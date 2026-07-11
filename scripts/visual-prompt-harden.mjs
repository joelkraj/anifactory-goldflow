#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sanitizeCharacterStaging } from "./lib/character-staging-utils.mjs";
import { beautyLanguageFindings, namedCharacterDuplicationFindings, providerExclusionPayloadFindings } from "./lib/prompt-prose-findings.mjs";
import { outOfScopeLocationRefMentions } from "./lib/visual-scope-utils.mjs";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeDir = path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode);
const promptPath = flags.prompts ?? path.join(episodeDir, "section_image_prompts.json");
const timedPlanPath = flags.timed ?? path.join(episodeDir, "timed_scene_plan.json");
const visualReferencePlanPath = flags.visualRefs ?? flags["visual-refs"] ?? path.join(episodeDir, "visual_reference_plan.json");
const characterStateRefsPath = flags.characterStateRefs ?? flags["character-state-refs"] ?? path.join(episodeDir, "character_state_refs.json");
const referenceInventoryLedgerPath = flags.referenceInventoryLedger ?? flags["reference-inventory-ledger"] ?? path.join(episodeDir, "reference_inventory_ledger.json");
const locationContractLedgerPath = flags.locationContractLedger ?? flags["location-contract-ledger"] ?? path.join(episodeDir, "location_contract_ledger.json");
const outputPath = flags.output ?? path.join(episodeDir, "section_image_prompts_hardened.json");
const reportPath = flags.report ?? flags["report-output"] ?? path.join(episodeDir, `visual_prompt_hardening_${episode}.json`);
const samplePath = flags.sample ?? flags["sample-output"] ?? path.join(episodeDir, `visual_prompt_hardening_sample_${episode}.md`);
const manualTriagePath = flags["manual-triage"] ?? path.join(episodeDir, `visual_manual_blocker_triage_${episode}.json`);
const mutationHitsOutputPath = flags["mutation-hits-output"] ?? null;
const sampleCount = Math.max(1, Number(flags["sample-count"] ?? 12));
const maxRefs = Math.max(1, Math.min(4, Number(flags["max-scene-references"] ?? 4)));
const hardenMode = String(flags.mode ?? flags["harden-mode"] ?? "sanitize").toLowerCase();
const effectiveHardenMode = "sanitize";
const mutationTrackingEnabled = Boolean(mutationHitsOutputPath);
const mutationStats = new Map();

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
  return createHash("sha256").update(String(value ?? "")).digest("hex");
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

function mutationStat(name) {
  if (!mutationStats.has(name)) {
    mutationStats.set(name, {
      function_name: name,
      call_count: 0,
      matched_count: 0,
      changed_count: 0,
      examples: [],
    });
  }
  return mutationStats.get(name);
}

function recordMutationHit(name, { before, after, matched = null, prompt = null }) {
  if (!mutationTrackingEnabled) return after;
  const stat = mutationStat(name);
  stat.call_count += 1;
  const normalizedBefore = String(before ?? "");
  const normalizedAfter = String(after ?? "");
  const derivedMatch = matched == null ? normalizedBefore !== normalizedAfter : Boolean(matched);
  if (derivedMatch) stat.matched_count += 1;
  if (normalizedBefore !== normalizedAfter) {
    stat.changed_count += 1;
    if (stat.examples.length < 3) {
      stat.examples.push({
        image_id: prompt?.image_id ?? null,
        scene_id: prompt?.scene_id ?? null,
        before: normalizedBefore,
        after: normalizedAfter,
      });
    }
  }
  return after;
}

function trackedMutation(name, before, mutate, options = {}) {
  const after = mutate(String(before ?? ""));
  return recordMutationHit(name, { before, after, ...options });
}

function trackedValueMutation(name, before, after, options = {}) {
  return recordMutationHit(name, { before, after, ...options });
}

function normalize(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").trim();
}

function sceneIdNumber(sceneId) {
  const match = String(sceneId ?? "").match(/^scene_(\d+)$/);
  return match ? Number(match[1]) : null;
}

function sceneIdsCover(sceneIds, sceneId) {
  if (!Array.isArray(sceneIds) || !sceneIds.length || sceneIds.includes("*")) return true;
  if (sceneIds.includes(sceneId)) return true;
  const current = sceneIdNumber(sceneId);
  const numeric = sceneIds.map(sceneIdNumber).filter((value) => Number.isFinite(value));
  if (current !== null && sceneIds.length === 2 && numeric.length === 2) {
    const low = Math.min(...numeric);
    const high = Math.max(...numeric);
    return current >= low && current <= high;
  }
  return false;
}

function compactWords(value) {
  return normalize(value).replace(/\s+/g, "");
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
    location_contract_id: value.location_contract_id ? String(value.location_contract_id) : null,
    location_ref_id: value.location_ref_id ? String(value.location_ref_id) : null,
    foreground_action: value.foreground_action ? String(value.foreground_action) : null,
    visible_props: arrayOfStrings("visible_props"),
    ui_elements: arrayOfStrings("ui_elements"),
    forbidden_ref_ids: arrayOfStrings("forbidden_ref_ids"),
    continuity_notes: value.continuity_notes ? String(value.continuity_notes) : null,
    character_staging: sanitizeCharacterStaging(value.character_staging),
  };
}

function promptText(prompt) {
  return [
    prompt.modelslab_image_prompt,
    prompt.image_prompt,
    prompt.codex_image_prompt,
    prompt.primary_subject,
    prompt.location,
    ...(Array.isArray(prompt.visible_subjects) ? prompt.visible_subjects : []),
    prompt.visual_beat_action,
    prompt.visual_beat_script_excerpt,
  ].filter(Boolean).join(" | ");
}

function characterMatchText(prompt) {
  return [
    prompt.modelslab_image_prompt,
    prompt.image_prompt,
    prompt.codex_image_prompt,
    prompt.primary_subject,
  ].filter(Boolean).join(" | ");
}

function sceneAllowed(ref, sceneId) {
  return !Array.isArray(ref.scene_ids) || !ref.scene_ids.length || ref.scene_ids.includes(sceneId);
}

function sourceRefId(ref) {
  return ref.source_ref_id ?? ref.ref_id ?? (ref.state_ref_id ? `char_${ref.state_ref_id}` : null);
}

function stateRefId(ref) {
  return ref?.state_ref_id ? String(ref.state_ref_id) : null;
}

function characterAliases(ref) {
  const character = String(ref.character ?? ref.subject ?? "");
  const n = normalize(character);
  const aliases = new Set([n, compactWords(character)]);
  const parts = n.split(/\s+/).filter(Boolean);
  if (parts.length > 1) aliases.add(parts[0]);
  if (parts.length > 1) aliases.add(parts.at(-1));
  return [...aliases].filter(Boolean);
}

function referenceKindRank(kind) {
  const value = String(kind ?? "").toLowerCase();
  if (value.includes("character")) return 0;
  if (value.includes("location")) return 1;
  if (value.includes("prop") || value.includes("ui")) return 2;
  if (value.includes("action") || value.includes("effect")) return 3;
  if (value.includes("style")) return 9;
  return 6;
}

function makeRequirement(ref_id, kind, slot_purpose, reason, slot_order = 1, required = true, extra = {}) {
  return { ref_id, kind, required, slot_order, slot_purpose, reason, ...extra };
}

