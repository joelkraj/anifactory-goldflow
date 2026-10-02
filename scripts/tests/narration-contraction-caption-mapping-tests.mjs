import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildSubtitleEventsForTests,
  captionWordsWithContractionExpansionForTests,
} from "../render.mjs";
import {
  CONTRACTION_ALIAS, CONTRACTION_SOURCE_UNIT, CONTRACTION_TARGET_UNIT_ID,
  contractionCaptionWordSpanForTests,
  contractionCandidateAsrDecisionForTests,
} from "../lib/narration-contraction-repair.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const sourceTokens = CONTRACTION_SOURCE_UNIT.split(" ");
const spokenTokens = CONTRACTION_SOURCE_UNIT.replace(CONTRACTION_ALIAS.from,
  CONTRACTION_ALIAS.to).split(" ");
assert.equal(spokenTokens.length, sourceTokens.length + 1);

// The unit occurs well inside the stitched narration. The prefix unit has no
// source caption, so only an approved visual-beat plan may supply its captions.
const start = 123.4;
const prefix = [
  { index: 0, word: "Before", start_sec: 122.1, end_sec: 122.32 },
  { index: 1, word: "this", start_sec: 122.36, end_sec: 122.62 },
];
const spoken = spokenTokens.map((word, index) => ({
  index: index + prefix.length, word,
  start_sec: Number((start + 0.05 + index * 0.29).toFixed(3)),
  end_sec: Number((start + 0.27 + index * 0.29).toFixed(3)),
}));
const words = [...prefix, ...spoken];
const evidenceSha256 = sha("reviewed-automated-delivery-qa");
const segment = {
  unit_id: CONTRACTION_TARGET_UNIT_ID,
  text: CONTRACTION_SOURCE_UNIT,
  caption_text: CONTRACTION_SOURCE_UNIT,
  start_sec: start,
  end_sec: 128.2,
  duration_sec: 4.8,
  tts_only_contraction_expansion: {
    source_token: "She’d", spoken_words: ["She", "had"],
    source_phrase: CONTRACTION_ALIAS.from,
    spoken_phrase: CONTRACTION_ALIAS.to,
    evidence_sha256: evidenceSha256,
  },
};
const stitch = { segments: [
  { unit_id: "prefix-unit", text: "Before this", caption_text: "",
    start_sec: 122.0, end_sec: 122.8, duration_sec: 0.8 },
  segment,
] };
const originalWords = JSON.stringify(words);
const originalStitch = JSON.stringify(stitch);
const span = contractionCaptionWordSpanForTests({ segments: stitch.segments, words });
assert.ok(span.start_sec >= start && span.start_sec > 0);
assert.deepEqual(span.spoken_word_indices, [2, 3]);
assert.equal(span.start_sec, spoken[0].start_sec);
assert.equal(span.end_sec, spoken[1].end_sec);
assert.equal(span.source_token, "She’d");

const mapped = captionWordsWithContractionExpansionForTests(words, stitch);
assert.equal(mapped.length, words.length - 1);
assert.equal(mapped[2].word, "She’d");
assert.equal(mapped[2].start_sec, spoken[0].start_sec);
assert.equal(mapped[2].end_sec, spoken[1].end_sec);
assert.equal(mapped[3].word, "looked");
assert.equal(mapped.at(-1).word, "going.");
assert.deepEqual(mapped.map((row) => row.index),
  Array.from({ length: mapped.length }, (_, index) => index));
assert.equal(JSON.stringify(words), originalWords);
assert.equal(JSON.stringify(stitch), originalStitch);

const beats = { status: "passed", beats: [
  { source_word_start_index: 0, source_word_end_index: 1,
    visual_beat_script_excerpt: "Before this" },
  { source_word_start_index: 2, source_word_end_index: mapped.length - 1,
    visual_beat_script_excerpt: CONTRACTION_SOURCE_UNIT },
] };
const captions = buildSubtitleEventsForTests({ words }, stitch, beats);
assert.equal(captions.source,
  "approved_visual_beat_script_text_with_exact_source_contraction");
assert.equal(captions.events.map((row) => row.text).join(" "),
  `Before this ${CONTRACTION_SOURCE_UNIT}`);
