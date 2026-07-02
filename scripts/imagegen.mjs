#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promptTextForImageProvider } from "./lib/image-prompt-utils.mjs";
import {
  isCodexImageProvider,
  normalizeImageProvider,
  providerSlug,
  routedProviderForPrompt,
  routedProviderForReference,
} from "./lib/image-provider-routing.mjs";
import { generateCodexImage } from "./codex-image-helper.mjs";
import { generateModelslabImage } from "./modelslab-image-helper.mjs";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeDir = path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode);
const promptPath = flags.prompts ?? path.join(episodeDir, "section_image_prompts_hardened.json");
const visualReferencePlanPath = flags.referencePlan ?? flags["reference-plan"] ?? path.join(episodeDir, "visual_reference_plan.json");
const characterStateRefsPath = flags.characterStateRefs ?? flags["character-state-refs"] ?? path.join(episodeDir, "character_state_refs.json");
const imageDir = path.join(episodeDir, "assets", "images");
const referenceDir = path.join(imageDir, "references");
const reportPath = flags.output ?? path.join(episodeDir, `imagegen_report_${episode}.json`);
const concurrency = Math.max(1, Math.min(24, Number(flags.concurrency ?? process.env.ANIFACTORY_IMAGEGEN_CONCURRENCY ?? 8)));
const referenceConcurrency = Math.max(1, Math.min(8, Number(flags["reference-concurrency"] ?? process.env.ANIFACTORY_REFERENCE_IMAGEGEN_CONCURRENCY ?? 3)));
const force = flags.force === "true";
const forceImages = force || flags["force-images"] === "true";
const forceReferences = force || flags["force-references"] === "true";
const skipReferenceGeneration = flags["skip-reference-generation"] === "true";
const referencesOnly = flags["references-only"] === "true";
const maxSceneReferences = Math.max(0, Math.min(4, Number(flags["max-scene-references"] ?? 4)));
const allowUnhardenedPrompts = flags["allow-unhardened-prompts"] === "true";
const imageModelOverride = flags["image-model-route"] ?? flags["image-model"] ?? null;
const imageProvider = normalizeImageProvider(flags["image-provider"] ?? flags.provider ?? process.env.ANIFACTORY_IMAGE_PROVIDER ?? "modelslab");
const providerFilter = normalizeProviderFilter(flags["provider-filter"] ?? flags.providerFilter ?? "");
const codexOpeningSecFlagRaw = flags["codex-opening-sec"] ?? flags["codex-opening-duration-sec"] ?? null;
const codexOpeningSecEnvRaw = process.env.ANIFACTORY_CODEX_OPENING_SEC ?? null;
let codexOpeningSec = Math.max(0, Number(codexOpeningSecFlagRaw ?? codexOpeningSecEnvRaw ?? 120));
const confirmImageProvider = flags["confirm-image-provider"] === "true";
const allowLegacyCodexExec = flags["allow-legacy-codex-exec"] === "true" || process.env.ANIFACTORY_ALLOW_LEGACY_CODEX_EXEC === "true";
const runIdentityPath = path.join(episodeDir, "run_identity.json");
const visualResolutionDeadletterPath = flags.deadletter ?? flags["deadletter"] ?? path.join(episodeDir, "visual_resolution_deadletter.json");
const derivedRefPromotionReportPath = flags["derived-ref-report"] ?? path.join(episodeDir, `derived_reference_promotion_report_${episode}.json`);
const sceneImageWidth = Number(flags["scene-image-width"] ?? process.env.ANIFACTORY_MODELSLAB_SCENE_IMAGE_WIDTH ?? 1024);
const sceneImageHeight = Number(flags["scene-image-height"] ?? process.env.ANIFACTORY_MODELSLAB_SCENE_IMAGE_HEIGHT ?? 576);
const referenceImageWidth = Number(flags["reference-image-width"] ?? process.env.ANIFACTORY_MODELSLAB_REFERENCE_IMAGE_WIDTH ?? process.env.ANIFACTORY_MODELSLAB_IMAGE_WIDTH ?? 1024);
const referenceImageHeight = Number(flags["reference-image-height"] ?? process.env.ANIFACTORY_MODELSLAB_REFERENCE_IMAGE_HEIGHT ?? process.env.ANIFACTORY_MODELSLAB_IMAGE_HEIGHT ?? 576);
const seedDerivedRefs = flags["seed-derived-refs"] === "true";
const promoteDerivedRefs = flags["promote-derived-refs"] === "true";

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

function normalizeProviderFilter(value) {
  const normalized = String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!normalized || normalized === "all") return null;
  return normalizeImageProvider(normalized);
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

