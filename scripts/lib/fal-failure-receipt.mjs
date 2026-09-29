import { promises as fs } from "node:fs";
import path from "node:path";

export function falFailureReceiptPath(row) {
  const resultDir = path.basename(path.dirname(row.result_receipt_path));
  const failureDir = resultDir === "repair-result-receipts" ? "repair-failure-receipts"
    : resultDir === "repair-v2-result-receipts" ? "repair-v2-failure-receipts" : "failure-receipts";
  return path.join(path.dirname(path.dirname(row.result_receipt_path)), failureDir, `${row.image_id}.json`);
}

export async function recordFalFailure(row, receipt, error) {
  const failurePath = falFailureReceiptPath(row);
  const prior = await fs.readFile(failurePath, "utf8").catch(e => e.code === "ENOENT" ? null : Promise.reject(e));
  if (prior !== null) {
    const existing = JSON.parse(prior);
    if (existing.request_id !== receipt.request_id || existing.assignment_sha256 !== row.assignment_sha256)
      throw new Error(`Existing Fal failure receipt differs: ${failurePath}`);
    return failurePath;
  }
  const failure = {
    schema: "goldflow_fal_exact_failure_v1", created_at: new Date().toISOString(), image_id: row.image_id,
    endpoint: receipt.endpoint, request_id: receipt.request_id, assignment_sha256: row.assignment_sha256,
    error_status: error.status, error_type: error.body?.detail?.[0]?.type ?? "unprocessable_entity",
    error_message: error.body?.detail?.[0]?.msg ?? error.message,
    automatic_retry: false, automatic_failover: false,
  };
  await fs.mkdir(path.dirname(failurePath), { recursive: true });
  await fs.writeFile(failurePath, `${JSON.stringify(failure, null, 2)}\n`, { flag: "wx" });
  return failurePath;
}
