from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Mapping
from dataclasses import dataclass
from enum import Enum
from typing import Any, Protocol

from strands.hooks.events import BeforeToolCallEvent
from strands.interventions import Confirm, Deny, InterventionHandler, OnError, Proceed

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
    async def evaluate(self, call: ToolCall) -> GuardDecision: ...


class HolGuardIntervention(InterventionHandler):
    """Gate every Strands tool call through local HOL Guard before execution."""

    name = "hol-guard"

    def __init__(self, provider: DecisionProvider | None = None) -> None:
        self._provider = provider or LocalHolGuardProvider()

    @property
    def on_error(self) -> OnError:
        return "deny"

    async def before_tool_call(self, event: BeforeToolCallEvent, **kwargs: Any) -> Proceed | Deny | Confirm:
        del kwargs
        tool_use = event.tool_use
        tool_name = str(tool_use.get("name") or "").strip()
        if not tool_name:
            return Deny(reason="HOL Guard could not identify the tool; execution failed closed")

        raw_arguments = tool_use.get("input") or {}
        if not isinstance(raw_arguments, Mapping):
            return Deny(reason="HOL Guard could not safely evaluate tool arguments")

        try:
            arguments = _json_arguments(raw_arguments)
            decision = await self._provider.evaluate(ToolCall(name=tool_name, arguments=arguments))
        except Exception:
            return Deny(reason="HOL Guard evaluation failed closed before tool execution")

        if decision.action is GuardAction.ALLOW:
            return Proceed(reason="HOL Guard allowed tool execution")
        if decision.action is GuardAction.REVIEW:
            return Confirm(
                prompt="HOL Guard requires approval before tool execution",
                reason="HOL Guard review required",
            )
        if decision.action is GuardAction.DENY:
            return Deny(reason="HOL Guard denied tool execution")
        return Deny(reason="HOL Guard returned no authoritative decision; execution failed closed")


def _json_arguments(value: Mapping[str, Any]) -> Mapping[str, Any]:
    encoded = json.dumps(dict(value), separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(encoded) > _MAX_PAYLOAD_BYTES:
        raise ValueError("HOL Guard payload exceeds 24 KiB adapter limit")
    normalized = json.loads(encoded)
    if not isinstance(normalized, dict):
        raise ValueError("tool arguments must encode as a JSON object")
    return normalized


class LocalHolGuardProvider:
    """Local CLI decision provider. Guard Cloud credentials are not required."""

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

    async def evaluate(self, call: ToolCall) -> GuardDecision:
        payload: dict[str, Any] = {
            "hook_event_name": "PreToolUse",
            "tool_name": call.name,
            "tool_input": call.arguments,
            "framework": "strands-agents",
            "source_scope": "project" if self._workspace else "global",
        }
        encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        if len(encoded) > _MAX_PAYLOAD_BYTES:
            raise ValueError("HOL Guard payload exceeds 24 KiB adapter limit")

        argv = [self._executable, "guard", "hook", "--harness", "generic"]
        if self._workspace:
            argv.extend(["--workspace", self._workspace])
        argv.append("--json")

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
    "DecisionProvider",
    "GuardAction",
    "GuardDecision",
    "HolGuardIntervention",
    "LocalHolGuardProvider",
    "ToolCall",
]
