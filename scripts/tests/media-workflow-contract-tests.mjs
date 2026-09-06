import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contentProfileDefinition } from "../lib/content-profiles.mjs";
import {
  assertAvailableMediaWorkflow,
  GENERATED_VISUALS_STAGE_REGISTRY_VERSION,
  GENERATED_VISUALS_WORKFLOW_VERSION,
  MEDIA_WORKFLOW_CONTRACT_SCHEMA,
  mediaWorkflowForPreflight,
  resolveMediaWorkflow,
} from "../lib/media-workflows.mjs";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const binding = (contentProfile = "manhwa_recap_v1") => mediaWorkflowForPreflight({
  contentProfile,
  mediaWorkflow: "generated_visuals_v1",
});
const explicitIdentity = (profileId = "manhwa_recap_v1") => ({
  schema: "goldflow_run_identity_v2",
  ...binding(profileId),
  stage_registry_version: GENERATED_VISUALS_STAGE_REGISTRY_VERSION,
  content_profile: profileId,
  content_profile_config: contentProfileDefinition(profileId).config,
});

test("both existing editorial profiles bind the same generated-visuals workflow", () => {
  for (const profileId of ["manhwa_recap_v1", "asset_afterlife_v1"]) {
    const identity = explicitIdentity(profileId);
    const before = JSON.stringify(identity);
    const resolved = assertAvailableMediaWorkflow(identity);
    assert.equal(resolved.id, "generated_visuals_v1");
    assert.equal(resolved.version, GENERATED_VISUALS_WORKFLOW_VERSION);
    assert.equal(resolved.stage_registry_version, "2026-08-22.1");
    assert.equal(resolved.available, true);
    assert.equal(resolved.legacy, false);
    assert.equal(JSON.stringify(identity), before);
  }
  assert.deepEqual(binding("manhwa_recap_v1"), binding("asset_afterlife_v1"));
});

test("workflow hash uses only the fixed-order canonical payload, never its own hash", () => {
  const { workflow_contract: contract } = binding();
  assert.deepEqual(Object.keys(contract), ["schema", "id", "version", "stage_registry_version", "sha256"]);
  assert.equal(contract.schema, MEDIA_WORKFLOW_CONTRACT_SCHEMA);
  assert.equal(contract.sha256, digest({
    schema: MEDIA_WORKFLOW_CONTRACT_SCHEMA,
    id: "generated_visuals_v1",
    version: GENERATED_VISUALS_WORKFLOW_VERSION,
    stage_registry_version: GENERATED_VISUALS_STAGE_REGISTRY_VERSION,
  }));
  assert.notEqual(contract.sha256, digest(contract));
  // JSON property order in an existing identity does not alter the contract meaning.
  assert.equal(resolveMediaWorkflow({
    media_workflow: "generated_visuals_v1",
    workflow_contract: Object.fromEntries(Object.entries(contract).reverse()),
  }).sha256, contract.sha256);
});

test("workflow results are detached and cannot change later bindings", () => {
  const first = binding();
  first.workflow_contract.version = "tampered";
  assert.equal(binding().workflow_contract.version, GENERATED_VISUALS_WORKFLOW_VERSION);
  const result = resolveMediaWorkflow(binding());
  result.sha256 = "tampered";
  assert.match(resolveMediaWorkflow(binding()).sha256, /^[a-f0-9]{64}$/);
});

test("identities with neither workflow field use a read-only legacy adapter", () => {
  for (const identity of [
    {},
    { schema: "goldflow_run_identity_v1", channel: "fixture" },
    { schema: "goldflow_run_identity_v2", stage_registry_version: "historical-registry-version" },
    { content_profile: "manhwa_recap_v1", content_profile_config: contentProfileDefinition("manhwa_recap_v1").config },
    { content_profile: "asset_afterlife_v1", content_profile_config: contentProfileDefinition("asset_afterlife_v1").config },
  ]) {
    const before = JSON.stringify(identity);
    const hashBefore = digest(identity);
    Object.freeze(identity);
    const result = assertAvailableMediaWorkflow(identity);
    assert.equal(result.id, "generated_visuals_v1");
    assert.equal(result.legacy, true);
    assert.equal(result.available, true);
    assert.equal(JSON.stringify(identity), before);
    assert.equal(digest(identity), hashBefore);
    assert.equal(Object.hasOwn(identity, "media_workflow"), false);
    assert.equal(Object.hasOwn(identity, "workflow_contract"), false);
  }
  assert.equal(resolveMediaWorkflow().legacy, true);
});

