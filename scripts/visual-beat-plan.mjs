#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeDir = path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode);
const timedPlanPath = flags.timed ?? path.join(episodeDir, "timed_scene_plan.json");
const scriptPath = flags.script ?? path.join(episodeDir, "script_clean.md");
const outputPath = flags.output ?? path.join(episodeDir, "visual_beat_plan.json");
const targetBeatSec = Number(flags["target-beat-sec"] ?? process.env.ANIFACTORY_VISUAL_TARGET_BEAT_SEC ?? 8.5);
const maxBeatSec = Number(flags["max-beat-sec"] ?? process.env.ANIFACTORY_VISUAL_MAX_BEAT_SEC ?? 15);
const minBeatSec = Number(flags["min-beat-sec"] ?? process.env.ANIFACTORY_VISUAL_MIN_BEAT_SEC ?? 3);
const hookDurationSec = Number(flags["hook-duration-sec"] ?? process.env.ANIFACTORY_VISUAL_HOOK_DURATION_SEC ?? 30);
const hookTargetBeatSec = Number(flags["hook-target-beat-sec"] ?? process.env.ANIFACTORY_VISUAL_HOOK_TARGET_BEAT_SEC ?? 3.2);
const hookMaxBeatSec = Number(flags["hook-max-beat-sec"] ?? process.env.ANIFACTORY_VISUAL_HOOK_MAX_BEAT_SEC ?? 4.2);
const hookMinBeatSec = Number(flags["hook-min-beat-sec"] ?? process.env.ANIFACTORY_VISUAL_HOOK_MIN_BEAT_SEC ?? 2.2);
const retentionRampSec = Number(flags["retention-ramp-sec"] ?? process.env.ANIFACTORY_VISUAL_RETENTION_RAMP_SEC ?? 180);
const rampTargetBeatSec = Number(flags["ramp-target-beat-sec"] ?? process.env.ANIFACTORY_VISUAL_RAMP_TARGET_BEAT_SEC ?? 5.2);
const rampMaxBeatSec = Number(flags["ramp-max-beat-sec"] ?? process.env.ANIFACTORY_VISUAL_RAMP_MAX_BEAT_SEC ?? 6.5);
const rampMinBeatSec = Number(flags["ramp-min-beat-sec"] ?? process.env.ANIFACTORY_VISUAL_RAMP_MIN_BEAT_SEC ?? 3.2);

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

function beatDurations(scene) {
  const duration = Math.max(1, Number(scene.duration_sec ?? 0));
  const start = Math.max(0, Number(scene.start_sec ?? 0));
  const subjects = Array.isArray(scene.visible_subjects) ? scene.visible_subjects.length : 0;
  const hasAction = /\b(?:fight|combat|attack|horde|swarm|monster|gate|break|strike|kill|collapse|rescue|chase|battle|explosion|impact|fall|run|lunge|dodge|pull)\b/i
    .test([scene.title, scene.visual_intent, scene.action_staging, ...(scene.sfx_cues ?? [])].filter(Boolean).join(" "));
  const target = hasAction || subjects >= 4 ? Math.min(targetBeatSec, 14) : targetBeatSec;
  const durations = [];
  const pushEven = (total, count) => {
    const each = total / count;
    for (let index = 0; index < count; index += 1) durations.push(each);
  };
  if (start < hookDurationSec) {
    const hookPortion = Math.min(duration, Math.max(0, hookDurationSec - start));
    if (hookPortion > 0) {
      const hookCount = Math.max(
        1,
        Math.ceil(hookPortion / Math.max(hookMinBeatSec, hookTargetBeatSec)),
        Math.ceil(hookPortion / Math.max(hookMinBeatSec, hookMaxBeatSec)),
      );
      pushEven(hookPortion, hookCount);
    }
    const rest = duration - hookPortion;
    if (rest > 0.001) {
      if (rest <= maxBeatSec) durations.push(rest);
      else pushEven(rest, Math.max(2, Math.ceil(rest / Math.max(minBeatSec, target))));
    }
    return durations;
  }
  if (start < retentionRampSec) {
    const rampPortion = Math.min(duration, Math.max(0, retentionRampSec - start));
    if (rampPortion > 0) {
      const rampCount = Math.max(
        1,
        Math.ceil(rampPortion / Math.max(rampMinBeatSec, rampTargetBeatSec)),
        Math.ceil(rampPortion / Math.max(rampMinBeatSec, rampMaxBeatSec)),
      );
      pushEven(rampPortion, rampCount);
    }
    const rest = duration - rampPortion;
    if (rest > 0.001) {
      if (rest <= maxBeatSec) durations.push(rest);
      else pushEven(rest, Math.max(2, Math.ceil(rest / Math.max(minBeatSec, target))));
    }
    return durations;
  }
  if (duration <= maxBeatSec) return [duration];
  pushEven(duration, Math.max(2, Math.ceil(duration / Math.max(minBeatSec, target))));
  return durations;
}

