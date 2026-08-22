# Moltis + HOL Guard

A thin external consumer of Moltis's native `BeforeToolCall` hook boundary.

Moltis documents `BeforeToolCall` as a modifying, blockable event intended for policy enforcement. This adapter translates the final Moltis tool name, structured arguments, session key, and channel provenance into HOL Guard's generic local hook envelope. An explicit Guard allow returns Moltis exit code 0. Deny, review, Guard unavailability, malformed/ambiguous output, input/output overflow, or inner Guard timeout return exit code 1, which Moltis maps to `HookAction::Block` before tool execution.

## Install

Copy this directory to:

```text
<workspace>/.moltis/hooks/hol-guard/
```

Then verify discovery with:

```bash
moltis hooks info hol-guard
```

`hol-guard` must be installed on the local machine. It is intentionally not a `[requires].bins` entry because Moltis skips ineligible hooks; the handler itself must observe a missing Guard binary and block.

## Workspace identity

For the recommended project-local installation, the handler derives the workspace from `<workspace>/.moltis/hooks/hol-guard`. If the hook is installed elsewhere, set `HOL_GUARD_WORKSPACE` to the workspace Guard should evaluate.

## Security contract

- bounded 24 KiB Moltis input and 64 KiB Guard output;
- 8 second inner Guard deadline under the 12 second Moltis hook deadline;
- no shell when launching Guard;
- timeout/output overflow terminate the Guard process tree;
- tool arguments are not copied into diagnostics;
- allow reaches downstream execution once;
- deny, review, provider failure, malformed output, and timeout reach downstream execution zero times in the adapter contract tests;
- local-only by default, with no HOL Guard Cloud login requirement.

## Framework-level limitation

Moltis's current `ShellHookHandler` turns its own timeout/spawn/nonstandard-exit failures into handler errors, and `HookRegistry::dispatch_sequential` logs handler errors then continues. Repeated failures can also circuit-break a hook and skip it. A child process cannot convert failures that occur outside itself into exit code 1.

That generic framework gap is tracked at https://github.com/moltis-org/moltis/issues/1230. This adapter does not claim complete fail-closed enforcement until Moltis exposes an opt-in required/fail-closed hook failure policy.

This repository is an external integration and does not imply Moltis endorsement.