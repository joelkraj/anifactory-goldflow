#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  claudeContentFromStdoutForTests,
  claudeNativeArgsForTests,
  isCodexCacheCompatible,
  runCodexCli,
} from "../lib/codex-cli-runner.mjs";
import {
  DEFAULT_PLANNING_ROOM_ROUTES,
  PLANNER_PROVIDER_IDS,
  normalizePlannerProviderId,
  plannerModelForProvider,
  plannerProviderAvailability,
  planningRoomContract,
} from "../lib/planner-provider-registry.mjs";
import { CLAUDE_PLANNING_DEFAULTS } from "../lib/model-defaults.mjs";

// Registry wiring.
assert.ok(PLANNER_PROVIDER_IDS.includes("claude_cli"));
for (const alias of ["claude", "claude-cli", "claude_cli", "Claude Code"]) {
  assert.equal(normalizePlannerProviderId(alias.replace(" ", "-")), "claude_cli");
}
assert.equal(plannerModelForProvider("claude_cli", {}, {}), CLAUDE_PLANNING_DEFAULTS.model);
assert.equal(plannerModelForProvider("claude_cli", {}, { ANIFACTORY_CLAUDE_MODEL: "claude-opus-5-5" }), "claude-opus-5-5");
assert.equal(
  plannerModelForProvider("claude_cli", { provider_locks: { planning_provider_models: { claude_cli: "locked-model" } } }, { ANIFACTORY_CLAUDE_MODEL: "ignored" }),
  "locked-model",
);
assert.equal(plannerProviderAvailability("claude_cli", { ANIFACTORY_CLAUDE_CLI_PATH: "/nonexistent/claude" }).available, false);

// Adding Claude must not change any default route: Codex stays the production planner.
for (const [stageClass, providers] of Object.entries(DEFAULT_PLANNING_ROOM_ROUTES)) {
  assert.equal(providers.includes("claude_cli"), false, `${stageClass} default route must not include claude_cli`);
}
const contract = planningRoomContract({});
assert.equal(contract.provider_registry.claude_cli.transport, "claude_code_headless_cli");
assert.equal(contract.stage_routes.structured_planning.includes("claude_cli"), false);

// An identity may opt Claude into a stage class explicitly.
const optIn = planningRoomContract({ planning_room: { stage_routes: { global_reasoning: ["claude_cli", "codex_cli"] } } });
assert.deepEqual(optIn.stage_routes.global_reasoning, ["claude_cli", "codex_cli"]);

// Pool capacity is opt-in: absent at zero, present when an identity configures it.
const poolOff = planningRoomContract({ production_profile_config: { planner: { federated_structured_pool: true } } });
assert.equal("claude_cli" in poolOff.structured_pool.providers, false);
const poolOn = planningRoomContract({ production_profile_config: { planner: { federated_structured_pool: true, claude_cli_structured_concurrency: 4 } } });
assert.equal(poolOn.structured_pool.providers.claude_cli.concurrency, 4);

// Arguments: headless, no tools, no session persistence, explicit model and effort.
const args = claudeNativeArgsForTests({ model: "claude-sonnet-5-5", effort: "medium" });
assert.deepEqual(args, [
  "-p", "--output-format", "json", "--no-session-persistence", "--tools", "",
  "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disallowedTools", "*", "--disable-slash-commands",
  "--settings", '{"disableAllHooks":true}',
  "--effort", "medium", "--model", "claude-sonnet-5-5",
]);
assert.throws(() => claudeNativeArgsForTests({ model: "m", effort: "bogus" }), /Unsupported Claude planning effort/);

// Output parsing.
const ok = claudeContentFromStdoutForTests(JSON.stringify({ type: "result", result: "{\"a\":1}", duration_ms: 1500, session_id: "s1" }));
assert.equal(ok.content, "{\"a\":1}");
assert.equal(ok.envelope.session_id, "s1");
assert.throws(() => claudeContentFromStdoutForTests(JSON.stringify({ is_error: true, result: "rate limited" })), /rate limited/);
assert.throws(() => claudeContentFromStdoutForTests("plain text"), /invalid JSON/);
assert.throws(() => claudeContentFromStdoutForTests(""), /invalid JSON/);
assert.throws(() => claudeContentFromStdoutForTests('{"type":"result","result":{"ok":true}}'), /no valid result text/);
assert.throws(() => claudeContentFromStdoutForTests('{"type":"system","result":"not a completion"}'), /no valid result text/);

