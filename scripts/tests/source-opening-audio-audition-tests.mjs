import assert from "node:assert/strict";
import {
  OPENING_AUDIO_AUDITION_MANIFEST_SCHEMA,
  OPENING_AUDIO_AUDITION_REVIEW_SCHEMA,
  extractOpeningAuditionText,
  sentenceCompleteAuditionUnits,
  validateOpeningAudioAuditionManifest,
  validateOpeningAudioAuditionReview,
} from "../lib/source-opening-audio-audition-contract.mjs";

const hash = "a".repeat(64);
const sentence = (index) => `Joey blocks the visible strike number ${index}, refuses the imposed sacrifice, and forces Serena to reveal what she planned.`;
const draftText = Array.from({ length: 30 }, (_, index) => sentence(index + 1)).join(" ");
const excerpt = extractOpeningAuditionText(draftText);
assert.ok(excerpt.word_count >= 180 && excerpt.word_count <= 270);
const units = sentenceCompleteAuditionUnits(excerpt.text);
assert.equal(units.join(" "), excerpt.text);
assert.ok(units.every((unit) => unit.split(/\s+/).length <= 60));

const finalists = ["draft_a", "draft_b"].map((draftId, index) => ({
  draft_id: draftId,
  text_rank: index + 1,
  blind_label: index === 0 ? "A" : "B",
  draft_sha256: hash,
  excerpt_text: excerpt.text,
  excerpt_word_count: excerpt.word_count,
  excerpt_sha256: excerpt.sha256,
  units: units.map((text, unitIndex) => ({ unit_id: `${draftId}_${unitIndex + 1}`, text })),
}));
const manifest = {
  schema: OPENING_AUDIO_AUDITION_MANIFEST_SCHEMA,
  status: "prepared",
  mode: "shadow_non_blocking",
  selection_authority: "none_until_calibrated",
  draft_selection_sha256: hash,
  voice_lock: {
    provider: "qwen_local",
    model_id: "qwen",
    model_revision: "revision",
    voice_id: "joel",
    reference_audio_path: "/tmp/joel.wav",
    reference_audio_sha256: hash,
    reference_text: "Reference.",
  },
  finalists,
};
assert.equal(validateOpeningAudioAuditionManifest(manifest, {
  draftSelectionSha256: hash,
  expectedDrafts: {
    draft_a: { sha256: hash, text: draftText },
    draft_b: { sha256: hash, text: draftText },
  },
}).done, true);
assert.equal(validateOpeningAudioAuditionManifest({
  ...manifest,
  selection_authority: "select_winner",
}).done, false);
assert.equal(validateOpeningAudioAuditionManifest({
  ...manifest,
  mode: "mandatory_advisory",
}, {
  draftSelectionSha256: hash,
  expectedDrafts: {
    draft_a: { sha256: hash, text: draftText },
    draft_b: { sha256: hash, text: draftText },
  },
  requireProductionGate: true,
}).done, true);

const review = {
  schema: OPENING_AUDIO_AUDITION_REVIEW_SCHEMA,
  status: "reviewed",
  decision_authority: "shadow_only",
  audition_manifest_sha256: hash,
  blind_reviews: ["A", "B"].map((blindLabel) => ({
    blind_label: blindLabel,
    scores: {
      spoken_cadence: 4,
      name_density: 4,
      exposition_control: 4,
      emotional_clarity: 5,
      immediate_click_satisfaction: 4,
    },
    notes: "The opening remains clear and forward-moving.",
  })),
  preferred_blind_label: "A",
  reviewed_by: "fixture",
};
assert.equal(validateOpeningAudioAuditionReview(review, { manifestSha256: hash }).done, true);
assert.equal(validateOpeningAudioAuditionReview({
  ...review,
  decision_authority: "blocking",
}, { manifestSha256: hash }).done, false);
assert.equal(validateOpeningAudioAuditionReview({
  ...review,
  decision_authority: "mandatory_advisory",
}, { manifestSha256: hash, requireProductionGate: true }).done, true);

console.log("source opening audio audition tests passed");
