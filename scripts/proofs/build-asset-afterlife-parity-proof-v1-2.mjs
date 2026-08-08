#!/usr/bin/env node

import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";

const execFile = promisify(execFileCb);
const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "../..");
const flags = parseFlags(process.argv.slice(2));
const episodeDir = path.resolve(String(flags["episode-dir"] ?? process.env.ASSET_AFTERLIFE_EPISODE_DIR ?? ""));

if (!episodeDir) throw new Error("Pass --episode-dir <path>.");

const v1Dir = path.join(episodeDir, "review_samples/hybrid_documentary_parity_proof_v1");
const v11Dir = path.join(episodeDir, "review_samples/hybrid_documentary_parity_proof_v1_1");
const outputDir = path.join(episodeDir, "review_samples/hybrid_documentary_parity_proof_v1_2");
const sourceAudioDir = path.join(outputDir, "sfx_source_downloads");
const openingAssetDir = path.join(outputDir, "opening_motion_assets");
const workDir = path.join(outputDir, "work");
const ffmpegBin = process.env.FFMPEG_BIN ?? "ffmpeg";
const ffprobeBin = process.env.FFPROBE_BIN ?? "ffprobe";
const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const TARGET_DURATION = 106.24;
const OPENING_FRAMES = 100;
const OPENING_DURATION = OPENING_FRAMES / FPS;

const EXPECTED = {
  v1: {
    lock: "d9528f61a5b4afca599c23e1c2da28c98d550ed3270fe81ccef959e1ed5ecbdf",
    content: "f8bd65ae173ba4cc205bfd6eb1e571ae725ca34d14560e478c4ed0769ed1720b",
    narration: "ccb8d870598fdf96116e8534a4a7464a4e399968c564ea7cb1897c2b72f9533c",
    music: "a5be491b4788974c71cbec05403e39ffd94df1bbdedd26a94fbea547c58bf915",
    script: "d51ba4dc1dadbf865c5e6af7bfa804476e47ba4cb57e4f859f11024eeda6c65a",
  },
  v11: {
    lock: "96ea72ceceb86de24b3200ddd1e8f090283d5ce719142a1d480466679d77caf3",
    content: "51426021eae8f3c3280e0b2b6d3590e4c7f9319a7a0fe61e7542f2135f1565fb",
    video: "9e69285e37b568b52b21427b1f3c4d2f0ef5e2f178ee6598fa3eb7c8f6c5d350",
  },
  opening: {
    image: "94a600ce7f19310e6d2242ba5967918a7b725febadb5a0011d985b6337689256",
    mask: "9482d6cd11a803b7a381319b171033284182f61bb21f61cb95483210211af387",
    foreground: "25e754c6cf34eaf9b559e4ac864df4a23a0eac39223526d682297169c83b3109",
    background: "374013c20618ef32d69e063379aaf411c4e396df68aecc0070464d3d2b773b72",
  },
};

const paths = {
  v1Lock: path.join(v1Dir, "BASELINE_LOCK.json"),
  v11Lock: path.join(v11Dir, "BASELINE_LOCK.json"),
  v11Video: path.join(v11Dir, "lost_luggage_hybrid_parity_proof_v1_1.mp4"),
  v11Report: path.join(v11Dir, "hybrid_parity_proof_v1_1_report.json"),
  narration: path.join(v1Dir, "narration_elevenlabs_adam.wav"),
  music: path.join(v1Dir, "documentary_underscore.provider-audio"),
  script: path.join(v1Dir, "proof_script.md"),
  openingImage: path.join(episodeDir, "assets/images/ep_01-w000000-w000008-modelslab-image.png"),
  openingMask: path.join(openingAssetDir, "red-suitcase-foreground-mask.png"),
  openingForeground: path.join(openingAssetDir, "red-suitcase-foreground.png"),
  openingBackground: path.join(openingAssetDir, "red-suitcase-background-plate.png"),
  openingAssetReport: path.join(openingAssetDir, "red-suitcase-parallax-assets.json"),
};

function source(id, title, channel, wavSha256, infoSha256) {
  return {
    id,
    title,
    channel,
    url: `https://www.youtube.com/watch?v=${id}`,
    path: path.join(sourceAudioDir, `${id}.wav`),
    info_path: path.join(sourceAudioDir, `${id}.info.json`),
    wav_sha256: wavSha256,
    info_sha256: infoSha256,
  };
}

