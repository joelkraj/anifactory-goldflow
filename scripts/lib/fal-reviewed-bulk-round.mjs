import { promises as fs } from "node:fs";
import path from "node:path";

const safeId = value => /^[a-z0-9][a-z0-9_-]{1,100}$/.test(value);
const safeSha = value => /^[a-f0-9]{64}$/.test(value);

async function readIfExists(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

// The first reviewed repair used a legacy per-ID name. Subsequent reviews of
// that same cut must keep that immutable attempt and bind their own artifacts
// to the exact blocked QA report that rejected the currently selected raster.
export async function reviewedBulkRepairRound({ root, imageId, qaReportSha256, rejectedImageSha256 }) {
  if (!safeId(imageId) || !safeSha(qaReportSha256) || !safeSha(rejectedImageSha256))
    throw new Error("Reviewed bulk repair requires an exact safe ID and QA/raster SHA-256 values.");
  const assignmentDir = path.join(root, "bulk", "review-repair-assignments");
  const legacyPath = path.join(assignmentDir, `${imageId}.json`);
  const legacy = await readIfExists(legacyPath);
  const legacyMatches = legacy?.image_id === imageId
    && legacy.qa_report_sha256 === qaReportSha256
    && legacy.rejected_image_sha256 === rejectedImageSha256;
  if (legacy && legacy.qa_report_sha256 === qaReportSha256 && !legacyMatches)
    throw new Error(`Reviewed bulk repair legacy assignment conflicts with current QA/raster: ${imageId}`);
  const stem = legacyMatches || !legacy ? imageId : `${imageId}--${qaReportSha256}`;
  const assignmentPath = path.join(assignmentDir, `${stem}.json`);
  const assignment = legacyMatches ? legacy : stem === imageId ? null : await readIfExists(assignmentPath);
  if (assignment && (assignment.image_id !== imageId
    || assignment.qa_report_sha256 !== qaReportSha256
    || assignment.rejected_image_sha256 !== rejectedImageSha256))
    throw new Error(`Reviewed bulk repair assignment conflicts with current QA/raster: ${imageId}`);
  if (assignment && (assignment.submission_receipt_path !== path.join(root, "bulk", "review-repair-submission-receipts", `${stem}.json`)
    || assignment.result_receipt_path !== path.join(root, "bulk", "review-repair-result-receipts", `${stem}.json`)))
    throw new Error(`Reviewed bulk repair receipt paths conflict with exact QA round: ${imageId}`);
  return { stem, assignmentPath, assignment };
}
