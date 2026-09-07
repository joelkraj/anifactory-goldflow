import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildPilotOpeningExecutionFixture } from "./avatar-pilot-opening-execution-tests.mjs";
import { validatePilotOpeningSampleResult } from "../lib/avatar-pilot-opening-validation.mjs";
import { buildNarrationProviderOutputManifest } from "../lib/narration-provider-adapter.mjs";
import { buildNarrationSubjectiveReviewManifest, narrationSubjectiveReviewManifestSha256 } from "../lib/narration-subjective-review.mjs";
import { buildLocalWhisperTimingCandidate, localWhisperTimingCandidateSha256 } from "../lib/local-whisper-timing-candidate.mjs";
import { localWhisperContractForIdentity } from "../lib/local-whisper-policy.mjs";
import { validateNarrationStitchAccounting } from "../lib/narration-boundary-editor.mjs";
import { adjudicateNarrationDeliveryConsensus, strictNarrationDeliveryDecision } from "../lib/narration-delivery-quality.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const fixture = await buildPilotOpeningExecutionFixture({ unitDurationSec: 8 });
const { root, identity, options, execution, built, writeJson, wavFixture } = fixture;
const { plan, units, policy } = options;
const ids = units.map((unit) => unit.unit_id);
const namespace = path.join(root, "pilot_narration_work", "opening_finalization");
const jsonValues = new Map();
const checks = [];
const result = {
  schema: "goldflow_avatar_pilot_opening_producer_result_v1", phase: "opening",
  status: "technical_finalization_returned_pending_validation_and_listening",
  identity_sha256: options.identityFileSha256, source_script_sha256: options.scriptSha256,
  unit_ids: ids, production_eligible: false, publish_allowed: false, subjective_approval: null,
  generation_plan: { path: options.planPath, sha256: options.planFileSha256 },
  spoken_text_ir: { path: options.preSynthesisGate.bindings.narration_text_ir_path, sha256: options.preSynthesisGate.bindings.narration_text_ir_file_sha256 },
  spoken_text_audit: { path: options.preSynthesisGate.bindings.tts_spoken_text_audit_path, sha256: options.preSynthesisGate.bindings.tts_spoken_text_audit_file_sha256 },
  pre_synthesis_gate: { path: options.preSynthesisGatePath, sha256: options.preSynthesisGateFileSha256 },
  runner_report: { path: execution.reportPath, sha256: execution.reportSha256 },
  cohort_events: { path: execution.cohortEventsPath, sha256: execution.cohortEventsSha256 },
  finalization_artifacts: {},
};
async function store(name, value) {
  const file = path.join(namespace, `${name}.json`);
  const ref = { path: file, sha256: await writeJson(file, value) };
  jsonValues.set(name, structuredClone(value)); result.finalization_artifacts[name] = ref;
  return ref;
}
async function verify(candidate = result, selectedIdentity = identity) {
  return validatePilotOpeningSampleResult(candidate, { episodeDir: root, identity: selectedIdentity });
}
async function rejectResult(name, mutate) {
  const copy = structuredClone(result); mutate(copy);
  const checked = await verify(copy); checks.push({ name, blocked: checked.status === "blocked", findings: checked.findings });
}
async function rejectArtifact(name, key, mutate) {
  const value = structuredClone(jsonValues.get(key)); mutate(value);
  if (key === "subjective_manifest") value.manifest_sha256 = narrationSubjectiveReviewManifestSha256(value);
  if (key === "timing_candidate") value.candidate_sha256 = localWhisperTimingCandidateSha256(value);
  const copy = structuredClone(result);
  copy.finalization_artifacts[key].sha256 = await writeJson(copy.finalization_artifacts[key].path, value);
  // Refresh downstream file bindings to isolate semantic validation rather
  // than passing a negative test merely because an unrelated hash went stale.
  const restored = [key];
  if (key === "stitch_report") {
    const timing = structuredClone(jsonValues.get("timing_candidate"));
    timing.narration_report_sha256 = copy.finalization_artifacts.stitch_report.sha256;
    timing.candidate_sha256 = localWhisperTimingCandidateSha256(timing);
    copy.finalization_artifacts.timing_candidate.sha256 = await writeJson(copy.finalization_artifacts.timing_candidate.path, timing);
    restored.push("timing_candidate");
  }
  if (key === "voice_continuity") {
    for (const dependent of ["tts_report", "unit_delivery_qa"]) {
      const report = structuredClone(jsonValues.get(dependent));
      report.voice_continuity_report_sha256 = copy.finalization_artifacts.voice_continuity.sha256;
      copy.finalization_artifacts[dependent].sha256 = await writeJson(copy.finalization_artifacts[dependent].path, report);
      restored.push(dependent);
    }
  }
  const checked = await verify(copy); checks.push({ name, blocked: checked.status === "blocked", findings: checked.findings });
  for (const restoredKey of restored) await writeJson(copy.finalization_artifacts[restoredKey].path, jsonValues.get(restoredKey));
}

