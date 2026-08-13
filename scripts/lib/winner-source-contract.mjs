import { createHash } from "node:crypto";

export const WINNER_FORMULA_SCHEMA = "goldflow_channel_winner_formula_v1";
export const WINNER_EVIDENCE_SNAPSHOT_SCHEMA = "goldflow_source_evidence_snapshot_v1";
export const WINNER_IDEATION_SCHEMA = "goldflow_winner_ideation_candidates_v1";
export const WINNER_IDEATION_REPORT_SCHEMA = "goldflow_winner_ideation_report_v1";
export const WINNER_PACKAGE_CONTRACT_SCHEMA = "goldflow_source_winner_package_v1";
export const WINNER_PACKAGE_APPROVAL_SCHEMA = "goldflow_source_winner_package_approval_v1";
export const WINNER_STORY_BLUEPRINT_SCHEMA = "goldflow_winner_story_blueprint_v1";
export const WINNER_STORY_BLUEPRINT_APPROVAL_SCHEMA = "goldflow_winner_story_blueprint_approval_v1";
export const WINNER_SCRIPT_GENERATION_REPORT_SCHEMA = "goldflow_winner_script_generation_report_v1";
export const WINNER_SCRIPT_GATE_SCHEMA = "goldflow_winner_script_gate_v1";
export const WINNER_SOURCE_RELEASE_SCHEMA = "goldflow_winner_source_release_v1";
export const WINNER_SOURCE_ROOM_PROFILE = "retention_drama_room_v1";

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

export const WINNER_BLUEPRINT_OPENING_CHECKPOINT_IDS = [
  "0_30_seconds",
  "30_60_seconds",
  "60_90_seconds",
  "90_180_seconds",
  "180_300_seconds",
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

function nextNonWhitespaceIndex(value, startIndex) {
  let index = startIndex;
  while (index < value.length && /\s/.test(value[index])) index += 1;
  return index;
}

function looksLikeObjectKeyAfterComma(value, commaIndex) {
  const keyStart = nextNonWhitespaceIndex(value, commaIndex + 1);
  if (value[keyStart] !== '"') return false;
  let escaped = false;
  for (let index = keyStart + 1; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character !== '"') continue;
    const separatorIndex = nextNonWhitespaceIndex(value, index + 1);
    return value[separatorIndex] === ":";
  }
  return false;
}

function looksLikeArrayValueAfterComma(value, commaIndex) {
  const valueStart = nextNonWhitespaceIndex(value, commaIndex + 1);
  const character = value[valueStart] ?? "";
  if ('"{[-'.includes(character) || /[0-9]/.test(character)) return true;
  return value.startsWith("true", valueStart)
    || value.startsWith("false", valueStart)
    || value.startsWith("null", valueStart);
}

function repairUnescapedJsonStringQuotes(value) {
  const output = [];
  const stack = [];
  let stringRole = null;
  let escaped = false;

  const markValueComplete = () => {
    const parent = stack.at(-1);
    if (parent) parent.expect = "comma_or_end";
  };

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (stringRole) {
      if (escaped) {
        output.push(character);
        escaped = false;
        continue;
      }
      if (character === "\\") {
        output.push(character);
        escaped = true;
        continue;
      }
      if (character !== '"') {
        output.push(character);
        continue;
      }

      const parent = stack.at(-1) ?? null;
      const nextIndex = nextNonWhitespaceIndex(value, index + 1);
      const nextCharacter = value[nextIndex] ?? "";
      let closesString = false;
      if (stringRole === "key") {
        closesString = nextCharacter === ":";
      } else if (!parent) {
        closesString = nextCharacter === "";
      } else if (parent.type === "object") {
        closesString = nextCharacter === "}"
          || (nextCharacter === "," && looksLikeObjectKeyAfterComma(value, nextIndex));
      } else {
        closesString = nextCharacter === "]"
          || (nextCharacter === "," && looksLikeArrayValueAfterComma(value, nextIndex));
      }

      if (!closesString) {
        output.push('\\"');
        continue;
      }
      output.push(character);
      if (stringRole === "key") parent.expect = "colon";
      else markValueComplete();
      stringRole = null;
      continue;
    }

    output.push(character);
    if (/\s/.test(character)) continue;
    const parent = stack.at(-1) ?? null;
    if (character === "{") {
      stack.push({ type: "object", expect: "key_or_end" });
    } else if (character === "[") {
      stack.push({ type: "array", expect: "value_or_end" });
    } else if (character === "}") {
      stack.pop();
      markValueComplete();
    } else if (character === "]") {
      stack.pop();
      markValueComplete();
    } else if (character === '"') {
      stringRole = parent?.type === "object" && parent.expect === "key_or_end" ? "key" : "value";
    } else if (character === ":" && parent?.type === "object") {
      parent.expect = "value";
    } else if (character === "," && parent) {
      parent.expect = parent.type === "object" ? "key_or_end" : "value_or_end";
    }
  }
  return output.join("");
}

