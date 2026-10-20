#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CLAUDE_CODE_PROVIDER, CODEX_EXEC_PROVIDER, readCodexCallMetadata, runClaudeCodePrint, runCodexCli, runCodexExec } from "./lib/codex-cli-runner.mjs";
import {
  MANUFACTURING_MODEL_LOCK_SCHEMA,
  modelLockConflicts,
  requestedModelLock,
  validateModelLock,
  requestedWriterFallback,
  BROWSER_SOURCE_PROVIDERS,
} from "./lib/source-model-lock.mjs";
import { sourceWriterPolicy, improvementEfforts } from "./lib/source-writer-policy.mjs";
import { recoverBrowserDraft } from "./lib/source-browser-draft-recovery.mjs";
import { CHATGPT_WEB_THROTTLE_COOLDOWN_MS, isChatGptWebRateLimitError } from "./lib/chatgpt-web-throttle-state.mjs";
import { parseJsonObjectFromPlannerOutput } from "./lib/json-output-repair.mjs";
import { DEFAULT_NEW_NARRATOR_VOICE_ID as DEFAULT_NARRATOR_VOICE_ID, qwenPrimaryLockForVoice } from "./lib/narration-tts-policy.mjs";
import { extractOpeningAuditionText, sentenceCompleteAuditionUnits } from "./lib/source-opening-audio-audition-contract.mjs";
import {
  MANUFACTURING_BRIEF_SCHEMA,
  MANUFACTURING_PORTFOLIO_SCHEMA,
  MANUFACTURING_TOPIC_POOL_SCHEMA,
  parseManufacturingTopicTitles,
  validateFilledManufacturingPrompt,
  validateManufacturingBrief,
  validateManufacturingPortfolio,
  validateManufacturingSelection,
  validateManufacturingTemplate,
  validateManufacturingTopicPool,
  validateManufacturingTopicShortlist,
  buildSourceHandoff,
  validateSourceHandoff,
  sha256Text,
} from "./lib/source-manufacturer-contract.mjs";
import {
  FAST_IMPROVEMENT_PANEL_COUNT,
  FAST_IMPROVEMENT_MIN_APV_DELTA,
  assessFastImprovementLength,
  decideFastImprovement,
  validateDirectorNotes,
} from "./lib/source-fast-improvement-contract.mjs";

import { STORY_LED_TITLE_POLICY } from "./lib/story-led-title.mjs";
import {
  REVISION_DECISION_SCHEMA,
  REVISION_LOOP_SCHEMA,
  REVISION_MAX_ROUNDS,
  REVISION_POLICY,
  assessRevisionLength,
  autoTitleBrief,
  decideRevisionRound,
  openingDeadlineWindows,
  validateRevisionNotes,
  validateRevisionVerdict,
} from "./lib/source-revision-contract.mjs";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DATA_ROOT = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const BASE_TEMPLATE_PATH = path.join(REPO_ROOT, "docs/prompts/manhwa_recap_manufacturing_template_v1.txt");
const FILLER_PROMPT_PATH = path.join(REPO_ROOT, "docs/prompts/manhwa_recap_manufacturing_prompt_filler_v1.md");
const SELECTOR_PROMPT_PATH = path.join(REPO_ROOT, "docs/prompts/manhwa_recap_manufacturing_selector_v1.md");
const TOPIC_PROMPT_PATH = path.join(REPO_ROOT, "docs/prompts/manhwa_recap_topic_manufacturer_v1.md");
const TOPIC_SHORTLIST_PROMPT_PATH = path.join(REPO_ROOT, "docs/prompts/manhwa_recap_topic_shortlist_v1.md");
const FAST_IMPROVEMENT_EDITOR_PROMPT_PATH = path.join(REPO_ROOT, "docs/prompts/manhwa_recap_fast_improvement_editor_v1.md");
const REVISION_DIAGNOSE_PROMPT_PATH = path.join(REPO_ROOT, "docs/prompts/manhwa_recap_revision_diagnose_v1.md");
const REVISION_REWRITE_PROMPT_PATH = path.join(REPO_ROOT, "docs/prompts/manhwa_recap_revision_rewrite_v1.md");
const REVISION_VERIFY_PROMPT_PATH = path.join(REPO_ROOT, "docs/prompts/manhwa_recap_revision_verify_v1.md");
const SOURCE_EVIDENCE_SNAPSHOT_PATH = path.join(REPO_ROOT, "docs/channel_formulas/53rebirth_source_evidence_snapshot_v1.json");
const DEFAULT_QWEN_PYTHON = "/Users/joel/AniFactoryData/voice_bank/bakeoff/.venv-kokoro-mlx-audio-0.4.6/bin/python";

function flagsFrom(parts) {
  const flags = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const next = parts[index + 1];
    flags[key] = next && !next.startsWith("--") ? next : "true";
    if (flags[key] !== "true") index += 1;
  }
  return flags;
}

