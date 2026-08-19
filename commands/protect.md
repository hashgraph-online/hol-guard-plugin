---
description: "Enable local HOL Guard protection for this workspace"
---

# Protect this workspace with HOL Guard

Use HOL Guard as the local security boundary for the active coding-agent workspace.

## Safety rules

- Do not read `.env` files or print secrets while checking the workspace.
- Do not install packages or modify agent configuration unless the user asked to enable protection.
- Fail closed if HOL Guard reports a denial, review requirement, malformed response, or unavailable enforcement hook.

## Steps

1. Check whether HOL Guard is already available:

   ```bash
   hol-guard status
   ```

2. If `hol-guard` is unavailable, explain that the local prerequisite is:

   ```bash
   pipx install hol-guard
   ```

   Do not install it automatically without user intent.

3. Detect supported local agent surfaces:

   ```bash
   hol-guard detect --json
   ```

4. For each agent the user wants protected, use HOL Guard's existing installer. Examples:

   ```bash
   hol-guard install claude-code
   hol-guard install codex
   hol-guard install copilot
   hol-guard install cursor
   hol-guard install dsh
   hol-guard install gemini
   hol-guard install openclaw
   hol-guard install opencode
   hol-guard install antigravity
   ```

5. Verify the resulting local protection:

   ```bash
   hol-guard status
   hol-guard detect --json
   ```

Report which requested agent surfaces are protected and surface any review or failure state instead of silently continuing.
