#!/usr/bin/env node
// Guarded exact post-render narration patch. See docs/workflows/narration_final_patch.md.
import { execFile as execFileCb, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { sha256File } from "./lib/file-hash.mjs";
import { masterNarrationTwoPass } from "./lib/narration-mastering.mjs";
import { NARRATION_FINAL_PATCH_RECEIPT_SCHEMA, NARRATION_FINAL_PATCH_SPEC_SCHEMA, parsePcm16Wav, spliceRetakes, unitWindows } from "./lib/narration-final-patch.mjs";

const execFile = promisify(execFileCb);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const need = (ok, message) => { if (!ok) throw new Error(`Narration final patch: ${message}`); };
const flags = {};
for (let i = 2; i < process.argv.length; i += 2) {
  need(process.argv[i]?.startsWith("--") && process.argv[i + 1], "flags require explicit values");
  flags[process.argv[i].slice(2)] = process.argv[i + 1];
}
need(Object.keys(flags).every((key) => ["episode-dir", "spec"].includes(key)), "only --episode-dir and --spec are accepted");
const episodeDir = path.resolve(flags["episode-dir"] ?? "");
const specPath = path.resolve(flags.spec ?? "");
need(specPath.startsWith(`${episodeDir}${path.sep}`), "spec must live inside the episode directory");

const statusCall = spawnSync(process.execPath, [path.join(repoRoot, "bin", "goldflow.mjs"), "run", "status", "--episode-dir", episodeDir, "--format", "json"],
  { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
need(statusCall.status === 0, `status failed: ${statusCall.stderr}`);
const status = JSON.parse(statusCall.stdout);
const finalQa = status.stage_ledger?.find((row) => row.stage === "final_qa");
need(finalQa?.state === "passed", "admission requires a passed final QA on the current render");
need(status.identity?.audio_target === "narrator_only", "only narrator-only renders are supported");

const spec = JSON.parse(await fs.readFile(specPath, "utf8"));
const specSha = await sha256File(specPath);
need(spec.schema === NARRATION_FINAL_PATCH_SPEC_SCHEMA && spec.status === "approved", "spec schema/status invalid");
for (const key of ["reviewer", "note", "operator_quote"]) need(String(spec[key] ?? "").trim().length >= 3, `spec ${key} required`);
const renderReportPath = path.resolve(spec.render_report_path ?? "");
need(await sha256File(renderReportPath) === spec.render_report_sha256, "render report changed since review");
const renderReport = JSON.parse(await fs.readFile(renderReportPath, "utf8"));
need(renderReport.status === "passed" && await sha256File(renderReport.final_video_path) === spec.final_video_sha256
  && renderReport.final_video_sha256 === spec.final_video_sha256, "final video changed since review");
const stitchPath = renderReport.audio_stitch_report_path;
need(await sha256File(stitchPath) === spec.stitch_report_sha256, "stitch report changed since review");
const stitch = JSON.parse(await fs.readFile(stitchPath, "utf8"));
need(stitch.final_wav_sha256 === renderReport.final_audio_loudnorm?.source_audio_sha256, "render audio is not the stitched master");
need(await sha256File(stitch.raw_output_path) === stitch.raw_output_sha256 && stitch.raw_output_sha256 === spec.raw_stream_sha256, "raw stitched stream changed");

const rawBytes = await fs.readFile(stitch.raw_output_path);
const raw = parsePcm16Wav(rawBytes);
const counts = [];
for (const segment of stitch.segments) counts.push(parsePcm16Wav(await fs.readFile(segment.prepared_audio_path)).samples);
const windows = unitWindows(counts, stitch.boundaries.map((row) => row.gap_sample_count));
need(windows.at(-1).offset + windows.at(-1).windowSamples === raw.samples, "stitch sample accounting does not match the raw stream");
const rawData = rawBytes.subarray(raw.dataOffset, raw.dataOffset + raw.dataBytes);

const indexById = new Map(stitch.segments.map((segment, index) => [segment.unit_id, index]));
need(Array.isArray(spec.units) && spec.units.length > 0 && new Set(spec.units.map((u) => u.unit_id)).size === spec.units.length, "spec needs unique units");
const placements = [];
const candidateReceipts = new Map();
for (const unit of spec.units) {
  const index = indexById.get(unit.unit_id);
  need(Number.isInteger(index), `unknown unit ${unit.unit_id}`);
  const segment = stitch.segments[index]; const window = windows[index];
  const prepared = await fs.readFile(segment.prepared_audio_path);
  need(sha(prepared) === segment.prepared_audio_sha256, `accepted unit audio changed: ${unit.unit_id}`);
  const preparedPcm = parsePcm16Wav(prepared);
  need(rawData.subarray(window.offset * 2, (window.offset + window.unitSamples) * 2)
    .equals(prepared.subarray(preparedPcm.dataOffset, preparedPcm.dataOffset + preparedPcm.dataBytes)), `raw stream does not hold ${unit.unit_id} at its offset`);
  if (!candidateReceipts.has(unit.candidate_receipt_path)) {
    need(await sha256File(unit.candidate_receipt_path) === unit.candidate_receipt_sha256, `candidate receipt changed: ${unit.unit_id}`);
    candidateReceipts.set(unit.candidate_receipt_path, JSON.parse(await fs.readFile(unit.candidate_receipt_path, "utf8")));
  }
  const listed = candidateReceipts.get(unit.candidate_receipt_path).units.find((row) => row.unit_id === unit.unit_id);
  need(listed?.wav_sha256 === unit.candidate_wav_sha256 && listed.spoken_text_sha256 === segment.spoken_text_sha256, `candidate receipt does not bind ${unit.unit_id}`);
  const candidate = await fs.readFile(unit.candidate_wav_path);
  need(sha(candidate) === unit.candidate_wav_sha256, `candidate audio changed: ${unit.unit_id}`);
  const candidatePcm = parsePcm16Wav(candidate);
  placements.push({ unit, window, pcm: candidate.subarray(candidatePcm.dataOffset, candidatePcm.dataOffset + candidatePcm.dataBytes) });
}

const patchId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const outDir = path.join(episodeDir, "assets", "audio", "narration_final_patch", patchId);
const receiptDir = path.join(episodeDir, "reports", "narration_final_patch", patchId);
await fs.mkdir(outDir, { recursive: true }); await fs.mkdir(receiptDir, { recursive: true });
const patchedRawPath = path.join(outDir, "narration-raw-patched.wav");
await fs.writeFile(patchedRawPath, Buffer.concat([rawBytes.subarray(0, raw.dataOffset), spliceRetakes(rawData, placements)]), { flag: "wx" });
const masterPath = path.join(outDir, "narration-mastered-patched.wav");
const mastering = await masterNarrationTwoPass({ inputPath: patchedRawPath, outputPath: masterPath, reportPath: path.join(outDir, "mastering_report.json") });
need(mastering.status === "passed", "two-pass mastering did not pass");
need(parsePcm16Wav(await fs.readFile(masterPath)).samples === raw.samples, "patched master duration changed");

const videoPath = path.join(path.dirname(renderReport.final_video_path), `${path.basename(renderReport.final_video_path, ".mp4")}-narration-patch-${patchId}.mp4`);
await execFile(renderReport.ffmpeg_bin ?? "ffmpeg", ["-v", "error", "-i", renderReport.final_video_path, "-i", masterPath,
  "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", videoPath], { maxBuffer: 1024 * 1024 * 32 });
const videoSha = await sha256File(videoPath);
const masterSha = await sha256File(masterPath);

const receipt = { schema: NARRATION_FINAL_PATCH_RECEIPT_SCHEMA, status: "passed", patch_id: patchId, episode_dir: episodeDir,
  spec_path: specPath, spec_sha256: specSha, reviewer: spec.reviewer, operator_quote: spec.operator_quote, note: spec.note,
  previous_render_report: { path: renderReportPath, sha256: spec.render_report_sha256 }, previous_final_video_sha256: spec.final_video_sha256,
  stitch_report_sha256: spec.stitch_report_sha256, raw_stream_sha256: spec.raw_stream_sha256,
  patched_raw: { path: patchedRawPath, sha256: await sha256File(patchedRawPath) }, patched_master: { path: masterPath, sha256: masterSha },
  mastering_report_path: path.join(outDir, "mastering_report.json"), final_video: { path: videoPath, sha256: videoSha },
  units: placements.map(({ unit, window, pcm }) => ({ unit_id: unit.unit_id, raw_offset_samples: window.offset, window_samples: window.windowSamples,
    previous_unit_samples: window.unitSamples, retake_samples: pcm.length / 2, remaining_pause_samples: window.windowSamples - pcm.length / 2,
    candidate_wav_sha256: unit.candidate_wav_sha256 })),
  timeline_preserved: true, video_stream_copied: true, provider_calls: 0, created_at: new Date().toISOString() };
const receiptPath = path.join(receiptDir, "receipt.json");
await fs.writeFile(receiptPath, json(receipt), { flag: "wx" });

const reportPath = path.join(episodeDir, `render_report_${status.identity.episode}-narration-patch-${patchId}.json`);
await fs.writeFile(reportPath, json({ ...renderReport, output_path: videoPath, output_hash: videoSha, final_video_path: videoPath, final_video_sha256: videoSha,
  audio_path: masterPath, render_audio_path: masterPath, final_mux_audio_path: masterPath, scoped_render_audio_source_path: masterPath,
  source_hashes: { ...renderReport.source_hashes, [masterPath]: masterSha, [receiptPath]: await sha256File(receiptPath), [specPath]: specSha },
  narration_final_patch: { receipt_path: receiptPath, receipt_sha256: await sha256File(receiptPath), patched_unit_count: placements.length },
  previous_render_report_path: renderReportPath, previous_render_report_sha256: spec.render_report_sha256, updated_at: new Date().toISOString() }), { flag: "wx" });
console.log(json({ status: "passed", patch_id: patchId, patched_unit_count: placements.length, final_video: videoPath, render_report: reportPath, receipt: receiptPath, provider_calls: 0 }));
