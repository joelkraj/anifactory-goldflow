#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCodexCli } from "./lib/codex-cli-runner.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const args = process.argv.slice(2);
const flags = parseFlags(args);

const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const weekDir = path.join(dataRoot, "channels", channel, "weekly_runs", week);
const episodeDir = path.join(weekDir, "episodes", episode);
const scriptPath = path.join(episodeDir, "script_clean.md");
const qwenReportPath = flags.qwenReport ?? flags["qwen-report"] ?? path.join(episodeDir, `audio_stitch_report_${episode}-modelslab-qwen.json`);
const wordTimingPath = flags.wordTiming ?? flags["word-timing"] ?? path.join(episodeDir, `narration_word_timing_${episode}.json`);
const scorePlanPath = flags.scorePlan ?? flags["score-plan"] ?? path.join(episodeDir, "score_chapter_plan.json");
const scoreDropPlanPath = flags.scoreDropPlan ?? flags["score-drop-plan"] ?? path.join(episodeDir, `score_drop_plan_${episode}.json`);
const reportPath = flags.report ?? path.join(episodeDir, `score_drop_chunked_planner_report_${episode}.json`);

const plannerName = "llm_audio_enrichment_v1";
const plannerVersion = 2;
const chunkSec = Number(flags["chunk-sec"] ?? 360);
const chunkOverlapSec = Number(flags["chunk-overlap-sec"] ?? 18);
const targetDrops = Number(flags["score-target-drops"] ?? flags.targetDrops ?? 72);
const minDropDurationSec = Number(flags["score-drop-min-duration-sec"] ?? 8);
const maxDropDurationSec = Number(flags["score-drop-max-duration-sec"] ?? 18);
const chunkConcurrency = Math.max(1, Math.min(6, Number(flags.concurrency ?? 3) || 3));
const dryRun = flags["dry-run"] === "true";

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

