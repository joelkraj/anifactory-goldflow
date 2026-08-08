#!/usr/bin/env node

import { execFile as execFileCb, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "../..");
const flags = parseFlags(process.argv.slice(2));
const episodeDir = path.resolve(String(flags["episode-dir"] ?? process.env.ASSET_AFTERLIFE_EPISODE_DIR ?? ""));

if (!episodeDir) {
  throw new Error("Pass --episode-dir <path>.");
}

const baselineDir = path.join(episodeDir, "review_samples/hybrid_documentary_parity_proof_v1");
const rejectedV2Dir = path.join(episodeDir, "review_samples/hybrid_documentary_cold_open_v2");
const outputDir = path.join(episodeDir, "review_samples/hybrid_documentary_parity_proof_v1_1");
const workDir = path.join(outputDir, "work");
const clipDir = path.join(workDir, "clips");
const sourceDir = path.join(baselineDir, "source_media");
const ffmpegBin = process.env.FFMPEG_BIN ?? "ffmpeg";
const ffprobeBin = process.env.FFPROBE_BIN ?? "ffprobe";
const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;

const BASELINE = {
  lock: "d9528f61a5b4afca599c23e1c2da28c98d550ed3270fe81ccef959e1ed5ecbdf",
  content: "f8bd65ae173ba4cc205bfd6eb1e571ae725ca34d14560e478c4ed0769ed1720b",
  video: "8675993522ecdfbdd2b14425f7c733a0609d12a7b811981ae6325f26ca89dd9c",
  narration: "ccb8d870598fdf96116e8534a4a7464a4e399968c564ea7cb1897c2b72f9533c",
  music: "a5be491b4788974c71cbec05403e39ffd94df1bbdedd26a94fbea547c58bf915",
  scriptContent: "0a7f5c1b70a364829284d2a56c99b00af0bba2f65a288439731832a1ed3c810c",
  scriptFile: "d51ba4dc1dadbf865c5e6af7bfa804476e47ba4cb57e4f859f11024eeda6c65a",
};

const baselinePaths = {
  lock: path.join(baselineDir, "BASELINE_LOCK.json"),
  video: path.join(baselineDir, "lost_luggage_hybrid_parity_proof.mp4"),
  narration: path.join(baselineDir, "narration_elevenlabs_adam.wav"),
  music: path.join(baselineDir, "documentary_underscore.provider-audio"),
  script: path.join(baselineDir, "proof_script.md"),
  openingStill: path.join(episodeDir, "assets/images/ep_01-w000000-w000008-modelslab-image.png"),
};

const graphicPaths = {
  question: path.join(baselineDir, "work/clips/04-question.mp4"),
  checkpoints: path.join(baselineDir, "work/clips/07-checkpoints.mp4"),
  status: path.join(baselineDir, "work/clips/11-status.mp4"),
  claimValue: path.join(baselineDir, "work/clips/14-claim_value.mp4"),
  route: path.join(baselineDir, "work/clips/17-route.mp4"),
  outcomes: path.join(baselineDir, "work/clips/24-outcomes.mp4"),
  finalVerdict: path.join(baselineDir, "work/clips/27-final_verdict.mp4"),
};

