from __future__ import annotations

import asyncio
import sys
from collections.abc import Callable

import pytest
from beeai_framework.tools import tool

from beeai_hol_guard import BeeAIHolGuardMiddleware, GuardDecision, LocalHOLGuardProvider
from beeai_hol_guard.middleware import _classify, _communicate_bounded, _parse_json_output


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
    marker = "opaque-value-4938"

    async def provider(_payload):
        raise RuntimeError(f"provider failed with {marker}")

    counter, output = await run_with(provider, marker)
    assert counter["calls"] == 0
    assert marker not in output.get_text_content()


@pytest.mark.asyncio
async def test_invalid_provider_result_fails_closed():
    async def provider(_payload):
        return None

    counter, output = await run_with(provider)
    assert counter["calls"] == 0
    assert output.get_text_content() == "HOL Guard blocked this BeeAI tool call."


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


@pytest.mark.asyncio
async def test_local_provider_rejects_non_serializable_payload_without_spawning_guard():
    provider = LocalHOLGuardProvider(command="command-that-must-not-run")
    decision = await provider({"tool_input": {"value": {1, 2, 3}}})
    assert decision.kind == "deny"


def test_warn_is_not_an_explicit_allow_decision():
    assert _classify({"decision": "warn"}) is None
    decision = _classify({"decision": "allow"})
    assert decision is not None
    assert decision.kind == "allow"


def test_non_utf8_guard_output_is_non_authoritative():
    assert _parse_json_output(b"\xff\xfe") is None


@pytest.mark.asyncio
async def test_guard_stdout_is_bounded_before_full_buffering():
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        "import sys; sys.stdin.buffer.read(); sys.stdout.buffer.write(b'x' * 70000); sys.stdout.buffer.flush()",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    stdout = await asyncio.wait_for(_communicate_bounded(process, b"{}"), timeout=3)
    assert stdout is None
    assert process.returncode is not None