function nowIso() {
  return new Date().toISOString();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(filePath) {
  return fs.readFile(filePath).then((buffer) => sha256(buffer)).catch(() => null);
}

async function readText(filePath, fallback = "") {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return fallback;
  }
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function slug(value, fallback = "score_drop") {
  return String(value ?? fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 90) || fallback;
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
  throw new Error(`LLM output did not contain JSON: ${raw.slice(0, 500)}`);
}

function segmentStart(segment, cursor) {
  return Number.isFinite(Number(segment.start_sec)) ? Number(segment.start_sec) : cursor;
}

function timedSegments(qwenReport) {
  let cursor = 0;
  return (qwenReport.segments ?? []).map((segment) => {
    const start = segmentStart(segment, cursor);
    const duration = Number(segment.duration_sec ?? segment.raw_audio_duration_sec ?? 0) || 0;
    cursor = start + duration;
    return {
      segment_id: segment.segment_id,
      start_sec: Number(start.toFixed(3)),
      end_sec: Number((start + duration).toFixed(3)),
      duration_sec: Number(duration.toFixed(3)),
      text: String(segment.caption_text ?? segment.stripped_text ?? segment.text ?? "").slice(0, 950),
    };
  });
}

function buildChunks(segments, durationSec) {
  const chunks = [];
  for (let start = 0; start < durationSec; start += chunkSec) {
    const end = Math.min(durationSec, start + chunkSec);
    const contextStart = Math.max(0, start - chunkOverlapSec);
    const contextEnd = Math.min(durationSec, end + chunkOverlapSec);
    const chunkSegments = segments.filter((segment) => segment.end_sec >= contextStart && segment.start_sec <= contextEnd);
    chunks.push({
      chunk_id: `score_chunk_${String(chunks.length + 1).padStart(2, "0")}`,
      start_sec: Number(start.toFixed(3)),
      end_sec: Number(end.toFixed(3)),
      context_start_sec: Number(contextStart.toFixed(3)),
      context_end_sec: Number(contextEnd.toFixed(3)),
      target_drop_count: Math.max(3, Math.round(((end - start) / durationSec) * targetDrops)),
      segments: chunkSegments,
    });
  }
  return chunks;
}

function promptForChunk({ chunk, durationSec, scriptExcerpt }) {
  return `You are planning ONLY cinematic score drops for an AniFactory manhwa recap episode.

Return one valid JSON object only. Do not include markdown.

Episode score goal:
- This is a high-retention longform narration mix.
- Plan moment-directed local ACE-Step 1.5 score drops only, not continuous music beds.
- Use music on shame, threat, reveal, refusal, system warning, manipulation, reversal, public speech, collapse, redemption, payoff, and cliffhanger beats.
- Do not score every scene turn. Do not create generic background beds.
- Each drop should feel held and intentional, usually ${minDropDurationSec}-${maxDropDurationSec} seconds.
- Instrumental only: no lyrics, no vocals, no speech, no crowd noise.
- Palette for this episode: dark royal-capital system drama, glass tower dread, attention economy, corporate/digital throne pressure, elegant dark synth, low taiko/sub pulse, bowed metal, cold glass shimmer, broadcast-screen resonance.
- Prompts must be concrete music prompts for ACE-Step, not story summaries.

Chunk:
${JSON.stringify({
  chunk_id: chunk.chunk_id,
  plan_window_sec: [chunk.start_sec, chunk.end_sec],
  context_window_sec: [chunk.context_start_sec, chunk.context_end_sec],
  target_drop_count: chunk.target_drop_count,
  full_episode_duration_sec: durationSec,
}, null, 2)}

Use start_sec inside the plan_window only. Context outside the plan window is for continuity only.

Nearby script excerpt:
${scriptExcerpt}

Timed narration segments:
${JSON.stringify(chunk.segments, null, 2)}

Return:
{
  "score_drops": [
    {
      "drop_id": "short_unique_snake_case_id",
      "segment_id": "voice_seg_001",
      "target_phrase": "exact spoken words inside that segment",
      "start_sec": 123.456,
      "duration_sec": 12,
      "gain_db": -18,
      "score_intent": "specific musical intent",
      "story_function": "hook pressure | reveal | reversal | speech payoff | cliffhanger | etc",
      "intensity_score": 1,
      "ace_step_prompt": "instrumental cinematic score drop, concrete instruments/textures, no vocals, no speech",
      "beat_reason": "why this moment earns music"
    }
  ],
  "warnings": []
}`;
}

async function callCodex(prompt, stageName) {
  const model = flags.model ?? flags["llm-model"] ?? process.env.ANIFACTORY_SCORE_PLANNER_CODEX_MODEL ?? "";
  const reasoningEffort = flags["reasoning-effort"] ?? process.env.ANIFACTORY_SCORE_PLANNER_REASONING_EFFORT ?? "medium";
  const callDir = path.join(weekDir, "_codex_calls");
  await fs.mkdir(callDir, { recursive: true });
  const stamp = nowIso().replace(/[:.]/g, "-");
  const promptPath = path.join(callDir, `${stamp}-${stageName}-prompt.md`);
  const outputPath = path.join(callDir, `${stamp}-${stageName}-output.txt`);
  await fs.writeFile(promptPath, prompt, "utf8");
  const call = await runCodexCli({
    prompt,
    stageName,
    repoRoot,
    outputPath,
    model: model || null,
    reasoningEffort,
    timeoutMs: Number(process.env.ANIFACTORY_SCORE_PLANNER_CODEX_TIMEOUT_MS ?? 900_000),
    detached: true,
  });
  return {
    provider: "codex",
    model: call.model,
    reasoning_effort: call.reasoning_effort,
    codex_cli_path: call.codex_cli_path,
    codex_cli_version: call.codex_cli_version,
    prompt_path: promptPath,
    output_path: outputPath,
    parsed: extractJson(call.content),
  };
}

async function runLimited(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function normalizeDrop(drop, index, chunk, validSegmentIds, durationSec) {
  const segmentId = String(drop.segment_id ?? "");
  const fallbackSegment = chunk.segments.find((segment) => segment.start_sec >= chunk.start_sec && segment.start_sec <= chunk.end_sec) ?? chunk.segments[0] ?? {};
  const start = Math.max(chunk.start_sec, Math.min(chunk.end_sec, Number(drop.start_sec ?? fallbackSegment.start_sec ?? chunk.start_sec) || chunk.start_sec));
  const duration = Math.max(minDropDurationSec, Math.min(maxDropDurationSec, Number(drop.duration_sec ?? 12) || 12, Math.max(0.5, durationSec - start)));
  const idBase = slug(drop.drop_id ?? `${chunk.chunk_id}_${index + 1}`, `${chunk.chunk_id}_${index + 1}`);
  return {
    drop_id: `chunked_${idBase}`,
    event_id: `chunked_${idBase}`,
    segment_id: validSegmentIds.has(segmentId) ? segmentId : String(fallbackSegment.segment_id ?? segmentId),
    offset_sec: Math.max(0, Number(drop.offset_sec ?? 0) || 0),
    start_sec: Number(start.toFixed(3)),
    duration_sec: Number(duration.toFixed(3)),
    gain_db: Number.isFinite(Number(drop.gain_db)) ? Number(drop.gain_db) : -18,
    score_intent: String(drop.score_intent ?? "dramatic_score_drop"),
    story_function: String(drop.story_function ?? "focal dramatic beat"),
    intensity_score: Math.max(1, Math.min(10, Number(drop.intensity_score ?? 7) || 7)),
    ace_step_prompt: String(drop.ace_step_prompt ?? "instrumental cinematic score drop, low sub pulse, bowed metal tension, cold glass shimmer, no vocals, no speech"),
    target_phrase: String(drop.target_phrase ?? drop.anchor_phrase ?? drop.anchor_text ?? "").trim(),
    beat_reason: String(drop.beat_reason ?? "Chunked LLM-selected dramatic score drop"),
    planner: "llm_audio_enrichment_v1",
    planner_chunk_id: chunk.chunk_id,
  };
}

function dedupeDrops(drops) {
  const sorted = [...drops].sort((left, right) => left.start_sec - right.start_sec);
  const kept = [];
  for (const drop of sorted) {
    const near = kept.find((existing) => Math.abs(existing.start_sec - drop.start_sec) < 5);
    if (near) {
      if (drop.intensity_score > near.intensity_score) {
        const index = kept.indexOf(near);
        kept[index] = drop;
      }
      continue;
    }
    kept.push(drop);
  }
  return kept;
}

async function main() {
  const [script, qwenReport, wordTiming] = await Promise.all([
    readText(scriptPath),
    readJson(qwenReportPath, null),
    readJson(wordTimingPath, null),
  ]);
  if (!script.trim()) throw new Error(`Missing script: ${scriptPath}`);
  if (!Array.isArray(qwenReport?.segments) || !qwenReport.segments.length) throw new Error(`Missing Qwen stitch segments: ${qwenReportPath}`);
  if (wordTiming?.status !== "passed" || !Array.isArray(wordTiming.words) || !wordTiming.words.length) {
    throw new Error(`Refusing chunked score planning without passed local Whisper timing: ${wordTimingPath}`);
  }
  const sourceScriptHash = sha256(script);
  const narrationPath = qwenReport.output_path ?? null;
  const narrationAudioHash = narrationPath ? await hashFile(narrationPath) : null;
  const segments = timedSegments(qwenReport);
  const durationSec = Number(wordTiming.audio_duration_sec ?? qwenReport.final_duration_sec ?? segments.at(-1)?.end_sec ?? 0);
  const chunks = buildChunks(segments, durationSec);
  const validSegmentIds = new Set(segments.map((segment) => String(segment.segment_id)));
  const scriptExcerpt = script.slice(0, 2200);

  const calls = dryRun
    ? chunks.map((chunk) => ({ chunk, llm: { provider: "dry_run", model: "none", parsed: { score_drops: [], warnings: [] } } }))
    : await runLimited(chunks, chunkConcurrency, async (chunk) => {
      const prompt = promptForChunk({ chunk, durationSec, scriptExcerpt });
      console.error(`[score-planner] ${chunk.chunk_id} ${chunk.start_sec}-${chunk.end_sec}s target ${chunk.target_drop_count}`);
      const llm = await callCodex(prompt, `${episode}_${chunk.chunk_id}_score_drop_plan`);
      return { chunk, llm };
    });

  const normalized = [];
  const warnings = [];
  const llmCalls = [];
  for (const row of calls) {
    const drops = Array.isArray(row.llm.parsed?.score_drops) ? row.llm.parsed.score_drops : [];
    drops.forEach((drop, index) => normalized.push(normalizeDrop(drop, index, row.chunk, validSegmentIds, durationSec)));
    warnings.push(...(row.llm.parsed?.warnings ?? []).map((warning) => `${row.chunk.chunk_id}: ${warning}`));
    llmCalls.push({
      chunk_id: row.chunk.chunk_id,
      provider: row.llm.provider,
      model: row.llm.model,
      prompt_path: row.llm.prompt_path ?? null,
      output_path: row.llm.output_path ?? null,
      raw_drop_count: drops.length,
    });
  }
  const drops = dedupeDrops(normalized).slice(0, Math.max(1, targetDrops + 12));
  const timingGate = {
    status: "passed",
    issues: [],
    path: wordTimingPath,
    source_script_hash: wordTiming.source_script_hash ?? null,
    narration_audio_hash: wordTiming.narration_audio_hash ?? null,
    current_narration_audio_hash: narrationAudioHash,
    audio_duration_sec: Number(durationSec.toFixed(3)),
    word_count: wordTiming.word_count ?? wordTiming.words.length,
  };
  const sourceHashes = Object.fromEntries((await Promise.all([scriptPath, qwenReportPath, wordTimingPath].map(async (filePath) => [filePath, await hashFile(filePath)]))).filter(([, hash]) => hash));

  const scorePlan = {
    status: "passed",
    ok: true,
    planner: plannerName,
    planner_version: plannerVersion,
    purpose: "Chunked score-only planning run: no continuous score beds, only local ACE-Step drops on dramatic retention beats.",
    channel,
    series_slug: series,
    week,
    episode,
    source_script_hash: sourceScriptHash,
    source_script_path: scriptPath,
    source_artifact_paths: [scriptPath, qwenReportPath, wordTimingPath],
    source_hashes: sourceHashes,
    timing_source: "local_whisper_word_timing",
    timing_gate: timingGate,
    target_runtime_minutes: Number((durationSec / 60).toFixed(2)),
    estimated_audio_duration_sec: Number(durationSec.toFixed(3)),
    score_density_policy: {
      target: "Drops-only retained-audience scoring; chunked LLM calls avoid full-episode prompt collapse.",
      chapter_count: 0,
      publish_requirement: "No continuous score beds are generated or mixed for this run.",
    },
    engine_hint: "Local ACE-Step 1.5 score generation through scripts/ace-step-score-generate.py",
    score_provider: "local_ace_step",
    score_disabled: false,
    score_model_id: process.env.ANIFACTORY_ACE_STEP_CONFIG_PATH ?? "acestep-v15-turbo",
    score_lm_model_id: process.env.ANIFACTORY_ACE_STEP_LM_MODEL ?? "acestep-5Hz-lm-1.7B",
    score_endpoint: "local:ace-step-1.5",
    global_rules: [
      "Instrumental only: no vocals, lyrics, speech, or crowd noise.",
      "Narration remains dominant.",
      "Drops are moment-directed and do not create continuous background music.",
    ],
    palette: {
      music_palette: ["dark royal-capital system drama", "cold glass shimmer", "low taiko/sub pulse", "bowed-metal dread", "broadcast-screen resonance"],
    },
    chapters: [],
    warnings,
    updated_at: nowIso(),
  };

  const scoreDropPlan = {
    status: drops.length ? "passed" : "failed",
    planner: plannerName,
    planner_version: plannerVersion,
    purpose: "Chunked drops-only score plan: local ACE-Step scoring cues for retention beats across the full episode.",
    channel,
    series_slug: series,
    week,
    episode,
    source_script_hash: sourceScriptHash,
    source_script_path: scriptPath,
    timing_source: "local_whisper_word_timing",
    timing_gate: timingGate,
    score_provider: "local_ace_step",
    score_model_id: process.env.ANIFACTORY_ACE_STEP_CONFIG_PATH ?? "acestep-v15-turbo",
    score_lm_model_id: process.env.ANIFACTORY_ACE_STEP_LM_MODEL ?? "acestep-5Hz-lm-1.7B",
    endpoint: "local:ace-step-1.5",
    density_policy: `Chunked planning target ${targetDrops} drops; actual ${drops.length} after dedupe.`,
    mix_policy: "Longform mixer fades each drop in/out; no chapter beds are mixed.",
    drops,
    warnings,
    updated_at: nowIso(),
  };

  const report = {
    status: scoreDropPlan.status,
    planner: "chunked_score_drop_planner_v1",
    channel,
    series_slug: series,
    week,
    episode,
    chunk_count: chunks.length,
    target_drops: targetDrops,
    drop_count: drops.length,
    chunk_sec: chunkSec,
    chunk_overlap_sec: chunkOverlapSec,
    concurrency: chunkConcurrency,
    llm_calls: llmCalls,
    score_plan_path: scorePlanPath,
    score_drop_plan_path: scoreDropPlanPath,
    timing_gate: timingGate,
    updated_at: nowIso(),
  };

  if (!dryRun) {
    await writeJson(scorePlanPath, scorePlan);
    await writeJson(scoreDropPlanPath, scoreDropPlan);
  }
  await writeJson(reportPath, report);
  console.log(JSON.stringify({ status: report.status, drop_count: drops.length, report_path: reportPath, score_drop_plan_path: scoreDropPlanPath }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
