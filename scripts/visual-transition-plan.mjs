#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isCodexCacheCompatible,
  readCodexCallMetadata,
  runCodexCli,
} from "./lib/codex-cli-runner.mjs";
import {
  availableTransitionCueById,
  resolveTransitionSfxFamily,
  transitionSfxFamilyGuide,
} from "./lib/transition-sfx-policy.mjs";

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
const transitionSfxEnabled = flags["transition-sfx"] !== "false";
const transitionSfxEndSec = Number(flags["transition-sfx-end-sec"] ?? Number.POSITIVE_INFINITY);
export const TRANSITION_PROMPT_SAFE_MAX_BYTES = 36_000;
export const TRANSITION_PROMPT_SAFE_MAX_CHARS = TRANSITION_PROMPT_SAFE_MAX_BYTES;
const transitionBoundaryChunkSize = Math.max(1, Math.min(32, Number(flags["boundary-chunk-size"] ?? 24) || 24));

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

function parseExactIds(...values) {
  return [...new Set(values
    .flatMap((value) => String(value ?? "").split(","))
    .map((value) => value.trim())
    .filter(Boolean))];
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
  ].filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 320);
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

function buildAdjacentBoundaries(prompts) {
  const boundaries = [];
  for (let index = 1; index < prompts.length; index += 1) {
    const previous = prompts[index - 1];
    const current = prompts[index];
    const start = Number(current.start_sec);
    if (!Number.isFinite(start)) continue;
    boundaries.push({
      boundary_id: `adjacent_boundary_${String(index).padStart(4, "0")}`,
      from_image_id: previous.image_id,
      to_image_id: current.image_id,
      scene_id: current.scene_id,
      start_sec: Number(start.toFixed(3)),
      in_hook: start < hookDurationSec,
      in_retention_ramp: start >= hookDurationSec && start < retentionRampSec,
      scene_changed: Boolean(previous.scene_id && current.scene_id && previous.scene_id !== current.scene_id),
    });
  }
  return boundaries;
}

function buildPrompt(boundaries) {
  return `You are the human-feel edit planner for an AniFactory manhwa recap.

Return one valid JSON object only. Do not include markdown.

Goal:
- Decide which visual cut boundaries deserve true editorial transition treatment${transitionSfxEnabled ? " and transition SFX" : ""}.
- Especially in the first 3 minutes, make the edit feel hand placed. Use the first 30 seconds as the densest cold open, then keep the 30-180 second ramp visually alive with selective sweeps, drop-ins, swipe-up/down, manga snaps, system scans, impact flashes, and quieter wipes.
- Do NOT place SFX on every cut after the hook. Be selective after 30 seconds.
${transitionSfxEnabled ? `- Transition SFX should land exactly on the cut boundary, not float under narration. Choose an editorial SFX family; deterministic code resolves that family to an approved available bank asset and supplies calibrated trim, lead-in, fade, and gain.${Number.isFinite(transitionSfxEndSec) ? ` Transition SFX are allowed only before ${transitionSfxEndSec} seconds; every later event must stay silent.` : ""}` : "- Transition SFX are disabled for this run. Set transition_sfx false and sfx_family none on every event."}
- Score drops are handled by the score planner; here you may only add a note when a boundary should be considered a score-drop anchor.
${transitionSfxEnabled ? "- Do not choose cue ids or asset paths. Choose only one family from the compact family guide below." : "- Do not reference cue ids, SFX families other than none, or SFX assets."}

Allowed xfade transitions:
fade, dissolve, distance, wipeleft, wiperight, wipeup, wipedown, slideleft, slideright, slideup, slidedown, smoothleft, smoothright, smoothup, smoothdown, circlecrop, rectcrop, pixelize, hblur, fadegrays, wipetl, wipetr, wipebl, wipebr, squeezeh, squeezev, zoomin, fadefast, fadeslow, hlwind, hrwind, vuwind, vdwind, coverleft, coverright, coverup, coverdown, revealleft, revealright, revealup, revealdown.

Transition SFX family guide:
${JSON.stringify(transitionSfxFamilyGuide())}

Candidate boundaries:
${JSON.stringify(boundaries)}

Return:
{
  "transition_events": [
    {
      "boundary_id": "boundary_001",
      "to_image_id": "ep_03-cut-002",
      "xfade_transition": "slideup",
      "xfade_duration_sec": 0.28,
      "transition_sfx": ${transitionSfxEnabled ? "true" : "false"},
      "sfx_family": ${transitionSfxEnabled ? "\"swipe_up\"" : "\"none\""},
      "score_drop_anchor": false,
      "edit_reason": "why this transition/SFX earns attention here"
    }
  ],
  "warnings": []
}

Rules:
- First 30 seconds: most boundaries should have vivid visual transitions when the narration beat supports it.
- 30-180 seconds: use stronger transition families on scene changes, system/UI reveals, reversals, humiliations, status turns, impact, memory shifts, and strong curiosity pivots. It should still feel designed, but less constant than the first 30 seconds.
- After 180 seconds: reserve strong transitions for scene changes, system/UI reveals, reversals, impact, memory shifts, cliffhangers, or strong emotional pivots.
${transitionSfxEnabled ? "- When transition_sfx is true, sfx_family must be one of: swipe_up, swipe_down, lateral_whoosh, manga_snap, impact, system_scan, memory_wash. Use none when the boundary should stay silent." : "- transition_sfx must be false and sfx_family must be none for every event in this silent-transition run."}
- xfade_duration_sec should usually be 0.18-0.34 seconds. Use shorter for impact cuts, longer for memory/dissolve.
${transitionSfxEnabled ? "- Do not author gain, asset trim, fade, or timing offsets; those come from the calibrated family policy." : "- Do not author SFX gain, asset trim, fade, or timing offsets."}
`;
}

