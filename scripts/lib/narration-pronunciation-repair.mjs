import { createHash } from "node:crypto";
import path from "node:path";

export const PRONUNCIATION_DEFECT_SCHEMA = "goldflow_tts_user_heard_pronunciation_defect_v1";
export const PRONUNCIATION_REQUEST_SCHEMA = "goldflow_tts_exact_pronunciation_request_v1";
export const PRONUNCIATION_RESULT_SCHEMA = "goldflow_tts_exact_pronunciation_result_v1";
export const PRONUNCIATION_REVIEW_SCHEMA = "goldflow_tts_pronunciation_candidate_listen_v1";
export const PRONUNCIATION_SELECTED_REVIEW_SCHEMA = "goldflow_tts_selected_pronunciation_listen_v1";
export const PRONUNCIATION_MODE = "user_heard_pronunciation_fragment_v1";
export const PRONUNCIATION_DEFECT_ATTESTATION = "user_listened_to_exact_selected_opening_word";
export const PRONUNCIATION_REVIEW_ATTESTATION = "user_listened_to_exact_candidate_opening_word";
export const PRONUNCIATION_SELECTED_REVIEW_ATTESTATION = "user_listened_to_exact_selected_opening_word";
export const AUTOMATED_PRONUNCIATION_SCHEMA = "goldflow_tts_reviewed_automated_pronunciation_v1";
export const AUTOMATED_PRONUNCIATION_MODE = "reviewed_automated_pronunciation_fragment_v1";

