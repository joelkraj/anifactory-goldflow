import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pilotArtifactContainsPrivateData } from "./avatar-pilot-artifacts.mjs";

export const POLISH_FRAME_REPAIR_SCHEMA = "goldflow_avatar_pilot_polish_frame_repair_v1";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const need = (ok, message) => { if (!ok) throw new Error(`Polish frame repair blocked: ${message}`); };
const same = (a, b) => a?.path === b?.path && a?.sha256 === b?.sha256;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const text = (value) => typeof value === "string" && value.trim().length > 0;
const isRef = (ref) => text(ref?.path) && path.isAbsolute(ref.path) && /^[a-f0-9]{64}$/.test(ref.sha256 ?? "");
const within = (file, dir) => file.startsWith(`${dir}${path.sep}`);
const env = { PATH: process.env.PATH, LANG: "C" };

async function bound(ref, refs) {
  need(isRef(ref), "exact local path/hash required");
  const stat = await fs.lstat(ref.path);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size < 2 * 1024 ** 3
    && await fs.realpath(ref.path) === ref.path, "bounded regular local artifact without aliases required");
  need(hash(await fs.readFile(ref.path)) === ref.sha256, "stale retained artifact");
  refs.push({ path: ref.path, sha256: ref.sha256 });
  return ref;
}
async function json(ref, refs) {
  await bound(ref, refs);
  const bytes = await fs.readFile(ref.path);
  need(bytes.length < 16 * 1024 ** 2, "bounded JSON evidence required");
  const value = JSON.parse(bytes);
  need(value && !pilotArtifactContainsPrivateData(value), "valid non-private repair evidence required");
  return value;
}

export function validatePolishFrameRepairShape(manifest) {
  const repair = manifest.polish_frame_repair;
  need(repair?.schema === POLISH_FRAME_REPAIR_SCHEMA
    && repair.cause === "route_chip_clipped_before_camera_reframe"
    && repair.repair === "recompose_exact_span_preserve_other_frames_and_aac"
    && equal(repair.interval, { start_frame: 2079, end_frame: 2145 }),
  "only the identified 66-frame route-chip compositor defect is in scope");
  need(manifest.polish_authorization?.authorizes_sound_motion_polish === true && !manifest.exact_scope_repair
    && manifest.duration_frames === 2700 && manifest.width === 1920 && manifest.height === 1080 && manifest.fps === 30
    && manifest.production_eligible === false && manifest.publish_allowed === false,
  "existing private 90-second polish scope required");
  for (const key of ["prior_program", "prior_request", "prior_qa", "prior_video", "preserved_master", "defect_evidence"])
    need(isRef(repair[key]), `exact ${key} binding required`);
  const scope = repair.operator_scope;
  need(scope?.authorizes_quality_defect_repair === true && text(scope.reviewer) && text(scope.note)
    && Array.isArray(scope.operator_messages) && scope.operator_messages.length > 0 && scope.operator_messages.every(text),
  "actual quality-polish direction must cover the deterministic defect repair");
  need(!Object.hasOwn(repair, "approved") && !Object.hasOwn(repair, "review") && !pilotArtifactContainsPrivateData(repair),
    "repair cannot invent a new listening or viewing approval");
  return manifest;
}

export function validatePolishFrameRepairScope(manifest, priorRequest, priorResult, qa, identity) {
  validatePolishFrameRepairShape(manifest);
  const repair = manifest.polish_frame_repair;
  need(priorRequest.polish_authorization?.authorizes_sound_motion_polish === true && !priorRequest.polish_frame_repair
    && priorRequest.candidate_id !== manifest.candidate_id, "repair requires a different successful initial polish, never a chained repair");
  const preserved = { ...manifest, candidate_id: priorRequest.candidate_id };
  delete preserved.polish_frame_repair;
  need(equal(preserved, priorRequest), "repair cannot change any asset, timeline, source, narration, soundtrack or earlier authorization");
  need(priorResult.schema === "goldflow_avatar_pilot_program_review_result_v1" && priorResult.status === "awaiting_program_review"
    && same(priorResult.identity, identity) && priorRequest.identity_sha256 === identity.sha256
    && same(priorResult.request, repair.prior_request) && same(priorResult.output, repair.prior_video)
    && same(priorResult.technical_report, repair.prior_qa)
    && priorResult.duration_frames === 2700 && priorResult.width === 1920 && priorResult.height === 1080 && priorResult.fps === 30
    && priorResult.provider_calls === 0 && priorResult.official_stage_completed === false
    && priorResult.exact_program_approval_recorded === false && priorResult.production_eligible === false && priorResult.publish_allowed === false,
  "matching successful private polish result required without invented acceptance");
  const shot = manifest.recipe.timeline.shots.find((row) => row.start_frame === 2079 && row.end_frame === 2145);
  need(shot?.id === "24_objective_approaches_exit" && shot.variant === "time_won"
    && shot.truth_mode === "hypothetical" && shot.label === "OUR WHAT-IF", "exact defect shot and its original hypothetical label required");
  need(qa.schema === "goldflow_avatar_program_polish_render_qa_v1" && qa.duration_frames === 2700
    && qa.review_only === true && qa.exact_program_approval_recorded === false
    && same(qa.audio?.master, repair.preserved_master) && qa.audio?.narration_tempo === 1
    && qa.audio.accepted_master_unchanged === true
    && equal(qa.audio.placements, manifest.narration_placements)
    && equal(qa.audio.source_audio, manifest.recipe.timeline.source_audio)
    && equal(qa.audio.soundtrack, manifest.recipe.timeline.soundtrack)
    && same(qa.audio.soundtrack_manifest, manifest.soundtrack_manifest),
  "repair must retain the complete measured mixed soundtrack and all accepted speech");
  need(qa.frames?.some((frame) => same(frame, repair.defect_evidence)
    && frame.frame >= 2079 && frame.frame < 2145), "identified defect evidence must be a retained QA frame from the exact repair interval");
}

