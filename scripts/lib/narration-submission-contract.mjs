import { createHash } from "node:crypto";

export const COHERENT_THOUGHT_SUBMISSION_POLICY = "coherent_thought_groups_v1";
export const COHERENT_THOUGHT_DIRECTION_SCHEMA = "goldflow_narration_actionable_direction_v4";

export const NARRATION_SHORT_UNIT_REASONS = Object.freeze([
  "dramatic_line", "revelation", "system_announcement", "chapter_or_delivery_transition",
  "complete_short_thought", "packet_boundary", "hard_limit_neighbor", "episode_boundary",
]);
export const NARRATION_BOUNDARY_INTENTS = Object.freeze({
  continuation: ["connected_thought", "request_limit", "packet_boundary"],
  clause: ["clause_complete", "request_limit"],
  sentence: ["sentence_complete", "request_limit", "packet_boundary"],
  emphasized_sentence: ["dramatic_emphasis"],
  paragraph: ["idea_transition", "chapter_transition", "delivery_transition"],
  reveal: ["revelation"],
  episode_end: ["episode_end"],
});

export function coherentThoughtSubmissionContract() {
  const contract = {
    schema: "goldflow_narration_submission_contract_v1",
    policy: COHERENT_THOUGHT_SUBMISSION_POLICY,
    authoring: "llm_authored_exact_source_components",
    preferred_words_min: 20, preferred_words_max: 42, soft_words_max: 48, hard_words_max: 60,
    planning_segments_are_speech_barriers: false,
    approved_overrides_are_speech_barriers: false,
    source_character_turns_are_speech_barriers: false,
    explicit_source_barriers_and_actual_voice_changes_required: true,
    short_unit_rationale_required: true,
    semantic_boundary_intent_required: true,
    provider_payload: "exact_final_spoken_text_no_instruction_channel",
  };
  return { ...contract, sha256: createHash("sha256").update(JSON.stringify(contract)).digest("hex") };
}

const meaningful = (value) => typeof value === "string" && value.trim().length >= 8;
const tokens = (value) => String(value ?? "").normalize("NFKC").toLocaleLowerCase("en-US")
  .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
const explicitBoundary = (value) => value && value !== "segment" ? String(value) : null;

// These are source-authored constraints, never inferred from scene IDs or an
// automatically assigned delivery_mode. Story transitions remain the author's job.
export function narrationSubmissionSourceConstraint(unit = {}, segment = {}) {
  const tags = Array.isArray(unit.metadata_tags) ? unit.metadata_tags.map(String) : [];
  const system = unit.kind === "system_ui" || /^(SYSTEM|NOTICE|WARNING|UI)$/i.test(String(unit.speaker ?? ""));
  return {
    atomic: system || unit.merge_barrier === true || unit.do_not_merge === true || unit.atomic === true
      || tags.some((tag) => /^(MERGE_BARRIER|ATOMIC|DO_NOT_MERGE)$/i.test(tag)),
    atomic_reason: system ? "system_announcement" : "explicit_source_barrier",
    before: explicitBoundary(unit.boundary_before),
    after: explicitBoundary(unit.boundary_after),
    chapter_id: unit.chapter_id ?? segment.chapter_id ?? null,
    delivery_id: unit.delivery_id ?? segment.delivery_id
      ?? (unit.kind === "mc_internal" || tags.includes("MC_INTERNAL") ? "source_mc_internal" : null),
  };
}

function constraintFor(row) {
  return row.submission_source_constraint ?? row.source_unit_refs?.[0]?.submission_source_constraint ?? {
    atomic: row.source_merge_barrier === true || row.risk_flags?.includes("system_ui_atomic"),
    atomic_reason: "explicit_source_barrier",
    before: explicitBoundary(row.boundary_before), after: explicitBoundary(row.boundary_after),
    chapter_id: row.chapter_id ?? null, delivery_id: row.delivery_id ?? null,
  };
}

export function coherentNarrationGroupFindings(group = {}, rows = []) {
  const findings = [];
  const add = (code, extra = {}) => findings.push({ code, ...extra });
  if (!rows.length) { add("submission_group_source_components_missing"); return findings; }
  const constraints = rows.map(constraintFor);
  if (rows.length > 1 && constraints.some((row) => row.atomic)) add("submission_group_crosses_atomic_source_barrier");
  for (let index = 1; index < rows.length; index += 1) {
    const previous = constraints[index - 1];
    const current = constraints[index];
    if (previous.after || current.before) add("submission_group_crosses_explicit_boundary", { component_index: index });
    for (const field of ["chapter_id", "delivery_id"]) {
      if ((previous[field] || current[field]) && previous[field] !== current[field]) {
        add("submission_group_crosses_source_transition", { component_index: index, field });
      }
    }
    for (const field of ["speaker", "reference_id", "reference_audio_path", "voice_source_policy"]) {
      if ((rows[index - 1][field] || rows[index][field]) && rows[index - 1][field] !== rows[index][field]) {
        add("submission_group_crosses_synthesis_identity", { component_index: index, field });
      }
    }
  }
  if (!meaningful(group.grouping_rationale)) add("submission_grouping_rationale_missing");
  const length = tokens(group.spoken_text).length;
  if (length < 20 && (!NARRATION_SHORT_UNIT_REASONS.includes(group.short_unit_reason?.reason)
    || !meaningful(group.short_unit_reason?.rationale))) add("submission_short_unit_reason_missing");
  if (length > 48 && !meaningful(group.length_exception_reason)) add("submission_soft_limit_rationale_missing");
  if (!NARRATION_BOUNDARY_INTENTS[group.boundary_after]?.includes(group.boundary_intent?.reason)
    || !meaningful(group.boundary_intent?.rationale)) add("submission_boundary_intent_invalid");
  if (/\[(?:pause|calm|angry|happy|sad|whisper|laugh|sigh|emotion|speaker|narrator)[^\]]*\]|<\/?(?:speak|break|prosody|voice|emotion)\b|^(?:narrator|speaker|instruction|system)\s*:/im.test(String(group.spoken_text ?? ""))) {
    add("submission_unsupported_control_leak");
  }
  return findings;
}

export function validateCoherentNarrationPlan(plan = {}) {
  if (plan.submission_policy !== COHERENT_THOUGHT_SUBMISSION_POLICY) return { status: "not_applicable", findings: [] };
  const findings = [];
  if (JSON.stringify(plan.submission_contract) !== JSON.stringify(coherentThoughtSubmissionContract())) findings.push({ code: "submission_contract_invalid" });
  for (const unit of plan.generation_units ?? plan.units ?? []) {
    const refs = unit.source_unit_refs ?? [];
    if (refs.some((ref) => !ref.submission_source_constraint || !ref.submission_synthesis_identity)) findings.push({ code: "submission_source_constraint_missing", unit_id: unit.unit_id });
    const rows = refs.map((ref) => ({ ...ref.submission_synthesis_identity, submission_source_constraint: ref.submission_source_constraint }));
    findings.push(...coherentNarrationGroupFindings(unit, rows).map((finding) => ({ ...finding, unit_id: unit.unit_id })));
  }
  return { status: findings.length ? "blocked" : "passed", findings };
}