async function exists(filePath) {
  return Boolean(filePath) && fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function assertRunIdentityImageProvider() {
  const runIdentity = await readJson(runIdentityPath, null);
  if (!runIdentity) {
    throw new Error(`Missing run identity preflight: ${runIdentityPath}. Run "goldflow run preflight" before imagegen.`);
  }
  for (const [key, actual, expected] of [
    ["channel", channel, runIdentity.channel],
    ["series", series, runIdentity.series_slug],
    ["week", week, runIdentity.week],
    ["episode", episode, runIdentity.episode],
  ]) {
    if (actual !== expected) throw new Error(`Run identity mismatch for ${key}: command has ${actual}, run_identity.json has ${expected}.`);
  }
  const lockedProvider = normalizeImageProvider(runIdentity.image_provider ?? "modelslab");
  if (lockedProvider !== imageProvider && !confirmImageProvider) {
    throw new Error(`Image provider mismatch: run_identity.json locks ${lockedProvider}, command requested ${imageProvider}. Update preflight or pass --confirm-image-provider true only with operator approval.`);
  }
  return runIdentity;
}

function runIdentityCodexOpeningSec(runIdentity) {
  const raw = runIdentity?.image_provider_options?.codex_opening_sec
    ?? runIdentity?.imageProviderOptions?.codexOpeningSec
    ?? runIdentity?.codex_opening_sec
    ?? null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function resolveCodexOpeningSec(runIdentity) {
  const locked = runIdentityCodexOpeningSec(runIdentity);
  const explicit = codexOpeningSecFlagRaw != null;
  const explicitValue = explicit ? Math.max(0, Number(codexOpeningSecFlagRaw)) : null;
  if (locked !== null) {
    if (
      explicit
      && Number.isFinite(explicitValue)
      && Math.abs(explicitValue - locked) > 0.001
      && !confirmImageProvider
    ) {
      throw new Error(`Codex opening window mismatch: run_identity.json locks ${locked}s, command requested ${explicitValue}s. Update preflight or pass --confirm-image-provider true only with operator approval.`);
    }
    return locked;
  }
  const envValue = Number(codexOpeningSecEnvRaw ?? 120);
  return Number.isFinite(explicitValue) ? explicitValue : (Number.isFinite(envValue) && envValue > 0 ? envValue : 120);
}

function requestedIds() {
  return new Set(String(flags["cut-ids"] ?? flags["image-ids"] ?? flags["image-id"] ?? "").split(",").map((row) => row.trim()).filter(Boolean));
}

function requestedReferenceIds() {
  return new Set(String(flags["reference-ids"] ?? flags["reference-id"] ?? "").split(",").map((row) => row.trim()).filter(Boolean));
}

function promptRoute(prompt) {
  return routedProviderForPrompt(prompt, imageProvider, { codexOpeningSec });
}

function imagePathFor(prompt, provider = promptRoute(prompt)) {
  return path.join(imageDir, `${prompt.image_id}-${providerSlug(provider)}-image.png`);
}

function referencePathFor(target, provider = routedProviderForReference(imageProvider, target)) {
  return path.join(referenceDir, `${target.ref_id}-${providerSlug(provider)}-reference.png`);
}

function referencePrompt(target) {
  const kind = String(target.kind ?? "");
  const kindInstruction = {
    style: "16:9 landscape style reference card: polished 2D anime/manhwa rendering language, clean linework, cel-shaded color, webtoon lighting, and polished production finish",
    character_state: "16:9 landscape single-character identity reference card in polished 2D anime/manhwa style: exactly one visible person, full-body or three-quarter view centered with ample side breathing room, plain neutral studio background, clear face, hair, age, body type, wardrobe, expression, and material details; scene prompts will provide action pose",
    location: "16:9 landscape unoccupied environment-only location plate in polished 2D anime/manhwa style: architecture, scale, lighting, materials, and readable geography, empty space ready for scene characters, non-photorealistic painted background design",
    prop: "16:9 landscape prop reference card in polished 2D anime/manhwa style: one clear object or tightly grouped object set on a plain neutral surface, shape, surface, markings, scale, and material details",
    ui: "16:9 landscape UI reference card in polished 2D anime/manhwa style: interface layout, typography, color, glow, panels, and exact display motif",
    action: "16:9 landscape action and effect reference plate in polished 2D anime/manhwa style: one readable effect shape, movement path, energy color, interaction pattern, and spatial logic on a neutral staging field",
  }[kind] ?? "production reference image";
  const parts = [
    target.prompt_anchor,
    kindInstruction,
    target.subject ? `subject: ${target.subject}` : "",
    "clean production reference, stable visual design, polished 2D anime/manhwa longform frame, clean line art, non-photorealistic rendering, landscape canvas",
  ].filter(Boolean);
  return parts.join(", ");
}

function isDerivedReferenceTarget(target) {
  return /^derive_from_/i.test(String(target?.generation_mode ?? ""));
}

function referencePathValue(target) {
  return target?.reference_image_path ?? target?.required_reference_path ?? target?.path ?? null;
}

async function hasExistingReferencePath(target) {
  const refPath = referencePathValue(target);
  return Boolean(refPath && await exists(refPath));
}

function promptStartSec(prompt) {
  const value = Number(prompt?.start_sec ?? prompt?.start ?? prompt?.timestamp_sec ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function promptWideScore(prompt) {
  const text = [
    prompt?.shot_manifest?.shot_job,
    prompt?.visual_job,
    prompt?.suggested_shot_job,
    prompt?.image_prompt,
    prompt?.modelslab_image_prompt,
  ].filter(Boolean).join(" ");
  if (/\b(?:wide|establishing|environment|location|exterior|interior|room|hall|lobby|street|plaza|stage|office)\b/i.test(text)) return 0;
  return 1;
}

function promptMentionsRef(prompt, refId) {
  const wanted = String(refId ?? "").trim();
  if (!wanted) return false;
  if ((prompt.reference_requirements ?? []).some((req) => String(req?.ref_id ?? "").trim() === wanted)) return true;
  const manifest = prompt.shot_manifest ?? {};
  return String(manifest.location_ref_id ?? "").trim() === wanted
    || String(manifest.protagonist_state_ref_id ?? "").trim() === wanted
    || (manifest.character_state_ref_ids ?? []).some((id) => String(id ?? "").trim() === wanted);
}

function explicitCandidateIds(target) {
  return [
    ...(Array.isArray(target?.candidate_image_ids) ? target.candidate_image_ids : []),
    ...(Array.isArray(target?.anchor_image_ids) ? target.anchor_image_ids : []),
    ...(Array.isArray(target?.seed_image_ids) ? target.seed_image_ids : []),
    ...(Array.isArray(target?.derived_candidate_image_ids) ? target.derived_candidate_image_ids : []),
  ].map((id) => String(id ?? "").trim()).filter(Boolean);
}

function candidateImageIdsForDerivedTarget(target, promptPlan) {
  const prompts = Array.isArray(promptPlan?.prompts) ? promptPlan.prompts : [];
  const byId = new Map(prompts.map((prompt) => [String(prompt.image_id ?? ""), prompt]));
  const explicit = explicitCandidateIds(target).filter((id) => byId.has(id));
  if (explicit.length) return [...new Set(explicit)];
  const sceneIds = new Set((Array.isArray(target?.scene_ids) ? target.scene_ids : []).map((id) => String(id ?? "").trim()).filter(Boolean));
  const mentioned = prompts.filter((prompt) => promptMentionsRef(prompt, target.ref_id));
  const inScene = prompts.filter((prompt) => sceneIds.has(String(prompt.scene_id ?? "")) || sceneIds.has(String(prompt.parent_scene_id ?? "")));
  const combined = [...mentioned, ...inScene]
    .filter((prompt) => prompt?.image_id)
    .sort((left, right) => {
      const mode = String(target?.generation_mode ?? "");
      const wideDelta = mode === "derive_from_first_clean_wide_cut" ? promptWideScore(left) - promptWideScore(right) : 0;
      return wideDelta || promptStartSec(left) - promptStartSec(right) || String(left.image_id).localeCompare(String(right.image_id), undefined, { numeric: true });
    })
    .map((prompt) => String(prompt.image_id));
  return [...new Set(combined)];
}

export function candidateImageIdsForDerivedTargetForTests(target, promptPlan) {
  return candidateImageIdsForDerivedTarget(target, promptPlan);
}

async function unresolvedDerivedTargets(referencePlan, promptPlan) {
  const unresolved = [];
  for (const target of referencePlan?.reference_targets ?? []) {
    if (!target?.ref_id || !isDerivedReferenceTarget(target) || await hasExistingReferencePath(target)) continue;
    unresolved.push({
      ...target,
      candidate_image_ids: candidateImageIdsForDerivedTarget(target, promptPlan),
    });
  }
  return unresolved;
}

function referenceFresh(target, outputPath) {
  return promptFresh({ image_id: target.ref_id, prompt_hash: sha256(referencePrompt(target)), modelslab_image_prompt: referencePrompt(target) }, outputPath);
}

async function validateReferences(prompt) {
  const paths = [...new Set((prompt.required_reference_paths ?? []).filter(Boolean))];
  const missing = [];
  for (const refPath of paths) {
    if (!(await exists(refPath))) missing.push(refPath);
  }
  if (missing.length) {
    throw new Error(`Missing required reference(s) for ${prompt.image_id}: ${missing.join(", ")}`);
  }
  return paths;
}

function referenceSortKey(requirement, index) {
  const explicitOrder = Number(requirement.slot_order ?? requirement.order ?? requirement.image_slot ?? NaN);
  const requiredRank = requirement.required === true ? 0 : 1;
  const kind = String(requirement.kind ?? "").toLowerCase();
  const kindRank = kind.includes("character") ? 0
    : kind.includes("location") ? 1
      : kind.includes("prop") || kind.includes("ui") ? 2
        : kind.includes("action") || kind.includes("effect") ? 3
          : kind.includes("style") ? 9
              : 6;
  return {
    requiredRank,
    kindRank,
    explicitOrder: Number.isFinite(explicitOrder) ? explicitOrder : 999,
    index,
  };
}

function isStyleReferenceRequirement(requirement) {
  return String(requirement.kind ?? "").toLowerCase().includes("style") || String(requirement.ref_id ?? "") === "style_ref";
}

function isStyleReferenceTarget(target) {
  return String(target.kind ?? "").toLowerCase().includes("style") || String(target.ref_id ?? "") === "style_ref";
}

function referenceSlotPurpose(requirement) {
  const kind = String(requirement.kind ?? "").toLowerCase();
  const subject = requirement.subject ?? requirement.ref_id;
  if (kind.includes("character")) return `character identity and wardrobe for ${subject}`;
  if (kind.includes("location")) return `location environment for ${subject}`;
  if (kind.includes("style")) return "anime manhwa style language";
  if (kind.includes("action")) return `action or effect design for ${subject}`;
  if (kind.includes("ui")) return `UI design for ${subject}`;
  if (kind.includes("prop")) return `prop design for ${subject}`;
  return `visual reference for ${subject}`;
}

function slotWord(value) {
  return ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"][Number(value)] ?? String(value);
}

function referenceSlotInstruction(slots) {
  if (!slots.length) return "";
  return slots.map((slot) => `Use image ${slotWord(slot.slot)} as ${slot.purpose}.`).join(" ");
}

function normalizeName(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function stagedCharacterSlotContext(prompt, characterRefs = []) {
  const staging = Array.isArray(prompt?.shot_manifest?.character_staging) ? prompt.shot_manifest.character_staging : [];
  const byRefId = new Map();
  for (const ref of characterRefs ?? []) {
    for (const id of [ref?.state_ref_id, ref?.source_ref_id].filter(Boolean)) {
      byRefId.set(String(id), ref);
    }
  }
  const context = new Map();
  staging.forEach((entry, index) => {
    const ids = [entry?.ref_id, String(entry?.wardrobe_from ?? "").replace(/^character_state_ref:/i, "")].filter(Boolean);
    for (const id of ids) {
      context.set(String(id), { order: index, name: entry?.name ? String(entry.name) : null });
      const ref = byRefId.get(String(id));
      if (ref?.state_ref_id) context.set(String(ref.state_ref_id), { order: index, name: entry?.name ? String(entry.name) : ref.character ?? null });
      if (ref?.source_ref_id) context.set(String(ref.source_ref_id), { order: index, name: entry?.name ? String(entry.name) : ref.character ?? null });
    }
  });
  return context;
}

function characterReferenceRequirements(prompt, characterRefs, existingIds) {
  const sceneId = String(prompt.scene_id ?? "");
  const visibleText = [
    ...(Array.isArray(prompt.visible_subjects) ? prompt.visible_subjects : []),
    prompt.primary_subject,
  ].map(normalizeName).filter(Boolean).join(" | ");
  const characterBySourceRef = new Map(
    (characterRefs ?? [])
      .filter((ref) => ref.source_ref_id && (ref.character || ref.subject))
      .map((ref) => [ref.source_ref_id, normalizeName(ref.character ?? ref.subject)])
  );
  const coveredCharacters = new Set(
    [...existingIds]
      .map((refId) => characterBySourceRef.get(refId))
      .filter(Boolean)
  );
  const inferred = [];
  for (const ref of characterRefs ?? []) {
    const character = normalizeName(ref.character ?? ref.subject ?? "");
    const sourceRefId = ref.source_ref_id ?? ref.ref_id ?? null;
    if (!character || !sourceRefId || existingIds.has(sourceRefId) || !ref.reference_image_path) continue;
    if (coveredCharacters.has(character)) continue;
    if (Array.isArray(ref.scene_ids) && ref.scene_ids.length && sceneId && !ref.scene_ids.includes(sceneId)) continue;
    if (!visibleText.includes(character)) continue;
    coveredCharacters.add(character);
    inferred.push({
      ref_id: sourceRefId,
      kind: "character_state",
      required: true,
      slot_order: 0,
      slot_purpose: `character identity and wardrobe for ${ref.character ?? ref.subject ?? sourceRefId}`,
      reason: "Visible named character has an approved character_state_ref; attached to reduce multi-character identity bleed.",
      inferred_from_visible_subject: true,
    });
  }
  return inferred;
}

function referenceLimitOmitted(prompt, refId) {
  const wanted = String(refId ?? "").trim();
  if (!wanted) return false;
  return (prompt.reference_usage ?? []).some((usage) => (
    String(usage?.ref_id ?? "").trim() === wanted
    && String(usage?.usage ?? "").trim() === "available_not_attached_reference_limit"
  ));
}

function targetKindById(referenceTargets = []) {
  return new Map((referenceTargets ?? []).filter((target) => target?.ref_id).map((target) => [String(target.ref_id), String(target.kind ?? "source_anchor")]));
}

function manifestReferenceRequirements(prompt, characterRefs, referenceById, referenceTargets = [], existingIds = new Set()) {
  const manifest = prompt.shot_manifest ?? {};
  const targetKind = targetKindById(referenceTargets);
  const additions = [];
  function add(refId, kind, slotPurpose, reason, extra = {}) {
    const id = String(refId ?? "").trim();
    if (!id || existingIds.has(id) || !referenceById.has(id) || referenceLimitOmitted(prompt, id)) return;
    existingIds.add(id);
    additions.push({
      ref_id: id,
      kind,
      required: true,
      slot_order: 0,
      slot_purpose: slotPurpose,
      reason,
      inferred_from_shot_manifest: true,
      ...extra,
    });
  }

  add(
    manifest.location_ref_id,
    targetKind.get(String(manifest.location_ref_id ?? "")) || "location",
    `location environment for ${manifest.location_ref_id}`,
    "Shot manifest declared this location ref; it is now attachable, usually after derived-ref promotion."
  );

  const characterByStateId = new Map();
  const characterBySourceId = new Map();
  for (const ref of characterRefs ?? []) {
    if (ref?.state_ref_id) characterByStateId.set(String(ref.state_ref_id), ref);
    if (ref?.source_ref_id) characterBySourceId.set(String(ref.source_ref_id), ref);
  }
  const manifestCharacterIds = [
    manifest.protagonist_state_ref_id,
    ...(Array.isArray(manifest.character_state_ref_ids) ? manifest.character_state_ref_ids : []),
  ].map((id) => String(id ?? "").trim()).filter(Boolean);
  for (const manifestId of manifestCharacterIds) {
    const ref = characterByStateId.get(manifestId) ?? characterBySourceId.get(manifestId) ?? null;
    const sourceRefId = ref?.source_ref_id ?? manifestId;
    add(
      sourceRefId,
      "character_state",
      `character identity and wardrobe for ${ref?.character ?? sourceRefId}`,
      "Shot manifest declared this character state ref; it is now attachable.",
      ref?.state_ref_id && ref.state_ref_id !== sourceRefId ? { source_state_ref_id: ref.state_ref_id } : {}
    );
  }

  return additions;
}

function isHardenedPromptPlan(plan) {
  return Boolean(plan?.visual_prompt_hardening_report_path || String(plan?.prompt_policy ?? "").includes("deterministic hardening"));
}

function attachReferencePathsToPrompts(plan, referenceById, characterRefs = [], referenceTargets = []) {
  const inferVisibleSubjectRefs = !isHardenedPromptPlan(plan);
  const prompts = (plan.prompts ?? []).map((prompt) => {
    const stagingContext = stagedCharacterSlotContext(prompt, characterRefs);
    const authoredRequirements = Array.isArray(prompt.reference_requirements)
      ? prompt.reference_requirements.filter((requirement) => requirement.inferred_from_visible_subject !== true)
      : [];
    const existingIds = new Set(authoredRequirements.map((requirement) => requirement.ref_id).filter(Boolean));
    const requirements = [
      ...authoredRequirements,
      ...manifestReferenceRequirements(prompt, characterRefs, referenceById, referenceTargets, existingIds),
      ...(inferVisibleSubjectRefs ? characterReferenceRequirements(prompt, characterRefs, existingIds) : []),
    ];
    const availableRows = requirements
      .map((requirement, index) => ({
        requirement,
        index,
        path: referenceById.get(requirement.ref_id),
        sortKey: referenceSortKey(requirement, index),
        staging: stagingContext.get(String(requirement.ref_id)) ?? stagingContext.get(String(requirement.source_state_ref_id ?? "")) ?? null,
      }))
      .filter((row) => row.path)
      .sort((a, b) => a.sortKey.kindRank - b.sortKey.kindRank
        || (a.staging?.order ?? 999) - (b.staging?.order ?? 999)
        || a.sortKey.requiredRank - b.sortKey.requiredRank
        || a.sortKey.explicitOrder - b.sortKey.explicitOrder
        || a.sortKey.index - b.sortKey.index);
    const nonStyleRows = availableRows.filter((row) => !isStyleReferenceRequirement(row.requirement));
    const styleRows = availableRows.filter((row) => isStyleReferenceRequirement(row.requirement));
    const selected = (nonStyleRows.length ? nonStyleRows : styleRows).slice(0, maxSceneReferences);
    const selectedIds = new Set(selected.map((row) => row.requirement.ref_id));
    const referenceSlots = selected.map((row, index) => ({
      slot: index + 1,
      ref_id: row.requirement.ref_id,
      kind: row.requirement.kind ?? null,
      path: row.path,
      purpose: row.staging?.name && String(row.requirement.kind ?? "").toLowerCase().includes("character")
        ? `character identity and wardrobe for ${row.staging.name}`
        : row.requirement.slot_purpose ?? referenceSlotPurpose(row.requirement),
      reason: row.requirement.reason ?? null,
    }));
    return {
      ...prompt,
      reference_requirements: requirements,
      required_reference_paths: selected.map((row) => row.path),
      reference_slots: referenceSlots,
      reference_usage: requirements.map((requirement) => {
        const refPath = referenceById.get(requirement.ref_id) ?? null;
        if (!refPath) {
          return {
            ref_id: requirement.ref_id,
            usage: requirement.required ? "missing_reference_coverage" : "not_attached_missing_optional_reference",
            reason: "Reference image path is not available.",
          };
        }
        if (!selectedIds.has(requirement.ref_id)) {
          return {
            ref_id: requirement.ref_id,
            usage: "available_not_attached_reference_limit",
            reference_image_path: refPath,
            reason: isStyleReferenceRequirement(requirement) && selected.length && !selectedIds.has(requirement.ref_id)
              ? "Style reference is only attached when no other scene references are available; concrete refs already carry style."
              : `Scene already uses the maximum ${maxSceneReferences} reference images for model stability.`,
          };
        }
        return {
          ref_id: requirement.ref_id,
          usage: "attached_reference",
          reference_image_path: refPath,
          reason: requirement.reason ?? "Referenced by reviewed scene prompt.",
        };
      }),
    };
  });
  return { ...plan, prompts, reference_paths_attached_at: new Date().toISOString(), max_scene_references: maxSceneReferences };
}

export function attachReferencePathsToPromptsForTests(plan, referenceById, characterRefs = [], referenceTargets = []) {
  return attachReferencePathsToPrompts(plan, referenceById, characterRefs, referenceTargets);
}

function promptWithReferenceSlots(prompt, provider = imageProvider) {
  const basePrompt = promptTextForImageProvider(prompt, provider);
  const slotInstruction = referenceSlotInstruction(prompt.reference_slots ?? []);
  return [slotInstruction, basePrompt].filter(Boolean).join(" ");
}

async function promptFresh(prompt, outputPath) {
  if (!(await exists(outputPath))) return false;
  const sidecar = `${outputPath}.prompt.sha256`;
  if (!(await exists(sidecar))) return false;
  const current = String(await fs.readFile(sidecar, "utf8")).trim();
  return current === (prompt.prompt_hash ?? sha256(promptTextForImageProvider(prompt, imageProvider)));
}

async function reusableImportedCodexImage(prompt, outputPath) {
  if (!(await exists(outputPath))) return false;
  const metadata = await readJson(`${outputPath}.metadata.json`, null);
  const provider = String(metadata?.image_provider ?? "");
  const source = String(metadata?.generated?.source ?? "");
  if (!/codex/i.test(provider) && !/codex/i.test(source)) return false;
  if (metadata?.image_id && String(metadata.image_id) !== String(prompt.image_id)) return false;
  const sourcePromptPath = metadata?.source_prompt_path ? path.resolve(String(metadata.source_prompt_path)) : null;
  if (sourcePromptPath && sourcePromptPath !== path.resolve(promptPath)) return false;
  return Boolean(metadata?.generated?.output_sha256 ?? metadata?.generated?.manual_source_sha256 ?? metadata?.prompt_hash);
}

async function runPool(items, worker, limit) {
  const results = [];
  let index = 0;
  async function next() {
    while (index < items.length) {
      const current = index++;
      try {
        results[current] = await worker(items[current], current);
      } catch (error) {
        const item = items[current] ?? {};
        const id = item.image_id ?? item.ref_id ?? `item_${current}`;
        console.error(`${id} generation failed: ${error.message}`);
        results[current] = {
          image_id: item.image_id,
          ref_id: item.ref_id,
          status: "failed",
          error: error.message,
        };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
  return results;
}

async function generateProviderImage({
  prompt,
  outputPath,
  referenceImagePaths = [],
  model = "flux-klein",
  provider = imageProvider,
  width = undefined,
  height = undefined,
}) {
  const routedProvider = normalizeImageProvider(provider);
  if (isCodexImageProvider(routedProvider)) {
    if (!allowLegacyCodexExec) {
      throw new Error([
        "Direct Codex image generation from imagegen start is disabled for production.",
        "Use built-in Codex imagegen workers/subagents to create real staged PNGs, then import them with",
        "goldflow imagegen import-staged-codex.",
        "Pass --allow-legacy-codex-exec true only for an explicitly approved diagnostic probe."
      ].join(" "));
    }
    return generateCodexImage({
      prompt,
      outputPath,
      referenceImagePaths,
      allowGlobalFallback: concurrency <= 1 && referenceConcurrency <= 1,
    });
  }
  return generateModelslabImage({ prompt, outputPath, referenceImagePaths, model, width, height });
}

function modelslabSceneGeometry() {
  return { width: sceneImageWidth, height: sceneImageHeight };
}

function modelslabReferenceGeometry(target) {
  const kind = String(target?.kind ?? "").toLowerCase();
  if (kind === "location") return { width: sceneImageWidth, height: sceneImageHeight };
  return { width: referenceImageWidth, height: referenceImageHeight };
}

function sceneAspectInstruction(provider) {
  if (normalizeImageProvider(provider) !== "modelslab") return "";
  return `16:9 landscape YouTube image at ${sceneImageWidth}x${sceneImageHeight}. Polished 2D anime/manhwa illustration style, clean line art, cel-shaded characters, cinematic webtoon lighting, non-photorealistic painted backgrounds. Preserve the shot scale, subject count, background population, and composition requested by the prompt.`;
}

async function generateOne(prompt) {
  const routedProvider = promptRoute(prompt);
  const outputPath = imagePathFor(prompt, routedProvider);
  const referenceImagePaths = await validateReferences(prompt);
  const modelPrompt = [sceneAspectInstruction(routedProvider), promptWithReferenceSlots(prompt, routedProvider)].filter(Boolean).join(" ");
  const sceneGeometry = routedProvider === "modelslab" ? modelslabSceneGeometry() : {};
  const promptHash = sha256(JSON.stringify({ prompt: modelPrompt, provider: routedProvider, model: imageModelOverride ?? prompt.image_model_route ?? "flux-klein", ...sceneGeometry }));
  if (routedProvider === "codex_imagegen" && !forceImages && await reusableImportedCodexImage(prompt, outputPath)) {
    return { image_id: prompt.image_id, status: "reused_imported_codex", image_path: outputPath, prompt_hash: promptHash, image_provider: routedProvider, image_provider_route: imageProvider };
  }
  if (!forceImages && await promptFresh({ ...prompt, prompt_hash: promptHash, modelslab_image_prompt: modelPrompt }, outputPath)) {
    return { image_id: prompt.image_id, status: "reused_fresh", image_path: outputPath, prompt_hash: promptHash, image_provider: routedProvider };
  }
  const generated = await generateProviderImage({
    prompt: modelPrompt,
    outputPath,
    referenceImagePaths,
    model: imageModelOverride ?? prompt.image_model_route ?? "flux-klein",
    provider: routedProvider,
    ...sceneGeometry,
  });
  await fs.writeFile(`${outputPath}.prompt.sha256`, promptHash, "utf8");
  await writeJson(`${outputPath}.metadata.json`, {
    image_id: prompt.image_id,
    prompt_hash: promptHash,
    source_prompt_path: promptPath,
    reference_image_paths: referenceImagePaths,
    reference_slots: prompt.reference_slots ?? [],
    image_prompt: modelPrompt,
    source_image_prompt: prompt.image_prompt ?? null,
    source_modelslab_image_prompt: prompt.modelslab_image_prompt ?? null,
    source_codex_image_prompt: prompt.codex_image_prompt ?? null,
    modelslab_prompt: routedProvider === "modelslab" ? modelPrompt : null,
    codex_prompt: routedProvider === "codex_imagegen" ? modelPrompt : null,
    image_provider: routedProvider,
    image_provider_route: imageProvider,
    model: routedProvider === "codex_imagegen" ? generated.model : (imageModelOverride ?? prompt.image_model_route ?? "flux-klein"),
    generated,
    requested_geometry: routedProvider === "modelslab" ? sceneGeometry : null,
    updated_at: new Date().toISOString(),
  });
  return { image_id: prompt.image_id, status: "generated", image_path: generated.downloaded_path ?? outputPath, prompt_hash: promptHash, image_provider: routedProvider, image_provider_route: imageProvider, generated };
}

async function generateReference(target, styleRefPath = null, referenceLookup = new Map(), characterStateRefs = []) {
  const routedProvider = routedProviderForReference(imageProvider, target);
  const outputPath = referencePathFor(target, routedProvider);
  const stateRef = characterStateRefs.find((ref) => ref.source_ref_id === target.ref_id);
  const baseIdentityRefId = stateRef?.base_identity_ref_id ?? target.identity_ref_id ?? target.source_identity_ref_id ?? null;
  const baseIdentityPath = baseIdentityRefId ? referenceLookup.get(baseIdentityRefId) : null;
  const prompt = baseIdentityPath
    ? `${referencePrompt(target)}\n\nUse the first attached image as the exact facial likeness and identity anchor for ${stateRef?.character ?? target.subject}. Preserve the same face, age impression, hair color, hairline, and core facial structure; change only the requested wardrobe, posture, expression, and emotional state.`
    : referencePrompt(target);
  const promptHash = sha256(prompt);
  if (!forceReferences && await referenceFresh(target, outputPath)) {
    return { ref_id: target.ref_id, status: "reused_fresh", image_path: outputPath, prompt_hash: promptHash };
  }
  const referenceImagePaths = [
    ...(baseIdentityPath ? [baseIdentityPath] : []),
    ...(target.ref_id !== "style_ref" && styleRefPath ? [styleRefPath] : []),
  ].slice(0, 4);
  const generated = await generateProviderImage({
    prompt,
    outputPath,
    referenceImagePaths,
    model: target.image_model_route ?? "flux-klein",
    provider: routedProvider,
    ...(routedProvider === "modelslab" ? modelslabReferenceGeometry(target) : {}),
  });
  await fs.writeFile(`${outputPath}.prompt.sha256`, promptHash, "utf8");
  await writeJson(`${outputPath}.metadata.json`, {
    ref_id: target.ref_id,
    kind: target.kind,
    subject: target.subject,
    prompt_hash: promptHash,
    source_reference_plan_path: visualReferencePlanPath,
    reference_image_paths: referenceImagePaths,
    base_identity_ref_id: baseIdentityRefId,
    image_provider: routedProvider,
    image_provider_route: imageProvider,
    model: routedProvider === "codex_imagegen" ? generated.model : (target.image_model_route ?? "flux-klein"),
    generated,
    updated_at: new Date().toISOString(),
  });
  return { ref_id: target.ref_id, status: "generated", image_path: generated.downloaded_path ?? outputPath, prompt_hash: promptHash, image_provider: routedProvider, image_provider_route: imageProvider, generated };
}

async function generateReferences() {
  const referencePlan = await readJson(visualReferencePlanPath, null);
  const characterRefs = await readJson(characterStateRefsPath, null);
  if (!referencePlan?.reference_targets?.length || skipReferenceGeneration) {
    const referenceEntries = [];
    for (const target of referencePlan?.reference_targets ?? []) {
      if (target.ref_id && target.reference_image_path && await exists(target.reference_image_path)) referenceEntries.push([target.ref_id, target.reference_image_path]);
    }
    for (const ref of characterRefs?.character_state_refs ?? []) {
      if (ref.source_ref_id && ref.reference_image_path && await exists(ref.reference_image_path)) referenceEntries.push([ref.source_ref_id, ref.reference_image_path]);
    }
    return {
      referencePlan,
      characterRefs,
      results: [],
      referenceById: new Map(referenceEntries),
    };
  }
  await fs.mkdir(referenceDir, { recursive: true });
  const referenceScope = requestedReferenceIds();
  const existingReferenceEntries = [];
  for (const target of referencePlan?.reference_targets ?? []) {
    if (target.ref_id && target.reference_image_path && await exists(target.reference_image_path)) existingReferenceEntries.push([target.ref_id, target.reference_image_path]);
  }
  for (const ref of characterRefs?.character_state_refs ?? []) {
    if (ref.source_ref_id && ref.reference_image_path && await exists(ref.reference_image_path)) existingReferenceEntries.push([ref.source_ref_id, ref.reference_image_path]);
  }
  const requestedTargets = referencePlan.reference_targets
    .filter((target) => target.generation_mode === "standalone_ref" || target.required_before_imagegen === true || referenceScope.has(target.ref_id))
    .filter((target) => !referenceScope.size || referenceScope.has(target.ref_id));
  const targets = [];
  for (const target of requestedTargets) {
    if (
      !forceReferences
      && target.reference_image_path
      && await exists(target.reference_image_path)
      && await referenceFresh(target, target.reference_image_path)
    ) {
      continue;
    }
    targets.push(target);
  }
  const styleTarget = targets.find((target) => isStyleReferenceTarget(target));
  const results = [];
  const existingStyleTarget = referencePlan.reference_targets.find((target) => isStyleReferenceTarget(target) && target.reference_image_path);
  let styleRefPath = existingStyleTarget && await exists(existingStyleTarget.reference_image_path)
    ? existingStyleTarget.reference_image_path
    : null;
  const referenceById = new Map(existingReferenceEntries);
  if (styleTarget) {
    const result = await generateReference(styleTarget, null, referenceById, characterRefs?.character_state_refs ?? []);
    results.push(result);
    referenceById.set(result.ref_id, result.image_path);
    styleRefPath = result.image_path;
  }
  const remaining = targets.filter((target) => target.ref_id !== styleTarget?.ref_id);
  const remainingResults = await runPool(remaining, (target) => generateReference(target, styleRefPath, referenceById, characterRefs?.character_state_refs ?? []), referenceConcurrency);
  results.push(...remainingResults);
  for (const row of remainingResults) referenceById.set(row.ref_id, row.image_path);
  const updatedReferencePlan = {
    ...referencePlan,
    reference_targets: referencePlan.reference_targets.map((target) => ({
      ...target,
      reference_image_path: referenceById.get(target.ref_id) ?? target.reference_image_path ?? null,
    })),
    reference_generation_updated_at: new Date().toISOString(),
  };
  await writeJson(visualReferencePlanPath, updatedReferencePlan);
  if (characterRefs?.character_state_refs) {
    const updatedCharacterRefs = {
      ...characterRefs,
      character_state_refs: characterRefs.character_state_refs.map((ref) => ({
        ...ref,
        reference_image_path: referenceById.get(ref.source_ref_id) ?? ref.reference_image_path ?? null,
      })),
      reference_generation_updated_at: new Date().toISOString(),
    };
    await writeJson(characterStateRefsPath, updatedCharacterRefs);
  }
  return { referencePlan: updatedReferencePlan, characterRefs, results, referenceById };
}

function successfulImageRows(report) {
  const byId = new Map();
  for (const row of report?.results ?? []) {
    const status = String(row?.status ?? "").toLowerCase();
    if (!row?.image_id || status === "failed" || !row.image_path) continue;
    byId.set(String(row.image_id), row);
  }
  return byId;
}

async function probePromptImageRows(promptPlan) {
  const rows = new Map();
  for (const prompt of promptPlan?.prompts ?? []) {
    if (!prompt?.image_id) continue;
    const provider = promptRoute(prompt);
    const outputPath = imagePathFor(prompt, provider);
    if (!(await exists(outputPath))) continue;
    rows.set(String(prompt.image_id), {
      image_id: String(prompt.image_id),
      status: "existing_file",
      image_path: outputPath,
      image_provider: provider,
    });
  }
  return rows;
}

async function promotedReferencePathFor(target) {
  await fs.mkdir(referenceDir, { recursive: true });
  return path.join(referenceDir, `${target.ref_id}-derived-reference.png`);
}

async function promoteDerivedReferences() {
  const referencePlan = await readJson(visualReferencePlanPath, null);
  const characterRefs = await readJson(characterStateRefsPath, null);
  const promptPlan = await readJson(promptPath, null);
  if (!referencePlan?.reference_targets?.length) throw new Error(`Missing visual reference plan: ${visualReferencePlanPath}`);
  if (!promptPlan?.prompts?.length) throw new Error(`Missing prompt plan for derived reference promotion: ${promptPath}`);
  const imagegenReport = await readJson(reportPath, null);
  const reportRows = successfulImageRows(imagegenReport);
  const probedRows = await probePromptImageRows(promptPlan);
  const imageRows = new Map([...probedRows, ...reportRows]);
  const targets = await unresolvedDerivedTargets(referencePlan, promptPlan);
  const promoted = [];
  const unresolved = [];
  const updatedTargets = [];
  for (const target of referencePlan.reference_targets ?? []) {
    if (!target?.ref_id || !isDerivedReferenceTarget(target) || await hasExistingReferencePath(target)) {
      updatedTargets.push(target);
      continue;
    }
    const candidateIds = candidateImageIdsForDerivedTarget(target, promptPlan);
    const candidate = candidateIds.map((id) => imageRows.get(id)).find((row) => row?.image_path);
    if (!candidate || !(await exists(candidate.image_path))) {
      unresolved.push({
        ref_id: target.ref_id,
        generation_mode: target.generation_mode,
        scene_ids: target.scene_ids ?? [],
        candidate_image_ids: candidateIds,
        reason: candidateIds.length ? "candidate cuts are not generated yet" : "no candidate cuts found for derived ref target",
      });
      updatedTargets.push(target);
      continue;
    }
    const outputPath = await promotedReferencePathFor(target);
    await fs.copyFile(candidate.image_path, outputPath);
    const sourceHash = await hashFile(candidate.image_path);
    const promotedHash = await hashFile(outputPath);
    await writeJson(`${outputPath}.metadata.json`, {
      ref_id: target.ref_id,
      kind: target.kind ?? null,
      generation_mode: target.generation_mode,
      derived_from_image_id: candidate.image_id,
      derived_from_image_path: candidate.image_path,
      source_image_sha256: sourceHash,
      output_sha256: promotedHash,
      prompt_plan_path: promptPath,
      visual_reference_plan_path: visualReferencePlanPath,
      promoted_at: new Date().toISOString(),
    });
    const updated = {
      ...target,
      reference_image_path: outputPath,
      derived_reference_status: "promoted",
      derived_from_image_id: candidate.image_id,
      derived_from_image_path: candidate.image_path,
      derived_from_image_sha256: sourceHash,
      candidate_image_ids: candidateIds,
      reference_generation_updated_at: new Date().toISOString(),
    };
    updatedTargets.push(updated);
    promoted.push({
      ref_id: target.ref_id,
      generation_mode: target.generation_mode,
      image_id: candidate.image_id,
      source_image_path: candidate.image_path,
      reference_image_path: outputPath,
      output_sha256: promotedHash,
    });
  }
  const updatedReferencePlan = {
    ...referencePlan,
    reference_targets: updatedTargets,
    derived_reference_promotion_updated_at: new Date().toISOString(),
  };
  await writeJson(visualReferencePlanPath, updatedReferencePlan);
  if (characterRefs?.character_state_refs) {
    const byTarget = new Map(updatedTargets.filter((target) => target.reference_image_path).map((target) => [target.ref_id, target.reference_image_path]));
    const updatedCharacterRefs = {
      ...characterRefs,
      character_state_refs: characterRefs.character_state_refs.map((ref) => ({
        ...ref,
        reference_image_path: byTarget.get(ref.source_ref_id) ?? ref.reference_image_path ?? null,
      })),
      derived_reference_promotion_updated_at: new Date().toISOString(),
    };
    await writeJson(characterStateRefsPath, updatedCharacterRefs);
  }
  const report = {
    schema: "goldflow_derived_reference_promotion_v1",
    status: "passed",
    channel,
    series_slug: series,
    week,
    episode,
    prompt_plan_path: promptPath,
    imagegen_report_path: reportPath,
    visual_reference_plan_path: visualReferencePlanPath,
    character_state_refs_path: characterStateRefsPath,
    pending_derived_ref_count: targets.length,
    promoted_count: promoted.length,
    unresolved_count: unresolved.length,
    promoted,
    unresolved,
    updated_at: new Date().toISOString(),
  };
  await writeJson(derivedRefPromotionReportPath, report);
  console.log(JSON.stringify({
    status: report.status,
    report_path: derivedRefPromotionReportPath,
    promoted_count: promoted.length,
    unresolved_count: unresolved.length,
  }, null, 2));
}

async function mergeImagegenResults({ currentResults, promptIds, promptPlanHash }) {
  const priorReport = await readJson(reportPath, null);
  const mergedById = new Map();
  if (
    priorReport?.schema === "goldflow_imagegen_report_v1"
    && priorReport.prompt_plan_hash === promptPlanHash
    && Array.isArray(priorReport.results)
  ) {
    for (const row of priorReport.results) {
      if (!row?.image_id || !promptIds.has(row.image_id)) continue;
      if (!row.image_path || !(await exists(row.image_path))) continue;
      mergedById.set(row.image_id, row);
    }
  }
  for (const row of currentResults) {
    if (row?.image_id) mergedById.set(row.image_id, row);
  }
  return [...mergedById.values()].sort((a, b) => String(a.image_id).localeCompare(String(b.image_id), undefined, { numeric: true }));
}

function imageResultPassed(row) {
  return ["generated", "reused_fresh", "reused_imported_codex", "existing_file"].includes(String(row?.status ?? "").toLowerCase());
}

export async function assertNoVisualResolutionDeadletterForTests(plan, selectedPrompts = [], options = {}) {
  const deadletterPath = options.deadletterPath ?? visualResolutionDeadletterPath;
  if (plan?.status === "blocked_deadletter") {
    throw new Error(`Imagegen refused blocked visual prompt plan with dead-lettered scenes: ${plan.visual_resolution_deadletter_path ?? deadletterPath}`);
  }
  const deadletter = await readJson(deadletterPath, null);
  if (deadletter?.status !== "blocked_deadletter") return;
  const blockedImages = new Set((deadletter.image_ids ?? []).map((imageId) => String(imageId)));
  const selectedImages = new Set((selectedPrompts ?? []).map((prompt) => String(prompt.image_id ?? "")).filter(Boolean));
  const imageOverlap = [...blockedImages].filter((imageId) => selectedImages.has(imageId));
  if (imageOverlap.length) {
    throw new Error(`Imagegen refused dead-lettered visual cuts: ${imageOverlap.join(", ")}. Resolve visual_resolution_deadletter.json before image generation.`);
  }
  const blockedScenes = new Set((deadletter.scene_ids ?? []).map((sceneId) => String(sceneId)));
  const selectedScenes = new Set((selectedPrompts ?? []).map((prompt) => String(prompt.scene_id ?? "")).filter(Boolean));
  const overlap = [...blockedScenes].filter((sceneId) => selectedScenes.has(sceneId));
  if (overlap.length) {
    throw new Error(`Imagegen refused dead-lettered visual scenes: ${overlap.join(", ")}. Resolve visual_resolution_deadletter.json before image generation.`);
  }
}

async function main() {
  const runIdentity = await assertRunIdentityImageProvider();
  codexOpeningSec = resolveCodexOpeningSec(runIdentity);
  if (promoteDerivedRefs) {
    await promoteDerivedReferences();
    return;
  }
  const referenceRun = await generateReferences();
  if (referencesOnly) {
    const report = {
      schema: "goldflow_imagegen_report_v1",
      status: referenceRun.results.every((row) => row.status === "generated" || row.status === "reused_fresh") ? "passed" : "failed",
      channel,
      series_slug: series,
      week,
      episode,
    image_provider: imageProvider,
    run_identity_path: runIdentityPath,
    run_identity_image_provider: runIdentity.image_provider ?? null,
    requested_scene_image_geometry: { width: sceneImageWidth, height: sceneImageHeight },
    requested_reference_image_geometry: { width: referenceImageWidth, height: referenceImageHeight },
    prompt_plan_path: promptPath,
      visual_reference_plan_path: visualReferencePlanPath,
      character_state_refs_path: characterStateRefsPath,
      image_dir: imageDir,
      reference_only: true,
      reference_concurrency: referenceConcurrency,
      codex_opening_sec: codexOpeningSec,
      reference_count: referenceRun.results.length,
      reference_results: referenceRun.results,
      updated_at: new Date().toISOString(),
    };
    await writeJson(reportPath, report);
    console.log(JSON.stringify({ status: report.status, report_path: reportPath, reference_count: report.reference_count }, null, 2));
    if (report.status !== "passed") process.exitCode = 1;
    return;
  }
  let plan = await readJson(promptPath, null);
  if (plan?.status !== "passed" || !Array.isArray(plan.prompts) || !plan.prompts.length) throw new Error(`Missing passed section image prompt plan: ${promptPath}`);
  if (!allowUnhardenedPrompts && !plan.visual_prompt_hardening_report_path && !String(plan.prompt_policy ?? "").includes("deterministic hardening")) {
    throw new Error(`Imagegen requires a deterministic-hardened prompt plan. Run "goldflow visual harden" and pass section_image_prompts_hardened.json, or use --allow-unhardened-prompts true for diagnostics.`);
  }
  if (referenceRun.referenceById?.size) {
    plan = attachReferencePathsToPrompts(
      plan,
      referenceRun.referenceById,
      referenceRun.characterRefs?.character_state_refs ?? [],
      referenceRun.referencePlan?.reference_targets ?? []
    );
  }
  const seedDerivedTargets = seedDerivedRefs ? await unresolvedDerivedTargets(referenceRun.referencePlan, plan) : [];
  const seedDerivedImageIds = new Set(seedDerivedTargets.flatMap((target) => target.candidate_image_ids ?? []));
  if (seedDerivedRefs && !seedDerivedImageIds.size) {
    throw new Error("No seed cuts found for unresolved derived references. Add candidate_image_ids/scene_ids to derived reference targets or promote existing refs manually.");
  }
  const scope = requestedIds();
  const prompts = plan.prompts
    .filter((prompt) => prompt.image_generation_required !== false)
    .filter((prompt) => !providerFilter || promptRoute(prompt) === providerFilter)
    .filter((prompt) => !seedDerivedRefs || seedDerivedImageIds.has(String(prompt.image_id ?? "")))
    .filter((prompt) => !scope.size || scope.has(prompt.image_id));
  if (!prompts.length) throw new Error("No image prompts selected for generation.");
  await assertNoVisualResolutionDeadletterForTests(plan, prompts);
  await fs.mkdir(imageDir, { recursive: true });
  const promptPlanHash = await hashFile(promptPath);
  const allPromptIds = new Set(plan.prompts.filter((prompt) => prompt.image_generation_required !== false).map((prompt) => prompt.image_id));
  const results = await runPool(prompts, generateOne, concurrency);
  const mergedResults = await mergeImagegenResults({ currentResults: results, promptIds: allPromptIds, promptPlanHash });
  const report = {
    schema: "goldflow_imagegen_report_v1",
    status: results.every((row) => imageResultPassed(row)) ? "passed" : "failed",
    channel,
    series_slug: series,
    week,
    episode,
    prompt_plan_path: promptPath,
    prompt_plan_hash: promptPlanHash,
    image_provider: imageProvider,
    run_identity_path: runIdentityPath,
    run_identity_image_provider: runIdentity.image_provider ?? null,
    requested_scene_image_geometry: { width: sceneImageWidth, height: sceneImageHeight },
    requested_reference_image_geometry: { width: referenceImageWidth, height: referenceImageHeight },
    image_dir: imageDir,
    concurrency,
    codex_opening_sec: codexOpeningSec,
    provider_filter: providerFilter,
    seed_derived_refs: seedDerivedRefs,
    seed_derived_ref_count: seedDerivedTargets.length,
    seed_derived_image_ids: [...seedDerivedImageIds],
    image_count: mergedResults.length,
    current_batch_image_count: results.length,
    reference_count: referenceRun.results.length,
    reference_results: referenceRun.results,
    results: mergedResults,
    updated_at: new Date().toISOString(),
  };
  await writeJson(reportPath, report);
  console.log(JSON.stringify({ status: report.status, report_path: reportPath, image_count: report.image_count, current_batch_image_count: report.current_batch_image_count }, null, 2));
  if (report.status !== "passed") process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    await writeJson(reportPath, { schema: "goldflow_imagegen_report_v1", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() }).catch(() => {});
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
