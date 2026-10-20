import { promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { autopilotEnabled, automatedReviewer, isAutomatedReviewer } from "./autopilot-policy.mjs";
import { fileSha256 } from "./episode-budget.mjs";
import {
  YOUTUBE_API_UNVERIFIABLE_FIELDS, YOUTUBE_PINNED_COMMENT_RECEIPT_SCHEMA, YOUTUBE_PIN_FOLLOWUP_METHOD, YOUTUBE_PUBLISH_MANIFEST_SCHEMA,
  YOUTUBE_SCHEDULE_RECEIPT_SCHEMA, YOUTUBE_UPLOAD_RECEIPT_SCHEMA, listYoutubeScheduleReceipts, validateYoutubeApiCompliance,
  validateYoutubePinnedCommentReceipt, validateYoutubeScheduleReceipt, validateYoutubeUploadReceipt, youtubeApiComplianceRefusal, youtubeTextSha256,
} from "./youtube-publish-contract.mjs";

export const FINAL_WATCH_SCHEMA = "goldflow_final_watch_v1";
export const YOUTUBE_PUBLISH_RECEIPT_SCHEMA = "goldflow_youtube_publish_receipt_v1";
export const PIN_FOLLOWUP_METHOD = YOUTUBE_PIN_FOLLOWUP_METHOD;
export const PUBLISH_PATH_DATA_API = "data_api_publish";
export const PUBLISH_PATH_PRIVATE_REVIEW_ONLY = "private_review_only";
const UPLOAD_METHOD = "youtube_data_api";

/** The compliance record bound into receipts: status, verification and the config hash. */
function complianceRecord(compliance) {
  need(compliance && validateYoutubeApiCompliance(compliance).status === "passed", "A valid config/youtube_api_compliance.json record is required (loadYoutubeApiCompliance).");
  return { audited: compliance.audited, verified_at: compliance.verified_at ?? null, verified_by: compliance.verified_by ?? null, config_path: compliance.config_path ?? null, config_sha256: compliance.config_sha256 ?? null };
}

function need(value, message) {
  if (!value) throw new Error(message);
}
function clean(value) {
  return String(value ?? "").trim();
}
async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function writeExclusive(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}
const paths = (episodeDir, episode) => ({
  manifest: path.join(episodeDir, `youtube_publish_manifest_${episode}.json`),
  upload: path.join(episodeDir, `youtube_upload_receipt_${episode}.json`),
  comment: path.join(episodeDir, `youtube_pinned_comment_receipt_${episode}.json`),
  publish: path.join(episodeDir, `youtube_publish_receipt_${episode}.json`),
  finalQa: path.join(episodeDir, `final_qa_${episode}.json`),
  finalWatch: path.join(episodeDir, `final_watch_${episode}.json`),
});

async function passedManifest(p) {
  const manifest = await readJson(p.manifest);
  need(manifest?.schema === YOUTUBE_PUBLISH_MANIFEST_SCHEMA && manifest.status === "passed", `Passed YouTube publish manifest required: ${p.manifest}`);
  return manifest;
}

/**
 * Builds the upload receipt from the Data API result. Every field the API can
 * read back is compared with the manifest; Studio-only settings are deferred to
 * the publish approval, never claimed as verified.
 */
export function automatedUploadReceipt({ manifest, manifestPath, manifestSha256, api, episode, now }) {
  const settings = manifest.publish_settings ?? {};
  const verification = {
    active_channel: api.status === "uploaded_private" && Boolean(api.channel?.id),
    initial_private: api.privacy_status === "private",
    title: clean(api.title) === clean(manifest.title),
    description: clean(api.description) === clean(manifest.description),
    thumbnail: api.thumbnail_uploaded === true,
    audience: typeof settings.made_for_kids === "boolean" && api.self_declared_made_for_kids === settings.made_for_kids,
  };
  verification.checks_complete = Object.values(verification).every(Boolean);
  const deferred = YOUTUBE_API_UNVERIFIABLE_FIELDS.filter((field) => field !== "mid_rolls" || clean(settings.mid_roll_mode) === "manual");
  return {
    schema: YOUTUBE_UPLOAD_RECEIPT_SCHEMA,
    status: "passed",
    episode,
    manifest_path: manifestPath,
    manifest_sha256: manifestSha256,
    video_id: clean(api.video_id),
    watch_url: clean(api.watch_url),
    studio_url: clean(api.studio_url) || null,
    initial_visibility: "private",
    visibility: "private",
    schedule_at: null,
    verification_method: "youtube_data_api_v3",
    field_verification: verification,
    deferred_field_verification: deferred,
    api_result: { channel: api.channel ?? null, privacy_status: api.privacy_status ?? null, processing_status: api.processing_status ?? null },
    publish_approval: { required: false, approved: false, approved_by: null, approved_at: null },
    channel_experiment: manifest.channel_experiment ? {
      experiment_id: manifest.channel_experiment.experiment_id,
      config_sha256: manifest.channel_experiment.config_sha256,
      ordinal: manifest.channel_experiment.ordinal,
      eligible_upload_count: manifest.channel_experiment.eligible_upload_count,
      runtime_exception: manifest.channel_experiment.runtime_exception ?? null,
    } : null,
    recorded_by: automatedReviewer(UPLOAD_METHOD),
    recorded_at: now,
    note: "Automatic private upload; Studio-only settings are confirmed at publish approval.",
  };
}

/** Default uploader: the existing private-only Data API script. */
export function defaultYoutubeUploader({ manifestPath, repoRoot, python = process.env.GOLDFLOW_YOUTUBE_PYTHON || "/Users/joel/youtube-niche-research/manhwa-webtoon-recap/.venv/bin/python" }) {
  const run = spawnSync(python, [path.join(repoRoot, "scripts", "youtube-data-api-upload.py"), "--manifest", manifestPath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  need(run.status === 0, `YouTube private upload failed: ${clean(run.stderr || run.stdout).split("\n").at(-1)}`);
  const lines = run.stdout.trim();
  return JSON.parse(lines.slice(lines.lastIndexOf("\n{") + 1));
}

/**
 * Unsupported-publish-path gate (R11): an unaudited OAuth project uploads
 * locked-private, which would force a Studio re-upload after the hash-bound
 * final watch. Without a passed audit the upload stops here unless the run is
 * explicitly declared private-review-only; the decision is bound into the receipt.
 */
export function publishPathFor({ compliance, privateReviewOnly = false }) {
  const record = complianceRecord(compliance);
  if (record.audited === true) return { publish_path: PUBLISH_PATH_DATA_API, api_compliance: record };
  need(privateReviewOnly === true, `${youtubeApiComplianceRefusal(compliance, "publish this upload later")} Unsupported publish path: stop before any upload, or declare the run private-review-only with --private-review-only true (the final watch still happens; the release is then a Studio action).`);
  return { publish_path: PUBLISH_PATH_PRIVATE_REVIEW_ONLY, api_compliance: record };
}

export async function autoPrivateUpload({ episodeDir, episode, uploader, compliance, privateReviewOnly = false, now = new Date().toISOString() }) {
  const p = paths(episodeDir, episode);
  const manifest = await passedManifest(p);
  need(manifest.publish_settings?.initial_visibility === "private", "Automatic upload requires initial_visibility=private.");
  const existing = await readJson(p.upload);
  need(!existing, `Upload receipt already exists; never upload twice: ${p.upload}`);
  const publishPath = publishPathFor({ compliance, privateReviewOnly });
  const manifestSha256 = await fileSha256(p.manifest);
  const api = await uploader({ manifestPath: p.manifest });
  need(api?.status === "uploaded_private" && clean(api.video_id), "Uploader did not report a private upload.");
  const receipt = { ...automatedUploadReceipt({ manifest, manifestPath: p.manifest, manifestSha256, api, episode, now }), ...publishPath };
  const validation = validateYoutubeUploadReceipt(receipt, { manifest, manifestHash: manifestSha256 });
  receipt.blockers = validation.blockers;
  if (validation.status !== "passed") receipt.status = "blocked";
  // The video exists on YouTube either way; the receipt records what was verified.
  await writeExclusive(p.upload, receipt);
  return { status: receipt.status, receipt_path: p.upload, video_id: receipt.video_id, blockers: receipt.blockers };
}

async function finalVideo(p) {
  const finalQa = await readJson(p.finalQa);
  need(finalQa?.status === "passed" && finalQa.final_video_path && finalQa.final_video_sha256, "Final watch requires passed final QA with a final video.");
  return { path: finalQa.final_video_path, sha256: finalQa.final_video_sha256 };
}

export async function recordFinalWatch({ episodeDir, episode, decision, reviewer, note, now = new Date().toISOString() }) {
  need(["accept", "reject"].includes(decision), "--decision must be accept or reject.");
  need(clean(reviewer) && !isAutomatedReviewer(reviewer), "Final watch is a human step: --reviewer must name the person who watched.");
  need(clean(note).length >= 10, "--note must describe what was watched (at least 10 characters).");
  const p = paths(episodeDir, episode);
  const video = await finalVideo(p);
  need(await fileSha256(video.path) === video.sha256, `Final video changed after final QA: ${video.path}`);
  const upload = await readJson(p.upload);
  const record = {
    schema: FINAL_WATCH_SCHEMA, status: decision === "accept" ? "accepted" : "rejected", episode,
    video_path: video.path, video_sha256: video.sha256,
    upload_receipt_sha256: await fileSha256(p.upload), watch_url: upload?.watch_url ?? null,
    reviewer: clean(reviewer), note: clean(note), recorded_at: now,
  };
  // A rejection is kept; a later decision for a new master supersedes it by video hash.
  const prior = await readJson(p.finalWatch);
  if (prior) {
    need(prior.video_sha256 !== video.sha256 || prior.status === "rejected", "This master already has an accepted final watch.");
    await fs.rename(p.finalWatch, path.join(episodeDir, `final_watch_${episode}.superseded_${Date.parse(prior.recorded_at) || Date.now()}.json`));
  }
  await writeExclusive(p.finalWatch, record);
  return { status: record.status, path: p.finalWatch };
}

export async function finalWatchStatus({ episodeDir, episode, identity }) {
  if (!autopilotEnabled(identity)) return { state: "skipped_with_waiver", evidence: "manual runs review before upload; final watch applies to autopilot identities" };
  const p = paths(episodeDir, episode);
  let video;
  try { video = await finalVideo(p); } catch (error) { return { done: false, state: "missing", evidence: error.message }; }
  const upload = await readJson(p.upload);
  const record = await readJson(p.finalWatch);
  // The upload starts right after final QA and packaging, so YouTube processing overlaps the watch; the local MP4 is watchable at once.
  const processing = upload?.api_result?.processing_status ? ` YouTube processing: ${upload.api_result.processing_status}; the local MP4 needs no wait.` : "";
  const command = `Watch ${video.path}${upload?.watch_url ? ` (private: ${upload.watch_url})` : ""}, then run node bin/goldflow.mjs run final-watch --episode-dir ${episodeDir} --decision accept --reviewer <name> --note "<watch notes>"${processing}`;
  if (!record) return { done: false, state: "missing", evidence: `final watch pending for ${video.path}`, final_watch_video_path: video.path, next_command_shape: command };
  if (record.schema !== FINAL_WATCH_SCHEMA || record.video_sha256 !== video.sha256 || isAutomatedReviewer(record.reviewer)) {
    return { done: false, state: "stale", evidence: "final watch does not bind the current master", final_watch_video_path: video.path, next_command_shape: command };
  }
  if (record.status !== "accepted") {
    return { done: false, state: "blocked", evidence: `final watch rejected by ${record.reviewer}: ${record.note}`, final_watch_video_path: video.path,
      next_command_shape: `Triage the final-watch rejection in ${p.finalWatch}; repair only the named scope, re-render, then watch again.` };
  }
  return { done: true, evidence: `final watch accepted by ${record.reviewer} for ${path.basename(video.path)}` };
}

/** Default publisher: the Data API publish script (visibility + comment post). */
export function defaultYoutubePublisher({ repoRoot, python = process.env.GOLDFLOW_YOUTUBE_PYTHON || "/Users/joel/youtube-niche-research/manhwa-webtoon-recap/.venv/bin/python" }) {
  return async ({ videoId, visibility, publishAt, commentText }) => {
    const args = [path.join(repoRoot, "scripts", "youtube-data-api-publish.py"), "--video-id", videoId, "--visibility", visibility, "--comment-text", commentText];
    if (publishAt) args.push("--publish-at", publishAt);
    const run = spawnSync(python, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    need(run.status === 0, `YouTube publish failed: ${clean(run.stderr || run.stdout).split("\n").at(-1)}`);
    return JSON.parse(run.stdout.trim().split("\n").at(-1));
  };
}

export async function publishApproval({ episodeDir, episode, visibility, scheduleAt = null, timeZone = null, approvedBy, studioSettingsVerified, publisher, compliance, channelDefaults = null, now = new Date().toISOString() }) {
  need(["public", "scheduled"].includes(visibility), "--visibility must be public or scheduled.");
  need(clean(approvedBy) && !isAutomatedReviewer(approvedBy), "Publish approval is a human step: --approved-by must name a person.");
  // Q54: without a passed compliance audit the Data API never flips visibility; Studio keeps that step.
  const apiCompliance = complianceRecord(compliance);
  need(apiCompliance.audited === true, youtubeApiComplianceRefusal(compliance));
  const p = paths(episodeDir, episode);
  const manifest = await passedManifest(p);
  const upload = await readJson(p.upload);
  const uploadSha256 = await fileSha256(p.upload);
  need(upload && validateYoutubeUploadReceipt(upload, { manifest, manifestHash: await fileSha256(p.manifest) }).status === "passed" && upload.visibility === "private",
    "A passed private upload receipt is required before publishing.");
  need(upload.publish_path !== PUBLISH_PATH_PRIVATE_REVIEW_ONLY, "This upload was declared private-review-only at upload time; its release is a Studio action (record-schedule / record-comment), not youtube publish.");
  const deferred = upload.deferred_field_verification ?? [];
  // Channel defaults only pre-fill what the approver confirms; the flag is the per-publish human attestation.
  const prefilled = channelDefaults ? Object.fromEntries(deferred.map((field) => [field, channelDefaults.values?.[field === "mid_rolls" ? "mid_roll_mode" : field] ?? null])) : null;
  if (deferred.length) {
    const expected = prefilled ? ` Expected per ${channelDefaults.path}: ${deferred.map((field) => `${field}=${prefilled[field] ?? "unset"}`).join(", ")}.` : "";
    need(studioSettingsVerified === true, `Confirm the Studio-only settings (${deferred.join(", ")}) in YouTube Studio for this video and pass --studio-settings-verified true.${expected} Channel defaults never satisfy this flag.`);
  }
  const watch = await readJson(p.finalWatch);
  need(watch?.status === "accepted" && watch.video_sha256 === (await readJson(p.finalQa))?.final_video_sha256, "An accepted final watch of the current master is required.");
  need(!(await readJson(p.publish)) && !(await readJson(p.comment)), "This episode already has a publish or comment receipt.");
  if (visibility === "scheduled") {
    need(clean(timeZone), "--time-zone is required for a scheduled release.");
    need(Number.isFinite(Date.parse(scheduleAt)) && new Date(Date.parse(scheduleAt)).toISOString() === scheduleAt && Date.parse(scheduleAt) > Date.parse(now),
      "--schedule-at must be a future ISO-8601 UTC timestamp (e.g. 2026-10-21T15:00:00.000Z).");
  }
  const commentText = clean(manifest.pinned_comment?.text);
  need(commentText, "Manifest pinned comment text is missing.");
  const api = await publisher({ videoId: upload.video_id, visibility, publishAt: visibility === "scheduled" ? scheduleAt : null, commentText });
  need(api?.video_id === upload.video_id, "Publisher reported a different video id.");
  const expectedPrivacy = visibility === "scheduled" ? "private" : "public";
  const recordedBy = automatedReviewer("youtube_data_api");
  const publishReceipt = {
    schema: YOUTUBE_PUBLISH_RECEIPT_SCHEMA, status: api.privacy_status === expectedPrivacy ? "passed" : "blocked", episode,
    upload_receipt_path: p.upload, upload_receipt_sha256: uploadSha256, video_id: upload.video_id,
    visibility, schedule_at: visibility === "scheduled" ? scheduleAt : null, time_zone: timeZone,
    api_privacy_status: api.privacy_status ?? null, api_publish_at: api.publish_at ?? null,
    publish_approval: { approved: true, approved_by: clean(approvedBy), approved_at: now },
    studio_settings: { deferred_fields: deferred, verified_by_publisher: studioSettingsVerified === true, verification_basis: "confirmed_by_approver",
      prefilled_from_defaults: channelDefaults ? { path: channelDefaults.path, sha256: channelDefaults.sha256, values: prefilled } : null },
    api_compliance: apiCompliance,
    final_watch_sha256: await fileSha256(p.finalWatch), recorded_by: recordedBy, recorded_at: now,
  };
  await writeExclusive(p.publish, publishReceipt);
  if (visibility === "scheduled") {
    const sequence = (await listYoutubeScheduleReceipts(episodeDir, episode)).length + 1;
    need(sequence === 1, "Schedule revisions use youtube record-schedule.");
    const scheduleReceipt = {
      schema: YOUTUBE_SCHEDULE_RECEIPT_SCHEMA, status: "passed", episode, manifest_path: p.manifest, manifest_sha256: upload.manifest_sha256,
      upload_receipt_path: p.upload, upload_receipt_sha256: uploadSha256, sequence, supersedes_receipt_sha256: null,
      video_id: upload.video_id, visibility: "scheduled", schedule_at: scheduleAt, time_zone: timeZone,
      publish_approval: { approved: true, approved_by: clean(approvedBy) },
      field_verification: { active_channel: true, schedule: clean(api.publish_at) !== "" && Date.parse(api.publish_at) === Date.parse(scheduleAt), existing_fields: true, checks_complete: true },
      recorded_by: recordedBy, recorded_at: now, note: "Scheduled through the Data API by the publish approval.",
    };
    scheduleReceipt.field_verification.checks_complete = scheduleReceipt.field_verification.schedule;
    await writeExclusive(path.join(episodeDir, `youtube_scheduled_release_receipt_${episode}.json`), scheduleReceipt);
  }
  const commentReceipt = {
    schema: YOUTUBE_PINNED_COMMENT_RECEIPT_SCHEMA, status: clean(api.comment_id) ? "passed" : "blocked", episode,
    upload_receipt_path: p.upload, upload_receipt_sha256: uploadSha256, video_id: upload.video_id,
    comment_id: clean(api.comment_id) || null, comment_url: clean(api.comment_url) || null,
    comment_text_sha256: clean(api.comment_text) === commentText ? youtubeTextSha256(commentText) : null,
    post_approval: { approved: true, approved_by: clean(approvedBy), approved_at: now },
    // The Data API has no pin endpoint; pinning is a Studio follow-up, recorded honestly.
    pinned: false, pin_method: PIN_FOLLOWUP_METHOD,
    recorded_by: recordedBy, recorded_at: now, note: "Posted through the Data API; pin it in Studio, then record-comment --pinned-verified true.",
  };
  await writeExclusive(p.comment, commentReceipt);
  return { status: publishReceipt.status === "passed" && commentReceipt.status === "passed" ? "published" : "blocked",
    publish_receipt_path: p.publish, comment_receipt_path: p.comment, pin_followup: true };
}

/** youtube_pinned_comment stage for autopilot identities: the publish approval. */
export async function autopilotPublishStatus({ episodeDir, episode }) {
  const p = paths(episodeDir, episode);
  const [manifest, upload, uploadReceiptHash, receipt, publish] = await Promise.all([
    readJson(p.manifest), readJson(p.upload), fileSha256(p.upload), readJson(p.comment), readJson(p.publish),
  ]);
  const shape = `node bin/goldflow.mjs youtube publish --episode-dir ${episodeDir} --visibility <public|scheduled> --approved-by <name> --studio-settings-verified true`;
  if (!publish || !receipt) return { done: false, state: "missing", evidence: "publish approval pending (human step 2)", next_command_shape: shape };
  if (publish.schema !== YOUTUBE_PUBLISH_RECEIPT_SCHEMA || publish.status !== "passed" || publish.upload_receipt_sha256 !== uploadReceiptHash) {
    return { done: false, state: "blocked", evidence: `publish receipt not passed or stale: ${p.publish}` };
  }
  if (publish.visibility === "scheduled") {
    const schedulePath = path.join(episodeDir, `youtube_scheduled_release_receipt_${episode}.json`);
    const schedule = await readJson(schedulePath);
    const validation = validateYoutubeScheduleReceipt(schedule, { manifest, uploadReceipt: upload, uploadReceiptSha256: uploadReceiptHash });
    if (validation.status !== "passed") return { done: false, state: "blocked", evidence: validation.blockers.join(", ") };
  }
  // The contract itself accepts pinned:false + pin_method on autopilot identities (R11).
  const validation = validateYoutubePinnedCommentReceipt(receipt, { manifest, uploadReceipt: upload, uploadReceiptHash, pinFollowupAllowed: true });
  if (validation.blockers.length) return { done: false, state: "blocked", evidence: validation.blockers.join(", ") };
  return { done: true, evidence: `published ${publish.visibility} by ${publish.publish_approval.approved_by}; comment posted${validation.pin_followup ? " — pin it in Studio (no Data API pin endpoint)" : " and pinned"}` };
}
