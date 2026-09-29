import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { qwenExactBoundaryRepairStatusForTests } from "../run-status.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-qwen-boundary-triage-"));

try {
  const episode = "ep_01";
  const sourceScriptHash = sha256("locked source");
  const ttsReport = { status: "blocked" };
  const reportPath = path.join(temp, `narration_tts_report_${episode}.json`);
  const reportText = `${JSON.stringify(ttsReport)}\n`;
  await fs.writeFile(reportPath, reportText);
  const oldSpecPath = path.join(temp, "old-spec.json");
  const newSpecPath = path.join(temp, "new-spec.json");
  await fs.writeFile(oldSpecPath, "old scope\n");
  await fs.writeFile(newSpecPath, "one current unit\n");
  const triage = (specPath, specHash) => ({
    status: "operator_hold_pending_exact_boundary_recovery",
    source_script_sha256: sourceScriptHash,
    blocked_report_sha256: sha256(reportText),
    repair_spec_path: specPath,
    repair_spec_sha256: specHash,
  });
  const v3Path = path.join(temp, `manual_blocker_triage_qwen_tts_stitch_${episode}_v3.json`);
  const v4Path = path.join(temp, `manual_blocker_triage_qwen_tts_stitch_${episode}_v4.json`);
  await fs.writeFile(v3Path, JSON.stringify(triage(oldSpecPath, sha256("old scope\n"))));
  await fs.writeFile(v4Path, JSON.stringify(triage(newSpecPath, sha256("one current unit\n"))));

  const status = () => qwenExactBoundaryRepairStatusForTests({
    episodeDir: temp, episode, ttsReportPath: reportPath, ttsReport,
    currentScriptHash: sourceScriptHash,
  });
  assert.equal((await status()).next_command_shape,
    `node bin/goldflow.mjs tts repair-boundary --episode-dir ${temp} --spec ${newSpecPath}`);
  await fs.writeFile(v4Path, JSON.stringify(triage(newSpecPath, sha256("wrong spec"))));
  assert.match((await status()).next_command_shape, /^Operator hold:/);
  await fs.writeFile(v4Path, JSON.stringify({
    ...triage(newSpecPath, sha256("one current unit\n")),
    blocked_report_sha256: sha256("stale report"),
  }));
  assert.equal(await status(), null, "a stale v4 receipt must not fall back to v3");
  await fs.rm(v4Path);
  assert.equal((await status()).next_command_shape,
    `node bin/goldflow.mjs tts repair-boundary --episode-dir ${temp} --spec ${oldSpecPath}`);
  console.log("PASS Qwen boundary triage v4 priority, exact route, stale hold, and v3 fallback");
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
