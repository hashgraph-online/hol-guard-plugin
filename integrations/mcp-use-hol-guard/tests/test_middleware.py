from __future__ import annotations

import time

import pytest
from mcp.types import CallToolRequestParams, CallToolResult, TextContent
from mcp_use.middleware import MiddlewareContext, MiddlewareManager

from mcp_use_hol_guard import GuardDecision, MCPUseHOLGuardMiddleware


def _context(arguments=None) -> MiddlewareContext[CallToolRequestParams]:
    return MiddlewareContext(
        id="request-1",
        method="tools/call",
        params=CallToolRequestParams(name="effect", arguments=arguments or {"value": "ok"}),
        connection_id="stdio:test",
        timestamp=time.time(),
    )


async def _run(provider, *, arguments=None):
    calls = {"count": 0}

    async def downstream(_context):
        calls["count"] += 1
        return CallToolResult(content=[TextContent(type="text", text="executed")])

    manager = MiddlewareManager()
    manager._record_telemetry = False
    manager.add_middleware(MCPUseHOLGuardMiddleware(provider))
    response = await manager.process_request(_context(arguments), downstream)
    return response, calls["count"]


@pytest.mark.asyncio
async def test_allow_calls_downstream_exactly_once():
    response, count = await _run(lambda _payload: GuardDecision("allow"))
    assert response.error is None
    assert count == 1
    assert response.result.content[0].text == "executed"


@pytest.mark.asyncio
@pytest.mark.parametrize("decision", ["deny", "review"])
async def test_deny_and_review_never_call_downstream(decision):
    response, count = await _run(lambda _payload: GuardDecision(decision))
    assert response.error is None
    assert count == 0
    assert response.result.isError is True


@pytest.mark.asyncio
async def test_provider_failure_never_calls_downstream_or_leaks_error():
    def provider(_payload):
        raise RuntimeError("secret-argument-marker")

    response, count = await _run(provider)
    assert response.error is None
    assert count == 0
    assert "secret-argument-marker" not in response.result.content[0].text


@pytest.mark.asyncio
async def test_invalid_provider_result_fails_closed():
    response, count = await _run(lambda _payload: None)
    assert response.error is None
    assert count == 0
    assert response.result.isError is True


@pytest.mark.asyncio
async def test_warn_is_not_an_authoritative_allow():
    from mcp_use_hol_guard.middleware import _classify

    assert _classify({"decision": "warn"}) is None


@pytest.mark.asyncio
async def test_oversized_request_fails_before_provider():
    calls = {"count": 0}

    def provider(_payload):
        calls["count"] += 1
        return GuardDecision("allow")

    response, downstream = await _run(provider, arguments={"value": "x" * (25 * 1024)})
    assert calls["count"] == 0
    assert downstream == 0
    assert response.result.isError is True


@pytest.mark.asyncio
async def test_nonserializable_input_fails_before_provider_without_leaking_repr():
    calls = {"count": 0}

    class OpaqueArgument:
        def __repr__(self):
            return "opaque-argument-marker"

    def provider(_payload):
        calls["count"] += 1
        return GuardDecision("allow")

    response, downstream = await _run(provider, arguments={"value": OpaqueArgument()})
    assert calls["count"] == 0
    assert downstream == 0
    assert "opaque-argument-marker" not in response.result.content[0].text
