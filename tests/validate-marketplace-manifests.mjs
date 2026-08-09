import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function load(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));
}

const copilot = await load('.github/plugin/plugin.json');
assert(copilot.$schema === 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', 'Copilot manifest must use Agent Plugins v1 schema');
assert(copilot.name === 'hol-guard', 'Copilot plugin name must be hol-guard');
assert(copilot.repository === 'https://github.com/hashgraph-online/hol-guard-plugin', 'Copilot repository mismatch');
assert(copilot.license === 'Apache-2.0', 'Copilot license mismatch');

const claude = await load('.claude-plugin/plugin.json');
assert(claude.name === 'hol-guard', 'Claude-compatible plugin name must be hol-guard');
assert(claude.repository === 'https://github.com/hashgraph-online/hol-guard-plugin', 'Claude-compatible repository mismatch');
assert(claude.homepage === 'https://hol.org/guard', 'Claude-compatible homepage mismatch');

const kimi = await load('kimi.plugin.json');
assert(kimi.name === 'hol-guard', 'Kimi plugin name must be hol-guard');
assert(kimi.skills === './skills/', 'Kimi plugin must expose the existing skills directory');
assert(kimi.interface?.displayName === 'HOL Guard', 'Kimi display name mismatch');
assert(kimi.interface?.websiteURL === 'https://hol.org/guard', 'Kimi website mismatch');

const skill = await readFile(path.join(root, 'skills/hol-guard/SKILL.md'), 'utf8');
assert(skill.includes('pipx install hol-guard'), 'Marketplace skill must preserve the documented pipx install path');
assert(skill.includes('hol-guard'), 'Marketplace skill must delegate to the HOL Guard CLI');

console.log('Cross-marketplace manifest validation passed.');
