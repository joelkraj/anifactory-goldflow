import assert from "node:assert/strict";
import { transcriptQaForTests as qa } from "../modelslab-qwen-episode-audio.mjs";

const errors = (a, b) => {
  const q = qa(a, b);
  return q.deletions + q.insertions + q.substitutions;
};
for (const [a, b] of [
  ["Room four twelve.", "Room 412."],
  ["At ten twenty-two.", "At 10.22."],
  ["Two oh one.", "201."],
  ["Doctor Ward.", "Dr. Ward."],
  ["Mister Walsh.", "Mr. Walsh."],
  ["It was canceled.", "It was cancelled."],
  ["Every one.", "Everyone."],
]) assert.equal(errors(a, b), 0, `${a} / ${b}`);
for (const [a, b] of [
  ["Room four twelve.", "Room 413."],
  ["Four, twelve.", "412."],
  ["Four and twelve.", "412."],
  ["Two oh one.", "207."],
  ["Ten dollars twenty-two.", "1022."],
  ["A hundred dollars.", "A thousand dollars."],
  ["Doctor Ward.", "Ward."],
]) assert.ok(errors(a, b) > 0, `${a} / ${b}`);
console.log("ASR notation equivalence and changed-digit/punctuation/word-loss tests passed");
const { adjudicateNarrationDeliveryConsensus: decide } = await import('../lib/narration-delivery-quality.mjs');
const delivery = (a, b) => decide({ primaryTranscriptQa: qa(a, b, {blockAnySubstitution:false}),
  confirmationTranscriptQa: qa(a,b,{blockAnySubstitution:false}),
  contract:{delivery_qa:{unconfirmed_primary_asr_requires_exact_listen:false}} });
const lexical=delivery("Three. One's stuck. Then he left.", 'Three. One stuck. Then he left.');
assert.equal(lexical.blockers.length,0);assert.ok(lexical.warnings.length);
assert.ok(delivery("Three. One's stuck. Then he left.",'Three. Two stuck. Then he left.').blockers.length);
assert.ok(delivery("One's stuck. Then he left.",'One stuck. Then he left.').blockers.length);
assert.ok(delivery("Three. One's stuck. Then he left.",'Three. One stuck. Then.').blockers.length);
