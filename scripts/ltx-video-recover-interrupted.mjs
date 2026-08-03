#!/usr/bin/env node

import { execFile as execFileCb } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  LTX_VIDEO_MODEL_ID,
  LTX_VIDEO_PROVIDER,
  hashFile,
  ltxPlanHash,
  sha256,
} from "./lib/ltx-video-contract.mjs";
import {
  loadConfiguredModelslabAccounts,
  modelslabProfileForWorkId,
  parseModelslabProfiles,
} from "./lib/modelslab-account-pool.mjs";
import {
  publicLtxClipResult,
  publicLtxModelslabAccountPool,
  redactLtxAccountProfileNames,
} from "./lib/ltx-video-report-contract.mjs";

const execFile = promisify(execFileCb);
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

function boolFlag(value) {
  return /^(?:true|1|yes)$/iu.test(String(value ?? "false"));
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? Math.round(parsed) : fallback));
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : fallback));
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, serialized, "utf8");
  await fs.rename(temporary, filePath);
  return sha256(serialized);
}

function values(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === "string" && value) return [value];
  return [];
}

function responseUrls(json = {}) {
  return [...values(json.output), ...values(json.proxy_links), ...values(json.future_links)];
}

export function parseProfileRequestMap(value) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("--profile-request-map is required.");
  let entries;
  if (raw.startsWith("{")) {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("--profile-request-map JSON must be an object of profile names to request-id arrays.");
    }
    entries = Object.entries(parsed);
  } else {
    entries = raw.split(";").map((entry) => {
      const separator = entry.indexOf("=");
      if (separator < 1) throw new Error("Text --profile-request-map entries must use profile=id1,id2;profile2=id3.");
      return [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()];
    });
  }
  const mappings = [];
  const seenRequests = new Set();
  const seenProfiles = new Set();
  for (const [rawProfile, rawRequests] of entries) {
    const profile = parseModelslabProfiles([rawProfile], { fallback: [] })[0];
    if (!profile || seenProfiles.has(profile)) throw new Error("Duplicate or empty ModelsLab profile in --profile-request-map.");
    seenProfiles.add(profile);
    const requestIds = (Array.isArray(rawRequests) ? rawRequests : String(rawRequests ?? "").split(","))
      .map((requestId) => String(requestId ?? "").trim())
      .filter(Boolean);
    if (!requestIds.length) throw new Error("Each ModelsLab profile mapping requires at least one request id.");
    for (const requestId of requestIds) {
      if (seenRequests.has(requestId)) throw new Error(`Duplicate ModelsLab request id ${requestId}.`);
      seenRequests.add(requestId);
    }
    mappings.push({ profile, request_ids: requestIds });
  }
  if (!mappings.length) throw new Error("--profile-request-map did not contain any request ids.");
  return mappings;
}

