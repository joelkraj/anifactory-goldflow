import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  applyPronunciationCandidateReviewForTests,
  pronunciationGuardAdmission,
  PRONUNCIATION_DEFECT_ATTESTATION,
  PRONUNCIATION_DEFECT_SCHEMA,
  PRONUNCIATION_SELECTED_REVIEW_ATTESTATION,
  PRONUNCIATION_SELECTED_REVIEW_SCHEMA,
  PRONUNCIATION_REVIEW_ATTESTATION,
  PRONUNCIATION_REVIEW_SCHEMA,
  validatePronunciationCandidateReviewForTests,
  validatePronunciationCandidateArtifactsForTests,
  validatePronunciationDefectEvidenceForTests,
  validateSelectedPronunciationReviewForTests,
} from "../lib/narration-pronunciation-repair.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const h = (value) => sha(`fixture:${value}`);
const id = "narr_voice_seg_001_u001";
const text = "Venn left without his sword.";
const sourceScriptSha256 = h("script");
const planFileSha256 = h("plan-file");
const reportFileSha256 = h("blocked-report");
const deliveryFileSha256 = h("blocked-delivery");
const manifestFileSha256 = h("prior-manifest-file");
const selectedAudioFileSha256 = h("selected-audio");
const priorBoundaryResultFileSha256 = h("boundary-result");
const selected = {
  unit_id: id, audio_path: "/tmp/test/selected.wav", audio_sha256: selectedAudioFileSha256,
  spoken_text_sha256: sha(text), synthesis_identity_sha256: h("synthesis"),
  synthesis_mode: "exact_sentence_boundary_composite_v1",
  recovery_provenance: { request_sha256: h("boundary-request"),
    result_sha256: priorBoundaryResultFileSha256 },
};
const plan = { source_script_hash: sourceScriptSha256, plan_sha256: h("plan"),
  units: [{ unit_id: id, spoken_text: text, spoken_text_sha256: sha(text) }] };
const blocker = { unit_id: id, code: "narration_confirmed_opening_token_mismatch" };
const exactLaterQa = { deletions: 0, insertions: 0,
  operations: [
    { type: "substitution", intended: "venn", recognized: "then" },
    ...["left", "without", "his", "sword"].map((token) => ({
      type: "match", intended: token, recognized: token,
    })),
  ] };
const report = { status: "blocked", unit_qa_status: "blocked",
  full_stream_qa_status: "not_run_due_to_unit_blockers",
  provider_output_manifest_sha256: manifestFileSha256,
  source_script_hash: sourceScriptSha256,
  narration_generation_plan_sha256: plan.plan_sha256,
  narration_generation_plan_file_sha256: planFileSha256,
  blockers: [blocker], results: [{ unit_id: id, spoken_text_sha256: sha(text),
    audio_sha256: selectedAudioFileSha256,
    synthesis_identity_sha256: selected.synthesis_identity_sha256 }] };
const delivery = { status: "blocked", source_script_hash: sourceScriptSha256,
  narration_generation_plan_sha256: plan.plan_sha256, blockers: [blocker],
  units: [{ unit_id: id, audio_sha256: selectedAudioFileSha256,
    transcript_qa: exactLaterQa, confirmation_transcript_qa: exactLaterQa,
    decision: { status: "blocked", blockers: [blocker] } }] };
const manifest = { units: [selected] };
const boundaryRequest = { schema: "goldflow_tts_exact_boundary_repair_request_v1",
  request_sha256: h("boundary-request"),
  units: [{ unit_id: id, fragments: ["Venn", "left without his sword."] }] };
const boundaryResult = { schema: "goldflow_tts_exact_boundary_repair_result_v1",
  request_sha256: h("boundary-request"),
  units: [{ unit_id: id, audio_sha256: selectedAudioFileSha256,
    fragments: [{ text_sha256: sha("Venn") }, {
      text_sha256: sha("left without his sword."),
      audio_path: "/tmp/test/remainder.wav", audio_sha256: h("remainder"),
      sidecar_path: "/tmp/test/remainder.json", sidecar_sha256: h("remainder-sidecar"),
    }] }] };
const common = { sourceScriptSha256, plan, planFileSha256, report,
  reportFileSha256, delivery, deliveryFileSha256, manifest,
  manifestFileSha256, selectedAudioFileSha256 };
const reviewedAt = "2026-10-01T19:00:00Z";

