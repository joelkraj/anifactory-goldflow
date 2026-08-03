#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  animationPolicyForIdentity,
  clampLtxDuration,
  hashFile,
  ltxMotionPromptForSequence,
  ltxNegativePrompt,
  ltxSingleShotIntentFindings,
  ltxVideoEnabled,
  sanitizeAnimationIntent,
} from "./lib/ltx-video-contract.mjs";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeDir = path.resolve(flags["episode-dir"] ?? path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode));
const identityPath = path.resolve(flags["run-identity"] ?? path.join(episodeDir, "run_identity.json"));
const beatPath = path.resolve(flags.beats ?? path.join(episodeDir, "visual_beat_plan.json"));
const promptPath = path.resolve(flags.prompts ?? path.join(episodeDir, "section_image_prompts_hardened.json"));
const imagegenPath = path.resolve(flags["imagegen-report"] ?? path.join(episodeDir, `imagegen_report_${episode}.json`));
const imageQaPath = path.resolve(flags["image-output-qa"] ?? path.join(episodeDir, `image_output_qa_${episode}.json`));
const outputPath = path.resolve(flags.output ?? path.join(episodeDir, `animation_direction_plan_${episode}.json`));
const revalidateExisting = /^(?:true|1|yes)$/i.test(String(flags["revalidate-existing"] ?? "false"));

