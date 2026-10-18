#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CLAUDE_PLANNING_DEFAULTS,
  CODEX_PLANNING_DEFAULTS,
  PLANNER_MODELS_PATH,
  minimumCodexCliForModel,
  parsePlannerModelsConfig,
  resolveModelAlias,
} from "../lib/model-defaults.mjs";
import { plannerModelForProvider } from "../lib/planner-provider-registry.mjs";
import { DEFAULT_CODEX_MODEL } from "../lib/codex-cli-runner.mjs";

const shipped = JSON.parse(readFileSync(PLANNER_MODELS_PATH, "utf8"));

// The shipped config feeds every default.
assert.equal(CODEX_PLANNING_DEFAULTS.model, shipped.providers.codex_cli.model);
assert.equal(CLAUDE_PLANNING_DEFAULTS.model, shipped.providers.claude_cli.model);
assert.equal(DEFAULT_CODEX_MODEL, shipped.providers.codex_cli.model);
assert.equal(plannerModelForProvider("codex_cli", {}, {}), shipped.providers.codex_cli.model);

// A model drop is a data edit: a new model works with no code change and no CLI gate row.
const dropped = parsePlannerModelsConfig({
  ...shipped,
  providers: { ...shipped.providers, codex_cli: { ...shipped.providers.codex_cli, model: "gpt-sol-6.2" } },
});
assert.equal(dropped.codex_cli.model, "gpt-sol-6.2");
assert.equal(minimumCodexCliForModel("gpt-sol-6.2", dropped), "0.0.0");
assert.equal(minimumCodexCliForModel("gpt-6.1-sol", dropped), "0.159.1");
assert.equal(minimumCodexCliForModel("gpt-5.6-sol", dropped), "0.144.0");
assert.equal(resolveModelAlias("codex_cli", "latest", dropped), "gpt-sol-6.2");

// Aliases resolve; concrete names pass through untouched.
assert.equal(resolveModelAlias("codex_cli", "Latest"), CODEX_PLANNING_DEFAULTS.model);
assert.equal(resolveModelAlias("claude_cli", "default"), CLAUDE_PLANNING_DEFAULTS.model);
assert.equal(resolveModelAlias("codex_cli", "gpt-5.6-sol"), "gpt-5.6-sol");
assert.equal(resolveModelAlias("planning_room", "stage_routed"), "stage_routed");
assert.throws(() => resolveModelAlias("planning_room", "latest"), /not supported/);

// The environment override accepts the alias too, and never persists it.
assert.equal(plannerModelForProvider("codex_cli", {}, { ANIFACTORY_CODEX_MODEL: "latest" }), CODEX_PLANNING_DEFAULTS.model);
assert.equal(plannerModelForProvider("claude_cli", {}, { ANIFACTORY_CLAUDE_MODEL: "claude-opus-5-5" }), "claude-opus-5-5");
// A locked identity still wins over config and environment.
assert.equal(
  plannerModelForProvider("codex_cli", { provider_locks: { planning_provider_models: { codex_cli: "gpt-5.6-sol" } } }, { ANIFACTORY_CODEX_MODEL: "latest" }),
  "gpt-5.6-sol",
);

// Bad config fails loudly.
assert.throws(() => parsePlannerModelsConfig("{nope"), /not valid JSON/);
assert.throws(() => parsePlannerModelsConfig({ schema: "other" }), /must declare schema/);
assert.throws(() => parsePlannerModelsConfig({ ...shipped, providers: { claude_cli: shipped.providers.claude_cli } }), /codex_cli\.model is required/);
assert.throws(() => parsePlannerModelsConfig({ ...shipped, providers: { ...shipped.providers, claude_cli: { model: "m", reasoning_effort: "turbo" } } }), /reasoning_effort/);
assert.throws(() => parsePlannerModelsConfig({
  ...shipped,
  providers: { ...shipped.providers, codex_cli: { ...shipped.providers.codex_cli, minimum_cli_by_model: [{ pattern: "x", minimum: "latest" }] } },
}), /must be x\.y\.z/);

console.log("planner model config tests passed");

// End to end: preflight resolves "latest" and records a concrete model, never the alias.
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
async function preflightIdentity(extraArgs) {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "planner-model-config-"));
  await execFileAsync(process.execPath, [
    "scripts/run-preflight.mjs",
    "--content-profile", "manhwa_recap_v1", "--media-workflow", "generated_visuals_v1",
    "--channel", "test", "--series", "series", "--week", "run", "--episode", "ep_01", "--title", "Fixture",
    "--run-intent", "diagnostic", "--allow-dirty-worktree", "true", "--dirty-reason", "planner model config test",
    ...extraArgs,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  return JSON.parse(readFileSync(path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01", "run_identity.json"), "utf8"));
}
const codexIdentity = await preflightIdentity(["--planning-provider", "codex_cli", "--planning-model", "latest"]);
assert.equal(codexIdentity.model_versions.planning_model, CODEX_PLANNING_DEFAULTS.model);
const claudeIdentity = await preflightIdentity(["--planning-provider", "claude_cli", "--planning-model", "latest"]);
assert.equal(claudeIdentity.model_versions.planning_model, CLAUDE_PLANNING_DEFAULTS.model);
const claudeDefault = await preflightIdentity(["--planning-provider", "claude_cli"]);
assert.equal(claudeDefault.model_versions.planning_model, CLAUDE_PLANNING_DEFAULTS.model);
console.log("planner model preflight identity checks passed");
