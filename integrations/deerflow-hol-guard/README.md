# DeerFlow HOL Guard provider

A small, separately maintained `GuardrailProvider` for DeerFlow's native pre-tool `GuardrailMiddleware`.

DeerFlow already provides the central execution boundary. This package only maps DeerFlow's final `GuardrailRequest` into a bounded local HOL Guard decision and maps that decision back to `GuardrailDecision`. It does not patch DeerFlow's agent loop or add another middleware layer.

## Behavior

- explicit HOL Guard `allow` -> DeerFlow's normal handler executes;
- `deny` -> native DeerFlow denial, zero downstream executions;
- `review` / `ask` -> denial with `hol_guard.review_required`, because DeerFlow's current provider contract is boolean allow/deny rather than resumable approval;
- malformed output, timeout, provider/runtime failure, non-zero non-deny output, oversized payload/output -> provider error, which DeerFlow's default `GuardrailMiddleware(..., fail_closed=True)` blocks before the tool handler;
- failure messages do not copy raw tool arguments;
- local HOL Guard is the default path and Guard Cloud is not required.

## Install from source

Install this package into the same Python environment as DeerFlow:

```bash
pip install 'git+https://github.com/hashgraph-online/hol-guard-plugin.git#subdirectory=integrations/deerflow-hol-guard'
```

DeerFlow is the host runtime and remains separately installed. The provider package intentionally does not force a second DeerFlow version through pip resolution.

## Configure DeerFlow

DeerFlow's official guardrails configuration supports any installed provider by class path:

```yaml
guardrails:
  enabled: true
  fail_closed: true
  provider:
    use: deerflow_hol_guard:HolGuardProvider
    config:
      workspace: .
      timeout_seconds: 5
```

`fail_closed: true` is DeerFlow's default and should remain enabled for a security provider.

## Contract tests

The source proof installs a pinned current DeerFlow harness in CI and runs the provider through the real sync and async `GuardrailMiddleware` paths. It proves that allow executes exactly once while deny, review, malformed output, unavailable provider, non-zero non-deny output, and oversized input execute zero downstream handlers.

## External conversion

This package follows DeerFlow's documented custom-provider model. After the provider proof is green, the external conversion target is the smallest acceptable DeerFlow documentation/provider-discovery contribution that lets normal DeerFlow users configure `deerflow_hol_guard:HolGuardProvider` without copying implementation code into their backend. This independently maintained package does not imply ByteDance/DeerFlow endorsement.
