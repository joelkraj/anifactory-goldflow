import { createHash } from "node:crypto";

export const NARRATION_TTS_SELECTION_POLICY_VERSION = "narration_tts_selection_v4_qwen_liam_review_warnings";
export const PRIMARY_TTS_PROVIDER = "qwen_local";
export const FALLBACK_TTS_PROVIDER = null;
export const QWEN_LIAM_MINIMUM_COSINE_SIMILARITY = 0.88;
export const QWEN_LIAM_WARNING_BELOW_COSINE_SIMILARITY = 0.90;
// Legacy aliases remain exported so historical Puck reports and fixtures can
// still be inspected. New production selection uses the Liam-named constants.
export const QWEN_PUCK_MINIMUM_COSINE_SIMILARITY = QWEN_LIAM_MINIMUM_COSINE_SIMILARITY;
export const QWEN_PUCK_WARNING_BELOW_COSINE_SIMILARITY =
  QWEN_LIAM_WARNING_BELOW_COSINE_SIMILARITY;

export function deterministicTtsSeed(unitId, provider, attempt = 1) {
  const payload = [
    NARRATION_TTS_SELECTION_POLICY_VERSION,
    String(unitId ?? ""),
    String(provider ?? ""),
    String(attempt ?? 1),
  ].join("\u001f");
  return Number.parseInt(createHash("sha256").update(payload).digest("hex").slice(0, 8), 16);
}

export function qaBlockerCodes(qa) {
  if (!qa || typeof qa !== "object") return ["tts_unit_qa_missing"];
  const codes = (qa.findings ?? [])
    .filter((finding) => finding?.severity === "blocker")
    .map((finding) => String(finding.code ?? "unknown_tts_blocker"));
  if (!codes.length && String(qa.status ?? "").toLowerCase() === "blocked") {
    codes.push("tts_unit_qa_blocked_without_finding");
  }
  if (!codes.length && !["passed", "passed_with_warnings"].includes(
    String(qa.status ?? "").toLowerCase(),
  )) {
    codes.push("tts_unit_qa_status_not_passed");
  }
  return codes;
}

const AUTOMATIC_CONFIRMED_RETRY_CODES = new Set([
  "tts_synthesis_job_failed",
  "tts_batch_synthesis_failed",
  "tts_serial_synthesis_failed",
  "tts_batch_token_limit_reached",
  "tts_serial_token_limit_reached",
  "tts_audio_missing",
  "tts_audio_unreadable",
  "tts_audio_empty",
  "tts_audio_corrupt",
]);

export function isAutomaticConfirmedRetryCode(code) {
  return AUTOMATIC_CONFIRMED_RETRY_CODES.has(String(code ?? ""));
}

const STRUCTURAL_HARD_STOP_CODES = new Set([
  ...AUTOMATIC_CONFIRMED_RETRY_CODES,
  "tts_batch_cache_nondeterminism",
  "tts_unit_qa_missing",
  "tts_unit_qa_blocked_without_finding",
  "tts_unit_qa_status_not_passed",
]);

export function isTtsStructuralHardStopCode(code) {
  return STRUCTURAL_HARD_STOP_CODES.has(String(code ?? ""));
}

export function automatedQaFindingsAsReviewWarnings(findings = []) {
  return (findings ?? []).map((finding) => {
    if (finding?.severity !== "blocker"
      || isTtsStructuralHardStopCode(finding.code)) {
      return finding;
    }
    return {
      ...finding,
      severity: "warning",
      original_severity: "blocker",
      disposition_policy: "automated_tts_qa_review_warning",
      review_required: true,
      automatic_retry_allowed: false,
      blocks_stitching: false,
    };
  });
}

export function primaryHardBlockerCodes(qa) {
  const findings = Array.isArray(qa?.findings) ? qa.findings : [];
  const blockerCodes = findings
    .filter((finding) => finding?.severity === "blocker")
    .filter((finding) => isTtsStructuralHardStopCode(finding.code))
    .map((finding) => String(finding.code));
  if (!qa || typeof qa !== "object") blockerCodes.push("tts_unit_qa_missing");
  if (!blockerCodes.length
    && String(qa?.status ?? "").toLowerCase() === "blocked"
    && !findings.some((finding) => finding?.severity === "blocker")) {
    blockerCodes.push("tts_unit_qa_blocked_without_finding");
  }
  return [...new Set(blockerCodes)];
}

const CONFIRMABLE_DELIVERY_CODES = new Set([
  "tts_transcript_empty",
  "tts_transcript_contiguous_words_missing",
  "tts_transcript_opening_word_missing",
  "tts_transcript_final_word_missing",
  "tts_transcript_excessive_deletions",
  "tts_transcript_unexpected_word_burst",
  "tts_transcript_word_substitutions",
  "tts_transcript_isolated_substitution",
  "tts_transcript_isolated_word_deletion",
  "tts_transcript_isolated_insertion",
]);

export function confirmableDeliveryFindingCodes(qa) {
  return [...new Set((qa?.findings ?? [])
    .map((finding) => String(finding?.code ?? ""))
    .filter((code) => CONFIRMABLE_DELIVERY_CODES.has(code)))];
}

