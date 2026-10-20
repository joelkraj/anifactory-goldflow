import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const hash = async (p) => createHash("sha256").update(await fs.readFile(p)).digest("hex");

export async function verifyVoiceMigrationHandoff(options) {
  const { identity, identityFileSha256, episodeDir, reportPath, unitQaPath,
    reportSha256, unitQaSha256, workflowBypass, allowFullStageRerun, reason,
    outputDir, planSha256 } = options;
  const relock = identity.narration_identity_relock;
  if (!workflowBypass || !allowFullStageRerun || !String(reason ?? "").trim()
    || relock?.recovery_kind !== "operator_selected_qwen_voice_migration"
    || relock.voice_identity_changed !== true) {
    throw new Error("Voice migration requires an explicit authorized full revoice and identity relock");
  }
  const archiveDir = path.resolve(relock.archive_dir);
  const receiptPath = path.join(archiveDir, "tts_identity_relock_report.json");
  const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  if (receipt.run_identity_after_sha256 !== identityFileSha256
    || receipt.recovery_kind !== relock.recovery_kind
    || path.resolve(receipt.episode_dir) !== path.resolve(episodeDir)) {
    throw new Error("Voice migration archive does not bind the current episode identity");
  }
  for (const [p, expected] of [[reportPath, reportSha256], [unitQaPath, unitQaSha256]]) {
    const row = receipt.archived_artifacts?.find((r) => path.resolve(r.path) === path.resolve(p));
    if (!expected || row?.sha256 !== expected || await hash(row.archived_path) !== expected) {
      throw new Error(`Voice migration prior report is not preserved exactly: ${p}`);
    }
  }
  const audio = receipt.retained_historical_audio_assets ?? [];
  if (!audio.length) throw new Error("Voice migration has no archived historical audio");
  for (const row of audio) {
    if (!row.archived_path || row.archived_sha256 !== row.sha256
      || await hash(row.archived_path) !== row.sha256) {
      throw new Error(`Voice migration historical audio archive mismatch: ${row.path}`);
    }
  }
  return { schema: "goldflow_verified_voice_migration_handoff_v1", status: "passed",
    recorded_at: new Date().toISOString(), receipt_path: receiptPath,
    identity_sha256: identityFileSha256, plan_sha256: planSha256,
    voice_id: relock.narrator_voice_id, output_dir: outputDir,
    historical_report_sha256: reportSha256, historical_unit_qa_sha256: unitQaSha256,
    historical_audio_count: audio.length, reason };
}
