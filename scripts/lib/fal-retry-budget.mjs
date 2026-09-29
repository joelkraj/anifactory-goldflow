import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const RETRY_FRACTION = 0.10;
// Conservative planning allowance based on the 2026-09-29 Fal dashboard:
// 3,088 billed Sunburst edit requests cost $55.76 ($0.01806 each), while
// text-to-image averaged about $0.005. This is not a provider-enforced quote.
export const FAL_PROJECTED_PAID_REQUEST_USD = 0.022;
const REPAIR_RECEIPT_DIRS = Object.freeze([
  "reference/repair-submission-receipts",
  "reference/review-repair-submission-receipts",
  "bulk/repair-submission-receipts",
  "bulk/review-repair-submission-receipts",
  "bulk/transport-recovery-submission-receipts",
]);
const INITIAL_RECEIPT_DIRS = Object.freeze([
  "reference/submission-receipts",
  "submission-receipts",
  "validation-v2/submission-receipts",
  "bulk/submission-receipts",
]);

async function exists(file) { return fs.access(file).then(() => true, () => false); }
async function receiptsIn(dir) {
  const names = await fs.readdir(dir).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return names.filter(name => name.endsWith(".json")).map(name => path.join(dir, name));
}
async function readReceipt(file) {
  const receipt = JSON.parse(await fs.readFile(file, "utf8"));
  if (receipt.schema !== "goldflow_fal_submission_receipt_v1"
    || typeof receipt.image_id !== "string"
    || typeof receipt.assignment_sha256 !== "string"
    || typeof receipt.request_id !== "string") {
    throw new Error(`Invalid Fal submission receipt in retry accounting: ${file}`);
  }
  return receipt;
}
async function paidSubmissionsIn(root, relativeDir) {
  const dir = path.join(root, relativeDir);
  const attemptDir = path.join(path.dirname(dir), `${path.basename(dir)}-attempts`);
  const [receiptPaths, attemptPaths] = await Promise.all([receiptsIn(dir), receiptsIn(attemptDir)]);
  const receipts = new Map(await Promise.all(receiptPaths.map(async file => [path.basename(file), await readReceipt(file)])));
  const records = [...receipts].map(([name, receipt]) => ({
    image_id: receipt.image_id, assignment_sha256: receipt.assignment_sha256,
    submission_receipt_path: path.join(dir, name), ambiguous: false,
  }));
  for (const attemptPath of attemptPaths) {
    const name = path.basename(attemptPath);
    const attempt = JSON.parse(await fs.readFile(attemptPath, "utf8"));
    const submissionReceiptPath = path.join(dir, name);
    if (attempt.schema !== "goldflow_fal_submission_attempt_v1"
      || typeof attempt.image_id !== "string"
      || typeof attempt.assignment_sha256 !== "string"
      || attempt.submission_receipt_path !== submissionReceiptPath) {
      throw new Error(`Invalid Fal submission attempt in paid accounting: ${attemptPath}`);
    }
    const receipt = receipts.get(name);
    if (receipt) {
      if (receipt.image_id !== attempt.image_id || receipt.assignment_sha256 !== attempt.assignment_sha256)
        throw new Error(`Fal submission attempt and receipt differ: ${attemptPath}`);
    } else records.push({
      image_id: attempt.image_id, assignment_sha256: attempt.assignment_sha256,
      submission_receipt_path: submissionReceiptPath, attempt_path: attemptPath, ambiguous: true,
    });
  }
  return records;
}
async function possibleSubmissionExists(receiptPath) {
  const dir = path.dirname(receiptPath);
  const attemptPath = path.join(path.dirname(dir), `${path.basename(dir)}-attempts`, path.basename(receiptPath));
  return await exists(receiptPath) || await exists(attemptPath);
}
export async function falAmbiguousSubmissionAttempts(episodeDir) {
  const root = path.join(episodeDir, "fal");
  const groups = await Promise.all([...INITIAL_RECEIPT_DIRS, ...REPAIR_RECEIPT_DIRS]
    .map(dir => paidSubmissionsIn(root, dir)));
  return groups.flat().filter(row => row.ambiguous);
}
async function rejectedValidationIds(root) {
  const revised = path.join(root, "validation-review-v2.json");
  const reviewFile = await exists(revised) ? revised : path.join(root, "validation-review.json");
  if (!await exists(reviewFile)) return new Set();
  const review = JSON.parse(await fs.readFile(reviewFile, "utf8"));
  if (review.status !== "passed") return new Set();
  if (!Array.isArray(review.rejected_ids)) throw new Error(`Invalid Fal validation review: ${reviewFile}`);
  return new Set(review.rejected_ids.map(String));
}
export function falProjectedSpendUsd(requestCount) {
  if (!Number.isSafeInteger(requestCount) || requestCount < 0) throw new Error("Fal projection needs a nonnegative request count.");
  return Number((requestCount * FAL_PROJECTED_PAID_REQUEST_USD).toFixed(4));
}

