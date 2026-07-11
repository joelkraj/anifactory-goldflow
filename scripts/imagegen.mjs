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
import { referencePlanApprovalMatches } from "./lib/reference-plan-contract.mjs";

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
const concurrency = Math.max(1, Math.min(15, Number(flags.concurrency ?? process.env.ANIFACTORY_IMAGEGEN_CONCURRENCY ?? 15)));
const referenceConcurrency = Math.max(1, Math.min(15, Number(flags["reference-concurrency"] ?? process.env.ANIFACTORY_REFERENCE_IMAGEGEN_CONCURRENCY ?? 15)));
const force = flags.force === "true";
const forceImages = force || flags["force-images"] === "true";
const forceReferences = force || flags["force-references"] === "true";
const skipReferenceGeneration = flags["skip-reference-generation"] === "true";
const referencesOnly = flags["references-only"] === "true";
const allowUnhardenedPrompts = flags["allow-unhardened-prompts"] === "true";
const imageModelOverride = flags["image-model-route"] ?? flags["image-model"] ?? process.env.ANIFACTORY_IMAGE_MODEL ?? null;
const referenceImageModelOverride = flags["reference-image-model-route"]
  ?? flags["reference-image-model"]
  ?? process.env.ANIFACTORY_REFERENCE_MODEL
  ?? imageModelOverride
  ?? null;
const imageProvider = normalizeImageProvider(flags["image-provider"] ?? flags.provider ?? process.env.ANIFACTORY_IMAGE_PROVIDER ?? "modelslab");
const maxSceneReferences = Math.max(0, Math.min(4, Number(flags["max-scene-references"] ?? process.env.ANIFACTORY_MAX_SCENE_REFERENCES ?? 4)));
const providerFilter = normalizeProviderFilter(flags["provider-filter"] ?? flags.providerFilter ?? "");
const codexOpeningSecFlagRaw = flags["codex-opening-sec"] ?? flags["codex-opening-duration-sec"] ?? null;
const codexOpeningSecEnvRaw = process.env.ANIFACTORY_CODEX_OPENING_SEC ?? null;
let codexOpeningSec = Math.max(0, Number(codexOpeningSecFlagRaw ?? codexOpeningSecEnvRaw ?? 120));
const confirmImageProvider = flags["confirm-image-provider"] === "true";
const allowLegacyCodexExec = flags["allow-legacy-codex-exec"] === "true" || process.env.ANIFACTORY_ALLOW_LEGACY_CODEX_EXEC === "true";
const runIdentityPath = path.join(episodeDir, "run_identity.json");
const referencePlanApprovalPath = flags["reference-plan-approval"] ?? path.join(episodeDir, "reference_plan_approval.json");
const visualResolutionDeadletterPath = flags.deadletter ?? flags["deadletter"] ?? path.join(episodeDir, "visual_resolution_deadletter.json");
const derivedRefPromotionReportPath = flags["derived-ref-report"] ?? path.join(episodeDir, `derived_reference_promotion_report_${episode}.json`);
const providerHealthReportPath = flags["provider-health-report"] ?? path.join(episodeDir, `imagegen_provider_health_${episode}.json`);
const cutExecutionLedgerPath = flags["cut-execution-ledger"] ?? path.join(episodeDir, "cut_execution_ledger.json");
const sceneImageWidth = Number(flags["scene-image-width"] ?? process.env.ANIFACTORY_MODELSLAB_SCENE_IMAGE_WIDTH ?? 1024);
const sceneImageHeight = Number(flags["scene-image-height"] ?? process.env.ANIFACTORY_MODELSLAB_SCENE_IMAGE_HEIGHT ?? 576);
const referenceImageWidth = Number(flags["reference-image-width"] ?? process.env.ANIFACTORY_MODELSLAB_REFERENCE_IMAGE_WIDTH ?? process.env.ANIFACTORY_MODELSLAB_IMAGE_WIDTH ?? 1024);
const referenceImageHeight = Number(flags["reference-image-height"] ?? process.env.ANIFACTORY_MODELSLAB_REFERENCE_IMAGE_HEIGHT ?? process.env.ANIFACTORY_MODELSLAB_IMAGE_HEIGHT ?? 576);
const seedDerivedRefs = flags["seed-derived-refs"] === "true";
const promoteDerivedRefs = flags["promote-derived-refs"] === "true";
const providerCircuitFailureThreshold = Math.max(2, Number(flags["provider-circuit-failures"] ?? process.env.ANIFACTORY_IMAGE_PROVIDER_CIRCUIT_FAILURES ?? 3));
const invocationStartedAt = new Date().toISOString();
const invocationStartedMs = Date.now();

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
  const targetText = `${target.subject ?? ""} ${target.prompt_anchor ?? ""} ${(target.risk_notes ?? []).join(" ")}`.toLowerCase();
  const creatureCharacterState = kind === "character_state"
    && /\b(creature|monster|monsters|hound|hounds|dragon|beast|beasts|wolf|wolves)\b/.test(targetText);
  const groupCharacterState = kind === "character_state"
    && /\b(group|squad|team|crowd|people|guards|soldiers|students|witnesses|faction|workforce)\b/.test(targetText);
  const kindInstruction = {
    style: "16:9 landscape anime/manhwa rendering sample with one coherent frame, clean linework, cel-shaded color, webtoon lighting, and polished production finish",
    character_state: creatureCharacterState
      ? "16:9 landscape creature conditioning image in polished 2D anime/manhwa style: exactly one canonical creature in one neutral pose on a plain studio background, clear full silhouette, anatomy, texture, markings, eyes, and material details"
      : groupCharacterState
        ? "16:9 landscape faction conditioning image in polished 2D anime/manhwa style: three to five clearly distinct visible people, separated full-body adults on a plain studio background, one shared uniform language, varied faces and silhouettes, readable insignia and equipment"
      : "16:9 landscape character conditioning image in polished 2D anime/manhwa style: exactly one visible person in one neutral pose, full-body or three-quarter body centered with ample side breathing room, plain studio background, clear face, hair, age, body type, wardrobe, expression, and materials",
    location: "16:9 landscape unoccupied environment-only conditioning image in polished 2D anime/manhwa style: one coherent view of the architecture, scale, lighting, materials, pathways, surfaces, and readable geography, with clean open space for later scene characters",
    prop: "16:9 landscape prop conditioning image in polished 2D anime/manhwa style: exactly one object on a plain neutral surface, one coherent view, clear shape, materials, markings, scale, and silhouette",
    ui: "16:9 landscape UI conditioning image in polished 2D anime/manhwa style: one coherent interface motif with clear panel geometry, color, glow, icon language, and hierarchy",
    action: "16:9 landscape action/effect conditioning image in polished 2D anime/manhwa style: one readable effect shape, movement path, energy color, interaction pattern, and spatial logic on a neutral field",
  }[kind] ?? "production reference image";
  const parts = [
    kindInstruction,
    target.prompt_anchor,
    target.subject ? `subject: ${target.subject}` : "",
    "single continuous image, stable visual design, no panel grid, no turnaround, no inset faces, no labels, no multiple views, landscape canvas",
  ].filter(Boolean);
  return parts.join(", ");
}