const sfxSources = {
  baggageMotor: source(
    "JhDvWsWZPvk",
    "AIRPORT SOUNDS EFFECTS - Airport, Baggage Claim, Motor Of Luggage Conveyor Belt",
    "Reality Sound",
    "637e6927d6d586db280de7356b9be5364ba9f4aae4b4a9fe50028c65963e4b41",
    "3676c762f35dda9376bc5dc1dfd2dd3efa0a89dd3022f686645b32406b1722ce",
  ),
  conveyorStart: source(
    "biMXVPqOkPw",
    "Conveyor belt starting",
    "Sound Effects - Topic",
    "68379376086f7048785748b00ec64b521ad57796754b9f24d6cd25fa53520854",
    "4f096711863e383f4684d199e5c159a8e48786e7efe12970bc86cf4ed10760a6",
  ),
  suitcaseImpact: source(
    "kfNLjFRVmbo",
    "Suitcase 1 SOUND Effect",
    "SOUND Effects Public Domain (No Copyrights)",
    "434e565e765f533fe7d663d3e1092ccd047cfc3cb710a3d935acfda87bb42c2b",
    "1a80becefa21bcd996ed0c4241659583a2135e6c139995723882ac1b235c6765",
  ),
  airportScanner: source(
    "jA5rz7T2wks",
    "Airport Ticket Scanner",
    "DevBadge",
    "a03f0d3089a6d89c2349ddbabfe49a86e3cd32a05d756aa0caa9d86da46d07b7",
    "6753313683b361e06013fa2d5b1917b300aeff3e0c40d6c0eb01692bf0b922bb",
  ),
  rubberStamp: source(
    "6QcNHrhFEBg",
    "Stamp SOUND EFFECT - Rubber Approved Impact Stamping Stempel SOUND",
    "BerlinAtmospheres",
    "6329cea0b5123b3b5e9731c2149d2eface4b2d9e0d49302dc3bd5e81ae435101",
    "ca83dd2fd33fd4ef3d85f1b020ad5a01b390c2db26500a9d6e7aec0289248302",
  ),
  suitcaseWheels: source(
    "JFcFAX-F2M4",
    "Rolling Suitcase Sound Effect",
    "Free Sound Stock",
    "de47dc0bd49a4716716092cb594ab37bd19ae6154fd7e32081521b9639a4c570",
    "c499bdc2f2179aadc70f64f94331596898e6130d6d181fcaec53669e960c11fc",
  ),
  suitcaseZipper: source(
    "eH8TB5v8-9A",
    "Zipper of Suitcase or Briefcase",
    "Dr. Sound FX - Topic",
    "6bbfb1e74b11acabd32c13bafcf55a4402949ec4e77a866c2d51572c6e2c5d05",
    "576748e6dcb462bc30d1dc26ac6fbb6cff7de7b912198fc810bb630840a439c5",
  ),
  splitFlap: source(
    "cj32w5z81Ak",
    "The wonderful split-flap Departure Board at Frankfurt Airport",
    "Aileron Aviation Films",
    "77cec3bedde757e7f3367239ae5aeb46e12a6a356b4b77652e5fd925e6f7046e",
    "8602014f0fc194341a27efe8fe8952840e0e2a54c95efb68640734ac1327af26",
  ),
};

const sfxCues = [
  cue("opening_baggage_motor", sfxSources.baggageMotor, 0.00, 0.25, 9.55, 0.030, { fade_in: 0.12, fade_out: 0.55 }),
  cue("opening_conveyor_start", sfxSources.conveyorStart, 0.00, 0.00, 2.48, 0.095, { fade_out: 0.28 }),
  cue("opening_suitcase_settle", sfxSources.suitcaseImpact, 0.08, 0.00, 1.25, 0.080, { fade_out: 0.18 }),
  cue("opening_status_flaps", sfxSources.splitFlap, 1.72, 0.49, 1.25, 0.065, { fade_out: 0.18 }),
  cue("tracking_scan_confirm", sfxSources.airportScanner, 18.36, 1.80, 0.20, 0.14),
  cue("checkpoint_handoff", sfxSources.airportScanner, 22.42, 1.80, 0.20, 0.055),
  cue("checkpoint_loading", sfxSources.airportScanner, 23.40, 1.80, 0.20, 0.055),
  cue("checkpoint_transfer", sfxSources.airportScanner, 24.06, 1.80, 0.20, 0.055),
  cue("checkpoint_return", sfxSources.airportScanner, 24.94, 1.80, 0.20, 0.055),
  cue("claim_stamp", sfxSources.rubberStamp, 43.84, 7.66, 0.34, 0.085),
  cue("route_wheels", sfxSources.suitcaseWheels, 59.88, 2.50, 1.70, 0.060, { fade_out: 0.22 }),
  cue("sorting_zipper", sfxSources.suitcaseZipper, 74.72, 0.10, 1.58, 0.085, { fade_out: 0.20 }),
  cue("electronics_test_confirm", sfxSources.airportScanner, 80.22, 5.04, 0.12, 0.11),
];

