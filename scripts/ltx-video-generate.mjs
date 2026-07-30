#!/usr/bin/env node

import { execFile as execFileCb } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  LTX_VIDEO_MODEL_ID,
  LTX_VIDEO_PROVIDER,
  clampLtxDuration,
  hashFile,
  ltxMotionPromptForCut,
  ltxNegativePrompt,
  ltxPlanHash,
  ltxVideoEnabled,
  sha256,
} from "./lib/ltx-video-contract.mjs";
import {
  configuredModelslabProfiles,
  loadConfiguredModelslabAccounts,
  modelslabProfileForWorkId,
  publicModelslabAccount,
} from "./lib/modelslab-account-pool.mjs";

const execFile = promisify(execFileCb);
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeDir = path.resolve(flags["episode-dir"] ?? path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode));
const proof = boolFlag(flags["diagnostic-proof"] ?? flags.proof);
const workflowBypass = boolFlag(flags["workflow-bypass"]);
const proofLabel = cleanSlug(flags["proof-label"] ?? "ltx23-15-cut-proof");
const outputDir = path.resolve(flags["output-dir"] ?? (proof
  ? path.join(episodeDir, "review_samples", proofLabel)
  : path.join(episodeDir, "assets", "motion", "ltx23")));
const planPath = path.resolve(flags.plan ?? path.join(outputDir, `ltx_video_plan_${episode}${proof ? `-${proofLabel}` : ""}.json`));
const outputPath = path.resolve(flags.output ?? path.join(outputDir, `ltx_video_report_${episode}${proof ? `-${proofLabel}` : ""}.json`));
const promptPath = path.resolve(flags.prompts ?? path.join(episodeDir, "section_image_prompts_hardened.json"));
const imagegenReportPath = path.resolve(flags["imagegen-report"] ?? path.join(episodeDir, `imagegen_report_${episode}.json`));
const imageQaPath = path.resolve(flags["image-output-qa"] ?? path.join(episodeDir, `image_output_qa_${episode}.json`));
const identityPath = path.resolve(flags["run-identity"] ?? path.join(episodeDir, "run_identity.json"));
const animationDirectionPath = path.resolve(flags["animation-direction-plan"] ?? path.join(episodeDir, `animation_direction_plan_${episode}.json`));
const concurrency = boundedInteger(flags.concurrency, 15, 1, 30);
const requestedDuration = flags.duration == null ? null : clampLtxDuration(flags.duration);
const pollIntervalMs = boundedInteger(flags["poll-interval-ms"], 7000, 2000, 60000);
const timeoutMs = boundedInteger(flags["timeout-ms"], 900000, 30000, 3600000);
const modelslabProfiles = configuredModelslabProfiles({
  flagValue: flags["modelslab-profiles"],
});

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
  return /^(true|1|yes)$/i.test(String(value ?? "false"));
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? Math.round(parsed) : fallback));
}

function cleanSlug(value) {
  return String(value ?? "proof").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "proof";
}

async function readJson(filePath, fallback = null) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); } catch { return fallback; }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function values(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === "string" && value) return [value];
  return [];
}

function responseUrls(json = {}) {
  return [...values(json.output), ...values(json.proxy_links), ...values(json.future_links)];
}

function providerRateLimitDelayMs(message) {
  const match = String(message ?? "").match(/try again in\s+(\d+)\s+minute/i);
  if (!match) return null;
  return (Number(match[1]) * 60 + 5) * 1000;
}

async function postJson(url, body, {
  account,
  retries = 2,
  rateLimitRetries = 0,
} = {}) {
  if (!account?.apiKey) throw new Error("ModelsLab request is missing its assigned account.");
  let lastError = null;
  let remainingRateLimitRetries = rateLimitRetries;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: account.apiKey, ...body }),
      });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch { throw new Error(`Non-JSON ${response.status}: ${text.slice(0, 500)}`); }
      if (!response.ok || ["error", "failed"].includes(String(json.status ?? ""))) {
        const message = `ModelsLab ${response.status}: ${JSON.stringify(json).slice(0, 1200)}`;
        const waitMs = providerRateLimitDelayMs(message);
        if (waitMs != null && remainingRateLimitRetries > 0) {
          remainingRateLimitRetries -= 1;
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          attempt -= 1;
          continue;
        }
        throw new Error(message);
      }
      return json;
    } catch (error) {
      lastError = error;
      if (attempt <= retries) await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
    }
  }
  throw lastError;
}

