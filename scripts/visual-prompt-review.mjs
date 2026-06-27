#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getLLMModel, isLocalLLMRoute, localLLMAuthHeaders, localLLMChatCompletionURL } from "./lib/llm-router.mjs";
import { CHARACTER_STAGING_POSITIONS, multiCharacterBleedFindings, sanitizeCharacterStaging } from "./lib/character-staging-utils.mjs";
import { beautyLanguageFindings, namedCharacterDuplicationFindings, negativePromptFindings } from "./lib/prompt-prose-findings.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const weekDir = path.join(dataRoot, "channels", channel, "weekly_runs", week);
const episodeDir = path.join(weekDir, "episodes", episode);
const promptPath = flags.prompts ?? path.join(episodeDir, "section_image_prompts.json");
const timedPlanPath = flags.timed ?? path.join(episodeDir, "timed_scene_plan.json");
const visualReferencePlanPath = flags.visualRefs ?? flags["visual-refs"] ?? path.join(episodeDir, "visual_reference_plan.json");
const characterStateRefsPath = flags.characterStateRefs ?? flags["character-state-refs"] ?? path.join(episodeDir, "character_state_refs.json");
const outputPath = flags.output ?? path.join(episodeDir, "section_image_prompts_reviewed.json");
const reviewReportPath = flags.reviewOutput ?? flags["review-output"] ?? flags.report ?? flags["report-output"] ?? path.join(episodeDir, `visual_prompt_review_${episode}.json`);
const autoResolveEnabled = flags["auto-resolve"] === "true";
const maxResolveIterations = Math.max(1, Number(flags["max-resolve-iterations"] ?? 2));
const deadletterPath = flags.deadletter ?? flags["deadletter-output"] ?? path.join(episodeDir, "visual_resolution_deadletter.json");

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

function normalize(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").trim();
}

function sceneNumber(sceneId) {
  const match = String(sceneId ?? "").match(/^scene_(\d+)$/);
  return match ? Number(match[1]) : null;
}

function sceneIdsCover(sceneIds, sceneId) {
  if (!Array.isArray(sceneIds) || !sceneIds.length || sceneIds.includes("*")) return true;
  if (sceneIds.includes(sceneId)) return true;
  const current = sceneNumber(sceneId);
  const numeric = sceneIds.map(sceneNumber).filter((value) => Number.isFinite(value));
  if (current !== null && sceneIds.length === 2 && numeric.length === 2) {
    const low = Math.min(...numeric);
    const high = Math.max(...numeric);
    return current >= low && current <= high;
  }
  return false;
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

async function runNodeScript(script, args = []) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, "scripts", script), ...args], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`${script} exited ${code}: ${stderr || stdout}`));
    });
  });
}

