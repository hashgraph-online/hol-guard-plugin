import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildGuardEnvironment,
  prepareGuardHome,
  prepareGuardProcess,
} from '../dsh-process.js';

async function makeExecutable(directory, baseName) {
  await mkdir(directory, { recursive: true });
  const fileName = process.platform === 'win32' ? `${baseName}.CMD` : baseName;
  const filePath = path.join(directory, fileName);
  const content = process.platform === 'win32'
    ? '@echo off\r\nexit /b 0\r\n'
    : '#!/bin/sh\nexit 0\n';
  await writeFile(filePath, content, 'utf8');
  if (process.platform !== 'win32') await chmod(filePath, 0o755);
  return filePath;
}

function withProcessPath(value, callback) {
  const previous = process.env.PATH;
  process.env.PATH = value;
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    });
}

async function expectedChildPath(...additionalEntries) {
  const runtimeDirectory = path.dirname(await realpath(process.execPath));
  const entries = [runtimeDirectory, ...additionalEntries.map((entry) => path.resolve(entry))];
  const seen = new Set();
  return entries
    .filter((entry) => {
      const identity = process.platform === 'win32' ? entry.toLowerCase() : entry;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    })
    .join(path.delimiter);
}

test('Guard child environment is allowlisted and does not inherit secrets or injection controls', async () => {
  const root = await mkdtemp(path.join(os.homedir(), '.hol-guard-env-trust-'));
  const workspace = path.join(root, 'workspace');
  const trustedBin = path.join(root, 'trusted-bin');
  const workspaceBin = path.join(workspace, 'bin');
  try {
    await mkdir(workspaceBin, { recursive: true });
    await mkdir(trustedBin, { recursive: true });
    const environment = buildGuardEnvironment({
      PATH: `relative${path.delimiter}${workspaceBin}${path.delimiter}${trustedBin}`,
      LANG: 'C.UTF-8',
      AWS_SECRET_ACCESS_KEY: 'do-not-forward',
      OPENAI_API_KEY: 'do-not-forward',
      HTTP_PROXY: 'http://attacker.invalid',
      HOL_GUARD_COMMAND: '/tmp/untrusted-command',
      LD_PRELOAD: '/tmp/attacker.so',
      NODE_OPTIONS: '--require=/tmp/attacker.js',
      PYTHONHOME: '/tmp/attacker-home',
      PYTHONPATH: '/tmp/attacker-python',
      VIRTUAL_ENV: '/tmp/attacker-venv',
    }, workspace);

    assert.equal(environment.PATH, await expectedChildPath(await realpath(trustedBin)));
    assert.equal(environment.LANG, 'C.UTF-8');
    for (const name of [
      'AWS_SECRET_ACCESS_KEY',
      'OPENAI_API_KEY',
      'HTTP_PROXY',
      'HOL_GUARD_COMMAND',
      'LD_PRELOAD',
      'NODE_OPTIONS',
      'PYTHONHOME',
      'PYTHONPATH',
      'VIRTUAL_ENV',
    ]) {
      assert.equal(environment[name], undefined, `${name} must not be forwarded`);
    }
    assert.equal(environment.PYTHONDONTWRITEBYTECODE, '1');
    assert.equal(environment.PYTHONIOENCODING, 'utf-8');
    assert.equal(environment.PYTHONNOUSERSITE, '1');
    assert.equal(environment.PYTHONSAFEPATH, '1');
    assert.equal(environment.PYTHONUTF8, '1');
    assert.equal(environment.GIT_CONFIG_GLOBAL, os.devNull);
    assert.equal(environment.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(environment.GIT_TERMINAL_PROMPT, '0');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the already-running DSH Node runtime is the first child PATH trust anchor', async () => {
  const root = await mkdtemp(path.join(os.homedir(), '.hol-guard-runtime-trust-'));
  const workspace = path.join(root, 'workspace');
  try {
    await mkdir(workspace, { recursive: true });
    const environment = buildGuardEnvironment({ PATH: '' }, workspace);
    const [runtimeDirectory] = environment.PATH.split(path.delimiter);
    const resolvedRuntime = await realpath(process.execPath);
    assert.equal(runtimeDirectory, path.dirname(resolvedRuntime));
    assert.equal(
      await realpath(path.join(runtimeDirectory, path.basename(resolvedRuntime))),
      resolvedRuntime,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('default PATH resolution skips workspace and temporary candidates and pins an owner-safe absolute executable', async () => {
  const root = await mkdtemp(path.join(os.homedir(), '.hol-guard-path-trust-'));
  const workspace = path.join(root, 'workspace');
  const workspaceBin = path.join(workspace, 'bin');
  const trustedBin = path.join(root, 'trusted-bin');
  const temporaryBin = await mkdtemp(path.join(os.tmpdir(), 'hol-guard-untrusted-bin-'));
  try {
    await makeExecutable(workspaceBin, 'hol-guard');
    await makeExecutable(temporaryBin, 'hol-guard');
    const trusted = await makeExecutable(trustedBin, 'hol-guard');
    await withProcessPath(
      `${workspaceBin}${path.delimiter}${temporaryBin}${path.delimiter}${trustedBin}`,
      async () => {
        const prepared = prepareGuardProcess({}, workspace);
        assert.equal(prepared.executable, await realpath(trusted));
        assert.equal(prepared.environment.PATH, await expectedChildPath(await realpath(trustedBin)));
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(temporaryBin, { recursive: true, force: true });
  }
});

test('explicit workspace and relative command paths fail closed', async () => {
  const root = await mkdtemp(path.join(os.homedir(), '.hol-guard-command-trust-'));
  const workspace = path.join(root, 'workspace');
  try {
    const workspaceCommand = await makeExecutable(workspace, 'hol-guard');
    assert.throws(
      () => prepareGuardProcess({ command: workspaceCommand }, workspace),
      /inside the active workspace/,
    );
    assert.throws(
      () => prepareGuardProcess({ command: `.${path.sep}hol-guard` }, workspace),
      /must be absolute/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('custom Guard home must be an absolute owner-safe directory outside the workspace', async () => {
  const root = await mkdtemp(path.join(os.homedir(), '.hol-guard-home-trust-'));
  const workspace = path.join(root, 'workspace');
  const guardHome = path.join(root, 'guard-home');
  try {
    await mkdir(workspace, { recursive: true });
    await mkdir(guardHome, { recursive: true });
    assert.equal(prepareGuardHome(guardHome, workspace), await realpath(guardHome));
    assert.throws(() => prepareGuardHome('relative-home', workspace), /must be an absolute/);
    assert.throws(() => prepareGuardHome(workspace, workspace), /inside the active workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runner injection receives the same minimal environment without requiring a local executable', async () => {
  const root = await mkdtemp(path.join(os.homedir(), '.hol-guard-runner-trust-'));
  const workspace = path.join(root, 'workspace');
  const trustedBin = path.join(root, 'trusted-bin');
  try {
    await mkdir(workspace, { recursive: true });
    await mkdir(trustedBin, { recursive: true });
    const prepared = prepareGuardProcess({
      command: 'not-installed-in-test',
      runner: async () => {},
      env: {
        PATH: trustedBin,
        OPENAI_API_KEY: 'do-not-forward',
        PYTHONPATH: '/tmp/attacker-python',
      },
    }, workspace);

    assert.equal(prepared.executable, 'not-installed-in-test');
    assert.equal(prepared.environment.PATH, await expectedChildPath(await realpath(trustedBin)));
    assert.equal(prepared.environment.OPENAI_API_KEY, undefined);
    assert.equal(prepared.environment.PYTHONPATH, undefined);
    assert.equal(prepared.environment.PYTHONNOUSERSITE, '1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
