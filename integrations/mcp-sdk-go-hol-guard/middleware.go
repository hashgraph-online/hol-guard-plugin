package holguardmcpsdk

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
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
	maxStderrBytes         = 4 * 1024
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

type boundedBuffer struct {
	buf       bytes.Buffer
	remaining int
}

func newBoundedBuffer(limit int) *boundedBuffer {
	return &boundedBuffer{remaining: limit}
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	originalLen := len(p)
	if b.remaining > 0 {
		keep := len(p)
		if keep > b.remaining {
			keep = b.remaining
		}
		_, _ = b.buf.Write(p[:keep])
		b.remaining -= keep
	}
	return originalLen, nil
}

func (b *boundedBuffer) Bytes() []byte {
	return b.buf.Bytes()
}

func safeStderrSummary(stderr []byte) string {
	lower := strings.ToLower(string(stderr))
	for _, category := range []struct {
		needle string
		label  string
	}{
		{"permission denied", "permission-denied"},
		{"no such file", "missing-resource"},
		{"not found", "missing-resource"},
		{"timeout", "timeout"},
		{"deadline", "timeout"},
		{"sandbox", "sandbox"},
		{"sqlite", "local-state"},
		{"database", "local-state"},
		{"json", "invalid-output"},
		{"parse", "invalid-output"},
		{"policy", "policy-config"},
		{"config", "policy-config"},
	} {
		if strings.Contains(lower, category.needle) {
			return category.label
		}
	}
	if len(stderr) == 0 {
		return "stderr-empty"
	}
	digest := sha256.Sum256(stderr)
	return fmt.Sprintf("stderr-sha256=%x", digest[:6])
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
	stderr := newBoundedBuffer(maxStderrBytes)
	cmd.Stderr = stderr
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
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return Decision{}, fmt.Errorf("HOL Guard decision process failed (exit=%d, %s)", exitErr.ExitCode(), safeStderrSummary(stderr.Bytes()))
		}
		return Decision{}, fmt.Errorf("HOL Guard decision process failed (%s)", safeStderrSummary(stderr.Bytes()))
	}
	return parseDecision(output)
}

func parseDecision(output []byte) (Decision, error) {
	trimmed := bytes.TrimSpace(output)
	var payload map[string]any
	if json.Unmarshal(trimmed, &payload) == nil {
		if decision, ok := classifyDecisionPayload(payload); ok {
			return decision, nil
		}
	}

	lines := bytes.Split(trimmed, []byte("\n"))
	for i := len(lines) - 1; i >= 0; i-- {
		line := bytes.TrimSpace(lines[i])
		if len(line) == 0 || line[0] != '{' {
			continue
		}
		payload = nil
		if json.Unmarshal(line, &payload) != nil {
			continue
		}
		if decision, ok := classifyDecisionPayload(payload); ok {
			return decision, nil
		}
	}
	return Decision{}, errors.New("HOL Guard returned no authoritative decision")
}

func classifyDecisionPayload(payload map[string]any) (Decision, bool) {
	if blocked, _ := payload["blocked"].(bool); blocked {
		return Decision{Action: ActionDeny}, true
	}
	if cont, ok := payload["continue"].(bool); ok && !cont {
		return Decision{Action: ActionDeny}, true
	}
	for _, key := range []string{"policy_action", "policyAction", "decision", "permissionDecision"} {
		if value, ok := payload[key].(string); ok {
			if decision, ok := normalizeDecision(value); ok {
				return decision, true
			}
		}
	}
	if hook, ok := payload["hookSpecificOutput"].(map[string]any); ok {
		if value, ok := hook["permissionDecision"].(string); ok {
			if decision, ok := normalizeDecision(value); ok {
				return decision, true
			}
		}
	}
	return Decision{}, false
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
