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
const promptPath = flags.prompts ?? path.join(episodeDir, "section_image_prompts.json");
const timedPlanPath = flags.timed ?? path.join(episodeDir, "timed_scene_plan.json");
const visualReferencePlanPath = flags.visualRefs ?? flags["visual-refs"] ?? path.join(episodeDir, "visual_reference_plan.json");
const characterStateRefsPath = flags.characterStateRefs ?? flags["character-state-refs"] ?? path.join(episodeDir, "character_state_refs.json");
const outputPath = flags.output ?? path.join(episodeDir, "section_image_prompts_reviewed.json");
const reviewReportPath = flags.reviewOutput ?? flags["review-output"] ?? path.join(episodeDir, `visual_prompt_review_${episode}.json`);

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

function positiveLanguageFindings(prompts) {
  const findings = [];
  for (const prompt of prompts) {
    const matches = negativeLanguageMatches(prompt.modelslab_image_prompt ?? prompt.image_prompt);
    if (matches.length) {
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "blocker",
        code: "negative_prompt",
        message: `Prompt contains negative visual language and must be rewritten as positive construction: ${matches.join(", ")}`,
        resolved: false,
      });
    }
  }
  return findings;
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
    modelslab_image_prompt: prompt.modelslab_image_prompt ?? prompt.image_prompt,
    reference_requirements: prompt.reference_requirements ?? [],
    required_reference_paths: prompt.required_reference_paths ?? [],
    reference_usage: prompt.reference_usage ?? [],
    anchor_roles: prompt.anchor_roles ?? [],
    visible_subjects: prompt.visible_subjects ?? [],
    character_state_refs_used: prompt.character_state_refs_used ?? [],
    primary_subject: prompt.primary_subject ?? null,
    location: prompt.location ?? null,
    ui_text_on_screen: prompt.ui_text_on_screen ?? [],
  };
}

