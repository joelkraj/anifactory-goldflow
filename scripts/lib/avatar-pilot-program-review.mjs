import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pilotArtifactContainsPrivateData } from "./avatar-pilot-artifacts.mjs";
import { preparePilotVisualReview, validateLocalVisualReviewShape } from "./avatar-pilot-style-preview.mjs";
import { validatePolishFrameRepairShape, preparePolishFrameRepair, verifyPolishFrameRepairOutput, verifyPolishFrameRepairPlayback } from "./avatar-pilot-polish-frame-repair.mjs";

export const PROGRAM_REVIEW_SCHEMA = "goldflow_avatar_pilot_program_review_request_v1";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const need = (ok, message) => { if (!ok) throw new Error(`Program review blocked: ${message}`); };
const text = (value) => typeof value === "string" && value.trim().length > 0;
const same = (a, b) => a?.path === b?.path && a?.sha256 === b?.sha256;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const within = (file, directory) => file.startsWith(`${directory}${path.sep}`);
const HASH = /^[a-f0-9]{64}$/;
const isPolish = (manifest) => Object.hasOwn(manifest, "polish_authorization");
const isRef = (ref) => text(ref?.path) && path.isAbsolute(ref.path) && HASH.test(ref.sha256 ?? "");
const overlaps = (a, b) => a.start_frame < b.end_frame && a.end_frame > b.start_frame;

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
  if (manifest.exact_scope_repair) {
    const repair = manifest.exact_scope_repair;
    need(equal(Object.keys(repair).sort(), ["cause", "prior_execution", "prior_request", "repair", "retained_raw_mix"].sort())
      && repair.cause === "ffmpeg_loudnorm_json_trailing_status"
      && repair.repair === "parse_bounded_loudnorm_json_preserve_raw_mix",
    "only the retained raw-mix loudnorm parse repair is supported");
    for (const key of ["prior_execution", "prior_request", "retained_raw_mix"])
      need(text(repair[key]?.path) && /^[a-f0-9]{64}$/.test(repair[key]?.sha256 ?? ""), "repair must bind exact retained artifacts");
  }
  need(manifest.recipe.captions?.length === 0 && manifest.recipe.new_synthesis === false,
    "no captions or synthesis in this review scope");
  if (isPolish(manifest)) validateProgramPolishShape(manifest);
  else need(manifest.recipe.added_music_or_sfx === false && !manifest.prior_program && !manifest.polish_budget
    && !manifest.soundtrack_assets && !manifest.soundtrack_manifest && !manifest.recipe.timeline?.soundtrack && !manifest.polish_frame_repair,
  "new music/SFX requires the separately bounded operator-authorized polish scope");
  validateProgramNarrationPlacements(manifest, manifest.narration.source_out_sec);
  validateProgramReviewTimeline(manifest);
  if (manifest.polish_frame_repair) validatePolishFrameRepairShape(manifest);
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
    && timeline.captions?.length === 0 && timeline.added_music_or_sfx === isPolish(manifest),
  "private 1080p30 timeline with no captions and matching soundtrack scope required");
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

