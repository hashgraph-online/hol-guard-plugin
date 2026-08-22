# ToolHive + HOL Guard

`toolhive-hol-guard` is an optional validating-webhook service that evaluates ToolHive MCP `tools/call` requests through a local HOL Guard installation before ToolHive dispatches them downstream.

It uses ToolHive's existing `validating-webhook` middleware contract. No ToolHive core patch, Guard Cloud account, or remote HOL service is required.

## Security contract

- Only MCP `tools/call` requests are sent to HOL Guard. Other MCP methods pass through.
- Tool name and arguments are evaluated through the local `hol-guard guard hook --harness toolhive --json` boundary.
- Guard `allow` maps to ToolHive `allowed: true`.
- Guard `deny`, `review`, malformed decisions, timeouts, process failures, and adapter validation failures map to `allowed: false`.
- ToolHive's validating middleware returns on `allowed: false` before invoking the downstream handler, so a denied call never reaches the MCP tool body.
- The adapter caps inbound webhook bodies at 1 MiB, Guard decision payloads at 24 KiB, and Guard evaluation time at a configurable maximum of 30 seconds.
- Only `server_name`, `backend_server`, `namespace`, and `transport` are forwarded as runtime context. Principal identity and source IP are deliberately excluded.
- The HTTP service does not log request bodies, tool arguments, or Guard reasons. Denial responses use stable generic reason codes rather than echoing potentially sensitive tool content.

ToolHive's own webhook middleware also supports a `failure_policy`. Use `fail` for security enforcement so transport/webhook failures are denied rather than ignored.

## Install

```bash
python -m pip install ./integrations/toolhive-hol-guard
```

A normal packaged release can be installed with the same console entry point once published.

HOL Guard remains local-first:

```bash
hol-guard --version
toolhive-hol-guard --host 127.0.0.1 --port 8787 --timeout 5
```

For production, expose the webhook over HTTPS or an authenticated in-cluster transport. ToolHive requires HTTPS unless its development/in-cluster `insecure_skip_verify` option is deliberately enabled.

## ToolHive configuration shape

Configure ToolHive's existing validating-webhook middleware to call this service and fail closed. The exact surrounding ToolHive config depends on whether you run a local proxy, vMCP, or the operator, but the webhook entry is conceptually:

```yaml
name: hol-guard
url: https://hol-guard-webhook.internal:8787
timeout: 5s
failure_policy: fail
```

The service speaks ToolHive validating webhook API `v0.1.0`:

```json
{
  "version": "v0.1.0",
  "uid": "request-id",
  "allowed": false,
  "reason": "hol_guard_denied",
  "message": "Request denied by HOL Guard policy"
}
```

A `review` decision is intentionally represented as a denial because ToolHive's validating-webhook response is boolean and does not currently provide a suspend/resume approval primitive. Resolve approval outside the webhook and retry the original action rather than silently treating review as allow.

## Test

```bash
python -m pip install './integrations/toolhive-hol-guard[test]'
python -m pytest -q integrations/toolhive-hol-guard/tests
```

The tests cover allow, deny, review, Guard failure, malformed requests, payload ceilings, non-zero Guard exits, context minimization, and response redaction. ToolHive's native middleware is the downstream enforcement boundary: it stops before `next.ServeHTTP(...)` whenever a validating response is denied or its configured fail-closed webhook call errors.

## Upstream status

The external placement/design discussion is tracked in ToolHive issue #6405. This package is maintained independently unless ToolHive maintainers select an upstream docs/example or integration placement. It should not be interpreted as ToolHive endorsement before that happens.
