import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const integrationsRoot = path.join(root, 'integrations');

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function fail(message) {
  throw new Error(`adoption integration gate: ${message}`);
}

if (await exists(integrationsRoot)) {
  const entries = await readdir(integrationsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) fail(`unexpected non-directory entry integrations/${entry.name}`);
    const routePath = path.join(integrationsRoot, entry.name, 'adoption-route.json');
    if (!(await exists(routePath))) {
      fail(`integrations/${entry.name} has no adoption-route.json with external acceptance evidence`);
    }

    const route = JSON.parse(await readFile(routePath, 'utf8'));
    const allowedKinds = new Set(['external-pr-open', 'maintainer-accepted', 'official-self-service']);
    if (!allowedKinds.has(route.route_kind)) fail(`integrations/${entry.name} has unsupported route_kind`);
    if (route.internal_pr_external_value !== 0) fail(`integrations/${entry.name} must score internal PR work as zero external value`);
    if (route.duplicates_hol_guard_core_adapter !== false) fail(`integrations/${entry.name} must prove it does not duplicate a hol-guard core adapter`);

    let externalUrl;
    try {
      externalUrl = new URL(route.external_url);
    } catch {
      fail(`integrations/${entry.name} external_url is invalid`);
    }
    if (externalUrl.protocol !== 'https:') fail(`integrations/${entry.name} external_url must use HTTPS`);
    if (externalUrl.hostname === 'github.com' && externalUrl.pathname.startsWith('/hashgraph-online/')) {
      fail(`integrations/${entry.name} external_url must be independently controlled`);
    }
    if (route.route_kind === 'external-pr-open' && !externalUrl.pathname.includes('/pull/')) {
      fail(`integrations/${entry.name} external-pr-open requires a real external PR URL`);
    }
    if (typeof route.next_external_mutation !== 'string' || route.next_external_mutation.trim().length < 10) {
      fail(`integrations/${entry.name} must name the next external mutation`);
    }
  }
}

console.log('Adoption integration gate passed.');
