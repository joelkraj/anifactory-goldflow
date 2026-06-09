#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getLLMBaseURL, getLLMModel, isLocalLLMRoute, localLLMAuthHeaders, localLLMChatCompletionURL } from "./lib/llm-router.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const weekDir = path.join(dataRoot, "channels", channel, "weekly_runs", week);
const episodeDir = path.join(weekDir, "episodes", episode);
const scriptPath = path.join(episodeDir, "script_clean.md");
const outputPath = flags.output ?? path.join(episodeDir, "semantic_scene_plan.json");

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

async function readText(filePath, fallback = "") {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return fallback;
  }
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

function extractJson(text) {
  const raw = String(text ?? "").trim();
  try {
    return JSON.parse(raw);
  } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1]);
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
  throw new Error(`LLM output did not contain JSON: ${raw.slice(0, 600)}`);
}

function approvedForHash(artifact, hash) {
  if (!artifact) return false;
  const status = String(artifact.status ?? artifact.approval_status ?? "").toLowerCase();
  return (artifact.approved === true || artifact.operator_approved === true || status.includes("approved") || status === "script_locked")
    && [artifact.script_clean_hash, artifact.source_script_hash].filter(Boolean).includes(hash);
}

async function requireApproval(scriptHash) {
  if (flags["allow-unlocked-script"] === "true") return { diagnostic: true };
  const manual = await readJson(path.join(episodeDir, "manual_agent_script_review.json"), null);
  const operator = await readJson(path.join(episodeDir, "operator_script_approval.json"), null);
  const lock = await readJson(path.join(episodeDir, "script_lock.json"), null);
  if (approvedForHash(manual, scriptHash) && approvedForHash(operator, scriptHash) && approvedForHash(lock, scriptHash)) {
    return { diagnostic: false };
  }
  throw new Error(`Refusing semantic scene plan: script hash ${scriptHash} is not approved/locked. Run script approve for the exact hash.`);
}

async function biblePacket() {
  const files = ["series_package.json", "series_bible.json", "character_bible.json", "location_bible.json", "visual_style_bible.json"];
  const packet = {};
  for (const file of files) {
    packet[file] = await readJson(path.join(weekDir, file), await readJson(path.join(dataRoot, "channels", channel, "series", series, file), null));
  }
  return packet;
}

function wordCount(text) {
  return String(text ?? "").trim().split(/\s+/).filter(Boolean).length;
}

function sceneCountTargets(script) {
  const words = wordCount(script);
  const target = Math.min(70, Math.max(12, Math.round(words / 200)));
  const minimum = Math.min(target, Math.max(8, Math.floor(words / 320)));
  const maximum = Math.max(target + 12, Math.ceil(words / 120));
  return { words, target, minimum, maximum };
}

function chunkSceneCountTargets(script) {
  const words = wordCount(script);
  const target = Math.max(2, Math.round(words / 200));
  const minimum = Math.max(1, Math.floor(words / 360));
  const maximum = Math.max(target + 3, Math.ceil(words / 110));
  return { words, target, minimum, maximum };
}

function scriptChunks(script, targetWords = Number(flags["semantic-chunk-words"] ?? 1000)) {
  const paragraphs = String(script ?? "").split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks = [];
  let current = [];
  let currentWords = 0;
  for (const paragraph of paragraphs) {
    const count = wordCount(paragraph);
    if (current.length && currentWords + count > targetWords) {
      chunks.push(current.join("\n\n"));
      current = [];
      currentWords = 0;
    }
    current.push(paragraph);
    currentWords += count;
  }
  if (current.length) chunks.push(current.join("\n\n"));
  return chunks.map((text, index) => ({ chunk_index: index + 1, chunk_count: chunks.length, text, words: wordCount(text) }));
}

function normalizeScenes(scenes) {
  return scenes.map((scene, index) => ({
    ...scene,
    scene_id: `scene_${String(index + 1).padStart(3, "0")}`,
  }));
}

