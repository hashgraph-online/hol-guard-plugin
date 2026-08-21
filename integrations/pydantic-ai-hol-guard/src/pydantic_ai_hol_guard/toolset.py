from __future__ import annotations

import asyncio
import json
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic_ai._run_context import AgentDepsT, RunContext
from pydantic_ai.exceptions import ApprovalRequired
from pydantic_ai.toolsets.abstract import ToolsetTool
from pydantic_ai.toolsets.wrapper import WrapperToolset


@dataclass(frozen=True, slots=True)
class GuardDecision:
    action: str
    reason: str = ""
    raw: dict[str, Any] | None = None


class HolGuardDenied(RuntimeError):
    """Raised when HOL Guard denies a Pydantic AI tool call."""


class HolGuardUnavailable(HolGuardDenied):
    """Raised when HOL Guard cannot produce an unambiguous bounded decision."""


DecisionProvider = Callable[[str, dict[str, Any], Path | None, float, str], GuardDecision]


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
    workspace: Path | None,
    timeout_seconds: float,
    executable: str,
) -> GuardDecision:
    """Evaluate one tool call through HOL Guard's generic local hook envelope."""

    payload = {
        "hook_event_name": "PreToolUse",
        "tool_name": tool_name,
        "tool_input": tool_args,
        "source_scope": "project" if workspace is not None else "global",
        "framework": "pydantic-ai",
    }
    command = [executable, "guard", "hook", "--harness", "pydantic-ai"]
    if workspace is not None:
        command.extend(["--workspace", str(workspace.resolve(strict=False))])
    command.append("--json")

    try:
        completed = subprocess.run(
            command,
            input=json.dumps(payload, ensure_ascii=True, separators=(",", ":")),
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
    return _classify_guard_payload(parsed)


@dataclass
class HolGuardToolset(WrapperToolset[AgentDepsT]):
    """Wrap a Pydantic AI toolset and gate every tool call through HOL Guard."""

    workspace: Path | None = None
    timeout_seconds: float = 5.0
    executable: str = "hol-guard"
    decision_provider: DecisionProvider = evaluate_with_hol_guard

    async def call_tool(
        self,
        name: str,
        tool_args: dict[str, Any],
        ctx: RunContext[AgentDepsT],
        tool: ToolsetTool[AgentDepsT],
    ) -> Any:
        decision = await asyncio.to_thread(
            self.decision_provider,
            name,
            tool_args,
            self.workspace,
            self.timeout_seconds,
            self.executable,
        )

        if decision.action == "allow":
            return await super().call_tool(name, tool_args, ctx, tool)

        if decision.action == "review":
            if not ctx.tool_call_approved:
                raise ApprovalRequired
            return await super().call_tool(name, tool_args, ctx, tool)

        if decision.action == "deny":
            raise HolGuardDenied(decision.reason or f"HOL Guard denied tool call: {name}")

        raise HolGuardUnavailable(f"Unsupported HOL Guard decision: {decision.action}")
