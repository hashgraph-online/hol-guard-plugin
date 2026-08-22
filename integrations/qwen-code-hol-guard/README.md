# Qwen Code + HOL Guard

This integration adapts Qwen Code's public `ToolInvocationGuard` execution boundary to local HOL Guard policy decisions.

Qwen Code evaluates `toolInvocationGuard` after it has built the final invocation and before the executor runs. The adapter therefore receives the canonical tool name, final cloned arguments, runtime-owned context, session identity, working directory, and cancellation signal rather than an earlier model draft.

```js
import { Config } from '@qwen-code/qwen-code-core';
import { createHolGuardToolInvocationGuard } from 'qwen-code-hol-guard';

const config = new Config({
  // ...your existing Qwen Code host configuration...
  toolInvocationGuard: createHolGuardToolInvocationGuard(),
});
```

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
