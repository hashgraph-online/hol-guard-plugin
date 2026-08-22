# Strands Agents + HOL Guard

This integration proof implements Strands Agents' public `InterventionHandler.before_tool_call` boundary. It evaluates each tool call with local HOL Guard before Strands reaches tool execution.

It is independently maintained supporting work, not Strands/AWS endorsement, and does not require Guard Cloud.

## Why this seam

Strands interventions are a framework-native control primitive. `before_tool_call` may return `Proceed`, `Deny`, or `Confirm`; Strands' intervention registry maps `Deny` to `event.cancel_tool`, and the tool executor checks `cancel_tool` before invoking the selected tool. That gives HOL Guard a real pre-execution boundary rather than an advisory callback.

## Runtime mapping

`HolGuardIntervention` sends a bounded `{tool name, arguments}` envelope to local HOL Guard:

- allow/warn -> `Proceed`;
- deny/block/sandbox-required -> `Deny` before tool execution;
- review/ask/require-reapproval -> Strands-native `Confirm`, preserving its pause/resume approval flow;
- timeout, provider failure, malformed/ambiguous output, invalid or oversized input -> `Deny` fail closed.

The handler also declares `on_error = "deny"` so unexpected handler exceptions use Strands' own fail-closed intervention behavior. Request payloads are capped at 24 KiB, decision stdout at 64 KiB, stderr is discarded, and raw tool arguments are not included in adapter error text.

## Usage

```python
from strands import Agent
from strands_hol_guard import HolGuardIntervention

agent = Agent(
    tools=[...],
    interventions=[HolGuardIntervention()],
)
```

The default provider invokes `hol-guard guard hook --harness generic --json` locally.

## Verification

The proof is tested against released `strands-agents==1.50.2`.

```bash
python -m pip install -e 'integrations/strands-hol-guard[test]'
pytest integrations/strands-hol-guard/tests -q
```

The contract tests cover allow/deny/review mapping, fail-closed provider errors, bounded inputs, argument-safe diagnostics, and immediate execution only for `Proceed`. Strands' shipped executor provides the final guarantee: a `Deny` intervention sets `cancel_tool`, which is consumed before the selected tool reaches its execution stage.

## External conversion

The upstream repository's documented contribution process is issue-first for this integration direction. A feature-request mutation was attempted on 2026-08-21 and returned a repository-specific 403, so that exact route remains under its 24-hour state-change TTL. When writable again, the next external action is the smallest placement proposal for an independently maintained intervention or docs/example, not a product-specific core dependency.
