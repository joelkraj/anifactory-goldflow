#!/usr/bin/env node

import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  PIPELINE_STAGE_REGISTRY,
  PIPELINE_STAGE_REGISTRY_VERSION,
  buildStageCommand,
  stageDefinition,
  stageIsSatisfied,
} from "./lib/pipeline-stage-registry.mjs";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const CURRENT_VISUAL_BEAT_CONTRACT_VERSION = "visual_beat_editorial_v3";
const LEGACY_VISUAL_BEAT_CONTRACT_VERSION = "visual_beat_ref_strategy_v2";
const DEFAULT_TARGET_WPM_MIN = 195;
const DEFAULT_TARGET_WPM_MAX = 220;
const DEFAULT_TARGET_WPM_MID = 208;
const DEFAULT_QWEN_NARRATOR_VOICE_ID = "joel_owned_narrator_clone";
const DEFAULT_QWEN_NATIVE_SPEED = 1.25;
const MANUAL_BLOCKER_TRIAGE_POLICY = {
  mode: "agent_review_first",
  summary: "For any blocked or missing gate, the active agent must inspect the blocker evidence and choose the narrowest valid recovery: manual structured repair, scoped rerun, recorded waiver/bypass with evidence, or operator hold.",
  artifact_pattern: "manual_blocker_triage_<stage>_<episode>.json or a stage-specific manual triage artifact",
  guardrails: [
    "Do not skip upstream approvals or missing production assets.",
    "Do not rewrite approved creative content through deterministic code.",
    "Record manual waivers/bypasses with cut/stage evidence and rerun run status after the repair.",
  ],
};

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

async function exists(filePath) {
  if (!filePath) return false;
  return fs.stat(filePath).then((stat) => stat.isFile() || stat.isDirectory()).catch(() => false);
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function fileMtimeMs(filePath) {
  const stat = await fs.stat(filePath).catch(() => null);
  return stat?.mtimeMs ?? 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileSha256(filePath) {
  try {
    return sha256(await fs.readFile(filePath));
  } catch {
    return null;
  }
}

async function listFiles(dirPath) {
  try {
    return await fs.readdir(dirPath);
  } catch {
    return [];
  }
}

async function latestMatching(dirPath, pattern) {
  const names = await listFiles(dirPath);
  const matches = [];
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const filePath = path.join(dirPath, name);
    const stat = await fs.stat(filePath).catch(() => null);
    if (stat?.isFile()) matches.push({ name, filePath, mtimeMs: stat.mtimeMs });
  }
  matches.sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));
  return matches[0] ?? null;
}

function requiredFlag(name, value) {
  if (!value) throw new Error(`Missing required --${name}. Pass --episode-dir, or pass --channel --week --episode.`);
}

function normalizeAudioTarget(value) {
  const normalized = String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!normalized || ["narrator", "narration", "narrator_only", "narration_only", "voice_only"].includes(normalized)) return "narrator_only";
  return normalized;
}

function normalizeImageProvider(value) {
  const normalized = String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (["codex", "codex_imagen", "codex_imagegen", "openai", "openai_imagegen", "gpt_image"].includes(normalized)) return "codex_imagegen";
  if ([
    "hybrid",
    "hybrid_codex_refs_multichar",
    "hybrid_codex_references_multichar",
    "codex_refs_multichar",
    "codex_refs_multichar_modelslab_simple",
    "codex_references_multichar_modelslab_simple",
  ].includes(normalized)) return "hybrid_codex_refs_multichar";
  if ([
    "hybrid_codex_opening_modelslab_rest",
    "hybrid_codex_first20_modelslab_rest",
    "hybrid_codex_first_20_modelslab_rest",
    "codex_first20_modelslab_rest",
    "codex_opening_modelslab_rest",
  ].includes(normalized)) return "hybrid_codex_opening_modelslab_rest";
  if ([
    "hybrid_codex_refs_opening_risky_modelslab_rest",
    "hybrid_codex_refs_first10_risky_modelslab_rest",
    "hybrid_codex_references_opening_risky_modelslab_rest",
    "codex_refs_opening_risky_modelslab_rest",
    "codex_refs_first10_risky_modelslab_rest",
    "codex_references_opening_risky_modelslab_rest",
  ].includes(normalized)) return "hybrid_codex_refs_opening_risky_modelslab_rest";
  if ([
    "hybrid_modelslab_refs_codex_opening_modelslab_rest",
    "modelslab_refs_codex_opening_modelslab_rest",
    "modelslab_references_codex_opening_modelslab_rest",
    "modelslab_refs_codex_first5_modelslab_rest",
    "modelslab_refs_codex_first_5_modelslab_rest",
    "codex_first5_modelslab_rest_modelslab_refs",
  ].includes(normalized)) return "hybrid_modelslab_refs_codex_opening_modelslab_rest";
  return "modelslab";
}

function isNarratorOnlyAudio(identity) {
  return normalizeAudioTarget(identity.audio_target) === "narrator_only";
}

function codexOpeningSec(identity) {
  const value = Number(identity?.image_provider_options?.codex_opening_sec ?? identity?.codex_opening_sec ?? 120);
  return Number.isFinite(value) && value > 0 ? value : 120;
}

function imagegenOpeningFlag(identity) {
  const provider = normalizeImageProvider(identity?.image_provider ?? "modelslab");
  return provider === "hybrid_codex_opening_modelslab_rest"
    || provider === "hybrid_codex_refs_opening_risky_modelslab_rest"
    || provider === "hybrid_modelslab_refs_codex_opening_modelslab_rest" ? ` --codex-opening-sec ${codexOpeningSec(identity)}` : "";
}

function usesCodexReferences(identity) {
  const provider = normalizeImageProvider(identity?.image_provider ?? "modelslab");
  return provider === "codex_imagegen"
    || provider === "hybrid_codex_refs_multichar"
    || provider === "hybrid_codex_opening_modelslab_rest"
    || provider === "hybrid_codex_refs_opening_risky_modelslab_rest";
}

function usesCodexSceneCuts(identity) {
  const provider = normalizeImageProvider(identity?.image_provider ?? "modelslab");
  return provider === "codex_imagegen"
    || provider === "hybrid_codex_refs_multichar"
    || provider === "hybrid_codex_opening_modelslab_rest"
    || provider === "hybrid_codex_refs_opening_risky_modelslab_rest"
    || provider === "hybrid_modelslab_refs_codex_opening_modelslab_rest";
}

function paceDiagnosticOnly(identity) {
  return String(identity?.pace_policy ?? "").toLowerCase() === "diagnostic";
}

