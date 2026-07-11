#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const flags = parseFlags(process.argv.slice(2));
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";

function parseFlags(parts) {
  const parsed = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--") ? parts[index + 1] : "true";
    parsed[key] = value;
    if (value !== "true") index += 1;
  }
  return parsed;
}

function requiredFlag(name, value) {
  if (!value) throw new Error(`Missing required --${name}.`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileSha256(filePath) {
  return sha256(await fs.readFile(filePath));
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function exists(filePath) {
  return Boolean(filePath) && fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
}

async function latestRenderReport(episodeDir, episode) {
  const names = await fs.readdir(episodeDir).catch(() => []);
  const matches = [];
  for (const name of names) {
    if (!new RegExp(`^render_report_${episode}.*\\.json$`).test(name)) continue;
    const filePath = path.join(episodeDir, name);
    const stat = await fs.stat(filePath).catch(() => null);
    if (stat) matches.push({ filePath, mtimeMs: stat.mtimeMs });
  }
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0]?.filePath ?? null;
}

async function probeMedia(filePath) {
  const ffprobe = flags.ffprobe ?? process.env.FFPROBE_BIN ?? "ffprobe";
  const { stdout } = await execFileAsync(ffprobe, [
    "-v", "error",
    "-show_entries", "format=duration,format_name:stream=index,codec_type,codec_name,width,height,pix_fmt",
    "-of", "json",
    filePath,
  ], { maxBuffer: 1024 * 1024 * 8 });
  return JSON.parse(stdout);
}

async function validateSourceHashes(sourceHashes) {
  const stale = [];
  const checked = [];
  for (const [sourcePath, expectedHash] of Object.entries(sourceHashes ?? {})) {
    if (!sourcePath || !expectedHash) continue;
    const currentHash = await fileSha256(sourcePath).catch(() => null);
    checked.push({ path: sourcePath, expected_sha256: expectedHash, current_sha256: currentHash });
    if (currentHash !== expectedHash) stale.push(sourcePath);
  }
  return { checked, stale };
}

async function main() {
  const episodeDir = flags["episode-dir"]
    ? path.resolve(flags["episode-dir"])
    : (() => {
        requiredFlag("channel", flags.channel);
        requiredFlag("week", flags.week);
        requiredFlag("episode", flags.episode);
        return path.join(dataRoot, "channels", flags.channel, "weekly_runs", flags.week, "episodes", flags.episode);
      })();
  const identity = await readJson(path.join(episodeDir, "run_identity.json"), {});
  const episode = flags.episode ?? identity.episode ?? path.basename(episodeDir);
  const renderReportPath = path.resolve(flags["render-report"] ?? await latestRenderReport(episodeDir, episode) ?? "");
  if (!renderReportPath || !(await exists(renderReportPath))) throw new Error("No render report found for final QA.");
  const renderReport = await readJson(renderReportPath, null);
  if (!renderReport) throw new Error(`Invalid render report: ${renderReportPath}`);
  const finalVideoPath = path.resolve(flags.video ?? renderReport.final_video_path ?? renderReport.output_path ?? renderReport.render_path ?? "");
  const blockers = [];
  if (String(renderReport.status ?? "").toLowerCase() !== "passed") blockers.push("render_report_not_passed");
  if (!finalVideoPath || !(await exists(finalVideoPath))) blockers.push("final_video_missing");
  const finalVideoHash = finalVideoPath && await exists(finalVideoPath) ? await fileSha256(finalVideoPath) : null;
  const expectedVideoHash = renderReport.final_video_sha256 ?? renderReport.output_hash ?? null;
  if (!expectedVideoHash) blockers.push("render_report_missing_final_video_hash");
  else if (finalVideoHash !== expectedVideoHash) blockers.push("final_video_hash_mismatch");
  const sourceValidation = await validateSourceHashes(renderReport.source_hashes);
  if (sourceValidation.stale.length) blockers.push("render_source_hash_stale");
  if (identity.schema === "goldflow_run_identity_v2" && !sourceValidation.checked.length) {
    blockers.push("render_report_missing_source_hashes");
  }

  let media = null;
  if (finalVideoHash) {
    try {
      media = await probeMedia(finalVideoPath);
      const streams = Array.isArray(media.streams) ? media.streams : [];
      const video = streams.find((stream) => stream.codec_type === "video");
      const audio = streams.find((stream) => stream.codec_type === "audio");
      const duration = Number(media.format?.duration ?? 0);
      if (!video) blockers.push("video_stream_missing");
      if (!audio) blockers.push("audio_stream_missing");
      if (!(duration > 0)) blockers.push("invalid_media_duration");
      if (video && !(Number(video.width) > Number(video.height))) blockers.push("final_video_not_landscape");
    } catch (error) {
      blockers.push("ffprobe_failed");
      media = { error: error instanceof Error ? error.message : String(error) };
    }
  }

  const approved = flags.approve === "true" || flags["operator-approved"] === "true";
  const status = blockers.length ? "blocked" : approved ? "passed" : "needs_review";
  const outputPath = path.resolve(flags.output ?? path.join(episodeDir, `final_qa_${episode}.json`));
  const report = {
    schema: "goldflow_final_qa_v2",
    status,
    episode,
    run_identity_schema: identity.schema ?? "missing",
    render_report_path: renderReportPath,
    render_report_sha256: await fileSha256(renderReportPath),
    final_video_path: finalVideoPath || null,
    final_video_sha256: finalVideoHash,
    expected_final_video_sha256: expectedVideoHash,
    source_hash_validation: sourceValidation,
    media_probe: media,
    blockers,
    approved,
    approved_by: approved ? flags["approved-by"] ?? "codex-agent" : null,
    approval_note: approved ? flags.note ?? "Render, source hashes, streams, and upload-safe geometry reviewed." : null,
    updated_at: new Date().toISOString(),
  };
  await writeJson(outputPath, report);
  console.log(JSON.stringify({ status, report_path: outputPath, blockers }, null, 2));
  if (status !== "passed") process.exitCode = 2;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export { validateSourceHashes as validateFinalQaSourceHashesForTests };
