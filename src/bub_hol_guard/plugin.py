import json
import os
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from bub import hookimpl
from bub.hooks.interception import ToolCall, ToolCallDecision
from bub.turn import TurnState

GUARD_TIMEOUT_SECONDS = 10
_SAFE_ENV_KEYS = (
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LOGNAME",
    "SYSTEMROOT",
    "TERM",
    "TZ",
    "USER",
    "WINDIR",
)


def _deny(code: str) -> ToolCallDecision:
    return ToolCallDecision.deny(code)


def _explicit_allow(payload: Any) -> bool:
    if not isinstance(payload, dict):
        return False
    classification = payload.get("classification")
    return (
        isinstance(classification, dict)
        and classification.get("explicitly_benign") is True
        and payload.get("minimum_action") == "allow"
    )


def _blocked_roots() -> tuple[Path, ...]:
    roots = [Path.cwd(), Path(tempfile.gettempdir())]
    for name in ("GITHUB_WORKSPACE", "RUNNER_TEMP", "TMPDIR", "TEMP", "TMP"):
        value = os.environ.get(name)
        if value:
            roots.append(Path(value))

    resolved: list[Path] = []
    for root in roots:
        try:
            candidate = root.expanduser().resolve()
        except (OSError, RuntimeError):
            continue
        if candidate not in resolved:
            resolved.append(candidate)
    return tuple(resolved)


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def _trusted_path_entries() -> list[str]:
    trusted: list[str] = []
    blocked = _blocked_roots()
    getuid = getattr(os, "getuid", None)
    current_uid = getuid() if getuid is not None else None

    for raw_entry in os.environ.get("PATH", "").split(os.pathsep):
        if not raw_entry:
            continue
        entry = Path(raw_entry).expanduser()
        if not entry.is_absolute():
            continue
        try:
            resolved = entry.resolve(strict=True)
            metadata = resolved.stat()
        except (OSError, RuntimeError):
            continue
        if not resolved.is_dir() or any(_inside(resolved, root) for root in blocked):
            continue
        if metadata.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
            continue
        if current_uid is not None and metadata.st_uid not in (0, current_uid):
            continue
        trusted.append(str(resolved))
    return trusted


def _resolve_guard_executable() -> str | None:
    path_entries = _trusted_path_entries()
    if not path_entries:
        return None

    candidate = shutil.which("hol-guard", path=os.pathsep.join(path_entries))
    if candidate is None:
        return None

    try:
        executable = Path(candidate).resolve(strict=True)
        metadata = executable.stat()
    except (OSError, RuntimeError):
        return None

    if not executable.is_file() or not os.access(executable, os.X_OK):
        return None
    if any(_inside(executable, root) for root in _blocked_roots()):
        return None
    if metadata.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        return None

    getuid = getattr(os, "getuid", None)
    if getuid is not None and metadata.st_uid not in (0, getuid()):
        return None
    return str(executable)


def _guard_environment() -> dict[str, str]:
    environment = {
        key: value
        for key in _SAFE_ENV_KEYS
        if (value := os.environ.get(key)) is not None and "\x00" not in value
    }
    path_entries = _trusted_path_entries()
    if path_entries:
        environment["PATH"] = os.pathsep.join(path_entries)
    return environment


@hookimpl
def before_tool_call(call: ToolCall, state: TurnState) -> ToolCallDecision | None:
    del state
    if call.tool != "bash":
        return None

    command = call.arguments.get("cmd")
    if not isinstance(command, str) or not command.strip() or "\x00" in command:
        return _deny("HOL_GUARD_INVALID_COMMAND")

    guard_executable = _resolve_guard_executable()
    if guard_executable is None:
        return _deny("HOL_GUARD_UNAVAILABLE")

    try:
        completed = subprocess.run(
            [guard_executable, "command", "test", command, "--json"],
            capture_output=True,
            check=False,
            env=_guard_environment(),
            text=True,
            timeout=GUARD_TIMEOUT_SECONDS,
        )
    except FileNotFoundError:
        return _deny("HOL_GUARD_UNAVAILABLE")
    except subprocess.TimeoutExpired:
        return _deny("HOL_GUARD_TIMEOUT")
    except (OSError, ValueError):
        return _deny("HOL_GUARD_ERROR")

    if completed.returncode != 0:
        return _deny("HOL_GUARD_ERROR")

    try:
        payload = json.loads(completed.stdout)
    except (json.JSONDecodeError, TypeError):
        return _deny("HOL_GUARD_INVALID_OUTPUT")

    if _explicit_allow(payload):
        return None
    return _deny("HOL_GUARD_DENY")
