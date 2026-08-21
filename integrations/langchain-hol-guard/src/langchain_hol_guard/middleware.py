from __future__ import annotations

import asyncio
import json
import subprocess
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from langchain.agents.middleware import AgentMiddleware, ToolCallRequest
from langchain_core.messages import ToolMessage
from langgraph.types import Command


@dataclass(frozen=True, slots=True)
class GuardDecision:
    action: str
    reason: str = ""
    raw: dict[str, Any] | None = None


class HolGuardDenied(RuntimeError):
    """Raised when HOL Guard denies a LangChain tool call."""


class HolGuardReviewRequired(HolGuardDenied):
    """Raised when HOL Guard requires explicit approval before execution."""


class HolGuardUnavailable(HolGuardDenied):
    """Raised when HOL Guard cannot produce an unambiguous bounded decision."""


DecisionProvider = Callable[[str, dict[str, Any], str | None, Path | None, float, str], GuardDecision]
SyncHandler = Callable[[ToolCallRequest], ToolMessage | Command[Any]]
AsyncHandler = Callable[[ToolCallRequest], Awaitable[ToolMessage | Command[Any]]]


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


def _reason(payload: dict[str, Any]) -> str:
    for key in ("reason", "stopReason", "review_hint", "systemMessage", "message", "error"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    hook = payload.get("hookSpecificOutput")
    if isinstance(hook, dict):
        value = hook.get("permissionDecisionReason") or hook.get("additionalContext")
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _classify_guard_payload(payload: dict[str, Any]) -> GuardDecision:
    reason = _reason(payload)
    if payload.get("blocked") is True or payload.get("continue") is False:
        return GuardDecision("deny", reason, payload)

    policy_action = payload.get("policy_action") or payload.get("policyAction")
    if isinstance(policy_action, str):
        action = policy_action.strip().lower()
        if action in {"allow", "warn"}:
            return GuardDecision("allow", reason, payload)
        if action in {"review", "require-reapproval"}:
            return GuardDecision("review", reason, payload)
        if action in {"block", "sandbox-required"}:
            return GuardDecision("deny", reason, payload)

    decision = payload.get("decision")
    if isinstance(decision, str):
        normalized = decision.strip().lower()
        if normalized in {"allow", "warn"}:
            return GuardDecision("allow", reason, payload)
        if normalized in {"ask", "review"}:
            return GuardDecision("review", reason, payload)
        if normalized in {"deny", "block"}:
            return GuardDecision("deny", reason, payload)

    hook = payload.get("hookSpecificOutput")
    if isinstance(hook, dict):
        permission = hook.get("permissionDecision")
        if isinstance(permission, str):
            normalized = permission.strip().lower()
            if normalized == "allow":
                return GuardDecision("allow", reason, payload)
            if normalized == "ask":
                return GuardDecision("review", reason, payload)
            if normalized == "deny":
                return GuardDecision("deny", reason, payload)

    raise HolGuardUnavailable("HOL Guard returned no unambiguous tool decision")


def evaluate_with_hol_guard(
    tool_name: str,
    tool_args: dict[str, Any],
    tool_call_id: str | None,
    workspace: Path | None,
    timeout_seconds: float,
    executable: str,
) -> GuardDecision:
    """Evaluate one LangChain tool call through HOL Guard's local hook envelope."""

    payload: dict[str, Any] = {
        "hook_event_name": "PreToolUse",
        "tool_name": tool_name,
        "tool_input": tool_args,
        "source_scope": "project" if workspace is not None else "global",
        "framework": "langchain",
    }
    if tool_call_id:
        payload["framework_context"] = {"tool_call_id": tool_call_id}

    command = [executable, "guard", "hook", "--harness", "langchain"]
    if workspace is not None:
        command.extend(["--workspace", str(workspace.resolve(strict=False))])
    command.append("--json")

    try:
        serialized_payload = json.dumps(payload, ensure_ascii=True, separators=(",", ":"))
    except (TypeError, ValueError) as exc:
        raise HolGuardUnavailable("HOL Guard decision unavailable: tool arguments are not JSON serializable") from exc

    try:
        completed = subprocess.run(
            command,
            input=serialized_payload,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise HolGuardUnavailable(f"HOL Guard decision unavailable: {exc}") from exc

    parsed = _last_json_object(completed.stdout)
    if parsed is None:
        detail = completed.stderr.strip() or f"exit status {completed.returncode}"
        raise HolGuardUnavailable(f"HOL Guard decision unavailable: {detail}")

    decision = _classify_guard_payload(parsed)
    if decision.action == "allow" and completed.returncode != 0:
        detail = completed.stderr.strip() or f"exit status {completed.returncode}"
        raise HolGuardUnavailable(
            f"HOL Guard allow decision rejected because the process exited non-zero: {detail}"
        )
    return decision


def _tool_call_parts(request: ToolCallRequest) -> tuple[str, dict[str, Any], str | None]:
    tool_call = request.tool_call
    if not isinstance(tool_call, dict):
        raise HolGuardUnavailable("LangChain tool call is not a structured mapping")

    name = tool_call.get("name")
    if not isinstance(name, str) or not name.strip():
        raise HolGuardUnavailable("LangChain tool call has no valid tool name")

    args = tool_call.get("args", {})
    if not isinstance(args, dict):
        raise HolGuardUnavailable("LangChain tool arguments are not a structured mapping")

    raw_id = tool_call.get("id")
    tool_call_id = raw_id if isinstance(raw_id, str) and raw_id else None
    return name, args, tool_call_id


@dataclass
class HolGuardMiddleware(AgentMiddleware):
    """Gate every LangChain agent tool call through HOL Guard before execution."""

    workspace: Path | None = None
    timeout_seconds: float = 5.0
    executable: str = "hol-guard"
    decision_provider: DecisionProvider = evaluate_with_hol_guard

    def _decision(self, request: ToolCallRequest) -> GuardDecision:
        name, args, tool_call_id = _tool_call_parts(request)
        return self.decision_provider(
            name,
            args,
            tool_call_id,
            self.workspace,
            self.timeout_seconds,
            self.executable,
        )

    @staticmethod
    def _enforce_before_handler(decision: GuardDecision, tool_name: str) -> None:
        if decision.action == "allow":
            return
        if decision.action == "review":
            raise HolGuardReviewRequired(
                decision.reason or f"HOL Guard requires approval before tool call: {tool_name}"
            )
        if decision.action == "deny":
            raise HolGuardDenied(decision.reason or f"HOL Guard denied tool call: {tool_name}")
        raise HolGuardUnavailable(f"Unsupported HOL Guard decision: {decision.action}")

    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: SyncHandler,
    ) -> ToolMessage | Command[Any]:
        name, _, _ = _tool_call_parts(request)
        decision = self._decision(request)
        self._enforce_before_handler(decision, name)
        return handler(request)

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: AsyncHandler,
    ) -> ToolMessage | Command[Any]:
        name, args, tool_call_id = _tool_call_parts(request)
        decision = await asyncio.to_thread(
            self.decision_provider,
            name,
            args,
            tool_call_id,
            self.workspace,
            self.timeout_seconds,
            self.executable,
        )
        self._enforce_before_handler(decision, name)
        return await handler(request)
