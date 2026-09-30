#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { generateModelslabImage } from "./modelslab-image-helper.mjs";
import {
  configuredModelslabProfiles,
  loadConfiguredModelslabAccounts,
  publicModelslabAccount,
} from "./lib/modelslab-account-pool.mjs";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flags = parseFlags(process.argv.slice(2));
const action = String(flags.action ?? "generate").trim().toLowerCase();
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeDir = path.resolve(flags["episode-dir"] ?? path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode));
const planPath = path.resolve(flags.plan ?? path.join(episodeDir, `vehicle_qwen_recovery_plan_${episode}.json`));
const outputDir = path.resolve(flags["output-dir"] ?? path.join(episodeDir, "review_samples", "qwen_vehicle_recovery"));
const reportPath = path.resolve(flags.report ?? path.join(outputDir, `qwen_vehicle_recovery_report_${episode}.json`));
const decisionsPath = path.resolve(flags.decisions ?? path.join(outputDir, `qwen_vehicle_recovery_decisions_${episode}.json`));
const repairPromptsPath = flags["repair-prompts"] ? path.resolve(flags["repair-prompts"]) : null;
const selectionLedgerPaths = String(flags["selection-ledgers"] ?? flags["selection-ledger"] ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => path.resolve(entry));
const imagegenReportPath = path.resolve(flags["imagegen-report"] ?? path.join(episodeDir, `imagegen_report_${episode}.json`));
const promptPlanPath = path.resolve(flags.prompts ?? path.join(episodeDir, "section_image_prompts_hardened.json"));
const cutLedgerPath = path.resolve(flags.ledger ?? path.join(episodeDir, "cut_execution_ledger.json"));
const modelslabProfiles = configuredModelslabProfiles({ flagValue: flags["modelslab-profiles"] });
const concurrency = boundedInteger(flags.concurrency, 15, 1, 30);
const workflowBypass = boolFlag(flags["workflow-bypass"]);
const operatorAuthorizedRetry = boolFlag(flags["operator-authorized-retry"]);

function parseFlags(parts) {
  const parsed = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const equalsIndex = part.indexOf("=", 2);
    if (equalsIndex !== -1) {
      parsed[part.slice(2, equalsIndex)] = part.slice(equalsIndex + 1);
      continue;
    }
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--") ? parts[index + 1] : "true";
    parsed[key] = value;
    if (value !== "true") index += 1;
  }
  return parsed;
}

function boolFlag(value) {
  return /^(true|1|yes)$/i.test(String(value ?? "false"));
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? Math.round(parsed) : fallback));
}

