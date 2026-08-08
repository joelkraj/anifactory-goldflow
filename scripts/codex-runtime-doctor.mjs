#!/usr/bin/env node

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { codexRuntimeSummary, runCodexCli } from "./lib/codex-cli-runner.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

export function normalizedDoctorProbeResponse(value) {
  return String(value ?? "")
    .trim()
    .replace(/^```(?:text)?\s*/i, "")
    .replace(/\s*```$/, "")
    .replace(/\\([_*`])/g, "$1")
    .trim();
}

async function main() {
  const model = flags.model ?? flags["llm-model"] ?? null;
  const reasoningEffort = flags["reasoning-effort"] ?? null;
  const provider = flags["planning-provider"] ?? flags.provider ?? null;
  const summary = await codexRuntimeSummary({ model, reasoningEffort, provider });
  if (flags.probe === "true") {
    const outputPath = path.join(os.tmpdir(), `goldflow-codex-doctor-${process.pid}.txt`);
    const result = await runCodexCli({
      prompt: "Reply with exactly MODEL_OK.",
      stageName: "goldflow_codex_doctor_probe",
      repoRoot,
      outputPath,
      model,
      reasoningEffort,
      provider,
      timeoutMs: Number(flags["timeout-ms"] ?? 120_000),
    });
    const normalizedOutput = normalizedDoctorProbeResponse(result.content);
    summary.probe = {
      status: normalizedOutput === "MODEL_OK" ? "passed" : "unexpected_output",
      output: result.content.trim(),
      normalized_output: normalizedOutput,
      metadata_path: `${outputPath}.meta.json`,
    };
    await fs.rm(outputPath, { force: true });
    await fs.rm(`${outputPath}.meta.json`, { force: true });
    if (summary.probe.status !== "passed") process.exitCode = 1;
  }
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
