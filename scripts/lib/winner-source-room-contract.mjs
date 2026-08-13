import {
  countWords,
  normalizeWinnerNarration,
  sha256Text,
  validateWinnerStoryBlueprint,
  WINNER_SOURCE_ROOM_PROFILE,
} from "./winner-source-contract.mjs";

export const WINNER_STORY_BLUEPRINT_V2_SCHEMA = "goldflow_winner_story_blueprint_v2";
export const WINNER_AUDIENCE_FEEDBACK_CONTRACT_VERSION = "2026-08-09.1";
export const WINNER_OPENING_DELIVERY_CONTRACT_VERSION = "2026-08-11.1";
export const WINNER_BLUEPRINT_AUDIENCE_AUDIT_SCHEMA = "goldflow_winner_blueprint_audience_audit_v1";
export const WINNER_RETENTION_MAP_SCHEMA = "goldflow_winner_retention_map_v1";
export const WINNER_OPENING_REPORT_SCHEMA = "goldflow_winner_opening_report_v1";
export const WINNER_OPENING_APPROVAL_SCHEMA = "goldflow_winner_opening_approval_v1";
export const WINNER_DEVELOPMENT_DIAGNOSTIC_SCHEMA = "goldflow_winner_development_diagnostic_v1";
export const WINNER_REVISION_REPORT_SCHEMA = "goldflow_winner_revision_report_v1";
export { WINNER_SOURCE_ROOM_PROFILE };

export const WINNER_OPENING_WINDOW_IDS = [
  "0_30_seconds",
  "30_60_seconds",
  "60_90_seconds",
  "90_180_seconds",
  "180_300_seconds",
];

export const WINNER_LONGFORM_CHECKPOINT_IDS = [
  "ten_percent",
  "twenty_five_percent",
  "midpoint",
  "seventy_five_percent",
  "climax_entry",
  "ending_payoff",
];

export const WINNER_DIAGNOSTIC_PASS_IDS = [
  "causal_flow",
  "emotional_drama",
  "retention_repetition",
];

export const WINNER_BLUEPRINT_AUDIENCE_AUDIT_DIMENSION_IDS = [
  "protagonist_evidence_update",
  "system_vs_joey_agency",
  "domain_and_stakes_relevance",
  "title_and_thumbnail_payment",
  "question_and_movement_progression",
  "continuity_and_closure",
  "supporting_character_balance",
];

function nonEmpty(value) {
  return Boolean(String(value ?? "").trim());
}

function pushIf(blockers, condition, code) {
  if (condition) blockers.push(code);
}

function integerBetween(value, minimum, maximum) {
  return Number.isInteger(Number(value))
    && Number(value) >= minimum
    && Number(value) <= maximum;
}

function collectStringValues(value, output = new Set()) {
  if (typeof value === "string") output.add(value);
  else if (Array.isArray(value)) value.forEach((entry) => collectStringValues(entry, output));
  else if (value && typeof value === "object") Object.values(value).forEach((entry) => collectStringValues(entry, output));
  return output;
}

export function usesWinnerAudienceFeedbackContract(document) {
  return nonEmpty(document?.audience_feedback_contract_version);
}

function expectedMovementRange(packageContract) {
  const minimumWords = Number(packageContract?.target_word_range?.minimum ?? 10_000);
  const maximumWords = Number(packageContract?.target_word_range?.maximum ?? minimumWords);
  const midpointWords = Math.max(1, Math.round((minimumWords + maximumWords) / 2));
  return {
    minimum: Math.max(4, Math.min(20, Math.ceil(midpointWords / 1_200))),
    maximum: Math.max(4, Math.min(30, Math.max(Math.ceil(midpointWords / 650), Math.ceil(midpointWords / 1_200)))),
  };
}

function validateNarrationContract(blockers, narration) {
  pushIf(
    blockers,
    !["first_person", "third_person", "hybrid_first_person_cold_open_then_third_person"].includes(narration?.pov),
    "winner_blueprint_v2_pov_invalid",
  );
  pushIf(blockers, !["present", "past"].includes(narration?.tense), "winner_blueprint_v2_tense_invalid");
  for (const field of ["voice", "dialogue_policy", "choice_reason", "cadence_contract"]) {
    pushIf(blockers, !nonEmpty(narration?.[field]), `winner_blueprint_v2_narration_${field}_missing`);
  }
}

function validateOpeningDeliveryContract(blockers, blueprint) {
  const version = String(blueprint?.opening_delivery_contract_version ?? "").trim();
  if (!version) return;
  pushIf(
    blockers,
    version !== WINNER_OPENING_DELIVERY_CONTRACT_VERSION,
    "winner_blueprint_v2_opening_delivery_contract_version_invalid",
  );
  const contract = blueprint?.opening_delivery_contract ?? {};
  const mode = String(contract.mode ?? "").trim();
  pushIf(
    blockers,
    !["linear_title_event", "outcome_choice_rewind", "direct_premise"].includes(mode),
    "winner_blueprint_v2_opening_delivery_mode_invalid",
  );
  for (const field of [
    "package_fit_reason",
    "title_truth_by_30_seconds",
    "forward_pressure_by_60_seconds",
    "choice_or_power_proof_by_90_seconds",
    "first_loop_by_180_seconds",
  ]) {
    pushIf(blockers, !nonEmpty(contract[field]), `winner_blueprint_v2_opening_delivery_${field}_missing`);
  }
  const languageBudget = contract.first_30_second_language_budget ?? {};
  pushIf(
    blockers,
    Number(languageBudget.new_proper_names_maximum) !== 1,
    "winner_blueprint_v2_opening_delivery_proper_name_budget_invalid",
  );
  pushIf(
    blockers,
    Number(languageBudget.unexplained_story_terms_maximum) !== 2,
    "winner_blueprint_v2_opening_delivery_story_term_budget_invalid",
  );
  pushIf(blockers, !nonEmpty(languageBudget.rule), "winner_blueprint_v2_opening_delivery_language_rule_missing");
  if (mode === "outcome_choice_rewind") {
    for (const field of [
      "cold_open_outcome_image",
      "cold_open_decisive_choice",
      "rewind_entry",
      "rewind_non_repetition_contract",
    ]) {
      pushIf(blockers, !nonEmpty(contract[field]), `winner_blueprint_v2_opening_delivery_${field}_missing`);
    }
  }
}

