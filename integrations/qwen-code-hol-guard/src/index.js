import { spawn } from 'node:child_process';
import process from 'node:process';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_PAYLOAD_BYTES = 24 * 1024;
const MAX_CAPTURE_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 250;

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function objectOrNull(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function parseObject(value) {
  try {
    return objectOrNull(JSON.parse(value));
  } catch {
    return null;
  }
}

function parseGuardOutput(stdout) {
  const text = nonEmpty(stdout);
  if (!text) return null;
  const direct = parseObject(text);
  if (direct) return direct;
  for (const line of text.split(/\r?\n/).reverse()) {
    const parsed = parseObject(line);
    if (parsed) return parsed;
  }
  return null;
}

function normalized(value) {
  return nonEmpty(value)?.toLowerCase() ?? null;
}

function classify(payload) {
  const root = objectOrNull(payload);
  if (!root) return null;
  const queue = [root];
  const seen = new Set();
  let allow = false;
  let reviewReason = null;
  let denyReason = null;

  while (queue.length) {
    if (seen.size >= 32) return null;
    const layer = queue.shift();
    if (!layer || seen.has(layer)) return null;
    seen.add(layer);
    const hook = objectOrNull(layer.hookSpecificOutput);
    const decisions = [
      normalized(hook?.permissionDecision),
      normalized(layer.permissionDecision),
      normalized(layer.decision),
    ].filter(Boolean);
    const actions = [normalized(layer.policy_action), normalized(layer.policyAction)].filter(Boolean);
    const reason = nonEmpty(hook?.permissionDecisionReason)
      ?? nonEmpty(layer.reason)
      ?? nonEmpty(layer.review_hint);

    if (
      layer.blocked === true
      || layer.continue === false
      || decisions.some((value) => value === 'deny' || value === 'block')
      || actions.some((value) => value === 'block' || value === 'sandbox-required')
    ) denyReason = reason ?? 'HOL Guard denied this Qwen Code tool invocation.';

    if (
      decisions.some((value) => value === 'review' || value === 'ask')
      || actions.some((value) => value === 'review' || value === 'require-reapproval')
    ) reviewReason = reason ?? reviewReason ?? 'HOL Guard requires approval for this Qwen Code tool invocation.';

    if (
      decisions.some((value) => value === 'allow' || value === 'warn')
      || actions.some((value) => value === 'allow' || value === 'warn')
    ) allow = true;

    for (const key of ['data', 'payload', 'result']) {
      const nested = objectOrNull(layer[key]);
      if (nested) queue.push(nested);
    }
  }

  if (denyReason) return { kind: 'deny', reason: denyReason };
  if (reviewReason) return { kind: 'review', reason: reviewReason };
  if (allow) return { kind: 'allow' };
  return null;
}

function safeJson(value, seen = new WeakSet(), depth = 0) {
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') return value ?? null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return String(value);
  if (depth >= 24) throw new Error('argument nesting exceeds limit');
  if (seen.has(value)) throw new Error('arguments contain a circular reference');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => safeJson(item, seen, depth + 1));
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = safeJson(item, seen, depth + 1);
    return result;
  } finally {
    seen.delete(value);
  }
}

function buildPayload(context) {
  const toolName = nonEmpty(context?.toolName);
  if (!toolName) throw new Error('missing canonical tool name');
  const payload = {
    hook_event_name: 'PreToolUse',
    hookEventName: 'PreToolUse',
    tool_name: toolName,
    tool_input: safeJson(context.args ?? {}),
    tool_use_id: nonEmpty(context.callId),
    cwd: nonEmpty(context.cwd),
    runtime_context: {
      framework: 'qwen-code',
      session_id: nonEmpty(context.sessionId),
      invocation_context: safeJson(context.invocationContext ?? null),
    },
  };
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) throw new Error('payload exceeds limit');
  return serialized;
}

async function terminateProcessTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (process.platform === 'win32' && typeof pid === 'number') {
    await new Promise((resolve) => {
      let killer;
      try {
        killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } catch {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, TERMINATION_GRACE_MS);
      timer.unref();
      killer.once('error', () => { clearTimeout(timer); resolve(); });
      killer.once('close', () => { clearTimeout(timer); resolve(); });
    });
  } else if (typeof pid === 'number') {
    try { process.kill(-pid, 'SIGTERM'); } catch {}
    await new Promise((resolve) => setTimeout(resolve, TERMINATION_GRACE_MS));
    try { process.kill(-pid, 'SIGKILL'); } catch {}
  }
  try { child.kill('SIGKILL'); } catch {}
}

export function runLocalHolGuard({ input, cwd, signal, command = 'hol-guard', timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Qwen Code cancelled before HOL Guard review'));
      return;
    }
    let child;
    try {
      child = spawn(command, ['guard', 'hook', '--harness', 'generic', '--workspace', cwd], {
        cwd,
        detached: process.platform !== 'win32',
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let stderrBytes = 0;
    let settled = false;
    let forcedError = null;
    let timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      if (error) reject(error);
      else resolve(result);
    };
    const fail = (error) => {
      if (settled || forcedError) return;
      forcedError = error;
      void terminateProcessTree(child).finally(() => finish(forcedError));
    };
    const onAbort = () => fail(new Error('Qwen Code cancelled during HOL Guard review'));
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.once('error', (error) => { if (!forcedError) finish(error); });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const next = stdout + chunk;
      if (Buffer.byteLength(next, 'utf8') > MAX_CAPTURE_BYTES) fail(new Error('Guard stdout exceeded limit'));
      else stdout = next;
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += Buffer.byteLength(chunk, 'utf8');
      if (stderrBytes > MAX_CAPTURE_BYTES) fail(new Error('Guard stderr exceeded limit'));
    });
    child.once('close', (code) => { if (!forcedError) finish(null, { exitCode: code ?? 1, stdout }); });
    timer = setTimeout(() => fail(new Error('Guard review timed out')), Math.max(250, Math.min(30_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)));
    timer.unref();
    child.stdin.once('error', (error) => { if (!forcedError) finish(error); });
    child.stdin.end(input);
  });
}

export function createHolGuardToolInvocationGuard(options = {}) {
  const runner = typeof options.runner === 'function' ? options.runner : runLocalHolGuard;
  return async function holGuardToolInvocationGuard(context) {
    if (context?.signal?.aborted) return { allowed: false, reason: 'HOL Guard review was cancelled before execution.' };
    const cwd = nonEmpty(context?.cwd) ?? process.cwd();
    let input;
    try {
      input = buildPayload(context);
    } catch {
      return { allowed: false, reason: 'HOL Guard could not safely serialize this tool invocation.' };
    }
    let result;
    try {
      result = await runner({ input, cwd, signal: context.signal, command: options.command, timeoutMs: options.timeoutMs });
    } catch {
      return { allowed: false, reason: 'HOL Guard review was unavailable and failed closed.' };
    }
    if (context.signal?.aborted) return { allowed: false, reason: 'HOL Guard review was cancelled before execution.' };
    const decision = classify(parseGuardOutput(result?.stdout));
    if (!decision) return { allowed: false, reason: 'HOL Guard returned no authoritative decision.' };
    if (decision.kind !== 'deny' && result?.exitCode !== 0) {
      return { allowed: false, reason: 'HOL Guard failed before an authoritative allow decision.' };
    }
    if (decision.kind === 'allow') return { allowed: true };
    return { allowed: false, reason: decision.reason };
  };
}
