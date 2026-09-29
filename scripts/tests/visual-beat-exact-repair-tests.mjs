import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { groupingLockHash } from "../lib/editorial-beat-director.mjs";
import { CURRENT_VISUAL_BEAT_CONTRACT_VERSION } from "../lib/visual-beat-contract.mjs";
import { commandStageFor } from "../lib/pipeline-stage-registry.mjs";
import { beginStageExecution, finishStageExecution } from "../lib/execution-provenance.mjs";
import { applyVisualBeatExactRepair, visualBeatExactRepairAdmission } from "../lib/visual-beat-exact-repair.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const bytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const read = async (file) => JSON.parse(await fs.readFile(file));
const beat = (number, place, id) => ({
  visual_beat_id: `beat_w${String(number).padStart(6, "0")}_w${String(number).padStart(6, "0")}`,
  image_id_hint: `ep_01-w${String(number).padStart(6, "0")}-w${String(number).padStart(6, "0")}`,
  source_atom_ids: [`atom_w${String(number).padStart(6, "0")}_w${String(number).padStart(6, "0")}`],
  source_word_start_index: number,
  source_word_end_index: number,
  start_sec: number,
  end_sec: number + 1,
  parent_scene_id: "scene_01",
  visual_beat_script_excerpt: `Word ${number}`,
  location_id: id,
  location: place,
  local_location: place,
  active_state_constraints: { location_id: id, wardrobe_state_id: "jacket" },
  visual_beat_focus: "A simple composition",
  visual_novelty_directive: "A simple composition",
  local_continuity_note: "Current clothing remains on.",
  physically_visible_entity_ids: ["joey"],
  preview_visible_entity_ids: [],
  preview_visible_characters: [],
  screen_visible_entity_ids: [],
  visible_entities: [{ entity_id: "joey", display_name: "Joey", kind: "person" }],
});

async function fixture() {
  const episodeDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-exact-beat-repair-"));
  const identity = { schema: "goldflow_run_identity_v2", channel: "c", series_slug: "s",
    week: "w", episode: "ep_01", content_profile: "manhwa_recap_v1", media_workflow: "generated_visuals_v1" };
  const identityBytes = bytes(identity);
  const scriptBytes = Buffer.from("Word zero. Word one. Word two.\n");
  const facts = { canonical_locations: [
    { location_id: "home_desk", display_name: "Home desk" },
    { location_id: "alder_mill", display_name: "Alder Mill" },
  ] };
  const sources = {};
  const sourceContents = {
    "script_clean.md": scriptBytes,
    "story_fact_ledger.json": bytes(facts),
    "timed_scene_plan.json": bytes({ status: "passed" }),
    "narration_word_timing_ep_01.json": bytes({ status: "passed" }),
  };
  for (const [name, value] of Object.entries(sourceContents)) {
    await fs.writeFile(path.join(episodeDir, name), value);
    sources[path.join(episodeDir, name)] = hash(value);
  }
  await fs.writeFile(path.join(episodeDir, "run_identity.json"), identityBytes);
  const beats = [beat(0, "Home desk", "home_desk"), beat(1, "Home desk", "home_desk"),
    beat(2, "Alder Mill", "alder_mill")];
  delete beats[1].active_state_constraints;
  beats[2].physically_visible_entity_ids = [];
  beats[2].preview_visible_entity_ids = ["joey"];
  beats[2].preview_visible_characters = ["Joey"];
  const grouping = groupingLockHash(beats);
  const plan = { schema: "goldflow_visual_beat_plan_v2", status: "passed",
    visual_beat_contract_version: CURRENT_VISUAL_BEAT_CONTRACT_VERSION,
    channel: "c", series_slug: "s", week: "w", episode: "ep_01",
    source_script_hash: hash(scriptBytes), source_hashes: sources,
    visual_beat_count: beats.length, editorial_director: { grouping_lock_sha256: grouping },
    beats, location_timeline: [], updated_at: "2026-01-01T00:00:00Z" };
  const planPath = path.join(episodeDir, "visual_beat_plan.json");
  const planBytes = bytes(plan);
  await fs.writeFile(planPath, planBytes);
  const approval = { schema: "goldflow_visual_beat_approval_v1", status: "approved",
    approval_kind: "grouping_lock", visual_beat_plan_path: planPath,
    visual_beat_plan_sha256: hash(planBytes), grouping_lock_sha256: grouping,
    approved_by: "original-director", approval_note: "Original editorial approval." };
  const approvalBytes = bytes(approval);
  await fs.writeFile(path.join(episodeDir, "visual_beat_approval.json"), approvalBytes);
  const status = { episode_dir: episodeDir, identity, media_workflow: { id: "generated_visuals_v1" },
    current_stage: "visual_reference_plan", current_stage_state: "missing",
    stage_ledger: [
      { stage: "visual_beat_plan", state: "passed" },
      { stage: "visual_reference_plan", state: "missing" },
      { stage: "reference_plan_approval", state: "missing" },
      { stage: "reference_generation", state: "missing" },
    ] };
  const ids = [beats[1].visual_beat_id, beats[2].visual_beat_id];
  const spec = { schema: "goldflow_visual_beat_exact_repair_v1", status: "approved",
    episode_dir: episodeDir, run_identity_sha256: hash(identityBytes), source_script_sha256: hash(scriptBytes),
    base_visual_beat_plan_sha256: hash(planBytes), base_visual_beat_approval_sha256: hash(approvalBytes),
    grouping_lock_sha256: grouping, approved_by: "codex-agent",
    review_note: "Manual correction against approved script and visual direction.",
    repairs: [
      { visual_beat_id: ids[0], source_atom_ids: beats[1].source_atom_ids,
        evidence_note: "This beat is now at Alder Mill.",
        location: { before_location_id: "home_desk", before_location: "Home desk",
          to_location_id: "alder_mill", to_location: "Alder Mill office" } },
      { visual_beat_id: ids[1], source_atom_ids: beats[2].source_atom_ids,
        evidence_note: "The approved script calls for visible blue light on the power source.",
        focus: { before: "A simple composition", to: "Blue light glows from the power source." },
        continuity_note: { before: "Current clothing remains on.", to: "Keep the current jacket visible." },
        visibility: { entity_id: "joey", from: "preview", to: "physical" } },
    ] };
  const specPath = path.join(episodeDir, "repair_spec.json");
  await fs.writeFile(specPath, bytes(spec));
  return { episodeDir, identity, status, ids, spec, specPath, plan, planBytes, approvalBytes };
}

