import assert from "node:assert/strict";
import { transcriptQaForTests, TRANSCRIPT_QA_COMPARISON_VERSION } from "../modelslab-qwen-episode-audio.mjs";
import { adjudicateNarrationDeliveryConsensus } from "../lib/narration-delivery-quality.mjs";
import { buildNarrationQualityContract } from "../lib/narration-quality-contract.mjs";

const contract = buildNarrationQualityContract({ provider: "qwen_local", modelId: "test" });
const qa = (intended, recognized) => transcriptQaForTests(intended, recognized, { blockAnySubstitution: false });
const decision = (intended, recognized) => adjudicateNarrationDeliveryConsensus({
  primaryTranscriptQa: qa(intended, recognized), confirmationTranscriptQa: qa(intended, recognized), contract,
});
const edits = (result) => result.deletions + result.insertions + result.substitutions;

for (const [intended, recognized] of [
  ["You think it is going to happen again.", "You think it is gonna happen again."],
  ["You think it is gonna happen again.", "You think it is going to happen again."],
  ["I am not going to leave.", "I am not gonna leave."],
  ["The keeper saved two.", "The keeper saved too."],
  ["The keeper saved 2.", "The keeper saved too."],
  ["Two saves mattered.", "Too saves mattered."],
  ["He saved two goals and two penalties.", "He saved too goals and too penalties."],
  ["I can see you are all right.", "I can see you are alright."],
  ["He hit the doorframe.", "He hit the door frame."],
  ["Coldwater opened the door.", "Cold water opened the door."],
  ["I connected to Wi-Fi and called Claire.", "I connected to wifi and called Claire."],
  ["Every body had inherited the training.", "Everybody had inherited the training."],
  ["She had slept too; there was coffee.", "She had slept two; there was coffee."],
]) {
  assert.equal(edits(qa(intended, recognized)), 0, `${intended} / ${recognized}`);
  assert.equal(decision(intended, recognized).blockers.length, 0);
}

const source = "The keeper saved two. The captain scored.";
const recognized = "The keeper saved too. The captain scored.";
const result = qa(source, recognized);
assert.equal(source, "The keeper saved two. The captain scored.");
assert.equal(recognized, "The keeper saved too. The captain scored.");
assert.equal(result.comparison_version, TRANSCRIPT_QA_COMPARISON_VERSION);
assert.deepEqual(result.phonetic_spelling_equivalences, [{
  intended_index: 3, recognized_index: 3, intended: "num:2", recognized: "too", rule: "aligned_two_too_spelling",
}]);
for (const intended of ["It is going to happen.", "It is gonna happen.", "He saved two goals."]) {
  const stableTokens = qa(intended, intended).intended_canonical_tokens;
  for (const heard of [intended, intended.replace("going to", "gonna"), intended.replace("gonna", "going to"), intended.replace("two", "too"), ""]) {
    assert.deepEqual(qa(intended, heard).intended_canonical_tokens, stableTokens);
  }
}

// A phonetic spelling cannot supply an absent word, number, negation or repeat.
for (const [intended, recognized] of [
  ["The keeper saved two.", "The keeper saved."],
  ["The keeper saved two.", "The keeper saved three."],
  ["The keeper saved two.", "The keeper saved to."],
  ["He saved two million.", "He saved too million."],
  ["He paid two dollars.", "He paid too."],
  ["He saved two, two penalties.", "He saved too penalties."],
  ["He saved two penalties.", "He saved too too penalties."],
  ["He saved two goals and two penalties.", "He saved too goals and penalties."],
  ["He did not save two goals.", "He did save too goals."],
  ["You think it is going to happen again.", "You think it is happen again."],
  ["You think it is going to happen again.", "You think it is to happen again."],
  ["I am not going to leave.", "I am gonna leave."],
  ["I am going not to leave.", "I am gonna leave."],
  ["I am gonna go.", "I am gonna gonna go."],
]) {
  assert.ok(edits(qa(intended, recognized)) > 0, `${intended} / ${recognized}`);
  assert.ok(decision(intended, recognized).blockers.length > 0, `${intended} / ${recognized}`);
}

// An unrelated too cannot cross punctuation to replace an omitted two. The
// comparator remains conservative when its immediate anchors are not aligned.
for (const [intended, recognized] of [
  ["I am going. To leave is hard.", "I am gonna leave is hard."],
  ["I am going, to leave is hard.", "I am gonna leave is hard."],
  ["I am going to leave.", "I am. Gonna leave."],
  ["I am going to go.", "I am gonna gonna go."],
  ["He saved two. Goals mattered.", "He saved. Too goals mattered."],
  ["He saved two, goals mattered.", "He saved, too goals mattered."],
  ["He saved two. Too late.", "He saved. Too late."],
  ["He saved three.", "He saved too."],
  ["He was too late.", "He was two late."],
]) {
  const compared = qa(intended, recognized);
  assert.ok(edits(compared) > 0, `${intended} / ${recognized}`);
  assert.deepEqual(compared.phonetic_spelling_equivalences, []);
}
// Existing currency/article notation can change token coordinates. Do not infer
// a phonetic match against those shifted coordinates.
assert.deepEqual(qa("He paid two dollars and saved two goals.", "He paid $2 and saved too goals.")
  .phonetic_spelling_equivalences, []);

console.log("narration transcript phonetic spelling tests passed");
