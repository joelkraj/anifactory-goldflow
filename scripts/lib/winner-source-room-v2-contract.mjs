import { createHash } from "node:crypto";

export const EVIDENCE_STORY_ROOM_PROFILE = "evidence_story_room_v2";
export const SOURCE_EVIDENCE_REGISTRY_SCHEMA = "goldflow_source_evidence_registry_v1";
export const PACKAGE_OUTLIER_LEDGER_SCHEMA = "goldflow_package_outlier_ledger_v1";
export const PREMISE_SLATE_V2_SCHEMA = "goldflow_premise_slate_v2";
export const PREMISE_SELECTION_V2_SCHEMA = "goldflow_premise_selection_v2";
export const PACKAGE_TOURNAMENT_SCHEMA = "goldflow_package_tournament_v1";
export const PACKAGE_TOURNAMENT_CONSENSUS_SCHEMA = "goldflow_package_tournament_consensus_v1";
export const PACKAGE_ADJUDICATION_SCHEMA = "goldflow_package_adjudication_v1";
export const TREATMENT_BAKEOFF_SCHEMA = "goldflow_treatment_bakeoff_v1";
export const TREATMENT_SELECTION_SCHEMA = "goldflow_treatment_selection_v1";
export const STORY_ARCHITECTURE_SCHEMA = "goldflow_story_architecture_v1";
export const ARCHITECTURE_REDTEAM_SCHEMA = "goldflow_architecture_redteam_v1";
export const SOURCE_STAGE_APPROVAL_SCHEMA = "goldflow_source_stage_approval_v1";
export const LONGFORM_DRAFT_SELECTION_SCHEMA = "goldflow_longform_draft_selection_v1";
export const SOURCE_DIAGNOSTIC_V2_SCHEMA = "goldflow_source_diagnostic_v2";
export const SOURCE_REVISION_LEDGER_SCHEMA = "goldflow_source_revision_ledger_v1";
export const SOURCE_SEMANTIC_ACCEPTANCE_SCHEMA = "goldflow_source_semantic_acceptance_v1";
export const SOURCE_ROOM_RELEASE_V2_SCHEMA = "goldflow_source_room_release_v2";
export const REFERENCE_MERIT_FRONTIER_SCHEMA = "goldflow_reference_merit_frontier_v1";
export const REFERENCE_DENSITY_DOMINANCE_SCHEMA = "goldflow_reference_density_dominance_v1";
export const REFERENCE_DENSITY_NORMALIZATION_POLICY = "viewer_payoff_quality_per_1000_words_and_estimated_spoken_minute_v1";
export const REFERENCE_DENSITY_ROOM_PROFILE_V1 = "reference_density_frontier_v1";
export const REFERENCE_DENSITY_ROOM_PROFILE_V2 = "reference_density_frontier_v2";
export const REFERENCE_DENSITY_ROOM_PROFILE_V3 = "reference_density_frontier_tournament_v3";

export const REFERENCE_DENSITY_DIMENSION_IDS = [
  "opening_hook",
  "title_fantasy_delivery",
  "power_progression",
  "spectacle_action",
  "emotional_relationship",
  "protagonist_agency",
  "antagonist_pressure",
  "world_visual_variety",
  "middle_propulsion",
  "clarity_naturalness",
  "continuity_integrity",
  "ending_payoff",
  "estimated_apv",
];

export const FRONTIER_SEMANTIC_ACCEPTANCE_REQUIREMENT_IDS = [
  "opening_promises_resolved",
  "power_provenance_clear",
  "possession_and_history_continuity",
  "auditory_name_distinction",
  "reference_density_dominance",
];

export const SOURCE_STAGE_APPROVAL_STAGE_IDS = [
  "package_selection",
  "treatment_selection",
  "story_architecture",
  "longform_draft_selection",
  "final_script",
];

export const PREMISE_SLOT_IDS = [
  "core_1",
  "core_2",
  "core_3",
  "core_4",
  "challenger_1",
  "challenger_2",
];

export const TREATMENT_ENGINE_IDS = [
  "boundary_drama",
  "adaptive_contest",
  "reclassification_drama",
];

export const SEMANTIC_ACCEPTANCE_REQUIREMENT_IDS = [
  "title_literal_and_emotional_payment",
  "title_remains_consequential",
  "owned_protagonist_choices",
  "evidence_remembered_and_used",
  "loops_change_equation",
  "learning_changes_later_choices",
  "opposition_adapts",
  "continuity_preserved",
  "midpoint_reclassifies",
  "climax_is_causal",
  "external_local_resolution",
  "relationship_changed_state_resolution",
  "internal_contradiction_answered",
  "ordinary_future_proof",
  "continuation_without_abrupt_cutoff",
];

export const DRAMATIC_OPENING_ACCEPTANCE_REQUIREMENT_IDS = [
  "opening_event_before_exposition",
  "opening_dramatic_loop_complete",
  "opening_engine_deadline_met",
];

export const DRAMATIC_COLD_OPEN_VERSION = "dramatic_cold_open_v2";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function nonEmpty(value) {
  return Boolean(String(value ?? "").trim());
}

function pushIf(blockers, condition, code) {
  if (condition) blockers.push(code);
}

function unique(values) {
  return new Set(values).size === values.length;
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/i.test(String(value ?? ""));
}

function compareStringMaps(actual, expected) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) return false;
  const actualEntries = Object.entries(actual).sort(([left], [right]) => left.localeCompare(right));
  const expectedEntries = Object.entries(expected).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(actualEntries) === JSON.stringify(expectedEntries);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

function firstWords(text, maximumWords = 220) {
  return String(text ?? "").trim().split(/\s+/).slice(0, maximumWords).join(" ");
}

function countWords(text) {
  return String(text ?? "").trim().split(/\s+/).filter(Boolean).length;
}

function validateExactAnchor(anchor, text, prefix, blockers) {
  const start = Number(anchor?.start_offset);
  const end = Number(anchor?.end_offset);
  const exactText = String(anchor?.exact_text ?? "");
  pushIf(blockers, !Number.isInteger(start) || start < 0, `${prefix}_start_offset_invalid`);
  pushIf(blockers, !Number.isInteger(end) || end <= start || end > text.length, `${prefix}_end_offset_invalid`);
  pushIf(blockers, !exactText, `${prefix}_exact_text_missing`);
  if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= text.length && exactText) {
    pushIf(blockers, text.slice(start, end) !== exactText, `${prefix}_exact_text_mismatch`);
  }
}

function bindUniqueExactAnchor(anchor, text) {
  if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) return anchor;
  const rawExactText = String(anchor.exact_text ?? "");
  const decodedExactText = rawExactText.includes("\\n") ? rawExactText.replace(/\\n/g, "\n") : rawExactText;
  const exactText = text.includes(rawExactText)
    ? rawExactText
    : text.includes(decodedExactText)
      ? decodedExactText
      : rawExactText;
  if (!exactText) return anchor;
  const currentStart = Number(anchor.start_offset);
  const currentEnd = Number(anchor.end_offset);
  if (
    Number.isInteger(currentStart)
    && Number.isInteger(currentEnd)
    && currentStart >= 0
    && currentEnd === currentStart + exactText.length
    && text.slice(currentStart, currentEnd) === exactText
  ) {
    return exactText === rawExactText ? anchor : { ...anchor, exact_text: exactText };
  }
  const first = text.indexOf(exactText);
  if (first < 0 || text.indexOf(exactText, first + 1) >= 0) return anchor;
  return {
    ...anchor,
    exact_text: exactText,
    start_offset: first,
    end_offset: first + exactText.length,
  };
}

export function bindReferenceMeritFrontierAnchors(document, { referenceText = "" } = {}) {
  return {
    ...document,
    dimensions: (Array.isArray(document?.dimensions) ? document.dimensions : []).map((row) => ({
      ...row,
      reference_anchor: bindUniqueExactAnchor(row?.reference_anchor, referenceText),
    })),
    material_reference_edges: (Array.isArray(document?.material_reference_edges)
      ? document.material_reference_edges
      : []).map((row) => ({
      ...row,
      reference_anchor: bindUniqueExactAnchor(row?.reference_anchor, referenceText),
    })),
  };
}

export function bindReferenceDensityAnchors(document, {
  scriptText = "",
  referenceText = "",
} = {}) {
  return {
    ...document,
    dimensions: (Array.isArray(document?.dimensions) ? document.dimensions : []).map((row) => ({
      ...row,
      candidate_anchor: bindUniqueExactAnchor(row?.candidate_anchor, scriptText),
      reference_anchor: bindUniqueExactAnchor(row?.reference_anchor, referenceText),
    })),
    edge_verdicts: (Array.isArray(document?.edge_verdicts) ? document.edge_verdicts : []).map((row) => ({
      ...row,
      candidate_anchor: bindUniqueExactAnchor(row?.candidate_anchor, scriptText),
      reference_anchor: bindUniqueExactAnchor(row?.reference_anchor, referenceText),
    })),
    findings: (Array.isArray(document?.findings) ? document.findings : []).map((finding) => (
      bindUniqueExactAnchor(finding, scriptText)
    )),
  };
}

export function bindSourceSemanticAcceptanceAnchors(document, {
  scriptText = "",
  referenceText = "",
} = {}) {
  return {
    ...document,
    reference_density_verdicts: (Array.isArray(document?.reference_density_verdicts)
      ? document.reference_density_verdicts
      : []).map((row) => ({
      ...row,
      candidate_anchor: bindUniqueExactAnchor(row?.candidate_anchor, scriptText),
      reference_anchor: bindUniqueExactAnchor(row?.reference_anchor, referenceText),
    })),
    reference_edge_verdicts: (Array.isArray(document?.reference_edge_verdicts)
      ? document.reference_edge_verdicts
      : []).map((row) => ({
      ...row,
      candidate_anchor: bindUniqueExactAnchor(row?.candidate_anchor, scriptText),
      reference_anchor: bindUniqueExactAnchor(row?.reference_anchor, referenceText),
    })),
    anchored_failures: (Array.isArray(document?.anchored_failures) ? document.anchored_failures : []).map((finding) => (
      bindUniqueExactAnchor(finding, scriptText)
    )),
  };
}

