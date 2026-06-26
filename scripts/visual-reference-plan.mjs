#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getLLMModel, isLocalLLMRoute, localLLMAuthHeaders, localLLMChatCompletionURL } from "./lib/llm-router.mjs";
import {
  applyDeterministicLocationSceneIds,
  locationCoverageFindings,
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
const semanticPlanPath = flags.semantic ?? path.join(episodeDir, "semantic_scene_plan.json");
const outputPath = flags.output ?? path.join(episodeDir, "visual_reference_plan.json");
const characterStateRefsOutputPath = flags.characterStateRefs
  ?? flags["character-state-refs"]
  ?? path.join(path.dirname(outputPath), "character_state_refs.json");
const visualStyleBiblePath = flags.visualStyleBible ?? flags["visual-style-bible"] ?? path.join(weekDir, "visual_style_bible.json");
const characterBiblePath = flags.characterBible ?? flags["character-bible"] ?? path.join(weekDir, "character_bible.json");
const episodeVisualDirectionPath = flags.episodeVisualDirection ?? flags["episode-visual-direction"] ?? path.join(episodeDir, "episode_visual_direction.md");

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

async function readText(filePath, fallback = "") {
  try {
    return await fs.readFile(filePath, "utf8");
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

function compactScene(scene) {
  return {
    scene_id: scene.scene_id,
    title: scene.title,
    location: scene.location,
    time: scene.time,
    visible_subjects: scene.visible_subjects ?? [],
    primary_subject: scene.primary_subject ?? null,
    visual_intent: scene.visual_intent ?? "",
    character_states: scene.character_states ?? [],
    props: scene.props ?? [],
    ref_requirements: scene.ref_requirements ?? [],
    action_staging: scene.action_staging ?? "",
    continuity_notes: scene.continuity_notes ?? [],
  };
}

function visualGuidanceBlock(guidance = {}) {
  return JSON.stringify({
    visual_style_bible: guidance.visualStyleBible ?? null,
    character_bible: guidance.characterBible ?? null,
    episode_visual_direction: String(guidance.episodeVisualDirection ?? "").slice(0, 5000),
  }, null, 2);
}

function buildPrompt(semanticPlan, { chunkLabel = null, guidance = {} } = {}) {
  const compact = {
    source_script_hash: semanticPlan.source_script_hash,
    episode_summary: semanticPlan.episode_summary ?? "",
    global_reference_requirements: semanticPlan.global_reference_requirements ?? [],
    scene_count: semanticPlan.scenes?.length ?? 0,
    scenes: (semanticPlan.scenes ?? []).map(compactScene),
  };
  return `Create a visual reference strategy from this semantic scene plan.
${chunkLabel ? `\nThis is ${chunkLabel}. Identify reference needs visible in this chunk. A later LLM merge pass will combine duplicate targets across chunks.\n` : ""}

Rules:
- This stage decides reference strategy only. It does not write final image prompts.
- Identify recurring characters, character states, major locations, important props, UI motifs, and high-risk repeated action states.
- Decide whether each target needs a standalone reference, should be derived from a generated cut, needs no reference, or needs operator/manual review.
- Use generic production logic. Do not hardcode story-specific rules.
- Positive visual language is mandatory. Prompt anchors must describe what should appear, never what should be avoided.
- Do not use negative prompt clauses or mitigation phrasing such as "no", "not", "without", "avoid", "exclude", "instead of", or "rather than" in prompt_anchor fields.
- Translate source text that contains negative wording into positive visual wording. Use "windowless room" for "no windows", "single visible subject" for absent extra characters, and "plain open-collar garment" for unwanted formalwear risk.
- Convert risks into positive construction. Example: write "single visible protagonist centered in frame, plain institutional detainee jacket with open collar and flat fabric panels" rather than saying what clothing or extra characters to avoid.
- Prompt anchors must be concrete and specific enough for image generation, but they are draft anchors requiring manual review before reference generation.
- Reference kind taxonomy is strict:
  - style refs define anime/manhwa rendering language, line quality, color, lighting, and shot polish.
  - character_state refs define face, hair, age, body type, wardrobe, and state; they are identity/wardrobe evidence, not reusable pose instructions.
  - location refs define environment, architecture, materials, lighting, and scale; include wide empty or lightly populated staging.
  - prop refs define object shape, surface, markings, and scale.
  - ui refs define interface design, typography, color, layout, and exact display motif.
  - action refs define effect shape, energy color, movement path, interaction pattern, and spatial logic; keep them as effect/action studies rather than complete story scenes.
- Action/effect reference anchors should use neutral or abstract staging unless a specific location is inseparable from the effect.
- Character reference anchors should be single-person, single-pose, plain-background identity refs; final scene poses and locations come from the visual prompt stage. Do not ask for multiple face angles, turnaround sheets, pose grids, scene backgrounds, or cinematic action.
- For progressive transformation arcs where the same character changes body, grooming, hair, facial hair, clothing, wealth status, injury state, power level, or age presentation, separate identity from state:
  - Create one base identity anchor for the character's face likeness and core recognizable identity.
  - Later character_state refs and scene_prompt_anchor values must dictate the current state explicitly: hairstyle, shave/facial hair, body shape, fitness, posture, wardrobe quality, cleanliness, social status, and emotional bearing.
  - Later states must use the base identity as a face-only continuity source; do not treat earlier overweight, injured, poor, dirty, weak, or young states as body/wardrobe references for later transformed states.
  - State anchors should describe the visible progression clearly enough that a viewer can read the arc without narration.
- Lower-priority entities should usually use derive_from_first_clean_cut or derive_from_best_cut rather than standalone_ref.
- Major recurring characters and visually sensitive wardrobe/state changes should usually use standalone_ref or manual_review.
- Any named human character who physically touches, fights, restrains, shoves, carries, rescues, confronts at close range, or otherwise directly interacts with a recurring protagonist should use standalone_ref before imagegen, even if they appear in only one scene. Contact scenes are high identity-blend risk.
- Any named human character who appears beside a protagonist in a two-character or three-character close/medium shot should use standalone_ref before imagegen when their distinct identity matters to the scene.
- Major recurring locations may use standalone_ref or derive_from_first_clean_wide_cut.
- Return only valid JSON.

VISUAL BIBLES AND OPERATOR DIRECTION:
${visualGuidanceBlock(guidance)}

SEMANTIC PLAN:
${JSON.stringify(compact, null, 2)}

Return:
{
  "reference_targets": [
    {
      "ref_id": "stable_snake_case_id",
      "kind": "style|character_state|location|prop|ui|action",
      "subject": "human readable subject",
      "scene_ids": ["scene_001"],
      "priority": "required|high|medium|low",
      "generation_mode": "standalone_ref|derive_from_first_clean_cut|derive_from_best_cut|derive_from_first_clean_wide_cut|no_ref_needed|manual_review",
      "required_before_imagegen": true,
      "reference_image_path": null,
      "prompt_anchor": "positive draft reference prompt anchor",
      "anchor_cut_policy": "none|first_clean_visible_cut|best_clean_visible_cut|first_clean_wide_cut",
      "appearance_count": 1,
      "risk_notes": ["identity blend risk, wardrobe ambiguity, scale ambiguity, etc."],
      "manual_review_required": true
    }
  ],
  "character_state_refs": [
    {
      "state_ref_id": "stable_snake_case_id",
      "character": "character name",
      "scene_ids": ["scene_001"],
      "prompt_anchor": "definitive draft character/state reference-generation anchor for manual review",
      "scene_prompt_anchor": "concise character identity, wardrobe, and state wording for use inside scene image prompts; no reference-sheet, camera, pose, location, or action-direction wording",
      "definitive": false,
      "reference_image_path": null,
      "source_ref_id": "matching reference_targets ref_id",
      "base_identity_ref_id": "optional base face identity reference id for progressive same-character states",
      "identity_usage": "full_identity|face_only"
    }
  ],
  "warnings": []
	}`;
}

function buildMergePrompt(semanticPlan, chunkPlans, guidance = {}) {
  const compact = {
    source_script_hash: semanticPlan.source_script_hash,
    episode_summary: semanticPlan.episode_summary ?? "",
    global_reference_requirements: semanticPlan.global_reference_requirements ?? [],
    scene_count: semanticPlan.scenes?.length ?? 0,
    scene_ids: (semanticPlan.scenes ?? []).map((scene) => scene.scene_id),
  };
  const compactChunkPlans = chunkPlans.map((plan, index) => ({
    chunk: index + 1,
    reference_targets: (plan.reference_targets ?? []).map((target) => ({
      ref_id: target.ref_id,
      kind: target.kind,
      subject: target.subject,
      scene_ids: target.scene_ids ?? [],
      priority: target.priority,
      generation_mode: target.generation_mode,
      required_before_imagegen: target.required_before_imagegen,
      prompt_anchor: String(target.prompt_anchor ?? "").slice(0, 280),
      anchor_cut_policy: target.anchor_cut_policy,
      appearance_count: target.appearance_count,
      risk_notes: (target.risk_notes ?? []).slice(0, 2).map((note) => String(note).slice(0, 120)),
      manual_review_required: target.manual_review_required,
    })),
    character_state_refs: (plan.character_state_refs ?? []).map((ref) => ({
      state_ref_id: ref.state_ref_id,
      character: ref.character,
      scene_ids: ref.scene_ids ?? [],
      prompt_anchor: String(ref.prompt_anchor ?? "").slice(0, 280),
      source_ref_id: ref.source_ref_id,
      base_identity_ref_id: ref.base_identity_ref_id,
      identity_usage: ref.identity_usage,
    })),
    warnings: (plan.warnings ?? []).slice(0, 5),
  }));
  return `Merge chunked visual reference strategy outputs into one coherent episode-level visual reference plan.

Rules:
- Qwen authors the merged plan. Code will only validate schema and blockers.
- Merge duplicate character/location/prop/UI/action targets across chunks.
- Preserve all relevant scene_ids from the chunk plans.
- Keep generation_mode decisions coherent at episode level.
- Positive visual language is mandatory. Prompt anchors must describe what should appear, never what should be avoided.
- Do not use negative prompt clauses or mitigation phrasing such as "no", "not", "without", "avoid", "exclude", "instead of", or "rather than" in prompt_anchor fields.
- Translate source text that contains negative wording into positive visual wording. Use "windowless room" for "no windows", "single visible subject" for absent extra characters, and "plain open-collar garment" for unwanted formalwear risk.
- Convert risks into positive construction: exact visible subject count, role, pose, action direction, wardrobe construction, frame composition, and location details.
- Reference kind taxonomy is strict:
  - style refs define anime/manhwa rendering language, line quality, color, lighting, and shot polish.
  - character_state refs define face, hair, age, body type, wardrobe, and state; they are identity/wardrobe evidence, not reusable pose instructions.
  - location refs define environment, architecture, materials, lighting, and scale; include wide empty or lightly populated staging.
  - prop refs define object shape, surface, markings, and scale.
  - ui refs define interface design, typography, color, layout, and exact display motif.
  - action refs define effect shape, energy color, movement path, interaction pattern, and spatial logic; keep them as effect/action studies rather than complete story scenes.
- Action/effect reference anchors should use neutral or abstract staging unless a specific location is inseparable from the effect.
- Character reference anchors should be single-person, single-pose, plain-background identity refs; final scene poses and locations come from the visual prompt stage. Do not ask for multiple face angles, turnaround sheets, pose grids, scene backgrounds, or cinematic action.
- For progressive transformation arcs where the same character changes body, grooming, hair, facial hair, clothing, wealth status, injury state, power level, or age presentation, separate identity from state:
  - Create one base identity anchor for the character's face likeness and core recognizable identity.
  - Later character_state refs and scene_prompt_anchor values must dictate the current state explicitly: hairstyle, shave/facial hair, body shape, fitness, posture, wardrobe quality, cleanliness, social status, and emotional bearing.
  - Later states must use the base identity as a face-only continuity source; do not treat earlier overweight, injured, poor, dirty, weak, or young states as body/wardrobe references for later transformed states.
  - State anchors should describe the visible progression clearly enough that a viewer can read the arc without narration.
- Major recurring characters and visually sensitive wardrobe/state changes should usually use standalone_ref or manual_review.
- Lower-priority entities should usually use derive_from_first_clean_cut or derive_from_best_cut rather than standalone_ref.
- Any named human character who physically touches, fights, restrains, shoves, carries, rescues, confronts at close range, or otherwise directly interacts with a recurring protagonist should use standalone_ref before imagegen, even if they appear in only one scene. Contact scenes are high identity-blend risk.
- Any named human character who appears beside a protagonist in a two-character or three-character close/medium shot should use standalone_ref before imagegen when their distinct identity matters to the scene.
- Return only valid JSON.

VISUAL BIBLES AND OPERATOR DIRECTION:
${visualGuidanceBlock(guidance)}

EPISODE SUMMARY:
${JSON.stringify(compact, null, 2)}

CHUNK PLANS:
${JSON.stringify(compactChunkPlans, null, 2)}

Return:
{
  "reference_targets": [
    {
      "ref_id": "stable_snake_case_id",
      "kind": "style|character_state|location|prop|ui|action",
      "subject": "human readable subject",
      "scene_ids": ["scene_001"],
      "priority": "required|high|medium|low",
      "generation_mode": "standalone_ref|derive_from_first_clean_cut|derive_from_best_cut|derive_from_first_clean_wide_cut|no_ref_needed|manual_review",
      "required_before_imagegen": true,
      "reference_image_path": null,
      "prompt_anchor": "positive draft reference prompt anchor",
      "anchor_cut_policy": "none|first_clean_visible_cut|best_clean_visible_cut|first_clean_wide_cut",
      "appearance_count": 1,
      "risk_notes": ["identity blend risk, wardrobe ambiguity, scale ambiguity, etc."],
      "manual_review_required": true
    }
  ],
  "character_state_refs": [
    {
      "state_ref_id": "stable_snake_case_id",
      "character": "character name",
      "scene_ids": ["scene_001"],
      "prompt_anchor": "definitive draft character/state reference-generation anchor for manual review",
      "scene_prompt_anchor": "concise character identity, wardrobe, and state wording for use inside scene image prompts; no reference-sheet, camera, pose, location, or action-direction wording",
      "definitive": false,
      "reference_image_path": null,
      "source_ref_id": "matching reference_targets ref_id",
      "base_identity_ref_id": "optional base face identity reference id for progressive same-character states",
      "identity_usage": "full_identity|face_only"
    }
  ],
  "warnings": []
}`;
}

async function callLocal(prompt, stageName, maxTokens = null) {
  const attempts = Number(flags["visual-ref-json-attempts"] ?? 3);
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
          { role: "system", content: "Return only valid JSON. You are a visual reference strategy planner for longform anime/manhwa production. Use positive visual language only: describe what should appear, never what should be avoided." },
          { role: "user", content: retryPrompt },
        ],
        temperature: attempt === 1 ? Number(flags["llm-temperature"] ?? 0.12) : 0,
        max_tokens: Number(maxTokens ?? flags["llm-max-tokens"] ?? 14000),
      }),
      signal: AbortSignal.timeout(Number(process.env.ANIFACTORY_VISUAL_REF_PLAN_TIMEOUT_MS ?? 1_200_000)),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`local-qwen visual refs HTTP ${response.status}: ${raw.slice(0, 1000)}`);
    const content = JSON.parse(raw)?.choices?.[0]?.message?.content ?? raw;
    lastContent = content;
    try {
      return { provider: "local-qwen", model: getLLMModel(stageName), content, parsed: extractJson(content), json_attempt: attempt };
    } catch (error) {
      lastError = error;
      console.error(`visual refs ${stageName}: invalid JSON attempt ${attempt}/${attempts}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`local-qwen visual refs returned invalid JSON after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}; content preview: ${lastContent.slice(0, 600)}`);
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
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`codex visual refs exited ${code}: ${stderr}`)));
    child.stdin.end(prompt);
  });
  const content = await fs.readFile(outputPath, "utf8");
  return { provider: "codex", model: "codex_cli_default", output_path: outputPath, content, parsed: extractJson(content) };
}

function normalizeTarget(target, index) {
  const refId = String(target.ref_id ?? `${target.kind ?? "ref"}_${index + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const mode = String(target.generation_mode ?? "manual_review");
  return {
    ref_id: refId,
    kind: target.kind ?? "unknown",
    subject: target.subject ?? refId,
    scene_ids: Array.isArray(target.scene_ids) ? target.scene_ids : [],
    priority: target.priority ?? "medium",
    generation_mode: ["standalone_ref", "derive_from_first_clean_cut", "derive_from_best_cut", "derive_from_first_clean_wide_cut", "no_ref_needed", "manual_review"].includes(mode) ? mode : "manual_review",
    required_before_imagegen: Boolean(target.required_before_imagegen),
    prompt_anchor: String(target.prompt_anchor ?? "").trim(),
    anchor_cut_policy: target.anchor_cut_policy ?? "none",
    appearance_count: Number(target.appearance_count ?? 0),
    risk_notes: Array.isArray(target.risk_notes) ? target.risk_notes : [],
    manual_review_required: target.manual_review_required !== false,
    reference_image_path: target.reference_image_path ?? target.path ?? null,
  };
}

function normalizeStateRef(ref, index) {
  const character = String(ref.character ?? ref.character_name ?? ref.name ?? `character_${index + 1}`).trim();
  const stateRefId = String(ref.state_ref_id ?? ref.ref_id ?? `${character}_${index + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return {
    state_ref_id: stateRefId,
    character,
    scene_ids: Array.isArray(ref.scene_ids) ? ref.scene_ids : [],
    prompt_anchor: String(ref.prompt_anchor ?? "").trim(),
    scene_prompt_anchor: String(ref.scene_prompt_anchor ?? ref.scene_anchor ?? ref.prompt_anchor ?? "").trim(),
    definitive: false,
    reference_image_path: ref.reference_image_path ?? null,
    source_ref_id: ref.source_ref_id ?? ref.ref_id ?? null,
    base_identity_ref_id: ref.base_identity_ref_id ?? ref.base_identity_ref ?? null,
    identity_usage: ref.identity_usage ?? (ref.base_identity_ref_id || ref.base_identity_ref ? "face_only" : "full_identity"),
  };
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

function assertPositiveAnchors(referenceTargets, characterStateRefs) {
  const failures = [];
  for (const target of referenceTargets) {
    const matches = negativeLanguageMatches(target.prompt_anchor);
    if (matches.length) failures.push(`reference_targets.${target.ref_id}.prompt_anchor contains negative visual language: ${matches.join(", ")}`);
  }
  for (const ref of characterStateRefs) {
    const matches = negativeLanguageMatches(ref.prompt_anchor);
    if (matches.length) failures.push(`character_state_refs.${ref.state_ref_id}.prompt_anchor contains negative visual language: ${matches.join(", ")}`);
    const sceneMatches = negativeLanguageMatches(ref.scene_prompt_anchor);
    if (sceneMatches.length) failures.push(`character_state_refs.${ref.state_ref_id}.scene_prompt_anchor contains negative visual language: ${sceneMatches.join(", ")}`);
  }
  if (failures.length) {
    throw new Error(`Visual reference plan violates positive-language-only contract:\n${failures.slice(0, 20).join("\n")}`);
  }
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

async function createReferencePlan(semanticPlan, stageName, guidance = {}) {
  const useLocalRoute = isLocalLLMRoute(stageName);
  const useChunking = flags["visual-ref-chunking"] !== "false"
    && semanticPlan.scenes.length > Number(flags["visual-ref-single-call-max-scenes"] ?? 12);
  if (!useChunking) {
    const prompt = buildPrompt(semanticPlan, { guidance });
    return useLocalRoute ? await callLocal(prompt, stageName) : await callCodex(prompt, stageName);
  }

  const sceneChunks = chunkArray(semanticPlan.scenes, Number(flags["visual-ref-chunk-scenes"] ?? 8));
  const chunkPlans = [];
  for (let index = 0; index < sceneChunks.length; index += 1) {
    console.error(`visual refs chunk ${index + 1}/${sceneChunks.length}: ${sceneChunks[index].length} scenes`);
    const chunkSemanticPlan = {
      ...semanticPlan,
      scenes: sceneChunks[index],
      scene_count: sceneChunks[index].length,
    };
    const prompt = buildPrompt(chunkSemanticPlan, { chunkLabel: `chunk ${index + 1} of ${sceneChunks.length}`, guidance });
    const chunkStageName = `${stageName}_chunk_${String(index + 1).padStart(2, "0")}`;
    const llm = useLocalRoute
      ? await callLocal(prompt, chunkStageName, Number(flags["visual-ref-chunk-max-tokens"] ?? 7000))
      : await callCodex(prompt, chunkStageName);
    if (!Array.isArray(llm.parsed.reference_targets) || !llm.parsed.reference_targets.length) {
      throw new Error(`Visual reference chunk ${index + 1}/${sceneChunks.length} returned no reference_targets.`);
    }
    chunkPlans.push(llm.parsed);
    console.error(`visual refs chunk ${index + 1}/${sceneChunks.length}: accepted ${llm.parsed.reference_targets.length} targets`);
  }
  console.error(`visual refs merge: ${chunkPlans.length} chunk plans`);
  const mergePrompt = buildMergePrompt(semanticPlan, chunkPlans, guidance);
  const mergeStageName = `${stageName}_merge`;
  const merged = useLocalRoute
    ? await callLocal(mergePrompt, mergeStageName, Number(flags["visual-ref-merge-max-tokens"] ?? 8000))
    : await callCodex(mergePrompt, mergeStageName);
  return {
    provider: merged.provider,
    model: useLocalRoute ? getLLMModel(stageName) : merged.model ?? "codex_cli_default",
    output_path: merged.output_path ?? null,
    chunked: true,
    chunk_count: sceneChunks.length,
    parsed: merged.parsed,
    json_attempt: merged.json_attempt,
  };
}

async function main() {
  const [semanticPlan, visualStyleBible, characterBible, episodeVisualDirection] = await Promise.all([
    readJson(semanticPlanPath, null),
    readJson(visualStyleBiblePath, null),
    readJson(characterBiblePath, null),
    readText(episodeVisualDirectionPath, ""),
  ]);
  if (semanticPlan?.status !== "passed" || !Array.isArray(semanticPlan.scenes) || !semanticPlan.scenes.length) throw new Error(`Missing passed semantic scene plan: ${semanticPlanPath}`);
  const stageName = `${episode}_visual_reference_plan`;
  const guidance = { visualStyleBible, characterBible, episodeVisualDirection };
  const llm = await createReferencePlan(semanticPlan, stageName, guidance);
  let referenceTargets = (Array.isArray(llm.parsed.reference_targets) ? llm.parsed.reference_targets : []).map(normalizeTarget);
  const deterministicLocationScope = applyDeterministicLocationSceneIds(referenceTargets, semanticPlan.scenes);
  referenceTargets = deterministicLocationScope.targets;
  if (!referenceTargets.length) throw new Error("Visual reference planner returned no reference_targets.");
  const characterStateRefs = (Array.isArray(llm.parsed.character_state_refs) ? llm.parsed.character_state_refs : []).map(normalizeStateRef);
  assertPositiveAnchors(referenceTargets, characterStateRefs);
  const coverageFindings = locationCoverageFindings(referenceTargets, semanticPlan.scenes);
  const status = coverageFindings.some((finding) => finding.severity === "blocker") ? "blocked" : "passed";
  const sourceArtifactPaths = [semanticPlanPath, visualStyleBiblePath, characterBiblePath, episodeVisualDirectionPath];
  const report = {
    schema: "goldflow_visual_reference_plan_v1",
    status,
    channel,
    series_slug: series,
    week,
    episode,
    source_script_hash: semanticPlan.source_script_hash,
    source_artifact_paths: sourceArtifactPaths,
    source_hashes: Object.fromEntries((await Promise.all(sourceArtifactPaths.map(async (filePath) => [filePath, await hashFile(filePath)]))).filter(([, hash]) => hash)),
    operator_visual_guidance: {
      visual_style_bible_path: visualStyleBible ? visualStyleBiblePath : null,
      character_bible_path: characterBible ? characterBiblePath : null,
      episode_visual_direction_path: episodeVisualDirection.trim() ? episodeVisualDirectionPath : null,
    },
    planner: { provider: llm.provider, model: llm.model ?? null, output_path: llm.output_path ?? null, chunked: llm.chunked ?? false, chunk_count: llm.chunk_count ?? null },
    policy: "Reference strategy only. Manual review must approve prompt anchors before reference generation or production imagegen.",
    reference_targets: referenceTargets,
    character_state_refs: characterStateRefs,
    findings: coverageFindings,
    warnings: [
      ...(llm.parsed.warnings ?? []),
      ...deterministicLocationScope.warnings,
      ...coverageFindings,
    ],
    updated_at: new Date().toISOString(),
  };
  await writeJson(outputPath, report);
  await writeJson(characterStateRefsOutputPath, {
    schema: "goldflow_character_state_refs_v1",
    status: "draft_needs_manual_review",
    source_visual_reference_plan_path: outputPath,
    source_script_hash: semanticPlan.source_script_hash,
    character_state_refs: report.character_state_refs,
    updated_at: report.updated_at,
  });
  console.log(JSON.stringify({ status, output_path: outputPath, character_state_refs_output_path: characterStateRefsOutputPath, reference_target_count: referenceTargets.length, character_state_ref_count: report.character_state_refs.length }, null, 2));
  if (status !== "passed") process.exitCode = 1;
}

main().catch(async (error) => {
  await writeJson(outputPath, { schema: "goldflow_visual_reference_plan_v1", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() }).catch(() => {});
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
