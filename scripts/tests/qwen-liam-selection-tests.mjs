import assert from "node:assert/strict";
import {
  candidateDisposition,
  fullStreamDecision,
  isTtsStructuralHardStopCode,
  softenPrimaryQa,
  voiceContinuityDecision,
} from "../lib/tts-selection-policy.mjs";
import {
  audioQaFindingsForTests,
  stitchBoundaryPaddingForTests,
  stitchEffectiveBoundaryContractForTests,
  stitchTargetGapSecForTests,
} from "../modelslab-qwen-episode-audio.mjs";
import {
  adjudicateManualReviewQaForTests,
  joinQaFromPcmForTests,
  preservedTtsSelectionsForTests,
  validateConfirmedRetryEvidenceForTests,
  validateManualReviewEvidenceForTests,
  validateManualStitchRecoveryForTests,
} from "../narration-tts-episode.mjs";

function blockedQa(code) {
  return {
    status: "blocked",
    findings: [{ severity: "blocker", code }],
  };
}

function testAutomatedQaWarnsWhileStructuralFailuresRemainHard() {
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
  assert.equal(softenedContinuity.status, "passed_with_warnings");
  assert.equal(
    softenedContinuity.findings.every((finding) => (
      finding.severity === "warning"
      && finding.disposition_policy === "automated_tts_qa_review_warning"
      && finding.automatic_retry_allowed === false
      && finding.blocks_stitching === false
    )),
    true,
  );
  assert.equal(
    candidateDisposition(softenedContinuity, "qwen_local").status,
    "accepted_primary",
  );

  for (const code of [
    "tts_primary_voice_continuity_qa_missing",
    "tts_audio_endpoint_discontinuity",
    "tts_audio_tail_not_settled",
    "tts_audio_clipping",
    "tts_audio_impulsive_discontinuity",
    "tts_audio_duration_too_long_for_text",
    "tts_audio_implausibly_short",
    "tts_audio_duration_too_short_for_text",
    "tts_transcript_final_word_missing",
  ]) {
    const qa = softenPrimaryQa(blockedQa(code));
    assert.equal(qa.status, "passed_with_warnings", code);
    assert.equal(qa.findings[0].severity, "warning", code);
    assert.equal(
      candidateDisposition(qa, "qwen_local").status,
      "accepted_primary",
      code,
    );
  }

  for (const code of [
    "tts_synthesis_job_failed",
    "tts_batch_synthesis_failed",
    "tts_batch_token_limit_reached",
    "tts_serial_synthesis_failed",
    "tts_serial_token_limit_reached",
    "tts_audio_missing",
    "tts_audio_unreadable",
    "tts_audio_empty",
    "tts_audio_corrupt",
  ]) {
    assert.equal(isTtsStructuralHardStopCode(code), true, code);
    const qa = softenPrimaryQa(blockedQa(code));
    assert.equal(qa.status, "blocked", code);
    assert.equal(
      candidateDisposition(qa, "qwen_local").status,
      "exact_unit_repair_required",
      code,
    );
  }

  const nondeterministicCache = softenPrimaryQa(
    blockedQa("tts_batch_cache_nondeterminism"),
  );
  assert.equal(nondeterministicCache.status, "blocked");
  assert.equal(
    candidateDisposition(nondeterministicCache, "qwen_local").status,
    "blocked_manual_review",
  );

  const acousticFindings = audioQaFindingsForTests({
    sample_count: 2400,
    duration_sec: 0.1,
    clipping_ratio: 0.01,
    clipping_sample_count: 24,
    peak_dbfs: 0,
    isolated_impulse_count: 1,
    maximum_isolated_impulse_dbfs: -2,
    maximum_sample_step_dbfs: -2,
    large_sample_step_count: 1,
    last_sample_dbfs: -2,
    trailing_silence_sec: 0,
    tail_10ms_peak_dbfs: -2,
    tail_50ms_rms_dbfs: -2,
    leading_silence_sec: 0,
    rms_dbfs: -6,
  }, {
    text: "one two three four five six seven eight nine ten",
    word_count: 10,
  });
  assert.equal(
    acousticFindings.some((finding) => finding.severity === "blocker"),
    false,
  );
  assert.equal(
    acousticFindings.some(
      (finding) => finding.code === "tts_audio_duration_too_short_for_text",
    ),
    true,
  );

  const asrOnlyStream = fullStreamDecision({
    leading_deletion_run: 1,
    trailing_deletion_run: 1,
    longest_deletion_run: 4,
    longest_insertion_run: 3,
    deletions: 4,
    insertions: 3,
    word_error_rate: 0.5,
    findings: [{
      severity: "blocker",
      code: "tts_transcript_contiguous_words_missing",
    }],
  }, {
    orderQa: { blockers: [] },
    joinQa: { blockers: [], warnings: [] },
  });
  assert.equal(asrOnlyStream.status, "passed");
  assert.equal(asrOnlyStream.blockers.length, 0);
  assert.equal(
    asrOnlyStream.warnings.every(
      (finding) => finding.blocks_stitching === false,
    ),
    true,
  );
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

  const secondAttemptReport = {
    results: [{
      unit_id: "unit_001",
      attempt: 2,
      audio_sha256: "audio-sha-2",
      synthesis_identity_sha256: "synthesis-sha-2",
    }],
  };
  assert.deepEqual(validateConfirmedRetryEvidenceForTests({
    evidence: {
      ...evidence,
      confirmed_units: [{
        ...evidence.confirmed_units[0],
        selected_attempt: 2,
        audio_sha256: "audio-sha-2",
        synthesis_identity_sha256: "synthesis-sha-2",
      }],
    },
    requestedUnitIds: ["unit_001"],
    planSha256,
    priorReport: secondAttemptReport,
    priorReportSha256: reportSha256,
    currentCandidates: [
      currentCandidates[0],
      {
        unit_id: "unit_001",
        attempt: 2,
        audio_sha256: "audio-sha-2",
        synthesis_identity_sha256: "synthesis-sha-2",
      },
    ],
  }), [{
    unit_id: "unit_001",
    defect_type: "stutter",
    selected_attempt: 2,
    audio_sha256: "audio-sha-2",
    synthesis_identity_sha256: "synthesis-sha-2",
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
  }), /does not match the reviewed pre-retry artifact/i);
}

