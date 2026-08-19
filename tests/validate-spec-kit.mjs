import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function exists(relativePath) {
  await access(path.join(root, relativePath));
}

const [manifest, packageSource] = await Promise.all([
  readFile(path.join(root, 'extension.yml'), 'utf8'),
  readFile(path.join(root, 'package.json'), 'utf8'),
]);
const packageJson = JSON.parse(packageSource);

assert(manifest.includes('schema_version: "1.0"'), 'Spec Kit schema version must be 1.0');
assert(manifest.includes('id: "hol-guard"'), 'Spec Kit extension id must be hol-guard');

const versionMatch = manifest.match(/^\s{2}version:\s*"([^"]+)"\s*$/m);
assert(versionMatch, 'Spec Kit extension version must be declared');
const extensionVersion = versionMatch[1];
assert(
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(extensionVersion),
  `Spec Kit extension version must be semver, got ${extensionVersion}`,
);
assert(
  extensionVersion === packageJson.version,
  `Spec Kit extension version (${extensionVersion}) must match package.json version (${packageJson.version})`,
);

assert(manifest.includes('repository: "https://github.com/hashgraph-online/hol-guard-plugin"'), 'Spec Kit repository mismatch');
assert(manifest.includes('license: "Apache-2.0"'), 'Spec Kit license must be Apache-2.0');
assert(manifest.includes('speckit_version: ">=0.1.0"'), 'Spec Kit minimum version must be declared');
assert(manifest.includes('name: "speckit.hol-guard.protect"'), 'protect command must be registered');
assert(manifest.includes('name: "speckit.hol-guard.scan"'), 'scan command must be registered');

await exists('commands/protect.md');
await exists('commands/scan.md');
await exists('README.md');
await exists('LICENSE');

const protect = await readFile(path.join(root, 'commands/protect.md'), 'utf8');
assert(protect.includes('hol-guard status'), 'protect command must verify HOL Guard status');
assert(protect.includes('hol-guard detect --json'), 'protect command must detect agent surfaces');
assert(protect.includes('Do not read `.env` files'), 'protect command must preserve env safety');

const scan = await readFile(path.join(root, 'commands/scan.md'), 'utf8');
assert(scan.includes('plugin-scanner lint'), 'scan command must include the read-only scanner path');
assert(scan.includes('plugin-scanner verify'), 'scan command must include the stronger verification path');
assert(scan.includes('Never run the target repository'), 'scan command must forbid executing untrusted target setup');

console.log(`Spec Kit extension validation passed for version ${extensionVersion}.`);
