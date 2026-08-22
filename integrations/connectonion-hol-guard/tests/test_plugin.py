from __future__ import annotations

from types import SimpleNamespace

import pytest

import connectonion_hol_guard as plugin
from connectonion.core.tool_executor import execute_single_tool


class Tools:
    def __init__(self, tool):
        self.tool = tool

    def get(self, name):
        return self.tool if name == "effect" else None


class Logger:
    def log_tool_call(self, *_args, **_kwargs):
        pass

    def log_tool_result(self, *_args, **_kwargs):
        pass

    def print(self, *_args, **_kwargs):
        pass


class Agent:
    def __init__(self):
        self.current_session = {
            "id": "session-1",
            "messages": [],
            "trace": [],
            "iteration": 1,
            "user_prompt": "test",
        }
        self.events = {"before_each_tool": [plugin.hol_guard_before_each_tool]}
        self.io = None
        self.tools = None

    def _record_trace(self, entry):
        self.current_session["trace"].append(entry)

    def _invoke_events(self, event):
        for handler in self.events.get(event, []):
            handler(self)


def run_tool(monkeypatch, *, code=0, stdout='{"decision":"allow"}', error=None):
    executions = {"count": 0}

    def effect(value="ok"):
        executions["count"] += 1
        return value

    def guard_runner(*_args, **_kwargs):
        if error is not None:
            raise error
        return code, stdout

    monkeypatch.setattr(plugin, "_run_guard", guard_runner)
    agent = Agent()
    result = execute_single_tool("effect", {"value": "ok"}, "call-1", Tools(effect), agent, Logger())
    return result, executions["count"]


def test_plugin_uses_native_before_each_tool_event():
    assert plugin.hol_guard_before_each_tool._event_type == "before_each_tool"


def test_allow_executes_underlying_tool_exactly_once(monkeypatch):
    result, count = run_tool(monkeypatch)
    assert count == 1
    assert result["status"] == "success"


@pytest.mark.parametrize(
    ("code", "stdout", "error"),
    [
        (0, '{"decision":"deny"}', None),
        (0, '{"policy_action":"review"}', None),
        (0, "not-json", None),
        (2, '{"decision":"allow"}', None),
        (0, "", RuntimeError("provider unavailable: secret-argument")),
    ],
)
def test_denied_ambiguous_or_unavailable_guard_never_executes_tool(monkeypatch, code, stdout, error):
    result, count = run_tool(monkeypatch, code=code, stdout=stdout, error=error)
    assert count == 0
    assert result["status"] == "error"
    assert "secret-argument" not in str(result["result"])


def test_deny_precedes_nested_allow():
    decision = plugin._classify_guard_decision({"decision": "allow", "data": {"permissionDecision": "deny"}})
    assert decision == "deny"


def test_oversized_request_fails_before_provider(monkeypatch):
    calls = {"count": 0}

    def runner(*_args, **_kwargs):
        calls["count"] += 1
        return 0, '{"decision":"allow"}'

    monkeypatch.setattr(plugin, "_run_guard", runner)
    agent = Agent()
    agent.current_session["pending_tool"] = {"name": "effect", "arguments": {"value": "x" * (25 * 1024)}}
    with pytest.raises(ValueError):
        plugin.evaluate_pending_tool(agent)
    assert calls["count"] == 0
