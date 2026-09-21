import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as helpers from "../modelslab-qwen-episode-audio.mjs";
import { buildNarrationQualityContract } from "../lib/narration-quality-contract.mjs";
import { adjudicateNarrationDeliveryConsensus } from "../lib/narration-delivery-quality.mjs";
import { runFullStreamDeliveryQa } from "../narration-provider-output-finalize.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const contract = buildNarrationQualityContract({ provider: "qwen_local", modelId: "test" });
const qa = (intended, recognized) => helpers.transcriptQaForTests(intended, recognized, {
  maxWer: 0.05, blockAnySubstitution: false,
});
const consensus = (intended, small, medium = small) => adjudicateNarrationDeliveryConsensus({
  primaryTranscriptQa: qa(intended, small), confirmationTranscriptQa: qa(intended, medium), contract,
});

const accent = qa("My fiancée chose him.", "My fiancé chose him.");
assert.deepEqual(accent.intended_canonical_tokens, ["my", "fiancée", "chose", "him"]);
assert.equal(accent.deletions, 0);
assert.equal(accent.substitutions, 1); // No homophone/meaning waiver.
assert.equal(consensus("My fiancée chose him.", "My fiancé chose him.").blockers.length, 0);
assert.equal(qa("My fiancée chose him.", "My fiance\u0301e chose him.").substitutions, 0);
assert.deepEqual(qa("Élodie’s café", "Élodie's café").intended_canonical_tokens, ["élodies", "café"]);
for (const contraction of ["I'm", "I’m", "i'm", "I’M"]) {
  const result = qa("If I am going, I will return.", `If ${contraction} going, I will return.`);
  assert.equal(result.deletions + result.insertions + result.substitutions, 0);
}
assert.notEqual(qa("I am ready.", "Im ready.").deletions, 0);
assert.notEqual(qa("He is ready.", "He's ready.").deletions, 0);
assert.notEqual(qa("He had left.", "He'd left.").deletions, 0);
assert.equal(qa("The quay is clear.", "The key is clear.").substitutions, 1);
assert.ok(consensus("He had answered that he understood.", "He had answered that he...").blockers
  .some((finding) => finding.code === "narration_confirmed_final_word_missing"));
assert.ok(consensus("No. Send me the address.", "No, send me the address of-", "No, send me the address of Adrian's.").blockers
  .some((finding) => finding.code === "narration_confirmed_unexpected_word"));
assert.ok(consensus("There were five guards.", "There were six guards.").blockers
  .some((finding) => finding.code.includes("protected_value")));
assert.equal(accent.comparison_version, helpers.TRANSCRIPT_QA_COMPARISON_VERSION);

const hundredIntended = "Five orders, worth a hundred million, before Joey had even prepared a sales sheet.";
for (const numeric of ["100 million", "$100 million", "one hundred million", "100,000,000"]) {
  const recognized = hundredIntended.replace("a hundred million", numeric);
  const result = qa(hundredIntended, recognized);
  assert.equal(result.deletions + result.insertions + result.substitutions, 0);
  assert.equal(consensus(hundredIntended, recognized).blockers.length, 0);
}
for (const [intended, recognized] of [
  ["a hundred", "100"], ["a hundred thousand", "100000"],
  ["a hundred and five", "105"], ["minus a hundred", "-100"],
]) {
  const result = qa(intended, recognized);
  assert.equal(result.deletions + result.insertions + result.substitutions, 0);
}
for (const numeric of ["99 million", "$101 million", "two hundred million", "100 thousand"]) {
  assert.ok(consensus(hundredIntended, hundredIntended.replace("a hundred million", numeric)).blockers
    .some((finding) => finding.code.includes("protected_value")));
}
for (const [intended, recognized] of [
  ["He prepared a sales sheet.", "He prepared sales sheet."],
  ["He bought a hundred-dollar bond.", "He bought a hundred-dollar."],
  ["It was a one hundred page report.", "It was one hundred page report."],
]) {
  assert.ok(qa(intended, recognized).deletions > 0);
  assert.ok(consensus(intended, recognized).blockers.length > 0);
}
assert.ok(qa("He prepared a sales sheet worth a hundred million.", "He prepared sales sheet worth 100 million.").deletions > 0);

