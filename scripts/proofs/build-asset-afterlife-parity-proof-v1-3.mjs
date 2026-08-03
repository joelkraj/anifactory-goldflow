#!/usr/bin/env node

import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "../..");
const flags = parseFlags(process.argv.slice(2));
const episodeDir = path.resolve(String(flags["episode-dir"] ?? process.env.ASSET_AFTERLIFE_EPISODE_DIR ?? ""));

if (!episodeDir) throw new Error("Pass --episode-dir <path>.");

const v1Dir = path.join(episodeDir, "review_samples/hybrid_documentary_parity_proof_v1");
const v12Dir = path.join(episodeDir, "review_samples/hybrid_documentary_parity_proof_v1_2");
const outputDir = path.join(episodeDir, "review_samples/hybrid_documentary_parity_proof_v1_3");
const inheritedSfxDir = path.join(v12Dir, "sfx_source_downloads");
const localSfxDir = path.join(outputDir, "sfx_source_downloads");
const workDir = path.join(outputDir, "work");
const ffmpegBin = process.env.FFMPEG_BIN ?? "ffmpeg";
const ffprobeBin = process.env.FFPROBE_BIN ?? "ffprobe";
const TARGET_DURATION = 106.24;

const EXPECTED = {
  v12Lock: "29ee358bd82d7161dd7f1bcebb272b06fe579f932ab1c23e3fd320c9560934e3",
  v12Content: "e4ff8e9c4bdb5a6e658c9c31f50910c000dac6c462c24dda0fe32390317eace1",
  v12Video: "22321545d09efecc671495cdb44f40d93077cec224f23e6a1c6f7206e5022a4d",
  narration: "ccb8d870598fdf96116e8534a4a7464a4e399968c564ea7cb1897c2b72f9533c",
  music: "a5be491b4788974c71cbec05403e39ffd94df1bbdedd26a94fbea547c58bf915",
  script: "d51ba4dc1dadbf865c5e6af7bfa804476e47ba4cb57e4f859f11024eeda6c65a",
};

const paths = {
  v12Lock: path.join(v12Dir, "BASELINE_LOCK.json"),
  v12Video: path.join(v12Dir, "lost_luggage_hybrid_parity_proof_v1_2.mp4"),
  narration: path.join(v1Dir, "narration_elevenlabs_adam.wav"),
  music: path.join(v1Dir, "documentary_underscore.provider-audio"),
  script: path.join(v1Dir, "proof_script.md"),
};

function source(id, title, channel, wavSha256, infoSha256, sourceDir) {
  return {
    id,
    title,
    channel,
    url: `https://www.youtube.com/watch?v=${id}`,
    path: path.join(sourceDir, `${id}.wav`),
    info_path: path.join(sourceDir, `${id}.info.json`),
    wav_sha256: wavSha256,
    info_sha256: infoSha256,
  };
}

