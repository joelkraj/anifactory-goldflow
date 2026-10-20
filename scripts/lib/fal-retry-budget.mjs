import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { falAdjudicationForAttempt } from "./fal-ambiguous-adjudication.mjs";

const RETRY_FRACTION = 0.10;
// Measured billed rates per paid request (USD) by endpoint and output canvas,
// read from Fal billing events, not list prices:
// - sunburst/edit 1920x1080 with a 1920 board: $0.0176 (coma-healer, 658 requests, $11.58);
//   the 2026-09-29 dashboard showed $0.01806 over 3,088 edits.
// - sunburst/edit 3840x2160 with a 1920 board: $0.0263 (reference_board_size_cost_test_v1, 4 pages).
// - text-to-image 1920x1080: $0.0061 (124 references, about $0.76).
// Rows marked derived add Fal's list delta for the larger output to the measured 1920 rate.
// A rolling median of this episode's reconciled billed costs replaces a row once it exists.
export const FAL_MEASURED_PAID_REQUEST_USD = Object.freeze({
  "openai/gpt-image-2.5/sunburst/edit": Object.freeze({ "1920x1080": 0.0176, "2560x1440": 0.0193, "3840x2160": 0.0263 }),
  "openai/gpt-image-2.5/sunburst/text-to-image": Object.freeze({ "1920x1080": 0.0061, "2560x1440": 0.0078, "3840x2160": 0.0128 }),
});
export const FAL_DEFAULT_PAID_REQUEST_USD = FAL_MEASURED_PAID_REQUEST_USD["openai/gpt-image-2.5/sunburst/edit"]["1920x1080"];
// Compatibility alias for callers that still project at one flat rate.
export const FAL_PROJECTED_PAID_REQUEST_USD = FAL_DEFAULT_PAID_REQUEST_USD;
// Per-request cost ceilings are 3x the measured rate, locked at preflight in the
// identity's Fal contract and never raised from billed data.
export const FAL_PER_REQUEST_CAP_MULTIPLIER = 3;
export const FAL_SPEND_WARNING_FRACTION = 0.7;
export const FAL_COST_RECONCILED_SCHEMA = "goldflow_fal_cost_reconciled_v1";
export const FAL_BILLING_RECONCILIATION_DIR = "fal/billing/reconciliations";

export function falCanvasKey(imageSize) {
  const width = Number(imageSize?.width ?? 1920), height = Number(imageSize?.height ?? 1080);
  return `${width}x${height}`;
}
function roundUsd(value) { return Number(Number(value).toFixed(4)); }

/** Measured rate for an endpoint/canvas; unknown rows fall back to the 1920 edit rate. */
export function falMeasuredRateUsd({ endpoint, imageSize } = {}) {
  const row = FAL_MEASURED_PAID_REQUEST_USD[String(endpoint ?? "")];
  return row?.[falCanvasKey(imageSize)] ?? row?.["1920x1080"] ?? FAL_DEFAULT_PAID_REQUEST_USD;
}

/** The locked cap table written into a new Fal contract (3x measured, every endpoint/canvas). */
export function buildFalPerRequestCaps() {
  return Object.fromEntries(Object.entries(FAL_MEASURED_PAID_REQUEST_USD).map(([endpoint, rows]) => [endpoint,
    Object.fromEntries(Object.entries(rows).map(([canvas, usd]) => [canvas, roundUsd(usd * FAL_PER_REQUEST_CAP_MULTIPLIER)]))]));
}

/** Cap for one assignment: the identity's locked table when present, else the built-in 3x table. */
export function falPerRequestCapUsd({ endpoint, imageSize, caps = null } = {}) {
  const locked = caps?.[String(endpoint ?? "")]?.[falCanvasKey(imageSize)];
  if (Number.isFinite(Number(locked)) && Number(locked) > 0) return Number(locked);
  return roundUsd(falMeasuredRateUsd({ endpoint, imageSize }) * FAL_PER_REQUEST_CAP_MULTIPLIER);
}

/**
 * Rolling billed state from append-only cost_reconciled records: the latest
 * billed cost per request_id and the median billed cost per endpoint/canvas.
 */
