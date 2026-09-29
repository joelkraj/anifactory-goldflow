import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { groupingLockHash } from "../lib/editorial-beat-director.mjs";
import { commandStageFor } from "../lib/pipeline-stage-registry.mjs";
import { referencePlanApprovalMatches } from "../lib/reference-plan-contract.mjs";
import { repairReferencePlanExact } from "../lib/reference-plan-exact-repair.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-ref-exact-"));
  const episodeDir = path.join(dir, "ep_01");
  await fs.mkdir(episodeDir);
  const file = (name) => path.join(episodeDir, name);
  const write = async (name, value) => { await fs.writeFile(file(name), bytes(value)); return sha(await fs.readFile(file(name))); };
  const beats = [
    { visual_beat_id: "beat_w000145_w000154", image_id_hint: "ep_01-w000145-w000154", source_atom_ids: ["atom_1"], source_word_start_index: 145, source_word_end_index: 154, scene_id: "scene_003", start_sec: 44.44, location: "Generator pad beside upper service building", local_location: "Generator pad beside upper service building", location_id: "upper_service_generator_pad", active_state_constraints: { location_id: "upper_service_generator_pad" }, location_timeline_label: "0:44 Generator pad beside upper service building", visual_beat_script_excerpt: "A remembered generator", ref_needs: [{ ref_id: "wrong_pad_ref", kind: "location" }], beat_ref_requirements: [{ ref_id: "wrong_pad_ref", kind: "location" }] },
    { visual_beat_id: "beat_w000263_w000281", image_id_hint: "ep_01-w000263-w000281", source_atom_ids: ["atom_2"], source_word_start_index: 263, source_word_end_index: 281, scene_id: "scene_005", start_sec: 80.5, location: "Generator pad beside upper service building", local_location: "Generator pad beside upper service building", location_id: "upper_service_generator_pad", active_state_constraints: { location_id: "upper_service_generator_pad" }, location_timeline_label: "1:20 Generator pad beside upper service building", visual_beat_script_excerpt: "A technician checks the generator", ref_needs: [{ ref_id: "wrong_pad_ref", kind: "location" }], beat_ref_requirements: [{ ref_id: "wrong_pad_ref", kind: "location" }] },
  ];
  const beatPlan = { status: "passed", source_hashes: {}, beats, location_timeline: [] };
  const beatHash = await write("visual_beat_plan.json", beatPlan);
  const approvalHash = await write("visual_beat_approval.json", { status: "approved", visual_beat_plan_sha256: beatHash, grouping_lock_sha256: groupingLockHash(beats) });
  const target = { ref_id: "blue_repaired_handpainted", kind: "character_state", generation_mode: "standalone_ref", scene_ids: ["scene_080", "scene_101"], planned_beat_ids: ["beat_w011248_w011272", "beat_w015035_w015055"], prompt_anchor: "one robot with a repaired shoulder", state_delta: "repaired shoulder", reference_image_path: null, conditioning_image_path: null };
  const pad = { ref_id: "upper_service_generator_pad", kind: "location", generation_mode: "standalone_ref", scene_ids: ["scene_003", "scene_005", "scene_085"], planned_beat_ids: ["beat_w000263_w000281", "beat_w012191_w012206"], prompt_anchor: "Alder Mill generator pad", state_delta: null, reference_image_path: null, conditioning_image_path: null };
  const inventory = { status: "passed", assets: [structuredClone(target), structuredClone(pad)] };
  const inventoryHash = await write("reference_inventory_ledger.json", inventory);
  const state = { state_ref_id: "blue_repaired_handpainted", scene_ids: ["scene_080", "scene_101"], prompt_anchor: "repaired Blue", scene_prompt_anchor: "repaired Blue" };
  const plan = { status: "passed", source_hashes: { [file("visual_beat_plan.json")]: beatHash, [file("reference_inventory_ledger.json")]: inventoryHash }, reference_targets: [target, pad], character_state_refs: [state], findings: [] };
  const planHash = await write("visual_reference_plan.json", plan);
  const stateHash = await write("character_state_refs.json", { status: "draft_needs_manual_review", source_hashes: { [file("visual_reference_plan.json")]: planHash }, character_state_refs: [state] });
  const spec = {
    schema: "goldflow_reference_plan_exact_repair_v1", episode: "ep_01", reviewer: "Reviewer", note: "Exact pre-spend visual continuity repair",
    expected: { visual_beat_plan_sha256: beatHash, visual_beat_approval_sha256: approvalHash, visual_reference_plan_sha256: planHash, reference_inventory_ledger_sha256: inventoryHash, character_state_refs_sha256: stateHash },
    beat_location_patches: [
      { beat_ids: ["beat_w000145_w000154"], from_location_id: "upper_service_generator_pad", from_location: "Generator pad beside upper service building", to_location_id: null, to_location: "Unprotected freezing generator site outside the bunker", remove_advisory_location_ref_id: "wrong_pad_ref" },
      { beat_ids: ["beat_w000263_w000281"], from_location_id: "upper_service_generator_pad", from_location: "Generator pad beside upper service building", to_location_id: null, to_location: "Unspecified pre-lease technician service worksite", remove_advisory_location_ref_id: "wrong_pad_ref" },
    ],
    reference_patches: [
      { ref_id: "blue_repaired_handpainted", remove_scene_ids: ["scene_080"], remove_planned_beat_ids: ["beat_w011248_w011272"], set: { prompt_anchor: "one robot with a visibly uneven hand-painted blue shoulder stripe", state_delta: "repaired shoulder with uneven hand-painted stripe" } },
      { ref_id: "upper_service_generator_pad", remove_scene_ids: ["scene_003", "scene_005"], remove_planned_beat_ids: ["beat_w000263_w000281"] },
    ],
    state_ref_patches: [{ state_ref_id: "blue_repaired_handpainted", set: { prompt_anchor: "repaired Blue with uneven hand-painted stripe" } }],
  };
  return { episodeDir, spec, file };
}

