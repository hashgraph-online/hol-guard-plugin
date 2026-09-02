import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildGuardPayload,
  classifyGuardResult,
} from "../distributions/openclaw-plugin/guard-client.js";

test("builds a generic OpenClaw PreToolUse payload", () => {
  const payload = buildGuardPayload(
    { toolName: "exec", params: { command: "npm install left-pad" } },
    { runId: "run-1" },
    "/workspace",
  );
  assert.equal(payload.hook_event_name, "PreToolUse");
  assert.equal(payload.tool_name, "exec");
  assert.deepEqual(payload.tool_input, { command: "npm install left-pad" });
  assert.equal(payload.session_id, "run-1");
  assert.equal(payload.cwd, "/workspace");
});

test("allows only a successful Guard result", () => {
  assert.deepEqual(
    classifyGuardResult({ code: 0, stdout: '{"policy_action":"allow"}' }),
    { kind: "allow", policyAction: "allow", reason: "allow" },
  );
});

test("blocks review decisions before OpenClaw executes the tool", () => {
  const decision = classifyGuardResult({
    code: 1,
    stdout: '{"policy_action":"review","reason":"operator review required"}',
  });
  assert.equal(decision.kind, "block");
  assert.equal(decision.policyAction, "review");
  assert.equal(decision.reason, "operator review required");
});

test("fails closed on an unknown non-zero Guard result", () => {
  const decision = classifyGuardResult({ code: 2, stderr: "guard unavailable" });
  assert.equal(decision.kind, "block");
  assert.equal(decision.policyAction, "error");
  assert.equal(decision.reason, "guard unavailable");
});

test("package and manifest expose a native OpenClaw startup plugin", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../distributions/openclaw-plugin/package.json", import.meta.url), "utf8"),
  );
  const manifest = JSON.parse(
    await readFile(new URL("../distributions/openclaw-plugin/openclaw.plugin.json", import.meta.url), "utf8"),
  );
  assert.equal(packageJson.name, "@hashgraph-online/openclaw-hol-guard");
  assert.deepEqual(packageJson.openclaw.extensions, ["./dist/index.js"]);
  assert.equal(manifest.id, "hol-guard");
  assert.equal(manifest.activation.onStartup, true);
});
