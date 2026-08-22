from __future__ import annotations

from collections.abc import Callable

import pytest
from beeai_framework.tools import tool

from beeai_hol_guard import BeeAIHolGuardMiddleware, GuardDecision


def make_tool(counter: dict[str, int]):
    @tool
    async def mutate(value: str) -> str:
        """Record a side effect for the middleware execution contract."""
        counter["calls"] += 1
        return f"ran:{value}"

    return mutate


async def run_with(provider: Callable, value: str = "safe"):
    counter = {"calls": 0}
    target = make_tool(counter)
    output = await target.run({"value": value}).middleware(BeeAIHolGuardMiddleware(provider))
    return counter, output


@pytest.mark.asyncio
async def test_allow_executes_underlying_tool_exactly_once():
    seen = []

    async def provider(payload):
        seen.append(payload)
        return GuardDecision("allow")

    counter, output = await run_with(provider)
    assert counter["calls"] == 1
    assert output.get_text_content() == "ran:safe"
    assert seen[0]["tool_name"] == "mutate"
    assert seen[0]["tool_input"] == {"value": "safe"}
    assert seen[0]["runtime_context"]["framework"] == "beeai"


@pytest.mark.asyncio
@pytest.mark.parametrize("decision", [GuardDecision("deny"), GuardDecision("review")])
async def test_deny_or_review_executes_underlying_tool_zero_times(decision):
    async def provider(_payload):
        return decision

    counter, _output = await run_with(provider)
    assert counter["calls"] == 0


@pytest.mark.asyncio
async def test_provider_failure_executes_underlying_tool_zero_times_without_argument_leakage():
    async def provider(_payload):
        raise RuntimeError("provider failed with secret-value")

    counter, output = await run_with(provider, "secret-value")
    assert counter["calls"] == 0
    assert "secret-value" not in output.get_text_content()


@pytest.mark.asyncio
async def test_oversized_payload_is_blocked_before_provider_call():
    provider_calls = 0

    async def provider(_payload):
        nonlocal provider_calls
        provider_calls += 1
        return GuardDecision("allow")

    counter, _output = await run_with(provider, "x" * (25 * 1024))
    assert counter["calls"] == 0
    assert provider_calls == 0
