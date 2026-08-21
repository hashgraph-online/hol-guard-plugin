from __future__ import annotations

from types import SimpleNamespace

import pytest
from crewai.hooks.tool_hooks import (
    ToolCallHookContext,
    clear_before_tool_call_hooks,
    run_before_tool_call_hooks,
)

from crewai_hol_guard import GuardDecision, HolGuardCrewAIHook, enable_hol_guard


def context() -> ToolCallHookContext:
    return ToolCallHookContext(
        tool_name="shell",
        tool_input={"command": "echo sentinel"},
        tool=None,  # type: ignore[arg-type]
        agent=SimpleNamespace(role="operator", verbose=False),  # type: ignore[arg-type]
        task=SimpleNamespace(description="Run a command"),  # type: ignore[arg-type]
        crew=SimpleNamespace(id="crew-1"),  # type: ignore[arg-type]
    )


def provider(decision: GuardDecision):
    def _provider(tool_name, tool_args, runtime_context, workspace, timeout, executable):
        assert tool_name == "shell"
        assert tool_args == {"command": "echo sentinel"}
        assert runtime_context == {
            "agent_role": "operator",
            "task_description": "Run a command",
            "crew_id": "crew-1",
        }
        return decision

    return _provider


def test_allow_continues() -> None:
    hook = HolGuardCrewAIHook(decision_provider=provider(GuardDecision("allow")))
    assert hook(context()) is None


def test_deny_blocks() -> None:
    hook = HolGuardCrewAIHook(decision_provider=provider(GuardDecision("deny", "blocked")))
    assert hook(context()) is False


def test_review_without_approval_handler_fails_closed() -> None:
    hook = HolGuardCrewAIHook(decision_provider=provider(GuardDecision("review", "confirm")))
    assert hook(context()) is False


def test_review_approval_maps_to_native_continue() -> None:
    hook = HolGuardCrewAIHook(
        decision_provider=provider(GuardDecision("review", "confirm")),
        approval_handler=lambda _context, _decision: True,
    )
    assert hook(context()) is None


def test_provider_failure_fails_closed() -> None:
    def broken(*_args):
        raise RuntimeError("unavailable")

    hook = HolGuardCrewAIHook(decision_provider=broken)
    assert hook(context()) is False


def test_registered_deny_reaches_crewai_pre_tool_abort_boundary() -> None:
    clear_before_tool_call_hooks()
    try:
        enable_hol_guard(decision_provider=provider(GuardDecision("deny", "blocked")))
        assert run_before_tool_call_hooks(context()) is True
    finally:
        clear_before_tool_call_hooks()