test("legacy embedded profile truth is not replaced with current defaults or revalidated", () => {
  const historical = {
    content_profile: "old_custom_profile",
    content_profile_config: { id: "historical_embedded_profile", version: "archived", historical_only: true },
    stage_registry_version: "archived-registry",
  };
  const before = JSON.stringify(historical);
  assert.equal(resolveMediaWorkflow(historical).legacy, true);
  assert.equal(JSON.stringify(historical), before);
});

test("new preflight requires explicit nonblank editorial and workflow flags", () => {
  for (const missing of [undefined, null, "", "  ", true, false]) {
    assert.throws(() => mediaWorkflowForPreflight({ contentProfile: missing, mediaWorkflow: "generated_visuals_v1" }), /required --content-profile/);
    assert.throws(() => mediaWorkflowForPreflight({ contentProfile: "manhwa_recap_v1", mediaWorkflow: missing }), /required --media-workflow/);
  }
  assert.throws(() => mediaWorkflowForPreflight(), /required --content-profile/);
});

test("profile aliases and custom paths remain caller-resolved editorial choices", () => {
  for (const profile of ["manhwa", "asset-afterlife", "/fixture/custom-profile.json"]) {
    assert.equal(binding(profile).media_workflow, "generated_visuals_v1");
  }
  const identity = {
    ...binding("/fixture/custom-profile.json"),
    content_profile: "custom_documentary_v1",
    content_profile_config: { id: "custom_documentary_v1", version: "locked-historical-config" },
  };
  assert.equal(resolveMediaWorkflow(identity).legacy, false);
});

test("reserved source footage cannot become a preflight or persisted executable route", () => {
  for (const id of ["source_footage_v1", "source-footage-v1", "SOURCE_FOOTAGE_V1"]) {
    assert.throws(() => mediaWorkflowForPreflight({ contentProfile: "manhwa_recap_v1", mediaWorkflow: id }), /reserved and unavailable/);
    assert.throws(() => resolveMediaWorkflow({ ...binding(), media_workflow: id }), /reserved and unavailable/);
    assert.throws(() => assertAvailableMediaWorkflow({ media_workflow: id, workflow_bypass: true }), /reserved and unavailable/);
  }
});

test("movie commentary and source footage IDs cannot masquerade as editorial profiles", () => {
  for (const id of ["movie_tv_commentary_v1", "movie-tv-commentary-v1", "source_footage_v1"]) {
    assert.throws(() => binding(id), /reserved.*unavailable/);
    assert.throws(() => resolveMediaWorkflow({ ...binding(), content_profile: id }), /reserved.*unavailable/);
    assert.throws(() => resolveMediaWorkflow({ ...binding(), content_profile_config: { id } }), /reserved.*unavailable/);
    assert.throws(() => resolveMediaWorkflow({ content_profile: id }), /reserved.*unavailable/);
    assert.throws(() => resolveMediaWorkflow({ content_profile_config: { id } }), /reserved.*unavailable/);
  }
});

test("unknown workflow IDs fail closed even when bypass flags are present", () => {
  for (const id of ["unknown_v1", "generated_visuals_v2", "manhwa_recap_v1", "generated_visuals_v1 ", ""]) {
    assert.throws(() => resolveMediaWorkflow({ ...binding(), media_workflow: id, workflow_bypass: true }), /Unknown media workflow/);
    if (id) assert.throws(() => mediaWorkflowForPreflight({ contentProfile: "manhwa_recap_v1", mediaWorkflow: id }), /Unknown media workflow/);
  }
});

