import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { reviewedBulkSourceReceipt } from "../lib/fal-reviewed-bulk-source-receipt.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
async function put(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, value);
}

test("reviewed bulk source keeps the primary result when it exists", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "goldflow-fal-reviewed-primary-"));
  try {
    const primaryImage = path.join(dir, "primary.png");
    const selectedImage = path.join(dir, "selected.png");
    const primaryReceiptPath = path.join(dir, "result-receipts", "cut.json");
    const selectedReceiptPath = path.join(dir, "repair-result-receipts", "cut.json");
    await put(primaryImage, "primary raster");
    await put(selectedImage, "selected repair raster");
    await put(primaryReceiptPath, JSON.stringify({ output_path: primaryImage,
      output_sha256: sha("primary raster") }));
    await put(selectedReceiptPath, JSON.stringify({ output_path: selectedImage,
      output_sha256: sha("selected repair raster") }));
    const args = { imageId: "cut", primaryReceiptPath, selectedReceiptPath,
      selectedReceiptSha256: sha(await readFile(selectedReceiptPath)),
      selectedImagePath: selectedImage, selectedImageSha256: sha("selected repair raster") };
    const source = await reviewedBulkSourceReceipt(args);
    assert.equal(source.receiptPath, primaryReceiptPath);
    assert.equal(source.selectedFallback, false);
    assert.equal(source.receipt.output_sha256, sha("primary raster"));

    // A damaged primary cannot be silently replaced by the still-valid selection.
    await writeFile(primaryImage, "changed primary raster");
    await assert.rejects(reviewedBulkSourceReceipt(args), /Original Fal result changed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("reviewed bulk source uses only the hash-bound selected receipt when primary never succeeded", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "goldflow-fal-reviewed-fallback-"));
  try {
    const selectedImage = path.join(dir, "selected.png");
    const primaryReceiptPath = path.join(dir, "result-receipts", "cut.json");
    const selectedReceiptPath = path.join(dir, "repair-result-receipts", "cut.json");
    await put(selectedImage, "422 recovery raster");
    await put(selectedReceiptPath, JSON.stringify({ output_path: selectedImage,
      output_sha256: sha("422 recovery raster") }));
    const args = { imageId: "cut", primaryReceiptPath, selectedReceiptPath,
      selectedReceiptSha256: sha(await readFile(selectedReceiptPath)),
      selectedImagePath: selectedImage, selectedImageSha256: sha("422 recovery raster") };
    const source = await reviewedBulkSourceReceipt(args);
    assert.equal(source.receiptPath, selectedReceiptPath);
    assert.equal(source.selectedFallback, true);
    assert.equal(source.receipt.output_sha256, args.selectedImageSha256);

    await assert.rejects(reviewedBulkSourceReceipt({ ...args,
      selectedReceiptSha256: "0".repeat(64) }), /Selected Fal result receipt changed/);
    await assert.rejects(reviewedBulkSourceReceipt({ ...args,
      selectedImagePath: path.join(dir, "unselected.png") }), /does not bind rejected raster/);
    await writeFile(selectedImage, "changed selected raster");
    await assert.rejects(reviewedBulkSourceReceipt(args), /Original Fal result changed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
