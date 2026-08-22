from __future__ import annotations

import argparse
import json
import subprocess
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

TOOLHIVE_WEBHOOK_VERSION = "v0.1.0"
MAX_HTTP_BODY_BYTES = 1 << 20
MAX_GUARD_PAYLOAD_BYTES = 24 * 1024
MAX_GUARD_TIMEOUT_SECONDS = 30.0
_SAFE_CONTEXT_KEYS = ("server_name", "backend_server", "namespace", "transport")


@dataclass(frozen=True, slots=True)
class GuardDecision:
    action: str
    reason: str = ""
    raw: dict[str, Any] | None = None


@dataclass(frozen=True, slots=True)
class ToolHiveWebhookResponse:
    version: str
    uid: str
    allowed: bool
    reason: str = ""
    message: str = ""

    def as_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "version": self.version,
            "uid": self.uid,
            "allowed": self.allowed,
        }
        if self.reason:
            payload["reason"] = self.reason
        if self.message:
            payload["message"] = self.message
        return payload


class HolGuardUnavailable(RuntimeError):
    """Raised when HOL Guard cannot produce a bounded unambiguous decision."""


DecisionProvider = Callable[[str, dict[str, Any], dict[str, str], float, str], GuardDecision]


def _last_json_object(stdout: str) -> dict[str, Any] | None:
    candidates = [stdout.strip(), *reversed([line.strip() for line in stdout.splitlines() if line.strip()])]
    for candidate in candidates:
        if not candidate.startswith("{"):
            continue
        try:
            value = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    return None


def _classify_guard_payload(payload: dict[str, Any]) -> GuardDecision:
    if payload.get("blocked") is True or payload.get("continue") is False:
        return GuardDecision("deny", raw=payload)

    policy_action = payload.get("policy_action") or payload.get("policyAction")
    if isinstance(policy_action, str):
        action = policy_action.strip().lower()
        if action in {"allow", "warn"}:
            return GuardDecision("allow", raw=payload)
        if action in {"review", "require-reapproval"}:
            return GuardDecision("review", raw=payload)
        if action in {"block", "sandbox-required"}:
            return GuardDecision("deny", raw=payload)

    decision = payload.get("decision")
    if isinstance(decision, str):
        normalized = decision.strip().lower()
        if normalized in {"allow", "warn"}:
            return GuardDecision("allow", raw=payload)
        if normalized in {"ask", "review"}:
            return GuardDecision("review", raw=payload)
        if normalized in {"deny", "block"}:
            return GuardDecision("deny", raw=payload)

    hook = payload.get("hookSpecificOutput")
    if isinstance(hook, dict):
        permission = hook.get("permissionDecision")
        if isinstance(permission, str):
            normalized = permission.strip().lower()
            if normalized == "allow":
                return GuardDecision("allow", raw=payload)
            if normalized == "ask":
                return GuardDecision("review", raw=payload)
            if normalized == "deny":
                return GuardDecision("deny", raw=payload)

    raise HolGuardUnavailable("HOL Guard returned no unambiguous tool decision")


def _bounded_runtime_context(context: object) -> dict[str, str]:
    if not isinstance(context, Mapping):
        return {}
    result: dict[str, str] = {}
    for key in _SAFE_CONTEXT_KEYS:
        value = context.get(key)
        if isinstance(value, str) and value.strip():
            result[key] = value.strip()[:512]
    return result


