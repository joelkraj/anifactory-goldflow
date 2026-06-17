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

function compactSceneForPrompt(scene, stateRefIndex = new Map()) {
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
    end_sec: scene.end_sec,
    duration_sec: scene.duration_sec,
    location: scene.location,
    time: scene.time,
    visible_subjects: scene.visible_subjects ?? [],
    primary_subject: scene.primary_subject ?? null,
    visual_intent: scene.visual_intent ?? "",
    character_state_refs: sceneCharacterStateRefs(scene, stateRefIndex).map((ref) => ({
      ...ref,
      scene_prompt_anchor: scenePromptAnchorFromRef(ref),
    })),
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
  const sceneId = scene.parent_scene_id ?? scene.scene_id;
  return (visualReferencePlan?.reference_targets ?? []).filter((target) => {
    if (!Array.isArray(target.scene_ids) || !target.scene_ids.length) return false;
    return target.scene_ids.includes(sceneId);
  }).map(compactReferenceTarget);
}

function compactReferenceTarget(target) {
  return {
    ref_id: target.ref_id ?? null,
    kind: target.kind ?? null,
    subject: target.subject ?? null,
    priority: target.priority ?? null,
    generation_mode: target.generation_mode ?? null,
    required_before_imagegen: target.required_before_imagegen ?? null,
    reference_image_path: target.reference_image_path ?? null,
    resolved_reference_image_path: target.resolved_reference_image_path ?? null,
    reference_exists: target.reference_exists ?? null,
    prompt_anchor: target.prompt_anchor ?? null,
    anchor_cut_policy: target.anchor_cut_policy ?? null,
    risk_notes: target.risk_notes ?? [],
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
    scenes: (sourceRows ?? []).map((scene, index, rows) => ({
      ...compactSceneForPrompt(scene, stateRefIndex),
      previous_beat_context: compactNeighborContext(rows[index - 1]),
      next_beat_context: compactNeighborContext(rows[index + 1]),
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
- For visual beats, visual_beat_script_excerpt and visual_beat_action are the main source for the image. Each cut must show the specific moment in that beat excerpt, not a repeated hero portrait with the whole scene summarized behind the character.
- Across beats in the same parent scene, vary the visible action progression: establish, object/UI close-up, character interaction, impact, reaction, consequence, and transition as appropriate to the beat excerpt.
- A prompt may use a calm foreground character only when the beat excerpt itself is about stillness, calculation, realization, or a character reveal.
- Author the shot_manifest before writing the prose prompt. Treat it as the contract for the cut: physically visible characters, mentioned-only characters, location ref, character state refs, foreground action, shot job, props/UI, and forbidden refs.
- The prose prompt and reference_requirements must obey shot_manifest. If a character is mentioned_only, do not attach that character reference and do not stage that person physically. If a ref_id is in forbidden_ref_ids, do not attach it. If location_ref_id is set, the prose prompt must describe that visible location.
- Parent scene context explains why the beat matters, but visual_beat_script_excerpt decides what appears. Do not include future reveals, earlier setup, or the whole confrontation unless the current beat excerpt physically shows them.
- previous_beat_context and next_beat_context are sequencing aids only. Use them to avoid repeated shots and to choose progression, but do not import their characters, props, locations, or reveals into the current cut unless the current visual_beat_script_excerpt also includes them.
- For transformation arcs, use one base identity face anchor only when the approved reference metadata says identity_usage is face_only; current state wording controls body, hair, shave/facial hair, wardrobe, posture, cleanliness, and social status.
- modelslab_image_prompt should be a polished image-generation prompt, not a metadata summary. Do not start with "Cut 001", "scene", "beat", or title bookkeeping.
- Start each prompt with the concrete visible moment, subject, action, and location from visual_beat_script_excerpt.
- Every prompt in the same parent scene should have a different visual job. Prefer concrete shot jobs such as environment establishment, object insert, hand/action close-up, over-shoulder confrontation, impact frame, crowd reaction, UI reveal, aftermath, or transition.
- If the beat excerpt mentions a hand, object, UI line, shove, strike, gate, orb, phone, counter, or expression change, make that element the visible focus for that cut.
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

async function callCodex(prompt, stageName) {
  assertPromptSize(prompt, stageName);
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

function assertPromptSize(prompt, stageName) {
  const length = String(prompt ?? "").length;
  console.error(`visual ${stageName}: prompt chars ${length}`);
  if (Number.isFinite(promptMaxChars) && promptMaxChars > 0 && length > promptMaxChars) {
    throw new Error(`Visual planner prompt for ${stageName} is ${length} chars, above limit ${promptMaxChars}. Use a smaller batch or compact upstream artifacts.`);
  }
}

function normalizePrompt(row, index, episodeId, sourceUnit = null) {
  const absoluteIndex = Number.isFinite(Number(sourceUnit?.__visual_plan_absolute_index))
    ? Number(sourceUnit.__visual_plan_absolute_index)
    : index;
  const imageId = `${episodeId}-cut-${String(absoluteIndex + 1).padStart(3, "0")}`;
  const prompt = sanitizePositiveVisualPrompt(String(row.modelslab_image_prompt ?? row.image_prompt ?? "").trim());
  return {
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
}

function sanitizePositiveVisualPrompt(value) {
  return String(value ?? "")
    .replace(/\bno[-\s]?contact\b/gi, "contact-silence")
    .replace(/\bdo\s+not\s+beg\b/gi, "stand firm")
    .replace(/\bdo\s+not\s+call\b/gi, "call restraint")
    .replace(/\bdo\s+not\s+text\b/gi, "message restraint")
    .replace(/\bdo\s+not\s+return upstairs\b/gi, "upstairs restraint")
    .replace(/\bdo\s+not\s+return\b/gi, "return restraint")
    .replace(/\bnot\s+call\b/gi, "call restraint")
    .replace(/\bnot\s+text\b/gi, "message restraint")
    .replace(/\bnot\s+return\b/gi, "return restraint")
    .replace(/\bnot\s+beg\b/gi, "stand firm")
    .replace(/\bno\s+speech bubbles\b/gi, "silent clean illustration")
    .replace(/\bno\s+dialogue balloons\b/gi, "silent clean illustration")
    .replace(/\bno\s+captions\b/gi, "clean image area")
    .replace(/\bno\s+comic lettering\b/gi, "clean image area")
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

function parseListFlag(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function filterVisualSourceRows(rows, episodeId) {
  const annotated = rows.map((row, index) => ({ ...row, __visual_plan_absolute_index: index }));
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
      && visualSourceRows.length > Number(flags["visual-single-call-max-scenes"] ?? 12);
    const promptSizes = [];
    if (useChunkingForDryRun) {
      const sceneChunks = chunkByParentScene(visualSourceRows, Number(flags["visual-chunk-scenes"] ?? 8));
      for (let index = 0; index < sceneChunks.length; index += 1) {
        const chunkTimedPlan = { ...timedPlan, scenes: sceneChunks[index], scene_count: sceneChunks[index].length };
        const chunkVisualBeatPlan = visualBeatPlan?.status === "passed" ? { ...visualBeatPlan, beats: sceneChunks[index], visual_beat_count: sceneChunks[index].length } : null;
        const chunkPrompt = buildPrompt(chunkTimedPlan, semanticPlan, enrichedVisualReferencePlan, stateRefIndex, chunkVisualBeatPlan);
        promptSizes.push({ chunk_index: index + 1, visual_unit_count: sceneChunks[index].length, prompt_chars: chunkPrompt.length });
      }
    } else {
      const prompt = buildPrompt(scopedTimedPlan, semanticPlan, enrichedVisualReferencePlan, stateRefIndex, scopedVisualBeatPlan);
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
    && visualSourceRows.length > Number(flags["visual-single-call-max-scenes"] ?? 12);
  if (useChunking) {
    const sceneChunks = chunkByParentScene(visualSourceRows, Number(flags["visual-chunk-scenes"] ?? 8));
    const styleSummaries = [];
    for (let index = 0; index < sceneChunks.length; index += 1) {
      const chunkTimedPlan = { ...timedPlan, scenes: sceneChunks[index], scene_count: sceneChunks[index].length };
      console.error(`visual chunk ${index + 1}/${sceneChunks.length}: ${sceneChunks[index].length} visual units`);
      const chunkVisualBeatPlan = visualBeatPlan?.status === "passed" ? { ...visualBeatPlan, beats: sceneChunks[index], visual_beat_count: sceneChunks[index].length } : null;
      const chunkPrompt = buildPrompt(chunkTimedPlan, semanticPlan, enrichedVisualReferencePlan, stateRefIndex, chunkVisualBeatPlan);
      const chunkStageName = `${stageName}_chunk_${String(index + 1).padStart(2, "0")}`;
      const chunkLlm = isLocalLLMRoute(chunkStageName)
        ? await callLocal(chunkPrompt, chunkStageName, Number(flags["visual-chunk-max-tokens"] ?? 7000))
        : await callCodex(chunkPrompt, chunkStageName);
      const chunkPrompts = Array.isArray(chunkLlm.parsed.prompts) ? chunkLlm.parsed.prompts : [];
      if (chunkPrompts.length !== sceneChunks[index].length) {
        throw new Error(`Visual chunk ${index + 1}/${sceneChunks.length} returned ${chunkPrompts.length} prompts for ${sceneChunks[index].length} visual units.`);
      }
      console.error(`visual chunk ${index + 1}/${sceneChunks.length}: accepted ${chunkPrompts.length} prompts`);
      parsedPrompts.push(...chunkPrompts);
      if (chunkLlm.parsed.style_summary) styleSummaries.push(chunkLlm.parsed.style_summary);
    }
    styleSummary = styleSummaries.filter(Boolean)[0] ?? "";
    llm = {
      provider: isLocalLLMRoute(stageName) ? "local-qwen" : "codex",
      model: isLocalLLMRoute(stageName) ? getLLMModel(stageName) : "codex_cli_default",
      chunked: true,
      chunk_count: sceneChunks.length,
      parsed: { prompts: parsedPrompts, style_summary: styleSummary, warnings: [] },
    };
  } else {
    const prompt = buildPrompt(scopedTimedPlan, semanticPlan, enrichedVisualReferencePlan, stateRefIndex, scopedVisualBeatPlan);
    llm = isLocalLLMRoute(stageName) ? await callLocal(prompt, stageName) : await callCodex(prompt, stageName);
    parsedPrompts = Array.isArray(llm.parsed.prompts) ? llm.parsed.prompts : [];
    styleSummary = llm.parsed.style_summary ?? "";
  }
  const prompts = parsedPrompts.map((row, index) => normalizePrompt(row, index, episode, visualSourceRows[index] ?? null));
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