function beatFocusLabel(index, count, startSec = null) {
  if (Number.isFinite(Number(startSec)) && Number(startSec) < hookDurationSec) {
    const hookLabels = [
      "hook visual punch: immediate high-contrast premise image",
      "hook reversal beat with changed camera angle and visible stakes",
      "hook escalation beat with new subject, new prop, or system/story reveal",
      "hook reaction beat: readable face, hand, crowd, or UI consequence",
      "hook payoff beat that forces the next click-forward question",
    ];
    return hookLabels[index % hookLabels.length];
  }
  if (Number.isFinite(Number(startSec)) && Number(startSec) < retentionRampSec) {
    const rampLabels = [
      "retention ramp: new story information with changed composition",
      "retention ramp: emotional reaction or social proof beat",
      "retention ramp: system/threat/status reveal beat",
      "retention ramp: movement beat that pulls viewer to the next question",
    ];
    return rampLabels[index % rampLabels.length];
  }
  if (count === 1) return "single establishing visual beat";
  if (index === 0) return "establish current location, visible subjects, and spatial relationship";
  if (index === count - 1) return "end-state beat showing the scene consequence or reveal";
  if (count === 2) return "reaction or action progression beat";
  const middle = index / Math.max(1, count - 1);
  if (middle < 0.4) return "early action beat with clear subject motion and readable staging";
  if (middle < 0.75) return "middle escalation beat with changed pose, changed camera angle, and current-scene action";
  return "late action beat with consequence, reaction, or UI/story reveal";
}

function splitSentences(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .match(/[^.!?]+[.!?]+|[^.!?]+$/g)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) ?? [];
}

function sceneTextFromAnchors(scriptText, scene, searchFrom = 0) {
  const startAnchor = String(scene.script_excerpt_start ?? "").trim();
  const endAnchor = String(scene.script_excerpt_end ?? "").trim();
  if (!scriptText || !startAnchor || !endAnchor) return "";
  let start = scriptText.indexOf(startAnchor, Math.max(0, searchFrom));
  if (start < 0) start = scriptText.indexOf(startAnchor);
  if (start < 0) return "";
  const end = scriptText.indexOf(endAnchor, start);
  if (end < 0) return "";
  return scriptText.slice(start, end + endAnchor.length).trim();
}

function splitSceneText(sceneText, count) {
  const sentences = splitSentences(sceneText);
  if (!sentences.length) return Array.from({ length: count }, () => "");
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor(index * sentences.length / count);
    const end = Math.max(start + 1, Math.floor((index + 1) * sentences.length / count));
    return sentences.slice(start, end).join(" ");
  });
}