/** A sound/motion review is not an import route for speech, new film or generated art. */
export function validateProgramPolishShape(manifest) {
  const authorization = manifest.polish_authorization, budget = manifest.polish_budget;
  need(authorization?.authorizes_sound_motion_polish === true && text(authorization.reviewer) && text(authorization.note)
    && Array.isArray(authorization.operator_messages) && authorization.operator_messages.length > 0
    && authorization.operator_messages.every(text), "actual operator sound-and-motion polish direction required");
  need(isRef(manifest.prior_program) && isRef(manifest.preserved_program_mix) && !manifest.exact_scope_repair,
    "polish must bind a successful prior program, not a failed-render repair");
  need(budget?.provider_calls === 0 && budget.provider_cost_usd === 0 && budget.new_voice_takes === 0
    && budget.new_visual_assets === 0 && Number.isInteger(budget.max_soundtrack_assets)
    && budget.max_soundtrack_assets >= 1 && budget.max_soundtrack_assets <= 14
    && Number.isInteger(budget.max_soundtrack_cues) && budget.max_soundtrack_cues >= 1 && budget.max_soundtrack_cues <= 36,
  "explicit zero-spend, zero-synthesis, bounded soundtrack polish budget required");
  need(manifest.recipe.added_music_or_sfx === true && manifest.recipe.new_synthesis === false
    && isRef(manifest.soundtrack_manifest), "polish requires an exact local soundtrack manifest");
  const assets = manifest.soundtrack_assets;
  need(Array.isArray(assets) && assets.length > 0 && assets.length <= budget.max_soundtrack_assets
    && new Set(assets.map((row) => row.id)).size === assets.length,
  "bounded unique soundtrack assets required");
  need(assets.filter((row) => row.kind === "music").length <= 2
    && assets.filter((row) => row.kind === "sfx").length <= 12, "at most two music and twelve SFX sources");
  const baseHashes = new Set(manifest.assets.map((row) => row.sha256));
  for (const row of assets) {
    need(/^[a-z0-9][a-z0-9_-]{0,79}$/.test(row.id ?? "") && !manifest.assets.some((asset) => asset.id === row.id)
      && ["music", "sfx"].includes(row.kind) && isRef(row) && isRef(row.source) && same(row, row.source)
      && row.contains_speech === false && !baseHashes.has(row.sha256) && !baseHashes.has(row.source.sha256)
      && Number.isFinite(row.duration_sec) && row.duration_sec > 0 && row.duration_sec <= 600
      && text(row.intended_use), "soundtrack must be separate source-bound non-speech music or SFX, never narration or film");
    need([".wav", ".mp3", ".ogg", ".flac", ".m4a"].includes(path.extname(row.path).toLowerCase())
      && [".wav", ".mp3", ".ogg", ".flac", ".m4a"].includes(path.extname(row.source.path).toLowerCase()),
    "native local soundtrack audio required");
    for (const [field, address] of [["source_url", row.source_url], ["source_page", row.source_page], ["license", row.license?.url]]) {
      let url;
      try { url = new URL(address); } catch { need(false, "public unsigned soundtrack source and license URLs required"); }
      const publicPageQuery = field === "source_page" && [...url.searchParams.keys()].every((key) => ["Search", "isrc"].includes(key));
      need(url.protocol === "https:" && !url.username && !url.password && (!url.search || publicPageQuery) && !url.hash,
        "public unsigned soundtrack source and license URLs required");
    }
    need(["CC0-1.0", "CC-BY-4.0", "CC-BY-3.0", "Pixabay-Content-License"].includes(row.license?.id)
      && row.license.permits_modification === true && row.license.permits_synchronization === true
      && text(row.license.attribution) && isRef(row.license.text) && isRef(row.license_application_evidence),
    "retained license must permit editing and synchronization and retain attribution");
  }
  const soundtrack = manifest.recipe.timeline?.soundtrack;
  need(Array.isArray(soundtrack) && soundtrack.length > 0 && soundtrack.length <= budget.max_soundtrack_cues
    && new Set(soundtrack.map((row) => row.id)).size === soundtrack.length, "bounded unique authored soundtrack cues required");
  for (const cue of soundtrack) {
    const asset = assets.find((row) => row.id === cue.asset_id);
    need(asset && /^[a-z0-9][a-z0-9_-]{0,79}$/.test(cue.id ?? "")
      && Number.isInteger(cue.start_frame) && Number.isFinite(cue.end_frame)
      && cue.start_frame >= 0 && cue.end_frame > cue.start_frame && cue.end_frame <= 2700
      && Number.isFinite(cue.source_in_sec) && cue.source_in_sec >= 0
      && Number.isFinite(cue.source_out_sec) && cue.source_out_sec > cue.source_in_sec
      && cue.source_out_sec <= asset.duration_sec + 0.001 && cue.loop === false
      && Math.abs((cue.source_out_sec - cue.source_in_sec) * 30 - (cue.end_frame - cue.start_frame)) < 0.001,
    "soundtrack cues must remain source-bound, unlooped and wholly inside 2700 frames at original speed");
    need(cue.role === (asset.kind === "music" ? "music_bed" : "punctuation")
      && Number.isFinite(cue.gain_db) && cue.gain_db >= -60 && cue.gain_db <= (asset.kind === "music" ? -12 : -6)
      && [cue.fade_in_sec, cue.fade_out_sec].every((value) => Number.isFinite(value) && value >= 0)
      && cue.fade_in_sec + cue.fade_out_sec <= cue.source_out_sec - cue.source_in_sec + 0.001,
    "soundtrack requires restrained explicit gains and in-scope fades");
    need((manifest.recipe.timeline.source_audio ?? []).every((spotlight) => !overlaps(cue, spotlight)),
      "music and SFX cannot overlap preserved film-audio spotlights");
  }
  need(assets.every((asset) => soundtrack.some((cue) => cue.asset_id === asset.id)), "unused soundtrack sources are outside scope");
  return manifest;
}