async function withFixture(callback) {
  const value = await fixture();
  try { await callback(value); }
  finally { await fs.rm(value.episodeDir, { recursive: true, force: true }); }
}

assert.equal(commandStageFor("visual", "repair-beats", {}, {}), "visual_beat_plan");
await withFixture(async ({ episodeDir, status, ids, specPath, plan, planBytes, approvalBytes }) => {
  const flags = { "episode-dir": episodeDir, "repair-spec": specPath, "beat-ids": ids.join(",") };
  assert.equal(visualBeatExactRepairAdmission(status, flags).allowed, true);
  for (const denied of [
    { ...flags, "beat-ids": `${ids[0]},${ids[0]}` },
    { ...flags, "workflow-bypass": "true" },
    { ...flags, "beat-ids": "" },
  ]) assert.equal(visualBeatExactRepairAdmission(status, denied).allowed, false);
  for (const deniedStatus of [
    { ...status, current_stage: "visual_beat_plan" },
    { ...status, current_stage_state: "blocked" },
    { ...status, stage_ledger: status.stage_ledger.map((row) => row.stage === "reference_generation"
      ? { ...row, state: "passed" } : row) },
  ]) assert.equal(visualBeatExactRepairAdmission(deniedStatus, flags).allowed, false);
  const oldEvent = { schema: "goldflow_execution_event_v1", event_type: "stage_completed",
    stage: "visual_beat_plan", execution_id: "old", status: "passed" };
  await fs.writeFile(path.join(episodeDir, "execution_events.jsonl"), `${JSON.stringify(oldEvent)}\n`);
  const execution = await beginStageExecution({ stage: "visual_beat_plan", command: "visual repair-beats",
    flags, args: ["--episode-dir", episodeDir, "--repair-spec", specPath, "--beat-ids", ids.join(",")] });
  const result = await applyVisualBeatExactRepair({ episodeDir, specPath, beatIds: ids, status });
  await finishStageExecution(execution, { exitCode: 0 });
  assert.equal(result.status, "passed");
  const after = await read(path.join(episodeDir, "visual_beat_plan.json"));
  const approval = await read(path.join(episodeDir, "visual_beat_approval.json"));
  assert.equal(groupingLockHash(after.beats), groupingLockHash(plan.beats));
  assert.equal(after.editorial_director.grouping_lock_sha256, groupingLockHash(plan.beats));
  assert.deepEqual(after.beats[0], plan.beats[0], "unselected beat is byte-equivalent after JSON serialization");
  assert.equal(after.beats[1].location_id, "alder_mill");
  assert.equal(after.beats[1].active_state_constraints, undefined, "repair must not invent absent state projection");
  assert.equal(after.beats[1].location, "Alder Mill office");
  assert.equal(after.beats[2].visual_beat_focus, "Blue light glows from the power source.");
  assert.equal(after.beats[2].visual_novelty_directive, after.beats[2].visual_beat_focus);
  assert.deepEqual(after.beats[2].physically_visible_entity_ids, ["joey"]);
  assert.deepEqual(after.beats[2].preview_visible_entity_ids, []);
  assert.deepEqual(after.beats[2].preview_visible_characters, []);
  assert.equal(after.location_timeline[1].location, "Alder Mill office");
  assert.equal(approval.visual_beat_plan_sha256, hash(await fs.readFile(path.join(episodeDir, "visual_beat_plan.json"))));
  assert.equal(approval.grouping_lock_sha256, groupingLockHash(after.beats));
  const receipt = await read(result.receipt_path);
  assert.deepEqual(receipt.visual_beat_ids, ids);
  assert.equal(receipt.previous_visual_beat_plan_sha256, hash(planBytes));
  assert.equal(receipt.provider_cost_usd, 0);
  assert.deepEqual(await fs.readFile(path.join(path.dirname(result.receipt_path), "before_plan.json")), planBytes);
  assert.deepEqual(await fs.readFile(path.join(path.dirname(result.receipt_path), "before_approval.json")), approvalBytes);
  const events = (await fs.readFile(path.join(episodeDir, "execution_events.jsonl"), "utf8"))
    .split("\n").filter(Boolean).map(JSON.parse);
  assert.deepEqual(events[0], oldEvent, "prior provenance line is append-only");
  assert.equal(events.filter((row) => row.event_type === "stage_started").length, 1);
  assert.equal(events.filter((row) => row.event_type === "stage_completed").length, 2);
  const scoped = events.at(-1);
  assert.deepEqual(scoped.scope.beat_ids, ids);
  assert.equal(scoped.output_hashes["visual_beat_plan.json"], result.visual_beat_plan_sha256);
  assert.equal(scoped.output_hashes["visual_beat_approval.json"], result.visual_beat_approval_sha256);
  assert.equal((await read(scoped.immutable_report_path)).status, "passed");
  await assert.rejects(
    applyVisualBeatExactRepair({ episodeDir, specPath, beatIds: ids, status }),
    /stale against episode/,
    "same spec cannot be applied twice",
  );
});