const defect = { schema: PRONUNCIATION_DEFECT_SCHEMA, status: "reviewed",
  listener_role: "user", human_listening_performed: true,
  operator_listening_performed: false, attestation: PRONUNCIATION_DEFECT_ATTESTATION,
  user_quote: "I hear Then", review_note: "The user identified the opening word as Then in the exact clip.",
  reviewed_at: reviewedAt, unit_id: id, expected_word: "Venn", heard_word: "Then",
  tts_only_phonetic_word: "Ven", source_script_sha256: sourceScriptSha256,
  narration_generation_plan_sha256: plan.plan_sha256,
  narration_generation_plan_file_sha256: planFileSha256,
  prior_narration_report_sha256: reportFileSha256,
  prior_unit_delivery_qa_sha256: deliveryFileSha256,
  prior_provider_manifest_file_sha256: manifestFileSha256,
  prior_audio_sha256: selectedAudioFileSha256,
  prior_synthesis_identity_sha256: selected.synthesis_identity_sha256,
  prior_boundary_result_sha256: priorBoundaryResultFileSha256 };
const defectArgs = { evidence: defect, evidenceFileSha256: h("defect-file"),
  ...common, priorBoundaryRequest: boundaryRequest, priorBoundaryResult: boundaryResult,
  priorBoundaryResultFileSha256 };
assert.equal(validatePronunciationDefectEvidenceForTests(defectArgs).unit_id, id);
assert.throws(() => validatePronunciationDefectEvidenceForTests({ ...defectArgs,
  evidence: { ...defect, human_listening_performed: false } }), /user-heard/i);
assert.throws(() => validatePronunciationDefectEvidenceForTests({ ...defectArgs,
  evidence: { ...defect, prior_audio_sha256: h("other-take") } }), /user-heard/i);
assert.throws(() => validatePronunciationDefectEvidenceForTests({ ...defectArgs,
  priorBoundaryRequest: { ...boundaryRequest,
    units: [{ unit_id: id, fragments: ["Venn", "wrong remainder"] }] } }), /user-heard/i);
assert.throws(() => validatePronunciationDefectEvidenceForTests({ ...defectArgs,
  report: { ...report, blockers: [blocker, { ...blocker, unit_id: "other" }] } }), /user-heard/i);

const selectedReview = { schema: PRONUNCIATION_SELECTED_REVIEW_SCHEMA,
  status: "approved", listener_role: "user", human_listening_performed: true,
  operator_listening_performed: false,
  attestation: PRONUNCIATION_SELECTED_REVIEW_ATTESTATION,
  user_quote: "I hear Venn", review_note: "The user identified the opening word as the intended name.",
  reviewed_at: reviewedAt, unit_id: id,
  expected_word: "Venn", heard_word: "Venn",
  source_script_sha256: sourceScriptSha256,
  narration_generation_plan_sha256: plan.plan_sha256,
  narration_generation_plan_file_sha256: planFileSha256,
  prior_narration_report_sha256: reportFileSha256,
  prior_unit_delivery_qa_sha256: deliveryFileSha256,
  prior_provider_manifest_file_sha256: manifestFileSha256,
  selected_audio_path: selected.audio_path,
  selected_audio_sha256: selectedAudioFileSha256,
  selected_synthesis_identity_sha256: selected.synthesis_identity_sha256 };
assert.equal(validateSelectedPronunciationReviewForTests({
  review: selectedReview, reviewFileSha256: h("selected-review"), ...common,
}).unit_id, id);
assert.throws(() => validateSelectedPronunciationReviewForTests({
  review: { ...selectedReview, heard_word: "Then" },
  reviewFileSha256: h("selected-review"), ...common,
}), /listening approval/i);
assert.throws(() => validateSelectedPronunciationReviewForTests({
  review: selectedReview, reviewFileSha256: h("selected-review"), ...common,
  delivery: { ...delivery, units: [{ ...delivery.units[0],
    confirmation_transcript_qa: { ...exactLaterQa,
      operations: [exactLaterQa.operations[0], { type: "substitution" },
        ...exactLaterQa.operations.slice(2)] } }] },
}), /listening approval/i);

const candidateManifest = { units: [{ unit_id: id, audio_path: "/tmp/test/candidate.wav",
  audio_sha256: h("candidate-audio"), synthesis_mode: "user_heard_pronunciation_fragment_v1",
  recovery_provenance: { request_sha256: h("request"), result_sha256: h("result") } }] };
