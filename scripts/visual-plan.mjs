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
const visualBeatPlanPath = flags.beats ?? flags["visual-beats"] ?? path.join(episodeDir, "visual_beat_plan.json");
const semanticPlanPath = flags.semantic ?? path.join(episodeDir, "semantic_scene_plan.json");
const visualReferencePlanPath = flags.visualRefs ?? flags["visual-refs"] ?? path.join(episodeDir, "visual_reference_plan.json");
const characterStateRefsPath = flags.characterStateRefs ?? flags["character-state-refs"] ?? path.join(episodeDir, "character_state_refs.json");
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

function negativeLanguageMatches(value) {
  const text = String(value ?? "").toLowerCase();
  const patterns = [
    /\bno\b/,
    /\bnot\b/,
    /\bwithout\b/,
    /\bavoid\b/,
    /\bexclude\b/,
    /\binstead\s+of\b/,
    /\brather\s+than\b/,
    /\bdo\s+not\b/,
    /\bdon't\b/,
    /--no\b/,
    /\bnegative\s+prompt\b/,
  ];
  return patterns.filter((pattern) => pattern.test(text)).map(String);
}

function assertPositivePromptLanguage(prompts) {
  const failures = [];
  for (const prompt of prompts) {
    const matches = negativeLanguageMatches(prompt.modelslab_image_prompt ?? prompt.image_prompt);
    if (matches.length) failures.push(`${prompt.image_id} contains negative visual language: ${matches.join(", ")}`);
  }
  if (failures.length) {
    throw new Error(`Visual prompt plan violates positive-language-only contract:\n${failures.slice(0, 20).join("\n")}`);
  }
}