function validateDensityDimensionRows(rows, {
  candidateText = "",
  referenceText = "",
  requireVerdicts = false,
  prefix = "reference_density",
} = {}) {
  const blockers = [];
  const dimensions = Array.isArray(rows) ? rows : [];
  const ids = dimensions.map((row) => String(row?.id ?? "").trim());
  pushIf(blockers, dimensions.length !== REFERENCE_DENSITY_DIMENSION_IDS.length, `${prefix}_dimension_count_invalid`);
  pushIf(blockers, !unique(ids), `${prefix}_dimension_ids_duplicate`);
  for (const id of REFERENCE_DENSITY_DIMENSION_IDS) {
    pushIf(blockers, !ids.includes(id), `${prefix}_dimension_${id}_missing`);
  }
  for (const [index, row] of dimensions.entries()) {
    pushIf(blockers, !REFERENCE_DENSITY_DIMENSION_IDS.includes(row?.id), `${prefix}_dimension_${index}_id_invalid`);
    if (requireVerdicts) {
      pushIf(blockers, !["candidate_win", "tie", "reference_win"].includes(row?.decision), `${prefix}_dimension_${index}_decision_invalid`);
      for (const field of ["density_judgment", "candidate_advantage_or_gap"]) {
        pushIf(blockers, !nonEmpty(row?.[field]), `${prefix}_dimension_${index}_${field}_missing`);
      }
      validateExactAnchor(row?.candidate_anchor, candidateText, `${prefix}_dimension_${index}_candidate_anchor`, blockers);
    } else {
      for (const field of [
        "viewer_appetite", "reference_strength", "reference_weakness",
        "candidate_dominance_obligation", "non_copying_boundary",
      ]) pushIf(blockers, !nonEmpty(row?.[field]), `${prefix}_dimension_${index}_${field}_missing`);
    }
    validateExactAnchor(row?.reference_anchor, referenceText, `${prefix}_dimension_${index}_reference_anchor`, blockers);
  }
  return blockers;
}

function validateDensityEdgeVerdictRows(rows, expectedEdges, {
  candidateText = "",
  referenceText = "",
  prefix = "reference_density_edges",
} = {}) {
  const blockers = [];
  const verdicts = Array.isArray(rows) ? rows : [];
  const expected = Array.isArray(expectedEdges) ? expectedEdges : [];
  const expectedIds = expected.map((row) => row.edge_id);
  const verdictIds = verdicts.map((row) => String(row?.edge_id ?? "").trim());
  pushIf(blockers, verdicts.length !== expected.length, `${prefix}_count_invalid`);
  pushIf(blockers, !unique(verdictIds), `${prefix}_ids_duplicate`);
  for (const edgeId of expectedIds) pushIf(blockers, !verdictIds.includes(edgeId), `${prefix}_${edgeId}_missing`);
  for (const [index, row] of verdicts.entries()) {
    pushIf(blockers, !expectedIds.includes(row?.edge_id), `${prefix}_${index}_edge_id_invalid`);
    pushIf(blockers, !["candidate_win", "tie", "reference_win"].includes(row?.decision), `${prefix}_${index}_decision_invalid`);
    for (const field of ["density_judgment", "candidate_advantage_or_gap"]) {
      pushIf(blockers, !nonEmpty(row?.[field]), `${prefix}_${index}_${field}_missing`);
    }
    validateExactAnchor(row?.candidate_anchor, candidateText, `${prefix}_${index}_candidate_anchor`, blockers);
    validateExactAnchor(row?.reference_anchor, referenceText, `${prefix}_${index}_reference_anchor`, blockers);
  }
  return blockers;
}

export function validateReferenceMeritFrontier(document, {
  packageSha256 = null,
  referenceText = "",
  referenceSha256 = null,
  referencePath = null,
  referenceTitle = null,
  requireMaterialEdges = false,
} = {}) {
  const blockers = [];
  pushIf(blockers, document?.schema !== REFERENCE_MERIT_FRONTIER_SCHEMA, "reference_merit_frontier_schema_invalid");
  pushIf(blockers, document?.status !== "charted", "reference_merit_frontier_not_charted");
  pushIf(blockers, document?.normalization_policy !== REFERENCE_DENSITY_NORMALIZATION_POLICY, "reference_merit_frontier_normalization_policy_invalid");
  pushIf(blockers, !isSha256(document?.package_sha256), "reference_merit_frontier_package_hash_invalid");
  pushIf(blockers, !isSha256(document?.reference_sha256), "reference_merit_frontier_reference_hash_invalid");
  if (packageSha256) pushIf(blockers, document?.package_sha256 !== packageSha256, "reference_merit_frontier_package_hash_mismatch");
  if (referenceSha256) pushIf(blockers, document?.reference_sha256 !== referenceSha256, "reference_merit_frontier_reference_hash_mismatch");
  if (referencePath) pushIf(blockers, document?.reference_path !== referencePath, "reference_merit_frontier_reference_path_mismatch");
  if (referenceTitle) pushIf(blockers, document?.reference_title !== referenceTitle, "reference_merit_frontier_reference_title_mismatch");
  pushIf(blockers, !nonEmpty(document?.selected_package_title), "reference_merit_frontier_selected_package_title_missing");
  pushIf(blockers, !nonEmpty(document?.source_outlier_id), "reference_merit_frontier_source_outlier_id_missing");
  pushIf(blockers, Number(document?.reference_word_count) !== countWords(referenceText), "reference_merit_frontier_reference_word_count_mismatch");
  pushIf(blockers, !Array.isArray(document?.cross_dimension_priorities) || document.cross_dimension_priorities.length < 3, "reference_merit_frontier_cross_dimension_priorities_missing");
  blockers.push(...validateDensityDimensionRows(document?.dimensions, {
    referenceText,
    prefix: "reference_merit_frontier",
  }));
  const edges = Array.isArray(document?.material_reference_edges) ? document.material_reference_edges : [];
  const edgeIds = edges.map((row) => String(row?.edge_id ?? "").trim());
  if (requireMaterialEdges) {
    pushIf(blockers, edges.length < REFERENCE_DENSITY_DIMENSION_IDS.length, "reference_merit_frontier_material_edges_incomplete");
  }
  pushIf(blockers, !unique(edgeIds), "reference_merit_frontier_material_edge_ids_duplicate");
  for (const [index, edge] of edges.entries()) {
    pushIf(blockers, !nonEmpty(edge?.edge_id), `reference_merit_frontier_material_edge_${index}_id_missing`);
    pushIf(blockers, !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(String(edge?.edge_id ?? "")), `reference_merit_frontier_material_edge_${index}_id_invalid`);
    pushIf(blockers, !REFERENCE_DENSITY_DIMENSION_IDS.includes(edge?.dimension_id), `reference_merit_frontier_material_edge_${index}_dimension_invalid`);
    for (const field of ["viewer_appetite", "reference_advantage", "candidate_dominance_obligation", "non_copying_boundary"]) {
      pushIf(blockers, !nonEmpty(edge?.[field]), `reference_merit_frontier_material_edge_${index}_${field}_missing`);
    }
    validateExactAnchor(edge?.reference_anchor, referenceText, `reference_merit_frontier_material_edge_${index}_reference_anchor`, blockers);
  }
  return { done: blockers.length === 0, blockers };
}

export function validateReferenceDensityDominance(document, {
  scriptText = "",
  scriptSha256 = null,
  referenceText = "",
  referenceSha256 = null,
  frontierSha256 = null,
  referenceMeritFrontier = null,
} = {}) {
  const blockers = [];
  pushIf(blockers, document?.schema !== REFERENCE_DENSITY_DOMINANCE_SCHEMA, "reference_density_dominance_schema_invalid");
  pushIf(blockers, !["passed", "findings"].includes(document?.status), "reference_density_dominance_status_invalid");
  pushIf(blockers, document?.normalization_policy !== REFERENCE_DENSITY_NORMALIZATION_POLICY, "reference_density_dominance_normalization_policy_invalid");
  if (scriptSha256) pushIf(blockers, document?.script_sha256 !== scriptSha256, "reference_density_dominance_script_hash_mismatch");
  if (referenceSha256) pushIf(blockers, document?.reference_sha256 !== referenceSha256, "reference_density_dominance_reference_hash_mismatch");
  if (frontierSha256) pushIf(blockers, document?.frontier_sha256 !== frontierSha256, "reference_density_dominance_frontier_hash_mismatch");
  blockers.push(...validateDensityDimensionRows(document?.dimensions, {
    candidateText: scriptText,
    referenceText,
    requireVerdicts: true,
    prefix: "reference_density_dominance",
  }));
  const dimensions = Array.isArray(document?.dimensions) ? document.dimensions : [];
  const nonWins = dimensions.filter((row) => row?.decision !== "candidate_win");
  const expectedEdges = referenceMeritFrontier?.material_reference_edges ?? [];
  if (referenceMeritFrontier) {
    blockers.push(...validateDensityEdgeVerdictRows(document?.edge_verdicts, expectedEdges, {
      candidateText: scriptText,
      referenceText,
      prefix: "reference_density_dominance_edges",
    }));
  }
  const edgeNonWins = (Array.isArray(document?.edge_verdicts) ? document.edge_verdicts : [])
    .filter((row) => row?.decision !== "candidate_win");
  const { accepted, discarded } = validateAnchoredFindings(document?.findings, scriptText);
  pushIf(blockers, discarded.length > 0, `reference_density_dominance_invalid_anchors_${discarded.length}`);
  const findingIds = accepted.map((finding) => String(finding?.id ?? "").trim());
  pushIf(blockers, !unique(findingIds), "reference_density_dominance_finding_ids_duplicate");
  for (const [index, finding] of accepted.entries()) {
    pushIf(blockers, !nonEmpty(finding?.id), `reference_density_dominance_finding_${index}_id_missing`);
    pushIf(blockers, !REFERENCE_DENSITY_DIMENSION_IDS.includes(finding?.dimension_id), `reference_density_dominance_finding_${index}_dimension_invalid`);
    if (finding?.edge_id != null) {
      pushIf(blockers, !expectedEdges.some((edge) => edge.edge_id === finding.edge_id), `reference_density_dominance_finding_${index}_edge_invalid`);
    }
    pushIf(blockers, !["material", "critical"].includes(finding?.severity), `reference_density_dominance_finding_${index}_severity_invalid`);
    for (const field of ["defect", "audience_effect", "smallest_repair_intent"]) {
      pushIf(blockers, !nonEmpty(finding?.[field]), `reference_density_dominance_finding_${index}_${field}_missing`);
    }
  }
  const findingDimensions = new Set(accepted.map((finding) => finding?.dimension_id));
  for (const row of nonWins) pushIf(blockers, !findingDimensions.has(row?.id), `reference_density_dominance_dimension_${row?.id}_finding_missing`);
  const findingEdges = new Set(accepted.map((finding) => finding?.edge_id).filter(Boolean));
  for (const row of edgeNonWins) pushIf(blockers, !findingEdges.has(row?.edge_id), `reference_density_dominance_edge_${row?.edge_id}_finding_missing`);
  pushIf(blockers, document?.status === "passed" && (nonWins.length > 0 || edgeNonWins.length > 0 || accepted.length > 0), "reference_density_dominance_passed_with_findings");
  pushIf(blockers, document?.status === "findings" && (nonWins.length + edgeNonWins.length < 1 || accepted.length < 1), "reference_density_dominance_findings_empty");
  return { done: blockers.length === 0, blockers, accepted_findings: accepted, discarded_findings: discarded };
}

