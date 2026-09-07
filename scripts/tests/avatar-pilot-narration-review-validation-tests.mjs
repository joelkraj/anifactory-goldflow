import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildPilotNarrationValidationFixture } from "./avatar-pilot-narration-validation-tests.mjs";
import { validatePilotNarrationPendingReviewResult, validatePilotNarrationResult } from "../lib/avatar-pilot-narration-validation.mjs";
import { adjudicateNarrationDeliveryConsensus, exactNarrationListenReviewPacket, narrationExactListenReviewPacketSha256 } from "../lib/narration-delivery-quality.mjs";
import { localWhisperTimingCandidateSha256 } from "../lib/local-whisper-timing-candidate.mjs";
import { buildLocalWhisperTimingCandidate } from "../lib/local-whisper-timing-candidate.mjs";
import { buildNarrationSubjectiveReviewManifest, narrationSubjectiveReviewManifestSha256 } from "../lib/narration-subjective-review.mjs";
import { localWhisperContractForIdentity } from "../lib/local-whisper-policy.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Explicit synthetic first-take review fixture. The observations/QA are
 * structural test data, never a real narrated take or a human review claim. */
export async function buildPilotNarrationPendingReviewFixture({ fullFixture = null } = {}) {
  const fixture = fullFixture ?? await buildPilotNarrationValidationFixture();
  try {
    const { result, jsonValues, writeJson, plan, options, namespace, identity } = fixture;
    const originals = structuredClone(Object.fromEntries(jsonValues));
    const unitDelivery = structuredClone(originals.unit_delivery_qa);
    const target = unitDelivery.units.at(-1);
    const intendedWord = target.intended_text.split(/\s+/u)[2];
    const transcript = { ...target.transcript_qa, substitutions: 1, word_error_rate: 0.01,
      operations: [{ type: "substitution", intended: intendedWord, recognized: "fixturehomophone" }] };
    target.transcript_qa = transcript; target.confirmation_transcript_qa = structuredClone(transcript);
    target.primary_recognized_text = target.intended_text.replace(intendedWord, "fixturehomophone");
    target.confirmation_recognized_text = target.primary_recognized_text;
    target.decision = adjudicateNarrationDeliveryConsensus({ primaryTranscriptQa: transcript, confirmationTranscriptQa: transcript,
      contract: options.policy.narration_quality_contract, orderQa: { blockers: [] }, joinQa: { blockers: [], warnings: [] } });
    assert.equal(target.decision.status, "passed_with_warnings");
    const packet = exactNarrationListenReviewPacket({ rows: unitDelivery.units, generationPlanSha256: plan.plan_sha256,
      generationPlanFileSha256: result.generation_plan.sha256, qualityContractSha256: options.policy.narration_quality_contract.contract_sha256 });
    assert.equal(packet.item_count, 1);
    unitDelivery.status = "passed_with_warnings"; unitDelivery.listen_review_unit_count = packet.item_count;
    const packetPath = path.join(namespace, `narration_exact_listen_review_packet_${identity.episode}.json`);
    const packetRef = { path: packetPath, sha256: await writeJson(packetPath, packet) };
    const unitQa = structuredClone(originals.unit_qa); unitQa.status = "passed_with_warnings";
    unitQa.selected_units.at(-1).qa_status = "passed_with_warnings";
    unitQa.selected_units.at(-1).qa.delivery = target.decision;
    const deferred = { status: "deferred_until_delivery_acceptance", reason: "Exact listen items must be approved before mastering." };
    const audio = result.finalization_artifacts.audio;
    const stitch = { ...structuredClone(originals.stitch_report), mastering: deferred,
      raw_output_path: audio.path, raw_output_sha256: audio.sha256,
      subjective_review_manifest_path: null, subjective_review_manifest_sha256: null };
    const tts = { ...structuredClone(originals.tts_report), status: "passed_with_warnings", mastering: deferred,
      listen_review_status: "pending", listen_review_packet_path: packetPath, listen_review_packet_sha256: packet.packet_sha256,
      subjective_review_status: "not_required_or_not_materialized", subjective_review_manifest_path: null, subjective_review_manifest_sha256: null,
      subjective_review_waiver: null, manual_review_evidence_path: null,
      raw_wav: audio.path, raw_wav_sha256: audio.sha256, final_wav: audio.path, final_wav_sha256: audio.sha256 };
    tts.results.at(-1).qa_status = "passed_with_warnings"; tts.results.at(-1).selected_qa = unitQa.selected_units.at(-1).qa;
    async function store(key, value) {
      jsonValues.set(key, structuredClone(value));
      result.finalization_artifacts[key].sha256 = await writeJson(result.finalization_artifacts[key].path, value);
    }
    await store("unit_delivery_qa", unitDelivery); await store("unit_qa", unitQa); await store("stitch_report", stitch); await store("tts_report", tts);
    const timing = structuredClone(originals.timing_candidate);
    timing.narration_report_sha256 = result.finalization_artifacts.stitch_report.sha256;
    timing.candidate_sha256 = localWhisperTimingCandidateSha256(timing); await store("timing_candidate", timing);
    const subjectiveRef = result.finalization_artifacts.subjective_manifest;
    delete result.finalization_artifacts.subjective_manifest;
    // Retain the former fixture artifact only as unrelated test data. It is not
    // bound by the pending result and no production file is ever removed.
    result.finalized = { status: "passed_with_warnings", unit_count: plan.units.length, delivery_accepted: false,
      delivery_blocker_count: 0, listen_review_unit_count: packet.item_count, mastering_status: deferred.status,
      exact_sample_accounting: true, subjective_review_status: "not_materialized_due_to_delivery_review",
      subjective_review_manifest_path: null, subjective_review_sample_count: 0,
      raw_wav: audio.path, raw_wav_sha256: audio.sha256, final_wav: audio.path, final_wav_sha256: audio.sha256,
      listen_review_packet_path: packetPath };
    const resultPath = path.join(fixture.root, "pilot_narration_work", "narration_producer_result.json");
    const resultRef = { path: resultPath, sha256: await writeJson(resultPath, result) };
    return { ...fixture, packet, packetRef, resultRef, subjectiveRef, store, originalCompleteArtifacts: originals };
  } catch (error) { await fixture.cleanup(); throw error; }
}

