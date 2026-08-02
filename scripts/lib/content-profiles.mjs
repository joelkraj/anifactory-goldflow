import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const profileRoot = path.join(repoRoot, "docs", "content_profiles");

const builtInProfiles = new Map([
  ["manhwa_recap_v1", path.join(profileRoot, "manhwa_recap_v1.json")],
  ["asset_afterlife_v1", path.join(profileRoot, "asset_afterlife_v1.json")],
]);

const aliases = new Map([
  ["default", "manhwa_recap_v1"],
  ["manhwa", "manhwa_recap_v1"],
  ["manhwa_recap", "manhwa_recap_v1"],
  ["manhwa_recap_v1", "manhwa_recap_v1"],
  ["asset_afterlife", "asset_afterlife_v1"],
  ["asset-afterlife", "asset_afterlife_v1"],
  ["asset_afterlife_v1", "asset_afterlife_v1"],
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedId(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function validateProfile(profile, sourcePath) {
  const blockers = [];
  if (profile?.schema !== "goldflow_content_profile_v1") blockers.push("schema");
  if (!normalizedId(profile?.id)) blockers.push("id");
  if (!String(profile?.version ?? "").trim()) blockers.push("version");
  if (!String(profile?.content_family ?? "").trim()) blockers.push("content_family");
  if (!String(profile?.visual?.scene_prompt_style_phrase ?? "").trim()) blockers.push("visual.scene_prompt_style_phrase");
  if (!Array.isArray(profile?.visual?.required_scene_prompt_phrases_any)
    || !profile.visual.required_scene_prompt_phrases_any.some((value) => String(value ?? "").trim())) {
    blockers.push("visual.required_scene_prompt_phrases_any");
  }
  if (!profile?.planner_roles || typeof profile.planner_roles !== "object") blockers.push("planner_roles");
  if (blockers.length) {
    throw new Error(`Invalid content profile ${sourcePath}: missing or invalid ${blockers.join(", ")}.`);
  }
  return profile;
}

function resolveProfilePath(value) {
  const raw = String(value ?? DEFAULT_CONTENT_PROFILE).trim();
  const alias = aliases.get(normalizedId(raw));
  if (alias) return builtInProfiles.get(alias);
  const candidate = path.resolve(raw);
  try {
    if (statSync(candidate).isFile()) return candidate;
  } catch {}
  throw new Error(`Unknown content profile: ${value}. Expected manhwa_recap_v1, asset_afterlife_v1, or a JSON profile path.`);
}

function loadDefinition(value) {
  const profilePath = resolveProfilePath(value);
  const bytes = readFileSync(profilePath);
  let profile;
  try {
    profile = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid content profile JSON at ${profilePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  validateProfile(profile, profilePath);
  return {
    id: normalizedId(profile.id),
    path: profilePath,
    sha256: sha256(bytes),
    config: structuredClone(profile),
  };
}

export const DEFAULT_CONTENT_PROFILE = "manhwa_recap_v1";

export function contentProfileDefinition(value = DEFAULT_CONTENT_PROFILE) {
  return loadDefinition(value);
}

export function contentProfileForIdentity(identity = {}) {
  const embedded = identity?.content_profile_config;
  if (embedded) {
    validateProfile(embedded, "run_identity.json#content_profile_config");
    return structuredClone(embedded);
  }
  return loadDefinition(identity?.content_profile ?? DEFAULT_CONTENT_PROFILE).config;
}

export function contentProfilePlannerRole(profile, stage, fallback) {
  return String(profile?.planner_roles?.[stage] ?? fallback ?? "a production planning assistant").trim();
}

export function contentProfileSceneStylePhrase(profile) {
  return String(profile?.visual?.scene_prompt_style_phrase ?? "16:9 landscape anime/manhwa frame").trim();
}

export function contentProfileStyleLabel(profile) {
  return String(profile?.visual?.reference_style_label ?? "production visual language").trim();
}

export function contentProfileReferenceInstruction(profile, kind, fallback = "production reference image") {
  return String(profile?.visual?.reference_kind_instructions?.[kind] ?? fallback).trim();
}

export function contentProfileSceneStyleSatisfied(promptText, profile) {
  const normalizedPrompt = String(promptText ?? "").toLowerCase();
  return (profile?.visual?.required_scene_prompt_phrases_any ?? [])
    .some((phrase) => normalizedPrompt.includes(String(phrase ?? "").trim().toLowerCase()));
}

export function contentProfilePlannerDirective(profile) {
  const directives = Array.isArray(profile?.visual?.planner_directives)
    ? profile.visual.planner_directives.filter((value) => String(value ?? "").trim())
    : [];
  return directives.map((directive) => `- ${directive}`).join("\n");
}

export function contentProfileVisualJobs(profile) {
  return Array.isArray(profile?.visual?.visual_jobs)
    ? profile.visual.visual_jobs.map(String).filter(Boolean)
    : [];
}

export function contentProfileShotJobs(profile) {
  return Array.isArray(profile?.visual?.shot_jobs)
    ? profile.visual.shot_jobs.map(String).filter(Boolean)
    : [];
}

export function contentProfileRequiresEvidenceLedger(profile) {
  return profile?.factuality?.evidence_ledger_required === true;
}
