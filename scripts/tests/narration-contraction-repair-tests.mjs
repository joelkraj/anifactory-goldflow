import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildContractionReviewEvidenceForTests,
} from "../tts-contraction-review.mjs";
import {
  CONTRACTION_ALIAS, CONTRACTION_TARGET_UNIT_ID,
  contractionCandidateAsrDecisionForTests, contractionGuardAdmission,
  contractionSegmentReportFieldsForTests,
  validateContractionEvidenceForTests,
} from "../lib/narration-contraction-repair.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const h = (name) => sha(`fixture:${name}`);
const id = CONTRACTION_TARGET_UNIT_ID;
const source = "She’d looked at me in the mirror. She knew where she was going.";
const remainder = "in the mirror. She knew where she was going.";
const plan = { plan_sha256: h("plan"), source_script_hash: h("script"),
  units: [{ unit_id: id, spoken_text: source, caption_text: source,
    source_text: source, spoken_text_sha256: sha(source) }] };
const selected = { unit_id: id, spoken_text_sha256: sha(source),
  audio_sha256: h("selected-wav"), synthesis_identity_sha256: h("identity"),
  synthesis_mode: "exact_sentence_boundary_composite_v1",
  recovery_provenance: { request_sha256: h("boundary-request-id"),
    result_sha256: h("boundary-result-file") } };
const manifest = { units: [selected] };
const exactDifference = { deletions: 0, insertions: 0, substitutions: 1,
  operations: [{ type: "substitution", intended: "shed", recognized: "she" },
    { type: "match" }, { type: "match" }] };
const blocker = { unit_id: id, code: "narration_confirmed_opening_token_mismatch" };
const report = { status: "blocked", unit_qa_status: "blocked",
  full_stream_qa_status: "not_run_due_to_unit_blockers",
  source_script_hash: h("script"), narration_generation_plan_sha256: h("plan"),
  narration_generation_plan_file_sha256: h("plan-file"),
  provider_output_manifest_sha256: h("manifest-file"),
  blockers: [blocker], results: [{ unit_id: id,
    spoken_text_sha256: sha(source), audio_sha256: selected.audio_sha256,
    synthesis_identity_sha256: selected.synthesis_identity_sha256 }] };
const delivery = { status: "blocked", source_script_hash: h("script"),
  narration_generation_plan_sha256: h("plan"), blockers: [blocker],
  units: [{ unit_id: id, audio_sha256: selected.audio_sha256,
    decision: { blockers: [blocker] }, transcript_qa: exactDifference,
    confirmation_transcript_qa: exactDifference,
    primary_recognized_text: "She looked at me in the mirror. She knew where she was going.",
    confirmation_recognized_text: "She looked at me in the mirror. She knew where she was going.",
    edge_alignment: { status: "passed" },
    acoustic_qa: { status: "passed", findings: [] },
    voice_continuity: { status: "passed" } }] };
const boundaryRequest = { schema: "goldflow_tts_exact_boundary_repair_request_v1",
  request_sha256: h("boundary-request-id"),
  units: [{ unit_id: id, fragments: [CONTRACTION_ALIAS.from, remainder] }] };
const first = { text: CONTRACTION_ALIAS.from,
  text_sha256: sha(CONTRACTION_ALIAS.from), audio_sha256: h("first-wav"),
  sidecar_sha256: h("first-sidecar") };
const second = { text: remainder, text_sha256: sha(remainder),
  audio_sha256: h("second-wav"), sidecar_sha256: h("second-sidecar") };
const boundaryResult = { schema: "goldflow_tts_exact_boundary_repair_result_v1",
  request_sha256: boundaryRequest.request_sha256,
  units: [{ unit_id: id, audio_sha256: selected.audio_sha256,
    gap_sample_count: 1920, fragments: [first, second] }] };