export function hasDramaticColdOpenContract(architecture) {
  return architecture?.opening_semantic_contract?.version === DRAMATIC_COLD_OPEN_VERSION;
}

export function sha256CanonicalJson(value) {
  return sha256(JSON.stringify(canonicalJson(value)));
}

export function validateSourceEvidenceRegistry(document) {
  const blockers = [];
  pushIf(blockers, document?.schema !== SOURCE_EVIDENCE_REGISTRY_SCHEMA, "source_evidence_registry_schema_invalid");
  pushIf(blockers, document?.status !== "compiled", "source_evidence_registry_not_compiled");
  pushIf(blockers, !nonEmpty(document?.channel), "source_evidence_registry_channel_missing");
  pushIf(blockers, !nonEmpty(document?.as_of_date), "source_evidence_registry_as_of_date_missing");
  const claims = Array.isArray(document?.claims) ? document.claims : [];
  pushIf(blockers, claims.length < 1, "source_evidence_registry_claims_missing");
  const claimIds = claims.map((claim) => String(claim?.claim_id ?? "").trim());
  pushIf(blockers, !unique(claimIds), "source_evidence_registry_claim_ids_duplicate");
  for (const [index, claim] of claims.entries()) {
    for (const field of ["claim_id", "claim", "sample_scope", "limitation", "confidence_language", "production_use"] ) {
      pushIf(blockers, !nonEmpty(claim?.[field]), `source_evidence_registry_claim_${index}_${field}_missing`);
    }
    pushIf(blockers, !["observation", "interpretation"].includes(claim?.claim_type), `source_evidence_registry_claim_${index}_type_invalid`);
    const sources = Array.isArray(claim?.sources) ? claim.sources : [];
    pushIf(blockers, sources.length < 1, `source_evidence_registry_claim_${index}_sources_missing`);
    for (const [sourceIndex, source] of sources.entries()) {
      pushIf(blockers, !nonEmpty(source?.source_id), `source_evidence_registry_claim_${index}_source_${sourceIndex}_id_missing`);
      pushIf(blockers, !nonEmpty(source?.reference), `source_evidence_registry_claim_${index}_source_${sourceIndex}_reference_missing`);
    }
    pushIf(blockers, !Array.isArray(claim?.counterevidence), `source_evidence_registry_claim_${index}_counterevidence_missing`);
  }
  return { done: blockers.length === 0, blockers };
}

export function validatePackageOutlierLedger(document) {
  const blockers = [];
  pushIf(blockers, document?.schema !== PACKAGE_OUTLIER_LEDGER_SCHEMA, "package_outlier_ledger_schema_invalid");
  pushIf(blockers, document?.status !== "compiled", "package_outlier_ledger_not_compiled");
  pushIf(blockers, !nonEmpty(document?.channel), "package_outlier_ledger_channel_missing");
  pushIf(blockers, !nonEmpty(document?.as_of_date), "package_outlier_ledger_as_of_date_missing");
  const entries = Array.isArray(document?.entries) ? document.entries : [];
  pushIf(blockers, entries.length < 10, "package_outlier_ledger_entries_below_10");
  const entryIds = entries.map((entry) => String(entry?.entry_id ?? "").trim());
  pushIf(blockers, !unique(entryIds), "package_outlier_ledger_entry_ids_duplicate");
  for (const [index, entry] of entries.entries()) {
    for (const field of ["entry_id", "title", "source_type", "performance_signal", "source_reference"]) {
      pushIf(blockers, !nonEmpty(entry?.[field]), `package_outlier_ledger_entry_${index}_${field}_missing`);
    }
    pushIf(
      blockers,
      !["public_niche_outlier", "own_channel"].includes(entry?.source_type),
      `package_outlier_ledger_entry_${index}_source_type_invalid`,
    );
  }
  return { done: blockers.length === 0, blockers };
}

export function validatePremiseSlateV2(document, {
  evidenceRegistry = null,
  evidenceRegistrySha256 = null,
  packageOutlierLedger = null,
} = {}) {
  const blockers = [];
  pushIf(blockers, document?.schema !== PREMISE_SLATE_V2_SCHEMA, "premise_slate_v2_schema_invalid");
  pushIf(blockers, document?.status !== "planned", "premise_slate_v2_not_planned");
  pushIf(blockers, !nonEmpty(document?.channel), "premise_slate_v2_channel_missing");
  pushIf(blockers, !nonEmpty(document?.development_slug), "premise_slate_v2_development_slug_missing");
  if (evidenceRegistrySha256) {
    pushIf(blockers, document?.evidence_registry_sha256 !== evidenceRegistrySha256, "premise_slate_v2_evidence_hash_mismatch");
  }
  const claimIds = new Set((evidenceRegistry?.claims ?? []).map((claim) => claim.claim_id));
  const outlierEntries = new Map((packageOutlierLedger?.entries ?? []).map((entry) => [entry.entry_id, entry]));
  const candidates = Array.isArray(document?.candidates) ? document.candidates : [];
  pushIf(blockers, candidates.length !== 6, `premise_slate_v2_candidate_count_${candidates.length}_not_6`);
  const candidateIds = candidates.map((candidate) => String(candidate?.id ?? "").trim());
  const slots = candidates.map((candidate) => String(candidate?.slot ?? "").trim());
  pushIf(blockers, !unique(candidateIds), "premise_slate_v2_candidate_ids_duplicate");
  pushIf(blockers, !unique(slots), "premise_slate_v2_slots_duplicate");
  for (const slot of PREMISE_SLOT_IDS) pushIf(blockers, !slots.includes(slot), `premise_slate_v2_slot_${slot}_missing`);
  for (const [index, candidate] of candidates.entries()) {
    for (const field of [
      "id", "slot", "title", "thumbnail_receipt", "contradiction", "human_desire",
      "first_owned_choice", "durable_engine", "continuation_cost", "primary_falsification_risk",
    ]) pushIf(blockers, !nonEmpty(candidate?.[field]), `premise_slate_v2_candidate_${index}_${field}_missing`);
    for (const field of ["positive_analogue", "failure_analogue", "click_judgment", "runway_judgment", "anti_reskin"]) {
      pushIf(blockers, !candidate?.[field] || typeof candidate[field] !== "object", `premise_slate_v2_candidate_${index}_${field}_missing`);
    }
    if (outlierEntries.size) {
      const mirror = candidate?.outlier_mirror;
      pushIf(blockers, !mirror || typeof mirror !== "object", `premise_slate_v2_candidate_${index}_outlier_mirror_missing`);
      for (const field of [
        "source_id", "source_title", "proven_package_movie", "retained_dna", "single_twist",
        "why_twist_beats_or_strengthens_source", "first_read_movie", "desirable_reversal",
      ]) {
        pushIf(blockers, !nonEmpty(mirror?.[field]), `premise_slate_v2_candidate_${index}_outlier_mirror_${field}_missing`);
      }
      const source = outlierEntries.get(mirror?.source_id);
      pushIf(blockers, !source, `premise_slate_v2_candidate_${index}_outlier_source_unknown`);
      if (source) {
        pushIf(blockers, mirror?.source_title !== source.title, `premise_slate_v2_candidate_${index}_outlier_title_mismatch`);
      }
    }
    pushIf(blockers, !["strong", "plausible", "weak"].includes(candidate?.click_judgment?.decision), `premise_slate_v2_candidate_${index}_click_judgment_invalid`);
    pushIf(blockers, !nonEmpty(candidate?.click_judgment?.rationale), `premise_slate_v2_candidate_${index}_click_rationale_missing`);
    pushIf(blockers, !["strong", "plausible", "weak"].includes(candidate?.runway_judgment?.decision), `premise_slate_v2_candidate_${index}_runway_judgment_invalid`);
    pushIf(blockers, !nonEmpty(candidate?.runway_judgment?.rationale), `premise_slate_v2_candidate_${index}_runway_rationale_missing`);
    pushIf(blockers, !["pass", "reject"].includes(candidate?.anti_reskin?.decision), `premise_slate_v2_candidate_${index}_anti_reskin_decision_invalid`);
    for (const field of ["abstraction", "nearest_candidate_or_recent_script", "material_difference"]) {
      pushIf(blockers, !nonEmpty(candidate?.anti_reskin?.[field]), `premise_slate_v2_candidate_${index}_anti_reskin_${field}_missing`);
    }
    if (claimIds.size) {
      pushIf(blockers, !claimIds.has(candidate?.positive_analogue?.claim_id), `premise_slate_v2_candidate_${index}_positive_claim_unknown`);
      pushIf(blockers, !claimIds.has(candidate?.failure_analogue?.claim_id), `premise_slate_v2_candidate_${index}_failure_claim_unknown`);
    }
  }
  return { done: blockers.length === 0, blockers };
}

export function validatePremiseSelectionV2(document, {
  premiseSlate = null,
  premiseSlateSha256 = null,
  evidenceRegistry = null,
  evidenceRegistrySha256 = null,
} = {}) {
  const blockers = [];
  pushIf(blockers, document?.schema !== PREMISE_SELECTION_V2_SCHEMA, "premise_selection_v2_schema_invalid");
  pushIf(blockers, !["selected", "rejected"].includes(document?.status), "premise_selection_v2_status_invalid");
  pushIf(blockers, !isSha256(document?.premise_slate_sha256), "premise_selection_v2_slate_hash_invalid");
  pushIf(blockers, !isSha256(document?.evidence_registry_sha256), "premise_selection_v2_evidence_hash_invalid");
  pushIf(blockers, !isSha256(premiseSlateSha256), "premise_selection_v2_expected_slate_hash_missing");
  pushIf(blockers, !isSha256(evidenceRegistrySha256), "premise_selection_v2_expected_evidence_hash_missing");
  if (premiseSlateSha256) {
    pushIf(blockers, document?.premise_slate_sha256 !== premiseSlateSha256, "premise_selection_v2_slate_hash_mismatch");
  }
  if (evidenceRegistrySha256) {
    pushIf(blockers, document?.evidence_registry_sha256 !== evidenceRegistrySha256, "premise_selection_v2_evidence_hash_mismatch");
  }

  const candidateIds = new Set((premiseSlate?.candidates ?? []).map((candidate) => candidate?.id).filter(nonEmpty));
  const claimIds = new Set((evidenceRegistry?.claims ?? []).map((claim) => claim?.claim_id).filter(nonEmpty));
  pushIf(blockers, candidateIds.size < 1, "premise_selection_v2_candidates_missing");
  pushIf(blockers, claimIds.size < 1, "premise_selection_v2_claims_missing");
  if (document?.status === "selected") {
    pushIf(blockers, !candidateIds.has(document?.selected_candidate_id), "premise_selection_v2_selected_candidate_unknown");
    pushIf(blockers, document?.rejection_reason !== null, "premise_selection_v2_selected_rejection_reason_must_be_null");
  } else {
    pushIf(blockers, document?.selected_candidate_id !== null, "premise_selection_v2_rejected_candidate_must_be_null");
    pushIf(blockers, !nonEmpty(document?.rejection_reason), "premise_selection_v2_rejection_reason_missing");
  }
  pushIf(blockers, !nonEmpty(document?.selection_rationale), "premise_selection_v2_rationale_missing");

  const findings = Array.isArray(document?.comparative_findings) ? document.comparative_findings : [];
  pushIf(blockers, findings.length < 1, "premise_selection_v2_findings_missing");
  const comparedCandidateIds = new Set();
  for (const [index, finding] of findings.entries()) {
    const candidateId = finding?.candidate_id;
    const findingClaimIds = Array.isArray(finding?.claim_ids) ? finding.claim_ids : [];
    pushIf(blockers, !candidateIds.has(candidateId), `premise_selection_v2_finding_${index}_candidate_unknown`);
    if (candidateIds.has(candidateId)) comparedCandidateIds.add(candidateId);
    pushIf(blockers, findingClaimIds.length < 1, `premise_selection_v2_finding_${index}_claims_missing`);
    pushIf(blockers, !unique(findingClaimIds), `premise_selection_v2_finding_${index}_claims_duplicate`);
    for (const claimId of findingClaimIds) {
      pushIf(blockers, !claimIds.has(claimId), `premise_selection_v2_finding_${index}_claim_${claimId}_unknown`);
    }
    for (const field of ["click_judgment", "runway_judgment", "decisive_reason"]) {
      pushIf(blockers, !nonEmpty(finding?.[field]), `premise_selection_v2_finding_${index}_${field}_missing`);
    }
  }
  if (document?.status === "selected") {
    pushIf(
      blockers,
      !comparedCandidateIds.has(document?.selected_candidate_id),
      "premise_selection_v2_selected_candidate_not_compared",
    );
  }
  return { done: blockers.length === 0, blockers };
}

