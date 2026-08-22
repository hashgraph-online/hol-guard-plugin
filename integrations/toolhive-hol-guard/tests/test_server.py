from __future__ import annotations

import json
import subprocess

import pytest

from toolhive_hol_guard.server import (
    GuardDecision,
    HolGuardUnavailable,
    _classify_guard_payload,
    evaluate_toolhive_webhook,
    evaluate_with_hol_guard,
)


def _request(*, method: str = "tools/call", arguments: dict | None = None) -> dict:
    return {
        "version": "v0.1.0",
        "uid": "req-123",
        "principal": {"subject": "should-not-be-forwarded"},
        "mcp_request": {
            "jsonrpc": "2.0",
            "id": 7,
            "method": method,
            "params": {
                "name": "filesystem.write_file",
                "arguments": {"path": "/tmp/example", "content": "secret-value"}
                if arguments is None
                else arguments,
            },
        },
        "context": {
            "server_name": "dev-gateway",
            "backend_server": "filesystem",
            "namespace": "default",
            "source_ip": "203.0.113.10",
            "transport": "stdio",
        },
    }


def test_allow_maps_to_toolhive_allowed_and_forwards_only_safe_context() -> None:
    observed: dict = {}

    def decide(name, args, context, timeout, executable):
        observed.update(
            name=name,
            args=args,
            context=context,
            timeout=timeout,
            executable=executable,
        )
        return GuardDecision("allow")

    response = evaluate_toolhive_webhook(_request(), decision_provider=decide)

    assert response.allowed is True
    assert response.as_dict() == {"version": "v0.1.0", "uid": "req-123", "allowed": True}
    assert observed["name"] == "filesystem.write_file"
    assert observed["args"]["content"] == "secret-value"
    assert observed["context"] == {
        "server_name": "dev-gateway",
        "backend_server": "filesystem",
        "namespace": "default",
        "transport": "stdio",
    }
    assert "source_ip" not in observed["context"]
    assert "principal" not in observed["context"]


def test_deny_returns_allowed_false_without_echoing_tool_arguments() -> None:
    response = evaluate_toolhive_webhook(
        _request(), decision_provider=lambda *_: GuardDecision("deny", reason="raw secret-value")
    )

    payload = response.as_dict()
    assert payload == {
        "version": "v0.1.0",
        "uid": "req-123",
        "allowed": False,
        "reason": "hol_guard_denied",
        "message": "Request denied by HOL Guard policy",
    }
    assert "secret-value" not in json.dumps(payload)


def test_review_fails_closed_on_toolhive_boolean_webhook_contract() -> None:
    response = evaluate_toolhive_webhook(
        _request(), decision_provider=lambda *_: GuardDecision("review", reason="sensitive detail")
    )

    assert response.allowed is False
    assert response.reason == "hol_guard_review_required"
    assert response.message == "HOL Guard approval required"
    assert "sensitive detail" not in json.dumps(response.as_dict())


def test_guard_unavailable_fails_closed_without_leaking_exception_text() -> None:
    def unavailable(*_):
        raise RuntimeError("sensitive backend diagnostic secret-value")

    response = evaluate_toolhive_webhook(_request(), decision_provider=unavailable)

    assert response.allowed is False
    assert response.reason == "hol_guard_unavailable"
    assert "secret-value" not in json.dumps(response.as_dict())


def test_non_tool_methods_do_not_call_guard() -> None:
    def should_not_run(*_):
        raise AssertionError("decision provider must not run for non-tools/call")

    response = evaluate_toolhive_webhook(
        _request(method="resources/read"), decision_provider=should_not_run
    )
    assert response.allowed is True


@pytest.mark.parametrize(
    "request",
    [
        {},
        {"version": "v9", "uid": "x", "mcp_request": {}},
        {"version": "v0.1.0", "uid": "x", "mcp_request": "not-json"},
        {
            "version": "v0.1.0",
            "uid": "x",
            "mcp_request": {"method": "tools/call", "params": {"name": "x", "arguments": []}},
        },
    ],
)
def test_malformed_envelopes_fail_closed(request: dict) -> None:
    response = evaluate_toolhive_webhook(request, decision_provider=lambda *_: GuardDecision("allow"))
    assert response.allowed is False


def test_payload_over_24k_fails_before_subprocess(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("subprocess must not run")),
    )
    with pytest.raises(HolGuardUnavailable, match="bounded adapter limit"):
        evaluate_with_hol_guard(
            "large_tool",
            {"blob": "x" * (25 * 1024)},
            {},
            5.0,
            "hol-guard",
        )


def test_allow_from_nonzero_guard_exit_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    completed = subprocess.CompletedProcess(
        args=["hol-guard"], returncode=2, stdout='{"decision":"allow"}', stderr=""
    )
    monkeypatch.setattr(subprocess, "run", lambda *args, **kwargs: completed)

    with pytest.raises(HolGuardUnavailable, match="allow decision exited non-zero"):
        evaluate_with_hol_guard("tool", {}, {}, 5.0, "hol-guard")


def test_native_deny_payload_shapes_are_preserved() -> None:
    assert _classify_guard_payload({"continue": False}).action == "deny"
    assert _classify_guard_payload({"policyAction": "sandbox-required"}).action == "deny"
    assert _classify_guard_payload({"decision": "review"}).action == "review"
    assert (
        _classify_guard_payload({"hookSpecificOutput": {"permissionDecision": "allow"}}).action
        == "allow"
    )
