#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  buildMergePromptForTests,
  buildReferenceDirectorCandidateCardsForTests,
  compactReferenceDirectorMergePayloadsForTests,
  compactOversizedReferenceDirectorPromptForTests,
  compactReferenceDirectorCardDefaultsForTests,
  expandReferenceDirectorCardDefaultsForTests,
  assertVisualReferencePromptBytesForTests,
  VISUAL_REFERENCE_DIRECTOR_SAFE_MAX_BYTES,
} from "../visual-reference-plan.mjs";
import { expandReferencePromptValue } from "../lib/reference-prompt-format.mjs";

const expandTable = (table) => table.rows.map((values) => ({
  ...table.constants,
  ...Object.fromEntries(table.fields.map((field, index) => [field, values[index]])),
}));
const expandLines = (rows, format) => expandTable({ ...format, rows }).map((row) => (
  format.all_fields.filter((field) => row[field] !== null)
    .map((field, index) => index === 0 ? row[field] : `${field}=${row[field]}`).join(" | ")
));
const expandCards = (payload) => {
  const { source_schema, target_candidate_line_format, character_state_candidate_line_format, ...original } = payload;
  return {
    ...original,
    schema: source_schema,
    cards: expandTable(payload.cards).map((card) => ({
      ...card,
      target_candidate_lines: expandLines(card.target_candidate_lines, target_candidate_line_format),
      character_state_candidate_lines: expandLines(card.character_state_candidate_lines, character_state_candidate_line_format),
    })),
    unlinked_character_state_candidates: expandLines(payload.unlinked_character_state_candidates, character_state_candidate_line_format),
  };
};
const expandEvidence = (payload) => {
  const { source_schema, ...original } = payload;
  return { ...original, schema: source_schema, asset_lines: expandLines(payload.asset_lines.rows, payload.asset_lines) };
};
const normalized = [{
  referenceTargets: [
    { candidate_id: "rt_0001", ref_id: "same_identity", kind: "character_state", inventory_asset_id: "hero", subject: "Renée", scene_ids: ["scene_001"], planned_beat_ids: ["beat_001"], prompt_anchor: "Renée; cobalt coat", state_delta: "cobalt coat; wrist badge=blue", base_asset_id: "hero_face", priority: "required", generation_mode: "standalone_ref", required_before_imagegen: true },
    { candidate_id: "rt_0002", ref_id: "same_identity", kind: "character_state", inventory_asset_id: "hero", subject: "Renée", scene_ids: ["scene_003"], planned_beat_ids: ["beat_006"], prompt_anchor: "Renée; cobalt coat", state_delta: "cobalt coat; wrist badge=blue", base_asset_id: "hero_face", priority: "supporting", generation_mode: "manual_review", required_before_imagegen: false },
    { candidate_id: "rt_0003", ref_id: "later_identity", kind: "character_state", inventory_asset_id: "hero", subject: "Renée", scene_ids: ["scene_009"], planned_beat_ids: ["beat_019"], prompt_anchor: "Renée in a distinct ivory coat", state_delta: "ivory coat", priority: "required", generation_mode: "standalone_ref" },
    { candidate_id: "rt_0004", ref_id: "blue_console", kind: "ui", inventory_asset_id: "console", subject: "Blue console", scene_ids: ["scene_001"], planned_beat_ids: ["beat_002"], prompt_anchor: "Console text: POWER=100; cobalt frame" },
  ],
  characterStateRefs: [
    { candidate_id: "cs_0001", state_ref_id: "hero_base", source_target_candidate_id: "rt_0001", base_identity_ref_id: "hero_face", identity_usage_override: "full_identity" },
    { candidate_id: "cs_0002", state_ref_id: "hero_later", source_target_candidate_id: "rt_0003", scene_ids_override: ["scene_009"], identity_usage_override: "face_only" },
    { candidate_id: "cs_0003", state_ref_id: "unlinked_state", source_target_candidate_id: null, scene_ids_override: ["scene_011"] },
  ],
}];
const cards = {
  ...buildReferenceDirectorCandidateCardsForTests(normalized),
  chunk_warning_summary: [{ code: "retained_warning", count: 1, example: "Review source evidence." }],
};
const evidence = {
  schema: "goldflow_reference_evidence_ledger_v1",
  summary: { asset_count: 2 },
  asset_count: 2,
  asset_lines: [
    "hero | kind=character_state | subject=Renée | entity=named_character | scenes=3 | beats=12 | span_sec=400 | canonical=renée",
    "console | kind=ui | subject=POWER=100 console | entity=ui | scenes=2 | beats=5 | span_sec=210",
  ],
};
const compacted = compactReferenceDirectorMergePayloadsForTests(cards, evidence);
assert.deepEqual(expandCards(compacted.candidateCards), cards, "Every card, candidate ID, distinction, scope, unlinked state and warning must round-trip exactly");
assert.deepEqual(expandEvidence(compacted.evidenceLedger), evidence, "Every original evidence line must round-trip byte-for-byte");
assert(!JSON.stringify(compacted).includes('"dictionaries"'), "Values must remain literal readable values");
assert.throws(() => compactReferenceDirectorMergePayloadsForTests(cards, { ...evidence, asset_lines: ["asset | unknown_field=do not silently drop"] }), /losslessly/);
const empty = { ...cards, cards: [], unlinked_character_state_candidates: [] };
assert.deepEqual(expandCards(compactReferenceDirectorMergePayloadsForTests(empty, { ...evidence, asset_lines: [] }).candidateCards), empty);