const sfxSources = {
  baggageMotor: source("JhDvWsWZPvk", "AIRPORT SOUNDS EFFECTS - Airport, Baggage Claim, Motor Of Luggage Conveyor Belt", "Reality Sound", "637e6927d6d586db280de7356b9be5364ba9f4aae4b4a9fe50028c65963e4b41", "3676c762f35dda9376bc5dc1dfd2dd3efa0a89dd3022f686645b32406b1722ce", inheritedSfxDir),
  conveyorStart: source("biMXVPqOkPw", "Conveyor belt starting", "Sound Effects - Topic", "68379376086f7048785748b00ec64b521ad57796754b9f24d6cd25fa53520854", "4f096711863e383f4684d199e5c159a8e48786e7efe12970bc86cf4ed10760a6", inheritedSfxDir),
  suitcaseImpact: source("kfNLjFRVmbo", "Suitcase 1 SOUND Effect", "SOUND Effects Public Domain (No Copyrights)", "434e565e765f533fe7d663d3e1092ccd047cfc3cb710a3d935acfda87bb42c2b", "1a80becefa21bcd996ed0c4241659583a2135e6c139995723882ac1b235c6765", inheritedSfxDir),
  rubberStamp: source("6QcNHrhFEBg", "Stamp SOUND EFFECT - Rubber Approved Impact Stamping Stempel SOUND", "BerlinAtmospheres", "6329cea0b5123b3b5e9731c2149d2eface4b2d9e0d49302dc3bd5e81ae435101", "ca83dd2fd33fd4ef3d85f1b020ad5a01b390c2db26500a9d6e7aec0289248302", inheritedSfxDir),
  suitcaseWheels: source("JFcFAX-F2M4", "Rolling Suitcase Sound Effect", "Free Sound Stock", "de47dc0bd49a4716716092cb594ab37bd19ae6154fd7e32081521b9639a4c570", "c499bdc2f2179aadc70f64f94331596898e6130d6d181fcaec53669e960c11fc", inheritedSfxDir),
  suitcaseZipper: source("eH8TB5v8-9A", "Zipper of Suitcase or Briefcase", "Dr. Sound FX - Topic", "6bbfb1e74b11acabd32c13bafcf55a4402949ec4e77a866c2d51572c6e2c5d05", "576748e6dcb462bc30d1dc26ac6fbb6cff7de7b912198fc810bb630840a439c5", inheritedSfxDir),
  splitFlap: source("cj32w5z81Ak", "The wonderful split-flap Departure Board at Frankfurt Airport", "Aileron Aviation Films", "77cec3bedde757e7f3367239ae5aeb46e12a6a356b4b77652e5fd925e6f7046e", "8602014f0fc194341a27efe8fe8952840e0e2a54c95efb68640734ac1327af26", inheritedSfxDir),
  boardingScanner: source("rTArKNCd5Fc", "Scan Boarding Pass - Sound Effect (HD)", "Sound Library", "4437d87a9f860ba73f9dd018603e01d44fa63e4d773c95ac1385ffd3f50779a1", "973dabd3d7fb601da64c33adbd8a109709ab212a4b063a2736c85e6cb8094f67", localSfxDir),
};

const cues = [
  cue("opening_baggage_motor", sfxSources.baggageMotor, 0.00, 0.25, 9.55, 0.060, -11.0, { fade_in: 0.12, fade_out: 0.55 }),
  cue("opening_conveyor_start", sfxSources.conveyorStart, 0.00, 0.00, 2.48, 0.200, 0.0, { fade_out: 0.28 }),
  cue("opening_suitcase_settle", sfxSources.suitcaseImpact, 0.08, 0.00, 1.25, 0.160, -1.9, { fade_out: 0.18 }),
  cue("opening_status_flaps", sfxSources.splitFlap, 1.72, 0.49, 1.25, 0.300, -9.6, { fade_out: 0.18 }),
  cue("tracking_scan_confirm", sfxSources.boardingScanner, 18.36, 3.78, 0.42, 0.350, -6.2),
  cue("checkpoint_handoff", sfxSources.boardingScanner, 22.42, 0.226, 0.20, 1.400, -18.7),
  cue("checkpoint_loading", sfxSources.boardingScanner, 23.40, 0.226, 0.20, 1.400, -18.7),
  cue("checkpoint_transfer", sfxSources.boardingScanner, 24.06, 0.226, 0.20, 1.400, -18.7),
  cue("checkpoint_return", sfxSources.boardingScanner, 24.94, 0.226, 0.20, 1.400, -18.7),
  cue("claim_stamp", sfxSources.rubberStamp, 43.84, 7.66, 0.34, 0.200, -3.4),
  cue("route_wheels", sfxSources.suitcaseWheels, 59.88, 2.50, 1.70, 2.500, -25.6, { fade_out: 0.22 }),
  cue("sorting_zipper", sfxSources.suitcaseZipper, 74.72, 0.10, 1.58, 0.180, -3.5, { fade_out: 0.20 }),
  cue("electronics_test_confirm", sfxSources.boardingScanner, 80.22, 1.27, 0.13, 1.000, -14.4),
];