async function fetchExistingVideoJob(requestId, account) {
  const response = await fetch(`https://modelslab.com/api/v6/video/fetch/${encodeURIComponent(requestId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: account.apiKey }),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`ModelsLab existing-job fetch returned non-JSON HTTP ${response.status}.`);
  }
  if (!response.ok) throw new Error(`ModelsLab existing-job fetch returned HTTP ${response.status}.`);
  return json;
}

async function downloadExistingOutput(json, outputFile) {
  const urls = responseUrls(json);
  if (!urls.length) throw new Error("Existing ModelsLab job has no downloadable output URL.");
  let lastError = null;
  for (const url of urls) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await fs.writeFile(outputFile, Buffer.from(await response.arrayBuffer()));
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("Existing ModelsLab output could not be downloaded.");
}

async function probeVideo(filePath) {
  const { stdout } = await execFile("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration,size",
    "-show_entries", "stream=index,codec_type,codec_name,width,height,r_frame_rate,pix_fmt",
    "-of", "json",
    filePath,
  ], { maxBuffer: 1024 * 1024 * 8 });
  const json = JSON.parse(stdout);
  const video = (json.streams ?? []).find((row) => row.codec_type === "video");
  const [numerator, denominator] = String(video?.r_frame_rate ?? "0/1").split("/").map(Number);
  return {
    duration_sec: Number(json.format?.duration ?? 0),
    size_bytes: Number(json.format?.size ?? 0),
    width: Number(video?.width ?? 0),
    height: Number(video?.height ?? 0),
    fps: denominator ? Number((numerator / denominator).toFixed(6)) : 0,
    video_codec: video?.codec_name ?? null,
    pixel_format: video?.pix_fmt ?? null,
    has_audio: (json.streams ?? []).some((row) => row.codec_type === "audio"),
  };
}

async function extractFirstFrame(videoPath, outputPath) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await execFile("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", videoPath,
    "-vf", "select=eq(n\\,0)",
    "-frames:v", "1",
    outputPath,
  ], { maxBuffer: 1024 * 1024 * 16 });
}

async function normalizeVideo(inputPath, outputPath, durationSec) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await execFile("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", inputPath,
    "-t", Number(durationSec).toFixed(3),
    "-vf", "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=24,setsar=1",
    "-an",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    outputPath,
  ], { maxBuffer: 1024 * 1024 * 32 });
  const probe = await probeVideo(outputPath);
  if (probe.width !== 1920 || probe.height !== 1080 || Math.abs(probe.fps - 24) > 0.01 || probe.has_audio) {
    throw new Error("Recovered LTX normalization failed the 1920x1080/24fps/no-audio contract.");
  }
  return probe;
}

export async function perceptualFingerprint(imagePath) {
  // ModelsLab's recovered first frame is 3:2 even when the accepted source is
  // 16:9. Compare the same center 3:2 field of view instead of distorting both
  // images to a square or penalizing the provider's aspect-ratio padding.
  const width = 96;
  const height = 64;
  const luminance = await sharp(imagePath)
    .rotate()
    .resize(width, height, { fit: "cover", position: "centre" })
    .grayscale()
    .raw()
    .toBuffer();
  const sobel = [];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const at = (dx, dy) => Number(luminance[(y + dy) * width + x + dx]);
      const gx = -at(-1, -1) + at(1, -1) - 2 * at(-1, 0) + 2 * at(1, 0) - at(-1, 1) + at(1, 1);
      const gy = -at(-1, -1) - 2 * at(0, -1) - at(1, -1) + at(-1, 1) + 2 * at(0, 1) + at(1, 1);
      sobel.push(Math.hypot(gx, gy));
    }
  }
  return { width, height, luminance, sobel };
}

function normalizedCrossCorrelation(left, right) {
  if (left.length !== right.length || !left.length) throw new Error("NCC inputs must have the same non-zero length.");
  let leftMean = 0;
  let rightMean = 0;
  for (let index = 0; index < left.length; index += 1) {
    leftMean += Number(left[index]);
    rightMean += Number(right[index]);
  }
  leftMean /= left.length;
  rightMean /= right.length;
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]) - leftMean;
    const b = Number(right[index]) - rightMean;
    covariance += a * b;
    leftVariance += a * a;
    rightVariance += b * b;
  }
  if (!leftVariance || !rightVariance) return leftMean === rightMean ? 1 : 0;
  return Math.max(-1, Math.min(1, covariance / Math.sqrt(leftVariance * rightVariance)));
}

function blockSsim(left, right, width, height, blockSize = 8) {
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  const scores = [];
  for (let blockY = 0; blockY < height; blockY += blockSize) {
    for (let blockX = 0; blockX < width; blockX += blockSize) {
      const leftValues = [];
      const rightValues = [];
      for (let y = blockY; y < Math.min(height, blockY + blockSize); y += 1) {
        for (let x = blockX; x < Math.min(width, blockX + blockSize); x += 1) {
          leftValues.push(Number(left[y * width + x]));
          rightValues.push(Number(right[y * width + x]));
        }
      }
      const count = leftValues.length;
      const leftMean = leftValues.reduce((sum, value) => sum + value, 0) / count;
      const rightMean = rightValues.reduce((sum, value) => sum + value, 0) / count;
      let leftVariance = 0;
      let rightVariance = 0;
      let covariance = 0;
      for (let index = 0; index < count; index += 1) {
        const a = leftValues[index] - leftMean;
        const b = rightValues[index] - rightMean;
        leftVariance += a * a;
        rightVariance += b * b;
        covariance += a * b;
      }
      const divisor = Math.max(1, count - 1);
      leftVariance /= divisor;
      rightVariance /= divisor;
      covariance /= divisor;
      scores.push(((2 * leftMean * rightMean + c1) * (2 * covariance + c2))
        / ((leftMean ** 2 + rightMean ** 2 + c1) * (leftVariance + rightVariance + c2)));
    }
  }
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

export function comparePerceptualFingerprints(left, right) {
  if (left.width !== right.width || left.height !== right.height || left.luminance.length !== right.luminance.length) {
    throw new Error("Perceptual fingerprint dimensions do not match.");
  }
  const ssim = blockSsim(left.luminance, right.luminance, left.width, left.height);
  const luminanceNcc = normalizedCrossCorrelation(left.luminance, right.luminance);
  const sobelEdgeNcc = normalizedCrossCorrelation(left.sobel, right.sobel);
  const score = 0.45 * ssim + 0.35 * luminanceNcc + 0.20 * sobelEdgeNcc;
  return {
    score: Number(score.toFixed(6)),
    block_ssim: Number(ssim.toFixed(6)),
    luminance_ncc: Number(luminanceNcc.toFixed(6)),
    sobel_edge_ncc: Number(sobelEdgeNcc.toFixed(6)),
    comparison_geometry: "center_crop_3x2_96x64",
    ensemble_weights: { block_ssim: 0.45, luminance_ncc: 0.35, sobel_edge_ncc: 0.20 },
  };
}

export function buildCandidateSlots(plan, profiles) {
  return (plan.clips ?? []).flatMap((clip) => Array.from(
    { length: Math.max(1, Number(clip.candidate_count ?? 1)) },
    (_, index) => {
      const candidateIndex = index + 1;
      const candidateId = `${clip.image_id}-candidate-${String(candidateIndex).padStart(2, "0")}`;
      return {
        ...clip,
        candidate_index: candidateIndex,
        candidate_id: candidateId,
        route_profile: modelslabProfileForWorkId(candidateId, profiles),
      };
    },
  ));
}

export function perceptualGateReason(metrics, {
  score,
  margin,
  hasRunner,
  minimumScore = 0.85,
  minimumMargin = 0.20,
  minimumBlockSsim = 0.80,
  minimumLuminanceNcc = 0.90,
} = {}) {
  if (!metrics) return "no_candidate_slot_for_assigned_account";
  if (Number(score) < minimumScore) return "perceptual_score_below_threshold";
  if (Number(metrics.block_ssim) < minimumBlockSsim) return "block_ssim_below_threshold";
  if (Number(metrics.luminance_ncc) < minimumLuminanceNcc) return "luminance_ncc_below_threshold";
  if (hasRunner && Number(margin) < minimumMargin) return "perceptual_match_ambiguous";
  return null;
}

export function assignRecoveredJobs(jobs, slots, {
  minimumScore = 0.85,
  minimumMargin = 0.20,
  minimumBlockSsim = 0.80,
  minimumLuminanceNcc = 0.90,
} = {}) {
  const slotsByProfileAndImage = new Map();
  for (const slot of slots) {
    const key = `${slot.route_profile}\0${slot.image_id}`;
    if (!slotsByProfileAndImage.has(key)) slotsByProfileAndImage.set(key, []);
    slotsByProfileAndImage.get(key).push(slot);
  }
  for (const rows of slotsByProfileAndImage.values()) rows.sort((a, b) => a.candidate_index - b.candidate_index);
  const analyses = jobs.map((job) => {
    const eligibleByImage = new Map();
    for (const slot of slots) {
      if (slot.route_profile !== job.route_profile || eligibleByImage.has(slot.image_id)) continue;
      eligibleByImage.set(slot.image_id, slot);
    }
    const options = [...eligibleByImage.values()]
      .map((slot) => ({ slot, metrics: comparePerceptualFingerprints(job.fingerprint, slot.source_fingerprint) }))
      .sort((a, b) => b.metrics.score - a.metrics.score || String(a.slot.image_id).localeCompare(String(b.slot.image_id)));
    const best = options[0] ?? null;
    const runner = options[1] ?? null;
    const margin = best ? best.metrics.score - Number(runner?.metrics.score ?? 0) : 0;
    const rejectionReason = perceptualGateReason(best?.metrics ?? null, {
      score: best?.metrics.score,
      margin,
      hasRunner: Boolean(runner),
      minimumScore,
      minimumMargin,
      minimumBlockSsim,
      minimumLuminanceNcc,
    });
    return {
      job,
      best,
      runner,
      margin,
      rejection_reason: rejectionReason,
    };
  }).sort((a, b) => {
    if (Boolean(a.rejection_reason) !== Boolean(b.rejection_reason)) return a.rejection_reason ? 1 : -1;
    return b.margin - a.margin || Number(b.best?.metrics.score ?? 0) - Number(a.best?.metrics.score ?? 0)
      || String(a.job.request_id).localeCompare(String(b.job.request_id));
  });
  const assigned = [];
  const unmatched = [];
  for (const analysis of analyses) {
    const diagnostics = {
      algorithm: "source_first_frame_perceptual_v1",
      decision: analysis.rejection_reason ? "unmatched" : "matched",
      reason: analysis.rejection_reason,
      best_image_id: analysis.best?.slot.image_id ?? null,
      runner_up_image_id: analysis.runner?.slot.image_id ?? null,
      score: analysis.best?.metrics.score ?? null,
      runner_up_score: analysis.runner?.metrics.score ?? null,
      margin: analysis.best ? Number(analysis.margin.toFixed(6)) : null,
      minimum_score: minimumScore,
      minimum_margin: minimumMargin,
      minimum_block_ssim: minimumBlockSsim,
      minimum_luminance_ncc: minimumLuminanceNcc,
      metrics: analysis.best?.metrics ?? null,
    };
    if (analysis.rejection_reason) {
      unmatched.push({ ...analysis.job, match_diagnostics: diagnostics });
      continue;
    }
    const key = `${analysis.job.route_profile}\0${analysis.best.slot.image_id}`;
    const available = slotsByProfileAndImage.get(key) ?? [];
    const slot = available.shift();
    if (!slot) {
      unmatched.push({
        ...analysis.job,
        match_diagnostics: { ...diagnostics, decision: "unmatched", reason: "matched_candidate_capacity_exhausted" },
      });
      continue;
    }
    assigned.push({ ...analysis.job, slot, match_diagnostics: diagnostics });
  }
  return { assigned, unmatched };
}

async function runLimited(rows, limit, worker) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, rows.length) }, async () => {
    while (cursor < rows.length) {
      const index = cursor;
      cursor += 1;
      await worker(rows[index], index);
    }
  });
  await Promise.all(workers);
}

async function contactSheet(clips, sheetPath) {
  const columns = 3;
  const cellWidth = 480;
  const cellHeight = 270;
  const rows = Math.ceil(clips.length / columns);
  const composites = [];
  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index];
    const frame = await sharp(clip.first_frame_path).resize(cellWidth, cellHeight, { fit: "cover" }).jpeg().toBuffer();
    composites.push({ input: frame, left: (index % columns) * cellWidth, top: Math.floor(index / columns) * cellHeight });
  }
  await sharp({
    create: { width: columns * cellWidth, height: rows * cellHeight, channels: 3, background: "#111827" },
  }).composite(composites).jpeg({ quality: 90 }).toFile(sheetPath);
}

function sanitizePrivateText(value, accounts, profiles) {
  let redacted = redactLtxAccountProfileNames(value, profiles);
  for (const account of accounts) {
    if (account.apiKey) redacted = redacted.replaceAll(account.apiKey, "[redacted-api-key]");
  }
  return redacted;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (!boolFlag(flags["confirm-existing-jobs-only"])) {
    throw new Error("--confirm-existing-jobs-only true is required; this recovery command never submits generation or retries.");
  }
  const channel = flags.channel ?? "53rebirth";
  const series = flags.series ?? flags.seriesSlug ?? "series";
  const week = flags.week ?? "current";
  const episode = flags.episode ?? "ep_01";
  const episodeDir = path.resolve(flags["episode-dir"] ?? path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode));
  const outputDir = path.resolve(flags["output-dir"] ?? path.join(episodeDir, "assets", "motion", "ltx23"));
  const planPath = path.resolve(flags.plan ?? path.join(outputDir, `ltx_video_plan_${episode}.json`));
  const outputPath = path.resolve(flags.output ?? path.join(outputDir, `ltx_video_report_${episode}.json`));
  const triagePath = path.resolve(flags["triage-output"] ?? path.join(episodeDir, `manual_blocker_triage_generated_video_motion_${episode}.json`));
  const concurrency = boundedInteger(flags.concurrency, 8, 1, 15);
  const minimumScore = boundedNumber(flags["min-match-score"], 0.85, 0.5, 0.999);
  const minimumMargin = boundedNumber(flags["min-match-margin"], 0.20, 0, 0.5);
  const minimumBlockSsim = boundedNumber(flags["min-block-ssim"], 0.80, 0.5, 0.999);
  const minimumLuminanceNcc = boundedNumber(flags["min-luminance-ncc"], 0.90, 0.5, 0.999);
  const mappings = parseProfileRequestMap(flags["profile-request-map"] ?? flags["profile-requests"]);
  const profiles = mappings.map((row) => row.profile);
  const [plan, existingTriage, accounts] = await Promise.all([
    readJson(planPath),
    readJson(triagePath),
    loadConfiguredModelslabAccounts(profiles, { cwd: repoRoot }),
  ]);
  if (plan?.schema !== "goldflow_ltx23_video_plan_v1" || plan?.status !== "passed" || !(plan.clips ?? []).length) {
    throw new Error(`Interrupted recovery requires a passed non-empty LTX plan: ${planPath}`);
  }
  if (plan.provider !== LTX_VIDEO_PROVIDER || plan.model_id !== LTX_VIDEO_MODEL_ID) {
    throw new Error("Interrupted recovery plan provider/model does not match the locked LTX 2.3 route.");
  }
  if (plan.plan_sha256 !== ltxPlanHash(plan)) throw new Error("Interrupted recovery refused a stale LTX plan contract hash.");
  if (!existingTriage || typeof existingTriage !== "object" || Array.isArray(existingTriage)) {
    throw new Error(`Interrupted recovery requires the existing manual triage artifact: ${triagePath}`);
  }
  const staleSources = [];
  for (const [sourcePath, expectedHash] of Object.entries(plan.source_hashes ?? {})) {
    if (await hashFile(sourcePath) !== expectedHash) staleSources.push(sourcePath);
  }
  if (!Object.keys(plan.source_hashes ?? {}).length || staleSources.length) {
    throw new Error("Interrupted recovery refused stale or missing plan source provenance.");
  }
  const accountByProfile = new Map(accounts.map((account) => [account.profile, account]));
  const slots = buildCandidateSlots(plan, profiles);
  const fingerprintsByHash = new Map();
  for (const slot of slots) {
    const actualHash = await hashFile(slot.source_image_path);
    if (!actualHash || actualHash !== slot.source_image_sha256) {
      throw new Error(`Interrupted recovery refused stale accepted source image ${slot.image_id}.`);
    }
    if (!fingerprintsByHash.has(actualHash)) {
      fingerprintsByHash.set(actualHash, await perceptualFingerprint(slot.source_image_path));
    }
    slot.source_fingerprint = fingerprintsByHash.get(actualHash);
  }
  const jobs = mappings.flatMap((mapping) => mapping.request_ids.map((requestId) => ({
    request_id: requestId,
    route_profile: mapping.profile,
    account: accountByProfile.get(mapping.profile),
    status: "pending_fetch",
  })));
  if (jobs.some((job) => !job.account)) throw new Error("One mapped ModelsLab account could not be loaded.");
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), `goldflow-ltx-recovery-${episode}-`));
  const diagnosticFrameDir = path.join(outputDir, "recovery_first_frames");
  await fs.mkdir(diagnosticFrameDir, { recursive: true });
  try {
    await runLimited(jobs, concurrency, async (job) => {
      const requestToken = sha256(job.request_id).slice(0, 16);
      job.request_token = requestToken;
      try {
        const response = await fetchExistingVideoJob(job.request_id, job.account);
        job.fetch_status = String(response.status ?? "unknown");
        job.provider_generation_time_sec = response.generationTime ?? null;
        if (job.fetch_status !== "success" || !responseUrls(response).length) {
          job.status = "omitted";
          job.omission_reason = `existing_job_${job.fetch_status}`;
          return;
        }
        const rawPath = path.join(scratchDir, `${requestToken}.mp4`);
        await downloadExistingOutput(response, rawPath);
        job.raw_video_path = rawPath;
        job.raw_probe = await probeVideo(rawPath);
        if (!job.raw_probe.duration_sec || !job.raw_probe.width || !job.raw_probe.height) {
          throw new Error("Downloaded existing job is not a valid video.");
        }
        const firstFramePath = path.join(diagnosticFrameDir, `${requestToken}-first-frame.png`);
        await extractFirstFrame(rawPath, firstFramePath);
        job.first_frame_path = firstFramePath;
        job.first_frame_sha256 = await hashFile(firstFramePath);
        job.fingerprint = await perceptualFingerprint(firstFramePath);
        job.status = "downloaded_for_match";
      } catch (error) {
        job.status = "omitted";
        job.omission_reason = "existing_job_fetch_or_download_failed";
        job.error = sanitizePrivateText(error instanceof Error ? error.message : String(error), accounts, profiles);
      }
    });
    const matchableJobs = jobs.filter((job) => job.status === "downloaded_for_match");
    const { assigned, unmatched } = assignRecoveredJobs(matchableJobs, slots, {
      minimumScore,
      minimumMargin,
      minimumBlockSsim,
      minimumLuminanceNcc,
    });
    const unmatchedByRequest = new Map(unmatched.map((job) => [job.request_id, job]));
    const completed = [];
    for (const assignment of assigned) {
      const { slot, account } = assignment;
      try {
        const rawPath = path.join(outputDir, "raw", `${slot.candidate_id}-ltx23.mp4`);
        const normalizedPath = path.join(outputDir, "normalized", `${slot.candidate_id}-ltx23-1920x1080.mp4`);
        await fs.mkdir(path.dirname(rawPath), { recursive: true });
        await fs.copyFile(assignment.raw_video_path, rawPath);
        const rawProbe = await probeVideo(rawPath);
        const normalizedProbe = await normalizeVideo(rawPath, normalizedPath, slot.duration_sec);
        const row = {
          ...slot,
          duration_sec: slot.duration_sec,
          modelslab_account: account,
          request_id: assignment.request_id,
          provider_generation_time_sec: assignment.provider_generation_time_sec,
          raw_video_path: rawPath,
          raw_video_sha256: await hashFile(rawPath),
          raw_probe: rawProbe,
          normalized_video_path: normalizedPath,
          normalized_video_sha256: await hashFile(normalizedPath),
          normalized_probe: normalizedProbe,
          status: "generated",
          first_frame_path: assignment.first_frame_path,
          first_frame_sha256: assignment.first_frame_sha256,
          match_diagnostics: assignment.match_diagnostics,
        };
        completed.push(row);
      } catch (error) {
        unmatchedByRequest.set(assignment.request_id, {
          ...assignment,
          status: "omitted",
          omission_reason: "normalization_failed",
          error: sanitizePrivateText(error instanceof Error ? error.message : String(error), accounts, profiles),
        });
      }
    }
    if (!completed.length) throw new Error("Interrupted recovery found no confidently matched, structurally valid survivor clips.");
    const recoveredCandidateIds = new Set(completed.map((row) => row.candidate_id));
    const omittedCandidates = slots.filter((slot) => !recoveredCandidateIds.has(slot.candidate_id)).map((slot) => ({
      image_id: slot.image_id,
      candidate_id: slot.candidate_id,
      candidate_index: slot.candidate_index,
      source_image_path: slot.source_image_path,
      source_image_sha256: slot.source_image_sha256,
      disposition: "accepted_still_motion_fallback",
      reason: "no_confidently_recovered_existing_job_assigned",
    }));
    const omittedJobs = jobs.filter((job) => job.status === "omitted")
      .concat([...unmatchedByRequest.values()])
      .filter((job, index, rows) => rows.findIndex((candidate) => candidate.request_id === job.request_id) === index)
      .map((job) => ({
        request_id: job.request_id,
        modelslab_account_fingerprint: job.account?.fingerprint ?? null,
        provider_status: job.fetch_status ?? null,
        disposition: "omitted_without_retry",
        reason: job.match_diagnostics?.reason ?? job.omission_reason ?? "not_recovered",
        first_frame_path: job.first_frame_path ?? null,
        first_frame_sha256: job.first_frame_sha256 ?? null,
        match_diagnostics: job.match_diagnostics ?? null,
        error: job.error ?? null,
      }));
    completed.sort((left, right) => Number(left.start_sec ?? 0) - Number(right.start_sec ?? 0)
      || Number(left.candidate_index ?? 0) - Number(right.candidate_index ?? 0));
    const sheetPath = path.join(outputDir, `ltx_video_contact_sheet_${episode}.jpg`);
    await contactSheet(completed, sheetPath);
    const publicClips = completed.map((row) => ({
      ...publicLtxClipResult(row, { accountProfiles: profiles }),
      recovery_source: "existing_v6_video_fetch",
      first_frame_path: row.first_frame_path,
      first_frame_sha256: row.first_frame_sha256,
      perceptual_match: row.match_diagnostics,
    }));
    const now = new Date().toISOString();
    const report = {
      schema: "goldflow_ltx23_video_report_v1",
      status: "passed",
      channel,
      series_slug: series,
      week,
      episode,
      proof: false,
      proof_label: null,
      provider: LTX_VIDEO_PROVIDER,
      model_id: LTX_VIDEO_MODEL_ID,
      plan_path: planPath,
      plan_sha256: await hashFile(planPath),
      plan_contract_sha256: plan.plan_sha256,
      source_hashes: plan.source_hashes,
      requested_concurrency: concurrency,
      modelslab_account_pool: publicLtxModelslabAccountPool(accounts),
      clip_count: publicClips.length,
      generated_count: publicClips.length,
      failed_count: 0,
      contact_sheet_path: sheetPath,
      partial_recovery: {
        schema: "goldflow_ltx23_interrupted_recovery_v1",
        mode: "fetch_existing_v6_jobs_only",
        generation_requests_submitted: 0,
        provider_retries: 0,
        input_request_count: jobs.length,
        fetched_success_count: matchableJobs.length,
        survivor_count: publicClips.length,
        omitted_request_count: omittedJobs.length,
        planned_candidate_count: slots.length,
        omitted_candidate_count: omittedCandidates.length,
        report_policy: "passed_survivors_only",
        omitted_candidate_policy: "accepted_still_motion_fallback",
        matching_contract: {
          algorithm: "source_first_frame_perceptual_v1",
          minimum_score: minimumScore,
          minimum_margin: minimumMargin,
          minimum_block_ssim: minimumBlockSsim,
          minimum_luminance_ncc: minimumLuminanceNcc,
          deterministic_account_route_required: true,
        },
        omitted_jobs: omittedJobs,
        omitted_candidates: omittedCandidates,
      },
      clips: publicClips,
      updated_at: now,
    };
    report.partial_recovery.recovery_contract_sha256 = sha256(JSON.stringify({
      plan_sha256: report.plan_sha256,
      plan_contract_sha256: report.plan_contract_sha256,
      survivor_candidates: publicClips.map((clip) => ({
        candidate_id: clip.candidate_id,
        source_image_sha256: clip.source_image_sha256,
        normalized_video_sha256: clip.normalized_video_sha256,
        account_fingerprint: clip.modelslab_account_fingerprint,
      })),
      omitted_candidates: omittedCandidates.map((row) => ({ candidate_id: row.candidate_id, source_image_sha256: row.source_image_sha256 })),
    }));
    await atomicWriteJson(outputPath, report);
    const reportSha256 = await hashFile(outputPath);
    const interruptionEvidence = {
      observed_at: now,
      disposition: "recovered_existing_v6_jobs_without_generation_or_retry",
      plan_path: planPath,
      plan_sha256: report.plan_sha256,
      recovered_report_path: outputPath,
      recovered_report_sha256: reportSha256,
      input_request_count: jobs.length,
      survivor_count: publicClips.length,
      omitted_request_count: omittedJobs.length,
      omitted_candidate_count: omittedCandidates.length,
      modelslab_account_pool: publicLtxModelslabAccountPool(accounts),
      evidence: [
        "Only pre-existing ModelsLab v6 request IDs were fetched; no generation endpoint was called.",
        "No provider request was retried.",
        "Every survivor was assigned only after first-frame perceptual matching to a current accepted source image and deterministic account-route compatibility.",
        "Every omitted candidate explicitly falls back to its accepted still-image motion treatment.",
      ],
    };
    const triage = {
      ...existingTriage,
      interruption_evidence: [
        ...(Array.isArray(existingTriage.interruption_evidence) ? existingTriage.interruption_evidence : []),
        interruptionEvidence,
      ],
      updated_at: now,
    };
    await atomicWriteJson(triagePath, triage);
    console.log(JSON.stringify({
      status: "passed",
      output_path: outputPath,
      triage_path: triagePath,
      input_request_count: jobs.length,
      survivor_count: publicClips.length,
      omitted_request_count: omittedJobs.length,
      omitted_candidate_count: omittedCandidates.length,
      contact_sheet_path: sheetPath,
    }, null, 2));
  } finally {
    await fs.rm(scratchDir, { recursive: true, force: true });
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const rawProfiles = (() => {
    try {
      const flags = parseFlags(process.argv.slice(2));
      return parseProfileRequestMap(flags["profile-request-map"] ?? flags["profile-requests"]).map((row) => row.profile);
    } catch {
      return [];
    }
  })();
  main().catch((error) => {
    console.error(redactLtxAccountProfileNames(error instanceof Error ? error.message : String(error), rawProfiles));
    process.exitCode = 1;
  });
}
