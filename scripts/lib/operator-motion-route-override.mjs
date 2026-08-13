import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const NO_LTX_OVERRIDE_SCHEMA = "goldflow_operator_motion_route_override_v1";
export const NO_LTX_OVERRIDE_STAGES = Object.freeze([
  "animation_direction_plan",
  "generated_video_motion",
  "generated_video_motion_approval",
]);

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function sha256File(filePath) {
  try {
    const bytes = await fs.readFile(filePath);
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    return null;
  }
}

export function operatorMotionRouteOverridePath(episodeDir, episode) {
  return path.join(episodeDir, `operator_motion_route_override_${episode}.json`);
}

export function validateNoLtxOverrideArtifact(artifact, {
  episode,
  runIdentitySha256,
  parallaxPolicy,
} = {}) {
  const findings = [];
  if (artifact?.schema !== NO_LTX_OVERRIDE_SCHEMA) findings.push("schema_mismatch");
  if (artifact?.status !== "approved") findings.push("status_not_approved");
  if (String(artifact?.episode ?? "") !== String(episode ?? "")) findings.push("episode_mismatch");
  if (artifact?.run_identity_sha256 !== runIdentitySha256) findings.push("run_identity_hash_mismatch");
  if (artifact?.disable_ltx !== true) findings.push("disable_ltx_not_true");
  if (artifact?.fallback_motion_route !== "selective_inspected_parallax") findings.push("fallback_motion_route_mismatch");
  if (parallaxPolicy !== "selective_inspected") findings.push("run_identity_parallax_not_selective_inspected");
  if (artifact?.subject_motion?.lateral_translation !== "forbidden") findings.push("lateral_translation_not_forbidden");
  if (artifact?.subject_motion?.scale_behavior !== "grow_in_place") findings.push("scale_behavior_not_grow_in_place");
  const stages = [...new Set((artifact?.waived_stages ?? []).map(String))].sort();
  const expected = [...NO_LTX_OVERRIDE_STAGES].sort();
  if (JSON.stringify(stages) !== JSON.stringify(expected)) findings.push("waived_stage_scope_mismatch");
  if (!String(artifact?.operator_instruction ?? "").trim()) findings.push("operator_instruction_missing");
  return {
    done: findings.length === 0,
    findings,
  };
}

export async function noLtxOverrideStatus(episodeDir, episode, identityPath, identity = {}) {
  const overridePath = operatorMotionRouteOverridePath(episodeDir, episode);
  const [artifact, runIdentitySha256] = await Promise.all([
    readJson(overridePath),
    sha256File(identityPath),
  ]);
  if (!artifact) {
    return {
      done: false,
      evidence: `${path.basename(overridePath)} missing`,
      path: overridePath,
      artifact: null,
      findings: ["override_missing"],
    };
  }
  const validation = validateNoLtxOverrideArtifact(artifact, {
    episode,
    runIdentitySha256,
    parallaxPolicy: identity?.parallax_policy,
  });
  return {
    ...validation,
    evidence: validation.done
      ? `${path.basename(overridePath)} approved; LTX waived in favor of selective inspected parallax with in-place subject growth`
      : `${path.basename(overridePath)} invalid: ${validation.findings.join(", ")}`,
    path: overridePath,
    artifact,
    run_identity_sha256: runIdentitySha256,
  };
}

export function enforceInPlaceSubjectGrowth(intent) {
  if (!intent || typeof intent !== "object" || intent.behavior === "static_hold") return intent;
  const anchor = intent.end_anchor ?? intent.start_anchor ?? intent.motion_keyframes?.[0]?.anchor ?? { x: 0.5, y: 0.5 };
  return {
    ...intent,
    start_anchor: { ...anchor },
    end_anchor: { ...anchor },
    ...(Array.isArray(intent.motion_keyframes) ? {
      motion_keyframes: intent.motion_keyframes.map((keyframe) => ({
        ...keyframe,
        anchor: { ...anchor },
      })),
    } : {}),
    operator_motion_route: {
      lateral_translation: "forbidden",
      scale_behavior: "grow_in_place",
    },
  };
}
