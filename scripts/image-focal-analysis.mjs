#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeDir = flags["episode-dir"] ? path.resolve(flags["episode-dir"]) : path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode);
const promptPath = flags.prompts ?? path.join(episodeDir, "section_image_prompts_hardened.json");
const imagegenReportPath = flags["imagegen-report"] ?? path.join(episodeDir, `imagegen_report_${episode}.json`);
const outputPath = flags.output ?? path.join(episodeDir, `image_focal_analysis_${episode}.json`);
const concurrency = Math.max(1, Number(flags.concurrency ?? 8));

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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(filePath, fallback = null) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); } catch { return fallback; }
}

async function hashFile(filePath) {
  return fs.readFile(filePath).then(sha256).catch(() => null);
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(value)));
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * fraction)))];
}

export function focalAnalysisFromPixelsForTests(data, width, height, channels = 3) {
  if (!data?.length || width < 3 || height < 3) throw new Error("Focal analysis requires a non-empty RGB raster.");
  const luminance = new Float64Array(width * height);
  const saturation = new Float64Array(width * height);
  let sum = 0;
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * channels;
    const red = Number(data[offset] ?? 0) / 255;
    const green = Number(data[offset + 1] ?? red * 255) / 255;
    const blue = Number(data[offset + 2] ?? red * 255) / 255;
    const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    luminance[index] = luma;
    saturation[index] = Math.max(red, green, blue) - Math.min(red, green, blue);
    sum += luma;
  }
  const mean = sum / luminance.length;
  const variance = luminance.reduce((total, value) => total + (value - mean) ** 2, 0) / luminance.length;
  const standardDeviation = Math.sqrt(variance);
  const scores = new Float64Array(width * height);
  let totalScore = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const gradient = Math.abs(luminance[index + 1] - luminance[index - 1])
        + Math.abs(luminance[index + width] - luminance[index - width]);
      const centerDistance = Math.hypot((x / (width - 1)) - 0.5, (y / (height - 1)) - 0.5) / 0.7071;
      const centerPrior = 0.72 + 0.28 * (1 - clamp(centerDistance));
      const score = (gradient * 1.65 + Math.abs(luminance[index] - mean) * 0.45 + saturation[index] * 0.28 + 0.002) * centerPrior;
      scores[index] = score;
      totalScore += score;
    }
  }
  if (totalScore <= 0) totalScore = 1;
  let weightedX = 0;
  let weightedY = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const score = scores[y * width + x];
      weightedX += (x / Math.max(1, width - 1)) * score;
      weightedY += (y / Math.max(1, height - 1)) * score;
    }
  }
  const anchor = { x: clamp(weightedX / totalScore), y: clamp(weightedY / totalScore) };
  const threshold = percentile([...scores], 0.84);
  let minX = width - 1;
  let minY = height - 1;
  let maxX = 0;
  let maxY = 0;
  let salientCount = 0;
  let concentrationScore = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const score = scores[y * width + x];
      const nx = x / Math.max(1, width - 1);
      const ny = y / Math.max(1, height - 1);
      if (Math.hypot(nx - anchor.x, ny - anchor.y) <= 0.24) concentrationScore += score;
      if (score < threshold || score <= 0) continue;
      salientCount += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  const bbox = salientCount ? {
    x: clamp(minX / width),
    y: clamp(minY / height),
    width: clamp((maxX - minX + 1) / width),
    height: clamp((maxY - minY + 1) / height),
  } : { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
  const concentration = clamp(concentrationScore / totalScore);
  const confidence = clamp(0.18 + concentration * 0.9 + Math.min(0.2, standardDeviation * 0.8));
  const edgeTouches = [bbox.x < 0.025, bbox.y < 0.025, bbox.x + bbox.width > 0.975, bbox.y + bbox.height > 0.975].filter(Boolean).length;
  const findings = [];
  if (standardDeviation < 0.018) findings.push({ severity: "needs_review", code: "image_low_visual_information", message: "The generated frame has unusually low luminance variation." });
  if (anchor.x < 0.07 || anchor.x > 0.93 || anchor.y < 0.07 || anchor.y > 0.93) findings.push({ severity: "needs_review", code: "focal_anchor_near_frame_edge", message: "The strongest visual focus sits unusually close to a frame edge." });
  if (edgeTouches >= 2 && bbox.width * bbox.height > 0.5) findings.push({ severity: "needs_review", code: "salient_region_edge_clipping_risk", message: "The dominant salient region touches multiple frame edges and may be awkwardly cropped." });
  return {
    focal_anchor: anchor,
    salient_bbox: bbox,
    confidence,
    concentration,
    luminance_mean: mean,
    luminance_standard_deviation: standardDeviation,
    findings,
  };
}