function csvSet(value) {
  return new Set(String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function allSettledWithConcurrency(items, concurrency, task) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: "fulfilled", value: await task(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function assertValid(label, validation) {
  if (!validation.done) throw new Error(`${label} blocked: ${validation.blockers.join(", ")}`);
}

function words(value) {
  return String(value ?? "").trim().split(/\s+/).filter(Boolean).length;
}

function mean(values) {
  const numbers = values.map(Number).filter(Number.isFinite);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
}

function median(values) {
  const numbers = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!numbers.length) return null;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
}

function canonicalizeSelectionArithmetic(document) {
  if (!Array.isArray(document?.rankings)) return document;
  const rankings = document.rankings.map((row) => {
    const viewerPercentages = Array.isArray(row?.viewer_simulation)
      ? row.viewer_simulation.map((viewer) => viewer?.predicted_percentage_viewed)
      : [];
    const computedAverage = mean(viewerPercentages);
    return computedAverage === null
      ? row
      : { ...row, predicted_average_percentage_viewed: Number(computedAverage.toFixed(2)) };
  }).sort((left, right) => Number(right.predicted_average_percentage_viewed) - Number(left.predicted_average_percentage_viewed)
    || String(left.blind_id).localeCompare(String(right.blind_id)))
    .map((row, index) => ({ ...row, rank: index + 1 }));
  return {
    ...document,
    selected_blind_id: rankings[0]?.blind_id ?? document.selected_blind_id,
    rankings,
  };
}

function runLocal(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function stripFence(value) {
  return String(value ?? "")
    .trim()
    .replace(/^```(?:text|markdown)?\s*/i, "")
    .replace(/\s*```$/, "")
    .replace(/^Edit\s*\n+/i, "")
    .trim();
}

async function exists(filePath) {
  return fs.stat(filePath).then(() => true).catch(() => false);
}

async function fileSha256(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function writeExclusive(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value, { flag: "wx" });
}

async function writeJsonExclusive(filePath, value) {
  await writeExclusive(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporaryPath, value);
  await fs.rename(temporaryPath, filePath);
}

async function writeJsonAtomic(filePath, value) {
  await writeAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function promptBody(markdown) {
  const match = String(markdown).match(/```text\s*([\s\S]*?)```/i);
  if (!match) throw new Error("Prompt file is missing a text fence.");
  return match[1].trim();
}

function developmentDirectory(flags, action = null) {
  if (flags["development-dir"]) return path.resolve(flags["development-dir"]);
  if (action === "revise" && flags.script && !flags["development-slug"]) {
    // A brought script gets its own sibling revision folder; the original file is never modified.
    const scriptPath = path.resolve(flags.script);
    return path.join(path.dirname(scriptPath), `${path.basename(scriptPath, path.extname(scriptPath))}_revision`);
  }
  const channel = String(flags.channel ?? "53rebirth").trim();
  const slug = String(flags["development-slug"] ?? "").trim();
  if (!slug) throw new Error("Use --development-dir or --development-slug.");
  return path.join(DATA_ROOT, "channels", channel, "source_development", slug);
}

function channelFor(directory, flags) {
  if (flags.channel) return String(flags.channel).trim();
  const match = path.resolve(directory).match(/[\\/]channels[\\/]([^\\/]+)[\\/]/);
  return match?.[1] ?? "53rebirth";
}

function activeTemplateManifestPath(directory, flags) {
  return path.join(DATA_ROOT, "channels", channelFor(directory, flags), "analytics", "manufacturing_prompt_templates", "current.json");
}

async function activeManufacturingTemplate(directory, flags) {
  const base = await fs.readFile(BASE_TEMPLATE_PATH, "utf8");
  assertValid("base manufacturing template", validateManufacturingTemplate(base));
  const currentPath = activeTemplateManifestPath(directory, flags);
  if (!await exists(currentPath)) {
    return { content: base, path: BASE_TEMPLATE_PATH, sha256: sha256Text(base), version: "base_v1_reversal_v2", currentPath: null };
  }
  const current = JSON.parse(await fs.readFile(currentPath, "utf8"));
  if (current?.schema !== "goldflow_manhwa_manufacturing_active_template_v1" || current?.status !== "approved") {
    throw new Error("Active manufacturing template manifest is invalid.");
  }
  const templatePath = path.resolve(current.template_path);
  const content = await fs.readFile(templatePath, "utf8");
  const digest = sha256Text(content);
  if (digest !== current.template_sha256) throw new Error("Active manufacturing template hash mismatch.");
  assertValid("active manufacturing template", validateManufacturingTemplate(content));
  return { content, path: templatePath, sha256: digest, version: current.version, currentPath };
}

async function loadBrief(directory, flags) {
  const target = path.join(directory, "manufacturing_brief.json");
  if (!await exists(target)) {
    if (!flags.brief) throw new Error("Missing manufacturing_brief.json; run ideate (auto-selects rank one) or pass --brief <approved-json>.");
    const source = path.resolve(flags.brief);
    const bytes = await fs.readFile(source);
    const document = JSON.parse(bytes.toString("utf8"));
    assertValid("manufacturing brief", validateManufacturingBrief(document));
    await writeExclusive(target, bytes);
  }
  const document = JSON.parse(await fs.readFile(target, "utf8"));
  assertValid("manufacturing brief", validateManufacturingBrief(document));
  return { document, path: target, sha256: await fileSha256(target) };
}

async function ideateTopics(directory, flags) {
  if (!flags.evidence) throw new Error("Use --evidence <txt-or-md> with measured own-channel winners and external outliers.");
  await fs.mkdir(directory, { recursive: true });
  const evidencePath = path.resolve(flags.evidence);
  const evidence = await fs.readFile(evidencePath, "utf8");
  if (!evidence.trim()) throw new Error("Premise evidence file is empty.");
  const poolPath = path.join(directory, "manufacturing_topic_pool.json");
  const shortlistPath = path.join(directory, "manufacturing_topic_shortlist.json");
  if (await exists(poolPath) && await exists(shortlistPath)) {
    // Completed ideation is reused from its validated, hash-recorded files without new calls.
    const pool = JSON.parse(await fs.readFile(poolPath, "utf8"));
    const shortlist = JSON.parse(await fs.readFile(shortlistPath, "utf8"));
    assertValid("manufacturing topic pool", validateManufacturingTopicPool(pool));
    assertValid("manufacturing topic shortlist", validateManufacturingTopicShortlist(shortlist, { topicPool: pool }));
    if (pool.evidence_sha256 !== sha256Text(evidence)) throw new Error("Existing ideation used different evidence; use a new development folder.");
    const brief = await autoSelectTitle(directory, flags, { shortlistPath, evidencePath, evidence });
    return { poolPath, shortlistPath, shortlist, brief };
  }
  const planning = (await loadModelLock(directory, flags)).document.roles.planning;
  const topicInstruction = promptBody(await fs.readFile(TOPIC_PROMPT_PATH, "utf8"));
  const topicPrompt = `${topicInstruction}\n\nMEASURED OWN-CHANNEL AND EXTERNAL OUTLIER EVIDENCE\n${evidence}`;
  const rawPoolPath = path.join(directory, ".model_responses", "manufacturing_topic_pool.txt");
  const poolResponse = await modelCall({
    outputPath: rawPoolPath,
    prompt: topicPrompt,
    provider: planning.provider,
    model: planning.model,
    effort: planning.reasoning_effort,
    stageName: "winner_source_premise_manufacturing_pool",
    timeoutMs: Number(flags["ideation-timeout-ms"] ?? 1_800_000),
  });
  const candidates = parseManufacturingTopicTitles(stripFence(poolResponse.content));
  const pool = {
    schema: MANUFACTURING_TOPIC_POOL_SCHEMA,
    title_selection_policy: STORY_LED_TITLE_POLICY,
    status: "completed",
    evidence_path: evidencePath,
    evidence_sha256: sha256Text(evidence),
    prompt_sha256: sha256Text(topicPrompt),
    raw_response_path: rawPoolPath,
    raw_response_sha256: await fileSha256(rawPoolPath),
    candidates,
    completed_at: new Date().toISOString(),
  };
  assertValid("manufacturing topic pool", validateManufacturingTopicPool(pool));
  if (!await exists(poolPath)) await writeJsonExclusive(poolPath, pool);

  const shortlistInstruction = promptBody(await fs.readFile(TOPIC_SHORTLIST_PROMPT_PATH, "utf8"));
  const shortlistPrompt = `${shortlistInstruction}\n\nMEASURED OWN-CHANNEL AND EXTERNAL OUTLIER EVIDENCE\n${evidence}\n\nBLIND ORIGINAL CANDIDATE TITLES\n${candidates.map((row) => `${row.number}. ${row.title}`).join("\n")}`;
  const rawShortlistPath = path.join(directory, ".model_responses", "manufacturing_topic_shortlist.txt");
  const shortlistResponse = await modelCall({
    outputPath: rawShortlistPath,
    prompt: shortlistPrompt,
    provider: planning.provider,
    model: planning.model,
    effort: planning.reasoning_effort,
    stageName: "winner_source_premise_manufacturing_shortlist",
    timeoutMs: Number(flags["shortlist-timeout-ms"] ?? 1_800_000),
  });
  const shortlist = parseJsonObjectFromPlannerOutput(shortlistResponse.content).value;
  assertValid("manufacturing topic shortlist", validateManufacturingTopicShortlist(shortlist, { topicPool: pool }));
  if (!await exists(shortlistPath)) await writeJsonExclusive(shortlistPath, shortlist);
  const brief = await autoSelectTitle(directory, flags, { shortlistPath, evidencePath, evidence });
  return { poolPath, shortlistPath, shortlist, brief };
}

// Rank one of the validated shortlist becomes the brief with no operator stop. An existing brief
// (operator-supplied or from an earlier run) is never replaced.
async function autoSelectTitle(directory, flags, { shortlistPath, evidencePath = null, evidence = null }) {
  const briefPath = path.join(directory, "manufacturing_brief.json");
  if (await exists(briefPath)) {
    const document = JSON.parse(await fs.readFile(briefPath, "utf8"));
    assertValid("manufacturing brief", validateManufacturingBrief(document));
    return { path: briefPath, document, created: false };
  }
  const shortlistSha256 = await fileSha256(shortlistPath);
  const shortlist = JSON.parse(await fs.readFile(shortlistPath, "utf8"));
  const document = autoTitleBrief(shortlist, {
    shortlistPath,
    shortlistSha256,
    evidencePath,
    evidenceSha256: evidence == null ? null : sha256Text(evidence),
    targetWordCount: Number(flags["target-word-count"] ?? 10_000),
  });
  assertValid("auto-selected manufacturing brief", validateManufacturingBrief(document));
  await writeJsonExclusive(briefPath, document);
  return { path: briefPath, document, created: true };
}

async function reusableResponse({ outputPath, prompt, provider, model, effort, stageName }) {
  if (!await exists(outputPath)) return null;
  const metadata = await readCodexCallMetadata(outputPath);
  const blockers = [];
  const content = await fs.readFile(outputPath, "utf8");
  if (!metadata) blockers.push("receipt_missing");
  if (metadata?.status !== "passed") blockers.push("receipt_not_passed");
  if (metadata?.prompt_sha256 !== sha256Text(prompt)) blockers.push("prompt_hash_mismatch");
  if (metadata?.provider !== provider) blockers.push("provider_mismatch");
  if (metadata?.model !== model) blockers.push("model_mismatch");
  if (metadata?.reasoning_effort !== effort) blockers.push("effort_mismatch");
  if (metadata?.stage_name !== stageName) blockers.push("stage_mismatch");
  if (metadata?.output_sha256 !== sha256Text(content)) blockers.push("output_hash_mismatch");
  if (blockers.length) throw new Error(`Cannot reuse ${outputPath}: ${blockers.join(", ")}`);
  return { content: await fs.readFile(outputPath, "utf8"), ...metadata, resumed: true };
}

// Tests inject a no-network executor with runCodexCli's contract: write the output file and its
// passed .meta.json receipt, then return { content, ...metadata }.
function providerExecutor(options) {
  if (options.provider === CODEX_EXEC_PROVIDER) return runCodexExec(options);
  if (options.provider === CLAUDE_CODE_PROVIDER) return runClaudeCodePrint(options);
  // Retired browser transport, reachable only behind --transport chatgpt_web.
  return runCodexCli(options);
}

// ChatGPT Web browser automation is retired. Recorded browser responses still resume, but a new
// browser submission needs an explicit --transport chatgpt_web.
let chatGptWebTransportAllowed = false;

export function allowChatGptWebTransport(allowed) {
  chatGptWebTransportAllowed = Boolean(allowed);
}

let modelExecutor = providerExecutor;

export function setModelExecutorForTests(executor) {
  modelExecutor = executor ?? providerExecutor;
}

async function modelCall({ outputPath, prompt, provider, model, effort, stageName, timeoutMs }) {
  const resumed = await reusableResponse({ outputPath, prompt, provider, model, effort, stageName });
  if (resumed) return resumed;
  if (provider === "chatgpt_web" && !chatGptWebTransportAllowed) {
    throw new Error(`Stage ${stageName} would submit to the retired ChatGPT Web browser transport. Pass --transport chatgpt_web to run this legacy path explicitly.`);
  }
  return modelExecutor({
    prompt,
    stageName,
    repoRoot: REPO_ROOT,
    outputPath,
    provider,
    model,
    reasoningEffort: effort,
    verbosity: "medium",
    timeoutMs,
  });
}

async function prepare(directory, flags) {
  await fs.mkdir(directory, { recursive: true });
  const brief = await loadBrief(directory, flags);
  const outputPath = path.join(directory, ".model_responses", "manufacturing_prompt.txt");
  const finalPath = path.join(directory, "manufacturing_writer_prompt.txt");
  const manifestPath = path.join(directory, "manufacturing_prompt_manifest.json");
  if (flags["writer-prompt"]) {
    const sourcePath = path.resolve(flags["writer-prompt"]);
    const sourceBytes = await fs.readFile(sourcePath);
    const filled = sourceBytes.toString("utf8");
    if (!filled.trim()) throw new Error("Imported manufacturing writer prompt is empty.");
    const filledPromptSha256 = sha256Text(filled);
    if (path.resolve(finalPath) !== sourcePath) {
      if (!await exists(finalPath)) await writeExclusive(finalPath, sourceBytes);
      else if (await fileSha256(finalPath) !== filledPromptSha256) throw new Error("Existing manufacturing writer prompt differs from the imported prompt.");
    } else if (await fileSha256(finalPath) !== filledPromptSha256) {
      throw new Error("Imported manufacturing writer prompt changed while it was being prepared.");
    }
    const manifest = {
      schema: "goldflow_manhwa_manufacturing_prompt_manifest_v1",
      status: "prepared",
      prompt_source: "operator_supplied_exact_prompt",
      brief_sha256: brief.sha256,
      active_template_path: null,
      active_template_sha256: null,
      active_template_version: "operator_direct_prompt_v1",
      active_template_manifest_path: null,
      filler_provider: null,
      filler_model: null,
      filler_reasoning_effort: null,
      filler_prompt_sha256: null,
      raw_response_path: null,
      raw_response_sha256: null,
      imported_prompt_path: sourcePath,
      imported_prompt_sha256: filledPromptSha256,
      filled_prompt_path: finalPath,
      filled_prompt_sha256: filledPromptSha256,
      prepared_at: new Date().toISOString(),
    };
    if (!await exists(manifestPath)) await writeJsonExclusive(manifestPath, manifest);
    else {
      const existing = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      if (existing.prompt_source !== manifest.prompt_source
        || existing.brief_sha256 !== manifest.brief_sha256
        || existing.filled_prompt_sha256 !== manifest.filled_prompt_sha256) {
        throw new Error("Existing manufacturing prompt manifest differs from the imported prompt.");
      }
    }
    return { brief, filled, finalPath, manifestPath, manifest };
  }
  if (await exists(manifestPath) && await exists(finalPath)) {
    // A prepared prompt is reused from its manifest and hash, so resumes never resubmit the filler.
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    if (manifest.brief_sha256 !== brief.sha256 || await fileSha256(finalPath) !== manifest.filled_prompt_sha256) {
      throw new Error("Existing manufacturing prompt manifest does not match the brief or prompt file.");
    }
    return { brief, filled: await fs.readFile(finalPath, "utf8"), finalPath, manifestPath, manifest };
  }
  const planning = (await loadModelLock(directory, flags)).document.roles.planning;
  const template = await activeManufacturingTemplate(directory, flags);
  const filler = promptBody(await fs.readFile(FILLER_PROMPT_PATH, "utf8"));
  const prompt = `${filler}\n\n${brief.document.status === "auto_selected" ? "SELECTED PREMISE BRIEF" : "APPROVED PREMISE BRIEF"}\n${JSON.stringify(brief.document, null, 2)}\n\nOPERATOR TEMPLATE\n${template.content}`;
  const response = await modelCall({
    outputPath,
    prompt,
    provider: planning.provider,
    model: planning.model,
    effort: planning.reasoning_effort,
    stageName: "winner_source_script_manufacturing_prompt",
    timeoutMs: Number(flags["prepare-timeout-ms"] ?? 1_800_000),
  });
  const filled = stripFence(response.content);
  assertValid("filled manufacturing prompt", validateFilledManufacturingPrompt(filled, { brief: brief.document, baseTemplate: template.content }));
  if (!await exists(finalPath)) await writeExclusive(finalPath, `${filled}\n`);
  else if (await fileSha256(finalPath) !== sha256Text(`${filled}\n`)) throw new Error("Existing manufacturing writer prompt differs.");
  const manifest = {
    schema: "goldflow_manhwa_manufacturing_prompt_manifest_v1",
    status: "prepared",
    brief_sha256: brief.sha256,
    active_template_path: template.path,
    active_template_sha256: template.sha256,
    active_template_version: template.version,
    active_template_manifest_path: template.currentPath,
    filler_provider: planning.provider,
    filler_model: planning.model,
    filler_reasoning_effort: planning.reasoning_effort,
    filler_prompt_sha256: sha256Text(prompt),
    raw_response_path: outputPath,
    raw_response_sha256: await fileSha256(outputPath),
    filled_prompt_path: finalPath,
    filled_prompt_sha256: await fileSha256(finalPath),
    prepared_at: new Date().toISOString(),
  };
  if (!await exists(manifestPath)) await writeJsonExclusive(manifestPath, manifest);
  return { brief, filled, finalPath, manifestPath, manifest };
}

// The per-run model lock. Written once; later stages and resumes must agree with it. A folder
// whose portfolio predates the lock keeps the writer recorded in that portfolio.
async function loadModelLock(directory, flags) {
  const lockPath = path.join(directory, "manufacturing_model_lock.json");
  if (await exists(lockPath)) {
    const document = JSON.parse(await fs.readFile(lockPath, "utf8"));
    assertValid("manufacturing model lock", validateModelLock(document));
    const conflicts = modelLockConflicts(document, flags);
    if (conflicts.length) throw new Error(`Model flags conflict with the locked run choice (${conflicts.join(", ")}); see ${lockPath}.`);
    return { document, path: lockPath, sha256: await fileSha256(lockPath) };
  }
  const roles = requestedModelLock(flags);
  const portfolioExists = await exists(path.join(directory, "manufacturing_portfolio.json"));
  const writerFallback = portfolioExists ? null : requestedWriterFallback(flags, roles);
  const document = {
    schema: MANUFACTURING_MODEL_LOCK_SCHEMA,
    roles: portfolioExists ? { ...roles, writer: null } : roles,
    writer_recorded_in_portfolio: portfolioExists,
    ...(BROWSER_SOURCE_PROVIDERS.includes(roles.writer.provider) && !portfolioExists
      ? { writer_transport: roles.writer.provider, writer_resubmit_policy: WRITER_TRANSPORT_POLICY, writer_fallback: writerFallback }
      : {}),
    locked_at: new Date().toISOString(),
  };
  assertValid("manufacturing model lock", validateModelLock(document));
  await writeJsonExclusive(lockPath, document);
  return { document, path: lockPath, sha256: await fileSha256(lockPath) };
}

// Only the single-draft policy takes its writer from the lock; multi-draft policies keep their
// fixed historical contracts.
function lockedWriterCandidates(policy, lock) {
  const writer = lock?.document?.roles?.writer;
  if (policy.candidates.length !== 1 || !writer) return policy.candidates;
  const fallback = lock.document.writer_fallback ?? null;
  return policy.candidates.map((row) => ({ ...row, model: writer.model, provider: writer.provider, ...(fallback ? { fallback } : {}) }));
}

// ChatGPT Web writer transport policy: one draft submission; a throttle gets exactly one
// resubmit after the shared cooldown; any remaining failure goes to the locked CLI fallback
// when the lock names one, else the stage stops. Every attempt is appended to a ledger and the
// failed receipt is archived before the next submission, so receipts stay append-only.
export const WRITER_TRANSPORT_POLICY = "chatgpt_web_writer_one_resubmit_then_locked_fallback_v1";
export const WRITER_TRANSPORT_LEDGER_SCHEMA = "goldflow_manhwa_writer_transport_ledger_v1";
const THROTTLE_ERROR_CODES = new Set(["rate_limited", "usage_limit", "usage_limit_reached"]);

// Production waits the shared browser cooldown (floor 60 s); tests inject a short wait.
let writerTransportTiming = { cooldownMs: CHATGPT_WEB_THROTTLE_COOLDOWN_MS, sleep };
export function setWriterTransportTimingForTests(timing) {
  writerTransportTiming = { cooldownMs: CHATGPT_WEB_THROTTLE_COOLDOWN_MS, sleep, ...(timing ?? {}) };
}

export function isWriterThrottleError(error) {
  const code = String(error?.code ?? "").trim().toLowerCase();
  const message = error instanceof Error ? error.message : String(error ?? "");
  return THROTTLE_ERROR_CODES.has(code) || isChatGptWebRateLimitError(message) || /cooldown active|usage limit/i.test(message);
}

// Concurrent browser drafts (legacy multi-draft policies) share one ledger; appends are serialized.
let ledgerChain = Promise.resolve();
function appendWriterTransportLedger(outputDirectory, entry) {
  const ledgerPath = path.join(outputDirectory, "writer_transport_ledger.json");
  const append = async () => {
    const existing = await exists(ledgerPath) ? JSON.parse(await fs.readFile(ledgerPath, "utf8")) : { schema: WRITER_TRANSPORT_LEDGER_SCHEMA, policy: WRITER_TRANSPORT_POLICY, attempts: [] };
    existing.attempts.push({ ...entry, recorded_at: new Date().toISOString() });
    await writeJsonAtomic(ledgerPath, existing);
    return ledgerPath;
  };
  const result = ledgerChain.then(append, append);
  ledgerChain = result.catch(() => {});
  return result;
}

async function archiveFailedReceipt(outputPath, candidateId) {
  const receiptPath = `${outputPath}.meta.json`;
  if (!await exists(receiptPath)) return null;
  const archiveDirectory = path.join(path.dirname(outputPath), "failed_receipts");
  await fs.mkdir(archiveDirectory, { recursive: true });
  const archivedPath = path.join(archiveDirectory, `${candidateId}.${new Date().toISOString().replace(/[:.]/g, "-")}.meta.json`);
  await fs.rename(receiptPath, archivedPath);
  return archivedPath;
}

// Returns { provider, model, writer_fallback_used, requested_writer, transport_attempts }.
async function writerDraftCall({ spec, outputDirectory, call }) {
  const ledgerEntry = (fields) => appendWriterTransportLedger(outputDirectory, { candidate_id: spec.id, stage_name: call.stageName, prompt_sha256: sha256Text(call.prompt), ...fields });
  if (!BROWSER_SOURCE_PROVIDERS.includes(spec.provider)) {
    await modelCall({ ...call, provider: spec.provider, model: spec.model });
    return { provider: spec.provider, model: spec.model, writer_fallback_used: false, requested_writer: null, transport_attempts: 1 };
  }
  const attempt = async (kind, provider, model, extra = {}) => {
    const startedAt = new Date().toISOString();
    try {
      await modelCall({ ...call, provider, model });
      await ledgerEntry({ kind, provider, model, outcome: "passed", started_at: startedAt, ...extra });
      return null;
    } catch (error) {
      const archived = await archiveFailedReceipt(call.outputPath, spec.id);
      await ledgerEntry({ kind, provider, model, outcome: isWriterThrottleError(error) ? "throttled" : "failed", error_code: error?.code ?? null,
        error: error instanceof Error ? error.message.slice(0, 2_000) : String(error), archived_receipt_path: archived, started_at: startedAt, ...extra });
      return error;
    }
  };
  let attempts = 1;
  let failure = await attempt("submit", spec.provider, spec.model);
  if (failure && isWriterThrottleError(failure)) {
    const cooldownMs = writerTransportTiming.cooldownMs;
    await ledgerEntry({ kind: "cooldown", provider: spec.provider, model: spec.model, outcome: "waiting", cooldown_ms: cooldownMs });
    await writerTransportTiming.sleep(cooldownMs);
    attempts += 1;
    failure = await attempt("resubmit", spec.provider, spec.model, { cooldown_ms: cooldownMs });
  }
  if (!failure) return { provider: spec.provider, model: spec.model, writer_fallback_used: false, requested_writer: null, transport_attempts: attempts };
  if (!spec.fallback) {
    await ledgerEntry({ kind: "stop", provider: spec.provider, model: spec.model, outcome: "no_fallback_locked" });
    throw failure;
  }
  attempts += 1;
  const fallbackFailure = await attempt("fallback", spec.fallback.provider, spec.fallback.model, { after_error: failure instanceof Error ? failure.message.slice(0, 500) : String(failure) });
  if (fallbackFailure) throw fallbackFailure;
  return { provider: spec.fallback.provider, model: spec.fallback.model, writer_fallback_used: true,
    requested_writer: { provider: spec.provider, model: spec.model }, transport_attempts: attempts };
}

// Non-gate notice: the auto-selected rank-one brief is about to be drafted. The file (and
// one stderr line) lets Joel see the premise before the writer spend without stopping it.
export const BRIEF_NOTICE_SCHEMA = "goldflow_manhwa_rank_one_brief_notice_v1";
async function writeBriefNotice(directory, brief) {
  if (brief?.document?.status !== "auto_selected") return null;
  const noticePath = path.join(directory, "rank_one_brief_notice.json");
  if (await exists(noticePath)) return noticePath;
  const notice = {
    schema: BRIEF_NOTICE_SCHEMA,
    kind: "notice",
    gate: false,
    message: "Auto-selected rank-one brief is proceeding to one draft call. No approval is requested; supply --brief <json> in a new development folder to choose a different premise.",
    title: brief.document.title,
    core_premise: brief.document.core_premise,
    brief_path: brief.path,
    brief_sha256: brief.sha256,
    selection_basis: brief.document.selection_basis ?? null,
    written_at: new Date().toISOString(),
  };
  await writeJsonExclusive(noticePath, notice);
  console.error(`[notice] rank-one brief proceeding to draft: ${JSON.stringify(brief.document.title)} (${noticePath})`);
  return noticePath;
}

async function writeCandidates(directory, flags) {
  const prepared = await prepare(directory, flags);
  await writeBriefNotice(directory, prepared.brief);
  const briefPolicy = prepared.brief.document.writer_policy;
  if (briefPolicy && flags["writer-policy"] && briefPolicy !== flags["writer-policy"]) {
    throw new Error("Writer policy override conflicts with the approved manufacturing brief.");
  }
  const requestedPolicy = flags["writer-policy"] ?? briefPolicy ?? null;
  const portfolioPath = path.join(directory, "manufacturing_portfolio.json");
  if (await exists(portfolioPath)) {
    const document = JSON.parse(await fs.readFile(portfolioPath, "utf8"));
    const recordedPolicy = sourceWriterPolicy(document, requestedPolicy);
    const recordedLock = document.model_lock_sha256 ? await loadModelLock(directory, flags) : null;
    assertValid("manufacturing portfolio", validateManufacturingPortfolio(document, { promptSha256: prepared.manifest.filled_prompt_sha256, expectedCandidates: lockedWriterCandidates(recordedPolicy, recordedLock) }));
    return { prepared, document, portfolioPath };
  }
  const outputDirectory = path.join(directory, "manufactured_drafts");
  const policy = sourceWriterPolicy(null, requestedPolicy);
  if (policy.candidates.length > 1 && flags["writer-model"]) throw new Error("--writer-model applies only to the single-draft writer policy.");
  const lock = policy.candidates.length === 1 ? await loadModelLock(directory, flags) : null;
  const candidates = lockedWriterCandidates(policy, lock);
  if (candidates.some((row) => row.provider === "chatgpt_web") && !chatGptWebTransportAllowed) {
    throw new Error(`Writer policy ${policy.name} submits to the retired ChatGPT Web browser transport. Pass --transport chatgpt_web to run this legacy path explicitly.`);
  }
  const recovery = flags["recover-browser-jobs"] ? JSON.parse(await fs.readFile(path.resolve(flags["recover-browser-jobs"]), "utf8")) : {};
  if (Object.keys(recovery).some((id) => !candidates.some((row) => row.id === id))) throw new Error("Recovery map contains a candidate outside the active writer policy.");
  await fs.mkdir(outputDirectory, { recursive: true });
  const repairIds = csvSet(flags["candidate-ids"]);
  const unknownRepairIds = [...repairIds].filter((id) => !candidates.some((candidate) => candidate.id === id));
  if (unknownRepairIds.length) throw new Error(`Unknown candidate repair IDs: ${unknownRepairIds.join(", ")}`);
  const writerConcurrency = Math.max(1, Math.min(3, Number(flags["writer-concurrency"] ?? 3) || 3));
  const writerStaggerMs = Math.max(0, Math.min(60_000, Number(flags["writer-stagger-ms"] ?? 15_000) || 0));
  const settled = await allSettledWithConcurrency(candidates, writerConcurrency, async (spec, index) => {
    await sleep((index % writerConcurrency) * writerStaggerMs);
    const outputPath = path.join(outputDirectory, `${spec.id}.txt`);
    const stageName = `winner_source_script_v3_${spec.id}`;
    const candidatePrompt = candidates.length === 1
      ? `${prepared.filled}\n\nWrite the best complete script you can from this prompt in a fresh context. Output only raw narration.`
      : `${prepared.filled}\n\nIndependent candidate run ${spec.id}. Write the best complete script you can from this prompt in a fresh context. Do not compare with or anticipate another candidate. Output only raw narration.`;
    const receiptPath = `${outputPath}.meta.json`;
    const existingReceipt = await readCodexCallMetadata(outputPath);
    const scopedOut = repairIds.size > 0 && !repairIds.has(spec.id);
    if (scopedOut && !await exists(outputPath) && !recovery[spec.id]) throw new Error(`Unscoped missing draft ${spec.id}; no new submission allowed.`);
    if (existingReceipt && existingReceipt.status !== "passed" && repairIds.has(spec.id)) {
      const archiveDirectory = path.join(outputDirectory, "failed_receipts");
      await fs.mkdir(archiveDirectory, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      await fs.rename(receiptPath, path.join(archiveDirectory, `${spec.id}.${timestamp}.meta.json`));
    }
    if (recovery[spec.id] && spec.provider !== "chatgpt_web") throw new Error("Browser job recovery applies only to ChatGPT Web drafts.");
    if (recovery[spec.id] && !await exists(outputPath)) {
      await recoverBrowserDraft({ manifestPath: path.resolve(recovery[spec.id]), outputPath,
        prompt: candidatePrompt, model: spec.model, effort: "max", stageName,
        timeoutMs: Number(flags["draft-timeout-ms"] ?? 5_400_000) });
    }
    if (scopedOut) {
      const reusable = await reusableResponse({ outputPath, prompt: candidatePrompt, provider: spec.provider,
        model: spec.model, effort: "max", stageName });
      if (!reusable) throw new Error(`Unscoped draft ${spec.id} cannot be reused.`);
    }
    const written = scopedOut || (recovery[spec.id] && await exists(outputPath))
      ? { provider: spec.provider, model: spec.model, writer_fallback_used: false, requested_writer: null, transport_attempts: 0 }
      : await writerDraftCall({ spec, outputDirectory, call: {
        outputPath,
        prompt: candidatePrompt,
        effort: "max",
        stageName,
        timeoutMs: Number(flags["draft-timeout-ms"] ?? 5_400_000),
      } });
    const content = await fs.readFile(outputPath, "utf8");
    const { fallback: _fallback, ...candidateSpec } = spec;
    return {
      ...candidateSpec,
      provider: written.provider,
      model: written.model,
      ...(BROWSER_SOURCE_PROVIDERS.includes(spec.provider) ? {
        writer_transport_policy: WRITER_TRANSPORT_POLICY,
        writer_transport_attempts: written.transport_attempts,
        writer_fallback_used: written.writer_fallback_used,
        requested_writer: written.requested_writer,
      } : {}),
      reasoning_effort: "max",
      prompt_sha256: sha256Text(candidatePrompt),
      output_path: outputPath,
      output_sha256: sha256Text(content),
      receipt_path: receiptPath,
      receipt_sha256: await fileSha256(receiptPath),
      word_count: words(content),
      word_count_enforcement: "advisory_only",
    };
  });
  const completed = settled.filter((result) => result.status === "fulfilled").map((result) => result.value);
  const failures = settled
    .map((result, index) => result.status === "rejected" ? {
      candidate_id: candidates[index].id,
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
    } : null)
    .filter(Boolean);
  if (failures.length) {
    const failurePath = path.join(outputDirectory, "manufacturing_candidate_failures.json");
    await fs.writeFile(failurePath, `${JSON.stringify({
      schema: "goldflow_manhwa_manufacturing_candidate_failures_v1",
      status: "blocked",
      completed_candidate_ids: completed.map((row) => row.id),
      failures,
      writer_policy: policy.name,
      exact_recovery_command: `goldflow source manufacture write --development-dir ${JSON.stringify(directory)} --writer-policy ${policy.name} --candidate-ids ${failures.map((row) => row.candidate_id).join(",")}`,
      writer_concurrency: writerConcurrency,
      writer_stagger_ms: writerStaggerMs,
      recorded_at: new Date().toISOString(),
    }, null, 2)}\n`, "utf8");
    throw new Error(`Manufacturing candidates incomplete: ${failures.map((row) => row.candidate_id).join(", ")}. See ${failurePath}`);
  }
  const document = {
    schema: MANUFACTURING_PORTFOLIO_SCHEMA,
    status: "completed",
    brief_sha256: prepared.brief.sha256,
    filled_prompt_sha256: prepared.manifest.filled_prompt_sha256,
    candidate_count: completed.length,
    writer_policy: policy.name,
    model_lock_path: lock?.path ?? null,
    model_lock_sha256: lock?.sha256 ?? null,
    writer_concurrency: writerConcurrency,
    writer_stagger_ms: writerStaggerMs,
    candidates: completed,
    completed_at: new Date().toISOString(),
  };
  assertValid("manufacturing portfolio", validateManufacturingPortfolio(document, { promptSha256: prepared.manifest.filled_prompt_sha256, expectedCandidates: candidates }));
  await writeJsonExclusive(portfolioPath, document);
  return { prepared, document, portfolioPath };
}

function auditionLabels(candidates, seed) {
  return [...candidates]
    .sort((left, right) => sha256Text(`${seed}\0${left.id}`).localeCompare(sha256Text(`${seed}\0${right.id}`)))
    .map((row, index) => ({ ...row, audition_label: String.fromCharCode(65 + index) }));
}

async function stitchAuditionVariant(variant, outputPath) {
  const inputPaths = variant.results.map((row) => row.output_path);
  const args = [];
  for (const inputPath of inputPaths) args.push("-i", inputPath);
  const padded = inputPaths.map((_, index) => `[${index}:a]apad=pad_dur=${index === inputPaths.length - 1 ? 0 : 0.08}[a${index}]`).join(";");
  const concatInputs = inputPaths.map((_, index) => `[a${index}]`).join("");
  args.push(
    "-filter_complex", `${padded};${concatInputs}concat=n=${inputPaths.length}:v=0:a=1[cat];[cat]loudnorm=I=-16:TP=-1.5:LRA=11[out]`,
    "-map", "[out]", "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", "-y", outputPath,
  );
  runLocal("ffmpeg", args);
}

async function auditionCandidates(directory, flags) {
  const portfolio = await writeCandidates(directory, flags);
  const selectionPath = path.join(directory, "manufacturing_selection.json");
  if (!await exists(selectionPath)) throw new Error("Run manufacturing selection before the blind audio audition.");
  const selectionBytes = await fs.readFile(selectionPath);
  const selection = JSON.parse(selectionBytes.toString("utf8"));
  const auditionCandidateCount = Math.max(2, Math.min(6, Number(flags["audition-candidate-count"] ?? 3) || 3));
  const auditionBlindIds = new Set([...selection.rankings]
    .sort((left, right) => Number(left.rank) - Number(right.rank))
    .slice(0, auditionCandidateCount)
    .map((row) => row.blind_id));
  const outputDirectory = path.join(directory, "manufacturing_audio_audition");
  await fs.mkdir(outputDirectory, { recursive: true });
  const seed = sha256Text(selectionBytes);
  const labeled = auditionLabels(
    portfolio.document.candidates.filter((row) => auditionBlindIds.has(row.blind_id)),
    seed,
  );
  const voice = qwenPrimaryLockForVoice(DEFAULT_NARRATOR_VOICE_ID);
  if (await fileSha256(voice.reference_audio_path) !== voice.reference_audio_sha256) throw new Error("Locked narrator reference hash mismatch.");
  const candidates = [];
  for (const row of labeled) {
    const fullText = await fs.readFile(row.output_path, "utf8");
    const excerpt = extractOpeningAuditionText(fullText);
    candidates.push({
      audition_label: row.audition_label,
      candidate_id: row.id,
      candidate_blind_id: row.blind_id,
      candidate_sha256: row.output_sha256,
      excerpt_text: excerpt.text,
      excerpt_word_count: excerpt.word_count,
      excerpt_sha256: excerpt.sha256,
      units: sentenceCompleteAuditionUnits(excerpt.text).map((text, index) => ({
        id: `blind_${row.audition_label}_opening_${String(index + 1).padStart(2, "0")}`,
        text,
      })),
    });
  }
  const manifestPath = path.join(outputDirectory, "manufacturing_audio_audition_manifest.json");
  const manifest = {
    schema: "goldflow_manhwa_manufacturing_audio_audition_v1",
    status: "prepared",
    portfolio_sha256: await fileSha256(portfolio.portfolioPath),
    selection_sha256: sha256Text(selectionBytes),
    audition_candidate_count: candidates.length,
    label_seed_sha256: seed,
    requested_window_sec: [60, 90],
    voice_lock: {
      provider: voice.provider,
      model_id: voice.model_id,
      model_revision: voice.model_revision,
      voice_id: voice.voice_id,
      reference_variant_id: voice.reference_variant_id ?? null,
      reference_audio_path: voice.reference_audio_path,
      reference_audio_sha256: voice.reference_audio_sha256,
      reference_text: voice.reference_text,
      generation_parameters: {
        temperature: voice.temperature,
        top_p: voice.top_p,
        top_k: voice.top_k,
        repetition_penalty: voice.repetition_penalty,
        max_tokens: voice.max_tokens,
      },
    },
    candidates,
    prepared_at: new Date().toISOString(),
  };
  if (!await exists(manifestPath)) await writeJsonExclusive(manifestPath, manifest);
  else {
    const existing = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    if (existing.portfolio_sha256 !== manifest.portfolio_sha256 || existing.selection_sha256 !== manifest.selection_sha256) {
      throw new Error("Existing manufacturing audio audition is stale.");
    }
  }
  const generationManifestPath = path.join(outputDirectory, "qwen_generation_manifest.json");
  const generationReportPath = path.join(outputDirectory, "qwen_generation_report.json");
  const generationManifest = {
    schema: "goldflow_narration_v2_bakeoff_manifest_v1",
    status: "ready",
    phase: "manufacturing_opening_audio_audition",
    diagnostic_only: true,
    output_dir: path.join(outputDirectory, "raw"),
    model: { id: voice.model_id, revision: voice.model_revision },
    references: {
      production_default: {
        audio_path: voice.reference_audio_path,
        audio_sha256: voice.reference_audio_sha256,
        text: voice.reference_text,
        style: voice.reference_variant_id ?? "production_default",
      },
    },
    variants: candidates.map((row) => ({
      id: `blind_${row.audition_label}`,
      mode: "batch4",
      seed: Number.parseInt(sha256Text(`${seed}\0${row.audition_label}`).slice(0, 8), 16),
      generation_parameters: manifest.voice_lock.generation_parameters,
      units: row.units.map((unit) => ({ id: unit.id, text: unit.text, reference_id: "production_default" })),
    })),
  };
  if (!await exists(generationManifestPath)) await writeJsonExclusive(generationManifestPath, generationManifest);
  if (!await exists(generationReportPath)) {
    runLocal(process.env.ANIFACTORY_QWEN_PYTHON || DEFAULT_QWEN_PYTHON, [
      path.join(REPO_ROOT, "scripts/tts-narration-v2-bakeoff-runner.py"),
      "--manifest", generationManifestPath,
      "--report", generationReportPath,
    ]);
  }
  const generationReport = JSON.parse(await fs.readFile(generationReportPath, "utf8"));
  const audio = [];
  for (const variant of generationReport.variants) {
    const label = variant.id.replace(/^blind_/, "");
    const outputPath = path.join(outputDirectory, `blind_${label}.wav`);
    if (!await exists(outputPath)) await stitchAuditionVariant(variant, outputPath);
    audio.push({
      blind_label: label,
      audio_path: outputPath,
      audio_sha256: await fileSha256(outputPath),
      duration_sec: variant.generated_audio_sec,
    });
  }
  audio.sort((left, right) => left.blind_label.localeCompare(right.blind_label));
  const packetPath = path.join(outputDirectory, "blind_audio_review_packet.json");
  const packet = {
    schema: "goldflow_manhwa_manufacturing_audio_review_packet_v1",
    status: "ready",
    decision_authority: "operator_blind_preference",
    labels: audio.map((row) => row.blind_label),
    audio,
    instruction: `Listen without opening the manifest. Rank ${audio.map((row) => row.blind_label).join("-")} by which opening you would continue watching after a normal YouTube click.`,
  };
  if (!await exists(packetPath)) await writeJsonExclusive(packetPath, packet);
  return { manifestPath, generationReportPath, packetPath, audio };
}

async function manufacturingTimingStage(paths, targetMinutes) {
  const metadata = (await Promise.all(paths.map(async (filePath) => (
    await exists(filePath) ? readCodexCallMetadata(filePath.replace(/\.meta\.json$/, "")) : null
  )))).filter(Boolean);
  const starts = metadata.map((row) => Date.parse(row.studio_timing?.created_at ?? row.started_at)).filter(Number.isFinite);
  const ends = metadata.map((row) => Date.parse(row.studio_timing?.completed_at ?? row.completed_at)).filter(Number.isFinite);
  if (!starts.length || !ends.length) return { status: "not_measured", target_minutes: targetMinutes };
  const durationMinutes = (Math.max(...ends) - Math.min(...starts)) / 60_000;
  return {
    status: durationMinutes <= targetMinutes ? "within_target" : "over_target",
    target_minutes: targetMinutes,
    measured_minutes: Number(durationMinutes.toFixed(2)),
    call_count: metadata.length,
    started_at: new Date(Math.min(...starts)).toISOString(),
    completed_at: new Date(Math.max(...ends)).toISOString(),
  };
}

async function writeManufacturingTimingReport(directory) {
  const responseDirectory = path.join(directory, ".model_responses");
  const draftDirectory = path.join(directory, "manufactured_drafts");
  const portfolioPath = path.join(directory, "manufacturing_portfolio.json");
  const policy = sourceWriterPolicy(await exists(portfolioPath) ? JSON.parse(await fs.readFile(portfolioPath, "utf8")) : null);
  const stages = {
    premise_ideation: await manufacturingTimingStage([
      path.join(responseDirectory, "manufacturing_topic_pool.txt.meta.json"),
      path.join(responseDirectory, "manufacturing_topic_shortlist.txt.meta.json"),
    ], 30),
    prompt_preparation: await manufacturingTimingStage([
      path.join(responseDirectory, "manufacturing_prompt.txt.meta.json"),
    ], 10),
    candidate_writing: await manufacturingTimingStage(policy.candidates.map(
      (row) => path.join(draftDirectory, `${row.id}.txt.meta.json`),
    ), policy.candidates.length === 1 ? 90 : 120),
  };
  if (policy.candidates.length > 1) {
    stages.selection = await manufacturingTimingStage([
      path.join(responseDirectory, "manufacturing_selection.txt.meta.json"),
    ], 20);
  } else {
    const roundDirectories = await fs.readdir(path.join(directory, "revision_loop")).catch(() => []);
    stages.revision = await manufacturingTimingStage(roundDirectories.filter((name) => /^round_\d+$/.test(name)).sort().flatMap((name) => (
      ["diagnose_response", "revise_response", "verify_response"].map((call) => path.join(directory, "revision_loop", name, `${call}.txt.meta.json`))
    )), 90);
  }
  const measured = Object.values(stages).filter((row) => row.status !== "not_measured");
  const starts = measured.map((row) => Date.parse(row.started_at)).filter(Number.isFinite);
  const ends = measured.map((row) => Date.parse(row.completed_at)).filter(Number.isFinite);
  const totalMinutes = starts.length && ends.length
    ? (Math.max(...ends) - Math.min(...starts)) / 60_000
    : null;
  const report = {
    schema: "goldflow_manhwa_manufacturing_timing_v1",
    status: measured.some((row) => row.status === "over_target") ? "target_missed" : "on_target_or_incomplete",
    target_total_minutes: policy.candidates.length === 1 ? 150 : 180,
    writer_policy: policy.name,
    candidate_count: policy.candidates.length,
    measured_total_minutes: totalMinutes == null ? null : Number(totalMinutes.toFixed(2)),
    stages,
    generated_at: new Date().toISOString(),
  };
  const outputPath = path.join(directory, "manufacturing_timing_report.json");
  await writeJsonAtomic(outputPath, report);
  return { outputPath, report };
}

async function selectCandidate(directory, flags) {
  const portfolio = await writeCandidates(directory, flags);
  if (portfolio.document.candidates.length === 1) throw new Error("Single-draft portfolios have no selection stage; run source manufacture revise.");
  const selectionPath = path.join(directory, "manufacturing_selection.json");
  const selectedScriptPath = path.join(directory, "manufacturing_selected_script.txt");
  if (await exists(selectionPath)) {
    const document = JSON.parse(await fs.readFile(selectionPath, "utf8"));
    assertValid("manufacturing selection", validateManufacturingSelection(document, { portfolio: portfolio.document }));
    return { portfolio, document, selectionPath, selectedScriptPath };
  }
  const selector = promptBody(await fs.readFile(SELECTOR_PROMPT_PATH, "utf8"));
  let calibration = portfolio.prepared.brief.document.own_channel_apv_observations ?? [];
  if (calibration.length === 0) {
    const evidenceSnapshot = JSON.parse(await fs.readFile(SOURCE_EVIDENCE_SNAPSHOT_PATH, "utf8"));
    calibration = (evidenceSnapshot.own_channel_evidence ?? []).map((row) => ({
      title: row.title,
      average_percentage_viewed: row.average_percentage_viewed,
    }));
  }
  // Content-addressed ordering removes the fixed model/position pattern without exposing authorship.
  const selectorCandidates = [...portfolio.document.candidates]
    .sort((left, right) => left.output_sha256.localeCompare(right.output_sha256));
  let prompt = `${selector}\n\nAPPROVED TITLE, PREMISE, AND OPENING TARGET\n${JSON.stringify({
    title: portfolio.prepared.brief.document.title,
    core_premise: portfolio.prepared.brief.document.core_premise,
    opening_target: portfolio.prepared.brief.document.opening_target,
    reference_outlier: portfolio.prepared.brief.document.reference_outlier,
    reference_opening_benchmark: portfolio.prepared.brief.document.reference_opening_benchmark ?? null,
  }, null, 2)}\n\nOWN-CHANNEL APV CALIBRATION\n${JSON.stringify(calibration, null, 2)}\n\nBLIND MANIFEST\n${JSON.stringify(selectorCandidates.map((row) => ({ blind_id: row.blind_id, sha256: row.output_sha256 })), null, 2)}`;
  for (const row of selectorCandidates) prompt += `\n\nBLIND CANDIDATE ${row.blind_id}\n${await fs.readFile(row.output_path, "utf8")}`;
  const rawPath = path.join(directory, ".model_responses", "manufacturing_selection.txt");
  const response = await modelCall({
    outputPath: rawPath,
    prompt,
    provider: "chatgpt_web",
    model: "gpt-6-sol",
    effort: "medium",
    stageName: "winner_source_longform_draft_selection_manufacturing",
    timeoutMs: Number(flags["selector-timeout-ms"] ?? 3_600_000),
  });
  let document;
  try {
    document = parseJsonObjectFromPlannerOutput(response.content).value;
  } catch (error) {
    throw new Error(`Manufacturing selector returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertValid("manufacturing selection", validateManufacturingSelection(document, { portfolio: portfolio.document }));
  await writeJsonExclusive(selectionPath, document);
  const winner = portfolio.document.candidates.find((row) => row.blind_id === document.selected_blind_id);
  await writeExclusive(selectedScriptPath, await fs.readFile(winner.output_path));
  return { portfolio, document, selectionPath, selectedScriptPath };
}

async function comparePromptVersions(directory, flags) {
  if (!flags["legacy-manifest"]) throw new Error("Use --legacy-manifest <recovered-drafts-manifest.json>.");
  const portfolio = await writeCandidates(directory, flags);
  const legacyManifestPath = path.resolve(flags["legacy-manifest"]);
  const legacyManifest = JSON.parse(await fs.readFile(legacyManifestPath, "utf8"));
  if (legacyManifest?.schema !== "goldflow_recovered_web_drafts_v1" || legacyManifest?.status !== "recovered") {
    throw new Error("Legacy comparison manifest is invalid.");
  }
  if (!Array.isArray(legacyManifest.candidates) || legacyManifest.candidates.length < 1) {
    throw new Error("Legacy comparison manifest has no candidates.");
  }

  const compactCandidates = portfolio.document.candidates.map((row) => ({
    candidate_id: row.id,
    source_prompt_version: "compact_v2",
    source_prompt_sha256: portfolio.document.filled_prompt_sha256,
    provider: row.provider,
    model: row.model,
    output_path: row.output_path,
    output_sha256: row.output_sha256,
    word_count: row.word_count,
  }));
  const legacyCandidates = [];
  for (const row of legacyManifest.candidates) {
    const outputPath = path.resolve(row.output_path);
    if (!await exists(outputPath)) throw new Error(`Legacy candidate is missing: ${row.id}.`);
    const outputSha256 = await fileSha256(outputPath);
    if (outputSha256 !== row.output_sha256) throw new Error(`Legacy candidate hash mismatch: ${row.id}.`);
    legacyCandidates.push({
      candidate_id: row.id,
      source_prompt_version: row.source_prompt_version ?? "long_v1",
      source_prompt_sha256: legacyManifest.source_prompt_sha256,
      provider: row.provider,
      model: row.model_slug,
      output_path: outputPath,
      output_sha256: outputSha256,
      word_count: row.word_count ?? words(await fs.readFile(outputPath, "utf8")),
    });
  }

  const candidates = [...compactCandidates, ...legacyCandidates]
    .sort((left, right) => sha256Text(`prompt-ab\0${left.output_sha256}`).localeCompare(sha256Text(`prompt-ab\0${right.output_sha256}`)))
    .map((row, index) => ({ ...row, blind_id: `candidate_${String.fromCharCode(97 + index)}` }));
  if (candidates.length > 26) throw new Error("Prompt comparison supports at most 26 candidates.");

  const decodeManifestPath = path.join(directory, "manufacturing_prompt_ab_decode_manifest.json");
  const decodeManifest = {
    schema: "goldflow_manhwa_prompt_ab_decode_manifest_v1",
    status: "ready",
    comparison_rule: "Candidate source prompt, provider, model, length, and original ID were hidden from the selector.",
    current_portfolio_path: portfolio.portfolioPath,
    current_portfolio_sha256: await fileSha256(portfolio.portfolioPath),
    legacy_manifest_path: legacyManifestPath,
    legacy_manifest_sha256: await fileSha256(legacyManifestPath),
    candidates,
    created_at: new Date().toISOString(),
  };
  if (!await exists(decodeManifestPath)) await writeJsonExclusive(decodeManifestPath, decodeManifest);
  else {
    const existing = JSON.parse(await fs.readFile(decodeManifestPath, "utf8"));
    const existingInputs = (existing.candidates ?? []).map((row) => `${row.blind_id}:${row.output_sha256}`).join("|");
    const currentInputs = candidates.map((row) => `${row.blind_id}:${row.output_sha256}`).join("|");
    if (existingInputs !== currentInputs) throw new Error("Existing prompt comparison decode manifest is stale.");
  }

  const selector = promptBody(await fs.readFile(SELECTOR_PROMPT_PATH, "utf8"));
  let calibration = portfolio.prepared.brief.document.own_channel_apv_observations ?? [];
  if (calibration.length === 0) {
    const evidenceSnapshot = JSON.parse(await fs.readFile(SOURCE_EVIDENCE_SNAPSHOT_PATH, "utf8"));
    calibration = (evidenceSnapshot.own_channel_evidence ?? []).map((row) => ({
      title: row.title,
      average_percentage_viewed: row.average_percentage_viewed,
    }));
  }
  const experimentHeader = `${selector}\n\nBLIND PROMPT-STRATEGY EXPERIMENT\nThe scripts below were produced by more than one undisclosed instruction strategy. Do not guess, discuss, or reward a strategy, model, provider, manuscript length, or candidate family. Judge only the exact narration each viewer would hear. Apply the same standard independently to every candidate.\n\nAPPROVED TITLE, PREMISE, AND OPENING TARGET\n${JSON.stringify({
    title: portfolio.prepared.brief.document.title,
    core_premise: portfolio.prepared.brief.document.core_premise,
    opening_target: portfolio.prepared.brief.document.opening_target,
    reference_outlier: portfolio.prepared.brief.document.reference_outlier,
    reference_opening_benchmark: portfolio.prepared.brief.document.reference_opening_benchmark ?? null,
  }, null, 2)}\n\nOWN-CHANNEL APV CALIBRATION\n${JSON.stringify(calibration, null, 2)}`;
  const promptForCandidates = async (rows, roundInstruction = "") => {
    let value = `${experimentHeader}${roundInstruction ? `\n\nROUND INSTRUCTION\n${roundInstruction}` : ""}\n\nBLIND MANIFEST\n${JSON.stringify(rows.map((row) => ({ blind_id: row.blind_id, sha256: row.output_sha256 })), null, 2)}`;
    for (const row of rows) value += `\n\nBLIND CANDIDATE ${row.blind_id}\n${await fs.readFile(row.output_path, "utf8")}`;
    return value;
  };
  const prompt = await promptForCandidates(candidates);
  const estimatedInputTokens = Math.ceil(prompt.length / 4);

  const rawPath = path.join(directory, ".model_responses", "manufacturing_prompt_ab_selection.txt");
  const selectionPath = path.join(directory, "manufacturing_prompt_ab_selection.json");
  let selection;
  let shouldWriteSelection = false;
  let comparisonMode = "single_pass";
  let bracketManifestPath = null;
  if (await exists(selectionPath)) {
    selection = JSON.parse(await fs.readFile(selectionPath, "utf8"));
    bracketManifestPath = path.join(directory, "manufacturing_prompt_ab_bracket_manifest.json");
    if (await exists(bracketManifestPath)) comparisonMode = "two_round_context_safe_bracket";
  } else {
    if (estimatedInputTokens <= 140_000) {
      const response = await modelCall({
        outputPath: rawPath,
        prompt,
        provider: "chatgpt_web",
        model: "gpt-6-sol",
        effort: "medium",
        stageName: "winner_source_prompt_strategy_ab_selection",
        timeoutMs: Number(flags["selector-timeout-ms"] ?? 3_600_000),
      });
      try {
        selection = canonicalizeSelectionArithmetic(parseJsonObjectFromPlannerOutput(response.content).value);
      } catch (error) {
        throw new Error(`Prompt comparison selector returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      if (candidates.length !== 8) {
        throw new Error(`Prompt comparison needs a context-safe panel design for ${candidates.length} candidates (${estimatedInputTokens} estimated tokens).`);
      }
      comparisonMode = "two_round_context_safe_bracket";
      const candidateByBlindId = new Map(candidates.map((row) => [row.blind_id, row]));
      const sized = await Promise.all(candidates.map(async (row) => ({
        row,
        chars: (await fs.readFile(row.output_path, "utf8")).length,
      })));
      sized.sort((left, right) => right.chars - left.chars || left.row.blind_id.localeCompare(right.row.blind_id));
      const qualifierGroups = [[], []];
      const qualifierChars = [0, 0];
      for (const item of sized) {
        const eligible = [0, 1].filter((index) => qualifierGroups[index].length < 4);
        const groupIndex = eligible.sort((left, right) => qualifierChars[left] - qualifierChars[right] || left - right)[0];
        qualifierGroups[groupIndex].push(item.row);
        qualifierChars[groupIndex] += item.chars;
      }

      const runRound = async (roundId, rows, roundInstruction) => {
        const roundPrompt = await promptForCandidates(rows, roundInstruction);
        const roundEstimatedTokens = Math.ceil(roundPrompt.length / 4);
        if (roundEstimatedTokens > 140_000) {
          throw new Error(`Prompt comparison round ${roundId} remains too large at ${roundEstimatedTokens} estimated tokens.`);
        }
        const roundRawPath = path.join(directory, ".model_responses", `manufacturing_prompt_ab_${roundId}.txt`);
        const roundSelectionPath = path.join(directory, `manufacturing_prompt_ab_${roundId}.json`);
        let roundSelection;
        if (await exists(roundSelectionPath)) {
          roundSelection = JSON.parse(await fs.readFile(roundSelectionPath, "utf8"));
        } else {
          const response = await modelCall({
            outputPath: roundRawPath,
            prompt: roundPrompt,
            provider: "chatgpt_web",
            model: "gpt-6-sol",
            effort: "medium",
            stageName: `winner_source_prompt_strategy_ab_${roundId}`,
            timeoutMs: Number(flags["selector-timeout-ms"] ?? 3_600_000),
          });
          try {
            roundSelection = canonicalizeSelectionArithmetic(parseJsonObjectFromPlannerOutput(response.content).value);
          } catch (error) {
            throw new Error(`Prompt comparison round ${roundId} returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
          }
          assertValid(`prompt comparison round ${roundId}`, validateManufacturingSelection(roundSelection, {
            portfolio: { candidates: rows.map((row) => ({ blind_id: row.blind_id })) },
          }));
          await writeJsonExclusive(roundSelectionPath, roundSelection);
        }
        assertValid(`prompt comparison round ${roundId}`, validateManufacturingSelection(roundSelection, {
          portfolio: { candidates: rows.map((row) => ({ blind_id: row.blind_id })) },
        }));
        return {
          round_id: roundId,
          candidate_blind_ids: rows.map((row) => row.blind_id),
          estimated_input_tokens: roundEstimatedTokens,
          selection: roundSelection,
          selection_path: roundSelectionPath,
          selection_sha256: await fileSha256(roundSelectionPath),
          raw_response_path: roundRawPath,
        };
      };

      const qualifiers = await Promise.all([
        runRound("qualifier_a", qualifierGroups[0], "This is qualifier panel A. Rank only these four scripts by predicted APV. Every script advances to a second full-script evaluation; do not speculate about unseen candidates."),
        runRound("qualifier_b", qualifierGroups[1], "This is qualifier panel B. Rank only these four scripts by predicted APV. Every script advances to a second full-script evaluation; do not speculate about unseen candidates."),
      ]);
      const orderedQualifierRows = qualifiers.map((round) => [...round.selection.rankings]
        .sort((left, right) => Number(left.rank) - Number(right.rank)));
      const championshipRows = [
        ...orderedQualifierRows[0].slice(0, 2),
        ...orderedQualifierRows[1].slice(0, 2),
      ].map((row) => candidateByBlindId.get(row.blind_id));
      const placementRows = [
        ...orderedQualifierRows[0].slice(2),
        ...orderedQualifierRows[1].slice(2),
      ].map((row) => candidateByBlindId.get(row.blind_id));
      const finals = await Promise.all([
        runRound("championship", championshipRows, "This is the second full-script evaluation for the top two scripts from each qualifier. Re-evaluate every script independently from the complete narration and rank this panel by predicted APV."),
        runRound("placement", placementRows, "This is the second full-script evaluation for the other two scripts from each qualifier. Re-evaluate every script independently from the complete narration and rank this panel by predicted APV."),
      ]);
      const qualifierRowById = new Map(qualifiers.flatMap((round) => round.selection.rankings)
        .map((row) => [row.blind_id, row]));
      const finalRows = finals.flatMap((round) => round.selection.rankings.map((row) => {
        const qualifierRow = qualifierRowById.get(row.blind_id);
        const qualifierViewerById = new Map((qualifierRow?.viewer_simulation ?? [])
          .map((viewer) => [viewer.viewer_id, viewer]));
        const viewerSimulation = row.viewer_simulation.map((viewer) => {
          const qualifierViewer = qualifierViewerById.get(viewer.viewer_id);
          const combinedPercentage = mean([
            qualifierViewer?.predicted_percentage_viewed,
            viewer.predicted_percentage_viewed,
          ]);
          return {
            ...viewer,
            predicted_percentage_viewed: Number(combinedPercentage.toFixed(2)),
            qualifier_predicted_percentage_viewed: Number(qualifierViewer.predicted_percentage_viewed),
            second_round_predicted_percentage_viewed: Number(viewer.predicted_percentage_viewed),
          };
        });
        const openingSurvivalCurve = Object.fromEntries([
          "thirty_seconds",
          "sixty_seconds",
          "two_minutes",
          "five_minutes",
        ].map((checkpoint) => [
          checkpoint,
          Number(mean([
            qualifierRow?.opening_survival_curve?.[checkpoint],
            row.opening_survival_curve?.[checkpoint],
          ]).toFixed(2)),
        ]));
        return {
          ...row,
          opening_survival_curve: openingSurvivalCurve,
          viewer_simulation: viewerSimulation,
          predicted_average_percentage_viewed: Number(mean(viewerSimulation
            .map((viewer) => viewer.predicted_percentage_viewed)).toFixed(2)),
          qualifier_predicted_average_percentage_viewed: Number(qualifierRow.predicted_average_percentage_viewed),
          second_round_predicted_average_percentage_viewed: Number(row.predicted_average_percentage_viewed),
          second_round: round.round_id,
        };
      })).sort((left, right) => Number(right.predicted_average_percentage_viewed) - Number(left.predicted_average_percentage_viewed)
        || left.blind_id.localeCompare(right.blind_id));
      const rankings = finalRows.map((row, index) => ({ ...row, rank: index + 1 }));
      selection = {
        schema: "goldflow_manhwa_manufacturing_selection_v1",
        status: "selected",
        selected_blind_id: rankings[0].blind_id,
        rankings,
        decision_rationale: `Context-safe blind bracket. ${finals[0].selection.decision_rationale} ${finals[1].selection.decision_rationale}`,
      };
      bracketManifestPath = path.join(directory, "manufacturing_prompt_ab_bracket_manifest.json");
      await writeJsonExclusive(bracketManifestPath, {
        schema: "goldflow_manhwa_prompt_ab_bracket_v1",
        status: "completed",
        full_prompt_estimated_input_tokens: estimatedInputTokens,
        direct_context_limit_tokens: 150_000,
        safe_round_ceiling_tokens: 140_000,
        rule: "Every candidate received one qualifier and one second full-script APV evaluation. Final order uses the arithmetic mean of each viewer's two predicted APV values.",
        qualifiers: qualifiers.map(({ selection, ...round }) => round),
        finals: finals.map(({ selection, ...round }) => round),
        completed_at: new Date().toISOString(),
      });
    }
    shouldWriteSelection = true;
  }
  assertValid("prompt comparison selection", validateManufacturingSelection(selection, {
    portfolio: { candidates: candidates.map((row) => ({ blind_id: row.blind_id })) },
  }));
  if (shouldWriteSelection) await writeJsonExclusive(selectionPath, selection);

  const decodedRankings = [...selection.rankings]
    .sort((left, right) => Number(left.rank) - Number(right.rank))
    .map((row) => ({
      ...row,
      ...candidates.find((candidate) => candidate.blind_id === row.blind_id),
    }));
  const versions = [...new Set(candidates.map((row) => row.source_prompt_version))];
  const promptVersionSummary = versions.map((version) => {
    const rows = decodedRankings.filter((row) => row.source_prompt_version === version);
    return {
      source_prompt_version: version,
      candidate_count: rows.length,
      best_rank: Math.min(...rows.map((row) => Number(row.rank))),
      top_three_count: rows.filter((row) => Number(row.rank) <= 3).length,
      mean_predicted_apv: Number(mean(rows.map((row) => row.predicted_average_percentage_viewed)).toFixed(2)),
      median_predicted_apv: Number(median(rows.map((row) => row.predicted_average_percentage_viewed)).toFixed(2)),
      mean_opening_survival: Object.fromEntries(["thirty_seconds", "sixty_seconds", "two_minutes", "five_minutes"].map((checkpoint) => [
        checkpoint,
        Number(mean(rows.map((row) => row.opening_survival_curve?.[checkpoint])).toFixed(2)),
      ])),
    };
  }).sort((left, right) => left.best_rank - right.best_rank);
  const winner = decodedRankings[0];
  const report = {
    schema: "goldflow_manhwa_prompt_ab_report_v1",
    status: "completed",
    caution: "Predicted APV is a blinded pre-upload simulation, not measured audience behavior.",
    ranking_metric: "predicted_average_percentage_viewed",
    comparison_mode: comparisonMode,
    full_prompt_estimated_input_tokens: estimatedInputTokens,
    selected_candidate: {
      blind_id: winner.blind_id,
      candidate_id: winner.candidate_id,
      source_prompt_version: winner.source_prompt_version,
      provider: winner.provider,
      model: winner.model,
      output_path: winner.output_path,
      output_sha256: winner.output_sha256,
      predicted_average_percentage_viewed: winner.predicted_average_percentage_viewed,
    },
    prompt_version_summary: promptVersionSummary,
    decoded_rankings: decodedRankings,
    blind_decision_rationale: selection.decision_rationale,
    selection_path: selectionPath,
    selection_sha256: await fileSha256(selectionPath),
    bracket_manifest_path: bracketManifestPath,
    bracket_manifest_sha256: bracketManifestPath ? await fileSha256(bracketManifestPath) : null,
    decode_manifest_path: decodeManifestPath,
    decode_manifest_sha256: await fileSha256(decodeManifestPath),
    completed_at: new Date().toISOString(),
  };
  const reportPath = path.join(directory, "manufacturing_prompt_ab_report.json");
  if (!await exists(reportPath)) await writeJsonExclusive(reportPath, report);
  return { report, reportPath, selectionPath, decodeManifestPath };
}

async function approveLearning(directory, flags) {
  if (!flags.template || !flags["approved-by"]) throw new Error("Use --template <complete-template.txt> --approved-by <name>.");
  const content = await fs.readFile(path.resolve(flags.template), "utf8");
  assertValid("proposed manufacturing template", validateManufacturingTemplate(content));
  const channel = channelFor(directory, flags);
  const templateSha256 = sha256Text(content);
  const templateDirectory = path.join(DATA_ROOT, "channels", channel, "analytics", "manufacturing_prompt_templates");
  const version = `${new Date().toISOString().slice(0, 10)}-${templateSha256.slice(0, 12)}`;
  const templatePath = path.join(templateDirectory, `${version}.txt`);
  const approvalPath = path.join(templateDirectory, `${version}.approval.json`);
  const previous = await activeManufacturingTemplate(directory, flags);
  if (!await exists(templatePath)) await writeExclusive(templatePath, content);
  else if (await fileSha256(templatePath) !== templateSha256) throw new Error("Versioned manufacturing template hash mismatch.");
  const approval = {
    schema: "goldflow_manhwa_manufacturing_template_approval_v1",
    status: "approved",
    channel,
    version,
    template_path: templatePath,
    template_sha256: templateSha256,
    rollback_template_path: previous.path,
    rollback_template_sha256: previous.sha256,
    analytics_proposal_sha256: flags["proposal-sha256"] ?? null,
    analytics_approval_sha256: flags["approval-sha256"] ?? null,
    approved_by: String(flags["approved-by"]),
    approved_at: new Date().toISOString(),
  };
  if (!await exists(approvalPath)) await writeJsonExclusive(approvalPath, approval);
  await writeJsonAtomic(activeTemplateManifestPath(directory, flags), {
    schema: "goldflow_manhwa_manufacturing_active_template_v1",
    status: "approved",
    channel,
    version,
    template_path: templatePath,
    template_sha256: templateSha256,
    approval_path: approvalPath,
    activated_at: new Date().toISOString(),
  });
  return { templatePath, approvalPath, currentPath: activeTemplateManifestPath(directory, flags), version };
}

async function promoteCandidate(directory, flags) {
  if (!flags["candidate-id"] || !flags["approved-by"] || !flags.reason) {
    throw new Error("Use --candidate-id <draft_id> --approved-by <name> --reason <reason>.");
  }
  const portfolio = await writeCandidates(directory, flags);
  const selectionPath = path.join(directory, "manufacturing_selection.json");
  if (!await exists(selectionPath)) throw new Error("Run selection before operator promotion.");
  const selection = JSON.parse(await fs.readFile(selectionPath, "utf8"));
  assertValid("manufacturing selection", validateManufacturingSelection(selection, { portfolio: portfolio.document }));
  const promoted = portfolio.document.candidates.find((row) => row.id === flags["candidate-id"]);
  if (!promoted) throw new Error(`Unknown candidate ID: ${flags["candidate-id"]}.`);
  const modelWinner = portfolio.document.candidates.find((row) => row.blind_id === selection.selected_blind_id);
  const selectedScriptPath = path.join(directory, "manufacturing_selected_script.txt");
  const modelSelectedScriptPath = path.join(directory, "manufacturing_model_selected_script.txt");
  const promotedBytes = await fs.readFile(promoted.output_path);
  const modelBytes = await fs.readFile(modelWinner.output_path);
  if (!await exists(modelSelectedScriptPath)) await writeExclusive(modelSelectedScriptPath, modelBytes);
  else if (await fileSha256(modelSelectedScriptPath) !== modelWinner.output_sha256) throw new Error("Archived model-selected script hash mismatch.");
  await writeAtomic(selectedScriptPath, promotedBytes);
  const receiptPath = path.join(directory, "manufacturing_operator_promotion.json");
  const receipt = {
    schema: "goldflow_manhwa_manufacturing_operator_promotion_v1",
    status: "operator_promoted",
    original_model_selected_blind_id: selection.selected_blind_id,
    original_model_selected_candidate_id: modelWinner.id,
    promoted_candidate_id: promoted.id,
    promoted_blind_id: promoted.blind_id,
    promoted_model: promoted.model,
    promoted_script_path: selectedScriptPath,
    promoted_script_sha256: promoted.output_sha256,
    model_selected_script_path: modelSelectedScriptPath,
    model_selected_script_sha256: modelWinner.output_sha256,
    selection_path: selectionPath,
    selection_sha256: await fileSha256(selectionPath),
    approved_by: String(flags["approved-by"]),
    reason: String(flags.reason),
    promoted_at: new Date().toISOString(),
  };
  if (!await exists(receiptPath)) await writeJsonExclusive(receiptPath, receipt);
  else {
    const existing = JSON.parse(await fs.readFile(receiptPath, "utf8"));
    if (existing.promoted_script_sha256 !== receipt.promoted_script_sha256) throw new Error("Existing operator promotion selects a different script.");
  }
  return { receiptPath, selectedScriptPath, receipt };
}

async function resolveImprovementIncumbent(directory, flags) {
  if (flags.script) {
    const scriptPath = path.resolve(flags.script);
    if (!await exists(scriptPath)) throw new Error(`Improvement script is missing: ${scriptPath}`);
    return { path: scriptPath, source: "operator_script" };
  }
  const reportPath = path.join(directory, "manufacturing_prompt_ab_report.json");
  if (await exists(reportPath)) {
    const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
    const selectedOutputPath = String(report?.selected_candidate?.output_path ?? "").trim();
    if (selectedOutputPath) {
      const scriptPath = path.resolve(selectedOutputPath);
      if (await exists(scriptPath)) return { path: scriptPath, source: "prompt_ab_winner" };
    }
  }
  const selectedPath = path.join(directory, "manufacturing_selected_script.txt");
  if (await exists(selectedPath)) return { path: selectedPath, source: "manufacturing_selection" };
  throw new Error("No improvement incumbent found. Pass --script <complete-script.txt>.");
}

function compactWinnerFeedback(report, outputSha256) {
  const row = (report?.decoded_rankings ?? []).find((candidate) => candidate?.output_sha256 === outputSha256)
    ?? null;
  if (!row) return null;
  const weakestViewers = [...(row.viewer_simulation ?? [])]
    .sort((left, right) => Number(left.predicted_percentage_viewed) - Number(right.predicted_percentage_viewed))
    .slice(0, 6)
    .map((viewer) => ({
      viewer_id: viewer.viewer_id,
      predicted_percentage_viewed: viewer.predicted_percentage_viewed,
      predicted_exit_point: viewer.predicted_exit_point,
      reason: viewer.reason,
    }));
  return {
    prior_predicted_average_percentage_viewed: row.predicted_average_percentage_viewed,
    prior_retention_reason: row.retention_reason,
    weakest_viewers: weakestViewers,
  };
}

async function runFastImprovementJudge({ directory, roundDirectory, roundNumber, panelNumber, brief, calibration, incumbent, challenger, flags }) {
  const selector = promptBody(await fs.readFile(SELECTOR_PROMPT_PATH, "utf8"));
  const panelId = `panel_${String(panelNumber).padStart(2, "0")}`;
  const challengerFirst = Number.parseInt(sha256Text(`${incumbent.sha256}\0${challenger.sha256}\0${panelId}`).slice(0, 2), 16) % 2 === 0;
  const ordered = challengerFirst
    ? [{ role: "challenger", ...challenger }, { role: "incumbent", ...incumbent }]
    : [{ role: "incumbent", ...incumbent }, { role: "challenger", ...challenger }];
  const labeled = ordered.map((row, index) => ({ ...row, blind_id: `candidate_${String.fromCharCode(97 + index)}` }));
  let prompt = `${selector}\n\nFAST IMPROVEMENT BLIND A/B PANEL ${panelNumber} OF ${FAST_IMPROVEMENT_PANEL_COUNT}\nJudge only expected percentage viewed. One script is an edit of the other, but do not infer which one, reward change itself, or consider manuscript length. Treat this as a fresh independent panel.\n\nAPPROVED TITLE AND PREMISE\n${JSON.stringify({
    title: brief.title,
    core_premise: brief.core_premise,
    opening_target: brief.opening_target,
  }, null, 2)}\n\nOWN-CHANNEL APV CALIBRATION\n${JSON.stringify(calibration, null, 2)}\n\nBLIND MANIFEST\n${JSON.stringify(labeled.map((row) => ({ blind_id: row.blind_id, sha256: row.sha256 })), null, 2)}`;
  for (const row of labeled) prompt += `\n\nBLIND CANDIDATE ${row.blind_id}\n${row.text}`;
  const responsePath = path.join(roundDirectory, "comparisons", `${panelId}.txt`);
  const selectionPath = path.join(roundDirectory, "comparisons", `${panelId}.json`);
  const response = await modelCall({
    outputPath: responsePath,
    prompt,
    provider: "chatgpt_web",
    model: "gpt-6-sol",
    effort: "medium",
    stageName: `winner_source_script_improvement_judge_r${String(roundNumber).padStart(2, "0")}_p${String(panelNumber).padStart(2, "0")}`,
    timeoutMs: Number(flags["judge-timeout-ms"] ?? 1_800_000),
  });
  let selection;
  try {
    selection = canonicalizeSelectionArithmetic(parseJsonObjectFromPlannerOutput(response.content).value);
  } catch (error) {
    throw new Error(`Fast improvement ${panelId} returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertValid(`fast improvement ${panelId}`, validateManufacturingSelection(selection, {
    portfolio: { candidates: labeled.map((row) => ({ blind_id: row.blind_id })) },
  }));
  if (!await exists(selectionPath)) await writeJsonExclusive(selectionPath, selection);
  const rowForRole = (role) => {
    const blindId = labeled.find((row) => row.role === role).blind_id;
    return selection.rankings.find((row) => row.blind_id === blindId);
  };
  const incumbentRow = rowForRole("incumbent");
  const challengerRow = rowForRole("challenger");
  const incumbentApv = Number(incumbentRow.predicted_average_percentage_viewed);
  const challengerApv = Number(challengerRow.predicted_average_percentage_viewed);
  return {
    panel_id: panelId,
    selection_path: selectionPath,
    selection_sha256: await fileSha256(selectionPath),
    response_path: responsePath,
    response_sha256: await fileSha256(responsePath),
    blind_decode: Object.fromEntries(labeled.map((row) => [row.blind_id, row.role])),
    incumbent_predicted_apv: incumbentApv,
    challenger_predicted_apv: challengerApv,
    predicted_apv_delta: Number((challengerApv - incumbentApv).toFixed(2)),
    winner: challengerApv > incumbentApv ? "challenger" : incumbentApv > challengerApv ? "incumbent" : "tie",
    decision_rationale: selection.decision_rationale,
  };
}

async function improveCandidate(directory, flags) {
  const maxRounds = Math.max(1, Math.min(3, Number(flags["max-rounds"] ?? 2) || 2));
  const editorEfforts = improvementEfforts(flags["edit-efforts"], maxRounds);
  const minimumApvDelta = Math.max(0, Number(flags["minimum-apv-delta"] ?? FAST_IMPROVEMENT_MIN_APV_DELTA) || 0);
  const loopDirectory = path.join(directory, "improvement_loop");
  const v00Path = path.join(loopDirectory, "v00_incumbent.txt");
  const currentWinnerPath = path.join(loopDirectory, "current_winner.txt");
  await fs.mkdir(loopDirectory, { recursive: true });

  const initial = await resolveImprovementIncumbent(directory, flags);
  const initialBytes = await fs.readFile(initial.path);
  if (!await exists(v00Path)) await writeExclusive(v00Path, initialBytes);
  const v00Sha256 = await fileSha256(v00Path);
  if (v00Sha256 !== sha256Text(initialBytes.toString("utf8"))) throw new Error("Existing improvement incumbent differs from the requested script.");
  if (!await exists(currentWinnerPath)) await writeExclusive(currentWinnerPath, initialBytes);

  const brief = await loadBrief(directory, flags);
  let calibration = brief.document.own_channel_apv_observations ?? [];
  if (calibration.length === 0) {
    const evidenceSnapshot = JSON.parse(await fs.readFile(SOURCE_EVIDENCE_SNAPSHOT_PATH, "utf8"));
    calibration = (evidenceSnapshot.own_channel_evidence ?? []).map((row) => ({
      title: row.title,
      average_percentage_viewed: row.average_percentage_viewed,
    }));
  }
  const priorReportPath = path.join(directory, "manufacturing_prompt_ab_report.json");
  let priorReport = await exists(priorReportPath) ? JSON.parse(await fs.readFile(priorReportPath, "utf8")) : null;
  const selectionPath = path.join(directory, "manufacturing_selection.json");
  const portfolioPath = path.join(directory, "manufacturing_portfolio.json");
  if (!priorReport && await exists(selectionPath) && await exists(portfolioPath)) {
    const selection = JSON.parse(await fs.readFile(selectionPath, "utf8"));
    const portfolio = JSON.parse(await fs.readFile(portfolioPath, "utf8"));
    priorReport = { decoded_rankings: selection.rankings.map((row) => ({ ...row,
      output_sha256: portfolio.candidates.find((candidate) => candidate.blind_id === row.blind_id)?.output_sha256 })) };
  }
  const editorInstruction = promptBody(await fs.readFile(FAST_IMPROVEMENT_EDITOR_PROMPT_PATH, "utf8"));
  const decisions = [];

  for (let roundNumber = 1; roundNumber <= maxRounds; roundNumber += 1) {
    const editorEffort = editorEfforts[roundNumber - 1];
    const roundDirectory = path.join(loopDirectory, `round_${String(roundNumber).padStart(2, "0")}`);
    const decisionPath = path.join(roundDirectory, "decision.json");
    if (await exists(decisionPath)) {
      const existing = JSON.parse(await fs.readFile(decisionPath, "utf8"));
      decisions.push(existing);
      if (existing.status !== "challenger_promoted") break;
      const promotedPath = path.resolve(existing.challenger.path);
      if (await fileSha256(promotedPath) !== existing.challenger.sha256) throw new Error(`Round ${roundNumber} promoted challenger hash mismatch.`);
      if (await fileSha256(currentWinnerPath) !== existing.challenger.sha256) {
        await writeAtomic(currentWinnerPath, await fs.readFile(promotedPath));
      }
      continue;
    }
    await fs.mkdir(path.join(roundDirectory, "comparisons"), { recursive: true });
    const startedAt = new Date().toISOString();
    const incumbentText = await fs.readFile(currentWinnerPath, "utf8");
    const roundIncumbentPath = path.join(roundDirectory, "incumbent.txt");
    if (!await exists(roundIncumbentPath)) await writeExclusive(roundIncumbentPath, incumbentText);
    else if (await fileSha256(roundIncumbentPath) !== sha256Text(incumbentText)) throw new Error(`Round ${roundNumber} incumbent hash mismatch.`);
    const incumbent = {
      path: roundIncumbentPath,
      text: incumbentText,
      sha256: sha256Text(incumbentText),
      word_count: words(incumbentText),
    };
    const feedback = compactWinnerFeedback(priorReport, incumbent.sha256);
    const directorNotesPath = flags["director-notes"] ? path.resolve(flags["director-notes"]) : null;
    const directorNotes = directorNotesPath ? validateDirectorNotes(
      JSON.parse(await fs.readFile(directorNotesPath, "utf8")), incumbent.sha256,
    ) : null;
    const editorBriefPath = path.join(roundDirectory, "editor_brief.json");
    const editorBrief = {
      schema: "goldflow_manhwa_fast_improvement_editor_brief_v1",
      status: "ready",
      round: roundNumber,
      model: "gpt-6-sol",
      reasoning_effort: editorEffort,
      incumbent_path: incumbent.path,
      incumbent_sha256: incumbent.sha256,
      incumbent_word_count: incumbent.word_count,
      approved_title: brief.document.title,
      approved_premise: brief.document.core_premise,
      prior_blind_feedback: feedback,
      director_notes: directorNotesPath ? { path: directorNotesPath, sha256: await fileSha256(directorNotesPath), instructions: directorNotes } : null,
      rule: `One ${editorEffort} call privately diagnoses and writes one complete challenger; no separate critique call or deterministic prose edit.`,
    };
    if (!await exists(editorBriefPath)) await writeJsonExclusive(editorBriefPath, editorBrief);
    else {
      const existingBrief = JSON.parse(await fs.readFile(editorBriefPath, "utf8"));
      if (existingBrief.incumbent_sha256 !== incumbent.sha256 || existingBrief.reasoning_effort !== editorEffort
        || (existingBrief.director_notes?.sha256 ?? null) !== (editorBrief.director_notes?.sha256 ?? null)) throw new Error(`Round ${roundNumber} editor brief is stale or has different effort/director notes.`);
    }
    const editorPrompt = `${editorInstruction}${directorNotes ? `\n\nDIRECTOR'S EXACT-SCRIPT REVIEW\n${directorNotes}` : ""}\n\nAPPROVED TITLE AND PREMISE\n${JSON.stringify({
      title: brief.document.title,
      core_premise: brief.document.core_premise,
      opening_target: brief.document.opening_target,
    }, null, 2)}\n\nPRIOR BLIND RETENTION EVIDENCE\n${JSON.stringify(feedback, null, 2)}\n\nINCUMBENT WORD COUNT\n${incumbent.word_count}\n\nEXACT INCUMBENT NARRATION\n${incumbent.text}`;
    const editorResponsePath = path.join(roundDirectory, "editor_response.txt");
    const challengerPath = path.join(roundDirectory, "challenger.txt");
    const editorResponse = await modelCall({
      outputPath: editorResponsePath,
      prompt: editorPrompt,
      provider: "chatgpt_web",
      model: "gpt-6-sol",
      effort: editorEffort,
      stageName: `winner_source_script_improvement_edit_r${String(roundNumber).padStart(2, "0")}`,
      timeoutMs: Number(flags["edit-timeout-ms"] ?? 2_400_000),
    });
    const challengerText = stripFence(editorResponse.content);
    const challengerBytes = `${challengerText}\n`;
    if (!await exists(challengerPath)) await writeExclusive(challengerPath, challengerBytes);
    else if (await fileSha256(challengerPath) !== sha256Text(challengerBytes)) throw new Error(`Round ${roundNumber} challenger differs from the recorded editor response.`);
    const normalizedChallengerText = await fs.readFile(challengerPath, "utf8");
    const challenger = {
      path: challengerPath,
      text: normalizedChallengerText,
      sha256: sha256Text(normalizedChallengerText),
      word_count: words(normalizedChallengerText),
    };
    const lengthAssessment = assessFastImprovementLength(incumbent.word_count, challenger.word_count);
    if (lengthAssessment.ratio == null || lengthAssessment.ratio < 0.75 || lengthAssessment.ratio > 1.25) {
      throw new Error(`Improvement challenger is probably incomplete or replaced the story (length ratio ${lengthAssessment.ratio}). No judge calls were spent.`);
    }
    const panels = await Promise.all(Array.from({ length: FAST_IMPROVEMENT_PANEL_COUNT }, (_, index) => runFastImprovementJudge({
      directory,
      roundDirectory,
      roundNumber,
      panelNumber: index + 1,
      brief: brief.document,
      calibration,
      incumbent,
      challenger,
      flags,
    })));
    const result = decideFastImprovement({
      panels,
      incumbentWordCount: incumbent.word_count,
      challengerWordCount: challenger.word_count,
      minimumApvDelta,
    });
    const promoted = result.accepted;
    const decision = {
      schema: "goldflow_manhwa_fast_improvement_decision_v1",
      status: promoted ? "challenger_promoted" : "incumbent_retained",
      round: roundNumber,
      editor_model: "gpt-6-sol",
      editor_reasoning_effort: editorEffort,
      judge_model: "gpt-6-sol",
      judge_reasoning_effort: "medium",
      incumbent: { path: incumbent.path, sha256: incumbent.sha256, word_count: incumbent.word_count },
      challenger: { path: challenger.path, sha256: challenger.sha256, word_count: challenger.word_count },
      editor_response: {
        path: editorResponsePath,
        sha256: await fileSha256(editorResponsePath),
        receipt_path: `${editorResponsePath}.meta.json`,
        receipt_sha256: await fileSha256(`${editorResponsePath}.meta.json`),
      },
      panels,
      decision: result,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    };
    await writeJsonExclusive(decisionPath, decision);
    if (promoted) await writeAtomic(currentWinnerPath, normalizedChallengerText);
    decisions.push(decision);
    if (!promoted) break;
  }

  const finalText = await fs.readFile(currentWinnerPath, "utf8");
  const reportPath = path.join(loopDirectory, "improvement_loop_report.json");
  const report = {
    schema: "goldflow_manhwa_fast_improvement_loop_v1",
    status: "completed",
    policy: "bounded_medium_high_editor_with_medium_blind_panels_v2",
    editor_efforts: editorEfforts,
    executed_editor_efforts: decisions.map((row) => row.editor_reasoning_effort),
    requested_max_rounds: maxRounds,
    initial_source: initial.source,
    v00_incumbent_path: v00Path,
    v00_incumbent_sha256: v00Sha256,
    final_script_path: currentWinnerPath,
    final_script_sha256: sha256Text(finalText),
    final_word_count: words(finalText),
    accepted_rounds: decisions.filter((row) => row.status === "challenger_promoted").length,
    stopped_on_rejection: decisions.some((row) => row.status === "incumbent_retained"),
    rounds: decisions.map((row) => ({
      round: row.round,
      status: row.status,
      decision_path: path.join(loopDirectory, `round_${String(row.round).padStart(2, "0")}`, "decision.json"),
      predicted_apv_delta: row.decision?.predicted_apv_delta ?? null,
    })),
    completed_at: new Date().toISOString(),
  };
  await writeJsonAtomic(reportPath, report);
  return { report, reportPath };
}

async function resolveRevisionIncumbent(directory, flags) {
  if (flags.script) {
    const scriptPath = path.resolve(flags.script);
    if (!await exists(scriptPath)) throw new Error(`Revision script is missing: ${scriptPath}`);
    return { path: scriptPath, source: "operator_script" };
  }
  const portfolioPath = path.join(directory, "manufacturing_portfolio.json");
  if (await exists(portfolioPath)) {
    const portfolio = JSON.parse(await fs.readFile(portfolioPath, "utf8"));
    if (sourceWriterPolicy(portfolio).candidates.length === 1) {
      const draft = portfolio.candidates?.[0];
      if (await fileSha256(draft.output_path) !== draft.output_sha256) throw new Error("Single draft hash differs from its portfolio record.");
      return { path: draft.output_path, source: "single_draft" };
    }
  }
  const selectedPath = path.join(directory, "manufacturing_selected_script.txt");
  if (await exists(selectedPath)) return { path: selectedPath, source: "manufacturing_selection" };
  throw new Error("No revision incumbent found. Run write, or pass --script <complete-script.txt>.");
}

async function optionalBrief(directory, flags) {
  if (flags.brief || await exists(path.join(directory, "manufacturing_brief.json"))) return loadBrief(directory, flags);
  return null;
}

function briefBlock(brief) {
  if (!brief) return "TITLE AND PREMISE\nNo brief was supplied for this script. Infer its promise from the narration itself and preserve it.";
  return `TITLE AND PREMISE\n${JSON.stringify({
    title: brief.document.title,
    core_premise: brief.document.core_premise,
    opening_target: brief.document.opening_target,
  }, null, 2)}`;
}

async function receiptFor(responsePath) {
  return {
    path: responsePath,
    sha256: await fileSha256(responsePath),
    receipt_path: `${responsePath}.meta.json`,
    receipt_sha256: await fileSha256(`${responsePath}.meta.json`),
  };
}

function parseModelJson(content, label) {
  try {
    return parseJsonObjectFromPlannerOutput(content).value;
  } catch (error) {
    throw new Error(`${label} returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runRevisionRound({ loopDirectory, roundNumber, incumbent, brief, priorVerdict, roles, maxRounds, flags }) {
  const pad = String(roundNumber).padStart(2, "0");
  const roundDirectory = path.join(loopDirectory, `round_${pad}`);
  await fs.mkdir(roundDirectory, { recursive: true });
  const startedAt = new Date().toISOString();
  const roundIncumbentPath = path.join(roundDirectory, "incumbent.txt");
  if (!await exists(roundIncumbentPath)) await writeExclusive(roundIncumbentPath, incumbent.text);
  else if (await fileSha256(roundIncumbentPath) !== incumbent.sha256) throw new Error(`Revision round ${roundNumber} incumbent hash mismatch.`);
  const priorBlock = priorVerdict
    ? `\n\nPREVIOUS ROUND VERIFY RESULT\nThe previous revision was ${priorVerdict.decision === "keep_revision" ? "kept; the script below is that revision" : "reverted; the script below is unchanged"}. Prioritize these remaining material issues and avoid these regressions.\n${JSON.stringify({
      remaining_material_issues: priorVerdict.remaining_material_issues,
      regressions: priorVerdict.regressions,
    }, null, 2)}`
    : "";

  // (a) diagnose
  const diagnoseInstruction = promptBody(await fs.readFile(REVISION_DIAGNOSE_PROMPT_PATH, "utf8"));
  const diagnosePrompt = `${diagnoseInstruction}\n\n${briefBlock(brief)}${priorBlock}\n\nOPENING WORD WINDOWS (exact narration words, counted by Goldflow)\n${JSON.stringify(openingDeadlineWindows(incumbent.text), null, 2)}\n\nINCUMBENT WORD COUNT\n${incumbent.word_count}\n\nEXACT NARRATION\n${incumbent.text}`;
  const diagnoseResponsePath = path.join(roundDirectory, "diagnose_response.txt");
  const diagnoseResponse = await modelCall({
    outputPath: diagnoseResponsePath,
    prompt: diagnosePrompt,
    provider: roles.diagnose.provider,
    model: roles.diagnose.model,
    effort: roles.diagnose.reasoning_effort,
    stageName: `winner_source_script_revision_diagnose_r${pad}`,
    timeoutMs: Number(flags["diagnose-timeout-ms"] ?? 1_800_000),
  });
  const notes = parseModelJson(diagnoseResponse.content, `Revision round ${roundNumber} diagnose`);
  const notesValidation = validateRevisionNotes(notes, incumbent.text);
  assertValid(`revision round ${roundNumber} notes`, notesValidation);
  const notesPath = path.join(roundDirectory, "notes.json");
  if (!await exists(notesPath)) await writeJsonExclusive(notesPath, notes);
  const base = {
    schema: REVISION_DECISION_SCHEMA,
    round: roundNumber,
    policy: REVISION_POLICY,
    roles,
    incumbent: { path: roundIncumbentPath, sha256: incumbent.sha256, word_count: incumbent.word_count },
    notes: { path: notesPath, sha256: await fileSha256(notesPath), anchors: notesValidation.anchors, material_note_count: notesValidation.material_note_count },
    diagnose_response: await receiptFor(diagnoseResponsePath),
  };
  if (notesValidation.nothing_to_fix) {
    return { ...base, status: "no_issues_found", decision: { kept: false, status: "no_issues_found", reason: "diagnose_reported_every_dimension_ok", remaining_material_issue_count: 0, next_round: false }, revision: null, verdict: null, started_at: startedAt, completed_at: new Date().toISOString() };
  }

  // (b) revise
  const rewriteInstruction = promptBody(await fs.readFile(REVISION_REWRITE_PROMPT_PATH, "utf8"));
  const revisePrompt = `${rewriteInstruction}\n\n${briefBlock(brief)}\n\nEDITOR NOTES\n${JSON.stringify(notes, null, 2)}\n\nINCUMBENT WORD COUNT\n${incumbent.word_count}\n\nEXACT INCUMBENT NARRATION\n${incumbent.text}`;
  const reviseResponsePath = path.join(roundDirectory, "revise_response.txt");
  const reviseResponse = await modelCall({
    outputPath: reviseResponsePath,
    prompt: revisePrompt,
    provider: roles.revise.provider,
    model: roles.revise.model,
    effort: roles.revise.reasoning_effort,
    stageName: `winner_source_script_revision_rewrite_r${pad}`,
    timeoutMs: Number(flags["revise-timeout-ms"] ?? 2_400_000),
  });
  const revisionPath = path.join(roundDirectory, "revision.txt");
  const revisionBytes = `${stripFence(reviseResponse.content)}\n`;
  if (!await exists(revisionPath)) await writeExclusive(revisionPath, revisionBytes);
  else if (await fileSha256(revisionPath) !== sha256Text(revisionBytes)) throw new Error(`Revision round ${roundNumber} revision differs from the recorded response.`);
  const revisionText = await fs.readFile(revisionPath, "utf8");
  const revision = { path: revisionPath, sha256: sha256Text(revisionText), word_count: words(revisionText) };
  const length = assessRevisionLength(incumbent.word_count, revision.word_count);
  const withRevision = { ...base, revision, revise_response: await receiptFor(reviseResponsePath), length };
  if (!length.plausibly_complete) {
    const decision = decideRevisionRound({ length, round: roundNumber, maxRounds });
    return { ...withRevision, status: decision.status, decision, verdict: null, started_at: startedAt, completed_at: new Date().toISOString() };
  }

  // (c) verify
  const verifyInstruction = promptBody(await fs.readFile(REVISION_VERIFY_PROMPT_PATH, "utf8"));
  const verifyPrompt = `${verifyInstruction}\n\n${briefBlock(brief)}\n\nEDITOR NOTES\n${JSON.stringify(notes, null, 2)}\n\nINCUMBENT (${incumbent.word_count} words)\n${incumbent.text}\n\nREVISION (${revision.word_count} words)\n${revisionText}`;
  const verifyResponsePath = path.join(roundDirectory, "verify_response.txt");
  const verifyResponse = await modelCall({
    outputPath: verifyResponsePath,
    prompt: verifyPrompt,
    provider: roles.verify.provider,
    model: roles.verify.model,
    effort: roles.verify.reasoning_effort,
    stageName: `winner_source_script_revision_verify_r${pad}`,
    timeoutMs: Number(flags["verify-timeout-ms"] ?? 1_800_000),
  });
  const verdict = parseModelJson(verifyResponse.content, `Revision round ${roundNumber} verify`);
  assertValid(`revision round ${roundNumber} verdict`, validateRevisionVerdict(verdict, { noteIds: (notes.notes ?? []).map((note) => String(note.id).trim()) }));
  const verdictPath = path.join(roundDirectory, "verdict.json");
  if (!await exists(verdictPath)) await writeJsonExclusive(verdictPath, verdict);
  const decision = decideRevisionRound({ verdict, length, round: roundNumber, maxRounds });
  return {
    ...withRevision,
    status: decision.status,
    decision,
    verdict: { path: verdictPath, sha256: await fileSha256(verdictPath), decision: verdict.decision, reasons: verdict.reasons, remaining_material_issues: verdict.remaining_material_issues, regressions: verdict.regressions },
    verify_response: await receiptFor(verifyResponsePath),
    started_at: startedAt,
    completed_at: new Date().toISOString(),
  };
}

async function callTiming(responsePath) {
  if (!responsePath) return null;
  const metadata = await readCodexCallMetadata(responsePath);
  if (!metadata) return null;
  const started = Date.parse(metadata.studio_timing?.created_at ?? metadata.started_at);
  const completed = Date.parse(metadata.studio_timing?.completed_at ?? metadata.completed_at);
  return {
    stage_name: metadata.stage_name,
    provider: metadata.provider,
    model: metadata.model,
    reasoning_effort: metadata.reasoning_effort,
    started_at: Number.isFinite(started) ? new Date(started).toISOString() : null,
    completed_at: Number.isFinite(completed) ? new Date(completed).toISOString() : null,
    minutes: Number.isFinite(started) && Number.isFinite(completed) ? Number(((completed - started) / 60_000).toFixed(2)) : null,
  };
}

async function reviseScript(directory, flags) {
  const maxRounds = Math.max(1, Math.min(REVISION_MAX_ROUNDS, Number(flags["max-rounds"] ?? REVISION_MAX_ROUNDS) || REVISION_MAX_ROUNDS));
  const loopDirectory = path.join(directory, "revision_loop");
  const v00Path = path.join(loopDirectory, "v00_incumbent.txt");
  await fs.mkdir(loopDirectory, { recursive: true });
  const initial = await resolveRevisionIncumbent(directory, flags);
  const initialBytes = await fs.readFile(initial.path);
  if (!await exists(v00Path)) await writeExclusive(v00Path, initialBytes);
  const v00Sha256 = await fileSha256(v00Path);
  if (v00Sha256 !== sha256Text(initialBytes.toString("utf8"))) throw new Error("Existing revision incumbent differs from the requested script; use a new --development-dir.");
  const brief = await optionalBrief(directory, flags);
  const lock = await loadModelLock(directory, flags);
  const roles = { diagnose: lock.document.roles.diagnose, revise: lock.document.roles.revise, verify: lock.document.roles.verify };

  let current = { path: v00Path, text: initialBytes.toString("utf8"), sha256: v00Sha256, word_count: words(initialBytes.toString("utf8")) };
  let priorVerdict = null;
  const decisions = [];
  for (let roundNumber = 1; roundNumber <= maxRounds; roundNumber += 1) {
    const decisionPath = path.join(loopDirectory, `round_${String(roundNumber).padStart(2, "0")}`, "decision.json");
    let decision;
    if (await exists(decisionPath)) {
      decision = JSON.parse(await fs.readFile(decisionPath, "utf8"));
      if (decision.incumbent?.sha256 !== current.sha256) throw new Error(`Revision round ${roundNumber} decision is bound to a different incumbent.`);
    } else {
      decision = await runRevisionRound({ loopDirectory, roundNumber, incumbent: current, brief, priorVerdict, roles, maxRounds, flags });
      await writeJsonExclusive(decisionPath, decision);
    }
    decisions.push({ ...decision, decision_path: decisionPath });
    if (decision.decision.kept) {
      const text = await fs.readFile(decision.revision.path, "utf8");
      if (sha256Text(text) !== decision.revision.sha256) throw new Error(`Revision round ${roundNumber} kept revision hash mismatch.`);
      current = { path: decision.revision.path, text, sha256: decision.revision.sha256, word_count: words(text) };
    }
    priorVerdict = decision.verdict;
    if (!decision.decision.next_round) break;
  }

  const finalPath = path.join(loopDirectory, "final_script.txt");
  if (!await exists(finalPath)) await writeExclusive(finalPath, current.text);
  else if (await fileSha256(finalPath) !== current.sha256) throw new Error("Existing final_script.txt differs from the loop's retained script.");
  const timing = [];
  for (const row of decisions) {
    for (const call of ["diagnose_response", "revise_response", "verify_response"]) {
      const measured = await callTiming(row[call]?.path);
      if (measured) timing.push({ round: row.round, call: call.replace(/_response$/, ""), ...measured });
    }
  }
  const starts = timing.map((row) => Date.parse(row.started_at)).filter(Number.isFinite);
  const ends = timing.map((row) => Date.parse(row.completed_at)).filter(Number.isFinite);
  const timingReport = {
    schema: "goldflow_manhwa_revision_timing_v1",
    call_count: timing.length,
    measured_minutes: starts.length && ends.length ? Number(((Math.max(...ends) - Math.min(...starts)) / 60_000).toFixed(2)) : null,
    calls: timing,
    generated_at: new Date().toISOString(),
  };
  const timingPath = path.join(loopDirectory, "revision_timing_report.json");
  await writeJsonAtomic(timingPath, timingReport);
  const report = {
    schema: REVISION_LOOP_SCHEMA,
    status: "completed",
    policy: REVISION_POLICY,
    max_rounds: maxRounds,
    roles,
    model_lock_path: lock.path,
    model_lock_sha256: lock.sha256,
    initial_source: initial.source,
    initial_source_path: initial.path,
    brief_sha256: brief?.sha256 ?? null,
    v00_incumbent_path: v00Path,
    v00_incumbent_sha256: v00Sha256,
    retained_script_path: current.path,
    final_script_path: finalPath,
    final_script_sha256: current.sha256,
    final_word_count: current.word_count,
    kept_rounds: decisions.filter((row) => row.decision.kept).length,
    rounds: decisions.map((row) => ({
      round: row.round,
      status: row.status,
      verify_decision: row.verdict?.decision ?? null,
      remaining_material_issue_count: row.decision.remaining_material_issue_count,
      decision_path: row.decision_path,
    })),
    timing_report_path: timingPath,
    model_call_count: timing.length,
    completed_at: new Date().toISOString(),
  };
  const reportPath = path.join(loopDirectory, "revision_loop_report.json");
  await writeJsonAtomic(reportPath, report);
  const handoff = await writeSourceHandoff(directory, { flags, loopDirectory, report, reportPath, brief, lock, current });
  return { report, reportPath, handoff };
}

// The hand-off binds the retained script, its brief, model lock and evidence by hash for
// `run preflight --source-handoff`. It never carries the content profile, media workflow or
// run intent: those stay explicit operator flags. Rewritten only when the retained script
// changed; an existing hand-off for the same script hash is kept byte-for-byte.
async function writeSourceHandoff(directory, { flags, loopDirectory, report, reportPath, brief, lock, current }) {
  const handoffPath = path.join(loopDirectory, "source_handoff.json");
  if (await exists(handoffPath)) {
    const existing = JSON.parse(await fs.readFile(handoffPath, "utf8"));
    if (existing.sha256 === current.sha256 && existing.final_script_path === report.final_script_path) {
      return { path: handoffPath, document: existing, sha256: await fileSha256(handoffPath), created: false };
    }
  }
  const document = buildSourceHandoff({
    title: brief?.document?.title ?? null,
    finalScriptPath: report.final_script_path,
    sha256: current.sha256,
    briefSha256: brief?.sha256 ?? null,
    modelLockSha256: lock.sha256,
    evidenceSha256: brief?.document?.selection_basis?.evidence_sha256 ?? null,
    channel: channelFor(directory, flags),
    developmentDir: directory,
    incumbentSource: report.initial_source,
    wordCount: current.word_count,
    revisionReportPath: reportPath,
    revisionReportSha256: await fileSha256(reportPath),
  });
  assertValid("source hand-off", validateSourceHandoff(document));
  await writeJsonAtomic(handoffPath, document);
  return { path: handoffPath, document, sha256: await fileSha256(handoffPath), created: true };
}

function revisionSummary(result, timing) {
  return {
    status: result.report.status,
    policy: result.report.policy,
    initial_source: result.report.initial_source,
    kept_rounds: result.report.kept_rounds,
    rounds: result.report.rounds,
    final_script_path: result.report.final_script_path,
    final_script_sha256: result.report.final_script_sha256,
    final_word_count: result.report.final_word_count,
    report_path: result.reportPath,
    revision_timing_report_path: result.report.timing_report_path,
    timing_report_path: timing.outputPath,
    source_handoff_path: result.handoff.path,
    source_handoff_sha256: result.handoff.sha256,
    next_action: `goldflow run preflight --content-profile manhwa_recap_v1 --media-workflow generated_visuals_v1 --run-intent production --source-handoff ${JSON.stringify(result.handoff.path)} --channel-preset <channels/${result.handoff.document.channel ?? "<channel>"}/channel_preset.json> --channel <channel> --series <series> --week <run-slug> --episode <ep_NN>${result.handoff.document.title ? "" : " --title <title>"}`,
  };
}

// New runs and existing single-draft runs use the one-draft flow; a recorded or explicitly
// requested multi-draft portfolio keeps its historical select/improve behavior.
async function singleDraftRun(directory, flags) {
  const portfolioPath = path.join(directory, "manufacturing_portfolio.json");
  const portfolio = await exists(portfolioPath) ? JSON.parse(await fs.readFile(portfolioPath, "utf8")) : null;
  const briefPath = path.join(directory, "manufacturing_brief.json");
  const briefPolicy = await exists(briefPath) ? JSON.parse(await fs.readFile(briefPath, "utf8")).writer_policy ?? null : null;
  return sourceWriterPolicy(portfolio, portfolio ? null : flags["writer-policy"] ?? briefPolicy).candidates.length === 1;
}

async function runSingleDraftFlow(directory, flags) {
  const briefPath = path.join(directory, "manufacturing_brief.json");
  let titleSelection = null;
  if (!await exists(briefPath) && !flags.brief) {
    if (!flags.evidence) throw new Error("source manufacture run needs --evidence <file> for ideation, or --brief <json>.");
    titleSelection = await ideateTopics(directory, flags);
  }
  const written = await writeCandidates(directory, flags);
  const revised = await reviseScript(directory, { ...flags, script: undefined });
  const timing = await writeManufacturingTimingReport(directory);
  return {
    ...revisionSummary(revised, timing),
    title: written.prepared.brief.document.title,
    brief_status: written.prepared.brief.document.status,
    auto_selected_title: Boolean(titleSelection?.brief?.created),
    draft_path: written.document.candidates[0].output_path,
  };
}

async function main() {
  const action = process.argv[2] ?? "help";
  const flags = flagsFrom(process.argv.slice(3));
  const directory = developmentDirectory(flags, action);
  if (flags.transport != null && flags.transport !== "chatgpt_web") throw new Error("--transport accepts only chatgpt_web (the opt-in browser writer path).");
  if (flags["writer-fallback"] != null && flags.transport !== "chatgpt_web") throw new Error("--writer-fallback applies only with --transport chatgpt_web.");
  allowChatGptWebTransport(flags.transport === "chatgpt_web");
  if (action === "ideate") {
    const result = await ideateTopics(directory, flags);
    const timing = await writeManufacturingTimingReport(directory);
    console.log(JSON.stringify({ status: "title_selected", topic_pool_path: result.poolPath, shortlist_path: result.shortlistPath, brief_path: result.brief.path, brief_status: result.brief.document.status, title: result.brief.document.title, brief_created: result.brief.created, timing_report_path: timing.outputPath, next_action: "prepare" }, null, 2));
    return;
  }
  if (action === "revise") {
    const result = await reviseScript(directory, flags);
    const timing = await writeManufacturingTimingReport(directory);
    console.log(JSON.stringify(revisionSummary(result, timing), null, 2));
    return;
  }
  if (action === "learn") {
    const result = await approveLearning(directory, flags);
    console.log(JSON.stringify({ status: "approved", template_path: result.templatePath, approval_path: result.approvalPath, active_template_manifest_path: result.currentPath, template_version: result.version, next_action: "prepare" }, null, 2));
    return;
  }
  if (action === "prepare") {
    const result = await prepare(directory, flags);
    console.log(JSON.stringify({ status: "prepared", writer_prompt_path: result.finalPath, manifest_path: result.manifestPath, next_action: "write" }, null, 2));
    return;
  }
  if (action === "write") {
    const result = await writeCandidates(directory, flags);
    const timing = await writeManufacturingTimingReport(directory);
    console.log(JSON.stringify({ status: "completed", portfolio_path: result.portfolioPath, draft_paths: result.document.candidates.map((row) => row.output_path), timing_report_path: timing.outputPath, next_action: result.document.candidates.length === 1 ? "revise" : "select" }, null, 2));
    return;
  }
  if (action === "audition") {
    const result = await auditionCandidates(directory, flags);
    console.log(JSON.stringify({
      status: "generated",
      blind_review_packet_path: result.packetPath,
      audio: result.audio,
      next_action: "operator ranks the selected blind audio labels",
    }, null, 2));
    return;
  }
  if (action === "promote") {
    const result = await promoteCandidate(directory, flags);
    console.log(JSON.stringify({
      status: "operator_promoted",
      promoted_candidate_id: result.receipt.promoted_candidate_id,
      promoted_blind_id: result.receipt.promoted_blind_id,
      selected_script_path: result.selectedScriptPath,
      promotion_receipt_path: result.receiptPath,
      next_action: "operator review, then source ingest",
    }, null, 2));
    return;
  }
  if (action === "improve") {
    const result = await improveCandidate(directory, flags);
    console.log(JSON.stringify({
      status: result.report.status,
      policy: result.report.policy,
      accepted_rounds: result.report.accepted_rounds,
      stopped_on_rejection: result.report.stopped_on_rejection,
      final_script_path: result.report.final_script_path,
      final_script_sha256: result.report.final_script_sha256,
      final_word_count: result.report.final_word_count,
      report_path: result.reportPath,
      next_action: "operator reviews the exact retained winner before production ingest",
    }, null, 2));
    return;
  }
  if (action === "compare-prompts") {
    const result = await comparePromptVersions(directory, flags);
    console.log(JSON.stringify({
      status: "completed",
      selected_candidate: result.report.selected_candidate,
      prompt_version_summary: result.report.prompt_version_summary,
      report_path: result.reportPath,
      blind_selection_path: result.selectionPath,
      decode_manifest_path: result.decodeManifestPath,
      next_action: "operator reviews the blind comparison before promotion",
    }, null, 2));
    return;
  }
  if (action === "run" && await singleDraftRun(directory, flags)) {
    const result = await runSingleDraftFlow(directory, flags);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (["select", "run"].includes(action)) {
    const result = await selectCandidate(directory, flags);
    const timing = await writeManufacturingTimingReport(directory);
    if (action === "run" && sourceWriterPolicy(result.portfolio.document).name === "three_56_pro_v1") {
      const improved = await improveCandidate(directory, { ...flags, script: result.selectedScriptPath });
      console.log(JSON.stringify({ status: improved.report.status,
        selected_script_path: result.selectedScriptPath,
        final_script_path: improved.report.final_script_path,
        final_script_sha256: improved.report.final_script_sha256,
        improvement_report_path: improved.reportPath,
        timing_report_path: timing.outputPath,
        next_action: "operator reviews the exact retained winner before production ingest" }, null, 2));
      return;
    }
    console.log(JSON.stringify({
      status: "selected",
      selected_blind_id: result.document.selected_blind_id,
      predicted_apv: result.document.rankings.find((row) => row.blind_id === result.document.selected_blind_id)?.predicted_average_percentage_viewed,
      selection_path: result.selectionPath,
      selected_script_path: result.selectedScriptPath,
      timing_report_path: timing.outputPath,
      next_action: sourceWriterPolicy(result.portfolio.document).name === "three_56_pro_v1"
        ? "bounded source manufacture improve, then operator exact-script review"
        : "operator review, then source ingest",
    }, null, 2));
    return;
  }
  console.log(`Usage: goldflow source manufacture <run|ideate|prepare|write|revise|select|compare-prompts|improve|audition|promote|learn> --development-slug <slug> [--evidence <txt>] [--brief <json>] [--target-word-count 10000] [--writer-model gpt-6.1-sol|gpt-6-sol|claude-fable-5-1|claude-opus-5-5|gpt-6-astra] [--transport chatgpt_web --writer-model gpt-6-astra [--writer-fallback claude-fable-5-1]] [--revision-model <model>] [--planning-model <model>] [--max-rounds 2] [--diagnose-effort high] [--revise-effort high] [--verify-effort medium]
       goldflow source manufacture revise --script <brought-script.txt> [--development-dir <dir>] [--brief <json>]
       Legacy multi-draft and browser paths need --transport chatgpt_web. Legacy flags: [--writer-prompt <operator-approved.txt>] [--script <incumbent.txt>] [--max-rounds 1] [--minimum-apv-delta 0.5] [--writer-concurrency 3] [--writer-stagger-ms 15000] [--legacy-manifest <recovered-drafts-manifest.json>] [--audition-candidate-count 3] [--candidate-id draft_56_2 --approved-by <name> --reason <text>] [--template <complete-template.txt>]`);
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export { autoSelectTitle, developmentDirectory, ideateTopics, prepare, reviseScript, runSingleDraftFlow, selectCandidate, writeCandidates, writeManufacturingTimingReport };