function buildIndexes(visualReferencePlan, characterStateRefs, referenceInventoryLedger = null, locationContractLedger = null) {
  const inventoryTargets = (referenceInventoryLedger?.assets ?? [])
    .filter((asset) => asset?.ref_id)
    .map((asset) => ({
      ...asset,
      generation_mode: asset.generation_mode ?? asset.recommended_generation_mode ?? "no_ref_needed",
      required_before_imagegen: asset.required_before_imagegen ?? asset.recommended_required_before_imagegen ?? false,
      prompt_anchor: asset.prompt_anchor ?? asset.scene_prompt_anchor ?? asset.subject ?? null,
    }));
  const byRefId = new Map();
  for (const target of [...inventoryTargets, ...(visualReferencePlan?.reference_targets ?? [])]) {
    byRefId.set(String(target.ref_id), { ...(byRefId.get(String(target.ref_id)) ?? {}), ...target });
  }
  const referenceTargets = [...byRefId.values()];
  const referenceById = new Map(referenceTargets.map((target) => [target.ref_id, target]));
  const visualCharacterRefs = referenceTargets
    .filter((target) => String(target.kind ?? "") === "character_state" && target.ref_id)
    .map((target) => ({
      ...target,
      character: target.subject ?? target.character ?? target.ref_id,
      source_ref_id: target.ref_id,
      scene_prompt_anchor: target.scene_prompt_anchor ?? target.prompt_anchor,
    }));
  const characterRefs = [
    ...(characterStateRefs?.character_state_refs ?? []),
    ...visualCharacterRefs,
  ].filter((ref) => sourceRefId(ref));
  const refIdByStateId = new Map();
  for (const ref of characterRefs) {
    const sourceId = sourceRefId(ref);
    const stateId = ref.state_ref_id ? String(ref.state_ref_id) : null;
    const sourceTarget = referenceById.get(sourceId) ?? {};
    if (stateId) {
      referenceById.set(stateId, {
        ...sourceTarget,
        ...ref,
        kind: "character_state",
        ref_id: stateId,
        subject: ref.character ?? sourceTarget.subject,
        character: ref.character ?? sourceTarget.character ?? sourceTarget.subject,
        source_ref_id: sourceId,
        reference_image_path: ref.conditioning_image_path ?? ref.reference_image_path ?? sourceTarget.conditioning_image_path ?? sourceTarget.reference_image_path ?? null,
        conditioning_image_path: ref.conditioning_image_path ?? sourceTarget.conditioning_image_path ?? ref.reference_image_path ?? sourceTarget.reference_image_path ?? null,
        scene_prompt_anchor: ref.scene_prompt_anchor ?? sourceTarget.scene_prompt_anchor ?? null,
        prompt_anchor: ref.prompt_anchor ?? sourceTarget.prompt_anchor ?? null,
      });
      refIdByStateId.set(stateId, stateId);
    }
    const existing = referenceById.get(sourceId) ?? {};
    referenceById.set(sourceId, {
      ...ref,
      ...existing,
      kind: "character_state",
      ref_id: sourceId,
      subject: existing.subject ?? ref.character,
      character: ref.character ?? existing.character ?? existing.subject,
      source_ref_id: sourceId,
      scene_prompt_anchor: existing.scene_prompt_anchor ?? ref.scene_prompt_anchor ?? null,
      prompt_anchor: existing.prompt_anchor ?? ref.prompt_anchor ?? null,
    });
  }
  const locationTargets = referenceTargets.filter((target) => String(target.kind ?? "") === "location");
  const locationContracts = Array.isArray(locationContractLedger?.contracts) ? locationContractLedger.contracts : [];
  const locationContractById = new Map(locationContracts
    .filter((contract) => contract?.location_contract_id)
    .map((contract) => [String(contract.location_contract_id), contract]));
  return {
    referenceById,
    refIdByStateId,
    characterRefs,
    locationTargets,
    locationContracts,
    locationContractById,
    usesLocationContractLedger: locationContractLedger?.status === "passed",
  };
}

function dedupeRequirements(requirements) {
  const seen = new Set();
  const out = [];
  for (const req of requirements) {
    if (!req?.ref_id || seen.has(req.ref_id)) continue;
    seen.add(req.ref_id);
    out.push(req);
  }
  return out;
}

function hardenPrompt(prompt, indexes) {
  return sanitizePrompt(prompt, indexes);
}

function normalizePromptFormatting(value) {
  return String(value ?? "");
}

function manifestNameSet(values) {
  return new Set((Array.isArray(values) ? values : []).map(normalize).filter(Boolean));
}

function characterRefNameMatches(ref, names) {
  const labels = [
    ref?.character,
    ref?.subject,
    ...(ref ? characterAliases(ref) : []),
  ].map(normalize).filter(Boolean);
  return labels.some((label) => names.has(label) || [...names].some((name) => label.includes(name) || name.includes(label)));
}

function targetReferencePath(target) {
  return target?.conditioning_image_path ?? target?.reference_image_path ?? target?.required_reference_path ?? target?.path ?? null;
}

function targetAttachable(target) {
  return Boolean(targetReferencePath(target));
}

function targetGenerationMode(target) {
  return String(target?.generation_mode ?? "").trim().toLowerCase();
}

function targetScopedToPrompt(target, prompt) {
  const sceneIds = Array.isArray(target?.scene_ids) ? target.scene_ids.map(String).filter(Boolean) : [];
  if (!sceneIds.length) return true;
  const sceneId = String(prompt?.scene_id ?? "");
  return sceneIds.includes(sceneId) || sceneIds.includes("*");
}

function attachableCharacterRefsForVisibleName(indexes, prompt, visibleName) {
  const names = manifestNameSet([visibleName]);
  const matches = [];
  for (const target of indexes.referenceById.values()) {
    if (referenceKindRank(target?.kind) !== 0) continue;
    if (!targetAttachable(target)) continue;
    if (!targetScopedToPrompt(target, prompt)) continue;
    if (!characterRefNameMatches(target, names)) continue;
    matches.push(target);
  }
  return matches;
}

function attachableCharacterRefsForVisibleNameAnyScope(indexes, visibleName) {
  const names = manifestNameSet([visibleName]);
  const matches = [];
  for (const target of indexes.referenceById.values()) {
    if (referenceKindRank(target?.kind) !== 0) continue;
    if (!targetAttachable(target)) continue;
    if (!characterRefNameMatches(target, names)) continue;
    matches.push(target);
  }
  return matches;
}

const weakCharacterAnchorWords = new Set([
  "a", "an", "and", "are", "as", "at", "body", "character", "clothes", "clothing", "costume", "face", "for",
  "from", "hair", "identity", "image", "in", "is", "man", "male", "match", "of", "on", "outfit", "person",
  "preserve", "reference", "ref", "source", "the", "this", "to", "wardrobe", "wear", "wearing", "with", "woman",
]);

function meaningfulAnchorTokens(value) {
  return [...new Set(normalize(value).split(/\s+/).filter((token) => (
    token.length >= 4
    && !weakCharacterAnchorWords.has(token)
    && !/^\d+$/.test(token)
  )))];
}

function promptFieldValues(prompt) {
  return [
    ["modelslab_image_prompt", prompt.modelslab_image_prompt ?? prompt.image_prompt ?? ""],
    ["codex_image_prompt", prompt.codex_image_prompt ?? ""],
  ].filter(([, value]) => String(value ?? "").trim());
}