export function validateProgramPolishScope(manifest, priorRequest, priorResult, identity) {
  need(isPolish(manifest) && priorRequest.candidate_id !== manifest.candidate_id && !isPolish(priorRequest),
    "polish must preserve a different completed first-style program; chained polish is not enabled");
  need(priorResult.schema === "goldflow_avatar_pilot_program_review_result_v1" && priorResult.status === "awaiting_program_review"
    && same(priorResult.identity, identity) && priorRequest.identity_sha256 === identity.sha256
    && priorResult.duration_frames === 2700 && priorResult.width === 1920 && priorResult.height === 1080 && priorResult.fps === 30
    && priorResult.provider_calls === 0 && priorResult.production_eligible === false && priorResult.publish_allowed === false
    && priorResult.official_stage_completed === false && priorResult.exact_program_approval_recorded === false,
  "successful matching private 90-second prior program required, without invented approval");
  for (const key of ["identity_sha256", "duration_frames", "width", "height", "fps", "production_eligible", "publish_allowed",
    "accepted_style_preview", "style_direction_approval", "assets", "narration", "narration_placements"])
    need(equal(manifest[key], priorRequest[key]), `polish cannot change preserved ${key}`);
  for (const key of ["source_script_sha256", "narration_audio_sha256", "narration", "source_audio", "captions"])
    need(equal(manifest.recipe.timeline[key], priorRequest.recipe.timeline[key]), `polish cannot change timeline ${key}`);
  const films = (timeline) => timeline.shots.filter((shot) => shot.film).map((shot) => ({
    start_frame: shot.start_frame, end_frame: shot.end_frame, truth_mode: shot.truth_mode, label: shot.label, film: shot.film,
  }));
  need(equal(films(manifest.recipe.timeline), films(priorRequest.recipe.timeline)),
    "polish must preserve exact film excerpts, intervals, playback and truth labels");
  for (const shot of manifest.recipe.timeline.shots) {
    const scene = shot.scene;
    if (scene) {
      const prior = priorRequest.recipe.timeline.shots.find((row) => row.id === scene.id);
      need(prior && scene.start_frame === prior.start_frame && scene.end_frame === prior.end_frame
        && shot.start_frame >= scene.start_frame && shot.end_frame <= scene.end_frame,
      "split-shot motion scene must retain an exact prior scene interval");
    }
    const camera = shot.framing?.camera;
    if (camera) need([camera.start_scale, camera.end_scale].every((value) => Number.isFinite(value) && value >= 1 && value <= 1.85)
      && Number.isFinite(camera.anchor_x) && camera.anchor_x >= 0 && camera.anchor_x <= 1920
      && Number.isFinite(camera.anchor_y) && camera.anchor_y >= 0 && camera.anchor_y <= 1080
      && ["linear", "smoothstep", "ease_out_cubic"].includes(camera.ease), "bounded authored camera framing required");
    for (const [key, limit] of [["target_x", 1920], ["target_y", 1080]])
      if (camera && Object.hasOwn(camera, key)) need(Number.isFinite(camera[key]) && camera[key] >= 0 && camera[key] <= limit,
        "camera reframing target must remain on the composition");
    if (shot.framing?.focus_asset_id) need(manifest.assets.some((row) => row.id === shot.framing.focus_asset_id),
      "camera focus must use a preserved base asset");
    if (shot.transition_in) need(text(shot.transition_in.kind) && Number.isInteger(shot.transition_in.frames)
      && shot.transition_in.frames >= 0 && shot.transition_in.frames <= 15
      && shot.transition_in.frames < shot.end_frame - shot.start_frame, "bounded transition duration required");
  }
}