const request = { request_sha256: h("request") };
const result = { unit: { audio_path: "/tmp/test/candidate.wav",
  audio_sha256: h("candidate-audio") } };
const candidateReview = { schema: PRONUNCIATION_REVIEW_SCHEMA,
  status: "approved", listener_role: "user", human_listening_performed: true,
  operator_listening_performed: false,
  attestation: PRONUNCIATION_REVIEW_ATTESTATION,
  user_quote: "I hear Venn", review_note: "The user identified the candidate opening as Venn.",
  reviewed_at: reviewedAt, unit_id: id,
  heard_word: "Venn", defect_evidence_sha256: h("defect-file"),
  request_file_sha256: h("request-file"), result_file_sha256: h("result"),
  candidate_manifest_file_sha256: h("candidate-manifest"),
  candidate_audio_path: "/tmp/test/candidate.wav",
  candidate_audio_sha256: h("candidate-audio") };
const candidateArgs = { review: candidateReview, defect, request, result,
  candidateManifest, reviewFileSha256: h("candidate-review"),
  defectFileSha256: h("defect-file"), requestFileSha256: h("request-file"),
  resultFileSha256: h("result"), candidateManifestFileSha256: h("candidate-manifest"),
  candidateAudioFileSha256: h("candidate-audio") };
assert.equal(validatePronunciationCandidateReviewForTests(candidateArgs).unit_id, id);
assert.throws(() => validatePronunciationCandidateReviewForTests({ ...candidateArgs,
  review: { ...candidateReview, candidate_audio_sha256: h("changed") } }), /hash-stale/i);
assert.throws(() => validatePronunciationCandidateReviewForTests({ ...candidateArgs,
  review: { ...candidateReview, attestation: "not_listened" } }), /hash-stale/i);

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value;
const before = { ...manifest, manifest_sha256: h("manifest-canonical"),
  units: [{ unit_id: "other-1", audio_sha256: h("other-1") }, selected,
    { unit_id: "other-2", audio_sha256: h("other-2") }] };
const requestArtifact = {
  schema: "goldflow_tts_exact_pronunciation_request_v1",
  defect_evidence_sha256: h("defect-file"),
  prior_manifest_file_sha256: manifestFileSha256,
  prior_manifest_sha256: before.manifest_sha256,
  unit_id: id, spoken_text_sha256: selected.spoken_text_sha256,
  prior_audio_sha256: selected.audio_sha256,
  prior_synthesis_identity_sha256: selected.synthesis_identity_sha256,
  expected_word: "Venn", tts_only_phonetic_word: "Ven",
  model_id: "pinned-model", model_revision: "pinned-revision",
  voice_id: "voice", voice_sha256: h("voice"),
  retained_remainder: { audio_sha256: h("remainder"),
    sidecar_sha256: h("remainder-sidecar") },
};
requestArtifact.request_sha256 = sha(JSON.stringify(canonical(requestArtifact)));
const made = { unit_id: id, spoken_text_sha256: selected.spoken_text_sha256,
  audio_path: "/tmp/test/candidate.wav", audio_sha256: h("candidate-audio"),
  phonetic_fragment: { request_sha256: requestArtifact.request_sha256,
    unit_id: id, text: "Ven", text_sha256: sha("Ven"),
    model_id: "pinned-model", model_revision: "pinned-revision",
    voice_id: "voice", voice_sha256: h("voice"),
    generated_token_count: 9, effective_token_limit: 1200,
    audio_sha256: h("phonetic-audio"), sidecar_sha256: h("phonetic-sidecar") },
  retained_remainder: requestArtifact.retained_remainder };
