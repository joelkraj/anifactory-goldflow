#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { generateModelslabImage } from "./modelslab-image-helper.mjs";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeDir = path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode);
const promptPath = flags.prompts ?? path.join(episodeDir, "section_image_prompts.json");
const imageDir = path.join(episodeDir, "assets", "images");
const reportPath = flags.output ?? path.join(episodeDir, `imagegen_report_${episode}.json`);
const concurrency = Math.max(1, Math.min(24, Number(flags.concurrency ?? process.env.ANIFACTORY_IMAGEGEN_CONCURRENCY ?? 8)));
const force = flags.force === "true";

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
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function hashFile(filePath) {
  try {
    return sha256(await fs.readFile(filePath));
  } catch {
    return null;
  }
}

async function exists(filePath) {
  return Boolean(filePath) && fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function requestedIds() {
  return new Set(String(flags["cut-ids"] ?? flags["image-ids"] ?? flags["image-id"] ?? "").split(",").map((row) => row.trim()).filter(Boolean));
}

function imagePathFor(prompt) {
  return path.join(imageDir, `${prompt.image_id}-modelslab-image.png`);
}

async function validateReferences(prompt) {
  const paths = [...new Set((prompt.required_reference_paths ?? []).filter(Boolean))];
  const missing = [];
  for (const refPath of paths) {
    if (!(await exists(refPath))) missing.push(refPath);
  }
  if (missing.length) {
    throw new Error(`Missing required reference(s) for ${prompt.image_id}: ${missing.join(", ")}`);
  }
  return paths;
}

async function promptFresh(prompt, outputPath) {
  if (!(await exists(outputPath))) return false;
  const sidecar = `${outputPath}.prompt.sha256`;
  if (!(await exists(sidecar))) return false;
  const current = String(await fs.readFile(sidecar, "utf8")).trim();
  return current === (prompt.prompt_hash ?? sha256(prompt.modelslab_image_prompt ?? prompt.image_prompt ?? ""));
}

async function runPool(items, worker, limit) {
  const results = [];
  let index = 0;
  async function next() {
    while (index < items.length) {
      const current = index++;
      results[current] = await worker(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
  return results;
}

async function generateOne(prompt) {
  const outputPath = imagePathFor(prompt);
  const promptHash = prompt.prompt_hash ?? sha256(prompt.modelslab_image_prompt ?? prompt.image_prompt ?? "");
  if (!force && await promptFresh(prompt, outputPath)) {
    return { image_id: prompt.image_id, status: "reused_fresh", image_path: outputPath, prompt_hash: promptHash };
  }
  const referenceImagePaths = await validateReferences(prompt);
  const generated = await generateModelslabImage({
    prompt: prompt.modelslab_image_prompt ?? prompt.image_prompt,
    outputPath,
    referenceImagePaths,
    model: prompt.image_model_route ?? "flux-klein",
  });
  await fs.writeFile(`${outputPath}.prompt.sha256`, promptHash, "utf8");
  await writeJson(`${outputPath}.metadata.json`, {
    image_id: prompt.image_id,
    prompt_hash: promptHash,
    source_prompt_path: promptPath,
    reference_image_paths: referenceImagePaths,
    model: prompt.image_model_route ?? "flux-klein",
    generated,
    updated_at: new Date().toISOString(),
  });
  return { image_id: prompt.image_id, status: "generated", image_path: outputPath, prompt_hash: promptHash, generated };
}

async function main() {
  const plan = await readJson(promptPath, null);
  if (plan?.status !== "passed" || !Array.isArray(plan.prompts) || !plan.prompts.length) throw new Error(`Missing passed section image prompt plan: ${promptPath}`);
  const scope = requestedIds();
  const prompts = plan.prompts
    .filter((prompt) => prompt.image_generation_required !== false)
    .filter((prompt) => !scope.size || scope.has(prompt.image_id));
  if (!prompts.length) throw new Error("No image prompts selected for generation.");
  await fs.mkdir(imageDir, { recursive: true });
  const results = await runPool(prompts, generateOne, concurrency);
  const report = {
    schema: "goldflow_imagegen_report_v1",
    status: results.every((row) => row.status === "generated" || row.status === "reused_fresh") ? "passed" : "failed",
    channel,
    series_slug: series,
    week,
    episode,
    prompt_plan_path: promptPath,
    prompt_plan_hash: await hashFile(promptPath),
    image_dir: imageDir,
    concurrency,
    image_count: results.length,
    results,
    updated_at: new Date().toISOString(),
  };
  await writeJson(reportPath, report);
  console.log(JSON.stringify({ status: report.status, report_path: reportPath, image_count: results.length }, null, 2));
  if (report.status !== "passed") process.exitCode = 1;
}

main().catch(async (error) => {
  await writeJson(reportPath, { schema: "goldflow_imagegen_report_v1", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() }).catch(() => {});
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
