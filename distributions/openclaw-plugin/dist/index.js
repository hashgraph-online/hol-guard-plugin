import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_EXECUTABLE, DEFAULT_TIMEOUT_MS, evaluateWithGuard } from "../guard-client.js";

function readConfig(pluginConfig) {
  const config = pluginConfig && typeof pluginConfig === "object" ? pluginConfig : {};
  const executable = typeof config.executable === "string" && config.executable.trim()
    ? config.executable.trim()
    : DEFAULT_EXECUTABLE;
  const timeoutMs = Number.isInteger(config.timeoutMs)
    ? Math.min(Math.max(config.timeoutMs, 250), 10_000)
    : DEFAULT_TIMEOUT_MS;
  const workspace = typeof config.workspace === "string" && config.workspace.trim()
    ? config.workspace.trim()
    : undefined;
  return { executable, timeoutMs, workspace };
}

export default definePluginEntry({
  id: "hol-guard",
  name: "HOL Guard",
  description: "Runs HOL Guard before OpenClaw tool calls and blocks protected actions on deny, review, error, or timeout.",
  register(api) {
    const config = readConfig(api.pluginConfig);
    api.on(
      "before_tool_call",
      async (event, context) => {
        const decision = await evaluateWithGuard({ event, context, ...config });
        if (decision.kind === "allow") {
          return;
        }
        return {
          block: true,
          blockReason: decision.reason,
        };
      },
      {
        priority: 100,
        timeoutMs: Math.min(config.timeoutMs + 2_000, 12_000),
        registrationId: "hol-guard-pretool",
      },
    );
  },
});
