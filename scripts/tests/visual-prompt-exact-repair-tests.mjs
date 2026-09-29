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
    reference_targets: [{ ref_id: "tessa_first_life", scene_ids: ["scene_001"] }], character_state_refs: [] });
  expected.reference_plan_approval_sha256 = await put("reference_plan_approval.json", { status: "approved" });
  expected.reference_image_approval_sha256 = await put("visual_reference_approval_ep_01.json", { status: "approved" });
  const original = { image_id: "ep_01-w000000-w000003", visual_beat_id: beat.visual_beat_id, scene_id: beat.scene_id,
    provider_prompt: "Original prompt", image_prompt: "Original prompt", prompt_hash: hash("Original prompt"),
    modelslab_image_prompt: "", codex_image_prompt: null,
    reference_requirements: [{ ref_id: "tessa_first_life" }], shot_manifest: { character_state_ref_ids: ["tessa_first_life"] } };
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
