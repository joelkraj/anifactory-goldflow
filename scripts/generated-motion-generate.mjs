#!/usr/bin/env node

import { execFile as execFileCallback, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  GENERATED_MOTION_PLAN_SCHEMA,
  GENERATED_MOTION_PROVIDER_FLOW,
  GENERATED_MOTION_PROVIDER_LTX,
  GENERATED_MOTION_REPORT_SCHEMA,
  clampGeneratedMotionDuration,
  generatedMotionArtifactPaths,
  generatedMotionEnabled,
  generatedMotionDirectionContractSha256,
  generatedMotionIdentityContract,
} from "./lib/generated-motion-contract.mjs";
import { buildGeneratedMotionCoherenceAudit } from "./lib/generated-motion-coherence-audit.mjs";
import { hashFile, sha256 } from "./lib/ltx-video-contract.mjs";

const execFile = promisify(execFileCallback);
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeDir = path.resolve(flags["episode-dir"] ?? path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode));
const identityPath = path.resolve(flags["run-identity"] ?? path.join(episodeDir, "run_identity.json"));
const directionPath = path.resolve(flags["animation-direction-plan"] ?? path.join(episodeDir, `animation_direction_plan_${episode}.json`));
const defaults = generatedMotionArtifactPaths(episodeDir, episode);
const outputDir = path.resolve(flags["output-dir"] ?? defaults.motionDir);
const planPath = path.resolve(flags.plan ?? path.join(outputDir, path.basename(defaults.planPath)));
const reportPath = path.resolve(flags.output ?? path.join(outputDir, path.basename(defaults.reportPath)));
const studioUrl = String(flags["studio-url"] ?? process.env.GOLDFLOW_FLOW_STUDIO_URL ?? "http://127.0.0.1:4318").replace(/\/+$/, "");
const timeoutMs = boundedInteger(flags["timeout-ms"], 7_200_000, 60_000, 14_400_000);
const pollMs = boundedInteger(flags["poll-ms"], 1_000, 250, 10_000);
const concurrency = boundedInteger(flags.concurrency, 3, 1, 5);
const submissionConcurrency = boundedInteger(flags["submission-concurrency"], concurrency, 1, 8);
const providerWaitConcurrency = boundedInteger(flags["provider-wait-concurrency"], concurrency, 1, 8);
const normalizationConcurrency = boundedInteger(flags["normalization-concurrency"], concurrency, 1, 8);
const repairReason = String(flags["repair-reason"] ?? "").trim();
const prefetchCoherenceCache = /^(true|1|yes)$/i.test(String(flags["prefetch-coherence-cache"] ?? "false"));

function parseFlags(parts) {
  const parsed = {};
  for (let index = 0; index < parts.length; index += 1) {
    const token = parts[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--") ? parts[++index] : "true";
    parsed[key] = value;
  }
  return parsed;
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? Math.round(parsed) : fallback));
}

function requestedCutIds() {
  return [...new Set(String(flags["cut-ids"] ?? flags["image-ids"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean))];
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

function planHash(plan) {
  const { plan_sha256: ignored, updated_at: ignoredAt, ...stable } = plan;
  return sha256(JSON.stringify(stable));
}

async function probeVideo(filePath) {
  const { stdout } = await execFile("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration,size",
    "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,pix_fmt",
    "-of", "json",
    filePath,
  ], { maxBuffer: 8 * 1024 * 1024 });
  const value = JSON.parse(stdout);
  const video = (value.streams ?? []).find((row) => row.codec_type === "video");
  const [numerator, denominator] = String(video?.r_frame_rate ?? "0/1").split("/").map(Number);
  return {
    duration_sec: Number(value.format?.duration ?? 0),
    size_bytes: Number(value.format?.size ?? 0),
    width: Number(video?.width ?? 0),
    height: Number(video?.height ?? 0),
    fps: denominator ? Number((numerator / denominator).toFixed(6)) : 0,
    video_codec: video?.codec_name ?? null,
    pixel_format: video?.pix_fmt ?? null,
    has_audio: (value.streams ?? []).some((row) => row.codec_type === "audio"),
  };
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
  ], { maxBuffer: 32 * 1024 * 1024 });
  return probeVideo(outputPath);
}

async function runLimited(rows, limit, worker) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, rows.length) }, async () => {
    while (cursor < rows.length) {
      const index = cursor;
      cursor += 1;
      await worker(rows[index], index);
    }
  }));
}

