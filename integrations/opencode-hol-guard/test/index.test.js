import assert from 'node:assert/strict';
import test from 'node:test';

import { createHolGuardPlugin } from '../src/index.js';

async function executeWithPlugin(pluginFactory, runner, args = { command: 'echo safe' }) {
  const plugin = await pluginFactory({ directory: '/tmp', project: { id: 'test-project' } });
  let executions = 0;
  try {
    await plugin['tool.execute.before'](
      { tool: 'bash', sessionID: 'session-1', callID: 'call-1' },
      { args },
    );
    executions += 1;
    return { executions, error: null, runner };
  } catch (error) {
    return { executions, error, runner };
  }
}

function result(decision, extra = {}) {
  return async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ decision, ...extra }),
    stderr: '',
  });
}

test('explicit allow permits exactly one downstream execution', async () => {
  const run = result('allow');
  const outcome = await executeWithPlugin(createHolGuardPlugin({ runner: run }), run);
  assert.equal(outcome.executions, 1);
  assert.equal(outcome.error, null);
});

for (const decision of ['deny', 'review', 'ask', 'warn']) {
  test(`${decision} never permits downstream execution`, async () => {
    const run = result(decision);
    const outcome = await executeWithPlugin(createHolGuardPlugin({ runner: run }), run);
    assert.equal(outcome.executions, 0);
    assert.ok(outcome.error instanceof Error);
  });
}

test('provider failure fails closed without leaking tool arguments', async () => {
  const secret = 'super-secret-argument';
  const run = async () => { throw new Error(`provider saw ${secret}`); };
  const outcome = await executeWithPlugin(createHolGuardPlugin({ runner: run }), run, { token: secret });
  assert.equal(outcome.executions, 0);
  assert.ok(outcome.error instanceof Error);
  assert.equal(outcome.error.message.includes(secret), false);
});

test('malformed provider output fails closed', async () => {
  const run = async () => ({ exitCode: 0, stdout: 'not-json', stderr: '' });
  const outcome = await executeWithPlugin(createHolGuardPlugin({ runner: run }), run);
  assert.equal(outcome.executions, 0);
  assert.match(outcome.error.message, /no authoritative decision/i);
});

test('non-zero allow fails closed', async () => {
  const run = async () => ({ exitCode: 1, stdout: JSON.stringify({ decision: 'allow' }), stderr: '' });
  const outcome = await executeWithPlugin(createHolGuardPlugin({ runner: run }), run);
  assert.equal(outcome.executions, 0);
});

test('oversized input fails closed before the provider runs', async () => {
  let calls = 0;
  const run = async () => {
    calls += 1;
    return { exitCode: 0, stdout: JSON.stringify({ decision: 'allow' }), stderr: '' };
  };
  const outcome = await executeWithPlugin(
    createHolGuardPlugin({ runner: run }),
    run,
    { content: 'x'.repeat(30 * 1024) },
  );
  assert.equal(outcome.executions, 0);
  assert.equal(calls, 0);
});

test('nested deny overrides an outer allow', async () => {
  const run = async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ decision: 'allow', result: { policy_action: 'block' } }),
    stderr: '',
  });
  const outcome = await executeWithPlugin(createHolGuardPlugin({ runner: run }), run);
  assert.equal(outcome.executions, 0);
});