try {
  await fs.mkdir(namespace, { recursive: true });
  // Explicitly synthetic silence, transcript observations and QA measurements.
  // This is an actual-file structural fixture, never a real narrated take or a
  // claim that silence passed speech/listening QA. No model or provider runs.
  const audioPath = path.join(namespace, "fixture-only-silence.wav");
  const audioBytes = wavFixture(16); await fs.writeFile(audioPath, audioBytes);
  const audioHash = hash(audioBytes); const totalSamples = 16 * 24000;
  result.finalization_artifacts.audio = { path: audioPath, sha256: audioHash };
  const manifest = buildNarrationProviderOutputManifest({ provider: policy.primary.provider,
    modelId: policy.primary.model_id, modelRevision: policy.primary.model_revision,
    voiceId: policy.primary.voice_id, voiceSha256: policy.primary.voice_sha256,
    voiceContinuityContract: policy.primary.voice_continuity_contract,
    generationPlanSha256: plan.plan_sha256, generationPlanFileSha256: options.planFileSha256,
    qualityContractSha256: policy.narration_quality_contract.contract_sha256,
    providerExecution: { phase: "opening", synthesis_contract: policy.synthesis_contract,
      batch_plan_sha256: options.batchPlan.batch_plan_sha256, effective_concurrency: 1,
      synthesis_runs: [{ attempt: 1, synthesis_mode: policy.synthesis_contract.mode,
        batch_plan_sha256: options.batchPlan.batch_plan_sha256,
        report_path: execution.reportPath, report_sha256: execution.reportSha256,
        cohort_events_path: execution.cohortEventsPath, cohort_events_sha256: execution.cohortEventsSha256 }] },
    units, results: execution.results.map((row) => ({ ...row, audio_path: row.output_path, audio_sha256: row.output_sha256,
      runner_report_path: execution.reportPath, runner_report_sha256: execution.reportSha256 })) });
  assert.equal(manifest.status, "passed");
  const manifestPath = path.join(root, "provider-manifest.json");
  result.provider_output_manifest = { path: manifestPath, sha256: await writeJson(manifestPath, manifest) };
  const scope = { schema: "goldflow_narration_opening_finalization_v1", phase: "opening", complete_episode: false,
    production_eligible: false, unit_ids: ids, full_plan_unit_count: plan.units.length,
    source_script_sha256: options.scriptSha256, run_identity_sha256: options.identityFileSha256,
    generation_plan_sha256: plan.plan_sha256, generation_plan_file_sha256: options.planFileSha256,
    provider_manifest_file_sha256: result.provider_output_manifest.sha256,
    pre_synthesis_gate_file_sha256: options.preSynthesisGateFileSha256,
    batch_plan_sha256: options.batchPlan.batch_plan_sha256, subjective_review_status: "pending" };
  const common = { fixture_only: true, status: "passed", source_script_hash: options.scriptSha256,
    narration_generation_plan_path: options.planPath, narration_generation_plan_sha256: plan.plan_sha256,
    narration_generation_plan_file_sha256: options.planFileSha256,
    narration_quality_contract_sha256: policy.narration_quality_contract.contract_sha256 };
  const transcriptQa = { status: "passed", word_error_rate: 0, substitutions: 0, deletions: 0, insertions: 0,
    leading_deletion_run: 0, trailing_deletion_run: 0, longest_deletion_run: 0, longest_insertion_run: 0, findings: [] };
  const decision = adjudicateNarrationDeliveryConsensus({ primaryTranscriptQa: transcriptQa, confirmationTranscriptQa: transcriptQa,
    contract: policy.narration_quality_contract, orderQa: { blockers: [] }, joinQa: { blockers: [], warnings: [] } });
  const continuityUnits = execution.results.map((row) => ({ unit_id: row.unit_id, status: "passed", audio_path: row.output_path,
    audio_sha256: row.output_sha256, reference_voice_id: policy.primary.reference_voice_id,
    reference_voice_sha256: policy.primary.reference_voice_sha256, voice_continuity_contract: policy.primary.voice_continuity_contract,
    threshold_mode: "reference_leave_one_out", reference_count: 3, cosine_similarity: 0.9,
    minimum_cosine_similarity: 0.7, warning_below_cosine_similarity: 0.8, warnings: [] }));
  const continuityRef = await store("voice_continuity", { schema: "goldflow_narration_voice_continuity_qa_v2", fixture_only: true,
    status: "passed", voice_id: policy.primary.voice_id, voice_sha256: policy.primary.voice_sha256,
    voice_continuity_contract: policy.primary.voice_continuity_contract, reference_count: 3, candidate_count: units.length,
    units: continuityUnits, blockers: [], warnings: [] });
  const deliveryRows = units.map((unit, index) => ({ unit_id: unit.unit_id, audio_path: execution.results[index].output_path,
    audio_sha256: execution.results[index].output_sha256, intended_text: unit.spoken_text,
    intended_text_sha256: unit.spoken_text_sha256, primary_recognized_text: unit.spoken_text,
    confirmation_recognized_text: null, transcript_qa: transcriptQa, confirmation_transcript_qa: null,
    acoustic_qa: { status: "passed", audio_sha256: execution.results[index].output_sha256,
      metrics: { sample_rate_hz: 24000, sample_count: 8 * 24000, duration_sec: 8 }, findings: [] },
    voice_continuity: continuityUnits[index], decision }));
  await store("unit_delivery_qa", { ...common, schema: "goldflow_narration_unit_delivery_qa_v2",
    quality_contract_sha256: policy.narration_quality_contract.contract_sha256,
    unit_count: units.length, blocked_unit_count: 0, listen_review_unit_count: 0,
    voice_continuity_report_path: continuityRef.path, voice_continuity_report_sha256: continuityRef.sha256,
    units: deliveryRows, blockers: [], operator_narration_qa_waiver: null });
  const selectedUnits = units.map((unit, index) => ({ unit_id: unit.unit_id,
    audio_path: execution.results[index].output_path, audio_sha256: execution.results[index].output_sha256,
    spoken_text: unit.spoken_text, spoken_text_sha256: unit.spoken_text_sha256,
    synthesis_identity: execution.results[index].synthesis_identity,
    synthesis_identity_sha256: execution.results[index].synthesis_identity_sha256,
    qa_status: "passed", qa: { status: "passed", acoustic: deliveryRows[index].acoustic_qa,
      delivery: decision, voice_continuity: continuityUnits[index] } }));
  await store("unit_qa", { ...common, schema: "goldflow_narration_tts_unit_qa_v2",
    expected_unit_count: units.length, selected_unit_count: units.length, selected_blocker_count: 0,
    selected_blockers: [], selected_units: selectedUnits, operator_narration_qa_waiver: null });
  const preparedInputs = units.map((unit) => ({ unit_id: unit.unit_id, sample_count: 8 * 24000 }));
  const boundaries = [{ boundary_id: `${ids[0]}__${ids[1]}`, after_unit_id: ids[0], before_unit_id: ids[1],
    boundary_class: "paragraph", gap_sample_count: 0, inserted_silence_sample_count: 0,
    retained_natural_silence_sample_count: 0, effective_pause_sample_count: 0 }];
  const sampleAccounting = validateNarrationStitchAccounting({ preparedInputs, boundaries, finalSampleCount: totalSamples });
  const mastering = { schema: "goldflow_narration_mastering_report_v2", status: "passed", fixture_only: true,
    input_path: audioPath, output_path: audioPath, input_sha256: audioHash, output_sha256: audioHash,
    policy: { target_lufs: -16, true_peak_dbtp_max: -1.5, loudness_range_target: 11,
      tempo_processing: false, broadband_denoise: false, per_unit_normalization: false },
    output_probe: { duration_sec: 16, sample_rate_hz: 24000, channels: 1, codec_name: "pcm_s16le" },
    measured_integrated_lufs: -16, measured_true_peak_dbtp: -1.5, duration_delta_ms: 0 };
  const stitchRef = await store("stitch_report", { ...common, finalization_scope: scope,
    schema: "goldflow_provider_neutral_narration_stitch_v2", output_path: audioPath, output_sha256: audioHash,
    final_wav_path: audioPath, final_wav_sha256: audioHash, final_duration_sec: 16,
    sample_accounting: sampleAccounting, boundaries, mastering, subjective_review_waiver: null });
  const intended = units.map((unit) => unit.spoken_text).join(" ");
  const words = intended.split(/\s+/u).map((word, index, all) => ({ word, start_sec: index * 16 / all.length,
    end_sec: (index + 1) * 16 / all.length, probability: 1 }));
  const orderQa = { status: "passed", expected_unit_ids: ids, actual_unit_ids: ids, blockers: [] };
  const joinQa = { status: "passed", blockers: [], warnings: [] };
  const fullDecision = strictNarrationDeliveryDecision(transcriptQa, { contract: policy.narration_quality_contract, orderQa, joinQa });
  await store("full_stream_qa", { ...common, finalization_scope: scope, schema: "goldflow_narration_full_stream_qa_v2",
    audio_path: audioPath, audio_sha256: audioHash, intended_text_sha256: hash(intended), primary_recognized_text: intended,
    primary_recognized_words: words, primary_model: "medium", primary_transcript_qa: transcriptQa,
    primary_alignment_contract: localWhisperContractForIdentity(identity), confirmation_required: false,
    decision: fullDecision, order_qa: orderQa, join_qa: joinQa, blockers: [], warnings: [], operator_narration_qa_waiver: null });
  const subjective = buildNarrationSubjectiveReviewManifest({ plan: { ...plan, units },
    stitch: { prepared_inputs: preparedInputs, boundaries }, audioPath, audioSha256: audioHash,
    generationPlanSha256: plan.plan_sha256, generationPlanFileSha256: options.planFileSha256,
    qualityContractSha256: policy.narration_quality_contract.contract_sha256 });
  await store("subjective_manifest", subjective);
  await store("timing_candidate", buildLocalWhisperTimingCandidate({ transcription: { words, text: intended, duration_sec: 16,
    language: "en", language_probability: 1 }, contract: localWhisperContractForIdentity(identity),
    sourceScriptPath: options.scriptPath, sourceScriptSha256: options.scriptSha256,
    narrationAudioPath: audioPath, narrationAudioSha256: audioHash,
    narrationReportPath: stitchRef.path, narrationReportSha256: stitchRef.sha256,
    runIdentityPath: options.identityPath, runIdentitySha256: options.identityFileSha256,
    narrationQualityContractSha256: policy.narration_quality_contract.contract_sha256 }));
  await store("tts_report", { ...common, finalization_scope: scope, schema: "goldflow_provider_neutral_narration_tts_report_v2",
    primary_provider: policy.primary.provider, primary_model_id: policy.primary.model_id, primary_model_revision: policy.primary.model_revision,
    voice_id: policy.primary.voice_id, voice_sha256: policy.primary.voice_sha256,
    tts_native_speed: null, post_tempo_normalized: false, fallback_unit_ids: [], operator_narration_qa_waiver: null,
    provider_output_manifest_sha256: result.provider_output_manifest.sha256,
    voice_continuity_report_path: continuityRef.path, voice_continuity_report_sha256: continuityRef.sha256,
    expected_unit_count: units.length, selected_unit_count: units.length, synthesis_contract: policy.synthesis_contract,
    batch_plan_sha256: options.batchPlan.batch_plan_sha256, subjective_review_status: "pending", subjective_review_waiver: null,
    results: units.map((unit, index) => ({ unit_id: unit.unit_id, audio_path: execution.results[index].output_path,
      audio_sha256: execution.results[index].output_sha256, spoken_text_sha256: unit.spoken_text_sha256,
      synthesis_identity_sha256: execution.results[index].synthesis_identity_sha256, token_limit_reached: false,
      qa_status: "passed", selected_qa: selectedUnits[index].qa })), mastering });

  const positive = await verify();
  assert.equal(positive.status, "passed", JSON.stringify(positive.findings));
  assert.equal(positive.subjective_review_status, "pending");
  assert.equal(positive.official_full_narration_timing, false);
  assert.equal(positive.duration_sec, 16);
  await rejectResult("changed source declaration", (row) => { row.source_script_sha256 = "0".repeat(64); });
  await rejectResult("reordered opening", (row) => row.unit_ids.reverse());
  await rejectResult("full source scope masquerading as opening", (row) => { row.unit_ids = plan.units.map((unit) => unit.unit_id); });
  await rejectResult("stale report hash", (row) => { row.finalization_artifacts.tts_report.sha256 = "0".repeat(64); });
  await rejectResult("forged subjective acceptance", (row) => { row.subjective_approval = { status: "approved" }; });
  await rejectResult("publishing claimed", (row) => { row.publish_allowed = true; });
  const escapedAudio = path.join(namespace, "..", "escaped-fixture.wav");
  await fs.writeFile(escapedAudio, audioBytes);
  await rejectResult("lexical namespace traversal", (row) => { row.finalization_artifacts.audio.path = `${namespace}/../escaped-fixture.wav`; });
  const linkPath = path.join(namespace, "outside-link");
  await fs.symlink(path.dirname(escapedAudio), linkPath, "dir");
  await rejectResult("parent symlink escapes phase namespace", (row) => { row.finalization_artifacts.audio.path = path.join(linkPath, "escaped-fixture.wav"); });
  const sourceOriginal = await fs.readFile(options.scriptPath);
  await fs.appendFile(options.scriptPath, "Changed.");
  checks.push({ name: "changed source bytes", blocked: (await verify()).status === "blocked" });
  await fs.writeFile(options.scriptPath, sourceOriginal);
  await fs.appendFile(audioPath, "changed");
  checks.push({ name: "changed canonical WAV bytes", blocked: (await verify()).status === "blocked" });
  await fs.writeFile(audioPath, audioBytes);
  await rejectArtifact("report widened scope", "tts_report", (row) => { row.finalization_scope.complete_episode = true; });
  await rejectArtifact("tempo processing requested", "tts_report", (row) => { row.post_tempo_normalized = true; });
  await rejectArtifact("mastering tempo flag", "stitch_report", (row) => { row.mastering.policy.tempo_processing = true; });
  await rejectArtifact("missing sample accounting", "stitch_report", (row) => { row.sample_accounting = { exact_sample_accounting: true }; });
  await rejectArtifact("stream blocker", "full_stream_qa", (row) => row.blockers.push({ code: "fixture_missing_word" }));
  await rejectArtifact("nested stream blocker", "full_stream_qa", (row) => row.decision.blockers.push({ code: "fixture_missing_word" }));
  await rejectArtifact("empty unit QA", "unit_qa", (row) => { row.selected_units = []; row.selected_unit_count = 0; });
  await rejectArtifact("wrong unit QA schema", "unit_qa", (row) => { row.schema = "not_canonical_qa"; });
  await rejectArtifact("empty unit delivery", "unit_delivery_qa", (row) => { row.units = []; row.unit_count = 0; });
  await rejectArtifact("changed unit delivery text", "unit_delivery_qa", (row) => { row.units[0].intended_text = "Unapproved different words."; });
  await rejectArtifact("voice continuity candidate mismatch", "voice_continuity", (row) => { row.units[0].audio_sha256 = "0".repeat(64); });
  await rejectArtifact("rehashed listening manifest falsely accepted", "subjective_manifest", (row) => { row.status = "approved"; });
  await rejectArtifact("listening manifest unrelated unit", "subjective_manifest", (row) => { row.samples[0].unit_ids = ["unrelated"]; });
  await rejectArtifact("listening samples shorter than audio", "subjective_manifest", (row) => {
    row.total_sample_count = 240; row.duration_sec = 0.01;
    for (const sample of row.samples) { sample.start_sample = 0; sample.end_sample_exclusive = 240; sample.start_sec = 0; sample.end_sec = 0.01; sample.duration_sec = 0.01; }
  });
  await rejectArtifact("changed Whisper recognized words", "timing_candidate", (row) => {
    row.words[0].word = "Unapproved"; row.recognized_text = row.words.map((word) => word.word).join(" ");
  });
  const missed = checks.filter((row) => !row.blocked);
  assert.deepEqual(missed, [], `Missing validation gates: ${JSON.stringify(missed)}`);
  assert.equal((await verify()).status, "passed", "restored fixture remains pending actual listening");
  console.log(`avatar pilot opening validation tests passed (${checks.length} blocked mutations; synthetic structural fixtures only, no speech/model/provider work)`);
} finally {
  await fixture.cleanup();
}
