# BeeAI Framework + HOL Guard

Experimental, separately maintained proof that attaches HOL Guard to BeeAI Framework's public `RunMiddlewareProtocol` and blocks a `Tool` run before the underlying tool handler executes unless Guard returns an explicit allow decision.

This is not an endorsed BeeAI integration. It exists to validate the current public middleware contract before proposing the smallest useful upstream docs/example or integration placement.

## Why this boundary

BeeAI middleware is designed for filtering and safety checks. `RunContextStartEvent.output` can short-circuit a runnable before its handler executes. The middleware listens to internal run-start events, selects nested `Tool` runs, and uses that native short-circuit path for deny, review, invalid output, provider failure, timeout, and oversized requests.

## Usage

```python
from beeai_hol_guard import BeeAIHolGuardMiddleware

result = await agent.run("...").middleware(BeeAIHolGuardMiddleware())
```

The middleware can also be attached directly to a tool run. HOL Guard runs locally; no Guard Cloud account is required.

## Contract

- allow: the BeeAI tool handler executes exactly once;
- deny or review: zero underlying tool-handler executions;
- Guard unavailable/error: zero executions;
- oversized or non-authoritative decisions: zero executions;
- diagnostics returned to the agent never echo tool arguments.

The payload is capped at 24 KiB and the local Guard decision deadline defaults to 8 seconds.
