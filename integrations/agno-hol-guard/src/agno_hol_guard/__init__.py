from __future__ import annotations

import asyncio
import inspect
import json
import os
import subprocess
import threading
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from enum import Enum
from typing import Any, Protocol

from agno.tools.function import ToolResult

_MAX_PAYLOAD_BYTES = 24 * 1024
_MAX_OUTPUT_BYTES = 64 * 1024
_MAX_TIMEOUT_SECONDS = 10.0


class GuardAction(str, Enum):
    ALLOW = "allow"
    DENY = "deny"
    REVIEW = "review"


@dataclass(frozen=True)
class GuardDecision:
    action: GuardAction


@dataclass(frozen=True)
class ToolCall:
    name: str
    arguments: Mapping[str, Any]


class DecisionProvider(Protocol):
    def evaluate(self, call: ToolCall) -> GuardDecision: ...

    async def aevaluate(self, call: ToolCall) -> GuardDecision: ...


class HolGuardToolHook:
    """Synchronous Agno tool hook. Use with synchronous agent/tool execution."""

    def __init__(self, provider: DecisionProvider | None = None) -> None:
        self._provider = provider or LocalHolGuardProvider()

    def __call__(self, function_name: str, function_call: Callable[..., Any], arguments: dict[str, Any]) -> Any:
        call = _normalize_call(function_name, arguments)
        if isinstance(call, ToolResult):
            return call

        try:
            decision = self._provider.evaluate(call)
        except Exception:
            return _blocked_result("HOL Guard evaluation failed closed before tool execution", "unavailable")

        if decision.action is GuardAction.DENY:
            return _blocked_result("HOL Guard denied tool execution", "deny")
        if decision.action is GuardAction.REVIEW:
            return _blocked_result("HOL Guard requires approval before tool execution", "review")
        if decision.action is not GuardAction.ALLOW:
            return _blocked_result("HOL Guard returned no authoritative decision; execution failed closed", "unavailable")

        result = function_call(**dict(call.arguments))
        if inspect.isawaitable(result):
            close = getattr(result, "close", None)
            if callable(close):
                close()
            raise RuntimeError("HolGuardToolHook cannot execute an async Agno tool; use AsyncHolGuardToolHook")
        return result


class AsyncHolGuardToolHook:
    """Asynchronous Agno tool hook. Use with Agent.arun/aprint_response paths."""

    def __init__(self, provider: DecisionProvider | None = None) -> None:
        self._provider = provider or LocalHolGuardProvider()

    async def __call__(
        self,
        function_name: str,
        function_call: Callable[..., Any],
        arguments: dict[str, Any],
    ) -> Any:
        call = _normalize_call(function_name, arguments)
        if isinstance(call, ToolResult):
            return call

        try:
            decision = await self._provider.aevaluate(call)
        except Exception:
            return _blocked_result("HOL Guard evaluation failed closed before tool execution", "unavailable")

        if decision.action is GuardAction.DENY:
            return _blocked_result("HOL Guard denied tool execution", "deny")
        if decision.action is GuardAction.REVIEW:
            return _blocked_result("HOL Guard requires approval before tool execution", "review")
        if decision.action is not GuardAction.ALLOW:
            return _blocked_result("HOL Guard returned no authoritative decision; execution failed closed", "unavailable")

        result = function_call(**dict(call.arguments))
        return await result if inspect.isawaitable(result) else result


