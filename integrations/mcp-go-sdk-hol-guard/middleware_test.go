package holguardmcp

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type toolArgs struct {
	Value string `json:"value"`
}

func TestDenyProducesZeroRegisteredHandlerExecution(t *testing.T) {
	var executions atomic.Int32
	result, err := callProbeTool(t, DecisionProviderFunc(func(context.Context, ToolCall) (Decision, error) {
		return Decision{Action: ActionDeny}, nil
	}), &executions)
	if err != nil {
		t.Fatalf("CallTool returned protocol error: %v", err)
	}
	if executions.Load() != 0 {
		t.Fatalf("handler executed %d times, want zero", executions.Load())
	}
	if !result.IsError {
		t.Fatal("blocked tool result must be marked IsError")
	}
}

func TestUnavailableGuardFailsClosedBeforeHandler(t *testing.T) {
	var executions atomic.Int32
	result, err := callProbeTool(t, DecisionProviderFunc(func(context.Context, ToolCall) (Decision, error) {
		return Decision{}, errors.New("unavailable")
	}), &executions)
	if err != nil {
		t.Fatalf("CallTool returned protocol error: %v", err)
	}
	if executions.Load() != 0 {
		t.Fatalf("handler executed %d times, want zero", executions.Load())
	}
	if !result.IsError {
		t.Fatal("failed-closed result must be marked IsError")
	}
}

func TestReviewProducesZeroHandlerExecution(t *testing.T) {
	var executions atomic.Int32
	result, err := callProbeTool(t, DecisionProviderFunc(func(context.Context, ToolCall) (Decision, error) {
		return Decision{Action: ActionReview}, nil
	}), &executions)
	if err != nil {
		t.Fatalf("CallTool returned protocol error: %v", err)
	}
	if executions.Load() != 0 {
		t.Fatalf("handler executed %d times, want zero", executions.Load())
	}
	if !result.IsError {
		t.Fatal("review-required result must be marked IsError")
	}
}

func TestAllowExecutesRegisteredHandlerExactlyOnce(t *testing.T) {
	var executions atomic.Int32
	var seen ToolCall
	result, err := callProbeTool(t, DecisionProviderFunc(func(_ context.Context, call ToolCall) (Decision, error) {
		seen = call
		return Decision{Action: ActionAllow}, nil
	}), &executions)
	if err != nil {
		t.Fatalf("CallTool failed: %v", err)
	}
	if executions.Load() != 1 {
		t.Fatalf("handler executed %d times, want one", executions.Load())
	}
	if result.IsError {
		t.Fatal("allowed tool result unexpectedly marked IsError")
	}
	if seen.Name != "probe" {
		t.Fatalf("provider saw tool %q, want probe", seen.Name)
	}
	if string(seen.Arguments) == "" {
		t.Fatal("provider did not receive structured arguments")
	}
}

func callProbeTool(t *testing.T, provider DecisionProvider, executions *atomic.Int32) (*mcp.CallToolResult, error) {
	t.Helper()
	server := mcp.NewServer(&mcp.Implementation{Name: "hol-guard-test-server", Version: "0.1.0"}, nil)
	server.AddReceivingMiddleware(ReceivingMiddleware(provider))
	mcp.AddTool(server, &mcp.Tool{Name: "probe", Description: "contract probe"},
		func(_ context.Context, _ *mcp.CallToolRequest, input toolArgs) (*mcp.CallToolResult, any, error) {
			executions.Add(1)
			return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: input.Value}}}, nil, nil
		})

	client := mcp.NewClient(&mcp.Implementation{Name: "hol-guard-test-client", Version: "0.1.0"}, nil)
	clientTransport, serverTransport := mcp.NewInMemoryTransports()
	ctx := context.Background()
	serverSession, err := server.Connect(ctx, serverTransport, nil)
	if err != nil {
		t.Fatalf("server connect: %v", err)
	}
	t.Cleanup(func() { _ = serverSession.Close() })
	clientSession, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	t.Cleanup(func() { _ = clientSession.Close() })
	return clientSession.CallTool(ctx, &mcp.CallToolParams{Name: "probe", Arguments: map[string]any{"value": "ok"}})
}

func TestParserNeverTreatsAmbiguousOutputAsAllow(t *testing.T) {
	if _, err := parseDecision([]byte(`{"message":"ok"}`)); err == nil {
		t.Fatal("ambiguous output unexpectedly allowed")
	}
}