export function validateWinnerBlueprintForPackage(blueprint, {
  packageContract = null,
  packageSha256 = null,
} = {}) {
  if (packageContract?.source_workflow_profile === WINNER_SOURCE_ROOM_PROFILE
    || blueprint?.schema === WINNER_STORY_BLUEPRINT_V2_SCHEMA) {
    return validateWinnerStoryBlueprintV2(blueprint, { packageContract, packageSha256 });
  }
  return validateWinnerStoryBlueprint(blueprint, { packageContract, packageSha256 });
}

export function validateWinnerStoryBlueprintV2(blueprint, {
  packageContract = null,
  packageSha256 = null,
} = {}) {
  const blockers = [];
  const audienceFeedbackEnabled = usesWinnerAudienceFeedbackContract(blueprint);
  pushIf(blockers, blueprint?.schema !== WINNER_STORY_BLUEPRINT_V2_SCHEMA, "winner_blueprint_v2_schema_invalid");
  pushIf(blockers, blueprint?.status !== "planned", "winner_blueprint_v2_not_planned");
  pushIf(blockers, blueprint?.source_workflow_profile !== WINNER_SOURCE_ROOM_PROFILE, "winner_blueprint_v2_profile_invalid");
  for (const field of [
    "channel", "development_slug", "selected_candidate_id", "selected_title",
    "winner_package_sha256", "planned_at",
  ]) pushIf(blockers, !nonEmpty(blueprint?.[field]), `winner_blueprint_v2_${field}_missing`);
  if (audienceFeedbackEnabled) {
    pushIf(
      blockers,
      blueprint?.audience_feedback_contract_version !== WINNER_AUDIENCE_FEEDBACK_CONTRACT_VERSION,
      "winner_blueprint_v2_audience_feedback_contract_version_invalid",
    );
  }

  if (packageContract) {
    pushIf(blockers, blueprint?.channel !== packageContract.channel, "winner_blueprint_v2_channel_mismatch");
    pushIf(blockers, blueprint?.development_slug !== packageContract.development_slug, "winner_blueprint_v2_development_slug_mismatch");
    pushIf(blockers, blueprint?.selected_candidate_id !== packageContract.selected_candidate_id, "winner_blueprint_v2_candidate_mismatch");
    pushIf(blockers, blueprint?.selected_title !== packageContract.selected_title, "winner_blueprint_v2_title_mismatch");
  }
  if (packageSha256) pushIf(blockers, blueprint?.winner_package_sha256 !== packageSha256, "winner_blueprint_v2_package_hash_mismatch");

  const retentionTarget = blueprint?.retention_north_star ?? {};
  pushIf(blockers, retentionTarget.metric !== "average_percentage_viewed", "winner_blueprint_v2_retention_metric_invalid");
  pushIf(blockers, Number(retentionTarget.target_percent) !== 50, "winner_blueprint_v2_retention_target_must_equal_50");
  pushIf(blockers, retentionTarget.contract !== "upload_measurement_target_not_model_prediction", "winner_blueprint_v2_retention_contract_invalid");

  validateNarrationContract(blockers, blueprint?.narration_contract ?? {});
  validateOpeningDeliveryContract(blockers, blueprint);

  const dramaticEngine = blueprint?.dramatic_engine ?? {};
  for (const field of [
    "emotional_promise", "joey_outer_goal", "joey_inner_need", "central_relationship_question",
    "antagonist_human_logic", "private_public_contrast", "premise_native_expansion",
    "midpoint_transformation", "warmth_or_relief_source", "recurring_emotional_object",
  ]) pushIf(blockers, !nonEmpty(dramaticEngine[field]), `winner_blueprint_v2_dramatic_engine_${field}_missing`);

  const canon = blueprint?.canon ?? {};
  for (const field of ["name", "initial_condition", "core_desire", "misbelief_or_wound", "final_condition"]) {
    pushIf(blockers, !nonEmpty(canon?.protagonist?.[field]), `winner_blueprint_v2_protagonist_${field}_missing`);
  }
  for (const field of [
    "recurring_characters", "advantage_rules", "execution_bridges", "recurring_locations",
    "critical_props_or_ui", "immutable_facts",
  ]) pushIf(blockers, !Array.isArray(canon?.[field]), `winner_blueprint_v2_canon_${field}_missing`);
  pushIf(blockers, !Array.isArray(canon?.recurring_characters) || canon.recurring_characters.length < 2, "winner_blueprint_v2_recurring_characters_too_thin");
  for (const [index, character] of (canon?.recurring_characters ?? []).entries()) {
    for (const field of ["id", "name", "role", "desire", "fear", "contradiction", "relationship_to_joey", "relationship_arc", "practical_story_function"]) {
      pushIf(blockers, !nonEmpty(character?.[field]), `winner_blueprint_v2_character_${index}_${field}_missing`);
    }
  }
  pushIf(blockers, !Array.isArray(canon?.advantage_rules) || canon.advantage_rules.filter(nonEmpty).length < 1, "winner_blueprint_v2_advantage_rules_too_thin");
  pushIf(blockers, !Array.isArray(canon?.immutable_facts) || canon.immutable_facts.filter(nonEmpty).length < 5, "winner_blueprint_v2_immutable_facts_too_thin");

  const movements = Array.isArray(blueprint?.movements) ? blueprint.movements : [];
  const expectedRange = expectedMovementRange(packageContract);
  pushIf(
    blockers,
    movements.length < expectedRange.minimum || movements.length > expectedRange.maximum,
    `winner_blueprint_v2_movement_count_${movements.length}_outside_${expectedRange.minimum}_${expectedRange.maximum}`,
  );
  let targetWordTotal = 0;
  const movementIds = [];
  const seenIds = new Set();
  let bridgeMovementCount = 0;
  let previousWasBridge = false;
  let humanChangeMovementCount = 0;
  let evidenceUpdateMovementCount = 0;
  for (const [index, movement] of movements.entries()) {
    const expectedId = `movement_${String(index + 1).padStart(2, "0")}`;
    const id = String(movement?.id ?? "").trim();
    movementIds.push(id);
    pushIf(blockers, id !== expectedId, `winner_blueprint_v2_movement_${index}_id_invalid`);
    pushIf(blockers, seenIds.has(id), `winner_blueprint_v2_movement_${index}_id_duplicate`);
    seenIds.add(id);
    const targetWords = Number(movement?.target_words);
    pushIf(blockers, !integerBetween(targetWords, 200, 1_800), `winner_blueprint_v2_movement_${index}_target_words_invalid`);
    if (Number.isInteger(targetWords)) targetWordTotal += targetWords;
    for (const field of [
      "start_state", "entry_question", "external_objective", "obstacle",
      "joey_choice", "visible_execution", "opposition_response",
      "reveal_or_reversal", "result", "answer_delivered", "next_question", "cause_into_next",
      "conflict_mode", "emotional_mode", "location_or_arena", "unique_function",
    ]) pushIf(blockers, !nonEmpty(movement?.[field]), `winner_blueprint_v2_movement_${index}_${field}_missing`);
    if (audienceFeedbackEnabled) {
      const movementKind = String(movement?.movement_kind ?? "").trim();
      pushIf(blockers, !["dramatic", "bridge"].includes(movementKind), `winner_blueprint_v2_movement_${index}_kind_invalid`);
      const isBridge = movementKind === "bridge";
      if (isBridge) bridgeMovementCount += 1;
      pushIf(blockers, isBridge && previousWasBridge, `winner_blueprint_v2_movement_${index}_adjacent_bridge_forbidden`);
      previousWasBridge = isBridge;
      if (!isBridge) {
        pushIf(blockers, !nonEmpty(movement?.emotional_objective), `winner_blueprint_v2_movement_${index}_emotional_objective_missing`);
        pushIf(blockers, !nonEmpty(movement?.relationship_turn), `winner_blueprint_v2_movement_${index}_relationship_turn_missing`);
      }
      if (nonEmpty(movement?.emotional_objective) || nonEmpty(movement?.relationship_turn)) {
        humanChangeMovementCount += 1;
      }
      pushIf(blockers, !nonEmpty(movement?.stakes_relevance), `winner_blueprint_v2_movement_${index}_stakes_relevance_missing`);
      const evidence = movement?.evidence_or_information_received;
      const updates = movement?.behavior_or_strategy_updates;
      pushIf(blockers, !Array.isArray(evidence), `winner_blueprint_v2_movement_${index}_evidence_or_information_missing`);
      pushIf(blockers, !Array.isArray(updates), `winner_blueprint_v2_movement_${index}_behavior_or_strategy_updates_missing`);
      if (Array.isArray(evidence) && evidence.filter(nonEmpty).length > 0
        && Array.isArray(updates) && updates.filter(nonEmpty).length > 0) {
        evidenceUpdateMovementCount += 1;
      }
    } else {
      for (const field of ["emotional_objective", "relationship_turn"]) {
        pushIf(blockers, !nonEmpty(movement?.[field]), `winner_blueprint_v2_movement_${index}_${field}_missing`);
      }
    }
    pushIf(
      blockers,
      !Array.isArray(movement?.irreversible_state_changes)
        || movement.irreversible_state_changes.filter(nonEmpty).length < (audienceFeedbackEnabled ? 1 : 2),
      `winner_blueprint_v2_movement_${index}_state_changes_too_thin`,
    );
    pushIf(
      blockers,
      !Array.isArray(movement?.setup_or_payoff_ids),
      `winner_blueprint_v2_movement_${index}_setup_or_payoff_ids_missing`,
    );
  }

  if (audienceFeedbackEnabled && movements.length > 0) {
    const maximumBridgeMovements = Math.max(1, Math.floor(movements.length * 0.25));
    pushIf(blockers, bridgeMovementCount > maximumBridgeMovements, "winner_blueprint_v2_bridge_movement_budget_exceeded");
    pushIf(
      blockers,
      humanChangeMovementCount < Math.ceil(movements.length * 0.6),
      "winner_blueprint_v2_human_change_coverage_too_thin",
    );
    pushIf(blockers, evidenceUpdateMovementCount < 1, "winner_blueprint_v2_evidence_update_chain_missing");
  }

  if (packageContract) {
    const minimum = Number(packageContract?.target_word_range?.minimum ?? 0);
    const maximum = Number(packageContract?.target_word_range?.maximum ?? Number.POSITIVE_INFINITY);
    pushIf(blockers, targetWordTotal < minimum || targetWordTotal > maximum, `winner_blueprint_v2_target_word_total_${targetWordTotal}_outside_${minimum}_${maximum}`);
  }

  const setupPayoffs = Array.isArray(blueprint?.setup_payoff_ledger) ? blueprint.setup_payoff_ledger : [];
  pushIf(blockers, setupPayoffs.length < 4, "winner_blueprint_v2_setup_payoff_ledger_too_thin");
  const setupPayoffIds = new Set();
  for (const [index, row] of setupPayoffs.entries()) {
    for (const field of ["id", "setup_movement_id", "payoff_movement_id", "setup", "payoff"]) {
      pushIf(blockers, !nonEmpty(row?.[field]), `winner_blueprint_v2_setup_payoff_${index}_${field}_missing`);
    }
    pushIf(blockers, setupPayoffIds.has(row?.id), `winner_blueprint_v2_setup_payoff_${index}_id_duplicate`);
    setupPayoffIds.add(row?.id);
    pushIf(blockers, !movementIds.includes(row?.setup_movement_id), `winner_blueprint_v2_setup_payoff_${index}_setup_movement_unknown`);
    pushIf(blockers, !movementIds.includes(row?.payoff_movement_id), `winner_blueprint_v2_setup_payoff_${index}_payoff_movement_unknown`);
  }

  if (audienceFeedbackEnabled) {
    const audienceTrust = blueprint?.audience_trust_contract ?? {};
    for (const field of [
      "initial_wound_behavior", "decisive_evidence", "evidence_movement_id",
      "required_behavior_update", "behavior_update_movement_id", "irreversible_boundary",
      "boundary_movement_id", "forbidden_casual_relapse", "strategic_contact_rule",
      "system_leverage", "joey_owned_decision", "supporting_character_ceiling",
    ]) pushIf(blockers, !nonEmpty(audienceTrust?.[field]), `winner_blueprint_v2_audience_trust_${field}_missing`);
    for (const field of ["evidence_movement_id", "behavior_update_movement_id", "boundary_movement_id"]) {
      pushIf(blockers, nonEmpty(audienceTrust?.[field]) && !movementIds.includes(audienceTrust[field]), `winner_blueprint_v2_audience_trust_${field}_unknown`);
    }
    const evidenceIndex = movementIds.indexOf(audienceTrust.evidence_movement_id);
    const updateIndex = movementIds.indexOf(audienceTrust.behavior_update_movement_id);
    const boundaryIndex = movementIds.indexOf(audienceTrust.boundary_movement_id);
    pushIf(blockers, evidenceIndex >= 0 && updateIndex >= 0 && updateIndex < evidenceIndex, "winner_blueprint_v2_audience_trust_update_precedes_evidence");
    pushIf(blockers, updateIndex >= 0 && boundaryIndex >= 0 && boundaryIndex < updateIndex, "winner_blueprint_v2_audience_trust_boundary_precedes_update");
    const evidenceMovement = movements[evidenceIndex];
    const updateMovement = movements[updateIndex];
    pushIf(
      blockers,
      evidenceIndex >= 0 && (!Array.isArray(evidenceMovement?.evidence_or_information_received) || evidenceMovement.evidence_or_information_received.filter(nonEmpty).length < 1),
      "winner_blueprint_v2_audience_trust_evidence_movement_has_no_evidence",
    );
    pushIf(
      blockers,
      updateIndex >= 0 && (!Array.isArray(updateMovement?.behavior_or_strategy_updates) || updateMovement.behavior_or_strategy_updates.filter(nonEmpty).length < 1),
      "winner_blueprint_v2_audience_trust_update_movement_has_no_update",
    );

    const titlePayments = Array.isArray(blueprint?.title_payment_ledger) ? blueprint.title_payment_ledger : [];
    pushIf(blockers, titlePayments.length < 1, "winner_blueprint_v2_title_payment_ledger_missing");
    const titlePaymentIds = new Set();
    for (const [index, row] of titlePayments.entries()) {
      for (const field of ["id", "promise", "first_progress_movement_id", "literal_payment_movement_id", "visible_proof", "failure_if_missing"]) {
        pushIf(blockers, !nonEmpty(row?.[field]), `winner_blueprint_v2_title_payment_${index}_${field}_missing`);
      }
      pushIf(blockers, titlePaymentIds.has(row?.id), `winner_blueprint_v2_title_payment_${index}_id_duplicate`);
      titlePaymentIds.add(row?.id);
      const progressIndex = movementIds.indexOf(row?.first_progress_movement_id);
      const paymentIndex = movementIds.indexOf(row?.literal_payment_movement_id);
      pushIf(blockers, progressIndex < 0, `winner_blueprint_v2_title_payment_${index}_progress_movement_unknown`);
      pushIf(blockers, paymentIndex < 0, `winner_blueprint_v2_title_payment_${index}_payment_movement_unknown`);
      pushIf(blockers, progressIndex >= 0 && paymentIndex >= 0 && paymentIndex < progressIndex, `winner_blueprint_v2_title_payment_${index}_payment_precedes_progress`);
    }

    const continuityStates = Array.isArray(blueprint?.continuity_state_ledger) ? blueprint.continuity_state_ledger : [];
    pushIf(blockers, continuityStates.length < 3, "winner_blueprint_v2_continuity_state_ledger_too_thin");
    const continuityIds = new Set();
    for (const [index, row] of continuityStates.entries()) {
      for (const field of ["id", "entity", "category", "initial_state"]) {
        pushIf(blockers, !nonEmpty(row?.[field]), `winner_blueprint_v2_continuity_state_${index}_${field}_missing`);
      }
      pushIf(blockers, continuityIds.has(row?.id), `winner_blueprint_v2_continuity_state_${index}_id_duplicate`);
      continuityIds.add(row?.id);
      const changes = Array.isArray(row?.changes) ? row.changes : [];
      pushIf(blockers, changes.length < 1, `winner_blueprint_v2_continuity_state_${index}_changes_missing`);
      let previousChangeIndex = -1;
      for (const [changeIndex, change] of changes.entries()) {
        for (const field of ["movement_id", "new_state", "cause"]) {
          pushIf(blockers, !nonEmpty(change?.[field]), `winner_blueprint_v2_continuity_state_${index}_change_${changeIndex}_${field}_missing`);
        }
        const movementIndex = movementIds.indexOf(change?.movement_id);
        pushIf(blockers, movementIndex < 0, `winner_blueprint_v2_continuity_state_${index}_change_${changeIndex}_movement_unknown`);
        pushIf(blockers, movementIndex >= 0 && movementIndex < previousChangeIndex, `winner_blueprint_v2_continuity_state_${index}_changes_out_of_order`);
        if (movementIndex >= 0) previousChangeIndex = movementIndex;
      }
    }
  }

  for (const field of ["setup_paid_off", "joey_decisive_action", "antagonist_response", "visible_result", "antagonist_concrete_loss", "relationship_payoff"]) {
    const value = blueprint?.climax_contract?.[field];
    pushIf(blockers, field === "setup_paid_off" ? !Array.isArray(value) || value.filter(nonEmpty).length < 3 : !nonEmpty(value), `winner_blueprint_v2_climax_${field}_missing`);
  }
  for (const field of ["final_boundary", "changed_equilibrium", "emotional_afterimage", "stop_point"]) {
    pushIf(blockers, !nonEmpty(blueprint?.ending_contract?.[field]), `winner_blueprint_v2_ending_${field}_missing`);
  }
  pushIf(blockers, !Array.isArray(blueprint?.continuity_watchlist) || blueprint.continuity_watchlist.filter(nonEmpty).length < 5, "winner_blueprint_v2_continuity_watchlist_too_thin");
  pushIf(blockers, !Array.isArray(blueprint?.repetition_watchlist) || blueprint.repetition_watchlist.filter(nonEmpty).length < 4, "winner_blueprint_v2_repetition_watchlist_too_thin");
  pushIf(blockers, !Array.isArray(blueprint?.procedural_compression_watchlist) || blueprint.procedural_compression_watchlist.filter(nonEmpty).length < 2, "winner_blueprint_v2_procedural_watchlist_too_thin");

  const sectionPlan = Array.isArray(blueprint?.section_plan) ? blueprint.section_plan : [];
  pushIf(blockers, sectionPlan.length < 3, "winner_blueprint_v2_section_plan_too_thin");
  const plannedMovementIds = sectionPlan.flatMap((row) => Array.isArray(row?.movement_ids) ? row.movement_ids : []);
  pushIf(blockers, JSON.stringify(plannedMovementIds) !== JSON.stringify(movementIds), "winner_blueprint_v2_section_plan_movement_coverage_invalid");
  for (const [index, section] of sectionPlan.entries()) {
    pushIf(blockers, !/^section_\d{2}$/.test(String(section?.id ?? "")), `winner_blueprint_v2_section_${index}_id_invalid`);
    for (const field of ["entry_state", "exit_state", "emotional_progress", "retention_function"]) {
      pushIf(blockers, !nonEmpty(section?.[field]), `winner_blueprint_v2_section_${index}_${field}_missing`);
    }
  }

  return {
    done: blockers.length === 0,
    blockers,
    target_word_total: targetWordTotal,
    movement_count_range: expectedRange,
  };
}

