import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MAX_INPUT_BYTES = 24 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const GUARD_TIMEOUT_MS = 8_000;
const TERMINATION_GRACE_MS = 250;

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function objectOrNull(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function normalized(value) {
  return nonEmpty(value)?.toLowerCase() ?? null;
}

export function resolveWorkspace({ cwd = process.cwd(), env = process.env } = {}) {
  const explicit = nonEmpty(env.HOL_GUARD_WORKSPACE);
  if (explicit) return resolve(explicit);
  const absolute = resolve(cwd);
  const marker = `${sep}.moltis${sep}hooks${sep}`;
  const markerIndex = absolute.lastIndexOf(marker);
  if (markerIndex >= 0) return markerIndex === 0 ? sep : absolute.slice(0, markerIndex);
  return absolute;
}

export function translateMoltisPayload(payload, workspace = resolveWorkspace()) {
  const root = objectOrNull(payload);
  if (!root || root.event !== 'BeforeToolCall') throw new Error('invalid Moltis BeforeToolCall payload');
  const toolName = nonEmpty(root.tool_name);
  if (!toolName) throw new Error('missing Moltis tool name');
  const args = objectOrNull(root.arguments);
  if (!args) throw new Error('invalid Moltis tool arguments');
  const channel = objectOrNull(root.channel);
  return {
    hook_event_name: 'PreToolUse',
    hookEventName: 'PreToolUse',
    tool_name: toolName,
    tool_input: args,
    session_id: nonEmpty(root.session_key),
    cwd: workspace,
    runtime_context: {
      framework: 'moltis',
      channel: channel
        ? {
            surface: nonEmpty(channel.surface),
            session_kind: nonEmpty(channel.session_kind),
            channel_type: nonEmpty(channel.channel_type),
            account_id: nonEmpty(channel.account_id),
            chat_id: nonEmpty(channel.chat_id),
            chat_type: nonEmpty(channel.chat_type),
          }
        : null,
    },
  };
}

function parseObject(text) {
  try {
    return objectOrNull(JSON.parse(text));
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

export function classifyGuardDecision(payload) {
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
    const reason = nonEmpty(hook?.permissionDecisionReason) ?? nonEmpty(layer.reason) ?? nonEmpty(layer.review_hint);

    if (
      layer.blocked === true
      || layer.continue === false
      || decisions.some((value) => value === 'deny' || value === 'block')
      || actions.some((value) => value === 'block' || value === 'sandbox-required')
    ) denyReason = reason ?? 'HOL Guard denied this Moltis tool call.';

    if (
      decisions.some((value) => value === 'review' || value === 'ask')
      || actions.some((value) => value === 'review' || value === 'require-reapproval')
    ) reviewReason = reason ?? reviewReason ?? 'HOL Guard requires approval for this Moltis tool call.';

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

async function terminateProcessTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (process.platform === 'win32') {
    const systemRoot = nonEmpty(process.env.SystemRoot) ?? nonEmpty(process.env.WINDIR);
    if (systemRoot && typeof pid === 'number') {
      const taskkill = resolve(systemRoot, 'System32', 'taskkill.exe');
      await new Promise((done) => {
        let killer;
        try {
          killer = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, shell: false });
        } catch {
          done();
          return;
        }
        const timer = setTimeout(done, TERMINATION_GRACE_MS);
        killer.once('error', () => { clearTimeout(timer); done(); });
        killer.once('close', () => { clearTimeout(timer); done(); });
      });
    }
  } else if (typeof pid === 'number') {
    try { process.kill(-pid, 'SIGTERM'); } catch {}
    await new Promise((done) => setTimeout(done, TERMINATION_GRACE_MS));
    try { process.kill(-pid, 'SIGKILL'); } catch {}
  }
  try { child.kill('SIGKILL'); } catch {}
}

export function runLocalGuard(input, { workspace = resolveWorkspace(), command = 'hol-guard', timeoutMs = GUARD_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(command, ['guard', 'hook', '--harness', 'generic', '--workspace', workspace], {
        cwd: workspace,
        detached: process.platform !== 'win32',
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stdoutBytes = 0;
    let settled = false;
    let timer;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise(value);
    };
    const failAndTerminate = (message, error = new Error(message)) => {
      if (settled) return;
      settle(error);
      void terminateProcessTree(child);
    };
    timer = setTimeout(() => failAndTerminate('HOL Guard review timed out'), timeoutMs);
    timer.unref?.();

    child.once('error', (error) => failAndTerminate('HOL Guard process failed', error));
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        failAndTerminate('HOL Guard output exceeded limit');
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.once('close', (code) => settle(null, { code, stdout }));
    child.stdin.once('error', (error) => failAndTerminate('HOL Guard input stream failed', error));
    try {
      child.stdin.end(input);
    } catch (error) {
      failAndTerminate('HOL Guard input stream failed', error);
    }
  });
}

export async function evaluateBeforeToolCall(payload, { runner = runLocalGuard, workspace = resolveWorkspace() } = {}) {
  let guardPayload;
  try {
    guardPayload = translateMoltisPayload(payload, workspace);
  } catch {
    return { kind: 'block', reason: 'HOL Guard could not validate the Moltis tool request.' };
  }
  const encoded = JSON.stringify(guardPayload);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_INPUT_BYTES) {
    return { kind: 'block', reason: 'HOL Guard rejected an oversized Moltis tool request.' };
  }

  let result;
  try {
    result = await runner(encoded, { workspace });
  } catch {
    return { kind: 'block', reason: 'HOL Guard is unavailable; Moltis tool execution is blocked.' };
  }

  const decision = classifyGuardDecision(parseGuardOutput(result.stdout));
  if (decision?.kind === 'deny') return { kind: 'block', reason: decision.reason };
  if (decision?.kind === 'review') return { kind: 'block', reason: decision.reason };
  if (result.code !== 0 || decision?.kind !== 'allow') {
    return { kind: 'block', reason: 'HOL Guard did not return an authoritative allow decision.' };
  }
  return { kind: 'allow' };
}

async function readStdinBounded() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES) throw new Error('Moltis hook input exceeded limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdinBounded());
  } catch {
    process.stderr.write('HOL Guard could not validate the Moltis tool request.\n');
    process.exitCode = 1;
    return;
  }
  const result = await evaluateBeforeToolCall(payload);
  if (result.kind === 'allow') return;
  process.stderr.write(`${result.reason}\n`);
  process.exitCode = 1;
}

function realpathOrResolve(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

const invokedPath = process.argv[1] ? realpathOrResolve(process.argv[1]) : null;
const modulePath = realpathOrResolve(fileURLToPath(import.meta.url));
if (invokedPath && invokedPath === modulePath) {
  await main();
}
