#!/usr/bin/env node

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { GoogleGeminiBrowser } from "../apps/goldflow-studio/desktop/google-gemini-browser.mjs";
import { defaultChromeExecutable } from "../apps/goldflow-studio/desktop/config.mjs";

function parseFlags(parts) {
  const flags = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--") ? parts[++index] : "true";
    flags[key] = value;
  }
  return flags;
}

function selectedIndices(value, count) {
  if (!String(value ?? "").trim()) return Array.from({ length: count }, (_, index) => index);
  const indices = String(value).split(",").map((entry) => Number(entry.trim())).filter(Number.isInteger);
  if (!indices.length || indices.some((index) => index < 0 || index >= count)) {
    throw new Error(`--indices must contain zero-based values from 0 through ${count - 1}.`);
  }
  return [...new Set(indices)];
}

async function runPool(items, concurrency, worker) {
  let cursor = 0;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

export async function generateGoogleGeminiThumbnails({
  jobs,
  concurrency = 3,
  profileDir = path.join(os.homedir(), ".goldflow-studio", "google-flow-browser-profile"),
  downloadsRoot = path.join(os.homedir(), "Downloads", "GoldflowStudio", "thumbnail-gemini"),
  chromeExecutable = defaultChromeExecutable(),
} = {}) {
  if (!Array.isArray(jobs) || !jobs.length) throw new Error("At least one Gemini thumbnail job is required.");
  if (jobs.some((job) => (job.referenceImagePaths ?? []).length)) {
    throw new Error("The thumbnail helper is zero-reference only. Use the guarded hybrid browser pool for referenced production images.");
  }
  const browser = new GoogleGeminiBrowser({
    profileDir,
    downloadsRoot,
    chromeExecutable,
    concurrency: Math.max(1, Math.min(5, Number(concurrency) || 3)),
    geminiPlanLabel: "Ultra",
    geminiModelLabel: "Nano Banana 2",
  });
  await browser.start();
  try {
    await browser.waitForAuthentication();
    return await runPool(jobs, browser.concurrency, async (job, index) => {
      const startedAt = new Date().toISOString();
      const result = await browser.runJob({
        job: {
          manifest_id: `thumbnail-gemini-${Date.now()}-${index}`,
          asset_id: String(job.workId ?? `thumbnail-${index}`),
          lease_token: `direct-${Date.now()}-${index}`,
          prompt: String(job.prompt ?? ""),
          references: [],
        },
        client: {
          fetchReference: async () => {
            throw new Error("Zero-reference thumbnail job unexpectedly requested a reference.");
          },
        },
      });
      const outputPath = path.resolve(job.outputPath);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.copyFile(result.downloadPath, outputPath);
      const receipt = {
        schema: "goldflow_google_gemini_thumbnail_receipt_v1",
        status: "completed",
        provider: "google-gemini",
        model: result.uiContract?.model_label ?? "Nano Banana 2",
        reference_count: 0,
        work_id: job.workId,
        output_path: outputPath,
        source_path: result.downloadPath,
        conversation_url: result.conversationUrl ?? null,
        ui_contract: result.uiContract,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
      };
      await fs.writeFile(`${outputPath}.receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
      return receipt;
    });
  } finally {
    await browser.close();
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (!flags.manifest) throw new Error("Usage: google-gemini-thumbnail-helper --manifest <jobs.json> [--indices 5,6,7,8,9] [--concurrency 3]");
  const manifestPath = path.resolve(flags.manifest);
  const jobs = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const indices = selectedIndices(flags.indices, jobs.length);
  const selected = indices.map((index) => jobs[index]);
  const results = await generateGoogleGeminiThumbnails({
    jobs: selected,
    concurrency: Number(flags.concurrency ?? 3),
    profileDir: flags["profile-dir"] ? path.resolve(flags["profile-dir"]) : undefined,
    downloadsRoot: flags["downloads-root"] ? path.resolve(flags["downloads-root"]) : undefined,
    chromeExecutable: flags["chrome-executable"] ? path.resolve(flags["chrome-executable"]) : undefined,
  });
  process.stdout.write(`${JSON.stringify({ status: "passed", manifest_path: manifestPath, indices, results }, null, 2)}\n`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
