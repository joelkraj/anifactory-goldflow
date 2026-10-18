export const NARRATION_CROSS_LEVEL_ASR_POLICY_VERSION =
  "internal_article_fusion_bound_unit_dual_asr_v1";

function exactTranscript(qa) {
  return qa?.deletions === 0 && qa?.insertions === 0
    && qa?.substitutions === 0 && qa?.first_token_ok === true
    && qa?.last_token_ok === true
    && (qa?.operations ?? []).length > 0
    && qa.operations.every((row) => row.type === "match");
}

function articleFusion(qa) {
  const operations = qa?.operations ?? [];
  if (qa?.first_token_ok !== true || qa?.last_token_ok !== true
    || operations.filter((row) => row.type === "deletion").length !== 1
    || operations.some((row) => row.type === "insertion")) return null;
  const index = operations.findIndex((row) => row.type === "deletion");
  const article = operations[index]?.intended;
  const next = operations[index + 1];
  if (!["a", "an"].includes(article)
    || index < 1 || index + 2 >= operations.length
    || operations[index - 1]?.type !== "match"
    || next?.type !== "substitution"
    || operations[index + 2]?.type !== "match"
    || !/^[a-z]{4,}$/.test(String(next.intended ?? ""))
    || !/^[a-z]{4,}$/.test(String(next.recognized ?? ""))
    || !next.recognized.startsWith(article)) return null;
  return { intended_index: index, article,
    following_intended_token: next.intended,
    fused_recognized_token: next.recognized };
}

export function crossLevelArticleFusionCandidate(window) {
  if ((window?.unit_ids ?? []).length !== 1
    || (window?.boundary_ids ?? []).length !== 0
    || window?.decision?.blockers?.length !== 1
    || window.decision.blockers[0]?.code !== "narration_confirmed_word_omission") return null;
  const primary = articleFusion(window.primary_transcript_qa);
  const confirmation = articleFusion(window.confirmation_transcript_qa);
  if (!primary || JSON.stringify(primary) !== JSON.stringify(confirmation)
    || JSON.stringify(window.decision.blockers[0]?.intended_tokens) !== JSON.stringify([primary.article])) return null;
  return { ...primary, unit_id: window.unit_ids[0] };
}

function articleTiming(recognition, index, article) {
  const words = recognition?.words ?? [];
  if (words.length !== recognition?.canonical_token_count) return false;
  const word = words[index];
  return String(word?.word ?? "").toLowerCase().replace(/[^a-z]/g, "") === article
    && Number(word?.end_sec) - Number(word?.start_sec) >= 0.05
    && Number(word?.probability) >= 0.5;
}

/**
 * Resolve an ASR spelling split only when the intact, immutable source unit
 * independently confirms the article. An actual deletion, a boundary defect,
 * or any other full-stream blocker remains blocked.
 */
export function corroborateCrossLevelArticleFusion(window, evidence) {
  const candidate = crossLevelArticleFusionCandidate(window);
  if (!candidate || evidence?.unit_id !== candidate.unit_id
    || evidence?.source_audio_sha256?.length !== 64
    || evidence?.prepared_audio_sha256?.length !== 64
    || evidence?.master_audio_sha256?.length !== 64
    || evidence?.window_audio_sha256 !== window.audio_sha256
    || evidence?.master_audio_sha256 !== window.source_audio_sha256
    || evidence?.sample_accounting_exact !== true
    || evidence?.join_qa_passed !== true
    || evidence?.prepared_speech_preserved !== true
    || evidence?.pcm_integrity?.status !== "passed"
    || evidence.pcm_integrity.prepared_pcm_sha256
      !== evidence.pcm_integrity.raw_stitch_span_pcm_sha256
    || Number(evidence.pcm_integrity.article_master_raw_correlation) < 0.99
    || !exactTranscript(evidence?.unit_small_qa)
    || !exactTranscript(evidence?.unit_medium_raw_qa)
    || !exactTranscript(evidence?.unit_medium_prepared_qa)
    || !articleTiming(evidence?.unit_medium_raw, candidate.intended_index, candidate.article)
    || !articleTiming(evidence?.unit_medium_prepared, candidate.intended_index, candidate.article)) {
    return { window, corroborated: false };
  }
  const warning = {
    code: "narration_cross_level_article_fusion_corroborated",
    severity: "warning",
    review_required: false,
    disposition: "bound_unit_dual_asr_exact_article_present",
    article: candidate.article,
    intended_index: candidate.intended_index,
    fused_recognized_token: candidate.fused_recognized_token,
    unit_id: candidate.unit_id,
    source_audio_sha256: evidence.source_audio_sha256,
    prepared_audio_sha256: evidence.prepared_audio_sha256,
    master_audio_sha256: evidence.master_audio_sha256,
  };
  return {
    corroborated: true,
    window: { ...window, cross_level_article_fusion: evidence,
      decision: { ...window.decision, status: "passed_with_warnings",
        blockers: [], warnings: [...(window.decision.warnings ?? []), warning],
        review_required: (window.decision.warnings ?? []).some((row) => row.review_required === true) } },
  };
}
