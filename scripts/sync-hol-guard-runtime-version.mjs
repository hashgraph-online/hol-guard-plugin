#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNTIME_PIN_TARGETS = Object.freeze([
  'distributions/wshobson-agents/README.md',
  'distributions/wshobson-agents/skills/hol-guard/SKILL.md',
  'distributions/wshobson-agents/skills/plugin-scanner/SKILL.md',
]);

const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const INSTALL_COMMAND_PATTERN = /\bpipx install hol-guard(?:==([^\s`'"\\]+))?(?=$|[\s`'"])/gm;

export function validateStableVersion(version) {
  if (typeof version !== 'string' || !STABLE_VERSION_PATTERN.test(version)) {
    throw new Error(`HOL Guard runtime version must be an exact stable X.Y.Z release, received: ${String(version)}`);
  }
  return version;
}

async function inspectTarget(root, relativePath) {
  const absolutePath = path.join(root, relativePath);
  const content = await readFile(absolutePath, 'utf8');
  const matches = [...content.matchAll(INSTALL_COMMAND_PATTERN)];

  if (matches.length !== 1) {
    throw new Error(`${relativePath} must contain exactly one "pipx install hol-guard" command; found ${matches.length}`);
  }

  const [match] = matches;
  const version = match[1];
  if (!version) {
    throw new Error(`${relativePath} must pin HOL Guard with "pipx install hol-guard==X.Y.Z"`);
  }
  validateStableVersion(version);

  return {
    relativePath,
    absolutePath,
    content,
    command: match[0],
    commandIndex: match.index,
    version,
  };
}

export async function inspectHolGuardRuntimePins(root = process.cwd()) {
  const resolvedRoot = path.resolve(root);
  const targets = await Promise.all(RUNTIME_PIN_TARGETS.map((target) => inspectTarget(resolvedRoot, target)));
  const versions = [...new Set(targets.map((target) => target.version))];

  if (versions.length !== 1) {
    const details = targets.map((target) => `${target.relativePath}=${target.version}`).join(', ');
    throw new Error(`HOL Guard runtime pins have drifted and will not be rewritten automatically: ${details}`);
  }

  return {
    root: resolvedRoot,
    version: versions[0],
    targets,
  };
}

export async function syncHolGuardRuntimeVersion({
  root = process.cwd(),
  version,
  check = false,
} = {}) {
  const inspected = await inspectHolGuardRuntimePins(root);
  const requestedVersion = version === undefined ? undefined : validateStableVersion(version);
  const targetVersion = requestedVersion ?? inspected.version;

  if (check) {
    if (inspected.version !== targetVersion) {
      throw new Error(`HOL Guard runtime pin is ${inspected.version}, expected ${targetVersion}`);
    }
    return {
      previousVersion: inspected.version,
      version: targetVersion,
      changedFiles: [],
    };
  }

  if (!requestedVersion) {
    throw new Error('--version X.Y.Z is required unless --check is used');
  }

  const changedFiles = [];
  for (const target of inspected.targets) {
    if (target.version === targetVersion) {
      continue;
    }

    const replacement = `pipx install hol-guard==${targetVersion}`;
    const updated = `${target.content.slice(0, target.commandIndex)}${replacement}${target.content.slice(target.commandIndex + target.command.length)}`;
    await writeFile(target.absolutePath, updated, 'utf8');
    changedFiles.push(target.relativePath);
  }

  return {
    previousVersion: inspected.version,
    version: targetVersion,
    changedFiles,
  };
}

function usage() {
  return [
    'Usage:',
    '  node scripts/sync-hol-guard-runtime-version.mjs --version X.Y.Z [--root PATH]',
    '  node scripts/sync-hol-guard-runtime-version.mjs --check [--version X.Y.Z] [--root PATH]',
  ].join('\n');
}

export function parseArguments(argv) {
  const options = { root: process.cwd(), check: false, version: undefined, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') {
      options.check = true;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--version' || argument === '--root') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${argument} requires a value`);
      }
      index += 1;
      if (argument === '--version') {
        options.version = value;
      } else {
        options.root = value;
      }
    } else if (argument.startsWith('--version=')) {
      options.version = argument.slice('--version='.length);
    } else if (argument.startsWith('--root=')) {
      options.root = argument.slice('--root='.length);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const result = await syncHolGuardRuntimeVersion(options);
  if (options.check) {
    console.log(`HOL Guard runtime pins are synchronized at ${result.version}.`);
  } else if (result.changedFiles.length === 0) {
    console.log(`HOL Guard runtime pins are already at ${result.version}.`);
  } else {
    console.log(`Updated HOL Guard runtime pins from ${result.previousVersion} to ${result.version}:`);
    for (const file of result.changedFiles) {
      console.log(`- ${file}`);
    }
  }
}

const isDirectInvocation = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectInvocation) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
