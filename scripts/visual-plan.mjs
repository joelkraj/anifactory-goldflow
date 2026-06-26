#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getLLMModel, isLocalLLMRoute, localLLMAuthHeaders, localLLMChatCompletionURL } from "./lib/llm-router.mjs";
import {
  allowedRefIdsForScene,
  dropOutOfScopePromptRefs,
  referenceTargetsForScene,
} from "./lib/visual-scope-utils.mjs";

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
const correctionFindingsPath = flags["correction-findings"] ?? flags.correctionFindings ?? null;
const promptMaxChars = Number(flags["visual-prompt-max-chars"] ?? process.env.ANIFACTORY_VISUAL_PLAN_MAX_PROMPT_CHARS ?? 900_000);

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

function sanitizePromptLanguage(prompt) {
  const next = { ...prompt };
  next.modelslab_image_prompt = sanitizePositiveVisualPrompt(next.modelslab_image_prompt ?? next.image_prompt ?? "");
  next.image_prompt = sanitizePositiveVisualPrompt(next.image_prompt ?? next.modelslab_image_prompt ?? "");
  return next;
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

function scenePromptAnchorFromRef(ref) {
  if (ref?.scene_prompt_anchor) return ref.scene_prompt_anchor;
  return String(ref?.prompt_anchor ?? "")
    .replace(/\bidentity sheet,\s*/gi, "")
    .replace(/\bfront view,\s*three-quarter view,\s*side profile,\s*expression closeups,\s*/gi, "")
    .replace(/\bplain white studio background,\s*/gi, "")
    .replace(/\bcharacter design turnaround only\b/gi, "")
    .replace(/\bcharacter turnaround reference sheet composition\b/gi, "")
    .replace(/\breference sheet composition\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*$/g, "")
    .trim();
}

function truncateText(value, max = 900) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max).trim()}...` : text;
}

function compactList(values, maxItems = 6, maxChars = 180) {
  return (Array.isArray(values) ? values : [])
    .slice(0, maxItems)
    .map((value) => typeof value === "string" ? truncateText(value, maxChars) : value);
}

function compactSceneCharacterRef(ref) {
  return {
    state_ref_id: ref.state_ref_id ?? null,
    source_ref_id: ref.source_ref_id ?? null,
    base_identity_ref_id: ref.base_identity_ref_id ?? null,
    identity_usage: ref.identity_usage ?? null,
    character: ref.character ?? null,
    scene_ids: ref.scene_ids ?? [],
    scene_prompt_anchor: truncateText(scenePromptAnchorFromRef(ref), 900),
    reference_image_path: ref.reference_image_path ?? null,
  };
}

function compactSceneForPrompt(scene, stateRefIndex = new Map()) {
  const absoluteIndex = Number.isFinite(Number(scene.__visual_plan_absolute_index))
    ? Number(scene.__visual_plan_absolute_index)
    : null;
  return {
    target_image_id: absoluteIndex == null ? null : `${episode}-cut-${String(absoluteIndex + 1).padStart(3, "0")}`,
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
    end_sec: scene.end_sec,
    duration_sec: scene.duration_sec,
    location: scene.location,
    time: scene.time,
    visible_subjects: scene.visible_subjects ?? [],
    primary_subject: scene.primary_subject ?? null,
    visual_intent: truncateText(scene.visual_intent ?? "", 360),
    character_state_refs: sceneCharacterStateRefs(scene, stateRefIndex).map(compactSceneCharacterRef),
    ui_text_on_screen: scene.ui_text_on_screen ?? [],
    character_states: compactList(scene.character_states ?? [], 4),
    wardrobe: scene.wardrobe ?? null,
    props: compactList(scene.props ?? [], 8),
    action_staging: truncateText(scene.action_staging ?? "", 500),
    continuity_notes: compactList(scene.continuity_notes ?? [], 4, 220),
  };
}

function compactNeighborContext(scene) {
  if (!scene) return null;
  return {
    visual_beat_id: scene.visual_beat_id ?? null,
    parent_scene_id: scene.parent_scene_id ?? scene.scene_id,
    beat_index: scene.beat_index ?? null,
    visual_beat_focus: scene.visual_beat_focus ?? null,
    visual_beat_action: scene.visual_beat_action ?? null,
    visual_beat_script_excerpt: scene.visual_beat_script_excerpt ?? null,
    location: scene.location ?? null,
    visible_subjects: scene.visible_subjects ?? [],
    primary_subject: scene.primary_subject ?? null,
  };
}

function relevantReferenceTargets(scene, visualReferencePlan) {
  return referenceTargetsForScene(scene, visualReferencePlan).map(compactReferenceTarget);
}

function compactReferenceTarget(target) {
  return {
    ref_id: target.ref_id ?? null,
    kind: target.kind ?? null,
    subject: target.subject ?? null,
    scene_ids: target.scene_ids ?? [],
    priority: target.priority ?? null,
    generation_mode: target.generation_mode ?? null,
    required_before_imagegen: target.required_before_imagegen ?? null,
    reference_image_path: target.reference_image_path ?? null,
    resolved_reference_image_path: target.resolved_reference_image_path ?? null,
    reference_exists: target.reference_exists ?? null,
    prompt_anchor: truncateText(target.scene_prompt_anchor ?? target.prompt_anchor ?? "", 900),
    anchor_cut_policy: target.anchor_cut_policy ?? null,
    risk_notes: compactList(target.risk_notes ?? [], 4, 220),
  };
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

function buildPrompt(timedPlan, semanticPlan, visualReferencePlan = null, stateRefIndex = new Map(), visualBeatPlan = null, correctionDirectives = []) {
  const sourceRows = visualBeatPlan?.status === "passed" && Array.isArray(visualBeatPlan.beats) && visualBeatPlan.beats.length
    ? visualBeatPlan.beats
    : timedPlan.scenes;
  const referenceTargetsByScene = {};
  for (const scene of sourceRows ?? []) {
    const sceneId = scene.parent_scene_id ?? scene.scene_id;
    if (!sceneId || referenceTargetsByScene[sceneId]) continue;
    referenceTargetsByScene[sceneId] = relevantReferenceTargets(scene, visualReferencePlan);
  }
  const compactTimedPlan = {
    source_script_hash: timedPlan.source_script_hash,
    scene_count: sourceRows?.length ?? 0,
    source_unit: visualBeatPlan ? "visual_beats" : "timed_scenes",
    parent_scene_count: timedPlan.scenes?.length ?? 0,
    timing_source: timedPlan.timing_source,
    visual_reference_plan_status: visualReferencePlan?.status ?? null,
    scenes: (sourceRows ?? []).map((scene, index, rows) => ({
      ...compactSceneForPrompt(scene, stateRefIndex),
      previous_beat_context: compactNeighborContext(rows[index - 1]),
      next_beat_context: compactNeighborContext(rows[index + 1]),
      reference_target_ids: (referenceTargetsByScene[scene.parent_scene_id ?? scene.scene_id] ?? []).map((target) => target.ref_id),
    })),
    reference_targets_by_scene: referenceTargetsByScene,
    correction_directives: correctionDirectives,
  };
  const compactSemanticPlan = {
    episode_summary: semanticPlan.episode_summary ?? "",
    global_reference_requirements: semanticPlan.global_reference_requirements ?? [],
    style_summary: semanticPlan.style_summary ?? "",
    warnings: semanticPlan.warnings ?? [],
  };
  return `Author production image prompts from the timed semantic scene plan.

