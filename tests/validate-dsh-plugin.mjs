import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const pluginManifest = JSON.parse(await readFile(path.join(root, 'dsh.plugin.json'), 'utf8'));
const patch = await readFile(path.join(root, 'cordis.patch.yml'), 'utf8');
const source = await readFile(path.join(root, 'index.js'), 'utf8');
const boundary = await readFile(path.join(root, 'docs/dsh-security-boundary.md'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

await access(path.join(root, 'index.js'), constants.R_OK);
assert(manifest.type === 'module', 'DSH plugin must be ESM');
assert(manifest.main === 'index.js', 'DSH plugin main must be index.js');
assert(manifest.dsh?.bundle?.patch === './cordis.patch.yml', 'DSH bundle patch metadata is missing');
assert(manifest.keywords?.includes('dsh-plugin'), 'package keywords must include dsh-plugin');
assert(pluginManifest.version === manifest.version, 'DSH plugin version must match package version');
assert(pluginManifest.entry?.name === 'hol-guard-plugin', 'DSH entry must load hol-guard-plugin');
assert(
  Array.isArray(pluginManifest.entry?.inject) && pluginManifest.entry.inject.includes('tools'),
  'DSH entry must require the tools service',
);
assert(patch.includes('id: hol-guard'), 'Cordis patch must use a stable HOL Guard id');
assert(patch.includes('name: hol-guard-plugin'), 'Cordis patch must load the package name');
assert(source.includes("export const inject = ['tools']"), 'plugin must declare the DSH tools service dependency');
assert(source.includes("ctx.on('tools/pre-execute'"), 'plugin must register a DSH pre-execute review');
assert(source.includes('ctx.tools.guard('), 'plugin must register a monotonic DSH tool guard');
assert(source.includes("ctx.get('approval')"), 'plugin must use the native DSH approval service');
assert(source.includes("'--harness',\n    'dsh'"), 'plugin must invoke the HOL Guard DSH hook');
assert(source.includes("kind: 'deny'"), 'plugin must support fail-closed denial');
assert(source.includes('root_tool_use_id'), 'plugin must preserve root DSH call correlation');
assert(boundary.includes('monotonic final denial boundary'), 'DSH boundary docs must describe monotonic enforcement');
assert(boundary.includes('sandbox-required'), 'DSH boundary docs must state the sandbox-required limitation');
assert(boundary.includes('listener short-circuits'), 'DSH boundary docs must describe listener-bypass behavior');
console.log('DSH plugin validation passed.');