function promptContainsCharacterAnchor(promptTextValue, target, characterName) {
  const text = normalize(promptTextValue);
  const nameTokens = normalize(characterName || target?.character || target?.subject || "").split(/\s+/).filter(Boolean);
  const namePresent = nameTokens.some((token) => token.length >= 3 && text.includes(token));
  const anchor = target?.scene_prompt_anchor ?? target?.state_contract ?? "";
  const anchorTokens = meaningfulAnchorTokens(anchor);
  if (!anchorTokens.length) return true;
  const fullName = nameTokens.join(" ");
  const clauses = String(promptTextValue ?? "")
    .split(/(?<=[.!?])\s+|\n+|;+/)
    .map((clause) => normalize(clause))
    .filter(Boolean);
  const characterClauses = clauses.filter((clause) => (
    (fullName && clause.includes(fullName))
    || nameTokens.some((token) => token.length >= 3 && clause.includes(token))
  ));
  const characterWindow = characterClauses.length
    ? characterClauses.sort((a, b) => (
        anchorTokens.filter((token) => b.includes(token)).length - anchorTokens.filter((token) => a.includes(token)).length
      ))[0]
    : text;
  const hits = anchorTokens.filter((token) => characterWindow.includes(token)).length;
  const requiredHits = Math.min(4, Math.max(2, Math.ceil(anchorTokens.length * 0.35)));
  return namePresent && hits >= requiredHits;
}

function promptAnchorNonNameHitScore(promptTextValue, target, characterName) {
  const text = normalize(promptTextValue);
  const nameTokens = normalize(characterName || target?.character || target?.subject || "").split(/\s+/).filter(Boolean);
  const anchor = target?.scene_prompt_anchor ?? target?.state_contract ?? target?.prompt_anchor ?? "";
  const anchorTokens = meaningfulAnchorTokens(anchor)
    .filter((token) => !nameTokens.includes(token));
  return anchorTokens.filter((token) => text.includes(token)).length;
}

function promptContainsBasicCharacterStaging(promptTextValue, target, characterName, req = {}) {
  const text = normalize(promptTextValue);
  const nameTokens = normalize(characterName || target?.character || target?.subject || "").split(/\s+/).filter(Boolean);
  const namePresent = nameTokens.some((token) => token.length >= 3 && text.includes(token));
  if (!namePresent) return false;
  const partialUsage = /\b(?:partial|insert|hand|edge|background|distant|face continuity|screen|crowd|faction)\b/i.test([
    req?.slot_purpose,
    req?.reason,
    promptTextValue,
  ].filter(Boolean).join(" "));
  const stagingTokens = [
    "frame", "foreground", "background", "center", "left", "right", "standing", "kneeling", "seated", "walking",
    "wearing", "clothes", "clothing", "uniform", "suit", "dress", "coat", "hair", "face", "eyes", "posture",
    "expression", "hands", "body", "torso", "shoulders", "pose", "holding", "carrying", "turning", "watching",
  ];
  if (!stagingTokens.some((token) => text.includes(token))) return false;
  return partialUsage || promptAnchorNonNameHitScore(promptTextValue, target, characterName) >= 2;
}

function promptAnchorHitScore(promptTextValue, target, characterName) {
  const text = normalize(promptTextValue);
  const nameTokens = normalize(characterName || target?.character || target?.subject || "").split(/\s+/).filter(Boolean);
  const namePresent = nameTokens.some((token) => token.length >= 3 && text.includes(token));
  if (!namePresent) return 0;
  const anchor = target?.scene_prompt_anchor ?? target?.state_contract ?? target?.prompt_anchor ?? "";
  const anchorTokens = meaningfulAnchorTokens(anchor);
  if (!anchorTokens.length) return 0;
  return anchorTokens.filter((token) => text.includes(token)).length;
}

function targetIsDerivedContract(target) {
  return /^derive_from_/.test(targetGenerationMode(target));
}

function targetIsLocationContract(target) {
  if (!target || String(target.kind ?? "").toLowerCase() !== "location") return false;
  if (targetAttachable(target)) return true;
  return targetIsDerivedContract(target);
}

function sanitizeRequirementFromRefId(refId, indexes, base = {}) {
  refId = indexes.refIdByStateId?.get(refId) ?? refId;
  const target = indexes.referenceById.get(refId);
  if (!target) return null;
  const rawKind = String(base.kind ?? target.kind ?? "").toLowerCase();
  const isCharacter = rawKind.includes("character");
  const baseIdentityRefId = target.base_identity_ref_id ?? target.base_identity_ref ?? null;
  const faceOnly = isCharacter && String(target.identity_usage ?? "").toLowerCase() === "face_only" && baseIdentityRefId;
  const targetPath = targetReferencePath(target);
  const shouldFallbackToBase = faceOnly && !targetPath;
  const selectedRefId = shouldFallbackToBase ? baseIdentityRefId : refId;
  const selectedTarget = shouldFallbackToBase ? (indexes.referenceById.get(selectedRefId) ?? target) : target;
  const kind = isCharacter ? "character_state" : (base.kind ?? target.kind ?? "source_anchor");
  const subject = target.character ?? target.subject ?? refId;
  return {
    ...base,
    ref_id: selectedRefId,
    kind,
    required: base.required !== false,
    slot_order: Number(base.slot_order ?? 50),
    slot_purpose: base.slot_purpose ?? (
      isCharacter
        ? (faceOnly ? `face-only identity anchor for ${subject}` : `character identity and wardrobe for ${subject}`)
        : `${kind} reference for ${target.subject ?? selectedRefId}`
    ),
    reason: base.reason ?? "Sanitizer: LLM-selected or manifest-required reference validated against approved reference ledger.",
    source_state_ref_id: faceOnly ? refId : base.source_state_ref_id,
    base_identity_ref_id: faceOnly ? baseIdentityRefId : base.base_identity_ref_id,
    identity_usage: faceOnly ? "face_only" : base.identity_usage,
    state_contract: faceOnly ? (target.scene_prompt_anchor ?? target.prompt_anchor ?? "") : base.state_contract,
    reference_image_path: targetReferencePath(selectedTarget),
  };
}

function refSelectionIds(req) {
  return [req?.ref_id, req?.source_state_ref_id].filter(Boolean).map(String);
}

function stateIdFromWardrobeFrom(value) {
  const match = String(value ?? "").trim().match(/^character_state_ref:(.+)$/i);
  return match ? match[1].trim() : "";
}