/** Authenticate the prior successful result and every added local source before any render write. */
export async function prepareProgramPolish(prepared, episodeDir) {
  const { manifest, refs } = prepared;
  if (!isPolish(manifest)) return;
  const priorResult = await json(manifest.prior_program, refs);
  const priorRequest = await json(priorResult.request, refs);
  const priorDirectory = path.join(episodeDir, "pilot_program_reviews", priorRequest.candidate_id);
  need(manifest.prior_program.path === path.join(priorDirectory, "result.json")
    && (within(priorResult.request.path, path.join(episodeDir, "pilot_media_work"))
      || priorResult.request.path === path.join(priorDirectory, "request.json"))
    && within(priorResult.output?.path ?? "", priorDirectory), "prior program artifacts must remain in their exact retained namespace");
  need(equal(await json(await binding(path.join(priorDirectory, "request.json")), refs), priorRequest),
    "retained program request must match the exact original input");
  validateProgramPolishScope(manifest, priorRequest, priorResult, prepared.identity);
  await bound(priorResult.output, refs);
  const technical = await json(priorResult.technical_report, refs);
  need(technical.schema === "goldflow_avatar_program_render_qa_v1" && technical.duration_frames === 2700
    && same(technical.audio?.raw, manifest.preserved_program_mix)
    && same(technical.audio?.source, manifest.assets.find((row) => row.kind === "narration"))
    && technical.audio?.narration_tempo === 1 && technical.audio.accepted_master_unchanged === true
    && equal(technical.audio.placements, manifest.narration_placements)
    && equal(technical.audio.source_audio, manifest.recipe.timeline.source_audio),
  "polish must preserve the prior technical report's exact lossless narration-and-film mix");
  await bound(manifest.preserved_program_mix, refs);
  const baseProbe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-show_streams", "-show_format", "-of", "json", manifest.preserved_program_mix.path],
    { encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1024 * 1024, env: { PATH: process.env.PATH, LANG: "C" } }));
  need(baseProbe.streams.length === 1 && baseProbe.streams[0].codec_name === "pcm_s24le"
    && baseProbe.streams[0].sample_rate === "48000" && baseProbe.streams[0].channels === 2
    && Number(baseProbe.format.duration) === 90, "preserved program mix must be complete 90-second lossless stereo");
  const namespace = path.dirname(manifest.soundtrack_manifest.path);
  need(within(namespace, path.join(episodeDir, "pilot_media_work")) && path.basename(namespace).startsWith("polish_audio_"),
    "added soundtrack inputs require a separate polish_audio namespace");
  const soundtrack = await json(manifest.soundtrack_manifest, refs);
  need(soundtrack.schema === "goldflow_avatar_pilot_soundtrack_assets_v1" && equal(soundtrack.assets, manifest.soundtrack_assets),
    "soundtrack rows must match their exact retained acquisition manifest");
  for (const row of manifest.soundtrack_assets) {
    need([row.path, row.source.path, row.license.text.path].every((file) => within(file, namespace)),
      "soundtrack sources and license evidence must stay inside the new namespace");
    for (const ref of [row, row.source, row.license.text]) await bound(ref, refs);
    for (const ref of [row.license_application_evidence, row.archive].filter(Boolean)) {
      need(isRef(ref) && within(ref.path, namespace), "retained audio acquisition evidence must remain source-bound in the new namespace");
      await bound(ref, refs);
    }
    if (row.archive) {
      need(typeof row.archive.entry === "string" && /^[a-zA-Z0-9_./-]+$/.test(row.archive.entry)
        && !row.archive.entry.startsWith("/") && !row.archive.entry.split("/").includes(".."),
      "exact safe audio archive member required");
      const member = execFileSync("unzip", ["-p", row.archive.path, row.archive.entry],
        { timeout: 30000, maxBuffer: 64 * 1024 * 1024, env: { PATH: process.env.PATH, LANG: "C" } });
      need(hash(member) === row.sha256, "local cue must be the exact source-bound licensed archive member");
    }
    need((await fs.readFile(row.license.text.path, "utf8")).trim().length >= 80, "actual retained license text required");
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-show_streams", "-show_format", "-of", "json", row.path],
      { encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1024 * 1024, env: { PATH: process.env.PATH, LANG: "C" } }));
    need(probe.streams.length === 1 && probe.streams[0].codec_type === "audio"
      && Math.abs(Number(probe.format.duration) - row.duration_sec) <= 0.05,
    "soundtrack must probe as one exact-duration audio-only source");
    prepared.assets[row.id] = { ...row };
  }
}