const semantic = { source_script_hash: "a".repeat(64), scenes: [{ scene_id: "scene_001" }] };
const small = buildMergePromptForTests(semantic, []);
assert(!small.prompt.includes("goldflow_reference_director_candidate_card_tables_v2"), "Under-ceiling historical packets retain the existing format");

// A long episode with distinct authored candidates crosses the old byte ceiling;
// formatting alone must admit its single global call and preserve full catalogs.
const targets = Array.from({ length: 350 }, (_, index) => ({
  ref_id: `authored_identity_${String(index).padStart(4, "0")}`,
  kind: "character_state",
  inventory_asset_id: `distinct_family_${index}`,
  subject: `Named person ${index}`,
  scene_ids: ["scene_001"],
  planned_beat_ids: [`beat_${index}`],
  priority: "required",
  generation_mode: "standalone_ref",
  required_before_imagegen: true,
  prompt_anchor: `Named person ${index}, exact cobalt wardrobe and uniquely authored silver clasp ${index}.`,
  state_delta: `Cobalt wardrobe with unique silver clasp ${index}`,
  source_evidence: { exact_text: `Evidence for person ${index}`, never_prompt_truncated: true },
}));
const refs = targets.map((target) => ({ state_ref_id: target.ref_id, source_ref_id: target.ref_id, scene_ids: target.scene_ids, character: target.subject, identity_usage: "full_identity" }));
const original = structuredClone({ targets, refs });
const large = buildMergePromptForTests(semantic, [{ reference_targets: targets, character_state_refs: refs }]);
assert(large.prompt.includes("goldflow_reference_director_candidate_card_tables_v2"), "Oversized packet must use the lossless fallback");
assert(Buffer.byteLength(large.prompt) <= VISUAL_REFERENCE_DIRECTOR_SAFE_MAX_BYTES, "Long fixture must fit without widening the global limit");
assert.deepEqual([...large.candidateCatalog.referenceTargetCatalog.values()], original.targets, "Full authored target catalog must remain exact");
assert.deepEqual([...large.candidateCatalog.characterStateRefCatalog.values()], original.refs, "Full authored state catalog must remain exact");
assert.deepEqual({ targets, refs }, original, "Input candidates must not be mutated");
const promptCards = JSON.parse(large.prompt.split("CANDIDATE CARDS:\n")[1].split("\n\nReturn:")[0]);
const restored = expandCards(promptCards);
assert.equal(restored.reference_target_proposal_count, targets.length);
assert.equal(restored.character_state_proposal_count, refs.length);
assert.deepEqual(restored.cards.flatMap((card) => card.target_candidate_lines.flatMap((line) => line.split(" | ")[0].split(","))), [...large.candidateCatalog.referenceTargetCatalog.keys()]);
assert.deepEqual(restored.cards.flatMap((card) => card.character_state_candidate_lines.flatMap((line) => line.split(" | ")[0].split(","))), [...large.candidateCatalog.characterStateRefCatalog.keys()]);