const contractionEvent = captions.events.find((row) => row.text.includes("She’d"));
assert.ok(contractionEvent);
assert.ok(contractionEvent.start_sec <= span.start_sec + 0.05);
assert.ok(contractionEvent.end_sec >= span.end_sec - 0.05);
assert.ok(captions.events.every((row) => row.end_sec > row.start_sec));

// Fresh visual plans derive beat ranges from raw Whisper indices, so they
// include the extra spoken auxiliary even though the caption omits it.
const rawBeatRanges = { status: "passed", beats: [
  beats.beats[0],
  { ...beats.beats[1], source_word_end_index: words.length - 1 },
] };
const rawIndexedCaptions = buildSubtitleEventsForTests({ words }, stitch,
  rawBeatRanges);
assert.equal(rawIndexedCaptions.source,
  "approved_visual_beat_script_text_with_exact_source_contraction");
assert.equal(rawIndexedCaptions.events.map((row) => row.text).join(" "),
  `Before this ${CONTRACTION_SOURCE_UNIT}`);
const rawContractionEvent = rawIndexedCaptions.events.find((row) =>
  row.text.includes("She’d"));
assert.ok(rawContractionEvent);
assert.ok(rawContractionEvent.start_sec <= span.start_sec + 0.05);
assert.ok(rawContractionEvent.end_sec >= span.end_sec - 0.05);

// An absent or incomplete approved beat plan must fail instead of silently
// switching the complete episode to Whisper-recognized caption text.
for (const invalidBeats of [null, { status: "blocked", beats: beats.beats },
  { status: "passed", beats: beats.beats.slice(0, 1) }]) {
  assert.throws(() => buildSubtitleEventsForTests({ words }, stitch, invalidBeats),
    /Approved source captions do not bind/);
}
const malformed = words.map((row) => ({ ...row }));
malformed[3].end_sec = malformed[3].start_sec;
assert.throws(() => contractionCaptionWordSpanForTests({
  segments: stitch.segments, words: malformed,
}), /two ordered spoken word intervals/);
assert.throws(() => buildSubtitleEventsForTests({ words: malformed }, stitch, beats),
  /two ordered spoken word intervals/);
assert.throws(() => contractionCaptionWordSpanForTests({
  segments: [{ ...segment, start_sec: Number.NaN }], words,
}), /exact stitched sample offsets/);
const missingAuxiliary = words.filter((row) => row.word !== "had");
assert.throws(() => contractionCaptionWordSpanForTests({
  segments: stitch.segments, words: missingAuxiliary,
}), /not aligned to spoken She had looked/);

const initialDecision = { status: "blocked", review_required: true,
  blockers: [{ code: "narration_confirmed_opening_token_mismatch" }], warnings: [] };
const cleanSpoken = CONTRACTION_SOURCE_UNIT.replace(CONTRACTION_ALIAS.from,
  CONTRACTION_ALIAS.to);
const accepted = contractionCandidateAsrDecisionForTests({
  decision: initialDecision, unitId: CONTRACTION_TARGET_UNIT_ID,
  reviewedUnitId: CONTRACTION_TARGET_UNIT_ID,
  expectedText: CONTRACTION_SOURCE_UNIT,
  primaryText: cleanSpoken, confirmationText: cleanSpoken,
  evidenceSha256,
});
assert.equal(accepted.status, "passed_with_warnings");
assert.deepEqual(accepted.blockers, []);
assert.equal(accepted.contraction_expansion_review.human_listening_performed, false);
const failed = contractionCandidateAsrDecisionForTests({
  decision: initialDecision, unitId: CONTRACTION_TARGET_UNIT_ID,
  reviewedUnitId: CONTRACTION_TARGET_UNIT_ID,
  expectedText: CONTRACTION_SOURCE_UNIT,
  primaryText: cleanSpoken,
  confirmationText: CONTRACTION_SOURCE_UNIT.replace("She’d", "She"),
  evidenceSha256,
});
assert.equal(failed.status, "blocked");
assert.ok(failed.blockers.some((row) =>
  row.code === "narration_exact_tts_only_expansion_not_confirmed"));

console.log("narration-contraction-caption-mapping-tests: passed");
