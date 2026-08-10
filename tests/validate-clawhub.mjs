import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const skillPath = path.join(root, 'distributions', 'clawhub', 'hol-guard', 'SKILL.md');
const skill = await readFile(skillPath, 'utf8');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(skill.startsWith('---\nname: hol-guard\n'), 'ClawHub skill must use the hol-guard package name');
assert(skill.includes('version: 1.0.0'), 'ClawHub skill must declare a version');
assert(skill.includes('homepage: https://hol.org/guard'), 'ClawHub skill must link the HOL Guard homepage');
assert(skill.includes('user-invocable: true'), 'ClawHub skill must be user invocable');
assert(skill.includes('disable-model-invocation: true'), 'ClawHub skill must not auto-run from model invocation');
assert(skill.includes('https://github.com/hashgraph-online/hol-guard'), 'ClawHub skill must link the canonical Guard source');
assert(skill.indexOf('hol-guard status') < skill.indexOf('pipx install hol-guard'), 'read-only status must precede install guidance');
assert(skill.indexOf('explicit approval') < skill.indexOf('pipx install hol-guard'), 'installation must require explicit approval');
assert(skill.indexOf('pipx install hol-guard') < skill.indexOf('hol-guard init'), 'install must precede initialization');
assert(skill.includes('Guard Cloud is optional'), 'local protection must not require Guard Cloud');
assert(skill.includes('Do not add a second OpenClaw enforcement implementation here'), 'distribution package must not duplicate runtime enforcement');
assert(skill.includes('Never read `.env` files'), 'distribution package must retain credential safety guidance');

console.log('ClawHub HOL Guard distribution validation passed.');