const sfxSources = {
  carousel: {
    path: path.join(rejectedV2Dir, "sfx_carousel_room.provider-audio"),
    sha256: "431fd0e7d95810f4f80788754553c60353b65e06aa12578d2bd43f2492e63871",
  },
  scanner: {
    path: path.join(rejectedV2Dir, "sfx_scanner_beep.provider-audio"),
    sha256: "5b188948e603531b4fca1593ac92b5dadc9f35f08774edb830df4ebf19bc7334",
  },
  thump: {
    path: path.join(rejectedV2Dir, "sfx_bag_thump.provider-audio"),
    sha256: "ca98b17bb6fbf008ff448a7269eaea85c9e1be6f2bbe0b07d5fee8de040009fe",
  },
  zipper: {
    path: path.join(rejectedV2Dir, "sfx_zipper_sort.provider-audio"),
    sha256: "e9a3f0afd698baeb18276b8b6a56d3621657cbdbc97062e79d0d44befa252f71",
  },
  claimStamp: {
    path: path.join(outputDir, "input_sfx/audio_1785687347018.mp3"),
    sha256: "ac905f2e8101be5b0717bb824fb6e6f311b22fbd9fbb57e534d907c865abf04a",
    model_id: "eleven_sound_effect",
    request_id: 4410330,
    prompt: "Close-miked airline baggage claim document placed on a desk followed by one firm rubber approval stamp, short natural paper movement, realistic office foley, isolated, no voice, no music, no cinematic boom",
  },
  routeTransition: {
    path: path.join(outputDir, "input_sfx/audio_1785687357067.mp3"),
    sha256: "9d7619c55b6d08deec088a03969a863dcf6e94d39194037a25973dacfd6fb9ff",
    model_id: "eleven_sound_effect",
    request_id: 4410331,
    prompt: "Restrained documentary logistics transition: suitcase wheels roll across a warehouse floor, a baggage cart passes, then a soft airy travel whoosh, realistic and understated, isolated, no voice, no music, no cinematic impact",
  },
  deviceCheck: {
    path: path.join(outputDir, "input_sfx/audio_1785687368966.mp3"),
    sha256: "ccbcc2fbf46702348a0dabfd4fbe4a7a5109ebab956ed7a84bcdecf0943214af",
    model_id: "eleven_sound_effect",
    request_id: 4410332,
    prompt: "Close-up electronics inspection foley: smartphone placed gently on a padded workbench, two light technician taps, then one quiet clean data-wipe confirmation tone, realistic, isolated, no voice, no music",
  },
};

// These boundaries come from local faster-whisper on the exact locked V1 narration.
const timeline = [
  cut("opening_red_suitcase", 0.00, 3.32, "still", baselinePaths.openingStill, { motion: "push_in" }),
  cut("empty_carousel", 3.32, 5.80, "source", "wXZ17FOhY5M.mp4", { sourceStart: 1.0 }),
  cut("traveler_with_bag", 5.80, 9.80, "source", "_4w9jFDV3Do.mp4", { sourceStart: 100.0 }),
  cut("not_officially_lost", 9.80, 12.40, "source", "r2DUoXRlwOk.mp4", { sourceStart: 2.4 }),
  cut("question_not_yet", 12.40, 14.46, "reuse", graphicPaths.question),
  cut("tracking_scan", 14.46, 18.82, "source", "WkN7eRmv7E8.mp4", { sourceStart: 111.0 }),
  cut("checked_bag_handoff", 18.82, 21.80, "source", "4NuTfvLPTas.mp4", { sourceStart: 0.0 }),
  cut("four_checkpoints", 21.80, 25.36, "reuse", graphicPaths.checkpoints),
  cut("missed_scan_belt", 25.36, 29.26, "source", "_4w9jFDV3Do.mp4", { sourceStart: 205.0 }),
  cut("network_belts", 29.26, 33.10, "source", "wL0wkmah60k.mp4", { sourceStart: 25.0 }),
  cut("bags_make_it_home", 33.10, 35.86, "source", "wXZ17FOhY5M.mp4", { sourceStart: 5.0 }),
  cut("search_fails_status", 35.86, 40.64, "reuse", graphicPaths.status),
  cut("search_becomes_claim", 40.64, 44.20, "source", "r2DUoXRlwOk.mp4", { sourceStart: 22.0 }),
  cut("claim_value", 44.20, 51.08, "reuse", graphicPaths.claimValue),
  cut("claim_closes", 51.08, 56.42, "source", "dDfGMQ_iffA.mp4", { sourceStart: 7.0 }),
  cut("physical_bag_keeps_moving", 56.42, 59.90, "source", "_4w9jFDV3Do.mp4", { sourceStart: 227.0 }),
  cut("three_to_four_month_route", 59.90, 64.42, "reuse", graphicPaths.route),
  cut("orphaned_property_arrives", 64.42, 67.28, "source", "YiwZ3kbtHj4.mp4", { sourceStart: 4.5 }),
  cut("alabama_storefront", 67.28, 70.12, "source", "YiwZ3kbtHj4.mp4", { sourceStart: 7.5 }),
  cut("baggage_becomes_inventory", 70.12, 73.62, "source", "YiwZ3kbtHj4.mp4", { sourceStart: 94.0 }),
  cut("workers_open_and_sort", 73.62, 77.90, "source", "YiwZ3kbtHj4.mp4", { sourceStart: 18.0 }),
  cut("clothes_cleaned", 77.90, 79.54, "source", "YiwZ3kbtHj4.mp4", { sourceStart: 154.0 }),
  cut("electronics_tested", 79.54, 81.78, "source", "WkN7eRmv7E8.mp4", { sourceStart: 50.0 }),
  cut("jewelry_appraised", 81.78, 83.56, "source", "YiwZ3kbtHj4.mp4", { sourceStart: 216.0 }),
  cut("luxury_authenticated", 83.56, 85.52, "source", "YiwZ3kbtHj4.mp4", { sourceStart: 85.0 }),
  cut("store_transition", 85.52, 86.32, "source", "YiwZ3kbtHj4.mp4", { sourceStart: 184.0 }),
  cut("three_outcomes", 86.32, 91.28, "reuse", graphicPaths.outcomes),
  cut("final_question", 91.28, 93.44, "reuse", graphicPaths.question),
  cut("back_to_owner", 93.44, 95.74, "source", "wXZ17FOhY5M.mp4", { sourceStart: 9.0 }),
  cut("hidden_second_economy", 95.74, 100.38, "source", "YiwZ3kbtHj4.mp4", { sourceStart: 184.0 }),
  cut("one_bag_many_objects", 100.38, 103.52, "source", "YiwZ3kbtHj4.mp4", { sourceStart: 231.5 }),
  cut("new_journey", 103.52, 106.24, "reuse", graphicPaths.finalVerdict),
];

