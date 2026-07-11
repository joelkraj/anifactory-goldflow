#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCodexCli } from "./lib/codex-cli-runner.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const weekDir = path.join(dataRoot, "channels", channel, "weekly_runs", week);
const episodeDir = path.join(weekDir, "episodes", episode);
const promptPlanPath = flags.prompts ?? path.join(episodeDir, "section_image_prompts_hardened.json");
const wordTimingPath = flags.wordTiming ?? flags["word-timing"] ?? path.join(episodeDir, `narration_word_timing_${episode}.json`);
const outputPath = flags.output ?? path.join(episodeDir, `engagement_overlay_plan_${episode}.json`);
const dryRun = flags["dry-run"] === "true";
const maxEvents = Math.max(0, Math.min(12, Number(flags["max-events"] ?? 7)));

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

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function hashFile(filePath) {
  return fs.readFile(filePath).then((buffer) => sha256(buffer)).catch(() => null);
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
  throw new Error(`LLM output did not contain JSON: ${raw.slice(0, 500)}`);
}

function promptTextBundle(prompt) {
  return [
    prompt.image_id,
    prompt.scene_id,
    prompt.visual_beat_focus,
    prompt.visual_beat_action,
    prompt.visual_beat_script_excerpt,
    prompt.shot_manifest?.shot_job,
    prompt.shot_manifest?.foreground_action,
    prompt.primary_subject,
    ...(prompt.visible_subjects ?? []),
  ].filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 1000);
}

function buildCandidates(prompts) {
  const candidates = [];
  for (const prompt of prompts) {
    const start = Number(prompt.start_sec);
    if (!Number.isFinite(start)) continue;
    const text = promptTextBundle(prompt);
    const hookRamp = start >= 45 && start < 180;
    const important = /\b(system|warning|phase|throne|crown|mirror|god|goddess|offer|refuse|choice|comment|collapse|reveal|betrayal|simp|humiliate|king|army|death|final|federa|city|capital)\b/i.test(text);
    const lateCta = start > 0 && start > (Number(prompts.at(-1)?.start_sec ?? 0) * 0.82);
    if (!hookRamp && !important && !lateCta) continue;
    candidates.push({
      image_id: prompt.image_id,
      scene_id: prompt.scene_id,
      start_sec: Number(start.toFixed(3)),
      duration_sec: Number(prompt.duration_sec ?? 6),
      in_retention_ramp: start >= 30 && start < 180,
      context: text,
    });
  }
  return candidates.slice(0, 220);
}

function buildPrompt(candidates, audioDuration) {
  return `You are the retention editor for a longform AniFactory manhwa recap.

Return one valid JSON object only. Do not include markdown.

Task:
- Choose the best moments for comment/like/subscribe engagement overlays.
- These overlays are render-layer bubbles, not scene-image prompts and not narration.
- Keep them rare enough to feel hand placed, not spammy.
- The best overlays ask viewers to take a side, predict a choice, or comment a judgment at a high-curiosity moment.

Rules:
- Pick at most ${maxEvents} overlays.
- Use one comment-bait overlay in the first 3 minutes after the cold open, ideally around a major dilemma/reveal.
- Use no more than two direct like/subscribe CTAs total.
- Put the strongest subscribe CTA in the final 20 percent of the episode or at the cliffhanger.
- Text must be 3-10 words, mobile readable, punchy, and safe to show on-screen.
- Do not spoil a reveal before the narration reaches it.
- Avoid generic spam. Prefer niche-native prompts such as "Would you sit on the throne?", "Comment NO if he should refuse", "Like if Joey stays unsellable", or "Subscribe for the next throne."
- Use one of these goals: comment_question, comment_choice, like_prompt, subscribe_prompt.
- Use one of these positions: top_left, top_right, mid_left, mid_right, top_center. Do not use bottom positions because subtitles live there.
- Use one of these styles: yellow_bubble, white_comment_bubble, red_subscribe_bubble, blue_system_bubble.
- Use one of these animations: pop, slide_in, bounce, sweep.
- Duration should be 3.0-6.0 seconds.

Audio duration: ${Number(audioDuration || 0).toFixed(3)} seconds.

Candidate timed moments:
${JSON.stringify(candidates, null, 2)}

Return:
{
  "engagement_overlays": [
    {
      "image_id": "ep_02-cut-042",
      "scene_id": "scene_007",
      "start_sec": 96.25,
      "duration_sec": 4.5,
      "text": "WOULD YOU TAKE THE CROWN?",
      "goal": "comment_question",
      "style": "yellow_bubble",
      "position": "top_right",
      "animation": "pop",
      "edit_reason": "why this question earns engagement here"
    }
  ],
  "warnings": []
}`;
}

