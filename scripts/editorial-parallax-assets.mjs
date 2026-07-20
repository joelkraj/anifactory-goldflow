#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sha256File } from "./lib/file-hash.mjs";
import { generateModelslabImage } from "./modelslab-image-helper.mjs";

const execFile = promisify(execFileCallback);
const flags = parseFlags(process.argv.slice(2));
const imagePath = path.resolve(flags.image ?? "");
const outputDir = path.resolve(flags["output-dir"] ?? "");
const slug = String(flags.slug ?? path.basename(imagePath, path.extname(imagePath)) ?? "parallax").trim();
const ffmpegBin = process.env.FFMPEG_BIN || "ffmpeg";
const swiftHelper = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers", "vision-foreground-mask.swift");
export const MODELSLAB_PARALLAX_BACKGROUND_STRATEGY = "modelslab_flux_klein_reconstruction";
export const LEGACY_PARALLAX_BACKGROUND_STRATEGY = "local_blur_legacy";

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function parallaxBackgroundFilter() {
  return "[0:v]format=yuv444p,split=2[base][blur_source];[blur_source]gblur=sigma=34:steps=3[blurred];[1:v]format=gray,gblur=sigma=18[fill_mask];[base][blurred][fill_mask]maskedmerge,format=rgb24[plate]";
}

export function parallaxBackgroundPrompt({ foregroundSubject, backgroundPlane } = {}) {
  const foreground = cleanText(foregroundSubject) || "the foreground subject";
  const background = cleanText(backgroundPlane) || "the same environment";
  return [
    "Using Image 1 as the exact composition and environment reference, reconstruct a clean unoccupied rear plate.",
    `Match the camera angle, lighting, architecture, materials, furniture, and anime/manhwa rendering of ${background}.`,
    `Fill every area behind ${foreground} with a natural continuation of the surrounding environment.`,
    "The final image contains the environment only, ready for the foreground layer to be composited separately.",
  ].join(" ");
}

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

async function exists(filePath) {
  return Boolean(filePath) && fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
}

async function cachedReport(reportPath, expectedImageHash, expectedBackgroundStrategy, expectedBackgroundPromptSha256) {
  if (!(await exists(reportPath))) return null;
  let report;
  try {
    report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  } catch {
    return null;
  }
  if (report?.schema !== "goldflow_editorial_parallax_assets_v2"
    || report?.status !== "passed"
    || report.image_sha256 !== expectedImageHash
    || report.background_strategy !== expectedBackgroundStrategy
    || report.background_prompt_sha256 !== expectedBackgroundPromptSha256) return null;
  for (const [filePath, expectedHash] of [
    [report.mask_path, report.mask_sha256],
    [report.foreground_path, report.foreground_sha256],
    [report.background_path, report.background_sha256],
  ]) {
    if (!(await exists(filePath)) || await sha256File(filePath) !== expectedHash) return null;
  }
  return { ...report, report_path: reportPath, cache_reused: true };
}

