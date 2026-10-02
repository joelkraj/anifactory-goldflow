// One source-preserving TTS-only expansion for the past-perfect opening
// "She’d looked". This is a scoped candidate repair, never an ASR waiver.
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256File } from "./file-hash.mjs";
import { pcm, pcmInfo } from "./narration-full-stream-contextual-asr.mjs";
import {
  narrationProviderOutputManifestSha256,
  narrationSynthesisIdentitySha256,
  validateNarrationProviderOutputManifest,
} from "./narration-provider-adapter.mjs";
import { transcriptQaForTests } from "../modelslab-qwen-episode-audio.mjs";

export const CONTRACTION_EVIDENCE_SCHEMA = "goldflow_tts_reviewed_contraction_expansion_v1";
export const CONTRACTION_REQUEST_SCHEMA = "goldflow_tts_exact_contraction_request_v1";
export const CONTRACTION_RESULT_SCHEMA = "goldflow_tts_exact_contraction_result_v1";
export const CONTRACTION_MODE = "exact_past_perfect_contraction_expansion_v1";
export const CONTRACTION_TARGET_UNIT_ID = "narr_voice_seg_84_u001-002_3193dd7890af";
export const CONTRACTION_ALIAS = Object.freeze({
  from: "She’d looked at me", to: "She had looked at me",
});
const FIRST = CONTRACTION_ALIAS.from;
const EXPANDED = CONTRACTION_ALIAS.to;
export const CONTRACTION_SOURCE_UNIT = "She’d looked at me in the mirror. She knew where she was going.";
const SOURCE_UNIT = CONTRACTION_SOURCE_UNIT;
const REMAINDER = "in the mirror. She knew where she was going.";
const SHA = /^[a-f0-9]{64}$/u;
const sha = (value) => createHash("sha256").update(String(value)).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value;
const read = async (name) => JSON.parse(await fs.readFile(name, "utf8"));
const inside = (root, target) => typeof target === "string" && path.isAbsolute(target)
  && path.resolve(target).startsWith(`${path.resolve(root)}${path.sep}`);
