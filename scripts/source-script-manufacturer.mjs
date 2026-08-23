#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { runCodexCli, readCodexCallMetadata } from "./lib/codex-cli-runner.mjs";
import { parseJsonObjectFromPlannerOutput } from "./lib/json-output-repair.mjs";
import { DEFAULT_NARRATOR_VOICE_ID, qwenPrimaryLockForVoice } from "./lib/narration-tts-policy.mjs";
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
  sha256Text,
} from "./lib/source-manufacturer-contract.mjs";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DATA_ROOT = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const BASE_TEMPLATE_PATH = path.join(REPO_ROOT, "docs/prompts/manhwa_recap_manufacturing_template_v1.txt");
const FILLER_PROMPT_PATH = path.join(REPO_ROOT, "docs/prompts/manhwa_recap_manufacturing_prompt_filler_v1.md");
const SELECTOR_PROMPT_PATH = path.join(REPO_ROOT, "docs/prompts/manhwa_recap_manufacturing_selector_v1.md");
const TOPIC_PROMPT_PATH = path.join(REPO_ROOT, "docs/prompts/manhwa_recap_topic_manufacturer_v1.md");
const TOPIC_SHORTLIST_PROMPT_PATH = path.join(REPO_ROOT, "docs/prompts/manhwa_recap_topic_shortlist_v1.md");
const SOURCE_EVIDENCE_SNAPSHOT_PATH = path.join(REPO_ROOT, "docs/channel_formulas/53rebirth_source_evidence_snapshot_v1.json");
const DEFAULT_QWEN_PYTHON = "/Users/joel/AniFactoryData/voice_bank/bakeoff/.venv-kokoro-mlx-audio-0.4.6/bin/python";

const CANDIDATES = Object.freeze([
  { id: "draft_56_1", blind_id: "candidate_a", provider: "chatgpt_web", model: "gpt-5.6-sol" },
  { id: "draft_55_1", blind_id: "candidate_b", provider: "chatgpt_web", model: "gpt-5.5" },
  { id: "draft_56_2", blind_id: "candidate_c", provider: "chatgpt_web", model: "gpt-5.6-sol" },
  { id: "draft_55_2", blind_id: "candidate_d", provider: "chatgpt_web", model: "gpt-5.5" },
  { id: "draft_56_3", blind_id: "candidate_e", provider: "chatgpt_web", model: "gpt-5.6-sol" },
  { id: "draft_55_3", blind_id: "candidate_f", provider: "chatgpt_web", model: "gpt-5.5" },
]);

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

