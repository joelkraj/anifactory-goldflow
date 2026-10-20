// This remains a lexical substitution, never an accepted spelling equivalence.
// ASR's digit for the pronoun in “one's” does not prove a changed numeric value.
// Ordinary delivery policy still handles omissions and opening/final differences.
export function isSameValueNumberContraction(operation) {
  return operation?.type === "substitution"
    && operation.intended === "one's"
    && operation.recognized === "num:1";
}
