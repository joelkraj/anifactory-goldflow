import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pilotArtifactContainsPrivateData } from "./avatar-pilot-artifacts.mjs";
import { preparePilotVisualReview, validateLocalVisualReviewShape } from "./avatar-pilot-style-preview.mjs";

export const PROGRAM_REVIEW_SCHEMA = "goldflow_avatar_pilot_program_review_request_v1";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const need = (ok, message) => { if (!ok) throw new Error(`Program review blocked: ${message}`); };
const text = (value) => typeof value === "string" && value.trim().length > 0;
const same = (a, b) => a?.path === b?.path && a?.sha256 === b?.sha256;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const within = (file, directory) => file.startsWith(`${directory}${path.sep}`);

async function binding(file) {
  need(path.isAbsolute(file) && !file.includes("\0"), "absolute local input required");
  const stat = await fs.lstat(file);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 512 * 1024 * 1024
    && await fs.realpath(file) === file, "bounded regular input without aliases required");
  return { path: file, sha256: hash(await fs.readFile(file)) };
}
async function bound(ref, refs) {
  need(ref && same(ref, await binding(ref.path)), "stale source binding");
  refs.push({ path: ref.path, sha256: ref.sha256 });
  return ref;
}
async function json(ref, refs) {
  await bound(ref, refs);
  const value = JSON.parse(await fs.readFile(ref.path, "utf8"));
  need(value && !pilotArtifactContainsPrivateData(value), "invalid or private review artifact");
  return value;
}

export function validateProgramReviewShape(manifest) {
  validateLocalVisualReviewShape(manifest, { schema: PROGRAM_REVIEW_SCHEMA, intent: "local_program_review", minFrames: 2700, maxFrames: 2700 });
  need(manifest.width === 1920 && manifest.height === 1080 && manifest.fps === 30, "exact 1080p30 program required");
  need(manifest.narration.source_in_sec === 0, "complete narration must start at source zero");
  const approval = manifest.style_direction_approval;
  need(approval?.authorizes_full_90_second_review === true && text(approval.reviewer) && text(approval.note)
    && Array.isArray(approval.operator_messages) && approval.operator_messages.length > 0
    && approval.operator_messages.every(text), "existing operator style approval and full-program review authorization required");
  need(manifest.accepted_style_preview?.path && /^[a-f0-9]{64}$/.test(manifest.accepted_style_preview.sha256 ?? ""),
    "exact successful reviewed style preview required");
  need(!Object.hasOwn(manifest, "timeline_approval") && !Object.hasOwn(manifest, "program_approval"),
    "the new program cannot claim prior exact-edit acceptance");
  need(manifest.recipe.captions?.length === 0 && manifest.recipe.new_synthesis === false
    && manifest.recipe.added_music_or_sfx === false, "no captions, synthesis or new music/SFX in this review scope");
  validateProgramNarrationPlacements(manifest, manifest.narration.source_out_sec);
  validateProgramReviewTimeline(manifest);
  return manifest;
}

export function validateProgramNarrationPlacements(manifest, durationSec) {
  const placements = manifest.narration_placements ?? [manifest.narration];
  need(Array.isArray(placements) && placements.length > 0 && placements.length <= 30, "bounded narration placements required");
  let source = 0, output = 0;
  for (const row of placements) {
    need([row.source_in_sec, row.source_out_sec, row.output_in_sec].every(Number.isFinite)
      && Math.abs(row.source_in_sec - source) < 0.000001 && row.source_out_sec > row.source_in_sec
      && row.output_in_sec >= output && row.output_in_sec + row.source_out_sec - row.source_in_sec <= 90,
    "narration must remain complete, in source order, without gaps, repetition or overlapping placements");
    source = row.source_out_sec;
    output = row.output_in_sec + row.source_out_sec - row.source_in_sec;
  }
  need(Math.abs(source - durationSec) < 0.000001, "every accepted narration sample must be consumed");
  return placements;
}