const bindings = { sourceScriptSha256: h("script"),
  identityFileSha256: h("identity-file"), plan, planFileSha256: h("plan-file"),
  report, reportFileSha256: h("report-file"), delivery,
  deliveryFileSha256: h("delivery-file"), manifest,
  manifestFileSha256: h("manifest-file"),
  selectedAudioFileSha256: selected.audio_sha256,
  boundaryRequest, boundaryRequestFileSha256: h("boundary-request-file"),
  boundaryResult, boundaryResultFileSha256: h("boundary-result-file"),
  firstAudioFileSha256: first.audio_sha256, firstSidecar: {
    text: first.text, text_sha256: first.text_sha256,
    audio_sha256: first.audio_sha256 },
  firstSidecarFileSha256: first.sidecar_sha256,
  remainderAudioFileSha256: second.audio_sha256, remainderSidecar: {
    text: second.text, text_sha256: second.text_sha256,
    audio_sha256: second.audio_sha256 },
  remainderSidecarFileSha256: second.sidecar_sha256 };
const evidence = buildContractionReviewEvidenceForTests({
  unitId: id, sourceScriptSha256: bindings.sourceScriptSha256,
  identityFileSha256: bindings.identityFileSha256, plan,
  planFileSha256: bindings.planFileSha256, report,
  reportFileSha256: bindings.reportFileSha256,
  deliveryFileSha256: bindings.deliveryFileSha256,
  manifestFileSha256: bindings.manifestFileSha256, selected,
  boundaryRequestFileSha256: bindings.boundaryRequestFileSha256,
  boundaryResultFileSha256: bindings.boundaryResultFileSha256,
  reviewedAt: "2026-10-02T20:00:00.000Z",
});
assert.equal(validateContractionEvidenceForTests({ evidence, ...bindings }).unit_id, id);
for (const changed of [
  { evidence: { ...evidence, human_listening_performed: true } },
  { sourceScriptSha256: h("changed-script") },
  { selectedAudioFileSha256: h("changed-wav") },
  { plan: { ...plan, units: [{ ...plan.units[0],
    spoken_text: "She’d go at me in the mirror. She knew where she was going." }] } },
  { plan: { ...plan, units: [{ ...plan.units[0], caption_text: "She had looked at me in the mirror. She knew where she was going." }] } },
  { report: { ...report, blockers: [blocker, blocker] } },
  { delivery: { ...delivery, units: [{ ...delivery.units[0],
    confirmation_transcript_qa: { ...exactDifference, deletions: 1 } }] } },
  { boundaryResult: { ...boundaryResult, units: [{ ...boundaryResult.units[0],
    gap_sample_count: 0 }] } },
]) assert.throws(() => validateContractionEvidenceForTests({ evidence,
  ...bindings, ...changed }), /Contraction expansion:/);

const decision = { status: "passed", blockers: [], warnings: [] };
const expanded = source.replace(CONTRACTION_ALIAS.from, CONTRACTION_ALIAS.to);
const candidateArgs = { decision, unitId: id, reviewedUnitId: id,
  expectedText: source, evidenceSha256: h("evidence"),
  primaryText: expanded, confirmationText: expanded };
const accepted = contractionCandidateAsrDecisionForTests(candidateArgs);
assert.equal(accepted.status, "passed_with_warnings");
assert.equal(accepted.blockers.length, 0);
assert.equal(accepted.warnings[0].human_listening_performed, false);
for (const changed of [
  { primaryText: source.replace("She’d", "She") },
  { confirmationText: source.replace("She’d", "She") },
  { confirmationText: expanded.replace("mirror", "window") },
  { primaryText: "She had go at me in the mirror. She knew where she was going." },
]) {
  const result = contractionCandidateAsrDecisionForTests({ ...candidateArgs, ...changed });
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.some((row) =>
    row.code === "narration_exact_tts_only_expansion_not_confirmed"));
}
assert.throws(() => contractionCandidateAsrDecisionForTests({ ...candidateArgs,
  decision: { ...decision, blockers: [{ code: "unrelated" }] } }),
/unrelated delivery blocker/);