function eligiblePackageCandidateIds(premiseSlate) {
  return (premiseSlate?.candidates ?? [])
    .filter((candidate) => candidate?.click_judgment?.decision === "strong"
      && candidate?.runway_judgment?.decision === "strong")
    .map((candidate) => candidate.id);
}

export function validatePackageTournament(document, {
  premiseSlate = null,
  premiseSlateSha256 = null,
} = {}) {
  const blockers = [];
  pushIf(blockers, document?.schema !== PACKAGE_TOURNAMENT_SCHEMA, "package_tournament_schema_invalid");
  pushIf(blockers, !nonEmpty(document?.provider_role), "package_tournament_provider_role_missing");
  pushIf(blockers, !isSha256(document?.premise_slate_sha256), "package_tournament_slate_hash_invalid");
  if (premiseSlateSha256) {
    pushIf(blockers, document?.premise_slate_sha256 !== premiseSlateSha256, "package_tournament_slate_hash_mismatch");
  }

  const expectedIds = eligiblePackageCandidateIds(premiseSlate);
  const suppliedIds = Array.isArray(document?.eligible_candidate_ids) ? document.eligible_candidate_ids : [];
  pushIf(blockers, expectedIds.length < 1, "package_tournament_no_eligible_candidates");
  pushIf(blockers, !unique(suppliedIds), "package_tournament_eligible_ids_duplicate");
  pushIf(
    blockers,
    JSON.stringify([...suppliedIds].sort()) !== JSON.stringify([...expectedIds].sort()),
    "package_tournament_eligible_ids_mismatch",
  );
  pushIf(
    blockers,
    document?.selected_candidate_id !== null && !expectedIds.includes(document?.selected_candidate_id),
    "package_tournament_selected_candidate_ineligible",
  );
  for (const field of ["selection_rationale", "click_confidence", "runway_screen"]) {
    pushIf(blockers, !nonEmpty(document?.[field]), `package_tournament_${field}_missing`);
  }
  pushIf(blockers, !["strong", "plausible", "weak"].includes(document?.click_confidence), "package_tournament_click_confidence_invalid");
  pushIf(blockers, !["strong", "plausible", "weak"].includes(document?.runway_screen), "package_tournament_runway_screen_invalid");
  if (document?.selected_candidate_id === null) {
    pushIf(blockers, !nonEmpty(document?.rejection_reason), "package_tournament_rejection_reason_missing");
  } else {
    pushIf(blockers, document?.rejection_reason !== null, "package_tournament_selected_rejection_reason_must_be_null");
  }

  const findings = Array.isArray(document?.comparative_findings) ? document.comparative_findings : [];
  const findingIds = findings.map((finding) => finding?.candidate_id);
  pushIf(blockers, !unique(findingIds), "package_tournament_finding_ids_duplicate");
  pushIf(
    blockers,
    JSON.stringify([...findingIds].sort()) !== JSON.stringify([...expectedIds].sort()),
    "package_tournament_findings_incomplete",
  );
  for (const [index, finding] of findings.entries()) {
    for (const field of [
      "candidate_id", "click_movie", "thumbnail_receipt", "proven_demand_transfer",
      "twist_value", "reskin_risk", "runway_veto", "decisive_reason",
    ]) pushIf(blockers, !nonEmpty(finding?.[field]), `package_tournament_finding_${index}_${field}_missing`);
    pushIf(blockers, !["pass", "fail"].includes(finding?.runway_veto), `package_tournament_finding_${index}_runway_veto_invalid`);
  }
  return { done: blockers.length === 0, blockers };
}

export function validatePackageTournamentConsensus(document, {
  premiseSlateSha256 = null,
  gptTournament = null,
  gptTournamentSha256 = null,
  geminiTournament = null,
  geminiTournamentSha256 = null,
} = {}) {
  const blockers = [];
  pushIf(blockers, document?.schema !== PACKAGE_TOURNAMENT_CONSENSUS_SCHEMA, "package_tournament_consensus_schema_invalid");
  pushIf(blockers, !["consensus", "disagreement"].includes(document?.status), "package_tournament_consensus_status_invalid");
  for (const field of ["premise_slate_sha256", "gpt_tournament_sha256", "gemini_tournament_sha256"]) {
    pushIf(blockers, !isSha256(document?.[field]), `package_tournament_consensus_${field}_invalid`);
  }
  if (premiseSlateSha256) pushIf(blockers, document?.premise_slate_sha256 !== premiseSlateSha256, "package_tournament_consensus_slate_hash_mismatch");
  if (gptTournamentSha256) pushIf(blockers, document?.gpt_tournament_sha256 !== gptTournamentSha256, "package_tournament_consensus_gpt_hash_mismatch");
  if (geminiTournamentSha256) pushIf(blockers, document?.gemini_tournament_sha256 !== geminiTournamentSha256, "package_tournament_consensus_gemini_hash_mismatch");
  pushIf(blockers, !nonEmpty(document?.created_at) || Number.isNaN(Date.parse(document?.created_at)), "package_tournament_consensus_created_at_invalid");

  const agreedId = gptTournament?.selected_candidate_id
    && gptTournament.selected_candidate_id === geminiTournament?.selected_candidate_id
    ? gptTournament.selected_candidate_id
    : null;
  const strongAgreement = Boolean(agreedId)
    && gptTournament?.click_confidence === "strong"
    && geminiTournament?.click_confidence === "strong"
    && gptTournament?.runway_screen === "strong"
    && geminiTournament?.runway_screen === "strong";
  const expectedStatus = strongAgreement ? "consensus" : "disagreement";
  pushIf(blockers, document?.status !== expectedStatus, "package_tournament_consensus_status_not_truthful");
  pushIf(blockers, document?.selected_candidate_id !== (strongAgreement ? agreedId : null), "package_tournament_consensus_selected_id_mismatch");
  pushIf(blockers, document?.consensus_click_confidence !== (strongAgreement ? "strong" : null), "package_tournament_consensus_click_mismatch");
  pushIf(blockers, document?.consensus_runway_screen !== (strongAgreement ? "strong" : null), "package_tournament_consensus_runway_mismatch");
  return { done: blockers.length === 0, blockers };
}

export function validatePackageAdjudication(document, {
  premiseSlate = null,
  premiseSlateSha256 = null,
  tournamentConsensus = null,
  tournamentConsensusSha256 = null,
  gptTournamentSha256 = null,
  geminiTournamentSha256 = null,
} = {}) {
  const blockers = [];
  pushIf(blockers, document?.schema !== PACKAGE_ADJUDICATION_SCHEMA, "package_adjudication_schema_invalid");
  pushIf(blockers, document?.status !== "adjudicated", "package_adjudication_status_invalid");
  for (const field of [
    "premise_slate_sha256", "tournament_consensus_sha256",
    "gpt_tournament_sha256", "gemini_tournament_sha256",
  ]) pushIf(blockers, !isSha256(document?.[field]), `package_adjudication_${field}_invalid`);
  if (premiseSlateSha256) pushIf(blockers, document?.premise_slate_sha256 !== premiseSlateSha256, "package_adjudication_slate_hash_mismatch");
  if (tournamentConsensusSha256) pushIf(blockers, document?.tournament_consensus_sha256 !== tournamentConsensusSha256, "package_adjudication_consensus_hash_mismatch");
  if (gptTournamentSha256) pushIf(blockers, document?.gpt_tournament_sha256 !== gptTournamentSha256, "package_adjudication_gpt_hash_mismatch");
  if (geminiTournamentSha256) pushIf(blockers, document?.gemini_tournament_sha256 !== geminiTournamentSha256, "package_adjudication_gemini_hash_mismatch");
  pushIf(blockers, tournamentConsensus?.status !== "disagreement", "package_adjudication_requires_disagreement");
  const eligibleIds = eligiblePackageCandidateIds(premiseSlate);
  pushIf(blockers, !eligibleIds.includes(document?.selected_candidate_id), "package_adjudication_selected_candidate_ineligible");
  pushIf(blockers, !nonEmpty(document?.adjudicated_by), "package_adjudication_operator_missing");
  pushIf(blockers, !nonEmpty(document?.rationale), "package_adjudication_rationale_missing");
  pushIf(
    blockers,
    !nonEmpty(document?.adjudicated_at) || Number.isNaN(Date.parse(document?.adjudicated_at)),
    "package_adjudication_timestamp_invalid",
  );
  return { done: blockers.length === 0, blockers };
}

