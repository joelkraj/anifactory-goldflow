import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { reviewedBulkRepairRound } from "../lib/fal-reviewed-bulk-round.mjs";
import { falFailureReceiptPath } from "../lib/fal-failure-receipt.mjs";
import { reviewedBulkQaRepairStatusForTests } from "../run-status.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const put = async (file, value) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value); };
const json = async (file, value) => put(file, `${JSON.stringify(value)}\n`);

test("a later reviewed Fal cut uses a fresh QA-bound round and keeps the prior repair immutable", async () => {
  const episodeDir = await mkdtemp(path.join(os.tmpdir(), "goldflow-reviewed-bulk-round-"));
  try {
    const id = "ep_01-w008815-w008835";
    const root = path.join(episodeDir, "fal");
    const assignmentDir = path.join(root, "bulk", "review-repair-assignments");
    const qaPath = path.join(episodeDir, "image_output_qa_ep_01.json");
    const imagePath = path.join(root, "bulk", "review-repair-outputs", `${id}-v2.png`);
    await put(imagePath, "first reviewed replacement");
    const selectedSha = sha("first reviewed replacement");
    await json(path.join(episodeDir, "cut_execution_ledger.json"), {
      cuts: [{ image_id: id, image_path: imagePath, image_sha256: selectedSha }],
    });
    const firstQaHash = sha("first blocked QA");
    const legacyPath = path.join(assignmentDir, `${id}.json`);
    const legacy = { image_id: id, qa_report_sha256: firstQaHash, rejected_image_sha256: sha("original image"),
      submission_receipt_path: path.join(root, "bulk", "review-repair-submission-receipts", `${id}.json`),
      result_receipt_path: path.join(root, "bulk", "review-repair-result-receipts", `${id}.json`) };
    await json(legacyPath, legacy);
    const originalLegacyBytes = await readFile(legacyPath);
    await json(legacy.result_receipt_path, { output_path: imagePath, output_sha256: selectedSha });
    const qa = { status: "blocked", critical_rejected_image_ids: [id] };
    await json(qaPath, qa);
    const currentQaHash = sha(await readFile(qaPath));
    const initial = await reviewedBulkQaRepairStatusForTests(episodeDir, qa, qaPath);
    assert.deepEqual(initial, { next: "repair-reviewed-bulk", assignedCount: 0, completeCount: 0, totalCount: 1 });
    const round = await reviewedBulkRepairRound({ root, imageId: id,
      qaReportSha256: currentQaHash, rejectedImageSha256: selectedSha });
    assert.equal(round.stem, `${id}--${currentQaHash}`);
    assert.equal(round.assignment, null);
    const second = { image_id: id, qa_report_sha256: currentQaHash, rejected_image_sha256: selectedSha,
      submission_receipt_path: path.join(root, "bulk", "review-repair-submission-receipts", `${round.stem}.json`),
      result_receipt_path: path.join(root, "bulk", "review-repair-result-receipts", `${round.stem}.json`) };
    assert.equal(falFailureReceiptPath(second), path.join(root, "bulk", "review-repair-failure-receipts", `${round.stem}.json`));
    await json(round.assignmentPath, second);
    assert.deepEqual(await reviewedBulkQaRepairStatusForTests(episodeDir, qa, qaPath),
      { next: "observe-reviewed-bulk", assignedCount: 1, completeCount: 0, totalCount: 1 });
    await json(second.result_receipt_path, { output_path: path.join(root, "bulk", "review-repair-outputs", `${round.stem}.png`),
      output_sha256: sha("second reviewed replacement") });
    assert.deepEqual(await reviewedBulkQaRepairStatusForTests(episodeDir, qa, qaPath),
      { next: "finalize-reviewed-bulk", assignedCount: 1, completeCount: 1, totalCount: 1 });
    assert.deepEqual(await readFile(legacyPath), originalLegacyBytes);
    await assert.rejects(reviewedBulkRepairRound({ root, imageId: id,
      qaReportSha256: currentQaHash, rejectedImageSha256: sha("tampered raster") }), /conflicts/);
  } finally { await rm(episodeDir, { recursive: true, force: true }); }
});

test("the first reviewed Fal cut retains its original per-ID artifact naming", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "goldflow-reviewed-bulk-first-"));
  try {
    const id = "ep_01-w000001-w000010", qaHash = sha("QA"), rasterHash = sha("raster");
    const round = await reviewedBulkRepairRound({ root, imageId: id,
      qaReportSha256: qaHash, rejectedImageSha256: rasterHash });
    assert.equal(round.stem, id);
    assert.equal(round.assignmentPath, path.join(root, "bulk", "review-repair-assignments", `${id}.json`));
    assert.equal(round.assignment, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
