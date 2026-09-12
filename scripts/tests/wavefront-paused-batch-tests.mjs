import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { streamingBatchCompletionStatus } from "../hybrid-browser-image-pool.mjs";
import { finalizePrefetchBatch } from "../run-visual-wavefront.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const paused = {
  status: "blocked_provider_circuit",
  counts: { pending: 2, leased: 0, completed: 0, deadlettered: 0 },
  completed_asset_ids: [], failed_asset_ids: [], pending_asset_ids: ["a", "b"],
};
const beforePaused = structuredClone(paused);
assert.deepEqual(streamingBatchCompletionStatus(paused, ["a", "b"]), { status: "blocked", code: 1 });
assert.deepEqual(paused, beforePaused, "classification must preserve queue evidence");
const partial = { ...paused, counts: { ...paused.counts, pending: 1, completed: 1 }, completed_asset_ids: ["a"], pending_asset_ids: ["b"] };
assert.deepEqual(streamingBatchCompletionStatus(partial, ["a", "b"]), { status: "blocked", code: 1 });
const complete = { status: "completed", counts: { pending: 0, leased: 0 }, completed_asset_ids: ["a", "b"], failed_asset_ids: [], pending_asset_ids: [] };
assert.deepEqual(streamingBatchCompletionStatus(complete, ["a", "b"]), { status: "passed", code: 0 });
assert.deepEqual(streamingBatchCompletionStatus({ ...complete, completed_asset_ids: ["a"] }, ["a", "b"]), { status: "blocked", code: 1 });
assert.deepEqual(streamingBatchCompletionStatus({ ...complete, completed_asset_ids: ["a"], reconciled_asset_ids: ["b"] }, ["a", "b"]), { status: "passed", code: 0 });
assert.deepEqual(streamingBatchCompletionStatus({ ...complete, counts: { pending: 0, leased: 1 } }, ["a", "b"]), { status: "blocked", code: 1 });

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-paused-batch-test-"));
try {
  const hardenedPlanPath = path.join(temp, "batch.hardened.json");
  const imagegenReportPath = path.join(temp, "batch.imagegen.json");
  const combined = { status: "passed", prompts: [{ image_id: "a" }, { image_id: "b" }] };
  const planBytes = JSON.stringify(combined);
  await fs.writeFile(hardenedPlanPath, planBytes);
  const options = {
    batchId: "batch", batchDir: temp, rows: [], combined, hardenedPlanPath, imagegenReportPath,
    incrementalQaEnabled: true, hybridProvider: true, imagegen: { code: 1, phase: paused },
  };
  const missing = await finalizePrefetchBatch(options);
  assert.equal(missing.status, "prefetch_partial_or_failed");
  assert.equal(missing.incremental_qa_eligible, false);
  assert.deepEqual(missing.completed_cut_ids, []);
  assert.deepEqual(missing.deferred_cut_ids, ["a", "b"]);
  const falseSuccess = await finalizePrefetchBatch({ ...options, imagegen: { code: 0 } });
  assert.equal(falseSuccess.incremental_qa_eligible, false, "legacy false code0 cannot replace report evidence");

  const imagePath = path.join(temp, "a.png");
  const imageBytes = Buffer.from("retained-image-bytes-for-hash-binding");
  await fs.writeFile(imagePath, imageBytes);
  const report = {
    status: "partial", prompt_plan_path: hardenedPlanPath, prompt_plan_hash: hash(planBytes),
    results: [{ image_id: "a", image_path: imagePath, generated: { output_sha256: hash(imageBytes) } }],
  };
  const reportBytes = JSON.stringify(report);
  await fs.writeFile(imagegenReportPath, reportBytes);
  const partialResult = await finalizePrefetchBatch({ ...options, imagegen: { code: 1, phase: partial } });
  assert.equal(partialResult.status, "prefetch_partial_or_failed");
  assert.equal(partialResult.incremental_qa_eligible, true);
  assert.deepEqual(partialResult.completed_cut_ids, ["a"]);
  assert.deepEqual(partialResult.deferred_cut_ids, ["b"]);
  const qaReport = JSON.parse(await fs.readFile(partialResult.qa_imagegen_report_path));
  const qaPlanBytes = await fs.readFile(partialResult.qa_prompt_path);
  assert.equal(qaReport.status, "passed");
  assert.equal(qaReport.prompt_plan_hash, hash(qaPlanBytes));
  assert.deepEqual(qaReport.results, report.results);
  assert.equal(await fs.readFile(imagegenReportPath, "utf8"), reportBytes, "retain original partial report");
  assert.deepEqual(await fs.readFile(imagePath), imageBytes, "retain completed image bytes");

  await fs.writeFile(imagegenReportPath, JSON.stringify({ ...report, prompt_plan_hash: "f".repeat(64) }));
  assert.equal((await finalizePrefetchBatch(options)).incremental_qa_eligible, false, "stale prompt evidence cannot enter QA");
  await fs.writeFile(imagegenReportPath, reportBytes);
  await fs.writeFile(imagePath, "changed bytes");
  assert.equal((await finalizePrefetchBatch(options)).incremental_qa_eligible, false, "changed completion bytes cannot enter QA");

  await fs.writeFile(imagePath, imageBytes);
  const onePrompt = { status: "passed", prompts: [{ image_id: "a" }] };
  const onePlanBytes = JSON.stringify(onePrompt);
  await fs.writeFile(hardenedPlanPath, onePlanBytes);
  await fs.writeFile(imagegenReportPath, JSON.stringify({ ...report, status: "passed", prompt_plan_hash: hash(onePlanBytes) }));
  const passed = await finalizePrefetchBatch({ ...options, combined: onePrompt, imagegen: { code: 0 } });
  assert.equal(passed.status, "prefetched");
  assert.equal(passed.incremental_qa_eligible, true);
  assert.equal(passed.qa_imagegen_report_path, imagegenReportPath);
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
console.log("wavefront-paused-batch-tests: PASS");
