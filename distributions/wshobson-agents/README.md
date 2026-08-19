# HOL Guard for wshobson/agents

This directory is the review-scoped external plugin payload for the `wshobson/agents` marketplace. It is intentionally smaller than the repository root so the installed payload contains only the portable local-security skills and their plugin metadata.

## Maintainer disclosure

Hashgraph Online maintains this plugin payload and also maintains the open-source [`hol-guard`](https://github.com/hashgraph-online/hol-guard) runtime that the skills invoke. The default workflow does not require an account, API key, hosted HOL service, metered API, or paid service.

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

The Markdown skills reference local shell commands. The only package installation command is `pipx install hol-guard==2.2.115`, and the skills allow it only when the user explicitly asks to set up HOL Guard or approves installation after the CLI availability check. That command installs the reviewed open-source runtime version directly from the user's configured Python package index. It does not transmit workspace contents.

The external `hol-guard` runtime can modify supported harness hook/settings configuration when the user explicitly requests protection through commands such as `hol-guard install <harness>`. Those changes are performed by the local Guard CLI, not by files in this marketplace payload, and are gated on the user's request for protection.

After installation, the skills invoke local commands such as `hol-guard status`, `hol-guard install <harness>`, `hol-guard run <harness>`, and `plugin-scanner scan <path>`. Harness configuration changes are performed by the local Guard CLI only when the user requested protection. Scanner guidance explicitly forbids executing code or lifecycle scripts from the target being inspected.

## Source

- Runtime and scanner: https://github.com/hashgraph-online/hol-guard
- Distribution repository: https://github.com/hashgraph-online/hol-guard-plugin