// Sentence/list boundaries and independent amounts must survive normalization.
// The former additive parser turned four + two into six, and repeated millions
// into a sum; digit whitespace folding also merged "210, 200" into 210200.
for (const [intended, recognized, expected] of [
  ["Level four. Two decisions.", "Level 4. Two decisions.", ["level", "num:4", "num:2", "decisions"]],
  ["Level six. Ninety-day forecasts.", "Level 6. 90-day forecasts.", ["level", "num:6", "num:90", "day", "forecasts"]],
  ["forty-two million and eighteen million", "42 million and 18 million", ["num:42000000", "and", "num:18000000"]],
  ["Two hundred and ten. Two hundred.", "210, 200.", ["num:210", "num:200"]],
  ["Three hundred million. Two hundred and ten against Dad's name.", "300 million. 210 against Dad's name.",
    ["num:300000000", "num:210", "against", "dads", "name"]],
  ["one, two, and three", "1, 2, and 3", ["num:1", "num:2", "and", "num:3"]],
]) {
  const result = qa(intended, recognized);
  assert.deepEqual(result.intended_canonical_tokens, expected);
  assert.deepEqual(result.recognized_canonical_tokens, expected);
  assert.equal(consensus(intended, recognized).blockers.length, 0);
}
for (const [intended, recognized] of [
  ["one million, two hundred thousand", "1,200,000"],
  ["one million and two hundred thousand", "1200000"],
  ["a million six hundred thousand", "1,600,000"],
  ["two thousand and twenty-one", "2021"],
  ["one hundred and five", "105"],
  ["twelve hundred and sixty dollars", "$1,260"],
  ["twenty-five hundred", "2500"],
  ["eleven hundred", "1100"],
  ["nineteen hundred and ninety-nine", "1999"],
  ["ninety-nine point four percent", "99.4%"],
  ["two point two million dollars", "$2.2 million"],
  ["one dollar", "$1"],
  ["thirty-two thousand five hundred dollars", "$32,500"],
  ["a hundred-dollar bond", "$100 bond"],
  ["minus one hundred dollars", "$-100"],
  ["minus one hundred dollars", "-$100"],
  ["minus one hundred dollars", "- $ 100"],
  ["minus one hundred dollars", "$ - 100"],
  ["minus one hundred dollars", "$−100"],
  ["minus one hundred dollars", "−$100"],
  ["one dollar and two dollars", "$1 and $2"],
  ["I picked one dollar. Dollars mattered.", "I picked $1. Dollars mattered."],
  ["S. E. C. filed it.", "SEC filed it."],
]) {
  for (const [left, right] of [[intended, recognized], [recognized, intended]]) {
    const result = qa(left, right);
    assert.equal(result.deletions + result.insertions + result.substitutions, 0, `${left} / ${right}`);
  }
}
for (const [intended, recognized] of [
  ["one; two", "three"],
  ["four. Two", "six"],
  ["six. Ninety", "ninety-six"],
  ["one hundred and two hundred", "10200"],
  ["one million and two million", "3000000"],
  ["forty-two million and eighteen million", "sixty million"],
  ["forty-two million and eighteen million", "42 million and 19 million"],
  ["one hundred. Five", "105"],
  ["one dollar", "$2"],
  ["minus one hundred dollars", "$100"],
  ["one hundred dollars", "- $ 100"],
  ["one hundred dollars", "$ - 100"],
  ["one hundred dollars", "$−100"],
  ["two point two million dollars", "$2.3 million"],
  ["twelve hundred and sixty dollars", "$1,620"],
  ["twenty-five hundred", "2600"],
  ["one dollar and two dollars", "$2 and $1"],
]) {
  assert.ok(consensus(intended, recognized).blockers.some((finding) => finding.code.includes("protected_value")),
    `${intended} / ${recognized}`);
}
for (const [intended, recognized] of [
  ["He gave me one dollar.", "He gave me one."],
  ["One dollar and two dollars remained.", "$1 and 2 remained."],
  ["He bought a hundred-dollar bond.", "He bought $100."],
  ["two point two million dollars arrived", "$2.2 million"],
  ["I picked one. Dollars mattered.", "I picked $1. Mattered."],
  ["I counted one; dollars disappeared.", "I counted $1; disappeared."],
]) {
  assert.ok(qa(intended, recognized).deletions > 0, `${intended} / ${recognized}`);
  assert.ok(consensus(intended, recognized).blockers.length > 0);
}
assert.ok(qa("one dollar", "one pound").substitutions > 0);
assert.ok(qa("one dollar", "£1").deletions > 0);
assert.ok(qa("He paid $1.", "He paid one pound.").insertions > 0);