export function validateSourceStageApproval(document, {
  stageId = null,
  sourceSha256 = null,
  selectedId = undefined,
} = {}) {
  const blockers = [];
  pushIf(blockers, document?.schema !== SOURCE_STAGE_APPROVAL_SCHEMA, "source_stage_approval_schema_invalid");
  pushIf(blockers, !SOURCE_STAGE_APPROVAL_STAGE_IDS.includes(document?.stage_id), "source_stage_approval_stage_id_invalid");
  pushIf(blockers, !isSha256(document?.source_sha256), "source_stage_approval_source_hash_invalid");
  pushIf(blockers, document?.approved !== true, "source_stage_approval_not_approved");
  pushIf(blockers, !nonEmpty(document?.approved_by), "source_stage_approval_approved_by_missing");
  pushIf(
    blockers,
    !nonEmpty(document?.approved_at) || Number.isNaN(Date.parse(document.approved_at)),
    "source_stage_approval_approved_at_invalid",
  );
  if (stageId) pushIf(blockers, document?.stage_id !== stageId, "source_stage_approval_stage_id_mismatch");
  if (sourceSha256) pushIf(blockers, document?.source_sha256 !== sourceSha256, "source_stage_approval_source_hash_mismatch");
  if (document?.selected_id !== undefined && document?.selected_id !== null) {
    pushIf(blockers, !nonEmpty(document.selected_id), "source_stage_approval_selected_id_invalid");
  }
  if (selectedId !== undefined) {
    pushIf(blockers, document?.selected_id !== selectedId, "source_stage_approval_selected_id_mismatch");
  }
  return { done: blockers.length === 0, blockers };
}

export function validateTreatmentBakeoff(document, { packageSha256 = null } = {}) {
  const blockers = [];
  pushIf(blockers, document?.schema !== TREATMENT_BAKEOFF_SCHEMA, "treatment_bakeoff_schema_invalid");
  pushIf(blockers, document?.status !== "planned", "treatment_bakeoff_not_planned");
  if (packageSha256) pushIf(blockers, document?.package_sha256 !== packageSha256, "treatment_bakeoff_package_hash_mismatch");
  const treatments = Array.isArray(document?.treatments) ? document.treatments : [];
  pushIf(blockers, treatments.length !== 3, `treatment_bakeoff_count_${treatments.length}_not_3`);
  const ids = treatments.map((treatment) => String(treatment?.id ?? "").trim());
  const engines = treatments.map((treatment) => String(treatment?.engine ?? "").trim());
  pushIf(blockers, !unique(ids), "treatment_bakeoff_ids_duplicate");
  pushIf(blockers, !unique(engines), "treatment_bakeoff_engines_duplicate");
  for (const engine of TREATMENT_ENGINE_IDS) pushIf(blockers, !engines.includes(engine), `treatment_bakeoff_engine_${engine}_missing`);
  for (const [index, treatment] of treatments.entries()) {
    for (const field of [
      "id", "engine", "treatment", "central_relationship", "opposition_learning_pattern",
      "midpoint_reclassification", "climax_causality", "closure_contract", "primary_failure_risk",
    ]) pushIf(blockers, !nonEmpty(treatment?.[field]), `treatment_bakeoff_${index}_${field}_missing`);
    const wordCount = String(treatment?.treatment ?? "").trim().split(/\s+/).filter(Boolean).length;
    pushIf(blockers, wordCount < 800 || wordCount > 1_200, `treatment_bakeoff_${index}_word_count_${wordCount}_outside_800_1200`);
  }
  return { done: blockers.length === 0, blockers };
}

export function validateTreatmentSelection(document, {
  packageSha256 = null,
  treatmentBatch = null,
  treatmentBatchSha256 = null,
} = {}) {
  const blockers = [];
  pushIf(blockers, document?.schema !== TREATMENT_SELECTION_SCHEMA, "treatment_selection_schema_invalid");
  pushIf(blockers, !["selected", "rejected"].includes(document?.status), "treatment_selection_status_invalid");
  if (packageSha256) pushIf(blockers, document?.package_sha256 !== packageSha256, "treatment_selection_package_hash_mismatch");
  if (treatmentBatchSha256) pushIf(blockers, document?.treatment_batch_sha256 !== treatmentBatchSha256, "treatment_selection_batch_hash_mismatch");
  const treatments = treatmentBatch?.treatments ?? [];
  const treatmentById = new Map(treatments.map((treatment) => [treatment.id, treatment]));
  if (document?.status === "selected") {
    pushIf(blockers, !treatmentById.has(document?.selected_treatment_id), "treatment_selection_selected_id_unknown");
  } else {
    pushIf(blockers, document?.selected_treatment_id !== null, "treatment_selection_rejected_id_must_be_null");
    pushIf(blockers, !nonEmpty(document?.rejection_reason), "treatment_selection_rejection_reason_missing");
  }
  pushIf(blockers, !nonEmpty(document?.decision_rationale), "treatment_selection_rationale_missing");
  const findings = Array.isArray(document?.comparative_findings) ? document.comparative_findings : [];
  pushIf(blockers, findings.length < 1, "treatment_selection_findings_missing");
  for (const [index, finding] of findings.entries()) {
    const source = treatmentById.get(finding?.treatment_id);
    pushIf(blockers, !source, `treatment_selection_finding_${index}_treatment_unknown`);
    pushIf(blockers, !nonEmpty(finding?.dimension), `treatment_selection_finding_${index}_dimension_missing`);
    pushIf(blockers, !nonEmpty(finding?.judgment), `treatment_selection_finding_${index}_judgment_missing`);
    pushIf(blockers, !nonEmpty(finding?.exact_anchor), `treatment_selection_finding_${index}_anchor_missing`);
    if (source && nonEmpty(finding?.exact_anchor)) {
      pushIf(blockers, !String(source.treatment).includes(String(finding.exact_anchor)), `treatment_selection_finding_${index}_anchor_not_found`);
    }
  }
  return { done: blockers.length === 0, blockers };
}

export function validateStoryArchitecture(document, {
  packageSha256 = null,
  selectedTreatmentSha256 = null,
  treatmentBatchSha256 = null,
  treatmentSelectionSha256 = null,
  requireDramaticOpeningContract = false,
  requireCharacterNamePlan = false,
  nameFamiliarityLedgerSha256 = null,
  requireMeritDominanceContract = false,
  referenceMeritFrontierSha256 = null,
  referenceMeritFrontier = null,
} = {}) {
  const blockers = [];
  pushIf(blockers, document?.schema !== STORY_ARCHITECTURE_SCHEMA, "story_architecture_schema_invalid");
  pushIf(blockers, document?.status !== "planned", "story_architecture_not_planned");
  if (packageSha256) pushIf(blockers, document?.package_sha256 !== packageSha256, "story_architecture_package_hash_mismatch");
  if (selectedTreatmentSha256) pushIf(blockers, document?.selected_treatment_sha256 !== selectedTreatmentSha256, "story_architecture_treatment_hash_mismatch");
  if (nameFamiliarityLedgerSha256) pushIf(blockers, document?.name_familiarity_ledger_sha256 !== nameFamiliarityLedgerSha256, "story_architecture_name_familiarity_hash_mismatch");
  if (referenceMeritFrontierSha256) {
    pushIf(blockers, document?.reference_merit_frontier_sha256 !== referenceMeritFrontierSha256, "story_architecture_reference_frontier_hash_mismatch");
  }
  if (treatmentBatchSha256) {
    pushIf(
      blockers,
      document?.selected_treatment_contract?.treatment_source_sha256 !== treatmentBatchSha256,
      "story_architecture_treatment_source_hash_mismatch",
    );
  }
  if (treatmentSelectionSha256) {
    pushIf(
      blockers,
      document?.selected_treatment_contract?.selection_source_sha256 !== treatmentSelectionSha256,
      "story_architecture_selection_source_hash_mismatch",
    );
  }
  for (const field of [
    "opening_semantic_contract", "protagonist_contract", "mechanic_and_world_constraints",
    "relationship_ladder", "opposition_ladder", "learning_ledger", "continuity_ledger",
    "climax_proof_obligations", "closure_contract",
  ]) pushIf(blockers, !document?.[field] || typeof document[field] !== "object", `story_architecture_${field}_missing`);
  const opening = document?.opening_semantic_contract ?? {};
  if (requireDramaticOpeningContract || hasDramaticColdOpenContract(document)) {
    pushIf(blockers, opening?.version !== DRAMATIC_COLD_OPEN_VERSION, "story_architecture_dramatic_cold_open_version_missing");
    for (const field of [
      "first_sentence_event",
      "cold_open_loop",
      "by_approximately_30_seconds",
      "by_approximately_60_seconds",
      "by_approximately_90_seconds",
      "by_approximately_3_minutes",
      "by_approximately_5_minutes",
      "exposition_release_point",
    ]) pushIf(blockers, !opening?.[field] || typeof opening[field] !== "object", `story_architecture_opening_${field}_missing`);
    const loop = opening?.cold_open_loop ?? {};
    for (const field of ["visible_wound", "active_pressure", "owned_choice", "counteraction", "observable_result", "next_question"]) {
      pushIf(blockers, !nonEmpty(loop?.[field]), `story_architecture_opening_loop_${field}_missing`);
    }
  }
  const target = document?.target_word_range ?? {};
  pushIf(blockers, !Number.isInteger(Number(target.minimum)) || Number(target.minimum) < 8_000, "story_architecture_word_minimum_invalid");
  pushIf(blockers, !Number.isInteger(Number(target.maximum)) || Number(target.maximum) > 12_000 || Number(target.maximum) < Number(target.minimum), "story_architecture_word_maximum_invalid");
  const movements = Array.isArray(document?.movements) ? document.movements : [];
  pushIf(blockers, movements.length < 10 || movements.length > 14, `story_architecture_movement_count_${movements.length}_outside_10_14`);
  const ids = movements.map((movement) => String(movement?.id ?? "").trim());
  pushIf(blockers, !unique(ids), "story_architecture_movement_ids_duplicate");
  for (const [index, movement] of movements.entries()) {
    for (const field of [
      "id", "entering_state", "protagonist_choice", "consequence_and_changed_state",
      "relationship_opposition_or_learning_change", "promise_or_viewer_question_movement",
    ]) pushIf(blockers, !nonEmpty(movement?.[field]), `story_architecture_movement_${index}_${field}_missing`);
    pushIf(blockers, !Array.isArray(movement?.continuity_constraints), `story_architecture_movement_${index}_continuity_constraints_missing`);
  }
  if (requireMeritDominanceContract || referenceMeritFrontierSha256) {
    const contract = document?.merit_dominance_contract;
    pushIf(blockers, !contract || typeof contract !== "object" || Array.isArray(contract), "story_architecture_merit_dominance_contract_missing");
    pushIf(blockers, contract?.normalization_policy !== REFERENCE_DENSITY_NORMALIZATION_POLICY, "story_architecture_merit_normalization_policy_invalid");
    const obligations = Array.isArray(contract?.dimension_obligations) ? contract.dimension_obligations : [];
    const obligationIds = obligations.map((row) => String(row?.id ?? "").trim());
    pushIf(blockers, obligations.length !== REFERENCE_DENSITY_DIMENSION_IDS.length, "story_architecture_merit_obligation_count_invalid");
    pushIf(blockers, !unique(obligationIds), "story_architecture_merit_obligation_ids_duplicate");
    for (const id of REFERENCE_DENSITY_DIMENSION_IDS) {
      pushIf(blockers, !obligationIds.includes(id), `story_architecture_merit_obligation_${id}_missing`);
    }
    for (const [index, obligation] of obligations.entries()) {
      for (const field of ["candidate_strategy", "proof_shape"]) {
        pushIf(blockers, !nonEmpty(obligation?.[field]), `story_architecture_merit_obligation_${index}_${field}_missing`);
      }
      const movementIds = Array.isArray(obligation?.movement_ids) ? obligation.movement_ids : [];
      pushIf(blockers, movementIds.length < 1, `story_architecture_merit_obligation_${index}_movement_ids_missing`);
      for (const movementId of movementIds) {
        pushIf(blockers, !ids.includes(movementId), `story_architecture_merit_obligation_${index}_movement_${movementId}_unknown`);
      }
    }
    if (referenceMeritFrontier) {
      const expectedEdgeIds = (referenceMeritFrontier.material_reference_edges ?? []).map((row) => row.edge_id);
      const edgeObligations = Array.isArray(contract?.edge_obligations) ? contract.edge_obligations : [];
      const edgeObligationIds = edgeObligations.map((row) => String(row?.edge_id ?? "").trim());
      pushIf(blockers, !unique(edgeObligationIds), "story_architecture_merit_edge_obligation_ids_duplicate");
      for (const edgeId of expectedEdgeIds) {
        pushIf(blockers, !edgeObligationIds.includes(edgeId), `story_architecture_merit_edge_obligation_${edgeId}_missing`);
      }
      for (const [index, obligation] of edgeObligations.entries()) {
        pushIf(blockers, !expectedEdgeIds.includes(obligation?.edge_id), `story_architecture_merit_edge_obligation_${index}_unknown`);
        for (const field of ["candidate_strategy", "proof_shape"]) {
          pushIf(blockers, !nonEmpty(obligation?.[field]), `story_architecture_merit_edge_obligation_${index}_${field}_missing`);
        }
        const movementIds = Array.isArray(obligation?.movement_ids) ? obligation.movement_ids : [];
        pushIf(blockers, movementIds.length < 1, `story_architecture_merit_edge_obligation_${index}_movement_ids_missing`);
        for (const movementId of movementIds) {
          pushIf(blockers, !ids.includes(movementId), `story_architecture_merit_edge_obligation_${index}_movement_${movementId}_unknown`);
        }
      }
    }
  }
  if (requireCharacterNamePlan) {
    const namePlan = Array.isArray(document?.character_name_plan) ? document.character_name_plan : [];
    pushIf(blockers, namePlan.length < 1, "story_architecture_character_name_plan_missing");
    const normalizedNames = namePlan.map((row) => String(row?.name ?? "").trim().toLowerCase()).filter(Boolean);
    pushIf(blockers, !unique(normalizedNames), "story_architecture_character_name_plan_duplicates");
    for (const [index, row] of namePlan.entries()) {
      for (const field of ["name", "role", "voice_or_behavior_distinction", "selection_rationale"]) {
        pushIf(blockers, !nonEmpty(row?.[field]), `story_architecture_character_name_plan_${index}_${field}_missing`);
      }
      pushIf(blockers, !["new", "intentional_reuse", "series_recurring"].includes(row?.reuse_disposition), `story_architecture_character_name_plan_${index}_reuse_disposition_invalid`);
    }
  }
  return { done: blockers.length === 0, blockers };
}

