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

test('Guard environment removes interpreter, loader, shell, and Git injection variables', () => {
  const workspace = path.join(os.tmpdir(), 'hol-guard-workspace');
  const trustedBin = path.join(os.tmpdir(), 'hol-guard-trusted-bin');
  const environment = buildGuardEnvironment({
    PATH: `relative${path.delimiter}${workspace}${path.delimiter}${trustedBin}`,
    PYTHONPATH: '/tmp/attacker-python',
    PYTHONHOME: '/tmp/attacker-home',
    VIRTUAL_ENV: '/tmp/attacker-venv',
    LD_PRELOAD: '/tmp/attacker.so',
    DYLD_INSERT_LIBRARIES: '/tmp/attacker.dylib',
    NODE_OPTIONS: '--require=/tmp/attacker.js',
    BASH_ENV: '/tmp/attacker-bashrc',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.fsmonitor',
    GIT_CONFIG_VALUE_0: '/tmp/attacker-hook',
    HOL_GUARD_COMMAND: '/tmp/untrusted-command',
  }, workspace);

  assert.equal(environment.PATH, trustedBin);
  for (const name of [
    'PYTHONPATH',
    'PYTHONHOME',
    'VIRTUAL_ENV',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'NODE_OPTIONS',
    'BASH_ENV',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_VALUE_0',
    'HOL_GUARD_COMMAND',
  ]) {
    assert.equal(environment[name], undefined, `${name} must be removed`);
  }
  assert.equal(environment.PYTHONDONTWRITEBYTECODE, '1');
  assert.equal(environment.PYTHONNOUSERSITE, '1');
  assert.equal(environment.PYTHONSAFEPATH, '1');
});

test('PATH resolution skips workspace executables and selects an absolute external executable', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'hol-guard-process-trust-'));
  const workspace = path.join(tempDir, 'workspace');
  const workspaceBin = path.join(workspace, 'bin');
  const trustedBin = path.join(tempDir, 'trusted-bin');
  try {
    await makeExecutable(workspaceBin, 'hol-guard');
    const trusted = await makeExecutable(trustedBin, 'hol-guard');
    const prepared = prepareGuardProcess({
      env: {
        PATH: `${workspaceBin}${path.delimiter}${trustedBin}`,
        PATHEXT: '.CMD',
      },
    }, workspace);

    assert.equal(prepared.executable, await realpath(trusted));
    assert.equal(prepared.environment.PATH, trustedBin);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('explicit workspace and relative command paths fail closed', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'hol-guard-command-trust-'));
  const workspace = path.join(tempDir, 'workspace');
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
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('runner injection receives a scrubbed environment without requiring a local executable', () => {
  const workspace = path.join(os.tmpdir(), 'hol-guard-runner-workspace');
  const trustedBin = path.join(os.tmpdir(), 'hol-guard-runner-bin');
  const prepared = prepareGuardProcess({
    command: 'not-installed-in-test',
    runner: async () => {},
    env: {
      PATH: trustedBin,
      PYTHONPATH: '/tmp/attacker-python',
    },
  }, workspace);

  assert.equal(prepared.executable, 'not-installed-in-test');
  assert.equal(prepared.environment.PATH, trustedBin);
  assert.equal(prepared.environment.PYTHONPATH, undefined);
  assert.equal(prepared.environment.PYTHONNOUSERSITE, '1');
});
