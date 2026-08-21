import os
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic_ai import ApprovalRequired

import pydantic_ai_hol_guard.toolset as toolset_module
from pydantic_ai_hol_guard.toolset import (
    GuardDecision,
    HolGuardDenied,
    HolGuardToolset,
    HolGuardUnavailable,
    _classify_guard_payload,
    evaluate_with_hol_guard,
)


class Wrapped:
    def __init__(self):
        self.calls = 0

    async def call_tool(self, name, tool_args, ctx, tool):
        self.calls += 1
        return {"name": name, "args": tool_args}


@pytest.mark.asyncio
async def test_allow_executes_once():
    wrapped = Wrapped()
    toolset = HolGuardToolset(wrapped=wrapped, decision_provider=lambda *args: GuardDecision("allow"))
    result = await toolset.call_tool("read_file", {"path": "README.md"}, SimpleNamespace(tool_call_approved=False), None)
    assert result["name"] == "read_file"
    assert wrapped.calls == 1


@pytest.mark.asyncio
async def test_deny_never_executes():
    wrapped = Wrapped()
    toolset = HolGuardToolset(wrapped=wrapped, decision_provider=lambda *args: GuardDecision("deny", "blocked"))
    with pytest.raises(HolGuardDenied, match="blocked"):
        await toolset.call_tool("bash", {"command": "rm -rf /"}, SimpleNamespace(tool_call_approved=False), None)
    assert wrapped.calls == 0


@pytest.mark.asyncio
async def test_review_uses_pydantic_native_approval_and_preserves_reason():
    wrapped = Wrapped()
    toolset = HolGuardToolset(wrapped=wrapped, decision_provider=lambda *args: GuardDecision("review", "confirm deletion"))
    with pytest.raises(ApprovalRequired) as exc_info:
        await toolset.call_tool("write_file", {"path": "a"}, SimpleNamespace(tool_call_approved=False), None)
    assert exc_info.value.metadata == {"hol_guard_reason": "confirm deletion"}
    assert wrapped.calls == 0
    await toolset.call_tool("write_file", {"path": "a"}, SimpleNamespace(tool_call_approved=True), None)
    assert wrapped.calls == 1


def test_maps_native_hook_decisions():
    assert _classify_guard_payload({"hookSpecificOutput": {"permissionDecision": "allow"}}).action == "allow"
    assert _classify_guard_payload({"hookSpecificOutput": {"permissionDecision": "ask"}}).action == "review"
    assert _classify_guard_payload({"hookSpecificOutput": {"permissionDecision": "deny"}}).action == "deny"


def test_non_json_serializable_tool_args_fail_closed():
    with pytest.raises(HolGuardUnavailable, match="not JSON serializable"):
        evaluate_with_hol_guard("custom", {"value": object()}, None, 1.0, "hol-guard")


def test_nonzero_allow_fails_closed(monkeypatch):
    def fake_run(*args, **kwargs):
        return SimpleNamespace(stdout='{"decision":"allow"}', stderr="guard failed", returncode=1)

    monkeypatch.setattr(toolset_module.subprocess, "run", fake_run)
    with pytest.raises(HolGuardUnavailable, match="exited non-zero"):
        evaluate_with_hol_guard("read_file", {"path": "README.md"}, None, 1.0, "hol-guard")


def test_nonzero_deny_remains_authoritative(monkeypatch):
    def fake_run(*args, **kwargs):
        return SimpleNamespace(stdout='{"decision":"deny","reason":"blocked"}', stderr="policy denied", returncode=1)

    monkeypatch.setattr(toolset_module.subprocess, "run", fake_run)
    decision = evaluate_with_hol_guard("bash", {"command": "rm -rf /"}, None, 1.0, "hol-guard")
    assert decision.action == "deny"
    assert decision.reason == "blocked"


@pytest.mark.skipif(
    os.environ.get("HOL_GUARD_INTEGRATION_TESTS") != "1",
    reason="requires an explicitly configured local HOL Guard runtime",
)
def test_real_guard_never_allows_destructive_shell(tmp_path: Path):
    decision = evaluate_with_hol_guard("bash", {"command": "rm -rf /"}, tmp_path, 10.0, "hol-guard")
    assert decision.action in {"review", "deny"}
