#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sanitizeCharacterStaging } from "./lib/character-staging-utils.mjs";
import { beautyLanguageFindings, namedCharacterDuplicationFindings, negativePromptFindings } from "./lib/prompt-prose-findings.mjs";
import { outOfScopeLocationRefMentions } from "./lib/visual-scope-utils.mjs";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeDir = path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode);
const promptPath = flags.prompts ?? path.join(episodeDir, "section_image_prompts_reviewed.json");
const timedPlanPath = flags.timed ?? path.join(episodeDir, "timed_scene_plan.json");
const visualReferencePlanPath = flags.visualRefs ?? flags["visual-refs"] ?? path.join(episodeDir, "visual_reference_plan.json");
const characterStateRefsPath = flags.characterStateRefs ?? flags["character-state-refs"] ?? path.join(episodeDir, "character_state_refs.json");
const outputPath = flags.output ?? path.join(episodeDir, "section_image_prompts_hardened.json");
const reportPath = flags.report ?? flags["report-output"] ?? path.join(episodeDir, `visual_prompt_hardening_${episode}.json`);
const samplePath = flags.sample ?? flags["sample-output"] ?? path.join(episodeDir, `visual_prompt_hardening_sample_${episode}.md`);
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

function buildIndexes(visualReferencePlan, characterStateRefs) {
  const referenceTargets = visualReferencePlan?.reference_targets ?? [];
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
    const refId = sourceRefId(ref);
    referenceById.set(refId, { ...ref, kind: "character_state", ref_id: refId, subject: ref.character });
    if (ref.state_ref_id) refIdByStateId.set(String(ref.state_ref_id), refId);
  }
  const locationTargets = referenceTargets.filter((target) => String(target.kind ?? "") === "location");
  return { referenceById, refIdByStateId, characterRefs, locationTargets };
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
  return target?.reference_image_path ?? target?.required_reference_path ?? target?.path ?? null;
}

function targetAttachable(target) {
  return Boolean(targetReferencePath(target));
}

function sanitizeRequirementFromRefId(refId, indexes, base = {}) {
  refId = indexes.refIdByStateId?.get(refId) ?? refId;
  const target = indexes.referenceById.get(refId);
  if (!target) return null;
  const rawKind = String(base.kind ?? target.kind ?? "").toLowerCase();
  const isCharacter = rawKind.includes("character");
  const baseIdentityRefId = target.base_identity_ref_id ?? target.base_identity_ref ?? null;
  const faceOnly = isCharacter && String(target.identity_usage ?? "").toLowerCase() === "face_only" && baseIdentityRefId;
  const selectedRefId = faceOnly ? baseIdentityRefId : refId;
  const selectedTarget = indexes.referenceById.get(selectedRefId) ?? target;
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
    identity_usage: faceOnly ? "face_only" : base.identity_usage,
    state_contract: faceOnly ? (target.scene_prompt_anchor ?? target.prompt_anchor ?? "") : base.state_contract,
    reference_image_path: targetReferencePath(selectedTarget),
  };
}

function refSelectionIds(req) {
  return [req?.ref_id, req?.source_state_ref_id].filter(Boolean).map(String);
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
  return /\b(?:apartment|kitchen|bedroom|bathroom|gym|treadmill|office|workplace|cubicle|support desk|street|sidewalk|lobby|elevator|coffee shop|courthouse|corridor|boardroom|conference|stage|hotel|tower|clinic|dental|warehouse|room|table)\b/i.test(text);
}