// End to end through the shared runner against a stub executable (no model call).
const dir = mkdtempSync(path.join(tmpdir(), "claude-planner-"));
const stub = path.join(dir, "claude");
writeFileSync(stub, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "0.0.0-stub (Claude Code)"; exit 0; fi
cat > "${dir}/received_prompt.txt"
echo "$@" > "${dir}/received_args.txt"
printf '%s' '{"type":"result","result":"{\\"ok\\":true}","duration_ms":250,"usage":{"input_tokens":3},"session_id":"stub-session"}'
`);
chmodSync(stub, 0o755);
process.env.ANIFACTORY_CLAUDE_CLI_PATH = stub;
const outputPath = path.join(dir, "out", "planner_output.json");
const result = await runCodexCli({
  prompt: "hello planner",
  stageName: "ep_01_claude_stub_probe",
  repoRoot: dir,
  cwd: dir,
  outputPath,
  provider: "claude_cli",
  model: "claude-sonnet-5-5",
  reasoningEffort: "medium",
});
assert.equal(result.content, "{\"ok\":true}");
assert.equal(result.provider, "claude_cli");
assert.equal(result.transport, "claude_code_headless_cli");
assert.equal(result.model, "claude-sonnet-5-5");
assert.equal(readFileSync(path.join(dir, "received_prompt.txt"), "utf8"), "hello planner");
assert.match(readFileSync(path.join(dir, "received_args.txt"), "utf8"), /--model claude-sonnet-5-5/);
const meta = JSON.parse(readFileSync(`${outputPath}.meta.json`, "utf8"));
assert.equal(meta.status, "passed");
assert.equal(meta.provider, "claude_cli");
assert.equal(meta.provider_conversation_id, "stub-session");
assert.equal(typeof meta.prompt_sha256, "string");
assert.equal(readFileSync(outputPath, "utf8"), "{\"ok\":true}");

// A pooled Claude result is reusable only under its exact approved route/model.
const originalArgv = process.argv;
const identityPath = path.join(dir, "run_identity.json");
const identity = {
  planning_provider: "planning_room",
  planning_effort_policy: "planning_room_stage_routed_v1",
  planning_room: {
    schema: "goldflow_planning_room_v2",
    stage_routes: { structured_planning: ["codex_cli", "claude_cli"] },
    provider_models: { codex_cli: "gpt-6-sol", claude_cli: "claude-sonnet-5-5" },
  },
};
writeFileSync(identityPath, JSON.stringify(identity));
process.argv = [process.execPath, "fixture", "--episode-dir", dir];
try {
  const cached = { ...meta, stage_name: "semantic_scene_plan", planning_effort_policy: "planning_room_stage_routed_v1" };
  const cacheOptions = { stageName: "semantic_scene_plan", planningOverrideStage: "semantic_scene_plan", promptHash: meta.prompt_sha256 };
  assert.equal(isCodexCacheCompatible(cached, cacheOptions), true);
  assert.equal(isCodexCacheCompatible({ ...cached, model: "wrong-model" }, cacheOptions), false);
  assert.equal(isCodexCacheCompatible({ ...cached, reasoning_effort: "high" }, cacheOptions), false);
  assert.equal(isCodexCacheCompatible({ ...cached, prompt_sha256: "changed" }, cacheOptions), false);
  identity.planning_room.stage_routes.structured_planning = ["codex_cli"];
  writeFileSync(identityPath, JSON.stringify(identity));
  assert.throws(() => isCodexCacheCompatible(cached, cacheOptions), /not approved/);
} finally { process.argv = originalArgv; }

// Malformed provider output fails once and leaves a failure receipt, never a cache hit.
const failureStub = path.join(dir, "claude-failure");
writeFileSync(failureStub, '#!/bin/sh\ncat > /dev/null\necho "not json"\n');
chmodSync(failureStub, 0o755);
process.env.ANIFACTORY_CLAUDE_CLI_PATH = failureStub;
const failedOutput = path.join(dir, "failed.json");
await assert.rejects(runCodexCli({ prompt: "fixture", stageName: "claude_failure", repoRoot: dir, outputPath: failedOutput, provider: "claude_cli" }), /invalid JSON/);
assert.equal(JSON.parse(readFileSync(`${failedOutput}.meta.json`, "utf8")).status, "failed");

console.log("claude CLI planner tests passed");
