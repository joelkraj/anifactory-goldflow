#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const sfxManifestPath = flags.sfxManifest ?? flags["sfx-manifest"] ?? path.join(dataRoot, "sfx_bank", "sfx_manifest.json");
const outputPath = flags.output ?? path.join(episodeDir, `transition_edit_plan_${episode}.json`);
const hookDurationSec = Number(flags["hook-duration-sec"] ?? 30);
const retentionRampSec = Number(flags["retention-ramp-sec"] ?? 180);
const maxBoundaries = Number(flags["max-boundaries"] ?? 220);
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

function preferredAsset(cue) {
  return cue?.assets?.find((asset) => asset.asset_id === cue.preferred_asset_id && asset.status === "available")
    ?? [...(cue?.assets ?? [])].reverse().find((asset) => asset?.path && asset.status === "available")
    ?? null;
}

function transitionCuePriority(cue, asset) {
  const text = [cue?.cue_id, cue?.generation_prompt, ...(cue?.aliases ?? []), asset?.prompt].filter(Boolean).join(" ").toLowerCase();
  let score = 0;
  for (const term of ["whoosh", "swipe", "sweep", "pop", "snap", "zip", "flash", "impact", "scene", "manga", "scan", "system", "glitch", "hush", "sub", "thud"]) {
    if (text.includes(term)) score += 10;
  }
  if (/ambience|room tone|music|voice|speech|crowd dialogue/.test(text)) score -= 40;
  return score;
}

function transitionCueBank(manifest) {
  const cues = Array.isArray(manifest?.cues) ? manifest.cues : Object.values(manifest?.cues ?? {});
  return cues
    .map((cue) => ({ cue, asset: preferredAsset(cue) }))
    .filter((row) => row.asset?.path)
    .map((row) => ({ ...row, priority: transitionCuePriority(row.cue, row.asset) }))
    .filter((row) => row.priority > 0)
    .sort((left, right) => right.priority - left.priority || String(left.cue.cue_id).localeCompare(String(right.cue.cue_id)))
    .slice(0, 80)
    .map(({ cue, asset }) => ({
      cue_id: cue.cue_id,
      aliases: cue.aliases ?? [],
      prompt: asset.prompt ?? cue.generation_prompt ?? "",
      asset_id: asset.asset_id ?? null,
      asset_path: asset.path,
    }));
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
  ].filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 900);
}

function buildBoundaries(prompts) {
  const boundaries = [];
  for (let index = 1; index < prompts.length; index += 1) {
    const previous = prompts[index - 1];
    const current = prompts[index];
    const start = Number(current.start_sec);
    if (!Number.isFinite(start)) continue;
    const sceneChanged = previous.scene_id && current.scene_id && previous.scene_id !== current.scene_id;
    const inHook = start < hookDurationSec;
    const inRamp = start >= hookDurationSec && start < retentionRampSec;
    const text = `${promptTextBundle(previous)} ${promptTextBundle(current)}`;
    const important = /\b(system|ledger|screen|broadcast|warning|phase|throne|crown|mirror|offer|refuse|collapse|reveal|activated|awakening|memory|first life|death|betrayal|humiliate|simp)\b/i.test(text);
    if (!inHook && !inRamp && !sceneChanged && !important) continue;
    boundaries.push({
      boundary_id: `boundary_${String(boundaries.length + 1).padStart(3, "0")}`,
      from_image_id: previous.image_id,
      to_image_id: current.image_id,
      scene_id: current.scene_id,
      start_sec: Number(start.toFixed(3)),
      in_hook: inHook,
      in_retention_ramp: inRamp,
      scene_changed: Boolean(sceneChanged),
      from_context: promptTextBundle(previous),
      to_context: promptTextBundle(current),
    });
    if (boundaries.length >= maxBoundaries) break;
  }
  return boundaries;
}