Rules:
- You are the creative visual author. The downstream deterministic pass only sanitizes approved ref IDs, paths, forbidden refs, and the four-reference cap; it will not creatively infer missing locations, add characters, rewrite action, choose shot jobs, or fix narrative intent.
- Use current scene only. Do not import neighboring scene characters, injuries, locations, props, or UI.
- Positive visual language is mandatory. Describe only what should appear.
- Do not use negative prompt clauses or mitigation phrasing such as "no", "not", "without", "avoid", "exclude", "instead of", or "rather than".
- Translate source text that contains negative wording into positive visual wording. Use "windowless room" for "no windows", "single visible subject" for absent extra characters, and "plain open-collar garment" for unwanted formalwear risk.
- Convert risks into positive construction: exact visible subject count, role, pose, action direction, wardrobe construction, frame composition, and location details.
- For single-character shots, state the visible subject positively, such as "one named character alone in frame" rather than naming absent characters.
- Identify exact subject roles by name and action, especially in multi-character scenes.
- For visual beats, use visual_beat_focus to change camera angle, pose, action moment, and composition across beats in the same parent scene.
- For visual beats, visual_beat_script_excerpt and visual_beat_action are the main source for the image. Each cut must show the specific moment in that beat excerpt, not a repeated hero portrait with the whole scene summarized behind the character.
- Across beats in the same parent scene, vary the visible action progression: establish, object/UI close-up, character interaction, impact, reaction, consequence, and transition as appropriate to the beat excerpt.
- A prompt may use a calm foreground character only when the beat excerpt itself is about stillness, calculation, realization, or a character reveal.
- Author the shot_manifest before writing the prose prompt. Treat it as the contract for the cut: physically visible characters, mentioned-only characters, location ref, character state refs, foreground action, shot job, props/UI, and forbidden refs.
- The prose prompt and reference_requirements must obey shot_manifest. If a character is mentioned_only, do not attach that character reference and do not stage that person physically. If a ref_id is in forbidden_ref_ids, do not attach it. If the cut physically occurs in a real environment such as an apartment, gym, office, street, shop, corridor, boardroom, lobby, stage, or courthouse area, choose the closest approved location ref from reference_targets_by_scene, set shot_manifest.location_ref_id, and attach that location ref unless all four slots are needed for visible characters. If location_ref_id is set, the prose prompt must describe that visible location.
- Every input unit includes target_image_id. Copy target_image_id exactly into output image_id. Do not restart image_id numbering inside chunks, and do not invent sequential IDs from the schema example.
- Parent scene context explains why the beat matters, but visual_beat_script_excerpt decides what appears. Do not include future reveals, earlier setup, or the whole confrontation unless the current beat excerpt physically shows them.
- previous_beat_context and next_beat_context are sequencing aids only. Use them to avoid repeated shots and to choose progression, but do not import their characters, props, locations, or reveals into the current cut unless the current visual_beat_script_excerpt also includes them.
- For transformation arcs, use one base identity face anchor only when the approved reference metadata says identity_usage is face_only; current state wording controls body, hair, shave/facial hair, wardrobe, posture, cleanliness, and social status.
- modelslab_image_prompt should be a polished image-generation prompt, not a metadata summary. Do not start with "Cut 001", "scene", "beat", or title bookkeeping.
- Start each prompt with the concrete visible moment, subject, action, and location from visual_beat_script_excerpt.
- Every prompt in the same parent scene should have a different visual job. Prefer concrete shot jobs such as environment establishment, object insert, hand/action close-up, over-shoulder confrontation, impact frame, crowd reaction, UI reveal, aftermath, or transition.
- If the beat excerpt mentions a hand, object, UI line, shove, strike, gate, orb, phone, counter, or expression change, make that element the visible focus for that cut.
- When shot_manifest.location_ref_id is set, describe that reference's visible architecture, materials, lighting, surfaces, and spatial layout as the physical setting for the current beat.
- Use one continuous full-frame composition by default. Intentional manga panel or split-screen layouts are allowed for montage beats, memory fragments, reaction stacks, parallel action, or UI-heavy reveals when they serve the beat.
- UI text policy for image generation: request clean holographic panels, gauges, icons, simple labels, and at most one short large number or word when visually essential. Put exact multi-line system text, captions, lists, and long labels in ui_text_on_screen for render/subtitle overlay instead of asking the image model to draw dense readable text.
- If a mission/UI label contains negative words, put the exact wording in ui_text_on_screen and use positive visual substitutes in modelslab_image_prompt, such as "contact-silence streak badge", "stand-firm mission card", "message restraint checklist", or "upstairs restraint icon".
- Scene cuts must not request contact sheets, reference panels, character sheets, turnarounds, or visible reference-image layouts.
- Character references are identity and wardrobe evidence. Use them to match face, hair, age, body type, and outfit while placing the character in the new pose/action required by this beat.
- Location references are environment evidence. Use them for setting, architecture, lighting, and materials.
- Action/effect references are visual language evidence. Use them for power shape, energy color, and interaction pattern while keeping the beat's current location and subjects.
- Put reference slot roles in reference_requirements.slot_purpose and slot_order. The imagegen wrapper will prepend Flux context instructions such as "Use image one as character identity for Kang Jiwoo" at generation time.
- Keep modelslab_image_prompt as a production scene description. Reference images guide identity, wardrobe, style, UI, props, and effects; they are design evidence for the final cut, not visible reference panels.
- Character state refs are definitive when present. For every visible named character with a character_state_refs.scene_prompt_anchor, copy that scene_prompt_anchor into the prompt rather than inventing or paraphrasing wardrobe. Use prompt_anchor only for generating reference images, not inside scene prompts.
- If semantic wardrobe conflicts with character_state_refs, character_state_refs wins.
- If no character_state_refs are provided for a visible character, do not create a definitive anchor. Keep wording limited to current-scene facts and add a warning requesting missing character state ref coverage.
- If a scene needs references, list them as reference_requirements only; do not pretend missing refs exist or define new canonical refs in this stage.
- For each cut, include only references that are visible or style-critical, with at most four reference_requirements total.
- Attach only necessary references. Use no more than four refs; fewer is better when the cut remains clear. Do not attach refs for people, locations, props, or UI that are only mentioned, remembered, texted, called, or implied.
- Reference priority is strict: visible character_state refs first, then location, then prop or UI, then action or effects, then style.
- Attach style only when the cut has zero concrete character, location, prop, UI, or action references.
- When more than four concrete references could apply, keep the highest-priority four and report dropped lower-priority refs in reference_usage as available_not_attached_reference_limit.
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

