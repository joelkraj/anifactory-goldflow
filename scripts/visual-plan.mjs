#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getLLMModel, isLocalLLMRoute, localLLMAuthHeaders, localLLMChatCompletionURL } from "./lib/llm-router.mjs";
import { configuredCodexModel, isCodexCacheCompatible, readCodexCallMetadata, runCodexCli } from "./lib/codex-cli-runner.mjs";
import {
  allowedRefIdsForScene,
  dropOutOfScopePromptRefs,
  referenceTargetsForScene,
} from "./lib/visual-scope-utils.mjs";
import { CHARACTER_STAGING_POSITIONS, sanitizeCharacterStaging } from "./lib/character-staging-utils.mjs";
import { normalizeImageProvider, routedProviderForPrompt } from "./lib/image-provider-routing.mjs";
import { referencePlanApprovalMatches } from "./lib/reference-plan-contract.mjs";
import { mergeScopedPromptReplacements } from "./lib/visual-resolution-utils.mjs";
import {
  longLocationSpanFindings,
  repeatedLocationShotJobFindings,
} from "./lib/visual-plan-quality-utils.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const weekDir = path.join(dataRoot, "channels", channel, "weekly_runs", week);
const episodeDir = path.join(weekDir, "episodes", episode);
const timedPlanPath = flags.timed ?? path.join(episodeDir, "timed_scene_plan.json");
const visualBeatPlanPath = flags.beats ?? flags["visual-beats"] ?? path.join(episodeDir, "visual_beat_plan.json");
const semanticPlanPath = flags.semantic ?? path.join(episodeDir, "semantic_scene_plan.json");
const storyFactLedgerPath = flags["story-fact-ledger"] ?? path.join(episodeDir, "story_fact_ledger.json");
const visualReferencePlanPath = flags.visualRefs ?? flags["visual-refs"] ?? path.join(episodeDir, "visual_reference_plan.json");
const referencePlanApprovalPath = flags["reference-plan-approval"] ?? path.join(episodeDir, "reference_plan_approval.json");
const locationContractLedgerPath = flags.locationContractLedger ?? flags["location-contract-ledger"] ?? path.join(episodeDir, "location_contract_ledger.json");
const characterStateRefsPath = flags.characterStateRefs ?? flags["character-state-refs"] ?? path.join(episodeDir, "character_state_refs.json");
const outputPath = flags.output ?? path.join(episodeDir, "section_image_prompts.json");
const basePromptPlanPath = flags["base-prompts"] ?? flags["base-prompt-plan"] ?? outputPath;
const correctionFindingsPath = flags["correction-findings"] ?? flags.correctionFindings ?? null;
const promptMaxChars = Number(flags["visual-prompt-max-chars"] ?? process.env.ANIFACTORY_VISUAL_PLAN_MAX_PROMPT_CHARS ?? 900_000);
const runIdentityPath = path.join(episodeDir, "run_identity.json");
const allowLongLocationSpans = flags["allow-long-location-spans"] === "true" || process.env.ANIFACTORY_ALLOW_LONG_LOCATION_SPANS === "true";
const maxSameLocationSpanSec = Number(flags["max-same-location-span-sec"] ?? process.env.ANIFACTORY_VISUAL_MAX_SAME_LOCATION_SPAN_SEC ?? 150);
const allowRepeatedRetentionShotJobs = flags["allow-repeated-retention-shot-jobs"] === "true"
  || process.env.ANIFACTORY_ALLOW_REPEATED_RETENTION_SHOT_JOBS === "true";
const maxConsecutiveRetentionShotJobs = Number(flags["max-consecutive-retention-shot-jobs"] ?? process.env.ANIFACTORY_MAX_CONSECUTIVE_RETENTION_SHOT_JOBS ?? 3);
const compactEditorialProof = flags["compact-editorial-proof"] === "true" || process.env.ANIFACTORY_COMPACT_EDITORIAL_PROOF === "true";

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

function providerExclusionPayloadSyntaxMatches(value) {
  const text = String(value ?? "").toLowerCase();
  const patterns = [
    /--no\b/,
    /\bnegative\s+prompt\s*[:=]/,
  ];
  return patterns.filter((pattern) => pattern.test(text)).map(String);
}

function providerExclusionPayloadMarkerWarnings(prompts) {
  const warnings = [];
  for (const prompt of prompts) {
    for (const field of ["image_prompt", "modelslab_image_prompt", "codex_image_prompt"]) {
      if (!prompt[field]) continue;
      const matches = providerExclusionPayloadSyntaxMatches(prompt[field]);
      if (matches.length) warnings.push({
        code: "provider_exclusion_payload_marker",
        severity: "warning",
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        target_field: field,
        message: `${prompt.image_id} ${field} appears to contain embedded provider-exclusion payload syntax: ${matches.join(", ")}`,
      });
    }
  }
  return warnings;
}

function normalizeLabel(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function uniqueStrings(values) {
  return [...new Set((values ?? []).map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function sceneCharacterStateRefs(scene, stateRefIndex = new Map()) {
  if (Array.isArray(scene.character_state_refs)) return scene.character_state_refs;
  const refs = [];
  const sceneId = String(scene.scene_id ?? "");
  const localMentions = compactEditorialProof
    ? uniqueStrings([...(scene.visible_characters ?? []), ...(scene.screen_visible_characters ?? []), ...(scene.preview_visible_characters ?? [])])
    : [];
  const visibleLabels = (localMentions.length ? localMentions : [
    ...(scene.visible_characters ?? []),
    ...(scene.visible_subjects ?? []),
    ...((scene.character_states ?? []).map((state) => state.character)),
  ]).filter(Boolean);
  for (const label of visibleLabels) {
    const keys = [
      `${sceneId}:${normalizeLabel(label)}`,
      `*:${normalizeLabel(label)}`,
      normalizeLabel(label),
    ];
    const ref = keys.map((key) => stateRefIndex.get(key)).find(Boolean);
    if (ref) refs.push(ref);
  }
  return refs;
}

function scenePromptAnchorFromRef(ref) {
  if (ref?.scene_prompt_anchor) return ref.scene_prompt_anchor;
  return String(ref?.prompt_anchor ?? "")
    .replace(/\bidentity sheet,\s*/gi, "")
    .replace(/\bfront view,\s*three-quarter view,\s*side profile,\s*expression closeups,\s*/gi, "")
    .replace(/\bplain white studio background,\s*/gi, "")
    .replace(/\bcharacter design turnaround only\b/gi, "")
    .replace(/\bcharacter turnaround reference sheet composition\b/gi, "")
    .replace(/\breference sheet composition\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*$/g, "")
    .trim();
}

function truncateText(value, max = 900) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max).trim()}...` : text;
}

function compactList(values, maxItems = 6, maxChars = 180) {
  return (Array.isArray(values) ? values : [])
    .slice(0, maxItems)
    .map((value) => typeof value === "string" ? truncateText(value, maxChars) : value);
}

function firstName(value) {
  return String(value ?? "").trim().split(/\s+/)[0] ?? "";
}

function isCollectiveOrEnvironmentSubject(value) {
  const label = normalizeLabel(value);
  if (!label) return true;
  if (/\b(?:audience|crowd|creators|students|viewers|fans|followers|staff|workers|classmates|witnesses|people|spaces|areas|rooms|halls|screens|chat|comments)\b/i.test(label)) return true;
  return /\b(?:campus|university|academy|school|venue|event|stage|hall|room|studio)\b.*\b(?:space|spaces|area|areas|rooms|halls)\b/i.test(label);
}

function mentionedCandidateNames(scene) {
  const excerpt = String(scene.visual_beat_script_excerpt ?? scene.script_excerpt ?? "");
  const candidates = [
    scene.primary_subject,
    ...(scene.visible_subjects ?? []),
    ...((scene.character_states ?? []).map((state) => state?.character)),
  ]
    .map((name) => String(name ?? "").trim())
    .filter((name) => name && /^[A-Z][\p{L}\p{N}'’-]+/u.test(name))
    .filter((name) => !isCollectiveOrEnvironmentSubject(name));
  const unique = [...new Set(candidates)];
  return unique.filter((name) => {
    const full = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const first = firstName(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${full}\\b`, "iu").test(excerpt)
      || (first.length > 2 && new RegExp(`\\b${first}\\b`, "iu").test(excerpt));
  });
}

function locationMentionPhrases(text) {
  const source = String(text ?? "");
  const phrases = [];
  const venueNouns = "Hall|Room|Stage|Lobby|Campus|Arena|Court|Boardroom|Office|Dorm|Apartment|Kitchen|Elevator|Tower|District|Station|Gym|Street|Floor|Hallway|Corridor|Courtyard|Temple|Palace|Library|Classroom|Studio|Theater|Restaurant|Cafe|Hospital|Bank|Store|Market|Platform|Roof|Basement|Warehouse|Server";
  const properVenuePattern = new RegExp(`\\b([A-Z][\\p{L}\\p{N}'’-]*(?:\\s+[A-Z][\\p{L}\\p{N}'’-]*){0,3}\\s+(?:${venueNouns}))\\b`, "gu");
  for (const match of source.matchAll(properVenuePattern)) phrases.push(match[1]);
  const genericMovementPattern = /\b(?:entered|arrived at|walked into|stepped into|crossed into|moved into|went into|inside|through|toward)\s+(?:the\s+)?(hall|room|stage|lobby|campus|arena|court|boardroom|office|dorm|apartment|kitchen|elevator|tower|district|station|gym|street|floor|hallway|corridor|courtyard|temple|palace|library|classroom|studio|theater|restaurant|cafe|hospital|bank|store|market|platform|roof|basement|warehouse|server)\b/giu;
  for (const match of source.matchAll(genericMovementPattern)) phrases.push(match[1]);
  return [...new Set(phrases.map((phrase) => phrase.trim()).filter(Boolean))];
}

function locationPhraseSignature(phrase) {
  const words = normalizeLabel(phrase).split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  return words.slice(Math.max(0, words.length - 2)).join(" ");
}

function locationPhraseAppearsInSourceLocation(phrase, source) {
  const phraseLabel = normalizeLabel(phrase);
  const signature = locationPhraseSignature(phrase);
  const sourceLocation = normalizeLabel([
    source?.location,
    source?.location_timeline_label,
  ].filter(Boolean).join(" "));
  return Boolean(phraseLabel && sourceLocation.includes(phraseLabel))
    || Boolean(signature && sourceLocation.includes(signature));
}

function locationPhraseHasCurrentBeatCue(phrase, source) {
  const excerpt = String(source?.visual_beat_script_excerpt ?? source?.script_excerpt ?? "");
  const escapedPhrase = String(phrase ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escapedPhrase) return false;
  return new RegExp(
    `\\b(?:entered|arrived at|walked into|stepped into|crossed into|moved into|went into|reached|stood in|stood inside|waited in|inside|through|toward)\\s+(?:the\\s+)?${escapedPhrase}\\b`,
    "iu",
  ).test(excerpt);
}

function locationPhraseRequiresVisibleStaging(phrase, source) {
  return locationPhraseAppearsInSourceLocation(phrase, source)
    || locationPhraseHasCurrentBeatCue(phrase, source);
}

function compactSceneCharacterRef(ref) {
  return {
    state_ref_id: ref.state_ref_id ?? null,
    source_ref_id: ref.source_ref_id ?? null,
    base_identity_ref_id: ref.base_identity_ref_id ?? null,
    identity_usage: ref.identity_usage ?? null,
    character: ref.character ?? null,
    scene_ids: ref.scene_ids ?? [],
    scene_prompt_anchor: truncateText(scenePromptAnchorFromRef(ref), compactEditorialProof ? 280 : 900),
    reference_image_path: ref.conditioning_image_path ?? ref.reference_image_path ?? null,
  };
}

function compactSceneForPrompt(scene, stateRefIndex = new Map()) {
  const absoluteIndex = Number.isFinite(Number(scene.__visual_plan_absolute_index))
    ? Number(scene.__visual_plan_absolute_index)
    : null;
  return {
    target_image_id: scene.image_id_hint ?? (absoluteIndex == null ? null : `${episode}-cut-${String(absoluteIndex + 1).padStart(3, "0")}`),
    scene_id: scene.scene_id,
    visual_beat_id: scene.visual_beat_id ?? null,
    parent_scene_id: scene.parent_scene_id ?? scene.scene_id,
    beat_index: scene.beat_index ?? null,
    beat_count: scene.beat_count ?? null,
    visual_beat_focus: scene.visual_beat_focus ?? null,
    visual_beat_action: scene.visual_beat_action ?? null,
    visual_beat_script_excerpt: scene.visual_beat_script_excerpt ?? null,
    source_word_start_index: scene.source_word_start_index ?? null,
    source_word_end_index: scene.source_word_end_index ?? null,
    source_atom_ids: scene.source_atom_ids ?? [],
    depiction_mode: scene.depiction_mode ?? "current_reality",
    physically_visible_entity_ids: scene.physically_visible_entity_ids ?? [],
    screen_visible_entity_ids: scene.screen_visible_entity_ids ?? [],
    preview_visible_entity_ids: scene.preview_visible_entity_ids ?? [],
    mentioned_only_entity_ids: scene.mentioned_only_entity_ids ?? [],
    active_state_constraints: scene.active_state_constraints ?? null,
    local_named_character_mentions: mentionedCandidateNames(scene),
    local_location_mentions: locationMentionPhrases(scene.visual_beat_script_excerpt ?? ""),
    shot_framing_guidance: "beat-authored composition; use close-up, insert, medium, over-shoulder, wide, manga panel, split-screen, or another framing only when it serves the current visual job and narration excerpt",
    visual_job: scene.visual_job ?? null,
    editorial_cues: scene.editorial_cues ?? [],
    suggested_shot_job: scene.suggested_shot_job ?? null,
    visual_novelty_directive: scene.visual_novelty_directive ?? null,
    location_timeline_label: scene.location_timeline_label ?? null,
    visual_beat_quality_findings: compactList(scene.visual_beat_quality_findings ?? [], 4, 260),
    title: scene.title,
    start_sec: scene.start_sec,
    end_sec: scene.end_sec,
    duration_sec: scene.duration_sec,
    location: scene.location,
    time: scene.time,
    visible_characters: scene.visible_characters ?? [],
    visible_subjects: scene.visible_subjects ?? [],
    primary_subject: scene.primary_subject ?? null,
    visual_intent: truncateText(scene.visual_intent ?? "", 360),
    character_state_refs: sceneCharacterStateRefs(scene, stateRefIndex).map(compactSceneCharacterRef),
    ui_text_on_screen: scene.local_ui_elements ?? scene.ui_text_on_screen ?? [],
    character_states: compactList(scene.character_states ?? [], 4),
    wardrobe: scene.wardrobe ?? null,
    props: compactList(scene.local_props ?? scene.props ?? [], 8),
    action_staging: truncateText(scene.action_staging ?? "", 500),
    continuity_notes: compactList(scene.continuity_notes ?? [], 4, 220),
  };
}