function normalizeLabel(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function sceneCharacterStateRefs(scene, stateRefIndex = new Map()) {
  if (Array.isArray(scene.character_state_refs)) return scene.character_state_refs;
  const refs = [];
  const sceneId = String(scene.scene_id ?? "");
  const visibleLabels = [
    ...(scene.visible_subjects ?? []),
    ...((scene.character_states ?? []).map((state) => state.character)),
  ].filter(Boolean);
  for (const label of visibleLabels) {
    const keys = [
      `${sceneId}:${normalizeLabel(label)}`,
      `*:${normalizeLabel(label)}`,
      normalizeLabel(label),
    ];
    const ref = keys.map((key) => stateRefIndex.get(key)).find(Boolean);
    if (ref) refs.push(ref);
  }
  return refs;
}

function compactSceneForPrompt(scene, stateRefIndex = new Map()) {
  return {
    scene_id: scene.scene_id,
    visual_beat_id: scene.visual_beat_id ?? null,
    parent_scene_id: scene.parent_scene_id ?? scene.scene_id,
    beat_index: scene.beat_index ?? null,
    beat_count: scene.beat_count ?? null,
    visual_beat_focus: scene.visual_beat_focus ?? null,
    title: scene.title,
    start_sec: scene.start_sec,
    end_sec: scene.end_sec,
    duration_sec: scene.duration_sec,
    location: scene.location,
    time: scene.time,
    visible_subjects: scene.visible_subjects ?? [],
    primary_subject: scene.primary_subject ?? null,
    visual_intent: scene.visual_intent ?? "",
    character_state_refs: sceneCharacterStateRefs(scene, stateRefIndex),
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

function relevantReferenceTargets(scene, visualReferencePlan) {
  const sceneId = scene.parent_scene_id ?? scene.scene_id;
  return (visualReferencePlan?.reference_targets ?? []).filter((target) => {
    if (!Array.isArray(target.scene_ids) || !target.scene_ids.length) return false;
    return target.scene_ids.includes(sceneId);
  });
}

function resolvedReferencePath(rawPath) {
  if (!rawPath) return null;
  return path.isAbsolute(rawPath) ? rawPath : path.join(episodeDir, rawPath);
}

async function fileExists(filePath) {
  if (!filePath) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function enrichVisualReferencePlan(visualReferencePlan) {
  if (!visualReferencePlan) return null;
  const targets = await Promise.all((visualReferencePlan.reference_targets ?? []).map(async (target) => {
    const referencePath = target.reference_image_path ?? target.required_reference_path ?? target.path ?? null;
    const resolvedPath = resolvedReferencePath(referencePath);
    return {
      ...target,
      reference_image_path: referencePath,
      resolved_reference_image_path: resolvedPath,
      reference_exists: await fileExists(resolvedPath),
    };
  }));
  return { ...visualReferencePlan, reference_targets: targets };
}

function buildPrompt(timedPlan, semanticPlan, visualReferencePlan = null, stateRefIndex = new Map(), visualBeatPlan = null) {
  const sourceRows = visualBeatPlan?.status === "passed" && Array.isArray(visualBeatPlan.beats) && visualBeatPlan.beats.length
    ? visualBeatPlan.beats
    : timedPlan.scenes;
  const compactTimedPlan = {
    source_script_hash: timedPlan.source_script_hash,
    scene_count: sourceRows?.length ?? 0,
    source_unit: visualBeatPlan ? "visual_beats" : "timed_scenes",
    parent_scene_count: timedPlan.scenes?.length ?? 0,
    timing_source: timedPlan.timing_source,
    visual_reference_plan_status: visualReferencePlan?.status ?? null,
    scenes: (sourceRows ?? []).map((scene) => ({
      ...compactSceneForPrompt(scene, stateRefIndex),
      reference_targets: relevantReferenceTargets(scene, visualReferencePlan),
    })),
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
- Positive visual language is mandatory. Describe only what should appear.
- Do not use negative prompt clauses or mitigation phrasing such as "no", "not", "without", "avoid", "exclude", "instead of", or "rather than".
- Translate source text that contains negative wording into positive visual wording. Use "windowless room" for "no windows", "single visible subject" for absent extra characters, and "plain open-collar garment" for unwanted formalwear risk.
- Convert risks into positive construction: exact visible subject count, role, pose, action direction, wardrobe construction, frame composition, and location details.
- For single-character shots, state the visible subject positively, such as "one named character alone in frame" rather than naming absent characters.
- Identify exact subject roles by name and action, especially in multi-character scenes.
- For visual beats, use visual_beat_focus to change camera angle, pose, action moment, and composition across beats in the same parent scene.
- Character references are identity and wardrobe evidence. Use them to match face, hair, age, body type, and outfit while placing the character in the new pose/action required by this beat.
- Location references are environment evidence. Use them for setting, architecture, lighting, and materials.
- Action/effect references are visual language evidence. Use them for power shape, energy color, and interaction pattern while keeping the beat's current location and subjects.
- In modelslab_image_prompt, include explicit reference slot mapping when references are needed, phrased like Flux context instructions: "Use image one as character identity for Kang Jiwoo; use image two as the dungeon location; use image three as the blue attention-thread effect."
- Character state refs are definitive when present. For every visible named character with a character_state_refs.prompt_anchor, copy that prompt_anchor into the prompt rather than inventing or paraphrasing wardrobe.
- If semantic wardrobe conflicts with character_state_refs, character_state_refs wins.
- If no character_state_refs are provided for a visible character, do not create a definitive anchor. Keep wording limited to current-scene facts and add a warning requesting missing character state ref coverage.
- If a scene needs references, list them as reference_requirements only; do not pretend missing refs exist or define new canonical refs in this stage.
- For each cut, include only references that are visible or style-critical.
- Use visual reference targets to decide reference_usage and anchor_roles.
- Order reference_requirements in the exact attachment order wanted by the image model. Use slot_order starting at 1.
- Put character identity refs before location refs when the main risk is character identity. Put location refs before character refs when the main risk is the environment. Put action/effect refs after identity and location refs unless the effect is the primary subject.
- Each reference requirement should include slot_purpose, such as "character identity and wardrobe for Kang Jiwoo" or "dungeon location environment".
- For standalone_ref targets, mark reference_usage as attach_existing_ref only when a required reference path exists; otherwise report missing_reference_coverage.
- For derive_from_first_clean_cut, derive_from_best_cut, and derive_from_first_clean_wide_cut targets, nominate suitable source-anchor cuts with anchor_roles.
- For no_ref_needed targets, do not attach a reference.
- Output exactly one prompt per ${compactTimedPlan.source_unit === "visual_beats" ? "visual beat" : "timed scene"}.
- Return ${compactTimedPlan.scene_count} prompts, one for every unit in the plan.

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
      "visual_beat_id": "scene_001_beat_01",
      "start_sec": 0,
      "duration_sec": 6,
      "image_prompt": "positive visual prompt only",
      "modelslab_image_prompt": "same positive prompt optimized for flux-klein",
      "reference_requirements": [{"ref_id":"style_ref","kind":"style","required":true,"slot_order":1,"slot_purpose":"anime manhwa style language","reason":"..."}],
      "required_reference_paths": [],
      "reference_usage": [{"ref_id":"...","usage":"attach_existing_ref|derive_from_cut|no_ref_needed|missing_reference_coverage","reason":"..."}],
      "anchor_roles": [{"ref_id":"...","kind":"character_state|location|prop|ui|action","anchor_role":"source_anchor","reason":"..."}],
      "visible_subjects": ["..."],
      "character_state_refs_used": ["state_ref_id"],
      "primary_subject": "...",
      "location": "...",
      "ui_text_on_screen": ["..."]
    }
  ],
  "warnings": [{"scene_id":"...","code":"missing_character_state_ref","message":"..."}]
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
          { role: "system", content: "Return only valid JSON. You are a precise anime/manhwa image prompt planner. Use positive visual language only: describe what should appear, never what should be avoided." },
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
    visual_beat_id: row.visual_beat_id ?? null,
    start_sec: Number(row.start_sec ?? 0),
    duration_sec: Math.max(1, Number(row.duration_sec ?? 6)),
    image_prompt: prompt,
    modelslab_image_prompt: prompt,
    prompt_hash: sha256(prompt),
    image_provider_route: "modelslab",
    image_model_route: "flux-klein",
    reference_requirements: Array.isArray(row.reference_requirements) ? row.reference_requirements : [],
    required_reference_paths: Array.isArray(row.required_reference_paths) ? row.required_reference_paths : [],
    reference_usage: Array.isArray(row.reference_usage) ? row.reference_usage : [],
    anchor_roles: Array.isArray(row.anchor_roles) ? row.anchor_roles : [],
    visible_subjects: row.visible_subjects ?? [],
    character_state_refs_used: Array.isArray(row.character_state_refs_used) ? row.character_state_refs_used : [],
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

function indexCharacterStateRefs(artifact) {
  const refs = [];
  if (Array.isArray(artifact?.character_state_refs)) refs.push(...artifact.character_state_refs);
  if (Array.isArray(artifact?.states)) refs.push(...artifact.states);
  if (artifact?.characters && typeof artifact.characters === "object") {
    for (const [character, states] of Object.entries(artifact.characters)) {
      for (const state of Array.isArray(states) ? states : [states]) refs.push({ character, ...state });
    }
  }
  const index = new Map();
  for (const ref of refs.filter(Boolean)) {
    const character = ref.character ?? ref.character_name ?? ref.name;
    const sceneId = ref.scene_id ?? ref.scene ?? "*";
    if (!character || !ref.prompt_anchor) continue;
    const normalized = {
      ...ref,
      character,
      scene_id: sceneId === "*" ? null : sceneId,
      state_ref_id: ref.state_ref_id ?? ref.ref_id ?? `${normalizeLabel(character).replace(/\s+/g, "_")}_${sceneId}`,
      definitive: ref.definitive !== false,
      source: ref.source ?? "character_state_ref_artifact",
    };
    index.set(`${sceneId}:${normalizeLabel(character)}`, normalized);
    if (sceneId === "*") index.set(normalizeLabel(character), normalized);
  }
  return index;
}

async function main() {
  const [timedPlan, semanticPlan, visualReferencePlan, characterStateRefs, visualBeatPlan] = await Promise.all([
    readJson(timedPlanPath, null),
    readJson(semanticPlanPath, null),
    readJson(visualReferencePlanPath, null),
    readJson(characterStateRefsPath, null),
    readJson(visualBeatPlanPath, null),
  ]);
  if (timedPlan?.status !== "passed" || !Array.isArray(timedPlan.scenes) || !timedPlan.scenes.length) throw new Error(`Missing passed timed scene plan: ${timedPlanPath}`);
  if (semanticPlan?.status !== "passed") throw new Error(`Missing passed semantic scene plan: ${semanticPlanPath}`);
  if (semanticPlan.source_script_hash !== timedPlan.source_script_hash) throw new Error("semantic_scene_plan and timed_scene_plan script hashes do not match.");
  if (!visualReferencePlan || visualReferencePlan.status !== "passed") throw new Error(`Missing passed visual reference plan: ${visualReferencePlanPath}`);
  const allowDraftRefs = flags["allow-draft-refs"] === "true";
  if (!["approved", "passed"].includes(characterStateRefs?.status) && !allowDraftRefs) {
    throw new Error(`character_state_refs must be approved before visual planning. Current status: ${characterStateRefs?.status ?? "missing"}. Use --allow-draft-refs true only for diagnostics.`);
  }
  const enrichedVisualReferencePlan = await enrichVisualReferencePlan(visualReferencePlan);
  const stateRefIndex = indexCharacterStateRefs(characterStateRefs);
  const visualSourceRows = visualBeatPlan?.status === "passed" && Array.isArray(visualBeatPlan.beats) && visualBeatPlan.beats.length
    ? visualBeatPlan.beats
    : timedPlan.scenes;
  const stageName = `${episode}_visual_plan`;
  let llm;
  let parsedPrompts = [];
  let styleSummary = "";
  const useChunking = isLocalLLMRoute(stageName)
    && flags["visual-chunking"] !== "false"
    && visualSourceRows.length > Number(flags["visual-single-call-max-scenes"] ?? 12);
  if (useChunking) {
    const sceneChunks = chunkArray(visualSourceRows, Number(flags["visual-chunk-scenes"] ?? 8));
    const styleSummaries = [];
    for (let index = 0; index < sceneChunks.length; index += 1) {
      const chunkTimedPlan = { ...timedPlan, scenes: sceneChunks[index], scene_count: sceneChunks[index].length };
      console.error(`visual chunk ${index + 1}/${sceneChunks.length}: ${sceneChunks[index].length} scenes`);
      const chunkVisualBeatPlan = visualBeatPlan?.status === "passed" ? { ...visualBeatPlan, beats: sceneChunks[index], visual_beat_count: sceneChunks[index].length } : null;
      const chunkPrompt = buildPrompt(chunkTimedPlan, semanticPlan, enrichedVisualReferencePlan, stateRefIndex, chunkVisualBeatPlan);
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
    const prompt = buildPrompt(timedPlan, semanticPlan, enrichedVisualReferencePlan, stateRefIndex, visualBeatPlan?.status === "passed" ? visualBeatPlan : null);
    llm = isLocalLLMRoute(stageName) ? await callLocal(prompt, stageName) : await callCodex(prompt, stageName);
    parsedPrompts = Array.isArray(llm.parsed.prompts) ? llm.parsed.prompts : [];
    styleSummary = llm.parsed.style_summary ?? "";
  }
  const prompts = parsedPrompts.map((row, index) => normalizePrompt(row, index, episode));
  const empty = prompts.filter((row) => !row.image_prompt);
  if (!prompts.length || empty.length) throw new Error(`Visual planner returned ${prompts.length} prompts with ${empty.length} empty prompts.`);
  assertPositivePromptLanguage(prompts);
  const expectedPromptCount = visualBeatPlan?.status === "passed" && Array.isArray(visualBeatPlan.beats) && visualBeatPlan.beats.length
    ? visualBeatPlan.beats.length
    : timedPlan.scenes.length;
  if (prompts.length !== expectedPromptCount) throw new Error(`Visual planner returned ${prompts.length} prompts for ${expectedPromptCount} visual units.`);
  const duplicateImageIds = [...new Set(prompts.map((prompt) => prompt.image_id).filter((imageId, index, all) => all.indexOf(imageId) !== index))];
  if (duplicateImageIds.length) throw new Error(`Visual planner produced duplicate image ids: ${duplicateImageIds.slice(0, 20).join(", ")}`);
  const timedSceneIds = new Set(timedPlan.scenes.map((scene) => scene.scene_id));
  const missingSceneIds = [...timedSceneIds].filter((sceneId) => !prompts.some((prompt) => prompt.scene_id === sceneId));
  if (missingSceneIds.length) throw new Error(`Visual planner missed timed scene ids: ${missingSceneIds.slice(0, 20).join(", ")}`);
  const missingBeatIds = visualBeatPlan?.status === "passed"
    ? visualBeatPlan.beats.map((beat) => beat.visual_beat_id).filter((beatId) => beatId && !prompts.some((prompt) => prompt.visual_beat_id === beatId))
    : [];
  if (missingBeatIds.length) throw new Error(`Visual planner missed visual beat ids: ${missingBeatIds.slice(0, 20).join(", ")}`);
  const sourcePaths = [timedPlanPath, semanticPlanPath, visualReferencePlanPath, characterStateRefsPath];
  if (visualBeatPlan?.status === "passed") sourcePaths.push(visualBeatPlanPath);
  const report = {
    schema: "goldflow_section_image_prompts_v1",
    status: "passed",
    channel,
    series_slug: series,
    week,
    episode,
    source_script_hash: timedPlan.source_script_hash,
    source_artifact_paths: sourcePaths,
    source_hashes: Object.fromEntries((await Promise.all(sourcePaths.map(async (filePath) => [filePath, await hashFile(filePath)]))).filter(([, hash]) => hash)),
    planner: { provider: llm.provider, model: llm.model ?? null, output_path: llm.output_path ?? null, chunked: llm.chunked ?? false, chunk_count: llm.chunk_count ?? null },
    style_summary: styleSummary,
    prompt_policy: "current-scene-only positive prompting; visual-beat-aware when visual_beat_plan exists; references selected only when visible/style-critical and described by explicit image slot roles",
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
