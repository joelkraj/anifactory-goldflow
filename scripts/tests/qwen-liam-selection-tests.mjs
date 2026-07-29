import assert from "node:assert/strict";
import {
  candidateDisposition,
  softenPrimaryQa,
  voiceContinuityDecision,
} from "../lib/tts-selection-policy.mjs";
import {
  validateConfirmedRetryEvidenceForTests,
} from "../narration-tts-episode.mjs";

function blockedQa(code) {
  return {
    status: "blocked",
    findings: [{ severity: "blocker", code }],
  };
}

function testHardFailuresAreNotSoftenedOrBlindlyRetried() {
  const continuity = voiceContinuityDecision({
    status: "passed",
    audio_sha256: "audio-a",
    reference_voice_id: "am_liam",
    reference_voice_sha256: "voice-a",
    similarity_model_sha256: "model-a",
    cosine_similarity: 0.5,
    minimum_cosine_similarity: 0.88,
    warning_below_cosine_similarity: 0.9,
  }, {
    audioSha256: "audio-a",
    referenceVoiceSha256: "voice-a",
    similarityModelSha256: "model-a",
  });
  const softenedContinuity = softenPrimaryQa(continuity);
  assert.equal(softenedContinuity.status, "blocked");
  assert.equal(
    candidateDisposition(softenedContinuity, "qwen_local").status,
    "blocked_manual_review",
  );

  for (const code of [
    "tts_primary_voice_continuity_qa_missing",
    "tts_audio_endpoint_discontinuity",
    "tts_audio_tail_not_settled",
    "tts_audio_clipping",
    "tts_audio_impulsive_discontinuity",
    "tts_audio_duration_too_long_for_text",
  ]) {
    const qa = softenPrimaryQa(blockedQa(code));
    assert.equal(qa.status, "blocked", code);
    assert.equal(
      candidateDisposition(qa, "qwen_local").status,
      "blocked_manual_review",
      code,
    );
  }

  const asrOnly = softenPrimaryQa(blockedQa("tts_transcript_final_word_missing"));
  assert.equal(asrOnly.status, "passed_with_warnings");
  assert.equal(candidateDisposition(asrOnly, "qwen_local").status, "accepted_primary");

  for (const code of [
    "tts_synthesis_job_failed",
    "tts_audio_empty",
    "tts_audio_implausibly_short",
    "tts_audio_duration_too_short_for_text",
  ]) {
    const qa = softenPrimaryQa(blockedQa(code));
    assert.equal(qa.status, "blocked", code);
    assert.equal(
      candidateDisposition(qa, "qwen_local").status,
      "confirmed_retry_required",
      code,
    );
  }
}

function testConfirmedRetryEvidenceBindsExactListenedArtifact() {
  const planSha256 = "plan-sha";
  const reportSha256 = "report-sha";
  const priorReport = {
    results: [{
      unit_id: "unit_001",
      attempt: 1,
      audio_sha256: "audio-sha",
      synthesis_identity_sha256: "synthesis-sha",
    }],
  };
  const currentCandidates = [{
    unit_id: "unit_001",
    attempt: 1,
    audio_sha256: "audio-sha",
    synthesis_identity_sha256: "synthesis-sha",
  }];
  const evidence = {
    narration_generation_plan_sha256: planSha256,
    pre_retry_narration_report_sha256: reportSha256,
    confirmed_units: [{
      unit_id: "unit_001",
      defect_type: "stutter",
      listen_note: "Repeated the final word twice.",
      selected_attempt: 1,
      audio_sha256: "audio-sha",
      synthesis_identity_sha256: "synthesis-sha",
    }],
  };
  assert.deepEqual(validateConfirmedRetryEvidenceForTests({
    evidence,
    requestedUnitIds: ["unit_001"],
    planSha256,
    priorReport,
    priorReportSha256: reportSha256,
    currentCandidates,
  }), [{
    unit_id: "unit_001",
    defect_type: "stutter",
    selected_attempt: 1,
    audio_sha256: "audio-sha",
    synthesis_identity_sha256: "synthesis-sha",
  }]);

  assert.throws(() => validateConfirmedRetryEvidenceForTests({
    evidence: {
      ...evidence,
      confirmed_units: [{
        ...evidence.confirmed_units[0],
        audio_sha256: "stale-audio",
      }],
    },
    requestedUnitIds: ["unit_001"],
    planSha256,
    priorReport,
    priorReportSha256: reportSha256,
    currentCandidates,
  }), /evidence is stale/i);

  assert.throws(() => validateConfirmedRetryEvidenceForTests({
    evidence,
    requestedUnitIds: ["unit_001"],
    planSha256,
    priorReport,
    priorReportSha256: reportSha256,
    currentCandidates: [{
      ...currentCandidates[0],
      synthesis_identity_sha256: "changed-synthesis",
    }],
  }), /does not match the listened pre-retry artifact/i);
}

testHardFailuresAreNotSoftenedOrBlindlyRetried();
testConfirmedRetryEvidenceBindsExactListenedArtifact();
