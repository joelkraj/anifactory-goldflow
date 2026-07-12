#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sha256File } from "./lib/file-hash.mjs";

const execFile = promisify(execFileCallback);
const flags = parseFlags(process.argv.slice(2));
const imagePath = path.resolve(flags.image ?? "");
const outputDir = path.resolve(flags["output-dir"] ?? "");
const slug = String(flags.slug ?? path.basename(imagePath, path.extname(imagePath)) ?? "parallax").trim();
const ffmpegBin = process.env.FFMPEG_BIN || "ffmpeg";
const swiftHelper = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers", "vision-foreground-mask.swift");

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

async function cachedReport(reportPath, expectedImageHash) {
  if (!(await exists(reportPath))) return null;
  let report;
  try {
    report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  } catch {
    return null;
  }
  if (report?.status !== "passed" || report.image_sha256 !== expectedImageHash) return null;
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
  const cached = await cachedReport(reportPath, imageHash);
  if (cached) return cached;

  const { stdout: maskStdout } = await execFile("swift", [inputSwiftHelper, resolvedImagePath, maskPath], { maxBuffer: 1024 * 1024 * 8 });
  const maskReport = JSON.parse(maskStdout);
  await execFile(inputFfmpegBin, [
    "-y", "-i", resolvedImagePath, "-i", maskPath,
    "-filter_complex", "[1:v]format=gray,gblur=sigma=1.2[alpha];[0:v]format=rgba[subject];[subject][alpha]alphamerge[fg]",
    "-map", "[fg]", "-frames:v", "1", foregroundPath,
  ], { maxBuffer: 1024 * 1024 * 16 });
  await execFile(inputFfmpegBin, [
    "-y", "-i", resolvedImagePath, "-i", maskPath,
    "-filter_complex", "[0:v]format=yuv444p,split=2[base][blur_source];[blur_source]gblur=sigma=34:steps=3[blurred];[1:v]format=gray,gblur=sigma=18[fill_mask];[base][blurred][fill_mask]maskedmerge,format=rgb24[plate]",
    "-map", "[plate]", "-frames:v", "1", backgroundPath,
  ], { maxBuffer: 1024 * 1024 * 16 });

  const report = {
    schema: "goldflow_editorial_parallax_assets_v1",
    status: "passed",
    image_path: resolvedImagePath,
    image_sha256: imageHash,
    mask_path: maskPath,
    mask_sha256: await sha256File(maskPath),
    foreground_path: foregroundPath,
    foreground_sha256: await sha256File(foregroundPath),
    background_path: backgroundPath,
    background_sha256: await sha256File(backgroundPath),
    mask_report: maskReport,
    cache_reused: false,
    updated_at: new Date().toISOString(),
  };
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { ...report, report_path: reportPath };
}

async function main() {
  if (!flags.image || !flags["output-dir"]) throw new Error("--image and --output-dir are required.");
  const report = await buildParallaxAssets({ imagePath, outputDir, slug, ffmpegBin, swiftHelper });
  console.log(JSON.stringify(report, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