export async function falRetryBudgetState(episodeDir) {
  const beatPath = path.join(episodeDir, "visual_beat_plan.json");
  const beatBytes = await fs.readFile(beatPath);
  const beatPlan = JSON.parse(beatBytes);
  const approval = JSON.parse(await fs.readFile(path.join(episodeDir, "visual_beat_approval.json"), "utf8"));
  const plannedFrames = Number(beatPlan.visual_beat_count);
  if (beatPlan.status !== "passed" || approval.status !== "approved"
    || approval.visual_beat_plan_sha256 !== createHash("sha256").update(beatBytes).digest("hex")
    || !Number.isSafeInteger(plannedFrames)
    || plannedFrames < 1 || beatPlan.beats?.length !== plannedFrames) {
    throw new Error("Fal retry cap requires the approved, complete visual beat plan.");
  }
  const root = path.join(episodeDir, "fal");
  const retryGroups = await Promise.all(REPAIR_RECEIPT_DIRS.map(dir => paidSubmissionsIn(root, dir)));
  const submissions = retryGroups.flat();
  const initialValidation = path.join(root, "submission-receipts");
  for (const row of await paidSubmissionsIn(root, "validation-v2/submission-receipts")) {
    if (await possibleSubmissionExists(path.join(initialValidation, path.basename(row.submission_receipt_path)))) submissions.push(row);
  }
  const bulkSubmissions = await paidSubmissionsIn(root, "bulk/submission-receipts");
  for (const imageId of await rejectedValidationIds(root)) {
    const repeatedBulk = bulkSubmissions.find(row => row.image_id === imageId);
    if (repeatedBulk) submissions.push(repeatedBulk);
  }
  const limit = Math.floor(plannedFrames * RETRY_FRACTION);
  return { planned_frames: plannedFrames, retry_limit: limit,
    paid_retry_submissions: submissions.length, remaining_retries: Math.max(0, limit - submissions.length) };
}

export async function assertFalRetryBudget({ episodeDir, assignments }) {
  const state = await falRetryBudgetState(episodeDir);
  const root = path.join(episodeDir, "fal");
  const validationRejected = await rejectedValidationIds(root);
  const pending = [];
  for (const row of assignments) {
    const relative = path.relative(root, row.submission_receipt_path);
    const isRepair = row.previous_assignment_sha256 || row.previous_request_id
      || row.rejected_image_sha256;
    const isRepeatedValidation = relative.startsWith(`validation-v2${path.sep}submission-receipts${path.sep}`)
      && await possibleSubmissionExists(path.join(root, "submission-receipts", path.basename(row.submission_receipt_path)));
    const isRejectedValidationBulk = relative.startsWith(`bulk${path.sep}submission-receipts${path.sep}`)
      && validationRejected.has(row.image_id);
    if (isRepair || isRepeatedValidation || isRejectedValidationBulk) pending.push(row);
  }
  if (new Set(pending.map(row => row.submission_receipt_path)).size !== pending.length) {
    throw new Error("Fal retry batch contains duplicate submission receipt paths.");
  }
  if (state.paid_retry_submissions + pending.length > state.retry_limit) {
    throw new Error(`Fal paid retry cap reached: ${state.paid_retry_submissions} used + ${pending.length} requested exceeds ${state.retry_limit} (10% of ${state.planned_frames} planned frames). Review exact IDs and hold additional image spend.`);
  }
  return { ...state, requested_paid_retries: pending.length };
}

export async function falSpendProjectionState({ episodeDir, warningBudgetUsd, hardBudgetUsd }) {
  if (!Number.isFinite(warningBudgetUsd) || !Number.isFinite(hardBudgetUsd)
    || warningBudgetUsd <= 0 || hardBudgetUsd <= warningBudgetUsd) {
    throw new Error("Fal spend projection requires valid locked warning and hard budgets.");
  }
  const root = path.join(episodeDir, "fal");
  const groups = await Promise.all([...INITIAL_RECEIPT_DIRS, ...REPAIR_RECEIPT_DIRS]
    .map(dir => paidSubmissionsIn(root, dir)));
  const paidSubmissions = groups.flat().length;
  const projectedSpendUsd = falProjectedSpendUsd(paidSubmissions);
  return {
    paid_submissions: paidSubmissions, projected_spend_usd: projectedSpendUsd,
    warning_budget_usd: warningBudgetUsd, hard_budget_usd: hardBudgetUsd,
    warning_reached: projectedSpendUsd >= warningBudgetUsd,
    hard_reached: projectedSpendUsd >= hardBudgetUsd,
    estimate_only: true, actual_charge_usd: null,
    pricing_note: "Conservative $0.022 per paid request from observed Fal dashboard billing; actual charges remain unavailable in submission/result receipts.",
  };
}

export async function assertFalSpendProjectionBudget({ episodeDir, assignments, warningBudgetUsd, hardBudgetUsd }) {
  const state = await falSpendProjectionState({ episodeDir, warningBudgetUsd, hardBudgetUsd });
  const projectedAfterBatch = falProjectedSpendUsd(state.paid_submissions + assignments.length);
  if (state.hard_reached || projectedAfterBatch >= hardBudgetUsd) {
    throw new Error(`Fal projected spend reaches the locked $${hardBudgetUsd} hard budget ($${state.projected_spend_usd} already projected + ${assignments.length} new requests). This is an estimate only; verify actual Fal balance before further spend.`);
  }
  return { ...state, requested_submissions: assignments.length,
    projected_spend_after_batch_usd: projectedAfterBatch,
    warning_after_batch: projectedAfterBatch >= warningBudgetUsd };
}