export function extractJsonObject(value) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error("Empty model response; expected one JSON object.");
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  const candidates = [unfenced];
  if (start >= 0 && end > start && (start !== 0 || end !== unfenced.length - 1)) {
    candidates.push(unfenced.slice(start, end + 1));
  }
  let lastError = null;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(repairUnescapedJsonStringQuotes(candidate));
    } catch (error) {
      lastError = error;
    }
  }
  if (start < 0 || end <= start) throw new Error("Model response did not contain a JSON object.");
  throw lastError;
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

export function validateSourceEvidenceSnapshot(snapshot) {
  const blockers = [];
  pushIf(blockers, snapshot?.schema !== WINNER_EVIDENCE_SNAPSHOT_SCHEMA, "source_evidence_snapshot_schema_invalid");
  pushIf(blockers, snapshot?.status !== "active", "source_evidence_snapshot_not_active");
  for (const field of ["channel", "channel_name", "version", "observed_through"]) {
    pushIf(blockers, !nonEmpty(snapshot?.[field]), `source_evidence_snapshot_${field}_missing`);
  }
  pushIf(blockers, !Array.isArray(snapshot?.source_paths) || snapshot.source_paths.length < 2, "source_evidence_snapshot_sources_too_thin");
  pushIf(
    blockers,
    !Number.isFinite(Number(snapshot?.research_scope?.primary_english_timed_transcripts))
      || Number(snapshot.research_scope.primary_english_timed_transcripts) < 10,
    "source_evidence_snapshot_primary_corpus_too_thin",
  );
  const openingModes = Array.isArray(snapshot?.market_opening_modes) ? snapshot.market_opening_modes : [];
  const openingIds = new Set(openingModes.map((row) => String(row?.id ?? "").trim()));
  for (const id of ["visible_proof_or_payoff", "wound_or_identity_contradiction", "direct_premise_or_mechanic"]) {
    pushIf(blockers, !openingIds.has(id), `source_evidence_snapshot_opening_mode_${id}_missing`);
  }
  pushIf(blockers, !Array.isArray(snapshot?.own_channel_evidence) || snapshot.own_channel_evidence.length < 3, "source_evidence_snapshot_own_channel_evidence_too_thin");
  pushIf(blockers, !Array.isArray(snapshot?.own_channel_negative_evidence) || snapshot.own_channel_negative_evidence.length < 1, "source_evidence_snapshot_negative_evidence_missing");
  pushIf(blockers, !snapshot?.decision_policy || typeof snapshot.decision_policy !== "object", "source_evidence_snapshot_decision_policy_missing");
  return { done: blockers.length === 0, blockers };
}