function imageOutputQaRequired(identity = {}) {
  return identity.image_output_qa_required === true
    || identity.production_gates?.image_output_qa_required_before_render === true;
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function targetWpmMin(identity = {}) {
  return numberOr(identity.target_wpm_min ?? identity.pace_targets?.target_wpm_min ?? identity.pace_targets?.min, DEFAULT_TARGET_WPM_MIN);
}

function targetWpmMax(identity = {}) {
  return numberOr(identity.target_wpm_max ?? identity.pace_targets?.target_wpm_max ?? identity.pace_targets?.max, DEFAULT_TARGET_WPM_MAX);
}

function targetWpmMid(identity = {}) {
  return numberOr(
    identity.target_wpm_midpoint ?? identity.pace_targets?.target_wpm_midpoint ?? identity.pace_targets?.mid,
    Number(((targetWpmMin(identity) + targetWpmMax(identity)) / 2).toFixed(3)) || DEFAULT_TARGET_WPM_MID,
  );
}

function targetWpmRange(identity = {}) {
  return `${targetWpmMin(identity)}-${targetWpmMax(identity)}`;
}

function lockedQwenNativeSpeed(identity = {}) {
  const raw = identity?.voice_provider_options?.qwen_native_speed ?? identity?.qwen_native_speed;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function qwenNativeSpeed(identity = {}) {
  return lockedQwenNativeSpeed(identity) ?? DEFAULT_QWEN_NATIVE_SPEED;
}

function renderCommand(identity, base, episode) {
  const smooth = String(identity?.render_profile ?? "").toLowerCase() === "smooth_fast_ken_burns";
  const common = `node bin/goldflow.mjs render start ${base} --prompts <episode-dir>/section_image_prompts_hardened.json --audio-bed-report <episode-dir>/<final-longform-audio-report>.json --transition-plan <episode-dir>/transition_edit_plan_${episode}.json --hook-xfade true --hook-xfade-duration-sec 0.28 --retention-xfade-sec 180`;
  if (smooth) {
    return `${common} --motion smooth_fast_ken_burns --motion-strength 1.75 --render-concurrency 4 --clip-preset veryfast --final-preset veryfast`;
  }
  return [
    `${common} --motion fill_ken_burns --motion-strength 1.75 --render-scale-multiplier 1.45 --render-concurrency 4 --clip-preset veryfast --final-preset veryfast`,
    `${common} --motion smooth_fast_ken_burns --motion-strength 1.75 --render-concurrency 4 --clip-preset veryfast --final-preset veryfast --output <episode-dir>/assets/renders/<title>-smooth-fast.mp4 --report-output <episode-dir>/render_report_${episode}-smooth-fast.json`,
  ].join("; optional A/B smoother sibling without overwriting premium: ");
}

function commandBase(identity) {
  const channel = identity.channel ?? "<channel>";
  const series = identity.series_slug ?? "<series>";
  const week = identity.week ?? "<week>";
  const episode = identity.episode ?? "<episode>";
  return `--channel ${channel} --series ${series} --week ${week} --episode ${episode}`;
}

function visualRefsApproveCommand(identity) {
  return `node bin/goldflow.mjs visual approve-refs ${commandBase(identity)} --note "<reference review notes>"`;
}

function imagegenStartCommand(identity, extra = "") {
  const provider = normalizeImageProvider(identity?.image_provider ?? "modelslab");
  return `node bin/goldflow.mjs imagegen start ${commandBase(identity)}${imagegenOpeningFlag(identity)} --image-provider ${provider} --prompts <episode-dir>/section_image_prompts_hardened.json --concurrency 15 --reference-concurrency 15${extra}`;
}

function imagegenPromoteDerivedRefsCommand(identity) {
  return `node bin/goldflow.mjs imagegen promote-derived-refs ${commandBase(identity)} --prompts <episode-dir>/section_image_prompts_hardened.json`;
}

function commandFor(stage, identity) {
  return buildStageCommand(stage, identity);
}

function inferredState(validation = {}) {
  if (validation.state) return validation.state;
  if (validation.done) return "passed";
  const evidence = String(validation.evidence ?? "").toLowerCase();
  if (evidence.includes("stale")) return "stale";
  if (evidence.includes("blocked") || evidence.includes("deadletter")) return "blocked";
  if (evidence.includes("failed") || evidence.includes("invalid")) return "failed";
  return "missing";
}

function stage(stageId, validation, identity, nextCommandOverride = null) {
  const definition = stageDefinition(stageId);
  if (!definition) throw new Error(`Stage ${stageId} is missing from the pipeline registry.`);
  const state = inferredState(validation);
  return {
    stage: stageId,
    title: definition.title,
    state,
    required_input: definition.required_input,
    output_artifact: definition.output_artifact,
    operator_approval_required: definition.approval !== "automatic",
    approval_policy: definition.approval,
    validator: definition.validator,
    exists: stageIsSatisfied(state),
    evidence: validation.evidence ?? null,
    next_command_shape: stageIsSatisfied(state) ? null : nextCommandOverride ?? validation.next_command_shape ?? commandFor(stageId, identity),
  };
}

async function visualPromptPlanReviewHardenCommand(episodeDir, identity) {
  const channel = identity.channel ?? "<channel>";
  const series = identity.series_slug ?? "<series>";
  const week = identity.week ?? "<week>";
  const episode = identity.episode ?? "<episode>";
  const base = `--channel ${channel} --series ${series} --week ${week} --episode ${episode}`;
  const planCommand = commandFor("visual_prompt_plan", identity);
  const promptPlan = await readJson(path.join(episodeDir, "section_image_prompts.json"), null);
  if (promptPlan?.status !== "passed" || !Array.isArray(promptPlan.prompts) || !promptPlan.prompts.length) return planCommand;
  const reviewedPlanPath = path.join(episodeDir, "section_image_prompts_reviewed.json");
  const hardenedPlanPath = path.join(episodeDir, "section_image_prompts_hardened.json");
  const hardenReportPath = path.join(episodeDir, `visual_prompt_hardening_${episode}.json`);
  const reviewedPlan = await readJson(reviewedPlanPath, null);
  const hardenedPlan = await readJson(hardenedPlanPath, null);
  const hardenReport = await readJson(hardenReportPath, null);
  const reviewedStatus = String(reviewedPlan?.status ?? "").toLowerCase();
  const hardenStatus = String(hardenReport?.status ?? "").toLowerCase();
  const manualReviewPath = reviewedPlan?.visual_manual_agent_review_path ?? path.join(episodeDir, `visual_manual_agent_review_${episode}.json`);
  const blockerReviewCommand = `node bin/goldflow.mjs visual review ${base} --prompts <episode-dir>/section_image_prompts.json --blockers-only true --auto-resolve true --max-resolve-iterations 2 --harden-report <episode-dir>/visual_prompt_hardening_${episode}.json`;
  const scopedReviewCommand = `node bin/goldflow.mjs visual review ${base} --resume-blocked true --auto-resolve true --max-resolve-iterations 2`;
  const hardenOriginalCommand = `node bin/goldflow.mjs visual harden ${base} --prompts <episode-dir>/section_image_prompts.json`;
  const hardenReviewedCommand = `node bin/goldflow.mjs visual harden ${base} --prompts <episode-dir>/section_image_prompts_reviewed.json`;
  if (hardenedPlan?.status === "passed" && Array.isArray(hardenedPlan.prompts) && hardenedPlan.prompts.length) {
    return hardenOriginalCommand;
  }
  if (reviewedStatus === "needs_manual_agent_review") {
    return `Manual agent review required: inspect ${manualReviewPath}; then patch detector/review logic or run a scoped visual review/replan for the listed cut ids before rerunning run status.`;
  }
  if (["blocked", "blocked_deadletter"].includes(reviewedStatus)) {
    return scopedReviewCommand;
  }
  if (reviewedStatus === "passed") {
    const [reviewedMtime, hardenMtime] = await Promise.all([
      fileMtimeMs(reviewedPlanPath),
      fileMtimeMs(hardenReportPath),
    ]);
    if (reviewedMtime > hardenMtime || !hardenStatus) return hardenReviewedCommand;
  }
  if (hardenStatus === "blocked") return blockerReviewCommand;
  return hardenOriginalCommand;
}

function isDerivedReferenceTarget(target) {
  return /^derive_from_/i.test(String(target?.generation_mode ?? ""));
}

function referencePathValue(target) {
  return target?.conditioning_image_path ?? target?.reference_image_path ?? target?.required_reference_path ?? target?.path ?? null;
}

function promptStartSec(prompt) {
  const value = Number(prompt?.start_sec ?? prompt?.start ?? prompt?.timestamp_sec ?? 0);
  return Number.isFinite(value) ? value : 0;
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
  return /\b(?:close[- ]?up|portrait|reaction|hand|phone|screen|panel|ui|sword|weapon|document|letter|book|cup|mug|tabletop|object insert|prop insert)\b/i.test(text);
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
  const rows = [
    ...prompts.filter((prompt) => promptMentionsRef(prompt, target.ref_id)),
    ...prompts.filter((prompt) => sceneIds.has(String(prompt.scene_id ?? "")) || sceneIds.has(String(prompt.parent_scene_id ?? ""))),
  ].filter((prompt) => prompt?.image_id)
    .filter((prompt) => promptIsCleanLocationSeed(prompt, target))
    .sort((left, right) => promptStartSec(left) - promptStartSec(right) || String(left.image_id).localeCompare(String(right.image_id), undefined, { numeric: true }))
    .map((prompt) => String(prompt.image_id));
  return [...new Set(rows)];
}

function successfulImageIdsFromReport(report) {
  const ids = new Set();
  for (const row of report?.results ?? []) {
    const status = String(row?.status ?? "").toLowerCase();
    if (!row?.image_id || status === "failed" || !row.image_path) continue;
    ids.add(String(row.image_id));
  }
  return ids;
}

function failedImageIdsFromReport(report) {
  return [...new Set((report?.results ?? [])
    .filter((row) => row?.image_id && String(row.status ?? "").toLowerCase() === "failed")
    .map((row) => String(row.image_id)))];
}

async function derivedReferenceImagegenStatus(episodeDir, promptPlan, latestImageReport, identity) {
  const visualReferencePlan = await readJson(path.join(episodeDir, "visual_reference_plan.json"), null);
  const targets = [];
  for (const target of visualReferencePlan?.reference_targets ?? []) {
    if (!target?.ref_id || !isDerivedReferenceTarget(target)) continue;
    const refPath = referencePathValue(target);
    if (refPath && await exists(refPath)) continue;
    targets.push({ ...target, candidate_image_ids: candidateImageIdsForDerivedTarget(target, promptPlan) });
  }
  if (!targets.length) return null;
  const successIds = successfulImageIdsFromReport(latestImageReport);
  const promotable = targets.filter((target) => (target.candidate_image_ids ?? []).some((id) => successIds.has(id)));
  if (promotable.length) {
    return {
      next_command_shape: imagegenPromoteDerivedRefsCommand(identity),
      evidence: `pending derived refs=${targets.length}; promotable=${promotable.map((target) => target.ref_id).slice(0, 6).join(", ")}${promotable.length > 6 ? ` +${promotable.length - 6} more` : ""}`,
    };
  }
  const seedIds = [...new Set(targets.flatMap((target) => target.candidate_image_ids ?? []))];
  if (seedIds.length) {
    return {
      next_command_shape: imagegenStartCommand(identity, ` --seed-derived-refs true --cut-ids ${seedIds.slice(0, 60).join(",")}`),
      evidence: `pending derived refs=${targets.length}; seed cuts needed=${seedIds.slice(0, 8).join(", ")}${seedIds.length > 8 ? ` +${seedIds.length - 8} more` : ""}`,
    };
  }
  return {
    next_command_shape: "Manual reference review required: derived reference targets have no candidate_image_ids and no scene-scoped prompt candidates.",
    evidence: `pending derived refs=${targets.length}; no candidate seed cuts found`,
  };
}

async function imageReportComplete(episodeDir, episode, identity) {
  const promptPlanPath = path.join(episodeDir, "section_image_prompts_hardened.json");
  const promptPlan = await readJson(promptPlanPath, null);
  const promptCount = Array.isArray(promptPlan) ? promptPlan.length : Array.isArray(promptPlan?.prompts) ? promptPlan.prompts.length : 0;
  const promptPlanHash = promptCount > 0 ? await fileSha256(promptPlanPath) : null;
  if (!promptCount || !promptPlanHash) {
    return { done: false, evidence: `image files=0/${promptCount || "unknown"}; section_image_prompts_hardened.json missing or empty` };
  }
  const names = await listFiles(episodeDir);
  const reports = [];
  for (const name of names.filter((item) => /^imagegen_report.*\.json$/.test(item))) {
    const filePath = path.join(episodeDir, name);
    const stat = await fs.stat(filePath).catch(() => null);
    const report = await readJson(filePath, null);
    if (!stat?.isFile() || !report) continue;
    reports.push({ name, filePath, report, mtimeMs: stat.mtimeMs });
  }
  reports.sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));
  async function duplicateSummary(report) {
    const byHash = new Map();
    for (const row of report.results ?? []) {
      if (!row?.image_id || !row.image_path || !(await exists(row.image_path))) continue;
      const hash = row.generated?.output_sha256 ?? await fileSha256(row.image_path);
      if (!hash) continue;
      const rows = byHash.get(hash) ?? [];
      rows.push(row.image_id);
      byHash.set(hash, rows);
    }
    return [...byHash.values()].filter((rows) => rows.length > 1).map((rows) => rows.join("="));
  }
  const latestReport = reports[0]?.report ?? null;
  const derivedStatus = await derivedReferenceImagegenStatus(episodeDir, promptPlan, latestReport, identity);
  if (derivedStatus) {
    return {
      done: false,
      evidence: derivedStatus.evidence,
      next_command_shape: derivedStatus.next_command_shape,
    };
  }
  const passed = reports.find(({ report }) => {
    const status = String(report.status ?? "").toLowerCase();
    const missing = Number(report.missing_image_count ?? report.missing_count ?? 0);
    const hashOk = report.prompt_plan_hash === promptPlanHash;
    const countOk = Number(report.expected_image_count ?? report.image_count ?? 0) >= promptCount
      && Number(report.image_count ?? 0) >= promptCount;
    return report.reference_only !== true && status === "passed" && missing === 0 && hashOk && countOk;
  });
  if (passed) {
    const duplicates = await duplicateSummary(passed.report);
    if (duplicates.length) {
      return {
        done: false,
        evidence: `${passed.name}; duplicate_hashes=${duplicates.slice(0, 4).join(", ")}${duplicates.length > 4 ? ` +${duplicates.length - 4} more` : ""}`,
      };
    }
    return { done: true, evidence: passed.name };
  }
  const imageDir = path.join(episodeDir, "assets", "images");
  const imageNames = await listFiles(imageDir);
  const generated = imageNames.filter((name) => new RegExp(`^${episode}-cut-.*\\.(png|jpe?g|webp)$`, "i").test(name)).length;
  const failedProbe = reports.find(({ report }) => String(report.status ?? "").toLowerCase() === "failed");
  const duplicates = latestReport ? await duplicateSummary(latestReport) : [];
  const failedIds = failedImageIdsFromReport(latestReport);
  if (failedIds.length) {
    return {
      done: false,
      evidence: `image files=${generated}/${promptCount || "unknown"}; failed cuts=${failedIds.slice(0, 8).join(", ")}${failedIds.length > 8 ? ` +${failedIds.length - 8} more` : ""}`,
      next_command_shape: imagegenStartCommand(identity, ` --cut-ids ${failedIds.join(",")}`),
    };
  }
  const successIds = successfulImageIdsFromReport(latestReport);
  const missingIds = (promptPlan.prompts ?? [])
    .filter((prompt) => prompt?.image_generation_required !== false)
    .map((prompt) => String(prompt.image_id ?? "").trim())
    .filter((id) => id && !successIds.has(id));
  if (missingIds.length && latestReport?.prompt_plan_hash === promptPlanHash) {
    return {
      done: false,
      evidence: `image files=${generated}/${promptCount || "unknown"}; missing cuts=${missingIds.slice(0, 8).join(", ")}${missingIds.length > 8 ? ` +${missingIds.length - 8} more` : ""}`,
      next_command_shape: imagegenStartCommand(identity, ` --cut-ids ${missingIds.join(",")}`),
    };
  }
  return {
    done: promptCount > 0 && generated >= promptCount && duplicates.length === 0,
    evidence: `image files=${generated}/${promptCount || "unknown"}${duplicates.length ? `; duplicate_hashes=${duplicates.slice(0, 4).join(", ")}${duplicates.length > 4 ? ` +${duplicates.length - 4} more` : ""}` : ""}${failedProbe ? `; failed probe/report also present: ${failedProbe.name}` : ""}`,
    next_command_shape: imagegenStartCommand(identity),
  };
}

