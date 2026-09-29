import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { blockedFullStreamPolicyRefreshEligibleForTests } from "../run-status.mjs";
import { TRANSCRIPT_QA_COMPARISON_VERSION } from "../modelslab-qwen-episode-audio.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const episodeDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-full-stream-status-"));
try {
  const manifestPath = path.join(episodeDir, "derived-manifest.json");
  const unitPath = path.join(episodeDir, "unit.wav");
  const preparedPath = path.join(episodeDir, "prepared.wav");
  const rawPath = path.join(episodeDir, "raw.wav");
  const masterPath = path.join(episodeDir, "master.wav");
  await fs.writeFile(unitPath, "immutable unit");
  await fs.writeFile(preparedPath, "immutable prepared");
  await fs.writeFile(rawPath, "immutable raw");
  await fs.writeFile(masterPath, "immutable master");
  const unitHash = hash("immutable unit");
  const preparedHash = hash("immutable prepared");
  const rawHash = hash("immutable raw");
  const masterHash = hash("immutable master");
  const providerOutput = { status: "passed", units: [{ unit_id: "unit-1", audio_path: unitPath,
    audio_sha256: unitHash }] };
  const checkpointPath = path.join(episodeDir, "narration-finalization-checkpoint-" + path.basename(episodeDir) + ".json");
  const checkpoint = { stages: { semantic_stitch: { status: "passed", payload: {
    raw_wav_path: rawPath, raw_wav_sha256: rawHash,
    stitch: { status: "passed", prepared_inputs: [{ unit_id: "unit-1", source_wav: unitPath,
      prepared_wav: preparedPath, prepared_audio_sha256: preparedHash }] },
  } } } };
  await fs.writeFile(checkpointPath, JSON.stringify(checkpoint));
  await fs.writeFile(manifestPath, JSON.stringify(providerOutput));
  const manifestHash = hash(JSON.stringify(providerOutput));
  const scriptHash = hash("approved script");
  const planHash = hash("plan content");
  const planFileHash = hash("plan file");
  const contractHash = hash("contract");
  const common = {
    source_script_hash: scriptHash,
    narration_generation_plan_sha256: planHash,
    narration_generation_plan_file_sha256: planFileHash,
    narration_quality_contract_sha256: contractHash,
  };
  const fusionQa = {
    first_token_ok: true, last_token_ok: true, deletions: 1, insertions: 0,
    operations: [
      { type: "match", intended: "that", recognized: "that" },
      { type: "deletion", intended: "a", recognized: null },
      { type: "substitution", intended: "morrow", recognized: "amaro" },
      { type: "match", intended: "joey", recognized: "joey" },
    ],
  };
  const finding = { code: "narration_confirmed_word_omission", intended_tokens: ["a"],
    confirmation_window_id: "window-1" };
  const window = { window_id: "window-1", unit_ids: ["unit-1"], boundary_ids: [],
    primary_transcript_qa: fusionQa, confirmation_transcript_qa: fusionQa,
    decision: { status: "blocked", blockers: [finding] } };
  const args = {
    episodeDir,
    ttsReport: { ...common, status: "blocked", unit_qa_status: "passed_with_warnings",
      full_stream_qa_status: "blocked", provider_output_manifest_path: manifestPath,
      provider_output_manifest_sha256: manifestHash, final_wav: masterPath,
      final_wav_sha256: masterHash, raw_wav: rawPath, raw_wav_sha256: rawHash },
    stitchReport: { ...common, status: "blocked", output_path: masterPath,
      output_sha256: masterHash, raw_output_path: rawPath, raw_output_sha256: rawHash,
      segments: [{ unit_id: "unit-1", prepared_audio_path: preparedPath,
        prepared_audio_sha256: preparedHash }],
      sample_accounting: { exact_sample_accounting: true },
      join_qa: { status: "passed" } },
    fullQa: { ...common, status: "blocked", transcript_comparison_version: TRANSCRIPT_QA_COMPARISON_VERSION,
      delivery_consensus_version: "old-consensus", provider_output_manifest_file_sha256: manifestHash,
      audio_path: masterPath, audio_sha256: masterHash, blockers: [finding],
      confirmation_windows: [window] },
    unitDelivery: { ...common, status: "passed_with_warnings", blocked_unit_count: 0,
      blockers: [], quality_contract_sha256: contractHash },
    providerOutput, providerValidation: { status: "passed" },
    plan: { source_script_hash: scriptHash, plan_sha256: planHash },
    planFileSha256: planFileHash, currentScriptHash: scriptHash,
    qualityContractSha256: contractHash,
  };
  assert.equal(await blockedFullStreamPolicyRefreshEligibleForTests(args), true);
  assert.equal(await blockedFullStreamPolicyRefreshEligibleForTests({
    ...args, ttsReport: { ...args.ttsReport, provider_output_manifest_sha256: hash("stale") },
  }), false);
  assert.equal(await blockedFullStreamPolicyRefreshEligibleForTests({
    ...args, fullQa: { ...args.fullQa, audio_sha256: hash("stale") },
  }), false);
  assert.equal(await blockedFullStreamPolicyRefreshEligibleForTests({
    ...args, fullQa: { ...args.fullQa, blockers: [...args.fullQa.blockers,
      { code: "narration_confirmed_final_token_mismatch" }] },
  }), false);
  await fs.writeFile(preparedPath, "mutated prepared");
  assert.equal(await blockedFullStreamPolicyRefreshEligibleForTests(args), false);
  await fs.writeFile(preparedPath, "immutable prepared");
  await fs.writeFile(rawPath, "mutated raw");
  assert.equal(await blockedFullStreamPolicyRefreshEligibleForTests(args), false);
  await fs.writeFile(rawPath, "immutable raw");
  await fs.writeFile(unitPath, "tampered unit");
  assert.equal(await blockedFullStreamPolicyRefreshEligibleForTests(args), false);
} finally {
  await fs.rm(episodeDir, { recursive: true, force: true });
}
console.log("narration-full-stream-status-refresh-tests: passed");
