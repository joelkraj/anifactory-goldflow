import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DEFAULT_GOOGLE_FLOW_MODEL,
  DEFAULT_GOOGLE_FLOW_PLAN,
  HYBRID_WEB_FLOW_PROVIDER,
  hybridWebFlowIdentityOptions,
  hybridWebFlowProviderLocks,
  hybridWebFlowProviderModels,
  loadGoogleFlowHealthProof,
} from "./image-provider-policy.mjs";

export const IMAGE_ROUTE_OVERRIDE_SCHEMA = "goldflow_operator_image_route_override_v1";

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function sha256File(filePath) {
  try {
    return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
  } catch {
    return null;
  }
}

export function operatorImageRouteOverridePath(episodeDir, episode) {
  return path.join(episodeDir, `operator_image_route_override_${episode}.json`);
}

export async function effectiveImageIdentityForEpisode(episodeDir, identityPath, identity = {}) {
  const episode = String(identity?.episode ?? path.basename(episodeDir));
  const overridePath = operatorImageRouteOverridePath(episodeDir, episode);
  const artifact = await readJson(overridePath);
  if (!artifact) return { identity, override: null, status: { done: false, evidence: `${path.basename(overridePath)} missing` } };
  const findings = [];
  const identitySha256 = await sha256File(identityPath);
  if (artifact.schema !== IMAGE_ROUTE_OVERRIDE_SCHEMA) findings.push("schema_mismatch");
  if (artifact.status !== "approved") findings.push("status_not_approved");
  if (artifact.episode !== episode) findings.push("episode_mismatch");
  if (artifact.run_identity_sha256 !== identitySha256) findings.push("run_identity_hash_mismatch");
  if (artifact.from_image_provider !== identity.image_provider) findings.push("source_provider_mismatch");
  if (artifact.to_image_provider !== HYBRID_WEB_FLOW_PROVIDER) findings.push("target_provider_mismatch");
  if (artifact.preserve_existing_accepted_assets !== true) findings.push("preserve_existing_assets_not_locked");
  if (artifact.one_creative_submission_per_asset !== true) findings.push("single_submission_not_locked");
  if (artifact.automatic_provider_failover !== "none") findings.push("provider_failover_not_disabled");
  if (artifact.style_reference_provider !== "chatgpt_web_gpt_image") findings.push("style_provider_mismatch");
  const flowPlan = String(artifact.google_flow_plan ?? DEFAULT_GOOGLE_FLOW_PLAN);
  const flowModel = String(artifact.google_flow_model ?? DEFAULT_GOOGLE_FLOW_MODEL);
  let healthProof = null;
  try {
    healthProof = await loadGoogleFlowHealthProof(artifact.google_flow_health_proof_path, {
      expectedSha256: artifact.google_flow_health_proof_sha256,
      expectedPlan: flowPlan,
      expectedModel: flowModel,
    });
  } catch (error) {
    findings.push(`google_flow_health_proof:${error instanceof Error ? error.message : String(error)}`);
  }
  if (findings.length) {
    return {
      identity,
      override: artifact,
      status: { done: false, evidence: `${path.basename(overridePath)} invalid: ${findings.join(", ")}`, findings },
    };
  }
  const options = hybridWebFlowIdentityOptions({
    chatGptProjectUrl: artifact.chatgpt_project_url,
    flowPlan,
    flowModel,
    healthProof,
  });
  const imageLocks = hybridWebFlowProviderLocks(options, { flowModel });
  const effective = {
    ...identity,
    image_provider: HYBRID_WEB_FLOW_PROVIDER,
    image_provider_options: options,
    provider_locks: { ...(identity.provider_locks ?? {}), ...imageLocks },
    model_versions: {
      ...(identity.model_versions ?? {}),
      image_provider_models: hybridWebFlowProviderModels({ flowModel }),
    },
    operator_image_route_override: {
      path: overridePath,
      run_identity_sha256: identitySha256,
      preserve_existing_accepted_assets: true,
    },
  };
  return {
    identity: effective,
    override: artifact,
    status: {
      done: true,
      evidence: `${path.basename(overridePath)} approved; remaining images use topped-off ChatGPT 3 + Flow 5 while accepted assets remain immutable`,
    },
  };
}
