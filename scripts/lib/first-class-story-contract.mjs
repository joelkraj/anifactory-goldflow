import { createHash } from "node:crypto";

export const FIRST_CLASS_STORY_ROOM_PROFILE_V4 = "first_class_story_room_v4";
export const PREMISE_POOL_V3_SCHEMA = "goldflow_premise_pool_v3";
export const PREMISE_BLIND_SELECTION_V3_SCHEMA = "goldflow_premise_blind_selection_v3";
export const STORY_TRUTH_IR_SCHEMA = "goldflow_story_truth_ir_v1";
export const STORY_TRUTH_IR_SCHEMA_V2 = "goldflow_story_truth_ir_v2";
export const STORY_TRUTH_AUDIT_SCHEMA = "goldflow_story_truth_audit_v1";
export const STORY_TRUTH_SCRIPT_MAP_SCHEMA = "goldflow_story_truth_script_map_v1";
export const STORY_TRUTH_SCRIPT_MAP_SCHEMA_V2 = "goldflow_story_truth_script_map_v2";
export const LONGFORM_DRAFT_PORTFOLIO_SCHEMA = "goldflow_longform_draft_portfolio_v1";
export const NARRATION_REVISION_LEDGER_SCHEMA = "goldflow_narration_revision_ledger_v1";

export const STORY_DIAGNOSTIC_IDS = Object.freeze([
  "causality_learning",
  "promise_continuity",
  "narrative_authenticity",
  "opening_stress",
  "character_agency",
  "anti_slop",
]);

