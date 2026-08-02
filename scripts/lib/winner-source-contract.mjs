import { createHash } from "node:crypto";

export const WINNER_FORMULA_SCHEMA = "goldflow_channel_winner_formula_v1";
export const WINNER_IDEATION_SCHEMA = "goldflow_winner_ideation_candidates_v1";
export const WINNER_IDEATION_REPORT_SCHEMA = "goldflow_winner_ideation_report_v1";
export const WINNER_PACKAGE_CONTRACT_SCHEMA = "goldflow_source_winner_package_v1";
export const WINNER_PACKAGE_APPROVAL_SCHEMA = "goldflow_source_winner_package_approval_v1";
export const WINNER_SCRIPT_GENERATION_REPORT_SCHEMA = "goldflow_winner_script_generation_report_v1";
export const WINNER_SCRIPT_GATE_SCHEMA = "goldflow_winner_script_gate_v1";
export const WINNER_SOURCE_RELEASE_SCHEMA = "goldflow_winner_source_release_v1";

export const WINNER_GATE_IDS = [
  "joey_competence_and_learning",
  "plot_logic_and_payoff",
  "pacing_and_non_repetition",
  "joey_agency_with_power",
  "first_time_viewer_clarity",
  "growth_revenge_and_closure",
];

export const WINNER_RETENTION_CHECKPOINT_IDS = [
  "title_contradiction_30s",
  "irreversible_boundary_minute_5",
  "advantage_proof_minute_8",
  "forward_objective_minute_10",
  "scaling_pressure_and_adaptive_response",
  "literal_title_payoff",
];

const STOP_TITLE_WORDS = new Set([
  "a", "an", "and", "as", "at", "for", "from", "her", "his", "i", "in", "it", "manhwa", "me",
  "my", "of", "on", "recap", "she", "so", "the", "then", "they", "to", "was", "with",
]);

const WINNER_DECISIVE_APPLICATION_ROLES = [
  "first_proof",
  "climax_or_late_scale_proof",
];

const WINNER_DECISIVE_APPLICATION_FIELDS = [
  "obstacle_or_tell",
  "mechanic_output_or_granted_capability",
  "execution_bridge",
  "joey_tactic_and_action",
  "opponent_or_environment_response",
  "result",
  "dominance_proof",
];

