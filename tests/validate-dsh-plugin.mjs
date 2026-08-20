import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const pluginManifest = JSON.parse(await readFile(path.join(root, 'dsh.plugin.json'), 'utf8'));
const patch = await readFile(path.join(root, 'cordis.patch.yml'), 'utf8');
const source = await readFile(path.join(root, 'index.js'), 'utf8');

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
assert(patch.includes('id: hol-guard'), 'Cordis patch must use a stable HOL Guard id');
assert(patch.includes('name: hol-guard-plugin'), 'Cordis patch must load the package name');
assert(source.includes("ctx.on('tools/pre-execute'"), 'plugin must register a DSH pre-execute gate');
assert(source.includes("'--harness',\n    'dsh'"), 'plugin must invoke the HOL Guard DSH hook');
assert(source.includes("kind: 'deny'"), 'plugin must support fail-closed denial');
console.log('DSH plugin validation passed.');