async function referenceGenerationComplete(episodeDir, identity) {
  const planPath = path.join(episodeDir, "visual_reference_plan.json");
  const plan = await readJson(planPath, null);
  if (!plan) return { done: false, evidence: "visual_reference_plan.json missing" };
  const characterRefs = await readJson(path.join(episodeDir, "character_state_refs.json"), null);
  const characterStatus = String(characterRefs?.status ?? "").toLowerCase();
  const targets = Array.isArray(plan.reference_targets) ? plan.reference_targets : [];
  const required = targets.filter((target) => {
    const mode = String(target.generation_mode ?? "");
    return Boolean(target.required_before_imagegen)
      || mode === "standalone_ref"
      || mode === "manual_review";
  });
  const missing = [];
  const byHash = new Map();
  let present = 0;
  if (!required.length) {
    return {
      done: true,
      evidence: "required refs=0/0; no standalone reference images required",
    };
  }
  for (const target of required) {
    const targetPath = referencePathValue(target);
    if (targetPath && await exists(targetPath)) {
      present += 1;
      const hash = await fileSha256(targetPath);
      if (hash) {
        const rows = byHash.get(hash) ?? [];
        rows.push(target.ref_id ?? target.id ?? "unknown_ref");
        byHash.set(hash, rows);
      }
    } else {
      missing.push(target.ref_id ?? target.id ?? "unknown_ref");
    }
  }
  const duplicates = [...byHash.values()].filter((rows) => rows.length > 1);
  const duplicateSummary = duplicates.map((rows) => rows.join("="));
  return {
    done: required.length > 0 && missing.length === 0 && duplicates.length === 0,
    evidence: `required refs=${present}/${required.length}${missing.length ? `; missing=${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ` +${missing.length - 8} more` : ""}` : ""}${duplicates.length ? `; duplicate_hashes=${duplicateSummary.slice(0, 4).join(", ")}${duplicates.length > 4 ? ` +${duplicates.length - 4} more` : ""}` : ""}`,
  };
}

async function referenceImageApprovalComplete(episodeDir, episode) {
  const characterRefs = await readJson(path.join(episodeDir, "character_state_refs.json"), null);
  const approval = await readJson(path.join(episodeDir, `visual_reference_approval_${episode}.json`), null);
  const characterStatus = String(characterRefs?.status ?? "").toLowerCase();
  const approvalStatus = String(approval?.status ?? "").toLowerCase();
  const done = ["approved", "passed"].includes(characterStatus)
    && ["approved", "passed"].includes(approvalStatus);
  return {
    done,
    evidence: done
      ? `visual_reference_approval_${episode}.json status=${approvalStatus}`
      : `generated reference approval missing; character_state_refs status=${characterStatus || "missing"}`,
  };
}

async function longformMixComplete(episodeDir, episode) {
  const latest = await latestMatching(episodeDir, new RegExp(`^longform_audio_bed_report_${episode}.*\\.json$`));
  if (!latest) return { done: false, evidence: null };
  const report = await readJson(latest.filePath, {});
  const finalAudio = report.final_audio_path
    ?? report.final_m4a_path
    ?? report.output_m4a_path
    ?? report.output_path
    ?? report.mix?.m4a_path
    ?? report.mix?.wav_path;
  return {
    done: Boolean(finalAudio && await exists(finalAudio)),
    evidence: `${latest.name}${finalAudio ? ` -> ${finalAudio}` : ""}`,
  };
}

async function sourceHashState(sourceHashes = {}) {
  const entries = Object.entries(sourceHashes ?? {}).filter(([sourcePath, hash]) => sourcePath && hash);
  const stale = [];
  for (const [sourcePath, expectedHash] of entries) {
    const currentHash = await fileSha256(sourcePath);
    if (currentHash !== expectedHash) stale.push(sourcePath);
  }
  return { count: entries.length, stale };
}

async function renderComplete(episodeDir, episode, identity) {
  const latest = await latestMatching(episodeDir, new RegExp(`^render_report_${episode}.*\\.json$`));
  if (!latest) return { done: false, evidence: null };
  const report = await readJson(latest.filePath, {});
  const finalVideo = report.final_video_path ?? report.output_path ?? report.render_path;
  const status = String(report.status ?? "").toLowerCase();
  if (status !== "passed") return { done: false, state: status === "failed" ? "failed" : "blocked", evidence: `${latest.name} status=${status || "missing"}` };
  if (!finalVideo || !(await exists(finalVideo))) return { done: false, evidence: `${latest.name}; final video missing` };
  const expectedHash = report.final_video_sha256 ?? report.output_hash ?? null;
  const currentHash = await fileSha256(finalVideo);
  if (!expectedHash || currentHash !== expectedHash) {
    return { done: false, state: "stale", evidence: `${latest.name}; final video hash missing or stale` };
  }
  const sourceState = await sourceHashState(report.source_hashes);
  if (sourceState.stale.length) {
    return { done: false, state: "stale", evidence: `${latest.name}; stale render sources=${sourceState.stale.slice(0, 4).join(", ")}` };
  }
  if (identity.run_identity_schema === "goldflow_run_identity_v2" && sourceState.count === 0) {
    return { done: false, state: "stale", evidence: `${latest.name}; v2 render report has no source hashes` };
  }
  return {
    done: true,
    evidence: `${latest.name} -> ${finalVideo}; source_hashes=${sourceState.count}`,
  };
}

