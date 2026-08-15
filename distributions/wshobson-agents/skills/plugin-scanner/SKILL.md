---
name: plugin-scanner
description: Scan AI agent skills, plugins, MCP servers, and agent tooling locally for prompt injection, unsafe commands, secret exposure, and supply-chain risks before installing or trusting them.
license: Apache-2.0
---

# Plugin Scanner

Use the open-source `plugin-scanner` CLI when a user asks to inspect an AI agent skill, plugin, MCP server, package, or repository before installation or use.

Scanning runs locally. Do not require an account, API key, hosted service, or remote decision endpoint, and do not send the target or findings to a hosted HOL service.

## When to use this skill

Use this skill when the user asks to:

- scan or audit a `SKILL.md` before installing it;
- inspect an MCP server or agent plugin for security risks;
- check a third-party agent repository before trusting it;
- look for prompt injection, credential exposure, unsafe commands, or suspicious package/install behavior;
- validate a skill or plugin repository in CI or before publishing it.

## Safety rules

- Never execute code from the target repository just to scan it.
- Never run the target's install scripts, package lifecycle hooks, or arbitrary shell commands.
- Never read `.env` files, credential stores, private keys, or unrelated user secrets.
- Prefer scanning a local path or a repository the user has already chosen to inspect.
- Treat scanner findings as security evidence, not a guarantee that a package is safe.
- Ask before installing `hol-guard` if `plugin-scanner` is not already available.
- Do not upload the target, package names, URLs, findings, prompts, or workspace contents to a hosted service.

## 1. Check for the scanner

```bash
command -v plugin-scanner
```

If it is not installed, explain that `plugin-scanner` ships with the open-source `hol-guard` package. Install only after the user explicitly approves setup:

```bash
pipx install hol-guard
```

If `pipx` is unavailable, recommend an isolated Python CLI installation approach rather than silently modifying the user's Python environment.

## 2. Scan the target without executing it

For a repository or directory:

```bash
plugin-scanner scan PATH --format markdown
```

For machine-readable results:

```bash
plugin-scanner scan PATH --format json
```

For Agent Skill or plugin structure validation:

```bash
plugin-scanner lint PATH
plugin-scanner verify PATH
```

Use the narrowest local target path that contains the material the user asked to inspect.

## 3. Interpret findings

Summarize:

1. the target that was scanned;
2. the highest severity finding;
3. concrete files or rules involved;
4. whether the scanner found prompt-injection, secret/exfiltration, command-execution, dependency/install, or MCP-specific risks;
5. the recommended next action.

Do not claim a target is safe solely because no finding was returned. Say that no covered issue was detected by the current scan.

## Source

The scanner is part of the open-source HOL Guard repository: https://github.com/hashgraph-online/hol-guard.
