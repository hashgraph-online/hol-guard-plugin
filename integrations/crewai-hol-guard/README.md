# CrewAI HOL Guard

`crewai-hol-guard` gates CrewAI tool execution through the local HOL Guard runtime using CrewAI's global `BeforeToolCallHook` boundary.

It is intentionally thin: CrewAI owns tool execution and hook ordering; HOL Guard owns the security decision. No Guard Cloud login is required.

## Install

```bash
pip install crewai-hol-guard
```

## Enable for every CrewAI tool call

```python
from crewai_hol_guard import enable_hol_guard

enable_hol_guard()
```

CrewAI calls the registered hook before each tool execution. HOL Guard receives the tool name, structured arguments, and bounded agent/task/crew context. Decisions map to CrewAI semantics as follows:

- `allow` / `warn`: continue normally.
- `deny` / `block`: return `False`, so CrewAI aborts before the tool executes.
- `review`: deny by default in headless mode. Provide an explicit approval handler to continue.
- malformed output, timeouts, missing Guard runtime, and provider errors: fail closed.

For interactive console approval:

```python
from crewai_hol_guard import enable_hol_guard, interactive_approval

enable_hol_guard(approval_handler=interactive_approval)
```

The adapter does not silently rewrite tool arguments. If HOL Guard later exposes an explicit transform decision, it should be mapped only through CrewAI's documented in-place `tool_input` mutation contract.

## Why this boundary

CrewAI's current `ToolCallHookContext` exposes `tool_name`, mutable `tool_input`, and agent/task/crew context, while `BeforeToolCallHook` can abort a call by returning `False`. This makes the integration a native pre-execution gate rather than post-hoc monitoring.

The package is maintained separately from CrewAI core so CrewAI does not need a product-specific dependency. It can also serve as a concrete provider/conformance case for CrewAI's ongoing provider-neutral guardrail standardization work.