async function finalQaComplete(episodeDir, episode, identity) {
  const exactPath = path.join(episodeDir, `final_qa_${episode}.json`);
  const legacyLatest = identity.run_identity_schema === "goldflow_run_identity_v2"
    ? null
    : await latestMatching(episodeDir, /^final_qa_.*\.json$|^upload_qa_.*\.json$|^qa_report_.*\.json$/);
  const reportPath = await exists(exactPath) ? exactPath : legacyLatest?.filePath ?? null;
  if (!reportPath) return { done: false, evidence: `final_qa_${episode}.json missing` };
  const report = await readJson(reportPath, null);
  const status = String(report?.status ?? "").toLowerCase();
  if (identity.run_identity_schema !== "goldflow_run_identity_v2") {
    if (!status || ["passed", "approved", "complete", "completed"].includes(status)) {
      return { done: true, evidence: `${path.basename(reportPath)} legacy adapter` };
    }
    return { done: false, state: status === "failed" ? "failed" : "blocked", evidence: `${path.basename(reportPath)} status=${status}` };
  }
  if (status !== "passed") return { done: false, state: status === "failed" ? "failed" : "blocked", evidence: `${path.basename(reportPath)} status=${status || "missing"}` };
  const finalVideoPath = report.final_video_path;
  const finalVideoHash = finalVideoPath ? await fileSha256(finalVideoPath) : null;
  if (!finalVideoHash || finalVideoHash !== report.final_video_sha256) {
    return { done: false, state: "stale", evidence: `${path.basename(reportPath)} final video hash stale` };
  }
  const renderReportPath = report.render_report_path;
  const renderReportHash = renderReportPath ? await fileSha256(renderReportPath) : null;
  if (!renderReportHash || renderReportHash !== report.render_report_sha256) {
    return { done: false, state: "stale", evidence: `${path.basename(reportPath)} render report hash stale` };
  }
  if (Array.isArray(report.blockers) && report.blockers.length) {
    return { done: false, state: "blocked", evidence: `${path.basename(reportPath)} blockers=${report.blockers.join(",")}` };
  }
  return { done: true, evidence: `${path.basename(reportPath)} status=passed; hashes=current` };
}

async function imageOutputQaComplete(episodeDir, episode, identity) {
  if (!imageOutputQaRequired(identity)) return { done: true, evidence: "skipped for legacy run identity; new preflights require output QA" };
  const reportPath = path.join(episodeDir, `image_output_qa_${episode}.json`);
  const report = await readJson(reportPath, null);
  if (!report) return { done: false, evidence: `image_output_qa_${episode}.json missing` };
  const imagegenReportPath = path.join(episodeDir, `imagegen_report_${episode}.json`);
  const [qaMtime, imagegenMtime] = await Promise.all([fileMtimeMs(reportPath), fileMtimeMs(imagegenReportPath)]);
  if (imagegenMtime > qaMtime) {
    return {
      done: false,
      evidence: `${path.basename(reportPath)} is stale after newer image generation`,
      next_command_shape: commandFor("image_output_qa", identity),
    };
  }
  const status = String(report.status ?? "").toLowerCase();
  if (status === "passed" && identity.run_identity_schema === "goldflow_run_identity_v2") {
    const decisionsPath = report.review_decisions_path ?? path.join(episodeDir, `image_output_review_decisions_${episode}.json`);
    const decisions = await readJson(decisionsPath, null);
    const decisionsHash = await fileSha256(decisionsPath);
    const rows = Array.isArray(decisions?.decisions) ? decisions.decisions : [];
    const invalidDecision = rows.find((row) => String(row?.decision ?? "").toLowerCase() !== "accepted");
    if (!decisionsHash || decisionsHash !== report.review_decisions_sha256) {
      return { done: false, state: "stale", evidence: `${path.basename(reportPath)} review decisions hash stale`, next_command_shape: commandFor("image_output_qa", identity) };
    }
    if (String(decisions?.status ?? "").toLowerCase() !== "complete" || invalidDecision) {
      return { done: false, state: "blocked", evidence: `${path.basename(decisionsPath)} has unresolved per-cut decisions`, next_command_shape: commandFor("image_output_qa", identity) };
    }
  }
  if (status === "passed") return { done: true, evidence: `${path.basename(reportPath)} passed; risk_cuts=${report.risk_cut_count ?? "?"}` };
  return {
    done: false,
    evidence: `${path.basename(reportPath)} status=${status || "missing"}; blockers=${report.unresolved_blocker_count ?? "?"}`,
    next_command_shape: report.next_command ?? commandFor("image_output_qa", identity),
  };
}

async function scriptApprovalComplete(episodeDir, currentScriptHash) {
  if (!currentScriptHash) return { done: false, evidence: "script_clean.md missing" };
  const approvalPath = path.join(episodeDir, "operator_script_approval.json");
  const lockPath = path.join(episodeDir, "script_lock.json");
  const approval = await readJson(approvalPath, null);
  const lock = await readJson(lockPath, null);
  const approvalHash = approval?.script_clean_hash ?? approval?.script_hash ?? null;
  const lockHash = lock?.script_clean_hash ?? lock?.script_hash ?? null;
  const done = Boolean(approval?.operator_approved && approvalHash === currentScriptHash && lockHash === currentScriptHash);
  return {
    done,
    evidence: done ? `operator_script_approval.json -> ${currentScriptHash}` : `stale/missing approval for current script hash ${currentScriptHash}`,
  };
}

async function jsonArtifactHashComplete(filePath, currentScriptHash, label) {
  if (!currentScriptHash) return { done: false, evidence: "script_clean.md missing" };
  const artifact = await readJson(filePath, null);
  if (!artifact) return { done: false, evidence: `${label} missing` };
  const artifactHash = artifact.script_clean_hash
    ?? artifact.script_hash
    ?? artifact.source_script_hash
    ?? artifact.source_hash
    ?? null;
  const status = String(artifact.status ?? "").toLowerCase();
  const statusOk = !status || ["passed", "completed", "approved", "skipped", "draft_needs_manual_review"].includes(status);
  const done = artifactHash === currentScriptHash && statusOk;
  return {
    done,
    evidence: done
      ? `${label} -> ${currentScriptHash}${status ? `; status=${status}` : ""}`
      : `${label} ${status || "missing_status"} for hash ${artifactHash ?? "none"}; required hash ${currentScriptHash}`,
  };
}

async function paceReportComplete(filePath, currentScriptHash, label, identity = {}) {
  if (!currentScriptHash) return { done: false, evidence: "script_clean.md missing" };
  const report = await readJson(filePath, null);
  if (!report) return { done: false, evidence: `${label} missing` };
  const artifactHash = report.source_script_hash ?? report.script_clean_hash ?? report.script_hash ?? null;
  const min = Number(report.target_wpm_min);
  const max = Number(report.target_wpm_max);
  const requiredMin = targetWpmMin(identity);
  const requiredMax = targetWpmMax(identity);
  const requiredRange = targetWpmRange(identity);
  const status = String(report.status ?? "").toLowerCase();
  const hookWarnings = Array.isArray(report.hook_milestone_report?.warnings)
    ? report.hook_milestone_report.warnings
    : [];
  const hookGateEnforced = report.hook_gate_enforced !== false && report.allow_hook_warnings !== true;
  const scriptHookBlocked = label === "script_pace_report.json" && hookWarnings.length > 0 && hookGateEnforced;
  const sourceHashes = report.source_hashes && typeof report.source_hashes === "object" && !Array.isArray(report.source_hashes)
    ? report.source_hashes
    : null;
  const staleSource = sourceHashes
    ? (await Promise.all(Object.entries(sourceHashes).map(async ([sourcePath, expectedHash]) => {
      const actualHash = await fileSha256(sourcePath);
      return actualHash && expectedHash && actualHash !== expectedHash ? `${path.basename(sourcePath)} stale` : null;
    }))).filter(Boolean)[0] ?? null
    : null;
  const done = artifactHash === currentScriptHash && status === "passed" && min === requiredMin && max === requiredMax && !scriptHookBlocked && !staleSource;
  const wpm = Number.isFinite(Number(report.actual_wpm)) ? `; actual_wpm=${Number(report.actual_wpm).toFixed(3)}` : "";
  const hook = scriptHookBlocked ? `; hook_warnings=${hookWarnings.length}` : "";
  const sourceHashEvidence = sourceHashes ? (staleSource ? `; ${staleSource}` : "; source_hashes=current") : "; source_hashes=missing";
  return {
    done,
    evidence: done
      ? `${label} -> ${currentScriptHash}; target_wpm=${requiredRange}${wpm}${sourceHashEvidence}`
      : `${label} ${status || "missing"} for hash ${artifactHash ?? "none"} target ${Number.isFinite(min) ? min : "?"}-${Number.isFinite(max) ? max : "?"}; required hash ${currentScriptHash} target ${requiredRange}${wpm}${hook}${sourceHashEvidence}`,
  };
}

async function audioPaceRecoveryCommand(episodeDir, identity) {
  if (paceDiagnosticOnly(identity)) return null;
  const report = await readJson(path.join(episodeDir, `narration_pace_report_${identity.episode}.json`), null);
  const status = String(report?.status ?? "").toLowerCase();
  const actualWpm = Number(report?.actual_wpm);
  if (status !== "blocked" || !Number.isFinite(actualWpm) || actualWpm <= 0) return null;
  const currentSpeed = qwenNativeSpeed(identity);
  const target = targetWpmMid(identity);
  const recommendedSpeed = Math.max(0.75, Math.min(1.5, Number((currentSpeed * target / actualWpm).toFixed(3))));
  if (Math.abs(recommendedSpeed - currentSpeed) < 0.01) {
    return `Native Qwen speed ${currentSpeed} still produced ${actualWpm.toFixed(1)} WPM. Hold for operator choice of another approved TTS voice/model; post-tempo normalization is emergency-only.`;
  }
  return `Regenerate narration at provider-native speed, then rerun Whisper: node bin/goldflow.mjs tts qwen ${commandBase(identity)} --native-speed ${recommendedSpeed} --force true`;
}

