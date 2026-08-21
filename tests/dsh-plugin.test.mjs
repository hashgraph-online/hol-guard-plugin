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
  resolveDshApproval,
} from '../index.js';

function execution(command = 'printf safe', overrides = {}) {
  return {
    name: 'bash',
    callId: 'call-1',
    rootCallId: 'root-call-1',
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

function pluginContext({ approval, includeTools = true } = {}) {
  const captured = { pre: null, guard: null };
  const ctx = {
    on(event, handler) {
      assert.equal(event, 'tools/pre-execute');
      captured.pre = handler;
    },
    get(name) {
      assert.equal(name, 'approval');
      return approval;
    },
  };
  if (includeTools) {
    ctx.tools = {
      guard(handler) {
        captured.guard = handler;
        return () => {};
      },
    };
  }
  return { ctx, captured };
}

function runnerFor(permissionDecision, { exitCode = 0, reason } = {}) {
  return async () => ({
    exitCode,
    signal: null,
    stdout: JSON.stringify({
      hookSpecificOutput: {
        permissionDecision,
        ...(reason ? { permissionDecisionReason: reason } : {}),
      },
    }),
    stderr: '',
  });
}

test('buildGuardPayload preserves DSH call identity, tool name, and arguments', () => {
  const { payload } = buildGuardPayload(execution('echo hello'));
  assert.equal(payload.hook_event_name, 'PreToolUse');
  assert.equal(payload.tool_name, 'bash');
  assert.equal(payload.tool_input.command, 'echo hello');
  assert.equal(payload.tool_use_id, 'call-1');
  assert.equal(payload.root_tool_use_id, 'root-call-1');
});

test('buildGuardPayload rejects circular input instead of dropping data', () => {
  const input = {};
  input.self = input;
  assert.throws(() => buildGuardPayload(execution('echo', { arguments: input })), /circular reference/);
});

test('parseGuardResponse accepts the final JSON line', () => {
  assert.deepEqual(parseGuardResponse('diagnostic\n{"decision":"allow"}\n'), { decision: 'allow' });
});

test('decisionFromGuardResponse maps native allow, ask, and deny responses', () => {
  assert.deepEqual(decisionFromGuardResponse({
    hookSpecificOutput: { permissionDecision: 'allow' },
  }), { kind: 'allow', reason: 'HOL Guard allowed this DSH tool call.' });
  assert.deepEqual(decisionFromGuardResponse({
    hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'review this action' },
  }), { kind: 'ask', reason: 'review this action' });
  assert.deepEqual(decisionFromGuardResponse({
    hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'blocked test' },
  }), { kind: 'deny', reason: 'blocked test' });
});

test('decisionFromGuardResponse maps review to approval and sandbox-required to denial', () => {
  assert.deepEqual(decisionFromGuardResponse({ policy_action: 'review', review_hint: 'human review' }), {
    kind: 'ask',
    reason: 'human review',
  });
  assert.deepEqual(decisionFromGuardResponse({ policy_action: 'sandbox-required', reason: 'sandbox unavailable' }), {
    kind: 'deny',
    reason: 'sandbox unavailable',
  });
});

test('resolveDshApproval allows exactly one natively approved review', async () => {
  const requests = [];
  const { ctx } = pluginContext({
    approval: {
      async request(request) {
        requests.push(request);
        return 'allowed-once';
      },
    },
  });
  const exec = execution();
  const resolved = await resolveDshApproval(ctx, exec, { kind: 'ask', reason: 'review required' });
  assert.deepEqual(resolved, { kind: 'allow', reason: 'review required' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].toolName, 'bash');
  assert.equal(requests[0].callId, 'call-1');
  assert.equal(requests[0].reason, 'review required');
  assert.equal(requests[0].agent, exec.agent);
});

