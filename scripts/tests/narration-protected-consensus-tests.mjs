import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as helpers from "../modelslab-qwen-episode-audio.mjs";
import { buildNarrationQualityContract } from "../lib/narration-quality-contract.mjs";
import {
  NARRATION_DELIVERY_CONSENSUS_VERSION,
  adjudicateNarrationDeliveryConsensus,
} from "../lib/narration-delivery-quality.mjs";
import {
  narrationFullStreamDerivedDecisionsCurrent,
  runFullStreamDeliveryQa,
} from "../narration-provider-output-finalize.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const contract = buildNarrationQualityContract({ provider: "qwen_local", modelId: "test" });
const qa = (source, text) => helpers.transcriptQaForTests(source, text, { maxWer: .05, blockAnySubstitution: false });
const consensus = (source, small, medium = small) => {
  const primaryTranscriptQa = qa(source, small);
  const confirmationTranscriptQa = qa(source, medium);
  const before = JSON.stringify([primaryTranscriptQa, confirmationTranscriptQa]);
  const result = adjudicateNarrationDeliveryConsensus({ primaryTranscriptQa, confirmationTranscriptQa, contract });
  assert.equal(JSON.stringify([primaryTranscriptQa, confirmationTranscriptQa]), before);
  return result;
};
const protectedBlockers = (result) => result.blockers.filter((row) => row.code.includes("protected_value"));

// The same finding family at different amounts is not independent confirmation.
for (const [source, small, medium] of [
  ["He invested two point two million. She received eighteen.",
    "He invested 2 .2 million. She received 18.",
    "He invested $2.2 million. She received $18 million."],
  ["He had five coins and six notes.", "He had four coins and six notes.", "He had five coins and seven notes."],
  ["He had five coins.", "He had four coins.", "He had six coins."],
  ["He had five coins and five notes.", "He had four coins and five notes.", "He had five coins and four notes."],
  ["He held ID then ID again.", "He held AI then ID again.", "He held ID then AI again."],
]) {
  const result = consensus(source, small, medium);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.status, "passed_with_warnings");
  assert.ok(result.warnings.some((row) => row.code === "narration_protected_value_difference_not_confirmed"));
}

// The exact same wrong value/sign/initialism at the same intended slot blocks.
for (const [source, recognized] of [
  ["He invested two point two million.", "He invested two million."],
  ["He had five coins.", "He had six coins."],
  ["He owed minus five dollars.", "He owed five dollars."],
  ["He received eighteen.", "He received eighteen million."],
  ["He asked the Eye.", "He asked the AI."],
]) {
  const result = consensus(source, recognized);
  assert.equal(protectedBlockers(result).length, 1);
  assert.equal(protectedBlockers(result)[0].operations.length, 1);
  assert.ok(Number.isInteger(protectedBlockers(result)[0].operations[0].intended_token_index));
}

// A shared operation remains blocking even when one model has additional errors.
const partial = consensus("He had five coins and six notes.",
  "He had four coins and seven notes.", "He had four coins and six notes.");
assert.deepEqual(protectedBlockers(partial)[0].operations.map((row) => [row.intended, row.recognized]), [["num:5", "num:4"]]);
assert.ok(partial.warnings.some((row) => row.code === "narration_protected_value_difference_not_confirmed"));

// The comparator may augment its intended side differently for each pair.
// Such notation words must not move a later confirmed error to a new source slot.
for (const [source, small, medium] of [
  ["He paid a hundred for food and five for tea.",
    "He paid the hundred for food and six for tea.",
    "He paid a hundred for food and six for tea."],
  ["He paid $100 for food and five for tea.",
    "He paid one hundred dollars for food and six for tea.",
    "He paid one hundred for food and six for tea."],
  ["He paid $100 for food and five for tea.",
    "He paid one hundred dollar for food and six for tea.",
    "He paid one hundred dollars for food and six for tea."],
]) {
  const result = consensus(source, small, medium);
  assert.deepEqual(protectedBlockers(result).flatMap((row) => row.operations)
    .map((row) => [row.intended, row.recognized]), [["num:5", "num:6"]]);
}
const shiftedOmission = consensus("He paid $100 for food and five for tea.",
  "He paid one hundred dollars for food and for tea.",
  "He paid one hundred for food and for tea.");
assert.ok(protectedBlockers(shiftedOmission).some((row) => row.operations.some((op) => op.intended === "num:5")));
const shiftedInsertion = consensus("He paid $100 for food and tea.",
  "He paid one hundred dollars for food and six tea.",
  "He paid one hundred for food and six tea.");
assert.ok(protectedBlockers(shiftedInsertion).some((row) => row.operations.some((op) => op.recognized === "num:6")));
// An ordinary source article is retained in both maps and still separates gaps.
assert.deepEqual(consensus("He held a coin.", "He held five a coin.", "He held a five coin.").blockers, []);

