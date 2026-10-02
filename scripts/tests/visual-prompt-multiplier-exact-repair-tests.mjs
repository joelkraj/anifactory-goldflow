import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyExactMultiplierRow, repairVisualPromptMultiplierExact } from "../lib/visual-prompt-multiplier-exact-repair.mjs";
import { commandStageFor } from "../lib/pipeline-stage-registry.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const stage = (name, state) => ({ stage: name, state });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-multiplier-repair-"));
  const episodeDir = path.join(root, "ep_01");
  await fs.mkdir(episodeDir);
  const put = async (name, value) => { const bytes = typeof value === "string" ? Buffer.from(value) : json(value);
    await fs.writeFile(path.join(episodeDir, name), bytes); return hash(bytes); };
  const expected = {};
  expected.run_identity_sha256 = await put("run_identity.json", { schema: "goldflow_run_identity_v2" });
  const quoteA = "and reset. The multiplier doubled.";
  const quoteB = "The blue numbers kept rising.";
  expected.source_script_sha256 = await put("script_clean.md", `${quoteA}\n${quoteB}\n`);
  const beats = [
    { visual_beat_id: "beat_w000100_w000104", image_id_hint: "ep_01-w000100-w000104", visual_beat_script_excerpt: quoteA },
    { visual_beat_id: "beat_w000200_w000204", image_id_hint: "ep_01-w000200-w000204", visual_beat_script_excerpt: quoteB },
    { visual_beat_id: "beat_w000300_w000304", image_id_hint: "ep_01-w000300-w000304", visual_beat_script_excerpt: "Other scene." },
  ];
  expected.visual_beat_plan_sha256 = await put("visual_beat_plan.json", { status: "passed", beats });
  expected.visual_reference_plan_sha256 = await put("visual_reference_plan.json", { status: "passed" });
  expected.reference_plan_approval_sha256 = await put("reference_plan_approval.json", { status: "approved" });
  expected.reference_image_approval_sha256 = await put("visual_reference_approval_ep_01.json", { status: "approved" });
  const makeRow = (index, phrase) => ({ image_id: beats[index].image_id_hint, visual_beat_id: beats[index].visual_beat_id,
    provider_prompt: phrase, image_prompt: phrase, prompt_hash: hash(phrase),
    narrative_overlays: [{ text: "×256 ACTIVE", information_delta: "×256 is active" }],
    shot_manifest: { ui_elements: ["Experience", "×256 ACTIVE"] } });
  const rows = [makeRow(0, "The panel shows ×256."), makeRow(1, "The wrist shows ×256."),
    { image_id: beats[2].image_id_hint, visual_beat_id: beats[2].visual_beat_id,
      provider_prompt: "An untouched scene.", image_prompt: "An untouched scene.", shot_manifest: { ui_elements: [] } }];
  expected.prompt_plan_sha256 = await put("section_image_prompts.json", { schema: "goldflow_section_image_prompts_v1", status: "passed",
    source_script_hash: expected.source_script_sha256, source_hashes: {}, prompts: rows });
  const repairFor = (row, quote, corrected_token) => ({ image_id: row.image_id, visual_beat_id: row.visual_beat_id,
    old_row_sha256: hash(json(row)), source_quote: quote, reason: "The later reset has not happened yet.",
    incorrect_token: "×256", corrected_token, field_assertions: [
      { path: "provider_prompt", before: row.provider_prompt }, { path: "image_prompt", before: row.image_prompt },
      { path: "narrative_overlays[0].text", before: row.narrative_overlays[0].text },
      { path: "narrative_overlays[0].information_delta", before: row.narrative_overlays[0].information_delta },
      { path: "shot_manifest.ui_elements[1]", before: row.shot_manifest.ui_elements[1] },
    ] });
  const spec = { schema: "goldflow_visual_prompt_multiplier_exact_repair_v1", episode: "ep_01", expected,
    rows: [repairFor(rows[0], quoteA, "×64"), repairFor(rows[1], quoteB, "×128")],
    reviewer: "agent-reviewer", note: "Repair only premature multiplier display fields.", scope_reviewed: true };
  const specPath = path.join(root, "reviewed-spec.json"); await fs.writeFile(specPath, json(spec));
  const status = { episode_dir: episodeDir, identity: { schema: "goldflow_run_identity_v2" },
    media_workflow: { id: "generated_visuals_v1" }, current_stage: "visual_prompt_harden", current_stage_state: "missing",
    stage_ledger: [stage("visual_prompt_plan", "passed"), stage("visual_prompt_harden", "missing"), stage("image_generation", "missing")] };
  return { root, episodeDir, spec, specPath, status, rows, expected };
}

