const DELTA_KINDS = new Set([
  "new_character_state",
  "new_action_or_contact",
  "new_relationship_evidence",
  "new_threat_or_obstacle",
  "new_power_or_rule",
  "new_evidence_or_object",
  "new_location_or_geography",
  "new_scale_or_status",
  "new_consequence_or_payoff",
  "new_question_or_uncertainty",
  "necessary_continuity_hold",
]);

const SHOT_SIZES = new Set(["extreme_wide", "wide", "medium", "close", "extreme_close", "insert"]);
const SEQUENCE_ROLES = new Set([
  "establish",
  "orient",
  "advance",
  "reveal",
  "react",
  "prove",
  "escalate",
  "climax",
  "resolve",
  "bridge",
]);
const VALUE_TIERS = new Set(["hero", "priority", "connective"]);
const HERO_TYPES = new Set([
  "package_proof",
  "opening_reversal",
  "first_visible_payoff",
  "major_reveal",
  "relationship_turn",
  "power_demonstration",
  "climax",
  "final_payoff",
]);
const RESET_KINDS = new Set(["analytics_earned", "story_earned", "none"]);
const MOTION_ROLES = new Set(["changes_understanding", "changes_emotion", "supports_clarity", "still_preferred"]);
const SCORE_BEHAVIORS = new Set(["hold", "build", "drop", "release", "silence", "no_change"]);
const SILENCE_BEHAVIORS = new Set(["preserve_before", "preserve_after", "preserve_both", "not_required"]);

