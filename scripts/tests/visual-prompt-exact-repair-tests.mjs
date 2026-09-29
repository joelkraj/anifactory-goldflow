import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyExactPromptText, exactVisualPromptRepairAdmission, repairVisualPromptExact } from "../lib/visual-prompt-exact-repair.mjs";
import { commandStageFor } from "../lib/pipeline-stage-registry.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const stage = (name, state) => ({ stage: name, state });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-exact-prompt-"));
  const episodeDir = path.join(root, "ep_01");
  await fs.mkdir(episodeDir);
  const put = async (name, value) => { const bytes = typeof value === "string" ? Buffer.from(value) : json(value);
    await fs.writeFile(path.join(episodeDir, name), bytes); return hash(bytes); };
  const expected = {};
  expected.run_identity_sha256 = await put("run_identity.json", { schema: "goldflow_run_identity_v2" });
  expected.source_script_sha256 = await put("script_clean.md", "A source line.\n");
  const beat = { visual_beat_id: "beat_w000000_w000003", scene_id: "scene_001", parent_scene_id: "scene_001" };
  expected.visual_beat_plan_sha256 = await put("visual_beat_plan.json", { status: "passed", beats: [beat] });
  expected.visual_reference_plan_sha256 = await put("visual_reference_plan.json", { status: "passed",
    reference_targets: [{ ref_id: "tessa_current", scene_ids: ["scene_001"] }, { ref_id: "tessa_first_life", scene_ids: ["scene_001"] }],
    character_state_refs: [
      { state_ref_id: "tessa_current", character: "Tessa", scene_ids: ["scene_001"] },
      { state_ref_id: "tessa_first_life", character: "Tessa", scene_ids: ["scene_001"] },
    ] });
  expected.reference_plan_approval_sha256 = await put("reference_plan_approval.json", { status: "approved" });
  expected.reference_image_approval_sha256 = await put("visual_reference_approval_ep_01.json", { status: "approved" });
  const original = { image_id: "ep_01-w000000-w000003", visual_beat_id: beat.visual_beat_id, scene_id: beat.scene_id,
    provider_prompt: "Original prompt", image_prompt: "Original prompt", prompt_hash: hash("Original prompt"),
    modelslab_image_prompt: "", codex_image_prompt: null,
    reference_requirements: [{ ref_id: "tessa_current", kind: "character_state", slot_purpose: "Tessa current state" }],
    reference_usage: [{ ref_id: "tessa_current", usage: "attach_existing_ref" }],
    anchor_roles: [{ ref_id: "tessa_current", anchor_role: "source_anchor" }],
    character_state_refs_used: ["tessa_current"],
    required_reference_paths: [], shot_manifest: { visible_characters: ["Tessa"], forbidden_ref_ids: [], character_state_ref_ids: ["tessa_current"],
      protagonist_state_ref_id: "tessa_current", reference_slots: [{ ref_id: "tessa_current", slot_purpose: "Tessa current state" }],
      character_staging: [{ name: "Tessa", ref_id: "tessa_current", wardrobe_from: "character_state_ref:tessa_current", pose: "At work", screen_position: "left" }],
      foreground_action: "Tessa works.", continuity_notes: "Current Tessa has no wrist burn." } };
  expected.prompt_plan_sha256 = await put("section_image_prompts.json", { schema: "goldflow_section_image_prompts_v1", status: "passed",
    source_script_hash: expected.source_script_sha256, source_hashes: {}, prompts: [original] });
  const spec = { schema: "goldflow_visual_prompt_exact_repair_v1", episode: "ep_01", expected,
    image_id: original.image_id, visual_beat_id: beat.visual_beat_id, old_row_sha256: hash(json(original)),
    replacement: { provider_prompt: "Tessa is visibly in the first life. Her right wrist carries the red work band.",
      image_prompt: "Tessa is visibly in the first life. Her right wrist carries the red work band." },
    reviewer: "test-reviewer", note: "Exact reviewed continuity correction before harden.", scope_reviewed: true };
  const specPath = path.join(root, "repair.json"); await fs.writeFile(specPath, json(spec));
  const status = { episode_dir: episodeDir, identity: { schema: "goldflow_run_identity_v2" },
    media_workflow: { id: "generated_visuals_v1" }, current_stage: "visual_prompt_harden", current_stage_state: "missing",
    stage_ledger: [stage("visual_prompt_plan", "passed"), stage("visual_prompt_harden", "missing"), stage("image_generation", "missing")] };
  return { root, episodeDir, spec, specPath, status, original, expected };
}

