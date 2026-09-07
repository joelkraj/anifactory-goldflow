import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { buildPilotNarrationPendingReviewFixture } from "./avatar-pilot-narration-review-validation-tests.mjs";
import { buildPilotRawNarrationReview, validatePilotNarrationReviewAuthorization,
  PILOT_RAW_NARRATION_REVIEW_ATTESTATION } from "../lib/avatar-pilot-narration-review.mjs";
import { narrationFinalizationUnitKey, narrationFinalizationStageKey } from "../lib/narration-finalization-checkpoint.mjs";
import { validateNarrationStitchAccounting } from "../lib/narration-boundary-editor.mjs";
import { localWhisperTimingCandidateSha256 } from "../lib/local-whisper-timing-candidate.mjs";
import { canonicalQwenBatchSha256 } from "../lib/qwen-liam-batch-contract.mjs";
import { narrationExactListenReviewDecisionSha256 } from "../lib/narration-delivery-quality.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Synthetic PCM/cache evidence only. No real narrated take, model, or human
 * listening claim is created. Importing this module does not run its tests. */
export async function buildPilotNarrationReviewFixture({ pendingFixture = null, tailTrimSamples = 0 } = {}) {
  const fixture = pendingFixture ?? await buildPilotNarrationPendingReviewFixture();
  try {
    const { root, result, identity, plan, manifest, options, namespace, originals,
      jsonValues, store, writeJson, packet, packetRef } = fixture;
    const qualityHash = identity.narration_quality_contract.contract_sha256;
    const preparedDir = path.join(namespace, "audio", "stitch-inputs-v2");
    await fs.mkdir(preparedDir, { recursive: true });
    const delivery = structuredClone(jsonValues.get("unit_delivery_qa"));
    const prepared = [];
    for (const [index, source] of manifest.units.entries()) {
      const originalBytes = await fs.readFile(source.audio_path), samples = originals[index].sample_count;
      const trimmed = index === manifest.units.length - 1 ? tailTrimSamples : 0;
      assert(Number.isInteger(trimmed) && trimmed >= 0 && trimmed < samples);
      const bytes = Buffer.from(originalBytes.subarray(0, originalBytes.length - trimmed * 2));
      bytes.writeUInt32LE(bytes.length - 8, 4); bytes.writeUInt32LE(bytes.length - 44, 40);
      const retained = samples - trimmed;
      const preparedPath = path.join(preparedDir, `${source.unit_id}.wav`);
      await fs.writeFile(preparedPath, bytes);
      const edge = { status: "passed", engine: "synthetic-fixture-only", sample_rate_hz: 24000,
        first_speech_sample: 0, last_speech_sample_exclusive: retained };
      delivery.units[index].edge_alignment = edge;
      prepared.push({ unit_id: source.unit_id, source_wav: source.audio_path,
        prepared_wav: preparedPath, prepared_audio_sha256: hash(bytes), sample_count: retained,
        source_sample_count: samples, trim_start_sample: 0, trim_end_sample: retained,
        fade_sec: 0, diagnostic_repair_tail_silence_sample_count: 0,
        edge_edit_plan: { status: "passed", mode: "alignment_safe_trim", alignment_used: true,
          source_sample_count: samples, trim_start_sample: 0, trim_end_sample: retained,
          retained_sample_count: retained, fade_in_samples: 0, fade_out_samples: 0, blockers: [] },
        preparation_policy: { edge_alignment: edge } });
    }
    await store("unit_delivery_qa", delivery);
    const stitchReport = structuredClone(jsonValues.get("stitch_report"));
    if (tailTrimSamples > 0) Object.assign(stitchReport.boundaries.at(-1), {
      gap_sample_count: tailTrimSamples, inserted_silence_sample_count: tailTrimSamples,
      effective_pause_sample_count: tailTrimSamples,
    });
    stitchReport.segments = manifest.units.map((source, index) => ({ unit_id: source.unit_id,
      raw_audio_path: source.audio_path, raw_audio_sha256: source.audio_sha256,
      synthesis_identity_sha256: source.synthesis_identity_sha256,
      prepared_audio_path: prepared[index].prepared_wav, prepared_audio_sha256: prepared[index].prepared_audio_sha256 }));
    const sampleCount = originals.reduce((sum, row) => sum + row.sample_count, 0);
    stitchReport.sample_accounting = validateNarrationStitchAccounting({ preparedInputs: prepared,
      boundaries: stitchReport.boundaries, finalSampleCount: sampleCount });
    assert.equal(stitchReport.sample_accounting.status, "passed");
    await store("stitch_report", stitchReport);
    const timing = structuredClone(jsonValues.get("timing_candidate"));
    timing.narration_report_sha256 = result.finalization_artifacts.stitch_report.sha256;
    timing.candidate_sha256 = localWhisperTimingCandidateSha256(timing);
    await store("timing_candidate", timing);
    const rawAudioRef = result.finalization_artifacts.audio;
    const unitKeys = manifest.units.map((unit) => narrationFinalizationUnitKey({ unit,
      qualityContractSha256: qualityHash, provider: manifest.provider, modelId: manifest.model_id,
      modelRevision: manifest.model_revision, voiceId: manifest.voice_id, voiceSha256: manifest.voice_sha256,
      voiceContinuityContract: manifest.voice_continuity_contract }));
    const checkpoint = { schema: "goldflow_narration_finalization_checkpoint_v1", status: "complete",
      fixture_only: true,
      context: { finalization_scope: stitchReport.finalization_scope,
        narration_generation_plan_sha256: plan.plan_sha256,
        narration_generation_plan_file_sha256: result.generation_plan.sha256,
        provider_output_manifest_sha256: manifest.manifest_sha256,
        provider_output_manifest_file_sha256: result.provider_output_manifest.sha256,
        narration_quality_contract_sha256: qualityHash,
        ...Object.fromEntries(["provider", "model_id", "model_revision", "voice_id", "voice_sha256", "voice_continuity_contract"]
          .map((key) => [key, manifest[key]])) },
      units: Object.fromEntries(manifest.units.map((unit, index) => [unit.unit_id, {
        unit_key: unitKeys[index], audio_sha256: unit.audio_sha256,
        spoken_text_sha256: unit.spoken_text_sha256, delivery_row: delivery.units[index] }])),
      stages: { semantic_stitch: { status: "passed",
        input_key: narrationFinalizationStageKey("semantic_stitch", { ordered_unit_keys: unitKeys,
          quality_contract_sha256: qualityHash, stitch_sample_rate_hz: 24000,
          alignment_policy: "narration_alignment_safe_semantic_stitch_v2" }),
        payload: { raw_wav_path: rawAudioRef.path, raw_wav_sha256: rawAudioRef.sha256,
          stitch: { status: "passed", prepared_inputs: prepared, boundaries: stitchReport.boundaries,
            sample_accounting: stitchReport.sample_accounting,
            policy: { version: "narration_alignment_safe_semantic_stitch_v2", quality_contract_sha256: qualityHash,
              sample_rate: 24000, amplitude_only_trimming: false, alignment_required_for_trimming: true,
              fade_over_speech: false } } } } } };
    const checkpointPath = path.join(namespace, "audio", `narration-finalization-checkpoint-${identity.episode}.json`);
    const checkpointRef = { path: checkpointPath, sha256: await writeJson(checkpointPath, checkpoint) };
    Object.assign(result.finalized, { checkpoint_path: checkpointPath, finalization_scope: stitchReport.finalization_scope,
      phase_context: { phase: "full_pilot", outputNamespace: namespace, unitIds: result.unit_ids,
        identitySha256: result.identity_sha256, sourceScriptSha256: result.source_script_sha256,
        generationPlanFileSha256: result.generation_plan.sha256,
        providerManifestFileSha256: result.provider_output_manifest.sha256,
        sourceArtifacts: fixture.openingFixture.result.finalized.phase_context.sourceArtifacts,
        preSynthesisGatePath: result.pre_synthesis_gate.path, preSynthesisGateFileSha256: result.pre_synthesis_gate.sha256,
        textIrPath: result.spoken_text_ir.path, textIrFileSha256: result.spoken_text_ir.sha256,
        spokenTextAuditPath: result.spoken_text_audit.path, spokenTextAuditFileSha256: result.spoken_text_audit.sha256,
        acceptedOpening: result.accepted_opening } });
    fixture.resultRef.sha256 = await writeJson(fixture.resultRef.path, result);
    const buildArgs = { priorResultRef: fixture.resultRef, priorResult: result, packetRef, packet,
      checkpointRef, checkpoint, rawAudioRef, reviewer: "synthetic-fixture-only reviewer",
      note: "Synthetic test data only; no human listened to this silent fixture.",
      attestation: PILOT_RAW_NARRATION_REVIEW_ATTESTATION, reviewedAt: "2026-01-01T00:00:00.000Z" };
    const { reviewReceipt, listenDecision } = await buildPilotRawNarrationReview(buildArgs);
    const reviewDir = path.join(root, "pilot_narration_work", "narration_review");
    await fs.mkdir(reviewDir);
    const receiptPath = path.join(reviewDir, "raw_listening_approval.json"), decisionPath = path.join(reviewDir, "exact_listen_decision.json");
    const reviewContinuation = { priorResult: fixture.resultRef,
      reviewReceipt: { path: receiptPath, sha256: await writeJson(receiptPath, reviewReceipt) },
      listenDecision: { path: decisionPath, sha256: await writeJson(decisionPath, listenDecision) },
      checkpoint: checkpointRef, rawAudio: rawAudioRef };
    return { ...fixture, pendingFixture: fixture, priorResult: result, priorResultRef: fixture.resultRef,
      rawAudioRef, checkpoint, checkpointRef, reviewReceipt, listenDecision, reviewContinuation, buildArgs };
  } catch (error) { await fixture.cleanup(); throw error; }
}

