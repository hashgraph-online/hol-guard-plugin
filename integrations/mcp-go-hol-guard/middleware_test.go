package holguardmcpgo

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/mcptest"
	"github.com/mark3labs/mcp-go/server"
)

func request() mcp.CallToolRequest {
	var req mcp.CallToolRequest
	req.Params.Name = "destructive"
	req.Params.Arguments = map[string]any{"command":"rm -rf /tmp/example"}
	return req
}

func TestDenyAndFailureNeverInvokeHandler(t *testing.T) {
	for _, tc := range []struct{name string; provider DecisionProvider}{
		{"deny", DecisionProviderFunc(func(context.Context, ToolCall)(Decision,error){ return Decision{Action:ActionDeny}, nil })},
		{"review", DecisionProviderFunc(func(context.Context, ToolCall)(Decision,error){ return Decision{Action:ActionReview}, nil })},
		{"provider failure", DecisionProviderFunc(func(context.Context, ToolCall)(Decision,error){ return Decision{}, errors.New("offline") })},
		{"ambiguous", DecisionProviderFunc(func(context.Context, ToolCall)(Decision,error){ return Decision{}, nil })},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			h := Middleware(tc.provider)(func(context.Context, mcp.CallToolRequest)(*mcp.CallToolResult,error){ calls.Add(1); return mcp.NewToolResultText("executed"),nil })
			result, err := h(t.Context(), request())
			if err != nil { t.Fatal(err) }
			if !result.IsError { t.Fatal("expected fail-closed tool result") }
			if calls.Load() != 0 { t.Fatalf("downstream executed %d times", calls.Load()) }
		})
	}
}

func TestAllowInvokesHandlerExactlyOnce(t *testing.T) {
	var calls atomic.Int32
	provider := DecisionProviderFunc(func(context.Context, ToolCall)(Decision,error){ return Decision{Action:ActionAllow}, nil })
	h := Middleware(provider)(func(context.Context, mcp.CallToolRequest)(*mcp.CallToolResult,error){ calls.Add(1); return mcp.NewToolResultText("executed"),nil })
	result, err := h(t.Context(), request())
	if err != nil || result.IsError { t.Fatalf("unexpected result: %#v err=%v", result, err) }
	if calls.Load() != 1 { t.Fatalf("downstream executed %d times", calls.Load()) }
}

func TestRealServerDenyMeansZeroToolExecution(t *testing.T) {
	var calls atomic.Int32
	provider := DecisionProviderFunc(func(context.Context, ToolCall)(Decision,error){ return Decision{Action:ActionDeny}, nil })
	srv := mcptest.NewUnstartedServer(t)
	srv.AddServerOptions(server.WithToolHandlerMiddleware(Middleware(provider)))
	srv.AddTool(mcp.NewTool("destructive", mcp.WithString("command")), func(context.Context, mcp.CallToolRequest)(*mcp.CallToolResult,error){ calls.Add(1); return mcp.NewToolResultText("executed"),nil })
	if err := srv.Start(t.Context()); err != nil { t.Fatal(err) }
	defer srv.Close()
	result, err := srv.Client().CallTool(t.Context(), request())
	if err != nil { t.Fatal(err) }
	if !result.IsError { t.Fatal("expected blocked MCP result") }
	if calls.Load() != 0 { t.Fatalf("real server tool executed %d times", calls.Load()) }
}
