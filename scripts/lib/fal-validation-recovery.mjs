import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const hex = value => /^[a-f0-9]{64}$/.test(String(value ?? ""));
const read = async file => JSON.parse(await fs.readFile(file, "utf8"));
const fileSha = async file => sha(await fs.readFile(file));
const exists = async file => fs.access(file).then(() => true, () => false);
function requireState(condition, message) { if (!condition) throw new Error(message); }

export const falValidationRecoveryPaths = root => ({
  request: path.join(root, "validation-review-correction-request.json"),
  correction: path.join(root, "validation-review-correction.json"),
  plan: path.join(root, "validation-recovery-plan.json"),
  review: path.join(root, "validation-recovery-review.json"),
});

export async function validateFalValidationCorrection({ root, validationPlanPath, validationReviewPath }) {
  const paths = falValidationRecoveryPaths(root);
  if (!await exists(paths.request)) return null;
  const bulkPath = path.join(root, "bulk-plan.json");
  const bulkExists = await exists(bulkPath);
  requireState(!bulkExists || await exists(paths.correction), "Validation review cannot be corrected after bulk planning.");
  const [request, plan, review] = await Promise.all([
    read(paths.request), read(validationPlanPath), read(validationReviewPath),
  ]);
  if (request.schema === "goldflow_fal_failed_validation_recovery_request_v1") {
    requireState(request.validation_plan_sha256 === await fileSha(validationPlanPath)
      && request.previous_review_sha256 === await fileSha(validationReviewPath)
      && review.schema === "goldflow_fal_validation_review_v1"
      && review.status === "failed" && plan.assignments?.length === 8,
    "Failed validation recovery is not bound to the current eight-shot plan and immutable failed review.");
    const ids = plan.assignments.map(row => row.image_id);
    const approved = review.approved_ids ?? [];
    const rejected = review.rejected_ids ?? [];
    requireState(ids.length === new Set(ids).size
      && approved.length === 6 && rejected.length === 2
      && new Set([...approved, ...rejected]).size === 8
      && ids.every(id => approved.includes(id) || rejected.includes(id))
      && approved.includes(ids[0])
      && !Object.hasOwn(request, "move_to_rejected_id")
      && !Object.hasOwn(request, "moved_result_sha256")
      && !Object.hasOwn(request, "moved_output_sha256"),
    "Failed validation recovery must preserve six approved shots, including the probe, and name exactly two reviewed rejects.");
    requireState(Object.keys(request.reviewed_result_sha256_by_id ?? {}).length === 8
      && Object.keys(request.reviewed_output_sha256_by_id ?? {}).length === 8
      && ids.every(id => hex(request.reviewed_result_sha256_by_id[id])
        && hex(request.reviewed_output_sha256_by_id[id])),
    "Failed validation recovery must bind all eight reviewed result receipts and rasters.");
    for (const original of plan.assignments) {
      const receipt = await read(original.result_receipt_path);
      requireState(request.reviewed_result_sha256_by_id[original.image_id] === await fileSha(original.result_receipt_path)
        && request.reviewed_output_sha256_by_id[original.image_id] === receipt.output_sha256
        && receipt.output_sha256 === await fileSha(receipt.output_path),
      `Reviewed validation raster changed: ${original.image_id}`);
    }
    requireState(Array.isArray(request.recovery_prompts)
      && request.recovery_prompts.length === 2
      && new Set(request.recovery_prompts.map(row => row.image_id)).size === 2
      && rejected.every(id => request.recovery_prompts.some(row => row.image_id === id)),
    "Failed validation recovery prompts must cover only the two rejected shots.");
    for (const entry of request.recovery_prompts) {
      const original = plan.assignments.find(row => row.image_id === entry.image_id);
      requireState(entry.previous_assignment_sha256 === original.assignment_sha256
        && entry.previous_result_sha256 === request.reviewed_result_sha256_by_id[entry.image_id]
        && entry.previous_output_sha256 === request.reviewed_output_sha256_by_id[entry.image_id]
        && typeof entry.replacement_prompt === "string" && entry.replacement_prompt.length > 100
        && sha(entry.replacement_prompt) === entry.replacement_prompt_sha256
        && entry.replacement_prompt !== original.prompt
        && typeof entry.reason === "string" && entry.reason.trim().length > 20,
      `Failed validation replacement prompt or reviewed provenance changed: ${entry.image_id}`);
    }
    requireState(typeof request.reviewer === "string" && request.reviewer.trim()
      && typeof request.note === "string" && request.note.trim().length > 20,
    "Failed validation recovery requires an actual reviewer and material visual evidence.");
    const expected = {
      schema: "goldflow_fal_validation_review_correction_v2",
      mode: "initial_failed_review",
      request_sha256: await fileSha(paths.request),
      validation_plan_sha256: request.validation_plan_sha256,
      previous_review_sha256: request.previous_review_sha256,
      reviewer: request.reviewer,
      note: request.note,
      status: "needs_exact_recovery",
      approved_ids: approved,
      rejected_ids: rejected,
    };
    if (await exists(paths.correction)) {
      const saved = await read(paths.correction);
      requireState(JSON.stringify(saved) === JSON.stringify(expected), "Failed validation recovery changed from its hash-bound request.");
    }
    if (bulkExists) {
      const bulk = await read(bulkPath);
      requireState(bulk.validation_review_correction_sha256 === await fileSha(paths.correction)
        && await exists(paths.review)
        && bulk.validation_recovery_review_sha256 === await fileSha(paths.review),
      "Fal bulk plan is not bound to the completed failed-validation recovery review.");
    }
    return { paths, request, plan, review, expected, recorded: await exists(paths.correction) };
  }
  requireState(request.schema === "goldflow_fal_validation_review_correction_request_v1"
    && request.validation_plan_sha256 === await fileSha(validationPlanPath)
    && request.previous_review_sha256 === await fileSha(validationReviewPath)
    && review.schema === "goldflow_fal_validation_review_v1"
    && review.status === "passed" && plan.assignments?.length === 8,
  "Validation correction is not bound to the current passed eight-shot plan and immutable review.");
  const moved = String(request.move_to_rejected_id ?? "");
  const ids = plan.assignments.map(row => row.image_id);
  requireState(ids.length === new Set(ids).size
    && review.approved_ids?.length === 7 && review.rejected_ids?.length === 1
    && review.approved_ids?.length + review.rejected_ids?.length === 8
    && new Set([...review.approved_ids, ...review.rejected_ids]).size === 8
    && ids.every(id => review.approved_ids.includes(id) || review.rejected_ids.includes(id))
    && review.approved_ids.includes(moved)
    && !review.rejected_ids.includes(moved)
    && moved !== ids[0],
  "Validation correction must move exactly one accepted non-probe shot to rejected.");
  const result = await read(plan.assignments.find(row => row.image_id === moved).result_receipt_path);
  requireState(request.moved_result_sha256 === await fileSha(plan.assignments.find(row => row.image_id === moved).result_receipt_path)
    && request.moved_output_sha256 === result.output_sha256
    && result.output_sha256 === await fileSha(result.output_path),
  "Validation correction is not bound to the selected visual result.");
  const rejectedIds = [...review.rejected_ids, moved];
  requireState(Array.isArray(request.recovery_prompts)
    && request.recovery_prompts.length === rejectedIds.length
    && new Set(request.recovery_prompts.map(row => row.image_id)).size === rejectedIds.length
    && rejectedIds.every(id => request.recovery_prompts.some(row => row.image_id === id)),
  "Validation recovery prompts must cover exactly the two rejected shots.");
  for (const entry of request.recovery_prompts) {
    const original = plan.assignments.find(row => row.image_id === entry.image_id);
    const receipt = await read(original.result_receipt_path);
    requireState(entry.previous_assignment_sha256 === original.assignment_sha256
      && entry.previous_result_sha256 === await fileSha(original.result_receipt_path)
      && entry.previous_output_sha256 === receipt.output_sha256
      && receipt.output_sha256 === await fileSha(receipt.output_path)
      && typeof entry.replacement_prompt === "string" && entry.replacement_prompt.length > 100
      && sha(entry.replacement_prompt) === entry.replacement_prompt_sha256
      && entry.replacement_prompt !== original.prompt
      && typeof entry.reason === "string" && entry.reason.trim().length > 20,
    `Validation recovery prompt or prior raster provenance changed: ${entry.image_id}`);
  }
  requireState(typeof request.reviewer === "string" && request.reviewer.trim()
    && typeof request.note === "string" && request.note.trim().length > 20,
  "Validation correction requires an actual reviewer and material visual evidence.");
  const expected = {
    schema: "goldflow_fal_validation_review_correction_v1",
    request_sha256: await fileSha(paths.request),
    validation_plan_sha256: request.validation_plan_sha256,
    previous_review_sha256: request.previous_review_sha256,
    moved_result_sha256: request.moved_result_sha256,
    moved_output_sha256: request.moved_output_sha256,
    moved_to_rejected_id: moved,
    reviewer: request.reviewer,
    note: request.note,
    status: "needs_exact_recovery",
    approved_ids: review.approved_ids.filter(id => id !== moved),
    rejected_ids: rejectedIds,
  };
  if (await exists(paths.correction)) {
    const saved = await read(paths.correction);
    requireState(JSON.stringify(saved) === JSON.stringify(expected), "Additive validation correction changed from its hash-bound request.");
  }
  if (bulkExists) {
    const bulk = await read(bulkPath);
    requireState(bulk.validation_review_correction_sha256 === await fileSha(paths.correction)
      && await exists(paths.review)
      && bulk.validation_recovery_review_sha256 === await fileSha(paths.review),
    "Fal bulk plan is not bound to the completed validation correction and recovery review.");
  }
  return { paths, request, plan, review, expected, recorded: await exists(paths.correction) };
}

