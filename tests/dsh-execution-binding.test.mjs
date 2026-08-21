import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { apply } from '../index.js';

function execution(overrides = {}) {
  return {
    token: Symbol('execution'),
    callId: 'call-binding-1',
    rootCallId: 'root-binding-1',
    name: 'bash',
    arguments: { command: 'printf safe' },
    agent: { session: { header: { cwd: process.cwd() } } },
    parent: undefined,
    signal: new AbortController().signal,
    deferContext() {},
    concludeTurn() {},
    ...overrides,
  };
}

function pluginContext() {
  const captured = { pre: null, guard: null };
  return {
    captured,
    ctx: {
      on(event, handler) {
        assert.equal(event, 'tools/pre-execute');
        captured.pre = handler;
      },
      get(name) {
        assert.equal(name, 'approval');
        return undefined;
      },
      tools: {
        guard(handler) {
          captured.guard = handler;
          return () => {};
        },
      },
    },
  };
}

const allowRunner = async () => ({
  exitCode: 0,
  signal: null,
  stdout: JSON.stringify({
    hookSpecificOutput: { permissionDecision: 'allow' },
  }),
  stderr: '',
});

test('approved execution identity fields are locked before downstream policy runs', async () => {
  const { ctx, captured } = pluginContext();
  apply(ctx, { runner: allowRunner });
  const exec = execution();

  const decision = await captured.pre(exec, async () => {
    assert.throws(() => {
      exec.name = 'python';
    }, TypeError);
    assert.throws(() => {
      Object.defineProperty(exec, 'arguments', {
        value: { command: 'rm -rf /tmp/unsafe' },
      });
    }, TypeError);
    return { kind: 'allow' };
  });

  assert.deepEqual(decision, { kind: 'allow' });
  assert.equal(exec.name, 'bash');
  assert.equal(exec.arguments.command, 'printf safe');
  assert.equal(captured.guard(exec), undefined);
});

test('workspace mutation after review is converted into a monotonic denial', async () => {
  const { ctx, captured } = pluginContext();
  apply(ctx, { runner: allowRunner });
  const exec = execution();

  const decision = await captured.pre(exec, async () => {
    exec.agent.session.header.cwd = path.join(process.cwd(), 'mutated-workspace');
    return { kind: 'allow' };
  });

  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /changed after review/);
  assert.match(captured.guard(exec), /changed after review/);
});

test('non-data identity fields fail closed before downstream dispatch', async () => {
  const { ctx, captured } = pluginContext();
  apply(ctx, { runner: allowRunner });
  const exec = execution();
  Object.defineProperty(exec, 'name', {
    configurable: true,
    enumerable: true,
    get() {
      return 'bash';
    },
  });
  let delegated = false;

  const decision = await captured.pre(exec, async () => {
    delegated = true;
    return { kind: 'allow' };
  });

  assert.equal(delegated, false);
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /not a data property/);
  assert.match(captured.guard(exec), /not a data property/);
});
