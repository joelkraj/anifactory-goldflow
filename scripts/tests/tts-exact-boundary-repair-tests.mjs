import assert from "node:assert/strict";
import { validateBoundaryRepairScopeForTests } from "../tts-exact-boundary-repair.mjs";

const unit = { unit_id: "unit-1", spoken_text: "First sentence. Missing ending." };
const comparatorOnly = { unit_id: "unit-2", spoken_text: "He is all right." };
const plan = { units: [unit, comparatorOnly], narration_quality_contract: {
  delivery_qa: { unconfirmed_primary_asr_requires_exact_listen: false },
} };
const manifest = { status: "passed", units: [
  { unit_id: "unit-1", audio_sha256: "a" },
  { unit_id: "unit-2", audio_sha256: "b" },
] };
const delivery = { status: "blocked", units: [
  { unit_id: "unit-1", audio_sha256: "a", intended_text: unit.spoken_text,
    primary_recognized_text: "First sentence. Missing.",
    confirmation_recognized_text: "First sentence. Missing.",
    decision: { status: "blocked", blockers: [{ code: "narration_confirmed_final_word_missing" }] } },
  { unit_id: "unit-2", audio_sha256: "b", intended_text: comparatorOnly.spoken_text,
    primary_recognized_text: "He is alright.",
    confirmation_recognized_text: "He is alright.",
    decision: { status: "blocked", blockers: [{ code: "narration_confirmed_final_token_mismatch" }] } },
] };
const spec = { schema: "goldflow_tts_exact_boundary_repair_spec_v1", units: [
  { unit_id: "unit-1", fragments: ["First sentence.", "Missing ending."] },
] };

assert.deepEqual(validateBoundaryRepairScopeForTests({ plan, manifest, delivery, spec }), {
  selected: ["unit-1"], orthographic: ["unit-2"],
});
const fullStreamDelivery = { status: "passed", units: delivery.units.map((row) => ({
  ...row, decision: { status: "passed", blockers: [] },
})) };
const fullStream = { status: "blocked", blockers: [{
  severity: "blocker", code: "narration_confirmed_word_omission", unit_id: "unit-1",
}] };
assert.deepEqual(validateBoundaryRepairScopeForTests({ plan, manifest,
  delivery: fullStreamDelivery, fullStream, spec }), {
  selected: ["unit-1"], orthographic: [],
});
assert.throws(() => validateBoundaryRepairScopeForTests({ plan, manifest,
  delivery: fullStreamDelivery, fullStream: { ...fullStream, blockers: [{
    severity: "blocker", code: "narration_confirmed_word_omission", unit_id: "unit-2",
  }] }, spec }), /scope is not current|Unrepaired full-stream blocker/);
assert.throws(() => validateBoundaryRepairScopeForTests({ plan, manifest, delivery,
  spec: { ...spec, units: [{ unit_id: "unit-1", fragments: ["First sentence.", "Wrong ending."] }] },
}), /scope is not current/);
assert.throws(() => validateBoundaryRepairScopeForTests({ plan, manifest, delivery: {
  ...delivery, units: delivery.units.map((row) => row.unit_id === "unit-2"
    ? { ...row, primary_recognized_text: "He is right.", confirmation_recognized_text: "He is right." } : row),
}, spec }), /substantive defect/);
assert.throws(() => validateBoundaryRepairScopeForTests({ plan, manifest, delivery, spec: {
  ...spec, units: [spec.units[0], spec.units[0]],
} }), /scope is not current/);

console.log("exact-boundary TTS repair scope tests passed");