const PROMISE_SOURCES = new Set(["title", "thumbnail", "premise", "treatment"]);
const STATE_TYPES = new Set([
  "injury",
  "resource",
  "possession",
  "authority",
  "location",
  "knowledge",
  "relationship",
  "identity",
  "public_status",
  "mechanic",
]);
const RETENTION_OBLIGATION_TYPES = new Set([
  "open_loop",
  "promise",
  "question",
  "threat",
  "relationship_pressure",
  "fantasy_payoff",
]);
const MOVEMENT_DIMENSIONS = new Set([
  "goal",
  "danger",
  "power",
  "relationship",
  "mystery",
  "status",
  "choice",
  "consequence",
  "payoff",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

export function sha256CanonicalStoryJson(value) {
  return sha256(Buffer.from(JSON.stringify(canonicalJson(value)), "utf8"));
}

function nonEmpty(value) {
  return Boolean(String(value ?? "").trim());
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/i.test(String(value ?? ""));
}

function unique(values) {
  return new Set(values).size === values.length;
}

function pushIf(blockers, condition, code) {
  if (condition) blockers.push(code);
}

function integerInRange(value, minimum, maximum) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum;
}

function objectRows(value) {
  return Array.isArray(value) ? value : [];
}

export function validatePremisePoolV3(document, {
  gptSlate = null,
  gptSlateSha256 = null,
  geminiSlate = null,
  geminiSlateSha256 = null,
  evidenceRegistrySha256 = null,
} = {}) {
  const blockers = [];
  pushIf(blockers, document?.schema !== PREMISE_POOL_V3_SCHEMA, "premise_pool_v3_schema_invalid");
  pushIf(blockers, document?.status !== "pooled", "premise_pool_v3_not_pooled");
  if (evidenceRegistrySha256) {
    pushIf(blockers, document?.evidence_registry_sha256 !== evidenceRegistrySha256, "premise_pool_v3_evidence_hash_mismatch");
  }
  if (gptSlateSha256) pushIf(blockers, document?.author_slate_sha256s?.gpt_web !== gptSlateSha256, "premise_pool_v3_gpt_slate_hash_mismatch");
  if (geminiSlateSha256) pushIf(blockers, document?.author_slate_sha256s?.gemini_web !== geminiSlateSha256, "premise_pool_v3_gemini_slate_hash_mismatch");

  const expected = [
    ...objectRows(gptSlate?.candidates).map((candidate) => ({ author: "gpt_web", candidate })),
    ...objectRows(geminiSlate?.candidates).map((candidate) => ({ author: "gemini_web", candidate })),
  ];
  const candidates = objectRows(document?.candidates);
  pushIf(blockers, expected.length !== 12, "premise_pool_v3_expected_candidate_count_not_12");
  pushIf(blockers, candidates.length !== 12, `premise_pool_v3_candidate_count_${candidates.length}_not_12`);
  const sourceIds = candidates.map((row) => String(row?.source_candidate_id ?? "").trim());
  const blindIds = candidates.map((row) => String(row?.blind_id ?? "").trim());
  pushIf(blockers, !unique(sourceIds), "premise_pool_v3_source_ids_duplicate");
  pushIf(blockers, !unique(blindIds), "premise_pool_v3_blind_ids_duplicate");
  const expectedBySourceId = new Map(expected.map(({ author, candidate }) => [
    `${author}:${candidate?.id}`,
    { author, candidate },
  ]));
  for (const [index, row] of candidates.entries()) {
    const expectedRow = expectedBySourceId.get(row?.source_candidate_id);
    pushIf(blockers, !expectedRow, `premise_pool_v3_candidate_${index}_source_unknown`);
    pushIf(blockers, !/^blind_[a-l]$/.test(String(row?.blind_id ?? "")), `premise_pool_v3_candidate_${index}_blind_id_invalid`);
    pushIf(blockers, !isSha256(row?.candidate_sha256), `premise_pool_v3_candidate_${index}_hash_invalid`);
    pushIf(blockers, !row?.candidate || typeof row.candidate !== "object" || Array.isArray(row.candidate), `premise_pool_v3_candidate_${index}_payload_missing`);
    if (expectedRow) {
      pushIf(blockers, row?.author !== expectedRow.author, `premise_pool_v3_candidate_${index}_author_mismatch`);
      pushIf(blockers, row?.candidate_sha256 !== sha256CanonicalStoryJson(expectedRow.candidate), `premise_pool_v3_candidate_${index}_hash_mismatch`);
      pushIf(blockers, sha256CanonicalStoryJson(row?.candidate) !== row?.candidate_sha256, `premise_pool_v3_candidate_${index}_payload_mismatch`);
    }
  }
  return { done: blockers.length === 0, blockers };
}

export function validatePremiseBlindSelectionV3(document, {
  premisePool = null,
  premisePoolSha256 = null,
  evidenceRegistrySha256 = null,
  requireOneFinalistPerPremiseMovie = false,
} = {}) {
  const blockers = [];
  pushIf(blockers, document?.schema !== PREMISE_BLIND_SELECTION_V3_SCHEMA, "premise_blind_selection_v3_schema_invalid");
  pushIf(blockers, !["selected", "rejected"].includes(document?.status), "premise_blind_selection_v3_status_invalid");
  if (premisePoolSha256) pushIf(blockers, document?.premise_pool_sha256 !== premisePoolSha256, "premise_blind_selection_v3_pool_hash_mismatch");
  if (evidenceRegistrySha256) pushIf(blockers, document?.evidence_registry_sha256 !== evidenceRegistrySha256, "premise_blind_selection_v3_evidence_hash_mismatch");
  const eligibleIds = new Set(objectRows(premisePool?.candidates).map((row) => row?.blind_id).filter(nonEmpty));
  const finalists = objectRows(document?.finalist_blind_ids);
  pushIf(blockers, document?.status === "selected" && finalists.length !== 6, "premise_blind_selection_v3_finalist_count_not_6");
  pushIf(blockers, document?.status === "rejected" && finalists.length !== 0, "premise_blind_selection_v3_rejected_finalists_not_empty");
  pushIf(blockers, !unique(finalists), "premise_blind_selection_v3_finalists_duplicate");
  for (const id of finalists) pushIf(blockers, !eligibleIds.has(id), `premise_blind_selection_v3_finalist_${id}_unknown`);
  if (requireOneFinalistPerPremiseMovie && document?.status === "selected") {
    const rowsByBlindId = new Map(objectRows(premisePool?.candidates).map((row) => [row?.blind_id, row]));
    const expectedMovieIds = [...new Set(objectRows(premisePool?.candidates)
      .map((row) => row?.candidate?.source_premise_movie?.blind_id)
      .filter(nonEmpty))];
    const finalistMovieIds = finalists
      .map((blindId) => rowsByBlindId.get(blindId)?.candidate?.source_premise_movie?.blind_id)
      .filter(nonEmpty);
    pushIf(blockers, expectedMovieIds.length !== 6, "premise_blind_selection_v3_source_movie_count_not_6");
    pushIf(blockers, finalistMovieIds.length !== finalists.length, "premise_blind_selection_v3_finalist_source_movie_missing");
    pushIf(blockers, !unique(finalistMovieIds), "premise_blind_selection_v3_finalist_source_movies_duplicate");
    pushIf(
      blockers,
      JSON.stringify([...finalistMovieIds].sort()) !== JSON.stringify([...expectedMovieIds].sort()),
      "premise_blind_selection_v3_finalist_source_movies_incomplete",
    );
  }
  if (document?.status === "selected") {
    pushIf(blockers, !finalists.includes(document?.selected_blind_id), "premise_blind_selection_v3_selected_not_finalist");
    pushIf(blockers, document?.rejection_reason !== null, "premise_blind_selection_v3_selected_rejection_reason_not_null");
  } else {
    pushIf(blockers, document?.selected_blind_id !== null, "premise_blind_selection_v3_rejected_selected_not_null");
    pushIf(blockers, !nonEmpty(document?.rejection_reason), "premise_blind_selection_v3_rejection_reason_missing");
  }
  pushIf(blockers, !nonEmpty(document?.selection_rationale), "premise_blind_selection_v3_rationale_missing");
  const rankings = objectRows(document?.rankings);
  pushIf(blockers, rankings.length !== eligibleIds.size, "premise_blind_selection_v3_ranking_count_mismatch");
  const rankedIds = rankings.map((row) => row?.blind_id);
  pushIf(blockers, !unique(rankedIds), "premise_blind_selection_v3_ranking_ids_duplicate");
  for (const [index, row] of rankings.entries()) {
    pushIf(blockers, !eligibleIds.has(row?.blind_id), `premise_blind_selection_v3_ranking_${index}_unknown`);
    pushIf(blockers, !integerInRange(row?.rank, 1, eligibleIds.size), `premise_blind_selection_v3_ranking_${index}_rank_invalid`);
    for (const field of ["click_judgment", "runway_judgment", "decisive_reason"]) {
      pushIf(blockers, !nonEmpty(row?.[field]), `premise_blind_selection_v3_ranking_${index}_${field}_missing`);
    }
  }
  return { done: blockers.length === 0, blockers };
}

export function validateStoryTruthIr(document, {
  packageSha256 = null,
  selectedTreatmentSha256 = null,
  architectureSha256 = null,
  architecture = null,
} = {}) {
  const blockers = [];
  const qualityV2 = document?.schema === STORY_TRUTH_IR_SCHEMA_V2;
  pushIf(blockers, ![STORY_TRUTH_IR_SCHEMA, STORY_TRUTH_IR_SCHEMA_V2].includes(document?.schema), "story_truth_ir_schema_invalid");
  pushIf(blockers, document?.status !== "locked", "story_truth_ir_not_locked");
  if (packageSha256) pushIf(blockers, document?.package_sha256 !== packageSha256, "story_truth_ir_package_hash_mismatch");
  if (selectedTreatmentSha256) pushIf(blockers, document?.selected_treatment_sha256 !== selectedTreatmentSha256, "story_truth_ir_treatment_hash_mismatch");
  if (architectureSha256) pushIf(blockers, document?.architecture_sha256 !== architectureSha256, "story_truth_ir_architecture_hash_mismatch");
  const movementIds = new Set(objectRows(architecture?.movements).map((row) => row?.id).filter(nonEmpty));
  const checkMovement = (id, code) => pushIf(blockers, !movementIds.has(id), code);

  const promises = objectRows(document?.promises);
  pushIf(blockers, promises.length < 2, "story_truth_ir_promises_below_2");
  const promiseIds = promises.map((row) => String(row?.id ?? "").trim());
  pushIf(blockers, !unique(promiseIds), "story_truth_ir_promise_ids_duplicate");
  pushIf(blockers, !promises.some((row) => row?.source === "title"), "story_truth_ir_title_promise_missing");
  pushIf(blockers, !promises.some((row) => row?.source === "thumbnail"), "story_truth_ir_thumbnail_promise_missing");
  for (const [index, row] of promises.entries()) {
    for (const field of ["id", "promise", "visible_receipt", "spark_movement_id", "first_proof_movement_id", "full_payoff_movement_id"]) {
      pushIf(blockers, !nonEmpty(row?.[field]), `story_truth_ir_promise_${index}_${field}_missing`);
    }
    pushIf(blockers, !PROMISE_SOURCES.has(row?.source), `story_truth_ir_promise_${index}_source_invalid`);
    pushIf(blockers, !integerInRange(row?.spark_deadline_word, 1, 650), `story_truth_ir_promise_${index}_spark_deadline_invalid`);
    pushIf(blockers, !integerInRange(row?.first_proof_deadline_word, Number(row?.spark_deadline_word ?? 0), 1_500), `story_truth_ir_promise_${index}_first_proof_deadline_invalid`);
    pushIf(blockers, !integerInRange(row?.full_payoff_deadline_word, Number(row?.first_proof_deadline_word ?? 0), 10_500), `story_truth_ir_promise_${index}_full_payoff_deadline_invalid`);
    for (const [field, suffix] of [["spark_movement_id", "spark"], ["first_proof_movement_id", "first_proof"], ["full_payoff_movement_id", "full_payoff"]]) {
      checkMovement(row?.[field], `story_truth_ir_promise_${index}_${suffix}_movement_unknown`);
    }
    pushIf(blockers, !Array.isArray(row?.escalation_movement_ids), `story_truth_ir_promise_${index}_escalations_missing`);
    for (const movementId of row?.escalation_movement_ids ?? []) checkMovement(movementId, `story_truth_ir_promise_${index}_escalation_${movementId}_unknown`);
  }

  const causalChains = objectRows(document?.causal_chains);
  pushIf(blockers, causalChains.length < Math.max(6, Math.ceil(movementIds.size / 2)), "story_truth_ir_causal_chains_too_few");
  const causalIds = causalChains.map((row) => String(row?.id ?? "").trim());
  pushIf(blockers, !unique(causalIds), "story_truth_ir_causal_chain_ids_duplicate");
  for (const [index, row] of causalChains.entries()) {
    for (const field of ["id", "pressure", "choice", "consequence", "counter", "changed_situation"]) {
      pushIf(blockers, !nonEmpty(row?.[field]), `story_truth_ir_causal_chain_${index}_${field}_missing`);
    }
    pushIf(blockers, row?.owned_choice !== true, `story_truth_ir_causal_chain_${index}_not_owned_choice`);
    const ids = objectRows(row?.movement_ids);
    pushIf(blockers, ids.length < 1, `story_truth_ir_causal_chain_${index}_movement_ids_missing`);
    for (const movementId of ids) checkMovement(movementId, `story_truth_ir_causal_chain_${index}_movement_${movementId}_unknown`);
  }

  const agency = objectRows(document?.character_agency);
  pushIf(blockers, agency.length < 2, "story_truth_ir_character_agency_below_2");
  pushIf(blockers, !unique(agency.map((row) => String(row?.id ?? "").trim())), "story_truth_ir_character_agency_ids_duplicate");
  for (const [index, row] of agency.entries()) {
    for (const field of ["id", "character", "desire", "pressure", "decision", "alternative_rejected", "consequence", "movement_id"]) {
      pushIf(blockers, !nonEmpty(row?.[field]), `story_truth_ir_agency_${index}_${field}_missing`);
    }
    checkMovement(row?.movement_id, `story_truth_ir_agency_${index}_movement_unknown`);
  }

  const setupPayoffs = objectRows(document?.setup_payoffs);
  pushIf(blockers, setupPayoffs.length < 4, "story_truth_ir_setup_payoffs_below_4");
  pushIf(blockers, !unique(setupPayoffs.map((row) => String(row?.id ?? "").trim())), "story_truth_ir_setup_payoff_ids_duplicate");
  for (const [index, row] of setupPayoffs.entries()) {
    for (const field of ["id", "setup", "setup_movement_id", "payoff", "payoff_movement_id"]) {
      pushIf(blockers, !nonEmpty(row?.[field]), `story_truth_ir_setup_payoff_${index}_${field}_missing`);
    }
    checkMovement(row?.setup_movement_id, `story_truth_ir_setup_payoff_${index}_setup_movement_unknown`);
    checkMovement(row?.payoff_movement_id, `story_truth_ir_setup_payoff_${index}_payoff_movement_unknown`);
    pushIf(blockers, !integerInRange(row?.payoff_deadline_word, 1, 10_500), `story_truth_ir_setup_payoff_${index}_deadline_invalid`);
    pushIf(blockers, !["none", "deliberate_live"].includes(row?.deferral), `story_truth_ir_setup_payoff_${index}_deferral_invalid`);
    pushIf(blockers, row?.deferral === "deliberate_live" && !nonEmpty(row?.deferral_reason), `story_truth_ir_setup_payoff_${index}_deferral_reason_missing`);
  }

  const mechanics = objectRows(document?.mechanic_rules);
  pushIf(blockers, mechanics.length < 1, "story_truth_ir_mechanic_rules_missing");
  pushIf(blockers, !unique(mechanics.map((row) => String(row?.id ?? "").trim())), "story_truth_ir_mechanic_ids_duplicate");
  for (const [index, row] of mechanics.entries()) {
    for (const field of ["id", "spoken_name", "trigger_or_input", "observable_output", "limit_or_cost", "provenance", "first_clear_movement_id"]) {
      pushIf(blockers, !nonEmpty(row?.[field]), `story_truth_ir_mechanic_${index}_${field}_missing`);
    }
    checkMovement(row?.first_clear_movement_id, `story_truth_ir_mechanic_${index}_movement_unknown`);
  }

  const transitions = objectRows(document?.state_transitions);
  pushIf(blockers, transitions.length < 6, "story_truth_ir_state_transitions_too_few");
  pushIf(blockers, !unique(transitions.map((row) => String(row?.id ?? "").trim())), "story_truth_ir_state_transition_ids_duplicate");
  for (const [index, row] of transitions.entries()) {
    for (const field of ["id", "subject", "from", "to", "cause", "movement_id"]) {
      pushIf(blockers, !nonEmpty(row?.[field]), `story_truth_ir_state_${index}_${field}_missing`);
    }
    pushIf(blockers, !STATE_TYPES.has(row?.state_type), `story_truth_ir_state_${index}_type_invalid`);
    checkMovement(row?.movement_id, `story_truth_ir_state_${index}_movement_unknown`);
  }

  const reveals = objectRows(document?.reveals);
  pushIf(blockers, reveals.length < 2, "story_truth_ir_reveals_below_2");
  pushIf(blockers, !unique(reveals.map((row) => String(row?.id ?? "").trim())), "story_truth_ir_reveal_ids_duplicate");
  for (const [index, row] of reveals.entries()) {
    for (const field of ["id", "knowledge", "knower_before", "knower_after", "movement_id", "behavior_change"]) {
      pushIf(blockers, !nonEmpty(row?.[field]), `story_truth_ir_reveal_${index}_${field}_missing`);
    }
    checkMovement(row?.movement_id, `story_truth_ir_reveal_${index}_movement_unknown`);
  }

  if (qualityV2) {
    const knownTruthIds = new Set([
      ...promiseIds,
      ...causalIds,
      ...agency.map((row) => row?.id),
      ...setupPayoffs.map((row) => row?.id),
      ...mechanics.map((row) => row?.id),
      ...transitions.map((row) => row?.id),
      ...reveals.map((row) => row?.id),
    ].filter(nonEmpty));
    const retention = objectRows(document?.retention_obligations);
    pushIf(blockers, retention.length < promises.length, "story_truth_ir_retention_obligations_too_few");
    const retentionIds = retention.map((row) => String(row?.id ?? "").trim());
    pushIf(blockers, !unique(retentionIds), "story_truth_ir_retention_obligation_ids_duplicate");
    for (const [index, row] of retention.entries()) {
      for (const field of [
        "id", "obligation", "open_movement_id", "closure_movement_id",
        "visible_or_spoken_receipt",
      ]) pushIf(blockers, !nonEmpty(row?.[field]), `story_truth_ir_retention_${index}_${field}_missing`);
      pushIf(blockers, !RETENTION_OBLIGATION_TYPES.has(row?.type), `story_truth_ir_retention_${index}_type_invalid`);
      pushIf(blockers, !integerInRange(row?.open_deadline_word, 1, 10_500), `story_truth_ir_retention_${index}_open_deadline_invalid`);
      pushIf(blockers, !integerInRange(row?.closure_deadline_word, Number(row?.open_deadline_word ?? 0), 10_500), `story_truth_ir_retention_${index}_closure_deadline_invalid`);
      checkMovement(row?.open_movement_id, `story_truth_ir_retention_${index}_open_movement_unknown`);
      checkMovement(row?.closure_movement_id, `story_truth_ir_retention_${index}_closure_movement_unknown`);
      const developmentIds = objectRows(row?.development_movement_ids);
      pushIf(blockers, developmentIds.length < 1, `story_truth_ir_retention_${index}_development_movements_missing`);
      for (const movementId of developmentIds) checkMovement(movementId, `story_truth_ir_retention_${index}_development_movement_${movementId}_unknown`);
      const sourceTruthIds = objectRows(row?.source_truth_ids);
      pushIf(blockers, sourceTruthIds.length < 1, `story_truth_ir_retention_${index}_source_truth_ids_missing`);
      for (const truthId of sourceTruthIds) {
        pushIf(blockers, !knownTruthIds.has(truthId), `story_truth_ir_retention_${index}_source_truth_${truthId}_unknown`);
      }
      if (row?.replacement_obligation_id !== null && row?.replacement_obligation_id !== undefined) {
        pushIf(blockers, !nonEmpty(row?.replacement_obligation_id), `story_truth_ir_retention_${index}_replacement_id_invalid`);
      }
    }
    for (const [index, row] of retention.entries()) {
      if (nonEmpty(row?.replacement_obligation_id)) {
        pushIf(blockers, !retentionIds.includes(row.replacement_obligation_id), `story_truth_ir_retention_${index}_replacement_unknown`);
        pushIf(blockers, row.replacement_obligation_id === row.id, `story_truth_ir_retention_${index}_replacement_self_reference`);
      }
    }

    const movementQuality = objectRows(document?.movement_quality);
    const qualityMovementIds = movementQuality.map((row) => String(row?.movement_id ?? "").trim());
    pushIf(blockers, movementQuality.length !== movementIds.size, "story_truth_ir_movement_quality_count_mismatch");
    pushIf(blockers, !unique(qualityMovementIds), "story_truth_ir_movement_quality_movement_ids_duplicate");
    for (const movementId of movementIds) {
      pushIf(blockers, !qualityMovementIds.includes(movementId), `story_truth_ir_movement_quality_${movementId}_missing`);
    }
    let counterplayCount = 0;
    for (const [index, row] of movementQuality.entries()) {
      for (const field of ["id", "movement_id", "new_pressure_or_reward", "specific_evidence_or_object", "irreversible_consequence"]) {
        pushIf(blockers, !nonEmpty(row?.[field]), `story_truth_ir_movement_quality_${index}_${field}_missing`);
      }
      checkMovement(row?.movement_id, `story_truth_ir_movement_quality_${index}_movement_unknown`);
      const changedDimensions = objectRows(row?.changed_dimensions);
      pushIf(blockers, changedDimensions.length < 1, `story_truth_ir_movement_quality_${index}_changed_dimensions_missing`);
      pushIf(blockers, !unique(changedDimensions), `story_truth_ir_movement_quality_${index}_changed_dimensions_duplicate`);
      for (const dimension of changedDimensions) {
        pushIf(blockers, !MOVEMENT_DIMENSIONS.has(dimension), `story_truth_ir_movement_quality_${index}_dimension_${dimension}_invalid`);
      }
      pushIf(blockers, !["none", "low", "material"].includes(row?.redundant_explanation_risk), `story_truth_ir_movement_quality_${index}_redundancy_risk_invalid`);
      pushIf(blockers, !["none", "low", "material"].includes(row?.procedural_reporting_risk), `story_truth_ir_movement_quality_${index}_procedure_risk_invalid`);
      const counterplay = row?.antagonist_counterplay;
      pushIf(blockers, !counterplay || typeof counterplay !== "object" || Array.isArray(counterplay), `story_truth_ir_movement_quality_${index}_counterplay_missing`);
      pushIf(blockers, typeof counterplay?.applicable !== "boolean", `story_truth_ir_movement_quality_${index}_counterplay_applicable_invalid`);
      if (counterplay?.applicable === true) {
        counterplayCount += 1;
        for (const field of ["observer", "observation", "inference", "changed_tactic", "forced_choice"]) {
          pushIf(blockers, !nonEmpty(counterplay?.[field]), `story_truth_ir_movement_quality_${index}_counterplay_${field}_missing`);
        }
      } else {
        pushIf(blockers, !nonEmpty(counterplay?.not_applicable_reason), `story_truth_ir_movement_quality_${index}_counterplay_reason_missing`);
      }
    }
    pushIf(blockers, counterplayCount < Math.min(2, Math.max(1, Math.floor(movementIds.size / 4))), "story_truth_ir_antagonist_counterplay_too_sparse");

    const voices = objectRows(document?.character_voice_fingerprints);
    const agencyCharacters = new Set(agency.map((row) => String(row?.character ?? "").trim()).filter(nonEmpty));
    const voiceCharacters = voices.map((row) => String(row?.character ?? "").trim());
    pushIf(blockers, voices.length < Math.max(2, agencyCharacters.size), "story_truth_ir_character_voice_fingerprints_too_few");
    pushIf(blockers, !unique(voiceCharacters), "story_truth_ir_character_voice_characters_duplicate");
    for (const character of agencyCharacters) {
      pushIf(blockers, !voiceCharacters.includes(character), `story_truth_ir_character_voice_${character}_missing`);
    }
    for (const [index, row] of voices.entries()) {
      for (const field of [
        "id", "character", "role", "vocabulary", "sentence_shape",
        "emotional_avoidance", "humor", "values", "decision_style", "contrast_with",
      ]) pushIf(blockers, !nonEmpty(row?.[field]), `story_truth_ir_character_voice_${index}_${field}_missing`);
      const forbidden = objectRows(row?.forbidden_generic_modes);
      pushIf(blockers, forbidden.length < 2, `story_truth_ir_character_voice_${index}_forbidden_modes_too_few`);
    }
  }

  const narration = document?.narration_constraints;
  pushIf(blockers, !narration || typeof narration !== "object" || Array.isArray(narration), "story_truth_ir_narration_constraints_missing");
  for (const field of ["protected_facts", "spoken_clarity_rules", "pronunciation_risks"]) {
    pushIf(blockers, !Array.isArray(narration?.[field]), `story_truth_ir_narration_${field}_missing`);
  }
  return { done: blockers.length === 0, blockers };
}

export function validateStoryTruthAudit(document, {
  storyTruthIrSha256 = null,
} = {}) {
  const blockers = [];
  pushIf(blockers, document?.schema !== STORY_TRUTH_AUDIT_SCHEMA, "story_truth_audit_schema_invalid");
  pushIf(blockers, !["passed", "findings"].includes(document?.status), "story_truth_audit_status_invalid");
  if (storyTruthIrSha256) pushIf(blockers, document?.story_truth_ir_sha256 !== storyTruthIrSha256, "story_truth_audit_hash_mismatch");
  const findings = objectRows(document?.findings);
  pushIf(blockers, document?.status === "passed" && findings.length > 0, "story_truth_audit_passed_with_findings");
  pushIf(blockers, document?.status === "findings" && findings.length < 1, "story_truth_audit_findings_empty");
  for (const [index, row] of findings.entries()) {
    for (const field of ["id", "json_path", "defect", "downstream_risk", "smallest_repair_intent"]) {
      pushIf(blockers, !nonEmpty(row?.[field]), `story_truth_audit_finding_${index}_${field}_missing`);
    }
    pushIf(blockers, !["material", "critical"].includes(row?.severity), `story_truth_audit_finding_${index}_severity_invalid`);
  }
  return { done: blockers.length === 0, blockers };
}

export function validateStoryTruthScriptMap(document, {
  storyTruthIr = null,
  storyTruthIrSha256 = null,
  scriptText = "",
  scriptSha256 = null,
} = {}) {
  const blockers = [];
  const qualityV2 = document?.schema === STORY_TRUTH_SCRIPT_MAP_SCHEMA_V2;
  pushIf(blockers, ![STORY_TRUTH_SCRIPT_MAP_SCHEMA, STORY_TRUTH_SCRIPT_MAP_SCHEMA_V2].includes(document?.schema), "story_truth_script_map_schema_invalid");
  pushIf(blockers, storyTruthIr?.schema === STORY_TRUTH_IR_SCHEMA_V2 && !qualityV2, "story_truth_script_map_v2_required_for_story_truth_v2");
  pushIf(blockers, document?.status !== "mapped", "story_truth_script_map_not_mapped");
  if (storyTruthIrSha256) pushIf(blockers, document?.story_truth_ir_sha256 !== storyTruthIrSha256, "story_truth_script_map_truth_hash_mismatch");
  if (scriptSha256) pushIf(blockers, document?.script_sha256 !== scriptSha256, "story_truth_script_map_script_hash_mismatch");
  const collections = [
    "promises",
    "causal_chains",
    "character_agency",
    "setup_payoffs",
    "mechanic_rules",
    "state_transitions",
    "reveals",
    ...(qualityV2 ? ["retention_obligations", "movement_quality", "character_voice_fingerprints"] : []),
  ];
  const truthByCollection = new Map(collections.map((collection) => [collection, new Set(objectRows(storyTruthIr?.[collection]).map((row) => row?.id).filter(nonEmpty))]));
  const mappings = objectRows(document?.mappings);
  pushIf(blockers, mappings.length < 1, "story_truth_script_map_mappings_missing");
  const mapIds = mappings.map((row) => String(row?.map_id ?? "").trim());
  pushIf(blockers, !unique(mapIds), "story_truth_script_map_ids_duplicate");
  const coverage = new Map();
  for (const [index, row] of mappings.entries()) {
    for (const field of ["map_id", "truth_collection", "truth_id", "phase", "movement_id", "exact_text", "story_function"]) {
      pushIf(blockers, !nonEmpty(row?.[field]), `story_truth_script_map_${index}_${field}_missing`);
    }
    const ids = truthByCollection.get(row?.truth_collection);
    pushIf(blockers, !ids, `story_truth_script_map_${index}_collection_invalid`);
    pushIf(blockers, ids && !ids.has(row?.truth_id), `story_truth_script_map_${index}_truth_id_unknown`);
    const start = Number(row?.start_offset);
    const end = Number(row?.end_offset);
    pushIf(blockers, !Number.isInteger(start) || start < 0, `story_truth_script_map_${index}_start_invalid`);
    pushIf(blockers, !Number.isInteger(end) || end <= start || end > scriptText.length, `story_truth_script_map_${index}_end_invalid`);
    if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= scriptText.length) {
      pushIf(blockers, scriptText.slice(start, end) !== row?.exact_text, `story_truth_script_map_${index}_anchor_mismatch`);
    }
    const key = `${row?.truth_collection}:${row?.truth_id}`;
    if (!coverage.has(key)) coverage.set(key, new Set());
    coverage.get(key).add(row?.phase);
  }
  for (const [collection, ids] of truthByCollection.entries()) {
    for (const id of ids) {
      const phases = coverage.get(`${collection}:${id}`) ?? new Set();
      if (collection === "promises") {
        for (const phase of ["spark", "first_proof", "full_payoff"]) pushIf(blockers, !phases.has(phase), `story_truth_script_map_${collection}_${id}_${phase}_missing`);
      } else if (collection === "retention_obligations") {
        for (const phase of ["open", "development", "closure"]) pushIf(blockers, !phases.has(phase), `story_truth_script_map_${collection}_${id}_${phase}_missing`);
      } else if (collection === "character_voice_fingerprints") {
        pushIf(blockers, !phases.has("voice_proof"), `story_truth_script_map_${collection}_${id}_voice_proof_missing`);
      } else {
        pushIf(blockers, phases.size < 1, `story_truth_script_map_${collection}_${id}_missing`);
      }
    }
  }
  return { done: blockers.length === 0, blockers };
}