function compactNeighborContext(scene) {
  if (!scene) return null;
  return {
    visual_beat_id: scene.visual_beat_id ?? null,
    parent_scene_id: scene.parent_scene_id ?? scene.scene_id,
    beat_index: scene.beat_index ?? null,
    visual_beat_focus: scene.visual_beat_focus ?? null,
    visual_beat_action: scene.visual_beat_action ?? null,
    visual_beat_script_excerpt: scene.visual_beat_script_excerpt ?? null,
    visual_job: scene.visual_job ?? null,
    editorial_cues: scene.editorial_cues ?? [],
    suggested_shot_job: scene.suggested_shot_job ?? null,
    location_timeline_label: scene.location_timeline_label ?? null,
    visual_beat_quality_findings: compactList(scene.visual_beat_quality_findings ?? [], 3, 220),
    location: scene.location ?? null,
    visible_subjects: scene.visible_subjects ?? [],
    primary_subject: scene.primary_subject ?? null,
  };
}

function characterStateRefForTarget(target, scene, stateRefIndex = new Map()) {
  const ids = [target?.ref_id, target?.source_ref_id, target?.state_ref_id].map((value) => String(value ?? "")).filter(Boolean);
  for (const id of ids) {
    const direct = stateRefIndex.get(id);
    if (direct) return direct;
  }
  const sceneId = String(scene?.parent_scene_id ?? scene?.scene_id ?? "");
  const labels = [target?.subject, target?.character, target?.ref_id].map(normalizeLabel).filter(Boolean);
  for (const label of labels) {
    const ref = stateRefIndex.get(`${sceneId}:${label}`) ?? stateRefIndex.get(`*:${label}`) ?? stateRefIndex.get(label);
    if (ref) return ref;
  }
  return null;
}

function relevantReferenceTargets(scene, visualReferencePlan, stateRefIndex = new Map()) {
  let targets = referenceTargetsForScene(scene, visualReferencePlan)
    .filter((target) => locationTargetMatchesSourceRow(target, scene));
  if (compactEditorialProof) {
    const visibleLabels = uniqueStrings([
      ...(scene.visible_characters ?? []),
      ...(scene.screen_visible_characters ?? []),
      ...(scene.preview_visible_characters ?? []),
    ]).map(normalizeLabel);
    const excerpt = normalizeLabel(scene.visual_beat_script_excerpt ?? "");
    const localUi = (scene.local_ui_elements ?? []).map(normalizeLabel).filter(Boolean);
    const localProps = (scene.local_props ?? []).map(normalizeLabel).filter(Boolean);
    const advisoryRefIds = new Set((scene.ref_needs ?? scene.beat_ref_requirements ?? []).map((need) => String(need?.ref_id ?? "")).filter(Boolean));
    targets = targets.filter((target) => {
      const kind = String(target.kind ?? "").toLowerCase();
      if (kind === "style" || kind === "location") return true;
      if (kind === "character_state") {
        const targetLabels = [target.subject, target.character].map(normalizeLabel).filter(Boolean);
        return targetLabels.some((label) => visibleLabels.includes(label));
      }
      if (kind === "ui") {
        return localUi.length > 0 || ["system_reveal", "ui_insert"].includes(String(scene.visual_job ?? ""));
      }
      if (["prop", "action", "effect"].includes(kind)) {
        if (advisoryRefIds.has(String(target.ref_id ?? ""))) return true;
        const label = normalizeLabel(`${target.subject ?? ""} ${target.ref_id ?? ""}`);
        const evidence = [...localProps, ...localUi, excerpt];
        return label.split(/\s+/).some((token) => token.length > 3 && evidence.some((value) => value.includes(token)));
      }
      return false;
    });
  }
  return targets.map((target) => {
    if (String(target?.kind ?? "").toLowerCase() !== "character_state") return compactReferenceTarget(target);
    const stateRef = characterStateRefForTarget(target, scene, stateRefIndex);
    return compactReferenceTarget({
      ...target,
      character: stateRef?.character ?? target.character ?? target.subject,
      source_ref_id: stateRef?.source_ref_id ?? target.source_ref_id ?? target.ref_id,
      scene_prompt_anchor: stateRef?.scene_prompt_anchor ?? target.scene_prompt_anchor,
      prompt_anchor: target.prompt_anchor ?? stateRef?.prompt_anchor,
      identity_usage: stateRef?.identity_usage ?? target.identity_usage,
    });
  });
}

function targetHasAttachableReference(target) {
  return Boolean(target.reference_exists || target.conditioning_image_path || target.reference_image_path || target.resolved_reference_image_path);
}

function compactReferenceTarget(target) {
  const attachable = targetHasAttachableReference(target);
  const generationMode = String(target.generation_mode ?? "");
  const pendingDerived = /^derive_from_/i.test(generationMode) && !attachable;
  const locationContractReference = String(target.kind ?? "").toLowerCase() === "location" && (attachable || pendingDerived);
  return {
    ref_id: target.ref_id ?? null,
    kind: target.kind ?? null,
    subject: target.subject ?? null,
    character: target.character ?? null,
    source_ref_id: target.source_ref_id ?? null,
    identity_usage: target.identity_usage ?? null,
    scene_ids: target.scene_ids ?? [],
    location_contract_ids: target.location_contract_ids ?? [],
    priority: target.priority ?? null,
    generation_mode: target.generation_mode ?? null,
    required_before_imagegen: target.required_before_imagegen ?? null,
    reference_image_path: compactEditorialProof ? null : (target.conditioning_image_path ?? target.reference_image_path ?? null),
    resolved_reference_image_path: compactEditorialProof ? null : (target.resolved_reference_image_path ?? null),
    reference_exists: compactEditorialProof ? null : (target.reference_exists ?? null),
    attachable_reference: attachable,
    pending_derived_reference: pendingDerived,
    location_contract_reference: locationContractReference,
    reference_budget: target.reference_budget ?? null,
    scene_prompt_anchor: truncateText(target.scene_prompt_anchor ?? "", compactEditorialProof ? 260 : 900),
    prompt_anchor: truncateText(target.scene_prompt_anchor ?? target.prompt_anchor ?? "", compactEditorialProof ? 260 : 900),
    anchor_cut_policy: target.anchor_cut_policy ?? null,
    risk_notes: compactEditorialProof ? [] : compactList(target.risk_notes ?? [], 4, 220),
  };
}

function resolvedReferencePath(rawPath) {
  if (!rawPath) return null;
  return path.isAbsolute(rawPath) ? rawPath : path.join(episodeDir, rawPath);
}

