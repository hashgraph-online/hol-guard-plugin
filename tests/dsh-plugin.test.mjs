import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  apply,
  buildGuardPayload,
  decisionFromGuardResponse,
  evaluateToolExecution,
  parseGuardResponse,
} from '../index.js';

function execution(command = 'printf safe', overrides = {}) {
  return {
    name: 'bash',
    callId: 'call-1',
    arguments: { command, description: 'Run test command' },
    agent: { session: { header: { cwd: process.cwd() } } },
    ...overrides,
  };
}

async function fakeGuard(body) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hol-guard-dsh-test-'));
  const script = path.join(dir, 'guard.mjs');
  await writeFile(script, `#!/usr/bin/env node\n${body}\n`, 'utf8');
  await chmod(script, 0o755);
  return { script, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('buildGuardPayload preserves the DSH tool name and arguments', () => {
  const { payload } = buildGuardPayload(execution('echo hello'));
  assert.equal(payload.hook_event_name, 'PreToolUse');
  assert.equal(payload.tool_name, 'bash');
  assert.equal(payload.tool_input.command, 'echo hello');
  assert.equal(payload.tool_use_id, 'call-1');
});

test('buildGuardPayload rejects circular input instead of dropping data', () => {
  const input = {};
  input.self = input;
  assert.throws(() => buildGuardPayload(execution('echo', { arguments: input })), /circular reference/);
});

test('parseGuardResponse accepts the final JSON line', () => {
  assert.deepEqual(parseGuardResponse('diagnostic\n{"decision":"allow"}\n'), { decision: 'allow' });
});

test('decisionFromGuardResponse maps native allow and deny responses', () => {
  assert.deepEqual(decisionFromGuardResponse({
    hookSpecificOutput: { permissionDecision: 'allow' },
  }), { kind: 'allow', reason: 'HOL Guard allowed this DSH tool call.' });
  assert.deepEqual(decisionFromGuardResponse({
    hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'blocked test' },
  }), { kind: 'deny', reason: 'blocked test' });
});

test('evaluateToolExecution allows only an authoritative successful allow', async () => {
  const guard = await fakeGuard(`
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const parsed = JSON.parse(input);
if (parsed.tool_name !== 'bash' || parsed.tool_input.command !== 'echo safe') process.exit(9);
console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow'}}));
`);
  try {
    const result = await evaluateToolExecution(execution('echo safe'), { command: guard.script });
    assert.equal(result.kind, 'allow');
  } finally {
    await guard.cleanup();
  }
});

test('evaluateToolExecution propagates an authoritative denial', async () => {
  const guard = await fakeGuard(`
process.stdin.resume();
console.log(JSON.stringify({hookSpecificOutput:{permissionDecision:'deny',permissionDecisionReason:'dangerous command'}}));
process.exitCode = 2;
`);
  try {
    const result = await evaluateToolExecution(execution('rm -rf /tmp/test'), { command: guard.script });
    assert.deepEqual(result, { kind: 'deny', reason: 'dangerous command' });
  } finally {
    await guard.cleanup();
  }
});

test('evaluateToolExecution fails closed on malformed output', async () => {
  const guard = await fakeGuard(`process.stdin.resume(); console.log('not-json');`);
  try {
    const result = await evaluateToolExecution(execution(), { command: guard.script });
    assert.equal(result.kind, 'deny');
    assert.match(result.reason, /no authoritative decision/);
  } finally {
    await guard.cleanup();
  }
});

test('evaluateToolExecution fails closed when the Guard command is missing', async () => {
  const result = await evaluateToolExecution(execution(), { command: path.join(os.tmpdir(), 'missing-hol-guard-command') });
  assert.equal(result.kind, 'deny');
  assert.match(result.reason, /failed closed/);
});

test('evaluateToolExecution kills timed-out Guard processes and fails closed', async () => {
  const guard = await fakeGuard(`process.stdin.resume(); setInterval(() => {}, 1000);`);
  try {
    const started = Date.now();
    const result = await evaluateToolExecution(execution(), { command: guard.script, timeoutMs: 300 });
    assert.equal(result.kind, 'deny');
    assert.match(result.reason, /timed out/);
    assert.ok(Date.now() - started < 3000);
  } finally {
    await guard.cleanup();
  }
});

test('apply delegates allowed calls and binds denials before dispatch', async () => {
  let handler;
  apply({ on(event, candidate) { assert.equal(event, 'tools/pre-execute'); handler = candidate; } }, {
    runner: async () => ({
      exitCode: 0,
      signal: null,
      stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } }),
      stderr: '',
    }),
  });
  let delegated = 0;
  const allowed = await handler(execution(), async () => { delegated += 1; return { kind: 'allowed-by-next' }; });
  assert.deepEqual(allowed, { kind: 'allowed-by-next' });
  assert.equal(delegated, 1);

  apply({ on(_event, candidate) { handler = candidate; } }, {
    runner: async () => ({
      exitCode: 2,
      signal: null,
      stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'policy' } }),
      stderr: '',
    }),
  });
  const denied = await handler(execution(), async () => { delegated += 1; });
  assert.deepEqual(denied, { kind: 'deny', reason: 'policy' });
  assert.equal(delegated, 1);
});