function boundedWorkerQueue(limit, worker) {
  const pending = [];
  let active = 0;
  const pump = () => {
    while (active < Math.max(1, limit) && pending.length) {
      const entry = pending.shift();
      active += 1;
      Promise.resolve()
        .then(() => worker(entry.value, entry.index))
        .then(entry.resolve, entry.reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };
  return {
    push(value, index) {
      return new Promise((resolve, reject) => {
        pending.push({ value, index, resolve, reject });
        pump();
      });
    },
  };
}

export async function runGeneratedMotionPipelineForTests({
  rows = [],
  submissionConcurrency: submitLimit = 1,
  providerWaitConcurrency: waitLimit = 1,
  normalizationConcurrency: normalizeLimit = 1,
  submit,
  wait,
  normalize,
} = {}) {
  const results = new Array(rows.length);
  const failures = [];
  const waitPromises = [];
  const normalizationPromises = [];
  const normalizationQueue = boundedWorkerQueue(normalizeLimit, normalize);
  const waitQueue = boundedWorkerQueue(waitLimit, wait);
  await runLimited(rows, submitLimit, async (row, index) => {
    let submitted;
    try {
      submitted = await submit(row, index);
    } catch (error) {
      failures.push({ row, index, stage: "submission", error });
      return;
    }
    waitPromises.push(waitQueue.push(submitted, index)
      .then((completed) => {
        normalizationPromises.push(normalizationQueue.push(completed, index)
          .then((value) => { results[index] = value; })
          .catch((error) => { failures.push({ row, index, stage: "normalization", value: completed, error }); }));
      })
      .catch((error) => { failures.push({ row, index, stage: "provider_wait", value: submitted, error }); }));
  });
  await Promise.all(waitPromises);
  await Promise.all(normalizationPromises);
  return {
    results: results.filter((value) => value !== undefined),
    failures: failures.sort((left, right) => left.index - right.index),
  };
}

function forwardLegacyLtx() {
  const child = spawn(process.execPath, [path.join(repoRoot, "scripts", "ltx-video-generate.mjs"), ...process.argv.slice(2)], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

async function studioAdminToken() {
  const explicit = String(flags["studio-token"] ?? process.env.GOLDFLOW_FLOW_STUDIO_TOKEN ?? "").trim();
  if (explicit) return explicit;
  const response = await fetch(`${studioUrl}/app-config.js`);
  if (!response.ok) throw new Error(`Flow Studio app-config returned HTTP ${response.status}.`);
  const source = await response.text();
  const match = source.match(/window\.GOLDFLOW_STUDIO_CONFIG=(\{[\s\S]*\});\s*$/);
  if (!match) throw new Error("Flow Studio did not expose its local dashboard configuration.");
  return String(JSON.parse(match[1]).adminToken ?? "");
}

async function studioRequest(route, token, { method = "GET", body = null } = {}) {
  const response = await fetch(`${studioUrl}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : null,
  });
  const value = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) {
    const error = new Error(value.error ?? `Flow Studio request ${route} failed with HTTP ${response.status}.`);
    error.code = value.code ?? "flow_studio_request_failed";
    throw error;
  }
  return value;
}

async function waitForMediaJob(jobId, token) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await studioRequest(`/v1/media/jobs/${jobId}`, token);
    const job = response.job;
    if (job?.status === "completed") return job;
    if (["failed", "needs_triage"].includes(job?.status)) {
      const error = new Error(job.error?.message ?? `Flow Studio media job ${jobId} ended as ${job?.status}.`);
      error.code = job.error?.code ?? job?.status;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Timed out waiting for Flow Studio media job ${jobId}; the durable job remains queued or leased.`);
}

export function selectGeneratedMotionDirections(directions = [], identityContract = {}, explicitIds = new Set()) {
  if (explicitIds.size) return directions.filter((row) => explicitIds.has(String(row.image_id)));
  const requiredThroughSec = Number(identityContract.required_through_sec ?? 0);
  if (Number.isFinite(requiredThroughSec) && requiredThroughSec > 0) {
    return directions.filter((row) => Number(row.start_sec ?? 0) < requiredThroughSec);
  }
  return directions;
}

function buildPlan(directionPlan, identityContract) {
  const explicitIds = new Set(requestedCutIds());
  const directions = directionPlan.directions ?? [];
  const selected = selectGeneratedMotionDirections(directions, identityContract, explicitIds);
  if (explicitIds.size && selected.length !== explicitIds.size) {
    throw new Error("One or more requested --cut-ids are absent from the animation direction plan.");
  }
  const clips = selected.map((direction) => ({
    image_id: String(direction.image_id),
    candidate_id: `${direction.image_id}-candidate-01`,
    scene_id: direction.scene_id ?? null,
    visual_beat_id: direction.visual_beat_id ?? null,
    start_sec: Number(direction.start_sec ?? 0),
    cut_duration_sec: Number(direction.cut_duration_sec ?? 0),
    requested_duration_sec: clampGeneratedMotionDuration(direction.requested_generation_duration_sec, identityContract.provider),
    animation_sequence_id: direction.animation_sequence_id ?? null,
    sequence_mode: "standalone_shot",
    coverage: direction.coverage,
    start_frame_contract: direction.start_frame_contract,
    end_frame_contract: direction.end_frame_contract,
    source_image_path: path.resolve(direction.source_image_path),
    source_image_sha256: direction.source_image_sha256,
    source_prompt_sha256: direction.source_prompt_sha256,
    motion_prompt: direction.motion_prompt,
    motion_prompt_sha256: sha256(String(direction.motion_prompt ?? "")),
    direction_contract_sha256: generatedMotionDirectionContractSha256({
      ...direction,
      requested_duration_sec: clampGeneratedMotionDuration(direction.requested_generation_duration_sec, identityContract.provider),
    }),
    candidate_count: 1,
    automatic_generation_retry_allowed: false,
  }));
  return {
    schema: GENERATED_MOTION_PLAN_SCHEMA,
    status: "passed",
    channel,
    series_slug: series,
    week,
    episode,
    provider: identityContract.provider,
    model_id: identityContract.model,
    policy: identityContract.policy,
    resolution: "16:9",
    requested_concurrency: concurrency,
    provider_image_inputs: ["first_frame"],
    candidate_policy: "one_candidate_per_motion_moment",
    automatic_generation_retries: 0,
    unavailable_or_rejected_disposition: "accepted_still_fallback",
    animation_direction_plan_path: directionPath,
    source_hashes: {},
    clip_count: clips.length,
    clips,
    repair_scope: explicitIds.size ? {
      cut_ids: [...explicitIds],
      reason: repairReason || null,
    } : null,
    updated_at: new Date().toISOString(),
  };
}

function flowRequestForRow(row, identityContract) {
  return {
    type: "video",
    manifest_id: `generated-motion-${episode}`,
    asset_id: row.candidate_id,
    prompt: row.motion_prompt,
    model_id: identityContract.model,
    duration_sec: row.requested_duration_sec,
    references: [{
      slot: 1,
      ref_id: row.image_id,
      path: row.source_image_path,
      sha256: row.source_image_sha256,
    }],
    source: {
      channel,
      series_slug: series,
      week,
      episode,
      animation_direction_contract_sha256: row.direction_contract_sha256,
      source_prompt_sha256: row.source_prompt_sha256,
    },
  };
}

function matchingProvenanceBinding(job, request) {
  return (job?.provenance_bindings ?? []).find((binding) => (
    binding?.manifest_id === request.manifest_id
    && binding?.asset_id === request.asset_id
    && binding?.first_frame?.ref_id === request.references[0].ref_id
    && binding?.first_frame?.path === request.references[0].path
    && binding?.first_frame?.sha256 === request.references[0].sha256
    && binding?.source?.channel === request.source.channel
    && binding?.source?.series_slug === request.source.series_slug
    && binding?.source?.week === request.source.week
    && binding?.source?.episode === request.source.episode
    && binding?.source?.animation_direction_contract_sha256 === request.source.animation_direction_contract_sha256
    && binding?.source?.source_prompt_sha256 === request.source.source_prompt_sha256
  ));
}

async function materializeCompletedJob(row, job, request) {
  const creativeIdentity = job?.creative_identity;
  const validIdentityStorage = job?.creative_identity_storage === "legacy_full_request_job_id"
    ? job?.legacy_request_sha256 === job?.job_id && job?.request_sha256 === job?.job_id
    : job?.creative_identity_sha256 === job?.job_id;
  if (
    creativeIdentity?.provider !== GENERATED_MOTION_PROVIDER_FLOW
    || creativeIdentity?.model_id !== request.model_id
    || creativeIdentity?.prompt_sha256 !== row.motion_prompt_sha256
    || creativeIdentity?.duration_sec !== row.requested_duration_sec
    || creativeIdentity?.first_frame_sha256 !== row.source_image_sha256
    || !validIdentityStorage
  ) {
    throw new Error(`Flow job creative identity is stale for ${row.image_id}.`);
  }
  const provenance = matchingProvenanceBinding(job, request);
  if (!provenance) throw new Error(`Flow job provenance binding is stale for ${row.image_id}.`);
  if (job.request?.prompt_sha256 !== row.motion_prompt_sha256) throw new Error(`Flow job prompt hash is stale for ${row.image_id}.`);
  if (job.request?.references?.[0]?.sha256 !== row.source_image_sha256) throw new Error(`Flow job first-frame hash is stale for ${row.image_id}.`);
  if (await hashFile(job.result?.download_path) !== job.result?.output_sha256) throw new Error(`Flow job output hash is stale for ${row.image_id}.`);
  const rawPath = path.join(outputDir, "raw", `${row.candidate_id}-flow.mp4`);
  await fs.mkdir(path.dirname(rawPath), { recursive: true });
  await fs.copyFile(job.result.download_path, rawPath);
  const rawVideoSha256 = await hashFile(rawPath);
  const rawProbe = await probeVideo(rawPath);
  const normalizedPath = path.join(outputDir, "normalized", `${row.candidate_id}-flow-1920x1080.mp4`);
  const normalizedProbe = await normalizeVideo(rawPath, normalizedPath, row.requested_duration_sec);
  const normalizedVideoSha256 = await hashFile(normalizedPath);
  const elapsedMs = (startedAt, completedAt) => {
    const start = Date.parse(startedAt ?? "");
    const end = Date.parse(completedAt ?? "");
    return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
  };
  const completedAt = job.completed_at ?? job.result?.completed_at ?? null;
  const queueOrigin = job.last_queued_at ?? job.created_at ?? null;
  const serviceOrigin = job.last_leased_at ?? null;
  const providerTiming = {
    created_at: job.created_at ?? null,
    last_queued_at: queueOrigin,
    first_leased_at: job.first_leased_at ?? null,
    last_leased_at: serviceOrigin,
    completed_at: completedAt,
    queue_wait_ms: elapsedMs(queueOrigin, serviceOrigin),
    service_ms: elapsedMs(serviceOrigin, completedAt),
    total_ms: elapsedMs(queueOrigin, completedAt),
  };
  const receipt = {
    schema: "goldflow_generated_motion_provider_receipt_v1",
    status: "passed",
    provider: GENERATED_MOTION_PROVIDER_FLOW,
    model_id: job.request.model_id,
    job_id: job.job_id,
    request_sha256: job.request_sha256,
    creative_identity_sha256: job.creative_identity_sha256,
    provenance_binding_sha256: provenance.provenance_sha256,
    image_id: row.image_id,
    candidate_id: row.candidate_id,
    prompt_sha256: row.motion_prompt_sha256,
    direction_contract_sha256: row.direction_contract_sha256,
    source_image_path: row.source_image_path,
    source_image_sha256: row.source_image_sha256,
    raw_video_path: rawPath,
    raw_video_sha256: rawVideoSha256,
    normalized_video_path: normalizedPath,
    normalized_video_sha256: normalizedVideoSha256,
    ui_contract: job.result.ui_contract,
    conversation_url: job.result.conversation_url,
    provider_timing: providerTiming,
    completed_at: completedAt,
    recorded_at: new Date().toISOString(),
  };
  const receiptPath = path.join(outputDir, "receipts", `${row.candidate_id}.json`);
  await writeJson(receiptPath, receipt);
  return {
    ...row,
    provider: GENERATED_MOTION_PROVIDER_FLOW,
    model_id: job.request.model_id,
    request_id: job.job_id,
    creative_generation_attempt: 1 + Number(job.manual_requeues?.length ?? 0),
    provider_receipt_path: receiptPath,
    provider_receipt_sha256: await hashFile(receiptPath),
    raw_video_path: rawPath,
    raw_video_sha256: rawVideoSha256,
    raw_probe: rawProbe,
    normalized_video_path: normalizedPath,
    normalized_video_sha256: normalizedVideoSha256,
    normalized_probe: normalizedProbe,
    provider_timing: providerTiming,
    status: "generated",
  };
}

async function main() {
  const [identity, directionPlan, priorReport] = await Promise.all([
    readJson(identityPath),
    readJson(directionPath),
    readJson(reportPath, null),
  ]);
  if (!generatedMotionEnabled(identity)) throw new Error("Generated motion is disabled in run_identity.json.");
  const identityContract = generatedMotionIdentityContract(identity);
  if (identityContract.provider === GENERATED_MOTION_PROVIDER_LTX) {
    forwardLegacyLtx();
    return;
  }
  if (identityContract.provider !== GENERATED_MOTION_PROVIDER_FLOW) throw new Error(`Unsupported generated-motion provider ${identityContract.provider}.`);
  if (directionPlan?.schema !== "goldflow_animation_direction_plan_v1" || directionPlan?.status !== "passed") {
    throw new Error(`Generated motion requires a passed animation direction plan: ${directionPath}`);
  }
  const explicitIds = requestedCutIds();
  if (priorReport?.status === "passed" && !explicitIds.length) {
    throw new Error("A generated-motion report already exists. Preserve passed outputs and use exact --cut-ids with --repair-reason for recovery.");
  }
  if (priorReport?.status === "passed" && explicitIds.length && !repairReason) {
    throw new Error("Exact generated-motion recovery requires --repair-reason.");
  }
  const plan = buildPlan(directionPlan, identityContract);
  plan.source_hashes = {
    [identityPath]: await hashFile(identityPath),
    [directionPath]: await hashFile(directionPath),
  };
  plan.plan_sha256 = planHash(plan);
  await writeJson(planPath, plan);

  const priorClips = new Map((priorReport?.clips ?? []).map((clip) => [String(clip.image_id), clip]));
  const priorOmissions = new Map((priorReport?.omitted_clips ?? []).map((clip) => [String(clip.image_id), clip]));
  for (const row of plan.clips) {
    if (await hashFile(row.source_image_path) !== row.source_image_sha256) throw new Error(`Accepted first frame is stale for ${row.image_id}.`);
    if (priorClips.has(row.image_id)) throw new Error(`Generated clip ${row.image_id} already passed and is immutable.`);
  }

  const token = await studioAdminToken();
  const health = await fetch(`${studioUrl}/v1/health`).then((response) => response.json());
  if (health.status !== "ok" || health.browser_provider !== "google-flow") {
    throw new Error(`Expected an active Google Flow Studio at ${studioUrl}.`);
  }
  const batchStartedAt = Date.now();
  let creativeSubmissionCount = 0;
  let creativeResubmissionCount = 0;
  const pipeline = await runGeneratedMotionPipelineForTests({
    rows: plan.clips,
    submissionConcurrency,
    providerWaitConcurrency,
    normalizationConcurrency,
    submit: async (row) => {
      const request = flowRequestForRow(row, identityContract);
      let created = await studioRequest("/v1/media/jobs", token, { method: "POST", body: request });
      if (created.created) creativeSubmissionCount += 1;
      if (["failed", "needs_triage"].includes(created.job?.status)) {
        if (!repairReason) throw new Error(created.job.error?.message ?? `Flow media job ${created.job.job_id} requires triage.`);
        created = await studioRequest("/v1/dashboard/media/requeue", token, {
          method: "POST",
          body: { jobId: created.job.job_id, reason: repairReason },
        });
        creativeSubmissionCount += 1;
        creativeResubmissionCount += 1;
      }
      return { row, request, job: created.job };
    },
    wait: async (submitted) => ({
      ...submitted,
      job: submitted.job?.status === "completed"
        ? submitted.job
        : await waitForMediaJob(submitted.job.job_id, token),
    }),
    normalize: async ({ row, request, job }) => materializeCompletedJob(row, job, request),
  });
  const generated = pipeline.results;
  const omitted = pipeline.failures.map((failure) => {
    const row = failure.row;
    const job = failure.value?.job;
    return {
      ...row,
      provider: GENERATED_MOTION_PROVIDER_FLOW,
      model_id: identityContract.model,
      status: "omitted",
      disposition: "accepted_still_fallback",
      omission_stage: failure.stage,
      creative_generation_attempt: Math.max(
        Number(priorOmissions.get(row.image_id)?.creative_generation_attempt ?? 0),
        job ? 1 + Number(job.manual_requeues?.length ?? 0) : 0,
      ),
      error: failure.error instanceof Error ? failure.error.message : String(failure.error),
    };
  });

  const repairedIds = new Set(plan.clips.map((row) => row.image_id));
  const cumulativeClips = [
    ...(priorReport?.clips ?? []).filter((row) => !repairedIds.has(String(row.image_id))),
    ...generated,
  ].sort((left, right) => Number(left.start_sec ?? 0) - Number(right.start_sec ?? 0));
  const cumulativeOmissions = [
    ...(priorReport?.omitted_clips ?? []).filter((row) => !repairedIds.has(String(row.image_id))),
    ...omitted,
  ].sort((left, right) => Number(left.start_sec ?? 0) - Number(right.start_sec ?? 0));
  const report = {
    schema: GENERATED_MOTION_REPORT_SCHEMA,
    status: "passed",
    channel,
    series_slug: series,
    week,
    episode,
    provider: GENERATED_MOTION_PROVIDER_FLOW,
    model_id: identityContract.model,
    policy: identityContract.policy,
    required_motion_through_sec: identityContract.required_through_sec,
    required_image_ids: (directionPlan.directions ?? [])
      .filter((row) => Number(row.start_sec ?? 0) < Number(identityContract.required_through_sec ?? 0))
      .map((row) => String(row.image_id)),
    plan_path: planPath,
    plan_sha256: await hashFile(planPath),
    plan_contract_sha256: plan.plan_sha256,
    source_hashes: plan.source_hashes,
    requested_concurrency: concurrency,
    queue_concurrency: {
      submission: submissionConcurrency,
      provider_wait: providerWaitConcurrency,
      local_normalization: normalizationConcurrency,
    },
    provider_image_inputs: ["first_frame"],
    candidate_policy: "one_candidate_per_motion_moment",
    automatic_generation_retries: 0,
    creative_resubmission_count: creativeResubmissionCount,
    repair_history: [
      ...(priorReport?.repair_history ?? []),
      ...(priorReport ? [{ cut_ids: [...repairedIds], reason: repairReason, at: new Date().toISOString() }] : []),
    ],
    planned_count: cumulativeClips.length + cumulativeOmissions.length,
    attempted_count: plan.clips.length,
    creative_submission_count: creativeSubmissionCount,
    clip_count: cumulativeClips.length,
    generated_count: cumulativeClips.length,
    failed_count: 0,
    omitted_count: cumulativeOmissions.length,
    omitted_disposition: "accepted_still_fallback",
    batch_wall_time_sec: Number(((Date.now() - batchStartedAt) / 1000).toFixed(3)),
    clips: cumulativeClips,
    omitted_clips: cumulativeOmissions,
    updated_at: new Date().toISOString(),
  };
  await writeJson(reportPath, report);
  let coherencePrefetch = null;
  if (prefetchCoherenceCache && generated.length) {
    const coherencePath = path.join(outputDir, `generated_motion_coherence_prefetch_${episode}.json`);
    try {
      const audit = await buildGeneratedMotionCoherenceAudit({
        report,
        reportPath,
        outputPath: coherencePath,
        framesRoot: path.join(outputDir, "coherence_frames"),
        callsDir: path.join(outputDir, "coherence_calls"),
        rowCacheDir: path.join(episodeDir, "assets", "motion", "generated", "coherence_row_cache"),
        repoRoot,
        concurrency: providerWaitConcurrency,
      });
      coherencePrefetch = { status: "passed", output_path: coherencePath, summary: audit.summary };
    } catch (error) {
      coherencePrefetch = { status: "unavailable", error: error instanceof Error ? error.message : String(error) };
    }
  }
  console.log(JSON.stringify({
    status: report.status,
    output_path: reportPath,
    plan_path: planPath,
    generated_count: report.generated_count,
    omitted_count: report.omitted_count,
    still_fallback_count: report.omitted_count,
    coherence_prefetch: coherencePrefetch,
  }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    await writeJson(reportPath, {
      schema: GENERATED_MOTION_REPORT_SCHEMA,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      updated_at: new Date().toISOString(),
    }).catch(() => {});
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