async function fileExists(filePath) {
  if (!filePath) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function enrichVisualReferencePlan(visualReferencePlan) {
  if (!visualReferencePlan) return null;
  const targets = await Promise.all((visualReferencePlan.reference_targets ?? []).map(async (target) => {
    const referencePath = target.conditioning_image_path ?? target.reference_image_path ?? target.required_reference_path ?? target.path ?? null;
    const resolvedPath = resolvedReferencePath(referencePath);
    return {
      ...target,
      reference_image_path: referencePath,
      conditioning_image_path: target.conditioning_image_path ?? referencePath,
      resolved_reference_image_path: resolvedPath,
      reference_exists: await fileExists(resolvedPath),
    };
  }));
  return { ...visualReferencePlan, reference_targets: targets };
}

function codexOpeningSecFromOptions(options = {}) {
  const value = Number(options.codex_opening_sec ?? options.codexOpeningSec ?? 120);
  return Number.isFinite(value) && value > 0 ? value : 120;
}

function providerPromptGuidance(activeProvider, providerOptions = {}) {
  const provider = normalizeImageProvider(activeProvider);
  const opening = codexOpeningSecFromOptions(providerOptions);
  return [
    `LOCKED IMAGE LANE: ${provider}.`,
    `For hybrid lanes the deterministic packet already assigns target_provider_route per cut${provider.includes("opening") ? ` using the locked ${opening}s opening window` : ""}.`,
    "Author exactly one provider_prompt for each cut, optimized for that cut's target_provider_route. Do not author parallel ModelsLab/Codex variants. Compatibility fields are derived later from provider_prompt and shot_manifest.",
  ].join("\n");
}

function compactAuthorRiskRules(compactTimedPlan) {
  const rows = compactTimedPlan.scenes ?? [];
  const text = JSON.stringify(rows);
  const rules = [];
  const hasMultiCharacter = rows.some((row) => (row.visible_characters ?? row.visible_subjects ?? []).length >= 2);
  const hasPhysicalAction = /\b(?:physical_action|fight|strike|hit|lift|carry|catch|pin|restrain|shield|stab|shove|grab|rescue)\b/i.test(text);
  const hasSurfaceRisk = /\b(?:table|desk|counter|island|railing|barrier|podium|bench|console|carriage|vehicle)\b/i.test(text);
  const hasScreenVisiblePerson = /\b(?:replay|livestream|broadcast|video wall|phone screen|dossier|chat avatar)\b/i.test(text);
  if (hasMultiCharacter) {
    rules.push("For multi-character cuts, shot_manifest.character_staging lists every visible named character in visible-character order with distinct screen positions, ref ids, wardrobe sources, and poses. Give each person a separate prose clause and separate body silhouette.");
  }
  if (hasPhysicalAction) {
    rules.push("For physical action, begin with actor, affected person/object, screen positions, exact contact plane, and the visible result proving the beat. Put identity anchors and environment after the decisive action sentence.");
  }
  if (hasSurfaceRisk) {
    rules.push("When a surface or large object can cross a body, state which side each person occupies and keep torsos, hands, feet, and body silhouettes spatially clear of the surface plane.");
  }
  if (hasScreenVisiblePerson) {
    rules.push("A named person visibly shown through replay, livestream, broadcast, phone, or dossier is visible through media: include their staged likeness and ref when available, while keeping them physically separate from people in the room.");
  }
  return rules;
}

function buildCompactAuthorPrompt({ compactTimedPlan, compactSemanticPlan, correctionDirectives, activeProvider, activeProviderOptions }) {
  const unitLabel = compactTimedPlan.source_unit === "visual_beats" ? "visual beat" : "timed scene";
  const riskRules = compactAuthorRiskRules(compactTimedPlan);
  return `Author one production image prompt for every ${unitLabel} below.

${providerPromptGuidance(activeProvider, activeProviderOptions)}

Core contract:
- You are the creative visual editor. The exact local visual_beat_script_excerpt, visual_beat_action, timing, visual_job, local location, and current-scene candidate refs are the source of truth.
- Ask what the viewer needs to see now to understand, feel, and keep watching. Depict one present-tense moment, not a parent-scene summary or generic hero portrait.
- Author shot_manifest first, then prose that obeys it. Preserve target_image_id, scene_id, visual_beat_id, start_sec, and duration_sec exactly.
- Start provider prompt prose with the visible subject, decisive action or reaction, and current location. Use the best composition for this beat without a global wide or close-up bias.
- Physically visible named people belong in visible_characters. Pure mentions belong in mentioned_only_characters and receive no character ref. Resolve first-person physical action to the narrator/protagonist unless the cut is explicitly POV, UI-only, document-only, or offscreen narration.
- Use only approved in-scope refs from the current unit's reference_target_ids and matching reference target packet. Attach up to four refs in the actual desired slot order: visible identity/wardrobe first when that is the main risk, then location, critical prop/UI, and action/effect. Fewer refs are fine.
- When a physically visible, screen-visible, or preview-visible named character has a matching attachable character_state target in the current unit packet, attach that character ref unless the four-slot cap makes it impossible. Do not leave a visible canonical identity text-only while an exact approved identity ref is available.
- Location contracts and image refs are separate. For a physical setting, select the exact in-scope textual location contract in shot_manifest.location_contract_id and use its prompt_anchor to describe the environment. Set shot_manifest.location_ref_id only when the current unit packet contains a matching approved attachable location image ref. A text-only location contract never belongs in reference_requirements and never consumes an image slot.
- For every attached character state, reaffirm the supplied scene_prompt_anchor in that person's own clause, then add current screen position and action. If the anchor already begins with the character's name, do not repeat the name a second time.
- Put ordered reference-role metadata once in shot_manifest.reference_slots. Do not duplicate it in top-level compatibility fields and do not repeat provider wrapper sentences such as "Use Image 1" inside scene prose.
- active_state_constraints is binding. Preserve its current wardrobe, injury, possession, status, visible state, and location facts for every visible entity; never reset a character to a base/default state merely because an older ref exists.
- Keep prompts concise and concrete. Normal ModelsLab prompts should usually be about 90-180 words; difficult action may use more. Include the short phrase "16:9 landscape anime/manhwa frame" once.
- Background extras appear only when the local beat asks for them. Keep private, lonely, or solo beats visibly clear of unrelated people.
- Author only provider_prompt for the supplied target_provider_route. The pipeline derives legacy image_prompt/modelslab_image_prompt/codex_image_prompt fields after validation.
- Do not create standalone negative_prompt, avoid_list, or exclude_list fields. Normal story-faithful prose may freely state absences, refusals, and contrast.
- Correction directives are binding only for their matching image_id or scene_id.
${riskRules.map((rule) => `- ${rule}`).join("\n")}

TIMED LOCAL UNITS AND SCOPED REFS:
${JSON.stringify(compactTimedPlan, null, 2)}

BROAD SEMANTIC CONTEXT:
${JSON.stringify(compactSemanticPlan, null, 2)}

CORRECTION DIRECTIVES:
${JSON.stringify(correctionDirectives, null, 2)}

Return JSON only with exactly ${compactTimedPlan.scene_count} prompts:
{
  "style_summary": "short episode style summary",
  "prompts": [{
    "image_id": "copy target_image_id",
    "scene_id": "copy scene_id",
    "visual_beat_id": "copy visual_beat_id when present",
    "start_sec": 0,
    "duration_sec": 6,
    "provider_prompt": "one production prompt optimized for target_provider_route",
    "image_provider_route": "copy target_provider_route",
    "shot_manifest": {
      "shot_job": "environment_establishing|body_state_proof|object_insert|interaction|physical_action|emotional_reaction|consequence|ui_reveal|transition",
      "visible_characters": [],
      "mentioned_only_characters": [],
      "primary_character": null,
      "character_state_ref_ids": [],
      "protagonist_state_ref_id": null,
      "location_contract_id": null,
      "location_ref_id": null,
      "foreground_action": "specific visible action",
      "visible_props": [],
      "ui_elements": [],
      "forbidden_ref_ids": [],
      "reference_slots": [{"ref_id":"id","kind":"character_state|location|prop|ui|action|style","slot_order":1,"slot_purpose":"role","reason":"why this visible ref matters"}],
      "continuity_notes": "current-beat continuity",
      "character_staging": [{"name":"Name","ref_id":"state_ref","screen_position":"frame-left","wardrobe_from":"character_state_ref:state_ref","pose":"current pose/action"}]
    }
  }],
  "warnings": []
}`;
}

function locationContractsForUnit(unit, locationContractLedger) {
  const contracts = Array.isArray(locationContractLedger?.contracts) ? locationContractLedger.contracts : [];
  const beatId = String(unit?.visual_beat_id ?? "").trim();
  const sceneId = String(unit?.parent_scene_id ?? unit?.scene_id ?? "").trim();
  const beatMatches = beatId
    ? contracts.filter((contract) => (contract.beat_ids ?? []).map(String).includes(beatId))
    : [];
  const rows = beatMatches.length
    ? beatMatches
    : contracts.filter((contract) => (contract.scene_ids ?? []).map(String).includes(sceneId));
  return rows.map((contract) => ({
    location_contract_id: contract.location_contract_id,
    description: contract.description ?? null,
    prompt_anchor: contract.prompt_anchor ?? contract.description ?? null,
    local_location_labels: contract.local_location_labels ?? [],
  }));
}

function promptEntityDictionary(storyFactLedger, stateRefIndex) {
  const rows = (storyFactLedger?.canonical_entities ?? []).map((entity) => {
    const displayName = entity.display_name ?? entity.label ?? entity.entity_id;
    const matchingStateRefs = [...stateRefIndex.values()].filter((ref) => normalizeLabel(ref.character) === normalizeLabel(displayName));
    return {
      entity_id: entity.entity_id,
      display_name: displayName,
      aliases: entity.aliases ?? [],
      kind: entity.kind ?? "person",
      state_refs: [...new Map(matchingStateRefs.map((ref) => [ref.state_ref_id, {
        state_ref_id: ref.state_ref_id,
        scene_ids: ref.scene_ids ?? (ref.scene_id ? [ref.scene_id] : []),
        scene_prompt_anchor: ref.scene_prompt_anchor ?? null,
        reference_image_path: ref.conditioning_image_path ?? ref.reference_image_path ?? null,
      }])).values()],
    };
  });
  return rows;
}

function promptLocationDictionary(storyFactLedger, locationContractLedger, visualReferencePlan) {
  const targets = (visualReferencePlan?.reference_targets ?? []).filter((target) => String(target.kind ?? "").toLowerCase() === "location");
  return (storyFactLedger?.canonical_locations ?? []).map((location) => ({
    location_id: location.location_id,
    display_name: location.display_name ?? location.label ?? location.location_id,
    aliases: location.aliases ?? [],
    contracts: (locationContractLedger?.contracts ?? []).filter((contract) => {
      const labels = [contract.description, contract.prompt_anchor, ...(contract.local_location_labels ?? [])].map(normalizeLabel);
      return labels.some((label) => label && (label.includes(normalizeLabel(location.display_name ?? location.label)) || normalizeLabel(location.display_name ?? location.label).includes(label)));
    }).map((contract) => ({
      location_contract_id: contract.location_contract_id,
      scene_ids: contract.scene_ids ?? [],
      prompt_anchor: contract.prompt_anchor ?? contract.description ?? null,
    })),
    attachable_refs: targets.filter((target) => (target.location_contract_ids ?? []).some((id) => (locationContractLedger?.contracts ?? []).some((contract) => contract.location_contract_id === id)))
      .map((target) => ({ ref_id: target.ref_id, scene_ids: target.scene_ids ?? [], prompt_anchor: target.prompt_anchor ?? null })),
  }));
}

function buildPrompt(timedPlan, semanticPlan, visualReferencePlan = null, stateRefIndex = new Map(), visualBeatPlan = null, correctionDirectives = [], activeProvider = "modelslab", activeProviderOptions = {}, locationContractLedger = null, storyFactLedger = null) {
  const sourceRows = visualBeatPlan?.status === "passed" && Array.isArray(visualBeatPlan.beats) && visualBeatPlan.beats.length
    ? visualBeatPlan.beats
    : timedPlan.scenes;
  const referenceTargetsByScene = {};
  const referenceTargetsByUnit = {};
  for (const scene of sourceRows ?? []) {
    const sceneId = scene.parent_scene_id ?? scene.scene_id;
    if (!sceneId) continue;
    if (compactEditorialProof) {
      const unitId = scene.visual_beat_id ?? scene.scene_id;
      referenceTargetsByUnit[unitId] = relevantReferenceTargets(scene, visualReferencePlan, stateRefIndex);
      continue;
    }
    if (!referenceTargetsByScene[sceneId]) {
      referenceTargetsByScene[sceneId] = relevantReferenceTargets(scene, visualReferencePlan, stateRefIndex);
    }
  }
  const compactTimedPlan = {
    source_script_hash: timedPlan.source_script_hash,
    image_provider: normalizeImageProvider(activeProvider),
    image_provider_options: activeProviderOptions,
    scene_count: sourceRows?.length ?? 0,
    source_unit: visualBeatPlan ? "visual_beats" : "timed_scenes",
    parent_scene_count: timedPlan.scenes?.length ?? 0,
    timing_source: timedPlan.timing_source,
    visual_reference_plan_status: visualReferencePlan?.status ?? null,
    entity_dictionary: promptEntityDictionary(storyFactLedger, stateRefIndex),
    location_dictionary: promptLocationDictionary(storyFactLedger, locationContractLedger, visualReferencePlan),
    scenes: (sourceRows ?? []).map((scene, index, rows) => {
      const unitId = scene.visual_beat_id ?? scene.scene_id;
      const targets = compactEditorialProof
        ? (referenceTargetsByUnit[unitId] ?? [])
        : (referenceTargetsByScene[scene.parent_scene_id ?? scene.scene_id] ?? []);
      return {
        ...compactSceneForPrompt(scene, stateRefIndex),
        target_provider_route: routedProviderForPrompt(scene, activeProvider, activeProviderOptions),
        previous_beat_context: scene.__previous_visual_context ?? compactNeighborContext(rows[index - 1]),
        next_beat_context: scene.__next_visual_context ?? compactNeighborContext(rows[index + 1]),
        reference_target_ids: targets.map((target) => target.ref_id),
        location_contracts: locationContractsForUnit(scene, locationContractLedger),
      };
    }),
    ...(compactEditorialProof
      ? { reference_targets_by_unit: referenceTargetsByUnit }
      : { reference_targets_by_scene: referenceTargetsByScene }),
    correction_directives: correctionDirectives,
  };
  const compactSemanticPlan = {
    episode_summary: semanticPlan.episode_summary ?? "",
    global_reference_requirements: semanticPlan.global_reference_requirements ?? [],
    style_summary: semanticPlan.style_summary ?? "",
    warnings: semanticPlan.warnings ?? [],
  };
  if (flags["legacy-author-instructions"] !== "true") {
    return buildCompactAuthorPrompt({
      compactTimedPlan,
      compactSemanticPlan,
      correctionDirectives,
      activeProvider,
      activeProviderOptions,
    });
  }
  return `Author production image prompts from the timed semantic scene plan.

Rules:
${providerPromptGuidance(activeProvider, activeProviderOptions)}

- You are the creative visual editor and image prompt author. The downstream deterministic pass only sanitizes approved ref IDs, paths, forbidden refs, and the four-reference cap; it will not creatively infer missing locations, add characters, rewrite action, choose shot jobs, or fix narrative intent.
- The local visual_beat_script_excerpt is the source of truth for this cut. If parent scene facts and the local excerpt conflict, make the local excerpt visually clear and use parent-scene facts only as candidate context.
- Use current beat and current scene only. Do not import neighboring scene characters, injuries, locations, props, or UI.
- Write normal descriptive prompt prose that preserves exact story meaning, UI text, character count, and shot intent. Exact story/UI text belongs in ui_text_on_screen when needed.
- Do not create separate provider-exclusion payload fields such as negative_prompt, avoid_list, or exclude_list. If the beat itself contains a meaningful absence or refusal, preserve it naturally inside the normal prompt.
- Convert risks into concrete construction when helpful: exact visible subject count, role, pose, action direction, wardrobe construction, frame composition, and location details.
- For single-character shots, state the visible subject concretely, such as "one named character alone in frame," while preserving story-faithful absence language when the beat needs it.
- Identify exact subject roles by name and action, especially in multi-character scenes.
- Reference anchors are binding authoring contracts. If you attach a character_state ref that has scene_prompt_anchor, paste that scene_prompt_anchor's identity/wardrobe/body/state wording into that character's own prompt clause. Do not replace it with generic or inferred wardrobe such as "academy clothes", "casual clothes", "training attire", "uniform", or "clean outfit" unless those exact concepts are in the scene_prompt_anchor. If the local beat suggests a different outfit but the attached character_state ref says otherwise, either use the ref anchor or do not attach that ref.
- For each attached character ref, the prompt body must contain a local clause shaped like: "[screen position], [Character Name]: [copied scene_prompt_anchor], [current pose/action]." The character_staging entry must use the same ref_id, screen_position, and pose as the prose clause.
- The imagegen wrapper will also add "Reference usage" text, but that wrapper is not a substitute for prompt authoring. The modelslab_image_prompt and codex_image_prompt themselves must reaffirm the attached ref anchors.
- For visual beats, use visual_beat_focus to change camera angle, pose, action moment, and composition across beats in the same parent scene.
- For visual beats, visual_beat_script_excerpt and visual_beat_action are the main source for the image. Each cut must show the specific moment in that beat excerpt, not a repeated hero portrait with the whole scene summarized behind the character.
- visual_job and editorial_cues are the editor's reason this cut exists. Build the cut around that job: premise image, humiliation image, system reveal, reaction shot, chat/UI insert, remote witness cutaway, location transition, consequence, threat reveal, or cliffhanger/question.
- suggested_shot_job is the default shot_manifest.shot_job. Copy it unless the beat excerpt clearly requires a better allowed shot job, and then keep the replacement aligned to visual_job.
- location_timeline_label records the current visible location at this timestamp. If the excerpt or location_timeline_label names a new physical place, the prompt must visibly stage that place or a transition into it using the in-scope textual location contract; attach a location image ref only when one exists in the current candidate packet.
- visual_novelty_directive is mandatory edit direction. Follow it to make the current cut visually distinct from adjacent beats without importing their story content.
- visual_beat_quality_findings are deterministic QA warnings for this exact cut. Treat each finding as specific edit direction: visibly stage the named location or transition when the excerpt calls for it, include the named physical character when the beat requires their presence, and vary composition or shot job when repetition is flagged.
- SCENE CORRECTION DIRECTIVES are binding for matching scene_id/image_id. When a directive includes image_id, apply it to that exact cut; when it only includes scene_id, apply it to every affected cut in that scene while preserving each cut's own local excerpt and visual job.
- Named people in the local excerpt are editorially important by default. If the excerpt names a person as a witness, speaker, physical presence, livestream/chat participant, social judge, antagonist, or target of the action, put that person in shot_manifest.visible_characters and stage them visibly in the prompt. Use mentioned_only only for people who are purely discussed and not useful to show for the current beat.
- First-person narration is visual evidence. When the local excerpt uses "I", "me", or "my" for a physical action, reaction, spoken confrontation, object use, or system interaction, treat the narrator/protagonist from visible_characters or character_state_refs as visibly present unless the visual_job is explicitly pure POV, document insert, UI-only, or offscreen narration. Attach the protagonist_state_ref_id / character_state_ref_ids when an in-scope attachable protagonist ref exists.
- Resolve role/title aliases to canonical named characters when current scene facts establish that relationship. If a named person is also the dean, boss, chairman, judge, professor, host, rival, spouse, parent, or another title, later role-only mentions should stage the named person rather than inventing a separate generic character.
- If a named person is present through chat, broadcast, video wall, replay, or livestream rather than physically in the room, make that visible medium explicit in foreground_action, visible_props, ui_elements, and prompt prose.
- If the current beat shows a recognizable named person inside a replay clip, livestream panel, broadcast feed, video wall, chat avatar, dossier card, or phone screen, that person is still visually present through media. Include them in shot_manifest.visible_characters, add character_staging that says they are screen-visible or panel-visible, and attach their in-scope character_state ref when their likeness matters and reference slots allow.
- Use mentioned_only for a named person only when the beat talks about them without showing their body, face, avatar, file portrait, or replay/broadcast image anywhere in the cut.
- Across beats in the same parent scene, vary the visible action progression: establish, object/UI close-up, character interaction, impact, reaction, consequence, and transition as appropriate to the beat excerpt.
- A prompt may use a calm foreground character only when the beat excerpt itself is about stillness, calculation, realization, or a character reveal.
- Author the shot_manifest before writing the prose prompt. Treat it as the contract for the cut: physically visible characters, mentioned-only characters, textual location contract, optional attachable location ref, character state refs, foreground action, shot job, props/UI, and forbidden refs.
- The prose prompt and reference_requirements must obey shot_manifest. If a character is mentioned_only, do not attach that character reference and do not stage that person physically. If a ref_id is in forbidden_ref_ids, do not attach it. forbidden_ref_ids is only for refs that would actively corrupt this cut, such as a wrong character, wrong state, wrong visible location, wrong timeline, or out-of-scope anchor. In-scope refs omitted because all four reference slots are already filled are not forbidden; report them only in reference_usage as available_not_attached_reference_limit. Only attach refs with attachable_reference true. For physical locations, choose the matching in-scope LOCATION CONTRACT LEDGER entry and set shot_manifest.location_contract_id. Describe its prompt_anchor architecture, materials, and layout in prose. Set shot_manifest.location_ref_id and add a location reference_requirement only when a matching approved attachable location image target exists. Never use a text-only contract id as an image ref id.
- Every input unit includes target_image_id. Copy target_image_id exactly into output image_id. Do not restart image_id numbering inside chunks, and do not invent sequential IDs from the schema example.
- Parent scene context explains why the beat matters, but visual_beat_script_excerpt decides what appears. Do not include future reveals, earlier setup, or the whole confrontation unless the current beat excerpt physically shows them.
- previous_beat_context and next_beat_context are sequencing aids only. Use them to avoid repeated shots and to choose progression, but do not import their characters, props, locations, or reveals into the current cut unless the current visual_beat_script_excerpt also includes them.
- For transformation arcs, use one base identity face anchor only when the approved reference metadata says identity_usage is face_only; current state wording controls body, hair, shave/facial hair, wardrobe, posture, cleanliness, and social status.
- Provider-specific prompt fields should be written only when useful for the active image provider route above. Any provider-specific prompt that is present must keep the same visible subject, action, location, references, and shot_manifest as image_prompt.
- modelslab_image_prompt should be a polished image-generation prompt, not a metadata summary. Do not start with "Cut 001", "scene", "beat", or title bookkeeping.
- codex_image_prompt should use natural Codex-friendly image prose with the same shot_manifest contract.
- Every scene prompt should carry concise anime/manhwa style intent without boilerplate. Prefer a short tail such as "16:9 landscape anime/manhwa frame" when the prompt would otherwise be ambiguous. Do not append long repeated style phrases such as clean line art, cel-shaded characters, cinematic webtoon lighting, or non-photorealistic painted background to every cut.
- Background extras are beat-authored, not a style default. Add anonymous customers, staff, workers, crowds, or audience figures only when the local beat excerpt, visible_subjects, editorial cue, or shot_manifest explicitly calls for them. For lonely/private/solo investigation beats, make the room visibly empty except for the named subject and necessary objects, even if the location is normally public.
- ModelsLab Flux handles multi-character shots at surfaces poorly. Whenever two or more characters are positioned at, behind, leaning on, or separated by ANY surface or large object that can cross or occlude a human body (waist-to-chest-height objects — recognize the actual surface from the beat and location, do not rely on a fixed list of furniture types), modelslab_image_prompt must: (a) give each visible character a clear spatial relationship to that surface — near side, far side, behind it, beside its edge, or another explicit side-of-surface placement; (b) state body clearance concretely — full torso above the surface line, feet grounded, hands resting on or above the edge, and body silhouette clear of the surface plane; and (c) prefer asymmetric or diagonal placement over flat centered bilateral staging, offsetting one character forward or to a near corner and the other farther back. codex_image_prompt may keep a more centered, cinematic composition as long as the bodies stay discrete, side-of-surface placement is readable, and body/surface placement is clear.
- Start each prompt with the concrete visible moment, subject, action, and location from visual_beat_script_excerpt.
- Every prompt in the same parent scene should have a different visual job. Prefer concrete shot jobs such as environment establishment, object insert, hand/action close-up, over-shoulder confrontation, impact frame, crowd reaction, UI reveal, aftermath, or transition.
- If the beat excerpt mentions a hand, object, UI line, shove, strike, gate, orb, phone, counter, or expression change, make that element the visible focus for that cut.
- When shot_manifest.location_contract_id is set, describe that contract's visible architecture, materials, lighting, surfaces, and spatial layout as the physical setting for the current beat. When location_ref_id is also set, use the attached image as continuity evidence for that same setting.
- Composition is beat-authored, not globally defaulted. Let the visual beat choose the composition. Do not impose a universal wide/full-frame/medium-wide default. Use close-up, insert, medium, over-shoulder, wide, manga panel, split-screen, or other framing only when that shot scale best serves the current visual_job, beat excerpt, emotion, object, UI, or transition.
- UI text policy for image generation: request clean holographic panels, gauges, icons, simple labels, and at most one short large number or word when visually essential. Put exact multi-line system text, captions, lists, and long labels in ui_text_on_screen for render/subtitle overlay instead of asking the image model to draw dense readable text.
- If a mission/UI label contains refusal or absence wording, put the exact wording in ui_text_on_screen. In modelslab_image_prompt, describe the visible UI design naturally and concretely, but do not add a separate provider-exclusion payload.
- If the story beat depends on chat, system panels, viewer counts, receipts, scoreboards, livestream status, or labels, include concise readable UI text in ui_text_on_screen and visually stage the screen/panel as a key story object. Text can be sparse and large; it should serve the beat instead of filling the frame.
- Shot scale must be intentional and beat-specific. The planner should choose the most useful composition for the cut instead of using a global wide or close-up default.
- Scene cuts must not request contact sheets, reference panels, character sheets, turnarounds, or visible reference-image layouts.
- Character references are identity and wardrobe evidence. Use them to match face, hair, age, body type, and outfit while placing the character in the new pose/action required by this beat.
- Location references are environment evidence. Use them for setting, architecture, lighting, and materials.
- Action/effect references are visual language evidence. Use them for power shape, energy color, and interaction pattern while keeping the beat's current location and subjects.
- Put reference slot roles in reference_requirements.slot_purpose and slot_order. The imagegen wrapper will prepend concise "Reference usage" instructions such as "Use Image 1 for Kang Jiwoo's face, hair, body type, outfit, wardrobe, and identity" at generation time.
- Keep modelslab_image_prompt as a production scene description. Reference images guide identity, wardrobe, style, UI, props, and effects; they are design evidence for the final cut, not visible reference panels.
- Character state refs are definitive when present. For every visible named character with a character_state_refs.scene_prompt_anchor, copy that scene_prompt_anchor into the prompt rather than inventing or paraphrasing wardrobe. Use prompt_anchor only for generating reference images, not inside scene prompts.
- If semantic wardrobe conflicts with character_state_refs, character_state_refs wins.
- If no character_state_refs are provided for a visible character, do not create a definitive anchor. Keep wording limited to current-scene facts and add a warning requesting missing character state ref coverage.
- When two or more visible characters appear, shot_manifest.character_staging is required and must list every visible named character in visible_characters order.
- shot_manifest.character_staging screen_position must use this fixed vocabulary only: ${CHARACTER_STAGING_POSITIONS.join(" | ")}.
- When two or more characters are visible, write separate position-bound people clauses in character_staging order. Bind each clause as: screen position, character name, that character's copied scene_prompt_anchor wardrobe/state wording, then that character's pose.
- Example multi-character clause shape: "Frame-left, Name A: [wardrobe/state anchor A], [pose A]. Frame-right, Name B: [wardrobe/state anchor B], [pose B]. Clear spatial separation between them."
- Never merge two characters into one shared wardrobe or appearance clause, and never describe wardrobe without naming whose wardrobe it is.
- Even when outfits are similar, state the distinguishing wardrobe detail for each staged character inside that character's own clause.
- If a scene needs references, list them as reference_requirements only; do not pretend missing refs exist or define new canonical refs in this stage.
- For each cut, include only references that are visible or style-critical, with at most four reference_requirements total.
- Attach only necessary references. Use no more than four refs; fewer is better when the cut remains clear. Do not attach refs for people, locations, props, or UI that are only mentioned, remembered, texted, called, or implied.
- Reference priority is strict: visible named character_state refs first, including screen-visible people, then location, then prop or UI, then action or effects, then style. If four reference slots are tight, drop optional UI, prop, action, or location refs before dropping a visible named character ref.
- Attach style only when the cut has zero concrete character, location, prop, UI, or action references.
- When more than four concrete references could apply, keep the highest-priority four and report dropped lower-priority refs in reference_usage as available_not_attached_reference_limit. Do not put these reference-limit omissions in forbidden_ref_ids.
- Use visual reference targets to decide reference_usage and anchor_roles.
- Order reference_requirements in the exact attachment order wanted by the image model. Use slot_order starting at 1.
- Put character identity refs before location refs when the main risk is character identity. Put location refs before character refs when the main risk is the environment. Put action/effect refs after identity and location refs unless the effect is the primary subject.
- Each reference requirement should include slot_purpose, such as "character identity and wardrobe for Kang Jiwoo" or "dungeon location environment".
- For standalone_ref targets, mark reference_usage as attach_existing_ref only when a required reference path exists; otherwise report missing_reference_coverage.
- For derive_from_first_clean_cut, derive_from_best_cut, and derive_from_first_clean_wide_cut targets, treat the target as text-only image context until it has a real reference_image_path. If the target is a location, still use it as the shot_manifest.location_ref_id contract for every beat that physically remains in that local location block.
- For no_ref_needed targets, do not attach a reference.
- Output exactly one prompt per ${compactTimedPlan.source_unit === "visual_beats" ? "visual beat" : "timed scene"}.
- Return ${compactTimedPlan.scene_count} prompts, one for every unit in the plan.

TIMED SCENE PLAN:
${JSON.stringify(compactTimedPlan, null, 2)}

SEMANTIC PLAN:
${JSON.stringify(compactSemanticPlan, null, 2)}

SCENE CORRECTION DIRECTIVES:
${JSON.stringify(correctionDirectives, null, 2)}

FEW-SHOT EXAMPLES:
${JSON.stringify({
  single_character_cut: {
    shot_manifest: {
      shot_job: "emotional_reaction",
      visible_characters: ["Protagonist"],
      mentioned_only_characters: ["Secondary Character"],
      primary_character: "Protagonist",
      character_state_ref_ids: ["protagonist_state_ref"],
      protagonist_state_ref_id: "protagonist_state_ref",
      location_contract_id: "corridor_location_contract",
      location_ref_id: "corridor_location_ref",
      foreground_action: "Protagonist freezes in the corridor as the elevator doors part",
      visible_props: ["bag"],
      ui_elements: [],
      forbidden_ref_ids: ["secondary_character_state_ref"],
      continuity_notes: "one present-tense beat",
    },
    modelslab_image_prompt: "Protagonist halts in a corridor as the elevator doors part, one visible subject alone in frame, casual layered outfit, one hand tightening around a bag strap, stunned expression under cold ceiling lights, polished corridor walls and brushed metal elevator doors behind him.",
  },
  multi_character_cut: {
    shot_manifest: {
      shot_job: "interaction",
      visible_characters: ["Protagonist", "Second Character"],
      mentioned_only_characters: [],
      primary_character: "Protagonist",
      character_state_ref_ids: ["protagonist_state_ref", "second_character_state_ref"],
      protagonist_state_ref_id: "protagonist_state_ref",
      location_contract_id: "lobby_location_contract",
      location_ref_id: "lobby_location_ref",
      foreground_action: "Protagonist and the second character stop across from each other in the lobby",
      visible_props: [],
      ui_elements: [],
      forbidden_ref_ids: [],
      continuity_notes: "single confrontation beat",
      character_staging: [
        {
          name: "Protagonist",
          ref_id: "protagonist_state_ref",
          screen_position: "frame-left",
          wardrobe_from: "character_state_ref:protagonist_state_ref",
          pose: "half-turned toward the other character with one shoulder forward and a tense grip on the bag strap",
        },
        {
          name: "Second Character",
          ref_id: "second_character_state_ref",
          screen_position: "frame-right",
          wardrobe_from: "character_state_ref:second_character_state_ref",
          pose: "chin lifted, one hand on the phone, weight settled on the back foot",
        },
      ],
    },
    modelslab_image_prompt: "Lobby confrontation the instant both characters stop. Frame-left, Protagonist: Protagonist, tired adult lead in dark practical work clothes, shoulder bag strap tight in one hand, half-turned toward the other character with one shoulder forward. Frame-right, Second Character: Second Character, polished adult rival in cream fitted coat over black dress, gold phone in hand, chin lifted with weight settled on the back foot. Clear spatial separation between them inside the polished stone lobby with warm sconces and reflective floor. 16:9 landscape anime/manhwa frame.",
    codex_image_prompt: "Two-character lobby confrontation at the exact moment both stop. Frame-left, Protagonist: Protagonist, tired adult lead in dark practical work clothes, shoulder bag strap tight in one hand, half-turned toward the other character with one shoulder forward. Frame-right, Second Character: Second Character, polished adult rival in cream fitted coat over black dress, gold phone in hand, chin lifted with weight settled on the back foot. Clear spatial separation between them in a polished stone lobby with warm sconces and reflective floor. 16:9 landscape anime/manhwa frame.",
    reference_requirements: [
      { ref_id: "protagonist_ref", kind: "character_state", required: true, slot_order: 1, slot_purpose: "character identity and wardrobe for Protagonist", reason: "Frame-left staged identity and wardrobe." },
      { ref_id: "second_character_ref", kind: "character_state", required: true, slot_order: 2, slot_purpose: "character identity and wardrobe for Second Character", reason: "Frame-right staged identity and wardrobe." },
      { ref_id: "lobby_location_ref", kind: "location", required: true, slot_order: 3, slot_purpose: "lobby location environment", reason: "Visible setting for the confrontation." },
    ],
  },
  support_surface_cut: {
    shot_manifest: {
      shot_job: "interaction",
      visible_characters: ["Protagonist", "Second Character"],
      mentioned_only_characters: [],
      primary_character: "Protagonist",
      character_state_ref_ids: ["protagonist_state_ref", "second_character_state_ref"],
      protagonist_state_ref_id: "protagonist_state_ref",
      location_contract_id: "room_location_contract",
      location_ref_id: "room_location_ref",
      foreground_action: "Protagonist pauses with a cup on the near side of a support surface while the second character stands on the far side",
      visible_props: ["cup", "support surface"],
      ui_elements: ["warning panel"],
      forbidden_ref_ids: [],
      continuity_notes: "support-surface confrontation beat",
      character_staging: [
        {
          name: "Protagonist",
          ref_id: "protagonist_state_ref",
          screen_position: "frame-left",
          wardrobe_from: "character_state_ref:protagonist_state_ref",
          pose: "standing on the near side of the support surface with the cup raised just above the edge",
        },
        {
          name: "Second Character",
          ref_id: "second_character_state_ref",
          screen_position: "frame-right",
          wardrobe_from: "character_state_ref:second_character_state_ref",
          pose: "standing on the far side of the support surface with both hands resting on the edge",
        },
      ],
    },
    modelslab_image_prompt: "Support-surface confrontation at the exact instant the warning appears. Frame-left foreground, Protagonist: Protagonist, tired adult lead in dark practical work clothes, standing on the near side of the surface with the cup raised just above the edge, full torso clear above the surface line, feet on the floor. Frame-right, Second Character: Second Character, polished adult rival in cream fitted coat over black dress, standing on the far side with both hands resting on the edge, full torso clear above the surface line. A crisp blue warning panel hovers above the cup. Clear diagonal separation between them, both bodies fully separate from the surface plane. 16:9 landscape anime/manhwa frame.",
    codex_image_prompt: "Stylized standoff across a support surface as the warning appears. Frame-left foreground, Protagonist: Protagonist, tired adult lead in dark practical work clothes, on the near side with the cup lifted. Frame-right, Second Character: Second Character, polished adult rival in cream fitted coat over black dress, on the far side leaning onto the edge. Both bodies fully clear of the surface silhouette, crisp blue warning panel above the cup, cinematic centered room depth with discrete body placement. 16:9 landscape anime/manhwa frame.",
  },
}, null, 2)}

Return JSON only:
{
  "style_summary": "...",
  "prompts": [
    {
      "image_id": "<copy target_image_id exactly>",
      "scene_id": "scene_001",
      "visual_beat_id": "scene_001_beat_01",
      "start_sec": 0,
      "duration_sec": 6,
      "image_prompt": "production scene prompt only",
      "modelslab_image_prompt": "production scene prompt optimized for the active ModelsLab image model when the active route needs ModelsLab, else empty string",
      "codex_image_prompt": "production scene prompt optimized for Codex/OpenAI when the active route needs Codex, else empty string",
      "image_provider_route": "modelslab|codex_imagegen",
      "reference_requirements": [{"ref_id":"style_ref","kind":"style","required":true,"slot_order":1,"slot_purpose":"anime manhwa style language","reason":"..."}],
      "required_reference_paths": [],
      "reference_usage": [{"ref_id":"...","usage":"attach_existing_ref|derive_from_cut|no_ref_needed|missing_reference_coverage","reason":"..."}],
      "anchor_roles": [{"ref_id":"...","kind":"character_state|location|prop|ui|action","anchor_role":"source_anchor","reason":"..."}],
      "shot_manifest": {
        "shot_job": "environment_establishing|body_state_proof|object_insert|interaction|physical_action|emotional_reaction|consequence|ui_reveal|transition",
        "visible_characters": ["Joey"],
        "mentioned_only_characters": ["Secondary Character"],
        "primary_character": "Joey",
        "character_state_ref_ids": ["joey_ref"],
        "protagonist_state_ref_id": "joey_ref",
        "location_contract_id": "location_contract",
        "location_ref_id": "location_ref",
        "foreground_action": "Joey holds a delivery bag alone in the elevator corridor",
        "visible_props": ["delivery bag"],
        "ui_elements": [],
        "forbidden_ref_ids": ["secondary_character_ref", "antagonist_ref"],
        "continuity_notes": "one present-tense moment from the current beat excerpt",
        "character_staging": [
          {
            "name": "Joey",
            "ref_id": "state_ref_id",
            "screen_position": "frame-left",
            "wardrobe_from": "character_state_ref:state_ref_id",
            "pose": "specific pose or action for this character"
          }
        ]
      },
      "visible_subjects": ["..."],
      "character_state_refs_used": ["state_ref_id"],
      "primary_subject": "...",
      "location": "...",
      "ui_text_on_screen": ["..."]
    }
  ],
  "warnings": [{"scene_id":"...","code":"missing_character_state_ref","message":"..."}]
}`;
}

async function callLocal(prompt, stageName, maxTokens = null) {
  assertPromptSize(prompt, stageName);
  const attempts = Number(flags["visual-json-attempts"] ?? 3);
  let lastError = null;
  let lastContent = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const retryPrompt = attempt === 1
      ? prompt
      : `${prompt}\n\nYour previous response was invalid or incomplete JSON. Return one complete JSON object only. Escape quotes inside strings. Do not include markdown fences, commentary, trailing commas, or partial objects.`;
    const response = await fetch(localLLMChatCompletionURL(stageName), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...localLLMAuthHeaders() },
      body: JSON.stringify({
        model: getLLMModel(stageName),
        messages: [
          { role: "system", content: "Return only valid JSON. You are a precise anime/manhwa image prompt planner. Preserve the local beat's visible story intent. Keep all provider prompt content in the normal prompt fields." },
          { role: "user", content: retryPrompt },
        ],
        temperature: attempt === 1 ? Number(flags["llm-temperature"] ?? 0.12) : 0,
        max_tokens: Number(maxTokens ?? flags["llm-max-tokens"] ?? 18000),
      }),
      signal: AbortSignal.timeout(Number(process.env.ANIFACTORY_VISUAL_PLAN_TIMEOUT_MS ?? 1_200_000)),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`local-qwen visual plan HTTP ${response.status}: ${raw.slice(0, 1000)}`);
    const content = JSON.parse(raw)?.choices?.[0]?.message?.content ?? raw;
    lastContent = content;
    try {
      return { provider: "local-qwen", model: getLLMModel(stageName), content, parsed: extractJson(content), json_attempt: attempt };
    } catch (error) {
      lastError = error;
      console.error(`visual ${stageName}: invalid JSON attempt ${attempt}/${attempts}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`local-qwen visual plan returned invalid JSON after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}; content preview: ${lastContent.slice(0, 600)}`);
}

async function callCodex(prompt, stageName, expectedBeatIds = null) {
  assertPromptSize(prompt, stageName);
  const callDir = path.join(weekDir, "_codex_calls");
  await fs.mkdir(callDir, { recursive: true });
  if (flags["codex-reuse-latest"] === "true" || flags["codex-reuse-cache"] === "true") {
    const cached = await findLatestCodexOutput(callDir, stageName, expectedBeatIds, prompt);
    if (cached) return cached;
    console.error(`visual ${stageName}: no reusable cached Codex output found; calling Codex`);
  }
  const attempts = Math.max(1, Number(flags["codex-call-attempts"] ?? 2));
  const timeoutMs = Math.max(30_000, Number(flags["codex-call-timeout-ms"] ?? 8 * 60_000));
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const outputPath = path.join(callDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${stageName}-attempt_${attempt}-output.txt`);
    try {
      const call = await runCodexCli({
        prompt,
        stageName,
        repoRoot,
        outputPath,
        model: flags.model ?? flags["llm-model"] ?? null,
        reasoningEffort: flags["reasoning-effort"] ?? null,
        timeoutMs,
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
    } catch (error) {
      lastError = error;
      if (attempt < attempts) console.error(`visual ${stageName}: retrying after ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw lastError ?? new Error(`codex visual plan failed for ${stageName}`);
}

async function findLatestCodexOutput(callDir, stageName, expectedBeatIds = null, prompt = "") {
  let entries = [];
  try {
    entries = await fs.readdir(callDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const safeStageName = stageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${safeStageName}(?:-attempt_\\d+)?-output\\.txt$`);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    const outputPath = path.join(callDir, entry.name);
    try {
      const stat = await fs.stat(outputPath);
      candidates.push({ outputPath, mtimeMs: stat.mtimeMs });
    } catch {}
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const candidate of candidates) {
    try {
      const metadata = await readCodexCallMetadata(candidate.outputPath);
      if (!isCodexCacheCompatible(metadata, {
        model: flags.model ?? flags["llm-model"] ?? null,
        reasoningEffort: flags["reasoning-effort"] ?? null,
        promptHash: sha256(prompt),
      })) continue;
      const content = await fs.readFile(candidate.outputPath, "utf8");
      const parsed = extractJson(content);
      if (Array.isArray(parsed.prompts) && parsed.prompts.length) {
        if (Array.isArray(expectedBeatIds) && expectedBeatIds.length) {
          const actualBeatIds = parsed.prompts.map((prompt) => String(prompt.visual_beat_id ?? "")).filter(Boolean);
          if (actualBeatIds.length !== expectedBeatIds.length) continue;
          if (!expectedBeatIds.every((beatId, index) => actualBeatIds[index] === beatId)) continue;
        }
        console.error(`visual ${stageName}: reused cached Codex output ${candidate.outputPath}`);
        return {
          provider: "codex-cache",
          model: metadata.model,
          reasoning_effort: metadata.reasoning_effort,
          codex_cli_path: metadata.codex_cli_path,
          codex_cli_version: metadata.codex_cli_version,
          output_path: candidate.outputPath,
          content,
          parsed,
        };
      }
    } catch {}
  }
  return null;
}

function assertPromptSize(prompt, stageName) {
  const length = String(prompt ?? "").length;
  console.error(`visual ${stageName}: prompt chars ${length}`);
  if (Number.isFinite(promptMaxChars) && promptMaxChars > 0 && length > promptMaxChars) {
    throw new Error(`Visual planner prompt for ${stageName} is ${length} chars, above limit ${promptMaxChars}. Use a smaller batch or compact upstream artifacts.`);
  }
}

function targetImageIdForRow(row, episodeId, fallbackIndex = 0) {
  if (row?.image_id_hint) return String(row.image_id_hint);
  const absoluteIndex = Number.isFinite(Number(row?.__visual_plan_absolute_index))
    ? Number(row.__visual_plan_absolute_index)
    : fallbackIndex;
  return `${episodeId}-cut-${String(absoluteIndex + 1).padStart(3, "0")}`;
}

function assertPromptIdentityMatchesInputs(prompts, sourceRows, episodeId, label = "visual planner") {
  const failures = [];
  for (let index = 0; index < sourceRows.length; index += 1) {
    const prompt = prompts[index] ?? {};
    const source = sourceRows[index] ?? {};
    const expectedImageId = targetImageIdForRow(source, episodeId, index);
    const actualImageId = String(prompt.image_id ?? "");
    if (actualImageId !== expectedImageId) {
      failures.push(`${label} item ${index + 1}: image_id ${actualImageId || "(missing)"} should be ${expectedImageId}`);
    }
    const expectedBeatId = source.visual_beat_id ? String(source.visual_beat_id) : "";
    const actualBeatId = prompt.visual_beat_id ? String(prompt.visual_beat_id) : "";
    if (expectedBeatId && actualBeatId !== expectedBeatId) {
      failures.push(`${label} item ${index + 1}: visual_beat_id ${actualBeatId || "(missing)"} should be ${expectedBeatId}`);
    }
  }
  if (failures.length) {
    throw new Error(`Visual planner output did not preserve input identity:\n${failures.slice(0, 24).join("\n")}`);
  }
}

function normalizePrompt(row, index, episodeId, sourceUnit = null, scope = {}) {
  const imageId = targetImageIdForRow(sourceUnit, episodeId, index);
  const manifest = sanitizeShotManifest(row.shot_manifest);
  if (manifest && !manifest.reference_slots.length && Array.isArray(row.reference_requirements)) {
    manifest.reference_slots = row.reference_requirements.map((slot, slotIndex) => ({
      ref_id: String(slot?.ref_id ?? "").trim(),
      kind: String(slot?.kind ?? "").trim(),
      required: slot?.required !== false,
      slot_order: Number(slot?.slot_order ?? slotIndex + 1),
      slot_purpose: String(slot?.slot_purpose ?? "").trim(),
      reason: String(slot?.reason ?? slot?.slot_purpose ?? "").trim(),
    })).filter((slot) => slot.ref_id);
  }
  const route = routedProviderForPrompt(sourceUnit ?? row, scope.activeImageProvider ?? row.image_provider_route ?? "modelslab", scope.activeImageProviderOptions ?? {});
  const providerPrompt = String(row.provider_prompt ?? row.image_prompt ?? row.modelslab_image_prompt ?? row.codex_image_prompt ?? "").trim();
  const referenceRequirements = (manifest?.reference_slots ?? []).map((slot) => ({
    ref_id: slot.ref_id,
    kind: slot.kind,
    required: slot.required !== false,
    slot_order: slot.slot_order,
    slot_purpose: slot.slot_purpose,
    reason: slot.reason ?? slot.slot_purpose,
  }));
  const characterRefIds = [...new Set([
    ...(manifest?.character_state_ref_ids ?? []),
    manifest?.protagonist_state_ref_id,
  ].filter(Boolean))];
  const basePrompt = {
    image_id: imageId,
    scene_id: row.scene_id ?? null,
    visual_beat_id: row.visual_beat_id ?? null,
    visual_beat_action: sourceUnit?.visual_beat_action ?? row.visual_beat_action ?? null,
    visual_beat_script_excerpt: sourceUnit?.visual_beat_script_excerpt ?? row.visual_beat_script_excerpt ?? null,
    visual_job: sourceUnit?.visual_job ?? row.visual_job ?? null,
    editorial_cues: sourceUnit?.editorial_cues ?? row.editorial_cues ?? [],
    suggested_shot_job: sourceUnit?.suggested_shot_job ?? row.suggested_shot_job ?? null,
    visual_novelty_directive: sourceUnit?.visual_novelty_directive ?? row.visual_novelty_directive ?? null,
    location_timeline_label: sourceUnit?.location_timeline_label ?? row.location_timeline_label ?? null,
    visual_beat_quality_findings: sourceUnit?.visual_beat_quality_findings ?? row.visual_beat_quality_findings ?? [],
    active_state_constraints: sourceUnit?.active_state_constraints ?? null,
    start_sec: Number(sourceUnit?.start_sec ?? row.start_sec ?? 0),
    duration_sec: Math.max(0.25, Number(sourceUnit?.duration_sec ?? row.duration_sec ?? 6)),
    provider_prompt: providerPrompt,
    image_prompt: providerPrompt,
    modelslab_image_prompt: route === "modelslab" ? providerPrompt : "",
    codex_image_prompt: route === "codex_imagegen" ? providerPrompt : null,
    prompt_hash: sha256(providerPrompt),
    image_provider_route: route,
    image_model_route: process.env.ANIFACTORY_IMAGE_MODEL ?? "flux-klein",
    reference_requirements: referenceRequirements,
    required_reference_paths: [],
    reference_usage: referenceRequirements.map((requirement) => ({ ref_id: requirement.ref_id, usage: "attach_existing_ref", reason: requirement.reason })),
    anchor_roles: referenceRequirements.map((requirement) => ({ ref_id: requirement.ref_id, kind: requirement.kind, anchor_role: "source_anchor", reason: requirement.reason })),
    shot_manifest: manifest,
    visible_subjects: manifest?.visible_characters ?? [],
    character_state_refs_used: characterRefIds,
    primary_subject: manifest?.primary_character ?? null,
    location: sourceUnit?.local_location ?? sourceUnit?.location ?? null,
    ui_text_on_screen: manifest?.ui_elements ?? [],
    image_generation_required: true,
  };
  const scene = sourceUnit ?? row;
  const scopedCharacterRefs = sceneCharacterStateRefs(scene, scope.stateRefIndex ?? new Map());
  const allowedRefIds = allowedRefIdsForScene({
    scene,
    visualReferencePlan: scope.visualReferencePlan,
    characterStateRefs: scopedCharacterRefs,
  });
  return dropOutOfScopePromptRefs(basePrompt, allowedRefIds);
}

export function normalizePromptPacketForTests(row, sourceUnit, options = {}) {
  return normalizePrompt(row, 0, options.episode ?? "ep_01", sourceUnit, {
    visualReferencePlan: options.visualReferencePlan ?? { reference_targets: [] },
    stateRefIndex: options.stateRefIndex ?? new Map(),
    activeImageProvider: options.activeImageProvider ?? "modelslab",
    activeImageProviderOptions: options.activeImageProviderOptions ?? {},
  });
}

function activeStateConstraintFindings(prompts, sourceRows) {
  const findings = [];
  const stop = new Set(["with", "from", "into", "wearing", "current", "same", "their", "visible", "state"]);
  const entityIsVisiblyStaged = (prompt, entityId) => {
    const expected = normalizeLabel(String(entityId ?? "").replace(/_/g, " "));
    if (!expected) return false;
    const visible = [
      ...(prompt?.shot_manifest?.visible_characters ?? []),
      ...(prompt?.shot_manifest?.character_staging ?? []).flatMap((row) => [row?.character_id, row?.character, row?.character_name]),
    ].filter(Boolean).map((value) => normalizeLabel(value));
    return visible.some((value) => value === expected || value.includes(expected) || expected.includes(value));
  };
  for (let index = 0; index < prompts.length; index += 1) {
    const prompt = prompts[index];
    const source = sourceRows[index];
    const text = normalizeLabel(prompt.provider_prompt ?? prompt.image_prompt ?? "");
    for (const [entityId, state] of Object.entries(source?.active_state_constraints?.entities ?? {})) {
      if (!entityIsVisiblyStaged(prompt, entityId)) continue;
      for (const field of ["wardrobe", "injury", "visible_state", "possession"]) {
        const value = String(state?.[field] ?? "").trim();
        if (!value) continue;
        const tokens = normalizeLabel(value).split(/\s+/).filter((token) => token.length > 3 && !stop.has(token));
        if (!tokens.length || tokens.some((token) => text.includes(token))) continue;
        findings.push({
          severity: "blocker",
          code: "active_state_constraint_not_reaffirmed",
          image_id: prompt.image_id,
          visual_beat_id: prompt.visual_beat_id,
          entity_id: entityId,
          field,
          expected_state: value,
          correction_directive: `Depict ${entityId} with the current ${field}: ${value}.`,
        });
      }
    }
  }
  return findings;
}

export function activeStateConstraintFindingsForTests(prompts, sourceRows) {
  return activeStateConstraintFindings(prompts, sourceRows);
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
    reference_slots: (Array.isArray(value.reference_slots) ? value.reference_slots : []).map((slot, index) => ({
      ref_id: String(slot?.ref_id ?? "").trim(),
      kind: String(slot?.kind ?? "").trim(),
      required: slot?.required !== false,
      slot_order: Number(slot?.slot_order ?? index + 1),
      slot_purpose: String(slot?.slot_purpose ?? "").trim(),
      reason: String(slot?.reason ?? slot?.slot_purpose ?? "").trim(),
    })).filter((slot) => slot.ref_id),
    continuity_notes: value.continuity_notes ? String(value.continuity_notes) : null,
    character_staging: sanitizeCharacterStaging(value.character_staging),
  };
}

function promptSimilarityKey(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\bcut\s+\d+\s+of\s+\d+\b/g, "")
    .replace(/\b(?:low angle close action frame|wide establishing composition|over shoulder perspective|dynamic diagonal action composition|tight emotional close frame|high angle surveillance style frame|side profile cinematic frame|foreground subject with deep background layers)\b/g, "")
    .replace(/\b\d+(?:\.\d+)?\b/g, "")
    .replace(/[^a-z0-9가-힣]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 420);
}