function compactReferencePlan(plan) {
  return {
    status: plan?.status ?? null,
    reference_targets: (plan?.reference_targets ?? []).map((target) => ({
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

function compactCharacterStateRefs(refs) {
  return {
    status: refs?.status ?? null,
    character_state_refs: (refs?.character_state_refs ?? []).map((ref) => ({
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
- Use current scene facts only.
- Positive visual language is mandatory. Describe only what should appear.
- Do not use negative prompt clauses or mitigation phrasing such as "no", "not", "without", "avoid", "exclude", "instead of", or "rather than".
- Translate source text that contains negative wording into positive visual wording. Use "windowless room" for "no windows", "single visible subject" for absent extra characters, and "plain open-collar garment" for unwanted formalwear risk.
- Convert risks into positive construction: exact visible subject count, role, pose, action direction, wardrobe construction, frame composition, and location details.
- For single-character shots, state the visible subject positively, such as "one named character alone in frame" rather than naming absent characters.
- Character references provide face, hair, age, body type, and outfit only. Scene pose, camera angle, and action come from the current visual beat.
- Use character_state_refs.scene_prompt_anchor for identity, wardrobe, and state wording inside scene prompts. prompt_anchor may describe a reference-generation sheet and should not be copied into scene cuts.
- visual_beat_script_excerpt and visual_beat_action are authoritative for what this cut shows. Rewrite generic scene-summary prompts into a concrete moment from that beat excerpt.
- Across prompts with the same scene_id, preserve visible action progression: establish, object/UI close-up, character interaction, impact, reaction, consequence, and transition as appropriate to each beat excerpt.
- Use a calm foreground character only when that beat excerpt is about stillness, calculation, realization, or a character reveal.
- modelslab_image_prompt should be a polished image-generation prompt, not a metadata summary. Rewrite prompts that start with "Cut 001", "scene", "beat", or title bookkeeping.
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
- Order reference_requirements in the exact attachment order wanted by the image model. Use slot_order starting at 1 and slot_purpose for every attached reference.
- Preserve clear reference slot mapping in reference_requirements so the image model knows which image provides character identity, location, style, UI, prop, or action/effect design.
- If a required existing reference is missing, add a finding with severity "blocker".
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
${JSON.stringify(compactReferencePlan(visualReferencePlan), null, 2)}

CHARACTER STATE REFS:
${JSON.stringify(compactCharacterStateRefs(characterStateRefs), null, 2)}

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
      "reference_requirements": [{"ref_id":"...","kind":"character_state|location|style|ui|prop|action","required":true,"slot_order":1,"slot_purpose":"character identity and wardrobe for ...","reason":"..."}],
      "required_reference_paths": [],
      "reference_usage": [],
      "anchor_roles": [],
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
      "code": "identity_blend|wrong_subject|unnecessary_ref|missing_ref|action_reversal|literalized_metaphor|wardrobe_contradiction|neighbor_context|unseen_character|negative_prompt|vague_action|scene_contradiction|reference_pose_lock|repeated_tableau|metadata_prompt|reference_layout_prompt|duplicated_reference_slot_text|contaminated_action_ref|other",
      "message": "specific issue",
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
  const prompt = String(row.modelslab_image_prompt ?? row.image_prompt ?? original.modelslab_image_prompt ?? original.image_prompt ?? "").trim();
  return {
    ...original,
    image_id: original.image_id,
    scene_id: original.scene_id,
    visual_beat_id: original.visual_beat_id ?? row.visual_beat_id ?? null,
    visual_beat_action: original.visual_beat_action ?? row.visual_beat_action ?? null,
    visual_beat_script_excerpt: original.visual_beat_script_excerpt ?? row.visual_beat_script_excerpt ?? null,
    start_sec: Number(original.start_sec ?? 0),
    duration_sec: Math.max(1, Number(original.duration_sec ?? 6)),
    image_prompt: prompt,
    modelslab_image_prompt: prompt,
    prompt_hash: sha256(prompt),
    reference_requirements: Array.isArray(row.reference_requirements) ? row.reference_requirements : (original.reference_requirements ?? []),
    required_reference_paths: Array.isArray(row.required_reference_paths) ? row.required_reference_paths : (original.required_reference_paths ?? []),
    reference_usage: Array.isArray(row.reference_usage) ? row.reference_usage : (original.reference_usage ?? []),
    anchor_roles: Array.isArray(row.anchor_roles) ? row.anchor_roles : (original.anchor_roles ?? []),
    visible_subjects: Array.isArray(row.visible_subjects) ? row.visible_subjects : (original.visible_subjects ?? []),
    character_state_refs_used: Array.isArray(row.character_state_refs_used) ? row.character_state_refs_used : (original.character_state_refs_used ?? []),
    primary_subject: row.primary_subject ?? original.primary_subject ?? null,
    location: row.location ?? original.location ?? null,
    ui_text_on_screen: Array.isArray(row.ui_text_on_screen) ? row.ui_text_on_screen : (original.ui_text_on_screen ?? []),
    image_generation_required: original.image_generation_required !== false,
  };
}

function staticPoseFindings(prompts) {
  const findings = [];
  const staticPose = /\b(?:standing|stands)\s+(?:still|straight|centered|calmly|front-facing|facing camera|with hands in pockets)\b/i;
  const actionWords = /\b(?:fight|combat|attack|horde|swarm|wolf|monster|gate|battle|rescue|lunge|strike|impact|corridor|tide|boss|collapse)\b/i;
  for (const prompt of prompts) {
    const text = String(prompt.modelslab_image_prompt ?? prompt.image_prompt ?? "");
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
      const key = promptSimilarityKey(row.modelslab_image_prompt ?? row.image_prompt);
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
    const text = String(prompt.modelslab_image_prompt ?? prompt.image_prompt ?? "");
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

async function reviewChunk({ promptPlan, timedPlan, visualReferencePlan, characterStateRefs, prompts, chunkIndex = null }) {
  const stageName = chunkIndex === null
    ? `${episode}_visual_review`
    : `${episode}_visual_review_chunk_${String(chunkIndex + 1).padStart(2, "0")}`;
  const prompt = buildPrompt({ promptPlan, timedPlan, visualReferencePlan, characterStateRefs, prompts });
  return isLocalLLMRoute(stageName)
    ? callLocal(prompt, stageName, Number(flags["visual-review-chunk-max-tokens"] ?? 9000))
    : callCodex(prompt, stageName);
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
  const planner = { provider: isLocalLLMRoute(`${episode}_visual_review`) ? "local-qwen" : "codex", model: isLocalLLMRoute(`${episode}_visual_review`) ? getLLMModel(`${episode}_visual_review`) : "codex_cli_default", chunked: useChunking, chunk_count: chunks.length };

  for (let index = 0; index < chunks.length; index += 1) {
    if (useChunking) console.error(`visual review chunk ${index + 1}/${chunks.length}: ${chunks[index].length} prompts`);
    const llm = await reviewChunk({ promptPlan, timedPlan, visualReferencePlan, characterStateRefs, prompts: chunks[index], chunkIndex: useChunking ? index : null });
    const chunkReviewed = Array.isArray(llm.parsed.reviewed_prompts) ? llm.parsed.reviewed_prompts : [];
    if (chunkReviewed.length !== chunks[index].length) throw new Error(`Visual review chunk ${index + 1}/${chunks.length} returned ${chunkReviewed.length} prompts for ${chunks[index].length} inputs.`);
    reviewedRows.push(...chunkReviewed);
    if (Array.isArray(llm.parsed.findings)) findings.push(...llm.parsed.findings);
    if (Array.isArray(llm.parsed.warnings)) warnings.push(...llm.parsed.warnings);
  }

  const reviewedPrompts = reviewedRows.map((row, index) => normalizeReviewedPrompt(row, promptPlan.prompts[index]));
  assertReviewedPrompts(promptPlan.prompts, reviewedPrompts, timedPlan);
  findings.push(...positiveLanguageFindings(reviewedPrompts));
  findings.push(...scenePromptShapeFindings(reviewedPrompts));
  findings.push(...staticPoseFindings(reviewedPrompts));
  findings.push(...repeatedTableauFindings(reviewedPrompts));
  findings.push(...contaminatedReferenceFindings(visualReferencePlan));
  findings.push(...await validateReferencePaths(reviewedPrompts));
  const unresolvedBlockers = findings.filter((finding) => finding?.severity === "blocker" && finding.resolved !== true);
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
  await writeJson(outputPath, reviewedPlan);
  await writeJson(reviewReportPath, reviewReport);
  console.log(JSON.stringify({ status, output_path: outputPath, review_report_path: reviewReportPath, prompt_count: reviewedPrompts.length, unresolved_blocker_count: unresolvedBlockers.length }, null, 2));
  if (status !== "passed") process.exitCode = 1;
}

main().catch(async (error) => {
  const failed = { schema: "goldflow_visual_prompt_review_v1", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() };
  await writeJson(reviewReportPath, failed).catch(() => {});
  await writeJson(outputPath, { schema: "goldflow_section_image_prompts_v1", status: "failed", error: failed.error, updated_at: failed.updated_at }).catch(() => {});
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