const hex = (value) => /^[a-f0-9]{64}$/u.test(String(value ?? ""));
const word = (value) => /^[\p{L}]+(?:['’][\p{L}]+)*$/u.test(String(value ?? ""));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value;
const canonicalHash = (value) => sha(JSON.stringify(canonical(value)));
const laterWordsMatchBothAsr = (primary, confirmation) => [primary, confirmation].every((qa) => (
  Array.isArray(qa?.operations) && qa.operations.length >= 2
  && ["match", "substitution"].includes(qa.operations[0]?.type)
  && qa.operations.slice(1).every((operation) => operation?.type === "match")
  && Number(qa.deletions) === 0 && Number(qa.insertions) === 0
));
const firstRecognizedWord = (qa) => String(qa?.operations?.[0]?.recognized ?? "").toLocaleLowerCase();
const terminalConsonantSpellingVariant = (expected, phonetic) => {
  const left = String(expected ?? "").toLocaleLowerCase();
  const right = String(phonetic ?? "").toLocaleLowerCase();
  return /^[a-z]+$/u.test(left) && /^[a-z]+$/u.test(right)
    && left.length >= 4 && left.slice(0, -1) === right
    && /[bcdfghjklmnpqrstvwxyz]/u.test(left.at(-1))
    && left.at(-1) === left.at(-2);
};

// This is a reviewed exact-scope *automated* repair authorization. It never
// claims that anyone heard the WAV. The candidate still has to pass fresh
// dual-ASR, acoustic, voice and full-stream QA after synthesis.
export function validateAutomatedPronunciationEvidenceForTests({
  evidence, evidenceFileSha256, sourceScriptSha256, plan, planFileSha256,
  report, reportFileSha256, delivery, deliveryFileSha256,
  manifest, manifestFileSha256, selectedAudioFileSha256,
  priorBoundaryRequest, priorBoundaryResult, priorBoundaryResultFileSha256,
} = {}) {
  const id = String(evidence?.unit_id ?? "");
  const planned = (plan?.units ?? []).find((row) => row.unit_id === id);
  const selected = (manifest?.units ?? []).find((row) => row.unit_id === id);
  const reported = (report?.results ?? []).find((row) => row.unit_id === id);
  const delivered = (delivery?.units ?? []).find((row) => row.unit_id === id);
  const first = priorBoundaryRequest?.units?.find((row) => row.unit_id === id);
  const repaired = priorBoundaryResult?.units?.find((row) => row.unit_id === id);
  const expectedWord = String(evidence?.expected_word ?? "");
  const phoneticWord = String(evidence?.tts_only_phonetic_word ?? "");
  const sourceText = String(planned?.spoken_text ?? "");
  const remainder = sourceText.slice(expectedWord.length + 1);
  const fragments = repaired?.fragments ?? [];
  const primary = delivered?.transcript_qa;
  const confirmation = delivered?.confirmation_transcript_qa;
  const observed = firstRecognizedWord(primary);
  const valid = evidence?.schema === AUTOMATED_PRONUNCIATION_SCHEMA
    && evidence.status === "reviewed"
    && evidence.evidence_basis === "reviewed_automated_delivery_qa"
    && evidence.authorization_origin === "user_authorized_autonomous_production"
    && evidence.human_listening_performed === false
    && evidence.user_listening_claimed === false
    && String(evidence.reviewed_by ?? "").trim().length >= 3
    && String(evidence.review_note ?? "").trim().length >= 30
    && Number.isFinite(Date.parse(evidence.reviewed_at))
    && hex(evidenceFileSha256)
    && terminalConsonantSpellingVariant(expectedWord, phoneticWord)
    && sourceText.startsWith(`${expectedWord} `)
    && remainder.length > 0
    && evidence.observed_primary_first_word === observed
    && evidence.observed_confirmation_first_word === firstRecognizedWord(confirmation)
    && observed === firstRecognizedWord(confirmation)
    && observed !== expectedWord.toLocaleLowerCase()
    && observed !== phoneticWord.toLocaleLowerCase()
    && evidence.source_script_sha256 === sourceScriptSha256
    && sourceScriptSha256 === plan?.source_script_hash
    && evidence.narration_generation_plan_sha256 === plan?.plan_sha256
    && evidence.narration_generation_plan_file_sha256 === planFileSha256
    && evidence.prior_narration_report_sha256 === reportFileSha256
    && evidence.prior_unit_delivery_qa_sha256 === deliveryFileSha256
    && evidence.prior_provider_manifest_file_sha256 === manifestFileSha256
    && evidence.prior_audio_sha256 === selected?.audio_sha256
    && selected?.audio_sha256 === selectedAudioFileSha256
    && evidence.prior_synthesis_identity_sha256 === selected?.synthesis_identity_sha256
    && evidence.prior_boundary_result_sha256 === priorBoundaryResultFileSha256
    && report?.status === "blocked"
    && report?.unit_qa_status === "blocked"
    && report?.full_stream_qa_status === "not_run_due_to_unit_blockers"
    && report?.provider_output_manifest_sha256 === manifestFileSha256
    && report?.source_script_hash === sourceScriptSha256
    && report?.narration_generation_plan_sha256 === plan?.plan_sha256
    && report?.narration_generation_plan_file_sha256 === planFileSha256
    && delivery?.status === "blocked"
    && delivery?.source_script_hash === sourceScriptSha256
    && delivery?.narration_generation_plan_sha256 === plan?.plan_sha256
    && report?.blockers?.length === 1
    && report.blockers[0]?.unit_id === id
    && report.blockers[0]?.code === "narration_confirmed_opening_token_mismatch"
    && delivery?.blockers?.length === 1
    && delivery.blockers[0]?.unit_id === id
    && delivery.blockers[0]?.code === "narration_confirmed_opening_token_mismatch"
    && delivered?.audio_sha256 === selected?.audio_sha256
    && laterWordsMatchBothAsr(primary, confirmation)
    && delivered?.decision?.blockers?.length === 1
    && delivered.decision.blockers[0]?.code === "narration_confirmed_opening_token_mismatch"
    && planned?.spoken_text_sha256 === sha(sourceText)
    && selected?.spoken_text_sha256 === sha(sourceText)
    && reported?.spoken_text_sha256 === sha(sourceText)
    && reported?.audio_sha256 === selected?.audio_sha256
    && reported?.synthesis_identity_sha256 === selected?.synthesis_identity_sha256
    && selected?.synthesis_mode === "exact_sentence_boundary_composite_v1"
    && selected?.recovery_provenance?.request_sha256 === priorBoundaryRequest?.request_sha256
    && selected?.recovery_provenance?.result_sha256 === priorBoundaryResultFileSha256
    && priorBoundaryRequest?.schema === "goldflow_tts_exact_boundary_repair_request_v1"
    && priorBoundaryResult?.schema === "goldflow_tts_exact_boundary_repair_result_v1"
    && priorBoundaryResult?.request_sha256 === priorBoundaryRequest?.request_sha256
    && first?.fragments?.length === 2
    && first.fragments[0] === expectedWord
    && first.fragments[1] === remainder
    && fragments.length === 2
    && fragments[0]?.text_sha256 === sha(expectedWord)
    && fragments[1]?.text_sha256 === sha(remainder)
    && repaired?.audio_sha256 === selected?.audio_sha256;
  if (!valid) throw new Error("Automated pronunciation evidence is not bound to one exact confirmed opening defect and retained remainder.");
  return { unit_id: id, expected_word: expectedWord, phonetic_word: phoneticWord,
    remainder_text: remainder, retained_remainder: fragments[1] };
}

export function applyAutomatedPronunciationCandidateForTests({
  decision, unitId, reviewedUnitId, evidenceSha256, expectedWord, phoneticWord,
  primaryTranscriptQa, confirmationTranscriptQa,
} = {}) {
  if (unitId !== reviewedUnitId) return decision;
  if (!terminalConsonantSpellingVariant(expectedWord, phoneticWord)) {
    throw new Error("Automated pronunciation receipt changes more than a terminal consonant spelling.");
  }
  if (!laterWordsMatchBothAsr(primaryTranscriptQa, confirmationTranscriptQa)) return decision;
  const acceptable = new Set([expectedWord.toLocaleLowerCase(), phoneticWord.toLocaleLowerCase()]);
  if (!acceptable.has(firstRecognizedWord(primaryTranscriptQa))
    || !acceptable.has(firstRecognizedWord(confirmationTranscriptQa))) return decision;
  const blockers = decision?.blockers ?? [];
  if (blockers.length === 0) return { ...decision,
    automated_pronunciation_review: { status: "passed", evidence_sha256: evidenceSha256,
      human_listening_performed: false } };
  if (blockers.length !== 1
    || blockers[0].code !== "narration_confirmed_opening_token_mismatch") {
    throw new Error("Automated pronunciation cannot override another delivery or acoustic defect.");
  }
  return { ...decision, status: "passed_with_warnings", blockers: [],
    review_required: false,
    warnings: [...(decision.warnings ?? []), { ...blockers[0],
      severity: "warning", original_severity: "blocker", review_required: false,
      automated_phonetic_match: true, evidence_sha256: evidenceSha256 }],
    automated_pronunciation_review: { status: "passed", evidence_sha256: evidenceSha256,
      human_listening_performed: false } };
}

export function validatePronunciationDefectEvidenceForTests({
  evidence, evidenceFileSha256, sourceScriptSha256, plan, planFileSha256,
  report, reportFileSha256, delivery, deliveryFileSha256,
  manifest, manifestFileSha256, selectedAudioFileSha256,
  priorBoundaryRequest, priorBoundaryResult, priorBoundaryResultFileSha256,
} = {}) {
  const unitId = String(evidence?.unit_id ?? "");
  const planned = (plan?.units ?? []).find((row) => row.unit_id === unitId);
  const selected = (manifest?.units ?? []).find((row) => row.unit_id === unitId);
  const reported = (report?.results ?? []).find((row) => row.unit_id === unitId);
  const deliveryRow = (delivery?.units ?? []).find((row) => row.unit_id === unitId);
  const first = priorBoundaryRequest?.units?.find((row) => row.unit_id === unitId);
  const repaired = priorBoundaryResult?.units?.find((row) => row.unit_id === unitId);
  const blockers = report?.blockers ?? [];
  const intended = String(evidence?.expected_word ?? "");
  const heard = String(evidence?.heard_word ?? "");
  const phonetic = String(evidence?.tts_only_phonetic_word ?? "");
  const sourceText = String(planned?.spoken_text ?? "");
  const remainder = sourceText.slice(intended.length + 1);
  const fragmentRows = repaired?.fragments ?? [];
  const defectValid = evidence?.schema === PRONUNCIATION_DEFECT_SCHEMA
    && evidence.status === "reviewed"
    && evidence.listener_role === "user"
    && evidence.human_listening_performed === true
    && evidence.operator_listening_performed === false
    && evidence.attestation === PRONUNCIATION_DEFECT_ATTESTATION
    && String(evidence.user_quote ?? "").trim().length >= 4
    && String(evidence.user_quote ?? "").toLocaleLowerCase()
      .includes(heard.toLocaleLowerCase())
    && String(evidence.review_note ?? "").trim().length >= 30
    && Number.isFinite(Date.parse(evidence.reviewed_at))
    && word(intended) && word(heard) && word(phonetic)
    && intended.toLocaleLowerCase() !== heard.toLocaleLowerCase()
    && intended.toLocaleLowerCase() !== phonetic.toLocaleLowerCase()
    && intended[0].toLocaleLowerCase() === phonetic[0].toLocaleLowerCase()
    && sourceText.startsWith(`${intended} `)
    && remainder.length > 0
    && evidence.source_script_sha256 === sourceScriptSha256
    && sourceScriptSha256 === plan?.source_script_hash
    && evidence.narration_generation_plan_sha256 === plan?.plan_sha256
    && evidence.narration_generation_plan_file_sha256 === planFileSha256
    && evidence.prior_narration_report_sha256 === reportFileSha256
    && evidence.prior_unit_delivery_qa_sha256 === deliveryFileSha256
    && evidence.prior_provider_manifest_file_sha256 === manifestFileSha256
    && evidence.prior_audio_sha256 === selected?.audio_sha256
    && evidence.prior_audio_sha256 === selectedAudioFileSha256
    && evidence.prior_synthesis_identity_sha256 === selected?.synthesis_identity_sha256
    && evidence.prior_boundary_result_sha256 === priorBoundaryResultFileSha256
    && hex(evidenceFileSha256)
    && report?.status === "blocked"
    && report?.unit_qa_status === "blocked"
    && report?.full_stream_qa_status === "not_run_due_to_unit_blockers"
    && report?.provider_output_manifest_sha256 === manifestFileSha256
    && report?.source_script_hash === sourceScriptSha256
    && report?.narration_generation_plan_sha256 === plan?.plan_sha256
    && report?.narration_generation_plan_file_sha256 === planFileSha256
    && delivery?.status === "blocked"
    && delivery?.source_script_hash === sourceScriptSha256
    && delivery?.narration_generation_plan_sha256 === plan?.plan_sha256
    && blockers.length === 1
    && blockers[0]?.unit_id === unitId
    && blockers[0]?.code === "narration_confirmed_opening_token_mismatch"
    && delivery?.blockers?.length === 1
    && delivery.blockers[0]?.unit_id === unitId
    && delivery.blockers[0]?.code === "narration_confirmed_opening_token_mismatch"
    && deliveryRow?.audio_sha256 === selected?.audio_sha256
    && laterWordsMatchBothAsr(deliveryRow?.transcript_qa,
      deliveryRow?.confirmation_transcript_qa)
    && deliveryRow?.decision?.blockers?.length === 1
    && deliveryRow.decision.blockers[0]?.code === "narration_confirmed_opening_token_mismatch"
    && planned?.spoken_text_sha256 === sha(sourceText)
    && selected?.spoken_text_sha256 === sha(sourceText)
    && reported?.spoken_text_sha256 === sha(sourceText)
    && reported?.audio_sha256 === selected?.audio_sha256
    && reported?.synthesis_identity_sha256 === selected?.synthesis_identity_sha256
    && selected?.synthesis_mode === "exact_sentence_boundary_composite_v1"
    && selected?.recovery_provenance?.request_sha256 === priorBoundaryRequest?.request_sha256
    && selected?.recovery_provenance?.result_sha256 === priorBoundaryResultFileSha256
    && priorBoundaryRequest?.schema === "goldflow_tts_exact_boundary_repair_request_v1"
    && priorBoundaryResult?.schema === "goldflow_tts_exact_boundary_repair_result_v1"
    && priorBoundaryResult?.request_sha256 === priorBoundaryRequest?.request_sha256
    && first?.fragments?.length === 2
    && first.fragments[0] === intended
    && first.fragments[1] === remainder
    && fragmentRows.length === 2
    && fragmentRows[0]?.text_sha256 === sha(intended)
    && fragmentRows[1]?.text_sha256 === sha(remainder)
    && repaired?.audio_sha256 === selected?.audio_sha256;
  if (!defectValid) throw new Error("User-heard pronunciation defect is not bound to one current exact opening and its immutable boundary fragments.");
  return { unit_id: unitId, intended_word: intended, heard_word: heard,
    tts_only_phonetic_word: phonetic, remainder_text: remainder,
    retained_remainder: fragmentRows[1] };
}

export function validatePronunciationCandidateReviewForTests({
  review, defect, request, result, candidateManifest,
  reviewFileSha256, defectFileSha256, requestFileSha256, resultFileSha256,
  candidateManifestFileSha256, candidateAudioFileSha256,
} = {}) {
  const row = candidateManifest?.units?.find((unit) => unit.unit_id === defect?.unit_id);
  const candidate = result?.unit;
  if (review?.schema !== PRONUNCIATION_REVIEW_SCHEMA
    || review.status !== "approved"
    || review.listener_role !== "user"
    || review.human_listening_performed !== true
    || review.operator_listening_performed !== false
    || review.attestation !== PRONUNCIATION_REVIEW_ATTESTATION
    || String(review.user_quote ?? "").trim().length < 4
    || !String(review.user_quote ?? "").toLocaleLowerCase()
      .includes(String(review.heard_word ?? "").toLocaleLowerCase())
    || String(review.review_note ?? "").trim().length < 20
    || Number.isNaN(Date.parse(review.reviewed_at))
    || review.unit_id !== defect.unit_id
    || review.heard_word !== defect.expected_word
    || review.defect_evidence_sha256 !== defectFileSha256
    || review.request_file_sha256 !== requestFileSha256
    || review.result_file_sha256 !== resultFileSha256
    || review.candidate_manifest_file_sha256 !== candidateManifestFileSha256
    || review.candidate_audio_path !== candidate?.audio_path
    || review.candidate_audio_sha256 !== candidate?.audio_sha256
    || review.candidate_audio_sha256 !== row?.audio_sha256
    || review.candidate_audio_sha256 !== candidateAudioFileSha256
    || row?.synthesis_mode !== PRONUNCIATION_MODE
    || row?.recovery_provenance?.request_sha256 !== request?.request_sha256
    || row?.recovery_provenance?.result_sha256 !== resultFileSha256
    || !hex(reviewFileSha256)) {
    throw new Error("Candidate listening review is missing, rejected, or hash-stale.");
  }
  return { unit_id: defect.unit_id, review_file_sha256: reviewFileSha256 };
}

export function validatePronunciationCandidateArtifactsForTests({
  defect, defectFileSha256, request, requestFileSha256, result, resultFileSha256,
  priorManifest, priorManifestFileSha256, candidateManifest,
  candidateAudioFileSha256, phoneticAudioFileSha256,
  phoneticSidecarFileSha256, remainderAudioFileSha256,
  remainderSidecarFileSha256,
  synthesisMode = PRONUNCIATION_MODE,
  candidateReviewStatus = "pending_user_listening",
} = {}) {
  const id = String(defect?.unit_id ?? "");
  const oldRows = priorManifest?.units ?? [];
  const newRows = candidateManifest?.units ?? [];
  const old = oldRows.find((row) => row.unit_id === id);
  const selected = newRows.find((row) => row.unit_id === id);
  const made = result?.unit;
  const phonetic = made?.phonetic_fragment;
  const retained = made?.retained_remainder;
  const otherRowsUnchanged = oldRows.length === newRows.length
    && oldRows.every((row, index) => row.unit_id === id
      || JSON.stringify(row) === JSON.stringify(newRows[index]));
  if (request?.schema !== PRONUNCIATION_REQUEST_SCHEMA
    || result?.schema !== PRONUNCIATION_RESULT_SCHEMA
    || request.request_sha256 !== canonicalHash(Object.fromEntries(
      Object.entries(request).filter(([key]) => key !== "request_sha256")))
    || request.defect_evidence_sha256 !== defectFileSha256
    || request.prior_manifest_file_sha256 !== priorManifestFileSha256
    || request.prior_manifest_sha256 !== priorManifest?.manifest_sha256
    || request.unit_id !== id
    || request.spoken_text_sha256 !== old?.spoken_text_sha256
    || request.prior_audio_sha256 !== old?.audio_sha256
    || request.prior_synthesis_identity_sha256 !== old?.synthesis_identity_sha256
    || request.expected_word !== defect.expected_word
    || request.tts_only_phonetic_word !== defect.tts_only_phonetic_word
    || !hex(requestFileSha256)
    || !hex(resultFileSha256)
    || result.request_sha256 !== request.request_sha256
    || result.request_file_sha256 !== requestFileSha256
    || made?.unit_id !== id
    || made?.spoken_text_sha256 !== old.spoken_text_sha256
    || made?.audio_sha256 !== candidateAudioFileSha256
    || phonetic?.text !== request.tts_only_phonetic_word
    || phonetic?.text_sha256 !== sha(request.tts_only_phonetic_word)
    || phonetic?.request_sha256 !== request.request_sha256
    || phonetic?.unit_id !== id
    || phonetic?.model_id !== request.model_id
    || phonetic?.model_revision !== request.model_revision
    || phonetic?.voice_id !== request.voice_id
    || phonetic?.voice_sha256 !== request.voice_sha256
    || Number(phonetic?.generated_token_count) >= Number(phonetic?.effective_token_limit)
    || !Number.isFinite(Number(phonetic?.generated_token_count))
    || !Number.isFinite(Number(phonetic?.effective_token_limit))
    || phonetic?.audio_sha256 !== phoneticAudioFileSha256
    || phonetic?.sidecar_sha256 !== phoneticSidecarFileSha256
    || retained?.audio_sha256 !== remainderAudioFileSha256
    || retained?.sidecar_sha256 !== remainderSidecarFileSha256
    || retained?.audio_sha256 !== request.retained_remainder?.audio_sha256
    || retained?.sidecar_sha256 !== request.retained_remainder?.sidecar_sha256
    || candidateManifest?.status !== "passed"
    || selected?.audio_sha256 !== made.audio_sha256
    || selected?.audio_path !== made.audio_path
    || selected?.synthesis_mode !== synthesisMode
    || selected?.spoken_text_sha256 !== old.spoken_text_sha256
    || selected?.recovery_provenance?.schema !== "goldflow_tts_pronunciation_candidate_provenance_v1"
    || selected?.recovery_provenance?.request_sha256 !== request.request_sha256
    || selected?.recovery_provenance?.result_sha256 !== resultFileSha256
    || selected?.recovery_provenance?.defect_evidence_sha256 !== defectFileSha256
    || selected?.recovery_provenance?.prior_audio_sha256 !== old.audio_sha256
    || selected?.recovery_provenance?.candidate_review_status !== candidateReviewStatus
    || !otherRowsUnchanged) {
    throw new Error("Pronunciation candidate or preserved provider selections are stale or mismatched.");
  }
  return { unit_id: id, preserved_unit_count: oldRows.length - 1 };
}

export function validateSelectedPronunciationReviewForTests({
  review, reviewFileSha256, sourceScriptSha256, plan, planFileSha256,
  report, reportFileSha256, delivery, deliveryFileSha256,
  manifest, manifestFileSha256, selectedAudioFileSha256,
} = {}) {
  const unitId = String(review?.unit_id ?? "");
  const planned = (plan?.units ?? []).find((row) => row.unit_id === unitId);
  const selected = (manifest?.units ?? []).find((row) => row.unit_id === unitId);
  const delivered = (delivery?.units ?? []).find((row) => row.unit_id === unitId);
  const expectedWord = String(review?.expected_word ?? "");
  if (review?.schema !== PRONUNCIATION_SELECTED_REVIEW_SCHEMA
    || review.status !== "approved"
    || review.listener_role !== "user"
    || review.human_listening_performed !== true
    || review.operator_listening_performed !== false
    || review.attestation !== PRONUNCIATION_SELECTED_REVIEW_ATTESTATION
    || String(review.user_quote ?? "").trim().length < 4
    || !String(review.user_quote ?? "").toLocaleLowerCase()
      .includes(String(review.heard_word ?? "").toLocaleLowerCase())
    || String(review.review_note ?? "").trim().length < 20
    || Number.isNaN(Date.parse(review.reviewed_at))
    || !word(expectedWord)
    || !String(planned?.spoken_text ?? "").startsWith(`${expectedWord} `)
    || review.heard_word !== expectedWord
    || review.source_script_sha256 !== sourceScriptSha256
    || sourceScriptSha256 !== plan?.source_script_hash
    || review.narration_generation_plan_sha256 !== plan?.plan_sha256
    || review.narration_generation_plan_file_sha256 !== planFileSha256
    || review.prior_narration_report_sha256 !== reportFileSha256
    || review.prior_unit_delivery_qa_sha256 !== deliveryFileSha256
    || review.prior_provider_manifest_file_sha256 !== manifestFileSha256
    || review.selected_audio_path !== selected?.audio_path
    || review.selected_audio_sha256 !== selected?.audio_sha256
    || review.selected_audio_sha256 !== selectedAudioFileSha256
    || review.selected_synthesis_identity_sha256 !== selected?.synthesis_identity_sha256
    || report?.status !== "blocked"
    || report?.unit_qa_status !== "blocked"
    || report?.full_stream_qa_status !== "not_run_due_to_unit_blockers"
    || report?.provider_output_manifest_sha256 !== manifestFileSha256
    || delivery?.status !== "blocked"
    || report?.blockers?.length !== 1
    || report.blockers[0]?.unit_id !== unitId
    || report.blockers[0]?.code !== "narration_confirmed_opening_token_mismatch"
    || delivery?.blockers?.length !== 1
    || delivery.blockers[0]?.unit_id !== unitId
    || delivery.blockers[0]?.code !== "narration_confirmed_opening_token_mismatch"
    || delivered?.audio_sha256 !== selected?.audio_sha256
    || !laterWordsMatchBothAsr(delivered?.transcript_qa,
      delivered?.confirmation_transcript_qa)
    || delivered?.decision?.blockers?.length !== 1
    || delivered.decision.blockers[0]?.code !== "narration_confirmed_opening_token_mismatch"
    || selected?.synthesis_mode !== "exact_sentence_boundary_composite_v1"
    || !hex(reviewFileSha256)) {
    throw new Error("Selected-unit listening approval is absent, broad, or hash-stale.");
  }
  return { unit_id: unitId, review_file_sha256: reviewFileSha256 };
}

export function applyPronunciationCandidateReviewForTests({
  decision, unitId, reviewedUnitId, reviewFileSha256,
  primaryTranscriptQa, confirmationTranscriptQa,
} = {}) {
  if (unitId !== reviewedUnitId) return decision;
  if (!laterWordsMatchBothAsr(primaryTranscriptQa, confirmationTranscriptQa)) {
    throw new Error("User opening-word listening cannot clear a later-word ASR difference.");
  }
  const blockers = decision?.blockers ?? [];
  if (blockers.length === 0) return { ...decision,
    user_pronunciation_review: { status: "approved", review_file_sha256: reviewFileSha256 } };
  if (blockers.length !== 1
    || blockers[0].code !== "narration_confirmed_opening_token_mismatch") {
    throw new Error("User listening cannot override a different narration delivery or acoustic defect.");
  }
  return { ...decision, status: "passed_with_warnings", blockers: [],
    review_required: false,
    warnings: [...(decision.warnings ?? []), { ...blockers[0],
      severity: "warning", original_severity: "blocker", review_required: false,
      user_listening_confirmed: true, review_file_sha256: reviewFileSha256 }],
    user_pronunciation_review: { status: "approved", review_file_sha256: reviewFileSha256 } };
}

// A blocked TTS stage admits neither a free-form phonetic retry nor an
// unreviewed provider manifest. The command must be precisely the one status
// derived from current episode-local evidence.
export function pronunciationGuardAdmission(status, command, subcommand, flags = {}) {
  const repair = command === "tts" && subcommand === "repair-pronunciation";
  const automatedRepair = command === "tts" && subcommand === "repair-pronunciation-auto";
  const finalize = command === "tts" && subcommand === "finalize-provider"
    && flags["pronunciation-review-evidence"] != null;
  const automatedFinalize = command === "tts" && subcommand === "finalize-provider"
    && flags["automated-pronunciation-evidence"] != null;
  if (!repair && !automatedRepair && !finalize && !automatedFinalize) {
    return { applicable: false, allowed: false };
  }
  const episodeDir = String(status?.episode_dir ?? "");
  const evidence = String(flags[repair || automatedRepair ? "evidence"
    : automatedFinalize ? "automated-pronunciation-evidence"
      : "pronunciation-review-evidence"] ?? "");
  const manifest = String(flags.manifest ?? "");
  const expected = repair || automatedRepair
    ? `node bin/goldflow.mjs tts repair-pronunciation${automatedRepair ? "-auto" : ""} --episode-dir ${episodeDir} --evidence ${evidence}`
    : `node bin/goldflow.mjs tts finalize-provider --episode-dir ${episodeDir} --manifest ${manifest} --${automatedFinalize
      ? "automated-pronunciation-evidence" : "pronunciation-review-evidence"} ${evidence}`;
  const exactFlags = Object.keys(flags).sort().join(",") === (repair
    ? "episode-dir,evidence" : automatedRepair
      ? "automated,episode-dir,evidence" : automatedFinalize
      ? "automated-pronunciation-evidence,episode-dir,manifest"
      : "episode-dir,manifest,pronunciation-review-evidence");
  const allowed = status?.current_stage === "qwen_tts_stitch"
    && status?.current_stage_state === "blocked"
    && exactFlags
    && (!automatedRepair || flags.automated === "true")
    && episodeDir.length > 0
    && path.resolve(String(flags["episode-dir"] ?? "")) === path.resolve(episodeDir)
    && path.isAbsolute(evidence)
    && path.resolve(evidence).startsWith(`${path.resolve(episodeDir)}${path.sep}`)
    && (!(finalize || automatedFinalize) || (path.isAbsolute(manifest)
      && path.resolve(manifest).startsWith(`${path.resolve(episodeDir)}${path.sep}`)))
    && status?.next_command_shape === expected;
  return { applicable: true, allowed,
    reason: allowed ? null : "Only the exact status-directed one-unit pronunciation review or repair is admitted." };
}
