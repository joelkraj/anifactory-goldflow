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
const referenceInventoryLedgerOutputPath = flags.referenceInventory
  ?? flags["reference-inventory"]
  ?? path.join(path.dirname(outputPath), "reference_inventory_ledger.json");
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
      visible_characters: beat.visible_characters ?? [],
      mentioned_only_characters: beat.mentioned_only_characters ?? [],
      primary_subject: beat.primary_subject ?? null,
      location: beat.location ?? null,
      local_location: beat.local_location ?? beat.location ?? null,
      local_props: beat.local_props ?? beat.props ?? [],
      local_ui_elements: beat.local_ui_elements ?? beat.ui_text_on_screen ?? [],
      ref_needs: beat.ref_needs ?? beat.beat_ref_requirements ?? [],
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

function normalizeKind(kind) {
  const normalized = String(kind ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (normalized === "character") return "character_state";
  if (normalized === "effect") return "action";
  return normalized || "unknown";
}

function normalizedTokens(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function tokenOverlapScore(left, right) {
  const leftTokens = new Set(normalizedTokens(left));
  const rightTokens = new Set(normalizedTokens(right));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let score = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) score += 1;
  return score;
}

function isGenericGroupSubject(value) {
  return /\b(?:group|crowd|audience|families|guards?|officers?|fighters?|raiders?|riders?|survivors?|witnesses?|attendants?|workers?|students?|teachers?|staff|public|guild masters?|soldiers?|police|workforce|faction|uniform system|wardrobe system)\b/i.test(String(value ?? ""));
}

function inventoryRefIdFor(kind, subject, fallback = "asset") {
  const normalizedKind = normalizeKind(kind);
  const prefix = normalizedKind === "character_state"
    ? "char"
    : normalizedKind === "location"
      ? "loc"
      : normalizedKind === "ui"
        ? "ui"
        : normalizedKind === "prop"
          ? "prop"
          : normalizedKind === "action"
            ? "action"
            : normalizedKind;
  return `${prefix}_${slug(subject, fallback).replace(new RegExp(`^${prefix}_`, "i"), "")}_ref`;
}

function sceneById(scenes = []) {
  return new Map((scenes ?? []).map((scene) => [String(scene.scene_id ?? ""), scene]));
}

function beatRowsFromScopedSemantic(scopedSemantic) {
  const rows = [];
  for (const scene of scopedSemantic?.scenes ?? []) {
    const beats = Array.isArray(scene.visual_beats) && scene.visual_beats.length
      ? scene.visual_beats
      : [{
          visual_beat_id: `${scene.scene_id ?? "scene"}_semantic_context`,
          scene_id: scene.scene_id,
          parent_scene_id: scene.scene_id,
          start_sec: scene.start_sec ?? scene.startSec ?? null,
          visual_beat_script_excerpt: scene.script_excerpt ?? scene.visual_intent ?? scene.title ?? "",
          local_location: scene.location ?? null,
          location: scene.location ?? null,
          visible_characters: scene.visible_subjects ?? [],
          local_props: scene.props ?? [],
          local_ui_elements: scene.ui_text_on_screen ?? [],
          ref_needs: [],
        }];
    for (const beat of beats) {
      rows.push({
        ...beat,
        scene_id: beat.parent_scene_id ?? beat.scene_id ?? scene.scene_id,
        parent_scene_id: beat.parent_scene_id ?? beat.scene_id ?? scene.scene_id,
      });
    }
  }
  return rows;
}

function assetSources(asset) {
  return asset?.sources instanceof Set
    ? asset.sources
    : new Set(Array.isArray(asset?.sources) ? asset.sources : []);
}

function directorModeForAsset(asset) {
  const kind = normalizeKind(asset.kind);
  const sceneCount = asset.scene_ids.size;
  const beatCount = asset.beat_ids.size;
  const firstStart = Number(asset.first_start_sec);
  const inOpening = Number.isFinite(firstStart) && firstStart < 180;
  const inColdOpen = Number.isFinite(firstStart) && firstStart < 45;
  const text = `${asset.subject ?? ""} ${asset.asset_id ?? ""} ${[...asset.reasons].join(" ")}`;
  const highPriority = /\b(?:critical|signature|system|quest|status|rank|ledger|ring|receipt|contract|evidence|weapon|badge|uniform|guild|faction|police|royal|throne|crown|poison|key)\b/i.test(text);
  const highRiskContact = /\b(?:fight|restrain|shove|rescue|grab|strike|hit|slap|wrestle|tackle|physical contact|body to body|hand on|hands on)\b/i.test(text);

  if (kind === "character_state") {
    if (isGenericGroupSubject(text)) {
      return {
        role: sceneCount >= 2 || highPriority ? "uniform_or_group_visual_system" : "generic_group_or_crowd",
        generation_mode: sceneCount >= 3 || highPriority ? "derive_from_best_cut" : "no_ref_needed",
        required_before_imagegen: false,
        anchor_cut_policy: sceneCount >= 2 ? "best_clean_visible_cut" : "none",
      };
    }
    const recurring = sceneCount >= 2 || beatCount >= 3;
    const major = sceneCount >= 4 || beatCount >= 6;
    const shouldGenerate = inOpening || major || highRiskContact;
    return {
      role: shouldGenerate ? "anchor_character_or_major_state" : recurring ? "minor_recurring_character_state" : "one_scene_character_text_state",
      generation_mode: shouldGenerate ? "standalone_ref" : recurring ? "derive_from_best_cut" : "no_ref_needed",
      required_before_imagegen: shouldGenerate,
      anchor_cut_policy: recurring && !shouldGenerate ? "best_clean_visible_cut" : "none",
    };
  }
  if (kind === "location") {
    const sources = assetSources(asset);
    const onlySemanticScope = sources.has("semantic_location_scope") && sources.size === 1;
    const hasLocalBeatEvidence = beatCount > 0;
    const recurring = sceneCount >= 2 || beatCount >= 3;
    const major = sceneCount >= 4 || beatCount >= 7;
    const openingAnchor = inOpening && hasLocalBeatEvidence && (
      recurring
      || beatCount >= 3
      || (inColdOpen && highPriority && !onlySemanticScope)
    );
    const shouldGenerate = major || (highPriority && recurring && hasLocalBeatEvidence) || openingAnchor;
    const shouldDerive = recurring || (inOpening && hasLocalBeatEvidence);
    return {
      role: shouldGenerate ? "key_location_anchor" : recurring ? "minor_recurring_location" : "scene_scoped_location_text",
      generation_mode: shouldGenerate ? "standalone_ref" : shouldDerive ? "derive_from_first_clean_wide_cut" : "no_ref_needed",
      required_before_imagegen: shouldGenerate,
      anchor_cut_policy: shouldDerive && !shouldGenerate ? "first_clean_wide_cut" : "none",
    };
  }
  if (kind === "ui") {
    const signature = highPriority || /\b(?:system|quest|status|rank|level|ledger|dashboard|interface|window|panel|notification|timer|score)\b/i.test(text);
    const shouldGenerate = signature && (beatCount >= 2 || sceneCount >= 2 || inOpening);
    return {
      role: shouldGenerate ? "signature_ui_motif" : beatCount >= 2 ? "minor_recurring_ui" : "one_scene_ui_text",
      generation_mode: shouldGenerate ? "standalone_ref" : beatCount >= 2 ? "derive_from_best_cut" : "no_ref_needed",
      required_before_imagegen: shouldGenerate,
      anchor_cut_policy: beatCount >= 2 && !shouldGenerate ? "best_clean_visible_cut" : "none",
    };
  }
  if (kind === "prop" || kind === "action") {
    const recurring = sceneCount >= 2 || beatCount >= 3;
    const shouldGenerate = highPriority && (recurring || inOpening);
    return {
      role: shouldGenerate ? (kind === "prop" ? "critical_prop_anchor" : "recurring_action_or_effect_anchor") : recurring ? `minor_recurring_${kind}` : `one_scene_${kind}_text`,
      generation_mode: shouldGenerate ? "standalone_ref" : recurring ? "derive_from_best_cut" : "no_ref_needed",
      required_before_imagegen: shouldGenerate,
      anchor_cut_policy: recurring && !shouldGenerate ? "best_clean_visible_cut" : "none",
    };
  }
  return {
    role: "low_priority_reference_candidate",
    generation_mode: "no_ref_needed",
    required_before_imagegen: false,
    anchor_cut_policy: "none",
  };
}

function buildReferenceInventoryLedger(scopedSemantic, visualBeatPlan, { outputPath: ledgerPath = referenceInventoryLedgerOutputPath } = {}) {
  const semanticScenes = scopedSemantic?.scenes ?? [];
  const scenes = sceneById(semanticScenes);
  const beats = beatRowsFromScopedSemantic(scopedSemantic);
  const assets = new Map();

  function addAsset({ kind, refId, subject, sceneId, beat = null, reason = null, source = null, semanticRefId = null }) {
    const normalizedKind = normalizeKind(kind);
    if (!["character_state", "location", "prop", "ui", "action"].includes(normalizedKind)) return;
    const cleanSubject = String(subject ?? refId ?? "").trim();
    if (!cleanSubject) return;
    const assetKind = normalizedKind === "character_state" && isGenericGroupSubject(cleanSubject) ? "prop" : normalizedKind;
    let resolvedRefId = refId
      ? slug(refId)
      : inventoryRefIdFor(assetKind, cleanSubject, "asset");
    let assetId = assetKind === "character_state" && !refId
      ? inventoryRefIdFor("character_state", cleanSubject, "character").replace(/_ref$/i, "_identity")
      : resolvedRefId;
    if (!refId && assetKind === "location" && sceneId) {
      let bestLocation = null;
      for (const existing of assets.values()) {
        if (existing.kind !== "location" || !existing.scene_ids.has(sceneId)) continue;
        const score = tokenOverlapScore(cleanSubject, `${existing.subject ?? ""} ${existing.ref_id ?? ""} ${existing.asset_id ?? ""}`);
        if (score > (bestLocation?.score ?? 0)) bestLocation = { score, asset: existing };
      }
      if (bestLocation?.score >= 3) {
        assetId = bestLocation.asset.asset_id;
        resolvedRefId = bestLocation.asset.ref_id;
      }
    }
    if (!assets.has(assetId)) {
      assets.set(assetId, {
        asset_id: assetId,
        ref_id: resolvedRefId,
        kind: assetKind,
        subject: cleanSubject,
        scene_ids: new Set(),
        beat_ids: new Set(),
        semantic_ref_ids: new Set(),
        beat_ref_ids: new Set(),
        reasons: new Set(),
        sources: new Set(),
        evidence_excerpts: [],
        first_start_sec: null,
        last_start_sec: null,
      });
    }
    const row = assets.get(assetId);
    if (cleanSubject.length > String(row.subject ?? "").length && !refId) row.subject = cleanSubject;
    if (sceneId) row.scene_ids.add(sceneId);
    if (beat?.visual_beat_id) row.beat_ids.add(beat.visual_beat_id);
    if (semanticRefId) row.semantic_ref_ids.add(semanticRefId);
    if (refId) row.beat_ref_ids.add(refId);
    if (reason) row.reasons.add(String(reason).slice(0, 180));
    if (source) row.sources.add(source);
    const start = Number(beat?.start_sec ?? scenes.get(sceneId)?.start_sec ?? scenes.get(sceneId)?.startSec);
    if (Number.isFinite(start)) {
      row.first_start_sec = row.first_start_sec == null ? start : Math.min(row.first_start_sec, start);
      row.last_start_sec = row.last_start_sec == null ? start : Math.max(row.last_start_sec, start);
    }
    const excerpt = String(beat?.visual_beat_script_excerpt ?? beat?.script_excerpt ?? "").replace(/\s+/g, " ").trim();
    if (excerpt && row.evidence_excerpts.length < 3 && !row.evidence_excerpts.includes(excerpt.slice(0, 240))) {
      row.evidence_excerpts.push(excerpt.slice(0, 240));
    }
  }

  for (const scene of semanticScenes) {
    for (const req of scene.ref_requirements ?? []) {
      const kind = normalizeKind(req?.kind);
      if (!["location", "character_state", "prop", "ui", "action"].includes(kind)) continue;
      if (kind !== "location") continue;
      addAsset({
        kind,
        refId: req.ref_id,
        subject: req.subject ?? req.description ?? req.reason ?? scene.location ?? req.ref_id,
        sceneId: scene.scene_id,
        reason: req.reason ?? "semantic scoped location target",
        source: "semantic_location_scope",
        semanticRefId: req.ref_id,
      });
    }
  }

  for (const beat of beats) {
    const sceneId = beat.parent_scene_id ?? beat.scene_id;
    const visibleCharacters = Array.isArray(beat.visible_characters) ? beat.visible_characters : [];
    for (const character of visibleCharacters) {
      addAsset({
        kind: "character_state",
        refId: null,
        subject: character,
        sceneId,
        beat,
        reason: "visible local beat character",
        source: "visual_beat_visible_character",
      });
    }
    const location = beat.local_location ?? beat.location;
    if (location) {
      addAsset({
        kind: "location",
        refId: null,
        subject: location,
        sceneId,
        beat,
        reason: "local visual beat location",
        source: "visual_beat_location",
      });
    }
    for (const prop of (Array.isArray(beat.local_props) ? beat.local_props : []).slice(0, 8)) {
      addAsset({
        kind: "prop",
        refId: null,
        subject: prop,
        sceneId,
        beat,
        reason: "local visual beat prop",
        source: "visual_beat_prop",
      });
    }
    for (const ui of (Array.isArray(beat.local_ui_elements) ? beat.local_ui_elements : []).slice(0, 5)) {
      addAsset({
        kind: "ui",
        refId: null,
        subject: ui,
        sceneId,
        beat,
        reason: "local visual beat UI/system element",
        source: "visual_beat_ui",
      });
    }
    for (const need of (Array.isArray(beat.ref_needs) ? beat.ref_needs : beat.beat_ref_requirements ?? [])) {
      const kind = normalizeKind(need?.kind);
      if (!["character_state", "location", "prop", "ui", "action"].includes(kind)) continue;
      addAsset({
        kind,
        refId: need.ref_id,
        subject: need.subject ?? need.ref_id,
        sceneId,
        beat,
        reason: need.reason ?? "beat advisory ref need",
        source: "visual_beat_ref_need",
      });
    }
  }

  const rows = [...assets.values()].map((asset) => {
    const director = directorModeForAsset(asset);
    return {
      asset_id: asset.asset_id,
      ref_id: asset.ref_id,
      kind: asset.kind,
      subject: asset.subject,
      director_role: director.role,
      recommended_generation_mode: director.generation_mode,
      recommended_required_before_imagegen: director.required_before_imagegen,
      recommended_anchor_cut_policy: director.anchor_cut_policy,
      scene_ids: [...asset.scene_ids].filter(Boolean).sort(),
      beat_ids: [...asset.beat_ids].filter(Boolean).sort(),
      distinct_scene_count: asset.scene_ids.size,
      beat_count: asset.beat_ids.size,
      semantic_ref_ids: [...asset.semantic_ref_ids].filter(Boolean).sort(),
      beat_ref_ids: [...asset.beat_ref_ids].filter(Boolean).sort(),
      first_start_sec: asset.first_start_sec,
      last_start_sec: asset.last_start_sec,
      sources: [...asset.sources].sort(),
      reasons: [...asset.reasons].slice(0, 6),
      evidence_excerpts: asset.evidence_excerpts,
    };
  }).sort((left, right) =>
    (left.first_start_sec ?? 999999) - (right.first_start_sec ?? 999999)
    || String(left.kind).localeCompare(String(right.kind))
    || String(left.asset_id).localeCompare(String(right.asset_id))
  );
  const byKind = {};
  const byMode = {};
  const byRole = {};
  for (const row of rows) {
    byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
    byMode[row.recommended_generation_mode] = (byMode[row.recommended_generation_mode] ?? 0) + 1;
    byRole[row.director_role] = (byRole[row.director_role] ?? 0) + 1;
  }
  return {
    schema: "goldflow_reference_inventory_ledger_v1",
    status: "passed",
    source_script_hash: scopedSemantic.source_script_hash,
    source_artifact_paths: [
      semanticPlanPath,
      visualBeatPlan?.status === "passed" ? visualBeatPlanPath : null,
    ].filter(Boolean),
    policy: "Director inventory for visual refs. Semantic scenes are broad context and location-scope coverage; visual beats provide local transcript evidence. Only inventory-backed assets should become standalone/derived refs.",
    output_path: ledgerPath,
    summary: {
      asset_count: rows.length,
      by_kind: byKind,
      by_recommended_generation_mode: byMode,
      by_director_role: byRole,
    },
    assets: rows,
    updated_at: new Date().toISOString(),
  };
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

function compactInventoryAsset(asset, { evidenceLimit = 2, sceneIdLimit = Infinity } = {}) {
  const sceneIds = asset.scene_ids ?? [];
  const maxSceneIds = Number.isFinite(Number(sceneIdLimit)) ? Number(sceneIdLimit) : sceneIds.length;
  return {
    asset_id: asset.asset_id,
    ref_id: asset.ref_id,
    kind: asset.kind,
    subject: asset.subject,
    director_role: asset.director_role,
    recommended_generation_mode: asset.recommended_generation_mode,
    recommended_required_before_imagegen: asset.recommended_required_before_imagegen,
    recommended_anchor_cut_policy: asset.recommended_anchor_cut_policy,
    scene_ids: sceneIds.slice(0, maxSceneIds),
    scene_ids_truncated_count: Math.max(0, sceneIds.length - maxSceneIds),
    distinct_scene_count: asset.distinct_scene_count,
    beat_count: asset.beat_count,
    semantic_ref_ids: asset.semantic_ref_ids ?? [],
    first_start_sec: asset.first_start_sec,
    evidence_excerpts: (asset.evidence_excerpts ?? []).slice(0, evidenceLimit),
  };
}

function inventoryAssetHasReferenceValue(asset) {
  const mode = String(asset?.recommended_generation_mode ?? "").toLowerCase();
  if (mode && mode !== "no_ref_needed") return true;
  if (asset?.recommended_required_before_imagegen === true) return true;
  const role = String(asset?.director_role ?? "");
  return /\b(?:anchor|key|signature|critical|recurring|uniform|group_visual_system)\b/i.test(role);
}

function compactInventoryForPrompt(inventoryLedger, sceneIds = null, options = {}) {
  const wantedScenes = sceneIds ? new Set(sceneIds) : null;
  const referenceValueOnly = options.referenceValueOnly === true;
  const maxAssets = Number(options.maxAssets ?? Infinity);
  const assets = (inventoryLedger?.assets ?? [])
    .filter((asset) => !wantedScenes || (asset.scene_ids ?? []).some((sceneId) => wantedScenes.has(sceneId)))
    .filter((asset) => !referenceValueOnly || inventoryAssetHasReferenceValue(asset))
    .slice(0, Number.isFinite(maxAssets) ? maxAssets : undefined)
    .map((asset) => compactInventoryAsset(asset, {
      evidenceLimit: Number(options.evidenceLimit ?? 2),
      sceneIdLimit: Number(options.sceneIdLimit ?? Infinity),
    }));
  const includeGlobalSelection = options.includeGlobalSelection === true;
  const globalSelectedAssets = includeGlobalSelection
    ? (inventoryLedger?.assets ?? [])
        .filter(inventoryAssetHasReferenceValue)
        .slice(0, Number(flags["visual-ref-global-context-max-assets"] ?? 160))
        .map((asset) => compactInventoryAsset(asset, { evidenceLimit: 1, sceneIdLimit: Number(options.globalSceneIdLimit ?? 24) }))
    : [];
  return {
    schema: inventoryLedger?.schema ?? "goldflow_reference_inventory_ledger_v1",
    summary: inventoryLedger?.summary ?? null,
    chunk_scene_ids: sceneIds ?? null,
    global_selected_assets: globalSelectedAssets,
    assets,
  };
}

function buildPrompt(semanticPlan, { chunkLabel = null, guidance = {}, inventoryLedger = null } = {}) {
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
- This stage is the cast/location/prop/UI director. It decides reference strategy only. It does not write final image prompts.
- Use REFERENCE DIRECTOR LEDGER as the primary source for asset economy. Semantic scenes are broad context and location-scope coverage; visual beats are local transcript evidence. Do not treat raw semantic ref_requirements or beat hints as automatic reference targets.
- In chunked mode, REFERENCE DIRECTOR LEDGER includes "assets" for the current chunk plus "global_selected_assets" for the whole episode. Reuse the exact global asset_id/ref_id when an asset is already planned elsewhere. Do not invent a duplicate local ref for the same character, location, prop, UI, uniform, or action system.
- For chunked output, return only current-chunk ledger assets that need attachable reference strategy, plus exact semantic location coverage targets needed for scene scoping. Non-location assets whose ledger mode is no_ref_needed should usually stay only in the inventory ledger, not in reference_targets.
- Every generated or derived reference target should trace to a ledger asset through inventory_asset_id or the same ref_id. If you add an extra target, it must be a director-level merge/split justified by recurrence, critical story value, or high identity risk.
- Prefer a small coherent asset strategy over exhaustive coverage. The goal is consistency leverage, not collecting every noun.
- Identify recurring characters, character states, major locations, important props, UI motifs, and high-risk repeated action states.
- Resolve role/title aliases to canonical named characters when the script or semantic scenes establish that relationship. If a named person is also the dean, boss, chairman, judge, professor, host, rival, spouse, parent, or another title, do not create a separate generic character ref for later role-only mentions. Expand the existing named character's state/scope instead.
- For real named public creators, streamers, celebrities, or influencers whose likeness matters, request a face-only source identity anchor before the episode character-state ref is generated. Do not rely on text-only "inspired by" likeness prompts for production. The source anchor supplies facial likeness only; the character-state ref supplies wardrobe, pose, body state, and anime/manhwa styling.
- Use each scene's visual_beats when present. A named character that appears in a beat excerpt through replay footage, livestream panels, phone screens, broadcast feeds, camera files, dossiers, avatars, or video walls still needs current-scene reference coverage if their likeness may be visible in that cut.
- When visual_beats carry ref_needs or beat_ref_requirements, treat those as advisory local transcript-timed evidence, not locked reference targets. Semantic scene ref_requirements remain broad scene coverage. The LLM decides the final episode-level reference strategy and may merge, downgrade, upgrade, rename, or replace beat suggestions when the story context supports it.
- Do not preserve beat-authored generation_mode mechanically. Use it as a hint only. Final generation_mode belongs to this reference-planning stage after considering recurrence, story criticality, identity risk, opening-retention value, and whether a clean scene cut can become the reference later.
- Distinguish named characters from groups, factions, crowds, and uniforms. A recurring named person gets a character_state/base identity ref when needed. A visible group such as guild masters, guards, families, students, witnesses, or crowds should not become a character identity ref unless a specific named member recurs. If the group has a recognizable uniform, faction styling, badge, armor set, or wardrobe system, prefer a uniform/faction/action/prop-style reference or derive_from_best_cut rather than a face/identity character ref.
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
- Major recurring locations may use standalone_ref or derive_from_first_clean_wide_cut. A small number of opening-retention physical environment anchors may use standalone_ref when they carry multiple beats or major visual clarity risk, but do not upgrade every one-scene opening sublocation to standalone just because it is early. Prefer derive_from_first_clean_wide_cut or no_ref_needed for one-scene scoped locations.
- Do not merge visually distinct sublocations into one broad location ref just because they share a building, campus, city, company, palace, arena, or venue name. If consecutive scenes or a long story span moves between different visible areas, create separate scene-scoped location refs for those areas, such as entrance, hallway, main room, screen wall, table area, plaza, roof, basement, server room, witness stand, audience floor, or exterior approach. Use the semantic scene location/ref_requirements as the source of scope; code will validate scene_ids and will not invent replacement locations later.
- Semantic scene ref_requirements with kind "location" are binding target IDs for scene scoping only. For every required location ref_id in a scene, return a location reference_target with that exact ref_id covering that scene, but choose generation_mode from production value: standalone only for key recurring/major locations, derive_from_best_cut for useful minor recurring locations, and no_ref_needed for one-scene locations. Broad venue refs may be added, but they must not replace the exact required scene-level location ref_id.
- Long same-venue arcs need enough scoped location refs for editorial variety. A single location ref should not be expected to carry many minutes of visually distinct beats after the retention runway when the semantic scene locations name different physical areas.
- Return only valid JSON.

VISUAL BIBLES AND OPERATOR DIRECTION:
${visualGuidanceBlock(guidance)}

REFERENCE DIRECTOR LEDGER:
${JSON.stringify(compactInventoryForPrompt(inventoryLedger, (semanticPlan.scenes ?? []).map((scene) => scene.scene_id), { includeGlobalSelection: Boolean(chunkLabel) }), null, 2)}

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
      "manual_review_required": true,
      "inventory_asset_id": "matching reference_inventory_ledger asset_id",
      "director_role": "anchor_character_or_major_state|key_location_anchor|signature_ui_motif|critical_prop_anchor|minor_recurring_location|one_scene_location_text|etc"
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

function buildMergePrompt(semanticPlan, chunkPlans, guidance = {}, inventoryLedger = null) {
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
      inventory_asset_id: target.inventory_asset_id ?? null,
      director_role: target.director_role ?? null,
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
- Qwen authors the merged director plan. Code validates schema, scope, and whether generated refs trace to the director inventory.
- Use REFERENCE DIRECTOR LEDGER as the primary source for asset economy. Semantic scenes are broad context and location-scope coverage; visual beats are local transcript evidence. Do not preserve every chunk target just because it was mentioned.
- The merged output should feel like a human art director chose the cast, location, prop, UI, uniform/faction, and action references that actually buy consistency.
- Treat chunk plans as proposals against the director ledger, not as a shopping list. Keep only targets that trace to inventory assets with reference value, exact semantic location coverage targets, or a clearly justified merge/split. If several chunks propose the same asset under different names, keep the ledger asset_id/ref_id and fold scene_ids together.
- Merge duplicate character/location/prop/UI/action targets across chunks.
- Resolve role/title aliases to canonical named characters when the script or semantic scenes establish that relationship. If a named person is also the dean, boss, chairman, judge, professor, host, rival, spouse, parent, or another title, do not create a separate generic character ref for later role-only mentions. Expand the existing named character's state/scope instead.
- For real named public creators, streamers, celebrities, or influencers whose likeness matters, preserve or request face-only source identity anchors and use those anchors as base_identity_ref_id for the generated anime/manhwa character-state refs. Do not merge these into generic role refs or text-only lookalikes.
- Preserve all relevant scene_ids from the chunk plans.
- Keep generation_mode decisions coherent at episode level. Semantic ref_requirements are scoped target candidates; they are not automatic standalone-generation requirements.
- Write normal descriptive prompt anchors that preserve story-faithful UI labels, status phrases, and concise absence states when they are the point of the reference.
- Do not create separate negative_prompt, avoid_list, or exclude_list payloads. Keep provider-facing content in the normal prompt anchor.
- Convert risks into concrete construction when helpful: exact visible subject count, role, pose, action direction, wardrobe construction, frame composition, and location details.
- Use each scene's visual_beats when present. A named character that appears in a beat excerpt through replay footage, livestream panels, phone screens, broadcast feeds, camera files, dossiers, avatars, or video walls still needs current-scene reference coverage if their likeness may be visible in that cut.
- When visual_beats carry ref_needs or beat_ref_requirements, treat those as advisory local transcript-timed evidence, not locked reference targets. Semantic scene ref_requirements remain broad scene coverage. The LLM decides the final episode-level reference strategy and may merge, downgrade, upgrade, rename, or replace beat suggestions when the story context supports it.
- Do not preserve beat-authored generation_mode mechanically. Use it as a hint only. Final generation_mode belongs to this reference-planning stage after considering recurrence, story criticality, identity risk, opening-retention value, and whether a clean scene cut can become the reference later.
- Distinguish named characters from groups, factions, crowds, and uniforms. A recurring named person gets a character_state/base identity ref when needed. A visible group such as guild masters, guards, families, students, witnesses, or crowds should not become a character identity ref unless a specific named member recurs. If the group has a recognizable uniform, faction styling, badge, armor set, or wardrobe system, prefer a uniform/faction/action/prop-style reference or derive_from_best_cut rather than a face/identity character ref.
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
- Do not upgrade every one-scene opening sublocation to standalone solely because it is early. Standalone opening locations should be a small curated set with real multi-beat clarity value; other scoped locations can be derive_from_first_clean_wide_cut or no_ref_needed.
- Any named human character who physically touches, fights, restrains, shoves, carries, rescues, grabs, strikes, escorts, wrestles, or otherwise has real body-contact interaction with a recurring protagonist should use standalone_ref before imagegen, even if they appear in only one scene. Contact scenes are high identity-blend risk.
- Being merely beside, watching, confronting verbally, appearing on a screen, or sharing a two-character frame is not by itself enough for a one-scene standalone ref; use base identity text or derive_from_best_cut unless distinct identity continuity is mission-critical.
- Do not merge visually distinct sublocations into one broad location ref just because they share a building, campus, city, company, palace, arena, or venue name. If chunk plans contain separate visible areas inside one larger venue, preserve or create separate scene-scoped location refs for those areas during merge, such as entrance, hallway, main room, screen wall, table area, plaza, roof, basement, server room, witness stand, audience floor, or exterior approach. Use the semantic scene location/ref_requirements as the source of scope; code will validate scene_ids and will not invent replacement locations later.
- Preserve exact semantic location ref_ids during merge. If a chunk plan or semantic scene requires a location ref_id, the merged plan must keep a location reference_target with that exact ref_id and scene coverage, even when a broader venue ref is also present. The preserved target can still be no_ref_needed or derive_from_best_cut when it is a one-off/minor scoped target.
- Long same-venue arcs need enough scoped location refs for editorial variety. A single location ref should not be expected to carry many minutes of visually distinct beats after the retention runway when the semantic scene locations name different physical areas.
- Return only valid JSON.

VISUAL BIBLES AND OPERATOR DIRECTION:
${visualGuidanceBlock(guidance)}

REFERENCE DIRECTOR LEDGER:
${JSON.stringify(compactInventoryForPrompt(inventoryLedger, null, { referenceValueOnly: true, maxAssets: Number(flags["visual-ref-merge-ledger-max-assets"] ?? 320), evidenceLimit: 0, sceneIdLimit: 18 }), null, 2)}

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
      "manual_review_required": true,
      "inventory_asset_id": "matching reference_inventory_ledger asset_id",
      "director_role": "anchor_character_or_major_state|key_location_anchor|signature_ui_motif|critical_prop_anchor|minor_recurring_location|one_scene_location_text|etc"
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
  const reuseChunks = flags["visual-ref-reuse-codex-chunks"] === "true";
  if (reuseChunks && /_chunk_\d+$/i.test(stageName)) {
    const entries = (await fs.readdir(callDir).catch(() => []))
      .filter((name) => name.endsWith(`-${stageName}-output.txt`))
      .sort()
      .reverse();
    for (const name of entries) {
      const cachedPath = path.join(callDir, name);
      const content = await fs.readFile(cachedPath, "utf8").catch(() => "");
      if (!content.trim()) continue;
      try {
        const parsed = extractJson(content);
        console.error(`visual refs ${stageName}: reused cached Codex chunk output ${cachedPath}`);
        return { provider: "codex", model: "codex_cli_default", output_path: cachedPath, content, parsed, reused_cached_output: true };
      } catch {}
    }
  }
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
    inventory_asset_id: target.inventory_asset_id ?? target.reference_inventory_asset_id ?? null,
    director_role: target.director_role ?? null,
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

function referenceBudgetOpeningSecFromRun(runIdentity = null) {
  const value = Number(
    flags["reference-opening-sec"]
    ?? runIdentity?.reference_budget_opening_sec
    ?? runIdentity?.reference_budget?.opening_sec
    ?? 180
  );
  return Number.isFinite(value) && value > 0 ? value : 180;
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

function generatedReferenceSummary(profile, applied, openingSec, referenceTargets) {
  const summary = {
    profile,
    applied,
    opening_sec: openingSec,
    generated_target_count: 0,
    downgraded_target_count: 0,
    by_kind: {},
  };
  for (const target of referenceTargets) {
    const kind = String(target.kind ?? "unknown").toLowerCase();
    if (!summary.by_kind[kind]) summary.by_kind[kind] = { generate: 0, downgrade: 0 };
    if (target.required_before_imagegen === true || target.generation_mode === "standalone_ref" || target.generation_mode === "manual_review") {
      summary.generated_target_count += 1;
      summary.by_kind[kind].generate += 1;
    } else {
      summary.downgraded_target_count += 1;
      summary.by_kind[kind].downgrade += 1;
    }
  }
  return summary;
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
  const genericGroupIdentity = kind === "character_state" && /\b(?:group|crowd|audience|families|guards?|officers?|fighters?|raiders?|riders?|survivors?|witnesses?|attendants?|workers?|public|uniform system|wardrobe system)\b/i.test(anchorText);
  const bundledMinorProp = (kind === "prop" || kind === "action" || kind === "effect") && (/\bminor\b/i.test(anchorText) || String(target.subject ?? "").split(",").length >= 4);
  if (kind === "style") return { generate: false, mode: "no_ref_needed", reason: "candidate validation uses style text/bible instead of spending a style ref" };
  if (kind === "character_state") {
    if (genericGroupIdentity && !baseIdentity) {
      return { generate: false, mode: recurringAcrossScenes ? "derive_from_best_cut" : "no_ref_needed", reason: "generic groups, crowds, uniforms, and wardrobe systems are not standalone character identity refs for candidate validation" };
    }
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
    const generate = inOpening || (recurringAcrossScenes && (majorRecurringAcrossScenes || highPriority));
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
    const generate = !bundledMinorProp && (majorRecurringAcrossScenes || (highPriority && recurringAcrossScenes && stats.appearance_count >= 4));
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

function characterGeneratedScore(target, timingIndex, openingSec) {
  const stats = referenceTargetStats(target, timingIndex);
  const text = `${target.ref_id ?? ""} ${target.subject ?? ""} ${target.prompt_anchor ?? ""}`;
  let score = 0;
  if (target.reference_image_path) score += 1000;
  if (isExplicitBaseIdentityTarget(target)) score += 500;
  if (isGenericCharacterIdentityTarget(target)) score += 220;
  if (Number.isFinite(stats.earliest_start_sec) && stats.earliest_start_sec < openingSec) score += 120;
  score += Math.min(160, stats.scene_count * 18);
  score += Math.min(120, stats.appearance_count * 12);
  if (/\b(?:base|identity|core|main|protagonist|antagonist|ally)\b/i.test(text)) score += 60;
  if (/\b(?:courtroom|tribunal|memory|projection|flashback|one[- ]scene|single[- ]scene|crowd|group|audience|families|witnesses)\b/i.test(text)) score -= 80;
  if (String(target.priority ?? "").match(/^(?:high|critical|signature)$/i)) score += 30;
  return score;
}

function applyCandidateCharacterStateGenerationCap(referenceTargets, timingIndex, openingSec) {
  const generated = referenceTargets.filter((target) =>
    String(target.kind ?? "").toLowerCase() === "character_state"
    && (target.required_before_imagegen === true || target.generation_mode === "standalone_ref" || target.generation_mode === "manual_review")
  );
  const groups = new Map();
  for (const target of generated) {
    const key = identityMergeKey(target) ?? String(target.ref_id ?? target.subject ?? "unknown");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(target);
  }
  if (!groups.size) return { referenceTargets, downgraded: [], warnings: [] };
  const groupWeights = [...groups.entries()].map(([key, rows]) => ({
    key,
    row_count: rows.length,
    total_scene_count: rows.reduce((sum, row) => sum + referenceTargetStats(row, timingIndex).scene_count, 0),
    total_appearance_count: rows.reduce((sum, row) => sum + referenceTargetStats(row, timingIndex).appearance_count, 0),
  })).sort((a, b) =>
    b.total_scene_count - a.total_scene_count
    || b.total_appearance_count - a.total_appearance_count
    || b.row_count - a.row_count
  );
  const primaryKey = groupWeights[0]?.key ?? null;
  const keepIds = new Set();
  const downgradedIds = new Set();
  const warnings = [];
  for (const group of groupWeights) {
    const rows = groups.get(group.key) ?? [];
    const cap = group.key === primaryKey
      ? 4
      : group.total_scene_count >= 10 || group.total_appearance_count >= 14
        ? 2
        : 1;
    const sorted = [...rows].sort((a, b) =>
      characterGeneratedScore(b, timingIndex, openingSec) - characterGeneratedScore(a, timingIndex, openingSec)
      || String(a.ref_id).localeCompare(String(b.ref_id))
    );
    for (const row of sorted.slice(0, cap)) keepIds.add(row.ref_id);
    for (const row of sorted.slice(cap)) downgradedIds.add(row.ref_id);
    if (sorted.length > cap) {
      warnings.push({
        code: "candidate_character_state_generation_cap",
        severity: "info",
        character_key: group.key,
        kept_count: cap,
        downgraded_count: sorted.length - cap,
        message: `Candidate reference budget kept ${cap} generated character-state refs for ${group.key} and downgraded ${sorted.length - cap} extra state variants to derive-from-cut.`,
      });
    }
  }
  if (!downgradedIds.size) return { referenceTargets, downgraded: [], warnings };
  const nextTargets = referenceTargets.map((target) => {
    if (!downgradedIds.has(target.ref_id)) return target;
    return {
      ...target,
      generation_mode: target.reference_image_path ? "source_only" : "derive_from_best_cut",
      required_before_imagegen: false,
      manual_review_required: false,
      reference_budget: {
        ...(target.reference_budget ?? {}),
        decision: "downgraded_by_character_generation_cap",
        reason: "candidate validation caps generated character-state refs per canonical identity; this state should derive from a clean cut or prompt text",
      },
    };
  });
  return {
    referenceTargets: nextTargets,
    downgraded: [...downgradedIds],
    warnings,
  };
}

function applyReferenceBudgetProfile(referenceTargets, scopedSemantic, runIdentity) {
  const profile = referenceBudgetProfile(runIdentity);
  const timingIndex = sceneTimingIndex(scopedSemantic.scenes ?? []);
  const openingSec = referenceBudgetOpeningSecFromRun(runIdentity);
  if (!/^candidate[_-]validation$/i.test(profile)) {
    return {
      referenceTargets,
      summary: generatedReferenceSummary(profile, false, openingSec, referenceTargets),
      warnings: [],
    };
  }
  let nextTargets = referenceTargets.map((target) => {
    const stats = referenceTargetStats(target, timingIndex);
    const decision = targetShouldGenerateForCandidate(target, stats, openingSec);
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
      return {
        ...next,
        generation_mode: target.generation_mode === "manual_review" ? "manual_review" : "standalone_ref",
        required_before_imagegen: true,
      };
    }
    return {
      ...next,
      generation_mode: target.reference_image_path ? "source_only" : (decision.mode ?? "no_ref_needed"),
      required_before_imagegen: false,
      manual_review_required: false,
    };
  });
  const characterCap = applyCandidateCharacterStateGenerationCap(nextTargets, timingIndex, openingSec);
  nextTargets = characterCap.referenceTargets;
  const summary = generatedReferenceSummary(profile, true, openingSec, nextTargets);
  return {
    referenceTargets: nextTargets,
    summary,
    warnings: [
      {
        code: "reference_budget_profile_applied",
        severity: "info",
        message: `Candidate validation reference budget kept ${summary.generated_target_count} generated refs and downgraded ${summary.downgraded_target_count} text-only or derive-from-cut scoped targets.`,
        profile,
        opening_sec: openingSec,
      },
      ...characterCap.warnings,
    ],
  };
}

function generatedOrAttachableTarget(target) {
  const mode = String(target?.generation_mode ?? "").toLowerCase();
  return Boolean(target?.reference_image_path)
    || target?.required_before_imagegen === true
    || mode === "standalone_ref"
    || mode === "manual_review"
    || mode === "source_only"
    || /^derive_from_/i.test(mode);
}

function directorInventoryLookup(inventoryLedger) {
  const byAssetId = new Map();
  const byRefId = new Map();
  const rows = inventoryLedger?.assets ?? [];
  for (const asset of rows) {
    if (asset.asset_id) byAssetId.set(String(asset.asset_id), asset);
    if (asset.ref_id) byRefId.set(String(asset.ref_id), asset);
    for (const refId of asset.semantic_ref_ids ?? []) byRefId.set(String(refId), asset);
    for (const refId of asset.beat_ref_ids ?? []) byRefId.set(String(refId), asset);
  }
  return { rows, byAssetId, byRefId };
}

function matchDirectorAsset(target, inventoryLedger) {
  const lookup = directorInventoryLookup(inventoryLedger);
  const explicitAssetId = String(target.inventory_asset_id ?? "").trim();
  if (explicitAssetId && lookup.byAssetId.has(explicitAssetId)) return lookup.byAssetId.get(explicitAssetId);
  const refId = String(target.ref_id ?? "").trim();
  if (refId && lookup.byRefId.has(refId)) return lookup.byRefId.get(refId);
  const kind = normalizeKind(target.kind);
  const subject = `${target.subject ?? ""} ${target.prompt_anchor ?? ""}`;
  let best = null;
  for (const asset of lookup.rows) {
    if (normalizeKind(asset.kind) !== kind) continue;
    const score = tokenOverlapScore(subject, `${asset.subject ?? ""} ${asset.asset_id ?? ""} ${asset.ref_id ?? ""}`);
    if (score > (best?.score ?? 0)) best = { score, asset };
  }
  return best?.score >= 2 ? best.asset : null;
}

function applyDirectorInventoryPolicy(referenceTargets, characterStateRefs, inventoryLedger) {
  const warnings = [];
  const nextTargets = [];
  const prunedTargetIds = new Set();
  for (const target of referenceTargets) {
    const kind = normalizeKind(target.kind);
    const asset = matchDirectorAsset(target, inventoryLedger);
    let next = { ...target };
    if (next.canonical_identity_ref_id && !next.reference_image_path) {
      next = {
        ...next,
        generation_mode: "no_ref_needed",
        required_before_imagegen: false,
        manual_review_required: false,
        reference_inventory_policy: {
          decision: "pruned_canonical_identity_duplicate",
          reason: `canonical identity duplicate merged into ${next.canonical_identity_ref_id}`,
        },
      };
    }
    const genericGroupCharacterIdentity = kind === "character_state"
      && isGenericGroupSubject(`${target.subject ?? ""} ${target.prompt_anchor ?? ""}`)
      && !target.reference_image_path;
    if (genericGroupCharacterIdentity) {
      next = {
        ...next,
        generation_mode: "no_ref_needed",
        required_before_imagegen: false,
        manual_review_required: false,
        reference_inventory_policy: {
          decision: "downgraded_generic_group_character_identity",
          reason: "generic groups, crowds, factions, and uniforms must not remain character identity refs",
        },
      };
      warnings.push({
        code: "generic_group_character_identity_pruned",
        severity: "warning",
        ref_id: target.ref_id,
        message: `Target ${target.ref_id} describes a generic group/uniform system as a character_state ref; downgraded so ref planning can use a uniform/faction/prop/action ref when needed.`,
      });
    }
    const oneSceneLocalCharacterVariant = kind === "character_state"
      && !isExplicitBaseIdentityTarget(next)
      && !isGenericCharacterIdentityTarget(next)
      && (Array.isArray(next.scene_ids) ? next.scene_ids.length : 0) <= 1
      && !/\b(?:fight|restrain|shove|rescue|grab|strike|hit|slap|wrestle|tackle|physical contact|body[- ]?to[- ]?body|hand on|hands on)\b/i.test(`${next.subject ?? ""} ${next.prompt_anchor ?? ""} ${(next.risk_notes ?? []).join(" ")}`);
    if (asset && !next.canonical_identity_ref_id && !oneSceneLocalCharacterVariant && !genericGroupCharacterIdentity) {
      next.inventory_asset_id = asset.asset_id;
      next.director_role = next.director_role ?? asset.director_role;
      next.director_recommended_generation_mode = asset.recommended_generation_mode;
      next.director_recommended_required_before_imagegen = asset.recommended_required_before_imagegen;
      if (!next.reference_image_path && String(next.generation_mode ?? "").toLowerCase() !== "source_only") {
        const recommendedMode = String(asset.recommended_generation_mode ?? "").trim();
        const modeChanged = recommendedMode && recommendedMode !== next.generation_mode;
        if (recommendedMode && generationModes.has(recommendedMode)) {
          next.generation_mode = recommendedMode;
          next.required_before_imagegen = asset.recommended_required_before_imagegen === true;
          next.anchor_cut_policy = asset.recommended_anchor_cut_policy ?? next.anchor_cut_policy ?? "none";
          next.manual_review_required = next.required_before_imagegen || /^derive_from_/i.test(recommendedMode);
          if (modeChanged) {
            warnings.push({
              code: "director_inventory_generation_mode_applied",
              severity: "info",
              ref_id: target.ref_id,
              inventory_asset_id: asset.asset_id,
              generation_mode: recommendedMode,
              message: `Applied director inventory generation mode ${recommendedMode} to ${target.ref_id}.`,
            });
          }
        }
      }
    }
    const wantsGeneration = generatedOrAttachableTarget(next) && !next.reference_image_path && String(next.generation_mode ?? "").toLowerCase() !== "source_only";
    if (!asset && wantsGeneration && kind !== "style") {
      next = {
        ...next,
        generation_mode: "no_ref_needed",
        required_before_imagegen: false,
        manual_review_required: false,
        reference_inventory_policy: {
          decision: "downgraded_untraced_generated_target",
          reason: "generated/derived ref target did not trace to the director inventory ledger",
        },
      };
      warnings.push({
        code: "reference_target_not_in_director_inventory",
        severity: "warning",
        ref_id: target.ref_id,
        kind,
        message: `Target ${target.ref_id} requested generated reference spend but did not trace to reference_inventory_ledger.json; downgraded to no_ref_needed.`,
      });
    }
    const noRef = String(next.generation_mode ?? "").toLowerCase() === "no_ref_needed"
      && next.required_before_imagegen !== true
      && !next.reference_image_path;
    if (noRef && kind !== "location") {
      prunedTargetIds.add(next.ref_id);
      warnings.push({
        code: "director_pruned_text_only_reference_target",
        severity: "info",
        ref_id: next.ref_id,
        kind,
        message: `Pruned text-only ${kind} target ${next.ref_id} from visual_reference_plan; it remains represented in reference_inventory_ledger.json when useful as context.`,
      });
      continue;
    }
    nextTargets.push(next);
  }

  const targetById = new Map(nextTargets.map((target) => [target.ref_id, target]));
  const nextStateRefs = [];
  for (const ref of characterStateRefs) {
    const sourceTarget = targetById.get(ref.source_ref_id) ?? targetById.get(ref.state_ref_id);
    const baseTarget = targetById.get(ref.base_identity_ref_id);
    if (sourceTarget && generatedOrAttachableTarget(sourceTarget)) {
      nextStateRefs.push(ref);
      continue;
    }
    if (baseTarget && generatedOrAttachableTarget(baseTarget)) {
      nextStateRefs.push({
        ...ref,
        source_ref_id: baseTarget.ref_id,
        base_identity_ref_id: baseTarget.ref_id,
        identity_usage: "face_only",
      });
      continue;
    }
    warnings.push({
      code: "director_pruned_text_only_character_state_ref",
      severity: "info",
      state_ref_id: ref.state_ref_id,
      source_ref_id: ref.source_ref_id,
      message: `Pruned character_state_ref ${ref.state_ref_id} because its source target is text-only or absent from the director-approved reference target set.`,
    });
  }

  return {
    referenceTargets: nextTargets,
    characterStateRefs: nextStateRefs,
    warnings,
    prunedTargetIds: [...prunedTargetIds],
  };
}

function pruneChunkPlanWithDirectorInventory(plan, inventoryLedger) {
  const referenceTargets = (Array.isArray(plan?.reference_targets) ? plan.reference_targets : []).map(normalizeTarget);
  const characterStateRefs = (Array.isArray(plan?.character_state_refs) ? plan.character_state_refs : []).map(normalizeStateRef);
  const policy = applyDirectorInventoryPolicy(referenceTargets, characterStateRefs, inventoryLedger);
  return {
    ...plan,
    reference_targets: policy.referenceTargets,
    character_state_refs: policy.characterStateRefs,
    warnings: [
      ...(Array.isArray(plan?.warnings) ? plan.warnings : []),
      ...policy.warnings.map((warning) => ({
        ...warning,
        source: "chunk_director_inventory_policy",
      })),
    ],
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

function priorityRank(priority) {
  const value = String(priority ?? "").toLowerCase();
  if (value === "required") return 4;
  if (value === "high") return 3;
  if (value === "medium") return 2;
  if (value === "low") return 1;
  return 0;
}

function strongerPriority(left, right) {
  return priorityRank(right) > priorityRank(left) ? right : left;
}

function deterministicMergeChunkPlans(chunkPlans, inventoryLedger, mergeWarnings = []) {
  const inventory = directorInventoryLookup(inventoryLedger);
  const targetsByKey = new Map();
  for (const rawTarget of chunkPlans.flatMap((plan) => plan.reference_targets ?? [])) {
    const target = normalizeTarget(rawTarget);
    const key = String(target.inventory_asset_id ?? target.ref_id ?? "").trim() || target.ref_id;
    const inventoryAsset = key ? inventory.byAssetId.get(key) : null;
    const refId = inventoryAsset?.ref_id ?? target.ref_id;
    const next = {
      ...target,
      ref_id: refId,
      inventory_asset_id: inventoryAsset?.asset_id ?? target.inventory_asset_id ?? key,
      director_role: target.director_role ?? inventoryAsset?.director_role ?? null,
    };
    if (!targetsByKey.has(key)) {
      targetsByKey.set(key, next);
      continue;
    }
    const previous = targetsByKey.get(key);
    targetsByKey.set(key, {
      ...previous,
      ...next,
      ref_id: previous.ref_id ?? next.ref_id,
      subject: String(previous.subject ?? "").length >= String(next.subject ?? "").length ? previous.subject : next.subject,
      scene_ids: [...new Set([...(previous.scene_ids ?? []), ...(next.scene_ids ?? [])].filter(Boolean))].sort(),
      priority: strongerPriority(previous.priority, next.priority),
      required_before_imagegen: Boolean(previous.required_before_imagegen || next.required_before_imagegen),
      manual_review_required: previous.manual_review_required === true || next.manual_review_required === true,
      prompt_anchor: String(previous.prompt_anchor ?? "").length >= String(next.prompt_anchor ?? "").length ? previous.prompt_anchor : next.prompt_anchor,
      appearance_count: Math.max(Number(previous.appearance_count ?? 0), Number(next.appearance_count ?? 0)),
      risk_notes: [...new Set([...(previous.risk_notes ?? []), ...(next.risk_notes ?? [])].filter(Boolean))].slice(0, 8),
      reference_image_path: previous.reference_image_path ?? next.reference_image_path ?? null,
      inventory_asset_id: previous.inventory_asset_id ?? next.inventory_asset_id ?? null,
      director_role: previous.director_role ?? next.director_role ?? null,
    });
  }
  return {
    reference_targets: [...targetsByKey.values()],
    character_state_refs: mergeArraysById(
      chunkPlans.flatMap((plan) => plan.character_state_refs ?? []).map((ref) => normalizeStateRef(ref)),
      "state_ref_id"
    ),
    warnings: [
      ...mergeWarnings,
      {
        code: "deterministic_inventory_merge_applied",
        severity: "info",
        message: "Merged chunk visual reference plans by inventory_asset_id/ref_id and deferred generation-mode normalization to budget/director validation.",
      },
      ...chunkPlans.flatMap((plan) => Array.isArray(plan.warnings) ? plan.warnings : []),
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

async function createReferencePlan(semanticPlan, stageName, guidance = {}, inventoryLedger = null) {
  const useLocalRoute = isLocalLLMRoute(stageName);
  const useChunking = flags["visual-ref-chunking"] !== "false"
    && semanticPlan.scenes.length > Number(flags["visual-ref-single-call-max-scenes"] ?? 12);
  if (!useChunking) {
    const prompt = buildPrompt(semanticPlan, { guidance, inventoryLedger });
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
    const prompt = buildPrompt(chunkSemanticPlan, { chunkLabel: `chunk ${index + 1} of ${sceneChunks.length}`, guidance, inventoryLedger });
    const chunkStageName = `${stageName}_chunk_${String(index + 1).padStart(2, "0")}`;
    const llm = useLocalRoute
      ? await callLocal(prompt, chunkStageName, Number(flags["visual-ref-chunk-max-tokens"] ?? 7000))
      : await callCodex(prompt, chunkStageName);
    if (!Array.isArray(llm.parsed.reference_targets) || !llm.parsed.reference_targets.length) {
      throw new Error(`Visual reference chunk ${index + 1}/${sceneChunks.length} returned no reference_targets.`);
    }
    const rawTargetCount = llm.parsed.reference_targets.length;
    const prunedChunk = pruneChunkPlanWithDirectorInventory(llm.parsed, inventoryLedger);
    if (!Array.isArray(prunedChunk.reference_targets) || !prunedChunk.reference_targets.length) {
      throw new Error(`Visual reference chunk ${index + 1}/${sceneChunks.length} had no director-approved reference targets after inventory pruning.`);
    }
    chunkPlans.push(prunedChunk);
    console.error(`visual refs chunk ${index + 1}/${sceneChunks.length}: accepted ${rawTargetCount} raw targets, kept ${prunedChunk.reference_targets.length} director targets`);
  }
  console.error(`visual refs merge: ${chunkPlans.length} chunk plans`);
  if (String(flags["visual-ref-merge-mode"] ?? "").toLowerCase() === "deterministic") {
    const parsed = deterministicMergeChunkPlans(chunkPlans, inventoryLedger);
    return {
      provider: "deterministic",
      model: "inventory_union",
      output_path: null,
      chunked: true,
      chunk_count: sceneChunks.length,
      parsed,
      json_attempt: null,
    };
  }
  const mergePrompt = buildMergePrompt(semanticPlan, chunkPlans, guidance, inventoryLedger);
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
  const referenceInventoryLedger = buildReferenceInventoryLedger(scopedSemantic, visualBeatPlan, {
    outputPath: referenceInventoryLedgerOutputPath,
  });
  await writeJson(referenceInventoryLedgerOutputPath, referenceInventoryLedger);
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
    : await createReferencePlan(scopedSemantic, stageName, guidance, referenceInventoryLedger);
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
  const directorInventoryPolicy = applyDirectorInventoryPolicy(referenceTargets, characterStateRefs, referenceInventoryLedger);
  referenceTargets = directorInventoryPolicy.referenceTargets;
  characterStateRefs = directorInventoryPolicy.characterStateRefs;
  const anchorLanguageWarnings = negativePromptPayloadAnchorWarnings(referenceTargets, characterStateRefs);
  const coverageFindings = locationCoverageFindings(referenceTargets, scopedSemantic.scenes);
  const styleFindings = shouldDropStyleRefs ? [] : styleReferenceContaminationFindings(referenceTargets);
  const findings = [...coverageFindings, ...styleFindings];
  const status = findings.some((finding) => finding.severity === "blocker") ? "blocked" : "passed";
  const sourceArtifactPaths = [
    semanticPlanPath,
    visualBeatPlan?.status === "passed" ? visualBeatPlanPath : null,
    referenceInventoryLedgerOutputPath,
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
      reference_inventory_ledger_path: referenceInventoryLedgerOutputPath,
      visual_style_bible_path: visualStyleBible ? visualStyleBiblePath : null,
      character_bible_path: characterBible ? characterBiblePath : null,
      episode_visual_direction_path: episodeVisualDirection.trim() ? episodeVisualDirectionPath : null,
    },
    visual_reference_scope: scope,
    reference_inventory_ledger_path: referenceInventoryLedgerOutputPath,
    reference_inventory_summary: referenceInventoryLedger.summary,
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
      ...directorInventoryPolicy.warnings,
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