for (const change of [
  ({ spec }) => { spec.run_identity_sha256 = "f".repeat(64); },
  ({ spec }) => { spec.base_visual_beat_approval_sha256 = "f".repeat(64); },
  ({ spec }) => { spec.repairs[0].location.before_location = "wrong"; },
  ({ spec }) => { spec.repairs[0].source_atom_ids = ["atom_w999999_w999999"]; },
  ({ spec }) => { spec.grouping_lock_sha256 = "f".repeat(64); },
]) {
  await withFixture(async (f) => {
    change(f);
    await fs.writeFile(f.specPath, bytes(f.spec));
    await assert.rejects(applyVisualBeatExactRepair({ episodeDir: f.episodeDir, specPath: f.specPath,
      beatIds: f.ids, status: f.status }));
    assert.deepEqual(await fs.readFile(path.join(f.episodeDir, "visual_beat_plan.json")), f.planBytes);
    assert.deepEqual(await fs.readFile(path.join(f.episodeDir, "visual_beat_approval.json")), f.approvalBytes);
  });
}

await withFixture(async ({ episodeDir, status, ids, specPath, planBytes }) => {
  await fs.writeFile(path.join(episodeDir, "story_fact_ledger.json"), "{}\n");
  await assert.rejects(applyVisualBeatExactRepair({ episodeDir, specPath, beatIds: ids, status }),
    /source artifact changed/);
  assert.deepEqual(await fs.readFile(path.join(episodeDir, "visual_beat_plan.json")), planBytes);
});
await withFixture(async ({ episodeDir, status, ids, specPath, planBytes }) => {
  await fs.writeFile(path.join(episodeDir, "execution_events.jsonl"), `${JSON.stringify({
    event_type: "stage_started", stage: "visual_reference_plan" })}\n`);
  await assert.rejects(applyVisualBeatExactRepair({ episodeDir, specPath, beatIds: ids, status }),
    /Downstream stage already started/);
  assert.deepEqual(await fs.readFile(path.join(episodeDir, "visual_beat_plan.json")), planBytes);
});
console.log("visual-beat-exact-repair-tests passed");