function assertPromptVariety(prompts) {
  const groups = new Map();
  for (const prompt of prompts) {
    const sceneId = prompt.scene_id ?? "unknown";
    if (!groups.has(sceneId)) groups.set(sceneId, []);
    groups.get(sceneId).push(prompt);
  }
  const failures = [];
  for (const [sceneId, rows] of groups.entries()) {
    if (rows.length < 4) continue;
    const counts = new Map();
    for (const row of rows) {
      const key = promptSimilarityKey(row.modelslab_image_prompt ?? row.image_prompt ?? row.codex_image_prompt);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const repeated = [...counts.entries()].filter(([, count]) => count >= Math.min(4, rows.length));
    if (repeated.length) failures.push(`${sceneId} has repeated prompt bodies across ${repeated[0][1]} visual beats`);
  }
  if (failures.length && flags["strict-prompt-variety-gate"] === "true") {
    throw new Error(`Visual prompt plan lacks beat-level variety:\n${failures.slice(0, 20).join("\n")}`);
  }
  return failures.map((message) => ({
    code: "prompt_variety_warning",
    severity: "warning",
    message,
  }));
}

function assertLocationSpanVariety(prompts) {
  if (allowLongLocationSpans) return [];
  const findings = longLocationSpanFindings(prompts, {
    maxSameLocationSpanSec,
    retentionStartSec: 180,
  });
  if (findings.length && flags["strict-location-span-gate"] === "true") {
    throw new Error(`Visual prompt plan has long repeated-location spans:\n${findings.slice(0, 20).map((span) => (
      `${span.locationId} ${span.count} cuts ${span.firstImageId}-${span.lastImageId} ${Number(span.start).toFixed(1)}s-${Number(span.end).toFixed(1)}s (${Number(span.measured_after_retention_start_sec).toFixed(1)}s after 3:00)`
    )).join("\n")}`);
  }
  return findings.map((finding) => ({
    code: "location_span_variety_warning",
    severity: "warning",
    message: `${finding.locationId} repeats for ${finding.count} cuts from ${finding.firstImageId} to ${finding.lastImageId} after the retention runway.`,
    ...finding,
  }));
}

function assertRetentionShotJobVarietySoft(prompts) {
  if (allowRepeatedRetentionShotJobs) return [];
  const findings = repeatedLocationShotJobFindings(prompts, {
    maxConsecutiveSameLocationShotJob: maxConsecutiveRetentionShotJobs,
    retentionEndSec: 180,
  });
  if (findings.length && flags["strict-retention-shot-job-gate"] === "true") {
    throw new Error(`Visual prompt plan repeats the same location/shot job too long in the retention runway:\n${findings.slice(0, 20).map((run) => (
      `${run.locationId}/${run.shotJob} ${run.count} cuts ${run.firstImageId}-${run.lastImageId} ${Number(run.start).toFixed(1)}s-${Number(run.end).toFixed(1)}s`
    )).join("\n")}`);
  }
  return findings.map((finding) => ({
    code: "retention_shot_job_variety_warning",
    severity: "warning",
    message: `${finding.locationId}/${finding.shotJob} repeats for ${finding.count} opening cuts from ${finding.firstImageId} to ${finding.lastImageId}.`,
    ...finding,
  }));
}

function assertScenePromptShape(prompts) {
  const failures = [];
  const badLayout = /\b(?:contact sheet|reference board|reference sheet|character sheet|visible reference panel|reference panels?|reference panel layout|turnaround sheet|turnaround board|character turnaround)\b/ig;
  const metadataStart = /^\s*(?:cut\s+\d+|scene\s+\d+|beat\s+\d+)/i;
  const duplicateSlotText = /\buse image (?:one|two|three|four|five|six|seven|eight) as\b/i;
  for (const prompt of prompts) {
    const text = String(prompt.modelslab_image_prompt ?? prompt.image_prompt ?? prompt.codex_image_prompt ?? "");
    if (metadataStart.test(text)) failures.push(`${prompt.image_id} starts with metadata instead of visible action`);
    if (hasAffirmativeReferenceLayoutRequest(text, badLayout)) failures.push(`${prompt.image_id} requests a reference/sheet layout in a scene cut`);
    if (duplicateSlotText.test(text)) failures.push(`${prompt.image_id} duplicates reference slot text inside prompt body`);
  }
  if (failures.length) {
    throw new Error(`Visual prompt plan violates scene-prompt shape contract:\n${failures.slice(0, 30).join("\n")}`);
  }
}

function hasAffirmativeReferenceLayoutRequest(text, pattern) {
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const before = text.slice(Math.max(0, match.index - 64), match.index).toLowerCase();
    if (/\b(?:no|not|without|avoid|avoiding|instead of|rather than|free of|clear of)\b/.test(before)) continue;
    return true;
  }
  return false;
}