export function sha256Text(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

export function normalizeWinnerNarration(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim() + "\n";
}

export function countWords(value) {
  return (String(value ?? "").match(/[A-Za-z0-9]+(?:['’.-][A-Za-z0-9]+)*/g) ?? []).length;
}

export function wordsInOverlay(value) {
  return countWords(String(value ?? "").replace(/[_/|]+/g, " "));
}

export function extractJsonObject(value) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error("Empty model response; expected one JSON object.");
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(unfenced);
  } catch {}
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Model response did not contain a JSON object.");
  return JSON.parse(unfenced.slice(start, end + 1));
}

function normalizedTitleTokens(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\|\s*manhwa\s+recap\s*$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token && !STOP_TITLE_WORDS.has(token));
}

export function titleSimilarity(left, right) {
  const leftSet = new Set(normalizedTitleTokens(left));
  const rightSet = new Set(normalizedTitleTokens(right));
  if (!leftSet.size || !rightSet.size) return 0;
  const intersection = [...leftSet].filter((token) => rightSet.has(token)).length;
  const union = new Set([...leftSet, ...rightSet]).size;
  return union ? intersection / union : 0;
}

function nonEmpty(value) {
  return Boolean(String(value ?? "").trim());
}

function exactPhrasePresent(title, phrase) {
  return nonEmpty(phrase) && String(title ?? "").toLowerCase().includes(String(phrase).trim().toLowerCase());
}

function integerBetween(value, min, max) {
  return Number.isInteger(Number(value)) && Number(value) >= min && Number(value) <= max;
}

function pushIf(blockers, condition, code) {
  if (condition) blockers.push(code);
}

function appendCoreAdvantageBlockers(blockers, coreAdvantage, prefix = "core_advantage") {
  for (const field of [
    "type",
    "post_betrayal_connection",
    "source_or_activation",
    "core_capability",
    "growth_or_compounding_rule",
    "execution_bridge",
    "first_visible_proof",
    "causal_scale_path",
  ]) {
    pushIf(blockers, !nonEmpty(coreAdvantage?.[field]), `${prefix}_${field}_missing`);
  }

  const applications = Array.isArray(coreAdvantage?.decisive_applications)
    ? coreAdvantage.decisive_applications
    : [];
  pushIf(blockers, applications.length < WINNER_DECISIVE_APPLICATION_ROLES.length, `${prefix}_decisive_applications_too_thin`);
  const roles = new Set();
  for (const [index, application] of applications.entries()) {
    const role = String(application?.role ?? "").trim();
    pushIf(blockers, !WINNER_DECISIVE_APPLICATION_ROLES.includes(role), `${prefix}_decisive_application_${index}_role_invalid`);
    pushIf(blockers, roles.has(role), `${prefix}_decisive_application_${role || index}_duplicate`);
    if (role) roles.add(role);
    for (const field of WINNER_DECISIVE_APPLICATION_FIELDS) {
      pushIf(blockers, !nonEmpty(application?.[field]), `${prefix}_decisive_application_${index}_${field}_missing`);
    }
  }
  for (const role of WINNER_DECISIVE_APPLICATION_ROLES) {
    pushIf(blockers, !roles.has(role), `${prefix}_decisive_application_${role}_missing`);
  }
}

export function validateWinnerFormula(formula) {
  const blockers = [];
  pushIf(blockers, formula?.schema !== WINNER_FORMULA_SCHEMA, "formula_schema_invalid");
  pushIf(blockers, formula?.status !== "active", "formula_not_active");
  pushIf(blockers, !nonEmpty(formula?.channel), "formula_channel_missing");
  pushIf(blockers, !nonEmpty(formula?.version), "formula_version_missing");
  pushIf(blockers, !Array.isArray(formula?.evidence) || formula.evidence.length < 2, "formula_evidence_missing");
  const evidenceIds = new Set();
  for (const [index, evidence] of (formula?.evidence ?? []).entries()) {
    pushIf(blockers, !nonEmpty(evidence?.id), `formula_evidence_${index}_id_missing`);
    pushIf(blockers, evidenceIds.has(evidence?.id), `formula_evidence_${index}_id_duplicate`);
    evidenceIds.add(evidence?.id);
    pushIf(blockers, !["own_channel", "niche_outlier"].includes(evidence?.source_type), `formula_evidence_${index}_source_type_invalid`);
    pushIf(blockers, !nonEmpty(evidence?.title), `formula_evidence_${index}_title_missing`);
    pushIf(blockers, !evidence?.metrics || typeof evidence.metrics !== "object", `formula_evidence_${index}_metrics_missing`);
    pushIf(blockers, !nonEmpty(evidence?.lesson), `formula_evidence_${index}_lesson_missing`);
  }
  const dimensions = formula?.score_dimensions ?? {};
  pushIf(blockers, !Object.keys(dimensions).length, "formula_score_dimensions_missing");
  const totalWeight = Object.values(dimensions).reduce((sum, row) => sum + Number(row?.weight ?? 0), 0);
  pushIf(blockers, Math.abs(totalWeight - 100) > 0.001, "formula_score_weights_must_total_100");
  for (const [id, row] of Object.entries(dimensions)) {
    pushIf(blockers, !nonEmpty(id), "formula_score_dimension_id_missing");
    pushIf(blockers, !Number.isFinite(Number(row?.weight)) || Number(row.weight) <= 0, `formula_score_dimension_${id}_weight_invalid`);
    pushIf(blockers, !integerBetween(row?.minimum, 1, 10), `formula_score_dimension_${id}_minimum_invalid`);
  }
  const enginePolicy = formula?.reversal_engine_policy ?? {};
  pushIf(blockers, !nonEmpty(enginePolicy?.mandatory_betrayal_spine), "formula_mandatory_betrayal_spine_missing");
  pushIf(blockers, !nonEmpty(enginePolicy?.sequence), "formula_betrayal_engine_sequence_missing");
  pushIf(blockers, !nonEmpty(enginePolicy?.discovery_rule), "formula_reversal_engine_discovery_rule_missing");
  pushIf(blockers, !nonEmpty(enginePolicy?.batch_diversity_rule), "formula_reversal_engine_batch_diversity_rule_missing");
  pushIf(blockers, !nonEmpty(enginePolicy?.selection_rule), "formula_reversal_engine_selection_rule_missing");
  const retention = formula?.retention_architecture ?? {};
  const retentionDimensions = retention?.score_dimensions ?? {};
  pushIf(blockers, !Object.keys(retentionDimensions).length, "formula_retention_score_dimensions_missing");
  const retentionWeight = Object.values(retentionDimensions).reduce((sum, row) => sum + Number(row?.weight ?? 0), 0);
  pushIf(blockers, Math.abs(retentionWeight - 100) > 0.001, "formula_retention_score_weights_must_total_100");
  for (const [id, row] of Object.entries(retentionDimensions)) {
    pushIf(blockers, !Number.isFinite(Number(row?.weight)) || Number(row.weight) <= 0, `formula_retention_dimension_${id}_weight_invalid`);
    pushIf(blockers, !integerBetween(row?.minimum, 1, 10), `formula_retention_dimension_${id}_minimum_invalid`);
  }
  pushIf(blockers, !Number.isFinite(Number(retention?.minimum_total_score)), "formula_retention_minimum_total_score_missing");
  pushIf(blockers, !Number.isInteger(Number(retention?.movement_count_min)), "formula_retention_movement_count_min_missing");
  pushIf(blockers, !Number.isInteger(Number(retention?.movement_count_max)), "formula_retention_movement_count_max_missing");
  const requiredCheckpoints = retention?.required_checkpoint_ids ?? [];
  pushIf(blockers, requiredCheckpoints.length !== WINNER_RETENTION_CHECKPOINT_IDS.length, "formula_retention_checkpoint_count_invalid");
  for (const id of WINNER_RETENTION_CHECKPOINT_IDS) pushIf(blockers, !requiredCheckpoints.includes(id), `formula_retention_checkpoint_${id}_missing`);
  return { done: blockers.length === 0, blockers };
}

function evidenceTypesForCandidate(candidate, evidenceById) {
  return new Set((candidate?.evidence_ids ?? []).map((id) => evidenceById.get(id)?.source_type).filter(Boolean));
}

function candidateScore(candidate, formula) {
  const dimensions = formula.score_dimensions ?? {};
  let weighted = 0;
  const dimensionScores = {};
  const blockers = [];
  for (const [id, policy] of Object.entries(dimensions)) {
    const value = Number(candidate?.score_inputs?.[id]);
    dimensionScores[id] = Number.isFinite(value) ? value : null;
    if (!integerBetween(value, 1, 10)) blockers.push(`score_${id}_invalid`);
    else {
      weighted += (value / 10) * Number(policy.weight);
      if (value < Number(policy.minimum)) blockers.push(`score_${id}_below_minimum`);
    }
  }
  return { weighted_score: Number(weighted.toFixed(2)), dimension_scores: dimensionScores, blockers };
}

export function evaluateWinnerIdeation(document, formula, { recentTitles = [], rejectedCandidateIds = [] } = {}) {
  const formulaValidation = validateWinnerFormula(formula);
  if (!formulaValidation.done) throw new Error(`Invalid winner formula: ${formulaValidation.blockers.join(", ")}`);
  const documentBlockers = [];
  const documentWarnings = [];
  pushIf(documentBlockers, document?.schema !== WINNER_IDEATION_SCHEMA, "ideation_schema_invalid");
  pushIf(documentBlockers, document?.channel !== formula.channel, "ideation_channel_mismatch");
  pushIf(documentBlockers, document?.formula_version !== formula.version, "ideation_formula_version_mismatch");
  pushIf(documentBlockers, !nonEmpty(document?.development_slug), "ideation_development_slug_missing");
  const candidates = Array.isArray(document?.candidates) ? document.candidates : [];
  const requestedCount = Number(formula?.candidate_policy?.requested_candidate_count ?? 6);
  pushIf(documentBlockers, candidates.length !== requestedCount, `ideation_candidate_count_expected_${requestedCount}_found_${candidates.length}`);
  const evidenceById = new Map((formula.evidence ?? []).map((row) => [row.id, row]));
  const rejectedIdSet = new Set(rejectedCandidateIds.map((value) => String(value ?? "").trim()).filter(Boolean));
  const requiredEvidenceTypes = formula?.candidate_policy?.required_evidence_types ?? ["own_channel", "niche_outlier"];
  const knownHardRejects = new Set(Object.keys(formula?.hard_reject_codes ?? {}));
  const seenIds = new Set();
  const seenPairwiseRanks = new Set();
  const evaluatedCandidates = candidates.map((candidate, index) => {
    const blockers = [];
    const warnings = [];
    const id = String(candidate?.id ?? "").trim();
    pushIf(blockers, !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(id), "candidate_id_invalid");
    pushIf(blockers, seenIds.has(id), "candidate_id_duplicate");
    pushIf(blockers, rejectedIdSet.has(id), "candidate_operator_rejected");
    seenIds.add(id);
    const title = String(candidate?.title ?? "").trim();
    const titleSuffix = String(formula?.candidate_policy?.title_suffix ?? "| Manhwa Recap");
    const titleMax = Number(formula?.candidate_policy?.title_max_characters ?? 100);
    pushIf(blockers, !title.endsWith(titleSuffix), "title_suffix_missing");
    pushIf(blockers, title.length > titleMax, "title_too_long");
    pushIf(blockers, !exactPhrasePresent(title, candidate?.title_contract?.betrayal_phrase), "title_betrayal_phrase_missing");
    pushIf(blockers, !exactPhrasePresent(title, candidate?.title_contract?.reversal_phrase), "title_reversal_phrase_missing");
    for (const field of ["betrayer", "betrayal_action", "reversal_action", "antagonist_loss"]) {
      pushIf(blockers, !nonEmpty(candidate?.title_contract?.[field]), `title_contract_${field}_missing`);
    }
    const thumbnail = candidate?.thumbnail ?? {};
    const subjects = Array.isArray(thumbnail.subjects) ? thumbnail.subjects : [];
    const labels = Array.isArray(thumbnail.labels) ? thumbnail.labels : [];
    const arrows = Array.isArray(thumbnail.arrows) ? thumbnail.arrows : [];
    pushIf(blockers, subjects.length < 1 || subjects.length > Number(formula.candidate_policy.thumbnail_subjects_max ?? 3), "thumbnail_subject_count_invalid");
    pushIf(blockers, wordsInOverlay(thumbnail.main_text) < 1 || wordsInOverlay(thumbnail.main_text) > Number(formula.candidate_policy.thumbnail_main_text_words_max ?? 4), "thumbnail_main_text_word_count_invalid");
    pushIf(blockers, labels.length > Number(formula.candidate_policy.thumbnail_labels_max ?? 2), "thumbnail_too_many_labels");
    pushIf(blockers, arrows.length > Number(formula.candidate_policy.thumbnail_arrows_max ?? 2), "thumbnail_too_many_arrows");
    const totalOverlayWords = wordsInOverlay(thumbnail.main_text) + labels.reduce((sum, label) => sum + wordsInOverlay(label), 0);
    pushIf(blockers, totalOverlayWords > Number(formula.candidate_policy.thumbnail_total_overlay_words_max ?? 8), "thumbnail_total_overlay_words_exceeded");
    for (const field of ["dominant_proof", "betrayal_signal", "reversal_signal", "additive_fact", "image_prompt"]) {
      pushIf(blockers, !nonEmpty(thumbnail[field]), `thumbnail_${field}_missing`);
    }
    const premiseWords = countWords(candidate?.premise);
    pushIf(blockers, premiseWords < 100 || premiseWords > 350, "premise_word_count_out_of_range");
    appendCoreAdvantageBlockers(blockers, candidate?.core_advantage);
    const story = candidate?.story_contract ?? {};
    for (const field of [
      "opening_30_seconds",
      "boundary_by_minute_5",
      "first_advantage_proof_by_minute_8",
      "new_objective_by_minute_10",
      "escalation_pressure",
      "antagonist_adaptation",
      "climax",
      "final_boundary",
    ]) pushIf(blockers, !nonEmpty(story[field]), `story_contract_${field}_missing`);
    pushIf(blockers, !Array.isArray(story.middle_engine) || story.middle_engine.length < 4, "story_contract_middle_engine_too_thin");
    const evidenceIds = Array.isArray(candidate?.evidence_ids) ? candidate.evidence_ids : [];
    pushIf(blockers, evidenceIds.some((idValue) => !evidenceById.has(idValue)), "candidate_evidence_id_unknown");
    const evidenceTypes = evidenceTypesForCandidate(candidate, evidenceById);
    for (const requiredType of requiredEvidenceTypes) pushIf(blockers, !evidenceTypes.has(requiredType), `candidate_evidence_type_${requiredType}_missing`);
    const hardRejects = Array.isArray(candidate?.hard_rejects) ? candidate.hard_rejects.filter(Boolean) : [];
    pushIf(blockers, hardRejects.some((code) => !knownHardRejects.has(code)), "candidate_hard_reject_code_unknown");
    if (hardRejects.length) blockers.push(...hardRejects.map((code) => `hard_reject_${code}`));
    const score = candidateScore(candidate, formula);
    warnings.push(...score.blockers);
    pushIf(warnings, score.weighted_score < Number(formula.candidate_policy.minimum_total_score ?? 80), "candidate_total_score_below_minimum");
    const pairwiseRank = Number(candidate?.pairwise_rank);
    const pairwiseWins = Number(candidate?.pairwise_wins);
    pushIf(blockers, !Number.isInteger(pairwiseRank) || pairwiseRank < 1 || pairwiseRank > requestedCount, "candidate_pairwise_rank_invalid");
    pushIf(blockers, seenPairwiseRanks.has(pairwiseRank), "candidate_pairwise_rank_duplicate");
    seenPairwiseRanks.add(pairwiseRank);
    pushIf(blockers, !Number.isInteger(pairwiseWins) || pairwiseWins < 0 || pairwiseWins >= requestedCount, "candidate_pairwise_wins_invalid");
    pushIf(blockers, !nonEmpty(candidate?.selection_rationale), "candidate_selection_rationale_missing");
    const similarities = recentTitles.map((recentTitle) => ({ title: recentTitle, score: titleSimilarity(title, recentTitle) }));
    similarities.sort((left, right) => right.score - left.score);
    const nearest = similarities[0] ?? { title: null, score: 0 };
    pushIf(blockers, nearest.score >= 0.82, "candidate_recent_title_near_duplicate");
    return {
      ...candidate,
      computed: {
        eligible: blockers.length === 0,
        weighted_score: score.weighted_score,
        dimension_scores: score.dimension_scores,
        blockers: [...new Set(blockers)],
        warnings: [...new Set(warnings)],
        nearest_recent_title: nearest.title,
        nearest_recent_title_similarity: Number(nearest.score.toFixed(4)),
        overlay_word_count: totalOverlayWords,
        premise_word_count: premiseWords,
      },
    };
  });
  const eligibleCount = evaluatedCandidates.filter((row) => row.computed.eligible).length;
  const minimumEligible = Number(formula?.candidate_policy?.minimum_eligible_candidates ?? 3);
  if (eligibleCount < minimumEligible) documentBlockers.push(`ideation_eligible_candidates_expected_at_least_${minimumEligible}_found_${eligibleCount}`);
  const status = documentBlockers.length ? "blocked" : "passed";
  return {
    document: {
      ...document,
      status,
      candidates: evaluatedCandidates,
    },
    report: {
      schema: WINNER_IDEATION_REPORT_SCHEMA,
      status,
      channel: formula.channel,
      development_slug: document?.development_slug ?? null,
      formula_version: formula.version,
      candidate_count: candidates.length,
      eligible_candidate_count: eligibleCount,
      candidate_warning_count: evaluatedCandidates.reduce((sum, row) => sum + row.computed.warnings.length, 0),
      document_warning_count: documentWarnings.length,
      warnings: [...new Set(documentWarnings)],
      reversal_engines: evaluatedCandidates.map((row) => ({ id: row.id, type: row.core_advantage?.type ?? null })),
      blockers: [...new Set(documentBlockers)],
      ranked_eligible_candidate_ids: evaluatedCandidates
        .filter((row) => row.computed.eligible)
        .sort((left, right) => Number(left.pairwise_rank) - Number(right.pairwise_rank)
          || right.computed.weighted_score - left.computed.weighted_score)
        .map((row) => row.id),
    },
  };
}

export function buildWinnerPackageContract({
  ideation,
  ideationPath,
  ideationSha256,
  formula,
  formulaPath,
  formulaSha256,
  candidateId,
  approvedBy,
  operatorOverride = null,
  approvedAt = new Date().toISOString(),
}) {
  const candidate = ideation?.candidates?.find((row) => row.id === candidateId);
  if (!candidate) throw new Error(`Unknown winner candidate: ${candidateId}`);
  if (!candidate?.computed?.eligible && !operatorOverride?.approved) {
    throw new Error(`Winner candidate ${candidateId} is not eligible: ${(candidate?.computed?.blockers ?? []).join(", ")}`);
  }
  if (operatorOverride?.approved && !nonEmpty(operatorOverride?.reason)) {
    throw new Error("An ineligible winner candidate override requires a non-empty reason.");
  }
  const targetMinutes = Number(formula.candidate_policy.target_runtime_minutes ?? 60);
  const minimumMinutes = Number(formula.candidate_policy.target_runtime_min_minutes ?? targetMinutes * 0.9);
  const maximumMinutes = Number(formula.candidate_policy.target_runtime_max_minutes ?? targetMinutes * 1.1);
  const targetWpm = Number(formula.candidate_policy.target_spoken_wpm ?? 187.5);
  const wordRange = {
    minimum: Math.round(minimumMinutes * targetWpm),
    maximum: Math.round(maximumMinutes * targetWpm),
  };
  const contract = {
    schema: WINNER_PACKAGE_CONTRACT_SCHEMA,
    status: "approved",
    channel: formula.channel,
    development_slug: ideation.development_slug,
    formula_version: formula.version,
    formula_path: formulaPath,
    formula_sha256: formulaSha256,
    ideation_path: ideationPath,
    ideation_sha256: ideationSha256,
    selected_candidate_id: candidateId,
    selected_title: candidate.title,
    title_contract: candidate.title_contract,
    thumbnail_contract: candidate.thumbnail,
    premise: candidate.premise,
    core_advantage: candidate.core_advantage,
    story_contract: candidate.story_contract,
    differentiation: candidate.differentiation,
    evidence_ids: candidate.evidence_ids,
    weighted_score: candidate.computed.weighted_score,
    target_runtime_minutes: targetMinutes,
    intended_spoken_wpm: targetWpm,
    target_word_range: wordRange,
    narration_profile: formula.candidate_policy.narration_profile ?? "CONVERSATIONAL WINNER",
    ending_requirement: "Complete standalone ending with the antagonist's concrete loss, Joey's final boundary, and one concise new equilibrium.",
    approved_by: approvedBy,
    approved_at: approvedAt,
    selection_override: operatorOverride?.approved ? {
      approved: true,
      reason: operatorOverride.reason,
      original_blockers: candidate?.computed?.blockers ?? [],
    } : null,
  };
  return {
    contract,
    approval: {
      schema: WINNER_PACKAGE_APPROVAL_SCHEMA,
      status: "approved",
      channel: formula.channel,
      development_slug: ideation.development_slug,
      selected_candidate_id: candidateId,
      selected_candidate_sha256: sha256Text(JSON.stringify(candidate)),
      selected_title: candidate.title,
      ideation_sha256: ideationSha256,
      formula_sha256: formulaSha256,
      approved_by: approvedBy,
      approved_at: approvedAt,
      approval_scope: "exact_formula_ideation_and_candidate",
      selection_override: contract.selection_override,
    },
  };
}

export function validateWinnerPackageContract(contract) {
  const blockers = [];
  pushIf(blockers, contract?.schema !== WINNER_PACKAGE_CONTRACT_SCHEMA, "winner_package_schema_invalid");
  pushIf(blockers, contract?.status !== "approved", "winner_package_not_approved");
  for (const field of [
    "channel", "development_slug", "formula_version", "formula_sha256", "ideation_sha256",
    "selected_candidate_id", "selected_title", "premise", "approved_by", "approved_at",
  ]) pushIf(blockers, !nonEmpty(contract?.[field]), `winner_package_${field}_missing`);
  pushIf(blockers, !contract?.thumbnail_contract || typeof contract.thumbnail_contract !== "object", "winner_package_thumbnail_contract_missing");
  pushIf(blockers, !contract?.title_contract || typeof contract.title_contract !== "object", "winner_package_title_contract_missing");
  pushIf(blockers, !contract?.core_advantage || typeof contract.core_advantage !== "object", "winner_package_core_advantage_missing");
  if (contract?.core_advantage && typeof contract.core_advantage === "object") {
    appendCoreAdvantageBlockers(blockers, contract.core_advantage, "winner_package_core_advantage");
  }
  pushIf(blockers, !contract?.story_contract || typeof contract.story_contract !== "object", "winner_package_story_contract_missing");
  pushIf(blockers, !Number.isFinite(Number(contract?.target_word_range?.minimum)), "winner_package_minimum_words_missing");
  pushIf(blockers, !Number.isFinite(Number(contract?.target_word_range?.maximum)), "winner_package_maximum_words_missing");
  return { done: blockers.length === 0, blockers };
}

export function deterministicWinnerScriptReview(script, packageContract) {
  const blockers = [];
  const warnings = [];
  const normalized = normalizeWinnerNarration(script);
  const wordCount = countWords(normalized);
  const minimum = Number(packageContract?.target_word_range?.minimum ?? 0);
  const maximum = Number(packageContract?.target_word_range?.maximum ?? Number.POSITIVE_INFINITY);
  const probableTruncationFloor = Math.max(500, Math.round(minimum * 0.7));
  pushIf(blockers, wordCount < probableTruncationFloor, `script_probably_truncated_${wordCount}_below_${probableTruncationFloor}`);
  if (wordCount < minimum) warnings.push(`script_word_count_below_target_${wordCount}_of_${minimum}`);
  if (wordCount > maximum) warnings.push(`script_word_count_above_target_${wordCount}_of_${maximum}`);
  if (/^#{1,6}\s+/m.test(normalized)) warnings.push("script_contains_markdown_heading");
  if (/^```/m.test(normalized)) warnings.push("script_contains_markdown_fence");
  if (/^(?:SCENE|CHAPTER|BLOCK|OUTLINE|NARRATOR|TITLE|THUMBNAIL|PREMISE|WORD COUNT)\s*[:#-]/im.test(normalized)) warnings.push("script_contains_non_narration_label");
  if (/^\s*[-*]\s+/m.test(normalized)) warnings.push("script_contains_markdown_list");
  if (/\b(?:the narrator wants you to|the narrator will|in this script|this story teaches|the viewer should)\b/i.test(normalized)) warnings.push("script_contains_meta_narration");
  if (!/\bJoey Manhwa\b/.test(normalized.slice(0, 1400))) warnings.push("joey_full_name_not_found_near_opening");
  const openingWordTarget = Math.round(Number(packageContract?.intended_spoken_wpm ?? 187.5) / 2);
  return {
    status: blockers.length ? "blocked" : "passed",
    source_script_sha256: sha256Text(normalized),
    source_word_count: wordCount,
    target_word_range: { minimum, maximum },
    estimated_opening_30_second_words: openingWordTarget,
    blockers,
    warnings,
    normalized_script: normalized,
  };
}

function worstDecision(decisions) {
  if (decisions.includes("REJECT")) return "REJECT";
  if (decisions.includes("REPAIR")) return "REPAIR";
  return "PASS";
}

function retentionScore(scoreInputs, policy) {
  const blockers = [];
  let weighted = 0;
  for (const [id, dimension] of Object.entries(policy?.score_dimensions ?? {})) {
    const value = Number(scoreInputs?.[id]);
    if (!integerBetween(value, 1, 10)) blockers.push(`winner_gate_retention_score_${id}_invalid`);
    else {
      weighted += (value / 10) * Number(dimension.weight);
      if (value < Number(dimension.minimum)) blockers.push(`winner_gate_retention_score_${id}_below_minimum`);
    }
  }
  return { weighted: Number(weighted.toFixed(2)), blockers };
}

function validateRetentionArchitecture(retention, {
  scriptWordCount,
  intendedSpokenWpm,
  policy,
}) {
  const blockers = [];
  pushIf(blockers, !retention || typeof retention !== "object", "winner_gate_retention_architecture_missing");
  if (!retention || typeof retention !== "object") return { blockers, decision: null };
  const decision = retention.decision;
  pushIf(blockers, !["PASS", "REPAIR", "REJECT"].includes(decision), "winner_gate_retention_decision_invalid");
  const score = retentionScore(retention.score_inputs, policy);
  blockers.push(...score.blockers);
  pushIf(blockers, Math.abs(Number(retention.weighted_score) - score.weighted) > 0.01, "winner_gate_retention_weighted_score_mismatch");
  pushIf(blockers, decision === "PASS" && score.weighted < Number(policy?.minimum_total_score ?? 85), "winner_gate_retention_weighted_score_below_minimum");

  const checkpoints = Array.isArray(retention.checkpoints) ? retention.checkpoints : [];
  const requiredCheckpointIds = policy?.required_checkpoint_ids ?? WINNER_RETENTION_CHECKPOINT_IDS;
  const checkpointById = new Map(checkpoints.map((row) => [row?.id, row]));
  pushIf(blockers, checkpoints.length !== requiredCheckpointIds.length, "winner_gate_retention_checkpoint_count_invalid");
  const maxWordByCheckpoint = {
    title_contradiction_30s: Math.ceil(intendedSpokenWpm * 0.65),
    irreversible_boundary_minute_5: Math.ceil(intendedSpokenWpm * 5.5),
    advantage_proof_minute_8: Math.ceil(intendedSpokenWpm * 8.5),
    forward_objective_minute_10: Math.ceil(intendedSpokenWpm * 10.5),
  };
  for (const id of requiredCheckpointIds) {
    const row = checkpointById.get(id);
    pushIf(blockers, !row, `winner_gate_retention_checkpoint_${id}_missing`);
    if (!row) continue;
    pushIf(blockers, !["PASS", "REPAIR", "REJECT"].includes(row.decision), `winner_gate_retention_checkpoint_${id}_decision_invalid`);
    pushIf(blockers, decision === "PASS" && row.decision !== "PASS", `winner_gate_retention_checkpoint_${id}_not_passed`);
    const start = Number(row.word_start);
    const end = Number(row.word_end);
    pushIf(blockers, !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > scriptWordCount, `winner_gate_retention_checkpoint_${id}_range_invalid`);
    pushIf(blockers, !nonEmpty(row.event), `winner_gate_retention_checkpoint_${id}_event_missing`);
    pushIf(blockers, !nonEmpty(row.retention_function), `winner_gate_retention_checkpoint_${id}_function_missing`);
    if (Number.isFinite(maxWordByCheckpoint[id])) {
      pushIf(blockers, end > maxWordByCheckpoint[id], `winner_gate_retention_checkpoint_${id}_late`);
    }
  }

  const movements = Array.isArray(retention.movements) ? retention.movements : [];
  const minimumMovements = Number(policy?.movement_count_min ?? 8);
  const maximumMovements = Number(policy?.movement_count_max ?? 10);
  pushIf(blockers, movements.length < minimumMovements || movements.length > maximumMovements, "winner_gate_retention_movement_count_invalid");
  const seenMovementIds = new Set();
  let expectedStart = 1;
  for (const [index, movement] of movements.entries()) {
    const id = String(movement?.id ?? "").trim();
    pushIf(blockers, !/^movement_\d{2}$/.test(id), `winner_gate_retention_movement_${index}_id_invalid`);
    pushIf(blockers, seenMovementIds.has(id), `winner_gate_retention_movement_${index}_id_duplicate`);
    seenMovementIds.add(id);
    const start = Number(movement?.word_start);
    const end = Number(movement?.word_end);
    pushIf(blockers, !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > scriptWordCount, `winner_gate_retention_movement_${index}_range_invalid`);
    pushIf(blockers, start !== expectedStart, `winner_gate_retention_movement_${index}_coverage_gap_or_overlap`);
    if (Number.isInteger(end)) expectedStart = end + 1;
    const movementPercent = scriptWordCount > 0 && Number.isInteger(start) && Number.isInteger(end)
      ? ((end - start + 1) / scriptWordCount) * 100
      : Number.POSITIVE_INFINITY;
    pushIf(blockers, movementPercent > Number(policy?.movement_max_script_percent ?? 18), `winner_gate_retention_movement_${index}_too_long`);
    for (const field of ["objective", "pressure_or_question", "joey_choice", "result", "cause_into_next", "unique_function"]) {
      pushIf(blockers, !nonEmpty(movement?.[field]), `winner_gate_retention_movement_${index}_${field}_missing`);
    }
    pushIf(blockers, !Array.isArray(movement?.state_changes) || movement.state_changes.filter(nonEmpty).length < 2, `winner_gate_retention_movement_${index}_state_changes_too_thin`);
    pushIf(blockers, decision === "PASS" && movement?.duplicate_of != null, `winner_gate_retention_movement_${index}_duplicate`);
  }
  pushIf(blockers, movements.length > 0 && expectedStart !== scriptWordCount + 1, "winner_gate_retention_movement_coverage_incomplete");

  const scalingPressureWord = Number(retention.scaling_pressure_word_start);
  const adaptiveResponseWord = Number(retention.adaptive_response_word_start);
  pushIf(blockers, !Number.isInteger(scalingPressureWord) || scalingPressureWord < 1 || scalingPressureWord > scriptWordCount, "winner_gate_retention_scaling_pressure_position_invalid");
  pushIf(blockers, !Number.isInteger(adaptiveResponseWord) || adaptiveResponseWord <= scalingPressureWord || adaptiveResponseWord > scriptWordCount, "winner_gate_retention_adaptive_response_position_invalid");
  const climaxWord = Number(retention.climax_word_start);
  const computedClimaxPercent = scriptWordCount > 0 && Number.isInteger(climaxWord) ? Number(((climaxWord / scriptWordCount) * 100).toFixed(2)) : null;
  pushIf(blockers, !Number.isInteger(climaxWord) || climaxWord < 1 || climaxWord > scriptWordCount, "winner_gate_retention_climax_position_invalid");
  pushIf(blockers, computedClimaxPercent == null || Math.abs(Number(retention.climax_start_percent) - computedClimaxPercent) > 0.15, "winner_gate_retention_climax_percent_mismatch");
  pushIf(blockers, decision === "PASS" && (computedClimaxPercent < Number(policy?.climax_start_percent_min ?? 86) || computedClimaxPercent > Number(policy?.climax_start_percent_max ?? 92)), "winner_gate_retention_climax_out_of_window");
  const resolutionWord = Number(retention.resolution_word_start);
  const computedResolutionCount = Number.isInteger(resolutionWord) ? scriptWordCount - resolutionWord + 1 : null;
  const computedResolutionPercent = computedResolutionCount != null && scriptWordCount > 0 ? Number(((computedResolutionCount / scriptWordCount) * 100).toFixed(2)) : null;
  pushIf(blockers, !Number.isInteger(resolutionWord) || resolutionWord <= climaxWord || resolutionWord > scriptWordCount, "winner_gate_retention_resolution_position_invalid");
  pushIf(blockers, Number(retention.resolution_word_count) !== computedResolutionCount, "winner_gate_retention_resolution_word_count_mismatch");
  pushIf(blockers, computedResolutionPercent == null || Math.abs(Number(retention.resolution_script_percent) - computedResolutionPercent) > 0.15, "winner_gate_retention_resolution_percent_mismatch");
  pushIf(blockers, decision === "PASS" && computedResolutionPercent > Number(policy?.resolution_script_percent_max ?? 8), "winner_gate_retention_resolution_too_long");
  const risks = Array.isArray(retention.retention_risks) ? retention.retention_risks : [];
  for (const [index, risk] of risks.entries()) {
    pushIf(blockers, !["low", "medium", "fatal"].includes(risk?.severity), `winner_gate_retention_risk_${index}_severity_invalid`);
    pushIf(blockers, !nonEmpty(risk?.code) || !nonEmpty(risk?.note), `winner_gate_retention_risk_${index}_incomplete`);
  }
  pushIf(blockers, decision === "PASS" && risks.some((row) => row?.severity === "fatal"), "winner_gate_retention_pass_has_fatal_risk");
  pushIf(blockers, !nonEmpty(retention.summary), "winner_gate_retention_summary_missing");
  return { blockers, decision, computed_weighted_score: score.weighted };
}

export function validateWinnerScriptGate(gate, { scriptWordCount, formula = null, intendedSpokenWpm = null }) {
  const blockers = [];
  pushIf(blockers, gate?.schema !== WINNER_SCRIPT_GATE_SCHEMA, "winner_gate_schema_invalid");
  pushIf(blockers, !["PASS", "REPAIR", "REJECT"].includes(gate?.status), "winner_gate_status_invalid");
  const gates = Array.isArray(gate?.gates) ? gate.gates : [];
  pushIf(blockers, gates.length !== WINNER_GATE_IDS.length, "winner_gate_count_invalid");
  const byId = new Map(gates.map((row) => [row?.id, row]));
  const decisions = [];
  for (const id of WINNER_GATE_IDS) {
    const row = byId.get(id);
    pushIf(blockers, !row, `winner_gate_${id}_missing`);
    if (!row) continue;
    const decision = row.decision;
    pushIf(blockers, !["PASS", "REPAIR", "REJECT"].includes(decision), `winner_gate_${id}_decision_invalid`);
    decisions.push(decision);
    const evidence = Array.isArray(row.evidence) ? row.evidence : [];
    pushIf(blockers, evidence.length < 2, `winner_gate_${id}_evidence_too_thin`);
    for (const [index, item] of evidence.entries()) {
      const start = Number(item?.word_start);
      const end = Number(item?.word_end);
      pushIf(blockers, !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > scriptWordCount, `winner_gate_${id}_evidence_${index}_range_invalid`);
      pushIf(blockers, !nonEmpty(item?.note), `winner_gate_${id}_evidence_${index}_note_missing`);
    }
    if (decision === "PASS") pushIf(blockers, Array.isArray(row.repair_actions) && row.repair_actions.length > 0, `winner_gate_${id}_pass_has_repairs`);
  }
  const packageFidelity = gate?.package_fidelity ?? {};
  const packageDecision = packageFidelity.decision;
  pushIf(blockers, !["PASS", "REPAIR", "REJECT"].includes(packageDecision), "winner_gate_package_fidelity_decision_invalid");
  if (["PASS", "REPAIR", "REJECT"].includes(packageDecision)) decisions.push(packageDecision);
  for (const field of [
    "title_facts_literal",
    "thumbnail_claims_literal",
    "opening_promise_delivered",
    "boundary_delivered",
    "forward_engine_delivered",
    "active_climax_delivered",
    "antagonist_loss_delivered",
    "concise_ending_delivered",
  ]) {
    pushIf(blockers, typeof packageFidelity[field] !== "boolean", `winner_gate_package_${field}_missing`);
    if (gate?.status === "PASS") pushIf(blockers, packageFidelity[field] !== true, `winner_gate_package_${field}_not_passed`);
  }
  const retentionPolicy = formula?.retention_architecture ?? {
    minimum_total_score: 85,
    movement_count_min: 8,
    movement_count_max: 10,
    movement_max_script_percent: 18,
    climax_start_percent_min: 86,
    climax_start_percent_max: 92,
    resolution_script_percent_max: 8,
    required_checkpoint_ids: WINNER_RETENTION_CHECKPOINT_IDS,
    score_dimensions: {
      opening_and_ten_minute_payoff_map: { weight: 15, minimum: 7 },
      clear_advantage_rule_and_scaling_path: { weight: 15, minimum: 7 },
      joey_agency_and_audience_trust: { weight: 15, minimum: 7 },
      causal_movement_runway: { weight: 20, minimum: 7 },
      conflict_variety_and_procedure_restraint: { weight: 10, minimum: 7 },
      intelligent_opposition_and_scaling_pressure: { weight: 10, minimum: 7 },
      active_title_native_climax: { weight: 10, minimum: 7 },
      concise_closure: { weight: 5, minimum: 7 },
    },
  };
  const retentionValidation = validateRetentionArchitecture(gate?.retention_architecture, {
    scriptWordCount,
    intendedSpokenWpm: Number(intendedSpokenWpm ?? formula?.candidate_policy?.target_spoken_wpm ?? 187.5),
    policy: retentionPolicy,
  });
  blockers.push(...retentionValidation.blockers);
  if (["PASS", "REPAIR", "REJECT"].includes(retentionValidation.decision)) decisions.push(retentionValidation.decision);
  const expectedStatus = worstDecision(decisions);
  pushIf(blockers, gate?.status !== expectedStatus, `winner_gate_status_must_equal_${expectedStatus}`);
  if (gate?.status === "PASS") {
    pushIf(blockers, (gate?.hard_rejects ?? []).length > 0, "winner_gate_pass_has_hard_rejects");
    pushIf(blockers, (gate?.repairs ?? []).length > 0, "winner_gate_pass_has_repairs");
    pushIf(blockers, !["review_only_no_strong_concern", "eligible_for_operator_release"].includes(gate?.release_recommendation), "winner_gate_pass_release_recommendation_invalid");
  }
  return { done: blockers.length === 0, blockers, expected_status: expectedStatus };
}

export function validateWinnerSourceRelease(release, { sourceText = null, packageContract = null } = {}) {
  const blockers = [];
  pushIf(blockers, release?.schema !== WINNER_SOURCE_RELEASE_SCHEMA, "winner_release_schema_invalid");
  pushIf(blockers, release?.status !== "passed", "winner_release_not_passed");
  for (const field of [
    "channel", "development_slug", "selected_title", "source_path", "source_script_sha256",
    "winner_package_sha256", "released_by", "released_at",
  ]) pushIf(blockers, !nonEmpty(release?.[field]), `winner_release_${field}_missing`);
  if (sourceText != null) {
    pushIf(blockers, sha256Text(normalizeWinnerNarration(sourceText)) !== release?.source_script_sha256, "winner_release_source_hash_mismatch");
  }
  if (packageContract) {
    pushIf(blockers, release?.channel !== packageContract.channel, "winner_release_channel_mismatch");
    pushIf(blockers, release?.selected_title !== packageContract.selected_title, "winner_release_title_mismatch");
  }
  return { done: blockers.length === 0, blockers };
}
