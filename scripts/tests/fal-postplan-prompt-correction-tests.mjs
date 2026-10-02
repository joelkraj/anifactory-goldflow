import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { falObjectSha256 } from "../lib/fal-provider.mjs";
import { applyFalPostplanPromptCorrection, falPostplanPromptCorrectionPaths,
  inspectFalPostplanPromptCorrection } from "../lib/fal-postplan-prompt-correction.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const fileSha = async file => sha(await readFile(file));
async function json(file, value) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, `${JSON.stringify(value, null, 2)}\n`); }

async function fixture() {
  const episodeDir = await mkdtemp(path.join(os.tmpdir(), "goldflow-fal-postplan-"));
  const root = path.join(episodeDir, "fal");
  const source = "He stopped when he saw the dead monster. I put both hands on top of the dead shellback. He turned with me. Too fast.";
  await json(path.join(episodeDir, "run_identity.json"), { image_provider: "fal_ai" });
  await writeFile(path.join(episodeDir, "script_clean.md"), source);
  await json(path.join(episodeDir, "visual_beat_plan.json"), { status: "passed" });
  await json(path.join(episodeDir, "visual_beat_approval.json"), { status: "approved" });
  const facts = [
    { id: "shellback", quote: "I put both hands on top of the dead shellback", kind: "rpg_game_text",
      text: "FIRST KILL CONFIRMED", operation: "remove_overlay",
      before: "Add an RPG receipt reading FIRST KILL CONFIRMED above the shellback.",
      after: "Keep this frame free of lettering; show the joy through Joey's face.",
      earlier: "He stopped when he saw the dead monster.", replacementText: null },
    { id: "duel", quote: "He turned with me. Too fast.", kind: "thought_bubble",
      text: "Too close to reset.", operation: "replace_overlay_text",
      before: "Add a thought bubble reading Too close to reset. above Joey.",
      after: "Add a thought bubble reading Too fast. above Joey.",
      earlier: null, replacementText: "Too fast." },
  ];
  const prompts = [], assignments = [], corrections = [];
  for (const fact of facts) {
    const providerPrompt = `Depict ${fact.quote}. ${fact.before} One frame.`;
    const overlays = [{ kind: fact.kind, text: fact.text }];
    prompts.push({ image_id: fact.id, visual_beat_id: `beat-${fact.id}`,
      visual_beat_script_excerpt: fact.quote, provider_prompt: providerPrompt,
      narrative_overlays: overlays });
    const fullPrompt = `${providerPrompt}\n\nReference-board guidance.`;
    const core = { image_id: fact.id, endpoint: "test/edit", prompt: fullPrompt,
      prompt_sha256: sha(fullPrompt), run_identity_sha256: "a".repeat(64),
      reference_mode: "one_positional_collage", reference_asset_ids: [], reference_hashes: [],
      board_path: "board", board_sha256: "b".repeat(64), max_cost_usd: 0.05 };
    assignments.push({ ...core, assignment_sha256: falObjectSha256(JSON.stringify(core)),
      submission_receipt_path: path.join(root, "bulk", "submission-receipts", `${fact.id}.json`),
      result_receipt_path: path.join(root, "bulk", "result-receipts", `${fact.id}.json`),
      output_path: path.join(root, "bulk", "outputs", `${fact.id}.png`),
      upload_receipt_path: path.join(root, "bulk", "upload-receipts", `${fact.id}.json`),
      assignment_path: path.join(root, "bulk", "assignments", `${fact.id}.json`) });
    corrections.push({ image_id: fact.id, visual_beat_id: `beat-${fact.id}`,
      operation: fact.operation, source_quote: fact.quote,
      earlier_source_quote: fact.earlier, overlay_kind: fact.kind, overlay_text: fact.text,
      replacement_text: fact.replacementText,
      old_overlay_sha256: sha(JSON.stringify(overlays)), old_prompt_sha256: sha(providerPrompt),
      old_assignment_sha256: assignments.at(-1).assignment_sha256,
      before_span: fact.before, replacement_span: fact.after,
      replacement_prompt_sha256: sha(fullPrompt.replace(fact.before, fact.after)),
      reason: "The authored overlay contradicts a specific earlier or current script event." });
  }
  // A prior paid cut is frozen by receipt hashes and must remain unchanged.
  const prior = { image_id: "prior", assignment_sha256: "c".repeat(64), prompt_sha256: "e".repeat(64),
    submission_receipt_path: path.join(root, "bulk", "submission-receipts", "prior.json"),
    result_receipt_path: path.join(root, "bulk", "result-receipts", "prior.json") };
  await json(prior.submission_receipt_path, { image_id: prior.image_id, assignment_sha256: prior.assignment_sha256,
    prompt_sha256: prior.prompt_sha256, request_id: "old" });
  await json(prior.result_receipt_path, { request_id: "old", output_sha256: "d".repeat(64) });
  assignments.unshift(prior);
  await json(path.join(episodeDir, "section_image_prompts_hardened.json"), { status: "passed", prompts });
  const bulkPlan = { schema: "goldflow_fal_bulk_plan_v1", assignment_count: assignments.length, assignments };
  await json(path.join(root, "bulk-plan.json"), bulkPlan);
  const expected = {};
  for (const [key, name] of Object.entries({ run_identity_sha256: "run_identity.json",
    source_script_sha256: "script_clean.md", visual_beat_plan_sha256: "visual_beat_plan.json",
    visual_beat_approval_sha256: "visual_beat_approval.json",
    hardened_prompt_plan_sha256: "section_image_prompts_hardened.json",
    bulk_plan_sha256: "fal/bulk-plan.json" })) expected[key] = await fileSha(path.join(episodeDir, name));
  const paths = falPostplanPromptCorrectionPaths(episodeDir);
  await json(paths.request, { schema: "goldflow_fal_postplan_prompt_correction_request_v1",
    expected, reviewer: "Codex", note: "Two unsubmitted authored overlays contradict source chronology or the current duel scene.",
    corrections });
  return { episodeDir, bulkPlan, paths, assignments, corrections, prior };
}

