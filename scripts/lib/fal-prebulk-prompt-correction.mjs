import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { NARRATIVE_OVERLAY_KINDS } from "./narrative-overlay-contract.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const hash = value => /^[a-f0-9]{64}$/.test(String(value ?? ""));
const read = async file => JSON.parse(await fs.readFile(file, "utf8"));
const fileSha = async file => sha(await fs.readFile(file));
const exists = async file => fs.access(file).then(() => true, () => false);
const requireState = (okay, message) => { if (!okay) throw new Error(message); };
const keysOnly = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));

export const falPrebulkPromptCorrectionPaths = episodeDir => ({
  request: path.join(episodeDir, "fal", "prebulk-prompt-correction-request.json"),
  receipt: path.join(episodeDir, "fal", "prebulk-prompt-correction-receipt.json"),
});

// This is a post-validation, pre-bulk exception for source-inconsistent editorial
// lettering. It does not rewrite the locked prompt plan or any accepted raster.
export async function validateFalPrebulkPromptCorrection({ episodeDir, validationPlanPath, validationReviewPath }) {
  const paths = falPrebulkPromptCorrectionPaths(episodeDir);
  if (!await exists(paths.request)) return null;
  const root = path.join(episodeDir, "fal");
  const bulkPath = path.join(root, "bulk-plan.json");
  const bulkExists = await exists(bulkPath);
  const requiredFiles = {
    run_identity_sha256: path.join(episodeDir, "run_identity.json"),
    source_script_sha256: path.join(episodeDir, "script_clean.md"),
    visual_beat_plan_sha256: path.join(episodeDir, "visual_beat_plan.json"),
    visual_beat_approval_sha256: path.join(episodeDir, "visual_beat_approval.json"),
    hardened_prompt_plan_sha256: path.join(episodeDir, "section_image_prompts_hardened.json"),
    validation_plan_sha256: validationPlanPath,
    validation_review_sha256: validationReviewPath,
  };
  const request = await read(paths.request);
  const recoveryBound = Object.hasOwn(request.expected ?? {}, "validation_correction_sha256")
    || Object.hasOwn(request.expected ?? {}, "validation_recovery_review_sha256");
  const expectedFiles = recoveryBound ? {
    ...requiredFiles,
    validation_correction_sha256: path.join(root, "validation-review-correction.json"),
    validation_recovery_review_sha256: path.join(root, "validation-recovery-review.json"),
  } : requiredFiles;
  requireState(keysOnly(request, ["schema", "expected", "reviewer", "note", "corrections"])
    && request.schema === "goldflow_fal_prebulk_prompt_correction_request_v1"
    && typeof request.reviewer === "string" && request.reviewer.trim()
    && typeof request.note === "string" && request.note.trim().length > 30
    && keysOnly(request.expected, Object.keys(expectedFiles))
    && Object.keys(request.expected).length === Object.keys(expectedFiles).length,
  "Fal pre-bulk prompt correction requires a reviewed, exactly bound request.");
  for (const [key, file] of Object.entries(expectedFiles)) {
    requireState(hash(request.expected[key]) && request.expected[key] === await fileSha(file),
      `Fal pre-bulk correction source changed: ${key}`);
  }
  const [identity, beats, beatApproval, hardened, validationPlan, validationReview, script] = await Promise.all([
    read(expectedFiles.run_identity_sha256), read(expectedFiles.visual_beat_plan_sha256),
    read(expectedFiles.visual_beat_approval_sha256), read(expectedFiles.hardened_prompt_plan_sha256),
    read(validationPlanPath), read(validationReviewPath), fs.readFile(expectedFiles.source_script_sha256, "utf8"),
  ]);
  const recoveryReview = recoveryBound ? await read(expectedFiles.validation_recovery_review_sha256) : null;
  requireState(identity.image_provider === "fal_ai"
    && beats.status === "passed" && beatApproval.status === "approved"
    && hardened.status === "passed" && Array.isArray(hardened.prompts)
    && validationPlan.schema === "goldflow_fal_validation_plan_v1"
    && (recoveryBound
      ? validationReview.status === "failed" && recoveryReview?.status === "passed"
      : validationReview.status === "passed"),
  "Fal pre-bulk correction requires locked source, approved beats, passed hardening and passed validation.");
  requireState(Array.isArray(request.corrections) && request.corrections.length >= 1 && request.corrections.length <= 8
    && new Set(request.corrections.map(row => row.image_id)).size === request.corrections.length,
  "Fal pre-bulk correction requires one to eight distinct ungenerated cuts.");
  const validationIds = new Set(validationPlan.assignments.map(row => row.image_id));
  const materializedImageNames = bulkExists ? [] : await fs.readdir(path.join(episodeDir, "assets", "images"))
    .catch(error => error.code === "ENOENT" ? [] : Promise.reject(error));
  const effectivePrompts = new Map();
  const originalHashes = {};
  const effectiveHashes = {};
  for (const directive of request.corrections) {
    requireState(keysOnly(directive, ["image_id", "visual_beat_id", "source_quote", "overlay_kind",
      "overlay_text", "old_prompt_sha256", "old_overlay_sha256", "before_span", "replacement_span",
      "replacement_prompt_sha256", "reason"])
      && typeof directive.image_id === "string" && typeof directive.visual_beat_id === "string"
      && typeof directive.source_quote === "string" && directive.source_quote.length >= 12
      && typeof directive.reason === "string" && directive.reason.trim().length > 25
      && hash(directive.old_prompt_sha256) && hash(directive.old_overlay_sha256)
      && hash(directive.replacement_prompt_sha256)
      && typeof directive.before_span === "string" && directive.before_span.length > 20
      && typeof directive.replacement_span === "string" && directive.replacement_span.length > 20,
    `Fal pre-bulk correction directive is incomplete: ${directive.image_id}`);
    const row = hardened.prompts.find(item => item.image_id === directive.image_id);
    requireState(row && row.image_generation_required !== false && !validationIds.has(directive.image_id)
      && !materializedImageNames.some(name => (name === `${directive.image_id}.png`
        || name.startsWith(`${directive.image_id}-`)) && /\.(?:png|jpe?g|webp)$/i.test(name))
      && row.visual_beat_id === directive.visual_beat_id
      && row.visual_beat_script_excerpt?.includes(directive.source_quote)
      && script.includes(directive.source_quote)
      && row.provider_prompt === row.image_prompt
      && (!row.modelslab_image_prompt || row.modelslab_image_prompt === row.provider_prompt),
    `Fal pre-bulk correction cut is missing, already validated, or not source-bound: ${directive.image_id}`);
    requireState(row.narrative_overlays?.length === 1
      && NARRATIVE_OVERLAY_KINDS.includes(directive.overlay_kind)
      && row.narrative_overlays[0].kind === directive.overlay_kind
      && row.narrative_overlays[0].text === directive.overlay_text
      && sha(JSON.stringify(row.narrative_overlays)) === directive.old_overlay_sha256
      && sha(row.provider_prompt) === directive.old_prompt_sha256,
    `Fal pre-bulk correction overlay or prompt changed: ${directive.image_id}`);
    const first = row.provider_prompt.indexOf(directive.before_span);
    requireState(first >= 0 && row.provider_prompt.indexOf(directive.before_span, first + 1) < 0
      && directive.before_span.includes(directive.overlay_text)
      && /\b(?:no lettering|free of lettering)\b/i.test(directive.replacement_span)
      && !/\b(?:thought|speech) bubble\b/i.test(directive.replacement_span),
    `Fal pre-bulk correction must remove exactly one source-inconsistent overlay: ${directive.image_id}`);
    const prompt = row.provider_prompt.replace(directive.before_span, directive.replacement_span);
    requireState(prompt !== row.provider_prompt && !prompt.includes(directive.overlay_text)
      && sha(prompt) === directive.replacement_prompt_sha256,
    `Fal pre-bulk corrected prompt differs from the reviewed exact replacement: ${directive.image_id}`);
    if (!bulkExists) {
      for (const file of [path.join(root, "bulk", "outputs", `${directive.image_id}.png`),
        path.join(root, "bulk", "assignments", `${directive.image_id}.json`),
        path.join(root, "bulk", "submission-receipts", `${directive.image_id}.json`),
        path.join(root, "bulk", "result-receipts", `${directive.image_id}.json`)]) {
        requireState(!await exists(file), `Fal pre-bulk correction cannot change an already submitted cut: ${directive.image_id}`);
      }
    }
    effectivePrompts.set(directive.image_id, prompt);
    originalHashes[directive.image_id] = directive.old_prompt_sha256;
    effectiveHashes[directive.image_id] = directive.replacement_prompt_sha256;
  }
  const receipt = {
    schema: "goldflow_fal_prebulk_prompt_correction_receipt_v1",
    status: "approved",
    request_sha256: await fileSha(paths.request),
    ...request.expected,
    reviewer: request.reviewer,
    note: request.note,
    corrected_image_ids: request.corrections.map(row => row.image_id),
    original_prompt_sha256_by_id: originalHashes,
    effective_prompt_sha256_by_id: effectiveHashes,
  };
  const recorded = await exists(paths.receipt);
  if (recorded) requireState(JSON.stringify(await read(paths.receipt)) === JSON.stringify(receipt),
    "Fal pre-bulk correction receipt differs from its immutable reviewed request.");
  if (bulkExists) {
    requireState(recorded, "Fal pre-bulk correction was added after bulk planning.");
    const bulk = await read(bulkPath);
    requireState(bulk.prebulk_prompt_correction_receipt_sha256 === await fileSha(paths.receipt)
      && JSON.stringify(bulk.prebulk_corrected_image_ids) === JSON.stringify(receipt.corrected_image_ids)
      && request.corrections.every(item => bulk.assignments.some(row => row.image_id === item.image_id
        && row.prompt.startsWith(effectivePrompts.get(item.image_id))
        && row.prebulk_prompt_correction_receipt_sha256 === bulk.prebulk_prompt_correction_receipt_sha256
        && row.prompt_sha256 === sha(row.prompt))),
    "Fal bulk assignments are not bound to the reviewed pre-bulk correction.");
  }
  return { paths, request, receipt, recorded, effectivePrompts };
}
