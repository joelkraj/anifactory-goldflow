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
const runIdentityPath = path.join(episodeDir, "run_identity.json");
const semanticPlanPath = flags.semantic ?? path.join(episodeDir, "semantic_scene_plan.json");
const visualBeatPlanPath = flags.beats ?? flags["visual-beats"] ?? path.join(episodeDir, "visual_beat_plan.json");
const outputPath = flags.output ?? path.join(episodeDir, "visual_reference_plan.json");
const characterStateRefsOutputPath = flags.characterStateRefs
  ?? flags["character-state-refs"]
  ?? path.join(path.dirname(outputPath), "character_state_refs.json");
const visualStyleBiblePath = flags.visualStyleBible ?? flags["visual-style-bible"] ?? path.join(weekDir, "visual_style_bible.json");
const characterBiblePath = flags.characterBible ?? flags["character-bible"] ?? path.join(weekDir, "character_bible.json");
const episodeVisualDirectionPath = flags.episodeVisualDirection ?? flags["episode-visual-direction"] ?? path.join(episodeDir, "episode_visual_direction.md");
const dropStyleRefs = flags["drop-style-refs"] === "true" || process.env.ANIFACTORY_DROP_STYLE_REFS === "true";
const keepStyleRefs = flags["drop-style-refs"] === "false" || process.env.ANIFACTORY_DROP_STYLE_REFS === "false";
const explicitReferenceBudgetProfile = flags["reference-budget-profile"] ?? process.env.ANIFACTORY_REFERENCE_BUDGET_PROFILE ?? null;
const generationModes = new Set([
  "standalone_ref",
  "derive_from_first_clean_cut",
  "derive_from_best_cut",
  "derive_from_first_clean_wide_cut",
  "no_ref_needed",
  "manual_review",
  "source_only",
]);

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

