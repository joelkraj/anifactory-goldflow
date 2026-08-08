import { createHash } from "node:crypto";

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function normalizedMode(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizedKind(value) {
  const kind = String(value ?? "").trim().toLowerCase();
  return kind === "character" ? "character_state" : kind;
}

function selectedRows(referenceTargets) {
  return (Array.isArray(referenceTargets) ? referenceTargets : []).map((target) => ({
    ref_id: String(target?.ref_id ?? "").trim(),
    kind: normalizedKind(target?.kind),
    generation_mode: normalizedMode(target?.generation_mode),
  }));
}

export function buildReferenceDirectorSelectionReceipt(referenceTargets, {
  sourceOutputPath = null,
  sourceOutputSha256 = null,
} = {}) {
  const rows = selectedRows(referenceTargets);
  return {
    schema: "goldflow_reference_director_selection_receipt_v1",
    policy: "Every clean target selected by the global LLM director remains in the production reference plan. Per-cut provider attachment limits are applied later and never reduce this episode reference library.",
    source_output_path: sourceOutputPath,
    source_output_sha256: sourceOutputSha256,
    selected_target_count: rows.length,
    selected_targets: rows,
    selected_ref_ids: rows.map((row) => row.ref_id),
    selected_targets_sha256: sha256(JSON.stringify(rows)),
  };
}

export function referenceDirectorSelectionFidelityFindings(plan) {
  const receipt = plan?.reference_director_selection_receipt;
  const contractVersion = String(plan?.reference_director_contract_version ?? "");
  if (!receipt) {
    return contractVersion === "reference_director_v3_full_selection"
      ? [{
          code: "reference_director_selection_receipt_missing",
          severity: "blocker",
          production_blocking: true,
          message: "Full-selection reference plans require the immutable global-director selection receipt.",
        }]
      : [];
  }
  const selected = selectedRows(receipt.selected_targets ?? []);
  const expectedCount = Number(receipt.selected_target_count ?? selected.length);
  const finalTargets = Array.isArray(plan?.reference_targets) ? plan.reference_targets : [];
  const finalById = new Map(finalTargets.map((target) => [String(target?.ref_id ?? "").trim(), target]));
  const findings = [];
  const selectedIds = selected.map((row) => row.ref_id);
  const duplicateSelectedIds = selectedIds.filter((id, index) => id && selectedIds.indexOf(id) !== index);
  const missingIds = selectedIds.filter((id) => id && !finalById.has(id));
  if (expectedCount !== selected.length || expectedCount !== selectedIds.length) {
    findings.push({
      code: "reference_director_selection_receipt_count_mismatch",
      severity: "blocker",
      production_blocking: true,
      expected_count: expectedCount,
      receipt_row_count: selected.length,
      message: "The global-director selection receipt has inconsistent target counts.",
    });
  }
  if (duplicateSelectedIds.length) {
    findings.push({
      code: "reference_director_selection_receipt_duplicate_ids",
      severity: "blocker",
      production_blocking: true,
      ref_ids: [...new Set(duplicateSelectedIds)],
      message: "The global-director selection receipt contains duplicate reference IDs.",
    });
  }
  if (missingIds.length) {
    findings.push({
      code: "post_director_reference_reduction",
      severity: "blocker",
      production_blocking: true,
      missing_ref_ids: missingIds,
      selected_target_count: expectedCount,
      final_target_count: finalTargets.length,
      message: `Post-director processing removed ${missingIds.length} globally selected reference target(s). Generate the full selection; do not prune the episode library because scene cuts can attach only four refs.`,
    });
  }
  const downgraded = selected.flatMap((selectedTarget) => {
    const finalTarget = finalById.get(selectedTarget.ref_id);
    if (!finalTarget || selectedTarget.generation_mode !== "standalone_ref") return [];
    return normalizedMode(finalTarget.generation_mode) === "standalone_ref"
      ? []
      : [{
          ref_id: selectedTarget.ref_id,
          selected_generation_mode: selectedTarget.generation_mode,
          final_generation_mode: normalizedMode(finalTarget.generation_mode),
        }];
  });
  if (downgraded.length) {
    findings.push({
      code: "post_director_reference_generation_downgrade",
      severity: "blocker",
      production_blocking: true,
      targets: downgraded,
      message: "Post-director processing changed selected standalone references into non-generatable rows.",
    });
  }
  const receiptHash = sha256(JSON.stringify(selected));
  if (receipt.selected_targets_sha256 && receipt.selected_targets_sha256 !== receiptHash) {
    findings.push({
      code: "reference_director_selection_receipt_hash_mismatch",
      severity: "blocker",
      production_blocking: true,
      message: "The global-director selection receipt hash is stale or was edited.",
    });
  }
  return findings;
}

export function assertReferenceDirectorSelectionFidelity(plan) {
  const findings = referenceDirectorSelectionFidelityFindings(plan);
  if (findings.length) {
    const first = findings[0];
    throw new Error(`${first.code}: ${first.message}`);
  }
  return true;
}
