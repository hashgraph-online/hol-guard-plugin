import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyGuardDecision,
  evaluateBeforeTool,
  parseGuardOutput,
} from '../hooks/hol-guard-before-tool.mjs';

const event = JSON.stringify({
  session_id: 'session-test',
  cwd: '/tmp/project',
  hook_event_name: 'BeforeTool',
  tool_name: 'run_shell_command',
  tool_input: { command: 'printf test' },
  tool_call_id: 'call-1',
});

async function simulateGeminiExecution(runner) {
  let executions = 0;
  const hookResult = await evaluateBeforeTool(event, { runner });
  if (hookResult.decision === 'allow') executions += 1;
  return { hookResult, executions };
}

test('parses direct and trailing authoritative Guard JSON', () => {
  assert.deepEqual(parseGuardOutput('{"decision":"allow"}'), { decision: 'allow' });
  assert.deepEqual(parseGuardOutput('diagnostic\n{"decision":"deny","reason":"blocked"}\n'), {
    decision: 'deny',
    reason: 'blocked',
  });
});

test('deny outranks nested allow', () => {
  assert.deepEqual(
    classifyGuardDecision({ decision: 'allow', result: { decision: 'deny', reason: 'policy denied' } }),
    { kind: 'deny', reason: 'policy denied' },
  );
});

test('allow executes the downstream Gemini tool exactly once', async () => {
  const result = await simulateGeminiExecution(async () => ({ exitCode: 0, stdout: '{"decision":"allow"}' }));
  assert.deepEqual(result.hookResult, { decision: 'allow' });
  assert.equal(result.executions, 1);
});

test('deny executes zero downstream Gemini tools', async () => {
  const result = await simulateGeminiExecution(async () => ({
    exitCode: 0,
    stdout: '{"decision":"deny","reason":"unsafe command"}',
  }));
  assert.equal(result.hookResult.decision, 'deny');
  assert.match(result.hookResult.reason, /unsafe command/);
  assert.equal(result.executions, 0);
});

test('review executes zero downstream Gemini tools', async () => {
  const result = await simulateGeminiExecution(async () => ({
    exitCode: 0,
    stdout: '{"decision":"review","reason":"approval required"}',
  }));
  assert.equal(result.hookResult.decision, 'deny');
  assert.match(result.hookResult.reason, /approval required/);
  assert.equal(result.executions, 0);
});

test('Guard unavailability executes zero downstream Gemini tools', async () => {
  const result = await simulateGeminiExecution(async () => {
    throw new Error('unavailable');
  });
  assert.equal(result.hookResult.decision, 'deny');
  assert.match(result.hookResult.reason, /unavailable/);
  assert.equal(result.executions, 0);
});

test('malformed or ambiguous Guard output executes zero downstream Gemini tools', async () => {
  for (const stdout of ['not-json', '{"status":"ok"}', '{"decision":"allow","result":{"decision":"review"}}']) {
    const result = await simulateGeminiExecution(async () => ({ exitCode: 0, stdout }));
    assert.equal(result.hookResult.decision, 'deny');
    assert.equal(result.executions, 0);
  }
});

test('nonzero Guard process cannot authorize a tool', async () => {
  const result = await simulateGeminiExecution(async () => ({ exitCode: 1, stdout: '{"decision":"allow"}' }));
  assert.equal(result.hookResult.decision, 'deny');
  assert.equal(result.executions, 0);
});

test('invalid and oversized Gemini payloads fail closed', async () => {
  const invalid = await evaluateBeforeTool('{"tool_input":{}}', {
    runner: async () => ({ exitCode: 0, stdout: '{"decision":"allow"}' }),
  });
  assert.equal(invalid.decision, 'deny');

  const oversized = await evaluateBeforeTool('x'.repeat(24 * 1024 + 1), {
    runner: async () => ({ exitCode: 0, stdout: '{"decision":"allow"}' }),
  });
  assert.equal(oversized.decision, 'deny');
});
