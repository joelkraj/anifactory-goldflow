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
const weekDir = path.join(dataRoot, "channels", channel, "weekly_runs", week);
const episodeDir = path.join(weekDir, "episodes", episode);
const sourcePath = flags.source ? path.resolve(flags.source) : null;
const storyText = flags.story ?? null;
const stripAnnotations = flags["strip-annotations"] === "true";

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

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeNewlines(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim() + "\n";
}

function stripSceneAnnotations(value) {
  return normalizeNewlines(value)
    .split("\n")
    .filter((line) => !/^SC\d{3}\s*[—-]/.test(line.trim()))
    .map((line) => line.trim() === "NARRATOR:" ? "" : line)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim() + "\n";
}

function annotationWarnings(value) {
  const lines = normalizeNewlines(value).split("\n");
  const tags = ["LOCATION:", "TIME:", "VISIBLE SUBJECTS:", "PRIMARY SUBJECT:", "UI / TEXT ON SCREEN:", "SFX:", "MUSIC:", "VISUAL INTENT:", "NARRATOR:"];
  return tags
    .map((tag) => ({ tag, count: lines.filter((line) => line.trim().startsWith(tag)).length }))
    .filter((row) => row.count > 0);
}

async function main() {
  const source = storyText ?? (sourcePath ? await fs.readFile(sourcePath, "utf8") : "");
  if (!source.trim()) throw new Error("source-ingest requires --source <path> or --story <text>.");
  const operatorSource = normalizeNewlines(source);
  const scriptClean = stripAnnotations ? stripSceneAnnotations(operatorSource) : operatorSource;
  const sourceHash = sha256(operatorSource);
  const scriptHash = sha256(scriptClean);
  const operatorSourcePath = path.join(episodeDir, "operator_source_story.md");
  const scriptPath = path.join(episodeDir, "script_clean.md");
  await fs.mkdir(episodeDir, { recursive: true });
  await fs.writeFile(operatorSourcePath, operatorSource, "utf8");
  await fs.writeFile(scriptPath, scriptClean, "utf8");
  const report = {
    schema: "goldflow_source_ingest_v1",
    status: "source_ingested_pending_review_and_approval",
    channel,
    series_slug: series,
    week,
    episode,
    source_path: sourcePath,
    operator_source_story_path: operatorSourcePath,
    script_clean_path: scriptPath,
    operator_source_hash: sourceHash,
    script_clean_hash: scriptHash,
    strip_annotations_applied: stripAnnotations,
    annotation_warnings: annotationWarnings(operatorSource),
    policy: "Ingest preserves source text. If annotation stripping is enabled, only scene headings and NARRATOR labels are removed; creative prose is not rewritten.",
    next_required_stage: "manual review + operator approval for script_clean_hash",
    updated_at: new Date().toISOString(),
  };
  await writeJson(path.join(episodeDir, "source_story_ingest_report.json"), report);
  await writeJson(path.join(episodeDir, "operator_story_lock.json"), {
    schema: "goldflow_operator_story_lock_v1",
    status: "source_locked_ingest",
    channel,
    series_slug: series,
    week,
    episode,
    operator_source_hash: sourceHash,
    script_clean_hash: scriptHash,
    script_clean_path: scriptPath,
    updated_at: report.updated_at,
  });
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