function promptMatchedStateRefId(rawRefId, prompt, indexes) {
  const lookupRefId = indexes.refIdByStateId?.get(String(rawRefId)) ?? String(rawRefId);
  const target = indexes.referenceById.get(lookupRefId);
  if (!target || referenceKindRank(target.kind) !== 0) return "";
  const promptBody = promptFieldValues(prompt).map(([, value]) => value).join("\n");
  const targetSource = String(target.source_ref_id ?? target.ref_id ?? lookupRefId);
  const candidates = [];
  for (const candidate of indexes.referenceById.values()) {
    if (!candidate?.ref_id || candidate.ref_id === lookupRefId) continue;
    if (referenceKindRank(candidate.kind) !== 0) continue;
    if (!targetScopedToPrompt(candidate, prompt)) continue;
    if (String(candidate.source_ref_id ?? candidate.ref_id) !== targetSource) continue;
    const candidateAnchor = normalize(candidate.scene_prompt_anchor ?? candidate.state_contract ?? candidate.prompt_anchor ?? "");
    const promptNorm = normalize(promptBody);
    if (/\b(?:old|past|former|weaker|subservient|humiliation footage|screen footage)\b/.test(candidateAnchor)
      && /\b(?:present time|current|foreground subject|main physical subject)\b/.test(promptNorm)) {
      continue;
    }
    const score = promptAnchorHitScore(promptBody, candidate, candidate.character ?? candidate.subject);
    if (score >= 2) candidates.push({ candidate, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.candidate?.ref_id ?? "";
}

function requirementRefIdForPrompt(rawRefId, req, prompt, indexes) {
  const lookupRefId = indexes.refIdByStateId?.get(String(rawRefId)) ?? String(rawRefId);
  const target = indexes.referenceById.get(lookupRefId);
  if (!target || referenceKindRank(req?.kind ?? target.kind) !== 0) return lookupRefId;
  const staging = Array.isArray(prompt?.shot_manifest?.character_staging) ? prompt.shot_manifest.character_staging : [];
  const candidates = [
    ...staging.map((entry) => stateIdFromWardrobeFrom(entry?.wardrobe_from)).filter(Boolean),
    ...staging.map((entry) => String(entry?.ref_id ?? "").trim()).filter(Boolean),
    ...(Array.isArray(prompt?.shot_manifest?.character_state_ref_ids) ? prompt.shot_manifest.character_state_ref_ids.map(String) : []),
    prompt?.shot_manifest?.protagonist_state_ref_id ? String(prompt.shot_manifest.protagonist_state_ref_id) : "",
  ].filter(Boolean);
  if (target.base_identity_ref_id && String(target.base_identity_ref_id) !== lookupRefId && targetAttachable(target)) {
    return lookupRefId;
  }
  for (const candidate of candidates) {
    const canonicalCandidate = indexes.refIdByStateId?.get(candidate) ?? candidate;
    const candidateTarget = indexes.referenceById.get(canonicalCandidate);
    if (!candidateTarget || canonicalCandidate === lookupRefId) continue;
    const candidateSource = String(candidateTarget.source_ref_id ?? "");
    const targetSource = String(target.source_ref_id ?? target.ref_id ?? lookupRefId);
    const candidateBaseIdentity = String(candidateTarget.base_identity_ref_id ?? candidateTarget.base_identity_ref ?? "");
    if (candidateBaseIdentity && candidateBaseIdentity === lookupRefId && targetAttachable(candidateTarget)) return canonicalCandidate;
    if (candidateSource && targetSource && candidateSource === targetSource) return canonicalCandidate;
  }
  const promptMatchedState = promptMatchedStateRefId(lookupRefId, prompt, indexes);
  if (promptMatchedState) return promptMatchedState;
  return lookupRefId;
}

function genericVisibleGroupName(value) {
  const text = normalize(value);
  if (!text) return true;
  if (/\b(?:men|women|clerks|priests|guards|students|citizens|crowd|crowds|witnesses|workers|staff|audience|spectators|officials|soldiers|nobles|reporters|followers)\b/.test(text)) return true;
  if (/\b[a-z]+\s+s\b/.test(text)) return true;
  return false;
}

function isReferenceLimitOmission(prompt, refId) {
  const wanted = String(refId ?? "").trim();
  if (!wanted) return false;
  return (prompt.reference_usage ?? []).some((usage) => (
    String(usage?.ref_id ?? "").trim() === wanted
    && String(usage?.usage ?? "").trim() === "available_not_attached_reference_limit"
  ));
}

function looksLikePhysicalLocation(prompt, promptTextValue) {
  const text = [
    prompt.location,
    prompt.shot_manifest?.foreground_action,
    promptTextValue,
  ].filter(Boolean).join(" ");
  return /\b(?:apartment|kitchen|bedroom|bathroom|gym|treadmill|office|workplace|cubicle|support desk|street|sidewalk|porch|bridge|lobby|elevator|coffee shop|courthouse|corridor|hallway|hall|boardroom|conference|stage|auditorium|arena|courtyard|chapel|cathedral|academy|campus|manor|station|facility|booth|hotel|tower|clinic|dental|warehouse|room|table|dining)\b/i.test(text);
}

function sanitizePrompt(prompt, indexes) {
  const findings = [];
  const shotManifest = sanitizeShotManifest(prompt.shot_manifest);
  const forbiddenRefs = new Set((shotManifest?.forbidden_ref_ids ?? []).map(String));
  const mentionedOnly = manifestNameSet(shotManifest?.mentioned_only_characters);
  const visibleNames = manifestNameSet(shotManifest?.visible_characters);
  const requestedLocationContractId = shotManifest?.location_contract_id ? String(shotManifest.location_contract_id) : null;
  const requestedLocationRefId = shotManifest?.location_ref_id ? String(shotManifest.location_ref_id) : null;
  const requestedCharacterRefIds = (shotManifest?.character_state_ref_ids ?? []).map((refId) => indexes.refIdByStateId?.get(String(refId)) ?? String(refId));
  if (shotManifest) {
    shotManifest.character_state_ref_ids = requestedCharacterRefIds;
    if (shotManifest.protagonist_state_ref_id) {
      shotManifest.protagonist_state_ref_id = indexes.refIdByStateId?.get(String(shotManifest.protagonist_state_ref_id)) ?? String(shotManifest.protagonist_state_ref_id);
    }
  }
  const requestedLocationContract = requestedLocationContractId
    ? indexes.locationContractById?.get(requestedLocationContractId)
    : null;
  if (requestedLocationContractId && !requestedLocationContract) {
    findings.push({
      image_id: prompt.image_id,
      scene_id: prompt.scene_id,
      severity: "blocker",
      code: "unknown_location_contract_id",
      message: `Shot manifest requested unknown textual location contract ${requestedLocationContractId}.`,
      resolved: false,
    });
  } else if (requestedLocationContract && !sceneIdsCover(requestedLocationContract.scene_ids, prompt.scene_id)) {
    findings.push({
      image_id: prompt.image_id,
      scene_id: prompt.scene_id,
      severity: "blocker",
      code: "out_of_scope_location_contract_id",
      message: `Textual location contract ${requestedLocationContractId} is not scoped to scene ${prompt.scene_id}.`,
      resolved: false,
    });
  }
  let promptTextValue = trackedMutation(
    "normalizePromptFormatting",
    prompt.modelslab_image_prompt ?? prompt.image_prompt ?? "",
    (value) => normalizePromptFormatting(value),
    { prompt }
  );
  let codexPromptTextValue = prompt.codex_image_prompt
    ? trackedMutation("normalizePromptFormatting", prompt.codex_image_prompt, (value) => normalizePromptFormatting(value), { prompt })
    : null;

  const inputRequirements = Array.isArray(prompt.reference_requirements) ? prompt.reference_requirements : [];
  const accepted = [];
  for (const req of inputRequirements) {
    if (!req?.ref_id) {
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "blocker",
        code: "reference_missing_ref_id",
        message: "A reference requirement is missing ref_id.",
        resolved: false,
      });
      continue;
    }
    const rawRefId = String(req.ref_id);
    const lookupRefId = requirementRefIdForPrompt(rawRefId, req, prompt, indexes);
    const target = indexes.referenceById.get(lookupRefId);
    if (!target) {
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "blocker",
        code: "unknown_reference_id",
        message: `Reference id ${rawRefId} is not present in approved reference artifacts.`,
        resolved: false,
      });
      continue;
    }
    if (forbiddenRefs.has(rawRefId)) {
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "warning",
        code: "shot_manifest_forbidden_ref_stripped",
        message: `Shot manifest forbade ref stripped before imagegen: ${rawRefId}.`,
        resolved: true,
      });
      continue;
    }
    const canonical = sanitizeRequirementFromRefId(lookupRefId, indexes, req);
    const selectedTargetForPath = indexes.referenceById.get(canonical.ref_id) ?? indexes.referenceById.get(canonical.source_state_ref_id) ?? target;
    if (!targetAttachable(selectedTargetForPath)) {
      if (targetGenerationMode(selectedTargetForPath).startsWith("derive_from_")) {
        accepted.push({
          ...canonical,
          reference_image_path: null,
          pending_derived_reference: true,
        });
        findings.push({
          image_id: prompt.image_id,
          scene_id: prompt.scene_id,
          severity: "warning",
          code: "pending_derived_reference_retained",
          message: `Reference ${rawRefId} is pending a clean derived seed; its authored requirement is retained without an image slot so imagegen can attach it after promotion.`,
          ref_id: rawRefId,
          resolved: true,
        });
        continue;
      }
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "warning",
        code: "non_attachable_reference_stripped",
        message: `Reference ${rawRefId} is a scoped text-only or derive-later target with no generated/source image path, so it was stripped from image inputs.`,
        ref_id: rawRefId,
        resolved: true,
      });
      continue;
    }
    const selectedIds = refSelectionIds(canonical);
    if (selectedIds.some((id) => forbiddenRefs.has(id))) {
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "warning",
        code: "shot_manifest_forbidden_ref_stripped",
        message: `Shot manifest forbade ref stripped before imagegen: ${selectedIds.find((id) => forbiddenRefs.has(id))}.`,
        resolved: true,
      });
      continue;
    }
    const canonicalTarget = indexes.referenceById.get(canonical.source_state_ref_id ?? canonical.ref_id) ?? target;
    if (referenceKindRank(canonical.kind) === 0 && mentionedOnly.size && characterRefNameMatches(canonicalTarget, mentionedOnly) && !characterRefNameMatches(canonicalTarget, visibleNames)) {
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "blocker",
        code: "mentioned_only_character_ref_attached",
        message: `Character ref ${rawRefId} is attached, but shot_manifest marks that character as mentioned-only. Replan or review this cut; harden will not decide whether to show the character.`,
        resolved: false,
      });
    }
    accepted.push(canonical);
  }

  for (const refId of requestedCharacterRefIds) {
    if (accepted.some((req) => refSelectionIds(req).includes(refId))) continue;
    if (forbiddenRefs.has(refId)) continue;
    if (indexes.referenceById.has(refId)) {
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "warning",
        code: "manifest_character_ref_not_attached_report_only",
        message: `Shot manifest declares character ref ${refId}, but harden will not add refs the LLM omitted from reference_requirements.`,
        resolved: true,
      });
    } else {
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "blocker",
        code: "unknown_manifest_character_ref",
        message: `Shot manifest requested unknown character ref ${refId}.`,
        resolved: false,
      });
    }
  }

  for (const visibleName of (shotManifest?.visible_characters ?? [])) {
    if (genericVisibleGroupName(visibleName)) continue;
    const visibleNameSet = manifestNameSet([visibleName]);
    const alreadyAttached = accepted.some((req) => {
      const target = indexes.referenceById.get(req.source_state_ref_id ?? req.ref_id) ?? indexes.referenceById.get(req.ref_id);
      return referenceKindRank(req.kind) === 0 && characterRefNameMatches(target, visibleNameSet);
    });
    if (alreadyAttached) continue;
    const availableRefs = attachableCharacterRefsForVisibleName(indexes, prompt, visibleName);
    if (!availableRefs.length) {
      const outOfScopeRefs = attachableCharacterRefsForVisibleNameAnyScope(indexes, visibleName);
      if (outOfScopeRefs.length) {
        findings.push({
          image_id: prompt.image_id,
          scene_id: prompt.scene_id,
          severity: "blocker",
          code: "visible_character_ref_scope_missing",
          message: `Shot manifest shows ${visibleName}, but matching attachable character ref(s) ${outOfScopeRefs.map((ref) => ref.ref_id).slice(0, 4).join(", ")} are not scoped to scene ${prompt.scene_id}. Repair the reference scope or author an explicit approved state before imagegen; harden will not guess the replacement ref.`,
          character: visibleName,
          out_of_scope_ref_ids: outOfScopeRefs.map((ref) => ref.ref_id),
          resolved: false,
        });
      }
      continue;
    }
    findings.push({
      image_id: prompt.image_id,
      scene_id: prompt.scene_id,
      severity: "blocker",
      code: "visible_character_ref_not_attached",
      message: `Shot manifest shows ${visibleName}, but scoped attachable character ref(s) ${availableRefs.map((ref) => ref.ref_id).slice(0, 4).join(", ")} were not attached. Replan or manually attach the visible character ref before imagegen.`,
      character: visibleName,
      available_ref_ids: availableRefs.map((ref) => ref.ref_id),
      resolved: false,
    });
  }

  for (const req of accepted) {
    if (referenceKindRank(req.kind) !== 0) continue;
    const target = indexes.referenceById.get(req.source_state_ref_id ?? req.ref_id) ?? indexes.referenceById.get(req.ref_id);
    const anchor = target?.scene_prompt_anchor ?? target?.state_contract ?? "";
    if (!String(anchor ?? "").trim()) continue;
    const characterName = target?.character ?? target?.subject ?? req.ref_id;
    for (const [field, value] of promptFieldValues({
      modelslab_image_prompt: promptTextValue,
      image_prompt: promptTextValue,
      codex_image_prompt: codexPromptTextValue,
    })) {
      if (promptContainsCharacterAnchor(value, target, characterName)) continue;
      const hasBasicStaging = promptContainsBasicCharacterStaging(value, target, characterName, req);
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: hasBasicStaging ? "warning" : "blocker",
        code: "character_ref_anchor_not_reaffirmed",
        message: hasBasicStaging
          ? `${field} attaches ${req.ref_id} and includes basic character staging, but does not reaffirm enough of the full reference anchor. This is report-only; imagegen will still receive the attached reference role.`
          : `${field} attaches ${req.ref_id}, but the prompt does not reaffirm enough of its character anchor. Restate the character name, position, face/body/wardrobe anchor, and current pose/action in the prompt body before imagegen.`,
        ref_id: req.ref_id,
        prompt_field: field,
        character: characterName,
        required_anchor: anchor,
        resolved: hasBasicStaging,
      });
    }
  }

  const requestedLocationOmittedForRefLimit = requestedLocationRefId && isReferenceLimitOmission(prompt, requestedLocationRefId);
  const requestedLocationTarget = requestedLocationRefId ? indexes.referenceById.get(requestedLocationRefId) : null;
  const requestedLocationAttachable = requestedLocationTarget ? targetAttachable(requestedLocationTarget) : false;

  if (requestedLocationContractId && requestedLocationTarget) {
    const targetContractIds = (requestedLocationTarget.location_contract_ids ?? []).map(String).filter(Boolean);
    if (targetContractIds.length && !targetContractIds.includes(requestedLocationContractId)) {
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "blocker",
        code: "location_ref_contract_mismatch",
        message: `Location image ref ${requestedLocationRefId} does not cover textual location contract ${requestedLocationContractId}.`,
        resolved: false,
      });
    }
  }

  if (requestedLocationRefId && !requestedLocationOmittedForRefLimit && requestedLocationTarget && !requestedLocationAttachable) {
    findings.push({
      image_id: prompt.image_id,
      scene_id: prompt.scene_id,
      severity: "warning",
      code: "manifest_location_ref_text_only",
      message: `Shot manifest location ref ${requestedLocationRefId} is scoped text-only or derive-later with no generated/source image path; harden will keep the prose location but not require an image input.`,
      ref_id: requestedLocationRefId,
      resolved: true,
    });
  } else if (requestedLocationRefId && !requestedLocationOmittedForRefLimit) {
    const locationReqs = accepted.filter((req) => referenceKindRank(req.kind) === 1);
    const mismatched = locationReqs.filter((req) => req.ref_id !== requestedLocationRefId);
    if (mismatched.length) {
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "blocker",
        code: "manifest_location_ref_mismatch",
        message: `Shot manifest location ${requestedLocationRefId} differs from attached location refs ${mismatched.map((req) => req.ref_id).join(", ")}. Replan or review this cut; harden will not replace LLM refs.`,
        resolved: false,
      });
    }
    if (!accepted.some((req) => req.ref_id === requestedLocationRefId)) {
      if (indexes.referenceById.has(requestedLocationRefId)) {
        findings.push({
          image_id: prompt.image_id,
          scene_id: prompt.scene_id,
          severity: "warning",
          code: "manifest_location_ref_not_attached_report_only",
          message: `Shot manifest declares location ref ${requestedLocationRefId}, but harden will not add refs the LLM omitted from reference_requirements.`,
          resolved: true,
        });
      } else {
        findings.push({
          image_id: prompt.image_id,
          scene_id: prompt.scene_id,
          severity: "blocker",
          code: "unknown_manifest_location_ref",
          message: `Shot manifest requested unknown location ref ${requestedLocationRefId}.`,
          resolved: false,
        });
      }
    }
  } else if (requestedLocationOmittedForRefLimit) {
    findings.push({
      image_id: prompt.image_id,
      scene_id: prompt.scene_id,
      severity: "warning",
      code: "manifest_location_ref_omitted_for_reference_limit",
      message: `Location ref ${requestedLocationRefId} is declared in the manifest but intentionally omitted because higher-priority visible refs consume the max ${maxRefs} reference slots.`,
      resolved: true,
    });
  }

  const deduped = dedupeRequirements(accepted);
  const selectedRequirements = deduped.map((req, index) => ({ ...req, slot_order: index + 1 }));
  if (deduped.length > maxRefs) {
    findings.push({
      image_id: prompt.image_id,
      scene_id: prompt.scene_id,
      severity: "blocker",
      code: "reference_limit_exceeded",
      message: `LLM selected ${deduped.length} refs, above max ${maxRefs}. Harden will not trim creative ref selection; replan this cut.`,
      resolved: false,
    });
  }

  if (shotManifest) {
    const selectedCharacterManifestIds = [...new Set(selectedRequirements
      .filter((req) => referenceKindRank(req.kind) === 0)
      .map((req) => String(req.source_state_ref_id ?? req.ref_id ?? "").trim())
      .filter(Boolean))];
    if (selectedCharacterManifestIds.length) {
      const previousCharacterIds = shotManifest.character_state_ref_ids ?? [];
      shotManifest.character_state_ref_ids = selectedCharacterManifestIds;
      const primaryNameSet = manifestNameSet([
        shotManifest.primary_character,
        prompt.primary_subject,
      ].filter(Boolean));
      const protagonistCandidate = selectedRequirements
        .filter((req) => referenceKindRank(req.kind) === 0)
        .find((req) => {
          const target = indexes.referenceById.get(req.source_state_ref_id ?? req.ref_id) ?? indexes.referenceById.get(req.ref_id);
          return primaryNameSet.size && characterRefNameMatches(target, primaryNameSet);
        });
      shotManifest.protagonist_state_ref_id = protagonistCandidate
        ? String(protagonistCandidate.source_state_ref_id ?? protagonistCandidate.ref_id)
        : selectedCharacterManifestIds.includes(String(shotManifest.protagonist_state_ref_id ?? ""))
          ? shotManifest.protagonist_state_ref_id
          : selectedCharacterManifestIds[0];
      if (JSON.stringify(previousCharacterIds) !== JSON.stringify(shotManifest.character_state_ref_ids)) {
        findings.push({
          image_id: prompt.image_id,
          scene_id: prompt.scene_id,
          severity: "warning",
          code: "shot_manifest_character_refs_synchronized",
          message: "Synchronized shot_manifest character refs to the canonical selected character_state reference requirements; no new refs were authored.",
          previous_character_state_ref_ids: previousCharacterIds,
          character_state_ref_ids: shotManifest.character_state_ref_ids,
          resolved: true,
        });
      }
    }
  }

  const selectedIds = new Set(selectedRequirements.flatMap(refSelectionIds));
  const referenceSlots = selectedRequirements
    .filter((req) => String(req.reference_image_path ?? "").trim())
    .map((req, index) => ({
      slot: index + 1,
      ref_id: req.ref_id,
      kind: req.kind ?? null,
      path: req.reference_image_path,
      purpose: req.slot_purpose ?? null,
      reason: req.reason ?? null,
    }));
  for (const refId of requestedCharacterRefIds) {
    if (!selectedIds.has(refId)) {
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "warning",
        code: "manifest_character_ref_missing_report_only",
        message: `Shot manifest expected character ref ${refId}, but harden will not alter the LLM reference selection.`,
        resolved: true,
      });
    }
  }
  if (requestedLocationRefId && requestedLocationAttachable && !requestedLocationOmittedForRefLimit && !selectedRequirements.some((req) => req.ref_id === requestedLocationRefId)) {
    findings.push({
      image_id: prompt.image_id,
      scene_id: prompt.scene_id,
      severity: "blocker",
      code: "manifest_location_ref_missing_after_sanitize",
      message: `Shot manifest expected location ref ${requestedLocationRefId}, but it is not selected after sanitation.`,
      resolved: false,
    });
  }
  if (indexes.usesLocationContractLedger
    && !requestedLocationContractId
    && looksLikePhysicalLocation(prompt, promptTextValue)) {
    const inScopeLocationContracts = indexes.locationContracts.filter((contract) => sceneIdsCover(contract.scene_ids, prompt.scene_id));
    const hasInScopeLocationContract = inScopeLocationContracts.length > 0;
    findings.push({
      image_id: prompt.image_id,
      scene_id: prompt.scene_id,
      severity: hasInScopeLocationContract ? "blocker" : "warning",
      code: "physical_location_contract_missing",
      message: hasInScopeLocationContract
        ? `Prompt describes a physical environment, but shot_manifest.location_contract_id is empty. Available in-scope textual contracts: ${inScopeLocationContracts.map((contract) => contract.location_contract_id).join(", ")}.`
        : "Prompt describes a physical environment, but the location-contract ledger has no in-scope contract for this scene.",
      resolved: !hasInScopeLocationContract,
    });
  } else if (!indexes.usesLocationContractLedger
    && !requestedLocationRefId
    && !selectedRequirements.some((req) => referenceKindRank(req.kind) === 1)
    && looksLikePhysicalLocation(prompt, promptTextValue)) {
    const inScopeLocationRefs = indexes.locationTargets.filter((target) => sceneIdsCover(target.scene_ids, prompt.scene_id) && targetIsLocationContract(target));
    const hasInScopeLocationRef = inScopeLocationRefs.length > 0;
    findings.push({
      image_id: prompt.image_id,
      scene_id: prompt.scene_id,
      severity: hasInScopeLocationRef ? "blocker" : "warning",
      code: "physical_location_ref_missing",
      message: hasInScopeLocationRef
        ? `Legacy prompt describes a physical environment without its in-scope location ref contract: ${inScopeLocationRefs.map((target) => target.ref_id).join(", ")}.`
        : "Legacy prompt describes a physical environment, but no in-scope location ref contract exists.",
      resolved: !hasInScopeLocationRef,
    });
  }
  for (const refId of forbiddenRefs) {
    if (selectedIds.has(refId)) {
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "blocker",
        code: "shot_manifest_forbidden_ref_attached",
        message: `Shot manifest forbids ref ${refId}, but it is still selected after sanitation.`,
        resolved: false,
      });
    }
  }
  const selectedLocationRefId = requestedLocationRefId ?? selectedRequirements.find((req) => referenceKindRank(req.kind) === 1)?.ref_id ?? null;
  for (const mention of outOfScopeLocationRefMentions({
    text: [promptTextValue, codexPromptTextValue].filter(Boolean).join(" "),
    locationTargets: indexes.locationTargets,
    allowedLocationRefId: selectedLocationRefId,
  })) {
    findings.push({
      image_id: prompt.image_id,
      scene_id: prompt.scene_id,
      severity: "blocker",
      code: mention.code,
      message: mention.message,
      ref_id: mention.ref_id,
      resolved: false,
    });
  }
  findings.push(...providerExclusionPayloadFindings([{
    image_id: prompt.image_id,
    scene_id: prompt.scene_id,
    image_prompt: promptTextValue,
    modelslab_image_prompt: promptTextValue,
    codex_image_prompt: codexPromptTextValue,
  }]));
  findings.push(...beautyLanguageFindings([{
    image_id: prompt.image_id,
    scene_id: prompt.scene_id,
    image_prompt: promptTextValue,
    modelslab_image_prompt: promptTextValue,
    codex_image_prompt: codexPromptTextValue,
  }]));
  findings.push(...namedCharacterDuplicationFindings([{
    image_id: prompt.image_id,
    scene_id: prompt.scene_id,
    image_prompt: promptTextValue,
    modelslab_image_prompt: promptTextValue,
    codex_image_prompt: codexPromptTextValue,
    shot_manifest: shotManifest,
  }]));

  return {
    prompt: {
      ...prompt,
      image_prompt: promptTextValue,
      modelslab_image_prompt: promptTextValue,
      codex_image_prompt: codexPromptTextValue,
      prompt_hash: sha256(promptTextValue),
      reference_requirements: selectedRequirements,
      required_reference_paths: referenceSlots.map((slot) => slot.path),
      reference_slots: referenceSlots,
      reference_usage: selectedRequirements.map((req) => ({
        ref_id: req.ref_id,
        usage: "attach_existing_ref",
        reason: req.reason ?? "Sanitizer: validated LLM-authored reference selection.",
      })),
      shot_manifest: shotManifest,
      hardening_notes: [
        ...(prompt.hardening_notes ?? []),
        "visual-prompt-harden sanitize mode: validated LLM-authored refs, normalized approved ref IDs, stripped forbidden refs, enforced max ref count; no creative prompt rewrite.",
      ],
    },
    findings,
  };
}