export function validateLongformDraftPortfolio(document, {
  packageSha256 = null,
  architectureSha256 = null,
  storyTruthIrSha256 = null,
  writerPacketSha256 = null,
  expectedCandidates = null,
} = {}) {
  const blockers = [];
  pushIf(blockers, document?.schema !== LONGFORM_DRAFT_PORTFOLIO_SCHEMA, "longform_draft_portfolio_schema_invalid");
  pushIf(blockers, document?.status !== "completed", "longform_draft_portfolio_not_completed");
  if (packageSha256) pushIf(blockers, document?.package_sha256 !== packageSha256, "longform_draft_portfolio_package_hash_mismatch");
  if (architectureSha256) pushIf(blockers, document?.architecture_sha256 !== architectureSha256, "longform_draft_portfolio_architecture_hash_mismatch");
  if (storyTruthIrSha256) pushIf(blockers, document?.story_truth_ir_sha256 !== storyTruthIrSha256, "longform_draft_portfolio_truth_hash_mismatch");
  if (writerPacketSha256) pushIf(blockers, document?.writer_packet_sha256 !== writerPacketSha256, "longform_draft_portfolio_writer_packet_hash_mismatch");
  const candidates = objectRows(document?.candidates);
  pushIf(blockers, candidates.length !== 6, `longform_draft_portfolio_candidate_count_${candidates.length}_not_6`);
  const ids = candidates.map((row) => String(row?.id ?? "").trim());
  const blindIds = candidates.map((row) => String(row?.blind_id ?? "").trim());
  pushIf(blockers, !unique(ids), "longform_draft_portfolio_ids_duplicate");
  pushIf(blockers, !unique(blindIds), "longform_draft_portfolio_blind_ids_duplicate");
  const expected = new Map(objectRows(expectedCandidates).map((row) => [row.id, row]));
  for (const [index, row] of candidates.entries()) {
    const spec = expected.get(row?.id);
    pushIf(blockers, expected.size > 0 && !spec, `longform_draft_portfolio_candidate_${index}_unexpected`);
    for (const field of ["id", "blind_id", "provider", "model", "reasoning_effort", "transport", "creative_lens", "output_path"]) {
      pushIf(blockers, !nonEmpty(row?.[field]), `longform_draft_portfolio_candidate_${index}_${field}_missing`);
    }
    for (const field of ["prompt_sha256", "output_sha256", "receipt_sha256"]) {
      pushIf(blockers, !isSha256(row?.[field]), `longform_draft_portfolio_candidate_${index}_${field}_invalid`);
    }
    if (row?.writer_output_path != null || row?.normalization != null) {
      for (const field of ["writer_output_path", "writer_receipt_path"]) {
        pushIf(blockers, !nonEmpty(row?.[field]), `longform_draft_portfolio_candidate_${index}_${field}_missing`);
      }
      for (const field of ["writer_output_sha256", "writer_receipt_sha256"]) {
        pushIf(blockers, !isSha256(row?.[field]), `longform_draft_portfolio_candidate_${index}_${field}_invalid`);
      }
      pushIf(blockers, !Number.isInteger(row?.writer_word_count) || row.writer_word_count < 1, `longform_draft_portfolio_candidate_${index}_writer_word_count_invalid`);
    }
    if (row?.normalization != null) {
      for (const field of ["provider", "model", "reasoning_effort", "visible_effort", "output_path", "receipt_path"]) {
        pushIf(blockers, !nonEmpty(row.normalization?.[field]), `longform_draft_portfolio_candidate_${index}_normalization_${field}_missing`);
      }
      pushIf(blockers, row.normalization?.reasoning_effort !== "medium", `longform_draft_portfolio_candidate_${index}_normalization_effort_not_medium`);
      pushIf(blockers, !isSha256(row.normalization?.prompt_sha256), `longform_draft_portfolio_candidate_${index}_normalization_prompt_sha256_invalid`);
      pushIf(blockers, row.normalization?.output_path !== row?.output_path, `longform_draft_portfolio_candidate_${index}_normalization_output_path_mismatch`);
      pushIf(blockers, row.normalization?.receipt_path !== row?.receipt_path, `longform_draft_portfolio_candidate_${index}_normalization_receipt_path_mismatch`);
    }
    pushIf(blockers, !Number.isInteger(row?.word_count) || row.word_count < 1, `longform_draft_portfolio_candidate_${index}_word_count_invalid`);
    pushIf(blockers, row?.word_count_target?.enforcement !== "advisory", `longform_draft_portfolio_candidate_${index}_word_count_target_not_advisory`);
    pushIf(blockers, !["below_target", "within_target", "above_target"].includes(row?.word_count_status), `longform_draft_portfolio_candidate_${index}_word_count_status_invalid`);
    if (spec) {
      for (const field of ["provider", "model", "reasoning_effort", "transport", "creative_lens"]) {
        pushIf(blockers, row?.[field] !== spec?.[field], `longform_draft_portfolio_candidate_${index}_${field}_mismatch`);
      }
    }
  }
  if (expected.size > 0) {
    for (const id of expected.keys()) pushIf(blockers, !ids.includes(id), `longform_draft_portfolio_expected_${id}_missing`);
  }
  return { done: blockers.length === 0, blockers };
}

