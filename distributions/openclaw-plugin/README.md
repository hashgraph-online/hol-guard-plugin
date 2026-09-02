# HOL Guard for OpenClaw

Native OpenClaw plugin that invokes the local `hol-guard` CLI from OpenClaw's typed `before_tool_call` gate before the protected tool executes.

## Behavior

- Guard exit success allows the original OpenClaw tool call to continue unchanged.
- Guard `block`, `deny`, `review`, `require-reapproval`, or `sandbox-required` decisions block the OpenClaw tool call before execution.
- Guard startup errors, input errors, non-zero unknown decisions, and timeouts fail closed.
- OpenClaw's existing tool policy, approval, plugin allow/deny, and runtime controls remain authoritative. This plugin adds no provider-neutral policy layer.

## Requirements

Install HOL Guard separately so `hol-guard` is on the Gateway process `PATH`:

```bash
pipx install hol-guard
```

The package targets OpenClaw `>=2026.8.1` and uses the public typed plugin hook API.

## Local package proof

From this directory:

```bash
npm pack --pack-destination /tmp
openclaw plugins install npm-pack:/tmp/hashgraph-online-openclaw-hol-guard-0.1.0.tgz --force
openclaw plugins enable hol-guard
openclaw plugins inspect hol-guard --runtime --json
```

The final distribution path is ClawHub. After the package is published, users will install it through the supported package route:

```bash
openclaw plugins install clawhub:hashgraph-online/openclaw-hol-guard
openclaw plugins enable hol-guard
```

## Optional config

```json
{
  "plugins": {
    "entries": {
      "hol-guard": {
        "enabled": true,
        "config": {
          "executable": "hol-guard",
          "timeoutMs": 8000
        }
      }
    }
  }
}
```

`workspace` can be set when the Gateway needs Guard evaluation to run from a specific project directory. The default is to leave the child process working directory unchanged.

## Security boundary

The plugin sends the OpenClaw tool name and parameters to `hol-guard hook --harness openclaw --json` over stdin. It does not alter tool parameters, grant approvals, or bypass OpenClaw controls. A blocked Guard decision returns `{ block: true }` from `before_tool_call`, which is terminal in OpenClaw's hook chain.
