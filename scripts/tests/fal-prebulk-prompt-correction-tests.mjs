import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  falPrebulkPromptCorrectionPaths,
  validateFalPrebulkPromptCorrection,
} from "../lib/fal-prebulk-prompt-correction.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const fileSha = async file => sha(await readFile(file));
async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function fixture({ recoveredValidation = true, statusOverlay = false } = {}) {
  const episodeDir = await mkdtemp(path.join(os.tmpdir(), "goldflow-fal-prebulk-correction-"));
  const root = path.join(episodeDir, "fal");
  await mkdir(root);
  await writeJson(path.join(episodeDir, "run_identity.json"), {
    image_provider: "fal_ai", visual_restart: { fork_at: "visual_reference_plan" }, episode: "ep_01",
  });
  const source = "First, the approach promised a hug. Dad silenced Caleb. Mom left a repaired jacket without an apology. Venn explained Dad wanted a different fight.";
  await writeFile(path.join(episodeDir, "script_clean.md"), source);
  await writeJson(path.join(episodeDir, "visual_beat_plan.json"), { status: "passed" });
  await writeJson(path.join(episodeDir, "visual_beat_approval.json"), { status: "approved" });
  const facts = [
    ["cut-hug", "the approach promised a hug", "Is he forgiving me?", "thought_bubble"],
    ["cut-dad", "Dad silenced Caleb", "You crossed a line.", "speech_bubble"],
    ["cut-mom", "Mom left a repaired jacket without an apology", "Her apology stayed.", "thought_bubble"],
    ["cut-venn", "Venn explained Dad wanted a different fight", "He was protecting my options.", "thought_bubble"],
  ];
  const prompts = [];
  const corrections = [];
  for (const [id, sourceQuote, bubbleText, kindFromFact] of facts) {
    const kind = statusOverlay && id === "cut-venn" ? "rpg_game_text" : kindFromFact;
    const beforeSpan = kind === "rpg_game_text"
      ? `Add one status panel reading “${bubbleText}” beside the face.`
      : `Add one ${kind === "speech_bubble" ? "speech" : "thought"} bubble reading “${bubbleText}” beside the face.`;
    const replacementSpan = "Keep this exact shot free of lettering; carry the meaning in the visible expression.";
    const providerPrompt = `Depict the source action: ${sourceQuote}. ${beforeSpan} One coherent frame.`;
    const narrativeOverlays = [{ kind, text: bubbleText }];
    const row = { image_id: id, visual_beat_id: `beat-${id}`, visual_beat_script_excerpt: sourceQuote,
      image_generation_required: true, provider_prompt: providerPrompt, image_prompt: providerPrompt,
      modelslab_image_prompt: providerPrompt, narrative_overlays: narrativeOverlays };
    prompts.push(row);
    corrections.push({ image_id: id, visual_beat_id: row.visual_beat_id, source_quote: sourceQuote,
      overlay_kind: kind, overlay_text: bubbleText, old_prompt_sha256: sha(providerPrompt),
      old_overlay_sha256: sha(JSON.stringify(narrativeOverlays)), before_span: beforeSpan,
      replacement_span: replacementSpan, replacement_prompt_sha256: sha(providerPrompt.replace(beforeSpan, replacementSpan)),
      reason: "The invented line gives the family member an unearned motive or apology contrary to the exact source." });
  }
  await writeJson(path.join(episodeDir, "section_image_prompts_hardened.json"), { status: "passed", prompts });
  const validationPlanPath = path.join(root, "validation-plan.json");
  const validationReviewPath = path.join(root, "validation-review.json");
  await writeJson(validationPlanPath, { schema: "goldflow_fal_validation_plan_v1",
    assignments: Array.from({ length: 8 }, (_, i) => ({ image_id: `validated-${i}` })) });
  await writeJson(validationReviewPath, { status: recoveredValidation ? "failed" : "passed" });
  if (recoveredValidation) {
    await writeJson(path.join(root, "validation-review-correction.json"), { status: "needs_exact_recovery" });
    await writeJson(path.join(root, "validation-recovery-review.json"), { status: "passed" });
  }
  const expected = {
    run_identity_sha256: await fileSha(path.join(episodeDir, "run_identity.json")),
    source_script_sha256: await fileSha(path.join(episodeDir, "script_clean.md")),
    visual_beat_plan_sha256: await fileSha(path.join(episodeDir, "visual_beat_plan.json")),
    visual_beat_approval_sha256: await fileSha(path.join(episodeDir, "visual_beat_approval.json")),
    hardened_prompt_plan_sha256: await fileSha(path.join(episodeDir, "section_image_prompts_hardened.json")),
    validation_plan_sha256: await fileSha(validationPlanPath),
    validation_review_sha256: await fileSha(validationReviewPath),
    ...(recoveredValidation ? {
      validation_correction_sha256: await fileSha(path.join(root, "validation-review-correction.json")),
      validation_recovery_review_sha256: await fileSha(path.join(root, "validation-recovery-review.json")),
    } : {}),
  };
  const paths = falPrebulkPromptCorrectionPaths(episodeDir);
  await writeJson(paths.request, { schema: "goldflow_fal_prebulk_prompt_correction_request_v1", expected,
    reviewer: "Codex", note: "Full source and prompt comparison identified four ungenerated bubbles that change family intent or imply an apology.",
    corrections });
  return { episodeDir, root, paths, expected, corrections, validationPlanPath, validationReviewPath };
}