const need = (ok, message) => { if (!ok) throw new Error(`Contraction expansion: ${message}.`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const word = (value) => String(value ?? "").toLowerCase().replace(/[^a-z]/gu, "");

export function contractionSegmentReportFieldsForTests({ row, timing,
  evidenceSha256 } = {}) {
  const marker = row?.tts_only_contraction_expansion;
  need(row?.unit_id === CONTRACTION_TARGET_UNIT_ID
    && row.text === SOURCE_UNIT && row.caption_text === SOURCE_UNIT
    && row.caption_text_sha256 === sha(SOURCE_UNIT)
    && same(row.asr_equivalent_phrases, [CONTRACTION_ALIAS])
    && marker?.source_token === "She’d"
    && same(marker.spoken_words, ["She", "had"])
    && marker.source_phrase === FIRST && marker.spoken_phrase === EXPANDED
    && marker.evidence_sha256 === evidenceSha256
    && SHA.test(evidenceSha256 ?? "")
    && timing?.unit_id === CONTRACTION_TARGET_UNIT_ID
    && Number.isInteger(timing.start_sample) && timing.start_sample >= 0
    && Number.isInteger(timing.end_sample_exclusive)
    && timing.end_sample_exclusive > timing.start_sample
    && Math.abs(Number(timing.start_sec) - timing.start_sample / 24000) < 0.000001
    && Math.abs(Number(timing.end_sec) - timing.end_sample_exclusive / 24000) < 0.000001,
  "final report lost the exact source caption or stitched word span");
  return { caption_text: row.caption_text,
    caption_text_sha256: row.caption_text_sha256,
    start_sec: timing.start_sec, end_sec: timing.end_sec,
    start_sample: timing.start_sample,
    end_sample_exclusive: timing.end_sample_exclusive,
    asr_equivalent_phrases: row.asr_equivalent_phrases,
    tts_only_contraction_expansion: marker };
}

export function contractionCaptionWordSpanForTests({ segments, words } = {}) {
  const marked = (segments ?? []).filter((row) => row.tts_only_contraction_expansion);
  if (!marked.length) return null;
  need(marked.length === 1 && marked[0].unit_id === CONTRACTION_TARGET_UNIT_ID,
    "caption timing includes an unexpected contraction expansion");
  const target = marked[0];
  const marker = target.tts_only_contraction_expansion;
  need(target.caption_text === SOURCE_UNIT && target.text === SOURCE_UNIT
    && marker.source_token === "She’d"
    && same(marker.spoken_words, ["She", "had"])
    && marker.source_phrase === FIRST && marker.spoken_phrase === EXPANDED
    && SHA.test(marker.evidence_sha256 ?? ""),
  "caption or source contraction marker changed");
  const start = Number(target.start_sec);
  const end = Number(target.end_sec);
  need(Number.isFinite(start) && Number.isFinite(end) && end > start,
    "source contraction lacks exact stitched sample offsets");
  const indexed = (words ?? []).map((row, index) => ({ ...row, index }))
    .filter((row) => {
      const midpoint = (Number(row.start_sec) + Number(row.end_sec)) / 2;
      return midpoint >= start - 0.35 && midpoint <= end + 0.35;
    });
  const at = indexed.findIndex((row, index) => word(row.word) === "she"
    && word(indexed[index + 1]?.word) === "had"
    && word(indexed[index + 2]?.word) === "looked"
    && Number(row.start_sec) <= start + 0.55);
  need(at >= 0, "the captioned contraction is not aligned to spoken She had looked");
  const she = indexed[at]; const had = indexed[at + 1];
  need(Number.isFinite(Number(she.start_sec))
    && Number(she.end_sec) > Number(she.start_sec)
    && Number(had.start_sec) >= Number(she.start_sec)
    && Number(had.end_sec) > Number(had.start_sec)
    && Number(had.end_sec) <= Number(indexed[at + 2].end_sec)
    && Number(had.end_sec) <= end + 0.35,
  "source contraction does not cover two ordered spoken word intervals");
  return { unit_id: CONTRACTION_TARGET_UNIT_ID, source_token: "She’d",
    source_token_index: 0, spoken_words: ["She", "had"],
    spoken_word_indices: [she.index, had.index],
    start_sec: Number(she.start_sec), end_sec: Number(had.end_sec),
    evidence_sha256: marker.evidence_sha256 };
}

function exactFullUnitDifference(qa) {
  const operations = qa?.operations ?? [];
  return qa?.deletions === 0 && qa?.insertions === 0
    && qa?.substitutions === 1 && operations.length >= 3
    && operations[0]?.type === "substitution"
    && operations[0]?.intended === "shed"
    && operations[0]?.recognized === "she"
    && operations.slice(1).every((row) => row.type === "match");
}

export function validateContractionEvidenceForTests({ evidence, sourceScriptSha256,
  identityFileSha256, plan, planFileSha256, report, reportFileSha256,
  delivery, deliveryFileSha256, manifest, manifestFileSha256,
  selectedAudioFileSha256, boundaryRequest, boundaryRequestFileSha256,
  boundaryResult, boundaryResultFileSha256, firstAudioFileSha256,
  firstSidecar, firstSidecarFileSha256, remainderAudioFileSha256,
  remainderSidecar, remainderSidecarFileSha256,
} = {}) {
  const id = evidence?.unit_id;
  const planned = (plan?.units ?? []).find((row) => row.unit_id === id);
  const selected = (manifest?.units ?? []).find((row) => row.unit_id === id);
  const reported = (report?.results ?? []).find((row) => row.unit_id === id);
  const delivered = (delivery?.units ?? []).find((row) => row.unit_id === id);
  const requested = (boundaryRequest?.units ?? []).find((row) => row.unit_id === id);
  const made = (boundaryResult?.units ?? []).find((row) => row.unit_id === id);
  const first = made?.fragments?.[0];
  const remainder = made?.fragments?.[1];
  const text = planned?.spoken_text;
  const expectedRemainder = text?.startsWith(`${FIRST} `) ? text.slice(FIRST.length + 1) : null;
  need(evidence?.schema === CONTRACTION_EVIDENCE_SCHEMA
    && evidence.status === "reviewed"
    && evidence.evidence_basis === "reviewed_automated_delivery_qa"
    && evidence.authorization_origin === "user_authorized_autonomous_production"
    && evidence.human_listening_performed === false
    && evidence.user_listening_claimed === false
    && String(evidence.reviewed_by ?? "").trim().length >= 3
    && String(evidence.review_note ?? "").trim().length >= 35
    && Number.isFinite(Date.parse(evidence.reviewed_at))
    && id === CONTRACTION_TARGET_UNIT_ID
    && text === SOURCE_UNIT
    && planned.caption_text === SOURCE_UNIT
    && planned.source_text === SOURCE_UNIT
    && (plan.units ?? []).filter((row) => row.spoken_text?.includes(FIRST)).length === 1
    && (plan.units ?? []).filter((row) => row.spoken_text?.includes(EXPANDED)).length === 0
    && expectedRemainder === REMAINDER
    && evidence.expected_first_fragment === FIRST
    && evidence.tts_only_first_fragment === EXPANDED
    && evidence.remainder_text === expectedRemainder
    && evidence.source_script_sha256 === sourceScriptSha256
    && sourceScriptSha256 === plan.source_script_hash
    && evidence.run_identity_file_sha256 === identityFileSha256
    && evidence.narration_generation_plan_sha256 === plan.plan_sha256
    && evidence.narration_generation_plan_file_sha256 === planFileSha256
    && evidence.prior_narration_report_sha256 === reportFileSha256
    && evidence.prior_unit_delivery_qa_sha256 === deliveryFileSha256
    && evidence.prior_provider_manifest_file_sha256 === manifestFileSha256
    && report?.status === "blocked" && report.unit_qa_status === "blocked"
    && report.full_stream_qa_status === "not_run_due_to_unit_blockers"
    && report.source_script_hash === sourceScriptSha256
    && report.narration_generation_plan_sha256 === plan.plan_sha256
    && report.narration_generation_plan_file_sha256 === planFileSha256
    && report.provider_output_manifest_sha256 === manifestFileSha256
    && delivery?.status === "blocked"
    && delivery.source_script_hash === sourceScriptSha256
    && delivery.narration_generation_plan_sha256 === plan.plan_sha256
    && report.blockers?.length === 1 && delivery.blockers?.length === 1
    && report.blockers[0]?.unit_id === id
    && delivery.blockers[0]?.unit_id === id
    && report.blockers[0]?.code === "narration_confirmed_opening_token_mismatch"
    && delivery.blockers[0]?.code === "narration_confirmed_opening_token_mismatch"
    && delivered?.decision?.blockers?.length === 1
    && delivered.decision.blockers[0]?.code === "narration_confirmed_opening_token_mismatch"
    && exactFullUnitDifference(delivered.transcript_qa)
    && exactFullUnitDifference(delivered.confirmation_transcript_qa)
    && delivered.primary_recognized_text === delivered.confirmation_recognized_text
    && delivered?.edge_alignment?.status === "passed"
    && ["passed", "passed_with_warnings"].includes(delivered?.acoustic_qa?.status)
    && !(delivered?.acoustic_qa?.findings ?? []).some((finding) => finding.severity === "blocker")
    && delivered?.voice_continuity?.status === "passed"
    && planned.spoken_text_sha256 === sha(text)
    && selected?.spoken_text_sha256 === sha(text)
    && reported?.spoken_text_sha256 === sha(text)
    && reported?.audio_sha256 === selected?.audio_sha256
    && reported?.synthesis_identity_sha256 === selected?.synthesis_identity_sha256
    && delivered.audio_sha256 === selected.audio_sha256
    && selected.audio_sha256 === selectedAudioFileSha256
    && evidence.prior_audio_sha256 === selected.audio_sha256
    && evidence.prior_synthesis_identity_sha256 === selected.synthesis_identity_sha256
    && selected.synthesis_mode === "exact_sentence_boundary_composite_v1"
    && selected.recovery_provenance?.request_sha256 === boundaryRequest?.request_sha256
    && selected.recovery_provenance?.result_sha256 === boundaryResultFileSha256
    && evidence.prior_boundary_request_sha256 === boundaryRequestFileSha256
    && evidence.prior_boundary_result_sha256 === boundaryResultFileSha256
    && boundaryRequest?.schema === "goldflow_tts_exact_boundary_repair_request_v1"
    && boundaryResult?.schema === "goldflow_tts_exact_boundary_repair_result_v1"
    && boundaryResult.request_sha256 === boundaryRequest.request_sha256
    && requested?.fragments?.length === 2
    && requested.fragments[0] === FIRST
    && requested.fragments[1] === expectedRemainder
    && made?.audio_sha256 === selected.audio_sha256
    && made?.fragments?.length === 2
    && first?.text === FIRST && first.text_sha256 === sha(FIRST)
    && first.audio_sha256 === firstAudioFileSha256
    && first.sidecar_sha256 === firstSidecarFileSha256
    && firstSidecar?.text === FIRST
    && firstSidecar?.text_sha256 === sha(FIRST)
    && firstSidecar?.audio_sha256 === first.audio_sha256
    && remainder?.text === expectedRemainder
    && remainder.text_sha256 === sha(expectedRemainder)
    && remainder.audio_sha256 === remainderAudioFileSha256
    && remainder.sidecar_sha256 === remainderSidecarFileSha256
    && remainderSidecar?.text === expectedRemainder
    && remainderSidecar?.text_sha256 === sha(expectedRemainder)
    && remainderSidecar?.audio_sha256 === remainder.audio_sha256
    && Number(made.gap_sample_count) === 1920
    && SHA.test(boundaryRequestFileSha256 ?? "")
    && SHA.test(boundaryResultFileSha256 ?? ""),
  "receipt, sole blocker, or selected boundary fragment lineage differs");
  return { unit_id: id, spoken_text: text, remainder_text: expectedRemainder,
    selected, first, remainder };
}

export function contractionCandidateAsrDecisionForTests({ decision, unitId,
  reviewedUnitId, expectedText, primaryText, confirmationText, evidenceSha256,
} = {}) {
  if (unitId !== reviewedUnitId) return decision;
  need(SHA.test(evidenceSha256 ?? "") && expectedText === SOURCE_UNIT,
    "candidate ASR evidence lacks the exact source contraction");
  const expanded = expectedText.replace(FIRST, EXPANDED);
  const clean = [primaryText, confirmationText].every((recognized) => {
    const qa = transcriptQaForTests(expanded, recognized, { blockAnySubstitution: true });
    return qa.deletions === 0 && qa.insertions === 0 && qa.substitutions === 0
      && qa.first_token_ok === true && qa.last_token_ok === true;
  });
  if (!clean) return { ...decision, status: "blocked", review_required: true,
    blockers: [...(decision?.blockers ?? []), {
      code: "narration_exact_tts_only_expansion_not_confirmed",
      severity: "blocker", expected_phrase: EXPANDED,
      primary_recognized_text: primaryText,
      confirmation_recognized_text: confirmationText,
    }] };
  const blockers = decision?.blockers ?? [];
  // A phrase alias may already make the ordinary consensus pass. We still
  // require fresh literal expansion in both independent raw transcripts.
  need(blockers.length === 0 || (blockers.length === 1
    && blockers[0].code === "narration_confirmed_opening_token_mismatch"),
  "candidate has an unrelated delivery blocker");
  return { ...decision, status: "passed_with_warnings", blockers: [],
    review_required: false,
    warnings: [...(decision.warnings ?? []), {
      code: "narration_exact_tts_only_past_perfect_expansion",
      severity: "warning", review_required: false,
      expected_phrase: FIRST, spoken_phrase: EXPANDED,
      evidence_sha256: evidenceSha256, human_listening_performed: false,
    }],
    contraction_expansion_review: { evidence_sha256: evidenceSha256,
      unit_id: unitId, human_listening_performed: false } };
}

async function verifiedPcmParts(compositePath, firstPath, remainderPath) {
  const [whole, first, rest] = await Promise.all([
    pcmInfo(compositePath), pcmInfo(firstPath), pcmInfo(remainderPath),
  ]);
  need(whole.frames === first.frames + 1920 + rest.frames,
  "selected composite sample accounting differs from its two fragments");
  const [wholeFirst, firstPcm, wholeRest, restPcm, gap] = await Promise.all([
    pcm(compositePath, 0, first.frames, whole),
    pcm(firstPath, 0, first.frames, first),
    pcm(compositePath, first.frames + 1920, rest.frames, whole),
    pcm(remainderPath, 0, rest.frames, rest),
    pcm(compositePath, first.frames, 1920, whole),
  ]);
  need(wholeFirst.equals(firstPcm) && wholeRest.equals(restPcm)
    && gap.every((byte) => byte === 0),
  "selected composite PCM does not contain the exact retained fragments");
}

export async function loadContractionRecoveryState({ episodeDir, episode,
  sourceScriptSha256, priorReportPath = null, priorDeliveryPath = null,
} = {}) {
  const evidencePath = path.join(episodeDir,
    `narration_automated_contraction_expansion_${episode}.json`);
  const evidence = await read(evidencePath).catch((error) => {
    if (error?.code === "ENOENT") return null; throw error;
  });
  if (!evidence) return null;
  const planPath = path.join(episodeDir, "narration_generation_plan.json");
  const reportPath = priorReportPath ?? path.join(episodeDir, `narration_tts_report_${episode}.json`);
  const deliveryPath = priorDeliveryPath ?? path.join(episodeDir, `narration_unit_delivery_qa_${episode}.json`);
  need(inside(episodeDir, reportPath) && inside(episodeDir, deliveryPath),
    "prior report or delivery snapshot escaped the episode");
  const identityPath = path.join(episodeDir, "run_identity.json");
  const [plan, report, delivery] = await Promise.all([planPath, reportPath, deliveryPath].map(read));
  const manifestPath = report.provider_output_manifest_path;
  need(inside(episodeDir, manifestPath), "current report-bound manifest escaped the episode");
  const manifest = await read(manifestPath);
  const [actualScriptSha256, identityFileSha256, planFileSha256,
    reportFileSha256, deliveryFileSha256, manifestFileSha256,
    evidenceFileSha256] = await Promise.all([
    sha256File(path.join(episodeDir, "script_clean.md")), sha256File(identityPath),
    sha256File(planPath), sha256File(reportPath), sha256File(deliveryPath),
    sha256File(manifestPath), sha256File(evidencePath),
  ]);
  need(actualScriptSha256 === sourceScriptSha256
    && report.provider_output_manifest_sha256 === manifestFileSha256
    && manifest.manifest_sha256 === narrationProviderOutputManifestSha256(manifest)
    && validateNarrationProviderOutputManifest(manifest, plan.units, {
      generationPlanSha256: plan.plan_sha256,
      generationPlanFileSha256: planFileSha256,
      qualityContractSha256: manifest.narration_quality_contract_sha256,
      provider: "qwen_local", voiceId: manifest.voice_id,
      voiceSha256: manifest.voice_sha256,
    }).status === "passed", "current source, plan, or manifest is stale");
  const selected = manifest.units.find((row) => row.unit_id === evidence.unit_id);
  need(selected && inside(episodeDir, selected.audio_path)
    && inside(episodeDir, selected.recovery_provenance?.request_path)
    && inside(episodeDir, selected.recovery_provenance?.result_path),
  "selected boundary provenance escaped the episode");
  const requestPath = selected.recovery_provenance.request_path;
  const resultPath = selected.recovery_provenance.result_path;
  const [boundaryRequest, boundaryResult] = await Promise.all([
    read(requestPath), read(resultPath),
  ]);
  const made = boundaryResult.units.find((row) => row.unit_id === evidence.unit_id);
  need(made?.fragments?.length === 2
    && [made.fragments[0].audio_path, made.fragments[0].sidecar_path,
      made.fragments[1].audio_path, made.fragments[1].sidecar_path]
      .every((target) => inside(episodeDir, target)),
  "the exact two-fragment result is missing");
  const [firstSidecar, remainderSidecar,
    selectedAudioFileSha256, boundaryRequestFileSha256,
    boundaryResultFileSha256, firstAudioFileSha256,
    firstSidecarFileSha256, remainderAudioFileSha256,
    remainderSidecarFileSha256] = await Promise.all([
    read(made.fragments[0].sidecar_path), read(made.fragments[1].sidecar_path),
    sha256File(selected.audio_path), sha256File(requestPath), sha256File(resultPath),
    sha256File(made.fragments[0].audio_path),
    sha256File(made.fragments[0].sidecar_path),
    sha256File(made.fragments[1].audio_path),
    sha256File(made.fragments[1].sidecar_path),
  ]);
  const validated = validateContractionEvidenceForTests({ evidence,
    sourceScriptSha256, identityFileSha256, plan, planFileSha256,
    report, reportFileSha256, delivery, deliveryFileSha256,
    manifest, manifestFileSha256, selectedAudioFileSha256,
    boundaryRequest, boundaryRequestFileSha256,
    boundaryResult, boundaryResultFileSha256,
    firstAudioFileSha256, firstSidecar, firstSidecarFileSha256,
    remainderAudioFileSha256, remainderSidecar, remainderSidecarFileSha256,
  });
  await verifiedPcmParts(selected.audio_path, made.fragments[0].audio_path,
    made.fragments[1].audio_path);
  for (const row of manifest.units) {
    need(inside(episodeDir, row.audio_path)
      && await sha256File(row.audio_path) === row.audio_sha256,
    `selected WAV changed: ${row.unit_id}`);
  }
  const root = path.join(episodeDir,
    "assets/audio/narration_tts/contraction_candidates");
  const names = (await fs.readdir(root).catch(() => []))
    .filter((name) => SHA.test(name));
  need(names.length <= 1, "more than one contraction candidate exists");
  if (!names.length) return { kind: "evidence_reviewed", unit_id: evidence.unit_id,
    evidence_path: evidencePath, evidence_file_sha256: evidenceFileSha256,
    prior_manifest_path: manifestPath, prior_manifest_file_sha256: manifestFileSha256,
    validated };
  const candidateDir = path.join(root, names[0]);
  const candidateRequestPath = path.join(candidateDir, "request.json");
  const candidateResultPath = path.join(candidateDir, "repair-result.json");
  const candidateManifestPath = path.join(candidateDir, "provider-output-manifest.json");
  need(await Promise.all([candidateRequestPath, candidateResultPath,
    candidateManifestPath].map((target) => fs.access(target).then(() => true, () => false)))
    .then((rows) => rows.every(Boolean)), "candidate is incomplete; hold for exact triage");
  const [candidateRequest, candidateResult, candidateManifest] = await Promise.all([
    read(candidateRequestPath), read(candidateResultPath), read(candidateManifestPath),
  ]);
  const [candidateRequestFileSha256, candidateResultFileSha256,
    candidateManifestFileSha256] = await Promise.all([
    sha256File(candidateRequestPath), sha256File(candidateResultPath),
    sha256File(candidateManifestPath),
  ]);
  const candidate = candidateManifest.units.find((row) => row.unit_id === evidence.unit_id);
  const output = candidateResult.unit;
  const requestPayload = Object.fromEntries(Object.entries(candidateRequest)
    .filter(([key]) => key !== "request_sha256"));
  const requestHash = sha(JSON.stringify(canonical(requestPayload)));
  need(candidateRequest.schema === CONTRACTION_REQUEST_SCHEMA
    && candidateResult.schema === CONTRACTION_RESULT_SCHEMA
    && candidateRequest.request_sha256 === names[0]
    && candidateRequest.request_sha256 === requestHash
    && candidateResult.request_sha256 === names[0]
    && candidateResult.request_file_sha256 === candidateRequestFileSha256
    && candidateRequest.identity_file_sha256 === identityFileSha256
    && candidateRequest.source_script_sha256 === sourceScriptSha256
    && candidateRequest.plan_sha256 === plan.plan_sha256
    && candidateRequest.plan_file_sha256 === planFileSha256
    && candidateRequest.defect_evidence_sha256 === evidenceFileSha256
    && candidateRequest.prior_report_file_sha256 === reportFileSha256
    && candidateRequest.prior_delivery_file_sha256 === deliveryFileSha256
    && candidateRequest.prior_manifest_path === manifestPath
    && candidateRequest.prior_manifest_sha256 === manifest.manifest_sha256
    && candidateRequest.prior_manifest_file_sha256 === manifestFileSha256
    && candidateRequest.prior_boundary_request_file_sha256 === boundaryRequestFileSha256
    && candidateRequest.prior_boundary_result_file_sha256 === boundaryResultFileSha256
    && candidateRequest.expected_first_fragment === FIRST
    && candidateRequest.tts_only_first_fragment === EXPANDED
    && candidateRequest.remainder_text === validated.remainder_text
    && candidateRequest.unit_id === evidence.unit_id
    && candidateRequest.spoken_text_sha256 === selected.spoken_text_sha256
    && candidateRequest.prior_audio_sha256 === selected.audio_sha256
    && candidateRequest.prior_synthesis_identity_sha256
      === selected.synthesis_identity_sha256
    && candidateRequest.model_id === manifest.model_id
    && candidateRequest.model_revision === manifest.model_revision
    && candidateRequest.voice_id === manifest.voice_id
    && candidateRequest.voice_sha256 === manifest.voice_sha256
    && candidateRequest.voice_continuity_contract
      === manifest.voice_continuity_contract
    && same(candidateRequest.retained_remainder, {
      audio_path: validated.remainder.audio_path,
      audio_sha256: validated.remainder.audio_sha256,
      sidecar_path: validated.remainder.sidecar_path,
      sidecar_sha256: validated.remainder.sidecar_sha256,
    })
    && candidateRequest.recovery_authorization?.human_listening_performed === false
    && candidateRequest.recovery_authorization?.authorization_origin
      === "user_authorized_autonomous_production"
    && candidateManifest.manifest_sha256
      === narrationProviderOutputManifestSha256(candidateManifest)
    && validateNarrationProviderOutputManifest(candidateManifest, plan.units, {
      generationPlanSha256: plan.plan_sha256,
      generationPlanFileSha256: planFileSha256,
      qualityContractSha256: manifest.narration_quality_contract_sha256,
      provider: "qwen_local", voiceId: manifest.voice_id,
      voiceSha256: manifest.voice_sha256,
    }).status === "passed"
    && output?.unit_id === evidence.unit_id
    && candidate?.audio_path === output.audio_path
    && candidate?.audio_sha256 === output.audio_sha256
    && candidate?.spoken_text_sha256 === selected.spoken_text_sha256
    && candidate?.synthesis_mode === CONTRACTION_MODE
    && candidate?.recovery_provenance?.result_sha256 === candidateResultFileSha256
    && same(candidate?.recovery_provenance?.prior_selected, selected)
    && candidate?.synthesis_identity_sha256
      === narrationSynthesisIdentitySha256(candidate.synthesis_identity)
    && candidate?.synthesis_identity?.source_first_fragment_sha256 === sha(FIRST)
    && candidate?.synthesis_identity?.tts_only_first_fragment_sha256 === sha(EXPANDED)
    && candidate?.synthesis_identity?.retained_remainder_audio_sha256
      === validated.remainder.audio_sha256,
  "candidate request, manifest, or selected identity is stale");
  for (const [index, row] of candidateManifest.units.entries()) {
    const prior = manifest.units[index];
    need(row.unit_id === prior.unit_id && inside(episodeDir, row.audio_path)
      && await sha256File(row.audio_path) === row.audio_sha256
      && (row.unit_id === evidence.unit_id || same(row, prior)),
      `candidate changed a preserved unit: ${row.unit_id}`);
  }
  const fragmentSidecar = inside(candidateDir,
    output?.expanded_fragment?.sidecar_path)
    ? await read(output.expanded_fragment.sidecar_path) : null;
  need(inside(candidateDir, output.audio_path)
    && inside(candidateDir, output.expanded_fragment?.audio_path)
    && inside(candidateDir, output.expanded_fragment?.sidecar_path)
    && await sha256File(output.audio_path) === output.audio_sha256
    && await sha256File(output.expanded_fragment.audio_path)
      === output.expanded_fragment.audio_sha256
    && await sha256File(output.expanded_fragment.sidecar_path)
      === output.expanded_fragment.sidecar_sha256
    && output.expanded_fragment?.text === EXPANDED
    && output.expanded_fragment?.text_sha256 === sha(EXPANDED)
    && fragmentSidecar?.schema === "goldflow_tts_contraction_fragment_v1"
    && fragmentSidecar.request_sha256 === candidateRequest.request_sha256
    && fragmentSidecar.unit_id === evidence.unit_id
    && fragmentSidecar.model_id === candidateRequest.model_id
    && fragmentSidecar.model_revision === candidateRequest.model_revision
    && fragmentSidecar.voice_id === candidateRequest.voice_id
    && fragmentSidecar.voice_sha256 === candidateRequest.voice_sha256
    && same(output.expanded_fragment, {
      ...fragmentSidecar,
      sidecar_path: output.expanded_fragment.sidecar_path,
      sidecar_sha256: output.expanded_fragment.sidecar_sha256,
    })
    && output.retained_remainder?.audio_sha256 === validated.remainder.audio_sha256
    && output.retained_remainder?.sidecar_sha256 === validated.remainder.sidecar_sha256,
  "candidate fragment or retained remainder is stale");
  need(Number(output.gap_sample_count) === 1920
    && output.retained_remainder.audio_path === validated.remainder.audio_path
    && output.retained_remainder.sidecar_path === validated.remainder.sidecar_path,
  "candidate changed the exact retained remainder");
  await verifiedPcmParts(output.audio_path, output.expanded_fragment.audio_path,
    output.retained_remainder.audio_path);
  return { kind: "candidate_ready", unit_id: evidence.unit_id,
    evidence_path: evidencePath, evidence_file_sha256: evidenceFileSha256,
    candidate_manifest_path: candidateManifestPath,
    candidate_manifest_file_sha256: candidateManifestFileSha256,
    candidate_request_path: candidateRequestPath,
    candidate_request_file_sha256: candidateRequestFileSha256,
    candidate_result_path: candidateResultPath,
    candidate_result_file_sha256: candidateResultFileSha256,
    candidate_audio_path: output.audio_path,
    candidate_audio_sha256: output.audio_sha256,
    prior_report_path: reportPath, prior_report_file_sha256: reportFileSha256,
    prior_delivery_path: deliveryPath,
    prior_delivery_file_sha256: deliveryFileSha256,
    prior_manifest_path: manifestPath,
    prior_manifest_file_sha256: manifestFileSha256,
  };
}

export async function validateAppliedContractionReview({ episodeDir, episode,
  sourceScriptSha256, ttsReport, unitDelivery, providerOutput,
  providerOutputPath,
} = {}) {
  const proof = ttsReport?.automated_contraction_expansion;
  const candidates = (providerOutput?.units ?? []).filter(
    (row) => row.synthesis_mode === CONTRACTION_MODE);
  if (!proof) return candidates.length === 0;
  try {
    need(proof.schema === CONTRACTION_EVIDENCE_SCHEMA
      && proof.unit_id === CONTRACTION_TARGET_UNIT_ID
      && proof.human_listening_performed === false
      && proof.acceptance_basis === "fresh_independent_dual_asr_and_normal_audio_qa"
      && proof.source_phrase === FIRST && proof.tts_only_spoken_phrase === EXPANDED
      && candidates.length === 1
      && proof.manifest_path === providerOutputPath
      && proof.manifest_file_sha256 === await sha256File(providerOutputPath)
      && unitDelivery?.automated_contraction_expansion?.evidence_sha256
        === proof.evidence_sha256
      && inside(episodeDir, proof.prior_report_snapshot_path)
      && inside(episodeDir, proof.prior_delivery_snapshot_path)
      && inside(episodeDir, proof.evidence_path)
      && inside(episodeDir, proof.candidate_request_path)
      && inside(episodeDir, proof.candidate_result_path)
      && await sha256File(proof.evidence_path) === proof.evidence_sha256
      && await sha256File(proof.prior_report_snapshot_path)
        === proof.prior_report_snapshot_sha256
      && await sha256File(proof.prior_delivery_snapshot_path)
        === proof.prior_delivery_snapshot_sha256
      && await sha256File(proof.candidate_request_path)
        === proof.candidate_request_sha256
      && await sha256File(proof.candidate_result_path)
        === proof.candidate_result_sha256
      && ["passed", "passed_with_warnings"].includes(ttsReport.status)
      && ["passed", "passed_with_warnings"].includes(unitDelivery.status)
      && ["passed", "passed_with_warnings"].includes(ttsReport.full_stream_qa_status)
      && !(ttsReport.blockers ?? []).length
      && !(unitDelivery.blockers ?? []).length
      && !ttsReport.operator_narration_qa_waiver
      && !unitDelivery.operator_narration_qa_waiver,
    "applied contraction provenance or QA is stale");
    const recovered = await loadContractionRecoveryState({ episodeDir, episode,
      sourceScriptSha256,
      priorReportPath: proof.prior_report_snapshot_path,
      priorDeliveryPath: proof.prior_delivery_snapshot_path,
    });
    need(recovered?.kind === "candidate_ready"
      && recovered.candidate_manifest_path === providerOutputPath
      && recovered.candidate_manifest_file_sha256 === proof.manifest_file_sha256
      && recovered.candidate_request_file_sha256 === proof.candidate_request_sha256
      && recovered.candidate_result_file_sha256 === proof.candidate_result_sha256,
    "applied contraction candidate changed");
    const delivered = (unitDelivery.units ?? []).find(
      (row) => row.unit_id === proof.unit_id);
    const segment = (ttsReport.segments ?? []).find(
      (row) => row.unit_id === proof.unit_id);
    const candidate = candidates[0];
    need(delivered?.audio_sha256 === candidate.audio_sha256
      && delivered?.intended_text === SOURCE_UNIT
      && delivered?.primary_recognition_source === "fresh_finalizer_small_asr"
      && delivered?.decision?.contraction_expansion_review?.evidence_sha256
        === proof.evidence_sha256
      && same(delivered?.asr_equivalent_phrases, [CONTRACTION_ALIAS])
      && same(segment?.asr_equivalent_phrases, [CONTRACTION_ALIAS])
      && segment?.text === SOURCE_UNIT
      && segment?.caption_text === SOURCE_UNIT
      && segment?.tts_only_contraction_expansion?.source_token === "She’d"
      && same(segment?.tts_only_contraction_expansion?.spoken_words,
        ["She", "had"])
      && !(delivered?.decision?.blockers ?? []).length,
    "applied contraction unit or caption mapping changed");
    const confirmed = contractionCandidateAsrDecisionForTests({
      decision: delivered.decision, unitId: proof.unit_id,
      reviewedUnitId: proof.unit_id, expectedText: SOURCE_UNIT,
      primaryText: delivered.primary_recognized_text,
      confirmationText: delivered.confirmation_recognized_text,
      evidenceSha256: proof.evidence_sha256,
    });
    need(!(confirmed.blockers ?? []).length
      && confirmed.status === "passed_with_warnings",
    "applied contraction dual-ASR is no longer exact");
    return true;
  } catch { return false; }
}

export function contractionGuardAdmission(status, command, subcommand, flags = {}) {
  const review = command === "tts" && subcommand === "review-contraction";
  const repair = command === "tts" && subcommand === "repair-contraction";
  const finalize = command === "tts" && subcommand === "finalize-provider"
    && flags["contraction-expansion-evidence"] != null;
  if (!review && !repair && !finalize) return { applicable: false, allowed: false };
  const episodeDir = String(status?.episode_dir ?? "");
  const evidence = review ? "" : String(flags[repair ? "evidence"
    : "contraction-expansion-evidence"] ?? "");
  const manifest = String(flags.manifest ?? "");
  const expected = review
    ? `node bin/goldflow.mjs tts review-contraction --episode-dir ${episodeDir}`
    : repair
      ? `node bin/goldflow.mjs tts repair-contraction --episode-dir ${episodeDir} --evidence ${evidence}`
      : `node bin/goldflow.mjs tts finalize-provider --episode-dir ${episodeDir} --manifest ${manifest} --contraction-expansion-evidence ${evidence}`;
  const keys = Object.keys(flags).sort().join(",");
  const allowed = status?.current_stage === "qwen_tts_stitch"
    && status.current_stage_state === "blocked"
    && keys === (review ? "episode-dir" : repair ? "episode-dir,evidence"
      : "contraction-expansion-evidence,episode-dir,manifest")
    && path.resolve(String(flags["episode-dir"] ?? "")) === path.resolve(episodeDir)
    && (review || inside(episodeDir, evidence))
    && (!finalize || inside(episodeDir, manifest))
    && status.next_command_shape === expected;
  return { applicable: true, allowed,
    reason: allowed ? null : "Only the exact status-directed contraction candidate or finalization is admitted." };
}
