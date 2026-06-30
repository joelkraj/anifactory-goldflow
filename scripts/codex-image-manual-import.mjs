#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promptTextForImageProvider } from "./lib/image-prompt-utils.mjs";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeDir = path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode);
const promptPath = flags.prompts ?? path.join(episodeDir, "section_image_prompts_hardened.json");
const imageDir = path.join(episodeDir, "assets", "images");
const reportPath = flags.output ?? flags.report ?? flags["report-output"] ?? path.join(episodeDir, `imagegen_report_${episode}.json`);
const imageId = flags["image-id"] ?? flags.imageId ?? flags["cut-id"] ?? flags.cutId;
const sourcePath = flags.source ?? flags["source-path"];
const forceDuplicate = flags["force-duplicate"] === "true";

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

async function hashFile(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function exists(filePath) {
  return Boolean(filePath) && fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
}

async function verifyRasterImage(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".webp"].includes(extension)) throw new Error(`Unsupported raster extension: ${extension}`);
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size <= 0) throw new Error(`Raster is missing or empty: ${filePath}`);
  if (/mock|placeholder/i.test(path.basename(filePath))) throw new Error(`Raster appears to be a mock/placeholder: ${filePath}`);
  if (extension === ".png") {
    const file = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(8);
      await file.read(buffer, 0, 8, 0);
      if (!buffer.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        throw new Error(`PNG failed magic-byte validation: ${filePath}`);
      }
    } finally {
      await file.close();
    }
  }
  return stat;
}

function slotWord(value) {
  return ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"][Number(value)] ?? String(value);
}

function referenceSlotInstruction(slots) {
  if (!slots.length) return "";
  return slots.map((slot) => `Use image ${slotWord(slot.slot)} as ${slot.purpose}.`).join(" ");
}

function promptWithReferenceSlots(prompt) {
  const basePrompt = promptTextForImageProvider(prompt, "codex_imagegen");
  const slotInstruction = referenceSlotInstruction(prompt.reference_slots ?? []);
  return [slotInstruction, basePrompt].filter(Boolean).join(" ");
}

function referenceSlotsFromPrompt(prompt) {
  const requirements = Array.isArray(prompt.reference_requirements) ? prompt.reference_requirements : [];
  const paths = Array.isArray(prompt.required_reference_paths) ? prompt.required_reference_paths : [];
  return requirements
    .map((requirement, index) => ({
      index,
      explicitOrder: Number(requirement.slot_order ?? requirement.order ?? requirement.image_slot ?? Number.NaN),
      slot: index + 1,
      ref_id: requirement.ref_id,
      kind: requirement.kind ?? null,
      path: requirement.reference_image_path ?? paths[index] ?? null,
      purpose: requirement.slot_purpose ?? requirement.reason ?? requirement.ref_id ?? `reference ${index + 1}`,
      reason: requirement.reason ?? null,
    }))
    .sort((a, b) => (Number.isFinite(a.explicitOrder) ? a.explicitOrder : 999) - (Number.isFinite(b.explicitOrder) ? b.explicitOrder : 999) || a.index - b.index)
    .map((slot, index) => ({
      ...slot,
      slot: index + 1,
    }))
    .filter((slot) => slot.path && paths.includes(slot.path))
    .slice(0, paths.length);
}

function imagePathFor(prompt) {
  return path.join(imageDir, `${prompt.image_id}-codex-imagegen-image.png`);
}