// Shared token spelling at different source slots must not fall back to generic
// word omission/insertion confirmation after the protected operation was rejected.
const differentOmissions = consensus("He had five coins and five notes.",
  "He had coins and five notes.", "He had five coins and notes.");
assert.deepEqual(differentOmissions.blockers, []);
const sameOmission = consensus("He had five coins and five notes.", "He had coins and five notes.");
assert.ok(sameOmission.blockers.some((row) => row.code === "narration_confirmed_tts_transcript_protected_value_missing"));
const differentInsertions = consensus("He held coins and notes.", "He held five coins and notes.", "He held coins and five notes.");
assert.deepEqual(differentInsertions.blockers, []);
assert.ok(consensus("He held coins and notes.", "He held five coins and notes.").blockers
  .some((row) => row.code === "narration_confirmed_tts_transcript_unexpected_protected_value"));
assert.ok(consensus("He kept the fucking watch.", "He kept the watch.").blockers
  .some((row) => row.code === "narration_confirmed_word_omission"));
assert.ok(consensus("He knew what happened.", "He knew what.").blockers
  .some((row) => row.code === "narration_confirmed_final_word_missing"));

// Consensus revisions invalidate derived decisions, without changing numeric
// tokenization or requiring repeat ASR over the same hash-bound evidence.
assert.equal(narrationFullStreamDerivedDecisionsCurrent({
  transcript_comparison_version: helpers.TRANSCRIPT_QA_COMPARISON_VERSION,
}, helpers.TRANSCRIPT_QA_COMPARISON_VERSION), false);
assert.equal(narrationFullStreamDerivedDecisionsCurrent({
  transcript_comparison_version: helpers.TRANSCRIPT_QA_COMPARISON_VERSION,
  delivery_consensus_version: NARRATION_DELIVERY_CONSENSUS_VERSION,
}, helpers.TRANSCRIPT_QA_COMPARISON_VERSION), true);
assert.equal(narrationFullStreamDerivedDecisionsCurrent({
  transcript_comparison_version: "stale-comparison",
  delivery_consensus_version: NARRATION_DELIVERY_CONSENSUS_VERSION,
}, helpers.TRANSCRIPT_QA_COMPARISON_VERSION), false);

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-protected-consensus-"));
try {
  const sampleCount = 240000;
  const wav = Buffer.alloc(44 + sampleCount * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36);
  wav.writeUInt32LE(sampleCount * 2, 40);
  const audioPath = path.join(temp, "fixture.wav");
  await fs.writeFile(audioPath, wav);
  const audioSha256 = hash(wav);
  const intended = "He invested two point two million. She received eighteen.";
  const primaryText = "He invested 2 .2 million. She received 18.";
  const mediumText = "He invested $2.2 million. She received $18 million.";
  const words = (text) => text.split(/\s+/).map((word, index) => ({ word, start_sec: .1 + index * .3, end_sec: .4 + index * .3 }));
  const window = { unit_ids: ["unit_1"], boundary_ids: [], start_sample: 0, end_sample_exclusive: sampleCount,
    intended_text: intended, intended_text_sha256: hash(intended), audio_path: audioPath,
    audio_sha256: audioSha256, sample_count: sampleCount,
    confirmation_recognized_text: mediumText, confirmation_recognized_words: words(mediumText) };
  window.binding_sha256 = hash(JSON.stringify({ source_audio_sha256: audioSha256, start_sample: 0,
    end_sample_exclusive: sampleCount, intended_text_sha256: hash(intended), unit_ids: ["unit_1"], boundary_ids: [] }));
  const evidence = { transcript_comparison_version: helpers.TRANSCRIPT_QA_COMPARISON_VERSION,
    primary_transcription: { text: primaryText, words: words(primaryText) },
    confirmation_model: "medium", confirmation_windows: [window] };
  const before = JSON.stringify(evidence);
  const result = await runFullStreamDeliveryQa({
    helpers: { ...helpers, runFasterWhisperUnitBatchForDiagnostics() { throw new Error("Existing evidence must be reused"); } },
    audioPath, audioSha256, units: [{ unit_id: "unit_1", spoken_text: intended }], qualityContract: contract,
    orderQa: { blockers: [] }, joinQa: { blockers: [], warnings: [] },
    stitch: { prepared_inputs: [{ unit_id: "unit_1", sample_count: sampleCount }] },
    workDir: temp, localWhisperContract: { model: "small.en" }, retainedEvidence: evidence,
  });
  assert.equal(result.delivery_consensus_version, NARRATION_DELIVERY_CONSENSUS_VERSION);
  assert.equal(result.transcript_comparison_version, helpers.TRANSCRIPT_QA_COMPARISON_VERSION);
  assert.equal(result.primary_transcription, evidence.primary_transcription);
  assert.equal(result.confirmation_windows[0].confirmation_recognized_text, mediumText);
  assert.deepEqual(result.decision.blockers, []);
  assert.equal(JSON.stringify(evidence), before);
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
console.log("narration protected consensus tests passed");