async function uploadImage(filePath, account) {
  const extension = path.extname(filePath).toLowerCase();
  const mime = extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : "image/png";
  const base64 = (await fs.readFile(filePath)).toString("base64");
  const json = await postJson("https://modelslab.com/api/v6/base64_to_url", {
    base64_string: `data:${mime};base64,${base64}`,
  }, { account });
  const url = responseUrls(json)[0];
  if (!url) throw new Error(`ModelsLab upload returned no URL for ${filePath}`);
  return url;
}

async function pollResult(requestId, startedAtMs, account) {
  while (Date.now() - startedAtMs < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const json = await postJson(
      `https://modelslab.com/api/v6/video/fetch/${requestId}`,
      {},
      { account, retries: 1 },
    );
    if (json.status === "success" && responseUrls(json).length) return json;
    if (["error", "failed"].includes(String(json.status ?? ""))) throw new Error(json.message ?? `LTX request ${requestId} failed.`);
  }
  throw new Error(`LTX request ${requestId} timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
}

async function downloadResult(json, outputFile) {
  let lastError = null;
  for (const url of responseUrls(json)) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(String(response.status));
      await fs.mkdir(path.dirname(outputFile), { recursive: true });
      await fs.writeFile(outputFile, Buffer.from(await response.arrayBuffer()));
      return url;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("ModelsLab success response contained no downloadable output.");
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
  const ratioParts = String(video?.r_frame_rate ?? "0/1").split("/").map(Number);
  const fps = ratioParts[1] ? ratioParts[0] / ratioParts[1] : 0;
  return {
    duration_sec: Number(json.format?.duration ?? 0),
    size_bytes: Number(json.format?.size ?? 0),
    width: Number(video?.width ?? 0),
    height: Number(video?.height ?? 0),
    fps: Number(fps.toFixed(6)),
    video_codec: video?.codec_name ?? null,
    pixel_format: video?.pix_fmt ?? null,
    has_audio: (json.streams ?? []).some((row) => row.codec_type === "audio"),
  };
}

async function normalizeVideo(inputPath, outputFile, durationSec) {
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
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
    outputFile,
  ], { maxBuffer: 1024 * 1024 * 32 });
  return probeVideo(outputFile);
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

function requestedCutIds() {
  return String(flags["cut-ids"] ?? flags["image-ids"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

async function buildPlan({ promptPlan, imagegenReport, imageQa, identity }) {
  if (promptPlan?.status !== "passed" || !Array.isArray(promptPlan.prompts)) throw new Error(`Missing passed hardened prompt plan: ${promptPath}`);
  if (imagegenReport?.status !== "passed" || !Array.isArray(imagegenReport.results)) throw new Error(`Missing passed imagegen report: ${imagegenReportPath}`);
  if (imageQa?.status !== "passed") throw new Error(`Missing passed image QA: ${imageQaPath}`);
  if (!ltxVideoEnabled(identity) && !(proof && workflowBypass)) {
    throw new Error("LTX generation is not locked in run_identity.json. Use a new preflight with --ltx-video-policy, or an explicit bounded --diagnostic-proof true --workflow-bypass true.");
  }
  const resultById = new Map(imagegenReport.results.map((row) => [String(row.image_id ?? ""), row]));
  const acceptedHashes = imageQa.accepted_image_hashes ?? {};
  const explicitIds = requestedCutIds();
  const maxCuts = boundedInteger(flags["max-cuts"], explicitIds.length || (proof ? 15 : promptPlan.prompts.length), 1, proof ? 25 : 100000);
  const selectedPrompts = (explicitIds.length
    ? explicitIds.map((id) => promptPlan.prompts.find((row) => String(row.image_id) === id))
    : promptPlan.prompts.filter((row) => row.image_generation_required !== false).slice(0, maxCuts))
    .filter(Boolean);
  if (!selectedPrompts.length) throw new Error("No cuts selected for LTX generation.");
  if (explicitIds.length && selectedPrompts.length !== explicitIds.length) throw new Error("One or more requested --cut-ids were not found in the hardened prompt plan.");
  const clips = [];
  for (const prompt of selectedPrompts) {
    const imageId = String(prompt.image_id ?? "");
    const result = resultById.get(imageId);
    const imagePath = result?.image_path ? path.resolve(result.image_path) : null;
    const actualHash = imagePath ? await hashFile(imagePath) : null;
    const acceptedHash = acceptedHashes[imageId] ?? result?.image_sha256 ?? null;
    if (!imagePath || !actualHash) throw new Error(`Selected cut ${imageId} has no readable accepted image.`);
    if (!acceptedHash || actualHash !== acceptedHash) throw new Error(`Selected cut ${imageId} image hash is missing or stale.`);
    const motionPrompt = ltxMotionPromptForCut(prompt);
    const durationSec = requestedDuration ?? clampLtxDuration(prompt.duration_sec ?? 5);
    clips.push({
      image_id: imageId,
      scene_id: prompt.scene_id ?? null,
      visual_beat_id: prompt.visual_beat_id ?? null,
      start_sec: Number(prompt.start_sec ?? 0),
      cut_duration_sec: Number(prompt.duration_sec ?? durationSec),
      duration_sec: durationSec,
      source_image_path: imagePath,
      source_image_sha256: actualHash,
      source_prompt_sha256: sha256(JSON.stringify(prompt)),
      motion_prompt: motionPrompt,
      motion_prompt_sha256: sha256(motionPrompt),
      negative_prompt: ltxNegativePrompt(),
    });
  }
  const plan = {
    schema: "goldflow_ltx23_video_plan_v1",
    status: "passed",
    channel,
    series_slug: series,
    week,
    episode,
    proof,
    proof_label: proof ? proofLabel : null,
    provider: LTX_VIDEO_PROVIDER,
    model_id: LTX_VIDEO_MODEL_ID,
    resolution: "16:9",
    requested_concurrency: concurrency,
    source_hashes: {
      [promptPath]: await hashFile(promptPath),
      [imagegenReportPath]: await hashFile(imagegenReportPath),
      [imageQaPath]: await hashFile(imageQaPath),
      [identityPath]: await hashFile(identityPath),
    },
    clip_count: clips.length,
    clips,
    updated_at: new Date().toISOString(),
  };
  plan.plan_sha256 = ltxPlanHash(plan);
  return plan;
}

async function contactSheet(clips, sheetPath) {
  const frameDir = path.join(path.dirname(sheetPath), "contact_frames");
  await fs.mkdir(frameDir, { recursive: true });
  const frames = [];
  await runLimited(clips, 6, async (clip, index) => {
    const framePath = path.join(frameDir, `${String(index + 1).padStart(3, "0")}-${clip.image_id}.png`);
    await execFile("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", String(Math.max(0.1, Number(clip.normalized_probe?.duration_sec ?? 5) / 2)),
      "-i", clip.normalized_video_path,
      "-frames:v", "1",
      framePath,
    ]);
    frames[index] = framePath;
  });
  const cellWidth = 480;
  const cellHeight = 270;
  const columns = 3;
  const rows = Math.ceil(frames.length / columns);
  const background = sharp({
    create: { width: columns * cellWidth, height: rows * cellHeight, channels: 3, background: "#111827" },
  });
  const composites = [];
  for (let index = 0; index < frames.length; index += 1) {
    const buffer = await sharp(frames[index]).resize(cellWidth, cellHeight, { fit: "cover" }).jpeg().toBuffer();
    composites.push({ input: buffer, left: (index % columns) * cellWidth, top: Math.floor(index / columns) * cellHeight });
  }
  await background.composite(composites).jpeg({ quality: 90 }).toFile(sheetPath);
}

async function main() {
  const [promptPlan, imagegenReport, imageQa, identity, animationDirection, modelslabAccounts] = await Promise.all([
    readJson(promptPath),
    readJson(imagegenReportPath),
    readJson(imageQaPath),
    readJson(identityPath, {}),
    readJson(animationDirectionPath, null),
    loadConfiguredModelslabAccounts(modelslabProfiles, { cwd: repoRoot }),
  ]);
  const accountByProfile = new Map(modelslabAccounts.map((account) => [account.profile, account]));
  let plan;
  const explicitProofDirection = proof && workflowBypass && Boolean(flags["animation-direction-plan"]);
  if ((!proof && ltxVideoEnabled(identity)) || explicitProofDirection) {
    if (animationDirection?.schema !== "goldflow_animation_direction_plan_v1" || animationDirection?.status !== "passed") {
      throw new Error(`Production LTX generation requires a passed animation direction plan: ${animationDirectionPath}`);
    }
    const explicit = new Set(requestedCutIds());
    const selected = (animationDirection.directions ?? []).filter((row) => !explicit.size || explicit.has(String(row.image_id)));
    if (explicit.size && selected.length !== explicit.size) throw new Error("One or more requested --cut-ids are absent from the animation direction plan.");
    const clips = selected.map((row) => ({
      image_id: row.image_id,
      scene_id: row.scene_id,
      visual_beat_id: row.visual_beat_id,
      start_sec: row.start_sec,
      cut_duration_sec: row.cut_duration_sec,
      duration_sec: row.requested_generation_duration_sec,
      source_image_path: row.source_image_path,
      source_image_sha256: row.source_image_sha256,
      source_prompt_sha256: row.source_prompt_sha256,
      motion_prompt: row.motion_prompt,
      motion_prompt_sha256: sha256(row.motion_prompt),
      negative_prompt: row.negative_prompt,
      candidate_count: row.candidate_count ?? 1,
    }));
    plan = {
      schema: "goldflow_ltx23_video_plan_v1",
      status: "passed",
      channel,
      series_slug: series,
      week,
      episode,
      proof,
      proof_label: proof ? proofLabel : null,
      provider: LTX_VIDEO_PROVIDER,
      model_id: LTX_VIDEO_MODEL_ID,
      resolution: "16:9",
      requested_concurrency: concurrency,
      animation_direction_plan_path: animationDirectionPath,
      source_hashes: { ...animationDirection.source_hashes, [animationDirectionPath]: await hashFile(animationDirectionPath) },
      clip_count: clips.length,
      clips,
      updated_at: new Date().toISOString(),
    };
    plan.plan_sha256 = ltxPlanHash(plan);
  } else {
    plan = await buildPlan({ promptPlan, imagegenReport, imageQa, identity });
  }
  await writeJson(planPath, plan);
  await fs.mkdir(path.join(outputDir, "raw"), { recursive: true });
  await fs.mkdir(path.join(outputDir, "normalized"), { recursive: true });
  const rows = plan.clips.flatMap((clip) => Array.from(
    { length: Math.max(1, Number(clip.candidate_count ?? 1)) },
    (_, index) => ({
      ...clip,
      candidate_index: index + 1,
      candidate_id: `${clip.image_id}-candidate-${String(index + 1).padStart(2, "0")}`,
      status: "planned",
    }),
  ));
  for (const row of rows) {
    const profile = modelslabProfileForWorkId(row.candidate_id, modelslabProfiles);
    row.modelslab_account = accountByProfile.get(profile);
    if (!row.modelslab_account) throw new Error(`ModelsLab account profile ${profile} was not loaded.`);
  }
  const batchStartedMs = Date.now();
  await runLimited(rows, concurrency, async (row) => {
    row.upload_started_at = new Date().toISOString();
    row.init_image_url = await uploadImage(row.source_image_path, row.modelslab_account);
    row.upload_elapsed_ms = Date.now() - Date.parse(row.upload_started_at);
    row.status = "uploaded";
  });
  await runLimited(rows, concurrency, async (row) => {
    const startedAtMs = Date.now();
    row.request_started_at = new Date(startedAtMs).toISOString();
    try {
      const initial = await postJson("https://modelslab.com/api/v6/video/img2video_ultra", {
        model_id: LTX_VIDEO_MODEL_ID,
        init_image: row.init_image_url,
        prompt: row.motion_prompt,
        negative_prompt: row.negative_prompt,
        resolution: "16:9",
        duration: String(row.duration_sec),
        base64: false,
        temp: false,
        track_id: `goldflow-${episode}-${proofLabel}-${row.candidate_id}`,
      }, {
        account: row.modelslab_account,
        rateLimitRetries: 1,
      });
      row.request_id = initial.id ?? null;
      row.initial_eta_sec = initial.eta ?? null;
      row.submit_latency_ms = Date.now() - startedAtMs;
      row.status = String(initial.status ?? "processing");
      row.initial_response = {
        status: initial.status ?? null,
        id: initial.id ?? null,
        eta: initial.eta ?? null,
        message: initial.message ?? null,
      };
    } catch (error) {
      row.status = "failed";
      row.error = error instanceof Error ? error.message : String(error);
    }
  });
  const submittedRows = rows.filter((row) => row.request_id || row.status === "success");
  await runLimited(submittedRows, concurrency, async (row) => {
    const startedAtMs = Date.parse(row.request_started_at);
    try {
      const result = row.status === "success" && responseUrls(row.initial_response).length
        ? row.initial_response
        : await pollResult(row.request_id, startedAtMs, row.modelslab_account);
      row.provider_generation_time_sec = result.generationTime ?? null;
      const rawPath = path.join(outputDir, "raw", `${row.candidate_id}-ltx23.mp4`);
      row.download_url = await downloadResult(result, rawPath);
      row.raw_video_path = rawPath;
      row.raw_video_sha256 = await hashFile(rawPath);
      row.raw_probe = await probeVideo(rawPath);
      const normalizedPath = path.join(outputDir, "normalized", `${row.candidate_id}-ltx23-1920x1080.mp4`);
      row.normalized_probe = await normalizeVideo(rawPath, normalizedPath, row.duration_sec);
      row.normalized_video_path = normalizedPath;
      row.normalized_video_sha256 = await hashFile(normalizedPath);
      row.wall_time_sec = Number(((Date.now() - startedAtMs) / 1000).toFixed(3));
      row.status = "generated";
      delete row.init_image_url;
      delete row.download_url;
    } catch (error) {
      row.status = "failed";
      row.error = error instanceof Error ? error.message : String(error);
    }
  });
  const completed = rows.filter((row) => row.status === "generated");
  const failures = rows.filter((row) => row.status !== "generated");
  const sheetPath = path.join(outputDir, `ltx_video_contact_sheet_${episode}${proof ? `-${proofLabel}` : ""}.jpg`);
  if (completed.length) await contactSheet(completed, sheetPath);
  const report = {
    schema: "goldflow_ltx23_video_report_v1",
    status: failures.length ? "failed" : "passed",
    channel,
    series_slug: series,
    week,
    episode,
    proof,
    proof_label: proof ? proofLabel : null,
    provider: LTX_VIDEO_PROVIDER,
    model_id: LTX_VIDEO_MODEL_ID,
    plan_path: planPath,
    plan_sha256: await hashFile(planPath),
    plan_contract_sha256: plan.plan_sha256,
    source_hashes: plan.source_hashes,
    requested_concurrency: concurrency,
    modelslab_account_pool: modelslabAccounts.map((account) => ({
      profile: account.profile,
      ...publicModelslabAccount(account),
    })),
    clip_count: rows.length,
    generated_count: completed.length,
    failed_count: failures.length,
    batch_wall_time_sec: Number(((Date.now() - batchStartedMs) / 1000).toFixed(3)),
    contact_sheet_path: completed.length ? sheetPath : null,
    clips: rows.map((row) => ({
      image_id: row.image_id,
      candidate_id: row.candidate_id,
      candidate_index: row.candidate_index,
      scene_id: row.scene_id,
      visual_beat_id: row.visual_beat_id,
      start_sec: row.start_sec,
      cut_duration_sec: row.cut_duration_sec,
      requested_duration_sec: row.duration_sec,
      source_image_path: row.source_image_path,
      source_image_sha256: row.source_image_sha256,
      source_prompt_sha256: row.source_prompt_sha256,
      motion_prompt_sha256: row.motion_prompt_sha256,
      modelslab_account_profile: row.modelslab_account?.profile ?? null,
      modelslab_account_fingerprint: row.modelslab_account?.fingerprint ?? null,
      request_id: row.request_id ?? null,
      initial_eta_sec: row.initial_eta_sec ?? null,
      submit_latency_ms: row.submit_latency_ms ?? null,
      wall_time_sec: row.wall_time_sec ?? null,
      provider_generation_time_sec: row.provider_generation_time_sec ?? null,
      raw_video_path: row.raw_video_path ?? null,
      raw_video_sha256: row.raw_video_sha256 ?? null,
      raw_probe: row.raw_probe ?? null,
      normalized_video_path: row.normalized_video_path ?? null,
      normalized_video_sha256: row.normalized_video_sha256 ?? null,
      normalized_probe: row.normalized_probe ?? null,
      status: row.status,
      error: row.error ?? null,
    })),
    updated_at: new Date().toISOString(),
  };
  await writeJson(outputPath, report);
  console.log(JSON.stringify({
    status: report.status,
    output_path: outputPath,
    plan_path: planPath,
    contact_sheet_path: report.contact_sheet_path,
    clip_count: report.clip_count,
    generated_count: report.generated_count,
    failed_count: report.failed_count,
    batch_wall_time_sec: report.batch_wall_time_sec,
  }, null, 2));
  if (failures.length) process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    await writeJson(outputPath, {
      schema: "goldflow_ltx23_video_report_v1",
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      updated_at: new Date().toISOString(),
    }).catch(() => {});
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
