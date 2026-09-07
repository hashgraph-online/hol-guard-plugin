# HOL Guard for tons-of-skills-marketplace

This directory is the review-scoped HOL Guard payload for `jeremylongshore/tons-of-skills-marketplace`. It is intentionally markdown-only so the marketplace mirrors a small, auditable install surface while the actual security runtime remains the independently published `hol-guard` CLI.

## Admitted files

The payload contains only:

- `.claude-plugin/plugin.json`
- `skills/hol-guard/SKILL.md`
- `README.md`
- `LICENSE`

It contains no hooks, MCP manifests, executable helper scripts, package lifecycle scripts, background daemons, telemetry setup, OAuth flow, or hosted-service dependency.

## Runtime boundary

HOL Guard itself is installed separately from the user's configured Python package index. The review-scoped skill pins the local runtime to:

```bash
pipx install hol-guard==3.0.46
```

Installation is offered only after the user asks to set up protection or explicitly approves installation. The skill checks Guard state with local CLI commands and keeps harness configuration changes owned by `hol-guard` rather than reimplementing security policy in marketplace content.

The default workflow is local-first. It does not require a Hashgraph Online account, API key, hosted service, or remote policy endpoint. Workspace contents, prompts, package names, URLs, Guard findings, and approval data are not sent to a hosted HOL service by this payload.

## What the skill does

The included `hol-guard` skill guides Claude Code through supported local Guard operations such as status inspection, harness detection, protection setup, dry-run validation, approval review, receipts, and post-install verification. It does not duplicate Guard enforcement logic. A user-facing security decision remains the output of the installed HOL Guard runtime.

## Source

- Runtime source: https://github.com/hashgraph-online/hol-guard
- Runtime package: https://pypi.org/project/hol-guard/
- Distribution source: https://github.com/hashgraph-online/hol-guard-plugin
