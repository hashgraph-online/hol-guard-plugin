# Official MCP Go SDK + HOL Guard

This proof uses the official `modelcontextprotocol/go-sdk` receiving-middleware boundary to gate `tools/call` before the registered tool handler executes.

It is intentionally provider-neutral and leaves the SDK API untouched. `ReceivingMiddleware` only intercepts `*mcp.CallToolRequest`; initialization, discovery, notifications, resources, prompts, and other MCP methods pass through unchanged.

## Usage

```go
server := mcp.NewServer(&mcp.Implementation{Name: "my-server"}, nil)
server.AddReceivingMiddleware(holguardmcp.ReceivingMiddleware(
    holguardmcp.LocalProvider{Workspace: "."},
))
```

The local provider invokes `hol-guard guard hook --harness generic --json` with a bounded `PreToolUse` envelope containing the tool name and structured MCP arguments. Guard Cloud is not required.

Decision behavior is fail-closed:

- allow/warn: invoke the SDK's next receiving handler normally;
- deny/block/sandbox-required: return an MCP tool error without invoking the registered tool;
- review/ask/require-reapproval: return a review-required MCP tool error without invoking the registered tool;
- timeout/provider failure/malformed or ambiguous decision: return a generic failed-closed MCP tool error without invoking the registered tool.

No raw tool arguments are included in adapter errors or diagnostics. Requests are capped at 24 KiB and local decision timeouts at ten seconds.

## Contract verification

`go test ./...` runs against released `github.com/modelcontextprotocol/go-sdk v1.6.1` and uses the SDK's real in-memory client/server transport plus a registered tool. It proves deny, review, and provider failure produce zero registered-handler executions while allow executes exactly once.

## Upstream conversion

This is an independently maintained integration proof, not MCP project endorsement. Because the official SDK asks contributors to discuss non-trivial new integration examples before code, the next external action is a focused issue proposing the smallest provider-neutral policy-middleware example/documentation placement. No product dependency or SDK API change is requested.
