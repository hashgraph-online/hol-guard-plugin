# ConnectOnion + HOL Guard

This proof uses ConnectOnion's native `before_each_tool` event to evaluate the final pending tool invocation with local HOL Guard before the framework calls the tool.

```python
from connectonion import Agent, bash
from connectonion_hol_guard import hol_guard

agent = Agent("assistant", tools=[bash], plugins=[hol_guard])
```

ConnectOnion documents that raising from `before_each_tool` cancels the current tool. The adapter therefore returns normally only for an authoritative Guard allow. Deny, review, provider failure, malformed/ambiguous output, oversized input/output, timeout, or a nonzero Guard result all raise before tool execution.

The bridge is local-only by default and does not require HOL Guard Cloud. It sends the pending tool name and structured arguments to `hol-guard guard hook --harness generic`, bounds the request to 24 KiB and captured output to 64 KiB, uses an 8 second deadline, and does not echo tool arguments in failure diagnostics.

The installed-framework contract test calls ConnectOnion's real `execute_single_tool` path and proves that allow reaches the underlying tool once while deny, review, malformed output, provider failure, and nonzero Guard outcomes reach it zero times.

This is an author-owned proof, not an upstream ConnectOnion integration or endorsement. The intended conversion route is ConnectOnion's documented enhancement process followed, if maintainers accept the shape, by the smallest `useful_plugins` contribution and docs.