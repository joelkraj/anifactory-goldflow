import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { plannerRerunDecision, plannerRerunDecisionForEpisode } from "../lib/planner-rerun-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-transition-revalidation-"));
try {
  const episodeDir = path.join(temp, "channels/c/weekly_runs/w/episodes/ep_01");
  await fs.mkdir(episodeDir, { recursive: true });
  const promptsPath = path.join(episodeDir, "section_image_prompts_hardened.json");
  const planPath = path.join(episodeDir, "transition_edit_plan_ep_01.json");
  const priorEvents = [{ event_type: "stage_started", stage: "transition_edit_plan" },
    { event_type: "stage_completed", stage: "transition_edit_plan", status: "passed" }];
  await fs.writeFile(path.join(episodeDir, "execution_events.jsonl"), priorEvents.map(JSON.stringify).join("\n") + "\n");
  const event = { boundary_id: "boundary_001", from_image_id: "cut_a", to_image_id: "cut_b",
    scene_id: "scene_1", start_sec: 5, in_hook: true, in_retention_ramp: false, scene_changed: false,
    transition_type: "wipeleft", duration_sec: 0.35, reason: "Retained authored transition.",
    transition_sfx: false, sfx_family: "none", cue_id: null, asset_path: null, asset_id: null };
  const original = { schema: "goldflow_transition_edit_plan_v1", status: "passed", prompt_plan_path: promptsPath, transition_sfx_enabled: false,
    transition_events: [event], planner: { provider: "fixture", selection: "retained" },
    source_hashes: { [promptsPath]: "old-hash" }, transition_event_count: 1 };
  const save = (value) => fs.writeFile(planPath, JSON.stringify(value));
  await save(original);
  const flags = { channel: "c", series: "s", week: "w", episode: "ep_01", prompts: promptsPath,
    "transition-sfx": "false", "revalidate-existing": "true" };
  const decide = (candidate = flags, extra = {}) => plannerRerunDecision({ stage: "transition_edit_plan",
    flags: candidate, priorEvents, episodeDir, ...extra });
  assert.equal(decide().reason, "deterministic_non_authoring_revalidation");
  assert.equal(decide().allowed, true);
  assert.equal(plannerRerunDecisionForEpisode({ stage: "transition_edit_plan", flags, episodeDir }).allowed, true);
  const withoutMode = { ...flags }; delete withoutMode["revalidate-existing"];
  assert.equal(decide(withoutMode).reason, "unscoped_planner_rerun_forbidden");
  assert.equal(decide({ ...flags, "revalidate-existing": "false" }).allowed, false);
  for (const value of ["yes", "1", "TRUE"]) assert.equal(decide({ ...flags, "revalidate-existing": value }).allowed, false);
  for (const key of ["output", "existing-plan", "sfx-manifest", "sfxManifest", "model", "provider",
    "codex-model", "codex-reasoning-effort", "planning-provider", "boundary-ids", "cut-ids", "only-scenes",
    "scope-end-sec", "hook-duration-sec", "retention-ramp-sec", "max-boundaries", "transition-sfx-end-sec",
    "dry-run", "codex-reuse-cache", "resume-incomplete-chunks", "allow-full-stage-rerun", "rerun-reason", "workflow-bypass"]) {
    assert.equal(decide({ ...flags, [key]: "true" }).allowed, false, key);
  }
  assert.equal(decide({ ...flags, prompts: path.join(temp, "other.json") }).allowed, false);
  assert.equal(decide({ ...flags, prompts: "" }).allowed, false);
  assert.equal(decide({ ...flags, episode: "ep_02" }).allowed, false);
  assert.equal(decide(flags, { episodeDir: null }).allowed, false);
  assert.equal(decide({ ...flags, "transition-sfx": "true" }).allowed, false);
  assert.equal(decide({ ...flags, "transition-sfx": "0" }).allowed, false);
  const noSfxFlag = { ...flags }; delete noSfxFlag["transition-sfx"];
  assert.equal(decide(noSfxFlag).allowed, false, "default true cannot change a retained silent plan");
  await save({ ...original, transition_sfx_enabled: true });
  assert.equal(decide({ ...flags, "transition-sfx": "true" }).allowed, true);
  assert.equal(decide(noSfxFlag).allowed, true);
  for (const value of [{ ...original, schema: "unknown" }, { ...original, status: "blocked" }, { ...original, transition_events: null },
    { ...original, prompt_plan_path: path.join(temp, "other.json") }]) {
    await save(value); assert.equal(decide().allowed, false);
  }
  await fs.rm(planPath); assert.equal(decide().allowed, false);
  assert.equal(plannerRerunDecision({ stage: "semantic_scene_plan", flags: { "revalidate-existing": "true" }, priorEvents: [
    { event_type: "stage_completed", stage: "semantic_scene_plan", status: "passed" }], episodeDir }).allowed, false);
  await save(original);

  // Execute only the existing deterministic early-return branch on temporary
  // fixtures. No episode production, planner calls, or provider credentials.
  const promptPlan = { status: "passed", prompts: [
    { image_id: "cut_a", scene_id: "scene_1", start_sec: 0, duration_sec: 7 },
    { image_id: "cut_b", scene_id: "scene_1", start_sec: 7, duration_sec: 5 },
  ] };
  const promptBytes = JSON.stringify(promptPlan);
  await fs.writeFile(promptsPath, promptBytes);
  const args = [path.join(root, "scripts/visual-transition-plan.mjs"), ...Object.entries(flags).flatMap(([k, v]) => [`--${k}`, v])];
  const output = execFileSync(process.execPath, args, { env: { ...process.env, ANIFACTORY_DATA_ROOT: temp }, encoding: "utf8", timeout: 10000 });
  assert.equal(JSON.parse(output).timing_revalidated_without_llm, true);
  const refreshed = JSON.parse(await fs.readFile(planPath, "utf8"));
  assert.deepEqual(refreshed.transition_events, [{ ...event, start_sec: 7 }]);
  assert.equal(refreshed.source_hashes[promptsPath], createHash("sha256").update(promptBytes).digest("hex"));
  assert.equal(refreshed.planner.provider, original.planner.provider);
  assert.equal(refreshed.transition_event_count, 1);
  // Removing a retained boundary must fail, never fall through to authoring.
  await fs.writeFile(promptsPath, JSON.stringify({ ...promptPlan, prompts: promptPlan.prompts.slice(0, 1) }));
  const beforeFailure = await fs.readFile(planPath, "utf8");
  assert.throws(() => execFileSync(process.execPath, args, { env: { ...process.env, ANIFACTORY_DATA_ROOT: temp },
    encoding: "utf8", timeout: 10000, stdio: "pipe" }), /Transition timing revalidation could not find current boundary/);
  assert.equal(await fs.readFile(planPath, "utf8"), beforeFailure, "failed revalidation preserves the passed plan");
  console.log("Transition deterministic revalidation policy tests passed.");
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
