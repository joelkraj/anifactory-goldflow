import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { validateBoundaryRepairScopeForTests,
  validateSubsetBoundaryFinalizationForTests,
  selectBoundaryRepairFullStreamForTests } from "../tts-exact-boundary-repair.mjs";
import { assertPartialRepairUnitBlockerHoldForTests } from "../narration-provider-output-finalize.mjs";

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
const unitOnlyDelivery = { status: "blocked", units: delivery.units.map((row) => row.unit_id === "unit-2"
  ? { ...row, decision: { status: "passed", blockers: [] } } : row) };
assert.deepEqual(validateBoundaryRepairScopeForTests({ plan, manifest, delivery: unitOnlyDelivery,
  fullStream: { status: "not_run_due_to_unit_blockers", blockers: [{
    severity: "blocker", code: "stale_prior_attempt", unit_id: "unit-2",
  }] }, spec }), {
  selected: ["unit-1"], orthographic: [],
});
const fullStreamDelivery = { status: "passed", units: delivery.units.map((row) => ({
  ...row, decision: { status: "passed", blockers: [] },
})) };
const fullStream = { status: "blocked", blockers: [{
  severity: "blocker", code: "narration_confirmed_word_omission", unit_id: "unit-1",
}] };
assert.throws(() => validateBoundaryRepairScopeForTests({ plan, manifest,
  delivery: fullStreamDelivery, fullStream, spec }), /a blocked full-stream report is required/);
assert.throws(() => validateBoundaryRepairScopeForTests({ plan, manifest,
  delivery: fullStreamDelivery, fullStream: { ...fullStream, blockers: [{
    severity: "blocker", code: "narration_confirmed_word_omission", unit_id: "unit-2",
  }] }, spec }), /a blocked full-stream report is required/);
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

const digest = (text) => createHash("sha256").update(text).digest("hex");
const subsetPlan = { plan_sha256: digest("plan"), units: [
  { unit_id: "cutoff", spoken_text: "He was twenty, two years older.",
    spoken_text_sha256: digest("He was twenty, two years older.") },
  { unit_id: "retained-a", spoken_text: "Beren arrived.",
    spoken_text_sha256: digest("Beren arrived.") },
  { unit_id: "retained-b", spoken_text: "Every one.",
    spoken_text_sha256: digest("Every one.") },
] };
const subsetManifest = { status: "passed", units: subsetPlan.units.map((row) => ({
  unit_id: row.unit_id, audio_sha256: digest(row.unit_id),
})) };
const subsetDelivery = { status: "blocked", units: subsetPlan.units.map((row) => ({
  unit_id: row.unit_id, audio_sha256: digest(row.unit_id),
  decision: { status: "blocked", blockers: [{ code:
    row.unit_id === "cutoff" ? "narration_confirmed_word_omission"
      : "narration_confirmed_opening_token_mismatch" }] },
})) };
subsetDelivery.blockers = subsetDelivery.units.flatMap((row) =>
  row.decision.blockers.map((blocker) => ({ unit_id: row.unit_id, code: blocker.code })));
const fileHashes = { plan: digest("plan-file"), report: digest("report-file"),
  delivery: digest("delivery-file"), manifest: digest("manifest-file") };
const subsetReport = { status: "blocked", unit_qa_status: "blocked",
  full_stream_qa_status: "not_run_due_to_unit_blockers",
  source_script_hash: digest("source"),
  blockers: structuredClone(subsetDelivery.blockers),
  provider_output_manifest_sha256: fileHashes.manifest };
