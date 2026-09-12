import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { settleWavefrontPrefetchBatch } from "../run-visual-wavefront.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-batch-rejection-test-"));
const unhandled = [];
const onUnhandled = (error) => unhandled.push(error);
process.on("unhandledRejection", onUnhandled);
try {
  const combined = { status: "passed", prompts: [{ image_id: "a" }, { image_id: "b" }] };
  const planBytes = JSON.stringify(combined);
  const planPath = path.join(temp, "batch.hardened.json");
  const reportPath = path.join(temp, "batch.imagegen.json");
  await fs.writeFile(planPath, planBytes);
  const options = {
    batchId: "blocked", batchDir: temp, rows: [], combined,
    hardenedPlanPath: planPath, imagegenReportPath: reportPath,
    incrementalQaEnabled: true, hybridProvider: true,
  };
  const healthError = Object.assign(new Error("Google Flow health endpoint operation aborted"), { code: "ABORT_ERR" });
  // The planner continues for another event-loop turn before consuming its
  // queued batch promises, reproducing the original unhandled rejection gap.
  const pendingBatch = settleWavefrontPrefetchBatch(Promise.reject(healthError), options);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(unhandled, []);
  const [settled] = await Promise.allSettled([pendingBatch]);
  assert.equal(settled.status, "fulfilled");
  const blocked = settled.value;
  assert.equal(blocked.status, "prefetch_blocked");
  assert.equal(blocked.incremental_qa_eligible, false);
  assert.deepEqual(blocked.deferred_cut_ids, ["a", "b"]);
  const errorReport = JSON.parse(await fs.readFile(blocked.stream_error_path));
  assert.equal(errorReport.error_code, "ABORT_ERR");
  assert.equal(errorReport.error, healthError.message);
  assert.equal(errorReport.automatic_retry, false);

  const imagePath = path.join(temp, "retained.png");
  const imageBytes = Buffer.from("retained completion fixture");
  await fs.writeFile(imagePath, imageBytes);
  const report = {
    status: "partial", prompt_plan_path: planPath, prompt_plan_hash: sha(planBytes),
    results: [{ image_id: "a", image_path: imagePath, generated: { output_sha256: sha(imageBytes) } }],
  };
  const reportBytes = JSON.stringify(report);
  await fs.writeFile(reportPath, reportBytes);
  const partial = await settleWavefrontPrefetchBatch(Promise.reject(healthError), { ...options, batchId: "partial" });
  assert.equal(partial.status, "prefetch_blocked");
  assert.deepEqual(partial.completed_cut_ids, ["a"]);
  assert.deepEqual(partial.deferred_cut_ids, ["b"]);
  assert.equal(partial.incremental_qa_eligible, true);
  assert.equal(JSON.parse(await fs.readFile(partial.qa_imagegen_report_path)).status, "passed");
  assert.equal(await fs.readFile(reportPath, "utf8"), reportBytes);
  assert.deepEqual(await fs.readFile(imagePath), imageBytes);

  const success = await settleWavefrontPrefetchBatch(Promise.resolve({ code: 1 }), { ...options, batchId: "resolved" });
  assert.equal(success.status, "prefetch_partial_or_failed");
  assert.equal(success.stream_error_path, undefined);
  assert.deepEqual(success.completed_cut_ids, ["a"]);
  assert.deepEqual(unhandled, []);
  console.log("wavefront-batch-rejection-tests: PASS");
} finally {
  process.off("unhandledRejection", onUnhandled);
  await fs.rm(temp, { recursive: true, force: true });
}
