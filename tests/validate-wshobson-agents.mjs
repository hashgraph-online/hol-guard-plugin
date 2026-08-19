import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const payloadRoot = path.join(root, 'distributions', 'wshobson-agents');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function walk(directory, relative = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const nextRelative = path.join(relative, entry.name);
    const nextAbsolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(nextAbsolute, nextRelative)));
    } else {
      files.push(nextRelative);
    }
  }
  return files;
}

const readmePath = path.join(payloadRoot, 'README.md');
const manifestPath = path.join(payloadRoot, '.claude-plugin', 'plugin.json');
const holGuardSkillPath = path.join(payloadRoot, 'skills', 'hol-guard', 'SKILL.md');
const scannerSkillPath = path.join(payloadRoot, 'skills', 'plugin-scanner', 'SKILL.md');

const payloadReadme = await readFile(readmePath, 'utf8');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const holGuardSkill = await readFile(holGuardSkillPath, 'utf8');
const scannerSkill = await readFile(scannerSkillPath, 'utf8');
const files = await walk(payloadRoot);

assert(manifest.name === 'hol-guard', 'wshobson payload plugin name must be hol-guard');
assert(manifest.license === 'Apache-2.0', 'wshobson payload must declare Apache-2.0');
assert(manifest.homepage === 'https://github.com/hashgraph-online/hol-guard', 'homepage must point to the open-source runtime');

for (const [name, skill] of [
  ['hol-guard', holGuardSkill],
  ['plugin-scanner', scannerSkill],
]) {
  assert(Buffer.byteLength(skill, 'utf8') < 8192, `${name} SKILL.md must remain below the Codex 8 KiB limit`);
  assert(skill.startsWith(`---\nname: ${name}\n`), `${name} skill must have canonical frontmatter`);
  assert(skill.includes('license: Apache-2.0'), `${name} skill must declare Apache-2.0`);
  assert(skill.includes('pipx install hol-guard'), `${name} skill must use the isolated pipx install path`);
  assert(skill.toLowerCase().includes('local'), `${name} skill must explicitly describe local execution`);
}

const runtimePinSurfaces = [
  ['README.md', payloadReadme],
  ['skills/hol-guard/SKILL.md', holGuardSkill],
  ['skills/plugin-scanner/SKILL.md', scannerSkill],
];
const runtimeVersions = [];
for (const [name, text] of runtimePinSurfaces) {
  const installCommands = text.match(/\bpipx install hol-guard[^\s`]*/g) ?? [];
  assert(installCommands.length === 1, `${name} must contain exactly one HOL Guard install command`);
  const exactPin = /^pipx install hol-guard==(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(installCommands[0]);
  assert(exactPin, `${name} must pin HOL Guard to one exact stable X.Y.Z release`);
  runtimeVersions.push(exactPin.slice(1).join('.'));
}
assert(new Set(runtimeVersions).size === 1, `HOL Guard runtime pins must match across review assets: ${runtimeVersions.join(', ')}`);

const forbiddenPaths = [
  '.mcp.json',
  'mcp.json',
  'hooks',
  'hooks.json',
  'scripts',
];
for (const file of files) {
  const segments = file.split(path.sep);
  for (const forbidden of forbiddenPaths) {
    assert(!segments.includes(forbidden), `review-scoped payload must not contain privileged surface: ${file}`);
  }
}

const textFiles = files.filter((file) => /\.(?:md|json|txt)$/i.test(file) || path.basename(file) === 'LICENSE');
const forbiddenText = [
  'https://hol.org',
  '/api/guard',
  'hol-guard connect',
  'hol-guard sync',
  'oauth bearer',
];
for (const file of textFiles) {
  const text = (await readFile(path.join(payloadRoot, file), 'utf8')).toLowerCase();
  for (const forbidden of forbiddenText) {
    assert(!text.includes(forbidden), `${file} must not promote or depend on hosted HOL services: ${forbidden}`);
  }
}

assert(
  scannerSkill.indexOf('command -v plugin-scanner') < scannerSkill.indexOf('pipx install hol-guard'),
  'scanner must check local availability before offering installation',
);
assert(
  holGuardSkill.indexOf('command -v hol-guard') < holGuardSkill.indexOf('pipx install hol-guard'),
  'Guard skill must check local availability before offering installation',
);
assert(
  scannerSkill.includes('Never execute code from the target repository just to scan it.'),
  'scanner must retain the no-execution safety rule',
);

console.log(`wshobson/agents HOL Guard payload validation passed with runtime ${runtimeVersions[0]}.`);