export function validateWinnerBlueprintAudienceAudit(document, {
  packageContract = null,
  packageSha256 = null,
  blueprint = null,
  blueprintSha256 = null,
} = {}) {
  const blockers = [];
  pushIf(blockers, document?.schema !== WINNER_BLUEPRINT_AUDIENCE_AUDIT_SCHEMA, "winner_blueprint_audience_audit_schema_invalid");
  pushIf(blockers, document?.status !== "completed", "winner_blueprint_audience_audit_not_completed");
  pushIf(blockers, document?.audience_feedback_contract_version !== WINNER_AUDIENCE_FEEDBACK_CONTRACT_VERSION, "winner_blueprint_audience_audit_contract_version_invalid");
  for (const field of [
    "channel", "development_slug", "selected_candidate_id", "winner_package_sha256",
    "winner_story_blueprint_sha256", "audited_at", "summary",
  ]) pushIf(blockers, !nonEmpty(document?.[field]), `winner_blueprint_audience_audit_${field}_missing`);
  pushIf(blockers, !["pass", "revise"].includes(document?.decision), "winner_blueprint_audience_audit_decision_invalid");
  if (packageContract) {
    pushIf(blockers, document?.channel !== packageContract.channel, "winner_blueprint_audience_audit_channel_mismatch");
    pushIf(blockers, document?.development_slug !== packageContract.development_slug, "winner_blueprint_audience_audit_development_slug_mismatch");
    pushIf(blockers, document?.selected_candidate_id !== packageContract.selected_candidate_id, "winner_blueprint_audience_audit_candidate_mismatch");
  }
  if (packageSha256) pushIf(blockers, document?.winner_package_sha256 !== packageSha256, "winner_blueprint_audience_audit_package_hash_mismatch");
  if (blueprintSha256) pushIf(blockers, document?.winner_story_blueprint_sha256 !== blueprintSha256, "winner_blueprint_audience_audit_blueprint_hash_mismatch");

  const movementIds = new Set((blueprint?.movements ?? []).map((row) => row?.id).filter(nonEmpty));
  const blueprintStrings = blueprint ? collectStringValues(blueprint) : null;
  const dimensions = Array.isArray(document?.dimensions) ? document.dimensions : [];
  const dimensionById = new Map(dimensions.map((row) => [row?.id, row]));
  pushIf(blockers, dimensions.length !== WINNER_BLUEPRINT_AUDIENCE_AUDIT_DIMENSION_IDS.length, "winner_blueprint_audience_audit_dimension_count_invalid");
  for (const id of WINNER_BLUEPRINT_AUDIENCE_AUDIT_DIMENSION_IDS) {
    const row = dimensionById.get(id);
    pushIf(blockers, !row, `winner_blueprint_audience_audit_dimension_${id}_missing`);
    if (!row) continue;
    pushIf(blockers, !["pass", "revise"].includes(row?.decision), `winner_blueprint_audience_audit_dimension_${id}_decision_invalid`);
    pushIf(blockers, !Array.isArray(row?.blueprint_evidence) || row.blueprint_evidence.filter(nonEmpty).length < 1, `winner_blueprint_audience_audit_dimension_${id}_evidence_missing`);
    for (const evidence of (row?.blueprint_evidence ?? []).filter(nonEmpty)) {
      pushIf(blockers, blueprintStrings && !blueprintStrings.has(String(evidence)), `winner_blueprint_audience_audit_dimension_${id}_evidence_not_exact`);
    }
    pushIf(blockers, !nonEmpty(row?.reasoning), `winner_blueprint_audience_audit_dimension_${id}_reasoning_missing`);
  }

  pushIf(blockers, !Array.isArray(document?.strengths), "winner_blueprint_audience_audit_strengths_missing");
  const findings = Array.isArray(document?.findings) ? document.findings : [];
  for (const [index, finding] of findings.entries()) {
    pushIf(blockers, !["high", "medium", "low"].includes(finding?.priority), `winner_blueprint_audience_audit_finding_${index}_priority_invalid`);
    pushIf(blockers, !WINNER_BLUEPRINT_AUDIENCE_AUDIT_DIMENSION_IDS.includes(finding?.dimension), `winner_blueprint_audience_audit_finding_${index}_dimension_invalid`);
    for (const field of ["id", "audience_risk", "repair_goal"]) {
      pushIf(blockers, !nonEmpty(finding?.[field]), `winner_blueprint_audience_audit_finding_${index}_${field}_missing`);
    }
    pushIf(blockers, !Array.isArray(finding?.blueprint_evidence) || finding.blueprint_evidence.filter(nonEmpty).length < 1, `winner_blueprint_audience_audit_finding_${index}_evidence_missing`);
    for (const evidence of (finding?.blueprint_evidence ?? []).filter(nonEmpty)) {
      pushIf(blockers, blueprintStrings && !blueprintStrings.has(String(evidence)), `winner_blueprint_audience_audit_finding_${index}_evidence_not_exact`);
    }
    pushIf(blockers, !Array.isArray(finding?.protected_facts), `winner_blueprint_audience_audit_finding_${index}_protected_facts_missing`);
    const affected = Array.isArray(finding?.movement_ids) ? finding.movement_ids : [];
    pushIf(blockers, !Array.isArray(finding?.movement_ids), `winner_blueprint_audience_audit_finding_${index}_movement_ids_missing`);
    for (const movementId of affected) {
      pushIf(blockers, movementIds.size > 0 && !movementIds.has(movementId), `winner_blueprint_audience_audit_finding_${index}_movement_unknown`);
    }
  }
  const expectedDecision = dimensions.some((row) => row?.decision === "revise")
    || findings.some((row) => row?.priority === "high")
    ? "revise"
    : "pass";
  pushIf(blockers, document?.decision !== expectedDecision, `winner_blueprint_audience_audit_decision_must_equal_${expectedDecision}`);
  return { done: blockers.length === 0, blockers, expected_decision: expectedDecision };
}