function text(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function unique(values) {
  return [...new Set((values ?? []).map(String).map((value) => value.trim()).filter(Boolean))];
}

export function qualityBudgetForBeatValue(beatValue = {}) {
  const tier = VALUE_TIERS.has(String(beatValue?.tier)) ? String(beatValue.tier) : "connective";
  const momentTypes = unique(beatValue?.moment_types).filter((value) => HERO_TYPES.has(value));
  if (tier === "hero") {
    return {
      schema: "goldflow_visual_quality_budget_v1",
      tier,
      moment_types: momentTypes,
      image_candidate_count: 2,
      reference_priority: "highest",
      generated_motion_priority: "highest_when_motion_changes_meaning",
      sfx_priority: "semantic_only",
      qa_depth: "blind_alternative_selection_plus_semantic_raster_review",
    };
  }
  if (tier === "priority") {
    return {
      schema: "goldflow_visual_quality_budget_v1",
      tier,
      moment_types: momentTypes,
      image_candidate_count: 1,
      reference_priority: "high_if_identity_or_continuity_risk",
      generated_motion_priority: "editorial",
      sfx_priority: "semantic_only",
      qa_depth: "semantic_raster_review",
    };
  }
  return {
    schema: "goldflow_visual_quality_budget_v1",
    tier,
    moment_types: momentTypes,
    image_candidate_count: 1,
    reference_priority: "normal",
    generated_motion_priority: "only_if_required_or_exceptionally_useful",
    sfx_priority: "none_unless_visible_or_narrative_event",
    qa_depth: "structural_plus_advisory_aesthetic",
  };
}

export function normalizeVisualBeatQuality(row = {}) {
  const delta = row.visual_information_delta ?? {};
  const grammar = row.sequence_grammar ?? {};
  const spatial = row.spatial_continuity ?? {};
  const value = row.beat_value ?? {};
  const reset = row.retention_reset ?? {};
  const audiovisual = row.audiovisual_intent ?? {};
  const sfx = audiovisual.sfx_event && typeof audiovisual.sfx_event === "object"
    ? {
        event_id: text(audiovisual.sfx_event.event_id),
        physical_or_editorial_cause: text(audiovisual.sfx_event.physical_or_editorial_cause),
        timing: text(audiovisual.sfx_event.timing),
        purpose: text(audiovisual.sfx_event.purpose),
      }
    : null;
  const normalizedValue = {
    tier: text(value.tier),
    moment_types: unique(value.moment_types),
    reason: text(value.reason),
  };
  return {
    visual_information_delta: {
      kind: text(delta.kind),
      statement: text(delta.statement),
      compared_to_previous: text(delta.compared_to_previous),
    },
    sequence_grammar: {
      shot_size: text(grammar.shot_size),
      camera_angle: text(grammar.camera_angle),
      vantage: text(grammar.vantage),
      sequence_role: text(grammar.sequence_role),
    },
    spatial_continuity: {
      eyeline_axis: text(spatial.eyeline_axis) || "not_applicable",
      primary_screen_position: text(spatial.primary_screen_position) || "not_applicable",
      primary_facing: text(spatial.primary_facing) || "not_applicable",
      threat_or_counterparty_position: text(spatial.threat_or_counterparty_position) || "not_applicable",
      travel_direction: text(spatial.travel_direction) || "not_applicable",
      object_geography: text(spatial.object_geography) || "not_applicable",
      intentional_axis_break: spatial.intentional_axis_break === true,
      axis_break_reason: text(spatial.axis_break_reason) || null,
    },
    beat_value: normalizedValue,
    retention_reset: {
      kind: text(reset.kind),
      evidence_ids: unique(reset.evidence_ids),
      purpose: text(reset.purpose),
    },
    audiovisual_intent: {
      emphasis_moment_ids: unique(audiovisual.emphasis_moment_ids),
      motion_role: text(audiovisual.motion_role),
      sfx_event: sfx,
      score_behavior: text(audiovisual.score_behavior),
      silence_behavior: text(audiovisual.silence_behavior),
      subtitle_emphasis: unique(audiovisual.subtitle_emphasis),
      coordination_note: text(audiovisual.coordination_note),
    },
    quality_budget: qualityBudgetForBeatValue(normalizedValue),
  };
}

export function visualBeatQualityContractFindings(rows, {
  analyticsEvidenceIds = [],
  emphasisMomentIds = [],
} = {}) {
  const findings = [];
  const allowedAnalyticsIds = new Set(unique(analyticsEvidenceIds));
  const allowedEmphasisIds = new Set(unique(emphasisMomentIds));
  const normalized = rows.map(normalizeVisualBeatQuality);
  normalized.forEach((quality, rowIndex) => {
    const delta = quality.visual_information_delta;
    if (!DELTA_KINDS.has(delta.kind) || !delta.statement || !delta.compared_to_previous) {
      findings.push({ severity: "blocker", code: "visual_information_delta_incomplete", row_index: rowIndex });
    }
    const grammar = quality.sequence_grammar;
    if (!SHOT_SIZES.has(grammar.shot_size)
      || !SEQUENCE_ROLES.has(grammar.sequence_role)
      || !grammar.camera_angle
      || !grammar.vantage) {
      findings.push({ severity: "blocker", code: "visual_sequence_grammar_incomplete", row_index: rowIndex });
    }
    const value = quality.beat_value;
    if (!VALUE_TIERS.has(value.tier) || !value.reason) {
      findings.push({ severity: "blocker", code: "visual_beat_value_incomplete", row_index: rowIndex });
    }
    if (value.tier === "hero" && !value.moment_types.some((kind) => HERO_TYPES.has(kind))) {
      findings.push({ severity: "blocker", code: "visual_hero_beat_type_missing", row_index: rowIndex });
    }
    if (value.tier !== "hero" && value.moment_types.some((kind) => HERO_TYPES.has(kind))) {
      findings.push({ severity: "warning", code: "visual_hero_moment_under_tiered", row_index: rowIndex });
    }
    const reset = quality.retention_reset;
    if (!RESET_KINDS.has(reset.kind) || !reset.purpose) {
      findings.push({ severity: "blocker", code: "visual_retention_reset_incomplete", row_index: rowIndex });
    }
    if (reset.kind === "analytics_earned") {
      if (!reset.evidence_ids.length
        || reset.evidence_ids.some((id) => !allowedAnalyticsIds.has(id))) {
        findings.push({ severity: "blocker", code: "visual_retention_reset_evidence_invalid", row_index: rowIndex });
      }
    } else if (reset.evidence_ids.length) {
      findings.push({ severity: "warning", code: "visual_retention_reset_unused_evidence", row_index: rowIndex });
    }
    const audiovisual = quality.audiovisual_intent;
    if (audiovisual.emphasis_moment_ids.some((id) => !allowedEmphasisIds.has(id))) {
      findings.push({ severity: "blocker", code: "visual_audiovisual_emphasis_binding_invalid", row_index: rowIndex });
    }
    if (!MOTION_ROLES.has(audiovisual.motion_role)
      || !SCORE_BEHAVIORS.has(audiovisual.score_behavior)
      || !SILENCE_BEHAVIORS.has(audiovisual.silence_behavior)
      || !audiovisual.coordination_note) {
      findings.push({ severity: "blocker", code: "visual_audiovisual_intent_incomplete", row_index: rowIndex });
    }
    if (audiovisual.sfx_event && Object.values(audiovisual.sfx_event).some((entry) => !entry)) {
      findings.push({ severity: "blocker", code: "visual_semantic_sfx_event_incomplete", row_index: rowIndex });
    }
    if (delta.kind === "necessary_continuity_hold" && value.tier === "hero") {
      findings.push({ severity: "warning", code: "visual_hero_beat_has_no_new_information", row_index: rowIndex });
    }
    const spatial = quality.spatial_continuity;
    if (spatial.intentional_axis_break && !spatial.axis_break_reason) {
      findings.push({ severity: "blocker", code: "visual_axis_break_reason_missing", row_index: rowIndex });
    }
  });

  for (let index = 3; index < normalized.length; index += 1) {
    const window = normalized.slice(index - 3, index + 1);
    if (new Set(window.map((row) => row.sequence_grammar.shot_size)).size === 1
      && new Set(window.map((row) => row.sequence_grammar.sequence_role)).size <= 2) {
      findings.push({
        severity: "warning",
        code: "visual_sequence_repeated_framing_streak",
        row_index: index,
        shot_size: window[0].sequence_grammar.shot_size,
        streak_length: 4,
      });
    }
  }
  return findings;
}

export function visualBeatQualityContractSchema() {
  return {
    schema: "goldflow_visual_beat_quality_contract_v1",
    delta_kinds: [...DELTA_KINDS],
    shot_sizes: [...SHOT_SIZES],
    sequence_roles: [...SEQUENCE_ROLES],
    value_tiers: [...VALUE_TIERS],
    hero_types: [...HERO_TYPES],
    reset_kinds: [...RESET_KINDS],
    motion_roles: [...MOTION_ROLES],
    score_behaviors: [...SCORE_BEHAVIORS],
    silence_behaviors: [...SILENCE_BEHAVIORS],
  };
}