async function main() {
  if (!imageId) throw new Error("Missing --image-id/--cut-id.");
  if (!sourcePath) throw new Error("Missing --source.");
  if (!(await exists(sourcePath))) throw new Error(`Missing source raster: ${sourcePath}`);
  await verifyRasterImage(sourcePath);
  const plan = await readJson(promptPath, null);
  if (plan?.status !== "passed" || !Array.isArray(plan.prompts)) throw new Error(`Missing passed prompt plan: ${promptPath}`);
  const prompt = plan.prompts.find((row) => row.image_id === imageId);
  if (!prompt) throw new Error(`Prompt plan does not contain image_id ${imageId}`);
  const promptForHash = {
    ...prompt,
    reference_slots: Array.isArray(prompt.reference_slots) ? prompt.reference_slots : referenceSlotsFromPrompt(prompt),
  };
  const modelPrompt = promptWithReferenceSlots(promptForHash);
  const promptHash = sha256(modelPrompt);
  const outputPath = imagePathFor(prompt);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.copyFile(sourcePath, outputPath);
  await verifyRasterImage(outputPath);
  await fs.writeFile(`${outputPath}.prompt.sha256`, promptHash, "utf8");
  const sourceHash = await hashFile(sourcePath);
  const outputHash = await hashFile(outputPath);
  const updatedAt = new Date().toISOString();
  await writeJson(`${outputPath}.metadata.json`, {
    image_id: prompt.image_id,
    prompt_hash: promptHash,
    source_prompt_path: promptPath,
    source_manual_codex_image_path: sourcePath,
    source_manual_codex_image_sha256: sourceHash,
    reference_image_paths: prompt.required_reference_paths ?? [],
    reference_slots: promptForHash.reference_slots ?? [],
    image_prompt: modelPrompt,
    codex_prompt: modelPrompt,
    image_provider: "codex_imagegen_manual_import",
    model: flags.model ?? "codex_builtin_imagegen_manual",
    generated: {
      downloaded_path: outputPath,
      manual_source_path: sourcePath,
      manual_source_sha256: sourceHash,
      output_sha256: outputHash,
    },
    updated_at: updatedAt,
  });
  const promptPlanHash = await hashFile(promptPath);
  const allPromptIds = new Set(plan.prompts.filter((row) => row.image_generation_required !== false).map((row) => row.image_id));
  const priorReport = await readJson(reportPath, null);
  const mergedById = new Map();
  if (Array.isArray(priorReport?.results)) {
    for (const row of priorReport.results) {
      if (!row?.image_id || !allPromptIds.has(row.image_id)) continue;
      if (!row.image_path || !(await exists(row.image_path))) continue;
      if (!forceDuplicate && row.image_id !== prompt.image_id) {
        const existingHash = row.generated?.output_sha256 ?? await hashFile(row.image_path);
        if (existingHash === sourceHash) {
          throw new Error(`Refusing duplicate Codex manual import for ${prompt.image_id}: source hash matches accepted ${row.image_id}. Regenerate a fresh raster or pass --force-duplicate true only for an explicitly approved intentional reuse.`);
        }
      }
      mergedById.set(row.image_id, row);
    }
  }
  mergedById.set(prompt.image_id, {
    image_id: prompt.image_id,
    status: "manual_imported",
    image_path: outputPath,
    prompt_hash: promptHash,
    image_provider: "codex_imagegen_manual_import",
    generated: {
      downloaded_path: outputPath,
      manual_source_path: sourcePath,
      manual_source_sha256: sourceHash,
      output_sha256: outputHash,
    },
  });
  const results = [...mergedById.values()].sort((a, b) => String(a.image_id).localeCompare(String(b.image_id), undefined, { numeric: true }));
  const missingImageCount = Math.max(0, allPromptIds.size - results.length);
  const reportStatus = missingImageCount === 0 ? "passed" : "partial";
  const report = {
    schema: "goldflow_imagegen_report_v1",
    status: reportStatus,
    channel,
    series_slug: series,
    week,
    episode,
    prompt_plan_path: promptPath,
    prompt_plan_hash: promptPlanHash,
    image_provider: "codex_imagegen_manual_import",
    image_dir: imageDir,
    image_count: results.length,
    expected_image_count: allPromptIds.size,
    missing_image_count: missingImageCount,
    current_batch_image_count: 1,
    manual_import: true,
    results,
    updated_at: updatedAt,
  };
  await writeJson(reportPath, report);
  console.log(JSON.stringify({ status: reportStatus, image_id: prompt.image_id, image_path: outputPath, report_path: reportPath, image_count: results.length, expected_image_count: allPromptIds.size, missing_image_count: missingImageCount }, null, 2));
}

main().catch(async (error) => {
  const failed = { schema: "goldflow_imagegen_report_v1", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() };
  if (reportPath) await writeJson(reportPath, failed).catch(() => {});
  console.error(failed.error);
  process.exitCode = 1;
});
