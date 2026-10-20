import { MANUFACTURING_BRIEF_SCHEMA, sha256Text } from "./source-manufacturer-contract.mjs";

export const REVISION_NOTES_SCHEMA = "goldflow_manhwa_revision_notes_v1";
export const REVISION_VERDICT_SCHEMA = "goldflow_manhwa_revision_verdict_v1";
export const REVISION_DECISION_SCHEMA = "goldflow_manhwa_revision_decision_v1";
export const REVISION_LOOP_SCHEMA = "goldflow_manhwa_revision_loop_v1";
export const REVISION_POLICY = "single_draft_diagnose_revise_verify_v1";
export const REVISION_MAX_ROUNDS = 2;
export const REVISION_DIMENSIONS = Object.freeze([
  "continuity_logic",
  "cold_viewer_explanation",
  "pacing_repetition",
  "opening_deadlines",
  "storytelling",
  "payoff",
  "additions",
]);
export const OPENING_DEADLINE_WORDS = Object.freeze([40, 80, 120, 300, 600]);
// A revised script outside this band is almost certainly truncated or a different story.
export const REVISION_LENGTH_RATIO_RANGE = Object.freeze([0.8, 1.3]);

function text(value) {
  return String(value ?? "").trim();
}

function normalizeSpace(value) {
  return String(value ?? "").replace(/[‘’]/g, "'").replace(/[“”]/g, "\"").replace(/\s+/g, " ").trim().toLowerCase();
}

export function wordCount(value) {
  return String(value ?? "").trim().split(/\s+/).filter(Boolean).length;
}

export function anchorIsExact(anchor, script) {
  const needle = normalizeSpace(anchor);
  return needle.length > 0 && normalizeSpace(script).includes(needle);
}

// Deterministic word windows so the diagnose call checks the deadlines against the exact text
// rather than estimating word positions itself. Code slices; it never edits.
export function openingDeadlineWindows(script) {
  const tokens = String(script ?? "").trim().split(/\s+/).filter(Boolean);
  let start = 0;
  return OPENING_DEADLINE_WORDS.map((end) => {
    const window = { first_word: start + 1, last_word: end, text: tokens.slice(start, end).join(" ") };
    start = end;
    return window;
  });
}

export function validateRevisionNotes(document, incumbentText) {
  const blockers = [];
  if (document?.schema !== REVISION_NOTES_SCHEMA) blockers.push("revision_notes_schema_invalid");
  const review = document?.dimension_review ?? {};
  for (const dimension of REVISION_DIMENSIONS) {
    if (!["ok", "issues"].includes(review?.[dimension]?.status) || !text(review?.[dimension]?.summary)) {
      blockers.push(`revision_notes_dimension_${dimension}_missing`);
    }
  }
  const notes = Array.isArray(document?.notes) ? document.notes : [];
  const allOk = REVISION_DIMENSIONS.every((dimension) => review?.[dimension]?.status === "ok");
  // No notes is a valid diagnosis only when every dimension was reviewed as fine.
  if (notes.length < 1 && !allOk) blockers.push("revision_notes_empty");
  const ids = notes.map((note) => text(note?.id));
  if (new Set(ids).size !== ids.length || ids.some((id) => !id)) blockers.push("revision_notes_ids_invalid");
  let verified = 0;
  for (const [index, note] of notes.entries()) {
    if (!REVISION_DIMENSIONS.includes(note?.dimension)) blockers.push(`revision_note_${index}_dimension_invalid`);
    if (!["material", "minor"].includes(note?.severity)) blockers.push(`revision_note_${index}_severity_invalid`);
    for (const field of ["anchor", "problem", "direction"]) if (!text(note?.[field])) blockers.push(`revision_note_${index}_${field}_missing`);
    if (anchorIsExact(note?.anchor, incumbentText)) verified += 1;
  }
  // Anchors are quotations; tolerate an occasional misquote but not unanchored notes.
  if (notes.length > 0 && verified * 2 < notes.length) blockers.push("revision_notes_anchors_not_in_script");
  return {
    done: blockers.length === 0,
    blockers,
    anchors: { total: notes.length, verified },
    material_note_count: notes.filter((note) => note?.severity === "material").length,
    nothing_to_fix: notes.length === 0 && allOk,
  };
}