export function sizeBoundTransitionChunksForTests(boundaries, {
  chunkSize = 24,
  maxBytes = TRANSITION_PROMPT_SAFE_MAX_BYTES,
  maxChars = null,
  promptBuilder = buildPrompt,
} = {}) {
  const requestedCeiling = maxChars ?? maxBytes;
  const ceiling = Math.min(
    TRANSITION_PROMPT_SAFE_MAX_BYTES,
    Number.isFinite(Number(requestedCeiling)) && Number(requestedCeiling) > 0
      ? Number(requestedCeiling)
      : TRANSITION_PROMPT_SAFE_MAX_BYTES,
  );
  const initial = [];
  const safeChunkSize = Math.max(1, Math.min(32, Number(chunkSize) || 24));
  for (let index = 0; index < boundaries.length; index += safeChunkSize) {
    initial.push(boundaries.slice(index, index + safeChunkSize));
  }
  const fitted = [];
  const visit = (rows) => {
    const promptBytes = Buffer.byteLength(String(promptBuilder(rows) ?? ""), "utf8");
    if (promptBytes <= ceiling) {
      fitted.push(Object.assign([...rows], { prompt_bytes: promptBytes }));
      return;
    }
    if (rows.length <= 1) {
      throw new Error(`Transition planner packet for exact boundary ${rows[0]?.boundary_id ?? "unknown"} is ${promptBytes} bytes, above ceiling ${ceiling}.`);
    }
    const midpoint = Math.ceil(rows.length / 2);
    visit(rows.slice(0, midpoint));
    visit(rows.slice(midpoint));
  };
  for (const rows of initial) visit(rows);
  return fitted;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length || 1) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
    }
  }));
  return output;
}

export function transitionContentAddressedPathsForTests(callDir, prompt) {
  const promptHash = sha256(String(prompt ?? ""));
  return {
    prompt_sha256: promptHash,
    prompt_path: path.join(callDir, `${promptHash}-prompt.md`),
    output_path: path.join(callDir, `${promptHash}-output.json`),
    acceptance_path: path.join(callDir, `${promptHash}-output.json.accepted.json`),
  };
}

function transitionBoundaryManifestSha256(boundaries) {
  return sha256(JSON.stringify(boundaries.map((row) => String(row.boundary_id ?? ""))));
}

