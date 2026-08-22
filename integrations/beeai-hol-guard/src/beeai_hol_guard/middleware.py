from __future__ import annotations

import asyncio
import inspect
import json
import os
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from beeai_framework.context import RunContext, RunContextStartEvent, RunMiddlewareProtocol
from beeai_framework.emitter import EmitterOptions, EventMeta
from beeai_framework.emitter.utils import create_internal_event_matcher
from beeai_framework.tools.tool import Tool
from beeai_framework.tools.types import StringToolOutput
from pydantic import BaseModel

_MAX_PAYLOAD_BYTES = 24 * 1024
_MAX_OUTPUT_BYTES = 64 * 1024
_DEFAULT_TIMEOUT_SECONDS = 8.0


@dataclass(frozen=True)
class GuardDecision:
    kind: Literal["allow", "deny", "review"]
    reason: str | None = None


DecisionProvider = Callable[[dict[str, Any]], GuardDecision | Awaitable[GuardDecision]]


def _object(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def _normal(value: Any) -> str | None:
    return value.strip().lower() if isinstance(value, str) and value.strip() else None


def _encode_payload(payload: dict[str, Any]) -> bytes | None:
    try:
        return json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    except (TypeError, ValueError, UnicodeEncodeError):
        return None


def _parse_json_output(raw: bytes) -> dict[str, Any] | None:
    if len(raw) > _MAX_OUTPUT_BYTES:
        return None
    try:
        text = raw.decode("utf-8", errors="strict").strip()
    except UnicodeDecodeError:
        return None
    if not text:
        return None
    candidates = [text, *reversed(text.splitlines())]
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def _classify(payload: dict[str, Any] | None) -> GuardDecision | None:
    if payload is None:
        return None
    queue = [payload]
    seen: set[int] = set()
    allow = False
    review_reason: str | None = None
    deny_reason: str | None = None

    while queue:
        if len(seen) >= 32:
            return None
        layer = queue.pop(0)
        marker = id(layer)
        if marker in seen:
            return None
        seen.add(marker)
        hook = _object(layer.get("hookSpecificOutput")) or {}
        decisions = {
            value
            for value in (
                _normal(hook.get("permissionDecision")),
                _normal(layer.get("permissionDecision")),
                _normal(layer.get("decision")),
            )
            if value
        }
        actions = {
            value
            for value in (_normal(layer.get("policy_action")), _normal(layer.get("policyAction")))
            if value
        }
        hook_reason = hook.get("permissionDecisionReason")
        layer_reason = layer.get("reason")
        reason: str | None = None
        if isinstance(hook_reason, str):
            reason = hook_reason
        elif isinstance(layer_reason, str):
            reason = layer_reason

        if (
            layer.get("blocked") is True
            or layer.get("continue") is False
            or decisions.intersection({"deny", "block"})
            or actions.intersection({"block", "sandbox-required"})
        ):
            deny_reason = reason or "HOL Guard denied this BeeAI tool call."
        if decisions.intersection({"review", "ask"}) or actions.intersection({"review", "require-reapproval"}):
            review_reason = reason or review_reason or "HOL Guard requires approval for this BeeAI tool call."
        if "allow" in decisions or "allow" in actions:
            allow = True

        for key in ("data", "payload", "result"):
            nested = _object(layer.get(key))
            if nested is not None:
                queue.append(nested)

    if deny_reason:
        return GuardDecision("deny", deny_reason)
    if review_reason:
        return GuardDecision("review", review_reason)
    if allow:
        return GuardDecision("allow")
    return None


async def _terminate_process(process: asyncio.subprocess.Process) -> None:
    if process.returncode is None:
        try:
            process.kill()
        except ProcessLookupError:
            pass
    try:
        await process.wait()
    except ProcessLookupError:
        pass


async def _communicate_bounded(process: asyncio.subprocess.Process, encoded: bytes) -> bytes | None:
    if process.stdin is None or process.stdout is None:
        await _terminate_process(process)
        return None

    try:
        process.stdin.write(encoded)
        await process.stdin.drain()
    except (BrokenPipeError, ConnectionResetError):
        await _terminate_process(process)
        return None
    finally:
        process.stdin.close()

    chunks: list[bytes] = []
    total = 0
    while True:
        read_limit = min(8192, _MAX_OUTPUT_BYTES + 1 - total)
        chunk = await process.stdout.read(read_limit)
        if not chunk:
            break
        total += len(chunk)
        if total > _MAX_OUTPUT_BYTES:
            await _terminate_process(process)
            return None
        chunks.append(chunk)

    await process.wait()
    return b"".join(chunks)


class LocalHOLGuardProvider:
    """Evaluate BeeAI tool calls with the local HOL Guard generic hook protocol."""

    def __init__(
        self,
        *,
        command: str = "hol-guard",
        workspace: str | os.PathLike[str] | None = None,
        timeout_seconds: float = _DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self.command = command
        self.workspace = Path(workspace or os.environ.get("HOL_GUARD_WORKSPACE") or os.getcwd()).resolve()
        self.timeout_seconds = timeout_seconds

    async def __call__(self, payload: dict[str, Any]) -> GuardDecision:
        encoded = _encode_payload(payload)
        if encoded is None:
            return GuardDecision("deny", "HOL Guard could not validate this BeeAI tool request.")
        if len(encoded) > _MAX_PAYLOAD_BYTES:
            return GuardDecision("deny", "HOL Guard rejected an oversized BeeAI tool request.")

        process: asyncio.subprocess.Process | None = None
        try:
            process = await asyncio.create_subprocess_exec(
                self.command,
                "guard",
                "hook",
                "--harness",
                "generic",
                "--workspace",
                str(self.workspace),
                cwd=self.workspace,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            stdout = await asyncio.wait_for(_communicate_bounded(process, encoded), timeout=self.timeout_seconds)
        except (OSError, asyncio.TimeoutError):
            if process is not None:
                await _terminate_process(process)
            return GuardDecision("deny", "HOL Guard is unavailable; BeeAI tool execution is blocked.")

        decision = _classify(_parse_json_output(stdout)) if stdout is not None else None
        if process.returncode != 0 or decision is None:
            return GuardDecision("deny", "HOL Guard did not return an authoritative allow decision.")
        return decision


class BeeAIHolGuardMiddleware(RunMiddlewareProtocol):
    """Intercept BeeAI Tool runs and short-circuit them unless HOL Guard explicitly allows execution."""

    def __init__(self, provider: DecisionProvider | None = None, *, workspace: str | os.PathLike[str] | None = None) -> None:
        self._provider = provider or LocalHOLGuardProvider(workspace=workspace)

    def bind(self, ctx: RunContext) -> None:
        ctx.emitter.on(
            create_internal_event_matcher("start"),
            self._on_run_start,
            EmitterOptions(is_blocking=True, persistent=True, match_nested=True, priority=100),
        )

    async def _on_run_start(self, data: RunContextStartEvent, meta: EventMeta) -> None:
        creator_context = meta.creator
        tool = getattr(creator_context, "instance", None)
        if not isinstance(tool, Tool):
            return

        raw_input = data.input.get("input")
        try:
            if isinstance(raw_input, BaseModel):
                arguments: dict[str, Any] = raw_input.model_dump(mode="json")
            elif isinstance(raw_input, Mapping):
                arguments = dict(raw_input)
            else:
                data.output = StringToolOutput(result="HOL Guard could not validate this BeeAI tool request.")
                return
        except (TypeError, ValueError):
            data.output = StringToolOutput(result="HOL Guard could not validate this BeeAI tool request.")
            return

        payload = {
            "hook_event_name": "PreToolUse",
            "hookEventName": "PreToolUse",
            "tool_name": tool.name,
            "tool_input": arguments,
            "cwd": str(getattr(self._provider, "workspace", Path.cwd())),
            "runtime_context": {"framework": "beeai", "run_id": meta.trace.run_id if meta.trace else None},
        }
        encoded = _encode_payload(payload)
        if encoded is None:
            data.output = StringToolOutput(result="HOL Guard could not validate this BeeAI tool request.")
            return
        if len(encoded) > _MAX_PAYLOAD_BYTES:
            data.output = StringToolOutput(result="HOL Guard rejected an oversized BeeAI tool request.")
            return

        try:
            value = self._provider(payload)
            decision = await value if inspect.isawaitable(value) else value
        except Exception:
            decision = GuardDecision("deny", "HOL Guard is unavailable; BeeAI tool execution is blocked.")

        if not isinstance(decision, GuardDecision) or decision.kind not in {"allow", "deny", "review"}:
            decision = GuardDecision("deny", "HOL Guard did not return an authoritative allow decision.")

        if decision.kind == "allow":
            return
        if decision.kind == "review":
            data.output = StringToolOutput(result="HOL Guard requires approval before this BeeAI tool can run.")
            return
        data.output = StringToolOutput(result="HOL Guard blocked this BeeAI tool call.")
