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

function buildPrompt(script, bibles) {
  return `Extract a semantic scene plan from the locked narration script.

Rules:
- Use only the locked script and bibles below.
- Do not use source-seed annotations or stale scene artifacts.
- Do not rewrite the script.
- Scene boundaries should support visual planning, SFX planning, and continuity.
- No timestamps. This is semantic only.
- Include production facts needed by visual prompts: location, visible_subjects, primary_subject, visual_intent, ui_text_on_screen, sfx_cues, character_states, wardrobe, props, ref_requirements, action_staging.

BIBLES:
${JSON.stringify(bibles, null, 2).slice(0, 30_000)}

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

async function callLocal(prompt, stageName) {
  const response = await fetch(localLLMChatCompletionURL(stageName), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...localLLMAuthHeaders() },
    body: JSON.stringify({
      model: getLLMModel(stageName),
      messages: [
        { role: "system", content: "Return only valid JSON. You are a production semantic planner for longform anime/manhwa recap videos." },
        { role: "user", content: prompt },
      ],
      temperature: Number(flags["llm-temperature"] ?? 0.15),
      max_tokens: Number(flags["llm-max-tokens"] ?? 18000),
    }),
    signal: AbortSignal.timeout(Number(process.env.ANIFACTORY_SEMANTIC_PLAN_TIMEOUT_MS ?? 1_200_000)),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`local-qwen semantic plan HTTP ${response.status}: ${raw.slice(0, 1000)}`);
  const content = JSON.parse(raw)?.choices?.[0]?.message?.content ?? raw;
  return { provider: "local-qwen", model: getLLMModel(stageName), content, parsed: extractJson(content) };
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
  const prompt = buildPrompt(script, bibles);
  const stageName = `${episode}_semantic_scene_plan`;
  const llm = isLocalLLMRoute(stageName) ? await callLocal(prompt, stageName) : await callCodex(prompt, stageName);
  const scenes = Array.isArray(llm.parsed.scenes) ? llm.parsed.scenes : [];
  if (!scenes.length) throw new Error("Semantic scene planner returned no scenes.");
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
    planner: { provider: llm.provider, model: llm.model ?? null, output_path: llm.output_path ?? null },
    ...llm.parsed,
    scenes,
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