export function validateNarrationRevisionLedger(document, {
  sourceScriptSha256 = null,
  polishedScriptSha256 = null,
  storyTruthIrSha256 = null,
  sourceWordCount = null,
  polishedWordCount = null,
} = {}) {
  const blockers = [];
  pushIf(blockers, document?.schema !== NARRATION_REVISION_LEDGER_SCHEMA, "narration_revision_ledger_schema_invalid");
  pushIf(blockers, document?.status !== "polished", "narration_revision_ledger_not_polished");
  if (sourceScriptSha256) pushIf(blockers, document?.source_script_sha256 !== sourceScriptSha256, "narration_revision_ledger_source_hash_mismatch");
  if (polishedScriptSha256) pushIf(blockers, document?.polished_script_sha256 !== polishedScriptSha256, "narration_revision_ledger_polished_hash_mismatch");
  if (storyTruthIrSha256) pushIf(blockers, document?.story_truth_ir_sha256 !== storyTruthIrSha256, "narration_revision_ledger_truth_hash_mismatch");
  pushIf(blockers, document?.story_facts_changed !== false, "narration_revision_ledger_story_facts_changed");
  pushIf(blockers, document?.events_reordered !== false, "narration_revision_ledger_events_reordered");
  pushIf(blockers, document?.ending_changed !== false, "narration_revision_ledger_ending_changed");
  const before = Number(sourceWordCount ?? document?.source_word_count);
  const after = Number(polishedWordCount ?? document?.polished_word_count);
  pushIf(blockers, !Number.isInteger(before) || before < 1, "narration_revision_ledger_source_word_count_invalid");
  pushIf(blockers, !Number.isInteger(after) || after < 1, "narration_revision_ledger_polished_word_count_invalid");
  const changes = objectRows(document?.changes);
  for (const [index, row] of changes.entries()) {
    for (const field of ["source_anchor", "polished_anchor", "narration_reason"]) {
      pushIf(blockers, !nonEmpty(row?.[field]), `narration_revision_ledger_change_${index}_${field}_missing`);
    }
    pushIf(blockers, !["cadence", "breath", "sentence_contrast", "spoken_clarity", "pronunciation", "join_safety"].includes(row?.change_type), `narration_revision_ledger_change_${index}_type_invalid`);
  }
  return { done: blockers.length === 0, blockers };
}
