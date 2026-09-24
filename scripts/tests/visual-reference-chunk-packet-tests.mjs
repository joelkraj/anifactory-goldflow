import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  compactReferencePromptValue,
  expandReferencePromptValue,
} from "../lib/reference-prompt-format.mjs";
import {
  buildReferenceChunkPromptForTests,
  assertVisualReferencePromptBytesForTests,
  selectReferencePartialRepairScopeForTests,
  mergeReferencePartialRepairForTests,
} from "../visual-reference-plan.mjs";

const roundTrip = (value) => expandReferencePromptValue(JSON.parse(JSON.stringify(compactReferencePromptValue(value))));
const longText = "Exact source text: Renée’s paid proposal is a draft, never an accepted transfer; gold words remain private. ".repeat(3);
const rows = Array.from({ length: 8 }, (_, index) => ({
  ref_id: `distinct_ref_${index}`,
  kind: index % 2 ? "ui" : "prop",
  description: `${index}: ${longText}`,
  reason: `${index}: ${longText}`,
  reasons: [`${index}: ${longText}`],
  scene_ids: [`scene_${index}`],
  optional: null,
  required: false,
  author_decision: index % 2 ? "draft" : "accepted",
}));
const original = structuredClone(rows);
const packed = compactReferencePromptValue(rows);
assert.equal(packed.format, "goldflow_literal_rows_v1");
assert.deepEqual(packed.same_as.reason, "description");
assert.deepEqual(packed.same_as.reasons, ["description"]);
assert.deepEqual(roundTrip(rows), rows, "Every exact string, identity, scope and author distinction survives");
assert.deepEqual(rows, original, "Compaction must not mutate source objects");
assert.deepEqual(roundTrip({ nested: [rows, rows.slice(0, 3)], empty: [], zero: 0, no: false }), { nested: [rows, rows.slice(0, 3)], empty: [], zero: 0, no: false });
assert.deepEqual(roundTrip([{ id: 1 }, { id: 2, absent_in_first: null }, { id: 3, absent_in_first: "" }]), [{ id: 1 }, { id: 2, absent_in_first: null }, { id: 3, absent_in_first: "" }], "Missing/null/empty fields must not collapse");
assert.deepEqual(roundTrip([{ a: longText, b: "first" }, { b: "second", a: longText }]), [{ a: longText, b: "first" }, { b: "second", a: longText }]);
for (const format of ["goldflow_literal_rows_v1", "goldflow_literal_object_v1"]) {
  const authored = { format, fields: ["literal"], rows: [["not an encoding"]], value: { format, message: longText } };
  assert.deepEqual(roundTrip(authored), authored, "Authored objects matching encoding names must be escaped");
  assert.deepEqual(roundTrip([authored, authored]), [authored, authored]);
}
const specialKeys = Array.from({ length: 3 }, (_, index) => JSON.parse(`{"id":${index},"__proto__":${JSON.stringify(longText)},"constructor":${JSON.stringify(longText)}}`));
assert.deepEqual(roundTrip(specialKeys), specialKeys);
assert.throws(() => expandReferencePromptValue({ format: "goldflow_literal_rows_v1", fields: ["id"], rows: [[]] }), /column count/);
assert.throws(() => expandReferencePromptValue({ format: "goldflow_literal_rows_v1", fields: [], rows: [[]], same_as: { bad: "missing" } }), /source missing/);

const semantic = { source_script_hash: "a".repeat(64), scenes: [{ scene_id: "scene_001", location: "Office", ref_requirements: [] }] };
const small = buildReferenceChunkPromptForTests(semantic);
assert.equal(small, buildReferenceChunkPromptForTests(semantic, { compactOversized: false }), "Existing under-ceiling prompts/cache keys remain byte-identical");
assert.equal(createHash("sha256").update(small).digest("hex"), "1e8b94d0460a389d62f81e3a518285c1bf5b8326d3ab8fb4ba422282755a0560", "Under-ceiling prompt must retain the reviewed cast and beat-scoped wardrobe policy hash");

