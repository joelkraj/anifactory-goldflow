#!/usr/bin/env node

import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("--") ? args[0] : "audit";
const flags = parseFlags(args.slice(command === args[0] ? 1 : 0));
const bankDir = flags.bankDir ?? flags["bank-dir"] ?? path.join(dataRoot, "sfx_bank");
const manifestPath = flags.manifest ?? path.join(bankDir, "sfx_manifest.json");
const assetRoot = flags.assets ?? path.join(bankDir, "assets", "llm_enriched");

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

function slug(value, fallback = "cue") {
  return String(value ?? fallback).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || fallback;
}

function titleFromCueId(cueId) {
  return String(cueId).replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function exists(filePath) {
  return Boolean(filePath) && fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
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

function normalizeManifest(raw) {
  const manifest = raw && typeof raw === "object" ? raw : {};
  const cueRows = Array.isArray(manifest.cues)
    ? manifest.cues
    : Object.values(manifest.cues ?? {});
  const cues = {};
  for (const cue of cueRows) {
    if (!cue || typeof cue !== "object") continue;
    const cueId = slug(cue.cue_id ?? cue.id ?? cue.name, "cue");
    cues[cueId] = {
      cue_id: cueId,
      aliases: Array.isArray(cue.aliases) ? cue.aliases : [],
      queries: Array.isArray(cue.queries) ? cue.queries : [],
      generation_prompt: cue.generation_prompt ?? null,
      default_duration_sec: cue.default_duration_sec ?? null,
      assets: Array.isArray(cue.assets) ? cue.assets : [],
      preferred_asset_id: cue.preferred_asset_id ?? null,
      tags: Array.isArray(cue.tags) ? cue.tags : [],
      quality_notes: Array.isArray(cue.quality_notes) ? cue.quality_notes : [],
    };
  }
  return {
    schema_version: "sfx_manifest_v1",
    created_at: manifest.created_at ?? nowIso(),
    updated_at: nowIso(),
    bank_dir: bankDir,
    cues,
  };
}

async function listWavs(root) {
  const out = [];
  async function walk(dir) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(filePath);
      else if (entry.isFile() && /\.wav$/i.test(entry.name)) out.push(filePath);
    }
  }
  await walk(root);
  return out.sort();
}

async function mediaDuration(filePath) {
  try {
    const { stdout } = await execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", filePath]);
    return Number(stdout.trim());
  } catch {
    return null;
  }
}

function qualityForCue(cueId, prompt) {
  const text = `${cueId} ${prompt}`.toLowerCase();
  const issues = [];
  if (/^incidental_/.test(cueId)) issues.push("auto_incidental_slug_review");
  if (/\b(?:bloom|pressure|energy|aura|truth|destiny|worship|void|reveal tone|family reveal|dramatic|cinematic|tension)\b/.test(text)) {
    issues.push("abstract_prompt_review");
  }
  if (!/\b(?:whoosh|swipe|pop|snap|click|chime|ping|pulse|thump|hit|hush|gasp|laugh|applause|clink|buzz|paper|card|glass|screen|scan|static|door|metal|wood|fabric|phone|camera|flash|bell|rumble|crack|flicker|glitch|beep|tick|ambience|room|rain|crowd)\b/.test(text)) {
    issues.push("missing_concrete_sound_terms");
  }
  return {
    status: issues.length ? "needs_review" : "available",
    issues,
  };
}

async function rebuild() {
  const manifest = normalizeManifest(await readJson(manifestPath, null));
  const wavs = await listWavs(assetRoot);
  let added = 0;
  let updated = 0;
  for (const wavPath of wavs) {
    const cueId = slug(path.basename(path.dirname(wavPath)), "cue");
    const prompt = titleFromCueId(cueId);
    const fileBuffer = await fs.readFile(wavPath);
    const fileHash = sha256(fileBuffer);
    const assetId = `${cueId}_${fileHash.slice(0, 10)}`;
    const quality = qualityForCue(cueId, prompt);
    manifest.cues[cueId] ??= {
      cue_id: cueId,
      aliases: [prompt],
      queries: [prompt],
      generation_prompt: prompt,
      default_duration_sec: null,
      assets: [],
      preferred_asset_id: null,
      tags: [],
      quality_notes: [],
    };
    const cue = manifest.cues[cueId];
    cue.aliases = [...new Set([...(cue.aliases ?? []), prompt])];
    cue.queries = [...new Set([...(cue.queries ?? []), prompt])];
    cue.generation_prompt ??= prompt;
    cue.quality_notes = [...new Set([...(cue.quality_notes ?? []), ...quality.issues])];
    const duration = await mediaDuration(wavPath);
    const existingIndex = (cue.assets ?? []).findIndex((asset) => asset.asset_id === assetId || asset.path === wavPath);
    const asset = {
      asset_id: assetId,
      cue_id: cueId,
      path: wavPath,
      sha256: fileHash,
      source: "sfx_bank_rebuild",
      provider: "unknown_or_legacy_generated",
      model: "unknown",
      endpoint: null,
      prompt,
      prompt_hash: sha256(Buffer.from(prompt)),
      duration_sec: Number.isFinite(duration) ? Number(duration.toFixed(3)) : null,
      generated_at: null,
      status: quality.status,
      validation: {
        status: Number.isFinite(duration) && duration > 0 ? "passed" : "needs_regeneration",
        issues: quality.issues,
        duration_sec: Number.isFinite(duration) ? Number(duration.toFixed(3)) : null,
        technical_gate: "rebuilt from existing WAV; semantic spot-listen still required",
      },
    };
    if (existingIndex >= 0) {
      cue.assets[existingIndex] = { ...cue.assets[existingIndex], ...asset, status: cue.assets[existingIndex].status === "rejected" ? "rejected" : asset.status };
      updated += 1;
    } else {
      cue.assets.push(asset);
      added += 1;
    }
    const preferred = cue.assets.find((row) => row.asset_id === cue.preferred_asset_id && row.status === "available")
      ?? cue.assets.find((row) => row.status === "available");
    cue.preferred_asset_id = preferred?.asset_id ?? cue.preferred_asset_id ?? null;
  }
  manifest.updated_at = nowIso();
  await writeJson(manifestPath, manifest);
  return { status: "rebuilt", manifest_path: manifestPath, cue_count: Object.keys(manifest.cues).length, wav_count: wavs.length, added, updated };
}

