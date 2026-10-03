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

test("removes one reviewed stale equipment contract without changing other equipment or references", async () => {
  const f = await fixture();
  try {
    const planPath = path.join(f.episodeDir, "section_image_prompts.json");
    const plan = JSON.parse(await fs.readFile(planPath, "utf8"));
    const row = plan.prompts[0];
    const stale = { owner: "Tessa", item: "field radio", visible_count: 1, holder_state: "clipped to collar" };
    const retained = { owner: "Tessa", item: "map", visible_count: 1, holder_state: "on table" };
    row.shot_manifest.equipment_contracts = [stale, retained];
    row.shot_manifest.visible_props = ["field radio at collar", "paper map"];
    row.provider_prompt = row.image_prompt = "Tessa checks the map with a radio clipped to her collar.";
    row.prompt_hash = hash(row.provider_prompt);
    row.shot_manifest.continuity_notes = "Tessa keeps the radio clipped to her collar.";
    await fs.writeFile(planPath, json(plan));
    f.spec.expected.prompt_plan_sha256 = hash(json(plan));
    f.spec.old_row_sha256 = hash(json(row));
    f.spec.replacement.provider_prompt = f.spec.replacement.image_prompt = "Tessa checks the map in the later office scene.";
    f.spec.replacement.manifest_text_patch = { continuity_notes: {
      before: row.shot_manifest.continuity_notes,
      to: "Tessa checks the map in the later office scene.",
    } };
    f.spec.replacement.equipment_contract_removal = {
      owner: "Tessa", item: "field radio", expected_contract_sha256: hash(json(stale)),
    };
    f.spec.replacement.visible_prop_removal = "field radio at collar";
    await fs.writeFile(f.specPath, json(f.spec));
    await repairVisualPromptExact(f);
    const corrected = JSON.parse(await fs.readFile(planPath, "utf8")).prompts[0];
    assert.deepEqual(corrected.shot_manifest.equipment_contracts, [retained]);
    assert.deepEqual(corrected.shot_manifest.visible_props, ["paper map"]);
    assert.deepEqual(corrected.reference_requirements, f.original.reference_requirements);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("refuses stale or ambiguous equipment and prop removals without modifying the plan", async () => {
  for (const variant of ["stale", "ambiguous", "prop"] ) {
    const f = await fixture();
    try {
      const planPath = path.join(f.episodeDir, "section_image_prompts.json");
      const plan = JSON.parse(await fs.readFile(planPath, "utf8"));
      const contract = { owner: "Tessa", item: "field radio", visible_count: 1 };
      plan.prompts[0].shot_manifest.equipment_contracts = variant === "stale" ? [contract] : [contract, contract];
      if (variant === "prop") plan.prompts[0].shot_manifest.visible_props = ["field radio", "field radio"];
      const before = json(plan);
      await fs.writeFile(planPath, before);
      f.spec.expected.prompt_plan_sha256 = hash(before);
      f.spec.old_row_sha256 = hash(json(plan.prompts[0]));
      f.spec.replacement.equipment_contract_removal = {
        owner: "Tessa", item: "field radio",
        expected_contract_sha256: variant === "stale" ? "0".repeat(64) : hash(json(contract)),
      };
      if (variant === "prop") {
        plan.prompts[0].shot_manifest.equipment_contracts = [contract];
        const revised = json(plan); await fs.writeFile(planPath, revised);
        f.spec.expected.prompt_plan_sha256 = hash(revised);
        f.spec.old_row_sha256 = hash(json(plan.prompts[0]));
        f.spec.replacement.visible_prop_removal = "field radio";
      }
      await fs.writeFile(f.specPath, json(f.spec));
      const unchanged = await fs.readFile(planPath);
      await assert.rejects(repairVisualPromptExact(f), /missing, ambiguous, or changed|visible prop is missing or ambiguous/);
      assert.deepEqual(await fs.readFile(planPath), unchanged);
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  }
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

async function bootOverlayFixture() {
  const f = await fixture();
  const source = "One hundred nineteen dollars and ninety-nine cents.\nThe return arrived before I reached the exit.\nEach return was exactly twice the corresponding purchase.\n";
  await fs.writeFile(path.join(f.episodeDir, "script_clean.md"), source);
  f.spec.expected.source_script_sha256 = hash(source);
  const beatPath = path.join(f.episodeDir, "visual_beat_plan.json");
  const beats = JSON.parse(await fs.readFile(beatPath, "utf8"));
  beats.beats[0].visual_beat_script_excerpt = "The return arrived before I reached the exit.";
  beats.beats.push({ ...beats.beats[0], visual_beat_id: "beat_other" });
  await fs.writeFile(beatPath, json(beats));
  f.spec.expected.visual_beat_plan_sha256 = hash(json(beats));
  const planPath = path.join(f.episodeDir, "section_image_prompts.json");
  const plan = JSON.parse(await fs.readFile(planPath, "utf8"));
  const row = plan.prompts[0];
  row.provider_prompt = row.image_prompt = "Joey receives Purchase return +$119.99. RPG panel NET COST: $0.";
  row.prompt_hash = hash(row.provider_prompt);
  row.narrative_overlays = [{ kind: "rpg_game_text", text: "NET COST: $0",
    information_delta: "matching credit cancels boot purchase cost", style: "system_cyan" }];
  row.shot_manifest.foreground_action = "Joey sees one $119.99 purchase-return credit.";
  row.shot_manifest.ui_elements = ["Paid $119.99", "Purchase return +$119.99"];
  const untouched = { ...structuredClone(row), image_id: "ep_01-other", visual_beat_id: "beat_other" };
  plan.prompts.push(untouched);
  plan.source_script_hash = f.spec.expected.source_script_sha256;
  await fs.writeFile(planPath, json(plan));
  f.spec.expected.prompt_plan_sha256 = hash(json(plan));
  f.spec.old_row_sha256 = hash(json(row));
  const overlayPatch = { index: 0, before: "NET COST: $0", old_overlay_sha256: hash(json(row.narrative_overlays[0])),
    to: "CASH UP $119.99", information_delta: { before: "matching credit cancels boot purchase cost",
      to: "Joey retains the boots while his cash increases by $119.99." },
    source_quotes: ["The return arrived before I reached the exit.",
      "One hundred nineteen dollars and ninety-nine cents.",
      "Each return was exactly twice the corresponding purchase."] };
  const correctedPrompt = "Joey receives Purchase return +$239.98. RPG panel CASH UP $119.99. The paid $119.99 boots remain with him.";
  f.spec.replacement = {
    provider_prompt: correctedPrompt, image_prompt: correctedPrompt,
    narrative_overlay_patch: overlayPatch,
    ui_element_patch: { index: 1, before: "Purchase return +$119.99", to: "Purchase return +$239.98" },
    manifest_text_patch: { foreground_action: { before: "Joey sees one $119.99 purchase-return credit.",
      to: "Joey sees a $239.98 return on the $119.99 boots purchase." } },
    assert_absent_terms: ["NET COST: $0", "Purchase return +$119.99", "matching credit cancels boot purchase cost"],
  };
  f.spec.note = "The source says every purchase returns twice its price, so the $119.99 boots yield $239.98 and increase cash by $119.99.";
  await fs.writeFile(f.specPath, json(f.spec));
  return { ...f, planPath, untouched };
}

test("corrects one source-backed purchase overlay, UI amount, and action without changing another cut", async () => {
  const f = await bootOverlayFixture();
  try {
    const result = await repairVisualPromptExact(f);
    const plan = JSON.parse(await fs.readFile(f.planPath, "utf8"));
    const row = plan.prompts[0];
    assert.equal(row.narrative_overlays[0].text, "CASH UP $119.99");
    assert.match(row.narrative_overlays[0].information_delta, /cash increases by \$119\.99/);
    assert.equal(row.shot_manifest.ui_elements[1], "Purchase return +$239.98");
    assert.match(row.shot_manifest.foreground_action, /\$239\.98/);
    assert.deepEqual(plan.prompts[1], f.untouched);
    const receipt = JSON.parse(await fs.readFile(result.receipt_path, "utf8"));
    assert.equal(receipt.narrative_overlay_text_change.before, "NET COST: $0");
    assert.equal(receipt.narrative_overlay_text_change.after, "CASH UP $119.99");
    assert.equal(receipt.narrative_overlay_text_change.after_overlay_sha256, hash(json(row.narrative_overlays[0])));
    assert.equal(receipt.narrative_overlay_text_change.information_delta_change.after,
      "Joey retains the boots while his cash increases by $119.99.");
    assert.deepEqual(receipt.narrative_overlay_text_change.source_quotes, f.spec.replacement.narrative_overlay_patch.source_quotes);
    assert.deepEqual(receipt.ui_element_text_change,
      { index: 1, before: "Purchase return +$119.99", after: "Purchase return +$239.98" });
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("refuses stale overlay text or hash, bad source quotes, stale UI text, and unmirrored prompt text", async () => {
  for (const variant of ["text", "hash", "quote", "local_quote", "ui", "ui_without_overlay", "prompt", "information_delta"]) {
    const f = await bootOverlayFixture();
    try {
      const patch = f.spec.replacement.narrative_overlay_patch;
      if (variant === "text") patch.before = "NET COST: $1";
      if (variant === "hash") patch.old_overlay_sha256 = "0".repeat(64);
      if (variant === "quote") patch.source_quotes[1] = "One hundred nineteen dollars and ninety-eight cents.";
      if (variant === "local_quote") patch.source_quotes.shift();
      if (variant === "ui") f.spec.replacement.ui_element_patch.before = "Purchase return +$119.98";
      if (variant === "ui_without_overlay") delete f.spec.replacement.narrative_overlay_patch;
      if (variant === "prompt") {
        f.spec.replacement.provider_prompt = f.spec.replacement.image_prompt = "Joey receives Purchase return +$239.98. The boots remain with him.";
      }
      if (variant === "information_delta") patch.information_delta.before = "matching credit covers purchase";
      await fs.writeFile(f.specPath, json(f.spec));
      const before = await fs.readFile(f.planPath);
      await assert.rejects(repairVisualPromptExact(f));
      assert.deepEqual(await fs.readFile(f.planPath), before, variant);
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  }
});

test("overlay repair refuses an altered unrelated row and any started harden", async () => {
  for (const variant of ["other_row", "harden", "harden_event"]) {
    const f = await bootOverlayFixture();
    try {
      if (variant === "other_row") {
        const plan = JSON.parse(await fs.readFile(f.planPath, "utf8"));
        plan.prompts[1].provider_prompt = "Unreviewed change";
        await fs.writeFile(f.planPath, json(plan));
      } else if (variant === "harden") {
        f.status.stage_ledger.find((stage) => stage.stage === "visual_prompt_harden").state = "failed";
        f.status.current_stage_state = "failed";
      } else {
        await fs.writeFile(path.join(f.episodeDir, "execution_events.jsonl"),
          `${JSON.stringify({ stage: "visual_prompt_harden", status: "failed" })}\n`);
      }
      const before = await fs.readFile(f.planPath);
      await assert.rejects(repairVisualPromptExact(f));
      assert.deepEqual(await fs.readFile(f.planPath), before);
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  }
});

async function uiOnlyFixture() {
  const f = await bootOverlayFixture();
  const plan = JSON.parse(await fs.readFile(f.planPath, "utf8"));
  const row = plan.prompts[0];
  row.narrative_overlays = [];
  row.provider_prompt = row.image_prompt = "Joey's phone shows The return and Purchase return +$119.99.";
  row.prompt_hash = hash(row.provider_prompt);
  row.shot_manifest.ui_elements = ["The return", "Purchase return +$119.99"];
  row.ui_text_on_screen = ["The return", "Purchase return +$119.99"];
  await fs.writeFile(f.planPath, json(plan));
  f.spec.expected.prompt_plan_sha256 = hash(json(plan));
  f.spec.old_row_sha256 = hash(json(row));
  f.spec.replacement = {
    provider_prompt: "Joey's phone shows Account activity and Purchase return +$239.98.",
    image_prompt: "Joey's phone shows Account activity and Purchase return +$239.98.",
    ui_element_patches: [
      { index: 0, before: "The return", to: "Account activity" },
      { index: 1, before: "Purchase return +$119.99", to: "Purchase return +$239.98" },
    ],
    ui_element_source_quotes: ["The return arrived before I reached the exit.",
      "Each return was exactly twice the corresponding purchase."],
    assert_absent_terms: ["Purchase return +$119.99"],
  };
  await fs.writeFile(f.specPath, json(f.spec));
  return f;
}

test("UI-only correction repairs two indexed source-bound strings with no overlay or other-row changes", async () => {
  const f = await uiOnlyFixture();
  try {
    const result = await repairVisualPromptExact(f);
    const plan = JSON.parse(await fs.readFile(f.planPath, "utf8"));
    assert.deepEqual(plan.prompts[0].shot_manifest.ui_elements, ["Account activity", "Purchase return +$239.98"]);
    assert.deepEqual(plan.prompts[0].ui_text_on_screen, ["Account activity", "Purchase return +$239.98"]);
    assert.deepEqual(plan.prompts[0].narrative_overlays, []);
    assert.deepEqual(plan.prompts[1], f.untouched);
    const receipt = JSON.parse(await fs.readFile(result.receipt_path, "utf8"));
    assert.deepEqual(receipt.ui_element_text_changes, [
      { index: 0, before: "The return", after: "Account activity" },
      { index: 1, before: "Purchase return +$119.99", after: "Purchase return +$239.98" },
    ]);
    assert.deepEqual(receipt.ui_element_source_quotes, f.spec.replacement.ui_element_source_quotes);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("UI-only correction rejects missing or stale source evidence, duplicate indices, stale element text, and ambiguous mirrors", async () => {
  for (const variant of ["no_quotes", "bad_quote", "no_local_quote", "duplicate", "stale", "fifth", "ambiguous_mirror"]) {
    const f = await uiOnlyFixture();
    try {
      const replacement = f.spec.replacement;
      if (variant === "no_quotes") delete replacement.ui_element_source_quotes;
      if (variant === "bad_quote") replacement.ui_element_source_quotes[1] = "Every purchase was an ordinary refund.";
      if (variant === "no_local_quote") replacement.ui_element_source_quotes.shift();
      if (variant === "duplicate") replacement.ui_element_patches[1].index = 0;
      if (variant === "stale") replacement.ui_element_patches[1].before = "Purchase return +$119.98";
      if (variant === "fifth") replacement.ui_element_patches.push(...Array(3).fill({ index: 0, before: "The return", to: "Account activity" }));
      if (variant === "ambiguous_mirror") {
        const plan = JSON.parse(await fs.readFile(f.planPath, "utf8"));
        plan.prompts[0].ui_text_on_screen.push("The return");
        await fs.writeFile(f.planPath, json(plan));
        f.spec.expected.prompt_plan_sha256 = hash(json(plan));
        f.spec.old_row_sha256 = hash(json(plan.prompts[0]));
      }
      await fs.writeFile(f.specPath, json(f.spec));
      const before = await fs.readFile(f.planPath);
      await assert.rejects(repairVisualPromptExact(f), undefined, variant);
      assert.deepEqual(await fs.readFile(f.planPath), before, variant);
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  }
});

async function locationReferenceFixture() {
  const f = await fixture();
  const quote = "She did not have permission to come through the gate.";
  await fs.writeFile(path.join(f.episodeDir, "script_clean.md"), `${quote}\n`);
  f.spec.expected.source_script_sha256 = hash(`${quote}\n`);
  const beatPath = path.join(f.episodeDir, "visual_beat_plan.json");
  const beats = JSON.parse(await fs.readFile(beatPath, "utf8"));
  beats.beats[0].location_id = "joeys_new_house";
  beats.beats[0].visual_beat_script_excerpt = quote;
  await fs.writeFile(beatPath, json(beats));
  f.spec.expected.visual_beat_plan_sha256 = hash(json(beats));
  const rasterPath = path.join(f.episodeDir, "gate.png");
  const raster = Buffer.from("approved-gate-raster");
  await fs.writeFile(rasterPath, raster);
  const refsPath = path.join(f.episodeDir, "visual_reference_plan.json");
  const refs = JSON.parse(await fs.readFile(refsPath, "utf8"));
  refs.reference_targets.push({ ref_id: "kitchen_ref", kind: "location", scene_ids: ["scene_001"],
    location_contract_ids: ["joeys_new_house"], planned_beat_ids: [] });
  refs.reference_targets.push({ ref_id: "gate_ref", kind: "location", scene_ids: ["scene_001"],
    location_contract_ids: ["joeys_new_house"], planned_beat_ids: [beats.beats[0].visual_beat_id],
    reference_image_path: rasterPath });
  await fs.writeFile(refsPath, json(refs));
  f.spec.expected.visual_reference_plan_sha256 = hash(json(refs));
  const approvalPath = path.join(f.episodeDir, "visual_reference_approval_ep_01.json");
  const approval = { status: "approved", reference_hash_by_ref_id: { gate_ref: hash(raster) } };
  await fs.writeFile(approvalPath, json(approval));
  f.spec.expected.reference_image_approval_sha256 = hash(json(approval));
  const planPath = path.join(f.episodeDir, "section_image_prompts.json");
  const plan = JSON.parse(await fs.readFile(planPath, "utf8"));
  const row = plan.prompts[0];
  row.provider_prompt = row.image_prompt = "Joey faces Claire across the kitchen table.";
  row.prompt_hash = hash(row.provider_prompt);
  const reference = { ref_id: "kitchen_ref", kind: "location", slot_purpose: "Kitchen geometry", reason: "An inside conversation." };
  row.reference_requirements.push(structuredClone(reference));
  row.reference_usage.push({ ref_id: "kitchen_ref", usage: "attach_existing_ref", reason: reference.reason });
  row.anchor_roles.push({ ref_id: "kitchen_ref", kind: "location", anchor_role: "source_anchor", reason: reference.reason });
  row.shot_manifest.reference_slots.push({ ...reference, conditioning_asset_role: "environment" });
  row.shot_manifest.location_contract_id = "joeys_new_house";
  row.shot_manifest.location_ref_id = "kitchen_ref";
  row.shot_manifest.visible_props = ["kitchen table", "Claire's green dress"];
  row.shot_manifest.motion_intent = { depth_candidate: { background_plane: "kitchen windows and table" } };
  row.shot_manifest.continuity_notes = "Same kitchen conversation.";
  plan.source_script_hash = f.spec.expected.source_script_sha256;
  await fs.writeFile(planPath, json(plan));
  f.spec.expected.prompt_plan_sha256 = hash(json(plan));
  f.spec.old_row_sha256 = hash(json(row));
  f.spec.replacement = {
    provider_prompt: "Joey stands inside the house gate while Claire waits outside beside the driveway. Her green dress remains visible.",
    image_prompt: "Joey stands inside the house gate while Claire waits outside beside the driveway. Her green dress remains visible.",
    location_reference_patch: { from_ref_id: "kitchen_ref", to_ref_id: "gate_ref",
      approved_reference_sha256: hash(raster), source_quotes: [quote] },
    reference_text_patch: { ref_id: "gate_ref",
      slot_purpose: { before: "Kitchen geometry", to: "Gate and driveway geometry" },
      reason: { before: "An inside conversation.", to: "Keeps Claire outside the gate." } },
    visible_prop_removal: "kitchen table",
    manifest_text_patch: {
      continuity_notes: { before: "Same kitchen conversation.", to: "Claire remains outside the gate." },
      depth_background_plane: { before: "kitchen windows and table", to: "house gate and driveway" },
    },
    assert_absent_terms: ["kitchen_ref", "kitchen table", "Same kitchen conversation"],
  };
  await fs.writeFile(f.specPath, json(f.spec));
  return { ...f, planPath, rasterPath };
}

async function locationContractFixture() {
  const f = await locationReferenceFixture();
  const beatPath = path.join(f.episodeDir, "visual_beat_plan.json");
  const beats = JSON.parse(await fs.readFile(beatPath, "utf8"));
  beats.beats[0].location_id = "house_gate";
  await fs.writeFile(beatPath, json(beats));
  f.spec.expected.visual_beat_plan_sha256 = hash(json(beats));

  const oldRasterPath = path.join(f.episodeDir, "kitchen.png");
  const oldRaster = Buffer.from("approved-old-sublocation-raster");
  await fs.writeFile(oldRasterPath, oldRaster);
  const refsPath = path.join(f.episodeDir, "visual_reference_plan.json");
  const refs = JSON.parse(await fs.readFile(refsPath, "utf8"));
  const oldTarget = refs.reference_targets.find((item) => item.ref_id === "kitchen_ref");
  const newTarget = refs.reference_targets.find((item) => item.ref_id === "gate_ref");
  oldTarget.location_contract_ids = ["house_gate"];
  oldTarget.reference_image_path = oldRasterPath;
  oldTarget.evidence_asset_ids = ["house_source"];
  newTarget.location_contract_ids = ["house_gate"];
  newTarget.evidence_asset_ids = ["house_source"];
  await fs.writeFile(refsPath, json(refs));
  f.spec.expected.visual_reference_plan_sha256 = hash(json(refs));

  const approvalPath = path.join(f.episodeDir, "visual_reference_approval_ep_01.json");
  const approval = JSON.parse(await fs.readFile(approvalPath, "utf8"));
  approval.reference_hash_by_ref_id.kitchen_ref = hash(oldRaster);
  await fs.writeFile(approvalPath, json(approval));
  f.spec.expected.reference_image_approval_sha256 = hash(json(approval));

  const plan = JSON.parse(await fs.readFile(f.planPath, "utf8"));
  plan.prompts[0].shot_manifest.location_contract_id = "house_property";
  await fs.writeFile(f.planPath, json(plan));
  f.spec.expected.prompt_plan_sha256 = hash(json(plan));
  f.spec.old_row_sha256 = hash(json(plan.prompts[0]));
  f.spec.replacement.location_contract_patch = { before: "house_property", to: "house_gate" };
  await fs.writeFile(f.specPath, json(f.spec));
  return { ...f, oldRasterPath };
}

test("corrects one stale contract to the approved beat location while swapping a planned approved sublocation ref", async () => {
  const f = await locationContractFixture();
  try {
    const before = JSON.parse(await fs.readFile(f.planPath, "utf8")).prompts[0];
    const result = await repairVisualPromptExact(f);
    const after = JSON.parse(await fs.readFile(f.planPath, "utf8")).prompts[0];
    const expected = structuredClone(before);
    expected.provider_prompt = expected.image_prompt = f.spec.replacement.provider_prompt;
    expected.prompt_hash = hash(expected.provider_prompt);
    for (const group of [expected.reference_requirements, expected.reference_usage,
      expected.anchor_roles, expected.shot_manifest.reference_slots]) {
      const item = group.find((entry) => entry.ref_id === "kitchen_ref");
      item.ref_id = "gate_ref";
      if (item.slot_purpose === "Kitchen geometry") item.slot_purpose = "Gate and driveway geometry";
      if (item.reason === "An inside conversation.") item.reason = "Keeps Claire outside the gate.";
    }
    expected.shot_manifest.location_ref_id = "gate_ref";
    expected.shot_manifest.location_contract_id = "house_gate";
    expected.shot_manifest.visible_props = ["Claire's green dress"];
    expected.shot_manifest.continuity_notes = "Claire remains outside the gate.";
    expected.shot_manifest.motion_intent.depth_candidate.background_plane = "house gate and driveway";
    assert.deepEqual(after, expected);
    const receipt = JSON.parse(await fs.readFile(result.receipt_path, "utf8"));
    assert.deepEqual(receipt.location_contract_change,
      { before: "house_property", after: "house_gate", source_beat_location_id: "house_gate" });
    assert.equal(receipt.provider_calls, 0);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("contract correction fails closed for stale IDs, wrong beat, missing swap, scope, plan, approval, or raster", async () => {
  for (const variant of ["absent_patch", "stale_before", "wrong_to", "no_swap", "old_contract", "new_contract",
    "old_scene", "new_scene", "unplanned", "old_approval", "new_approval", "old_raster", "new_raster"]) {
    const f = await locationContractFixture();
    try {
      const replacement = f.spec.replacement;
      if (variant === "absent_patch") delete replacement.location_contract_patch;
      if (variant === "stale_before") replacement.location_contract_patch.before = "other_property";
      if (variant === "wrong_to") replacement.location_contract_patch.to = "other_gate";
      if (variant === "no_swap") delete replacement.location_reference_patch;
      if (["old_contract", "new_contract", "old_scene", "new_scene", "unplanned"].includes(variant)) {
        const file = path.join(f.episodeDir, "visual_reference_plan.json");
        const refs = JSON.parse(await fs.readFile(file, "utf8"));
        const target = refs.reference_targets.find((item) => item.ref_id ===
          (["old_contract", "old_scene"].includes(variant) ? "kitchen_ref" : "gate_ref"));
        if (variant.endsWith("contract")) target.location_contract_ids = ["other_place"];
        if (variant.endsWith("scene")) target.scene_ids = ["scene_999"];
        if (variant === "unplanned") target.planned_beat_ids = [];
        await fs.writeFile(file, json(refs));
        f.spec.expected.visual_reference_plan_sha256 = hash(json(refs));
      }
      if (["old_approval", "new_approval"].includes(variant)) {
        const file = path.join(f.episodeDir, "visual_reference_approval_ep_01.json");
        const approval = JSON.parse(await fs.readFile(file, "utf8"));
        approval.reference_hash_by_ref_id[variant === "old_approval" ? "kitchen_ref" : "gate_ref"] = "0".repeat(64);
        await fs.writeFile(file, json(approval));
        f.spec.expected.reference_image_approval_sha256 = hash(json(approval));
      }
      if (variant === "old_raster") await fs.writeFile(f.oldRasterPath, "changed-old-raster");
      if (variant === "new_raster") await fs.writeFile(f.rasterPath, "changed-new-raster");
      await fs.writeFile(f.specPath, json(f.spec));
      const before = await fs.readFile(f.planPath);
      await assert.rejects(repairVisualPromptExact(f), undefined, variant);
      assert.deepEqual(await fs.readFile(f.planPath), before, variant);
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  }
});

test("replaces one approved wrong sublocation reference and stale room prose without changing cast or timing", async () => {
  const f = await locationReferenceFixture();
  try {
    const result = await repairVisualPromptExact(f);
    const row = JSON.parse(await fs.readFile(f.planPath, "utf8")).prompts[0];
    assert.equal(row.shot_manifest.location_ref_id, "gate_ref");
    assert.deepEqual(row.shot_manifest.visible_props, ["Claire's green dress"]);
    assert.equal(row.shot_manifest.motion_intent.depth_candidate.background_plane, "house gate and driveway");
    assert.equal(row.reference_requirements.at(-1).ref_id, "gate_ref");
    assert.equal(row.shot_manifest.reference_slots.at(-1).ref_id, "gate_ref");
    assert.equal(row.shot_manifest.character_state_ref_ids[0], "tessa_current");
    const receipt = JSON.parse(await fs.readFile(result.receipt_path, "utf8"));
    assert.equal(receipt.location_reference_change.to_ref_id, "gate_ref");
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("location reference correction fails closed on unplanned, unapproved, changed, or cross-contract targets", async () => {
  for (const variant of ["unplanned", "unapproved", "changed", "cross_contract", "bad_quote", "stale_id"]) {
    const f = await locationReferenceFixture();
    try {
      if (variant === "unplanned" || variant === "cross_contract") {
        const file = path.join(f.episodeDir, "visual_reference_plan.json");
        const refs = JSON.parse(await fs.readFile(file, "utf8"));
        const gate = refs.reference_targets.find((item) => item.ref_id === "gate_ref");
        if (variant === "unplanned") gate.planned_beat_ids = [];
        else gate.location_contract_ids = ["another_house"];
        await fs.writeFile(file, json(refs)); f.spec.expected.visual_reference_plan_sha256 = hash(json(refs));
      }
      if (variant === "unapproved") f.spec.replacement.location_reference_patch.approved_reference_sha256 = "0".repeat(64);
      if (variant === "changed") await fs.writeFile(f.rasterPath, "changed-raster");
      if (variant === "bad_quote") f.spec.replacement.location_reference_patch.source_quotes = ["Claire entered the house and sat at the table."];
      if (variant === "stale_id") f.spec.replacement.location_reference_patch.from_ref_id = "other_ref";
      await fs.writeFile(f.specPath, json(f.spec));
      const before = await fs.readFile(f.planPath);
      await assert.rejects(repairVisualPromptExact(f), undefined, variant);
      assert.deepEqual(await fs.readFile(f.planPath), before, variant);
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  }
});

test("a planned adjacent sublocation can retain the broad contract only when both references share source geography", async () => {
  const f = await locationReferenceFixture();
  try {
    const refsPath = path.join(f.episodeDir, "visual_reference_plan.json");
    const refs = JSON.parse(await fs.readFile(refsPath, "utf8"));
    const kitchen = refs.reference_targets.find((item) => item.ref_id === "kitchen_ref");
    const gate = refs.reference_targets.find((item) => item.ref_id === "gate_ref");
    kitchen.evidence_asset_ids = ["house_property_source"];
    gate.evidence_asset_ids = ["house_property_source"];
    gate.location_contract_ids = ["house_entry_subspace"];
    await fs.writeFile(refsPath, json(refs));
    f.spec.expected.visual_reference_plan_sha256 = hash(json(refs));
    await fs.writeFile(f.specPath, json(f.spec));
    await repairVisualPromptExact(f);
    const row = JSON.parse(await fs.readFile(f.planPath, "utf8")).prompts[0];
    assert.equal(row.shot_manifest.location_contract_id, "joeys_new_house");
    assert.equal(row.shot_manifest.location_ref_id, "gate_ref");
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("location correction can remove two stale room props and patch one exact equipment holder", async () => {
  const f = await locationReferenceFixture();
  try {
    const plan = JSON.parse(await fs.readFile(f.planPath, "utf8"));
    const row = plan.prompts[0];
    row.shot_manifest.visible_props = ["kitchen table", "meeting chairs", "presentation screen"];
    const screen = { owner: "hotel", item: "presentation screen", holder_state: "fixed in meeting room",
      contact_target: "meeting room wall", visible_count: 1 };
    row.shot_manifest.equipment_contracts = [screen];
    await fs.writeFile(f.planPath, json(plan));
    f.spec.expected.prompt_plan_sha256 = hash(json(plan));
    f.spec.old_row_sha256 = hash(json(row));
    f.spec.replacement.visible_prop_removal = undefined;
    f.spec.replacement.visible_prop_removals = ["kitchen table", "meeting chairs"];
    f.spec.replacement.equipment_contract_text_patch = { owner: "hotel", item: "presentation screen",
      expected_contract_sha256: hash(json(screen)), holder_state: { before: "fixed in meeting room", to: "fixed in ballroom" },
      contact_target: { before: "meeting room wall", to: "ballroom wall" } };
    f.spec.replacement.provider_prompt = f.spec.replacement.image_prompt =
      "Joey stands inside the house gate while Claire waits outside beside the driveway; a presentation screen is fixed in ballroom.";
    await fs.writeFile(f.specPath, json(f.spec));
    await repairVisualPromptExact(f);
    const corrected = JSON.parse(await fs.readFile(f.planPath, "utf8")).prompts[0];
    assert.deepEqual(corrected.shot_manifest.visible_props, ["presentation screen"]);
    assert.equal(corrected.shot_manifest.equipment_contracts[0].holder_state, "fixed in ballroom");
    assert.equal(corrected.shot_manifest.equipment_contracts[0].contact_target, "ballroom wall");
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