const headings = ["VISUAL BIBLES AND OPERATOR DIRECTION:", "REFERENCE EVIDENCE LEDGER:", "LOCATION CONTRACT LEDGER:", "EPISODE SUMMARY:", "CANDIDATE CARDS:", "Return:"];
const payload = (prompt, index) => {
  const start = prompt.indexOf(`${headings[index]}\n`) + headings[index].length + 1;
  const end = index + 1 < headings.length ? prompt.indexOf(`\n\n${headings[index + 1]}\n`, start) : prompt.length;
  return JSON.parse(prompt.slice(start, end));
};
const expandedPayload = (prompt, index) => {
  const value = expandReferencePromptValue(payload(prompt, index));
  return index === 4 ? expandReferenceDirectorCardDefaultsForTests(value) : value;
};
assert.equal(compactOversizedReferenceDirectorPromptForTests(small.prompt), small.prompt, "Under-ceiling prompts stay byte-identical");
assert.equal(compactOversizedReferenceDirectorPromptForTests(large.prompt), large.prompt, "Already fitting card-table prompts stay byte-identical");

// The existing table fallback can still leave repeated bible/entity metadata
// over the limit. Pack literal values without changing any candidate card,
// scope, user direction, reserved-format object or JSON null/false distinction.
const bible = {
  rows: Array.from({ length: 600 }, (_, index) => ({
    identity: `source_identity_${index}`,
    exact_alias: `source_identity_${index}`,
    singleton_scope: [`source_identity_${index}`],
    direction: "Preserve the exact authored appearance, quoted source evidence, object custody and location scope. ".repeat(3),
    fact: `Verbatim source fact ${index}: café, Joey’s watch, $2.2 million.`,
    optional: index % 2 ? null : false,
  })),
  distinct_values: [{ missing_is_not_null: true }, { missing_is_not_null: true, nullable: null }],
  authored_reserved_format: { format: "goldflow_literal_rows_v1", fields: ["author_data"], rows: [["literal source object"]] },
};
const originalGuidance = payload(large.prompt, 0);
const expandedGuidance = { ...originalGuidance, visual_style_bible: bible };
const oversized = large.prompt.replace(JSON.stringify(originalGuidance), JSON.stringify(expandedGuidance));
assert(Buffer.byteLength(oversized) > VISUAL_REFERENCE_DIRECTOR_SAFE_MAX_BYTES);
const packed = compactOversizedReferenceDirectorPromptForTests(oversized);
assert(Buffer.byteLength(packed) <= VISUAL_REFERENCE_DIRECTOR_SAFE_MAX_BYTES, "Observed form of repeated guidance fits through formatting only");
assertVisualReferencePromptBytesForTests(packed, { label: "visual-reference global director merge", maxBytes: VISUAL_REFERENCE_DIRECTOR_SAFE_MAX_BYTES });
for (let index = 0; index < headings.length; index += 1) {
  assert.deepEqual(expandedPayload(packed, index), payload(oversized, index), `All values in ${headings[index]} must round-trip`);
}
assert.equal(compactOversizedReferenceDirectorPromptForTests(packed), packed, "A fitting packed prompt needs no further formatting");
const integrated = buildMergePromptForTests(semantic, [{ reference_targets: targets, character_state_refs: refs }], { visualStyleBible: bible });
assert(Buffer.byteLength(integrated.prompt) <= VISUAL_REFERENCE_DIRECTOR_SAFE_MAX_BYTES);
assert.deepEqual(expandReferencePromptValue(payload(integrated.prompt, 0)).visual_style_bible, bible);
assert.deepEqual([...integrated.candidateCatalog.referenceTargetCatalog.values()], original.targets, "Final fallback preserves complete target objects");
assert.deepEqual([...integrated.candidateCatalog.characterStateRefCatalog.values()], original.refs, "Final fallback preserves complete state objects");
const irreducible = small.prompt.replace(JSON.stringify(payload(small.prompt, 0)), JSON.stringify({ exact_operator_text: "z".repeat(VISUAL_REFERENCE_DIRECTOR_SAFE_MAX_BYTES) }));
assert.throws(() => assertVisualReferencePromptBytesForTests(compactOversizedReferenceDirectorPromptForTests(irreducible), { label: "visual-reference global director merge", maxBytes: VISUAL_REFERENCE_DIRECTOR_SAFE_MAX_BYTES }), /above safe ceiling 229376/, "Irreducible packets remain blocked at the unchanged ceiling");

