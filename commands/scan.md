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

## Steps

1. Run the fast local scanner pass:

   ```bash
   plugin-scanner lint "$ARGUMENTS"
   ```

2. When a stronger verification pass is appropriate, run:

   ```bash
   plugin-scanner verify "$ARGUMENTS"
   ```

3. Summarize findings by severity and identify the exact file or surface responsible for each material finding.

4. Do not install or enable the scanned artifact unless the user explicitly asks to proceed after reviewing the findings.
