import { spawn } from "node:child_process";

export const DEFAULT_EXECUTABLE = "hol-guard";
export const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const BLOCK_ACTIONS = new Set(["block", "deny", "review", "require-reapproval", "sandbox-required"]);

function boundedAppend(current, chunk) {
  if (Buffer.byteLength(current) >= MAX_CAPTURE_BYTES) {
    return current;
  }
  const remaining = MAX_CAPTURE_BYTES - Buffer.byteLength(current);
  return current + Buffer.from(chunk).subarray(0, remaining).toString("utf8");
}

function parseLastJsonObject(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const value = JSON.parse(trimmed);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    // Guard may emit bounded diagnostics before a final JSON line. Prefer the last JSON object.
  }
  const lines = trimmed.split(/\r?\n/).reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value;
      }
    } catch {
      // Continue to earlier lines.
    }
  }
  return null;
}

function normalizedAction(payload) {
  for (const key of ["policy_action", "decision", "action"]) {
    const value = payload?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim().toLowerCase().replaceAll("_", "-");
    }
  }
  return null;
}

function decisionReason(payload, stderr, code, action) {
  for (const key of ["permission_decision_reason", "reason", "message"]) {
    const value = payload?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim().slice(0, 1000);
    }
  }
  if (action) {
    return `HOL Guard policy action: ${action}`;
  }
  const error = stderr.trim();
  if (error) {
    return error.slice(0, 1000);
  }
  return `HOL Guard exited with status ${code ?? "unknown"}`;
}

export function classifyGuardResult({ code, stdout = "", stderr = "" }) {
  const payload = parseLastJsonObject(stdout);
  const action = normalizedAction(payload);
  if (code === 0 && !BLOCK_ACTIONS.has(action)) {
    return { kind: "allow", policyAction: action ?? "allow", reason: "allow" };
  }
  return {
    kind: "block",
    policyAction: action ?? "error",
    reason: decisionReason(payload, stderr, code, action),
  };
}

export function buildGuardPayload(event, context = {}, workspace) {
  const sessionId = context.sessionId ?? context.runId;
  const payload = {
    artifact_id: `openclaw:tool:${event.toolName}`,
    artifact_name: event.toolName,
    hook_event_name: "PreToolUse",
    source_scope: "project",
    tool_name: event.toolName,
    tool_input: event.params,
  };
  if (sessionId) {
    payload.session_id = sessionId;
  }
  if (workspace) {
    payload.cwd = workspace;
  }
  return payload;
}

export async function evaluateWithGuard({
  event,
  context = {},
  executable = DEFAULT_EXECUTABLE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  workspace,
  spawnImpl = spawn,
}) {
  const payload = JSON.stringify(buildGuardPayload(event, context, workspace));
  if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) {
    return { kind: "block", policyAction: "error", reason: "HOL Guard payload exceeded 256 KiB" };
  }

  return await new Promise((resolve) => {
    let child;
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (decision) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.abortSignal?.removeEventListener?.("abort", onAbort);
      resolve(decision);
    };

    const onAbort = () => {
      child?.kill?.("SIGKILL");
      finish({ kind: "block", policyAction: "cancelled", reason: "OpenClaw cancelled the guarded tool call" });
    };

    try {
      child = spawnImpl(executable, ["hook", "--harness", "openclaw", "--json"], {
        cwd: workspace || undefined,
        env: process.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ kind: "block", policyAction: "error", reason: `HOL Guard could not start: ${String(error)}` });
      return;
    }

    const timer = setTimeout(() => {
      child.kill?.("SIGKILL");
      finish({ kind: "block", policyAction: "timeout", reason: `HOL Guard timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    context.abortSignal?.addEventListener?.("abort", onAbort, { once: true });
    child.stdout?.on?.("data", (chunk) => {
      stdout = boundedAppend(stdout, chunk);
    });
    child.stderr?.on?.("data", (chunk) => {
      stderr = boundedAppend(stderr, chunk);
    });
    child.on?.("error", (error) => {
      finish({ kind: "block", policyAction: "error", reason: `HOL Guard failed: ${String(error)}` });
    });
    child.on?.("close", (code) => {
      finish(classifyGuardResult({ code, stdout, stderr }));
    });

    try {
      child.stdin?.end?.(payload);
    } catch (error) {
      child.kill?.("SIGKILL");
      finish({ kind: "block", policyAction: "error", reason: `HOL Guard input failed: ${String(error)}` });
    }
  });
}