const subsetSpec = {
  schema: "goldflow_tts_exact_boundary_repair_spec_v2",
  source_script_sha256: subsetReport.source_script_hash,
  narration_generation_plan_sha256: subsetPlan.plan_sha256,
  narration_generation_plan_file_sha256: fileHashes.plan,
  prior_report_file_sha256: fileHashes.report,
  prior_delivery_file_sha256: fileHashes.delivery,
  prior_manifest_file_sha256: fileHashes.manifest,
  blocked_unit_ids: ["cutoff", "retained-a", "retained-b"],
  preserved_blocked_unit_ids: ["retained-a", "retained-b"],
  units: [{ unit_id: "cutoff", spoken_text_sha256: subsetPlan.units[0].spoken_text_sha256,
    reviewed_blocker_codes: ["narration_confirmed_word_omission"],
    review_reason: "Both retained ASR passes omit the protected age statement at this exact boundary.",
    fragments: ["He was twenty,", "two years older."] }],
};
const subsetArgs = { plan: subsetPlan, manifest: subsetManifest,
  delivery: subsetDelivery, report: subsetReport, spec: subsetSpec, fileHashes };
assert.deepEqual(validateBoundaryRepairScopeForTests(subsetArgs), {
  selected: ["cutoff"], orthographic: [],
  preservedBlocked: ["retained-a", "retained-b"],
});
const staleFullStream = { status: "blocked", source_script_hash: subsetReport.source_script_hash,
  provider_output_manifest_file_sha256: digest("prior-manifest-file") };
const historicalSha256 = digest("historical-full-stream-file");
const unitQaFirstSpec = { ...subsetSpec,
  historical_full_stream_file_sha256: historicalSha256 };
const selectedHistorical = selectBoundaryRepairFullStreamForTests({
  candidate: staleFullStream, report: subsetReport, spec: unitQaFirstSpec,
  currentManifestSha256: fileHashes.manifest, candidateFileSha256: historicalSha256,
});
assert.deepEqual(selectedHistorical, { current: null, historical: staleFullStream });
assert.deepEqual(validateBoundaryRepairScopeForTests({ ...subsetArgs,
  fullStream: selectedHistorical.current, spec: unitQaFirstSpec }), {
  selected: ["cutoff"], orthographic: [],
  preservedBlocked: ["retained-a", "retained-b"],
});
for (const change of [
  { spec: { ...unitQaFirstSpec, historical_full_stream_file_sha256: digest("wrong") } },
  { spec: { ...unitQaFirstSpec, schema: "goldflow_tts_exact_boundary_repair_spec_v1" } },
  { spec: { ...unitQaFirstSpec, contextual_asr_evidence_path: "/stale.json" } },
  { spec: { ...unitQaFirstSpec, full_stream_targets: [{ finding_sha256: digest("old") }] } },
  { report: { ...subsetReport, unit_qa_status: "passed" } },
  { report: { ...subsetReport, full_stream_qa_status: "blocked" } },
  { candidate: { ...staleFullStream, source_script_hash: digest("wrong-source") } },
]) {
  assert.throws(() => selectBoundaryRepairFullStreamForTests({
    candidate: staleFullStream, report: subsetReport, spec: unitQaFirstSpec,
    currentManifestSha256: fileHashes.manifest, candidateFileSha256: historicalSha256,
    ...change,
  }), /Stale full-stream evidence/);
}
assert.deepEqual(selectBoundaryRepairFullStreamForTests({
  candidate: { ...staleFullStream, provider_output_manifest_file_sha256: fileHashes.manifest },
  report: { ...subsetReport, full_stream_qa_status: "blocked" }, spec: subsetSpec,
  currentManifestSha256: fileHashes.manifest, candidateFileSha256: historicalSha256,
}).current.provider_output_manifest_file_sha256, fileHashes.manifest);
assert.throws(() => selectBoundaryRepairFullStreamForTests({
  candidate: { ...staleFullStream, provider_output_manifest_file_sha256: fileHashes.manifest },
  report: subsetReport, spec: subsetSpec,
  currentManifestSha256: fileHashes.manifest, candidateFileSha256: historicalSha256,
}), /conflicts with the blocked report/);
for (const mutate of [
  (spec) => { spec.preserved_blocked_unit_ids.pop(); },
  (spec) => { spec.blocked_unit_ids.pop(); },
  (spec) => { spec.prior_report_file_sha256 = digest("other"); },
  (spec) => { spec.units[0].reviewed_blocker_codes = ["narration_final_word_missing"]; },
  (spec) => { spec.units[0].fragments[1] = "two years younger."; },
  (spec) => { spec.units[0].review_reason = "short"; },
]) {
  const changed = structuredClone(subsetSpec);
  mutate(changed);
  assert.throws(() => validateBoundaryRepairScopeForTests({ ...subsetArgs, spec: changed }));
}
for (const changed of [
  { report: { ...subsetReport, blockers: subsetReport.blockers.slice(1) } },
  { delivery: { ...subsetDelivery, blockers: subsetDelivery.blockers.slice(1) } },
  { report: { ...subsetReport, blockers: [...subsetReport.blockers,
    { unit_id: "retained-a", code: "invented_blocker" }] } },
]) {
  assert.throws(() => validateBoundaryRepairScopeForTests({ ...subsetArgs, ...changed }),
    /blocked-report and manifest bindings/);
}

