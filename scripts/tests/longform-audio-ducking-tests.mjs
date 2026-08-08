import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-audio-ducking-"));

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

try {
  const narrationPath = path.join(root, "narration.wav");
  const scorePath = path.join(root, "score.wav");
  const narrationReportPath = path.join(root, "narration_report.json");
  const scorePlanPath = path.join(root, "score_chapter_plan.json");

  await Promise.all([
    execFile("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=4",
      "-af", "volume='if(between(t,1.6,2.15),0,0.35)':eval=frame",
      "-ac", "1", narrationPath,
    ]),
    execFile("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "sine=frequency=180:sample_rate=44100:duration=4",
      "-af", "volume=0.25",
      "-ac", "2", scorePath,
    ]),
  ]);
  await writeJson(narrationReportPath, {
    status: "passed",
    output_path: narrationPath,
    source_script_hash: "fixture-script-hash",
    segments: [{ segment_id: "seg_001", duration_sec: 4 }],
  });
  await writeJson(scorePlanPath, {
    status: "passed",
    planner: "llm_audio_enrichment_v1",
    timing_source: "local_whisper_word_timing",
    timing_gate: { status: "passed" },
    source_script_hash: "fixture-script-hash",
    chapters: [{
      chapter_id: "chapter_001",
      start_sec: 0,
      end_sec: 4,
      gain_db: -12,
      asset_path: scorePath,
    }],
  });

  await execFile(process.execPath, [
    "scripts/modelslab-longform-audio-bed.mjs", "start",
    "--channel", "assetafterlife",
    "--series", "asset-afterlife",
    "--week", "fixture",
    "--episode", "ep_01",
    "--episodeDir", root,
    "--qwenReport", narrationReportPath,
    "--scorePlan", scorePlanPath,
    "--skip-sfx", "true",
    "--score-bed-trim-db", "-1.5",
    "--score-narration-ducking", "true",
    "--outputBase", "ducking-fixture",
    "--reportSuffix", "-ducking-fixture",
    "--keep-wav", "true",
  ], { cwd: process.cwd(), maxBuffer: 1024 * 1024 * 16 });

  const report = JSON.parse(await fs.readFile(path.join(root, "longform_audio_bed_report_ep_01-ducking-fixture.json"), "utf8"));
  assert.equal(report.status, "completed");
  assert.equal(report.mix.score_narration_ducking_requested, true);
  assert.equal(report.mix.score_narration_ducking_applied, true);
  assert.equal(report.mix.score_bed_trim_db, -1.5);
  assert.match(report.mix.score_bed_trim_scope, /score drops and SFX retain authored gain/);
  assert.deepEqual(report.mix.score_narration_ducking_policy, {
    threshold: 0.022,
    ratio: 7,
    attack_ms: 12,
    release_ms: 390,
    silence_surge_cap: {
      threshold: 0.016,
      ratio: 6,
      attack_ms: 20,
      release_ms: 200,
    },
  });
  assert.match(report.mix.score_narration_ducking_scope, /score drops and SFX retain authored gain/);
  assert.equal(await fs.stat(report.mix.wav_path).then((row) => row.isFile()), true);
  assert.equal(await fs.stat(report.mix.m4a_path).then((row) => row.isFile()), true);

  const { stdout } = await execFile("ffprobe", [
    "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels", "-of", "csv=p=0",
    report.mix.m4a_path,
  ]);
  assert.equal(Number(stdout.trim()), 2);

  await execFile(process.execPath, [
    "scripts/modelslab-longform-audio-bed.mjs", "start",
    "--channel", "assetafterlife",
    "--series", "asset-afterlife",
    "--week", "fixture",
    "--episode", "ep_01",
    "--episodeDir", root,
    "--qwenReport", narrationReportPath,
    "--scorePlan", scorePlanPath,
    "--skip-sfx", "true",
    "--score-bed-trim-db", "-3.5",
    "--score-bed-level-mode", "fixed_ducked",
    "--score-bed-fixed-duck-db", "-16.23",
    "--outputBase", "fixed-ducking-fixture",
    "--reportSuffix", "-fixed-ducking-fixture",
    "--keep-wav", "true",
  ], { cwd: process.cwd(), maxBuffer: 1024 * 1024 * 16 });
  const fixedReport = JSON.parse(await fs.readFile(path.join(root, "longform_audio_bed_report_ep_01-fixed-ducking-fixture.json"), "utf8"));
  assert.equal(fixedReport.mix.score_bed_level_mode, "fixed_ducked");
  assert.equal(fixedReport.mix.score_bed_trim_db, -3.5);
  assert.equal(fixedReport.mix.score_bed_fixed_duck_db, -16.23);
  assert.equal(fixedReport.mix.score_bed_effective_adjustment_db, -19.73);
  assert.equal(fixedReport.mix.score_narration_ducking_applied, false);
  console.log("longform audio ducking integration test passed");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