function developmentDirectory(flags) {
  if (flags["development-dir"]) return path.resolve(flags["development-dir"]);
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
    if (!flags.brief) throw new Error("Missing manufacturing_brief.json; pass --brief <approved-json>.");
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
  const topicInstruction = promptBody(await fs.readFile(TOPIC_PROMPT_PATH, "utf8"));
  const topicPrompt = `${topicInstruction}\n\nMEASURED OWN-CHANNEL AND EXTERNAL OUTLIER EVIDENCE\n${evidence}`;
  const rawPoolPath = path.join(directory, ".model_responses", "manufacturing_topic_pool.txt");
  const poolResponse = await modelCall({
    outputPath: rawPoolPath,
    prompt: topicPrompt,
    provider: "chatgpt_web",
    model: "gpt-5.6-sol",
    effort: "medium",
    stageName: "winner_source_premise_manufacturing_pool",
    timeoutMs: Number(flags["ideation-timeout-ms"] ?? 1_800_000),
  });
  const candidates = parseManufacturingTopicTitles(stripFence(poolResponse.content));
  const pool = {
    schema: MANUFACTURING_TOPIC_POOL_SCHEMA,
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
  const poolPath = path.join(directory, "manufacturing_topic_pool.json");
  if (!await exists(poolPath)) await writeJsonExclusive(poolPath, pool);

  const shortlistInstruction = promptBody(await fs.readFile(TOPIC_SHORTLIST_PROMPT_PATH, "utf8"));
  const shortlistPrompt = `${shortlistInstruction}\n\nMEASURED OWN-CHANNEL AND EXTERNAL OUTLIER EVIDENCE\n${evidence}\n\nBLIND ORIGINAL CANDIDATE TITLES\n${candidates.map((row) => `${row.number}. ${row.title}`).join("\n")}`;
  const rawShortlistPath = path.join(directory, ".model_responses", "manufacturing_topic_shortlist.txt");
  const shortlistResponse = await modelCall({
    outputPath: rawShortlistPath,
    prompt: shortlistPrompt,
    provider: "chatgpt_web",
    model: "gpt-5.6-sol",
    effort: "medium",
    stageName: "winner_source_premise_manufacturing_shortlist",
    timeoutMs: Number(flags["shortlist-timeout-ms"] ?? 1_800_000),
  });
  const shortlist = parseJsonObjectFromPlannerOutput(shortlistResponse.content).value;
  assertValid("manufacturing topic shortlist", validateManufacturingTopicShortlist(shortlist, { topicPool: pool }));
  const shortlistPath = path.join(directory, "manufacturing_topic_shortlist.json");
  if (!await exists(shortlistPath)) await writeJsonExclusive(shortlistPath, shortlist);
  return { poolPath, shortlistPath, shortlist };
}

async function reusableResponse({ outputPath, prompt, provider, model, effort, stageName }) {
  if (!await exists(outputPath)) return null;
  const metadata = await readCodexCallMetadata(outputPath);
  const blockers = [];
  if (!metadata) blockers.push("receipt_missing");
  if (metadata?.status !== "passed") blockers.push("receipt_not_passed");
  if (metadata?.prompt_sha256 !== sha256Text(prompt)) blockers.push("prompt_hash_mismatch");
  if (metadata?.provider !== provider) blockers.push("provider_mismatch");
  if (metadata?.model !== model) blockers.push("model_mismatch");
  if (metadata?.reasoning_effort !== effort) blockers.push("effort_mismatch");
  if (metadata?.stage_name !== stageName) blockers.push("stage_mismatch");
  if (blockers.length) throw new Error(`Cannot reuse ${outputPath}: ${blockers.join(", ")}`);
  return { content: await fs.readFile(outputPath, "utf8"), ...metadata, resumed: true };
}

async function modelCall({ outputPath, prompt, provider, model, effort, stageName, timeoutMs }) {
  const resumed = await reusableResponse({ outputPath, prompt, provider, model, effort, stageName });
  if (resumed) return resumed;
  return runCodexCli({
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
  const template = await activeManufacturingTemplate(directory, flags);
  const outputPath = path.join(directory, ".model_responses", "manufacturing_prompt.txt");
  const finalPath = path.join(directory, "manufacturing_writer_prompt.txt");
  const manifestPath = path.join(directory, "manufacturing_prompt_manifest.json");
  const filler = promptBody(await fs.readFile(FILLER_PROMPT_PATH, "utf8"));
  const prompt = `${filler}\n\nAPPROVED PREMISE BRIEF\n${JSON.stringify(brief.document, null, 2)}\n\nOPERATOR TEMPLATE\n${template.content}`;
  const response = await modelCall({
    outputPath,
    prompt,
    provider: "chatgpt_web",
    model: "gpt-5.6-sol",
    effort: "medium",
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
    filler_provider: "chatgpt_web",
    filler_model: "gpt-5.6-sol",
    filler_reasoning_effort: "medium",
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

async function writeCandidates(directory, flags) {
  const prepared = await prepare(directory, flags);
  const portfolioPath = path.join(directory, "manufacturing_portfolio.json");
  if (await exists(portfolioPath)) {
    const document = JSON.parse(await fs.readFile(portfolioPath, "utf8"));
    assertValid("manufacturing portfolio", validateManufacturingPortfolio(document, { promptSha256: prepared.manifest.filled_prompt_sha256, expectedCandidates: CANDIDATES }));
    return { prepared, document, portfolioPath };
  }
  const outputDirectory = path.join(directory, "manufactured_drafts");
  await fs.mkdir(outputDirectory, { recursive: true });
  const repairIds = csvSet(flags["candidate-ids"]);
  const unknownRepairIds = [...repairIds].filter((id) => !CANDIDATES.some((candidate) => candidate.id === id));
  if (unknownRepairIds.length) throw new Error(`Unknown candidate repair IDs: ${unknownRepairIds.join(", ")}`);
  const writerConcurrency = Math.max(1, Math.min(3, Number(flags["writer-concurrency"] ?? 3) || 3));
  const writerStaggerMs = Math.max(0, Math.min(60_000, Number(flags["writer-stagger-ms"] ?? 15_000) || 0));
  const settled = await allSettledWithConcurrency(CANDIDATES, writerConcurrency, async (spec, index) => {
    await sleep((index % writerConcurrency) * writerStaggerMs);
    const outputPath = path.join(outputDirectory, `${spec.id}.txt`);
    const stageName = `winner_source_script_v3_${spec.id}`;
    const candidatePrompt = `${prepared.filled}\n\nIndependent candidate run ${spec.id}. Write the best complete script you can from this prompt in a fresh context. Do not compare with or anticipate another candidate. Output only raw narration.`;
    const receiptPath = `${outputPath}.meta.json`;
    const existingReceipt = await readCodexCallMetadata(outputPath);
    if (existingReceipt && existingReceipt.status !== "passed" && repairIds.has(spec.id)) {
      const archiveDirectory = path.join(outputDirectory, "failed_receipts");
      await fs.mkdir(archiveDirectory, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      await fs.rename(receiptPath, path.join(archiveDirectory, `${spec.id}.${timestamp}.meta.json`));
    }
    await modelCall({
      outputPath,
      prompt: candidatePrompt,
      provider: spec.provider,
      model: spec.model,
      effort: "max",
      stageName,
      timeoutMs: Number(flags["draft-timeout-ms"] ?? 5_400_000),
    });
    const content = await fs.readFile(outputPath, "utf8");
    return {
      ...spec,
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
      candidate_id: CANDIDATES[index].id,
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
      exact_recovery_command: `goldflow source manufacture write --development-dir ${JSON.stringify(directory)} --candidate-ids ${failures.map((row) => row.candidate_id).join(",")}`,
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
    writer_concurrency: writerConcurrency,
    writer_stagger_ms: writerStaggerMs,
    candidates: completed,
    completed_at: new Date().toISOString(),
  };
  assertValid("manufacturing portfolio", validateManufacturingPortfolio(document, { promptSha256: prepared.manifest.filled_prompt_sha256, expectedCandidates: CANDIDATES }));
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
  const stages = {
    premise_ideation: await manufacturingTimingStage([
      path.join(responseDirectory, "manufacturing_topic_pool.txt.meta.json"),
      path.join(responseDirectory, "manufacturing_topic_shortlist.txt.meta.json"),
    ], 30),
    prompt_preparation: await manufacturingTimingStage([
      path.join(responseDirectory, "manufacturing_prompt.txt.meta.json"),
    ], 10),
    six_candidate_writing: await manufacturingTimingStage(CANDIDATES.map(
      (row) => path.join(draftDirectory, `${row.id}.txt.meta.json`),
    ), 120),
    selection: await manufacturingTimingStage([
      path.join(responseDirectory, "manufacturing_selection.txt.meta.json"),
    ], 20),
  };
  const measured = Object.values(stages).filter((row) => row.status !== "not_measured");
  const starts = measured.map((row) => Date.parse(row.started_at)).filter(Number.isFinite);
  const ends = measured.map((row) => Date.parse(row.completed_at)).filter(Number.isFinite);
  const totalMinutes = starts.length && ends.length
    ? (Math.max(...ends) - Math.min(...starts)) / 60_000
    : null;
  const report = {
    schema: "goldflow_manhwa_manufacturing_timing_v1",
    status: measured.some((row) => row.status === "over_target") ? "target_missed" : "on_target_or_incomplete",
    target_total_minutes: 180,
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
    model: "gpt-5.6-sol",
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
  let prompt = `${selector}\n\nBLIND PROMPT-STRATEGY EXPERIMENT\nThe scripts below were produced by more than one undisclosed instruction strategy. Do not guess, discuss, or reward a strategy, model, provider, manuscript length, or candidate family. Judge only the exact narration each viewer would hear. Apply the same standard independently to every candidate.\n\nAPPROVED TITLE, PREMISE, AND OPENING TARGET\n${JSON.stringify({
    title: portfolio.prepared.brief.document.title,
    core_premise: portfolio.prepared.brief.document.core_premise,
    opening_target: portfolio.prepared.brief.document.opening_target,
    reference_outlier: portfolio.prepared.brief.document.reference_outlier,
    reference_opening_benchmark: portfolio.prepared.brief.document.reference_opening_benchmark ?? null,
  }, null, 2)}\n\nOWN-CHANNEL APV CALIBRATION\n${JSON.stringify(calibration, null, 2)}\n\nBLIND MANIFEST\n${JSON.stringify(candidates.map((row) => ({ blind_id: row.blind_id, sha256: row.output_sha256 })), null, 2)}`;
  for (const row of candidates) prompt += `\n\nBLIND CANDIDATE ${row.blind_id}\n${await fs.readFile(row.output_path, "utf8")}`;

  const rawPath = path.join(directory, ".model_responses", "manufacturing_prompt_ab_selection.txt");
  const selectionPath = path.join(directory, "manufacturing_prompt_ab_selection.json");
  let selection;
  let shouldWriteSelection = false;
  if (await exists(selectionPath)) {
    selection = JSON.parse(await fs.readFile(selectionPath, "utf8"));
  } else {
    const response = await modelCall({
      outputPath: rawPath,
      prompt,
      provider: "chatgpt_web",
      model: "gpt-5.6-sol",
      effort: "medium",
      stageName: "winner_source_prompt_strategy_ab_selection",
      timeoutMs: Number(flags["selector-timeout-ms"] ?? 3_600_000),
    });
    try {
      selection = parseJsonObjectFromPlannerOutput(response.content).value;
    } catch (error) {
      throw new Error(`Prompt comparison selector returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
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

async function main() {
  const action = process.argv[2] ?? "help";
  const flags = flagsFrom(process.argv.slice(3));
  const directory = developmentDirectory(flags);
  if (action === "ideate") {
    const result = await ideateTopics(directory, flags);
    const timing = await writeManufacturingTimingReport(directory);
    console.log(JSON.stringify({ status: "shortlisted", topic_pool_path: result.poolPath, shortlist_path: result.shortlistPath, timing_report_path: timing.outputPath, top_recommendation: result.shortlist.rankings[0], next_action: "operator approves one premise and supplies manufacturing_brief.json" }, null, 2));
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
    console.log(JSON.stringify({ status: "completed", portfolio_path: result.portfolioPath, draft_paths: result.document.candidates.map((row) => row.output_path), timing_report_path: timing.outputPath, next_action: "select" }, null, 2));
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
  if (["select", "run"].includes(action)) {
    const result = await selectCandidate(directory, flags);
    const timing = await writeManufacturingTimingReport(directory);
    console.log(JSON.stringify({
      status: "selected",
      selected_blind_id: result.document.selected_blind_id,
      predicted_apv: result.document.rankings.find((row) => row.blind_id === result.document.selected_blind_id)?.predicted_average_percentage_viewed,
      selection_path: result.selectionPath,
      selected_script_path: result.selectedScriptPath,
      timing_report_path: timing.outputPath,
      next_action: "operator review, then source ingest",
    }, null, 2));
    return;
  }
  console.log(`Usage: goldflow source manufacture <ideate|prepare|write|select|compare-prompts|audition|promote|run|learn> --development-slug <slug> [--evidence <txt>] [--brief <json>] [--writer-concurrency 3] [--writer-stagger-ms 15000] [--legacy-manifest <recovered-drafts-manifest.json>] [--audition-candidate-count 3] [--candidate-id draft_56_2 --approved-by <name> --reason <text>] [--template <complete-template.txt>]`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
