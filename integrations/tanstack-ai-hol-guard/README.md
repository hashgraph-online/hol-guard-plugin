# tanstack-ai-hol-guard

Local HOL Guard middleware for TanStack AI tool calls.

The package uses TanStack AI's `onBeforeToolCall` middleware hook to evaluate a tool call before the server tool executes. HOL Guard remains optional and local-only: the middleware invokes the local `hol-guard` CLI and does not require Guard Cloud.

## Install

```bash
npm install tanstack-ai-hol-guard @tanstack/ai
pip install hol-guard
```

## Use

```js
import { chat } from '@tanstack/ai';
import { createHolGuardMiddleware } from 'tanstack-ai-hol-guard';

const stream = chat({
  adapter,
  messages,
  tools,
  middleware: [
    createHolGuardMiddleware({
      workspace: process.cwd(),
      approve: async ({ reason, toolCall }) => {
        return requestApproval({ reason, toolCall });
      },
    }),
  ],
});
```

HOL Guard decisions map to TanStack AI behavior as follows:

- allow / warn: proceed with the original tool call
- block / deny / sandbox-required: return TanStack's native `abort` result before tool execution
- review / require-reapproval: call the optional `approve` resolver; execution proceeds only when it returns `true`
- malformed output, an unavailable Guard process, unsafe serialization, timeout, or ambiguous non-zero result: fail closed before tool execution

The middleware sends only the bounded tool name, structured arguments, workspace, and TanStack runtime/session context to the local Guard process. It does not log raw tool arguments.

## Options

`createHolGuardMiddleware()` accepts:

- `workspace`: workspace path, or a function returning one for the current call
- `approve`: async approval resolver for HOL Guard review decisions
- `command`: HOL Guard executable name or absolute path; defaults to `hol-guard`
- `guardHome`: optional Guard home passed to the local CLI
- `timeoutMs`: Guard evaluation timeout, bounded to 250 ms through 30 seconds
- `runner`: optional test/custom decision runner implementing the same local input/output contract

## Security contract

The adapter is deliberately fail closed. A denied call never reaches the TanStack server tool. The contract tests run against the real `@tanstack/ai` chat/tool lifecycle and verify zero downstream execution for deny, malformed, unavailable, and unapproved review paths, plus exactly one execution after explicit approval.
