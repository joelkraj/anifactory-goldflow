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

function riskAndCandidateCount(intent, prompt) {
  const highRisk = ["physical_contact", "locomotion_action", "effect_or_impact"].includes(intent.shot_class);
  const denseCast = (prompt.shot_manifest?.visible_characters ?? []).length >= 3;
  return {
    risk: highRisk || denseCast ? "high" : ["dialogue_pair", "ui_or_screen"].includes(intent.shot_class) ? "medium" : "low",
    candidate_count: highRisk || denseCast ? 3 : ["dialogue_pair", "ui_or_screen"].includes(intent.shot_class) ? 2 : 1,
  };
}

function sequenceCompatible(left, right, currentDurationSec) {
  if (!left?.intent?.sequence_eligible_with_next || !right) return false;
  if (Number(right.index) !== Number(left.index) + 1) return false;
  if (left.prompt.scene_id !== right.prompt.scene_id) return false;
  if ((left.prompt.depiction_mode ?? null) !== (right.prompt.depiction_mode ?? null)) return false;
  const leftLocation = left.prompt.shot_manifest?.location_id ?? left.beat?.location_id ?? null;
  const rightLocation = right.prompt.shot_manifest?.location_id ?? right.beat?.location_id ?? null;
  if (leftLocation !== rightLocation) return false;
  const nextDuration = Number(right.prompt.duration_sec ?? 0);
  return currentDurationSec + Math.max(0, nextDuration) <= 12;
}

