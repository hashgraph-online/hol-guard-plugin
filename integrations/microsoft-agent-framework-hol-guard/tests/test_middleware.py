from __future__ import annotations

from collections.abc import Mapping

import pytest
from agent_framework import FunctionInvocationContext, MiddlewareFailure, tool

from microsoft_agent_framework_hol_guard import (
    GuardAction,
    GuardDecision,
    HolGuardFunctionMiddleware,
    ToolCall,
)


@tool(approval_mode="never_require")
def destructive_probe(path: str) -> str:
    """Contract-test function; the middleware tests never invoke this directly."""
    return path


class Provider:
    def __init__(self, action: GuardAction | None = GuardAction.ALLOW, error: Exception | None = None) -> None:
        self.action = action
        self.error = error
        self.calls: list[ToolCall] = []

    async def evaluate(self, call: ToolCall) -> GuardDecision:
        self.calls.append(call)
        if self.error:
            raise self.error
        assert self.action is not None
        return GuardDecision(self.action)


def context(arguments: Mapping[str, object] | None = None) -> FunctionInvocationContext:
    return FunctionInvocationContext(destructive_probe, arguments or {"path": "/tmp/probe"})


@pytest.mark.asyncio
async def test_deny_never_calls_next() -> None:
    provider = Provider(GuardAction.DENY)
    middleware = HolGuardFunctionMiddleware(provider)
    calls = 0

    async def call_next() -> None:
        nonlocal calls
        calls += 1

    with pytest.raises(MiddlewareFailure):
        await middleware.process(context(), call_next)
    assert calls == 0
    assert provider.calls[0].name == "destructive_probe"
    assert provider.calls[0].arguments == {"path": "/tmp/probe"}


@pytest.mark.asyncio
async def test_review_never_calls_next() -> None:
    middleware = HolGuardFunctionMiddleware(Provider(GuardAction.REVIEW))
    calls = 0

    async def call_next() -> None:
        nonlocal calls
        calls += 1

    with pytest.raises(MiddlewareFailure):
        await middleware.process(context(), call_next)
    assert calls == 0


@pytest.mark.asyncio
async def test_provider_failure_never_calls_next_or_leaks_arguments() -> None:
    middleware = HolGuardFunctionMiddleware(Provider(error=RuntimeError("provider unavailable")))
    calls = 0

    async def call_next() -> None:
        nonlocal calls
        calls += 1

    with pytest.raises(MiddlewareFailure) as exc_info:
        await middleware.process(context({"path": "/very/secret/path"}), call_next)
    assert calls == 0
    assert "/very/secret/path" not in str(exc_info.value)


@pytest.mark.asyncio
async def test_allow_calls_next_exactly_once() -> None:
    middleware = HolGuardFunctionMiddleware(Provider(GuardAction.ALLOW))
    calls = 0

    async def call_next() -> None:
        nonlocal calls
        calls += 1

    await middleware.process(context(), call_next)
    assert calls == 1
