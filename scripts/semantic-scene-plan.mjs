#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getLLMBaseURL, getLLMModel, isLocalLLMRoute, localLLMAuthHeaders, localLLMChatCompletionURL } from "./lib/llm-router.mjs";
import { configuredCodexModel, isCodexCacheCompatible, readCodexCallMetadata, runCodexCli } from "./lib/codex-cli-runner.mjs";
import { recordPlannerChunkCheckpoint } from "./lib/planner-chunk-ledger.mjs";
import { parseJsonObjectFromPlannerOutput } from "./lib/json-output-repair.mjs";
import {
  readPassedSemanticChunkCheckpoint,
  semanticChunkId,
  semanticPartialFailureArtifact,
  semanticRequestedUnitIds,
  semanticSceneCountFindings,
  writeSemanticChunkCheckpoint,
} from "./lib/semantic-planner-recovery.mjs";
import {
  contentProfileForIdentity,
  contentProfilePlannerDirective,
  contentProfilePlannerRole,
} from "./lib/content-profiles.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const weekDir = path.join(dataRoot, "channels", channel, "weekly_runs", week);
const episodeDir = path.join(weekDir, "episodes", episode);
const scriptPath = path.join(episodeDir, "script_clean.md");
const outputPath = flags.output ?? path.join(episodeDir, "semantic_scene_plan.json");
const storyFactLedgerPath = flags["fact-ledger-output"] ?? path.join(episodeDir, "story_fact_ledger.json");
const runIdentityPath = path.join(episodeDir, "run_identity.json");
const proofBaselineTimingPath = flags["proof-baseline-word-timing"] ?? null;
const manualLocationRefRepairsPath = flags["manual-location-ref-repairs"]
  ? path.resolve(flags["manual-location-ref-repairs"])
  : null;
const manualSemanticRepairsPath = flags["manual-semantic-repairs"]
  ? path.resolve(flags["manual-semantic-repairs"])
  : null;
const scopeStartSec = flags["scope-start-sec"] == null ? null : Number(flags["scope-start-sec"]);
const scopeEndSec = flags["scope-end-sec"] == null ? null : Number(flags["scope-end-sec"]);
let activeContentProfile = contentProfileForIdentity({});

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

export function semanticReasoningEffortForStage(stageName, stageFlags = {}) {
  const isGlobalReconciliation = /global_reconciliation/i.test(String(stageName ?? ""));
  const stageSpecific = isGlobalReconciliation
    ? stageFlags["semantic-reconciliation-reasoning-effort"]
    : stageFlags["semantic-chunk-reasoning-effort"];
  return stageSpecific ?? stageFlags["reasoning-effort"] ?? null;
}

async function readText(filePath, fallback = "") {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return fallback;
  }
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function extractJson(text) {
  return parseJsonObjectFromPlannerOutput(text).value;
}

function approvedForHash(artifact, hash) {
  if (!artifact) return false;
  const status = String(artifact.status ?? artifact.approval_status ?? "").toLowerCase();
  return (artifact.approved === true || artifact.operator_approved === true || status.includes("approved") || status === "script_locked")
    && [artifact.script_clean_hash, artifact.source_script_hash].filter(Boolean).includes(hash);
}

async function requireApproval(scriptHash) {
  if (flags["allow-unlocked-script"] === "true") return { diagnostic: true };
  const manual = await readJson(path.join(episodeDir, "manual_agent_script_review.json"), null);
  const operator = await readJson(path.join(episodeDir, "operator_script_approval.json"), null);
  const lock = await readJson(path.join(episodeDir, "script_lock.json"), null);
  if (approvedForHash(manual, scriptHash) && approvedForHash(operator, scriptHash) && approvedForHash(lock, scriptHash)) {
    return { diagnostic: false };
  }
  throw new Error(`Refusing semantic scene plan: script hash ${scriptHash} is not approved/locked. Run script approve for the exact hash.`);
}

async function biblePacket() {
  const files = ["series_package.json", "series_bible.json", "character_bible.json", "location_bible.json", "visual_style_bible.json"];
  const packet = {};
  for (const file of files) {
    packet[file] = await readJson(path.join(weekDir, file), await readJson(path.join(dataRoot, "channels", channel, "series", series, file), null));
  }
  return packet;
}

function wordCount(text) {
  return String(text ?? "").trim().split(/\s+/).filter(Boolean).length;
}

export function semanticProofScopeForTests(script, timing, startSec, endSec, bufferWords = 24) {
  if (!Number.isFinite(Number(startSec)) || !Number.isFinite(Number(endSec)) || Number(endSec) <= Number(startSec)) {
    return { script, scoped: false, source_word_start: 0, source_word_end_exclusive: wordCount(script) };
  }
  if (Number(startSec) !== 0) throw new Error("Semantic proof baseline scoping currently requires scope-start-sec 0 so locked-script order remains exact.");
  const timingWords = Array.isArray(timing?.words) ? timing.words : [];
  const inScope = timingWords.filter((row) => Number(row?.start_sec ?? row?.start ?? 0) < Number(endSec));
  if (!inScope.length) throw new Error("Semantic proof baseline timing contains no words inside the requested scope.");
  const source = String(script ?? "");
  const scriptWords = [...source.matchAll(/\S+/g)];
  const endExclusive = Math.min(scriptWords.length, inScope.length + Math.max(0, Number(bufferWords) || 0));
  const lastIncluded = scriptWords[Math.max(0, endExclusive - 1)];
  const charEndExclusive = lastIncluded ? Number(lastIncluded.index ?? 0) + lastIncluded[0].length : 0;
  return {
    script: source.slice(0, charEndExclusive),
    scoped: true,
    source_word_start: 0,
    source_word_end_exclusive: endExclusive,
    baseline_timing_word_count: inScope.length,
    buffer_words: Math.max(0, Number(bufferWords) || 0),
    start_sec: Number(startSec),
    end_sec: Number(endSec),
  };
}

function sceneCountTargets(script) {
  const words = wordCount(script);
  const target = Math.min(70, Math.max(12, Math.round(words / 200)));
  const minimum = Math.min(target, Math.max(8, Math.floor(words / 320)));
  const maximum = Math.max(target + 12, Math.ceil(words / 120));
  return { words, target, minimum, maximum };
}

function chunkSceneCountTargets(script) {
  const words = wordCount(script);
  const target = Math.max(2, Math.round(words / 200));
  const minimum = Math.max(1, Math.floor(words / 360));
  const maximum = Math.max(target + 3, Math.ceil(words / 110));
  return { words, target, minimum, maximum };
}

function splitWordsIntoChunks(text, targetWords) {
  const words = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  const chunks = [];
  for (let index = 0; index < words.length; index += targetWords) {
    chunks.push(words.slice(index, index + targetWords).join(" "));
  }
  return chunks;
}

