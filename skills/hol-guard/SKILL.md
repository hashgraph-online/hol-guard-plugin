---
name: hol-guard
description: Use when setting up HOL Guard, protecting local AI harnesses, reviewing Guard approvals or receipts, scanning Codex plugins, skills, MCP servers, marketplace packages, or running ai-plugin-scanner verification before release.
license: Apache-2.0
---

# HOL Guard

HOL Guard protects local AI harnesses before tools run. Use this skill when the user wants AI antivirus behavior, local approval review, plugin scanning, MCP safety checks, skill/package verification, or release gates from `ai-plugin-scanner`.

## Hard Rules

- Never read `.env` files.
- Never bypass Guard approvals.
- Do not mark a workspace protected until a Guard command proves status.
- Prefer reversible Guard commands over direct harness config edits.
- Do not mutate user-level harness config unless the `hol-guard` command owns that mutation.
- Treat scanner failures as real until inspected.
- Preserve existing user changes and inspect `git status --short` before edits in a repo.

## Install Check

First check whether the CLI exists:

```bash
command -v hol-guard
command -v plugin-scanner
```

If missing and the user asked for setup, prefer:

```bash
pipx install hol-guard
```

Fallback only when `pipx` is unavailable:

```bash
python3 -m pip install --user hol-guard
```

After install:

```bash
hol-guard status
hol-guard detect --json
```

## Protect A Local Harness

Use this flow for Codex, Claude Code, Copilot CLI, Cursor, Gemini, Hermes, OpenClaw, OpenCode, or Antigravity.

```bash
hol-guard bootstrap
hol-guard install <harness>
hol-guard run <harness> --dry-run
hol-guard run <harness>
hol-guard status
```

Harness names:

- `codex`
- `claude-code`
- `copilot`
- `cursor`
- `gemini`
- `hermes`
- `openclaw`
- `opencode`
- `antigravity`

Use harness-specific bootstrap when available:

```bash
hol-guard hermes bootstrap
```

## Approval Work

If Guard blocks or queues work:

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

## Evidence Work

Use evidence commands when user needs proof, audit trail, or handoff artifacts:

```bash
hol-guard receipts
hol-guard inventory
hol-guard abom --format json
hol-guard events
hol-guard explain <artifact-id>
```

For cloud sync, keep it optional and user-directed:

```bash
hol-guard connect
hol-guard connect status
hol-guard connect repair
hol-guard sync
```

## Scan A Plugin Or Skill Package

Use scanner mode for Codex plugins, `.agents` marketplaces, skills, MCP server configs, and release gates.

```bash
plugin-scanner lint .
plugin-scanner verify .
```

If scanning a specific package:

```bash
plugin-scanner lint <path>
plugin-scanner verify <path>
```

If the target is a Codex marketplace root with `.agents/plugins/marketplace.json`, scan the repo root so local plugin entries can be discovered.

## Common Debug Commands

```bash
hol-guard doctor
hol-guard doctor <harness> --json
hol-guard detect --json
hol-guard settings show
hol-guard explain install-connect
plugin-scanner verify . --json
```

## Response Pattern

When using Guard, report:

- What command ran.
- What Guard found.
- What remains blocked or risky.
- What proof exists.
- Exact next command if user must act.

Do not claim protection, approval, or release readiness without command output proving it.

## Local Helper

This plugin includes:

```bash
bash scripts/hol-guard-plugin status
bash scripts/hol-guard-plugin protect <harness>
bash scripts/hol-guard-plugin scan <path>
bash scripts/hol-guard-plugin evidence
```

Use the helper only when running from this plugin repository. Otherwise call `hol-guard` and `plugin-scanner` directly.
