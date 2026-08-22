package holguardmcpsdk

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	maxPayloadBytes        = 24 * 1024
	maxDecisionOutputBytes = 64 * 1024
)

type Action string

const (
	ActionAllow  Action = "allow"
	ActionDeny   Action = "deny"
	ActionReview Action = "review"
)

type Decision struct {
	Action Action
}

type ToolCall struct {
	Name      string
	Arguments map[string]any
}

type DecisionProvider interface {
	Evaluate(context.Context, ToolCall) (Decision, error)
}

type DecisionProviderFunc func(context.Context, ToolCall) (Decision, error)

func (f DecisionProviderFunc) Evaluate(ctx context.Context, call ToolCall) (Decision, error) {
	return f(ctx, call)
}

// ReceivingMiddleware gates inbound tools/call requests before the registered
// MCP tool handler executes. All non-tool methods pass through unchanged.
func ReceivingMiddleware(provider DecisionProvider) mcp.Middleware {
	if provider == nil {
		panic("holguardmcpsdk: nil decision provider")
	}
	return func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
			toolReq, ok := req.(*mcp.CallToolRequest)
			if !ok {
				return next(ctx, method, req)
			}

			name := strings.TrimSpace(toolReq.Params.Name)
			if name == "" {
				return denyResult("HOL Guard could not identify the MCP tool call"), nil
			}

			if len(toolReq.Params.Arguments) > maxPayloadBytes {
				return denyResult("HOL Guard could not safely evaluate MCP tool arguments"), nil
			}
			arguments := map[string]any{}
			if len(toolReq.Params.Arguments) > 0 {
				if err := json.Unmarshal(toolReq.Params.Arguments, &arguments); err != nil {
					return denyResult("HOL Guard could not safely evaluate MCP tool arguments"), nil
				}
			}

			decision, err := evaluateSafely(provider, ctx, ToolCall{Name: name, Arguments: arguments})
			if err != nil {
				return denyResult("HOL Guard was unavailable; MCP tool execution failed closed"), nil
			}
			switch decision.Action {
			case ActionAllow:
				return next(ctx, method, req)
			case ActionDeny:
				return denyResult("HOL Guard denied MCP tool execution"), nil
			case ActionReview:
				return denyResult("HOL Guard requires approval before MCP tool execution"), nil
			default:
				return denyResult("HOL Guard returned no authoritative decision; MCP tool execution failed closed"), nil
			}
		}
	}
}

func denyResult(message string) *mcp.CallToolResult {
	return &mcp.CallToolResult{
		IsError: true,
		Content: []mcp.Content{&mcp.TextContent{Text: message}},
	}
}

func evaluateSafely(provider DecisionProvider, ctx context.Context, call ToolCall) (decision Decision, err error) {
	defer func() {
		if recover() != nil {
			decision = Decision{}
			err = errors.New("HOL Guard decision provider panicked")
		}
	}()
	return provider.Evaluate(ctx, call)
}

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
		return Decision{}, errors.New("invalid HOL Guard timeout")
	}
	workspace := strings.TrimSpace(p.Workspace)
	if workspace != "" {
		var err error
		workspace, err = filepath.Abs(workspace)
		if err != nil {
			return Decision{}, errors.New("invalid workspace")
		}
	}

	payload := map[string]any{
		"hook_event_name": "PreToolUse",
		"tool_name":       call.Name,
		"tool_input":      call.Arguments,
		"framework":       "mcp-go-sdk",
		"source_scope":    map[bool]string{true: "project", false: "global"}[workspace != ""],
	}
	encoded, err := json.Marshal(payload)
	if err != nil || len(encoded) > maxPayloadBytes {
		return Decision{}, errors.New("HOL Guard request exceeds adapter limit")
	}

	decisionCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	argv := []string{"guard", "hook", "--harness", "generic"}
	if workspace != "" {
		argv = append(argv, "--workspace", workspace)
	}
	argv = append(argv, "--json")
	cmd := exec.CommandContext(decisionCtx, executable, argv...)
	cmd.Stdin = bytes.NewReader(encoded)
	cmd.Stderr = io.Discard
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return Decision{}, errors.New("HOL Guard decision process could not start")
	}
	if err := cmd.Start(); err != nil {
		return Decision{}, errors.New("HOL Guard decision process could not start")
	}
	output, readErr := io.ReadAll(io.LimitReader(stdout, maxDecisionOutputBytes+1))
	if readErr != nil {
		cancel()
		_ = cmd.Wait()
		return Decision{}, errors.New("HOL Guard decision output could not be read")
	}
	if len(output) > maxDecisionOutputBytes {
		cancel()
		_ = cmd.Wait()
		return Decision{}, errors.New("HOL Guard decision output exceeded adapter limit")
	}
	if err := cmd.Wait(); err != nil {
		return Decision{}, errors.New("HOL Guard decision process failed")
	}
	return parseDecision(output)
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
				if d, ok := normalizeDecision(value); ok {
					return d, nil
				}
			}
		}
		if hook, ok := payload["hookSpecificOutput"].(map[string]any); ok {
			if value, ok := hook["permissionDecision"].(string); ok {
				if d, ok := normalizeDecision(value); ok {
					return d, nil
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