export function validateLongformDraftSelection(document, {
  packageSha256 = null,
  architectureSha256 = null,
  expectedDrafts = null,
  requireOpeningVerdicts = false,
} = {}) {
  const blockers = [];
  pushIf(blockers, document?.schema !== LONGFORM_DRAFT_SELECTION_SCHEMA, "longform_draft_selection_schema_invalid");
  pushIf(blockers, !["selected", "rejected"].includes(document?.status), "longform_draft_selection_status_invalid");
  pushIf(blockers, !isSha256(document?.package_sha256), "longform_draft_selection_package_hash_invalid");
  pushIf(blockers, !isSha256(document?.architecture_sha256), "longform_draft_selection_architecture_hash_invalid");
  pushIf(blockers, !isSha256(packageSha256), "longform_draft_selection_expected_package_hash_missing");
  pushIf(blockers, !isSha256(architectureSha256), "longform_draft_selection_expected_architecture_hash_missing");
  if (packageSha256) {
    pushIf(blockers, document?.package_sha256 !== packageSha256, "longform_draft_selection_package_hash_mismatch");
  }
  if (architectureSha256) {
    pushIf(blockers, document?.architecture_sha256 !== architectureSha256, "longform_draft_selection_architecture_hash_mismatch");
  }

  const expectedEntries = expectedDrafts instanceof Map
    ? [...expectedDrafts.entries()]
    : Object.entries(expectedDrafts ?? {});
  const expectedById = new Map(expectedEntries.map(([id, draft]) => [id, {
    sha256: typeof draft === "string" ? null : draft?.sha256,
    text: typeof draft === "string" ? draft : draft?.text,
  }]));
  pushIf(blockers, expectedById.size < 1, "longform_draft_selection_expected_drafts_missing");
  for (const [id, draft] of expectedById.entries()) {
    pushIf(blockers, !nonEmpty(id), "longform_draft_selection_expected_draft_id_missing");
    pushIf(blockers, !isSha256(draft.sha256), `longform_draft_selection_expected_draft_${id}_hash_invalid`);
    pushIf(blockers, !nonEmpty(draft.text), `longform_draft_selection_expected_draft_${id}_text_missing`);
  }

  const drafts = Array.isArray(document?.drafts) ? document.drafts : [];
  const draftIds = drafts.map((draft) => String(draft?.id ?? "").trim());
  pushIf(blockers, drafts.length !== expectedById.size, "longform_draft_selection_draft_count_mismatch");
  pushIf(blockers, !unique(draftIds), "longform_draft_selection_draft_ids_duplicate");
  for (const [index, draft] of drafts.entries()) {
    const expected = expectedById.get(draft?.id);
    pushIf(blockers, !expected, `longform_draft_selection_draft_${index}_unknown`);
    pushIf(blockers, !isSha256(draft?.sha256), `longform_draft_selection_draft_${index}_hash_invalid`);
    if (expected) {
      pushIf(blockers, draft?.sha256 !== expected.sha256, `longform_draft_selection_draft_${index}_hash_mismatch`);
    }
  }
  for (const expectedId of expectedById.keys()) {
    pushIf(blockers, !draftIds.includes(expectedId), `longform_draft_selection_expected_draft_${expectedId}_missing`);
  }

  if (document?.status === "selected") {
    pushIf(blockers, !expectedById.has(document?.selected_draft_id), "longform_draft_selection_selected_draft_unknown");
    pushIf(blockers, document?.rejection_reason !== null, "longform_draft_selection_selected_rejection_reason_must_be_null");
  } else {
    pushIf(blockers, document?.selected_draft_id !== null, "longform_draft_selection_rejected_draft_must_be_null");
    pushIf(blockers, !nonEmpty(document?.rejection_reason), "longform_draft_selection_rejection_reason_missing");
  }
  pushIf(blockers, !nonEmpty(document?.decision_rationale), "longform_draft_selection_rationale_missing");

  const openingVerdicts = Array.isArray(document?.opening_verdicts) ? document.opening_verdicts : [];
  if (requireOpeningVerdicts) {
    pushIf(blockers, openingVerdicts.length !== expectedById.size, "longform_draft_selection_opening_verdict_count_mismatch");
    const verdictIds = openingVerdicts.map((verdict) => String(verdict?.draft_id ?? "").trim());
    pushIf(blockers, !unique(verdictIds), "longform_draft_selection_opening_verdict_ids_duplicate");
    for (const expectedId of expectedById.keys()) {
      pushIf(blockers, !verdictIds.includes(expectedId), `longform_draft_selection_opening_verdict_${expectedId}_missing`);
    }
    for (const [index, verdict] of openingVerdicts.entries()) {
      const expected = expectedById.get(verdict?.draft_id);
      pushIf(blockers, !expected, `longform_draft_selection_opening_verdict_${index}_draft_unknown`);
      pushIf(blockers, !["pass", "fail"].includes(verdict?.decision), `longform_draft_selection_opening_verdict_${index}_decision_invalid`);
      pushIf(blockers, !["dramatized", "exposition_first", "trailer_summary"].includes(verdict?.opening_mode), `longform_draft_selection_opening_verdict_${index}_mode_invalid`);
      pushIf(blockers, !Array.isArray(verdict?.new_proper_names_first_220), `longform_draft_selection_opening_verdict_${index}_proper_names_invalid`);
      pushIf(blockers, !Array.isArray(verdict?.unexplained_story_terms_first_220), `longform_draft_selection_opening_verdict_${index}_story_terms_invalid`);
      for (const field of ["first_event_anchor", "judgment"]) {
        pushIf(blockers, !nonEmpty(verdict?.[field]), `longform_draft_selection_opening_verdict_${index}_${field}_missing`);
      }
      const openingText = firstWords(expected?.text);
      if (expected && nonEmpty(verdict?.first_event_anchor)) {
        pushIf(blockers, !openingText.includes(String(verdict.first_event_anchor)), `longform_draft_selection_opening_verdict_${index}_first_anchor_not_in_opening`);
      }
      if (verdict?.decision === "pass") {
        pushIf(blockers, verdict?.opening_mode !== "dramatized", `longform_draft_selection_opening_verdict_${index}_passed_non_dramatized`);
        pushIf(blockers, nonEmpty(verdict?.exposition_before_turn_anchor), `longform_draft_selection_opening_verdict_${index}_passed_with_early_exposition`);
        pushIf(blockers, (verdict?.new_proper_names_first_220 ?? []).length > 1, `longform_draft_selection_opening_verdict_${index}_proper_names_exceed_1`);
        pushIf(blockers, (verdict?.unexplained_story_terms_first_220 ?? []).length > 2, `longform_draft_selection_opening_verdict_${index}_story_terms_exceed_2`);
        pushIf(blockers, !nonEmpty(verdict?.dramatic_turn_anchor), `longform_draft_selection_opening_verdict_${index}_turn_anchor_missing`);
        if (expected && nonEmpty(verdict?.dramatic_turn_anchor)) {
          pushIf(blockers, !openingText.includes(String(verdict.dramatic_turn_anchor)), `longform_draft_selection_opening_verdict_${index}_turn_anchor_not_in_opening`);
        }
      }
    }
    if (document?.status === "selected") {
      const selectedVerdict = openingVerdicts.find((verdict) => verdict?.draft_id === document?.selected_draft_id);
      pushIf(blockers, selectedVerdict?.decision !== "pass", "longform_draft_selection_selected_opening_not_passed");
    }
  }

  const findings = Array.isArray(document?.comparative_findings) ? document.comparative_findings : [];
  pushIf(blockers, findings.length < 1, "longform_draft_selection_findings_missing");
  const comparedDraftIds = new Set();
  for (const [index, finding] of findings.entries()) {
    const expected = expectedById.get(finding?.draft_id);
    pushIf(blockers, !expected, `longform_draft_selection_finding_${index}_draft_unknown`);
    if (expected) comparedDraftIds.add(finding.draft_id);
    for (const field of ["dimension", "exact_anchor", "judgment"]) {
      pushIf(blockers, !nonEmpty(finding?.[field]), `longform_draft_selection_finding_${index}_${field}_missing`);
    }
    if (expected && nonEmpty(finding?.exact_anchor)) {
      pushIf(
        blockers,
        !String(expected.text ?? "").includes(String(finding.exact_anchor)),
        `longform_draft_selection_finding_${index}_anchor_not_found`,
      );
    }
  }
  if (document?.status === "selected") {
    pushIf(
      blockers,
      !comparedDraftIds.has(document?.selected_draft_id),
      "longform_draft_selection_selected_draft_not_compared",
    );
  }

  const transplants = Array.isArray(document?.approved_transplants) ? document.approved_transplants : [];
  pushIf(blockers, transplants.length > 2, "longform_draft_selection_transplants_exceed_2");
  pushIf(blockers, document?.approved_transplants !== undefined && !Array.isArray(document.approved_transplants), "longform_draft_selection_transplants_invalid");
  for (const [index, transplant] of transplants.entries()) {
    pushIf(blockers, !expectedById.has(transplant?.from_draft_id), `longform_draft_selection_transplant_${index}_draft_unknown`);
    if (document?.status === "selected") {
      pushIf(
        blockers,
        transplant?.from_draft_id === document?.selected_draft_id,
        `longform_draft_selection_transplant_${index}_from_selected_draft`,
      );
    }
    for (const field of ["component", "reason"]) {
      pushIf(blockers, !nonEmpty(transplant?.[field]), `longform_draft_selection_transplant_${index}_${field}_missing`);
    }
  }
  pushIf(
    blockers,
    document?.status === "rejected" && transplants.length > 0,
    "longform_draft_selection_rejected_with_transplants",
  );
  return { done: blockers.length === 0, blockers };
}

