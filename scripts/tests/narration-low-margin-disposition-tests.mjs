import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyLowMarginDisposition, assertLowMarginActiveBindings, assertLowMarginDisposition, assertLowMarginEvidence,
  buildLowMarginDisposition, loadLowMarginDisposition, lowMarginDispositionSha256, LOW_MARGIN_CODE,
} from "../lib/narration-low-margin-disposition.mjs";
import { commandStageFor } from "../lib/pipeline-stage-registry.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const profile = { provider: "qwen_local", model_id: "synthetic-model", model_revision: "synthetic-revision",
  voice_id: "fixture-owned-voice", voice_sha256: hash("voice"), reference_voice_id: "fixture-owned-voice",
  reference_voice_sha256: hash("voice"), voice_continuity_contract: "synthetic-owned-contract",
  speaker_similarity_method: "synthetic-method", speaker_similarity_model_sha256: hash("similarity") };
const units = [0.8, 0.82, 0.79, 0.9].map((score, index) => ({ unit_id: `unit_${index + 1}`,
  status: "accepted", audio_path: `/fixture/${index}.wav`, audio_sha256: hash(`audio-${index}`), score }));
const references = [0.85, 0.91, 0.9].map((score, index) => ({ audio_path: `/fixture/reference-${index}.wav`,
  audio_sha256: hash(`reference-${index}`), leave_one_out_cosine_similarity: score }));
const context = {
  bindings: Object.fromEntries(["source_script_sha256", "run_identity_sha256", "narration_generation_plan_file_sha256",
    "provider_output_manifest_file_sha256", "speaker_similarity_file_sha256", "narration_generation_plan_sha256",
    "narration_quality_contract_sha256"].map((key) => [key, hash(key)])), profile,
  qualityContract: { voice_identity_qa: { minimum_reference_count: 3, unit_outliers_are_review_required: true } },
  manifest: { ...profile, units },
  report: { schema: "goldflow_tts_voice_continuity_qa_v1", threshold_mode: "reference_leave_one_out",
    method: profile.speaker_similarity_method, model_sha256: profile.speaker_similarity_model_sha256,
    reference_voice_id: profile.voice_id, reference_voice_sha256: profile.voice_sha256,
    minimum_cosine_similarity: 0.8, warning_below_cosine_similarity: 0.85,
    aggregate_minimum_cosine_similarity: 0.82, aggregate_status: "passed",
    calibration: { reference_leave_one_out_floor: 0.85, hard_margin: 0.05, warning_margin: 0, aggregate_margin: 0.03 },
    references, reference_calibration: references, reference_count: 3,
    candidate_count: units.length, candidate_aggregate: { count: units.length, mean_cosine_similarity: 0.8275 },
    candidates: units.map((unit) => ({ audio_path: unit.audio_path, audio_sha256: unit.audio_sha256,
      status: unit.score >= 0.8 ? "passed" : "blocked", cosine_similarity: unit.score,
      minimum_cosine_similarity: 0.8, warning_below_cosine_similarity: 0.85 })) },
};
const original = JSON.stringify(context);
const options = { context, unitIds: ["unit_1", "unit_2"], reviewer: "fixture-reviewer",
  reason: "Explicitly retain calibrated passing low-margin measurements as advisory while all other checks and subjective listening remain required.",
  reviewedAt: "2026-09-12T00:00:00.000Z" };
