#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeAuthoredMotionIntent, sanitizeLayeredParallaxTreatment } from "./lib/motion-plan-utils.mjs";
import { resolveTransitionSfxFamily } from "./lib/transition-sfx-policy.mjs";

const flags = parseFlags(process.argv.slice(2));
const episodeDir = path.resolve(flags["episode-dir"] ?? "");
const scopeEndSec = Number(flags["scope-end-sec"] ?? 60);
const recipePath = path.resolve(flags.recipe ?? "");
const outputDir = path.resolve(flags["output-dir"] ?? path.join(episodeDir, "review_samples", "editorial_motion_v3"));
const episode = flags.episode ?? path.basename(episodeDir) ?? "ep_01";
const proofLabel = String(flags["proof-label"] ?? "editorial-v3").trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const promptPlanPath = path.resolve(flags.prompts ?? path.join(episodeDir, "section_image_prompts_hardened.json"));
const baseMotionPlanPath = path.resolve(flags["motion-plan"] ?? path.join(episodeDir, `motion_edit_plan_${episode}.json`));
const baseTransitionPlanPath = path.resolve(flags["transition-plan"] ?? path.join(episodeDir, `transition_edit_plan_${episode}.json`));
const sfxManifestPath = path.resolve(flags["sfx-manifest"] ?? path.join(dataRoot, "sfx_bank", "sfx_manifest.json"));
const motionOutputPath = path.join(outputDir, `motion_edit_plan_${episode}-${proofLabel}.json`);
const transitionOutputPath = path.join(outputDir, `transition_edit_plan_${episode}-${proofLabel}.json`);
const reportOutputPath = path.join(outputDir, proofLabel === "editorial-v3" ? "editorial_motion_v3_plan_report.json" : `${proofLabel}_plan_report.json`);

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

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function hashFile(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}

function mergedMotionIntent(base, override, prompt, depthTreatment = null) {
  const authored = sanitizeAuthoredMotionIntent({
    behavior: override?.behavior ?? base?.behavior,
    focal_subject: override?.focal_subject ?? base?.focal_subject,
    start_anchor: override?.start_anchor ?? base?.start_anchor,
    end_anchor: override?.end_anchor ?? base?.end_anchor,
    start_scale: override?.start_scale ?? base?.start_scale,
    end_scale: override?.end_scale ?? base?.end_scale,
    easing: override?.easing ?? base?.easing,
    motion_keyframes: override?.motion_keyframes ?? base?.motion_keyframes,
    reason: override?.reason ?? base?.intent_reason,
  });
  if (!authored) throw new Error(`Editorial motion recipe produced an invalid intent for ${prompt.image_id}.`);
  return {
    ...base,
    image_id: prompt.image_id,
    scene_id: prompt.scene_id ?? base?.scene_id ?? null,
    visual_beat_id: prompt.visual_beat_id ?? base?.visual_beat_id ?? null,
    start_sec: Number(prompt.start_sec ?? 0),
    duration_sec: Math.max(1 / 60, Math.min(Number(prompt.duration_sec ?? base?.duration_sec ?? 6), scopeEndSec - Number(prompt.start_sec ?? 0))),
    focal_subject: authored.focal_subject,
    focal_source: override ? "editorial_motion_proof_recipe" : base?.focal_source,
    start_anchor: authored.start_anchor,
    end_anchor: authored.end_anchor,
    start_scale: authored.start_scale,
    end_scale: authored.end_scale,
    easing: authored.easing,
    behavior: authored.behavior,
    intent_reason: authored.reason,
    motion_keyframes: authored.motion_keyframes,
    ...(depthTreatment ? { depth_treatment: depthTreatment } : {}),
    proof_override: override ?? null,
  };
}

async function resolveDepthTreatment(override) {
  const config = override?.depth_treatment;
  if (!config) return null;
  if (String(config.mode ?? "") !== "layered_parallax") throw new Error("Only layered_parallax depth treatment is supported.");
  const reportPath = path.resolve(outputDir, String(config.asset_report ?? ""));
  const report = await readJson(reportPath);
  if (report?.status !== "passed") throw new Error(`Missing passed parallax asset report: ${reportPath}`);
  const treatment = sanitizeLayeredParallaxTreatment({
    mode: "layered_parallax",
    source_image_sha256: report.image_sha256,
    background_path: report.background_path,
    background_sha256: report.background_sha256,
    foreground_path: report.foreground_path,
    foreground_sha256: report.foreground_sha256,
    background_keyframes: config.background_keyframes,
    foreground_keyframes: config.foreground_keyframes,
  });
  if (!treatment) throw new Error(`Invalid layered parallax treatment in ${reportPath}.`);
  return { treatment, reportPath };
}