function splitOversizedChunkUnit(text, targetWords) {
  const normalized = String(text ?? "").trim();
  if (!normalized) return [];
  if (wordCount(normalized) <= targetWords) return [normalized];
  const sentences = normalized.match(/[^.!?]+(?:[.!?]+["'”’]*)?|[^.!?]+$/g)?.map((part) => part.trim()).filter(Boolean) ?? [];
  if (sentences.length <= 1) return splitWordsIntoChunks(normalized, targetWords);
  const units = [];
  let current = [];
  let currentWords = 0;
  for (const sentence of sentences) {
    const count = wordCount(sentence);
    if (count > targetWords) {
      if (current.length) {
        units.push(current.join(" "));
        current = [];
        currentWords = 0;
      }
      units.push(...splitWordsIntoChunks(sentence, targetWords));
      continue;
    }
    if (current.length && currentWords + count > targetWords) {
      units.push(current.join(" "));
      current = [];
      currentWords = 0;
    }
    current.push(sentence);
    currentWords += count;
  }
  if (current.length) units.push(current.join(" "));
  return units;
}

function scriptChunks(
  script,
  targetWords = Number(flags["semantic-chunk-words"] ?? 1000),
  overlapWords = Number(flags["semantic-overlap-words"] ?? 120),
) {
  const source = String(script ?? "");
  const tokens = [...source.matchAll(/\S+/g)].map((match, index) => ({
    index,
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
  if (!tokens.length) return [];
  const target = Math.max(100, Math.floor(targetWords));
  const overlap = Math.max(0, Math.min(target - 1, Math.floor(overlapWords)));
  const chunks = [];
  let startWord = 0;
  while (startWord < tokens.length) {
    const endWord = Math.min(tokens.length, startWord + target);
    const charStart = tokens[startWord].start;
    const charEnd = tokens[endWord - 1].end;
    chunks.push({
      text: source.slice(charStart, charEnd),
      words: endWord - startWord,
      word_start_index: startWord,
      word_end_index_exclusive: endWord,
      char_start: charStart,
      char_end: charEnd,
      overlap_words: chunks.length ? overlap : 0,
    });
    if (endWord >= tokens.length) break;
    startWord = endWord - overlap;
  }
  return chunks.map((chunk, index) => ({
    ...chunk,
    chunk_index: index + 1,
    chunk_count: chunks.length,
  }));
}

export function sanitizeCanonicalIdForTests(value, fallback = "id") {
  const sanitized = String(value ?? fallback)
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return sanitized || fallback;
}

function sanitizeCanonicalRows(rows, key) {
  const byId = new Map();
  for (const row of rows ?? []) {
    const id = sanitizeCanonicalIdForTests(row?.[key]);
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, { ...row, [key]: id });
      continue;
    }
    byId.set(id, {
      ...existing,
      aliases: [...new Set([...(existing.aliases ?? []), ...(row.aliases ?? [])])],
      evidence: [...new Map([...(existing.evidence ?? []), ...(row.evidence ?? [])]
        .map((item) => [JSON.stringify(item), item])).values()],
    });
  }
  return [...byId.values()];
}

function normalizeSemanticRefKind(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (normalized === "character") return "character_state";
  if (normalized === "effect") return "action";
  return normalized;
}

function normalizeScenes(scenes) {
  return scenes.map((scene, index) => ({
    ...scene,
    scene_id: `scene_${String(index + 1).padStart(3, "0")}`,
    location_id: scene.location_id ? sanitizeCanonicalIdForTests(scene.location_id) : scene.location_id,
    ref_requirements: (scene.ref_requirements ?? []).map((requirement) => ({
      ...requirement,
      ref_id: requirement?.ref_id ? sanitizeCanonicalIdForTests(requirement.ref_id) : requirement?.ref_id,
      kind: normalizeSemanticRefKind(requirement?.kind),
    })),
  }));
}

function commaSeparatedIds(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function applyManualLocationRefRepairsForTests(
  scenes,
  artifact,
  { sourceScriptHash = null, requestedSceneIds = [] } = {},
) {
  if (!artifact) return { scenes, applied_repairs: [] };
  if (artifact.schema !== "goldflow_semantic_manual_location_ref_repair_v1"
    || artifact.status !== "approved") {
    throw new Error("Manual semantic location-ref repair artifact is not approved or has an unsupported schema");
  }
  if (sourceScriptHash && artifact.source_script_hash !== sourceScriptHash) {
    throw new Error("Manual semantic location-ref repair artifact does not match the locked script hash");
  }
  const repairs = Array.isArray(artifact.repairs) ? artifact.repairs : [];
  if (!repairs.length) {
    throw new Error("Manual semantic location-ref repair artifact contains no repairs");
  }
  const repairIds = repairs.map((repair) => String(repair?.scene_id ?? "").trim());
  if (repairIds.some((sceneId) => !sceneId) || new Set(repairIds).size !== repairIds.length) {
    throw new Error("Manual semantic location-ref repairs require unique non-empty scene IDs");
  }
  const requestedIds = [...new Set(requestedSceneIds.map(String).filter(Boolean))];
  if (requestedIds.length) {
    const orderedRequested = scenes
      .map((scene) => String(scene?.scene_id ?? ""))
      .filter((sceneId) => requestedIds.includes(sceneId));
    const orderedRepairs = scenes
      .map((scene) => String(scene?.scene_id ?? ""))
      .filter((sceneId) => repairIds.includes(sceneId));
    if (orderedRequested.length !== requestedIds.length
      || JSON.stringify(orderedRequested) !== JSON.stringify(orderedRepairs)) {
      throw new Error(
        `Manual semantic repair scene scope ${JSON.stringify(orderedRepairs)} `
        + `does not match --scene-ids ${JSON.stringify(orderedRequested)}`,
      );
    }
  }
  const repairsById = new Map(repairs.map((repair) => [String(repair.scene_id), repair]));
  const sceneIds = new Set(scenes.map((scene) => String(scene?.scene_id ?? "")));
  const unknownIds = repairIds.filter((sceneId) => !sceneIds.has(sceneId));
  if (unknownIds.length) {
    throw new Error(`Manual semantic location-ref repairs name unknown scenes: ${unknownIds.join(", ")}`);
  }
  const appliedRepairs = [];
  const repairedScenes = scenes.map((scene) => {
    const sceneId = String(scene?.scene_id ?? "");
    const repair = repairsById.get(sceneId);
    if (!repair) return scene;
    const expectedLocation = String(repair.expected_location ?? "").trim();
    const actualLocation = String(scene.location ?? "").trim();
    if (!expectedLocation || expectedLocation !== actualLocation) {
      throw new Error(
        `Manual semantic location-ref repair for ${sceneId} expected location `
        + `${JSON.stringify(expectedLocation)} but current scene has ${JSON.stringify(actualLocation)}`,
      );
    }
    const existingLocationRefs = (scene.ref_requirements ?? []).filter(
      (requirement) => String(requirement?.kind ?? "").trim().toLowerCase() === "location",
    );
    if (existingLocationRefs.length) {
      throw new Error(`Manual semantic location-ref repair refuses to overwrite existing location scope for ${sceneId}`);
    }
    const requirement = repair.location_ref_requirement ?? {};
    const rawRefId = String(requirement.ref_id ?? "").trim();
    if (!rawRefId
      || sanitizeCanonicalIdForTests(rawRefId) !== rawRefId
      || String(requirement.kind ?? "").trim().toLowerCase() !== "location"
      || requirement.required !== true
      || !String(requirement.reason ?? "").trim()) {
      throw new Error(`Manual semantic location-ref repair for ${sceneId} has an invalid location requirement`);
    }
    const normalizedRequirement = {
      ...requirement,
      ref_id: rawRefId,
      kind: "location",
      required: true,
    };
    appliedRepairs.push({
      scene_id: sceneId,
      expected_location: expectedLocation,
      location_ref_requirement: normalizedRequirement,
    });
    return {
      ...scene,
      ref_requirements: [...(scene.ref_requirements ?? []), normalizedRequirement],
    };
  });
  return { scenes: repairedScenes, applied_repairs: appliedRepairs };
}

function exactJsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function applyManualSemanticRepairsForTests(
  scenes,
  ledger,
  artifact,
  {
    sourceScriptHash = null,
    baseReconciliationSha256 = null,
    requestedSceneIds = [],
  } = {},
) {
  if (!artifact) {
    return {
      scenes,
      ledger,
      applied_scene_updates: [],
      applied_scene_insertions: [],
      appended_state_transitions: [],
      appended_canonical_locations: [],
    };
  }
  if (artifact.schema !== "goldflow_semantic_manual_repair_v1"
    || artifact.status !== "approved") {
    throw new Error("Manual semantic repair artifact is not approved or has an unsupported schema");
  }
  if (sourceScriptHash && artifact.source_script_hash !== sourceScriptHash) {
    throw new Error("Manual semantic repair artifact does not match the locked script hash");
  }
  if (baseReconciliationSha256
    && artifact.base_reconciliation_sha256 !== baseReconciliationSha256) {
    throw new Error("Manual semantic repair artifact does not match the accepted reconciliation output hash");
  }
  const sceneUpdates = Array.isArray(artifact.scene_updates) ? artifact.scene_updates : [];
  const sceneInsertions = Array.isArray(artifact.scene_insertions) ? artifact.scene_insertions : [];
  const transitionAppends = Array.isArray(artifact.state_transition_appends)
    ? artifact.state_transition_appends
    : [];
  const canonicalLocationAppends = Array.isArray(artifact.canonical_location_appends)
    ? artifact.canonical_location_appends
    : [];
  if (!sceneUpdates.length && !sceneInsertions.length
    && !transitionAppends.length && !canonicalLocationAppends.length) {
    throw new Error("Manual semantic repair artifact contains no repair operations");
  }
  const sourceSceneIds = new Set(scenes.map((scene) => String(scene?.scene_id ?? "")));
  const updateIds = sceneUpdates.map((update) => String(update?.scene_id ?? "").trim());
  const insertionIds = sceneInsertions.map(
    (insertion) => String(insertion?.inserted_scene_id ?? insertion?.scene?.scene_id ?? "").trim(),
  );
  if (updateIds.some((sceneId) => !sceneId)
    || new Set(updateIds).size !== updateIds.length
    || insertionIds.some((sceneId) => !sceneId)
    || new Set(insertionIds).size !== insertionIds.length) {
    throw new Error("Manual semantic repair scene updates and insertions require unique non-empty IDs");
  }
  const unknownUpdateIds = updateIds.filter((sceneId) => !sourceSceneIds.has(sceneId));
  const unknownInsertionAnchors = sceneInsertions
    .map((insertion) => String(insertion?.after_scene_id ?? "").trim())
    .filter((sceneId) => !sourceSceneIds.has(sceneId));
  const duplicateInsertionIds = insertionIds.filter((sceneId) => sourceSceneIds.has(sceneId));
  if (unknownUpdateIds.length || unknownInsertionAnchors.length || duplicateInsertionIds.length) {
    throw new Error(
      "Manual semantic repair scene scope is invalid: "
      + JSON.stringify({ unknownUpdateIds, unknownInsertionAnchors, duplicateInsertionIds }),
    );
  }
  const impactedIds = new Set([
    ...updateIds,
    ...sceneInsertions.map((insertion) => String(insertion.after_scene_id)),
    ...transitionAppends.map((transition) => String(transition?.source_scene_id ?? "")).filter(Boolean),
  ]);
  const requestedIds = new Set(requestedSceneIds.map(String).filter(Boolean));
  if (!requestedIds.size) {
    throw new Error("Manual semantic repair requires exact --scene-ids scope");
  }
  if (!exactJsonEqual([...requestedIds].sort(), [...impactedIds].sort())) {
    throw new Error(
      `Manual semantic repair scope ${JSON.stringify([...impactedIds].sort())} `
      + `does not match --scene-ids ${JSON.stringify([...requestedIds].sort())}`,
    );
  }
  const allowedSetFields = new Set([
    "title",
    "script_excerpt_start",
    "script_excerpt_end",
    "location",
    "visible_subjects",
    "primary_subject",
    "visual_intent",
    "ui_text_on_screen",
    "sfx_cues",
    "character_states",
    "wardrobe",
    "props",
    "ref_requirements",
    "action_staging",
    "continuity_notes",
  ]);
  const updatesById = new Map(sceneUpdates.map((update) => [String(update.scene_id), update]));
  const insertionsByAnchor = new Map();
  for (const insertion of sceneInsertions) {
    const anchorId = String(insertion.after_scene_id);
    const rows = insertionsByAnchor.get(anchorId) ?? [];
    rows.push(insertion);
    insertionsByAnchor.set(anchorId, rows);
  }
  const appliedSceneUpdates = [];
  const appliedSceneInsertions = [];
  const repairedScenes = [];
  for (const scene of scenes) {
    const sceneId = String(scene?.scene_id ?? "");
    const update = updatesById.get(sceneId);
    let nextScene = scene;
    if (update) {
      const expected = update.expected ?? {};
      for (const [field, expectedValue] of Object.entries(expected)) {
        if (!exactJsonEqual(scene[field], expectedValue)) {
          throw new Error(
            `Manual semantic repair for ${sceneId} expected ${field} `
            + `${JSON.stringify(expectedValue)} but found ${JSON.stringify(scene[field])}`,
          );
        }
      }
      const setFields = update.set ?? {};
      const unsupportedFields = Object.keys(setFields).filter((field) => !allowedSetFields.has(field));
      if (unsupportedFields.length) {
        throw new Error(
          `Manual semantic repair for ${sceneId} attempts unsupported fields: ${unsupportedFields.join(", ")}`,
        );
      }
      nextScene = { ...scene, ...setFields };
      appliedSceneUpdates.push({
        scene_id: sceneId,
        expected,
        set: setFields,
      });
    }
    repairedScenes.push(nextScene);
    for (const insertion of insertionsByAnchor.get(sceneId) ?? []) {
      const insertedSceneId = String(
        insertion.inserted_scene_id ?? insertion.scene?.scene_id ?? "",
      );
      const insertedScene = {
        ...(insertion.scene ?? {}),
        scene_id: insertedSceneId,
      };
      repairedScenes.push(insertedScene);
      appliedSceneInsertions.push({
        after_scene_id: sceneId,
        inserted_scene_id: insertedSceneId,
      });
    }
  }
  const repairedSceneIds = repairedScenes.map((scene) => String(scene?.scene_id ?? ""));
  if (repairedSceneIds.some((sceneId) => !sceneId)
    || new Set(repairedSceneIds).size !== repairedSceneIds.length) {
    throw new Error("Manual semantic repair produced missing or duplicate scene IDs");
  }
  const canonicalLocations = sanitizeCanonicalRows([
    ...(ledger.canonical_locations ?? []),
    ...canonicalLocationAppends,
  ], "location_id");
  const existingTransitionKeys = new Set((ledger.state_transitions ?? []).map(
    (transition) => [
      transition.entity_id,
      transition.state_kind,
      transition.transition_evidence_excerpt,
    ].join("\u001f"),
  ));
  const appendedTransitions = transitionAppends.map((transition) => {
    const { source_scene_id: _sourceSceneId, ...row } = transition;
    const key = [row.entity_id, row.state_kind, row.transition_evidence_excerpt].join("\u001f");
    if (existingTransitionKeys.has(key)) {
      throw new Error(`Manual semantic repair duplicates state transition evidence: ${row.transition_evidence_excerpt}`);
    }
    existingTransitionKeys.add(key);
    return row;
  });
  return {
    scenes: repairedScenes,
    ledger: {
      ...ledger,
      canonical_locations: canonicalLocations,
      state_transitions: [
        ...(ledger.state_transitions ?? []),
        ...appendedTransitions,
      ],
    },
    applied_scene_updates: appliedSceneUpdates,
    applied_scene_insertions: appliedSceneInsertions,
    appended_state_transitions: appendedTransitions,
    appended_canonical_locations: canonicalLocationAppends,
  };
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function semanticSceneAnchorFindingsForTests(scenes, script) {
  return semanticSceneAnchorFindings(scenes, script);
}

export function semanticSceneQualityFindingsForTests(scenes) {
  return semanticSceneQualityFindings(scenes);
}

export function semanticBuildPromptForTests(script, bibles, targets, chunk = null) {
  return buildPrompt(script, bibles, targets, chunk);
}

export function semanticScriptChunksForTests(script, targetWords = 1000) {
  return scriptChunks(script, targetWords);
}

function scriptTokenIndex(script) {
  const rows = [];
  const pattern = /[\p{L}\p{N}]+/gu;
  for (const match of String(script ?? "").matchAll(pattern)) {
    rows.push({
      value: match[0].toLowerCase(),
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    });
  }
  return rows;
}

function anchorTokens(anchor) {
  return [...String(anchor ?? "").matchAll(/[\p{L}\p{N}]+/gu)].map((match) => match[0].toLowerCase());
}

function findTokenSequence(tokens, sequence, charFrom) {
  if (!sequence.length) return null;
  for (let index = 0; index <= tokens.length - sequence.length; index += 1) {
    if (tokens[index].start < charFrom) continue;
    let matches = true;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (tokens[index + offset].value !== sequence[offset]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    return {
      start: tokens[index].start,
      end: tokens[index + sequence.length - 1].end,
      matched_token_count: sequence.length,
    };
  }
  return null;
}

function findAnchorTokenMatch(anchor, tokens, charFrom) {
  const sequence = anchorTokens(anchor);
  if (!sequence.length) return null;
  const exact = findTokenSequence(tokens, sequence, charFrom);
  if (exact) return { ...exact, original_token_count: sequence.length, snap_type: "token_sequence" };
  for (let length = sequence.length - 1; length >= 1; length -= 1) {
    const suffix = sequence.slice(sequence.length - length);
    if (suffix.join("").length < 5) continue;
    const match = findTokenSequence(tokens, suffix, charFrom);
    if (match) return { ...match, original_token_count: sequence.length, snap_type: "token_suffix" };
  }
  return null;
}

function snapSemanticSceneAnchors(scenes, script) {
  const tokens = scriptTokenIndex(script);
  const snaps = [];
  let previousStart = 0;
  const snappedScenes = scenes.map((scene) => {
    const next = { ...scene };
    const sceneId = String(scene?.scene_id ?? "");
    for (const field of ["script_excerpt_start", "script_excerpt_end"]) {
      const searchFrom = field === "script_excerpt_start" ? previousStart : previousStart;
      const original = normalizeText(next[field]);
      const match = findAnchorTokenMatch(original, tokens, searchFrom);
      if (!match) continue;
      const exact = script.slice(match.start, match.end);
      if (field === "script_excerpt_start") previousStart = match.start;
      if (exact && exact !== next[field]) {
        next[field] = exact;
        snaps.push({
          scene_id: sceneId,
          field,
          snap_type: match.snap_type,
          matched_token_count: match.matched_token_count,
          original_token_count: match.original_token_count,
          original_anchor: original.slice(0, 180),
          snapped_anchor: exact.slice(0, 180),
        });
      }
    }
    return next;
  });
  return { scenes: snappedScenes, snaps };
}

export function semanticSnapSceneAnchorsForTests(scenes, script) {
  return snapSemanticSceneAnchors(scenes, script);
}

function semanticSceneAnchorFindings(scenes, script) {
  const scriptText = normalizeText(script);
  const findings = [];
  let cursor = 0;
  let previousStart = -1;
  for (const scene of scenes) {
    const sceneId = String(scene?.scene_id ?? "");
    const title = String(scene?.title ?? "");
    const startAnchor = normalizeText(scene?.script_excerpt_start);
    const endAnchor = normalizeText(scene?.script_excerpt_end);
    let startIndex = startAnchor ? scriptText.indexOf(startAnchor, cursor) : -1;
    if (startIndex < 0 && previousStart >= 0) {
      const orderedFallbackIndex = scriptText.indexOf(startAnchor, previousStart + 1);
      if (orderedFallbackIndex >= 0) {
        startIndex = orderedFallbackIndex;
        findings.push({ severity: "warning", code: "semantic_start_anchor_ordered_fallback", scene_id: sceneId, title, anchor: startAnchor.slice(0, 180), message: "script_excerpt_start was found after the previous scene start but before the previous end cursor; this usually means an earlier end anchor was too common." });
      }
    }
    const endSearchIndex = startIndex >= 0 ? startIndex : cursor;
    const endIndex = endAnchor ? scriptText.indexOf(endAnchor, endSearchIndex) : -1;
    if (!startAnchor) {
      findings.push({ severity: "blocker", code: "semantic_missing_start_anchor", scene_id: sceneId, title, message: "script_excerpt_start is empty." });
    } else if (startIndex < 0) {
      findings.push({ severity: "blocker", code: "semantic_start_anchor_not_found", scene_id: sceneId, title, anchor: startAnchor.slice(0, 180), message: "script_excerpt_start is not found in locked script at or after the previous scene." });
    }
    if (!endAnchor) {
      findings.push({ severity: "blocker", code: "semantic_missing_end_anchor", scene_id: sceneId, title, message: "script_excerpt_end is empty." });
    } else if (endIndex < 0) {
      findings.push({ severity: "blocker", code: "semantic_end_anchor_not_found", scene_id: sceneId, title, anchor: endAnchor.slice(0, 180), message: "script_excerpt_end is not found in locked script at or after this scene start." });
    }
    if (startIndex >= 0 && previousStart >= 0 && startIndex < previousStart) {
      findings.push({ severity: "blocker", code: "semantic_anchor_order_regression", scene_id: sceneId, title, message: "script_excerpt_start appears before the previous accepted scene start." });
    }
    if (startIndex >= 0 && endIndex >= 0 && endIndex < startIndex) {
      findings.push({ severity: "blocker", code: "semantic_end_before_start", scene_id: sceneId, title, message: "script_excerpt_end appears before script_excerpt_start." });
    }
    if (startIndex >= 0) previousStart = startIndex;
    if (endIndex >= 0) cursor = Math.max(cursor, endIndex);
    else if (startIndex >= 0) cursor = Math.max(cursor, startIndex);
  }
  return findings;
}

export function semanticSceneCoverageFindingsForTests(scenes, script, maxSceneSpanWords = 1600) {
  const scriptText = normalizeText(script);
  const findings = [];
  const starts = [];
  const ends = [];
  let cursor = 0;
  for (const scene of scenes ?? []) {
    const startAnchor = normalizeText(scene?.script_excerpt_start);
    const endAnchor = normalizeText(scene?.script_excerpt_end);
    const startIndex = startAnchor ? scriptText.indexOf(startAnchor, cursor) : -1;
    const endIndex = startIndex >= 0 && endAnchor
      ? scriptText.indexOf(endAnchor, startIndex)
      : -1;
    starts.push(startIndex);
    ends.push(endIndex);
    if (startIndex >= 0) cursor = startIndex + Math.max(1, startAnchor.length);
  }
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    if (start < 0) continue;
    const next = starts[index + 1] >= 0 ? starts[index + 1] : scriptText.length;
    const spanWords = scriptText.slice(start, next).split(/\s+/).filter(Boolean).length;
    if (spanWords > maxSceneSpanWords) {
      findings.push({
        severity: "warning",
        code: "semantic_scene_span_too_large",
        scene_id: String(scenes[index]?.scene_id ?? ""),
        title: String(scenes[index]?.title ?? ""),
        span_words: spanWords,
        max_scene_span_words: maxSceneSpanWords,
        message: "A reconciled semantic scene spans too much locked narration and must be split using the existing chunk extractions.",
      });
    }
    if (index < starts.length - 1 && ends[index] >= 0 && starts[index + 1] >= 0) {
      const endAnchor = normalizeText(scenes[index]?.script_excerpt_end);
      const uncoveredText = scriptText.slice(ends[index] + endAnchor.length, starts[index + 1]);
      const uncoveredWords = anchorTokens(uncoveredText).length;
      if (uncoveredWords > 0) {
        findings.push({
          severity: "blocker",
          code: "semantic_scene_gap_uncovered_words",
          scene_id: String(scenes[index]?.scene_id ?? ""),
          next_scene_id: String(scenes[index + 1]?.scene_id ?? ""),
          uncovered_word_count: uncoveredWords,
          uncovered_excerpt: uncoveredText.slice(0, 240),
          message: "Narration words fall after this scene's end anchor and before the next scene's start anchor.",
        });
      }
    }
  }
  const lastScene = scenes?.at?.(-1);
  const lastEnd = normalizeText(lastScene?.script_excerpt_end);
  if (lastScene && lastEnd) {
    const lastEndIndex = scriptText.lastIndexOf(lastEnd);
    const trailingWords = lastEndIndex < 0
      ? Number.POSITIVE_INFINITY
      : scriptText.slice(lastEndIndex + lastEnd.length).split(/\s+/).filter(Boolean).length;
    if (trailingWords > 24) {
      findings.push({
        severity: "warning",
        code: "semantic_final_scene_does_not_cover_script_end",
        scene_id: String(lastScene.scene_id ?? ""),
        trailing_words: trailingWords,
        message: "The final semantic scene end anchor leaves locked narration uncovered.",
      });
    }
  }
  return findings;
}

function countByCode(findings) {
  const counts = {};
  for (const finding of findings) {
    const code = String(finding.code ?? "unknown");
    counts[code] = (counts[code] ?? 0) + 1;
  }
  return counts;
}

function semanticSceneQualityFindings(scenes) {
  const findings = [];
  const mixedLocationPattern = /\b(?:split|montage|then|while|plus|multiple|various|moving between|connected to|transitioning to|and later|screen|dashboard|phone|message view|overlay|system interface|document|publication screens|recorded clip|proposal screen)\b|\/|;/i;
  const propLocationPattern = /\b(?:room|corridor|hallway|hall|lobby|tower|office|desk area|entrance|elevator|warehouse|street|station|shop|library|apartment|conference|court|stage|theater|bookstore|district|square|gate|screen|dashboard|web page|feed|furniture|doors?|windows?|walls?|lighting)\b/i;
  const genericSubjectPattern = /\b(?:employees?|crowd|audience|watchers?|customers?|staff|workers?|passengers?|commuters?|students?|tenants?|people|reporters?|press|bystanders?|security guards?|online public)\b/i;
  const editorialMetaPattern = /\b(?:hook|viewer|retention|thumbnail|youtube|chapter|recap|narrator|audience should|keep watching|ctr)\b/i;
  const characterNames = [];

  for (const scene of scenes) {
    const sceneId = String(scene?.scene_id ?? "");
    const title = String(scene?.title ?? "");
    const location = normalizeText(scene?.location);
    const locationRefRequirements = Array.isArray(scene?.ref_requirements)
      ? scene.ref_requirements.filter((requirement) => String(requirement?.kind ?? "").trim().toLowerCase() === "location")
      : [];
    const supportedRefKinds = new Set(["location", "character_state", "prop", "ui", "action"]);
    for (const requirement of scene?.ref_requirements ?? []) {
      const kind = String(requirement?.kind ?? "").trim().toLowerCase();
      if (kind && !supportedRefKinds.has(kind)) {
        findings.push({
          severity: "blocker",
          code: "semantic_ref_requirement_kind_unsupported",
          scene_id: sceneId,
          title,
          ref_id: String(requirement?.ref_id ?? ""),
          kind,
          message: "Semantic ref requirements must use a downstream-supported reference kind.",
        });
      }
    }
    if (location && mixedLocationPattern.test(location)) {
      findings.push({
        severity: "warning",
        code: "semantic_mixed_location_contract",
        scene_id: sceneId,
        title,
        value: location,
        message: "Location appears to mix multiple places, UI, overlays, screens, or montage language instead of one visible physical environment.",
      });
    }
    if (location && !/^(?:none|unknown|n\/a|na|abstract|unspecified)$/i.test(location) && !locationRefRequirements.length) {
      findings.push({
        severity: "warning",
        code: "semantic_physical_scene_missing_location_ref_requirement",
        scene_id: sceneId,
        title,
        location,
        message: "This physical scene has textual location truth but no separate location ref_requirement. The location contract remains usable; add a location reference candidate only when reusable visual conditioning would improve consistency.",
      });
    }
    for (const subject of scene?.visible_subjects ?? []) {
      const value = normalizeText(subject);
      if (value) characterNames.push({ scene_id: sceneId, value });
      if (genericSubjectPattern.test(value)) {
        findings.push({
          severity: "warning",
          code: "semantic_generic_visible_subject",
          scene_id: sceneId,
          title,
          value,
          message: "Generic groups should only be visible subjects when the beat needs public witnesses or readable group reaction.",
        });
      }
    }
    for (const state of scene?.character_states ?? []) {
      const value = normalizeText(state?.character);
      if (value) characterNames.push({ scene_id: sceneId, value });
    }
    for (const prop of scene?.props ?? []) {
      const value = normalizeText(prop);
      if (propLocationPattern.test(value)) {
        findings.push({
          severity: "warning",
          code: "semantic_prop_location_or_ui_bleed",
          scene_id: sceneId,
          title,
          value,
          message: "Props should be tangible foreground objects, not rooms, surfaces, architecture, screens, dashboards, feeds, or location nouns.",
        });
      }
    }
    for (const text of scene?.ui_text_on_screen ?? []) {
      const value = normalizeText(text);
      if (value.length > 90 || value.split(/\s+/).length > 12) {
        findings.push({
          severity: "warning",
          code: "semantic_dense_ui_text",
          scene_id: sceneId,
          title,
          value: value.slice(0, 180),
          message: "UI text is dense enough that image prompts should use concise labels or render-layer overlays instead of asking imagegen to draw it.",
        });
      }
    }
    for (const [field, values] of [
      ["title", [scene?.title]],
      ["visual_intent", [scene?.visual_intent]],
      ["action_staging", [scene?.action_staging]],
      ["continuity_notes", scene?.continuity_notes ?? []],
    ]) {
      for (const raw of values) {
        const value = normalizeText(raw);
        if (value && editorialMetaPattern.test(value)) {
          findings.push({
            severity: "warning",
            code: "semantic_editorial_meta_language",
            scene_id: sceneId,
            title,
            field,
            value: value.slice(0, 180),
            message: "Semantic fields should describe story facts, not packaging or editor/audience intent.",
          });
        }
      }
    }
  }

  const namesByFirstToken = new Map();
  for (const item of characterNames) {
    const parts = item.value.split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    const first = parts[0].toLowerCase();
    if (!namesByFirstToken.has(first)) namesByFirstToken.set(first, new Map());
    const byName = namesByFirstToken.get(first);
    if (!byName.has(item.value)) byName.set(item.value, new Set());
    byName.get(item.value).add(item.scene_id);
  }
  for (const [first, byName] of namesByFirstToken) {
    const names = [...byName.keys()];
    const hasSingle = names.some((name) => name.toLowerCase() === first);
    const multiword = names.filter((name) => name.includes(" "));
    if (hasSingle && multiword.length) {
      findings.push({
        severity: "warning",
        code: "semantic_character_alias_churn",
        character_family: first,
        names,
        scene_ids: [...new Set(names.flatMap((name) => [...byName.get(name)]))].sort(),
        message: "The plan alternates between a bare first name and full canonical name; this can split identity refs downstream.",
      });
    }
  }

  return findings;
}

function buildPrompt(script, bibles, targets, chunk = null) {
  const scopeLine = chunk
    ? `This is chunk ${chunk.chunk_index} of ${chunk.chunk_count} from the locked script. Extract semantic scenes only for this chunk, preserving local order.`
    : "Extract a semantic scene plan from the locked narration script.";
  const bibleLimit = chunk ? Number(flags["semantic-chunk-bible-chars"] ?? 8000) : 30_000;
  const plannerDirective = contentProfilePlannerDirective(activeContentProfile);
  return `Extract a semantic scene plan from the locked narration script.
${scopeLine}

CONTENT PROFILE: ${activeContentProfile.id}
${plannerDirective || "- Preserve the exact visible story truth without inventing facts."}

Rules:
- Use only the locked script and bibles below.
- Do not use source-seed annotations or stale scene artifacts.
- Do not rewrite the script.
- Scene boundaries should support visual planning, SFX planning, and continuity.
- No timestamps. This is semantic only.
- This script is ${targets.words} words. Return about ${targets.target} scenes.
- Hard scene-count range: minimum ${targets.minimum}, maximum ${targets.maximum}.
- Do not collapse acts, montages, flashbacks, locations, or major emotional beats into broad summaries.
- Prefer visual-production units of roughly 120-260 spoken words each; shorter is fine for fast action, reveals, UI inserts, or emotional turns.
- Include production facts needed by visual prompts: location, visible_subjects, primary_subject, visual_intent, ui_text_on_screen, sfx_cues, character_states, wardrobe, props, ref_requirements, action_staging.
- visible_subjects includes every identity-bearing physical actor the camera may need to preserve: people, named or distinct creatures, bosses, guardians, constructs, summons, and recurring creature systems. An actor that moves, attacks, reacts, is fought, or is physically contacted is an entity, not a prop. Props are inert objects.
- Keep character state layers separate. visible_state is for physical facts the camera can see: wet hair, torn sleeve, black suit, bandaged hand, posture, expression, age presentation, cleanliness, injury, body shape, grooming, and wardrobe condition. emotional_state, financial_state, and social_state are narrative/status facts; they should not be treated as costume or body damage unless the locked script explicitly says the character is dirty, ragged, injured, homeless, sick, or wearing damaged clothes.
- When a character is socially, financially, or emotionally ruined, express that in semantic context without inventing visible grime. Use props, posture, expression, staging, witnesses, receipts, phones, screens, isolation, or power dynamics to make it visual. Do not convert abstract phrases like broke, ruined, betrayed, humiliated, indebted, or emotionally collapsed into filthy/ragged clothing, wounds, dumpster-like styling, or homelessness unless those physical details are explicitly in the script.
- Resolve role/title aliases to canonical named characters when the script establishes that relationship. If a named person is introduced as the dean, boss, chairman, judge, professor, host, rival, spouse, parent, or another title, later role-only mentions such as "the dean" or "the judge" should refer to that named person instead of creating a new generic character. In visible_subjects and character_states, use the named character and put the role in their state, for example "Kai Cenat, acting as dean and final judge." Only create a separate role character when the script clearly introduces a different person.
- Use one canonical display name for each named person after the script establishes it. Do not alternate between a first name and a full name for the same character in visible_subjects, character_states, or character ref IDs; keep role/title aliases in the state or continuity notes.
- Treat location as one visible physical environment for this scene, not merely the parent venue name and not a mixture of UI, overlays, phone views, document views, remote call locations, or montage destinations. If a passage moves through several physical environments, split it into separate semantic scenes whenever possible. If the passage is a communication or montage beat that cannot be split cleanly, set location to the camera's primary physical environment and describe remote/on-screen material in ui_text_on_screen, action_staging, or continuity_notes.
- If a story arc stays inside one larger venue but moves through distinct visible areas, give each scene the specific area name. When reusable conditioning would help, propose separate location refs for genuinely distinct areas instead of one broad venue ref.
- visible_subjects means physically visible named people or people visibly shown through a specific screen/broadcast/replay that the scene will depict. Put remote callers, online commenters, text-message senders, and remembered people in ui_text_on_screen, action_staging, or continuity_notes unless the current visual should literally show them on a device or screen. Anonymous groups are neither a default nor forbidden: include workers, audience, employees, reporters, customers, guards, or similar groups when explicitly named or when a concrete active social situation logically needs them to read correctly, such as a hearing, ceremony, class in session, active market, public humiliation, audience reaction, staffed workplace, or assembled formation. A merely public location is insufficient; private, lonely, abandoned, isolated, after-hours, and object/UI-only scenes remain unpopulated unless the script says otherwise.
- props means tangible foreground objects the camera should show. Do not put rooms, doors, windows, desks, walls, stages, screens, dashboards, webpages, feeds, architecture, lighting, or whole locations in props. Put architecture and surfaces in location/action_staging, and put screens/dashboards/feeds in ui_text_on_screen or action_staging.
- ui_text_on_screen should be concise image/render guidance: short system labels, numbers, chat snippets, document titles, or key words. Do not dump long multi-line system messages, documents, article text, captions, or dense lists into imagegen text. Summarize dense UI as a visual motif here and leave exact long wording to narration/subtitles or render-layer overlays.
- Textual scene locations are the source of physical truth and feed location contracts. Optional location ref_requirements are reusable-conditioning candidates; when proposed, use stable, specific snake_case IDs for the visible area.
- For a concrete physical location, propose a stable kind "location" ref_requirement only when a reusable visual-conditioning image would materially improve consistency. The scene's textual location remains authoritative, and omitting an image candidate is advisory rather than blocking.
- Semantic ref_requirements are scoped target suggestions, not automatic standalone image-generation orders. Include refs for canonical recurring characters, named or distinct recurring nonhuman actors, signature bosses/guardians/constructs with unusual anatomy, major visible states, distinct visible physical locations, signature recurring UI motifs, critical props, and high-risk one-scene close-contact actors. Use kind "character" for identity-bearing human or nonhuman actors so downstream reference planning can preserve their identity and anatomy. Do not create semantic refs for generic background groups, throwaway one-scene UI text, ordinary desks/doors/screens, or props that can be safely derived from the scene image.
- Avoid editorial/package words in semantic fields, such as hook, retention, thumbnail, CTR, narrator, recap, or what the viewer should feel. Describe the story fact visible in the scene.
- script_excerpt_start and script_excerpt_end must be exact words copied from this script text so Whisper timing can bind them later. Use short verbatim spans from the actual first and final sentence of the scene; do not summarize, paraphrase, remove clauses, or change quotation marks.

BIBLES:
${JSON.stringify(bibles, null, 2).slice(0, bibleLimit)}

SCRIPT:
${script}

Return one valid JSON object:
{
  "episode_summary": "...",
  "global_reference_requirements": [
    {"ref_id":"style_ref","kind":"style","description":"...","required":true}
  ],
  "scenes": [
    {
      "scene_id": "scene_001",
      "title": "...",
      "script_excerpt_start": "exact words from the first sentence of this scene",
      "script_excerpt_end": "exact words from the final sentence of this scene",
      "location": "...",
      "time": "...",
      "visible_subjects": ["..."],
      "primary_subject": "...",
      "visual_intent": "...",
      "ui_text_on_screen": ["..."],
      "sfx_cues": ["..."],
      "character_states": [{"character":"...","state":"...","visible_state":"camera-visible body, grooming, wardrobe, cleanliness, posture, expression, and injury facts only","emotional_state":"...","financial_state":"...","social_state":"...","wardrobe":"..."}],
      "props": ["..."],
      "ref_requirements": [{"ref_id":"specific_visible_area_location_ref","kind":"location","required":true,"reason":"optional reusable visual-conditioning candidate for this concrete physical scene"}, {"ref_id":"...","kind":"character|prop|ui|style","required":true,"reason":"character covers identity-bearing people, creatures, bosses, guardians, constructs, and summons"}],
      "action_staging": "...",
      "continuity_notes": ["..."]
    }
  ],
  "warnings": []
}`;
}

async function callLocal(prompt, stageName, maxTokens = null) {
  const attempts = 1;
  let lastError = null;
  let lastContent = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const retryPrompt = attempt === 1
      ? prompt
      : `${prompt}\n\nYour previous response was invalid JSON. Return one complete JSON object only. Escape all quotation marks inside string values. Do not include markdown fences, commentary, trailing commas, or partial objects.`;
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
              "semantic",
              "production semantic planner for longform narration",
            )}.`,
          },
          { role: "user", content: retryPrompt },
        ],
        temperature: attempt === 1 ? Number(flags["llm-temperature"] ?? 0.15) : 0,
        max_tokens: Number(maxTokens ?? flags["llm-max-tokens"] ?? 18000),
      }),
      signal: AbortSignal.timeout(Number(process.env.ANIFACTORY_SEMANTIC_PLAN_TIMEOUT_MS ?? 1_200_000)),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`local-qwen semantic plan HTTP ${response.status}: ${raw.slice(0, 1000)}`);
    const content = JSON.parse(raw)?.choices?.[0]?.message?.content ?? raw;
    lastContent = content;
    try {
      const extracted = parseJsonObjectFromPlannerOutput(content);
      return {
        provider: "local-qwen",
        model: getLLMModel(stageName),
        content,
        parsed: extracted.value,
        json_syntax_repair: extracted.syntax_repair,
        json_attempt: attempt,
      };
    } catch (error) {
      lastError = error;
      console.error(`semantic ${stageName}: invalid JSON attempt ${attempt}/${attempts}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const error = new Error(`local-qwen semantic plan returned invalid JSON after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}; content preview: ${lastContent.slice(0, 600)}`);
  error.llm_failure_packet = {
    provider: "local-qwen",
    model: getLLMModel(stageName),
    content: lastContent,
    parsed: null,
  };
  throw error;
}

async function callCodex(prompt, stageName) {
  const callDir = path.join(weekDir, "_codex_calls");
  await fs.mkdir(callDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = path.join(callDir, `${stamp}-${stageName}-output.txt`);
  const call = await runCodexCli({
    prompt,
    stageName,
    repoRoot,
    outputPath,
    model: flags.model ?? flags["llm-model"] ?? null,
    reasoningEffort: semanticReasoningEffortForStage(stageName, flags),
    timeoutMs: Number(process.env.ANIFACTORY_SEMANTIC_PLAN_TIMEOUT_MS ?? 1_200_000),
  });
  let extracted;
  try {
    extracted = parseJsonObjectFromPlannerOutput(call.content);
  } catch (error) {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    wrapped.llm_failure_packet = {
      provider: call.provider ?? "codex_cli",
      model: call.model,
      reasoning_effort: call.reasoning_effort,
      codex_cli_path: call.codex_cli_path,
      codex_cli_version: call.codex_cli_version,
      output_path: outputPath,
      content: call.content,
      parsed: null,
    };
    throw wrapped;
  }
  return {
    provider: call.provider ?? "codex_cli",
    model: call.model,
    reasoning_effort: call.reasoning_effort,
    codex_cli_path: call.codex_cli_path,
    codex_cli_version: call.codex_cli_version,
    output_path: outputPath,
    content: call.content,
    parsed: extracted.value,
    json_syntax_repair: extracted.syntax_repair,
  };
}

async function reusableCodexCall(stageName, prompt, validateParsed = null) {
  if (!semanticCodexCacheEnabled(flags)) return null;
  const callDir = path.join(weekDir, "_codex_calls");
  let files = [];
  try {
    files = await fs.readdir(callDir);
  } catch {
    return null;
  }
  const reusableStageNames = semanticReusableStageNamesForTests(stageName);
  const suffixes = reusableStageNames.map((candidateStageName) => `-${candidateStageName}-output.txt`);
  const candidates = files.filter((file) => suffixes.some((suffix) => file.endsWith(suffix))).sort().reverse();
  for (const latest of candidates) {
    const outputPath = path.join(callDir, latest);
    const metadata = await readCodexCallMetadata(outputPath);
    if (!isCodexCacheCompatible(metadata, {
      model: flags.model ?? flags["llm-model"] ?? null,
      reasoningEffort: semanticReasoningEffortForStage(stageName, flags),
      promptHash: sha256(prompt),
      stageName,
    })) continue;
    const content = await fs.readFile(outputPath, "utf8");
    let extracted;
    try {
      extracted = parseJsonObjectFromPlannerOutput(content);
    } catch {
      continue;
    }
    if (validateParsed && !validateParsed(extracted.value)) continue;
    return {
      provider: `${metadata.provider ?? "codex_cli"}_cache`,
      model: metadata.model,
      reasoning_effort: metadata.reasoning_effort,
      codex_cli_path: metadata.codex_cli_path,
      codex_cli_version: metadata.codex_cli_version,
      output_path: outputPath,
      content,
      parsed: extracted.value,
      json_syntax_repair: extracted.syntax_repair,
      reused_output: true,
    };
  }
  return null;
}

export function semanticReusableStageNamesForTests(stageName) {
  const requested = String(stageName ?? "").trim();
  if (!requested) return [];
  const baseStage = requested.replace(/_exact_repair$/, "");
  return [...new Set([requested, baseStage])];
}

function semanticCodexCacheEnabled(inputFlags = {}) {
  return inputFlags["reuse-codex-calls"] !== "false";
}

export function semanticCodexCacheEnabledForTests(inputFlags = {}) {
  return semanticCodexCacheEnabled(inputFlags);
}

async function runPool(items, worker, concurrency = 4) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runWorker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, runWorker));
  return results;
}

function buildReconciliationPrompt(script, bibles, extractedChunks, targets) {
  const chunkPacket = extractedChunks.map((item) => ({
    chunk_index: item.chunk.chunk_index,
    word_start_index: item.chunk.word_start_index,
    word_end_index_exclusive: item.chunk.word_end_index_exclusive,
    overlap_words: item.chunk.overlap_words,
    extracted: item.llm.parsed,
  }));
  const serializedChunkPacket = JSON.stringify(chunkPacket);
  const lockedScriptPacket = script.length + serializedChunkPacket.length > 900_000
    ? `[LOCKED SCRIPT OMITTED FROM THIS OVERSIZED RECONCILIATION PACKET. SHA-256: ${sha256(script)}. Use only verbatim evidence already present in OVERLAPPING EXTRACTIONS. Deterministic validation will check every returned excerpt against the full locked script.]`
    : script;
  return `Reconcile overlapping semantic extractions into one factual continuity plan and one story fact ledger.

Your job is evidence reconciliation, not story invention and not visual art direction.

Hard rules:
- The locked script is the only source of story facts. Bibles may resolve established identity/style naming but may not add events.
- Merge aliases into one canonical entity when the script proves they are the same person. Keep distinct people distinct.
- Canonical entities are identity-bearing actors, not only people. Include named or distinct creatures, bosses, guardians, constructs, summons, and recurring creature systems when they move, attack, react, are fought, or are physically contacted. Never demote an acting entity to canonical_props merely because it is nonhuman.
- Give every recurring or signature nonhuman actor one canonical entity with all evidence-backed aliases. Preserve unusual anatomy as entity identity/state evidence so downstream prompts can repeat one stable construction across cuts.
- Canonicalize physical locations, props, recurring UI motifs, and character state transitions across chunk boundaries.
- Merge every evidence-backed alternate name or short descriptive label for the same recurring location, prop, or UI motif into that canonical row's aliases array. Do not split one recurring object or interface into separate rows merely because the script calls it by different names.
- Overlapping chunks intentionally repeat evidence. Deduplicate repeated scenes and facts without deleting story coverage.
- Preserve the useful scene granularity already present in the chunk extractions. Never collapse several adjacent extraction chunks into one catch-all scene. No reconciled scene may span more than 1,600 locked-script words; split broad arcs at the supplied exact chunk anchors.
- The first scene must begin near the beginning of the locked script and the final scene must end on the locked script's actual final narration. Short or repeated anchors such as "yes" must be resolved by ordered script position, not by the first matching occurrence.
- Preserve scene order and exact script anchors. Return ${targets.minimum}-${targets.maximum} scenes, aiming for ${targets.target}.
- Every canonical fact row and every state transition must contain at least one evidence row with exact_excerpt copied verbatim from the locked script and confidence from 0 to 1.
- Every state transition must also set transition_evidence_excerpt to the one exact evidence excerpt where to_state first becomes true. Earlier from-state evidence may remain in evidence, but it is not the transition boundary.
- Evidence excerpts must be short enough to audit but long enough to prove the fact. Never paraphrase evidence.
- A fact without exact evidence must be omitted or placed in warnings as unresolved.
- Do not manufacture costume damage, injury, grime, wealth, location, relationships, props, UI, or physical presence from emotional/social language.
- Use injury for body injury or physical entrapment, possession for held objects, location for movement, wardrobe for clothing, and status for social/system role. Do not duplicate a physical condition as a generic status transition.
- Temporary states need their later exact closure transition when the script reverses them; a trapped, armed, transformed, or role-assigned state must not remain active after explicit release, loss, reversion, or replacement evidence.
- Preserve the semantic scene schema and textual location truth from the extracted rows. Preserve any evidence-backed location ref_requirements that were proposed, but do not invent one merely to satisfy a quota.

BIBLES:
${JSON.stringify(bibles).slice(0, 20_000)}

LOCKED SCRIPT:
${lockedScriptPacket}

OVERLAPPING EXTRACTIONS:
${serializedChunkPacket}

Return one JSON object only:
{
  "episode_summary": "factual summary",
  "canonical_entities": [{"entity_id":"snake_case","display_name":"...","kind":"person|creature|construct|creature_group|group|organization","aliases":["..."],"evidence":[{"exact_excerpt":"verbatim script text","confidence":0.99}]}],
  "canonical_locations": [{"location_id":"snake_case","display_name":"...","aliases":["..."],"evidence":[{"exact_excerpt":"verbatim script text","confidence":0.95}]}],
  "canonical_props": [{"prop_id":"snake_case","display_name":"...","aliases":["every evidence-backed alternate name or short descriptor"],"evidence":[{"exact_excerpt":"verbatim script text","confidence":0.9}]}],
  "canonical_ui_motifs": [{"ui_id":"snake_case","display_name":"...","aliases":["every evidence-backed alternate name or short descriptor"],"evidence":[{"exact_excerpt":"verbatim script text","confidence":0.9}]}],
  "state_transitions": [{"entity_id":"snake_case","state_kind":"wardrobe|injury|possession|status|location","from_state":"...","to_state":"...","transition_evidence_excerpt":"one verbatim evidence excerpt where to_state first becomes true","evidence":[{"exact_excerpt":"verbatim script text","confidence":0.9}]}],
  "global_reference_requirements": [],
  "scenes": [/* reconciled semantic scene objects using exact script_excerpt_start/end */],
  "warnings": []
}`;
}

export function semanticReconciliationPromptForTests(script, bibles, extractedChunks, targets) {
  return buildReconciliationPrompt(script, bibles, extractedChunks, targets);
}

function storyFactRows(ledger) {
  return [
    ...(ledger.canonical_entities ?? []),
    ...(ledger.canonical_locations ?? []),
    ...(ledger.canonical_props ?? []),
    ...(ledger.canonical_ui_motifs ?? []),
    ...(ledger.state_transitions ?? []),
  ];
}

function identityLabel(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function identityTokens(value) {
  const stop = new Set([
    "a", "an", "the", "final", "old", "new", "unlisted", "ancient", "greater", "lesser",
    "fallen", "wounded", "injured", "dead", "sealed", "awakened",
  ]);
  return identityLabel(value).split(/\s+/).filter((token) => token && !stop.has(token));
}

function labelsDescribeSameEntity(left, right) {
  const a = identityLabel(left);
  const b = identityLabel(right);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const leftTokens = new Set(identityTokens(a));
  const rightTokens = new Set(identityTokens(b));
  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const smaller = Math.min(leftTokens.size, rightTokens.size);
  return overlap >= 1 && smaller > 0 && overlap / smaller >= 0.67;
}

function isGenericVisibleCollective(value) {
  const label = identityLabel(value);
  if (!label) return true;
  return /^(?:people|civilians?|crowd|audience|workers?|staff|guards?|soldiers?|students?|witnesses?|attackers?|fighters?|hunters?|raiders?|survivors?|monsters?|creatures?|teams?|crews?|members?|families|children)$/.test(label)
    || /^(?:two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:people|civilians?|guards?|soldiers?|students?|witnesses?|attackers?|fighters?|hunters?|raiders?|survivors?|monsters?|creatures?|teams?|crews?|members?)$/.test(label)
    || /^(?:ordinary|generic|various|several|many|multiple|minor|lesser)\s+(?:monsters?|creatures?|beasts?|guards?|soldiers?|attackers?|fighters?|hunters?|raiders?|survivors?)$/.test(label)
    || /\b(?:background crowd|anonymous crowd|generic crowd)\b/.test(label);
}

function hasDistinctActorCue(value) {
  return /\b(?:boss|guardian|sentinel|golem|construct|automaton|monster|creature|beast|hound|wolf|dragon|wyrm|demon|spirit|summon|undead|ram|serpent|leviathan|titan|colossus|giant|entity)\b/i.test(String(value ?? ""));
}

function hasSignatureActorCue(value) {
  return /\b(?:boss|guardian|sentinel|golem|construct|automaton|dragon|wyrm|demon|summon|undead|ram|leviathan|titan|colossus)\b/i.test(String(value ?? ""));
}

export function canonicalVisibleEntityCoverageFindingsForTests(ledger, scenes) {
  const candidates = new Map();
  for (const scene of scenes ?? []) {
    const sceneId = String(scene?.scene_id ?? "").trim();
    const primary = identityLabel(scene?.primary_subject);
    for (const rawSubject of scene?.visible_subjects ?? []) {
      const subject = normalizeText(rawSubject);
      const key = identityLabel(subject);
      if (!key || isGenericVisibleCollective(subject)) continue;
      const current = candidates.get(key) ?? {
        subject,
        scene_ids: new Set(),
        primary_count: 0,
        distinct_actor_cue: false,
        signature_actor_cue: false,
      };
      if (sceneId) current.scene_ids.add(sceneId);
      if (primary && labelsDescribeSameEntity(subject, primary)) current.primary_count += 1;
      current.distinct_actor_cue ||= hasDistinctActorCue(subject);
      current.signature_actor_cue ||= hasSignatureActorCue(subject);
      candidates.set(key, current);
    }
  }

  const canonicalLabels = (ledger?.canonical_entities ?? []).flatMap((entity) => [
    entity?.display_name,
    ...(entity?.aliases ?? []),
  ]).filter(Boolean);

  return [...candidates.values()]
    .filter((candidate) => (
      candidate.signature_actor_cue
      || candidate.scene_ids.size >= 2
      || (candidate.distinct_actor_cue && candidate.primary_count >= 1)
    ))
    .filter((candidate) => !canonicalLabels.some((label) => labelsDescribeSameEntity(candidate.subject, label)))
    .map((candidate) => ({
      severity: "blocker",
      code: "canonical_visible_actor_missing",
      subject: candidate.subject,
      scene_ids: [...candidate.scene_ids].sort(),
      message: `Identity-bearing visible actor ${candidate.subject} is absent from canonical_entities. Add one evidence-backed person/creature/construct/group entity instead of treating the actor as a prop.`,
    }));
}

export function storyFactEvidenceFindingsForTests(ledger, script) {
  const findings = [];
  for (const [index, row] of storyFactRows(ledger).entries()) {
    const factId = row.entity_id ?? row.location_id ?? row.prop_id ?? row.ui_id ?? `fact_${index + 1}`;
    const evidence = Array.isArray(row.evidence) ? row.evidence : [];
    if (!evidence.length) {
      findings.push({ severity: "blocker", code: "fact_missing_evidence", fact_id: factId });
      continue;
    }
    for (const [evidenceIndex, item] of evidence.entries()) {
      const exactExcerpt = String(item?.exact_excerpt ?? "");
      const confidence = Number(item?.confidence);
      if (!exactExcerpt || !String(script).includes(exactExcerpt)) {
        findings.push({ severity: "blocker", code: "fact_evidence_not_exact", fact_id: factId, evidence_index: evidenceIndex });
      }
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        findings.push({ severity: "blocker", code: "fact_confidence_invalid", fact_id: factId, evidence_index: evidenceIndex });
      }
    }
  }
  for (const [index, transition] of (ledger.state_transitions ?? []).entries()) {
    const factId = transition.entity_id ?? `state_transition_${index + 1}`;
    const transitionExcerpt = String(transition.transition_evidence_excerpt ?? "");
    const evidence = Array.isArray(transition.evidence) ? transition.evidence : [];
    if (!transitionExcerpt || !String(script).includes(transitionExcerpt)) {
      findings.push({ severity: "blocker", code: "state_transition_evidence_not_exact", fact_id: factId, transition_index: index });
      continue;
    }
    if (!evidence.some((item) => String(item?.exact_excerpt ?? "") === transitionExcerpt)) {
      findings.push({ severity: "blocker", code: "state_transition_evidence_not_listed", fact_id: factId, transition_index: index });
    }
  }
  return findings;
}

async function reconcileSemanticPlan(script, bibles, parsedChunks, targets, stageName, { exactRepair = false } = {}) {
  const reconciliationStage = `${stageName}_global_reconciliation`;
  const basePrompt = buildReconciliationPrompt(script, bibles, parsedChunks, targets);
  const chunkId = "global_reconciliation";
  const inputHash = sha256(basePrompt);
  const cachedCheckpoint = await readPassedSemanticChunkCheckpoint({
    episodeDir,
    chunkId,
    inputHash,
  });
  let llm = cachedCheckpoint ? {
    provider: cachedCheckpoint.artifact.provider,
    model: cachedCheckpoint.artifact.model,
    reasoning_effort: cachedCheckpoint.artifact.reasoning_effort,
    output_path: cachedCheckpoint.artifact.provider_output_path,
    parsed: cachedCheckpoint.artifact.parsed,
    reused_output: true,
  } : null;
  try {
    if (!llm) {
      const callStage = exactRepair ? `${reconciliationStage}_exact_repair` : reconciliationStage;
      llm = isLocalLLMRoute(callStage)
        ? await callLocal(basePrompt, callStage, Number(flags["semantic-reconciliation-max-tokens"] ?? 18_000))
        : exactRepair
          ? await callCodex(basePrompt, callStage)
          : await reusableCodexCall(callStage, basePrompt) ?? await callCodex(basePrompt, callStage);
    }
    const parsed = llm.parsed ?? {};
    const canonicalEntities = sanitizeCanonicalRows(parsed.canonical_entities, "entity_id");
    const canonicalLocations = sanitizeCanonicalRows(parsed.canonical_locations, "location_id");
    const canonicalProps = sanitizeCanonicalRows(parsed.canonical_props, "prop_id");
    const canonicalUiMotifs = sanitizeCanonicalRows(parsed.canonical_ui_motifs, "ui_id");
    const entityIdMap = new Map((parsed.canonical_entities ?? []).map((row) => [String(row.entity_id ?? ""), sanitizeCanonicalIdForTests(row.entity_id)]));
    const ledger = {
      schema: "goldflow_story_fact_ledger_v2",
      state_transition_contract: "exact_effective_evidence_v2",
      status: "passed",
      source_script_hash: sha256(script),
      source_script_path: scriptPath,
      canonical_entities: canonicalEntities,
      canonical_locations: canonicalLocations,
      canonical_props: canonicalProps,
      canonical_ui_motifs: canonicalUiMotifs,
      state_transitions: (parsed.state_transitions ?? []).map((transition) => ({
        ...transition,
        entity_id: entityIdMap.get(String(transition.entity_id ?? "")) ?? sanitizeCanonicalIdForTests(transition.entity_id),
      })),
      warnings: parsed.warnings ?? [],
      planner: {
        provider: llm.provider,
        model: llm.model ?? null,
        reasoning_effort: llm.reasoning_effort ?? null,
        output_path: llm.output_path ?? null,
        attempt: 1,
      },
      updated_at: new Date().toISOString(),
    };
    const evidenceFindings = storyFactEvidenceFindingsForTests(ledger, script);
    const normalizedScenes = normalizeScenes(parsed.scenes ?? []);
    const snappedScenes = snapSemanticSceneAnchors(normalizedScenes, script).scenes;
    const visibleEntityCoverageFindings = canonicalVisibleEntityCoverageFindingsForTests(ledger, snappedScenes);
    const sceneFindings = [
      ...semanticSceneAnchorFindings(snappedScenes, script),
      ...semanticSceneCoverageFindingsForTests(snappedScenes, script),
      ...visibleEntityCoverageFindings,
      ...semanticSceneQualityFindings(snappedScenes),
      ...semanticSceneCountFindings(snappedScenes.length, targets),
    ];
    const reconciliationFindings = [...evidenceFindings, ...sceneFindings];
    const blockers = reconciliationFindings.filter((finding) => finding.severity === "blocker");
    if (blockers.length) {
      const preview = blockers.slice(0, 10).map((finding) => `${finding.fact_id ?? finding.scene_id ?? "unknown"}:${finding.code}`).join(", ");
      throw new Error(`Semantic reconciliation failed structural evidence or scene-coverage validation: ${preview}`);
    }
    const checkpoint = cachedCheckpoint ?? await writeSemanticChunkCheckpoint({
      episodeDir,
      chunkId,
      inputHash,
      chunk: {
        chunk_index: 1,
        chunk_count: 1,
        word_start_index: 0,
        word_end_index_exclusive: wordCount(script),
        overlap_words: 0,
        words: wordCount(script),
      },
      targets,
      llm,
      status: "passed",
    });
    await recordPlannerChunkCheckpoint({
      episodeDir,
      plannerStage: "semantic_scene_plan",
      chunkId,
      inputHash,
      expectedIds: [chunkId],
      status: "passed",
      attempt: 1,
      reused: Boolean(cachedCheckpoint || llm.reused_output),
      outputPath: checkpoint.path,
      metadata: {
        scene_count: normalizedScenes.length,
        unit_role: "global_reconciliation",
      },
    });
    return {
      llm,
      parsed,
      ledger,
      evidenceFindings,
      sceneFindings,
      checkpoint_path: checkpoint.path,
      checkpoint_sha256: checkpoint.sha256,
      input_hash: inputHash,
      reused_checkpoint: Boolean(cachedCheckpoint),
    };
  } catch (error) {
    llm ??= error?.llm_failure_packet ?? null;
    const message = error instanceof Error ? error.message : String(error);
    const checkpoint = await writeSemanticChunkCheckpoint({
      episodeDir,
      chunkId,
      inputHash,
      chunk: {
        chunk_index: 1,
        chunk_count: 1,
        word_start_index: 0,
        word_end_index_exclusive: wordCount(script),
        overlap_words: 0,
        words: wordCount(script),
      },
      targets,
      llm,
      status: "failed",
      failure: { code: "semantic_global_reconciliation_failed", message },
    });
    await recordPlannerChunkCheckpoint({
      episodeDir,
      plannerStage: "semantic_scene_plan",
      chunkId,
      inputHash,
      expectedIds: [chunkId],
      status: "failed",
      attempt: 1,
      reused: Boolean(llm?.reused_output),
      outputPath: checkpoint.path,
      findings: [{ code: "semantic_global_reconciliation_failed", message }],
      metadata: { unit_role: "global_reconciliation" },
    });
    const wrapped = error instanceof Error ? error : new Error(message);
    wrapped.semantic_failure_result = {
      chunk_id: chunkId,
      input_hash: inputHash,
      checkpoint_path: checkpoint.path,
      checkpoint_sha256: checkpoint.sha256,
      error: message,
    };
    throw wrapped;
  }
}

function semanticRecoveryCommand(unitIds) {
  const proofFlags = proofBaselineTimingPath
    ? ` --proof-baseline-word-timing ${proofBaselineTimingPath} --scope-start-sec ${scopeStartSec} --scope-end-sec ${scopeEndSec}`
    : "";
  return `node bin/goldflow.mjs semantic plan --channel ${channel} --series ${series} --week ${week} --episode ${episode}`
    + ` --concurrency ${Math.max(1, Math.min(11, Number(flags.concurrency ?? flags["semantic-concurrency"] ?? 11)))}`
    + " --semantic-json-attempts 1 --semantic-chunk-validation-attempts 1 --semantic-reconciliation-attempts 1"
    + ` --semantic-chunk-ids ${unitIds.join(",")}${proofFlags}`;
}

async function main() {
  const runIdentity = await readJson(runIdentityPath, {});
  activeContentProfile = contentProfileForIdentity(runIdentity);
  const script = await readText(scriptPath);
  if (!script.trim()) throw new Error(`Missing script_clean.md at ${scriptPath}`);
  const scriptHash = sha256(script);
  await requireApproval(scriptHash);
  const manualLocationRefRepairs = manualLocationRefRepairsPath
    ? await readJson(manualLocationRefRepairsPath, null)
    : null;
  const manualSemanticRepairs = manualSemanticRepairsPath
    ? await readJson(manualSemanticRepairsPath, null)
    : null;
  if (manualLocationRefRepairsPath && !manualLocationRefRepairs) {
    throw new Error(`Missing or invalid manual semantic location-ref repair artifact: ${manualLocationRefRepairsPath}`);
  }
  if (manualSemanticRepairsPath && !manualSemanticRepairs) {
    throw new Error(`Missing or invalid manual semantic repair artifact: ${manualSemanticRepairsPath}`);
  }
  if (manualLocationRefRepairsPath && manualSemanticRepairsPath) {
    throw new Error("Use either --manual-location-ref-repairs or --manual-semantic-repairs, not both");
  }
  const baselineTiming = proofBaselineTimingPath ? await readJson(proofBaselineTimingPath, null) : null;
  if (proofBaselineTimingPath && (!baselineTiming || baselineTiming.source_script_hash !== scriptHash)) {
    throw new Error(`Semantic proof baseline timing is missing or does not match locked script hash: ${proofBaselineTimingPath}`);
  }
  const scope = proofBaselineTimingPath
    ? semanticProofScopeForTests(script, baselineTiming, scopeStartSec, scopeEndSec, Number(flags["scope-buffer-words"] ?? 24))
    : { script, scoped: false, source_word_start: 0, source_word_end_exclusive: wordCount(script) };
  const planningScript = scope.script;
  const bibles = await biblePacket();
  const targets = sceneCountTargets(planningScript);
  const stageName = `${episode}_semantic_scene_plan`;
  let llm;
  let scenes = [];
  let semanticParsed = {};
  let parsedChunks = [];
  const useChunking = flags["semantic-chunking"] !== "false" && targets.words > Number(flags["semantic-single-call-max-words"] ?? 2500);
  const chunks = useChunking ? scriptChunks(planningScript) : [{
    text: planningScript,
    words: targets.words,
    word_start_index: 0,
    word_end_index_exclusive: targets.words,
    char_start: 0,
    char_end: planningScript.length,
    overlap_words: 0,
    chunk_index: 1,
    chunk_count: 1,
  }];
  const semanticConcurrency = Math.max(1, Math.min(11, Number(flags.concurrency ?? flags["semantic-concurrency"] ?? 11)));
  const expectedChunkIds = chunks.map((chunk) => semanticChunkId(chunk.chunk_index));
  const expectedUnitIds = [...expectedChunkIds, "global_reconciliation"];
  const requestedUnitIds = semanticRequestedUnitIds(flags);
  const unknownRequestedIds = requestedUnitIds.filter((id) => !expectedUnitIds.includes(id));
  if (unknownRequestedIds.length) {
    throw new Error(`Unknown semantic repair unit IDs: ${unknownRequestedIds.join(", ")}. Expected one of ${expectedUnitIds.join(", ")}.`);
  }
  const requestedSet = new Set(requestedUnitIds);
  const chunkResults = await runPool(chunks, async (chunk) => {
    const chunkTargets = chunkSceneCountTargets(chunk.text);
    const chunkPrompt = buildPrompt(chunk.text, bibles, chunkTargets, chunk);
    const chunkId = semanticChunkId(chunk.chunk_index);
    const inputHash = sha256(chunkPrompt);
    console.error(`semantic chunk ${chunk.chunk_index}/${chunk.chunk_count}: ${chunk.words} words, target ${chunkTargets.target} scenes`);
    const cachedCheckpoint = await readPassedSemanticChunkCheckpoint({ episodeDir, chunkId, inputHash });
    if (cachedCheckpoint) {
      const chunkLlm = {
        provider: cachedCheckpoint.artifact.provider,
        model: cachedCheckpoint.artifact.model,
        reasoning_effort: cachedCheckpoint.artifact.reasoning_effort,
        output_path: cachedCheckpoint.artifact.provider_output_path,
        parsed: cachedCheckpoint.artifact.parsed,
        reused_output: true,
      };
      await recordPlannerChunkCheckpoint({
        episodeDir,
        plannerStage: "semantic_scene_plan",
        chunkId,
        inputHash,
        expectedIds: [chunkId],
        status: "passed",
        attempt: 1,
        reused: true,
        outputPath: cachedCheckpoint.path,
        metadata: {
          word_start_index: chunk.word_start_index,
          word_end_index_exclusive: chunk.word_end_index_exclusive,
          scene_count: cachedCheckpoint.artifact.scenes.length,
        },
      });
      console.error(`semantic chunk ${chunk.chunk_index}/${chunk.chunk_count}: preserved checkpoint ${cachedCheckpoint.path}`);
      return {
        ok: true,
        chunk_id: chunkId,
        input_hash: inputHash,
        chunk,
        targets: chunkTargets,
        llm: chunkLlm,
        scenes: cachedCheckpoint.artifact.scenes,
        checkpoint_path: cachedCheckpoint.path,
        checkpoint_sha256: cachedCheckpoint.sha256,
        reused_checkpoint: true,
      };
    }
    if (requestedSet.size && !requestedSet.has(chunkId)) {
      return {
        ok: false,
        chunk_id: chunkId,
        input_hash: inputHash,
        chunk,
        targets: chunkTargets,
        scenes: [],
        error: "Passed semantic checkpoint is missing; exact recovery must include this chunk ID.",
      };
    }
    let chunkLlm = null;
    try {
      const attemptStageName = requestedSet.has(chunkId)
        ? `${stageName}_${chunkId}_exact_repair`
        : `${stageName}_${chunkId}`;
      const structurallyUsable = (parsed) => Array.isArray(parsed?.scenes) && parsed.scenes.length > 0;
      chunkLlm = isLocalLLMRoute(attemptStageName)
        ? await callLocal(chunkPrompt, attemptStageName, Number(flags["semantic-chunk-max-tokens"] ?? 4500))
        : await reusableCodexCall(attemptStageName, chunkPrompt, structurallyUsable) ?? await callCodex(chunkPrompt, attemptStageName);
      const chunkScenes = Array.isArray(chunkLlm?.parsed?.scenes) ? chunkLlm.parsed.scenes : [];
      if (!chunkScenes.length) throw new Error("returned no semantic scenes");
      const checkpoint = await writeSemanticChunkCheckpoint({
        episodeDir,
        chunkId,
        inputHash,
        chunk,
        targets: chunkTargets,
        llm: chunkLlm,
        status: "passed",
      });
      await recordPlannerChunkCheckpoint({
        episodeDir,
        plannerStage: "semantic_scene_plan",
        chunkId,
        inputHash,
        expectedIds: [chunkId],
        status: "passed",
        attempt: 1,
        reused: Boolean(chunkLlm.reused_output),
        outputPath: checkpoint.path,
        metadata: {
          word_start_index: chunk.word_start_index,
          word_end_index_exclusive: chunk.word_end_index_exclusive,
          scene_count: chunkScenes.length,
          scene_count_findings: semanticSceneCountFindings(chunkScenes.length, chunkTargets),
        },
      });
      console.error(`semantic chunk ${chunk.chunk_index}/${chunk.chunk_count}: accepted ${chunkScenes.length} scenes`);
      return {
        ok: true,
        chunk_id: chunkId,
        input_hash: inputHash,
        chunk,
        targets: chunkTargets,
        llm: chunkLlm,
        scenes: chunkScenes,
        checkpoint_path: checkpoint.path,
        checkpoint_sha256: checkpoint.sha256,
        reused_checkpoint: false,
      };
    } catch (error) {
      chunkLlm ??= error?.llm_failure_packet ?? null;
      const message = error instanceof Error ? error.message : String(error);
      const checkpoint = await writeSemanticChunkCheckpoint({
        episodeDir,
        chunkId,
        inputHash,
        chunk,
        targets: chunkTargets,
        llm: chunkLlm,
        status: "failed",
        failure: { code: "semantic_chunk_structural_failure", message },
      });
      await recordPlannerChunkCheckpoint({
        episodeDir,
        plannerStage: "semantic_scene_plan",
        chunkId,
        inputHash,
        expectedIds: [chunkId],
        status: "failed",
        attempt: 1,
        reused: Boolean(chunkLlm?.reused_output),
        outputPath: checkpoint.path,
        findings: [{ code: "semantic_chunk_structural_failure", message }],
        metadata: {
          word_start_index: chunk.word_start_index,
          word_end_index_exclusive: chunk.word_end_index_exclusive,
        },
      });
      return {
        ok: false,
        chunk_id: chunkId,
        input_hash: inputHash,
        chunk,
        targets: chunkTargets,
        scenes: [],
        checkpoint_path: checkpoint.path,
        checkpoint_sha256: checkpoint.sha256,
        error: message,
      };
    }
  }, semanticConcurrency);
  const failedChunkResults = chunkResults.filter((result) => !result.ok);
  const passedChunkResults = chunkResults.filter((result) => result.ok);
  if (failedChunkResults.length) {
    const failedIds = failedChunkResults.map((result) => result.chunk_id);
    await writeJson(outputPath, semanticPartialFailureArtifact({
      identity: { channel, series_slug: series, week, episode },
      sourceScriptHash: scriptHash,
      sourceScriptPath: scriptPath,
      expectedUnitIds,
      passedResults: passedChunkResults,
      failedResults: failedChunkResults,
      sceneCountPolicy: targets,
      requestedUnitIds,
      recoveryCommand: semanticRecoveryCommand(failedIds),
    }));
    const error = new Error(`Semantic chunk batch stopped with exact failed scope: ${failedIds.join(", ")}`);
    error.goldflow_artifact_preserved = true;
    throw error;
  }
  parsedChunks = passedChunkResults.map((result) => ({
    chunk: result.chunk,
    targets: result.targets,
    llm: result.llm,
    scenes: result.scenes,
  }));
  llm = {
    provider: parsedChunks[0]?.llm?.provider ?? (isLocalLLMRoute(stageName) ? "local-qwen" : "identity_locked_llm"),
    model: parsedChunks[0]?.llm?.model ?? (isLocalLLMRoute(stageName) ? getLLMModel(stageName) : configuredCodexModel()),
    reasoning_effort: parsedChunks[0]?.llm?.reasoning_effort ?? null,
    codex_cli_path: parsedChunks[0]?.llm?.codex_cli_path ?? null,
    codex_cli_version: parsedChunks[0]?.llm?.codex_cli_version ?? null,
    chunked: useChunking,
    chunk_count: chunks.length,
    concurrency: semanticConcurrency,
    reused_chunk_count: passedChunkResults.filter((item) => item.reused_checkpoint || item.llm?.reused_output).length,
  };
  let reconciliation;
  try {
    reconciliation = await reconcileSemanticPlan(planningScript, bibles, parsedChunks, targets, stageName, {
      exactRepair: requestedSet.has("global_reconciliation"),
    });
  } catch (error) {
    const failure = error?.semantic_failure_result ?? {
      chunk_id: "global_reconciliation",
      input_hash: null,
      error: error instanceof Error ? error.message : String(error),
    };
    await writeJson(outputPath, semanticPartialFailureArtifact({
      identity: { channel, series_slug: series, week, episode },
      sourceScriptHash: scriptHash,
      sourceScriptPath: scriptPath,
      expectedUnitIds,
      passedResults: passedChunkResults,
      failedResults: [failure],
      sceneCountPolicy: targets,
      requestedUnitIds,
      recoveryCommand: semanticRecoveryCommand(["global_reconciliation"]),
    }));
    const wrapped = error instanceof Error ? error : new Error(String(error));
    wrapped.goldflow_artifact_preserved = true;
    throw wrapped;
  }
  semanticParsed = reconciliation.parsed;
  scenes = Array.isArray(reconciliation.parsed.scenes) ? reconciliation.parsed.scenes : [];
  if (!scenes.length) throw new Error("Semantic scene planner returned no scenes.");
  const sceneCountFindings = semanticSceneCountFindings(scenes.length, targets);
  const normalizedScenes = normalizeScenes(scenes);
  const reconciliationOutputSha256 = reconciliation.checkpoint_path
    ? sha256(await fs.readFile(reconciliation.checkpoint_path))
    : null;
  const manualSemanticRepairResult = applyManualSemanticRepairsForTests(
    normalizedScenes,
    reconciliation.ledger,
    manualSemanticRepairs,
    {
      sourceScriptHash: scriptHash,
      baseReconciliationSha256: reconciliationOutputSha256,
      requestedSceneIds: commaSeparatedIds(flags["scene-ids"] ?? flags["scene-id"]),
    },
  );
  const manualLocationRepairResult = applyManualLocationRefRepairsForTests(
    manualSemanticRepairResult.scenes,
    manualLocationRefRepairs,
    {
      sourceScriptHash: scriptHash,
      requestedSceneIds: commaSeparatedIds(flags["scene-ids"] ?? flags["scene-id"]),
    },
  );
  const repairedScenes = manualLocationRepairResult.scenes;
  const anchorSnapReport = snapSemanticSceneAnchors(repairedScenes, planningScript);
  const anchorFindings = semanticSceneAnchorFindings(anchorSnapReport.scenes, planningScript);
  const coverageFindings = semanticSceneCoverageFindingsForTests(anchorSnapReport.scenes, planningScript);
  const anchorBlockers = [...anchorFindings, ...coverageFindings].filter((finding) => finding.severity === "blocker");
  if (anchorBlockers.length) {
    const preview = anchorBlockers.slice(0, 8).map((finding) => `${finding.scene_id} ${finding.code}: ${finding.anchor ?? finding.message}`).join("\n");
    throw new Error(`Semantic scene planner returned scene anchors that do not bind to the locked script:\n${preview}`);
  }
  const semanticQualityFindings = semanticSceneQualityFindings(repairedScenes);
  const semanticQualityBlockers = semanticQualityFindings.filter((finding) => finding.severity === "blocker");
  if (semanticQualityBlockers.length) {
    const preview = semanticQualityBlockers.slice(0, 8).map((finding) => `${finding.scene_id} ${finding.code}: ${finding.message}`).join("\n");
    throw new Error(`Semantic scene planner returned blocking quality findings:\n${preview}`);
  }
  const repairedLedgerEvidenceFindings = storyFactEvidenceFindingsForTests(
    manualSemanticRepairResult.ledger,
    planningScript,
  );
  const repairedLedgerEvidenceBlockers = repairedLedgerEvidenceFindings.filter(
    (finding) => finding.severity === "blocker",
  );
  if (repairedLedgerEvidenceBlockers.length) {
    const preview = repairedLedgerEvidenceBlockers.slice(0, 8)
      .map((finding) => `${finding.fact_id ?? "unknown"} ${finding.code}`)
      .join("\n");
    throw new Error(`Manual semantic repair returned blocking story-fact evidence findings:\n${preview}`);
  }
  const semanticRepairMetadata = manualSemanticRepairsPath ? {
    artifact_path: manualSemanticRepairsPath,
    artifact_sha256: sha256(await fs.readFile(manualSemanticRepairsPath)),
    base_reconciliation_sha256: reconciliationOutputSha256,
    applied_scene_updates: manualSemanticRepairResult.applied_scene_updates,
    applied_scene_insertions: manualSemanticRepairResult.applied_scene_insertions,
    appended_state_transitions: manualSemanticRepairResult.appended_state_transitions,
    appended_canonical_locations: manualSemanticRepairResult.appended_canonical_locations,
  } : null;
  const storyFactLedger = {
    ...manualSemanticRepairResult.ledger,
    planning_scope_script_hash: manualSemanticRepairResult.ledger.source_script_hash ?? null,
    source_script_hash: scriptHash,
    source_hashes: {
      [scriptPath]: scriptHash,
      ...(proofBaselineTimingPath ? { [proofBaselineTimingPath]: sha256(await fs.readFile(proofBaselineTimingPath)) } : {}),
      ...(manualLocationRefRepairsPath
        ? { [manualLocationRefRepairsPath]: sha256(await fs.readFile(manualLocationRefRepairsPath)) }
        : {}),
      ...(manualSemanticRepairsPath
        ? { [manualSemanticRepairsPath]: sha256(await fs.readFile(manualSemanticRepairsPath)) }
        : {}),
    },
    proof_scope: scope.scoped ? { ...scope, script: undefined } : null,
    manual_location_ref_repair: manualLocationRefRepairsPath ? {
      artifact_path: manualLocationRefRepairsPath,
      artifact_sha256: sha256(await fs.readFile(manualLocationRefRepairsPath)),
      applied_repairs: manualLocationRepairResult.applied_repairs,
    } : null,
    manual_semantic_repair: semanticRepairMetadata,
    semantic_scene_count: anchorSnapReport.scenes.length,
    evidence_finding_count: repairedLedgerEvidenceFindings.length,
  };
  await writeJson(storyFactLedgerPath, storyFactLedger);
  const report = {
    schema: "goldflow_semantic_scene_plan_v2",
    status: "passed",
    channel,
    series_slug: series,
    week,
    episode,
    content_profile: {
      id: activeContentProfile.id,
      version: activeContentProfile.version,
      sha256: runIdentity.content_profile_sha256 ?? null,
    },
    source_script_hash: scriptHash,
    source_script_path: scriptPath,
    source_hashes: {
      [scriptPath]: scriptHash,
      [storyFactLedgerPath]: sha256(`${JSON.stringify(storyFactLedger, null, 2)}\n`),
      ...(proofBaselineTimingPath ? { [proofBaselineTimingPath]: sha256(await fs.readFile(proofBaselineTimingPath)) } : {}),
      ...(manualLocationRefRepairsPath
        ? { [manualLocationRefRepairsPath]: sha256(await fs.readFile(manualLocationRefRepairsPath)) }
        : {}),
      ...(manualSemanticRepairsPath
        ? { [manualSemanticRepairsPath]: sha256(await fs.readFile(manualSemanticRepairsPath)) }
        : {}),
    },
    story_fact_ledger_path: storyFactLedgerPath,
    timing_dependency: proofBaselineTimingPath ? "proof_baseline_word_timing_scope_only" : "none_semantic_only",
    proof_scope: scope.scoped ? { ...scope, script: undefined } : null,
    manual_location_ref_repair: manualLocationRefRepairsPath ? {
      artifact_path: manualLocationRefRepairsPath,
      artifact_sha256: sha256(await fs.readFile(manualLocationRefRepairsPath)),
      applied_repairs: manualLocationRepairResult.applied_repairs,
    } : null,
    manual_semantic_repair: semanticRepairMetadata,
    scene_count_policy: targets,
    semantic_validation: {
      scene_count_finding_count: sceneCountFindings.length,
      scene_count_findings_by_code: countByCode(sceneCountFindings),
      anchor_finding_count: anchorFindings.length,
      anchor_findings_by_code: countByCode(anchorFindings),
      coverage_finding_count: coverageFindings.length,
      coverage_findings_by_code: countByCode(coverageFindings),
      anchor_snap_count: anchorSnapReport.snaps.length,
      quality_finding_count: semanticQualityFindings.length,
      quality_findings_by_code: countByCode(semanticQualityFindings),
    },
    semantic_anchor_snaps: anchorSnapReport.snaps,
    semantic_quality_findings: [...sceneCountFindings, ...semanticQualityFindings],
    planner: {
      maximum_creative_submissions_per_unit_per_invocation: 1,
      passed_outputs_are_immutable: true,
      exact_scope_repair_only: true,
      provider: llm.provider,
      model: llm.model ?? null,
      reasoning_effort: llm.reasoning_effort ?? null,
      codex_cli_path: llm.codex_cli_path ?? null,
      codex_cli_version: llm.codex_cli_version ?? null,
      output_path: llm.output_path ?? null,
      chunked: llm.chunked ?? false,
      chunk_count: llm.chunk_count ?? null,
      concurrency: llm.concurrency ?? 1,
      reused_chunk_count: llm.reused_chunk_count ?? 0,
      chunk_ledger_path: path.join(episodeDir, "planner_chunk_ledger.json"),
      overlap_words: useChunking ? Number(flags["semantic-overlap-words"] ?? 120) : 0,
      reconciliation: {
        provider: reconciliation.llm.provider,
        model: reconciliation.llm.model ?? null,
        reasoning_effort: reconciliation.llm.reasoning_effort ?? null,
        output_path: reconciliation.llm.output_path ?? null,
        checkpoint_path: reconciliation.checkpoint_path,
        checkpoint_sha256: reconciliation.checkpoint_sha256,
        reused_checkpoint: reconciliation.reused_checkpoint,
      },
    },
    ...semanticParsed,
    canonical_entities: storyFactLedger.canonical_entities,
    canonical_locations: storyFactLedger.canonical_locations,
    canonical_props: storyFactLedger.canonical_props,
    canonical_ui_motifs: storyFactLedger.canonical_ui_motifs,
    state_transitions: storyFactLedger.state_transitions,
    scenes: anchorSnapReport.scenes,
    updated_at: new Date().toISOString(),
  };
  await writeJson(outputPath, report);
  console.log(JSON.stringify({ status: "passed", output_path: outputPath, scene_count: scenes.length, source_script_hash: scriptHash }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    const existing = await readJson(outputPath, null);
    if (!error?.goldflow_artifact_preserved && !["passed", "blocked"].includes(String(existing?.status ?? ""))) {
      await writeJson(outputPath, {
        schema: "goldflow_semantic_scene_plan_v2",
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        preserved_existing_artifact: false,
        updated_at: new Date().toISOString(),
      }).catch(() => {});
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
