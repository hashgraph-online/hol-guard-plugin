# DeepSeek Harness security boundary

HOL Guard integrates with the DeepSeek Harness (DSH) tool runtime at two separate policy layers. The split is intentional: DSH's asynchronous `tools/pre-execute` waterfall can be reordered or short-circuited by another plugin, while `ctx.tools.guard()` is a monotonic final denial boundary that runs after the waterfall and before dispatch.

## Enforcement order

For every DSH tool execution:

1. HOL Guard installs a fail-closed decision latch for the exact DSH execution object.
2. The `tools/pre-execute` listener serializes the immutable tool name, arguments, call ID, root call ID, and workspace into a bounded `PreToolUse` payload.
3. The payload is reviewed by `hol-guard guard hook --harness dsh` under a process-tree deadline.
4. An authoritative `allow` is latched as allow.
5. An authoritative `ask` or review decision is routed through DSH's native one-time approval service.
6. Rejection, cancellation, a missing approval service, a headless call without an agent, an unknown approval outcome, or an approval transport failure is latched as deny.
7. The monotonic `ctx.tools.guard()` callback permits only a latched allow. A missing latch or any denial returns a final reason and prevents dispatch.

This means a different pre-execute plugin cannot force-allow a HOL Guard denial. If another listener short-circuits the waterfall before HOL Guard runs, the monotonic guard sees no completed review and denies the tool call.

## Decision mapping

| HOL Guard result | DSH outcome |
| --- | --- |
| `allow` | Continue through remaining DSH pre-execute policy, then pass the monotonic guard. |
| `ask`, `review`, `require-reapproval` | Request one native DSH approval. Only `allowed-once` becomes a latched allow. |
| `deny`, `block` | Deny before tool dispatch. |
| `sandbox-required` | Deny. The plugin does not claim to provision or verify a DSH sandbox. |
| Missing command, timeout, cancellation, malformed output, oversized payload/output, non-zero allow/ask process | Deny. |
| HOL Guard listener bypassed or incomplete | Deny at the monotonic guard. |

## Trust and privacy properties

- Guard decisions are local by default. Guard Cloud is not required.
- The plugin launches the configured `hol-guard` executable directly with `shell: false`.
- Tool payloads and captured subprocess output are bounded.
- Circular or excessively nested tool input is rejected rather than silently dropped.
- The tool body never starts until both the asynchronous review and the monotonic guard permit it.
- Native DSH approval is one-call authorization only. Unknown or unavailable approval states fail closed.
- The plugin never treats `sandbox-required` as ordinary human approval.

## Scope and limitations

This boundary covers tool executions that traverse DSH's `ToolRuntime`. It does not claim control over code that a plugin executes outside the DSH tool pipeline. The current integration enforces before dispatch; post-result confidentiality filtering is a separate boundary and is not implied by this document.

## Verification

The repository runs:

- focused unit tests for allow, deny, ask, rejection, cancellation, missing services, malformed output, timeout, and listener bypass;
- manifest validation requiring the DSH `tools` service and monotonic guard registration;
- a real pinned DSH headless runtime test where the unprotected control executes a bash side effect and the protected profile blocks the identical call before the side effect.

Run locally:

```bash
npm test
npm run test:dsh-e2e
```
