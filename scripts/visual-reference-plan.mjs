#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getLLMModel, isLocalLLMRoute, localLLMAuthHeaders, localLLMChatCompletionURL } from "./lib/llm-router.mjs";
import { configuredCodexModel, isCodexCacheCompatible, readCodexCallMetadata, runCodexCli } from "./lib/codex-cli-runner.mjs";
import {
  applyBeatLocationSceneIds,
  applyDeterministicLocationSceneIds,
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
const storyFactLedgerPath = flags["story-fact-ledger"] ?? path.join(episodeDir, "story_fact_ledger.json");
const outputPath = flags.output ?? path.join(episodeDir, "visual_reference_plan.json");
const referenceInventoryLedgerOutputPath = flags.referenceInventory
  ?? flags["reference-inventory"]
  ?? path.join(path.dirname(outputPath), "reference_inventory_ledger.json");
const referenceEvidenceLedgerOutputPath = flags.referenceEvidence
  ?? flags["reference-evidence"]
  ?? path.join(path.dirname(outputPath), "reference_evidence_ledger.json");
const locationContractLedgerOutputPath = flags.locationContracts
  ?? flags["location-contracts"]
  ?? path.join(path.dirname(outputPath), "location_contract_ledger.json");
const characterStateRefsOutputPath = flags.characterStateRefs
  ?? flags["character-state-refs"]
  ?? path.join(path.dirname(outputPath), "character_state_refs.json");
const visualStyleBiblePath = flags.visualStyleBible ?? flags["visual-style-bible"] ?? path.join(weekDir, "visual_style_bible.json");
const characterBiblePath = flags.characterBible ?? flags["character-bible"] ?? path.join(weekDir, "character_bible.json");
const episodeVisualDirectionPath = flags.episodeVisualDirection ?? flags["episode-visual-direction"] ?? path.join(episodeDir, "episode_visual_direction.md");
const dropStyleRefs = flags["drop-style-refs"] === "true" || process.env.ANIFACTORY_DROP_STYLE_REFS === "true";
const keepStyleRefs = flags["drop-style-refs"] === "false" || process.env.ANIFACTORY_DROP_STYLE_REFS === "false";
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
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
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
    story_fact_ledger: guidance.storyFactLedger ? {
      canonical_entities: guidance.storyFactLedger.canonical_entities ?? [],
      canonical_locations: guidance.storyFactLedger.canonical_locations ?? [],
      canonical_props: guidance.storyFactLedger.canonical_props ?? [],
      canonical_ui_motifs: guidance.storyFactLedger.canonical_ui_motifs ?? [],
      state_transitions: guidance.storyFactLedger.state_transitions ?? [],
    } : null,
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

function uniqueTokenList(tokens = []) {
  const seen = new Set();
  const out = [];
  for (const token of tokens) {
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function isGenericGroupSubject(value) {
  return /\b(?:group|crowd|audience|families|guards?|officers?|fighters?|raiders?|riders?|survivors?|witnesses?|attendants?|workers?|students?|teachers?|staff|public|guild masters?|soldiers?|police|workforce|faction|uniform system|wardrobe system|monsters?|merchants?|children|civilians?|teams?|members?|holders?|servants?|nobles?|priests?|court priests?|commoners?|spectators?|protagonist|main character|narrator)\b/i.test(String(value ?? ""));
}

function isCollectiveGroupSubject(value) {
  return /\b(?:group|crowd|audience|families|guards?|officers?|fighters?|raiders?|riders?|survivors?|witnesses?|attendants?|workers?|students?|teachers?|staff|public|guild masters?|soldiers?|police|workforce|faction|uniform system|wardrobe system|monsters?|merchants?|children|civilians?|teams?|members?|holders?|servants?|nobles?|priests?|court priests?|commoners?|spectators?)\b/i.test(String(value ?? ""));
}

function isYouthVariantText(value) {
  return /\b(?:young|younger|child|childhood|boy|girl|eight[- ]?year[- ]?old|teen|teenage|student-age)\b/i.test(String(value ?? ""));
}

function isYouthVariantTarget(target) {
  return normalizeKind(target?.kind) === "character_state"
    && isYouthVariantText(`${target?.subject ?? ""} ${target?.ref_id ?? ""} ${target?.prompt_anchor ?? ""}`);
}

function isYouthStateRef(ref) {
  return isYouthVariantText(`${ref?.character ?? ""} ${ref?.state_ref_id ?? ""} ${ref?.scene_prompt_anchor ?? ""}`);
}

function titleCaseTokens(tokens) {
  return tokens.map((token) => token.charAt(0).toUpperCase() + token.slice(1)).join(" ");
}

function characterSubjectFromRefId(refId) {
  const stop = new Set([
    "char", "ref", "reference", "identity", "base", "core", "face", "source", "anchor",
    "state", "private", "menace", "clean", "dirty", "injured", "bloodied", "wounded",
    "young", "younger", "old", "older", "red", "blue", "white", "black", "gray", "grey",
    "robes", "robe", "uniform", "jacket", "shirt", "dress", "cloak", "gloved", "in",
    "after", "before", "memory", "projection", "marked", "body", "single", "person",
  ]);
  const tokens = normalizedTokens(refId).filter((token) => !stop.has(token) && !/^\d+$/.test(token));
  if (!tokens.length) return null;
  return titleCaseTokens(tokens.slice(0, 3));
}

function shouldPreferCharacterRefIdSubject(subject, refId) {
  if (!refId) return false;
  const refSubject = characterSubjectFromRefId(refId);
  if (!refSubject) return false;
  const subjectTokens = new Set(normalizedTokens(subject));
  const refTokens = normalizedTokens(refSubject);
  if (!subjectTokens.size || !refTokens.length) return true;
  if (isGenericGroupSubject(subject) && !isGenericGroupSubject(refSubject)) return true;
  const overlap = refTokens.filter((token) => subjectTokens.has(token)).length;
  if (overlap === 0) return true;
  const firstRefToken = refTokens[0];
  const firstSubjectToken = [...subjectTokens][0];
  return overlap <= 1 && firstRefToken && firstSubjectToken && firstRefToken !== firstSubjectToken;
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

function assetFirstStartSec(asset) {
  const value = Number(asset?.first_start_sec ?? asset?.firstStartSec ?? asset?.start_sec ?? asset?.startSec);
  return Number.isFinite(value) ? value : null;
}

function isOpeningLocationCoverageAsset(asset, openingSec) {
  if (normalizeKind(asset?.kind) !== "location") return false;
  const firstStart = assetFirstStartSec(asset);
  if (!Number.isFinite(firstStart) || firstStart >= openingSec) return false;
  const sceneIds = Array.isArray(asset?.scene_ids) ? asset.scene_ids.filter(Boolean) : [];
  return sceneIds.length > 0;
}

function buildReferenceEvidenceLedger(scopedSemantic, visualBeatPlan, { outputPath: ledgerPath = referenceEvidenceLedgerOutputPath } = {}) {
  const semanticScenes = scopedSemantic?.scenes ?? [];
  const scenes = sceneById(semanticScenes);
  const beats = beatRowsFromScopedSemantic(scopedSemantic);
  const assets = new Map();

  function addAsset({ kind, refId, subject, sceneId, beat = null, reason = null, source = null, semanticRefId = null }) {
    const normalizedKind = normalizeKind(kind);
    if (!["character_state", "location", "prop", "ui", "action"].includes(normalizedKind)) return;
    const rawSubject = String(subject ?? refId ?? "").trim();
    const cleanSubject = normalizedKind === "character_state" && shouldPreferCharacterRefIdSubject(rawSubject, refId)
      ? (characterSubjectFromRefId(refId) ?? rawSubject)
      : rawSubject;
    if (!cleanSubject) return;
    const assetKind = normalizedKind;
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
        subject: req.subject ?? req.description ?? scene.location ?? req.ref_id,
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
    const reuseSpanSec = Number.isFinite(Number(asset.first_start_sec)) && Number.isFinite(Number(asset.last_start_sec))
      ? Math.max(0, Number(asset.last_start_sec) - Number(asset.first_start_sec))
      : 0;
    return {
      asset_id: asset.asset_id,
      ref_id: asset.ref_id,
      kind: asset.kind,
      subject: asset.subject,
      canonical_subject_key: slug(asset.subject, asset.asset_id),
      entity_type: asset.kind === "character_state" && isGenericGroupSubject(`${asset.subject ?? ""} ${asset.asset_id ?? ""}`)
        ? "group_or_creature_system"
        : asset.kind === "character_state"
          ? "named_or_distinct_character"
          : asset.kind,
      scene_ids: [...asset.scene_ids].filter(Boolean).sort(),
      beat_ids: [...asset.beat_ids].filter(Boolean).sort(),
      distinct_scene_count: asset.scene_ids.size,
      beat_count: asset.beat_ids.size,
      reuse_span_sec: Number(reuseSpanSec.toFixed(3)),
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
  const bySource = {};
  for (const row of rows) {
    byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
    for (const source of row.sources ?? []) bySource[source] = (bySource[source] ?? 0) + 1;
  }
  return {
    schema: "goldflow_reference_evidence_ledger_v1",
    status: "passed",
    source_script_hash: scopedSemantic.source_script_hash,
    source_artifact_paths: [
      semanticPlanPath,
      visualBeatPlan?.status === "passed" ? visualBeatPlanPath : null,
    ].filter(Boolean),
    policy: "Broad evidence observations only. This ledger records what appeared in semantic scenes and local visual beats; it does not choose generation modes or require image references.",
    output_path: ledgerPath,
    summary: {
      asset_count: rows.length,
      by_kind: byKind,
      by_source: bySource,
    },
    assets: rows,
    updated_at: new Date().toISOString(),
  };
}

function buildLocationContractLedger(scopedSemantic, { outputPath: ledgerPath = locationContractLedgerOutputPath } = {}) {
  const contracts = new Map();
  const sceneContracts = [];
  const findings = [];
  for (const scene of scopedSemantic?.scenes ?? []) {
    const sceneId = String(scene?.scene_id ?? "").trim();
    if (!sceneId) continue;
    const requirements = (scene.ref_requirements ?? []).filter((req) => normalizeKind(req?.kind) === "location");
    const physicalLocation = String(scene.location ?? "").trim();
    if (physicalLocation && !/^(?:none|unknown|n\/a|na|abstract|unspecified)$/i.test(physicalLocation) && !requirements.length) {
      findings.push({
        code: "scene_missing_location_contract",
        severity: "blocker",
        scene_id: sceneId,
        location: physicalLocation,
        message: `Physical scene ${sceneId} has no explicit semantic location contract.`,
      });
      continue;
    }
    const beats = Array.isArray(scene.visual_beats) ? scene.visual_beats : [];
    for (const req of requirements) {
      const contractId = slug(req.ref_id ?? `${sceneId}_location_contract`, `${sceneId}_location_contract`);
      const description = String(req.subject ?? req.description ?? scene.location ?? req.ref_id ?? contractId).trim();
      const matchingBeats = beats.filter((beat) => (beat.ref_needs ?? beat.beat_ref_requirements ?? [])
        .some((need) => normalizeKind(need?.kind) === "location" && slug(need?.ref_id ?? "") === contractId));
      const scopedBeats = matchingBeats.length ? matchingBeats : beats;
      const localLocationLabels = [...new Set(scopedBeats
        .map((beat) => String(beat.local_location ?? beat.location ?? "").trim())
        .filter(Boolean))];
      const previous = contracts.get(contractId) ?? {
        location_contract_id: contractId,
        semantic_ref_id: contractId,
        description,
        prompt_anchor: description,
        scene_ids: [],
        beat_ids: [],
        local_location_labels: [],
        reasons: [],
      };
      contracts.set(contractId, {
        ...previous,
        description: previous.description || description,
        prompt_anchor: previous.prompt_anchor || description,
        scene_ids: [...new Set([...previous.scene_ids, sceneId])],
        beat_ids: [...new Set([...previous.beat_ids, ...scopedBeats.map((beat) => beat.visual_beat_id).filter(Boolean)])],
        local_location_labels: [...new Set([...previous.local_location_labels, ...localLocationLabels])],
        reasons: [...new Set([...previous.reasons, String(req.reason ?? "semantic location scope").trim()].filter(Boolean))],
      });
      sceneContracts.push({
        scene_id: sceneId,
        location_contract_id: contractId,
        location: physicalLocation || description,
      });
    }
  }
  // A later editorial beat may intentionally use a location contract first
  // declared by another broad semantic scene (preview, flashback, return, or
  // mixed-location parent scene). Union that exact beat scope after every
  // semantic contract exists; never invent a contract from prose or keywords.
  for (const scene of scopedSemantic?.scenes ?? []) {
    for (const beat of Array.isArray(scene.visual_beats) ? scene.visual_beats : []) {
      const sceneId = String(beat.parent_scene_id ?? beat.scene_id ?? scene.scene_id ?? "").trim();
      const beatId = String(beat.visual_beat_id ?? "").trim();
      const contractIds = new Set([
        slug(beat.location_id ?? ""),
        ...(beat.ref_needs ?? beat.beat_ref_requirements ?? [])
          .filter((need) => normalizeKind(need?.kind) === "location")
          .map((need) => slug(need?.ref_id ?? "")),
      ].filter(Boolean));
      for (const contractId of contractIds) {
        const contract = contracts.get(contractId);
        if (!contract) continue;
        const locationLabel = String(beat.local_location ?? beat.location ?? "").trim();
        const updated = {
          ...contract,
          scene_ids: [...new Set([...contract.scene_ids, sceneId].filter(Boolean))],
          beat_ids: [...new Set([...contract.beat_ids, beatId].filter(Boolean))],
          local_location_labels: [...new Set([...contract.local_location_labels, locationLabel].filter(Boolean))],
        };
        contracts.set(contractId, updated);
        if (sceneId && !sceneContracts.some((row) => row.scene_id === sceneId && row.location_contract_id === contractId)) {
          sceneContracts.push({ scene_id: sceneId, location_contract_id: contractId, location: locationLabel || updated.description });
        }
      }
    }
  }
  const rows = [...contracts.values()].sort((left, right) => String(left.location_contract_id).localeCompare(String(right.location_contract_id)));
  return {
    schema: "goldflow_location_contract_ledger_v1",
    status: findings.some((finding) => finding.severity === "blocker") ? "blocked" : "passed",
    source_script_hash: scopedSemantic?.source_script_hash ?? null,
    policy: "Textual physical-location truth and scene scope. A location contract is not an image reference unless the LLM director explicitly selects a clean location plate in visual_reference_plan.json.",
    output_path: ledgerPath,
    contract_count: rows.length,
    contracts: rows,
    scene_contracts: sceneContracts,
    findings,
    updated_at: new Date().toISOString(),
  };
}

function buildSelectedReferenceInventory(referenceTargets, {
  sourceScriptHash = null,
  evidenceLedgerPath = referenceEvidenceLedgerOutputPath,
  locationLedgerPath = locationContractLedgerOutputPath,
  outputPath: ledgerPath = referenceInventoryLedgerOutputPath,
} = {}) {
  const assets = (referenceTargets ?? [])
    .filter((target) => String(target.generation_mode ?? "").toLowerCase() !== "no_ref_needed")
    .map((target) => ({
      asset_id: target.inventory_asset_id ?? target.ref_id,
      ref_id: target.ref_id,
      kind: target.kind,
      subject: target.subject,
      canonical_subject_id: target.canonical_subject_id ?? null,
      base_asset_id: target.base_asset_id ?? null,
      state_delta: target.state_delta ?? null,
      location_contract_ids: target.location_contract_ids ?? [],
      scene_ids: target.scene_ids ?? [],
      planned_beat_ids: target.planned_beat_ids ?? [],
      estimated_use_count: Number(target.estimated_use_count ?? target.appearance_count ?? 0),
      generation_mode: target.generation_mode,
      required_before_imagegen: target.required_before_imagegen === true,
      reference_value_reason: target.reference_value_reason ?? null,
      why_text_is_insufficient: target.why_text_is_insufficient ?? null,
      clean_plate_contract: target.clean_plate_contract ?? null,
      conditioning_subject_count: target.conditioning_subject_count ?? null,
      conditioning_asset_role: target.conditioning_asset_role ?? null,
      clean_plate_contract: target.clean_plate_contract ?? null,
      evidence_asset_ids: target.evidence_asset_ids ?? (target.inventory_asset_id ? [target.inventory_asset_id] : []),
      prompt_anchor: target.prompt_anchor ?? null,
    }));
  const byKind = {};
  const byMode = {};
  for (const asset of assets) {
    byKind[asset.kind] = (byKind[asset.kind] ?? 0) + 1;
    byMode[asset.generation_mode] = (byMode[asset.generation_mode] ?? 0) + 1;
  }
  return {
    schema: "goldflow_reference_inventory_ledger_v2",
    status: "passed",
    source_script_hash: sourceScriptHash,
    source_artifact_paths: [evidenceLedgerPath, locationLedgerPath],
    policy: "LLM-selected canonical attachable reference inventory. Deterministic stages may validate or remove invalid rows but may not restore omitted evidence observations or invent reference targets.",
    output_path: ledgerPath,
    summary: {
      asset_count: assets.length,
      by_kind: byKind,
      by_generation_mode: byMode,
    },
    assets,
    updated_at: new Date().toISOString(),
  };
}

function applyLocationContractSceneIds(referenceTargets, locationContractLedger) {
  const contractById = new Map((locationContractLedger?.contracts ?? [])
    .filter((contract) => contract?.location_contract_id)
    .map((contract) => [String(contract.location_contract_id), contract]));
  const findings = [];
  const targets = (referenceTargets ?? []).map((target) => {
    if (normalizeKind(target?.kind) !== "location") return target;
    const sceneIds = new Set((target.scene_ids ?? []).map(String).filter(Boolean));
    for (const contractId of (target.location_contract_ids ?? []).map(String).filter(Boolean)) {
      const contract = contractById.get(contractId);
      if (!contract) {
        findings.push({
          code: "unknown_location_contract_id",
          severity: "blocker",
          ref_id: target.ref_id,
          location_contract_id: contractId,
          message: `Location reference ${target.ref_id} cites unknown location contract ${contractId}.`,
        });
        continue;
      }
      for (const sceneId of contract.scene_ids ?? []) sceneIds.add(String(sceneId));
    }
    return { ...target, scene_ids: [...sceneIds] };
  });
  return { targets, findings };
}

export function referenceLocationContractLedgerForTests(semanticPlan) {
  return buildLocationContractLedger(semanticPlan, { outputPath: "location_contract_ledger.json" });
}

export function referenceEvidenceLedgerForTests(semanticPlan) {
  return buildReferenceEvidenceLedger(semanticPlan, null, { outputPath: "reference_evidence_ledger.json" });
}

export function referenceLocationScopeForTests(referenceTargets, locationContractLedger) {
  return applyLocationContractSceneIds(referenceTargets, locationContractLedger);
}

export function selectedReferenceInventoryForTests(referenceTargets, sourceScriptHash = "fixture_hash") {
  return buildSelectedReferenceInventory(referenceTargets, {
    sourceScriptHash,
    evidenceLedgerPath: "reference_evidence_ledger.json",
    locationLedgerPath: "location_contract_ledger.json",
    outputPath: "reference_inventory_ledger.json",
  });
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
    canonical_subject_key: asset.canonical_subject_key ?? null,
    entity_type: asset.entity_type ?? null,
    scene_ids: sceneIds.slice(0, maxSceneIds),
    scene_ids_truncated_count: Math.max(0, sceneIds.length - maxSceneIds),
    distinct_scene_count: asset.distinct_scene_count,
    beat_count: asset.beat_count,
    reuse_span_sec: asset.reuse_span_sec ?? 0,
    semantic_ref_ids: asset.semantic_ref_ids ?? [],
    beat_ref_ids: asset.beat_ref_ids ?? [],
    first_start_sec: asset.first_start_sec,
    evidence_excerpts: (asset.evidence_excerpts ?? []).slice(0, evidenceLimit),
  };
}

function inventoryAssetHasReferenceValue(asset) {
  const kind = normalizeKind(asset?.kind);
  const scenes = Number(asset?.distinct_scene_count ?? asset?.scene_ids?.length ?? 0);
  const beats = Number(asset?.beat_count ?? asset?.beat_ids?.length ?? 0);
  if (kind === "character_state" && asset?.entity_type === "named_or_distinct_character") return true;
  if ((asset?.semantic_ref_ids ?? []).length > 0 && kind === "location") return true;
  return scenes >= 2 || beats >= 3;
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
    schema: inventoryLedger?.schema ?? "goldflow_reference_evidence_ledger_v1",
    summary: inventoryLedger?.summary ?? null,
    chunk_scene_ids: sceneIds ?? null,
    global_selected_assets: globalSelectedAssets,
    assets,
  };
}

function buildPrompt(semanticPlan, { chunkLabel = null, guidance = {}, inventoryLedger = null, locationContractLedger = null } = {}) {
  const compact = {
    source_script_hash: semanticPlan.source_script_hash,
    episode_summary: semanticPlan.episode_summary ?? "",
    global_reference_requirements: semanticPlan.global_reference_requirements ?? [],
    scene_count: semanticPlan.scenes?.length ?? 0,
    scenes: (semanticPlan.scenes ?? []).map(compactScene),
  };
  return `Propose canonical visual-reference candidates from this evidence-backed story chunk.
${chunkLabel ? `\nThis is ${chunkLabel}. Propose only assets with plausible episode-level continuity value. A later global director call makes every final generation decision.\n` : ""}

Rules:
- This chunk stage supplies evidence-backed candidates to the global reference director. It does not decide the final reference budget and it does not write final scene-image prompts.
- Use REFERENCE EVIDENCE LEDGER as observations, not orders. Semantic scenes provide broad context and location contracts; visual beats provide local transcript evidence. Raw semantic requirements and beat hints never force image generation.
- Reuse stable evidence asset ids. Canonicalize aliases and state variants under canonical_subject_id and base_asset_id instead of inventing duplicate identities.
- Return only candidates that might deserve a clean attachable reference. Omit text-only one-scene nouns entirely; location scope remains available separately through LOCATION CONTRACT LEDGER.
- Every candidate must list evidence_asset_ids, planned_beat_ids, estimated_use_count, reference_value_reason, and why_text_is_insufficient.
- Propose every plausible continuity-leverage candidate supported by this chunk, while omitting ordinary one-off nouns. This is a candidate pass, so do not artificially minimize it; the global director makes the final right-sized selection.
- Identify recurring characters, character states, major locations, important props, UI motifs, and high-risk repeated action states.
- Resolve role/title aliases to canonical named characters when the script or semantic scenes establish that relationship. If a named person is also the dean, boss, chairman, judge, professor, host, rival, spouse, parent, or another title, do not create a separate generic character ref for later role-only mentions. Expand the existing named character's state/scope instead.
- For real named public creators, streamers, celebrities, or influencers whose likeness matters, request a face-only source identity anchor before the episode character-state ref is generated. Do not rely on text-only "inspired by" likeness prompts for production. The source anchor supplies facial likeness only; the character-state ref supplies wardrobe, pose, body state, and anime/manhwa styling.
- Use each scene's visual_beats when present. A named character that appears in a beat excerpt through replay footage, livestream panels, phone screens, broadcast feeds, camera files, dossiers, avatars, or video walls still needs current-scene reference coverage if their likeness may be visible in that cut.
- Treat each beat's active_state_constraints and depiction_mode as binding evidence. Select refs for materially recurring visible states; do not collapse incompatible wardrobe/injury states and do not create refs for transient text-only state changes.
- When visual_beats carry ref_needs or beat_ref_requirements, treat those as advisory local transcript-timed evidence, not locked reference targets. Semantic scene ref_requirements remain broad scene coverage. The LLM decides the final episode-level reference strategy and may merge, downgrade, upgrade, rename, or replace beat suggestions when the story context supports it.
- Do not preserve beat-authored generation_mode mechanically. Use it as a hint only. Final generation_mode belongs to this reference-planning stage after considering recurrence, story criticality, identity risk, opening-retention value, and whether a clean scene cut can become the reference later.
- Distinguish named characters from groups, factions, crowds, and uniforms. A recurring named person gets a character_state/base identity ref when needed. A visible group such as guild masters, guards, families, students, witnesses, or crowds should not become a character identity ref unless a specific named member recurs. If the group has a recognizable uniform, faction styling, badge, armor set, or wardrobe system with real continuity value, propose one clean attachable uniform/faction design plate; otherwise omit it and let scene prompts describe the group.
- If a character state ref is visually reused as replay/screen evidence in a later scene, include that later scene_id in the ref scope and explain the screen-visible or replay-footage usage in risk_notes.
- Candidate generation_mode is limited to standalone_ref, manual_review, or source_only. Do not derive references from ordinary story cuts; those images contain people, props, UI, and backgrounds that can contaminate later generations.
- Use generic production logic. Do not hardcode story-specific rules.
- Write normal descriptive prompt anchors that preserve story-faithful UI labels, status phrases, and concise absence states when they are the point of the reference.
- Do not create separate provider-exclusion payload fields such as negative_prompt, avoid_list, or exclude_list. Keep provider-facing content in the normal prompt anchor.
- Convert risks into concrete construction when helpful: exact visible subject count, role, pose, action direction, wardrobe construction, frame composition, and location details.
- Keep narrative state separate from visible state. Semantic emotional_state, financial_state, social_state, or loose state phrases such as broke, ruined, betrayed, humiliated, indebted, rejected, or emotionally collapsed are story context, not automatic costume/body damage. Use them to choose props, posture, expression, staging, witnesses, UI, receipts, screens, isolation, or power dynamics. Only put dirt, ragged clothing, torn fabric, wounds, illness, homelessness, dumpster-like styling, or severe physical decay into a character prompt_anchor/scene_prompt_anchor when the locked script or semantic visible_state explicitly says that physical detail is visible.
- Prompt anchors must be concrete and specific enough for image generation, but they are draft anchors requiring manual review before reference generation.
- Every prompt_anchor for every reference kind should start as a 16:9 landscape anime/manhwa reference card or plate; character refs should use plain backgrounds, location refs should use environment-only staging plates, and prop/UI/action refs should be landscape design plates.
- Reference kind taxonomy is strict:
  - style refs define polished 2D anime/manhwa rendering language, line quality, color, lighting, and shot polish.
  - character_state refs define face, hair, age, body type, wardrobe, and state; they are identity/wardrobe evidence, not reusable pose instructions.
  - location refs define environment, architecture, materials, lighting, and scale; use open environment-only staging with enough clean space for later scene characters.
  - prop refs define object shape, surface, markings, and scale.
  - ui refs define interface design, typography, color, layout, and exact display motif.
  - action refs define effect shape, energy color, movement path, interaction pattern, and spatial logic; keep them as effect/action studies rather than complete story scenes.
- Every selected conditioning asset contains exactly one conditioning concept: one identity/state, one environment, one prop, one UI motif, one faction/uniform language, one action/effect language, or one abstract style language. Set conditioning_subject_count to 1 and conditioning_asset_role accordingly. Never combine a character, populated story scene, prop lineup, and UI panel into one reference.
- Action/effect reference anchors should use neutral or abstract staging unless a specific location is inseparable from the effect.
- Character reference anchors should be 16:9 landscape, single-person, single-pose, plain-background identity reference cards with the full body or three-quarter body centered inside the canvas; final scene poses and locations come from the visual prompt stage. Do not ask for multiple face angles, turnaround sheets, pose grids, scene backgrounds, or cinematic action.
- For adult female character refs, keep the character story-appropriate but conventionally attractive: beautiful face, polished hair/makeup when suitable, flattering outfit, full bust, curvy hourglass adult silhouette, graceful waist-to-hip shape, and confident posture. Keep this non-explicit and avoid nudity, lingerie, childlike features, or pinup posing.
- UI refs that represent a named person as data should use dossier identity tile, silhouette identity marker, or archival record wording so the ref stays an interface design plate instead of a character reference card.
- Style references are optional. Prefer the visual style bible and style_summary text over a generated style image. Create a style reference only when it is a clean abstract rendering/material/lighting sample; it must not contain character faces, character sheets, expression panels, UI screens, speech bubbles, or readable text.
- For progressive transformation arcs where the same character changes body, grooming, hair, facial hair, clothing, wealth status, injury state, power level, or age presentation, separate identity from state:
  - Create one base identity anchor for the character's face likeness and core recognizable identity.
  - Later character_state refs and scene_prompt_anchor values must dictate the current visible state explicitly: hairstyle, shave/facial hair, body shape, fitness, posture, wardrobe quality, cleanliness, social status expressed through visible styling, and emotional bearing expressed through expression/posture. Do not visualize abstract wealth loss, debt, betrayal, shame, or social ruin as grime or raggedness unless the script explicitly describes those physical signs.
  - Later states must use the base identity as a face-only continuity source; do not treat earlier overweight, injured, poor, dirty, weak, or young states as body/wardrobe references for later transformed states.
  - State anchors should describe the visible progression clearly enough that a viewer can read the arc without narration.
- Omit lower-priority entities from candidate output. Their story facts remain available as prompt text and location contracts.
- Standalone references are for production leverage: recurring named characters, major character states, opening-retention location anchors, key recurring locations, signature recurring system/UI motifs, critical recurring props, and high-risk physical-contact character interactions.
- Minor role characters, generic witnesses/crowds, single-use wardrobe variants, one-off documents, one-off dashboards, one-off props, and low-value 2-3 occurrence assets should be omitted unless the story makes them truly critical.
- Major recurring characters and visually sensitive major wardrobe/state changes should usually use standalone_ref or manual_review.
- A selected recurring character identity that is visibly depicted in the first 30 seconds must be standalone_ref with required_before_imagegen true. manual_review is a planning hold, not a generatable opening identity.
- Any named human character who physically touches, fights, restrains, shoves, carries, rescues, grabs, strikes, escorts, wrestles, or otherwise has real body-contact interaction with a recurring protagonist should use standalone_ref before imagegen, even if they appear in only one scene. Contact scenes are high identity-blend risk.
- Being merely beside, watching, confronting verbally, appearing on a screen, or sharing a two-character frame is not by itself enough for a one-scene standalone ref; omit it unless distinct identity continuity is mission-critical.
- Major recurring locations should use clean environment-only standalone plates. Do not upgrade every one-scene opening sublocation merely because it is early, and do not derive location refs from populated story cuts.
- Do not merge visually distinct sublocations into one broad location ref just because they share a building, campus, city, company, palace, arena, or venue name. If consecutive scenes or a long story span moves between different visible areas, create separate scene-scoped location refs for those areas, such as entrance, hallway, main room, screen wall, table area, plaza, roof, basement, server room, witness stand, audience floor, or exterior approach. Use the semantic scene location/ref_requirements as the source of scope; code will validate scene_ids and will not invent replacement locations later.
- Semantic location ref_requirements are represented in LOCATION CONTRACT LEDGER and do not need matching image targets. Propose a location image ref only when a clean reusable environment plate buys meaningful consistency; list every covered location_contract_id.
- Long same-venue arcs need enough scoped location refs for editorial variety. A single location ref should not be expected to carry many minutes of visually distinct beats after the retention runway when the semantic scene locations name different physical areas.
- Rank recurring locations by continuity_value_score, which includes beat reuse, scene reuse, opening value, and reuse span. A location used across six or more cuts can be a key standalone anchor even when all of those cuts live under one broad semantic scene. Do not let several one-off props displace a high-value recurring environment.
- Return only valid JSON.

VISUAL BIBLES AND OPERATOR DIRECTION:
${visualGuidanceBlock(guidance)}

REFERENCE EVIDENCE LEDGER:
${JSON.stringify(compactInventoryForPrompt(inventoryLedger, (semanticPlan.scenes ?? []).map((scene) => scene.scene_id), { includeGlobalSelection: Boolean(chunkLabel) }), null, 2)}

LOCATION CONTRACT LEDGER:
${JSON.stringify({
  contracts: (locationContractLedger?.contracts ?? []).filter((contract) =>
    (contract.scene_ids ?? []).some((sceneId) => (semanticPlan.scenes ?? []).some((scene) => scene.scene_id === sceneId))
  ),
}, null, 2)}

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
      "generation_mode": "standalone_ref|manual_review|source_only",
      "required_before_imagegen": true,
      "reference_image_path": null,
      "prompt_anchor": "draft reference prompt anchor",
      "anchor_cut_policy": "none",
      "appearance_count": 1,
      "risk_notes": ["identity blend risk, wardrobe ambiguity, scale ambiguity, etc."],
      "manual_review_required": true,
      "inventory_asset_id": "primary matching reference_evidence_ledger asset_id",
      "evidence_asset_ids": ["all supporting evidence asset ids"],
      "canonical_subject_id": "stable canonical identity/location/prop/ui family id",
      "base_asset_id": "base identity or base environment id when this is a visible state variant",
      "state_delta": "specific visible state difference or null",
      "location_contract_ids": ["covered location contract ids for location refs"],
      "planned_beat_ids": ["beats expected to attach this ref"],
      "estimated_use_count": 4,
      "reference_value_reason": "specific continuity value",
      "why_text_is_insufficient": "specific model-consistency risk",
      "clean_plate_contract": "single clean subject, environment, object, UI, or effect plate without unrelated story-scene contamination"
      ,"conditioning_subject_count": 1,
      "conditioning_asset_role": "identity_state|environment|prop|ui_motif|faction_language|action_effect|style_language"
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

function buildMergePrompt(semanticPlan, chunkPlans, guidance = {}, inventoryLedger = null, locationContractLedger = null) {
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
      evidence_asset_ids: target.evidence_asset_ids ?? [],
      canonical_subject_id: target.canonical_subject_id ?? null,
      base_asset_id: target.base_asset_id ?? null,
      state_delta: target.state_delta ?? null,
      location_contract_ids: target.location_contract_ids ?? [],
      planned_beat_ids: target.planned_beat_ids ?? [],
      estimated_use_count: target.estimated_use_count ?? target.appearance_count ?? 0,
      reference_value_reason: target.reference_value_reason ?? null,
      why_text_is_insufficient: target.why_text_is_insufficient ?? null,
    })),
    character_state_refs: (plan.character_state_refs ?? []).map((ref) => ({
      state_ref_id: ref.state_ref_id,
      character: ref.character,
      scene_ids: ref.scene_ids ?? [],
      prompt_anchor: String(ref.prompt_anchor ?? "").slice(0, 280),
      scene_prompt_anchor: String(ref.scene_prompt_anchor ?? "").slice(0, 280),
      source_ref_id: ref.source_ref_id,
      base_identity_ref_id: ref.base_identity_ref_id,
      identity_usage: ref.identity_usage,
    })),
    warnings: (plan.warnings ?? []).slice(0, 5),
  }));
  return `Merge chunked visual reference strategy outputs into one coherent episode-level visual reference plan.

Rules:
- You are the sole episode-level reference director. Code validates your output but never restores an asset you omit and never guesses a replacement.
- Use REFERENCE EVIDENCE LEDGER and CHUNK CANDIDATES as evidence, not shopping lists. Semantic scenes provide broad context, visual beats provide local transcript truth, and LOCATION CONTRACT LEDGER carries textual location scope without forcing image refs.
- The merged output should feel like a human art director chose the cast, location, prop, UI, uniform/faction, and action references that actually buy consistency.
- There is no fixed numeric reference budget. Right-size the selection to the episode's length and visual complexity. Do not optimize for the smallest possible count, and do not keep low-value refs merely to hit a quota; every selected ref must have concrete reuse or risk-reduction value.
- Treat chunk plans as proposals. Keep only references that materially improve consistency and trace each selection through evidence_asset_ids. If several chunks propose aliases or state variants of the same asset, choose one canonical_subject_id and one base_asset_id, then retain only visually material state deltas.
- Merge duplicate character/location/prop/UI/action targets across chunks.
- Resolve role/title aliases to canonical named characters when the script or semantic scenes establish that relationship. If a named person is also the dean, boss, chairman, judge, professor, host, rival, spouse, parent, or another title, do not create a separate generic character ref for later role-only mentions. Expand the existing named character's state/scope instead.
- For real named public creators, streamers, celebrities, or influencers whose likeness matters, preserve or request face-only source identity anchors and use those anchors as base_identity_ref_id for the generated anime/manhwa character-state refs. Do not merge these into generic role refs or text-only lookalikes.
- Preserve all relevant scene_ids from the chunk plans.
- Final generation_mode is limited to standalone_ref, manual_review, or source_only. Omit text-only assets. Do not derive references from populated story cuts.
- Write normal descriptive prompt anchors that preserve story-faithful UI labels, status phrases, and concise absence states when they are the point of the reference.
- Do not create separate provider-exclusion payload fields such as negative_prompt, avoid_list, or exclude_list. Keep provider-facing content in the normal prompt anchor.
- Convert risks into concrete construction when helpful: exact visible subject count, role, pose, action direction, wardrobe construction, frame composition, and location details.
- Keep narrative state separate from visible state. Semantic emotional_state, financial_state, social_state, or loose state phrases such as broke, ruined, betrayed, humiliated, indebted, rejected, or emotionally collapsed are story context, not automatic costume/body damage. Use them to choose props, posture, expression, staging, witnesses, UI, receipts, screens, isolation, or power dynamics. Only put dirt, ragged clothing, torn fabric, wounds, illness, homelessness, dumpster-like styling, or severe physical decay into a character prompt_anchor/scene_prompt_anchor when the locked script or semantic visible_state explicitly says that physical detail is visible.
- Use each scene's visual_beats when present. A named character that appears in a beat excerpt through replay footage, livestream panels, phone screens, broadcast feeds, camera files, dossiers, avatars, or video walls still needs current-scene reference coverage if their likeness may be visible in that cut.
- Treat each beat's active_state_constraints and depiction_mode as binding evidence. Select refs for materially recurring visible states; do not collapse incompatible wardrobe/injury states and do not create refs for transient text-only state changes.
- When visual_beats carry ref_needs or beat_ref_requirements, treat those as advisory local transcript-timed evidence, not locked reference targets. Semantic scene ref_requirements remain broad scene coverage. The LLM decides the final episode-level reference strategy and may merge, downgrade, upgrade, rename, or replace beat suggestions when the story context supports it.
- Do not preserve beat-authored generation_mode mechanically. Make the final decision from recurrence, story criticality, identity risk, and opening-retention value.
- Distinguish named characters from groups, creatures, factions, crowds, and uniforms. A recurring named person gets a character_state/base identity ref when needed. A recurring group or creature system may receive a clean group/faction design plate when its shared silhouette, uniform, armor, or visual system matters; never pretend it is one person's face identity.
- If a character state ref is visually reused as replay/screen evidence in a later scene, include that later scene_id in the ref scope and explain the screen-visible or replay-footage usage in risk_notes.
- Every prompt_anchor for every reference kind should start as a 16:9 landscape anime/manhwa reference card or plate; character refs should use plain backgrounds, location refs should use environment-only staging plates, and prop/UI/action refs should be landscape design plates.
- Reference kind taxonomy is strict:
  - style refs define polished 2D anime/manhwa rendering language, line quality, color, lighting, and shot polish.
  - character_state refs define face, hair, age, body type, wardrobe, and state; they are identity/wardrobe evidence, not reusable pose instructions.
  - location refs define environment, architecture, materials, lighting, and scale; use open environment-only staging with enough clean space for later scene characters.
  - prop refs define object shape, surface, markings, and scale.
  - ui refs define interface design, typography, color, layout, and exact display motif.
  - action refs define effect shape, energy color, movement path, interaction pattern, and spatial logic; keep them as effect/action studies rather than complete story scenes.
- Every selected conditioning asset contains exactly one conditioning concept: one identity/state, one environment, one prop, one UI motif, one faction/uniform language, one action/effect language, or one abstract style language. Set conditioning_subject_count to 1 and conditioning_asset_role accordingly. Never combine a character, populated story scene, prop lineup, and UI panel into one reference.
- Action/effect reference anchors should use neutral or abstract staging unless a specific location is inseparable from the effect.
- Character reference anchors should be 16:9 landscape, single-person, single-pose, plain-background identity reference cards with the full body or three-quarter body centered inside the canvas; final scene poses and locations come from the visual prompt stage. Do not ask for multiple face angles, turnaround sheets, pose grids, scene backgrounds, or cinematic action.
- For adult female character refs, keep the character story-appropriate but conventionally attractive: beautiful face, polished hair/makeup when suitable, flattering outfit, full bust, curvy hourglass adult silhouette, graceful waist-to-hip shape, and confident posture. Keep this non-explicit and avoid nudity, lingerie, childlike features, or pinup posing.
- UI refs that represent a named person as data should use dossier identity tile, silhouette identity marker, or archival record wording so the ref stays an interface design plate instead of a character reference card.
- Style references are optional. Prefer the visual style bible and style_summary text over a generated style image. Preserve a style reference only when it is a clean abstract rendering/material/lighting sample; it must not contain character faces, character sheets, expression panels, UI screens, speech bubbles, or readable text.
- For progressive transformation arcs where the same character changes body, grooming, hair, facial hair, clothing, wealth status, injury state, power level, or age presentation, separate identity from state:
  - Create one base identity anchor for the character's face likeness and core recognizable identity.
  - Later character_state refs and scene_prompt_anchor values must dictate the current visible state explicitly: hairstyle, shave/facial hair, body shape, fitness, posture, wardrobe quality, cleanliness, social status expressed through visible styling, and emotional bearing expressed through expression/posture. Do not visualize abstract wealth loss, debt, betrayal, shame, or social ruin as grime or raggedness unless the script explicitly describes those physical signs.
  - Later states must use the base identity as a face-only continuity source; do not treat earlier overweight, injured, poor, dirty, weak, or young states as body/wardrobe references for later transformed states.
  - State anchors should describe the visible progression clearly enough that a viewer can read the arc without narration.
- Major recurring characters and visually sensitive wardrobe/state changes should usually use standalone_ref or manual_review.
- A selected recurring character identity that is visibly depicted in the first 30 seconds must be standalone_ref with required_before_imagegen true. manual_review is a planning hold, not a generatable opening identity.
- Omit lower-priority entities entirely. Their facts remain available to scene prompting as text.
- Standalone references are for production leverage: recurring named characters, major character states, opening-retention location anchors, key recurring locations, signature recurring system/UI motifs, critical recurring props, and high-risk physical-contact character interactions.
- Minor role characters, generic witnesses/crowds, single-use wardrobe variants, one-off documents, one-off dashboards, one-off props, and low-value 2-3 occurrence assets should be omitted unless truly critical.
- Do not upgrade every one-scene opening sublocation solely because it is early. Standalone opening locations must be a small curated set with real multi-beat clarity value.
- Any named human character who physically touches, fights, restrains, shoves, carries, rescues, grabs, strikes, escorts, wrestles, or otherwise has real body-contact interaction with a recurring protagonist should use standalone_ref before imagegen, even if they appear in only one scene. Contact scenes are high identity-blend risk.
- Being merely beside, watching, confronting verbally, appearing on a screen, or sharing a two-character frame is not enough for a one-scene standalone ref unless distinct identity continuity is mission-critical.
- Do not merge visually distinct sublocations into one broad location ref just because they share a building, campus, city, company, palace, arena, or venue name. If chunk plans contain separate visible areas inside one larger venue, preserve or create separate scene-scoped location refs for those areas during merge, such as entrance, hallway, main room, screen wall, table area, plaza, roof, basement, server room, witness stand, audience floor, or exterior approach. Use the semantic scene location/ref_requirements as the source of scope; code will validate scene_ids and will not invent replacement locations later.
- Location contracts do not force matching image refs. Select clean reusable location plates for recurring physical environments, list the location_contract_ids they cover, and leave one-scene location truth in the contract ledger.
- Long same-venue arcs need enough scoped location refs for editorial variety. A single location ref should not be expected to carry many minutes of visually distinct beats after the retention runway when the semantic scene locations name different physical areas.
- Rank recurring locations from the supplied evidence: beat reuse, scene reuse, opening value, and reuse span. A location used across many cuts can be a key standalone anchor even when those cuts live under one broad semantic scene. Do not let several one-off props displace a high-value recurring environment.
- Return only valid JSON.

VISUAL BIBLES AND OPERATOR DIRECTION:
${visualGuidanceBlock(guidance)}

REFERENCE EVIDENCE LEDGER:
${JSON.stringify(compactInventoryForPrompt(inventoryLedger, null, { referenceValueOnly: true, maxAssets: Number(flags["visual-ref-merge-ledger-max-assets"] ?? 320), evidenceLimit: 0, sceneIdLimit: 18 }), null, 2)}

LOCATION CONTRACT LEDGER:
${JSON.stringify(locationContractLedger, null, 2)}

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
      "generation_mode": "standalone_ref|manual_review|source_only",
      "required_before_imagegen": true,
      "reference_image_path": null,
      "prompt_anchor": "draft reference prompt anchor",
      "anchor_cut_policy": "none",
      "appearance_count": 1,
      "risk_notes": ["identity blend risk, wardrobe ambiguity, scale ambiguity, etc."],
      "manual_review_required": true,
      "inventory_asset_id": "primary matching evidence asset id",
      "evidence_asset_ids": ["all supporting evidence ids"],
      "canonical_subject_id": "stable canonical identity/location/prop/ui family id",
      "base_asset_id": "base identity/environment id or null",
      "state_delta": "specific visible state change or null",
      "location_contract_ids": ["covered contract ids for location refs"],
      "planned_beat_ids": ["beats expected to attach this ref"],
      "estimated_use_count": 4,
      "reference_value_reason": "specific continuity value",
      "why_text_is_insufficient": "specific generation risk",
      "clean_plate_contract": "clean reusable plate with no unrelated story-scene contamination"
      ,"conditioning_subject_count": 1,
      "conditioning_asset_role": "identity_state|environment|prop|ui_motif|faction_language|action_effect|style_language"
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
      const metadata = await readCodexCallMetadata(cachedPath);
      if (!isCodexCacheCompatible(metadata, {
        model: flags.model ?? flags["llm-model"] ?? null,
        reasoningEffort: flags["reasoning-effort"] ?? null,
        promptHash: sha256(prompt),
      })) continue;
      const content = await fs.readFile(cachedPath, "utf8").catch(() => "");
      if (!content.trim()) continue;
      try {
        const parsed = extractJson(content);
        console.error(`visual refs ${stageName}: reused cached Codex chunk output ${cachedPath}`);
        return {
          provider: "codex-cache",
          model: metadata.model,
          reasoning_effort: metadata.reasoning_effort,
          codex_cli_path: metadata.codex_cli_path,
          codex_cli_version: metadata.codex_cli_version,
          output_path: cachedPath,
          content,
          parsed,
          reused_cached_output: true,
        };
      } catch {}
    }
  }
  const outputPath = path.join(callDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${stageName}-output.txt`);
  const call = await runCodexCli({
    prompt,
    stageName,
    repoRoot,
    outputPath,
    model: flags.model ?? flags["llm-model"] ?? null,
    reasoningEffort: flags["reasoning-effort"] ?? null,
    timeoutMs: Number(process.env.ANIFACTORY_VISUAL_REF_PLAN_TIMEOUT_MS ?? 1_200_000),
  });
  return {
    provider: "codex",
    model: call.model,
    reasoning_effort: call.reasoning_effort,
    codex_cli_path: call.codex_cli_path,
    codex_cli_version: call.codex_cli_version,
    output_path: outputPath,
    content: call.content,
    parsed: extractJson(call.content),
  };
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
    conditioning_image_path: target.conditioning_image_path ?? target.reference_image_path ?? target.path ?? null,
    inventory_asset_id: target.inventory_asset_id ?? target.reference_inventory_asset_id ?? null,
    evidence_asset_ids: Array.isArray(target.evidence_asset_ids)
      ? [...new Set(target.evidence_asset_ids.map((value) => String(value ?? "").trim()).filter(Boolean))]
      : (target.inventory_asset_id ? [String(target.inventory_asset_id)] : []),
    canonical_subject_id: target.canonical_subject_id ?? target.canonical_entity_id ?? null,
    base_asset_id: target.base_asset_id ?? null,
    state_delta: target.state_delta ?? null,
    location_contract_ids: Array.isArray(target.location_contract_ids)
      ? [...new Set(target.location_contract_ids.map((value) => String(value ?? "").trim()).filter(Boolean))]
      : [],
    planned_beat_ids: Array.isArray(target.planned_beat_ids)
      ? [...new Set(target.planned_beat_ids.map((value) => String(value ?? "").trim()).filter(Boolean))]
      : [],
    estimated_use_count: Number(target.estimated_use_count ?? target.appearance_count ?? 0),
    reference_value_reason: target.reference_value_reason ?? null,
    why_text_is_insufficient: target.why_text_is_insufficient ?? null,
    clean_plate_contract: target.clean_plate_contract ?? null,
    conditioning_subject_count: Number(target.conditioning_subject_count ?? 0),
    conditioning_asset_role: target.conditioning_asset_role ?? null,
    director_role: target.director_role ?? null,
    director_recommended_generation_mode: target.director_recommended_generation_mode ?? target.recommended_generation_mode ?? null,
    director_recommended_required_before_imagegen: target.director_recommended_required_before_imagegen ?? target.recommended_required_before_imagegen ?? null,
    first_start_sec: Number.isFinite(Number(target.first_start_sec ?? target.firstStartSec))
      ? Number(target.first_start_sec ?? target.firstStartSec)
      : null,
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
    conditioning_image_path: ref.conditioning_image_path ?? ref.reference_image_path ?? null,
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
      conditioning_image_path: row.conditioning_image_path ?? row.reference_image_path ?? row.path,
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
      conditioning_image_path: anchor.conditioning_image_path ?? previous.conditioning_image_path ?? anchor.reference_image_path ?? previous.reference_image_path ?? null,
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
  const relationText = text.replace(/[^a-z0-9]+/g, " ");
  const relationMatch = relationText.match(/\bjoey(?:\s+manhwa)?\s+s\s+(father|mother|sister|brother|parents?)\b/);
  if (relationMatch) return `joey_${relationMatch[1].replace(/s$/, "")}`;
  const stop = new Set([
    "a", "an", "the", "char", "character", "state", "ref", "reference", "base", "core", "face",
    "identity", "source", "anchor", "real", "only", "full", "body", "wardrobe", "version",
    "young", "younger", "older", "current", "final", "early", "late", "clean", "dirty", "poor",
    "rich", "injured", "bloodied", "weak", "strong", "transformed", "before", "after",
    "captain", "commander", "judge", "councilman", "councilwoman", "guildmaster", "guild",
    "master", "dean", "professor", "chairman", "chairwoman", "boss", "rival", "saint",
    "healer", "raid", "court", "tribunal", "prisoner", "restrained", "bound",
    "duke", "duchess", "lord", "lady", "high", "sir", "madam",
  ]);
  const tokens = uniqueTokenList(text
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token && !stop.has(token) && !/^\d+$/.test(token)));
  if (tokens[0] === "joey" && tokens[1] && !["father", "mother", "sister", "brother"].includes(tokens[1])) {
    return `${tokens[0]}_${tokens[1]}`;
  }
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
  if (/^char_[a-z0-9]+_[a-z0-9]+(?:_ref)?$/i.test(refId) && isPlainNamedIdentitySubject(target)) return true;
  if (/^(?:[a-z0-9]+_)+(?:base_)?(?:face_)?identity_ref$/i.test(refId)) return true;
  if (/^[a-z0-9]+_ref$/i.test(refId) && isPlainNamedIdentitySubject(target)) return true;
  if (/^[a-z0-9]+_[a-z0-9]+_ref$/i.test(refId) && isPlainNamedIdentitySubject(target)) return true;
  if (/^[a-z0-9]+_character_ref$/i.test(refId)) {
    return !/\b(?:state|office|final|morning|warehouse|business|evening|disgraced|promoted|betrayal|suit|support|ally|executive|cornered|diminished|rain|premiere|winter|mature|memory|archival|public|speaker|operator|leader|companion|confession|exit|reformer|strategist|worker|video)\b/i.test(subject);
  }
  return false;
}

function isGenericGroupCharacterTarget(target) {
  if (String(target.kind ?? "").toLowerCase() !== "character_state") return false;
  if (isExplicitBaseIdentityTarget(target)) return false;
  return isGenericGroupSubject(`${target.subject ?? ""} ${target.ref_id ?? ""}`);
}

function isPlainNamedIdentitySubject(target) {
  const subject = String(target.subject ?? "").trim().toLowerCase();
  const refTokens = String(target.ref_id ?? "")
    .toLowerCase()
    .replace(/^char_/, "")
    .replace(/_ref$/, "")
    .split(/_+/)
    .filter(Boolean);
  if (/\b(?:state|injured|wounded|bloodied|betrayed|ruined|humiliated|gala|rain|rain[- ]?soaked|damp|wet|porter|captain|commander|judge|councilman|healer|blindfolded|restrained|bound|court|prisoner|raid|fever|shaken|memory|projection|monster|monsters|merchant|merchants|children|civilians?|teams?|members?|holders?|design|pods|larvae|guild|group|crowd|uniform|family|student|witness)\b/i.test(subject)) return false;
  const subjectTokens = subject.replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(Boolean);
  if (refTokens.length === 1) return subjectTokens.length <= 3 && subjectTokens.includes(refTokens[0]);
  if (refTokens.length < 2) return false;
  const overlap = refTokens.filter((token) => subjectTokens.includes(token)).length;
  return overlap >= Math.min(2, refTokens.length);
}

function isDirectorRequiredStateVariantTarget(target) {
  if (normalizeKind(target?.kind) !== "character_state") return false;
  const text = `${target?.subject ?? ""} ${target?.ref_id ?? ""} ${target?.prompt_anchor ?? ""} ${target?.scene_prompt_anchor ?? ""} ${(target?.risk_notes ?? []).join(" ")}`;
  const stateLike = /\b(?:state|injured|wounded|bloodied|betrayed|ruined|humiliated|gala|rain|rain[- ]?soaked|damp|wet|panicked|shaken|collapsed|rescued|restrained|bound|uniform|armor|armour|cloak|robes?|scar|scars|brand|burn|burned|post[- ]?battle|memory|projection|debtor|marked|tears?)\b/i.test(text);
  return target?.director_recommended_required_before_imagegen === true
    && /^(?:standalone_ref|manual_review)$/i.test(String(target?.director_recommended_generation_mode ?? ""))
    && !isExplicitBaseIdentityTarget(target)
    && stateLike;
}

function isCanonicalIdentityCandidate(target) {
  const refId = String(target.ref_id ?? "");
  if (isDirectorRequiredStateVariantTarget(target)) return false;
  if (isYouthVariantTarget(target) && !isExplicitBaseIdentityTarget(target)) return false;
  if (isExplicitBaseIdentityTarget(target)) return true;
  if (isGenericCharacterIdentityTarget(target)) return true;
  if (isPlainNamedIdentitySubject(target)) return true;
  const compactRef = refId.toLowerCase().replace(/^char_/, "").replace(/_ref$/, "");
  return compactRef.split("_").length <= 2 && /\b(?:base|face|identity)\b/i.test(`${target.subject ?? ""} ${refId}`);
}

function identityTargetScore(target) {
  let score = 0;
  const text = `${target.subject ?? ""} ${target.ref_id ?? ""}`;
  if (target.conditioning_image_path ?? target.reference_image_path) score += 100;
  if (isExplicitBaseIdentityTarget(target)) score += 50;
  if (/\bbase\s+(?:face\s+)?identity\b/i.test(text)) score += 10;
  if (/\bcore\s+(?:face\s+)?identity\b/i.test(text)) score += 8;
  if (/^char_[a-z0-9]+(?:_[a-z0-9]+)*_ref$/i.test(String(target.ref_id ?? ""))) score += 20;
  if (!/^char_[a-z0-9]+(?:_ref)?$/i.test(String(target.ref_id ?? ""))) score += 10;
  if (isYouthVariantTarget(target) && !isExplicitBaseIdentityTarget(target)) score -= 45;
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
  const canonicalByKey = new Map();
  const warnings = [];
  const targetById = new Map(referenceTargets.map((target) => [target.ref_id, { ...target }]));
  function canonicalRefForKeys(keys) {
    for (const key of keys) {
      const exact = canonicalByKey.get(key);
      if (exact) return exact;
    }
    for (const key of keys) {
      if (!key || key.includes("_")) continue;
      const matches = [...canonicalByKey.entries()].filter(([candidateKey]) => candidateKey === key || candidateKey.startsWith(`${key}_`));
      const uniqueMatches = [...new Set(matches.map(([, refId]) => refId))];
      if (uniqueMatches.length === 1) return uniqueMatches[0];
    }
    return null;
  }
  for (const [key, rows] of candidateGroups.entries()) {
    if (!rows.length) continue;
    const allRows = allGroups.get(key) ?? rows;
    const explicitRows = rows.filter(isExplicitBaseIdentityTarget);
    const primaryPool = explicitRows.length ? explicitRows : allRows;
    const sorted = [...primaryPool].sort((a, b) => identityTargetScore(b) - identityTargetScore(a) || String(a.ref_id).localeCompare(String(b.ref_id)));
    const primary = sorted[0];
    if (!primary) continue;
    canonicalByKey.set(key, primary.ref_id);
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
  const redirectedStateRefs = characterStateRefs.map((ref) => ({
    ...ref,
    source_ref_id: redirect.get(ref.source_ref_id) ?? ref.source_ref_id,
    base_identity_ref_id: redirect.get(ref.base_identity_ref_id) ?? ref.base_identity_ref_id,
  })).map((ref) => {
    const sourceTargetExists = !ref.source_ref_id || targetById.has(ref.source_ref_id);
    const baseTargetExists = !ref.base_identity_ref_id || targetById.has(ref.base_identity_ref_id);
    if (sourceTargetExists && baseTargetExists) return ref;
    const keys = [ref.character, ref.state_ref_id, ref.source_ref_id, ref.base_identity_ref_id]
      .map((value) => identityMergeKey({ kind: "character_state", subject: value, ref_id: "" }))
      .filter(Boolean);
    const canonicalRefId = canonicalRefForKeys(keys);
    if (!canonicalRefId) return ref;
    warnings.push({
      code: "canonical_identity_state_ref_rebased",
      severity: "info",
      state_ref_id: ref.state_ref_id,
      canonical_ref_id: canonicalRefId,
      message: `Rebased dangling state ref ${ref.state_ref_id} to canonical identity ${canonicalRefId}.`,
    });
    return {
      ...ref,
      source_ref_id: sourceTargetExists ? ref.source_ref_id : canonicalRefId,
      base_identity_ref_id: baseTargetExists ? ref.base_identity_ref_id : canonicalRefId,
      identity_usage: ref.identity_usage ?? "face_only",
    };
  });
  return {
    referenceTargets: [...targetById.values()],
    characterStateRefs: redirectedStateRefs,
    warnings,
    redirect,
  };
}

function isMergeableIdentityAliasTarget(target) {
  if (normalizeKind(target?.kind) !== "character_state") return false;
  if (isGenericGroupCharacterTarget(target)) return false;
  if (isDirectorRequiredStateVariantTarget(target)) return false;
  const identityText = `${target?.subject ?? ""} ${target?.ref_id ?? ""}`;
  if (isYouthVariantText(identityText)) return false;
  if (isExplicitBaseIdentityTarget(target) || isGenericCharacterIdentityTarget(target) || isPlainNamedIdentitySubject(target)) return true;
  const subjectTokens = normalizedTokens(target?.subject);
  const refTokens = normalizedTokens(String(target?.ref_id ?? "").replace(/^char_/, "").replace(/_ref$/, ""));
  const stateLike = /\b(?:state|injured|wounded|bloodied|bruised|marked|condemned|prisoner|uniform|armor|armour|cloak|robes?|scar|scars|chain|chains|corrupt|order|post[- ]?battle|vessel|watch|clean|dirty|memory|projection|collapsed|rescued|duel|combat|brand|burn|burned)\b/i.test(identityText);
  if (stateLike) return false;
  return subjectTokens.length > 0 && subjectTokens.length <= 4 && refTokens.some((token) => subjectTokens.includes(token));
}

function identityAliasPrimaryScore(target) {
  let score = identityTargetScore(target);
  const subjectTokens = normalizedTokens(target?.subject).filter((token) => !["duke", "duchess", "lord", "lady", "high", "sir", "madam"].includes(token));
  const prompt = String(target?.prompt_anchor ?? "");
  const sceneCount = Array.isArray(target?.scene_ids) ? target.scene_ids.length : 0;
  if (subjectTokens.length >= 2) score += 15;
  if (!/\bContinuity evidence:/i.test(prompt)) score += 12;
  if (prompt.length && prompt.length < 700) score += 8;
  if (generatedOrAttachableTarget(target)) score += 6;
  score += Math.min(12, sceneCount);
  return score;
}

function collapseCharacterIdentityAliasTargets(referenceTargets, characterStateRefs) {
  const targetById = new Map(referenceTargets.map((target) => [target.ref_id, { ...target }]));
  const groups = new Map();
  for (const target of targetById.values()) {
    if (!isMergeableIdentityAliasTarget(target)) continue;
    const key = identityMergeKey(target);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(target);
  }
  const redirect = new Map();
  const warnings = [];
  for (const [key, rows] of groups.entries()) {
    const uniqueRows = [...new Map(rows.map((row) => [row.ref_id, row])).values()];
    if (uniqueRows.length < 2) continue;
    const anyGenerated = uniqueRows.some((row) => generatedOrAttachableTarget(row));
    const sorted = [...uniqueRows].sort((a, b) => identityAliasPrimaryScore(b) - identityAliasPrimaryScore(a) || String(a.ref_id).localeCompare(String(b.ref_id)));
    const primary = sorted[0];
    const primaryRow = targetById.get(primary.ref_id);
    const mergedSceneIds = new Set(primaryRow.scene_ids ?? []);
    const mergedRiskNotes = new Set(primaryRow.risk_notes ?? []);
    const manualReview = uniqueRows.some((row) => row.manual_review_required === true);
    for (const duplicate of uniqueRows.filter((row) => row.ref_id !== primary.ref_id)) {
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
          decision: "merged_identity_alias",
          reason: `plain identity alias ${duplicate.ref_id} merged into ${primary.ref_id}`,
        },
      });
      warnings.push({
        code: "character_identity_alias_merged",
        severity: "info",
        character_key: key,
        ref_id: duplicate.ref_id,
        canonical_ref_id: primary.ref_id,
        message: `Merged plain identity alias ${duplicate.ref_id} into canonical generated identity ${primary.ref_id}.`,
      });
    }
    targetById.set(primary.ref_id, {
      ...primaryRow,
      scene_ids: [...mergedSceneIds].filter(Boolean),
      risk_notes: [...mergedRiskNotes].filter(Boolean),
      generation_mode: anyGenerated && !primaryRow.reference_image_path ? "standalone_ref" : primaryRow.generation_mode,
      required_before_imagegen: anyGenerated ? true : primaryRow.required_before_imagegen,
      manual_review_required: manualReview || primaryRow.manual_review_required === true,
    });
  }
  const redirectedStateRefs = characterStateRefs.map((ref) => {
    const stateCanonicalRefId = redirect.get(ref.state_ref_id);
    const refIsYouthVariant = isYouthStateRef(ref);
    if (stateCanonicalRefId && !refIsYouthVariant) {
      warnings.push({
        code: "character_identity_alias_state_ref_id_rebased",
        severity: "warning",
        state_ref_id: ref.state_ref_id,
        canonical_ref_id: stateCanonicalRefId,
        message: `Rebased state ref ${ref.state_ref_id} to use merged canonical identity ${stateCanonicalRefId} as its source.`,
      });
      return {
        ...ref,
        source_ref_id: stateCanonicalRefId,
        base_identity_ref_id: stateCanonicalRefId,
        identity_usage: ref.identity_usage ?? "face_only",
      };
    }
    return {
      ...ref,
      source_ref_id: redirect.get(ref.source_ref_id) ?? ref.source_ref_id,
      base_identity_ref_id: redirect.get(ref.base_identity_ref_id) ?? ref.base_identity_ref_id,
    };
  });
  const generatedCandidates = [...targetById.values()]
    .filter((target) => normalizeKind(target.kind) === "character_state" && generatedOrAttachableTarget(target))
    .sort((a, b) => identityAliasPrimaryScore(b) - identityAliasPrimaryScore(a) || String(a.ref_id).localeCompare(String(b.ref_id)));
  function canonicalTargetForStateRef(ref, { allowYouth = false } = {}) {
    const keys = [ref.character, ref.state_ref_id, ref.source_ref_id, ref.base_identity_ref_id]
      .map((value) => identityMergeKey({ kind: "character_state", subject: value, ref_id: "" }))
      .filter(Boolean);
    if (!keys.length) return null;
    for (const key of keys) {
      const exact = generatedCandidates.find((target) => identityMergeKey(target) === key && (allowYouth || !isYouthVariantTarget(target)));
      if (exact) return exact;
    }
    for (const key of keys) {
      if (!key || key.includes("_")) continue;
      const matches = generatedCandidates.filter((target) => {
        if (!allowYouth && isYouthVariantTarget(target)) return false;
        const candidateKey = identityMergeKey(target);
        return candidateKey === key || String(candidateKey ?? "").startsWith(`${key}_`);
      });
      const unique = [...new Map(matches.map((target) => [target.ref_id, target])).values()];
      if (unique.length === 1) return unique[0];
    }
    return null;
  }
  const repairedStateRefs = redirectedStateRefs.map((ref) => {
    const sourceTarget = targetById.get(ref.source_ref_id);
    const baseTarget = targetById.get(ref.base_identity_ref_id);
    const refIsYouthVariant = isYouthStateRef(ref);
    const canonicalTarget = canonicalTargetForStateRef(ref, { allowYouth: refIsYouthVariant });
    if (sourceTarget && isYouthVariantTarget(sourceTarget) && canonicalTarget && canonicalTarget.ref_id !== sourceTarget.ref_id && !refIsYouthVariant) {
      warnings.push({
        code: "character_identity_alias_state_ref_rebased_from_youth_source",
        severity: "warning",
        state_ref_id: ref.state_ref_id,
        previous_source_ref_id: ref.source_ref_id,
        canonical_ref_id: canonicalTarget.ref_id,
        message: `Rebased adult/non-youth state ref ${ref.state_ref_id} from youth source ${ref.source_ref_id} to canonical identity ${canonicalTarget.ref_id}.`,
      });
      return {
        ...ref,
        source_ref_id: canonicalTarget.ref_id,
        base_identity_ref_id: canonicalTarget.ref_id,
        identity_usage: ref.identity_usage ?? "face_only",
      };
    }
    const sourceKey = sourceTarget ? identityMergeKey(sourceTarget) : null;
    const baseKey = baseTarget ? identityMergeKey(baseTarget) : null;
    const refKeys = [ref.character, ref.state_ref_id]
      .map((value) => identityMergeKey({ kind: "character_state", subject: value, ref_id: "" }))
      .filter(Boolean);
    if (sourceTarget && baseTarget && sourceKey && baseKey && refKeys.includes(sourceKey) && !refKeys.includes(baseKey)) {
      warnings.push({
        code: "character_identity_alias_state_ref_base_rebased",
        severity: "warning",
        state_ref_id: ref.state_ref_id,
        source_ref_id: ref.source_ref_id,
        previous_base_identity_ref_id: ref.base_identity_ref_id,
        canonical_ref_id: sourceTarget.ref_id,
        message: `Rebased state ref ${ref.state_ref_id} base identity from mismatched ${ref.base_identity_ref_id} to source identity ${sourceTarget.ref_id}.`,
      });
      return {
        ...ref,
        base_identity_ref_id: sourceTarget.ref_id,
        identity_usage: ref.identity_usage ?? "face_only",
      };
    }
    return ref;
  });
  return {
    referenceTargets: [...targetById.values()],
    characterStateRefs: repairedStateRefs,
    warnings,
    redirect,
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



function prunePromptFacingNoRefTargets(referenceTargets) {
  const warnings = [];
  const nextTargets = [];
  const prunedTargetIds = new Set();
  for (const target of referenceTargets ?? []) {
    const kind = normalizeKind(target.kind);
    const noRef = String(target.generation_mode ?? "").toLowerCase() === "no_ref_needed"
      && target.required_before_imagegen !== true
      && !(target.conditioning_image_path ?? target.reference_image_path);
    if (noRef) {
      prunedTargetIds.add(target.ref_id);
      warnings.push({
        code: "director_pruned_text_only_reference_target",
        severity: "info",
        ref_id: target.ref_id,
        kind,
        message: `Pruned text-only ${kind} target ${target.ref_id} from visual_reference_plan; it remains represented in reference_inventory_ledger.json when useful as context or coverage evidence.`,
      });
      continue;
    }
    nextTargets.push(target);
  }
  return {
    referenceTargets: nextTargets,
    warnings,
    prunedTargetIds: [...prunedTargetIds],
  };
}


function providerExclusionPayloadSyntaxMatches(value) {
  const text = String(value ?? "").toLowerCase();
  const patterns = [
    /--no\b/,
    /\bnegative\s+prompt\s*[:=]/,
  ];
  return patterns.filter((pattern) => pattern.test(text)).map(String);
}

function providerExclusionPayloadAnchorWarnings(referenceTargets, characterStateRefs) {
  const failures = [];
  for (const target of referenceTargets) {
    const matches = providerExclusionPayloadSyntaxMatches(target.prompt_anchor);
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
    const matches = providerExclusionPayloadSyntaxMatches(ref.prompt_anchor);
    if (matches.length) failures.push({
      path: `character_state_refs.${ref.state_ref_id}.prompt_anchor`,
      type: "character_state_ref",
      id: ref.state_ref_id,
      field: "prompt_anchor",
      matches: matches.join(", "),
      value: ref.prompt_anchor,
    });
    const sceneMatches = providerExclusionPayloadSyntaxMatches(ref.scene_prompt_anchor);
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
    code: "provider_exclusion_payload_marker",
    severity: "warning",
    path: failure.path,
    ref_id: failure.id,
    field: failure.field,
    matched_terms: failure.matches,
    message: `${failure.path} appears to contain embedded provider-exclusion payload syntax; keep exclusion payloads out of normal anchor prose.`,
  }));
}

function abstractStatusAsPhysicalAnchorWarnings(referenceTargets, characterStateRefs) {
  const abstractStatusPattern = /\b(?:financial(?:ly)?\s+ruin(?:ed)?|visible\s+financial\s+ruin|broke|bankrupt|debt(?:or)?|indebted|social(?:ly)?\s+(?:ruin(?:ed)?|humiliat(?:ed|ion)|exil(?:ed|e))|emotional(?:ly)?\s+(?:collaps(?:ed|e)|broken)|betray(?:ed|al)|rejected|scapegoat(?:ed)?)\b/i;
  const physicalDamagePattern = /\b(?:ragged|filthy|dirty|grimy|dumpster|homeless|torn|shredded|ripped|stained|mud(?:dy)?|soot|blood(?:ied|y)?|bruised|wounded|injured|decay(?:ed)?|rotting|sickly|starving|gaunt|unkempt|trash|garbage)\b/i;
  const rows = [];
  for (const target of referenceTargets) {
    if (String(target.kind ?? "").toLowerCase() !== "character_state") continue;
    rows.push({
      ref_id: target.ref_id,
      field: "prompt_anchor",
      value: String(target.prompt_anchor ?? ""),
      path: `reference_targets.${target.ref_id}.prompt_anchor`,
    });
  }
  for (const ref of characterStateRefs) {
    rows.push({
      ref_id: ref.state_ref_id,
      field: "prompt_anchor",
      value: String(ref.prompt_anchor ?? ""),
      path: `character_state_refs.${ref.state_ref_id}.prompt_anchor`,
    });
    rows.push({
      ref_id: ref.state_ref_id,
      field: "scene_prompt_anchor",
      value: String(ref.scene_prompt_anchor ?? ""),
      path: `character_state_refs.${ref.state_ref_id}.scene_prompt_anchor`,
    });
  }
  return rows
    .filter((row) => abstractStatusPattern.test(row.value) && physicalDamagePattern.test(row.value))
    .map((row) => ({
      code: "abstract_status_as_physical_anchor_risk",
      severity: "warning",
      ref_id: row.ref_id,
      field: row.field,
      path: row.path,
      value: row.value.slice(0, 240),
      message: `${row.path} mixes abstract social/financial/emotional status with physical damage language. Manual review should verify those visible details are explicitly supported by the locked script or semantic visible_state.`,
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

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(items.length || 1, Number(concurrency) || 1));
  async function runWorker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

function sanitizeChunkReferenceCandidates(plan) {
  const warnings = Array.isArray(plan?.warnings) ? [...plan.warnings] : [];
  const referenceTargets = [];
  for (const rawTarget of Array.isArray(plan?.reference_targets) ? plan.reference_targets : []) {
    const target = normalizeTarget(rawTarget);
    const mode = String(target.generation_mode ?? "").toLowerCase();
    if (mode === "no_ref_needed" || /^derive_from_/i.test(mode)) {
      warnings.push({
        code: "chunk_text_or_derived_candidate_omitted",
        severity: "info",
        ref_id: target.ref_id,
        message: `Omitted ${target.ref_id} from global director candidates because chunk stages may propose only clean standalone, manual-review, or approved source references.`,
      });
      continue;
    }
    referenceTargets.push(target);
  }
  const targetIds = new Set(referenceTargets.map((target) => target.ref_id));
  const characterStateRefs = (Array.isArray(plan?.character_state_refs) ? plan.character_state_refs : [])
    .map(normalizeStateRef)
    .filter((ref) => targetIds.has(String(ref.source_ref_id ?? ref.state_ref_id ?? "")));
  return { ...plan, reference_targets: referenceTargets, character_state_refs: characterStateRefs, warnings };
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

async function createReferencePlan(semanticPlan, stageName, guidance = {}, evidenceLedger = null, locationContractLedger = null) {
  const useLocalRoute = isLocalLLMRoute(stageName);
  const useChunking = flags["visual-ref-chunking"] !== "false"
    && semanticPlan.scenes.length > Number(flags["visual-ref-single-call-max-scenes"] ?? 12);
  if (!useChunking) {
    const prompt = buildPrompt(semanticPlan, { guidance, inventoryLedger: evidenceLedger, locationContractLedger });
    const result = useLocalRoute ? await callLocal(prompt, stageName) : await callCodex(prompt, stageName);
    return {
      ...result,
      chunk_raw_target_count: Array.isArray(result.parsed?.reference_targets) ? result.parsed.reference_targets.length : 0,
      merged_target_count: Array.isArray(result.parsed?.reference_targets) ? result.parsed.reference_targets.length : 0,
      chunk_concurrency: 1,
    };
  }

  const sceneChunks = chunkArray(semanticPlan.scenes, Number(flags["visual-ref-chunk-scenes"] ?? 8));
  const chunkConcurrency = Math.max(1, Number(flags["visual-ref-chunk-concurrency"] ?? process.env.ANIFACTORY_VISUAL_REF_CHUNK_CONCURRENCY ?? 6));
  const chunkResults = await mapWithConcurrency(sceneChunks, chunkConcurrency, async (sceneChunk, index) => {
    console.error(`visual refs chunk ${index + 1}/${sceneChunks.length}: ${sceneChunks[index].length} scenes`);
    const chunkSemanticPlan = {
      ...semanticPlan,
      scenes: sceneChunk,
      scene_count: sceneChunk.length,
    };
    const prompt = buildPrompt(chunkSemanticPlan, {
      chunkLabel: `chunk ${index + 1} of ${sceneChunks.length}`,
      guidance,
      inventoryLedger: evidenceLedger,
      locationContractLedger,
    });
    const chunkStageName = `${stageName}_chunk_${String(index + 1).padStart(2, "0")}`;
    const llm = useLocalRoute
      ? await callLocal(prompt, chunkStageName, Number(flags["visual-ref-chunk-max-tokens"] ?? 7000))
      : await callCodex(prompt, chunkStageName);
    const rawTargetCount = Array.isArray(llm.parsed?.reference_targets) ? llm.parsed.reference_targets.length : 0;
    const candidatePlan = sanitizeChunkReferenceCandidates(llm.parsed);
    console.error(`visual refs chunk ${index + 1}/${sceneChunks.length}: proposed ${rawTargetCount} raw targets, retained ${candidatePlan.reference_targets.length} clean candidates`);
    return { candidatePlan, rawTargetCount };
  });
  const chunkPlans = chunkResults.map((result) => result.candidatePlan);
  const chunkRawTargetCount = chunkResults.reduce((sum, result) => sum + result.rawTargetCount, 0);
  if (!chunkPlans.some((plan) => plan.reference_targets.length)) throw new Error("Visual reference chunks returned no clean reference candidates for global director selection.");
  console.error(`visual refs merge: ${chunkPlans.length} chunk plans`);
  if (String(flags["visual-ref-merge-mode"] ?? "").toLowerCase() === "deterministic") {
    throw new Error("Deterministic visual-reference merge is disabled in director v2. The global LLM director must make the final creative selection.");
  }
  const mergePrompt = buildMergePrompt(semanticPlan, chunkPlans, guidance, evidenceLedger, locationContractLedger);
  const mergeStageName = `${stageName}_merge`;
  const merged = useLocalRoute
    ? await callLocal(mergePrompt, mergeStageName, Number(flags["visual-ref-merge-max-tokens"] ?? 8000))
    : await callCodex(mergePrompt, mergeStageName);
  if (!Array.isArray(merged.parsed?.reference_targets) || !merged.parsed.reference_targets.length) {
    throw new Error("Global visual-reference director returned no reference targets; refusing chunk-union fallback because it would turn local proposals into automatic generation orders.");
  }
  const parsed = merged.parsed;
  return {
    provider: merged.provider,
    model: useLocalRoute ? getLLMModel(stageName) : merged.model ?? configuredCodexModel(),
    reasoning_effort: merged.reasoning_effort ?? null,
    codex_cli_path: merged.codex_cli_path ?? null,
    codex_cli_version: merged.codex_cli_version ?? null,
    output_path: merged.output_path ?? null,
    chunked: true,
    chunk_count: sceneChunks.length,
    chunk_concurrency: Math.min(sceneChunks.length, chunkConcurrency),
    chunk_raw_target_count: chunkRawTargetCount,
    merged_target_count: parsed.reference_targets.length,
    parsed,
    json_attempt: merged.json_attempt,
  };
}

function finalDirectorSelectionFindings(referenceTargets, {
  llmTargetIds = new Set(),
  knownSceneIds = new Set(),
  legacyRevalidation = false,
} = {}) {
  const findings = [];
  const canonicalGroups = new Map();
  for (const target of referenceTargets ?? []) {
    const mode = String(target.generation_mode ?? "").toLowerCase();
    if (!legacyRevalidation && (mode === "no_ref_needed" || /^derive_from_/i.test(mode))) {
      findings.push({
        code: "director_selected_non_clean_reference_mode",
        severity: "blocker",
        ref_id: target.ref_id,
        generation_mode: mode,
        message: `Reference director selected ${target.ref_id} with ${mode}; v2 permits only clean standalone, manual-review, or approved source references.`,
      });
    }
    if (mode !== "source_only" && !llmTargetIds.has(String(target.ref_id ?? ""))) {
      findings.push({
        code: "post_llm_reference_target_expansion",
        severity: "blocker",
        ref_id: target.ref_id,
        message: `Post-LLM processing introduced ${target.ref_id}; deterministic stages may not restore or invent reference targets.`,
      });
    }
    const unknownSceneIds = (target.scene_ids ?? []).filter((sceneId) => !knownSceneIds.has(String(sceneId)));
    if (unknownSceneIds.length) {
      findings.push({
        code: "reference_target_unknown_scene_scope",
        severity: "blocker",
        ref_id: target.ref_id,
        scene_ids: unknownSceneIds,
        message: `Reference ${target.ref_id} contains scene ids outside the locked semantic plan.`,
      });
    }
    if (!legacyRevalidation && mode !== "source_only" && !(target.evidence_asset_ids ?? []).length) {
      findings.push({
        code: "reference_target_missing_evidence_trace",
        severity: "warning",
        ref_id: target.ref_id,
        message: `Reference ${target.ref_id} has no evidence_asset_ids; manual review should verify its story support.`,
      });
    }
    if (!legacyRevalidation && mode !== "source_only" && !String(target.clean_plate_contract ?? "").trim()) {
      findings.push({
        code: "reference_target_missing_clean_plate_contract",
        severity: "blocker",
        ref_id: target.ref_id,
        message: `Reference ${target.ref_id} does not state a clean_plate_contract.`,
      });
    }
    if (!legacyRevalidation && mode !== "source_only" && Number(target.conditioning_subject_count) !== 1) {
      findings.push({
        code: "reference_target_not_single_conditioning_concept",
        severity: "blocker",
        ref_id: target.ref_id,
        conditioning_subject_count: target.conditioning_subject_count,
        message: `Reference ${target.ref_id} must condition exactly one identity/state, environment, prop, UI motif, faction language, action/effect language, or style language.`,
      });
    }
    if (!legacyRevalidation && mode !== "source_only") {
      const allowedRoles = {
        style: new Set(["style_language"]),
        character_state: new Set(["identity_state", "faction_language"]),
        location: new Set(["environment"]),
        prop: new Set(["prop", "faction_language"]),
        ui: new Set(["ui_motif"]),
        action: new Set(["action_effect"]),
      }[normalizeKind(target.kind)] ?? new Set();
      if (!allowedRoles.has(String(target.conditioning_asset_role ?? ""))) {
        findings.push({
          code: "reference_target_conditioning_role_mismatch",
          severity: "blocker",
          ref_id: target.ref_id,
          kind: target.kind,
          conditioning_asset_role: target.conditioning_asset_role ?? null,
          message: `Reference ${target.ref_id} has a conditioning role that does not match its reference kind.`,
        });
      }
    }
    const canonicalId = String(target.canonical_subject_id ?? "").trim();
    if (canonicalId) {
      const key = [normalizeKind(target.kind), canonicalId, String(target.state_delta ?? "base")].join("|");
      if (!canonicalGroups.has(key)) canonicalGroups.set(key, []);
      canonicalGroups.get(key).push(target.ref_id);
    }
  }
  for (const [key, ids] of canonicalGroups.entries()) {
    if (ids.length <= 1) continue;
    findings.push({
      code: "duplicate_canonical_reference_family",
      severity: "blocker",
      canonical_key: key,
      ref_ids: ids,
      message: `Global director returned duplicate refs for canonical family ${key}: ${ids.join(", ")}.`,
    });
  }
  return findings;
}

function openingSelectedIdentityFindings(referenceTargets, visualBeatPlan) {
  const openingVisibleIds = new Set(visualBeatRows(visualBeatPlan)
    .filter((beat) => Number(beat.start_sec ?? 0) < 30)
    .flatMap((beat) => [
      ...(beat.physically_visible_entity_ids ?? []),
      ...(beat.screen_visible_entity_ids ?? []),
      ...(beat.preview_visible_entity_ids ?? []),
    ])
    .map(slug)
    .filter(Boolean));
  return (referenceTargets ?? []).flatMap((target) => {
    if (normalizeKind(target.kind) !== "character_state") return [];
    const subjectId = slug(target.canonical_subject_id ?? "", "");
    if (!subjectId || !openingVisibleIds.has(subjectId)) return [];
    const mode = String(target.generation_mode ?? "").toLowerCase();
    const generatable = mode === "standalone_ref" || target.required_before_imagegen === true || Boolean(target.reference_image_path ?? target.conditioning_image_path);
    if (generatable) return [];
    return [{
      code: "opening_visible_identity_not_generatable",
      severity: "blocker",
      ref_id: target.ref_id,
      canonical_subject_id: subjectId,
      generation_mode: mode,
      message: `Selected identity ${target.ref_id} is visibly used before 30 seconds but is not a generated, required, or approved source reference.`,
    }];
  });
}

function characterStateDirectorFindings(characterStateRefs, referenceTargets, { legacyRevalidation = false } = {}) {
  if (legacyRevalidation) return [];
  const findings = [];
  const targetIds = new Set((referenceTargets ?? []).map((target) => String(target?.ref_id ?? "")).filter(Boolean));
  const seenStateIds = new Set();
  for (const ref of characterStateRefs ?? []) {
    const stateRefId = String(ref?.state_ref_id ?? "").trim();
    if (!stateRefId) {
      findings.push({
        code: "character_state_ref_missing_id",
        severity: "blocker",
        message: "Character state contract is missing state_ref_id.",
      });
      continue;
    }
    if (seenStateIds.has(stateRefId)) {
      findings.push({
        code: "duplicate_character_state_ref_id",
        severity: "blocker",
        state_ref_id: stateRefId,
        message: `Global director returned duplicate character state id ${stateRefId}.`,
      });
    }
    seenStateIds.add(stateRefId);
    const sourceIds = [ref.source_ref_id, ref.base_identity_ref_id, stateRefId]
      .map((value) => String(value ?? "").trim())
      .filter(Boolean);
    if (!sourceIds.some((refId) => targetIds.has(refId))) {
      findings.push({
        code: "character_state_ref_missing_selected_source",
        severity: "blocker",
        state_ref_id: stateRefId,
        source_ref_ids: sourceIds,
        message: `Character state ${stateRefId} does not resolve to any final director-selected reference target.`,
      });
    }
    if (isCollectiveGroupSubject(`${ref.character ?? ""} ${stateRefId}`)) {
      findings.push({
        code: "generic_group_character_state_ref",
        severity: "blocker",
        state_ref_id: stateRefId,
        character: ref.character ?? null,
        message: `Generic group ${ref.character ?? stateRefId} must use a group/faction design target or scene prose, not a character identity state contract.`,
      });
    }
  }
  return findings;
}

function referenceSelectionTelemetry({
  evidenceLedger,
  locationContractLedger,
  llm,
  llmTargetCount,
  finalTargets,
  sourceOnlyAddedCount,
}) {
  const byKind = {};
  const byMode = {};
  for (const target of finalTargets ?? []) {
    const kind = normalizeKind(target.kind);
    const mode = String(target.generation_mode ?? "unknown");
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    byMode[mode] = (byMode[mode] ?? 0) + 1;
  }
  return {
    contract_version: "reference_director_v2",
    evidence_observation_count: evidenceLedger?.assets?.length ?? 0,
    location_contract_count: locationContractLedger?.contracts?.length ?? 0,
    chunk_raw_proposal_count: Number(llm?.chunk_raw_target_count ?? llmTargetCount),
    llm_merged_target_count: Number(llm?.merged_target_count ?? llmTargetCount),
    llm_selected_target_count: llmTargetCount,
    final_target_count: finalTargets.length,
    source_only_dependency_count_added_after_llm: sourceOnlyAddedCount,
    post_llm_non_source_expansion_count: finalTargets.filter((target) =>
      String(target.generation_mode ?? "").toLowerCase() !== "source_only"
      && !(llm?.parsed?.reference_targets ?? []).some((row) => String(row?.ref_id ?? "") === String(target.ref_id ?? ""))
    ).length,
    by_kind: byKind,
    by_generation_mode: byMode,
    chunk_count: llm?.chunk_count ?? 1,
    chunk_concurrency: llm?.chunk_concurrency ?? 1,
  };
}

export function referenceDirectorSelectionFindingsForTests(referenceTargets, options = {}) {
  return finalDirectorSelectionFindings(referenceTargets, options);
}

export function referenceCharacterStateFindingsForTests(characterStateRefs, referenceTargets, options = {}) {
  return characterStateDirectorFindings(characterStateRefs, referenceTargets, options);
}

export function referenceOpeningIdentityFindingsForTests(referenceTargets, visualBeatPlan) {
  return openingSelectedIdentityFindings(referenceTargets, visualBeatPlan);
}

async function main() {
  const [semanticPlan, visualBeatPlan, storyFactLedger, visualStyleBible, characterBible, episodeVisualDirection, runIdentity] = await Promise.all([
    readJson(semanticPlanPath, null),
    readJson(visualBeatPlanPath, null),
    readJson(storyFactLedgerPath, null),
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
  if (runIdentity?.schema === "goldflow_run_identity_v2" && (storyFactLedger?.status !== "passed" || storyFactLedger.source_script_hash !== semanticPlan.source_script_hash)) {
    throw new Error(`Reference Director v2 requires current story_fact_ledger.json: ${storyFactLedgerPath}`);
  }
  const guidance = { visualStyleBible, characterBible, episodeVisualDirection, storyFactLedger };
  const referenceEvidenceLedger = buildReferenceEvidenceLedger(scopedSemantic, visualBeatPlan, {
    outputPath: referenceEvidenceLedgerOutputPath,
  });
  const locationContractLedger = buildLocationContractLedger(scopedSemantic, {
    outputPath: locationContractLedgerOutputPath,
  });
  await Promise.all([
    writeJson(referenceEvidenceLedgerOutputPath, referenceEvidenceLedger),
    writeJson(locationContractLedgerOutputPath, locationContractLedger),
  ]);
  if (locationContractLedger.status !== "passed") {
    throw new Error(`Location contract ledger is blocked: ${locationContractLedger.findings.filter((finding) => finding.severity === "blocker").map((finding) => finding.scene_id).join(", ")}`);
  }
  const existingReferencePlan = flags["revalidate-existing"] === "true" ? await readJson(outputPath, null) : null;
  const legacyRevalidation = Boolean(existingReferencePlan);
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
    : await createReferencePlan(scopedSemantic, stageName, guidance, referenceEvidenceLedger, locationContractLedger);
  let referenceTargets = (Array.isArray(llm.parsed.reference_targets) ? llm.parsed.reference_targets : []).map(normalizeTarget);
  const llmTargetIds = new Set(referenceTargets.map((target) => String(target.ref_id ?? "")));
  const llmTargetCount = referenceTargets.length;
  const shouldDropStyleRefs = dropStyleRefs || (Boolean(visualStyleBible) && !keepStyleRefs);
  if (shouldDropStyleRefs) {
    referenceTargets = referenceTargets.filter((target) => String(target.kind ?? "").toLowerCase() !== "style");
  }
  const deterministicLocationScope = applyDeterministicLocationSceneIds(referenceTargets, scopedSemantic.scenes);
  referenceTargets = deterministicLocationScope.targets;
  const locationContractScope = applyLocationContractSceneIds(referenceTargets, locationContractLedger);
  referenceTargets = locationContractScope.targets;
  const beatLocationScope = applyBeatLocationSceneIds(referenceTargets, visualBeatRows(visualBeatPlan));
  referenceTargets = beatLocationScope.targets;
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
  const sourceOnlyAddedCount = referenceTargets.filter((target) =>
    String(target.generation_mode ?? "").toLowerCase() === "source_only"
    && !llmTargetIds.has(String(target.ref_id ?? ""))
  ).length;
  const canonicalIdentityMerge = mergeCanonicalBaseIdentityRefs(referenceTargets, characterStateRefs);
  referenceTargets = canonicalIdentityMerge.referenceTargets;
  characterStateRefs = canonicalIdentityMerge.characterStateRefs;
  const finalCanonicalIdentityMerge = mergeCanonicalBaseIdentityRefs(referenceTargets, characterStateRefs);
  referenceTargets = finalCanonicalIdentityMerge.referenceTargets;
  characterStateRefs = finalCanonicalIdentityMerge.characterStateRefs;
  const finalIdentityAliasCollapse = collapseCharacterIdentityAliasTargets(referenceTargets, characterStateRefs);
  referenceTargets = finalIdentityAliasCollapse.referenceTargets;
  characterStateRefs = finalIdentityAliasCollapse.characterStateRefs;
  const anchorLanguageWarnings = [
    ...providerExclusionPayloadAnchorWarnings(referenceTargets, characterStateRefs),
    ...abstractStatusAsPhysicalAnchorWarnings(referenceTargets, characterStateRefs),
  ];
  const promptFacingPrune = prunePromptFacingNoRefTargets(referenceTargets);
  referenceTargets = promptFacingPrune.referenceTargets;
  const directorSelectionFindings = finalDirectorSelectionFindings(referenceTargets, {
    llmTargetIds,
    knownSceneIds: new Set(scopedSemantic.scenes.map((scene) => String(scene.scene_id ?? ""))),
    legacyRevalidation,
  });
  const openingIdentityFindings = openingSelectedIdentityFindings(referenceTargets, visualBeatPlan);
  const characterStateFindings = characterStateDirectorFindings(characterStateRefs, referenceTargets, { legacyRevalidation });
  const coverageFindings = locationContractLedger.findings ?? [];
  const styleFindings = shouldDropStyleRefs ? [] : styleReferenceContaminationFindings(referenceTargets);
  const findings = [...coverageFindings, ...locationContractScope.findings, ...styleFindings, ...directorSelectionFindings, ...openingIdentityFindings, ...characterStateFindings];
  const status = findings.some((finding) => finding.severity === "blocker") ? "blocked" : "passed";
  const referenceInventoryLedger = buildSelectedReferenceInventory(referenceTargets, {
    sourceScriptHash: semanticPlan.source_script_hash,
    evidenceLedgerPath: referenceEvidenceLedgerOutputPath,
    locationLedgerPath: locationContractLedgerOutputPath,
    outputPath: referenceInventoryLedgerOutputPath,
  });
  await writeJson(referenceInventoryLedgerOutputPath, referenceInventoryLedger);
  const selectionTelemetry = referenceSelectionTelemetry({
    evidenceLedger: referenceEvidenceLedger,
    locationContractLedger,
    llm,
    llmTargetCount,
    finalTargets: referenceTargets,
    sourceOnlyAddedCount,
  });
  const sourceArtifactPaths = [
    semanticPlanPath,
    visualBeatPlan?.status === "passed" ? visualBeatPlanPath : null,
    storyFactLedger?.status === "passed" ? storyFactLedgerPath : null,
    referenceEvidenceLedgerOutputPath,
    locationContractLedgerOutputPath,
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
      story_fact_ledger_path: storyFactLedger?.status === "passed" ? storyFactLedgerPath : null,
      reference_evidence_ledger_path: referenceEvidenceLedgerOutputPath,
      location_contract_ledger_path: locationContractLedgerOutputPath,
      reference_inventory_ledger_path: referenceInventoryLedgerOutputPath,
      visual_style_bible_path: visualStyleBible ? visualStyleBiblePath : null,
      character_bible_path: characterBible ? characterBiblePath : null,
      episode_visual_direction_path: episodeVisualDirection.trim() ? episodeVisualDirectionPath : null,
    },
    visual_reference_scope: scope,
    reference_director_contract_version: legacyRevalidation ? "legacy_revalidation" : "reference_director_v2",
    reference_evidence_ledger_path: referenceEvidenceLedgerOutputPath,
    location_contract_ledger_path: locationContractLedgerOutputPath,
    reference_inventory_ledger_path: referenceInventoryLedgerOutputPath,
    reference_inventory_summary: referenceInventoryLedger.summary,
    reference_selection_telemetry: selectionTelemetry,
    style_reference_policy: shouldDropStyleRefs
      ? "style refs dropped for this run; use style bible/text guidance only"
      : "style refs allowed only as abstract rendering/material/lighting samples",
    planner: {
      provider: llm.provider,
      model: llm.model ?? null,
      reasoning_effort: llm.reasoning_effort ?? null,
      codex_cli_path: llm.codex_cli_path ?? null,
      codex_cli_version: llm.codex_cli_version ?? null,
      output_path: llm.output_path ?? null,
      chunked: llm.chunked ?? false,
      chunk_count: llm.chunk_count ?? null,
      chunk_concurrency: llm.chunk_concurrency ?? null,
      chunk_raw_target_count: llm.chunk_raw_target_count ?? null,
      merged_target_count: llm.merged_target_count ?? llmTargetCount,
    },
    reference_budget: {
      profile: "llm_directed_v2",
      policy: "The global reference-director LLM is the sole creative selector. Deterministic code may validate, canonicalize, scope, and add source-only dependencies; it never restores omitted generated targets.",
      llm_selected_target_count: llmTargetCount,
      final_target_count: referenceTargets.length,
    },
    provider_exclusion_payload_policy: "LLM-authored anchor language is preserved. Separate provider-exclusion payload fields and embedded provider-exclusion sections are disallowed before provider use.",
    policy: "Reference strategy only. Manual review must approve prompt anchors before reference generation or production imagegen.",
    reference_targets: referenceTargets,
    character_state_refs: characterStateRefs,
    findings,
    warnings: [
      ...(llm.parsed.warnings ?? []),
      ...deterministicLocationScope.warnings,
      ...promptFacingPrune.warnings,
      ...anchorLanguageWarnings,
      ...findings,
      ...sourceFaceAnchoring.warnings,
      ...canonicalIdentityMerge.warnings,
      ...finalCanonicalIdentityMerge.warnings,
      ...finalIdentityAliasCollapse.warnings,
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
  console.log(JSON.stringify({
    status,
    output_path: outputPath,
    character_state_refs_output_path: characterStateRefsOutputPath,
    reference_evidence_ledger_path: referenceEvidenceLedgerOutputPath,
    location_contract_ledger_path: locationContractLedgerOutputPath,
    reference_inventory_ledger_path: referenceInventoryLedgerOutputPath,
    reference_target_count: referenceTargets.length,
    character_state_ref_count: report.character_state_refs.length,
    reference_selection_telemetry: selectionTelemetry,
  }, null, 2));
  if (status !== "passed") process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    await writeJson(outputPath, { schema: "goldflow_visual_reference_plan_v1", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() }).catch(() => {});
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
