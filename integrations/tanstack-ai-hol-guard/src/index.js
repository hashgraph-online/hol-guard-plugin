import { spawn as spawnChild } from 'node:child_process';
import process from 'node:process';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_PAYLOAD_BYTES = 24 * 1024;
const MAX_CAPTURE_BYTES = 64 * 1024;

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
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
  if (depth >= 24) throw new Error('tool input exceeds the maximum nesting depth');
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

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function parseGuardOutput(stdout) {
  const trimmed = nonEmptyString(stdout);
  if (trimmed === null) return null;
  const direct = parseJsonObject(trimmed);
  if (direct !== null) return direct;
  const lines = trimmed.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = nonEmptyString(lines[index]);
    if (candidate === null) continue;
    const parsed = parseJsonObject(candidate);
    if (parsed !== null) return parsed;
  }
  return null;
}

function normalizedDecision(value) {
  const decision = nonEmptyString(value);
  return decision === null ? null : decision.toLowerCase();
}

function collectDecisionLayers(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const queue = [payload];
  const layers = [];
  const seen = new WeakSet();
  while (queue.length > 0) {
    if (layers.length >= 32) return null;
    const current = queue.shift();
    if (!current || typeof current !== 'object' || Array.isArray(current) || seen.has(current)) return null;
    seen.add(current);
    layers.push(current);
    for (const key of ['data', 'payload', 'result']) {
      const nested = current[key];
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) queue.push(nested);
    }
  }
  return layers;
}

function decisionFromGuardOutput(payload) {
  const layers = collectDecisionLayers(payload);
  if (layers === null) return null;
  let sawAllow = false;
  let sawReview = false;
  let denyReason = null;
  let reviewReason = null;
  let allowReason = null;

  for (const layer of layers) {
    const hookOutput = layer.hookSpecificOutput && typeof layer.hookSpecificOutput === 'object'
      ? layer.hookSpecificOutput
      : null;
    const values = [
      normalizedDecision(hookOutput?.permissionDecision),
      normalizedDecision(layer.permissionDecision),
      normalizedDecision(layer.decision),
    ].filter(Boolean);
    const policyActions = [
      normalizedDecision(layer.policy_action),
      normalizedDecision(layer.policyAction),
    ].filter(Boolean);
    const reason = nonEmptyString(hookOutput?.permissionDecisionReason)
      ?? nonEmptyString(layer.reason)
      ?? nonEmptyString(layer.review_hint);

    if (
      layer.blocked === true
      || layer.continue === false
      || values.some((value) => value === 'deny' || value === 'block')
      || policyActions.some((value) => value === 'block' || value === 'sandbox-required')
    ) {
      denyReason = reason ?? 'HOL Guard denied this TanStack AI tool call.';
    }
    if (
      values.some((value) => value === 'ask' || value === 'review')
      || policyActions.some((value) => value === 'review' || value === 'require-reapproval')
    ) {
      sawReview = true;
      reviewReason = reason ?? reviewReason;
    }
    if (
      values.some((value) => value === 'allow' || value === 'warn')
      || policyActions.some((value) => value === 'allow' || value === 'warn')
      || (layer.blocked === false && policyActions.includes('allow'))
    ) {
      sawAllow = true;
      allowReason = reason ?? allowReason;
    }
  }

  if (denyReason !== null) return { kind: 'deny', reason: denyReason };
  if (sawReview) return { kind: 'review', reason: reviewReason ?? 'HOL Guard requires approval for this TanStack AI tool call.' };
  if (sawAllow) return { kind: 'allow', reason: allowReason ?? 'HOL Guard allowed this TanStack AI tool call.' };
  return null;
}

