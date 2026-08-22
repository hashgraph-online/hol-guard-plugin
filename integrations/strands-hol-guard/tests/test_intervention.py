from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest
from strands.hooks.events import BeforeToolCallEvent
from strands.interventions import Confirm, Deny, Proceed

from strands_hol_guard import GuardAction, GuardDecision, HolGuardIntervention, _parse_decision

_DEFAULT = object()


@dataclass
class Provider:
    decision: GuardDecision | None = None
    error: Exception | None = None
    seen_name: str | None = None
    seen_arguments: Any = None

    async def evaluate(self, call):
        self.seen_name = call.name
        self.seen_arguments = call.arguments
        if self.error:
            raise self.error
        assert self.decision is not None
        return self.decision


def event(arguments: Any = _DEFAULT, name: str = "destructive") -> BeforeToolCallEvent:
    tool_input = {"command": "rm -rf /tmp/example"} if arguments is _DEFAULT else arguments
    return BeforeToolCallEvent(
        selected_tool=None,
        tool_use={
            "name": name,
            "input": tool_input,
            "toolUseId": "tool-1",
        },
        invocation_state={},
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
    real_event = event()

    action = await handler.before_tool_call(real_event)

    assert isinstance(real_event, BeforeToolCallEvent)
    assert isinstance(action, expected_type)
    assert provider.seen_name == "destructive"
    assert provider.seen_arguments == {"command": "rm -rf /tmp/example"}


@pytest.mark.asyncio
@pytest.mark.parametrize("arguments", ["", 0, [], ["a", "b"], "rm -rf /tmp/example"])
async def test_preserves_json_serializable_non_object_and_falsy_inputs(arguments):
    provider = Provider(decision=GuardDecision(GuardAction.ALLOW))
    action = await HolGuardIntervention(provider).before_tool_call(event(arguments))

    assert isinstance(action, Proceed)
    assert provider.seen_arguments == arguments


@pytest.mark.asyncio
async def test_provider_failure_is_fail_closed_without_argument_leakage():
    marker = "opaque-sensitive-value"
    handler = HolGuardIntervention(Provider(error=RuntimeError(f"provider failed near {marker}")))

    action = await handler.before_tool_call(event({"opaque_value": marker}))

    assert isinstance(action, Deny)
    assert marker not in action.reason
    assert handler.on_error == "deny"


@pytest.mark.asyncio
async def test_invalid_and_oversized_inputs_fail_closed():
    handler = HolGuardIntervention(Provider(decision=GuardDecision(GuardAction.ALLOW)))

    assert isinstance(await handler.before_tool_call(event(name="")), Deny)
    assert isinstance(await handler.before_tool_call(event(arguments={1, 2})), Deny)
    assert isinstance(await handler.before_tool_call(event(arguments={"payload": "x" * (24 * 1024)})), Deny)


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ({"data": {"policyAction": "allow"}}, GuardAction.ALLOW),
        ({"payload": {"result": {"decision": "review"}}}, GuardAction.REVIEW),
        ({"decision": "allow", "data": {"policy_action": "deny"}}, GuardAction.DENY),
        ({"result": {"hookSpecificOutput": {"permissionDecision": "deny"}}}, GuardAction.DENY),
    ],
)
def test_nested_decisions_use_bounded_wrappers_and_deny_precedence(payload, expected):
    decision = _parse_decision(__import__("json").dumps(payload).encode())
    assert decision.action is expected


def test_pretty_printed_multiline_json_decision_is_parsed():
    output = b'{\n  "data": {\n    "policyAction": "allow"\n  }\n}'
    assert _parse_decision(output).action is GuardAction.ALLOW


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
