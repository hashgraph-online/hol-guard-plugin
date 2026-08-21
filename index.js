import { spawn } from 'node:child_process';
import process from 'node:process';

import { prepareGuardProcess } from './dsh-process.js';

export const name = 'hol-guard-plugin';
export const inject = ['tools'];

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_CAPTURE_BYTES = 256 * 1024;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const TERMINATION_GRACE_MS = 250;
const INCOMPLETE_REVIEW_REASON = 'HOL Guard review did not complete before DSH reached its monotonic tool guard.';
const EXECUTION_MUTATION_REASON = 'HOL Guard denied this DSH tool call because its identity, workspace, or arguments changed after review.';
const EXECUTION_IDENTITY_KEYS = Object.freeze([
  'token',
  'callId',
  'rootCallId',
  'name',
  'arguments',
  'agent',
  'parent',
  'deferContext',
  'concludeTurn',
]);

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function boundedTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(250, Math.floor(parsed)));
}

function jsonSafe(value, seen = new WeakSet(), depth = 0) {
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') return value ?? null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return String(value);
  if (depth >= 32) throw new Error('tool input exceeds the maximum nesting depth');
  if (seen.has(value)) throw new Error('tool input contains a circular reference');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => jsonSafe(item, seen, depth + 1));
    const output = {};
    for (const [key, item] of Object.entries(value)) output[key] = jsonSafe(item, seen, depth + 1);
    return output;
  } finally {
    seen.delete(value);
  }
}

function workspaceFor(exec) {
  const sessionCwd = exec?.agent?.session?.header?.cwd;
  return nonEmptyString(sessionCwd) ?? process.cwd();
}

