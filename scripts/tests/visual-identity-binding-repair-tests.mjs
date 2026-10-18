import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bindVisibleIdentity, identityBindingRepairAdmission, validateEditorialReplacement,
  repairIdentityBindings } from "../lib/visual-identity-binding-repair.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const names = {
  run_identity: "run_identity.json", script: "script_clean.md", beat_plan: "visual_beat_plan.json",
  beat_approval: "visual_beat_approval.json", reference_plan: "visual_reference_plan.json",
  reference_plan_approval: "reference_plan_approval.json", reference_image_approval: "visual_reference_approval_ep_01.json",
  base_prompt_plan: "section_image_prompts.json", reviewed_prompt_plan: "section_image_prompts_reviewed.json",
  harden_report: "visual_prompt_hardening_ep_01.json", manual_review: "visual_manual_agent_review_ep_01.json",
};
const target = { ref_id: "joey_state", kind: "character_state", canonical_subject_id: "joey",
  scene_ids: ["scene_002"], conditioning_asset_role: "identity_state", identity_usage: "full_identity" };
const location = { ref_id: "exit_location", kind: "location", slot_order: 1, required: true, reason: "exit geography" };
const row = {
  image_id: "ep_01-cut-002", visual_beat_id: "beat_w000020_w000030", scene_id: "scene_002",
  visual_beat_script_excerpt: "Joey hands the injured to the responders.",
  provider_prompt: "Joey, bloodstained and injured, hands a patient to responders at the exit.",
  image_prompt: "Joey, bloodstained and injured, hands a patient to responders at the exit.",
  prompt_hash: sha("Joey, bloodstained and injured, hands a patient to responders at the exit."),
  reference_requirements: [location], reference_usage: [], anchor_roles: [], character_state_refs_used: [],
  shot_manifest: { visible_characters: ["Joey", "Responder"], reference_slots: [location],
    forbidden_ref_ids: [], character_state_ref_ids: [], protagonist_state_ref_id: null,
    character_staging: [{ name: "Joey", ref_id: null, wardrobe_from: "bloodstained workwear" }],
    anatomy_contracts: [{ entity: "Joey", identity_ref_id: null }] },
};
const binding = { image_id: row.image_id, visual_beat_id: row.visual_beat_id, character: "Joey", ref_id: "joey_state",
  replace_ref_id: null, stale_staging_ref_id: null, remove_forbidden_ref_id: null, slot_order: 2,
  old_row_sha256: sha(json(row)), approved_reference_sha256: null,
  wardrobe_from: "character_state_ref:joey_state", reason: "Approved wounded state matches this handoff." };

