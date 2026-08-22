from __future__ import annotations

import asyncio
import json
import math
import os
import signal
import subprocess
import threading
import time
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
    authz_attributes = getattr(request, "authz_attributes", None)
    payload = {
        "hook_event_name": "PreToolUse",
        "hookEventName": "PreToolUse",
        "tool_name": tool_name,
        "tool_input": _safe_json(request.tool_input or {}),
        "tool_use_id": getattr(request, "tool_call_id", None),
        "cwd": str(workspace) if workspace is not None else None,
        "runtime_context": {
            "framework": "deerflow",
            "agent_id": getattr(request, "agent_id", None),
            "thread_id": getattr(request, "thread_id", None),
            "run_id": getattr(request, "run_id", None),
            "user_id": getattr(request, "user_id", None),
            "user_role": getattr(request, "user_role", None),
            "oauth_provider": getattr(request, "oauth_provider", None),
            "oauth_id": getattr(request, "oauth_id", None),
            "channel_user_id": getattr(request, "channel_user_id", None),
            "is_subagent": bool(getattr(request, "is_subagent", False)),
            "is_internal": bool(getattr(request, "is_internal", False)),
            "authz_attributes": _safe_json(authz_attributes) if authz_attributes is not None else None,
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


def _trusted_windows_taskkill() -> str | None:
    """Resolve taskkill from the Windows API, never from PATH/environment variables."""
    try:
        import ctypes

        buffer = ctypes.create_unicode_buffer(32768)
        length = ctypes.windll.kernel32.GetSystemDirectoryW(buffer, len(buffer))
        if length <= 0 or length >= len(buffer):
            return None
        system_directory = Path(buffer.value)
        if not system_directory.is_absolute():
            return None
        return str(system_directory / "taskkill.exe")
    except (AttributeError, OSError, ValueError):
        return None


def _terminate_process_tree(process: subprocess.Popen[bytes]) -> None:
    pid = process.pid
    if os.name == "nt":
        taskkill = _trusted_windows_taskkill()
        if taskkill is not None:
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
        if process.poll() is None and hasattr(signal, "CTRL_BREAK_EVENT"):
            try:
                process.send_signal(signal.CTRL_BREAK_EVENT)
                process.wait(timeout=0.25)
            except (OSError, subprocess.TimeoutExpired):
                pass
    else:
        try:
            os.killpg(pid, signal.SIGTERM)
        except (OSError, ProcessLookupError):
            pass
        if process.poll() is None:
            try:
                process.wait(timeout=0.25)
            except subprocess.TimeoutExpired:
                pass
        try:
            os.killpg(pid, signal.SIGKILL)
        except (OSError, ProcessLookupError):
            pass
    if process.poll() is None:
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
        command.extend(["--workspace", str(workspace)])
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
    deadline = time.monotonic() + timeout_seconds
    try:
        process.stdin.write(payload)
        process.stdin.close()
    except (BrokenPipeError, OSError):
        _terminate_process_tree(process)
        raise RuntimeError("HOL Guard process rejected the DeerFlow request") from None
    remaining = max(0.0, deadline - time.monotonic())
    try:
        return_code = process.wait(timeout=remaining)
    except subprocess.TimeoutExpired:
        _terminate_process_tree(process)
        raise RuntimeError("HOL Guard review timed out") from None

    for reader in readers:
        remaining = max(0.0, deadline - time.monotonic())
        reader.join(timeout=remaining)
    if any(reader.is_alive() for reader in readers):
        _terminate_process_tree(process)
        for stream in (process.stdout, process.stderr):
            try:
                stream.close()
            except OSError:
                pass
        for reader in readers:
            reader.join(timeout=0.25)
        raise RuntimeError("HOL Guard output did not close within the DeerFlow deadline")
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
        self.workspace = (
            Path(workspace).expanduser().resolve(strict=False) if workspace is not None else None
        )
        try:
            parsed_timeout = float(timeout_seconds)
        except (TypeError, ValueError):
            raise ValueError("timeout_seconds must be a finite number") from None
        if not math.isfinite(parsed_timeout):
            raise ValueError("timeout_seconds must be a finite number")
        self.timeout_seconds = max(0.25, min(MAX_TIMEOUT_SECONDS, parsed_timeout))
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