function promptSearchText(prompt) {
  return [
    prompt.image_prompt,
    prompt.modelslab_image_prompt,
    prompt.codex_image_prompt,
    prompt.shot_manifest?.foreground_action,
    prompt.shot_manifest?.visible_characters,
    prompt.shot_manifest?.mentioned_only_characters,
    prompt.visible_subjects,
    prompt.ui_text_on_screen,
  ].flat(Infinity).filter(Boolean).join(" ").toLowerCase();
}

function normalizedPromptSearchText(prompt) {
  return promptSearchText(prompt).replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function nameAppearsInPrompt(name, prompt) {
  const text = normalizedPromptSearchText(prompt);
  const full = String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const first = full.split(/\s+/)[0] ?? "";
  if (full && text.includes(full)) return true;
  return first.length > 2 && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
}

function localBeatFidelityFindings(prompts, sourceRows) {
  const failures = [];
  for (let index = 0; index < prompts.length; index += 1) {
    const prompt = prompts[index];
    const source = sourceRows[index] ?? {};
    const localNames = mentionedCandidateNames(source);
    const qualityNames = (source.visual_beat_quality_findings ?? [])
      .filter((finding) => finding?.code === "named_character_not_visible_subject" && finding.character)
      .map((finding) => String(finding.character));
    for (const name of [...new Set([...localNames, ...qualityNames])]) {
      if (!nameAppearsInPrompt(name, prompt)) {
        failures.push(`${prompt.image_id} local excerpt names ${name}, but prompt/manifest does not stage or visibly mediate that person`);
      }
    }
    for (const phrase of locationMentionPhrases(source.visual_beat_script_excerpt ?? "")) {
      const text = promptSearchText(prompt);
      const normalizedPhrase = phrase.toLowerCase();
      const importantVenue = /^[A-Z]/.test(phrase) || /\b(?:hall|stage|lobby|room|screen|wall|floor|campus|studio|server)\b/i.test(phrase);
      if (importantVenue && locationPhraseRequiresVisibleStaging(phrase, source) && !text.includes(normalizedPhrase.split(/\s+/).slice(-2).join(" "))) {
        failures.push(`${prompt.image_id} local excerpt names location ${phrase}, but prompt/manifest does not visibly stage it`);
      }
    }
  }
  return failures;
}

export function localBeatFidelityFindingsForTests(prompts, sourceRows) {
  return localBeatFidelityFindings(prompts, sourceRows);
}

function assertLocalBeatFidelity(prompts, sourceRows) {
  const failures = localBeatFidelityFindings(prompts, sourceRows);
  if (failures.length) {
    throw new Error(`Visual prompt plan failed local beat fidelity:\n${failures.slice(0, 40).join("\n")}`);
  }
}

function assertShotFramingDistribution(prompts) {
  const closePattern = /\b(?:extreme close|close-up|closeup|tight (?:shot|frame|framing|composition)|face fills|head-and-shoulders|shoulders-up|chest-up|waist-up|cropped face|cropped head)\b/i;
  const allowedCloseJobs = new Set(["object_insert", "ui_reveal", "emotional_reaction", "consequence"]);
  const closeRows = prompts.filter((prompt) => closePattern.test([
    prompt.image_prompt,
    prompt.modelslab_image_prompt,
    prompt.codex_image_prompt,
    prompt.shot_manifest?.shot_job,
  ].filter(Boolean).join(" ")));
  const badCloseRows = closeRows.filter((prompt) => !allowedCloseJobs.has(String(prompt.shot_manifest?.shot_job ?? prompt.suggested_shot_job ?? "")));
  const maxCloseShare = Number(flags["max-close-shot-share"] ?? process.env.ANIFACTORY_MAX_CLOSE_SHOT_SHARE ?? 0.32);
  const failures = [];
  if (prompts.length >= 10 && closeRows.length / prompts.length > maxCloseShare) {
    failures.push(`close/tight framing share ${closeRows.length}/${prompts.length} exceeds ${Math.round(maxCloseShare * 100)}%`);
  }
  if (badCloseRows.length) {
    failures.push(`close/tight language used on non-close shot jobs: ${badCloseRows.slice(0, 12).map((prompt) => prompt.image_id).join(", ")}`);
  }
  if (failures.length && flags["strict-framing-gate"] === "true") {
    throw new Error(`Visual prompt framing gate failed:\n${failures.join("\n")}`);
  }
  return failures.map((message) => ({
    code: "shot_framing_distribution_warning",
    severity: "warning",
    message,
  }));
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function chunkByParentScene(items, targetSize) {
  const chunks = [];
  let current = [];
  let currentSceneId = null;
  const splitLongScenes = flags["visual-chunk-split-long-scenes"] !== "false";
  for (const item of items) {
    const sceneId = item.parent_scene_id ?? item.scene_id ?? null;
    const startsNewScene = current.length && sceneId !== currentSceneId;
    const reachedTarget = current.length >= targetSize;
    if (current.length && ((startsNewScene && reachedTarget) || (!startsNewScene && splitLongScenes && reachedTarget))) {
      chunks.push(current);
      current = [];
    }
    current.push(item);
    currentSceneId = sceneId;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function visualUnitRiskClass(unit, visualReferencePlan, stateRefIndex) {
  const visibleCount = (unit.visible_characters ?? unit.visible_subjects ?? []).length;
  const referenceCount = relevantReferenceTargets(unit, visualReferencePlan, stateRefIndex).length;
  const job = `${unit.visual_job ?? ""} ${unit.suggested_shot_job ?? ""} ${unit.visual_beat_action ?? ""}`;
  if (Number(unit.start_sec ?? 0) < 180
    || visibleCount >= 3
    || referenceCount >= 4
    || /physical_action|fight|strike|grab|carry|rescue|impact|shove|restrain/i.test(job)) return "high";
  if (visibleCount >= 2 || referenceCount >= 2 || /system_reveal|ui_reveal|interaction|reaction|consequence/i.test(job)) return "medium";
  return "simple";
}

function adaptivePromptChunks(items, visualReferencePlan, stateRefIndex) {
  const limits = {
    high: Math.max(1, Number(flags["visual-high-risk-chunk-size"] ?? 4)),
    medium: Math.max(1, Number(flags["visual-medium-risk-chunk-size"] ?? 6)),
    simple: Math.max(1, Number(flags["visual-simple-chunk-size"] ?? 10)),
  };
  const priority = { simple: 1, medium: 2, high: 3 };
  const chunks = [];
  let index = 0;
  while (index < items.length) {
    const initialRisk = visualUnitRiskClass(items[index], visualReferencePlan, stateRefIndex);
    const chunk = [];
    let risk = initialRisk;
    while (index < items.length && chunk.length < limits[risk]) {
      const nextRisk = visualUnitRiskClass(items[index], visualReferencePlan, stateRefIndex);
      if (chunk.length && nextRisk !== risk) break;
      chunk.push(items[index]);
      if (priority[nextRisk] > priority[risk]) risk = nextRisk;
      index += 1;
    }
    chunks.push(Object.assign(chunk, { risk_class: risk, target_chunk_size: limits[risk] }));
  }
  return chunks;
}

export function adaptivePromptChunksForTests(items, options = {}) {
  return adaptivePromptChunks(items, options.visualReferencePlan ?? { reference_targets: [] }, options.stateRefIndex ?? new Map())
    .map((chunk) => ({ risk_class: chunk.risk_class, target_chunk_size: chunk.target_chunk_size, ids: chunk.map((row) => row.visual_beat_id ?? row.scene_id) }));
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(items.length, Number(concurrency) || 1));
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function parseListFlag(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function loadCorrectionDirectives(filePath) {
  if (!filePath) return [];
  const artifact = await readJson(filePath, null);
  if (Array.isArray(artifact)) return artifact;
  if (Array.isArray(artifact?.correction_directives)) return artifact.correction_directives;
  if (Array.isArray(artifact?.directives)) return artifact.directives;
  return [];
}

function filterVisualSourceRows(rows, episodeId) {
  const annotated = rows.map((row, index, allRows) => ({
    ...row,
    __visual_plan_absolute_index: index,
    __previous_visual_context: compactNeighborContext(allRows[index - 1]),
    __next_visual_context: compactNeighborContext(allRows[index + 1]),
  }));
  const sceneIds = parseListFlag(flags["only-scenes"] ?? flags.onlyScenes);
  if (sceneIds.length) {
    const wanted = new Set(sceneIds);
    return annotated.filter((row) => wanted.has(row.parent_scene_id ?? row.scene_id));
  }
  const cutIds = parseListFlag(flags["cut-ids"] ?? flags.cutIds);
  if (cutIds.length) {
    const wanted = new Set(cutIds);
    return annotated.filter((row, index) => wanted.has(row.image_id_hint ?? `${episodeId}-cut-${String(index + 1).padStart(3, "0")}`));
  }
  const beatIds = parseListFlag(flags["beat-ids"] ?? flags.beatIds);
  if (beatIds.length) {
    const wanted = new Set(beatIds);
    return annotated.filter((row) => wanted.has(row.visual_beat_id));
  }
  const offset = Math.max(0, Number(flags["visual-unit-offset"] ?? flags.offset ?? 0));
  const limitRaw = flags["visual-unit-limit"] ?? flags.limit;
  const limit = limitRaw == null ? null : Math.max(0, Number(limitRaw));
  if (limit != null) return annotated.slice(offset, offset + limit);
  if (offset > 0) return annotated.slice(offset);
  return annotated;
}

function locationTargetsForSourceRow(row, visualReferencePlan) {
  return referenceTargetsForScene(row, visualReferencePlan)
    .filter((target) => String(target?.kind ?? "").toLowerCase() === "location")
    .filter((target) => locationTargetMatchesSourceRow(target, row));
}

function locationTargetMatchesSourceRow(target, row) {
  if (String(target?.kind ?? "").toLowerCase() !== "location") return true;
  const contractIds = (target.location_contract_ids ?? []).map((id) => String(id ?? "").trim()).filter(Boolean);
  const rowLocationId = String(row?.location_id ?? row?.location_contract_id ?? "").trim();
  if (!contractIds.length || !rowLocationId) return true;
  return contractIds.includes(rowLocationId);
}

function forcedLocationRefId(row, visualReferencePlan) {
  const locationTargets = locationTargetsForSourceRow(row, visualReferencePlan);
  return locationTargets.length === 1 ? String(locationTargets[0].ref_id ?? "").trim() : null;
}

function locationLabelTokens(label) {
  const stopwords = new Set([
    "the", "a", "an", "of", "and", "same", "inside", "outside", "around", "beside",
    "near", "with", "within", "into", "onto", "from", "at", "by",
  ]);
  return new Set(String(label ?? "")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => !stopwords.has(token)));
}

function locationLabelsEquivalent(left, right) {
  const leftTokens = locationLabelTokens(left);
  const rightTokens = locationLabelTokens(right);
  if (!leftTokens.size || !rightTokens.size) return false;
  const commonTokens = [...leftTokens].filter((token) => rightTokens.has(token));
  const intersection = commonTokens.length;
  const smaller = Math.min(leftTokens.size, rightTokens.size);
  if (intersection === smaller && smaller >= 3) return true;
  const strongLocationTokens = new Set([
    "academy", "altar", "arena", "atrium", "basement", "bathroom", "bedroom", "bridge",
    "building", "cafe", "cafeteria", "campus", "chamber", "classroom", "core", "corridor",
    "court", "courthouse", "courtroom", "courtyard", "deck", "district", "door", "dungeon",
    "elevator", "entrance", "floor", "fountain", "gate", "guild", "gym", "hall", "hallway",
    "hospital", "house", "island", "kitchen", "lab", "library", "lobby", "office", "palace",
    "plaza", "platform", "restaurant", "roof", "rooftop", "room", "shop", "square", "stage",
    "station", "street", "studio", "table", "tower", "tribunal", "vault", "wall", "warehouse",
  ]);
  const commonStrong = commonTokens.filter((token) => strongLocationTokens.has(token));
  const leftUniqueStrong = [...leftTokens].filter((token) => !rightTokens.has(token) && strongLocationTokens.has(token));
  const rightUniqueStrong = [...rightTokens].filter((token) => !leftTokens.has(token) && strongLocationTokens.has(token));
  if (intersection >= 3 && commonStrong.length && (!leftUniqueStrong.length || !rightUniqueStrong.length)) return true;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union > 0 && intersection / union >= 0.72;
}

function addDistinctLocationLabel(labels, label) {
  const trimmed = String(label ?? "").trim();
  if (!trimmed) return;
  for (const existing of labels) {
    if (locationLabelsEquivalent(existing, trimmed)) return;
  }
  labels.add(trimmed);
}

function scopedLocationCoverageFindings(rows, visualReferencePlan, {
  maxSameLocationSpanSec: maxSec = maxSameLocationSpanSec,
  retentionStartSec = 180,
} = {}) {
  const ordered = [...rows]
    .filter((row) => Number.isFinite(Number(row.start_sec)))
    .sort((a, b) => Number(a.start_sec) - Number(b.start_sec));
  const spans = [];
  let current = null;
  for (const row of ordered) {
    const forcedRefId = forcedLocationRefId(row, visualReferencePlan);
    if (!forcedRefId) {
      if (current) spans.push(current);
      current = null;
      continue;
    }
    const start = Number(row.start_sec);
    const end = Number(row.end_sec ?? (start + Number(row.duration_sec ?? 0)));
    const locationLabel = String(row.location ?? "").trim();
    if (!current || current.locationRefId !== forcedRefId) {
      if (current) spans.push(current);
      current = {
        code: "long_single_location_ref_coverage_span",
        severity: "blocker",
        locationRefId: forcedRefId,
        start,
        end,
        count: 1,
        firstVisualBeatId: row.visual_beat_id ?? row.scene_id ?? null,
        lastVisualBeatId: row.visual_beat_id ?? row.scene_id ?? null,
        distinctLocationLabels: new Set(),
      };
      addDistinctLocationLabel(current.distinctLocationLabels, locationLabel);
    } else {
      current.end = Math.max(current.end, end);
      current.count += 1;
      current.lastVisualBeatId = row.visual_beat_id ?? row.scene_id ?? current.lastVisualBeatId;
      addDistinctLocationLabel(current.distinctLocationLabels, locationLabel);
    }
  }
  if (current) spans.push(current);
  return spans
    .filter((span) => {
      const measuredStart = Math.max(span.start, retentionStartSec);
      if (span.end <= measuredStart) return false;
      const measured = span.end - measuredStart;
      const effectiveMax = Math.min(Number(maxSec) || 150, 120);
      return measured > effectiveMax && span.count >= 8 && span.distinctLocationLabels.size >= 2;
    })
    .map((span) => ({
      ...span,
      measured_after_retention_start_sec: Number((span.end - Math.max(span.start, retentionStartSec)).toFixed(3)),
      distinctLocationLabels: [...span.distinctLocationLabels],
      message: `Only one in-scope location ref (${span.locationRefId}) covers ${span.count} consecutive visual units across ${span.distinctLocationLabels.size} beat location labels for ${Number(span.end - Math.max(span.start, retentionStartSec)).toFixed(1)}s after 3:00. Split the semantic/ref plan into scene-scoped location refs or add approved in-scope sublocation targets before prompt authoring.`,
    }));
}

function assertScopedLocationCoverage(rows, visualReferencePlan) {
  if (allowLongLocationSpans) return [];
  const findings = scopedLocationCoverageFindings(rows, visualReferencePlan);
  if (findings.length) {
    throw new Error(`Visual prompt planning has insufficient location-ref coverage:\n${findings.slice(0, 20).map((finding) => (
      `${finding.locationRefId} ${finding.count} units ${finding.firstVisualBeatId}-${finding.lastVisualBeatId} ${Number(finding.start).toFixed(1)}s-${Number(finding.end).toFixed(1)}s (${Number(finding.measured_after_retention_start_sec).toFixed(1)}s after 3:00): ${finding.distinctLocationLabels.join(" | ")}`
    )).join("\n")}`);
  }
  return findings;
}

function scopedPlanFromRows(plan, rows, countField = "scene_count") {
  return {
    ...plan,
    scenes: rows,
    [countField]: rows.length,
  };
}

function scopedVisualBeatPlanFromRows(plan, rows) {
  if (plan?.status !== "passed") return null;
  return {
    ...plan,
    beats: rows,
    visual_beat_count: rows.length,
  };
}

function visualSourceContextAudit(rows, scopedLocationCoverage = []) {
  const total = rows.length;
  const countWith = (fn) => rows.filter(fn).length;
  const byValue = (field) => {
    const counts = {};
    for (const row of rows) {
      const value = row[field] ?? "missing";
      counts[value] = (counts[value] ?? 0) + 1;
    }
    return counts;
  };
  const cueCounts = {};
  for (const row of rows) {
    for (const cue of row.editorial_cues ?? []) cueCounts[cue] = (cueCounts[cue] ?? 0) + 1;
  }
  return {
    visual_unit_count: total,
    exact_excerpt_count: countWith((row) => String(row.visual_beat_script_excerpt ?? "").trim().length > 0),
    visual_job_count: countWith((row) => String(row.visual_job ?? "").trim().length > 0),
    suggested_shot_job_count: countWith((row) => String(row.suggested_shot_job ?? "").trim().length > 0),
    editorial_cue_beat_count: countWith((row) => Array.isArray(row.editorial_cues) && row.editorial_cues.length > 0),
    location_timeline_label_count: countWith((row) => String(row.location_timeline_label ?? "").trim().length > 0),
    quality_warning_beat_count: countWith((row) => Array.isArray(row.visual_beat_quality_findings) && row.visual_beat_quality_findings.length > 0),
    visual_job_counts: byValue("visual_job"),
    suggested_shot_job_counts: byValue("suggested_shot_job"),
    editorial_cue_counts: cueCounts,
    scoped_location_coverage_findings: scopedLocationCoverage,
    first_units: rows.slice(0, 12).map((row) => ({
      visual_beat_id: row.visual_beat_id ?? null,
      start_sec: row.start_sec ?? null,
      end_sec: row.end_sec ?? null,
      location: row.location ?? null,
      visual_job: row.visual_job ?? null,
      suggested_shot_job: row.suggested_shot_job ?? null,
      editorial_cues: row.editorial_cues ?? [],
      visual_beat_quality_findings: row.visual_beat_quality_findings ?? [],
      excerpt: String(row.visual_beat_script_excerpt ?? "").slice(0, 180),
    })),
  };
}

function indexCharacterStateRefs(artifact) {
  const refs = [];
  if (Array.isArray(artifact?.character_state_refs)) refs.push(...artifact.character_state_refs);
  if (Array.isArray(artifact?.states)) refs.push(...artifact.states);
  if (artifact?.characters && typeof artifact.characters === "object") {
    for (const [character, states] of Object.entries(artifact.characters)) {
      for (const state of Array.isArray(states) ? states : [states]) refs.push({ character, ...state });
    }
  }
  const index = new Map();
  for (const ref of refs.filter(Boolean)) {
    const character = ref.character ?? ref.character_name ?? ref.name;
    if (!character || !(ref.scene_prompt_anchor || ref.prompt_anchor)) continue;
    const sceneIds = Array.isArray(ref.scene_ids) && ref.scene_ids.length
      ? ref.scene_ids
      : [ref.scene_id ?? ref.scene ?? "*"];
    const normalized = {
      ...ref,
      character,
      scene_id: sceneIds[0] === "*" ? null : sceneIds[0],
      state_ref_id: ref.state_ref_id ?? ref.ref_id ?? `${normalizeLabel(character).replace(/\s+/g, "_")}_${sceneIds[0] ?? "global"}`,
      definitive: ref.definitive !== false,
      scene_prompt_anchor: scenePromptAnchorFromRef(ref),
      source: ref.source ?? "character_state_ref_artifact",
    };
    for (const sceneId of sceneIds) {
      index.set(`${sceneId}:${normalizeLabel(character)}`, { ...normalized, scene_id: sceneId === "*" ? null : sceneId });
      if (sceneId === "*") index.set(normalizeLabel(character), normalized);
    }
  }
  return index;
}

async function main() {
  const [timedPlan, semanticPlan, storyFactLedger, visualReferencePlan, referencePlanApproval, characterStateRefs, visualBeatPlan, runIdentity, locationContractLedger] = await Promise.all([
    readJson(timedPlanPath, null),
    readJson(semanticPlanPath, null),
    readJson(storyFactLedgerPath, null),
    readJson(visualReferencePlanPath, null),
    readJson(referencePlanApprovalPath, null),
    readJson(characterStateRefsPath, null),
    readJson(visualBeatPlanPath, null),
    readJson(runIdentityPath, null),
    readJson(locationContractLedgerPath, null),
  ]);
  const activeImageProvider = normalizeImageProvider(flags["image-provider"] ?? flags.provider ?? runIdentity?.image_provider ?? process.env.ANIFACTORY_IMAGE_PROVIDER ?? "modelslab");
  const activeImageProviderOptions = {
    ...(runIdentity?.image_provider_options ?? {}),
  };
  if (flags["codex-opening-sec"] != null || flags["codex-opening-duration-sec"] != null) {
    const value = Number(flags["codex-opening-sec"] ?? flags["codex-opening-duration-sec"]);
    if (Number.isFinite(value) && value > 0) activeImageProviderOptions.codex_opening_sec = value;
  }
  if (timedPlan?.status !== "passed" || !Array.isArray(timedPlan.scenes) || !timedPlan.scenes.length) throw new Error(`Missing passed timed scene plan: ${timedPlanPath}`);
  if (semanticPlan?.status !== "passed") throw new Error(`Missing passed semantic scene plan: ${semanticPlanPath}`);
  if (semanticPlan.source_script_hash !== timedPlan.source_script_hash) throw new Error("semantic_scene_plan and timed_scene_plan script hashes do not match.");
  if (runIdentity?.schema === "goldflow_run_identity_v2" && (storyFactLedger?.status !== "passed" || storyFactLedger.source_script_hash !== timedPlan.source_script_hash)) {
    throw new Error(`Visual prompt authoring requires current story_fact_ledger.json: ${storyFactLedgerPath}`);
  }
  if (!visualReferencePlan || visualReferencePlan.status !== "passed") throw new Error(`Missing passed visual reference plan: ${visualReferencePlanPath}`);
  if (runIdentity?.schema === "goldflow_run_identity_v2") {
    const referencePlanHash = await hashFile(visualReferencePlanPath);
    if (!referencePlanApprovalMatches({ approval: referencePlanApproval, plan: visualReferencePlan, fileSha256: referencePlanHash })) {
      throw new Error(`Visual prompt authoring requires current reference_plan_approval.json: ${referencePlanApprovalPath}`);
    }
  }
  const requiresLocationContractLedger = visualReferencePlan.reference_director_contract_version === "reference_director_v2";
  if (requiresLocationContractLedger && (locationContractLedger?.status !== "passed" || !Array.isArray(locationContractLedger?.contracts))) {
    throw new Error(`Missing passed location contract ledger for reference_director_v2: ${locationContractLedgerPath}`);
  }
  const allowDraftRefs = flags["allow-draft-refs"] === "true";
  if (!["approved", "passed"].includes(characterStateRefs?.status) && !allowDraftRefs) {
    throw new Error(`character_state_refs must be approved before visual planning. Current status: ${characterStateRefs?.status ?? "missing"}. Use --allow-draft-refs true only for diagnostics.`);
  }
  const enrichedVisualReferencePlan = await enrichVisualReferencePlan(visualReferencePlan);
  const correctionDirectives = await loadCorrectionDirectives(correctionFindingsPath);
  const stateRefIndex = indexCharacterStateRefs(characterStateRefs);
  const allVisualSourceRows = visualBeatPlan?.status === "passed" && Array.isArray(visualBeatPlan.beats) && visualBeatPlan.beats.length
    ? visualBeatPlan.beats
    : timedPlan.scenes;
  const visualSourceRows = filterVisualSourceRows(allVisualSourceRows, episode);
  if (!visualSourceRows.length) throw new Error("Visual planner small-batch filters selected zero visual units.");
  const scopedRepair = visualSourceRows.length !== allVisualSourceRows.length;
  const dryRunPrompt = flags["dry-run-prompt"] === "true";
  const basePromptPlan = scopedRepair && !dryRunPrompt ? await readJson(basePromptPlanPath, null) : null;
  if (scopedRepair && !dryRunPrompt && (!Array.isArray(basePromptPlan?.prompts) || basePromptPlan.prompts.length !== allVisualSourceRows.length)) {
    throw new Error(`Scoped visual planning requires a complete passed or blocked base prompt plan at ${basePromptPlanPath}.`);
  }
  const scopedLocationCoverage = allowLongLocationSpans
    ? []
    : scopedLocationCoverageFindings(visualSourceRows, enrichedVisualReferencePlan);
  const scopedTimedPlan = scopedPlanFromRows(timedPlan, visualSourceRows);
  const scopedVisualBeatPlan = visualBeatPlan?.status === "passed"
    ? scopedVisualBeatPlanFromRows(visualBeatPlan, visualSourceRows)
    : null;
  const stageName = `${episode}_visual_plan`;
  if (dryRunPrompt) {
    const useChunkingForDryRun = flags["visual-chunking"] !== "false"
      && visualSourceRows.length > Number(flags["visual-single-call-max-scenes"] ?? 4);
    const promptSizes = [];
    if (useChunkingForDryRun) {
      const sceneChunks = adaptivePromptChunks(visualSourceRows, enrichedVisualReferencePlan, stateRefIndex);
      for (let index = 0; index < sceneChunks.length; index += 1) {
        const chunkTimedPlan = { ...timedPlan, scenes: sceneChunks[index], scene_count: sceneChunks[index].length };
        const chunkVisualBeatPlan = visualBeatPlan?.status === "passed" ? { ...visualBeatPlan, beats: sceneChunks[index], visual_beat_count: sceneChunks[index].length } : null;
        const chunkPrompt = buildPrompt(chunkTimedPlan, semanticPlan, enrichedVisualReferencePlan, stateRefIndex, chunkVisualBeatPlan, correctionDirectives, activeImageProvider, activeImageProviderOptions, locationContractLedger, storyFactLedger);
        promptSizes.push({ chunk_index: index + 1, risk_class: sceneChunks[index].risk_class, target_chunk_size: sceneChunks[index].target_chunk_size, visual_unit_count: sceneChunks[index].length, prompt_chars: chunkPrompt.length });
      }
    } else {
      const prompt = buildPrompt(scopedTimedPlan, semanticPlan, enrichedVisualReferencePlan, stateRefIndex, scopedVisualBeatPlan, correctionDirectives, activeImageProvider, activeImageProviderOptions, locationContractLedger, storyFactLedger);
      promptSizes.push({ chunk_index: null, visual_unit_count: visualSourceRows.length, prompt_chars: prompt.length });
    }
    await writeJson(outputPath, {
      schema: "goldflow_section_image_prompts_v1",
      status: "dry_run",
      channel,
      series_slug: series,
      week,
      episode,
      visual_plan_scope: {
        mode: visualSourceRows.length === allVisualSourceRows.length ? "full_episode" : "small_batch",
        selected_visual_unit_count: visualSourceRows.length,
        total_visual_unit_count: allVisualSourceRows.length,
        cut_ids: visualSourceRows.map((row) => row.image_id_hint ?? `${episode}-cut-${String(Number(row.__visual_plan_absolute_index ?? 0) + 1).padStart(3, "0")}`),
      },
      image_provider: activeImageProvider,
      image_provider_options: activeImageProviderOptions,
      context_audit: visualSourceContextAudit(visualSourceRows, scopedLocationCoverage),
      prompt_sizes: promptSizes,
      updated_at: new Date().toISOString(),
    });
    console.log(JSON.stringify({ status: "dry_run", output_path: outputPath, prompt_sizes: promptSizes }, null, 2));
    return;
  }
  assertScopedLocationCoverage(visualSourceRows, enrichedVisualReferencePlan);
  if (flags["revalidate-existing"] === "true") {
    if (scopedRepair) throw new Error("Existing prompt-plan revalidation must validate the complete plan; omit scoped cut/scene flags.");
    const existingPlan = await readJson(outputPath, null);
    const prompts = existingPlan?.prompts;
    if (!Array.isArray(prompts) || prompts.length !== allVisualSourceRows.length) {
      throw new Error(`Existing prompt-plan revalidation requires ${allVisualSourceRows.length} prompts at ${outputPath}.`);
    }
    assertPromptIdentityMatchesInputs(prompts, allVisualSourceRows, episode, "visual prompt revalidation");
    assertScenePromptShape(prompts);
    assertLocalBeatFidelity(prompts, allVisualSourceRows);
    const activeStateFindings = activeStateConstraintFindings(prompts, allVisualSourceRows);
    const sourcePaths = [timedPlanPath, semanticPlanPath, visualReferencePlanPath, characterStateRefsPath];
    if (referencePlanApproval?.status === "approved") sourcePaths.push(referencePlanApprovalPath);
    if (storyFactLedger?.status === "passed") sourcePaths.push(storyFactLedgerPath);
    if (visualBeatPlan?.status === "passed") sourcePaths.push(visualBeatPlanPath);
    if (locationContractLedger?.status === "passed") sourcePaths.push(locationContractLedgerPath);
    const refreshed = {
      ...existingPlan,
      status: activeStateFindings.length ? "blocked" : "passed",
      source_artifact_paths: sourcePaths,
      source_hashes: Object.fromEntries((await Promise.all(sourcePaths.map(async (filePath) => [filePath, await hashFile(filePath)]))).filter(([, hash]) => hash)),
      planner: {
        ...(existingPlan.planner ?? {}),
        revalidated_without_llm: true,
        revalidated_at: new Date().toISOString(),
      },
      visual_plan_scope: {
        mode: "full_episode",
        selected_visual_unit_count: allVisualSourceRows.length,
        total_visual_unit_count: allVisualSourceRows.length,
        cut_ids: prompts.map((prompt) => prompt.image_id),
        untouched_prompt_count: prompts.length,
        revalidated_existing: true,
      },
      active_state_findings: activeStateFindings,
      findings: activeStateFindings,
      warnings: [
        ...(existingPlan.warnings ?? []),
        ...providerExclusionPayloadMarkerWarnings(prompts),
        ...assertShotFramingDistribution(prompts),
        ...assertPromptVariety(prompts),
        ...assertLocationSpanVariety(prompts),
        ...assertRetentionShotJobVarietySoft(prompts),
      ],
      updated_at: new Date().toISOString(),
    };
    await writeJson(outputPath, refreshed);
    if (activeStateFindings.length) {
      throw new Error(`Existing visual prompt plan contradicted binding active state on ${activeStateFindings.length} cut(s).`);
    }
    console.log(JSON.stringify({ status: "passed", output_path: outputPath, prompt_count: prompts.length, revalidated_without_llm: true }, null, 2));
    return;
  }
  let llm;
  let parsedPrompts = [];
  let styleSummary = "";
  let adaptiveChunkTelemetry = [];
  const useChunking = flags["visual-chunking"] !== "false"
    && visualSourceRows.length > Number(flags["visual-single-call-max-scenes"] ?? 4);
  if (useChunking) {
    const sceneChunks = adaptivePromptChunks(visualSourceRows, enrichedVisualReferencePlan, stateRefIndex);
    adaptiveChunkTelemetry = sceneChunks.map((chunk, index) => ({
      chunk_index: index + 1,
      risk_class: chunk.risk_class,
      target_chunk_size: chunk.target_chunk_size,
      visual_unit_count: chunk.length,
      beat_ids: chunk.map((row) => row.visual_beat_id ?? null).filter(Boolean),
    }));
    const chunkConcurrency = Math.max(1, Number(flags["visual-chunk-concurrency"] ?? 6));
    const chunkResults = await mapWithConcurrency(sceneChunks, chunkConcurrency, async (sceneChunk, index) => {
      const chunkTimedPlan = { ...timedPlan, scenes: sceneChunk, scene_count: sceneChunk.length };
      console.error(`visual chunk ${index + 1}/${sceneChunks.length}: ${sceneChunk.length} visual units, risk=${sceneChunk.risk_class}`);
      const chunkVisualBeatPlan = visualBeatPlan?.status === "passed" ? { ...visualBeatPlan, beats: sceneChunk, visual_beat_count: sceneChunk.length } : null;
      const chunkPrompt = buildPrompt(chunkTimedPlan, semanticPlan, enrichedVisualReferencePlan, stateRefIndex, chunkVisualBeatPlan, correctionDirectives, activeImageProvider, activeImageProviderOptions, locationContractLedger, storyFactLedger);
      const chunkStageName = `${stageName}_chunk_${String(index + 1).padStart(2, "0")}`;
      const expectedBeatIds = sceneChunk.map((unit) => String(unit.visual_beat_id ?? "")).filter(Boolean);
      const chunkLlm = isLocalLLMRoute(chunkStageName)
        ? await callLocal(chunkPrompt, chunkStageName, Number(flags["visual-chunk-max-tokens"] ?? 7000))
        : await callCodex(chunkPrompt, chunkStageName, expectedBeatIds);
      const chunkPrompts = Array.isArray(chunkLlm.parsed.prompts) ? chunkLlm.parsed.prompts : [];
      if (chunkPrompts.length !== sceneChunk.length) {
        throw new Error(`Visual chunk ${index + 1}/${sceneChunks.length} returned ${chunkPrompts.length} prompts for ${sceneChunk.length} visual units.`);
      }
      assertPromptIdentityMatchesInputs(chunkPrompts, sceneChunk, episode, `visual chunk ${index + 1}/${sceneChunks.length}`);
      console.error(`visual chunk ${index + 1}/${sceneChunks.length}: accepted ${chunkPrompts.length} prompts`);
      return { chunkLlm, chunkPrompts };
    });
    const styleSummaries = [];
    for (const result of chunkResults) {
      parsedPrompts.push(...result.chunkPrompts);
      if (result.chunkLlm.parsed.style_summary) styleSummaries.push(result.chunkLlm.parsed.style_summary);
    }
    styleSummary = styleSummaries.filter(Boolean)[0] ?? "";
    const firstChunkLlm = chunkResults[0]?.chunkLlm ?? null;
    llm = {
      provider: firstChunkLlm?.provider ?? (isLocalLLMRoute(stageName) ? "local-qwen" : "codex"),
      model: firstChunkLlm?.model ?? (isLocalLLMRoute(stageName) ? getLLMModel(stageName) : configuredCodexModel()),
      reasoning_effort: firstChunkLlm?.reasoning_effort ?? null,
      codex_cli_path: firstChunkLlm?.codex_cli_path ?? null,
      codex_cli_version: firstChunkLlm?.codex_cli_version ?? null,
      chunked: true,
      chunk_count: sceneChunks.length,
      chunk_concurrency: Math.min(sceneChunks.length, chunkConcurrency),
      parsed: { prompts: parsedPrompts, style_summary: styleSummary, warnings: [] },
    };
  } else {
    const prompt = buildPrompt(scopedTimedPlan, semanticPlan, enrichedVisualReferencePlan, stateRefIndex, scopedVisualBeatPlan, correctionDirectives, activeImageProvider, activeImageProviderOptions, locationContractLedger, storyFactLedger);
    llm = isLocalLLMRoute(stageName) ? await callLocal(prompt, stageName) : await callCodex(prompt, stageName);
    parsedPrompts = Array.isArray(llm.parsed.prompts) ? llm.parsed.prompts : [];
    styleSummary = llm.parsed.style_summary ?? "";
  }
  const scopedPrompts = parsedPrompts
    .map((row, index) => normalizePrompt(row, index, episode, visualSourceRows[index] ?? null, {
      visualReferencePlan: enrichedVisualReferencePlan,
      stateRefIndex,
      activeImageProvider,
      activeImageProviderOptions,
    }));
  const empty = scopedPrompts.filter((row) => !row.image_prompt);
  if (!scopedPrompts.length || empty.length) throw new Error(`Visual planner returned ${scopedPrompts.length} prompts with ${empty.length} empty prompts.`);
  assertScenePromptShape(scopedPrompts);
  assertLocalBeatFidelity(scopedPrompts, visualSourceRows);
  const scopedImageIds = scopedPrompts.map((prompt) => prompt.image_id);
  let prompts = scopedPrompts;
  if (scopedRepair) {
    prompts = mergeScopedPromptReplacements(basePromptPlan.prompts, scopedPrompts, { image_ids: scopedImageIds });
  }
  const providerExclusionPayloadWarnings = providerExclusionPayloadMarkerWarnings(prompts);
  const activeStateFindings = activeStateConstraintFindings(prompts, allVisualSourceRows);
  const shotFramingWarnings = assertShotFramingDistribution(prompts);
  const promptVarietyWarnings = assertPromptVariety(prompts);
  const locationSpanWarnings = assertLocationSpanVariety(prompts);
  const retentionShotJobWarnings = assertRetentionShotJobVarietySoft(prompts);
  const expectedPromptCount = allVisualSourceRows.length;
  if (prompts.length !== expectedPromptCount) throw new Error(`Visual planner returned ${prompts.length} prompts for ${expectedPromptCount} visual units.`);
  const duplicateImageIds = [...new Set(prompts.map((prompt) => prompt.image_id).filter((imageId, index, all) => all.indexOf(imageId) !== index))];
  if (duplicateImageIds.length) throw new Error(`Visual planner produced duplicate image ids: ${duplicateImageIds.slice(0, 20).join(", ")}`);
  const timedSceneIds = new Set(allVisualSourceRows.map((scene) => scene.scene_id));
  const missingSceneIds = [...timedSceneIds].filter((sceneId) => sceneId && !prompts.some((prompt) => prompt.scene_id === sceneId));
  if (missingSceneIds.length) throw new Error(`Visual planner missed timed scene ids: ${missingSceneIds.slice(0, 20).join(", ")}`);
  const missingBeatIds = visualBeatPlan?.status === "passed"
    ? allVisualSourceRows.map((beat) => beat.visual_beat_id).filter((beatId) => beatId && !prompts.some((prompt) => prompt.visual_beat_id === beatId))
    : [];
  if (missingBeatIds.length) throw new Error(`Visual planner missed visual beat ids: ${missingBeatIds.slice(0, 20).join(", ")}`);
  const sourcePaths = [timedPlanPath, semanticPlanPath, visualReferencePlanPath, characterStateRefsPath];
  if (referencePlanApproval?.status === "approved") sourcePaths.push(referencePlanApprovalPath);
  if (storyFactLedger?.status === "passed") sourcePaths.push(storyFactLedgerPath);
  if (visualBeatPlan?.status === "passed") sourcePaths.push(visualBeatPlanPath);
  if (locationContractLedger?.status === "passed") sourcePaths.push(locationContractLedgerPath);
  const report = {
    schema: "goldflow_section_image_prompts_v1",
    status: activeStateFindings.length ? "blocked" : "passed",
    channel,
    series_slug: series,
    week,
    episode,
    source_script_hash: timedPlan.source_script_hash,
    source_artifact_paths: sourcePaths,
    source_hashes: Object.fromEntries((await Promise.all(sourcePaths.map(async (filePath) => [filePath, await hashFile(filePath)]))).filter(([, hash]) => hash)),
    planner: {
      provider: llm.provider,
      model: llm.model ?? null,
      reasoning_effort: llm.reasoning_effort ?? null,
      codex_cli_path: llm.codex_cli_path ?? null,
      codex_cli_version: llm.codex_cli_version ?? null,
      output_path: llm.output_path ?? null,
      chunked: llm.chunked ?? false,
      chunk_count: llm.chunk_count ?? null,
      adaptive_chunks: adaptiveChunkTelemetry,
    },
    style_summary: styleSummary,
    prompt_policy: "shot_manifest-authoritative provider-aware prompt packets; the LLM authors one active provider_prompt and deterministic compatibility fields are derived without changing depicted content",
    image_provider: activeImageProvider,
    image_provider_options: activeImageProviderOptions,
    run_identity_path: runIdentityPath,
    location_contract_ledger_path: locationContractLedger?.status === "passed" ? locationContractLedgerPath : null,
    visual_plan_scope: {
      mode: visualSourceRows.length === allVisualSourceRows.length ? "full_episode" : "small_batch",
      selected_visual_unit_count: visualSourceRows.length,
      total_visual_unit_count: allVisualSourceRows.length,
      cut_ids: scopedImageIds,
      untouched_prompt_count: scopedRepair ? allVisualSourceRows.length - visualSourceRows.length : 0,
      base_prompt_plan_path: scopedRepair ? basePromptPlanPath : null,
    },
    prompts,
    active_state_findings: activeStateFindings,
    findings: activeStateFindings,
    warnings: [
      ...(llm.parsed.warnings ?? []),
      ...providerExclusionPayloadWarnings,
      ...shotFramingWarnings,
      ...promptVarietyWarnings,
      ...locationSpanWarnings,
      ...retentionShotJobWarnings,
    ],
    updated_at: new Date().toISOString(),
  };
  await writeJson(outputPath, report);
  if (activeStateFindings.length) {
    throw new Error(`Visual prompt authoring contradicted binding active state on ${activeStateFindings.length} cut(s): ${activeStateFindings.slice(0, 12).map((finding) => `${finding.image_id}:${finding.entity_id}:${finding.field}`).join(", ")}`);
  }
  console.log(JSON.stringify({ status: "passed", output_path: outputPath, prompt_count: prompts.length, scoped_repair_count: scopedRepair ? scopedPrompts.length : 0 }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (error) => {
    const existing = await readJson(outputPath, null);
    if (existing?.status !== "blocked" || !Array.isArray(existing?.prompts)) {
      await writeJson(outputPath, { schema: "goldflow_section_image_prompts_v1", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() }).catch(() => {});
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
