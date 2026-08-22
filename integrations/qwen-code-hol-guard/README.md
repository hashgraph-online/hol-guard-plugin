# Qwen Code + HOL Guard

This integration adapts Qwen Code's public source-level `ToolInvocationGuard` execution boundary to local HOL Guard policy decisions.

Qwen Code evaluates `toolInvocationGuard` after it has built the final invocation and before the executor runs. The adapter therefore receives the canonical tool name, final cloned arguments, runtime-owned context, session identity, working directory, and cancellation signal rather than an earlier model draft.

```js
import { createHolGuardToolInvocationGuard } from 'qwen-code-hol-guard';

// In an embedding host that constructs Qwen Code Config:
const config = new Config({
  // ...your existing Qwen Code host configuration...
  toolInvocationGuard: createHolGuardToolInvocationGuard(),
});
```

## Current Qwen package boundary

Qwen Code's current source tree contains the `ToolInvocationGuard`/`toolInvocationGuard` contract, but the separately published npm package `@qwen-code/qwen-code-core` is still at the older `0.0.14` line while the source package version is `0.21.x`. This adapter therefore does **not** declare a peer dependency on a core version that npm cannot install. Its CI pins and verifies the actual upstream source contract instead.

Until Qwen publishes a version-aligned core package or exposes the host guard through another supported embedding package, treat this as a source/embedding-host consumer proof rather than claiming a clean npm integration with `@qwen-code/qwen-code-core`. Do not install a mismatched core release just to satisfy this adapter.

The default bridge invokes the local CLI as:

```text
hol-guard guard hook --harness generic --workspace <qwen-runtime-cwd>
```

It is deliberately fail closed. An explicit Guard allow proceeds. Deny, review/approval-required, cancellation, provider failure, malformed or ambiguous output, oversized payloads, and nonzero Guard termination without an authoritative deny all prevent the Qwen executor from running. The adapter does not require HOL Guard Cloud and does not log tool arguments.

## Security contract

- final canonical Qwen tool name and arguments are evaluated before execution;
- payloads are bounded to 24 KiB and captured Guard output to 64 KiB;
- review latency defaults to 10 seconds;
- Guard runs without a shell;
- timeout and overflow terminate the full Guard process tree on POSIX and Windows;
- Qwen's `AbortSignal` cancels Guard evaluation and fails closed;
- tests prove blocked/error paths produce zero simulated downstream executor calls.

This is an external consumer of Qwen Code's provider-neutral guard seam. It does not modify Qwen Code core and does not imply Qwen endorsement.