export function validateTransitionChunkPayloadForTests(parsed, boundaries) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Transition planner response must be one JSON object.");
  }
  if (!Array.isArray(parsed.transition_events)) {
    throw new Error("Transition planner response must contain transition_events array.");
  }
  const allowed = new Map(boundaries.map((row) => [String(row.boundary_id ?? ""), row]));
  const seen = new Set();
  for (const event of parsed.transition_events) {
    const boundaryId = String(event?.boundary_id ?? "").trim();
    if (!allowed.has(boundaryId)) {
      throw new Error(`Transition planner returned unknown boundary_id ${boundaryId || "<missing>"}.`);
    }
    if (seen.has(boundaryId)) {
      throw new Error(`Transition planner returned duplicate boundary_id ${boundaryId}.`);
    }
    seen.add(boundaryId);
    const expectedToImageId = String(allowed.get(boundaryId)?.to_image_id ?? "");
    if (event.to_image_id != null && String(event.to_image_id) !== expectedToImageId) {
      throw new Error(`Transition planner returned mismatched to_image_id for ${boundaryId}.`);
    }
  }
  if (parsed.warnings != null && !Array.isArray(parsed.warnings)) {
    throw new Error("Transition planner warnings must be an array when present.");
  }
  return {
    ...parsed,
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
  };
}

export function acceptedTransitionCacheForTests({
  content,
  acceptance,
  promptSha256,
  boundaries,
} = {}) {
  if (!content || acceptance?.schema !== "goldflow_transition_chunk_acceptance_v1"
    || acceptance?.status !== "accepted"
    || acceptance?.prompt_sha256 !== promptSha256
    || acceptance?.output_sha256 !== sha256(String(content))
    || acceptance?.boundary_manifest_sha256 !== transitionBoundaryManifestSha256(boundaries ?? [])) {
    return null;
  }
  try {
    return validateTransitionChunkPayloadForTests(extractJson(content), boundaries ?? []);
  } catch {
    return null;
  }
}

export function transitionChunkAcceptanceForTests({
  content,
  promptSha256,
  boundaries,
  acceptedAt = nowIso(),
} = {}) {
  validateTransitionChunkPayloadForTests(extractJson(content), boundaries ?? []);
  return {
    schema: "goldflow_transition_chunk_acceptance_v1",
    status: "accepted",
    prompt_sha256: promptSha256,
    output_sha256: sha256(String(content)),
    boundary_manifest_sha256: transitionBoundaryManifestSha256(boundaries ?? []),
    boundary_ids: (boundaries ?? []).map((row) => row.boundary_id),
    accepted_at: acceptedAt,
  };
}

export function transitionRepairScopeForTests({ boundaries, existingPlan, requestedBoundaryIds = [] } = {}) {
  const requested = parseExactIds(requestedBoundaryIds);
  const byId = new Map((boundaries ?? []).map((row) => [String(row.boundary_id ?? ""), row]));
  const unknown = requested.filter((boundaryId) => !byId.has(boundaryId));
  if (unknown.length) throw new Error(`Unknown transition boundary IDs: ${unknown.join(", ")}.`);
  if (existingPlan?.status === "blocked") {
    if (!requested.length) {
      throw new Error("Blocked transition planning requires exact --boundary-ids recovery; unscoped resubmission is forbidden.");
    }
    const failed = new Set((existingPlan.failed_boundary_ids ?? []).map(String));
    const unauthorized = requested.filter((boundaryId) => !failed.has(boundaryId));
    if (unauthorized.length) {
      throw new Error(`Transition repair IDs were not failed in the blocked artifact: ${unauthorized.join(", ")}. Passed boundaries are immutable.`);
    }
    return {
      boundaries: requested.map((boundaryId) => byId.get(boundaryId)),
      requested_boundary_ids: requested,
      remaining_failed_boundary_ids: [...failed].filter((boundaryId) => !requested.includes(boundaryId)),
      preserved_transition_events: (existingPlan.transition_events ?? [])
        .filter((event) => !requested.includes(String(event.boundary_id ?? ""))),
    };
  }
  if (requested.length) {
    throw new Error("Exact transition repair requires an existing blocked transition plan.");
  }
  if (["passed", "needs_review"].includes(existingPlan?.status)) {
    throw new Error("Transition plan is already materialized; unscoped creative resubmission is forbidden.");
  }
  return {
    boundaries: boundaries ?? [],
    requested_boundary_ids: [],
    remaining_failed_boundary_ids: [],
    preserved_transition_events: [],
  };
}

