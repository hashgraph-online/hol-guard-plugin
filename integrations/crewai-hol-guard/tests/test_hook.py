from __future__ import annotations

import logging
from types import SimpleNamespace

import pytest
from crewai.hooks.tool_hooks import (
    ToolCallHookContext,
    clear_before_tool_call_hooks,
    get_before_tool_call_hooks,
    run_before_tool_call_hooks,
)

from crewai_hol_guard import (
    GuardDecision,
    HolGuardCrewAIHook,
    HolGuardUnavailable,
    enable_hol_guard,
    evaluate_with_hol_guard,
)


def context(*, task_description: str = "Run a command") -> ToolCallHookContext:
    return ToolCallHookContext(
        tool_name="shell",
        tool_input={"command": "echo sentinel"},
        tool=None,  # type: ignore[arg-type]
        agent=SimpleNamespace(role="operator", verbose=False),  # type: ignore[arg-type]
        task=SimpleNamespace(description=task_description),  # type: ignore[arg-type]
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


def test_provider_failure_fails_closed_with_safe_diagnostic(caplog: pytest.LogCaptureFixture) -> None:
    def broken(*_args):
        raise RuntimeError("provider unavailable")

    caplog.set_level(logging.WARNING, logger="crewai_hol_guard.hook")
    hook = HolGuardCrewAIHook(decision_provider=broken)
    assert hook(context()) is False
    assert "provider unavailable" in caplog.text
    assert "echo sentinel" not in caplog.text


def test_runtime_context_is_bounded() -> None:
    observed = {}

    def capture(tool_name, tool_args, runtime_context, workspace, timeout, executable):
        observed.update(runtime_context)
        return GuardDecision("allow")

    hook = HolGuardCrewAIHook(decision_provider=capture)
    assert hook(context(task_description="x" * 10_000)) is None
    assert len(observed["task_description"]) == 4_096
    assert observed["agent_role"] == "operator"
    assert observed["crew_id"] == "crew-1"


def test_oversized_serialized_payload_fails_closed_before_subprocess(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def should_not_run(*_args, **_kwargs):
        raise AssertionError("subprocess must not run for oversized payloads")

    monkeypatch.setattr("crewai_hol_guard.hook.subprocess.run", should_not_run)
    with pytest.raises(HolGuardUnavailable, match="exceeds 24000 bytes"):
        evaluate_with_hol_guard(
            "shell",
            {"blob": "x" * 25_000},
            {},
            None,
            5.0,
            "hol-guard",
        )


def test_enable_is_idempotent_for_global_hook_registration() -> None:
    clear_before_tool_call_hooks()
    try:
        first = enable_hol_guard(decision_provider=provider(GuardDecision("allow")))
        second = enable_hol_guard(decision_provider=provider(GuardDecision("deny")))
        assert second is first
        assert get_before_tool_call_hooks() == [first]
    finally:
        clear_before_tool_call_hooks()


def test_enable_replace_swaps_existing_hook_once() -> None:
    clear_before_tool_call_hooks()
    try:
        first = enable_hol_guard(decision_provider=provider(GuardDecision("allow")))
        second = enable_hol_guard(
            decision_provider=provider(GuardDecision("deny")), replace=True
        )
        assert second is not first
        assert get_before_tool_call_hooks() == [second]
    finally:
        clear_before_tool_call_hooks()


def test_registered_deny_reaches_crewai_pre_tool_abort_boundary() -> None:
    clear_before_tool_call_hooks()
    try:
        enable_hol_guard(
            decision_provider=provider(GuardDecision("deny", "blocked")), replace=True
        )
        assert run_before_tool_call_hooks(context()) is True
    finally:
        clear_before_tool_call_hooks()
