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
const memoryBinding = await fixture();
try {
  const { file } = memoryBinding;
  const beatPlan = JSON.parse(await fs.readFile(file("visual_beat_plan.json")));
  beatPlan.beats[0].scene_id = "scene_080";
  beatPlan.beats[0].depiction_mode = "memory_or_flashback";
  beatPlan.beats[0].visible_characters = ["Blue"];
  beatPlan.beats[0].physically_visible_entity_ids = ["blue"];
  beatPlan.beats[0].visual_beat_script_excerpt = "Blue remembers the repaired shoulder before the factory door closed.";
  const beatHash = sha(bytes(beatPlan));
  await fs.writeFile(file("visual_beat_plan.json"), bytes(beatPlan));
  const approval = JSON.parse(await fs.readFile(file("visual_beat_approval.json")));
  approval.visual_beat_plan_sha256 = beatHash;
  approval.grouping_lock_sha256 = groupingLockHash(beatPlan.beats);
  const approvalHash = sha(bytes(approval));
  await fs.writeFile(file("visual_beat_approval.json"), bytes(approval));
  const plan = JSON.parse(await fs.readFile(file("visual_reference_plan.json")));
  plan.reference_targets[0].canonical_subject_id = "blue";
  plan.source_hashes[file("visual_beat_plan.json")] = beatHash;
  await fs.writeFile(file("visual_reference_plan.json"), bytes(plan));
  const inventory = JSON.parse(await fs.readFile(file("reference_inventory_ledger.json")));
  inventory.assets[0].canonical_subject_id = "blue";
  const inventoryHash = sha(bytes(inventory));
  await fs.writeFile(file("reference_inventory_ledger.json"), bytes(inventory));
  plan.source_hashes[file("reference_inventory_ledger.json")] = inventoryHash;
  const reboundPlanHash = sha(bytes(plan));
  await fs.writeFile(file("visual_reference_plan.json"), bytes(plan));
  const states = JSON.parse(await fs.readFile(file("character_state_refs.json")));
  states.source_hashes[file("visual_reference_plan.json")] = reboundPlanHash;
  const statesHash = sha(bytes(states));
  await fs.writeFile(file("character_state_refs.json"), bytes(states));
  const spec = {
    schema: "goldflow_reference_plan_exact_repair_v1", episode: "ep_01", reviewer: "Reviewer", note: "Bind one source-quoted historical state before reference spend",
    expected: { visual_beat_plan_sha256: beatHash, visual_beat_approval_sha256: approvalHash, visual_reference_plan_sha256: reboundPlanHash, reference_inventory_ledger_sha256: inventoryHash, character_state_refs_sha256: statesHash },
    reference_patches: [{ ref_id: "blue_repaired_handpainted", add_memory_beat_quotes: [{ beat_id: beatPlan.beats[0].visual_beat_id, source_quote: "Blue remembers the repaired shoulder" }] }],
  };
  const wrongQuote = structuredClone(spec);
  wrongQuote.reference_patches[0].add_memory_beat_quotes[0].source_quote = "not in source";
  await assert.rejects(repairReferencePlanExact({ episodeDir: memoryBinding.episodeDir, spec: wrongQuote, currentStage: "reference_plan_approval" }), /source-backed visible character/);
  const changedBeats = structuredClone(beatPlan);
  changedBeats.beats[0].depiction_mode = "current_reality";
  await fs.writeFile(file("visual_beat_plan.json"), bytes(changedBeats));
  const changedApproval = structuredClone(approval);
  changedApproval.visual_beat_plan_sha256 = sha(bytes(changedBeats));
  await fs.writeFile(file("visual_beat_approval.json"), bytes(changedApproval));
  const changedPlan = structuredClone(plan);
  changedPlan.source_hashes[file("visual_beat_plan.json")] = sha(bytes(changedBeats));
  await fs.writeFile(file("visual_reference_plan.json"), bytes(changedPlan));
  const changedStates = structuredClone(states);
  changedStates.source_hashes[file("visual_reference_plan.json")] = sha(bytes(changedPlan));
  await fs.writeFile(file("character_state_refs.json"), bytes(changedStates));
  const wrongMode = structuredClone(spec);
  wrongMode.expected.visual_beat_plan_sha256 = sha(bytes(changedBeats));
  wrongMode.expected.visual_beat_approval_sha256 = sha(bytes(changedApproval));
  wrongMode.expected.visual_reference_plan_sha256 = sha(bytes(changedPlan));
  wrongMode.expected.character_state_refs_sha256 = sha(bytes(changedStates));
  await assert.rejects(repairReferencePlanExact({ episodeDir: memoryBinding.episodeDir, spec: wrongMode, currentStage: "reference_plan_approval" }), /source-backed visible character/);
  await fs.writeFile(file("visual_beat_plan.json"), bytes(beatPlan));
  await fs.writeFile(file("visual_beat_approval.json"), bytes(approval));
  await fs.writeFile(file("visual_reference_plan.json"), bytes(plan));
  await fs.writeFile(file("character_state_refs.json"), bytes(states));
  const result = await repairReferencePlanExact({ episodeDir: memoryBinding.episodeDir, spec, currentStage: "reference_plan_approval" });
  assert.equal(result.status, "passed");
  const revisedPlan = JSON.parse(await fs.readFile(file("visual_reference_plan.json")));
  const revisedInventory = JSON.parse(await fs.readFile(file("reference_inventory_ledger.json")));
  assert.deepEqual(revisedPlan.reference_targets[0].planned_beat_ids, revisedInventory.assets[0].planned_beat_ids);
  assert.equal(revisedPlan.reference_targets[0].planned_beat_ids.at(-1), beatPlan.beats[0].visual_beat_id);
  const receipt = JSON.parse(await fs.readFile(result.receipt_path));
  assert.deepEqual(receipt.reference_changes[0].added_memory_beat_ids, [beatPlan.beats[0].visual_beat_id]);
  assert.equal(receipt.provider_calls, 0);
} finally {
  await fs.rm(path.dirname(memoryBinding.episodeDir), { recursive: true, force: true });
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
async function locationFixture() {
  const test = await fixture();
  const { file } = test;
  const rewrite = async (name, value) => { await fs.writeFile(file(name), bytes(value)); return sha(await fs.readFile(file(name))); };
  const beatPlan = JSON.parse(await fs.readFile(file("visual_beat_plan.json")));
  beatPlan.beats[0].scene_id = "scene_072";
  beatPlan.beats[1].scene_id = "scene_073";
  for (let index = 1; index < 10; index += 1) {
    const clone = structuredClone(beatPlan.beats[1]);
    clone.visual_beat_id = `beat_scene_073_${String(index + 1).padStart(2, "0")}`;
    clone.image_id_hint = `ep_01-scene-073-${String(index + 1).padStart(2, "0")}`;
    clone.source_atom_ids = [`atom_073_${index + 1}`];
    clone.source_word_start_index += index * 20;
    clone.source_word_end_index += index * 20;
    clone.start_sec += index * 6;
    beatPlan.beats.push(clone);
  }
  for (const beat of beatPlan.beats) {
    beat.location_id = "bellmouth_medical_tents";
    beat.location = "Medical tents outside Bellmouth";
    beat.local_location = beat.location;
    beat.active_state_constraints.location_id = beat.location_id;
  }
  const beatHash = await rewrite("visual_beat_plan.json", beatPlan);
  const approval = JSON.parse(await fs.readFile(file("visual_beat_approval.json")));
  approval.visual_beat_plan_sha256 = beatHash;
  approval.grouping_lock_sha256 = groupingLockHash(beatPlan.beats);
  const approvalHash = await rewrite("visual_beat_approval.json", approval);
  const firstId = beatPlan.beats[0].visual_beat_id;
  const sceneBeatIds = beatPlan.beats.filter((beat) => beat.scene_id === "scene_073").map((beat) => beat.visual_beat_id);
  const ledger = {
    status: "passed", contract_count: 2,
    contracts: [
      { location_contract_id: "clinic", description: "Clinic treatment area", prompt_anchor: "Clinic treatment area", scene_ids: ["scene_073"], beat_ids: sceneBeatIds, reasons: ["Holt visits at the clinic."] },
      { location_contract_id: "bellmouth_medical_tents", description: "Roadside medical tents outside Bellmouth", prompt_anchor: "Roadside medical tents outside Bellmouth", scene_ids: ["scene_072"], beat_ids: [firstId], reasons: ["The first treatment happens here."] },
    ],
    scene_contracts: [
      { scene_id: "scene_072", location_contract_id: "bellmouth_medical_tents", location: "Medical tents outside Bellmouth" },
      { scene_id: "scene_073", location_contract_id: "clinic", location: "Clinic treatment area" },
    ],
  };
  const ledgerHash = await rewrite("location_contract_ledger.json", ledger);
  const inventory = JSON.parse(await fs.readFile(file("reference_inventory_ledger.json")));
  const plan = JSON.parse(await fs.readFile(file("visual_reference_plan.json")));
  for (let index = 0; index < 92; index += 1) {
    const target = { ...structuredClone(plan.reference_targets[0]), ref_id: `unchanged_selected_ref_${String(index).padStart(2, "0")}` };
    plan.reference_targets.push(target);
    inventory.assets.push(structuredClone(target));
  }
  const inventoryHash = await rewrite("reference_inventory_ledger.json", inventory);
  plan.source_hashes[file("visual_beat_plan.json")] = beatHash;
  plan.source_hashes[file("reference_inventory_ledger.json")] = inventoryHash;
  plan.source_hashes[file("location_contract_ledger.json")] = ledgerHash;
  const planHash = await rewrite("visual_reference_plan.json", plan);
  const states = JSON.parse(await fs.readFile(file("character_state_refs.json")));
  states.source_hashes[file("visual_reference_plan.json")] = planHash;
  const stateHash = await rewrite("character_state_refs.json", states);
  test.spec.expected = {
    ...test.spec.expected,
    visual_beat_plan_sha256: beatHash,
    visual_beat_approval_sha256: approvalHash,
    visual_reference_plan_sha256: planHash,
    reference_inventory_ledger_sha256: inventoryHash,
    character_state_refs_sha256: stateHash,
    location_contract_ledger_sha256: ledgerHash,
  };
  delete test.spec.beat_location_patches;
  delete test.spec.reference_patches;
  delete test.spec.state_ref_patches;
  test.spec.location_contract_patches = [{
    scene_id: "scene_073", beat_ids: sceneBeatIds,
    from_contract_id: "clinic", from_location: "Clinic treatment area",
    to_contract_id: "bellmouth_medical_tents", to_location: "Medical tents outside Bellmouth",
    from_reason_remove: "Holt visits at the clinic.",
    to_reason_add: "Holt visits in the continuing roadside treatment bay.",
  }];
  return test;
}

const location = await locationFixture();
try {
  const originalPlan = JSON.parse(await fs.readFile(location.file("visual_reference_plan.json")));
  const originalLedger = JSON.parse(await fs.readFile(location.file("location_contract_ledger.json")));
  const wrongHash = structuredClone(location.spec);
  wrongHash.expected.location_contract_ledger_sha256 = "0".repeat(64);
  await assert.rejects(repairReferencePlanExact({ episodeDir: location.episodeDir, spec: wrongHash, currentStage: "reference_plan_approval" }), /SHA-256 does not match/);
  const partial = structuredClone(location.spec);
  partial.location_contract_patches[0].beat_ids = ["beat_not_in_scene"];
  await assert.rejects(repairReferencePlanExact({ episodeDir: location.episodeDir, spec: partial, currentStage: "reference_plan_approval" }), /every current beat/);
  assert.equal(sha(await fs.readFile(location.file("location_contract_ledger.json"))), location.spec.expected.location_contract_ledger_sha256);
  const result = await repairReferencePlanExact({ episodeDir: location.episodeDir, spec: location.spec, currentStage: "reference_plan_approval" });
  assert.equal(result.status, "passed");
  assert.equal(result.location_contract_count, 1);
  assert.equal(result.beat_count, 0);
  assert.equal(result.reference_count, 0);
  assert.equal(sha(await fs.readFile(location.file("visual_beat_plan.json"))), location.spec.expected.visual_beat_plan_sha256);
  assert.equal(sha(await fs.readFile(location.file("visual_beat_approval.json"))), location.spec.expected.visual_beat_approval_sha256);
  const updatedLedger = JSON.parse(await fs.readFile(location.file("location_contract_ledger.json")));
  const updatedPlan = JSON.parse(await fs.readFile(location.file("visual_reference_plan.json")));
  const updatedStates = JSON.parse(await fs.readFile(location.file("character_state_refs.json")));
  const expectedLedger = structuredClone(originalLedger);
  expectedLedger.contracts[0].scene_ids = [];
  expectedLedger.contracts[0].beat_ids = [];
  expectedLedger.contracts[0].reasons = [];
  expectedLedger.contracts[1].scene_ids.push("scene_073");
  expectedLedger.contracts[1].beat_ids.push(...location.spec.location_contract_patches[0].beat_ids);
  expectedLedger.contracts[1].reasons.push("Holt visits in the continuing roadside treatment bay.");
  expectedLedger.scene_contracts[1].location_contract_id = "bellmouth_medical_tents";
  expectedLedger.scene_contracts[1].location = "Medical tents outside Bellmouth";
  expectedLedger.updated_at = updatedLedger.updated_at;
  assert.deepEqual(updatedLedger, expectedLedger);
  assert.deepEqual(updatedLedger.contracts[0].scene_ids, []);
  assert.deepEqual(updatedLedger.contracts[0].beat_ids, []);
  assert.deepEqual(updatedLedger.contracts[1].scene_ids, ["scene_072", "scene_073"]);
  assert.equal(updatedLedger.scene_contracts[1].location_contract_id, "bellmouth_medical_tents");
  assert.deepEqual(updatedLedger.scene_contracts[0], originalLedger.scene_contracts[0]);
  assert.deepEqual(updatedLedger.contracts[0].reasons, []);
  assert.deepEqual(updatedLedger.contracts[1].reasons, ["The first treatment happens here.", "Holt visits in the continuing roadside treatment bay."]);
  assert.equal(updatedPlan.source_hashes[location.file("location_contract_ledger.json")], sha(await fs.readFile(location.file("location_contract_ledger.json"))));
  assert.deepEqual(updatedPlan.reference_targets, originalPlan.reference_targets);
  assert.equal(updatedPlan.reference_targets.length, 94);
  assert.deepEqual(updatedPlan.reference_targets.map((row) => row.ref_id), originalPlan.reference_targets.map((row) => row.ref_id));
  assert.equal(sha(await fs.readFile(location.file("reference_inventory_ledger.json"))), location.spec.expected.reference_inventory_ledger_sha256);
  assert.equal(updatedStates.source_hashes[location.file("visual_reference_plan.json")], sha(await fs.readFile(location.file("visual_reference_plan.json"))));
  assert.equal(referencePlanApprovalMatches({ approval: { status: "approved", visual_reference_plan_sha256: location.spec.expected.visual_reference_plan_sha256 }, plan: updatedPlan, fileSha256: sha(await fs.readFile(location.file("visual_reference_plan.json"))) }), false);
  const receipt = JSON.parse(await fs.readFile(result.receipt_path));
  assert.equal(receipt.location_contract_changes.length, 1);
  assert.equal(receipt.location_contract_changes[0].scene_id, "scene_073");
  assert.deepEqual(receipt.location_contract_changes[0].beat_ids, location.spec.location_contract_patches[0].beat_ids);
  assert.equal(receipt.provider_calls, 0);
  assert.equal(sha(await fs.readFile(receipt.before_snapshots["location_contract_ledger.json"])), location.spec.expected.location_contract_ledger_sha256);
  const approvalCall = spawnSync(process.execPath, [path.resolve("scripts/visual-reference-plan-approve.mjs"), "--episode-dir", location.episodeDir, "--note", "Reviewed exact location contract"], { encoding: "utf8" });
  assert.equal(approvalCall.status, 0, approvalCall.stderr);
} finally {
  await fs.rm(path.dirname(location.episodeDir), { recursive: true, force: true });
}
const locationSpent = await locationFixture();
try {
  await fs.mkdir(path.join(locationSpent.episodeDir, "assets", "images", "references"), { recursive: true });
  await fs.writeFile(path.join(locationSpent.episodeDir, "assets", "images", "references", "generated.png"), "image bytes");
  await assert.rejects(repairReferencePlanExact({ episodeDir: locationSpent.episodeDir, spec: locationSpent.spec, currentStage: "reference_plan_approval" }), /pre-spend repair is closed/);
  assert.equal(sha(await fs.readFile(locationSpent.file("location_contract_ledger.json"))), locationSpent.spec.expected.location_contract_ledger_sha256);
} finally {
  await fs.rm(path.dirname(locationSpent.episodeDir), { recursive: true, force: true });
}
console.log("reference-plan location contract repair tests passed");