export function validateWinnerStoryBlueprint(blueprint, {
  packageContract = null,
  packageSha256 = null,
} = {}) {
  const blockers = [];
  pushIf(blockers, blueprint?.schema !== WINNER_STORY_BLUEPRINT_SCHEMA, "winner_blueprint_schema_invalid");
  pushIf(blockers, blueprint?.status !== "planned", "winner_blueprint_not_planned");
  for (const field of [
    "channel", "development_slug", "selected_candidate_id", "selected_title",
    "winner_package_sha256", "planned_at",
  ]) pushIf(blockers, !nonEmpty(blueprint?.[field]), `winner_blueprint_${field}_missing`);
  if (packageContract) {
    pushIf(blockers, blueprint?.channel !== packageContract.channel, "winner_blueprint_channel_mismatch");
    pushIf(blockers, blueprint?.development_slug !== packageContract.development_slug, "winner_blueprint_development_slug_mismatch");
    pushIf(blockers, blueprint?.selected_candidate_id !== packageContract.selected_candidate_id, "winner_blueprint_candidate_mismatch");
    pushIf(blockers, blueprint?.selected_title !== packageContract.selected_title, "winner_blueprint_title_mismatch");
  }
  if (packageSha256) pushIf(blockers, blueprint?.winner_package_sha256 !== packageSha256, "winner_blueprint_package_hash_mismatch");

  const narration = blueprint?.narration_contract ?? {};
  pushIf(blockers, !["first_person", "third_person"].includes(narration.pov), "winner_blueprint_pov_invalid");
  pushIf(blockers, !["present", "past"].includes(narration.tense), "winner_blueprint_tense_invalid");
  for (const field of ["voice", "dialogue_policy", "choice_reason"]) {
    pushIf(blockers, !nonEmpty(narration[field]), `winner_blueprint_narration_${field}_missing`);
  }

  const opening = blueprint?.opening_contract ?? {};
  pushIf(
    blockers,
    !["visible_proof_or_payoff", "wound_or_identity_contradiction", "direct_premise_or_mechanic"].includes(opening.mode),
    "winner_blueprint_opening_mode_invalid",
  );
  pushIf(blockers, !nonEmpty(opening.rewind_policy), "winner_blueprint_rewind_policy_missing");
  const checkpoints = Array.isArray(opening.checkpoints) ? opening.checkpoints : [];
  pushIf(blockers, checkpoints.length !== WINNER_BLUEPRINT_OPENING_CHECKPOINT_IDS.length, "winner_blueprint_opening_checkpoint_count_invalid");
  const checkpointById = new Map(checkpoints.map((row) => [row?.id, row]));
  let previousWordEnd = 0;
  for (const id of WINNER_BLUEPRINT_OPENING_CHECKPOINT_IDS) {
    const row = checkpointById.get(id);
    pushIf(blockers, !row, `winner_blueprint_opening_checkpoint_${id}_missing`);
    if (!row) continue;
    const targetWordEnd = Number(row.target_word_end);
    pushIf(blockers, !Number.isInteger(targetWordEnd) || targetWordEnd <= previousWordEnd, `winner_blueprint_opening_checkpoint_${id}_word_end_invalid`);
    if (Number.isInteger(targetWordEnd)) previousWordEnd = targetWordEnd;
    for (const field of ["visible_event", "consequence_or_state_change", "viewer_question"]) {
      pushIf(blockers, !nonEmpty(row[field]), `winner_blueprint_opening_checkpoint_${id}_${field}_missing`);
    }
  }

  const canon = blueprint?.canon ?? {};
  for (const field of ["name", "initial_condition", "core_desire", "final_condition"]) {
    pushIf(blockers, !nonEmpty(canon?.protagonist?.[field]), `winner_blueprint_protagonist_${field}_missing`);
  }
  for (const field of ["recurring_characters", "advantage_rules", "execution_bridges", "recurring_locations", "critical_props_or_ui", "immutable_facts"]) {
    pushIf(blockers, !Array.isArray(canon?.[field]), `winner_blueprint_canon_${field}_missing`);
  }
  pushIf(blockers, !Array.isArray(canon?.advantage_rules) || canon.advantage_rules.filter(nonEmpty).length < 1, "winner_blueprint_advantage_rules_too_thin");
  pushIf(blockers, !Array.isArray(canon?.immutable_facts) || canon.immutable_facts.filter(nonEmpty).length < 3, "winner_blueprint_immutable_facts_too_thin");

  const movements = Array.isArray(blueprint?.movements) ? blueprint.movements : [];
  pushIf(blockers, movements.length < 8 || movements.length > 10, "winner_blueprint_movement_count_invalid");
  let targetWordTotal = 0;
  const movementIds = [];
  const seenMovementIds = new Set();
  for (const [index, movement] of movements.entries()) {
    const expectedId = `movement_${String(index + 1).padStart(2, "0")}`;
    const id = String(movement?.id ?? "").trim();
    movementIds.push(id);
    pushIf(blockers, id !== expectedId, `winner_blueprint_movement_${index}_id_invalid`);
    pushIf(blockers, seenMovementIds.has(id), `winner_blueprint_movement_${index}_id_duplicate`);
    seenMovementIds.add(id);
    const targetWords = Number(movement?.target_words);
    pushIf(blockers, !Number.isInteger(targetWords) || targetWords < 100, `winner_blueprint_movement_${index}_target_words_invalid`);
    if (Number.isInteger(targetWords)) targetWordTotal += targetWords;
    for (const field of [
      "start_state", "objective", "obstacle", "joey_choice", "concrete_execution",
      "opposition_response", "result", "cause_into_next", "unique_function",
      "location_or_arena", "package_payoff_role",
    ]) pushIf(blockers, !nonEmpty(movement?.[field]), `winner_blueprint_movement_${index}_${field}_missing`);
    pushIf(blockers, !Array.isArray(movement?.state_changes) || movement.state_changes.filter(nonEmpty).length < 2, `winner_blueprint_movement_${index}_state_changes_too_thin`);
  }
  if (packageContract) {
    const minimum = Number(packageContract?.target_word_range?.minimum ?? 0);
    const maximum = Number(packageContract?.target_word_range?.maximum ?? Number.POSITIVE_INFINITY);
    pushIf(blockers, targetWordTotal < minimum || targetWordTotal > maximum, `winner_blueprint_target_word_total_${targetWordTotal}_outside_${minimum}_${maximum}`);
  }

  for (const field of ["setup_paid_off", "joey_decisive_action", "antagonist_response", "visible_result", "antagonist_concrete_loss"]) {
    const value = blueprint?.climax_contract?.[field];
    pushIf(blockers, field === "setup_paid_off" ? !Array.isArray(value) || value.filter(nonEmpty).length < 2 : !nonEmpty(value), `winner_blueprint_climax_${field}_missing`);
  }
  for (const field of ["final_boundary", "changed_equilibrium", "stop_point"]) {
    pushIf(blockers, !nonEmpty(blueprint?.ending_contract?.[field]), `winner_blueprint_ending_${field}_missing`);
  }
  pushIf(blockers, !Array.isArray(blueprint?.continuity_watchlist) || blueprint.continuity_watchlist.filter(nonEmpty).length < 3, "winner_blueprint_continuity_watchlist_too_thin");
  pushIf(blockers, !Array.isArray(blueprint?.repetition_watchlist) || blueprint.repetition_watchlist.filter(nonEmpty).length < 2, "winner_blueprint_repetition_watchlist_too_thin");

  const sectionPlan = Array.isArray(blueprint?.section_plan) ? blueprint.section_plan : [];
  pushIf(blockers, sectionPlan.length < 2, "winner_blueprint_section_plan_too_thin");
  const plannedMovementIds = sectionPlan.flatMap((row) => Array.isArray(row?.movement_ids) ? row.movement_ids : []);
  pushIf(blockers, JSON.stringify(plannedMovementIds) !== JSON.stringify(movementIds), "winner_blueprint_section_plan_movement_coverage_invalid");
  for (const [index, section] of sectionPlan.entries()) {
    pushIf(blockers, !/^section_\d{2}$/.test(String(section?.id ?? "")), `winner_blueprint_section_${index}_id_invalid`);
    pushIf(blockers, !nonEmpty(section?.entry_state), `winner_blueprint_section_${index}_entry_state_missing`);
    pushIf(blockers, !nonEmpty(section?.exit_state), `winner_blueprint_section_${index}_exit_state_missing`);
  }
  return { done: blockers.length === 0, blockers, target_word_total: targetWordTotal };
}

