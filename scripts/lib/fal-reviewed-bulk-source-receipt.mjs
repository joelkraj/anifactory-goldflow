import { promises as fs } from "node:fs";
import path from "node:path";
import { falFileSha256 } from "./fal-provider.mjs";

function need(value, message) { if (!value) throw new Error(message); }

// A selected cut can come from an exact provider-failure repair, in which case
// the original bulk assignment never produced a result receipt. Prefer the
// primary receipt whenever it exists; only its absence permits the already
// selected, hash-bound result to stand in as the source of this review repair.
export async function reviewedBulkSourceReceipt({ imageId, primaryReceiptPath,
  selectedReceiptPath, selectedReceiptSha256, selectedImagePath, selectedImageSha256 }) {
  let receiptPath = primaryReceiptPath;
  let selectedFallback = false;
  try { await fs.access(primaryReceiptPath); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    receiptPath = selectedReceiptPath;
    selectedFallback = true;
  }
  if (selectedFallback) {
    need(path.isAbsolute(receiptPath ?? "")
      && await falFileSha256(receiptPath) === selectedReceiptSha256,
      `Selected Fal result receipt changed: ${imageId}`);
  }
  const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  need(receipt.output_sha256 === await falFileSha256(receipt.output_path),
    `Original Fal result changed: ${imageId}`);
  if (selectedFallback) {
    need(receipt.output_path === selectedImagePath
      && receipt.output_sha256 === selectedImageSha256,
      `Selected Fal result receipt does not bind rejected raster: ${imageId}`);
  }
  return { receipt, receiptPath, selectedFallback };
}