export function validateProgramReviewTimeline(manifest) {
  const timeline = manifest.recipe.timeline, placements = manifest.narration_placements ?? [manifest.narration];
  need(timeline?.fps === 30 && timeline.width === 1920 && timeline.height === 1080 && timeline.duration_frames === 2700
    && timeline.production_eligible === false && timeline.publish_allowed === false
    && timeline.captions?.length === 0 && timeline.added_music_or_sfx === false,
  "private 1080p30 timeline with no captions or added soundtrack required");
  need(Array.isArray(timeline.narration) && timeline.narration.length === placements.length,
    "render narration must match the validated complete source placements");
  for (const [index, row] of timeline.narration.entries()) {
    const placement = placements[index];
    need(row.asset_id === manifest.narration.asset_id && row.tempo === 1 && Number.isInteger(row.output_start_frame)
      && row.source_in_sec === placement.source_in_sec && row.source_out_sec === placement.source_out_sec
      && Math.abs(row.output_start_frame / 30 - placement.output_in_sec) < 0.000001
      && Math.abs(row.output_end_frame - row.output_start_frame - (row.source_out_sec - row.source_in_sec) * 30) < 0.000001,
    "render narration placement or tempo differs from the preserved source contract");
  }
  need(Array.isArray(timeline.shots) && timeline.shots.length > 0 && timeline.shots.length <= 60, "bounded typed shots required");
  let end = 0;
  const assets = Object.fromEntries(manifest.assets.map((row) => [row.id, row]));
  for (const shot of timeline.shots) {
    need(Number.isInteger(shot.start_frame) && Number.isInteger(shot.end_frame) && shot.start_frame === end
      && shot.end_frame > shot.start_frame && shot.end_frame <= 2700
      && ["room", "evidence", "intercept", "rescue", "void", "hold", "payoff", "comparison"].includes(shot.type),
    "shots must cover every program frame once in typed source order");
    need(["commentary", "hypothetical", "film_evidence"].includes(shot.truth_mode) && text(shot.label)
      && (shot.truth_mode !== "hypothetical" || shot.label === "OUR WHAT-IF"), "visible evidence/hypothesis distinction required");
    if (shot.host_pose) need(assets[shot.host_pose]?.kind === "host_pose", "shot host must be an accepted pose");
    for (const id of [shot.left_asset_id, shot.right_asset_id, ...(shot.cues ?? []).map((cue) => cue.asset_id)].filter(Boolean))
      need(assets[id], "shot refers to an unbound asset");
    if (shot.film) {
      const film = shot.film, duration = film.source_out_sec - film.source_in_sec;
      need(shot.type === "evidence" && shot.truth_mode === "film_evidence" && shot.label === "FILM EVIDENCE"
        && assets[film.asset_id]?.kind === "movie_clip" && film.source_in_sec >= 0 && duration >= 3 && duration <= 5
        && film.loop === false && Math.abs((shot.end_frame - shot.start_frame) / 30 - duration) < 0.000001,
      "film evidence must play one bound 3–5-second excerpt at original speed");
    } else need(shot.type !== "evidence" && shot.truth_mode !== "film_evidence", "film evidence cannot use a substituted illustration");
    end = shot.end_frame;
  }
  need(end === 2700, "timeline must cover exactly 2700 frames");
  need(Array.isArray(timeline.source_audio) && timeline.source_audio.length <= 2, "bounded source-audio spotlights required");
  for (const audio of timeline.source_audio) {
    const shot = timeline.shots.find((entry) => entry.start_frame === audio.start_frame && entry.end_frame === audio.end_frame);
    need(shot?.film?.asset_id === audio.asset_id && shot.film.source_in_sec === audio.source_in_sec
      && shot.film.source_out_sec === audio.source_out_sec && audio.loop === false && audio.mode === "spotlight"
      && Number.isFinite(audio.gain_db) && audio.gain_db <= 0 && audio.gain_db >= -60,
    "source audio must map exactly to its visible clip with an explicit spotlight gain");
    need(timeline.narration.every((row) => row.output_end_frame <= audio.start_frame || row.output_start_frame >= audio.end_frame),
      "source-audio spotlight must fall wholly inside a narration pause");
  }
  return timeline;
}