export function referencePromptForTests(target) {
  return referencePrompt(target);
}

function isDerivedReferenceTarget(target) {
  return /^derive_from_/i.test(String(target?.generation_mode ?? ""));
}

function referencePathValue(target) {
  return target?.conditioning_image_path ?? target?.reference_image_path ?? target?.required_reference_path ?? target?.path ?? null;
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

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.map((item) => String(item ?? "").trim()).filter(Boolean) : [];
}

function isLocationTarget(target) {
  return String(target?.kind ?? "").toLowerCase() === "location";
}

function promptRequirementKind(prompt, kindPattern) {
  return (prompt?.reference_requirements ?? []).some((requirement) => kindPattern.test(String(requirement?.kind ?? "").toLowerCase()));
}

function visibleCharacterCount(prompt) {
  const manifest = prompt?.shot_manifest ?? {};
  const names = new Set([
    ...arrayOfStrings(prompt?.visible_characters),
    ...arrayOfStrings(prompt?.visible_subjects),
    ...arrayOfStrings(manifest.visible_characters),
    ...arrayOfStrings(manifest.character_state_ref_ids),
    ...arrayOfStrings(manifest.character_staging?.map?.((entry) => entry?.name) ?? []),
    ...arrayOfStrings(manifest.character_staging?.map?.((entry) => entry?.ref_id) ?? []),
  ]);
  if (manifest.primary_character) names.add(String(manifest.primary_character));
  if (manifest.protagonist_state_ref_id) names.add(String(manifest.protagonist_state_ref_id));
  return [...names].filter(Boolean).length;
}

function promptHasPromotableLocationContamination(prompt) {
  const manifest = prompt?.shot_manifest ?? {};
  if (visibleCharacterCount(prompt) > 0) return true;
  if (promptRequirementKind(prompt, /character/)) return true;
  if (promptRequirementKind(prompt, /(?:prop|ui|action|effect)/)) return true;
  if (arrayOfStrings(manifest.visible_props).length) return true;
  if (arrayOfStrings(manifest.ui_elements).length) return true;
  const text = [
    prompt?.visual_job,
    prompt?.suggested_shot_job,
    manifest.shot_job,
    prompt?.image_prompt,
    prompt?.modelslab_image_prompt,
    prompt?.codex_image_prompt,
  ].filter(Boolean).join(" ");
  if (/\b(?:close[- ]?up|portrait|reaction|hand|phone|screen|panel|ui|sword|weapon|document|letter|book|cup|mug|tabletop|object insert|prop insert)\b/i.test(text)) return true;
  return false;
}

