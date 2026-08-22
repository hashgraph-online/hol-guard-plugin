import { spawn as spawnChild } from 'node:child_process';
import process from 'node:process';

const DEFAULT_TIMEOUT_MS = 8_000;
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
  let sawDeny = false;

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

    if (
      layer.blocked === true
      || layer.continue === false
      || values.some((value) => value === 'deny' || value === 'block')
      || policyActions.some((value) => value === 'block' || value === 'sandbox-required')
    ) sawDeny = true;

    if (
      values.some((value) => value === 'ask' || value === 'review')
      || policyActions.some((value) => value === 'review' || value === 'require-reapproval')
    ) sawReview = true;

    if (values.includes('allow') || policyActions.includes('allow')) sawAllow = true;
  }

  if (sawDeny) return 'deny';
  if (sawReview) return 'review';
  if (sawAllow) return 'allow';
  return null;
}

function buildPayload(input, output, directory, project) {
  const toolName = nonEmptyString(input?.tool);
  if (toolName === null) throw new Error('OpenCode tool call is missing a tool name');
  const payload = {
    hook_event_name: 'PreToolUse',
    hookEventName: 'PreToolUse',
    tool_name: toolName,
    tool_input: jsonSafe(output?.args ?? {}),
    tool_use_id: nonEmptyString(input?.callID),
    cwd: directory,
    runtime_context: {
      framework: 'opencode',
      session_id: nonEmptyString(input?.sessionID),
      call_id: nonEmptyString(input?.callID),
      project_id: nonEmptyString(project?.id),
    },
  };
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new Error('HOL Guard payload exceeds the bounded OpenCode limit');
  }
  return serialized;
}

export function runLocalHolGuard({ command = 'hol-guard', guardHome = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const timeout = boundedTimeout(timeoutMs);
  return ({ input, directory }) => new Promise((resolve, reject) => {
    const args = ['guard', 'hook', '--harness', 'opencode', '--workspace', directory];
    if (nonEmptyString(guardHome) !== null) args.push('--guard-home', guardHome.trim());
    const child = spawnChild(command, args, {
      cwd: directory,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const append = (current, chunk, label) => {
      const next = current + chunk;
      if (Buffer.byteLength(next, 'utf8') > MAX_CAPTURE_BYTES) {
        try { child.kill('SIGKILL'); } catch {}
        finish(new Error('HOL Guard ' + label + ' exceeded the bounded capture limit'));
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
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(new Error('HOL Guard review timed out'));
    }, timeout);
    timer.unref();
    child.stdin.on('error', (error) => finish(error));
    child.stdin.end(input);
  });
}

export function createHolGuardPlugin(options = {}) {
  const runner = typeof options.runner === 'function' ? options.runner : runLocalHolGuard(options);
  const directoryOverride = nonEmptyString(options.directory);

  return async function HolGuardOpenCodePlugin({ directory, project } = {}) {
    const workspace = directoryOverride ?? nonEmptyString(directory) ?? process.cwd();
    return {
      'tool.execute.before': async (input, output) => {
        let guardInput;
        try {
          guardInput = buildPayload(input, output, workspace, project);
        } catch {
          throw new Error('HOL Guard could not safely serialize this OpenCode tool call.');
        }

        let result;
        try {
          result = await runner({ input: guardInput, directory: workspace, context: input });
        } catch {
          throw new Error('HOL Guard review was unavailable and the OpenCode tool call was blocked.');
        }

        const decision = decisionFromGuardOutput(parseGuardOutput(result?.stdout));
        if (decision === null) {
          throw new Error('HOL Guard returned no authoritative decision and the OpenCode tool call was blocked.');
        }
        if ((decision === 'allow' || decision === 'review') && result?.exitCode !== 0) {
          throw new Error('HOL Guard returned a non-deny decision from a failing process and the OpenCode tool call was blocked.');
        }
        if (decision === 'deny') {
          throw new Error('HOL Guard blocked this OpenCode tool call.');
        }
        if (decision === 'review') {
          throw new Error('HOL Guard requires approval before this OpenCode tool call can execute.');
        }
      },
    };
  };
}

export const HolGuardPlugin = createHolGuardPlugin();