export function validateArchitectureRedteam(document, {
  architectureText = "",
  architectureSha256 = null,
} = {}) {
  const blockers = [];
  pushIf(blockers, document?.schema !== ARCHITECTURE_REDTEAM_SCHEMA, "architecture_redteam_schema_invalid");
  pushIf(blockers, !["passed", "findings"].includes(document?.status), "architecture_redteam_status_invalid");
  pushIf(blockers, !isSha256(document?.architecture_sha256), "architecture_redteam_architecture_hash_invalid");
  pushIf(blockers, !isSha256(architectureSha256), "architecture_redteam_expected_architecture_hash_missing");
  if (architectureSha256) {
    pushIf(blockers, document?.architecture_sha256 !== architectureSha256, "architecture_redteam_architecture_hash_mismatch");
  }
  const findings = Array.isArray(document?.findings) ? document.findings : [];
  const { accepted, discarded } = validateAnchoredFindings(findings, architectureText);
  pushIf(blockers, discarded.length > 0, `architecture_redteam_invalid_anchors_${discarded.length}`);
  pushIf(blockers, document?.status === "passed" && findings.length > 0, "architecture_redteam_passed_with_findings");
  pushIf(blockers, document?.status === "findings" && findings.length < 1, "architecture_redteam_findings_empty");
  const ids = findings.map((finding) => String(finding?.id ?? "").trim());
  pushIf(blockers, !unique(ids), "architecture_redteam_finding_ids_duplicate");
  for (const [index, finding] of findings.entries()) {
    pushIf(blockers, !nonEmpty(finding?.id), `architecture_redteam_finding_${index}_id_missing`);
    pushIf(blockers, !["material", "critical"].includes(finding?.severity), `architecture_redteam_finding_${index}_severity_invalid`);
    for (const field of ["defect", "downstream_risk", "smallest_repair_intent"]) {
      pushIf(blockers, !nonEmpty(finding?.[field]), `architecture_redteam_finding_${index}_${field}_missing`);
    }
  }
  return {
    done: blockers.length === 0,
    blockers,
    accepted_findings: accepted,
    discarded_findings: discarded,
  };
}

export function validateAnchoredFindings(findings, scriptText) {
  const accepted = [];
  const discarded = [];
  for (const finding of Array.isArray(findings) ? findings : []) {
    const start = Number(finding?.start_offset);
    const end = Number(finding?.end_offset);
    const exactText = String(finding?.exact_text ?? "");
    const valid = Number.isInteger(start)
      && Number.isInteger(end)
      && start >= 0
      && end > start
      && end <= scriptText.length
      && exactText.length > 0
      && scriptText.slice(start, end) === exactText;
    (valid ? accepted : discarded).push(finding);
  }
  return { accepted, discarded };
}

export function validateSourceDiagnosticV2(document, { scriptText = "", scriptSha256 = null } = {}) {
  const blockers = [];
  pushIf(blockers, document?.schema !== SOURCE_DIAGNOSTIC_V2_SCHEMA, "source_diagnostic_v2_schema_invalid");
  pushIf(blockers, !["causality_learning", "promise_continuity", "narrative_authenticity"].includes(document?.diagnostic_id), "source_diagnostic_v2_id_invalid");
  pushIf(blockers, !["passed", "findings"].includes(document?.status), "source_diagnostic_v2_status_invalid");
  if (scriptSha256) pushIf(blockers, document?.script_sha256 !== scriptSha256, "source_diagnostic_v2_script_hash_mismatch");
  const { accepted, discarded } = validateAnchoredFindings(document?.findings, scriptText);
  pushIf(blockers, discarded.length > 0, `source_diagnostic_v2_invalid_anchors_${discarded.length}`);
  pushIf(blockers, document?.status === "passed" && accepted.length > 0, "source_diagnostic_v2_passed_with_findings");
  pushIf(blockers, document?.status === "findings" && accepted.length < 1, "source_diagnostic_v2_findings_empty");
  return { done: blockers.length === 0, blockers, accepted_findings: accepted, discarded_findings: discarded };
}

export function validateSourceRevisionLedger(document, {
  sourceScriptSha256 = null,
  revisedScriptSha256 = null,
  acceptedFindingIds = [],
} = {}) {
  const blockers = [];
  pushIf(blockers, document?.schema !== SOURCE_REVISION_LEDGER_SCHEMA, "source_revision_ledger_schema_invalid");
  pushIf(blockers, document?.status !== "revised", "source_revision_ledger_not_revised");
  if (sourceScriptSha256) pushIf(blockers, document?.source_script_sha256 !== sourceScriptSha256, "source_revision_ledger_source_hash_mismatch");
  if (revisedScriptSha256) pushIf(blockers, document?.revised_script_sha256 !== revisedScriptSha256, "source_revision_ledger_revised_hash_mismatch");
  const entries = Array.isArray(document?.entries) ? document.entries : [];
  const ledgerIds = entries.map((entry) => entry?.finding_id).filter(nonEmpty);
  for (const findingId of acceptedFindingIds) pushIf(blockers, !ledgerIds.includes(findingId), `source_revision_ledger_finding_${findingId}_unresolved`);
  for (const [index, entry] of entries.entries()) {
    for (const field of ["finding_id", "repair_intent", "source_anchor", "revised_anchor"]) {
      pushIf(blockers, !nonEmpty(entry?.[field]), `source_revision_ledger_entry_${index}_${field}_missing`);
    }
    pushIf(blockers, !Array.isArray(entry?.dependent_spans_changed), `source_revision_ledger_entry_${index}_dependent_spans_missing`);
  }
  return { done: blockers.length === 0, blockers };
}

