from __future__ import annotations

import asyncio
import json
import os
import signal
import subprocess
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

from deerflow.guardrails.provider import GuardrailDecision, GuardrailReason, GuardrailRequest

MAX_PAYLOAD_BYTES = 24 * 1024
MAX_CAPTURE_BYTES = 64 * 1024
DEFAULT_TIMEOUT_SECONDS = 5.0
MAX_TIMEOUT_SECONDS = 30.0
_READ_CHUNK_BYTES = 4096

Runner = Callable[[bytes], tuple[int, bytes]]


def _safe_json(value: Any, seen: set[int] | None = None, depth: int = 0) -> Any:
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if value == value and value not in (float("inf"), float("-inf")) else str(value)
    if depth >= 24:
        raise ValueError("tool input exceeds the maximum nesting depth")
    if isinstance(value, (list, tuple)):
        return [_safe_json(item, seen, depth + 1) for item in value]
    if isinstance(value, dict):
        seen = seen or set()
        identity = id(value)
        if identity in seen:
            raise ValueError("tool input contains a circular reference")
        seen.add(identity)
        try:
            return {str(key): _safe_json(item, seen, depth + 1) for key, item in value.items()}
        finally:
            seen.remove(identity)
    return str(value)


def _bounded_payload(request: GuardrailRequest, workspace: Path | None) -> bytes:
    tool_name = str(request.tool_name or "").strip()
    if not tool_name:
        raise ValueError("DeerFlow tool call is missing a tool name")
    payload = {
        "hook_event_name": "PreToolUse",
        "hookEventName": "PreToolUse",
        "tool_name": tool_name,
        "tool_input": _safe_json(request.tool_input or {}),
        "tool_use_id": request.tool_call_id,
        "cwd": str(workspace) if workspace is not None else None,
        "runtime_context": {
            "framework": "deerflow",
            "agent_id": request.agent_id,
            "thread_id": request.thread_id,
            "run_id": request.run_id,
            "user_id": request.user_id,
            "user_role": request.user_role,
            "oauth_provider": request.oauth_provider,
            "oauth_id": request.oauth_id,
            "channel_user_id": request.channel_user_id,
            "is_subagent": request.is_subagent,
            "is_internal": request.is_internal,
            "authz_attributes": _safe_json(request.authz_attributes),
        },
    }
    encoded = json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
    if len(encoded) > MAX_PAYLOAD_BYTES:
        raise ValueError("HOL Guard payload exceeds the bounded DeerFlow limit")
    return encoded


def _parse_object(data: bytes) -> dict[str, Any] | None:
    try:
        value = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _last_json_object(stdout: bytes) -> dict[str, Any] | None:
    stripped = stdout.strip()
    if not stripped:
        return None
    direct = _parse_object(stripped)
    if direct is not None:
        return direct
    for line in reversed(stripped.splitlines()):
        parsed = _parse_object(line.strip())
        if parsed is not None:
            return parsed
    return None


def _normalized(value: Any) -> str | None:
    return value.strip().lower() if isinstance(value, str) and value.strip() else None


def _decision(payload: dict[str, Any]) -> str | None:
    queue = [payload]
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
        hook = layer.get("hookSpecificOutput") if isinstance(layer.get("hookSpecificOutput"), dict) else {}
        decisions = [
            _normalized(hook.get("permissionDecision")),
            _normalized(layer.get("permissionDecision")),
            _normalized(layer.get("decision")),
        ]
        actions = [_normalized(layer.get("policy_action")), _normalized(layer.get("policyAction"))]
        if (
            layer.get("blocked") is True
            or layer.get("continue") is False
            or any(value in {"deny", "block"} for value in decisions)
            or any(value in {"block", "sandbox-required"} for value in actions)
        ):
            deny = True
        if any(value in {"ask", "review"} for value in decisions) or any(
            value in {"review", "require-reapproval"} for value in actions
        ):
            review = True
        if "allow" in decisions or "allow" in actions:
            allow = True
        for key in ("data", "payload", "result"):
            nested = layer.get(key)
            if isinstance(nested, dict):
                queue.append(nested)
    if deny:
        return "deny"
    if review:
        return "review"
    if allow:
        return "allow"
    return None


