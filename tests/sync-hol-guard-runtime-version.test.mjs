import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  RUNTIME_PIN_TARGETS,
  inspectHolGuardRuntimePins,
  syncHolGuardRuntimeVersion,
  validateStableVersion,
} from '../scripts/sync-hol-guard-runtime-version.mjs';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL('../scripts/sync-hol-guard-runtime-version.mjs', import.meta.url));
const temporaryRoots = [];

async function createFixture(version = '2.1.27') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hol-guard-runtime-sync-'));
  temporaryRoots.push(root);
  for (const target of RUNTIME_PIN_TARGETS) {
    const absolutePath = path.join(root, target);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, `before\n\`pipx install hol-guard==${version}\`\nafter\n`, 'utf8');
  }
  return root;
}

test.after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test('the repository review payload starts synchronized', async () => {
  const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const inspected = await inspectHolGuardRuntimePins(repositoryRoot);
  assert.match(inspected.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
});

test('updates every reviewed runtime pin and is idempotent', async () => {
  const root = await createFixture();
  const first = await syncHolGuardRuntimeVersion({ root, version: '2.1.28' });
  assert.equal(first.previousVersion, '2.1.27');
  assert.equal(first.version, '2.1.28');
  assert.deepEqual(first.changedFiles, RUNTIME_PIN_TARGETS);

  for (const target of RUNTIME_PIN_TARGETS) {
    const content = await readFile(path.join(root, target), 'utf8');
    assert.match(content, /pipx install hol-guard==2\.1\.28/);
    assert.doesNotMatch(content, /2\.1\.27/);
  }

  const second = await syncHolGuardRuntimeVersion({ root, version: '2.1.28' });
  assert.deepEqual(second.changedFiles, []);
});

test('check mode verifies the current or requested exact version without writing', async () => {
  const root = await createFixture();
  const current = await syncHolGuardRuntimeVersion({ root, check: true });
  assert.equal(current.version, '2.1.27');
  await syncHolGuardRuntimeVersion({ root, version: '2.1.27', check: true });
  await assert.rejects(
    syncHolGuardRuntimeVersion({ root, version: '2.1.28', check: true }),
    /runtime pin is 2\.1\.27, expected 2\.1\.28/,
  );
});

test('the command-line entry point performs a real fixture update and check', async () => {
  const root = await createFixture();
  const update = await execFileAsync(process.execPath, [scriptPath, '--root', root, '--version', '3.0.1']);
  assert.match(update.stdout, /Updated HOL Guard runtime pins from 2\.1\.27 to 3\.0\.1/);

  const check = await execFileAsync(process.execPath, [scriptPath, '--root', root, '--check', '--version', '3.0.1']);
  assert.match(check.stdout, /synchronized at 3\.0\.1/);
});

test('rejects prereleases, malformed versions, and shell-like input', () => {
  for (const version of ['2.1.28rc1', '2.1.28-alpha.1', 'v2.1.28', 'latest', '2.1', '2.1.28;echo pwned']) {
    assert.throws(() => validateStableVersion(version), /exact stable X\.Y\.Z/);
  }
});

test('fails closed when a target is missing, duplicated, unpinned, or divergent', async () => {
  const missingRoot = await createFixture();
  await writeFile(path.join(missingRoot, RUNTIME_PIN_TARGETS[0]), 'no install command\n', 'utf8');
  await assert.rejects(inspectHolGuardRuntimePins(missingRoot), /exactly one/);

  const duplicateRoot = await createFixture();
  await writeFile(
    path.join(duplicateRoot, RUNTIME_PIN_TARGETS[0]),
    'pipx install hol-guard==2.1.27\npipx install hol-guard==2.1.27\n',
    'utf8',
  );
  await assert.rejects(inspectHolGuardRuntimePins(duplicateRoot), /exactly one/);

  const unpinnedRoot = await createFixture();
  await writeFile(path.join(unpinnedRoot, RUNTIME_PIN_TARGETS[0]), 'pipx install hol-guard\n', 'utf8');
  await assert.rejects(inspectHolGuardRuntimePins(unpinnedRoot), /must pin HOL Guard/);

  const nearMatchRoot = await createFixture();
  await writeFile(path.join(nearMatchRoot, RUNTIME_PIN_TARGETS[0]), 'pipx install hol-guardian==2.1.27\n', 'utf8');
  await assert.rejects(inspectHolGuardRuntimePins(nearMatchRoot), /exactly one/);

  const divergentRoot = await createFixture();
  await writeFile(path.join(divergentRoot, RUNTIME_PIN_TARGETS[0]), 'pipx install hol-guard==2.1.26\n', 'utf8');
  await assert.rejects(inspectHolGuardRuntimePins(divergentRoot), /pins have drifted/);
});