function buildPayload(ctx, hookCtx, workspace) {
  const toolName = nonEmptyString(hookCtx?.toolName);
  if (toolName === null) throw new Error('TanStack AI tool call is missing a tool name');
  const payload = {
    hook_event_name: 'PreToolUse',
    hookEventName: 'PreToolUse',
    tool_name: toolName,
    tool_input: jsonSafe(hookCtx?.args ?? {}),
    tool_use_id: nonEmptyString(hookCtx?.toolCallId),
    cwd: workspace,
    runtime_context: {
      framework: 'tanstack-ai',
      provider: nonEmptyString(ctx?.provider),
      model: nonEmptyString(ctx?.model),
      request_id: nonEmptyString(ctx?.requestId),
      run_id: nonEmptyString(ctx?.runId),
      thread_id: nonEmptyString(ctx?.threadId),
      iteration: Number.isInteger(ctx?.iteration) ? ctx.iteration : null,
    },
  };
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new Error('HOL Guard payload exceeds the bounded TanStack AI limit');
  }
  return serialized;
}

export function runLocalHolGuard({ command = 'hol-guard', guardHome = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const timeout = boundedTimeout(timeoutMs);
  return ({ input, workspace, signal }) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('TanStack AI cancelled the tool call before HOL Guard review'));
      return;
    }
    const args = ['guard', 'hook', '--harness', 'tanstack-ai', '--workspace', workspace];
    if (nonEmptyString(guardHome) !== null) args.push('--guard-home', guardHome.trim());
    const child = spawnChild(command, args, {
      cwd: workspace,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      if (error) reject(error);
      else resolve(result);
    };
    const append = (current, chunk, label) => {
      const next = current + chunk;
      if (Buffer.byteLength(next, 'utf8') > MAX_CAPTURE_BYTES) {
        finish(new Error('HOL Guard ' + label + ' exceeded the bounded capture limit'));
        try { child.kill('SIGKILL'); } catch {}
        return current;
      }
      return next;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk, 'stdout'); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk, 'stderr'); });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => finish(null, { exitCode: code ?? 1, stdout, stderr }));
    const onAbort = () => {
      try { child.kill('SIGKILL'); } catch {}
      finish(new Error('TanStack AI cancelled the tool call during HOL Guard review'));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(new Error('HOL Guard review timed out'));
    }, timeout);
    timer.unref();
    child.stdin.on('error', (error) => finish(error));
    child.stdin.end(input);
  });
}

export function createHolGuardMiddleware(options = {}) {
  const runner = typeof options.runner === 'function' ? options.runner : runLocalHolGuard(options);
  const approve = typeof options.approve === 'function' ? options.approve : null;
  const workspaceOption = options.workspace;

  return {
    name: 'hol-guard',
    async onBeforeToolCall(ctx, hookCtx) {
      const workspaceCandidate = typeof workspaceOption === 'function'
        ? workspaceOption(ctx, hookCtx)
        : workspaceOption;
      const workspace = nonEmptyString(workspaceCandidate) ?? process.cwd();
      let input;
      try {
        input = buildPayload(ctx, hookCtx, workspace);
      } catch {
        return { type: 'abort', reason: 'HOL Guard could not safely serialize this TanStack AI tool call.' };
      }

      let result;
      try {
        result = await runner({ input, workspace, signal: ctx?.signal, context: ctx, toolCall: hookCtx });
      } catch {
        return { type: 'abort', reason: 'HOL Guard review was unavailable and failed closed.' };
      }

      const payload = parseGuardOutput(result?.stdout);
      const decision = decisionFromGuardOutput(payload);
      if (decision === null) {
        return { type: 'abort', reason: 'HOL Guard returned no authoritative decision and failed closed.' };
      }
      if ((decision.kind === 'allow' || decision.kind === 'review') && result?.exitCode !== 0) {
        return { type: 'abort', reason: 'HOL Guard returned a non-deny decision from a failing process and failed closed.' };
      }
      if (decision.kind === 'deny') return { type: 'abort', reason: decision.reason };
      if (decision.kind === 'review') {
        if (approve === null) {
          return { type: 'abort', reason: 'HOL Guard requires approval, but no TanStack AI approval resolver is configured.' };
        }
        try {
          const approved = await approve({
            reason: decision.reason,
            context: ctx,
            toolCall: hookCtx,
          });
          if (approved === true) return undefined;
          return { type: 'abort', reason: 'HOL Guard approval was not granted.' };
        } catch {
          return { type: 'abort', reason: 'HOL Guard approval failed and the tool call was blocked.' };
        }
      }
      return undefined;
    },
  };
}