async function main() {
  const [identity, beatPlan, promptPlan, imagegen, imageQa] = await Promise.all([
    readJson(identityPath),
    readJson(beatPath),
    readJson(promptPath),
    readJson(imagegenPath),
    readJson(imageQaPath),
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
  for (const [index, prompt] of eligiblePrompts.entries()) {
    const beat = beatById.get(String(prompt.visual_beat_id ?? ""));
    const intent = sanitizeAnimationIntent(prompt.shot_manifest?.animation_intent ?? beat?.animation_intent);
    if (!intent) throw new Error(`Animation-enabled cut ${prompt.image_id} has no valid beat-authored animation_intent.`);
    if (policy === "selective_ltx23" && intent.eligibility !== "animate") continue;
    const image = imageById.get(String(prompt.image_id ?? ""));
    const imagePath = image?.image_path ? path.resolve(image.image_path) : null;
    const imageHash = imagePath ? await hashFile(imagePath) : null;
    if (!imagePath || !imageHash || accepted[prompt.image_id] !== imageHash) {
      throw new Error(`Animation direction requires the current accepted image hash for ${prompt.image_id}.`);
    }
    const risk = riskAndCandidateCount(intent, prompt);
    candidates.push({ index, prompt, beat, intent, imagePath, imageHash, risk });
  }
  const groups = [];
  for (let index = 0; index < candidates.length;) {
    const group = [candidates[index]];
    let durationSec = Math.max(0, Number(candidates[index].prompt.duration_sec ?? 0));
    while (index + group.length < candidates.length) {
      const left = group.at(-1);
      const right = candidates[index + group.length];
      if (!sequenceCompatible(left, right, durationSec)) break;
      group.push(right);
      durationSec += Math.max(0, Number(right.prompt.duration_sec ?? 0));
    }
    groups.push(group);
    index += group.length;
  }
  const directions = groups.map((group, groupIndex) => {
    const first = group[0];
    const last = group.at(-1);
    let offsetSec = 0;
    const coverage = group.map((row) => {
      const durationSec = Math.max(0.001, Number(row.prompt.duration_sec ?? 0));
      const covered = {
        image_id: row.prompt.image_id,
        image_sha256: row.imageHash,
        visual_beat_id: row.prompt.visual_beat_id ?? null,
        timeline_duration_sec: durationSec,
        source_offset_sec: Number(offsetSec.toFixed(3)),
        source_end_offset_sec: Number((offsetSec + durationSec).toFixed(3)),
        foreground_action: row.prompt.visual_beat_action ?? row.beat?.foreground_action ?? null,
        animation_intent: row.intent,
      };
      offsetSec += durationSec;
      return covered;
    });
    const preferredDuration = Math.max(
      offsetSec,
      ...group.map((row) => Number(row.intent.preferred_generation_duration_sec ?? 5)),
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
    const animationSequenceId = `ltx-seq-${String(groupIndex + 1).padStart(4, "0")}-${sha256(JSON.stringify(sequenceIdentity)).slice(0, 12)}`;
    const prior = eligiblePrompts[first.index - 1];
    const next = eligiblePrompts[last.index + 1];
    const directedPrompt = {
      ...first.prompt,
      duration_sec: offsetSec,
      animation_intent: first.intent,
      shot_manifest: { ...(first.prompt.shot_manifest ?? {}), animation_intent: first.intent },
    };
    const direction = {
      image_id: first.prompt.image_id,
      scene_id: first.prompt.scene_id ?? null,
      visual_beat_id: first.prompt.visual_beat_id ?? null,
      animation_sequence_id: animationSequenceId,
      sequence_mode: group.length > 1 ? "continuous_scene_sequence" : "standalone_shot",
      start_sec: Number(first.prompt.start_sec ?? 0),
      cut_duration_sec: Number(first.prompt.duration_sec ?? 5),
      sequence_timeline_duration_sec: Number(offsetSec.toFixed(3)),
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
        state: last.intent.end_state,
        camera_state: last.intent.camera_end_state,
        composition: last.intent.end_frame_composition,
        continuity_bridge: last.intent.continuity_bridge,
        next_start_image_id: next?.scene_id === last.prompt.scene_id ? next.image_id : null,
      },
      risk_class: group.some((row) => row.risk.risk === "high")
        ? "high"
        : group.some((row) => row.risk.risk === "medium") ? "medium" : "low",
      candidate_count: Math.max(...group.map((row) => row.risk.candidate_count)),
      scene_continuity: {
        previous_image_id: prior?.scene_id === first.prompt.scene_id ? prior.image_id : null,
        previous_action: prior?.scene_id === first.prompt.scene_id ? prior.visual_beat_action ?? null : null,
        next_image_id: next?.scene_id === last.prompt.scene_id ? next.image_id : null,
        next_action: next?.scene_id === last.prompt.scene_id ? next.visual_beat_action ?? null : null,
      },
      directed_prompt: directedPrompt,
      negative_prompt: ltxNegativePrompt(),
    };
    direction.motion_prompt = ltxMotionPromptForSequence(direction);
    return direction;
  });
  if (!directions.length) throw new Error("Animation policy selected no cuts.");
  const sourcePaths = [identityPath, beatPath, promptPath, imagegenPath, imageQaPath];
  const report = {
    schema: "goldflow_animation_direction_plan_v1",
    status: "passed",
    channel,
    series_slug: series,
    week,
    episode,
    animation_policy: policy,
    provider: "modelslab",
    model_id: "ltx-2.3",
    source_paths: sourcePaths,
    source_hashes: Object.fromEntries(await Promise.all(sourcePaths.map(async (filePath) => [filePath, await hashFile(filePath)]))),
    direction_count: directions.length,
    candidate_generation_count: directions.reduce((sum, row) => sum + row.candidate_count, 0),
    ui_policy: "ui_and_screen_shots_are_animation_eligible; exact_generated_text_legibility_not_required",
    directions,
    updated_at: new Date().toISOString(),
  };
  await writeJson(outputPath, report);
  console.log(JSON.stringify({
    status: "passed",
    output_path: outputPath,
    direction_count: report.direction_count,
    candidate_generation_count: report.candidate_generation_count,
  }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    await writeJson(outputPath, {
      schema: "goldflow_animation_direction_plan_v1",
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      updated_at: new Date().toISOString(),
    }).catch(() => {});
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