// Repeated exact evidence with one local beat used to overwhelm even a single
// scene. Formatting must preserve the payload, not discard refs or widen limits.
const largeSemantic = { ...semantic, scenes: [{
  ...semantic.scenes[0], ref_requirements: Array.from({ length: 24 }, (_, index) => ({ ...rows[index % rows.length], ref_id: `ref_${index}` })),
  visual_beats: [{ visual_beat_id: "beat_001", visual_beat_script_excerpt: "An actual current moment.", local_location: "Office", visible_subjects: ["Renée"] }],
}] };
const options = { locationContractLedger: { contracts: Array.from({ length: 6 }, (_, index) => ({
  location_contract_id: `loc_${index}`, semantic_ref_id: `location_${index}`, description: longText, prompt_anchor: longText,
  reasons: [longText], scene_ids: ["scene_001"], beat_ids: Array.from({ length: 55 }, (_, beat) => `exact_beat_${index}_${beat}`),
})) } };
const raw = buildReferenceChunkPromptForTests(largeSemantic, { ...options, compactOversized: false });
const compact = buildReferenceChunkPromptForTests(largeSemantic, options);
assert(Buffer.byteLength(raw) > 52_000, "Fixture must exercise the original byte-ceiling failure");
assert(Buffer.byteLength(compact) < 52_000, "Lossless formatting must fit without changing the ceiling");
const headings = ["VISUAL BIBLES AND OPERATOR DIRECTION:", "REFERENCE EVIDENCE LEDGER (scene-local; the global director receives the episode catalog later):", "LOCATION CONTRACT LEDGER:", "SEMANTIC PLAN:", "Return:"];
const payload = (text, index) => JSON.parse(text.split(`${headings[index]}\n`)[1].split(`\n\n${headings[index + 1]}`)[0]);
for (let index = 0; index < 4; index += 1) assert.deepEqual(expandReferencePromptValue(payload(compact, index)), payload(raw, index));
assert.deepEqual(JSON.parse(compact.split("\nReturn:\n")[1]), JSON.parse(raw.split("\nReturn:\n")[1]), "The full authored return schema remains unchanged");
assert.doesNotThrow(() => assertVisualReferencePromptBytesForTests(compact));
const irreducible = buildReferenceChunkPromptForTests({ ...semantic, episode_summary: "Unique indivisible source context. ".repeat(2500) });
assert.throws(() => assertVisualReferencePromptBytesForTests(irreducible), /above safe ceiling 52000/, "Truly oversized packets still block before providers");

// Exact failed leaves retain their IDs while every accepted proposal, raw path,
// input hash and candidate object survives the existing partial-repair merge.
const passed = { chunk_id: "chunk_passed", scene_ids: ["scene_002"], input_sha256: "b".repeat(64), output_path: "/immutable/passed-output.txt", candidate_plan: { reference_targets: rows, warnings: [{ code: "keep_exact_warning" }] } };
const failed = [1, 2].map((n) => ({ chunk_id: `chunk_failed_${n}`, scene_ids: ["scene_001"], beat_ids: [`beat_${n}`], input_sha256: String(n).repeat(64) }));
const partial = { status: "needs_chunk_repair", passed_chunks: [passed], failed_chunks: failed };
const prior = structuredClone(partial);
const selection = selectReferencePartialRepairScopeForTests(partial, { chunkIds: [failed[0].chunk_id] });
assert.deepEqual(selection.selected_chunks[0].beat_ids, ["beat_1"]);
assert.throws(() => selectReferencePartialRepairScopeForTests(partial, { chunkIds: [passed.chunk_id] }), /non-failed/);
const repaired = { ...failed[0], candidate_plan: { reference_targets: [{ ref_id: "newly_authored" }] }, input_sha256: "f".repeat(64) };
const merged = mergeReferencePartialRepairForTests(partial, [{ original_chunk_id: failed[0].chunk_id, status: "passed", repair_scene_ids: ["scene_001"], passed_chunk: repaired }]);
assert.deepEqual(merged.passed_chunks, [passed, repaired]);
assert.deepEqual(merged.failed_chunks, [failed[1]], "Repairing one leaf must not remove another leaf from the same scene");
assert.deepEqual(partial, prior);
console.log("PASS lossless reference chunk packet formatting and retained exact recovery");
