+++
name = "hol-guard"
description = "Evaluate Moltis tool calls with local HOL Guard before execution"
events = ["BeforeToolCall"]
command = "node ./handler.mjs"
timeout = 12
priority = 100

[requires]
bins = ["node"]
+++

# HOL Guard

This project-local Moltis hook evaluates every `BeforeToolCall` event with local HOL Guard before the tool executes.

The hook deliberately does not list `hol-guard` as a Moltis eligibility requirement. Moltis skips ineligible hooks, so declaring Guard there would turn a missing Guard binary into a silent bypass. Instead the handler treats an unavailable Guard process as a block.

Install this directory as `<workspace>/.moltis/hooks/hol-guard/`. Project-local installation lets the handler derive the workspace from the hook directory. For other layouts, set `HOL_GUARD_WORKSPACE` explicitly.

The handler has an 8 second inner Guard deadline, shorter than Moltis's 12 second shell-hook deadline, so Guard timeout is converted into an explicit exit-1 block before the outer hook timeout can fire.

Moltis currently treats handler-level shell-hook errors/timeouts and circuit-broken hooks as non-fatal. The provider-neutral fail-closed framework fix is tracked upstream in moltis-org/moltis#1230. Until that lands, this consumer provides fail-closed semantics for failures it can observe inside the handler but cannot truthfully claim a complete framework-level required-hook guarantee.