function parseFlags(parts) {
  const parsed = {};
  for (let index = 0; index < parts.length; index += 1) {
    if (!parts[index].startsWith("--")) continue;
    const key = parts[index].slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--") ? parts[index + 1] : "true";
    parsed[key] = value;
    if (value !== "true") index += 1;
  }
  return parsed;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function riskClass(intent, prompt) {
  const highRisk = ["physical_contact", "locomotion_action", "effect_or_impact"].includes(intent.shot_class);
  const denseCast = (prompt.shot_manifest?.visible_characters ?? []).length >= 3;
  return highRisk || denseCast
    ? "high"
    : ["dialogue_pair", "ui_or_screen"].includes(intent.shot_class) ? "medium" : "low";
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function promptCreativeContract(prompt = {}) {
  const value = structuredClone(prompt);
  delete value.start_sec;
  delete value.duration_sec;
  // These fields are transcript/timeline provenance. They may change after an
  // exact narration retime without changing anything submitted to image or
  // video generation.
  delete value.visual_beat_script_excerpt;
  delete value.location_timeline_label;
  if (value.active_state_constraints && typeof value.active_state_constraints === "object") {
    delete value.active_state_constraints.applied_through_source_word_index;
  }
  return value;
}

function originalPromptFromDirection(direction = {}) {
  const prompt = structuredClone(direction.directed_prompt ?? {});
  delete prompt.animation_intent;
  return prompt;
}

function assertAnimationDirectionCreativeIdentity(existing, fresh) {
  const imageId = String(existing?.image_id ?? fresh?.image_id ?? "<unknown>");
  const fail = (field) => {
    throw new Error(`Animation timing revalidation creative/hash mismatch for ${imageId}: ${field}.`);
  };
  for (const field of ["image_id", "scene_id", "visual_beat_id", "sequence_mode", "risk_class", "candidate_count"]) {
    if (!jsonEqual(existing?.[field] ?? null, fresh?.[field] ?? null)) fail(field);
  }
  if (!String(existing?.animation_sequence_id ?? "").trim()) fail("animation_sequence_id");
  if (existing?.source_image_path !== fresh?.source_image_path) fail("source_image_path");
  if (existing?.source_image_sha256 !== fresh?.source_image_sha256) fail("source_image_sha256");
  if (!jsonEqual(existing?.animation_intent, fresh?.animation_intent)) fail("animation_intent");
  if (!jsonEqual(existing?.start_frame_contract, fresh?.start_frame_contract)) fail("start_frame_contract");
  if (!jsonEqual(existing?.end_frame_contract, fresh?.end_frame_contract)) fail("end_frame_contract");
  if (!jsonEqual(existing?.scene_continuity, fresh?.scene_continuity)) fail("scene_continuity");
  if (!jsonEqual(existing?.provider_image_inputs, fresh?.provider_image_inputs)) fail("provider_image_inputs");
  if (existing?.negative_prompt !== fresh?.negative_prompt) fail("negative_prompt");
  if (!jsonEqual(
    promptCreativeContract(existing?.directed_prompt),
    promptCreativeContract(fresh?.directed_prompt),
  )) fail("directed_prompt_creative_contract");
  const originalPrompt = originalPromptFromDirection(existing);
  if (sha256(JSON.stringify(originalPrompt)) !== existing?.source_prompt_sha256) fail("source_prompt_sha256");
  if (ltxMotionPromptForSequence(existing) !== existing?.motion_prompt) fail("motion_prompt");
  const originalCutDuration = Math.max(0.001, Number(originalPrompt.duration_sec ?? 0));
  const expectedGenerationDuration = clampLtxDuration(Math.max(
    originalCutDuration,
    Number(existing?.animation_intent?.preferred_generation_duration_sec ?? 5),
  ));
  if (Number(existing?.requested_generation_duration_sec) !== expectedGenerationDuration) {
    fail("requested_generation_duration_sec");
  }
  const coverage = Array.isArray(existing?.coverage) ? existing.coverage : [];
  if (coverage.length !== 1
    || coverage[0]?.image_id !== existing?.image_id
    || coverage[0]?.image_sha256 !== existing?.source_image_sha256
    || Number(coverage[0]?.source_offset_sec ?? -1) !== 0) {
    fail("coverage");
  }
}

function retimePreservedDirection(existing, fresh) {
  const cutDurationSec = Number(fresh.cut_duration_sec);
  return {
    ...existing,
    start_sec: Number(fresh.start_sec),
    cut_duration_sec: cutDurationSec,
    sequence_timeline_duration_sec: Number(cutDurationSec.toFixed(3)),
    coverage: existing.coverage.map((covered) => ({
      ...covered,
      timeline_duration_sec: cutDurationSec,
      source_offset_sec: 0,
      source_end_offset_sec: Number(cutDurationSec.toFixed(3)),
    })),
  };
}

async function main() {
  const [identity, beatPlan, promptPlan, imagegen, imageQa, existingPlan] = await Promise.all([
    readJson(identityPath),
    readJson(beatPath),
    readJson(promptPath),
    readJson(imagegenPath),
    readJson(imageQaPath),
    revalidateExisting ? readJson(outputPath) : Promise.resolve(null),
  ]);
  if (!ltxVideoEnabled(identity)) throw new Error("Animation direction is disabled in run_identity.json.");
  if (beatPlan?.status !== "passed" || !Array.isArray(beatPlan.beats)) throw new Error(`Missing passed visual beat plan: ${beatPath}`);
  if (promptPlan?.status !== "passed" || !Array.isArray(promptPlan.prompts)) throw new Error(`Missing passed hardened prompt plan: ${promptPath}`);
  if (imagegen?.status !== "passed" || !Array.isArray(imagegen.results)) throw new Error(`Missing passed image generation report: ${imagegenPath}`);
  if (imageQa?.status !== "passed") throw new Error(`Missing passed image QA: ${imageQaPath}`);
  const policy = animationPolicyForIdentity(identity);
  const beatById = new Map(beatPlan.beats.map((row) => [String(row.visual_beat_id ?? ""), row]));
  const imageById = new Map(imagegen.results.map((row) => [String(row.image_id ?? ""), row]));
  const accepted = imageQa.accepted_image_hashes ?? {};
  const eligiblePrompts = promptPlan.prompts.filter((row) => row.image_generation_required !== false);
  const candidates = [];
  const stillFallbacks = [];
  for (const [index, prompt] of eligiblePrompts.entries()) {
    const beat = beatById.get(String(prompt.visual_beat_id ?? ""));
    const rawIntent = prompt.shot_manifest?.animation_intent ?? beat?.animation_intent;
    const intent = sanitizeAnimationIntent(rawIntent);
    if (policy === "selective_ltx23" && intent?.eligibility !== "animate") {
      stillFallbacks.push({
        image_id: prompt.image_id,
        visual_beat_id: prompt.visual_beat_id ?? null,
        disposition: "accepted_still_fallback",
        reason_codes: [intent ? "still_preferred" : "invalid_animation_intent"],
      });
      continue;
    }
    const intentFindings = ltxSingleShotIntentFindings(rawIntent);
    if (intentFindings.length) {
      stillFallbacks.push({
        image_id: prompt.image_id,
        visual_beat_id: prompt.visual_beat_id ?? null,
        disposition: "accepted_still_fallback",
        reason_codes: intentFindings,
      });
      continue;
    }
    const image = imageById.get(String(prompt.image_id ?? ""));
    const imagePath = image?.image_path ? path.resolve(image.image_path) : null;
    const imageHash = imagePath ? await hashFile(imagePath) : null;
    if (!imagePath || !imageHash || accepted[prompt.image_id] !== imageHash) {
      throw new Error(`Animation direction requires the current accepted image hash for ${prompt.image_id}.`);
    }
    candidates.push({ index, prompt, beat, intent, imagePath, imageHash, risk: riskClass(intent, prompt) });
  }
  const freshDirections = candidates.map((first, directionIndex) => {
    const cutDurationSec = Math.max(0.001, Number(first.prompt.duration_sec ?? 0));
    const coverage = [{
      image_id: first.prompt.image_id,
      image_sha256: first.imageHash,
      visual_beat_id: first.prompt.visual_beat_id ?? null,
      timeline_duration_sec: cutDurationSec,
      source_offset_sec: 0,
      source_end_offset_sec: Number(cutDurationSec.toFixed(3)),
      foreground_action: first.prompt.visual_beat_action ?? first.beat?.foreground_action ?? null,
      animation_intent: first.intent,
    }];
    const preferredDuration = Math.max(
      cutDurationSec,
      Number(first.intent.preferred_generation_duration_sec ?? 5),
    );
    const sequenceIdentity = {
      scene_id: first.prompt.scene_id ?? null,
      coverage: coverage.map((row) => ({
        image_id: row.image_id,
        image_sha256: row.image_sha256,
        source_offset_sec: row.source_offset_sec,
        source_end_offset_sec: row.source_end_offset_sec,
      })),
    };
    const animationSequenceId = `ltx-shot-${String(directionIndex + 1).padStart(4, "0")}-${sha256(JSON.stringify(sequenceIdentity)).slice(0, 12)}`;
    const prior = eligiblePrompts[first.index - 1];
    const next = eligiblePrompts[first.index + 1];
    const directedPrompt = {
      ...first.prompt,
      duration_sec: cutDurationSec,
      animation_intent: first.intent,
      shot_manifest: { ...(first.prompt.shot_manifest ?? {}), animation_intent: first.intent },
    };
    const direction = {
      image_id: first.prompt.image_id,
      scene_id: first.prompt.scene_id ?? null,
      visual_beat_id: first.prompt.visual_beat_id ?? null,
      animation_sequence_id: animationSequenceId,
      sequence_mode: "standalone_shot",
      start_sec: Number(first.prompt.start_sec ?? 0),
      cut_duration_sec: cutDurationSec,
      sequence_timeline_duration_sec: Number(cutDurationSec.toFixed(3)),
      requested_generation_duration_sec: clampLtxDuration(preferredDuration),
      source_image_path: first.imagePath,
      source_image_sha256: first.imageHash,
      source_prompt_sha256: sha256(JSON.stringify(first.prompt)),
      animation_intent: first.intent,
      coverage,
      start_frame_contract: {
        image_id: first.prompt.image_id,
        image_sha256: first.imageHash,
        state: first.intent.start_state,
        composition: first.intent.animation_ready_composition,
      },
      end_frame_contract: {
        provider_input: false,
        state: first.intent.end_state,
        camera_state: first.intent.camera_end_state,
        composition: first.intent.end_frame_composition,
        continuity_bridge: first.intent.continuity_bridge,
        next_start_image_id: next?.scene_id === first.prompt.scene_id ? next.image_id : null,
      },
      provider_image_inputs: ["init_image"],
      risk_class: first.risk,
      candidate_count: 1,
      scene_continuity: {
        previous_image_id: prior?.scene_id === first.prompt.scene_id ? prior.image_id : null,
        previous_action: prior?.scene_id === first.prompt.scene_id ? prior.visual_beat_action ?? null : null,
        next_image_id: next?.scene_id === first.prompt.scene_id ? next.image_id : null,
        next_action: next?.scene_id === first.prompt.scene_id ? next.visual_beat_action ?? null : null,
      },
      directed_prompt: directedPrompt,
      negative_prompt: ltxNegativePrompt(),
    };
    direction.motion_prompt = ltxMotionPromptForSequence(direction);
    return direction;
  });
  let directions = freshDirections;
  if (revalidateExisting) {
    if (existingPlan?.schema !== "goldflow_animation_direction_plan_v1" || existingPlan?.status !== "passed") {
      throw new Error(`Animation timing revalidation requires an existing passed direction plan: ${outputPath}`);
    }
    const existingDirections = Array.isArray(existingPlan.directions) ? existingPlan.directions : [];
    if (existingDirections.length !== freshDirections.length) {
      throw new Error(
        `Animation timing revalidation creative/hash mismatch: direction count changed (${existingDirections.length} -> ${freshDirections.length}).`,
      );
    }
    const existingIds = existingDirections.map((row) => String(row.image_id ?? ""));
    const freshIds = freshDirections.map((row) => String(row.image_id ?? ""));
    if (!jsonEqual(existingIds, freshIds) || new Set(existingIds).size !== existingIds.length) {
      throw new Error("Animation timing revalidation creative/hash mismatch: direction IDs or order changed.");
    }
    const existingFallbacks = Array.isArray(existingPlan.still_fallbacks) ? existingPlan.still_fallbacks : [];
    if (!jsonEqual(existingFallbacks, stillFallbacks)) {
      throw new Error("Animation timing revalidation creative/hash mismatch: still-fallback decisions changed.");
    }
    directions = existingDirections.map((existing, index) => {
      const fresh = freshDirections[index];
      assertAnimationDirectionCreativeIdentity(existing, fresh);
      return retimePreservedDirection(existing, fresh);
    });
  }
  const sourcePaths = [identityPath, beatPath, promptPath, imagegenPath, imageQaPath];
  const report = {
    schema: "goldflow_animation_direction_plan_v1",
    status: "passed",
    channel: revalidateExisting ? existingPlan.channel : channel,
    series_slug: revalidateExisting ? existingPlan.series_slug : series,
    week: revalidateExisting ? existingPlan.week : week,
    episode: revalidateExisting ? existingPlan.episode : episode,
    animation_policy: policy,
    provider: "modelslab",
    model_id: "ltx-2.3",
    source_paths: sourcePaths,
    source_hashes: Object.fromEntries(await Promise.all(sourcePaths.map(async (filePath) => [filePath, await hashFile(filePath)]))),
    direction_count: directions.length,
    candidate_generation_count: directions.length,
    selection_policy: "one_accepted_init_image_to_one_reachable_single_shot_v1",
    provider_image_inputs: ["init_image"],
    automatic_generation_retries: 0,
    still_fallback_count: stillFallbacks.length,
    still_fallbacks: stillFallbacks,
    no_suitable_motion_fallback: directions.length === 0 ? {
      disposition: "accepted_stills_for_all_cuts",
      reason: "No cut carried a complete reachable single-shot animation contract.",
    } : null,
    ui_policy: "ui_and_screen_shots_are_animation_eligible; exact_generated_text_legibility_not_required",
    directions,
    ...(revalidateExisting ? {
      timing_revalidated_without_creative_replan: true,
      timing_revalidated_at: new Date().toISOString(),
      preserved_direction_ids: true,
      preserved_motion_prompts: true,
    } : {}),
    updated_at: new Date().toISOString(),
  };
  await writeJson(outputPath, report);
  console.log(JSON.stringify({
    status: "passed",
    output_path: outputPath,
    direction_count: report.direction_count,
    candidate_generation_count: report.candidate_generation_count,
    timing_revalidated_without_creative_replan: revalidateExisting,
  }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    if (!revalidateExisting) {
      await writeJson(outputPath, {
        schema: "goldflow_animation_direction_plan_v1",
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        updated_at: new Date().toISOString(),
      }).catch(() => {});
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
