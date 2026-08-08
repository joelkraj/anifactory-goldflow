import assert from "node:assert/strict";

import {
  hasTtsTerminalPunctuation,
  isInlineQuotedNarrationTerm,
  normalizeAtomicSpokenTerminal,
} from "../voice-direction-gate.mjs";

assert.equal(isInlineQuotedNarrationTerm({
  before: "The second time, because I wrote",
  quotedText: "currently uncertain",
}), true);
assert.equal(isInlineQuotedNarrationTerm({
  before: "Serena said,",
  quotedText: "You are coming with me.",
}), false);

assert.equal(
  normalizeAtomicSpokenTerminal("Current Rank: B", {
    sourceText: "CURRENT RANK: B",
    kind: "narration",
  }),
  "Current Rank: B.",
);
assert.equal(
  normalizeAtomicSpokenTerminal("Elara Venn", {
    sourceText: "ELARA VENN",
    kind: "narration",
  }),
  "Elara Venn.",
);
assert.equal(
  normalizeAtomicSpokenTerminal("because I wrote", {
    sourceText: "because I wrote",
    kind: "narration",
  }),
  "because I wrote",
);
assert.equal(hasTtsTerminalPunctuation("I knew you would—"), true);

console.log("voice-direction boundary tests passed");