export function validateProgramRepairScope(manifest, priorRequest, execution, identity) {
  const repair = manifest.exact_scope_repair;
  need(repair && priorRequest.candidate_id !== manifest.candidate_id && !priorRequest.exact_scope_repair,
    "repair must retain a different first-attempt candidate; chained repairs are unavailable");
  const unchanged = { ...manifest, candidate_id: priorRequest.candidate_id };
  delete unchanged.exact_scope_repair;
  need(equal(unchanged, priorRequest), "repair cannot change the timeline, media, narration, mix or authorization");
  need(execution.schema === "goldflow_avatar_pilot_program_review_execution_v1" && same(execution.identity, identity)
    && execution.request?.sha256 === repair.prior_request.sha256 && execution.duration_frames === 2700
    && execution.provider_calls === 0 && execution.production_eligible === false && execution.publish_allowed === false
    && execution.exact_program_approval_recorded === false,
  "retained raw mix must belong to the matching guarded private execution");
}

async function prepareProgramRepair(prepared, episodeDir) {
  const { manifest, refs } = prepared, repair = manifest.exact_scope_repair;
  if (!repair) return;
  const priorDirectory = path.dirname(repair.prior_request.path);
  const priorRequest = await json(repair.prior_request, refs);
  need(priorDirectory === path.join(episodeDir, "pilot_program_reviews", priorRequest.candidate_id)
    && repair.prior_request.path === path.join(priorDirectory, "request.json")
    && repair.prior_execution.path === path.join(priorDirectory, "execution_started.json")
    && repair.retained_raw_mix.path === path.join(priorDirectory, "program-mix-unmastered.wav"),
  "repair artifacts must share the exact earlier candidate directory");
  const execution = await json(repair.prior_execution, refs);
  validateProgramRepairScope(manifest, priorRequest, execution, prepared.identity);
  await bound(execution.request, refs);
  need(equal((await fs.readdir(priorDirectory)).sort(), ["execution_started.json", "program-mix-unmastered.wav", "request.json"]),
    "repair requires only the retained request, execution and raw mix; no completed or downstream output may exist");
  await bound(repair.retained_raw_mix, refs);
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-show_streams", "-show_format", "-of", "json", repair.retained_raw_mix.path],
    { encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1024 * 1024, env: { PATH: process.env.PATH, LANG: "C" } }));
  need(probe.streams.length === 1 && probe.streams[0].codec_name === "pcm_s24le"
    && probe.streams[0].sample_rate === "48000" && probe.streams[0].channels === 2
    && Number(probe.format.duration) === 90, "retained raw mix must be the complete lossless 90-second stereo program");
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
  for (const name of ["avatar-pilot-program-review.mjs", "avatar-pilot-program-renderer.mjs", "avatar-pilot-style-preview-renderer.mjs", "avatar-pilot-style-preview.mjs", "avatar-pilot-workflow.mjs"])
    await bound(await binding(path.join(args.repoRoot, "scripts/lib", name)), refs);
  await prepareProgramRepair(prepared, args.episodeDir);
  await prepareProgramPolish(prepared, args.episodeDir);
  if (isPolish(manifest)) await bound(await binding(path.join(args.repoRoot, "scripts/lib/avatar-pilot-polish-renderer.mjs")), refs);
  await preparePolishFrameRepair(prepared, args.episodeDir);
  if (manifest.polish_frame_repair) {
    for (const name of ["avatar-pilot-polish-frame-repair.mjs", "avatar-pilot-polish-frame-repair-renderer.mjs"])
      await bound(await binding(path.join(args.repoRoot, "scripts/lib", name)), refs);
  }
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
    exact_scope_repair: manifest.exact_scope_repair ?? null,
    prior_program: manifest.prior_program ?? null, polish_authorization: manifest.polish_authorization ?? null,
    polish_budget: manifest.polish_budget ?? null, soundtrack_manifest: manifest.soundtrack_manifest ?? null,
    preserved_program_mix: manifest.preserved_program_mix ?? null,
    polish_frame_repair: manifest.polish_frame_repair ?? null,
    duration_frames: 2700, provider_calls: 0, provider_cost: 0, production_eligible: false, publish_allowed: false,
    exact_program_approval_recorded: false });
  const renderer = manifest.polish_frame_repair
    ? (await import("./avatar-pilot-polish-frame-repair-renderer.mjs")).renderPolishFrameRepair
    : isPolish(manifest)
    ? (await import("./avatar-pilot-polish-renderer.mjs")).renderPolishReview
    : (await import("./avatar-pilot-program-renderer.mjs")).renderProgramReview;
  const result = await renderer({ outputDir, manifest, assets });
  need(within(result.output?.path ?? "", outputDir), "renderer output must remain in the fresh review directory");
  await bound(result.output, []);
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-count_frames", "-show_streams", "-show_format", "-of", "json", result.output.path],
    { encoding: "utf8", timeout: 60000, maxBuffer: 2 * 1024 * 1024, env: { PATH: process.env.PATH, LANG: "C" } }));
  const video = probe.streams.filter((row) => row.codec_type === "video"), audio = probe.streams.filter((row) => row.codec_type === "audio");
  need(video.length === 1 && video[0].width === 1920 && video[0].height === 1080 && video[0].r_frame_rate === "30/1"
    && Number(video[0].nb_read_frames) === 2700 && audio.length === 1 && Math.abs(Number(probe.format.duration) - 90) <= 0.08,
  "review must contain exactly 2700 1080p30 frames and one complete program audio track");
  let frameRepairIntegrity = null;
  let reviewPlayback = null;
  if (manifest.polish_frame_repair) {
    const integrity = verifyPolishFrameRepairOutput(manifest, result.output);
    await write("frame-repair-integrity.json", integrity);
    frameRepairIntegrity = await binding(path.join(outputDir, "frame-repair-integrity.json"));
    if (result.review_playback) {
      need(within(result.review_playback.path ?? "", outputDir) && result.review_playback.path !== result.output.path,
        "playback derivative must remain separate in the fresh exact-repair namespace");
      await bound(result.review_playback, []);
      verifyPolishFrameRepairPlayback(manifest, result.review_playback);
      reviewPlayback = result.review_playback;
    }
  }
  for (const ref of refs) await bound(ref, []);
  const receipt = { schema: "goldflow_avatar_pilot_program_review_result_v1", status: "awaiting_program_review", created_at: new Date().toISOString(),
    identity: prepared.identity, request: prepared.request, inputs: refs, runtime: prepared.runtime,
    accepted_style_preview: manifest.accepted_style_preview, style_direction_approval: manifest.style_direction_approval,
    exact_scope_repair: manifest.exact_scope_repair ?? null,
    prior_program: manifest.prior_program ?? null, polish_authorization: manifest.polish_authorization ?? null,
    polish_budget: manifest.polish_budget ?? null, soundtrack_manifest: manifest.soundtrack_manifest ?? null,
    preserved_program_mix: manifest.preserved_program_mix ?? null,
    polish_frame_repair: manifest.polish_frame_repair ?? null, frame_repair_integrity: frameRepairIntegrity,
    review_playback: reviewPlayback,
    output: result.output, technical_report: result.technical_report ?? null, duration_frames: 2700, width: 1920, height: 1080, fps: 30,
    narration_duration_sec: prepared.narrationDurationSec, narration_placements: manifest.narration_placements ?? [manifest.narration],
    provider_calls: 0, provider_cost: 0, creative_submissions: 0, official_stage_completed: false,
    exact_program_approval_recorded: false, production_eligible: false, publish_allowed: false };
  await write("result.json", receipt);
  return { ...receipt, receipt: await binding(path.join(outputDir, "result.json")) };
}
