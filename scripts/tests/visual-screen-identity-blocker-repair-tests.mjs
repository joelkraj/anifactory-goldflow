import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { correctGenericScreenSubject, repairScreenIdentityBlocker,
  screenIdentityBlockerRepairAdmission } from "../lib/visual-screen-identity-blocker-repair.mjs";

const sha = (data) => createHash("sha256").update(data).digest("hex");
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const write = async (dir, name, value) => fs.writeFile(path.join(dir, name), name.endsWith(".json") ? json(value) : value);
const ref = { ref_id: "morrow_floor", kind: "location", slot_order: 1 };
const row = {
  image_id: "ep_01-cut-002", visual_beat_id: "beat_w000020_w000030", scene_id: "scene_002",
  visual_beat_script_excerpt: "The promotional screen showed a robot carrying groceries into a spotless home.",
  screen_visible_entity_ids: ["blue"],
  provider_prompt: "Blue is a robot with groceries on the screen. A speech bubble says Right on time!",
  image_prompt: "Blue is a robot with groceries on the screen. A speech bubble says Right on time!",
  reference_requirements: [ref], visible_subjects: ["Blue"], primary_subject: "Blue",
  narrative_overlays: [{ kind: "speech_bubble", speaker: "Blue", text: "Right on time!" }],
  narrative_overlay_findings: [{ code: "test" }],
  shot_manifest: {
    visible_characters: ["Blue"], primary_character: "Blue",
    foreground_action: "Blue carries groceries inside the screen.", reference_slots: [ref],
    anatomy_contracts: [{ entity: "Blue", identity_ref_id: null, body_invariant: "Two hands." }],
    equipment_contracts: [{ owner: "Blue", item: "groceries" }],
    character_staging: [{ name: "Blue", screen_position: "inside screen" }],
  },
};
const correction = {
  false_entity_id: "blue", false_name: "Blue", generic_subject: "unnamed promotional robot",
  replacement_prompt: "An unnamed promotional robot carries one grocery bag inside a spotless home shown on a factory screen. Its two hands remain coherent; the factory display bezel remains visible. No written text.",
};
const dependencies = {
  run_identity: "run_identity.json", script: "script_clean.md", beat_plan: "visual_beat_plan.json",
  beat_approval: "visual_beat_approval.json", reference_plan: "visual_reference_plan.json",
  reference_plan_approval: "reference_plan_approval.json", reference_image_approval: "visual_reference_approval_ep_01.json",
  base_prompt_plan: "section_image_prompts.json", reviewed_prompt_plan: "section_image_prompts_reviewed.json",
  harden_report: "visual_prompt_hardening_ep_01.json", manual_review: "visual_manual_agent_review_ep_01.json",
};

const corrected = correctGenericScreenSubject(row, correction);
assert.equal(corrected.shot_manifest.visible_characters[0], "unnamed promotional robot");
assert.equal(corrected.narrative_overlays.length, 0);
assert.equal(corrected.narrative_overlay_findings.length, 0);
assert.deepEqual(corrected.reference_requirements, row.reference_requirements);
assert.deepEqual(row.screen_visible_entity_ids, ["blue"]);
assert.throws(() => correctGenericScreenSubject(row, { ...correction, replacement_prompt: "Blue on a screen" }), /Replacement prompt/);

const root = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-screen-identity-"));
try {
  const dir = path.join(root, "ep_01");
  await fs.mkdir(dir);
  const other = { image_id: "ep_01-cut-001", provider_prompt: "Unchanged", image_prompt: "Unchanged" };
  const contents = {
    run_identity: { schema: "goldflow_run_identity_v2" }, script: "The promotional screen showed a robot carrying groceries into a spotless home.\n",
    beat_plan: { status: "passed", beats: [{ visual_beat_id: row.visual_beat_id, image_id_hint: row.image_id,
      screen_visible_entity_ids: ["blue"], local_continuity_note: "The promotional screen robot is generic, not Blue physically present.",
      visual_beat_script_excerpt: row.visual_beat_script_excerpt }] },
    beat_approval: { status: "approved" }, reference_plan: { status: "passed" },
    reference_plan_approval: { status: "approved" }, reference_image_approval: { status: "approved" },
    base_prompt_plan: { status: "passed", prompts: [other, row] },
    reviewed_prompt_plan: { status: "needs_manual_agent_review", prompts: [other, row] },
    harden_report: { status: "blocked", unresolved_blocker_count: 1 }, manual_review: { status: "needs_manual_agent_review", image_ids: [row.image_id],
      unresolved_blockers: [{ code: "visible_character_ref_scope_missing", character: "Blue" }] },
  };
  const expected = {};
  for (const [key, name] of Object.entries(dependencies)) {
    await write(dir, name, contents[key]);
    expected[key] = sha(await fs.readFile(path.join(dir, name)));
  }
  const spec = {
    schema: "goldflow_visual_screen_identity_blocker_repair_v1", episode: "ep_01", expected,
    image_id: row.image_id, visual_beat_id: row.visual_beat_id, old_row_sha256: sha(json(row)),
    ...correction, reviewer: "fixture-reviewer", note: "Script depicts a generic advertisement robot; Blue remains elsewhere.",
    source_erratum_reviewed: true,
  };
  const specPath = path.join(root, "screen-repair-spec.json");
  await fs.writeFile(specPath, json(spec));
  const status = { episode_dir: dir, identity: { schema: "goldflow_run_identity_v2" },
    media_workflow: { id: "generated_visuals_v1" }, current_stage: "visual_prompt_harden",
    current_stage_state: "blocked", next_command_shape: "Manual agent review required",
    stage_ledger: [{ stage: "image_generation", state: "missing" }] };
  assert.equal(screenIdentityBlockerRepairAdmission(status, { "episode-dir": dir, "repair-spec": specPath }).allowed, true);
  assert.equal(screenIdentityBlockerRepairAdmission({ ...status, stage_ledger: [{ stage: "image_generation", state: "passed" }] },
    { "episode-dir": dir, "repair-spec": specPath }).allowed, false);
  await assert.rejects(repairScreenIdentityBlocker({ episodeDir: dir, specPath,
    spec: { ...spec, expected: { ...expected, script: "0".repeat(64) } }, status }), /changed since review/);
  const result = await repairScreenIdentityBlocker({ episodeDir: dir, specPath, spec, status });
  assert.equal(result.status, "passed");
  const after = JSON.parse(await fs.readFile(path.join(dir, dependencies.reviewed_prompt_plan)));
  assert.equal(after.status, "passed");
  assert.deepEqual(after.prompts[0], other);
  assert.equal(after.prompts[1].shot_manifest.visible_characters[0], "unnamed promotional robot");
  assert.equal(after.prompts[1].narrative_overlays.length, 0);
  const receipt = JSON.parse(await fs.readFile(result.receipt_path));
  assert.equal(receipt.before_plan_sha256, expected.reviewed_prompt_plan);
  assert.equal(sha(await fs.readFile(receipt.before_snapshot_path)), expected.reviewed_prompt_plan);
  assert.equal(receipt.provider_calls, 0);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, dependencies.beat_plan))).beats[0].screen_visible_entity_ids[0], "blue");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
console.log("Exact screen identity blocker repair tests passed.");
