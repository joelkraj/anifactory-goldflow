#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeDir = flags["episode-dir"]
  ? path.resolve(flags["episode-dir"])
  : path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode);
const visualReferencePlanPath = flags.visualRefs ?? flags["visual-refs"] ?? path.join(episodeDir, "visual_reference_plan.json");
const characterStateRefsPath = flags.characterStateRefs ?? flags["character-state-refs"] ?? path.join(episodeDir, "character_state_refs.json");
const imagegenReportPath = flags.imagegenReport ?? flags["imagegen-report"] ?? path.join(episodeDir, `imagegen_report_${episode}.json`);
const approvalOutputPath = flags.output ?? path.join(episodeDir, `visual_reference_approval_${episode}.json`);

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

async function fileHash(filePath) {
  try {
    return sha256(await fs.readFile(filePath));
  } catch {
    return null;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  const [visualReferencePlan, characterStateRefs, imagegenReport] = await Promise.all([
    readJson(visualReferencePlanPath, null),
    readJson(characterStateRefsPath, null),
    readJson(imagegenReportPath, null),
  ]);
  if (visualReferencePlan?.status !== "passed") {
    throw new Error(`visual_reference_plan.json must be passed before approval. Current status: ${visualReferencePlan?.status ?? "missing"}.`);
  }
  if (!Array.isArray(characterStateRefs?.character_state_refs)) {
    throw new Error(`Missing character_state_refs.json: ${characterStateRefsPath}`);
  }
  const allowedStatuses = new Set(["draft_needs_manual_review", "approved", "passed"]);
  if (!allowedStatuses.has(String(characterStateRefs.status ?? ""))) {
    throw new Error(`character_state_refs.json has unexpected status ${characterStateRefs.status ?? "missing"}.`);
  }
  const requiredTargets = (visualReferencePlan.reference_targets ?? []).filter((target) => target.required_before_imagegen === true);
  const missingReferencePaths = requiredTargets
    .filter((target) => !(target.conditioning_image_path ?? target.reference_image_path))
    .map((target) => target.ref_id);
  if (missingReferencePaths.length && flags["allow-missing-reference-paths"] !== "true") {
    throw new Error(`Cannot approve: required references are missing image paths: ${missingReferencePaths.slice(0, 20).join(", ")}`);
  }
  if (imagegenReport && imagegenReport.status && imagegenReport.status !== "passed") {
    throw new Error(`Cannot approve: imagegen report exists but status is ${imagegenReport.status}.`);
  }
  const visualReferencePlanHash = await fileHash(visualReferencePlanPath);
  const now = new Date().toISOString();
  const approvedRefs = {
    ...characterStateRefs,
    status: "approved",
    approved_at: now,
    approved_by: flags["approved-by"] ?? "codex-agent",
    approval_note: flags.note ?? "Reference contact sheet and generated references reviewed; approved for visual prompt planning.",
    reference_review_contact_sheet: flags["contact-sheet"] ?? null,
    source_hashes: visualReferencePlanHash ? { [visualReferencePlanPath]: visualReferencePlanHash } : (characterStateRefs.source_hashes ?? {}),
    character_state_refs: characterStateRefs.character_state_refs.map((ref) => ({
      ...ref,
      definitive: true,
    })),
  };
  const approvalReport = {
    schema: "goldflow_visual_reference_approval_v1",
    status: "approved",
    channel,
    series_slug: series,
    week,
    episode,
    visual_reference_plan_path: visualReferencePlanPath,
    character_state_refs_path: characterStateRefsPath,
    visual_reference_plan_hash: visualReferencePlanHash,
    imagegen_report_path: imagegenReport ? imagegenReportPath : null,
    imagegen_status: imagegenReport?.status ?? null,
    required_reference_count: requiredTargets.length,
    character_state_ref_count: approvedRefs.character_state_refs.length,
    approved_by: approvedRefs.approved_by,
    approval_note: approvedRefs.approval_note,
    reference_review_contact_sheet: approvedRefs.reference_review_contact_sheet,
    updated_at: now,
  };
  await writeJson(characterStateRefsPath, approvedRefs);
  await writeJson(approvalOutputPath, approvalReport);
  console.log(JSON.stringify({
    status: "approved",
    character_state_refs_path: characterStateRefsPath,
    approval_report_path: approvalOutputPath,
    required_reference_count: requiredTargets.length,
    character_state_ref_count: approvedRefs.character_state_refs.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