const first = await fixture();
try {
  assert.equal(commandStageFor("visual", "repair-ref-plan"), "reference_plan_approval");
  await assert.rejects(repairReferencePlanExact({ ...first, currentStage: "reference_generation" }), /only at reference_plan_approval/);
  assert.equal(sha(await fs.readFile(first.file("visual_reference_plan.json"))), first.spec.expected.visual_reference_plan_sha256);
  const bad = structuredClone(first.spec);
  bad.reference_patches[0].set.generation_mode = "source_only";
  await assert.rejects(repairReferencePlanExact({ episodeDir: first.episodeDir, spec: bad, currentStage: "reference_plan_approval" }), /forbidden field/);
  assert.equal(sha(await fs.readFile(first.file("visual_reference_plan.json"))), first.spec.expected.visual_reference_plan_sha256);
  const result = await repairReferencePlanExact({ episodeDir: first.episodeDir, spec: first.spec, currentStage: "reference_plan_approval" });
  assert.equal(result.status, "passed");
  assert.equal(result.beat_count, 2);
  const beat = JSON.parse(await fs.readFile(first.file("visual_beat_plan.json")));
  const approval = JSON.parse(await fs.readFile(first.file("visual_beat_approval.json")));
  const plan = JSON.parse(await fs.readFile(first.file("visual_reference_plan.json")));
  const inventory = JSON.parse(await fs.readFile(first.file("reference_inventory_ledger.json")));
  const states = JSON.parse(await fs.readFile(first.file("character_state_refs.json")));
  const receipt = JSON.parse(await fs.readFile(result.receipt_path));
  assert.equal(beat.beats[1].location_id, null);
  assert.equal(beat.beats[1].ref_needs.length, 0);
  assert.equal(beat.beats[1].beat_ref_requirements.length, 0);
  assert.equal(approval.visual_beat_plan_sha256, sha(await fs.readFile(first.file("visual_beat_plan.json"))));
  assert.equal(approval.grouping_lock_sha256, groupingLockHash(beat.beats));
  assert.equal(plan.source_hashes[first.file("visual_beat_plan.json")], approval.visual_beat_plan_sha256);
  assert.equal(plan.source_hashes[first.file("reference_inventory_ledger.json")], sha(await fs.readFile(first.file("reference_inventory_ledger.json"))));
  assert.deepEqual(plan.reference_targets[0].scene_ids, ["scene_101"]);
  assert.deepEqual(inventory.assets[0].scene_ids, ["scene_101"]);
  assert.deepEqual(states.character_state_refs, plan.character_state_refs);
  assert.equal(states.source_hashes[first.file("visual_reference_plan.json")], sha(await fs.readFile(first.file("visual_reference_plan.json"))));
  assert.equal(receipt.provider_calls, 0);
  assert.equal(sha(await fs.readFile(receipt.before_snapshots["visual_reference_plan.json"])), first.spec.expected.visual_reference_plan_sha256);
  const approvalCall = spawnSync(process.execPath, [path.resolve("scripts/visual-reference-plan-approve.mjs"), "--episode-dir", first.episodeDir, "--note", "Reviewed exact repair"], { encoding: "utf8" });
  assert.equal(approvalCall.status, 0, approvalCall.stderr);
  const refApproval = JSON.parse(await fs.readFile(first.file("reference_plan_approval.json")));
  assert.equal(referencePlanApprovalMatches({ approval: refApproval, plan, fileSha256: sha(await fs.readFile(first.file("visual_reference_plan.json"))) }), true);
  await assert.rejects(repairReferencePlanExact({ episodeDir: first.episodeDir, spec: first.spec, currentStage: "reference_plan_approval" }), /does not match repair spec/);
} finally {
  await fs.rm(path.dirname(first.episodeDir), { recursive: true, force: true });
}
const spent = await fixture();
try {
  await fs.mkdir(path.join(spent.episodeDir, "assets", "images", "references"), { recursive: true });
  await fs.writeFile(path.join(spent.episodeDir, "assets", "images", "references", "generated.png"), "image bytes");
  await assert.rejects(repairReferencePlanExact({ episodeDir: spent.episodeDir, spec: spent.spec, currentStage: "reference_plan_approval" }), /pre-spend repair is closed/);
  assert.equal(sha(await fs.readFile(spent.file("visual_reference_plan.json"))), spent.spec.expected.visual_reference_plan_sha256);
} finally {
  await fs.rm(path.dirname(spent.episodeDir), { recursive: true, force: true });
}
console.log("reference-plan exact repair tests passed");