function sanitizePrompt(prompt, indexes) {
  const findings = [];
  const shotManifest = sanitizeShotManifest(prompt.shot_manifest);
  const forbiddenRefs = new Set((shotManifest?.forbidden_ref_ids ?? []).map(String));
  const mentionedOnly = manifestNameSet(shotManifest?.mentioned_only_characters);
  const visibleNames = manifestNameSet(shotManifest?.visible_characters);
  const requestedLocationRefId = shotManifest?.location_ref_id ? String(shotManifest.location_ref_id) : null;
  const requestedCharacterRefIds = (shotManifest?.character_state_ref_ids ?? []).map((refId) => indexes.refIdByStateId?.get(String(refId)) ?? String(refId));
  if (shotManifest) {
    shotManifest.character_state_ref_ids = requestedCharacterRefIds;
    if (shotManifest.protagonist_state_ref_id) {
      shotManifest.protagonist_state_ref_id = indexes.refIdByStateId?.get(String(shotManifest.protagonist_state_ref_id)) ?? String(shotManifest.protagonist_state_ref_id);
    }
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
    const lookupRefId = indexes.refIdByStateId?.get(rawRefId) ?? rawRefId;
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
    const canonical = sanitizeRequirementFromRefId(rawRefId, indexes, req);
    const selectedTargetForPath = indexes.referenceById.get(canonical.ref_id) ?? indexes.referenceById.get(canonical.source_state_ref_id) ?? target;
    if (!targetAttachable(selectedTargetForPath)) {
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

  const requestedLocationOmittedForRefLimit = requestedLocationRefId && isReferenceLimitOmission(prompt, requestedLocationRefId);
  const requestedLocationTarget = requestedLocationRefId ? indexes.referenceById.get(requestedLocationRefId) : null;
  const requestedLocationAttachable = requestedLocationTarget ? targetAttachable(requestedLocationTarget) : false;

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

  const selectedIds = new Set(selectedRequirements.flatMap(refSelectionIds));
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
  if (!requestedLocationRefId
    && !selectedRequirements.some((req) => referenceKindRank(req.kind) === 1)
    && looksLikePhysicalLocation(prompt, promptTextValue)) {
    const inScopeLocationRefs = indexes.locationTargets.filter((target) => sceneIdsCover(target.scene_ids, prompt.scene_id) && targetAttachable(target));
    const hasInScopeLocationRef = inScopeLocationRefs.length > 0;
    findings.push({
      image_id: prompt.image_id,
      scene_id: prompt.scene_id,
      severity: hasInScopeLocationRef ? "blocker" : "warning",
      code: "physical_location_ref_missing",
      message: hasInScopeLocationRef
        ? `Prompt describes a real physical environment, but the LLM did not set shot_manifest.location_ref_id or attach an in-scope location ref. Available in-scope location refs: ${inScopeLocationRefs.map((target) => target.ref_id).join(", ")}.`
        : "Prompt describes a real physical environment, but no approved in-scope location ref exists; proceeding with concrete generic location staging.",
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
  findings.push(...negativePromptFindings([{
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
      required_reference_paths: selectedRequirements.map((req) => req.reference_image_path).filter(Boolean),
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

async function main() {
  const [promptPlan, timedPlan, visualReferencePlan, characterStateRefs] = await Promise.all([
    readJson(promptPath, null),
    readJson(timedPlanPath, null),
    readJson(visualReferencePlanPath, null),
    readJson(characterStateRefsPath, null),
  ]);
  if (!Array.isArray(promptPlan?.prompts) || !promptPlan.prompts.length) throw new Error(`Missing prompt plan: ${promptPath}`);
  if (timedPlan?.status !== "passed") throw new Error(`Missing passed timed scene plan: ${timedPlanPath}`);
  if (visualReferencePlan?.status !== "passed") throw new Error(`Missing passed visual reference plan: ${visualReferencePlanPath}`);
  if (!["approved", "passed"].includes(characterStateRefs?.status) && flags["allow-draft-refs"] !== "true") {
    throw new Error(`character_state_refs must be approved before prompt hardening. Current status: ${characterStateRefs?.status ?? "missing"}.`);
  }
  const indexes = buildIndexes(visualReferencePlan, characterStateRefs);
  const prompts = [];
  const findings = [];
  for (const prompt of promptPlan.prompts) {
    const result = sanitizePrompt(prompt, indexes);
    prompts.push(result.prompt);
    findings.push(...result.findings);
  }
  const unresolvedBlockers = findings.filter((finding) => finding.severity === "blocker" && finding.resolved !== true);
  const status = unresolvedBlockers.length ? "blocked" : "passed";
  const sourcePaths = [promptPath, timedPlanPath, visualReferencePlanPath, characterStateRefsPath];
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
    findings,
    unresolved_blocker_count: unresolvedBlockers.length,
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
