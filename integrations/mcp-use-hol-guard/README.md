# mcp-use + HOL Guard

This is an author-owned proof of a local HOL Guard policy middleware for the documented Python `mcp-use` client middleware boundary.

`mcp-use` already routes `tools/call` through `Middleware.on_call_tool(context, call_next)`. The adapter evaluates the final tool name and structured arguments before choosing whether to invoke `call_next(context)`. An authoritative Guard allow delegates exactly once. Deny, review, malformed output, invalid input, timeout, oversized input/output, or provider failure returns a framework-native MCP error result without sending the tool call downstream.

```python
from mcp_use import MCPClient
from mcp_use_hol_guard import MCPUseHOLGuardMiddleware

client = MCPClient(
    config=config,
    middleware=[MCPUseHOLGuardMiddleware()],
)
```

The local provider invokes `hol-guard guard hook --harness generic`, bounds requests to 24 KiB and captured output to 64 KiB, uses an 8 second deadline, and does not require Guard Cloud. Failure diagnostics are fixed strings and never echo tool arguments.

The contract tests run against `mcp-use==1.7.0` and use its real `MiddlewareManager` chain to prove that allow reaches the downstream handler exactly once while deny, review, provider failure, invalid provider output, non-serializable input, and oversized input reach it zero times.

This repository is not claiming upstream mcp-use endorsement. The external architecture discussion is https://github.com/mcp-use/mcp-use/issues/1257. The intended conversion is the smallest docs/example or separately maintained middleware placement that maintainers choose; this proof does not revive the broader built-in authorization subsystem.
