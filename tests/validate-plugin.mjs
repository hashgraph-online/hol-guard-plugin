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
await exists('assets/icon.png');
await exists('assets/logo.svg');
await exists('scripts/hol-guard-plugin');

const skill = await readFile(path.join(root, 'skills/hol-guard/SKILL.md'), 'utf8');
assert(skill.includes('Never read `.env` files.'), 'skill must include env safety rule');
assert(skill.includes('plugin-scanner verify'), 'skill must document plugin-scanner verify');
assert(skill.includes('hol-guard bootstrap'), 'skill must document hol-guard bootstrap');
assert(skill.includes('hol-guard install claude-code'), 'skill must document Claude Code protection');
assert(skill.includes('Claude Code is a first-class Guard target.'), 'skill must call out Claude as first-class');
assert(skill.includes('OpenClaw'), 'skill must document OpenClaw support');
assert(skill.includes('OpenCode'), 'skill must document OpenCode support');

const readme = await readFile(path.join(root, 'README.md'), 'utf8');
const readmeLines = readme.split('\n');
assert(
  readmeLines.some((line) => line === '- Guard and scanner source: https://github.com/hashgraph-online/hol-guard'),
  'README must link source Guard repo',
);
assert(readme.includes('npm test'), 'README must document validation');
assert(readme.includes('bash scripts/hol-guard-plugin protect claude-code'), 'README must show Claude helper command');

const helper = await readFile(path.join(root, 'scripts/hol-guard-plugin'), 'utf8');
assert(helper.includes('normalize_harness'), 'helper must normalize harness aliases');
assert(helper.includes('claude|claude_code|claude-code'), 'helper must accept Claude aliases');
assert(helper.includes('normalize_scan_system'), 'helper must normalize scanner system aliases');
assert(helper.includes('claude|claude-code|claude_code'), 'helper must accept Claude scanner aliases');
assert(helper.includes('scan-system'), 'helper must support system-specific scan guidance');
// Validate .mcp.json
await exists('.mcp.json');
const mcpConfig = JSON.parse(await readFile(path.join(root, '.mcp.json'), 'utf8'));
assert(mcpConfig.mcpServers, '.mcp.json must have mcpServers');
assert(mcpConfig.mcpServers['hol-guard'], '.mcp.json must have hol-guard server');
const guardServer = mcpConfig.mcpServers['hol-guard'];
assert(guardServer.command === 'hol-guard', '.mcp.json command must be hol-guard (direct binary)');
assert(
  Array.isArray(guardServer.args) && guardServer.args.length === 4 && guardServer.args[0] === 'guard' && guardServer.args[1] === 'mcp' && guardServer.args[2] === 'serve' && guardServer.args[3] === '--stdio',
  '.mcp.json args must be ["guard", "mcp", "serve", "--stdio"]',
);
// Reject forbidden patterns
const mcpJsonStr = JSON.stringify(mcpConfig);
assert(!mcpJsonStr.includes('npx'), '.mcp.json must not use npx');
assert(!mcpJsonStr.includes('npm exec'), '.mcp.json must not use npm exec');
assert(!mcpJsonStr.includes('pnpm dlx'), '.mcp.json must not use pnpm dlx');
assert(!mcpJsonStr.includes('yarn dlx'), '.mcp.json must not use yarn dlx');
assert(!mcpJsonStr.includes('bunx'), '.mcp.json must not use bunx');
assert(!mcpJsonStr.includes('bash -c'), '.mcp.json must not use shell wrappers');
assert(!mcpJsonStr.includes('sh -c'), '.mcp.json must not use shell wrappers');
assert(!mcpJsonStr.includes('http://'), '.mcp.json must not contain URLs');
assert(!mcpJsonStr.includes('https://'), '.mcp.json must not contain URLs');
assert(!mcpJsonStr.includes('token'), '.mcp.json must not contain inline credentials');
assert(!mcpJsonStr.includes('secret'), '.mcp.json must not contain inline credentials');
assert(!mcpJsonStr.includes('password'), '.mcp.json must not contain inline credentials');
assert(!mcpJsonStr.includes('api_key'), '.mcp.json must not contain inline credentials');
assert(!mcpJsonStr.includes('/Users/'), '.mcp.json must not contain absolute paths');
assert(!mcpJsonStr.includes('/home/'), '.mcp.json must not contain absolute paths');

console.log('HOL Guard Plugin validation passed.');
