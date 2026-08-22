# HOL Guard middleware for mcp-go

A thin, independently maintained integration proof for `github.com/mark3labs/mcp-go`'s public `ToolHandlerMiddleware` seam.

```go
srv := server.NewMCPServer("example", "1.0.0",
    server.WithToolHandlerMiddleware(holguardmcpgo.Middleware(
        holguardmcpgo.LocalProvider{Workspace: "."},
    )),
)
```

The middleware evaluates `{tool name, arguments}` with the local HOL Guard CLI before invoking the registered tool handler. It is local-only by default and does not require Guard Cloud.

Semantics are deliberately fail-closed: `deny`, `review`, provider failure, timeout, oversized input, or an ambiguous decision return an MCP error result without calling the downstream handler. `allow` calls the handler exactly once. Raw tool arguments are never included in adapter diagnostics.

## Scope

mcp-go applies `ToolHandlerMiddleware` to normal tools and to regular tools executed through its task-augmented path. Native task tools registered with `TaskToolHandlerFunc` are not covered by this middleware API and must apply policy inside their task handler. This adapter does not claim otherwise.

## Why this boundary

This uses mcp-go's existing middleware contract; it adds no core interception API and no mandatory HOL dependency to mcp-go. The intended upstream contribution is the smallest useful documentation/example showing provider-neutral pre-tool policy enforcement, not vendor-specific core code.
