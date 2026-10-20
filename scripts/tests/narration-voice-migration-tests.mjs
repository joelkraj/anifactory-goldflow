import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { verifyVoiceMigrationHandoff } from "../lib/narration-voice-migration.mjs";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-migration-test-"));
const sha = (s) => createHash("sha256").update(s).digest("hex");
try {
  const reportPath = path.join(dir, "report.json"), unitQaPath = path.join(dir, "qa.json");
  const archivedReport = path.join(dir, "old-report.json"), archivedQa = path.join(dir, "old-qa.json");
  const archivedWav = path.join(dir, "old.wav");
  await fs.writeFile(archivedReport, "report");
  await fs.writeFile(archivedQa, "qa");
  await fs.writeFile(archivedWav, "historical audio fixture");
  const receipt = {
    episode_dir: dir, run_identity_after_sha256: "identity",
    recovery_kind: "operator_selected_qwen_voice_migration",
    archived_artifacts: [
      { path: reportPath, archived_path: archivedReport, sha256: sha("report") },
      { path: unitQaPath, archived_path: archivedQa, sha256: sha("qa") },
    ],
    retained_historical_audio_assets: [{ path: "prior master", archived_path: archivedWav,
      sha256: sha("historical audio fixture"), archived_sha256: sha("historical audio fixture") }],
  };
  await fs.writeFile(path.join(dir, "tts_identity_relock_report.json"), JSON.stringify(receipt));
  const args = { identity: { narration_identity_relock: { archive_dir: dir,
    recovery_kind: receipt.recovery_kind, voice_identity_changed: true, narrator_voice_id: "new_voice" } },
  identityFileSha256: "identity", episodeDir: dir, reportPath, unitQaPath,
  reportSha256: sha("report"), unitQaSha256: sha("qa"), workflowBypass: true,
  allowFullStageRerun: true, reason: "Explicit full revoice", outputDir: "new-output", planSha256: "new-plan" };
  assert.equal((await verifyVoiceMigrationHandoff(args)).status, "passed");
  await assert.rejects(verifyVoiceMigrationHandoff({ ...args, allowFullStageRerun: false }));
  await assert.rejects(verifyVoiceMigrationHandoff({ ...args, identityFileSha256: "wrong" }));
  await assert.rejects(verifyVoiceMigrationHandoff({ ...args, unitQaSha256: "wrong" }));
  await fs.writeFile(archivedWav, "corrupt audio");
  await assert.rejects(verifyVoiceMigrationHandoff(args));
  console.log("Voice migration archive, scope, report and audio tamper tests passed");
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
