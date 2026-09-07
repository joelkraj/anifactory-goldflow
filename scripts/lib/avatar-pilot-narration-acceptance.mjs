import path from "node:path";
import { createHash } from "node:crypto";
import { readBound } from "./avatar-pilot-opening-producer.mjs";
import { validateNarrationSubjectiveReviewDecision, NARRATION_SUBJECTIVE_REVIEW_ATTESTATION } from "./narration-subjective-review.mjs";
import { localWhisperContractForIdentity } from "./local-whisper-policy.mjs";
import { validateLocalWhisperTimingCandidate } from "./local-whisper-timing-candidate.mjs";
import { reusableCanonicalFullStreamQaForTiming } from "../local-whisper-word-timing.mjs";

export const PILOT_NARRATION_ACCEPTANCE_SCHEMA = "goldflow_avatar_pilot_narration_accepted_v1";
export const PILOT_NARRATION_LISTEN_ATTESTATION = "entire_proof_narration_listened_end_to_end";
const need = (ok, message) => { if (!ok) throw new Error(message); };
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const json = async (ref) => JSON.parse((await readBound(ref)).toString("utf8"));
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Pilot-specific consumer adapter, not a renamed official generated-lane
 * timing artifact. It preserves every actual Whisper observation and exposes
 * the compositor's explicitly named start/end aliases without another ASR run. */
export function buildPilotNarrationTiming({ result, candidate, delivery, identity }) {
  const contract = localWhisperContractForIdentity(identity);
  need(validateLocalWhisperTimingCandidate(candidate, { contract,
    sourceScriptSha256: result.source_script_sha256, narrationAudioSha256: result.finalization_artifacts.audio.sha256,
    narrationReportSha256: result.finalization_artifacts.stitch_report.sha256, runIdentitySha256: result.identity_sha256,
    narrationQualityContractSha256: identity.narration_quality_contract.contract_sha256 }).status === "passed", "Full narration timing candidate invalid.");
  need(candidate.finalization_scope?.phase === "full_pilot" && candidate.finalization_scope.complete_episode === true,
    "An opening timing candidate cannot become full proof timing.");
  need(reusableCanonicalFullStreamQaForTiming({ artifact: delivery,
    sourceScriptHash: result.source_script_sha256, narrationAudioSha256: result.finalization_artifacts.audio.sha256,
    narrationQualityContractSha256: identity.narration_quality_contract.contract_sha256, runtimeContract: contract,
    alignmentModel: candidate.alignment_model, recognizedText: candidate.recognized_text, recognizedWords: candidate.words }).status === "reusable",
  "Full narration timing lacks matching canonical stream consensus.");
  const timing = { schema: "goldflow_avatar_pilot_word_timing_v1", status: "passed", phase: "full_pilot",
    production_eligible: false, publish_allowed: false, source_script_hash: result.source_script_sha256,
    narration_audio_hash: result.finalization_artifacts.audio.sha256, run_identity_sha256: result.identity_sha256,
    narration_report_sha256: result.finalization_artifacts.stitch_report.sha256,
    full_stream_qa: result.finalization_artifacts.full_stream_qa, timing_candidate: result.finalization_artifacts.timing_candidate,
    candidate_sha256: candidate.candidate_sha256, alignment_contract: contract,
    audio_duration_sec: candidate.audio_duration_sec, word_count: candidate.words.length,
    words: candidate.words.map((word, index) => ({ ...word, index, start: word.start_sec, end: word.end_sec })),
    mapping: "identity_aliases_from_exact_validated_canonical_faster_whisper_candidate_no_retranscription",
  };
  return { ...timing, timing_sha256: digest(timing) };
}

/** Final narration gate: real technical result AND a separately recorded full
 * listening decision. This is also the only new narration media import route. */
export async function validatePilotNarrationAcceptance(payload, { episodeDir, identity } = {}) {
  try {
    need(payload?.schema === PILOT_NARRATION_ACCEPTANCE_SCHEMA && payload.production_eligible === false
      && payload.publish_allowed === false && payload.review?.approved === true
      && payload.review.attestation === PILOT_NARRATION_LISTEN_ATTESTATION
      && typeof payload.review.reviewer === "string" && payload.review.reviewer.trim()
      && typeof payload.review.note === "string" && payload.review.note.trim(), "Full narration requires a genuine complete listening review.");
    const workRoot = path.join(episodeDir, "pilot_narration_work");
    need(["narration_producer_result.json", "narration_reviewed_result.json"].some((name) => payload.narration_result?.path === path.join(workRoot, name)), "Only the original produced or authenticated reviewed narration candidate is accepted.");
    const result = await json(payload.narration_result);
    need(payload.narration_result.path === path.join(workRoot, result.review_continuation ? "narration_reviewed_result.json" : "narration_producer_result.json"), "Narration result phase/path mismatch.");
    const outputDir = path.join(workRoot, result.review_continuation ? "full_finalization_reviewed" : "full_finalization");
    const { validatePilotNarrationResult } = await import("./avatar-pilot-narration-validation.mjs");
    const technical = await validatePilotNarrationResult(result, { episodeDir, identity });
    need(technical.status === "passed", `Full narration technical validation blocked: ${JSON.stringify(technical.findings)}`);
    need(same(payload.audio, result.finalization_artifacts.audio), "Accepted narration audio differs from the produced take.");
    need(payload.subjective_decision?.path === path.join(outputDir, `narration_subjective_review_decision_${identity.episode}.json`), "Full narration listening decision namespace invalid.");
    const manifest = await json(result.finalization_artifacts.subjective_manifest), decision = await json(payload.subjective_decision);
    need(validateNarrationSubjectiveReviewDecision(manifest, decision).status === "approved"
      && decision.reviewer === payload.review.reviewer && decision.decisions.every((row) => row.decision === "accept" && row.note === payload.review.note), "Full narration listening decision invalid.");
    const mapping = payload.listening_attestation_mapping;
    need(mapping?.operator_attestation === PILOT_NARRATION_LISTEN_ATTESTATION
      && mapping.canonical_attestation === NARRATION_SUBJECTIVE_REVIEW_ATTESTATION
      && mapping.audio_sha256 === payload.audio.sha256 && mapping.manifest_sha256 === result.finalization_artifacts.subjective_manifest.sha256
      && mapping.all_samples_contained_in_full_narration === true
      && same(mapping.sample_ids, manifest.samples.map((sample) => sample.sample_id)), "Full narration listening mapping is stale.");
    need(payload.whisper_timing?.path === path.join(outputDir, "pilot_word_timing.json"), "Pilot timing namespace invalid.");
    const timing = await json(payload.whisper_timing);
    const expected = buildPilotNarrationTiming({ result, candidate: await json(result.finalization_artifacts.timing_candidate),
      delivery: await json(result.finalization_artifacts.full_stream_qa), identity });
    need(same(timing, expected), "Pilot timing changed its exact canonical observations.");
    return { status: "passed", findings: [], audio: payload.audio, duration_sec: technical.duration_sec };
  } catch (error) { return { status: "blocked", findings: [{ code: error.message }] }; }
}
