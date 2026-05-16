# Contributing

## Validate changes

```bash
npm test
```

## Plugin rules

- Keep `.codex-plugin/plugin.json` present.
- Keep plugin name `hol-guard-plugin`.
- Keep public skill entry at `skills/hol-guard/SKILL.md`.
- Do not add instructions that read `.env` files.
- Do not instruct agents to bypass HOL Guard approval decisions.
- Keep helper scripts reversible and scoped to `hol-guard` or `plugin-scanner` commands.

## Release checklist

- Manifest validates with `npm test`.
- README command examples still match the skill.
- Source links still point to `hashgraph-online/ai-plugin-scanner`.
- No secrets or local machine paths are committed.
