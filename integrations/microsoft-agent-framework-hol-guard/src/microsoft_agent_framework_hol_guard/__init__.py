from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from enum import Enum
from typing import Any, Protocol

from agent_framework import FunctionInvocationContext, FunctionMiddleware, MiddlewareFailure
from pydantic import BaseModel

_MAX_PAYLOAD_BYTES = 24 * 1024
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


class HolGuardFunctionMiddleware(FunctionMiddleware):
    """Gate Agent Framework function execution with HOL Guard before call_next()."""

    def __init__(self, provider: DecisionProvider | None = None) -> None:
        self._provider = provider or LocalHolGuardProvider()

    async def process(
        self,
        context: FunctionInvocationContext,
        call_next: Callable[[], Awaitable[None]],
    ) -> None:
        function_name = str(getattr(context.function, "name", "") or "").strip()
        if not function_name:
            raise MiddlewareFailure("HOL Guard could not identify the function; execution failed closed")

        try:
            arguments = _json_arguments(context.arguments)
            decision = await self._provider.evaluate(ToolCall(name=function_name, arguments=arguments))
        except MiddlewareFailure:
            raise
        except Exception as exc:
            raise MiddlewareFailure("HOL Guard evaluation failed closed before function execution") from exc

        if decision.action is GuardAction.ALLOW:
            await call_next()
            return
        if decision.action is GuardAction.REVIEW:
            raise MiddlewareFailure("HOL Guard requires approval before function execution")
        if decision.action is GuardAction.DENY:
            raise MiddlewareFailure("HOL Guard denied function execution")
        raise MiddlewareFailure("HOL Guard returned no authoritative decision; execution failed closed")


def _json_arguments(value: BaseModel | Mapping[str, Any]) -> Mapping[str, Any]:
    if isinstance(value, BaseModel):
        data = value.model_dump(mode="json")
    elif isinstance(value, Mapping):
        data = dict(value)
    else:
        raise TypeError("function arguments must be a Pydantic model or mapping")
    encoded = json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(encoded) > _MAX_PAYLOAD_BYTES:
        raise ValueError("HOL Guard payload exceeds 24 KiB adapter limit")
    # Round-trip to guarantee the provider receives JSON-safe data only.
    normalized = json.loads(encoded)
    if not isinstance(normalized, dict):
        raise ValueError("function arguments must encode as a JSON object")
    return normalized


class LocalHolGuardProvider:
    """Local-only CLI decision provider. Guard Cloud credentials are not required."""

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
            "framework": "microsoft-agent-framework",
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
        try:
            stdout, _ = await asyncio.wait_for(process.communicate(encoded), timeout=self._timeout_seconds)
        except TimeoutError:
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
    "HolGuardFunctionMiddleware",
    "LocalHolGuardProvider",
    "ToolCall",
]
