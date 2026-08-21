from __future__ import annotations

import json
import logging
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from crewai.hooks.tool_hooks import (
    ToolCallHookContext,
    get_before_tool_call_hooks,
    register_before_tool_call_hook,
    unregister_before_tool_call_hook,
)

logger = logging.getLogger(__name__)

MAX_SERIALIZED_PAYLOAD_BYTES = 24_000
MAX_AGENT_ROLE_CHARS = 512
MAX_TASK_DESCRIPTION_CHARS = 4_096
MAX_CREW_ID_CHARS = 512


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

    payload_bytes = len(serialized_payload.encode("utf-8"))
    if payload_bytes > MAX_SERIALIZED_PAYLOAD_BYTES:
        raise HolGuardUnavailable(
            "HOL Guard decision unavailable: serialized CrewAI hook payload "
            f"exceeds {MAX_SERIALIZED_PAYLOAD_BYTES} bytes"
        )

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


def _bounded_string(value: Any, max_chars: int) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    if len(text) > max_chars:
        return text[:max_chars]
    return text


def _bounded_identifier(value: Any, max_chars: int) -> str | None:
    if value is None:
        return None
    if isinstance(value, (str, int)):
        text = str(value).strip()
    else:
        # Crew identifiers are commonly UUID-like objects. Avoid serializing
        # arbitrary rich objects into the security envelope.
        module = type(value).__module__
        if module != "uuid":
            return None
        text = str(value).strip()
    if not text:
        return None
    return text[:max_chars]


def _context_metadata(context: ToolCallHookContext) -> dict[str, Any]:
    agent = getattr(context, "agent", None)
    task = getattr(context, "task", None)
    crew = getattr(context, "crew", None)
    metadata: dict[str, Any] = {}

    agent_role = _bounded_string(getattr(agent, "role", None), MAX_AGENT_ROLE_CHARS)
    if agent_role:
        metadata["agent_role"] = agent_role
    task_description = _bounded_string(
        getattr(task, "description", None), MAX_TASK_DESCRIPTION_CHARS
    )
    if task_description:
        metadata["task_description"] = task_description
    crew_id = _bounded_identifier(getattr(crew, "id", None), MAX_CREW_ID_CHARS) or _bounded_string(
        getattr(crew, "name", None), MAX_CREW_ID_CHARS
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
        except HolGuardUnavailable as exc:
            logger.warning(
                "HOL Guard unavailable; blocking CrewAI tool %r: %s",
                context.tool_name,
                exc,
            )
            return False
        except Exception as exc:
            logger.warning(
                "HOL Guard provider failed; blocking CrewAI tool %r: %s",
                context.tool_name,
                exc,
            )
            logger.debug("HOL Guard provider traceback", exc_info=True)
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
            except Exception as exc:
                logger.warning(
                    "HOL Guard approval handler failed; blocking CrewAI tool %r: %s",
                    context.tool_name,
                    exc,
                )
                logger.debug("HOL Guard approval-handler traceback", exc_info=True)
                return False
        logger.warning(
            "HOL Guard returned unsupported action %r; blocking CrewAI tool %r",
            decision.action,
            context.tool_name,
        )
        return False


_registered_hook: HolGuardCrewAIHook | None = None


def enable_hol_guard(
    *,
    workspace: Path | None = None,
    timeout_seconds: float = 5.0,
    executable: str = "hol-guard",
    decision_provider: DecisionProvider = evaluate_with_hol_guard,
    approval_handler: ApprovalHandler | None = None,
    replace: bool = False,
) -> HolGuardCrewAIHook:
    """Register one global HOL Guard hook for every CrewAI tool call.

    Repeated calls are idempotent while the previously returned hook remains in
    CrewAI's global hook registry. Set ``replace=True`` to intentionally replace
    the current HOL Guard hook with new configuration.
    """

    global _registered_hook

    registered_hooks = get_before_tool_call_hooks()
    if _registered_hook is not None and _registered_hook in registered_hooks:
        if not replace:
            return _registered_hook
        unregister_before_tool_call_hook(_registered_hook)
    elif _registered_hook is not None:
        # The registry may have been cleared by the host application. Do not
        # treat a stale local reference as an active registration.
        _registered_hook = None

    hook = HolGuardCrewAIHook(
        workspace=workspace,
        timeout_seconds=timeout_seconds,
        executable=executable,
        decision_provider=decision_provider,
        approval_handler=approval_handler,
    )
    register_before_tool_call_hook(hook)
    _registered_hook = hook
    return hook
