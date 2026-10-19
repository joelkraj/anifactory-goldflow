#!/usr/bin/env node
// Guarded narration retime. See docs/workflows/narration_final_patch.md.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256File } from "./lib/file-hash.mjs";
import { masterNarrationTwoPass } from "./lib/narration-mastering.mjs";
import { parsePcm16Wav, unitWindows } from "./lib/narration-final-patch.mjs";
import { NARRATION_RETIME_RECEIPT_SCHEMA, NARRATION_RETIME_SPEC_SCHEMA, buildRetimeMap, retimeTimeline, retimeWordTiming } from "./lib/narration-retime.mjs";
import { validatePanelTimeline } from "./lib/panel-layout-validation.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const need = (ok, message) => { if (!ok) throw new Error(`Narration retime: ${message}`); };
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
need(status.stage_ledger?.find((row) => row.stage === "premium_render")?.state === "passed", "admission requires a passed render");
need(status.identity?.render_profile === "panel_composition_v1", "panel composition render required");

const spec = JSON.parse(await fs.readFile(specPath, "utf8"));
const specSha = await sha256File(specPath);
need(spec.schema === NARRATION_RETIME_SPEC_SCHEMA && spec.status === "approved", "spec schema/status invalid");
for (const key of ["reviewer", "note", "operator_quote"]) need(String(spec[key] ?? "").trim().length >= 3, `spec ${key} required`);
const bind = spec.bindings ?? {};
for (const key of ["panel_plan", "word_timing", "audio_bed_report", "stitch_report"]) {
  need(bind[`${key}_path`] && await sha256File(bind[`${key}_path`]) === bind[`${key}_sha256`], `${key} changed since review`);
}
const plan = JSON.parse(await fs.readFile(bind.panel_plan_path, "utf8"));
need(plan.status === "passed" && plan.timeline?.sha256 === bind.timeline_sha256 && await sha256File(plan.timeline.path) === bind.timeline_sha256, "panel timeline changed since review");
const stitch = JSON.parse(await fs.readFile(bind.stitch_report_path, "utf8"));
const audioBed = JSON.parse(await fs.readFile(bind.audio_bed_report_path, "utf8"));
need(audioBed.final_audio_sha256 === stitch.final_wav_sha256 && audioBed.narration_only === true, "audio bed is not the narrator-only stitched master");
need(await sha256File(stitch.raw_output_path) === stitch.raw_output_sha256 && stitch.raw_output_sha256 === spec.raw_stream_sha256, "raw stitched stream changed");

const rawBytes = await fs.readFile(stitch.raw_output_path);
const raw = parsePcm16Wav(rawBytes);
const rawData = rawBytes.subarray(raw.dataOffset, raw.dataOffset + raw.dataBytes);
const oldUnits = [];
for (const segment of stitch.segments) oldUnits.push(parsePcm16Wav(await fs.readFile(segment.prepared_audio_path)).samples);
const gaps = stitch.boundaries.map((row) => row.gap_sample_count);
const windows = unitWindows(oldUnits, gaps);
need(windows.at(-1).offset + windows.at(-1).windowSamples === raw.samples, "stitch sample accounting does not match the raw stream");

const indexById = new Map(stitch.segments.map((segment, index) => [segment.unit_id, index]));
need(Array.isArray(spec.units) && spec.units.length > 0 && new Set(spec.units.map((u) => u.unit_id)).size === spec.units.length, "spec needs unique units");
const replacements = new Map(); const receipts = new Map();
for (const unit of spec.units) {
  const index = indexById.get(unit.unit_id);
  need(Number.isInteger(index), `unknown unit ${unit.unit_id}`);
  const segment = stitch.segments[index]; const window = windows[index];
  const prepared = await fs.readFile(segment.prepared_audio_path);
  need(sha(prepared) === segment.prepared_audio_sha256, `accepted unit audio changed: ${unit.unit_id}`);
  const preparedPcm = parsePcm16Wav(prepared);
  need(rawData.subarray(window.offset * 2, (window.offset + window.unitSamples) * 2)
    .equals(prepared.subarray(preparedPcm.dataOffset, preparedPcm.dataOffset + preparedPcm.dataBytes)), `raw stream does not hold ${unit.unit_id} at its offset`);
  if (!receipts.has(unit.candidate_receipt_path)) {
    need(await sha256File(unit.candidate_receipt_path) === unit.candidate_receipt_sha256, `candidate receipt changed: ${unit.unit_id}`);
    receipts.set(unit.candidate_receipt_path, JSON.parse(await fs.readFile(unit.candidate_receipt_path, "utf8")));
  }
  const listed = receipts.get(unit.candidate_receipt_path).units.find((row) => row.unit_id === unit.unit_id);
  need(listed?.wav_sha256 === unit.candidate_wav_sha256 && listed.spoken_text_sha256 === segment.spoken_text_sha256, `candidate receipt does not bind ${unit.unit_id}`);
  const candidate = await fs.readFile(unit.candidate_wav_path);
  need(sha(candidate) === unit.candidate_wav_sha256, `candidate audio changed: ${unit.unit_id}`);
  const pcm = parsePcm16Wav(candidate);
  replacements.set(index, candidate.subarray(pcm.dataOffset, pcm.dataOffset + pcm.dataBytes));
}

