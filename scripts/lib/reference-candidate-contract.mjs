export const REFERENCE_CANDIDATE_STAGE_VERSION = "2026-07-11.4";

export function referenceTargetUseCount(target) {
  return Math.max(
    Number(target?.estimated_use_count ?? 0),
    Number(target?.appearance_count ?? 0),
    Array.isArray(target?.planned_beat_ids) ? target.planned_beat_ids.length : 0,
    Array.isArray(target?.scene_ids) ? target.scene_ids.length : 0,
  );
}

export function referenceCandidateCount(target, explicitCount = null) {
  if (explicitCount !== null && explicitCount !== undefined && Number.isFinite(Number(explicitCount))) {
    return Math.max(1, Math.min(6, Math.round(Number(explicitCount))));
  }
  if (Number.isFinite(Number(target?.candidate_count))) {
    return Math.max(1, Math.min(6, Math.round(Number(target.candidate_count))));
  }
  const useCount = referenceTargetUseCount(target);
  const kind = String(target?.kind ?? "");
  const priority = String(target?.priority ?? "").toLowerCase();
  const required = target?.required_before_imagegen === true || priority === "required" || priority === "high";
  if (kind === "character_state") {
    if (useCount >= 20) return 4;
    if (useCount >= 8 || required) return 3;
    return useCount >= 3 ? 2 : 1;
  }
  if (["location", "uniform", "faction", "prop", "ui", "action", "effect"].includes(kind)) {
    if (useCount >= 12 && required) return 3;
    if (useCount >= 4 || required) return 2;
  }
  return 1;
}

export function referenceSelectionRequired(target) {
  return referenceCandidateCount(target) > 1;
}

export function candidateSelectionCoverage(referenceTargets, selectionReport) {
  const selectedById = new Map((selectionReport?.targets ?? [])
    .filter((row) => row.status === "selected")
    .map((row) => [String(row.ref_id), row]));
  const missing = [];
  for (const target of referenceTargets ?? []) {
    if (!referenceSelectionRequired(target)) continue;
    const row = selectedById.get(String(target.ref_id));
    if (!row?.promotion?.official_reference_sha256) missing.push(String(target.ref_id));
  }
  return { passed: missing.length === 0, missing_ref_ids: missing };
}

export function referenceCandidatePolicyActive(identity) {
  if (String(identity?.stage_registry_version ?? "") < REFERENCE_CANDIDATE_STAGE_VERSION) return false;
  const provider = String(identity?.image_provider ?? "modelslab");
  return provider === "modelslab" || provider === "hybrid_modelslab_refs_codex_opening_modelslab_rest";
}