SCENE CORRECTION DIRECTIVES:
${JSON.stringify(correctionDirectives, null, 2)}

Return JSON only:
{
  "style_summary": "...",
  "prompts": [
    {
      "image_id": "<copy target_image_id exactly>",
      "scene_id": "scene_001",
      "visual_beat_id": "scene_001_beat_01",
      "start_sec": 0,
      "duration_sec": 6,
      "image_prompt": "positive production scene prompt only",
      "modelslab_image_prompt": "positive production scene prompt optimized for flux-klein",
      "reference_requirements": [{"ref_id":"style_ref","kind":"style","required":true,"slot_order":1,"slot_purpose":"anime manhwa style language","reason":"..."}],
      "required_reference_paths": [],
      "reference_usage": [{"ref_id":"...","usage":"attach_existing_ref|derive_from_cut|no_ref_needed|missing_reference_coverage","reason":"..."}],
      "anchor_roles": [{"ref_id":"...","kind":"character_state|location|prop|ui|action","anchor_role":"source_anchor","reason":"..."}],
      "shot_manifest": {
        "shot_job": "environment_establishing|body_state_proof|object_insert|interaction|physical_action|emotional_reaction|consequence|ui_reveal|transition",
        "visible_characters": ["Joey Mercer"],
        "mentioned_only_characters": ["Vivian"],
        "primary_character": "Joey Mercer",
        "character_state_ref_ids": ["joey_overweight_ref"],
        "protagonist_state_ref_id": "joey_overweight_ref",
        "location_ref_id": "blackwell_lobby_elevator_ref",
        "foreground_action": "Joey holds a Thai takeout bag alone in the elevator corridor",
        "visible_props": ["Thai takeout bag"],
        "ui_elements": [],
        "forbidden_ref_ids": ["vivian_ref", "preston_ref"],
        "continuity_notes": "one present-tense moment from the current beat excerpt"
      },
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
  assertPromptSize(prompt, stageName);
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

async function callCodex(prompt, stageName, expectedBeatIds = null) {
  assertPromptSize(prompt, stageName);
  const callDir = path.join(weekDir, "_codex_calls");
  await fs.mkdir(callDir, { recursive: true });
  if (flags["codex-reuse-latest"] === "true" || flags["codex-reuse-cache"] === "true") {
    const cached = await findLatestCodexOutput(callDir, stageName, expectedBeatIds);
    if (cached) return cached;
    console.error(`visual ${stageName}: no reusable cached Codex output found; calling Codex`);
  }
  const attempts = Math.max(1, Number(flags["codex-call-attempts"] ?? 2));
  const timeoutMs = Math.max(30_000, Number(flags["codex-call-timeout-ms"] ?? 8 * 60_000));
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const outputPath = path.join(callDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${stageName}-attempt_${attempt}-output.txt`);
    try {
      await new Promise((resolve, reject) => {
        const child = spawn("codex", ["exec", "--ephemeral", "--skip-git-repo-check", "-C", repoRoot, "-o", outputPath], { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
        let stderr = "";
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
          reject(new Error(`codex visual plan timed out after ${timeoutMs}ms for ${stageName} attempt ${attempt}`));
        }, timeoutMs);
        timer.unref();
        child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("exit", (code) => {
          clearTimeout(timer);
          code === 0 ? resolve() : reject(new Error(`codex visual plan exited ${code}: ${stderr}`));
        });
        child.stdin.end(prompt);
      });
      const content = await fs.readFile(outputPath, "utf8");
      return { provider: "codex", model: "codex_cli_default", output_path: outputPath, content, parsed: extractJson(content) };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) console.error(`visual ${stageName}: retrying after ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw lastError ?? new Error(`codex visual plan failed for ${stageName}`);
}

async function findLatestCodexOutput(callDir, stageName, expectedBeatIds = null) {
  let entries = [];
  try {
    entries = await fs.readdir(callDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const safeStageName = stageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${safeStageName}(?:-attempt_\\d+)?-output\\.txt$`);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    const outputPath = path.join(callDir, entry.name);
    try {
      const stat = await fs.stat(outputPath);
      candidates.push({ outputPath, mtimeMs: stat.mtimeMs });
    } catch {}
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const candidate of candidates) {
    try {
      const content = await fs.readFile(candidate.outputPath, "utf8");
      const parsed = extractJson(content);
      if (Array.isArray(parsed.prompts) && parsed.prompts.length) {
        if (Array.isArray(expectedBeatIds) && expectedBeatIds.length) {
          const actualBeatIds = parsed.prompts.map((prompt) => String(prompt.visual_beat_id ?? "")).filter(Boolean);
          if (actualBeatIds.length !== expectedBeatIds.length) continue;
          if (!expectedBeatIds.every((beatId, index) => actualBeatIds[index] === beatId)) continue;
        }
        console.error(`visual ${stageName}: reused cached Codex output ${candidate.outputPath}`);
        return { provider: "codex-cache", model: "codex_cli_default", output_path: candidate.outputPath, content, parsed };
      }
    } catch {}
  }
  return null;
}

function assertPromptSize(prompt, stageName) {
  const length = String(prompt ?? "").length;
  console.error(`visual ${stageName}: prompt chars ${length}`);
  if (Number.isFinite(promptMaxChars) && promptMaxChars > 0 && length > promptMaxChars) {
    throw new Error(`Visual planner prompt for ${stageName} is ${length} chars, above limit ${promptMaxChars}. Use a smaller batch or compact upstream artifacts.`);
  }
}

function targetImageIdForRow(row, episodeId, fallbackIndex = 0) {
  const absoluteIndex = Number.isFinite(Number(row?.__visual_plan_absolute_index))
    ? Number(row.__visual_plan_absolute_index)
    : fallbackIndex;
  return `${episodeId}-cut-${String(absoluteIndex + 1).padStart(3, "0")}`;
}

function assertPromptIdentityMatchesInputs(prompts, sourceRows, episodeId, label = "visual planner") {
  const failures = [];
  for (let index = 0; index < sourceRows.length; index += 1) {
    const prompt = prompts[index] ?? {};
    const source = sourceRows[index] ?? {};
    const expectedImageId = targetImageIdForRow(source, episodeId, index);
    const actualImageId = String(prompt.image_id ?? "");
    if (actualImageId !== expectedImageId) {
      failures.push(`${label} item ${index + 1}: image_id ${actualImageId || "(missing)"} should be ${expectedImageId}`);
    }
    const expectedBeatId = source.visual_beat_id ? String(source.visual_beat_id) : "";
    const actualBeatId = prompt.visual_beat_id ? String(prompt.visual_beat_id) : "";
    if (expectedBeatId && actualBeatId !== expectedBeatId) {
      failures.push(`${label} item ${index + 1}: visual_beat_id ${actualBeatId || "(missing)"} should be ${expectedBeatId}`);
    }
  }
  if (failures.length) {
    throw new Error(`Visual planner output did not preserve input identity:\n${failures.slice(0, 24).join("\n")}`);
  }
}

function normalizePrompt(row, index, episodeId, sourceUnit = null, scope = {}) {
  const imageId = targetImageIdForRow(sourceUnit, episodeId, index);
  const prompt = sanitizePositiveVisualPrompt(String(row.modelslab_image_prompt ?? row.image_prompt ?? "").trim());
  const basePrompt = {
    image_id: imageId,
    scene_id: row.scene_id ?? null,
    visual_beat_id: row.visual_beat_id ?? null,
    visual_beat_action: sourceUnit?.visual_beat_action ?? row.visual_beat_action ?? null,
    visual_beat_script_excerpt: sourceUnit?.visual_beat_script_excerpt ?? row.visual_beat_script_excerpt ?? null,
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
    shot_manifest: sanitizeShotManifest(row.shot_manifest),
    visible_subjects: row.visible_subjects ?? [],
    character_state_refs_used: Array.isArray(row.character_state_refs_used) ? row.character_state_refs_used : [],
    primary_subject: row.primary_subject ?? null,
    location: row.location ?? null,
    ui_text_on_screen: row.ui_text_on_screen ?? [],
    image_generation_required: true,
  };
  const scene = sourceUnit ?? row;
  const scopedCharacterRefs = sceneCharacterStateRefs(scene, scope.stateRefIndex ?? new Map());
  const allowedRefIds = allowedRefIdsForScene({
    scene,
    visualReferencePlan: scope.visualReferencePlan,
    characterStateRefs: scopedCharacterRefs,
  });
  return dropOutOfScopePromptRefs(basePrompt, allowedRefIds);
}

function sanitizePositiveVisualPrompt(value) {
  return String(value ?? "")
    .replace(/\bno[-\s]?contact\b/gi, "contact-silence")
    .replace(/\bdo\s+not\s+self[-\s]?deprecate\b/gi, "self-respect response")
    .replace(/\bdo\s+not\s+beg\b/gi, "stand firm")
    .replace(/\bdo\s+not\s+call\b/gi, "call restraint")
    .replace(/\bdo\s+not\s+text\b/gi, "message restraint")
    .replace(/\bdo\s+not\s+return upstairs\b/gi, "upstairs restraint")
    .replace(/\bdo\s+not\s+return\b/gi, "return restraint")
    .replace(/\bnot\s+call\b/gi, "call restraint")
    .replace(/\bnot\s+text\b/gi, "message restraint")
    .replace(/\bnot\s+return\b/gi, "return restraint")
    .replace(/\bnot\s+beg\b/gi, "stand firm")
    .replace(/\bnot\s+self[-\s]?deprecate\b/gi, "self-respect response")
    .replace(/\bnot\s+performing\s+for\s+her\b/gi, "self-contained composure")
    .replace(/\bnot\s+performing\b/gi, "self-contained composure")
    .replace(/\bnot\s+chasing\b/gi, "controlled distance")
    .replace(/\bnot\s+confident\s+yet\b/gi, "cautiously building confidence")
    .replace(/\bwithout\s+performing\s+for\s+her\b/gi, "with self-contained composure")
    .replace(/\bwithout\s+performing\b/gi, "with self-contained composure")
    .replace(/\bwithout\s+chasing\b/gi, "with controlled distance")
    .replace(/\bno\s+rain[-\s]?night\s+grime\b/gi, "cleaner than the rain-night version")
    .replace(/\bno\s+rain[-\s]?soaked\s+jacket\b/gi, "clean dry simple clothing")
    .replace(/\bno\s+food\s+stains\b/gi, "clean unstained clothing")
    .replace(/\bno\s+speech bubbles\b/gi, "silent clean illustration")
    .replace(/\bno\s+dialogue balloons\b/gi, "silent clean illustration")
    .replace(/\bno\s+captions\b/gi, "clean image area")
    .replace(/\bno\s+comic lettering\b/gi, "clean image area")
    .replace(/\brather\s+than\b/gi, "with")
    .replace(/\binstead\s+of\b/gi, "with")
    .replace(/\bnegative\s+prompt\b/gi, "visual prompt")
    .replace(/--no\b/gi, "")
    .replace(/\bdo\s+not\b/gi, "show restraint")
    .replace(/\bdon't\b/gi, "show restraint")
    .replace(/\bwithout\b/gi, "with")
    .replace(/\bavoid\b/gi, "favor")
    .replace(/\bexclude\b/gi, "favor")
    .replace(/\bnot\b/gi, "restrained")
    .replace(/\bno\b/gi, "clean")
    .replace(/\s+/g, " ")
    .trim();
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
  };
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

function assertPromptVariety(prompts) {
  const groups = new Map();
  for (const prompt of prompts) {
    const sceneId = prompt.scene_id ?? "unknown";
    if (!groups.has(sceneId)) groups.set(sceneId, []);
    groups.get(sceneId).push(prompt);
  }
  const failures = [];
  for (const [sceneId, rows] of groups.entries()) {
    if (rows.length < 4) continue;
    const counts = new Map();
    for (const row of rows) {
      const key = promptSimilarityKey(row.modelslab_image_prompt ?? row.image_prompt);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const repeated = [...counts.entries()].filter(([, count]) => count >= Math.min(4, rows.length));
    if (repeated.length) failures.push(`${sceneId} has repeated prompt bodies across ${repeated[0][1]} visual beats`);
  }
  if (failures.length) {
    throw new Error(`Visual prompt plan lacks beat-level variety:\n${failures.slice(0, 20).join("\n")}`);
  }
}

function assertScenePromptShape(prompts) {
  const failures = [];
  const badLayout = /\b(?:contact sheet|reference sheet|turnaround|character sheet|visible reference panel|reference panel layout)\b/i;
  const metadataStart = /^\s*(?:cut\s+\d+|scene\s+\d+|beat\s+\d+)/i;
  const duplicateSlotText = /\buse image (?:one|two|three|four|five|six|seven|eight) as\b/i;
  for (const prompt of prompts) {
    const text = String(prompt.modelslab_image_prompt ?? prompt.image_prompt ?? "");
    if (metadataStart.test(text)) failures.push(`${prompt.image_id} starts with metadata instead of visible action`);
    if (badLayout.test(text)) failures.push(`${prompt.image_id} requests a reference/sheet layout in a scene cut`);
    if (duplicateSlotText.test(text)) failures.push(`${prompt.image_id} duplicates reference slot text inside prompt body`);
  }
  if (failures.length) {
    throw new Error(`Visual prompt plan violates scene-prompt shape contract:\n${failures.slice(0, 30).join("\n")}`);
  }
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function chunkByParentScene(items, targetSize) {
  const chunks = [];
  let current = [];
  let currentSceneId = null;
  const splitLongScenes = flags["visual-chunk-split-long-scenes"] !== "false";
  for (const item of items) {
    const sceneId = item.parent_scene_id ?? item.scene_id ?? null;
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

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(items.length, Number(concurrency) || 1));
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function parseListFlag(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function loadCorrectionDirectives(filePath) {
  if (!filePath) return [];
  const artifact = await readJson(filePath, null);
  if (Array.isArray(artifact)) return artifact;
  if (Array.isArray(artifact?.correction_directives)) return artifact.correction_directives;
  if (Array.isArray(artifact?.directives)) return artifact.directives;
  return [];
}

function filterVisualSourceRows(rows, episodeId) {
  const annotated = rows.map((row, index) => ({ ...row, __visual_plan_absolute_index: index }));
  const sceneIds = parseListFlag(flags["only-scenes"] ?? flags.onlyScenes);
  if (sceneIds.length) {
    const wanted = new Set(sceneIds);
    return annotated.filter((row) => wanted.has(row.parent_scene_id ?? row.scene_id));
  }
  const cutIds = parseListFlag(flags["cut-ids"] ?? flags.cutIds);
  if (cutIds.length) {
    const wanted = new Set(cutIds);
    return annotated.filter((row, index) => wanted.has(`${episodeId}-cut-${String(index + 1).padStart(3, "0")}`));
  }
  const beatIds = parseListFlag(flags["beat-ids"] ?? flags.beatIds);
  if (beatIds.length) {
    const wanted = new Set(beatIds);
    return annotated.filter((row) => wanted.has(row.visual_beat_id));
  }
  const offset = Math.max(0, Number(flags["visual-unit-offset"] ?? flags.offset ?? 0));
  const limitRaw = flags["visual-unit-limit"] ?? flags.limit;
  const limit = limitRaw == null ? null : Math.max(0, Number(limitRaw));
  if (limit != null) return annotated.slice(offset, offset + limit);
  if (offset > 0) return annotated.slice(offset);
  return annotated;
}

function scopedPlanFromRows(plan, rows, countField = "scene_count") {
  return {
    ...plan,
    scenes: rows,
    [countField]: rows.length,
  };
}

function scopedVisualBeatPlanFromRows(plan, rows) {
  if (plan?.status !== "passed") return null;
  return {
    ...plan,
    beats: rows,
    visual_beat_count: rows.length,
  };
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
    if (!character || !(ref.scene_prompt_anchor || ref.prompt_anchor)) continue;
    const sceneIds = Array.isArray(ref.scene_ids) && ref.scene_ids.length
      ? ref.scene_ids
      : [ref.scene_id ?? ref.scene ?? "*"];
    const normalized = {
      ...ref,
      character,
      scene_id: sceneIds[0] === "*" ? null : sceneIds[0],
      state_ref_id: ref.state_ref_id ?? ref.ref_id ?? `${normalizeLabel(character).replace(/\s+/g, "_")}_${sceneIds[0] ?? "global"}`,
      definitive: ref.definitive !== false,
      scene_prompt_anchor: scenePromptAnchorFromRef(ref),
      source: ref.source ?? "character_state_ref_artifact",
    };
    for (const sceneId of sceneIds) {
      index.set(`${sceneId}:${normalizeLabel(character)}`, { ...normalized, scene_id: sceneId === "*" ? null : sceneId });
      if (sceneId === "*") index.set(normalizeLabel(character), normalized);
    }
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
  const correctionDirectives = await loadCorrectionDirectives(correctionFindingsPath);
  const stateRefIndex = indexCharacterStateRefs(characterStateRefs);
  const allVisualSourceRows = visualBeatPlan?.status === "passed" && Array.isArray(visualBeatPlan.beats) && visualBeatPlan.beats.length
    ? visualBeatPlan.beats
    : timedPlan.scenes;
  const visualSourceRows = filterVisualSourceRows(allVisualSourceRows, episode);
  if (!visualSourceRows.length) throw new Error("Visual planner small-batch filters selected zero visual units.");
  const scopedTimedPlan = scopedPlanFromRows(timedPlan, visualSourceRows);
  const scopedVisualBeatPlan = visualBeatPlan?.status === "passed"
    ? scopedVisualBeatPlanFromRows(visualBeatPlan, visualSourceRows)
    : null;
  const stageName = `${episode}_visual_plan`;
  if (flags["dry-run-prompt"] === "true") {
    const useChunkingForDryRun = flags["visual-chunking"] !== "false"
      && visualSourceRows.length > Number(flags["visual-single-call-max-scenes"] ?? 4);
    const promptSizes = [];
    if (useChunkingForDryRun) {
      const sceneChunks = chunkByParentScene(visualSourceRows, Number(flags["visual-chunk-scenes"] ?? 4));
      for (let index = 0; index < sceneChunks.length; index += 1) {
        const chunkTimedPlan = { ...timedPlan, scenes: sceneChunks[index], scene_count: sceneChunks[index].length };
        const chunkVisualBeatPlan = visualBeatPlan?.status === "passed" ? { ...visualBeatPlan, beats: sceneChunks[index], visual_beat_count: sceneChunks[index].length } : null;
        const chunkPrompt = buildPrompt(chunkTimedPlan, semanticPlan, enrichedVisualReferencePlan, stateRefIndex, chunkVisualBeatPlan, correctionDirectives);
        promptSizes.push({ chunk_index: index + 1, visual_unit_count: sceneChunks[index].length, prompt_chars: chunkPrompt.length });
      }
    } else {
      const prompt = buildPrompt(scopedTimedPlan, semanticPlan, enrichedVisualReferencePlan, stateRefIndex, scopedVisualBeatPlan, correctionDirectives);
      promptSizes.push({ chunk_index: null, visual_unit_count: visualSourceRows.length, prompt_chars: prompt.length });
    }
    await writeJson(outputPath, {
      schema: "goldflow_section_image_prompts_v1",
      status: "dry_run",
      channel,
      series_slug: series,
      week,
      episode,
      visual_plan_scope: {
        mode: visualSourceRows.length === allVisualSourceRows.length ? "full_episode" : "small_batch",
        selected_visual_unit_count: visualSourceRows.length,
        total_visual_unit_count: allVisualSourceRows.length,
        cut_ids: visualSourceRows.map((row) => `${episode}-cut-${String(Number(row.__visual_plan_absolute_index ?? 0) + 1).padStart(3, "0")}`),
      },
      prompt_sizes: promptSizes,
      updated_at: new Date().toISOString(),
    });
    console.log(JSON.stringify({ status: "dry_run", output_path: outputPath, prompt_sizes: promptSizes }, null, 2));
    return;
  }
  let llm;
  let parsedPrompts = [];
  let styleSummary = "";
  const useChunking = flags["visual-chunking"] !== "false"
    && visualSourceRows.length > Number(flags["visual-single-call-max-scenes"] ?? 4);
  if (useChunking) {
    const sceneChunks = chunkByParentScene(visualSourceRows, Number(flags["visual-chunk-scenes"] ?? 4));
    const chunkConcurrency = Math.max(1, Number(flags["visual-chunk-concurrency"] ?? 6));
    const chunkResults = await mapWithConcurrency(sceneChunks, chunkConcurrency, async (sceneChunk, index) => {
      const chunkTimedPlan = { ...timedPlan, scenes: sceneChunk, scene_count: sceneChunk.length };
      console.error(`visual chunk ${index + 1}/${sceneChunks.length}: ${sceneChunk.length} visual units`);
      const chunkVisualBeatPlan = visualBeatPlan?.status === "passed" ? { ...visualBeatPlan, beats: sceneChunk, visual_beat_count: sceneChunk.length } : null;
      const chunkPrompt = buildPrompt(chunkTimedPlan, semanticPlan, enrichedVisualReferencePlan, stateRefIndex, chunkVisualBeatPlan, correctionDirectives);
      const chunkStageName = `${stageName}_chunk_${String(index + 1).padStart(2, "0")}`;
      const expectedBeatIds = sceneChunk.map((unit) => String(unit.visual_beat_id ?? "")).filter(Boolean);
      const chunkLlm = isLocalLLMRoute(chunkStageName)
        ? await callLocal(chunkPrompt, chunkStageName, Number(flags["visual-chunk-max-tokens"] ?? 7000))
        : await callCodex(chunkPrompt, chunkStageName, expectedBeatIds);
      const chunkPrompts = Array.isArray(chunkLlm.parsed.prompts) ? chunkLlm.parsed.prompts : [];
      if (chunkPrompts.length !== sceneChunk.length) {
        throw new Error(`Visual chunk ${index + 1}/${sceneChunks.length} returned ${chunkPrompts.length} prompts for ${sceneChunk.length} visual units.`);
      }
      assertPromptIdentityMatchesInputs(chunkPrompts, sceneChunk, episode, `visual chunk ${index + 1}/${sceneChunks.length}`);
      console.error(`visual chunk ${index + 1}/${sceneChunks.length}: accepted ${chunkPrompts.length} prompts`);
      return { chunkLlm, chunkPrompts };
    });
    const styleSummaries = [];
    for (const result of chunkResults) {
      parsedPrompts.push(...result.chunkPrompts);
      if (result.chunkLlm.parsed.style_summary) styleSummaries.push(result.chunkLlm.parsed.style_summary);
    }
    styleSummary = styleSummaries.filter(Boolean)[0] ?? "";
    llm = {
      provider: isLocalLLMRoute(stageName) ? "local-qwen" : "codex",
      model: isLocalLLMRoute(stageName) ? getLLMModel(stageName) : "codex_cli_default",
      chunked: true,
      chunk_count: sceneChunks.length,
      chunk_concurrency: Math.min(sceneChunks.length, chunkConcurrency),
      parsed: { prompts: parsedPrompts, style_summary: styleSummary, warnings: [] },
    };
  } else {
    const prompt = buildPrompt(scopedTimedPlan, semanticPlan, enrichedVisualReferencePlan, stateRefIndex, scopedVisualBeatPlan, correctionDirectives);
    llm = isLocalLLMRoute(stageName) ? await callLocal(prompt, stageName) : await callCodex(prompt, stageName);
    parsedPrompts = Array.isArray(llm.parsed.prompts) ? llm.parsed.prompts : [];
    styleSummary = llm.parsed.style_summary ?? "";
  }
  const prompts = parsedPrompts
    .map((row, index) => normalizePrompt(row, index, episode, visualSourceRows[index] ?? null, { visualReferencePlan: enrichedVisualReferencePlan, stateRefIndex }))
    .map(sanitizePromptLanguage);
  const empty = prompts.filter((row) => !row.image_prompt);
  if (!prompts.length || empty.length) throw new Error(`Visual planner returned ${prompts.length} prompts with ${empty.length} empty prompts.`);
  assertPositivePromptLanguage(prompts);
  assertScenePromptShape(prompts);
  assertPromptVariety(prompts);
  const expectedPromptCount = visualSourceRows.length;
  if (prompts.length !== expectedPromptCount) throw new Error(`Visual planner returned ${prompts.length} prompts for ${expectedPromptCount} visual units.`);
  const duplicateImageIds = [...new Set(prompts.map((prompt) => prompt.image_id).filter((imageId, index, all) => all.indexOf(imageId) !== index))];
  if (duplicateImageIds.length) throw new Error(`Visual planner produced duplicate image ids: ${duplicateImageIds.slice(0, 20).join(", ")}`);
  const timedSceneIds = new Set(visualSourceRows.map((scene) => scene.scene_id));
  const missingSceneIds = [...timedSceneIds].filter((sceneId) => sceneId && !prompts.some((prompt) => prompt.scene_id === sceneId));
  if (missingSceneIds.length) throw new Error(`Visual planner missed timed scene ids: ${missingSceneIds.slice(0, 20).join(", ")}`);
  const missingBeatIds = visualBeatPlan?.status === "passed"
    ? visualSourceRows.map((beat) => beat.visual_beat_id).filter((beatId) => beatId && !prompts.some((prompt) => prompt.visual_beat_id === beatId))
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
    visual_plan_scope: {
      mode: visualSourceRows.length === allVisualSourceRows.length ? "full_episode" : "small_batch",
      selected_visual_unit_count: visualSourceRows.length,
      total_visual_unit_count: allVisualSourceRows.length,
      cut_ids: prompts.map((prompt) => prompt.image_id),
    },
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