async function main() {
  const fixture = await buildPilotNarrationReviewFixture();
  const { root, identity, reviewContinuation, reviewReceipt, listenDecision, checkpoint,
    writeJson, buildArgs, rawAudioRef } = fixture;
  const verify = (value = reviewContinuation) => validatePilotNarrationReviewAuthorization({
    reviewContinuation: value, episodeDir: root, identity });
  let count = 0;
  try {
    const allowed = await verify();
    assert.equal(allowed.status, "authorized_technical_continuation_only");
    assert.equal(allowed.mastered_audio_listened, false);
    assert.equal(allowed.mastered_subjective_review_status, "pending");
    assert.equal(reviewReceipt.raw_stream_segments.length, fixture.plan.units.length);
    assert.deepEqual(reviewReceipt.reviewed_warning_unit_ids, fixture.packet.unit_ids);
    assert.equal(listenDecision.listening_attestation_mapping.original_unit_files_listened_in_isolation, false);
    assert.equal(listenDecision.listening_attestation_mapping.unplayed_source_tails_claimed_listened, false);
    for (const args of [{ attestation: "entire_proof_narration_listened_end_to_end" }, { reviewer: "" }, { note: "" }]) {
      await assert.rejects(buildPilotRawNarrationReview({ ...buildArgs, ...args })); count++;
    }
    for (const mutate of [
      (row) => { row.extra = {}; }, (row) => { delete row.checkpoint; },
      (row) => { row.rawAudio.extra = "not an exact artifact binding"; },
      (row) => { row.rawAudio.sha256 = "0".repeat(64); },
      (row) => { row.priorResult.sha256 = "0".repeat(64); },
      (row) => { row.reviewReceipt.path = row.listenDecision.path; },
    ]) { const changed = structuredClone(reviewContinuation); mutate(changed); await assert.rejects(verify(changed)); count++; }
    for (const [key, original, mutate] of [
      ["reviewReceipt", reviewReceipt, (row) => { row.mastered_audio_listened = true; }],
      ["reviewReceipt", reviewReceipt, (row) => { row.synthesis_authorized = true; }],
      ["reviewReceipt", reviewReceipt, (row) => { row.restitch_authorized = true; }],
      ["reviewReceipt", reviewReceipt, (row) => { row.mastered_subjective_review_status = "approved"; }],
      ["reviewReceipt", reviewReceipt, (row) => { row.raw_stream_segments.pop(); }],
      ["listenDecision", listenDecision, (row) => { row.listening_attestation_mapping.segments[0].raw_start_sample++; }],
      ["listenDecision", listenDecision, (row) => { row.listening_attestation_mapping.original_unit_files_listened_in_isolation = true; }],
      ["listenDecision", listenDecision, (row) => { row.listening_attestation_mapping.unplayed_source_tails_claimed_listened = true; }],
      ["checkpoint", checkpoint, (row) => { row.context.voice_sha256 = "0".repeat(64); }],
      ["checkpoint", checkpoint, (row) => { row.stages.semantic_stitch.input_key = "0".repeat(64); }],
      ["checkpoint", checkpoint, (row) => { row.stages.mastering = { status: "passed" }; }],
      ["checkpoint", checkpoint, (row) => { row.stages.semantic_stitch.payload.stitch.prepared_inputs[0].edge_edit_plan.fade_out_samples = 1; }],
      ["checkpoint", checkpoint, (row) => { row.stages.semantic_stitch.payload.stitch.prepared_inputs[0].trim_end_sample--; }],
      ["checkpoint", checkpoint, (row) => { row.stages.semantic_stitch.payload.stitch.prepared_inputs.reverse(); }],
      ["checkpoint", checkpoint, (row) => { row.units[fixture.plan.units[0].unit_id].delivery_row.edge_alignment.last_speech_sample_exclusive++; }],
    ]) {
      const value = structuredClone(original); mutate(value);
      if (key === "reviewReceipt") { delete value.review_sha256; value.review_sha256 = canonicalQwenBatchSha256(value); }
      if (key === "listenDecision") value.decision_sha256 = narrationExactListenReviewDecisionSha256(value);
      const changed = structuredClone(reviewContinuation);
      changed[key].sha256 = await writeJson(changed[key].path, value);
      await assert.rejects(verify(changed)); count++;
      await writeJson(reviewContinuation[key].path, original);
    }
    const originalRaw = await fs.readFile(rawAudioRef.path);
    const changedRaw = Buffer.from(originalRaw); changedRaw[44] ^= 1;
    await fs.writeFile(rawAudioRef.path, changedRaw);
    await assert.rejects(verify()); count++; await fs.writeFile(rawAudioRef.path, originalRaw);
    assert.equal((await verify()).status, "authorized_technical_continuation_only");
    const trimmed = await buildPilotNarrationReviewFixture({ tailTrimSamples: 240 });
    try {
      const approved = await validatePilotNarrationReviewAuthorization({ reviewContinuation: trimmed.reviewContinuation,
        episodeDir: trimmed.root, identity: trimmed.identity });
      assert.equal(approved.status, "authorized_technical_continuation_only");
      const segment = approved.listenDecision.listening_attestation_mapping.segments.at(-1);
      assert.equal(segment.unplayed_source_tail_samples, 240);
      assert.equal(segment.aligned_speech_fully_present, true);
      assert.equal(approved.listenDecision.listening_attestation_mapping.unplayed_source_tails_claimed_listened, false);
    } finally { await trimmed.cleanup(); }
    console.log(`Pilot raw-review authorization tests passed (${count} blocked mutations; synthetic PCM only, no models or actual listening).`);
  } finally { await fixture.cleanup(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
