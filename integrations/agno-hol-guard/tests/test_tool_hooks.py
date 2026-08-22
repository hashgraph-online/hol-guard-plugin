from __future__ import annotations

from dataclasses import dataclass

import pytest
from agno.tools.function import Function, FunctionCall, ToolResult

from agno_hol_guard import AsyncHolGuardToolHook, GuardAction, GuardDecision, HolGuardToolHook


@dataclass
class Provider:
    decision: GuardDecision | None = None
    error: Exception | None = None
    seen_name: str | None = None
    seen_arguments: dict | None = None

    def evaluate(self, call):
        self._record(call)
        if self.error:
            raise self.error
        assert self.decision is not None
        return self.decision

    async def aevaluate(self, call):
        self._record(call)
        if self.error:
            raise self.error
        assert self.decision is not None
        return self.decision

    def _record(self, call):
        self.seen_name = call.name
        self.seen_arguments = dict(call.arguments)


def _sync_call(provider: Provider, counter: dict[str, int]):
    def destructive(command: str):
        counter["calls"] += 1
        return f"executed:{command}"

    fn = Function.from_callable(destructive)
    fn.tool_hooks = [HolGuardToolHook(provider)]
    return FunctionCall(function=fn, arguments={"command": "rm -rf /tmp/example"}).execute()


async def _async_call(provider: Provider, counter: dict[str, int]):
    async def destructive(command: str):
        counter["calls"] += 1
        return f"executed:{command}"

    fn = Function.from_callable(destructive)
    fn.tool_hooks = [AsyncHolGuardToolHook(provider)]
    return await FunctionCall(function=fn, arguments={"command": "rm -rf /tmp/example"}).aexecute()


@pytest.mark.parametrize("action", [GuardAction.DENY, GuardAction.REVIEW])
def test_sync_deny_and_review_never_execute_agno_entrypoint(action):
    counter = {"calls": 0}
    provider = Provider(decision=GuardDecision(action))

    result = _sync_call(provider, counter)

    assert result.status == "success"
    assert isinstance(result.result, ToolResult)
    assert result.result.metadata["hol_guard"]["executed"] is False
    assert counter["calls"] == 0
    assert provider.seen_name == "destructive"


@pytest.mark.asyncio
@pytest.mark.parametrize("action", [GuardAction.DENY, GuardAction.REVIEW])
async def test_async_deny_and_review_never_execute_agno_entrypoint(action):
    counter = {"calls": 0}
    provider = Provider(decision=GuardDecision(action))

    result = await _async_call(provider, counter)

    assert result.status == "success"
    assert isinstance(result.result, ToolResult)
    assert result.result.metadata["hol_guard"]["executed"] is False
    assert counter["calls"] == 0


def test_sync_allow_executes_exactly_once():
    counter = {"calls": 0}
    result = _sync_call(Provider(decision=GuardDecision(GuardAction.ALLOW)), counter)

    assert result.status == "success"
    assert result.result == "executed:rm -rf /tmp/example"
    assert counter["calls"] == 1


@pytest.mark.asyncio
async def test_async_allow_executes_exactly_once():
    counter = {"calls": 0}
    result = await _async_call(Provider(decision=GuardDecision(GuardAction.ALLOW)), counter)

    assert result.status == "success"
    assert result.result == "executed:rm -rf /tmp/example"
    assert counter["calls"] == 1


@pytest.mark.parametrize("async_mode", [False, True])
@pytest.mark.asyncio
async def test_provider_failure_fails_closed_without_argument_leakage(async_mode):
    counter = {"calls": 0}
    marker = "sensitive-value-that-must-not-be-returned"
    provider = Provider(error=RuntimeError(f"failure near {marker}"))

    if async_mode:
        async def guarded(opaque_value: str):
            counter["calls"] += 1
            return opaque_value

        fn = Function.from_callable(guarded)
        fn.tool_hooks = [AsyncHolGuardToolHook(provider)]
        result = await FunctionCall(function=fn, arguments={"opaque_value": marker}).aexecute()
    else:
        def guarded(opaque_value: str):
            counter["calls"] += 1
            return opaque_value

        fn = Function.from_callable(guarded)
        fn.tool_hooks = [HolGuardToolHook(provider)]
        result = FunctionCall(function=fn, arguments={"opaque_value": marker}).execute()

    assert result.status == "success"
    assert isinstance(result.result, ToolResult)
    assert marker not in result.result.content
    assert counter["calls"] == 0
