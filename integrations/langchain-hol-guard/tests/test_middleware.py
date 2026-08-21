from __future__ import annotations

import json
import subprocess
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest

from langchain_hol_guard import (
    GuardDecision,
    HolGuardDenied,
    HolGuardMiddleware,
    HolGuardReviewRequired,
    HolGuardUnavailable,
    evaluate_with_hol_guard,
)


def request(name: str = "shell", args: dict[str, Any] | None = None, call_id: str = "call-1"):
    return cast(
        Any,
        SimpleNamespace(
            tool_call={"name": name, "args": args or {"command": "echo ok"}, "id": call_id},
            runtime=SimpleNamespace(context=None),
        ),
    )


def provider(decision: GuardDecision):
    def _provider(*_args: Any, **_kwargs: Any) -> GuardDecision:
        return decision

    return _provider


def test_allow_invokes_sync_handler_once() -> None:
    calls = 0
    middleware = HolGuardMiddleware(decision_provider=provider(GuardDecision("allow")))

    def handler(req: Any):
        nonlocal calls
        calls += 1
        assert req.tool_call["name"] == "shell"
        return "executed"

    assert middleware.wrap_tool_call(request(), handler) == "executed"
    assert calls == 1


def test_deny_never_invokes_sync_handler() -> None:
    calls = 0
    middleware = HolGuardMiddleware(decision_provider=provider(GuardDecision("deny", "unsafe command")))

    def handler(_req: Any):
        nonlocal calls
        calls += 1
        return "should-not-run"

    with pytest.raises(HolGuardDenied, match="unsafe command"):
        middleware.wrap_tool_call(request(), handler)
    assert calls == 0


def test_review_never_invokes_sync_handler() -> None:
    calls = 0
    middleware = HolGuardMiddleware(
        decision_provider=provider(GuardDecision("review", "approval required"))
    )

    def handler(_req: Any):
        nonlocal calls
        calls += 1
        return "should-not-run"

    with pytest.raises(HolGuardReviewRequired, match="approval required"):
        middleware.wrap_tool_call(request(), handler)
    assert calls == 0


@pytest.mark.asyncio
async def test_allow_invokes_async_handler_once() -> None:
    calls = 0
    middleware = HolGuardMiddleware(decision_provider=provider(GuardDecision("allow")))

    async def handler(_req: Any):
        nonlocal calls
        calls += 1
        return "executed"

    assert await middleware.awrap_tool_call(request(), handler) == "executed"
    assert calls == 1


@pytest.mark.asyncio
async def test_deny_never_invokes_async_handler() -> None:
    calls = 0
    middleware = HolGuardMiddleware(decision_provider=provider(GuardDecision("deny", "blocked")))

    async def handler(_req: Any):
        nonlocal calls
        calls += 1
        return "should-not-run"

    with pytest.raises(HolGuardDenied, match="blocked"):
        await middleware.awrap_tool_call(request(), handler)
    assert calls == 0


def test_unstructured_arguments_fail_closed_before_provider() -> None:
    invoked = False

    def decision_provider(*_args: Any, **_kwargs: Any) -> GuardDecision:
        nonlocal invoked
        invoked = True
        return GuardDecision("allow")

    middleware = HolGuardMiddleware(decision_provider=decision_provider)
    bad_request = cast(
        Any,
        SimpleNamespace(tool_call={"name": "shell", "args": "echo unsafe", "id": "call-2"}),
    )

    with pytest.raises(HolGuardUnavailable, match="not a structured mapping"):
        middleware.wrap_tool_call(bad_request, lambda _req: "should-not-run")
    assert invoked is False


def test_local_runtime_payload_is_bounded_and_framework_scoped(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}

    def fake_run(command: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        captured["command"] = command
        captured["input"] = kwargs["input"]
        captured["timeout"] = kwargs["timeout"]
        return subprocess.CompletedProcess(command, 0, stdout='{"decision":"allow"}\n', stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    workspace = Path("project")
    decision = evaluate_with_hol_guard(
        "write_file",
        {"path": "README.md", "content": "safe"},
        "call-3",
        workspace,
        1.25,
        "hol-guard-test",
    )

    assert decision.action == "allow"
    assert captured["command"][:5] == [
        "hol-guard-test",
        "guard",
        "hook",
        "--harness",
        "langchain",
    ]
    assert captured["command"][-1] == "--json"
    assert captured["timeout"] == 1.25
    payload = json.loads(captured["input"])
    assert payload == {
        "hook_event_name": "PreToolUse",
        "tool_name": "write_file",
        "tool_input": {"path": "README.md", "content": "safe"},
        "source_scope": "project",
        "framework": "langchain",
        "framework_context": {"tool_call_id": "call-3"},
    }
    assert "messages" not in payload
    assert "state" not in payload


def test_nonzero_allow_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_run(command: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(command, 2, stdout='{"decision":"allow"}\n', stderr="boom")

    monkeypatch.setattr(subprocess, "run", fake_run)
    with pytest.raises(HolGuardUnavailable, match="process exited non-zero"):
        evaluate_with_hol_guard("shell", {"command": "echo ok"}, None, None, 1.0, "hol-guard")


def test_ambiguous_runtime_output_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_run(command: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(command, 0, stdout='{"status":"ok"}\n', stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    with pytest.raises(HolGuardUnavailable, match="no unambiguous tool decision"):
        evaluate_with_hol_guard("shell", {"command": "echo ok"}, None, None, 1.0, "hol-guard")