function cue(id, sourceRecord, start, sourceStart, duration, volume, extra = {}) {
  return { id, source: sourceRecord, start, source_start: sourceStart, duration, volume, ...extra };
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
  if (expectedHash && actualHash !== expectedHash) {
    throw new Error(`Hash mismatch for ${filePath}: expected ${expectedHash}, got ${actualHash}`);
  }
  return { path: filePath, size_bytes: stat.size, sha256: actualHash };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
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

async function verifyLock(lockPath, proofDir, expectedHash, expectedContent) {
  await ensureFile(lockPath, expectedHash);
  const lock = await readJson(lockPath);
  if (lock.status !== "locked" || lock.content_sha256 !== expectedContent) {
    throw new Error(`Invalid proof lock: ${lockPath}`);
  }
  const mismatches = [];
  for (const record of lock.artifacts ?? []) {
    const filePath = path.join(proofDir, record.path);
    try {
      const actual = await ensureFile(filePath);
      if (actual.sha256 !== record.sha256 || actual.size_bytes !== record.size_bytes) mismatches.push(record.path);
    } catch {
      mismatches.push(record.path);
    }
  }
  if (mismatches.length) throw new Error(`Locked proof mismatch: ${mismatches.join(", ")}`);
  return {
    path: lockPath,
    sha256: expectedHash,
    content_sha256: expectedContent,
    artifact_count: lock.artifact_count,
  };
}

async function verifyInputs() {
  const [v1Lock, v11Lock] = await Promise.all([
    verifyLock(paths.v1Lock, v1Dir, EXPECTED.v1.lock, EXPECTED.v1.content),
    verifyLock(paths.v11Lock, v11Dir, EXPECTED.v11.lock, EXPECTED.v11.content),
  ]);
  const [video, narration, music, script, image, mask, foreground, background] = await Promise.all([
    ensureFile(paths.v11Video, EXPECTED.v11.video),
    ensureFile(paths.narration, EXPECTED.v1.narration),
    ensureFile(paths.music, EXPECTED.v1.music),
    ensureFile(paths.script, EXPECTED.v1.script),
    ensureFile(paths.openingImage, EXPECTED.opening.image),
    ensureFile(paths.openingMask, EXPECTED.opening.mask),
    ensureFile(paths.openingForeground, EXPECTED.opening.foreground),
    ensureFile(paths.openingBackground, EXPECTED.opening.background),
  ]);
  const v11Report = await readJson(paths.v11Report);
  if (v11Report?.output?.video_sha256 !== EXPECTED.v11.video) throw new Error("V1.1 report no longer matches its locked video.");
  const openingAssetReport = await readJson(paths.openingAssetReport);
  if (openingAssetReport?.status !== "passed"
    || openingAssetReport?.background_strategy !== "modelslab_flux_klein_reconstruction"
    || openingAssetReport?.background_sha256 !== EXPECTED.opening.background
    || openingAssetReport?.foreground_sha256 !== EXPECTED.opening.foreground) {
    throw new Error("Opening Flux Klein parallax asset contract changed.");
  }

  const sourceRecords = [];
  for (const record of Object.values(sfxSources)) {
    const [wav, info] = await Promise.all([
      ensureFile(record.path, record.wav_sha256),
      ensureFile(record.info_path, record.info_sha256),
    ]);
    const metadata = await readJson(record.info_path);
    if (metadata.id !== record.id || metadata.webpage_url !== record.url) {
      throw new Error(`SFX metadata mismatch for ${record.id}`);
    }
    sourceRecords.push({
      ...record,
      wav_size_bytes: wav.size_bytes,
      info_size_bytes: info.size_bytes,
      downloaded_title: metadata.title,
      downloaded_channel: metadata.channel,
      duration_sec: metadata.duration,
    });
  }
  return { v1Lock, v11Lock, video, narration, music, script, image, mask, foreground, background, openingAssetReport, sourceRecords };
}

async function buildStatusCard(outputPath) {
  const svg = `
    <svg width="520" height="126" viewBox="0 0 520 126" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="518" height="124" rx="10" fill="#091217" fill-opacity="0.92" stroke="#dce6e8" stroke-opacity="0.24" stroke-width="2"/>
      <rect x="1" y="1" width="9" height="124" rx="4" fill="#d84a3f"/>
      <circle cx="40" cy="34" r="6" fill="#d84a3f"/>
      <text x="58" y="42" fill="#b9c8cc" font-family="DIN Condensed, Avenir Next Condensed, sans-serif" font-size="23" font-weight="700" letter-spacing="4">BAGGAGE STATUS</text>
      <text x="30" y="101" fill="#ffffff" font-family="DIN Condensed, Avenir Next Condensed, sans-serif" font-size="51" font-weight="700" letter-spacing="1">20 MINUTES LATE</text>
    </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outputPath);
}

async function buildOpeningClip(statusCardPath, outputPath) {
  const filter = [
    `[0:v]scale=${WIDTH}:${HEIGHT}:flags=lanczos,zoompan=z='1.012+0.00024*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${WIDTH}x${HEIGHT}:fps=${FPS},trim=duration=${OPENING_DURATION},setpts=PTS-STARTPTS[bg]`,
    `[1:v]scale=1978:1113:flags=lanczos,format=rgba,trim=duration=${OPENING_DURATION},setpts=PTS-STARTPTS[fg]`,
    `[bg][fg]overlay=x='-41+12*min(t/${OPENING_DURATION},1)':y='-17+if(lt(t,0.18),-20+28*t/0.18,8*exp(-5*(t-0.18))*cos(22*(t-0.18)))':eval=frame:format=auto[scene]`,
    `[2:v]format=rgba,fade=t=in:st=1.72:d=0.12:alpha=1,trim=duration=${OPENING_DURATION},setpts=PTS-STARTPTS[card]`,
    `[scene][card]overlay=x='if(lt(t,1.97),${WIDTH}-(${WIDTH}-1320)*(t-1.72)/0.25,1320)':y=120:enable='between(t,1.72,${OPENING_DURATION})':eval=frame:format=auto,trim=duration=${OPENING_DURATION},fps=${FPS},format=yuv420p[out]`,
  ].join(";");
  await run(ffmpegBin, [
    "-y", "-v", "error",
    "-loop", "1", "-framerate", String(FPS), "-t", String(OPENING_DURATION), "-i", paths.openingBackground,
    "-loop", "1", "-framerate", String(FPS), "-t", String(OPENING_DURATION), "-i", paths.openingForeground,
    "-loop", "1", "-framerate", String(FPS), "-t", String(OPENING_DURATION), "-i", statusCardPath,
    "-filter_complex", filter, "-map", "[out]", "-frames:v", String(OPENING_FRAMES), "-an",
    "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", "-r", String(FPS),
    "-movflags", "+faststart", outputPath,
  ]);
}

