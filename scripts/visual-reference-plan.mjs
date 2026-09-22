#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getLLMModel, isLocalLLMRoute, localLLMAuthHeaders, localLLMChatCompletionURL } from "./lib/llm-router.mjs";
import { configuredCodexModel, isCodexCacheCompatible, readCodexCallMetadata, runCodexCli } from "./lib/codex-cli-runner.mjs";
import { recordPlannerChunkCheckpoint } from "./lib/planner-chunk-ledger.mjs";
import { isSourceSceneLocationBeat } from "./lib/editorial-beat-director.mjs";
import { compactReferencePromptValue, REFERENCE_PROMPT_TABLE_INSTRUCTION } from "./lib/reference-prompt-format.mjs";
import {
  buildReferenceDirectorSelectionReceipt,
  referenceDirectorSelectionFidelityFindings,
} from "./lib/reference-selection-fidelity.mjs";
import {
  applyBeatLocationSceneIds,
  applyCanonicalCharacterIdentitySceneIds,
  applyDeterministicLocationSceneIds,
} from "./lib/visual-scope-utils.mjs";
import {
  contentProfileForIdentity,
  contentProfilePlannerDirective,
  contentProfilePlannerRole,
  contentProfileReferenceInstruction,
} from "./lib/content-profiles.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
let activeContentProfile = contentProfileForIdentity({});
const weekDir = path.join(dataRoot, "channels", channel, "weekly_runs", week);
const episodeDir = path.join(weekDir, "episodes", episode);
const runIdentityPath = path.join(episodeDir, "run_identity.json");
const semanticPlanPath = flags.semantic ?? path.join(episodeDir, "semantic_scene_plan.json");
const visualBeatPlanPath = flags.beats ?? flags["visual-beats"] ?? path.join(episodeDir, "visual_beat_plan.json");
const storyFactLedgerPath = flags["story-fact-ledger"] ?? path.join(episodeDir, "story_fact_ledger.json");
const outputPath = flags.output ?? path.join(episodeDir, "visual_reference_plan.json");
const referencePartialPath = flags["reference-partial"]
  ?? path.join(episodeDir, `visual_reference_partial_${episode}.json`);
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
const referenceCleanlinessContractVersion = "empty_hands_no_detachable_props_v1";
export const VISUAL_REFERENCE_CHUNK_SAFE_MAX_BYTES = 52_000;
// The global director receives compact selection rows rather than full reference
// objects. A 224 KiB ceiling keeps large episodes in one creative selection call
// while remaining well below the Codex planning context limit.
export const VISUAL_REFERENCE_DIRECTOR_SAFE_MAX_BYTES = 224 * 1024;

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
  const visualBeats = scene.visual_beats ?? [];
  const beatReferenceHints = new Map();
  for (const need of visualBeats.flatMap((beat) => beat.ref_needs ?? beat.beat_ref_requirements ?? [])) {
    const refId = String(need?.ref_id ?? need?.subject ?? "").trim();
    if (!refId || beatReferenceHints.has(refId)) continue;
    beatReferenceHints.set(refId, [
      refId,
      need.kind ?? null,
      need.subject ?? null,
      need.generation_mode ?? null,
      need.suggested_required_before_imagegen === true ? 1 : 0,
    ]);
  }
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
    continuity_notes: (scene.continuity_notes ?? []).slice(0, 8),
    visual_beat_fields: [
      "visual_beat_id",
      "start_sec",
      "visual_job",
      "depiction_mode",
      "evidence_excerpt",
      "visible_subjects",
      "local_location",
      "local_props",
      "local_ui_elements",
      "active_entity_ids",
    ],
    visual_beat_rows: visualBeats.map((beat) => [
      beat.visual_beat_id ?? null,
      beat.start_sec ?? null,
      beat.visual_job ?? beat.suggested_shot_job ?? null,
      beat.depiction_mode ?? null,
      String(beat.visual_beat_script_excerpt ?? beat.script_excerpt ?? "").slice(0, 84),
      beat.visible_subjects ?? [],
      beat.local_location ?? beat.location ?? null,
      beat.local_props ?? beat.props ?? [],
      beat.local_ui_elements ?? beat.ui_text_on_screen ?? [],
      Object.keys(beat.active_state_constraints?.entities ?? {}),
    ]),
    beat_reference_hint_fields: ["ref_id", "kind", "subject", "suggested_mode", "suggested_required_1_or_0"],
    beat_reference_hint_rows: [...beatReferenceHints.values()],
  };
}

export function compactStoryFactLedgerForPromptForTests(storyFactLedger, evidence = null) {
  if (!storyFactLedger || typeof storyFactLedger !== "object") return null;
  const evidenceText = evidence == null ? null : JSON.stringify(evidence).toLowerCase();
  const relevant = (row, idField) => !evidenceText || [
    row?.[idField],
    row?.display_name,
    ...(row?.aliases ?? []),
  ].map((value) => String(value ?? "").trim().toLowerCase()).filter((value) => value.length >= 3)
    .some((value) => evidenceText.includes(value));
  const compactNamedRows = (rows, idField) => (Array.isArray(rows) ? rows : [])
    .filter((row) => relevant(row, idField))
    .slice(0, evidenceText ? 32 : 60)
    .map((row) => ({
    [idField]: row?.[idField] ?? null,
    display_name: row?.display_name ?? null,
    kind: row?.kind ?? null,
    aliases: row?.aliases ?? [],
  }));
  const canonicalEntities = compactNamedRows(storyFactLedger.canonical_entities, "entity_id");
  const selectedEntityIds = new Set(canonicalEntities.map((row) => row.entity_id));
  return {
    canonical_entities: canonicalEntities,
    canonical_locations: compactNamedRows(storyFactLedger.canonical_locations, "location_id"),
    canonical_props: compactNamedRows(storyFactLedger.canonical_props, "prop_id"),
    canonical_ui_motifs: compactNamedRows(storyFactLedger.canonical_ui_motifs, "ui_id"),
    state_transitions: (Array.isArray(storyFactLedger.state_transitions) ? storyFactLedger.state_transitions : [])
      .filter((row) => !evidenceText || selectedEntityIds.has(row?.entity_id))
      .slice(0, evidenceText ? 16 : 24)
      .map((row) => ({
      entity_id: row?.entity_id ?? null,
      state_kind: row?.state_kind ?? null,
      from_state: row?.from_state ?? null,
      to_state: row?.to_state ?? null,
      transition_evidence_excerpt: String(row?.transition_evidence_excerpt ?? "").slice(0, 180),
    })),
  };
}

function visualGuidanceBlock(guidance = {}, semanticEvidence = null) {
  const bibleExcerpt = (value, maxChars) => {
    if (!value) return null;
    const serialized = JSON.stringify(value);
    return serialized.length <= maxChars
      ? value
      : { source_sha256: sha256(serialized), compact_excerpt: serialized.slice(0, maxChars) };
  };
  return JSON.stringify({
    visual_style_bible: bibleExcerpt(guidance.visualStyleBible, 2_000),
    character_bible: bibleExcerpt(guidance.characterBible, 3_000),
    episode_visual_direction: String(guidance.episodeVisualDirection ?? "").slice(0, 1_200),
    story_fact_ledger: compactStoryFactLedgerForPromptForTests(guidance.storyFactLedger, semanticEvidence),
  });
}

function visualMergeGuidanceBlock(guidance = {}) {
  const facts = compactStoryFactLedgerForPromptForTests(guidance.storyFactLedger);
  return JSON.stringify({
    visual_style_bible: guidance.visualStyleBible ?? null,
    character_bible: guidance.characterBible ?? null,
    episode_visual_direction: String(guidance.episodeVisualDirection ?? "").slice(0, 5000),
    canonical_story_entities: facts ? {
      canonical_entities: facts.canonical_entities,
      canonical_locations: facts.canonical_locations,
      canonical_props: facts.canonical_props,
      canonical_ui_motifs: facts.canonical_ui_motifs,
      state_transition_count: facts.state_transitions.length,
    } : null,
  });
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

function canonicalReferenceAliasIndex(storyFactLedger = {}) {
  const indexByKind = new Map();
  const groups = [
    ["character_state", storyFactLedger?.canonical_entities, ["entity_id", "canonical_entity_id"]],
    ["location", storyFactLedger?.canonical_locations, ["location_id", "canonical_location_id"]],
    ["prop", storyFactLedger?.canonical_props, ["prop_id", "canonical_prop_id"]],
    ["ui", storyFactLedger?.canonical_ui_motifs, ["ui_id", "canonical_ui_id"]],
  ];
  for (const [kind, rows, idFields] of groups) {
    const candidatesByAlias = new Map();
    const evidencePhrases = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const canonicalId = idFields.map((field) => row?.[field]).find(Boolean);
      if (!canonicalId) continue;
      const normalizedId = slug(canonicalId, "");
      if (!normalizedId) continue;
      const displayName = String(row?.display_name ?? row?.name ?? row?.label ?? canonicalId).trim();
      const record = {
        canonical_id: normalizedId,
        display_name: displayName || normalizedId,
        entity_kind: kind === "character_state" ? String(row?.kind ?? "").trim().toLowerCase() || null : null,
      };
      const shortEvidenceAliases = (Array.isArray(row?.evidence) ? row.evidence : [])
        .map((item) => String(item?.exact_excerpt ?? "").replace(/\s+/g, " ").trim())
        .filter((label) => label && label.length <= 120 && label.split(/\s+/).length <= 12);
      for (const label of shortEvidenceAliases) {
        const phrase = slug(label, "");
        if (phrase) evidencePhrases.push({ phrase, record });
      }
      for (const label of [canonicalId, displayName, ...(Array.isArray(row?.aliases) ? row.aliases : []), ...shortEvidenceAliases]) {
        const alias = slug(label, "");
        if (!alias) continue;
        if (!candidatesByAlias.has(alias)) candidatesByAlias.set(alias, new Map());
        candidatesByAlias.get(alias).set(normalizedId, record);
      }
    }
    indexByKind.set(kind, {
      exact: new Map(
        [...candidatesByAlias.entries()]
          .filter(([, candidates]) => candidates.size === 1)
          .map(([alias, candidates]) => [alias, [...candidates.values()][0]]),
      ),
      evidence_phrases: evidencePhrases,
    });
  }
  return indexByKind;
}

function canonicalFromEvidenceContainment(subject, evidencePhrases = [], kind = "") {
  const normalizedSubject = slug(subject, "");
  if (!normalizedSubject) return null;
  const contentTokens = normalizedSubject.split("_").filter((token) => token && !new Set([
    "a", "an", "the", "his", "her", "its", "their", "this", "that",
  ]).has(token));
  if (contentTokens.length < 2) {
    const safeSingleTokenAliases = {
      prop: new Set(["weapon", "sword", "blade", "spear", "bow", "shield", "gun", "rifle", "pistol", "axe", "hammer", "staff", "wand", "knife", "dagger", "key", "coin", "bell", "orb", "gem", "crystal", "crown", "mask", "amulet", "ring", "book", "phone", "tablet", "document", "letter", "contract", "ledger", "scroll", "map", "lantern", "chain"]),
      ui: new Set(["system", "interface", "panel", "screen", "window", "menu", "ledger", "status", "ranking", "quest", "warning", "notification"]),
      location: new Set(["hall", "room", "vault", "palace", "academy", "arena", "office", "street", "alley", "bridge", "tower", "chamber", "court", "courtyard", "rooftop", "warehouse", "dungeon", "forest", "city", "village"]),
    };
    if (contentTokens.length !== 1 || !safeSingleTokenAliases[kind]?.has(contentTokens[0])) return null;
  }
  const needle = `_${normalizedSubject}_`;
  const matches = new Map();
  for (const candidate of evidencePhrases) {
    if (`_${candidate.phrase}_`.includes(needle)) {
      matches.set(candidate.record.canonical_id, candidate.record);
    }
  }
  return matches.size === 1 ? [...matches.values()][0] : null;
}