function testConfirmedRetryKeepsBlockedSelectionOnlyAsExactOrigin() {
  const planSha256 = "plan-sha";
  const planFileSha256 = "plan-file-sha";
  const policy = {
    primary: {
      provider: "qwen_local",
      model_id: "qwen-model",
      voice_id: "liam",
      voice_sha256: "voice-sha",
      voice_continuity_contract: "voice-contract",
    },
  };
  const units = [
    { unit_id: "unit_001", spoken_text_sha256: "text-sha-1" },
    { unit_id: "unit_002", spoken_text_sha256: "text-sha-2" },
  ];
  const selection = (unit, { attempt, audioSha256, qa }) => ({
    unit_id: unit.unit_id,
    attempt,
    provider: policy.primary.provider,
    model_id: policy.primary.model_id,
    voice_id: policy.primary.voice_id,
    voice_sha256: policy.primary.voice_sha256,
    voice_continuity_contract: policy.primary.voice_continuity_contract,
    spoken_text_sha256: unit.spoken_text_sha256,
    synthesis_identity_sha256: `synthesis-${unit.unit_id}-${attempt}`,
    audio_path: `/fixture/${unit.unit_id}-attempt-${attempt}.wav`,
    audio_sha256: audioSha256,
    selected_qa: qa,
  });
  const accepted = { status: "passed", findings: [] };
  const blocked = blockedQa("tts_audio_empty");
  const results = [
    selection(units[0], { attempt: 1, audioSha256: "audio-1", qa: accepted }),
    selection(units[1], { attempt: 2, audioSha256: "audio-2", qa: blocked }),
  ];
  const priorReport = {
    narration_generation_plan_sha256: planSha256,
    narration_generation_plan_file_sha256: planFileSha256,
    results,
  };
  const priorUnitQa = {
    narration_generation_plan_sha256: planSha256,
    narration_generation_plan_file_sha256: planFileSha256,
    selected_units: results.map((result) => ({
      ...result,
      qa: result.selected_qa,
    })),
  };
  const exactRetry = preservedTtsSelectionsForTests({
    units,
    priorReport,
    priorUnitQa,
    policy,
    canonicalPlanSha256: planSha256,
    planFileSha256,
    requestedUnitIds: ["unit_002"],
    requireAllUnrequested: true,
  });
  assert.equal(exactRetry.status, "passed");
  assert.deepEqual(exactRetry.preserved_unit_ids, ["unit_001"]);
  assert.deepEqual(exactRetry.retry_origin_unit_ids, ["unit_002"]);
  assert.deepEqual(
    exactRetry.rows.map((row) => row.unit.unit_id),
    ["unit_001", "unit_002"],
  );

  const unscopedReuse = preservedTtsSelectionsForTests({
    units,
    priorReport,
    priorUnitQa,
    policy,
    canonicalPlanSha256: planSha256,
    planFileSha256,
    requireAllUnrequested: true,
  });
  assert.equal(unscopedReuse.status, "blocked");
  assert.ok(unscopedReuse.findings.some((finding) => (
    finding.code === "preserved_tts_selection_missing_or_stale"
    && finding.unit_id === "unit_002"
  )));
}

