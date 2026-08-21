from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic_ai.exceptions import ApprovalRequired

from pydantic_ai_hol_guard.toolset import (
    GuardDecision,
    HolGuardDenied,
    HolGuardToolset,
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
async def test_review_uses_pydantic_native_approval():
    wrapped = Wrapped()
    toolset = HolGuardToolset(wrapped=wrapped, decision_provider=lambda *args: GuardDecision("review", "confirm"))
    with pytest.raises(ApprovalRequired):
        await toolset.call_tool("write_file", {"path": "a"}, SimpleNamespace(tool_call_approved=False), None)
    assert wrapped.calls == 0
    await toolset.call_tool("write_file", {"path": "a"}, SimpleNamespace(tool_call_approved=True), None)
    assert wrapped.calls == 1


def test_maps_native_hook_decisions():
    assert _classify_guard_payload({"hookSpecificOutput": {"permissionDecision": "allow"}}).action == "allow"
    assert _classify_guard_payload({"hookSpecificOutput": {"permissionDecision": "ask"}}).action == "review"
    assert _classify_guard_payload({"hookSpecificOutput": {"permissionDecision": "deny"}}).action == "deny"


def test_real_guard_never_allows_destructive_shell(tmp_path: Path):
    decision = evaluate_with_hol_guard("bash", {"command": "rm -rf /"}, tmp_path, 10.0, "hol-guard")
    assert decision.action in {"review", "deny"}