const derivedManifest = structuredClone(subsetManifest);
derivedManifest.units[0].audio_sha256 = digest("repaired-cutoff");
const finalDelivery = structuredClone(subsetDelivery);
finalDelivery.units[0].audio_sha256 = digest("repaired-cutoff");
finalDelivery.units[0].decision = { status: "passed", blockers: [] };
finalDelivery.blockers = finalDelivery.blockers.filter((row) => row.unit_id !== "cutoff");
const priorResults = subsetManifest.units.map((row, index) => ({
  unit_id: row.unit_id, audio_path: `/audio/${row.unit_id}.wav`,
  audio_sha256: row.audio_sha256, attempt: index + 1,
}));
const priorReport = { ...subsetReport, results: priorResults };
const finalReport = { status: "blocked", selected_unit_count: 3,
  full_stream_qa_status: "not_run_due_to_unit_blockers",
  provider_output_manifest_sha256: digest(JSON.stringify(derivedManifest, null, 2) + "\n"),
  blockers: structuredClone(finalDelivery.blockers),
  results: structuredClone(priorResults) };
finalReport.results[0].audio_sha256 = digest("repaired-cutoff");
const finalizationArgs = { priorManifest: subsetManifest, derivedManifest,
  priorDelivery: subsetDelivery, finalDelivery, priorReport, finalReport,
  repairedUnitIds: ["cutoff"],
  preservedBlockedUnitIds: ["retained-a", "retained-b"] };
assert.deepEqual(validateSubsetBoundaryFinalizationForTests(finalizationArgs), {
  preserved_blocked_unit_count: 2,
});
for (const mutate of [
  (input) => { input.derivedManifest.units[1].audio_sha256 = digest("wrong"); },
  (input) => { input.finalDelivery.units[1].decision.blockers = []; },
  (input) => { input.finalDelivery.units[2].decision.status = "passed"; },
  (input) => { input.finalReport.results[1].attempt = 3; },
  (input) => { input.finalReport.blockers.pop(); },
  (input) => { input.finalReport.full_stream_qa_status = "passed"; },
  (input) => { input.preservedBlockedUnitIds.pop(); },
]) {
  const changed = structuredClone(finalizationArgs);
  mutate(changed);
  assert.throws(() => validateSubsetBoundaryFinalizationForTests(changed));
}
assert.throws(() => assertPartialRepairUnitBlockerHoldForTests({
  requireUnitBlockers: true, blockers: [],
}), /full-stream QA held/);
assert.doesNotThrow(() => assertPartialRepairUnitBlockerHoldForTests({
  requireUnitBlockers: true, blockers: [{ unit_id: "retained-a" }],
}));
assert.doesNotThrow(() => assertPartialRepairUnitBlockerHoldForTests({
  requireUnitBlockers: false, blockers: [],
}));

console.log("exact-boundary TTS repair scope tests passed");
