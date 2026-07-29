import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const LTX_VIDEO_MODEL_ID = "ltx-2.3";
export const LTX_VIDEO_PROVIDER = "modelslab";
export const LTX_VIDEO_POLICIES = Object.freeze([
  "disabled",
  "selective_ltx23",
  "full_ltx23",
]);

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function hashFile(filePath) {
  return fs.readFile(filePath).then((buffer) => sha256(buffer)).catch(() => null);
}

export function normalizeLtxVideoPolicy(value = "disabled") {
  const normalized = String(value ?? "disabled").trim().toLowerCase().replaceAll("-", "_");
  if (!LTX_VIDEO_POLICIES.includes(normalized)) {
    throw new Error(`Unsupported LTX video policy ${value}. Use ${LTX_VIDEO_POLICIES.join(", ")}.`);
  }
  return normalized;
}

export function ltxVideoEnabled(identity = {}) {
  return normalizeLtxVideoPolicy(identity.ltx_video_policy ?? "disabled") !== "disabled";
}

export function clampLtxDuration(value, fallback = 5) {
  const parsed = Number(value);
  const selected = Number.isFinite(parsed) ? parsed : Number(fallback);
  return Math.max(5, Math.min(12, Math.round(selected)));
}

export function ltxMotionPromptForCut(prompt = {}) {
  const explicit = String(
    prompt.ltx_video_prompt
    ?? prompt.shot_manifest?.ltx_video_prompt
    ?? prompt.shot_manifest?.motion_intent?.video_prompt
    ?? "",
  ).trim();
  if (explicit) return explicit;
  const intent = prompt.shot_manifest?.motion_intent ?? {};
  const authoredPrompt = String(
    prompt.modelslab_image_prompt
    ?? prompt.image_prompt
    ?? prompt.prompt
    ?? "",
  ).trim();
  const motionParts = [
    intent.behavior ? `Motion behavior: ${intent.behavior}.` : "",
    intent.focal_subject ? `Keep focus on ${intent.focal_subject}.` : "",
    intent.editorial_reason ? `Editorial purpose: ${intent.editorial_reason}.` : "",
  ].filter(Boolean).join(" ");
  return [
    "Preserve the exact accepted anime/manhwa frame, character identities, wardrobe, objects, environment, and composition.",
    authoredPrompt,
    motionParts,
    "Use restrained natural subject motion and one continuous stable camera move. No new people, objects, text, panels, or scene changes.",
  ].filter(Boolean).join(" ");
}

export function ltxNegativePrompt() {
  return [
    "photorealistic",
    "identity drift",
    "face distortion",
    "duplicate person",
    "extra limbs",
    "warped hands",
    "missing object",
    "new object",
    "text mutation",
    "subtitles",
    "speech bubbles",
    "flicker",
    "jitter",
    "fast camera",
    "scene cut",
  ].join(", ");
}

export function ltxPlanHash(plan = {}) {
  return sha256(JSON.stringify({
    schema: plan.schema,
    model_id: plan.model_id,
    provider: plan.provider,
    resolution: plan.resolution,
    clips: (plan.clips ?? []).map((clip) => ({
      image_id: clip.image_id,
      source_image_sha256: clip.source_image_sha256,
      source_prompt_sha256: clip.source_prompt_sha256,
      motion_prompt_sha256: clip.motion_prompt_sha256,
      duration_sec: clip.duration_sec,
    })),
  }));
}

export async function ltxApprovalMatches(report, approval, { reportPath = null } = {}) {
  if (report?.schema !== "goldflow_ltx23_video_report_v1" || report?.status !== "passed") return false;
  if (approval?.schema !== "goldflow_ltx23_video_approval_v1" || approval?.status !== "passed") return false;
  const reportHash = reportPath ? await hashFile(reportPath) : null;
  if (reportHash && approval.report_sha256 !== reportHash) return false;
  const decisions = new Map((approval.decisions ?? []).map((row) => [String(row.image_id ?? ""), row]));
  for (const clip of report.clips ?? []) {
    const decision = decisions.get(String(clip.image_id ?? ""));
    if (!decision || !["accepted", "rejected"].includes(String(decision.decision ?? ""))) return false;
    if (decision.source_image_sha256 !== clip.source_image_sha256) return false;
    if (decision.video_sha256 !== clip.normalized_video_sha256) return false;
  }
  return true;
}

export async function approvedLtxClips(report, approval, { reportPath = null } = {}) {
  if (!await ltxApprovalMatches(report, approval, { reportPath })) return new Map();
  const accepted = new Set((approval.decisions ?? [])
    .filter((row) => row.decision === "accepted")
    .map((row) => String(row.image_id ?? "")));
  const rows = new Map();
  for (const clip of report.clips ?? []) {
    if (!accepted.has(String(clip.image_id ?? ""))) continue;
    if (await hashFile(clip.normalized_video_path) !== clip.normalized_video_sha256) continue;
    rows.set(String(clip.image_id), clip);
  }
  return rows;
}

export function ltxTreatmentForClip(clip) {
  return {
    mode: "generated_video_ltx23",
    provider: LTX_VIDEO_PROVIDER,
    model_id: LTX_VIDEO_MODEL_ID,
    source_image_sha256: clip.source_image_sha256,
    video_path: path.resolve(clip.normalized_video_path),
    video_sha256: clip.normalized_video_sha256,
    native_duration_sec: Number(clip.normalized_probe?.duration_sec ?? clip.requested_duration_sec),
    native_width: Number(clip.normalized_probe?.width ?? 1920),
    native_height: Number(clip.normalized_probe?.height ?? 1080),
    native_fps: Number(clip.normalized_probe?.fps ?? 24),
    audio_removed: clip.normalized_probe?.has_audio === false,
    request_id: clip.request_id ?? null,
    motion_prompt_sha256: clip.motion_prompt_sha256,
  };
}