function selectSamples(prompts) {
  const selected = [];
  const seen = new Set();
  const add = (prompt, reason) => {
    if (!prompt || seen.has(prompt.image_id) || selected.length >= sampleCount) return;
    seen.add(prompt.image_id);
    selected.push({ image_id: prompt.image_id, reason });
  };
  const find = (predicate) => prompts.find((prompt) => !seen.has(prompt.image_id) && predicate(prompt));
  add(prompts[0], "first cut hook");
  add(find((p) => (p.reference_requirements ?? []).some((r) => String(r.kind).includes("location"))), "location-anchor cut");
  add(find((p) => /mentor|elder|teacher|judge|authority|director|dean|boss|officer|captain|leader|moderator|host/i.test(promptText(p))), "authority or mentor role cut");
  add(find((p) => /rival|antagonist|enemy|traitor|bully|ex|challenger|opponent|competitor/i.test(promptText(p))), "rival or antagonist role cut");
  add(find((p) => /witness|crowd|audience|chat|viewer|spectator|panel|jury|followers/i.test(promptText(p))), "witness or audience reaction cut");
  add(find((p) => (p.reference_requirements ?? []).filter((r) => String(r.kind).includes("character")).length >= 3), "crowded multi-character identity cut");
  add(find((p) => (p.reference_requirements ?? []).filter((r) => String(r.kind).includes("character")).length >= 2), "multi-character identity cut");
  add(find((p) => /strike|palm|blood|sword|attack|duel|impact|break|counter|qi|dantian/i.test(promptText(p))), "action/combat cut");
  add(find((p) => /ledger|window|system|ui|text|screen|seal|document|token|jade|rope/i.test(promptText(p))), "UI/prop/document cut");
  add(find((p) => Number(String(p.image_id ?? "").match(/cut-(\d+)/)?.[1] ?? 0) > 300), "late-episode continuity cut");
  const byLocation = new Set();
  for (const prompt of prompts) {
    const loc = normalize(prompt.location);
    if (loc && !byLocation.has(loc)) {
      byLocation.add(loc);
      add(prompt, `first location block: ${prompt.location}`);
    }
  }
  for (const prompt of prompts) add(prompt, "coverage fill");
  return selected;
}

