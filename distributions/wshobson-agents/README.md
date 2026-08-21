# HOL Guard for wshobson/agents

This directory is the review-scoped external plugin payload for the `wshobson/agents` marketplace. It is intentionally smaller than the repository root so the installed payload contains only the portable local-security skills and their plugin metadata.

## Maintainer disclosure

Hashgraph Online maintains this plugin payload and also maintains the open-source [`hol-guard`](https://github.com/hashgraph-online/hol-guard) source repository. That source is published as two local CLI distributions used here: `hol-guard` for runtime protection and `plugin-scanner` for static security scanning. The default workflow does not require an account, API key, hosted HOL service, metered API, or paid service.

All security decisions described by these skills run on the user's machine through the open-source `hol-guard` and `plugin-scanner` CLIs. The skills do not route package names, repository contents, URLs, prompts, scan findings, or other workspace data through a Hashgraph Online service.

## High-privilege surface disclosure

The installed `git-subdir` payload contains:

- `skills/hol-guard/SKILL.md`
- `skills/plugin-scanner/SKILL.md`
- `.claude-plugin/plugin.json`
- this README
- the Apache-2.0 license

It contains **no**:

- `hooks/` directory or automatic lifecycle hooks;
- `.mcp.json` or other MCP server auto-registration manifest;
- `scripts/` directory, executable helper, install script, `preinstall`, `postinstall`, or package lifecycle script;
- background daemon, telemetry setup, OAuth flow, hosted-service endpoint, or credential collection.

The review-scoped runtime install is pinned to:

```bash
pipx install hol-guard==2.2.119
```

The scanner is a separate `plugin-scanner` distribution, and its exact pin is owned by `skills/plugin-scanner/SKILL.md`. Each skill checks for its own local CLI before offering installation. Installation is allowed only when the user explicitly asks for setup or approves it after the relevant availability check. Both packages are installed directly from the user's configured Python package index and do not transmit workspace contents.

The external `hol-guard` runtime can modify supported harness hook/settings configuration when the user explicitly requests protection through commands such as `hol-guard install <harness>`. Those changes are performed by the local Guard CLI, not by files in this marketplace payload, and are gated on the user's request for protection.

After installation, the skills invoke local commands such as `hol-guard status`, `hol-guard install <harness>`, `hol-guard run <harness>`, and `plugin-scanner scan <path>`. Harness configuration changes are performed by the local Guard CLI only when the user requested protection. Scanner guidance explicitly forbids executing code or lifecycle scripts from the target being inspected.

## Source

- Runtime and scanner source: https://github.com/hashgraph-online/hol-guard
- Runtime package: https://pypi.org/project/hol-guard/
- Scanner package: https://pypi.org/project/plugin-scanner/
- Distribution repository: https://github.com/hashgraph-online/hol-guard-plugin