export function buildGuardPayload(exec) {
  const toolName = nonEmptyString(exec?.name);
  if (toolName === null) throw new Error('DSH tool execution is missing a tool name');
  const rawArguments = exec?.arguments ?? exec?.args ?? {};
  const payload = {
    hook_event_name: 'PreToolUse',
    hookEventName: 'PreToolUse',
    tool_name: toolName,
    tool_input: jsonSafe(rawArguments),
    cwd: workspaceFor(exec),
  };
  const callId = nonEmptyString(exec?.callId);
  if (callId !== null) payload.tool_use_id = callId;
  const rootCallId = nonEmptyString(exec?.rootCallId);
  if (rootCallId !== null) payload.root_tool_use_id = rootCallId;
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new Error(`HOL Guard payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }
  return { payload, serialized };
}

function lockExecutionIdentity(exec) {
  if (!exec || typeof exec !== 'object') {
    throw new Error('DSH tool execution is not an object');
  }
  for (const key of EXECUTION_IDENTITY_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(exec, key);
    if (descriptor === undefined) continue;
    if (!Object.hasOwn(descriptor, 'value')) {
      throw new Error(`DSH execution identity field "${key}" is not a data property`);
    }
    if (descriptor.writable === false && descriptor.configurable === false) continue;
    Object.defineProperty(exec, key, {
      value: descriptor.value,
      enumerable: descriptor.enumerable,
      writable: false,
      configurable: false,
    });
  }
}

function executionMutationReason(exec, reviewedSerialized) {
  try {
    const current = buildGuardPayload(exec).serialized;
    return current === reviewedSerialized ? null : EXECUTION_MUTATION_REASON;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `HOL Guard could not revalidate the reviewed DSH tool call: ${detail}`;
  }
}

function parseJsonObject(candidate) {
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseGuardResponse(stdout) {
  const trimmed = typeof stdout === 'string' ? stdout.trim() : '';
  if (!trimmed) return null;
  const direct = parseJsonObject(trimmed);
  if (direct !== null) return direct;
  const lines = trimmed.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines[index]?.trim();
    if (!candidate) continue;
    const parsed = parseJsonObject(candidate);
    if (parsed !== null) return parsed;
  }
  return null;
}

function responseLayers(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const layers = [];
  const queue = [payload];
  const seen = new WeakSet();
  while (queue.length > 0) {
    if (layers.length >= 32) return null;
    const current = queue.shift();
    if (seen.has(current)) return null;
    seen.add(current);
    layers.push(current);
    for (const key of ['data', 'payload', 'result']) {
      const candidate = current[key];
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        queue.push(candidate);
      }
    }
  }
  return layers;
}

function normalizedDecision(value) {
  const decision = nonEmptyString(value);
  return decision === null ? null : decision.toLowerCase();
}

function layerSignals(response) {
  const hookOutput = response.hookSpecificOutput;
  let hookDecision = null;
  if (hookOutput && typeof hookOutput === 'object') {
    hookDecision = normalizedDecision(hookOutput.permissionDecision);
  }
  const decisions = [
    hookDecision,
    normalizedDecision(response.permissionDecision),
    normalizedDecision(response.decision),
  ].filter((decision) => decision !== null);
  const policyAction = normalizedDecision(response.policy_action);
  return {
    response,
    hookOutput,
    hookDecision,
    decisions,
    policyAction,
    hardDeny: response.blocked === true
      || response.continue === false
      || decisions.some((decision) => ['deny', 'block'].includes(decision))
      || ['block', 'sandbox-required'].includes(policyAction),
    requiresApproval: decisions.includes('ask') || ['review', 'require-reapproval'].includes(policyAction),
    allows: decisions.includes('allow') || (response.blocked === false && policyAction === 'allow'),
  };
}

function signalReason(signal, kind) {
  const hookReason = signal.hookOutput && typeof signal.hookOutput === 'object'
    ? nonEmptyString(signal.hookOutput.permissionDecisionReason)
    : null;
  const responseReason = nonEmptyString(signal.response.reason);
  const reviewHint = nonEmptyString(signal.response.review_hint);
  if (kind === 'deny') {
    if (['deny', 'block'].includes(signal.hookDecision) && hookReason !== null) return hookReason;
    return responseReason ?? reviewHint;
  }
  if (kind === 'ask') {
    if (signal.hookDecision === 'ask' && hookReason !== null) return hookReason;
    return responseReason ?? reviewHint;
  }
  if (signal.hookDecision === 'allow' && hookReason !== null) return hookReason;
  return responseReason ?? reviewHint;
}

function signalMatchesKind(signal, kind) {
  if (kind === 'deny') return signal.hardDeny;
  if (kind === 'ask') return signal.requiresApproval;
  return signal.allows;
}

function defaultDecisionReason(kind) {
  if (kind === 'ask') return 'HOL Guard requires approval for this DSH tool call.';
  if (kind === 'deny') return 'HOL Guard denied this DSH tool call.';
  return 'HOL Guard allowed this DSH tool call.';
}

function reasonFromSignals(signals, kind) {
  const matching = signals.filter((signal) => signalMatchesKind(signal, kind));
  for (const signal of [...matching].reverse()) {
    const reason = signalReason(signal, kind);
    if (reason !== null) return reason;
  }
  return defaultDecisionReason(kind);
}

export function decisionFromGuardResponse(payload) {
  const layers = responseLayers(payload);
  if (layers === null) return null;
  const signals = layers.map(layerSignals);
  let kind = null;
  if (signals.some((signal) => signal.hardDeny)) kind = 'deny';
  else if (signals.some((signal) => signal.requiresApproval)) kind = 'ask';
  else if (signals.some((signal) => signal.allows)) kind = 'allow';
  if (kind === null) return null;
  return { kind, reason: reasonFromSignals(signals, kind) };
}

function approvalFailure(reason) {
  return { kind: 'deny', reason: `HOL Guard review failed closed: ${reason}` };
}

export async function resolveDshApproval(ctx, exec, decision) {
  if (decision.kind !== 'ask') return decision;
  if (!exec?.agent) {
    return approvalFailure(`tool "${nonEmptyString(exec?.name) ?? 'unknown'}" requires approval, but the call has no DSH agent`);
  }

  let approval;
  try {
    approval = typeof ctx?.get === 'function' ? ctx.get('approval') : undefined;
  } catch (error) {
    return approvalFailure(`the DSH approval service could not be resolved: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!approval || typeof approval.request !== 'function') {
    return approvalFailure('this DSH profile has no native approval service');
  }

  let outcome;
  try {
    outcome = await approval.request({
      agent: exec.agent,
      toolName: exec.name,
      callId: exec.callId,
      reason: decision.reason,
      signal: exec.signal,
    });
  } catch (error) {
    return approvalFailure(`the DSH approval request failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  switch (outcome) {
    case 'allowed-once':
      return { kind: 'allow', reason: decision.reason };
    case 'rejected':
      return approvalFailure(`the user rejected tool "${nonEmptyString(exec.name) ?? 'unknown'}"`);
    case 'cancelled':
      return approvalFailure(`approval for tool "${nonEmptyString(exec.name) ?? 'unknown'}" was cancelled`);
    case 'unavailable':
      return approvalFailure(`no approval channel is available for tool "${nonEmptyString(exec.name) ?? 'unknown'}"`);
    default:
      return approvalFailure(`the DSH approval service returned an unknown outcome: ${String(outcome)}`);
  }
}

async function terminateProcessTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (process.platform === 'win32' && typeof pid === 'number') {
    await new Promise((resolve) => {
      let killer;
      try {
        killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } catch {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, TERMINATION_GRACE_MS);
      timer.unref();
      killer.once('error', () => {
        if (timer !== undefined) clearTimeout(timer);
        resolve();
      });
      killer.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  } else if (typeof pid === 'number') {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, TERMINATION_GRACE_MS));
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
  }
  try {
    child.kill('SIGKILL');
  } catch {}
}

export function spawnGuardHook({ command, args, cwd, env, input, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('DSH cancelled the tool call before HOL Guard review'));
      return;
    }
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        detached: process.platform !== 'win32',
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    let forcedError = null;
    let timer;
    let stdout = '';
    let stderr = '';
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const append = (current, chunk, streamName) => {
      const next = current + chunk;
      if (Buffer.byteLength(next, 'utf8') > MAX_CAPTURE_BYTES) {
        if (forcedError === null) {
          forcedError = new Error(`HOL Guard ${streamName} exceeded ${MAX_CAPTURE_BYTES} bytes`);
          void terminateProcessTree(child).finally(() => {
            finish(forcedError);
          });
        }
        return current;
      }
      return next;
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk, 'stdout'); });
    child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk, 'stderr'); });
    child.once('error', (error) => {
      if (forcedError !== null) return;
      finish(error);
    });
    child.once('close', (code, closeSignal) => {
      if (forcedError !== null) return;
      finish(null, {
        exitCode: code ?? 1,
        signal: closeSignal,
        stdout,
        stderr,
      });
    });

    const onAbort = () => {
      forcedError = new Error('DSH cancelled the tool call during HOL Guard review');
      void terminateProcessTree(child).finally(() => {
        finish(forcedError);
      });
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      forcedError = new Error(`HOL Guard review timed out after ${timeoutMs} ms`);
      void terminateProcessTree(child).finally(() => {
        finish(forcedError);
      });
    }, timeoutMs);
    timer.unref();

    child.stdin?.on('error', (error) => finish(error));
    child.stdin?.end(input);
  });
}

async function evaluatePreparedToolExecution(exec, config, request) {
  const timeoutMs = boundedTimeout(config.timeoutMs);
  const workspace = request.payload.cwd;
  let guard;
  try {
    guard = prepareGuardProcess(config, workspace);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { kind: 'deny', reason: `HOL Guard process trust validation failed closed: ${detail}` };
  }
  const args = [
    ...guard.prefixArgs,
    'guard',
    'hook',
    '--harness',
    'dsh',
    '--workspace',
    workspace,
  ];
  if (guard.guardHome !== null) args.push('--guard-home', guard.guardHome);

  let result;
  try {
    const runner = typeof config.runner === 'function' ? config.runner : spawnGuardHook;
    result = await runner({
      command: guard.executable,
      args,
      cwd: workspace,
      env: guard.environment,
      input: request.serialized,
      signal: exec?.signal,
      timeoutMs,
    });
  } catch (error) {
    return { kind: 'deny', reason: `HOL Guard review failed closed: ${error instanceof Error ? error.message : String(error)}` };
  }

  const response = parseGuardResponse(result.stdout);
  const decision = decisionFromGuardResponse(response);
  if (decision === null) {
    const detail = nonEmptyString(result.stderr) ?? `exit code ${result.exitCode}`;
    return { kind: 'deny', reason: `HOL Guard returned no authoritative decision (${detail}).` };
  }
  if ((decision.kind === 'allow' || decision.kind === 'ask') && result.exitCode !== 0) {
    const detail = nonEmptyString(result.stderr) ?? `exit code ${result.exitCode}`;
    return { kind: 'deny', reason: `HOL Guard returned ${decision.kind} with a failing process (${detail}).` };
  }
  return decision;
}

export async function evaluateToolExecution(exec, config = {}) {
  let request;
  try {
    request = buildGuardPayload(exec);
  } catch (error) {
    return { kind: 'deny', reason: `HOL Guard could not serialize this DSH tool call: ${error instanceof Error ? error.message : String(error)}` };
  }
  return evaluatePreparedToolExecution(exec, config, request);
}

export function apply(ctx, config = {}) {
  if (!ctx || typeof ctx.on !== 'function') {
    throw new Error('HOL Guard requires a valid DSH Cordis context.');
  }
  if (!ctx.tools || typeof ctx.tools.guard !== 'function') {
    throw new Error('HOL Guard requires the DSH tools service with monotonic guard support.');
  }

  const decisions = new WeakMap();
  ctx.tools.guard((exec) => {
    const decision = decisions.get(exec);
    if (decision === undefined) return INCOMPLETE_REVIEW_REASON;
    if (decision.reviewedSerialized === null) return decision.reason;
    const mutationReason = executionMutationReason(exec, decision.reviewedSerialized);
    if (mutationReason !== null) return mutationReason;
    if (decision.kind === 'allow') return undefined;
    return decision.reason;
  });

  ctx.on('tools/pre-execute', async (exec, next) => {
    let request;
    try {
      request = buildGuardPayload(exec);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const reason = `HOL Guard could not serialize this DSH tool call: ${detail}`;
      decisions.set(exec, { kind: 'deny', reason, reviewedSerialized: null });
      return { kind: 'deny', reason };
    }

    decisions.set(exec, {
      kind: 'deny',
      reason: INCOMPLETE_REVIEW_REASON,
      reviewedSerialized: request.serialized,
    });
    const reviewed = await evaluatePreparedToolExecution(exec, config, request);
    const resolved = await resolveDshApproval(ctx, exec, reviewed);
    if (resolved.kind !== 'allow') {
      decisions.set(exec, { ...resolved, reviewedSerialized: request.serialized });
      return { kind: 'deny', reason: resolved.reason };
    }

    const mutationBeforeDelegation = executionMutationReason(exec, request.serialized);
    if (mutationBeforeDelegation !== null) {
      decisions.set(exec, {
        kind: 'deny',
        reason: mutationBeforeDelegation,
        reviewedSerialized: request.serialized,
      });
      return { kind: 'deny', reason: mutationBeforeDelegation };
    }

    try {
      lockExecutionIdentity(exec);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const reason = `HOL Guard could not lock the reviewed DSH execution: ${detail}`;
      decisions.set(exec, { kind: 'deny', reason, reviewedSerialized: request.serialized });
      return { kind: 'deny', reason };
    }

    decisions.set(exec, { ...resolved, reviewedSerialized: request.serialized });
    const downstream = await next();
    const mutationAfterDelegation = executionMutationReason(exec, request.serialized);
    if (mutationAfterDelegation !== null) {
      decisions.set(exec, {
        kind: 'deny',
        reason: mutationAfterDelegation,
        reviewedSerialized: request.serialized,
      });
      return { kind: 'deny', reason: mutationAfterDelegation };
    }
    return downstream;
  });
}