export function validateWinnerRetentionMap(document, {
  blueprint = null,
  blueprintSha256 = null,
  packageContract = null,
  packageSha256 = null,
} = {}) {
  const blockers = [];
  const audienceFeedbackEnabled = usesWinnerAudienceFeedbackContract(document)
    || usesWinnerAudienceFeedbackContract(blueprint);
  const questionReferenceIds = [];
  pushIf(blockers, document?.schema !== WINNER_RETENTION_MAP_SCHEMA, "winner_retention_map_schema_invalid");
  pushIf(blockers, document?.status !== "planned", "winner_retention_map_not_planned");
  pushIf(blockers, document?.source_workflow_profile !== WINNER_SOURCE_ROOM_PROFILE, "winner_retention_map_profile_invalid");
  for (const field of [
    "channel", "development_slug", "selected_candidate_id", "winner_package_sha256",
    "winner_story_blueprint_sha256", "planned_at",
  ]) pushIf(blockers, !nonEmpty(document?.[field]), `winner_retention_map_${field}_missing`);
  if (audienceFeedbackEnabled) {
    pushIf(
      blockers,
      document?.audience_feedback_contract_version !== WINNER_AUDIENCE_FEEDBACK_CONTRACT_VERSION,
      "winner_retention_map_audience_feedback_contract_version_invalid",
    );
  }
  if (blueprintSha256) pushIf(blockers, document?.winner_story_blueprint_sha256 !== blueprintSha256, "winner_retention_map_blueprint_hash_mismatch");
  if (packageSha256) pushIf(blockers, document?.winner_package_sha256 !== packageSha256, "winner_retention_map_package_hash_mismatch");
  if (blueprint) {
    pushIf(blockers, document?.channel !== blueprint.channel, "winner_retention_map_channel_mismatch");
    pushIf(blockers, document?.development_slug !== blueprint.development_slug, "winner_retention_map_development_slug_mismatch");
    pushIf(blockers, document?.selected_candidate_id !== blueprint.selected_candidate_id, "winner_retention_map_candidate_mismatch");
  }
  pushIf(blockers, document?.retention_north_star?.metric !== "average_percentage_viewed", "winner_retention_map_metric_invalid");
  pushIf(blockers, Number(document?.retention_north_star?.target_percent) !== 50, "winner_retention_map_target_must_equal_50");
  pushIf(blockers, document?.retention_north_star?.contract !== "upload_measurement_target_not_model_prediction", "winner_retention_map_contract_invalid");

  const openingWindows = Array.isArray(document?.opening_windows) ? document.opening_windows : [];
  const openingById = new Map(openingWindows.map((row) => [row?.id, row]));
  pushIf(blockers, openingWindows.length !== WINNER_OPENING_WINDOW_IDS.length, "winner_retention_map_opening_window_count_invalid");
  let previousWordEnd = 0;
  for (const id of WINNER_OPENING_WINDOW_IDS) {
    const row = openingById.get(id);
    pushIf(blockers, !row, `winner_retention_map_opening_${id}_missing`);
    if (!row) continue;
    const targetWordEnd = Number(row.target_word_end);
    pushIf(blockers, !Number.isInteger(targetWordEnd) || targetWordEnd <= previousWordEnd, `winner_retention_map_opening_${id}_word_end_invalid`);
    if (Number.isInteger(targetWordEnd)) previousWordEnd = targetWordEnd;
    for (const field of ["visible_event", "promise_progress", "proof_or_change", "emotional_turn", "viewer_question_out"]) {
      pushIf(blockers, !nonEmpty(row?.[field]), `winner_retention_map_opening_${id}_${field}_missing`);
    }
    if (audienceFeedbackEnabled) {
      pushIf(blockers, !nonEmpty(row?.viewer_question_id_out), `winner_retention_map_opening_${id}_question_id_missing`);
      if (nonEmpty(row?.viewer_question_id_out)) questionReferenceIds.push(row.viewer_question_id_out);
    }
  }
  if (packageContract) {
    const targetFiveMinuteWords = Math.round(Number(packageContract.intended_spoken_wpm ?? 187.5) * 5);
    pushIf(
      blockers,
      previousWordEnd < Math.floor(targetFiveMinuteWords * 0.8) || previousWordEnd > Math.ceil(targetFiveMinuteWords * 1.2),
      `winner_retention_map_opening_word_end_${previousWordEnd}_outside_five_minute_window`,
    );
  }

  const checkpoints = Array.isArray(document?.longform_checkpoints) ? document.longform_checkpoints : [];
  const checkpointById = new Map(checkpoints.map((row) => [row?.id, row]));
  pushIf(blockers, checkpoints.length !== WINNER_LONGFORM_CHECKPOINT_IDS.length, "winner_retention_map_longform_checkpoint_count_invalid");
  for (const id of WINNER_LONGFORM_CHECKPOINT_IDS) {
    const row = checkpointById.get(id);
    pushIf(blockers, !row, `winner_retention_map_checkpoint_${id}_missing`);
    if (!row) continue;
    for (const field of ["movement_id", "payoff_or_change", "relationship_change", "freshness_source", "viewer_question_out"]) {
      pushIf(blockers, !nonEmpty(row?.[field]), `winner_retention_map_checkpoint_${id}_${field}_missing`);
    }
    if (audienceFeedbackEnabled) {
      pushIf(blockers, !nonEmpty(row?.viewer_question_id_out), `winner_retention_map_checkpoint_${id}_question_id_missing`);
      if (nonEmpty(row?.viewer_question_id_out)) questionReferenceIds.push(row.viewer_question_id_out);
    }
  }

  const blueprintMovements = Array.isArray(blueprint?.movements) ? blueprint.movements : [];
  const blueprintMovementIds = blueprintMovements.map((row) => row.id);
  const directives = Array.isArray(document?.movement_directives) ? document.movement_directives : [];
  pushIf(blockers, directives.length !== blueprintMovementIds.length, "winner_retention_map_movement_directive_count_invalid");
  const directiveIds = directives.map((row) => row?.movement_id);
  pushIf(blockers, JSON.stringify(directiveIds) !== JSON.stringify(blueprintMovementIds), "winner_retention_map_movement_coverage_invalid");
  for (const [index, directive] of directives.entries()) {
    for (const field of ["movement_id", "entry_hook", "promise_progress", "contrast_from_previous", "compression_target", "rehook_out"]) {
      pushIf(blockers, !nonEmpty(directive?.[field]), `winner_retention_map_movement_${index}_${field}_missing`);
    }
    if (audienceFeedbackEnabled) {
      for (const field of ["entry_question_id", "rehook_out_question_id"]) {
        pushIf(blockers, !nonEmpty(directive?.[field]), `winner_retention_map_movement_${index}_${field}_missing`);
        if (nonEmpty(directive?.[field])) questionReferenceIds.push(directive[field]);
      }
    }
    const turns = Array.isArray(directive?.turns) ? directive.turns : [];
    pushIf(blockers, turns.length < 2 || turns.length > 7, `winner_retention_map_movement_${index}_turn_count_invalid`);
    let turnWordTotal = 0;
    for (const [turnIndex, turn] of turns.entries()) {
      const expectedId = `${directive.movement_id}_turn_${String(turnIndex + 1).padStart(2, "0")}`;
      pushIf(blockers, turn?.id !== expectedId, `winner_retention_map_movement_${index}_turn_${turnIndex}_id_invalid`);
      const targetWords = Number(turn?.target_words);
      pushIf(blockers, !integerBetween(targetWords, 100, 500), `winner_retention_map_movement_${index}_turn_${turnIndex}_target_words_invalid`);
      if (Number.isInteger(targetWords)) turnWordTotal += targetWords;
      for (const field of ["trigger", "visible_event", "character_choice", "emotional_turn", "information_or_state_change", "viewer_question_after"]) {
        pushIf(blockers, !nonEmpty(turn?.[field]), `winner_retention_map_movement_${index}_turn_${turnIndex}_${field}_missing`);
      }
      if (audienceFeedbackEnabled) {
        pushIf(blockers, !nonEmpty(turn?.viewer_question_id_after), `winner_retention_map_movement_${index}_turn_${turnIndex}_question_id_missing`);
        if (nonEmpty(turn?.viewer_question_id_after)) questionReferenceIds.push(turn.viewer_question_id_after);
      }
    }
    const blueprintWords = Number(blueprintMovements[index]?.target_words ?? 0);
    const tolerance = Math.max(120, Math.round(blueprintWords * 0.2));
    pushIf(blockers, Math.abs(turnWordTotal - blueprintWords) > tolerance, `winner_retention_map_movement_${index}_turn_word_total_${turnWordTotal}_mismatch_${blueprintWords}`);
  }

  if (audienceFeedbackEnabled) {
    const questionLedger = Array.isArray(document?.question_payment_ledger) ? document.question_payment_ledger : [];
    pushIf(
      blockers,
      questionLedger.length < Math.max(2, Math.ceil(blueprintMovementIds.length / 2)),
      "winner_retention_map_question_payment_ledger_too_thin",
    );
    const questionById = new Map();
    for (const [index, row] of questionLedger.entries()) {
      for (const field of ["id", "question", "opened_in_movement_id", "paid_in_movement_id", "answer"]) {
        pushIf(blockers, !nonEmpty(row?.[field]), `winner_retention_map_question_${index}_${field}_missing`);
      }
      pushIf(blockers, questionById.has(row?.id), `winner_retention_map_question_${index}_id_duplicate`);
      if (nonEmpty(row?.id)) questionById.set(row.id, row);
      const openedIndex = blueprintMovementIds.indexOf(row?.opened_in_movement_id);
      const paidIndex = blueprintMovementIds.indexOf(row?.paid_in_movement_id);
      pushIf(blockers, openedIndex < 0, `winner_retention_map_question_${index}_open_movement_unknown`);
      pushIf(blockers, paidIndex < 0, `winner_retention_map_question_${index}_payment_movement_unknown`);
      pushIf(blockers, openedIndex >= 0 && paidIndex >= 0 && paidIndex < openedIndex, `winner_retention_map_question_${index}_paid_before_opened`);
      pushIf(blockers, row?.replacement_question_id === row?.id, `winner_retention_map_question_${index}_self_replacement`);
    }
    for (const [index, row] of questionLedger.entries()) {
      const replacementId = String(row?.replacement_question_id ?? "").trim();
      if (!replacementId) continue;
      const replacement = questionById.get(replacementId);
      pushIf(blockers, !replacement, `winner_retention_map_question_${index}_replacement_unknown`);
      if (!replacement) continue;
      const paidIndex = blueprintMovementIds.indexOf(row?.paid_in_movement_id);
      const replacementOpenIndex = blueprintMovementIds.indexOf(replacement?.opened_in_movement_id);
      pushIf(
        blockers,
        paidIndex >= 0 && replacementOpenIndex >= 0 && replacementOpenIndex < paidIndex,
        `winner_retention_map_question_${index}_replacement_opened_before_payment`,
      );
    }
    for (const id of questionById.keys()) {
      const chain = new Set();
      let cursor = id;
      while (cursor && questionById.has(cursor)) {
        if (chain.has(cursor)) {
          blockers.push(`winner_retention_map_question_${id}_replacement_cycle`);
          break;
        }
        chain.add(cursor);
        cursor = String(questionById.get(cursor)?.replacement_question_id ?? "").trim();
      }
    }
    const referencedQuestionIds = new Set(questionReferenceIds);
    for (const id of referencedQuestionIds) {
      pushIf(blockers, !questionById.has(id), `winner_retention_map_question_reference_${id}_unknown`);
    }
    for (const id of questionById.keys()) {
      pushIf(blockers, !referencedQuestionIds.has(id), `winner_retention_map_question_${id}_unreferenced`);
    }
  }

  pushIf(blockers, !Array.isArray(document?.retention_risk_register), "winner_retention_map_risk_register_missing");
  pushIf(blockers, !Array.isArray(document?.procedural_compression_targets), "winner_retention_map_procedural_targets_missing");
  pushIf(blockers, !Array.isArray(document?.repetition_budgets), "winner_retention_map_repetition_budgets_missing");
  return { done: blockers.length === 0, blockers };
}