test('resolveDshApproval fails closed for rejection, missing service, and missing agent', async () => {
  const { ctx: rejectedContext } = pluginContext({
    approval: { request: async () => 'rejected' },
  });
  const rejected = await resolveDshApproval(rejectedContext, execution(), { kind: 'ask', reason: 'review' });
  assert.equal(rejected.kind, 'deny');
  assert.match(rejected.reason, /user rejected/);

  const { ctx: missingContext } = pluginContext();
  const missing = await resolveDshApproval(missingContext, execution(), { kind: 'ask', reason: 'review' });
  assert.equal(missing.kind, 'deny');
  assert.match(missing.reason, /no native approval service/);

  const { ctx: agentlessContext } = pluginContext({
    approval: { request: async () => 'allowed-once' },
  });
  const agentless = await resolveDshApproval(
    agentlessContext,
    execution('echo', { agent: undefined }),
    { kind: 'ask', reason: 'review' },
  );
  assert.equal(agentless.kind, 'deny');
  assert.match(agentless.reason, /no DSH agent/);
});

test('resolveDshApproval fails closed when the approval provider throws or returns an unknown outcome', async () => {
  const { ctx: throwingContext } = pluginContext({
    approval: { request: async () => { throw new Error('approval transport failed'); } },
  });
  const throwing = await resolveDshApproval(throwingContext, execution(), { kind: 'ask', reason: 'review' });
  assert.equal(throwing.kind, 'deny');
  assert.match(throwing.reason, /approval transport failed/);

  const { ctx: unknownContext } = pluginContext({
    approval: { request: async () => 'permanently-allowed' },
  });
  const unknown = await resolveDshApproval(unknownContext, execution(), { kind: 'ask', reason: 'review' });
  assert.equal(unknown.kind, 'deny');
  assert.match(unknown.reason, /unknown outcome/);
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

test('evaluateToolExecution preserves an authoritative native approval request', async () => {
  const guard = await fakeGuard(`
process.stdin.resume();
console.log(JSON.stringify({hookSpecificOutput:{permissionDecision:'ask',permissionDecisionReason:'review once'}}));
`);
  try {
    const result = await evaluateToolExecution(execution('echo review'), { command: guard.script });
    assert.deepEqual(result, { kind: 'ask', reason: 'review once' });
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

test('apply latches allowed calls into the monotonic guard before delegating', async () => {
  const { ctx, captured } = pluginContext();
  apply(ctx, { runner: runnerFor('allow') });
  assert.equal(typeof captured.pre, 'function');
  assert.equal(typeof captured.guard, 'function');

  const exec = execution();
  let delegated = 0;
  const result = await captured.pre(exec, async () => {
    delegated += 1;
    return { kind: 'allow' };
  });
  assert.deepEqual(result, { kind: 'allow' });
  assert.equal(delegated, 1);
  assert.equal(captured.guard(exec), undefined);
});

test('apply keeps denials monotonic even when an outer listener tries to force allow', async () => {
  const { ctx, captured } = pluginContext();
  apply(ctx, { runner: runnerFor('deny', { exitCode: 2, reason: 'policy denial' }) });

  const exec = execution('rm -rf /tmp/test');
  let delegated = 0;
  const decision = await captured.pre(exec, async () => {
    delegated += 1;
    return { kind: 'allow' };
  });
  assert.deepEqual(decision, { kind: 'deny', reason: 'policy denial' });
  assert.equal(delegated, 0);
  assert.equal(captured.guard(exec), 'policy denial');
});

test('apply fails closed when another pre-execute listener bypasses HOL Guard', () => {
  const { ctx, captured } = pluginContext();
  apply(ctx, { runner: runnerFor('allow') });
  assert.match(captured.guard(execution()), /review did not complete/);
});

test('apply routes Guard review through native DSH approval before latching allow', async () => {
  let approvalCount = 0;
  const { ctx, captured } = pluginContext({
    approval: {
      async request() {
        approvalCount += 1;
        return 'allowed-once';
      },
    },
  });
  apply(ctx, { runner: runnerFor('ask', { reason: 'approve exact command' }) });

  const exec = execution('printf approved');
  let delegated = 0;
  const decision = await captured.pre(exec, async () => {
    delegated += 1;
    return { kind: 'allow' };
  });
  assert.deepEqual(decision, { kind: 'allow' });
  assert.equal(approvalCount, 1);
  assert.equal(delegated, 1);
  assert.equal(captured.guard(exec), undefined);
});

test('apply fails closed at load time when monotonic DSH guard support is unavailable', () => {
  const { ctx } = pluginContext({ includeTools: false });
  assert.throws(() => apply(ctx), /monotonic guard support/);
});
