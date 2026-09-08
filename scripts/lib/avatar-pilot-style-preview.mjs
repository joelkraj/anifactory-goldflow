import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pilotArtifactContainsPrivateData } from "./avatar-pilot-artifacts.mjs";
import { resolvePilotHostIdentityApproval } from "./avatar-pilot-host-identity-approval.mjs";
import { validateFootageClipReceipt } from "./footage-library.mjs";

export const STYLE_PREVIEW_SCHEMA = "goldflow_avatar_pilot_style_preview_request_v1";
const HASH = /^[a-f0-9]{64}$/;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const text = (value) => typeof value === "string" && value.trim().length > 0;
const need = (ok, message) => { if (!ok) throw new Error(`Style preview blocked: ${message}`); };
const same = (a, b) => a?.path === b?.path && a?.sha256 === b?.sha256;
const within = (file, directory) => file.startsWith(`${directory}${path.sep}`);

async function bytesAt(file) {
  need(path.isAbsolute(file) && !file.includes("\0"), "absolute local files required");
  const stat = await fs.lstat(file);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 512 * 1024 * 1024
    && await fs.realpath(file) === file, "bounded regular input without symlink aliases required");
  return fs.readFile(file);
}
async function binding(file) { return { path: file, sha256: hash(await bytesAt(file)) }; }
async function bound(ref, refs) {
  need(ref && text(ref.path) && HASH.test(ref.sha256 ?? ""), "path and SHA-256 binding required");
  const bytes = await bytesAt(ref.path);
  need(hash(bytes) === ref.sha256, "stale input hash");
  refs.push({ path: ref.path, sha256: ref.sha256 });
  return bytes;
}
async function json(ref, refs) {
  const bytes = await bound(ref, refs);
  need(bytes.length <= 32 * 1024 * 1024, "JSON exceeds review input limit");
  const row = JSON.parse(bytes.toString("utf8"));
  need(row && typeof row === "object" && !Array.isArray(row) && !pilotArtifactContainsPrivateData(row), "invalid or private review artifact");
  return row;
}

export function validateLocalVisualReviewShape(manifest, { schema = STYLE_PREVIEW_SCHEMA, intent = "local_visual_review", minFrames = 240, maxFrames = 360 } = {}) {
  need(manifest?.schema === schema && manifest.intent === intent
    && manifest.production_eligible === false && manifest.publish_allowed === false, "private visual-review request required");
  need(/^[a-z0-9][a-z0-9_-]{0,59}$/.test(manifest.candidate_id ?? ""), "explicit candidate ID required");
  need(Number.isInteger(manifest.duration_frames) && manifest.duration_frames >= minFrames && manifest.duration_frames <= maxFrames,
    `review duration must be ${minFrames}–${maxFrames} frames at 30 fps`);
  need(HASH.test(manifest.identity_sha256 ?? ""), "current identity hash required");
  need(manifest.recipe && typeof manifest.recipe === "object" && !Array.isArray(manifest.recipe), "local recipe required");
  need(!Object.hasOwn(manifest, "review") && !Object.hasOwn(manifest, "approved"), "a review candidate cannot claim operator acceptance");
  need(!pilotArtifactContainsPrivateData(manifest), "private credentials or signed URLs are forbidden");
  need(Array.isArray(manifest.assets) && manifest.assets.length >= 3 && manifest.assets.length <= 20
    && new Set(manifest.assets.map((row) => row.id)).size === manifest.assets.length, "bounded unique assets required");
  for (const row of manifest.assets) {
    need(/^[a-z0-9][a-z0-9_-]{0,79}$/.test(row.id ?? "")
      && ["narration", "host_pose", "background", "movie_clip", "illustration"].includes(row.kind), "invalid review asset ID or role");
    need(row.provenance && typeof row.provenance === "object" && !Object.hasOwn(row, "review"), "provenance required; new asset approvals forbidden");
  }
  need(manifest.assets.filter((row) => row.kind === "narration").length === 1
    && manifest.assets.some((row) => row.kind === "host_pose") && manifest.assets.some((row) => row.kind === "background"),
  "one accepted narration, host and room required");
  need(manifest.narration && manifest.assets.some((row) => row.id === manifest.narration.asset_id && row.kind === "narration")
    && Number.isFinite(manifest.narration.source_in_sec) && manifest.narration.source_in_sec >= 0
    && Number.isFinite(manifest.narration.source_out_sec) && manifest.narration.source_out_sec > manifest.narration.source_in_sec
    && Number.isFinite(manifest.narration.output_in_sec) && manifest.narration.output_in_sec >= 0
    && manifest.narration.output_in_sec + manifest.narration.source_out_sec - manifest.narration.source_in_sec <= manifest.duration_frames / 30,
  "explicit narration source interval required");
  return manifest;
}
export function validateStylePreviewShape(manifest) { return validateLocalVisualReviewShape(manifest); }