export function reviewWinnerOpening(openingText, packageContract, {
  retentionMapSha256 = null,
  blueprintSha256 = null,
} = {}) {
  const blockers = [];
  const warnings = [];
  const normalized = normalizeWinnerNarration(openingText);
  const wordCount = countWords(normalized);
  const targetWords = Math.round(Number(packageContract?.intended_spoken_wpm ?? 187.5) * 5);
  const minimumWords = Math.floor(targetWords * 0.8);
  const maximumWords = Math.ceil(targetWords * 1.2);
  pushIf(blockers, wordCount < minimumWords, `winner_opening_probably_truncated_${wordCount}_below_${minimumWords}`);
  pushIf(blockers, wordCount > maximumWords, `winner_opening_too_long_${wordCount}_above_${maximumWords}`);
  if (/^#{1,6}\s+/m.test(normalized)) blockers.push("winner_opening_contains_markdown_heading");
  if (/^```/m.test(normalized)) blockers.push("winner_opening_contains_markdown_fence");
  if (/^(?:SCENE|CHAPTER|BLOCK|OUTLINE|NARRATOR|TITLE|THUMBNAIL|PREMISE|WORD COUNT)\s*[:#-]/im.test(normalized)) blockers.push("winner_opening_contains_non_narration_label");
  if (/\b(?:the narrator wants you to|the narrator will|in this script|this story teaches|the viewer should|that was the hook)\b/i.test(normalized)) blockers.push("winner_opening_contains_meta_narration");
  if (!/\bJoey Manhwa\b/.test(normalized.slice(0, 1_600))) warnings.push("winner_opening_joey_full_name_not_found_near_opening");
  return {
    schema: WINNER_OPENING_REPORT_SCHEMA,
    status: blockers.length ? "blocked" : "passed",
    source_workflow_profile: WINNER_SOURCE_ROOM_PROFILE,
    opening_sha256: sha256Text(normalized),
    opening_word_count: wordCount,
    target_word_count: targetWords,
    target_word_range: { minimum: minimumWords, maximum: maximumWords },
    winner_retention_map_sha256: retentionMapSha256,
    winner_story_blueprint_sha256: blueprintSha256,
    blockers,
    warnings,
    normalized_opening: normalized,
  };
}

export function validateWinnerOpeningApproval(approval, {
  openingSha256 = null,
  retentionMapSha256 = null,
  blueprintSha256 = null,
} = {}) {
  const blockers = [];
  pushIf(blockers, approval?.schema !== WINNER_OPENING_APPROVAL_SCHEMA, "winner_opening_approval_schema_invalid");
  pushIf(blockers, approval?.status !== "approved", "winner_opening_approval_not_approved");
  for (const field of [
    "channel", "development_slug", "selected_candidate_id", "opening_path", "opening_sha256",
    "winner_retention_map_sha256", "winner_story_blueprint_sha256", "approved_by", "approved_at",
  ]) pushIf(blockers, !nonEmpty(approval?.[field]), `winner_opening_approval_${field}_missing`);
  if (openingSha256) pushIf(blockers, approval?.opening_sha256 !== openingSha256, "winner_opening_approval_hash_mismatch");
  if (retentionMapSha256) pushIf(blockers, approval?.winner_retention_map_sha256 !== retentionMapSha256, "winner_opening_approval_retention_map_hash_mismatch");
  if (blueprintSha256) pushIf(blockers, approval?.winner_story_blueprint_sha256 !== blueprintSha256, "winner_opening_approval_blueprint_hash_mismatch");
  return { done: blockers.length === 0, blockers };
}

export function validateWinnerDevelopmentDiagnostic(document, {
  passId = null,
  sourceScriptSha256 = null,
  scriptText = null,
} = {}) {
  const blockers = [];
  const warnings = [];
  pushIf(blockers, document?.schema !== WINNER_DEVELOPMENT_DIAGNOSTIC_SCHEMA, "winner_development_diagnostic_schema_invalid");
  pushIf(blockers, document?.status !== "completed", "winner_development_diagnostic_not_completed");
  pushIf(blockers, !WINNER_DIAGNOSTIC_PASS_IDS.includes(document?.pass_id), "winner_development_diagnostic_pass_invalid");
  if (passId) pushIf(blockers, document?.pass_id !== passId, "winner_development_diagnostic_pass_mismatch");
  if (sourceScriptSha256) pushIf(blockers, document?.source_script_sha256 !== sourceScriptSha256, "winner_development_diagnostic_script_hash_mismatch");
  pushIf(blockers, !["pass", "revise"].includes(document?.decision), "winner_development_diagnostic_decision_invalid");
  pushIf(blockers, !Array.isArray(document?.strengths), "winner_development_diagnostic_strengths_missing");
  const findings = Array.isArray(document?.findings) ? document.findings : [];
  for (const [index, finding] of findings.entries()) {
    pushIf(blockers, !["high", "medium", "low"].includes(finding?.priority), `winner_development_diagnostic_finding_${index}_priority_invalid`);
    for (const field of ["id", "problem", "viewer_effect", "revision_goal"]) {
      pushIf(blockers, !nonEmpty(finding?.[field]), `winner_development_diagnostic_finding_${index}_${field}_missing`);
    }
    pushIf(blockers, !Array.isArray(finding?.protected_facts), `winner_development_diagnostic_finding_${index}_protected_facts_missing`);
    const anchor = String(finding?.evidence_anchor ?? "").trim();
    pushIf(blockers, !anchor, `winner_development_diagnostic_finding_${index}_evidence_anchor_missing`);
    if (scriptText && anchor && !String(scriptText).includes(anchor)) {
      warnings.push(`winner_development_diagnostic_finding_${index}_anchor_not_exact`);
    }
  }
  pushIf(blockers, document?.decision === "revise" && findings.length < 1, "winner_development_diagnostic_revise_without_findings");
  pushIf(blockers, !nonEmpty(document?.summary), "winner_development_diagnostic_summary_missing");
  return { done: blockers.length === 0, blockers, warnings };
}

export function validateWinnerRevisionReport(report, {
  expectedStage = null,
  sourceScriptSha256 = null,
  outputScriptSha256 = null,
  openingSha256 = null,
} = {}) {
  const blockers = [];
  pushIf(blockers, report?.schema !== WINNER_REVISION_REPORT_SCHEMA, "winner_revision_report_schema_invalid");
  pushIf(blockers, report?.status !== "passed", "winner_revision_report_not_passed");
  pushIf(blockers, !["integrated_revision", "line_flow_polish"].includes(report?.stage), "winner_revision_report_stage_invalid");
  if (expectedStage) pushIf(blockers, report?.stage !== expectedStage, "winner_revision_report_stage_mismatch");
  if (sourceScriptSha256) pushIf(blockers, report?.source_script_sha256 !== sourceScriptSha256, "winner_revision_report_source_hash_mismatch");
  if (outputScriptSha256) pushIf(blockers, report?.output_script_sha256 !== outputScriptSha256, "winner_revision_report_output_hash_mismatch");
  if (openingSha256) pushIf(blockers, report?.approved_opening_sha256 !== openingSha256, "winner_revision_report_opening_hash_mismatch");
  for (const field of [
    "source_script_path", "source_script_sha256", "output_script_path", "output_script_sha256",
    "approved_opening_sha256", "winner_story_blueprint_sha256", "winner_retention_map_sha256",
    "completed_at",
  ]) pushIf(blockers, !nonEmpty(report?.[field]), `winner_revision_report_${field}_missing`);
  return { done: blockers.length === 0, blockers };
}

export function assembleWinnerScriptWithApprovedOpening(openingText, continuationText) {
  const opening = normalizeWinnerNarration(openingText).trim();
  const continuation = normalizeWinnerNarration(continuationText).trim();
  if (!opening) throw new Error("Approved opening is empty.");
  if (!continuation) throw new Error("Winner script continuation is empty.");
  const openingSignature = opening.slice(0, Math.min(240, opening.length));
  if (openingSignature.length >= 80 && continuation.startsWith(openingSignature)) {
    throw new Error("Winner script continuation repeated the approved opening.");
  }
  return normalizeWinnerNarration(`${opening}\n\n${continuation}`);
}
