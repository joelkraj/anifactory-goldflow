#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runVisualPromptHardCutBenchmark } from "./lib/visual-prompt-benchmark.mjs";

function parseFlags(parts) {
  const flags = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    flags[key] = parts[index + 1] && !parts[index + 1].startsWith("--") ? parts[++index] : "true";
  }
  return flags;
}

export async function runVisualPromptBenchmark(flags = {}) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const fixturePath = path.resolve(flags.fixture ?? path.join(repoRoot, "scripts", "fixtures", "visual_prompt_hard_cut_benchmark_v1.json"));
  const outputPath = path.resolve(flags.output ?? path.join(repoRoot, "reports", "benchmarks", "visual_prompt_hard_cut_benchmark_v1.json"));
  const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8"));
  const report = runVisualPromptHardCutBenchmark(fixture);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, fixturePath, outputPath };
}

async function main() {
  try {
    const result = await runVisualPromptBenchmark(parseFlags(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({
      status: result.report.status,
      locked_case_count: result.report.scope.locked_case_count,
      compiled_prompt_count: result.report.scope.compiled_prompt_count,
      failed_count: result.report.failed_count,
      fixture_path: result.fixturePath,
      output_path: result.outputPath,
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