def _normalize_call(function_name: str, arguments: Mapping[str, Any] | Any) -> ToolCall | ToolResult:
    name = str(function_name or "").strip()
    if not name:
        return _blocked_result("HOL Guard could not identify the tool; execution failed closed", "invalid")
    if not isinstance(arguments, Mapping):
        return _blocked_result("HOL Guard could not safely evaluate tool arguments", "invalid")

    try:
        encoded = json.dumps(dict(arguments), separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    except (TypeError, ValueError):
        return _blocked_result("HOL Guard could not safely evaluate tool arguments", "invalid")
    if len(encoded) > _MAX_PAYLOAD_BYTES:
        return _blocked_result("HOL Guard tool arguments exceed the adapter limit", "invalid")

    normalized = json.loads(encoded)
    if not isinstance(normalized, dict):
        return _blocked_result("HOL Guard could not safely evaluate tool arguments", "invalid")
    return ToolCall(name=name, arguments=normalized)


def _blocked_result(message: str, decision: str) -> ToolResult:
    return ToolResult(content=message, metadata={"hol_guard": {"decision": decision, "executed": False}})


class LocalHolGuardProvider:
    """Local-only HOL Guard CLI provider. Guard Cloud credentials are not required."""

    def __init__(
        self,
        *,
        executable: str = "hol-guard",
        workspace: str | None = None,
        timeout_seconds: float = 5.0,
    ) -> None:
        if not executable.strip():
            raise ValueError("executable must not be blank")
        if timeout_seconds <= 0 or timeout_seconds > _MAX_TIMEOUT_SECONDS:
            raise ValueError("timeout_seconds must be > 0 and <= 10")
        self._executable = executable
        self._workspace = os.path.abspath(workspace) if workspace else None
        self._timeout_seconds = timeout_seconds

    def evaluate(self, call: ToolCall) -> GuardDecision:
        encoded, argv = self._command(call)
        stdout, returncode = _run_bounded(argv, encoded, self._timeout_seconds)
        decision = _parse_decision(stdout)
        if decision.action is GuardAction.ALLOW and returncode != 0:
            raise RuntimeError("HOL Guard allow decision exited non-zero")
        return decision

    async def aevaluate(self, call: ToolCall) -> GuardDecision:
        encoded, argv = self._command(call)
        process = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        if process.stdin is None or process.stdout is None:
            process.kill()
            await process.wait()
            raise RuntimeError("HOL Guard decision process streams unavailable")

        async def exchange() -> bytes:
            process.stdin.write(encoded)
            await process.stdin.drain()
            process.stdin.close()
            output = bytearray()
            while True:
                remaining = _MAX_OUTPUT_BYTES + 1 - len(output)
                if remaining <= 0:
                    process.kill()
                    await process.wait()
                    raise RuntimeError("HOL Guard decision output exceeded adapter limit")
                chunk = await process.stdout.read(min(8192, remaining))
                if not chunk:
                    break
                output.extend(chunk)
                if len(output) > _MAX_OUTPUT_BYTES:
                    process.kill()
                    await process.wait()
                    raise RuntimeError("HOL Guard decision output exceeded adapter limit")
            await process.wait()
            return bytes(output)

        try:
            stdout = await asyncio.wait_for(exchange(), timeout=self._timeout_seconds)
        except TimeoutError:
            if process.returncode is None:
                process.kill()
                await process.wait()
            raise RuntimeError("HOL Guard decision timed out") from None

        decision = _parse_decision(stdout)
        if decision.action is GuardAction.ALLOW and process.returncode != 0:
            raise RuntimeError("HOL Guard allow decision exited non-zero")
        return decision

    def _command(self, call: ToolCall) -> tuple[bytes, list[str]]:
        payload: dict[str, Any] = {
            "hook_event_name": "PreToolUse",
            "tool_name": call.name,
            "tool_input": call.arguments,
            "framework": "agno",
            "source_scope": "project" if self._workspace else "global",
        }
        encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        if len(encoded) > _MAX_PAYLOAD_BYTES:
            raise ValueError("HOL Guard payload exceeds 24 KiB adapter limit")

        argv = [self._executable, "guard", "hook", "--harness", "generic"]
        if self._workspace:
            argv.extend(["--workspace", self._workspace])
        argv.append("--json")
        return encoded, argv


def _run_bounded(argv: list[str], encoded: bytes, timeout_seconds: float) -> tuple[bytes, int]:
    process = subprocess.Popen(
        argv,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    if process.stdin is None or process.stdout is None:
        process.kill()
        process.wait()
        raise RuntimeError("HOL Guard decision process streams unavailable")

    output = bytearray()
    overflow = threading.Event()

    def read_stdout() -> None:
        while True:
            chunk = process.stdout.read(8192)
            if not chunk:
                return
            output.extend(chunk)
            if len(output) > _MAX_OUTPUT_BYTES:
                overflow.set()
                try:
                    process.kill()
                except OSError:
                    pass
                return

    reader = threading.Thread(target=read_stdout, name="hol-guard-agno-stdout", daemon=True)
    reader.start()
    try:
        process.stdin.write(encoded)
        process.stdin.close()
        returncode = process.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
        raise RuntimeError("HOL Guard decision timed out") from None
    finally:
        reader.join(timeout=1.0)

    if reader.is_alive():
        process.kill()
        process.wait()
        raise RuntimeError("HOL Guard decision output reader did not terminate")
    if overflow.is_set() or len(output) > _MAX_OUTPUT_BYTES:
        raise RuntimeError("HOL Guard decision output exceeded adapter limit")
    return bytes(output), returncode


def _parse_decision(output: bytes) -> GuardDecision:
    for raw_line in reversed(output.splitlines()):
        line = raw_line.strip()
        if not line.startswith(b"{"):
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, dict):
            continue
        decision = _classify_payload(payload)
        if decision is not None:
            return decision
    raise RuntimeError("HOL Guard returned no authoritative decision")


def _classify_payload(payload: Mapping[str, Any]) -> GuardDecision | None:
    if payload.get("blocked") is True or payload.get("continue") is False:
        return GuardDecision(GuardAction.DENY)

    candidates: list[Any] = [
        payload.get("policy_action"),
        payload.get("policyAction"),
        payload.get("decision"),
        payload.get("permissionDecision"),
    ]
    hook = payload.get("hookSpecificOutput")
    if isinstance(hook, Mapping):
        candidates.append(hook.get("permissionDecision"))

    normalized = {str(value).strip().lower() for value in candidates if isinstance(value, str)}
    if normalized & {"deny", "block", "sandbox-required"}:
        return GuardDecision(GuardAction.DENY)
    if normalized & {"ask", "review", "require-reapproval"}:
        return GuardDecision(GuardAction.REVIEW)
    if normalized & {"allow", "warn"}:
        return GuardDecision(GuardAction.ALLOW)
    return None


__all__ = [
    "AsyncHolGuardToolHook",
    "DecisionProvider",
    "GuardAction",
    "GuardDecision",
    "HolGuardToolHook",
    "LocalHolGuardProvider",
    "ToolCall",
]
