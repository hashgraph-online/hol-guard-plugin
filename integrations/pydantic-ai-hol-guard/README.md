# pydantic-ai-hol-guard

Optional HOL Guard runtime enforcement for Pydantic AI toolsets.

`HolGuardToolset` wraps any Pydantic AI `AbstractToolset` and evaluates every tool call through HOL Guard's existing local generic hook contract before delegating to the wrapped toolset. It does not reimplement HOL Guard policy.

## Behavior

- `allow` / `warn`: execute the wrapped tool normally.
- `review` / `require-reapproval`: raise Pydantic AI's native `ApprovalRequired`; an approved retry executes normally.
- `block` / `sandbox-required`: raise `HolGuardDenied`; the wrapped tool is never called.
- timeout, malformed output, or unavailable Guard runtime: fail closed with `HolGuardUnavailable`.

Guard Cloud is not required. The integration invokes the local `hol-guard` runtime with a bounded timeout and sends only the current tool name, structured arguments, and workspace scope through the local hook envelope.

## Source install

From this repository checkout:

```bash
python -m pip install -e 'integrations/pydantic-ai-hol-guard[test]'
pytest integrations/pydantic-ai-hol-guard/tests
```

## Usage

```python
from pathlib import Path

from pydantic_ai_hol_guard import HolGuardToolset

protected = HolGuardToolset(
    wrapped=my_toolset,
    workspace=Path.cwd(),
)

agent = Agent(..., toolsets=[protected])
```

Because the wrapper sits around the assembled toolset, the same boundary can cover native Pydantic AI tools and MCP-backed tools without a separate policy implementation for each provider.
