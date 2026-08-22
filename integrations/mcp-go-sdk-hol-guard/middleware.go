package holguardmcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const maxPayloadBytes = 24 * 1024

// Action is the normalized HOL Guard decision applied before an MCP tool handler.
type Action string

const (
	ActionAllow  Action = "allow"
	ActionDeny   Action = "deny"
	ActionReview Action = "review"
)

// Decision is deliberately small: adapters should not leak raw tool arguments
// through errors or diagnostics.
type Decision struct {
	Action Action
}

// ToolCall is the bounded, provider-neutral request passed to a decision provider.
type ToolCall struct {
	Name      string
	Arguments json.RawMessage
}

// DecisionProvider evaluates one MCP tools/call request before its registered handler runs.
type DecisionProvider interface {
	Evaluate(context.Context, ToolCall) (Decision, error)
}

// DecisionProviderFunc adapts a function to DecisionProvider.
type DecisionProviderFunc func(context.Context, ToolCall) (Decision, error)

func (f DecisionProviderFunc) Evaluate(ctx context.Context, call ToolCall) (Decision, error) {
	return f(ctx, call)
}

// ReceivingMiddleware gates only tools/call requests. All other MCP methods pass through
// unchanged. Deny, review, unavailable Guard, malformed decisions, and provider errors
// short-circuit before next is invoked.
func ReceivingMiddleware(provider DecisionProvider) mcp.Middleware {
	if provider == nil {
		panic("holguardmcp: nil decision provider")
	}
	return func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
			callReq, ok := req.(*mcp.CallToolRequest)
			if !ok {
				return next(ctx, method, req)
			}

			name := strings.TrimSpace(callReq.Params.Name)
			if name == "" {
				return blockedResult("HOL Guard could not identify the MCP tool call"), nil
			}
			arguments := append(json.RawMessage(nil), callReq.Params.Arguments...)
			if len(arguments) == 0 {
				arguments = json.RawMessage(`{}`)
			}
			if !json.Valid(arguments) {
				return blockedResult("HOL Guard rejected malformed MCP tool arguments"), nil
			}

			decision, err := provider.Evaluate(ctx, ToolCall{Name: name, Arguments: arguments})
			if err != nil {
				return blockedResult("HOL Guard was unavailable; MCP tool execution failed closed"), nil
			}
			switch decision.Action {
			case ActionAllow:
				return next(ctx, method, req)
			case ActionReview:
				return blockedResult("HOL Guard requires approval before MCP tool execution"), nil
			case ActionDeny:
				return blockedResult("HOL Guard denied MCP tool execution"), nil
			default:
				return blockedResult("HOL Guard returned no authoritative decision; MCP tool execution failed closed"), nil
			}
		}
	}
}

func blockedResult(message string) *mcp.CallToolResult {
	return &mcp.CallToolResult{
		IsError: true,
		Content: []mcp.Content{&mcp.TextContent{Text: message}},
	}
}

// LocalProvider invokes the local HOL Guard CLI. It does not require Guard Cloud.
type LocalProvider struct {
	Executable string
	Workspace  string
	Timeout    time.Duration
}

func (p LocalProvider) Evaluate(ctx context.Context, call ToolCall) (Decision, error) {
	executable := strings.TrimSpace(p.Executable)
	if executable == "" {
		executable = "hol-guard"
	}
	timeout := p.Timeout
	if timeout == 0 {
		timeout = 5 * time.Second
	}
	if timeout < 250*time.Millisecond || timeout > 10*time.Second {
		return Decision{}, errors.New("HOL Guard timeout must be between 250ms and 10s")
	}
	workspace := strings.TrimSpace(p.Workspace)
	if workspace != "" {
		var err error
		workspace, err = filepath.Abs(workspace)
		if err != nil {
			return Decision{}, fmt.Errorf("resolve workspace: %w", err)
		}
	}

	var toolInput any
	if err := json.Unmarshal(call.Arguments, &toolInput); err != nil {
		return Decision{}, errors.New("invalid MCP tool arguments")
	}
	payload := map[string]any{
		"hook_event_name": "PreToolUse",
		"tool_name":       call.Name,
		"tool_input":      toolInput,
		"framework":       "mcp-go-sdk",
		"source_scope":    map[bool]string{true: "project", false: "global"}[workspace != ""],
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return Decision{}, errors.New("serialize HOL Guard request")
	}
	if len(encoded) > maxPayloadBytes {
		return Decision{}, errors.New("HOL Guard request exceeds 24 KiB adapter limit")
	}

	decisionCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	args := []string{"guard", "hook", "--harness", "generic"}
	if workspace != "" {
		args = append(args, "--workspace", workspace)
	}
	args = append(args, "--json")
	cmd := exec.CommandContext(decisionCtx, executable, args...)
	cmd.Stdin = bytes.NewReader(encoded)
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	// Intentionally discard stderr here: tool arguments must never become adapter diagnostics.
	if err := cmd.Run(); err != nil {
		return Decision{}, errors.New("HOL Guard decision process failed")
	}
	return parseDecision(stdout.Bytes())
}

func parseDecision(output []byte) (Decision, error) {
	lines := bytes.Split(bytes.TrimSpace(output), []byte("\n"))
	for i := len(lines) - 1; i >= 0; i-- {
		line := bytes.TrimSpace(lines[i])
		if len(line) == 0 || line[0] != '{' {
			continue
		}
		var payload map[string]any
		if json.Unmarshal(line, &payload) != nil {
			continue
		}
		if blocked, _ := payload["blocked"].(bool); blocked {
			return Decision{Action: ActionDeny}, nil
		}
		if cont, ok := payload["continue"].(bool); ok && !cont {
			return Decision{Action: ActionDeny}, nil
		}
		for _, key := range []string{"policy_action", "policyAction", "decision", "permissionDecision"} {
			if value, ok := payload[key].(string); ok {
				if decision, ok := normalizeDecision(value); ok {
					return decision, nil
				}
			}
		}
		if hook, ok := payload["hookSpecificOutput"].(map[string]any); ok {
			if value, ok := hook["permissionDecision"].(string); ok {
				if decision, ok := normalizeDecision(value); ok {
					return decision, nil
				}
			}
		}
	}
	return Decision{}, errors.New("HOL Guard returned no authoritative decision")
}

func normalizeDecision(value string) (Decision, bool) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "allow", "warn":
		return Decision{Action: ActionAllow}, true
	case "ask", "review", "require-reapproval":
		return Decision{Action: ActionReview}, true
	case "deny", "block", "sandbox-required":
		return Decision{Action: ActionDeny}, true
	default:
		return Decision{}, false
	}
}
