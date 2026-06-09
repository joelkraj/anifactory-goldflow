#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getLLMModel, isLocalLLMRoute, localLLMAuthHeaders, localLLMChatCompletionURL } from "./lib/llm-router.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const weekDir = path.join(dataRoot, "channels", channel, "weekly_runs", week);
const episodeDir = path.join(weekDir, "episodes", episode);
const timedPlanPath = flags.timed ?? path.join(episodeDir, "timed_scene_plan.json");
const semanticPlanPath = flags.semantic ?? path.join(episodeDir, "semantic_scene_plan.json");
const outputPath = flags.output ?? path.join(episodeDir, "section_image_prompts.json");

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

async function hashFile(filePath) {
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

function compactSceneForPrompt(scene) {
  return {
    scene_id: scene.scene_id,
    title: scene.title,
    start_sec: scene.start_sec,
    end_sec: scene.end_sec,
    duration_sec: scene.duration_sec,
    location: scene.location,
    time: scene.time,
    visible_subjects: scene.visible_subjects ?? [],
    primary_subject: scene.primary_subject ?? null,
    visual_intent: scene.visual_intent ?? "",
    ui_text_on_screen: scene.ui_text_on_screen ?? [],
    sfx_cues: scene.sfx_cues ?? [],
    character_states: scene.character_states ?? [],
    wardrobe: scene.wardrobe ?? null,
    props: scene.props ?? [],
    ref_requirements: scene.ref_requirements ?? [],
    action_staging: scene.action_staging ?? "",
    continuity_notes: scene.continuity_notes ?? [],
    script_excerpt_start: scene.script_excerpt_start,
    script_excerpt_end: scene.script_excerpt_end,
  };
}

function buildPrompt(timedPlan, semanticPlan) {
  const compactTimedPlan = {
    source_script_hash: timedPlan.source_script_hash,
    scene_count: timedPlan.scenes?.length ?? 0,
    timing_source: timedPlan.timing_source,
    scenes: (timedPlan.scenes ?? []).map(compactSceneForPrompt),
  };
  const compactSemanticPlan = {
    episode_summary: semanticPlan.episode_summary ?? "",
    global_reference_requirements: semanticPlan.global_reference_requirements ?? [],
    style_summary: semanticPlan.style_summary ?? "",
    warnings: semanticPlan.warnings ?? [],
  };
  return `Author production image prompts from the timed semantic scene plan.

Rules:
- Use current scene only. Do not import neighboring scene characters, injuries, locations, props, or UI.
- Prompt positively. Do not use negative prompt wording.
- Identify exact subject roles by name and action, especially in multi-character scenes.
- If a scene needs references, list them as reference_requirements only; do not pretend missing refs exist.
- For each cut, include only references that are visible or style-critical.
- Output exactly one prompt per timed scene.
- Return ${compactTimedPlan.scene_count} prompts, one for every scene_id in the timed plan.

TIMED SCENE PLAN:
${JSON.stringify(compactTimedPlan, null, 2)}

SEMANTIC PLAN:
${JSON.stringify(compactSemanticPlan, null, 2)}

Return JSON only:
{
  "style_summary": "...",
  "prompts": [
    {
      "image_id": "ep_01-cut-001",
      "scene_id": "scene_001",
      "start_sec": 0,
      "duration_sec": 6,
      "image_prompt": "positive visual prompt only",
      "modelslab_image_prompt": "same positive prompt optimized for flux-klein",
      "reference_requirements": [{"ref_id":"style_ref","kind":"style","required":true,"reason":"..."}],
      "required_reference_paths": [],
      "visible_subjects": ["..."],
      "primary_subject": "...",
      "location": "...",
      "ui_text_on_screen": ["..."]
    }
  ],
  "warnings": []
}`;
}

async function callLocal(prompt, stageName, maxTokens = null) {
  const attempts = Number(flags["visual-json-attempts"] ?? 3);
  let lastError = null;
  let lastContent = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const retryPrompt = attempt === 1
      ? prompt
      : `${prompt}\n\nYour previous response was invalid or incomplete JSON. Return one complete JSON object only. Escape quotes inside strings. Do not include markdown fences, commentary, trailing commas, or partial objects.`;
    const response = await fetch(localLLMChatCompletionURL(stageName), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...localLLMAuthHeaders() },
      body: JSON.stringify({
        model: getLLMModel(stageName),
        messages: [
          { role: "system", content: "Return only valid JSON. You are a precise anime/manhwa image prompt planner." },
          { role: "user", content: retryPrompt },
        ],
        temperature: attempt === 1 ? Number(flags["llm-temperature"] ?? 0.12) : 0,
        max_tokens: Number(maxTokens ?? flags["llm-max-tokens"] ?? 18000),
      }),
      signal: AbortSignal.timeout(Number(process.env.ANIFACTORY_VISUAL_PLAN_TIMEOUT_MS ?? 1_200_000)),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`local-qwen visual plan HTTP ${response.status}: ${raw.slice(0, 1000)}`);
    const content = JSON.parse(raw)?.choices?.[0]?.message?.content ?? raw;
    lastContent = content;
    try {
      return { provider: "local-qwen", model: getLLMModel(stageName), content, parsed: extractJson(content), json_attempt: attempt };
    } catch (error) {
      lastError = error;
      console.error(`visual ${stageName}: invalid JSON attempt ${attempt}/${attempts}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`local-qwen visual plan returned invalid JSON after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}; content preview: ${lastContent.slice(0, 600)}`);
}

async function callCodex(prompt, stageName) {
  const callDir = path.join(weekDir, "_codex_calls");
  await fs.mkdir(callDir, { recursive: true });
  const outputPath = path.join(callDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${stageName}-output.txt`);
  await new Promise((resolve, reject) => {
    const child = spawn("codex", ["exec", "--ephemeral", "--skip-git-repo-check", "-C", repoRoot, "-o", outputPath], { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`codex visual plan exited ${code}: ${stderr}`)));
    child.stdin.end(prompt);
  });
  const content = await fs.readFile(outputPath, "utf8");
  return { provider: "codex", model: "codex_cli_default", output_path: outputPath, content, parsed: extractJson(content) };
}