export async function falBilledRateState(episodeDir) {
  const dir = path.join(episodeDir, FAL_BILLING_RECONCILIATION_DIR);
  const names = (await fs.readdir(dir).catch(error => { if (error.code === "ENOENT") return []; throw error; }))
    .filter(name => /^\d{4}_.*\.json$/.test(name)).sort();
  const byRequestId = new Map();
  for (const name of names) {
    const record = JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
    if (record.schema !== FAL_COST_RECONCILED_SCHEMA) throw new Error(`Invalid Fal cost reconciliation record: ${path.join(dir, name)}`);
    for (const row of record.rows ?? []) {
      if (row.cost_basis !== "billed" || !Number.isFinite(Number(row.cost_usd))) continue;
      byRequestId.set(row.request_id, { cost_usd: Number(row.cost_usd), endpoint: row.endpoint, image_size: row.image_size ?? null, record_path: path.join(dir, name) });
    }
  }
  const samples = new Map();
  for (const row of byRequestId.values()) {
    const key = `${row.endpoint}|${falCanvasKey(row.image_size)}`;
    if (!samples.has(key)) samples.set(key, []);
    samples.get(key).push(row.cost_usd);
  }
  const medianByKey = {};
  for (const [key, values] of samples) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    medianByKey[key] = { median_usd: roundUsd(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2), count: sorted.length };
  }
  return { billed_by_request_id: byRequestId, median_usd_by_key: medianByKey, record_count: names.length };
}