export async function validateFalValidationRecovery({ root, correction }) {
  if (!correction?.recorded) return null;
  const { paths, plan, expected } = correction;
  if (!await exists(paths.plan)) return { status: "plan_missing", paths };
  const recoveryPlan = await read(paths.plan);
  requireState(recoveryPlan.schema === "goldflow_fal_validation_recovery_plan_v1"
    && recoveryPlan.correction_sha256 === await fileSha(paths.correction)
    && recoveryPlan.validation_plan_sha256 === expected.validation_plan_sha256
    && recoveryPlan.assignments?.length === expected.rejected_ids.length
    && expected.rejected_ids.every(id => recoveryPlan.assignments.some(row => row.image_id === id)),
  "Exact validation recovery plan differs from corrected review.");
  for (const row of recoveryPlan.assignments) {
    const original = plan.assignments.find(item => item.image_id === row.image_id);
    const directive = correction.request.recovery_prompts.find(item => item.image_id === row.image_id);
    const assignmentPath = path.join(root, "validation-recovery", "assignments", `${row.image_id}.json`);
    const savedAssignment = await read(assignmentPath);
    const checks = {
      original: Boolean(original),
      previous_assignment: row.previous_assignment_sha256 === original?.assignment_sha256,
      previous_result: row.previous_result_sha256 === await fileSha(original.result_receipt_path),
      correction: row.recovery_correction_sha256 === recoveryPlan.correction_sha256,
      prompt: row.prompt === directive.replacement_prompt && row.prompt_sha256 === directive.replacement_prompt_sha256,
      reference_mode: row.reference_mode === original.reference_mode,
      board: row.board_sha256 === original.board_sha256,
      references: JSON.stringify(row.reference_hashes) === JSON.stringify(original.reference_hashes),
      assignment_path: row.assignment_path === assignmentPath,
    };
    requireState(Object.values(checks).every(Boolean),
      `Validation recovery assignment changed: ${row.image_id} (${Object.entries(checks).filter(([,ok])=>!ok).map(([name])=>name).join(", ")}; got ${row.assignment_path}; expected ${assignmentPath})`);
    requireState(JSON.stringify((({ assignment_path, ...rest }) => rest)(row)) === JSON.stringify(savedAssignment),
      `Validation recovery assignment file changed: ${row.image_id}`);
  }
  const submissions = await Promise.all(recoveryPlan.assignments.map(row => exists(row.submission_receipt_path)));
  const results = await Promise.all(recoveryPlan.assignments.map(row => exists(row.result_receipt_path)));
  const failures = await Promise.all(recoveryPlan.assignments.map(row => exists(path.join(root, "validation-recovery", "failure-receipts", `${row.image_id}.json`))));
  const holds = await Promise.all(recoveryPlan.assignments.map(row => exists(path.join(root, "validation-recovery", "transport-holds", `${row.image_id}.json`))));
  if (!await exists(paths.review)) return { status: "pending", paths, plan: recoveryPlan, submissions, results, failures, holds };
  requireState(results.every(Boolean), "Validation recovery cannot be reviewed until all exact results exist.");
  const review = await read(paths.review);
  requireState(review.schema === "goldflow_fal_validation_recovery_review_v1"
    && review.correction_sha256 === recoveryPlan.correction_sha256
    && review.recovery_plan_sha256 === await fileSha(paths.plan)
    && review.approved_ids?.length + review.rejected_ids?.length === expected.rejected_ids.length
    && new Set([...review.approved_ids, ...review.rejected_ids]).size === expected.rejected_ids.length
    && expected.rejected_ids.every(id => review.approved_ids.includes(id) || review.rejected_ids.includes(id))
    && review.status === (review.rejected_ids.length ? "failed" : "passed")
    && typeof review.reviewer === "string" && review.reviewer.trim()
    && typeof review.note === "string" && review.note.trim().length > 20,
  "Validation recovery review is not an exact disposition of the corrected shots.");
  for (const row of recoveryPlan.assignments) {
    const result = await read(row.result_receipt_path);
    const submission = await read(row.submission_receipt_path);
    requireState(submission.schema === "goldflow_fal_submission_receipt_v1"
      && submission.image_id === row.image_id
      && submission.assignment_sha256 === row.assignment_sha256
      && submission.request_id === result.request_id
      && result.output_path === row.output_path
      && result.output_sha256 === await fileSha(result.output_path)
      && review.result_sha256_by_id?.[row.image_id] === await fileSha(row.result_receipt_path),
    `Validation recovery review result changed: ${row.image_id}`);
  }
  return { status: review.status, paths, plan: recoveryPlan, submissions, results, failures, holds, review };
}
