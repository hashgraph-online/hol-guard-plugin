import assert from 'node:assert/strict';
import process from 'node:process';
import test from 'node:test';

import { createHolGuardToolInvocationGuard } from '../src/index.js';

function qwenContext(overrides = {}) {
  return {
    callId: 'call-1',
    toolName: 'run_shell_command',
    args: { command: 'printf test' },
    signal: new AbortController().signal,
    sessionId: 'session-1',
    cwd: '/tmp/project',
    invocationContext: { promptId: 'prompt-1' },
    ...overrides,
  };
}

async function simulateExecution(guard, context = qwenContext()) {
  let executorCalls = 0;
  const decision = await guard(context);
  if (decision.allowed === true) executorCalls += 1;
  return { decision, executorCalls };
}

test('authoritative allow reaches the downstream executor exactly once', async () => {
  const guard = createHolGuardToolInvocationGuard({
    runner: async () => ({ exitCode: 0, stdout: '{"decision":"allow"}' }),
  });
  const result = await simulateExecution(guard);
  assert.deepEqual(result.decision, { allowed: true });
  assert.equal(result.executorCalls, 1);
});

test('deny reaches zero downstream executor calls', async () => {
  const guard = createHolGuardToolInvocationGuard({
    runner: async () => ({ exitCode: 0, stdout: '{"decision":"deny","reason":"unsafe command"}' }),
  });
  const result = await simulateExecution(guard);
  assert.equal(result.decision.allowed, false);
  assert.match(result.decision.reason, /unsafe command/);
  assert.equal(result.executorCalls, 0);
});

test('review reaches zero downstream executor calls', async () => {
  const guard = createHolGuardToolInvocationGuard({
    runner: async () => ({ exitCode: 0, stdout: '{"decision":"review","reason":"approval required"}' }),
  });
  const result = await simulateExecution(guard);
  assert.equal(result.decision.allowed, false);
  assert.match(result.decision.reason, /approval required/);
  assert.equal(result.executorCalls, 0);
});

test('Guard unavailability and malformed output fail closed', async () => {
  for (const runner of [
    async () => { throw new Error('unavailable'); },
    async () => ({ exitCode: 0, stdout: 'not-json' }),
    async () => ({ exitCode: 0, stdout: '{"status":"ok"}' }),
    async () => ({ exitCode: 1, stdout: '{"decision":"allow"}' }),
  ]) {
    const result = await simulateExecution(createHolGuardToolInvocationGuard({ runner }));
    assert.equal(result.decision.allowed, false);
    assert.equal(result.executorCalls, 0);
  }
});

test('an already-aborted Qwen signal never invokes Guard or the executor', async () => {
  const controller = new AbortController();
  controller.abort();
  let runnerCalls = 0;
  const guard = createHolGuardToolInvocationGuard({
    runner: async () => {
      runnerCalls += 1;
      return { exitCode: 0, stdout: '{"decision":"allow"}' };
    },
  });
  const result = await simulateExecution(guard, qwenContext({ signal: controller.signal }));
  assert.equal(result.decision.allowed, false);
  assert.equal(runnerCalls, 0);
  assert.equal(result.executorCalls, 0);
});

test('cancellation during Guard review remains a cancellation and executes nothing', async () => {
  const controller = new AbortController();
  const guard = createHolGuardToolInvocationGuard({
    runner: async () => {
      controller.abort();
      throw new Error('runner cancelled');
    },
  });
  const result = await simulateExecution(guard, qwenContext({ signal: controller.signal }));
  assert.equal(result.decision.allowed, false);
  assert.match(result.decision.reason, /cancelled/);
  assert.doesNotMatch(result.decision.reason, /unavailable/);
  assert.equal(result.executorCalls, 0);
});

test('the exact final Qwen context is forwarded within the bounded Guard envelope', async () => {
  let observed;
  const guard = createHolGuardToolInvocationGuard({
    runner: async ({ input, cwd, signal }) => {
      observed = { payload: JSON.parse(input), cwd, signal };
      return { exitCode: 0, stdout: '{"decision":"allow"}' };
    },
  });
  const context = qwenContext({
    toolName: 'write_file',
    args: { path: '/tmp/project/a.txt', content: 'hello' },
    sessionId: 'runtime-session',
    cwd: '/tmp/project',
  });
  const result = await simulateExecution(guard, context);
  assert.equal(result.decision.allowed, true);
  assert.equal(observed.payload.tool_name, 'write_file');
  assert.deepEqual(observed.payload.tool_input, context.args);
  assert.equal(observed.payload.tool_use_id, 'call-1');
  assert.equal(observed.payload.cwd, '/tmp/project');
  assert.equal(observed.payload.runtime_context.framework, 'qwen-code');
  assert.equal(observed.payload.runtime_context.session_id, 'runtime-session');
  assert.equal(observed.cwd, '/tmp/project');
  assert.equal(observed.signal, context.signal);
});

test('payload and Guard process share the same resolved cwd fallback', async () => {
  let observed;
  const guard = createHolGuardToolInvocationGuard({
    runner: async ({ input, cwd }) => {
      observed = { payload: JSON.parse(input), cwd };
      return { exitCode: 0, stdout: '{"decision":"allow"}' };
    },
  });
  const result = await simulateExecution(guard, qwenContext({ cwd: '   ' }));
  assert.equal(result.decision.allowed, true);
  assert.equal(observed.cwd, process.cwd());
  assert.equal(observed.payload.cwd, process.cwd());
});

test('oversized final arguments fail closed before the Guard runner', async () => {
  let runnerCalls = 0;
  const guard = createHolGuardToolInvocationGuard({
    runner: async () => {
      runnerCalls += 1;
      return { exitCode: 0, stdout: '{"decision":"allow"}' };
    },
  });
  const result = await simulateExecution(guard, qwenContext({ args: { content: 'x'.repeat(30 * 1024) } }));
  assert.equal(result.decision.allowed, false);
  assert.equal(runnerCalls, 0);
  assert.equal(result.executorCalls, 0);
});