const after = { status: "passed", units: [before.units[0], {
  ...selected, audio_path: made.audio_path, audio_sha256: made.audio_sha256,
  synthesis_mode: "user_heard_pronunciation_fragment_v1",
  recovery_provenance: {
    schema: "goldflow_tts_pronunciation_candidate_provenance_v1",
    request_sha256: requestArtifact.request_sha256,
    result_sha256: h("result-file"),
    defect_evidence_sha256: h("defect-file"),
    prior_audio_sha256: selected.audio_sha256,
    candidate_review_status: "pending_user_listening",
  },
}, before.units[2]] };
const artifactArgs = {
  defect, defectFileSha256: h("defect-file"),
  request: requestArtifact, requestFileSha256: h("request-file"),
  result: { schema: "goldflow_tts_exact_pronunciation_result_v1",
    request_sha256: requestArtifact.request_sha256,
    request_file_sha256: h("request-file"), unit: made },
  resultFileSha256: h("result-file"), priorManifest: before,
  priorManifestFileSha256: manifestFileSha256, candidateManifest: after,
  candidateAudioFileSha256: h("candidate-audio"),
  phoneticAudioFileSha256: h("phonetic-audio"),
  phoneticSidecarFileSha256: h("phonetic-sidecar"),
  remainderAudioFileSha256: h("remainder"),
  remainderSidecarFileSha256: h("remainder-sidecar"),
};
assert.equal(validatePronunciationCandidateArtifactsForTests(artifactArgs).preserved_unit_count, 2);
assert.throws(() => validatePronunciationCandidateArtifactsForTests({ ...artifactArgs,
  candidateManifest: { ...after, units: [
    { ...before.units[0], audio_sha256: h("silently-changed") }, ...after.units.slice(1),
  ] },
}), /selections are stale/i);

const opening = { status: "blocked", blockers: [blocker], warnings: [] };
const accepted = applyPronunciationCandidateReviewForTests({ decision: opening,
  unitId: id, reviewedUnitId: id, reviewFileSha256: h("candidate-review"),
  primaryTranscriptQa: exactLaterQa, confirmationTranscriptQa: exactLaterQa });
assert.equal(accepted.status, "passed_with_warnings");
assert.equal(accepted.blockers.length, 0);
assert.equal(accepted.warnings[0].user_listening_confirmed, true);
assert.deepEqual(applyPronunciationCandidateReviewForTests({ decision: opening,
  unitId: "other", reviewedUnitId: id, reviewFileSha256: h("candidate-review") }), opening);
assert.throws(() => applyPronunciationCandidateReviewForTests({
  decision: { status: "blocked", blockers: [{ code: "tts_audio_clipping" }] },
  unitId: id, reviewedUnitId: id, reviewFileSha256: h("candidate-review"),
  primaryTranscriptQa: exactLaterQa, confirmationTranscriptQa: exactLaterQa,
}), /cannot override/i);
assert.throws(() => applyPronunciationCandidateReviewForTests({
  decision: opening, unitId: id, reviewedUnitId: id,
  reviewFileSha256: h("candidate-review"),
  primaryTranscriptQa: exactLaterQa,
  confirmationTranscriptQa: { ...exactLaterQa,
    operations: [exactLaterQa.operations[0], { type: "deletion" },
      ...exactLaterQa.operations.slice(2)], deletions: 1 },
}), /later-word ASR difference/i);

const episodeDir = "/tmp/episode";
const evidence = path.join(episodeDir, "narration_user_heard_pronunciation_defect_ep_01.json");
const status = { episode_dir: episodeDir, current_stage: "qwen_tts_stitch",
  current_stage_state: "blocked",
  next_command_shape: `node bin/goldflow.mjs tts repair-pronunciation --episode-dir ${episodeDir} --evidence ${evidence}` };
assert.equal(pronunciationGuardAdmission(status, "tts", "repair-pronunciation",
  { "episode-dir": episodeDir, evidence }).allowed, true);
assert.equal(pronunciationGuardAdmission(status, "tts", "repair-pronunciation",
  { "episode-dir": episodeDir, evidence, extra: "true" }).allowed, false);
assert.equal(pronunciationGuardAdmission({ ...status, current_stage_state: "passed" },
  "tts", "repair-pronunciation", { "episode-dir": episodeDir, evidence }).allowed, false);
const review = path.join(episodeDir, "narration_pronunciation_candidate_listen_ep_01.json");
const manifestPath = path.join(episodeDir, "assets/audio/candidate.json");
const finalStatus = { ...status, next_command_shape:
  `node bin/goldflow.mjs tts finalize-provider --episode-dir ${episodeDir} --manifest ${manifestPath} --pronunciation-review-evidence ${review}` };
assert.equal(pronunciationGuardAdmission(finalStatus, "tts", "finalize-provider",
  { "episode-dir": episodeDir, manifest: manifestPath,
    "pronunciation-review-evidence": review }).allowed, true);
assert.equal(pronunciationGuardAdmission(finalStatus, "tts", "finalize-provider",
  { "episode-dir": episodeDir, manifest: "/tmp/other.json",
    "pronunciation-review-evidence": review }).allowed, false);
console.log("narration pronunciation repair contracts passed");
