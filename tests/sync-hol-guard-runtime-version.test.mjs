import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  RUNTIME_PIN_PACKAGES,
  RUNTIME_PIN_TARGETS,
  inspectHolGuardRuntimePins,
  syncHolGuardRuntimeVersion,
  validateStableVersion,
} from '../scripts/sync-hol-guard-runtime-version.mjs';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scriptPath = fileURLToPath(new URL('../scripts/sync-hol-guard-runtime-version.mjs', import.meta.url));
const temporaryRoots = [];

async function createFixture(version = '2.1.27') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hol-guard-runtime-sync-'));
  temporaryRoots.push(root);
  for (const target of RUNTIME_PIN_TARGETS) {
    const packageName = RUNTIME_PIN_PACKAGES[target];
    const absolutePath = path.join(root, target);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, `before\n\`pipx install ${packageName}==${version}\`\nafter\n`, 'utf8');
  }
  return root;
}

async function readFixture(root) {
  return Promise.all(RUNTIME_PIN_TARGETS.map((target) => readFile(path.join(root, target), 'utf8')));
}

test.after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test('the repository review payload starts synchronized', async () => {
  const inspected = await inspectHolGuardRuntimePins(repositoryRoot);
  assert.match(inspected.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.deepEqual(
    inspected.targets.map((target) => target.packageName),
    ['hol-guard', 'hol-guard', 'plugin-scanner'],
  );
});

test('updates every reviewed runtime pin and is idempotent', async () => {
  const root = await createFixture();
  const first = await syncHolGuardRuntimeVersion({ root, version: '2.1.28' });
  assert.equal(first.previousVersion, '2.1.27');
  assert.equal(first.version, '2.1.28');
  assert.deepEqual(first.changedFiles, RUNTIME_PIN_TARGETS);

  for (const target of RUNTIME_PIN_TARGETS) {
    const packageName = RUNTIME_PIN_PACKAGES[target];
    const content = await readFile(path.join(root, target), 'utf8');
    assert.match(content, new RegExp(`pipx install ${packageName}==2\\.1\\.28`));
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

test('rejects prereleases, malformed versions, line terminators, and shell-like input', () => {
  for (const version of [
    '2.1.28rc1',
    '2.1.28-alpha.1',
    'v2.1.28',
    'latest',
    '2.1',
    '2.1.28;echo pwned',
    '2.1.28\n',
    '2.1.28\r\n',
  ]) {
    assert.throws(() => validateStableVersion(version), /exact stable X\.Y\.Z/);
  }
});

test('the CLI rejects a version containing a trailing line terminator', async () => {
  const root = await createFixture();
  const before = await readFixture(root);
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, '--root', root, '--version', '2.1.28\n']),
    (error) => {
      assert.match(error.stderr, /exact stable X\.Y\.Z/);
      return true;
    },
  );
  assert.deepEqual(await readFixture(root), before);
});

test('preparation failure leaves every reviewed pin unchanged', async () => {
  const root = await createFixture();
  const before = await readFixture(root);
  let writes = 0;
  const fileOperations = {
    rename,
    rm,
    writeFile: async (...arguments_) => {
      writes += 1;
      if (writes === 2) {
        throw new Error('injected preparation failure');
      }
      return writeFile(...arguments_);
    },
  };

  await assert.rejects(
    syncHolGuardRuntimeVersion({ root, version: '2.1.28', fileOperations }),
    /injected preparation failure/,
  );
  assert.deepEqual(await readFixture(root), before);
  assert.equal((await inspectHolGuardRuntimePins(root)).version, '2.1.27');
});

test('commit failure rolls back every pin already replaced', async () => {
  const root = await createFixture();
  const before = await readFixture(root);
  let renames = 0;
  const fileOperations = {
    rm,
    writeFile,
    rename: async (...arguments_) => {
      renames += 1;
      if (renames === 2) {
        throw new Error('injected commit failure');
      }
      return rename(...arguments_);
    },
  };

  await assert.rejects(
    syncHolGuardRuntimeVersion({ root, version: '2.1.28', fileOperations }),
    /injected commit failure/,
  );
  assert.deepEqual(await readFixture(root), before);
  assert.equal((await inspectHolGuardRuntimePins(root)).version, '2.1.27');
});

test('fails closed when a target is missing, duplicated, unpinned, or divergent', async () => {
  const firstTarget = RUNTIME_PIN_TARGETS[0];
  const firstPackage = RUNTIME_PIN_PACKAGES[firstTarget];

  const missingRoot = await createFixture();
  await writeFile(path.join(missingRoot, firstTarget), 'no install command\n', 'utf8');
  await assert.rejects(inspectHolGuardRuntimePins(missingRoot), /exactly one/);

  const duplicateRoot = await createFixture();
  await writeFile(
    path.join(duplicateRoot, firstTarget),
    `pipx install ${firstPackage}==2.1.27\npipx install ${firstPackage}==2.1.27\n`,
    'utf8',
  );
  await assert.rejects(inspectHolGuardRuntimePins(duplicateRoot), /exactly one/);

  const unpinnedRoot = await createFixture();
  await writeFile(path.join(unpinnedRoot, firstTarget), `pipx install ${firstPackage}\n`, 'utf8');
  await assert.rejects(inspectHolGuardRuntimePins(unpinnedRoot), /must pin hol-guard/);

  const nearMatchRoot = await createFixture();
  await writeFile(path.join(nearMatchRoot, firstTarget), 'pipx install hol-guardian==2.1.27\n', 'utf8');
  await assert.rejects(inspectHolGuardRuntimePins(nearMatchRoot), /exactly one/);

  const divergentRoot = await createFixture();
  await writeFile(path.join(divergentRoot, firstTarget), `pipx install ${firstPackage}==2.1.26\n`, 'utf8');
  await assert.rejects(inspectHolGuardRuntimePins(divergentRoot), /pins have drifted/);
});

test('fails closed when the scanner package name regresses to the runtime package', async () => {
  const root = await createFixture();
  const scannerTarget = 'distributions/wshobson-agents/skills/plugin-scanner/SKILL.md';
  await writeFile(path.join(root, scannerTarget), 'pipx install hol-guard==2.1.27\n', 'utf8');
  await assert.rejects(inspectHolGuardRuntimePins(root), /pipx install plugin-scanner/);
});

test('the workflow validates PR code read-only and publishes only from trusted main', async () => {
  const workflow = await readFile(path.join(repositoryRoot, '.github/workflows/sync-hol-guard-runtime-version.yml'), 'utf8');

  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /verify-updater:[\s\S]*persist-credentials: false/);
  assert.match(workflow, /sync-runtime:[\s\S]*if: github\.event_name != 'pull_request'/);
  assert.match(workflow, /sync-runtime:[\s\S]*permissions:\n      contents: write/);
  assert.match(workflow, /sync-runtime:[\s\S]*ref: main/);
  assert.match(workflow, /git reset --hard origin\/main/);
  assert.doesNotMatch(workflow, /git rebase/);
});