const sfxCues = [
  { id: "carousel_room", source: sfxSources.carousel, start: 0.00, duration: 9.80, volume: 0.065, loop: true },
  { id: "carousel_bag_thump", source: sfxSources.thump, start: 3.38, duration: 1.20, volume: 0.105 },
  { id: "scan_confirm", source: sfxSources.scanner, start: 18.36, duration: 0.75, volume: 0.16 },
  { id: "checkpoint_handoff", source: sfxSources.scanner, start: 22.42, duration: 0.55, volume: 0.065 },
  { id: "checkpoint_loading", source: sfxSources.scanner, start: 23.40, duration: 0.55, volume: 0.065 },
  { id: "checkpoint_transfer", source: sfxSources.scanner, start: 24.06, duration: 0.55, volume: 0.065 },
  { id: "checkpoint_return", source: sfxSources.scanner, start: 24.94, duration: 0.55, volume: 0.065 },
  // The generated stamp's primary transient is 0.38 seconds into the file.
  { id: "claim_stamp", source: sfxSources.claimStamp, start: 43.46, duration: 3.40, volume: 0.075 },
  { id: "route_transition", source: sfxSources.routeTransition, start: 59.88, duration: 1.00, volume: 0.09 },
  { id: "sorting_open", source: sfxSources.zipper, start: 74.72, duration: 3.10, volume: 0.10 },
  // The device placement transient is 0.54 seconds in, aligned to "Electronics."
  { id: "device_inspection", source: sfxSources.deviceCheck, start: 79.68, duration: 2.10, volume: 0.18 },
];

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

