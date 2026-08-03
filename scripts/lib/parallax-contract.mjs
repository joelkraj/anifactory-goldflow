import { createHash } from "node:crypto";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function parallaxAssetContractSha256(report) {
  return sha256(JSON.stringify({
    source_hashes: report?.source_hashes ?? {},
    candidates: (report?.candidates ?? []).map((row) => ({
      image_id: row.image_id,
      image_sha256: row.image_sha256,
      priority: row.priority,
      foreground_evidence_path: row.foreground_evidence_path,
      foreground_evidence_mask_sha256: row.foreground_evidence?.mask_sha256,
      foreground_evidence_foreground_sha256: row.foreground_evidence?.foreground_sha256,
      separation_evidence_classification: row.separation_evidence_classification,
      asset_report_path: row.asset_report_path,
      mask_sha256: row.asset_report?.mask_sha256,
      foreground_sha256: row.asset_report?.foreground_sha256,
      background_sha256: row.asset_report?.background_sha256,
    })),
  }));
}

export function parallaxApprovalMatches(report, approval, { reportSha256 = null } = {}) {
  if (approval?.status !== "approved"
    || approval.asset_contract_sha256 !== parallaxAssetContractSha256(report)
    || (reportSha256 && approval.asset_report_sha256 !== reportSha256)) return false;
  const candidates = Array.isArray(report?.candidates) ? report.candidates : [];
  const decisions = Array.isArray(approval?.decisions) ? approval.decisions : [];
  if (decisions.length !== candidates.length) return false;
  const decisionById = new Map(decisions.map((row) => [String(row?.image_id ?? ""), row]));
  for (const candidate of candidates) {
    const decision = decisionById.get(String(candidate.image_id ?? ""));
    if (!decision
      || !["approved", "approved_low_motion", "repairable", "declined"].includes(String(decision.decision ?? ""))
      || decision.image_sha256 !== candidate.image_sha256
      || decision.asset_report_path !== candidate.asset_report_path
      || decision.mask_sha256 !== candidate.asset_report?.mask_sha256
      || decision.foreground_sha256 !== candidate.asset_report?.foreground_sha256
      || decision.background_sha256 !== candidate.asset_report?.background_sha256) return false;
  }
  const expectedApproved = decisions.filter((row) => row.decision === "approved").map((row) => String(row.image_id)).sort();
  const expectedApprovedLowMotion = decisions.filter((row) => row.decision === "approved_low_motion").map((row) => String(row.image_id)).sort();
  const expectedRepairable = decisions.filter((row) => row.decision === "repairable").map((row) => String(row.image_id)).sort();
  const expectedDeclined = decisions.filter((row) => row.decision === "declined").map((row) => String(row.image_id)).sort();
  const approved = (approval.approved_image_ids ?? []).map(String).sort();
  const approvedLowMotion = (approval.approved_low_motion_image_ids ?? []).map(String).sort();
  const repairable = (approval.repairable_image_ids ?? []).map(String).sort();
  const declined = (approval.declined_image_ids ?? []).map(String).sort();
  return JSON.stringify(approved) === JSON.stringify(expectedApproved)
    && JSON.stringify(approvedLowMotion) === JSON.stringify(expectedApprovedLowMotion)
    && JSON.stringify(repairable) === JSON.stringify(expectedRepairable)
    && JSON.stringify(declined) === JSON.stringify(expectedDeclined);
}