function buildPrompt(script, bibles, targets, chunk = null) {
  const scopeLine = chunk
    ? `This is chunk ${chunk.chunk_index} of ${chunk.chunk_count} from the locked script. Extract semantic scenes only for this chunk, preserving local order.`
    : "Extract a semantic scene plan from the locked narration script.";
  const bibleLimit = chunk ? Number(flags["semantic-chunk-bible-chars"] ?? 8000) : 30_000;
  return `Extract a semantic scene plan from the locked narration script.
${scopeLine}

Rules:
- Use only the locked script and bibles below.
- Do not use source-seed annotations or stale scene artifacts.
- Do not rewrite the script.
- Scene boundaries should support visual planning, SFX planning, and continuity.
- No timestamps. This is semantic only.
- This script is ${targets.words} words. Return about ${targets.target} scenes.
- Hard scene-count range: minimum ${targets.minimum}, maximum ${targets.maximum}.
- Do not collapse acts, montages, flashbacks, locations, or major emotional beats into broad summaries.
- Prefer visual-production units of roughly 120-260 spoken words each; shorter is fine for fast action, reveals, UI inserts, or emotional turns.
- Include production facts needed by visual prompts: location, visible_subjects, primary_subject, visual_intent, ui_text_on_screen, sfx_cues, character_states, wardrobe, props, ref_requirements, action_staging.
- script_excerpt_start and script_excerpt_end must be exact words copied from this script text so Whisper timing can bind them later.

BIBLES:
${JSON.stringify(bibles, null, 2).slice(0, bibleLimit)}

SCRIPT:
${script}

Return one valid JSON object:
{
  "episode_summary": "...",
  "global_reference_requirements": [
    {"ref_id":"style_ref","kind":"style","description":"...","required":true}
  ],
  "scenes": [
    {
      "scene_id": "scene_001",
      "title": "...",
      "script_excerpt_start": "exact words from the first sentence of this scene",
      "script_excerpt_end": "exact words from the final sentence of this scene",
      "location": "...",
      "time": "...",
      "visible_subjects": ["..."],
      "primary_subject": "...",
      "visual_intent": "...",
      "ui_text_on_screen": ["..."],
      "sfx_cues": ["..."],
      "character_states": [{"character":"...","state":"...","wardrobe":"..."}],
      "props": ["..."],
      "ref_requirements": [{"ref_id":"...","kind":"character|location|prop|ui|style","required":true,"reason":"..."}],
      "action_staging": "...",
      "continuity_notes": ["..."]
    }
  ],
  "warnings": []
}`;
}

