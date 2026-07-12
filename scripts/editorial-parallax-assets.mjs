#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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

async function sha256(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function main() {
  if (!flags.image || !flags["output-dir"]) throw new Error("--image and --output-dir are required.");
  await fs.access(imagePath);
  await fs.mkdir(outputDir, { recursive: true });
  const maskPath = path.join(outputDir, `${slug}-foreground-mask.png`);
  const foregroundPath = path.join(outputDir, `${slug}-foreground.png`);
  const backgroundPath = path.join(outputDir, `${slug}-background-plate.png`);
  const reportPath = path.join(outputDir, `${slug}-parallax-assets.json`);

  const { stdout: maskStdout } = await execFile("swift", [swiftHelper, imagePath, maskPath], { maxBuffer: 1024 * 1024 * 8 });
  const maskReport = JSON.parse(maskStdout);
  await execFile(ffmpegBin, [
    "-y", "-i", imagePath, "-i", maskPath,
    "-filter_complex", "[1:v]format=gray,gblur=sigma=1.2[alpha];[0:v]format=rgba[subject];[subject][alpha]alphamerge[fg]",
    "-map", "[fg]", "-frames:v", "1", foregroundPath,
  ], { maxBuffer: 1024 * 1024 * 16 });
  await execFile(ffmpegBin, [
    "-y", "-i", imagePath, "-i", maskPath,
    "-filter_complex", "[0:v]format=yuv444p,split=2[base][blur_source];[blur_source]gblur=sigma=34:steps=3[blurred];[1:v]format=gray,gblur=sigma=18[fill_mask];[base][blurred][fill_mask]maskedmerge,format=rgb24[plate]",
    "-map", "[plate]", "-frames:v", "1", backgroundPath,
  ], { maxBuffer: 1024 * 1024 * 16 });

  const report = {
    schema: "goldflow_editorial_parallax_assets_v1",
    status: "passed",
    image_path: imagePath,
    image_sha256: await sha256(imagePath),
    mask_path: maskPath,
    mask_sha256: await sha256(maskPath),
    foreground_path: foregroundPath,
    foreground_sha256: await sha256(foregroundPath),
    background_path: backgroundPath,
    background_sha256: await sha256(backgroundPath),
    mask_report: maskReport,
    updated_at: new Date().toISOString(),
  };
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...report, report_path: reportPath }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
