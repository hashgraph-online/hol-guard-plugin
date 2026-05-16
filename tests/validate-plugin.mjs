import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifestPath = path.join(root, '.codex-plugin', 'plugin.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function exists(relativePath, mode = constants.R_OK) {
  await access(path.join(root, relativePath), mode);
}

assert(manifest.name === 'hol-guard-plugin', 'manifest name must be hol-guard-plugin');
assert(manifest.interface.displayName === 'HOL Guard Plugin', 'displayName must be HOL Guard Plugin');
assert(manifest.license === 'Apache-2.0', 'license must be Apache-2.0');
assert(manifest.repository === 'https://github.com/hashgraph-online/hol-guard-plugin', 'repository URL mismatch');
assert(manifest.skills === './skills/', 'skills path must be ./skills/');
assert(manifest.interface.defaultPrompt.length <= 3, 'default prompts must be capped at 3');

for (const prompt of manifest.interface.defaultPrompt) {
  assert(prompt.length <= 128, `default prompt too long: ${prompt}`);
}

await exists('skills/hol-guard/SKILL.md');
await exists('assets/icon.svg');
await exists('assets/logo.svg');
await exists('scripts/hol-guard-plugin');

const skill = await readFile(path.join(root, 'skills/hol-guard/SKILL.md'), 'utf8');
assert(skill.includes('Never read `.env` files.'), 'skill must include env safety rule');
assert(skill.includes('plugin-scanner verify'), 'skill must document plugin-scanner verify');
assert(skill.includes('hol-guard bootstrap'), 'skill must document hol-guard bootstrap');

const readme = await readFile(path.join(root, 'README.md'), 'utf8');
assert(readme.includes('https://github.com/hashgraph-online/ai-plugin-scanner'), 'README must link source scanner repo');
assert(readme.includes('npm test'), 'README must document validation');

console.log('HOL Guard Plugin validation passed.');