export async function preparePilotStylePreview({ episodeDir, inputPath, report, repoRoot, flags }) {
  return preparePilotVisualReview({ episodeDir, inputPath, report, repoRoot, flags });
}

export async function preparePilotVisualReview({ episodeDir, inputPath, report, repoRoot, flags,
  validateShape = validateStylePreviewShape, outputNamespace = "pilot_visual_reviews", allowMovieCutout = false }) {
  need(report.current_stage === "pilot_media" && report.allowed_command_stages.includes("pilot_media")
    && report.production_eligible === false && report.publish_allowed === false, "current unresolved pilot_media stage required");
  const refs = [], request = await binding(inputPath), manifest = validateShape(await json(request, refs));
  const identity = await binding(path.join(episodeDir, "run_identity.json"));
  await bound(identity, refs);
  need(identity.sha256 === manifest.identity_sha256 && report.identity.media_workflow === "avatar_footage_pilot_v1"
    && report.identity.content_profile === "mcu_what_if_pilot_v1", "current dedicated pilot identity required");
  const stage = async (id) => {
    const found = report.stages.find((row) => row.stage === id);
    need(found?.state === "passed", `accepted ${id} required`);
    return json(await binding(found.artifact), refs);
  };
  const narration = (await stage("pilot_narration")).payload;
  const plan = (await stage("pilot_asset_plan")).payload;
  await stage("pilot_asset_plan_approval");
  const host = await resolvePilotHostIdentityApproval({ episodeDir, identity: report.identity });
  need(host, "accepted masked host identity required");
  const hostAuthority = await json(await binding(path.join(episodeDir, "pilot_host_identity_approval/approval.json")), refs);
  const assets = {};
  let narrationDurationSec;
  for (const row of manifest.assets) {
    await bound(row, refs);
    const planned = plan.assets.find((entry) => entry.id === row.id), provenance = row.provenance;
    if (row.kind === "narration") {
      need(provenance.type === "accepted_narration" && same(row, narration.audio), "only exact accepted narration may be reused");
      const duration = Number(execFileSync("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", row.path],
        { encoding: "utf8", timeout: 30000, env: { PATH: process.env.PATH, LANG: "C" } }).trim());
      need(Number.isFinite(duration) && manifest.narration.source_out_sec <= duration, "narration excerpt exceeds accepted master");
      narrationDurationSec = duration;
    } else if (row.kind === "movie_clip") {
      need(provenance.type === "accepted_movie_clip" && planned?.kind === "movie_clip" && same(row, planned.existing_file), "exact planned movie excerpt required");
      const receiptPath = path.join(path.dirname(row.path), "receipt.json");
      const verified = await validateFootageClipReceipt(receiptPath);
      await bound(await binding(receiptPath), refs);
      const approval = await json(await binding(path.join(path.dirname(row.path), "approval.json")), refs);
      need(verified.receipt.clip_sha256 === row.sha256 && approval.clip_sha256 === row.sha256
        && approval.decision === "approved" && approval.receipt_sha256 === verified.receipt.receipt_sha256,
      "current library excerpt and review required");
    } else if (row.id === "host_neutral") {
      need(row.kind === "host_pose" && provenance.type === "accepted_host_identity" && same(row, hostAuthority.accepted_alpha_output), "exact accepted neutral host required");
    } else if (["host_pose", "background"].includes(row.kind)) {
      need(planned?.kind === row.kind && provenance.type === "accepted_generated" && within(provenance.receipt?.path ?? "", path.join(episodeDir, "pilot_media_work")), "planned host or room receipt required");
      const receipt = await json(provenance.receipt, refs);
      need(receipt.schema === "goldflow_avatar_pilot_provider_receipt_v1" && receipt.status === "passed"
        && receipt.asset_id === row.id && receipt.output_sha256 === row.sha256 && receipt.provider === planned.provider
        && receipt.model === planned.model && receipt.review?.approved === true, "accepted generated output mismatch");
      for (const key of ["provider_evidence", "operator_review", "technical_derivative", "host_identity_authority", "host_design_authority", "replacement_authority"])
        if (receipt[key]) await bound(receipt[key], refs);
      for (const ref of receipt.reference_bindings ?? []) await bound(ref, refs);
      if (row.kind === "host_pose") need(same(receipt.host_identity_authority, await binding(path.join(episodeDir, "pilot_host_identity_approval/approval.json"))), "pose must retain accepted host identity");
    } else if (allowMovieCutout && provenance.type === "source_movie_cutout") {
      const source = plan.assets.find((entry) => entry.id === provenance.source_asset_id);
      need(row.kind === "illustration" && provenance.truth_mode === "illustration_only"
        && source?.kind === "movie_clip" && same(source.existing_file, provenance.source), "cutout must bind an exact planned movie excerpt");
      await bound(provenance.source, refs);
      const derivation = provenance.derivation;
      need(derivation?.method === "ffmpeg_frame_then_macos_vision_foreground_mask_then_sharp_sticker_board"
        && within(derivation.recipe?.path ?? "", path.join(episodeDir, "pilot_media_work")), "existing local cutout recipe required");
      const recipe = await json(derivation.recipe, refs);
      need(recipe.schema === "goldflow_avatar_pilot_local_composite_recipe_v1"
        && recipe.method === derivation.method && recipe.intermediate_hashes?.[derivation.intermediate_key] === row.sha256
        && recipe.source_frame_offsets_sec?.[source.id] === derivation.frame_time_sec,
      "cutout hash and source frame must match its retained recipe");
    } else {
      need(provenance.type === "external_illustration" && provenance.truth_mode === "illustration_only"
        && text(provenance.description) && text(provenance.derivation?.method), "external art needs explicit illustrative role and derivation");
      const url = new URL(provenance.source_url);
      need(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash, "public unsigned source-page URL required");
      await bound(provenance.source, refs);
      need([row.path, provenance.source.path].every((file) => [".png", ".jpg", ".jpeg", ".webp"].includes(path.extname(file).toLowerCase())), "external illustrations must be local native raster images");
    }
    assets[row.id] = { ...row };
  }
  const git = (...args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).trim();
  const dirty = git("status", "--porcelain=v1", "--untracked-files=all");
  need(!dirty || flags["allow-dirty-worktree"] === "true" && text(flags["dirty-reason"]) && flags["dirty-reason"].trim().length >= 12,
    "clean code or explicit proof-only dirty-worktree reason required");
  need(["pilot_visual_reviews", "pilot_program_reviews"].includes(outputNamespace), "unsupported review namespace");
  const outputDir = path.join(episodeDir, outputNamespace, manifest.candidate_id);
  need(!await fs.lstat(outputDir).catch((error) => { if (error.code === "ENOENT") return null; throw error; }), "candidate already exists; preserve it and use a new reviewed revision ID");
  return { manifest, assets, refs, request, identity, outputDir, narrationDurationSec,
    runtime: { commit: git("rev-parse", "HEAD"), dirty: Boolean(dirty), dirty_diff_sha256: hash(`${dirty}\n${git("diff", "HEAD", "--binary")}`),
      dirty_reason: dirty ? flags["dirty-reason"] : null } };
}