def _terminate_process_tree(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    pid = process.pid
    if os.name == "nt":
        system_root = os.environ.get("SystemRoot") or os.environ.get("WINDIR")
        if system_root and os.path.isabs(system_root):
            taskkill = os.path.join(system_root, "System32", "taskkill.exe")
            try:
                subprocess.run(
                    [taskkill, "/PID", str(pid), "/T", "/F"],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=1.0,
                    check=False,
                )
            except (OSError, subprocess.TimeoutExpired):
                pass
    else:
        try:
            os.killpg(pid, signal.SIGTERM)
        except (OSError, ProcessLookupError):
            pass
        try:
            process.wait(timeout=0.25)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(pid, signal.SIGKILL)
            except (OSError, ProcessLookupError):
                pass
    try:
        process.kill()
    except OSError:
        pass


def _read_bounded(stream: Any, output: bytearray, overflow: threading.Event, process: subprocess.Popen[bytes]) -> None:
    while True:
        chunk = stream.read(_READ_CHUNK_BYTES)
        if not chunk:
            return
        if len(output) + len(chunk) > MAX_CAPTURE_BYTES:
            overflow.set()
            _terminate_process_tree(process)
            return
        output.extend(chunk)


def _subprocess_runner(
    payload: bytes,
    *,
    executable: str,
    workspace: Path | None,
    timeout_seconds: float,
) -> tuple[int, bytes]:
    command = [executable, "guard", "hook", "--harness", "deerflow"]
    if workspace is not None:
        command.extend(["--workspace", str(workspace.resolve(strict=False))])
    command.append("--json")
    creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    process = subprocess.Popen(
        command,
        cwd=str(workspace) if workspace is not None else None,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=os.name != "nt",
        creationflags=creationflags,
    )
    assert process.stdin is not None and process.stdout is not None and process.stderr is not None
    stdout = bytearray()
    stderr = bytearray()
    overflow = threading.Event()
    readers = [
        threading.Thread(target=_read_bounded, args=(process.stdout, stdout, overflow, process), daemon=True),
        threading.Thread(target=_read_bounded, args=(process.stderr, stderr, overflow, process), daemon=True),
    ]
    for reader in readers:
        reader.start()
    try:
        process.stdin.write(payload)
        process.stdin.close()
    except (BrokenPipeError, OSError):
        _terminate_process_tree(process)
        raise RuntimeError("HOL Guard process rejected the DeerFlow request") from None
    try:
        return_code = process.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        _terminate_process_tree(process)
        raise RuntimeError("HOL Guard review timed out") from None
    finally:
        for reader in readers:
            reader.join(timeout=1.0)
    if overflow.is_set():
        raise RuntimeError("HOL Guard output exceeded the bounded DeerFlow limit")
    return return_code, bytes(stdout)


class HolGuardProvider:
    """DeerFlow GuardrailProvider backed by the local HOL Guard runtime."""

    name = "hol-guard"

    def __init__(
        self,
        *,
        executable: str = "hol-guard",
        workspace: str | Path | None = None,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        runner: Runner | None = None,
        **_: Any,
    ) -> None:
        self.executable = executable
        self.workspace = Path(workspace).expanduser() if workspace is not None else None
        self.timeout_seconds = max(0.25, min(MAX_TIMEOUT_SECONDS, float(timeout_seconds)))
        self._runner = runner

    def _evaluate(self, request: GuardrailRequest) -> GuardrailDecision:
        try:
            payload = _bounded_payload(request, self.workspace)
        except (TypeError, ValueError) as exc:
            raise RuntimeError(str(exc)) from None
        if self._runner is not None:
            return_code, stdout = self._runner(payload)
        else:
            return_code, stdout = _subprocess_runner(
                payload,
                executable=self.executable,
                workspace=self.workspace,
                timeout_seconds=self.timeout_seconds,
            )
        parsed = _last_json_object(stdout)
        if parsed is None:
            raise RuntimeError("HOL Guard returned no parseable DeerFlow decision")
        decision = _decision(parsed)
        if decision is None:
            raise RuntimeError("HOL Guard returned no authoritative DeerFlow decision")
        if decision != "deny" and return_code != 0:
            raise RuntimeError("HOL Guard exited non-zero without an authoritative deny")
        if decision == "allow":
            return GuardrailDecision(
                allow=True,
                reasons=[GuardrailReason(code="hol_guard.allowed", message="HOL Guard allowed this tool call")],
                policy_id="hol-guard.local",
            )
        if decision == "review":
            return GuardrailDecision(
                allow=False,
                reasons=[GuardrailReason(code="hol_guard.review_required", message="HOL Guard requires approval before this tool call")],
                policy_id="hol-guard.local",
            )
        return GuardrailDecision(
            allow=False,
            reasons=[GuardrailReason(code="hol_guard.denied", message="HOL Guard denied this tool call")],
            policy_id="hol-guard.local",
        )

    def evaluate(self, request: GuardrailRequest) -> GuardrailDecision:
        return self._evaluate(request)

    async def aevaluate(self, request: GuardrailRequest) -> GuardrailDecision:
        return await asyncio.to_thread(self._evaluate, request)