function manualReviewFixture(blockerCodes = ["tts_audio_tail_not_settled"]) {
  const qa = {
    status: "blocked",
    audio_sha256: "audio-sha",
    findings: blockerCodes.map((code) => ({ severity: "blocker", code })),
    delivery_first_gate: { hard_blocker_codes: blockerCodes },
  };
  const candidate = {
    unit_id: "unit_001",
    provider: "qwen_local",
    model_id: "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit",
    voice_id: "am_liam",
    attempt: 1,
    spoken_text_sha256: "text-sha",
    synthesis_identity_sha256: "synthesis-sha",
    audio_path: "/tmp/unit_001.wav",
    audio_sha256: "audio-sha",
    duration_sec: 3.5,
    qa,
    disposition: {
      status: "blocked_manual_review",
      accepted: false,
      blocker_codes: blockerCodes,
    },
  };
  const priorReport = {
    status: "blocked",
    narration_generation_plan_sha256: "plan-sha",
  };
  const priorUnitQa = {
    status: "blocked",
    narration_generation_plan_sha256: "plan-sha",
    candidates: [candidate],
    selected_units: [],
  };
  const evidence = {
    schema: "goldflow_narration_tts_manual_review_v1",
    status: "approved",
    reviewer: "operator",
    note: "Exact first take was heard and accepted.",
    reviewed_at: "2026-07-29T00:00:00.000Z",
    narration_generation_plan_sha256: "plan-sha",
    pre_review_narration_report_sha256: "report-sha",
    pre_review_unit_qa_sha256: "unit-qa-sha",
    accepted_unit_count: 1,
    accepted_units: [{
      unit_id: "unit_001",
      decision: "accept_first_take",
      provider: "qwen_local",
      attempt: 1,
      audio_path: "/tmp/unit_001.wav",
      audio_sha256: "audio-sha",
      synthesis_identity_sha256: "synthesis-sha",
      reviewed_blocker_codes: blockerCodes,
      listen_note: "Complete, smooth, correct voice, and clean endpoint.",
      audible_review: {
        speech_complete: true,
        no_skip: true,
        no_truncation: true,
        no_stutter: true,
        voice_identity_acceptable: true,
        endpoint_acceptable: true,
      },
    }],
  };
  return {
    qa,
    candidate,
    priorReport,
    priorUnitQa,
    evidence,
    args: {
      planSha256: "plan-sha",
      preReviewNarrationReport: priorReport,
      preReviewNarrationReportSha256: "report-sha",
      preReviewUnitQa: priorUnitQa,
      preReviewUnitQaSha256: "unit-qa-sha",
    },
  };
}

