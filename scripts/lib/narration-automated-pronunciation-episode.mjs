import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256File } from "./file-hash.mjs";
import {
  narrationProviderOutputManifestSha256,
  validateNarrationProviderOutputManifest,
} from "./narration-provider-adapter.mjs";
import {
  AUTOMATED_PRONUNCIATION_MODE,
  validateAutomatedPronunciationEvidenceForTests,
  validatePronunciationCandidateArtifactsForTests,
} from "./narration-pronunciation-repair.mjs";

const read = async (name) => JSON.parse(await fs.readFile(name, "utf8"));
const exists = async (name) => fs.access(name).then(() => true, () => false);
const inside = (root, name) => typeof name === "string" && path.isAbsolute(name)
  && path.resolve(name).startsWith(`${path.resolve(root)}${path.sep}`);

// Read-only, hash-bound admission for one reviewed automated repair. A partial
// candidate or a changed selected WAV is a hold, never a synthesis retry.
export async function loadAutomatedPronunciationState({ episodeDir, episode, sourceScriptSha256 }) {
  const evidencePath = path.join(episodeDir,
    `narration_automated_pronunciation_review_${episode}.json`);
  if (!(await exists(evidencePath))) return null;
  const planPath = path.join(episodeDir, "narration_generation_plan.json");
  const reportPath = path.join(episodeDir, `narration_tts_report_${episode}.json`);
  const deliveryPath = path.join(episodeDir, `narration_unit_delivery_qa_${episode}.json`);
  const [plan, report, delivery, evidence] = await Promise.all(
    [planPath, reportPath, deliveryPath, evidencePath].map(read));
  const manifestPath = report.provider_output_manifest_path;
  if (!inside(episodeDir, manifestPath)) throw new Error("Automated pronunciation prior manifest escaped the episode.");
  const manifest = await read(manifestPath);
  const [planFileSha256, reportFileSha256, deliveryFileSha256,
    manifestFileSha256, actualScriptSha256, evidenceFileSha256] = await Promise.all([
    sha256File(planPath), sha256File(reportPath), sha256File(deliveryPath),
    sha256File(manifestPath), sha256File(path.join(episodeDir, "script_clean.md")),
    sha256File(evidencePath),
  ]);
  if (actualScriptSha256 !== sourceScriptSha256
    || report.provider_output_manifest_sha256 !== manifestFileSha256
    || manifest.manifest_sha256 !== narrationProviderOutputManifestSha256(manifest)
    || validateNarrationProviderOutputManifest(manifest, plan.units, {
      generationPlanSha256: plan.plan_sha256,
      generationPlanFileSha256: planFileSha256,
      qualityContractSha256: manifest.narration_quality_contract_sha256,
      provider: "qwen_local", voiceId: manifest.voice_id,
      voiceSha256: manifest.voice_sha256,
    }).status !== "passed") {
    throw new Error("Current blocked source, report, or Qwen manifest changed.");
  }
  const selected = manifest.units.find((row) => row.unit_id === evidence.unit_id);
  const priorRequestPath = selected?.recovery_provenance?.request_path;
  const priorResultPath = selected?.recovery_provenance?.result_path;
  if (!selected || !inside(episodeDir, selected.audio_path)
    || !inside(episodeDir, priorRequestPath) || !inside(episodeDir, priorResultPath)) {
    throw new Error("Automated pronunciation evidence lacks exact selected boundary provenance.");
  }
  const [priorBoundaryRequest, priorBoundaryResult] = await Promise.all([
    read(priorRequestPath), read(priorResultPath),
  ]);
  validateAutomatedPronunciationEvidenceForTests({
    evidence, evidenceFileSha256, sourceScriptSha256, plan, planFileSha256,
    report, reportFileSha256, delivery, deliveryFileSha256,
    manifest, manifestFileSha256, selectedAudioFileSha256: await sha256File(selected.audio_path),
    priorBoundaryRequest, priorBoundaryResult,
    priorBoundaryResultFileSha256: await sha256File(priorResultPath),
  });
  for (const row of manifest.units) {
    if (!inside(episodeDir, row.audio_path)
      || await sha256File(row.audio_path) !== row.audio_sha256) {
      throw new Error(`Automated pronunciation prior WAV changed: ${row.unit_id}`);
    }
  }
  const root = path.join(episodeDir, "assets/audio/narration_tts/automated_pronunciation_candidates");
  const names = (await fs.readdir(root).catch(() => [])).filter((name) => /^[a-f0-9]{64}$/u.test(name));
  if (!names.length) return { kind: "evidence_reviewed", unit_id: evidence.unit_id,
    evidence_path: evidencePath, evidence_file_sha256: evidenceFileSha256 };
  if (names.length !== 1) throw new Error("More than one automated pronunciation candidate exists.");
  const candidateDir = path.join(root, names[0]);
  const requestPath = path.join(candidateDir, "request.json");
  const resultPath = path.join(candidateDir, "repair-result.json");
  const candidateManifestPath = path.join(candidateDir, "provider-output-manifest.json");
  if (!(await exists(requestPath)) || !(await exists(resultPath))
    || !(await exists(candidateManifestPath))) {
    throw new Error("Automated pronunciation candidate is incomplete; retain it for exact triage.");
  }
  const [request, result, candidateManifest] = await Promise.all([
    read(requestPath), read(resultPath), read(candidateManifestPath),
  ]);
  const [requestFileSha256, resultFileSha256, candidateManifestFileSha256] = await Promise.all([
    sha256File(requestPath), sha256File(resultPath), sha256File(candidateManifestPath),
  ]);
  const made = result.unit;
  for (const name of [made?.audio_path, made?.phonetic_fragment?.audio_path,
    made?.phonetic_fragment?.sidecar_path, made?.retained_remainder?.audio_path,
    made?.retained_remainder?.sidecar_path]) {
    if (!inside(episodeDir, name)) throw new Error("Automated pronunciation candidate escaped the episode.");
  }
  if (request.request_sha256 !== names[0]
    || request.defect_evidence_sha256 !== evidenceFileSha256
    || request.prior_report_file_sha256 !== reportFileSha256
    || request.prior_delivery_file_sha256 !== deliveryFileSha256
    || request.prior_manifest_file_sha256 !== manifestFileSha256
    || request.prior_boundary_request_file_sha256 !== await sha256File(priorRequestPath)
    || request.prior_boundary_result_file_sha256 !== await sha256File(priorResultPath)
    || request.recovery_authorization?.human_listening_performed !== false
    || request.recovery_authorization?.authorization_origin !== "user_authorized_autonomous_production"
    || candidateManifest.manifest_sha256 !== narrationProviderOutputManifestSha256(candidateManifest)
    || validateNarrationProviderOutputManifest(candidateManifest, plan.units, {
      generationPlanSha256: plan.plan_sha256,
      generationPlanFileSha256: planFileSha256,
      qualityContractSha256: manifest.narration_quality_contract_sha256,
      provider: "qwen_local", voiceId: manifest.voice_id,
      voiceSha256: manifest.voice_sha256,
    }).status !== "passed") {
    throw new Error("Automated pronunciation candidate request or manifest is stale.");
  }
  validatePronunciationCandidateArtifactsForTests({
    defect: evidence, defectFileSha256: evidenceFileSha256, request, requestFileSha256,
    result, resultFileSha256, priorManifest: manifest,
    priorManifestFileSha256: manifestFileSha256, candidateManifest,
    candidateAudioFileSha256: await sha256File(made.audio_path),
    phoneticAudioFileSha256: await sha256File(made.phonetic_fragment.audio_path),
    phoneticSidecarFileSha256: await sha256File(made.phonetic_fragment.sidecar_path),
    remainderAudioFileSha256: await sha256File(made.retained_remainder.audio_path),
    remainderSidecarFileSha256: await sha256File(made.retained_remainder.sidecar_path),
    synthesisMode: AUTOMATED_PRONUNCIATION_MODE,
    candidateReviewStatus: "pending_automated_asr",
  });
  return { kind: "candidate_ready", unit_id: evidence.unit_id,
    evidence_path: evidencePath, evidence_file_sha256: evidenceFileSha256,
    expected_word: evidence.expected_word, phonetic_word: evidence.tts_only_phonetic_word,
    candidate_audio_path: made.audio_path, candidate_audio_sha256: made.audio_sha256,
    manifest_path: candidateManifestPath,
    manifest_file_sha256: candidateManifestFileSha256 };
}