function buildPrompt(boundaries, cueBank) {
  return `You are the human-feel edit planner for an AniFactory manhwa recap.

Return one valid JSON object only. Do not include markdown.

Goal:
- Decide which visual cut boundaries deserve true editorial transition treatment and transition SFX.
- Especially in the first 3 minutes, make the edit feel hand placed. Use the first 30 seconds as the densest cold open, then keep the 30-180 second ramp visually alive with selective sweeps, drop-ins, swipe-up/down, manga snaps, system scans, impact flashes, and quieter wipes.
- Do NOT place SFX on every cut after the hook. Be selective after 30 seconds.
- Transition SFX should land exactly on the cut boundary, not float under narration.
- Score drops are handled by the score planner; here you may only add a note when a boundary should be considered a score-drop anchor.
- Use only cue_id values from the SFX cue bank below.

Allowed xfade transitions:
fade, dissolve, distance, wipeleft, wiperight, wipeup, wipedown, slideleft, slideright, slideup, slidedown, smoothleft, smoothright, smoothup, smoothdown, circlecrop, rectcrop, pixelize, hblur, fadegrays, wipetl, wipetr, wipebl, wipebr, squeezeh, squeezev, zoomin, fadefast, fadeslow, hlwind, hrwind, vuwind, vdwind, coverleft, coverright, coverup, coverdown, revealleft, revealright, revealup, revealdown.

Transition cue bank:
${JSON.stringify(cueBank, null, 2)}

Candidate boundaries:
${JSON.stringify(boundaries, null, 2)}

Return:
{
  "transition_events": [
    {
      "boundary_id": "boundary_001",
      "to_image_id": "ep_03-cut-002",
      "xfade_transition": "slideup",
      "xfade_duration_sec": 0.28,
      "transition_sfx": true,
      "cue_id": "hook_swipe_up_flash",
      "gain_db": -16,
      "sfx_offset_sec": -0.015,
      "score_drop_anchor": false,
      "edit_reason": "why this transition/SFX earns attention here"
    }
  ],
  "warnings": []
}

Rules:
- First 30 seconds: most boundaries should have transition_sfx true unless the narration beat is quiet.
- 30-180 seconds: use transition_sfx on scene changes, system/UI reveals, reversals, humiliations, status turns, impact, memory shifts, and strong curiosity pivots. It should still feel designed, but less constant than the first 30 seconds.
- After 180 seconds: transition_sfx true only for scene changes, system/UI reveals, reversals, impact, memory shifts, cliffhangers, or strong emotional pivots.
- xfade_duration_sec should usually be 0.18-0.34 seconds. Use shorter for impact cuts, longer for memory/dissolve.
- gain_db should usually be -18 to -14 in hook, -24 to -18 later.
- sfx_offset_sec should be between -0.04 and 0.02 so the attack lands on the cut.
`;
}

async function callCodex(prompt, stageName) {
  const model = flags.model ?? flags["llm-model"] ?? process.env.ANIFACTORY_TRANSITION_PLANNER_CODEX_MODEL ?? "";
  const reasoningEffort = flags["reasoning-effort"] ?? process.env.ANIFACTORY_TRANSITION_PLANNER_REASONING_EFFORT ?? "medium";
  const callDir = path.join(weekDir, "_codex_calls");
  await fs.mkdir(callDir, { recursive: true });
  const stamp = nowIso().replace(/[:.]/g, "-");
  const promptPath = path.join(callDir, `${stamp}-${stageName}-prompt.md`);
  const outputPath = path.join(callDir, `${stamp}-${stageName}-output.txt`);
  await fs.writeFile(promptPath, prompt, "utf8");
  const codexArgs = ["exec", "--ephemeral", "--skip-git-repo-check", "-C", repoRoot];
  if (model) codexArgs.push("-m", model);
  codexArgs.push("-c", `model_reasoning_effort="${reasoningEffort}"`, "-c", 'model_verbosity="medium"', "-o", outputPath);
  const output = await new Promise((resolve, reject) => {
    const child = spawn("codex", codexArgs, { env: { ...process.env, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      reject(new Error(`Codex transition plan ${stageName} timed out`));
    }, Number(process.env.ANIFACTORY_TRANSITION_PLANNER_CODEX_TIMEOUT_MS ?? 600_000));
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", async (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Codex transition plan ${stageName} exited ${code}: ${stderr || stdout}`));
        return;
      }
      const text = await fs.readFile(outputPath, "utf8").catch(() => stdout || stderr);
      resolve(text);
    });
    child.stdin.end(prompt);
  });
  return { provider: "codex", model: model || "codex_cli_default", prompt_path: promptPath, output_path: outputPath, parsed: extractJson(output) };
}

