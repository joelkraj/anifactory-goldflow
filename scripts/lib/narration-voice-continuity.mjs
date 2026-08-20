import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sha256File } from "./file-hash.mjs";

const execFile = promisify(execFileCallback);
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RUNNER = path.resolve(MODULE_DIR, "../tts-speaker-similarity.py");
const DEFAULT_PYTHON =
  "/Users/joel/AniFactoryData/voice_bank/bakeoff/.venv-speaker-similarity/bin/python";

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function referenceRows(manifest) {
  return manifest?.references
    ?? manifest?.reference_variants
    ?? manifest?.samples
    ?? [];
}

function referenceAudioPath(row) {
  return row?.wav_path ?? row?.audio_path ?? row?.path ?? null;
}

function profileFields(profile = {}) {
  return [
    "voice_id",
    "voice_sha256",
    "voice_continuity_contract",
    "reference_manifest_path",
    "reference_manifest_sha256",
    "reference_voice_id",
    "reference_voice_sha256",
    "speaker_similarity_method",
    "speaker_similarity_model_path",
    "speaker_similarity_model_sha256",
    "speaker_similarity_calibration_path",
    "speaker_similarity_calibration_sha256",
  ].filter((field) => !String(profile?.[field] ?? "").trim());
}

export async function runNarrationVoiceContinuityQa({
  rows = [],
  profile = {},
  qualityContract = {},
  reportPath,
  pythonPath = process.env.ANIFACTORY_TTS_SIMILARITY_PYTHON
    ?? DEFAULT_PYTHON,
  runnerPath = DEFAULT_RUNNER,
} = {}) {
  const blockers = [];
  const warnings = [];
  const missingFields = profileFields(profile);
  if (missingFields.length) {
    return {
      status: "blocked",
      blockers: [{
        code: "narration_voice_continuity_profile_incomplete",
        fields: missingFields,
      }],
      warnings,
      units: [],
      report: null,
      report_path: reportPath ?? null,
    };
  }
  const requiredReferences = Number(
    qualityContract?.voice_identity_qa?.minimum_reference_count ?? 3,
  );
  const [manifestHash, modelHash, calibrationHash] = await Promise.all([
    sha256File(profile.reference_manifest_path).catch(() => null),
    sha256File(profile.speaker_similarity_model_path).catch(() => null),
    sha256File(profile.speaker_similarity_calibration_path).catch(() => null),
  ]);
  for (const [label, actual, expected] of [
    ["reference_manifest", manifestHash, profile.reference_manifest_sha256],
    ["similarity_model", modelHash, profile.speaker_similarity_model_sha256],
    ["similarity_calibration", calibrationHash, profile.speaker_similarity_calibration_sha256],
  ]) {
    if (!actual || actual !== expected) {
      blockers.push({
        code: "narration_voice_continuity_asset_hash_mismatch",
        asset: label,
        expected_sha256: expected,
        actual_sha256: actual,
      });
    }
  }
  const manifest = await readJson(profile.reference_manifest_path, null);
  const selectedReferences = referenceRows(manifest)
    .filter((row) => row?.status === "ready" && referenceAudioPath(row))
    .map((row) => path.resolve(referenceAudioPath(row)));
  if (selectedReferences.length < requiredReferences) {
    blockers.push({
      code: "narration_voice_reference_bank_too_small",
      required: requiredReferences,
      actual: selectedReferences.length,
    });
  }
  const candidateRows = [];
  for (const row of rows) {
    const audioPath = path.resolve(row.wav ?? row.audio_path ?? "");
    const audioSha256 = await sha256File(audioPath).catch(() => null);
    const expectedSha256 = row.audio_sha256 ?? row.unit_qa?.audio_sha256 ?? null;
    if (!audioSha256 || audioSha256 !== expectedSha256) {
      blockers.push({
        code: "narration_voice_candidate_audio_hash_mismatch",
        unit_id: row.unit_id,
        expected_sha256: expectedSha256,
        actual_sha256: audioSha256,
      });
    }
    candidateRows.push({
      unit_id: String(row.unit_id),
      audio_path: audioPath,
      audio_sha256: audioSha256,
    });
  }
  if (blockers.length) {
    return {
      status: "blocked",
      blockers,
      warnings,
      units: candidateRows,
      report: null,
      report_path: reportPath ?? null,
    };
  }
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  let executionError = null;
  try {
    await execFile(pythonPath, [
      runnerPath,
      "--model", profile.speaker_similarity_model_path,
      ...selectedReferences.flatMap((referencePath) => [
        "--reference",
        referencePath,
      ]),
      ...candidateRows.flatMap((candidate) => [
        "--candidate",
        candidate.audio_path,
      ]),
      "--output", reportPath,
      "--reference-voice-id", profile.reference_voice_id,
      "--reference-voice-sha256", profile.reference_voice_sha256,
      "--threshold-mode", "reference_leave_one_out",
      "--calibration-hard-margin", "0.05",
      "--calibration-warning-margin", "0",
      "--calibration-aggregate-margin", "0.03",
    ], { maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    executionError = error instanceof Error ? error.message : String(error);
    // The helper deliberately exits non-zero when a candidate falls below a
    // calibrated floor, while still writing the complete evidence report.
  }
  const report = await readJson(reportPath, null);
  const reportSha256 = report ? await sha256File(reportPath) : null;
  const reportReferences = report?.references ?? [];
  const reportCandidates = report?.candidates ?? [];
  const identityValid = Boolean(
    report
      && report.schema === "goldflow_tts_voice_continuity_qa_v1"
      && report.method === profile.speaker_similarity_method
      && report.model_sha256 === profile.speaker_similarity_model_sha256
      && report.threshold_mode === "reference_leave_one_out"
      && report.reference_voice_id === profile.reference_voice_id
      && report.reference_voice_sha256 === profile.reference_voice_sha256
      && reportReferences.length === selectedReferences.length
      && reportCandidates.length === candidateRows.length
      && Number.isFinite(Number(report.minimum_cosine_similarity))
      && Number.isFinite(Number(report.warning_below_cosine_similarity))
      && Number(report.minimum_cosine_similarity)
        < Number(report.warning_below_cosine_similarity)
  );
  if (!identityValid) {
    blockers.push({
      code: "narration_voice_continuity_report_identity_invalid",
      report_path: reportPath,
      execution_error: executionError,
    });
  }
  const candidateByHash = new Map(
    reportCandidates.map((candidate) => [candidate.audio_sha256, candidate]),
  );
  const units = candidateRows.map((row) => {
    const candidate = candidateByHash.get(row.audio_sha256) ?? null;
    const unitWarnings = [];
    if (!candidate) {
      blockers.push({
        code: "narration_voice_continuity_candidate_missing",
        unit_id: row.unit_id,
      });
    } else {
      const similarity = Number(candidate.cosine_similarity);
      const hardFloor = Number(report.minimum_cosine_similarity);
      const warningFloor = Number(report.warning_below_cosine_similarity);
      if (!Number.isFinite(similarity)) {
        blockers.push({
          code: "narration_voice_similarity_not_measurable",
          unit_id: row.unit_id,
        });
      } else if (similarity < hardFloor) {
        unitWarnings.push({
          severity: "warning",
          code: "narration_voice_similarity_below_calibrated_hard_floor",
          cosine_similarity: similarity,
          hard_floor: hardFloor,
          review_required: true,
          automatic_retry_allowed: false,
        });
      } else if (similarity < warningFloor) {
        unitWarnings.push({
          severity: "warning",
          code: "narration_voice_similarity_low_margin",
          cosine_similarity: similarity,
          warning_floor: warningFloor,
          review_required: true,
          automatic_retry_allowed: false,
        });
      }
    }
    warnings.push(...unitWarnings.map((warning) => ({
      ...warning,
      unit_id: row.unit_id,
    })));
    return {
      ...row,
      status: candidate ? "passed" : "blocked",
      cosine_similarity: candidate?.cosine_similarity ?? null,
      minimum_cosine_similarity: report?.minimum_cosine_similarity ?? null,
      warning_below_cosine_similarity:
        report?.warning_below_cosine_similarity ?? null,
      reference_voice_id: profile.reference_voice_id,
      reference_voice_sha256: profile.reference_voice_sha256,
      reference_audio_sha256s: reportReferences.map((item) => item.audio_sha256),
      reference_count: reportReferences.length,
      similarity_method: report?.method ?? null,
      similarity_model_sha256: report?.model_sha256 ?? null,
      similarity_calibration_sha256:
        profile.speaker_similarity_calibration_sha256,
      threshold_mode: report?.threshold_mode ?? null,
      reference_leave_one_out_floor:
        report?.calibration?.reference_leave_one_out_floor ?? null,
      aggregate_voice_similarity: report?.candidate_aggregate ?? null,
      aggregate_status: report?.aggregate_status ?? null,
      voice_continuity_contract: profile.voice_continuity_contract,
      report_path: reportPath,
      report_sha256: reportSha256,
      warnings: unitWarnings,
    };
  });
  if (report?.aggregate_status === "blocked") {
    warnings.push({
      severity: "warning",
      code: "narration_voice_aggregate_below_calibrated_floor",
      aggregate: report.candidate_aggregate ?? null,
      review_required: true,
      automatic_retry_allowed: false,
    });
  }
  return {
    schema: "goldflow_narration_voice_continuity_qa_v2",
    status: blockers.length
      ? "blocked"
      : warnings.length ? "passed_with_warnings" : "passed",
    voice_id: profile.voice_id,
    voice_sha256: profile.voice_sha256,
    voice_continuity_contract: profile.voice_continuity_contract,
    report_path: reportPath,
    report_sha256: reportSha256,
    execution_error: executionError,
    reference_count: selectedReferences.length,
    candidate_count: candidateRows.length,
    blockers,
    warnings,
    units,
    report,
  };
}