// Grown stream: each unit is its original bytes or the reviewed retake; every pause keeps its exact original bytes.
const parts = []; const newUnits = [];
windows.forEach((window) => {
  const unitPcm = replacements.get(window.index) ?? rawData.subarray(window.offset * 2, (window.offset + window.unitSamples) * 2);
  parts.push(unitPcm, rawData.subarray((window.offset + window.unitSamples) * 2, (window.offset + window.windowSamples) * 2));
  newUnits.push(unitPcm.length / 2);
});
const grownData = Buffer.concat(parts);
const header = Buffer.from(rawBytes.subarray(0, raw.dataOffset));
header.writeUInt32LE(raw.dataOffset - 8 + grownData.length, 4);
header.writeUInt32LE(grownData.length, raw.dataOffset - 4);
const map = buildRetimeMap(oldUnits, newUnits, gaps);
need(map.newTotal === grownData.length / 2, "retime map disagrees with the grown stream");

const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const outDir = path.join(episodeDir, "assets", "audio", "narration_retime", id);
const receiptDir = path.join(episodeDir, "reports", "narration_retime", id);
await fs.mkdir(outDir, { recursive: true }); await fs.mkdir(receiptDir, { recursive: true });
const rawPath = path.join(outDir, "narration-raw-retimed.wav");
await fs.writeFile(rawPath, Buffer.concat([header, grownData]), { flag: "wx" });
const masterPath = path.join(outDir, "narration-mastered-retimed.wav");
const masteringPath = path.join(outDir, "mastering_report.json");
const mastering = await masterNarrationTwoPass({ inputPath: rawPath, outputPath: masterPath, reportPath: masteringPath });
need(mastering.status === "passed", "two-pass mastering did not pass");
need(parsePcm16Wav(await fs.readFile(masterPath)).samples === map.newTotal, "master duration differs from the retime map");
const audio = { path: masterPath, sha256: await sha256File(masterPath) };

const timeline = retimeTimeline(JSON.parse(await fs.readFile(plan.timeline.path, "utf8")), map, audio);
validatePanelTimeline(timeline, "production_panel_composition");
const wordTiming = retimeWordTiming(JSON.parse(await fs.readFile(bind.word_timing_path, "utf8")), map, audio);
const timelinePath = path.join(outDir, "panel_timeline_retimed.json"); const wordTimingPath = path.join(outDir, "narration_word_timing_retimed.json");
await fs.writeFile(timelinePath, json(timeline), { flag: "wx" });
await fs.writeFile(wordTimingPath, json(wordTiming), { flag: "wx" });

const outputs = { raw: { path: rawPath, sha256: await sha256File(rawPath) }, master: audio,
  mastering_report: { path: masteringPath, sha256: await sha256File(masteringPath) },
  timeline: { path: timelinePath, sha256: await sha256File(timelinePath) }, word_timing: { path: wordTimingPath, sha256: await sha256File(wordTimingPath) } };
const receipt = { schema: NARRATION_RETIME_RECEIPT_SCHEMA, status: "passed", retime_id: id, episode_dir: episodeDir,
  spec_path: specPath, spec_sha256: specSha, reviewer: spec.reviewer, operator_quote: spec.operator_quote, note: spec.note,
  bindings: { ...bind }, raw_stream_sha256: spec.raw_stream_sha256, outputs,
  previous_duration_sec: Number((map.oldTotal / 24000).toFixed(6)), retimed_duration_sec: timeline.duration_sec,
  units: [...replacements.keys()].sort((a, b) => a - b).map((index) => ({ unit_id: stitch.segments[index].unit_id,
    previous_samples: oldUnits[index], retimed_samples: newUnits[index], delta_samples: newUnits[index] - oldUnits[index] })),
  pause_samples_preserved: true, provider_calls: 0, created_at: new Date().toISOString() };
const receiptPath = path.join(receiptDir, "receipt.json");
await fs.writeFile(receiptPath, json(receipt), { flag: "wx" });
console.log(json({ status: "passed", retime_id: id, units: receipt.units.length, previous_duration_sec: receipt.previous_duration_sec,
  retimed_duration_sec: receipt.retimed_duration_sec, receipt: receiptPath,
  next_render_flag: `--narration-retime-receipt ${receiptPath}` }));