test("post-plan correction creates two append-only alternate assignments and preserves paid receipts", async () => {
  const f = await fixture();
  try {
    const bulkSha = await fileSha(path.join(f.episodeDir, "fal", "bulk-plan.json"));
    const priorSha = await fileSha(f.prior.submission_receipt_path);
    const pending = await inspectFalPostplanPromptCorrection(f);
    assert.equal(pending.state, "pending");
    assert.match(pending.assignments[1].prompt, /free of lettering/);
    assert.match(pending.assignments[2].prompt, /Too fast\. above Joey/);
    assert.equal(pending.assignments[1].submission_receipt_path, f.assignments[1].submission_receipt_path);
    assert.equal(Object.hasOwn(pending.assignments[1], "previous_assignment_sha256"), false);
    await applyFalPostplanPromptCorrection({ ...f, requestPath: f.paths.request });
    const applied = await inspectFalPostplanPromptCorrection(f);
    assert.equal(applied.state, "applied");
    assert.equal(applied.receipt.preexisting_submission_receipts.length, 1);
    assert.equal(await fileSha(path.join(f.episodeDir, "fal", "bulk-plan.json")), bulkSha);
    assert.equal(await fileSha(f.prior.submission_receipt_path), priorSha);
    await json(f.assignments[1].submission_receipt_path, {
      assignment_sha256: applied.assignments[1].assignment_sha256,
      prompt_sha256: applied.assignments[1].prompt_sha256, request_id: "new" });
    assert.equal((await inspectFalPostplanPromptCorrection(f)).state, "applied");
  } finally { await rm(f.episodeDir, { recursive: true, force: true }); }
});

test("post-plan correction rejects stale source, submitted targets, changed prior receipts and wrong alternate", async () => {
  for (const scenario of ["source", "submitted", "prior", "alternate", "wrong_text"]) {
    const f = await fixture();
    try {
      if (scenario === "source") await writeFile(path.join(f.episodeDir, "script_clean.md"), "changed");
      if (scenario === "submitted") await json(f.assignments[1].submission_receipt_path, { request_id: "existing" });
      if (scenario === "wrong_text") {
        const request = JSON.parse(await readFile(f.paths.request));
        request.corrections[1].replacement_text = "Reset now.";
        await json(f.paths.request, request);
      }
      if (["source", "submitted", "wrong_text"].includes(scenario))
        await assert.rejects(inspectFalPostplanPromptCorrection(f));
      else {
        await applyFalPostplanPromptCorrection({ ...f, requestPath: f.paths.request });
        if (scenario === "prior") await json(f.prior.submission_receipt_path, { request_id: "tampered" });
        if (scenario === "alternate") await json(f.paths.alternate("shellback"), { altered: true });
        await assert.rejects(inspectFalPostplanPromptCorrection(f));
      }
    } finally { await rm(f.episodeDir, { recursive: true, force: true }); }
  }
});
