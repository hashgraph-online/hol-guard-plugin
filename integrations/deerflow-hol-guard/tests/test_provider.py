from __future__ import annotations

import asyncio
import json
from unittest.mock import MagicMock

import pytest

from deerflow.guardrails.middleware import GuardrailMiddleware
from deerflow.guardrails.provider import GuardrailRequest
from deerflow_hol_guard import HolGuardProvider


class _FakeRuntime:
    def __init__(self):
        self.context = {"thread_id": "thread-1", "run_id": "run-1", "user_role": "developer"}


def _request(name: str = "bash", args: dict | None = None):
    request = MagicMock()
    request.tool_call = {"name": name, "args": args or {"command": "echo safe"}, "id": "call-1"}
    request.runtime = _FakeRuntime()
    return request


def _runner(payload: dict, *, return_code: int = 0):
    def run(encoded: bytes):
        decoded = json.loads(encoded)
        assert decoded["tool_name"] == "bash"
        assert decoded["runtime_context"]["framework"] == "deerflow"
        return return_code, json.dumps(payload).encode()

    return run


def test_allow_executes_sync_handler_once():
    provider = HolGuardProvider(runner=_runner({"decision": "allow"}))
    middleware = GuardrailMiddleware(provider)
    request = _request()
    expected = MagicMock()
    handler = MagicMock(return_value=expected)

    result = middleware.wrap_tool_call(request, handler)

    assert result is expected
    handler.assert_called_once_with(request)


@pytest.mark.parametrize("payload", [
    {"decision": "deny"},
    {"decision": "review"},
    {"decision": "ask"},
    {"policy_action": "block"},
    {"decision": "allow", "result": {"policy_action": "block"}},
])
def test_non_allow_executes_zero_sync_handlers(payload):
    provider = HolGuardProvider(runner=_runner(payload))
    middleware = GuardrailMiddleware(provider)
    request = _request()
    handler = MagicMock()

    result = middleware.wrap_tool_call(request, handler)

    handler.assert_not_called()
    assert result.status == "error"


def test_provider_failure_fails_closed_in_deerflow_default_middleware():
    def broken(_: bytes):
        raise RuntimeError("secret argument should not escape")

    provider = HolGuardProvider(runner=broken)
    middleware = GuardrailMiddleware(provider)
    request = _request(args={"token": "super-secret"})
    handler = MagicMock()

    result = middleware.wrap_tool_call(request, handler)

    handler.assert_not_called()
    assert result.status == "error"
    assert "super-secret" not in result.content


def test_malformed_decision_fails_closed():
    provider = HolGuardProvider(runner=lambda _: (0, b"not-json"))
    middleware = GuardrailMiddleware(provider)
    handler = MagicMock()

    result = middleware.wrap_tool_call(_request(), handler)

    handler.assert_not_called()
    assert result.status == "error"


def test_nonzero_allow_fails_closed():
    provider = HolGuardProvider(runner=_runner({"decision": "allow"}, return_code=1))
    middleware = GuardrailMiddleware(provider)
    handler = MagicMock()

    result = middleware.wrap_tool_call(_request(), handler)

    handler.assert_not_called()
    assert result.status == "error"


def test_oversized_input_never_reaches_provider_runner():
    calls = 0

    def run(_: bytes):
        nonlocal calls
        calls += 1
        return 0, b'{"decision":"allow"}'

    provider = HolGuardProvider(runner=run)
    middleware = GuardrailMiddleware(provider)
    handler = MagicMock()

    result = middleware.wrap_tool_call(_request(args={"content": "x" * (30 * 1024)}), handler)

    assert calls == 0
    handler.assert_not_called()
    assert result.status == "error"


def test_async_allow_executes_handler_once():
    provider = HolGuardProvider(runner=_runner({"decision": "allow"}))
    middleware = GuardrailMiddleware(provider)
    request = _request()
    calls = 0

    async def handler(_):
        nonlocal calls
        calls += 1
        return "ok"

    result = asyncio.run(middleware.awrap_tool_call(request, handler))

    assert result == "ok"
    assert calls == 1


def test_async_deny_executes_zero_handlers():
    provider = HolGuardProvider(runner=_runner({"decision": "deny"}))
    middleware = GuardrailMiddleware(provider)
    request = _request()
    calls = 0

    async def handler(_):
        nonlocal calls
        calls += 1
        return "unexpected"

    result = asyncio.run(middleware.awrap_tool_call(request, handler))

    assert calls == 0
    assert result.status == "error"


def test_provider_satisfies_deerflow_structural_protocol():
    from deerflow.guardrails.provider import GuardrailProvider

    assert isinstance(HolGuardProvider(runner=_runner({"decision": "allow"})), GuardrailProvider)


def test_class_path_import_is_stable():
    module = __import__("deerflow_hol_guard", fromlist=["HolGuardProvider"])
    assert module.HolGuardProvider is HolGuardProvider


def test_payload_uses_bounded_context_without_raw_failure_leaks():
    request = GuardrailRequest(tool_name="bash", tool_input={"token": "sensitive"})
    captured = {}

    def run(encoded: bytes):
        captured.update(json.loads(encoded))
        return 0, b'{"decision":"deny"}'

    decision = HolGuardProvider(runner=run).evaluate(request)
    assert decision.allow is False
    assert captured["tool_name"] == "bash"
    assert captured["tool_input"] == {"token": "sensitive"}
    assert "sensitive" not in decision.reasons[0].message