function promptIsCleanLocationSeed(prompt, target) {
  if (!isLocationTarget(target)) return true;
  if (promptHasPromotableLocationContamination(prompt)) return false;
  const text = [
    prompt?.visual_job,
    prompt?.suggested_shot_job,
    prompt?.shot_manifest?.shot_job,
    prompt?.image_prompt,
    prompt?.modelslab_image_prompt,
    prompt?.codex_image_prompt,
  ].filter(Boolean).join(" ");
  return /\b(?:environment|establishing|location|empty|no characters|architecture|interior|exterior|room|hall|corridor|courtyard|street|stage|arena|chapel|cathedral|academy|manor)\b/i.test(text);
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
    .filter((prompt) => promptIsCleanLocationSeed(prompt, target))
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

function referenceFresh(target, outputPath, promptHash) {
  return promptFresh({ image_id: target.ref_id, prompt_hash: promptHash, modelslab_image_prompt: referencePrompt(target) }, outputPath);
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

function slotNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(parsed) : String(value ?? "").trim();
}

function stagingForSlot(prompt, slot) {
  const refId = String(slot?.ref_id ?? "").trim();
  if (!refId) return null;
  const staging = Array.isArray(prompt?.shot_manifest?.character_staging) ? prompt.shot_manifest.character_staging : [];
  return staging.find((entry) => {
    const ids = [
      entry?.ref_id,
      String(entry?.wardrobe_from ?? "").replace(/^character_state_ref:/i, ""),
    ].map((value) => String(value ?? "").trim()).filter(Boolean);
    return ids.includes(refId);
  }) ?? null;
}

function characterSlotSubtype(slot, staging = null) {
  const text = `${slot?.subject ?? ""} ${slot?.ref_id ?? ""} ${slot?.purpose ?? ""} ${staging?.name ?? ""}`.toLowerCase();
  if (/\b(?:creature|monster|hound|dragon|beast|wolf|spirit|demon|construct)\b/.test(text)) return "creature";
  if (/\b(?:group|squad|team|crowd|guards|soldiers|students|witnesses|faction|workforce|guild masters)\b/.test(text)) return "group";
  return "human";
}

function referenceSlotRole(slot, prompt) {
  const slotNo = slotNumber(slot.slot);
  const kind = String(slot.kind ?? "").toLowerCase();
  const purpose = String(slot.purpose ?? referenceSlotPurpose(slot)).trim();
  const staging = stagingForSlot(prompt, slot);

  if (kind.includes("character")) {
    const subject = staging?.name ?? slot.subject ?? slot.ref_id ?? "the referenced subject";
    const position = staging?.screen_position ? ` Place ${subject} at ${staging.screen_position}.` : "";
    const pose = staging?.pose ? ` Current action: ${staging.pose}.` : "";
    const subtype = characterSlotSubtype(slot, staging);
    if (subtype === "creature") return `Use Image ${slotNo} for ${subject}'s anatomy, silhouette, texture, markings, eyes, and identity.${position}${pose}`;
    if (subtype === "group") return `Use Image ${slotNo} for ${subject}'s uniform palette, insignia, equipment, and silhouette variety.${position}${pose}`;
    return `Use Image ${slotNo} for ${subject}'s face, hair, body type, wardrobe, and identity.${position}${pose}`;
  }
  if (kind.includes("location")) {
    return `Use Image ${slotNo} for the setting's architecture, materials, lighting, surfaces, and spatial layout.`;
  }
  if (kind.includes("prop")) {
    return `Use Image ${slotNo} for the prop's shape, material, color, and readable silhouette.`;
  }
  if (kind.includes("ui")) {
    return `Use Image ${slotNo} for the UI style, panel shapes, glow language, icon style, and layout logic.`;
  }
  if (kind.includes("action") || kind.includes("effect")) {
    return `Use Image ${slotNo} for the action/effect energy shape, motion language, color behavior, and interaction pattern.`;
  }
  if (kind.includes("style")) {
    return `Use Image ${slotNo} for the overall anime/manhwa visual style, rendering finish, and color treatment.`;
  }
  return `Use Image ${slotNo} for ${purpose}.`;
}

function conciseReferenceSlotRole(slot, prompt, index) {
  const kind = String(slot.kind ?? "").toLowerCase();
  const staging = stagingForSlot(prompt, slot);
  const subject = staging?.name ?? slot.character ?? slot.subject ?? slot.ref_id ?? `reference ${index + 1}`;
  const source = `Image ${index + 1}`;
  if (kind.includes("character")) {
    const subtype = characterSlotSubtype(slot, staging);
    if (subtype === "creature") return `${source} = exact ${subject} anatomy, silhouette, texture, and markings`;
    if (subtype === "group") return `${source} = exact ${subject} uniform, insignia, and equipment language`;
    return `${source} = exact ${subject} identity and wardrobe`;
  }
  if (kind.includes("location")) return `${source} = exact setting architecture and spatial layout`;
  if (kind.includes("prop")) return `${source} = exact prop design and materials`;
  if (kind.includes("ui")) return `${source} = exact UI design language`;
  if (kind.includes("action") || kind.includes("effect")) return `${source} = exact action or effect design language`;
  if (kind.includes("style")) return `${source} = exact anime/manhwa rendering style`;
  return `${source} = ${subject}`;
}

function referenceSlotInstruction(slots, prompt = {}, { concise = false } = {}) {
  if (!slots.length) return "";
  const roles = slots.map((slot, index) => {
    if (concise) return conciseReferenceSlotRole(slot, prompt, index);
    return referenceSlotRole(slot, prompt);
  }).join(" ");
  if (concise) {
    return [
      "Reference mapping:",
      `${roles}.`,
      "Keep referenced subjects distinct; use the scene prompt for pose, position, action, setting, lighting, and composition.",
    ].join(" ");
  }
  return [
    "Reference usage:",
    roles,
    "Compose one unified final scene. Match the referenced subjects/settings while following the prompt's current action, position, lighting, and composition.",
  ].filter(Boolean).join(" ");
}

export function referenceSlotInstructionForTests(slots, prompt = {}, options = {}) {
  return referenceSlotInstruction(slots, prompt, options);
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
    if (!character || !sourceRefId || existingIds.has(sourceRefId) || !referencePathValue(ref)) continue;
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
    const equivalentRefIds = [
      manifestId,
      ref?.state_ref_id,
      ref?.source_ref_id,
      ref?.base_identity_ref_id,
    ].map((id) => String(id ?? "").trim()).filter(Boolean);
    if (equivalentRefIds.some((id) => existingIds.has(id))) continue;
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

function withCharacterReferenceAliases(referenceById, characterRefs = []) {
  const resolved = new Map(referenceById);
  for (const ref of characterRefs ?? []) {
    const stateRefId = String(ref?.state_ref_id ?? "").trim();
    const sourceRefId = String(ref?.source_ref_id ?? "").trim();
    const baseIdentityRefId = String(ref?.base_identity_ref_id ?? "").trim();
    const path = resolved.get(stateRefId)
      ?? resolved.get(sourceRefId)
      ?? resolved.get(baseIdentityRefId)
      ?? null;
    if (!path) continue;
    if (stateRefId) resolved.set(stateRefId, path);
    if (sourceRefId && !resolved.has(sourceRefId)) resolved.set(sourceRefId, path);
    if (baseIdentityRefId && !resolved.has(baseIdentityRefId)) resolved.set(baseIdentityRefId, path);
  }
  return resolved;
}

function attachReferencePathsToPrompts(plan, referenceById, characterRefs = [], referenceTargets = []) {
  const resolvedReferenceById = withCharacterReferenceAliases(referenceById, characterRefs);
  const inferVisibleSubjectRefs = !isHardenedPromptPlan(plan);
  const prompts = (plan.prompts ?? []).map((prompt) => {
    const stagingContext = stagedCharacterSlotContext(prompt, characterRefs);
    const authoredRequirements = Array.isArray(prompt.reference_requirements)
      ? prompt.reference_requirements.filter((requirement) => requirement.inferred_from_visible_subject !== true)
      : [];
    const existingIds = new Set(authoredRequirements.map((requirement) => requirement.ref_id).filter(Boolean));
    const requirements = [
      ...authoredRequirements,
      ...manifestReferenceRequirements(prompt, characterRefs, resolvedReferenceById, referenceTargets, existingIds),
      ...(inferVisibleSubjectRefs ? characterReferenceRequirements(prompt, characterRefs, existingIds) : []),
    ];
    const availableRows = requirements
      .map((requirement, index) => ({
        requirement,
        index,
        path: resolvedReferenceById.get(requirement.ref_id),
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
        const refPath = resolvedReferenceById.get(requirement.ref_id) ?? null;
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
  return {
    ...plan,
    prompts,
    reference_paths_attached_at: new Date().toISOString(),
    max_scene_references: maxSceneReferences,
  };
}

export function attachReferencePathsToPromptsForTests(plan, referenceById, characterRefs = [], referenceTargets = []) {
  return attachReferencePathsToPrompts(plan, referenceById, characterRefs, referenceTargets);
}

export function scenePromptProductionContractFindingsForTests(prompts, options = {}) {
  const referenceLimit = Number(options.maxSceneReferences ?? maxSceneReferences);
  const findings = [];
  for (const prompt of prompts ?? []) {
    const requirements = Array.isArray(prompt.reference_requirements) ? prompt.reference_requirements : [];
    const slots = Array.isArray(prompt.reference_slots) ? prompt.reference_slots : [];
    const slotIds = new Set(slots.map((slot) => String(slot?.ref_id ?? "").trim()).filter(Boolean));
    const attachableRequired = requirements.filter((requirement) => (
      requirement?.required === true
      && String(requirement?.reference_image_path ?? "").trim()
    ));
    if (referenceLimit === 0 && attachableRequired.length) {
      findings.push({
        image_id: prompt.image_id,
        code: "required_scene_references_disabled",
        message: `Scene references are disabled, but ${attachableRequired.length} required approved reference(s) are available.`,
      });
    }
    for (const requirement of attachableRequired) {
      if (!slotIds.has(String(requirement.ref_id))) {
        findings.push({
          image_id: prompt.image_id,
          ref_id: requirement.ref_id,
          code: "required_reference_slot_missing",
          message: `Required approved ref ${requirement.ref_id} is not materialized in reference_slots.`,
        });
      }
    }
    const promptText = promptTextForImageProvider(prompt, "modelslab");
    if (!/\b(?:anime|manhwa|webtoon|manga)\b/i.test(promptText)) {
      findings.push({
        image_id: prompt.image_id,
        code: "scene_prompt_style_contract_missing",
        message: "ModelsLab scene prompt must explicitly preserve anime/manhwa/webtoon/manga style.",
      });
    }
    if (prompt?.shot_manifest?.shot_job === "physical_action" && !String(prompt?.shot_manifest?.foreground_action ?? "").trim()) {
      findings.push({
        image_id: prompt.image_id,
        code: "physical_action_contract_missing",
        message: "Physical-action cut is missing shot_manifest.foreground_action.",
      });
    }
  }
  return findings;
}

function assertGeneratedProviderContract(prompt, generated, submittedPrompt, referenceImagePaths, routedProvider) {
  if (routedProvider !== "modelslab" || !/^gpt[-_]?image[-_]?2/i.test(String(generated?.modelslab_model_id ?? ""))) return;
  if (String(generated.modelslab_submitted_prompt ?? "") !== String(submittedPrompt ?? "")) {
    throw new Error(`GPT Image 2 provider prompt changed before submission for ${prompt.image_id}.`);
  }
  if (Number(generated.modelslab_submitted_prompt_length ?? -1) !== String(submittedPrompt ?? "").length
    || Number(generated.modelslab_original_prompt_length ?? -1) !== String(submittedPrompt ?? "").length
    || generated.modelslab_prompt_compacted === true) {
    throw new Error(`GPT Image 2 prompt truncation/compaction detected for ${prompt.image_id}.`);
  }
  if (Number(generated.modelslab_reference_count ?? -1) !== referenceImagePaths.length) {
    throw new Error(`GPT Image 2 reference-count mismatch for ${prompt.image_id}: expected ${referenceImagePaths.length}, provider recorded ${generated.modelslab_reference_count}.`);
  }
  if (referenceImagePaths.length && (!/image-to-image/i.test(String(generated.modelslab_endpoint ?? ""))
    || !/i2i/i.test(String(generated.modelslab_model_id ?? "")))) {
    throw new Error(`Referenced GPT Image 2 cut ${prompt.image_id} did not use the image-to-image route.`);
  }
}

function promptWithReferenceSlots(prompt, provider = imageProvider, { concise = false } = {}) {
  const basePrompt = promptTextForImageProvider(prompt, provider);
  const slotInstruction = referenceSlotInstruction(prompt.reference_slots ?? [], prompt, { concise });
  return [slotInstruction, basePrompt].filter(Boolean).join(" ");
}

function isGptImage2Route(model) {
  return /^gpt[-_]?image[-_]?2/i.test(String(model ?? ""));
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
  if (metadata?.source_prompt_sha256) {
    const currentPromptPlanHash = await hashFile(promptPath);
    if (metadata.source_prompt_sha256 !== currentPromptPlanHash) return false;
  }
  if (Array.isArray(metadata?.reference_inputs)) {
    for (const input of metadata.reference_inputs) {
      if (!input?.path || !input?.sha256 || await hashFile(input.path) !== input.sha256) return false;
    }
  }
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

function providerInfrastructureFailure(error) {
  const message = String(error?.message ?? error ?? "");
  return /\b(?:429|500|502|503|504|520|522|524)\b|gateway|rate.?limit|queue|timed?\s*out|timeout|service unavailable|temporarily unavailable|fetch failed|socket hang up/i.test(message);
}

async function runPoolWithCircuitBreaker(items, worker, limit) {
  const results = new Array(items.length);
  let cursor = 0;
  let active = 0;
  const configuredLimit = Math.max(1, Math.min(limit, items.length || 1));
  let adaptiveLimit = configuredLimit;
  let minimumAdaptiveLimit = adaptiveLimit;
  let maximumObservedActive = 0;
  let successesSinceAdjustment = 0;
  let consecutiveInfrastructureFailures = 0;
  let circuitOpen = false;
  let circuitReason = null;
  const concurrencyEvents = [];
  await new Promise((resolve) => {
    const finishIfDone = () => {
      if ((cursor >= items.length || circuitOpen) && active === 0) resolve();
    };
    const launch = () => {
      while (!circuitOpen && cursor < items.length && active < adaptiveLimit) {
        const current = cursor;
        cursor += 1;
        active += 1;
        maximumObservedActive = Math.max(maximumObservedActive, active);
        Promise.resolve()
          .then(() => worker(items[current], current))
          .then((result) => {
            results[current] = result;
            consecutiveInfrastructureFailures = 0;
            successesSinceAdjustment += 1;
            if (adaptiveLimit < configuredLimit && successesSinceAdjustment >= Math.max(3, adaptiveLimit)) {
              const previous = adaptiveLimit;
              adaptiveLimit += 1;
              successesSinceAdjustment = 0;
              concurrencyEvents.push({ type: "recovery_ramp", from: previous, to: adaptiveLimit, after_index: current });
            }
          })
          .catch((error) => {
            const item = items[current] ?? {};
            const infrastructureFailure = providerInfrastructureFailure(error);
            consecutiveInfrastructureFailures = infrastructureFailure ? consecutiveInfrastructureFailures + 1 : 0;
            successesSinceAdjustment = 0;
            results[current] = {
              image_id: item.image_id,
              ref_id: item.ref_id,
              status: "failed",
              error: error instanceof Error ? error.message : String(error),
              provider_infrastructure_failure: infrastructureFailure,
            };
            if (infrastructureFailure && adaptiveLimit > 1) {
              const previous = adaptiveLimit;
              adaptiveLimit = Math.max(1, Math.ceil(adaptiveLimit / 2));
              minimumAdaptiveLimit = Math.min(minimumAdaptiveLimit, adaptiveLimit);
              concurrencyEvents.push({
                type: "provider_backoff",
                from: previous,
                to: adaptiveLimit,
                after_index: current,
                evidence: String(error instanceof Error ? error.message : error).slice(0, 240),
              });
            }
            if (infrastructureFailure && consecutiveInfrastructureFailures >= providerCircuitFailureThreshold) {
              circuitOpen = true;
              circuitReason = `provider circuit opened after ${consecutiveInfrastructureFailures} consecutive infrastructure failures`;
            }
          })
          .finally(() => {
            active -= 1;
            launch();
            finishIfDone();
          });
      }
      finishIfDone();
    };
    launch();
  });
  if (circuitOpen) {
    for (let index = 0; index < items.length; index += 1) {
      if (results[index]) continue;
      results[index] = {
        image_id: items[index]?.image_id,
        ref_id: items[index]?.ref_id,
        status: "skipped_provider_circuit_open",
        error: circuitReason,
        provider_infrastructure_failure: true,
      };
    }
  }
  return {
    results,
    circuit_open: circuitOpen,
    circuit_reason: circuitReason,
    failure_threshold: providerCircuitFailureThreshold,
    adaptive_concurrency: {
      configured: configuredLimit,
      minimum: minimumAdaptiveLimit,
      final: adaptiveLimit,
      maximum_observed_active: maximumObservedActive,
      events: concurrencyEvents,
    },
  };
}

export async function runPoolWithCircuitBreakerForTests(items, worker, limit) {
  return runPoolWithCircuitBreaker(items, worker, limit);
}

function promptReferenceCount(prompt) {
  return Math.min(4, Array.isArray(prompt?.reference_slots)
    ? prompt.reference_slots.length
    : Array.isArray(prompt?.reference_requirements)
      ? prompt.reference_requirements.filter((row) => row?.reference_image_path).length
      : 0);
}

function providerHealthProbeEnabled(prompts) {
  if (flags["provider-health-probe"] === "true") return true;
  if (flags["provider-health-probe"] === "false") return false;
  return prompts.some((prompt) => isGptImage2Route(imageModelOverride ?? prompt.image_model_route ?? "flux-klein"));
}

function representativeProviderProbePrompts(prompts) {
  const selected = [];
  const used = new Set();
  for (const wanted of [0, 1, 2, 4]) {
    const row = prompts.find((prompt) => !used.has(prompt.image_id) && promptReferenceCount(prompt) === wanted);
    if (!row) continue;
    selected.push(row);
    used.add(row.image_id);
  }
  if (!selected.length && prompts[0]) selected.push(prompts[0]);
  return selected;
}

async function runProviderHealthProbe(prompts) {
  const selected = representativeProviderProbePrompts(prompts);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const probe = await runPoolWithCircuitBreaker(selected, generateOne, Math.min(2, selected.length));
  const passed = probe.results.every(imageResultPassed);
  const report = {
    schema: "goldflow_image_provider_health_v1",
    status: passed ? "passed" : "failed",
    channel,
    series_slug: series,
    week,
    episode,
    image_provider: imageProvider,
    image_model: imageModelOverride ?? "prompt_routed_model",
    representative_reference_counts: selected.map(promptReferenceCount),
    representative_image_ids: selected.map((prompt) => prompt.image_id),
    results: probe.results,
    circuit_open: probe.circuit_open,
    circuit_reason: probe.circuit_reason,
    started_at: startedAt,
    duration_sec: Number(((Date.now() - startedMs) / 1000).toFixed(3)),
    updated_at: new Date().toISOString(),
  };
  await writeJson(providerHealthReportPath, report);
  if (!passed) {
    throw new Error(`Provider health probe failed for ${selected.map((prompt) => prompt.image_id).join(", ")}. Inspect ${providerHealthReportPath}; completed probe cuts remain reusable.`);
  }
  return report;
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
  return "";
}

async function generateOne(prompt) {
  const routedProvider = promptRoute(prompt);
  const outputPath = imagePathFor(prompt, routedProvider);
  const referenceImagePaths = await validateReferences(prompt);
  const sceneGeometry = routedProvider === "modelslab" ? modelslabSceneGeometry() : {};
  const sceneModel = imageModelOverride ?? prompt.image_model_route ?? "flux-klein";
  const modelPrompt = [
    sceneAspectInstruction(routedProvider),
    promptWithReferenceSlots(prompt, routedProvider, {
      concise: routedProvider === "modelslab" && isGptImage2Route(sceneModel),
    }),
  ].filter(Boolean).join(" ");
  const referenceInputs = await Promise.all(referenceImagePaths.map(async (referencePath) => ({
    path: referencePath,
    sha256: await hashFile(referencePath),
  })));
  const promptHash = sha256(JSON.stringify({ prompt: modelPrompt, provider: routedProvider, model: sceneModel, reference_inputs: referenceInputs, ...sceneGeometry }));
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
    model: sceneModel,
    provider: routedProvider,
    ...sceneGeometry,
  });
  assertGeneratedProviderContract(prompt, generated, modelPrompt, referenceImagePaths, routedProvider);
  await fs.writeFile(`${outputPath}.prompt.sha256`, promptHash, "utf8");
  await writeJson(`${outputPath}.metadata.json`, {
    image_id: prompt.image_id,
    prompt_hash: promptHash,
    source_prompt_path: promptPath,
    reference_image_paths: referenceImagePaths,
    reference_inputs: referenceInputs,
    reference_slots: prompt.reference_slots ?? [],
    image_prompt: modelPrompt,
    source_image_prompt: prompt.image_prompt ?? null,
    source_modelslab_image_prompt: prompt.modelslab_image_prompt ?? null,
    source_codex_image_prompt: prompt.codex_image_prompt ?? null,
    modelslab_prompt: routedProvider === "modelslab" ? modelPrompt : null,
    codex_prompt: routedProvider === "codex_imagegen" ? modelPrompt : null,
    image_provider: routedProvider,
    image_provider_route: imageProvider,
    model: routedProvider === "codex_imagegen" ? generated.model : sceneModel,
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
  const referenceImagePaths = [
    ...(baseIdentityPath ? [baseIdentityPath] : []),
    ...(target.ref_id !== "style_ref" && styleRefPath ? [styleRefPath] : []),
  ].slice(0, 4);
  const referenceModel = referenceImageModelOverride ?? target.image_model_route ?? "flux-klein";
  const referenceInputs = await Promise.all(referenceImagePaths.map(async (referencePath) => ({
    path: referencePath,
    sha256: await hashFile(referencePath),
  })));
  const promptHash = sha256(JSON.stringify({
    prompt,
    provider: routedProvider,
    model: referenceModel,
    geometry: routedProvider === "modelslab" ? modelslabReferenceGeometry(target) : null,
    reference_inputs: referenceInputs,
  }));
  if (!forceReferences && await referenceFresh(target, outputPath, promptHash)) {
    return { ref_id: target.ref_id, status: "reused_fresh", image_path: outputPath, prompt_hash: promptHash };
  }
  const generated = await generateProviderImage({
    prompt,
    outputPath,
    referenceImagePaths,
    model: referenceModel,
    provider: routedProvider,
    ...(routedProvider === "modelslab" ? modelslabReferenceGeometry(target) : {}),
  });
  await fs.writeFile(`${outputPath}.prompt.sha256`, promptHash, "utf8");
  await writeJson(`${outputPath}.metadata.json`, {
    ref_id: target.ref_id,
    kind: target.kind,
    subject: target.subject,
    prompt_hash: promptHash,
    reference_master_prompt: target.prompt_anchor ?? null,
    conditioning_prompt: prompt,
    conditioning_image_path: generated.downloaded_path ?? outputPath,
    source_reference_plan_path: visualReferencePlanPath,
    reference_image_paths: referenceImagePaths,
    reference_inputs: referenceInputs,
    base_identity_ref_id: baseIdentityRefId,
    image_provider: routedProvider,
    image_provider_route: imageProvider,
    model: routedProvider === "codex_imagegen" ? generated.model : referenceModel,
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
      const targetPath = referencePathValue(target);
      if (target.ref_id && targetPath && await exists(targetPath)) referenceEntries.push([target.ref_id, targetPath]);
    }
    for (const ref of characterRefs?.character_state_refs ?? []) {
      const refPath = referencePathValue(ref);
      if (ref.source_ref_id && refPath && await exists(refPath)) referenceEntries.push([ref.source_ref_id, refPath]);
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
    const targetPath = referencePathValue(target);
    if (target.ref_id && targetPath && await exists(targetPath)) existingReferenceEntries.push([target.ref_id, targetPath]);
  }
  for (const ref of characterRefs?.character_state_refs ?? []) {
    const refPath = referencePathValue(ref);
    if (ref.source_ref_id && refPath && await exists(refPath)) existingReferenceEntries.push([ref.source_ref_id, refPath]);
  }
  const requestedTargets = referencePlan.reference_targets
    .filter((target) => target.generation_mode === "standalone_ref" || target.required_before_imagegen === true || referenceScope.has(target.ref_id))
    .filter((target) => !referenceScope.size || referenceScope.has(target.ref_id));
  const targets = [];
  for (const target of requestedTargets) {
    targets.push(target);
  }
  const styleTarget = targets.find((target) => isStyleReferenceTarget(target));
  const results = [];
  const existingStyleTarget = referencePlan.reference_targets.find((target) => isStyleReferenceTarget(target) && referencePathValue(target));
  let styleRefPath = existingStyleTarget && await exists(referencePathValue(existingStyleTarget))
    ? referencePathValue(existingStyleTarget)
    : null;
  const referenceById = new Map(existingReferenceEntries);
  if (styleTarget) {
    const result = await generateReference(styleTarget, null, referenceById, characterRefs?.character_state_refs ?? []);
    results.push(result);
    referenceById.set(result.ref_id, result.image_path);
    styleRefPath = result.image_path;
  }
  const remaining = targets.filter((target) => target.ref_id !== styleTarget?.ref_id);
  const referencePool = await runPoolWithCircuitBreaker(
    remaining,
    (target) => generateReference(target, styleRefPath, referenceById, characterRefs?.character_state_refs ?? []),
    referenceConcurrency,
  );
  const remainingResults = referencePool.results;
  results.push(...remainingResults);
  for (const row of remainingResults) {
    if (row?.ref_id && row?.image_path && imageResultPassed(row)) referenceById.set(row.ref_id, row.image_path);
  }
  const updatedReferencePlan = {
    ...referencePlan,
    reference_targets: referencePlan.reference_targets.map((target) => ({
      ...target,
      reference_image_path: target.reference_image_path ?? referenceById.get(target.ref_id) ?? null,
      conditioning_image_path: referenceById.get(target.ref_id) ?? target.conditioning_image_path ?? target.reference_image_path ?? null,
    })),
    reference_generation_updated_at: new Date().toISOString(),
  };
  await writeJson(visualReferencePlanPath, updatedReferencePlan);
  if (characterRefs?.character_state_refs) {
    const updatedCharacterRefs = {
      ...characterRefs,
      character_state_refs: characterRefs.character_state_refs.map((ref) => ({
        ...ref,
        reference_image_path: ref.reference_image_path ?? referenceById.get(ref.source_ref_id) ?? null,
        conditioning_image_path: referenceById.get(ref.source_ref_id) ?? ref.conditioning_image_path ?? ref.reference_image_path ?? null,
      })),
      reference_generation_updated_at: new Date().toISOString(),
    };
    await writeJson(characterStateRefsPath, updatedCharacterRefs);
  }
  return {
    referencePlan: updatedReferencePlan,
    characterRefs,
    results,
    referenceById,
    provider_circuit_open: referencePool.circuit_open,
    provider_circuit_reason: referencePool.circuit_reason,
    adaptive_concurrency: referencePool.adaptive_concurrency,
  };
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
        reason: candidateIds.length
          ? "clean candidate cuts are not generated yet"
          : isLocationTarget(target)
            ? "no clean environment-only candidate cuts found for derived location ref target"
            : "no candidate cuts found for derived ref target",
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
    ["goldflow_imagegen_report_v1", "goldflow_imagegen_report_v2"].includes(priorReport?.schema)
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

function episodeImageStatus(currentBatchStatus, cutLedgerStatus) {
  if (currentBatchStatus === "failed") return "failed";
  return cutLedgerStatus === "passed" ? "passed" : "partial";
}

function imagegenCostSummary(rows = []) {
  const generatedRows = (rows ?? []).filter((row) => String(row?.status ?? "").toLowerCase() === "generated");
  const estimatedRows = generatedRows.filter((row) => Number.isFinite(Number(row?.generated?.estimated_cost_usd)));
  const estimatedCostUsd = estimatedRows.reduce((sum, row) => sum + Number(row.generated.estimated_cost_usd), 0);
  const byModel = {};
  for (const row of estimatedRows) {
    const model = String(row.generated?.modelslab_model_id ?? row.generated?.model ?? row.generated?.model_id ?? "unknown");
    if (!byModel[model]) byModel[model] = { generated_count: 0, estimated_cost_usd: 0 };
    byModel[model].generated_count += 1;
    byModel[model].estimated_cost_usd = Number((byModel[model].estimated_cost_usd + Number(row.generated.estimated_cost_usd)).toFixed(6));
  }
  return {
    generated_count: generatedRows.length,
    estimated_count: estimatedRows.length,
    estimated_cost_usd: Number(estimatedCostUsd.toFixed(6)),
    by_model: byModel,
    note: "Estimated from ModelsLab catalog/model detail price fields; reused cached/imported images add zero incremental cost.",
  };
}

function imagegenBatchId(kind, currentRows) {
  return sha256(JSON.stringify({
    kind,
    started_at: invocationStartedAt,
    ids: (currentRows ?? []).map((row) => row.image_id ?? row.ref_id ?? null),
    statuses: (currentRows ?? []).map((row) => row.status ?? null),
  })).slice(0, 16);
}

async function immutableImagegenBatchReports() {
  const dir = path.join(episodeDir, "reports", "imagegen-batches");
  const names = await fs.readdir(dir).catch(() => []);
  const reports = [];
  for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
    const filePath = path.join(dir, name);
    const report = await readJson(filePath, null);
    if (report?.schema === "goldflow_imagegen_batch_report_v1") reports.push({ filePath, report });
  }
  return reports;
}

async function writeAuditableImagegenReport(report, { kind, currentRows }) {
  const completedAt = new Date().toISOString();
  const batchId = imagegenBatchId(kind, currentRows);
  const batchDir = path.join(episodeDir, "reports", "imagegen-batches");
  const safeTime = completedAt.replace(/[:.]/g, "-");
  const batchPath = path.join(batchDir, `${safeTime}-${batchId}.json`);
  const batchCost = imagegenCostSummary(currentRows);
  const immutable = {
    ...report,
    schema: "goldflow_imagegen_batch_report_v1",
    batch_id: batchId,
    batch_kind: kind,
    current_batch_status: report.current_batch_status ?? report.status,
    episode_status: report.episode_status ?? report.status,
    current_batch_results: currentRows,
    current_batch_cost: batchCost,
    started_at: invocationStartedAt,
    completed_at: completedAt,
    wall_time_sec: Number(((Date.now() - invocationStartedMs) / 1000).toFixed(3)),
    materialized_report_path: reportPath,
  };
  await writeJson(batchPath, immutable);
  const history = await immutableImagegenBatchReports();
  const cumulative = {
    batch_count: history.length,
    generated_count: history.reduce((sum, row) => sum + Number(row.report.current_batch_cost?.generated_count ?? 0), 0),
    estimated_count: history.reduce((sum, row) => sum + Number(row.report.current_batch_cost?.estimated_count ?? 0), 0),
    estimated_cost_usd: Number(history.reduce((sum, row) => sum + Number(row.report.current_batch_cost?.estimated_cost_usd ?? 0), 0).toFixed(6)),
    wall_time_sec: Number(history.reduce((sum, row) => sum + Number(row.report.wall_time_sec ?? 0), 0).toFixed(3)),
    retry_batch_count: Math.max(0, history.length - 1),
    immutable_batch_report_paths: history.map((row) => row.filePath),
  };
  const materialized = {
    ...report,
    schema: "goldflow_imagegen_report_v2",
    immutable_batch_report_path: batchPath,
    cumulative_history: cumulative,
    updated_at: completedAt,
  };
  await writeJson(reportPath, materialized);
  return materialized;
}

export async function cumulativeImagegenHistoryForTests(batchReports = []) {
  return {
    batch_count: batchReports.length,
    estimated_cost_usd: Number(batchReports.reduce((sum, row) => sum + Number(row.current_batch_cost?.estimated_cost_usd ?? 0), 0).toFixed(6)),
    wall_time_sec: Number(batchReports.reduce((sum, row) => sum + Number(row.wall_time_sec ?? 0), 0).toFixed(3)),
  };
}

async function writeCutExecutionLedger(plan, rows, promptPlanHash) {
  const previous = await readJson(cutExecutionLedgerPath, null);
  const previousById = new Map((previous?.cuts ?? []).map((row) => [String(row.image_id ?? ""), row]));
  const resultById = new Map((rows ?? []).filter((row) => row?.image_id).map((row) => [String(row.image_id), row]));
  const cuts = [];
  for (const prompt of plan.prompts ?? []) {
    if (prompt.image_generation_required === false) continue;
    const imageId = String(prompt.image_id ?? "");
    const result = resultById.get(imageId) ?? null;
    const imagePath = result?.image_path ?? null;
    const imageHash = imagePath && await exists(imagePath) ? await hashFile(imagePath) : null;
    const metadata = imagePath ? await readJson(`${imagePath}.metadata.json`, null) : null;
    const referencePaths = [...new Set((metadata?.reference_image_paths ?? prompt.reference_slots?.map((slot) => slot.reference_image_path) ?? []).filter(Boolean))];
    const references = [];
    for (const referencePath of referencePaths) {
      references.push({
        path: referencePath,
        sha256: await hashFile(referencePath),
      });
    }
    const beatHash = sha256(JSON.stringify({
      scene_id: prompt.scene_id ?? null,
      visual_beat_id: prompt.visual_beat_id ?? null,
      start_sec: prompt.start_sec ?? null,
      duration_sec: prompt.duration_sec ?? null,
      visual_beat_script_excerpt: prompt.visual_beat_script_excerpt ?? null,
      visual_beat_action: prompt.visual_beat_action ?? null,
      visual_job: prompt.visual_job ?? null,
    }));
    const authoredPromptHash = sha256(JSON.stringify({
      image_prompt: prompt.image_prompt ?? null,
      modelslab_image_prompt: prompt.modelslab_image_prompt ?? null,
      codex_image_prompt: prompt.codex_image_prompt ?? null,
      shot_manifest: prompt.shot_manifest ?? null,
      reference_requirements: prompt.reference_requirements ?? [],
    }));
    const prior = previousById.get(imageId);
    const unchangedImage = Boolean(prior?.image_sha256 && imageHash && prior.image_sha256 === imageHash);
    cuts.push({
      image_id: imageId,
      scene_id: prompt.scene_id ?? null,
      visual_beat_id: prompt.visual_beat_id ?? null,
      start_sec: Number(prompt.start_sec ?? 0),
      duration_sec: Number(prompt.duration_sec ?? 0),
      beat_hash: beatHash,
      authored_prompt_hash: authoredPromptHash,
      submitted_prompt_hash: result?.prompt_hash ?? metadata?.prompt_hash ?? null,
      reference_ids: (prompt.reference_slots ?? prompt.reference_requirements ?? []).map((row) => row.ref_id).filter(Boolean),
      references,
      image_provider: result?.image_provider ?? metadata?.image_provider ?? null,
      image_model: result?.generated?.modelslab_model_id ?? result?.generated?.model ?? metadata?.model ?? null,
      image_path: imagePath,
      image_sha256: imageHash,
      generation_status: result?.status ?? "missing",
      image_qa_status: unchangedImage ? prior.image_qa_status ?? "pending" : "pending",
      image_qa_note: unchangedImage ? prior.image_qa_note ?? null : null,
      motion_profile_hash: unchangedImage ? prior.motion_profile_hash ?? null : null,
      motion_clip_path: unchangedImage ? prior.motion_clip_path ?? null : null,
      motion_clip_sha256: unchangedImage ? prior.motion_clip_sha256 ?? null : null,
    });
  }
  const complete = cuts.length > 0 && cuts.every((cut) => cut.image_sha256 && imageResultPassed(resultById.get(cut.image_id)));
  const ledger = {
    schema: "goldflow_cut_execution_ledger_v1",
    status: complete ? "passed" : "partial",
    channel,
    series_slug: series,
    week,
    episode,
    prompt_plan_path: promptPath,
    prompt_plan_hash: promptPlanHash,
    imagegen_report_path: reportPath,
    cut_count: cuts.length,
    completed_image_count: cuts.filter((cut) => cut.image_sha256).length,
    pending_image_qa_count: cuts.filter((cut) => !String(cut.image_qa_status ?? "").startsWith("passed")).length,
    cuts,
    updated_at: new Date().toISOString(),
  };
  await writeJson(cutExecutionLedgerPath, ledger);
  return ledger;
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
  if (runIdentity.schema === "goldflow_run_identity_v2" && !skipReferenceGeneration) {
    const approval = await readJson(referencePlanApprovalPath, null);
    const currentPlan = await readJson(visualReferencePlanPath, null);
    const currentPlanHash = await hashFile(visualReferencePlanPath);
    if (!currentPlan || !referencePlanApprovalMatches({ approval, plan: currentPlan, fileSha256: currentPlanHash })) {
      throw new Error(`Reference generation refused: current reference_plan_approval.json is missing or stale for ${visualReferencePlanPath}. Run goldflow visual approve-ref-plan first.`);
    }
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
      reference_provider_circuit_open: Boolean(referenceRun.provider_circuit_open),
      reference_provider_circuit_reason: referenceRun.provider_circuit_reason ?? null,
      codex_opening_sec: codexOpeningSec,
      reference_count: referenceRun.results.length,
      reference_results: referenceRun.results,
      estimated_cost: imagegenCostSummary(referenceRun.results),
      updated_at: new Date().toISOString(),
    };
    report.current_batch_status = report.status;
    report.episode_status = report.status;
    const materialized = await writeAuditableImagegenReport(report, { kind: "references", currentRows: referenceRun.results });
    console.log(JSON.stringify({ status: materialized.status, report_path: reportPath, immutable_batch_report_path: materialized.immutable_batch_report_path, reference_count: materialized.reference_count }, null, 2));
    if (materialized.status !== "passed") process.exitCode = 1;
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
  const productionContractFindings = scenePromptProductionContractFindingsForTests(
    prompts.filter((prompt) => promptRoute(prompt) === "modelslab"),
    { maxSceneReferences },
  );
  if (productionContractFindings.length) {
    throw new Error(
      `Scene image production contract failed for ${productionContractFindings.length} finding(s): ` +
      productionContractFindings.slice(0, 12).map((finding) => `${finding.image_id}:${finding.code}`).join(", "),
    );
  }
  await fs.mkdir(imageDir, { recursive: true });
  const promptPlanHash = await hashFile(promptPath);
  const allPromptIds = new Set(plan.prompts.filter((prompt) => prompt.image_generation_required !== false).map((prompt) => prompt.image_id));
  let providerHealthReport = null;
  let probeResults = [];
  if (providerHealthProbeEnabled(prompts)) {
    providerHealthReport = await runProviderHealthProbe(prompts);
    probeResults = providerHealthReport.results ?? [];
  }
  const probedIds = new Set(probeResults.map((row) => String(row.image_id ?? "")).filter(Boolean));
  const remainingPrompts = prompts.filter((prompt) => !probedIds.has(String(prompt.image_id ?? "")));
  const pool = await runPoolWithCircuitBreaker(remainingPrompts, generateOne, concurrency);
  const results = [...probeResults, ...pool.results];
  const mergedResults = await mergeImagegenResults({ currentResults: results, promptIds: allPromptIds, promptPlanHash });
  const cutExecutionLedger = await writeCutExecutionLedger(plan, mergedResults, promptPlanHash);
  const currentBatchStatus = results.every((row) => imageResultPassed(row)) ? "passed" : "failed";
  const episodeStatus = episodeImageStatus(currentBatchStatus, cutExecutionLedger.status);
  const report = {
    schema: "goldflow_imagegen_report_v1",
    status: episodeStatus,
    current_batch_status: currentBatchStatus,
    episode_status: episodeStatus,
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
    provider_health_probe_enabled: Boolean(providerHealthReport),
    provider_health_report_path: providerHealthReport ? providerHealthReportPath : null,
    provider_circuit_open: pool.circuit_open,
    provider_circuit_reason: pool.circuit_reason,
    provider_circuit_failure_threshold: pool.failure_threshold,
    adaptive_scene_concurrency: pool.adaptive_concurrency,
    codex_opening_sec: codexOpeningSec,
    provider_filter: providerFilter,
    seed_derived_refs: seedDerivedRefs,
    seed_derived_ref_count: seedDerivedTargets.length,
    seed_derived_image_ids: [...seedDerivedImageIds],
    image_count: mergedResults.length,
    current_batch_image_count: results.length,
    reference_count: referenceRun.results.length,
    reference_results: referenceRun.results,
    reference_provider_circuit_open: Boolean(referenceRun.provider_circuit_open),
    reference_provider_circuit_reason: referenceRun.provider_circuit_reason ?? null,
    adaptive_reference_concurrency: referenceRun.adaptive_concurrency ?? null,
    results: mergedResults,
    cut_execution_ledger_path: cutExecutionLedgerPath,
    cut_execution_ledger_status: cutExecutionLedger.status,
    estimated_cost: {
      current_batch: imagegenCostSummary([...referenceRun.results, ...results]),
      report_total: imagegenCostSummary([...referenceRun.results, ...mergedResults]),
    },
    updated_at: new Date().toISOString(),
  };
  const materialized = await writeAuditableImagegenReport(report, {
    kind: seedDerivedRefs ? "seed_derived_refs" : scope.size ? "scoped_scene_retry" : "scene_images",
    currentRows: [...referenceRun.results, ...results],
  });
  console.log(JSON.stringify({ status: materialized.status, current_batch_status: materialized.current_batch_status, report_path: reportPath, immutable_batch_report_path: materialized.immutable_batch_report_path, image_count: materialized.image_count, current_batch_image_count: materialized.current_batch_image_count }, null, 2));
  if (materialized.status === "failed") process.exitCode = 1;
}

export { episodeImageStatus as episodeImageStatusForTests };

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    const failureReport = {
      schema: "goldflow_imagegen_report_v1",
      status: "failed",
      current_batch_status: "failed",
      episode_status: "failed",
      error: error instanceof Error ? error.message : String(error),
      updated_at: new Date().toISOString(),
    };
    await writeAuditableImagegenReport(failureReport, { kind: referencesOnly ? "references" : "scene_images", currentRows: [] }).catch(() => {});
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
