import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { materializeProductionManifest } from "../lib/execution-provenance.mjs";
import { PIPELINE_STAGE_REGISTRY } from "../lib/pipeline-stage-registry.mjs";

const execFileAsync = promisify(execFile);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileSha256(filePath) {
  return sha256(await fs.readFile(filePath));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function runProviderFreeSyntheticE2e() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-synthetic-e2e-"));
  const sourcePath = path.join(root, "source.md");
  await fs.writeFile(sourcePath, "He opened the ledger. The system answered. He chose to stand.\n", "utf8");
  const env = { ...process.env, ANIFACTORY_DATA_ROOT: root };
  const base = ["--channel", "synthetic", "--series", "provider_free", "--week", "synthetic-e2e", "--episode", "ep_01"];
  await execFileAsync(process.execPath, [
    "scripts/run-preflight.mjs", ...base,
    "--title", "Synthetic Provider Free E2E",
    "--source", sourcePath,
    "--image-provider", "modelslab",
    "--audio-target", "narrator_only",
    "--run-intent", "proof",
    "--proof-scope", "0-5",
    "--allow-dirty-worktree", "true",
    "--dirty-reason", "provider-free synthetic integration fixture",
  ], { cwd: process.cwd(), env });
  await execFileAsync(process.execPath, ["scripts/source-ingest.mjs", ...base, "--source", sourcePath], { cwd: process.cwd(), env });
  const episodeDir = path.join(root, "channels", "synthetic", "weekly_runs", "synthetic-e2e", "episodes", "ep_01");
  const scriptPath = path.join(episodeDir, "script_clean.md");
  await execFileAsync(process.execPath, ["scripts/script-approve.mjs", ...base, "--hash", await fileSha256(scriptPath)], { cwd: process.cwd(), env });

  const evidencePath = path.join(episodeDir, "synthetic_provider_free_evidence.json");
  await writeJson(evidencePath, { schema: "goldflow_synthetic_e2e_evidence_v1", status: "passed", provider_calls: 0 });
  await writeJson(path.join(episodeDir, "cut_execution_ledger.json"), {
    schema: "goldflow_cut_execution_ledger_v1",
    status: "passed",
    cut_count: 1,
    completed_image_count: 1,
    pending_image_qa_count: 0,
    cuts: [{ image_id: "synthetic-cut-001", image_sha256: "synthetic", image_qa_status: "passed_structural" }],
  });
  const videoPath = path.join(episodeDir, "assets", "renders", "synthetic-proof.mp4");
  await fs.mkdir(path.dirname(videoPath), { recursive: true });
  await execFileAsync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "color=c=0x1b2230:s=640x360:d=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", videoPath,
  ], { maxBuffer: 1024 * 1024 * 8 });
  const renderReportPath = path.join(episodeDir, "render_report_ep_01.json");
  await writeJson(renderReportPath, {
    schema: "goldflow_render_report_v2",
    status: "passed",
    final_video_path: videoPath,
    final_video_sha256: await fileSha256(videoPath),
    source_hashes: { [evidencePath]: await fileSha256(evidencePath) },
  });
  await execFileAsync(process.execPath, [
    "scripts/final-qa.mjs", "--episode-dir", episodeDir, "--episode", "ep_01",
    "--render-report", renderReportPath, "--approve", "true", "--approved-by", "synthetic-suite", "--note", "provider-free synthetic end-to-end fixture",
  ], { cwd: process.cwd(), env });
  const finalQa = JSON.parse(await fs.readFile(path.join(episodeDir, "final_qa_ep_01.json"), "utf8"));
  assert.equal(finalQa.status, "passed");

  const now = new Date().toISOString();
  const events = PIPELINE_STAGE_REGISTRY.map((stage, index) => ({
    schema: "goldflow_execution_event_v1",
    event_type: "stage_completed",
    execution_id: randomUUID(),
    stage: stage.id,
    status: stage.id === "sfx_score_plan" ? "skipped_with_waiver" : "passed",
    attempt: 1,
    scope_sha256: sha256("synthetic-proof-0-5"),
    immutable_report_path: stage.id === "final_qa" ? path.join(episodeDir, "final_qa_ep_01.json") : evidencePath,
    completed_at: now,
    wall_time_sec: Number((0.001 * (index + 1)).toFixed(3)),
    cost_usd: 0,
    cache_reuse_count: 0,
  }));
  await fs.writeFile(path.join(episodeDir, "execution_events.jsonl"), `${events.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  const manifest = await materializeProductionManifest(episodeDir);
  assert.equal(manifest.telemetry.total_stage_calls, PIPELINE_STAGE_REGISTRY.length);
  assert.equal(manifest.telemetry.cumulative_cost_usd, 0);
  assert.equal(Object.keys(manifest.stage_latest).length, PIPELINE_STAGE_REGISTRY.length);
  await fs.rm(root, { recursive: true, force: true });
}

await runProviderFreeSyntheticE2e();
console.log("goldflow integration suite passed (provider-free preflight through final QA)");
