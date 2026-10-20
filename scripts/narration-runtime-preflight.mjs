#!/usr/bin/env node
// `goldflow tts preflight-runtime`: fail-closed narration runtime check
// (stabilization roadmap R04). Resolves one explicit interpreter per tool,
// imports faster_whisper / mlx_audio / sherpa_onnx in their own interpreters,
// and records the interpreter realpaths, hashes and package versions. With
// --episode-dir it appends an immutable receipt under
// reports/narration_runtime_preflight/. No model is loaded and nothing else is
// written.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runNarrationRuntimePreflight,
} from "./lib/narration-runtime-preflight.mjs";

function parseFlags(parts) {
  const flags = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const next = parts[index + 1];
    if (next === undefined || next.startsWith("--")) flags[part.slice(2)] = "true";
    else { flags[part.slice(2)] = next; index += 1; }
  }
  return flags;
}

export async function main(parts = process.argv.slice(2)) {
  const flags = parseFlags(parts);
  const report = await runNarrationRuntimePreflight({
    asrPython: flags["asr-python"] ?? null,
    ttsPython: flags["tts-python"] ?? flags.python ?? null,
    similarityPython: flags["similarity-python"] ?? null,
    ffmpeg: flags.ffmpeg ?? null,
    ffprobe: flags.ffprobe ?? null,
    allowAsrPathFallback: flags["allow-diagnostic-path-python"] === "true",
  });
  let receiptPath = null;
  if (flags["episode-dir"]) {
    const episodeDir = path.resolve(flags["episode-dir"]);
    const identity = await fs.stat(path.join(episodeDir, "run_identity.json")).catch(() => null);
    if (!identity?.isFile()) {
      throw new Error("tts preflight-runtime --episode-dir requires an existing episode with run_identity.json");
    }
    const receiptDir = path.join(episodeDir, "reports", "narration_runtime_preflight");
    await fs.mkdir(receiptDir, { recursive: true });
    receiptPath = path.join(
      receiptDir,
      `${report.generated_at.replace(/[:.]/g, "-")}-${process.pid}.json`,
    );
    await fs.writeFile(receiptPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  }
  process.stdout.write(`${JSON.stringify({
    status: report.status,
    fingerprint_sha256: report.fingerprint_sha256,
    receipt_path: receiptPath,
    tools: Object.fromEntries(Object.entries(report.tools).map(([name, row]) => [name, {
      realpath: row.realpath, version: row.version, modules: row.modules ?? undefined,
      status: row.status,
    }])),
    findings: report.findings,
  }, null, 2)}\n`);
  if (report.status !== "passed") process.exitCode = 1;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