function cue(id, sourceRecord, start, sourceStart, duration, volume, rawPeakDbfs, extra = {}) {
  return {
    id,
    source: sourceRecord,
    start,
    source_start: sourceStart,
    duration,
    volume,
    raw_peak_dbfs: rawPeakDbfs,
    expected_mixed_peak_dbfs: round(rawPeakDbfs + (20 * Math.log10(volume)), 2),
    ...extra,
  };
}

function parseFlags(parts) {
  const parsed = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const next = parts[index + 1];
    parsed[key] = next && !next.startsWith("--") ? next : "true";
    if (parsed[key] !== "true") index += 1;
  }
  return parsed;
}

function round(value, digits = 3) {
  const multiplier = 10 ** digits;
  return Math.round(Number(value) * multiplier) / multiplier;
}

async function sha256File(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function ensureFile(filePath, expectedHash = null) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size < 1) throw new Error(`Missing input file: ${filePath}`);
  const actualHash = await sha256File(filePath);
  if (expectedHash && actualHash !== expectedHash) throw new Error(`Hash mismatch for ${filePath}`);
  return { path: filePath, size_bytes: stat.size, sha256: actualHash };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function run(command, args, options = {}) {
  const { stdout = "", stderr = "" } = await execFile(command, args, { maxBuffer: 64 * 1024 * 1024, ...options });
  if (stderr && flags.verbose === "true") process.stderr.write(stderr);
  return stdout;
}

async function probe(filePath) {
  return JSON.parse(await run(ffprobeBin, [
    "-v", "error",
    "-show_entries", "format=duration,size,bit_rate:stream=codec_name,codec_type,width,height,r_frame_rate,sample_rate,channels",
    "-of", "json",
    filePath,
  ]));
}

async function verifyInputs() {
  await ensureFile(paths.v12Lock, EXPECTED.v12Lock);
  const lock = await readJson(paths.v12Lock);
  if (lock.status !== "locked" || lock.content_sha256 !== EXPECTED.v12Content) throw new Error("V1.2 lock changed.");
  const mismatches = [];
  for (const record of lock.artifacts ?? []) {
    try {
      const actual = await ensureFile(path.join(v12Dir, record.path));
      if (actual.sha256 !== record.sha256 || actual.size_bytes !== record.size_bytes) mismatches.push(record.path);
    } catch {
      mismatches.push(record.path);
    }
  }
  if (mismatches.length) throw new Error(`V1.2 lock mismatch: ${mismatches.join(", ")}`);
  await Promise.all([
    ensureFile(paths.v12Video, EXPECTED.v12Video),
    ensureFile(paths.narration, EXPECTED.narration),
    ensureFile(paths.music, EXPECTED.music),
    ensureFile(paths.script, EXPECTED.script),
  ]);
  const sourceRecords = [];
  for (const record of Object.values(sfxSources)) {
    const [wav, info] = await Promise.all([
      ensureFile(record.path, record.wav_sha256),
      ensureFile(record.info_path, record.info_sha256),
    ]);
    const metadata = await readJson(record.info_path);
    if (metadata.id !== record.id || metadata.webpage_url !== record.url) throw new Error(`SFX metadata mismatch: ${record.id}`);
    sourceRecords.push({
      ...record,
      wav_size_bytes: wav.size_bytes,
      info_size_bytes: info.size_bytes,
      downloaded_title: metadata.title,
      downloaded_channel: metadata.channel,
      duration_sec: metadata.duration,
    });
  }
  return {
    v12_lock_path: paths.v12Lock,
    v12_lock_sha256: EXPECTED.v12Lock,
    v12_content_sha256: EXPECTED.v12Content,
    v12_artifact_count: lock.artifact_count,
    sourceRecords,
  };
}