function normalizeEvent(event, boundariesById, cueById) {
  const boundary = boundariesById.get(String(event.boundary_id ?? ""));
  if (!boundary) return null;
  const cueId = String(event.cue_id ?? "");
  const cue = cueById.get(cueId);
  const transitionSfx = event.transition_sfx === true && cue;
  return {
    boundary_id: boundary.boundary_id,
    from_image_id: boundary.from_image_id,
    to_image_id: boundary.to_image_id,
    scene_id: boundary.scene_id,
    start_sec: boundary.start_sec,
    xfade_transition: String(event.xfade_transition ?? "dissolve").replace(/[^a-z0-9]/gi, "").toLowerCase() || "dissolve",
    xfade_duration_sec: Math.max(0.08, Math.min(0.5, Number(event.xfade_duration_sec ?? 0.28) || 0.28)),
    transition_sfx: Boolean(transitionSfx),
    cue_id: transitionSfx ? cueId : null,
    asset_path: transitionSfx ? cue.asset_path : null,
    asset_id: transitionSfx ? cue.asset_id : null,
    gain_db: Math.max(-36, Math.min(-10, Number(event.gain_db ?? (boundary.in_hook ? -16 : -22)) || (boundary.in_hook ? -16 : -22))),
    sfx_offset_sec: Math.max(-0.08, Math.min(0.05, Number(event.sfx_offset_sec ?? -0.015) || -0.015)),
    score_drop_anchor: event.score_drop_anchor === true,
    in_hook: boundary.in_hook,
    in_retention_ramp: boundary.in_retention_ramp,
    scene_changed: boundary.scene_changed,
    edit_reason: String(event.edit_reason ?? "LLM selected transition boundary").slice(0, 500),
  };
}

async function main() {
  const [promptPlan, sfxManifest] = await Promise.all([
    readJson(promptPlanPath, null),
    readJson(sfxManifestPath, null),
  ]);
  if (promptPlan?.status !== "passed" || !Array.isArray(promptPlan.prompts)) throw new Error(`Missing passed hardened prompt plan: ${promptPlanPath}`);
  const boundaries = buildBoundaries(promptPlan.prompts);
  const cueBank = transitionCueBank(sfxManifest);
  if (!cueBank.length) throw new Error(`No available transition SFX cue bank entries in ${sfxManifestPath}`);
  const boundariesById = new Map(boundaries.map((boundary) => [boundary.boundary_id, boundary]));
  const cueById = new Map(cueBank.map((cue) => [cue.cue_id, cue]));
  const llm = dryRun
    ? { provider: "dry_run", model: "none", prompt_path: null, output_path: null, parsed: { transition_events: boundaries.filter((row) => row.in_hook).map((row, index) => ({ boundary_id: row.boundary_id, to_image_id: row.to_image_id, xfade_transition: index % 2 ? "slideup" : "smoothup", transition_sfx: true, cue_id: cueBank[index % cueBank.length].cue_id, gain_db: -16, sfx_offset_sec: -0.015, edit_reason: "dry run hook transition" })), warnings: [] } }
    : await callCodex(buildPrompt(boundaries, cueBank), `${episode}_transition_edit_plan`);
  const events = (Array.isArray(llm.parsed.transition_events) ? llm.parsed.transition_events : [])
    .map((event) => normalizeEvent(event, boundariesById, cueById))
    .filter(Boolean);
  const report = {
    schema: "goldflow_transition_edit_plan_v1",
    status: events.length ? "passed" : "needs_review",
    channel,
    series_slug: series,
    week,
    episode,
    prompt_plan_path: promptPlanPath,
    sfx_manifest_path: sfxManifestPath,
    source_hashes: Object.fromEntries((await Promise.all([promptPlanPath, sfxManifestPath].map(async (filePath) => [filePath, await hashFile(filePath)]))).filter(([, hash]) => hash)),
    planner: { provider: llm.provider, model: llm.model, prompt_path: llm.prompt_path, output_path: llm.output_path },
    policy: "LLM edit plan chooses visual xfade transitions and transition SFX. Story SFX/score/ambience remain in audio planning; transition SFX are applied by render/edit at cut boundaries.",
    hook_duration_sec: hookDurationSec,
    retention_ramp_sec: retentionRampSec,
    candidate_boundary_count: boundaries.length,
    transition_event_count: events.length,
    hook_transition_sfx_count: events.filter((event) => event.in_hook && event.transition_sfx).length,
    retention_ramp_transition_sfx_count: events.filter((event) => event.in_retention_ramp && event.transition_sfx).length,
    transition_events: events,
    warnings: llm.parsed.warnings ?? [],
    updated_at: nowIso(),
  };
  await writeJson(outputPath, report);
  console.log(JSON.stringify({ status: report.status, output_path: outputPath, transition_event_count: report.transition_event_count, hook_transition_sfx_count: report.hook_transition_sfx_count }, null, 2));
  if (report.status !== "passed") process.exitCode = 1;
}

main().catch(async (error) => {
  await writeJson(outputPath, { schema: "goldflow_transition_edit_plan_v1", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: nowIso() }).catch(() => {});
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
