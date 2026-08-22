#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MAX_INPUT_BYTES = 24 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const REVIEW_TIMEOUT_MS = 10_000;
const TERMINATION_GRACE_MS = 250;

function objectOrNull(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseObject(text) {
  try {
    return objectOrNull(JSON.parse(text));
  } catch {
    return null;
  }
}

export function parseGuardOutput(stdout) {
  const text = stringOrNull(stdout);
  if (!text) return null;
  const direct = parseObject(text);
  if (direct) return direct;
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = stringOrNull(lines[index]);
    if (!candidate) continue;
    const parsed = parseObject(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function normalized(value) {
  return stringOrNull(value)?.toLowerCase() ?? null;
}

export function classifyGuardDecision(payload) {
  const root = objectOrNull(payload);
  if (!root) return null;
  const queue = [root];
  const seen = new Set();
  let sawAllow = false;
  let sawReview = false;
  let denyReason = null;
  let reviewReason = null;

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
    const policyActions = [normalized(layer.policy_action), normalized(layer.policyAction)].filter(Boolean);
    const reason = stringOrNull(hook?.permissionDecisionReason)
      ?? stringOrNull(layer.reason)
      ?? stringOrNull(layer.review_hint);

    if (
      layer.blocked === true
      || layer.continue === false
      || decisions.some((value) => value === 'deny' || value === 'block')
      || policyActions.some((value) => value === 'block' || value === 'sandbox-required')
    ) {
      denyReason = reason ?? 'HOL Guard denied this Gemini CLI tool call.';
    }
    if (
      decisions.some((value) => value === 'ask' || value === 'review')
      || policyActions.some((value) => value === 'review' || value === 'require-reapproval')
    ) {
      sawReview = true;
      reviewReason = reason ?? reviewReason;
    }
    if (
      decisions.some((value) => value === 'allow' || value === 'warn')
      || policyActions.some((value) => value === 'allow' || value === 'warn')
    ) {
      sawAllow = true;
    }

    for (const key of ['data', 'payload', 'result']) {
      const nested = objectOrNull(layer[key]);
      if (nested) queue.push(nested);
    }
  }

  if (denyReason) return { kind: 'deny', reason: denyReason };
  if (sawReview) {
    return {
      kind: 'review',
      reason: reviewReason ?? 'HOL Guard requires approval before this Gemini CLI tool call can run.',
    };
  }
  if (sawAllow) return { kind: 'allow' };
  return null;
}

function deny(reason) {
  return {
    decision: 'deny',
    reason,
    systemMessage: 'HOL Guard blocked this tool call before execution.',
  };
}

function validateGeminiInput(payload) {
  const input = objectOrNull(payload);
  if (!input) throw new Error('invalid_input');
  if (!stringOrNull(input.tool_name)) throw new Error('missing_tool_name');
  const toolInput = input.tool_input;
  if (toolInput !== undefined && toolInput !== null && typeof toolInput !== 'object') {
    throw new Error('invalid_tool_input');
  }
  return input;
}

function trustedTaskkillPath() {
  const systemRoot = stringOrNull(process.env.SystemRoot) ?? stringOrNull(process.env.WINDIR);
  if (!systemRoot || !isAbsolute(systemRoot)) return null;
  return join(systemRoot, 'System32', 'taskkill.exe');
}

async function terminateProcessTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (process.platform === 'win32' && typeof pid === 'number') {
    const taskkillPath = trustedTaskkillPath();
    if (taskkillPath) {
      await new Promise((resolve) => {
        let killer;
        try {
          killer = spawn(taskkillPath, ['/PID', String(pid), '/T', '/F'], {
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
          clearTimeout(timer);
          resolve();
        });
        killer.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
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

export function runLocalHolGuard(serializedInput, {
  command = 'hol-guard',
  workspace = process.env.GEMINI_CWD || process.env.GEMINI_PROJECT_DIR || process.cwd(),
  timeoutMs = REVIEW_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, ['guard', 'hook', '--harness', 'gemini', '--workspace', workspace], {
        cwd: workspace,
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
      if (error) reject(error);
      else resolve(result);
    };
    const failAfterTermination = (error) => {
      if (settled || forcedError !== null) return;
      forcedError = error;
      void terminateProcessTree(child).finally(() => finish(forcedError));
    };

    child.once('error', (error) => {
      if (forcedError !== null) return;
      finish(error);
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const next = stdout + chunk;
      if (Buffer.byteLength(next, 'utf8') > MAX_OUTPUT_BYTES) {
        failAfterTermination(new Error('guard_output_too_large'));
        return;
      }
      stdout = next;
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += Buffer.byteLength(chunk, 'utf8');
      if (stderrBytes > MAX_OUTPUT_BYTES) {
        failAfterTermination(new Error('guard_stderr_too_large'));
      }
    });
    child.once('close', (code) => {
      if (forcedError !== null) return;
      finish(null, { exitCode: code ?? 1, stdout });
    });

    timer = setTimeout(() => {
      failAfterTermination(new Error('guard_timeout'));
    }, Math.max(250, Math.min(30_000, Number(timeoutMs) || REVIEW_TIMEOUT_MS)));
    timer.unref();

    child.stdin.once('error', (error) => {
      if (forcedError !== null) return;
      finish(error);
    });
    child.stdin.end(serializedInput);
  });
}

export async function evaluateBeforeTool(rawInput, options = {}) {
  const raw = typeof rawInput === 'string' ? rawInput : '';
  if (!raw || Buffer.byteLength(raw, 'utf8') > MAX_INPUT_BYTES) {
    return deny('HOL Guard could not safely inspect this tool call and failed closed.');
  }

  const parsed = parseObject(raw);
  try {
    validateGeminiInput(parsed);
  } catch {
    return deny('HOL Guard received an invalid Gemini CLI BeforeTool payload and failed closed.');
  }

  const runner = typeof options.runner === 'function' ? options.runner : runLocalHolGuard;
  let result;
  try {
    result = await runner(raw, options);
  } catch {
    return deny('HOL Guard review was unavailable and failed closed.');
  }

  const decision = classifyGuardDecision(parseGuardOutput(result?.stdout));
  if (!decision) return deny('HOL Guard returned no authoritative decision and failed closed.');
  if (decision.kind !== 'deny' && result?.exitCode !== 0) {
    return deny('HOL Guard review failed before an authoritative allow decision.');
  }
  if (decision.kind === 'allow') return { decision: 'allow' };
  if (decision.kind === 'deny') return deny(decision.reason);
  return deny(decision.reason);
}

async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_INPUT_BYTES) throw new Error('input_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  try {
    const raw = await readStdin();
    const output = await evaluateBeforeTool(raw);
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify(deny('HOL Guard could not safely inspect this tool call and failed closed.'))}\n`);
  }
}

export function isMainModule(argvPath = process.argv[1], moduleUrl = import.meta.url) {
  if (!argvPath) return false;
  const modulePath = fileURLToPath(moduleUrl);
  const resolvedArgvPath = resolvePath(argvPath);
  try {
    return realpathSync(resolvedArgvPath) === realpathSync(modulePath);
  } catch {
    return resolvedArgvPath === resolvePath(modulePath);
  }
}

if (isMainModule()) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify(deny('HOL Guard hook failed closed.'))}\n`);
  });
}