export async function producePilotStylePreview(prepared) {
  const { manifest, assets, outputDir, refs } = prepared;
  await fs.mkdir(path.dirname(outputDir), { recursive: true });
  await fs.mkdir(outputDir);
  const write = (name, data) => fs.writeFile(path.join(outputDir, name), `${JSON.stringify(data, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await write("request.json", manifest);
  await write("execution_started.json", { schema: "goldflow_avatar_pilot_style_preview_execution_v1", created_at: new Date().toISOString(),
    identity: prepared.identity, request: prepared.request, inputs: refs, runtime: prepared.runtime,
    duration_frames: manifest.duration_frames, provider_calls: 0, provider_cost: 0, production_eligible: false, publish_allowed: false });
  const { renderStylePreview } = await import("./avatar-pilot-style-preview-renderer.mjs");
  const result = await renderStylePreview({ outputDir, manifest, assets });
  need(within(result.output?.path ?? "", outputDir), "renderer output must remain inside its fresh candidate directory");
  await bound(result.output, []);
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-count_frames", "-show_streams", "-show_format", "-of", "json", result.output.path],
    { encoding: "utf8", timeout: 60000, maxBuffer: 2 * 1024 * 1024, env: { PATH: process.env.PATH, LANG: "C" } }));
  const video = probe.streams.filter((row) => row.codec_type === "video"), audio = probe.streams.filter((row) => row.codec_type === "audio");
  need(video.length === 1 && video[0].width === 1920 && video[0].height === 1080 && video[0].r_frame_rate === "30/1"
    && Number(video[0].nb_read_frames) === manifest.duration_frames && audio.length === 1
    && Math.abs(Number(probe.format.duration) - manifest.duration_frames / 30) <= 0.08,
  "preview must contain exact requested 1080p30 frames and narration audio");
  for (const ref of refs) await bound(ref, []);
  const receipt = { schema: "goldflow_avatar_pilot_style_preview_result_v1", status: "awaiting_visual_review", created_at: new Date().toISOString(),
    identity: prepared.identity, request: prepared.request, inputs: refs, runtime: prepared.runtime,
    output: result.output, duration_frames: manifest.duration_frames, width: 1920, height: 1080, fps: 30,
    provider_calls: 0, provider_cost: 0, creative_submissions: 0, official_stage_completed: false,
    operator_review_recorded: false, production_eligible: false, publish_allowed: false };
  await write("result.json", receipt);
  return { ...receipt, receipt: await binding(path.join(outputDir, "result.json")) };
}