export function softenPrimaryQa(qa) {
  if (!qa || typeof qa !== "object") return qa;
  const findings = automatedQaFindingsAsReviewWarnings(qa.findings ?? [])
    .map((finding) => (
      finding?.disposition_policy === "automated_tts_qa_review_warning"
        ? {
            ...finding,
            retry_requires_confirmed_listen: CONFIRMABLE_DELIVERY_CODES.has(
              String(finding.code ?? ""),
            ),
          }
        : finding
    ));
  const blockers = findings.filter((finding) => finding?.severity === "blocker");
  return {
    ...qa,
    status: blockers.length ? "blocked" : findings.length ? "passed_with_warnings" : "passed",
    findings,
    delivery_first_gate: {
      policy_version: NARRATION_TTS_SELECTION_POLICY_VERSION,
      hard_blocker_codes: primaryHardBlockerCodes({ ...qa, findings }),
      demoted_diagnostic_count: findings.filter(
        (finding) => finding?.disposition_policy === "automated_tts_qa_review_warning",
      ).length,
      retry_policy:
        "Automated findings never trigger resubmission. A structural failure stops and emits its exact unit ID; a later hash-bound repair invocation may resynthesize only that unit after confirmed evidence.",
    },
  };
}

export function candidateDisposition(qa, provider) {
  if (provider !== PRIMARY_TTS_PROVIDER) {
    return {
      status: "rejected_unknown_provider",
      accepted: false,
      blocker_codes: qaBlockerCodes(qa),
    };
  }
  const blockerCodes = primaryHardBlockerCodes(qa);
  if (blockerCodes.length) {
    const manualReviewCodes = blockerCodes.filter(
      (code) => !isAutomaticConfirmedRetryCode(code),
    );
    return {
      status: manualReviewCodes.length
        ? "blocked_manual_review"
        : "exact_unit_repair_required",
      accepted: false,
      blocker_codes: blockerCodes,
    };
  }
  return {
    status: "accepted_primary",
    accepted: true,
    blocker_codes: [],
  };
}

export function voiceContinuityDecision(continuityQa, {
  audioSha256,
  referenceVoiceId = "am_liam",
  referenceVoiceSha256,
  similarityModelSha256,
  minimumCosineSimilarity = QWEN_LIAM_MINIMUM_COSINE_SIMILARITY,
  warningBelowCosineSimilarity = QWEN_LIAM_WARNING_BELOW_COSINE_SIMILARITY,
} = {}) {
  const findings = [];
  const addBlocker = (code, details = {}) => findings.push({
    severity: "blocker",
    code,
    ...details,
  });
  const addWarning = (code, details = {}) => findings.push({
    severity: "warning",
    code,
    ...details,
  });
  if (!continuityQa || typeof continuityQa !== "object") {
    addBlocker("tts_primary_voice_continuity_qa_missing");
  } else {
    if (continuityQa.status !== "passed") {
      addBlocker("tts_primary_voice_continuity_not_passed", {
        status: continuityQa.status ?? null,
      });
    }
    if (!audioSha256 || continuityQa.audio_sha256 !== audioSha256) {
      addBlocker("tts_primary_voice_continuity_audio_hash_mismatch", {
        expected: audioSha256 ?? null,
        actual: continuityQa.audio_sha256 ?? null,
      });
    }
    if (continuityQa.reference_voice_id !== referenceVoiceId) {
      addBlocker("tts_primary_reference_voice_id_mismatch", {
        expected: referenceVoiceId,
        actual: continuityQa.reference_voice_id ?? null,
      });
    }
    if (!referenceVoiceSha256
      || continuityQa.reference_voice_sha256 !== referenceVoiceSha256) {
      addBlocker("tts_primary_reference_voice_hash_mismatch", {
        expected: referenceVoiceSha256 ?? null,
        actual: continuityQa.reference_voice_sha256 ?? null,
      });
    }
    if (!similarityModelSha256
      || continuityQa.similarity_model_sha256 !== similarityModelSha256) {
      addBlocker("tts_primary_similarity_model_hash_mismatch", {
        expected: similarityModelSha256 ?? null,
        actual: continuityQa.similarity_model_sha256 ?? null,
      });
    }
    const similarity = Number(continuityQa.cosine_similarity);
    if (!Number.isFinite(similarity)
      || similarity < Number(minimumCosineSimilarity)) {
      addBlocker("tts_primary_voice_similarity_below_minimum", {
        cosine_similarity: Number.isFinite(similarity) ? similarity : null,
        minimum_cosine_similarity: minimumCosineSimilarity,
      });
    } else if (similarity < Number(warningBelowCosineSimilarity)) {
      addWarning("tts_primary_voice_similarity_low_margin", {
        cosine_similarity: similarity,
        minimum_cosine_similarity: minimumCosineSimilarity,
        warning_below_cosine_similarity: warningBelowCosineSimilarity,
        review_required: true,
      });
    }
    if (Number(continuityQa.minimum_cosine_similarity)
      !== Number(minimumCosineSimilarity)) {
      addBlocker("tts_primary_voice_similarity_policy_mismatch", {
        expected: minimumCosineSimilarity,
        actual: continuityQa.minimum_cosine_similarity ?? null,
      });
    }
    if (Number(continuityQa.warning_below_cosine_similarity)
      !== Number(warningBelowCosineSimilarity)) {
      addBlocker("tts_primary_voice_similarity_warning_policy_mismatch", {
        expected: warningBelowCosineSimilarity,
        actual: continuityQa.warning_below_cosine_similarity ?? null,
      });
    }
  }
  const blockers = findings.filter((finding) => finding.severity === "blocker");
  return {
    status: blockers.length ? "blocked" : "passed",
    findings,
  };
}

