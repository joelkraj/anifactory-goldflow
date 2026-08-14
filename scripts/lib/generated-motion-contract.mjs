import path from "node:path";

import {
  approvedLtxCoverageByImage,
  clampLtxDuration,
  hashFile,
  ltxApprovalMatches,
  ltxMotionPromptForSequence,
  ltxNegativePrompt,
  ltxTreatmentForClip,
} from "./ltx-video-contract.mjs";

export const GENERATED_MOTION_PLAN_SCHEMA = "goldflow_generated_motion_plan_v1";
export const GENERATED_MOTION_REPORT_SCHEMA = "goldflow_generated_motion_report_v1";
export const GENERATED_MOTION_APPROVAL_SCHEMA = "goldflow_generated_motion_approval_v1";
export const GENERATED_MOTION_PROVIDER_FLOW = "google_flow";
export const GENERATED_MOTION_PROVIDER_LTX = "modelslab_ltx23";
export const DEFAULT_GENERATED_MOTION_MODEL = "Veo 3.1 Fast";
export const DEFAULT_GENERATED_MOTION_POLICY = "selective_generated_video";

export function generatedMotionArtifactPaths(episodeDir, episode) {
  const motionDir = path.join(episodeDir, "assets", "motion", "generated");
  return {
    motionDir,
    planPath: path.join(motionDir, `generated_motion_plan_${episode}.json`),
    reportPath: path.join(motionDir, `generated_motion_report_${episode}.json`),
    approvalPath: path.join(motionDir, `generated_motion_approval_${episode}.json`),
  };
}

const policyAliases = new Map([
  ["disabled", "disabled"],
  ["selective_generated_video", "selective_generated_video"],
  ["selective_generated_motion", "selective_generated_video"],
  ["selective_ltx23", "selective_generated_video"],
  ["full_generated_video", "full_generated_video"],
  ["full_generated_motion", "full_generated_video"],
  ["full_ltx23", "full_generated_video"],
]);

export function normalizeGeneratedMotionPolicy(value = "disabled") {
  const normalized = String(value ?? "disabled").trim().toLowerCase().replaceAll("-", "_");
  const selected = policyAliases.get(normalized);
  if (!selected) throw new Error(`Unsupported generated-motion policy ${value}.`);
  return selected;
}

export function normalizeGeneratedMotionProvider(value = GENERATED_MOTION_PROVIDER_FLOW) {
  const normalized = String(value ?? GENERATED_MOTION_PROVIDER_FLOW).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  if (["google_flow", "flow", "veo", "google_flow_video"].includes(normalized)) return GENERATED_MOTION_PROVIDER_FLOW;
  if (["modelslab", "modelslab_ltx23", "ltx", "ltx23", "ltx_2_3"].includes(normalized)) return GENERATED_MOTION_PROVIDER_LTX;
  throw new Error(`Unsupported generated-motion provider ${value}.`);
}

export function generatedMotionProviderImageInputs(provider = GENERATED_MOTION_PROVIDER_FLOW) {
  return normalizeGeneratedMotionProvider(provider) === GENERATED_MOTION_PROVIDER_LTX
    ? ["init_image"]
    : ["first_frame"];
}

export function generatedMotionPolicyForIdentity(identity = {}) {
  return normalizeGeneratedMotionPolicy(
    identity.generated_motion_policy
      ?? identity.animation_policy
      ?? identity.ltx_video_policy
      ?? "disabled",
  );
}

export function generatedMotionEnabled(identity = {}) {
  return generatedMotionPolicyForIdentity(identity) !== "disabled";
}

