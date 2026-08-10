---
name: hol-guard
description: Install, initialize, repair, or check local HOL Guard security protection for OpenClaw.
version: 1.0.0
homepage: https://hol.org/guard
user-invocable: true
disable-model-invocation: true
---

# HOL Guard for OpenClaw

Use this skill only when the user explicitly asks to install, enable, initialize, repair, or check HOL Guard.

HOL Guard is a separate open-source local runtime package. This ClawHub skill is a discovery and setup surface. The `hol-guard` CLI remains the security authority and owns OpenClaw integration, policy, approvals, and evidence.

Canonical source: https://github.com/hashgraph-online/hol-guard

## Check current state

Start with read-only checks:

```bash
command -v hol-guard
```

If Guard is installed, run:

```bash
hol-guard --version
hol-guard status
```

Report only what the CLI proves. Installing this skill alone does not mean runtime protection is active.

If the user asked only to check Guard, stop after `hol-guard status`. Do not install or initialize Guard.

## Install or initialize

Continue with setup only when the user explicitly asked to install, enable, initialize, or repair Guard.

If `hol-guard` is missing, explain that the next command changes the user's Python/pipx environment and obtain explicit approval before running it:

```bash
pipx install hol-guard
```

If `pipx` is unavailable, stop and tell the user that the documented HOL Guard install path requires pipx. Do not silently switch package managers and do not execute a remote bootstrap script as a fallback.

After Guard is available, initialize protection interactively:

```bash
hol-guard init
```

Do not add unattended flags unless the user explicitly requests unattended setup. `hol-guard init` owns the real OpenClaw integration and avoids maintaining a second enforcement implementation in this skill.

Verify the resulting state:

```bash
hol-guard status
```

If protection is degraded, report the failed layer and let the Guard CLI or core documentation drive repair. Do not manually rewrite OpenClaw configuration from this skill unless the core HOL Guard documentation explicitly requires it.

## Local-first boundary

Guard Cloud is optional. Do not require sign-in, credentials, or cloud connectivity for local OpenClaw protection. Offer cloud connection only if the user asks for synchronized history, shared policy, fleet visibility, or team approvals.

## Safety rules

- Never read `.env` files or unrelated credential stores.
- Never bypass Guard approvals.
- Never claim protection is active without `hol-guard status` proving it.
- Do not execute code from unrelated repositories as part of setup.
- Keep this package as a setup and discovery companion. Do not add a second OpenClaw enforcement implementation here.