function assetRows(manifest) {
  return Object.values(manifest.cues ?? {}).flatMap((cue) => (cue.assets ?? []).map((asset) => ({ cue, asset })));
}

async function audit() {
  const manifest = normalizeManifest(await readJson(manifestPath, null));
  const rows = assetRows(manifest);
  const summary = {
    status: "passed",
    manifest_path: manifestPath,
    cue_count: Object.keys(manifest.cues).length,
    asset_count: rows.length,
    available: rows.filter((row) => row.asset.status === "available").length,
    needs_review: rows.filter((row) => row.asset.status === "needs_review").length,
    needs_regeneration: rows.filter((row) => row.asset.status === "needs_regeneration").length,
    rejected: rows.filter((row) => row.asset.status === "rejected").length,
    missing_files: rows.filter((row) => !row.asset.path || !existsSync(row.asset.path)).length,
    review_samples: rows
      .filter((row) => row.asset.status !== "available")
      .slice(0, 40)
      .map((row) => ({ cue_id: row.cue.cue_id, asset_id: row.asset.asset_id, status: row.asset.status, issues: row.asset.validation?.issues ?? [], path: row.asset.path })),
  };
  console.log(JSON.stringify(summary, null, 2));
}

async function list() {
  const manifest = normalizeManifest(await readJson(manifestPath, null));
  const status = flags.status ?? null;
  const query = String(flags.query ?? flags.q ?? "").toLowerCase();
  const limit = Math.max(1, Math.min(500, Number(flags.limit ?? 80) || 80));
  const rows = assetRows(manifest)
    .filter((row) => !status || row.asset.status === status)
    .filter((row) => !query || `${row.cue.cue_id} ${row.asset.prompt ?? ""} ${(row.asset.validation?.issues ?? []).join(" ")}`.toLowerCase().includes(query))
    .slice(0, limit)
    .map((row) => ({
      cue_id: row.cue.cue_id,
      asset_id: row.asset.asset_id,
      status: row.asset.status,
      preferred: row.cue.preferred_asset_id === row.asset.asset_id,
      duration_sec: row.asset.duration_sec,
      issues: row.asset.validation?.issues ?? [],
      path: row.asset.path,
    }));
  console.log(JSON.stringify({ status: "listed", count: rows.length, rows }, null, 2));
}

async function reject() {
  const cueId = slug(flags.cue ?? flags["cue-id"], "");
  const assetId = flags.asset ?? flags["asset-id"];
  if (!cueId) throw new Error("Pass --cue <cue_id>.");
  const manifest = normalizeManifest(await readJson(manifestPath, null));
  const cue = manifest.cues[cueId];
  if (!cue) throw new Error(`Unknown cue: ${cueId}`);
  const assets = cue.assets ?? [];
  const selected = assetId ? assets.filter((asset) => asset.asset_id === assetId) : assets;
  if (!selected.length) throw new Error(`No matching assets for ${cueId}${assetId ? ` / ${assetId}` : ""}`);
  for (const asset of selected) asset.status = "rejected";
  if (selected.some((asset) => asset.asset_id === cue.preferred_asset_id)) {
    cue.preferred_asset_id = assets.find((asset) => asset.status === "available")?.asset_id ?? null;
  }
  manifest.updated_at = nowIso();
  await writeJson(manifestPath, manifest);
  console.log(JSON.stringify({ status: "rejected", cue_id: cueId, rejected_count: selected.length, preferred_asset_id: cue.preferred_asset_id }, null, 2));
}

async function prefer() {
  const cueId = slug(flags.cue ?? flags["cue-id"], "");
  const assetId = flags.asset ?? flags["asset-id"];
  if (!cueId || !assetId) throw new Error("Pass --cue <cue_id> --asset <asset_id>.");
  const manifest = normalizeManifest(await readJson(manifestPath, null));
  const cue = manifest.cues[cueId];
  const asset = cue?.assets?.find((row) => row.asset_id === assetId);
  if (!asset) throw new Error(`Unknown cue/asset: ${cueId} / ${assetId}`);
  asset.status = "available";
  cue.preferred_asset_id = assetId;
  manifest.updated_at = nowIso();
  await writeJson(manifestPath, manifest);
  console.log(JSON.stringify({ status: "preferred", cue_id: cueId, preferred_asset_id: assetId }, null, 2));
}

if (command === "rebuild") console.log(JSON.stringify(await rebuild(), null, 2));
else if (command === "audit") await audit();
else if (command === "list") await list();
else if (command === "reject") await reject();
else if (command === "prefer") await prefer();
else {
  console.log(`Usage:
  node scripts/sfx-bank-maintain.mjs rebuild
  node scripts/sfx-bank-maintain.mjs audit
  node scripts/sfx-bank-maintain.mjs list [--status available|needs_review|rejected] [--query text]
  node scripts/sfx-bank-maintain.mjs reject --cue <cue_id> [--asset <asset_id>]
  node scripts/sfx-bank-maintain.mjs prefer --cue <cue_id> --asset <asset_id>`);
}
