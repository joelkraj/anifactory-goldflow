#!/usr/bin/env node

import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("--") ? args[0] : "audit";
const flags = parseFlags(args.slice(command === args[0] ? 1 : 0));
const bankDir = flags.bankDir ?? flags["bank-dir"] ?? path.join(dataRoot, "score_bank");
const manifestPath = flags.manifest ?? path.join(bankDir, "score_manifest.json");

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

function nowIso() {
  return new Date().toISOString();
}

function slug(value, fallback = "score") {
  return String(value ?? fallback).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || fallback;
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

async function walk(root, matcher) {
  const out = [];
  async function visit(dir) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(filePath);
      else if (entry.isFile() && matcher(filePath)) out.push(filePath);
    }
  }
  await visit(root);
  return out.sort();
}

function normalizeManifest(raw) {
  const rows = Array.isArray(raw?.drops) ? raw.drops : Object.values(raw?.drops ?? {});
  const drops = {};
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const id = slug(row.bank_id ?? row.drop_id ?? row.prompt_hash ?? row.asset_path, "score_drop");
    drops[id] = {
      bank_id: id,
      status: row.status ?? "needs_review",
      source: row.source ?? "score_bank",
      drop_id: row.drop_id ?? null,
      prompt: row.prompt ?? null,
      prompt_hash: row.prompt_hash ?? null,
      provider: row.provider ?? null,
      model_id: row.model_id ?? null,
      lm_model_id: row.lm_model_id ?? null,
      endpoint: row.endpoint ?? null,
      duration_sec: row.duration_sec ?? null,
      asset_path: row.asset_path ?? null,
      source_json_path: row.source_json_path ?? null,
      tags: Array.isArray(row.tags) ? row.tags : [],
      quality_notes: Array.isArray(row.quality_notes) ? row.quality_notes : [],
    };
  }
  return {
    schema_version: "score_manifest_v1",
    created_at: raw?.created_at ?? nowIso(),
    updated_at: nowIso(),
    bank_dir: bankDir,
    drops,
  };
}

function promptTags(prompt) {
  const text = String(prompt ?? "").toLowerCase();
  const tags = [];
  for (const [tag, regex] of [
    ["impact", /\b(?:impact|hit|crack|slam|thump)\b/],
    ["riser", /\b(?:riser|rise|swell|build)\b/],
    ["reveal", /\b(?:reveal|truth|awakening|objective|system)\b/],
    ["dread", /\b(?:dread|ominous|dark|warning|threat)\b/],
    ["warm", /\b(?:warm|cello|resolved|connection)\b/],
    ["glass", /\b(?:glass|crystalline|screen|digital)\b/],
    ["taiko", /\btaiko\b/],
    ["sub", /\b(?:sub|low pulse|low)\b/],
  ]) {
    if (regex.test(text)) tags.push(tag);
  }
  return tags;
}

function quality(row) {
  const issues = [];
  if (!row.asset_path || !existsSync(row.asset_path)) issues.push("missing_wav");
  if (!row.prompt || row.prompt.length < 30) issues.push("missing_or_short_prompt");
  if (!/no vocals|instrumental/i.test(row.prompt ?? "")) issues.push("missing_no_vocals_guardrail");
  if (!/ace_step|local_ace_step/i.test(`${row.provider} ${row.endpoint}`)) issues.push("not_local_ace_step_review");
  return {
    status: issues.length ? "needs_review" : "needs_review",
    issues,
  };
}