async function whisperTimingComplete(episodeDir, episode, currentScriptHash) {
  if (!currentScriptHash) return { done: false, evidence: "script_clean.md missing" };
  const timingPath = path.join(episodeDir, `narration_word_timing_${episode}.json`);
  const stitchPath = path.join(episodeDir, `audio_stitch_report_${episode}-modelslab-qwen.json`);
  const timing = await readJson(timingPath, null);
  if (!timing) return { done: false, evidence: `narration_word_timing_${episode}.json missing` };
  const artifactHash = timing.source_script_hash ?? null;
  if (artifactHash !== currentScriptHash) {
    return { done: false, evidence: `narration_word_timing_${episode}.json hash ${artifactHash ?? "none"}; required hash ${currentScriptHash}` };
  }
  const stitch = await readJson(stitchPath, null);
  const currentAudioPath = stitch?.output_path ?? null;
  const currentAudioHash = currentAudioPath ? await fileSha256(currentAudioPath) : null;
  if (currentAudioHash && timing.narration_audio_hash !== currentAudioHash) {
    return {
      done: false,
      evidence: `narration_word_timing_${episode}.json stale audio hash ${timing.narration_audio_hash ?? "none"}; current audio hash ${currentAudioHash}`,
    };
  }
  return {
    done: String(timing.status ?? "").toLowerCase() === "passed",
    evidence: `narration_word_timing_${episode}.json -> ${currentScriptHash}; audio_hash=${timing.narration_audio_hash ?? "none"}`,
  };
}