function slug(value, fallback = "ref") {
  const normalized = String(value ?? fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function personKey(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
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
    visual_beats: (scene.visual_beats ?? []).map((beat) => ({
      visual_beat_id: beat.visual_beat_id ?? null,
      start_sec: beat.start_sec ?? null,
      visual_job: beat.visual_job ?? null,
      suggested_shot_job: beat.suggested_shot_job ?? null,
      visual_beat_script_excerpt: String(beat.visual_beat_script_excerpt ?? beat.script_excerpt ?? "").slice(0, 500),
      visual_beat_action: String(beat.visual_beat_action ?? beat.action ?? "").slice(0, 360),
      visible_subjects: beat.visible_subjects ?? [],
      primary_subject: beat.primary_subject ?? null,
      location: beat.location ?? null,
    })),
  };
}

function visualGuidanceBlock(guidance = {}) {
  return JSON.stringify({
    visual_style_bible: guidance.visualStyleBible ?? null,
    character_bible: guidance.characterBible ?? null,
    episode_visual_direction: String(guidance.episodeVisualDirection ?? "").slice(0, 5000),
  }, null, 2);
}

function parseListFlag(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function scopedSemanticPlan(plan) {
  const sceneIds = parseListFlag(flags["only-scenes"] ?? flags.onlyScenes);
  if (!sceneIds.length) return { plan, scope: { mode: "full_episode", selected_scene_ids: [] } };
  const wanted = new Set(sceneIds);
  const scenes = (plan.scenes ?? []).filter((scene) => wanted.has(scene.scene_id));
  return {
    plan: {
      ...plan,
      scenes,
      scene_count: scenes.length,
    },
    scope: {
      mode: "scene_scoped",
      selected_scene_ids: scenes.map((scene) => scene.scene_id),
      requested_scene_ids: sceneIds,
      total_scene_count: plan.scenes?.length ?? 0,
    },
  };
}

function visualBeatRows(plan) {
  if (!plan || plan.status && plan.status !== "passed") return [];
  const rows = Array.isArray(plan.beats) ? plan.beats : (Array.isArray(plan.visual_beats) ? plan.visual_beats : []);
  return rows.filter((row) => row && row.scene_id);
}

function semanticPlanWithVisualBeats(semanticPlan, visualBeatPlan) {
  const rows = visualBeatRows(visualBeatPlan);
  if (!rows.length) return semanticPlan;
  const byScene = new Map();
  for (const row of rows) {
    const sceneId = String(row.parent_scene_id ?? row.scene_id ?? "").trim();
    if (!sceneId) continue;
    if (!byScene.has(sceneId)) byScene.set(sceneId, []);
    byScene.get(sceneId).push(row);
  }
  return {
    ...semanticPlan,
    visual_beat_plan_path: visualBeatPlanPath,
    scenes: (semanticPlan.scenes ?? []).map((scene) => ({
      ...scene,
      visual_beats: byScene.get(scene.scene_id) ?? [],
    })),
  };
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
- Resolve role/title aliases to canonical named characters when the script or semantic scenes establish that relationship. If a named person is also the dean, boss, chairman, judge, professor, host, rival, spouse, parent, or another title, do not create a separate generic character ref for later role-only mentions. Expand the existing named character's state/scope instead.
- For real named public creators, streamers, celebrities, or influencers whose likeness matters, request a face-only source identity anchor before the episode character-state ref is generated. Do not rely on text-only "inspired by" likeness prompts for production. The source anchor supplies facial likeness only; the character-state ref supplies wardrobe, pose, body state, and anime/manhwa styling.
- Use each scene's visual_beats when present. A named character that appears in a beat excerpt through replay footage, livestream panels, phone screens, broadcast feeds, camera files, dossiers, avatars, or video walls still needs current-scene reference coverage if their likeness may be visible in that cut.
- If a character state ref is visually reused as replay/screen evidence in a later scene, include that later scene_id in the ref scope and explain the screen-visible or replay-footage usage in risk_notes.
- Decide whether each target needs a standalone reference, should be derived from a generated cut, needs no reference, or needs operator/manual review. Semantic ref_requirements are scoped target candidates; they are not automatic standalone-generation requirements.
- Use generic production logic. Do not hardcode story-specific rules.
- Write normal descriptive prompt anchors that preserve story-faithful UI labels, status phrases, and concise absence states when they are the point of the reference.
- Do not create separate negative_prompt, avoid_list, or exclude_list payloads. Keep provider-facing content in the normal prompt anchor.
- Convert risks into concrete construction when helpful: exact visible subject count, role, pose, action direction, wardrobe construction, frame composition, and location details.
- Prompt anchors must be concrete and specific enough for image generation, but they are draft anchors requiring manual review before reference generation.
- Every prompt_anchor for every reference kind should start as a 16:9 landscape anime/manhwa reference card or plate; character refs should use plain backgrounds, location refs should use environment-only staging plates, and prop/UI/action refs should be landscape design plates.
- Reference kind taxonomy is strict:
  - style refs define polished 2D anime/manhwa rendering language, line quality, color, lighting, and shot polish.
  - character_state refs define face, hair, age, body type, wardrobe, and state; they are identity/wardrobe evidence, not reusable pose instructions.
  - location refs define environment, architecture, materials, lighting, and scale; use open environment-only staging with enough clean space for later scene characters.
  - prop refs define object shape, surface, markings, and scale.
  - ui refs define interface design, typography, color, layout, and exact display motif.
  - action refs define effect shape, energy color, movement path, interaction pattern, and spatial logic; keep them as effect/action studies rather than complete story scenes.
- Action/effect reference anchors should use neutral or abstract staging unless a specific location is inseparable from the effect.
- Character reference anchors should be 16:9 landscape, single-person, single-pose, plain-background identity reference cards with the full body or three-quarter body centered inside the canvas; final scene poses and locations come from the visual prompt stage. Do not ask for multiple face angles, turnaround sheets, pose grids, scene backgrounds, or cinematic action.
- UI refs that represent a named person as data should use dossier identity tile, silhouette identity marker, or archival record wording so the ref stays an interface design plate instead of a character reference card.
- Style references are optional. Prefer the visual style bible and style_summary text over a generated style image. Create a style reference only when it is a clean abstract rendering/material/lighting sample; it must not contain character faces, character sheets, expression panels, UI screens, speech bubbles, or readable text.
- For progressive transformation arcs where the same character changes body, grooming, hair, facial hair, clothing, wealth status, injury state, power level, or age presentation, separate identity from state:
  - Create one base identity anchor for the character's face likeness and core recognizable identity.
  - Later character_state refs and scene_prompt_anchor values must dictate the current state explicitly: hairstyle, shave/facial hair, body shape, fitness, posture, wardrobe quality, cleanliness, social status, and emotional bearing.
  - Later states must use the base identity as a face-only continuity source; do not treat earlier overweight, injured, poor, dirty, weak, or young states as body/wardrobe references for later transformed states.
  - State anchors should describe the visible progression clearly enough that a viewer can read the arc without narration.
- Lower-priority entities should usually use no_ref_needed, derive_from_first_clean_cut, or derive_from_best_cut rather than standalone_ref.
- Standalone references are for production leverage: recurring named characters, major character states, opening-retention location anchors, key recurring locations, signature recurring system/UI motifs, critical recurring props, and high-risk physical-contact character interactions.
- Minor role characters, generic witnesses/crowds, single-use wardrobe variants, one-off documents, one-off dashboards, one-off props, and late 2-3 occurrence locations/UI/props/actions should not be standalone refs unless the story makes them truly critical. They should be no_ref_needed or derive_from_best_cut so a clean generated scene can become the reference later.
- Major recurring characters and visually sensitive major wardrobe/state changes should usually use standalone_ref or manual_review.
- Any named human character who physically touches, fights, restrains, shoves, carries, rescues, grabs, strikes, escorts, wrestles, or otherwise has real body-contact interaction with a recurring protagonist should use standalone_ref before imagegen, even if they appear in only one scene. Contact scenes are high identity-blend risk.
- Being merely beside, watching, confronting verbally, appearing on a screen, or sharing a two-character frame is not by itself enough for a one-scene standalone ref; use base identity text or derive_from_best_cut unless distinct identity continuity is mission-critical.
- Major recurring locations may use standalone_ref or derive_from_first_clean_wide_cut. Opening-retention physical environments may use standalone_ref even when they appear briefly, because early visual clarity matters.
- Do not merge visually distinct sublocations into one broad location ref just because they share a building, campus, city, company, palace, arena, or venue name. If consecutive scenes or a long story span moves between different visible areas, create separate scene-scoped location refs for those areas, such as entrance, hallway, main room, screen wall, table area, plaza, roof, basement, server room, witness stand, audience floor, or exterior approach. Use the semantic scene location/ref_requirements as the source of scope; code will validate scene_ids and will not invent replacement locations later.
- Semantic scene ref_requirements with kind "location" are binding target IDs for scene scoping only. For every required location ref_id in a scene, return a location reference_target with that exact ref_id covering that scene, but choose generation_mode from production value: standalone only for key recurring/major locations, derive_from_best_cut for useful minor recurring locations, and no_ref_needed for one-scene locations. Broad venue refs may be added, but they must not replace the exact required scene-level location ref_id.
- Long same-venue arcs need enough scoped location refs for editorial variety. A single location ref should not be expected to carry many minutes of visually distinct beats after the retention runway when the semantic scene locations name different physical areas.
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
      "generation_mode": "standalone_ref|derive_from_first_clean_cut|derive_from_best_cut|derive_from_first_clean_wide_cut|no_ref_needed|manual_review|source_only",
      "required_before_imagegen": true,
      "reference_image_path": null,
      "prompt_anchor": "draft reference prompt anchor",
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
- Resolve role/title aliases to canonical named characters when the script or semantic scenes establish that relationship. If a named person is also the dean, boss, chairman, judge, professor, host, rival, spouse, parent, or another title, do not create a separate generic character ref for later role-only mentions. Expand the existing named character's state/scope instead.
- For real named public creators, streamers, celebrities, or influencers whose likeness matters, preserve or request face-only source identity anchors and use those anchors as base_identity_ref_id for the generated anime/manhwa character-state refs. Do not merge these into generic role refs or text-only lookalikes.
- Preserve all relevant scene_ids from the chunk plans.
- Keep generation_mode decisions coherent at episode level. Semantic ref_requirements are scoped target candidates; they are not automatic standalone-generation requirements.
- Write normal descriptive prompt anchors that preserve story-faithful UI labels, status phrases, and concise absence states when they are the point of the reference.
- Do not create separate negative_prompt, avoid_list, or exclude_list payloads. Keep provider-facing content in the normal prompt anchor.
- Convert risks into concrete construction when helpful: exact visible subject count, role, pose, action direction, wardrobe construction, frame composition, and location details.
- Use each scene's visual_beats when present. A named character that appears in a beat excerpt through replay footage, livestream panels, phone screens, broadcast feeds, camera files, dossiers, avatars, or video walls still needs current-scene reference coverage if their likeness may be visible in that cut.
- If a character state ref is visually reused as replay/screen evidence in a later scene, include that later scene_id in the ref scope and explain the screen-visible or replay-footage usage in risk_notes.
- Every prompt_anchor for every reference kind should start as a 16:9 landscape anime/manhwa reference card or plate; character refs should use plain backgrounds, location refs should use environment-only staging plates, and prop/UI/action refs should be landscape design plates.
- Reference kind taxonomy is strict:
  - style refs define polished 2D anime/manhwa rendering language, line quality, color, lighting, and shot polish.
  - character_state refs define face, hair, age, body type, wardrobe, and state; they are identity/wardrobe evidence, not reusable pose instructions.
  - location refs define environment, architecture, materials, lighting, and scale; use open environment-only staging with enough clean space for later scene characters.
  - prop refs define object shape, surface, markings, and scale.
  - ui refs define interface design, typography, color, layout, and exact display motif.
  - action refs define effect shape, energy color, movement path, interaction pattern, and spatial logic; keep them as effect/action studies rather than complete story scenes.
- Action/effect reference anchors should use neutral or abstract staging unless a specific location is inseparable from the effect.
- Character reference anchors should be 16:9 landscape, single-person, single-pose, plain-background identity reference cards with the full body or three-quarter body centered inside the canvas; final scene poses and locations come from the visual prompt stage. Do not ask for multiple face angles, turnaround sheets, pose grids, scene backgrounds, or cinematic action.
- UI refs that represent a named person as data should use dossier identity tile, silhouette identity marker, or archival record wording so the ref stays an interface design plate instead of a character reference card.
- Style references are optional. Prefer the visual style bible and style_summary text over a generated style image. Preserve a style reference only when it is a clean abstract rendering/material/lighting sample; it must not contain character faces, character sheets, expression panels, UI screens, speech bubbles, or readable text.
- For progressive transformation arcs where the same character changes body, grooming, hair, facial hair, clothing, wealth status, injury state, power level, or age presentation, separate identity from state:
  - Create one base identity anchor for the character's face likeness and core recognizable identity.
  - Later character_state refs and scene_prompt_anchor values must dictate the current state explicitly: hairstyle, shave/facial hair, body shape, fitness, posture, wardrobe quality, cleanliness, social status, and emotional bearing.
  - Later states must use the base identity as a face-only continuity source; do not treat earlier overweight, injured, poor, dirty, weak, or young states as body/wardrobe references for later transformed states.
  - State anchors should describe the visible progression clearly enough that a viewer can read the arc without narration.
- Major recurring characters and visually sensitive wardrobe/state changes should usually use standalone_ref or manual_review.
- Lower-priority entities should usually use no_ref_needed, derive_from_first_clean_cut, or derive_from_best_cut rather than standalone_ref.
- Standalone references are for production leverage: recurring named characters, major character states, opening-retention location anchors, key recurring locations, signature recurring system/UI motifs, critical recurring props, and high-risk physical-contact character interactions.
- Minor role characters, generic witnesses/crowds, single-use wardrobe variants, one-off documents, one-off dashboards, one-off props, and late 2-3 occurrence locations/UI/props/actions should not be standalone refs unless the story makes them truly critical. They should be no_ref_needed or derive_from_best_cut so a clean generated scene can become the reference later.
- Any named human character who physically touches, fights, restrains, shoves, carries, rescues, grabs, strikes, escorts, wrestles, or otherwise has real body-contact interaction with a recurring protagonist should use standalone_ref before imagegen, even if they appear in only one scene. Contact scenes are high identity-blend risk.
- Being merely beside, watching, confronting verbally, appearing on a screen, or sharing a two-character frame is not by itself enough for a one-scene standalone ref; use base identity text or derive_from_best_cut unless distinct identity continuity is mission-critical.
- Do not merge visually distinct sublocations into one broad location ref just because they share a building, campus, city, company, palace, arena, or venue name. If chunk plans contain separate visible areas inside one larger venue, preserve or create separate scene-scoped location refs for those areas during merge, such as entrance, hallway, main room, screen wall, table area, plaza, roof, basement, server room, witness stand, audience floor, or exterior approach. Use the semantic scene location/ref_requirements as the source of scope; code will validate scene_ids and will not invent replacement locations later.
- Preserve exact semantic location ref_ids during merge. If a chunk plan or semantic scene requires a location ref_id, the merged plan must keep a location reference_target with that exact ref_id and scene coverage, even when a broader venue ref is also present. The preserved target can still be no_ref_needed or derive_from_best_cut when it is a one-off/minor scoped target.
- Long same-venue arcs need enough scoped location refs for editorial variety. A single location ref should not be expected to carry many minutes of visually distinct beats after the retention runway when the semantic scene locations name different physical areas.
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
      "generation_mode": "standalone_ref|derive_from_first_clean_cut|derive_from_best_cut|derive_from_first_clean_wide_cut|no_ref_needed|manual_review|source_only",
      "required_before_imagegen": true,
      "reference_image_path": null,
      "prompt_anchor": "draft reference prompt anchor",
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
          { role: "system", content: "Return only valid JSON. You are a visual reference strategy planner for longform anime/manhwa production. Preserve story intent and keep provider-facing content in normal prompt anchor fields." },
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
  const refId = slug(target.ref_id ?? `${target.kind ?? "ref"}_${index + 1}`);
  const mode = String(target.generation_mode ?? "manual_review");
  const kind = target.kind ?? "unknown";
  return {
    ref_id: refId,
    kind,
    subject: target.subject ?? refId,
    scene_ids: Array.isArray(target.scene_ids) ? target.scene_ids : [],
    priority: target.priority ?? "medium",
    generation_mode: generationModes.has(mode) ? mode : "manual_review",
    required_before_imagegen: Boolean(target.required_before_imagegen),
    prompt_anchor: ensureLandscapeReferenceAnchor(target.prompt_anchor, kind),
    anchor_cut_policy: target.anchor_cut_policy ?? "none",
    appearance_count: Number(target.appearance_count ?? 0),
    risk_notes: Array.isArray(target.risk_notes) ? target.risk_notes : [],
    manual_review_required: target.manual_review_required !== false,
    reference_image_path: target.reference_image_path ?? target.path ?? null,
  };
}

function normalizeStateRef(ref, index) {
  const character = String(ref.character ?? ref.character_name ?? ref.name ?? `character_${index + 1}`).trim();
  const stateRefId = slug(ref.state_ref_id ?? ref.ref_id ?? `${character}_${index + 1}`);
  return {
    state_ref_id: stateRefId,
    character,
    scene_ids: Array.isArray(ref.scene_ids) ? ref.scene_ids : [],
    prompt_anchor: ensureLandscapeReferenceAnchor(ref.prompt_anchor, "character_state"),
    scene_prompt_anchor: String(ref.scene_prompt_anchor ?? ref.scene_anchor ?? ref.prompt_anchor ?? "").trim(),
    definitive: false,
    reference_image_path: ref.reference_image_path ?? null,
    source_ref_id: ref.source_ref_id ?? ref.ref_id ?? null,
    base_identity_ref_id: ref.base_identity_ref_id ?? ref.base_identity_ref ?? null,
    identity_usage: ref.identity_usage ?? (ref.base_identity_ref_id || ref.base_identity_ref ? "face_only" : "full_identity"),
  };
}

function sourceFaceAnchorRows(characterBible) {
  const rows = [];
  const directRows = Array.isArray(characterBible?.source_face_anchors)
    ? characterBible.source_face_anchors
    : Array.isArray(characterBible?.sourceFaceAnchors)
      ? characterBible.sourceFaceAnchors
      : [];
  rows.push(...directRows);
  const characterRows = Array.isArray(characterBible?.characters)
    ? characterBible.characters
    : Array.isArray(characterBible?.character_bible)
      ? characterBible.character_bible
      : [];
  for (const character of characterRows) {
    const anchor = character?.source_face_anchor ?? character?.sourceFaceAnchor ?? null;
    const imagePath = anchor?.reference_image_path
      ?? anchor?.path
      ?? character?.source_face_image_path
      ?? character?.sourceFaceImagePath
      ?? null;
    if (!imagePath) continue;
    rows.push({
      ...anchor,
      character: anchor?.character ?? character.character ?? character.name ?? character.canonical_name,
      aliases: anchor?.aliases ?? character.aliases ?? [],
      reference_image_path: imagePath,
      ref_id: anchor?.ref_id ?? character.source_face_ref_id ?? null,
      scene_ids: anchor?.scene_ids ?? character.scene_ids ?? [],
      prompt_anchor: anchor?.prompt_anchor ?? character.source_face_prompt_anchor ?? null,
      approved: anchor?.approved ?? character.source_face_approved ?? false,
      source: anchor?.source ?? character.source_face_source ?? null,
    });
  }
  return rows.filter((row) => row && (row.character || row.ref_id) && (row.reference_image_path || row.path));
}

function sceneIdsForCharacter(character, aliases, scenes, characterStateRefs, explicitSceneIds = []) {
  const keys = [character, ...(Array.isArray(aliases) ? aliases : [])].map(personKey).filter(Boolean);
  const sceneIds = new Set((Array.isArray(explicitSceneIds) ? explicitSceneIds : []).filter(Boolean));
  for (const ref of characterStateRefs) {
    const refKeys = [ref.character, ref.state_ref_id, ref.source_ref_id].map(personKey).filter(Boolean);
    if (!keys.some((key) => refKeys.some((refKey) => refKey.includes(key) || key.includes(refKey)))) continue;
    for (const sceneId of ref.scene_ids ?? []) sceneIds.add(sceneId);
  }
  for (const scene of scenes ?? []) {
    const haystack = [
      scene.primary_subject,
      ...(scene.visible_subjects ?? []),
      ...(scene.character_states ?? []).flatMap((state) => [state.character, state.state, state.wardrobe]),
    ].map(personKey).filter(Boolean).join(" ");
    if (keys.some((key) => key && haystack.includes(key))) sceneIds.add(scene.scene_id);
  }
  return [...sceneIds].filter(Boolean);
}

function sourceFaceAnchorsFromCharacterBible(characterBible, scenes, characterStateRefs) {
  const seen = new Set();
  const anchors = [];
  for (const row of sourceFaceAnchorRows(characterBible)) {
    const character = String(row.character ?? row.name ?? row.subject ?? row.ref_id ?? "").trim();
    const aliases = Array.isArray(row.aliases) ? row.aliases : [];
    const refId = slug(row.ref_id ?? `${character}_real_face_source`);
    if (!refId || seen.has(refId)) continue;
    seen.add(refId);
    const sceneIds = sceneIdsForCharacter(character, aliases, scenes, characterStateRefs, row.scene_ids);
    anchors.push({
      ref_id: refId,
      kind: "character_state",
      subject: row.subject ?? `${character} real face source`,
      scene_ids: sceneIds,
      priority: row.priority ?? "required",
      generation_mode: "source_only",
      required_before_imagegen: false,
      reference_image_path: row.reference_image_path ?? row.path,
      prompt_anchor: ensureLandscapeReferenceAnchor(
        row.prompt_anchor
          ?? `face source identity anchor for ${character}, source image supplies facial likeness only, state refs supply wardrobe, body language, pose, and anime/manhwa styling`,
        "character_state"
      ),
      anchor_cut_policy: "none",
      appearance_count: sceneIds.length,
      risk_notes: [
        ...(Array.isArray(row.risk_notes) ? row.risk_notes : []),
        "Approved source portrait supplies face identity continuity for generated anime/manhwa character-state refs.",
      ],
      manual_review_required: row.manual_review_required ?? row.approved !== true,
      source_face_character: character,
      source_face_aliases: aliases,
      source_face_status: row.approved === true ? "approved" : (row.status ?? "needs_manual_review"),
      source: row.source ?? null,
    });
  }
  return anchors;
}

function applySourceFaceAnchors({ referenceTargets, characterStateRefs, characterBible, scenes }) {
  const anchors = sourceFaceAnchorsFromCharacterBible(characterBible, scenes, characterStateRefs);
  if (!anchors.length) {
    return { referenceTargets, characterStateRefs, warnings: [] };
  }
  const targetById = new Map(referenceTargets.map((target) => [target.ref_id, target]));
  for (const anchor of anchors) {
    const previous = targetById.get(anchor.ref_id);
    targetById.set(anchor.ref_id, previous ? {
      ...previous,
      ...anchor,
      scene_ids: [...new Set([...(previous.scene_ids ?? []), ...(anchor.scene_ids ?? [])].filter(Boolean))],
      risk_notes: [...new Set([...(previous.risk_notes ?? []), ...(anchor.risk_notes ?? [])].filter(Boolean))],
      reference_image_path: anchor.reference_image_path ?? previous.reference_image_path ?? null,
      generation_mode: "source_only",
      required_before_imagegen: false,
    } : anchor);
  }
  const anchorsByCharacter = new Map();
  for (const anchor of anchors) {
    for (const key of [anchor.source_face_character, ...(anchor.source_face_aliases ?? [])].map(personKey).filter(Boolean)) {
      anchorsByCharacter.set(key, anchor);
    }
  }
  const anchoredStateRefs = characterStateRefs.map((ref) => {
    const refKeys = [ref.character, ref.state_ref_id, ref.source_ref_id].map(personKey).filter(Boolean);
    const anchor = [...anchorsByCharacter.entries()]
      .find(([key]) => refKeys.some((refKey) => refKey.includes(key) || key.includes(refKey)))?.[1] ?? null;
    if (!anchor || ref.source_ref_id === anchor.ref_id || ref.state_ref_id === anchor.ref_id) return ref;
    return {
      ...ref,
      base_identity_ref_id: anchor.ref_id,
      identity_usage: "face_only",
    };
  });
  return {
    referenceTargets: [...targetById.values()],
    characterStateRefs: anchoredStateRefs,
    warnings: anchors.map((anchor) => ({
      code: "source_face_anchor_applied",
      severity: anchor.source_face_status === "approved" ? "info" : "warning",
      ref_id: anchor.ref_id,
      character: anchor.source_face_character,
      message: `Source-face anchor ${anchor.ref_id} is available for ${anchor.source_face_character}.`,
    })),
  };
}

function identityMergeKey(target) {
  if (String(target.kind ?? "").toLowerCase() !== "character_state") return null;
  const subjectText = String(target.subject ?? "").trim();
  const refText = String(target.ref_id ?? "").replace(/^char_/, "").replace(/_ref$/, "");
  const text = `${subjectText || refText} ${refText}`.toLowerCase();
  const stop = new Set([
    "a", "an", "the", "char", "character", "state", "ref", "reference", "base", "core", "face",
    "identity", "source", "anchor", "real", "only", "full", "body", "wardrobe", "version",
    "young", "younger", "older", "current", "final", "early", "late", "clean", "dirty", "poor",
    "rich", "injured", "bloodied", "weak", "strong", "transformed", "before", "after",
  ]);
  const tokens = text
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token && !stop.has(token) && !/^\d+$/.test(token));
  return tokens[0] ?? null;
}

function isExplicitBaseIdentityTarget(target) {
  if (String(target.kind ?? "").toLowerCase() !== "character_state") return false;
  const refId = String(target.ref_id ?? "");
  const text = `${target.subject ?? ""} ${refId}`;
  if (/\b(?:base|core|source|real)\s+(?:face\s+)?identity\b/i.test(text)) return true;
  if (/\b(?:face|identity)\s+(?:source|anchor|ref|reference)\b/i.test(text)) return true;
  if (/(?:^|_)(?:base|core|source|real)_(?:face_)?identity(?:_|$)/i.test(refId)) return true;
  if (/(?:^|_)(?:face_)?identity_(?:source|anchor|ref|reference)(?:_|$)/i.test(refId)) return true;
  return false;
}

function isGenericCharacterIdentityTarget(target) {
  if (String(target.kind ?? "").toLowerCase() !== "character_state") return false;
  const refId = String(target.ref_id ?? "");
  const subject = String(target.subject ?? "");
  if (/^char_[a-z0-9]+(?:_ref)?$/i.test(refId)) return true;
  if (/^[a-z0-9]+_(?:base_)?(?:face_)?identity_ref$/i.test(refId)) return true;
  if (/^[a-z0-9]+_character_ref$/i.test(refId)) {
    return !/\b(?:state|office|final|morning|warehouse|business|evening|disgraced|promoted|betrayal|suit|support|ally|executive|cornered|diminished|rain|premiere|winter|mature|memory|archival|public|speaker|operator|leader|companion|confession|exit|reformer|strategist|worker|video)\b/i.test(subject);
  }
  return false;
}

function isCanonicalIdentityCandidate(target) {
  const refId = String(target.ref_id ?? "");
  if (isExplicitBaseIdentityTarget(target)) return true;
  if (isGenericCharacterIdentityTarget(target)) return true;
  const compactRef = refId.toLowerCase().replace(/^char_/, "").replace(/_ref$/, "");
  return compactRef.split("_").length <= 2 && /\b(?:base|face|identity)\b/i.test(`${target.subject ?? ""} ${refId}`);
}

function identityTargetScore(target) {
  let score = 0;
  const text = `${target.subject ?? ""} ${target.ref_id ?? ""}`;
  if (target.reference_image_path) score += 100;
  if (isExplicitBaseIdentityTarget(target)) score += 50;
  if (/\bbase\s+(?:face\s+)?identity\b/i.test(text)) score += 10;
  if (/\bcore\s+(?:face\s+)?identity\b/i.test(text)) score += 8;
  if (!/^char_[a-z0-9]+(?:_ref)?$/i.test(String(target.ref_id ?? ""))) score += 10;
  score += Math.min(8, Array.isArray(target.scene_ids) ? target.scene_ids.length : 0);
  return score;
}

function mergeCanonicalBaseIdentityRefs(referenceTargets, characterStateRefs) {
  const allGroups = new Map();
  const candidateGroups = new Map();
  for (const target of referenceTargets) {
    if (String(target.kind ?? "").toLowerCase() !== "character_state") continue;
    const key = identityMergeKey(target);
    if (!key) continue;
    if (!allGroups.has(key)) allGroups.set(key, []);
    allGroups.get(key).push(target);
    if (!isCanonicalIdentityCandidate(target)) continue;
    if (!candidateGroups.has(key)) candidateGroups.set(key, []);
    candidateGroups.get(key).push(target);
  }
  const redirect = new Map();
  const warnings = [];
  const targetById = new Map(referenceTargets.map((target) => [target.ref_id, { ...target }]));
  for (const [key, rows] of candidateGroups.entries()) {
    if (!rows.length) continue;
    const allRows = allGroups.get(key) ?? rows;
    const explicitRows = rows.filter(isExplicitBaseIdentityTarget);
    const primaryPool = explicitRows.length ? explicitRows : allRows;
    const sorted = [...primaryPool].sort((a, b) => identityTargetScore(b) - identityTargetScore(a) || String(a.ref_id).localeCompare(String(b.ref_id)));
    const primary = sorted[0];
    if (!primary) continue;
    const primaryRow = targetById.get(primary.ref_id);
    const mergedSceneIds = new Set(primaryRow.scene_ids ?? []);
    const mergedRiskNotes = new Set(primaryRow.risk_notes ?? []);
    for (const duplicate of rows.filter((row) => row.ref_id !== primary.ref_id)) {
      redirect.set(duplicate.ref_id, primary.ref_id);
      for (const sceneId of duplicate.scene_ids ?? []) mergedSceneIds.add(sceneId);
      for (const note of duplicate.risk_notes ?? []) mergedRiskNotes.add(note);
      const duplicateRow = targetById.get(duplicate.ref_id);
      targetById.set(duplicate.ref_id, {
        ...duplicateRow,
        scene_ids: duplicateRow.scene_ids ?? [],
        generation_mode: duplicateRow.reference_image_path ? "source_only" : "no_ref_needed",
        required_before_imagegen: false,
        manual_review_required: false,
        canonical_identity_ref_id: primary.ref_id,
        reference_budget: {
          ...(duplicateRow.reference_budget ?? {}),
          decision: "merged_identity",
          reason: `canonical ${key} identity merged into ${primary.ref_id}`,
        },
      });
      warnings.push({
        code: "canonical_identity_ref_merged",
        severity: "info",
        character_key: key,
        ref_id: duplicate.ref_id,
        canonical_ref_id: primary.ref_id,
        message: `Merged duplicate base identity target ${duplicate.ref_id} into canonical ${primary.ref_id}.`,
      });
    }
    targetById.set(primary.ref_id, {
      ...primaryRow,
      scene_ids: [...mergedSceneIds].filter(Boolean),
      risk_notes: [...mergedRiskNotes].filter(Boolean),
    });
  }
  if (!redirect.size) return { referenceTargets, characterStateRefs, warnings };
  const redirectedStateRefs = characterStateRefs.map((ref) => ({
    ...ref,
    source_ref_id: redirect.get(ref.source_ref_id) ?? ref.source_ref_id,
    base_identity_ref_id: redirect.get(ref.base_identity_ref_id) ?? ref.base_identity_ref_id,
  }));
  return {
    referenceTargets: [...targetById.values()],
    characterStateRefs: redirectedStateRefs,
    warnings,
    redirect,
  };
}

function sceneTimingIndex(scenes = []) {
  const index = new Map();
  for (const scene of scenes) {
    const starts = [
      Number(scene.start_sec),
      Number(scene.startSec),
      ...(Array.isArray(scene.visual_beats)
        ? scene.visual_beats.map((beat) => Number(beat.start_sec ?? beat.startSec))
        : []),
    ].filter((value) => Number.isFinite(value) && value >= 0);
    index.set(scene.scene_id, {
      start_sec: starts.length ? Math.min(...starts) : null,
    });
  }
  return index;
}

function referenceBudgetProfile(runIdentity = null) {
  const explicit = String(explicitReferenceBudgetProfile ?? runIdentity?.reference_budget_profile ?? "").trim();
  if (explicit) return explicit;
  const markers = [
    runIdentity?.pace_policy,
    runIdentity?.run_intent,
    runIdentity?.series_slug,
    runIdentity?.week,
    series,
    week,
  ].map((value) => String(value ?? "").toLowerCase()).join(" ");
  return /\b(?:diagnostic|validation|candidate|proof|sample)\b/.test(markers)
    ? "candidate_validation"
    : "production";
}

function codexOpeningSecFromRun(runIdentity = null) {
  const value = Number(
    flags["codex-opening-sec"]
    ?? runIdentity?.image_provider_options?.codex_opening_sec
    ?? runIdentity?.image_provider_options?.codexOpeningSec
    ?? 300
  );
  return Number.isFinite(value) && value > 0 ? value : 300;
}

function referenceTargetStats(target, timingIndex) {
  const sceneIds = Array.isArray(target.scene_ids) ? target.scene_ids.filter(Boolean) : [];
  const starts = sceneIds
    .map((sceneId) => timingIndex.get(sceneId)?.start_sec)
    .filter((value) => Number.isFinite(value));
  return {
    scene_count: sceneIds.length,
    earliest_start_sec: starts.length ? Math.min(...starts) : null,
    appearance_count: Number(target.appearance_count ?? sceneIds.length ?? 0),
  };
}

function targetShouldGenerateForCandidate(target, stats, openingSec) {
  const kind = String(target.kind ?? "").toLowerCase();
  const mode = String(target.generation_mode ?? "").toLowerCase();
  if (target.canonical_identity_ref_id) {
    return { generate: false, mode: "no_ref_needed", reason: `merged into canonical identity ref ${target.canonical_identity_ref_id}` };
  }
  if (mode === "source_only" || target.reference_image_path) {
    return { generate: false, reason: "already has a source/existing reference path" };
  }
  const inOpening = Number.isFinite(stats.earliest_start_sec) && stats.earliest_start_sec < openingSec;
  const recurringAcrossScenes = stats.scene_count >= 2;
  const majorRecurringAcrossScenes = stats.scene_count >= 4 || stats.appearance_count >= 6;
  const meaningfulRecurringCharacter = stats.scene_count >= 4 || stats.appearance_count >= 6;
  const minorRecurringMode = recurringAcrossScenes ? "derive_from_best_cut" : "no_ref_needed";
  const highPriority = ["high", "critical", "signature"].includes(String(target.priority ?? "").toLowerCase());
  const anchorText = `${target.subject ?? ""} ${target.ref_id ?? ""} ${target.prompt_anchor ?? ""}`;
  const riskText = `${anchorText} ${(target.risk_notes ?? []).join(" ")}`;
  const baseIdentity = isExplicitBaseIdentityTarget(target) || isGenericCharacterIdentityTarget(target);
  const signatureSystemUi = kind === "ui" && /\b(?:system|quest|status|ranking|rank|ledger|notification|interface|hud|window|panel|score|stat)\b/i.test(anchorText);
  const highRiskContact = kind === "character_state" && /\b(?:fight(?:s|ing)?|restrain(?:s|ing)?\s+(?:him|her|them|joey|protagonist|victim)|shove(?:s|d|ing)?|rescue(?:s|d|ing)?\s+(?:him|her|them|joey|protagonist|victim)|grab(?:s|bed|bing)?|strike(?:s|d|ing)?|hit(?:s|ting)?|slap(?:s|ped|ping)?|wrestle(?:s|d|ing)?|tackle(?:s|d|ing)?|body[- ]?to[- ]?body|physical contact|hand on (?:his|her|their)|hands on (?:his|her|their))\b/i.test(riskText);
  if (kind === "style") return { generate: false, mode: "no_ref_needed", reason: "candidate validation uses style text/bible instead of spending a style ref" };
  if (kind === "character_state") {
    const generate = baseIdentity || highRiskContact || meaningfulRecurringCharacter || (highPriority && recurringAcrossScenes && stats.appearance_count >= 3);
    return {
      generate,
      mode: baseIdentity ? "no_ref_needed" : minorRecurringMode,
      reason: generate
        ? "character identity/state is a base identity, genuinely recurring, high-priority recurring state, or high-risk physical-contact interaction"
        : (recurringAcrossScenes ? "minor recurring character/state should derive from a clean scene cut or base identity" : "one-scene character/state can be carried by scene prompt text for validation"),
    };
  }
  if (kind === "location") {
    const generate = inOpening || majorRecurringAcrossScenes || (highPriority && recurringAcrossScenes);
    return {
      generate,
      mode: recurringAcrossScenes ? "derive_from_best_cut" : "no_ref_needed",
      reason: generate
        ? "location is in the opening retention window, major recurring, or high-priority recurring"
        : (recurringAcrossScenes ? "minor recurring location should derive from a clean scene cut" : "one-scene location remains scoped text-only"),
    };
  }
  if (kind === "ui") {
    const generate = majorRecurringAcrossScenes || (signatureSystemUi && stats.appearance_count >= 4) || (highPriority && recurringAcrossScenes && stats.appearance_count >= 4);
    return {
      generate,
      mode: recurringAcrossScenes ? "derive_from_best_cut" : "no_ref_needed",
      reason: generate
        ? "UI is signature/high-priority and truly recurring, or major recurring"
        : (recurringAcrossScenes ? "minor recurring UI should derive from a clean scene cut" : "one-scene UI remains scoped text-only"),
    };
  }
  if (kind === "prop" || kind === "action" || kind === "effect") {
    const generate = majorRecurringAcrossScenes || (highPriority && recurringAcrossScenes && stats.appearance_count >= 4);
    return {
      generate,
      mode: recurringAcrossScenes ? "derive_from_best_cut" : "no_ref_needed",
      reason: generate
        ? `${kind} is high-priority and truly recurring, or major recurring`
        : (recurringAcrossScenes ? `minor recurring ${kind} should derive from a clean scene cut` : `one-scene ${kind} can be described directly in scene prompts`),
    };
  }
  return { generate: false, mode: "no_ref_needed", reason: "unknown or low-priority target kind for candidate validation" };
}

function applyReferenceBudgetProfile(referenceTargets, scopedSemantic, runIdentity) {
  const profile = referenceBudgetProfile(runIdentity);
  const timingIndex = sceneTimingIndex(scopedSemantic.scenes ?? []);
  const openingSec = codexOpeningSecFromRun(runIdentity);
  if (!/^candidate[_-]validation$/i.test(profile)) {
    return {
      referenceTargets,
      summary: {
        profile,
        applied: false,
        opening_sec: openingSec,
        generated_target_count: referenceTargets.filter((target) => target.generation_mode === "standalone_ref" || target.required_before_imagegen === true).length,
        downgraded_target_count: 0,
      },
      warnings: [],
    };
  }
  const summary = {
    profile,
    applied: true,
    opening_sec: openingSec,
    generated_target_count: 0,
    downgraded_target_count: 0,
    by_kind: {},
  };
  const nextTargets = referenceTargets.map((target) => {
    const stats = referenceTargetStats(target, timingIndex);
    const decision = targetShouldGenerateForCandidate(target, stats, openingSec);
    const kind = String(target.kind ?? "unknown").toLowerCase();
    if (!summary.by_kind[kind]) summary.by_kind[kind] = { generate: 0, downgrade: 0 };
    const next = {
      ...target,
      reference_budget: {
        profile,
        decision: decision.generate ? "generate" : "text_only",
        reason: decision.reason,
        earliest_start_sec: stats.earliest_start_sec,
        scene_count: stats.scene_count,
        appearance_count: stats.appearance_count,
      },
    };
    if (decision.generate) {
      summary.generated_target_count += 1;
      summary.by_kind[kind].generate += 1;
      return {
        ...next,
        generation_mode: target.generation_mode === "manual_review" ? "manual_review" : "standalone_ref",
        required_before_imagegen: true,
      };
    }
    summary.downgraded_target_count += 1;
    summary.by_kind[kind].downgrade += 1;
    return {
      ...next,
      generation_mode: target.reference_image_path ? "source_only" : (decision.mode ?? "no_ref_needed"),
      required_before_imagegen: false,
      manual_review_required: false,
    };
  });
  return {
    referenceTargets: nextTargets,
    summary,
    warnings: [{
      code: "reference_budget_profile_applied",
      severity: "info",
      message: `Candidate validation reference budget kept ${summary.generated_target_count} generated refs and downgraded ${summary.downgraded_target_count} text-only scoped targets.`,
      profile,
      opening_sec: openingSec,
    }],
  };
}

function negativeLanguageMatches(value) {
  const text = String(value ?? "").toLowerCase();
  const patterns = [
    /--no\b/,
    /\bnegative\s+prompt\s*[:=]/,
  ];
  return patterns.filter((pattern) => pattern.test(text)).map(String);
}

function negativePromptPayloadAnchorWarnings(referenceTargets, characterStateRefs) {
  const failures = [];
  for (const target of referenceTargets) {
    const matches = negativeLanguageMatches(target.prompt_anchor);
    if (matches.length) failures.push({
      path: `reference_targets.${target.ref_id}.prompt_anchor`,
      type: "reference_target",
      id: target.ref_id,
      field: "prompt_anchor",
      matches: matches.join(", "),
      value: target.prompt_anchor,
    });
  }
  for (const ref of characterStateRefs) {
    const matches = negativeLanguageMatches(ref.prompt_anchor);
    if (matches.length) failures.push({
      path: `character_state_refs.${ref.state_ref_id}.prompt_anchor`,
      type: "character_state_ref",
      id: ref.state_ref_id,
      field: "prompt_anchor",
      matches: matches.join(", "),
      value: ref.prompt_anchor,
    });
    const sceneMatches = negativeLanguageMatches(ref.scene_prompt_anchor);
    if (sceneMatches.length) failures.push({
      path: `character_state_refs.${ref.state_ref_id}.scene_prompt_anchor`,
      type: "character_state_ref",
      id: ref.state_ref_id,
      field: "scene_prompt_anchor",
      matches: sceneMatches.join(", "),
      value: ref.scene_prompt_anchor,
    });
  }
  return failures.map((failure) => ({
    code: "negative_prompt_payload_marker",
    severity: "warning",
    path: failure.path,
    ref_id: failure.id,
    field: failure.field,
    matched_terms: failure.matches,
    message: `${failure.path} appears to contain embedded negative-prompt payload syntax. Normal negative words are allowed in anchor prose; do not add a separate or embedded negative prompt section.`,
  }));
}

function styleReferenceContaminationFindings(referenceTargets) {
  const badPattern = /\b(?:face|faces|character|characters|portrait|expression|expressions|closeup|closeups|panel|panels|sheet|turnaround|ui|interface|screen|screens|speech bubble|text|caption|chat|profile card)\b/i;
  return referenceTargets
    .filter((target) => String(target.kind ?? "").toLowerCase() === "style")
    .filter((target) => badPattern.test(`${target.subject ?? ""} ${target.prompt_anchor ?? ""}`))
    .map((target) => ({
      code: "style_ref_contamination_risk",
      severity: "warning",
      ref_id: target.ref_id,
      message: `Style ref ${target.ref_id} mentions character/UI/panel/text terms. Inspect the generated style ref before use; this warning does not block reference planning.`,
    }));
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function mergeArraysById(rows, idKey) {
  const merged = new Map();
  for (const row of rows) {
    const id = String(row?.[idKey] ?? "").trim();
    if (!id) continue;
    const previous = merged.get(id);
    if (!previous) {
      merged.set(id, { ...row });
      continue;
    }
    merged.set(id, {
      ...previous,
      ...row,
      scene_ids: [...new Set([...(previous.scene_ids ?? []), ...(row.scene_ids ?? [])].filter(Boolean))],
      risk_notes: [...new Set([...(previous.risk_notes ?? []), ...(row.risk_notes ?? [])].filter(Boolean))],
      appearance_count: Math.max(Number(previous.appearance_count ?? 0), Number(row.appearance_count ?? 0)),
      manual_review_required: previous.manual_review_required !== false || row.manual_review_required !== false,
      required_before_imagegen: Boolean(previous.required_before_imagegen || row.required_before_imagegen),
    });
  }
  return [...merged.values()];
}

function fallbackMergeChunkPlans(chunkPlans, mergeWarnings = []) {
  return {
    reference_targets: mergeArraysById(chunkPlans.flatMap((plan) => plan.reference_targets ?? []), "ref_id"),
    character_state_refs: mergeArraysById(chunkPlans.flatMap((plan) => plan.character_state_refs ?? []), "state_ref_id"),
    warnings: [
      ...mergeWarnings,
      "Merge LLM returned no top-level reference targets; preserved accepted chunk-authored targets with deterministic id de-duplication.",
    ],
  };
}

function landscapePrefixForKind(kind) {
  const normalized = String(kind ?? "").toLowerCase();
  if (normalized === "style") return "16:9 landscape polished 2D anime/manhwa style reference card";
  if (normalized === "character_state") return "16:9 landscape polished 2D anime/manhwa single-character identity reference card";
  if (normalized === "location") return "16:9 landscape polished 2D anime/manhwa environment-only location reference card";
  if (normalized === "prop") return "16:9 landscape polished 2D anime/manhwa prop reference card";
  if (normalized === "ui") return "16:9 landscape polished 2D anime/manhwa UI reference card";
  if (normalized === "action") return "16:9 landscape polished 2D anime/manhwa action and effect reference card";
  return "16:9 landscape polished 2D anime/manhwa production reference card";
}

function ensureLandscapeReferenceAnchor(anchor, kind) {
  const text = String(anchor ?? "").trim();
  if (/^16:9\s+landscape\b/i.test(text)) return text;
  const prefix = landscapePrefixForKind(kind);
  return [prefix, text].filter(Boolean).join(", ");
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
  let parsed = Array.isArray(merged.parsed?.reference_targets) && merged.parsed.reference_targets.length
    ? merged.parsed
    : fallbackMergeChunkPlans(chunkPlans, Array.isArray(merged.parsed?.warnings) ? merged.parsed.warnings : []);
  const mergedLocationFindings = locationCoverageFindings(
    applyDeterministicLocationSceneIds(parsed.reference_targets ?? [], semanticPlan.scenes ?? []).targets,
    semanticPlan.scenes ?? []
  ).filter((finding) => finding.severity === "blocker");
  if (mergedLocationFindings.length) {
    const fallbackParsed = fallbackMergeChunkPlans(chunkPlans, [
      ...(Array.isArray(parsed.warnings) ? parsed.warnings : []),
      {
        code: "llm_merge_location_scope_collapsed",
        severity: "warning",
        message: "LLM merge dropped exact semantic location ref coverage; preserved accepted chunk targets with deterministic exact-id de-duplication.",
        collapsed_scene_count: mergedLocationFindings.length,
      },
    ]);
    const fallbackLocationFindings = locationCoverageFindings(
      applyDeterministicLocationSceneIds(fallbackParsed.reference_targets ?? [], semanticPlan.scenes ?? []).targets,
      semanticPlan.scenes ?? []
    ).filter((finding) => finding.severity === "blocker");
    if (!fallbackLocationFindings.length) parsed = fallbackParsed;
  }
  return {
    provider: merged.provider,
    model: useLocalRoute ? getLLMModel(stageName) : merged.model ?? "codex_cli_default",
    output_path: merged.output_path ?? null,
    chunked: true,
    chunk_count: sceneChunks.length,
    parsed,
    json_attempt: merged.json_attempt,
  };
}

async function main() {
  const [semanticPlan, visualBeatPlan, visualStyleBible, characterBible, episodeVisualDirection, runIdentity] = await Promise.all([
    readJson(semanticPlanPath, null),
    readJson(visualBeatPlanPath, null),
    readJson(visualStyleBiblePath, null),
    readJson(characterBiblePath, null),
    readText(episodeVisualDirectionPath, ""),
    readJson(runIdentityPath, null),
  ]);
  if (semanticPlan?.status !== "passed" || !Array.isArray(semanticPlan.scenes) || !semanticPlan.scenes.length) throw new Error(`Missing passed semantic scene plan: ${semanticPlanPath}`);
  const semanticWithBeats = semanticPlanWithVisualBeats(semanticPlan, visualBeatPlan);
  const { plan: scopedSemantic, scope } = scopedSemanticPlan(semanticWithBeats);
  if (!Array.isArray(scopedSemantic.scenes) || !scopedSemantic.scenes.length) throw new Error("Visual reference planner scope selected zero semantic scenes.");
  const stageName = `${episode}_visual_reference_plan`;
  const guidance = { visualStyleBible, characterBible, episodeVisualDirection };
  const existingReferencePlan = flags["revalidate-existing"] === "true" ? await readJson(outputPath, null) : null;
  const llm = existingReferencePlan && Array.isArray(existingReferencePlan.reference_targets) && existingReferencePlan.reference_targets.length
    ? {
        provider: "existing-plan",
        model: null,
        output_path: outputPath,
        chunked: existingReferencePlan.planner?.chunked ?? null,
        chunk_count: existingReferencePlan.planner?.chunk_count ?? null,
        parsed: {
          reference_targets: existingReferencePlan.reference_targets,
          character_state_refs: existingReferencePlan.character_state_refs ?? [],
          warnings: [],
        },
      }
    : await createReferencePlan(scopedSemantic, stageName, guidance);
  let referenceTargets = (Array.isArray(llm.parsed.reference_targets) ? llm.parsed.reference_targets : []).map(normalizeTarget);
  const shouldDropStyleRefs = dropStyleRefs || (Boolean(visualStyleBible) && !keepStyleRefs);
  if (shouldDropStyleRefs) {
    referenceTargets = referenceTargets.filter((target) => String(target.kind ?? "").toLowerCase() !== "style");
  }
  const deterministicLocationScope = applyDeterministicLocationSceneIds(referenceTargets, scopedSemantic.scenes);
  referenceTargets = deterministicLocationScope.targets;
  if (!referenceTargets.length) throw new Error("Visual reference planner returned no reference_targets.");
  let characterStateRefs = (Array.isArray(llm.parsed.character_state_refs) ? llm.parsed.character_state_refs : []).map(normalizeStateRef);
  const sourceFaceAnchoring = applySourceFaceAnchors({
    referenceTargets,
    characterStateRefs,
    characterBible,
    scenes: scopedSemantic.scenes,
  });
  referenceTargets = sourceFaceAnchoring.referenceTargets;
  characterStateRefs = sourceFaceAnchoring.characterStateRefs;
  const canonicalIdentityMerge = mergeCanonicalBaseIdentityRefs(referenceTargets, characterStateRefs);
  referenceTargets = canonicalIdentityMerge.referenceTargets;
  characterStateRefs = canonicalIdentityMerge.characterStateRefs;
  const referenceBudget = applyReferenceBudgetProfile(referenceTargets, scopedSemantic, runIdentity);
  referenceTargets = referenceBudget.referenceTargets;
  const anchorLanguageWarnings = negativePromptPayloadAnchorWarnings(referenceTargets, characterStateRefs);
  const coverageFindings = locationCoverageFindings(referenceTargets, scopedSemantic.scenes);
  const styleFindings = shouldDropStyleRefs ? [] : styleReferenceContaminationFindings(referenceTargets);
  const findings = [...coverageFindings, ...styleFindings];
  const status = findings.some((finding) => finding.severity === "blocker") ? "blocked" : "passed";
  const sourceArtifactPaths = [
    semanticPlanPath,
    visualBeatPlan?.status === "passed" ? visualBeatPlanPath : null,
    visualStyleBiblePath,
    characterBiblePath,
    episodeVisualDirectionPath,
  ].filter(Boolean);
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
      visual_beat_plan_path: visualBeatPlan?.status === "passed" ? visualBeatPlanPath : null,
      visual_style_bible_path: visualStyleBible ? visualStyleBiblePath : null,
      character_bible_path: characterBible ? characterBiblePath : null,
      episode_visual_direction_path: episodeVisualDirection.trim() ? episodeVisualDirectionPath : null,
    },
    visual_reference_scope: scope,
    style_reference_policy: shouldDropStyleRefs
      ? "style refs dropped for this run; use style bible/text guidance only"
      : "style refs allowed only as abstract rendering/material/lighting samples",
    planner: { provider: llm.provider, model: llm.model ?? null, output_path: llm.output_path ?? null, chunked: llm.chunked ?? false, chunk_count: llm.chunk_count ?? null },
    reference_budget: referenceBudget.summary,
    negative_prompt_payload_policy: "LLM-authored anchor language is preserved. Ordinary negative words are allowed in prompt anchors; separate negative prompt payloads and embedded negative-prompt sections are disallowed before provider use.",
    policy: "Reference strategy only. Manual review must approve prompt anchors before reference generation or production imagegen.",
    reference_targets: referenceTargets,
    character_state_refs: characterStateRefs,
    findings,
    warnings: [
      ...(llm.parsed.warnings ?? []),
      ...deterministicLocationScope.warnings,
      ...referenceBudget.warnings,
      ...anchorLanguageWarnings,
      ...findings,
      ...sourceFaceAnchoring.warnings,
      ...canonicalIdentityMerge.warnings,
    ],
    updated_at: new Date().toISOString(),
  };
  await writeJson(outputPath, report);
  const visualReferencePlanHash = await hashFile(outputPath);
  await writeJson(characterStateRefsOutputPath, {
    schema: "goldflow_character_state_refs_v1",
    status: "draft_needs_manual_review",
    source_visual_reference_plan_path: outputPath,
    source_script_hash: semanticPlan.source_script_hash,
    source_hashes: visualReferencePlanHash ? { [outputPath]: visualReferencePlanHash } : {},
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