function testManualAcceptanceIsExactHashBoundAndPreservesFindings() {
  const fixture = manualReviewFixture([
    "tts_primary_voice_continuity_not_passed",
    "tts_primary_voice_similarity_below_minimum",
  ]);
  const validated = validateManualReviewEvidenceForTests({
    evidence: fixture.evidence,
    ...fixture.args,
  });
  assert.equal(validated.accepted_units.length, 1);
  assert.equal(validated.accepted_units[0].candidate, fixture.candidate);

  const adjudicated = adjudicateManualReviewQaForTests(fixture.qa, {
    reviewer: validated.reviewer,
    reviewedAt: validated.reviewed_at,
    listenNote: validated.accepted_units[0].listen_note,
    reviewedBlockerCodes: validated.accepted_units[0].reviewed_blocker_codes,
    evidencePath: "/episode/manual-review.json",
    evidenceSha256: "evidence-sha",
    preReviewNarrationReportPath: "/archive/report.json",
    preReviewNarrationReportSha256: "report-sha",
    preReviewUnitQaPath: "/archive/unit-qa.json",
    preReviewUnitQaSha256: "unit-qa-sha",
  });
  assert.equal(adjudicated.status, "passed_with_warnings");
  assert.equal(
    adjudicated.findings.every((finding) => (
      finding.severity === "warning"
      && finding.original_severity === "blocker"
      && finding.disposition_policy === "hash_bound_manual_accept_first_take"
    )),
    true,
  );
  assert.deepEqual(
    adjudicated.manual_review_disposition.reviewed_blocker_codes,
    fixture.evidence.accepted_units[0].reviewed_blocker_codes.slice().sort(),
  );

  for (const stale of [
    { narration_generation_plan_sha256: "stale-plan" },
    { pre_review_narration_report_sha256: "stale-report" },
    { pre_review_unit_qa_sha256: "stale-unit-qa" },
  ]) {
    assert.throws(() => validateManualReviewEvidenceForTests({
      evidence: { ...fixture.evidence, ...stale },
      ...fixture.args,
    }), /not bound/i);
  }
  assert.throws(() => validateManualReviewEvidenceForTests({
    evidence: {
      ...fixture.evidence,
      accepted_units: [{
        ...fixture.evidence.accepted_units[0],
        reviewed_blocker_codes: ["tts_audio_endpoint_discontinuity"],
      }],
    },
    ...fixture.args,
  }), /exact current blocker codes/i);
}

function testManualAcceptanceCannotWaiveAutomaticRetryCandidates() {
  const fixture = manualReviewFixture([
    "tts_audio_empty",
    "tts_audio_tail_not_settled",
  ]);
  assert.throws(() => validateManualReviewEvidenceForTests({
    evidence: fixture.evidence,
    ...fixture.args,
  }), /cannot waive a structural .* synthesis result/i);
}

function testManualTailRepairAndRenderedAsrSkipAreStrictlyScoped() {
  const fixture = manualReviewFixture(["tts_audio_tail_not_settled"]);
  const validatedReview = validateManualReviewEvidenceForTests({
    evidence: fixture.evidence,
    ...fixture.args,
  });
  assert.deepEqual(validateManualStitchRecoveryForTests({
    manualReviewEvidencePath: "/episode/manual-review.json",
    repairTailUnitIds: ["unit_001"],
    skipRenderedTranscriptQa: true,
    workflowBypass: true,
    validatedReview,
  }), {
    repair_tail_unit_ids: ["unit_001"],
    skip_rendered_transcript_qa: true,
  });
  assert.throws(() => validateManualStitchRecoveryForTests({
    repairTailUnitIds: ["unit_001"],
    skipRenderedTranscriptQa: true,
    workflowBypass: true,
    validatedReview,
  }), /allowed only with --manual-review-evidence/i);
  assert.throws(() => validateManualStitchRecoveryForTests({
    manualReviewEvidencePath: "/episode/manual-review.json",
    repairTailUnitIds: [],
    skipRenderedTranscriptQa: true,
    workflowBypass: true,
    validatedReview,
  }), /requires at least one/i);
  assert.throws(() => validateManualStitchRecoveryForTests({
    manualReviewEvidencePath: "/episode/manual-review.json",
    repairTailUnitIds: ["unit_002"],
    skipRenderedTranscriptQa: true,
    workflowBypass: true,
    validatedReview,
  }), /not an exact manually accepted tts_audio_tail_not_settled/i);
  assert.throws(() => validateManualStitchRecoveryForTests({
    manualReviewEvidencePath: "/episode/manual-review.json",
    repairTailUnitIds: ["unit_001"],
    skipRenderedTranscriptQa: true,
    validatedReview,
  }), /require explicit --workflow-bypass true/i);
}