async function analyzeImage(imagePath) {
  const { data, info } = await sharp(imagePath)
    .resize({ width: 192, height: 108, fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return focalAnalysisFromPixelsForTests(data, info.width, info.height, info.channels);
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runWorker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(items.length, limit) }, runWorker));
  return results;
}

async function main() {
  const [promptPlan, imagegenReport, prior] = await Promise.all([
    readJson(promptPath),
    readJson(imagegenReportPath),
    readJson(outputPath, { analyses: [] }),
  ]);
  if (promptPlan?.status !== "passed" || !Array.isArray(promptPlan.prompts)) throw new Error(`Missing passed prompt plan: ${promptPath}`);
  if (imagegenReport?.status !== "passed" || !Array.isArray(imagegenReport.results)) throw new Error(`Missing passed imagegen report: ${imagegenReportPath}`);
  const resultById = new Map(imagegenReport.results.map((row) => [String(row.image_id ?? ""), row]));
  const priorByHash = new Map((prior?.analyses ?? []).filter((row) => row.image_sha256).map((row) => [row.image_sha256, row]));
  const units = promptPlan.prompts.filter((prompt) => prompt.image_generation_required !== false).map((prompt) => ({ prompt, result: resultById.get(String(prompt.image_id ?? "")) }));
  const analyses = await mapWithConcurrency(units, concurrency, async ({ prompt, result }) => {
    const imagePath = result?.image_path ?? null;
    const imageHash = imagePath ? await hashFile(imagePath) : null;
    if (!imagePath || !imageHash) return { image_id: prompt.image_id, status: "failed", image_path: imagePath, error: "generated image missing" };
    const cached = priorByHash.get(imageHash);
    const analysis = cached ? {
      focal_anchor: cached.focal_anchor,
      salient_bbox: cached.salient_bbox,
      confidence: cached.confidence,
      concentration: cached.concentration,
      luminance_mean: cached.luminance_mean,
      luminance_standard_deviation: cached.luminance_standard_deviation,
      findings: cached.findings ?? [],
    } : await analyzeImage(imagePath);
    return {
      image_id: prompt.image_id,
      scene_id: prompt.scene_id ?? null,
      visual_beat_id: prompt.visual_beat_id ?? null,
      start_sec: Number(prompt.start_sec ?? 0),
      status: "passed",
      image_path: imagePath,
      image_sha256: imageHash,
      analysis_source: cached ? "image_hash_cache" : "sharp_local_contrast_saliency_v1",
      ...analysis,
    };
  });
  const failures = analyses.filter((row) => row.status !== "passed");
  const exceptions = analyses.flatMap((row) => (row.findings ?? []).map((finding) => ({ image_id: row.image_id, image_sha256: row.image_sha256, ...finding })));
  const report = {
    schema: "goldflow_image_focal_analysis_v1",
    status: failures.length ? "blocked" : "passed",
    channel,
    series_slug: series,
    week,
    episode,
    algorithm: "sharp_local_contrast_saliency_v1",
    prompt_plan_path: promptPath,
    prompt_plan_sha256: await hashFile(promptPath),
    imagegen_report_path: imagegenReportPath,
    imagegen_report_sha256: await hashFile(imagegenReportPath),
    image_count: analyses.length,
    cache_reuse_count: analyses.filter((row) => row.analysis_source === "image_hash_cache").length,
    composition_exception_count: exceptions.length,
    composition_exceptions: exceptions,
    failures,
    analyses,
    updated_at: new Date().toISOString(),
  };
  await writeJson(outputPath, report);
  console.log(JSON.stringify({ status: report.status, output_path: outputPath, image_count: report.image_count, composition_exception_count: report.composition_exception_count, cache_reuse_count: report.cache_reuse_count }, null, 2));
  if (report.status !== "passed") process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    await writeJson(outputPath, { schema: "goldflow_image_focal_analysis_v1", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() }).catch(() => {});
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