export function validateWinnerStoryBlueprintApproval(approval, { blueprintSha256 = null } = {}) {
  const blockers = [];
  pushIf(blockers, approval?.schema !== WINNER_STORY_BLUEPRINT_APPROVAL_SCHEMA, "winner_blueprint_approval_schema_invalid");
  pushIf(blockers, approval?.status !== "approved", "winner_blueprint_approval_not_approved");
  for (const field of [
    "channel", "development_slug", "selected_candidate_id", "winner_story_blueprint_path",
    "winner_story_blueprint_sha256", "approved_by", "approved_at",
  ]) pushIf(blockers, !nonEmpty(approval?.[field]), `winner_blueprint_approval_${field}_missing`);
  if (blueprintSha256) pushIf(blockers, approval?.winner_story_blueprint_sha256 !== blueprintSha256, "winner_blueprint_approval_hash_mismatch");
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
  if (document?.source_workflow_profile != null) {
    pushIf(
      documentBlockers,
      document.source_workflow_profile !== WINNER_SOURCE_ROOM_PROFILE,
      "ideation_source_workflow_profile_invalid",
    );
  }
  const dramaRoomEnabled = document?.source_workflow_profile === WINNER_SOURCE_ROOM_PROFILE;
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
    if (Array.isArray(formula?.package_contract?.pairing) && formula.package_contract.pairing.length > 0) {
      for (const field of ["title_supplies", "thumbnail_adds", "package_open_loop", "proof_device", "literal_payment_scene"]) {
        pushIf(blockers, !nonEmpty(thumbnail[field]), `thumbnail_${field}_missing`);
      }
      pushIf(
        blockers,
        nonEmpty(thumbnail.title_supplies)
          && nonEmpty(thumbnail.thumbnail_adds)
          && String(thumbnail.title_supplies).trim().toLowerCase() === String(thumbnail.thumbnail_adds).trim().toLowerCase(),
        "title_thumbnail_pair_not_additive",
      );
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
    if (dramaRoomEnabled) {
      const dramatic = candidate?.dramatic_contract ?? {};
      for (const field of [
        "emotional_promise",
        "central_relationship_question",
        "joey_wound_or_misbelief",
        "antagonist_human_logic",
        "supporting_character_agency",
        "midpoint_human_transformation",
        "warmth_or_relief_source",
        "recurring_emotional_object",
        "procedural_risk",
      ]) pushIf(blockers, !nonEmpty(dramatic[field]), `dramatic_contract_${field}_missing`);
    }
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
    dramatic_contract: candidate.dramatic_contract ?? null,
    differentiation: candidate.differentiation,
    evidence_ids: candidate.evidence_ids,
    weighted_score: candidate.computed.weighted_score,
    target_runtime_minutes: targetMinutes,
    intended_spoken_wpm: targetWpm,
    target_word_range: wordRange,
    source_workflow_profile: WINNER_SOURCE_ROOM_PROFILE,
    retention_objective: {
      metric: "average_percentage_viewed",
      target_percent: 50,
      contract: "upload_measurement_target_not_model_prediction",
      diagnostic_checkpoints: ["30_seconds", "60_seconds", "3_minutes", "5_minutes", "25_percent", "50_percent", "75_percent", "completion"],
    },
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
  if (contract?.source_workflow_profile != null) {
    pushIf(blockers, contract.source_workflow_profile !== WINNER_SOURCE_ROOM_PROFILE, "winner_package_source_workflow_profile_invalid");
    pushIf(blockers, contract?.retention_objective?.metric !== "average_percentage_viewed", "winner_package_retention_metric_invalid");
    pushIf(blockers, Number(contract?.retention_objective?.target_percent) !== 50, "winner_package_retention_target_must_equal_50");
    pushIf(
      blockers,
      contract?.retention_objective?.contract !== "upload_measurement_target_not_model_prediction",
      "winner_package_retention_contract_invalid",
    );
    const dramatic = contract?.dramatic_contract ?? {};
    for (const field of [
      "emotional_promise",
      "central_relationship_question",
      "joey_wound_or_misbelief",
      "antagonist_human_logic",
      "supporting_character_agency",
      "midpoint_human_transformation",
      "warmth_or_relief_source",
      "recurring_emotional_object",
      "procedural_risk",
    ]) pushIf(blockers, !nonEmpty(dramatic[field]), `winner_package_dramatic_contract_${field}_missing`);
  }
  return { done: blockers.length === 0, blockers };
}

function narrationPovDiagnostic(script) {
  const outsideDialogue = String(script ?? "")
    .replace(/[“"][\s\S]*?[”"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = outsideDialogue.match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g) ?? [];
  const normalize = (value) => value.toLowerCase().replaceAll("’", "'");
  const normalized = tokens.map(normalize);
  const firstPerson = new Set(["i", "i'm", "i've", "i'd", "i'll", "me", "my", "mine", "myself", "we", "us", "our", "ours"]);
  const thirdPerson = new Set(["joey", "he", "he's", "he'd", "he'll", "him", "his", "himself"]);
  const countSignals = (values) => ({
    first_person: values.filter((token) => firstPerson.has(token)).length,
    third_person: values.filter((token) => thirdPerson.has(token)).length,
  });
  const opening = countSignals(normalized.slice(0, 180));
  const postOpening = countSignals(normalized.slice(180, 1500));
  const full = countSignals(normalized);
  let likelyPov = "unclear";
  if (full.first_person >= Math.max(8, full.third_person * 1.5)) likelyPov = "first_person";
  if (full.third_person >= Math.max(8, full.first_person * 1.5)) likelyPov = "third_person";
  const likelyOpeningSwitch = opening.first_person >= 3 && postOpening.third_person >= 10
    ? "first_to_third"
    : opening.third_person >= 8 && postOpening.first_person >= 8
      ? "third_to_first"
      : null;
  return {
    dialogue_stripped_token_count: normalized.length,
    likely_pov: likelyPov,
    likely_opening_switch: likelyOpeningSwitch,
    opening_signals: opening,
    post_opening_signals: postOpening,
    full_signals: full,
  };
}

export function deterministicWinnerScriptReview(script, packageContract, { blueprint = null } = {}) {
  const blockers = [];
  const warnings = [];
  const normalized = normalizeWinnerNarration(script);
  const wordCount = countWords(normalized);
  const minimum = Number(packageContract?.target_word_range?.minimum ?? 0);
  const maximum = Number(packageContract?.target_word_range?.maximum ?? Number.POSITIVE_INFINITY);
  const probableTruncationFloor = Math.max(500, Math.round(minimum * 0.7));
  pushIf(blockers, wordCount < probableTruncationFloor, `script_probably_truncated_${wordCount}_below_${probableTruncationFloor}`);
  pushIf(
    blockers,
    Boolean(normalized.trim()) && !/[.!?](?:["')\]}]+)?$/.test(normalized.trimEnd()),
    "script_terminal_sentence_incomplete",
  );
  if (wordCount < minimum) warnings.push(`script_word_count_below_target_${wordCount}_of_${minimum}`);
  if (wordCount > maximum) warnings.push(`script_word_count_above_target_${wordCount}_of_${maximum}`);
  if (/^#{1,6}\s+/m.test(normalized)) warnings.push("script_contains_markdown_heading");
  if (/^```/m.test(normalized)) warnings.push("script_contains_markdown_fence");
  if (/^(?:SCENE|CHAPTER|BLOCK|OUTLINE|NARRATOR|TITLE|THUMBNAIL|PREMISE|WORD COUNT)\s*[:#-]/im.test(normalized)) warnings.push("script_contains_non_narration_label");
  if (/^\s*[-*]\s+/m.test(normalized)) warnings.push("script_contains_markdown_list");
  if (/\b(?:the narrator wants you to|the narrator will|in this script|this story teaches|the viewer should)\b/i.test(normalized)) warnings.push("script_contains_meta_narration");
  if (!/\bJoey Manhwa\b/.test(normalized.slice(0, 1400))) warnings.push("joey_full_name_not_found_near_opening");
  const povDiagnostic = narrationPovDiagnostic(normalized);
  if (povDiagnostic.likely_opening_switch) warnings.push(`script_pov_switch_${povDiagnostic.likely_opening_switch}_near_opening`);
  const expectedPov = blueprint?.narration_contract?.pov ?? null;
  if (expectedPov && povDiagnostic.likely_pov !== "unclear" && povDiagnostic.likely_pov !== expectedPov) {
    warnings.push(`script_pov_${povDiagnostic.likely_pov}_does_not_match_blueprint_${expectedPov}`);
  }
  const openingWordTarget = Math.round(Number(packageContract?.intended_spoken_wpm ?? 187.5) / 2);
  return {
    status: blockers.length ? "blocked" : "passed",
    source_script_sha256: sha256Text(normalized),
    source_word_count: wordCount,
    target_word_range: { minimum, maximum },
    estimated_opening_30_second_words: openingWordTarget,
    blueprint_sha256: blueprint ? sha256Text(JSON.stringify(blueprint)) : null,
    pov_diagnostic: povDiagnostic,
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
  const blueprintFields = [
    "winner_story_blueprint_path",
    "winner_story_blueprint_sha256",
    "winner_story_blueprint_approval_path",
  ];
  if (blueprintFields.some((field) => nonEmpty(release?.[field]))) {
    for (const field of blueprintFields) {
      pushIf(blockers, !nonEmpty(release?.[field]), `winner_release_${field}_missing`);
    }
  }
  if (nonEmpty(release?.audience_feedback_contract_version)) {
    pushIf(blockers, release.audience_feedback_contract_version !== "2026-08-09.1", "winner_release_audience_feedback_contract_version_invalid");
    for (const field of [
      "winner_blueprint_audience_audit_path",
      "winner_blueprint_audience_audit_sha256",
      "winner_blueprint_audience_audit_decision",
    ]) pushIf(blockers, !nonEmpty(release?.[field]), `winner_release_${field}_missing`);
    pushIf(blockers, !["pass", "revise"].includes(release?.winner_blueprint_audience_audit_decision), "winner_release_blueprint_audience_audit_decision_invalid");
    if (release?.winner_blueprint_audience_audit_decision === "revise") {
      pushIf(
        blockers,
        release?.winner_blueprint_audience_audit_risk_override?.approved !== true
          || !nonEmpty(release?.winner_blueprint_audience_audit_risk_override?.reason),
        "winner_release_blueprint_audience_audit_revision_not_overridden",
      );
    }
  }
  if (sourceText != null) {
    pushIf(blockers, sha256Text(normalizeWinnerNarration(sourceText)) !== release?.source_script_sha256, "winner_release_source_hash_mismatch");
  }
  if (packageContract) {
    pushIf(blockers, release?.channel !== packageContract.channel, "winner_release_channel_mismatch");
    pushIf(blockers, release?.selected_title !== packageContract.selected_title, "winner_release_title_mismatch");
    if (packageContract.source_workflow_profile === WINNER_SOURCE_ROOM_PROFILE) {
      pushIf(blockers, release?.source_workflow_profile !== WINNER_SOURCE_ROOM_PROFILE, "winner_release_source_workflow_profile_invalid");
      for (const field of [
        "winner_retention_map_path",
        "winner_retention_map_sha256",
        "winner_opening_path",
        "winner_opening_sha256",
        "winner_opening_approval_path",
        "script_development_report_path",
        "script_development_report_sha256",
        "winner_development_diagnostics_manifest_path",
        "winner_development_diagnostics_manifest_sha256",
        "winner_integrated_revision_report_path",
        "winner_integrated_revision_report_sha256",
        "winner_line_flow_polish_report_path",
        "winner_line_flow_polish_report_sha256",
      ]) pushIf(blockers, !nonEmpty(release?.[field]), `winner_release_${field}_missing`);
    }
  }
  return { done: blockers.length === 0, blockers };
}
