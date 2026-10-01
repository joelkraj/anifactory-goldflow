#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  FULL_STREAM_REVIEW_SCHEMA, FULL_STREAM_REVIEW_ATTESTATION,
  fullStreamReviewScope, applyFullStreamManualReview, loadFullStreamManualReview,
  validateAppliedFullStreamManualReview, fullStreamWindowBindingSha256,
} from "../lib/narration-full-stream-manual-review.mjs";
import { NARRATION_DELIVERY_CONSENSUS_VERSION } from "../lib/narration-delivery-quality.mjs";
import { finalizeNarrationProviderOutput } from "../narration-provider-output-finalize.mjs";
import { validateOpeningFinalizationFlags } from "../lib/narration-opening-finalization.mjs";
import {
  CONTEXTUAL_ASR_SCHEMA, loadContextualAsrReconciliation,
  applyContextualAsrReconciliation, validateAppliedContextualAsrReconciliation,
} from "../lib/narration-full-stream-contextual-asr.mjs";
import { validateBoundaryRepairScopeForTests } from "../tts-exact-boundary-repair.mjs";

const execFile = promisify(execFileCallback);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-full-stream-review-test-"));
const write = async (name, data) => {
  const file = path.join(tmp, name);
  const bytes = typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2);
  await fs.writeFile(file, bytes);
  return { path: file, sha256: hash(bytes) };
};
function wav(frequency, count = 48000) {
  const b = Buffer.alloc(44 + count * 2);
  b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) b.writeInt16LE(Math.round(12000 * Math.sin(i * frequency * 2 * Math.PI / 24000)), 44 + i * 2);
  return b;
}
try {
  const audios = [await write("window-a.wav", wav(440)), await write("window-b.wav", wav(660))];
  const masterBytes = wav(440, 96000);
  wav(660).copy(masterBytes, 44 + 48000 * 2, 44);
  const master = await write("master.wav", masterBytes);
  const oldUnitReview = await write("existing-unit-review.json", {
    accepted_units: Array.from({ length: 6 }, (_, i) => ({ unit_id: `older-${i}`, operator_quote: "Heard and accepted." })),
  });
  const windows = audios.map((audio, i) => ({
    window_id: `window-${i}`, audio_path: audio.path, audio_sha256: audio.sha256,
    source_audio_path: master.path,
    source_audio_sha256: master.sha256, sample_rate_hz: 24000, sample_count: 48000,
    start_sample: i * 48000, end_sample_exclusive: (i + 1) * 48000,
    intended_text: "An exact sentence for the listener.", intended_text_sha256: hash("An exact sentence for the listener."),
    unit_ids: i ? ["unit-b", "unit-c"] : ["unit-a"], boundary_ids: i ? ["unit-b__unit-c"] : [],
    decision: { status: "blocked", blockers: [{ severity: "blocker",
      code: i ? "narration_confirmed_unexpected_word" : "narration_confirmed_word_omission",
      ...(i ? { recognized_tokens: ["extra"] } : { intended_tokens: ["exact"] }),
    }], warnings: [] },
  }));
  for (const window of windows) window.binding_sha256 = fullStreamWindowBindingSha256(window);
  const blockers = windows.map((w) => ({ ...w.decision.blockers[0], confirmation_window_id: w.window_id,
    unit_ids: w.unit_ids, ...(w.unit_ids.length === 1 ? { unit_id: w.unit_ids[0] } : {}),
    ...(w.boundary_ids.length === 1 ? { boundary_id: w.boundary_ids[0] } : {}),
  }));
  const report = {
    schema: "goldflow_narration_full_stream_qa_v2", status: "blocked",
    source_script_hash: hash("script"), narration_generation_plan_sha256: hash("plan"),
    narration_generation_plan_file_sha256: hash("plan-file"), narration_quality_contract_sha256: hash("contract"),
    audio_path: master.path, audio_sha256: master.sha256, intended_text_sha256: hash("all words"),
    transcript_comparison_version: "fixture-comparison", delivery_consensus_version: NARRATION_DELIVERY_CONSENSUS_VERSION,
    provider_output_manifest_file_sha256: hash("manifest"), confirmation_windows: windows,
    manual_review_evidence_path: oldUnitReview.path, manual_review_evidence_sha256: oldUnitReview.sha256,
    manual_review_accepted_unit_ids: Array.from({ length: 6 }, (_, i) => `older-${i}`),
    blockers, warnings: [], decision: { status: "blocked", blockers, warnings: [] },
  };
  const snapshot = await write("prior-full-stream.json", report);
  const current = await write("canonical-full-stream.json", report);
  const scope = fullStreamReviewScope(report);
  const evidence = {
    ...Object.fromEntries(["source_script_hash", "narration_generation_plan_sha256", "narration_generation_plan_file_sha256",
      "narration_quality_contract_sha256", "audio_path", "audio_sha256", "intended_text_sha256",
      "transcript_comparison_version", "delivery_consensus_version", "provider_output_manifest_file_sha256"]
      .map((key) => [key, report[key]])),
    schema: FULL_STREAM_REVIEW_SCHEMA, status: "reviewed", reviewer_kind: "human", reviewer: "Fixture listener",
    reviewed_at: "2026-01-02T12:00:00Z", note: "Both exact affected passages heard.",
    attestation: FULL_STREAM_REVIEW_ATTESTATION, prior_full_stream_qa_path: snapshot.path,
    prior_full_stream_qa_sha256: snapshot.sha256, scope,
    decisions: scope.map((item) => ({ finding_sha256: item.finding_sha256, decision: "accept",
      human_listened: true, affected_passage_complete: true, listen_note: "Complete and acceptable.",
      intended_passage_text: report.confirmation_windows[0].intended_text,
      listened_audio: { path: item.window.audio_path, sha256: item.window.audio_sha256,
        source_window_id: item.window.window_id, source_window_sha256: item.window.audio_sha256,
        start_sample_in_window: 0, end_sample_in_window: item.window.sample_count },
    })),
  };
  const evidenceFile = await write("review.json", evidence);
  const input = { evidencePath: evidenceFile.path, currentReportPath: current.path,
    expectedBindings: report, providerManifestSha256: report.provider_output_manifest_file_sha256,
    unitReviewEvidencePath: oldUnitReview.path };
  const load = async (candidate = evidence, overrides = {}) => {
    await write("review.json", candidate);
    return loadFullStreamManualReview({ ...input, ...overrides });
  };
  const valid = await load();
  // A contextual full-stream omission may be reconciled only when the same
  // selected unit is exact in both standalone ASR passes and its complete PCM
  // survives the current stitch/mastered confirmation window.
  const contextManifest = { status: "passed", units: [
    { unit_id: "unit-a", spoken_text_sha256: hash("An exact sentence for the listener."),
      audio_path: audios[0].path, audio_sha256: audios[0].sha256 },
    { unit_id: "unit-b", spoken_text_sha256: hash("Known ones."),
      audio_path: audios[1].path, audio_sha256: audios[1].sha256 },
  ] };
  const contextManifestFile = await write("context-manifest.json", contextManifest);
  const contextDelivery = { status: "passed_with_warnings", units: [
    { unit_id: "unit-a", audio_path: audios[0].path, audio_sha256: audios[0].sha256,
      intended_text: "An exact sentence for the listener.",
      intended_text_sha256: hash("An exact sentence for the listener."),
      primary_recognized_text: "An exact sentence for the listener.",
      confirmation_recognized_text: "An exact sentence for the listener.",
      confirmation_transcript_qa: { deletions: 0, insertions: 0, substitutions: 0 },
      decision: { status: "passed", blockers: [], confirmation_decision: { status: "passed" } } },
    { unit_id: "unit-b", audio_path: audios[1].path, audio_sha256: audios[1].sha256,
      intended_text: "Known ones.", intended_text_sha256: hash("Known ones."),
      decision: { status: "passed_with_warnings", blockers: [] } },
  ] };
  const contextDeliveryFile = await write("context-delivery.json", contextDelivery);
  const contextStitch = {
    source_script_hash: report.source_script_hash,
    narration_generation_plan_sha256: report.narration_generation_plan_sha256,
    final_wav_path: master.path, final_wav_sha256: master.sha256,
    raw_output_path: master.path, raw_output_sha256: master.sha256,
    stitch_qa_status: "passed",
    sample_accounting: { status: "passed", exact_sample_accounting: true,
      actual_sample_count: 96000 },
    segments: [
      { unit_id: "unit-a", raw_audio_path: audios[0].path,
        raw_audio_sha256: audios[0].sha256, prepared_audio_path: audios[0].path,
        prepared_audio_sha256: audios[0].sha256 },
      { unit_id: "unit-b", raw_audio_path: audios[1].path,
        raw_audio_sha256: audios[1].sha256, prepared_audio_path: audios[1].path,
        prepared_audio_sha256: audios[1].sha256 },
    ],
    boundaries: [{ after_unit_id: "unit-a", before_unit_id: "unit-b", gap_sample_count: 0 }],
  };
  const contextStitchFile = await write("context-stitch.json", contextStitch);
  const contextReport = structuredClone(report);
  contextReport.provider_output_manifest_file_sha256 = contextManifestFile.sha256;
  contextReport.confirmation_windows[0].primary_recognized_text =
    "An added sentence for the listener.";
  contextReport.confirmation_windows[0].confirmation_recognized_text =
    "An added sentence for the listener.";
  contextReport.confirmation_windows[1].intended_text = "Known ones.";
  contextReport.confirmation_windows[1].intended_text_sha256 = hash("Known ones.");
  contextReport.confirmation_windows[1].binding_sha256 = fullStreamWindowBindingSha256(
    contextReport.confirmation_windows[1]);
  const protectedMismatch = { severity: "blocker",
    code: "narration_confirmed_tts_transcript_protected_value_mismatch",
    operations: [{ type: "substitution", intended: "ones", recognized: "once" }] };
  contextReport.confirmation_windows[1].decision.blockers = [protectedMismatch];
  contextReport.blockers[1] = { ...protectedMismatch,
    confirmation_window_id: "window-1", unit_ids: ["unit-b", "unit-c"],
    boundary_id: "unit-b__unit-c" };
  contextReport.decision.blockers[1] = contextReport.blockers[1];
  const contextPrior = await write("context-prior.json", contextReport);
  const contextCurrent = await write("context-current.json", contextReport);
  const contextFinding = fullStreamReviewScope(contextReport)[0];
  const contextEvidence = {
    schema: CONTEXTUAL_ASR_SCHEMA, status: "reviewed_evidence",
    human_listening_performed: false, synthesis_authorized: false,
    prior_full_stream_qa_path: contextPrior.path,
    prior_full_stream_qa_sha256: contextPrior.sha256,
    provider_manifest_path: contextManifestFile.path,
    provider_manifest_sha256: contextManifestFile.sha256,
    unit_delivery_path: contextDeliveryFile.path,
    unit_delivery_sha256: contextDeliveryFile.sha256,
    stitch_report_path: contextStitchFile.path,
    stitch_report_sha256: contextStitchFile.sha256,
    finding_sha256: contextFinding.finding_sha256,
    confirmation_window_id: contextFinding.window.window_id,
    confirmation_window_sha256: contextFinding.window.audio_sha256,
    confirmation_window_binding_sha256: contextFinding.window.binding_sha256,
    unit_id: "unit-a",
    affected_passage_text: "An exact sentence for the listener.",
    excerpt_start_sample_in_unit: 0, excerpt_end_sample_in_unit: 48000,
  };
  const contextEvidenceFile = await write("context-evidence.json", contextEvidence);
  const contextLoad = async (candidate = contextEvidence) => {
    await write("context-evidence.json", candidate);
    return loadContextualAsrReconciliation({ evidencePath: contextEvidenceFile.path,
      currentReportPath: contextCurrent.path,
      currentStitchReportPath: contextStitchFile.path });
  };
  const contextValid = await contextLoad();
  assert.equal(contextValid.waveform_correlation, 1);
  const contextApplied = applyContextualAsrReconciliation({
    fullStream: contextReport, reconciliation: contextValid });
  assert.equal(contextApplied.decision.status, "blocked");
  assert.deepEqual(contextApplied.decision.blockers, [contextReport.blockers[1]]);
  await validateAppliedContextualAsrReconciliation({
    ...contextApplied, status: contextApplied.decision.status,
    blockers: contextApplied.decision.blockers,
    warnings: contextApplied.decision.warnings });
  const changedContext = structuredClone(contextEvidence);
  changedContext.excerpt_start_sample_in_unit = 1000;
  await assert.rejects(contextLoad(changedContext), /entire selected unit/);
  await contextLoad();
  const changedContextDelivery = structuredClone(contextDelivery);
  changedContextDelivery.units[0].primary_recognized_text =
    "An added sentence for the listener.";
  await write("context-delivery.json", changedContextDelivery);
  await assert.rejects(contextLoad(), /unit delivery hash changed/);
  await write("context-delivery.json", contextDelivery);
  const staleContext = { ...contextApplied, status: contextApplied.decision.status,
    blockers: [], warnings: contextApplied.decision.warnings };
  await assert.rejects(validateAppliedContextualAsrReconciliation(staleContext),
    /applied decision or current media differs/);
  const contextPlan = { plan_sha256: report.narration_generation_plan_sha256,
    units: [
      { unit_id: "unit-a", spoken_text: "An exact sentence for the listener.",
        spoken_text_sha256: hash("An exact sentence for the listener.") },
      { unit_id: "unit-b", spoken_text: "Known ones.",
        spoken_text_sha256: hash("Known ones.") },
    ] };
  const contextSpec = {
    schema: "goldflow_tts_exact_boundary_repair_spec_v1",
    contextual_asr_evidence_path: contextEvidenceFile.path,
    source_script_sha256: report.source_script_hash,
    narration_generation_plan_sha256: contextPlan.plan_sha256,
    narration_generation_plan_file_sha256: hash("plan-file"),
    prior_report_file_sha256: hash("report"),
    prior_delivery_file_sha256: contextDeliveryFile.sha256,
    prior_manifest_file_sha256: contextManifestFile.sha256,
    prior_full_stream_file_sha256: contextCurrent.sha256,
    full_stream_targets: [{ unit_id: "unit-b",
      finding_sha256: fullStreamReviewScope(contextReport)[1].finding_sha256 }],
    units: [{ unit_id: "unit-b", fragments: ["Known", "ones."] }],
  };
  const contextTts = { status: "blocked", source_script_hash: report.source_script_hash,
    full_stream_qa_status: "blocked",
    provider_output_manifest_sha256: contextManifestFile.sha256 };
  const contextHashes = { plan: hash("plan-file"), report: hash("report"),
    delivery: contextDeliveryFile.sha256, manifest: contextManifestFile.sha256,
    fullStream: contextCurrent.sha256 };
  const admitted = validateBoundaryRepairScopeForTests({
    plan: contextPlan, manifest: contextManifest, delivery: contextDelivery,
    fullStream: contextReport, report: contextTts, spec: contextSpec,
    fileHashes: contextHashes, contextualAsr: contextValid });
  assert.deepEqual(admitted.selected, ["unit-b"]);
  assert.throws(() => validateBoundaryRepairScopeForTests({
    plan: contextPlan, manifest: contextManifest, delivery: contextDelivery,
    fullStream: contextReport, report: contextTts,
    spec: { ...contextSpec, full_stream_targets: [] },
    fileHashes: contextHashes, contextualAsr: contextValid }),
  /Every unresolved full-stream blocker/);
  assert.throws(() => validateBoundaryRepairScopeForTests({
    plan: contextPlan, manifest: contextManifest, delivery: contextDelivery,
    fullStream: contextReport, report: contextTts,
    spec: { ...contextSpec, units: [...contextSpec.units,
      { unit_id: "unit-a", fragments: ["An exact", "sentence for the listener."] }] },
    fileHashes: contextHashes, contextualAsr: contextValid }),
  /Exact-boundary repair scope is not current/);
  const before = JSON.stringify(report);
  const applied = applyFullStreamManualReview({ fullStream: report, review: valid, bindings: report });
  assert.equal(applied.decision.status, "passed_with_warnings");
  assert.equal(applied.decision.blockers.length, 0);
  assert.equal(applied.decision.warnings.length, 2);
  assert.equal(JSON.stringify(report), before, "input reports must remain immutable");
  assert.deepEqual(applied.manual_review_accepted_unit_ids, report.manual_review_accepted_unit_ids);
  assert.equal(hash(await fs.readFile(oldUnitReview.path)), oldUnitReview.sha256);
  const published = { ...applied, status: applied.decision.status,
    blockers: applied.decision.blockers, warnings: applied.decision.warnings };
  await validateAppliedFullStreamManualReview(published);

  const rejectedEvidence = structuredClone(evidence);
  rejectedEvidence.decisions[1].decision = "reject";
  const rejected = applyFullStreamManualReview({ fullStream: report, review: await load(rejectedEvidence), bindings: report });
  assert.equal(rejected.decision.status, "blocked");
  assert.deepEqual(rejected.decision.blockers, [blockers[1]]);
  assert.equal(rejected.full_stream_manual_review.synthesis_authorized, false);
  assert.equal(rejected.confirmation_windows[1].decision.status, "blocked");
  await load();

  const bad = async (mutate, pattern) => {
    const candidate = structuredClone(evidence); mutate(candidate);
    await assert.rejects(load(candidate), pattern);
  };
  await bad((e) => { e.status = "prepared_not_reviewed"; }, /schema\/status/);
  await bad((e) => { e.reviewer_kind = "agent"; }, /human reviewer/);
  await bad((e) => { e.attestation = "ASR looked right"; }, /listening attestation/);
  await bad((e) => { e.decisions[0].human_listened = false; }, /unreviewed blocker/);
  await bad((e) => { e.decisions.pop(); }, /every current blocker/);
  await bad((e) => { e.decisions[1] = e.decisions[0]; }, /exactly once/);
  await bad((e) => { e.scope.pop(); }, /scope/);
  await bad((e) => { e.decisions[0].finding_sha256 = hash("wrong finding"); }, /unreviewed blocker/);
  await bad((e) => { e.scope[0].window.audio_sha256 = hash("wrong window"); }, /scope/);
  await bad((e) => { e.source_script_hash = hash("changed source"); }, /source_script_hash/);
  await bad((e) => { e.delivery_consensus_version = "old"; }, /consensus version/);
  await bad((e) => { e.prior_full_stream_qa_sha256 = hash("changed report"); }, /prior full-stream report hash/);
  await bad((e) => { e.decisions[0].listened_audio.end_sample_in_window++; }, /sample range/);
  await bad((e) => { e.decisions[0].intended_passage_text = "Unrelated text."; }, /exact span/);
  await bad((e) => { e.decisions[0].listened_audio = { ...e.decisions[0].listened_audio,
    path: audios[1].path, sha256: audios[1].sha256, encoding: "ffmpeg_libmp3lame_q2_v1" }; }, /not the exact source-window excerpt/);
  await assert.rejects(load(evidence, { unitReviewEvidencePath: null }), /existing unit review must be preserved/);
  await assert.rejects(load(evidence, { providerManifestSha256: hash("changed provider") }), /provider manifest/);
  await assert.rejects(load(evidence, { expectedBindings: { ...report, narration_quality_contract_sha256: hash("changed") } }), /active narration_quality/);

  const staleCurrent = await write("canonical-full-stream.json", { ...report, stale: true });
  assert.notEqual(staleCurrent.sha256, snapshot.sha256);
  await assert.rejects(load(), /exact current full-stream report/);
  await write("canonical-full-stream.json", report);
  const withExtraLocal = structuredClone(report);
  withExtraLocal.confirmation_windows[0].decision.blockers.push({ code: "narration_confirmed_unexpected_word", severity: "blocker" });
  assert.throws(() => fullStreamReviewScope(withExtraLocal), /unreviewed local window/);
  const withBadAlias = structuredClone(report);
  withBadAlias.blockers[0].unit_id = "other";
  assert.throws(() => fullStreamReviewScope(withBadAlias), /aliases/);
  const withOrderError = structuredClone(report);
  withOrderError.blockers.push({ code: "narration_unit_order_mismatch", severity: "blocker" });
  assert.throws(() => fullStreamReviewScope(withOrderError), /non-delivery blocker/);
  const changed = structuredClone(report);
  changed.confirmation_windows[0].binding_sha256 = hash("changed binding");
  assert.throws(() => applyFullStreamManualReview({ fullStream: changed, review: valid, bindings: report }), /binding hash is stale/);
  await load();
  const changedPublished = structuredClone(published);
  changedPublished.confirmation_windows[0].decision.blockers.push({ code: "unreviewed", severity: "blocker" });
  await assert.rejects(validateAppliedFullStreamManualReview(changedPublished), /differs from its evidence/);
  const droppedWarning = structuredClone(published);
  droppedWarning.warnings.pop();
  await assert.rejects(validateAppliedFullStreamManualReview(droppedWarning), /differs from its evidence/);

  // Verify the actual heard lossy clip by the supported deterministic recipe,
  // including equivalence to a clip originally created with second bounds.
  const clipPath = path.join(tmp, "heard.mp3");
  await execFile("ffmpeg", ["-v", "error", "-i", audios[0].path, "-af",
    "atrim=start=0.3:end=1.7,asetpts=PTS-STARTPTS", "-c:a", "libmp3lame", "-q:a", "2", clipPath]);
  const clippedEvidence = structuredClone(evidence);
  clippedEvidence.decisions[0].listened_audio = { ...clippedEvidence.decisions[0].listened_audio,
    path: clipPath, sha256: hash(await fs.readFile(clipPath)), start_sample_in_window: 7200,
    end_sample_in_window: 40800, encoding: "ffmpeg_libmp3lame_q2_v1" };
  await load(clippedEvidence);
  clippedEvidence.decisions[0].listened_audio.start_sample_in_window = 9600;
  await assert.rejects(load(clippedEvidence), /not the exact source-window excerpt/);
  const wrongSource = structuredClone(report);
  wrongSource.confirmation_windows[0].audio_path = audios[1].path;
  wrongSource.confirmation_windows[0].audio_sha256 = audios[1].sha256;
  const wrongSnapshot = await write("prior-full-stream.json", wrongSource);
  await write("canonical-full-stream.json", wrongSource);
  const wrongSourceEvidence = { ...evidence, prior_full_stream_qa_sha256: wrongSnapshot.sha256,
    scope: fullStreamReviewScope(wrongSource) };
  await assert.rejects(load(wrongSourceEvidence), /PCM does not match/);
  await write("prior-full-stream.json", report);
  await write("canonical-full-stream.json", report);
  await fs.writeFile(audios[0].path, "stale window bytes");
  await assert.rejects(load(), /confirmation window hash is stale/);
  assert.throws(() => validateOpeningFinalizationFlags({ "full-stream-review-evidence": evidenceFile.path }), /unavailable/);
  await assert.rejects(finalizeNarrationProviderOutput(["--episode-dir", tmp,
    "--full-stream-review-evidence", evidenceFile.path, "--accept-asr-delivery-blockers", "true"]), /cannot be combined/);
  console.log("PASS exact full-stream human review bindings, rejection, stale scope, clip derivation and unit-review preservation");
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
