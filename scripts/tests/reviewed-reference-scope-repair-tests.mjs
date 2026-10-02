import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { referencePlanApprovalContractSha256 } from "../lib/reference-plan-contract.mjs";
import { repairReviewedReferenceScope, reviewedReferenceScopeRepairAdmission } from "../lib/reviewed-reference-scope-repair.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const names = {
  run_identity: "run_identity.json", script: "script_clean.md", beat_plan: "visual_beat_plan.json",
  beat_approval: "visual_beat_approval.json", inventory: "reference_inventory_ledger.json",
  reference_plan: "visual_reference_plan.json", character_refs: "character_state_refs.json",
  reference_plan_approval: "reference_plan_approval.json",
  reference_image_approval: "visual_reference_approval_ep_01.json",
  base_prompt_plan: "section_image_prompts.json",
  reviewed_prompt_plan: "section_image_prompts_reviewed.json",
  harden_report: "visual_prompt_hardening_ep_01.json",
  manual_review: "visual_manual_agent_review_ep_01.json",
};

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-reviewed-scope-"));
  const dir = path.join(root, "ep_01");
  await fs.mkdir(dir);
  const raster = path.join(dir, "ironback.png");
  await fs.writeFile(raster, "accepted raster bytes");
  const rasterHash = hash(await fs.readFile(raster));
  const oldScenes = ["scene_001"];
  const target = { ref_id: "ironback_identity_ref", kind: "character_state", conditioning_asset_role: "creature_identity", canonical_subject_id: "ironbacks",
    scene_ids: oldScenes, planned_beat_ids: ["beat_old"], reference_image_path: raster };
  const state = { state_ref_id: target.ref_id, character: "Ironbacks", identity_subtype: "creature", scene_ids: oldScenes,
    reference_image_path: raster };
  const asset = { asset_id: "char_ironbacks", ref_id: target.ref_id, canonical_subject_id: "ironbacks",
    scene_ids: oldScenes, planned_beat_ids: ["beat_old"] };
  const excerpt = "A smaller ironback came over the rail.";
  const cut = { image_id: "ep_01-w000001-w000006", image_id_hint: "ep_01-w000001-w000006", visual_beat_id: "beat_new", scene_id: "scene_002",
    visual_beat_script_excerpt: excerpt, physically_visible_entity_ids: ["ironbacks"] };
  const row = { image_id: cut.image_id, visual_beat_id: cut.visual_beat_id, scene_id: cut.scene_id,
    shot_manifest: { visible_characters: ["Ironbacks"] }, provider_prompt: "One ironback on the rail." };
  const files = {
    run_identity: { schema: "goldflow_run_identity_v2" }, script: excerpt,
    beat_plan: { status: "passed", beats: [cut] }, beat_approval: { status: "approved" },
    inventory: { status: "passed", assets: [asset] },
    reference_plan: { status: "passed", source_hashes: {}, reference_targets: [target], character_state_refs: [state] },
    character_refs: { status: "approved", source_hashes: {}, character_state_refs: [state] },
    reference_plan_approval: { status: "approved", selected_targets: [{ ref_id: target.ref_id, kind: "character_state", scene_ids: oldScenes }] },
    reference_image_approval: { status: "approved", materialized_reference_count: 1,
      reference_decisions: [{ ref_id: target.ref_id, status: "approved_clean", reference_image_path: raster,
        reference_image_sha256: rasterHash }], reference_hash_by_ref_id: { [target.ref_id]: rasterHash } },
    base_prompt_plan: { status: "passed", source_hashes: {}, prompts: [row] },
    reviewed_prompt_plan: { status: "needs_manual_agent_review", source_hashes: {}, prompts: [row],
      visual_manual_agent_review_path: path.join(dir, names.manual_review) },
    harden_report: { status: "blocked", findings: [{ severity: "blocker", resolved: false,
      code: "visible_character_ref_scope_missing", image_id: cut.image_id, character: "Ironbacks",
      out_of_scope_ref_ids: [target.ref_id] }] },
    manual_review: { status: "needs_manual_agent_review", image_ids: [cut.image_id],
      unresolved_blockers: [{ image_id: cut.image_id, code: "visible_character_ref_scope_missing" }] },
  };
  const save = async (key) => fs.writeFile(path.join(dir, names[key]), key === "script" ? files[key] : json(files[key]));
  for (const key of ["run_identity", "script", "beat_plan", "beat_approval", "inventory"]) await save(key);
  files.reference_plan.source_hashes[path.join(dir, names.inventory)] = hash(await fs.readFile(path.join(dir, names.inventory)));
  await save("reference_plan");
  const planHash = hash(await fs.readFile(path.join(dir, names.reference_plan)));
  files.character_refs.source_hashes[path.join(dir, names.reference_plan)] = planHash;
  await save("character_refs");
  files.reference_plan_approval.visual_reference_plan_sha256 = planHash;
  files.reference_plan_approval.reference_plan_contract_sha256 = referencePlanApprovalContractSha256(files.reference_plan);
  await save("reference_plan_approval");
  files.reference_image_approval.visual_reference_plan_hash = planHash;
  await save("reference_image_approval");
  for (const key of ["base_prompt_plan", "reviewed_prompt_plan"]) {
    for (const dep of ["reference_plan", "character_refs", "reference_plan_approval"]) {
      files[key].source_hashes[path.join(dir, names[dep])] = hash(await fs.readFile(path.join(dir, names[dep])));
    }
    await save(key);
  }
  for (const key of ["harden_report", "manual_review"]) await save(key);
  const expected = {};
  for (const [key, name] of Object.entries(names)) expected[key] = hash(await fs.readFile(path.join(dir, name)));
  const spec = { schema: "goldflow_reviewed_reference_scope_repair_v1", episode: "ep_01", expected,
    scope: { ref_id: target.ref_id, asset_id: asset.asset_id, canonical_subject_id: "ironbacks",
      visible_character: "Ironbacks", old_scene_ids: oldScenes, add_scene_ids: ["scene_002"],
      approved_reference_sha256: rasterHash,
      cuts: [{ image_id: cut.image_id, visual_beat_id: cut.visual_beat_id, scene_id: cut.scene_id,
        source_quote: excerpt, old_reviewed_row_sha256: hash(json(row)) }] },
    reviewer: "test-reviewer", note: "Source and accepted raster reviewed." };
  const specPath = path.join(root, "repair.json");
  await fs.writeFile(specPath, json(spec));
  const status = { episode_dir: dir, identity: { schema: "goldflow_run_identity_v2" },
    media_workflow: { id: "generated_visuals_v1" }, current_stage: "visual_prompt_harden",
    current_stage_state: "blocked", next_command_shape: "Manual agent review required", stage_ledger: [] };
  return { root, dir, raster, rasterHash, spec, specPath, status, row, cut };
}