function cleanOptionalId(value) {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function selectedQwenNarratorVoiceId(identity = {}) {
  return cleanOptionalId(flags["qwen-narrator-voice-id"])
    ?? cleanOptionalId(flags["narrator-voice-id"])
    ?? cleanOptionalId(identity?.voice_provider_options?.qwen_narrator_voice_id)
    ?? cleanOptionalId(identity?.qwen_narrator_voice_id)
    ?? cleanOptionalId(identity?.narrator_voice_id)
    ?? DEFAULT_QWEN_NARRATOR_VOICE_ID;
}

function narratorReferenceIdsFromPlan(plan) {
  const ids = new Set();
  for (const segment of plan?.segments ?? []) {
    for (const unit of segment?.qwen_generation_units ?? []) {
      const speaker = String(unit?.speaker ?? unit?.source_speaker ?? "NARRATOR").toUpperCase();
      const role = String(unit?.role ?? "").toLowerCase();
      if (!["NARRATOR", "MC_INTERNAL"].includes(speaker) && role !== "narrator") continue;
      const referenceId = cleanOptionalId(unit?.reference_id) ?? cleanOptionalId(unit?.voice_id);
      if (referenceId) ids.add(referenceId);
    }
  }
  return ids;
}

function voiceIdsFromTtsArtifacts(ttsReport, stitchReport) {
  const ids = new Set();
  for (const row of ttsReport?.results ?? []) {
    const voiceId = cleanOptionalId(row?.voice_id);
    if (voiceId) ids.add(voiceId);
  }
  for (const segment of stitchReport?.segments ?? []) {
    const voiceId = cleanOptionalId(segment?.voice_id);
    if (voiceId) ids.add(voiceId);
  }
  return ids;
}

async function qwenTtsStitchComplete(episodeDir, episode, currentScriptHash, identity) {
  if (!currentScriptHash) return { done: false, evidence: "script_clean.md missing" };
  const ttsReportPath = path.join(episodeDir, `modelslab_qwen_tts_report_${episode}.json`);
  const stitchReportPath = path.join(episodeDir, `audio_stitch_report_${episode}-modelslab-qwen.json`);
  const ttsReport = await readJson(ttsReportPath, null);
  if (!ttsReport) return { done: false, evidence: `modelslab_qwen_tts_report_${episode}.json missing` };
  const ttsStatus = String(ttsReport.status ?? "").toLowerCase();
  if (!["passed", "completed"].includes(ttsStatus)) {
    return { done: false, evidence: `modelslab_qwen_tts_report_${episode}.json status=${ttsStatus || "missing_status"}` };
  }
  const ttsHash = ttsReport.source_script_hash ?? ttsReport.script_hash ?? null;
  if (ttsHash && ttsHash !== currentScriptHash) {
    return { done: false, evidence: `modelslab_qwen_tts_report_${episode}.json hash ${ttsHash}; required hash ${currentScriptHash}` };
  }
  const stitchReport = await readJson(stitchReportPath, null);
  if (!stitchReport) return { done: false, evidence: `audio_stitch_report_${episode}-modelslab-qwen.json missing` };
  const stitchStatus = String(stitchReport.status ?? "").toLowerCase();
  if (!["passed", "completed"].includes(stitchStatus)) {
    return { done: false, evidence: `audio_stitch_report_${episode}-modelslab-qwen.json status=${stitchStatus || "missing_status"}` };
  }
  const stitchHash = stitchReport.source_script_hash ?? stitchReport.script_hash ?? null;
  if (stitchHash && stitchHash !== currentScriptHash) {
    return { done: false, evidence: `audio_stitch_report_${episode}-modelslab-qwen.json hash ${stitchHash}; required hash ${currentScriptHash}` };
  }
  if (isNarratorOnlyAudio(identity)) {
    const requiredVoiceId = selectedQwenNarratorVoiceId(identity);
    const voiceIds = voiceIdsFromTtsArtifacts(ttsReport, stitchReport);
    const staleVoiceIds = [...voiceIds].filter((voiceId) => voiceId !== requiredVoiceId);
    if (staleVoiceIds.length > 0) {
      return {
        done: false,
        evidence: `stitched Qwen narration voice_id=${staleVoiceIds.join(", ")}; required narrator voice ${requiredVoiceId}`,
      };
    }
  }
  const requiredNativeSpeed = lockedQwenNativeSpeed(identity);
  if (requiredNativeSpeed !== null) {
    const reportedNativeSpeed = Number(ttsReport?.native_speed ?? stitchReport?.native_speed);
    if (!Number.isFinite(reportedNativeSpeed) || Math.abs(reportedNativeSpeed - requiredNativeSpeed) > 0.001) {
      return {
        done: false,
        evidence: `stitched Qwen narration native_speed=${Number.isFinite(reportedNativeSpeed) ? reportedNativeSpeed : "missing"}; required ${requiredNativeSpeed}`,
      };
    }
    if (ttsReport?.post_tempo_normalized === true || stitchReport?.tempo_normalized === true || stitchReport?.post_tempo_normalized === true) {
      return { done: false, evidence: "stitched narration uses post tempo normalization; new runs require provider-native Qwen speed" };
    }
  }
  const outputPath = stitchReport.output_path ?? stitchReport.final_audio_path ?? stitchReport.final_wav_path ?? null;
  if (!outputPath) return { done: false, evidence: `audio_stitch_report_${episode}-modelslab-qwen.json missing output_path` };
  if (!(await exists(outputPath))) return { done: false, evidence: `stitched narration missing: ${outputPath}` };
  const duration = Number(stitchReport.final_duration_sec ?? stitchReport.duration_sec);
  return {
    done: true,
    evidence: `audio_stitch_report_${episode}-modelslab-qwen.json -> ${outputPath}${Number.isFinite(duration) ? `; duration=${duration.toFixed(3)}s` : ""}`,
  };
}

async function qwenVoicePlanComplete(episodeDir, currentScriptHash, identity) {
  const label = "qwen_generation_plan.json";
  const base = await jsonArtifactHashComplete(path.join(episodeDir, label), currentScriptHash, label);
  if (!base.done) return base;
  const plan = await readJson(path.join(episodeDir, label), null);
  if (isNarratorOnlyAudio(identity)) {
    const requiredVoiceId = selectedQwenNarratorVoiceId(identity);
    const narratorReferenceIds = narratorReferenceIdsFromPlan(plan);
    const staleReferenceIds = [...narratorReferenceIds].filter((voiceId) => voiceId !== requiredVoiceId);
    if (staleReferenceIds.length > 0) {
      return {
        done: false,
        evidence: `${label} narrator reference_id=${staleReferenceIds.join(", ")}; required narrator voice ${requiredVoiceId}`,
      };
    }
  }
  const overrides = await readJson(path.join(episodeDir, "tts_spoken_overrides.json"), null);
  const loadedOverrideCount = Array.isArray(overrides?.replacements) ? overrides.replacements.length : 0;
  const audit = plan?.tts_override_application_audit ?? null;
  if (loadedOverrideCount > 0 && !audit) {
    return {
      done: false,
      evidence: `${base.evidence}; missing tts_override_application_audit for ${loadedOverrideCount} loaded override(s)`,
    };
  }
  if (audit) {
    return {
      done: base.done,
      evidence: `${base.evidence}; tts_overrides applied=${audit.applied_rule_count ?? 0}/${audit.loaded_count ?? loadedOverrideCount}; unmatched=${audit.unmatched_rule_count ?? 0}`,
    };
  }
  return base;
}

async function jsonStatusComplete(filePath, label) {
  const artifact = await readJson(filePath, null);
  if (!artifact) return { done: false, evidence: `${label} missing` };
  const status = String(artifact.status ?? "").toLowerCase();
  const done = !["failed", "blocked", "blocked_deadletter", "failed_repairable", "needs_manual_agent_review"].includes(status);
  return { done, evidence: `${label}; status=${status || "missing_status"}` };
}

function statusAllowsDownstreamUse(status) {
  return !["failed", "blocked", "blocked_deadletter", "failed_repairable", "needs_manual_agent_review"].includes(String(status ?? "").toLowerCase());
}

async function sourceHashesCurrent(artifact) {
  const sourceHashes = artifact?.source_hashes && typeof artifact.source_hashes === "object" && !Array.isArray(artifact.source_hashes)
    ? artifact.source_hashes
    : null;
  if (!sourceHashes) return true;
  for (const [sourcePath, recordedHash] of Object.entries(sourceHashes)) {
    const currentHash = await fileSha256(sourcePath);
    if (!currentHash || currentHash !== recordedHash) return false;
  }
  return true;
}

function sortedJson(value) {
  if (Array.isArray(value)) return JSON.stringify([...value].sort());
  return JSON.stringify(value ?? null);
}

function characterStateRefsCompatible(dependentRefs, currentRefs) {
  const currentById = new Map((currentRefs ?? []).map((ref) => [ref.state_ref_id, ref]));
  for (const ref of dependentRefs ?? []) {
    const current = currentById.get(ref.state_ref_id);
    if (!current) return false;
    for (const key of ["character", "prompt_anchor", "scene_prompt_anchor", "source_ref_id", "base_identity_ref_id", "identity_usage"]) {
      if ((ref[key] ?? null) !== (current[key] ?? null)) return false;
    }
    if (sortedJson(ref.scene_ids) !== sortedJson(current.scene_ids)) return false;
  }
  return true;
}

function referencedIdsFromPromptPlan(artifact) {
  const ids = new Set();
  for (const prompt of artifact?.prompts ?? []) {
    for (const req of prompt.reference_requirements ?? []) {
      if (req?.ref_id) ids.add(req.ref_id);
    }
    const manifest = prompt.shot_manifest ?? {};
    if (manifest.location_ref_id) ids.add(manifest.location_ref_id);
    if (manifest.protagonist_state_ref_id) ids.add(manifest.protagonist_state_ref_id);
    for (const refId of manifest.character_state_ref_ids ?? []) {
      if (refId) ids.add(refId);
    }
  }
  return ids;
}

async function visualReferencePlanHashDriftIsVolatile(sourcePath, dependentArtifact) {
  if (path.basename(sourcePath) !== "visual_reference_plan.json") return false;
  const currentPlan = await readJson(sourcePath, null);
  if (!currentPlan || !statusAllowsDownstreamUse(currentPlan.status) || !(await sourceHashesCurrent(currentPlan))) return false;
  if (Array.isArray(dependentArtifact?.character_state_refs)) {
    return characterStateRefsCompatible(dependentArtifact.character_state_refs, currentPlan.character_state_refs ?? []);
  }
  if (Array.isArray(dependentArtifact?.prompts)) {
    const targetIds = new Set((currentPlan.reference_targets ?? []).map((target) => target.ref_id).filter(Boolean));
    for (const ref of currentPlan.character_state_refs ?? []) {
      if (ref.state_ref_id) targetIds.add(ref.state_ref_id);
      if (ref.source_ref_id) targetIds.add(ref.source_ref_id);
    }
    for (const refId of referencedIdsFromPromptPlan(dependentArtifact)) {
      if (!targetIds.has(refId)) return false;
    }
  }
  return true;
}

async function characterStateRefsHashDriftIsVolatile(sourcePath, dependentArtifact) {
  if (path.basename(sourcePath) !== "character_state_refs.json") return false;
  const currentRefs = await readJson(sourcePath, null);
  if (!currentRefs || !statusAllowsDownstreamUse(currentRefs.status)) return false;
  const sourceHashes = currentRefs.source_hashes && typeof currentRefs.source_hashes === "object" && !Array.isArray(currentRefs.source_hashes)
    ? currentRefs.source_hashes
    : null;
  if (sourceHashes) {
    for (const [currentSourcePath, recordedHash] of Object.entries(sourceHashes)) {
      const currentHash = await fileSha256(currentSourcePath);
      if (!currentHash) return false;
      if (currentHash !== recordedHash && !(await visualReferencePlanHashDriftIsVolatile(currentSourcePath, currentRefs))) return false;
    }
  }
  if (Array.isArray(dependentArtifact?.prompts)) {
    const currentIds = new Set();
    for (const ref of currentRefs.character_state_refs ?? []) {
      if (ref.state_ref_id) currentIds.add(ref.state_ref_id);
      if (ref.source_ref_id) currentIds.add(ref.source_ref_id);
      if (ref.base_identity_ref_id) currentIds.add(ref.base_identity_ref_id);
    }
    for (const sourcePath of Object.keys(sourceHashes ?? {})) {
      if (path.basename(sourcePath) !== "visual_reference_plan.json") continue;
      const visualPlan = await readJson(sourcePath, null);
      for (const target of visualPlan?.reference_targets ?? []) {
        if (target.ref_id) currentIds.add(target.ref_id);
      }
      for (const ref of visualPlan?.character_state_refs ?? []) {
        if (ref.state_ref_id) currentIds.add(ref.state_ref_id);
        if (ref.source_ref_id) currentIds.add(ref.source_ref_id);
        if (ref.base_identity_ref_id) currentIds.add(ref.base_identity_ref_id);
      }
    }
    for (const prompt of dependentArtifact.prompts ?? []) {
      const manifest = prompt.shot_manifest ?? {};
      const stateIds = [
        manifest.protagonist_state_ref_id,
        ...(manifest.character_state_ref_ids ?? []),
      ].filter(Boolean);
      for (const refId of stateIds) {
        if (!currentIds.has(refId)) return false;
      }
    }
  }
  return true;
}

async function jsonStatusWithSourceHashesComplete(filePath, label) {
  const artifact = await readJson(filePath, null);
  if (!artifact) return { done: false, evidence: `${label} missing` };
  const status = String(artifact.status ?? "").toLowerCase();
  if (!statusAllowsDownstreamUse(status)) {
    return { done: false, evidence: `${label}; status=${status || "missing_status"}` };
  }
  if (label === "visual_beat_plan.json") {
    const contractVersion = artifact.visual_beat_contract_version ?? artifact.planner_contract_version ?? null;
    if (![CURRENT_VISUAL_BEAT_CONTRACT_VERSION, LEGACY_VISUAL_BEAT_CONTRACT_VERSION].includes(contractVersion)) {
      return {
        done: false,
        evidence: `${label}; status=${status || "missing_status"}; stale planner_contract_version=${contractVersion ?? "missing"} required=${CURRENT_VISUAL_BEAT_CONTRACT_VERSION}`,
      };
    }
    const beats = Array.isArray(artifact.beats) ? artifact.beats : [];
    const missingRefNeeds = beats.filter((beat) => !Array.isArray(beat.ref_needs) && !Array.isArray(beat.beat_ref_requirements));
    if (beats.length && missingRefNeeds.length) {
      return {
        done: false,
        evidence: `${label}; status=${status || "missing_status"}; ${missingRefNeeds.length}/${beats.length} beats missing ref_needs contract`,
      };
    }
  }
  const sourceHashes = artifact.source_hashes && typeof artifact.source_hashes === "object" && !Array.isArray(artifact.source_hashes)
    ? artifact.source_hashes
    : null;
  if (!sourceHashes) return { done: true, evidence: `${label}; status=${status || "missing_status"}; source_hashes=missing` };
  const stale = [];
  const ignored = [];
  for (const [sourcePath, recordedHash] of Object.entries(sourceHashes)) {
    const currentHash = await fileSha256(sourcePath);
    if (!currentHash) {
      stale.push(`${path.basename(sourcePath)} missing`);
    } else if (currentHash !== recordedHash) {
      if (await visualReferencePlanHashDriftIsVolatile(sourcePath, artifact)) {
        ignored.push(`${path.basename(sourcePath)} reference_paths_updated`);
      } else if (await characterStateRefsHashDriftIsVolatile(sourcePath, artifact)) {
        ignored.push(`${path.basename(sourcePath)} reference_paths_updated`);
      } else {
        stale.push(`${path.basename(sourcePath)} stale`);
      }
    }
  }
  if (stale.length) {
    return { done: false, evidence: `${label}; status=${status || "missing_status"}; ${stale.slice(0, 4).join(", ")}` };
  }
  return {
    done: true,
    evidence: `${label}; status=${status || "missing_status"}; source_hashes=current${ignored.length ? `; ignored=${ignored.slice(0, 4).join(", ")}` : ""}`,
  };
}

async function visualReferencePlanComplete(episodeDir, currentScriptHash, identity) {
  const visualPlanPath = path.join(episodeDir, "visual_reference_plan.json");
  const inventoryLedgerPath = path.join(episodeDir, "reference_inventory_ledger.json");
  const characterRefsPath = path.join(episodeDir, "character_state_refs.json");
  const visual = await jsonStatusWithSourceHashesComplete(visualPlanPath, "visual_reference_plan.json");
  const visualPlan = await readJson(visualPlanPath, null);
  const inventoryPath = visualPlan?.reference_inventory_ledger_path ?? inventoryLedgerPath;
  const inventoryLedger = await readJson(inventoryPath, null);
  if (!inventoryLedger || inventoryLedger.status !== "passed" || !Array.isArray(inventoryLedger.assets)) {
    return {
      done: false,
      evidence: `${visual.evidence}; reference_inventory_ledger.json missing or invalid`,
    };
  }
  let directorLedgerEvidence = "";
  if (visualPlan?.reference_director_contract_version === "reference_director_v2") {
    const evidenceLedgerPath = visualPlan.reference_evidence_ledger_path ?? path.join(episodeDir, "reference_evidence_ledger.json");
    const locationContractLedgerPath = visualPlan.location_contract_ledger_path ?? path.join(episodeDir, "location_contract_ledger.json");
    const [evidenceLedger, locationContractLedger] = await Promise.all([
      readJson(evidenceLedgerPath, null),
      readJson(locationContractLedgerPath, null),
    ]);
    if (evidenceLedger?.status !== "passed" || !Array.isArray(evidenceLedger?.assets)) {
      return {
        done: false,
        evidence: `${visual.evidence}; reference_evidence_ledger.json missing or invalid for reference_director_v2`,
      };
    }
    if (locationContractLedger?.status !== "passed" || !Array.isArray(locationContractLedger?.contracts)) {
      return {
        done: false,
        evidence: `${visual.evidence}; location_contract_ledger.json missing, invalid, or blocked for reference_director_v2`,
      };
    }
    directorLedgerEvidence = `; evidence_assets=${evidenceLedger.assets.length}; location_contracts=${locationContractLedger.contracts.length}`;
  }
  const characterRefs = await readJson(characterRefsPath, null);
  if (!characterRefs) {
    return { done: false, evidence: `${visual.evidence}; character_state_refs.json missing` };
  }
  const characterStatus = String(characterRefs.status ?? "").toLowerCase();
  const statusOk = ["approved", "passed", "draft_needs_manual_review"].includes(characterStatus);
  const characterHash = characterRefs.source_script_hash ?? characterRefs.script_hash ?? characterRefs.script_clean_hash ?? null;
  if (!statusOk || characterHash !== currentScriptHash) {
    return {
      done: false,
      evidence: `${visual.evidence}; character_state_refs.json ${characterStatus || "missing_status"} for hash ${characterHash ?? "none"}; required hash ${currentScriptHash}`,
    };
  }
  const charSourceHashes = characterRefs.source_hashes && typeof characterRefs.source_hashes === "object" && !Array.isArray(characterRefs.source_hashes)
    ? characterRefs.source_hashes
    : null;
  if (charSourceHashes) {
    const stale = [];
    const ignored = [];
    for (const [sourcePath, recordedHash] of Object.entries(charSourceHashes)) {
      const currentHash = await fileSha256(sourcePath);
      if (!currentHash) stale.push(`${path.basename(sourcePath)} missing`);
      else if (currentHash !== recordedHash) {
        if (await visualReferencePlanHashDriftIsVolatile(sourcePath, characterRefs)) {
          ignored.push(`${path.basename(sourcePath)} reference_paths_updated`);
        } else {
          stale.push(`${path.basename(sourcePath)} stale`);
        }
      }
    }
    if (stale.length) {
      return { done: false, evidence: `${visual.evidence}; character_state_refs.json ${stale.slice(0, 4).join(", ")}` };
    }
    if (ignored.length) {
      return {
        done: visual.done,
        evidence: `${visual.evidence}; character_state_refs.json status=${characterStatus}; source_hashes=current; ignored=${ignored.slice(0, 4).join(", ")}`,
      };
    }
  }
  return {
    done: visual.done,
    evidence: `${visual.evidence}; reference_inventory_ledger.json selected_assets=${inventoryLedger.assets.length}${directorLedgerEvidence}; character_state_refs.json status=${characterStatus}${charSourceHashes ? "; source_hashes=current" : ""}`,
  };
}

async function main() {
  const episodeDir = flags["episode-dir"]
    ? path.resolve(flags["episode-dir"])
    : (() => {
        requiredFlag("channel", flags.channel);
        requiredFlag("week", flags.week);
        requiredFlag("episode", flags.episode);
        return path.join(dataRoot, "channels", flags.channel, "weekly_runs", flags.week, "episodes", flags.episode);
      })();
  const runIdentityPath = path.join(episodeDir, "run_identity.json");
  const runIdentity = await readJson(runIdentityPath, {});
  const productionManifest = await readJson(path.join(episodeDir, "production_manifest.json"), null);
  const identity = {
    channel: flags.channel ?? runIdentity.channel,
    series_slug: flags.series ?? flags.seriesSlug ?? runIdentity.series_slug,
    week: flags.week ?? runIdentity.week,
    episode: flags.episode ?? runIdentity.episode ?? path.basename(episodeDir),
    audio_target: flags["audio-target"] ?? runIdentity.audio_target ?? "narrator_only",
    image_provider: flags["image-provider"] ?? flags.provider ?? runIdentity.image_provider ?? "modelslab",
    image_provider_options: runIdentity.image_provider_options ?? {},
    voice_provider_options: runIdentity.voice_provider_options ?? {},
    qwen_narrator_voice_id: flags["qwen-narrator-voice-id"] ?? flags["narrator-voice-id"] ?? runIdentity.voice_provider_options?.qwen_narrator_voice_id ?? runIdentity.qwen_narrator_voice_id ?? DEFAULT_QWEN_NARRATOR_VOICE_ID,
    qwen_native_speed: flags["qwen-native-speed"] ?? flags["native-speed"] ?? runIdentity.voice_provider_options?.qwen_native_speed ?? runIdentity.qwen_native_speed ?? null,
    image_output_qa_required: runIdentity.image_output_qa_required ?? runIdentity.production_gates?.image_output_qa_required_before_render ?? false,
    production_gates: runIdentity.production_gates ?? {},
    pace_policy: flags["pace-policy"] ?? flags["wpm-policy"] ?? runIdentity.pace_policy ?? "enforced",
    target_wpm_min: flags["target-wpm-min"] ?? flags["wpm-min"] ?? runIdentity.target_wpm_min ?? runIdentity.pace_targets?.target_wpm_min ?? runIdentity.pace_targets?.min ?? DEFAULT_TARGET_WPM_MIN,
    target_wpm_max: flags["target-wpm-max"] ?? flags["wpm-max"] ?? runIdentity.target_wpm_max ?? runIdentity.pace_targets?.target_wpm_max ?? runIdentity.pace_targets?.max ?? DEFAULT_TARGET_WPM_MAX,
    target_wpm_midpoint: flags["target-wpm-mid"] ?? flags["wpm-mid"] ?? runIdentity.target_wpm_midpoint ?? runIdentity.pace_targets?.target_wpm_midpoint ?? runIdentity.pace_targets?.mid ?? DEFAULT_TARGET_WPM_MID,
    pace_targets: runIdentity.pace_targets ?? null,
    render_profile: flags["render-profile"] ?? runIdentity.render_profile ?? "smooth_fast_ken_burns",
    run_intent: runIdentity.run_intent ?? "production",
    proof_scope: runIdentity.proof_scope ?? { mode: "full_episode", start_sec: 0, end_sec: null },
    git: runIdentity.git ?? null,
    provider_locks: runIdentity.provider_locks ?? null,
    model_versions: runIdentity.model_versions ?? null,
    run_identity_schema: runIdentity.schema ?? "missing",
    stage_registry_version: runIdentity.stage_registry_version ?? null,
  };
  const legacyIdentity = runIdentity.schema !== "goldflow_run_identity_v2";
  const episode = identity.episode;
  const scriptHash = await fileSha256(path.join(episodeDir, "script_clean.md"));
  const scriptApproval = await scriptApprovalComplete(episodeDir, scriptHash);
  const scriptPace = await paceReportComplete(path.join(episodeDir, "script_pace_report.json"), scriptHash, "script_pace_report.json", identity);
  const speakability = await jsonArtifactHashComplete(path.join(episodeDir, "script_speakability_report.json"), scriptHash, "script_speakability_report.json");
  const ttsOverrides = await jsonArtifactHashComplete(path.join(episodeDir, "tts_spoken_overrides.json"), scriptHash, "tts_spoken_overrides.json");
  const qwenVoicePlan = await qwenVoicePlanComplete(episodeDir, scriptHash, identity);
  const qwenTtsStitch = await qwenTtsStitchComplete(episodeDir, episode, scriptHash, identity);
  const whisperTiming = await whisperTimingComplete(episodeDir, episode, scriptHash);
  const audioPace = await paceReportComplete(path.join(episodeDir, `narration_pace_report_${episode}.json`), scriptHash, `narration_pace_report_${episode}.json`, identity);
  const audioPaceNextCommand = await audioPaceRecoveryCommand(episodeDir, identity);
  const semanticPlan = await jsonStatusComplete(path.join(episodeDir, "semantic_scene_plan.json"), "semantic_scene_plan.json");
  const storyFactLedger = await jsonStatusWithSourceHashesComplete(path.join(episodeDir, "story_fact_ledger.json"), "story_fact_ledger.json");
  const timedScenePlan = await jsonStatusComplete(path.join(episodeDir, "timed_scene_plan.json"), "timed_scene_plan.json");
  const visualBeatPlanPath = path.join(episodeDir, "visual_beat_plan.json");
  let visualBeatPlan = await jsonStatusWithSourceHashesComplete(visualBeatPlanPath, "visual_beat_plan.json");
  if (!legacyIdentity && visualBeatPlan.done) {
    const [beatArtifact, beatApproval, beatPlanHash] = await Promise.all([
      readJson(visualBeatPlanPath, null),
      readJson(path.join(episodeDir, "visual_beat_approval.json"), null),
      fileSha256(visualBeatPlanPath),
    ]);
    const contract = beatArtifact?.visual_beat_contract_version ?? beatArtifact?.planner_contract_version;
    const approvalCurrent = beatApproval?.status === "approved" && beatApproval.visual_beat_plan_sha256 === beatPlanHash;
    if (contract !== CURRENT_VISUAL_BEAT_CONTRACT_VERSION || !approvalCurrent) {
      visualBeatPlan = {
        done: false,
        state: contract !== CURRENT_VISUAL_BEAT_CONTRACT_VERSION ? "stale" : "missing",
        evidence: `visual_beat_plan.json requires ${CURRENT_VISUAL_BEAT_CONTRACT_VERSION} and current visual_beat_approval.json`,
      };
    }
  }
  const visualReferencePlan = await visualReferencePlanComplete(episodeDir, scriptHash, identity);
  const visualPromptPlan = await jsonStatusWithSourceHashesComplete(path.join(episodeDir, "section_image_prompts.json"), "section_image_prompts.json");
  const hardenedPromptPlan = await jsonStatusWithSourceHashesComplete(path.join(episodeDir, "section_image_prompts_hardened.json"), "section_image_prompts_hardened.json");
  const longformMix = await longformMixComplete(episodeDir, episode);
  const referenceGeneration = await referenceGenerationComplete(episodeDir, identity);
  const referenceImageApproval = await referenceImageApprovalComplete(episodeDir, episode);
  const legacyCharacterRefs = await readJson(path.join(episodeDir, "character_state_refs.json"), null);
  const legacyCharacterRefStatus = String(legacyCharacterRefs?.status ?? "").toLowerCase();
  const imagegen = await imageReportComplete(episodeDir, episode, identity);
  const imageOutputQa = await imageOutputQaComplete(episodeDir, episode, identity);
  const render = await renderComplete(episodeDir, episode, identity);
  const finalQa = await finalQaComplete(episodeDir, episode, identity);
  const latestPackaging = await latestMatching(episodeDir, /^upload_packaging.*\.md$|^title_thumbnail.*\.json$|^thumbnail.*\.png$/);
  const visualPromptNextCommand = await visualPromptPlanReviewHardenCommand(episodeDir, identity);
  const narratorOnly = isNarratorOnlyAudio(identity);
  const sfxScoreDone = narratorOnly
    ? { done: true, evidence: "skipped: audio_target narrator_only" }
    : {
        done: await exists(path.join(episodeDir, `sfx_event_plan_${episode}.json`)) && await exists(path.join(episodeDir, `score_drop_plan_${episode}.json`)),
        evidence: `sfx_event_plan_${episode}.json`,
      };

  const referencePlanPath = path.join(episodeDir, "visual_reference_plan.json");
  const referencePlanHash = await fileSha256(referencePlanPath);
  const referencePlanApproval = await readJson(path.join(episodeDir, "reference_plan_approval.json"), null);
  const referencePlanApprovalDone = Boolean(
    referencePlanHash
    && ["approved", "passed"].includes(String(referencePlanApproval?.status ?? "").toLowerCase())
    && referencePlanApproval?.visual_reference_plan_sha256 === referencePlanHash
  );
  const hardenReport = await readJson(path.join(episodeDir, `visual_prompt_hardening_${episode}.json`), null);
  const hardenStatus = String(hardenReport?.status ?? "").toLowerCase();
  const transitionPlan = await jsonStatusWithSourceHashesComplete(path.join(episodeDir, `transition_edit_plan_${episode}.json`), `transition_edit_plan_${episode}.json`);
  const motionPlan = await jsonStatusWithSourceHashesComplete(path.join(episodeDir, `motion_edit_plan_${episode}.json`), `motion_edit_plan_${episode}.json`);
  const semanticValidation = legacyIdentity
    ? { ...semanticPlan, evidence: `${semanticPlan.evidence ?? "semantic_scene_plan.json"}; legacy run: story_fact_ledger waived` }
    : {
        done: semanticPlan.done && storyFactLedger.done,
        evidence: `${semanticPlan.evidence}; ${storyFactLedger.evidence}`,
      };
  const validationByStage = {
    run_identity: { done: await exists(runIdentityPath), evidence: legacyIdentity ? "run_identity.json legacy adapter" : "run_identity.json v2" },
    source_ingest: {
      done: await exists(path.join(episodeDir, "script_clean.md")) && await exists(path.join(episodeDir, "source_story_ingest_report.json")),
      evidence: "script_clean.md + source_story_ingest_report.json",
    },
    script_approval: scriptApproval,
    script_pace_check: scriptPace,
    targeted_speakability: { done: speakability.done && ttsOverrides.done, evidence: `${speakability.evidence}; ${ttsOverrides.evidence}` },
    semantic_scene_plan: semanticValidation,
    voice_plan: qwenVoicePlan,
    qwen_tts_stitch: qwenTtsStitch,
    local_whisper_word_timing: whisperTiming,
    audio_pace_check: { ...audioPace, next_command_shape: audioPaceNextCommand },
    timing_bind: timedScenePlan,
    sfx_score_plan: narratorOnly
      ? { state: "skipped_with_waiver", evidence: "audio_target narrator_only; audio design intentionally disabled" }
      : sfxScoreDone,
    longform_audio_mix: longformMix,
    visual_beat_plan: visualBeatPlan,
    visual_reference_plan: visualReferencePlan,
    reference_plan_approval: legacyIdentity
      ? { state: "skipped_with_waiver", evidence: "legacy run predates reference-plan hash approval" }
      : { done: referencePlanApprovalDone, evidence: referencePlanApprovalDone ? "reference_plan_approval.json hash=current" : "reference plan hash approval missing or stale" },
    reference_generation: referenceGeneration,
    reference_image_approval: legacyIdentity && legacyCharacterRefStatus !== "draft_needs_manual_review" && !referenceImageApproval.done
      ? { state: "skipped_with_waiver", evidence: "legacy run predates separate generated-reference approval report" }
      : referenceImageApproval,
    visual_prompt_plan: visualPromptPlan,
    visual_prompt_harden: hardenStatus === "blocked" || /visual review|manual agent review/i.test(String(visualPromptNextCommand ?? ""))
      ? { state: "blocked", evidence: `${hardenedPromptPlan.evidence ?? "hardened prompts"}; harden blockers present`, next_command_shape: visualPromptNextCommand }
      : hardenedPromptPlan,
    visual_prompt_blocker_repair: hardenedPromptPlan.done
      ? { state: "skipped_with_waiver", evidence: "hardening passed with no unresolved prompt blockers" }
      : { state: hardenStatus === "blocked" ? "missing" : "blocked", evidence: hardenStatus ? `hardening status=${hardenStatus}` : "awaiting hardening result", next_command_shape: visualPromptNextCommand },
    transition_edit_plan: legacyIdentity
      ? { done: await exists(path.join(episodeDir, `transition_edit_plan_${episode}.json`)), evidence: `transition_edit_plan_${episode}.json legacy adapter` }
      : transitionPlan,
    image_generation: imagegen,
    image_output_qa: legacyIdentity && !imageOutputQaRequired(identity)
      ? { state: "skipped_with_waiver", evidence: "legacy run predates required per-cut image QA" }
      : imageOutputQa,
    motion_edit_plan: legacyIdentity
      ? { state: "skipped_with_waiver", evidence: "legacy run predates directed motion-plan contract" }
      : motionPlan,
    premium_render: render,
    final_qa: finalQa,
    upload_packaging: { done: Boolean(latestPackaging), evidence: latestPackaging?.name ?? "upload packaging missing" },
  };

  const rows = PIPELINE_STAGE_REGISTRY.map((definition) => {
    const validation = validationByStage[definition.id] ?? { state: "missing", evidence: "validator not materialized" };
    return stage(definition.id, validation, identity, validation.next_command_shape);
  });

  const next = rows.find((row) => !stageIsSatisfied(row.state)) ?? null;
  const result = {
    schema: "goldflow_run_status_v2",
    stage_registry_version: PIPELINE_STAGE_REGISTRY_VERSION,
    episode_dir: episodeDir,
    identity,
    run_identity_path: await exists(runIdentityPath) ? runIdentityPath : null,
    current_stage: next?.stage ?? "complete",
    current_stage_state: next?.state ?? "passed",
    allowed_command_stages: next?.stage === "visual_prompt_harden" && next?.state === "blocked"
      ? ["visual_prompt_harden", "visual_prompt_blocker_repair"]
      : next?.stage ? [next.stage] : [],
    next_required_input: next?.required_input ?? null,
    next_output_artifact: next?.output_artifact ?? null,
    operator_approval_required: next?.operator_approval_required ?? false,
    next_command_shape: next?.next_command_shape ?? null,
    manual_blocker_triage_policy: MANUAL_BLOCKER_TRIAGE_POLICY,
    execution_telemetry: productionManifest?.telemetry ?? null,
    production_manifest_path: productionManifest ? path.join(episodeDir, "production_manifest.json") : null,
    stage_ledger: rows,
  };

  if (flags.format === "markdown" || flags.md === "true") {
    console.log(`# Goldflow Run Status\n`);
    console.log(`Episode dir: ${episodeDir}`);
    console.log(`Current stage: ${result.current_stage}`);
    if (result.next_command_shape) console.log(`Next command shape: \`${result.next_command_shape}\``);
    console.log(`Manual blocker triage: ${MANUAL_BLOCKER_TRIAGE_POLICY.summary}`);
    console.log("\n| Stage | State | Approval | Output |");
    console.log("| --- | --- | --- | --- |");
    for (const row of rows) {
      console.log(`| ${row.stage} | ${row.state} | ${row.operator_approval_required ? "yes" : "no"} | ${row.output_artifact} |`);
    }
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