export async function preparePolishFrameRepair(prepared, episodeDir) {
  const { manifest, refs } = prepared;
  if (!manifest.polish_frame_repair) return;
  const repair = manifest.polish_frame_repair;
  const priorResult = await json(repair.prior_program, refs);
  const priorRequest = await json(repair.prior_request, refs);
  const qa = await json(repair.prior_qa, refs);
  const priorDir = path.join(episodeDir, "pilot_program_reviews", priorRequest.candidate_id);
  need(repair.prior_program.path === path.join(priorDir, "result.json")
    && repair.prior_qa.path === path.join(priorDir, "render-qa.json")
    && [repair.prior_video.path, repair.preserved_master.path, repair.defect_evidence.path].every((file) => within(file, priorDir)),
  "all output evidence must come from the exact retained successful polish namespace");
  need(within(repair.prior_request.path, path.join(episodeDir, "pilot_media_work"))
    || repair.prior_request.path === path.join(priorDir, "request.json"), "retained original polish input required");
  const copyPath = path.join(priorDir, "request.json");
  const copy = { path: copyPath, sha256: hash(await fs.readFile(copyPath)) };
  need(equal(await json(copy, refs), priorRequest), "prior request copy differs from its original input");
  validatePolishFrameRepairScope(manifest, priorRequest, priorResult, qa, prepared.identity);
  for (const key of ["prior_video", "preserved_master", "defect_evidence"]) await bound(repair[key], refs);
}

function videoFrames(file) {
  const out = execFileSync("ffmpeg", ["-v", "error", "-protocol_whitelist", "file", "-i", file, "-map", "0:v:0", "-an", "-pix_fmt", "yuv420p", "-f", "framemd5", "-"],
    { encoding: "utf8", timeout: 120000, maxBuffer: 2 * 1024 ** 2, env });
  return out.split("\n").filter((line) => line.trim() && !line.startsWith("#")).map((line) => line.split(",").map((value) => value.trim()));
}
function aacPackets(file) {
  return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-select_streams", "a:0",
    "-show_packets", "-show_streams", "-show_data_hash", "sha256", "-show_entries",
    "packet=pts_time,dts_time,duration_time,size,data_hash:stream=codec_name,extradata_hash,sample_rate,channels", "-of", "json", file],
  { encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 ** 2, env }));
}

/** Actual decoded-pixel and AAC-packet checks, not renderer-authored success booleans. */
export function verifyPolishFrameRepairOutput(manifest, output) {
  const repair = manifest.polish_frame_repair;
  need(isRef(output), "exact repaired output required");
  const priorFrames = videoFrames(repair.prior_video.path), nextFrames = videoFrames(output.path);
  need(priorFrames.length === 2700 && nextFrames.length === 2700, "both video streams must decode to exactly 2700 frames");
  let changedInside = 0;
  for (let frame = 0; frame < 2700; frame++) {
    const a = priorFrames[frame], b = nextFrames[frame];
    need(equal(a.slice(0, -1), b.slice(0, -1)), "repair must retain exact video timestamps and frame sizes");
    const changed = a.at(-1) !== b.at(-1);
    if (frame >= 2079 && frame < 2145) changedInside += Number(changed);
    else need(!changed, `unexpected changed decoded frame ${frame} outside the exact repair`);
  }
  need(changedInside > 0, "repair must actually change the identified faulty frame span");
  const priorAudio = aacPackets(repair.prior_video.path), nextAudio = aacPackets(output.path);
  need(priorAudio.streams.length === 1 && priorAudio.streams[0].codec_name === "aac"
    && priorAudio.packets.length > 0 && equal(priorAudio, nextAudio), "every AAC packet, timestamp and codec configuration must remain byte-identical");
  return { schema: "goldflow_avatar_pilot_frame_repair_integrity_v1", interval: repair.interval,
    decoded_frames: 2700, unchanged_outside_frames: 2634, changed_inside_frames: changedInside,
    prior_frame_md5_sha256: hash(JSON.stringify(priorFrames)), repaired_frame_md5_sha256: hash(JSON.stringify(nextFrames)),
    aac_packet_count: priorAudio.packets.length, aac_packets_and_configuration_sha256: hash(JSON.stringify(priorAudio)),
    outside_pixels_unchanged: true, aac_packets_unchanged: true, exact_program_approval_recorded: false };
}

export function verifyPolishFrameRepairPlayback(manifest, playback) {
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-count_frames", "-show_streams", "-show_format", "-of", "json", playback.path],
    { encoding: "utf8", timeout: 60000, maxBuffer: 2 * 1024 ** 2, env }));
  const video = probe.streams.filter((row) => row.codec_type === "video");
  const audio = probe.streams.filter((row) => row.codec_type === "audio");
  need(video.length === 1 && video[0].codec_name === "h264" && ["High", "Main", "Constrained Baseline"].includes(video[0].profile)
    && video[0].width === 1920 && video[0].height === 1080 && video[0].pix_fmt === "yuv420p"
    && video[0].r_frame_rate === "30/1" && Number(video[0].nb_read_frames) === 2700
    && audio.length === 1 && audio[0].codec_name === "aac" && Math.abs(Number(probe.format.duration) - 90) <= 0.08,
  "playback derivative must remain a complete standard-profile 1080p30 H264/AAC private review");
  need(equal(aacPackets(manifest.polish_frame_repair.prior_video.path), aacPackets(playback.path)),
    "playback derivative must retain every original AAC packet and timestamp");
}