/** Projected rate for one request: this episode's billed median when it exists, else the measured table. */
export function falProjectedRateUsd({ endpoint, imageSize, billedState = null } = {}) {
  const median = billedState?.median_usd_by_key?.[`${endpoint}|${falCanvasKey(imageSize)}`];
  if (median?.count > 0) return { rate_usd: median.median_usd, rate_source: "episode_billed_median" };
  return { rate_usd: falMeasuredRateUsd({ endpoint, imageSize }), rate_source: "measured_table" };
}
const REPAIR_RECEIPT_DIRS = Object.freeze([
  "validation-recovery/submission-receipts",
  "validation-recovery-second/submission-receipts",
  "reference/repair-submission-receipts",
  "reference/transport-recovery-submission-receipts",
  "reference/review-repair-submission-receipts",
  "reference/review-repair-v3-submission-receipts",
  "bulk/repair-submission-receipts",
  "bulk/repair-v2-submission-receipts",
  "bulk/review-repair-submission-receipts",
  "bulk/review-repair-transport-recovery-submission-receipts",
  "bulk/transport-recovery-submission-receipts",
  "bulk/ambiguous-retry-submission-receipts",
  "zone-repair/submission-receipts",
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
    request_id: receipt.request_id, endpoint: receipt.endpoint ?? null, image_size: receipt.params?.image_size ?? null,
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
  const unresolved = [];
  for (const row of groups.flat().filter(row => row.ambiguous)) {
    const originalBulk = path.relative(root, row.submission_receipt_path)
      .startsWith(`bulk${path.sep}submission-receipts${path.sep}`);
    if (!originalBulk || !await falAdjudicationForAttempt(episodeDir, row)) unresolved.push(row);
  }
  return unresolved;
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
export function falProjectedSpendUsd(requestCount, rateUsd = FAL_DEFAULT_PAID_REQUEST_USD) {
  if (!Number.isSafeInteger(requestCount) || requestCount < 0) throw new Error("Fal projection needs a nonnegative request count.");
  if (!Number.isFinite(rateUsd) || rateUsd < 0) throw new Error("Fal projection needs a nonnegative rate.");
  return Number((requestCount * rateUsd).toFixed(4));
}

/**
 * Cost of a set of paid submissions: billed where a cost_reconciled record
 * covers the request_id, projected (billed median, else measured table) otherwise.
 */
export function falSubmissionCostState(rows, billedState = null) {
  let billedUsd = 0, projectedUsd = 0, billedCount = 0;
  const sources = new Set();
  for (const row of rows) {
    const billed = row.request_id ? billedState?.billed_by_request_id?.get(row.request_id) : null;
    if (billed) { billedUsd += billed.cost_usd; billedCount += 1; continue; }
    const rate = falProjectedRateUsd({ endpoint: row.endpoint, imageSize: row.image_size, billedState });
    projectedUsd += rate.rate_usd; sources.add(rate.rate_source);
  }
  const total = roundUsd(billedUsd + projectedUsd);
  return {
    paid_submissions: rows.length, billed_count: billedCount, billed_usd: roundUsd(billedUsd),
    projected_count: rows.length - billedCount, projected_usd: roundUsd(projectedUsd), total_usd: total,
    cost_basis: rows.length === 0 ? "none" : billedCount === rows.length ? "billed" : billedCount ? "mixed" : "projected",
    rate_sources: [...sources].sort(),
  };
}

/** Every paid submission of the episode with its endpoint/canvas and billed cost where reconciled. */
export async function falEpisodeSpendState(episodeDir) {
  const root = path.join(episodeDir, "fal");
  const groups = await Promise.all([...INITIAL_RECEIPT_DIRS, ...REPAIR_RECEIPT_DIRS].map(dir => paidSubmissionsIn(root, dir)));
  const billedState = await falBilledRateState(episodeDir);
  return { ...falSubmissionCostState(groups.flat(), billedState), billed_state: billedState };
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

export async function falPaidSubmissionCount(episodeDir) {
  const root = path.join(episodeDir, "fal");
  const groups = await Promise.all([...INITIAL_RECEIPT_DIRS, ...REPAIR_RECEIPT_DIRS]
    .map(dir => paidSubmissionsIn(root, dir)));
  return groups.flat().length;
}

export async function falSpendProjectionState({ episodeDir, warningBudgetUsd, hardBudgetUsd }) {
  if (!Number.isFinite(warningBudgetUsd) || !Number.isFinite(hardBudgetUsd)
    || warningBudgetUsd <= 0 || hardBudgetUsd <= warningBudgetUsd) {
    throw new Error("Fal spend projection requires valid locked warning and hard budgets.");
  }
  const spend = await falEpisodeSpendState(episodeDir);
  const paidSubmissions = spend.paid_submissions;
  const projectedSpendUsd = spend.total_usd;
  return {
    paid_submissions: paidSubmissions, projected_spend_usd: projectedSpendUsd,
    billed_usd: spend.billed_usd, billed_count: spend.billed_count, cost_basis: spend.cost_basis, rate_sources: spend.rate_sources,
    warning_budget_usd: warningBudgetUsd, hard_budget_usd: hardBudgetUsd,
    warning_reached: projectedSpendUsd >= warningBudgetUsd,
    hard_reached: projectedSpendUsd >= hardBudgetUsd,
    estimate_only: spend.billed_count < paidSubmissions, actual_charge_usd: spend.billed_count ? spend.billed_usd : null,
    pricing_note: "Billed USD comes only from append-only cost_reconciled records (imagegen fal --action billing-reconcile); unreconciled requests are projected at this episode's billed median per endpoint/canvas, else the measured table (1920 edit $0.0176). Projections are estimates, not provider quotes.",
  };
}

export async function assertFalSpendProjectionBudget({ episodeDir, assignments, warningBudgetUsd, hardBudgetUsd }) {
  const state = await falSpendProjectionState({ episodeDir, warningBudgetUsd, hardBudgetUsd });
  const billedState = await falBilledRateState(episodeDir);
  const batchUsd = assignments.reduce((sum, row) => sum + falProjectedRateUsd({ endpoint: row.endpoint, imageSize: row.image_size, billedState }).rate_usd, 0);
  const projectedAfterBatch = roundUsd(state.projected_spend_usd + batchUsd);
  if (state.hard_reached || projectedAfterBatch >= hardBudgetUsd) {
    throw new Error(`Fal projected spend reaches the locked $${hardBudgetUsd} hard budget ($${state.projected_spend_usd} already projected + ${assignments.length} new requests). This is an estimate only; verify actual Fal balance before further spend.`);
  }
  return { ...state, requested_submissions: assignments.length, requested_batch_usd: roundUsd(batchUsd),
    projected_spend_after_batch_usd: projectedAfterBatch,
    warning_after_batch: projectedAfterBatch >= warningBudgetUsd,
    warning_70_percent_after_batch: projectedAfterBatch >= FAL_SPEND_WARNING_FRACTION * hardBudgetUsd };
}