function cueFilter(item, inputIndex, label) {
  const operations = [
    `atrim=start=${item.source_start}:duration=${item.duration}`,
    "asetpts=N/SR/TB",
    "aresample=48000",
    "highpass=f=42",
    "lowpass=f=15000",
    `volume=${item.volume}`,
  ];
  if (item.fade_in) operations.push(`afade=t=in:st=0:d=${item.fade_in}`);
  if (item.fade_out) operations.push(`afade=t=out:st=${Math.max(0, item.duration - item.fade_out)}:d=${item.fade_out}`);
  operations.push(`adelay=${Math.round(item.start * 1000)}:all=1`);
  return `[${inputIndex}:a]${operations.join(",")}[${label}]`;
}

async function mixFinal(outputPath) {
  const inputs = ["-i", paths.v12Video, "-i", paths.narration, "-stream_loop", "-1", "-i", paths.music];
  for (const item of cues) inputs.push("-i", item.source.path);
  const fadeOutStart = TARGET_DURATION - 2.4;
  const filters = [
    `[1:a]highpass=f=58,apad=pad_dur=1.2,atrim=0:${TARGET_DURATION},asetpts=N/SR/TB,asplit=2[voice][voicekey]`,
    `[2:a]atrim=0:${TARGET_DURATION},asetpts=N/SR/TB,highpass=f=35,lowpass=f=12500,volume=0.12,afade=t=in:st=0:d=1.2,afade=t=out:st=${fadeOutStart}:d=2.2[bed]`,
    "[bed][voicekey]sidechaincompress=threshold=0.025:ratio=7:attack=15:release=420[ducked]",
  ];
  const labels = ["[voice]", "[ducked]"];
  cues.forEach((item, index) => {
    const label = `fx${index}`;
    filters.push(cueFilter(item, index + 3, label));
    labels.push(`[${label}]`);
  });
  filters.push(`${labels.join("")}amix=inputs=${labels.length}:duration=longest:normalize=0,alimiter=limit=0.95[mix]`);
  await run(ffmpegBin, [
    "-y", "-v", "error", ...inputs, "-filter_complex", filters.join(";"),
    "-map", "0:v:0", "-map", "[mix]", "-t", String(TARGET_DURATION),
    "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-movflags", "+faststart", outputPath,
  ]);
}

async function buildOpeningStem(outputPath) {
  const openingCues = cues.filter((item) => item.id.startsWith("opening_"));
  const inputs = [];
  const filters = [];
  const labels = [];
  openingCues.forEach((item, index) => {
    inputs.push("-i", item.source.path);
    const label = `stem${index}`;
    filters.push(cueFilter(item, index, label));
    labels.push(`[${label}]`);
  });
  filters.push(`${labels.join("")}amix=inputs=${labels.length}:duration=longest:normalize=0,apad=pad_dur=2.5,atrim=0:12,alimiter=limit=0.95[stem]`);
  await run(ffmpegBin, [
    "-y", "-v", "error", ...inputs, "-filter_complex", filters.join(";"),
    "-map", "[stem]", "-c:a", "pcm_s24le", "-ar", "48000", outputPath,
  ]);
}