/** A synthetic reviewed technical continuation, never a mastered-audio listening
 * approval. The genuine structural review authorizer is not mocked. */
export async function buildPilotNarrationReviewedValidationFixture({ reviewFixture = null } = {}) {
  const review = reviewFixture ?? await (await import("./avatar-pilot-narration-review-tests.mjs")).buildPilotNarrationReviewFixture();
  const pending = review.pendingFixture;
  try {
    const { validatePilotNarrationReviewAuthorization } = await import("../lib/avatar-pilot-narration-review.mjs");
    const { root, identity, plan, options, writeJson } = pending;
    const authorized = await validatePilotNarrationReviewAuthorization({ reviewContinuation: review.reviewContinuation, episodeDir: root, identity });
    const prior = authorized.priorResult;
    const rawAudio = review.reviewContinuation.rawAudio;
    const namespace = path.join(root, "pilot_narration_work", "full_finalization_reviewed");
    await fs.mkdir(namespace);
    const audioPath = path.join(namespace, "fixture-only-reviewed-master.wav");
    // Test-only PCM copy stands in for mastering. No model/acoustic/listening
    // claim is made; the production path must use the canonical finalizer.
    await fs.copyFile(rawAudio.path, audioPath);
    const audioRef = { path: audioPath, sha256: hash(await fs.readFile(audioPath)) };
    const result = { ...structuredClone(prior), review_continuation: structuredClone(review.reviewContinuation),
      finalization_artifacts: { audio: audioRef }, subjective_approval: null };
    const jsonValues = new Map();
    const readArtifact = async (key) => JSON.parse(await fs.readFile(prior.finalization_artifacts[key].path, "utf8"));
    const scope = { ...(await readArtifact("stitch_report")).finalization_scope, review_continuation: structuredClone(review.reviewContinuation) };
    async function store(key, value) {
      const file = path.join(namespace, `${key}.json`);
      jsonValues.set(key, structuredClone(value));
      result.finalization_artifacts[key] = { path: file, sha256: await writeJson(file, value) };
      return result.finalization_artifacts[key];
    }
    const continuity = await readArtifact("voice_continuity"), continuityRef = await store("voice_continuity", continuity);
    const unitDelivery = await readArtifact("unit_delivery_qa");
    unitDelivery.voice_continuity_report_path = continuityRef.path; unitDelivery.voice_continuity_report_sha256 = continuityRef.sha256;
    await store("unit_delivery_qa", unitDelivery); await store("unit_qa", await readArtifact("unit_qa"));
    const priorStitch = await readArtifact("stitch_report");
    const duration = priorStitch.final_duration_sec;
    const mastering = { ...structuredClone(pending.originalCompleteArtifacts.stitch_report.mastering),
      input_path: rawAudio.path, input_sha256: rawAudio.sha256, output_path: audioPath, output_sha256: audioRef.sha256 };
    mastering.output_probe.duration_sec = duration;
    const stitch = { ...priorStitch, finalization_scope: scope, output_path: audioPath, final_wav_path: audioPath,
      output_sha256: audioRef.sha256, final_wav_sha256: audioRef.sha256, mastering };
    let stitchRef = await store("stitch_report", stitch);
    const delivery = { ...await readArtifact("full_stream_qa"), finalization_scope: scope, audio_path: audioPath, audio_sha256: audioRef.sha256 };
    await store("full_stream_qa", delivery);
    const subjective = buildNarrationSubjectiveReviewManifest({ plan,
      stitch: authorized.checkpoint.stages.semantic_stitch.payload.stitch,
      audioPath, audioSha256: audioRef.sha256, generationPlanSha256: plan.plan_sha256,
      generationPlanFileSha256: result.generation_plan.sha256, qualityContractSha256: options.policy.narration_quality_contract.contract_sha256 });
    subjective.finalization_scope = scope; subjective.manifest_sha256 = narrationSubjectiveReviewManifestSha256(subjective);
    const subjectiveRef = await store("subjective_manifest", subjective);
    stitch.subjective_review_manifest_path = subjectiveRef.path;
    stitch.subjective_review_manifest_sha256 = subjective.manifest_sha256;
    stitchRef = await store("stitch_report", stitch);
    const timing = buildLocalWhisperTimingCandidate({ transcription: { words: delivery.primary_recognized_words,
      text: delivery.primary_recognized_text, duration_sec: duration, language: "en", language_probability: 1 },
      contract: localWhisperContractForIdentity(identity), sourceScriptPath: identity.source_script.path,
      sourceScriptSha256: result.source_script_sha256, narrationAudioPath: audioPath, narrationAudioSha256: audioRef.sha256,
      narrationReportPath: stitchRef.path, narrationReportSha256: stitchRef.sha256,
      runIdentityPath: path.join(root, "run_identity.json"), runIdentitySha256: result.identity_sha256,
      narrationQualityContractSha256: options.policy.narration_quality_contract.contract_sha256 });
    timing.finalization_scope = scope; timing.candidate_sha256 = localWhisperTimingCandidateSha256(timing);
    await store("timing_candidate", timing);
    const packetPath = path.join(namespace, `narration_exact_listen_review_packet_${identity.episode}.json`);
    await writeJson(packetPath, pending.packet);
    const tts = { ...await readArtifact("tts_report"), finalization_scope: scope, mastering, listen_review_status: "approved",
      listen_review_packet_path: packetPath,
      final_wav: audioPath, final_wav_sha256: audioRef.sha256,
      voice_continuity_report_path: continuityRef.path, voice_continuity_report_sha256: continuityRef.sha256,
      subjective_review_status: "pending", subjective_review_manifest_path: subjectiveRef.path,
      subjective_review_manifest_sha256: subjective.manifest_sha256 };
    await store("tts_report", tts);
    result.finalized = { ...prior.finalized, phase_context: { ...prior.finalized.phase_context,
      outputNamespace: namespace, reviewContinuation: result.review_continuation },
      finalization_scope: scope, delivery_accepted: true, mastering_status: "passed",
      final_wav: audioPath, final_wav_sha256: audioRef.sha256, subjective_review_status: "pending",
      listen_review_packet_path: packetPath,
      subjective_review_manifest_path: subjectiveRef.path, subjective_review_sample_count: subjective.sample_count };
    const resultPath = path.join(root, "pilot_narration_work", "narration_reviewed_result.json");
    const resultRef = { path: resultPath, sha256: await writeJson(resultPath, result) };
    return { ...pending, pendingFixture: pending, reviewFixture: review, reviewContinuation: result.review_continuation,
      priorResult: prior, result, resultRef, namespace, jsonValues, audioPath, audioRef, store };
  } catch (error) { await pending.cleanup(); throw error; }
}