function ids(value) {
  return new Set(String(value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(filePath) {
  return sha256(await fs.readFile(filePath));
}

async function exists(filePath) {
  return Boolean(filePath) && fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
}

async function readJson(filePath, fallback = null) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); } catch { return fallback; }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function copyAtomic(sourcePath, outputPath) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.${Date.now()}.tmp.png`;
  await fs.copyFile(sourcePath, temporary);
  await assertRaster(temporary);
  await fs.rename(temporary, outputPath);
}

async function assertRaster(filePath) {
  const metadata = await sharp(filePath, { failOn: "error" }).metadata();
  const width = Number(metadata.width ?? 0);
  const height = Number(metadata.height ?? 0);
  if (!(width > height) || Math.abs(width / height - 16 / 9) > 0.08) {
    throw new Error(`Qwen recovery raster must be 16:9 landscape: ${filePath} (${width}x${height}).`);
  }
  return { width, height };
}

function planItems(plan) {
  const rows = Array.isArray(plan?.items) ? plan.items : Array.isArray(plan?.cases) ? plan.cases : [];
  return rows.map((row) => ({
    ...row,
    image_id: String(row.image_id ?? "").trim(),
    qwen_prompt: String(row.qwen_prompt ?? row.prompt ?? "").trim(),
  }));
}

export async function validatePlan(plan, { allowMutableTargetDrift = false } = {}) {
  if (plan?.schema !== "goldflow_qwen_vehicle_recovery_plan_v1") {
    throw new Error(`Unsupported Qwen vehicle recovery plan schema: ${plan?.schema ?? "<missing>"}.`);
  }
  if (!plan || !["passed", "approved"].includes(String(plan.status ?? ""))) {
    throw new Error(`Qwen vehicle recovery requires an approved plan: ${planPath}`);
  }
  const items = planItems(plan);
  if (!items.length) throw new Error("Qwen vehicle recovery plan contains no items.");
  const seen = new Set();
  for (const item of items) {
    if (!item.image_id || seen.has(item.image_id)) throw new Error(`Duplicate or missing recovery image_id: ${item.image_id || "<missing>"}.`);
    if (!item.qwen_prompt) throw new Error(`Recovery item ${item.image_id} has no Qwen prompt.`);
    seen.add(item.image_id);
  }
  const sourceEntries = Object.entries(plan.source_hashes ?? {});
  if (!sourceEntries.length) throw new Error("Qwen vehicle recovery plan requires hash-bound source artifacts.");
  for (const [sourceName, sourceValue] of sourceEntries) {
    const sourcePath = typeof sourceValue === "string" ? sourceName : sourceValue?.path;
    const expectedHash = typeof sourceValue === "string" ? sourceValue : sourceValue?.sha256;
    const mutablePromotionTarget = allowMutableTargetDrift
      && sourcePath
      && path.resolve(sourcePath) === imagegenReportPath;
    if (!sourcePath || !expectedHash || (!mutablePromotionTarget && await hashFile(sourcePath).catch(() => null) !== expectedHash)) {
      throw new Error(`Qwen vehicle recovery plan source is stale: ${sourceName} (${sourcePath ?? "missing path"})`);
    }
  }
  return items;
}

export function decisionMatchesAttempt(decision, attempt, expectedPrompt = null) {
  return Boolean(attempt
    && attempt.status === "passed"
    && Number(decision?.attempt_index) === Number(attempt.attempt_index)
    && decision?.candidate_path === attempt.candidate_path
    && decision?.candidate_sha256 === attempt.candidate_sha256
    && decision?.prompt_sha256 === attempt.prompt_sha256
    && attempt.prompt_sha256 === sha256(String(attempt.prompt ?? ""))
    && (expectedPrompt == null || attempt.prompt_sha256 === sha256(String(expectedPrompt))));
}

// Retain the original export for callers/tests written before best-of-attempt selection.
export const decisionMatchesLatestAttempt = decisionMatchesAttempt;

export function resolveSelectedAttempt(attempts, selection, { requireCandidateBinding = true } = {}) {
  const imageId = String(selection?.image_id ?? "").trim();
  const rawAttemptIndex = selection?.selected_attempt_index ?? selection?.attempt_index;
  const attemptIndex = Number(rawAttemptIndex);
  if (!imageId || !Number.isInteger(attemptIndex) || attemptIndex < 1) {
    throw new Error(`Candidate selection needs image_id and a positive selected_attempt_index: ${imageId || "<missing>"}.`);
  }
  const matches = (attempts ?? []).filter((attempt) => String(attempt?.image_id ?? "") === imageId
    && Number(attempt?.attempt_index) === attemptIndex);
  if (matches.length !== 1) {
    throw new Error(`Candidate selection must resolve exactly one attempt: ${imageId} attempt ${attemptIndex}.`);
  }
  const attempt = matches[0];
  if (attempt.status !== "passed" || !attempt.candidate_path || !attempt.candidate_sha256) {
    throw new Error(`Candidate selection resolves to a failed or missing attempt: ${imageId} attempt ${attemptIndex}.`);
  }
  const selectedPath = selection?.selected_candidate_path ?? selection?.candidate_path;
  const selectedHash = selection?.selected_candidate_sha256 ?? selection?.candidate_sha256;
  if (requireCandidateBinding && (!selectedPath || !selectedHash)) {
    throw new Error(`Candidate selection must bind the exact path and hash: ${imageId} attempt ${attemptIndex}.`);
  }
  if ((selectedPath && selectedPath !== attempt.candidate_path)
    || (selectedHash && selectedHash !== attempt.candidate_sha256)) {
    throw new Error(`Candidate selection path/hash is stale: ${imageId} attempt ${attemptIndex}.`);
  }
  return attempt;
}

async function loadRepairPromptOverrides({ planHash, items, selectedIds }) {
  if (!repairPromptsPath) return { byId: new Map(), path: null, sha256: null };
  const ledger = await readJson(repairPromptsPath);
  if (ledger?.schema !== "goldflow_qwen_vehicle_repair_prompts_v1" || ledger?.status !== "approved") {
    throw new Error(`Qwen repair prompts must be an approved goldflow_qwen_vehicle_repair_prompts_v1 ledger: ${repairPromptsPath}`);
  }
  if (ledger.base_plan_sha256 !== planHash) {
    throw new Error(`Qwen repair prompt ledger is stale for the current recovery plan: ${repairPromptsPath}`);
  }
  const itemById = new Map(items.map((item) => [item.image_id, item]));
  const rows = Array.isArray(ledger.items) ? ledger.items : [];
  const byId = new Map();
  for (const row of rows) {
    const imageId = String(row?.image_id ?? "").trim();
    const prompt = String(row?.repair_prompt ?? row?.prompt ?? "").trim();
    const item = itemById.get(imageId);
    if (!item || !prompt || byId.has(imageId)) {
      throw new Error(`Invalid or duplicate Qwen repair prompt row: ${imageId || "<missing>"}.`);
    }
    if (row.prior_prompt_sha256 !== sha256(item.qwen_prompt)) {
      throw new Error(`Qwen repair prompt prior hash does not match the approved base prompt: ${imageId}.`);
    }
    byId.set(imageId, { ...row, image_id: imageId, repair_prompt: prompt });
  }
  const missing = [...selectedIds].filter((imageId) => !byId.has(imageId));
  if (missing.length) {
    throw new Error(`Every selected repair cut needs a hash-bound repair prompt. Missing: ${missing.join(", ")}`);
  }
  return { byId, path: repairPromptsPath, sha256: await hashFile(repairPromptsPath) };
}

export function profileForAttempt({ profiles, itemIndex, priorAttempts = [] }) {
  if (!profiles.length) throw new Error("At least one ModelsLab account profile is required.");
  const priorSlot = Number(priorAttempts.at(-1)?.account_slot ?? 0);
  if (priorAttempts.length && profiles.length > 1 && priorSlot > 0) return ((priorSlot % profiles.length) + 1);
  return (itemIndex % profiles.length) + 1;
}

export function mergeImagegenResults(priorResults, replacements, expectedIds) {
  const priorIds = (priorResults ?? []).map((row) => String(row?.image_id ?? ""));
  if (new Set(priorIds).size !== priorIds.length) throw new Error("Prior imagegen report contains duplicate image IDs.");
  const replacementIds = replacements.map((row) => String(row?.image_id ?? ""));
  if (new Set(replacementIds).size !== replacementIds.length) throw new Error("Replacement batch contains duplicate image IDs.");
  const replacementById = new Map(replacements.map((row) => [String(row.image_id), row]));
  const merged = [];
  for (const row of priorResults ?? []) {
    const imageId = String(row?.image_id ?? "");
    if (!expectedIds.has(imageId)) continue;
    merged.push(replacementById.get(imageId) ?? row);
    replacementById.delete(imageId);
  }
  for (const [imageId, row] of replacementById) {
    if (!expectedIds.has(imageId)) throw new Error(`Replacement is outside the prompt plan: ${imageId}`);
    merged.push(row);
  }
  const sorted = merged.sort((left, right) => String(left.image_id).localeCompare(String(right.image_id), undefined, { numeric: true }));
  const mergedIds = new Set(sorted.map((row) => String(row.image_id)));
  if (sorted.length !== expectedIds.size || mergedIds.size !== expectedIds.size
    || [...expectedIds].some((imageId) => !mergedIds.has(imageId))) {
    throw new Error("Merged imagegen results do not exactly cover the hardened prompt plan.");
  }
  return sorted;
}

async function mapLimited(rows, limit, mapper) {
  const results = new Array(rows.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, rows.length) }, async () => {
    while (cursor < rows.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(rows[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function latestAttempts(attempts) {
  const latest = new Map();
  for (const attempt of attempts ?? []) {
    const current = latest.get(attempt.image_id);
    if (!current || Number(attempt.attempt_index) > Number(current.attempt_index)) latest.set(attempt.image_id, attempt);
  }
  return latest;
}

function svgEscape(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function writeContactSheets(attempts, basename = "qwen_vehicle_candidates") {
  const passed = attempts.filter((row) => row.status === "passed" && row.candidate_path);
  const pages = [];
  for (let offset = 0; offset < passed.length; offset += 20) {
    const rows = passed.slice(offset, offset + 20);
    const width = 480;
    const imageHeight = 270;
    const labelHeight = 70;
    const columns = 4;
    const composites = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const image = await sharp(row.candidate_path).resize({ width, height: imageHeight, fit: "contain", background: "#080808" }).jpeg().toBuffer();
      const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${labelHeight}"><rect width="100%" height="100%" fill="#101218"/><text x="12" y="25" fill="#fff" font-family="Arial" font-size="16" font-weight="700">${svgEscape(row.image_id)}</text><text x="12" y="50" fill="#b9c2d0" font-family="Arial" font-size="13">attempt ${row.attempt_index} • account ${row.account_slot} • ${svgEscape(row.label ?? "vehicle shot")}</text></svg>`);
      const tile = await sharp({ create: { width, height: imageHeight + labelHeight, channels: 3, background: "#101218" } })
        .composite([{ input: image, top: 0, left: 0 }, { input: label, top: imageHeight, left: 0 }])
        .jpeg({ quality: 90 })
        .toBuffer();
      composites.push({ input: tile, left: (index % columns) * width, top: Math.floor(index / columns) * (imageHeight + labelHeight) });
    }
    const page = Math.floor(offset / 20) + 1;
    const pagePath = path.join(outputDir, `${basename}-page-${String(page).padStart(2, "0")}.jpg`);
    await sharp({ create: { width: columns * width, height: Math.ceil(rows.length / columns) * (imageHeight + labelHeight), channels: 3, background: "#080808" } })
      .composite(composites)
      .jpeg({ quality: 90 })
      .toFile(pagePath);
    pages.push(pagePath);
  }
  return pages;
}