// A comparator-only refresh must use retained recognizer output. Any attempted
// new ASR fails the test. This does not create or approve production audio.
const noAsrHelpers = { ...helpers, runFasterWhisperUnitBatchForDiagnostics() {
  throw new Error("Unexpected repeated Medium ASR");
} };
const retained = {
  transcript_comparison_version: "older_ascii_comparison",
  primary_transcription: { text: "I'm ready.", words: [] },
  confirmation_windows: [{ binding_sha256: hash("old-window"),
    confirmation_recognized_text: "I'm ready.", confirmation_recognized_words: [],
    decision: { status: "blocked" }, confirmation_transcript_qa: { deletions: 1 } }],
  decision: { status: "blocked", blockers: [{ code: "old_phantom_i_deletion" }] },
};
const before = JSON.stringify(retained);
const refreshed = await runFullStreamDeliveryQa({
  helpers: noAsrHelpers, audioPath: "/must-not-read-audio.wav", audioSha256: hash("audio"),
  units: [{ unit_id: "unit_1", spoken_text: "I am ready." }], qualityContract: contract,
  orderQa: { blockers: [] }, joinQa: { blockers: [], warnings: [] },
  stitch: {}, workDir: "/must-not-write", localWhisperContract: { model: "small.en" },
  retainedEvidence: retained,
});
assert.equal(refreshed.decision.blockers.length, 0);
assert.equal(refreshed.primary_transcription, retained.primary_transcription);
assert.equal(refreshed.transcript_comparison_version, helpers.TRANSCRIPT_QA_COMPARISON_VERSION);
assert.equal(refreshed.confirmation_windows.length, 0);
assert.equal(refreshed.retained_confirmation_evidence.length, 1);
assert.equal(refreshed.retained_confirmation_evidence[0].confirmation_recognized_text, "I'm ready.");
assert.equal(refreshed.retained_confirmation_evidence[0].decision, undefined);
assert.equal(refreshed.retained_confirmation_evidence[0].confirmation_transcript_qa, undefined);
assert.equal(JSON.stringify(retained), before);