function normalizePrompt(row, index, episodeId) {
  const imageId = `${episodeId}-cut-${String(index + 1).padStart(3, "0")}`;
  const prompt = String(row.modelslab_image_prompt ?? row.image_prompt ?? "").trim();
  return {
    image_id: imageId,
    scene_id: row.scene_id ?? null,
    start_sec: Number(row.start_sec ?? 0),
    duration_sec: Math.max(1, Number(row.duration_sec ?? 6)),
    image_prompt: prompt,
    modelslab_image_prompt: prompt,
    prompt_hash: sha256(prompt),
    image_provider_route: "modelslab",
    image_model_route: "flux-klein",
    reference_requirements: Array.isArray(row.reference_requirements) ? row.reference_requirements : [],
    required_reference_paths: Array.isArray(row.required_reference_paths) ? row.required_reference_paths : [],
    visible_subjects: row.visible_subjects ?? [],
    primary_subject: row.primary_subject ?? null,
    location: row.location ?? null,
    ui_text_on_screen: row.ui_text_on_screen ?? [],
    image_generation_required: true,
  };
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

async function main() {
  const [timedPlan, semanticPlan] = await Promise.all([readJson(timedPlanPath, null), readJson(semanticPlanPath, null)]);
  if (timedPlan?.status !== "passed" || !Array.isArray(timedPlan.scenes) || !timedPlan.scenes.length) throw new Error(`Missing passed timed scene plan: ${timedPlanPath}`);
  if (semanticPlan?.status !== "passed") throw new Error(`Missing passed semantic scene plan: ${semanticPlanPath}`);
  if (semanticPlan.source_script_hash !== timedPlan.source_script_hash) throw new Error("semantic_scene_plan and timed_scene_plan script hashes do not match.");
  const stageName = `${episode}_visual_plan`;
  let llm;
  let parsedPrompts = [];
  let styleSummary = "";
  const useChunking = isLocalLLMRoute(stageName)
    && flags["visual-chunking"] !== "false"
    && timedPlan.scenes.length > Number(flags["visual-single-call-max-scenes"] ?? 12);
  if (useChunking) {
    const sceneChunks = chunkArray(timedPlan.scenes, Number(flags["visual-chunk-scenes"] ?? 8));
    const styleSummaries = [];
    for (let index = 0; index < sceneChunks.length; index += 1) {
      const chunkTimedPlan = { ...timedPlan, scenes: sceneChunks[index], scene_count: sceneChunks[index].length };
      console.error(`visual chunk ${index + 1}/${sceneChunks.length}: ${sceneChunks[index].length} scenes`);
      const chunkPrompt = buildPrompt(chunkTimedPlan, semanticPlan);
      const chunkLlm = await callLocal(chunkPrompt, `${stageName}_chunk_${String(index + 1).padStart(2, "0")}`, Number(flags["visual-chunk-max-tokens"] ?? 7000));
      const chunkPrompts = Array.isArray(chunkLlm.parsed.prompts) ? chunkLlm.parsed.prompts : [];
      if (chunkPrompts.length !== sceneChunks[index].length) {
        throw new Error(`Visual chunk ${index + 1}/${sceneChunks.length} returned ${chunkPrompts.length} prompts for ${sceneChunks[index].length} scenes.`);
      }
      console.error(`visual chunk ${index + 1}/${sceneChunks.length}: accepted ${chunkPrompts.length} prompts`);
      parsedPrompts.push(...chunkPrompts);
      if (chunkLlm.parsed.style_summary) styleSummaries.push(chunkLlm.parsed.style_summary);
    }
    styleSummary = styleSummaries.filter(Boolean)[0] ?? "";
    llm = { provider: "local-qwen", model: getLLMModel(stageName), chunked: true, chunk_count: sceneChunks.length, parsed: { prompts: parsedPrompts, style_summary: styleSummary, warnings: [] } };
  } else {
    const prompt = buildPrompt(timedPlan, semanticPlan);
    llm = isLocalLLMRoute(stageName) ? await callLocal(prompt, stageName) : await callCodex(prompt, stageName);
    parsedPrompts = Array.isArray(llm.parsed.prompts) ? llm.parsed.prompts : [];
    styleSummary = llm.parsed.style_summary ?? "";
  }
  const prompts = parsedPrompts.map((row, index) => normalizePrompt(row, index, episode));
  const empty = prompts.filter((row) => !row.image_prompt);
  if (!prompts.length || empty.length) throw new Error(`Visual planner returned ${prompts.length} prompts with ${empty.length} empty prompts.`);
  if (prompts.length !== timedPlan.scenes.length) throw new Error(`Visual planner returned ${prompts.length} prompts for ${timedPlan.scenes.length} timed scenes.`);
  const duplicateImageIds = [...new Set(prompts.map((prompt) => prompt.image_id).filter((imageId, index, all) => all.indexOf(imageId) !== index))];
  if (duplicateImageIds.length) throw new Error(`Visual planner produced duplicate image ids: ${duplicateImageIds.slice(0, 20).join(", ")}`);
  const timedSceneIds = new Set(timedPlan.scenes.map((scene) => scene.scene_id));
  const missingSceneIds = [...timedSceneIds].filter((sceneId) => !prompts.some((prompt) => prompt.scene_id === sceneId));
  if (missingSceneIds.length) throw new Error(`Visual planner missed timed scene ids: ${missingSceneIds.slice(0, 20).join(", ")}`);
  const report = {
    schema: "goldflow_section_image_prompts_v1",
    status: "passed",
    channel,
    series_slug: series,
    week,
    episode,
    source_script_hash: timedPlan.source_script_hash,
    source_artifact_paths: [timedPlanPath, semanticPlanPath],
    source_hashes: Object.fromEntries((await Promise.all([timedPlanPath, semanticPlanPath].map(async (filePath) => [filePath, await hashFile(filePath)]))).filter(([, hash]) => hash)),
    planner: { provider: llm.provider, model: llm.model ?? null, output_path: llm.output_path ?? null, chunked: llm.chunked ?? false, chunk_count: llm.chunk_count ?? null },
    style_summary: styleSummary,
    prompt_policy: "current-scene-only positive prompting; no negative prompt text; references selected only when visible/style-critical",
    prompts,
    warnings: llm.parsed.warnings ?? [],
    updated_at: new Date().toISOString(),
  };
  await writeJson(outputPath, report);
  console.log(JSON.stringify({ status: "passed", output_path: outputPath, prompt_count: prompts.length }, null, 2));
}

main().catch(async (error) => {
  await writeJson(outputPath, { schema: "goldflow_section_image_prompts_v1", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() }).catch(() => {});
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