export async function preparePilotProgramReview(args) {
  const prepared = await preparePilotVisualReview({ ...args, validateShape: validateProgramReviewShape,
    outputNamespace: "pilot_program_reviews", allowMovieCutout: true });
  const { manifest, refs } = prepared;
  need(Math.abs(manifest.narration.source_out_sec - prepared.narrationDurationSec) < 0.000001,
    "complete exact-duration accepted narration required");
  validateProgramNarrationPlacements(manifest, prepared.narrationDurationSec);
  need(manifest.recipe.timeline.source_script_sha256 === args.report.identity.source_script.sha256
    && manifest.recipe.timeline.narration_audio_sha256 === prepared.assets[manifest.narration.asset_id].sha256,
  "authored timeline must bind the accepted source script and narration master");
  const priorRef = manifest.accepted_style_preview;
  need(within(priorRef.path, path.join(args.episodeDir, "pilot_visual_reviews"))
    && path.basename(priorRef.path) === "result.json", "retained pilot style-preview receipt required");
  const prior = await json(priorRef, refs);
  need(prior.schema === "goldflow_avatar_pilot_style_preview_result_v1" && prior.status === "awaiting_visual_review"
    && same(prior.identity, prepared.identity) && prior.duration_frames >= 240 && prior.duration_frames <= 360
    && prior.official_stage_completed === false && prior.production_eligible === false && prior.publish_allowed === false,
  "successful matching private style preview required");
  await bound(prior.output, refs);
  const priorManifest = await json(prior.request, refs);
  need(priorManifest.identity_sha256 === manifest.identity_sha256, "style request identity mismatch");
  for (const ref of prior.inputs) await bound(ref, refs);
  for (const row of manifest.assets.filter((entry) => entry.kind === "illustration")) {
    if (row.provenance.type === "source_movie_cutout") continue;
    need(equal(row, priorManifest.assets.find((entry) => entry.id === row.id)),
      "external illustrations must be the exact artwork and provenance from the accepted style preview");
  }
  for (const name of ["avatar-pilot-program-review.mjs", "avatar-pilot-program-renderer.mjs", "avatar-pilot-style-preview.mjs", "avatar-pilot-workflow.mjs"])
    await bound(await binding(path.join(args.repoRoot, "scripts/lib", name)), refs);
  return prepared;
}

export async function producePilotProgramReview(prepared) {
  const { manifest, assets, outputDir, refs } = prepared;
  await fs.mkdir(path.dirname(outputDir), { recursive: true });
  await fs.mkdir(outputDir);
  const write = (name, value) => fs.writeFile(path.join(outputDir, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await write("request.json", manifest);
  await write("execution_started.json", { schema: "goldflow_avatar_pilot_program_review_execution_v1", created_at: new Date().toISOString(),
    identity: prepared.identity, request: prepared.request, inputs: refs, runtime: prepared.runtime,
    accepted_style_preview: manifest.accepted_style_preview, style_direction_approval: manifest.style_direction_approval,
    duration_frames: 2700, provider_calls: 0, provider_cost: 0, production_eligible: false, publish_allowed: false,
    exact_program_approval_recorded: false });
  const { renderProgramReview } = await import("./avatar-pilot-program-renderer.mjs");
  const result = await renderProgramReview({ outputDir, manifest, assets });
  need(within(result.output?.path ?? "", outputDir), "renderer output must remain in the fresh review directory");
  await bound(result.output, []);
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-count_frames", "-show_streams", "-show_format", "-of", "json", result.output.path],
    { encoding: "utf8", timeout: 60000, maxBuffer: 2 * 1024 * 1024, env: { PATH: process.env.PATH, LANG: "C" } }));
  const video = probe.streams.filter((row) => row.codec_type === "video"), audio = probe.streams.filter((row) => row.codec_type === "audio");
  need(video.length === 1 && video[0].width === 1920 && video[0].height === 1080 && video[0].r_frame_rate === "30/1"
    && Number(video[0].nb_read_frames) === 2700 && audio.length === 1 && Math.abs(Number(probe.format.duration) - 90) <= 0.08,
  "review must contain exactly 2700 1080p30 frames and one complete program audio track");
  for (const ref of refs) await bound(ref, []);
  const receipt = { schema: "goldflow_avatar_pilot_program_review_result_v1", status: "awaiting_program_review", created_at: new Date().toISOString(),
    identity: prepared.identity, request: prepared.request, inputs: refs, runtime: prepared.runtime,
    accepted_style_preview: manifest.accepted_style_preview, style_direction_approval: manifest.style_direction_approval,
    output: result.output, technical_report: result.technical_report ?? null, duration_frames: 2700, width: 1920, height: 1080, fps: 30,
    narration_duration_sec: prepared.narrationDurationSec, narration_placements: manifest.narration_placements ?? [manifest.narration],
    provider_calls: 0, provider_cost: 0, creative_submissions: 0, official_stage_completed: false,
    exact_program_approval_recorded: false, production_eligible: false, publish_allowed: false };
  await write("result.json", receipt);
  return { ...receipt, receipt: await binding(path.join(outputDir, "result.json")) };
}
