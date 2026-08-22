package holguardmcpsdk

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type testInput struct {
	Path string `json:"path"`
}

func runToolCall(t *testing.T, provider DecisionProvider) (*mcp.CallToolResult, *atomic.Int32) {
	t.Helper()
	var executions atomic.Int32
	server := mcp.NewServer(&mcp.Implementation{Name: "hol-guard-test-server", Version: "0.1.0"}, nil)
	server.AddReceivingMiddleware(ReceivingMiddleware(provider))
	mcp.AddTool(server, &mcp.Tool{Name: "write_file", Description: "test tool"}, func(
		ctx context.Context,
		req *mcp.CallToolRequest,
		in testInput,
	) (*mcp.CallToolResult, any, error) {
		executions.Add(1)
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "executed"}}}, nil, nil
	})

	client := mcp.NewClient(&mcp.Implementation{Name: "hol-guard-test-client", Version: "0.1.0"}, nil)
	clientTransport, serverTransport := mcp.NewInMemoryTransports()
	ctx := context.Background()
	serverSession, err := server.Connect(ctx, serverTransport, nil)
	if err != nil {
		t.Fatalf("server connect: %v", err)
	}
	defer serverSession.Close()
	clientSession, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	defer clientSession.Close()

	result, err := clientSession.CallTool(ctx, &mcp.CallToolParams{
		Name:      "write_file",
		Arguments: map[string]any{"path": "/tmp/example"},
	})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	return result, &executions
}

func TestReceivingMiddlewareDenySkipsDownstreamTool(t *testing.T) {
	result, executions := runToolCall(t, DecisionProviderFunc(func(context.Context, ToolCall) (Decision, error) {
		return Decision{Action: ActionDeny}, nil
	}))
	if !result.IsError {
		t.Fatal("expected denied result to be an MCP tool error")
	}
	if got := executions.Load(); got != 0 {
		t.Fatalf("denied tool executed %d times, want 0", got)
	}
}

func TestReceivingMiddlewareProviderFailureFailsClosed(t *testing.T) {
	result, executions := runToolCall(t, DecisionProviderFunc(func(context.Context, ToolCall) (Decision, error) {
		return Decision{}, errors.New("provider unavailable")
	}))
	if !result.IsError {
		t.Fatal("expected provider failure to return an MCP tool error")
	}
	if got := executions.Load(); got != 0 {
		t.Fatalf("tool executed after provider failure %d times, want 0", got)
	}
}

func TestReceivingMiddlewareReviewFailsClosed(t *testing.T) {
	result, executions := runToolCall(t, DecisionProviderFunc(func(context.Context, ToolCall) (Decision, error) {
		return Decision{Action: ActionReview}, nil
	}))
	if !result.IsError {
		t.Fatal("expected review-required result to be an MCP tool error")
	}
	if got := executions.Load(); got != 0 {
		t.Fatalf("review-required tool executed %d times, want 0", got)
	}
}

func TestReceivingMiddlewareAllowDelegatesExactlyOnce(t *testing.T) {
	result, executions := runToolCall(t, DecisionProviderFunc(func(_ context.Context, call ToolCall) (Decision, error) {
		if call.Name != "write_file" {
			t.Fatalf("unexpected tool name %q", call.Name)
		}
		if call.Arguments["path"] != "/tmp/example" {
			t.Fatalf("unexpected arguments %#v", call.Arguments)
		}
		return Decision{Action: ActionAllow}, nil
	}))
	if result.IsError {
		t.Fatal("expected allowed call to succeed")
	}
	if got := executions.Load(); got != 1 {
		t.Fatalf("allowed tool executed %d times, want 1", got)
	}
}

func TestParseDecisionRejectsAmbiguousOutput(t *testing.T) {
	if _, err := parseDecision([]byte(`{"status":"ok"}`)); err == nil {
		t.Fatal("expected ambiguous decision to fail closed")
	}
	decision, err := parseDecision([]byte("noise\n{\"hookSpecificOutput\":{\"permissionDecision\":\"allow\"}}\n"))
	if err != nil || decision.Action != ActionAllow {
		t.Fatalf("unexpected parsed decision: %#v err=%v", decision, err)
	}
}
