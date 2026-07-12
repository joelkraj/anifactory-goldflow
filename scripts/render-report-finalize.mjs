#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256File } from "./lib/file-hash.mjs";

const flags = parseFlags(process.argv.slice(2));

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

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function finalizeRenderReport({
  reportPath,
  outputPath = null,
  outputReportPath = null,
}) {
  const resolvedReportPath = path.resolve(reportPath);
  const report = await readJson(resolvedReportPath);
  if (report?.status !== "passed") throw new Error("Render report must be passed before finalization.");
  const rawOutputPath = outputPath ?? report.output_path ?? report.final_video_path;
  if (!rawOutputPath) throw new Error("Render report does not identify an output video.");
  const resolvedOutputPath = path.resolve(rawOutputPath);
  const stat = await fs.stat(resolvedOutputPath);
  if (!stat.isFile() || stat.size <= 0) throw new Error(`Render output is missing or empty: ${resolvedOutputPath}`);
  const outputSha256 = await sha256File(resolvedOutputPath);
  const finalized = {
    ...report,
    output_path: resolvedOutputPath,
    final_video_path: resolvedOutputPath,
    output_hash: outputSha256,
    final_video_sha256: outputSha256,
    output_size_bytes: stat.size,
    output_hash_method: "streaming_sha256",
    hash_finalized_at: new Date().toISOString(),
  };
  const destination = path.resolve(outputReportPath ?? resolvedReportPath);
  await writeJson(destination, finalized);
  return { report: finalized, reportPath: destination };
}

async function main() {
  if (!flags.report) throw new Error("--report is required.");
  const result = await finalizeRenderReport({
    reportPath: flags.report,
    outputPath: flags.output ?? null,
    outputReportPath: flags["output-report"] ?? null,
  });
  console.log(JSON.stringify({
    status: "passed",
    report_path: result.reportPath,
    output_path: result.report.output_path,
    output_size_bytes: result.report.output_size_bytes,
    output_sha256: result.report.output_hash,
  }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