async function callCodex(prompt, boundaries) {
  const stageName = "transition_edit_plan";
  const model = flags.model ?? flags["llm-model"] ?? process.env.ANIFACTORY_TRANSITION_PLANNER_CODEX_MODEL ?? "";
  const reasoningEffort = flags["reasoning-effort"] ?? process.env.ANIFACTORY_TRANSITION_PLANNER_REASONING_EFFORT ?? null;
  const callDir = path.join(episodeDir, "_codex_calls", "transition-edit-plan");
  await fs.mkdir(callDir, { recursive: true });
  const addressed = transitionContentAddressedPathsForTests(callDir, prompt);
  const promptHash = addressed.prompt_sha256;
  const promptPath = addressed.prompt_path;
  const outputPath = addressed.output_path;
  const acceptancePath = addressed.acceptance_path;
  await fs.writeFile(promptPath, prompt, "utf8");
  const [cachedContent, cachedMetadata, acceptance] = await Promise.all([
    fs.readFile(outputPath, "utf8").catch(() => null),
    readCodexCallMetadata(outputPath),
    readJson(acceptancePath, null),
  ]);
  const cacheCompatible = cachedContent && isCodexCacheCompatible(cachedMetadata, {
    model: model || null,
    reasoningEffort,
    promptHash,
    stageName,
    planningOverrideStage: "transition_edit_plan",
  });
  let acceptedCachedPayload = cacheCompatible
    ? acceptedTransitionCacheForTests({
        content: cachedContent,
        acceptance,
        promptSha256: promptHash,
        boundaries,
      })
    : null;
  if (cacheCompatible && !acceptedCachedPayload) {
    try {
      acceptedCachedPayload = validateTransitionChunkPayloadForTests(extractJson(cachedContent), boundaries);
      await writeJson(acceptancePath, transitionChunkAcceptanceForTests({
        content: cachedContent,
        promptSha256: promptHash,
        boundaries,
      }));
    } catch {
      acceptedCachedPayload = null;
    }
  }
  if (acceptedCachedPayload) {
    return {
      provider: `${cachedMetadata.provider ?? "codex_cli"}_cache`,
      model: cachedMetadata.model,
      reasoning_effort: cachedMetadata.reasoning_effort,
      codex_cli_path: cachedMetadata.codex_cli_path,
      codex_cli_version: cachedMetadata.codex_cli_version,
      prompt_path: promptPath,
      output_path: outputPath,
      prompt_sha256: promptHash,
      prompt_bytes: Buffer.byteLength(prompt, "utf8"),
      reused: true,
      parsed: acceptedCachedPayload,
    };
  }
  const call = await runCodexCli({
    prompt,
    stageName,
    repoRoot,
    outputPath,
    model: model || null,
    reasoningEffort,
    timeoutMs: Number(process.env.ANIFACTORY_TRANSITION_PLANNER_CODEX_TIMEOUT_MS ?? 480_000),
    detached: true,
  });
  const outputContent = await fs.readFile(outputPath, "utf8").catch(() => call.content);
  const parsed = validateTransitionChunkPayloadForTests(extractJson(outputContent), boundaries);
  await writeJson(acceptancePath, transitionChunkAcceptanceForTests({
    content: outputContent,
    promptSha256: promptHash,
    boundaries,
  }));
  return {
    provider: call.provider ?? "codex_cli",
    model: call.model,
    reasoning_effort: call.reasoning_effort,
    codex_cli_path: call.codex_cli_path,
    codex_cli_version: call.codex_cli_version,
    prompt_path: promptPath,
    output_path: outputPath,
    prompt_sha256: promptHash,
    prompt_bytes: Buffer.byteLength(prompt, "utf8"),
    reused: false,
    parsed,
  };
}

