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
await exists('index.js');
await exists('cordis.patch.yml');
await exists('dsh.plugin.json');

const skill = await readFile(path.join(root, 'skills/hol-guard/SKILL.md'), 'utf8');
assert(skill.includes('Never read `.env` files.'), 'skill must include env safety rule');
assert(skill.includes('plugin-scanner verify'), 'skill must document plugin-scanner verify');
assert(skill.includes('pipx install plugin-scanner'), 'skill must document the separately published scanner distribution');
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
assert(
  readmeLines.some((line) => line === '- Plugin security dataset: https://huggingface.co/datasets/HashgraphOnline/hol-plugin-security'),
  'README must cite the HOL plugin security dataset',
);
assert(readme.includes('separate `plugin-scanner` package'), 'README must distinguish the scanner distribution');
assert(readme.includes('their respective upstream distributions'), 'README helper disclosure must describe both CLI distributions');
assert(readme.includes('npm test'), 'README must document validation');
assert(readme.includes('npm run test:dsh-e2e'), 'README must document the DSH end-to-end test');
assert(readme.includes('bash scripts/hol-guard-plugin protect claude-code'), 'README must show Claude helper command');
assert(readme.includes('bash scripts/hol-guard-plugin protect dsh'), 'README must show DSH helper command');
assert(readme.includes('dsh plugin --profile headless add'), 'README must document native DSH installation');

const helper = await readFile(path.join(root, 'scripts/hol-guard-plugin'), 'utf8');
assert(helper.includes('normalize_harness'), 'helper must normalize harness aliases');
assert(helper.includes('claude|claude_code|claude-code'), 'helper must accept Claude aliases');
assert(helper.includes('dsh|deepseek-harness|deepseek_harness'), 'helper must accept DSH aliases');
assert(helper.includes('normalize_scan_system'), 'helper must normalize scanner system aliases');
assert(helper.includes('claude|claude-code|claude_code'), 'helper must accept Claude scanner aliases');
assert(helper.includes('scan-system'), 'helper must support system-specific scan guidance');
assert(helper.includes('install_command_for'), 'helper must map missing CLIs to their owning distribution');
assert(helper.includes('plugin-scanner) echo "pipx install plugin-scanner"'), 'helper must recommend the scanner distribution when scanner is missing');

const power = await readFile(path.join(root, 'POWER.md'), 'utf8');
assert(power.includes('pipx install plugin-scanner'), 'Kiro power must document scanner installation');
assert(power.includes('separately published scanner CLI'), 'Kiro power must distinguish scanner packaging');
assert(power.includes('Do not assume the `hol-guard` runtime distribution provides the `plugin-scanner` command.'), 'Kiro power must prevent package alias assumptions');

// Validate .mcp.json. Load forbidden patterns from data to avoid scanner false positives.
await exists('.mcp.json');
const mcpConfig = JSON.parse(await readFile(path.join(root, '.mcp.json'), 'utf8'));
assert(mcpConfig.mcpServers, '.mcp.json must have mcpServers');
assert(mcpConfig.mcpServers['hol-guard'], '.mcp.json must have hol-guard server');
const guardServer = mcpConfig.mcpServers['hol-guard'];
assert(guardServer.command === 'hol-guard', '.mcp.json command must be hol-guard (direct binary)');
assert(
  Array.isArray(guardServer.args) && guardServer.args.length === 3 && guardServer.args[0] === 'mcp' && guardServer.args[1] === 'serve' && guardServer.args[2] === '--stdio',
  '.mcp.json args must be ["mcp", "serve", "--stdio"]',
);
const mcpJsonStr = JSON.stringify(mcpConfig);
const forbiddenPatterns = JSON.parse(await readFile(path.join(root, 'tests/forbidden-patterns.json'), 'utf8'));
for (const pattern of forbiddenPatterns) {
  assert(!mcpJsonStr.includes(pattern), `.mcp.json must not contain forbidden pattern: ${pattern}`);
}
console.log('HOL Guard Plugin validation passed.');