async function callLocal(prompt, stageName, maxTokens = null) {
  const attempts = Number(flags["semantic-json-attempts"] ?? 3);
  let lastError = null;
  let lastContent = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const retryPrompt = attempt === 1
      ? prompt
      : `${prompt}\n\nYour previous response was invalid JSON. Return one complete JSON object only. Escape all quotation marks inside string values. Do not include markdown fences, commentary, trailing commas, or partial objects.`;
    const response = await fetch(localLLMChatCompletionURL(stageName), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...localLLMAuthHeaders() },
      body: JSON.stringify({
        model: getLLMModel(stageName),
        messages: [
          { role: "system", content: "Return only valid JSON. You are a production semantic planner for longform anime/manhwa recap videos." },
          { role: "user", content: retryPrompt },
        ],
        temperature: attempt === 1 ? Number(flags["llm-temperature"] ?? 0.15) : 0,
        max_tokens: Number(maxTokens ?? flags["llm-max-tokens"] ?? 18000),
      }),
      signal: AbortSignal.timeout(Number(process.env.ANIFACTORY_SEMANTIC_PLAN_TIMEOUT_MS ?? 1_200_000)),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`local-qwen semantic plan HTTP ${response.status}: ${raw.slice(0, 1000)}`);
    const content = JSON.parse(raw)?.choices?.[0]?.message?.content ?? raw;
    lastContent = content;
    try {
      return { provider: "local-qwen", model: getLLMModel(stageName), content, parsed: extractJson(content), json_attempt: attempt };
    } catch (error) {
      lastError = error;
      console.error(`semantic ${stageName}: invalid JSON attempt ${attempt}/${attempts}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`local-qwen semantic plan returned invalid JSON after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}; content preview: ${lastContent.slice(0, 600)}`);
}

async function callCodex(prompt, stageName) {
  const callDir = path.join(weekDir, "_codex_calls");
  await fs.mkdir(callDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = path.join(callDir, `${stamp}-${stageName}-output.txt`);
  await new Promise((resolve, reject) => {
    const child = spawn("codex", ["exec", "--ephemeral", "--skip-git-repo-check", "-C", repoRoot, "-o", outputPath], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`codex semantic plan exited ${code}: ${stderr}`)));
    child.stdin.end(prompt);
  });
  const content = await fs.readFile(outputPath, "utf8");
  return { provider: "codex", model: "codex_cli_default", output_path: outputPath, content, parsed: extractJson(content) };
}

async function main() {
  const script = await readText(scriptPath);
  if (!script.trim()) throw new Error(`Missing script_clean.md at ${scriptPath}`);
  const scriptHash = sha256(script);
  await requireApproval(scriptHash);
  const bibles = await biblePacket();
  const targets = sceneCountTargets(script);
  const stageName = `${episode}_semantic_scene_plan`;
  let llm;
  let scenes = [];
  let semanticParsed = {};
  const useChunking = isLocalLLMRoute(stageName) && flags["semantic-chunking"] !== "false" && targets.words > Number(flags["semantic-single-call-max-words"] ?? 2500);
  if (useChunking) {
    const chunks = scriptChunks(script);
    const parsedChunks = [];
    for (const chunk of chunks) {
      const chunkTargets = chunkSceneCountTargets(chunk.text);
      const chunkPrompt = buildPrompt(chunk.text, bibles, chunkTargets, chunk);
      console.error(`semantic chunk ${chunk.chunk_index}/${chunk.chunk_count}: ${chunk.words} words, target ${chunkTargets.target} scenes`);
      const chunkLlm = await callLocal(chunkPrompt, `${stageName}_chunk_${String(chunk.chunk_index).padStart(2, "0")}`, Number(flags["semantic-chunk-max-tokens"] ?? 4500));
      const chunkScenes = Array.isArray(chunkLlm.parsed.scenes) ? chunkLlm.parsed.scenes : [];
      if (chunkScenes.length < chunkTargets.minimum) {
        throw new Error(`Semantic chunk ${chunk.chunk_index}/${chunk.chunk_count} under-segmented: returned ${chunkScenes.length} scenes, minimum is ${chunkTargets.minimum} for ${chunkTargets.words} words.`);
      }
      console.error(`semantic chunk ${chunk.chunk_index}/${chunk.chunk_count}: accepted ${chunkScenes.length} scenes`);
      parsedChunks.push({ chunk, targets: chunkTargets, llm: chunkLlm, scenes: chunkScenes });
      scenes.push(...chunkScenes.map((scene) => ({ ...scene, source_chunk_index: chunk.chunk_index })));
    }
    semanticParsed = {
      episode_summary: parsedChunks.map((item) => item.llm.parsed.episode_summary).filter(Boolean).join(" "),
      global_reference_requirements: parsedChunks.flatMap((item) => item.llm.parsed.global_reference_requirements ?? []),
      warnings: parsedChunks.flatMap((item) => item.llm.parsed.warnings ?? []),
    };
    llm = {
      provider: "local-qwen",
      model: getLLMModel(stageName),
      chunked: true,
      chunk_count: chunks.length,
    };
  } else {
    const prompt = buildPrompt(script, bibles, targets);
    llm = isLocalLLMRoute(stageName) ? await callLocal(prompt, stageName) : await callCodex(prompt, stageName);
    semanticParsed = llm.parsed;
    scenes = Array.isArray(llm.parsed.scenes) ? llm.parsed.scenes : [];
  }
  if (!scenes.length) throw new Error("Semantic scene planner returned no scenes.");
  if (scenes.length < targets.minimum) {
    throw new Error(`Semantic scene planner under-segmented locked script: returned ${scenes.length} scenes, minimum is ${targets.minimum} for ${targets.words} words.`);
  }
  if (scenes.length > targets.maximum) {
    throw new Error(`Semantic scene planner over-segmented locked script: returned ${scenes.length} scenes, maximum is ${targets.maximum} for ${targets.words} words.`);
  }
  const report = {
    schema: "goldflow_semantic_scene_plan_v1",
    status: "passed",
    channel,
    series_slug: series,
    week,
    episode,
    source_script_hash: scriptHash,
    source_script_path: scriptPath,
    timing_dependency: "none_semantic_only",
    scene_count_policy: targets,
    planner: { provider: llm.provider, model: llm.model ?? null, output_path: llm.output_path ?? null, chunked: llm.chunked ?? false, chunk_count: llm.chunk_count ?? null },
    ...semanticParsed,
    scenes: normalizeScenes(scenes),
    updated_at: new Date().toISOString(),
  };
  await writeJson(outputPath, report);
  console.log(JSON.stringify({ status: "passed", output_path: outputPath, scene_count: scenes.length, source_script_hash: scriptHash }, null, 2));
}

main().catch(async (error) => {
  await writeJson(outputPath, { schema: "goldflow_semantic_scene_plan_v1", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() }).catch(() => {});
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