function buildReferenceEvidenceLedger(scopedSemantic, visualBeatPlan, {
  outputPath: ledgerPath = referenceEvidenceLedgerOutputPath,
  storyFactLedger = null,
} = {}) {
  const semanticScenes = scopedSemantic?.scenes ?? [];
  const scenes = sceneById(semanticScenes);
  const beats = beatRowsFromScopedSemantic(scopedSemantic);
  const assets = new Map();
  const canonicalAliases = canonicalReferenceAliasIndex(storyFactLedger ?? {});

  function addAsset({ kind, refId, subject, canonicalId = null, sceneId, beat = null, reason = null, source = null, semanticRefId = null, entityKind = null }) {
    const normalizedKind = normalizeKind(kind);
    if (!["character_state", "location", "prop", "ui", "action"].includes(normalizedKind)) return;
    const rawSubject = String(subject ?? refId ?? "").trim();
    let cleanSubject = normalizedKind === "character_state" && shouldPreferCharacterRefIdSubject(rawSubject, refId)
      ? (characterSubjectFromRefId(refId) ?? rawSubject)
      : rawSubject;
    if (!cleanSubject) return;
    const assetKind = normalizedKind;
    const sourceSceneLocation = assetKind === "location" && isSourceSceneLocationBeat(beat);
    const canonicalIndex = canonicalAliases.get(assetKind) ?? { exact: new Map(), evidence_phrases: [] };
    const canonical = sourceSceneLocation ? null : [canonicalId, refId, cleanSubject]
      .map((value) => slug(value, ""))
      .filter(Boolean)
      .map((key) => canonicalIndex.exact.get(key))
      .find(Boolean)
      ?? canonicalFromEvidenceContainment(cleanSubject, canonicalIndex.evidence_phrases, assetKind)
      ?? null;
    const resolvedEntityKind = String(entityKind ?? canonical?.entity_kind ?? "").trim().toLowerCase() || null;
    if (assetKind === "character_state" && resolvedEntityKind === "organization") return;
    if (canonical?.display_name) cleanSubject = canonical.display_name;
    let resolvedRefId = refId
      ? slug(refId)
      : inventoryRefIdFor(assetKind, cleanSubject, "asset");
    let assetId = assetKind === "character_state" && !refId
      ? inventoryRefIdFor("character_state", cleanSubject, "character").replace(/_ref$/i, "_identity")
      : resolvedRefId;
    if (canonical) {
      resolvedRefId = canonical.canonical_id;
      assetId = assetKind === "character_state"
        ? `char_${canonical.canonical_id.replace(/^char_/, "")}_identity`
        : inventoryRefIdFor(assetKind, canonical.canonical_id, canonical.canonical_id);
    }
    if (!sourceSceneLocation && !refId && assetKind === "location" && sceneId) {
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
        canonical_subject_id: canonical?.canonical_id ?? null,
        observed_aliases: new Set(),
        scene_ids: new Set(),
        beat_ids: new Set(),
        semantic_ref_ids: new Set(),
        beat_ref_ids: new Set(),
        entity_kinds: new Set(),
        reasons: new Set(),
        sources: new Set(),
        evidence_excerpts: [],
        first_start_sec: null,
        last_start_sec: null,
      });
    }
    const row = assets.get(assetId);
    if (rawSubject) row.observed_aliases.add(rawSubject);
    if (cleanSubject.length > String(row.subject ?? "").length && !refId) row.subject = cleanSubject;
    if (sceneId) row.scene_ids.add(sceneId);
    if (beat?.visual_beat_id) row.beat_ids.add(beat.visual_beat_id);
    if (semanticRefId) row.semantic_ref_ids.add(semanticRefId);
    if (refId) row.beat_ref_ids.add(refId);
    if (resolvedEntityKind) row.entity_kinds.add(resolvedEntityKind);
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
    const visibleEntityRows = Array.isArray(beat.visible_entities) ? beat.visible_entities : [];
    const visibleEntityIds = [
      ...(beat.physically_visible_entity_ids ?? []),
      ...(beat.screen_visible_entity_ids ?? []),
      ...(beat.preview_visible_entity_ids ?? []),
    ];
    for (const [index, character] of visibleCharacters.entries()) {
      const entityRow = visibleEntityRows.find((row) => String(row?.display_name ?? "") === String(character))
        ?? visibleEntityRows[index]
        ?? null;
      const entityId = entityRow?.entity_id ?? visibleEntityIds[index] ?? null;
      const entityKind = entityRow?.kind ?? beat.visible_entity_kinds?.[entityId] ?? null;
      addAsset({
        kind: "character_state",
        refId: null,
        subject: character,
        canonicalId: entityId,
        sceneId,
        beat,
        reason: entityKind && String(entityKind).toLowerCase() !== "person"
          ? "visible local beat identity-bearing nonhuman actor"
          : "visible local beat character",
        source: entityKind && String(entityKind).toLowerCase() !== "person"
          ? "visual_beat_visible_nonhuman_actor"
          : "visual_beat_visible_character",
        entityKind,
      });
    }
    const location = beat.local_location ?? beat.location;
    if (location) {
      addAsset({
        kind: "location",
        refId: null,
        subject: location,
        canonicalId: beat.location_id ?? null,
        sceneId,
        beat,
        reason: "local visual beat location",
        source: "visual_beat_location",
      });
    }
    for (const [index, prop] of (Array.isArray(beat.local_props) ? beat.local_props : []).entries()) {
      addAsset({
        kind: "prop",
        refId: null,
        subject: prop,
        canonicalId: Array.isArray(beat.local_prop_ids) ? beat.local_prop_ids[index] : null,
        sceneId,
        beat,
        reason: "local visual beat prop",
        source: "visual_beat_prop",
      });
    }
    for (const [index, ui] of (Array.isArray(beat.local_ui_elements) ? beat.local_ui_elements : []).entries()) {
      addAsset({
        kind: "ui",
        refId: null,
        subject: ui,
        canonicalId: Array.isArray(beat.local_ui_ids) ? beat.local_ui_ids[index] : null,
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
      canonical_subject_id: asset.canonical_subject_id,
      canonical_subject_key: asset.canonical_subject_id ?? slug(asset.subject, asset.asset_id),
      observed_aliases: [...asset.observed_aliases].filter(Boolean).sort(),
      entity_kind: [...asset.entity_kinds][0] ?? null,
      entity_type: asset.kind === "character_state" && [...asset.entity_kinds]
        .some((kind) => /^(?:creature|construct|summon|spirit|undead)$/i.test(String(kind)))
        ? "distinct_nonhuman_actor"
        : asset.kind === "character_state" && (
          [...asset.entity_kinds].some((kind) => /^(?:creature_group|group)$/i.test(String(kind)))
          || isGenericGroupSubject(`${asset.subject ?? ""} ${asset.asset_id ?? ""}`)
        )
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
        severity: "warning",
        production_blocking: false,
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
      const scopedBeats = matchingBeats.length ? matchingBeats : beats.filter((beat) => !isSourceSceneLocationBeat(beat));
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
        if (isSourceSceneLocationBeat(beat) && !contracts.has(contractId)
          && (beat.ref_needs ?? beat.beat_ref_requirements ?? []).some((need) => (
            normalizeKind(need?.kind) === "location" && slug(need?.ref_id ?? "") === contractId
            && need.subject === beat.local_location
          ))) {
          contracts.set(contractId, {
            location_contract_id: contractId,
            semantic_ref_id: null,
            description: beat.local_location,
            prompt_anchor: beat.local_location,
            scene_ids: [],
            beat_ids: [],
            local_location_labels: [],
            reasons: ["Exact source scene location; no canonical location ID or inherited venue reference."],
            location_provenance: beat.location_provenance,
          });
        }
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
      identity_subtype: target.identity_subtype ?? null,
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
    policy: "LLM-selected canonical attachable reference inventory. Deterministic stages validate the complete global-director selection without capping, pruning, merging away, or downgrading selected targets; unusable structural rows remain explicit blockers rather than disappearing.",
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
          severity: "warning",
          production_blocking: false,
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

export function referenceEvidenceLedgerForTests(semanticPlan, storyFactLedger = null) {
  return buildReferenceEvidenceLedger(semanticPlan, null, {
    outputPath: "reference_evidence_ledger.json",
    storyFactLedger,
  });
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
    entity_kind: asset.entity_kind ?? null,
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
  if (kind === "character_state" && ["named_or_distinct_character", "distinct_nonhuman_actor"].includes(asset?.entity_type)) return true;
  if ((asset?.semantic_ref_ids ?? []).length > 0 && kind === "location") return true;
  return scenes >= 2 || beats >= 3;
}

export function unselectedDistinctNonhumanActorFindingsForTests(evidenceLedger, referenceTargets) {
  const selectedEvidenceIds = new Set((referenceTargets ?? [])
    .flatMap((target) => target?.evidence_asset_ids ?? [])
    .map(String)
    .filter(Boolean));
  const selectedSubjectKeys = new Set((referenceTargets ?? [])
    .flatMap((target) => [
      target?.canonical_subject_id,
      target?.subject,
    ])
    .map((value) => slug(value, ""))
    .filter(Boolean));
  return (evidenceLedger?.assets ?? [])
    .filter((asset) => asset?.entity_type === "distinct_nonhuman_actor")
    .filter((asset) => {
      const assetId = String(asset.asset_id ?? "");
      const subjectKey = slug(asset.canonical_subject_key ?? asset.subject, "");
      return !selectedEvidenceIds.has(assetId) && (!subjectKey || !selectedSubjectKeys.has(subjectKey));
    })
    .map((asset) => ({
      code: "distinct_nonhuman_actor_reference_not_selected",
      severity: "warning",
      review_required: true,
      review_disposition: "manual_fix_or_accept",
      production_blocking: false,
      asset_id: asset.asset_id,
      subject: asset.subject,
      scene_ids: asset.scene_ids ?? [],
      beat_ids: asset.beat_ids ?? [],
      message: `Reference director did not select a standalone identity/anatomy reference for distinct nonhuman actor ${asset.subject}. Confirm text-only continuity is intentional or manually repair the reference plan before approval.`,
    }));
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

export function compactInventoryForPromptForTests(inventoryLedger, sceneIds = null, options = {}) {
  return compactInventoryForPrompt(inventoryLedger, sceneIds, options);
}

export function compactSceneReferenceEvidenceForTests(inventoryLedger, sceneIds = null, options = {}) {
  const compact = compactInventoryForPrompt(inventoryLedger, sceneIds, {
    maxAssets: Number(options.maxAssets ?? 36),
    evidenceLimit: 0,
    sceneIdLimit: Number(options.sceneIdLimit ?? 4),
  });
  return {
    schema: compact.schema,
    summary: compact.summary,
    chunk_scene_ids: compact.chunk_scene_ids,
    asset_count: compact.assets.length,
    asset_fields: ["asset_id", "kind", "subject", "entity_type", "scene_count", "beat_count", "semantic_ref_ids"],
    asset_rows: compact.assets.map((asset) => [
      asset.asset_id,
      asset.kind,
      String(asset.subject ?? "").slice(0, 90),
      asset.entity_type ?? asset.entity_kind ?? null,
      asset.distinct_scene_count ?? asset.scene_ids?.length ?? 0,
      asset.beat_count ?? 0,
      (asset.semantic_ref_ids ?? []).slice(0, 4),
    ]),
  };
}

export function compactReferenceEvidenceLedgerForDirectorCardsForTests(inventoryLedger, options = {}) {
  const compact = compactInventoryForPrompt(inventoryLedger, null, {
    referenceValueOnly: true,
    maxAssets: Number(options.maxAssets ?? 320),
    evidenceLimit: 0,
    sceneIdLimit: 0,
  });
  return {
    schema: compact.schema,
    summary: compact.summary,
    asset_count: compact.assets.length,
    asset_lines: compact.assets.map((asset) => [
      asset.asset_id,
      `kind=${asset.kind}`,
      `subject=${readableCardValue(asset.subject, 100)}`,
      `entity=${asset.entity_type ?? asset.entity_kind ?? "unspecified"}`,
      `scenes=${asset.distinct_scene_count ?? 0}`,
      `beats=${asset.beat_count ?? 0}`,
      `span_sec=${Math.round(Number(asset.reuse_span_sec ?? 0))}`,
      asset.canonical_subject_key ? `canonical=${readableCardValue(asset.canonical_subject_key, 70)}` : null,
    ].filter(Boolean).join(" | ")),
  };
}

export function compactLocationContractLedgerForPromptForTests(locationContractLedger) {
  if (!locationContractLedger || typeof locationContractLedger !== "object") return locationContractLedger;
  const contracts = Array.isArray(locationContractLedger.contracts)
    ? locationContractLedger.contracts
    : Array.isArray(locationContractLedger.locations)
      ? locationContractLedger.locations
      : [];
  return {
    schema: locationContractLedger.schema ?? "goldflow_location_contract_ledger_v1",
    status: locationContractLedger.status ?? null,
    contracts: contracts.map((contract) => ({
      location_contract_id: contract.location_contract_id,
      semantic_ref_id: contract.semantic_ref_id ?? null,
      description: contract.description ?? null,
      prompt_anchor: contract.prompt_anchor ?? null,
      scene_ids: contract.scene_ids ?? [],
      beat_count: Array.isArray(contract.beat_ids) ? contract.beat_ids.length : Number(contract.beat_count ?? 0),
      local_location_labels: contract.local_location_labels ?? [],
      reasons: contract.reasons ?? [],
    })),
  };
}

export function compactLocationContractLedgerForDirectorCardsForTests(locationContractLedger) {
  const compact = compactLocationContractLedgerForPromptForTests(locationContractLedger);
  if (!compact || typeof compact !== "object") return compact;
  return {
    schema: compact.schema,
    status: compact.status,
    contract_count: compact.contracts.length,
    contract_lines: compact.contracts.map((contract) => [
      contract.location_contract_id,
      contract.semantic_ref_id ? `semantic=${contract.semantic_ref_id}` : null,
      `description=${readableCardValue(contract.description, 120)}`,
      `scenes=${readableScopeSummary(contract.scene_ids ?? [])}`,
      `beats=${contract.beat_count ?? 0}`,
      contract.local_location_labels?.length
        ? `sublocations=${readableCardValue(readableCardList(contract.local_location_labels), 140)}`
        : null,
    ].filter(Boolean).join(" | ")),
  };
}

function buildPrompt(semanticPlan, { chunkLabel = null, guidance = {}, inventoryLedger = null, locationContractLedger = null, compactOversized = true } = {}) {
  const contentProfile = guidance.contentProfile ?? activeContentProfile;
  const plannerDirective = contentProfilePlannerDirective(contentProfile);
  const compact = {
    source_script_hash: semanticPlan.source_script_hash,
    episode_summary: semanticPlan.episode_summary ?? "",
    global_reference_requirements: semanticPlan.global_reference_requirements ?? [],
    scene_count: semanticPlan.scenes?.length ?? 0,
    scenes: (semanticPlan.scenes ?? []).map(compactScene),
  };
  const guidancePayload = visualGuidanceBlock(guidance, compact);
  const evidencePayload = compactPromptJsonForTests(compactSceneReferenceEvidenceForTests(
    inventoryLedger,
    (semanticPlan.scenes ?? []).map((scene) => scene.scene_id),
    { maxAssets: 36, sceneIdLimit: 4 },
  ));
  const locationPayload = compactPromptJsonForTests({
    contracts: (locationContractLedger?.contracts ?? []).filter((contract) =>
      (contract.scene_ids ?? []).some((sceneId) => (semanticPlan.scenes ?? []).some((scene) => scene.scene_id === sceneId))
    ),
  });
  const semanticPayload = compactPromptJsonForTests(compact);
  let prompt = `Propose canonical visual-reference candidates from this evidence-backed story chunk.
${chunkLabel ? `\nThis is ${chunkLabel}. Propose only assets with plausible episode-level continuity value. A later global director call makes every final generation decision.\n` : ""}

CONTENT PROFILE: ${contentProfile.id}
${plannerDirective || "- Preserve recurring visual identity and physical continuity from the locked narration."}

Rules:
- This chunk stage supplies evidence-backed candidates to the global reference director. It does not decide the final reference budget and it does not write final scene-image prompts.
- Use REFERENCE EVIDENCE LEDGER as observations, not direct authoring orders. Semantic scenes provide broad context and location contracts; visual beats provide local transcript evidence. You remain the sole creative selector. Recurrence thresholds are continuity goals and deterministic validation reports misses as advisory review findings; they never override or prune your final selection.
- Reuse stable evidence asset ids. Canonicalize aliases and state variants under canonical_subject_id and base_asset_id instead of inventing duplicate identities.
- Return only candidates that might deserve a clean attachable reference. Omit text-only one-scene nouns entirely; location scope remains available separately through LOCATION CONTRACT LEDGER.
- Every candidate must list evidence_asset_ids, planned_beat_ids, estimated_use_count, reference_value_reason, and why_text_is_insufficient.
- Propose every plausible continuity-leverage candidate supported by this chunk, while omitting ordinary one-off nouns. This is a candidate pass, so do not artificially minimize it; the global director makes the final right-sized selection.
- Identify recurring identity-bearing actors, visible states, major locations, important props, UI motifs, and high-risk repeated action states. Identity-bearing actors include people, named or distinct creatures, bosses, guardians, constructs, summons, and recurring creature systems.
- A nonhuman actor that moves, attacks, reacts, is fought, or is physically contacted is not a prop. Propose it as kind character_state. Use conditioning_asset_role creature_identity for one distinct creature/construct identity and faction_language only for a true recurring creature group or shared species/faction design.
- A distinct nonhuman actor should receive a clean standalone identity reference when it recurs across two or more beats, is the decisive threat/contact target in an action sequence, or has signature anatomy that text-only scene prompting is likely to reinterpret. Its scene_prompt_anchor must repeat one concise positive anatomy contract across every covered beat, including exact silhouette, material, head/face construction, limb/body construction, and whether a signature object-like feature is integrated into the body, worn, held, or separate in the environment.
- Resolve role/title aliases to canonical named characters when the script or semantic scenes establish that relationship. If a named person is also the dean, boss, chairman, judge, professor, host, rival, spouse, parent, or another title, do not create a separate generic character ref for later role-only mentions. Expand the existing named character's state/scope instead.
- For real named public figures whose likeness matters, request a face-only source identity anchor before the episode character-state ref is generated. Do not rely on text-only "inspired by" likeness prompts for production. The source anchor supplies facial likeness only; the character-state ref supplies wardrobe, pose, body state, and ${contentProfile.content_family} styling.
- Use each scene's visual_beats when present. A named character that appears in a beat excerpt through replay footage, livestream panels, phone screens, broadcast feeds, camera files, dossiers, avatars, or video walls still needs current-scene reference coverage if their likeness may be visible in that cut.
- Treat each beat's active_state_constraints and depiction_mode as binding evidence. Select refs for materially recurring visible states; do not collapse incompatible wardrobe/injury states and do not create refs for transient text-only state changes.
- When visual_beats carry ref_needs or beat_ref_requirements, treat those as advisory local transcript-timed evidence, not locked reference targets. Semantic scene ref_requirements remain broad scene coverage. The LLM decides the final episode-level reference strategy and may merge, downgrade, upgrade, rename, or replace beat suggestions when the story context supports it.
- Do not preserve beat-authored generation_mode mechanically. Use it as a hint only. Final generation_mode belongs to this reference-planning stage after considering recurrence, story criticality, identity risk, opening-retention value, and whether an already accepted, clean, review-bound source asset exists.
- Distinguish named characters from groups, factions, crowds, and uniforms. A recurring named person gets a character_state/base identity ref when needed. A visible group such as guild masters, guards, families, students, witnesses, or crowds should not become a character identity ref unless a specific named member recurs. If the group has a recognizable uniform, faction styling, badge, armor set, or wardrobe system with real continuity value, propose one clean attachable uniform/faction design plate; otherwise omit it and let scene prompts describe the group.
- If a character state ref is visually reused as replay/screen evidence in a later scene, include that later scene_id in the ref scope and explain the screen-visible or replay-footage usage in risk_notes.
- Candidate generation_mode is limited to standalone_ref, manual_review, or source_only. Do not derive references from ordinary story cuts. source_only is valid only when the exact clean asset already exists and the target carries reference_image_path, source_origin, source_review_status=approved_clean, source_review_receipt_path, source_image_id, and source_image_sha256. source_origin is owned_source or accepted_production_cut. An accepted production cut additionally carries source_cut_id, passed source_image_qa_status, and source_image_qa_receipt_path, and may be source_only only for location, prop, or UI refs. Human source refs must be operator-owned face-only sources, never production story cuts.
- Use generic production logic. Do not hardcode story-specific rules.
- Write normal descriptive prompt anchors that preserve story-faithful UI labels, status phrases, and concise absence states when they are the point of the reference.
- Do not create separate provider-exclusion payload fields such as negative_prompt, avoid_list, or exclude_list. Keep provider-facing content in the normal prompt anchor.
- Convert risks into concrete construction when helpful: exact visible subject count, role, pose, action direction, wardrobe construction, frame composition, and location details.
- Keep narrative state separate from visible state. Semantic emotional_state, financial_state, social_state, or loose state phrases such as broke, ruined, betrayed, humiliated, indebted, rejected, or emotionally collapsed are story context, not automatic costume/body damage. Use them to choose props, posture, expression, staging, witnesses, UI, receipts, screens, isolation, or power dynamics. Only put dirt, ragged clothing, torn fabric, wounds, illness, homelessness, dumpster-like styling, or severe physical decay into a character prompt_anchor/scene_prompt_anchor when the locked script or semantic visible_state explicitly says that physical detail is visible.
- Prompt anchors must be concrete and specific enough for image generation, but they are draft anchors requiring manual review before reference generation.
- Every prompt_anchor must begin with the matching content-profile reference instruction and depict exactly one reusable conditioning concept.
- Reference kind taxonomy is strict:
  - style refs follow: ${contentProfileReferenceInstruction(contentProfile, "style")}.
  - character_state refs define one identity/state: human face/body/wardrobe, one distinct creature/construct anatomy, or one coherent faction/species language. They are identity/anatomy evidence, not reusable pose instructions.
  - location refs define environment, architecture, materials, lighting, and scale; use open environment-only staging with enough clean space for later scene characters.
  - prop refs define object shape, surface, markings, and scale.
  - ui refs define interface design, typography, color, layout, and exact display motif.
  - action refs define effect shape, energy color, movement path, interaction pattern, and spatial logic; keep them as effect/action studies rather than complete story scenes.
- Every selected conditioning asset contains exactly one conditioning concept: one identity/state, one environment, one prop, one UI motif, one faction/uniform language, one action/effect language, or one abstract style language. Set conditioning_subject_count to 1 and conditioning_asset_role accordingly. Never combine a character, populated story scene, prop lineup, and UI panel into one reference.
- Every non-source character_state target must carry the structured cleanliness fields reference_pose, visible_subject_count, expected_visible_hands, hands_policy, detachable_props, and integrated_anatomy_features. Human identity refs use reference_pose=neutral_single, visible_subject_count=1, exact expected_visible_hands for the authored anatomy (normally 2; use the evidence-backed present count after amputation or other permanent anatomy), hands_policy=relaxed_empty, and detachable_props=[]. Creature refs use reference_pose=neutral_single, visible_subject_count=1, exact expected_visible_hands for grasping/hand-like appendages, hands_policy=empty_or_unoccupied, detachable_props=[], explicitly keep every such appendage empty/unoccupied, and list integrated body structures in integrated_anatomy_features. Faction refs use reference_pose=neutral_separated_lineup, visible_subject_count from 3 through 5, expected_visible_hands=null, hands_policy=relaxed_empty, and detachable_props=[]. Weapons, handheld props, action poses, and interaction staging belong to separate prop/action targets and final scene prompts.
- Action/effect reference anchors should use neutral or abstract staging unless a specific location is inseparable from the effect.
- Human character reference anchors should be 16:9 landscape, single-person, single-pose, plain-background identity reference cards with the full body or three-quarter body centered inside the canvas; preserve the exact authored limb count, keep every anatomically present visible hand relaxed and empty, and omit every detachable weapon and carried prop. Final scene poses, held objects, and locations come from the visual prompt stage.
- Creature/construct reference anchors should be 16:9 landscape, exactly one nonhuman actor in one neutral pose on a plain background, with one coherent full silhouette, every grasping or hand-like appendage visibly empty/unoccupied, and explicit anatomy/material construction. An object-like anatomical feature must be described as one integrated body structure at its exact attachment point, not as a second prop or alternate head. Do not ask for multiple angles, turnaround sheets, pose grids, scene backgrounds, or cinematic action.
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
- Minor role characters, generic witnesses/crowds, single-use wardrobe variants, one-off documents, one-off dashboards, and one-off props may be omitted when they do not meet a high-risk exception. Repeated character/location/prop/UI evidence is a strong continuity signal, not a deterministic quota.
- Recurring character_state assets that reach two beats or two scenes should usually use standalone_ref or an approved-clean full conditioning source_only asset. A face-only source remains an identity dependency rather than a full state plate. Departures are advisory review findings.
- A selected recurring character identity visibly depicted in the first 30 seconds should usually be standalone_ref with required_before_imagegen true. Other choices remain visible advisory decisions rather than automatic blockers.
- Any named human character who physically touches, fights, restrains, shoves, carries, rescues, grabs, strikes, escorts, wrestles, or otherwise has real body-contact interaction with a recurring protagonist should use standalone_ref before imagegen, even if they appear in only one scene. Contact scenes are high identity-blend risk.
- Being merely beside, watching, confronting verbally, appearing on a screen, or sharing a two-character frame is not by itself enough for a one-scene standalone ref; omit it unless distinct identity continuity is mission-critical.
- Recurring locations that reach three beats or two scenes must use clean environment-only standalone plates or an approved-clean source_only asset. Do not upgrade every one-scene opening sublocation merely because it is early, and do not derive location refs from populated story cuts without an explicit accepted-production-cut source review.
- Do not merge visually distinct sublocations into one broad location ref just because they share a building, campus, city, company, palace, arena, or venue name. If consecutive scenes or a long story span moves between different visible areas, create separate scene-scoped location refs for those areas, such as entrance, hallway, main room, screen wall, table area, plaza, roof, basement, server room, witness stand, audience floor, or exterior approach. Use the semantic scene location/ref_requirements as the source of scope; code will validate scene_ids and will not invent replacement locations later.
- Semantic location ref_requirements are represented in LOCATION CONTRACT LEDGER and do not alone force matching image targets. Recurring evidence still does: propose a location image ref whenever the location reaches three beats or two scenes, and list every covered location_contract_id.
- Long same-venue arcs need enough scoped location refs for editorial variety. A single location ref should not be expected to carry many minutes of visually distinct beats after the retention runway when the semantic scene locations name different physical areas.
- Rank recurring locations by continuity_value_score, which includes beat reuse, scene reuse, opening value, and reuse span. A location used across six or more cuts can be a key standalone anchor even when all of those cuts live under one broad semantic scene. Do not let several one-off props displace a high-value recurring environment.
- Return only valid JSON.

VISUAL BIBLES AND OPERATOR DIRECTION:
${guidancePayload}

REFERENCE EVIDENCE LEDGER (scene-local; the global director receives the episode catalog later):
${evidencePayload}

LOCATION CONTRACT LEDGER:
${locationPayload}

SEMANTIC PLAN:
${semanticPayload}

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
      "clean_plate_contract": "single clean subject, environment, object, UI, or effect plate without unrelated story-scene contamination",
      "conditioning_subject_count": 1,
      "conditioning_asset_role": "identity_state|creature_identity|environment|prop|ui_motif|faction_language|action_effect|style_language",
      "reference_pose": "neutral_single|neutral_separated_lineup|not_applicable",
      "visible_subject_count": 1,
      "expected_visible_hands": 2,
      "hands_policy": "relaxed_empty|empty_or_unoccupied|not_applicable",
      "detachable_props": [],
      "integrated_anatomy_features": [],
      "identity_usage": "full_identity|face_only",
      "reference_cleanliness_contract_version": "empty_hands_no_detachable_props_v1",
      "source_origin": "owned_source|accepted_production_cut|null",
      "source_review_status": "approved_clean|needs_manual_review|null",
      "source_review_receipt_path": null,
      "source_image_id": null,
      "source_image_sha256": null,
      "source_image_qa_status": "passed|null",
      "source_image_qa_receipt_path": null,
      "source_cut_id": null
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
      ,"identity_subtype": "human|creature|construct|creature_group"
    }
  ],
  "warnings": []
	}`;
  if (compactOversized && Buffer.byteLength(prompt, "utf8") > VISUAL_REFERENCE_CHUNK_SAFE_MAX_BYTES) {
    // Leave compatible historical packets byte-identical. Oversized packets get
    // reversible formatting only; splitting and the hard byte guard still apply.
    for (const [heading, payload] of [
      ["VISUAL BIBLES AND OPERATOR DIRECTION:", guidancePayload],
      ["REFERENCE EVIDENCE LEDGER (scene-local; the global director receives the episode catalog later):", evidencePayload],
      ["LOCATION CONTRACT LEDGER:", locationPayload],
      ["SEMANTIC PLAN:", semanticPayload],
    ]) {
      prompt = prompt.replace(`${heading}\n${payload}`, `${heading}\n${JSON.stringify(compactReferencePromptValue(JSON.parse(payload)))}`);
    }
    const returnMarker = "\nReturn:\n";
    const returnStart = prompt.lastIndexOf(returnMarker) + returnMarker.length;
    prompt = prompt.slice(0, returnStart) + JSON.stringify(JSON.parse(prompt.slice(returnStart)));
    prompt = prompt.replace("VISUAL BIBLES AND OPERATOR DIRECTION:", `${REFERENCE_PROMPT_TABLE_INSTRUCTION}\n\nVISUAL BIBLES AND OPERATOR DIRECTION:`);
  }
  return prompt;
}

export function buildReferenceChunkPromptForTests(semanticPlan, options = {}) {
  return buildPrompt(semanticPlan, options);
}

export function compactPromptJsonForTests(value) {
  return JSON.stringify(value);
}

export function compactPromptTableForTests(rows, fields) {
  const constants = {};
  const variableFields = fields.filter((field) => {
    if (!rows.length) return true;
    const first = JSON.stringify(rows[0]?.[field] ?? null);
    const constant = rows.every((row) => JSON.stringify(row?.[field] ?? null) === first);
    if (constant) constants[field] = rows[0]?.[field] ?? null;
    return !constant;
  });
  return {
    fields: variableFields,
    constants,
    rows: rows.map((row) => variableFields.map((field) => row[field] ?? null)),
  };
}

export function compactPromptDictionaryTableForTests(rows, fields) {
  const constants = {};
  const dictionaries = {};
  const dictionaryIndexes = {};
  const variableFields = fields.filter((field) => {
    if (!rows.length) return true;
    const values = [];
    const indexes = new Map();
    for (const row of rows) {
      const value = row?.[field] ?? null;
      const key = JSON.stringify(value);
      if (indexes.has(key)) continue;
      indexes.set(key, values.length);
      values.push(value);
    }
    if (values.length === 1) {
      constants[field] = values[0];
      return false;
    }
    dictionaries[field] = values;
    dictionaryIndexes[field] = indexes;
    return true;
  });
  return {
    fields: variableFields,
    constants,
    dictionaries,
    rows: rows.map((row) => variableFields.map((field) => {
      const key = JSON.stringify(row?.[field] ?? null);
      return dictionaryIndexes[field].get(key);
    })),
  };
}

export function expandPromptDictionaryTableForTests(table) {
  const fields = Array.isArray(table?.fields) ? table.fields : [];
  const constants = table?.constants && typeof table.constants === "object" ? table.constants : {};
  const dictionaries = table?.dictionaries && typeof table.dictionaries === "object" ? table.dictionaries : {};
  return (Array.isArray(table?.rows) ? table.rows : []).map((encodedRow) => ({
    ...constants,
    ...Object.fromEntries(fields.map((field, index) => {
      const dictionary = Array.isArray(dictionaries[field]) ? dictionaries[field] : [];
      return [field, dictionary[encodedRow?.[index]]];
    })),
  }));
}

function stableStringList(values = []) {
  const seen = new Set();
  const output = [];
  for (const value of values.flat(Infinity)) {
    const normalized = String(value ?? "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function compactCandidateBeatScope(beatIds = []) {
  const ids = stableStringList(beatIds);
  return {
    count: ids.length,
    first: ids[0] ?? null,
    last: ids.at(-1) ?? null,
    sample: ids.length <= 8 ? ids : [...ids.slice(0, 4), ...ids.slice(-4)],
  };
}

function referenceCandidateCardKey(target) {
  const familyId = String(
    target?.inventory_asset_id
      ?? target?.canonical_subject_id
      ?? target?.base_asset_id
      ?? target?.ref_id
      ?? target?.candidate_id
      ?? "unknown_reference_family",
  ).trim();
  return `${normalizeKind(target?.kind)}|${familyId}`;
}

function readableCardValue(value, maxLength = 180) {
  const normalized = String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "/")
    .trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function readableCardList(values = []) {
  return stableStringList(values).join(",");
}

function distinctivePromptAnchorForCard(value) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const clauses = normalized.split(/;\s*/);
  while (
    clauses.length > 1
    && /(?:16:9|landscape|anime|manhwa|clean linework|cel-shaded|webtoon lighting|one coherent frame)/i.test(clauses[0])
  ) {
    clauses.shift();
  }
  return clauses.join("; ");
}

function readableScopeSummary(values = []) {
  const ids = stableStringList(values);
  if (!ids.length) return "none";
  if (ids.length <= 12) return ids.join(",");
  return `${ids.length}:${ids.slice(0, 4).join(",")}...${ids.slice(-4).join(",")}`;
}

function stableGroups(rows, keyForRow) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyForRow(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function readableTargetCandidateLine(targets) {
  const primary = targets[0];
  const beats = compactCandidateBeatScope(targets.flatMap((target) => target.planned_beat_ids ?? []));
  const visibleStates = stableStringList(targets.map((target) => target.state_delta)).slice(0, 3);
  const anchors = stableStringList(
    targets.map((target) => distinctivePromptAnchorForCard(target.prompt_anchor)),
  ).slice(0, 2);
  const parts = [
    readableCardList(targets.map((target) => target.candidate_id)),
    `ref=${readableCardValue(primary.ref_id, 60)}`,
    `scenes=${readableScopeSummary(targets.flatMap((target) => target.scene_ids ?? []))}`,
    `beats=${beats.count}${beats.count ? `:${beats.first}->${beats.last}` : ""}`,
    `uses=${Math.max(...targets.map((target) => targetNumber(target.estimated_use_count ?? target.appearance_count)))}`,
    `priority=${readableCardValue(readableCardList(targets.map((target) => target.priority)), 40) || "unspecified"}`,
    `mode=${readableCardValue(readableCardList(targets.map((target) => target.generation_mode)), 50) || "unspecified"}`,
    `required=${targets.some((target) => target.required_before_imagegen) ? 1 : 0}`,
  ];
  if (visibleStates.length) parts.push(`states=${readableCardValue(visibleStates.join(" / "), 90)}`);
  const bases = stableStringList(targets.map((target) => target.base_asset_id));
  if (bases.length) parts.push(`bases=${readableCardValue(bases.join(","), 70)}`);
  if (!visibleStates.length && anchors.length) {
    parts.push(`construction=${readableCardValue(anchors.join(" / "), 80)}`);
  }
  return parts.join(" | ");
}

function readableCharacterStateCandidateLine(states, targetByCandidateId) {
  const primary = states[0];
  const sourceTargets = states.map((state) => targetByCandidateId.get(state.source_target_candidate_id)).filter(Boolean);
  const identityUsages = stableStringList(states.map((state) => (
    state.identity_usage_override ?? targetByCandidateId.get(state.source_target_candidate_id)?.identity_usage
  )));
  const parts = [
    readableCardList(states.map((state) => state.candidate_id)),
    `state_ref=${readableCardValue(primary.state_ref_id, 60)}`,
    `source_targets=${readableCardValue(readableCardList(states.map((state) => state.source_target_candidate_id)), 120) || "unlinked"}`,
  ];
  const bases = stableStringList(states.map((state) => state.base_identity_ref_id));
  if (bases.length) parts.push(`bases=${readableCardValue(bases.join(","), 80)}`);
  if (identityUsages.length) parts.push(`usage=${readableCardValue(identityUsages.join(","), 50)}`);
  const overrideScenes = states.flatMap((state) => state.scene_ids_override ?? []);
  if (overrideScenes.length) parts.push(`scene_overrides=${readableScopeSummary(overrideScenes)}`);
  if (!overrideScenes.length && sourceTargets.length) parts.push("scenes=inherit_source_targets");
  return parts.join(" | ");
}

export function buildReferenceDirectorCandidateCardsForTests(normalizedChunkPlans = []) {
  const targets = normalizedChunkPlans.flatMap((plan) => plan?.referenceTargets ?? []);
  const stateCandidates = normalizedChunkPlans.flatMap((plan) => plan?.characterStateRefs ?? []);
  const targetByCandidateId = new Map();
  const targetCandidateIds = new Set();
  for (const target of targets) {
    const candidateId = String(target?.candidate_id ?? "").trim();
    if (!candidateId) throw new Error("reference candidate card input contains a target without candidate_id");
    if (targetCandidateIds.has(candidateId)) throw new Error(`duplicate reference candidate_id ${candidateId}`);
    targetCandidateIds.add(candidateId);
    targetByCandidateId.set(candidateId, target);
  }

  const statesByTargetCandidateId = new Map();
  const unlinkedStates = [];
  const stateCandidateIds = new Set();
  for (const state of stateCandidates) {
    const candidateId = String(state?.candidate_id ?? "").trim();
    if (!candidateId) throw new Error("reference candidate card input contains a character state without candidate_id");
    if (stateCandidateIds.has(candidateId)) throw new Error(`duplicate character-state candidate_id ${candidateId}`);
    stateCandidateIds.add(candidateId);
    const sourceTargetCandidateId = String(state?.source_target_candidate_id ?? "").trim();
    if (!sourceTargetCandidateId || !targetByCandidateId.has(sourceTargetCandidateId)) {
      unlinkedStates.push(readableCharacterStateCandidateLine([state], targetByCandidateId));
      continue;
    }
    const rows = statesByTargetCandidateId.get(sourceTargetCandidateId) ?? [];
    rows.push(state);
    statesByTargetCandidateId.set(sourceTargetCandidateId, rows);
  }

  const cardsByKey = new Map();
  for (const target of targets) {
    const key = referenceCandidateCardKey(target);
    let card = cardsByKey.get(key);
    if (!card) {
      card = {
        card_id: `card_${String(cardsByKey.size + 1).padStart(3, "0")}`,
        family_id: key.slice(key.indexOf("|") + 1),
        kind: normalizeKind(target.kind),
        candidate_options: [],
      };
      cardsByKey.set(key, card);
    }
    card.candidate_options.push(target);
  }

  const cards = [...cardsByKey.values()].map((card) => {
    const options = card.candidate_options;
    return {
      card_id: card.card_id,
      family_id: card.family_id,
      kind: card.kind,
      target_proposal_count: options.length,
      character_state_proposal_count: options.reduce(
        (count, option) => count + (statesByTargetCandidateId.get(option.candidate_id)?.length ?? 0),
        0,
      ),
      subjects: readableCardValue(readableCardList(options.map((option) => option.subject)), 100),
      roles: readableCardList(options.map((option) => option.conditioning_asset_role)),
      union_scene_scope: readableScopeSummary(options.flatMap((option) => option.scene_ids ?? [])),
      union_beat_scope: (() => {
        const scope = compactCandidateBeatScope(
          options.flatMap((option) => targetByCandidateId.get(option.candidate_id)?.planned_beat_ids ?? []),
        );
        return `${scope.count}${scope.count ? `:${scope.first}->${scope.last}` : ""}`;
      })(),
      target_candidate_lines: stableGroups(options, (option) => String(option.ref_id ?? option.candidate_id))
        .map(readableTargetCandidateLine),
      character_state_candidate_lines: stableGroups(
        options.flatMap((option) => statesByTargetCandidateId.get(option.candidate_id) ?? []),
        (state) => String(state.state_ref_id ?? state.candidate_id),
      ).map((states) => readableCharacterStateCandidateLine(states, targetByCandidateId)),
    };
  });

  return {
    schema: "goldflow_reference_director_candidate_cards_v1",
    reference_target_proposal_count: targets.length,
    character_state_proposal_count: stateCandidates.length,
    card_count: cards.length,
    rules: {
      card_meaning: "Each card groups duplicate or state-related proposals for one reusable family and one strict reference kind.",
      candidate_traceability: "Every target and character-state proposal appears once in a labeled human-readable line by stable candidate_id; complete local objects remain authoritative.",
      director_choice: "Select, merge, rename, or omit candidate IDs. Cards organize evidence but make no creative selection.",
    },
    cards,
    unlinked_character_state_candidates: unlinkedStates,
  };
}

function readablePromptLineTable(lines, firstField, fieldOrder) {
  const rows = lines.map((line) => {
    const parts = String(line).split(" | ");
    const row = { [firstField]: parts.shift() };
    for (const part of parts) {
      const separator = part.indexOf("=");
      const field = part.slice(0, separator);
      if (separator < 1 || !fieldOrder.includes(field) || Object.hasOwn(row, field)) {
        throw new Error(`Cannot losslessly table reference-director line field ${field}`);
      }
      row[field] = part.slice(separator + 1);
    }
    const reconstructed = fieldOrder.filter((field) => Object.hasOwn(row, field))
      .map((field) => field === firstField ? row[field] : `${field}=${row[field]}`).join(" | ");
    if (reconstructed !== line) throw new Error("Cannot losslessly table reference-director line order");
    return row;
  });
  const allFields = fieldOrder.filter((field) => rows.some((row) => Object.hasOwn(row, field)));
  return { all_fields: allFields, ...compactPromptTableForTests(rows, allFields) };
}

// A size-only fallback: values remain readable strings, never numeric dictionary
// codes. Full local candidate catalogs and the director's selection are untouched.
export function compactReferenceDirectorMergePayloadsForTests(candidateCards, evidenceLedger) {
  const targetLines = candidateCards.cards.flatMap((card) => card.target_candidate_lines);
  const stateLines = [
    ...candidateCards.cards.flatMap((card) => card.character_state_candidate_lines),
    ...candidateCards.unlinked_character_state_candidates,
  ];
  const targetTable = readablePromptLineTable(targetLines, "candidate_ids", [
    "candidate_ids", "ref", "scenes", "beats", "uses", "priority", "mode", "required", "states", "bases", "construction",
  ]);
  const stateTable = readablePromptLineTable(stateLines, "candidate_ids", [
    "candidate_ids", "state_ref", "source_targets", "bases", "usage", "scene_overrides", "scenes",
  ]);
  const { rows: targetRows, ...targetFormat } = targetTable;
  const { rows: stateRows, ...stateFormat } = stateTable;
  let targetOffset = 0;
  let stateOffset = 0;
  const cards = candidateCards.cards.map((card) => {
    const targetCount = card.target_candidate_lines.length;
    const stateCount = card.character_state_candidate_lines.length;
    const row = {
      ...card,
      target_candidate_lines: targetRows.slice(targetOffset, targetOffset + targetCount),
      character_state_candidate_lines: stateRows.slice(stateOffset, stateOffset + stateCount),
    };
    targetOffset += targetCount;
    stateOffset += stateCount;
    return row;
  });
  return {
    candidateCards: {
      ...candidateCards,
      schema: "goldflow_reference_director_candidate_card_tables_v2",
      source_schema: candidateCards.schema,
      target_candidate_line_format: targetFormat,
      character_state_candidate_line_format: stateFormat,
      cards: compactPromptTableForTests(cards, cards.length ? Object.keys(cards[0]) : []),
      unlinked_character_state_candidates: stateRows.slice(stateOffset),
    },
    evidenceLedger: {
      ...evidenceLedger,
      schema: "goldflow_reference_director_evidence_rows_v1",
      source_schema: evidenceLedger.schema,
      asset_lines: readablePromptLineTable(evidenceLedger.asset_lines, "asset_id", [
        "asset_id", "kind", "subject", "entity", "scenes", "beats", "span_sec", "canonical",
      ]),
    },
  };
}

function buildMergePrompt(semanticPlan, chunkPlans, guidance = {}, inventoryLedger = null, locationContractLedger = null) {
  const contentProfile = guidance.contentProfile ?? activeContentProfile;
  const plannerDirective = contentProfilePlannerDirective(contentProfile);
  const compact = {
    source_script_hash: semanticPlan.source_script_hash,
    episode_summary: semanticPlan.episode_summary ?? "",
    global_reference_requirements: semanticPlan.global_reference_requirements ?? [],
    scene_count: semanticPlan.scenes?.length ?? 0,
    scene_ids: (semanticPlan.scenes ?? []).map((scene) => scene.scene_id),
  };
  let referenceTargetOrdinal = 0;
  let characterStateRefOrdinal = 0;
  const referenceTargetCatalog = new Map();
  const characterStateRefCatalog = new Map();
  const normalizedChunkPlans = chunkPlans.map((plan, index) => {
    const referenceTargets = (plan.reference_targets ?? []).map((target) => {
      const candidateId = `rt_${String(referenceTargetOrdinal + 1).padStart(4, "0")}`;
      referenceTargetOrdinal += 1;
      referenceTargetCatalog.set(candidateId, target);
      return {
      candidate_id: candidateId,
      ref_id: target.ref_id,
      kind: target.kind,
      subject: target.subject,
      scene_ids: target.scene_ids ?? [],
      priority: target.priority,
      generation_mode: target.generation_mode,
      required_before_imagegen: target.required_before_imagegen,
      prompt_anchor: String(target.prompt_anchor ?? "").slice(0, 500),
      anchor_cut_policy: target.anchor_cut_policy,
      appearance_count: target.appearance_count,
      risk_notes: (target.risk_notes ?? []).slice(0, 1).map((note) => String(note).slice(0, 50)),
      manual_review_required: target.manual_review_required,
      inventory_asset_id: target.inventory_asset_id ?? null,
      evidence_asset_ids: target.evidence_asset_ids ?? [],
      canonical_subject_id: target.canonical_subject_id ?? null,
      base_asset_id: target.base_asset_id ?? null,
      state_delta: target.state_delta == null ? null : String(target.state_delta).slice(0, 100),
      location_contract_ids: target.location_contract_ids ?? [],
      planned_beat_ids: target.planned_beat_ids ?? [],
      estimated_use_count: target.estimated_use_count ?? target.appearance_count ?? 0,
      reference_value_reason: target.reference_value_reason == null ? null : String(target.reference_value_reason).slice(0, 70),
      why_text_is_insufficient: target.why_text_is_insufficient == null ? null : String(target.why_text_is_insufficient).slice(0, 70),
      conditioning_asset_role: target.conditioning_asset_role ?? null,
      identity_subtype: target.identity_subtype ?? null,
      reference_pose: target.reference_pose ?? null,
      visible_subject_count: target.visible_subject_count ?? null,
      expected_visible_hands: target.expected_visible_hands ?? null,
      hands_policy: target.hands_policy ?? null,
      detachable_props: target.detachable_props ?? null,
      integrated_anatomy_features: target.integrated_anatomy_features ?? null,
      identity_usage: target.identity_usage ?? null,
      reference_cleanliness_contract_version: target.reference_cleanliness_contract_version ?? null,
      source_origin: target.source_origin ?? null,
      source_review_status: target.source_review_status ?? null,
      source_review_receipt_path: target.source_review_receipt_path ?? null,
      source_image_id: target.source_image_id ?? null,
      source_image_sha256: target.source_image_sha256 ?? null,
      source_image_qa_status: target.source_image_qa_status ?? null,
      source_image_qa_receipt_path: target.source_image_qa_receipt_path ?? null,
      source_cut_id: target.source_cut_id ?? null,
      };
    });
    const targetById = new Map(referenceTargets.map((target) => [String(target.ref_id ?? ""), target]));
    const characterStateRefs = (plan.character_state_refs ?? []).map((ref) => {
      const candidateId = `cs_${String(characterStateRefOrdinal + 1).padStart(4, "0")}`;
      characterStateRefOrdinal += 1;
      const sourceTarget = targetById.get(String(ref.source_ref_id ?? ""));
      const sourceSceneIds = sourceTarget?.scene_ids ?? [];
      const sourcePromptAnchor = String(sourceTarget?.prompt_anchor ?? "");
      const sourceIdentityUsage = sourceTarget?.identity_usage ?? null;
      const refSceneIds = ref.scene_ids ?? [];
      const refPromptAnchor = String(ref.prompt_anchor ?? "").slice(0, 140);
      const refIdentityUsage = ref.identity_usage ?? null;
      characterStateRefCatalog.set(candidateId, ref);
      return {
        candidate_id: candidateId,
        state_ref_id: ref.state_ref_id,
        character: ref.character,
        scene_prompt_anchor: String(ref.scene_prompt_anchor ?? "").slice(0, 120),
        source_ref_id: ref.source_ref_id,
        source_target_candidate_id: sourceTarget?.candidate_id ?? null,
        base_identity_ref_id: ref.base_identity_ref_id,
        identity_subtype: ref.identity_subtype ?? null,
        scene_ids_override: JSON.stringify(refSceneIds) === JSON.stringify(sourceSceneIds) ? null : refSceneIds,
        prompt_anchor_override: refPromptAnchor === sourcePromptAnchor ? null : refPromptAnchor,
        identity_usage_override: refIdentityUsage === sourceIdentityUsage ? null : refIdentityUsage,
      };
    });
    return {
      chunk: index + 1,
      referenceTargets,
      characterStateRefs,
      warnings: (plan.warnings ?? []).slice(0, 5),
    };
  });
  const warningSummaryByCode = new Map();
  for (const warning of normalizedChunkPlans.flatMap((plan) => plan.warnings)) {
    const code = String(warning?.code ?? "uncoded_chunk_warning");
    const current = warningSummaryByCode.get(code) ?? {
      code,
      count: 0,
      example: String(warning?.message ?? warning?.severity ?? "").slice(0, 160),
    };
    current.count += 1;
    warningSummaryByCode.set(code, current);
  }
  const candidateCardPayload = {
    ...buildReferenceDirectorCandidateCardsForTests(normalizedChunkPlans),
    chunk_warning_summary: [...warningSummaryByCode.values()],
  };
  const evidencePayload = compactReferenceEvidenceLedgerForDirectorCardsForTests(inventoryLedger, {
    maxAssets: Number(flags["visual-ref-merge-ledger-max-assets"] ?? 320),
  });
  let prompt = `Merge chunked visual reference strategy outputs into one coherent episode-level visual reference plan.

CONTENT PROFILE: ${contentProfile.id}
${plannerDirective || "- Preserve recurring visual identity and physical continuity from the locked narration."}

Rules:
- You are the sole episode-level reference director. Code validates your output but never restores an asset you omit, never guesses a replacement, and never caps or prunes the clean targets you select.
- Use REFERENCE EVIDENCE LEDGER and CHUNK CANDIDATES as evidence, not deterministic target authoring. Semantic scenes provide broad context, visual beats provide local transcript truth, and LOCATION CONTRACT LEDGER carries textual location scope. Recurrence thresholds are continuity goals; omissions are advisory findings for approval review, not deterministic blockers.
- The merged output should feel like a human art director chose the cast, location, prop, UI, uniform/faction, and action references that actually buy consistency.
- There is no fixed numeric reference budget. Right-size the selection to the episode's length and visual complexity. Do not optimize for the smallest possible count, and do not keep low-value refs merely to hit a quota; every selected ref must have concrete reuse or risk-reduction value.
- Treat chunk plans as proposals. Keep only references that materially improve consistency and trace each selection through evidence_asset_ids. If several chunks propose aliases or state variants of the same asset, choose one canonical_subject_id and one base_asset_id, then retain only visually material state deltas.
- Merge duplicate character/location/prop/UI/action targets across chunks.
- Resolve role/title aliases to canonical named characters when the script or semantic scenes establish that relationship. If a named person is also the dean, boss, chairman, judge, professor, host, rival, spouse, parent, or another title, do not create a separate generic character ref for later role-only mentions. Expand the existing named character's state/scope instead.
- For real named public figures whose likeness matters, preserve or request face-only source identity anchors and use those anchors as base_identity_ref_id for generated character-state refs. Do not merge these into generic role refs or text-only lookalikes.
- Preserve all relevant scene_ids from the chunk plans.
- Final generation_mode is limited to standalone_ref, manual_review, or source_only. Omit text-only one-off assets. Do not derive references from populated story cuts. source_only is valid only when an exact clean asset already exists and the target carries reference_image_path, source_origin, source_review_status=approved_clean, source_review_receipt_path, source_image_id, and source_image_sha256. source_origin is owned_source or accepted_production_cut. accepted_production_cut additionally requires source_cut_id, passed source_image_qa_status, and source_image_qa_receipt_path, and is permitted only for location, prop, or UI refs. A human source identity must be an operator-owned face-only source.
- Write normal descriptive prompt anchors that preserve story-faithful UI labels, status phrases, and concise absence states when they are the point of the reference.
- Do not create separate provider-exclusion payload fields such as negative_prompt, avoid_list, or exclude_list. Keep provider-facing content in the normal prompt anchor.
- Convert risks into concrete construction when helpful: exact visible subject count, role, pose, action direction, wardrobe construction, frame composition, and location details.
- Keep narrative state separate from visible state. Semantic emotional_state, financial_state, social_state, or loose state phrases such as broke, ruined, betrayed, humiliated, indebted, rejected, or emotionally collapsed are story context, not automatic costume/body damage. Use them to choose props, posture, expression, staging, witnesses, UI, receipts, screens, isolation, or power dynamics. Only put dirt, ragged clothing, torn fabric, wounds, illness, homelessness, dumpster-like styling, or severe physical decay into a character prompt_anchor/scene_prompt_anchor when the locked script or semantic visible_state explicitly says that physical detail is visible.
- Use each scene's visual_beats when present. A named character that appears in a beat excerpt through replay footage, livestream panels, phone screens, broadcast feeds, camera files, dossiers, avatars, or video walls still needs current-scene reference coverage if their likeness may be visible in that cut.
- Treat each beat's active_state_constraints and depiction_mode as binding evidence. Select refs for materially recurring visible states; do not collapse incompatible wardrobe/injury states and do not create refs for transient text-only state changes.
- When visual_beats carry ref_needs or beat_ref_requirements, treat those as advisory local transcript-timed evidence, not locked reference targets. Semantic scene ref_requirements remain broad scene coverage. The LLM decides the final episode-level reference strategy and may merge, downgrade, upgrade, rename, or replace beat suggestions when the story context supports it.
- Do not preserve beat-authored generation_mode mechanically. Make the final decision from recurrence, story criticality, identity risk, and opening-retention value.
- Distinguish people, distinct nonhuman actors, and true groups/factions. A recurring named person gets a character_state/base identity ref when needed. A named or distinct creature, boss, guardian, construct, or summon that moves, attacks, reacts, is fought, or is physically contacted is an identity-bearing actor, never a prop; keep it as kind character_state with conditioning_asset_role creature_identity. A recurring group or creature system may receive a clean group/faction design plate when its shared silhouette, uniform, armor, or visual system matters; never pretend it is one person's face identity.
- Preserve a clean standalone identity ref for a distinct nonhuman actor when it recurs across two or more beats, is the decisive threat/contact target in an action sequence, or has signature anatomy that text-only prompts can reinterpret. Its scene_prompt_anchor must carry one concise positive anatomy contract unchanged across its covered beats, including exact silhouette, materials, head/face construction, limb/body construction, and whether any object-like feature is integrated, worn, held, or environmental.
- If a character state ref is visually reused as replay/screen evidence in a later scene, include that later scene_id in the ref scope and explain the screen-visible or replay-footage usage in risk_notes.
- Every prompt_anchor must begin with the matching content-profile reference instruction and depict exactly one reusable conditioning concept.
- Reference kind taxonomy is strict:
  - style refs follow: ${contentProfileReferenceInstruction(contentProfile, "style")}.
  - character_state refs define one human identity/state, one distinct creature/construct anatomy, or one coherent faction/species language; they are identity/anatomy evidence, not reusable pose instructions.
  - location refs define environment, architecture, materials, lighting, and scale; use open environment-only staging with enough clean space for later scene characters.
  - prop refs define object shape, surface, markings, and scale.
  - ui refs define interface design, typography, color, layout, and exact display motif.
  - action refs define effect shape, energy color, movement path, interaction pattern, and spatial logic; keep them as effect/action studies rather than complete story scenes.
- Every selected conditioning asset contains exactly one conditioning concept: one identity/state, one environment, one prop, one UI motif, one faction/uniform language, one action/effect language, or one abstract style language. Set conditioning_subject_count to 1 and conditioning_asset_role accordingly. Never combine a character, populated story scene, prop lineup, and UI panel into one reference.
- Every non-source character_state target must carry reference_pose, visible_subject_count, expected_visible_hands, hands_policy, detachable_props, and integrated_anatomy_features. Human identity refs use neutral_single, one visible subject, the exact evidence-backed count of anatomically present hands (normally two), relaxed_empty hands, and no detachable props. Creature refs use neutral_single, one visible subject, the exact count of grasping/hand-like appendages, empty_or_unoccupied appendages, no detachable props, and integrated body structures in integrated_anatomy_features. Faction refs use neutral_separated_lineup, three through five separated subjects, expected_visible_hands=null, relaxed_empty hands, and no detachable props. Held weapons/objects and action poses belong to separate prop/action targets and final scene prompts.
- Action/effect reference anchors should use neutral or abstract staging unless a specific location is inseparable from the effect.
- Human character reference anchors should be 16:9 landscape, single-person, single-pose, plain-background identity reference cards with the full body or three-quarter body centered inside the canvas; preserve the exact authored limb count, keep every anatomically present visible hand relaxed and empty, and omit detachable weapons, bows, swords, shields, and carried props. Creature/construct anchors should show exactly one nonhuman actor in one neutral pose with one coherent silhouette, every grasping or hand-like appendage visibly empty/unoccupied, and explicit anatomy/material construction. Final scene poses, held objects, and locations come from the visual prompt stage. Do not ask for multiple angles, turnaround sheets, pose grids, scene backgrounds, or cinematic action.
- For adult female character refs, keep the character story-appropriate but conventionally attractive: beautiful face, polished hair/makeup when suitable, flattering outfit, full bust, curvy hourglass adult silhouette, graceful waist-to-hip shape, and confident posture. Keep this non-explicit and avoid nudity, lingerie, childlike features, or pinup posing.
- UI refs that represent a named person as data should use dossier identity tile, silhouette identity marker, or archival record wording so the ref stays an interface design plate instead of a character reference card.
- Style references are optional. Prefer the visual style bible and style_summary text over a generated style image. Preserve a style reference only when it is a clean abstract rendering/material/lighting sample; it must not contain character faces, character sheets, expression panels, UI screens, speech bubbles, or readable text.
- For progressive transformation arcs where the same character changes body, grooming, hair, facial hair, clothing, wealth status, injury state, power level, or age presentation, separate identity from state:
  - Create one base identity anchor for the character's face likeness and core recognizable identity.
  - Later character_state refs and scene_prompt_anchor values must dictate the current visible state explicitly: hairstyle, shave/facial hair, body shape, fitness, posture, wardrobe quality, cleanliness, social status expressed through visible styling, and emotional bearing expressed through expression/posture. Do not visualize abstract wealth loss, debt, betrayal, shame, or social ruin as grime or raggedness unless the script explicitly describes those physical signs.
  - Later states must use the base identity as a face-only continuity source; do not treat earlier overweight, injured, poor, dirty, weak, or young states as body/wardrobe references for later transformed states.
  - State anchors should describe the visible progression clearly enough that a viewer can read the arc without narration.
- Recurring character_state assets that reach two beats or two scenes should usually use standalone_ref or an approved-clean full conditioning source_only asset. A face-only source is an identity dependency rather than a full state plate; exceptions are advisory.
- A selected recurring character identity visibly depicted in the first 30 seconds should usually be standalone_ref with required_before_imagegen true; alternative choices remain explicit advisory decisions.
- Omit lower-priority entities entirely. Their facts remain available to scene prompting as text.
- Standalone references are for production leverage: recurring named characters, major character states, opening-retention location anchors, key recurring locations, signature recurring system/UI motifs, critical recurring props, and high-risk physical-contact character interactions.
- Minor role characters, generic witnesses/crowds, single-use wardrobe variants, one-off documents, one-off dashboards, and one-off props may be omitted when they do not meet a high-risk exception. Give repeated character/location/prop/UI evidence strong weight, but choose the final library yourself.
- Do not upgrade every one-scene opening sublocation solely because it is early. Standalone opening locations must be a small curated set with real multi-beat clarity value.
- Any named human character who physically touches, fights, restrains, shoves, carries, rescues, grabs, strikes, escorts, wrestles, or otherwise has real body-contact interaction with a recurring protagonist should use standalone_ref before imagegen, even if they appear in only one scene. Contact scenes are high identity-blend risk.
- Being merely beside, watching, confronting verbally, appearing on a screen, or sharing a two-character frame is not enough for a one-scene standalone ref unless distinct identity continuity is mission-critical.
- Do not merge visually distinct sublocations into one broad location ref just because they share a building, campus, city, company, palace, arena, or venue name. If chunk plans contain separate visible areas inside one larger venue, preserve or create separate scene-scoped location refs for those areas during merge, such as entrance, hallway, main room, screen wall, table area, plaza, roof, basement, server room, witness stand, audience floor, or exterior approach. Use the semantic scene location/ref_requirements as the source of scope; code will validate scene_ids and will not invent replacement locations later.
- Location contracts alone do not force matching image refs. Select clean reusable location plates for physical environments recurring in three beats or two scenes, list the location_contract_ids they cover, and leave one-scene location truth in the contract ledger.
- Long same-venue arcs need enough scoped location refs for editorial variety. A single location ref should not be expected to carry many minutes of visually distinct beats after the retention runway when the semantic scene locations name different physical areas.
- Rank recurring locations from the supplied evidence: beat reuse, scene reuse, opening value, and reuse span. A location used across many cuts can be a key standalone anchor even when those cuts live under one broad semantic scene. Do not let several one-off props displace a high-value recurring environment.
- Return only valid JSON.
- CANDIDATE CARDS are plain-language evidence, not encoded dictionaries. Every proposal appears exactly once by stable candidate_id. Cards group one reusable family and one strict reference kind, but they do not preselect the winner.
- Return an ultra-compact final selection-row manifest, not repeated full reference objects. Every retained target must name its exact candidate_ids; the first candidate is the primary authored object. Deterministic code will materialize only those selected candidate fields, the union of their exact scopes, and your explicit overrides. It will not make creative selections.
- candidate_ids may merge only proposals for the same reusable concept. Omit low-value candidates by leaving them out of the selection manifest.
- Do not reconstruct or repeat the full production reference schema, scene_ids, planned_beat_ids, evidence IDs, prompt anchors, or rationale prose. The local catalog already retains every complete authored object and unions the exact scope of candidate_ids you select.
- It is valid and expected for many input candidates to be omitted. The response should be only a few thousand tokens.

VISUAL BIBLES AND OPERATOR DIRECTION:
${visualMergeGuidanceBlock(guidance)}

REFERENCE EVIDENCE LEDGER:
${compactPromptJsonForTests(evidencePayload)}

LOCATION CONTRACT LEDGER:
${compactPromptJsonForTests(compactLocationContractLedgerForDirectorCardsForTests(locationContractLedger))}

EPISODE SUMMARY:
${JSON.stringify(compact, null, 2)}

CANDIDATE CARDS:
${compactPromptJsonForTests(candidateCardPayload)}

Return:
{
  "selection_contract": "goldflow_reference_director_selection_rows_v2",
  "reference_selection_fields": ["ref_id", "candidate_ids", "priority", "generation_mode", "required_before_imagegen_1_or_0"],
  "reference_selection_rows": [
    ["stable_snake_case_id", ["rt_0001", "rt_0042"], "required", "standalone_ref", 1]
  ],
  "character_state_selection_fields": ["state_ref_id", "candidate_ids", "source_ref_id", "identity_usage", "base_identity_ref_id_or_null"],
  "character_state_selection_rows": [
    ["stable_snake_case_id", ["cs_0001"], "matching selected reference ref_id", "full_identity", null]
  ],
  "reference_overrides": {},
  "character_state_overrides": {},
  "warnings": []
}`;
  if (Buffer.byteLength(prompt, "utf8") > VISUAL_REFERENCE_DIRECTOR_SAFE_MAX_BYTES) {
    const compacted = compactReferenceDirectorMergePayloadsForTests(candidateCardPayload, evidencePayload);
    prompt = prompt
      .replace(`REFERENCE EVIDENCE LEDGER:\n${compactPromptJsonForTests(evidencePayload)}`,
        `REFERENCE EVIDENCE LEDGER:\n${compactPromptJsonForTests(compacted.evidenceLedger)}`)
      .replace(`CANDIDATE CARDS:\n${compactPromptJsonForTests(candidateCardPayload)}`,
        `CANDIDATE CARDS:\n${compactPromptJsonForTests(compacted.candidateCards)}`)
      .replace("- CANDIDATE CARDS are plain-language evidence, not encoded dictionaries.",
        "- CANDIDATE CARDS and evidence use lossless plain-value tables: fields names each row column; constants apply to every row; null means that optional field is absent. Nested target/state rows use their named line_format. all_fields records original label order. Values are literal text and IDs, never dictionary indexes.");
  }
  return {
    prompt,
    candidateCatalog: {
      referenceTargetCatalog,
      characterStateRefCatalog,
    },
  };
}

export function buildMergePromptForTests(semanticPlan, chunkPlans, guidance = {}, inventoryLedger = null, locationContractLedger = null) {
  return buildMergePrompt(semanticPlan, chunkPlans, guidance, inventoryLedger, locationContractLedger);
}

function catalogValue(catalog, candidateId) {
  if (catalog instanceof Map) return catalog.get(candidateId);
  return catalog?.[candidateId];
}

function selectedStringArray(value, fallbackRows, field) {
  const direct = Array.isArray(value) ? value : null;
  const source = direct ?? fallbackRows.flatMap((row) => Array.isArray(row?.[field]) ? row[field] : []);
  return [...new Set(source.map((item) => String(item ?? "").trim()).filter(Boolean))];
}

function applySelectionOverride(target, selection, outputField, overrideField) {
  if (!Object.prototype.hasOwnProperty.call(selection, overrideField)) return;
  target[outputField] = selection[overrideField];
}

function targetNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function materializeReferenceDirectorSelectionForTests(parsed, candidateCatalog) {
  if (Array.isArray(parsed?.reference_targets)) return parsed;
  if (String(parsed?.selection_contract ?? "") === "goldflow_reference_director_selection_rows_v2") {
    const referenceOverrides = parsed.reference_overrides && typeof parsed.reference_overrides === "object"
      ? parsed.reference_overrides
      : {};
    const characterStateOverrides = parsed.character_state_overrides && typeof parsed.character_state_overrides === "object"
      ? parsed.character_state_overrides
      : {};
    parsed = {
      selection_contract: "goldflow_reference_director_selection_v1",
      reference_selections: (Array.isArray(parsed.reference_selection_rows) ? parsed.reference_selection_rows : []).map((row) => {
        if (!Array.isArray(row) || row.length < 5) throw new Error("global director returned a malformed reference selection row");
        const [refId, candidateIds, priority, generationMode, requiredBeforeImagegen] = row;
        const override = referenceOverrides?.[refId] ?? {};
        return {
          ref_id: refId,
          candidate_ids: candidateIds,
          priority,
          generation_mode: generationMode,
          required_before_imagegen: requiredBeforeImagegen === true || requiredBeforeImagegen === 1,
          ...override,
        };
      }),
      character_state_selections: (Array.isArray(parsed.character_state_selection_rows) ? parsed.character_state_selection_rows : []).map((row) => {
        if (!Array.isArray(row) || row.length < 5) throw new Error("global director returned a malformed character-state selection row");
        const [stateRefId, candidateIds, sourceRefId, identityUsage, baseIdentityRefId] = row;
        const override = characterStateOverrides?.[stateRefId] ?? {};
        return {
          state_ref_id: stateRefId,
          candidate_ids: candidateIds,
          source_ref_id: sourceRefId,
          identity_usage: identityUsage,
          base_identity_ref_id: baseIdentityRefId,
          ...override,
        };
      }),
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
    };
  }
  if (String(parsed?.selection_contract ?? "") !== "goldflow_reference_director_selection_v1") {
    throw new Error("global director did not return the compact reference selection contract");
  }
  const referenceSelections = Array.isArray(parsed.reference_selections) ? parsed.reference_selections : [];
  if (!referenceSelections.length) throw new Error("global director returned no reference selections");

  const referenceTargets = referenceSelections.map((selection, index) => {
    const candidateIds = selectedStringArray(selection?.candidate_ids, [], "candidate_ids");
    if (!candidateIds.length) throw new Error(`reference selection ${index + 1} has no candidate_ids`);
    const candidates = candidateIds.map((candidateId) => {
      const candidate = catalogValue(candidateCatalog?.referenceTargetCatalog, candidateId);
      if (!candidate) throw new Error(`reference selection ${index + 1} names unknown candidate ${candidateId}`);
      return candidate;
    });
    const kinds = new Set(candidates.map((candidate) => normalizeKind(candidate?.kind)));
    if (kinds.size !== 1) {
      throw new Error(`reference selection ${index + 1} merges incompatible candidate kinds: ${[...kinds].join(", ")}`);
    }
    const primary = candidates[0];
    const target = {
      ...primary,
      ref_id: String(selection.ref_id ?? primary.ref_id ?? "").trim(),
      scene_ids: selectedStringArray(selection.scene_ids, candidates, "scene_ids"),
      planned_beat_ids: selectedStringArray(selection.planned_beat_ids, candidates, "planned_beat_ids"),
      evidence_asset_ids: selectedStringArray(null, candidates, "evidence_asset_ids"),
      location_contract_ids: selectedStringArray(null, candidates, "location_contract_ids"),
      risk_notes: selectedStringArray(null, candidates, "risk_notes"),
      priority: selection.priority ?? primary.priority,
      generation_mode: selection.generation_mode ?? primary.generation_mode,
      required_before_imagegen: selection.required_before_imagegen ?? primary.required_before_imagegen,
      appearance_count: Math.max(
        targetNumber(primary.appearance_count),
        ...candidates.map((candidate) => targetNumber(candidate?.appearance_count)),
      ),
      estimated_use_count: Math.max(
        targetNumber(primary.estimated_use_count ?? primary.appearance_count),
        ...candidates.map((candidate) => targetNumber(candidate?.estimated_use_count ?? candidate?.appearance_count)),
      ),
    };
    if (!target.ref_id) throw new Error(`reference selection ${index + 1} has no ref_id`);
    applySelectionOverride(target, selection, "prompt_anchor", "prompt_anchor_override");
    applySelectionOverride(target, selection, "subject", "subject_override");
    applySelectionOverride(target, selection, "canonical_subject_id", "canonical_subject_id_override");
    applySelectionOverride(target, selection, "inventory_asset_id", "inventory_asset_id_override");
    applySelectionOverride(target, selection, "base_asset_id", "base_asset_id_override");
    applySelectionOverride(target, selection, "state_delta", "state_delta_override");
    return target;
  });

  const selectedRefIds = new Set(referenceTargets.map((target) => String(target.ref_id ?? "")));
  const characterStateSelections = Array.isArray(parsed.character_state_selections)
    ? parsed.character_state_selections
    : [];
  const characterStateRefs = characterStateSelections.map((selection, index) => {
    const candidateIds = selectedStringArray(selection?.candidate_ids, [], "candidate_ids");
    if (!candidateIds.length) throw new Error(`character-state selection ${index + 1} has no candidate_ids`);
    const candidates = candidateIds.map((candidateId) => {
      const candidate = catalogValue(candidateCatalog?.characterStateRefCatalog, candidateId);
      if (!candidate) throw new Error(`character-state selection ${index + 1} names unknown candidate ${candidateId}`);
      return candidate;
    });
    const primary = candidates[0];
    const sourceRefId = String(selection.source_ref_id ?? primary.source_ref_id ?? "").trim();
    if (!selectedRefIds.has(sourceRefId)) {
      throw new Error(`character-state selection ${index + 1} points to unselected source_ref_id ${sourceRefId || "<empty>"}`);
    }
    const stateRef = {
      ...primary,
      state_ref_id: String(selection.state_ref_id ?? primary.state_ref_id ?? "").trim(),
      source_ref_id: sourceRefId,
      scene_ids: selectedStringArray(selection.scene_ids, candidates, "scene_ids"),
      identity_usage: selection.identity_usage ?? primary.identity_usage,
    };
    if (!stateRef.state_ref_id) throw new Error(`character-state selection ${index + 1} has no state_ref_id`);
    applySelectionOverride(stateRef, selection, "prompt_anchor", "prompt_anchor_override");
    applySelectionOverride(stateRef, selection, "scene_prompt_anchor", "scene_prompt_anchor_override");
    if (Object.prototype.hasOwnProperty.call(selection, "base_identity_ref_id")) {
      stateRef.base_identity_ref_id = selection.base_identity_ref_id;
    }
    return stateRef;
  });

  return {
    reference_targets: referenceTargets,
    character_state_refs: characterStateRefs,
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
  };
}

async function callLocal(prompt, stageName, maxTokens = null) {
  // Reference planning gets one creative attempt. A malformed response is
  // preserved as failure evidence and repaired explicitly; it is never sent
  // back through an automatic same-input creative retry.
  const attempts = 1;
  let lastError = null;
  let lastContent = "";
  let lastOutputPath = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const retryPrompt = attempt === 1 ? prompt : `${prompt}\n\nReturn one complete valid JSON object only. No markdown fences, commentary, trailing commas, or partial objects.`;
    const response = await fetch(localLLMChatCompletionURL(stageName), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...localLLMAuthHeaders() },
      body: JSON.stringify({
        model: getLLMModel(stageName),
        messages: [
          {
            role: "system",
            content: `Return only valid JSON. You are a ${contentProfilePlannerRole(
              activeContentProfile,
              "reference",
              "visual reference strategy planner for longform production",
            )}. Preserve story intent and keep provider-facing content in normal prompt anchor fields.`,
          },
          { role: "user", content: retryPrompt },
        ],
        temperature: attempt === 1 ? Number(flags["llm-temperature"] ?? 0.12) : 0,
        max_tokens: Number(maxTokens ?? flags["llm-max-tokens"] ?? 14000),
      }),
      signal: AbortSignal.timeout(Number(process.env.ANIFACTORY_VISUAL_REF_PLAN_TIMEOUT_MS ?? 1_200_000)),
    });
    const raw = await response.text();
    let responsePayload = null;
    try { responsePayload = JSON.parse(raw); } catch {}
    const content = responsePayload?.choices?.[0]?.message?.content ?? raw;
    lastContent = content;
    const callDir = path.join(weekDir, "_llm_calls");
    await fs.mkdir(callDir, { recursive: true });
    lastOutputPath = path.join(callDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${stageName}-attempt-${attempt}-output.txt`);
    await fs.writeFile(lastOutputPath, content, "utf8");
    if (!response.ok) {
      const error = new Error(`local-qwen visual refs HTTP ${response.status}: ${raw.slice(0, 1000)}`);
      error.outputPath = lastOutputPath;
      throw error;
    }
    try {
      return { provider: "local-qwen", model: getLLMModel(stageName), content, parsed: extractJson(content), json_attempt: attempt, output_path: lastOutputPath };
    } catch (error) {
      lastError = error;
      console.error(`visual refs ${stageName}: invalid JSON attempt ${attempt}/${attempts}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const error = new Error(`local-qwen visual refs returned invalid JSON after ${attempts} attempt: ${lastError instanceof Error ? lastError.message : String(lastError)}; raw output: ${lastOutputPath}; content preview: ${lastContent.slice(0, 600)}`);
  error.outputPath = lastOutputPath;
  throw error;
}

async function callCodex(prompt, stageName) {
  const callDir = path.join(weekDir, "_codex_calls");
  await fs.mkdir(callDir, { recursive: true });
  const reuseCachedOutput = visualReferenceCodexCacheEnabled(flags);
  if (reuseCachedOutput) {
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
        console.error(`visual refs ${stageName}: reused compatible cached Codex output ${cachedPath}`);
        return {
          provider: `${metadata.provider ?? "codex_cli"}_cache`,
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
  let call;
  try {
    call = await runCodexCli({
      prompt,
      stageName,
      repoRoot,
      outputPath,
      model: flags.model ?? flags["llm-model"] ?? null,
      reasoningEffort: flags["reasoning-effort"] ?? null,
      timeoutMs: Number(process.env.ANIFACTORY_VISUAL_REF_PLAN_TIMEOUT_MS ?? 1_200_000),
    });
  } catch (error) {
    error.outputPath = outputPath;
    throw error;
  }
  let parsed;
  try {
    parsed = extractJson(call.content);
  } catch (error) {
    error.outputPath = outputPath;
    throw error;
  }
  return {
    provider: call.provider ?? "codex_cli",
    model: call.model,
    reasoning_effort: call.reasoning_effort,
    codex_cli_path: call.codex_cli_path,
    codex_cli_version: call.codex_cli_version,
    output_path: outputPath,
    content: call.content,
    parsed,
  };
}

function visualReferenceCodexCacheEnabled(inputFlags = {}) {
  return inputFlags["visual-ref-reuse-codex-chunks"] !== "false";
}

export function visualReferenceCodexCacheEnabledForTests(inputFlags = {}) {
  return visualReferenceCodexCacheEnabled(inputFlags);
}

function shouldSplitReferenceChunk(promptBytes, sceneCount, maxPromptBytes) {
  return Number(sceneCount) > 1 && Number(promptBytes) > Number(maxPromptBytes);
}

export function shouldSplitReferenceChunkForTests(promptBytes, sceneCount, maxPromptBytes = VISUAL_REFERENCE_CHUNK_SAFE_MAX_BYTES) {
  return shouldSplitReferenceChunk(promptBytes, sceneCount, maxPromptBytes);
}

export function assertVisualReferencePromptBytesForTests(prompt, {
  label = "visual-reference packet",
  maxBytes = VISUAL_REFERENCE_CHUNK_SAFE_MAX_BYTES,
} = {}) {
  const hardCeiling = label.includes("global")
    ? VISUAL_REFERENCE_DIRECTOR_SAFE_MAX_BYTES
    : VISUAL_REFERENCE_CHUNK_SAFE_MAX_BYTES;
  const ceiling = Math.min(
    hardCeiling,
    Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0 ? Number(maxBytes) : hardCeiling,
  );
  const promptBytes = Buffer.byteLength(String(prompt ?? ""), "utf8");
  if (promptBytes > ceiling) {
    throw new Error(`${label} is ${promptBytes} bytes, above safe ceiling ${ceiling}; split or compact it before provider submission.`);
  }
  return promptBytes;
}

export function splitVisualReferenceChunkForTests(sceneChunk) {
  if (sceneChunk.length > 1) {
    const splitAt = Math.ceil(sceneChunk.length / 2);
    return [sceneChunk.slice(0, splitAt), sceneChunk.slice(splitAt)].filter((rows) => rows.length);
  }
  const scene = sceneChunk[0];
  const beats = scene?.visual_beats ?? [];
  if (beats.length < 2) return [];
  const splitAt = Math.ceil(beats.length / 2);
  return [beats.slice(0, splitAt), beats.slice(splitAt)]
    .filter((rows) => rows.length)
    .map((visualBeats) => [{ ...scene, visual_beats: visualBeats }]);
}

function normalizedOptionalStringArray(value) {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean))];
}

function normalizeSourceOrigin(value) {
  const normalized = slug(value, "");
  if (!normalized) return null;
  if ([
    "owned_source",
    "owned_source_face",
    "owned_face_source",
    "operator_owned_face",
    "operator_owned_source_face",
    "owned_clean_asset",
    "operator_owned_clean_asset",
    "owned_reference_asset",
  ].includes(normalized)) return "owned_source";
  if (["accepted_production_cut", "approved_production_cut", "production_cut"].includes(normalized)) return "accepted_production_cut";
  return normalized;
}

function normalizeTarget(target, index) {
  const refId = slug(target.ref_id ?? `${target.kind ?? "ref"}_${index + 1}`);
  const mode = String(target.generation_mode ?? "manual_review");
  const kind = normalizeKind(target.kind);
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
    identity_subtype: target.identity_subtype ?? target.entity_kind ?? null,
    reference_pose: target.reference_pose ?? null,
    visible_subject_count: Number.isFinite(Number(target.visible_subject_count))
      ? Number(target.visible_subject_count)
      : null,
    expected_visible_hands: target.expected_visible_hands === null
      ? null
      : Number.isInteger(Number(target.expected_visible_hands)) && Number(target.expected_visible_hands) >= 0
        ? Number(target.expected_visible_hands)
        : null,
    hands_policy: target.hands_policy ?? null,
    detachable_props: normalizedOptionalStringArray(target.detachable_props),
    integrated_anatomy_features: normalizedOptionalStringArray(target.integrated_anatomy_features),
    identity_usage: target.identity_usage ?? null,
    reference_cleanliness_contract_version: target.reference_cleanliness_contract_version ?? referenceCleanlinessContractVersion,
    source_origin: normalizeSourceOrigin(target.source_origin ?? target.source_asset_origin),
    source_review_status: target.source_review_status ?? target.clean_source_review_status ?? null,
    source_review_receipt_path: target.source_review_receipt_path ?? target.source_review_path ?? null,
    source_image_id: target.source_image_id ?? target.source_asset_id ?? target.source_cut_id ?? target.production_cut_id ?? null,
    source_image_sha256: target.source_image_sha256 ?? target.source_sha256 ?? null,
    source_image_qa_status: target.source_image_qa_status ?? target.source_qa_status ?? null,
    source_image_qa_receipt_path: target.source_image_qa_receipt_path ?? target.source_qa_receipt_path ?? null,
    source_cut_id: target.source_cut_id ?? target.production_cut_id ?? null,
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
    identity_subtype: ref.identity_subtype ?? ref.entity_kind ?? null,
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
      owned: anchor?.owned ?? character.source_face_owned ?? character.source_face_operator_owned ?? false,
      source_origin: anchor?.source_origin ?? character.source_face_origin ?? null,
      source_review_status: anchor?.source_review_status ?? character.source_face_review_status ?? null,
      source_review_receipt_path: anchor?.source_review_receipt_path ?? character.source_face_review_receipt_path ?? null,
      source_image_id: anchor?.source_image_id ?? character.source_face_image_id ?? null,
      source_image_sha256: anchor?.source_image_sha256 ?? character.source_face_image_sha256 ?? null,
      source_image_qa_status: anchor?.source_image_qa_status ?? character.source_face_image_qa_status ?? null,
      source_image_qa_receipt_path: anchor?.source_image_qa_receipt_path ?? character.source_face_image_qa_receipt_path ?? null,
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

async function sourceFaceAnchorsFromCharacterBible(characterBible, scenes, characterStateRefs) {
  const seen = new Set();
  const anchors = [];
  for (const row of sourceFaceAnchorRows(characterBible)) {
    const character = String(row.character ?? row.name ?? row.subject ?? row.ref_id ?? "").trim();
    const aliases = Array.isArray(row.aliases) ? row.aliases : [];
    const refId = slug(row.ref_id ?? `${character}_real_face_source`);
    if (!refId || seen.has(refId)) continue;
    seen.add(refId);
    const sceneIds = sceneIdsForCharacter(character, aliases, scenes, characterStateRefs, row.scene_ids);
    const sourceOrigin = normalizeSourceOrigin(
      row.source_origin
        ?? row.origin
        ?? (row.owned === true || row.operator_owned === true ? "owned_source" : null),
    );
    const sourceReviewStatus = String(
      row.source_review_status
        ?? row.review_status
        ?? (row.approved === true ? "approved_clean" : "needs_manual_review"),
    ).toLowerCase();
    const sourceImagePath = row.conditioning_image_path ?? row.reference_image_path ?? row.path;
    const sourceImageSha256 = row.source_image_sha256 ?? await hashFile(sourceImagePath);
    anchors.push({
      ref_id: refId,
      kind: "character_state",
      subject: row.subject ?? `${character} real face source`,
      scene_ids: sceneIds,
      priority: row.priority ?? "required",
      generation_mode: "source_only",
      required_before_imagegen: false,
      reference_image_path: sourceImagePath,
      conditioning_image_path: sourceImagePath,
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
      evidence_asset_ids: normalizedOptionalStringArray(row.evidence_asset_ids) ?? [],
      canonical_subject_id: row.canonical_subject_id ?? slug(character, refId),
      conditioning_subject_count: 1,
      conditioning_asset_role: "identity_state",
      identity_usage: "face_only",
      reference_cleanliness_contract_version: referenceCleanlinessContractVersion,
      source_face_character: character,
      source_face_aliases: aliases,
      source_face_status: row.approved === true ? "approved" : (row.status ?? "needs_manual_review"),
      source: row.source ?? null,
      source_origin: sourceOrigin,
      source_review_status: sourceReviewStatus,
      source_review_receipt_path: row.source_review_receipt_path
        ?? row.review_receipt_path
        ?? (row.approved === true ? characterBiblePath : null),
      source_image_id: row.source_image_id ?? refId,
      source_image_sha256: sourceImageSha256,
      source_image_qa_status: row.source_image_qa_status ?? null,
      source_image_qa_receipt_path: row.source_image_qa_receipt_path ?? null,
      source_cut_id: null,
    });
  }
  return anchors;
}

async function applySourceFaceAnchors({ referenceTargets, characterStateRefs, characterBible, scenes }) {
  const anchors = await sourceFaceAnchorsFromCharacterBible(characterBible, scenes, characterStateRefs);
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
  const canonicalSubjectId = slug(target.canonical_subject_id ?? "", "");
  if (canonicalSubjectId) return canonicalSubjectId;
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

function identityMergeGroupKey(target) {
  const identityKey = identityMergeKey(target);
  if (!identityKey) return null;
  const stateDelta = String(target.state_delta ?? "").normalize("NFKC").trim();
  if (!stateDelta) return identityKey;
  return `${identityKey}::state_delta::${slug(stateDelta, "state")}`;
}

function isFaceOnlySourceDependency(target) {
  return String(target?.generation_mode ?? "").toLowerCase() === "source_only"
    && String(target?.identity_usage ?? "").toLowerCase() === "face_only";
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
  if (isFaceOnlySourceDependency(target)) return false;
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
    const key = identityMergeGroupKey(target);
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
    const allRows = (allGroups.get(key) ?? rows).filter((row) => !isFaceOnlySourceDependency(row));
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
  if (isFaceOnlySourceDependency(target)) return false;
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
    const key = identityMergeGroupKey(target);
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
    .filter((target) => (
      normalizeKind(target.kind) === "character_state"
      && generatedOrAttachableTarget(target)
      && !isFaceOnlySourceDependency(target)
    ))
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
  return contentProfileReferenceInstruction(
    activeContentProfile,
    normalized,
    contentProfileReferenceInstruction(activeContentProfile, "style", "16:9 landscape production reference image"),
  );
}

function ensureLandscapeReferenceAnchor(anchor, kind) {
  const text = String(anchor ?? "").trim();
  if (/^16:9\s+landscape\b/i.test(text)) return text;
  const prefix = landscapePrefixForKind(kind);
  return [prefix, text].filter(Boolean).join(", ");
}

function referenceRepairFlags() {
  return {
    chunkIds: parseListFlag(flags["repair-chunk-ids"] ?? flags.repairChunkIds),
    sceneIds: parseListFlag(flags["repair-scene-ids"] ?? flags.repairSceneIds),
    repairGlobal: flags["repair-global"] === "true" || flags.repairGlobal === "true",
  };
}

function pendingReferencePartial(partial) {
  return partial && ["needs_chunk_repair", "needs_global_repair", "needs_explicit_repair"].includes(String(partial.status ?? ""));
}

function normalizePartialPassedChunks(partial) {
  if (Array.isArray(partial?.passed_chunks)) return partial.passed_chunks;
  const retainedTargets = Array.isArray(partial?.retained_reference_targets) ? partial.retained_reference_targets : [];
  if (!retainedTargets.length) return [];
  return [{
    chunk_id: "legacy_preserved_chunks",
    scene_ids: [],
    input_sha256: null,
    raw_target_count: retainedTargets.length,
    output_path: null,
    candidate_plan: {
      reference_targets: retainedTargets,
      character_state_refs: Array.isArray(partial?.retained_character_state_refs) ? partial.retained_character_state_refs : [],
      warnings: [{
        code: "legacy_partial_candidates_preserved",
        severity: "info",
        message: "Candidates were recovered from a v1 visual-reference partial artifact.",
      }],
    },
  }];
}

function uniqueByChunkId(rows = []) {
  const byId = new Map();
  for (const row of rows) {
    const id = String(row?.chunk_id ?? "").trim();
    if (id) byId.set(id, row);
  }
  return [...byId.values()];
}

export function selectReferencePartialRepairScopeForTests(partial, {
  chunkIds = [],
  sceneIds = [],
  repairGlobal = false,
} = {}) {
  if (!pendingReferencePartial(partial)) throw new Error("No pending visual-reference partial artifact is available for repair.");
  const failedChunks = Array.isArray(partial.failed_chunks) ? partial.failed_chunks : [];
  const requestedChunkIds = [...new Set(chunkIds.map(String).filter(Boolean))];
  const requestedSceneIds = [...new Set(sceneIds.map(String).filter(Boolean))];
  const selected = [];
  if (repairGlobal) {
    if (requestedChunkIds.length || requestedSceneIds.length) throw new Error("Global repair cannot be combined with chunk or scene repair scope.");
    if (failedChunks.length) throw new Error("Repair the exact failed reference chunks before repairing the global director.");
    return { mode: "global", selected_chunks: [], requested_chunk_ids: [], requested_scene_ids: [] };
  }
  if (!requestedChunkIds.length && !requestedSceneIds.length) {
    throw new Error("Reference recovery requires --repair-chunk-ids, --repair-scene-ids, or --repair-global true.");
  }
  const failedById = new Map(failedChunks.map((row) => [String(row?.chunk_id ?? ""), row]));
  const failedSceneIds = new Set(failedChunks.flatMap((row) => row?.scene_ids ?? []).map(String));
  const unknownChunks = requestedChunkIds.filter((id) => !failedById.has(id));
  const unknownScenes = requestedSceneIds.filter((id) => !failedSceneIds.has(id));
  if (unknownChunks.length || unknownScenes.length) {
    throw new Error(`Reference repair scope contains non-failed IDs: ${[...unknownChunks, ...unknownScenes].join(", ")}`);
  }
  const sceneSet = new Set(requestedSceneIds);
  for (const failed of failedChunks) {
    const chunkId = String(failed?.chunk_id ?? "");
    const allSceneIds = (failed?.scene_ids ?? []).map(String).filter(Boolean);
    if (requestedChunkIds.includes(chunkId)) {
      selected.push({ ...failed, repair_scene_ids: allSceneIds, full_chunk_repair: true });
      continue;
    }
    const matched = allSceneIds.filter((sceneId) => sceneSet.has(sceneId));
    if (matched.length) selected.push({ ...failed, repair_scene_ids: matched, full_chunk_repair: matched.length === allSceneIds.length });
  }
  if (!selected.length) throw new Error("Reference repair selected no failed chunks or scenes.");
  return {
    mode: "chunks",
    selected_chunks: selected,
    requested_chunk_ids: requestedChunkIds,
    requested_scene_ids: requestedSceneIds,
  };
}

export function mergeReferencePartialRepairForTests(partial, repairResults = []) {
  const priorPassed = normalizePartialPassedChunks(partial);
  const priorFailed = Array.isArray(partial?.failed_chunks) ? partial.failed_chunks : [];
  const replacementByOriginal = new Map();
  for (const result of repairResults) {
    const originalId = String(result?.original_chunk_id ?? result?.chunk_id ?? "");
    if (!replacementByOriginal.has(originalId)) replacementByOriginal.set(originalId, []);
    replacementByOriginal.get(originalId).push(result);
  }
  const passedChunks = [...priorPassed];
  const failedChunks = [];
  for (const failed of priorFailed) {
    const originalId = String(failed?.chunk_id ?? "");
    const replacements = replacementByOriginal.get(originalId);
    if (!replacements?.length) {
      failedChunks.push(failed);
      continue;
    }
    const repairedScenes = new Set(replacements.flatMap((row) => row?.repair_scene_ids ?? row?.scene_ids ?? []).map(String));
    const remainingScenes = (failed.scene_ids ?? []).map(String).filter((sceneId) => !repairedScenes.has(sceneId));
    if (remainingScenes.length) failedChunks.push({ ...failed, scene_ids: remainingScenes });
    for (const row of replacements) {
      if (row.status === "passed" && row.passed_chunk) passedChunks.push(row.passed_chunk);
      if (row.status === "failed" && row.failed_chunk) failedChunks.push(row.failed_chunk);
    }
  }
  return {
    passed_chunks: uniqueByChunkId(passedChunks),
    failed_chunks: uniqueByChunkId(failedChunks),
  };
}

function referencePartialArtifact({
  semanticPlan,
  passedChunks,
  failedChunks,
  globalDirector = null,
  status = null,
}) {
  const resolvedStatus = status ?? (failedChunks.length ? "needs_chunk_repair" : "needs_global_repair");
  return {
    schema: "goldflow_visual_reference_partial_v2",
    status: resolvedStatus,
    episode,
    source_script_hash: semanticPlan?.source_script_hash ?? null,
    source_scene_ids: (semanticPlan?.scenes ?? []).map((scene) => String(scene.scene_id ?? "")).filter(Boolean),
    automatic_creative_retry_count: 0,
    passed_chunk_count: passedChunks.length,
    failed_chunk_count: failedChunks.length,
    passed_chunks: passedChunks,
    failed_chunks: failedChunks,
    retained_reference_targets: passedChunks.flatMap((row) => row?.candidate_plan?.reference_targets ?? []),
    retained_character_state_refs: passedChunks.flatMap((row) => row?.candidate_plan?.character_state_refs ?? []),
    global_director: globalDirector,
    recovery: failedChunks.length
      ? {
          failed_chunk_ids: failedChunks.map((row) => row.chunk_id).filter(Boolean),
          failed_scene_ids: [...new Set(failedChunks.flatMap((row) => row.scene_ids ?? []).map(String).filter(Boolean))],
          action: "Run one later explicit repair invocation naming only these failed chunk IDs or scene IDs. Passed candidates are immutable.",
        }
      : {
          failed_chunk_ids: [],
          failed_scene_ids: [],
          action: resolvedStatus === "needs_global_repair"
            ? "Run one later explicit --repair-global true invocation. Preserved chunk candidates will be reused without regeneration."
            : "No repair remains.",
        },
    updated_at: new Date().toISOString(),
  };
}

async function createReferencePlan(semanticPlan, stageName, guidance = {}, evidenceLedger = null, locationContractLedger = null) {
  const useLocalRoute = isLocalLLMRoute(stageName);
  const repair = referenceRepairFlags();
  const repairRequested = repair.repairGlobal || repair.chunkIds.length > 0 || repair.sceneIds.length > 0;
  const existingPartial = await readJson(referencePartialPath, null);
  if (pendingReferencePartial(existingPartial) && !repairRequested) {
    throw new Error(`Visual-reference partial recovery is pending. Use its exact failed chunk/scene scope instead of rerunning passed chunks: ${referencePartialPath}`);
  }
  if (repairRequested) {
    if (!pendingReferencePartial(existingPartial)) throw new Error(`Reference repair requires a pending partial artifact: ${referencePartialPath}`);
    if (existingPartial.source_script_hash && existingPartial.source_script_hash !== semanticPlan.source_script_hash) {
      throw new Error("Reference partial source_script_hash is stale; do not merge candidates from a different locked script.");
    }
  }
  const partialChunked = Array.isArray(existingPartial?.passed_chunks) && existingPartial.passed_chunks.length > 0
    || Array.isArray(existingPartial?.failed_chunks) && existingPartial.failed_chunks.length > 0;
  const directPrompt = buildPrompt(semanticPlan, { guidance, inventoryLedger: evidenceLedger, locationContractLedger });
  const directPromptBytes = Buffer.byteLength(directPrompt, "utf8");
  const useChunking = repairRequested
    ? partialChunked
    : (
      flags["visual-ref-chunking"] !== "false"
        && semanticPlan.scenes.length > Number(flags["visual-ref-single-call-max-scenes"] ?? 12)
    ) || directPromptBytes > VISUAL_REFERENCE_CHUNK_SAFE_MAX_BYTES;
  if (!useChunking) {
    const prompt = directPrompt;
    const promptBytes = Buffer.byteLength(prompt, "utf8");
    if (repairRequested && !repair.repairGlobal) {
      throw new Error("This partial contains a single global-director call; repair it with --repair-global true.");
    }
    let result;
    const globalStartedMs = Date.now();
    try {
      assertVisualReferencePromptBytesForTests(prompt, {
        label: "visual-reference global packet",
        maxBytes: VISUAL_REFERENCE_DIRECTOR_SAFE_MAX_BYTES,
      });
      result = useLocalRoute ? await callLocal(prompt, stageName) : await callCodex(prompt, stageName);
      await recordPlannerChunkCheckpoint({
        episodeDir,
        plannerStage: "visual_reference_plan",
        chunkId: "global_director",
        inputHash: sha256(prompt),
        expectedIds: (semanticPlan.scenes ?? []).map((scene) => scene.scene_id).filter(Boolean),
        status: "passed",
        attempt: 1,
        reused: Boolean(result.reused_cached_output),
        outputPath: result.output_path ?? null,
        metadata: {
          selected_target_count: result.parsed?.reference_targets?.length ?? 0,
          automatic_creative_retry_count: 0,
        },
        telemetry: {
          requested_provider: "identity_locked",
          actual_provider: result.provider ?? "unknown",
          model: result.model ?? null,
          reasoning_effort: result.reasoning_effort ?? null,
          risk_class: "high",
          item_count: semanticPlan.scenes.length,
          scene_count: semanticPlan.scenes.length,
          prompt_chars: prompt.length,
          prompt_bytes: promptBytes,
          output_chars: String(result.content ?? "").length,
          service_ms: Date.now() - globalStartedMs,
        },
      });
    } catch (error) {
      await recordPlannerChunkCheckpoint({
        episodeDir,
        plannerStage: "visual_reference_plan",
        chunkId: "global_director",
        inputHash: sha256(prompt),
        expectedIds: (semanticPlan.scenes ?? []).map((scene) => scene.scene_id).filter(Boolean),
        status: "failed",
        attempt: 1,
        outputPath: error?.outputPath ?? null,
        findings: [{
          code: "reference_global_director_single_attempt_failed",
          message: error instanceof Error ? error.message : String(error),
          recovery: "Use one later explicit --repair-global true invocation. Automatic creative retry is disabled.",
        }],
        metadata: { automatic_creative_retry_count: 0 },
        telemetry: {
          requested_provider: "identity_locked",
          actual_provider: "unknown",
          risk_class: "high",
          item_count: semanticPlan.scenes.length,
          scene_count: semanticPlan.scenes.length,
          prompt_chars: prompt.length,
          prompt_bytes: promptBytes,
          service_ms: Date.now() - globalStartedMs,
        },
      });
      await writeJson(referencePartialPath, referencePartialArtifact({
        semanticPlan,
        passedChunks: [],
        failedChunks: [],
        status: "needs_global_repair",
        globalDirector: {
          status: "failed",
          input_sha256: sha256(prompt),
          raw_output_path: error?.outputPath ?? null,
          error: error instanceof Error ? error.message : String(error),
          automatic_creative_retry_count: 0,
        },
      }));
      throw new Error(`Global visual-reference director made one failed creative submission. Exact global repair artifact: ${referencePartialPath}`);
    }
    if (repairRequested) {
      await writeJson(referencePartialPath, referencePartialArtifact({
        semanticPlan,
        passedChunks: [],
        failedChunks: [],
        status: "completed",
        globalDirector: {
          status: "passed",
          input_sha256: sha256(prompt),
          output_path: result.output_path ?? null,
          selected_target_count: result.parsed?.reference_targets?.length ?? 0,
        },
      }));
    }
    return {
      ...result,
      chunk_raw_target_count: Array.isArray(result.parsed?.reference_targets) ? result.parsed.reference_targets.length : 0,
      merged_target_count: Array.isArray(result.parsed?.reference_targets) ? result.parsed.reference_targets.length : 0,
      chunk_concurrency: 1,
    };
  }

  const repairSelection = repairRequested
    ? selectReferencePartialRepairScopeForTests(existingPartial, repair)
    : null;
  if (repairSelection?.mode === "global") {
    // All chunk candidates have already passed and are consumed below without
    // sending any chunk back to the creative provider.
  }
  const semanticSceneById = new Map((semanticPlan.scenes ?? []).map((scene) => [String(scene.scene_id ?? ""), scene]));
  const initialChunkDescriptors = repairSelection?.mode === "chunks"
    ? repairSelection.selected_chunks.map((failed) => {
        const selectedSceneIds = (failed.repair_scene_ids ?? failed.scene_ids ?? []).map(String);
        const repairBeatIds = new Set((failed.beat_ids ?? []).map(String));
        const selectedScenes = selectedSceneIds
          .map((sceneId) => semanticSceneById.get(sceneId))
          .filter(Boolean)
          .map((scene) => repairBeatIds.size
            ? {
                ...scene,
                visual_beats: (scene.visual_beats ?? []).filter((beat) => (
                  repairBeatIds.has(String(beat?.visual_beat_id ?? beat?.beat_id ?? ""))
                )),
              }
            : scene)
          .filter((scene) => !repairBeatIds.size || (scene.visual_beats ?? []).length > 0);
        if (selectedScenes.length !== selectedSceneIds.length) {
          throw new Error(`Reference partial names scene IDs missing from the current semantic plan: ${selectedSceneIds.filter((id) => !semanticSceneById.has(id)).join(", ")}`);
        }
        const suffix = failed.full_chunk_repair
          ? String(failed.chunk_id)
          : `${String(failed.chunk_id)}_repair_${sha256(selectedSceneIds.join(",")).slice(0, 8)}`;
        return {
          sceneChunk: selectedScenes,
          chunkLabel: `explicit repair for ${failed.chunk_id}`,
          stageSuffix: suffix,
          displayLabel: `explicit repair ${failed.chunk_id}`,
          originalChunkId: String(failed.chunk_id),
          repairSceneIds: selectedSceneIds,
        };
      })
    : repairSelection?.mode === "global"
      ? []
      : chunkArray(semanticPlan.scenes, Number(flags["visual-ref-chunk-scenes"] ?? 8)).map((sceneChunk, index, chunks) => ({
          sceneChunk,
          chunkLabel: `chunk ${index + 1} of ${chunks.length}`,
          stageSuffix: `chunk_${String(index + 1).padStart(2, "0")}`,
          displayLabel: `chunk ${index + 1}/${chunks.length}`,
          originalChunkId: `chunk_${String(index + 1).padStart(2, "0")}`,
          repairSceneIds: sceneChunk.map((scene) => String(scene.scene_id ?? "")).filter(Boolean),
        }));
  const sourceChunkCount = repairRequested
    ? Number(existingPartial?.source_chunk_count ?? normalizePartialPassedChunks(existingPartial).length + (existingPartial?.failed_chunks?.length ?? 0))
    : initialChunkDescriptors.length;
  const chunkConcurrency = Math.max(1, Number(flags["visual-ref-chunk-concurrency"] ?? process.env.ANIFACTORY_VISUAL_REF_CHUNK_CONCURRENCY ?? 8));
  const requestedMaxChunkPromptBytes = Number(
    flags["visual-ref-max-prompt-bytes"]
      ?? flags["visual-ref-max-prompt-chars"]
      ?? process.env.ANIFACTORY_VISUAL_REF_MAX_PROMPT_BYTES
      ?? process.env.ANIFACTORY_VISUAL_REF_MAX_PROMPT_CHARS
      ?? VISUAL_REFERENCE_CHUNK_SAFE_MAX_BYTES,
  );
  const maxChunkPromptBytes = Math.min(
    VISUAL_REFERENCE_CHUNK_SAFE_MAX_BYTES,
    Number.isFinite(requestedMaxChunkPromptBytes) && requestedMaxChunkPromptBytes > 0
      ? requestedMaxChunkPromptBytes
      : VISUAL_REFERENCE_CHUNK_SAFE_MAX_BYTES,
  );

  const planChunk = async ({
    sceneChunk,
    chunkLabel,
    stageSuffix,
    displayLabel,
    originalChunkId = stageSuffix,
    repairSceneIds = sceneChunk.map((scene) => String(scene.scene_id ?? "")).filter(Boolean),
  }) => {
    const chunkSemanticPlan = {
      ...semanticPlan,
      scenes: sceneChunk,
      scene_count: sceneChunk.length,
    };
    const prompt = buildPrompt(chunkSemanticPlan, {
      chunkLabel,
      guidance,
      inventoryLedger: evidenceLedger,
      locationContractLedger,
    });
    const promptBytes = Buffer.byteLength(prompt, "utf8");
    if (promptBytes > maxChunkPromptBytes && (sceneChunk.length > 1 || (sceneChunk[0]?.visual_beats ?? []).length > 1)) {
      let children;
      let splitUnit;
      if (sceneChunk.length > 1) {
        children = splitVisualReferenceChunkForTests(sceneChunk);
        splitUnit = `${sceneChunk.length} scenes`;
      } else {
        const scene = sceneChunk[0];
        const beats = scene.visual_beats ?? [];
        children = splitVisualReferenceChunkForTests(sceneChunk);
        splitUnit = `${beats.length} local beats in ${scene.scene_id ?? "one scene"}`;
      }
      console.error(`visual refs ${displayLabel}: prompt ${promptBytes} bytes exceeds ${maxChunkPromptBytes}; splitting ${splitUnit} into ${children.map((rows) => rows.length > 1 ? `${rows.length} scenes` : `${rows[0]?.visual_beats?.length ?? 0} beats`).join("+")}`);
      const childResults = await mapWithConcurrency(children, Math.min(children.length, 2), async (child, childIndex) => planChunk({
        sceneChunk: child,
        chunkLabel: `${chunkLabel}, adaptive part ${childIndex + 1} of ${children.length}`,
        stageSuffix: `${stageSuffix}_part_${String(childIndex + 1).padStart(2, "0")}`,
        displayLabel: `${displayLabel} part ${childIndex + 1}/${children.length}`,
        originalChunkId,
        repairSceneIds: child.map((scene) => String(scene.scene_id ?? "")).filter(Boolean),
      }));
      return childResults.flat();
    }
    const chunkStageName = `${stageName}_${stageSuffix}`;
    let llm = null;
    const chunkStartedMs = Date.now();
    try {
      assertVisualReferencePromptBytesForTests(prompt, {
        label: `visual-reference exact chunk ${stageSuffix}`,
        maxBytes: maxChunkPromptBytes,
      });
      llm = useLocalRoute
        ? await callLocal(prompt, chunkStageName, Number(flags["visual-ref-chunk-max-tokens"] ?? 7000))
        : await callCodex(prompt, chunkStageName);
      const rawTargetCount = Array.isArray(llm.parsed?.reference_targets) ? llm.parsed.reference_targets.length : 0;
      const candidatePlan = sanitizeChunkReferenceCandidates(llm.parsed);
      await recordPlannerChunkCheckpoint({
        episodeDir,
        plannerStage: "visual_reference_plan",
        chunkId: stageSuffix,
        inputHash: sha256(prompt),
        expectedIds: sceneChunk.map((scene) => scene.scene_id).filter(Boolean),
        status: "passed",
        attempt: 1,
        reused: Boolean(llm.reused_cached_output),
        outputPath: llm.output_path,
        metadata: {
          scene_count: sceneChunk.length,
          raw_target_count: rawTargetCount,
          retained_candidate_count: candidatePlan.reference_targets.length,
          automatic_creative_retry_count: 0,
        },
        telemetry: {
          requested_provider: "identity_locked",
          actual_provider: llm.provider ?? "unknown",
          model: llm.model ?? null,
          reasoning_effort: llm.reasoning_effort ?? null,
          risk_class: "medium",
          item_count: sceneChunk.length,
          scene_count: sceneChunk.length,
          prompt_chars: prompt.length,
          prompt_bytes: promptBytes,
          output_chars: String(llm.content ?? "").length,
          service_ms: Date.now() - chunkStartedMs,
        },
      });
      console.error(`visual refs ${displayLabel}: proposed ${rawTargetCount} raw targets, retained ${candidatePlan.reference_targets.length} clean candidates`);
      const beatIds = sceneChunk.flatMap((scene) => (
        scene.visual_beats ?? []
      )).map((beat) => String(beat?.visual_beat_id ?? beat?.beat_id ?? "")).filter(Boolean);
      return [{
        status: "passed",
        original_chunk_id: originalChunkId,
        repair_scene_ids: repairSceneIds,
        passed_chunk: {
          chunk_id: stageSuffix,
          source_chunk_id: originalChunkId,
          scene_ids: sceneChunk.map((scene) => String(scene.scene_id ?? "")).filter(Boolean),
          beat_ids: beatIds,
          input_sha256: sha256(prompt),
          raw_target_count: rawTargetCount,
          output_path: llm.output_path ?? null,
          candidate_plan: candidatePlan,
        },
      }];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const sceneIds = sceneChunk.map((scene) => scene.scene_id).filter(Boolean);
      const beatIds = sceneChunk.flatMap((scene) => (
        scene.visual_beats ?? []
      )).map((beat) => String(beat?.visual_beat_id ?? beat?.beat_id ?? "")).filter(Boolean);
      const referenceIds = (llm?.parsed?.reference_targets ?? []).map((target) => String(target?.ref_id ?? "").trim()).filter(Boolean);
      await recordPlannerChunkCheckpoint({
        episodeDir,
        plannerStage: "visual_reference_plan",
        chunkId: stageSuffix,
        inputHash: sha256(prompt),
        expectedIds: sceneIds,
        status: "failed",
        attempt: 1,
        outputPath: llm?.output_path ?? error?.outputPath ?? null,
        findings: [{
          code: "reference_chunk_single_attempt_failed",
          message,
          scene_ids: sceneIds,
          reference_ids: referenceIds,
          recovery: "Use exact failed ref IDs when recoverable from the raw output; otherwise perform an explicit manual structured repair. Automatic creative retry is disabled.",
        }],
        metadata: {
          scene_count: sceneChunk.length,
          automatic_creative_retry_count: 0,
          explicit_manual_repair_required: true,
        },
        telemetry: {
          requested_provider: "identity_locked",
          actual_provider: llm?.provider ?? "unknown",
          model: llm?.model ?? null,
          reasoning_effort: llm?.reasoning_effort ?? null,
          risk_class: "medium",
          item_count: sceneChunk.length,
          scene_count: sceneChunk.length,
          prompt_chars: prompt.length,
          prompt_bytes: promptBytes,
          output_chars: String(llm?.content ?? "").length,
          service_ms: Date.now() - chunkStartedMs,
        },
      });
      console.error(`visual refs ${displayLabel}: single creative attempt failed; preserving passed chunks and requiring explicit repair`);
      return [{
        status: "failed",
        original_chunk_id: originalChunkId,
        repair_scene_ids: repairSceneIds,
        failed_chunk: {
          chunk_id: stageSuffix,
          source_chunk_id: originalChunkId,
          scene_ids: sceneIds,
          beat_ids: beatIds,
          reference_ids: referenceIds,
          input_sha256: sha256(prompt),
          raw_output_path: llm?.output_path ?? error?.outputPath ?? null,
          message,
        },
      }];
    }
  };

  const chunkResults = await mapWithConcurrency(initialChunkDescriptors, chunkConcurrency, async (descriptor, index) => {
    console.error(`visual refs ${descriptor.displayLabel}: ${descriptor.sceneChunk.length} scenes (${index + 1}/${initialChunkDescriptors.length})`);
    return planChunk(descriptor);
  });
  const plannedChunks = chunkResults.flat();
  let passedChunks;
  let failedChunks;
  if (repairSelection?.mode === "chunks") {
    const mergedPartial = mergeReferencePartialRepairForTests(existingPartial, plannedChunks);
    passedChunks = mergedPartial.passed_chunks;
    failedChunks = mergedPartial.failed_chunks;
  } else if (repairSelection?.mode === "global") {
    passedChunks = normalizePartialPassedChunks(existingPartial);
    failedChunks = [];
  } else {
    passedChunks = uniqueByChunkId(plannedChunks.filter((result) => result.status === "passed").map((result) => result.passed_chunk));
    failedChunks = uniqueByChunkId(plannedChunks.filter((result) => result.status === "failed").map((result) => result.failed_chunk));
  }
  const chunkPlans = passedChunks.map((row) => row.candidate_plan).filter(Boolean);
  const chunkRawTargetCount = passedChunks.reduce((sum, row) => sum + Number(row.raw_target_count ?? 0), 0);
  if (failedChunks.length) {
    await writeJson(referencePartialPath, {
      ...referencePartialArtifact({ semanticPlan, passedChunks, failedChunks, status: "needs_chunk_repair" }),
      source_chunk_count: sourceChunkCount,
    });
    throw new Error(`Visual reference planning preserved ${passedChunks.length} passed chunk(s), but ${failedChunks.length} exact chunk scope(s) need later repair. Partial artifact: ${referencePartialPath}`);
  }
  if (!chunkPlans.length) throw new Error("Visual reference recovery has no preserved or repaired chunk candidate plans.");
  if (!chunkPlans.some((plan) => plan.reference_targets.length)) {
    console.error("visual refs: chunk calls selected zero candidates; the one global director submission will make the episode-level decision from locked evidence");
  }
  console.error(`visual refs merge: ${chunkPlans.length} chunk plans`);
  if (String(flags["visual-ref-merge-mode"] ?? "").toLowerCase() === "deterministic") {
    throw new Error("Deterministic visual-reference merge is disabled in director v2. The global LLM director must make the final creative selection.");
  }
  const {
    prompt: mergePrompt,
    candidateCatalog,
  } = buildMergePrompt(semanticPlan, chunkPlans, guidance, evidenceLedger, locationContractLedger);
  const mergeInputHash = sha256(mergePrompt);
  const globalExpectedSceneIds = (semanticPlan.scenes ?? []).map((scene) => String(scene.scene_id ?? "")).filter(Boolean);
  let mergePromptBytes;
  try {
    mergePromptBytes = assertVisualReferencePromptBytesForTests(mergePrompt, {
      label: "visual-reference global director merge",
      maxBytes: VISUAL_REFERENCE_DIRECTOR_SAFE_MAX_BYTES,
    });
  } catch (error) {
    await writeJson(referencePartialPath, {
      ...referencePartialArtifact({
        semanticPlan,
        passedChunks,
        failedChunks: [],
        status: "needs_global_repair",
        globalDirector: {
          status: "blocked_pre_submission",
          input_sha256: mergeInputHash,
          error: error instanceof Error ? error.message : String(error),
          automatic_creative_retry_count: 0,
          creative_submission_count: 0,
        },
      }),
      source_chunk_count: sourceChunkCount,
    });
    throw new Error(`Global visual-reference director packet exceeded its byte ceiling before provider submission. Passed chunk candidates remain preserved in ${referencePartialPath}.`);
  }
  console.error(`visual refs merge prompt: ${mergePromptBytes} bytes`);
  const maxMergeAttempts = 1;
  let merged = null;
  let lastMergeError = null;
  for (let attempt = 1; attempt <= maxMergeAttempts; attempt += 1) {
    const mergeStageName = attempt === 1 ? `${stageName}_merge` : `${stageName}_merge_repair_${attempt}`;
    const attemptPrompt = attempt === 1
      ? mergePrompt
      : `${mergePrompt}\n\nGlobal-director correction: the previous response failed validation with ${lastMergeError?.message}. Return the complete selected reference plan again with at least one clean, evidence-backed reference target.`;
    const mergeStartedMs = Date.now();
    try {
      const candidate = useLocalRoute
        ? await callLocal(attemptPrompt, mergeStageName, Number(flags["visual-ref-merge-max-tokens"] ?? 8000))
        : await callCodex(attemptPrompt, mergeStageName);
      const materializedParsed = materializeReferenceDirectorSelectionForTests(candidate.parsed, candidateCatalog);
      if (!Array.isArray(materializedParsed?.reference_targets) || !materializedParsed.reference_targets.length) {
        throw new Error("global director returned no reference targets");
      }
      merged = {
        ...candidate,
        parsed: materializedParsed,
        director_selection_contract: candidate.parsed?.selection_contract ?? "legacy_full_objects",
      };
      await recordPlannerChunkCheckpoint({
        episodeDir,
        plannerStage: "visual_reference_plan",
        chunkId: "global_merge",
        inputHash: mergeInputHash,
        expectedIds: globalExpectedSceneIds,
        status: "passed",
        attempt,
        reused: Boolean(candidate.reused_cached_output),
        outputPath: candidate.output_path,
        metadata: {
          selected_target_count: materializedParsed.reference_targets.length,
          director_selection_contract: candidate.parsed?.selection_contract ?? "legacy_full_objects",
        },
        telemetry: {
          requested_provider: "identity_locked",
          actual_provider: candidate.provider ?? "unknown",
          model: candidate.model ?? null,
          reasoning_effort: candidate.reasoning_effort ?? null,
          risk_class: "high",
          item_count: globalExpectedSceneIds.length,
          scene_count: globalExpectedSceneIds.length,
          prompt_chars: attemptPrompt.length,
          prompt_bytes: Buffer.byteLength(attemptPrompt, "utf8"),
          output_chars: String(candidate.content ?? "").length,
          service_ms: Date.now() - mergeStartedMs,
        },
      });
      break;
    } catch (error) {
      lastMergeError = error instanceof Error ? error : new Error(String(error));
      await recordPlannerChunkCheckpoint({
        episodeDir,
        plannerStage: "visual_reference_plan",
        chunkId: "global_merge",
        inputHash: mergeInputHash,
        expectedIds: globalExpectedSceneIds,
        status: "failed",
        attempt,
        outputPath: lastMergeError?.outputPath ?? null,
        findings: [{
          code: "reference_global_merge_validation_failed",
          message: lastMergeError.message,
          recovery: "Automatic creative retry is disabled. Repair the named references from the preserved raw output when available, or provide an explicit manual structured global selection.",
        }],
        metadata: { automatic_creative_retry_count: 0, explicit_manual_repair_required: true },
        telemetry: {
          requested_provider: "identity_locked",
          actual_provider: "unknown",
          risk_class: "high",
          item_count: globalExpectedSceneIds.length,
          scene_count: globalExpectedSceneIds.length,
          prompt_chars: attemptPrompt.length,
          prompt_bytes: Buffer.byteLength(attemptPrompt, "utf8"),
          service_ms: Date.now() - mergeStartedMs,
        },
      });
    }
  }
  if (!merged) {
    await writeJson(referencePartialPath, {
      ...referencePartialArtifact({
        semanticPlan,
        passedChunks,
        failedChunks: [],
        status: "needs_global_repair",
        globalDirector: {
          status: "failed",
          input_sha256: mergeInputHash,
          raw_output_path: lastMergeError?.outputPath ?? null,
          error: lastMergeError?.message ?? "global director failed",
          automatic_creative_retry_count: 0,
        },
      }),
      source_chunk_count: sourceChunkCount,
    });
    throw new Error(`Global visual-reference director made one failed creative submission. Preserved chunk candidates require a later explicit --repair-global true invocation: ${referencePartialPath}`);
  }
  const parsed = merged.parsed;
  if (repairRequested || pendingReferencePartial(existingPartial)) {
    await writeJson(referencePartialPath, {
      ...referencePartialArtifact({
        semanticPlan,
        passedChunks,
        failedChunks: [],
        status: "completed",
        globalDirector: {
          status: "passed",
          input_sha256: mergeInputHash,
          output_path: merged.output_path ?? null,
          selected_target_count: parsed.reference_targets.length,
        },
      }),
      source_chunk_count: sourceChunkCount,
    });
  }
  return {
    provider: merged.provider,
    model: useLocalRoute ? getLLMModel(stageName) : merged.model ?? configuredCodexModel(),
    reasoning_effort: merged.reasoning_effort ?? null,
    codex_cli_path: merged.codex_cli_path ?? null,
    codex_cli_version: merged.codex_cli_version ?? null,
    output_path: merged.output_path ?? null,
    chunked: true,
    chunk_count: passedChunks.length,
    source_chunk_count: sourceChunkCount,
    chunk_concurrency: Math.min(Math.max(1, sourceChunkCount), chunkConcurrency),
    chunk_raw_target_count: chunkRawTargetCount,
    merged_target_count: parsed.reference_targets.length,
    parsed,
    json_attempt: merged.json_attempt,
  };
}

function sourceReferencePath(target) {
  return String(
    target?.reference_image_path
      ?? target?.conditioning_image_path
      ?? target?.required_reference_path
      ?? target?.path
      ?? "",
  ).trim();
}

function characterConditioningRole(target) {
  const explicit = String(target?.conditioning_asset_role ?? "").trim().toLowerCase();
  if (["identity_state", "creature_identity", "faction_language"].includes(explicit)) return explicit;
  const subtype = String(target?.identity_subtype ?? "").trim().toLowerCase();
  if (/^(?:creature|construct|summon|spirit|undead)$/.test(subtype)) return "creature_identity";
  if (/^(?:creature_group|group|faction)$/.test(subtype) || isCollectiveGroupSubject(`${target?.subject ?? ""} ${target?.ref_id ?? ""}`)) return "faction_language";
  return "identity_state";
}

function approvedSourceQaStatus(value) {
  return /^passed(?:_|$)/i.test(String(value ?? "").trim());
}

function sourceOnlyReferenceFindings(target) {
  if (String(target?.generation_mode ?? "").toLowerCase() !== "source_only") return [];
  const findings = [];
  const refId = target?.ref_id ?? null;
  const kind = normalizeKind(target?.kind);
  const role = kind === "character_state" ? characterConditioningRole(target) : null;
  const origin = normalizeSourceOrigin(target?.source_origin);
  const reviewStatus = slug(target?.source_review_status, "");
  const pathValue = sourceReferencePath(target);
  const sourceImageId = String(target?.source_image_id ?? target?.source_cut_id ?? "").trim();
  const sourceHash = String(target?.source_image_sha256 ?? "").trim().toLowerCase();
  const reviewReceiptPath = String(target?.source_review_receipt_path ?? "").trim();
  const qaReceiptPath = String(target?.source_image_qa_receipt_path ?? "").trim();
  const add = (code, message, extra = {}) => findings.push({
    code,
    severity: "blocker",
    production_blocking: true,
    ref_id: refId,
    kind,
    ...extra,
    message,
  });

  if (!pathValue) add("source_only_reference_missing_path", `Source-only reference ${refId} must carry an exact reference_image_path or conditioning_image_path.`);
  if (!sourceImageId) add("source_only_reference_missing_image_id", `Source-only reference ${refId} must identify its source image.`);
  if (!/^[a-f0-9]{64}$/.test(sourceHash)) add("source_only_reference_missing_image_hash", `Source-only reference ${refId} must carry the exact 64-character source_image_sha256.`);
  if (!origin || !["owned_source", "accepted_production_cut"].includes(origin)) {
    add("source_only_reference_invalid_origin", `Source-only reference ${refId} must use source_origin owned_source or accepted_production_cut.`, { source_origin: origin });
  }
  if (reviewStatus !== "approved_clean") {
    add("source_only_reference_not_clean_approved", `Source-only reference ${refId} must carry source_review_status=approved_clean.`, { source_review_status: target?.source_review_status ?? null });
  }
  if (!reviewReceiptPath) add("source_only_reference_missing_review_receipt", `Source-only reference ${refId} must carry source_review_receipt_path for its clean review.`);

  if (origin === "accepted_production_cut") {
    if (!["location", "prop", "ui"].includes(kind)) {
      add("production_cut_source_kind_not_allowed", `Accepted production-cut source ${refId} is ${kind}; production cuts may source only location, prop, or UI references.`);
    }
    if (!String(target?.source_cut_id ?? "").trim()) {
      add("production_cut_source_missing_cut_id", `Accepted production-cut source ${refId} must identify source_cut_id.`);
    }
    if (!approvedSourceQaStatus(target?.source_image_qa_status)) {
      add("production_cut_source_not_qa_passed", `Accepted production-cut source ${refId} must carry a passed source_image_qa_status.`, { source_image_qa_status: target?.source_image_qa_status ?? null });
    }
    if (!qaReceiptPath) add("production_cut_source_missing_qa_receipt", `Accepted production-cut source ${refId} must carry source_image_qa_receipt_path.`);
  }

  if (kind === "character_state") {
    if (origin !== "owned_source") {
      add("character_source_must_be_owned", `Character source-only reference ${refId} must be an owned_source, never a production story cut.`);
    }
    if (role === "identity_state" && String(target?.identity_usage ?? "").toLowerCase() !== "face_only") {
      add("human_source_identity_not_face_only", `Human source-only reference ${refId} must use identity_usage=face_only; generated state refs own body, wardrobe, pose, and styling.`);
    }
  } else if (origin === "owned_source" && String(target?.identity_usage ?? "").toLowerCase() === "face_only") {
    add("non_character_source_marked_face_only", `Non-character source-only reference ${refId} cannot use face_only identity usage.`);
  }
  return findings;
}

function approvedCleanSourceOnlyTarget(target) {
  return String(target?.generation_mode ?? "").toLowerCase() === "source_only"
    && sourceOnlyReferenceFindings(target).length === 0;
}

const detachableReferenceObjectPattern = "(?:weapon|sword|blade|spear|bow|shield|gun|rifle|pistol|axe|hammer|staff|wand|knife|dagger|book|phone|smartphone|tablet|laptop|cup|bottle|bag|briefcase|suitcase|crutch|cane|coin|key|card|document|paper|folder|pen|pencil|microphone|camera|tool|map|scroll|torch|lantern|bell|orb|gem|crystal|crown|mask|amulet|necklace|ring|rope|chain)";
const integratedObjectLikePattern = /\b(?:bell|orb|core|gem|crystal|crown|mask|clock|lens|emblem|sigil|disc|plate|blade|spike|horn)\b/i;
const anatomyAttachmentLocationPattern = /\b(?:head|face|forehead|skull|neck|throat|chest|torso|back|shoulder|shoulders|arm|arms|hand|hands|waist|hip|hips|leg|legs|foot|feet|tail|tails|wing|wings)\b/i;
const anatomyAttachmentRelationPattern = /\b(?:integrated|built[- ]?in|fused|embedded|anatomical|prosthetic|cybernetic|organic|attached|growing|grown|forming|set|mounted|within|along)\b/i;

function matchHasClauseNegation(text, index) {
  const localStart = Math.max(
    0,
    text.lastIndexOf(".", index - 1) + 1,
    text.lastIndexOf(";", index - 1) + 1,
    text.lastIndexOf(",", index - 1) + 1,
  );
  const localPrefix = text.slice(localStart, index);
  const negationPattern = /\b(?:no|not|never|without|omit|omits|omitted|exclude|excludes|excluded|avoid|avoids|absent|free of)\b/ig;
  if (new RegExp(`${negationPattern.source}[^,.;]{0,55}$`, "i").test(localPrefix)) return true;

  // Reference prompts commonly end with a comma-separated exclusion list.
  // Keep that leading "no" in scope unless a contrast or a new depicted subject
  // clearly starts before the matched token.
  const sentenceStart = Math.max(
    0,
    text.lastIndexOf(".", index - 1) + 1,
    text.lastIndexOf(";", index - 1) + 1,
  );
  const sentencePrefix = text.slice(sentenceStart, index);
  const negations = [...sentencePrefix.matchAll(negationPattern)];
  const lastNegation = negations.at(-1);
  if (!lastNegation) return false;
  const tail = sentencePrefix.slice(Number(lastNegation.index ?? 0) + lastNegation[0].length);
  if (tail.length > 320) return false;
  if (/\b(?:but|however|although|though|while|yet|featuring|showing|depicting|alongside)\b/i.test(tail)) return false;
  if (/,\s*(?:a|an|the|one|two|three|several|many)\s+[^,.;]{0,28}$/i.test(tail)) return false;
  return true;
}

function matchIsNonDepictedStagingOrScaleMention(text, index, matchText) {
  const before = String(text ?? "").slice(Math.max(0, index - 100), index);
  if (/\b(?:space|room|area)\s+for\s+(?:(?:a|an|the)\s+)?(?:later\s+)?$/i.test(before)) return true;
  const around = String(text ?? "").slice(
    Math.max(0, index - 35),
    Math.min(String(text ?? "").length, index + String(matchText ?? "").length + 45),
  );
  return /\b(?:realistic|believable)\s+(?:human|person|people)(?:\s+and\s+\w+){0,2}(?:\s+working)?\s+scale\b/i.test(around);
}

function affirmativeHeldPropInAnchor(value) {
  const text = String(value ?? "");
  const patterns = [
    new RegExp(`\\b(?:holding|wielding|gripping|clutching|carrying|brandishing|aiming|swinging|raising|using|wearing|slinging|slung|strapping|strapped|sheathing|sheathed|holstering|holstered)\\b[^,.;]{0,80}\\b${detachableReferenceObjectPattern}\\b`, "ig"),
    new RegExp(`\\b${detachableReferenceObjectPattern}\\b[^,.;]{0,55}\\b(?:in (?:his|her|their|its|a|the)?\\s*(?:right|left)?\\s*(?:hand|hands|grip)|gripped by|at (?:his|her|their|its) (?:hip|waist)|on (?:his|her|their|its) (?:back|belt)|slung over|strapped to|sheathed at|holstered at)\\b`, "ig"),
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (matchHasClauseNegation(text, Number(match.index ?? 0))) continue;
      return true;
    }
  }
  return false;
}

function affirmativeActionPoseInAnchor(value) {
  const text = String(value ?? "");
  const pattern = /\b(?:lunging|running|sprinting|leaping|jumping|attacking|fighting|striking|swinging|casting|aiming|shooting|chasing|wrestling)\b/ig;
  for (const match of text.matchAll(pattern)) {
    if (!matchHasClauseNegation(text, Number(match.index ?? 0))) return true;
  }
  return false;
}

function integratedFeatureLooksLikeDetachableProp(value) {
  const text = String(value ?? "");
  if (!new RegExp(`\\b${detachableReferenceObjectPattern}\\b`, "i").test(text)) return false;
  if (anatomyAttachmentRelationPattern.test(text) && anatomyAttachmentLocationPattern.test(text)) return false;
  return !/\b(?:integrated|built[- ]?in|fused|anatomical|prosthetic|cybernetic|organic|part of (?:the|its|his|her|their) body|body structure|attachment point)\b/i.test(text);
}

function integratedObjectFeatureMissingAttachment(value) {
  const text = String(value ?? "");
  if (!integratedObjectLikePattern.test(text)) return false;
  return !anatomyAttachmentLocationPattern.test(text) || !anatomyAttachmentRelationPattern.test(text);
}

function explicitAnchorHandCounts(value) {
  const text = String(value ?? "");
  const wordCounts = new Map([
    ["no", 0], ["zero", 0], ["one", 1], ["two", 2], ["both", 2], ["three", 3],
    ["four", 4], ["five", 5], ["six", 6], ["seven", 7], ["eight", 8],
  ]);
  const counts = [];
  const pattern = /\b(?:exactly\s+)?(no|zero|one|two|both|three|four|five|six|seven|eight|\d+)\b((?:\s+(?:total|visible|natural|documented|prosthetic|grasping|stone|hand-like|present|anatomically|right|left|empty|relaxed|open)){0,7}\s+)\b(hand|hands|claw|claws|appendage|appendages)\b/ig;
  for (const match of text.matchAll(pattern)) {
    if (/\b(?:extra|additional|duplicate|duplicated)\b/i.test(match[2] ?? "")) continue;
    const count = wordCounts.has(String(match[1]).toLowerCase())
      ? wordCounts.get(String(match[1]).toLowerCase())
      : Number(match[1]);
    if (Number.isInteger(count) && count >= 0) counts.push(count);
  }
  return counts;
}

function integratedFeatureAnchored(feature, promptAnchor) {
  const stop = new Set(["a", "an", "the", "one", "two", "three", "four", "of", "to", "into", "in", "on", "at", "and", "or", "its", "his", "her", "their", "body", "structure", "integrated"]);
  const featureTokens = normalizedTokens(feature).filter((token) => !stop.has(token));
  const promptTokens = new Set(normalizedTokens(promptAnchor));
  if (!featureTokens.length) return false;
  const overlap = featureTokens.filter((token) => promptTokens.has(token)).length;
  const requiredOverlap = Math.max(Math.min(2, featureTokens.length), Math.ceil(featureTokens.length * 0.6));
  const attachmentTokens = new Set([
    "head", "face", "forehead", "skull", "neck", "throat", "chest", "torso", "back",
    "shoulder", "shoulders", "arm", "arms", "hand", "hands", "waist", "hip", "hips",
    "leg", "legs", "foot", "feet", "tail", "tails", "wing", "wings", "left", "right",
    "center", "centre", "front", "rear", "above", "below", "beneath", "between",
  ]);
  const requiredAttachmentTokens = featureTokens.filter((token) => attachmentTokens.has(token));
  return overlap >= requiredOverlap && requiredAttachmentTokens.every((token) => promptTokens.has(token));
}

function affirmativePatternPresent(text, pattern) {
  for (const match of String(text ?? "").matchAll(pattern)) {
    const index = Number(match.index ?? 0);
    if (matchHasClauseNegation(String(text ?? ""), index)) continue;
    if (matchIsNonDepictedStagingOrScaleMention(String(text ?? ""), index, match[0])) continue;
    return true;
  }
  return false;
}

function nonCharacterReferenceContentFindings(target) {
  if (String(target?.generation_mode ?? "").toLowerCase() === "source_only") return [];
  const kind = normalizeKind(target?.kind);
  if (!["location", "prop", "ui", "action", "style"].includes(kind)) return [];
  const promptAnchor = String(target?.prompt_anchor ?? "");
  const findings = [];
  const add = (code, message) => findings.push({
    code,
    severity: "warning",
    production_blocking: false,
    review_disposition: "manual_fix_or_accept",
    ref_id: target?.ref_id ?? null,
    kind,
    message,
  });
  const actorPattern = /\b(?:person|people|men|women|boys?|girls?|warriors?|soldiers?|students?|crowds?|characters?|humans?|figures?)\b|\bguards?\b(?!\s+rails?\b)/ig;
  const contextualBodyPartPattern = /\b(?:person|man|woman|boy|girl|warrior|soldier|student|character|human|figure)(?:'s|s')\s+(?:face|body|hand|hands|arm|arms)\b|\b(?:face|body|hand|hands|arm|arms)\b[^,.;]{0,28}\bof\s+(?:a|the)\s+(?:person|man|woman|boy|girl|warrior|soldier|student|character|human|figure)\b|\b(?:held|carried|wielded|gripped)\b[^,.;]{0,35}\b(?:by|in)\b[^,.;]{0,18}\b(?:hand|hands|arm|arms)\b/ig;
  const hasActor = affirmativePatternPresent(promptAnchor, actorPattern)
    || affirmativePatternPresent(promptAnchor, contextualBodyPartPattern);
  if (kind === "prop" && (hasActor || affirmativeHeldPropInAnchor(promptAnchor) || affirmativePatternPresent(promptAnchor, /\b(?:held|wielded|carried|gripped)\b/ig))) {
    add("prop_reference_anchor_contains_holder", `Prop reference ${target?.ref_id ?? "unknown"} must depict one isolated unheld object with no hand, body, or actor.`);
  }
  if (kind === "location") {
    if (hasActor) add("location_reference_anchor_contains_actor", `Location reference ${target?.ref_id ?? "unknown"} must be an unoccupied environment plate with no featured actor or body part.`);
    const featuredObjectPattern = new RegExp(`\\b(?:foreground|prominent|featured|centered|close[- ]?up)\\b[^,.;]{0,50}\\b${detachableReferenceObjectPattern}\\b|\\b${detachableReferenceObjectPattern}\\b[^,.;]{0,50}\\b(?:foreground|prominent|featured|centered|close[- ]?up)\\b`, "ig");
    if (affirmativePatternPresent(promptAnchor, featuredObjectPattern)) {
      add("location_reference_anchor_contains_featured_prop", `Location reference ${target?.ref_id ?? "unknown"} must not center a detachable foreground prop that can contaminate later scenes.`);
    }
  }
  if (kind === "ui" && (hasActor || affirmativePatternPresent(promptAnchor, /\b(?:phone|smartphone|tablet|laptop|device)\b/ig))) {
    add("ui_reference_anchor_contains_actor_or_device", `UI reference ${target?.ref_id ?? "unknown"} must isolate the interface motif without a person, hand, body, or physical device.`);
  }
  if (kind === "action" && (hasActor || affirmativeHeldPropInAnchor(promptAnchor))) {
    add("action_reference_anchor_contains_story_actor", `Action/effect reference ${target?.ref_id ?? "unknown"} must isolate effect or motion language on a neutral field without a story actor or held prop.`);
  }
  if (kind === "style" && affirmativePatternPresent(promptAnchor, /\b(?:person|people|character|face|portrait|hand|body|speech bubble|ui panel)\b/ig)) {
    add("style_reference_anchor_contains_concrete_subject", `Style reference ${target?.ref_id ?? "unknown"} must remain an abstract rendering/material/lighting sample without identities or interface panels.`);
  }
  return findings;
}

function characterReferenceContentFindings(target) {
  if (normalizeKind(target?.kind) !== "character_state") return [];
  if (String(target?.generation_mode ?? "").toLowerCase() === "source_only") return [];
  const findings = [];
  const role = characterConditioningRole(target);
  const refId = target?.ref_id ?? null;
  const expectedPose = role === "faction_language" ? "neutral_separated_lineup" : "neutral_single";
  const expectedHands = role === "creature_identity" ? "empty_or_unoccupied" : "relaxed_empty";
  const expectedSubjectCount = role === "faction_language" ? "3_to_5" : "1";
  const promptAnchor = String(target?.prompt_anchor ?? "");
  const add = (code, message, extra = {}) => findings.push({
    code,
    severity: "warning",
    production_blocking: false,
    review_disposition: "manual_fix_or_accept",
    ref_id: refId,
    conditioning_asset_role: role,
    ...extra,
    message,
  });

  if (String(target?.reference_cleanliness_contract_version ?? "") !== referenceCleanlinessContractVersion) {
    add("character_reference_cleanliness_contract_missing", `Character reference ${refId} must use ${referenceCleanlinessContractVersion}.`);
  }
  const identitySubtype = String(target?.identity_subtype ?? "").trim().toLowerCase();
  const humanSubtypes = new Set(["human", "person"]);
  const creatureSubtypes = new Set(["creature", "construct", "summon", "spirit", "undead"]);
  const groupSubtypes = new Set(["group", "creature_group", "faction"]);
  const subtypeRoleConflict = (role === "identity_state" && (creatureSubtypes.has(identitySubtype) || groupSubtypes.has(identitySubtype)))
    || (role === "creature_identity" && (humanSubtypes.has(identitySubtype) || groupSubtypes.has(identitySubtype)))
    || (role === "faction_language" && (humanSubtypes.has(identitySubtype) || creatureSubtypes.has(identitySubtype)));
  if (identitySubtype && subtypeRoleConflict) {
    add("character_reference_role_subtype_conflict", `Character reference ${refId} has conditioning_asset_role=${role} but incompatible identity_subtype=${identitySubtype}; the explicit role and subtype must describe the same conditioning concept.`, { identity_subtype: identitySubtype });
  }
  if (String(target?.reference_pose ?? "").toLowerCase() !== expectedPose) {
    add("character_reference_pose_not_neutral", `Character reference ${refId} must use reference_pose=${expectedPose}.`, { reference_pose: target?.reference_pose ?? null });
  }
  const visibleCount = Number(target?.visible_subject_count);
  if (role === "faction_language") {
    if (!Number.isInteger(visibleCount) || visibleCount < 3 || visibleCount > 5) {
      add("faction_reference_visible_subject_count_invalid", `Faction reference ${refId} must contain three through five separated visible subjects.`, { visible_subject_count: target?.visible_subject_count ?? null });
    }
  } else if (visibleCount !== 1) {
    add("character_reference_visible_subject_count_invalid", `Character reference ${refId} must contain exactly one visible subject.`, { visible_subject_count: target?.visible_subject_count ?? null, expected_visible_subject_count: expectedSubjectCount });
  }
  if (String(target?.hands_policy ?? "").toLowerCase() !== expectedHands) {
    add("character_reference_hands_policy_invalid", `Character reference ${refId} must use hands_policy=${expectedHands}.`, { hands_policy: target?.hands_policy ?? null });
  }
  let exactExpectedVisibleHands = null;
  if (role !== "faction_language") {
    const expectedVisibleHandsValue = target?.expected_visible_hands;
    const expectedVisibleHands = expectedVisibleHandsValue !== null
      && expectedVisibleHandsValue !== undefined
      && expectedVisibleHandsValue !== ""
      ? Number(expectedVisibleHandsValue)
      : null;
    if (!Number.isInteger(expectedVisibleHands) || expectedVisibleHands < 0) {
      add("character_reference_expected_visible_hands_invalid", `Character reference ${refId} must state the exact nonnegative expected_visible_hands for its authored anatomy.`, { expected_visible_hands: target?.expected_visible_hands ?? null });
    } else {
      exactExpectedVisibleHands = expectedVisibleHands;
    }
  }
  if (!Array.isArray(target?.detachable_props)) {
    add("character_reference_detachable_props_contract_missing", `Character reference ${refId} must carry detachable_props as an explicit empty array.`);
  } else if (target.detachable_props.length) {
    add("character_reference_contains_detachable_props", `Character reference ${refId} must keep every detachable weapon and prop in a separate prop/action reference.`, { detachable_props: target.detachable_props });
  }
  if (!Array.isArray(target?.integrated_anatomy_features)) {
    add("character_reference_integrated_anatomy_contract_missing", `Character reference ${refId} must carry integrated_anatomy_features as an explicit array.`);
  } else {
    const disguisedProps = target.integrated_anatomy_features.filter(integratedFeatureLooksLikeDetachableProp);
    if (disguisedProps.length) {
      add("integrated_anatomy_contains_detachable_prop", `Character reference ${refId} places a detachable object in integrated_anatomy_features; move it to a separate prop reference.`, { integrated_anatomy_features: disguisedProps });
    }
    const underspecifiedAttachments = target.integrated_anatomy_features.filter(integratedObjectFeatureMissingAttachment);
    if (underspecifiedAttachments.length) {
      add("integrated_anatomy_attachment_unspecified", `Character reference ${refId} contains an object-like integrated feature without an explicit body attachment and relationship; state exactly where and how it is integrated so Klein cannot relocate it.`, { integrated_anatomy_features: underspecifiedAttachments });
    }
    const unanchoredFeatures = target.integrated_anatomy_features.filter((feature) => !integratedFeatureAnchored(feature, promptAnchor));
    if (unanchoredFeatures.length) {
      add("integrated_anatomy_missing_from_anchor", `Character reference ${refId} must repeat every integrated anatomy feature consistently in prompt_anchor.`, { integrated_anatomy_features: unanchoredFeatures });
    }
  }
  if (exactExpectedVisibleHands != null) {
    const anchorHandCounts = explicitAnchorHandCounts(promptAnchor);
    if (!anchorHandCounts.length) {
      add("character_reference_anchor_missing_expected_hand_count", `Character reference ${refId} prompt_anchor must state exactly ${exactExpectedVisibleHands} visible hands or grasping appendages.`);
    } else if (anchorHandCounts.some((count) => count !== exactExpectedVisibleHands)) {
      add("character_reference_anchor_hand_count_conflict", `Character reference ${refId} prompt_anchor contradicts expected_visible_hands=${exactExpectedVisibleHands}.`, { anchor_hand_counts: anchorHandCounts });
    }
  }
  if (!/\bneutral\b/i.test(promptAnchor)) {
    add("character_reference_anchor_missing_neutral_pose", `Character reference ${refId} prompt_anchor must explicitly describe its neutral pose.`);
  }
  if (role === "faction_language" && !/\b(?:separated|lineup|line-up)\b/i.test(promptAnchor)) {
    add("faction_reference_anchor_missing_separation", `Faction reference ${refId} prompt_anchor must explicitly keep members separated in a neutral lineup.`);
  }
  if (role === "creature_identity") {
    const zeroAppendageContract = exactExpectedVisibleHands === 0
      && /\b(?:no|zero)\b[^.;]{0,35}\b(?:hand|hands|claw|claws|grasping|hand-like|appendage|appendages)\b|\bwithout\b[^.;]{0,35}\b(?:hand|hands|claw|claws|grasping|hand-like|appendage|appendages)\b/i.test(promptAnchor);
    if (!zeroAppendageContract && !/(?:\bempty\b|\bunoccupied\b)[^.;]{0,55}\b(?:hand|hands|claw|claws|grasping|appendage|appendages)\b|\b(?:hand|hands|claw|claws|grasping|appendage|appendages)\b[^.;]{0,55}(?:\bempty\b|\bunoccupied\b)/i.test(promptAnchor)) {
      add("creature_reference_anchor_missing_empty_appendages", `Creature reference ${refId} prompt_anchor must explicitly keep every grasping or hand-like appendage empty/unoccupied.`);
    }
  } else {
    const zeroHandContract = exactExpectedVisibleHands === 0
      && /\b(?:no|zero)\b[^.;]{0,25}\bhands?\b|\bwithout\b[^.;]{0,25}\bhands?\b/i.test(promptAnchor);
    if (!zeroHandContract && !/\bempty[- ]handed\b|\b(?:hand|hands)\b[^.;]{0,45}\bempty\b|\bempty\b[^.;]{0,45}\b(?:hand|hands)\b/i.test(promptAnchor)) {
      add("character_reference_anchor_missing_empty_hands", `Human/faction reference ${refId} prompt_anchor must explicitly keep all hands relaxed and empty, or explicitly state that no hands are anatomically present.`);
    }
  }
  if (affirmativeHeldPropInAnchor(promptAnchor)) {
    add("character_reference_anchor_depicts_detachable_prop", `Character reference ${refId} prompt_anchor affirmatively depicts a held weapon or detachable prop.`);
  }
  if (affirmativeActionPoseInAnchor(promptAnchor)) {
    add("character_reference_anchor_depicts_action_pose", `Character reference ${refId} prompt_anchor depicts an action pose instead of a neutral identity/anatomy plate.`);
  }
  return findings;
}

function evidenceAssetCoverageKeys(asset) {
  return new Set([
    asset?.asset_id,
    asset?.ref_id,
    asset?.canonical_subject_id,
    asset?.canonical_subject_key,
    asset?.subject,
    ...(asset?.observed_aliases ?? []),
  ].map((value) => slug(value, "")).filter(Boolean));
}

function targetCoverageKeys(target) {
  return new Set([
    target?.inventory_asset_id,
    target?.canonical_subject_id,
    target?.base_asset_id,
    target?.ref_id,
    target?.subject,
    ...(target?.evidence_asset_ids ?? []),
  ].map((value) => slug(value, "")).filter(Boolean));
}

function targetCoversEvidenceAsset(target, asset) {
  if (normalizeKind(target?.kind) !== normalizeKind(asset?.kind)) return false;
  const assetKeys = evidenceAssetCoverageKeys(asset);
  const targetKeys = targetCoverageKeys(target);
  for (const key of targetKeys) if (assetKeys.has(key)) return true;
  return false;
}

function bindingRecurringEvidenceAsset(asset) {
  const kind = normalizeKind(asset?.kind);
  const beats = Number(asset?.beat_count ?? asset?.beat_ids?.length ?? 0);
  const scenes = Number(asset?.distinct_scene_count ?? asset?.scene_ids?.length ?? 0);
  if (kind === "character_state") return beats >= 2 || scenes >= 2;
  if (["location", "prop", "ui"].includes(kind)) return beats >= 3 || scenes >= 2;
  return false;
}

function recurringReferenceCoverageFindings(evidenceLedger, referenceTargets, { legacyRevalidation = false } = {}) {
  if (legacyRevalidation) return [];
  const findings = [];
  for (const asset of (evidenceLedger?.assets ?? []).filter(bindingRecurringEvidenceAsset)) {
    const matchingTargets = (referenceTargets ?? []).filter((target) => targetCoversEvidenceAsset(target, asset));
    const cleanTargets = matchingTargets.filter((target) => {
      const mode = String(target?.generation_mode ?? "").toLowerCase();
      if (mode === "standalone_ref") return true;
      if (!approvedCleanSourceOnlyTarget(target)) return false;
      return !(
        normalizeKind(asset?.kind) === "character_state"
        && String(target?.identity_usage ?? "").toLowerCase() === "face_only"
      );
    });
    if (cleanTargets.length) continue;
    findings.push({
      code: "recurring_reference_coverage_missing",
      severity: "warning",
      production_blocking: false,
      review_required: true,
      review_disposition: "director_must_select_clean_reference",
      asset_id: asset.asset_id ?? null,
      ref_id: asset.ref_id ?? null,
      kind: normalizeKind(asset.kind),
      subject: asset.subject ?? null,
      beat_count: Number(asset.beat_count ?? asset.beat_ids?.length ?? 0),
      distinct_scene_count: Number(asset.distinct_scene_count ?? asset.scene_ids?.length ?? 0),
      scene_ids: asset.scene_ids ?? [],
      beat_ids: asset.beat_ids ?? [],
      matching_target_ids: matchingTargets.map((target) => target.ref_id).filter(Boolean),
      matching_generation_modes: matchingTargets.map((target) => target.generation_mode ?? null),
      message: `Global reference director omitted binding recurring coverage for ${asset.subject ?? asset.asset_id}. It must select an evidence-linked standalone_ref or approved-clean full conditioning source; a face-only source is only an identity dependency and does not replace a recurring character-state plate. Deterministic code will not invent one.`,
    });
  }
  return findings;
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
    if (!legacyRevalidation) {
      findings.push(...sourceOnlyReferenceFindings(target));
      findings.push(...characterReferenceContentFindings(target));
      findings.push(...nonCharacterReferenceContentFindings(target));
    }
    if (!legacyRevalidation && (mode === "no_ref_needed" || /^derive_from_/i.test(mode))) {
      findings.push({
        code: "director_selected_non_clean_reference_mode",
        severity: "warning",
        production_blocking: false,
        ref_id: target.ref_id,
        generation_mode: mode,
        message: `Reference director selected ${target.ref_id} with ${mode}; v2 permits only clean standalone, manual-review, or approved source references.`,
      });
    }
    if (mode !== "source_only" && !llmTargetIds.has(String(target.ref_id ?? ""))) {
      findings.push({
        code: "post_llm_reference_target_expansion",
        severity: "blocker",
        production_blocking: true,
        ref_id: target.ref_id,
        message: `Post-LLM processing introduced ${target.ref_id}; deterministic stages may not restore or invent reference targets.`,
      });
    }
    const unknownSceneIds = (target.scene_ids ?? []).filter((sceneId) => !knownSceneIds.has(String(sceneId)));
    if (unknownSceneIds.length) {
      findings.push({
        code: "reference_target_unknown_scene_scope",
        severity: "warning",
        production_blocking: false,
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
        severity: "warning",
        production_blocking: false,
        ref_id: target.ref_id,
        message: `Reference ${target.ref_id} does not state a clean_plate_contract.`,
      });
    }
    if (!legacyRevalidation && mode !== "source_only" && Number(target.conditioning_subject_count) !== 1) {
      findings.push({
        code: "reference_target_not_single_conditioning_concept",
        severity: "warning",
        production_blocking: false,
        ref_id: target.ref_id,
        conditioning_subject_count: target.conditioning_subject_count,
        message: `Reference ${target.ref_id} must condition exactly one identity/state, environment, prop, UI motif, faction language, action/effect language, or style language.`,
      });
    }
    if (!legacyRevalidation && mode !== "source_only") {
      const allowedRoles = {
        style: new Set(["style_language"]),
        character_state: new Set(["identity_state", "creature_identity", "faction_language"]),
        location: new Set(["environment"]),
        prop: new Set(["prop"]),
        ui: new Set(["ui_motif"]),
        action: new Set(["action_effect"]),
      }[normalizeKind(target.kind)] ?? new Set();
      if (!allowedRoles.has(String(target.conditioning_asset_role ?? ""))) {
        findings.push({
          code: "reference_target_conditioning_role_mismatch",
          severity: "warning",
          production_blocking: false,
          ref_id: target.ref_id,
          kind: target.kind,
          conditioning_asset_role: target.conditioning_asset_role ?? null,
          message: `Reference ${target.ref_id} has a conditioning role that does not match its reference kind.`,
        });
      }
    }
    const canonicalId = String(target.canonical_subject_id ?? "").trim();
    if (canonicalId) {
      const identityRole = isFaceOnlySourceDependency(target)
        ? "face_source_dependency"
        : String(target.state_delta ?? "base");
      const key = [normalizeKind(target.kind), canonicalId, identityRole].join("|");
      if (!canonicalGroups.has(key)) canonicalGroups.set(key, []);
      canonicalGroups.get(key).push(target.ref_id);
    }
  }
  for (const [key, ids] of canonicalGroups.entries()) {
    if (ids.length <= 1) continue;
    findings.push({
      code: "duplicate_canonical_reference_family",
      severity: "warning",
      production_blocking: false,
      canonical_key: key,
      ref_ids: ids,
      message: `Global director returned duplicate refs for canonical family ${key}: ${ids.join(", ")}.`,
    });
  }
  return findings;
}

export function dropUnknownReferenceSceneScopesForTests(referenceTargets, knownSceneIds) {
  const known = knownSceneIds instanceof Set ? knownSceneIds : new Set(knownSceneIds ?? []);
  const findings = [];
  const targets = (referenceTargets ?? []).map((target) => {
    const original = (target.scene_ids ?? []).map(String).filter(Boolean);
    const dropped = original.filter((sceneId) => !known.has(sceneId));
    if (dropped.length) {
      findings.push({
        code: "reference_target_unknown_scene_scope_preserved",
        severity: "warning",
        ref_id: target.ref_id,
        scene_ids: dropped,
        message: `Preserved retired or unknown scene scope on ${target.ref_id}; deterministic validation reports it for review but does not rewrite the global director's selection.`,
      });
    }
    return { ...target, scene_ids: original };
  });
  return { targets, findings };
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
      severity: "warning",
      production_blocking: false,
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
        production_blocking: true,
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
        severity: "warning",
        production_blocking: false,
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
  const selectedIds = new Set(
    (llm?.parsed?.reference_targets ?? []).map((target) => String(target?.ref_id ?? "")).filter(Boolean),
  );
  const finalIds = new Set((finalTargets ?? []).map((target) => String(target?.ref_id ?? "")).filter(Boolean));
  return {
    contract_version: "reference_director_v3_full_selection",
    evidence_observation_count: evidenceLedger?.assets?.length ?? 0,
    location_contract_count: locationContractLedger?.contracts?.length ?? 0,
    chunk_raw_proposal_count: Number(llm?.chunk_raw_target_count ?? llmTargetCount),
    llm_merged_target_count: Number(llm?.merged_target_count ?? llmTargetCount),
    llm_selected_target_count: llmTargetCount,
    final_target_count: finalTargets.length,
    post_director_removed_target_count: [...selectedIds].filter((refId) => !finalIds.has(refId)).length,
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

export function recurringReferenceCoverageFindingsForTests(evidenceLedger, referenceTargets, options = {}) {
  return recurringReferenceCoverageFindings(evidenceLedger, referenceTargets, options);
}

export function characterReferenceContentFindingsForTests(target) {
  return characterReferenceContentFindings(target);
}

export function nonCharacterReferenceContentFindingsForTests(target) {
  return nonCharacterReferenceContentFindings(target);
}

export function sourceOnlyReferenceFindingsForTests(target) {
  return sourceOnlyReferenceFindings(target);
}

export function approvedCleanSourceOnlyTargetForTests(target) {
  return approvedCleanSourceOnlyTarget(target);
}

export function referenceCharacterStateFindingsForTests(characterStateRefs, referenceTargets, options = {}) {
  return characterStateDirectorFindings(characterStateRefs, referenceTargets, options);
}

export function referenceOpeningIdentityFindingsForTests(referenceTargets, visualBeatPlan) {
  return openingSelectedIdentityFindings(referenceTargets, visualBeatPlan);
}

export function identityMergeKeyForTests(target) {
  return identityMergeKey(target);
}

export function reconcileReferenceIdentityTargetsForTests(referenceTargets, characterStateRefs) {
  const firstCanonicalMerge = mergeCanonicalBaseIdentityRefs(referenceTargets, characterStateRefs);
  const secondCanonicalMerge = mergeCanonicalBaseIdentityRefs(
    firstCanonicalMerge.referenceTargets,
    firstCanonicalMerge.characterStateRefs,
  );
  const aliasCollapse = collapseCharacterIdentityAliasTargets(
    secondCanonicalMerge.referenceTargets,
    secondCanonicalMerge.characterStateRefs,
  );
  return {
    referenceTargets: aliasCollapse.referenceTargets,
    characterStateRefs: aliasCollapse.characterStateRefs,
    warnings: [
      ...firstCanonicalMerge.warnings,
      ...secondCanonicalMerge.warnings,
      ...aliasCollapse.warnings,
    ],
  };
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
  activeContentProfile = contentProfileForIdentity(runIdentity ?? {});
  const semanticWithBeats = semanticPlanWithVisualBeats(semanticPlan, visualBeatPlan);
  const { plan: scopedSemantic, scope } = scopedSemanticPlan(semanticWithBeats);
  if (!Array.isArray(scopedSemantic.scenes) || !scopedSemantic.scenes.length) throw new Error("Visual reference planner scope selected zero semantic scenes.");
  const stageName = `${episode}_visual_reference_plan`;
  if (runIdentity?.schema === "goldflow_run_identity_v2" && (storyFactLedger?.status !== "passed" || storyFactLedger.source_script_hash !== semanticPlan.source_script_hash)) {
    throw new Error(`Reference Director v2 requires current story_fact_ledger.json: ${storyFactLedgerPath}`);
  }
  const guidance = {
    visualStyleBible,
    characterBible,
    episodeVisualDirection,
    storyFactLedger,
    contentProfile: activeContentProfile,
  };
  const referenceEvidenceLedger = buildReferenceEvidenceLedger(scopedSemantic, visualBeatPlan, {
    outputPath: referenceEvidenceLedgerOutputPath,
    storyFactLedger,
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
  let referenceTargets = (Array.isArray(llm.parsed.reference_targets) ? llm.parsed.reference_targets : []).map((target, index) => {
    const normalized = normalizeTarget(target, index);
    return legacyRevalidation
      ? { ...normalized, ...target, ref_id: normalized.ref_id, scene_ids: normalized.scene_ids, generation_mode: normalized.generation_mode }
      : normalized;
  });
  const fullSelectionContract = !legacyRevalidation
    || String(existingReferencePlan?.reference_director_contract_version ?? "") === "reference_director_v3_full_selection";
  const directorSelectionReceipt = fullSelectionContract
    ? (existingReferencePlan?.reference_director_selection_receipt
      ?? buildReferenceDirectorSelectionReceipt(referenceTargets, {
        sourceOutputPath: llm.output_path ?? null,
        sourceOutputSha256: llm.output_path ? await hashFile(llm.output_path) : null,
      }))
    : null;
  const llmTargetIds = new Set(
    (directorSelectionReceipt?.selected_ref_ids ?? referenceTargets.map((target) => String(target.ref_id ?? "")))
      .map(String)
      .filter(Boolean),
  );
  const llmTargetCount = Number(directorSelectionReceipt?.selected_target_count ?? referenceTargets.length);
  // In the full-selection contract, a style reference selected by the global
  // director is part of the same production library as every other target.
  // A style bible can make the director omit that asset, but deterministic code
  // may not remove it after selection.
  const shouldDropStyleRefs = fullSelectionContract
    ? false
    : dropStyleRefs || (Boolean(visualStyleBible) && !keepStyleRefs);
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
  let characterStateRefs = (Array.isArray(llm.parsed.character_state_refs) ? llm.parsed.character_state_refs : []).map((ref, index) => {
    const normalized = normalizeStateRef(ref, index);
    return legacyRevalidation
      ? { ...normalized, ...ref, state_ref_id: normalized.state_ref_id, scene_ids: normalized.scene_ids }
      : normalized;
  });
  const canonicalCharacterScope = applyCanonicalCharacterIdentitySceneIds(
    referenceTargets,
    characterStateRefs,
    visualBeatRows(visualBeatPlan),
  );
  referenceTargets = canonicalCharacterScope.targets;
  const sourceFaceAnchoring = await applySourceFaceAnchors({
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
  let canonicalIdentityMerge = { referenceTargets, characterStateRefs, warnings: [] };
  let finalCanonicalIdentityMerge = { referenceTargets, characterStateRefs, warnings: [] };
  let finalIdentityAliasCollapse = { referenceTargets, characterStateRefs, warnings: [] };
  if (!fullSelectionContract) {
    canonicalIdentityMerge = mergeCanonicalBaseIdentityRefs(referenceTargets, characterStateRefs);
    referenceTargets = canonicalIdentityMerge.referenceTargets;
    characterStateRefs = canonicalIdentityMerge.characterStateRefs;
    finalCanonicalIdentityMerge = mergeCanonicalBaseIdentityRefs(referenceTargets, characterStateRefs);
    referenceTargets = finalCanonicalIdentityMerge.referenceTargets;
    characterStateRefs = finalCanonicalIdentityMerge.characterStateRefs;
    finalIdentityAliasCollapse = collapseCharacterIdentityAliasTargets(referenceTargets, characterStateRefs);
    referenceTargets = finalIdentityAliasCollapse.referenceTargets;
    characterStateRefs = finalIdentityAliasCollapse.characterStateRefs;
  }
  const anchorLanguageWarnings = [
    ...providerExclusionPayloadAnchorWarnings(referenceTargets, characterStateRefs),
    ...abstractStatusAsPhysicalAnchorWarnings(referenceTargets, characterStateRefs),
  ];
  const promptFacingPrune = fullSelectionContract
    ? { referenceTargets, warnings: [], prunedTargetIds: [] }
    : prunePromptFacingNoRefTargets(referenceTargets);
  referenceTargets = promptFacingPrune.referenceTargets;
  const knownSceneIds = new Set(scopedSemantic.scenes.map((scene) => String(scene.scene_id ?? "")));
  const unknownSceneScopeDrop = dropUnknownReferenceSceneScopesForTests(referenceTargets, knownSceneIds);
  referenceTargets = unknownSceneScopeDrop.targets;
  const directorSelectionFindings = finalDirectorSelectionFindings(referenceTargets, {
    llmTargetIds,
    knownSceneIds,
    legacyRevalidation,
  });
  const recurringCoverageFindings = recurringReferenceCoverageFindings(referenceEvidenceLedger, referenceTargets, { legacyRevalidation });
  const openingIdentityFindings = openingSelectedIdentityFindings(referenceTargets, visualBeatPlan);
  const characterStateFindings = characterStateDirectorFindings(characterStateRefs, referenceTargets, { legacyRevalidation });
  const nonhumanSelectionFindings = unselectedDistinctNonhumanActorFindingsForTests(referenceEvidenceLedger, referenceTargets);
  const selectionFidelityFindings = fullSelectionContract
    ? referenceDirectorSelectionFidelityFindings({
        reference_director_contract_version: "reference_director_v3_full_selection",
        reference_director_selection_receipt: directorSelectionReceipt,
        reference_targets: referenceTargets,
      })
    : [];
  const coverageFindings = locationContractLedger.findings ?? [];
  const styleFindings = shouldDropStyleRefs ? [] : styleReferenceContaminationFindings(referenceTargets);
  const findings = [...coverageFindings, ...locationContractScope.findings, ...unknownSceneScopeDrop.findings, ...styleFindings, ...directorSelectionFindings, ...recurringCoverageFindings, ...openingIdentityFindings, ...characterStateFindings, ...nonhumanSelectionFindings, ...selectionFidelityFindings];
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
    content_profile: {
      id: activeContentProfile.id,
      version: activeContentProfile.version,
      sha256: runIdentity?.content_profile_sha256 ?? null,
    },
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
    reference_director_contract_version: fullSelectionContract
      ? "reference_director_v3_full_selection"
      : (existingReferencePlan.reference_director_contract_version ?? "legacy_revalidation"),
    reference_director_selection_receipt: directorSelectionReceipt,
    reference_cleanliness_contract_version: legacyRevalidation
      ? (existingReferencePlan.reference_cleanliness_contract_version ?? null)
      : referenceCleanlinessContractVersion,
    reference_evidence_ledger_path: referenceEvidenceLedgerOutputPath,
    location_contract_ledger_path: locationContractLedgerOutputPath,
    reference_inventory_ledger_path: referenceInventoryLedgerOutputPath,
    reference_inventory_summary: referenceInventoryLedger.summary,
    reference_selection_telemetry: selectionTelemetry,
    canonical_character_scope_overlay: {
      policy: "Only exact canonical visible-character matches from approved editorial beats expand an already-selected base identity ref. No reference IDs are authored, removed, merged, or guessed.",
      additions: canonicalCharacterScope.additions,
    },
    style_reference_policy: shouldDropStyleRefs
      ? "style refs dropped for this run; use style bible/text guidance only"
      : "style refs allowed only as abstract rendering/material/lighting samples",
    planner: {
      ...(legacyRevalidation ? existingReferencePlan.planner ?? {} : {}),
      provider: llm.provider,
      model: llm.model ?? null,
      reasoning_effort: llm.reasoning_effort ?? null,
      codex_cli_path: llm.codex_cli_path ?? null,
      codex_cli_version: llm.codex_cli_version ?? null,
      output_path: llm.output_path ?? null,
      chunked: llm.chunked ?? false,
      chunk_count: llm.chunk_count ?? null,
      chunk_concurrency: llm.chunk_concurrency ?? null,
      chunk_ledger_path: path.join(episodeDir, "planner_chunk_ledger.json"),
      chunk_raw_target_count: llm.chunk_raw_target_count ?? null,
      merged_target_count: llm.merged_target_count ?? llmTargetCount,
      creative_attempts_per_chunk: 1,
      global_director_creative_attempts: 1,
      automatic_creative_retry_count: 0,
      revalidated_without_llm: legacyRevalidation,
      revalidated_at: legacyRevalidation ? new Date().toISOString() : null,
    },
    reference_budget: {
      profile: fullSelectionContract ? "llm_full_selection_v3" : "llm_directed_v2",
      policy: fullSelectionContract
        ? "The full clean global LLM director selection is the production library. Deterministic code never caps, prunes, merges away, or downgrades a selected generated target; the separate four-reference limit applies only when attaching refs to an individual scene cut."
        : "The global reference-director LLM is the sole creative selector. Deterministic code may validate, canonicalize, scope, and add source-only dependencies; it never restores omitted generated targets.",
      llm_selected_target_count: llmTargetCount,
      final_target_count: referenceTargets.length,
      post_director_removed_target_count: Math.max(0, llmTargetCount - referenceTargets.filter((target) => llmTargetIds.has(String(target.ref_id ?? ""))).length),
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
    const [partial, existing] = await Promise.all([
      readJson(referencePartialPath, null),
      readJson(outputPath, null),
    ]);
    if (existing?.status !== "passed") {
      await writeJson(outputPath, {
        schema: "goldflow_visual_reference_plan_v1",
        status: pendingReferencePartial(partial) ? "blocked" : "failed",
        error: error instanceof Error ? error.message : String(error),
        reference_partial_path: pendingReferencePartial(partial) ? referencePartialPath : null,
        failed_chunk_ids: pendingReferencePartial(partial)
          ? (partial.failed_chunks ?? []).map((row) => row.chunk_id).filter(Boolean)
          : [],
        failed_scene_ids: pendingReferencePartial(partial)
          ? [...new Set((partial.failed_chunks ?? []).flatMap((row) => row.scene_ids ?? []).map(String).filter(Boolean))]
          : [],
        passed_chunks_preserved: pendingReferencePartial(partial) ? Number(partial.passed_chunk_count ?? 0) : 0,
        updated_at: new Date().toISOString(),
      }).catch(() => {});
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
