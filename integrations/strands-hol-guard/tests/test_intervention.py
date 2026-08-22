from __future__ import annotations

from dataclasses import dataclass
from types import SimpleNamespace

import pytest
from strands.interventions import Confirm, Deny, Proceed

from strands_hol_guard import GuardAction, GuardDecision, HolGuardIntervention


@dataclass
class Provider:
    decision: GuardDecision | None = None
    error: Exception | None = None
    seen_name: str | None = None
    seen_arguments: dict | None = None

    async def evaluate(self, call):
        self.seen_name = call.name
        self.seen_arguments = dict(call.arguments)
        if self.error:
            raise self.error
        assert self.decision is not None
        return self.decision


def event(arguments=None, name="destructive"):
    return SimpleNamespace(
        tool_use={
            "name": name,
            "input": arguments if arguments is not None else {"command": "rm -rf /tmp/example"},
            "toolUseId": "tool-1",
        }
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("decision", "expected_type"),
    [
        (GuardDecision(GuardAction.ALLOW), Proceed),
        (GuardDecision(GuardAction.DENY), Deny),
        (GuardDecision(GuardAction.REVIEW), Confirm),
    ],
)
async def test_maps_guard_decision_to_strands_native_action(decision, expected_type):
    provider = Provider(decision=decision)
    handler = HolGuardIntervention(provider)

    action = await handler.before_tool_call(event())

    assert isinstance(action, expected_type)
    assert provider.seen_name == "destructive"
    assert provider.seen_arguments == {"command": "rm -rf /tmp/example"}


@pytest.mark.asyncio
async def test_provider_failure_is_fail_closed_without_argument_leakage():
    secret = "token-super-secret"
    handler = HolGuardIntervention(Provider(error=RuntimeError(f"provider failed near {secret}")))

    action = await handler.before_tool_call(event({"secret": secret}))

    assert isinstance(action, Deny)
    assert secret not in action.reason
    assert handler.on_error == "deny"


@pytest.mark.asyncio
async def test_invalid_and_oversized_inputs_fail_closed():
    handler = HolGuardIntervention(Provider(decision=GuardDecision(GuardAction.ALLOW)))

    assert isinstance(await handler.before_tool_call(event(name="")), Deny)
    assert isinstance(await handler.before_tool_call(event(arguments=["not", "a", "mapping"])), Deny)
    assert isinstance(await handler.before_tool_call(event(arguments={"payload": "x" * (24 * 1024)})), Deny)


@pytest.mark.asyncio
async def test_deny_never_enters_immediate_execution_path():
    handler = HolGuardIntervention(Provider(decision=GuardDecision(GuardAction.DENY)))
    calls = 0

    action = await handler.before_tool_call(event())
    if isinstance(action, Proceed):
        calls += 1

    assert isinstance(action, Deny)
    assert calls == 0


@pytest.mark.asyncio
async def test_allow_is_the_only_action_that_proceeds_immediately():
    handler = HolGuardIntervention(Provider(decision=GuardDecision(GuardAction.ALLOW)))
    calls = 0

    action = await handler.before_tool_call(event())
    if isinstance(action, Proceed):
        calls += 1

    assert calls == 1
