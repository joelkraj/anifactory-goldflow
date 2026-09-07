import { createHash } from "node:crypto";

// Kept here so workflow identity and the generated-visuals registry share one version.
// Do not import the registry or content-profile helpers: both consume this contract.
export const GENERATED_VISUALS_STAGE_REGISTRY_VERSION = "2026-08-22.1";
export const MEDIA_WORKFLOW_CONTRACT_SCHEMA = "goldflow_media_workflow_v1";
export const GENERATED_VISUALS_WORKFLOW_VERSION = "2026-09-06.1";
export const AVATAR_PILOT_WORKFLOW_ID = "avatar_footage_pilot_v1";
export const AVATAR_PILOT_PROFILE_ID = "mcu_what_if_pilot_v1";
export const AVATAR_PILOT_VERSION = "2026-09-06.1";

const GENERATED_WORKFLOW_ID = "generated_visuals_v1";
const RESERVED_WORKFLOW_ID = "source_footage_v1";
const RESERVED_CONTENT_PROFILE_ID = "movie_tv_commentary_v1";
const contractKeys = ["schema", "id", "version", "stage_registry_version", "sha256"];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedReservedId(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function assertEditorialProfileId(value) {
  const id = normalizedReservedId(value);
  if (id === RESERVED_CONTENT_PROFILE_ID) {
    throw new Error(`Content profile ${RESERVED_CONTENT_PROFILE_ID} is reserved and unavailable; movie/TV commentary planning is not implemented.`);
  }
  if (id === RESERVED_WORKFLOW_ID) {
    throw new Error(`${RESERVED_WORKFLOW_ID} is a reserved, unavailable media workflow, not an executable content profile.`);
  }
}

function assertWorkflowId(id) {
  if (id === RESERVED_WORKFLOW_ID || normalizedReservedId(id) === RESERVED_WORKFLOW_ID) {
    throw new Error(`Media workflow ${RESERVED_WORKFLOW_ID} is reserved and unavailable; it has no executable stage registry. The standalone footage tools do not create a production workflow.`);
  }
  if (![GENERATED_WORKFLOW_ID, AVATAR_PILOT_WORKFLOW_ID].includes(id)) {
    throw new Error(`Unknown media workflow ${String(id)}. Available workflows: ${GENERATED_WORKFLOW_ID}, ${AVATAR_PILOT_WORKFLOW_ID} (90-second proof only).`);
  }
}

function currentContract(id = GENERATED_WORKFLOW_ID) {
  // Fixed key order is the canonical serialization; sha256 is never part of its payload.
  const payload = {
    schema: MEDIA_WORKFLOW_CONTRACT_SCHEMA,
    id,
    version: id === AVATAR_PILOT_WORKFLOW_ID ? AVATAR_PILOT_VERSION : GENERATED_VISUALS_WORKFLOW_VERSION,
    stage_registry_version: id === AVATAR_PILOT_WORKFLOW_ID ? AVATAR_PILOT_VERSION : GENERATED_VISUALS_STAGE_REGISTRY_VERSION,
  };
  return {
    ...payload,
    sha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  };
}

function assertExplicitProfileConsistency(identity) {
  const hasProfile = Object.hasOwn(identity, "content_profile");
  const hasConfig = Object.hasOwn(identity, "content_profile_config");
  if (hasProfile) {
    if (typeof identity.content_profile !== "string" || !identity.content_profile.trim()) {
      throw new Error("Explicit workflow identity has an invalid content_profile.");
    }
    assertEditorialProfileId(identity.content_profile);
  }
  if (hasConfig) {
    if (!isRecord(identity.content_profile_config)
      || typeof identity.content_profile_config.id !== "string"
      || !identity.content_profile_config.id.trim()) {
      throw new Error("Explicit workflow identity has an invalid content_profile_config.id.");
    }
    assertEditorialProfileId(identity.content_profile_config.id);
  }
  if (hasProfile && hasConfig && identity.content_profile !== identity.content_profile_config.id) {
    throw new Error("Workflow identity content_profile conflicts with its embedded content_profile_config.id; existing identities must not be reinterpreted or migrated implicitly.");
  }
}

/** Resolve an immutable run identity. Old identities receive only an in-memory adapter. */
export function resolveMediaWorkflow(identity = {}) {
  if (!isRecord(identity)) throw new Error("Media workflow resolution requires a run identity object.");
  const hasWorkflow = Object.hasOwn(identity, "media_workflow");
  const hasContract = Object.hasOwn(identity, "workflow_contract");
  if (!hasWorkflow && !hasContract) {
    if ([identity.content_profile, identity.content_profile_config?.id].includes(AVATAR_PILOT_PROFILE_ID)) {
      throw new Error("Avatar pilot requires its explicit proof workflow; no legacy generated adapter is available.");
    }
    // Reserved future IDs never described a supported historical profile. Omitting
    // workflow fields must not turn a future movie/footage profile into this adapter.
    assertEditorialProfileId(identity.content_profile);
    assertEditorialProfileId(identity.content_profile_config?.id);
    // Do not validate/reload old editorial profiles or compare their historical registry
    // marker here. Their embedded config and original hashes remain authoritative.
    return { ...currentContract(), legacy: true, available: true };
  }
  if (hasWorkflow) assertWorkflowId(identity.media_workflow);
  if (!hasWorkflow || !hasContract) {
    throw new Error("Incomplete media workflow identity: media_workflow and workflow_contract must both be present. Existing identities cannot be partially migrated.");
  }
  const contract = identity.workflow_contract;
  if (!isRecord(contract)
    || Object.keys(contract).length !== contractKeys.length
    || contractKeys.some((key) => !Object.hasOwn(contract, key))) {
    throw new Error("Invalid workflow_contract: expected exactly schema, id, version, stage_registry_version, and sha256.");
  }
  if (contract.id !== identity.media_workflow) {
    throw new Error("Workflow identity media_workflow conflicts with workflow_contract.id.");
  }
  const expected = currentContract(identity.media_workflow);
  for (const key of contractKeys.filter((key) => key !== "sha256")) {
    if (contract[key] !== expected[key]) {
      throw new Error(`Unsupported or stale workflow_contract ${key}; expected ${expected[key]}. Existing identities must not be migrated implicitly.`);
    }
  }
  if (typeof contract.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(contract.sha256)
    || contract.sha256 !== expected.sha256) {
    throw new Error("Invalid workflow_contract sha256: the canonical workflow contract hash does not match.");
  }
  if (Object.hasOwn(identity, "stage_registry_version")
    && identity.stage_registry_version !== contract.stage_registry_version) {
    throw new Error("Workflow identity stage_registry_version conflicts with its workflow_contract.stage_registry_version.");
  }
  assertExplicitProfileConsistency(identity);
  const profile = identity.content_profile_config?.id ?? identity.content_profile;
  if ((identity.media_workflow === AVATAR_PILOT_WORKFLOW_ID) !== (profile === AVATAR_PILOT_PROFILE_ID)) {
    throw new Error("Avatar pilot workflow and mcu_what_if_pilot_v1 must be selected together.");
  }
  return { ...expected, legacy: false, available: true };
}

export function assertAvailableMediaWorkflow(identity = {}) {
  // Reserved workflows are deliberately rejected during resolution, before any guard
  // bypass or legacy generated-visuals routing could treat them as executable.
  return resolveMediaWorkflow(identity);
}

/** The caller still resolves/validates the editorial profile ID or custom JSON file. */
export function mediaWorkflowForPreflight({ contentProfile, mediaWorkflow } = {}) {
  if (typeof contentProfile !== "string" || !contentProfile.trim()) {
    throw new Error("Missing required --content-profile. New preflights must explicitly select editorial guidance.");
  }
  if (typeof mediaWorkflow !== "string" || !mediaWorkflow.trim()) {
    throw new Error("Missing required --media-workflow. New preflights must explicitly select an executable media workflow.");
  }
  assertEditorialProfileId(contentProfile);
  assertWorkflowId(mediaWorkflow);
  if ((mediaWorkflow === AVATAR_PILOT_WORKFLOW_ID) !== (contentProfile === AVATAR_PILOT_PROFILE_ID)) {
    throw new Error("Avatar pilot preflight requires the exact pilot workflow/profile pair.");
  }
  return { media_workflow: mediaWorkflow, workflow_contract: currentContract(mediaWorkflow) };
}