async function exists(filePath) {
  return Boolean(filePath) && fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
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

function compactScene(scene) {
  return {
    scene_id: scene.scene_id,
    visual_beat_id: scene.visual_beat_id ?? null,
    parent_scene_id: scene.parent_scene_id ?? scene.scene_id,
    beat_index: scene.beat_index ?? null,
    beat_count: scene.beat_count ?? null,
    visual_beat_focus: scene.visual_beat_focus ?? null,
    visual_beat_action: scene.visual_beat_action ?? null,
    visual_beat_script_excerpt: scene.visual_beat_script_excerpt ?? null,
    title: scene.title,
    start_sec: scene.start_sec,
    duration_sec: scene.duration_sec,
    location: scene.location,
    visible_subjects: scene.visible_subjects ?? [],
    primary_subject: scene.primary_subject ?? null,
    visual_intent: scene.visual_intent ?? "",
    ui_text_on_screen: scene.ui_text_on_screen ?? [],
    action_staging: scene.action_staging ?? "",
    character_states: scene.character_states ?? [],
    props: scene.props ?? [],
    continuity_notes: scene.continuity_notes ?? [],
  };
}

function compactPrompt(prompt) {
  return {
    image_id: prompt.image_id,
    scene_id: prompt.scene_id,
    visual_beat_id: prompt.visual_beat_id ?? null,
    visual_beat_action: prompt.visual_beat_action ?? null,
    visual_beat_script_excerpt: prompt.visual_beat_script_excerpt ?? null,
    start_sec: prompt.start_sec,
    duration_sec: prompt.duration_sec,
    image_prompt: prompt.image_prompt ?? prompt.modelslab_image_prompt,
    modelslab_image_prompt: prompt.modelslab_image_prompt ?? prompt.image_prompt,
    codex_image_prompt: prompt.codex_image_prompt ?? null,
    reference_requirements: prompt.reference_requirements ?? [],
    required_reference_paths: prompt.required_reference_paths ?? [],
    reference_usage: prompt.reference_usage ?? [],
    anchor_roles: prompt.anchor_roles ?? [],
    shot_manifest: prompt.shot_manifest ?? null,
    visible_subjects: prompt.visible_subjects ?? [],
    character_state_refs_used: prompt.character_state_refs_used ?? [],
    primary_subject: prompt.primary_subject ?? null,
    location: prompt.location ?? null,
    ui_text_on_screen: prompt.ui_text_on_screen ?? [],
  };
}

function compactReferencePlan(plan, prompts = []) {
  const relevantRefIds = new Set();
  const relevantSceneIds = new Set();
  for (const prompt of prompts ?? []) {
    if (prompt.scene_id) relevantSceneIds.add(prompt.scene_id);
    if (prompt.shot_manifest?.location_ref_id) relevantRefIds.add(prompt.shot_manifest.location_ref_id);
    for (const refId of prompt.shot_manifest?.character_state_ref_ids ?? []) relevantRefIds.add(refId);
    if (prompt.shot_manifest?.protagonist_state_ref_id) relevantRefIds.add(prompt.shot_manifest.protagonist_state_ref_id);
    for (const req of prompt.reference_requirements ?? []) if (req?.ref_id) relevantRefIds.add(req.ref_id);
    for (const usage of prompt.reference_usage ?? []) if (usage?.ref_id) relevantRefIds.add(usage.ref_id);
    for (const role of prompt.anchor_roles ?? []) if (role?.ref_id) relevantRefIds.add(role.ref_id);
  }
  const targetIsRelevant = (target) => {
    if (relevantRefIds.has(target.ref_id)) return true;
    const sceneIds = Array.isArray(target.scene_ids) ? target.scene_ids : [];
    return sceneIds.some((sceneId) => relevantSceneIds.has(sceneId));
  };
  return {
    status: plan?.status ?? null,
    reference_targets: (plan?.reference_targets ?? []).filter(targetIsRelevant).map((target) => ({
      ref_id: target.ref_id,
      kind: target.kind,
      subject: target.subject,
      scene_ids: target.scene_ids ?? [],
      priority: target.priority,
      generation_mode: target.generation_mode,
      required_before_imagegen: target.required_before_imagegen,
      reference_image_path: target.reference_image_path ?? target.required_reference_path ?? null,
      prompt_anchor: target.prompt_anchor,
      risk_notes: target.risk_notes ?? [],
    })),
  };
}

function compactCharacterStateRefs(refs, prompts = []) {
  const relevantRefIds = new Set();
  const relevantSceneIds = new Set();
  const relevantNames = new Set();
  for (const prompt of prompts ?? []) {
    if (prompt.scene_id) relevantSceneIds.add(prompt.scene_id);
    for (const name of prompt.visible_subjects ?? []) relevantNames.add(normalize(name));
    for (const name of prompt.shot_manifest?.visible_characters ?? []) relevantNames.add(normalize(name));
    for (const name of prompt.shot_manifest?.mentioned_only_characters ?? []) relevantNames.add(normalize(name));
    if (prompt.primary_subject) relevantNames.add(normalize(prompt.primary_subject));
    if (prompt.shot_manifest?.primary_character) relevantNames.add(normalize(prompt.shot_manifest.primary_character));
    if (prompt.shot_manifest?.protagonist_state_ref_id) relevantRefIds.add(prompt.shot_manifest.protagonist_state_ref_id);
    for (const refId of prompt.shot_manifest?.character_state_ref_ids ?? []) relevantRefIds.add(refId);
    for (const refId of prompt.character_state_refs_used ?? []) relevantRefIds.add(refId);
    for (const req of prompt.reference_requirements ?? []) if (req?.ref_id) relevantRefIds.add(req.ref_id);
  }
  const refIsRelevant = (ref) => {
    const ids = [ref.state_ref_id, ref.source_ref_id, ref.ref_id].filter(Boolean);
    if (ids.some((id) => relevantRefIds.has(id))) return true;
    const sceneIds = Array.isArray(ref.scene_ids) ? ref.scene_ids : [];
    if (sceneIds.includes("*") || sceneIds.some((sceneId) => relevantSceneIds.has(sceneId))) return true;
    const character = normalize(ref.character);
    return character && [...relevantNames].some((name) => character.includes(name) || name.includes(character));
  };
  return {
    status: refs?.status ?? null,
    character_state_refs: (refs?.character_state_refs ?? []).filter(refIsRelevant).map((ref) => ({
      state_ref_id: ref.state_ref_id,
      character: ref.character,
      scene_ids: ref.scene_ids ?? [],
      prompt_anchor: ref.prompt_anchor,
      scene_prompt_anchor: ref.scene_prompt_anchor ?? ref.scene_anchor ?? ref.prompt_anchor,
      definitive: ref.definitive,
      reference_image_path: ref.reference_image_path ?? null,
      source_ref_id: ref.source_ref_id ?? null,
    })),
  };
}

function buildPrompt({ promptPlan, timedPlan, visualReferencePlan, characterStateRefs, prompts }) {
  const scenesById = new Map((timedPlan.scenes ?? []).map((scene) => [scene.scene_id, compactScene(scene)]));
  const rows = prompts.map((prompt) => ({
    scene: scenesById.get(prompt.scene_id) ?? null,
    prompt: compactPrompt(prompt),
  }));
  return `Review and fix image prompts for longform anime/manhwa production.

You are the second LLM pass. Do not change scene structure, timing, image IDs, or scene IDs.
You may revise the prompt wording when it improves visual correctness.
The code gate will validate counts, IDs, hashes, and explicit blockers; your job is creative diagnosis and prompt correction.

Review for:
- wrong character focus
- identity blending risk
- unnecessary attached references
- missing required references
- action direction reversal
- literalized metaphor or figurative text becoming a wrong prop
- wardrobe contradiction against character state refs
- stale neighboring-scene context
- characters not visible in the current scene
- negative prompt wording
- vague multi-character action staging
- prompt contradiction against current scene facts
- reference-pose lock, where the prompt lets a character preserve a neutral reference pose during an action scene
- repeated tableau, where several beats in one scene show the same hero pose or same summary image with only camera labels changed
- contaminated action/effect references, where a power/effect ref brings its own room, screens, soldiers, or unrelated scene into the prompt

Rules:
- You are the creative visual reviewer. The downstream deterministic pass only sanitizes approved ref IDs, paths, forbidden refs, and the four-reference cap; it will not creatively infer missing locations, add characters, rewrite action, choose shot jobs, or fix narrative intent.
- Use current scene facts only.
- Positive visual language is mandatory. Describe only what should appear.
- Do not use negative prompt clauses or mitigation phrasing such as "no", "not", "without", "avoid", "exclude", "instead of", or "rather than".
- Translate source text that contains negative wording into positive visual wording. Use "windowless room" for "no windows", "single visible subject" for absent extra characters, and "plain open-collar garment" for unwanted formalwear risk.
- Convert risks into positive construction: exact visible subject count, role, pose, action direction, wardrobe construction, frame composition, and location details.
- For single-character shots, state the visible subject positively, such as "one named character alone in frame" rather than naming absent characters.
- Character references provide face, hair, age, body type, and outfit only. Scene pose, camera angle, and action come from the current visual beat.
- Use character_state_refs.scene_prompt_anchor for identity, wardrobe, and state wording inside scene prompts. prompt_anchor may describe a reference-generation sheet and should not be copied into scene cuts.
- visual_beat_script_excerpt and visual_beat_action are authoritative for what this cut shows. Rewrite generic scene-summary prompts into a concrete moment from that beat excerpt.
- Review and repair shot_manifest first, then make the prose prompt and reference_requirements obey it. The manifest is the cut contract: visible characters, mentioned-only characters, location ref, character state refs, foreground action, shot job, props/UI, and forbidden refs.
- If a character is mentioned_only in shot_manifest, remove that character's reference and keep them out of the visible prompt. If a ref_id appears in forbidden_ref_ids, remove it. If the cut physically occurs in a real environment such as an apartment, gym, office, street, shop, corridor, boardroom, lobby, stage, or courthouse area, choose the closest approved location ref, set shot_manifest.location_ref_id, and attach that location ref unless all four slots are needed for visible characters. If location_ref_id is set, make the prompt and location reference match it.
- For cuts with two or more visible characters, shot_manifest.character_staging is required and must cover visible_characters in the same order.
- shot_manifest.character_staging screen_position must use this fixed vocabulary only: ${CHARACTER_STAGING_POSITIONS.join(" | ")}.
- For cuts with two or more visible characters, keep separate position-bound people clauses in the prompt. Each staged clause must bind screen position, character name, that character's copied scene_prompt_anchor wardrobe/state wording, and that character's pose.
- Never merge two characters into one shared wardrobe or appearance clause, and never describe wardrobe without naming whose wardrobe it is.
- Keep reference_requirements.slot_order and slot_purpose aligned with character_staging order so the image model receives the same identity order that the prose prompt uses.
- For multi-character cuts where any body-occluding surface or large object is in frame (recognize it from the beat/location, not a fixed list), check that modelslab_image_prompt gives each character an explicit side-of-surface placement, states body clearance positively (torso above the surface line, feet grounded, no body-surface merging), and avoids flat centered bilateral staging. codex_image_prompt may stay more centered if bodies remain discrete and clear of the surface.
- Do not import a named location/world/era/institution from a reference merely because it is visually convenient. If a location ref's named setting is absent from the current visual_beat_script_excerpt, visual_beat_action, and semantic scene location, remove that location ref and stage the generic current location from the beat text.
- Treat reference target scene_ids as usage contracts for location, prop, UI, and action/effect refs. If such a ref's scene_ids do not cover the current scene, remove it from shot_manifest and reference_requirements, and rewrite the prose location/action from the current beat. When a reference has two scene IDs like scene_009 and scene_039, treat that as an inclusive scene range.
- Parent scene context is context only. The visible cut must be the current visual_beat_script_excerpt moment, not a broad parent-scene summary or a future reveal.
- Across prompts with the same scene_id, preserve visible action progression: establish, object/UI close-up, character interaction, impact, reaction, consequence, and transition as appropriate to each beat excerpt.
- Use a calm foreground character only when that beat excerpt is about stillness, calculation, realization, or a character reveal.
- modelslab_image_prompt should be a polished image-generation prompt, not a metadata summary. Rewrite prompts that start with "Cut 001", "scene", "beat", or title bookkeeping.
- codex_image_prompt is optional provider-specific wording for Codex/OpenAI image generation. If it exists, review it for the same shot_manifest, visible subjects, action, location, and refs as image_prompt; preserve it when good and repair it only when needed.
- Each prompt should start with the concrete visible moment, subject, action, and location from visual_beat_script_excerpt.
- Every prompt in the same scene should have a different visual job. Prefer concrete shot jobs such as environment establishment, object insert, hand/action close-up, over-shoulder confrontation, impact frame, crowd reaction, UI reveal, aftermath, or transition.
- If the beat excerpt mentions a hand, object, UI line, shove, strike, gate, orb, phone, counter, or expression change, make that element the visible focus for that cut.
- Scene cuts should use one continuous full-frame composition by default. Intentional manga panel or split-screen layouts are allowed for montage beats, memory fragments, reaction stacks, parallel action, or UI-heavy reveals when they serve the beat.
- UI text policy for image generation: keep modelslab_image_prompt focused on clean holographic panels, gauges, icons, simple labels, and at most one short large number or word when visually essential. Move exact multi-line system text, captions, lists, and long labels to ui_text_on_screen for render/subtitle overlay instead of asking the image model to draw dense readable text.
- Scene cuts must not request contact sheets, reference panels, character sheets, turnarounds, or visible reference-image layouts.
- Location references provide architecture, environment, lighting, and materials only.
- Action/effect references provide effect shape, color, and interaction pattern only. Current scene location and current visible subjects stay authoritative.
- When references are attached, preserve positive Flux-style slot mapping through reference_requirements.slot_order and slot_purpose. The imagegen wrapper adds the "Use image one as..." text at generation time.
- For action scenes, use active pose language with direction and changed body position.
- Preserve each image_id, scene_id, start_sec, and duration_sec exactly.
- Preserve one reviewed prompt for every input prompt.
- If a prompt is already good, keep it materially unchanged.
- If a reference is not visible or style-critical for this cut, remove it from reference_usage and required_reference_paths.
- Keep at most four reference_requirements for any cut.
- Attach only necessary references. Use no more than four refs; fewer is better when the cut remains clear. Do not attach refs for people, locations, props, or UI that are only mentioned, remembered, texted, called, or implied.
- Reference priority is strict: visible character_state refs first, then location, then prop or UI, then action or effects, then style.
- Attach style only when the cut has zero concrete character, location, prop, UI, or action references.
- When more than four concrete references could apply, keep the highest-priority four and report dropped lower-priority refs in reference_usage as available_not_attached_reference_limit.
- Order reference_requirements in the exact attachment order wanted by the image model. Use slot_order starting at 1 and slot_purpose for every attached reference.
- Preserve clear reference slot mapping in reference_requirements so the image model knows which image provides character identity, location, style, UI, prop, or action/effect design.
- If a required existing reference is missing, add a finding with severity "blocker".
- Reference image files are generated after this review pass. A null, unresolved, or not-yet-generated reference_image_path is not a blocker here when the ref_id exists in the approved reference plan or character_state_refs; keep the ref_id and let the image generation stage resolve the file.
- If a problem is fixed in revised prompt text, mark resolved true.
- Do not invent new canonical character anchors. Use character_state_refs and visual_reference_plan only.

PROMPT PLAN SUMMARY:
${JSON.stringify({
  source_script_hash: promptPlan.source_script_hash,
  prompt_count: promptPlan.prompts?.length ?? 0,
  prompt_policy: promptPlan.prompt_policy,
  style_summary: promptPlan.style_summary,
}, null, 2)}

VISUAL REFERENCES:
${JSON.stringify(compactReferencePlan(visualReferencePlan, prompts), null, 2)}

CHARACTER STATE REFS:
${JSON.stringify(compactCharacterStateRefs(characterStateRefs, prompts), null, 2)}

SCENE PROMPTS TO REVIEW:
${JSON.stringify(rows, null, 2)}

Return JSON only:
{
  "review_summary": "short summary",
  "reviewed_prompts": [
    {
      "image_id": "same",
      "scene_id": "same",
      "visual_beat_id": "same",
      "start_sec": 0,
      "duration_sec": 6,
      "image_prompt": "reviewed positive production scene prompt",
      "modelslab_image_prompt": "reviewed positive production scene prompt optimized for image model",
      "codex_image_prompt": "optional reviewed positive production scene prompt optimized for Codex/OpenAI image generation",
      "reference_requirements": [{"ref_id":"...","kind":"character_state|location|style|ui|prop|action","required":true,"slot_order":1,"slot_purpose":"character identity and wardrobe for ...","reason":"..."}],
      "required_reference_paths": [],
      "reference_usage": [],
      "anchor_roles": [],
      "shot_manifest": {
        "shot_job": "environment_establishing|body_state_proof|object_insert|interaction|physical_action|emotional_reaction|consequence|ui_reveal|transition",
        "visible_characters": ["..."],
        "mentioned_only_characters": ["..."],
        "primary_character": "...",
        "character_state_ref_ids": ["..."],
        "protagonist_state_ref_id": "...",
        "location_ref_id": "...",
        "foreground_action": "...",
        "visible_props": ["..."],
        "ui_elements": ["..."],
        "forbidden_ref_ids": ["..."],
        "continuity_notes": "...",
        "character_staging": [
          {
            "name": "...",
            "ref_id": "...",
            "screen_position": "frame-left|frame-right|center|foreground|background-left|background-right",
            "wardrobe_from": "character_state_ref:...",
            "pose": "..."
          }
        ]
      },
      "visible_subjects": [],
      "character_state_refs_used": [],
      "primary_subject": "...",
      "location": "...",
      "ui_text_on_screen": []
    }
  ],
  "findings": [
    {
      "image_id": "ep_01-cut-001",
      "scene_id": "scene_001",
      "severity": "info|warning|blocker",
      "code": "identity_blend|wrong_subject|unnecessary_ref|missing_ref|action_reversal|literalized_metaphor|wardrobe_contradiction|neighbor_context|unseen_character|negative_prompt|beauty_language_risk|named_character_duplication_risk|vague_action|scene_contradiction|reference_pose_lock|repeated_tableau|metadata_prompt|reference_layout_prompt|duplicated_reference_slot_text|contaminated_action_ref|character_attribute_bleed_risk|other",
      "message": "specific issue",
      "target_field": "optional span repair target such as people_clause",
      "resolved": true
    }
  ],
  "warnings": []
}`;
}

async function callLocal(prompt, stageName, maxTokens = null) {
  const attempts = Number(flags["visual-review-json-attempts"] ?? 3);
  let lastError = null;
  let lastContent = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const retryPrompt = attempt === 1 ? prompt : `${prompt}\n\nReturn one complete valid JSON object only. No markdown fences, commentary, trailing commas, or partial objects.`;
    const response = await fetch(localLLMChatCompletionURL(stageName), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...localLLMAuthHeaders() },
      body: JSON.stringify({
        model: getLLMModel(stageName),
        messages: [
          { role: "system", content: "Return only valid JSON. You review and fix image prompts using current-scene facts and approved visual refs. Use positive visual language only: describe what should appear, never what should be avoided." },
          { role: "user", content: retryPrompt },
        ],
        temperature: attempt === 1 ? Number(flags["llm-temperature"] ?? 0.08) : 0,
        max_tokens: Number(maxTokens ?? flags["llm-max-tokens"] ?? 16000),
      }),
      signal: AbortSignal.timeout(Number(process.env.ANIFACTORY_VISUAL_REVIEW_TIMEOUT_MS ?? 1_200_000)),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`local-qwen visual review HTTP ${response.status}: ${raw.slice(0, 1000)}`);
    const content = JSON.parse(raw)?.choices?.[0]?.message?.content ?? raw;
    lastContent = content;
    try {
      return { provider: "local-qwen", model: getLLMModel(stageName), content, parsed: extractJson(content), json_attempt: attempt };
    } catch (error) {
      lastError = error;
      console.error(`visual review ${stageName}: invalid JSON attempt ${attempt}/${attempts}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`local-qwen visual review returned invalid JSON after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}; content preview: ${lastContent.slice(0, 600)}`);
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
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`codex visual review exited ${code}: ${stderr}`)));
    child.stdin.end(prompt);
  });
  const content = await fs.readFile(outputPath, "utf8");
  return { provider: "codex", model: "codex_cli_default", output_path: outputPath, content, parsed: extractJson(content) };
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function chunkByScene(items, targetSize) {
  const chunks = [];
  let current = [];
  let currentSceneId = null;
  const splitLongScenes = flags["visual-review-chunk-split-long-scenes"] !== "false";
  for (const item of items) {
    const sceneId = item.scene_id ?? null;
    const startsNewScene = current.length && sceneId !== currentSceneId;
    const reachedTarget = current.length >= targetSize;
    if (current.length && ((startsNewScene && reachedTarget) || (!startsNewScene && splitLongScenes && reachedTarget))) {
      chunks.push(current);
      current = [];
    }
    current.push(item);
    currentSceneId = sceneId;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function normalizeReviewedPrompt(row, original) {
  const imagePrompt = String(row.image_prompt ?? row.modelslab_image_prompt ?? original.image_prompt ?? original.modelslab_image_prompt ?? "").trim();
  const modelslabPrompt = String(row.modelslab_image_prompt ?? imagePrompt).trim();
  const codexPrompt = row.codex_image_prompt
    ? String(row.codex_image_prompt).trim()
    : original.codex_image_prompt
      ? String(original.codex_image_prompt).trim()
      : null;
  return {
    ...original,
    image_id: original.image_id,
    scene_id: original.scene_id,
    visual_beat_id: original.visual_beat_id ?? row.visual_beat_id ?? null,
    visual_beat_action: original.visual_beat_action ?? row.visual_beat_action ?? null,
    visual_beat_script_excerpt: original.visual_beat_script_excerpt ?? row.visual_beat_script_excerpt ?? null,
    start_sec: Number(original.start_sec ?? 0),
    duration_sec: Math.max(1, Number(original.duration_sec ?? 6)),
    image_prompt: imagePrompt,
    modelslab_image_prompt: modelslabPrompt,
    codex_image_prompt: codexPrompt,
    prompt_hash: sha256(modelslabPrompt || imagePrompt),
    reference_requirements: Array.isArray(row.reference_requirements) ? row.reference_requirements : (original.reference_requirements ?? []),
    required_reference_paths: Array.isArray(row.required_reference_paths) ? row.required_reference_paths : (original.required_reference_paths ?? []),
    reference_usage: Array.isArray(row.reference_usage) ? row.reference_usage : (original.reference_usage ?? []),
    anchor_roles: Array.isArray(row.anchor_roles) ? row.anchor_roles : (original.anchor_roles ?? []),
    shot_manifest: sanitizeShotManifest(row.shot_manifest ?? original.shot_manifest),
    visible_subjects: Array.isArray(row.visible_subjects) ? row.visible_subjects : (original.visible_subjects ?? []),
    character_state_refs_used: Array.isArray(row.character_state_refs_used) ? row.character_state_refs_used : (original.character_state_refs_used ?? []),
    primary_subject: row.primary_subject ?? original.primary_subject ?? null,
    location: row.location ?? original.location ?? null,
    ui_text_on_screen: Array.isArray(row.ui_text_on_screen) ? row.ui_text_on_screen : (original.ui_text_on_screen ?? []),
    image_generation_required: original.image_generation_required !== false,
  };
}

function sanitizeShotManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const arrayOfStrings = (field) => Array.isArray(value[field]) ? value[field].map((item) => String(item ?? "").trim()).filter(Boolean) : [];
  return {
    shot_job: value.shot_job ? String(value.shot_job) : null,
    visible_characters: arrayOfStrings("visible_characters"),
    mentioned_only_characters: arrayOfStrings("mentioned_only_characters"),
    primary_character: value.primary_character ? String(value.primary_character) : null,
    character_state_ref_ids: arrayOfStrings("character_state_ref_ids"),
    protagonist_state_ref_id: value.protagonist_state_ref_id ? String(value.protagonist_state_ref_id) : null,
    location_ref_id: value.location_ref_id ? String(value.location_ref_id) : null,
    foreground_action: value.foreground_action ? String(value.foreground_action) : null,
    visible_props: arrayOfStrings("visible_props"),
    ui_elements: arrayOfStrings("ui_elements"),
    forbidden_ref_ids: arrayOfStrings("forbidden_ref_ids"),
    continuity_notes: value.continuity_notes ? String(value.continuity_notes) : null,
    character_staging: sanitizeCharacterStaging(value.character_staging),
  };
}

function staticPoseFindings(prompts) {
  const findings = [];
  const staticPose = /\b(?:standing|stands)\s+(?:still|straight|centered|calmly|front-facing|facing camera|with hands in pockets)\b/i;
  const actionWords = /\b(?:fight|combat|attack|horde|swarm|wolf|monster|gate|battle|rescue|lunge|strike|impact|corridor|tide|boss|collapse)\b/i;
  for (const prompt of prompts) {
    const text = String(prompt.modelslab_image_prompt ?? prompt.image_prompt ?? prompt.codex_image_prompt ?? "");
    if (staticPose.test(text) && actionWords.test(text)) {
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "warning",
        code: "reference_pose_lock",
        message: "Action-scene prompt may preserve a neutral standing reference pose; use active pose, camera angle, and changed body position in review.",
        resolved: false,
      });
    }
  }
  return findings;
}

function promptSimilarityKey(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\bcut\s+\d+\s+of\s+\d+\b/g, "")
    .replace(/\b(?:low angle close action frame|wide establishing composition|over shoulder perspective|dynamic diagonal action composition|tight emotional close frame|high angle surveillance style frame|side profile cinematic frame|foreground subject with deep background layers)\b/g, "")
    .replace(/\b\d+(?:\.\d+)?\b/g, "")
    .replace(/[^a-z0-9가-힣]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 420);
}

function repeatedTableauFindings(prompts) {
  const findings = [];
  const byScene = new Map();
  for (const prompt of prompts) {
    const sceneId = prompt.scene_id ?? "unknown";
    if (!byScene.has(sceneId)) byScene.set(sceneId, []);
    byScene.get(sceneId).push(prompt);
  }
  for (const [sceneId, rows] of byScene.entries()) {
    if (rows.length < 4) continue;
    const counts = new Map();
    for (const row of rows) {
      const key = promptSimilarityKey(row.modelslab_image_prompt ?? row.image_prompt ?? row.codex_image_prompt);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const repeated = [...counts.values()].filter((count) => count >= Math.min(4, rows.length));
    if (repeated.length) {
      findings.push({
        image_id: null,
        scene_id: sceneId,
        severity: "blocker",
        code: "repeated_tableau",
        message: `Several visual beats in ${sceneId} share the same prompt body after camera-label normalization. Rewrite prompts around each visual_beat_script_excerpt action.`,
        resolved: false,
      });
    }
  }
  return findings;
}

function scenePromptShapeFindings(prompts) {
  const findings = [];
  const badLayout = /\b(?:contact sheet|reference sheet|turnaround|character sheet|visible reference panel|reference panel layout)\b/i;
  const metadataStart = /^\s*(?:cut\s+\d+|scene\s+\d+|beat\s+\d+)/i;
  const duplicateSlotText = /\buse image (?:one|two|three|four|five|six|seven|eight) as\b/i;
  for (const prompt of prompts) {
    const text = String(prompt.modelslab_image_prompt ?? prompt.image_prompt ?? prompt.codex_image_prompt ?? "");
    if (metadataStart.test(text)) {
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "blocker",
        code: "metadata_prompt",
        message: "Scene prompt starts with cut/scene/beat metadata instead of the visible action moment.",
        resolved: false,
      });
    }
    if (badLayout.test(text)) {
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "blocker",
        code: "reference_layout_prompt",
        message: "Scene prompt requests a reference/sheet/turnaround layout for a production cut.",
        resolved: false,
      });
    }
    if (duplicateSlotText.test(text)) {
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "blocker",
        code: "duplicated_reference_slot_text",
        message: "Scene prompt body contains reference slot mapping text that the imagegen wrapper injects separately.",
        resolved: false,
      });
    }
  }
  return findings;
}

function contaminatedReferenceFindings(visualReferencePlan) {
  const findings = [];
  const contaminants = /\b(?:office|monitor|screen|control room|laboratory|soldier|operator|desk|hallway|room|camera feed)\b/i;
  for (const target of visualReferencePlan?.reference_targets ?? []) {
    if (!["action", "ui", "prop"].includes(String(target.kind ?? ""))) continue;
    const anchor = String(target.prompt_anchor ?? "");
    if (String(target.kind) === "action" && contaminants.test(anchor)) {
      findings.push({
        image_id: null,
        scene_id: (target.scene_ids ?? [null])[0],
        severity: "warning",
        code: "contaminated_action_ref",
        message: `Action/effect reference ${target.ref_id} includes full-scene/location language; action refs should isolate effect shape, color, and interaction pattern.`,
        resolved: false,
      });
    }
  }
  return findings;
}

function outOfScopeReferenceFindings(prompts, visualReferencePlan) {
  const findings = [];
  const targetsById = new Map((visualReferencePlan?.reference_targets ?? []).map((target) => [target.ref_id, target]));
  const scopedKinds = new Set(["location", "prop", "ui", "action"]);
  for (const prompt of prompts) {
    const refIds = new Set();
    if (prompt.shot_manifest?.location_ref_id) refIds.add(prompt.shot_manifest.location_ref_id);
    for (const req of prompt.reference_requirements ?? []) if (req?.ref_id) refIds.add(req.ref_id);
    for (const refId of refIds) {
      const target = targetsById.get(refId);
      if (!target || !scopedKinds.has(String(target.kind ?? ""))) continue;
      if (sceneIdsCover(target.scene_ids, prompt.scene_id)) continue;
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "blocker",
        code: "out_of_scope_reference",
        message: `Reference ${refId} is a ${target.kind} ref scoped to ${(target.scene_ids ?? []).join(", ") || "unscoped"} but is attached to ${prompt.scene_id}. Remove the ref and rewrite the visible moment from the current beat location/action.`,
        resolved: false,
      });
    }
  }
  return findings;
}

function normalizePreImagegenFindings(findings) {
  return findings.map((finding) => {
    if (!finding || finding.severity !== "blocker" || finding.resolved === true) return finding;
    const code = String(finding.code ?? "");
    const message = String(finding.message ?? "");
    const isNoInScopeLocationRef =
      code === "missing_ref"
      && /no in[- ]scope .*location reference exists|no approved .*location ref(?:erence)? exists|only approved .*location reference is out of scope/i.test(message);
    if (isNoInScopeLocationRef) {
      return {
        ...finding,
        severity: "warning",
        resolved: true,
        no_in_scope_location_ref: true,
        message: `${message} Proceeding with concrete generic location staging because no approved in-scope location reference exists for this beat.`,
      };
    }
    const isDeferredReferencePath =
      code === "missing_ref"
      && /(?:null|unresolved|not[- ]yet[- ]generated|no resolved|has no resolved|missing) reference(?:_|\s)image(?:_|\s)path|reference(?:_|\s)image(?:_|\s)path (?:is )?(?:null|unresolved|not generated)|image path (?:is )?(?:null|unresolved|not generated)/i.test(message);
    if (!isDeferredReferencePath) return finding;
    return {
      ...finding,
      severity: "warning",
      resolved: true,
      pre_imagegen_deferred: true,
      message: `${message} Deferred to the reference-generation/imagegen stage because this review pass runs before reference image files are created.`,
    };
  });
}

function unresolvedBlockerFindings(findings) {
  return (findings ?? []).filter((finding) => finding?.severity === "blocker" && finding.resolved !== true);
}

function sceneIdsFromBlockers(blockers) {
  return [...new Set(blockers.map((finding) => String(finding.scene_id ?? "").trim()).filter(Boolean))];
}

function positiveCorrectionDirective(finding) {
  const code = String(finding?.code ?? "visual_blocker");
  let directive = "Create a concrete current-beat image from the beat excerpt, with visible subjects, action, props, UI, and approved refs aligned to this scene candidate set.";
  if (/location|scope|ref/i.test(code)) {
    directive = "Stage the cut inside the in-scope location reference for this scene. Describe that location's visible architecture, materials, lighting, surfaces, and spatial layout.";
  } else if (/repeat|tableau|static/i.test(code)) {
    directive = "Create a distinct shot job for this beat with a new camera distance, foreground action, subject pose, and visible consequence from the beat excerpt.";
  } else if (/reference|missing/i.test(code)) {
    directive = "Attach approved refs from this scene candidate set for physically visible subjects and setting, then describe the beat with concrete visible action.";
  }
  return {
    scene_id: finding.scene_id ?? null,
    code,
    directive,
  };
}

function mergeScenePrompts(basePrompts, replacementPrompts, sceneIds) {
  const sceneSet = new Set(sceneIds);
  const replacementsById = new Map((replacementPrompts ?? []).map((prompt) => [prompt.image_id, prompt]));
  return (basePrompts ?? []).map((prompt) => {
    if (!sceneSet.has(prompt.scene_id)) return prompt;
    return replacementsById.get(prompt.image_id) ?? prompt;
  });
}

async function autoResolveBlockedReview({ reviewedPlan, reviewReport }) {
  let currentPlan = reviewedPlan;
  let currentReport = reviewReport;
  const iterations = [];
  let blockers = unresolvedBlockerFindings(currentReport.findings);
  for (let iteration = 1; iteration <= maxResolveIterations && blockers.length; iteration += 1) {
    const sceneIds = sceneIdsFromBlockers(blockers);
    if (!sceneIds.length) break;
    const iterationDir = path.join(episodeDir, "_visual_resolution");
    const correctionPath = path.join(iterationDir, `correction_directives_${episode}_iter_${iteration}.json`);
    const planPath = path.join(iterationDir, `section_image_prompts_resolve_${episode}_iter_${iteration}.json`);
    const reviewedPath = path.join(iterationDir, `section_image_prompts_resolve_reviewed_${episode}_iter_${iteration}.json`);
    const reportPath = path.join(iterationDir, `visual_prompt_review_resolve_${episode}_iter_${iteration}.json`);
    const correctionDirectives = blockers
      .filter((finding) => sceneIds.includes(finding.scene_id))
      .map(positiveCorrectionDirective);
    await writeJson(correctionPath, {
      schema: "goldflow_visual_resolution_directives_v1",
      status: "passed",
      iteration,
      scene_ids: sceneIds,
      correction_directives: correctionDirectives,
      source_findings: blockers.filter((finding) => sceneIds.includes(finding.scene_id)),
      updated_at: new Date().toISOString(),
    });
    await runNodeScript("visual-plan.mjs", [
      "--channel", channel,
      "--series", series,
      "--week", week,
      "--episode", episode,
      "--only-scenes", sceneIds.join(","),
      "--correction-findings", correctionPath,
      "--output", planPath,
    ]);
    let iterationStatus = "failed";
    let iterationReport = null;
    let iterationPlan = null;
    try {
      await runNodeScript("visual-prompt-review.mjs", [
        "--channel", channel,
        "--series", series,
        "--week", week,
        "--episode", episode,
        "--prompts", planPath,
        "--output", reviewedPath,
        "--review-output", reportPath,
        "--auto-resolve", "false",
      ]);
    } catch {
      // The review script intentionally exits non-zero for blocked review output.
    }
    iterationReport = await readJson(reportPath, null);
    iterationPlan = await readJson(reviewedPath, null);
    iterationStatus = iterationReport?.status ?? "failed";
    iterations.push({ iteration, scene_ids: sceneIds, status: iterationStatus, plan_path: planPath, reviewed_path: reviewedPath, review_report_path: reportPath });
    if (iterationStatus === "passed" && iterationPlan?.prompts?.length) {
      currentPlan = {
        ...currentPlan,
        status: "passed",
        prompts: mergeScenePrompts(currentPlan.prompts, iterationPlan.prompts, sceneIds),
        visual_resolution_iterations: iterations,
        updated_at: new Date().toISOString(),
      };
      currentReport = {
        ...currentReport,
        status: "passed",
        findings: (currentReport.findings ?? []).filter((finding) => !sceneIds.includes(finding.scene_id) || finding.severity !== "blocker"),
        unresolved_blocker_count: 0,
        visual_resolution_iterations: iterations,
        reviewed_prompt_count: currentPlan.prompts.length,
        updated_at: currentPlan.updated_at,
      };
      blockers = [];
      break;
    }
    blockers = unresolvedBlockerFindings(iterationReport?.findings ?? blockers);
  }
  if (blockers.length) {
    const sceneIds = sceneIdsFromBlockers(blockers);
    const deadletter = {
      schema: "goldflow_visual_resolution_deadletter_v1",
      status: "blocked_deadletter",
      channel,
      series_slug: series,
      week,
      episode,
      scene_ids: sceneIds,
      unresolved_blockers: blockers,
      last_prompts: (currentPlan.prompts ?? []).filter((prompt) => sceneIds.includes(prompt.scene_id)),
      visual_resolution_iterations: iterations,
      updated_at: new Date().toISOString(),
    };
    await writeJson(deadletterPath, deadletter);
    currentPlan = { ...currentPlan, status: "blocked_deadletter", visual_resolution_deadletter_path: deadletterPath, visual_resolution_iterations: iterations, updated_at: deadletter.updated_at };
    currentReport = { ...currentReport, status: "blocked_deadletter", unresolved_blocker_count: blockers.length, visual_resolution_deadletter_path: deadletterPath, visual_resolution_iterations: iterations, updated_at: deadletter.updated_at };
  }
  return { reviewedPlan: currentPlan, reviewReport: currentReport };
}

async function validateReferencePaths(prompts) {
  const findings = [];
  for (const prompt of prompts) {
    for (const refPath of [...new Set((prompt.required_reference_paths ?? []).filter(Boolean))]) {
      if (!(await exists(refPath))) {
        findings.push({
          image_id: prompt.image_id,
          scene_id: prompt.scene_id,
          severity: "blocker",
          code: "missing_ref",
          message: `Required reference path does not exist: ${refPath}`,
          resolved: false,
        });
      }
    }
  }
  return findings;
}

function assertReviewedPrompts(originalPrompts, reviewedPrompts, timedPlan) {
  if (reviewedPrompts.length !== originalPrompts.length) throw new Error(`Visual review returned ${reviewedPrompts.length} prompts for ${originalPrompts.length} input prompts.`);
  const timedSceneIds = new Set((timedPlan.scenes ?? []).map((scene) => scene.scene_id));
  for (let index = 0; index < originalPrompts.length; index += 1) {
    const original = originalPrompts[index];
    const reviewed = reviewedPrompts[index];
    if (reviewed.image_id !== original.image_id) throw new Error(`Visual review changed image_id at index ${index}: ${original.image_id} -> ${reviewed.image_id}`);
    if (reviewed.scene_id !== original.scene_id) throw new Error(`Visual review changed scene_id for ${original.image_id}: ${original.scene_id} -> ${reviewed.scene_id}`);
    if ((original.visual_beat_id ?? null) !== (reviewed.visual_beat_id ?? null)) throw new Error(`Visual review changed visual_beat_id for ${original.image_id}: ${original.visual_beat_id} -> ${reviewed.visual_beat_id}`);
    if (!timedSceneIds.has(reviewed.scene_id)) throw new Error(`Visual review produced unknown scene_id ${reviewed.scene_id} for ${reviewed.image_id}`);
    if (!reviewed.modelslab_image_prompt) throw new Error(`Visual review produced empty prompt for ${reviewed.image_id}`);
  }
}

async function reviewChunk({ promptPlan, timedPlan, visualReferencePlan, characterStateRefs, prompts, chunkIndex = null, attemptIndex = 1 }) {
  const baseStageName = chunkIndex === null
    ? `${episode}_visual_review`
    : `${episode}_visual_review_chunk_${String(chunkIndex + 1).padStart(2, "0")}`;
  const stageName = attemptIndex > 1 ? `${baseStageName}_attempt_${attemptIndex}` : baseStageName;
  const prompt = buildPrompt({ promptPlan, timedPlan, visualReferencePlan, characterStateRefs, prompts });
  return isLocalLLMRoute(stageName)
    ? callLocal(prompt, stageName, Number(flags["visual-review-chunk-max-tokens"] ?? 9000))
    : callCodex(prompt, stageName);
}

async function runPool(items, worker, limit) {
  const results = [];
  let cursor = 0;
  async function next() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, next));
  return results;
}

async function main() {
  const [promptPlan, timedPlan, visualReferencePlan, characterStateRefs] = await Promise.all([
    readJson(promptPath, null),
    readJson(timedPlanPath, null),
    readJson(visualReferencePlanPath, null),
    readJson(characterStateRefsPath, null),
  ]);
  if (promptPlan?.status !== "passed" || !Array.isArray(promptPlan.prompts) || !promptPlan.prompts.length) throw new Error(`Missing passed visual prompt plan: ${promptPath}`);
  if (timedPlan?.status !== "passed" || !Array.isArray(timedPlan.scenes) || !timedPlan.scenes.length) throw new Error(`Missing passed timed scene plan: ${timedPlanPath}`);
  if (promptPlan.source_script_hash !== timedPlan.source_script_hash) throw new Error("section_image_prompts and timed_scene_plan script hashes do not match.");
  if (visualReferencePlan?.status !== "passed") throw new Error(`Missing passed visual reference plan: ${visualReferencePlanPath}`);
  if (!["approved", "passed"].includes(characterStateRefs?.status) && flags["allow-draft-refs"] !== "true") {
    throw new Error(`character_state_refs must be approved before visual review. Current status: ${characterStateRefs?.status ?? "missing"}. Use --allow-draft-refs true only for diagnostics.`);
  }

  const useChunking = flags["visual-review-chunking"] !== "false"
    && promptPlan.prompts.length > Number(flags["visual-review-single-call-max-scenes"] ?? 10);
  const chunks = useChunking ? chunkByScene(promptPlan.prompts, Number(flags["visual-review-chunk-scenes"] ?? 6)) : [promptPlan.prompts];
  const reviewedRows = [];
  const findings = [];
  const warnings = [];
  const reviewConcurrency = Math.max(1, Math.min(12, Number(flags["visual-review-concurrency"] ?? process.env.ANIFACTORY_VISUAL_REVIEW_CONCURRENCY ?? 6)));
  const planner = { provider: isLocalLLMRoute(`${episode}_visual_review`) ? "local-qwen" : "codex", model: isLocalLLMRoute(`${episode}_visual_review`) ? getLLMModel(`${episode}_visual_review`) : "codex_cli_default", chunked: useChunking, chunk_count: chunks.length, concurrency: reviewConcurrency };

  const chunkResults = await runPool(chunks, async (chunk, index) => {
    if (useChunking) console.error(`visual review chunk ${index + 1}/${chunks.length}: ${chunk.length} prompts`);
    const maxAttempts = Math.max(1, Number(flags["visual-review-chunk-attempts"] ?? 3));
    let lastCount = null;
    let lastError = null;
    for (let attemptIndex = 1; attemptIndex <= maxAttempts; attemptIndex += 1) {
      let llm = null;
      try {
        llm = await reviewChunk({ promptPlan, timedPlan, visualReferencePlan, characterStateRefs, prompts: chunk, chunkIndex: useChunking ? index : null, attemptIndex });
      } catch (error) {
        lastError = error;
        if (attemptIndex < maxAttempts) {
          console.error(`visual review chunk ${index + 1}/${chunks.length}: retrying after provider error (attempt ${attemptIndex}/${maxAttempts}): ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        throw error;
      }
      const chunkReviewed = Array.isArray(llm.parsed.reviewed_prompts) ? llm.parsed.reviewed_prompts : [];
      lastCount = chunkReviewed.length;
      if (chunkReviewed.length === chunk.length) {
        return {
          reviewed_prompts: chunkReviewed,
          findings: Array.isArray(llm.parsed.findings) ? llm.parsed.findings : [],
          warnings: Array.isArray(llm.parsed.warnings) ? llm.parsed.warnings : [],
        };
      }
      if (attemptIndex < maxAttempts) {
        console.error(`visual review chunk ${index + 1}/${chunks.length}: retrying after ${chunkReviewed.length} prompts for ${chunk.length} inputs (attempt ${attemptIndex}/${maxAttempts})`);
      }
    }
    throw new Error(`Visual review chunk ${index + 1}/${chunks.length} returned ${lastCount ?? 0} prompts for ${chunk.length} inputs after ${maxAttempts} attempts${lastError ? `; last provider error: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ""}.`);
  }, reviewConcurrency);

  for (const chunkResult of chunkResults) {
    reviewedRows.push(...chunkResult.reviewed_prompts);
    findings.push(...chunkResult.findings);
    warnings.push(...chunkResult.warnings);
  }

  const reviewedPrompts = reviewedRows.map((row, index) => normalizeReviewedPrompt(row, promptPlan.prompts[index]));
  assertReviewedPrompts(promptPlan.prompts, reviewedPrompts, timedPlan);
  findings.push(...negativePromptFindings(reviewedPrompts));
  findings.push(...beautyLanguageFindings(reviewedPrompts));
  findings.push(...namedCharacterDuplicationFindings(reviewedPrompts));
  findings.push(...scenePromptShapeFindings(reviewedPrompts));
  findings.push(...staticPoseFindings(reviewedPrompts));
  findings.push(...repeatedTableauFindings(reviewedPrompts));
  findings.push(...reviewedPrompts.flatMap((prompt) => multiCharacterBleedFindings(prompt, characterStateRefs)));
  findings.push(...contaminatedReferenceFindings(visualReferencePlan));
  findings.push(...outOfScopeReferenceFindings(reviewedPrompts, visualReferencePlan));
  findings.push(...await validateReferencePaths(reviewedPrompts));
  const normalizedFindings = normalizePreImagegenFindings(findings);
  findings.length = 0;
  findings.push(...normalizedFindings);
  const unresolvedBlockers = unresolvedBlockerFindings(findings);
  const status = unresolvedBlockers.length ? "blocked" : "passed";
  const sourcePaths = [promptPath, timedPlanPath, visualReferencePlanPath, characterStateRefsPath];
  const sourceHashes = Object.fromEntries((await Promise.all(sourcePaths.map(async (filePath) => [filePath, await hashFile(filePath)]))).filter(([, hash]) => hash));
  const reviewedPlan = {
    ...promptPlan,
    schema: "goldflow_section_image_prompts_v1",
    status,
    source_artifact_paths: sourcePaths,
    source_hashes: sourceHashes,
    planner: {
      ...promptPlan.planner,
      visual_review: planner,
    },
    prompt_policy: "LLM-authored prompts with LLM review/fix pass; code gates validate shape, IDs, hashes, and missing references only",
    prompts: reviewedPrompts,
    visual_review_report_path: reviewReportPath,
    updated_at: new Date().toISOString(),
  };
  const reviewReport = {
    schema: "goldflow_visual_prompt_review_v1",
    status,
    channel,
    series_slug: series,
    week,
    episode,
    source_script_hash: promptPlan.source_script_hash,
    source_artifact_paths: sourcePaths,
    source_hashes: sourceHashes,
    planner,
    input_prompt_count: promptPlan.prompts.length,
    reviewed_prompt_count: reviewedPrompts.length,
    findings,
    warnings,
    unresolved_blocker_count: unresolvedBlockers.length,
    reviewed_prompt_plan_path: outputPath,
    updated_at: reviewedPlan.updated_at,
  };
  let finalReviewedPlan = reviewedPlan;
  let finalReviewReport = reviewReport;
  if (autoResolveEnabled && status === "blocked") {
    const resolved = await autoResolveBlockedReview({ reviewedPlan, reviewReport });
    finalReviewedPlan = resolved.reviewedPlan;
    finalReviewReport = resolved.reviewReport;
  }
  await writeJson(outputPath, finalReviewedPlan);
  await writeJson(reviewReportPath, finalReviewReport);
  console.log(JSON.stringify({ status: finalReviewReport.status, output_path: outputPath, review_report_path: reviewReportPath, prompt_count: finalReviewedPlan.prompts?.length ?? reviewedPrompts.length, unresolved_blocker_count: finalReviewReport.unresolved_blocker_count ?? unresolvedBlockers.length }, null, 2));
  if (finalReviewReport.status !== "passed") process.exitCode = 1;
}

main().catch(async (error) => {
  const failed = { schema: "goldflow_visual_prompt_review_v1", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() };
  await writeJson(reviewReportPath, failed).catch(() => {});
  await writeJson(outputPath, { schema: "goldflow_section_image_prompts_v1", status: "failed", error: failed.error, updated_at: failed.updated_at }).catch(() => {});
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
