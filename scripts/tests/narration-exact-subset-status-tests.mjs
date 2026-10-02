import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { reviewedAutomatedRetryStatusForTests } from "../run-status.mjs";
import { canonicalQwenBatchSha256 } from "../lib/qwen-liam-batch-contract.mjs";
import { exactBlockedNarrationRetakeAdmission } from "../lib/narration-exact-retake-guard.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-narration-subset-"));
try {
  const episode = "ep_01";
  const sourceHash = sha("locked source");
  const planHash = sha("canonical plan");
  const planPath = path.join(temp, "narration_generation_plan.json");
  await fs.writeFile(planPath, JSON.stringify({
    plan_sha256: planHash, source_script_hash: sourceHash,
  }));
  const planFileHash = sha(await fs.readFile(planPath));
  const audioPath = path.join(temp, "unit.wav");
  await fs.writeFile(audioPath, "immutable first take");
  const selectedQa = { status: "blocked",
    delivery: { schema: "goldflow_narration_delivery_consensus_v2",
      status: "blocked", blockers: [{ code: "narration_confirmed_word_omission",
        severity: "blocker" }] } };
  const first = { unit_id: "u1", attempt: 1, audio_path: audioPath,
    audio_sha256: sha("immutable first take"),
    synthesis_identity_sha256: sha("first synthesis"),
    selected_qa: selectedQa, qa_status: "blocked" };
  const second = { unit_id: "u2", attempt: 1, audio_path: audioPath,
    audio_sha256: first.audio_sha256,
    synthesis_identity_sha256: sha("second synthesis"),
    selected_qa: selectedQa, qa_status: "blocked" };
  const report = { schema: "goldflow_narration_tts_report_v1",
    status: "blocked", source_script_hash: sourceHash,
    narration_generation_plan_sha256: planHash,
    narration_generation_plan_file_sha256: planFileHash,
    results: [first, second], blockers: [
      { unit_id: "u1", code: "narration_confirmed_word_omission" },
      { unit_id: "u2", code: "narration_confirmed_word_omission" },
    ] };
  const reportPath = path.join(temp, `narration_tts_report_${episode}.json`);
  await fs.writeFile(reportPath, JSON.stringify(report));
  const archivePath = path.join(temp, "immutable-pre-retry-report.json");
  await fs.copyFile(reportPath, archivePath);
  const evidencePath = path.join(temp,
    `narration_confirmed_retry_evidence_${episode}.json`);
  const evidence = { schema: "goldflow_confirmed_tts_retry_evidence_v2",
    evidence_basis: "reviewed_automated_delivery_qa",
    human_listening_performed: false,
    authorization_origin: "user_authorized_autonomous_asr_qa",
    operator_reason: "Two retained ASR passes identify an exact material omission in the first selected take.",
    authorized_by: "Codex production operator",
    authorized_at: "2026-10-01T20:00:00.000Z",
    maximum_attempts_per_unit: 1,
    source_script_sha256: sourceHash,
    narration_generation_plan_sha256: planHash,
    narration_generation_plan_file_sha256: planFileHash,
    pre_retry_narration_report_sha256: sha(await fs.readFile(reportPath)),
    pre_retry_narration_report_path: archivePath,
    confirmed_units: [{
      unit_id: "u1", defect_type: "delivery", selected_attempt: 1,
      audio_sha256: first.audio_sha256,
      synthesis_identity_sha256: first.synthesis_identity_sha256,
      reviewed_blocker_codes: ["narration_confirmed_word_omission"],
      selected_qa_sha256: canonicalQwenBatchSha256(selectedQa),
      evidence_note: "The first take has the exact confirmed word omission in current QA.",
    }] };
  await fs.writeFile(evidencePath, JSON.stringify(evidence));
  const status = () => reviewedAutomatedRetryStatusForTests({
    episodeDir: temp, episode, ttsReport: report,
    ttsReportPath: reportPath, currentScriptHash: sourceHash,
  });
  const exact = await status();
  assert.match(exact.next_command_shape, /--confirmed-retry-unit-ids u1\b/);
  assert.doesNotMatch(exact.next_command_shape, /u2/);
  const accepted = exactBlockedNarrationRetakeAdmission({
    episode_dir: temp, current_stage: "qwen_tts_stitch",
    current_stage_state: "blocked",
    next_command_shape: exact.next_command_shape,
  }, "tts", "narrate", {
    "episode-dir": temp, "confirmed-retry-unit-ids": "u1",
    "confirmed-retry-evidence": evidencePath,
  });
  assert.equal(accepted.allowed, true);
  for (const extra of [
    { "confirmed-retry-unit-ids": "u1,u2" },
    { concurrency: "1" },
    { "confirmed-retry-evidence": path.join(temp, "other.json") },
  ]) {
    assert.equal(exactBlockedNarrationRetakeAdmission({
      episode_dir: temp, current_stage: "qwen_tts_stitch",
      current_stage_state: "blocked",
      next_command_shape: exact.next_command_shape,
    }, "tts", "narrate", {
      "episode-dir": temp, "confirmed-retry-unit-ids": "u1",
      "confirmed-retry-evidence": evidencePath, ...extra,
    }).allowed, false);
  }
  assert.equal(exactBlockedNarrationRetakeAdmission({
    episode_dir: temp, current_stage: "qwen_tts_stitch",
    current_stage_state: "blocked", next_command_shape: "Operator hold",
  }, "tts", "narrate", { "episode-dir": temp }).allowed, false);
  const secondAudioPath = path.join(temp, "unit-second.wav");
  await fs.writeFile(secondAudioPath, "selected exact second take");
  const secondReport = { ...report,
    blockers: [{ unit_id: "u2", code: "narration_confirmed_word_omission" }],
    results: [{ ...first, attempt: 2, audio_path: secondAudioPath,
      audio_sha256: sha("selected exact second take"),
      synthesis_identity_sha256: sha("second take identity"),
      recovery_provenance: { evidence_basis: "reviewed_automated_delivery_qa",
        confirmed_evidence_path: evidencePath,
        confirmed_evidence_sha256: sha(await fs.readFile(evidencePath)),
        origin_audio_sha256: first.audio_sha256,
        origin_synthesis_identity_sha256: first.synthesis_identity_sha256 } }, second] };
  const originalReportBytes = await fs.readFile(reportPath);
  await fs.writeFile(reportPath, JSON.stringify(secondReport));
  const consumed = () => reviewedAutomatedRetryStatusForTests({
    episodeDir: temp, episode, ttsReport: secondReport,
    ttsReportPath: reportPath, currentScriptHash: sourceHash,
  });
  assert.equal(await consumed(), null);
  await fs.writeFile(secondAudioPath, "mutated second take");
  assert.match((await consumed()).next_command_shape, /^Operator hold:/);
  await fs.writeFile(secondAudioPath, "selected exact second take");
  const boundaryDir = path.join(temp, "exact-boundary");
  await fs.mkdir(boundaryDir);
  const boundaryPriorManifestPath = path.join(boundaryDir, "prior_manifest.json");
  const boundaryPriorReportPath = path.join(boundaryDir, "prior_report.json");
  await fs.writeFile(boundaryPriorManifestPath, JSON.stringify({ units: [secondReport.results[0]] }));
  await fs.writeFile(boundaryPriorReportPath, JSON.stringify(secondReport));
  const boundaryRequestPath = path.join(boundaryDir, "request.json");
  const boundaryResultPath = path.join(boundaryDir, "repair-result.json");
  await fs.writeFile(boundaryRequestPath, JSON.stringify({ request_sha256: sha("boundary request"),
    prior_manifest_file_sha256: sha(await fs.readFile(boundaryPriorManifestPath)),
    prior_report_file_sha256: sha(await fs.readFile(boundaryPriorReportPath)) }));
  await fs.writeFile(boundaryResultPath, "completed boundary result");
  const compositePath = path.join(boundaryDir, "composite.wav");
  await fs.writeFile(compositePath, "selected boundary composite");
  const supersededReport = { ...secondReport, results: [{ ...secondReport.results[0],
    audio_path: compositePath, audio_sha256: sha("selected boundary composite"),
    recovery_provenance: {
      schema: "goldflow_tts_exact_boundary_repair_provenance_v1",
      request_path: boundaryRequestPath, request_sha256: sha("boundary request"),
      result_path: boundaryResultPath,
      result_sha256: sha("completed boundary result"),
      prior_audio_sha256: secondReport.results[0].audio_sha256,
      prior_synthesis_identity_sha256: secondReport.results[0].synthesis_identity_sha256,
    } }, second] };
  await fs.writeFile(reportPath, JSON.stringify(supersededReport));
  const superseded = () => reviewedAutomatedRetryStatusForTests({
    episodeDir: temp, episode, ttsReport: supersededReport,
    ttsReportPath: reportPath, currentScriptHash: sourceHash,
  });
  assert.equal(await superseded(), null);
  await fs.writeFile(boundaryResultPath, "corrupted boundary result");
  assert.match((await superseded()).next_command_shape, /^Operator hold:/);
  await fs.writeFile(reportPath, originalReportBytes);
  await fs.writeFile(audioPath, "mutated");
  assert.match((await status()).next_command_shape, /^Operator hold:/);
  await fs.writeFile(audioPath, "immutable first take");
  await fs.writeFile(archivePath, "mutated");
  assert.match((await status()).next_command_shape, /^Operator hold:/);
  console.log("PASS hash-bound narration subset route, exact command guard, and stale audio/report holds");
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
