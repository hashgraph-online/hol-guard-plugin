from __future__ import annotations

import asyncio
import inspect
import json
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from mcp.types import CallToolRequestParams, CallToolResult, TextContent
from mcp_use.middleware import Middleware, MiddlewareContext, NextFunctionT

_MAX_PAYLOAD_BYTES = 24 * 1024
_MAX_OUTPUT_BYTES = 64 * 1024
_DEFAULT_TIMEOUT_SECONDS = 8.0


@dataclass(frozen=True)
class GuardDecision:
    kind: Literal["allow", "deny", "review"]


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
    for candidate in [text, *reversed(text.splitlines())]:
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
    review = False
    deny = False
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
        deny = deny or layer.get("blocked") is True or layer.get("continue") is False
        deny = deny or bool(decisions.intersection({"deny", "block"}))
        deny = deny or bool(actions.intersection({"block", "sandbox-required"}))
        review = review or bool(decisions.intersection({"review", "ask"}))
        review = review or bool(actions.intersection({"review", "require-reapproval"}))
        allow = allow or "allow" in decisions or "allow" in actions
        for key in ("data", "payload", "result"):
            nested = _object(layer.get(key))
            if nested is not None:
                queue.append(nested)
    if deny:
        return GuardDecision("deny")
    if review:
        return GuardDecision("review")
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
        if encoded is None or len(encoded) > _MAX_PAYLOAD_BYTES:
            return GuardDecision("deny")
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
            return GuardDecision("deny")
        decision = _classify(_parse_json_output(stdout)) if stdout is not None else None
        if process.returncode != 0 or decision is None:
            return GuardDecision("deny")
        return decision


def _blocked_result(message: str) -> CallToolResult:
    return CallToolResult(isError=True, content=[TextContent(type="text", text=message)])


class MCPUseHOLGuardMiddleware(Middleware):
    """Gate mcp-use tools/call requests before the downstream MCP server is invoked."""

    def __init__(self, provider: DecisionProvider | None = None, *, workspace: str | os.PathLike[str] | None = None) -> None:
        self._provider = provider or LocalHOLGuardProvider(workspace=workspace)

    async def on_call_tool(
        self,
        context: MiddlewareContext[CallToolRequestParams],
        call_next: NextFunctionT,
    ) -> CallToolResult:
        arguments = context.params.arguments or {}
        payload = {
            "hook_event_name": "PreToolUse",
            "hookEventName": "PreToolUse",
            "tool_name": context.params.name,
            "tool_input": arguments,
            "cwd": str(getattr(self._provider, "workspace", Path.cwd())),
            "runtime_context": {
                "framework": "mcp-use",
                "request_id": context.id,
                "connection_id": context.connection_id,
            },
        }
        encoded = _encode_payload(payload)
        if encoded is None:
            return _blocked_result("HOL Guard could not validate this MCP tool request.")
        if len(encoded) > _MAX_PAYLOAD_BYTES:
            return _blocked_result("HOL Guard rejected an oversized MCP tool request.")
        try:
            value = self._provider(payload)
            decision = await value if inspect.isawaitable(value) else value
        except Exception:
            decision = GuardDecision("deny")
        if not isinstance(decision, GuardDecision) or decision.kind not in {"allow", "deny", "review"}:
            decision = GuardDecision("deny")
        if decision.kind == "allow":
            return await call_next(context)
        if decision.kind == "review":
            return _blocked_result("HOL Guard requires approval before this MCP tool can run.")
        return _blocked_result("HOL Guard blocked this MCP tool call.")
