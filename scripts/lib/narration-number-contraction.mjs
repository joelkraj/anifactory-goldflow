// This remains a lexical substitution, never an accepted spelling equivalence.
// ASR's digit for the pronoun in “one's” does not prove a changed numeric value.
// Ordinary delivery policy still handles omissions and opening/final differences.
// The pairs live in the frozen, hash-bound spoken-form equivalence table (R05).
import { isNarrationSameValueContraction } from "./narration-spoken-form-equivalences.mjs";

export function isSameValueNumberContraction(operation) {
  return isNarrationSameValueContraction(operation);
}
