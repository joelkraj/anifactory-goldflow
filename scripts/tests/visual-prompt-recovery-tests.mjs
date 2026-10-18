import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readVisualPromptRecoveryScope, visualPromptFailedRecoveryScope, visualPromptPartialFailure,
  visualPromptRecoveryAdmission } from "../lib/visual-prompt-recovery.mjs";
import { workflowStageIds } from "../lib/pipeline-stage-registry.mjs";
import { visualPromptRecoveryCommandForTests } from "../run-status.mjs";
import { exactPromptRecoveryAllowedForTests } from "../run-visual-wavefront.mjs";
import { mergeScopedPromptReplacements } from "../lib/visual-resolution-utils.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-prompt-recovery-"));
try {
  const identity = { channel: "c", series_slug: "s", week: "w", episode: "ep_01" };
  const script = "Locked source fixture.", sourceHash = hash(script);
  const beats = Array.from({ length: 1288 }, (_, i) => ({ image_id_hint: `cut_${i}`, visual_beat_id: `beat_${i}`,
    scene_id: `scene_${Math.floor(i / 10)}`, start_sec: i * 5, duration_sec: 5, visual_beat_script_excerpt: `Exact source ${i}.` }));
  const beatPlan = { status: "passed", source_script_hash: sourceHash, beats };
  const prompts = beats.map((beat, i) => ({ image_id: beat.image_id_hint, visual_beat_id: beat.visual_beat_id,
    scene_id: beat.scene_id, start_sec: beat.start_sec, duration_sec: beat.duration_sec,
    visual_beat_script_excerpt: beat.visual_beat_script_excerpt, provider_prompt: i < 56 ? `Accepted authored ${i}.` : "",
    ...(i < 56 ? {} : { planner_recovery_required: true }) }));
  const originalPrompts = JSON.stringify(prompts);
  const sourceHashes = {};
  await fs.writeFile(path.join(temp, "script_clean.md"), script);
  for (const name of ["timed_scene_plan.json", "semantic_scene_plan.json", "visual_reference_plan.json",
    "character_state_refs.json", "reference_plan_approval.json", "story_fact_ledger.json", "visual_beat_plan.json"]) {
    const content = JSON.stringify(name === "visual_beat_plan.json" ? beatPlan : { status: "passed", source_script_hash: sourceHash });
    await fs.writeFile(path.join(temp, name), content); sourceHashes[path.join(temp, name)] = hash(content);
  }
  const artifact = { schema: "goldflow_section_image_prompts_v1", status: "blocked", ...identity,
    source_script_hash: sourceHash, source_hashes: sourceHashes, prompts,
    visual_plan_scope: { total_visual_unit_count: 1288 },
    planner: { partial_failure: visualPromptPartialFailure(prompts, { failed_chunk_count: 67 }) } };
  const planPath = path.join(temp, "section_image_prompts.json");
  const save = value => fs.writeFile(planPath, JSON.stringify(value));
  await save(artifact);
  const read = () => readVisualPromptRecoveryScope({ episodeDir: temp, sourceScriptHash: sourceHash, identity });
  const scope = await read();
  assert.equal(scope.failed_cut_ids.length, 1232);
  assert.equal(scope.preserved_passed_cut_ids.length, 56);
  assert.equal(scope.preserved_prompts_sha256, hash(JSON.stringify(prompts.slice(0, 56))));
  const order = workflowStageIds(identity), stageIndex = order.indexOf("visual_prompt_plan");
  const status = { identity, current_stage: "visual_prompt_plan", current_stage_state: "blocked",
    stage_ledger: order.slice(0, stageIndex).map(stage => ({ stage, state: "passed" })), visual_prompt_recovery_scope: scope };
  const selected = { "cut-ids": "cut_56,cut_60" };
  assert.deepEqual(visualPromptRecoveryAdmission(status, selected).selected_beat_ids, ["beat_56", "beat_60"]);
  assert.equal(exactPromptRecoveryAllowedForTests(status, selected), true, "wavefront accepts current exact scope without bypass");
  assert.equal(visualPromptRecoveryAdmission(status, { ...selected,
    "wavefront-output-dir": path.join(temp, "reports", "visual-wavefront", "attempt-1", "planner-waves") }).allowed, true);
  assert.equal(visualPromptRecoveryAdmission(status, { "beat-ids": "beat_60" }).allowed, true);
  assert.equal(visualPromptRecoveryAdmission(status, { ...selected, "episode-dir": temp, channel: "c", series: "s", week: "w", episode: "ep_01" }).allowed, true);
  assert.equal(visualPromptRecoveryAdmission(status, { "cut-ids": scope.failed_cut_ids.join(",") }).allowed, true);
  const command = visualPromptRecoveryCommandForTests(scope, identity);
  assert.match(command, /visual plan .*--cut-ids cut_56,/); assert.doesNotMatch(command, /workflow-bypass/);
  assert.equal(visualPromptRecoveryCommandForTests(null, identity), null);
  for (const bad of [{}, { "cut-ids": "" }, { "cut-ids": "cut_0" }, { "cut-ids": "unknown" },
    { "cut-ids": "cut_56,cut_56" }, { "beat-ids": "beat_0" }, { ...selected, "beat-ids": "beat_56" },
    ...["only-scenes", "chunk-ids", "cut-id", "image-id", "scope-end-sec", "offset", "visual-unit-limit", "cutIds",
      "base-prompts", "output", "visual-refs", "beats", "semantic", "manual-recovery-output-files", "allow-draft-refs",
      "revalidate-existing", "correction-findings", "model", "planning-provider", "image-provider", "wavefront-output-dir",
      "episode-dir", "channel", "series", "seriesSlug", "week", "episode"
    ].map(key => ({ ...selected, [key]: "other" })),
    { ...selected, "resume-incomplete-chunks": "true" }, { ...selected, "codex-reuse-cache": "false" },
    { ...selected, "codex-reuse-latest": "0" }]) {
    assert.equal(visualPromptRecoveryAdmission(status, bad).allowed, false, JSON.stringify(bad));
    assert.equal(exactPromptRecoveryAllowedForTests(status, bad), false);
  }
  for (const state of ["passed", "stale", "missing"]) {
    assert.equal(visualPromptRecoveryAdmission({ ...status, current_stage_state: state }, selected).allowed, false);
  }
  assert.equal(visualPromptRecoveryAdmission({ ...status, current_stage: "reference_image_approval" }, selected).allowed, false);
  for (const state of ["blocked", "stale", "missing"]) {
    const changed = structuredClone(status); changed.stage_ledger.at(-1).state = state;
    assert.equal(visualPromptRecoveryAdmission(changed, selected).allowed, false, "all earlier gates remain current");
  }
  assert.equal(visualPromptRecoveryAdmission({ ...status, stage_ledger: [] }, selected).allowed, false);
  for (const change of [{ source_hashes_current: false }, { failed_cut_ids: ["cut_0"] },
    { prompt_plan_sha256: "b".repeat(64) }, { preserved_prompts_sha256: "b".repeat(64) }]) {
    assert.equal(visualPromptRecoveryAdmission({ ...status, visual_prompt_recovery_scope: { ...scope, ...change } }, selected).allowed, false);
  }
  for (const mutate of [
    a => { a.status = "passed"; }, a => { a.source_script_hash = "b".repeat(64); },
    a => { a.prompts.pop(); }, a => { a.prompts[0] = a.prompts[1]; },
    a => { [a.prompts[56], a.prompts[57]] = [a.prompts[57], a.prompts[56]]; },
    a => { a.prompts[56].visual_beat_id = "unknown"; }, a => { a.prompts[56].start_sec += 1; },
    a => { a.prompts[56].visual_beat_script_excerpt = "Changed"; },
    a => { a.prompts[56].provider_prompt = "Already authored"; },
    a => { a.planner.partial_failure.failed_cut_ids.push("cut_0"); },
    a => { a.planner.partial_failure.failed_beat_ids[0] = "beat_0"; },
    a => { a.planner.partial_failure.preserved_passed_cut_ids = []; },
  ]) { const changed = structuredClone(artifact); mutate(changed);
    assert.equal(visualPromptFailedRecoveryScope(changed, beatPlan, sourceHash), null); }
  const repaired = { ...prompts[56], provider_prompt: "Explicitly authored recovery." }; delete repaired.planner_recovery_required;
  const merged = mergeScopedPromptReplacements(prompts, [repaired], { image_ids: [repaired.image_id] });
  const after = { ...artifact, prompts: merged, planner: { partial_failure: visualPromptPartialFailure(merged) } };
  assert.equal(visualPromptFailedRecoveryScope(after, beatPlan, sourceHash).failed_cut_ids.length, 1231);
  assert.equal(JSON.stringify(merged.slice(0, 56)), JSON.stringify(prompts.slice(0, 56)), "all passed rows preserved exactly");
  assert.deepEqual(merged.slice(57), prompts.slice(57), "unrequested placeholders retained");
  await save(after);
  const afterScope = await read();
  assert.equal(visualPromptRecoveryAdmission({ ...status, visual_prompt_recovery_scope: afterScope }, { "cut-ids": "cut_56" }).allowed, false);
  assert.equal(visualPromptRecoveryAdmission({ ...status, visual_prompt_recovery_scope: afterScope }, { "cut-ids": "cut_57" }).allowed, true);
  await save(artifact);
  await fs.writeFile(path.join(temp, "timed_scene_plan.json"), "{}"); assert.equal(await read(), null);
  await fs.writeFile(path.join(temp, "timed_scene_plan.json"), JSON.stringify({ status: "passed", source_script_hash: sourceHash }));
  await save({ ...artifact, source_hashes: { ...sourceHashes, [path.join(temp, "visual_beat_plan.json")]: undefined } });
  assert.equal(await read(), null, "canonical source bindings required");
  await save(artifact);
  assert.equal(await readVisualPromptRecoveryScope({ episodeDir: temp, sourceScriptHash: sourceHash,
    identity: { ...identity, episode: "ep_02" } }), null);
  assert.ok(await read()); assert.equal(JSON.stringify(artifact.prompts), originalPrompts, "all validators read-only");
  console.log("visual prompt exact recovery tests passed (1288 complete / 1232 unresolved / 56 preserved)");
} finally { await fs.rm(temp, { recursive: true, force: true }); }