export async function buildParallaxAssets({
  imagePath: inputImagePath,
  outputDir: inputOutputDir,
  slug: inputSlug,
  ffmpegBin: inputFfmpegBin = process.env.FFMPEG_BIN || "ffmpeg",
  swiftHelper: inputSwiftHelper = swiftHelper,
  backgroundProvider = LEGACY_PARALLAX_BACKGROUND_STRATEGY,
  foregroundSubject = "",
  backgroundPlane = "",
  backgroundPrompt = null,
}) {
  const resolvedImagePath = path.resolve(inputImagePath);
  const resolvedOutputDir = path.resolve(inputOutputDir);
  const resolvedSlug = String(inputSlug ?? path.basename(resolvedImagePath, path.extname(resolvedImagePath)) ?? "parallax").trim();
  await fs.access(resolvedImagePath);
  await fs.mkdir(resolvedOutputDir, { recursive: true });
  const maskPath = path.join(resolvedOutputDir, `${resolvedSlug}-foreground-mask.png`);
  const foregroundPath = path.join(resolvedOutputDir, `${resolvedSlug}-foreground.png`);
  const backgroundPath = path.join(resolvedOutputDir, `${resolvedSlug}-background-plate.png`);
  const reportPath = path.join(resolvedOutputDir, `${resolvedSlug}-parallax-assets.json`);
  const imageHash = await sha256File(resolvedImagePath);
  const backgroundStrategy = backgroundProvider === "modelslab_flux_klein"
    ? MODELSLAB_PARALLAX_BACKGROUND_STRATEGY
    : LEGACY_PARALLAX_BACKGROUND_STRATEGY;
  const resolvedBackgroundPrompt = cleanText(backgroundPrompt)
    || parallaxBackgroundPrompt({ foregroundSubject, backgroundPlane });
  const backgroundPromptSha256 = sha256(resolvedBackgroundPrompt);
  const cached = await cachedReport(reportPath, imageHash, backgroundStrategy, backgroundPromptSha256);
  if (cached) return cached;

  const { stdout: maskStdout } = await execFile("swift", [inputSwiftHelper, resolvedImagePath, maskPath], { maxBuffer: 1024 * 1024 * 8 });
  const maskReport = JSON.parse(maskStdout);
  await execFile(inputFfmpegBin, [
    "-y", "-i", resolvedImagePath, "-i", maskPath,
    "-filter_complex", "[1:v]format=gray,gblur=sigma=1.2[alpha];[0:v]format=rgba[subject];[subject][alpha]alphamerge[fg]",
    "-map", "[fg]", "-frames:v", "1", foregroundPath,
  ], { maxBuffer: 1024 * 1024 * 16 });
  let backgroundProviderResult = null;
  if (backgroundStrategy === MODELSLAB_PARALLAX_BACKGROUND_STRATEGY) {
    backgroundProviderResult = await generateModelslabImage({
      prompt: resolvedBackgroundPrompt,
      outputPath: backgroundPath,
      referenceImagePaths: [resolvedImagePath],
      model: "flux-klein",
      width: 1024,
      height: 576,
      enhancePrompt: false,
    });
  } else {
    await execFile(inputFfmpegBin, [
      "-y", "-i", resolvedImagePath, "-i", maskPath,
      "-filter_complex", parallaxBackgroundFilter(),
      "-map", "[plate]", "-frames:v", "1", backgroundPath,
    ], { maxBuffer: 1024 * 1024 * 16 });
  }

  const report = {
    schema: "goldflow_editorial_parallax_assets_v2",
    status: "passed",
    image_path: resolvedImagePath,
    image_sha256: imageHash,
    mask_path: maskPath,
    mask_sha256: await sha256File(maskPath),
    foreground_path: foregroundPath,
    foreground_sha256: await sha256File(foregroundPath),
    background_path: backgroundPath,
    background_sha256: await sha256File(backgroundPath),
    background_strategy: backgroundStrategy,
    background_prompt: resolvedBackgroundPrompt,
    background_prompt_sha256: backgroundPromptSha256,
    background_provider_result: backgroundProviderResult,
    mask_report: maskReport,
    cache_reused: false,
    updated_at: new Date().toISOString(),
  };
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { ...report, report_path: reportPath };
}

async function main() {
  if (!flags.image || !flags["output-dir"]) throw new Error("--image and --output-dir are required.");
  const report = await buildParallaxAssets({
    imagePath,
    outputDir,
    slug,
    ffmpegBin,
    swiftHelper,
    backgroundProvider: flags["background-provider"] ?? LEGACY_PARALLAX_BACKGROUND_STRATEGY,
    foregroundSubject: flags["foreground-subject"] ?? "",
    backgroundPlane: flags["background-plane"] ?? "",
  });
  console.log(JSON.stringify(report, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