test("pre-bulk correction binds exactly four ungenerated source-backed bubble removals and immutable receipt", async () => {
  const f = await fixture();
  try {
    const beforeHash = await fileSha(path.join(f.episodeDir, "section_image_prompts_hardened.json"));
    const result = await validateFalPrebulkPromptCorrection(f);
    assert.equal(result.recorded, false);
    assert.deepEqual([...result.effectivePrompts.keys()], f.corrections.map(row => row.image_id));
    await writeJson(f.paths.receipt, result.receipt);
    assert.equal((await validateFalPrebulkPromptCorrection(f)).recorded, true);
    assert.equal(await fileSha(path.join(f.episodeDir, "section_image_prompts_hardened.json")), beforeHash);
    const assignments = f.corrections.map(item => {
      const prompt = result.effectivePrompts.get(item.image_id);
      return { image_id: item.image_id, prompt, prompt_sha256: sha(prompt),
        prebulk_prompt_correction_receipt_sha256: null };
    });
    for (const row of assignments) row.prebulk_prompt_correction_receipt_sha256 = await fileSha(f.paths.receipt);
    await writeJson(path.join(f.root, "bulk-plan.json"), {
      prebulk_prompt_correction_receipt_sha256: await fileSha(f.paths.receipt),
      prebulk_corrected_image_ids: f.corrections.map(row => row.image_id), assignments,
    });
    assert.equal((await validateFalPrebulkPromptCorrection(f)).recorded, true);
  } finally { await rm(f.episodeDir, { recursive: true, force: true }); }
});

test("same guard supports a passed first review and a false RPG status overlay", async () => {
  const f = await fixture({ recoveredValidation: false, statusOverlay: true });
  try {
    const correction = await validateFalPrebulkPromptCorrection(f);
    assert.equal(correction.effectivePrompts.size, 4);
    assert.doesNotMatch(correction.effectivePrompts.get("cut-venn"), /He was protecting my options/);
    assert.equal(Object.hasOwn(correction.receipt, "validation_recovery_review_sha256"), false);
  } finally { await rm(f.episodeDir, { recursive: true, force: true }); }
});

test("pre-bulk correction fails closed on accepted cuts, changed source, submitted cut, or added scope", async () => {
  for (const scenario of ["accepted", "source", "submitted", "extra"]) {
    const f = await fixture();
    try {
      const request = JSON.parse(await readFile(f.paths.request));
      if (scenario === "accepted") request.corrections[0].image_id = "validated-0";
      if (scenario === "source") await writeFile(path.join(f.episodeDir, "script_clean.md"), "changed source");
      if (scenario === "submitted") await writeJson(path.join(f.root, "bulk", "submission-receipts", "cut-hug.json"), {});
      if (scenario === "extra") request.corrections.push({ ...request.corrections[0], image_id: "unexpected" });
      if (scenario === "accepted" || scenario === "extra") await writeJson(f.paths.request, request);
      await assert.rejects(validateFalPrebulkPromptCorrection(f));
    } finally { await rm(f.episodeDir, { recursive: true, force: true }); }
  }
});
