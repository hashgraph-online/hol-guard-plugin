---
description: "Scan agent extensions and tooling before trusting them"
---

# Scan an agent extension before trust

Treat `$ARGUMENTS` as the path to the plugin, skill, MCP server, or agent-tooling source that should be inspected.

## Safety rules

- Never run the target repository's install, build, lifecycle, or setup scripts just to inspect it.
- Never read `.env` files or reveal secrets.
- Keep the initial pass read-only.
- If no target path was provided, ask for one instead of guessing.
- Do not assume the `hol-guard` runtime package provides the separate `plugin-scanner` CLI.

## Steps

1. Check whether the scanner is available:

   ```bash
   command -v plugin-scanner
   ```

   If it is missing, explain that the scanner is published as the separate open-source `plugin-scanner` distribution. Install it only after explicit user approval:

   ```bash
   pipx install plugin-scanner
   ```

2. Run the fast local scanner pass:

   ```bash
   plugin-scanner lint "$ARGUMENTS"
   ```

3. When a stronger verification pass is appropriate, run:

   ```bash
   plugin-scanner verify "$ARGUMENTS"
   ```

4. Summarize findings by severity and identify the exact file or surface responsible for each material finding.

5. Do not install or enable the scanned artifact unless the user explicitly asks to proceed after reviewing the findings.
