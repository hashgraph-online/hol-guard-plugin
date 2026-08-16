import { spawn } from 'node:child_process';
import process from 'node:process';

export const name = 'hol-guard-plugin';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_CAPTURE_BYTES = 256 * 1024;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const TERMINATION_GRACE_MS = 250;

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function boundedTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(250, Math.floor(parsed)));
}

function normalizeGuardCommand(config = {}) {
  const configured = config.command;
  if (Array.isArray(configured) && configured.length > 0 && configured.every((part) => typeof part === 'string' && part.length > 0)) {
    return { executable: configured[0], prefixArgs: configured.slice(1) };
  }
  if (typeof configured === 'string' && configured.trim()) {
    return { executable: configured.trim(), prefixArgs: [] };
  }
  const fromEnvironment = nonEmptyString(process.env.HOL_GUARD_COMMAND);
  return { executable: fromEnvironment ?? 'hol-guard', prefixArgs: [] };
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
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new Error(`HOL Guard payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }
  return { payload, serialized };
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

function unwrapResponse(payload) {
  if (!payload || typeof payload !== 'object') return null;
  for (const key of ['data', 'payload', 'result']) {
    const nested = payload[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const unwrapped = unwrapResponse(nested);
      if (unwrapped !== null) return unwrapped;
    }
  }
  return payload;
}

export function decisionFromGuardResponse(payload) {
  const response = unwrapResponse(payload);
  if (response === null) return null;
  const hookOutput = response.hookSpecificOutput;
  const hookDecision = hookOutput && typeof hookOutput === 'object'
    ? nonEmptyString(hookOutput.permissionDecision)
    : null;
  const topLevelDecision = nonEmptyString(response.permissionDecision) ?? nonEmptyString(response.decision);
  const decision = (hookDecision ?? topLevelDecision)?.toLowerCase() ?? null;
  const policyAction = nonEmptyString(response.policy_action)?.toLowerCase() ?? null;
  const blocked = response.blocked;

  let kind = null;
  if (decision === 'allow') kind = 'allow';
  if (decision === 'deny' || decision === 'ask' || decision === 'block') kind = 'deny';
  if (kind === null && blocked === false && policyAction === 'allow') kind = 'allow';
  if (kind === null && (blocked === true || ['block', 'review', 'require-reapproval', 'sandbox-required'].includes(policyAction))) {
    kind = 'deny';
  }
  if (kind === null) return null;

  const reason = (
    hookOutput && typeof hookOutput === 'object' ? nonEmptyString(hookOutput.permissionDecisionReason) : null
  ) ?? nonEmptyString(response.reason)
    ?? nonEmptyString(response.review_hint)
    ?? (kind === 'deny' ? 'HOL Guard denied this DSH tool call.' : 'HOL Guard allowed this DSH tool call.');
  return { kind, reason };
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

export async function evaluateToolExecution(exec, config = {}) {
  let request;
  try {
    request = buildGuardPayload(exec);
  } catch (error) {
    return { kind: 'deny', reason: `HOL Guard could not serialize this DSH tool call: ${error instanceof Error ? error.message : String(error)}` };
  }

  const timeoutMs = boundedTimeout(config.timeoutMs ?? process.env.HOL_GUARD_DSH_TIMEOUT_MS);
  const guard = normalizeGuardCommand(config);
  const workspace = request.payload.cwd;
  const args = [
    ...guard.prefixArgs,
    'guard',
    'hook',
    '--harness',
    'dsh',
    '--workspace',
    workspace,
  ];
  const guardHome = nonEmptyString(config.guardHome) ?? nonEmptyString(process.env.HOL_GUARD_HOME);
  if (guardHome !== null) args.push('--guard-home', guardHome);

  let result;
  try {
    const runner = typeof config.runner === 'function' ? config.runner : spawnGuardHook;
    result = await runner({
      command: guard.executable,
      args,
      cwd: workspace,
      env: { ...process.env, ...(config.env ?? {}) },
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
  if (decision.kind === 'allow' && result.exitCode !== 0) {
    const detail = nonEmptyString(result.stderr) ?? `exit code ${result.exitCode}`;
    return { kind: 'deny', reason: `HOL Guard returned allow with a failing process (${detail}).` };
  }
  return decision;
}

export function apply(ctx, config = {}) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await evaluateToolExecution(exec, config);
    if (decision.kind === 'allow') return next();
    return { kind: 'deny', reason: decision.reason };
  });
}