function transitionEvent(recipeEvent, prompts, baseByToImage, sfxManifest) {
  const toIndex = prompts.findIndex((prompt) => String(prompt.image_id) === String(recipeEvent.to_image_id));
  if (toIndex <= 0) throw new Error(`Transition recipe target is not an in-scope adjacent cut: ${recipeEvent.to_image_id}`);
  const from = prompts[toIndex - 1];
  const to = prompts[toIndex];
  const base = baseByToImage.get(String(to.image_id)) ?? {};
  const family = String(recipeEvent.sfx_family ?? "none").trim().toLowerCase();
  const resolved = family === "none" ? null : resolveTransitionSfxFamily(sfxManifest, family, { inHook: Number(to.start_sec) < 30 });
  if (family !== "none" && !resolved) throw new Error(`No approved available transition SFX asset resolves family ${family} for ${to.image_id}.`);
  return {
    boundary_id: recipeEvent.boundary_id ?? base.boundary_id ?? `proof_boundary_${String(toIndex).padStart(3, "0")}`,
    from_image_id: from.image_id,
    to_image_id: to.image_id,
    scene_id: to.scene_id ?? null,
    start_sec: Number(Number(to.start_sec).toFixed(3)),
    xfade_transition: String(recipeEvent.xfade_transition ?? base.xfade_transition ?? "dissolve"),
    xfade_duration_sec: clamp(recipeEvent.xfade_duration_sec ?? base.xfade_duration_sec ?? 0.24, 0.08, 0.5),
    transition_sfx: Boolean(resolved),
    sfx_family: resolved?.sfx_family ?? "none",
    cue_id: resolved?.cue_id ?? null,
    asset_path: resolved?.asset_path ?? null,
    asset_id: resolved?.asset_id ?? null,
    asset_trim_start_sec: resolved?.asset_trim_start_sec ?? null,
    duration_sec: resolved?.duration_sec ?? null,
    fade_out_sec: resolved?.fade_out_sec ?? null,
    sfx_resolution_source: resolved?.resolution_source ?? null,
    gain_db: resolved ? clamp(recipeEvent.gain_db ?? resolved.gain_db, -36, -8) : null,
    sfx_offset_sec: resolved ? clamp(recipeEvent.sfx_offset_sec ?? resolved.sfx_offset_sec, -0.5, 0.05) : 0,
    score_drop_anchor: false,
    in_hook: Number(to.start_sec) < 30,
    in_retention_ramp: Number(to.start_sec) >= 30 && Number(to.start_sec) < 180,
    scene_changed: Boolean(from.scene_id && to.scene_id && from.scene_id !== to.scene_id),
    edit_reason: String(recipeEvent.edit_reason ?? "Editorial Motion V3 bounded proof transition.").slice(0, 500),
  };
}

