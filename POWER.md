---
name: "hol-guard"
displayName: "HOL Guard AI Agent Security"
description: "Inspect and protect AI agent workflows with local Guard status, security receipts, inventory, policy validation, and plugin, skill, MCP, and package scanning"
keywords: ["hol guard", "ai security", "agent security", "mcp security", "plugin scanner", "prompt injection", "supply chain", "approvals"]
author: "Hashgraph Online"
---

# HOL Guard

HOL Guard is a local-first security layer for AI coding agents and agent extension ecosystems. Use this power when a developer needs to inspect Guard state, review security evidence, validate policy changes, scan an MCP server or Agent Skill before trusting it, or add a repeatable security gate to an agent workflow.

The bundled `mcp.json` starts HOL Guard's local stdio MCP server. The MCP surface exposes sanitized Guard status, receipts, and inventory, plus policy validation and approval-backed policy authoring where those features are enabled locally. It does not upload workspace file contents. Guard Local runs on the developer's machine; cloud sync remains optional.

## Onboarding

First verify that the HOL Guard CLI is installed:

```bash
command -v hol-guard
hol-guard --version
```

If the CLI is missing and the user wants to install it, prefer `pipx`:

```bash
pipx install hol-guard
```

Then initialize or inspect local Guard state:

```bash
hol-guard status
hol-guard detect --json
```

Kiro can load the bundled `mcp.json` and start the local server with:

```bash
hol-guard guard mcp serve --stdio
```

## MCP tools

Use the MCP tools according to least privilege:

- `get_guard_status`: inspect whether Guard data is available and current.
- `search`: search sanitized local Guard receipts and inventory.
- `fetch`: fetch one sanitized receipt or inventory item by its opaque ID.
- `validate_policy`: validate candidate policy YAML before any write.
- `create_policy`: request an approval-backed policy write when local policy authoring and MCP writes are enabled.
- `get_policy_creation`: inspect a pending or completed policy request.

Do not bypass Guard approvals or treat a pending policy request as applied.

## Scan agent extensions before trust

For a public or local Agent Skill, plugin, MCP package, or mixed agent workspace, first check for the separately published scanner CLI:

```bash
command -v plugin-scanner
```

If it is missing and the user approves installation:

```bash
pipx install plugin-scanner
```

Then scan without executing the target package:

```bash
plugin-scanner lint <path>
plugin-scanner verify <path>
```

Do not assume the `hol-guard` runtime distribution provides the `plugin-scanner` command. Treat scanner failures as real until the finding is reviewed.

## Local evidence workflow

Use Guard's evidence commands when the user needs an audit trail or a concise explanation of what changed:

```bash
hol-guard receipts
hol-guard inventory
hol-guard events
hol-guard explain <artifact-id>
```

Guard should remain the owner of Guard-managed configuration. Prefer its CLI over manual edits to Guard state or supported harness configuration.

## Kiro scope

This power gives Kiro access to HOL Guard's security knowledge and local MCP evidence surface. It does not claim that Kiro's own built-in tool execution is natively intercepted by HOL Guard unless a supported Guard integration explicitly proves that protection on the user's machine. Report the observed Guard status rather than assuming protection.

## License and support

HOL Guard Power: Apache-2.0.

The bundled HOL Guard MCP server is part of the Apache-2.0 licensed HOL Guard project.

- Privacy Policy: https://hol.org/points/legal/privacy
- Product and documentation: https://hol.org/guard
- Support and issue tracking: https://github.com/hashgraph-online/hol-guard/issues