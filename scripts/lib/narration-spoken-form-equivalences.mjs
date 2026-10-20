import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Stabilization roadmap R05(3): the comparator's spoken-form equivalences are a
// frozen, hash-bound table extracted from the deepmale-default comparator
// commits (27257e3, 6cc4466, 9d150d0, febb091). The comparator reads the table
// here; new automated identities bind its sha into their narration quality
// contract, so changing the table is a relock, never a mid-run edit. The table
// compares; it never rewrites approved spoken text.

export const NARRATION_SPOKEN_FORM_EQUIVALENCES_SCHEMA =
  "goldflow_narration_spoken_form_equivalences_v1";
export const NARRATION_SPOKEN_FORM_EQUIVALENCES_RELATIVE_PATH =
  "config/narration_spoken_form_equivalences_v1.json";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const NARRATION_SPOKEN_FORM_EQUIVALENCES_PATH = path.join(
  REPO_ROOT,
  NARRATION_SPOKEN_FORM_EQUIVALENCES_RELATIVE_PATH,
);

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function loadNarrationSpokenFormEquivalences(filePath = NARRATION_SPOKEN_FORM_EQUIVALENCES_PATH) {
  const buffer = readFileSync(filePath);
  const table = JSON.parse(buffer.toString("utf8"));
  if (table?.schema !== NARRATION_SPOKEN_FORM_EQUIVALENCES_SCHEMA
    || !String(table?.version ?? "").trim()
    || !Array.isArray(table.honorific_spellings)
    || !Array.isArray(table.orthographic_variants)
    || !Array.isArray(table.compounds)
    || !Array.isArray(table.same_value_contractions)
    || !table.grouped_numbers) {
    throw new Error(`Invalid narration spoken-form equivalence table: ${filePath}`);
  }
  return deepFreeze({
    table,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    path: filePath,
  });
}

const loaded = loadNarrationSpokenFormEquivalences();
export const NARRATION_SPOKEN_FORM_EQUIVALENCES = loaded.table;
export const NARRATION_SPOKEN_FORM_EQUIVALENCES_SHA256 = loaded.sha256;
export const NARRATION_SPOKEN_FORM_EQUIVALENCES_VERSION = loaded.table.version;

const honorificRules = NARRATION_SPOKEN_FORM_EQUIVALENCES.honorific_spellings.map((row) => ({
  pattern: new RegExp(row.pattern, "gu"),
  spoken: row.spoken,
}));
const orthographicRules = NARRATION_SPOKEN_FORM_EQUIVALENCES.orthographic_variants.map((row) => ({
  pattern: new RegExp(`\\b${row.from}\\b`, row.case_insensitive ? "giu" : "gu"),
  to: row.to,
}));
const compoundByParts = new Map(NARRATION_SPOKEN_FORM_EQUIVALENCES.compounds.map((row) => [
  row.parts.join(" "),
  row.joined,
]));
const sameValueContractions = NARRATION_SPOKEN_FORM_EQUIVALENCES.same_value_contractions;
const grouped = NARRATION_SPOKEN_FORM_EQUIVALENCES.grouped_numbers;

export const NARRATION_GROUPED_NUMBER_RULES = Object.freeze({
  lead: new RegExp(grouped.lead_token_pattern),
  part: new RegExp(grouped.part_token_pattern),
  zeroWord: grouped.zero_word,
  maxGroupTokens: Number(grouped.max_group_tokens),
  targets: grouped.target_patterns.map((row) => new RegExp(row.pattern)),
});

// Comparison-side spelling: written honorifics and spelling variants become
// their single spoken form on whichever side carries them.
export function applyNarrationSpokenFormSpellings(text) {
  let output = String(text ?? "");
  for (const rule of honorificRules) output = output.replace(rule.pattern, rule.spoken);
  for (const rule of orthographicRules) output = output.replace(rule.pattern, rule.to);
  return output;
}

export function narrationSpokenFormCompound(left, right) {
  return compoundByParts.get(`${left} ${right}`) ?? null;
}

// A same-value contraction stays a lexical substitution (warning), never a
// protected-value mismatch: ASR's digit for the pronoun in "one's" does not
// prove a changed numeric value.
export function isNarrationSameValueContraction(operation) {
  return operation?.type === "substitution"
    && sameValueContractions.some((row) => (
      operation.intended === row.intended && operation.recognized === row.recognized
    ));
}

export function narrationSpokenFormEquivalencesBinding() {
  return {
    schema: NARRATION_SPOKEN_FORM_EQUIVALENCES_SCHEMA,
    version: NARRATION_SPOKEN_FORM_EQUIVALENCES_VERSION,
    config_path: NARRATION_SPOKEN_FORM_EQUIVALENCES_RELATIVE_PATH,
    config_sha256: NARRATION_SPOKEN_FORM_EQUIVALENCES_SHA256,
  };
}
