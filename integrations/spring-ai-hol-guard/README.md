# Spring AI + HOL Guard

This proof-of-integration wraps Spring AI's public `ToolCallingManager` execution boundary so every model-requested tool call is evaluated by local HOL Guard before the underlying manager can execute any tool.

The adapter is deliberately small and provider-neutral. It does not modify Spring AI core and does not require Guard Cloud.

## Why this boundary

`ToolCallingManager.executeToolCalls(...)` is the Spring AI service responsible for executing tool calls requested by a chat model. `HolGuardToolCallingManager` preflights the complete tool-call batch before delegating once. If HOL Guard denies, requires review, times out, fails, or returns an ambiguous decision, the delegate is never invoked.

That whole-batch preflight matters when a model requests multiple tools: a later denied operation cannot arrive after an earlier tool has already produced a side effect.

## Usage

```java
ToolCallingManager existing = /* your configured Spring AI manager */;
ToolCallingManager guarded = HolGuardToolCallingManager.local(existing, Path.of("."));
```

The local bridge invokes:

```text
hol-guard guard hook --harness generic --workspace <workspace> --json
```

with a bounded `PreToolUse` envelope carrying `framework: spring-ai`, the tool name, structured tool arguments, and the tool-call id. Payloads are capped at 24 KiB and the default decision timeout is five seconds (hard maximum ten seconds).

Decision mapping is fail-closed:

- `allow` / `warn` → delegate normally
- `deny` / `block` / `sandbox-required` → throw before any tool execution
- `ask` / `review` / `require-reapproval` → throw `HolGuardReviewRequiredException` before execution so the application can route explicit approval
- timeout, process failure, malformed output, ambiguous decision, or non-zero allow → throw `HolGuardUnavailableException` before execution

The adapter never includes raw tool arguments in exception text or diagnostics.

## Verification

```bash
mvn -q -f integrations/spring-ai-hol-guard/pom.xml test
```

The contract tests use the released `org.springframework.ai:spring-ai-model:2.0.0` API and prove:

- deny produces zero delegated execution;
- review produces zero delegated execution;
- provider/runtime failure produces zero delegated execution;
- every call in a multi-tool batch is evaluated before the delegate runs;
- an allowed batch delegates exactly once.

## Upstream conversion

This is an independently maintained integration proof, not Spring endorsement. The intended upstream contribution is a small Spring AI documentation/sample change showing how a security policy can decorate the existing `ToolCallingManager`, without adding a product-specific dependency or new core interception API.