const root = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-identity-binding-"));
try {
  const dir = path.join(root, "ep_01");
  await fs.mkdir(dir);
  const rasterPath = path.join(root, "approved-ref.png");
  await fs.writeFile(rasterPath, "approved fixture raster");
  binding.approved_reference_sha256 = sha(await fs.readFile(rasterPath));
  const approved = { status: "approved", reference_decisions: [{ ref_id: "joey_state", status: "approved_clean",
    reference_image_path: rasterPath, reference_image_sha256: binding.approved_reference_sha256 }],
  reference_hash_by_ref_id: { joey_state: binding.approved_reference_sha256 } };
  const contents = {
    run_identity: { schema: "goldflow_run_identity_v2" }, script: "Joey hands the injured to the responders.\n",
    beat_plan: { status: "passed", beats: [{ visual_beat_id: row.visual_beat_id, image_id_hint: row.image_id, scene_id: row.scene_id },
      { image_id_hint: "ep_01-event", start_sec: 5, visual_beat_script_excerpt: "The shoulder cut begins." }] },
    beat_approval: { status: "approved" }, reference_plan: { status: "passed", reference_targets: [target] },
    reference_plan_approval: { status: "approved", selected_targets: [{ ref_id: "joey_state", scene_ids: ["scene_002"] }] },
    reference_image_approval: approved, base_prompt_plan: { status: "passed", prompts: [row] },
    reviewed_prompt_plan: { status: "needs_manual_agent_review", prompts: [row] },
    harden_report: { status: "blocked", unresolved_blocker_count: 1, findings: [{ image_id: row.image_id,
      code: "required_source_identity_ambiguous", character: "Joey", available_ref_ids: ["joey_state"],
      severity: "blocker", resolved: false }] },
    manual_review: { status: "needs_manual_agent_review", image_ids: [row.image_id],
      unresolved_blockers: [{ image_id: row.image_id, code: "required_source_identity_ambiguous" }] },
  };
  approved.visual_reference_plan_hash = sha(json(contents.reference_plan));
  const expected = {};
  for (const [key, name] of Object.entries(names)) {
    const bytes = name.endsWith(".json") ? json(contents[key]) : contents[key];
    await fs.writeFile(path.join(dir, name), bytes);
    expected[key] = sha(bytes);
  }
  const spec = { schema: "goldflow_visual_identity_binding_repair_v1", episode: "ep_01", expected,
    bindings: [binding], continuity_scope: { character: "Joey", canonical_subject_id: "joey",
      old_ref_id: "old_full_state", new_ref_id: "joey_face", active_wardrobe_phrase: "coat cut across the shoulder" },
    temporal_scope: { character: "Joey", canonical_subject_id: "joey", old_ref_id: "old_wounded_state",
      new_ref_id: "joey_state", pre_event_wardrobe: "sleeve torn by a bolt", event_image_id: "ep_01-event",
      event_source_phrase: "The shoulder cut begins." },
    editorial_repairs: [],
    reviewer: "Codex", note: "Exact wounded handoff identity selected from approved references." };
  const specPath = path.join(root, "spec.json");
  await fs.writeFile(specPath, json(spec));
  const status = { episode_dir: dir, identity: { schema: "goldflow_run_identity_v2" },
    media_workflow: { id: "generated_visuals_v1" }, current_stage: "visual_prompt_harden",
    current_stage_state: "blocked", next_command_shape: "visual repair-identity-binding", stage_ledger: [] };
  assert.equal(identityBindingRepairAdmission(status, { "episode-dir": dir, "repair-spec": specPath }).allowed, true);
  assert.equal(identityBindingRepairAdmission({ ...status, stage_ledger: [{ stage: "image_generation", state: "passed" }] },
    { "episode-dir": dir, "repair-spec": specPath }).allowed, false);
  await assert.rejects(repairIdentityBindings({ episodeDir: dir, specPath,
    spec: { ...spec, expected: { ...expected, script: "0".repeat(64) } }, status }), /changed since review/);
  await assert.rejects(repairIdentityBindings({ episodeDir: dir, specPath,
    spec: { ...spec, bindings: [{ ...binding, approved_reference_sha256: "0".repeat(64) }] }, status }), /approved scoped reference/);
  const result = await repairIdentityBindings({ episodeDir: dir, specPath, spec, status });
  assert.equal(result.repaired_cut_count, 1);
  // Plain missing-identity repair must not invent a wardrobe migration or an
  // injury event merely to satisfy an older recovery contract.
  const plainDir = path.join(root, "plain", "ep_01");
  await fs.mkdir(plainDir, { recursive: true });
  for (const [key, name] of Object.entries(names)) {
    await fs.writeFile(path.join(plainDir, name), name.endsWith(".json") ? json(contents[key]) : contents[key]);
  }
  const plainSpec = { ...spec, continuity_scope: null, temporal_scope: null };
  const plainSpecPath = path.join(root, "plain-spec.json");
  await fs.writeFile(plainSpecPath, json(plainSpec));
  const plainResult = await repairIdentityBindings({ episodeDir: plainDir, specPath: plainSpecPath,
    spec: plainSpec, status: { ...status, episode_dir: plainDir } });
  assert.equal(plainResult.repaired_cut_count, 1);
  const after = JSON.parse(await fs.readFile(path.join(dir, names.reviewed_prompt_plan)));
  assert.equal(after.status, "passed");
  assert.deepEqual(after.prompts[0].reference_requirements.map((item) => item.ref_id), ["exit_location", "joey_state"]);
  assert.equal(after.prompts[0].provider_prompt, row.provider_prompt);
  const receipt = JSON.parse(await fs.readFile(result.receipt_path));
  assert.equal(receipt.provider_calls, 0);
  assert.equal(sha(await fs.readFile(receipt.before_snapshot_path)), expected.reviewed_prompt_plan);

  const face = { ref_id: "joey_face", kind: "character_state", identity_usage: "face_only", conditioning_asset_role: "identity_state" };
  const conflict = structuredClone(row);
  conflict.reference_requirements.push({ ref_id: "old_full_state", kind: "character_state", slot_order: 2 });
  conflict.shot_manifest.reference_slots.push({ ref_id: "old_full_state", kind: "character_state", slot_order: 2 });
  conflict.shot_manifest.character_staging[0].ref_id = "old_full_state";
  conflict.shot_manifest.character_state_ref_ids = ["old_full_state"];
  conflict.shot_manifest.forbidden_ref_ids = ["joey_face"];
  const switched = bindVisibleIdentity(conflict, { ...binding, ref_id: "joey_face", replace_ref_id: "old_full_state",
    remove_forbidden_ref_id: "joey_face", wardrobe_from: "current cut shoulder, face-only reference",
    reason: "Current wound disallows intact full-state plate." }, face);
  assert.deepEqual(switched.reference_requirements.map((item) => item.ref_id), ["exit_location", "joey_face"]);
  assert.deepEqual(switched.shot_manifest.forbidden_ref_ids, []);
  assert.equal(switched.shot_manifest.character_staging[0].wardrobe_from, "current cut shoulder, face-only reference");
  assert.equal(switched.provider_prompt, conflict.provider_prompt);
  assert.throws(() => bindVisibleIdentity(conflict, { ...binding, ref_id: "joey_face", replace_ref_id: "old_full_state",
    remove_forbidden_ref_id: null }, face), /Exact visible identity context/);
  const dropped = structuredClone(row);
  dropped.shot_manifest.character_staging[0].ref_id = "joey_crown_wounded";
  dropped.shot_manifest.character_staging[0].wardrobe_from = "character_state_ref:joey_crown_wounded";
  dropped.character_state_refs_used = ["joey_crown_wounded"];
  dropped.reference_usage = [{ ref_id: "joey_crown_wounded", usage: "out_of_scope_ref_dropped" }];
  dropped.anchor_roles = [{ ref_id: "joey_crown_wounded", kind: "character_state" }];
  const rebound = bindVisibleIdentity(dropped, { ...binding, ref_id: "joey_face",
    stale_staging_ref_id: "joey_crown_wounded", remove_forbidden_ref_id: null,
    wardrobe_from: "current coat cut across shoulder; face-only reference supplies likeness" }, face);
  assert.equal(rebound.shot_manifest.character_staging[0].ref_id, "joey_face");
  assert.equal(rebound.shot_manifest.character_staging[0].wardrobe_from.includes("joey_crown_wounded"), false);
  assert.equal(JSON.stringify([rebound.reference_requirements, rebound.reference_usage,
    rebound.anchor_roles, rebound.character_state_refs_used]).includes("joey_crown_wounded"), false);
  const tooEarly = structuredClone(conflict);
  tooEarly.provider_prompt = "Joey's dark coat has a heat-cut shoulder and small wound; one sleeve is torn by a bolt.";
  tooEarly.image_prompt = tooEarly.provider_prompt;
  tooEarly.prompt_hash = sha(tooEarly.provider_prompt);
  tooEarly.shot_manifest.continuity_notes = "Joey's shoulder wound and torn sleeve persist.";
  const correctedPrompt = "Joey's dark coat has an intact shoulder; one sleeve is torn by a bolt.";
  const temporalBinding = { ...binding, ref_id: "joey_state", replace_ref_id: "old_full_state",
    wardrobe_from: "current beat: expedition coat with bolt-torn sleeve; shoulder intact",
    temporal_correction: { prompt_changes: [{ before: "a heat-cut shoulder and small wound", to: "an intact shoulder" }],
      replacement_prompt: correctedPrompt,
      continuity_notes: { before: "Joey's shoulder wound and torn sleeve persist.",
        to: "Joey's bolt-torn sleeve persists; shoulder intact." }, body_invariant: null } };
  const temporalCorrected = bindVisibleIdentity(tooEarly, temporalBinding, target);
  assert.equal(temporalCorrected.provider_prompt, correctedPrompt);
  assert.equal(temporalCorrected.prompt_hash, sha(correctedPrompt));
  assert.equal(temporalCorrected.shot_manifest.continuity_notes.includes("wound"), false);
  assert.throws(() => bindVisibleIdentity(tooEarly, { ...temporalBinding,
    temporal_correction: { ...temporalBinding.temporal_correction,
      replacement_prompt: "A completely different scene." } }, target), /fully reviewed/);

  const lexicalOld = structuredClone(row);
  lexicalOld.reference_requirements = [];
  lexicalOld.shot_manifest.reference_slots = [];
  const lexicalNew = structuredClone(lexicalOld);
  lexicalNew.provider_prompt = lexicalNew.provider_prompt.replace("bloodstained", "dusty");
  lexicalNew.image_prompt = lexicalNew.provider_prompt;
  lexicalNew.prompt_hash = sha(lexicalNew.provider_prompt);
  const lexicalRepair = { image_id: lexicalOld.image_id, visual_beat_id: lexicalOld.visual_beat_id,
    old_row_sha256: sha(json(lexicalOld)), source_quote: "Joey hands the injured", reason: "Exact source-grounded descriptor.",
    text_changes: [{ before: "bloodstained", to: "dusty" }], manual_full_prompt_reviewed: false,
    replacement_row: lexicalNew };
  await validateEditorialReplacement(lexicalOld, lexicalRepair, { reference_targets: [] },
    { reference_decisions: [], reference_hash_by_ref_id: {} }, { selected_targets: [] });
  await assert.rejects(validateEditorialReplacement(lexicalOld, { ...lexicalRepair,
    replacement_row: { ...lexicalNew, scene_id: "scene_wrong" } }, { reference_targets: [] },
  { reference_decisions: [], reference_hash_by_ref_id: {} }, { selected_targets: [] }), /immutable cut fields/);
  const memoryOld = { ...structuredClone(lexicalOld), depiction_mode: "memory_or_flashback" };
  const memoryNew = structuredClone(memoryOld);
  memoryNew.provider_prompt = "Earlier at the family home, Caleb alone secretly smears the pack before the handoff.";
  memoryNew.image_prompt = memoryNew.provider_prompt;
  memoryNew.prompt_hash = sha(memoryNew.provider_prompt);
  memoryNew.shot_manifest.visible_characters = ["Responder"];
  memoryNew.shot_manifest.character_staging = [];
  memoryNew.shot_manifest.anatomy_contracts = [];
  memoryNew.visible_subjects = [];
  const memoryRepair = { image_id: memoryOld.image_id, visual_beat_id: memoryOld.visual_beat_id,
    old_row_sha256: sha(json(memoryOld)), source_quote: "Joey hands the injured", reason: "Earlier source memory, not current state.",
    manual_full_prompt_reviewed: true, replacement_row: memoryNew };
  await validateEditorialReplacement(memoryOld, memoryRepair, { reference_targets: [] },
    { reference_decisions: [], reference_hash_by_ref_id: {} }, { selected_targets: [] });
  await assert.rejects(validateEditorialReplacement(memoryOld, { ...memoryRepair,
    replacement_row: { ...memoryNew, visual_beat_script_excerpt: "Invented source" } }, { reference_targets: [] },
  { reference_decisions: [], reference_hash_by_ref_id: {} }, { selected_targets: [] }), /immutable cut fields/);
  await assert.rejects(validateEditorialReplacement({ ...memoryOld, depiction_mode: "present" },
    { ...memoryRepair, old_row_sha256: sha(json({ ...memoryOld, depiction_mode: "present" })),
      replacement_row: { ...memoryNew, depiction_mode: "present" } },
    { reference_targets: [] }, { reference_decisions: [], reference_hash_by_ref_id: {} },
    { selected_targets: [] }), /reviewed memory cut/);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
console.log("Exact visual identity binding repair tests passed.");
