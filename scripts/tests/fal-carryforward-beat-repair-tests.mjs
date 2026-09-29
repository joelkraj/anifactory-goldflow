import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { groupingLockHash } from "../lib/editorial-beat-director.mjs";
import { verifyFalBeatCarryforwardRepair } from "../lib/fal-carryforward-beat-repair.mjs";
import { repairReferencePlanExact } from "../lib/reference-plan-exact-repair.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const bytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

const root = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fal-beat-carryforward-"));
const episodeDir = path.join(root, "ep_01");
const file = name => path.join(episodeDir, name);
const write = async (name, value) => { const data = bytes(value); await fs.writeFile(file(name), data); return sha(data); };
try {
  await fs.mkdir(episodeDir);
  const beat = {
    visual_beat_id: "beat_w000145_w000154", image_id_hint: "ep_01-w000145-w000154",
    source_atom_ids: ["atom_1"], source_word_start_index: 145, source_word_end_index: 154,
    scene_id: "scene_003", start_sec: 44.44, location: "Generator pad beside upper service building",
    local_location: "Generator pad beside upper service building", location_id: "upper_service_generator_pad",
    active_state_constraints: { location_id: "upper_service_generator_pad" },
    location_timeline_label: "0:44 Generator pad beside upper service building",
    visual_beat_script_excerpt: "A remembered generator",
    ref_needs: [{ ref_id: "wrong_pad_ref", kind: "location" }],
    beat_ref_requirements: [{ ref_id: "wrong_pad_ref", kind: "location" }],
  };
  const originalPlanSha256 = await write("visual_beat_plan.json", {
    status: "passed", source_hashes: {}, beats: [beat], location_timeline: [],
  });
  const originalApprovalSha256 = await write("visual_beat_approval.json", {
    status: "approved", visual_beat_plan_sha256: originalPlanSha256,
    grouping_lock_sha256: groupingLockHash([beat]),
  });
  const target = {
    ref_id: "upper_service_generator_pad", kind: "location", generation_mode: "standalone_ref",
    scene_ids: ["scene_003"], planned_beat_ids: [beat.visual_beat_id],
    prompt_anchor: "A clean generator pad", state_delta: null,
    reference_image_path: null, conditioning_image_path: null,
  };
  const inventorySha256 = await write("reference_inventory_ledger.json", { status: "passed", assets: [structuredClone(target)] });
  const planSha256 = await write("visual_reference_plan.json", {
    status: "passed",
    source_hashes: { [file("visual_beat_plan.json")]: originalPlanSha256, [file("reference_inventory_ledger.json")]: inventorySha256 },
    reference_targets: [target], character_state_refs: [], findings: [],
  });
  const statesSha256 = await write("character_state_refs.json", {
    status: "draft_needs_manual_review", source_hashes: { [file("visual_reference_plan.json")]: planSha256 },
    character_state_refs: [],
  });
  const spec = {
    schema: "goldflow_reference_plan_exact_repair_v1", episode: "ep_01", reviewer: "Reviewer",
    note: "Correct one pre-lease location before provider spend",
    expected: {
      visual_beat_plan_sha256: originalPlanSha256, visual_beat_approval_sha256: originalApprovalSha256,
      visual_reference_plan_sha256: planSha256, reference_inventory_ledger_sha256: inventorySha256,
      character_state_refs_sha256: statesSha256,
    },
    beat_location_patches: [{ beat_ids: [beat.visual_beat_id],
      from_location_id: "upper_service_generator_pad", from_location: "Generator pad beside upper service building",
      to_location_id: null, to_location: "Unprotected freezing generator site outside the bunker",
      remove_advisory_location_ref_id: "wrong_pad_ref" }],
  };
  const result = await repairReferencePlanExact({ episodeDir, spec, currentStage: "reference_plan_approval" });
  const receipt = JSON.parse(await fs.readFile(result.receipt_path));
  const currentPlanSha256 = sha(await fs.readFile(file("visual_beat_plan.json")));
  const currentApprovalSha256 = sha(await fs.readFile(file("visual_beat_approval.json")));
  const event = { event_type: "stage_completed", stage: "reference_plan_approval", command: "visual repair-ref-plan",
    exit_code: 0, output_hashes: { "visual_beat_plan.json": currentPlanSha256,
      "visual_beat_approval.json": currentApprovalSha256 },
    stdout_tail: JSON.stringify({ status: "passed", receipt_path: result.receipt_path }, null, 2) };
  await fs.writeFile(file("execution_events.jsonl"), `${JSON.stringify(event)}\n`);
  const verify = () => verifyFalBeatCarryforwardRepair({ episodeDir, originalPlanSha256, originalApprovalSha256 });
  assert.deepEqual(await verify(), { repairCount: 1 });

  // Later reference materialization may change its own artifact; the identity
  // exception binds only the two carried beat files.
  await fs.writeFile(file("visual_reference_plan.json"), "later reference materialization\n");
  assert.deepEqual(await verify(), { repairCount: 1 });

  const approvalBytes = await fs.readFile(file("visual_beat_approval.json"));
  const approval = JSON.parse(approvalBytes);
  approval.approval_note = "unreviewed edit";
  await fs.writeFile(file("visual_beat_approval.json"), bytes(approval));
  await assert.rejects(verify(), /deterministic guarded update/);
  await fs.writeFile(file("visual_beat_approval.json"), approvalBytes);

  const beatBytes = await fs.readFile(file("visual_beat_plan.json"));
  const changedBeat = JSON.parse(beatBytes);
  changedBeat.beats[0].location = "Unreviewed replacement";
  await fs.writeFile(file("visual_beat_plan.json"), bytes(changedBeat));
  await assert.rejects(verify(), /does not bind the current beat plan/);
  await fs.writeFile(file("visual_beat_plan.json"), beatBytes);

  const snapshotPath = receipt.before_snapshots["visual_beat_plan.json"];
  const snapshotBytes = await fs.readFile(snapshotPath);
  await fs.writeFile(snapshotPath, "tampered snapshot\n");
  await assert.rejects(verify(), /before snapshot hash differs/);
  await fs.writeFile(snapshotPath, snapshotBytes);

  await fs.writeFile(file("execution_events.jsonl"), "");
  await assert.rejects(verify(), /completed exact-repair execution event is missing/);
  console.log("Fal beat carryforward exact-repair validation tests passed");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