async function main() {
  const finalPath = path.join(outputDir, "lost_luggage_hybrid_parity_proof_v1_3.mp4");
  try {
    await fs.access(finalPath);
    throw new Error(`Append-only proof already exists: ${finalPath}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const inputs = await verifyInputs();
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.mkdir(workDir, { recursive: true });
  await mixFinal(finalPath);
  const openingStemPath = path.join(outputDir, "v1_3_opening_sourced_sfx_stem.wav");
  await buildOpeningStem(openingStemPath);
  const openingPreviewPath = path.join(outputDir, "v1_3_opening_preview.mp4");
  await run(ffmpegBin, ["-y", "-v", "error", "-i", finalPath, "-t", "12", "-c", "copy", "-movflags", "+faststart", openingPreviewPath]);

  const [finalProbe, previewProbe, sourceRows] = await Promise.all([
    probe(finalPath),
    probe(openingPreviewPath),
    Promise.all(cues.map(async (item) => ({
      id: item.id,
      timeline_start_sec: item.start,
      source_start_sec: item.source_start,
      source_end_sec: round(item.source_start + item.duration, 3),
      duration_sec: item.duration,
      gain_scalar: item.volume,
      raw_peak_dbfs: item.raw_peak_dbfs,
      expected_mixed_peak_dbfs: item.expected_mixed_peak_dbfs,
      youtube_id: item.source.id,
      youtube_url: item.source.url,
      source_title: item.source.title,
      source_channel: item.source.channel,
      source_audio_path: item.source.path,
      source_audio_sha256: await sha256File(item.source.path),
      source_metadata_path: item.source.info_path,
      source_metadata_sha256: await sha256File(item.source.info_path),
    }))),
  ]);
  const ledgerPath = path.join(outputDir, "sourced_sfx_ledger_v1_3.json");
  await fs.writeFile(ledgerPath, `${JSON.stringify({
    schema: "goldflow_sourced_sfx_ledger_v1",
    status: "passed",
    created_at: new Date().toISOString(),
    acquisition_tool: "yt-dlp",
    acquisition_tool_version: "2026.07.04",
    generated_sfx_used: false,
    gain_policy: "Each real source slice is audited independently and gain-staged toward an editorial peak; raw YouTube mastering is never treated as a mix level.",
    inherited_sources_are_bound_to_v1_2_lock: true,
    sources: inputs.sourceRecords,
    cues: sourceRows,
  }, null, 2)}\n`);

  const report = {
    schema: "goldflow_asset_afterlife_parity_proof_v1_3",
    status: "rendered_pending_operator_review",
    proof_intent: "append_only_source_aware_sfx_gain_refinement",
    official_pipeline_artifacts_modified: false,
    created_at: new Date().toISOString(),
    output_dir: outputDir,
    lineage: {
      canonical_baseline: "hybrid_documentary_parity_proof_v1",
      visual_baseline: "hybrid_documentary_parity_proof_v1_2",
      v1_2_lock_path: inputs.v12_lock_path,
      v1_2_lock_sha256: inputs.v12_lock_sha256,
      v1_2_content_sha256: inputs.v12_content_sha256,
      v1_2_video_sha256: EXPECTED.v12Video,
      visual_stream_reencoded: false,
      prior_proofs_modified: false,
    },
    preservation_contract: {
      exact_script_sha256: EXPECTED.script,
      exact_narration_sha256: EXPECTED.narration,
      exact_music_sha256: EXPECTED.music,
      narration_tempo_processing: false,
      v1_2_visual_stream_preserved: true,
    },
    sound_design: {
      generated_sfx_used: false,
      sourced_sfx_cue_count: sourceRows.length,
      gain_policy: "source-aware audited gain",
      source_ledger_path: ledgerPath,
      opening_sfx_stem_path: openingStemPath,
      opening_sfx_stem_sha256: await sha256File(openingStemPath),
      cues: sourceRows,
    },
    output: {
      video_path: finalPath,
      video_sha256: await sha256File(finalPath),
      duration_sec: round(Number(finalProbe?.format?.duration ?? 0), 3),
      size_bytes: Number(finalProbe?.format?.size ?? 0),
      probe: finalProbe,
      opening_preview_path: openingPreviewPath,
      opening_preview_sha256: await sha256File(openingPreviewPath),
      opening_preview_probe: previewProbe,
    },
  };
  const reportPath = path.join(outputDir, "hybrid_parity_proof_v1_3_report.json");
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const recipeDir = path.join(outputDir, "recipe_snapshot");
  await fs.mkdir(recipeDir, { recursive: true });
  await fs.copyFile(currentFile, path.join(recipeDir, path.basename(currentFile)));
  await fs.copyFile(path.join(repoRoot, "scripts/proofs/lock-proof-baseline.mjs"), path.join(recipeDir, "lock-proof-baseline.mjs"));

  process.stdout.write(`${JSON.stringify({
    status: report.status,
    video_path: finalPath,
    video_sha256: report.output.video_sha256,
    opening_preview_path: openingPreviewPath,
    opening_sfx_stem_path: openingStemPath,
    sourced_sfx_cue_count: sourceRows.length,
    generated_sfx_used: false,
    report_path: reportPath,
  }, null, 2)}\n`);
}

await main();
