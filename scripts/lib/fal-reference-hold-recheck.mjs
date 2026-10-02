import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const exists = file => fs.access(file).then(() => true, () => false);
const read = async file => JSON.parse(await fs.readFile(file, "utf8"));
const fileHash = async file => digest(await fs.readFile(file));
function need(value, message) { if (!value) throw new Error(message); }

// A transport hold says nothing about whether Fal completed the original job.
// Observe its exact request ID before any new billable assignment is considered.
export async function recheckFalReferenceHolds({ root, assignments, observe }) {
  need(path.isAbsolute(root) && Array.isArray(assignments) && typeof observe === "function",
    "Fal reference hold recheck needs a root, canonical assignments, and an observer.");
  const rows = [];
  const provenance = [];
  for (const row of assignments) {
    const holdPath = path.join(root, "reference", "transport-holds", `${row.image_id}.json`);
    const terminalObservationPath = path.join(root, "reference", "hold-observation-receipts", `${row.image_id}.json`);
    if (!await exists(holdPath) || await exists(row.result_receipt_path)
      || await exists(path.join(root, "reference", "failure-receipts", `${row.image_id}.json`))
      || await exists(terminalObservationPath)) continue;
    const [hold, submission] = await Promise.all([read(holdPath), read(row.submission_receipt_path)]);
    need(hold.schema === "goldflow_fal_transport_hold_v1"
      && hold.image_id === row.image_id
      && hold.assignment_sha256 === row.assignment_sha256
      && hold.request_id === submission.request_id
      && hold.endpoint === submission.endpoint
      && submission.image_id === row.image_id
      && submission.assignment_sha256 === row.assignment_sha256
      && submission.endpoint === row.endpoint
      && submission.request_id,
    `Fal reference hold is not bound to its original request: ${row.image_id}`);
    rows.push(row);
    provenance.push({ holdPath, submissionPath: row.submission_receipt_path,
      requestId: submission.request_id });
  }
  const results = rows.length ? await observe(rows) : [];
  need(Array.isArray(results) && results.length === rows.length,
    "Fal reference hold observer returned an incomplete result set.");
  const observations = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index], result = results[index], source = provenance[index];
    const providerStatus = String(result.status?.status ?? "").toUpperCase();
    const outcome = result.complete ? "complete" : result.failed ? "failed"
      : providerStatus === "FAILED" ? "provider_failed"
      : result.transport_pending ? "transport_pending" : "original_pending";
    const resultPath = row.result_receipt_path;
    const failurePath = path.join(root, "reference", "failure-receipts", `${row.image_id}.json`);
    need(outcome !== "complete" || await exists(resultPath),
      `Fal reference recheck completed without its original result receipt: ${row.image_id}`);
    need(outcome !== "failed" || await exists(failurePath),
      `Fal reference recheck failed without its original failure receipt: ${row.image_id}`);
    const receipt = {
      schema: "goldflow_fal_reference_hold_observation_v1",
      observed_at: new Date().toISOString(), image_id: row.image_id,
      original_assignment_sha256: row.assignment_sha256,
      original_request_id: source.requestId,
      original_submission_receipt_sha256: await fileHash(source.submissionPath),
      original_transport_hold_sha256: await fileHash(source.holdPath),
      outcome, billable_request_resubmitted: false,
      ...(providerStatus ? { provider_queue_status: providerStatus } : {}),
      ...(outcome === "complete" ? { result_receipt_sha256: await fileHash(resultPath) } : {}),
      ...(outcome === "failed" ? { failure_receipt_sha256: await fileHash(failurePath) } : {}),
    };
    const receiptPath = outcome === "original_pending"
      ? path.join(root, "reference", "hold-observation-pending-receipts", row.image_id,
        `${Date.now()}-${randomUUID()}.json`)
      : path.join(root, "reference", "hold-observation-receipts", `${row.image_id}.json`);
    await fs.mkdir(path.dirname(receiptPath), { recursive: true });
    await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    observations.push({ image_id: row.image_id, outcome, receipt_path: receiptPath });
  }
  return { status: observations.every(row => row.outcome === "complete") ? "complete" : "pending",
    checked: observations.length, complete: observations.filter(row => row.outcome === "complete").length,
    failed: observations.filter(row => row.outcome === "failed").length,
    held: observations.filter(row => ["transport_pending", "provider_failed"].includes(row.outcome)).length,
    pending: observations.filter(row => row.outcome === "original_pending").length,
    observations };
}