async function generate() {
  if (!workflowBypass) throw new Error("Qwen vehicle recovery is an operator-directed post-QA recovery; pass --workflow-bypass true.");
  const plan = await readJson(planPath);
  const items = await validatePlan(plan);
  const planHash = await hashFile(planPath);
  const requested = ids(flags["cut-ids"] ?? flags["image-ids"]);
  const selected = requested.size ? items.filter((row) => requested.has(row.image_id)) : items;
  if (!selected.length || (requested.size && selected.length !== requested.size)) throw new Error("Recovery cut scope is empty or contains unknown IDs.");
  const repairPrompts = await loadRepairPromptOverrides({
    planHash,
    items,
    selectedIds: new Set(selected.map((row) => row.image_id)),
  });
  const effectiveSelected = selected.map((item) => {
    const override = repairPrompts.byId.get(item.image_id);
    return {
      ...item,
      generation_prompt: override?.repair_prompt ?? item.qwen_prompt,
      generation_prompt_source: override ? "approved_repair_prompt" : "approved_base_plan",
      repair_prompt_reason: override?.rejection_reason ?? override?.reason ?? null,
    };
  });
  const priorReport = await readJson(reportPath, { attempts: [] });
  if (priorReport?.attempts?.length) {
    if (priorReport.schema !== "goldflow_qwen_vehicle_recovery_report_v1"
      || priorReport.channel !== channel
      || priorReport.series_slug !== series
      || priorReport.week !== week
      || priorReport.episode !== episode
      || priorReport.plan_sha256 !== planHash) {
      throw new Error("Existing Qwen vehicle recovery report does not match the current identity and plan hash.");
    }
    const itemById = new Map(items.map((row) => [row.image_id, row]));
    for (const attempt of priorReport.attempts) {
      const item = itemById.get(String(attempt.image_id));
      if (!item || attempt.prompt_sha256 !== sha256(String(attempt.prompt ?? "")) || attempt.plan_sha256 !== planHash) {
        throw new Error(`Existing Qwen attempt is stale or outside the current plan: ${attempt.image_id ?? "<missing>"}.`);
      }
    }
  }
  const priorAttempts = Array.isArray(priorReport?.attempts) ? priorReport.attempts : [];
  const attemptsById = new Map();
  for (const attempt of priorAttempts) {
    const rows = attemptsById.get(attempt.image_id) ?? [];
    rows.push(attempt);
    attemptsById.set(attempt.image_id, rows);
  }
  const decisions = await readJson(decisionsPath, { decisions: [] });
  const decisionById = new Map((decisions.decisions ?? []).map((row) => [row.image_id, row]));
  for (const item of effectiveSelected) {
    const history = attemptsById.get(item.image_id) ?? [];
    if (!history.length) continue;
    const latest = history.sort((a, b) => Number(a.attempt_index) - Number(b.attempt_index)).at(-1);
    const decision = decisionById.get(item.image_id);
    const retryNeeded = latest.status !== "passed" || (decision?.decision === "rejected" && decision.candidate_sha256 === latest.candidate_sha256);
    if (!retryNeeded) throw new Error(`Refusing to resubmit passed, unrejected Qwen candidate ${item.image_id}.`);
    if (!operatorAuthorizedRetry) throw new Error(`Retry for ${item.image_id} requires --operator-authorized-retry true.`);
  }
  const accounts = await loadConfiguredModelslabAccounts(modelslabProfiles, { cwd: repoRoot });
  const batchId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${sha256(effectiveSelected.map((row) => `${row.image_id}:${sha256(row.generation_prompt)}`).join("\n")).slice(0, 8)}`;
  const startedMs = Date.now();
  const nextAttempts = await mapLimited(effectiveSelected, concurrency, async (item, itemIndex) => {
    const history = attemptsById.get(item.image_id) ?? [];
    const attemptIndex = Math.max(0, ...history.map((row) => Number(row.attempt_index) || 0)) + 1;
    const accountSlot = profileForAttempt({ profiles: modelslabProfiles, itemIndex, priorAttempts: history });
    const account = accounts[accountSlot - 1];
    const promptHash = sha256(item.generation_prompt);
    const candidateDir = path.join(outputDir, "candidates", item.image_id);
    const candidatePath = path.join(candidateDir, `${item.image_id}-qwen-${promptHash.slice(0, 10)}-attempt-${String(attemptIndex).padStart(2, "0")}.png`);
    const startedAt = new Date().toISOString();
    try {
      if (await exists(candidatePath)) throw new Error(`Versioned candidate already exists: ${candidatePath}`);
      const generated = await generateModelslabImage({
        prompt: item.generation_prompt,
        outputPath: candidatePath,
        referenceImagePaths: [],
        model: "qwen",
        width: 1024,
        height: 576,
        enhancePrompt: false,
        account,
      });
      const geometry = await assertRaster(candidatePath);
      return {
        image_id: item.image_id,
        label: item.label ?? item.scope_reason ?? null,
        attempt_index: attemptIndex,
        batch_id: batchId,
        status: "passed",
        prompt: item.generation_prompt,
        prompt_sha256: promptHash,
        prompt_source: item.generation_prompt_source,
        repair_prompt_reason: item.repair_prompt_reason,
        repair_prompt_ledger_path: repairPrompts.path,
        repair_prompt_ledger_sha256: repairPrompts.sha256,
        plan_sha256: planHash,
        reference_count: 0,
        candidate_path: candidatePath,
        candidate_sha256: await hashFile(candidatePath),
        geometry,
        model: "qwen",
        endpoint: generated.modelslab_endpoint,
        request_id: generated.modelslab_request_id,
        account_slot: accountSlot,
        modelslab_account: publicModelslabAccount(account),
        estimated_cost_usd: generated.estimated_cost_usd ?? null,
        cost_basis: generated.cost_basis ?? null,
        creative_submission_count: 1,
        automatic_retry_count: 0,
        wall_time_sec: Number((generated.modelslab_elapsed_ms / 1000).toFixed(3)),
        started_at: startedAt,
        completed_at: new Date().toISOString(),
      };
    } catch (error) {
      return {
        image_id: item.image_id,
        label: item.label ?? item.scope_reason ?? null,
        attempt_index: attemptIndex,
        batch_id: batchId,
        status: "failed",
        prompt: item.generation_prompt,
        prompt_sha256: promptHash,
        prompt_source: item.generation_prompt_source,
        repair_prompt_reason: item.repair_prompt_reason,
        repair_prompt_ledger_path: repairPrompts.path,
        repair_prompt_ledger_sha256: repairPrompts.sha256,
        plan_sha256: planHash,
        reference_count: 0,
        candidate_path: null,
        candidate_sha256: null,
        model: "qwen",
        endpoint: "/api/v6/images/text2img",
        account_slot: accountSlot,
        modelslab_account: publicModelslabAccount(account),
        creative_submission_count: 1,
        automatic_retry_count: 0,
        error: error instanceof Error ? error.message : String(error),
        started_at: startedAt,
        completed_at: new Date().toISOString(),
      };
    }
  });
  const attempts = [...priorAttempts, ...nextAttempts];
  const latest = [...latestAttempts(attempts).values()].sort((a, b) => a.image_id.localeCompare(b.image_id, undefined, { numeric: true }));
  const unresolvedImageIds = items.map((row) => row.image_id).filter((imageId) => latestAttempts(attempts).get(imageId)?.status !== "passed");
  const contactSheets = await writeContactSheets(latest, `qwen_vehicle_candidates_${batchId}`);
  const batches = [...(priorReport?.batches ?? []), {
    batch_id: batchId,
    cut_ids: effectiveSelected.map((row) => row.image_id),
    repair_prompt_ledger_path: repairPrompts.path,
    repair_prompt_ledger_sha256: repairPrompts.sha256,
    account_slots: [...new Set(nextAttempts.map((row) => row.account_slot))],
    passed_count: nextAttempts.filter((row) => row.status === "passed").length,
    failed_count: nextAttempts.filter((row) => row.status === "failed").length,
    contact_sheets: contactSheets,
    wall_time_sec: Number(((Date.now() - startedMs) / 1000).toFixed(3)),
    updated_at: new Date().toISOString(),
  }];
  const report = {
    schema: "goldflow_qwen_vehicle_recovery_report_v1",
    status: unresolvedImageIds.length ? "partial" : "passed",
    current_batch_status: nextAttempts.every((row) => row.status === "passed") ? "passed" : "partial",
    channel,
    series_slug: series,
    week,
    episode,
    plan_path: planPath,
    plan_sha256: planHash,
    provider: "modelslab",
    model: "qwen",
    endpoint: "/api/v6/images/text2img",
    generation_contract: "zero_references_layout_first_one_creative_submission_per_attempt",
    account_pool: accounts.map((account, index) => ({ account_slot: index + 1, ...publicModelslabAccount(account) })),
    attempts,
    latest_attempts: latest,
    batches,
    creative_submission_count: attempts.length,
    automatic_retry_count: 0,
    expected_image_count: items.length,
    completed_image_count: items.length - unresolvedImageIds.length,
    unresolved_image_ids: unresolvedImageIds,
    updated_at: new Date().toISOString(),
  };
  await writeJsonAtomic(reportPath, report);
  await writeImmutableBatchReport(report, batches.at(-1), nextAttempts);
  console.log(JSON.stringify({ status: report.status, passed: nextAttempts.filter((row) => row.status === "passed").length, failed: nextAttempts.filter((row) => row.status === "failed").length, account_slots_used: batches.at(-1).account_slots, report_path: reportPath, contact_sheets: contactSheets }, null, 2));
  if (nextAttempts.some((row) => row.status === "failed")) process.exitCode = 2;
}

async function writeImmutableBatchReport(report, batch, attempts) {
  const immutableDir = path.join(episodeDir, "reports", "imagegen-batches");
  const immutablePath = path.join(immutableDir, `qwen_vehicle_${batch.batch_id}.json`);
  if (await exists(immutablePath)) {
    const current = await readJson(immutablePath);
    if (current?.batch_id === batch.batch_id && current?.report_sha256 === await hashFile(reportPath)) return immutablePath;
    throw new Error(`Immutable Qwen batch report already exists with different content: ${immutablePath}`);
  }
  await writeJsonAtomic(immutablePath, {
    schema: "goldflow_imagegen_batch_report_v1",
    status: batch.failed_count ? "partial" : "passed",
    batch_kind: "modelslab_qwen_text2img_vehicle_recovery",
    channel,
    series_slug: series,
    week,
    episode,
    batch_id: batch.batch_id,
    plan_path: planPath,
    plan_sha256: report.plan_sha256,
    report_path: reportPath,
    report_sha256: await hashFile(reportPath),
    account_slots: batch.account_slots,
    creative_submission_count: attempts.length,
    automatic_retry_count: 0,
    estimated_cost_usd: attempts.reduce((sum, row) => sum + Number(row.estimated_cost_usd ?? 0), 0) || null,
    wall_time_sec: batch.wall_time_sec,
    attempts,
    updated_at: new Date().toISOString(),
  });
  return immutablePath;
}

async function prepareRepairPrompts() {
  if (!workflowBypass) throw new Error("Preparing Qwen repair prompts requires --workflow-bypass true.");
  if (!repairPromptsPath) throw new Error("--repair-prompts must name the output ledger path.");
  const sourcePaths = String(flags["repair-prompt-sources"] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(entry));
  if (!sourcePaths.length) throw new Error("--repair-prompt-sources must name one or more reviewed prompt-array files.");
  const [plan, report, decisions] = await Promise.all([
    readJson(planPath), readJson(reportPath), readJson(decisionsPath),
  ]);
  const items = await validatePlan(plan);
  const planHash = await hashFile(planPath);
  const reportHash = await hashFile(reportPath);
  if (report?.schema !== "goldflow_qwen_vehicle_recovery_report_v1"
    || decisions?.schema !== "goldflow_qwen_vehicle_recovery_decisions_v1"
    || report.plan_sha256 !== planHash
    || decisions.report_sha256 !== reportHash) {
    throw new Error("Qwen repair prompts require a current plan/report/decision chain.");
  }
  const rejectedIds = new Set((decisions.decisions ?? [])
    .filter((row) => row.decision === "rejected")
    .map((row) => String(row.image_id)));
  const itemById = new Map(items.map((item) => [item.image_id, item]));
  const merged = new Map();
  for (const sourcePath of sourcePaths) {
    const value = await readJson(sourcePath);
    const rows = Array.isArray(value) ? value : value?.items;
    if (!Array.isArray(rows)) throw new Error(`Qwen repair prompt source must be an array: ${sourcePath}`);
    for (const row of rows) {
      const imageId = String(row?.image_id ?? "").trim();
      const item = itemById.get(imageId);
      const repairPrompt = String(row?.repair_prompt ?? "").trim();
      if (!rejectedIds.has(imageId) || !item || !repairPrompt || merged.has(imageId)) {
        throw new Error(`Invalid, duplicate, or non-rejected Qwen repair prompt: ${imageId || "<missing>"}.`);
      }
      if (row.prior_prompt_sha256 !== sha256(item.qwen_prompt)) {
        throw new Error(`Qwen repair prompt source is stale for ${imageId}.`);
      }
      merged.set(imageId, {
        image_id: imageId,
        prior_prompt_sha256: row.prior_prompt_sha256,
        rejection_reason: String(row.rejection_reason ?? "").trim(),
        repair_prompt: repairPrompt,
      });
    }
  }
  const missing = [...rejectedIds].filter((imageId) => !merged.has(imageId));
  if (missing.length || merged.size !== rejectedIds.size) {
    throw new Error(`Repair prompt sources must exactly cover rejected IDs. Missing: ${missing.join(", ") || "none"}.`);
  }
  const ordered = items.filter((item) => rejectedIds.has(item.image_id)).map((item) => merged.get(item.image_id));
  const approvedBy = String(flags["approved-by"] ?? "").trim();
  const note = String(flags.note ?? "").trim();
  if (!approvedBy || !note) throw new Error("--approved-by and --note are required.");
  await writeJsonAtomic(repairPromptsPath, {
    schema: "goldflow_qwen_vehicle_repair_prompts_v1",
    status: "approved",
    channel,
    series_slug: series,
    week,
    episode,
    base_plan_path: planPath,
    base_plan_sha256: planHash,
    decisions_path: decisionsPath,
    decisions_sha256: await hashFile(decisionsPath),
    source_files: await Promise.all(sourcePaths.map(async (sourcePath) => ({ path: sourcePath, sha256: await hashFile(sourcePath) }))),
    approved_by: approvedBy,
    note,
    item_count: ordered.length,
    items: ordered,
    approved_at: new Date().toISOString(),
  });
  console.log(JSON.stringify({ status: "passed", item_count: ordered.length, repair_prompts_path: repairPromptsPath }, null, 2));
}

async function review() {
  const report = await readJson(reportPath);
  if (!report?.attempts?.length) throw new Error(`Missing Qwen recovery candidates: ${reportPath}`);
  const reviewer = String(flags.reviewer ?? "").trim();
  const note = String(flags.note ?? "").trim();
  if (!reviewer || !note) throw new Error("--reviewer and --note are required.");
  const prior = await readJson(decisionsPath, { decisions: [] });
  const byId = new Map((prior.decisions ?? []).map((row) => [row.image_id, row]));

  if (selectionLedgerPaths.length) {
    const selectedRows = new Map();
    for (const ledgerPath of selectionLedgerPaths) {
      const ledger = await readJson(ledgerPath);
      const rows = Array.isArray(ledger)
        ? ledger
        : Array.isArray(ledger?.decisions)
          ? ledger.decisions
          : Array.isArray(ledger?.items)
            ? ledger.items
            : Array.isArray(ledger?.selections)
              ? ledger.selections
              : null;
      if (!rows) throw new Error(`Qwen selection ledger has no decisions/items/selections array: ${ledgerPath}`);
      for (const row of rows) {
        const imageId = String(row?.image_id ?? "").trim();
        if (!imageId || selectedRows.has(imageId)) {
          throw new Error(`Duplicate or missing Qwen candidate selection: ${imageId || "<missing>"}.`);
        }
        const rawDecision = String(row?.decision ?? row?.status ?? "").trim().toLowerCase();
        const decision = ["accepted", "approved", "approve", "pass", "passed"].includes(rawDecision)
          ? "accepted"
          : ["rejected", "reject", "failed", "fail"].includes(rawDecision)
            ? "rejected"
            : null;
        if (!decision) throw new Error(`Invalid Qwen selection decision for ${imageId}: ${rawDecision || "<missing>"}.`);
        selectedRows.set(imageId, { ...row, image_id: imageId, decision, selection_ledger_path: ledgerPath });
      }
    }
    const requested = ids(flags["cut-ids"] ?? flags["image-ids"]);
    if (requested.size && (requested.size !== selectedRows.size || [...requested].some((imageId) => !selectedRows.has(imageId)))) {
      throw new Error("--cut-ids/--image-ids must exactly match the supplied Qwen selection ledgers.");
    }
    for (const [imageId, row] of selectedRows) {
      const selectedPath = row.selected_candidate_path ?? row.candidate_path;
      const normalizedSelection = {
        ...row,
        selected_candidate_path: selectedPath && !path.isAbsolute(selectedPath)
          ? path.resolve(episodeDir, selectedPath)
          : selectedPath,
      };
      const candidate = resolveSelectedAttempt(report.attempts, normalizedSelection);
      if (await hashFile(candidate.candidate_path) !== candidate.candidate_sha256) {
        throw new Error(`Candidate hash changed for ${imageId} attempt ${candidate.attempt_index}.`);
      }
      byId.set(imageId, {
        image_id: imageId,
        attempt_index: candidate.attempt_index,
        candidate_path: candidate.candidate_path,
        candidate_sha256: candidate.candidate_sha256,
        prompt_sha256: candidate.prompt_sha256,
        decision: row.decision,
        reason: String(row.reason ?? row.rejection_reason ?? row.note ?? "").trim(),
        advisories: Array.isArray(row.advisories) ? row.advisories.map(String) : [],
        selection_ledger_path: row.selection_ledger_path,
        selection_ledger_sha256: await hashFile(row.selection_ledger_path),
        reviewer: String(row.reviewer ?? reviewer).trim() || reviewer,
        note,
        updated_at: new Date().toISOString(),
      });
    }
  } else {
  const approveIds = ids(flags["approve-ids"]);
  const rejectIds = ids(flags["reject-ids"]);
  for (const imageId of approveIds) if (rejectIds.has(imageId)) throw new Error(`${imageId} cannot be approved and rejected.`);
  const selected = ids(flags["cut-ids"] ?? flags["image-ids"]);
  const latest = latestAttempts(report.attempts);
  const reviewIds = selected.size ? [...selected] : [...latest.keys()];
  const unknown = reviewIds.filter((imageId) => !latest.has(imageId) || latest.get(imageId).status !== "passed");
  if (unknown.length) throw new Error(`Cannot review missing/failed latest candidates: ${unknown.join(", ")}`);
  const undecided = reviewIds.filter((imageId) => !approveIds.has(imageId) && !rejectIds.has(imageId));
  if (undecided.length) throw new Error(`Every selected Qwen candidate needs a decision. Missing: ${undecided.join(", ")}`);
  for (const imageId of reviewIds) {
    const candidate = latest.get(imageId);
    if (await hashFile(candidate.candidate_path) !== candidate.candidate_sha256) throw new Error(`Candidate hash changed for ${imageId}.`);
    byId.set(imageId, {
      image_id: imageId,
      attempt_index: candidate.attempt_index,
      candidate_path: candidate.candidate_path,
      candidate_sha256: candidate.candidate_sha256,
      prompt_sha256: candidate.prompt_sha256,
      decision: approveIds.has(imageId) ? "accepted" : "rejected",
      reviewer,
      note,
      updated_at: new Date().toISOString(),
    });
  }
  }
  const decisions = [...byId.values()].sort((a, b) => a.image_id.localeCompare(b.image_id, undefined, { numeric: true }));
  const output = {
    schema: "goldflow_qwen_vehicle_recovery_decisions_v1",
    status: "passed",
    report_path: reportPath,
    report_sha256: await hashFile(reportPath),
    accepted_count: decisions.filter((row) => row.decision === "accepted").length,
    rejected_count: decisions.filter((row) => row.decision === "rejected").length,
    selection_ledgers: await Promise.all(selectionLedgerPaths.map(async (ledgerPath) => ({
      path: ledgerPath,
      sha256: await hashFile(ledgerPath),
    }))),
    reviewer,
    note,
    decisions,
    updated_at: new Date().toISOString(),
  };
  await writeJsonAtomic(decisionsPath, output);
  console.log(JSON.stringify({ status: output.status, accepted_count: output.accepted_count, rejected_count: output.rejected_count, decisions_path: decisionsPath }, null, 2));
}

async function promote() {
  if (!workflowBypass) throw new Error("Qwen promotion is a scoped post-QA recovery; pass --workflow-bypass true.");
  const [plan, report, decisions, promptPlan, imagegenReport, cutLedger] = await Promise.all([
    readJson(planPath), readJson(reportPath), readJson(decisionsPath), readJson(promptPlanPath), readJson(imagegenReportPath), readJson(cutLedgerPath),
  ]);
  const items = await validatePlan(plan, { allowMutableTargetDrift: true });
  if (report?.schema !== "goldflow_qwen_vehicle_recovery_report_v1" || !Array.isArray(report.attempts)) throw new Error(`Invalid Qwen report: ${reportPath}`);
  if (decisions?.schema !== "goldflow_qwen_vehicle_recovery_decisions_v1") throw new Error(`Invalid Qwen decisions: ${decisionsPath}`);
  if (promptPlan?.status !== "passed" || !Array.isArray(promptPlan.prompts)) throw new Error(`Missing prompt plan: ${promptPlanPath}`);
  if (imagegenReport?.status !== "passed" || !Array.isArray(imagegenReport.results)) throw new Error(`Missing imagegen report: ${imagegenReportPath}`);
  if (!Array.isArray(cutLedger?.cuts)) throw new Error(`Missing cut execution ledger: ${cutLedgerPath}`);
  const planHash = await hashFile(planPath);
  const reportHash = await hashFile(reportPath);
  const decisionsHash = await hashFile(decisionsPath);
  if (report.plan_sha256 !== planHash || decisions.report_sha256 !== reportHash) {
    throw new Error("Qwen promotion refused a stale plan/report/decision chain.");
  }
  const requested = ids(flags["cut-ids"] ?? flags["image-ids"]);
  const decisionById = new Map(decisions.decisions.map((row) => [row.image_id, row]));
  const itemById = new Map(items.map((row) => [row.image_id, row]));
  const accepted = decisions.decisions.filter((row) => row.decision === "accepted" && (!requested.size || requested.has(row.image_id)));
  if (!accepted.length || (requested.size && accepted.length !== requested.size)) throw new Error("Promotion scope must contain only hash-approved Qwen candidates.");
  const promptIds = new Set(promptPlan.prompts.filter((row) => row.image_generation_required !== false).map((row) => String(row.image_id)));
  const priorResultIds = imagegenReport.results.map((row) => String(row?.image_id ?? ""));
  if (priorResultIds.length !== promptIds.size || new Set(priorResultIds).size !== promptIds.size
    || [...promptIds].some((imageId) => !priorResultIds.includes(imageId))) {
    throw new Error("Current imagegen report does not exactly cover the hardened prompt plan.");
  }
  const cutIds = cutLedger.cuts.map((row) => String(row?.image_id ?? ""));
  if (new Set(cutIds).size !== cutIds.length) throw new Error("Cut execution ledger contains duplicate image IDs.");
  const replacements = [];
  const ledgerUpdates = new Map();
  const prepared = [];
  for (const decision of accepted) {
    const item = itemById.get(decision.image_id);
    const selectedAttempt = resolveSelectedAttempt(report.attempts, decision);
    if (!item || !promptIds.has(decision.image_id)) throw new Error(`Approved Qwen candidate is outside current production scope: ${decision.image_id}`);
    if (!decisionMatchesAttempt(decision, selectedAttempt)) {
      throw new Error(`Approved Qwen decision is not bound to its selected current attempt: ${decision.image_id}`);
    }
    if (await hashFile(decision.candidate_path) !== decision.candidate_sha256) throw new Error(`Approved Qwen candidate is stale: ${decision.image_id}`);
    const productionPath = path.join(episodeDir, "assets", "images", `${decision.image_id}-modelslab-qwen-text2img-${decision.candidate_sha256.slice(0, 12)}.png`);
    if (await exists(productionPath) && await hashFile(productionPath) !== decision.candidate_sha256) {
      throw new Error(`Content-addressed Qwen production path exists with a different hash: ${productionPath}`);
    }
    const ledgerMatches = cutLedger.cuts.filter((cut) => String(cut.image_id) === decision.image_id);
    if (ledgerMatches.length !== 1) throw new Error(`Promotion requires exactly one cut-ledger row for ${decision.image_id}.`);
    prepared.push({ decision, item, selectedAttempt, productionPath });
  }
  for (const { decision, item, selectedAttempt, productionPath } of prepared) {
    if (!(await exists(productionPath))) await copyAtomic(decision.candidate_path, productionPath);
    const outputHash = await hashFile(productionPath);
    const submittedPromptHash = sha256(JSON.stringify({
      provider: "modelslab",
      model: "qwen",
      endpoint: "/api/v6/images/text2img",
      prompt: selectedAttempt.prompt,
      reference_inputs: [],
      recovery_plan_sha256: planHash,
      repair_prompt_ledger_sha256: selectedAttempt.repair_prompt_ledger_sha256 ?? null,
    }));
    await fs.writeFile(`${productionPath}.prompt.sha256`, submittedPromptHash, "utf8");
    const metadata = {
      image_id: decision.image_id,
      prompt_hash: submittedPromptHash,
      recovery_plan_path: planPath,
      recovery_plan_sha256: planHash,
      recovery_report_path: reportPath,
      recovery_report_sha256: reportHash,
      recovery_decisions_path: decisionsPath,
      recovery_decisions_sha256: decisionsHash,
      source_candidate_path: decision.candidate_path,
      source_candidate_sha256: decision.candidate_sha256,
      reference_image_paths: [],
      reference_inputs: [],
      image_prompt: selectedAttempt.prompt,
      recovery_prompt_source: selectedAttempt.prompt_source ?? "approved_base_plan",
      repair_prompt_ledger_path: selectedAttempt.repair_prompt_ledger_path ?? null,
      repair_prompt_ledger_sha256: selectedAttempt.repair_prompt_ledger_sha256 ?? null,
      image_provider: "modelslab_qwen_text2img_vehicle_recovery",
      model: "qwen",
      endpoint: "/api/v6/images/text2img",
      generated: { output_sha256: outputHash, downloaded_path: productionPath },
      updated_at: new Date().toISOString(),
    };
    await writeJsonAtomic(`${productionPath}.metadata.json`, metadata);
    replacements.push({
      image_id: decision.image_id,
      status: "manual_imported",
      image_path: productionPath,
      image_sha256: outputHash,
      prompt_hash: submittedPromptHash,
      image_provider: metadata.image_provider,
      generated: {
        model: "qwen",
        endpoint: metadata.endpoint,
        output_sha256: outputHash,
        downloaded_path: productionPath,
        reference_count: 0,
        source_candidate_path: decision.candidate_path,
        source_candidate_sha256: decision.candidate_sha256,
      },
    });
    ledgerUpdates.set(decision.image_id, { productionPath, outputHash, submittedPromptHash });
  }
  const results = mergeImagegenResults(imagegenReport.results, replacements, promptIds);
  const replacementIds = new Set(replacements.map((row) => row.image_id));
  const nextImagegenReport = {
    ...imagegenReport,
    status: "passed",
    image_provider: "mixed_preserved_plus_modelslab_qwen_text2img_vehicle_recovery",
    image_count: results.length,
    expected_image_count: promptIds.size,
    missing_image_count: Math.max(0, promptIds.size - results.length),
    current_batch_image_count: replacements.length,
    results,
    scoped_recovery_batches: [
      ...(imagegenReport.scoped_recovery_batches ?? []),
      {
        kind: "modelslab_qwen_text2img_vehicle_recovery",
        image_ids: [...replacementIds],
        plan_path: planPath,
        plan_sha256: planHash,
        report_path: reportPath,
        report_sha256: reportHash,
        decisions_path: decisionsPath,
        decisions_sha256: decisionsHash,
        updated_at: new Date().toISOString(),
      },
    ],
    updated_at: new Date().toISOString(),
  };
  const nextCuts = cutLedger.cuts.map((cut) => {
    const update = ledgerUpdates.get(String(cut.image_id));
    if (!update) return cut;
    return {
      ...cut,
      submitted_prompt_hash: update.submittedPromptHash,
      references: [],
      reference_ids: [],
      image_provider: "modelslab_qwen_text2img_vehicle_recovery",
      image_model: "qwen",
      editorial_reuse_approved: false,
      reuse_source_image_id: null,
      image_path: update.productionPath,
      image_sha256: update.outputHash,
      generation_status: "manual_imported",
      image_qa_status: "pending",
      image_qa_note: "Awaiting hash-bound vehicle topology review.",
      image_qa_reviewed_at: null,
      motion_profile_hash: null,
      motion_clip_path: null,
      motion_clip_sha256: null,
      motion_clip_cache_key: null,
      motion_clip_cache_status: null,
      updated_at: new Date().toISOString(),
    };
  });
  const nextLedger = {
    ...cutLedger,
    imagegen_report_path: imagegenReportPath,
    completed_image_count: nextCuts.filter((cut) => cut.image_sha256).length,
    pending_image_qa_count: nextCuts.filter((cut) => !String(cut.image_qa_status ?? "").startsWith("passed")).length,
    cuts: nextCuts,
    updated_at: new Date().toISOString(),
  };
  await writeJsonAtomic(imagegenReportPath, nextImagegenReport);
  await writeJsonAtomic(cutLedgerPath, nextLedger);
  const promotionPath = path.join(outputDir, `qwen_vehicle_promotion_${episode}_${Date.now()}.json`);
  await writeJsonAtomic(promotionPath, {
    schema: "goldflow_qwen_vehicle_promotion_v1",
    status: "passed",
    image_ids: [...replacementIds],
    replacements,
    imagegen_report_path: imagegenReportPath,
    imagegen_report_sha256: await hashFile(imagegenReportPath),
    cut_execution_ledger_path: cutLedgerPath,
    cut_execution_ledger_sha256: await hashFile(cutLedgerPath),
    updated_at: new Date().toISOString(),
  });
  console.log(JSON.stringify({ status: "passed", promoted_count: replacements.length, image_ids: [...replacementIds], promotion_report: promotionPath }, null, 2));
}

async function main() {
  if (action === "validate") {
    const plan = await readJson(planPath);
    const items = await validatePlan(plan);
    const promptPlan = await readJson(promptPlanPath);
    const promptIds = new Set((promptPlan?.prompts ?? []).filter((row) => row.image_generation_required !== false).map((row) => String(row.image_id)));
    const unknown = items.filter((row) => !promptIds.has(row.image_id)).map((row) => row.image_id);
    if (unknown.length) throw new Error(`Recovery plan contains IDs outside the hardened prompt plan: ${unknown.join(", ")}`);
    console.log(JSON.stringify({ status: "passed", plan_path: planPath, item_count: items.length, model: "qwen", endpoint: "/api/v6/images/text2img", reference_count: 0, configured_account_count: modelslabProfiles.length }, null, 2));
    return;
  }
  if (action === "generate") return generate();
  if (action === "prepare-repair-prompts") return prepareRepairPrompts();
  if (action === "archive") {
    if (!workflowBypass) throw new Error("Archiving scoped recovery evidence requires --workflow-bypass true.");
    const report = await readJson(reportPath);
    if (report?.schema !== "goldflow_qwen_vehicle_recovery_report_v1" || !report?.batches?.length) {
      throw new Error(`No Qwen recovery batch is available to archive: ${reportPath}`);
    }
    const batch = report.batches.at(-1);
    const attempts = (report.attempts ?? []).filter((row) => row.batch_id === batch.batch_id);
    const immutablePath = await writeImmutableBatchReport(report, batch, attempts);
    console.log(JSON.stringify({ status: "passed", batch_id: batch.batch_id, immutable_report_path: immutablePath }, null, 2));
    return;
  }
  if (action === "review") return review();
  if (action === "promote") return promote();
  throw new Error(`Unknown Qwen vehicle recovery action: ${action}`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
