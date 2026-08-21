# DeepSeek Harness security boundary

HOL Guard integrates with the DeepSeek Harness (DSH) tool runtime at two separate policy layers. The split is intentional: DSH's asynchronous `tools/pre-execute` waterfall can be reordered or short-circuited by another plugin, while `ctx.tools.guard()` is a monotonic final denial boundary that runs after the waterfall and before dispatch.

## Enforcement order

For every DSH tool execution:

1. HOL Guard installs a fail-closed decision latch for the exact DSH execution object and captures the exact serialized call identity.
2. The `tools/pre-execute` listener serializes the tool name, arguments, call ID, root call ID, and workspace into a bounded `PreToolUse` payload.
3. The payload is reviewed by `hol-guard guard hook --harness dsh` under a process-tree deadline.
4. Hard-deny signals dominate review and allow across same-layer fields, nested wrappers, and sibling response branches.
5. An authoritative `ask` or review decision is routed through DSH's native one-time approval service.
6. Rejection, cancellation, a missing approval service, a headless call without an agent, an unknown approval outcome, or an approval transport failure is latched as deny.
7. Before downstream pre-execute policy runs, HOL Guard makes the execution's own readonly identity fields non-writable and non-configurable.
8. After downstream policy returns, HOL Guard reserializes the call. Any change to the reviewed name, arguments, IDs, or workspace becomes a denial.
9. The monotonic `ctx.tools.guard()` callback revalidates the serialized call and permits only a completed, unchanged allow. A missing latch, mutation, or denial returns a final reason and prevents dispatch.

This means a different pre-execute plugin cannot force-allow a HOL Guard denial. If another listener short-circuits the waterfall before HOL Guard runs, the monotonic guard sees no completed review and denies the tool call. If a later listener attempts to replace the reviewed execution identity, the readonly property lock prevents the change; mutable nested workspace drift is detected by reserialization.

## Decision mapping

| HOL Guard or pipeline result | DSH outcome |
| --- | --- |
| `allow` | Continue through remaining DSH pre-execute policy, then pass the monotonic guard only if the reviewed call is unchanged. |
| `ask`, `review`, `require-reapproval` | Request one native DSH approval. Only `allowed-once` becomes a candidate allow. |
| `deny`, `block` | Deny before tool dispatch. |
| `sandbox-required` | Deny. The plugin does not claim to provision or verify a DSH sandbox. |
| Missing command, timeout, cancellation, malformed output, oversized payload/output, non-zero allow/ask process | Deny. |
| HOL Guard listener bypassed or incomplete | Deny at the monotonic guard. |
| Tool name, arguments, call identity, or workspace changed after review | Deny before dispatch and at the monotonic guard. |
| Execution identity cannot be locked or revalidated | Deny. |

## Trust and privacy properties

- Guard decisions are local by default. Guard Cloud is not required.
- The plugin launches the configured `hol-guard` executable directly with `shell: false`.
- Tool payloads and captured subprocess output are bounded.
- Circular or excessively nested tool input is rejected rather than silently dropped.
- The tool body never starts until the asynchronous review, native approval when required, execution-binding check, and monotonic guard all permit it.
- Native DSH approval is one-call authorization only. Unknown or unavailable approval states fail closed.
- The reviewed serialized payload is reused for the subprocess call and retained only as a bounded in-memory execution binding.
- DSH identity fields intended to be readonly are locked before downstream policy can act on the call.
- The plugin never treats `sandbox-required` as ordinary human approval.

## Scope and limitations

This boundary covers tool executions that traverse DSH's `ToolRuntime`. It does not claim control over code that a plugin executes outside the DSH tool pipeline. The current integration enforces before dispatch; post-result confidentiality filtering is a separate boundary and is not implied by this document.

## Verification

The repository runs:

- focused unit tests for allow, deny, ask, rejection, cancellation, missing services, malformed output, timeout, and listener bypass;
- contradiction tests proving deny dominates review and allow across every recognized response field and wrapper;
- execution-binding tests proving own identity replacement is prevented, workspace drift is denied, and non-data identity descriptors fail closed;
- manifest validation requiring the DSH `tools` service, monotonic guard registration, and execution-binding logic;
- a real pinned DSH headless runtime test where the unprotected control executes a bash side effect and the protected profile blocks the identical call before the side effect.

Run locally:

```bash
npm test
npm run test:dsh-e2e
```