test("status routes exact multiplier repair to prompt plan", () => {
  assert.equal(commandStageFor("visual", "repair-prompt-multiplier"), "visual_prompt_plan");
});

test("repairs only reviewed prompt/UI/overlay fields across two exact rows with immutable receipt", async () => {
  const f = await fixture();
  try {
    const result = await repairVisualPromptMultiplierExact(f);
    const afterBytes = await fs.readFile(path.join(f.episodeDir, "section_image_prompts.json"));
    const after = JSON.parse(afterBytes);
    assert.equal(after.prompts.length, 3);
    assert.deepEqual(after.prompts[2], f.rows[2]);
    for (const [index, token] of ["×64", "×128"].entries()) {
      const row = after.prompts[index];
      assert.ok(row.provider_prompt.includes(token));
      assert.equal(row.provider_prompt, row.image_prompt);
      assert.equal(row.prompt_hash, hash(row.provider_prompt));
      assert.equal(row.narrative_overlays[0].text, `${token} ACTIVE`);
      assert.equal(row.shot_manifest.ui_elements[1], `${token} ACTIVE`);
      assert.equal(JSON.stringify(row).includes("×256"), false);
    }
    const receipt = JSON.parse(await fs.readFile(result.receipt_path, "utf8"));
    assert.equal(receipt.provider_calls, 0);
    assert.equal(receipt.repaired_rows.length, 2);
    assert.equal(receipt.after_plan_sha256, hash(afterBytes));
    assert.equal(hash(await fs.readFile(receipt.before_snapshot_path)), f.expected.prompt_plan_sha256);
    assert.equal(hash(await fs.readFile(path.join(path.dirname(result.receipt_path), "repair_spec.json"))), hash(json(f.spec)));
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("missing occurrence, changed old value, stale plan, or bad source quote refuses atomically", async () => {
  for (const mutate of [
    (f) => { f.spec.rows[0].field_assertions.pop(); },
    (f) => { f.spec.rows[0].field_assertions[0].before = "Different prompt ×256"; },
    (f) => { f.spec.expected.prompt_plan_sha256 = "0".repeat(64); },
    (f) => { f.spec.rows[0].source_quote = "Never in the script"; },
  ]) {
    const f = await fixture();
    try {
      mutate(f); await fs.writeFile(f.specPath, json(f.spec));
      await assert.rejects(repairVisualPromptMultiplierExact(f));
      assert.equal(hash(await fs.readFile(path.join(f.episodeDir, "section_image_prompts.json"))), f.expected.prompt_plan_sha256 === "0".repeat(64)
        ? hash(json({ schema: "goldflow_section_image_prompts_v1", status: "passed", source_script_hash: f.expected.source_script_sha256,
          source_hashes: {}, prompts: f.rows })) : f.expected.prompt_plan_sha256);
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  }
});

test("requires an earlier power-of-two multiplier and closes after downstream starts", async () => {
  const f = await fixture();
  try {
    assert.throws(() => applyExactMultiplierRow(f.rows[0], { ...f.spec.rows[0], corrected_token: "×512" }), /requires exact identity/);
    assert.throws(() => applyExactMultiplierRow(f.rows[0], { ...f.spec.rows[0], corrected_token: "×256" }), /requires exact identity/);
    f.status.stage_ledger.push(stage("visual_prompt_harden", "passed"));
    await assert.rejects(repairVisualPromptMultiplierExact(f), /refused/);
    f.status.stage_ledger.pop();
    await fs.writeFile(path.join(f.episodeDir, "execution_events.jsonl"), `${JSON.stringify({ stage: "image_generation" })}\n`);
    await assert.rejects(repairVisualPromptMultiplierExact(f), /Downstream visual processing/);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