export function validateRevisionVerdict(document, { noteIds = [] } = {}) {
  const blockers = [];
  if (document?.schema !== REVISION_VERDICT_SCHEMA) blockers.push("revision_verdict_schema_invalid");
  if (!["keep_revision", "revert"].includes(document?.decision)) blockers.push("revision_verdict_decision_invalid");
  if (!text(document?.reasons)) blockers.push("revision_verdict_reasons_missing");
  const comparison = document?.dimension_comparison ?? {};
  for (const dimension of REVISION_DIMENSIONS) {
    if (!["revision", "incumbent", "tie"].includes(comparison?.[dimension]?.better) || !text(comparison?.[dimension]?.reason)) {
      blockers.push(`revision_verdict_dimension_${dimension}_missing`);
    }
  }
  const addressed = Array.isArray(document?.notes_addressed) ? document.notes_addressed : [];
  const addressedIds = new Set(addressed.map((row) => text(row?.note_id)));
  for (const id of noteIds) if (!addressedIds.has(id)) blockers.push(`revision_verdict_note_${id}_unreviewed`);
  for (const [index, row] of addressed.entries()) {
    if (!["addressed", "partial", "not_addressed", "made_worse"].includes(row?.status)) blockers.push(`revision_verdict_note_${index}_status_invalid`);
  }
  if (!Array.isArray(document?.regressions)) blockers.push("revision_verdict_regressions_missing");
  const remaining = document?.remaining_material_issues;
  if (!Array.isArray(remaining)) blockers.push("revision_verdict_remaining_issues_missing");
  for (const [index, issue] of (Array.isArray(remaining) ? remaining : []).entries()) {
    if (!REVISION_DIMENSIONS.includes(issue?.dimension) || !text(issue?.problem)) blockers.push(`revision_verdict_remaining_${index}_invalid`);
  }
  return { done: blockers.length === 0, blockers };
}

export function assessRevisionLength(incumbentWords, revisionWords) {
  const ratio = incumbentWords > 0 && revisionWords > 0 ? revisionWords / incumbentWords : null;
  const [low, high] = REVISION_LENGTH_RATIO_RANGE;
  return {
    incumbent_word_count: incumbentWords,
    revision_word_count: revisionWords,
    ratio: ratio == null ? null : Number(ratio.toFixed(4)),
    complete_range: [low, high],
    plausibly_complete: ratio != null && ratio >= low && ratio <= high,
    rule: "Word count is not quality. This guard only catches a truncated or replaced script before verify spend.",
  };
}

// The verify call decides keep or revert; code only applies that decision and the round cap.
export function decideRevisionRound({ verdict = null, length, round, maxRounds = REVISION_MAX_ROUNDS }) {
  const cap = Math.min(REVISION_MAX_ROUNDS, Math.max(1, Number(maxRounds) || REVISION_MAX_ROUNDS));
  if (!length?.plausibly_complete) {
    return { kept: false, status: "revision_incomplete_reverted", reason: "revision_length_out_of_range", remaining_material_issue_count: null, next_round: false };
  }
  const kept = verdict?.decision === "keep_revision";
  const remaining = Array.isArray(verdict?.remaining_material_issues) ? verdict.remaining_material_issues.length : 0;
  return {
    kept,
    status: kept ? "revision_kept" : "incumbent_retained",
    reason: kept ? "verify_kept_revision" : "verify_reverted",
    remaining_material_issue_count: remaining,
    next_round: remaining > 0 && round < cap,
  };
}

// Auto-title copies the shortlist's rank-one model output into the brief verbatim. Code never
// composes or edits the title or premise text.
export function autoTitleBrief(shortlist, { shortlistPath, shortlistSha256, evidencePath = null, evidenceSha256 = null, targetWordCount = 10_000, selectedAt = new Date().toISOString() } = {}) {
  const top = (Array.isArray(shortlist?.rankings) ? shortlist.rankings : []).find((row) => Number(row?.rank) === 1);
  if (!top) throw new Error("Shortlist has no rank-one candidate.");
  const brief = {
    schema: MANUFACTURING_BRIEF_SCHEMA,
    status: "auto_selected",
    title: top.title,
    core_premise: top.core_premise,
    opening_target: top.opening_target,
    hook_contract: top.hook_contract ?? null,
    demand_transfer: top.demand_transfer ?? null,
    complexity_risk: top.complexity_risk ?? null,
    target_word_count: Number(targetWordCount),
    genre_elements: Array.isArray(top.genre_elements) ? top.genre_elements : [],
    reference_outlier: top.reference_outlier?.url && top.reference_outlier?.title ? top.reference_outlier : null,
    title_selection_policy: shortlist.title_selection_policy ?? null,
    selection_basis: {
      method: "shortlist_rank_one_auto_v1",
      rank: 1,
      candidate_number: Number(top.candidate_number),
      rationale: top.why_it_can_win,
      shortlist_path: shortlistPath,
      shortlist_sha256: shortlistSha256,
      evidence_path: evidencePath,
      evidence_sha256: evidenceSha256,
      title_sha256: sha256Text(top.title),
      core_premise_sha256: sha256Text(top.core_premise),
    },
    selected_at: selectedAt,
  };
  return brief;
}