const first = await fixture();
try {
  assert.equal(reviewedReferenceScopeRepairAdmission(first.status,
    { "episode-dir": first.dir, "repair-spec": first.specPath }).allowed, true);
  const dry = await repairReviewedReferenceScope({ episodeDir: first.dir, specPath: first.specPath,
    spec: first.spec, status: first.status, dryRun: true });
  assert.equal(dry.status, "validated");
  assert.equal(hash(await fs.readFile(path.join(first.dir, names.reference_plan))), first.spec.expected.reference_plan);
  const result = await repairReviewedReferenceScope({ episodeDir: first.dir, specPath: first.specPath,
    spec: first.spec, status: first.status });
  assert.equal(result.provider_calls, 0);
  assert.equal(result.prompt_rows_changed, 0);
  const read = async (name) => JSON.parse(await fs.readFile(path.join(first.dir, name)));
  const plan = await read(names.reference_plan);
  const inventory = await read(names.inventory);
  const refs = await read(names.character_refs);
  const planApproval = await read(names.reference_plan_approval);
  const imageApproval = await read(names.reference_image_approval);
  const base = await read(names.base_prompt_plan);
  const reviewed = await read(names.reviewed_prompt_plan);
  assert.deepEqual(plan.reference_targets[0].scene_ids, ["scene_001", "scene_002"]);
  assert.deepEqual(inventory.assets[0].planned_beat_ids, ["beat_old", "beat_new"]);
  assert.deepEqual(refs.character_state_refs[0].scene_ids, ["scene_001", "scene_002"]);
  assert.deepEqual(planApproval.selected_targets[0].scene_ids, ["scene_001", "scene_002"]);
  assert.equal(planApproval.reference_plan_contract_sha256, referencePlanApprovalContractSha256(plan));
  assert.equal(imageApproval.visual_reference_plan_hash, hash(await fs.readFile(path.join(first.dir, names.reference_plan))));
  assert.equal(hash(await fs.readFile(first.raster)), first.rasterHash);
  assert.deepEqual(base.prompts, [first.row]);
  assert.deepEqual(reviewed.prompts, [first.row]);
  assert.equal(reviewed.status, "passed");
  assert.equal(reviewed.visual_manual_agent_review_path, undefined);
  const receipt = JSON.parse(await fs.readFile(result.receipt_path));
  assert.equal(receipt.materialized_refs_changed, 0);
  assert.equal(receipt.prompt_rows_changed, 0);
  assert.equal(receipt.accepted_raster_hashes.ironback_identity_ref, first.rasterHash);
  await assert.rejects(() => repairReviewedReferenceScope({ episodeDir: first.dir, specPath: first.specPath,
    spec: first.spec, status: first.status }), /changed since review/);
} finally { await fs.rm(first.root, { recursive: true, force: true }); }

for (const mutation of [
  (ctx) => { ctx.spec.scope.cuts[0].source_quote = "Invented creature."; },
  (ctx) => { ctx.spec.scope.add_scene_ids = ["scene_099"]; },
  (ctx) => { ctx.status.stage_ledger = [{ stage: "image_generation", state: "running" }]; },
]) {
  const ctx = await fixture();
  try {
    mutation(ctx);
    await assert.rejects(() => repairReviewedReferenceScope({ episodeDir: ctx.dir, specPath: ctx.specPath,
      spec: ctx.spec, status: ctx.status }));
    assert.equal(hash(await fs.readFile(path.join(ctx.dir, names.reference_plan))), ctx.spec.expected.reference_plan);
    assert.equal(hash(await fs.readFile(ctx.raster)), ctx.rasterHash);
  } finally { await fs.rm(ctx.root, { recursive: true, force: true }); }
}

console.log("Reviewed reference scope repair tests passed.");