const marker = { source_token: "She’d", spoken_words: ["She", "had"],
  source_phrase: CONTRACTION_ALIAS.from, spoken_phrase: CONTRACTION_ALIAS.to,
  evidence_sha256: h("evidence") };
const reportRow = { unit_id: id, text: source, caption_text: source,
  caption_text_sha256: sha(source), asr_equivalent_phrases: [CONTRACTION_ALIAS],
  tts_only_contraction_expansion: marker };
const timing = { unit_id: id, start_sample: 240000, end_sample_exclusive: 336000,
  start_sec: 10, end_sec: 14 };
const segmentFields = contractionSegmentReportFieldsForTests({ row: reportRow,
  timing, evidenceSha256: h("evidence") });
assert.equal(segmentFields.caption_text, source);
assert.equal(segmentFields.start_sample, 240000);
assert.equal(segmentFields.end_sample_exclusive, 336000);
assert.deepEqual(segmentFields.tts_only_contraction_expansion.spoken_words,
  ["She", "had"]);
for (const changed of [
  { row: { ...reportRow, caption_text: expanded } },
  { row: { ...reportRow, caption_text_sha256: h("wrong-caption") } },
  { row: { ...reportRow, asr_equivalent_phrases: [] } },
  { timing: { ...timing, start_sample: 0 } },
  { timing: { ...timing, end_sample_exclusive: timing.start_sample } },
]) assert.throws(() => contractionSegmentReportFieldsForTests({ row: reportRow,
  timing, evidenceSha256: h("evidence"), ...changed }),
  /final report lost/);

const episodeDir = "/tmp/contraction-guard/ep_01";
const reviewShape = `node bin/goldflow.mjs tts review-contraction --episode-dir ${episodeDir}`;
const status = { episode_dir: episodeDir, current_stage: "qwen_tts_stitch",
  current_stage_state: "blocked", next_command_shape: reviewShape };
assert.equal(contractionGuardAdmission(status, "tts", "review-contraction",
  { "episode-dir": episodeDir }).allowed, true);
assert.equal(contractionGuardAdmission({ ...status, current_stage_state: "ready" },
  "tts", "review-contraction", { "episode-dir": episodeDir }).allowed, false);
assert.equal(contractionGuardAdmission(status, "tts", "review-contraction",
  { "episode-dir": episodeDir, bypass: "true" }).allowed, false);
const evidencePath = `${episodeDir}/narration_automated_contraction_expansion_ep_01.json`;
const manifestPath = `${episodeDir}/assets/audio/narration_tts/contraction_candidates/${h("request")}/provider-output-manifest.json`;
const repairFlags = { "episode-dir": episodeDir, evidence: evidencePath };
const repairStatus = { ...status,
  next_command_shape: `node bin/goldflow.mjs tts repair-contraction --episode-dir ${episodeDir} --evidence ${evidencePath}` };
assert.equal(contractionGuardAdmission(repairStatus, "tts", "repair-contraction",
  repairFlags).allowed, true);
assert.equal(contractionGuardAdmission(repairStatus, "tts", "repair-contraction",
  { ...repairFlags, evidence: "/tmp/other.json" }).allowed, false);
const finalFlags = { "episode-dir": episodeDir, manifest: manifestPath,
  "contraction-expansion-evidence": evidencePath };
const finalStatus = { ...status,
  next_command_shape: `node bin/goldflow.mjs tts finalize-provider --episode-dir ${episodeDir} --manifest ${manifestPath} --contraction-expansion-evidence ${evidencePath}` };
assert.equal(contractionGuardAdmission(finalStatus, "tts", "finalize-provider",
  finalFlags).allowed, true);
assert.equal(contractionGuardAdmission(finalStatus, "tts", "finalize-provider",
  { ...finalFlags, "accept-asr-delivery-blockers": "true" }).allowed, false);
console.log("narration-contraction-repair-tests: passed");
