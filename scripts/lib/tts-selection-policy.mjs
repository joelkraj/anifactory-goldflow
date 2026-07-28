import { createHash } from "node:crypto";

export const NARRATION_TTS_SELECTION_POLICY_VERSION = "narration_tts_selection_v2_delivery_first";
export const PRIMARY_TTS_PROVIDER = "kokoro_local";
export const FALLBACK_TTS_PROVIDER = "qwen_local";
export const QWEN_PUCK_MINIMUM_COSINE_SIMILARITY = 0.88;
export const QWEN_PUCK_WARNING_BELOW_COSINE_SIMILARITY = 0.90;

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

const PRIMARY_HARD_BLOCKER_CODES = new Set([
  "tts_unit_qa_missing",
  "tts_synthesis_job_failed",
  "tts_audio_empty",
  "tts_audio_implausibly_short",
  "tts_audio_clipping",
  "tts_audio_untranscribed_internal_burst",
  "tts_transcript_empty",
]);

export function primaryHardBlockerCodes(qa) {
  const findings = Array.isArray(qa?.findings) ? qa.findings : [];
  const hardCodes = findings
    .filter((finding) => finding?.severity === "blocker")
    .filter((finding) => {
      const code = String(finding.code ?? "");
      if (PRIMARY_HARD_BLOCKER_CODES.has(code)) return true;
      if (code === "tts_transcript_contiguous_words_missing") {
        return Number(finding.longest_deletion_run ?? qa?.transcript?.longest_deletion_run ?? 0) >= 4;
      }
      if (code === "tts_transcript_excessive_deletions") {
        const deletions = Number(finding.deletions ?? qa?.transcript?.deletions ?? 0);
        const intended = Number(
          finding.intended_word_count ?? qa?.transcript?.intended_canonical_token_count ?? 0,
        );
        return deletions >= 4 && intended > 0 && deletions / intended >= 0.2;
      }
      if (code === "tts_transcript_unexpected_word_burst") {
        return Number(finding.longest_insertion_run ?? qa?.transcript?.longest_insertion_run ?? 0) >= 4;
      }
      return false;
    })
    .map((finding) => String(finding.code));
  if (!qa || typeof qa !== "object") hardCodes.push("tts_unit_qa_missing");
  return [...new Set(hardCodes)];
}

export function softenPrimaryQa(qa) {
  if (!qa || typeof qa !== "object") return qa;
  const hardCodes = new Set(primaryHardBlockerCodes(qa));
  const findings = (qa.findings ?? []).map((finding) => {
    if (finding?.severity !== "blocker" || hardCodes.has(String(finding.code ?? ""))) {
      return finding;
    }
    return {
      ...finding,
      severity: "warning",
      original_severity: "blocker",
      disposition_policy: "delivery_first_primary_warning",
    };
  });
  const blockers = findings.filter((finding) => finding?.severity === "blocker");
  return {
    ...qa,
    status: blockers.length ? "blocked" : findings.length ? "passed_with_warnings" : "passed",
    findings,
    delivery_first_gate: {
      policy_version: NARRATION_TTS_SELECTION_POLICY_VERSION,
      hard_blocker_codes: [...hardCodes],
      demoted_diagnostic_count: findings.filter(
        (finding) => finding?.disposition_policy === "delivery_first_primary_warning",
      ).length,
    },
  };
}

export function candidateDisposition(qa, provider) {
  const blockerCodes = provider === PRIMARY_TTS_PROVIDER
    ? primaryHardBlockerCodes(qa)
    : qaBlockerCodes(qa);
  if (blockerCodes.length) {
    return {
      status: provider === PRIMARY_TTS_PROVIDER ? "fallback_required" : "rejected",
      accepted: false,
      blocker_codes: blockerCodes,
    };
  }
  return {
    status: provider === PRIMARY_TTS_PROVIDER ? "accepted_primary" : "accepted_fallback",
    accepted: true,
    blocker_codes: [],
  };
}

