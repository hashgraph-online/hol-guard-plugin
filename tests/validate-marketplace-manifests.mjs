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

const guardSkill = await readFile(path.join(root, 'skills/hol-guard/SKILL.md'), 'utf8');
assert(guardSkill.includes('pipx install hol-guard'), 'Marketplace skill must preserve the documented pipx install path');
assert(guardSkill.includes('hol-guard'), 'Marketplace skill must delegate to the HOL Guard CLI');

const scannerSkill = await readFile(path.join(root, 'skills/plugin-scanner/SKILL.md'), 'utf8');
assert(scannerSkill.includes('name: plugin-scanner'), 'Scanner skill must have portable Agent Skills frontmatter');
assert(scannerSkill.includes('pipx install hol-guard'), 'Scanner skill must install the canonical hol-guard package');
assert(scannerSkill.includes('plugin-scanner scan'), 'Scanner skill must document repository scanning');
assert(scannerSkill.includes('plugin-scanner lint'), 'Scanner skill must document skill/plugin linting');
assert(scannerSkill.includes('Never execute code from the target repository'), 'Scanner skill must prohibit executing scanned code');

console.log('Cross-marketplace manifest validation passed.');