// Make formerly constant fields vary, including literal null/false/empty
// exceptions, and retain mismatched or unlinked state names as explicit data.
const mixedCards = expandCards(promptCards);
mixedCards.cards[0].target_candidate_lines[0] = mixedCards.cards[0].target_candidate_lines[0].replace("mode=standalone_ref", "mode=manual_review").replace("required=1", "required=0");
mixedCards.cards[0].character_state_candidate_lines[0] = mixedCards.cards[0].character_state_candidate_lines[0].replace("usage=full_identity", "usage=face_only").replace("state_ref=authored_identity_0000", "state_ref=different_state_name");
mixedCards.unlinked_character_state_candidates = ["cs_unlinked | state_ref=unlinked_state | source_targets=unlinked"];
const mixed = compactReferenceDirectorMergePayloadsForTests(mixedCards, evidence).candidateCards;
const targetColumn = mixed.cards.fields.indexOf("target_candidate_lines");
const modeColumn = mixed.target_candidate_line_format.fields.indexOf("mode");
for (const [index, value] of [null, false, ""].entries()) mixed.cards.rows[index + 1][targetColumn][0][modeColumn] = value;
const untouched = structuredClone(mixed);
const defaultCards = compactReferenceDirectorCardDefaultsForTests(mixed);
assert.equal(defaultCards.schema, "goldflow_reference_director_candidate_card_defaults_v3");
assert(Buffer.byteLength(JSON.stringify(defaultCards)) < Buffer.byteLength(JSON.stringify(mixed)));
assert.deepEqual(expandReferenceDirectorCardDefaultsForTests(defaultCards), mixed, "Every literal, candidate ID, scope, differing name and unlinked state must survive defaults and source aliases");
assert.deepEqual(mixed, untouched, "Card inputs remain untouched");
assert.deepEqual(compactReferenceDirectorCardDefaultsForTests(defaultCards), defaultCards, "Already packed schemas are not reinterpreted");
assert(defaultCards.character_state_candidate_line_format.field_aliases?.state_ref, "Matching state names use the explicit source-target ref alias");
const brokenAlias = structuredClone(defaultCards);
const stateColumn = brokenAlias.cards.fields.indexOf("character_state_candidate_lines");
const stateFormat = brokenAlias.character_state_candidate_line_format;
const sourcesColumn = stateFormat.fields.indexOf("source_targets");
brokenAlias.cards.rows[5][stateColumn][0][sourcesColumn] = "rt_absent";
assert.throws(() => expandReferenceDirectorCardDefaultsForTests(brokenAlias), /Unresolved/, "A missing alias source cannot invent a value");
const dependencyInput = structuredClone(mixed);
const sourceIndex = dependencyInput.character_state_candidate_line_format.fields.indexOf("source_targets");
const stateIndex = dependencyInput.character_state_candidate_line_format.fields.indexOf("state_ref");
const dependencyStateColumn = dependencyInput.cards.fields.indexOf("character_state_candidate_lines");
for (let index = 0; index < 300; index += 1) {
  dependencyInput.cards.rows[index][dependencyStateColumn][0][sourceIndex] = "rt_0002";
  dependencyInput.cards.rows[index][dependencyStateColumn][0][stateIndex] = "authored_identity_0001";
}
const dependencyPacked = compactReferenceDirectorCardDefaultsForTests(dependencyInput);
assert.equal(dependencyPacked.character_state_candidate_line_format.defaults.source_targets, "rt_0002", "Fixture must select a shared source-target default");
assert(dependencyPacked.character_state_candidate_line_format.field_aliases.state_ref);
assert.deepEqual(expandReferenceDirectorCardDefaultsForTests(dependencyPacked), dependencyInput, "Alias lookup must use overridden source_targets, while explicit state_ref overrides retain priority");
const emptyCards = { ...mixed, cards: { ...mixed.cards, rows: [] }, unlinked_character_state_candidates: [] };
assert.deepEqual(compactReferenceDirectorCardDefaultsForTests(emptyCards), emptyCards);

console.log("PASS visual-reference merge packet lossless compaction");