export function generatedMotionRequiredThroughSec(identity = {}) {
  const value = identity.provider_locks?.generated_motion_required_through_sec
    ?? identity.generated_motion_required_through_sec
    ?? 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function generatedMotionProviderForIdentity(identity = {}) {
  const explicit = identity.provider_locks?.generated_motion_provider
    ?? identity.generated_motion_provider
    ?? null;
  if (explicit) return normalizeGeneratedMotionProvider(explicit);
  const legacyPolicy = String(identity.ltx_video_policy ?? identity.animation_policy ?? "").toLowerCase();
  if (identity.ltx_video_provider || legacyPolicy.includes("ltx")) return GENERATED_MOTION_PROVIDER_LTX;
  return GENERATED_MOTION_PROVIDER_FLOW;
}

export function generatedMotionIdentityContract(identity = {}) {
  const enabled = generatedMotionEnabled(identity);
  const provider = enabled ? generatedMotionProviderForIdentity(identity) : null;
  const model = enabled
    ? identity.provider_locks?.generated_motion_model
      ?? identity.generated_motion_model
      ?? (provider === GENERATED_MOTION_PROVIDER_FLOW ? DEFAULT_GENERATED_MOTION_MODEL : "ltx-2.3")
    : null;
  return {
    schema: "goldflow_generated_motion_identity_v1",
    policy: generatedMotionPolicyForIdentity(identity),
    provider,
    model,
    required_through_sec: enabled ? generatedMotionRequiredThroughSec(identity) : 0,
    candidates_per_motion_moment: 1,
    automatic_generation_retries: 0,
    unavailable_or_rejected_disposition: "accepted_still_fallback",
    accepted_clip_hash_required: true,
  };
}

export function requiredGeneratedMotionCoverageFindings(report, approval = null) {
  const required = new Set((report?.required_image_ids ?? []).map(String).filter(Boolean));
  if (!required.size) return [];
  const generated = new Set((report?.clips ?? []).map((row) => String(row.image_id ?? "")).filter(Boolean));
  const findings = [...required]
    .filter((imageId) => !generated.has(imageId))
    .map((imageId) => ({ code: "required_generated_motion_missing", image_id: imageId }));
  if (!approval) return findings;
  const accepted = new Set((approval.decisions ?? [])
    .filter((row) => row.decision === "accepted")
    .map((row) => String(row.image_id ?? ""))
    .filter(Boolean));
  findings.push(...[...required]
    .filter((imageId) => !accepted.has(imageId))
    .map((imageId) => ({ code: "required_generated_motion_not_accepted", image_id: imageId })));
  return findings;
}

export function clampGeneratedMotionDuration(value, provider = GENERATED_MOTION_PROVIDER_FLOW) {
  if (normalizeGeneratedMotionProvider(provider) === GENERATED_MOTION_PROVIDER_LTX) return clampLtxDuration(value);
  const parsed = Number(value);
  return Math.max(4, Math.min(10, Math.round(Number.isFinite(parsed) ? parsed : 8)));
}

export function generatedMotionPromptForSequence(direction) {
  return ltxMotionPromptForSequence(direction);
}

export function generatedMotionNegativePrompt() {
  return ltxNegativePrompt();
}

export async function generatedMotionApprovalMatches(report, approval, { reportPath = null } = {}) {
  if (report?.schema === "goldflow_ltx23_video_report_v1") {
    return ltxApprovalMatches(report, approval, { reportPath });
  }
  if (report?.schema !== GENERATED_MOTION_REPORT_SCHEMA || report?.status !== "passed") return false;
  if (approval?.schema !== GENERATED_MOTION_APPROVAL_SCHEMA || approval?.status !== "passed") return false;
  if (reportPath && approval.report_sha256 !== await hashFile(reportPath)) return false;
  const decisions = new Map((approval.decisions ?? []).map((row) => [String(row.candidate_id ?? row.image_id ?? ""), row]));
  for (const clip of report.clips ?? []) {
    const decision = decisions.get(String(clip.candidate_id ?? clip.image_id ?? ""));
    if (!decision || !["accepted", "rejected"].includes(String(decision.decision ?? ""))) return false;
    if (decision.source_image_sha256 !== clip.source_image_sha256) return false;
    if (decision.video_sha256 !== clip.normalized_video_sha256) return false;
  }
  if (requiredGeneratedMotionCoverageFindings(report, approval).length) return false;
  return true;
}

export async function approvedGeneratedMotionCoverageByImage(report, approval, { reportPath = null } = {}) {
  if (report?.schema === "goldflow_ltx23_video_report_v1") {
    return approvedLtxCoverageByImage(report, approval, { reportPath });
  }
  if (!await generatedMotionApprovalMatches(report, approval, { reportPath })) return new Map();
  const accepted = new Set((approval.decisions ?? [])
    .filter((row) => row.decision === "accepted")
    .map((row) => String(row.candidate_id ?? row.image_id ?? "")));
  const rows = new Map();
  for (const clip of report.clips ?? []) {
    if (!accepted.has(String(clip.candidate_id ?? clip.image_id ?? ""))) continue;
    if (await hashFile(clip.normalized_video_path) !== clip.normalized_video_sha256) continue;
    const coverage = Array.isArray(clip.coverage) && clip.coverage.length
      ? clip.coverage
      : [{
          image_id: clip.image_id,
          image_sha256: clip.source_image_sha256,
          source_offset_sec: 0,
          source_end_offset_sec: Number(clip.cut_duration_sec ?? clip.requested_duration_sec),
        }];
    for (const covered of coverage) {
      const imageId = String(covered.image_id ?? "");
      if (imageId && !rows.has(imageId)) rows.set(imageId, { clip, covered });
    }
  }
  return rows;
}

export function generatedMotionTreatmentForClip(clip, covered = null) {
  if (clip.provider === "modelslab" || clip.model_id === "ltx-2.3") return ltxTreatmentForClip(clip, covered);
  const coverage = covered ?? {
    image_id: clip.image_id,
    image_sha256: clip.source_image_sha256,
    source_offset_sec: 0,
    source_end_offset_sec: Number(clip.cut_duration_sec ?? clip.requested_duration_sec),
  };
  return {
    mode: "generated_video",
    provider: clip.provider ?? GENERATED_MOTION_PROVIDER_FLOW,
    model_id: clip.model_id ?? DEFAULT_GENERATED_MOTION_MODEL,
    source_image_sha256: clip.source_image_sha256,
    covered_image_id: coverage.image_id,
    covered_image_sha256: coverage.image_sha256 ?? clip.source_image_sha256,
    source_offset_sec: Number(coverage.source_offset_sec ?? 0),
    source_end_offset_sec: Number(coverage.source_end_offset_sec ?? Number(coverage.source_offset_sec ?? 0) + Number(clip.cut_duration_sec ?? 0)),
    animation_sequence_id: clip.animation_sequence_id ?? null,
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
