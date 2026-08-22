# Microsoft Agent Framework + HOL Guard

This integration proof implements Microsoft Agent Framework's public `FunctionMiddleware` seam. It evaluates a function call with local HOL Guard before `call_next()` can execute the underlying function.

The adapter does not patch Agent Framework core and does not require Guard Cloud.

## Runtime behavior

`HolGuardFunctionMiddleware` maps the framework's validated `{function.name, arguments}` to a bounded HOL Guard `PreToolUse` decision.

- allow/warn: `await call_next()` exactly once;
- deny/block/sandbox-required: raise `MiddlewareFailure` before `call_next()`;
- review/ask/require-reapproval: raise `MiddlewareFailure` before execution so the application can route explicit approval;
- provider error, timeout, malformed/ambiguous output, oversized input: fail closed with `MiddlewareFailure` before execution.

`MiddlewareFailure` is important here: Agent Framework documents it as the explicit fail-closed escape for enforcement middleware, unlike ordinary function exceptions that can be converted into tool-error results while the loop continues.

Tool arguments are capped at 24 KiB and never included in adapter exception text.

## Usage

```python
from agent_framework import Agent
from microsoft_agent_framework_hol_guard import HolGuardFunctionMiddleware

agent = Agent(
    client=client,
    tools=[...],
    middleware=[HolGuardFunctionMiddleware()],
)
```

The default provider invokes local `hol-guard guard hook --harness generic --json`; Guard Cloud credentials are not required.

## Verification

```bash
python -m pip install -e 'integrations/microsoft-agent-framework-hol-guard[test]'
pytest integrations/microsoft-agent-framework-hol-guard/tests -q
```

The contract is pinned to released `agent-framework-core==1.15.0` and proves deny, review, and provider failure never call the framework continuation while allow calls it exactly once.

## External conversion

This is independently maintained supporting work, not Microsoft endorsement. The upstream repository currently requires issue-first alignment for this product-specific placement. Once its issue-write TTL expires, the intended external action is a focused proposal for the smallest provider-neutral docs/sample placement, not a product-specific core dependency.