function sampleMarkdown(prompts, sampleRows, report) {
  const byId = new Map(prompts.map((prompt) => [prompt.image_id, prompt]));
  const title = "Visual Prompt Sanitation Sample";
  const lines = [
    `# ${title}`,
    "",
    `Status: ${report.status}`,
    `Mode: ${report.harden_mode ?? "sanitize"}`,
    `Prompt count: ${prompts.length}`,
    `Unresolved blockers: ${report.unresolved_blocker_count}`,
    "",
  ];
  for (const row of sampleRows) {
    const prompt = byId.get(row.image_id);
    if (!prompt) continue;
    lines.push(`## ${prompt.image_id}`);
    lines.push("");
    lines.push(`Reason: ${row.reason}`);
    lines.push(`Scene: ${prompt.scene_id}`);
    lines.push(`Location: ${prompt.location ?? ""}`);
    lines.push(`Subjects: ${(prompt.visible_subjects ?? []).join(", ")}`);
    lines.push("");
    lines.push("References:");
    for (const req of prompt.reference_requirements ?? []) {
      lines.push(`- ${req.slot_order}. ${req.kind}:${req.ref_id} - ${req.slot_purpose}`);
    }
    if (!(prompt.reference_requirements ?? []).length) lines.push("- none");
    lines.push("");
    lines.push("Prompt:");
    lines.push("");
    lines.push(prompt.modelslab_image_prompt ?? prompt.image_prompt ?? "");
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function manualTriageEntries(manualTriage) {
  if (!manualTriage || typeof manualTriage !== "object") return [];
  const status = String(manualTriage.status ?? "").toLowerCase();
  if (!["approved", "passed"].includes(status)) return [];
  const entries = Array.isArray(manualTriage.dispositions)
    ? manualTriage.dispositions
    : Array.isArray(manualTriage.entries)
      ? manualTriage.entries
      : [];
  return entries.filter((entry) => {
    const disposition = String(entry?.disposition ?? "").toLowerCase();
    return ["manual_disregard", "disregard", "waive", "waived", "bypass"].includes(disposition)
      && entry?.image_id
      && entry?.code
      && (entry?.rationale || entry?.evidence);
  });
}

function applyManualTriage(findings, manualTriage) {
  const entries = manualTriageEntries(manualTriage);
  if (!entries.length) return { findings, applied: [] };
  const applied = [];
  const triagedFindings = findings.map((finding) => {
    if (finding.severity !== "blocker" || finding.resolved === true) return finding;
    const match = entries.find((entry) => (
      String(entry.image_id) === String(finding.image_id)
      && String(entry.code) === String(finding.code)
      && (!entry.scene_id || String(entry.scene_id) === String(finding.scene_id))
    ));
    if (!match) return finding;
    applied.push({
      image_id: finding.image_id,
      scene_id: finding.scene_id,
      code: finding.code,
      disposition: "manual_disregard",
      rationale: match.rationale ?? match.evidence,
    });
    return {
      ...finding,
      severity: "warning",
      resolved: true,
      manual_disposition: "manual_disregard",
      manual_triage_rationale: match.rationale ?? match.evidence,
    };
  });
  return { findings: triagedFindings, applied };
}

async function main() {
  const [promptPlan, timedPlan, visualReferencePlan, characterStateRefs, referenceInventoryLedger, locationContractLedger, manualTriage] = await Promise.all([
    readJson(promptPath, null),
    readJson(timedPlanPath, null),
    readJson(visualReferencePlanPath, null),
    readJson(characterStateRefsPath, null),
    readJson(referenceInventoryLedgerPath, null),
    readJson(locationContractLedgerPath, null),
    readJson(manualTriagePath, null),
  ]);
  if (!Array.isArray(promptPlan?.prompts) || !promptPlan.prompts.length) throw new Error(`Missing prompt plan: ${promptPath}`);
  if (timedPlan?.status !== "passed") throw new Error(`Missing passed timed scene plan: ${timedPlanPath}`);
  if (visualReferencePlan?.status !== "passed") throw new Error(`Missing passed visual reference plan: ${visualReferencePlanPath}`);
  if (visualReferencePlan.reference_director_contract_version === "reference_director_v2"
    && (locationContractLedger?.status !== "passed" || !Array.isArray(locationContractLedger?.contracts))) {
    throw new Error(`Missing passed location contract ledger for reference_director_v2: ${locationContractLedgerPath}`);
  }
  if (!["approved", "passed"].includes(characterStateRefs?.status) && flags["allow-draft-refs"] !== "true") {
    throw new Error(`character_state_refs must be approved before prompt hardening. Current status: ${characterStateRefs?.status ?? "missing"}.`);
  }
  const indexes = buildIndexes(visualReferencePlan, characterStateRefs, referenceInventoryLedger, locationContractLedger);
  const prompts = [];
  const findings = [];
  for (const prompt of promptPlan.prompts) {
    const result = sanitizePrompt(prompt, indexes);
    prompts.push(result.prompt);
    findings.push(...result.findings);
  }
  const triageResult = applyManualTriage(findings, manualTriage);
  const finalFindings = triageResult.findings;
  const unresolvedBlockers = finalFindings.filter((finding) => finding.severity === "blocker" && finding.resolved !== true);
  const status = unresolvedBlockers.length ? "blocked" : "passed";
  const sourcePaths = [promptPath, timedPlanPath, visualReferencePlanPath, characterStateRefsPath, ...(referenceInventoryLedger ? [referenceInventoryLedgerPath] : []), ...(locationContractLedger ? [locationContractLedgerPath] : []), ...(manualTriage ? [manualTriagePath] : [])];
  const sourceHashes = Object.fromEntries((await Promise.all(sourcePaths.map(async (filePath) => [filePath, await hashFile(filePath)]))).filter(([, hash]) => hash));
  const sampleRows = selectSamples(prompts);
  const report = {
    schema: "goldflow_visual_prompt_hardening_v1",
    status,
    channel,
    series_slug: series,
    week,
    episode,
    source_script_hash: promptPlan.source_script_hash,
    source_artifact_paths: sourcePaths,
    source_hashes: sourceHashes,
    input_prompt_count: promptPlan.prompts.length,
    hardened_prompt_count: prompts.length,
    harden_mode: effectiveHardenMode,
    sample_prompt_count: sampleRows.length,
    sample_prompt_ids: sampleRows,
    findings: finalFindings,
    unresolved_blocker_count: unresolvedBlockers.length,
    manual_triage_path: manualTriage ? manualTriagePath : null,
    location_contract_ledger_path: locationContractLedger?.status === "passed" ? locationContractLedgerPath : null,
    manual_triage_applied_count: triageResult.applied.length,
    manual_triage_applied: triageResult.applied,
    hardened_prompt_plan_path: outputPath,
    sample_review_path: samplePath,
    updated_at: new Date().toISOString(),
  };
  const hardenedPlan = {
    ...promptPlan,
    status,
    source_artifact_paths: sourcePaths,
    source_hashes: sourceHashes,
    prompt_policy: "LLM-authored prompts with deterministic sanitation only: approved ref ID/path validation, forbidden-ref stripping, manifest enforcement, and max-reference trimming",
    prompts,
    visual_prompt_hardening_report_path: reportPath,
    visual_prompt_hardening_sample_path: samplePath,
    visual_manual_blocker_triage_path: manualTriage ? manualTriagePath : null,
    updated_at: report.updated_at,
  };
  await writeJson(outputPath, hardenedPlan);
  await writeJson(reportPath, report);
  if (mutationTrackingEnabled) {
    await writeJson(mutationHitsOutputPath, {
      schema: "goldflow_visual_prompt_hardening_mutation_hits_v1",
      status,
      channel,
      series_slug: series,
      week,
      episode,
      harden_mode: effectiveHardenMode,
      prompt_path: promptPath,
      prompt_count: prompts.length,
      functions: [...mutationStats.values()].sort((a, b) => b.changed_count - a.changed_count || b.matched_count - a.matched_count || a.function_name.localeCompare(b.function_name)),
      updated_at: report.updated_at,
    });
  }
  await fs.mkdir(path.dirname(samplePath), { recursive: true });
  await fs.writeFile(samplePath, sampleMarkdown(prompts, sampleRows, report), "utf8");
  console.log(JSON.stringify({ status, output_path: outputPath, report_path: reportPath, sample_path: samplePath, prompt_count: prompts.length, sample_prompt_count: sampleRows.length, unresolved_blocker_count: unresolvedBlockers.length }, null, 2));
  if (status !== "passed") process.exitCode = 1;
}

main().catch(async (error) => {
  const failed = { schema: "goldflow_visual_prompt_hardening_v1", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() };
  await writeJson(reportPath, failed).catch(() => {});
  console.error(failed.error);
  process.exitCode = 1;
});
