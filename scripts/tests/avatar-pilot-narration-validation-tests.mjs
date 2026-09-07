import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildPilotRemainingExecutionFixture } from "./avatar-pilot-remaining-execution-tests.mjs";
import { validatePilotNarrationResult } from "../lib/avatar-pilot-narration-validation.mjs";
import { buildNarrationProviderOutputManifest, narrationProviderOutputManifestSha256 } from "../lib/narration-provider-adapter.mjs";
import { buildNarrationSubjectiveReviewManifest, narrationSubjectiveReviewManifestSha256 } from "../lib/narration-subjective-review.mjs";
import { buildLocalWhisperTimingCandidate, localWhisperTimingCandidateSha256 } from "../lib/local-whisper-timing-candidate.mjs";
import { localWhisperContractForIdentity } from "../lib/local-whisper-policy.mjs";
import { validateNarrationStitchAccounting } from "../lib/narration-boundary-editor.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

/** Explicit synthetic structural fixture. No voice/QA model runs, no personal
 * listening claim, no real source/artifact, and no imported production audio. */
export async function buildPilotNarrationValidationFixture({ remainingFixture = null } = {}) {
  const fixture = remainingFixture ?? await buildPilotRemainingExecutionFixture();
  try {
    const opening = fixture.openingFixture;
    const { root, identity, plan, writeJson, wavFixture } = opening;
    const { options, execution, acceptedOpening } = fixture;
    const units = plan.units, ids = units.map((unit) => unit.unit_id), policy = options.policy;
    const originals = [...opening.execution.results, ...execution.results];
    const namespace = path.join(root, "pilot_narration_work", "full_finalization");
    await fs.mkdir(namespace, { recursive: true });
    const duration = originals.reduce((sum, row) => sum + row.duration_sec, 0);
    const audioPath = path.join(namespace, "fixture-only-full-silence.wav");
    const audioBytes = wavFixture(duration); await fs.writeFile(audioPath, audioBytes);
    const audioHash = hash(audioBytes);
    const result = { ...structuredClone(opening.result), schema: "goldflow_avatar_pilot_narration_producer_result_v1",
      phase: "full_pilot", unit_ids: ids, accepted_opening: acceptedOpening,
      pre_synthesis_gate: { path: options.preSynthesisGatePath, sha256: options.preSynthesisGateFileSha256 },
      runner_report: { path: execution.reportPath, sha256: execution.reportSha256 },
      cohort_events: { path: execution.cohortEventsPath, sha256: execution.cohortEventsSha256 },
      finalization_artifacts: { audio: { path: audioPath, sha256: audioHash } } };
    const jsonValues = new Map();
    async function store(key, value) {
      const file = path.join(namespace, `${key}.json`);
      jsonValues.set(key, structuredClone(value));
      return result.finalization_artifacts[key] = { path: file, sha256: await writeJson(file, value) };
    }
    const openingManifest = JSON.parse(await fs.readFile(opening.result.provider_output_manifest.path, "utf8"));
    const remainingRun = { attempt: 1, synthesis_mode: policy.synthesis_contract.mode,
      batch_plan_sha256: plan.pilot_phase_batch_plans.remaining.batch_plan_sha256,
      report_path: execution.reportPath, report_sha256: execution.reportSha256,
      cohort_events_path: execution.cohortEventsPath, cohort_events_sha256: execution.cohortEventsSha256 };
    const providerExecution = { phase: "full_pilot", synthesis_contract: policy.synthesis_contract,
      phase_batch_plans: plan.pilot_phase_batch_plans,
      synthesis_runs: [openingManifest.provider_execution.synthesis_runs[0], remainingRun], effective_concurrency: 1 };
    const manifest = buildNarrationProviderOutputManifest({ provider: policy.primary.provider,
      modelId: policy.primary.model_id, modelRevision: policy.primary.model_revision,
      voiceId: policy.primary.voice_id, voiceSha256: policy.primary.voice_sha256,
      voiceContinuityContract: policy.primary.voice_continuity_contract,
      generationPlanSha256: plan.plan_sha256, generationPlanFileSha256: result.generation_plan.sha256,
      qualityContractSha256: policy.narration_quality_contract.contract_sha256,
      providerExecution, units, results: originals.map((row, index) => ({ ...row,
        audio_path: row.output_path, audio_sha256: row.output_sha256,
        runner_report_path: index < opening.units.length ? opening.execution.reportPath : execution.reportPath,
        runner_report_sha256: index < opening.units.length ? opening.execution.reportSha256 : execution.reportSha256 })) });
    const manifestPath = path.join(namespace, "full_provider_manifest.json");
    result.provider_output_manifest = { path: manifestPath, sha256: await writeJson(manifestPath, manifest) };
    const scope = { schema: "goldflow_narration_full_pilot_finalization_v1", phase: "full_pilot", complete_episode: true,
      production_eligible: false, unit_ids: ids, full_plan_unit_count: units.length,
      preserved_unit_ids: plan.pilot_opening_unit_ids, newly_synthesized_unit_ids: options.units.map((unit) => unit.unit_id),
      source_script_sha256: result.source_script_sha256, run_identity_sha256: result.identity_sha256,
      generation_plan_sha256: plan.plan_sha256, generation_plan_file_sha256: result.generation_plan.sha256,
      provider_manifest_file_sha256: result.provider_output_manifest.sha256,
      pre_synthesis_gate_file_sha256: result.pre_synthesis_gate.sha256,
      phase_batch_plan_sha256: Object.fromEntries(Object.entries(plan.pilot_phase_batch_plans).map(([key, batch]) => [key, batch.batch_plan_sha256])),
      accepted_opening: acceptedOpening, subjective_review_status: "pending" };
    const clone = (key) => structuredClone(opening.jsonValues.get(key));
    const continuity = clone("voice_continuity");
    continuity.candidate_count = units.length;
    continuity.units = units.map((unit, index) => ({ ...structuredClone(continuity.units[0]), unit_id: unit.unit_id,
      audio_path: originals[index].output_path, audio_sha256: originals[index].output_sha256 }));
    const continuityRef = await store("voice_continuity", continuity);
    const unitDelivery = clone("unit_delivery_qa");
    unitDelivery.unit_count = units.length;
    unitDelivery.voice_continuity_report_path = continuityRef.path; unitDelivery.voice_continuity_report_sha256 = continuityRef.sha256;
    unitDelivery.units = units.map((unit, index) => {
      const row = structuredClone(unitDelivery.units[0]);
      return { ...row, unit_id: unit.unit_id, audio_path: originals[index].output_path, audio_sha256: originals[index].output_sha256,
        intended_text: unit.spoken_text, intended_text_sha256: unit.spoken_text_sha256, primary_recognized_text: unit.spoken_text,
        voice_continuity: continuity.units[index], acoustic_qa: { ...row.acoustic_qa,
          audio_sha256: originals[index].output_sha256, metrics: { ...row.acoustic_qa.metrics,
            duration_sec: originals[index].duration_sec, sample_count: originals[index].sample_count } } };
    });
    await store("unit_delivery_qa", unitDelivery);
    const unitQa = clone("unit_qa"); unitQa.expected_unit_count = units.length; unitQa.selected_unit_count = units.length;
    unitQa.selected_units = units.map((unit, index) => ({ ...structuredClone(unitQa.selected_units[0]), unit_id: unit.unit_id,
      audio_path: originals[index].output_path, audio_sha256: originals[index].output_sha256,
      spoken_text: unit.spoken_text, spoken_text_sha256: unit.spoken_text_sha256,
      synthesis_identity: originals[index].synthesis_identity, synthesis_identity_sha256: originals[index].synthesis_identity_sha256,
      qa: { status: "passed", acoustic: unitDelivery.units[index].acoustic_qa,
        delivery: unitDelivery.units[index].decision, voice_continuity: continuity.units[index] } }));
    await store("unit_qa", unitQa);
    const preparedInputs = originals.map((row) => ({ unit_id: row.unit_id, sample_count: row.sample_count }));
    const boundaries = units.slice(0, -1).map((unit, index) => ({ boundary_id: `${unit.unit_id}__${ids[index + 1]}`,
      after_unit_id: unit.unit_id, before_unit_id: ids[index + 1], boundary_class: unit.boundary_after,
      gap_sample_count: 0, inserted_silence_sample_count: 0, retained_natural_silence_sample_count: 0, effective_pause_sample_count: 0 }));
    const stitch = clone("stitch_report");
    Object.assign(stitch, { finalization_scope: scope, final_duration_sec: duration, output_path: audioPath, output_sha256: audioHash,
      final_wav_path: audioPath, final_wav_sha256: audioHash, boundaries,
      sample_accounting: validateNarrationStitchAccounting({ preparedInputs, boundaries, finalSampleCount: Math.round(duration * 24000) }) });
    Object.assign(stitch.mastering, { input_path: audioPath, output_path: audioPath, input_sha256: audioHash, output_sha256: audioHash });
    stitch.mastering.output_probe.duration_sec = duration;
    const stitchRef = await store("stitch_report", stitch);
    const intended = units.map((unit) => unit.spoken_text).join(" ");
    const words = intended.split(/\s+/u).map((word, index, all) => ({ word,
      start_sec: index * duration / all.length, end_sec: (index + 1) * duration / all.length, probability: 1 }));
    const delivery = clone("full_stream_qa");
    Object.assign(delivery, { finalization_scope: scope, audio_path: audioPath, audio_sha256: audioHash,
      intended_text_sha256: hash(intended), primary_recognized_text: intended, primary_recognized_words: words });
    delivery.order_qa.expected_unit_ids = ids; delivery.order_qa.actual_unit_ids = ids;
    await store("full_stream_qa", delivery);
    const subjective = buildNarrationSubjectiveReviewManifest({ plan, stitch: { prepared_inputs: preparedInputs, boundaries },
      audioPath, audioSha256: audioHash, generationPlanSha256: plan.plan_sha256,
      generationPlanFileSha256: result.generation_plan.sha256, qualityContractSha256: policy.narration_quality_contract.contract_sha256 });
    subjective.finalization_scope = scope; subjective.manifest_sha256 = narrationSubjectiveReviewManifestSha256(subjective);
    await store("subjective_manifest", subjective);
    const timing = buildLocalWhisperTimingCandidate({ transcription: { words, text: intended, duration_sec: duration, language: "en", language_probability: 1 },
      contract: localWhisperContractForIdentity(identity), sourceScriptPath: options.scriptPath, sourceScriptSha256: result.source_script_sha256,
      narrationAudioPath: audioPath, narrationAudioSha256: audioHash, narrationReportPath: stitchRef.path, narrationReportSha256: stitchRef.sha256,
      runIdentityPath: options.identityPath, runIdentitySha256: result.identity_sha256,
      narrationQualityContractSha256: policy.narration_quality_contract.contract_sha256 });
    timing.finalization_scope = scope; timing.candidate_sha256 = localWhisperTimingCandidateSha256(timing);
    await store("timing_candidate", timing);
    const tts = clone("tts_report");
    Object.assign(tts, { finalization_scope: scope, expected_unit_count: units.length, selected_unit_count: units.length,
      provider_output_manifest_sha256: result.provider_output_manifest.sha256,
      voice_continuity_report_path: continuityRef.path, voice_continuity_report_sha256: continuityRef.sha256,
      synthesis_runs: providerExecution.synthesis_runs, batch_plan_sha256: null, effective_concurrency: 1, mastering: stitch.mastering });
    tts.results = units.map((unit, index) => ({ ...structuredClone(tts.results[0]), unit_id: unit.unit_id,
      audio_path: originals[index].output_path, audio_sha256: originals[index].output_sha256,
      spoken_text_sha256: unit.spoken_text_sha256, synthesis_identity_sha256: originals[index].synthesis_identity_sha256,
      selected_qa: unitQa.selected_units[index].qa }));
    await store("tts_report", tts);
    return { ...fixture, openingFixture: opening, root, identity, options, execution, plan, result, manifest, originals,
      jsonValues, audioPath, audioBytes, duration, writeJson, namespace };
  } catch (error) { await fixture.cleanup(); throw error; }
}