const receipt = buildLowMarginDisposition(options);
assert.equal(receipt.units[0].cosine_similarity, 0.8, "equality with the unchanged minimum passes");
assert.equal(receipt.human_listening_performed, false);
assert.equal(receipt.synthesis_authorized, false);
assert.equal(JSON.stringify(context), original, "evidence and locked policy remain unchanged");
for (const ids of [["unit_3"], ["unit_4"], ["unknown"], ["unit_1", "unit_1"], []]) {
  assert.throws(() => buildLowMarginDisposition({ ...options, unitIds: ids }));
}
assert.throws(() => buildLowMarginDisposition({ ...options, reason: "short" }));
for (const key of Object.keys(context.bindings)) {
  assert.throws(() => assertLowMarginDisposition(receipt, { ...context,
    bindings: { ...context.bindings, [key]: hash("changed") } }), undefined, `${key} must be current`);
  const missing = structuredClone(context); delete missing.bindings[key];
  assert.throws(() => assertLowMarginEvidence(missing));
}
for (const mutate of [
  (c) => { c.report.aggregate_status = "blocked"; },
  (c) => { c.report.candidate_aggregate.mean_cosine_similarity = 0.81; },
  (c) => { c.report.reference_voice_sha256 = hash("foreign"); },
  (c) => { c.report.candidates[0].cosine_similarity = null; },
  (c) => { c.report.candidates[0].cosine_similarity = Number.NaN; },
  (c) => { c.report.candidates[0].cosine_similarity = 0.79999; },
  (c) => { c.report.candidates[0].audio_sha256 = hash("stale-audio"); },
  (c) => { c.report.candidates.reverse(); },
  (c) => { c.report.candidates.pop(); },
  (c) => { c.report.minimum_cosine_similarity = 0.79; },
  (c) => { c.report.reference_calibration[0].leave_one_out_cosine_similarity = 0.86; },
  (c) => { c.manifest.model_revision = "foreign"; },
]) {
  const changed = structuredClone(context); mutate(changed);
  assert.throws(() => assertLowMarginDisposition(receipt, changed));
}
const low = { severity: "warning", code: LOW_MARGIN_CODE, cosine_similarity: 0.8, warning_floor: 0.85, review_required: true };
const tail = { severity: "warning", code: "tts_audio_tail_not_settled", review_required: true };
const below = { severity: "warning", code: "narration_voice_similarity_below_calibrated_hard_floor", review_required: true };
const asr = { severity: "warning", code: "narration_asr_uncertain", review_required: true };
const decision = { status: "passed_with_warnings", blockers: [], review_required: true, warnings: [low, tail, below, asr] };
const binding = { path: "/fixture/disposition.json", file_sha256: hash("receipt"), receipt };
assert.doesNotThrow(() => assertLowMarginActiveBindings(binding, context.bindings));
for (const key of Object.keys(context.bindings)) {
  assert.throws(() => assertLowMarginActiveBindings(binding, { ...context.bindings, [key]: hash("effective override") }), /effective finalizer inputs/);
}
assert.doesNotThrow(() => assertLowMarginActiveBindings(null, {}), "no receipt does not change override/default behavior");
assert.strictEqual(applyLowMarginDisposition(decision, "unit_1", null), decision, "default exact listening stays unchanged");
assert.strictEqual(applyLowMarginDisposition(decision, "unlisted-unit", binding), decision, "unlisted IDs gain no disposition");
const changed = applyLowMarginDisposition(decision, "unit_1", binding);
assert.equal(changed.warnings[0].review_required, false);
assert.equal(changed.warnings[0].cosine_similarity, low.cosine_similarity);
assert.deepEqual(changed.warnings.slice(1), [tail, below, asr], "coexisting warnings remain required");
assert.equal(changed.review_required, true);
assert.equal(applyLowMarginDisposition({ ...decision, warnings: [low] }, "unit_1", binding).review_required, false);
assert.throws(() => applyLowMarginDisposition({ ...decision, warnings: [{ ...low, cosine_similarity: 0.81 }] }, "unit_1", binding));
assert.equal(decision.warnings[0].review_required, true, "input decision is immutable");
const forged = structuredClone(receipt); forged.units.push({ ...forged.units[0], unit_id: "unit_3" });
forged.disposition_sha256 = lowMarginDispositionSha256(forged);
assert.throws(() => assertLowMarginDisposition(forged, context), undefined, "rehashed new/below-floor IDs still fail");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-low-margin-test-"));
try {
  const opts = { episodeDir: root, episode: "ep_01", context };
  assert.equal(await loadLowMarginDisposition(opts), null);
  const file = path.join(root, "narration_low_margin_disposition_ep_01.json");
  await fs.writeFile(file, JSON.stringify(receipt) + "\n");
  const loaded = await loadLowMarginDisposition(opts);
  assert.deepEqual((await loadLowMarginDisposition({ ...opts, expectedBinding: loaded })).receipt, receipt);
  await assert.rejects(() => loadLowMarginDisposition({ ...opts, expectedBinding: null }), /changed/, "adding a receipt invalidates old cached review results");
  await fs.appendFile(file, "\n");
  await assert.rejects(() => loadLowMarginDisposition({ ...opts, expectedBinding: loaded }), /changed/, "even changed receipt file bytes invalidate derived review");
  await fs.rm(file);
  await assert.rejects(() => loadLowMarginDisposition({ ...opts, expectedBinding: loaded }), /missing/);
} finally { await fs.rm(root, { recursive: true, force: true }); }
assert.equal(commandStageFor("tts", "low-margin-disposition", {}), "qwen_tts_stitch");
console.log("narration low-margin disposition tests passed (synthetic evidence; no media or listening approval)");