test("partial workflow migration is never interpreted as legacy", () => {
  assert.throws(() => resolveMediaWorkflow({ media_workflow: "generated_visuals_v1" }), /Incomplete media workflow identity/);
  assert.throws(() => resolveMediaWorkflow({ workflow_contract: binding().workflow_contract }), /Incomplete media workflow identity/);
  assert.throws(() => resolveMediaWorkflow({ workflow_contract: undefined }), /Incomplete media workflow identity/);
  assert.throws(() => resolveMediaWorkflow({ media_workflow: undefined }), /Unknown media workflow/);
  assert.throws(() => resolveMediaWorkflow({ media_workflow: null, workflow_contract: null }), /Unknown media workflow/);
});

test("malformed contract and unexpected payload fields fail closed", () => {
  for (const contract of [null, undefined, [], "generated_visuals_v1", {}, { ...binding().workflow_contract, extra: true }]) {
    assert.throws(() => resolveMediaWorkflow({ ...binding(), workflow_contract: contract }), /Invalid workflow_contract/);
  }
  for (const key of Object.keys(binding().workflow_contract)) {
    const identity = binding();
    delete identity.workflow_contract[key];
    assert.throws(() => resolveMediaWorkflow(identity), /Invalid workflow_contract/);
  }
});

test("contradictory workflow identifiers fail closed", () => {
  for (const id of ["source_footage_v1", "other_v1", null, 1]) {
    const identity = binding();
    identity.workflow_contract.id = id;
    assert.throws(() => resolveMediaWorkflow(identity), /conflicts with workflow_contract.id/);
  }
});

test("stale contract schema, workflow version, and registry version remain unsupported even if rehashed", () => {
  for (const key of ["schema", "version", "stage_registry_version"]) {
    const identity = binding();
    identity.workflow_contract[key] = "future-or-historical-value";
    const { sha256: _sha, ...payload } = identity.workflow_contract;
    identity.workflow_contract.sha256 = digest(payload);
    assert.throws(() => resolveMediaWorkflow(identity), /Unsupported or stale workflow_contract/);
  }
});

test("hash tampering and malformed hashes fail closed", () => {
  for (const hash of ["0".repeat(64), binding().workflow_contract.sha256.toUpperCase(), null, 0, "", "a".repeat(63)]) {
    const identity = binding();
    identity.workflow_contract.sha256 = hash;
    assert.throws(() => resolveMediaWorkflow(identity), /Invalid workflow_contract sha256/);
  }
});

test("explicit top-level registry marker must agree with the workflow lock", () => {
  for (const version of ["old-version", null, undefined, ""]) {
    assert.throws(() => resolveMediaWorkflow({ ...binding(), stage_registry_version: version }), /stage_registry_version conflicts/);
  }
  assert.equal(resolveMediaWorkflow({ ...binding(), stage_registry_version: GENERATED_VISUALS_STAGE_REGISTRY_VERSION }).legacy, false);
});

test("explicit profile/config contradictions or malformed embedded IDs fail closed", () => {
  assert.throws(() => resolveMediaWorkflow({ ...binding(), content_profile: "manhwa_recap_v1", content_profile_config: { id: "asset_afterlife_v1" } }), /content_profile conflicts/);
  for (const profile of ["", " ", null, undefined, 1]) {
    assert.throws(() => resolveMediaWorkflow({ ...binding(), content_profile: profile }), /invalid content_profile/);
  }
  for (const config of [null, undefined, [], {}, { id: "" }, { id: " " }, { id: 1 }]) {
    assert.throws(() => resolveMediaWorkflow({ ...binding(), content_profile_config: config }), /invalid content_profile_config.id/);
  }
});

test("invalid identity containers fail closed", () => {
  for (const identity of [null, [], "generated_visuals_v1", 0, false]) {
    assert.throws(() => resolveMediaWorkflow(identity), /requires a run identity object/);
  }
});

export async function runMediaWorkflowContractTests() {
  for (const [name, fn] of tests) {
    try { await fn(); } catch (error) {
      error.message = `${name}: ${error.message}`;
      throw error;
    }
  }
  return { passed: tests.length };
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const result = await runMediaWorkflowContractTests();
  console.log(`Media workflow contract tests passed (${result.passed}).`);
}