async function main() {
  const fixture = await buildPilotNarrationValidationFixture();
  const { result, identity, root, writeJson, jsonValues, manifest, originals, audioPath, audioBytes } = fixture;
  const verify = (value = result) => validatePilotNarrationResult(value, { episodeDir: root, identity });
  let count = 0;
  try {
    const positive = await verify();
    assert.equal(positive.status, "passed", JSON.stringify(positive.findings));
    assert.equal(positive.subjective_review_status, "pending"); assert.equal(positive.official_full_narration_timing, false);
    assert.equal(positive.production_eligible, false); assert.equal(positive.publish_allowed, false);
    assert.notEqual(result.finalization_artifacts.audio.sha256, fixture.openingFixture.result.finalization_artifacts.audio.sha256,
      "new complete master need not preserve the old opening master bytes");
    for (const mutate of [
      (row) => { row.unit_ids.reverse(); }, (row) => { row.unit_ids.pop(); },
      (row) => { row.accepted_opening.approval.sha256 = "0".repeat(64); },
      (row) => { row.source_script_sha256 = "0".repeat(64); },
      (row) => { row.subjective_approval = { status: "approved" }; },
      (row) => { row.publish_allowed = true; },
      (row) => { row.pre_synthesis_gate = fixture.openingFixture.result.pre_synthesis_gate; },
      (row) => { row.runner_report = fixture.openingFixture.result.runner_report; },
    ]) {
      const changed = structuredClone(result); mutate(changed);
      assert.equal((await verify(changed)).status, "blocked"); count++;
    }
    for (const mutate of [
      (row) => { row.units[0].audio_sha256 = "0".repeat(64); },
      (row) => { row.units[0].duration_sec += 1; },
      (row) => { row.provider_execution.synthesis_runs.reverse(); },
      (row) => { row.provider_execution.batch_plan_sha256 = row.provider_execution.phase_batch_plans.opening.batch_plan_sha256; },
    ]) {
      const changedManifest = structuredClone(manifest); mutate(changedManifest);
      changedManifest.manifest_sha256 = narrationProviderOutputManifestSha256(changedManifest);
      const changed = structuredClone(result);
      changed.provider_output_manifest.sha256 = await writeJson(changed.provider_output_manifest.path, changedManifest);
      assert.equal((await verify(changed)).status, "blocked"); count++;
      await writeJson(result.provider_output_manifest.path, manifest);
    }
    for (const [key, mutate] of [
      ["tts_report", (row) => { row.post_tempo_normalized = true; }],
      ["full_stream_qa", (row) => { row.finalization_scope.preserved_unit_ids = []; }],
      ["full_stream_qa", (row) => { row.primary_model = "medium"; }],
      ["full_stream_qa", (row) => { row.primary_alignment_contract.beam_size += 1; }],
      ["unit_qa", (row) => { row.selected_units.pop(); }],
      ["subjective_manifest", (row) => { row.status = "approved"; }],
      ["timing_candidate", (row) => { row.words[0].word = "Unapproved"; }],
    ]) {
      const changedArtifact = structuredClone(jsonValues.get(key)); mutate(changedArtifact);
      if (key === "subjective_manifest") changedArtifact.manifest_sha256 = narrationSubjectiveReviewManifestSha256(changedArtifact);
      if (key === "timing_candidate") changedArtifact.candidate_sha256 = localWhisperTimingCandidateSha256(changedArtifact);
      const changed = structuredClone(result);
      changed.finalization_artifacts[key].sha256 = await writeJson(changed.finalization_artifacts[key].path, changedArtifact);
      assert.equal((await verify(changed)).status, "blocked"); count++;
      await writeJson(result.finalization_artifacts[key].path, jsonValues.get(key));
    }
    const originalAudio = await fs.readFile(originals[0].output_path);
    await fs.appendFile(originals[0].output_path, "tampered accepted raw unit");
    assert.equal((await verify()).status, "blocked"); count++;
    await fs.writeFile(originals[0].output_path, originalAudio);
    await fs.appendFile(audioPath, "tampered full master");
    assert.equal((await verify()).status, "blocked"); count++;
    await fs.writeFile(audioPath, audioBytes);
    const overlong = Buffer.alloc(44 + Math.round(90.25 * 24000) * 2);
    fixture.openingFixture.wavFixture(90).copy(overlong);
    overlong.writeUInt32LE(overlong.length - 8, 4);
    overlong.writeUInt32LE(overlong.length - 44, 40);
    await fs.writeFile(audioPath, overlong);
    const overlongResult = structuredClone(result); overlongResult.finalization_artifacts.audio.sha256 = hash(overlong);
    const durationCheck = await verify(overlongResult);
    assert.equal(durationCheck.status, "blocked");
    assert.ok(durationCheck.findings.some((row) => row.code.includes("fit 90 seconds")), JSON.stringify(durationCheck.findings)); count++;
    await fs.writeFile(audioPath, audioBytes);
    assert.equal((await verify()).status, "passed");
    console.log(`avatar pilot full narration validation tests passed (${count} blocked mutations; synthetic structural evidence only, no voice/provider calls)`);
  } finally { await fixture.cleanup(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
