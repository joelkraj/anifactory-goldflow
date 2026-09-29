import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  narrationProviderOutputManifestSha256,
  narrationSynthesisIdentitySha256,
} from "../lib/narration-provider-adapter.mjs";
import { canonicalQwenBatchSha256 } from "../lib/qwen-liam-batch-contract.mjs";
import { exactBoundaryRepairResumeCandidate } from "../lib/narration-boundary-resume.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const fileHash = async (file) => sha(await fs.readFile(file));
const write = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
};
const root = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-boundary-resume-"));
try {
  const episodeDir = path.join(root, "ep_01");
  const episode = "ep_01";
  const identity = { episode, tts_provider: "qwen_local" };
  const identityPath = path.join(episodeDir, "run_identity.json");
  const plan = { plan_sha256: "plan", source_script_hash: "script" };
  const planPath = path.join(episodeDir, "narration_generation_plan.json");
  const planUnits = [
    { unit_id: "repaired", spoken_text: "Tessa came.", spoken_text_sha256: sha("Tessa came.") },
    { unit_id: "retained", spoken_text: "All good.", spoken_text_sha256: sha("All good.") },
  ];
  const qualityContractSha256 = "quality";
  const policy = { primary: { provider: "qwen_local", model_id: "model", model_revision: "revision",
    voice_id: "voice", voice_sha256: "voice-hash" } };
  await write(identityPath, identity);
  await write(planPath, plan);
  const planFileSha256 = await fileHash(planPath);
  const oldAudio = path.join(episodeDir, "old.wav");
  const retainedAudio = path.join(episodeDir, "retained.wav");
  await write(oldAudio, "old audio");
  await write(retainedAudio, "retained audio");
  const old = { unit_id: "repaired", audio_path: oldAudio, audio_sha256: await fileHash(oldAudio),
    spoken_text_sha256: planUnits[0].spoken_text_sha256, synthesis_identity_sha256: "prior-synthesis" };
  const retained = { unit_id: "retained", audio_path: retainedAudio, audio_sha256: await fileHash(retainedAudio),
    spoken_text_sha256: planUnits[1].spoken_text_sha256, synthesis_identity_sha256: "retained-synthesis" };
  const prior = { status: "passed", units: [old, retained] };
  prior.manifest_sha256 = narrationProviderOutputManifestSha256(prior);
  const canonicalPath = path.join(episodeDir, "narration_provider_output_manifest_ep_01.json");
  await write(canonicalPath, prior);
  const specPath = path.join(episodeDir, "narration_exact_boundary_repair_spec_ep_01.json");
  await write(specPath, { units: [{ unit_id: "repaired", fragments: ["Tessa", "came."] }] });
  const request = {
    schema: "goldflow_tts_exact_boundary_repair_request_v1", episode_dir: episodeDir,
    identity_sha256: await fileHash(identityPath), plan_sha256: plan.plan_sha256,
    plan_file_sha256: planFileSha256, prior_manifest_sha256: prior.manifest_sha256,
    prior_manifest_file_sha256: await fileHash(canonicalPath),
    prior_report_file_sha256: sha("prior report"),
    prior_delivery_file_sha256: sha("prior delivery"),
    spec_file_sha256: await fileHash(specPath),
    model_id: "model", model_revision: "revision", voice_id: "voice", voice_sha256: "voice-hash",
    units: [{ unit_id: "repaired", spoken_text: "Tessa came.",
      spoken_text_sha256: sha("Tessa came."), prior_audio_sha256: old.audio_sha256,
      prior_synthesis_identity_sha256: old.synthesis_identity_sha256,
      fragments: ["Tessa", "came."] }],
    orthographic_equivalence_unit_ids: [],
  };
  request.request_sha256 = canonicalQwenBatchSha256(request);
  const repairDir = path.join(episodeDir, "assets/audio/narration_tts/exact_boundary_repairs", request.request_sha256);
  const requestPath = path.join(repairDir, "request.json");
  const resultPath = path.join(repairDir, "repair-result.json");
  await write(requestPath, request);
  await write(path.join(repairDir, "prior_manifest.json"), prior);
  await write(path.join(repairDir, "prior_report.json"), "prior report");
  await write(path.join(repairDir, "prior_delivery.json"), "prior delivery");
  const compositePath = path.join(repairDir, "composites", "repaired.wav");
  await write(compositePath, "composite audio");
  const fragments = [];
  for (const [index, text] of ["Tessa", "came."].entries()) {
    const audioPath = path.join(repairDir, "fragments", `${index}.wav`);
    const sidecarPath = path.join(repairDir, "fragments", `${index}.json`);
    await write(audioPath, `fragment ${index}`);
    await write(sidecarPath, `sidecar ${index}`);
    fragments.push({ text_sha256: sha(text), audio_path: audioPath,
      audio_sha256: await fileHash(audioPath), sidecar_path: sidecarPath,
      sidecar_sha256: await fileHash(sidecarPath) });
  }
  const result = { schema: "goldflow_tts_exact_boundary_repair_result_v1",
    request_sha256: request.request_sha256, request_path: requestPath,
    request_file_sha256: await fileHash(requestPath),
    units: [{ unit_id: "repaired", spoken_text_sha256: sha("Tessa came."),
      audio_path: compositePath, audio_sha256: await fileHash(compositePath), fragments }] };
  await write(resultPath, result);
  const synthesis = { schema: "goldflow_tts_exact_boundary_composite_identity_v1",
    request_sha256: request.request_sha256,
    prior_audio_sha256: old.audio_sha256,
    prior_synthesis_identity_sha256: old.synthesis_identity_sha256,
    composite_audio_sha256: result.units[0].audio_sha256 };
  const derived = { status: "passed", units: [{ ...old, audio_path: compositePath,
    audio_sha256: result.units[0].audio_sha256,
    synthesis_mode: "exact_sentence_boundary_composite_v1",
    recovery_provenance: { schema: "goldflow_tts_exact_boundary_repair_provenance_v1",
      request_path: requestPath, request_sha256: request.request_sha256,
      result_path: resultPath, result_sha256: await fileHash(resultPath),
      prior_audio_sha256: old.audio_sha256,
      prior_synthesis_identity_sha256: old.synthesis_identity_sha256 },
    synthesis_identity: synthesis,
    synthesis_identity_sha256: narrationSynthesisIdentitySha256(synthesis),
  }, retained],
  provider_execution: { exact_boundary_repair: {
    request_sha256: request.request_sha256, result_sha256: await fileHash(resultPath),
    repaired_unit_ids: ["repaired"], preserved_unit_count: 1 } },
  repair_history: [{ mode: "exact_sentence_boundary_composite_v1",
    prior_manifest_sha256: prior.manifest_sha256, request_sha256: request.request_sha256 }] };
  derived.manifest_sha256 = narrationProviderOutputManifestSha256(derived);
  const derivedPath = path.join(repairDir, "provider-output-manifest.json");
  await write(derivedPath, derived);
  const blocker = { unit_id: "repaired", code: "narration_confirmed_opening_token_mismatch" };
  const ttsReport = { status: "blocked", unit_qa_status: "blocked",
    full_stream_qa_status: "not_run_due_to_unit_blockers", blockers: [blocker],
    provider_output_manifest_path: canonicalPath,
    provider_output_manifest_sha256: await fileHash(canonicalPath),
    source_script_hash: "script", narration_generation_plan_sha256: "plan",
    narration_generation_plan_file_sha256: planFileSha256,
    narration_quality_contract_sha256: qualityContractSha256,
    results: [{ unit_id: "repaired", audio_path: oldAudio, audio_sha256: old.audio_sha256 }] };
  const unitDelivery = { status: "blocked", blockers: [blocker],
    transcript_comparison_version: "old-version", source_script_hash: "script",
    narration_generation_plan_sha256: "plan",
    narration_generation_plan_file_sha256: planFileSha256,
    quality_contract_sha256: qualityContractSha256 };
  const args = { episodeDir, episode, repairDir, identity, plan, planUnits,
    planFileSha256, qualityContractSha256, policy, ttsReport, unitDelivery,
    currentScriptHash: "script", currentComparisonVersion: "new-version",
    validateProvider: () => ({ status: "passed" }) };
  assert.equal((await exactBoundaryRepairResumeCandidate(args))?.manifestPath, derivedPath);
  assert.equal(await exactBoundaryRepairResumeCandidate({ ...args,
    ttsReport: { ...ttsReport, provider_output_manifest_path: "/outside.json" } }), null);
  assert.equal(await exactBoundaryRepairResumeCandidate({ ...args,
    ttsReport: { ...ttsReport, results: [{ unit_id: "repaired", audio_path: compositePath,
      audio_sha256: result.units[0].audio_sha256 }] } }), null);
  await write(compositePath, "tampered composite");
  assert.equal(await exactBoundaryRepairResumeCandidate(args), null);
  await write(compositePath, "composite audio");
  await write(resultPath, { ...result, request_file_sha256: "tampered" });
  assert.equal(await exactBoundaryRepairResumeCandidate(args), null);
  console.log("narration boundary resume tests passed");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
