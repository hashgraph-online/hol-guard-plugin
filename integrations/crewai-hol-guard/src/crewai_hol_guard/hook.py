from __future__ import annotations

import json
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from crewai.hooks.tool_hooks import ToolCallHookContext, register_before_tool_call_hook


@dataclass(frozen=True, slots=True)
class GuardDecision:
    action: str
    reason: str = ""
    raw: dict[str, Any] | None = None


class HolGuardUnavailable(RuntimeError):
    """HOL Guard could not produce an unambiguous bounded decision."""


DecisionProvider = Callable[
    [str, dict[str, Any], dict[str, Any], Path | None, float, str], GuardDecision
]
ApprovalHandler = Callable[[ToolCallHookContext, GuardDecision], bool]


def _last_json_object(stdout: str) -> dict[str, Any] | None:
    candidates = [
        stdout.strip(),
        *reversed([line.strip() for line in stdout.splitlines() if line.strip()]),
    ]
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
    runtime_context: dict[str, Any],
    workspace: Path | None,
    timeout_seconds: float,
    executable: str,
) -> GuardDecision:
    """Evaluate one CrewAI tool call through HOL Guard's local hook envelope."""

    payload = {
        "hook_event_name": "PreToolUse",
        "tool_name": tool_name,
        "tool_input": tool_args,
        "source_scope": "project" if workspace is not None else "global",
        "framework": "crewai",
        "runtime_context": runtime_context,
    }
    command = [executable, "guard", "hook", "--harness", "crewai"]
    if workspace is not None:
        command.extend(["--workspace", str(workspace.resolve(strict=False))])
    command.append("--json")

    try:
        serialized_payload = json.dumps(payload, ensure_ascii=True, separators=(",", ":"))
    except (TypeError, ValueError) as exc:
        raise HolGuardUnavailable(
            "HOL Guard decision unavailable: CrewAI tool input/context is not JSON serializable"
        ) from exc

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


def _safe_string(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _context_metadata(context: ToolCallHookContext) -> dict[str, Any]:
    agent = getattr(context, "agent", None)
    task = getattr(context, "task", None)
    crew = getattr(context, "crew", None)
    metadata: dict[str, Any] = {}

    agent_role = _safe_string(getattr(agent, "role", None))
    if agent_role:
        metadata["agent_role"] = agent_role
    task_description = _safe_string(getattr(task, "description", None))
    if task_description:
        metadata["task_description"] = task_description
    crew_id = _safe_string(getattr(crew, "id", None)) or _safe_string(
        getattr(crew, "name", None)
    )
    if crew_id:
        metadata["crew_id"] = crew_id
    return metadata


def interactive_approval(context: ToolCallHookContext, decision: GuardDecision) -> bool:
    """CrewAI console approval helper for HOL Guard review decisions."""

    reason = decision.reason or "HOL Guard requires approval before this tool call."
    response = context.request_human_input(
        prompt=reason,
        default_message="Type 'approve' to allow this tool call: ",
    )
    return response.strip().lower() in {"approve", "allow", "yes", "y"}


@dataclass(slots=True)
class HolGuardCrewAIHook:
    """Fail-closed CrewAI before-tool hook backed by local HOL Guard."""

    workspace: Path | None = None
    timeout_seconds: float = 5.0
    executable: str = "hol-guard"
    decision_provider: DecisionProvider = evaluate_with_hol_guard
    approval_handler: ApprovalHandler | None = None

    def __call__(self, context: ToolCallHookContext) -> bool | None:
        try:
            decision = self.decision_provider(
                context.tool_name,
                context.tool_input,
                _context_metadata(context),
                self.workspace,
                self.timeout_seconds,
                self.executable,
            )
        except Exception:
            return False

        if decision.action == "allow":
            return None
        if decision.action == "deny":
            return False
        if decision.action == "review":
            if self.approval_handler is None:
                return False
            try:
                return None if self.approval_handler(context, decision) else False
            except Exception:
                return False
        return False


def enable_hol_guard(
    *,
    workspace: Path | None = None,
    timeout_seconds: float = 5.0,
    executable: str = "hol-guard",
    decision_provider: DecisionProvider = evaluate_with_hol_guard,
    approval_handler: ApprovalHandler | None = None,
) -> HolGuardCrewAIHook:
    """Register HOL Guard globally for every CrewAI tool call in this process."""

    hook = HolGuardCrewAIHook(
        workspace=workspace,
        timeout_seconds=timeout_seconds,
        executable=executable,
        decision_provider=decision_provider,
        approval_handler=approval_handler,
    )
    register_before_tool_call_hook(hook)
    return hook
