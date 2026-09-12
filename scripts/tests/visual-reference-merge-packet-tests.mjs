#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  buildMergePromptForTests,
  buildReferenceDirectorCandidateCardsForTests,
  compactReferenceDirectorMergePayloadsForTests,
  VISUAL_REFERENCE_DIRECTOR_SAFE_MAX_BYTES,
} from "../visual-reference-plan.mjs";

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

console.log("PASS visual-reference merge packet lossless compaction");
