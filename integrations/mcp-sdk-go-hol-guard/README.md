# HOL Guard for the official MCP Go SDK

This proof uses the official SDK's existing server receiving-middleware API. It does not change the MCP SDK and does not imply upstream endorsement.

`ReceivingMiddleware` inspects only inbound `*mcp.CallToolRequest` values. It sends a bounded `{tool name, arguments}` envelope to the local open-source HOL Guard runtime and calls the SDK's next handler only after an authoritative allow decision.

```go
server := mcp.NewServer(&mcp.Implementation{Name: "example", Version: "1.0.0"}, nil)
server.AddReceivingMiddleware(holguardmcpsdk.ReceivingMiddleware(
    holguardmcpsdk.LocalProvider{Workspace: "."},
))
```

Behavior:

- allow: delegate exactly once
- deny: return an MCP tool error without running the registered tool
- review required: fail closed until approval is resolved outside this stateless middleware call
- Guard unavailable, ambiguous output, malformed arguments, or oversized payload: fail closed
- non-tool MCP methods: pass through unchanged

The local provider invokes `hol-guard guard hook --harness generic --json`; HOL Guard Cloud is not required.

## Contract test

The test uses the SDK's real in-memory client/server transports and a registered tool handler. It asserts that deny, review, and Guard failure leave the downstream handler execution count at zero, while allow executes it exactly once.

```bash
go test -v ./...
```

## External conversion

This is supporting evidence for an upstream provider-neutral example/docs proposal. The intended contribution is the smallest official-SDK example showing how an external policy engine can use `Server.AddReceivingMiddleware`; the SDK should not take a dependency on HOL Guard.
