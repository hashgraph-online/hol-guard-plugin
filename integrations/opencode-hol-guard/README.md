# OpenCode HOL Guard plugin

A small, optional local policy plugin for OpenCode's existing `tool.execute.before` hook.

It does not add a new execution layer to OpenCode. The plugin receives the final tool name and structured arguments at OpenCode's documented pre-execution hook, asks the locally installed HOL Guard runtime for a bounded decision, and proceeds only on an explicit authoritative `allow`.

## Security contract

- `allow` permits the normal OpenCode tool path.
- `deny`, `review`, and `ask` block before the tool body runs.
- malformed decisions, provider/runtime failure, non-zero non-deny decisions, oversized input/output, and timeout fail closed.
- `warn` is not treated as authoritative permission.
- provider diagnostics and raw tool arguments are not copied into thrown errors.
- HOL Guard Cloud is not required.

OpenCode's current plugin API does not expose a way for `tool.execute.before` to initiate a new native confirmation request. For that reason, a HOL Guard review decision blocks the call rather than pretending approval occurred. If OpenCode later exposes a supported approval resolver at this hook boundary, the adapter can map review to that flow explicitly.

## Local installation

OpenCode automatically loads JavaScript or TypeScript files from `.opencode/plugins/` for a project and `~/.config/opencode/plugins/` globally.

Copy or symlink `src/index.js` into one of those plugin directories, keeping the exported `HolGuardPlugin` function. Ensure `hol-guard` is installed and available on `PATH`.

The default invocation is equivalent to:

```text
hol-guard guard hook --harness opencode --workspace <project-directory>
```

No hosted service or account is required.

## Tests

```bash
cd integrations/opencode-hol-guard
npm test
```

The contract suite proves that only an explicit allow reaches the simulated downstream tool and that deny, review, warn, malformed output, provider failure, oversized input, and conflicting nested decisions execute zero downstream calls.

## Upstream placement

OpenCode documents community plugins on its official Ecosystem page and invites additions through pull requests. This package is an independently maintained proof intended for that route; it does not imply OpenCode endorsement.