export function validateSelectedUnitOrder(plannedUnits, selectedRows) {
  const expected = plannedUnits.map((unit) => String(unit.unit_id));
  const actual = selectedRows.map((row) => String(row.unit_id));
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const duplicateExpected = expected.filter((id, index) => expected.indexOf(id) !== index);
  const duplicateActual = actual.filter((id, index) => actual.indexOf(id) !== index);
  const missing = expected.filter((id) => !actualSet.has(id));
  const unexpected = actual.filter((id) => !expectedSet.has(id));
  const reordered = expected.length === actual.length
    && expected.some((id, index) => actual[index] !== id);
  const blockers = [];
  if (duplicateExpected.length) blockers.push({
    code: "tts_plan_duplicate_unit_ids",
    unit_ids: [...new Set(duplicateExpected)],
  });
  if (duplicateActual.length) blockers.push({
    code: "tts_selection_duplicate_unit_ids",
    unit_ids: [...new Set(duplicateActual)],
  });
  if (missing.length) blockers.push({ code: "tts_selection_missing_units", unit_ids: missing });
  if (unexpected.length) blockers.push({ code: "tts_selection_unexpected_units", unit_ids: unexpected });
  if (reordered) blockers.push({
    code: "tts_selection_reordered_units",
    expected_unit_ids: expected,
    actual_unit_ids: actual,
  });
  return {
    status: blockers.length ? "blocked" : "passed",
    expected_unit_ids: expected,
    actual_unit_ids: actual,
    blockers,
  };
}

export function fullStreamDecision(transcriptQa, {
  orderQa,
  joinQa,
  maximumWer = 0.05,
  transcriptDeferred = false,
} = {}) {
  const blockers = [
    ...(orderQa?.blockers ?? []),
    ...(joinQa?.blockers ?? []),
  ];
  const warnings = [...(joinQa?.warnings ?? [])];
  const addWarning = (code, details = {}) => warnings.push({
    ...details,
    severity: "warning",
    disposition_policy: "automated_tts_qa_review_warning",
    review_required: true,
    automatic_retry_allowed: false,
    blocks_stitching: false,
    code,
  });
  if (!transcriptQa) {
    if (transcriptDeferred) {
      addWarning("tts_full_stream_transcript_deferred_to_official_whisper_timing");
    } else {
      addWarning("tts_full_stream_transcript_missing", {
        original_severity: "blocker",
      });
    }
  } else {
    if (Number(transcriptQa.leading_deletion_run ?? 0) > 0) {
      addWarning("tts_full_stream_opening_missing", {
        missing_count: transcriptQa.leading_deletion_run,
        original_severity: "blocker",
      });
    }
    if (Number(transcriptQa.trailing_deletion_run ?? 0) > 0) {
      addWarning("tts_full_stream_final_word_missing", {
        missing_count: transcriptQa.trailing_deletion_run,
        original_severity: "blocker",
      });
    }
    if (Number(transcriptQa.longest_deletion_run ?? 0) >= 2) {
      addWarning("tts_full_stream_contiguous_words_missing", {
        longest_deletion_run: transcriptQa.longest_deletion_run,
        original_severity: "blocker",
      });
    } else if (Number(transcriptQa.deletions ?? 0) > 0) {
      addWarning("tts_full_stream_isolated_asr_deletion", {
        deletions: transcriptQa.deletions,
      });
    }
    if (Number(transcriptQa.longest_insertion_run ?? 0) >= 2) {
      addWarning("tts_full_stream_repetition_or_insertion_burst", {
        longest_insertion_run: transcriptQa.longest_insertion_run,
        original_severity: "blocker",
      });
    } else if (Number(transcriptQa.insertions ?? 0) > 0) {
      addWarning("tts_full_stream_isolated_asr_insertion", {
        insertions: transcriptQa.insertions,
      });
    }
    if (Number(transcriptQa.word_error_rate ?? 1) > maximumWer) {
      addWarning("tts_full_stream_wer_exceeded", {
        word_error_rate: transcriptQa.word_error_rate,
        maximum: maximumWer,
        original_severity: "blocker",
      });
    }
    for (const finding of automatedQaFindingsAsReviewWarnings(
      transcriptQa.findings ?? [],
    )) {
      const code = String(finding.code ?? "tts_full_stream_transcript_blocker");
      if (!warnings.some((row) => row.code === code)) {
        addWarning(code, finding);
      }
    }
  }
  return {
    status: blockers.length ? "blocked" : "passed",
    blockers,
    warnings,
  };
}
