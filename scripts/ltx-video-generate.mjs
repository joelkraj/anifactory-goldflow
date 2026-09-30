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
  LTX_SINGLE_SHOT_POLICY,
  clampLtxDuration,
  hashFile,
  ltxMotionPromptForCut,
  ltxNegativePrompt,
  ltxPlanHash,
  ltxProviderPayloadForClip,
  ltxVideoEnabled,
  sha256,
} from "./lib/ltx-video-contract.mjs";
import {
  configuredModelslabProfiles,
  loadConfiguredModelslabAccounts,
  modelslabProfileForWorkId,
} from "./lib/modelslab-account-pool.mjs";
import {
  publicLtxClipResult,
  publicLtxModelslabAccountPool,
  redactLtxAccountProfileNames,
} from "./lib/ltx-video-report-contract.mjs";
import {
  isTransientLtxOmission,
  ltxCandidateId,
  mergeLtxPlanForRepair,
  mergeLtxReportRowsForRepair,
  providerRetryDeadlineMs,
  providerRetryDelayMs,
  reportRowMatchesPlanClip,
} from "./lib/ltx-video-repair.mjs";

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
const revalidateExisting = boolFlag(flags["revalidate-existing"]);
const repairExisting = boolFlag(flags["repair-existing"]);
const operatorAuthorizedRetry = boolFlag(flags["operator-authorized-retry"]);
const preserveUntouchedSourceStable = boolFlag(flags["preserve-untouched-source-stable"]);
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

function serializedJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function atomicWriteJsonPair(firstPath, firstValue, secondPath, secondValue) {
  await Promise.all([
    fs.mkdir(path.dirname(firstPath), { recursive: true }),
    fs.mkdir(path.dirname(secondPath), { recursive: true }),
  ]);
  const token = `${process.pid}-${Date.now()}`;
  const firstTemporaryPath = `${firstPath}.tmp-${token}`;
  const secondTemporaryPath = `${secondPath}.tmp-${token}`;
  const [firstBackup, secondBackup] = await Promise.all([
    fs.readFile(firstPath).catch(() => null),
    fs.readFile(secondPath).catch(() => null),
  ]);
  await Promise.all([
    fs.writeFile(firstTemporaryPath, serializedJson(firstValue), "utf8"),
    fs.writeFile(secondTemporaryPath, serializedJson(secondValue), "utf8"),
  ]);
  let firstCommitted = false;
  try {
    await fs.rename(firstTemporaryPath, firstPath);
    firstCommitted = true;
    await fs.rename(secondTemporaryPath, secondPath);
  } catch (error) {
    if (firstCommitted) {
      const restorePath = `${firstPath}.restore-${token}`;
      if (firstBackup == null) {
        await fs.rm(firstPath, { force: true });
      } else {
        await fs.writeFile(restorePath, firstBackup);
        await fs.rename(restorePath, firstPath);
      }
    }
    if (secondBackup != null && await hashFile(secondPath) == null) {
      const restorePath = `${secondPath}.restore-${token}`;
      await fs.writeFile(restorePath, secondBackup);
      await fs.rename(restorePath, secondPath);
    }
    throw error;
  } finally {
    await Promise.all([
      fs.rm(firstTemporaryPath, { force: true }),
      fs.rm(secondTemporaryPath, { force: true }),
    ]);
  }
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function withoutCoverageTiming(coverage = []) {
  return coverage.map((row) => {
    const value = structuredClone(row);
    delete value.timeline_duration_sec;
    delete value.source_offset_sec;
    delete value.source_end_offset_sec;
    return value;
  });
}

function retimedCoverage(coverage = [], direction = {}) {
  const cutDurationSec = Number(direction.cut_duration_sec);
  return coverage.map((row) => ({
    ...row,
    timeline_duration_sec: cutDurationSec,
    source_offset_sec: 0,
    source_end_offset_sec: Number(cutDurationSec.toFixed(3)),
  }));
}

function assertExact(label, left, right, imageId) {
  if (!jsonEqual(left, right)) {
    throw new Error(`LTX zero-submit timing revalidation creative/hash mismatch for ${imageId}: ${label}.`);
  }
}

async function revalidateExistingLtx({ animationDirection }) {
  const [existingPlan, existingReport, existingPlanFileHash, existingReportFileHash] = await Promise.all([
    readJson(planPath, null),
    readJson(outputPath, null),
    hashFile(planPath),
    hashFile(outputPath),
  ]);
  if (existingPlan?.schema !== "goldflow_ltx23_video_plan_v1" || existingPlan?.status !== "passed") {
    throw new Error(`LTX zero-submit timing revalidation requires an existing passed plan: ${planPath}`);
  }
  if (existingReport?.schema !== "goldflow_ltx23_video_report_v1" || existingReport?.status !== "passed") {
    throw new Error(`LTX zero-submit timing revalidation requires an existing passed report: ${outputPath}`);
  }
  if (animationDirection?.schema !== "goldflow_animation_direction_plan_v1"
    || animationDirection?.status !== "passed"
    || animationDirection?.timing_revalidated_without_creative_replan !== true) {
    throw new Error(
      `LTX zero-submit timing revalidation requires a timing-revalidated animation direction plan: ${animationDirectionPath}`,
    );
  }
  const animationSourceEntries = Object.entries(animationDirection.source_hashes ?? {});
  if (!animationSourceEntries.length) {
    throw new Error("LTX zero-submit timing revalidation requires hash-bound animation source provenance.");
  }
  for (const [sourcePath, expectedHash] of animationSourceEntries) {
    if (!expectedHash || await hashFile(sourcePath) !== expectedHash) {
      throw new Error(`LTX zero-submit timing revalidation animation source hash mismatch: ${sourcePath}.`);
    }
  }
  if (existingReport.plan_sha256 !== existingPlanFileHash
    || existingPlan.plan_sha256 !== ltxPlanHash(existingPlan)
    || existingReport.plan_contract_sha256 !== ltxPlanHash(existingPlan)) {
    throw new Error("LTX zero-submit timing revalidation refused a stale or internally inconsistent baseline plan/report pair.");
  }
  if (existingPlan.provider !== LTX_VIDEO_PROVIDER
    || existingPlan.model_id !== LTX_VIDEO_MODEL_ID
    || existingReport.provider !== LTX_VIDEO_PROVIDER
    || existingReport.model_id !== LTX_VIDEO_MODEL_ID
    || existingPlan.resolution !== "16:9") {
    throw new Error("LTX zero-submit timing revalidation creative/hash mismatch: provider, model, or resolution changed.");
  }
  const planClips = Array.isArray(existingPlan.clips) ? existingPlan.clips : [];
  const reportClips = Array.isArray(existingReport.clips) ? existingReport.clips : [];
  const omittedClips = Array.isArray(existingReport.omitted_clips) ? existingReport.omitted_clips : [];
  const reportRows = [...reportClips, ...omittedClips];
  if (planClips.length !== reportRows.length
    || Number(existingReport.planned_count) !== reportRows.length
    || Number(existingReport.clip_count) !== reportClips.length
    || Number(existingReport.generated_count) !== reportClips.length
    || Number(existingReport.omitted_count) !== omittedClips.length
    || Number(existingReport.failed_count ?? 0) !== 0) {
    throw new Error("LTX zero-submit timing revalidation refused inconsistent historical clip counts.");
  }
  const directionById = new Map((animationDirection.directions ?? []).map((row) => [String(row.image_id ?? ""), row]));
  const planById = new Map();
  for (const clip of planClips) {
    const imageId = String(clip.image_id ?? "");
    if (!imageId || planById.has(imageId)) {
      throw new Error("LTX zero-submit timing revalidation requires unique non-empty plan image IDs.");
    }
    planById.set(imageId, clip);
  }
  const candidateIds = new Set();
  for (const row of reportRows) {
    const imageId = String(row.image_id ?? "");
    const candidateId = String(row.candidate_id ?? "");
    if (!planById.has(imageId) || candidateId !== `${imageId}-candidate-01` || candidateIds.has(candidateId)) {
      throw new Error(`LTX zero-submit timing revalidation candidate identity mismatch for ${imageId || "<missing>"}.`);
    }
    candidateIds.add(candidateId);
  }
  if (candidateIds.size !== planClips.length) {
    throw new Error("LTX zero-submit timing revalidation report rows do not exactly cover the historical plan.");
  }

  const retimedPlanClips = [];
  for (const clip of planClips) {
    const imageId = String(clip.image_id);
    const direction = directionById.get(imageId);
    if (!direction) throw new Error(`LTX zero-submit timing revalidation lost direction ${imageId}.`);
    assertExact("animation_sequence_id", clip.animation_sequence_id ?? null, direction.animation_sequence_id ?? null, imageId);
    assertExact("scene_id", clip.scene_id ?? null, direction.scene_id ?? null, imageId);
    assertExact("visual_beat_id", clip.visual_beat_id ?? null, direction.visual_beat_id ?? null, imageId);
    assertExact("sequence_mode", clip.sequence_mode ?? null, direction.sequence_mode ?? null, imageId);
    assertExact("source_image_path", clip.source_image_path ?? null, direction.source_image_path ?? null, imageId);
    assertExact("source_image_sha256", clip.source_image_sha256 ?? null, direction.source_image_sha256 ?? null, imageId);
    assertExact("source_prompt_sha256", clip.source_prompt_sha256 ?? null, direction.source_prompt_sha256 ?? null, imageId);
    assertExact("motion_prompt", clip.motion_prompt ?? null, direction.motion_prompt ?? null, imageId);
    assertExact("motion_prompt_sha256", clip.motion_prompt_sha256 ?? null, sha256(direction.motion_prompt ?? ""), imageId);
    assertExact("negative_prompt", clip.negative_prompt ?? null, direction.negative_prompt ?? null, imageId);
    assertExact("generation_duration", Number(clip.duration_sec), Number(direction.requested_generation_duration_sec), imageId);
    assertExact("start_frame_contract", clip.start_frame_contract ?? null, direction.start_frame_contract ?? null, imageId);
    assertExact("end_frame_contract", clip.end_frame_contract ?? null, direction.end_frame_contract ?? null, imageId);
    assertExact("provider_image_inputs", clip.provider_image_inputs ?? null, direction.provider_image_inputs ?? null, imageId);
    assertExact("candidate_count", Number(clip.candidate_count ?? 1), Number(direction.candidate_count ?? 1), imageId);
    assertExact(
      "coverage_creative_contract",
      withoutCoverageTiming(clip.coverage ?? []),
      withoutCoverageTiming(direction.coverage ?? []),
      imageId,
    );
    if (await hashFile(clip.source_image_path) !== clip.source_image_sha256) {
      throw new Error(`LTX zero-submit timing revalidation source-image hash mismatch for ${imageId}.`);
    }
    const cutDurationSec = Number(direction.cut_duration_sec);
    retimedPlanClips.push({
      ...clip,
      start_sec: Number(direction.start_sec),
      cut_duration_sec: cutDurationSec,
      sequence_timeline_duration_sec: Number(cutDurationSec.toFixed(3)),
      coverage: retimedCoverage(clip.coverage, direction),
    });
  }

  const reportByImageId = new Map(reportRows.map((row) => [String(row.image_id), row]));
  for (const clip of planClips) {
    const imageId = String(clip.image_id);
    const row = reportByImageId.get(imageId);
    for (const field of [
      "animation_sequence_id",
      "scene_id",
      "visual_beat_id",
      "sequence_mode",
      "source_image_path",
      "source_image_sha256",
      "source_prompt_sha256",
      "motion_prompt_sha256",
      "start_frame_contract",
      "end_frame_contract",
    ]) assertExact(`report_${field}`, row?.[field] ?? null, clip?.[field] ?? null, imageId);
    assertExact("report_generation_duration", Number(row?.requested_duration_sec), Number(clip.duration_sec), imageId);
    assertExact(
      "report_coverage_creative_contract",
      withoutCoverageTiming(row?.coverage ?? []),
      withoutCoverageTiming(clip.coverage ?? []),
      imageId,
    );
    if (row.status === "generated") {
      if (!row.request_id) throw new Error(`LTX zero-submit timing revalidation missing request ID for ${imageId}.`);
      if (!row.normalized_video_path || !row.normalized_video_sha256
        || await hashFile(row.normalized_video_path) !== row.normalized_video_sha256) {
        throw new Error(`LTX zero-submit timing revalidation normalized-video hash mismatch for ${imageId}.`);
      }
    } else if (row.status !== "omitted" || row.disposition !== LTX_SINGLE_SHOT_POLICY.unavailable_or_rejected_disposition) {
      throw new Error(`LTX zero-submit timing revalidation invalid omission contract for ${imageId}.`);
    }
  }

  const animationDirectionHash = await hashFile(animationDirectionPath);
  const sourceHashes = {
    ...animationDirection.source_hashes,
    [animationDirectionPath]: animationDirectionHash,
  };
  const revalidatedAt = new Date().toISOString();
  const nextPlan = {
    ...existingPlan,
    source_hashes: sourceHashes,
    clips: retimedPlanClips,
    timing_revalidated_without_provider_submission: true,
    timing_revalidated_at: revalidatedAt,
    generation_requests_submitted: 0,
    creative_resubmission_count: 0,
    updated_at: revalidatedAt,
  };
  nextPlan.plan_sha256 = ltxPlanHash(nextPlan);
  const serializedPlan = `${JSON.stringify(nextPlan, null, 2)}\n`;
  const nextPlanFileHash = sha256(serializedPlan);
  const retimeRow = (row) => {
    const direction = directionById.get(String(row.image_id));
    const cutDurationSec = Number(direction.cut_duration_sec);
    return {
      ...row,
      start_sec: Number(direction.start_sec),
      cut_duration_sec: cutDurationSec,
      sequence_timeline_duration_sec: Number(cutDurationSec.toFixed(3)),
      coverage: retimedCoverage(row.coverage, direction),
    };
  };
  const nextReport = {
    ...existingReport,
    plan_sha256: nextPlanFileHash,
    plan_contract_sha256: nextPlan.plan_sha256,
    source_hashes: sourceHashes,
    clips: reportClips.map(retimeRow),
    omitted_clips: omittedClips.map(retimeRow),
    timing_revalidated_without_provider_submission: true,
    timing_revalidated_at: revalidatedAt,
    timing_revalidated_from_report_sha256: existingReportFileHash,
    generation_requests_submitted: 0,
    creative_resubmission_count: 0,
    updated_at: revalidatedAt,
  };
  await fs.writeFile(planPath, serializedPlan, "utf8");
  await writeJson(outputPath, nextReport);
  console.log(JSON.stringify({
    status: nextReport.status,
    output_path: outputPath,
    plan_path: planPath,
    clip_count: nextReport.clip_count,
    omitted_count: nextReport.omitted_count,
    generation_requests_submitted: 0,
    creative_resubmission_count: 0,
    timing_revalidated_without_provider_submission: true,
  }, null, 2));
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
  return providerRetryDelayMs(message);
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

async function fetchExistingResult(requestId, account) {
  return postJson(
    `https://modelslab.com/api/v6/video/fetch/${requestId}`,
    {},
    { account, retries: 0 },
  );
}

async function waitForRecordedCooldown(row, fallbackTimestamp = null) {
  const cooldownDeadline = providerRetryDeadlineMs(row, fallbackTimestamp);
  if (cooldownDeadline == null) return;
  const cooldownMs = cooldownDeadline - Date.now();
  if (cooldownMs <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, cooldownMs));
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
      sequence_mode: "standalone_shot",
      coverage: [{
        image_id: imageId,
        image_sha256: actualHash,
        source_offset_sec: 0,
        source_end_offset_sec: Number(prompt.duration_sec ?? durationSec),
      }],
      provider_image_inputs: ["init_image"],
      candidate_count: LTX_SINGLE_SHOT_POLICY.candidates_per_motion_moment,
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
    provider_image_inputs: [...LTX_SINGLE_SHOT_POLICY.provider_image_inputs],
    automatic_generation_retries: LTX_SINGLE_SHOT_POLICY.automatic_generation_retries,
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

async function buildAnimationDirectionPlan(animationDirection) {
  if (animationDirection?.schema !== "goldflow_animation_direction_plan_v1" || animationDirection?.status !== "passed") {
    throw new Error(`Production LTX generation requires a passed animation direction plan: ${animationDirectionPath}`);
  }
  const clips = (animationDirection.directions ?? []).map((row) => {
    const coverage = row.coverage ?? [{
      image_id: row.image_id,
      image_sha256: row.source_image_sha256,
      source_offset_sec: 0,
      source_end_offset_sec: row.cut_duration_sec,
    }];
    if (row.sequence_mode !== "standalone_shot" || coverage.length !== 1
      || String(coverage[0]?.image_id ?? "") !== String(row.image_id ?? "")) {
      throw new Error(
        `LTX direction ${row.image_id} violates the one-init-image/one-reachable-shot production contract.`,
      );
    }
    if (!String(row.start_frame_contract?.state ?? "").trim()
      || !String(row.end_frame_contract?.state ?? "").trim()
      || !String(row.end_frame_contract?.camera_state ?? "").trim()
      || !String(row.end_frame_contract?.composition ?? "").trim()
      || !String(row.end_frame_contract?.continuity_bridge ?? "").trim()) {
      throw new Error(`LTX direction ${row.image_id} is missing its explicit single-shot terminal contract.`);
    }
    return {
      image_id: row.image_id,
      scene_id: row.scene_id,
      visual_beat_id: row.visual_beat_id,
      start_sec: row.start_sec,
      cut_duration_sec: row.cut_duration_sec,
      duration_sec: row.requested_generation_duration_sec,
      animation_sequence_id: row.animation_sequence_id ?? null,
      sequence_mode: "standalone_shot",
      sequence_timeline_duration_sec: row.cut_duration_sec,
      coverage,
      start_frame_contract: row.start_frame_contract,
      end_frame_contract: row.end_frame_contract,
      provider_image_inputs: ["init_image"],
      source_image_path: row.source_image_path,
      source_image_sha256: row.source_image_sha256,
      source_prompt_sha256: row.source_prompt_sha256,
      motion_prompt: row.motion_prompt,
      motion_prompt_sha256: sha256(row.motion_prompt),
      negative_prompt: row.negative_prompt,
      candidate_count: LTX_SINGLE_SHOT_POLICY.candidates_per_motion_moment,
    };
  });
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
    provider_image_inputs: [...LTX_SINGLE_SHOT_POLICY.provider_image_inputs],
    automatic_generation_retries: LTX_SINGLE_SHOT_POLICY.automatic_generation_retries,
    animation_direction_plan_path: animationDirectionPath,
    source_hashes: { ...animationDirection.source_hashes, [animationDirectionPath]: await hashFile(animationDirectionPath) },
    clip_count: clips.length,
    clips,
    updated_at: new Date().toISOString(),
  };
  plan.plan_sha256 = ltxPlanHash(plan);
  return plan;
}

function selectPlanClips(plan, requestedIds) {
  const explicit = new Set(requestedIds);
  if (!explicit.size) return plan;
  const clips = (plan.clips ?? []).filter((row) => explicit.has(String(row.image_id)));
  if (clips.length !== explicit.size) {
    throw new Error("One or more requested --cut-ids are absent from the animation direction plan.");
  }
  const selected = { ...plan, clips, clip_count: clips.length, updated_at: new Date().toISOString() };
  selected.plan_sha256 = ltxPlanHash(selected);
  return selected;
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

function reportRows(report = {}) {
  return [...(report.clips ?? []), ...(report.omitted_clips ?? [])];
}

async function loadRepairBaseline(freshPlan, scopeIds) {
  const [priorPlan, priorReport, priorPlanFileHash, priorReportFileHash] = await Promise.all([
    readJson(planPath, null),
    readJson(outputPath, null),
    hashFile(planPath),
    hashFile(outputPath),
  ]);
  if (priorPlan?.schema !== "goldflow_ltx23_video_plan_v1" || priorPlan?.status !== "passed") {
    throw new Error(`Scoped LTX repair requires the existing passed canonical plan: ${planPath}`);
  }
  if (priorReport?.schema !== "goldflow_ltx23_video_report_v1" || priorReport?.status !== "passed") {
    throw new Error(`Scoped LTX repair requires the existing passed canonical report: ${outputPath}`);
  }
  if (priorReport.plan_sha256 !== priorPlanFileHash
    || priorPlan.plan_sha256 !== ltxPlanHash(priorPlan)
    || priorReport.plan_contract_sha256 !== priorPlan.plan_sha256) {
    throw new Error("Scoped LTX repair refused a stale or internally inconsistent canonical plan/report pair.");
  }
  const freshSourceEntries = Object.entries(freshPlan.source_hashes ?? {});
  if (!freshSourceEntries.length) throw new Error("Scoped LTX repair requires current animation-plan source provenance.");
  for (const [sourcePath, expectedHash] of freshSourceEntries) {
    if (!expectedHash || await hashFile(sourcePath) !== expectedHash) {
      throw new Error(`Scoped LTX repair animation source hash is missing or stale: ${sourcePath}.`);
    }
  }
  const priorRows = reportRows(priorReport);
  const priorIds = new Set(priorRows.map((row) => String(row.image_id ?? "")));
  if (priorIds.size !== priorRows.length) throw new Error("Scoped LTX repair refused duplicate prior report image IDs.");
  const plan = mergeLtxPlanForRepair({
    freshPlan,
    priorPlan,
    scopeIds,
    preserveUntouchedSourceStable,
  });
  plan.plan_sha256 = ltxPlanHash(plan);
  for (const clip of plan.clips ?? []) {
    if (!clip.source_image_path || await hashFile(clip.source_image_path) !== clip.source_image_sha256) {
      throw new Error(`Scoped LTX repair source image is missing or stale for ${clip.image_id}.`);
    }
  }
  const scope = scopeIds instanceof Set ? scopeIds : new Set(scopeIds);
  for (const row of priorRows) {
    if (scope.has(String(row.image_id ?? ""))) continue;
    if (row.status === "generated"
      && (!row.normalized_video_path
        || await hashFile(row.normalized_video_path) !== row.normalized_video_sha256)) {
      throw new Error(`Untouched LTX video is missing or stale outside repair scope: ${row.image_id}.`);
    }
  }
  return { plan, priorPlan, priorReport, priorPlanFileHash, priorReportFileHash };
}

function reboundGeneratedRow(prior, clip) {
  if (reportRowMatchesPlanClip(prior, clip)) return prior;
  return {
    ...prior,
    image_id: clip.image_id,
    scene_id: clip.scene_id ?? null,
    visual_beat_id: clip.visual_beat_id ?? null,
    start_sec: clip.start_sec,
    cut_duration_sec: clip.cut_duration_sec,
    requested_duration_sec: clip.duration_sec,
    animation_sequence_id: clip.animation_sequence_id ?? null,
    sequence_mode: clip.sequence_mode ?? "standalone_shot",
    sequence_timeline_duration_sec: clip.sequence_timeline_duration_sec ?? clip.cut_duration_sec,
    coverage: clip.coverage ?? null,
    start_frame_contract: clip.start_frame_contract ?? null,
    end_frame_contract: clip.end_frame_contract ?? null,
    source_image_path: clip.source_image_path,
    source_image_sha256: clip.source_image_sha256,
    source_prompt_sha256: clip.source_prompt_sha256,
    motion_prompt_sha256: clip.motion_prompt_sha256,
  };
}

function sameCreativeContract(row, clip) {
  return row?.source_image_sha256 === clip.source_image_sha256
    && row?.source_prompt_sha256 === clip.source_prompt_sha256
    && row?.motion_prompt_sha256 === clip.motion_prompt_sha256
    && Number(row?.requested_duration_sec) === Number(clip.duration_sec)
    && jsonEqual(row?.start_frame_contract ?? null, clip.start_frame_contract ?? null)
    && jsonEqual(row?.end_frame_contract ?? null, clip.end_frame_contract ?? null);
}

function setTransientOmissionMetadata(row) {
  const retryAfterMs = providerRetryDelayMs(row.error);
  row.retryable_transient = isTransientLtxOmission(row);
  row.retry_after_ms = retryAfterMs;
  row.omitted_at = new Date().toISOString();
  row.cooldown_until = retryAfterMs == null
    ? null
    : new Date(Date.now() + retryAfterMs).toISOString();
}

function omitRow(row, stage, error) {
  row.status = "omitted";
  row.omission_stage = stage;
  row.disposition = LTX_SINGLE_SHOT_POLICY.unavailable_or_rejected_disposition;
  row.error = error instanceof Error ? error.message : String(error);
  delete row.init_image_url;
  delete row.download_url;
  delete row.initial_provider_result;
  setTransientOmissionMetadata(row);
}

function versionedMediaPaths(row) {
  const sourceVersion = String(row.source_image_sha256 ?? "unknown").slice(0, 12);
  const attemptVersion = String(Math.max(1, Number(row.creative_generation_attempt ?? 1))).padStart(2, "0");
  const version = `${sourceVersion}-a${attemptVersion}`;
  return {
    rawPath: path.join(outputDir, "raw", `${row.candidate_id}-${version}-ltx23.mp4`),
    normalizedPath: path.join(outputDir, "normalized", `${row.candidate_id}-${version}-ltx23-1920x1080.mp4`),
  };
}

async function materializeProviderResult(row, result, startedAtMs) {
  row.provider_generation_time_sec = result.generationTime ?? null;
  const { rawPath, normalizedPath } = versionedMediaPaths(row);
  row.download_url = await downloadResult(result, rawPath);
  row.raw_video_path = rawPath;
  row.raw_video_sha256 = await hashFile(rawPath);
  row.raw_probe = await probeVideo(rawPath);
  row.normalized_probe = await normalizeVideo(rawPath, normalizedPath, row.duration_sec);
  row.normalized_video_path = normalizedPath;
  row.normalized_video_sha256 = await hashFile(normalizedPath);
  row.wall_time_sec = Number(((Date.now() - startedAtMs) / 1000).toFixed(3));
  row.status = "generated";
  delete row.init_image_url;
  delete row.download_url;
  delete row.initial_provider_result;
}

async function main() {
  if (repairExisting && (proof || revalidateExisting)) {
    throw new Error("--repair-existing is production-only and cannot be combined with proof or timing revalidation.");
  }
  const repairScope = new Set(requestedCutIds());
  if (repairExisting && !repairScope.size) {
    throw new Error("--repair-existing requires exact --cut-ids or --image-ids scope.");
  }
  if (!proof && !repairExisting && repairScope.size) {
    throw new Error(
      "Production --cut-ids/--image-ids are a scoped repair operation. Add --repair-existing true so canonical full-plan rows are merged instead of truncated.",
    );
  }
  const [promptPlan, imagegenReport, imageQa, identity, animationDirection] = await Promise.all([
    readJson(promptPath),
    readJson(imagegenReportPath),
    readJson(imageQaPath),
    readJson(identityPath, {}),
    readJson(animationDirectionPath, null),
  ]);
  if (revalidateExisting) {
    await revalidateExistingLtx({ animationDirection });
    return;
  }
  if (!proof && !repairExisting) {
    const existingCanonical = await readJson(outputPath, null);
    if (existingCanonical?.schema === "goldflow_ltx23_video_report_v1" && existingCanonical?.status === "passed") {
      throw new Error(
        "A passed canonical LTX report already exists. Production reruns must use exact --cut-ids with --repair-existing true.",
      );
    }
  }
  let plan;
  let priorPlan = null;
  let priorReport = null;
  let priorPlanFileHash = null;
  let priorReportFileHash = null;
  const explicitProofDirection = proof && workflowBypass && Boolean(flags["animation-direction-plan"]);
  if ((!proof && ltxVideoEnabled(identity)) || explicitProofDirection) {
    const fullPlan = await buildAnimationDirectionPlan(animationDirection);
    if (repairExisting) {
      ({ plan, priorPlan, priorReport, priorPlanFileHash, priorReportFileHash } = await loadRepairBaseline(fullPlan, repairScope));
    } else {
      plan = selectPlanClips(fullPlan, requestedCutIds());
    }
  } else {
    if (repairExisting) throw new Error("Scoped LTX repair requires an enabled production animation policy.");
    plan = await buildPlan({ promptPlan, imagegenReport, imageQa, identity });
  }

  const modelslabAccounts = await loadConfiguredModelslabAccounts(modelslabProfiles, { cwd: repoRoot });
  const accountByProfile = new Map(modelslabAccounts.map((account) => [account.profile, account]));
  if (!repairExisting) await writeJson(planPath, plan);
  await fs.mkdir(path.join(outputDir, "raw"), { recursive: true });
  await fs.mkdir(path.join(outputDir, "normalized"), { recursive: true });

  const priorRowsById = new Map(reportRows(priorReport ?? {}).map((row) => [String(row.image_id ?? ""), row]));
  const workClips = repairExisting
    ? (plan.clips ?? []).filter((clip) => repairScope.has(String(clip.image_id ?? "")))
    : (plan.clips ?? []);
  const rows = [];
  for (const clip of workClips) {
    const prior = priorRowsById.get(String(clip.image_id ?? "")) ?? null;
    const candidateId = ltxCandidateId(clip.image_id);
    if (repairExisting && prior?.status === "generated" && sameCreativeContract(prior, clip)) {
      if (!prior.normalized_video_path || await hashFile(prior.normalized_video_path) !== prior.normalized_video_sha256) {
        throw new Error(`Scoped LTX repair cannot preserve stale generated media for ${clip.image_id}.`);
      }
      const publicRow = reboundGeneratedRow(prior, clip);
      if (!reportRowMatchesPlanClip(publicRow, clip)) {
        throw new Error(`Scoped LTX repair could not safely rebind the prior generated clip for ${clip.image_id}.`);
      }
      rows.push({ ...clip, candidate_id: candidateId, status: "preserved_generated", _public_row: publicRow });
      continue;
    }
    const sameContractOmission = repairExisting && prior?.status === "omitted" && sameCreativeContract(prior, clip);
    const priorCreativeRequestAttempted = sameContractOmission && (
      Boolean(prior.request_id)
      || Number(prior.provider_request_attempt ?? 0) > 0
      || ["creative_generation_submission", "provider_result_or_normalization", "existing_request_resume"]
        .includes(String(prior.omission_stage ?? ""))
    );
    if (priorCreativeRequestAttempted && !operatorAuthorizedRetry) {
      throw new Error(
        `LTX cut ${clip.image_id} already consumed its creative submission. Exact retry requires --operator-authorized-retry true.`,
      );
    }
    if (priorCreativeRequestAttempted && !isTransientLtxOmission(prior)) {
      throw new Error(`LTX cut ${clip.image_id} is not a transient provider omission and cannot use the retry route.`);
    }
    const previousAttempt = Math.max(0, Number(prior?.creative_generation_attempt ?? 0));
    const changedSource = Boolean(prior && prior.source_image_sha256 !== clip.source_image_sha256);
    const resumeExisting = priorCreativeRequestAttempted && Boolean(prior.request_id);
    const creativeGenerationAttempt = resumeExisting
      ? Math.max(1, previousAttempt)
      : (changedSource || !prior
          ? 1
          : (sameContractOmission && !priorCreativeRequestAttempted
              ? Math.max(1, previousAttempt)
              : Math.max(1, previousAttempt + 1)));
    rows.push({
      ...clip,
      candidate_count: LTX_SINGLE_SHOT_POLICY.candidates_per_motion_moment,
      candidate_index: 1,
      candidate_id: candidateId,
      creative_generation_attempt: creativeGenerationAttempt,
      provider_request_attempt: Math.max(0, Number(prior?.provider_request_attempt ?? previousAttempt)),
      automatic_generation_retry_allowed: false,
      operator_authorized_retry: priorCreativeRequestAttempted,
      retry_of_error: sameContractOmission ? prior.error ?? null : null,
      request_id: resumeExisting ? prior.request_id : null,
      resumed_existing_request: resumeExisting,
      _prior_row: prior,
      _prior_report_updated_at: priorReport?.updated_at ?? null,
      status: resumeExisting ? "resume_pending" : "planned",
    });
  }
  for (const row of rows) {
    if (row.status === "preserved_generated") continue;
    if (row.status === "resume_pending") {
      const fingerprint = String(row._prior_row?.modelslab_account_fingerprint ?? "").trim();
      if (!fingerprint) {
        throw new Error(`Cannot resume LTX request ${row.request_id} without its persisted ModelsLab account fingerprint.`);
      }
      row.modelslab_account = modelslabAccounts.find((account) => account.fingerprint === fingerprint) ?? null;
      if (!row.modelslab_account) {
        throw new Error(
          `Cannot resume LTX request ${row.request_id}: its persisted ModelsLab account is not among the configured accounts.`,
        );
      }
    } else {
      const profile = modelslabProfileForWorkId(row.candidate_id, modelslabProfiles);
      row.modelslab_account = accountByProfile.get(profile);
    }
    if (!row.modelslab_account) throw new Error("The assigned ModelsLab account was not loaded.");
  }

  const batchStartedMs = Date.now();
  let providerRequestAttemptCount = 0;
  let creativeResubmissionCount = 0;
  let resumedExistingRequestCount = 0;

  const resumeRows = rows.filter((row) => row.status === "resume_pending");
  await runLimited(resumeRows, concurrency, async (row) => {
    const startedAtMs = Date.now();
    row.request_started_at = new Date(startedAtMs).toISOString();
    await waitForRecordedCooldown(row._prior_row, row._prior_report_updated_at);
    try {
      const fetched = await fetchExistingResult(row.request_id, row.modelslab_account);
      const result = fetched.status === "success" && responseUrls(fetched).length
        ? fetched
        : await pollResult(row.request_id, Date.now(), row.modelslab_account);
      resumedExistingRequestCount += 1;
      await materializeProviderResult(row, result, startedAtMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const confirmedTerminal = /ModelsLab\s+(?:404|410)\b|ModelsLab\s+\d+:.*"status":"(?:error|failed)"/i.test(message);
      if (confirmedTerminal) {
        row.prior_request_id = row.request_id;
        row.request_id = null;
        row.resumed_existing_request = true;
        row.confirmed_terminal_prior_request = true;
        row.creative_generation_attempt = Math.max(1, Number(row.creative_generation_attempt ?? 1) + 1);
        row.status = "planned";
      } else {
        omitRow(row, "existing_request_resume", error);
      }
    }
  });

  const plannedRows = rows.filter((row) => row.status === "planned");
  await runLimited(plannedRows, concurrency, async (row) => {
    row.upload_started_at = new Date().toISOString();
    await waitForRecordedCooldown(row._prior_row, row._prior_report_updated_at);
    try {
      row.init_image_url = await uploadImage(row.source_image_path, row.modelslab_account);
      row.upload_elapsed_ms = Date.now() - Date.parse(row.upload_started_at);
      row.status = "uploaded";
    } catch (error) {
      omitRow(row, "init_image_upload", error);
    }
  });
  const uploadedRows = rows.filter((row) => row.status === "uploaded");
  await runLimited(uploadedRows, concurrency, async (row) => {
    const startedAtMs = Date.now();
    row.request_started_at = new Date(startedAtMs).toISOString();
    row.provider_request_attempt = Math.max(0, Number(row.provider_request_attempt ?? 0)) + 1;
    providerRequestAttemptCount += 1;
    const creativeRetry = Boolean(row.operator_authorized_retry || row.confirmed_terminal_prior_request);
    if (creativeRetry) creativeResubmissionCount += 1;
    try {
      const initial = await postJson(
        "https://modelslab.com/api/v6/video/img2video_ultra",
        ltxProviderPayloadForClip(row, {
          trackId: `goldflow-${episode}-${row.image_id}-${String(row.source_image_sha256).slice(0, 12)}-a${row.creative_generation_attempt}`,
        }),
        {
          account: row.modelslab_account,
          retries: LTX_SINGLE_SHOT_POLICY.automatic_generation_retries,
          rateLimitRetries: 0,
        },
      );
      row.request_id = initial.id ?? null;
      row.initial_eta_sec = initial.eta ?? null;
      row.submit_latency_ms = Date.now() - startedAtMs;
      row.status = String(initial.status ?? "processing");
      row.initial_provider_result = initial;
      row.initial_response = {
        status: initial.status ?? null,
        id: initial.id ?? null,
        eta: initial.eta ?? null,
        message: initial.message ?? null,
      };
    } catch (error) {
      omitRow(row, "creative_generation_submission", error);
    }
  });
  const submittedRows = rows.filter((row) => row.status !== "generated"
    && row.status !== "omitted"
    && (row.request_id || row.status === "success"));
  await runLimited(submittedRows, concurrency, async (row) => {
    const startedAtMs = Date.parse(row.request_started_at);
    try {
      const result = row.status === "success" && responseUrls(row.initial_provider_result).length
        ? row.initial_provider_result
        : await pollResult(row.request_id, startedAtMs, row.modelslab_account);
      await materializeProviderResult(row, result, startedAtMs);
    } catch (error) {
      omitRow(row, "provider_result_or_normalization", error);
    }
  });

  const scopedPublicRows = rows.map((row) => row._public_row
    ?? publicLtxClipResult(row, { accountProfiles: modelslabProfiles }));
  const merged = repairExisting
    ? mergeLtxReportRowsForRepair({
        mergedPlan: plan,
        priorReport,
        scopeIds: repairScope,
        scopedRows: scopedPublicRows,
      })
    : {
        rows: scopedPublicRows,
        generated: scopedPublicRows.filter((row) => row.status === "generated"),
        omitted: scopedPublicRows.filter((row) => row.status !== "generated"),
      };
  const completed = merged.generated;
  const omitted = merged.omitted;
  const repairedAt = new Date().toISOString();
  const repairSheetToken = repairedAt.replace(/[^0-9]/g, "");
  const sheetPath = path.join(outputDir, repairExisting
    ? `ltx_video_contact_sheet_${episode}-repair-${repairSheetToken}.jpg`
    : `ltx_video_contact_sheet_${episode}${proof ? `-${proofLabel}` : ""}.jpg`);
  if (completed.length) await contactSheet(completed, sheetPath);
  if (repairExisting) {
    plan.repair_history = [
      ...(priorPlan.repair_history ?? []),
      {
        repaired_at: repairedAt,
        prior_plan_sha256: priorPlanFileHash,
        prior_report_sha256: priorReportFileHash,
        exact_cut_ids: [...repairScope],
        operator_authorized_retry: operatorAuthorizedRetry,
        provider_request_attempt_count: providerRequestAttemptCount,
        creative_resubmission_count: creativeResubmissionCount,
        resumed_existing_request_count: resumedExistingRequestCount,
      },
    ];
  }
  plan.updated_at = repairedAt;
  plan.plan_sha256 = ltxPlanHash(plan);
  const nextPlanFileHash = sha256(serializedJson(plan));
  const priorSubmissionCount = repairExisting ? Number(priorReport.creative_submission_count ?? 0) : 0;
  const priorResubmissionCount = repairExisting ? Number(priorReport.creative_resubmission_count ?? 0) : 0;
  const priorProviderAttemptCount = repairExisting ? Number(priorReport.provider_request_attempt_count ?? priorSubmissionCount) : 0;
  const report = {
    ...(repairExisting ? priorReport : {}),
    schema: "goldflow_ltx23_video_report_v1",
    status: "passed",
    channel,
    series_slug: series,
    week,
    episode,
    proof,
    proof_label: proof ? proofLabel : null,
    provider: LTX_VIDEO_PROVIDER,
    model_id: LTX_VIDEO_MODEL_ID,
    plan_path: planPath,
    plan_sha256: nextPlanFileHash,
    plan_contract_sha256: plan.plan_sha256,
    source_hashes: plan.source_hashes,
    requested_concurrency: concurrency,
    provider_image_inputs: [...LTX_SINGLE_SHOT_POLICY.provider_image_inputs],
    candidate_policy: "one_candidate_per_motion_moment",
    automatic_generation_retries: LTX_SINGLE_SHOT_POLICY.automatic_generation_retries,
    modelslab_account_pool: publicLtxModelslabAccountPool(modelslabAccounts),
    planned_count: merged.rows.length,
    attempted_count: merged.rows.filter((row) => Number(row.creative_generation_attempt ?? 0) > 0).length,
    creative_submission_count: priorSubmissionCount + providerRequestAttemptCount,
    provider_request_attempt_count: priorProviderAttemptCount + providerRequestAttemptCount,
    generation_requests_submitted: providerRequestAttemptCount,
    creative_resubmission_count: priorResubmissionCount + creativeResubmissionCount,
    operator_authorized_retry_count: (repairExisting ? Number(priorReport.operator_authorized_retry_count ?? 0) : 0)
      + rows.filter((row) => row.operator_authorized_retry).length,
    resumed_existing_request_count: (repairExisting ? Number(priorReport.resumed_existing_request_count ?? 0) : 0)
      + resumedExistingRequestCount,
    clip_count: completed.length,
    generated_count: completed.length,
    failed_count: 0,
    omitted_count: omitted.length,
    omitted_disposition: LTX_SINGLE_SHOT_POLICY.unavailable_or_rejected_disposition,
    batch_wall_time_sec: Number(((Date.now() - batchStartedMs) / 1000).toFixed(3)),
    contact_sheet_path: completed.length ? sheetPath : null,
    clips: completed,
    omitted_clips: omitted,
    timing_revalidated_without_provider_submission: false,
    timing_revalidated_at: null,
    timing_revalidated_from_report_sha256: null,
    repair_history: repairExisting
      ? [
          ...(priorReport.repair_history ?? []),
          {
            repaired_at: repairedAt,
            prior_plan_sha256: priorPlanFileHash,
            prior_report_sha256: priorReportFileHash,
            exact_cut_ids: [...repairScope],
            operator_authorized_retry: operatorAuthorizedRetry,
            provider_request_attempt_count: providerRequestAttemptCount,
            creative_resubmission_count: creativeResubmissionCount,
            resumed_existing_request_count: resumedExistingRequestCount,
            generated_count: completed.length,
            omitted_count: omitted.length,
          },
        ]
      : [],
    updated_at: repairedAt,
  };
  await atomicWriteJsonPair(planPath, plan, outputPath, report);
  console.log(JSON.stringify({
    status: report.status,
    output_path: outputPath,
    plan_path: planPath,
    contact_sheet_path: report.contact_sheet_path,
    clip_count: report.clip_count,
    generated_count: report.generated_count,
    failed_count: report.failed_count,
    omitted_count: report.omitted_count,
    generation_requests_submitted: report.generation_requests_submitted,
    creative_resubmission_count: report.creative_resubmission_count,
    repaired_cut_ids: repairExisting ? [...repairScope] : [],
    batch_wall_time_sec: report.batch_wall_time_sec,
  }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (!revalidateExisting && !repairExisting) {
      const existingCanonical = await readJson(outputPath, null).catch(() => null);
      if (existingCanonical?.status !== "passed") {
        await writeJson(outputPath, {
          schema: "goldflow_ltx23_video_report_v1",
          status: "failed",
          error: redactLtxAccountProfileNames(errorMessage, modelslabProfiles),
          updated_at: new Date().toISOString(),
        }).catch(() => {});
      }
    }
    console.error(errorMessage);
    process.exitCode = 1;
  });
}