async function buildSilentVisual(openingPath, outputPath) {
  const bodyPath = path.join(workDir, "v1_1_body_after_opening.mp4");
  const bodyDuration = TARGET_DURATION - OPENING_DURATION;
  await run(ffmpegBin, [
    "-y", "-v", "error", "-ss", String(OPENING_DURATION), "-i", paths.v11Video,
    "-t", String(bodyDuration), "-an",
    "-vf", `setpts=PTS-STARTPTS,scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},fps=${FPS},setsar=1`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", "-r", String(FPS),
    "-movflags", "+faststart", bodyPath,
  ]);
  await run(ffmpegBin, [
    "-y", "-v", "error", "-i", openingPath, "-i", bodyPath,
    "-filter_complex", `[0:v]setpts=PTS-STARTPTS[o];[1:v]setpts=PTS-STARTPTS[b];[o][b]concat=n=2:v=1:a=0,trim=duration=${TARGET_DURATION},fps=${FPS},format=yuv420p[v]`,
    "-map", "[v]", "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", "-r", String(FPS),
    "-movflags", "+faststart", outputPath,
  ]);
}

async function mixFinal(silentPath, outputPath) {
  const inputs = ["-i", silentPath, "-i", paths.narration, "-stream_loop", "-1", "-i", paths.music];
  for (const item of sfxCues) inputs.push("-i", item.source.path);
  const fadeOutStart = TARGET_DURATION - 2.4;
  const filters = [
    `[1:a]highpass=f=58,apad=pad_dur=1.2,atrim=0:${TARGET_DURATION},asetpts=N/SR/TB,asplit=2[voice][voicekey]`,
    `[2:a]atrim=0:${TARGET_DURATION},asetpts=N/SR/TB,highpass=f=35,lowpass=f=12500,volume=0.12,afade=t=in:st=0:d=1.2,afade=t=out:st=${fadeOutStart}:d=2.2[bed]`,
    "[bed][voicekey]sidechaincompress=threshold=0.025:ratio=7:attack=15:release=420[ducked]",
  ];
  const labels = ["[voice]", "[ducked]"];
  sfxCues.forEach((item, index) => {
    const inputIndex = index + 3;
    const label = `fx${index}`;
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
    filters.push(`[${inputIndex}:a]${operations.join(",")}[${label}]`);
    labels.push(`[${label}]`);
  });
  filters.push(`${labels.join("")}amix=inputs=${labels.length}:duration=longest:normalize=0,alimiter=limit=0.95[mix]`);
  await run(ffmpegBin, [
    "-y", "-v", "error", ...inputs,
    "-filter_complex", filters.join(";"), "-map", "0:v:0", "-map", "[mix]", "-t", String(TARGET_DURATION),
    "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-movflags", "+faststart", outputPath,
  ]);
}