export function validateSourceSemanticAcceptance(document, {
  scriptText = "",
  scriptSha256 = null,
  requireDramaticOpeningAcceptance = false,
  requireReferenceDensityDominance = false,
  referenceText = "",
  referenceSha256 = null,
  referenceMeritFrontierSha256 = null,
  referenceDensityDiagnosticSha256 = null,
  referenceMeritFrontier = null,
} = {}) {
  const blockers = [];
  pushIf(blockers, document?.schema !== SOURCE_SEMANTIC_ACCEPTANCE_SCHEMA, "source_semantic_acceptance_schema_invalid");
  pushIf(blockers, !["accepted", "repair"].includes(document?.status), "source_semantic_acceptance_status_invalid");
  if (scriptSha256) pushIf(blockers, document?.script_sha256 !== scriptSha256, "source_semantic_acceptance_script_hash_mismatch");
  if (requireReferenceDensityDominance || referenceMeritFrontierSha256 || referenceDensityDiagnosticSha256) {
    pushIf(blockers, document?.reference_sha256 !== referenceSha256, "source_semantic_acceptance_reference_hash_mismatch");
    pushIf(blockers, document?.reference_merit_frontier_sha256 !== referenceMeritFrontierSha256, "source_semantic_acceptance_reference_frontier_hash_mismatch");
    pushIf(blockers, document?.reference_density_diagnostic_sha256 !== referenceDensityDiagnosticSha256, "source_semantic_acceptance_reference_diagnostic_hash_mismatch");
  }
  const requirements = Array.isArray(document?.requirements) ? document.requirements : [];
  const ids = requirements.map((requirement) => String(requirement?.id ?? "").trim());
  pushIf(blockers, !unique(ids), "source_semantic_acceptance_requirement_ids_duplicate");
  for (const id of SEMANTIC_ACCEPTANCE_REQUIREMENT_IDS) pushIf(blockers, !ids.includes(id), `source_semantic_acceptance_requirement_${id}_missing`);
  if (requireDramaticOpeningAcceptance) {
    for (const id of DRAMATIC_OPENING_ACCEPTANCE_REQUIREMENT_IDS) {
      pushIf(blockers, !ids.includes(id), `source_semantic_acceptance_requirement_${id}_missing`);
    }
  }
  if (requireReferenceDensityDominance) {
    for (const id of FRONTIER_SEMANTIC_ACCEPTANCE_REQUIREMENT_IDS) {
      pushIf(blockers, !ids.includes(id), `source_semantic_acceptance_requirement_${id}_missing`);
    }
    for (const id of REFERENCE_DENSITY_DIMENSION_IDS) {
      pushIf(blockers, !ids.includes(`reference_density_${id}`), `source_semantic_acceptance_requirement_reference_density_${id}_missing`);
    }
    blockers.push(...validateDensityDimensionRows(document?.reference_density_verdicts, {
      candidateText: scriptText,
      referenceText,
      requireVerdicts: true,
      prefix: "source_semantic_acceptance_reference_density",
    }));
    const verdicts = Array.isArray(document?.reference_density_verdicts) ? document.reference_density_verdicts : [];
    const verdictById = new Map(verdicts.map((row) => [row?.id, row?.decision]));
    const requirementById = new Map(requirements.map((row) => [row?.id, row?.decision]));
    const nonWins = verdicts.filter((row) => row?.decision !== "candidate_win");
    for (const id of REFERENCE_DENSITY_DIMENSION_IDS) {
      const expectedDecision = verdictById.get(id) === "candidate_win" ? "pass" : "fail";
      pushIf(
        blockers,
        requirementById.get(`reference_density_${id}`) !== expectedDecision,
        `source_semantic_acceptance_requirement_reference_density_${id}_verdict_mismatch`,
      );
    }
    const expectedEdges = referenceMeritFrontier?.material_reference_edges ?? [];
    let edgeNonWins = [];
    if (referenceMeritFrontier) {
      blockers.push(...validateDensityEdgeVerdictRows(document?.reference_edge_verdicts, expectedEdges, {
        candidateText: scriptText,
        referenceText,
        prefix: "source_semantic_acceptance_reference_edges",
      }));
      const edgeVerdicts = Array.isArray(document?.reference_edge_verdicts) ? document.reference_edge_verdicts : [];
      const edgeVerdictById = new Map(edgeVerdicts.map((row) => [row?.edge_id, row?.decision]));
      for (const edge of expectedEdges) {
        const requirementId = `reference_edge_${edge.edge_id}`;
        pushIf(blockers, !ids.includes(requirementId), `source_semantic_acceptance_requirement_${requirementId}_missing`);
        const expectedDecision = edgeVerdictById.get(edge.edge_id) === "candidate_win" ? "pass" : "fail";
        pushIf(blockers, requirementById.get(requirementId) !== expectedDecision, `source_semantic_acceptance_requirement_${requirementId}_verdict_mismatch`);
      }
      edgeNonWins = edgeVerdicts.filter((row) => row?.decision !== "candidate_win");
      pushIf(blockers, document?.status === "accepted" && edgeNonWins.length > 0, "source_semantic_acceptance_accepted_without_edge_dominance");
    }
    pushIf(
      blockers,
      requirementById.get("reference_density_dominance") !== (nonWins.length + edgeNonWins.length === 0 ? "pass" : "fail"),
      "source_semantic_acceptance_reference_density_dominance_verdict_mismatch",
    );
    pushIf(blockers, document?.status === "accepted" && nonWins.length > 0, "source_semantic_acceptance_accepted_without_density_dominance");
  }
  for (const [index, requirement] of requirements.entries()) {
    pushIf(blockers, !["pass", "fail"].includes(requirement?.decision), `source_semantic_acceptance_requirement_${index}_decision_invalid`);
  }
  const { accepted: validFailures, discarded } = validateAnchoredFindings(document?.anchored_failures, scriptText);
  pushIf(blockers, discarded.length > 0, `source_semantic_acceptance_invalid_failure_anchors_${discarded.length}`);
  const failedCount = requirements.filter((requirement) => requirement?.decision === "fail").length;
  pushIf(blockers, document?.status === "accepted" && (failedCount > 0 || validFailures.length > 0), "source_semantic_acceptance_accepted_with_failures");
  pushIf(blockers, document?.status === "repair" && (failedCount < 1 || validFailures.length < 1), "source_semantic_acceptance_repair_without_anchored_failure");
  return { done: blockers.length === 0, blockers, valid_failures: validFailures, discarded_failures: discarded };
}

export function validateSourceRoomReleaseV2(document, {
  finalScriptSha256 = null,
  packageSelectionSha256 = null,
  packageSelectionApprovalSha256 = null,
  treatmentSelectionSha256 = null,
  treatmentSelectionApprovalSha256 = null,
  architectureSha256 = null,
  architectureApprovalSha256 = null,
  longformDraftSelectionSha256 = null,
  diagnosticSha256s = null,
  revisionLedgerSha256 = null,
  semanticAcceptanceSha256 = null,
  finalScriptApprovalSha256 = null,
  referenceMeritFrontierSha256 = null,
  referenceSha256 = null,
  viewerTournamentAcceptanceSha256 = null,
  viewerTournamentManifestSha256 = null,
  viewerTournamentReportSha256s = null,
  requireViewerTournamentAcceptance = false,
  sourceRoomContractSha256 = null,
  sourceRoomProfile = null,
  requireSourceRoomContract = false,
} = {}) {
  const blockers = [];
  pushIf(blockers, document?.schema !== SOURCE_ROOM_RELEASE_V2_SCHEMA, "source_room_release_v2_schema_invalid");
  pushIf(blockers, document?.status !== "released", "source_room_release_v2_not_released");
  const scalarBindings = [
    ["final_script_sha256", finalScriptSha256],
    ["package_selection_sha256", packageSelectionSha256],
    ["package_selection_approval_sha256", packageSelectionApprovalSha256],
    ["treatment_selection_sha256", treatmentSelectionSha256],
    ["treatment_selection_approval_sha256", treatmentSelectionApprovalSha256],
    ["architecture_sha256", architectureSha256],
    ["architecture_approval_sha256", architectureApprovalSha256],
    ["longform_draft_selection_sha256", longformDraftSelectionSha256],
    ["revision_ledger_sha256", revisionLedgerSha256],
    ["semantic_acceptance_sha256", semanticAcceptanceSha256],
    ["final_script_approval_sha256", finalScriptApprovalSha256],
  ];
  for (const [field, expected] of scalarBindings) {
    pushIf(blockers, !isSha256(document?.[field]), `source_room_release_v2_${field}_invalid`);
    pushIf(blockers, !isSha256(expected), `source_room_release_v2_expected_${field}_missing`);
    if (expected) pushIf(blockers, document?.[field] !== expected, `source_room_release_v2_${field}_mismatch`);
  }
  for (const [field, expected] of [
    ["reference_merit_frontier_sha256", referenceMeritFrontierSha256],
    ["reference_sha256", referenceSha256],
    ["viewer_tournament_acceptance_sha256", viewerTournamentAcceptanceSha256],
    ["viewer_tournament_manifest_sha256", viewerTournamentManifestSha256],
  ]) {
    if (!expected) continue;
    pushIf(blockers, !isSha256(document?.[field]), `source_room_release_v2_${field}_invalid`);
    pushIf(blockers, document?.[field] !== expected, `source_room_release_v2_${field}_mismatch`);
  }
  if (requireViewerTournamentAcceptance) {
    pushIf(blockers, !isSha256(viewerTournamentAcceptanceSha256), "source_room_release_v2_expected_viewer_tournament_acceptance_hash_missing");
    pushIf(blockers, !isSha256(viewerTournamentManifestSha256), "source_room_release_v2_expected_viewer_tournament_manifest_hash_missing");
    pushIf(blockers, !isSha256(document?.viewer_tournament_acceptance_sha256), "source_room_release_v2_viewer_tournament_acceptance_hash_missing");
    pushIf(blockers, !isSha256(document?.viewer_tournament_manifest_sha256), "source_room_release_v2_viewer_tournament_manifest_hash_missing");
    pushIf(
      blockers,
      !viewerTournamentReportSha256s || typeof viewerTournamentReportSha256s !== "object" || Array.isArray(viewerTournamentReportSha256s),
      "source_room_release_v2_expected_viewer_tournament_report_hashes_missing",
    );
    pushIf(
      blockers,
      !document?.viewer_tournament_report_sha256s
        || typeof document.viewer_tournament_report_sha256s !== "object"
        || Array.isArray(document.viewer_tournament_report_sha256s),
      "source_room_release_v2_viewer_tournament_report_hashes_missing",
    );
    if (viewerTournamentReportSha256s) {
      pushIf(
        blockers,
        Object.keys(viewerTournamentReportSha256s).length !== 10,
        "source_room_release_v2_expected_viewer_tournament_report_count_invalid",
      );
      pushIf(
        blockers,
        !compareStringMaps(document?.viewer_tournament_report_sha256s, viewerTournamentReportSha256s),
        "source_room_release_v2_viewer_tournament_report_hashes_mismatch",
      );
    }
  }
  if (sourceRoomContractSha256 || sourceRoomProfile || requireSourceRoomContract) {
    pushIf(blockers, !isSha256(sourceRoomContractSha256), "source_room_release_v2_expected_room_contract_hash_missing");
    pushIf(blockers, !isSha256(document?.source_room_contract_sha256), "source_room_release_v2_room_contract_hash_missing");
    if (sourceRoomContractSha256) {
      pushIf(blockers, document?.source_room_contract_sha256 !== sourceRoomContractSha256, "source_room_release_v2_room_contract_hash_mismatch");
    }
    pushIf(blockers, !nonEmpty(sourceRoomProfile), "source_room_release_v2_expected_room_profile_missing");
    pushIf(blockers, !nonEmpty(document?.source_room_profile), "source_room_release_v2_room_profile_missing");
    if (sourceRoomProfile) {
      pushIf(blockers, document?.source_room_profile !== sourceRoomProfile, "source_room_release_v2_room_profile_mismatch");
    }
    pushIf(blockers, !nonEmpty(document?.source_room_contract_path), "source_room_release_v2_room_contract_path_missing");
  }

  const diagnostics = document?.diagnostic_sha256s;
  pushIf(
    blockers,
    !diagnostics || typeof diagnostics !== "object" || Array.isArray(diagnostics),
    "source_room_release_v2_diagnostic_hashes_invalid",
  );
  const diagnosticEntries = diagnostics && typeof diagnostics === "object" && !Array.isArray(diagnostics)
    ? Object.entries(diagnostics)
    : [];
  pushIf(blockers, diagnosticEntries.length < 1, "source_room_release_v2_diagnostic_hashes_missing");
  // V2 releases created before the authenticity lane remain readable. New releases
  // bind the third diagnostic through their complete expected hash map.
  for (const requiredDiagnosticId of ["causality_learning", "promise_continuity"]) {
    pushIf(
      blockers,
      !Object.hasOwn(diagnostics ?? {}, requiredDiagnosticId),
      `source_room_release_v2_diagnostic_${requiredDiagnosticId}_missing`,
    );
  }
  for (const [diagnosticId, hash] of diagnosticEntries) {
    pushIf(blockers, !nonEmpty(diagnosticId), "source_room_release_v2_diagnostic_id_missing");
    pushIf(blockers, !isSha256(hash), `source_room_release_v2_diagnostic_${diagnosticId}_hash_invalid`);
  }
  pushIf(
    blockers,
    !diagnosticSha256s || typeof diagnosticSha256s !== "object" || Array.isArray(diagnosticSha256s),
    "source_room_release_v2_expected_diagnostic_hashes_missing",
  );
  if (diagnosticSha256s) {
    pushIf(
      blockers,
      !compareStringMaps(diagnostics, diagnosticSha256s),
      "source_room_release_v2_diagnostic_hashes_mismatch",
    );
  }
  return { done: blockers.length === 0, blockers };
}