function normalizeEvent(event, boundariesById, sfxManifest) {
  const boundary = boundariesById.get(String(event.boundary_id ?? ""));
  if (!boundary) return null;
  const sfxAllowedAtBoundary = transitionSfxEnabled && boundary.start_sec < transitionSfxEndSec;
  const family = String(event.sfx_family ?? "none").trim().toLowerCase();
  const familyResolution = sfxAllowedAtBoundary && event.transition_sfx === true
    ? resolveTransitionSfxFamily(sfxManifest, family, { inHook: boundary.in_hook })
    : null;
  const legacyResolution = !familyResolution && sfxAllowedAtBoundary && event.transition_sfx === true && event.cue_id
    ? availableTransitionCueById(sfxManifest, event.cue_id)
    : null;
  const resolved = familyResolution ?? (legacyResolution ? {
    ...legacyResolution,
    sfx_family: "legacy_exact_cue",
    asset_trim_start_sec: 0,
    sfx_offset_sec: -0.015,
    duration_sec: 0.65,
    fade_out_sec: 0.12,
    gain_db: boundary.in_hook ? -16 : -22,
    resolution_source: "legacy_exact_cue",
  } : null);
  const transitionSfx = Boolean(resolved);
  return {
    boundary_id: boundary.boundary_id,
    from_image_id: boundary.from_image_id,
    to_image_id: boundary.to_image_id,
    scene_id: boundary.scene_id,
    start_sec: boundary.start_sec,
    xfade_transition: String(event.xfade_transition ?? "dissolve").replace(/[^a-z0-9]/gi, "").toLowerCase() || "dissolve",
    xfade_duration_sec: Math.max(0.08, Math.min(0.5, Number(event.xfade_duration_sec ?? 0.28) || 0.28)),
    transition_sfx: transitionSfx,
    sfx_family: transitionSfx ? resolved.sfx_family : "none",
    cue_id: transitionSfx ? resolved.cue_id : null,
    asset_path: transitionSfx ? resolved.asset_path : null,
    asset_id: transitionSfx ? resolved.asset_id : null,
    asset_trim_start_sec: transitionSfx ? resolved.asset_trim_start_sec : null,
    duration_sec: transitionSfx ? resolved.duration_sec : null,
    fade_out_sec: transitionSfx ? resolved.fade_out_sec : null,
    sfx_resolution_source: transitionSfx ? resolved.resolution_source : null,
    gain_db: transitionSfx ? resolved.gain_db : null,
    sfx_offset_sec: transitionSfx ? resolved.sfx_offset_sec : 0,
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
    transitionSfxEnabled ? readJson(sfxManifestPath, null) : null,
  ]);
  if (promptPlan?.status !== "passed" || !Array.isArray(promptPlan.prompts)) throw new Error(`Missing passed hardened prompt plan: ${promptPlanPath}`);
  const boundaries = buildBoundaries(promptPlan.prompts);
  const boundariesById = new Map(boundaries.map((boundary) => [boundary.boundary_id, boundary]));
  if (flags["revalidate-existing"] === "true") {
    const existingPlanPath = flags["existing-plan"] ?? outputPath;
    const existing = await readJson(existingPlanPath, null);
    if (existing?.status !== "passed" || !Array.isArray(existing.transition_events)) {
      throw new Error(`Transition timing revalidation requires an existing passed plan: ${existingPlanPath}`);
    }
    // Revalidation is not a new creative selection pass. Validate retained
    // transitions against every current adjacent cut, not only the capped
    // heuristic candidate shortlist used when authoring a new plan.
    const boundaryByPair = new Map(buildAdjacentBoundaries(promptPlan.prompts)
      .map((boundary) => [`${boundary.from_image_id}->${boundary.to_image_id}`, boundary]));
    const transitionEvents = existing.transition_events.map((event) => {
      const boundary = boundaryByPair.get(`${event.from_image_id}->${event.to_image_id}`);
      if (!boundary) throw new Error(`Transition timing revalidation could not find current boundary for ${event.from_image_id}->${event.to_image_id}.`);
      return {
        ...event,
        boundary_id: event.boundary_id ?? boundary.boundary_id,
        scene_id: boundary.scene_id,
        start_sec: boundary.start_sec,
        in_hook: boundary.in_hook,
        in_retention_ramp: boundary.in_retention_ramp,
        scene_changed: boundary.scene_changed,
        transition_sfx: transitionSfxEnabled ? event.transition_sfx === true : false,
        sfx_family: transitionSfxEnabled ? event.sfx_family : "none",
        cue_id: transitionSfxEnabled ? event.cue_id : null,
        asset_path: transitionSfxEnabled ? event.asset_path : null,
        asset_id: transitionSfxEnabled ? event.asset_id : null,
      };
    });
    const refreshed = {
      ...existing,
      prompt_plan_path: promptPlanPath,
      transition_sfx_enabled: transitionSfxEnabled,
      sfx_manifest_path: transitionSfxEnabled ? sfxManifestPath : null,
      source_hashes: Object.fromEntries((await Promise.all([promptPlanPath, transitionSfxEnabled ? sfxManifestPath : null].filter(Boolean).map(async (filePath) => [filePath, await hashFile(filePath)]))).filter(([, hash]) => hash)),
      planner: {
        ...(existing.planner ?? {}),
        timing_revalidated_without_llm: true,
        timing_revalidated_at: nowIso(),
        timing_revalidated_from_path: existingPlanPath,
      },
      candidate_boundary_count: boundaries.length,
      transition_event_count: transitionEvents.length,
      transition_events: transitionEvents,
      updated_at: nowIso(),
    };
    await writeJson(outputPath, refreshed);
    console.log(JSON.stringify({ status: refreshed.status, output_path: outputPath, transition_event_count: refreshed.transition_event_count, timing_revalidated_without_llm: true }, null, 2));
    return;
  }
  const existingPlan = await readJson(outputPath, null);
  const currentSourceHashes = Object.fromEntries((await Promise.all(
    [promptPlanPath, transitionSfxEnabled ? sfxManifestPath : null]
      .filter(Boolean)
      .map(async (filePath) => [filePath, await hashFile(filePath)]),
  )).filter(([, hash]) => hash));
  if (existingPlan?.status === "blocked") {
    const priorPromptPlanHash = existingPlan.source_hashes?.[existingPlan.prompt_plan_path]
      ?? existingPlan.source_hashes?.[promptPlanPath]
      ?? null;
    if (!priorPromptPlanHash || priorPromptPlanHash !== currentSourceHashes[promptPlanPath]) {
      throw new Error("Blocked transition repair scope belongs to a different prompt-plan hash.");
    }
    if (transitionSfxEnabled) {
      const priorSfxHash = existingPlan.source_hashes?.[existingPlan.sfx_manifest_path]
        ?? existingPlan.source_hashes?.[sfxManifestPath]
        ?? null;
      if (priorSfxHash !== (currentSourceHashes[sfxManifestPath] ?? null)) {
        throw new Error("Blocked transition repair scope belongs to a different transition-SFX manifest hash.");
      }
    }
  }
  const repairScope = transitionRepairScopeForTests({
    boundaries,
    existingPlan,
    requestedBoundaryIds: parseExactIds(flags["boundary-ids"], flags["boundary-id"]),
  });
  const boundaryChunks = sizeBoundTransitionChunksForTests(repairScope.boundaries, {
    chunkSize: transitionBoundaryChunkSize,
  });
  const chunkConcurrency = Math.max(1, Math.min(8, Number(flags["boundary-chunk-concurrency"] ?? 8) || 8));
  const chunkCalls = dryRun
    ? boundaryChunks.map((rows) => ({
        provider: "dry_run",
        model: "none",
        prompt_path: null,
        output_path: null,
        prompt_sha256: sha256(buildPrompt(rows)),
        reused: false,
        parsed: {
          transition_events: rows.filter((row) => row.in_hook).map((row, index) => ({
            boundary_id: row.boundary_id,
            to_image_id: row.to_image_id,
            xfade_transition: index % 2 ? "slideup" : "smoothup",
            transition_sfx: transitionSfxEnabled,
            sfx_family: transitionSfxEnabled ? (index % 2 ? "swipe_up" : "manga_snap") : "none",
            edit_reason: "dry run hook transition",
          })),
          warnings: [],
        },
      }))
    : await mapWithConcurrency(boundaryChunks, chunkConcurrency, async (rows, index) => {
        try {
          return await callCodex(buildPrompt(rows), rows);
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : String(error),
            boundary_ids: rows.map((row) => row.boundary_id),
            prompt_bytes: rows.prompt_bytes,
          };
        }
      });
  const failedChunks = chunkCalls.filter((call) => call?.error);
  const passedCalls = chunkCalls.filter((call) => !call?.error);
  const llm = {
    provider: [...new Set(passedCalls.map((call) => call.provider))].join("+") || "unavailable",
    model: [...new Set(passedCalls.map((call) => call.model).filter(Boolean))].join("+") || null,
    prompt_path: passedCalls.length === 1 ? passedCalls[0].prompt_path : null,
    output_path: passedCalls.length === 1 ? passedCalls[0].output_path : null,
    parsed: {
      transition_events: passedCalls.flatMap((call) => call.parsed?.transition_events ?? []),
      warnings: passedCalls.flatMap((call) => call.parsed?.warnings ?? []),
    },
  };
  const repairedEvents = (Array.isArray(llm.parsed.transition_events) ? llm.parsed.transition_events : [])
    .map((event) => normalizeEvent(event, boundariesById, sfxManifest))
    .filter(Boolean);
  const events = [...repairScope.preserved_transition_events, ...repairedEvents]
    .sort((left, right) => Number(left.start_sec ?? 0) - Number(right.start_sec ?? 0));
  const failedBoundaryIds = [...new Set([
    ...repairScope.remaining_failed_boundary_ids,
    ...failedChunks.flatMap((chunk) => chunk.boundary_ids ?? []),
  ])];
  const priorWarnings = Array.isArray(existingPlan?.warnings) ? existingPlan.warnings : [];
  const report = {
    schema: "goldflow_transition_edit_plan_v1",
    status: failedBoundaryIds.length ? "blocked" : events.length ? "passed" : "needs_review",
    channel,
    series_slug: series,
    week,
    episode,
    prompt_plan_path: promptPlanPath,
    transition_sfx_enabled: transitionSfxEnabled,
    transition_sfx_end_sec: Number.isFinite(transitionSfxEndSec) ? transitionSfxEndSec : null,
    sfx_manifest_path: transitionSfxEnabled ? sfxManifestPath : null,
    source_hashes: currentSourceHashes,
    planner: {
      provider: llm.provider,
      model: llm.model,
      prompt_path: llm.prompt_path,
      output_path: llm.output_path,
      packet_policy: "content_addressed_boundary_chunks_v1",
      prompt_byte_ceiling: TRANSITION_PROMPT_SAFE_MAX_BYTES,
      chunk_count: boundaryChunks.length,
      chunk_concurrency: chunkConcurrency,
      reused_chunk_count: passedCalls.filter((call) => call.reused).length,
      calls: passedCalls.map((call, index) => ({
        chunk_index: index + 1,
        provider: call.provider,
        model: call.model,
        prompt_path: call.prompt_path,
        output_path: call.output_path,
        prompt_sha256: call.prompt_sha256,
        prompt_bytes: call.prompt_bytes,
        reused: call.reused,
      })),
      failed_chunks: failedChunks,
    },
    repair_scope: {
      exact_boundary_repair: repairScope.requested_boundary_ids.length > 0,
      submitted_boundary_ids: repairScope.requested_boundary_ids,
      unscoped_resubmission_forbidden: true,
    },
    policy: transitionSfxEnabled
      ? "LLM edit plan chooses visual xfade transitions and transition SFX. Story SFX/score/ambience remain in audio planning; transition SFX are applied by render/edit at cut boundaries."
      : "LLM edit plan chooses visual xfade transitions only. Transition SFX are disabled for this narrator-only/silent-transition run.",
    hook_duration_sec: hookDurationSec,
    retention_ramp_sec: retentionRampSec,
    candidate_boundary_count: boundaries.length,
    transition_event_count: events.length,
    hook_transition_sfx_count: events.filter((event) => event.in_hook && event.transition_sfx).length,
    retention_ramp_transition_sfx_count: events.filter((event) => event.in_retention_ramp && event.transition_sfx).length,
    transition_events: events,
    warnings: [...priorWarnings, ...(llm.parsed.warnings ?? [])],
    failed_boundary_ids: failedBoundaryIds,
    updated_at: nowIso(),
  };
  await writeJson(outputPath, report);
  console.log(JSON.stringify({ status: report.status, output_path: outputPath, transition_event_count: report.transition_event_count, hook_transition_sfx_count: report.hook_transition_sfx_count }, null, 2));
  if (report.status !== "passed") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(async (error) => {
    const existingPlan = await readJson(outputPath, null);
    if (existingPlan?.schema !== "goldflow_transition_edit_plan_v1") {
      await writeJson(outputPath, { schema: "goldflow_transition_edit_plan_v1", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: nowIso() }).catch(() => {});
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
