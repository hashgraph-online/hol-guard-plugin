"""HOL Guard pre-tool policy plugin for ConnectOnion."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

from connectonion.core.events import before_each_tool

MAX_PAYLOAD_BYTES = 24 * 1024
MAX_OUTPUT_BYTES = 64 * 1024
DEFAULT_TIMEOUT_SECONDS = 8.0


def _non_empty(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _object(value: object) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def _parse_guard_output(stdout: str) -> dict[str, Any] | None:
    text = stdout.strip()
    if not text:
        return None
    candidates = [text, *reversed(text.splitlines())]
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except (TypeError, ValueError):
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def _classify_guard_decision(payload: dict[str, Any] | None) -> str | None:
    if payload is None:
        return None
    queue: list[dict[str, Any]] = [payload]
    seen: set[int] = set()
    allow = False
    review = False
    deny = False
    while queue:
        if len(seen) >= 32:
            return None
        layer = queue.pop(0)
        identity = id(layer)
        if identity in seen:
            return None
        seen.add(identity)
        hook = _object(layer.get("hookSpecificOutput")) or {}
        raw_decisions = [hook.get("permissionDecision"), layer.get("permissionDecision"), layer.get("decision")]
        decisions = {_non_empty(value).lower() for value in raw_decisions if _non_empty(value)}
        raw_actions = [layer.get("policy_action"), layer.get("policyAction")]
        actions = {_non_empty(value).lower() for value in raw_actions if _non_empty(value)}
        deny = deny or layer.get("blocked") is True or layer.get("continue") is False or bool(decisions & {"deny", "block"}) or bool(actions & {"block", "sandbox-required"})
        review = review or bool(decisions & {"review", "ask"}) or bool(actions & {"review", "require-reapproval"})
        allow = allow or bool(decisions & {"allow", "warn"}) or bool(actions & {"allow", "warn"})
        for key in ("data", "payload", "result"):
            nested = _object(layer.get(key))
            if nested is not None:
                queue.append(nested)
    if deny:
        return "deny"
    if review:
        return "review"
    if allow:
        return "allow"
    return None


def _run_guard(encoded: str, *, workspace: Path, timeout: float = DEFAULT_TIMEOUT_SECONDS) -> tuple[int, str]:
    command = os.environ.get("HOL_GUARD_BIN", "hol-guard")
    completed = subprocess.run(
        [command, "guard", "hook", "--harness", "generic", "--workspace", str(workspace)],
        input=encoded,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        cwd=workspace,
        shell=False,
        timeout=timeout,
        check=False,
    )
    stdout = completed.stdout or ""
    if len(stdout.encode("utf-8")) > MAX_OUTPUT_BYTES:
        raise RuntimeError("HOL Guard output exceeded limit")
    return completed.returncode, stdout


def _guard_payload(agent: Any, pending: dict[str, Any], workspace: Path) -> dict[str, Any]:
    tool_name = _non_empty(pending.get("name"))
    arguments = _object(pending.get("arguments"))
    if tool_name is None or arguments is None:
        raise ValueError("invalid pending tool")
    session = getattr(agent, "current_session", {})
    return {
        "hook_event_name": "PreToolUse",
        "hookEventName": "PreToolUse",
        "tool_name": tool_name,
        "tool_input": arguments,
        "session_id": _non_empty(session.get("id")) or _non_empty(session.get("session_id")),
        "cwd": str(workspace),
        "runtime_context": {"framework": "connectonion"},
    }


def evaluate_pending_tool(agent: Any, *, workspace: Path | None = None) -> None:
    pending = _object(getattr(agent, "current_session", {}).get("pending_tool"))
    if pending is None:
        raise ValueError("HOL Guard could not validate the pending ConnectOnion tool call")
    effective_workspace = (workspace or Path.cwd()).expanduser().resolve()
    payload = _guard_payload(agent, pending, effective_workspace)
    encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=True)
    if len(encoded.encode("utf-8")) > MAX_PAYLOAD_BYTES:
        raise ValueError("HOL Guard blocked an oversized ConnectOnion tool request")
    try:
        code, stdout = _run_guard(encoded, workspace=effective_workspace)
        decision = _classify_guard_decision(_parse_guard_output(stdout))
    except Exception as exc:
        raise ValueError("HOL Guard is unavailable; ConnectOnion tool execution is blocked") from exc
    if code == 0 and decision == "allow":
        return
    if decision == "review":
        raise ValueError("HOL Guard requires approval; ConnectOnion tool execution is blocked")
    raise ValueError("HOL Guard blocked ConnectOnion tool execution")


@before_each_tool
def hol_guard_before_each_tool(agent: Any) -> None:
    """Evaluate the final pending tool invocation before ConnectOnion executes it."""
    evaluate_pending_tool(agent)


hol_guard = [hol_guard_before_each_tool]

__all__ = ["hol_guard", "hol_guard_before_each_tool", "evaluate_pending_tool"]
