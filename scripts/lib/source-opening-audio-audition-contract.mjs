import { createHash } from "node:crypto";

export const OPENING_AUDIO_AUDITION_MANIFEST_SCHEMA = "goldflow_opening_audio_audition_manifest_v1";
export const OPENING_AUDIO_AUDITION_REVIEW_SCHEMA = "goldflow_opening_audio_audition_review_v1";
export const OPENING_AUDIO_AUDITION_MODES = Object.freeze([
  "shadow_non_blocking",
  "mandatory_advisory",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function collapseWhitespace(value) {
  return clean(value).replace(/\s+/g, " ");
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function words(value) {
  return clean(value).split(/\s+/).filter(Boolean);
}

export function extractOpeningAuditionText(text, {
  minimumWords = 180,
  maximumWords = 270,
} = {}) {
  const source = clean(text);
  const sentenceMatches = source.match(/[^.!?]+(?:[.!?]+[\"'’”)]*|$)/g) ?? [];
  const selected = [];
  let count = 0;
  for (const raw of sentenceMatches) {
    const sentence = clean(raw);
    if (!sentence) continue;
    const sentenceWords = words(sentence).length;
    if (count >= minimumWords && count + sentenceWords > maximumWords) break;
    selected.push(sentence);
    count += sentenceWords;
    if (count >= minimumWords) break;
  }
  const excerpt = selected.join(" ");
  if (count < minimumWords || count > maximumWords) {
    throw new Error(`Opening audition excerpt has ${count} words; expected ${minimumWords}-${maximumWords} on sentence boundaries.`);
  }
  return { text: excerpt, word_count: count, sha256: sha256(excerpt) };
}

export function sentenceCompleteAuditionUnits(text, {
  preferredWords = 42,
  hardMaximumWords = 60,
} = {}) {
  const sentences = clean(text).match(/[^.!?]+(?:[.!?]+[\"'’”)]*|$)/g)?.map(clean).filter(Boolean) ?? [];
  const units = [];
  let pending = [];
  let pendingWords = 0;
  const flush = () => {
    if (!pending.length) return;
    units.push(pending.join(" "));
    pending = [];
    pendingWords = 0;
  };
  for (const sentence of sentences) {
    const count = words(sentence).length;
    if (count > hardMaximumWords) throw new Error(`Opening audition sentence exceeds ${hardMaximumWords} words.`);
    if (pending.length && pendingWords + count > preferredWords) flush();
    pending.push(sentence);
    pendingWords += count;
    if (pendingWords >= preferredWords) flush();
  }
  flush();
  if (!units.length || units.some((unit) => words(unit).length > hardMaximumWords)) {
    throw new Error("Opening audition unitization failed.");
  }
  return units;
}

export function validateOpeningAudioAuditionManifest(document, {
  draftSelectionSha256 = null,
  expectedDrafts = null,
  requireProductionGate = false,
} = {}) {
  const blockers = [];
  const add = (condition, code) => {
    if (condition) blockers.push(code);
  };
  add(document?.schema !== OPENING_AUDIO_AUDITION_MANIFEST_SCHEMA, "opening_audio_audition_schema_invalid");
  add(document?.status !== "prepared", "opening_audio_audition_not_prepared");
  add(!OPENING_AUDIO_AUDITION_MODES.includes(document?.mode), "opening_audio_audition_mode_invalid");
  add(requireProductionGate && document?.mode !== "mandatory_advisory", "opening_audio_audition_production_gate_missing");
  add(document?.selection_authority !== "none_until_calibrated", "opening_audio_audition_selection_authority_invalid");
  if (draftSelectionSha256) add(document?.draft_selection_sha256 !== draftSelectionSha256, "opening_audio_audition_selection_hash_mismatch");
  const finalists = Array.isArray(document?.finalists) ? document.finalists : [];
  add(finalists.length !== 2, "opening_audio_audition_finalist_count_invalid");
  add(new Set(finalists.map((row) => row?.draft_id)).size !== finalists.length, "opening_audio_audition_draft_ids_duplicate");
  add(new Set(finalists.map((row) => row?.blind_label)).size !== finalists.length, "opening_audio_audition_labels_duplicate");
  const expected = expectedDrafts ?? {};
  for (const [index, row] of finalists.entries()) {
    add(!clean(row?.draft_id), `opening_audio_audition_finalist_${index}_draft_id_missing`);
    add(!["A", "B"].includes(row?.blind_label), `opening_audio_audition_finalist_${index}_label_invalid`);
    add(!Number.isInteger(Number(row?.text_rank)) || Number(row.text_rank) !== index + 1, `opening_audio_audition_finalist_${index}_rank_invalid`);
    add(!/^[a-f0-9]{64}$/i.test(clean(row?.draft_sha256)), `opening_audio_audition_finalist_${index}_draft_hash_invalid`);
    add(!/^[a-f0-9]{64}$/i.test(clean(row?.excerpt_sha256)), `opening_audio_audition_finalist_${index}_excerpt_hash_invalid`);
    add(words(row?.excerpt_text).length < 180 || words(row?.excerpt_text).length > 270, `opening_audio_audition_finalist_${index}_excerpt_words_invalid`);
    add(Number(row?.excerpt_word_count) !== words(row?.excerpt_text).length, `opening_audio_audition_finalist_${index}_excerpt_word_count_mismatch`);
    add(sha256(row?.excerpt_text) !== row?.excerpt_sha256, `opening_audio_audition_finalist_${index}_excerpt_hash_mismatch`);
    const draft = expected?.[row?.draft_id];
    if (draft) {
      add(row?.draft_sha256 !== draft.sha256, `opening_audio_audition_finalist_${index}_expected_draft_hash_mismatch`);
      add(!collapseWhitespace(draft.text).startsWith(collapseWhitespace(row?.excerpt_text)), `opening_audio_audition_finalist_${index}_excerpt_not_prefix`);
    }
    const units = Array.isArray(row?.units) ? row.units : [];
    add(units.length < 1, `opening_audio_audition_finalist_${index}_units_missing`);
    add(units.map((unit) => unit.text).join(" ") !== clean(row?.excerpt_text), `opening_audio_audition_finalist_${index}_unit_text_mismatch`);
    for (const [unitIndex, unit] of units.entries()) {
      add(words(unit?.text).length > 60, `opening_audio_audition_finalist_${index}_unit_${unitIndex}_too_long`);
    }
  }
  const voice = document?.voice_lock;
  for (const field of ["provider", "model_id", "model_revision", "voice_id", "reference_audio_path", "reference_audio_sha256", "reference_text"]) {
    add(!clean(voice?.[field]), `opening_audio_audition_voice_${field}_missing`);
  }
  return { done: blockers.length === 0, blockers };
}

export function validateOpeningAudioAuditionReview(document, {
  manifestSha256 = null,
  allowedLabels = ["A", "B"],
  requireProductionGate = false,
} = {}) {
  const blockers = [];
  const add = (condition, code) => {
    if (condition) blockers.push(code);
  };
  add(document?.schema !== OPENING_AUDIO_AUDITION_REVIEW_SCHEMA, "opening_audio_audition_review_schema_invalid");
  add(document?.status !== "reviewed", "opening_audio_audition_review_not_reviewed");
  add(!["shadow_only", "mandatory_advisory"].includes(document?.decision_authority), "opening_audio_audition_review_authority_invalid");
  add(requireProductionGate && document?.decision_authority !== "mandatory_advisory", "opening_audio_audition_review_production_gate_missing");
  if (manifestSha256) add(document?.audition_manifest_sha256 !== manifestSha256, "opening_audio_audition_review_manifest_hash_mismatch");
  const rows = Array.isArray(document?.blind_reviews) ? document.blind_reviews : [];
  add(rows.length !== allowedLabels.length, "opening_audio_audition_review_count_invalid");
  add(new Set(rows.map((row) => row?.blind_label)).size !== rows.length, "opening_audio_audition_review_labels_duplicate");
  for (const label of allowedLabels) add(!rows.some((row) => row?.blind_label === label), `opening_audio_audition_review_label_${label}_missing`);
  for (const [index, row] of rows.entries()) {
    for (const field of ["spoken_cadence", "name_density", "exposition_control", "emotional_clarity", "immediate_click_satisfaction"]) {
      const score = Number(row?.scores?.[field]);
      add(!Number.isInteger(score) || score < 1 || score > 5, `opening_audio_audition_review_${index}_${field}_invalid`);
    }
    add(!clean(row?.notes), `opening_audio_audition_review_${index}_notes_missing`);
  }
  add(![...allowedLabels, "tie"].includes(document?.preferred_blind_label), "opening_audio_audition_review_preference_invalid");
  add(!clean(document?.reviewed_by), "opening_audio_audition_review_reviewer_missing");
  return { done: blockers.length === 0, blockers };
}