export function voiceContinuityDecision(continuityQa, {
  audioSha256,
  referenceVoiceId = "am_puck",
  referenceVoiceSha256,
  similarityModelSha256,
  minimumCosineSimilarity = QWEN_PUCK_MINIMUM_COSINE_SIMILARITY,
  warningBelowCosineSimilarity = QWEN_PUCK_WARNING_BELOW_COSINE_SIMILARITY,
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
    addBlocker("tts_fallback_voice_continuity_qa_missing");
  } else {
    if (continuityQa.status !== "passed") {
      addBlocker("tts_fallback_voice_continuity_not_passed", {
        status: continuityQa.status ?? null,
      });
    }
    if (!audioSha256 || continuityQa.audio_sha256 !== audioSha256) {
      addBlocker("tts_fallback_voice_continuity_audio_hash_mismatch", {
        expected: audioSha256 ?? null,
        actual: continuityQa.audio_sha256 ?? null,
      });
    }
    if (continuityQa.reference_voice_id !== referenceVoiceId) {
      addBlocker("tts_fallback_reference_voice_id_mismatch", {
        expected: referenceVoiceId,
        actual: continuityQa.reference_voice_id ?? null,
      });
    }
    if (!referenceVoiceSha256
      || continuityQa.reference_voice_sha256 !== referenceVoiceSha256) {
      addBlocker("tts_fallback_reference_voice_hash_mismatch", {
        expected: referenceVoiceSha256 ?? null,
        actual: continuityQa.reference_voice_sha256 ?? null,
      });
    }
    if (!similarityModelSha256
      || continuityQa.similarity_model_sha256 !== similarityModelSha256) {
      addBlocker("tts_fallback_similarity_model_hash_mismatch", {
        expected: similarityModelSha256 ?? null,
        actual: continuityQa.similarity_model_sha256 ?? null,
      });
    }
    const similarity = Number(continuityQa.cosine_similarity);
    if (!Number.isFinite(similarity)
      || similarity < Number(minimumCosineSimilarity)) {
      addBlocker("tts_fallback_voice_similarity_below_minimum", {
        cosine_similarity: Number.isFinite(similarity) ? similarity : null,
        minimum_cosine_similarity: minimumCosineSimilarity,
      });
    } else if (similarity < Number(warningBelowCosineSimilarity)) {
      addWarning("tts_fallback_voice_similarity_low_margin", {
        cosine_similarity: similarity,
        minimum_cosine_similarity: minimumCosineSimilarity,
        warning_below_cosine_similarity: warningBelowCosineSimilarity,
        review_required: true,
      });
    }
    if (Number(continuityQa.minimum_cosine_similarity)
      !== Number(minimumCosineSimilarity)) {
      addBlocker("tts_fallback_voice_similarity_policy_mismatch", {
        expected: minimumCosineSimilarity,
        actual: continuityQa.minimum_cosine_similarity ?? null,
      });
    }
    if (Number(continuityQa.warning_below_cosine_similarity)
      !== Number(warningBelowCosineSimilarity)) {
      addBlocker("tts_fallback_voice_similarity_warning_policy_mismatch", {
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
  const addBlocker = (code, details = {}) => blockers.push({ code, ...details });
  const addWarning = (code, details = {}) => warnings.push({ code, ...details });
  if (!transcriptQa) {
    if (transcriptDeferred) {
      addWarning("tts_full_stream_transcript_deferred_to_official_whisper_timing");
    } else {
      addBlocker("tts_full_stream_transcript_missing");
    }
  } else {
    if (Number(transcriptQa.leading_deletion_run ?? 0) > 0) {
      addBlocker("tts_full_stream_opening_missing", {
        missing_count: transcriptQa.leading_deletion_run,
      });
    }
    if (Number(transcriptQa.trailing_deletion_run ?? 0) > 0) {
      addBlocker("tts_full_stream_final_word_missing", {
        missing_count: transcriptQa.trailing_deletion_run,
      });
    }
    if (Number(transcriptQa.longest_deletion_run ?? 0) >= 2) {
      addBlocker("tts_full_stream_contiguous_words_missing", {
        longest_deletion_run: transcriptQa.longest_deletion_run,
      });
    } else if (Number(transcriptQa.deletions ?? 0) > 0) {
      addWarning("tts_full_stream_isolated_asr_deletion", {
        deletions: transcriptQa.deletions,
      });
    }
    if (Number(transcriptQa.longest_insertion_run ?? 0) >= 2) {
      addBlocker("tts_full_stream_repetition_or_insertion_burst", {
        longest_insertion_run: transcriptQa.longest_insertion_run,
      });
    } else if (Number(transcriptQa.insertions ?? 0) > 0) {
      addWarning("tts_full_stream_isolated_asr_insertion", {
        insertions: transcriptQa.insertions,
      });
    }
    if (Number(transcriptQa.word_error_rate ?? 1) > maximumWer) {
      addBlocker("tts_full_stream_wer_exceeded", {
        word_error_rate: transcriptQa.word_error_rate,
        maximum: maximumWer,
      });
    }
    for (const finding of transcriptQa.findings ?? []) {
      if (finding?.severity !== "blocker") continue;
      const code = String(finding.code ?? "tts_full_stream_transcript_blocker");
      if (!blockers.some((row) => row.code === code)) addBlocker(code, finding);
    }
  }
  return {
    status: blockers.length ? "blocked" : "passed",
    blockers,
    warnings,
  };
}