async function callCodex(prompt, stageName) {
  const model = flags.model ?? flags["llm-model"] ?? process.env.ANIFACTORY_ENGAGEMENT_PLANNER_CODEX_MODEL ?? "";
  const reasoningEffort = flags["reasoning-effort"] ?? process.env.ANIFACTORY_ENGAGEMENT_PLANNER_REASONING_EFFORT ?? "medium";
  const callDir = path.join(weekDir, "_codex_calls");
  await fs.mkdir(callDir, { recursive: true });
  const stamp = nowIso().replace(/[:.]/g, "-");
  const promptPath = path.join(callDir, `${stamp}-${stageName}-prompt.md`);
  const codexOutputPath = path.join(callDir, `${stamp}-${stageName}-output.txt`);
  await fs.writeFile(promptPath, prompt, "utf8");
  const call = await runCodexCli({
    prompt,
    stageName,
    repoRoot,
    outputPath: codexOutputPath,
    model: model || null,
    reasoningEffort,
    timeoutMs: Number(process.env.ANIFACTORY_ENGAGEMENT_PLANNER_CODEX_TIMEOUT_MS ?? 600_000),
    detached: true,
  });
  return {
    provider: "codex",
    model: call.model,
    reasoning_effort: call.reasoning_effort,
    codex_cli_path: call.codex_cli_path,
    codex_cli_version: call.codex_cli_version,
    prompt_path: promptPath,
    output_path: codexOutputPath,
    parsed: extractJson(call.content),
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/[^\w\s?!.,'#$-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 72);
}

function normalizeOverlay(row, candidatesByImageId, audioDuration, index) {
  const imageId = String(row.image_id ?? "");
  const candidate = candidatesByImageId.get(imageId);
  if (!candidate) return null;
  const text = normalizeText(row.text);
  if (!text) return null;
  const duration = clamp(Number(row.duration_sec ?? 4.2) || 4.2, 2.5, 6.5);
  const start = clamp(Number(row.start_sec ?? candidate.start_sec) || candidate.start_sec, candidate.start_sec, Math.max(candidate.start_sec, candidate.start_sec + Math.max(0.3, Number(candidate.duration_sec ?? 6) - duration)));
  if (start + duration > audioDuration + 0.5) return null;
  const goal = String(row.goal ?? "comment_question").replace(/[^a-z_]/gi, "").toLowerCase();
  const style = String(row.style ?? "yellow_bubble").replace(/[^a-z_]/gi, "").toLowerCase();
  const position = String(row.position ?? "top_right").replace(/[^a-z_]/gi, "").toLowerCase();
  const animation = String(row.animation ?? "pop").replace(/[^a-z_]/gi, "").toLowerCase();
  return {
    overlay_id: `engagement_${String(index + 1).padStart(3, "0")}`,
    image_id: imageId,
    scene_id: candidate.scene_id,
    start_sec: Number(start.toFixed(3)),
    duration_sec: Number(duration.toFixed(3)),
    end_sec: Number((start + duration).toFixed(3)),
    text,
    goal: ["comment_question", "comment_choice", "like_prompt", "subscribe_prompt"].includes(goal) ? goal : "comment_question",
    style: ["yellow_bubble", "white_comment_bubble", "red_subscribe_bubble", "blue_system_bubble"].includes(style) ? style : "yellow_bubble",
    position: ["top_left", "top_right", "mid_left", "mid_right", "top_center"].includes(position) ? position : "top_right",
    animation: ["pop", "slide_in", "bounce", "sweep"].includes(animation) ? animation : "pop",
    edit_reason: String(row.edit_reason ?? "LLM selected engagement moment").slice(0, 500),
  };
}

async function main() {
  const [promptPlan, wordTiming] = await Promise.all([
    readJson(promptPlanPath, null),
    readJson(wordTimingPath, null),
  ]);
  if (promptPlan?.status !== "passed" || !Array.isArray(promptPlan.prompts)) throw new Error(`Missing passed hardened prompt plan: ${promptPlanPath}`);
  const audioDuration = Number(wordTiming?.audio_duration_sec ?? wordTiming?.duration_sec ?? promptPlan.prompts.at(-1)?.end_sec ?? 0);
  const candidates = buildCandidates(promptPlan.prompts);
  const candidatesByImageId = new Map(candidates.map((candidate) => [candidate.image_id, candidate]));
  const llm = dryRun
    ? {
        provider: "dry_run",
        model: "none",
        prompt_path: null,
        output_path: null,
        parsed: {
          engagement_overlays: candidates.slice(0, maxEvents).map((candidate, index) => ({
            image_id: candidate.image_id,
            start_sec: candidate.start_sec,
            duration_sec: 4,
            text: index === 0 ? "WOULD YOU TAKE THE THRONE?" : "COMMENT YOUR CHOICE",
            goal: "comment_question",
            style: "yellow_bubble",
            position: index % 2 ? "top_left" : "top_right",
            animation: "pop",
            edit_reason: "dry run engagement overlay",
          })),
          warnings: [],
        },
      }
    : await callCodex(buildPrompt(candidates, audioDuration), `${episode}_engagement_overlay_plan`);
  const overlays = (Array.isArray(llm.parsed.engagement_overlays) ? llm.parsed.engagement_overlays : [])
    .slice(0, maxEvents)
    .map((row, index) => normalizeOverlay(row, candidatesByImageId, audioDuration, index))
    .filter(Boolean)
    .sort((left, right) => left.start_sec - right.start_sec);
  const report = {
    schema: "goldflow_engagement_overlay_plan_v1",
    status: overlays.length ? "passed" : "needs_review",
    channel,
    series_slug: series,
    week,
    episode,
    prompt_plan_path: promptPlanPath,
    word_timing_path: wordTimingPath,
    source_hashes: Object.fromEntries((await Promise.all([promptPlanPath, wordTimingPath].map(async (filePath) => [filePath, await hashFile(filePath)]))).filter(([, hash]) => hash)),
    planner: { provider: llm.provider, model: llm.model, prompt_path: llm.prompt_path, output_path: llm.output_path },
    policy: "LLM chooses sparse story-timed engagement moments; render applies exact mobile-readable bubbles. Engagement text must not be baked into scene images, narration, subtitles, visual facts, or audio planning.",
    max_events: maxEvents,
    candidate_count: candidates.length,
    overlay_count: overlays.length,
    engagement_overlays: overlays,
    warnings: llm.parsed.warnings ?? [],
    updated_at: nowIso(),
  };
  await writeJson(outputPath, report);
  console.log(JSON.stringify({ status: report.status, output_path: outputPath, overlay_count: report.overlay_count }, null, 2));
  if (report.status !== "passed") process.exitCode = 1;
}

main().catch(async (error) => {
  await writeJson(outputPath, { schema: "goldflow_engagement_overlay_plan_v1", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: nowIso() }).catch(() => {});
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