async function main() {
  if (!flags["episode-dir"]) throw new Error("--episode-dir is required.");
  if (!flags.recipe) throw new Error("--recipe is required.");
  if (!(scopeEndSec > 0)) throw new Error("--scope-end-sec must be greater than zero.");
  const [promptPlan, baseMotionPlan, baseTransitionPlan, sfxManifest, recipe] = await Promise.all([
    readJson(promptPlanPath),
    readJson(baseMotionPlanPath),
    readJson(baseTransitionPlanPath),
    readJson(sfxManifestPath),
    readJson(recipePath),
  ]);
  for (const [label, report] of [["prompt plan", promptPlan], ["motion plan", baseMotionPlan], ["transition plan", baseTransitionPlan]]) {
    if (report?.status !== "passed") throw new Error(`Missing passed ${label}.`);
  }
  const prompts = (promptPlan.prompts ?? []).filter((prompt) => Number(prompt.start_sec ?? 0) < scopeEndSec);
  if (!prompts.length) throw new Error("No prompt cuts fall inside the requested proof scope.");
  const baseMotionById = new Map((baseMotionPlan.motion_intents ?? []).map((row) => [String(row.image_id), row]));
  const motionOverrides = recipe.motion_overrides ?? {};
  const resolvedDepthByImage = new Map();
  for (const prompt of prompts) {
    const override = motionOverrides[prompt.image_id] ?? null;
    const resolved = await resolveDepthTreatment(override);
    if (resolved) resolvedDepthByImage.set(String(prompt.image_id), resolved);
  }
  const motionIntents = prompts.map((prompt) => {
    const base = baseMotionById.get(String(prompt.image_id));
    if (!base) throw new Error(`Base motion plan is missing ${prompt.image_id}.`);
    return mergedMotionIntent(base, motionOverrides[prompt.image_id] ?? null, prompt, resolvedDepthByImage.get(String(prompt.image_id))?.treatment ?? null);
  });
  const baseTransitionByTo = new Map((baseTransitionPlan.transition_events ?? []).map((row) => [String(row.to_image_id), row]));
  const transitionEvents = (recipe.transition_overrides ?? []).map((event) => transitionEvent(event, prompts, baseTransitionByTo, sfxManifest));
  const sourcePaths = [
    promptPlanPath,
    baseMotionPlanPath,
    baseTransitionPlanPath,
    sfxManifestPath,
    recipePath,
    ...[...resolvedDepthByImage.values()].map((row) => row.reportPath),
  ];
  const sourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async (filePath) => [filePath, await hashFile(filePath)])));
  const now = new Date().toISOString();
  const motionPlan = {
    ...baseMotionPlan,
    schema: "goldflow_motion_edit_plan_v2",
    status: "passed",
    scope: { kind: "diagnostic_proof", start_sec: 0, end_sec: scopeEndSec },
    source_hashes: sourceHashes,
    policy: "Image-aware editorial proof recipe with selective static holds, restrained keyframed moves, and optional hash-bound layered parallax. Unchanged in-scope cuts inherit the approved base motion plan.",
    motion_intent_count: motionIntents.length,
    keyframed_motion_intent_count: motionIntents.filter((row) => Array.isArray(row.motion_keyframes)).length,
    static_hold_count: motionIntents.filter((row) => row.behavior === "static_hold").length,
    layered_parallax_count: motionIntents.filter((row) => row.depth_treatment?.mode === "layered_parallax").length,
    motion_intents: motionIntents,
    updated_at: now,
  };
  const transitionPlan = {
    ...baseTransitionPlan,
    schema: "goldflow_transition_edit_plan_v2",
    status: "passed",
    scope: { kind: "diagnostic_proof", start_sec: 0, end_sec: scopeEndSec },
    source_hashes: sourceHashes,
    transition_sfx_enabled: transitionEvents.some((event) => event.transition_sfx),
    policy: "Human-selected proof boundaries and xfade families; unselected boundaries remain hard cuts and transition SFX families resolve deterministically to approved available bank assets.",
    transition_event_count: transitionEvents.length,
    transition_events: transitionEvents,
    updated_at: now,
  };
  await writeJson(motionOutputPath, motionPlan);
  await writeJson(transitionOutputPath, transitionPlan);
  const report = {
    schema: "goldflow_editorial_motion_proof_plan_v1",
    status: "passed",
    episode_dir: episodeDir,
    scope_end_sec: scopeEndSec,
    selected_image_ids: prompts.map((prompt) => prompt.image_id),
    motion_plan_path: motionOutputPath,
    transition_plan_path: transitionOutputPath,
    motion_intent_count: motionIntents.length,
    keyframed_motion_intent_count: motionPlan.keyframed_motion_intent_count,
    static_hold_count: motionPlan.static_hold_count,
    layered_parallax_count: motionPlan.layered_parallax_count,
    transition_event_count: transitionEvents.length,
    transition_sfx_event_count: transitionEvents.filter((event) => event.transition_sfx).length,
    source_hashes: sourceHashes,
    updated_at: now,
  };
  await writeJson(reportOutputPath, report);
  console.log(JSON.stringify(report, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    await writeJson(reportOutputPath, { schema: "goldflow_editorial_motion_proof_plan_v1", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() }).catch(() => {});
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
