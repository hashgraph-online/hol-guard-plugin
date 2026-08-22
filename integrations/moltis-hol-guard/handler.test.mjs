import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  classifyGuardDecision,
  evaluateBeforeToolCall,
  resolveWorkspace,
  translateMoltisPayload,
} from './handler.mjs';

const payload = {
  event: 'BeforeToolCall',
  session_key: 'session-1',
  tool_name: 'exec',
  arguments: { command: 'printf safe' },
  channel: { surface: 'web', session_kind: 'web' },
};

async function simulatedExecution(runner) {
  let executed = 0;
  const decision = await evaluateBeforeToolCall(payload, { runner, workspace: '/tmp/project' });
  if (decision.kind === 'allow') executed += 1;
  return { decision, executed };
}

test('translates Moltis final tool payload without changing arguments', () => {
  const translated = translateMoltisPayload(payload, '/tmp/project');
  assert.equal(translated.tool_name, 'exec');
  assert.deepEqual(translated.tool_input, payload.arguments);
  assert.equal(translated.session_id, 'session-1');
  assert.equal(translated.cwd, '/tmp/project');
  assert.equal(translated.runtime_context.framework, 'moltis');
  assert.equal(translated.runtime_context.channel.surface, 'web');
});

test('project-local hook layout derives the enclosing workspace', () => {
  const workspace = resolveWorkspace({ cwd: '/tmp/demo/.moltis/hooks/hol-guard', env: {} });
  assert.equal(workspace, '/tmp/demo');
});

test('filesystem-root project hook derives root workspace', () => {
  const workspace = resolveWorkspace({ cwd: '/.moltis/hooks/hol-guard', env: {} });
  assert.equal(workspace, '/');
});

test('explicit workspace overrides hook location', () => {
  const workspace = resolveWorkspace({ cwd: '/tmp/demo/.moltis/hooks/hol-guard', env: { HOL_GUARD_WORKSPACE: '/srv/work' } });
  assert.equal(workspace, '/srv/work');
});

test('executing handler as a script never silently allows when Guard is unavailable', () => {
  const handler = fileURLToPath(new URL('./handler.mjs', import.meta.url));
  const child = spawnSync(process.execPath, [handler], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, PATH: '' },
  });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /HOL Guard is unavailable/);
});

test('allow executes downstream exactly once', async () => {
  const result = await simulatedExecution(async () => ({ code: 0, stdout: '{"decision":"allow"}' }));
  assert.equal(result.decision.kind, 'allow');
  assert.equal(result.executed, 1);
});

test('deny executes downstream zero times', async () => {
  const result = await simulatedExecution(async () => ({ code: 0, stdout: '{"decision":"deny","reason":"policy denied"}' }));
  assert.equal(result.decision.kind, 'block');
  assert.equal(result.executed, 0);
});

test('review executes downstream zero times', async () => {
  const result = await simulatedExecution(async () => ({ code: 0, stdout: '{"policy_action":"review"}' }));
  assert.equal(result.decision.kind, 'block');
  assert.equal(result.executed, 0);
});

test('provider failure executes downstream zero times without leaking arguments', async () => {
  const result = await simulatedExecution(async () => { throw new Error('provider failed: printf safe'); });
  assert.equal(result.decision.kind, 'block');
  assert.equal(result.executed, 0);
  assert.equal(result.decision.reason.includes('printf safe'), false);
});

test('malformed or ambiguous output executes downstream zero times', async () => {
  const malformed = await simulatedExecution(async () => ({ code: 0, stdout: 'not-json' }));
  const ambiguous = await simulatedExecution(async () => ({ code: 0, stdout: '{"status":"ok"}' }));
  assert.equal(malformed.executed, 0);
  assert.equal(ambiguous.executed, 0);
});

test('nonzero Guard result without authoritative deny executes downstream zero times', async () => {
  const result = await simulatedExecution(async () => ({ code: 2, stdout: '{"decision":"allow"}' }));
  assert.equal(result.executed, 0);
});

test('deny takes precedence over nested allow', () => {
  assert.deepEqual(
    classifyGuardDecision({ decision: 'allow', data: { hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'blocked' } } }),
    { kind: 'deny', reason: 'blocked' },
  );
});

test('oversized Moltis payload fails closed before provider execution', async () => {
  let providerCalls = 0;
  const oversized = { ...payload, arguments: { command: 'x'.repeat(25 * 1024) } };
  const result = await evaluateBeforeToolCall(oversized, {
    workspace: '/tmp/project',
    runner: async () => { providerCalls += 1; return { code: 0, stdout: '{"decision":"allow"}' }; },
  });
  assert.equal(result.kind, 'block');
  assert.equal(providerCalls, 0);
});