async function main() {
  const fixture = await buildPilotNarrationPendingReviewFixture();
  const { result, root, identity, packet, packetRef, jsonValues, writeJson, originals } = fixture;
  const verify = (value = result) => validatePilotNarrationPendingReviewResult(value, { episodeDir: root, identity });
  let count = 0;
  try {
    const pending = await verify();
    assert.equal(pending.status, "pending_delivery_review", JSON.stringify(pending.findings));
    assert.equal(pending.mastering_status, "deferred_until_delivery_acceptance");
    assert.equal(pending.official_full_narration_timing, false); assert.equal(pending.delivery_accepted, false);
    assert.deepEqual(pending.listen_review_packet, packetRef); assert.deepEqual(pending.listen_review_unit_ids, packet.unit_ids);
    assert.equal((await validatePilotNarrationResult(result, { episodeDir: root, identity })).status, "blocked",
      "raw pending take must never be completed narration");
    for (const mutate of [
      (row) => { row.unit_ids.pop(); }, (row) => { row.subjective_approval = { status: "approved" }; },
      (row) => { row.finalized.delivery_accepted = true; }, (row) => { row.finalized.delivery_blocker_count = 1; },
      (row) => { row.finalized.mastering_status = "passed"; },
      (row) => { row.finalization_artifacts.subjective_manifest = fixture.subjectiveRef; },
      (row) => { row.finalized.listen_review_unit_count = 0; },
      (row) => { row.finalized.raw_wav_sha256 = "0".repeat(64); },
      (row) => { row.review_continuation = {}; },
    ]) { const changed = structuredClone(result); mutate(changed); assert.equal((await verify(changed)).status, "blocked"); count++; }
    for (const [key, mutate] of [
      ["tts_report", (row) => { row.mastering.status = "diagnostic_disabled"; }],
      ["tts_report", (row) => { row.listen_review_status = "approved"; }],
      ["tts_report", (row) => { row.post_tempo_normalized = true; }],
      ["unit_delivery_qa", (row) => { row.units.at(-1).decision.blockers.push({ code: "fixture_hard_blocker" }); }],
      ["unit_delivery_qa", (row) => { row.units.at(-1).decision.warnings = []; }],
      ["unit_delivery_qa", (row) => { row.units.at(-1).audio_path = "/fixture/not-original.wav"; }],
      ["full_stream_qa", (row) => { row.decision.blockers.push({ code: "fixture_hard_blocker" }); }],
      ["full_stream_qa", (row) => { row.primary_model = "medium"; }],
    ]) {
      const changed = structuredClone(result), value = structuredClone(jsonValues.get(key)); mutate(value);
      changed.finalization_artifacts[key].sha256 = await writeJson(changed.finalization_artifacts[key].path, value);
      assert.equal((await verify(changed)).status, "blocked"); count++;
      await writeJson(result.finalization_artifacts[key].path, jsonValues.get(key));
    }
    for (const mutate of [
      (row) => { row.items[0].audio_sha256 = "0".repeat(64); },
      (row) => { row.items[0].warnings[0].code = "invented_warning"; },
      (row) => { row.items = []; row.item_count = 0; row.unit_ids = []; },
    ]) {
      const changed = structuredClone(packet); mutate(changed); changed.packet_sha256 = narrationExactListenReviewPacketSha256(changed);
      await writeJson(packetRef.path, changed); assert.equal((await verify()).status, "blocked"); count++;
      await writeJson(packetRef.path, packet);
    }
    const originalUnit = await fs.readFile(originals[0].output_path);
    await fs.appendFile(originals[0].output_path, "fixture raw unit mutation");
    assert.equal((await verify()).status, "blocked"); count++; await fs.writeFile(originals[0].output_path, originalUnit);
    assert.equal((await verify()).status, "pending_delivery_review");
    console.log(`Pilot pending-review validation tests passed (${count} blocked mutations; synthetic evidence only, no models or real listening).`);
  } finally { await fixture.cleanup(); }
  const reviewed = await buildPilotNarrationReviewedValidationFixture();
  const validateReviewed = (value = reviewed.result) => validatePilotNarrationResult(value, { episodeDir: reviewed.root, identity: reviewed.identity });
  let reviewedCount = 0;
  try {
    const technical = await validateReviewed();
    assert.equal(technical.status, "passed", JSON.stringify(technical.findings));
    assert.equal(technical.subjective_review_status, "pending"); assert.equal(technical.official_full_narration_timing, false);
    assert.equal((await validatePilotNarrationPendingReviewResult(reviewed.result, { episodeDir: reviewed.root, identity: reviewed.identity })).status, "blocked");
    for (const mutate of [
      (row) => { row.review_continuation.reviewReceipt.sha256 = "0".repeat(64); },
      (row) => { delete row.review_continuation.rawAudio; },
      (row) => { row.source_script_sha256 = "0".repeat(64); },
      (row) => { row.generation_plan = { ...row.generation_plan, sha256: "0".repeat(64) }; },
      (row) => { row.finalization_artifacts.audio = reviewed.pendingFixture.result.finalization_artifacts.audio; },
      (row) => { row.subjective_approval = { status: "approved" }; },
      (row) => { delete row.review_continuation; },
    ]) {
      const changed = structuredClone(reviewed.result); mutate(changed);
      assert.equal((await validateReviewed(changed)).status, "blocked"); reviewedCount++;
    }
    for (const [key, mutate] of [
      ["tts_report", (row) => { row.raw_wav = reviewed.audioPath; }],
      ["stitch_report", (row) => { row.raw_output_sha256 = "0".repeat(64); }],
      ["tts_report", (row) => { row.mastering.status = "deferred_until_delivery_acceptance"; }],
      ["full_stream_qa", (row) => { delete row.finalization_scope.review_continuation; }],
      ["subjective_manifest", (row) => { row.status = "approved"; row.manifest_sha256 = narrationSubjectiveReviewManifestSha256(row); }],
    ]) {
      const value = structuredClone(reviewed.jsonValues.get(key)); mutate(value);
      const changed = structuredClone(reviewed.result);
      changed.finalization_artifacts[key].sha256 = await reviewed.writeJson(changed.finalization_artifacts[key].path, value);
      assert.equal((await validateReviewed(changed)).status, "blocked", `Reviewed receipt mutation ${key}`); reviewedCount++;
      await reviewed.writeJson(reviewed.result.finalization_artifacts[key].path, reviewed.jsonValues.get(key));
    }
    const originalAudio = await fs.readFile(reviewed.audioPath);
    await fs.appendFile(reviewed.audioPath, "changed fixture master");
    assert.equal((await validateReviewed()).status, "blocked"); reviewedCount++; await fs.writeFile(reviewed.audioPath, originalAudio);
    assert.equal((await validateReviewed()).status, "passed");
    assert.equal((await validatePilotNarrationPendingReviewResult(reviewed.priorResult, { episodeDir: reviewed.root, identity: reviewed.identity })).status,
      "pending_delivery_review", "reviewed candidate never overwrites prior raw evidence");
    console.log(`Pilot reviewed technical validation tests passed (${reviewedCount} blocked mutations; final master listening remains pending).`);
  } finally { await reviewed.cleanup(); }
}
// Finish module evaluation before dynamically loading the review-fixture module,
// which imports this module's pending builder. Imported fixtures remain inert.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
