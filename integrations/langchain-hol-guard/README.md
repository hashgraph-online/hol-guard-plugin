# LangChain HOL Guard middleware

`langchain-hol-guard` gates LangChain agent tool execution through the local HOL Guard runtime using LangChain's native `AgentMiddleware.wrap_tool_call` / `awrap_tool_call` boundary.

The integration is intentionally thin: LangChain owns tool execution, while HOL Guard evaluates the tool name and structured arguments immediately before the handler is invoked. Guard Cloud is not required.

## Install

```bash
pip install ./integrations/langchain-hol-guard
```

The package depends on `hol-guard` and `langchain` but does not add HOL policy logic to LangChain itself.

## Use

```python
from langchain.agents import create_agent
from langchain_hol_guard import HolGuardMiddleware

agent = create_agent(
    model="openai:gpt-5",
    tools=[...],
    middleware=[HolGuardMiddleware()],
)
```

For each tool call the middleware sends a bounded local `PreToolUse` hook envelope to HOL Guard. An allow decision invokes LangChain's handler exactly once. A deny decision never invokes the handler. A review/reapproval decision is surfaced as `HolGuardReviewRequired` and also never invokes the handler, because the generic LangChain middleware contract does not itself prove a user approval occurred. Applications can catch that condition and route it into their chosen human-approval flow.

Timeouts, malformed output, non-serializable arguments, ambiguous decisions, and non-zero Guard processes that claim allow all fail closed as `HolGuardUnavailable`.

## Workspace scope

Pass a project directory when you want Guard to evaluate project-scoped settings:

```python
from pathlib import Path
from langchain_hol_guard import HolGuardMiddleware

middleware = HolGuardMiddleware(workspace=Path.cwd())
```

No LangChain state or conversation history is sent to Guard by default. The decision payload contains the tool name, structured arguments, tool-call identifier, source scope, and framework identity.

## Security contract

- Tool execution only occurs after an explicit HOL Guard allow/warn decision.
- Block, sandbox-required, timeout, malformed output, and ambiguous decisions do not execute the tool.
- Review/reapproval does not execute the tool until the application explicitly handles approval and retries through a trusted flow.
- Guard Cloud is optional; local operation is the default.
- The adapter never weakens LangChain's own middleware composition or tool execution semantics.