function testNarrationExplicitGapsAreAlwaysExactEightyMilliseconds() {
  const explicit = { unitGapSec: 0.08, segmentGapSec: 0.08 };
  for (const crossesSegment of [false, true]) {
    const targetGapSec = stitchTargetGapSecForTests(explicit, crossesSegment);
    assert.equal(targetGapSec, 0.08);
    const planned = stitchBoundaryPaddingForTests(
      { trailing_silence_sample_count: 0 },
      { leading_silence_sample_count: 0 },
      targetGapSec,
      0.05,
      24000,
    );
    assert.equal(planned.target_gap_sample_count, 1920);
    assert.equal(planned.effective_gap_sample_count, 1920);
    const passed = stitchEffectiveBoundaryContractForTests(
      { trailing_silence_sample_count: 0 },
      { leading_silence_sample_count: 0 },
      targetGapSec,
      1920,
      24000,
    );
    assert.equal(passed.status, "passed");
    assert.equal(passed.effective_gap_sample_count, 1920);
    assert.equal(stitchEffectiveBoundaryContractForTests(
      { trailing_silence_sample_count: 0 },
      { leading_silence_sample_count: 0 },
      targetGapSec,
      3840,
      24000,
    ).status, "blocked");
  }

  const acousticImpulse = new Int16Array(1920);
  acousticImpulse[960] = 15000;
  const warningOnlyJoin = joinQaFromPcmForTests(
    acousticImpulse,
    24000,
    [
      {
        unit_id: "unit_left",
        sample_count: 960,
        prepared_qa: {
          metrics: { trailing_silence_sample_count: 960 },
        },
      },
      {
        unit_id: "unit_right",
        sample_count: 960,
        prepared_qa: {
          metrics: { leading_silence_sample_count: 960 },
        },
      },
    ],
    [{
      after_unit_id: "unit_left",
      before_unit_id: "unit_right",
      target_gap_sample_count: 1920,
      retained_left_trailing_silence_sample_count: 960,
      retained_right_leading_silence_sample_count: 960,
      inserted_silence_sample_count: 0,
      effective_gap_sample_count: 1920,
      gap_sample_count: 0,
    }],
  );
  assert.equal(warningOnlyJoin.status, "passed_with_warnings");
  assert.equal(
    warningOnlyJoin.warnings.some((finding) => (
      finding.code === "tts_join_impulsive_discontinuity"
      && finding.automatic_retry_allowed === false
      && finding.blocks_stitching === false
    )),
    true,
  );
}

testAutomatedQaWarnsWhileStructuralFailuresRemainHard();
testConfirmedRetryEvidenceBindsExactListenedArtifact();
testConfirmedRetryKeepsBlockedSelectionOnlyAsExactOrigin();
testManualAcceptanceIsExactHashBoundAndPreservesFindings();
testManualAcceptanceCannotWaiveAutomaticRetryCandidates();
testManualTailRepairAndRenderedAsrSkipAreStrictlyScoped();
testNarrationExplicitGapsAreAlwaysExactEightyMilliseconds();
