import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildNarrationProviderOutputManifest } from "../lib/narration-provider-adapter.mjs";
import { canonicalQwenBatchSha256 } from "../lib/qwen-liam-batch-contract.mjs";
import { completedExactDeliveryRetakeFinalizationForTests } from "../run-status.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const hex = (letter) => letter.repeat(64);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-exact-finalize-"));
const write = async (name, value) => {
  const target = path.join(temp, name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const bytes = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(target, bytes);
  return { path: target, sha256: sha(bytes) };
};
try {
  const oldAudio = await write("audio/old-u1.wav", "old u1 audio");
  const newAudio = await write("audio/new-u1.wav", "new u1 audio");
  const keptAudio = await write("audio/kept-u2.wav", "kept u2 audio");
  const sourceHash = hex("a"), planHash = hex("b"), planFileSha256 = hex("c");
  const qualityHash = hex("d"), oldIdentity = hex("e"), newIdentity = hex("f");
  const keptIdentity = hex("1"), voiceHash = hex("2");
  const units = [
    { unit_id: "u1", spoken_text: "First sentence.",
      spoken_text_sha256: sha("First sentence.") },
    { unit_id: "u2", spoken_text: "Second sentence.",
      spoken_text_sha256: sha("Second sentence.") },
  ];
  const plan = { plan_sha256: planHash, source_script_hash: sourceHash, units };
  const policy = { primary: { provider: "qwen_local", voice_id: "joel",
    voice_sha256: voiceHash } };
  const manifestPath = path.join(temp, "narration_provider_output_manifest_ep_01.json");
  const reportPath = path.join(temp, "narration_tts_report_ep_01.json");
  const oldQa = { status: "blocked" };
  const priorReport = {
    schema: "goldflow_narration_tts_report_v1", status: "blocked",
    source_script_hash: sourceHash,
    narration_generation_plan_sha256: planHash,
    narration_generation_plan_file_sha256: planFileSha256,
    provider_output_manifest_path: manifestPath,
    provider_output_manifest_sha256: hex("3"),
    blockers: [{ unit_id: "u1", code: "narration_confirmed_unexpected_word" }],
    results: [
      { unit_id: "u1", attempt: 1, spoken_text_sha256: units[0].spoken_text_sha256,
        audio_path: oldAudio.path, audio_sha256: oldAudio.sha256,
        synthesis_identity_sha256: oldIdentity, selected_qa: oldQa,
        qa_status: "blocked" },
      { unit_id: "u2", attempt: 1, spoken_text_sha256: units[1].spoken_text_sha256,
        audio_path: keptAudio.path, audio_sha256: keptAudio.sha256,
        synthesis_identity_sha256: keptIdentity,
        selected_qa: { status: "passed" }, qa_status: "passed" },
    ],
  };
  const storedReport = await write("narration_tts_report_ep_01.json", priorReport);
  await write("snapshots/pre-retry-report.json", priorReport);
  const evidencePath = path.join(temp, "narration_confirmed_retry_evidence_ep_01.json");
  const evidence = {
    schema: "goldflow_confirmed_tts_retry_evidence_v2",
    evidence_basis: "reviewed_automated_delivery_qa",
    human_listening_performed: false,
    authorization_origin: "user_authorized_autonomous_asr_qa",
    operator_reason: "Automated dual-model delivery review confirmed a lexical defect in this exact first take.",
    authorized_by: "operator", authorized_at: "2026-10-01T18:00:00Z",
    maximum_attempts_per_unit: 1,
    source_script_sha256: sourceHash,
    narration_generation_plan_sha256: planHash,
    narration_generation_plan_file_sha256: planFileSha256,
    pre_retry_narration_report_sha256: storedReport.sha256,
    pre_retry_narration_report_path: path.join(temp, "snapshots/pre-retry-report.json"),
    confirmed_units: [{ unit_id: "u1", defect_type: "delivery", selected_attempt: 1,
      audio_sha256: oldAudio.sha256, synthesis_identity_sha256: oldIdentity,
      reviewed_blocker_codes: ["narration_confirmed_unexpected_word"],
      selected_qa_sha256: canonicalQwenBatchSha256(oldQa),
      evidence_note: "Both ASR passes identify the exact unexpected word in this first take." }],
  };
  const evidenceSha256 = (await write("narration_confirmed_retry_evidence_ep_01.json", evidence)).sha256;
  const runner = await write("runs/exact-attempt-two.json", { status: "passed",
    results: [{ unit_id: "u1", status: "generated", attempt: 2,
      output_path: newAudio.path, output_sha256: newAudio.sha256,
      synthesis_identity_sha256: newIdentity,
      spoken_text_sha256: units[0].spoken_text_sha256,
      token_limit_reached: false }] });
  const recovery = { unit_id: "u1", evidence_basis: "reviewed_automated_delivery_qa",
    human_listening_performed: false,
    origin_audio_sha256: oldAudio.sha256,
    origin_synthesis_identity_sha256: oldIdentity,
    confirmed_evidence_path: evidencePath,
    confirmed_evidence_sha256: evidenceSha256 };
  const manifest = buildNarrationProviderOutputManifest({
    provider: "qwen_local", modelId: "qwen", modelRevision: "revision",
    voiceId: "joel", voiceSha256: voiceHash,
    voiceContinuityContract: "owned-voice", generationPlanSha256: planHash,
    generationPlanFileSha256: planFileSha256, qualityContractSha256: qualityHash,
    providerExecution: { synthesis_runs: [{ attempt: 2, report_path: runner.path,
      report_sha256: runner.sha256 }] }, units,
    results: [
      { unit_id: "u1", model_id: "qwen", model_revision: "revision",
        voice_id: "joel", voice_sha256: voiceHash,
        voice_continuity_contract: "owned-voice", attempt: 2,
        audio_path: newAudio.path, audio_sha256: newAudio.sha256,
        duration_sec: 1, synthesis_identity_sha256: newIdentity,
        recovery_provenance: recovery,
        runner_report_path: runner.path, runner_report_sha256: runner.sha256 },
      { unit_id: "u2", model_id: "qwen", model_revision: "revision",
        voice_id: "joel", voice_sha256: voiceHash,
        voice_continuity_contract: "owned-voice", attempt: 1,
        audio_path: keptAudio.path, audio_sha256: keptAudio.sha256,
        duration_sec: 1, synthesis_identity_sha256: keptIdentity },
    ],
  });
  assert.equal(manifest.status, "passed");
  await write("narration_provider_output_manifest_ep_01.json", manifest);
  const args = { episodeDir: temp, episode: "ep_01", ttsReport: priorReport,
    ttsReportPath: reportPath, manifest, manifestPath, plan, planFileSha256,
    qualityContract: { contract_sha256: qualityHash }, policy,
    currentScriptHash: sourceHash };
  const result = await completedExactDeliveryRetakeFinalizationForTests(args);
  assert.equal(result.retainedUnitCount, 1);
  assert.deepEqual(result.repairedUnitIds, ["u1"]);
  for (const mutate of [
    (copy) => { copy.manifest.units[1].audio_sha256 = hex("0"); },
    (copy) => { copy.manifest.units[0].recovery_provenance.confirmed_evidence_sha256 = hex("0"); },
    (copy) => { copy.manifest.provider_execution.synthesis_runs[0].report_sha256 = hex("0"); },
    (copy) => { copy.manifest.units[0].runner_report_path = null; },
    (copy) => { copy.ttsReport.provider_output_manifest_sha256 = hex("0"); copy.manifest.units[1].audio_path = oldAudio.path; },
  ]) {
    const copy = structuredClone(args);
    mutate(copy);
    await assert.rejects(completedExactDeliveryRetakeFinalizationForTests(copy));
  }
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
console.log("narration exact-finalize resume tests passed");
