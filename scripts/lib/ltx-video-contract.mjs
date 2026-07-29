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

export const ANIMATION_SHOT_CLASSES = Object.freeze([
  "portrait_reaction",
  "dialogue_pair",
  "physical_contact",
  "locomotion_action",
  "object_insert",
  "ui_or_screen",
  "environment_establishing",
  "effect_or_impact",
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
  return normalizeLtxVideoPolicy(identity?.animation_policy ?? identity?.ltx_video_policy ?? "disabled") !== "disabled";
}

export function animationPolicyForIdentity(identity = {}) {
  return normalizeLtxVideoPolicy(identity?.animation_policy ?? identity?.ltx_video_policy ?? "disabled");
}

function firstNonEmpty(...values) {
  return values.map((value) => String(value ?? "").trim()).find(Boolean) ?? "";
}

function compactInstruction(value, maxLength) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  const clipped = normalized.slice(0, maxLength + 1);
  return `${clipped.slice(0, Math.max(0, clipped.lastIndexOf(" "))).replace(/[,:;\s]+$/g, "")}.`;
}

export function sanitizeAnimationIntent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const shotClass = String(value.shot_class ?? "").trim();
  const eligibility = String(value.eligibility ?? "").trim();
  if (!ANIMATION_SHOT_CLASSES.includes(shotClass) || !["animate", "still_preferred"].includes(eligibility)) return null;
  const strings = (field) => Array.isArray(value[field])
    ? value[field].map((row) => String(row ?? "").trim()).filter(Boolean)
    : [];
  return {
    eligibility,
    shot_class: shotClass,
    start_state: firstNonEmpty(value.start_state),
    subject_motion: firstNonEmpty(value.subject_motion),
    camera_motion: firstNonEmpty(value.camera_motion),
    environmental_motion: firstNonEmpty(value.environmental_motion),
    end_state: firstNonEmpty(value.end_state),
    timing_priority: ["early_action", "even_action", "settle_hold"].includes(String(value.timing_priority))
      ? String(value.timing_priority)
      : "settle_hold",
    animation_ready_composition: firstNonEmpty(value.animation_ready_composition),
    continuity_bridge: firstNonEmpty(value.continuity_bridge),
    locked_elements: strings("locked_elements"),
  };
}

export function clampLtxDuration(value, fallback = 5) {
  const parsed = Number(value);
  const selected = Number.isFinite(parsed) ? parsed : Number(fallback);
  return Math.max(5, Math.min(12, Math.round(selected)));
}

export function ltxMotionPromptForCut(prompt = {}) {
  const explicit = firstNonEmpty(
    prompt.ltx_video_prompt,
    prompt.shot_manifest?.ltx_video_prompt,
    prompt.shot_manifest?.animation_intent?.video_prompt,
    prompt.shot_manifest?.motion_intent?.video_prompt,
  );
  if (explicit) return explicit;
  const intent = prompt.shot_manifest?.motion_intent ?? {};
  const authoredPrompt = firstNonEmpty(
    prompt.provider_prompt,
    prompt.modelslab_image_prompt,
    prompt.image_prompt,
    prompt.codex_image_prompt,
    prompt.prompt,
  );
  const animation = sanitizeAnimationIntent(
    prompt.shot_manifest?.animation_intent ?? prompt.animation_intent,
  );
  const cutDuration = Math.max(0.1, Number(prompt.duration_sec ?? 5));
  const actionEnd = Math.min(4.5, Math.max(1.2, cutDuration - 0.25));
  const motionParts = [
    intent.behavior ? `Motion behavior: ${intent.behavior}.` : "",
    intent.focal_subject ? `Focus: ${compactInstruction(intent.focal_subject, 80)}` : "",
  ].filter(Boolean).join(" ");
  const directedParts = animation ? [
    animation.subject_motion ? `One action from 0.0 to ${actionEnd.toFixed(1)} seconds: ${compactInstruction(animation.subject_motion, 140)}` : "",
    animation.camera_motion ? `Camera: ${compactInstruction(animation.camera_motion, 80)}` : "",
    animation.environmental_motion ? `Secondary: ${compactInstruction(animation.environmental_motion, 40)}` : "",
    "Then settle into a readable hold.",
  ].filter(Boolean).join(" ")
    : "";
  return [
    animation
      ? "Preserve the exact accepted anime/manhwa frame, identities, wardrobe, anatomy, objects, environment, and composition."
      : "Use the accepted image as the exact first frame. Preserve its character identities, wardrobe, anatomy, objects, environment, lighting, and spatial layout.",
    animation ? "" : authoredPrompt,
    directedParts,
    motionParts,
    animation
      ? "Use one continuous stable camera move. No new people, duplicate subjects, objects, panels, cuts, or scene changes. Existing UI may move; exact text legibility is not required."
      : "Use one coherent action and one continuous stable camera move. No new people, duplicate subjects, unrelated objects, panels, cuts, or scene changes. Existing UI may animate naturally; exact text legibility is not required.",
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
      candidate_count: Number(clip.candidate_count ?? 1),
    })),
  }));
}

export async function ltxApprovalMatches(report, approval, { reportPath = null } = {}) {
  if (report?.schema !== "goldflow_ltx23_video_report_v1" || report?.status !== "passed") return false;
  if (approval?.schema !== "goldflow_ltx23_video_approval_v1" || approval?.status !== "passed") return false;
  const reportHash = reportPath ? await hashFile(reportPath) : null;
  if (reportHash && approval.report_sha256 !== reportHash) return false;
  const decisions = new Map((approval.decisions ?? []).map((row) => [String(row.candidate_id ?? row.image_id ?? ""), row]));
  for (const clip of report.clips ?? []) {
    const decision = decisions.get(String(clip.candidate_id ?? clip.image_id ?? ""));
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
    .map((row) => String(row.candidate_id ?? row.image_id ?? "")));
  const rows = new Map();
  for (const clip of report.clips ?? []) {
    if (!accepted.has(String(clip.candidate_id ?? clip.image_id ?? ""))) continue;
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