def evaluate_with_hol_guard(
    tool_name: str,
    tool_args: dict[str, Any],
    runtime_context: dict[str, str],
    timeout_seconds: float,
    executable: str,
) -> GuardDecision:
    """Evaluate one ToolHive tools/call through HOL Guard's local hook envelope."""

    payload = {
        "hook_event_name": "PreToolUse",
        "tool_name": tool_name,
        "tool_input": tool_args,
        "source_scope": "global",
        "framework": "toolhive",
        "runtime_context": runtime_context,
    }
    try:
        serialized = json.dumps(payload, ensure_ascii=True, separators=(",", ":"))
    except (TypeError, ValueError) as exc:
        raise HolGuardUnavailable("HOL Guard payload is not JSON serializable") from exc

    if len(serialized.encode("utf-8")) > MAX_GUARD_PAYLOAD_BYTES:
        raise HolGuardUnavailable("HOL Guard payload exceeds the bounded adapter limit")

    command = [executable, "guard", "hook", "--harness", "toolhive", "--json"]
    try:
        completed = subprocess.run(
            command,
            input=serialized,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise HolGuardUnavailable("HOL Guard decision process unavailable") from exc

    parsed = _last_json_object(completed.stdout)
    if parsed is None:
        raise HolGuardUnavailable("HOL Guard returned no JSON decision")

    decision = _classify_guard_payload(parsed)
    if decision.action == "allow" and completed.returncode != 0:
        raise HolGuardUnavailable("HOL Guard allow decision exited non-zero")
    return decision


def _deny(uid: str, reason: str, message: str = "Request denied by HOL Guard policy") -> ToolHiveWebhookResponse:
    return ToolHiveWebhookResponse(
        version=TOOLHIVE_WEBHOOK_VERSION,
        uid=uid,
        allowed=False,
        reason=reason,
        message=message,
    )


def evaluate_toolhive_webhook(
    webhook_request: Mapping[str, Any],
    *,
    decision_provider: DecisionProvider = evaluate_with_hol_guard,
    timeout_seconds: float = 5.0,
    executable: str = "hol-guard",
) -> ToolHiveWebhookResponse:
    """Return a ToolHive v0.1.0 validating-webhook response.

    Only MCP ``tools/call`` requests are evaluated. Other MCP methods are
    allowed through unchanged. Malformed tool calls, Guard failures, denies,
    and review-required decisions all fail closed.
    """

    uid_value = webhook_request.get("uid")
    uid = uid_value.strip() if isinstance(uid_value, str) else ""
    version = webhook_request.get("version")
    if version != TOOLHIVE_WEBHOOK_VERSION or not uid:
        return _deny(uid, "invalid_webhook_envelope", "Invalid ToolHive webhook envelope")

    mcp_request = webhook_request.get("mcp_request")
    if isinstance(mcp_request, str):
        try:
            mcp_request = json.loads(mcp_request)
        except json.JSONDecodeError:
            return _deny(uid, "invalid_mcp_request", "Invalid MCP request")
    if not isinstance(mcp_request, Mapping):
        return _deny(uid, "invalid_mcp_request", "Invalid MCP request")

    if mcp_request.get("method") != "tools/call":
        return ToolHiveWebhookResponse(version=TOOLHIVE_WEBHOOK_VERSION, uid=uid, allowed=True)

    params = mcp_request.get("params")
    if not isinstance(params, Mapping):
        return _deny(uid, "invalid_tool_call", "Invalid MCP tool call")
    name = params.get("name")
    arguments = params.get("arguments", {})
    if not isinstance(name, str) or not name.strip() or not isinstance(arguments, dict):
        return _deny(uid, "invalid_tool_call", "Invalid MCP tool call")

    runtime_context = _bounded_runtime_context(webhook_request.get("context"))
    try:
        decision = decision_provider(
            name.strip(),
            arguments,
            runtime_context,
            timeout_seconds,
            executable,
        )
    except Exception:
        return _deny(uid, "hol_guard_unavailable", "HOL Guard decision unavailable")

    if decision.action == "allow":
        return ToolHiveWebhookResponse(version=TOOLHIVE_WEBHOOK_VERSION, uid=uid, allowed=True)
    if decision.action == "review":
        # ToolHive validating webhooks have an allow/deny response, not a
        # suspend/resume approval primitive. Fail closed and let the caller
        # retry only after the review is resolved out of band.
        return _deny(uid, "hol_guard_review_required", "HOL Guard approval required")
    if decision.action == "deny":
        return _deny(uid, "hol_guard_denied")
    return _deny(uid, "hol_guard_unavailable", "HOL Guard decision unavailable")


def _handler_class(
    *,
    decision_provider: DecisionProvider,
    timeout_seconds: float,
    executable: str,
) -> type[BaseHTTPRequestHandler]:
    class ToolHiveHolGuardHandler(BaseHTTPRequestHandler):
        server_version = "toolhive-hol-guard/0.1"

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            # Do not log request bodies or tool arguments. Operators can use
            # ToolHive/Guard receipts for decision observability.
            return

        def _write_json(self, status: int, payload: Mapping[str, Any]) -> None:
            body = json.dumps(dict(payload), ensure_ascii=True, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:  # noqa: N802
            raw_length = self.headers.get("Content-Length")
            try:
                content_length = int(raw_length) if raw_length is not None else -1
            except ValueError:
                content_length = -1
            if content_length < 0 or content_length > MAX_HTTP_BODY_BYTES:
                self._write_json(413, {"error": "request_too_large_or_length_missing"})
                return

            body = self.rfile.read(content_length)
            try:
                request = json.loads(body)
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._write_json(422, {"error": "invalid_webhook_json"})
                return
            if not isinstance(request, dict):
                self._write_json(422, {"error": "invalid_webhook_envelope"})
                return

            response = evaluate_toolhive_webhook(
                request,
                decision_provider=decision_provider,
                timeout_seconds=timeout_seconds,
                executable=executable,
            )
            self._write_json(200, response.as_dict())

    return ToolHiveHolGuardHandler


def serve(
    *,
    host: str = "127.0.0.1",
    port: int = 8787,
    timeout_seconds: float = 5.0,
    executable: str = "hol-guard",
    decision_provider: DecisionProvider = evaluate_with_hol_guard,
) -> None:
    if not 0.0 < timeout_seconds <= MAX_GUARD_TIMEOUT_SECONDS:
        raise ValueError(f"timeout_seconds must be > 0 and <= {MAX_GUARD_TIMEOUT_SECONDS}")
    handler = _handler_class(
        decision_provider=decision_provider,
        timeout_seconds=timeout_seconds,
        executable=executable,
    )
    ThreadingHTTPServer((host, port), handler).serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser(description="HOL Guard validating webhook for ToolHive")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--timeout", type=float, default=5.0)
    parser.add_argument("--hol-guard", default="hol-guard", dest="executable")
    args = parser.parse_args()
    serve(host=args.host, port=args.port, timeout_seconds=args.timeout, executable=args.executable)


if __name__ == "__main__":
    main()