function cut(id, startSec, endSec, kind, source, extra = {}) {
  return {
    id,
    start_sec: startSec,
    end_sec: endSec,
    duration_sec: round(endSec - startSec, 4),
    kind,
    source,
    ...extra,
  };
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
  if (expectedHash && actualHash !== expectedHash) {
    throw new Error(`Hash mismatch for ${filePath}: expected ${expectedHash}, got ${actualHash}`);
  }
  return { path: filePath, size_bytes: stat.size, sha256: actualHash };
}

async function run(command, args, options = {}) {
  const { stdout = "", stderr = "" } = await execFile(command, args, {
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
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

function durationFromProbe(value) {
  return Number(value?.format?.duration ?? 0);
}

function validateTimeline() {
  let cursor = 0;
  for (const item of timeline) {
    if (Math.abs(item.start_sec - cursor) > 0.001) {
      throw new Error(`Timeline gap or overlap before ${item.id}: ${cursor} -> ${item.start_sec}`);
    }
    if (!(item.duration_sec > 0)) throw new Error(`Invalid duration for ${item.id}`);
    cursor = item.end_sec;
  }
  return round(cursor, 4);
}

async function verifyBaseline() {
  const lockInput = await ensureFile(baselinePaths.lock, BASELINE.lock);
  const lock = JSON.parse(await fs.readFile(baselinePaths.lock, "utf8"));
  if (lock.status !== "locked" || lock.content_sha256 !== BASELINE.content) {
    throw new Error("V1 baseline lock status or content hash changed.");
  }
  const mismatches = [];
  for (const artifact of lock.artifacts ?? []) {
    const artifactPath = path.join(baselineDir, artifact.path);
    try {
      const actual = await ensureFile(artifactPath);
      if (actual.sha256 !== artifact.sha256 || actual.size_bytes !== artifact.size_bytes) {
        mismatches.push(artifact.path);
      }
    } catch {
      mismatches.push(artifact.path);
    }
  }
  if (mismatches.length) throw new Error(`V1 baseline lock mismatch: ${mismatches.join(", ")}`);
  const [video, narration, music, script] = await Promise.all([
    ensureFile(baselinePaths.video, BASELINE.video),
    ensureFile(baselinePaths.narration, BASELINE.narration),
    ensureFile(baselinePaths.music, BASELINE.music),
    ensureFile(baselinePaths.script, BASELINE.scriptFile),
  ]);
  return { lock: lockInput, video, narration, music, script, artifact_count: lock.artifact_count };
}

async function buildWordTiming() {
  const outputPath = path.join(outputDir, "v1_narration_word_timing.json");
  const tmpPath = path.join(os.tmpdir(), `asset-afterlife-v1-timing-${process.pid}.json`);
  const py = String.raw`
import json, os, sys
os.environ["OMP_NUM_THREADS"] = "12"
from faster_whisper import WhisperModel

model = WhisperModel("small.en", device="cpu", compute_type="int8_float32", cpu_threads=0)
segments, info = model.transcribe(
    sys.argv[1], language="en", word_timestamps=True, vad_filter=False, beam_size=5
)
words = []
for segment in segments:
    for word in (segment.words or []):
        words.append({
            "word": word.word.strip(),
            "start_sec": round(float(word.start), 3),
            "end_sec": round(float(word.end), 3),
            "probability": round(float(getattr(word, "probability", 0.0) or 0.0), 4),
        })
with open(sys.argv[2], "w", encoding="utf-8") as handle:
    json.dump({
        "schema": "goldflow_private_proof_word_timing_v1",
        "status": "passed",
        "engine": "faster_whisper",
        "model": "small.en",
        "device": "cpu",
        "compute_type": "int8_float32",
        "omp_num_threads": 12,
        "cpu_threads": 0,
        "beam_size": 5,
        "word_timestamps": True,
        "vad_filter": False,
        "language": info.language,
        "duration_sec": info.duration,
        "narration_audio_sha256": sys.argv[3],
        "words": words,
    }, handle, ensure_ascii=False, indent=2)
`;
  await new Promise((resolve, reject) => {
    const child = spawn("python3", ["-c", py, baselinePaths.narration, tmpPath, BASELINE.narration], {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, OMP_NUM_THREADS: "12" },
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Whisper exited ${code}`)));
  });
  await fs.rename(tmpPath, outputPath);
  return { path: outputPath, sha256: await sha256File(outputPath), report: JSON.parse(await fs.readFile(outputPath, "utf8")) };
}

async function encodeSource(item, outputPath) {
  const inputPath = path.join(sourceDir, item.source);
  await ensureFile(inputPath);
  await run(ffmpegBin, [
    "-y", "-v", "error",
    "-i", inputPath,
    "-ss", String(item.sourceStart ?? 0),
    "-t", String(item.duration_sec),
    "-an",
    "-vf", `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},setsar=1,fps=${FPS},eq=contrast=1.035:saturation=0.96:gamma=0.99`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "17",
    "-pix_fmt", "yuv420p", "-r", String(FPS), "-movflags", "+faststart",
    outputPath,
  ]);
}

async function encodeStill(item, outputPath) {
  await ensureFile(item.source);
  const frames = Math.ceil(item.duration_sec * FPS);
  await run(ffmpegBin, [
    "-y", "-v", "error", "-loop", "1", "-i", item.source,
    "-vf", `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},zoompan=z='min(zoom+0.00125,1.09)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${WIDTH}x${HEIGHT}:fps=${FPS},trim=duration=${item.duration_sec},setsar=1`,
    "-frames:v", String(frames), "-an",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "17",
    "-pix_fmt", "yuv420p", "-r", String(FPS), "-movflags", "+faststart",
    outputPath,
  ]);
}

async function encodeReuse(item, outputPath) {
  await ensureFile(item.source);
  await run(ffmpegBin, [
    "-y", "-v", "error", "-i", item.source,
    "-an",
    "-vf", `setpts=PTS-STARTPTS,scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},fps=${FPS},tpad=stop_mode=clone:stop_duration=12,trim=duration=${item.duration_sec},setsar=1`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "17",
    "-pix_fmt", "yuv420p", "-r", String(FPS), "-movflags", "+faststart",
    outputPath,
  ]);
}

async function buildVisualTimeline() {
  await fs.mkdir(clipDir, { recursive: true });
  const encoded = [];
  for (let index = 0; index < timeline.length; index += 1) {
    const item = timeline[index];
    const outputPath = path.join(clipDir, `${String(index + 1).padStart(2, "0")}-${item.id}.mp4`);
    process.stderr.write(`[visual ${index + 1}/${timeline.length}] ${item.id}\n`);
    if (item.kind === "source") await encodeSource(item, outputPath);
    else if (item.kind === "still") await encodeStill(item, outputPath);
    else if (item.kind === "reuse") await encodeReuse(item, outputPath);
    else throw new Error(`Unsupported visual kind: ${item.kind}`);
    const itemProbe = await probe(outputPath);
    encoded.push({ ...item, output_path: outputPath, output_sha256: await sha256File(outputPath), encoded_duration_sec: round(durationFromProbe(itemProbe), 4) });
  }

  const concatPath = path.join(workDir, "timeline.ffconcat");
  const concatText = ["ffconcat version 1.0", ...encoded.map((item) => `file '${item.output_path.replaceAll("'", "'\\''")}'`)].join("\n");
  await fs.writeFile(concatPath, `${concatText}\n`);
  const silentPath = path.join(workDir, "v1_1_visual_silent.mp4");
  await run(ffmpegBin, [
    "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", concatPath,
    "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "16",
    "-pix_fmt", "yuv420p", "-r", String(FPS), "-movflags", "+faststart", silentPath,
  ]);
  return { encoded, silentPath, probe: await probe(silentPath) };
}

async function mixFinal({ silentPath, targetDuration, outputPath }) {
  const inputs = ["-i", silentPath, "-i", baselinePaths.narration, "-stream_loop", "-1", "-i", baselinePaths.music];
  for (const cue of sfxCues) {
    if (cue.loop) inputs.push("-stream_loop", "-1");
    inputs.push("-i", cue.source.path);
  }

  const fadeOutStart = Math.max(0, targetDuration - 2.4);
  const filters = [
    `[1:a]highpass=f=58,apad=pad_dur=1.2,atrim=0:${targetDuration},asetpts=N/SR/TB,asplit=2[voice][voicekey]`,
    `[2:a]atrim=0:${targetDuration},asetpts=N/SR/TB,highpass=f=35,lowpass=f=12500,volume=0.12,afade=t=in:st=0:d=1.2,afade=t=out:st=${fadeOutStart}:d=2.2[bed]`,
    "[bed][voicekey]sidechaincompress=threshold=0.025:ratio=7:attack=15:release=420[ducked]",
  ];
  const mixLabels = ["[voice]", "[ducked]"];
  sfxCues.forEach((cue, index) => {
    const inputIndex = 3 + index;
    const label = `fx${index}`;
    const delayMs = Math.round(cue.start * 1000);
    const fadeOut = Math.max(0.05, cue.duration - 0.25);
    filters.push(`[${inputIndex}:a]atrim=0:${cue.duration},asetpts=N/SR/TB,highpass=f=45,volume=${cue.volume},afade=t=out:st=${fadeOut}:d=0.2,adelay=${delayMs}:all=1[${label}]`);
    mixLabels.push(`[${label}]`);
  });
  filters.push(`${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=longest:normalize=0,alimiter=limit=0.95[mix]`);

  await run(ffmpegBin, [
    "-y", "-v", "error", ...inputs,
    "-filter_complex", filters.join(";"),
    "-map", "0:v:0", "-map", "[mix]", "-t", String(targetDuration),
    "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-ar", "48000",
    "-movflags", "+faststart", outputPath,
  ]);
}

async function buildContactSheet(videoPath, outputPath, interval) {
  await run(ffmpegBin, [
    "-y", "-v", "error", "-i", videoPath,
    "-vf", `fps=1/${interval},scale=480:270,tile=4x4:padding=4:margin=4:color=0x0d171c`,
    "-frames:v", "1", "-update", "1", outputPath,
  ]);
}

async function main() {
  const finalPath = path.join(outputDir, "lost_luggage_hybrid_parity_proof_v1_1.mp4");
  try {
    await fs.access(finalPath);
    throw new Error(`Append-only proof already exists: ${finalPath}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const targetDuration = validateTimeline();
  const baseline = await verifyBaseline();
  await Promise.all(Object.values(graphicPaths).map((value) => ensureFile(value)));
  await Promise.all(Object.values(sfxSources).map((value) => ensureFile(value.path, value.sha256)));
  await fs.mkdir(outputDir, { recursive: true });
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.mkdir(workDir, { recursive: true });

  const timing = await buildWordTiming();
  const visual = await buildVisualTimeline();
  await mixFinal({ silentPath: visual.silentPath, targetDuration, outputPath: finalPath });
  const finalProbe = await probe(finalPath);

  const contactSheetPath = path.join(outputDir, "v1_1_contact_sheet.jpg");
  const openingSheetPath = path.join(outputDir, "v1_1_opening_contact_sheet.jpg");
  await buildContactSheet(finalPath, contactSheetPath, 6.6);
  await run(ffmpegBin, [
    "-y", "-v", "error", "-t", "32", "-i", finalPath,
    "-vf", "fps=1/2.6,scale=480:270,tile=4x3:padding=4:margin=4:color=0x0d171c",
    "-frames:v", "1", "-update", "1", openingSheetPath,
  ]);

  const counts = Object.fromEntries(["source", "still", "reuse"].map((kind) => [kind, visual.encoded.filter((item) => item.kind === kind).length]));
  const report = {
    schema: "goldflow_asset_afterlife_parity_proof_v1_1",
    status: "rendered_pending_operator_review",
    proof_intent: "append_only_v1_refinement",
    official_pipeline_artifacts_modified: false,
    created_at: new Date().toISOString(),
    output_dir: outputDir,
    lineage: {
      selected_baseline: "hybrid_documentary_parity_proof_v1",
      baseline,
      baseline_video_path: baselinePaths.video,
      baseline_video_sha256: BASELINE.video,
      rejected_versions_used_as_edit_baseline: false,
      reused_rejected_version_assets: "four isolated hash-bound SFX files only",
    },
    preservation_contract: {
      exact_script_content_sha256: BASELINE.scriptContent,
      exact_script_file_sha256: BASELINE.scriptFile,
      exact_narration_sha256: BASELINE.narration,
      exact_music_sha256: BASELINE.music,
      narration_tempo_processing: false,
      hard_cut_edit_grammar_preserved: true,
      v1_graphic_language_preserved: true,
    },
    improvements: [
      "Cut boundaries authored against the exact locked narration clock",
      "Moving source-footage coverage increased while generated still coverage was reduced to one opening shot",
      "SFX cues placed at visible or spoken events rather than section estimates",
      "V1 script, narration cadence, underscore, palette, and graphic language preserved",
    ],
    timing: {
      source: "local_faster_whisper_word_timing",
      path: timing.path,
      sha256: timing.sha256,
      word_count: timing.report.words.length,
      narration_audio_sha256: timing.report.narration_audio_sha256,
      timeline_duration_sec: targetDuration,
    },
    visuals: {
      width: WIDTH,
      height: HEIGHT,
      fps: FPS,
      clip_count: visual.encoded.length,
      source_footage_clip_count: counts.source,
      reused_motion_graphic_count: counts.reuse,
      generated_still_clip_count: counts.still,
      source_footage_share: round(counts.source / visual.encoded.length, 4),
      static_still_share: round(counts.still / visual.encoded.length, 4),
      average_clip_duration_sec: round(targetDuration / visual.encoded.length, 3),
      timeline: visual.encoded,
    },
    sound_design: {
      timing_source: "exact_locked_v1_narration_clock",
      cue_count: sfxCues.length,
      cues: await Promise.all(sfxCues.map(async (cue) => ({
        id: cue.id,
        start_sec: cue.start,
        duration_sec: cue.duration,
        volume: cue.volume,
        source_path: cue.source.path,
        source_sha256: await sha256File(cue.source.path),
        model_id: cue.source.model_id ?? null,
        request_id: cue.source.request_id ?? null,
        prompt: cue.source.prompt ?? null,
      }))),
    },
    output: {
      video_path: finalPath,
      video_sha256: await sha256File(finalPath),
      duration_sec: round(durationFromProbe(finalProbe), 3),
      size_bytes: Number(finalProbe?.format?.size ?? 0),
      probe: finalProbe,
      contact_sheet_path: contactSheetPath,
      contact_sheet_sha256: await sha256File(contactSheetPath),
      opening_contact_sheet_path: openingSheetPath,
      opening_contact_sheet_sha256: await sha256File(openingSheetPath),
    },
  };
  const reportPath = path.join(outputDir, "hybrid_parity_proof_v1_1_report.json");
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  const recipeDir = path.join(outputDir, "recipe_snapshot");
  await fs.mkdir(recipeDir, { recursive: true });
  await fs.copyFile(currentFile, path.join(recipeDir, path.basename(currentFile)));
  await fs.copyFile(path.join(repoRoot, "scripts/proofs/lock-proof-baseline.mjs"), path.join(recipeDir, "lock-proof-baseline.mjs"));

  process.stdout.write(`${JSON.stringify({
    status: report.status,
    video_path: finalPath,
    video_sha256: report.output.video_sha256,
    duration_sec: report.output.duration_sec,
    source_footage_share: report.visuals.source_footage_share,
    static_still_share: report.visuals.static_still_share,
    average_clip_duration_sec: report.visuals.average_clip_duration_sec,
    report_path: reportPath,
  }, null, 2)}\n`);
}

await main();
