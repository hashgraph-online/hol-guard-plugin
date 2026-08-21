---
name: hol-guard
description: Use when setting up local HOL Guard protection, reviewing local Guard approvals or receipts, or scanning agent skills, plugins, MCP servers, packages, and harness configuration before trust or execution.
license: Apache-2.0
---

# HOL Guard

Use HOL Guard as a local security boundary for AI coding agents and agent tooling. The default workflow in this skill is local-only. Do not require an account, API key, hosted service, or remote decision endpoint.

## Hard rules

- Never read `.env` files, credential stores, private keys, or unrelated secrets.
- Never bypass Guard approvals.
- Do not claim a workspace is protected until a Guard command proves status.
- Prefer Guard-owned, reversible harness changes over direct manual config edits.
- Do not mutate user-level harness configuration unless the user requested protection and the `hol-guard` command owns the change.
- Treat scanner failures as real until inspected.
- Preserve existing user changes and inspect `git status --short` before editing a repository.
- Do not send workspace contents, package names, scan findings, prompts, or URLs to a hosted HOL service.

## 1. Check local availability

Run read-only checks first:

```bash
command -v hol-guard
command -v plugin-scanner
```

If `hol-guard` is missing, install the local runtime only when the user explicitly asked for setup or approved installation:

```bash
pipx install hol-guard==2.2.119
```

If `plugin-scanner` is missing and the user asks to scan agent tooling, use the bundled `plugin-scanner` skill for its separate approved installation flow. Do not assume the `hol-guard` distribution provides the scanner CLI.

If `pipx` is unavailable, explain that isolated CLI installation is recommended rather than silently modifying the user's Python environment.

Verify the local runtime:

```bash
hol-guard status
hol-guard detect --json
```

## 2. Protect a local harness

Use this flow when the user asks to enable protection for Codex, Claude Code, Copilot CLI, Cursor, Gemini CLI, Hermes, OpenClaw, OpenCode, or Antigravity:

```bash
hol-guard bootstrap
hol-guard install <harness>
hol-guard run <harness> --dry-run
hol-guard run <harness>
hol-guard status
```

Supported harness names:

- `codex`
- `claude-code`
- `copilot`
- `cursor`
- `gemini`
- `hermes`
- `openclaw`
- `opencode`
- `antigravity`

Common aliases:

- `claude` maps to `claude-code`
- `gemini-cli` maps to `gemini`
- `open-code` maps to `opencode`
- `open-claw` maps to `openclaw`
- `copilot-cli` maps to `copilot`

For Hermes, use the harness-specific bootstrap when appropriate:

```bash
hol-guard hermes bootstrap
hol-guard status
```

### Claude Code

Use Guard-owned integration rather than hand-editing Claude hooks or settings:

```bash
hol-guard install claude-code
hol-guard run claude-code --dry-run
hol-guard run claude-code
hol-guard doctor claude-code --json
```

### Codex

Use Guard-owned integration rather than hand-editing Codex hooks or MCP configuration:

```bash
hol-guard install codex
hol-guard run codex --dry-run
hol-guard run codex
hol-guard doctor codex --json
```

## 3. Review approvals and local evidence

If Guard blocks or queues work, inspect the local reason before approving anything:

```bash
hol-guard approvals
hol-guard approvals open
hol-guard receipts
hol-guard diff <harness>
```

For terminal-only resolution:

```bash
hol-guard approvals approve <request-id>
hol-guard approvals deny <request-id>
```

Only approve after reading the risk reason and understanding the requested scope.

For local audit evidence:

```bash
hol-guard receipts
hol-guard inventory
hol-guard abom --format json
hol-guard events
hol-guard explain <artifact-id>
```

## 4. Scan a plugin, skill, MCP server, or package

Use scanner mode before trusting or installing agent tooling:

```bash
plugin-scanner scan <path> --format markdown
plugin-scanner lint <path>
plugin-scanner verify <path>
```

For machine-readable results:

```bash
plugin-scanner scan <path> --format json
```

Target guidance:

- Agent Skill: scan the folder containing `SKILL.md`.
- Codex plugin: scan the repository root or plugin folder containing `.codex-plugin/plugin.json`.
- Codex marketplace: scan the root containing `.agents/plugins/marketplace.json`.
- Claude Code project: scan the workspace containing `.claude/`, hooks, or MCP configuration.
- MCP server package: scan the package root containing server configuration and package metadata.
- Mixed agent workspace: scan the repository root so local plugin, skill, MCP, and harness surfaces can be discovered together.

Do not execute the target repository's code, install scripts, package lifecycle hooks, or arbitrary shell commands just to scan it.

## 5. Report results

When using Guard, report:

- the command that ran;
- what Guard or the scanner found;
- what remains blocked or risky;
- what local evidence exists;
- the exact next command if the user must act.

Do not claim protection, approval, release readiness, or safety without command output supporting that claim.

## Source

- Runtime and scanner source: https://github.com/hashgraph-online/hol-guard
- Runtime package: https://pypi.org/project/hol-guard/
- Scanner package: https://pypi.org/project/plugin-scanner/