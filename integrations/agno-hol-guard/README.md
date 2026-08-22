# Agno + HOL Guard

This integration proof attaches HOL Guard to Agno's documented `tool_hooks` middleware boundary. Agno applies tool hooks around every tool call and execution continues only when the hook invokes the supplied next function.

It is independently maintained supporting work, not Agno endorsement, and does not require Guard Cloud.

## Runtime behavior

The integration provides two hooks because Agno intentionally has distinct synchronous and asynchronous tool-hook execution paths:

- `HolGuardToolHook` for synchronous Agent/tool execution.
- `AsyncHolGuardToolHook` for `arun` / async Agent and tool execution.

Both send a bounded `{tool name, arguments}` envelope to local HOL Guard before calling Agno's `next_func`.

- allow/warn: invoke `next_func` exactly once;
- deny/block/sandbox-required: return a blocked `ToolResult` without invoking the tool;
- review/ask/require-reapproval: return a review-required `ToolResult` without invoking the tool because Agno's global `tool_hooks` contract has no dynamic pause/confirm primitive;
- timeout, provider failure, malformed/ambiguous output, invalid or oversized input: fail closed without invoking the tool.

Request payloads are capped at 24 KiB, decision stdout at 64 KiB, subprocess stderr is discarded, and adapter error text never includes raw tool arguments.

## Usage

Synchronous execution:

```python
from agno.agent import Agent
from agno_hol_guard import HolGuardToolHook

agent = Agent(
    tools=[...],
    tool_hooks=[HolGuardToolHook()],
)
```

Asynchronous execution:

```python
from agno.agent import Agent
from agno_hol_guard import AsyncHolGuardToolHook

agent = Agent(
    tools=[...],
    tool_hooks=[AsyncHolGuardToolHook()],
)
```

Do not use the async hook on a synchronous Agno execution path: Agno deliberately skips coroutine hooks in sync function calls. Likewise, use the async hook for async agent execution so the supplied async `next_func` is awaited correctly.

The default provider invokes `hol-guard guard hook --harness generic --json` locally.

## Verification

The proof is pinned to current released/source Agno `2.9.0`.

```bash
python -m pip install -e 'integrations/agno-hol-guard[test]'
pytest integrations/agno-hol-guard/tests -q
```

The tests exercise Agno's real `Function` / `FunctionCall` hook chain for both sync and async execution. They require deny, review, and provider failure to produce zero entrypoint executions and allow to execute exactly once.

## External conversion

Agno's CONTRIBUTING guide uses the standard fork-and-pull-request workflow and explicitly allows well-tested AI-assisted contributions when disclosed and reviewed by the author. There is currently no reusable authenticated-user fork and the connected GitHub surface cannot create one. Once that action surface changes, the smallest upstream contribution should be a cookbook/docs example showing the provider-neutral `tool_hooks` security pattern, not a product-specific core dependency.