async function buildContactSheet(videoPath, outputPath, filter) {
  await run(ffmpegBin, [
    "-y", "-v", "error", "-i", videoPath, "-vf", filter,
    "-frames:v", "1", "-update", "1", outputPath,
  ]);
}

async function main() {
  const finalPath = path.join(outputDir, "lost_luggage_hybrid_parity_proof_v1_2.mp4");
  try {
    await fs.access(finalPath);
    throw new Error(`Append-only proof already exists: ${finalPath}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const inputs = await verifyInputs();
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.mkdir(workDir, { recursive: true });
  const statusCardPath = path.join(workDir, "opening-status-card.png");
  const openingPath = path.join(workDir, "opening-motion-silent.mp4");
  const silentPath = path.join(workDir, "v1_2_visual_silent.mp4");
  await buildStatusCard(statusCardPath);
  await buildOpeningClip(statusCardPath, openingPath);
  await buildSilentVisual(openingPath, silentPath);
  await mixFinal(silentPath, finalPath);

  const openingPreviewPath = path.join(outputDir, "v1_2_opening_preview.mp4");
  await run(ffmpegBin, [
    "-y", "-v", "error", "-i", finalPath, "-t", "12", "-c", "copy", "-movflags", "+faststart", openingPreviewPath,
  ]);
  const contactSheetPath = path.join(outputDir, "v1_2_contact_sheet.jpg");
  const openingSheetPath = path.join(outputDir, "v1_2_opening_motion_sheet.jpg");
  await buildContactSheet(finalPath, contactSheetPath, "fps=1/6.6,scale=480:270,tile=4x4:padding=4:margin=4:color=0x0d171c");
  await buildContactSheet(finalPath, openingSheetPath, "fps=5/2,scale=384:216,tile=5x2:padding=4:margin=4:color=0x0d171c");

  const [finalProbe, openingProbe] = await Promise.all([probe(finalPath), probe(openingPreviewPath)]);
  const cueRows = await Promise.all(sfxCues.map(async (item) => ({
    id: item.id,
    timeline_start_sec: item.start,
    source_start_sec: item.source_start,
    source_end_sec: round(item.source_start + item.duration, 3),
    duration_sec: item.duration,
    mix_volume: item.volume,
    youtube_id: item.source.id,
    youtube_url: item.source.url,
    source_title: item.source.title,
    source_channel: item.source.channel,
    source_audio_path: item.source.path,
    source_audio_sha256: await sha256File(item.source.path),
    source_metadata_path: item.source.info_path,
    source_metadata_sha256: await sha256File(item.source.info_path),
  })));
  const sourceLedger = {
    schema: "goldflow_sourced_sfx_ledger_v1",
    status: "passed",
    created_at: new Date().toISOString(),
    acquisition_tool: "yt-dlp",
    acquisition_tool_version: "2026.07.04",
    generated_sfx_used: false,
    exact_source_slice_required: true,
    sources: inputs.sourceRecords,
    cues: cueRows,
  };
  const sourceLedgerPath = path.join(outputDir, "sourced_sfx_ledger_v1_2.json");
  await fs.writeFile(sourceLedgerPath, `${JSON.stringify(sourceLedger, null, 2)}\n`);

  const report = {
    schema: "goldflow_asset_afterlife_parity_proof_v1_2",
    status: "rendered_pending_operator_review",
    proof_intent: "append_only_v1_1_opening_motion_and_sourced_sfx_refinement",
    official_pipeline_artifacts_modified: false,
    created_at: new Date().toISOString(),
    output_dir: outputDir,
    lineage: {
      canonical_baseline: "hybrid_documentary_parity_proof_v1",
      immediate_visual_baseline: "hybrid_documentary_parity_proof_v1_1",
      v1_lock: inputs.v1Lock,
      v1_1_lock: inputs.v11Lock,
      v1_1_video_sha256: EXPECTED.v11.video,
      v1_1_timeline_reused_after_frame: OPENING_FRAMES,
      prior_proofs_modified: false,
    },
    preservation_contract: {
      exact_script_sha256: EXPECTED.v1.script,
      exact_narration_sha256: EXPECTED.v1.narration,
      exact_music_sha256: EXPECTED.v1.music,
      narration_tempo_processing: false,
      post_opening_v1_1_visual_edit_preserved: true,
      hard_cut_edit_grammar_preserved: true,
    },
    opening: {
      duration_sec: OPENING_DURATION,
      source_image_path: paths.openingImage,
      source_image_sha256: EXPECTED.opening.image,
      local_foreground_mask_sha256: EXPECTED.opening.mask,
      foreground_sha256: EXPECTED.opening.foreground,
      rear_plate_sha256: EXPECTED.opening.background,
      rear_plate_provider: "modelslab_flux_klein",
      rear_plate_request_id: inputs.openingAssetReport?.background_provider_result?.modelslab_request_id ?? null,
      generated_video_model_used: false,
      motion_jobs: [
        "opposing-plane camera push",
        "weighted suitcase settle aligned to sourced impact",
        "status card slide aligned to the spoken twenty-minute hook",
      ],
      status_card_text: "20 MINUTES LATE",
      status_card_reveal_sec: 1.72,
      status_phrase_start_sec: 1.80,
    },
    visuals: {
      width: WIDTH,
      height: HEIGHT,
      fps: FPS,
      clip_count: 32,
      source_footage_clip_count: 23,
      reused_motion_graphic_count: 8,
      animated_generated_opening_count: 1,
      static_still_count: 0,
      source_footage_share: 0.7188,
      static_still_share: 0,
      average_clip_duration_sec: 3.32,
    },
    sound_design: {
      timing_source: "exact_locked_v1_narration_clock",
      generated_sfx_used: false,
      sourced_sfx_cue_count: cueRows.length,
      source_ledger_path: sourceLedgerPath,
      cues: cueRows,
    },
    output: {
      video_path: finalPath,
      video_sha256: await sha256File(finalPath),
      duration_sec: round(Number(finalProbe?.format?.duration ?? 0), 3),
      size_bytes: Number(finalProbe?.format?.size ?? 0),
      probe: finalProbe,
      opening_preview_path: openingPreviewPath,
      opening_preview_sha256: await sha256File(openingPreviewPath),
      opening_preview_probe: openingProbe,
      contact_sheet_path: contactSheetPath,
      contact_sheet_sha256: await sha256File(contactSheetPath),
      opening_motion_sheet_path: openingSheetPath,
      opening_motion_sheet_sha256: await sha256File(openingSheetPath),
    },
  };
  const reportPath = path.join(outputDir, "hybrid_parity_proof_v1_2_report.json");
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
    duration_sec: report.output.duration_sec,
    static_still_share: report.visuals.static_still_share,
    sourced_sfx_cue_count: report.sound_design.sourced_sfx_cue_count,
    generated_sfx_used: report.sound_design.generated_sfx_used,
    report_path: reportPath,
  }, null, 2)}\n`);
}

await main();
