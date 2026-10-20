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
