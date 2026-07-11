import { createHash } from "node:crypto";

// Reference generation enriches the approved plan with provider outputs. Those
// fields are execution evidence, not part of the creative contract being
// approved before spend.
const MUTABLE_REFERENCE_OUTPUT_KEYS = new Set([
  "candidate_image_ids",
  "candidate_selection",
  "conditioning_image_path",
  "derived_from_image_id",
  "derived_from_image_path",
  "derived_from_image_sha256",
  "derived_reference_promotion_updated_at",
  "derived_reference_status",
  "reference_generation_updated_at",
  "reference_candidate_selection_updated_at",
  "reference_image_path",
  "updated_at",
]);

function stableContractValue(value) {
  if (Array.isArray(value)) return value.map(stableContractValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !MUTABLE_REFERENCE_OUTPUT_KEYS.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableContractValue(nested)]),
  );
}

export function referencePlanApprovalContract(plan) {
  return stableContractValue(plan ?? null);
}

export function referencePlanApprovalContractSha256(plan) {
  return createHash("sha256")
    .update(JSON.stringify(referencePlanApprovalContract(plan)))
    .digest("hex");
}

export function referencePlanApprovalMatches({ approval, plan, fileSha256 = null }) {
  if (!["approved", "passed"].includes(String(approval?.status ?? "").toLowerCase())) return false;
  if (approval?.reference_plan_contract_sha256) {
    return approval.reference_plan_contract_sha256 === referencePlanApprovalContractSha256(plan);
  }
  return Boolean(fileSha256 && approval?.visual_reference_plan_sha256 === fileSha256);
}
