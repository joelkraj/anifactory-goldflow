import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { googleImageSchedulingForIdentity, googleImageSchedulingPolicy } from "./google-image-scheduling.mjs";

export const HYBRID_WEB_FLOW_PROVIDER = "hybrid_chatgpt_web_style_google_flow_pool";
export const FEDERATED_WEB_IMAGE_PROVIDER = "federated_google_web_image_pool";
export const FEDERATED_WEB_IMAGE_ROUTING_POLICY_V1 = "resource_aware_google_web_pool_v1";
export const FEDERATED_WEB_IMAGE_ROUTING_POLICY_V2 = "resource_aware_google_web_pool_v2";
export const FEDERATED_WEB_IMAGE_ROUTING_POLICY = "resource_aware_google_web_pool_v3";
export const HYBRID_WEB_FLOW_ROUTING_POLICY = "speed_first_web_flow_v1";
export const HYBRID_WEB_FLOW_ASSIGNMENT_POLICY = "first_available_top_off_v1";
export const FRESH_BROWSER_SESSION_PER_JOB_POLICY = "fresh_session_per_job_v1";
export const PERSISTENT_BROWSER_TAB_PER_SLOT_POLICY = "persistent_tab_per_worker_slot_v1";
export const FRESH_GOOGLE_FLOW_PROJECT_PER_JOB_POLICY = "fresh_project_per_job";
export const PERSISTENT_GOOGLE_FLOW_PROJECT_PER_SLOT_POLICY = "persistent_project_per_worker_slot_v1";
export const CHATGPT_WEB_IMAGE_PROVIDER = "chatgpt_web_gpt_image";
export const GOOGLE_FLOW_IMAGE_PROVIDER = "google_flow";
export const GOOGLE_GEMINI_IMAGE_PROVIDER = "google_gemini_imagen";
export const GOOGLE_FLOW_PRIMARY_ROUTING_POLICY = "google_flow_primary_v1";
export const GOOGLE_FLOW_EXACT_ID_FALLBACK_POLICY = "operator_approved_exact_id_only_v1";
export const GOOGLE_FLOW_BROWSER_PROVIDER = "google-flow";
export const GOOGLE_GEMINI_BROWSER_PROVIDER = "google-gemini";
export const GOOGLE_FLOW_REFERENCE_BINDING_SCHEMA = "goldflow_google_flow_reference_binding_v1";
export const HYBRID_CHATGPT_IMAGE_CONCURRENCY = 3;
export const HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY = 5;
export const HYBRID_TOTAL_IMAGE_CONCURRENCY = HYBRID_CHATGPT_IMAGE_CONCURRENCY + HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY;
export const GOOGLE_GEMINI_IMAGE_CONCURRENCY = 3;
export const FEDERATED_GOOGLE_PRIMARY_CONCURRENCY = HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY + GOOGLE_GEMINI_IMAGE_CONCURRENCY;
export const FEDERATED_TOTAL_IMAGE_CONCURRENCY = FEDERATED_GOOGLE_PRIMARY_CONCURRENCY;
export const FEDERATED_LEGACY_TOTAL_IMAGE_CONCURRENCY = FEDERATED_GOOGLE_PRIMARY_CONCURRENCY + HYBRID_CHATGPT_IMAGE_CONCURRENCY;
export const DEFAULT_GOOGLE_FLOW_PLAN = "ULTRA";
export const DEFAULT_GOOGLE_FLOW_MODEL = "Nano Banana Pro";
export const DEFAULT_GOOGLE_GEMINI_PLAN = "Ultra";
export const DEFAULT_GOOGLE_GEMINI_MODEL = "Nano Banana 2";
export const DEFAULT_GOOGLE_FLOW_HEALTH_PROOF_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../docs/proofs/google_flow_ultra_access_v1.json",
);

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REQUIRED_LIVE_REFERENCE_COUNTS = [1, 2, 4];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactArray(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

export function isHybridWebFlowProvider(provider) {
  return String(provider ?? "") === HYBRID_WEB_FLOW_PROVIDER;
}

export function isFederatedWebImageProvider(provider) {
  return String(provider ?? "") === FEDERATED_WEB_IMAGE_PROVIDER;
}

export function isGoogleFlowPrimaryProvider(provider) {
  return String(provider ?? "") === GOOGLE_FLOW_IMAGE_PROVIDER;
}

export function isBrowserPoolImageProvider(provider) {
  return isHybridWebFlowProvider(provider) || isGoogleFlowPrimaryProvider(provider) || isFederatedWebImageProvider(provider);
}

export function isStyleReferenceTarget(target = {}) {
  return String(target?.kind ?? "").toLowerCase().includes("style")
    || String(target?.ref_id ?? "").toLowerCase() === "style_ref";
}

export function hybridWebFlowProviderModels({ flowModel = DEFAULT_GOOGLE_FLOW_MODEL } = {}) {
  return {
    [CHATGPT_WEB_IMAGE_PROVIDER]: {
      image_model: CHATGPT_WEB_IMAGE_PROVIDER,
      reference_model: CHATGPT_WEB_IMAGE_PROVIDER,
    },
    [GOOGLE_FLOW_IMAGE_PROVIDER]: {
      image_model: flowModel,
      reference_model: flowModel,
    },
  };
}

export function federatedWebImageProviderModels({
  flowModel = DEFAULT_GOOGLE_FLOW_MODEL,
  geminiModel = DEFAULT_GOOGLE_GEMINI_MODEL,
} = {}) {
  return {
    [GOOGLE_FLOW_IMAGE_PROVIDER]: { image_model: flowModel, reference_model: flowModel },
    [GOOGLE_GEMINI_IMAGE_PROVIDER]: { image_model: geminiModel, reference_model: geminiModel },
    [CHATGPT_WEB_IMAGE_PROVIDER]: {
      image_model: CHATGPT_WEB_IMAGE_PROVIDER,
      reference_model: CHATGPT_WEB_IMAGE_PROVIDER,
      fallback_only: true,
    },
  };
}

export function federatedWebImageIdentityOptions({
  chatGptProjectUrl = null,
  flowPlan = DEFAULT_GOOGLE_FLOW_PLAN,
  flowModel = DEFAULT_GOOGLE_FLOW_MODEL,
  geminiPlan = DEFAULT_GOOGLE_GEMINI_PLAN,
  geminiModel = DEFAULT_GOOGLE_GEMINI_MODEL,
  healthProof,
  schedulingPolicy = null,
} = {}) {
  if (!healthProof?.path || !SHA256_PATTERN.test(String(healthProof?.sha256 ?? ""))) {
    throw new Error("Federated image identity options require a hash-bound Google Flow health proof.");
  }
  const scheduling = googleImageSchedulingPolicy(schedulingPolicy);
  return {
    ...(scheduling ? { scheduling } : {}),
    routing_policy: FEDERATED_WEB_IMAGE_ROUTING_POLICY,
    style_reference_provider: GOOGLE_GEMINI_IMAGE_PROVIDER,
    reference_provider_pool: [GOOGLE_FLOW_IMAGE_PROVIDER, GOOGLE_GEMINI_IMAGE_PROVIDER],
    scene_provider_pool: [GOOGLE_FLOW_IMAGE_PROVIDER, GOOGLE_GEMINI_IMAGE_PROVIDER],
    assignment_policy: HYBRID_WEB_FLOW_ASSIGNMENT_POLICY,
    chatgpt_activation_policy: "operator_approved_exact_id_only_v1",
    explicit_fallback: {
      provider: CHATGPT_WEB_IMAGE_PROVIDER,
      policy: GOOGLE_FLOW_EXACT_ID_FALLBACK_POLICY,
      automatic_failover: false,
    },
    chatgpt_project_url: chatGptProjectUrl,
    google_flow: {
      concurrency: scheduling?.google_flow_concurrency ?? HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY,
      plan_label: flowPlan,
      model_label: flowModel,
      project_policy: PERSISTENT_GOOGLE_FLOW_PROJECT_PER_SLOT_POLICY,
      worker_session_policy: PERSISTENT_GOOGLE_FLOW_PROJECT_PER_SLOT_POLICY,
      reference_binding_schema: GOOGLE_FLOW_REFERENCE_BINDING_SCHEMA,
      require_verified_reference_binding: true,
      health_proof_path: healthProof.path,
      health_proof_sha256: healthProof.sha256,
    },
    google_gemini: {
      concurrency: scheduling?.google_gemini_concurrency ?? GOOGLE_GEMINI_IMAGE_CONCURRENCY,
      plan_label: geminiPlan,
      model_label: geminiModel,
      worker_session_policy: PERSISTENT_BROWSER_TAB_PER_SLOT_POLICY,
      reference_binding_required: true,
    },
    chatgpt_web: { concurrency: 0, fallback_concurrency: HYBRID_CHATGPT_IMAGE_CONCURRENCY },
  };
}

export function federatedWebImageProviderLocks(options, {
  flowModel = DEFAULT_GOOGLE_FLOW_MODEL,
  geminiModel = DEFAULT_GOOGLE_GEMINI_MODEL,
} = {}) {
  const scheduling = options?.scheduling;
  const flowConcurrency = scheduling?.google_flow_concurrency ?? HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY;
  const geminiConcurrency = scheduling?.google_gemini_concurrency ?? GOOGLE_GEMINI_IMAGE_CONCURRENCY;
  return {
    ...(scheduling ? { image_scheduling: { ...scheduling } } : {}),
    image_provider: FEDERATED_WEB_IMAGE_PROVIDER,
    image_routing_policy: options?.routing_policy ?? FEDERATED_WEB_IMAGE_ROUTING_POLICY,
    image_assignment_policy: HYBRID_WEB_FLOW_ASSIGNMENT_POLICY,
    style_reference_provider: GOOGLE_GEMINI_IMAGE_PROVIDER,
    reference_provider_pool: options?.reference_provider_pool ?? [GOOGLE_FLOW_IMAGE_PROVIDER, GOOGLE_GEMINI_IMAGE_PROVIDER],
    scene_provider_pool: options?.scene_provider_pool ?? [GOOGLE_FLOW_IMAGE_PROVIDER, GOOGLE_GEMINI_IMAGE_PROVIDER],
    explicit_image_fallback_provider: CHATGPT_WEB_IMAGE_PROVIDER,
    explicit_image_fallback_policy: GOOGLE_FLOW_EXACT_ID_FALLBACK_POLICY,
    google_flow_image_concurrency: flowConcurrency,
    google_gemini_image_concurrency: geminiConcurrency,
    chatgpt_web_image_concurrency: Number(options?.chatgpt_web?.concurrency ?? 0),
    chatgpt_web_fallback_concurrency: HYBRID_CHATGPT_IMAGE_CONCURRENCY,
    federated_google_primary_concurrency: flowConcurrency + geminiConcurrency,
    federated_web_image_concurrency: scheduling?.total_concurrency ?? FEDERATED_TOTAL_IMAGE_CONCURRENCY,
    chatgpt_image_activation_policy: options?.chatgpt_activation_policy ?? "operator_approved_exact_id_only_v1",
    creative_submission_attempts: 1,
    image_automatic_retry_policy: "none",
    image_automatic_provider_failover_policy: "none",
    style_reference_barrier: true,
    google_flow_plan_label: options?.google_flow?.plan_label ?? DEFAULT_GOOGLE_FLOW_PLAN,
    google_flow_model_label: options?.google_flow?.model_label ?? flowModel,
    google_flow_project_policy: options?.google_flow?.project_policy ?? PERSISTENT_GOOGLE_FLOW_PROJECT_PER_SLOT_POLICY,
    google_flow_worker_session_policy: options?.google_flow?.worker_session_policy ?? PERSISTENT_GOOGLE_FLOW_PROJECT_PER_SLOT_POLICY,
    google_flow_reference_binding_schema: GOOGLE_FLOW_REFERENCE_BINDING_SCHEMA,
    google_flow_reference_binding_required: true,
    google_flow_health_proof_path: options?.google_flow?.health_proof_path ?? null,
    google_flow_health_proof_sha256: options?.google_flow?.health_proof_sha256 ?? null,
    google_gemini_plan_label: options?.google_gemini?.plan_label ?? DEFAULT_GOOGLE_GEMINI_PLAN,
    google_gemini_model_label: options?.google_gemini?.model_label ?? geminiModel,
    google_gemini_worker_session_policy: options?.google_gemini?.worker_session_policy ?? PERSISTENT_BROWSER_TAB_PER_SLOT_POLICY,
    google_gemini_reference_binding_required: true,
    image_provider_models: federatedWebImageProviderModels({ flowModel, geminiModel }),
  };
}

export function googleFlowPrimaryIdentityOptions({
  flowPlan = DEFAULT_GOOGLE_FLOW_PLAN,
  flowModel = DEFAULT_GOOGLE_FLOW_MODEL,
  healthProof,
} = {}) {
  if (!healthProof?.path || !SHA256_PATTERN.test(String(healthProof?.sha256 ?? ""))) {
    throw new Error("Google Flow primary identity options require a hash-bound health proof.");
  }
  return {
    routing_policy: GOOGLE_FLOW_PRIMARY_ROUTING_POLICY,
    style_reference_provider: GOOGLE_FLOW_IMAGE_PROVIDER,
    reference_provider_pool: [GOOGLE_FLOW_IMAGE_PROVIDER],
    scene_provider_pool: [GOOGLE_FLOW_IMAGE_PROVIDER],
    assignment_policy: HYBRID_WEB_FLOW_ASSIGNMENT_POLICY,
    explicit_fallback: {
      provider: CHATGPT_WEB_IMAGE_PROVIDER,
      policy: GOOGLE_FLOW_EXACT_ID_FALLBACK_POLICY,
      automatic_failover: false,
    },
    google_flow: {
      concurrency: HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY,
      plan_label: flowPlan,
      model_label: flowModel,
      project_policy: FRESH_GOOGLE_FLOW_PROJECT_PER_JOB_POLICY,
      reference_binding_schema: GOOGLE_FLOW_REFERENCE_BINDING_SCHEMA,
      require_verified_reference_binding: true,
      health_proof_path: healthProof.path,
      health_proof_sha256: healthProof.sha256,
    },
  };
}

export function googleFlowPrimaryProviderLocks(options, { flowModel = DEFAULT_GOOGLE_FLOW_MODEL } = {}) {
  return {
    image_provider: GOOGLE_FLOW_IMAGE_PROVIDER,
    image_routing_policy: GOOGLE_FLOW_PRIMARY_ROUTING_POLICY,
    image_assignment_policy: HYBRID_WEB_FLOW_ASSIGNMENT_POLICY,
    style_reference_provider: GOOGLE_FLOW_IMAGE_PROVIDER,
    reference_provider_pool: [GOOGLE_FLOW_IMAGE_PROVIDER],
    scene_provider_pool: [GOOGLE_FLOW_IMAGE_PROVIDER],
    explicit_image_fallback_provider: CHATGPT_WEB_IMAGE_PROVIDER,
    explicit_image_fallback_policy: GOOGLE_FLOW_EXACT_ID_FALLBACK_POLICY,
    google_flow_image_concurrency: HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY,
    creative_submission_attempts: 1,
    image_automatic_retry_policy: "none",
    image_automatic_provider_failover_policy: "none",
    style_reference_barrier: true,
    google_flow_plan_label: options?.google_flow?.plan_label ?? DEFAULT_GOOGLE_FLOW_PLAN,
    google_flow_model_label: options?.google_flow?.model_label ?? flowModel,
    google_flow_project_policy: FRESH_GOOGLE_FLOW_PROJECT_PER_JOB_POLICY,
    google_flow_reference_binding_schema: GOOGLE_FLOW_REFERENCE_BINDING_SCHEMA,
    google_flow_reference_binding_required: true,
    google_flow_health_proof_path: options?.google_flow?.health_proof_path ?? null,
    google_flow_health_proof_sha256: options?.google_flow?.health_proof_sha256 ?? null,
    image_provider_models: {
      [GOOGLE_FLOW_IMAGE_PROVIDER]: {
        image_model: flowModel,
        reference_model: flowModel,
      },
      [CHATGPT_WEB_IMAGE_PROVIDER]: {
        image_model: CHATGPT_WEB_IMAGE_PROVIDER,
        reference_model: CHATGPT_WEB_IMAGE_PROVIDER,
        fallback_only: true,
      },
    },
  };
}

export async function googleFlowPrimaryIdentityStatus(identity = {}) {
  if (!isGoogleFlowPrimaryProvider(identity.image_provider)) {
    return { done: true, evidence: `image provider=${identity.image_provider ?? "legacy/default"}` };
  }
  const options = identity.image_provider_options ?? {};
  const locks = identity.provider_locks ?? {};
  const flow = options.google_flow ?? {};
  const findings = [];
  const compare = (condition, field) => { if (!condition) findings.push(field); };
  compare(options.routing_policy === GOOGLE_FLOW_PRIMARY_ROUTING_POLICY, "image_provider_options.routing_policy");
  compare(options.style_reference_provider === GOOGLE_FLOW_IMAGE_PROVIDER, "image_provider_options.style_reference_provider");
  compare(exactArray(options.reference_provider_pool, [GOOGLE_FLOW_IMAGE_PROVIDER]), "image_provider_options.reference_provider_pool");
  compare(exactArray(options.scene_provider_pool, [GOOGLE_FLOW_IMAGE_PROVIDER]), "image_provider_options.scene_provider_pool");
  compare(options.explicit_fallback?.provider === CHATGPT_WEB_IMAGE_PROVIDER, "image_provider_options.explicit_fallback.provider");
  compare(options.explicit_fallback?.automatic_failover === false, "image_provider_options.explicit_fallback.automatic_failover");
  compare(locks.image_provider === GOOGLE_FLOW_IMAGE_PROVIDER, "provider_locks.image_provider");
  compare(locks.image_routing_policy === GOOGLE_FLOW_PRIMARY_ROUTING_POLICY, "provider_locks.image_routing_policy");
  compare(locks.style_reference_provider === GOOGLE_FLOW_IMAGE_PROVIDER, "provider_locks.style_reference_provider");
  compare(locks.explicit_image_fallback_provider === CHATGPT_WEB_IMAGE_PROVIDER, "provider_locks.explicit_image_fallback_provider");
  compare(locks.image_automatic_provider_failover_policy === "none", "provider_locks.image_automatic_provider_failover_policy");
  compare(Number(locks.creative_submission_attempts) === 1, "provider_locks.creative_submission_attempts");
  compare(Number(flow.concurrency) === HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY, "image_provider_options.google_flow.concurrency");
  compare(flow.reference_binding_schema === GOOGLE_FLOW_REFERENCE_BINDING_SCHEMA, "image_provider_options.google_flow.reference_binding_schema");
  try {
    const proof = await loadGoogleFlowHealthProof(flow.health_proof_path, {
      expectedSha256: flow.health_proof_sha256,
      expectedPlan: flow.plan_label,
      expectedModel: flow.model_label,
    });
    compare(locks.google_flow_health_proof_sha256 === proof.sha256, "provider_locks.google_flow_health_proof_sha256");
  } catch (error) {
    findings.push(`google_flow_health_proof:${error instanceof Error ? error.message : String(error)}`);
  }
  return findings.length
    ? { done: false, evidence: `Google Flow primary identity missing/stale: ${findings.join(", ")}`, findings }
    : { done: true, evidence: `Google Flow primary locked at concurrency ${HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY}; ChatGPT exact-ID fallback only; no automatic failover` };
}

export async function federatedWebImageIdentityStatus(identity = {}) {
  if (!isFederatedWebImageProvider(identity.image_provider)) {
    return { done: true, evidence: `image provider=${identity.image_provider ?? "legacy/default"}` };
  }
  const options = identity.image_provider_options ?? {};
  const locks = identity.provider_locks ?? {};
  const flow = options.google_flow ?? {};
  const gemini = options.google_gemini ?? {};
  let scheduling;
  try { scheduling = googleImageSchedulingForIdentity(identity); }
  catch (error) { return { done: false, evidence: error.message, findings: [error.message] }; }
  const flowConcurrency = scheduling?.google_flow_concurrency ?? HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY;
  const geminiConcurrency = scheduling?.google_gemini_concurrency ?? GOOGLE_GEMINI_IMAGE_CONCURRENCY;
  const legacyV1 = options.routing_policy === FEDERATED_WEB_IMAGE_ROUTING_POLICY_V1;
  const legacyV2 = options.routing_policy === FEDERATED_WEB_IMAGE_ROUTING_POLICY_V2;
  const currentV3 = options.routing_policy === FEDERATED_WEB_IMAGE_ROUTING_POLICY;
  const legacyFederated = legacyV1 || legacyV2;
  const expectedPool = legacyV1
    ? [GOOGLE_FLOW_IMAGE_PROVIDER, GOOGLE_GEMINI_IMAGE_PROVIDER, CHATGPT_WEB_IMAGE_PROVIDER]
    : [GOOGLE_FLOW_IMAGE_PROVIDER, GOOGLE_GEMINI_IMAGE_PROVIDER];
  const expectedChatGptConcurrency = legacyV1 ? HYBRID_CHATGPT_IMAGE_CONCURRENCY : 0;
  const expectedTotalConcurrency = legacyV1
    ? FEDERATED_LEGACY_TOTAL_IMAGE_CONCURRENCY
    : scheduling?.total_concurrency ?? FEDERATED_TOTAL_IMAGE_CONCURRENCY;
  const findings = [];
  const compare = (condition, field) => { if (!condition) findings.push(field); };
  compare(legacyFederated || currentV3, "image_provider_options.routing_policy");
  compare(!scheduling || currentV3, "image_provider_options.scheduling.routing_policy");
  compare(options.style_reference_provider === GOOGLE_GEMINI_IMAGE_PROVIDER, "image_provider_options.style_reference_provider");
  compare(exactArray(options.reference_provider_pool, expectedPool), "image_provider_options.reference_provider_pool");
  compare(exactArray(options.scene_provider_pool, expectedPool), "image_provider_options.scene_provider_pool");
  compare(options.chatgpt_activation_policy === (legacyV1
    ? "planning_idle_or_priority_asset_v1"
    : "operator_approved_exact_id_only_v1"), "image_provider_options.chatgpt_activation_policy");
  if (legacyV2 || currentV3) {
    compare(options.explicit_fallback?.provider === CHATGPT_WEB_IMAGE_PROVIDER, "image_provider_options.explicit_fallback.provider");
    compare(options.explicit_fallback?.policy === GOOGLE_FLOW_EXACT_ID_FALLBACK_POLICY, "image_provider_options.explicit_fallback.policy");
    compare(options.explicit_fallback?.automatic_failover === false, "image_provider_options.explicit_fallback.automatic_failover");
  }
  compare(Number(flow.concurrency) === flowConcurrency, "image_provider_options.google_flow.concurrency");
  compare(Number(gemini.concurrency) === geminiConcurrency, "image_provider_options.google_gemini.concurrency");
  const expectedFlowProjectPolicy = currentV3
    ? PERSISTENT_GOOGLE_FLOW_PROJECT_PER_SLOT_POLICY
    : FRESH_GOOGLE_FLOW_PROJECT_PER_JOB_POLICY;
  if (legacyV2 || currentV3) {
    compare(flow.project_policy === expectedFlowProjectPolicy, "image_provider_options.google_flow.project_policy");
  }
  if (currentV3) {
    compare(flow.worker_session_policy === PERSISTENT_GOOGLE_FLOW_PROJECT_PER_SLOT_POLICY, "image_provider_options.google_flow.worker_session_policy");
    compare(gemini.worker_session_policy === PERSISTENT_BROWSER_TAB_PER_SLOT_POLICY, "image_provider_options.google_gemini.worker_session_policy");
  }
  compare(Number(options.chatgpt_web?.concurrency) === expectedChatGptConcurrency, "image_provider_options.chatgpt_web.concurrency");
  compare(locks.image_provider === FEDERATED_WEB_IMAGE_PROVIDER, "provider_locks.image_provider");
  compare(locks.image_routing_policy === options.routing_policy, "provider_locks.image_routing_policy");
  compare(exactArray(locks.reference_provider_pool, expectedPool), "provider_locks.reference_provider_pool");
  compare(exactArray(locks.scene_provider_pool, expectedPool), "provider_locks.scene_provider_pool");
  compare(Number(locks.federated_google_primary_concurrency) === flowConcurrency + geminiConcurrency, "provider_locks.federated_google_primary_concurrency");
  if (scheduling) {
    compare(Number(locks.google_flow_image_concurrency) === flowConcurrency, "provider_locks.google_flow_image_concurrency");
    compare(Number(locks.google_gemini_image_concurrency) === geminiConcurrency, "provider_locks.google_gemini_image_concurrency");
  }
  compare(Number(locks.chatgpt_web_image_concurrency) === expectedChatGptConcurrency, "provider_locks.chatgpt_web_image_concurrency");
  compare(Number(locks.federated_web_image_concurrency) === expectedTotalConcurrency, "provider_locks.federated_web_image_concurrency");
  if (legacyV2 || currentV3) {
    compare(locks.explicit_image_fallback_provider === CHATGPT_WEB_IMAGE_PROVIDER, "provider_locks.explicit_image_fallback_provider");
    compare(locks.explicit_image_fallback_policy === GOOGLE_FLOW_EXACT_ID_FALLBACK_POLICY, "provider_locks.explicit_image_fallback_policy");
  }
  compare(locks.image_automatic_provider_failover_policy === "none", "provider_locks.image_automatic_provider_failover_policy");
  compare(Number(locks.creative_submission_attempts) === 1, "provider_locks.creative_submission_attempts");
  if (legacyV2 || currentV3) {
    compare(locks.google_flow_project_policy === expectedFlowProjectPolicy, "provider_locks.google_flow_project_policy");
  }
  if (currentV3) {
    compare(locks.google_flow_worker_session_policy === PERSISTENT_GOOGLE_FLOW_PROJECT_PER_SLOT_POLICY, "provider_locks.google_flow_worker_session_policy");
    compare(locks.google_gemini_worker_session_policy === PERSISTENT_BROWSER_TAB_PER_SLOT_POLICY, "provider_locks.google_gemini_worker_session_policy");
  }
  compare(gemini.plan_label === locks.google_gemini_plan_label, "provider_locks.google_gemini_plan_label");
  compare(gemini.model_label === locks.google_gemini_model_label, "provider_locks.google_gemini_model_label");
  try {
    const proof = await loadGoogleFlowHealthProof(flow.health_proof_path, {
      expectedSha256: flow.health_proof_sha256,
      expectedPlan: flow.plan_label,
      expectedModel: flow.model_label,
    });
    compare(locks.google_flow_health_proof_sha256 === proof.sha256, "provider_locks.google_flow_health_proof_sha256");
  } catch (error) {
    findings.push(`google_flow_health_proof:${error instanceof Error ? error.message : String(error)}`);
  }
  return findings.length
    ? { done: false, evidence: `Federated image identity missing/stale: ${findings.join(", ")}`, findings }
    : {
        done: true,
        evidence: legacyV1
          ? `legacy federated image pool locked: Flow ${HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY} + Gemini ${GOOGLE_GEMINI_IMAGE_CONCURRENCY} + GPT Image ${HYBRID_CHATGPT_IMAGE_CONCURRENCY}`
          : legacyV2
            ? `legacy federated image pool locked: Flow ${HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY} + Gemini ${GOOGLE_GEMINI_IMAGE_CONCURRENCY}; fresh browser workspaces; GPT Image exact-ID fallback only`
            : `federated persistent-worker image pool locked: Flow ${flowConcurrency} projects + Gemini ${geminiConcurrency} tabs; GPT Image exact-ID fallback only`,
      };
}

export function federatedWebImageAutomaticChatGptEnabled(identity = {}) {
  if (!isFederatedWebImageProvider(identity.image_provider)) return false;
  const options = identity.image_provider_options ?? {};
  return [options.reference_provider_pool, options.scene_provider_pool]
    .some((pool) => Array.isArray(pool) && pool.includes(CHATGPT_WEB_IMAGE_PROVIDER));
}

export function federatedWebImageConcurrencyForIdentity(identity = {}, {
  flowConcurrency,
} = {}) {
  if (!isFederatedWebImageProvider(identity.image_provider)) return null;
  const scheduling = googleImageSchedulingForIdentity(identity);
  return Math.min(scheduling?.total_concurrency ?? Infinity,
    Number(flowConcurrency ?? scheduling?.google_flow_concurrency ?? HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY)
      + (scheduling?.google_gemini_concurrency ?? GOOGLE_GEMINI_IMAGE_CONCURRENCY)
    + (federatedWebImageAutomaticChatGptEnabled(identity) ? HYBRID_CHATGPT_IMAGE_CONCURRENCY : 0)
  );
}

export async function loadGoogleFlowHealthProof(filePath = DEFAULT_GOOGLE_FLOW_HEALTH_PROOF_PATH, {
  expectedSha256 = null,
  expectedPlan = DEFAULT_GOOGLE_FLOW_PLAN,
  expectedModel = DEFAULT_GOOGLE_FLOW_MODEL,
} = {}) {
  const resolved = path.resolve(filePath);
  const bytes = await fs.readFile(resolved).catch(() => null);
  if (!bytes) throw new Error(`Missing Google Flow health proof: ${resolved}`);
  const currentSha256 = sha256(bytes);
  if (expectedSha256 && currentSha256 !== expectedSha256) {
    throw new Error(`Google Flow health-proof SHA-256 mismatch: expected ${expectedSha256}, found ${currentSha256}.`);
  }
  let proof;
  try {
    proof = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid Google Flow health-proof JSON at ${resolved}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const blockers = [];
  if (proof.schema !== "goldflow_google_flow_health_proof_v1") blockers.push("schema");
  if (proof.status !== "passed") blockers.push("status");
  if (proof.provider !== GOOGLE_FLOW_BROWSER_PROVIDER) blockers.push("provider");
  if (proof.account_plan !== expectedPlan) blockers.push("account_plan");
  if (proof.model_label !== expectedModel) blockers.push("model_label");
  if (Number(proof.safe_concurrency) < HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY) blockers.push("safe_concurrency");
  if (proof.routing_decision !== HYBRID_WEB_FLOW_ROUTING_POLICY) blockers.push("routing_decision");
  const binding = proof.reference_binding_evidence ?? {};
  if (binding.status !== "passed") blockers.push("reference_binding_evidence.status");
  if (binding.binding_schema !== GOOGLE_FLOW_REFERENCE_BINDING_SCHEMA) blockers.push("reference_binding_evidence.binding_schema");
  if (binding.require_verified_reference_binding !== true) blockers.push("reference_binding_evidence.require_verified_reference_binding");
  const liveCounts = new Set((binding.live_verified_reference_counts ?? []).map(Number));
  for (const count of REQUIRED_LIVE_REFERENCE_COUNTS) {
    if (!liveCounts.has(count)) blockers.push(`reference_binding_evidence.live_verified_reference_counts:${count}`);
  }
  if (binding.zero_reference_contract_tested !== true) blockers.push("reference_binding_evidence.zero_reference_contract_tested");
  const policy = proof.policy ?? {};
  if (policy.fresh_project_per_job !== true) blockers.push("policy.fresh_project_per_job");
  if (policy.one_creative_submission_per_item !== true) blockers.push("policy.one_creative_submission_per_item");
  if (policy.automatic_retry_policy !== "none") blockers.push("policy.automatic_retry_policy");
  if (policy.reference_echo_rejection_required !== true) blockers.push("policy.reference_echo_rejection_required");
  if (policy.style_reference_provider !== CHATGPT_WEB_IMAGE_PROVIDER) blockers.push("policy.style_reference_provider");
  if (!exactArray(policy.shared_pool_providers, [CHATGPT_WEB_IMAGE_PROVIDER, GOOGLE_FLOW_IMAGE_PROVIDER])) {
    blockers.push("policy.shared_pool_providers");
  }
  if (blockers.length) {
    throw new Error(`Google Flow health proof is not production-compatible: ${blockers.join(", ")}.`);
  }
  return {
    path: resolved,
    sha256: currentSha256,
    proof,
  };
}

export function hybridWebFlowIdentityOptions({
  chatGptProjectUrl = null,
  flowPlan = DEFAULT_GOOGLE_FLOW_PLAN,
  flowModel = DEFAULT_GOOGLE_FLOW_MODEL,
  healthProof,
} = {}) {
  if (!healthProof?.path || !SHA256_PATTERN.test(String(healthProof?.sha256 ?? ""))) {
    throw new Error("Hybrid Web/Flow identity options require a hash-bound Google Flow health proof.");
  }
  return {
    routing_policy: HYBRID_WEB_FLOW_ROUTING_POLICY,
    style_reference_provider: CHATGPT_WEB_IMAGE_PROVIDER,
    reference_provider_pool: [CHATGPT_WEB_IMAGE_PROVIDER, GOOGLE_FLOW_IMAGE_PROVIDER],
    scene_provider_pool: [CHATGPT_WEB_IMAGE_PROVIDER, GOOGLE_FLOW_IMAGE_PROVIDER],
    assignment_policy: HYBRID_WEB_FLOW_ASSIGNMENT_POLICY,
    chatgpt_project_url: chatGptProjectUrl,
    chatgpt_web: {
      concurrency: HYBRID_CHATGPT_IMAGE_CONCURRENCY,
    },
    google_flow: {
      concurrency: HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY,
      plan_label: flowPlan,
      model_label: flowModel,
      project_policy: "fresh_project_per_job",
      reference_binding_schema: GOOGLE_FLOW_REFERENCE_BINDING_SCHEMA,
      require_verified_reference_binding: true,
      health_proof_path: healthProof.path,
      health_proof_sha256: healthProof.sha256,
    },
  };
}

export function hybridWebFlowProviderLocks(options, { flowModel = DEFAULT_GOOGLE_FLOW_MODEL } = {}) {
  return {
    image_provider: HYBRID_WEB_FLOW_PROVIDER,
    image_routing_policy: HYBRID_WEB_FLOW_ROUTING_POLICY,
    image_assignment_policy: HYBRID_WEB_FLOW_ASSIGNMENT_POLICY,
    style_reference_provider: CHATGPT_WEB_IMAGE_PROVIDER,
    reference_provider_pool: [CHATGPT_WEB_IMAGE_PROVIDER, GOOGLE_FLOW_IMAGE_PROVIDER],
    scene_provider_pool: [CHATGPT_WEB_IMAGE_PROVIDER, GOOGLE_FLOW_IMAGE_PROVIDER],
    chatgpt_web_image_concurrency: HYBRID_CHATGPT_IMAGE_CONCURRENCY,
    google_flow_image_concurrency: HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY,
    hybrid_web_flow_image_concurrency: HYBRID_TOTAL_IMAGE_CONCURRENCY,
    creative_submission_attempts: 1,
    image_automatic_retry_policy: "none",
    image_automatic_provider_failover_policy: "none",
    style_reference_barrier: true,
    google_flow_plan_label: options?.google_flow?.plan_label ?? DEFAULT_GOOGLE_FLOW_PLAN,
    google_flow_model_label: options?.google_flow?.model_label ?? flowModel,
    google_flow_project_policy: "fresh_project_per_job",
    google_flow_reference_binding_schema: GOOGLE_FLOW_REFERENCE_BINDING_SCHEMA,
    google_flow_reference_binding_required: true,
    google_flow_health_proof_path: options?.google_flow?.health_proof_path ?? null,
    google_flow_health_proof_sha256: options?.google_flow?.health_proof_sha256 ?? null,
    image_provider_models: hybridWebFlowProviderModels({ flowModel }),
  };
}

export async function hybridWebFlowIdentityStatus(identity = {}) {
  if (!isHybridWebFlowProvider(identity.image_provider)) {
    return { done: true, evidence: `image provider=${identity.image_provider ?? "legacy/default"}` };
  }
  const findings = [];
  const options = identity.image_provider_options ?? {};
  const locks = identity.provider_locks ?? {};
  const flow = options.google_flow ?? {};
  const modelMap = hybridWebFlowProviderModels({ flowModel: flow.model_label ?? DEFAULT_GOOGLE_FLOW_MODEL });
  const compare = (condition, field) => { if (!condition) findings.push(field); };
  compare(options.routing_policy === HYBRID_WEB_FLOW_ROUTING_POLICY, "image_provider_options.routing_policy");
  compare(options.style_reference_provider === CHATGPT_WEB_IMAGE_PROVIDER, "image_provider_options.style_reference_provider");
  compare(exactArray(options.reference_provider_pool, [CHATGPT_WEB_IMAGE_PROVIDER, GOOGLE_FLOW_IMAGE_PROVIDER]), "image_provider_options.reference_provider_pool");
  compare(exactArray(options.scene_provider_pool, [CHATGPT_WEB_IMAGE_PROVIDER, GOOGLE_FLOW_IMAGE_PROVIDER]), "image_provider_options.scene_provider_pool");
  compare(options.assignment_policy === HYBRID_WEB_FLOW_ASSIGNMENT_POLICY, "image_provider_options.assignment_policy");
  compare(Number(options.chatgpt_web?.concurrency) === HYBRID_CHATGPT_IMAGE_CONCURRENCY, "image_provider_options.chatgpt_web.concurrency");
  compare(Number(flow.concurrency) === HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY, "image_provider_options.google_flow.concurrency");
  compare(flow.project_policy === "fresh_project_per_job", "image_provider_options.google_flow.project_policy");
  compare(flow.reference_binding_schema === GOOGLE_FLOW_REFERENCE_BINDING_SCHEMA, "image_provider_options.google_flow.reference_binding_schema");
  compare(flow.require_verified_reference_binding === true, "image_provider_options.google_flow.require_verified_reference_binding");
  compare(locks.image_provider === HYBRID_WEB_FLOW_PROVIDER, "provider_locks.image_provider");
  compare(locks.image_routing_policy === HYBRID_WEB_FLOW_ROUTING_POLICY, "provider_locks.image_routing_policy");
  compare(locks.image_assignment_policy === HYBRID_WEB_FLOW_ASSIGNMENT_POLICY, "provider_locks.image_assignment_policy");
  compare(locks.style_reference_provider === CHATGPT_WEB_IMAGE_PROVIDER, "provider_locks.style_reference_provider");
  compare(exactArray(locks.reference_provider_pool, [CHATGPT_WEB_IMAGE_PROVIDER, GOOGLE_FLOW_IMAGE_PROVIDER]), "provider_locks.reference_provider_pool");
  compare(exactArray(locks.scene_provider_pool, [CHATGPT_WEB_IMAGE_PROVIDER, GOOGLE_FLOW_IMAGE_PROVIDER]), "provider_locks.scene_provider_pool");
  compare(Number(locks.chatgpt_web_image_concurrency) === HYBRID_CHATGPT_IMAGE_CONCURRENCY, "provider_locks.chatgpt_web_image_concurrency");
  compare(Number(locks.google_flow_image_concurrency) === HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY, "provider_locks.google_flow_image_concurrency");
  compare(Number(locks.hybrid_web_flow_image_concurrency) === HYBRID_TOTAL_IMAGE_CONCURRENCY, "provider_locks.hybrid_web_flow_image_concurrency");
  compare(Number(locks.creative_submission_attempts) === 1, "provider_locks.creative_submission_attempts");
  compare(locks.image_automatic_retry_policy === "none", "provider_locks.image_automatic_retry_policy");
  compare(locks.image_automatic_provider_failover_policy === "none", "provider_locks.image_automatic_provider_failover_policy");
  compare(locks.style_reference_barrier === true, "provider_locks.style_reference_barrier");
  compare(locks.google_flow_plan_label === flow.plan_label, "provider_locks.google_flow_plan_label");
  compare(locks.google_flow_model_label === flow.model_label, "provider_locks.google_flow_model_label");
  compare(locks.google_flow_project_policy === flow.project_policy, "provider_locks.google_flow_project_policy");
  compare(locks.google_flow_reference_binding_schema === flow.reference_binding_schema, "provider_locks.google_flow_reference_binding_schema");
  compare(locks.google_flow_reference_binding_required === flow.require_verified_reference_binding, "provider_locks.google_flow_reference_binding_required");
  compare(JSON.stringify(locks.image_provider_models ?? null) === JSON.stringify(modelMap), "provider_locks.image_provider_models");
  compare(JSON.stringify(identity.model_versions?.image_provider_models ?? null) === JSON.stringify(modelMap), "model_versions.image_provider_models");
  try {
    const healthProof = await loadGoogleFlowHealthProof(flow.health_proof_path, {
      expectedSha256: flow.health_proof_sha256,
      expectedPlan: flow.plan_label,
      expectedModel: flow.model_label,
    });
    compare(locks.google_flow_health_proof_path === healthProof.path, "provider_locks.google_flow_health_proof_path");
    compare(locks.google_flow_health_proof_sha256 === healthProof.sha256, "provider_locks.google_flow_health_proof_sha256");
  } catch (error) {
    findings.push(`google_flow_health_proof:${error instanceof Error ? error.message : String(error)}`);
  }
  return findings.length
    ? { done: false, evidence: `hybrid image identity missing/stale: ${findings.join(", ")}`, findings }
    : { done: true, evidence: `hybrid image pool locked: ChatGPT style; shared ChatGPT ${HYBRID_CHATGPT_IMAGE_CONCURRENCY} + Flow ${HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY}; one submission; verified Flow binding` };
}