function compactBeatAction(text, fallback) {
  const cleaned = String(text || fallback || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return fallback;
  return cleaned.length > 360 ? `${cleaned.slice(0, 357).trim()}...` : cleaned;
}

function splitScene(scene, scriptText, searchFrom = 0) {
  const durations = beatDurations(scene);
  const count = durations.length;
  const duration = Math.max(1, Number(scene.duration_sec ?? 0));
  const start = Number(scene.start_sec ?? 0);
  const sceneText = sceneTextFromAnchors(scriptText, scene, searchFrom);
  const beatTexts = splitSceneText(sceneText, count);
  const beats = [];
  let cursor = start;
  for (let index = 0; index < count; index += 1) {
    const beatStart = cursor;
    const beatEnd = index === count - 1 ? start + duration : cursor + durations[index];
    const focus = beatFocusLabel(index, count, beatStart);
    beats.push({
      ...scene,
      visual_beat_id: `${scene.scene_id}_beat_${String(index + 1).padStart(2, "0")}`,
      parent_scene_id: scene.scene_id,
      scene_id: scene.scene_id,
      beat_index: index + 1,
      beat_count: count,
      start_sec: Number(beatStart.toFixed(3)),
      end_sec: Number(beatEnd.toFixed(3)),
      duration_sec: Number(Math.max(1, beatEnd - beatStart).toFixed(3)),
      visual_beat_focus: focus,
      visual_beat_script_excerpt: beatTexts[index] ?? "",
      visual_beat_action: compactBeatAction(beatTexts[index], focus),
      hook_visual: beatStart < hookDurationSec,
      retention_ramp_visual: beatStart >= hookDurationSec && beatStart < retentionRampSec,
      hook_visual_intent: beatStart < hookDurationSec
        ? "fast opening retention cut: new information, new composition, and transition-ready motion"
        : null,
      retention_ramp_intent: beatStart >= hookDurationSec && beatStart < retentionRampSec
        ? "first-three-minutes retention cut: keep visual novelty and story momentum without hook-level chaos"
        : null,
      image_id_hint: `${episode}-cut-${String(beats.length + 1).padStart(3, "0")}`,
    });
    cursor = beatEnd;
  }
  return { beats, sceneText };
}

async function main() {
  const [timedPlan, scriptText] = await Promise.all([
    readJson(timedPlanPath, null),
    fs.readFile(scriptPath, "utf8").catch(() => ""),
  ]);
  if (timedPlan?.status !== "passed" || !Array.isArray(timedPlan.scenes) || !timedPlan.scenes.length) throw new Error(`Missing passed timed scene plan: ${timedPlanPath}`);
  const beats = [];
  let scriptCursor = 0;
  for (const scene of timedPlan.scenes) {
    const result = splitScene(scene, scriptText, scriptCursor);
    for (const beat of result.beats) beats.push(beat);
    if (result.sceneText) {
      const start = scriptText.indexOf(result.sceneText, scriptCursor);
      if (start >= 0) scriptCursor = start + result.sceneText.length;
    }
  }
  const numberedBeats = beats.map((beat, index) => ({
    ...beat,
    image_id_hint: `${episode}-cut-${String(index + 1).padStart(3, "0")}`,
  }));
  const report = {
    schema: "goldflow_visual_beat_plan_v1",
    status: "passed",
    channel,
    series_slug: series,
    week,
    episode,
    source_script_hash: timedPlan.source_script_hash,
    source_artifact_paths: [timedPlanPath, scriptPath],
    source_hashes: Object.fromEntries((await Promise.all([timedPlanPath, scriptPath].map(async (filePath) => [filePath, await hashFile(filePath)]))).filter(([, hash]) => hash)),
    timing_source: timedPlan.timing_source,
    audio_duration_sec: timedPlan.audio_duration_sec,
    scene_count: timedPlan.scenes.length,
    visual_beat_count: numberedBeats.length,
    hook_duration_sec: hookDurationSec,
    hook_visual_beat_count: numberedBeats.filter((beat) => Number(beat.start_sec) < hookDurationSec).length,
    retention_ramp_sec: retentionRampSec,
    retention_ramp_visual_beat_count: numberedBeats.filter((beat) => Number(beat.start_sec) >= hookDurationSec && Number(beat.start_sec) < retentionRampSec).length,
    policy: "Split timed semantic scenes into visual beats before image prompt authoring. Beats preserve scene facts, Whisper timing, and a local script excerpt for each beat; LLM still authors the final prompt.",
    beat_settings: {
      target_beat_sec: targetBeatSec,
      max_beat_sec: maxBeatSec,
      min_beat_sec: minBeatSec,
      hook_duration_sec: hookDurationSec,
      hook_target_beat_sec: hookTargetBeatSec,
      hook_max_beat_sec: hookMaxBeatSec,
      hook_min_beat_sec: hookMinBeatSec,
      retention_ramp_sec: retentionRampSec,
      ramp_target_beat_sec: rampTargetBeatSec,
      ramp_max_beat_sec: rampMaxBeatSec,
      ramp_min_beat_sec: rampMinBeatSec,
    },
    beats: numberedBeats,
    updated_at: new Date().toISOString(),
  };
  await writeJson(outputPath, report);
  console.log(JSON.stringify({ status: report.status, output_path: outputPath, scene_count: report.scene_count, visual_beat_count: report.visual_beat_count }, null, 2));
}

main().catch(async (error) => {
  await writeJson(outputPath, { schema: "goldflow_visual_beat_plan_v1", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() }).catch(() => {});
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