test("repairs one reviewed row, preserves its refs and every immutable input, and snapshots the original", async () => {
  const f = await fixture();
  try {
    const result = await repairVisualPromptExact(f);
    const plan = JSON.parse(await fs.readFile(path.join(f.episodeDir, "section_image_prompts.json"), "utf8"));
    assert.equal(plan.prompts.length, 1);
    assert.equal(plan.prompts[0].provider_prompt, f.spec.replacement.provider_prompt);
    assert.equal(plan.prompts[0].prompt_hash, hash(f.spec.replacement.provider_prompt));
    assert.deepEqual(plan.prompts[0].reference_requirements, f.original.reference_requirements);
    const receipt = JSON.parse(await fs.readFile(result.receipt_path, "utf8"));
    assert.equal(receipt.provider_calls, 0);
    assert.equal(hash(await fs.readFile(receipt.before_snapshot_path)), f.expected.prompt_plan_sha256);
    assert.equal(receipt.after_plan_sha256, hash(await fs.readFile(path.join(f.episodeDir, "section_image_prompts.json"))));
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("face-donor repair clears contradictory wrist prose across prompt, slot, anatomy, staging and continuity without changing IDs", async () => {
  const f = await fixture();
  try {
    const planPath = path.join(f.episodeDir, "section_image_prompts.json");
    const plan = JSON.parse(await fs.readFile(planPath, "utf8"));
    const row = plan.prompts[0];
    row.provider_prompt = row.image_prompt = "Tessa's wrist is unscarred.";
    row.prompt_hash = hash(row.provider_prompt);
    row.reference_requirements[0].slot_purpose = row.shot_manifest.reference_slots[0].slot_purpose = "Tessa unscarred wrist face and clothing";
    row.reference_requirements[0].reason = row.shot_manifest.reference_slots[0].reason = "Keep Tessa unscarred.";
    row.shot_manifest.anatomy_contracts = [{ entity: "Tessa", identity_ref_id: "tessa_current", body_invariant: "Right wrist unscarred.",
      reason: "Show the unscarred wrist.", expected_visible_hands: 2 }];
    row.shot_manifest.character_staging[0].wardrobe_from = "Tessa unscarred current clothing";
    const oldBytes = json(plan); await fs.writeFile(planPath, oldBytes);
    f.spec.expected.prompt_plan_sha256 = hash(oldBytes);
    f.spec.old_row_sha256 = hash(json(row));
    f.spec.replacement.provider_prompt = f.spec.replacement.image_prompt = "First-life Tessa wears factory work layers; the old right-wrist burn is visible.";
    f.spec.replacement.reference_text_patch = {
      ref_id: "tessa_current", slot_purpose: { before: "Tessa unscarred wrist face and clothing", to: "Tessa face identity only; first-life factory clothes and wrist burn come from scene direction" },
      reason: { before: "Keep Tessa unscarred.", to: "Preserve Tessa's face while depicting her first-life state." },
    };
    f.spec.replacement.anatomy_contract_patch = { entity: "Tessa", identity_ref_id: "tessa_current",
      body_invariant: { before: "Right wrist unscarred.", to: "Old burn mark visible at the right wrist." },
      reason: { before: "Show the unscarred wrist.", to: "The first-life memory requires the old burn." } };
    f.spec.replacement.staging_patch = { name: "Tessa", wardrobe_from: { before: "Tessa unscarred current clothing",
      to: "First-life factory work layers with the old right-wrist burn" } };
    f.spec.replacement.manifest_text_patch = { continuity_notes: { before: "Current Tessa has no wrist burn.",
      to: "This is first-life Tessa, with her old right-wrist burn." } };
    f.spec.replacement.assert_absent_terms = ["unscarred"];
    await fs.writeFile(f.specPath, json(f.spec));
    await repairVisualPromptExact(f);
    const result = JSON.parse(await fs.readFile(planPath, "utf8"));
    assert.equal(JSON.stringify(result.prompts[0]).toLowerCase().includes("unscarred"), false);
    assert.deepEqual(result.prompts[0].reference_requirements.map((item) => item.ref_id), ["tessa_current"]);
    assert.equal(result.prompts[0].shot_manifest.anatomy_contracts[0].expected_visible_hands, 2);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("refuses stale row, changed approved refs, out-of-scope refs, and downstream work without modifying plan", async () => {
  for (const variant of ["row", "refs", "scope", "downstream"]) {
    const f = await fixture();
    try {
      if (variant === "row") f.spec.old_row_sha256 = "0".repeat(64);
      if (variant === "refs") f.spec.expected.visual_reference_plan_sha256 = "0".repeat(64);
      if (variant === "scope") {
        const p = JSON.parse(await fs.readFile(path.join(f.episodeDir, "section_image_prompts.json"), "utf8"));
        p.prompts[0].reference_requirements = [{ ref_id: "wrong_ref" }];
        f.spec.old_row_sha256 = hash(json(p.prompts[0]));
        f.spec.expected.prompt_plan_sha256 = await (async () => { const b = json(p); await fs.writeFile(path.join(f.episodeDir, "section_image_prompts.json"), b); return hash(b); })();
      }
      if (variant === "downstream") f.status.current_stage = "transition_edit_plan";
      await fs.writeFile(f.specPath, json(f.spec));
      const original = await fs.readFile(path.join(f.episodeDir, "section_image_prompts.json"));
      await assert.rejects(repairVisualPromptExact(f));
      assert.deepEqual(await fs.readFile(path.join(f.episodeDir, "section_image_prompts.json")), original);
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  }
});

test("requires one canonical prompt mirror and explicit reviewed scope", async () => {
  assert.equal(commandStageFor("visual", "repair-prompt"), "visual_prompt_plan");
  assert.throws(() => applyExactPromptText({ provider_prompt: "a", image_prompt: "a" },
    { provider_prompt: "new", image_prompt: "different" }));
  const f = await fixture();
  try {
    assert.equal(exactVisualPromptRepairAdmission(f.status, { "episode-dir": f.episodeDir, "repair-spec": f.specPath }).allowed, true);
    assert.equal(exactVisualPromptRepairAdmission(f.status, { "episode-dir": f.episodeDir, "repair-spec": f.specPath, "workflow-bypass": "true" }).allowed, false);
    f.spec.scope_reviewed = false; await fs.writeFile(f.specPath, json(f.spec));
    await assert.rejects(repairVisualPromptExact(f), /incomplete/);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("refuses ID-changing repairs and staging that silently selects another wardrobe reference", async () => {
  const f = await fixture();
  try {
    f.spec.replacement.reference_swap = { from_ref_id: "tessa_current", to_ref_id: "tessa_first_life" };
    await fs.writeFile(f.specPath, json(f.spec));
    await assert.rejects(repairVisualPromptExact(f), /Replacement must contain/);
    delete f.spec.replacement.reference_swap;
    f.spec.replacement.staging_patch = { name: "Tessa", wardrobe_from: { before: "character_state_ref:tessa_current",
      to: "character_state_ref:tessa_first_life" } };
    await fs.writeFile(f.specPath, json(f.spec));
    await assert.rejects(repairVisualPromptExact(f), /cannot change the wardrobe state reference ID/);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("four independent exact cuts can be repaired sequentially before harden without altering earlier corrections", async () => {
  const f = await fixture();
  try {
    const beatPath = path.join(f.episodeDir, "visual_beat_plan.json");
    const planPath = path.join(f.episodeDir, "section_image_prompts.json");
    const beats = JSON.parse(await fs.readFile(beatPath, "utf8"));
    const plan = JSON.parse(await fs.readFile(planPath, "utf8"));
    for (let i = 1; i < 4; i++) {
      const id = `beat_w00000${i}_w00000${i + 1}`;
      beats.beats.push({ ...beats.beats[0], visual_beat_id: id });
      plan.prompts.push({ ...structuredClone(plan.prompts[0]), image_id: `ep_01-w00000${i}-w00000${i + 1}`, visual_beat_id: id });
    }
    f.spec.expected.visual_beat_plan_sha256 = hash(json(beats)); await fs.writeFile(beatPath, json(beats));
    await fs.writeFile(planPath, json(plan));
    for (let i = 0; i < 4; i++) {
      const current = JSON.parse(await fs.readFile(planPath, "utf8"));
      const row = current.prompts[i];
      f.spec.expected.prompt_plan_sha256 = hash(await fs.readFile(planPath));
      f.spec.image_id = row.image_id;
      f.spec.visual_beat_id = row.visual_beat_id;
      f.spec.old_row_sha256 = hash(json(row));
      const corrected = `Cut ${i} reviewed wardrobe wording.`;
      f.spec.replacement.provider_prompt = f.spec.replacement.image_prompt = corrected;
      await fs.writeFile(f.specPath, json(f.spec));
      await repairVisualPromptExact(f);
      const after = JSON.parse(await fs.readFile(planPath, "utf8"));
      for (let prior = 0; prior <= i; prior++) assert.equal(after.prompts[prior].provider_prompt, `Cut ${prior} reviewed wardrobe wording.`);
      for (let future = i + 1; future < 4; future++) assert.equal(after.prompts[future].provider_prompt, "Original prompt");
    }
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("one cut can correct two anatomy contracts and two staging poses with exact reviewed prose", async () => {
  const f = await fixture();
  try {
    const planPath = path.join(f.episodeDir, "section_image_prompts.json");
    const refPath = path.join(f.episodeDir, "visual_reference_plan.json");
    const refs = JSON.parse(await fs.readFile(refPath, "utf8"));
    refs.reference_targets.push({ ref_id: "guard_state", scene_ids: ["scene_001"] });
    refs.character_state_refs.push({ state_ref_id: "guard_state", character: "Guard", scene_ids: ["scene_001"] });
    await fs.writeFile(refPath, json(refs)); f.spec.expected.visual_reference_plan_sha256 = hash(json(refs));
    const plan = JSON.parse(await fs.readFile(planPath, "utf8"));
    const row = plan.prompts[0];
    row.reference_requirements.push({ ref_id: "guard_state", kind: "character_state" });
    row.shot_manifest.reference_slots.push({ ref_id: "guard_state" });
    row.shot_manifest.character_state_ref_ids.push("guard_state");
    row.shot_manifest.visible_characters.push("Guard");
    row.shot_manifest.character_staging.push({ name: "Guard", ref_id: "guard_state", wardrobe_from: "character_state_ref:guard_state",
      pose: "Guard left hand grips Joey right wrist.", screen_position: "right" });
    row.shot_manifest.character_staging[0].pose = "Joey right wrist held by guard left hand.";
    row.shot_manifest.foreground_action = "Guard left hand holds Joey right wrist.";
    row.shot_manifest.anatomy_contracts = [
      { entity: "Tessa", identity_ref_id: "tessa_current", body_invariant: "Joey right wrist held.", reason: "Old incorrect side." },
      { entity: "Guard", identity_ref_id: "guard_state", body_invariant: "Guard left hand grips.", reason: "Old incorrect side." },
    ];
    await fs.writeFile(planPath, json(plan)); f.spec.expected.prompt_plan_sha256 = hash(json(plan)); f.spec.old_row_sha256 = hash(json(row));
    f.spec.replacement.provider_prompt = f.spec.replacement.image_prompt = "Joey's left hand catches the guard's right wrist; both bodies remain separate.";
    f.spec.replacement.manifest_text_patch = { foreground_action: { before: "Guard left hand holds Joey right wrist.",
      to: "Joey left hand catches the guard right wrist." } };
    f.spec.replacement.staging_patches = [
      { name: "Tessa", pose: { before: "Joey right wrist held by guard left hand.", to: "Joey reaches with his left hand to catch the guard's right wrist." } },
      { name: "Guard", pose: { before: "Guard left hand grips Joey right wrist.", to: "Guard's right wrist is caught by Joey's left hand." } },
    ];
    f.spec.replacement.anatomy_contract_patches = [
      { entity: "Tessa", identity_ref_id: "tessa_current", body_invariant: { before: "Joey right wrist held.", to: "Joey left hand catches guard right wrist." },
        reason: { before: "Old incorrect side.", to: "Left-hand grab is visible." } },
      { entity: "Guard", identity_ref_id: "guard_state", body_invariant: { before: "Guard left hand grips.", to: "Guard right wrist is caught." },
        reason: { before: "Old incorrect side.", to: "Right-wrist contact is visible." } },
    ];
    await fs.writeFile(f.specPath, json(f.spec));
    await repairVisualPromptExact(f);
    const after = JSON.parse(await fs.readFile(planPath, "utf8")).prompts[0];
    assert.deepEqual(after.reference_requirements.map((item) => item.ref_id), ["tessa_current", "guard_state"]);
    assert.match(after.shot_manifest.character_staging[0].pose, /left hand/);
    assert.match(after.shot_manifest.character_staging[1].pose, /right wrist/);
    assert.match(after.shot_manifest.anatomy_contracts[0].body_invariant, /left hand/);
    assert.match(after.shot_manifest.anatomy_contracts[1].body_invariant, /right wrist/);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("plural patches reject repeated character or anatomy targets", async () => {
  const f = await fixture();
  try {
    const patch = { name: "Tessa", pose: { before: "At work", to: "Reaches left." } };
    f.spec.replacement.staging_patches = [patch, patch];
    await fs.writeFile(f.specPath, json(f.spec));
    await assert.rejects(repairVisualPromptExact(f), /Duplicate staging patch/);
    delete f.spec.replacement.staging_patches;
    f.spec.replacement.anatomy_contract_patches = [{ entity: "Tessa", identity_ref_id: "tessa_current",
      body_invariant: { before: "A", to: "B" } }];
    await fs.writeFile(f.specPath, json(f.spec));
    await assert.rejects(repairVisualPromptExact(f), /match exactly once/);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