async function rebuild() {
  const manifest = normalizeManifest(await readJson(manifestPath, null));
  const jsonFiles = await walk(dataRoot, (filePath) => filePath.includes(`${path.sep}ace_step_score_drops${path.sep}`) && filePath.endsWith(".json"));
  let added = 0;
  let updated = 0;
  for (const jsonPath of jsonFiles) {
    const row = await readJson(jsonPath, null);
    if (!row?.asset_path) continue;
    const bankId = slug(`${row.prompt_hash ?? path.basename(row.asset_path, ".wav")}_${row.drop_id ?? ""}`, "score_drop");
    const current = manifest.drops[bankId];
    const tags = [...new Set([...(current?.tags ?? []), ...promptTags(row.prompt)])];
    const next = {
      bank_id: bankId,
      status: current?.status ?? quality(row).status,
      source: "episode_ace_step_score_drop",
      drop_id: row.drop_id ?? null,
      prompt: row.prompt ?? null,
      prompt_hash: row.prompt_hash ?? null,
      provider: row.provider ?? null,
      model_id: row.model_id ?? null,
      lm_model_id: row.lm_model_id ?? null,
      endpoint: row.endpoint ?? null,
      duration_sec: row.duration_sec ?? null,
      asset_path: row.asset_path,
      source_json_path: jsonPath,
      tags,
      quality_notes: [...new Set([...(current?.quality_notes ?? []), ...quality(row).issues])],
    };
    manifest.drops[bankId] = next;
    if (current) updated += 1;
    else added += 1;
  }
  manifest.updated_at = nowIso();
  await writeJson(manifestPath, manifest);
  console.log(JSON.stringify({ status: "rebuilt", manifest_path: manifestPath, drop_count: Object.keys(manifest.drops).length, scanned_json_count: jsonFiles.length, added, updated }, null, 2));
}

async function audit() {
  const manifest = normalizeManifest(await readJson(manifestPath, null));
  const rows = Object.values(manifest.drops ?? {});
  console.log(JSON.stringify({
    status: "passed",
    manifest_path: manifestPath,
    drop_count: rows.length,
    approved: rows.filter((row) => row.status === "approved").length,
    needs_review: rows.filter((row) => row.status === "needs_review").length,
    rejected: rows.filter((row) => row.status === "rejected").length,
    missing_files: rows.filter((row) => !row.asset_path || !existsSync(row.asset_path)).length,
    sample_needs_review: rows.filter((row) => row.status === "needs_review").slice(0, 20).map((row) => ({
      bank_id: row.bank_id,
      tags: row.tags,
      prompt: row.prompt,
      asset_path: row.asset_path,
    })),
  }, null, 2));
}

async function list() {
  const manifest = normalizeManifest(await readJson(manifestPath, null));
  const status = flags.status ?? null;
  const query = String(flags.query ?? flags.q ?? "").toLowerCase();
  const limit = Math.max(1, Math.min(500, Number(flags.limit ?? 80) || 80));
  const rows = Object.values(manifest.drops ?? {})
    .filter((row) => !status || row.status === status)
    .filter((row) => !query || `${row.bank_id} ${row.prompt ?? ""} ${(row.tags ?? []).join(" ")}`.toLowerCase().includes(query))
    .slice(0, limit)
    .map((row) => ({
      bank_id: row.bank_id,
      status: row.status,
      tags: row.tags,
      duration_sec: row.duration_sec,
      prompt: row.prompt,
      asset_path: row.asset_path,
    }));
  console.log(JSON.stringify({ status: "listed", count: rows.length, rows }, null, 2));
}

async function setStatus(status) {
  const bankId = flags.id ?? flags["bank-id"];
  if (!bankId) throw new Error("Pass --id <bank_id>.");
  const manifest = normalizeManifest(await readJson(manifestPath, null));
  const row = manifest.drops[bankId];
  if (!row) throw new Error(`Unknown score drop bank id: ${bankId}`);
  row.status = status;
  if (flags.note) row.quality_notes = [...new Set([...(row.quality_notes ?? []), flags.note])];
  manifest.updated_at = nowIso();
  await writeJson(manifestPath, manifest);
  console.log(JSON.stringify({ status, bank_id: bankId }, null, 2));
}

if (command === "rebuild") await rebuild();
else if (command === "audit") await audit();
else if (command === "list") await list();
else if (command === "approve") await setStatus("approved");
else if (command === "reject") await setStatus("rejected");
else {
  console.log(`Usage:
  node scripts/score-bank-maintain.mjs rebuild
  node scripts/score-bank-maintain.mjs audit
  node scripts/score-bank-maintain.mjs list [--status needs_review|approved|rejected] [--query text]
  node scripts/score-bank-maintain.mjs approve --id <bank_id>
  node scripts/score-bank-maintain.mjs reject --id <bank_id> [--note text]`);
}
