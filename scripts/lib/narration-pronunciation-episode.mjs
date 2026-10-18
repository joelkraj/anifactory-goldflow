import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256File } from "./file-hash.mjs";
import {
  narrationProviderOutputManifestSha256,
  validateNarrationProviderOutputManifest,
} from "./narration-provider-adapter.mjs";
import {
  validatePronunciationCandidateArtifactsForTests,
  validatePronunciationCandidateReviewForTests,
  validatePronunciationDefectEvidenceForTests,
  validateSelectedPronunciationReviewForTests,
} from "./narration-pronunciation-repair.mjs";

const read = async (name) => JSON.parse(await fs.readFile(name, "utf8"));
const exists = async (name) => fs.access(name).then(() => true, () => false);
const inside = (root, name) => typeof name === "string" && path.isAbsolute(name)
  && path.resolve(name).startsWith(`${path.resolve(root)}${path.sep}`);

// This loader performs no writes. A saved listening receipt becomes usable only
// while the exact blocked report and selected WAV it cites are still current.
export async function loadPronunciationRecoveryState({ episodeDir, episode, sourceScriptSha256 }) {
  const selectedReviewPath = path.join(episodeDir,
    `narration_selected_pronunciation_listen_${episode}.json`);
  const defectPath = path.join(episodeDir,
    `narration_user_heard_pronunciation_defect_${episode}.json`);
  const selectedExists = await exists(selectedReviewPath);
  const defectExists = await exists(defectPath);
  if (!selectedExists && !defectExists) return null;
  if (selectedExists && defectExists) {
    throw new Error("Conflicting selected-audio approval and user-heard defect receipts.");
  }
  const planPath = path.join(episodeDir, "narration_generation_plan.json");
  const reportPath = path.join(episodeDir, `narration_tts_report_${episode}.json`);
  const deliveryPath = path.join(episodeDir, `narration_unit_delivery_qa_${episode}.json`);
  const [plan, report, delivery] = await Promise.all(
    [planPath, reportPath, deliveryPath].map(read));
  const manifestPath = report.provider_output_manifest_path;
  if (!inside(episodeDir, manifestPath)) throw new Error("Blocked provider manifest escaped the episode.");
  const manifest = await read(manifestPath);
  const [planFileSha256, reportFileSha256, deliveryFileSha256,
    manifestFileSha256, actualScriptSha256] = await Promise.all([
    sha256File(planPath), sha256File(reportPath), sha256File(deliveryPath),
    sha256File(manifestPath), sha256File(path.join(episodeDir, "script_clean.md")),
  ]);
  if (actualScriptSha256 !== sourceScriptSha256
    || manifest.manifest_sha256 !== narrationProviderOutputManifestSha256(manifest)
    || report.provider_output_manifest_sha256 !== manifestFileSha256
    || validateNarrationProviderOutputManifest(manifest, plan.units, {
      generationPlanSha256: plan.plan_sha256,
      generationPlanFileSha256: planFileSha256,
      qualityContractSha256: manifest.narration_quality_contract_sha256,
      provider: "qwen_local", voiceId: manifest.voice_id,
      voiceSha256: manifest.voice_sha256,
    }).status !== "passed") {
    throw new Error("Current blocked source, report, or Qwen provider manifest changed.");
  }
  const common = { sourceScriptSha256, plan, planFileSha256, report, reportFileSha256,
    delivery, deliveryFileSha256, manifest, manifestFileSha256 };
  if (selectedExists) {
    const review = await read(selectedReviewPath);
    const selected = manifest.units.find((row) => row.unit_id === review.unit_id);
    if (!selected || !inside(episodeDir, selected.audio_path)) {
      throw new Error("Selected listening audio is absent or outside the episode.");
    }
    const reviewFileSha256 = await sha256File(selectedReviewPath);
    const accepted = validateSelectedPronunciationReviewForTests({
      review, reviewFileSha256, ...common,
      selectedAudioFileSha256: await sha256File(selected.audio_path),
    });
    return { kind: "selected_approved", unit_id: accepted.unit_id,
      manifest_path: manifestPath, manifest_file_sha256: manifestFileSha256,
      review_path: selectedReviewPath, review_file_sha256: reviewFileSha256,
      source_script_sha256: sourceScriptSha256 };
  }
  const defect = await read(defectPath);
  const selected = manifest.units.find((row) => row.unit_id === defect.unit_id);
  const priorRequestPath = selected?.recovery_provenance?.request_path;
  const priorResultPath = selected?.recovery_provenance?.result_path;
  if (!selected || !inside(episodeDir, selected.audio_path)
    || !inside(episodeDir, priorRequestPath) || !inside(episodeDir, priorResultPath)) {
    throw new Error("User-heard defect lacks exact selected boundary provenance.");
  }
  const [priorBoundaryRequest, priorBoundaryResult] = await Promise.all([
    read(priorRequestPath), read(priorResultPath),
  ]);
  const defectFileSha256 = await sha256File(defectPath);
  validatePronunciationDefectEvidenceForTests({
    evidence: defect, evidenceFileSha256: defectFileSha256, ...common,
    selectedAudioFileSha256: await sha256File(selected.audio_path),
    priorBoundaryRequest, priorBoundaryResult,
    priorBoundaryResultFileSha256: await sha256File(priorResultPath),
  });
  const root = path.join(episodeDir, "assets/audio/narration_tts/pronunciation_candidates");
  const candidateNames = (await fs.readdir(root).catch(() => [])).filter((name) => /^[a-f0-9]{64}$/u.test(name));
  if (!candidateNames.length) {
    return { kind: "defect_reviewed", unit_id: defect.unit_id,
      defect_path: defectPath, defect_file_sha256: defectFileSha256 };
  }
  if (candidateNames.length !== 1) throw new Error("Multiple pronunciation candidates require operator triage.");
  const candidateDir = path.join(root, candidateNames[0]);
  const requestPath = path.join(candidateDir, "request.json");
  const resultPath = path.join(candidateDir, "repair-result.json");
  const candidateManifestPath = path.join(candidateDir, "provider-output-manifest.json");
  if (!(await exists(requestPath)) || !(await exists(resultPath))
    || !(await exists(candidateManifestPath))) {
    throw new Error("Pronunciation candidate is incomplete; preserve its partial evidence for triage.");
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
    if (!inside(episodeDir, name)) throw new Error("Pronunciation candidate artifact escaped the episode.");
  }
  if (request.request_sha256 !== candidateNames[0]
    || request.prior_report_file_sha256 !== reportFileSha256
    || request.prior_delivery_file_sha256 !== deliveryFileSha256
    || request.source_script_sha256 !== sourceScriptSha256
    || request.plan_file_sha256 !== planFileSha256
    || request.plan_sha256 !== plan.plan_sha256
    || request.prior_boundary_request_file_sha256 !== await sha256File(priorRequestPath)
    || request.prior_boundary_result_file_sha256 !== await sha256File(priorResultPath)
    || candidateManifest.manifest_sha256 !== narrationProviderOutputManifestSha256(candidateManifest)
    || validateNarrationProviderOutputManifest(candidateManifest, plan.units, {
      generationPlanSha256: plan.plan_sha256,
      generationPlanFileSha256: planFileSha256,
      qualityContractSha256: manifest.narration_quality_contract_sha256,
      provider: "qwen_local", voiceId: manifest.voice_id,
      voiceSha256: manifest.voice_sha256,
    }).status !== "passed") {
    throw new Error("Pronunciation candidate request or derived manifest is stale.");
  }
  validatePronunciationCandidateArtifactsForTests({
    defect, defectFileSha256, request, requestFileSha256,
    result, resultFileSha256, priorManifest: manifest, priorManifestFileSha256: manifestFileSha256,
    candidateManifest, candidateAudioFileSha256: await sha256File(made.audio_path),
    phoneticAudioFileSha256: await sha256File(made.phonetic_fragment.audio_path),
    phoneticSidecarFileSha256: await sha256File(made.phonetic_fragment.sidecar_path),
    remainderAudioFileSha256: await sha256File(made.retained_remainder.audio_path),
    remainderSidecarFileSha256: await sha256File(made.retained_remainder.sidecar_path),
  });
  const reviewPath = path.join(episodeDir,
    `narration_pronunciation_candidate_listen_${episode}.json`);
  if (!(await exists(reviewPath))) {
    return { kind: "candidate_pending_user_listening", unit_id: defect.unit_id,
      candidate_audio_path: made.audio_path, candidate_audio_sha256: made.audio_sha256,
      candidate_manifest_path: candidateManifestPath,
      candidate_manifest_file_sha256: candidateManifestFileSha256 };
  }
  const review = await read(reviewPath);
  const reviewFileSha256 = await sha256File(reviewPath);
  validatePronunciationCandidateReviewForTests({
    review, defect, request, result, candidateManifest,
    reviewFileSha256, defectFileSha256, requestFileSha256, resultFileSha256,
    candidateManifestFileSha256, candidateAudioFileSha256: await sha256File(made.audio_path),
  });
  return { kind: "candidate_approved", unit_id: defect.unit_id,
    manifest_path: candidateManifestPath, manifest_file_sha256: candidateManifestFileSha256,
    review_path: reviewPath, review_file_sha256: reviewFileSha256,
    source_script_sha256: sourceScriptSha256 };
}
