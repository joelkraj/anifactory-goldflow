import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { falSubmissionAttemptPath } from "./fal-provider.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const present = file => fs.access(file).then(() => true, () => false);
const read = async file => JSON.parse(await fs.readFile(file, "utf8"));
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };

export function falAdjudicationPath(episodeDir, imageId) {
  requireValue(/^[a-zA-Z0-9_-]+$/.test(imageId), "Unsafe Fal image ID.");
  return path.join(episodeDir, "fal", "bulk", "ambiguous-adjudications", `${imageId}.json`);
}

export async function validateFalNoJobAdjudication({ episodeDir, assignment, spec }) {
  requireValue(spec?.schema === "goldflow_fal_no_job_adjudication_v1"
    && spec.image_id === assignment.image_id
    && spec.assignment_sha256 === assignment.assignment_sha256
    && spec.prompt_sha256 === assignment.prompt_sha256
    && spec.endpoint === assignment.endpoint,
  "Fal no-job adjudication does not bind the exact assignment.");
  const attemptPath = falSubmissionAttemptPath(assignment.submission_receipt_path);
  requireValue(await present(attemptPath) && !await present(assignment.submission_receipt_path),
    "Fal no-job adjudication requires one unresolved original attempt.");
  const attemptBytes = await fs.readFile(attemptPath);
  const attempt = JSON.parse(attemptBytes);
  requireValue(attempt.schema === "goldflow_fal_submission_attempt_v1"
    && attempt.image_id === assignment.image_id
    && attempt.assignment_sha256 === assignment.assignment_sha256
    && attempt.run_identity_sha256 === assignment.run_identity_sha256
    && attempt.endpoint === assignment.endpoint
    && attempt.submission_receipt_path === assignment.submission_receipt_path
    && spec.attempt_sha256 === hash(attemptBytes)
    && spec.attempt_created_at === attempt.created_at,
  "Fal no-job adjudication attempt binding changed.");
  requireValue(typeof spec.reviewer === "string" && spec.reviewer.trim()
    && typeof spec.note === "string" && spec.note.trim().length >= 30,
  "Fal no-job adjudication requires reviewer and substantive note.");
  requireValue(typeof spec.ui_evidence_summary === "string" && spec.ui_evidence_summary.trim().length >= 60,
    "Fal no-job adjudication requires a detailed UI evidence summary.");
  requireValue(path.isAbsolute(spec.ui_evidence_path ?? "")
    && /^[a-f0-9]{64}$/.test(spec.ui_evidence_sha256 ?? "")
    && await present(spec.ui_evidence_path)
    && hash(await fs.readFile(spec.ui_evidence_path)) === spec.ui_evidence_sha256,
  "Fal no-job adjudication requires hash-matched UI evidence.");
  const evidence=await read(spec.ui_evidence_path);
  requireValue(evidence.schema === "goldflow_fal_authenticated_history_evidence_v1"
    && evidence.missing_assignment_image_id === assignment.image_id
    && evidence.missing_prompt_visible === false
    && evidence.all_visible_ids_match_local_submission_receipts === true
    && evidence.request_time_window_start_utc === spec.observation_window_start
    && evidence.request_time_window_end_utc === spec.observation_window_end
    && JSON.stringify(evidence.visible_request_ids_in_window) === JSON.stringify(spec.adjacent_request_ids)
    && Date.parse(evidence.observed_at_utc) > Date.parse(spec.observation_window_end),
  "Fal authenticated history evidence does not bind the no-job finding and exact neighbors.");
  const start = Date.parse(spec.observation_window_start);
  const end = Date.parse(spec.observation_window_end);
  const created = Date.parse(attempt.created_at);
  requireValue(Number.isFinite(start) && Number.isFinite(end) && start <= created && created <= end
    && end - start <= 120_000, "Fal UI observation window must bracket the attempt within two minutes.");
  requireValue(Array.isArray(spec.adjacent_request_ids) && spec.adjacent_request_ids.length >= 19
    && new Set(spec.adjacent_request_ids).size === spec.adjacent_request_ids.length,
  "Fal adjudication requires distinct neighboring provider request IDs.");
  const receiptDir = path.dirname(assignment.submission_receipt_path);
  const receipts = await Promise.all((await fs.readdir(receiptDir)).filter(name => name.endsWith(".json"))
    .map(name => read(path.join(receiptDir, name))));
  const byRequest = new Map(receipts.map(row => [row.request_id, row]));
  requireValue(spec.adjacent_request_ids.every(id => {
    const row = byRequest.get(id);
    const time = Date.parse(row?.submitted_at);
    return row?.endpoint === assignment.endpoint && Number.isFinite(time)
      && time >= start && time <= end;
  }), "Fal adjacent request IDs are not locally receipted in the reviewed window.");
  return { schema: "goldflow_fal_no_job_adjudication_receipt_v1",
    adjudicated_at: new Date().toISOString(), image_id: assignment.image_id,
    assignment_sha256: assignment.assignment_sha256, prompt_sha256: assignment.prompt_sha256,
    run_identity_sha256: assignment.run_identity_sha256,
    endpoint: assignment.endpoint, attempt_path: attemptPath, attempt_sha256: hash(attemptBytes),
    attempt_created_at: attempt.created_at, reviewer: spec.reviewer, note: spec.note,
    ui_evidence_path: spec.ui_evidence_path, ui_evidence_sha256: spec.ui_evidence_sha256,
    ui_evidence_summary: spec.ui_evidence_summary,
    observation_window_start: spec.observation_window_start,
    observation_window_end: spec.observation_window_end,
    adjacent_request_ids: spec.adjacent_request_ids,
    original_attempt_preserved: true, provider_job_found: false,
    replacement_counts_as_paid_retry: true };
}

export async function falAdjudicationForAttempt(episodeDir, attempt) {
  const file = falAdjudicationPath(episodeDir, attempt.image_id);
  if (!await present(file)) return null;
  const row = await read(file);
  const attemptRecord=await read(attempt.attempt_path);
  const evidence=await read(row.ui_evidence_path);
  requireValue(row.schema === "goldflow_fal_no_job_adjudication_receipt_v1"
    && row.image_id === attempt.image_id
    && row.assignment_sha256 === attempt.assignment_sha256
    && row.run_identity_sha256 === attemptRecord.run_identity_sha256
    && row.endpoint === attemptRecord.endpoint
    && row.attempt_path === attempt.attempt_path
    && row.attempt_sha256 === hash(await fs.readFile(attempt.attempt_path))
    && row.attempt_created_at === attemptRecord.created_at
    && row.ui_evidence_sha256 === hash(await fs.readFile(row.ui_evidence_path))
    && evidence.schema === "goldflow_fal_authenticated_history_evidence_v1"
    && evidence.missing_assignment_image_id === attempt.image_id
    && evidence.missing_prompt_visible === false
    && evidence.all_visible_ids_match_local_submission_receipts === true
    && JSON.stringify(evidence.visible_request_ids_in_window) === JSON.stringify(row.adjacent_request_ids)
    && row.original_attempt_preserved === true && row.provider_job_found === false,
  "Fal ambiguous adjudication changed or is invalid.");
  return row;
}
