# HOL Guard Plugin: Security for AI Agent Ecosystems

[![HOL Guard](https://img.shields.io/endpoint?url=https%3A%2F%2Fhol.org%2Fapi%2Fregistry%2Fbadges%2Fguard%2Fhashgraph-online%2Fhol-guard-plugin&style=flat-square)](https://hol.org/guard)
[![CI](https://img.shields.io/github/actions/workflow/status/hashgraph-online/hol-guard-plugin/ci.yml?branch=main&label=CI&logo=githubactions&logoColor=white)](https://github.com/hashgraph-online/hol-guard-plugin/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/hashgraph-online/hol-guard-plugin?style=social)](https://github.com/hashgraph-online/hol-guard-plugin/stargazers)
[![skills.sh](https://skills.sh/b/hashgraph-online/hol-guard-plugin)](https://skills.sh/hashgraph-online/hol-guard-plugin)

| ![HOL Guard Plugin logo](assets/logo.svg) | **Bring HOL Guard protection to the AI tools you already use.** This repository packages integrations for AI harnesses, skills, MCP servers, agent frameworks, and plugin marketplaces.<br><br>[Install HOL Guard](https://hol.org/guard/activate)<br>[Browse integrations](#choose-an-integration)<br>[Guard source](https://github.com/hashgraph-online/hol-guard)<br>[Report an issue](https://github.com/hashgraph-online/hol-guard-plugin/issues) |
| :--- | :--- |

HOL Guard Plugin is the ecosystem integration repository for [`hol-guard`](https://github.com/hashgraph-online/hol-guard), the local-first security layer for AI agents. It is not limited to Codex or DeepSeek Harness. It provides native harness integrations, portable security skills, MCP configuration, framework middleware, and marketplace-ready packages that connect supported AI toolchains to HOL Guard's policy, approval, and evidence boundaries.

## Choose an integration

| What you use | Start here |
| :--- | :--- |
| **AI coding harnesses** | Install HOL Guard, then use the [supported harness commands](#supported-harness-systems). |
| **DeepSeek Harness** | Add the native DSH bundle described in [Install in DeepSeek Harness](#install-in-deepseek-harness). |
| **Codex and compatible skill clients** | Install the bundled [`hol-guard`](skills/hol-guard/SKILL.md) or [`plugin-scanner`](skills/plugin-scanner/SKILL.md) skill. |
| **MCP clients and servers** | Use the local [HOL Guard MCP server](#mcp-server) or a reviewed SDK middleware under [`integrations/`](integrations/). |
| **Agent frameworks** | Choose a reviewed adapter under [`integrations/`](integrations/) for Agno, CrewAI, LangChain, Microsoft Agent Framework, Pydantic AI, Semantic Kernel, Spring AI, Strands, TanStack AI, or ToolHive. |
| **Plugin marketplaces** | Use the included Codex, Gemini, Kimi, Kiro, ClawHub, Spec Kit, and marketplace distribution manifests. |

## Install in DeepSeek Harness

Install HOL Guard first:

```bash
pipx install hol-guard
hol-guard status
```

Add the plugin to each DSH profile you use:

```bash
dsh plugin --profile headless add github:hashgraph-online/hol-guard-plugin
dsh plugin --profile web add github:hashgraph-online/hol-guard-plugin
```

Verify that the composed profile contains `hol-guard-plugin`:

```bash
dsh --profile headless --dump-config
```

You can also let HOL Guard install its managed local copy into detected DSH profiles:

```bash
hol-guard install dsh
```

### DSH enforcement contract

The plugin uses both DSH policy layers instead of relying on a reorderable listener alone:

1. `tools/pre-execute` performs the bounded asynchronous HOL Guard review.
2. Guard `ask`, `review`, and `require-reapproval` outcomes use DSH's native one-time approval service when it is mounted.
3. The resolved decision is latched onto the exact DSH execution.
4. `ctx.tools.guard()` enforces the latch as a monotonic final denial boundary before dispatch.

A missing Guard command, timeout, malformed response, rejected or unavailable approval, `sandbox-required` outcome, incomplete review, or another plugin short-circuiting the pre-execute waterfall fails closed and prevents the tool from running. An ordinary pre-execute listener cannot force-allow a HOL Guard denial.

See [DeepSeek Harness security boundary](docs/dsh-security-boundary.md) for the ordering, failure matrix, trust properties, and explicit limitations.

## Install the security skill

Install the portable `plugin-scanner` skill with the open Skills CLI:

```bash
npx skills add hashgraph-online/hol-guard-plugin --skill plugin-scanner
```

The Skills CLI supports many coding agents. The skill asks before installing the separate `plugin-scanner` package and never executes code from a repository just to scan it.

## What this plugin adds

- A native DSH bundle with asynchronous Guard review, native one-time approval, and a monotonic pre-dispatch denial guard.
- A public Codex skill at [`skills/hol-guard/SKILL.md`](skills/hol-guard/SKILL.md).
- A portable security skill at [`skills/plugin-scanner/SKILL.md`](skills/plugin-scanner/SKILL.md).
- Guard setup guidance for Codex, Claude Code, Copilot CLI, Cursor, DeepSeek Harness, Gemini, Hermes, OpenClaw, OpenCode, and Antigravity.
- Scanner guidance for Codex plugins, Claude Code project surfaces, skills, MCP servers, and marketplace packages.
- Helper script for common `hol-guard` and `plugin-scanner` workflows.
- Validation for the Codex manifest, DSH bundle, skill assets, script paths, and `.mcp.json`.

## MCP server

This plugin includes a `.mcp.json` that registers the HOL Guard local MCP server (`guard-mcp.v1`). The server runs directly via the `hol-guard` binary, with no package-manager startup or shell wrapper.

### Prerequisites

- `hol-guard` CLI installed and on PATH (minimum version: 2.0.1024)
- Python >= 3.10

### Tools

| Tool | Input | Returns |
| :--- | :--- | :--- |
| `search` | `{query: string}` | Max 20 sanitized results from local receipts and inventory |
| `fetch` | `{id: string}` | Single receipt or inventory item, max 32 KiB sanitized text |
| `get_guard_status` | `{}` | CLI availability, receipt count, inventory count |

All tools return a `guard-mcp.v1` contract envelope with `contractVersion`, `source: local`, `generatedAt`, and `freshness: real-time`.

### Local vs Cloud

- **Local** (`hol-guard mcp serve --stdio`): reads local Guard data offline. No network access required.
- **Cloud** (`/api/guard/mcp` on the portal): reads synced workspace data. Requires OAuth Bearer token with `guard:workspace.read` and `guard:receipt.read` scopes.

### Setup

```bash
pipx install hol-guard
hol-guard status
```

The `.mcp.json` is automatically discovered by MCP-compatible clients. No additional configuration is needed.

## Install HOL Guard locally

Recommended:

```bash
pipx install hol-guard
```

Fallback:

```bash
python3 -m pip install --user hol-guard
```

Verify:

```bash
hol-guard status
hol-guard detect --json
```

## Use from Codex

Install this plugin in Codex, then ask:

```text
Use HOL Guard to protect this workspace before running agent tools.
```

or:

```text
Use HOL Guard to scan this plugin before release.
```

## Local helper

```bash
bash scripts/hol-guard-plugin status
bash scripts/hol-guard-plugin harnesses
bash scripts/hol-guard-plugin protect claude-code
bash scripts/hol-guard-plugin protect codex
bash scripts/hol-guard-plugin protect dsh
bash scripts/hol-guard-plugin scan-system claude .
bash scripts/hol-guard-plugin scan-system codex .
bash scripts/hol-guard-plugin scan .
bash scripts/hol-guard-plugin evidence
```

The helper does not read `.env` files. It only calls `hol-guard` and `plugin-scanner` commands already exposed by their respective upstream distributions.

## Supported harness systems

| System | Helper command | Guard command |
| :--- | :--- | :--- |
| Codex | `bash scripts/hol-guard-plugin protect codex` | `hol-guard install codex` |
| Claude Code | `bash scripts/hol-guard-plugin protect claude-code` | `hol-guard install claude-code` |
| Copilot CLI | `bash scripts/hol-guard-plugin protect copilot` | `hol-guard install copilot` |
| Cursor | `bash scripts/hol-guard-plugin protect cursor` | `hol-guard install cursor` |
| DeepSeek Harness | `bash scripts/hol-guard-plugin protect dsh` | `hol-guard install dsh` |
| Gemini CLI | `bash scripts/hol-guard-plugin protect gemini` | `hol-guard install gemini` |
| Hermes | `bash scripts/hol-guard-plugin protect hermes` | `hol-guard hermes bootstrap` |
| OpenClaw | `bash scripts/hol-guard-plugin protect openclaw` | `hol-guard install openclaw` |
| OpenCode | `bash scripts/hol-guard-plugin protect opencode` | `hol-guard install opencode` |
| Antigravity | `bash scripts/hol-guard-plugin protect antigravity` | `hol-guard install antigravity` |

## Validation

```bash
npm test
```

The repository also runs an actual DSH headless session against a local OpenAI-compatible mock inference endpoint. The control session executes a bash tool call, while the protected session proves HOL Guard's native DSH gate blocks the same call:

```bash
npm run test:dsh-e2e
```

No provider key is required for the end-to-end test.

## Source projects

- Plugin repository: https://github.com/hashgraph-online/hol-guard-plugin
- Guard and scanner source: https://github.com/hashgraph-online/hol-guard
- DeepSeek Harness source: https://github.com/deepseek-ai/deepseek-harness
- HOL Guard product: https://hol.org/guard
- Plugin security dataset: https://huggingface.co/datasets/HashgraphOnline/hol-plugin-security

Snapshot of catalog scores (~205 scored plugins), modeled Guard runtime fixtures, and public advisories. Scan ≠ safety guarantee. Catalog plugin count is not the Registry Broker agent catalog. HOL publishes it; not independent validation. Do not attribute Hashgraph Online's org-wide GitHub stars to this plugin repository.