// Refresh the previous comparator's phantom numeric-article blocker without
// touching audio or rerunning either recognizer; preserve the retired raw window.
const numericRetained = {
  transcript_comparison_version: "unicode_words_exact_im_contraction_v1",
  primary_transcription: { text: hundredIntended.replace("a hundred million", "100 million"), words: [] },
  confirmation_model: "medium",
  confirmation_windows: [{ binding_sha256: hash("numeric-window"),
    confirmation_recognized_text: hundredIntended.replace("a hundred million", "$100 million"),
    confirmation_recognized_words: [], decision: { status: "blocked" },
    confirmation_transcript_qa: { deletions: 1 } }],
  decision: { status: "blocked", blockers: [{ code: "narration_confirmed_word_omission", words: ["a"] }] },
};
const numericBefore = JSON.stringify(numericRetained);
const numericRefreshed = await runFullStreamDeliveryQa({
  helpers: noAsrHelpers, audioPath: "/must-not-read-audio.wav", audioSha256: hash("numeric-audio"),
  units: [{ unit_id: "unit_78", spoken_text: hundredIntended }], qualityContract: contract,
  orderQa: { blockers: [] }, joinQa: { blockers: [], warnings: [] },
  stitch: {}, workDir: "/must-not-write", localWhisperContract: { model: "small.en" },
  retainedEvidence: numericRetained,
});
assert.equal(numericRefreshed.decision.blockers.length, 0);
assert.equal(numericRefreshed.primary_transcription, numericRetained.primary_transcription);
assert.equal(numericRefreshed.transcript_comparison_version, helpers.TRANSCRIPT_QA_COMPARISON_VERSION);
assert.equal(numericRefreshed.confirmation_windows.length, 0);
assert.equal(numericRefreshed.retained_confirmation_evidence.length, 1);
assert.equal(numericRefreshed.retained_confirmation_evidence[0].confirmation_recognized_text,
  numericRetained.confirmation_windows[0].confirmation_recognized_text);
assert.equal(numericRefreshed.retained_confirmation_evidence[0].decision, undefined);
assert.equal(numericRefreshed.retained_confirmation_evidence[0].confirmation_transcript_qa, undefined);
assert.equal(JSON.stringify(numericRetained), numericBefore);

// Keep a still-required exact Medium window while rebuilding its old decision.
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-comparison-test-"));
try {
  const sampleCount = 48000;
  const wav = Buffer.alloc(44 + sampleCount * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36);
  wav.writeUInt32LE(sampleCount * 2, 40);
  const audioPath = path.join(temp, "silence-fixture.wav");
  await fs.writeFile(audioPath, wav);
  const audioSha256 = hash(wav);
  const intended = "My fiancée left.";
  const words = [
    { word: "My", start_sec: 0.1, end_sec: 0.3 },
    { word: "fiancé", start_sec: 0.3, end_sec: 0.9 },
    { word: "left.", start_sec: 0.9, end_sec: 1.4 },
  ];
  const window = {
    unit_ids: ["unit_1"], boundary_ids: [], start_sample: 0, end_sample_exclusive: sampleCount,
    intended_text: intended, intended_text_sha256: hash(intended),
    audio_path: audioPath, audio_sha256: audioSha256, sample_count: sampleCount,
    confirmation_recognized_text: "My fiancé left.", confirmation_recognized_words: words,
  };
  window.binding_sha256 = hash(JSON.stringify({
    source_audio_sha256: audioSha256, start_sample: 0, end_sample_exclusive: sampleCount,
    intended_text_sha256: hash(intended), unit_ids: ["unit_1"], boundary_ids: [],
  }));
  const evidence = { primary_transcription: { text: "My fiancé left.", words },
    confirmation_model: "medium", confirmation_windows: [window] };
  const immutable = JSON.stringify(evidence);
  const result = await runFullStreamDeliveryQa({
    helpers: noAsrHelpers, audioPath, audioSha256,
    units: [{ unit_id: "unit_1", spoken_text: intended }], qualityContract: contract,
    orderQa: { blockers: [] }, joinQa: { blockers: [], warnings: [] },
    stitch: { prepared_inputs: [{ unit_id: "unit_1", sample_count: sampleCount }] },
    workDir: temp, localWhisperContract: { model: "small.en" }, retainedEvidence: evidence,
  });
  assert.equal(result.confirmation_windows.length, 1);
  assert.equal(result.confirmation_windows[0].audio_sha256, audioSha256);
  assert.equal(result.confirmation_windows[0].confirmation_recognized_words, words);
  assert.equal(result.confirmation_windows[0].primary_transcript_qa.deletions, 0);
  assert.equal(result.decision.blockers.length, 0);
  assert.equal(JSON.stringify(evidence), immutable);
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
console.log("narration transcript comparison tests passed");
