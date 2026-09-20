import json
import os
import stat
import subprocess
from types import SimpleNamespace

import pytest
from bub.hooks.interception import ToolCall

from bub_hol_guard import plugin


def _call(tool: str = "bash", **arguments: object) -> ToolCall:
    return ToolCall(run_id="run", tool=tool, arguments=dict(arguments))


def _completed(payload: object, returncode: int = 0) -> SimpleNamespace:
    return SimpleNamespace(returncode=returncode, stdout=json.dumps(payload), stderr="")


@pytest.fixture
def trusted_guard(monkeypatch):
    monkeypatch.setattr(plugin, "_resolve_guard_executable", lambda: "/usr/bin/hol-guard")
    monkeypatch.setattr(plugin, "_guard_environment", lambda: {"PATH": "/usr/bin:/bin"})


def test_non_bash_skips_guard(monkeypatch) -> None:
    def fail(*args, **kwargs):
        raise AssertionError

    monkeypatch.setattr(plugin.subprocess, "run", fail)
    assert plugin.before_tool_call(_call("read_file", path="x"), {}) is None


def test_explicit_allow_proceeds(monkeypatch, trusted_guard) -> None:
    monkeypatch.setattr(
        plugin.subprocess,
        "run",
        lambda *args, **kwargs: _completed(
            {"classification": {"explicitly_benign": True}, "minimum_action": "allow"}
        ),
    )
    assert plugin.before_tool_call(_call(cmd="git status"), {}) is None


def test_review_denies(monkeypatch, trusted_guard) -> None:
    monkeypatch.setattr(
        plugin.subprocess,
        "run",
        lambda *args, **kwargs: _completed(
            {"classification": {"explicitly_benign": False}, "minimum_action": "review"}
        ),
    )
    decision = plugin.before_tool_call(_call(cmd="rm -rf build"), {})
    assert decision is not None
    assert decision.action == "deny"
    assert decision.message == "HOL_GUARD_DENY"


def test_implicit_allow_denies(monkeypatch, trusted_guard) -> None:
    monkeypatch.setattr(
        plugin.subprocess,
        "run",
        lambda *args, **kwargs: _completed(
            {"classification": {}, "minimum_action": "allow"}
        ),
    )
    decision = plugin.before_tool_call(_call(cmd="git status"), {})
    assert decision is not None
    assert decision.action == "deny"


def test_malformed_output_denies(monkeypatch, trusted_guard) -> None:
    monkeypatch.setattr(
        plugin.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout="not-json", stderr=""),
    )
    decision = plugin.before_tool_call(_call(cmd="git status"), {})
    assert decision is not None
    assert decision.message == "HOL_GUARD_INVALID_OUTPUT"


def test_nonzero_exit_denies(monkeypatch, trusted_guard) -> None:
    monkeypatch.setattr(
        plugin.subprocess,
        "run",
        lambda *args, **kwargs: _completed({}, returncode=2),
    )
    decision = plugin.before_tool_call(_call(cmd="git status"), {})
    assert decision is not None
    assert decision.message == "HOL_GUARD_ERROR"


def test_missing_guard_denies(monkeypatch) -> None:
    monkeypatch.setattr(plugin, "_resolve_guard_executable", lambda: None)
    decision = plugin.before_tool_call(_call(cmd="git status"), {})
    assert decision is not None
    assert decision.message == "HOL_GUARD_UNAVAILABLE"


def test_disappearing_guard_denies(monkeypatch, trusted_guard) -> None:
    def missing(*args, **kwargs):
        raise FileNotFoundError

    monkeypatch.setattr(plugin.subprocess, "run", missing)
    decision = plugin.before_tool_call(_call(cmd="git status"), {})
    assert decision is not None
    assert decision.message == "HOL_GUARD_UNAVAILABLE"


def test_timeout_denies(monkeypatch, trusted_guard) -> None:
    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired(cmd="hol-guard", timeout=10)

    monkeypatch.setattr(plugin.subprocess, "run", timeout)
    decision = plugin.before_tool_call(_call(cmd="git status"), {})
    assert decision is not None
    assert decision.message == "HOL_GUARD_TIMEOUT"


def test_oserror_denies(monkeypatch, trusted_guard) -> None:
    def failed(*args, **kwargs):
        raise OSError("boom")

    monkeypatch.setattr(plugin.subprocess, "run", failed)
    decision = plugin.before_tool_call(_call(cmd="git status"), {})
    assert decision is not None
    assert decision.message == "HOL_GUARD_ERROR"


def test_value_error_denies(monkeypatch, trusted_guard) -> None:
    def failed(*args, **kwargs):
        raise ValueError("embedded null byte")

    monkeypatch.setattr(plugin.subprocess, "run", failed)
    decision = plugin.before_tool_call(_call(cmd="git status"), {})
    assert decision is not None
    assert decision.message == "HOL_GUARD_ERROR"


def test_missing_command_denies() -> None:
    decision = plugin.before_tool_call(_call(), {})
    assert decision is not None
    assert decision.message == "HOL_GUARD_INVALID_COMMAND"


def test_null_command_denies(monkeypatch) -> None:
    def fail(*args, **kwargs):
        raise AssertionError

    monkeypatch.setattr(plugin.subprocess, "run", fail)
    decision = plugin.before_tool_call(_call(cmd="echo before\x00after"), {})
    assert decision is not None
    assert decision.message == "HOL_GUARD_INVALID_COMMAND"


def test_workspace_path_hijack_is_rejected(monkeypatch, tmp_path) -> None:
    fake = tmp_path / "hol-guard"
    fake.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("PATH", str(tmp_path))
    assert plugin._resolve_guard_executable() is None


def test_guard_process_gets_minimal_environment(monkeypatch, trusted_guard) -> None:
    captured = {}
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "do-not-pass")
    monkeypatch.setenv("HOL_GUARD_HOME", "/tmp/override")
    monkeypatch.setattr(plugin, "_guard_environment", lambda: {"PATH": "/usr/bin:/bin", "HOME": "/home/test"})

    def run(args, **kwargs):
        captured["args"] = args
        captured["env"] = kwargs["env"]
        return _completed(
            {"classification": {"explicitly_benign": True}, "minimum_action": "allow"}
        )

    monkeypatch.setattr(plugin.subprocess, "run", run)
    assert plugin.before_tool_call(_call(cmd="git status"), {}) is None
    assert captured["args"][0] == "/usr/bin/hol-guard"
    assert captured["env"] == {"PATH": "/usr/bin:/bin", "HOME": "/home/test"}
    assert "AWS_SECRET_ACCESS_KEY" not in captured["env"]
    assert "HOL_GUARD_HOME" not in captured["env"]


def test_guard_environment_drops_override_and_secret_keys(monkeypatch) -> None:
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    monkeypatch.setenv("HOME", "/home/test")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "do-not-pass")
    monkeypatch.setenv("HOL_GUARD_HOME", "/tmp/override")
    monkeypatch.setattr(plugin, "_trusted_path_entries", lambda: ["/usr/bin", "/bin"])
    environment = plugin._guard_environment()
    assert environment["HOME"] == "/home/test"
    assert environment["PATH"] == os.pathsep.join(["/usr/bin", "/bin"])
    assert "AWS_SECRET_ACCESS_KEY" not in environment
    assert "HOL_GUARD_HOME" not in environment
