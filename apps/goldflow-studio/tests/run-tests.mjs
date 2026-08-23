#!/usr/bin/env node

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";

import {
  chatGptWebRouteEnabled,
  codexRuntimeSummary,
  isCodexCacheCompatible,
  readCodexCallMetadata,
  runCodexCli,
} from "../../../scripts/lib/codex-cli-runner.mjs";
import {
  createCodexWorkManifest,
  leaseNextWorkItem,
  sha256File,
} from "../../../scripts/lib/codex-image-work-contract.mjs";
import {
  FEDERATED_TOTAL_IMAGE_CONCURRENCY,
  FEDERATED_WEB_IMAGE_PROVIDER,
  FRESH_BROWSER_SESSION_PER_JOB_POLICY,
  FRESH_GOOGLE_FLOW_PROJECT_PER_JOB_POLICY,
  GOOGLE_FLOW_BROWSER_PROVIDER,
  GOOGLE_GEMINI_BROWSER_PROVIDER,
  GOOGLE_GEMINI_IMAGE_CONCURRENCY,
  HYBRID_CHATGPT_IMAGE_CONCURRENCY,
  HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY,
  HYBRID_TOTAL_IMAGE_CONCURRENCY,
  HYBRID_WEB_FLOW_PROVIDER,
  PERSISTENT_BROWSER_TAB_PER_SLOT_POLICY,
  PERSISTENT_GOOGLE_FLOW_PROJECT_PER_SLOT_POLICY,
} from "../../../scripts/lib/image-provider-policy.mjs";
import {
  assertHostRuntime,
  chatGptImageFailureDisposition,
  hybridManifestDispatchOptions,
  materializedReferenceState,
  resolveManualProviderAuthRecoveryEvidence,
  validateFlowRuntimeConcurrency,
  validateRepairSharedReferenceScope,
} from "../../../scripts/hybrid-browser-image-pool.mjs";
import { loginMarkerExists, loginVerificationMarkerPath, markLoginVerified } from "../desktop/browser-login.mjs";
import { chatGptModelControlMatches, ChatGptBrowser } from "../desktop/chatgpt-browser.mjs";
import {
  assertDesktopConfig,
  desktopConfig,
  GOOGLE_FLOW_BROWSER_CONCURRENCY_CEILING,
  normalizeBrowserProvider,
  parseDesktopFlags,
  PRODUCTION_BROWSER_CONCURRENCY_CEILING,
} from "../desktop/config.mjs";
import { browserFailureDisposition, GoldflowDesktopHost } from "../desktop/worker-host.mjs";
import { flowBlockingCode, flowModelLabelMatches, flowReferenceUploadOrder, GoogleFlowBrowser, identifyAutoAttachedFlowComposerChip, identifyNewFlowComposerChip, isFlowProjectWorkspaceUrl, nearestFlowVideoDuration, normalizeFlowPromptText, redactBrowserDiagnostic, shouldRetryFlowPreSubmissionTransport, validateFlowReferenceDock } from "../desktop/google-flow-browser.mjs";
import { DesktopRuntimeState } from "../desktop/runtime-state.mjs";
import { validReferenceRoute } from "../desktop/worker-client.mjs";
import { GoldflowBridge, validateGoogleFlowReferenceBinding } from "../lib/goldflow-bridge.mjs";
import { chatGptEffortLabel, chatGptEffortSliderIndex, chatGptModelLabel, chatGptUiContractForLlmJob } from "../lib/chatgpt-ui-contract.mjs";
import { LlmJobStore } from "../lib/llm-job-store.mjs";
import {
  MediaJobStore,
  mediaCreativeIdentityForTests,
} from "../lib/media-job-store.mjs";
import { sha256, stableStringify } from "../lib/util.mjs";
import { createStudioServer, providerFailurePausesDispatch, studioServerOptionsFromFlags } from "../server.mjs";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-studio-tests-"));
const originalEnvironment = { ...process.env };

assert.equal(providerFailurePausesDispatch("content_policy_rejected"), false, "one asset rejection must not pause its provider queue");
assert.equal(providerFailurePausesDispatch("rate_limited"), false, "rate limits use the desktop worker's timed cooldown instead of an indefinite controller pause");
assert.equal(providerFailurePausesDispatch("ui_contract_mismatch"), true, "a provider UI-contract break must pause dispatch");
assert.equal(providerFailurePausesDispatch("google_gemini_generation_error"), false, "one transient Gemini failure must preserve its exact ID without stopping healthy unleased work");
assert.equal(providerFailurePausesDispatch("chatgpt_generation_error"), false, "one transient ChatGPT failure must preserve its exact ID without stopping healthy unleased work");
assert.equal(providerFailurePausesDispatch("provider_transient_circuit_open"), true, "the controller must stop a provider after its three-strike transient circuit opens");
assert.deepEqual(flowReferenceUploadOrder([{ slot: 4 }, { slot: 2 }, { slot: 1 }, { slot: 3 }]).map((row) => row.slot), [1, 2, 3, 4], "Flow must upload in canonical order because its composer appends newly added chips");
assert.equal(identifyNewFlowComposerChip([], [{ media_id: "composer-1" }]).media_id, "composer-1");
assert.equal(identifyNewFlowComposerChip(["composer-2"], [{ media_id: "composer-1" }, { media_id: "composer-2" }]).media_id, "composer-1");
assert.throws(() => identifyNewFlowComposerChip(["composer-1"], [{ media_id: "composer-1" }]), /added 0 new reference chips/);
assert.equal(identifyAutoAttachedFlowComposerChip([], { busy: false, chips: [{ media_id: "composer-1", loaded: true }] }).media_id, "composer-1");
assert.equal(identifyAutoAttachedFlowComposerChip(["composer-1"], { busy: false, chips: [{ media_id: "composer-1", loaded: true }, { media_id: "composer-2", loaded: true }] }).media_id, "composer-2");
assert.equal(identifyAutoAttachedFlowComposerChip(["composer-1"], { busy: true, chips: [{ media_id: "composer-1", loaded: true }, { media_id: "composer-2", loaded: true }] }), null);
assert.equal(identifyAutoAttachedFlowComposerChip(["composer-1"], { busy: false, chips: [{ media_id: "different", loaded: true }, { media_id: "composer-2", loaded: true }] }), null);
assert.equal(shouldRetryFlowPreSubmissionTransport({ errorCode: "ui_contract_mismatch", attempt: 1 }), true);
assert.equal(shouldRetryFlowPreSubmissionTransport({ errorCode: "provider_response_timeout", attempt: 1 }), true);
assert.equal(shouldRetryFlowPreSubmissionTransport({ errorCode: "ui_contract_mismatch", attempt: 2 }), false);
assert.equal(shouldRetryFlowPreSubmissionTransport({ errorCode: "ui_contract_mismatch", creativeSubmissionStarted: true, attempt: 1 }), false);
assert.equal(flowModelLabelMatches("Veo 3.1 - Fast arrow_drop_down", "Veo 3.1 Fast"), true);
assert.equal(flowModelLabelMatches("Veo 3.1 - Lite [Lower Priority]", "Veo 3.1 Lite"), false);
assert.equal(nearestFlowVideoDuration(5, [4, 6, 8]), 6);
assert.equal(nearestFlowVideoDuration(9, [4, 6, 8]), 8);
assert.equal(isFlowProjectWorkspaceUrl("https://labs.google/fx/tools/flow/project/worker-1"), true);
assert.equal(isFlowProjectWorkspaceUrl("https://labs.google/fx/tools/flow"), false);
assert.equal(shouldRetryFlowPreSubmissionTransport({ errorCode: "rate_limited", attempt: 1 }), false);
assert.equal(shouldRetryFlowPreSubmissionTransport({ errorName: "TimeoutError", errorMessage: "locator.click: Timeout 30000ms exceeded; element was detached from the DOM", attempt: 1 }), true);
assert.equal(shouldRetryFlowPreSubmissionTransport({ errorName: "TimeoutError", errorMessage: "locator.click: Timeout 30000ms exceeded; element was detached from the DOM", creativeSubmissionStarted: true, attempt: 1 }), false);
assert.equal(shouldRetryFlowPreSubmissionTransport({ errorName: "Error", errorMessage: "reference asset hash does not match", attempt: 1 }), false);
const redactedFlowDiagnostic = redactBrowserDiagnostic([
  "apiRequestContext.get: read ETIMEDOUT",
  "\u001b[2m    - cookie: __Secure-next-auth.session-token=SECRET; _ga=TRACKING; email=user@example.test\u001b[22m",
  "authorization: Bearer TOPSECRET",
  "GET https://example.test/image?X-Goog-Signature=SIGNED&key=PRIVATE",
].join("\n"));
assert.match(redactedFlowDiagnostic, /apiRequestContext\.get: read ETIMEDOUT/);
assert.doesNotMatch(redactedFlowDiagnostic, /SECRET|session-token|TOPSECRET|SIGNED|PRIVATE|TRACKING/);
const flowDownloadFallbackBrowser = new GoogleFlowBrowser();
const flowDownloadFallbackPage = {
  request: { get: async () => { throw new Error("simulated CDN timeout"); } },
  evaluate: async () => Buffer.from("page-session-fallback").toString("base64"),
};
assert.equal((await flowDownloadFallbackBrowser.imageBytes(flowDownloadFallbackPage, "https://example.test/image")).toString(), "page-session-fallback");
assert.equal((await flowDownloadFallbackBrowser.mediaBytes(flowDownloadFallbackPage, "https://example.test/video")).toString(), "page-session-fallback");
assert.deepEqual(browserFailureDisposition(Object.assign(new Error("requesting generations too quickly"), { code: "rate_limited" })), { kind: "rate_limit", pausesDispatch: true });
assert.deepEqual(browserFailureDisposition(new Error("Upload files element is not enabled")), { kind: "transport", pausesDispatch: true });
assert.deepEqual(browserFailureDisposition(Object.assign(new Error("Generation failed"), { code: "google_flow_generation_error" })), { kind: "transport", pausesDispatch: true });
assert.deepEqual(
  browserFailureDisposition(Object.assign(new Error("Timed out waiting for a completed ChatGPT response."), { code: "ui_contract_mismatch" })),
  { kind: "transport", pausesDispatch: true },
  "a completed-response timeout must be transient even when the browser encoded it as a UI-contract error",
);
assert.deepEqual(
  browserFailureDisposition(Object.assign(new Error("Expected model GPT-5.6; visible control was GPT-5.5."), { code: "ui_contract_mismatch" })),
  { kind: "ui_contract_mismatch", pausesDispatch: true },
  "a true model UI mismatch must remain fatal",
);
assert.deepEqual(
  browserFailureDisposition(Object.assign(new Error("Expected effort Pro; visible control was Medium."), { code: "ui_contract_mismatch" })),
  { kind: "ui_contract_mismatch", pausesDispatch: true },
  "a true effort UI mismatch must remain fatal",
);
assert.deepEqual(
  browserFailureDisposition(Object.assign(new Error("Signed into the wrong account."), { code: "account_mismatch" })),
  { kind: "account_mismatch", pausesDispatch: true },
  "an account mismatch must remain fatal",
);
assert.deepEqual(browserFailureDisposition(new Error("one malformed image")), { kind: "asset", pausesDispatch: false });

async function jsonRequest(url, { method = "GET", token = null, body = null } = {}) {
  const response = await fetch(url, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : null,
  });
  const value = await response.json();
  return { response, value };
}

async function waitForLease(baseUrl, token, types = ["llm"], slot = 0) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const { value } = await jsonRequest(`${baseUrl}/v1/worker/lease`, { method: "POST", token, body: { types, slot } });
    if (value.status === "leased") return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Test worker did not receive a lease.");
}

async function flowReferenceBindingFixture(downloadsRoot, fixtureId, references) {
  const evidenceDir = path.join(downloadsRoot, "reference-binding-evidence", fixtureId);
  await fs.mkdir(evidenceDir, { recursive: true });
  const receiptPath = path.join(evidenceDir, "reference-binding.json");
  const fullScreenshotPath = path.join(evidenceDir, "full-page.png");
  const composerScreenshotPath = path.join(evidenceDir, "composer.png");
  await fs.writeFile(receiptPath, `${JSON.stringify({
    schema: "goldflow_google_flow_reference_binding_evidence_v1",
    status: "captured",
    fixture_id: fixtureId,
  }, null, 2)}\n`);
  await sharp({ create: { width: 64, height: 36, channels: 3, background: "#384f73" } }).png().toFile(fullScreenshotPath);
  await sharp({ create: { width: 48, height: 24, channels: 3, background: "#739150" } }).png().toFile(composerScreenshotPath);
  return {
    schema: "goldflow_google_flow_reference_binding_v1",
    status: "verified",
    expected_count: references.length,
    observed_count: references.length,
    add_to_prompt_clicked: true,
    no_pending_uploads: true,
    prompt_text_verified: true,
    ordered_references: references.map((reference, index) => ({
      slot: reference.slot ?? index + 1,
      ref_id: reference.ref_id,
      source_sha256: reference.sha256,
      upload_filename: `${String(index + 1).padStart(2, "0")}-${reference.ref_id}.png`,
      media_id: `flow-media-${fixtureId}-${index + 1}`,
      media_url: `https://labs.google/fx/media/${fixtureId}/${index + 1}`,
    })),
    verified_at: new Date().toISOString(),
    evidence: {
      receipt_path: receiptPath,
      receipt_sha256: await sha256File(receiptPath),
      full_screenshot_path: fullScreenshotPath,
      full_screenshot_sha256: await sha256File(fullScreenshotPath),
      composer_screenshot_path: composerScreenshotPath,
      composer_screenshot_sha256: await sha256File(composerScreenshotPath),
    },
  };
}

async function testLlmStore() {
  const store = await new LlmJobStore({ stateDir: path.join(temporaryRoot, "llm") }).init();
  const first = await store.createOrGet({ model: "gpt-test", messages: [{ role: "user", content: "Return one word." }], timeout_ms: 1_800_000 });
  const duplicate = await store.createOrGet({ model: "gpt-test", messages: [{ role: "user", content: "Return one word." }], timeout_ms: 5_400_000 });
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(first.job.job_id, duplicate.job.job_id);
  assert.equal(duplicate.job.response_timeout_ms, 5_400_000, "a later longer timeout must raise the existing job's execution window");
  const shorterDuplicate = await store.createOrGet({ model: "gpt-test", messages: [{ role: "user", content: "Return one word." }], timeout_ms: 60_000 });
  assert.equal(shorterDuplicate.job.job_id, first.job.job_id, "timeout changes must not duplicate the creative job");
  assert.equal(shorterDuplicate.job.response_timeout_ms, 5_400_000, "a later shorter timeout must not reduce the existing execution window");
  assert.equal((await store.get(first.job.job_id)).response_timeout_ms, 5_400_000, "the raised timeout must be atomically persisted");
  assert.equal((await store.list()).length, 1, "timeout reconciliation must retain exactly one content-addressed job");
  const leased = await store.leaseNext({ workerId: "worker-a" });
  assert.equal(leased.job.attempt_count, 1);
  const sameLease = await store.leaseNext({ workerId: "worker-a" });
  assert.equal(sameLease.job.lease.lease_token, leased.job.lease.lease_token);
  await store.complete({ jobId: first.job.job_id, leaseToken: leased.job.lease.lease_token, workerId: "worker-a", content: "READY" });
  assert.equal((await store.waitForCompletion(first.job.job_id)).result.content, "READY");

  const second = await store.createOrGet({ model: "gpt-test", messages: [{ role: "user", content: "Fail once." }] });
  const secondLease = await store.leaseNext({ workerId: "worker-b" });
  await store.fail({ jobId: second.job.job_id, leaseToken: secondLease.job.lease.lease_token, workerId: "worker-b", code: "test_failure", message: "expected" });
  assert.equal((await store.leaseNext({ workerId: "worker-c" })).status, "no_work", "failed calls must not silently re-enter the queue");
  await store.requeue(second.job.job_id, "operator-approved test recovery");
  assert.equal((await store.leaseNext({ workerId: "worker-c" })).status, "leased");
}

async function testMediaJobStore() {
  const root = path.join(temporaryRoot, "media-store");
  const downloadsRoot = path.join(root, "downloads");
  await fs.mkdir(downloadsRoot, { recursive: true });
  const referencePath = path.join(root, "first-frame.png");
  await sharp({ create: { width: 160, height: 90, channels: 3, background: "#224466" } }).png().toFile(referencePath);
  const referenceSha256 = await sha256File(referencePath);
  const store = await new MediaJobStore({ stateDir: path.join(root, "state"), downloadsRoot }).init();
  const request = {
    type: "video",
    asset_id: "cut_001",
    prompt: "The camera pushes toward the subject as the coat moves in a light breeze.",
    model_id: "Veo 3.1 Fast",
    duration_sec: 8,
    references: [{ ref_id: "first_frame", path: referencePath, sha256: referenceSha256 }],
  };
  const first = await store.createOrGet(request);
  const duplicate = await store.createOrGet(request);
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(first.job.job_id, duplicate.job.job_id);
  const provenanceDuplicate = await store.createOrGet({
    ...request,
    manifest_id: "generated-motion-proof-02",
    asset_id: "proof-cut-001",
    references: [{ ref_id: "proof_first_frame", path: referencePath, sha256: referenceSha256 }],
    source: { direction_contract_sha256: "new-provenance-only" },
  });
  assert.equal(provenanceDuplicate.created, false, "provenance changes must not resubmit identical creative work");
  assert.equal(provenanceDuplicate.job.job_id, first.job.job_id);
  assert.equal(provenanceDuplicate.job.provenance_bindings.length, 2);
  const creativeIdentity = mediaCreativeIdentityForTests(request);
  assert.deepEqual(Object.keys(creativeIdentity), ["provider", "model_id", "prompt_sha256", "duration_sec", "first_frame_sha256"]);
  assert.notDeepEqual(mediaCreativeIdentityForTests({ ...request, model_id: "Veo 3.1 Quality" }), creativeIdentity);
  assert.notDeepEqual(mediaCreativeIdentityForTests({ ...request, prompt: `${request.prompt} Slowly.` }), creativeIdentity);
  assert.notDeepEqual(mediaCreativeIdentityForTests({ ...request, duration_sec: 10 }), creativeIdentity);
  await assert.rejects(() => store.createOrGet({ ...request, references: [] }), /exactly one first-frame reference/);

  const legacyStore = await new MediaJobStore({
    stateDir: path.join(root, "legacy-state"),
    downloadsRoot,
  }).init();
  const seeded = await legacyStore.createOrGet(request);
  const seededLease = await legacyStore.leaseNext({ workerId: "legacy-flow-worker" });
  assert.equal(seededLease.status, "leased");
  const legacyRequest = structuredClone(seededLease.job.request);
  delete legacyRequest.provider;
  const legacyJobId = sha256(stableStringify(legacyRequest));
  const legacyJob = { ...seededLease.job, job_id: legacyJobId, request_sha256: legacyJobId, request: legacyRequest };
  delete legacyJob.creative_identity;
  delete legacyJob.creative_identity_sha256;
  delete legacyJob.creative_identity_storage;
  delete legacyJob.provenance_bindings;
  await fs.writeFile(legacyStore.jobPath(legacyJobId), `${JSON.stringify(legacyJob, null, 2)}\n`, "utf8");
  await fs.unlink(legacyStore.jobPath(seeded.job.job_id));
  const adopted = await legacyStore.createOrGet({
    ...request,
    manifest_id: "new-manifest-provenance",
    asset_id: "new-asset-provenance",
    source: { direction_contract_sha256: "new-direction-provenance" },
  });
  assert.equal(adopted.created, false, "an in-flight legacy request must be adopted instead of duplicate-submitted");
  assert.equal(adopted.adopted_legacy_identity, true);
  assert.equal(adopted.job.job_id, legacyJobId, "legacy live job IDs must remain stable for connected workers");
  assert.equal(adopted.job.status, "leased", "legacy adoption must preserve an in-flight provider lease");
  assert.equal(adopted.job.lease.lease_token, seededLease.job.lease.lease_token);
  assert.equal(adopted.job.creative_identity_storage, "legacy_full_request_job_id");
  assert.equal(adopted.job.provenance_bindings.length, 2);
  assert.equal((await legacyStore.list()).length, 1);

  const leased = await store.leaseNext({ workerId: "flow-video-1" });
  assert.equal(leased.status, "leased");
  assert.equal(leased.job.attempt_count, 1);
  await store.fail({
    jobId: leased.job.job_id,
    leaseToken: leased.job.lease.lease_token,
    workerId: "flow-video-1",
    code: "provider_generation_failed",
    message: "bounded proof failure",
  });
  assert.equal((await store.leaseNext({ workerId: "flow-video-2" })).status, "no_work", "failed creative jobs must not auto-requeue");
  await store.requeue(leased.job.job_id, "operator approved exact-ID repair");
  const repairLease = await store.leaseNext({ workerId: "flow-video-2" });
  const outputPath = path.join(downloadsRoot, "cut_001.mp4");
  await fs.writeFile(outputPath, Buffer.alloc(120_000, 1));
  const completed = await store.complete({
    jobId: repairLease.job.job_id,
    leaseToken: repairLease.job.lease.lease_token,
    workerId: "flow-video-2",
    downloadPath: outputPath,
    uiContract: { reference_count: 1, model_label: "Veo 3.1 Fast" },
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.result.output_sha256, await sha256File(outputPath));
  assert.equal(completed.manual_requeues.length, 1);
}

async function testImageBridge() {
  const dataRoot = path.join(temporaryRoot, "data");
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "proof", "episodes", "ep_01");
  const stateDir = path.join(temporaryRoot, "image-state");
  const downloadsRoot = path.join(temporaryRoot, "downloads");
  await fs.mkdir(episodeDir, { recursive: true });
  const referencePath = path.join(episodeDir, "assets", "images", "references", "echo-reference.png");
  await fs.mkdir(path.dirname(referencePath), { recursive: true });
  await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#315d88" } }).png().toFile(referencePath);
  const promptsPath = path.join(episodeDir, "section_image_prompts_hardened.json");
  await fs.writeFile(promptsPath, `${JSON.stringify({
    status: "passed",
    image_provider: "codex_imagegen",
    prompts: [
      { image_id: "cut_001", image_generation_required: true, codex_image_prompt: "A precise landscape test frame.", reference_slots: [] },
      {
        image_id: "cut_echo",
        image_generation_required: true,
        codex_image_prompt: "Create a new scene from the reference.",
        reference_slots: [{ slot: 1, ref_id: "echo-reference", kind: "location", path: referencePath }],
      },
    ],
  }, null, 2)}\n`);
  const bridge = await new GoldflowBridge({ repoRoot, dataRoot, stateDir, downloadsRoot }).init();
  const created = await bridge.createManifest({ episodeDir, mode: "scene", imageIds: ["cut_001"], concurrency: 2 });
  assert.equal(created.item_count, 1);
  const leased = await bridge.leaseImage("image-worker");
  assert.equal(leased.job.asset_id, "cut_001");
  const downloadPath = path.join(downloadsRoot, "source-image.webp");
  await fs.mkdir(downloadsRoot, { recursive: true });
  await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#d94f2b" } }).webp().toFile(downloadPath);
  await assert.rejects(() => bridge.completeImage({
    manifestId: leased.job.manifest_id,
    assetId: leased.job.asset_id,
    leaseToken: leased.job.lease_token,
    workerId: "image-worker",
    downloadPath,
    browserProvider: "google-flow",
  }), /bound to chatgpt/, "receipt provider must come from the server-bound queue, not the client body");
  await bridge.completeImage({
    manifestId: leased.job.manifest_id,
    assetId: leased.job.asset_id,
    leaseToken: leased.job.lease_token,
    workerId: "image-worker",
    downloadPath,
    sourceUrl: "https://chatgpt.com/backend-api/test",
  });
  const summary = await bridge.imageManifestSummary(created.manifest_path);
  assert.equal(summary.status, "completed");
  assert.equal(summary.counts.completed, 1);

  const echoManifest = await bridge.createManifest({ episodeDir, mode: "scene", imageIds: ["cut_echo"], concurrency: 1 });
  const echoLease = await bridge.leaseImage("echo-worker");
  assert.equal(echoLease.job.asset_id, "cut_echo");
  const echoDownloadPath = path.join(downloadsRoot, "reference-echo.webp");
  await sharp(referencePath).webp({ quality: 100 }).toFile(echoDownloadPath);
  await assert.rejects(() => bridge.completeImage({
    manifestId: echoLease.job.manifest_id,
    assetId: echoLease.job.asset_id,
    leaseToken: echoLease.job.lease_token,
    workerId: "echo-worker",
    downloadPath: echoDownloadPath,
  }), (error) => error.code === "provider_reference_echo" && /matches ordered reference/.test(error.message));
  await bridge.failImage({
    manifestId: echoLease.job.manifest_id,
    assetId: echoLease.job.asset_id,
    leaseToken: echoLease.job.lease_token,
    workerId: "echo-worker",
    error: "provider_reference_echo: expected test rejection",
  });
  assert.equal((await bridge.imageManifestSummary(echoManifest.manifest_path)).counts.deadlettered, 1);
}

async function testGoogleFlowReferenceReceiptGate() {
  const dataRoot = path.join(temporaryRoot, "flow-receipt-data");
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "flow-proof", "episodes", "ep_01");
  const downloadsRoot = path.join(temporaryRoot, "flow-receipt-downloads");
  const stateDir = path.join(temporaryRoot, "flow-receipt-state");
  const firstReferencePath = path.join(episodeDir, "assets", "images", "references", "first.png");
  const secondReferencePath = path.join(episodeDir, "assets", "images", "references", "second.png");
  await fs.mkdir(path.dirname(firstReferencePath), { recursive: true });
  await sharp({ create: { width: 160, height: 90, channels: 3, background: "#8f3154" } }).png().toFile(firstReferencePath);
  await sharp({ create: { width: 160, height: 90, channels: 3, background: "#258b78" } }).png().toFile(secondReferencePath);
  const promptsPath = path.join(episodeDir, "section_image_prompts_hardened.json");
  await fs.writeFile(promptsPath, `${JSON.stringify({
    status: "passed",
    image_provider: "codex_imagegen",
    prompts: [
      { image_id: "flow_zero", image_generation_required: true, codex_image_prompt: "A zero-reference Flow test.", reference_slots: [] },
      {
        image_id: "flow_two",
        image_generation_required: true,
        codex_image_prompt: "A two-reference Flow test.",
        reference_slots: [
          { slot: 1, ref_id: "first", kind: "character", path: firstReferencePath },
          { slot: 2, ref_id: "second", kind: "location", path: secondReferencePath },
        ],
      },
    ],
  }, null, 2)}\n`);
  const bridge = await new GoldflowBridge({
    repoRoot,
    dataRoot,
    stateDir,
    downloadsRoot,
    browserProvider: "google-flow",
  }).init();

  const zeroManifest = await bridge.createManifest({ episodeDir, mode: "scene", imageIds: ["flow_zero"], concurrency: 1 });
  const zeroLease = await bridge.leaseImage("flow-zero-worker");
  assert.deepEqual(zeroLease.job.references, []);
  const zeroDownloadPath = path.join(downloadsRoot, "flow-zero-result.webp");
  await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#d88f27" } }).webp().toFile(zeroDownloadPath);
  await assert.rejects(() => bridge.completeImage({
    manifestId: zeroLease.job.manifest_id,
    assetId: zeroLease.job.asset_id,
    leaseToken: zeroLease.job.lease_token,
    workerId: "flow-zero-worker",
    downloadPath: zeroDownloadPath,
    browserProvider: "google-flow",
    uiContract: {},
  }), (error) => error.code === "ui_contract_mismatch" && /reference_binding is required/.test(error.message));
  const zeroBinding = await flowReferenceBindingFixture(downloadsRoot, "zero", []);
  await bridge.completeImage({
    manifestId: zeroLease.job.manifest_id,
    assetId: zeroLease.job.asset_id,
    leaseToken: zeroLease.job.lease_token,
    workerId: "flow-zero-worker",
    downloadPath: zeroDownloadPath,
    browserProvider: "google-flow",
    uiContract: { reference_binding: zeroBinding },
  });
  assert.equal((await bridge.imageManifestSummary(zeroManifest.manifest_path)).counts.completed, 1, "Flow must accept an explicit verified zero-reference receipt");

  const twoManifest = await bridge.createManifest({ episodeDir, mode: "scene", imageIds: ["flow_two"], concurrency: 1 });
  const twoLease = await bridge.leaseImage("flow-two-worker");
  assert.equal(twoLease.job.references.length, 2);
  const binding = await flowReferenceBindingFixture(downloadsRoot, "two", twoLease.job.references);
  await validateGoogleFlowReferenceBinding({
    uiContract: { reference_binding: binding },
    orderedReferences: twoLease.job.references.map((reference) => ({ slot: reference.slot, ref_id: reference.ref_id, sha256: reference.sha256 })),
    downloadsRoot,
  });
  await assert.rejects(() => validateGoogleFlowReferenceBinding({
    uiContract: { reference_binding: { ...binding, ordered_references: [...binding.ordered_references].reverse() } },
    orderedReferences: twoLease.job.references.map((reference) => ({ slot: reference.slot, ref_id: reference.ref_id, sha256: reference.sha256 })),
    downloadsRoot,
  }), /assignment slot|assignment order/);
  await assert.rejects(() => validateGoogleFlowReferenceBinding({
    uiContract: {
      reference_binding: {
        ...binding,
        ordered_references: binding.ordered_references.map((reference, index) => index === 0
          ? { ...reference, source_sha256: "0".repeat(64) }
          : reference),
      },
    },
    orderedReferences: twoLease.job.references.map((reference) => ({ slot: reference.slot, ref_id: reference.ref_id, sha256: reference.sha256 })),
    downloadsRoot,
  }), /does not match the assigned reference/);
  await assert.rejects(() => validateGoogleFlowReferenceBinding({
    uiContract: { reference_binding: { ...binding, observed_count: 1 } },
    orderedReferences: twoLease.job.references.map((reference) => ({ slot: reference.slot, ref_id: reference.ref_id, sha256: reference.sha256 })),
    downloadsRoot,
  }), /observed_count/);
  await assert.rejects(() => validateGoogleFlowReferenceBinding({
    uiContract: {
      reference_binding: {
        ...binding,
        evidence: { ...binding.evidence, receipt_path: path.join(temporaryRoot, "outside-evidence.json") },
      },
    },
    orderedReferences: twoLease.job.references.map((reference) => ({ slot: reference.slot, ref_id: reference.ref_id, sha256: reference.sha256 })),
    downloadsRoot,
  }), /must remain inside/);
  await fs.appendFile(binding.evidence.receipt_path, " ");
  await assert.rejects(() => validateGoogleFlowReferenceBinding({
    uiContract: { reference_binding: binding },
    orderedReferences: twoLease.job.references.map((reference) => ({ slot: reference.slot, ref_id: reference.ref_id, sha256: reference.sha256 })),
    downloadsRoot,
  }), /SHA-256 does not match/);

  const validBinding = await flowReferenceBindingFixture(downloadsRoot, "two-valid", twoLease.job.references);
  const twoDownloadPath = path.join(downloadsRoot, "flow-two-result.webp");
  await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#5a4dbc" } }).webp().toFile(twoDownloadPath);
  await bridge.completeImage({
    manifestId: twoLease.job.manifest_id,
    assetId: twoLease.job.asset_id,
    leaseToken: twoLease.job.lease_token,
    workerId: "flow-two-worker",
    downloadPath: twoDownloadPath,
    browserProvider: "google-flow",
    uiContract: { reference_binding: validBinding },
  });
  assert.equal((await bridge.imageManifestSummary(twoManifest.manifest_path)).counts.completed, 1);
}

async function testProviderAttributedSharedImageManifest() {
  const dataRoot = path.join(temporaryRoot, "shared-provider-data");
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "shared-provider", "episodes", "ep_01");
  const downloadsRoot = path.join(temporaryRoot, "shared-provider-downloads");
  const chatStateDir = path.join(temporaryRoot, "shared-provider-chat-state");
  const flowStateDir = path.join(temporaryRoot, "shared-provider-flow-state");
  const geminiStateDir = path.join(temporaryRoot, "shared-provider-gemini-state");
  await fs.mkdir(episodeDir, { recursive: true });

  const chatBridge = await new GoldflowBridge({
    repoRoot,
    dataRoot,
    stateDir: chatStateDir,
    downloadsRoot,
    browserProvider: "chatgpt",
  }).init();
  const flowBridge = await new GoldflowBridge({
    repoRoot,
    dataRoot,
    stateDir: flowStateDir,
    downloadsRoot,
    browserProvider: GOOGLE_FLOW_BROWSER_PROVIDER,
  }).init();
  const geminiBridge = await new GoldflowBridge({
    repoRoot,
    dataRoot,
    stateDir: geminiStateDir,
    downloadsRoot,
    browserProvider: GOOGLE_GEMINI_BROWSER_PROVIDER,
  }).init();

  const referencePlanPath = path.join(episodeDir, "visual_reference_plan.json");
  const characterStateRefsPath = path.join(episodeDir, "character_state_refs.json");
  await fs.writeFile(referencePlanPath, `${JSON.stringify({
    status: "passed",
    image_provider: HYBRID_WEB_FLOW_PROVIDER,
    reference_targets: [{
      ref_id: "style_ref",
      kind: "style",
      generation_mode: "standalone_ref",
      required_before_imagegen: true,
      codex_image_prompt: "A single clean anime/manhwa style-language reference.",
    }],
  }, null, 2)}\n`);
  await fs.writeFile(characterStateRefsPath, `${JSON.stringify({
    status: "draft_needs_manual_review",
    character_state_refs: [],
  }, null, 2)}\n`);

  const styleManifest = await createCodexWorkManifest({
    mode: "reference",
    episodeDir,
    referencePlanPath,
    characterStateRefsPath,
    referenceIds: ["style_ref"],
    ...hybridManifestDispatchOptions({ styleOnly: true }),
    maxAttempts: 1,
    leaseSeconds: 300,
  });
  assert.deepEqual(styleManifest.manifest.policy.allowed_browser_providers, ["chatgpt"]);
  await Promise.all([
    chatBridge.activateManifest(styleManifest.manifest.manifest_path),
    flowBridge.activateManifest(styleManifest.manifest.manifest_path),
  ]);
  assert.equal(
    (await chatBridge.activeManifestPaths()).includes(styleManifest.manifest.manifest_path),
    true,
    "activating a Flow manifest must preserve the active ChatGPT manifest entry",
  );
  assert.equal(
    (await flowBridge.activeManifestPaths()).includes(styleManifest.manifest.manifest_path),
    true,
    "activating a ChatGPT manifest must preserve the active Flow manifest entry",
  );
  const directFlowStyleLease = await leaseNextWorkItem({
    manifestPath: styleManifest.manifest.manifest_path,
    workerId: "flow-style-direct-worker",
    browserProvider: GOOGLE_FLOW_BROWSER_PROVIDER,
  });
  assert.equal(directFlowStyleLease.status, "no_work");
  assert.equal(directFlowStyleLease.no_work_reason, "browser_provider_not_allowed", "Flow must be unable to lease a ChatGPT-only style reference even if the manifest is accidentally activated there");
  assert.equal((await flowBridge.leaseImage("flow-style-bridge-worker")).status, "no_work");
  const chatStyleLease = await chatBridge.leaseImage("chat-style-worker");
  assert.equal(chatStyleLease.status, "leased");
  assert.equal(chatStyleLease.job.asset_id, "style_ref");
  assert.equal(
    (await chatBridge.imageManifestSummary(styleManifest.manifest.manifest_path)).items.find((row) => row.asset_id === "style_ref")?.browser_provider,
    "chatgpt",
  );
  await Promise.all([
    chatBridge.deactivateManifest(styleManifest.manifest.manifest_path),
    flowBridge.deactivateManifest(styleManifest.manifest.manifest_path),
  ]);

  const sceneIds = Array.from({ length: HYBRID_TOTAL_IMAGE_CONCURRENCY }, (_value, index) => `shared_cut_${String(index + 1).padStart(3, "0")}`);
  const promptsPath = path.join(episodeDir, "section_image_prompts_hardened.json");
  await fs.writeFile(promptsPath, `${JSON.stringify({
    status: "passed",
    image_provider: HYBRID_WEB_FLOW_PROVIDER,
    prompts: sceneIds.map((imageId) => ({
      image_id: imageId,
      image_generation_required: true,
      codex_image_prompt: `${imageId}: a distinct anime/manhwa landscape scene.`,
      reference_slots: [],
    })),
  }, null, 2)}\n`);
  const healthProofPath = path.join(episodeDir, "shared-provider-health-proof.json");
  await fs.writeFile(healthProofPath, `${JSON.stringify({
    schema: "goldflow_google_flow_health_proof_v1",
    status: "passed",
    safe_concurrency: HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY,
  }, null, 2)}\n`);
  const sharedManifest = await createCodexWorkManifest({
    mode: "scene",
    episodeDir,
    promptsPath,
    imageIds: sceneIds,
    ...hybridManifestDispatchOptions(),
    maxAttempts: 1,
    leaseSeconds: 300,
    verificationGateBypass: {
      kind: "prior_health_proof",
      path: healthProofPath,
      sha256: await sha256File(healthProofPath),
    },
  });
  assert.deepEqual(sharedManifest.manifest.policy.browser_provider_concurrency, {
    chatgpt: HYBRID_CHATGPT_IMAGE_CONCURRENCY,
    [GOOGLE_FLOW_BROWSER_PROVIDER]: HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY,
  });
  await Promise.all([
    chatBridge.activateManifest(sharedManifest.manifest.manifest_path),
    flowBridge.activateManifest(sharedManifest.manifest.manifest_path),
  ]);
  assert.deepEqual(
    await flowBridge.activeWorkerSessionPolicies(),
    [FRESH_GOOGLE_FLOW_PROJECT_PER_JOB_POLICY],
    "an active legacy manifest must advertise only its fresh-project policy",
  );

  const chatAttempts = [];
  for (let index = 0; index <= HYBRID_CHATGPT_IMAGE_CONCURRENCY; index += 1) {
    chatAttempts.push(await chatBridge.leaseImage(`shared-chat-worker-${index}`));
  }
  const flowAttempts = [];
  for (let index = 0; index <= HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY; index += 1) {
    flowAttempts.push(await flowBridge.leaseImage(`shared-flow-worker-${index}`));
  }
  const chatLeases = chatAttempts.filter((row) => row.status === "leased");
  const flowLeases = flowAttempts.filter((row) => row.status === "leased");
  assert.equal(chatLeases.length, HYBRID_CHATGPT_IMAGE_CONCURRENCY, "the shared manifest must cap ChatGPT at c3");
  assert.equal(flowLeases.length, HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY, "the shared manifest must cap Flow at c5");
  assert.equal(chatAttempts.at(-1).status, "no_work");
  assert.equal(flowAttempts.at(-1).status, "no_work");
  const chatAssetIds = new Set(chatLeases.map((row) => row.job.asset_id));
  const flowAssetIds = new Set(flowLeases.map((row) => row.job.asset_id));
  assert.deepEqual([...chatAssetIds].filter((assetId) => flowAssetIds.has(assetId)), [], "ChatGPT and Flow must never lease the same asset");
  assert.equal(new Set([...chatAssetIds, ...flowAssetIds]).size, sceneIds.length, "c3+c5 leasing must cover the eight-item shared manifest exactly once");

  const chatCompletionLease = chatLeases[0];
  const flowCompletionLease = flowLeases[0];
  const chatDownloadPath = path.join(downloadsRoot, "shared-chat-result.webp");
  const flowDownloadPath = path.join(downloadsRoot, "shared-flow-result.webp");
  await fs.mkdir(downloadsRoot, { recursive: true });
  await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#bd3f62" } }).webp().toFile(chatDownloadPath);
  await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#3e87bd" } }).webp().toFile(flowDownloadPath);
  await chatBridge.completeImage({
    manifestId: chatCompletionLease.job.manifest_id,
    assetId: chatCompletionLease.job.asset_id,
    leaseToken: chatCompletionLease.job.lease_token,
    workerId: "shared-chat-worker-0",
    downloadPath: chatDownloadPath,
  });
  const flowBinding = await flowReferenceBindingFixture(downloadsRoot, "shared-flow", flowCompletionLease.job.references);
  await flowBridge.completeImage({
    manifestId: flowCompletionLease.job.manifest_id,
    assetId: flowCompletionLease.job.asset_id,
    leaseToken: flowCompletionLease.job.lease_token,
    workerId: "shared-flow-worker-0",
    downloadPath: flowDownloadPath,
    uiContract: { reference_binding: flowBinding },
  });

  const manifestDir = path.dirname(sharedManifest.manifest.manifest_path);
  const chatCompletion = JSON.parse(await fs.readFile(path.join(manifestDir, "completions", `${chatCompletionLease.job.asset_id}.json`), "utf8"));
  const flowCompletion = JSON.parse(await fs.readFile(path.join(manifestDir, "completions", `${flowCompletionLease.job.asset_id}.json`), "utf8"));
  assert.equal(chatCompletion.browser_provider, "chatgpt");
  assert.equal(flowCompletion.browser_provider, GOOGLE_FLOW_BROWSER_PROVIDER);
  const chatReceipt = JSON.parse(await fs.readFile(path.join(chatCompletion.attempt_dir, "chatgpt_web_receipt.json"), "utf8"));
  const flowReceipt = JSON.parse(await fs.readFile(path.join(flowCompletion.attempt_dir, "google_flow_receipt.json"), "utf8"));
  assert.equal(chatReceipt.browser_provider, "chatgpt", "completion receipt attribution must come from the actual ChatGPT bridge");
  assert.equal(flowReceipt.browser_provider, GOOGLE_FLOW_BROWSER_PROVIDER, "completion receipt attribution must come from the actual Flow bridge");

  const deferredLease = chatLeases[2];
  const deferred = await chatBridge.deferImage({
    manifestId: deferredLease.job.manifest_id,
    assetId: deferredLease.job.asset_id,
    leaseToken: deferredLease.job.lease_token,
    workerId: "shared-chat-worker-2",
    reason: "fixture cooldown before submission",
  });
  assert.equal(deferred.status, "deferred_before_submission");
  const resumedDeferredLease = await chatBridge.leaseImage("shared-chat-deferred-worker");
  assert.equal(resumedDeferredLease.status, "leased");
  assert.equal(resumedDeferredLease.job.asset_id, deferredLease.job.asset_id, "a pre-submission deferral must preserve the exact item for a later first attempt");
  const deferredFailure = await chatBridge.failImage({
    manifestId: resumedDeferredLease.job.manifest_id,
    assetId: resumedDeferredLease.job.asset_id,
    leaseToken: resumedDeferredLease.job.lease_token,
    workerId: "shared-chat-deferred-worker",
    error: "fixture later creative failure",
  });
  assert.equal(deferredFailure.failure.attempt_number, 1, "a pre-submission deferral must not consume a creative attempt number");

  const failedLease = chatLeases[1];
  const failure = await chatBridge.failImage({
    manifestId: failedLease.job.manifest_id,
    assetId: failedLease.job.asset_id,
    leaseToken: failedLease.job.lease_token,
    workerId: "shared-chat-worker-1",
    error: "fixture single-submission failure",
  });
  assert.equal(failure.status, "deadlettered");
  assert.equal(failure.failure.browser_provider, "chatgpt");
  assert.equal((await chatBridge.leaseImage("shared-chat-retry-worker")).status, "no_work", "a deadlettered item must not be leased again to ChatGPT");
  assert.equal((await flowBridge.leaseImage("shared-flow-retry-worker")).status, "no_work", "a deadlettered item must not cross over to Flow as an implicit retry");
  const finalSummary = await chatBridge.imageManifestSummary(sharedManifest.manifest.manifest_path);
  assert.equal(finalSummary.items.find((row) => row.asset_id === failedLease.job.asset_id)?.status, "deadlettered");
  assert.equal(finalSummary.items.find((row) => row.asset_id === failedLease.job.asset_id)?.attempt_count, 1);
  assert.deepEqual(finalSummary.completed_by_browser_provider, {
    chatgpt: 1,
    [GOOGLE_FLOW_BROWSER_PROVIDER]: 1,
  });

  const persistentManifest = await createCodexWorkManifest({
    mode: "scene",
    episodeDir,
    promptsPath,
    imageIds: sceneIds.slice(0, 2),
    ...hybridManifestDispatchOptions({ federated: true, persistentWorkerPool: true }),
    maxAttempts: 1,
    leaseSeconds: 300,
  });
  assert.deepEqual(persistentManifest.manifest.policy.browser_provider_worker_session_policy, {
    [GOOGLE_FLOW_BROWSER_PROVIDER]: PERSISTENT_GOOGLE_FLOW_PROJECT_PER_SLOT_POLICY,
    [GOOGLE_GEMINI_BROWSER_PROVIDER]: PERSISTENT_BROWSER_TAB_PER_SLOT_POLICY,
  });
  const persistentFlowLease = await leaseNextWorkItem({
    manifestPath: persistentManifest.manifest.manifest_path,
    workerId: "persistent-flow-slot-0",
    browserProvider: GOOGLE_FLOW_BROWSER_PROVIDER,
  });
  const persistentGeminiLease = await leaseNextWorkItem({
    manifestPath: persistentManifest.manifest.manifest_path,
    workerId: "persistent-gemini-slot-0",
    browserProvider: GOOGLE_GEMINI_BROWSER_PROVIDER,
  });
  assert.equal(persistentFlowLease.assignment.worker_session_policy, PERSISTENT_GOOGLE_FLOW_PROJECT_PER_SLOT_POLICY);
  assert.equal(persistentGeminiLease.assignment.worker_session_policy, PERSISTENT_BROWSER_TAB_PER_SLOT_POLICY);
  await geminiBridge.activateManifest(persistentManifest.manifest.manifest_path);
  assert.deepEqual(
    await geminiBridge.activeWorkerSessionPolicies(),
    [PERSISTENT_BROWSER_TAB_PER_SLOT_POLICY],
    "an unresolved v3 manifest must advertise persistent Gemini startup warmup",
  );
  const persistentGeminiDownloadPath = path.join(downloadsRoot, "persistent-gemini-result.webp");
  await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#526ea8" } }).webp().toFile(persistentGeminiDownloadPath);
  await assert.rejects(() => geminiBridge.completeImage({
    manifestId: persistentGeminiLease.assignment.manifest_id,
    assetId: persistentGeminiLease.assignment.asset_id,
    leaseToken: persistentGeminiLease.assignment.lease_token,
    workerId: "persistent-gemini-slot-0",
    downloadPath: persistentGeminiDownloadPath,
    uiContract: {},
  }), (error) => error.code === "ui_contract_mismatch" && /worker_session_policy/.test(error.message));
  await geminiBridge.completeImage({
    manifestId: persistentGeminiLease.assignment.manifest_id,
    assetId: persistentGeminiLease.assignment.asset_id,
    leaseToken: persistentGeminiLease.assignment.lease_token,
    workerId: "persistent-gemini-slot-0",
    downloadPath: persistentGeminiDownloadPath,
    uiContract: {
      worker_session_policy: PERSISTENT_BROWSER_TAB_PER_SLOT_POLICY,
      worker_slot: 0,
    },
  });
  const persistentGeminiReceipt = JSON.parse(await fs.readFile(
    path.join(persistentGeminiLease.assignment.attempt_dir, "google_gemini_receipt.json"),
    "utf8",
  ));
  assert.equal(persistentGeminiReceipt.ui_contract.worker_session_policy, PERSISTENT_BROWSER_TAB_PER_SLOT_POLICY);
  assert.equal(persistentGeminiReceipt.ui_contract.worker_slot, 0);
}

async function testServerAndRunner() {
  const studio = await createStudioServer({
    port: 0,
    repoRoot,
    stateDir: path.join(temporaryRoot, "server-state"),
    dataRoot: path.join(temporaryRoot, "server-data"),
    downloadsRoot: path.join(temporaryRoot, "server-downloads"),
    adminToken: "test-admin-token",
    pairingCode: "123456",
  });
  try {
    const health = await jsonRequest(`${studio.url}/v1/health`);
    assert.equal(health.response.status, 200);
    assert.deepEqual(health.value.active_image_worker_session_policies, []);
    const unauthorized = await jsonRequest(`${studio.url}/v1/dashboard/state`);
    assert.equal(unauthorized.response.status, 401);
    const wrongPair = await jsonRequest(`${studio.url}/v1/pair`, { method: "POST", body: { code: "999999" } });
    assert.equal(wrongPair.response.status, 401);
    const paired = await jsonRequest(`${studio.url}/v1/pair`, { method: "POST", body: { code: "123456", label: "test worker" } });
    assert.equal(paired.response.status, 201);
    const workerToken = paired.value.token;
    const chatGptOverflow = await jsonRequest(`${studio.url}/v1/worker/lease`, {
      method: "POST",
      token: workerToken,
      body: { types: ["llm"], slot: 5 },
    });
    assert.equal(chatGptOverflow.response.status, 400, "ChatGPT server must reject a sixth browser slot");

    const completionPromise = jsonRequest(`${studio.url}/v1/chat/completions`, {
      method: "POST",
      token: studio.adminToken,
      body: { model: "gpt-5.6-sol", messages: [{ role: "user", content: "Return TEST_OK." }], timeout_ms: 5_400_000, metadata: { stage_name: "server-test", reasoning_effort: "max" } },
    });
    const lease = await waitForLease(studio.url, workerToken);
    assert.match(lease.job.prompt, /Return TEST_OK/);
    assert.equal(lease.ui_contract.effort_label, "Pro");
    assert.equal(lease.job.response_timeout_ms, 5_400_000, "the request timeout must reach the leased browser job");
    const completed = await jsonRequest(`${studio.url}/v1/worker/complete`, {
      method: "POST",
      token: workerToken,
      body: { type: "llm", jobId: lease.job.job_id, leaseToken: lease.job.lease_token, slot: 0, content: "TEST_OK" },
    });
    assert.equal(completed.response.status, 200);
    const completion = await completionPromise;
    assert.equal(completion.value.choices[0].message.content, "TEST_OK");
    assert.equal(typeof completion.value.goldflow_timing.total_ms, "number");
    assert.ok(completion.value.goldflow_timing.total_ms >= 0);
    assert.ok(completion.value.goldflow_timing.queue_wait_ms >= 0);
    assert.ok(completion.value.goldflow_timing.service_ms >= 0);

    const concurrentA = jsonRequest(`${studio.url}/v1/chat/completions`, {
      method: "POST",
      token: studio.adminToken,
      body: { model: "gpt-5.6-sol", messages: [{ role: "user", content: "Return SLOT_A." }], metadata: { stage_name: "slot-a" } },
    });
    const concurrentB = jsonRequest(`${studio.url}/v1/chat/completions`, {
      method: "POST",
      token: studio.adminToken,
      body: { model: "gpt-5.6-sol", messages: [{ role: "user", content: "Return SLOT_B." }], metadata: { stage_name: "slot-b" } },
    });
    const slotZeroLease = await waitForLease(studio.url, workerToken, ["llm"], 0);
    const slotOneLease = await waitForLease(studio.url, workerToken, ["llm"], 1);
    assert.notEqual(slotZeroLease.job.job_id, slotOneLease.job.job_id, "concurrent slots must own distinct leases");
    for (const [slot, leasedJob] of [[0, slotZeroLease], [1, slotOneLease]]) {
      const content = leasedJob.job.prompt.includes("SLOT_A") ? "SLOT_A" : "SLOT_B";
      await jsonRequest(`${studio.url}/v1/worker/complete`, {
        method: "POST",
        token: workerToken,
        body: { type: "llm", jobId: leasedJob.job.job_id, leaseToken: leasedJob.job.lease_token, slot, content },
      });
    }
    const concurrentResults = await Promise.all([concurrentA, concurrentB]);
    assert.deepEqual(new Set(concurrentResults.map((result) => result.value.choices[0].message.content)), new Set(["SLOT_A", "SLOT_B"]));

    process.env.ANIFACTORY_LLM_ROUTE = "chatgpt-web";
    process.env.ANIFACTORY_CHATGPT_WEB_URL = `${studio.url}/v1`;
    process.env.ANIFACTORY_CHATGPT_WEB_TOKEN = studio.adminToken;
    process.env.ANIFACTORY_CHATGPT_WEB_MODEL = "gpt-5.6-sol";
    assert.equal(chatGptWebRouteEnabled(), true);
    const outputPath = path.join(temporaryRoot, "runner", "answer.txt");
    const runnerPromise = runCodexCli({ prompt: "Return RUNNER_OK.", stageName: "runner-test", repoRoot, outputPath, timeoutMs: 30_000 });
    const runnerLease = await waitForLease(studio.url, workerToken);
    await jsonRequest(`${studio.url}/v1/worker/complete`, {
      method: "POST",
      token: workerToken,
      body: { type: "llm", jobId: runnerLease.job.job_id, leaseToken: runnerLease.job.lease_token, slot: 0, content: "RUNNER_OK" },
    });
    const runner = await runnerPromise;
    assert.equal(typeof runner.studio_timing.total_ms, "number");
    assert.equal(runner.bridge_duration_ms, runner.studio_timing.total_ms);
    assert.equal(runner.content, "RUNNER_OK");
    assert.equal(await fs.readFile(outputPath, "utf8"), "RUNNER_OK");
    const metadata = await readCodexCallMetadata(outputPath);
    assert.equal(metadata.provider, "chatgpt_web");
    assert.equal(isCodexCacheCompatible(metadata, { promptHash: metadata.prompt_sha256 }), true);
    const runtime = await codexRuntimeSummary();
    assert.equal(runtime.codex_cli_path, null);

    process.env.ANIFACTORY_CHATGPT_WEB_URL = "https://example.com/v1";
    await assert.rejects(() => codexRuntimeSummary(), /127\.0\.0\.1/);
  } finally {
    await studio.close();
    process.env = { ...originalEnvironment };
  }
}

async function testProviderIsolation() {
  const sharedStateDir = path.join(temporaryRoot, "provider-isolation-state");
  const chatState = new DesktopRuntimeState({ stateDir: sharedStateDir, namespace: "chatgpt" });
  const flowState = new DesktopRuntimeState({ stateDir: sharedStateDir, namespace: "google-flow" });
  assert.notEqual(chatState.credentialsPath, flowState.credentialsPath);
  assert.notEqual(chatState.runtimePath, flowState.runtimePath);
  await chatState.saveCredentials({ browser_provider: "chatgpt", worker_token: "chat-token" });
  await flowState.saveCredentials({ browser_provider: "google-flow", worker_token: "flow-token" });
  assert.equal((await chatState.credentials()).worker_token, "chat-token");
  assert.equal((await flowState.credentials()).worker_token, "flow-token");

  const studio = await createStudioServer({
    port: 0,
    repoRoot,
    stateDir: sharedStateDir,
    dataRoot: path.join(temporaryRoot, "flow-server-data"),
    downloadsRoot: path.join(temporaryRoot, "flow-server-downloads"),
    adminToken: "flow-admin-token",
    pairingCode: "654321",
    browserProvider: "google-flow",
    flowPlanLabel: "PLUS",
    flowModelLabel: "Nano Banana Pro",
  });
  try {
    const runtimePath = path.join(studio.stateDir, "studio-runtime.json");
    const runtime = await assertHostRuntime(runtimePath, "google-flow", {
      expectedPlanLabel: "PLUS",
      expectedModelLabel: "Nano Banana Pro",
    });
    assert.equal(runtime.ui_contract.account_plan, "PLUS");
    assert.equal(runtime.ui_contract.model_label, "Nano Banana Pro");
    await assert.rejects(() => assertHostRuntime(runtimePath, "google-flow", {
      expectedPlanLabel: "ULTRA",
      expectedModelLabel: "Nano Banana Pro",
    }), /Google Flow host identity mismatch: expected plan=ULTRA/);
    await assert.rejects(() => assertHostRuntime(runtimePath, "google-flow", {
      expectedPlanLabel: "PLUS",
      expectedModelLabel: "Nano Banana 2",
    }), /Google Flow host identity mismatch: expected plan=PLUS, model=Nano Banana 2/);
    await assert.rejects(
      () => assertHostRuntime(runtimePath, "google-flow"),
      /requires exact identity-locked plan and model labels/,
    );
    const health = await jsonRequest(`${studio.url}/v1/health`);
    assert.equal(health.value.browser_provider, "google-flow");
    assert.equal(health.value.worker_slot_ceiling, 19);
    assert.deepEqual(health.value.active_image_worker_session_policies, []);
    const wrongProvider = await jsonRequest(`${studio.url}/v1/pair`, {
      method: "POST",
      body: { code: "654321", label: "wrong worker", browserProvider: "chatgpt" },
    });
    assert.equal(wrongProvider.response.status, 409);
    const paired = await jsonRequest(`${studio.url}/v1/pair`, {
      method: "POST",
      body: { code: "654321", label: "flow worker", browserProvider: "google-flow" },
    });
    assert.equal(paired.response.status, 201);
    assert.equal(paired.value.browser_provider, "google-flow");
    const twentiethSlot = await jsonRequest(`${studio.url}/v1/worker/lease`, {
      method: "POST",
      token: paired.value.token,
      body: { types: ["image"], slot: 19 },
    });
    assert.equal(twentiethSlot.response.status, 200);
    assert.equal(twentiethSlot.value.status, "no_work");
    const overflow = await jsonRequest(`${studio.url}/v1/worker/lease`, {
      method: "POST",
      token: paired.value.token,
      body: { types: ["image"], slot: 20 },
    });
    assert.equal(overflow.response.status, 400);
    const wrongType = await jsonRequest(`${studio.url}/v1/worker/lease`, {
      method: "POST",
      token: paired.value.token,
      body: { types: ["llm"], slot: 0 },
    });
    assert.equal(wrongType.response.status, 400);
  } finally {
    await studio.close();
  }
}

async function testExtensionPermissions() {
  const manifest = JSON.parse(await fs.readFile(path.join(repoRoot, "apps", "goldflow-studio", "extension", "manifest.json"), "utf8"));
  const contentWorker = await fs.readFile(path.join(repoRoot, "apps", "goldflow-studio", "extension", "content.js"), "utf8");
  const backgroundWorker = await fs.readFile(path.join(repoRoot, "apps", "goldflow-studio", "extension", "background.js"), "utf8");
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.host_permissions.sort(), ["http://127.0.0.1/*", "https://chatgpt.com/*"].sort());
  assert.match(contentWorker, /accounts-profile-button/, "account verification must support ChatGPT's role-button profile control");
  assert.match(contentWorker, /new PointerEvent\("pointerdown"/, "power-menu verification must use ChatGPT's pointer-trigger contract");
  assert.match(contentWorker, /querySelectorAll\([^\n]+\)\]\s*\.find\(visible\)/, "composer discovery must ignore ChatGPT's hidden fallback textarea");
  assert.match(contentWorker, /\["Instant", "Medium", "High", "Extra High", "Pro"\]/, "worker must select the exact per-job effort contract");
  assert.match(contentWorker, /menuitemradio/, "worker must select each job's exact Advanced model option");
  assert.match(contentWorker, /contract\.model_label/, "worker must bind model selection to the leased job contract");
  assert.match(contentWorker, /No reference images are attached\. Generate directly from the text prompt/, "zero-reference image jobs must not ask ChatGPT to use missing attachments");
  assert.match(contentWorker, /chatgpt_image_refusal/, "image workers must stop on upload or clarification refusals");
  assert.match(contentWorker, /image generation failed/, "image workers must stop on ChatGPT's terminal generation-failed state");
  assert.match(contentWorker, /image tool incorrectly treated/, "image workers must stop when ChatGPT misroutes a text-only request as an edit");
  assert.match(contentWorker, /data-id="picture_v2"/, "image workers must explicitly activate ChatGPT Create image mode");
  assert.match(contentWorker, /preserveImageMode: true/, "image prompt submission must preserve the active Create image pill");
  assert.match(contentWorker, /#upload-files/, "reference uploads must use ChatGPT's general file input before legacy image inputs");
  assert.match(contentWorker, /Remove file/, "reference uploads must wait for ChatGPT's accepted attachment marker");
  assert.match(contentWorker, /GOLDFLOW_FETCH_REFERENCE/, "reference bytes must be requested from the extension service worker");
  assert.doesNotMatch(contentWorker, /fetch\(`\$\{connection\.serverUrl\}/, "the ChatGPT page must not fetch localhost references directly");
  assert.match(backgroundWorker, /fetchReferenceForContentScript/, "the extension service worker must own localhost reference retrieval");
  assert.match(backgroundWorker, /\/v1\\\/worker\\\/image-reference/, "reference retrieval must reject arbitrary localhost routes");
  for (const forbidden of ["cookies", "history", "webRequest", "webRequestBlocking", "<all_urls>"]) {
    assert.equal(JSON.stringify(manifest).includes(forbidden), false, `extension must not request ${forbidden}`);
  }
}

async function testDesktopHostContract() {
  assert.equal(chatGptEffortLabel("max"), "Pro");
  assert.equal(chatGptEffortSliderIndex("Pro"), 4);
  assert.equal(chatGptModelLabel("gpt-5.5"), "GPT-5.5");
  assert.equal(chatGptModelLabel("gpt-5.6-sol"), "GPT-5.6 Sol");
  assert.equal(chatGptModelControlMatches("Model 5.5", "GPT-5.5"), true);
  assert.equal(chatGptModelControlMatches("Model GPT-5.6 Sol", "GPT-5.5"), false);
  assert.equal(chatGptUiContractForLlmJob({ account_plan: "Pro", model_label: "GPT-5.6 Sol", effort_label: "Medium" }, {
    request: { model: "gpt-5.5", reasoning_effort: "max" },
  }).model_label, "GPT-5.5");
  assert.equal(chatGptUiContractForLlmJob({ account_plan: "Pro", model_label: "GPT-5.6 Sol", effort_label: "Medium" }, {
    request: { model: "gpt-5.5", reasoning_effort: "max" },
  }).effort_label, "Pro");
  const flags = parseDesktopFlags(["--server-url", "http://127.0.0.1:4317", "--concurrency", "5", "--types", "llm,image"]);
  const config = assertDesktopConfig(desktopConfig({
    ...flags,
    "state-dir": path.join(temporaryRoot, "desktop-state"),
    "profile-dir": path.join(temporaryRoot, "desktop-profile"),
    "downloads-root": path.join(temporaryRoot, "desktop-downloads"),
  }, {}));
  assert.equal(config.concurrency, PRODUCTION_BROWSER_CONCURRENCY_CEILING);
  assert.equal(config.submissionStaggerMs, 6_000);
  assert.deepEqual(config.types, ["llm", "image"]);
  assert.throws(() => assertDesktopConfig({ ...config, serverUrl: "https://example.com" }), /127\.0\.0\.1/);
  assert.equal(normalizeBrowserProvider("nano banana pro"), "google-flow");
  const flowConfig = assertDesktopConfig(desktopConfig({
    "server-url": "http://127.0.0.1:4317",
    provider: "google-flow",
    "state-dir": path.join(temporaryRoot, "flow-state"),
    "downloads-root": path.join(temporaryRoot, "flow-downloads"),
  }, {}));
  assert.equal(flowConfig.browserProvider, "google-flow");
  assert.deepEqual(flowConfig.types, ["image"]);
  assert.match(flowConfig.profileDir, /google-flow-browser-profile$/);
  assert.equal(desktopConfig({ ...flowConfig, provider: "google-flow", concurrency: "20" }, {}).concurrency, GOOGLE_FLOW_BROWSER_CONCURRENCY_CEILING);
  assert.equal(desktopConfig({ ...flowConfig, provider: "google-flow", concurrency: "21" }, {}).concurrency, GOOGLE_FLOW_BROWSER_CONCURRENCY_CEILING);
  assert.equal(desktopConfig({ ...config, provider: "chatgpt", concurrency: "20" }, {}).concurrency, 3);
  assert.equal(desktopConfig({ ...flowConfig, "submission-stagger-ms": "1" }, {}).submissionStaggerMs, 5_000);
  assert.equal(desktopConfig({ ...flowConfig, "submission-stagger-ms": "999999" }, {}).submissionStaggerMs, 8_000);
  assert.throws(() => assertDesktopConfig({ ...flowConfig, types: ["llm", "image"] }), /image or video work/);
  assert.throws(() => assertDesktopConfig({ ...flowConfig, concurrency: 2, flowProjectUrl: "https://labs.google/fx/tools/flow/project/example" }), /dedicated project per persistent worker slot/);
  assert.equal(flowBlockingCode("Requesting generations too quickly. Try again later."), "rate_limited");
  assert.equal(flowBlockingCode("Unusual activity has been detected."), "usage_limited");
  assert.equal(flowBlockingCode("Generation failed"), "google_flow_generation_error");
  assert.equal(flowBlockingCode("This generation might violate our policies. Please try a different prompt or send feedback"), "content_policy_rejected");
  assert.equal(normalizeFlowPromptText("first\n\n\uFEFF\nsecond"), "first second");
  const threeReferenceDock = {
    expectedReferences: [{ media_id: "media-a" }, { media_id: "media-b" }, { media_id: "media-c" }],
    observedChips: [
      { media_id: "media-a", loaded: true },
      { media_id: "media-b", loaded: true },
      { media_id: "media-c", loaded: true },
    ],
    expectedPrompt: "exact prompt text",
    observedPrompt: "exact prompt text",
    noPendingUploads: true,
    createEnabled: true,
  };
  assert.equal(validateFlowReferenceDock(threeReferenceDock), true, "Flow must retain valid three-reference jobs even though the proof samples 1/2/4");
  assert.throws(() => validateFlowReferenceDock({
    ...threeReferenceDock,
    observedChips: [...threeReferenceDock.observedChips].reverse(),
  }), /missing or out of order/, "Flow must reject reordered prompt-bound media UUIDs");
  assert.throws(() => validateFlowReferenceDock({
    ...threeReferenceDock,
    noPendingUploads: false,
  }), /pending reference upload/, "Flow must reject a composer that still reports upload activity");
  assert.throws(() => validateFlowReferenceDock({
    ...threeReferenceDock,
    expectedReferences: Array.from({ length: 5 }, (_, index) => ({ media_id: `media-${index}` })),
    observedChips: Array.from({ length: 5 }, (_, index) => ({ media_id: `media-${index}`, loaded: true })),
  }), /between zero and four/, "Flow image jobs must retain the exact four-reference ceiling");

  const sharedClipboard = { value: "" };
  const pasteEvents = [];
  const fakePage = (id) => {
    const composer = {
      value: "",
      async click() {},
      async evaluate() { return this.value; },
    };
    const page = {
      composer,
      keyboard: {
        async press(key) {
          if (/Backspace/.test(key)) composer.value = "";
          if (/\+V$/.test(key)) {
            pasteEvents.push(`paste-${id}`);
            composer.value = sharedClipboard.value;
          }
        },
      },
      async evaluate(_callback, value) {
        pasteEvents.push(`write-${id}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        sharedClipboard.value = value;
      },
    };
    return page;
  };
  const flowBrowser = new GoogleFlowBrowser({ concurrency: 2 });
  flowBrowser.composer = async (page) => page.composer;
  const firstPage = fakePage("a");
  const secondPage = fakePage("b");
  await Promise.all([
    flowBrowser.pastePrompt(firstPage, "prompt alpha"),
    flowBrowser.pastePrompt(secondPage, "prompt beta"),
  ]);
  assert.equal(firstPage.composer.value, "prompt alpha");
  assert.equal(secondPage.composer.value, "prompt beta");
  assert.deepEqual(pasteEvents, ["write-a", "paste-a", "write-b", "paste-b"], "Flow clipboard write/paste/verification must be one serialized critical section");

  const validRoute = "/v1/worker/image-reference/codex-work-abc/cut_001/1?lease_token=token-123";
  assert.equal(validReferenceRoute(validRoute), true);
  assert.equal(validReferenceRoute("http://127.0.0.1:4317/v1/dashboard/state"), false);
  assert.equal(validReferenceRoute("/v1/worker/image-reference/a/b/1?lease_token=x&extra=y"), false);

  const state = new DesktopRuntimeState({ stateDir: config.stateDir });
  await state.saveCredentials({ server_url: config.serverUrl, worker_id: "worker-test", worker_token: "secret" });
  assert.equal((await state.credentials()).worker_token, "secret");
  assert.equal((await fs.stat(state.credentialsPath)).mode & 0o777, 0o600);
  await state.saveRuntime({ status: "running", active_jobs: [{ slot: 0, phase: "submitted" }] });
  assert.equal((await state.runtime()).active_jobs[0].phase, "submitted");
  await Promise.all([
    state.saveRuntime({ status: "running", active_jobs: [], marker: "a" }),
    state.saveRuntime({ status: "running", active_jobs: [], marker: "b" }),
  ]);
  assert.ok(["a", "b"].includes((await state.runtime()).marker), "concurrent runtime writes must remain atomic");

  assert.equal(await loginMarkerExists(config.profileDir), false);
  await markLoginVerified(config.profileDir, { url: "https://chatgpt.com/" });
  assert.equal(await loginMarkerExists(config.profileDir), true);
  assert.equal((await fs.stat(loginVerificationMarkerPath(config.profileDir))).mode & 0o777, 0o600);

  const browserSource = await fs.readFile(path.join(repoRoot, "apps", "goldflow-studio", "desktop", "chatgpt-browser.mjs"), "utf8");
  const flowBrowserSource = await fs.readFile(path.join(repoRoot, "apps", "goldflow-studio", "desktop", "google-flow-browser.mjs"), "utf8");
  const hostSource = await fs.readFile(path.join(repoRoot, "apps", "goldflow-studio", "desktop", "worker-host.mjs"), "utf8");
  const configSource = await fs.readFile(path.join(repoRoot, "apps", "goldflow-studio", "desktop", "config.mjs"), "utf8");
  const launcher = await fs.readFile(path.join(repoRoot, "apps", "goldflow-studio", "Goldflow Studio.command"), "utf8");
  const loginSource = await fs.readFile(path.join(repoRoot, "apps", "goldflow-studio", "desktop", "browser-login.mjs"), "utf8");
  assert.match(browserSource, /launchPersistentContext/, "desktop host must own a persistent signed-in browser profile");
  assert.match(browserSource, /--use-mock-keychain/, "supervised Chrome must retain access to cookies written by the normal Keychain-aware login process");
  assert.match(browserSource, /SIGNED_OUT_SELECTOR/, "the public logged-out composer must never satisfy desktop authentication");
  assert.match(loginSource, /--disable-background-mode/, "login bootstrap must use a normal dedicated Chrome process that exits cleanly");
  assert.doesNotMatch(loginSource, /playwright|remote-debugging|enable-automation/i, "manual login must not attach browser automation");
  assert.match(browserSource, /profilePlanText/, "desktop host must verify the plan from the opened account menu when the closed profile button omits it");
  assert.match(browserSource, /_ui-contract-diagnostics/, "desktop host must preserve local diagnostics for ChatGPT UI contract drift");
  assert.match(browserSource, /setInputFiles/, "desktop host must upload ordered reference bytes outside the ChatGPT origin");
  assert.ok(
    browserSource.indexOf("const composerReceipt = await stabilizeChatGptComposerPrompt")
      < browserSource.indexOf('await onPhase("attaching_prompt_file")'),
    "long ChatGPT prompts must stabilize composer text before attaching the hash-bound file because composer.fill clears current attachments",
  );
  assert.match(browserSource, /Create image/, "desktop host must select the explicit ChatGPT image surface");
  assert.match(flowBrowserSource, /navigator\.clipboard\.writeText/, "Flow prompts must use the real clipboard-paste path that enables Create");
  assert.match(flowBrowserSource, /baseline = new Set/, "Flow completion must distinguish generated output from uploaded references");
  assert.match(flowBrowserSource, /baselineImageFingerprints/, "Flow completion must detect generated pixels when the provider reuses an existing media URL");
  assert.match(flowBrowserSource, /waitForComposerChipCount\(page, expectedCount, \{ timeoutMs = 90_000 \}/, "five-way Flow uploads must receive a full reference-thumbnail settle window before failing closed");
  assert.match(flowBrowserSource, /browserProvider: "google-flow"/, "Flow receipts must identify their browser provider");
  assert.match(flowBrowserSource, /project_url: page\.url\(\)/, "Flow receipts must preserve the exact project URL for duplicate-safe recovery");
  assert.match(hostSource, /lease_ambiguous/, "desktop restart recovery must fail closed rather than resubmit");
  assert.match(hostSource, /this\.persistQueue\.then/, "desktop runtime snapshots must preserve call order so completed jobs cannot remain falsely active");
  assert.match(hostSource, /this\.stopStarted/, "desktop host must close browser resources even when startup fails");
  assert.match(configSource, /PRODUCTION_BROWSER_CONCURRENCY_CEILING = 3/, "ChatGPT and Gemini must retain the three-slot ceiling");
  assert.match(configSource, /GOOGLE_FLOW_BROWSER_CONCURRENCY_CEILING = 5/, "Flow must expose the five-slot production pool promised by the fast-premium profile");
  assert.match(hostSource, /submissionStaggerMs/, "the desktop host must stagger creative browser submissions");
  assert.match(hostSource, /consecutiveTransportFailures/, "the desktop host must open a circuit after repeated transport failures");
  assert.match(launcher, /desktop\/main\.mjs/, "Finder launcher must start the supervised desktop host");
}

async function testPersistentFlowWorkerPool() {
  const createdSlots = [];
  const pages = new Map();
  const projectUrl = (slot) => `https://labs.google/fx/tools/flow/project/persistent-slot-${slot}/edit`;
  const makePage = (slot) => {
    let closed = false;
    const navigations = [];
    const page = {
      slot,
      navigations,
      async goto(url) { navigations.push(url); },
      url() { return projectUrl(slot); },
      isClosed() { return closed; },
      async close() { closed = true; },
      locator(selector) {
        const visible = !/Sign in/i.test(selector);
        return {
          async count() { return visible ? 1 : 0; },
          nth() { return this; },
          async isVisible() { return visible; },
        };
      },
    };
    pages.set(slot, page);
    return page;
  };
  const browser = new GoogleFlowBrowser({ concurrency: HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY });
  browser.createPersistentWorkerPage = async (slot) => {
    createdSlots.push(slot);
    const page = makePage(slot);
    return { slot, page, projectUrl: projectUrl(slot), preparedAt: new Date().toISOString() };
  };
  const ready = await browser.prepareWorkerSlots();
  assert.deepEqual(createdSlots.sort((left, right) => left - right), [0, 1, 2, 3, 4], "Flow must prewarm exactly five stable worker projects");
  assert.equal(ready.ready_slots.length, HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY);
  const firstSlotTwo = await browser.persistentJobPage(2);
  const secondSlotTwo = await browser.persistentJobPage(2);
  assert.equal(firstSlotTwo, secondSlotTwo, "successive jobs on one Flow slot must reuse the same page object");
  assert.deepEqual(firstSlotTwo.navigations, [projectUrl(2), projectUrl(2)], "successive jobs must return to the same slot-bound Flow project URL");
  assert.equal(createdSlots.filter((slot) => slot === 2).length, 1, "slot reuse must not create another Flow project");
  await assert.rejects(() => browser.ensurePersistentWorkerPage(5), /integer from 0 through 4/);

  let creativeSubmissions = 0;
  browser.verifyUiContract = async () => ({ model_label: "Nano Banana Pro" });
  browser.pastePrompt = async () => {};
  browser.attachReferences = async () => ({ referenceInputs: [], boundReferences: [] });
  browser.waitForVisibleImagesToSettle = async () => [];
  browser.baselineImageFingerprints = async () => new Map();
  browser.recordReferenceBindingEvidence = async () => ({
    create: { async click() { creativeSubmissions += 1; } },
    referenceBinding: { status: "verified", expected_count: 0, observed_count: 0 },
  });
  browser.waitForGeneratedImage = async () => ({ sourceUrl: "blob:persistent-flow-success", bytes: Buffer.from("image") });
  browser.saveGeneratedImage = async () => "/tmp/persistent-flow-success.img";
  const baseJob = {
    type: "image",
    manifest_id: "persistent-flow-manifest",
    asset_id: "cut_persistent_success",
    lease_token: "persistent-flow-lease-success",
    worker_session_policy: PERSISTENT_GOOGLE_FLOW_PROJECT_PER_SLOT_POLICY,
    prompt: "A single test landscape.",
    references: [],
  };
  await browser.runJob({ slot: 2, job: baseJob, client: {} });
  assert.equal(creativeSubmissions, 1, "one successful asset must receive exactly one creative submission");
  assert.equal(firstSlotTwo.isClosed(), false, "a successful persistent Flow job must leave its slot page open");

  browser.waitForGeneratedImage = async () => {
    const error = new Error("Generation failed after submission");
    error.code = "google_flow_generation_error";
    throw error;
  };
  await assert.rejects(
    () => browser.runJob({
      slot: 2,
      job: { ...baseJob, asset_id: "cut_persistent_failure", lease_token: "persistent-flow-lease-failure" },
      client: {},
    }),
    (error) => error.code === "google_flow_generation_error",
  );
  assert.equal(creativeSubmissions, 2, "a post-submit provider failure must not trigger a second creative submission for that asset");
  assert.equal(firstSlotTwo.isClosed(), false, "a failed persistent Flow job must remain inspectable in its stable slot page");

  const legacyPage = makePage(99);
  let legacyPageCreations = 0;
  const legacyBrowser = new GoogleFlowBrowser({ concurrency: 1 });
  legacyBrowser.workerPages.set(0, { slot: 0, page: makePage(0), projectUrl: projectUrl(0) });
  legacyBrowser.newJobPage = async () => { legacyPageCreations += 1; return legacyPage; };
  legacyBrowser.verifyUiContract = browser.verifyUiContract;
  legacyBrowser.pastePrompt = browser.pastePrompt;
  legacyBrowser.attachReferences = browser.attachReferences;
  legacyBrowser.waitForVisibleImagesToSettle = browser.waitForVisibleImagesToSettle;
  legacyBrowser.baselineImageFingerprints = browser.baselineImageFingerprints;
  legacyBrowser.recordReferenceBindingEvidence = async () => ({
    create: { async click() {} },
    referenceBinding: { status: "verified", expected_count: 0, observed_count: 0 },
  });
  legacyBrowser.waitForGeneratedImage = async () => ({ sourceUrl: "blob:legacy-flow-success", bytes: Buffer.from("image") });
  legacyBrowser.saveGeneratedImage = async () => "/tmp/legacy-flow-success.img";
  await legacyBrowser.runJob({
    slot: 0,
    job: { ...baseJob, asset_id: "cut_legacy", lease_token: "legacy-lease", worker_session_policy: FRESH_GOOGLE_FLOW_PROJECT_PER_JOB_POLICY },
    client: {},
  });
  assert.equal(legacyPageCreations, 1, "legacy identities must continue to create a fresh Flow job page");
  assert.equal(legacyPage.isClosed(), true, "legacy fresh Flow pages must still close after successful work");
}

async function testDesktopProviderCircuitBreaker() {
  const config = assertDesktopConfig(desktopConfig({
    "server-url": "http://127.0.0.1:4317",
    provider: "google-flow",
    concurrency: "1",
    types: "image",
    "state-dir": path.join(temporaryRoot, "circuit-state"),
    "profile-dir": path.join(temporaryRoot, "circuit-profile"),
    "downloads-root": path.join(temporaryRoot, "circuit-downloads"),
  }, {}));
  const browser = {
    async runJob() {
      const error = new Error("Generation failed transiently");
      error.code = "google_flow_generation_error";
      throw error;
    },
  };
  const reportedCodes = [];
  const host = new GoldflowDesktopHost({ config, browser, log: () => {} });
  host.persistRuntime = async () => {};
  host.schedule = () => {};
  host.client = {
    async heartbeat() {},
    async complete() { throw new Error("unexpected completion"); },
    async fail(_job, _slot, error) { reportedCodes.push(error.code); },
  };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await host.runSlot(0, { job: { type: "image", job_id: `circuit-cut-${attempt}` } });
  }
  assert.deepEqual(reportedCodes, [
    "google_flow_generation_error",
    "google_flow_generation_error",
    "provider_transient_circuit_open",
  ], "only the third consecutive transient failure may open the provider circuit");
  assert.equal(host.consecutiveTransportFailures, 3);
  assert.equal(host.providerCircuit?.status, "open");
  assert.equal(host.providerCircuit?.failure_count, 3);
  assert.ok(host.dispatchCooldownUntil > Date.now(), "an open provider circuit must halt new local leases during triage");

  const chatConfig = assertDesktopConfig(desktopConfig({
    "server-url": "http://127.0.0.1:4317",
    provider: "chatgpt",
    concurrency: "1",
    types: "llm",
    "state-dir": path.join(temporaryRoot, "response-timeout-state"),
    "profile-dir": path.join(temporaryRoot, "response-timeout-profile"),
    "downloads-root": path.join(temporaryRoot, "response-timeout-downloads"),
  }, {}));
  const responseTimeoutBrowser = {
    async runJob() {
      const error = new Error("Timed out waiting for a completed ChatGPT response.");
      error.code = "ui_contract_mismatch";
      throw error;
    },
  };
  const responseTimeoutCodes = [];
  const responseTimeoutHost = new GoldflowDesktopHost({ config: chatConfig, browser: responseTimeoutBrowser, log: () => {} });
  responseTimeoutHost.persistRuntime = async () => {};
  responseTimeoutHost.schedule = () => {};
  responseTimeoutHost.client = {
    async heartbeat() {},
    async complete() { throw new Error("unexpected completion"); },
    async fail(_job, _slot, error) { responseTimeoutCodes.push(error.code); },
  };
  await responseTimeoutHost.runSlot(0, { job: { type: "llm", job_id: "response-timeout" } });
  assert.deepEqual(responseTimeoutCodes, ["provider_response_timeout"], "a response timeout must not reach the server as a fatal UI-contract code");
  assert.equal(responseTimeoutHost.consecutiveTransportFailures, 1);
  assert.equal(responseTimeoutHost.providerCircuit, null, "one response timeout must not open the provider circuit");
  assert.equal(responseTimeoutHost.dispatchCooldownUntil, 0, "one response timeout must not halt local dispatch");
}

async function testDesktopTopOffScheduling() {
  const config = assertDesktopConfig(desktopConfig({
    "server-url": "http://127.0.0.1:4317",
    provider: "google-flow",
    concurrency: "5",
    types: "image",
    "state-dir": path.join(temporaryRoot, "top-off-state"),
    "profile-dir": path.join(temporaryRoot, "top-off-profile"),
    "downloads-root": path.join(temporaryRoot, "top-off-downloads"),
  }, {}));
  const host = new GoldflowDesktopHost({ config, browser: {}, log: () => {} });
  host.running = true;
  host.activeJobs.set(0, { slot: 0, job: { job_id: "already-running" } });
  const leaseCalls = [];
  const startedSlots = [];
  host.client = {
    async lease(_types, slot) {
      leaseCalls.push(slot);
      return { status: "leased", job: { type: "image", job_id: `top-off-${slot}` } };
    },
  };
  host.runSlot = (slot, lease) => {
    startedSlots.push(slot);
    host.activeJobs.set(slot, { slot, job: lease.job });
    return Promise.resolve();
  };
  host.schedule = () => {};

  await host.tick();
  host.nextLeaseAt = 0;
  await host.tick();
  host.activeJobs.delete(1);
  host.nextLeaseAt = 0;
  await host.tick();
  assert.deepEqual(leaseCalls, [1, 2, 1], "the scheduler must immediately top off the first free stable slot instead of waiting for a whole wave");
  assert.deepEqual(startedSlots, [1, 2, 1]);
}

async function testConditionalPersistentWorkerWarmup() {
  const providerCases = [
    {
      provider: GOOGLE_FLOW_BROWSER_PROVIDER,
      freshPolicy: FRESH_GOOGLE_FLOW_PROJECT_PER_JOB_POLICY,
      persistentPolicy: PERSISTENT_GOOGLE_FLOW_PROJECT_PER_SLOT_POLICY,
    },
    {
      provider: GOOGLE_GEMINI_BROWSER_PROVIDER,
      freshPolicy: FRESH_BROWSER_SESSION_PER_JOB_POLICY,
      persistentPolicy: PERSISTENT_BROWSER_TAB_PER_SLOT_POLICY,
    },
  ];
  const hostFixture = (providerCase, suffix, activePolicies) => {
    let prepareCalls = 0;
    const browser = {
      async start() {},
      async waitForAuthentication() {},
      async prepareWorkerSlots() { prepareCalls += 1; },
      async runJob() { return { uiContract: {} }; },
      async close() {},
      workerPoolState() { return { policy: providerCase.persistentPolicy, ready_slots: [] }; },
    };
    const config = assertDesktopConfig(desktopConfig({
      "server-url": "http://127.0.0.1:4317",
      provider: providerCase.provider,
      concurrency: "1",
      types: "image",
      "state-dir": path.join(temporaryRoot, `warmup-${providerCase.provider}-${suffix}-state`),
      "profile-dir": path.join(temporaryRoot, `warmup-${providerCase.provider}-${suffix}-profile`),
      "downloads-root": path.join(temporaryRoot, `warmup-${providerCase.provider}-${suffix}-downloads`),
    }, {}));
    const host = new GoldflowDesktopHost({ config, browser, log: () => {} });
    host.ensureCredentials = async () => {};
    host.reconcileInterruptedJobs = async () => {};
    host.persistRuntime = async () => {};
    host.schedule = () => {};
    host.client = {
      async health() {
        return {
          browser_provider: providerCase.provider,
          active_image_worker_session_policies: activePolicies,
        };
      },
      async heartbeat() {},
      async complete() {},
      async fail() { throw new Error("unexpected warmup fixture failure"); },
    };
    return { host, prepareCalls: () => prepareCalls };
  };

  for (const providerCase of providerCases) {
    const legacy = hostFixture(providerCase, "legacy", [providerCase.freshPolicy]);
    await legacy.host.start();
    assert.equal(legacy.prepareCalls(), 0, `${providerCase.provider} must not prewarm for an active legacy fresh-session manifest`);
    await legacy.host.runSlot(0, {
      job: {
        type: "image",
        job_id: `${providerCase.provider}-legacy-image`,
        worker_session_policy: providerCase.freshPolicy,
      },
    });
    assert.equal(legacy.prepareCalls(), 0, `${providerCase.provider} must not warm persistent pages for a leased legacy item`);
    await legacy.host.runSlot(0, {
      job: {
        type: "image",
        job_id: `${providerCase.provider}-persistent-image-1`,
        worker_session_policy: providerCase.persistentPolicy,
      },
    });
    await legacy.host.runSlot(0, {
      job: {
        type: "image",
        job_id: `${providerCase.provider}-persistent-image-2`,
        worker_session_policy: providerCase.persistentPolicy,
      },
    });
    assert.equal(legacy.prepareCalls(), 1, `${providerCase.provider} must lazily warm its pool once when a v3 lease first arrives`);

    const startupV3 = hostFixture(providerCase, "startup-v3", [providerCase.persistentPolicy]);
    await startupV3.host.start();
    assert.equal(startupV3.prepareCalls(), 1, `${providerCase.provider} must prewarm at startup when an unresolved v3 persistent manifest is already active`);
  }
}

async function testHybridAcceptedReferencePreservation() {
  const referenceDir = path.join(temporaryRoot, "accepted-reference-preservation");
  await fs.mkdir(referenceDir, { recursive: true });
  const imagePath = path.join(referenceDir, "legacy_ref.png");
  await sharp({ create: { width: 160, height: 90, channels: 3, background: "#43516d" } }).png().toFile(imagePath);
  const imageSha256 = await sha256File(imagePath);
  await fs.writeFile(`${imagePath}.metadata.json`, `${JSON.stringify({
    ref_id: "legacy_ref",
    conditioning_image_path: imagePath,
    generated: {
      provider: "chatgpt_web_gpt_image",
      downloaded_path: imagePath,
      source_sha256: imageSha256,
    },
    updated_at: new Date().toISOString(),
  }, null, 2)}\n`);
  const accepted = await materializedReferenceState({
    ref_id: "legacy_ref",
    reference_image_path: imagePath,
  });
  assert.equal(accepted?.imageSha256, imageSha256, "legacy hash-bound ChatGPT references must remain accepted without a newer browser receipt");

  const episodeDir = path.join(temporaryRoot, "accepted-reference-episode");
  const discoveredPath = path.join(episodeDir, "assets", "images", "references", "discovered_ref-chatgpt-web.png");
  await fs.mkdir(path.dirname(discoveredPath), { recursive: true });
  await sharp({ create: { width: 160, height: 90, channels: 3, background: "#744c39" } }).png().toFile(discoveredPath);
  const discoveredSha256 = await sha256File(discoveredPath);
  await fs.writeFile(`${discoveredPath}.metadata.json`, `${JSON.stringify({
    ref_id: "discovered_ref",
    conditioning_image_path: discoveredPath,
    generated: {
      provider: "chatgpt_web_gpt_image",
      downloaded_path: discoveredPath,
      source_sha256: discoveredSha256,
    },
    updated_at: new Date().toISOString(),
  }, null, 2)}\n`);
  const discovered = await materializedReferenceState({
    ref_id: "discovered_ref",
    reference_image_path: null,
  }, { episodeDir });
  assert.equal(discovered?.imageSha256, discoveredSha256, "accepted references must be discovered from hash-bound sidecars when the director plan keeps paths null");

  const flowOnly = hybridManifestDispatchOptions({ flowOnly: true });
  assert.deepEqual(flowOnly.allowedBrowserProviders, [GOOGLE_FLOW_BROWSER_PROVIDER]);
  assert.deepEqual(flowOnly.browserProviderConcurrency, {
    [GOOGLE_FLOW_BROWSER_PROVIDER]: HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY,
  });
  assert.equal(flowOnly.maxConcurrency, HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY);
  assert.deepEqual(flowOnly.browserProviderWorkerSessionPolicy, {
    [GOOGLE_FLOW_BROWSER_PROVIDER]: FRESH_GOOGLE_FLOW_PROJECT_PER_JOB_POLICY,
  }, "legacy Flow-only identities must retain their fresh-project contract");
  assert.equal(validateFlowRuntimeConcurrency(), HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY);
  assert.equal(validateFlowRuntimeConcurrency("4"), 4);
  assert.throws(() => validateFlowRuntimeConcurrency("0"), /integer from 1 to 5/);
  assert.throws(() => validateFlowRuntimeConcurrency("6"), /integer from 1 to 5/);
  assert.throws(() => validateFlowRuntimeConcurrency("2.5"), /integer from 1 to 5/);
  const cappedFlowOnly = hybridManifestDispatchOptions({ flowOnly: true, flowConcurrency: 4 });
  assert.deepEqual(cappedFlowOnly.browserProviderConcurrency, { [GOOGLE_FLOW_BROWSER_PROVIDER]: 4 });
  assert.equal(cappedFlowOnly.maxConcurrency, 4);
  const chatgptOnly = hybridManifestDispatchOptions({ chatgptOnly: true });
  assert.deepEqual(chatgptOnly.allowedBrowserProviders, ["chatgpt"]);
  assert.deepEqual(chatgptOnly.browserProviderConcurrency, {
    chatgpt: HYBRID_CHATGPT_IMAGE_CONCURRENCY,
  });
  assert.equal(chatgptOnly.maxConcurrency, HYBRID_CHATGPT_IMAGE_CONCURRENCY);
  assert.deepEqual(chatgptOnly.browserProviderWorkerSessionPolicy, {
    chatgpt: FRESH_BROWSER_SESSION_PER_JOB_POLICY,
  });
  const federated = hybridManifestDispatchOptions({ federated: true });
  assert.equal(federated.workProvider, FEDERATED_WEB_IMAGE_PROVIDER);
  assert.deepEqual(federated.allowedBrowserProviders, [GOOGLE_FLOW_BROWSER_PROVIDER, GOOGLE_GEMINI_BROWSER_PROVIDER]);
  assert.deepEqual(federated.browserProviderConcurrency, {
    [GOOGLE_FLOW_BROWSER_PROVIDER]: HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY,
    [GOOGLE_GEMINI_BROWSER_PROVIDER]: GOOGLE_GEMINI_IMAGE_CONCURRENCY,
  });
  assert.deepEqual(federated.browserProviderMaxOrderedReferences, {
    [GOOGLE_FLOW_BROWSER_PROVIDER]: 4,
    [GOOGLE_GEMINI_BROWSER_PROVIDER]: 4,
  });
  assert.deepEqual(hybridManifestDispatchOptions({ federated: true, mode: "reference" }).browserProviderMaxOrderedReferences, {
    [GOOGLE_FLOW_BROWSER_PROVIDER]: 4,
    [GOOGLE_GEMINI_BROWSER_PROVIDER]: 4,
  });
  assert.equal(federated.maxConcurrency, FEDERATED_TOTAL_IMAGE_CONCURRENCY);
  assert.deepEqual(federated.browserProviderWorkerSessionPolicy, {
    [GOOGLE_FLOW_BROWSER_PROVIDER]: FRESH_GOOGLE_FLOW_PROJECT_PER_JOB_POLICY,
    [GOOGLE_GEMINI_BROWSER_PROVIDER]: FRESH_BROWSER_SESSION_PER_JOB_POLICY,
  }, "legacy federated manifests must remain replay-compatible");
  const persistentFederated = hybridManifestDispatchOptions({ federated: true, persistentWorkerPool: true });
  assert.deepEqual(persistentFederated.browserProviderWorkerSessionPolicy, {
    [GOOGLE_FLOW_BROWSER_PROVIDER]: PERSISTENT_GOOGLE_FLOW_PROJECT_PER_SLOT_POLICY,
    [GOOGLE_GEMINI_BROWSER_PROVIDER]: PERSISTENT_BROWSER_TAB_PER_SLOT_POLICY,
  }, "new fast-premium manifests must bind five persistent Flow projects and three persistent Gemini tabs");
  assert.deepEqual(
    hybridManifestDispatchOptions({ federated: true, styleOnly: true, persistentWorkerPool: true }).browserProviderWorkerSessionPolicy,
    { [GOOGLE_GEMINI_BROWSER_PROVIDER]: PERSISTENT_BROWSER_TAB_PER_SLOT_POLICY },
    "the Gemini style barrier must use the same persistent slot pool",
  );
  assert.deepEqual(
    hybridManifestDispatchOptions({ federated: true, chatgptOnly: true, persistentWorkerPool: true }).allowedBrowserProviders,
    ["chatgpt"],
    "an approved federated ChatGPT exact-ID fallback must not reopen the full Google queue",
  );
  const cappedFederated = hybridManifestDispatchOptions({ federated: true, flowConcurrency: 4 });
  assert.equal(cappedFederated.browserProviderConcurrency[GOOGLE_FLOW_BROWSER_PROVIDER], 4);
  assert.equal(cappedFederated.maxConcurrency, FEDERATED_TOTAL_IMAGE_CONCURRENCY - 1);
  const legacyFederated = hybridManifestDispatchOptions({ federated: true, federatedChatGptEnabled: true });
  assert.deepEqual(legacyFederated.allowedBrowserProviders, [GOOGLE_FLOW_BROWSER_PROVIDER, GOOGLE_GEMINI_BROWSER_PROVIDER, "chatgpt"]);
  assert.equal(legacyFederated.maxConcurrency, FEDERATED_TOTAL_IMAGE_CONCURRENCY + HYBRID_CHATGPT_IMAGE_CONCURRENCY);
  const federatedStyle = hybridManifestDispatchOptions({ federated: true, styleOnly: true });
  assert.deepEqual(federatedStyle.allowedBrowserProviders, [GOOGLE_GEMINI_BROWSER_PROVIDER]);
  assert.deepEqual(
    hybridManifestDispatchOptions({ styleOnly: true, flowOnly: true }).allowedBrowserProviders,
    [GOOGLE_FLOW_BROWSER_PROVIDER],
    "Flow-primary identities must be able to generate style references without a ChatGPT barrier",
  );
  assert.throws(
    () => hybridManifestDispatchOptions({ flowOnly: true, chatgptOnly: true }),
    /both Flow-only and ChatGPT-only/,
  );
  assert.deepEqual(validateRepairSharedReferenceScope({
    ids: ["approved_style_ref"],
    repairReason: "exact failed reference recovery",
    referencesOnly: true,
  }), ["approved_style_ref"]);
  assert.throws(
    () => validateRepairSharedReferenceScope({ ids: ["approved_style_ref"], referencesOnly: true }),
    /only for exact reference repairs/,
  );
  assert.throws(
    () => validateRepairSharedReferenceScope({ ids: ["approved_style_ref"], repairReason: "repair", referencesOnly: false }),
    /only for exact reference repairs/,
  );

  const recoveryEpisodeDir = path.join(temporaryRoot, "manual-provider-auth-recovery");
  const recoveryRows = [{
    ref_id: "pending_ref",
    generation_mode: "standalone_ref",
    reference_image_path: null,
  }];
  const runIdentityPath = path.join(recoveryEpisodeDir, "run_identity.json");
  const referencePlanPath = path.join(recoveryEpisodeDir, "visual_reference_plan.json");
  const stageReportPath = path.join(recoveryEpisodeDir, "reports", "stages", "reference_generation", "blocked.json");
  const triagePath = path.join(recoveryEpisodeDir, "manual_blocker_triage_reference_generation_ep_01.json");
  await fs.mkdir(path.dirname(stageReportPath), { recursive: true });
  await fs.writeFile(runIdentityPath, `${JSON.stringify({ schema: "goldflow_run_identity_v2", episode: "ep_01" }, null, 2)}\n`);
  await fs.writeFile(referencePlanPath, `${JSON.stringify({ status: "passed", reference_targets: recoveryRows }, null, 2)}\n`);
  await fs.writeFile(stageReportPath, `${JSON.stringify({
    status: "failed",
    command: "imagegen browser-pool",
    stdout_tail: JSON.stringify({
      status: "blocked",
      mode: "reference",
      unsubmitted_asset_ids: ["pending_ref"],
    }),
  }, null, 2)}\n`);
  await fs.writeFile(triagePath, `${JSON.stringify({
    schema: "goldflow_manual_image_provider_auth_recovery_v1",
    status: "approved",
    episode_dir: recoveryEpisodeDir,
    mode: "reference",
    target_provider: "chatgpt",
    preserve_existing_assets: true,
    automatic_cross_provider_failover: false,
    creative_submission_count_per_authorized_asset: 0,
    operator_authorization: "Continue autonomously through exact-ID ChatGPT fallback.",
    authorized_asset_ids: ["pending_ref"],
    run_identity_sha256: await sha256File(runIdentityPath),
    source_artifact_sha256: await sha256File(referencePlanPath),
    blocked_stage_report_path: stageReportPath,
    blocked_stage_report_sha256: await sha256File(stageReportPath),
    supporting_evidence: [],
  }, null, 2)}\n`);
  const recoveryEvidence = await resolveManualProviderAuthRecoveryEvidence({
    episodeDir: recoveryEpisodeDir,
    mode: "reference",
    currentRows: recoveryRows,
    requestedIds: new Set(["pending_ref"]),
    evidencePath: triagePath,
    targetProvider: "chatgpt",
  });
  assert.equal(recoveryEvidence.kind, "manual_provider_auth_unsubmitted_assets");
  assert.deepEqual(recoveryEvidence.authorized_asset_ids, ["pending_ref"]);
  await fs.mkdir(path.join(recoveryEpisodeDir, "assets", "images", "codex_worker_staging", "prior", "attempts", "pending_ref", "attempt-001"), { recursive: true });
  await assert.rejects(
    () => resolveManualProviderAuthRecoveryEvidence({
      episodeDir: recoveryEpisodeDir,
      mode: "reference",
      currentRows: recoveryRows,
      requestedIds: new Set(["pending_ref"]),
      evidencePath: triagePath,
      targetProvider: "chatgpt",
    }),
    /prior creative attempt directory exists/,
  );
}

async function testChatGptSharedVerificationAndPacing() {
  const browser = new ChatGptBrowser({ imageStartIntervalMs: 20 });
  let verificationCalls = 0;
  browser.verifyUiContract = async () => {
    verificationCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { account_plan: "Pro", model_label: "GPT-5", effort_label: "Medium" };
  };
  const contract = { account_plan: "Pro", model_label: "GPT-5", effort_label: "Medium" };
  const firstPage = {};
  const [first, second] = await Promise.all([
    browser.verifyUiContractOnce(firstPage, contract),
    browser.verifyUiContractOnce(firstPage, contract),
  ]);
  assert.deepEqual(first, second);
  assert.equal(verificationCalls, 1, "one ChatGPT page must share an in-flight verification for the same contract");
  await browser.verifyUiContractOnce({}, contract);
  assert.equal(verificationCalls, 2, "each ChatGPT page must independently select and verify its model and effort");

  const startedAt = Date.now();
  await Promise.all([
    browser.waitForImageStartGate(),
    browser.waitForImageStartGate(),
    browser.waitForImageStartGate(),
  ]);
  assert.ok(Date.now() - startedAt >= 35, "ChatGPT image starts must be globally staggered across slots");
}

async function testProductionRuntimeRegressions() {
  const options = studioServerOptionsFromFlags({
    port: "4317",
    provider: "google-flow",
    "flow-plan": "ULTRA",
    "flow-model": "Nano Banana Pro",
  });
  assert.equal(options.port, 4317);
  assert.equal(options.browserProvider, "google-flow");
  assert.equal(options.flowPlanLabel, "ULTRA", "CLI Flow plan must reach the server runtime identity");
  assert.equal(options.flowModelLabel, "Nano Banana Pro", "CLI Flow model must reach the server runtime identity");

  const directRateLimit = chatGptImageFailureDisposition(new Error("ChatGPT rate limit: too many requests are being made too quickly."));
  assert.equal(directRateLimit.action, "defer", "an account throttle must not consume a creative image attempt");
  assert.equal(directRateLimit.cooldownMs, 900_000);
  const recordedCooldown = chatGptImageFailureDisposition(new Error("ChatGPT Web cooldown active for 42 more seconds before image generation."));
  assert.equal(recordedCooldown.action, "defer");
  assert.equal(recordedCooldown.cooldownMs, 43_000);
  const creativeFailure = chatGptImageFailureDisposition(new Error("image generation returned no asset"));
  assert.equal(creativeFailure.action, "fail");
}

const tests = [
  ["durable LLM job policy", testLlmStore],
  ["durable Flow video job policy", testMediaJobStore],
  ["Goldflow image contract bridge", testImageBridge],
  ["Google Flow reference receipt gate", testGoogleFlowReferenceReceiptGate],
  ["provider-attributed shared image manifest", testProviderAttributedSharedImageManifest],
  ["localhost API and planner adapter", testServerAndRunner],
  ["provider-bound worker isolation", testProviderIsolation],
  ["extension permission boundary", testExtensionPermissions],
  ["desktop browser host contract", testDesktopHostContract],
  ["persistent Flow worker pool", testPersistentFlowWorkerPool],
  ["desktop provider circuit breaker", testDesktopProviderCircuitBreaker],
  ["desktop topped-off scheduling", testDesktopTopOffScheduling],
  ["conditional persistent worker warmup", testConditionalPersistentWorkerWarmup],
  ["hybrid accepted-reference preservation", testHybridAcceptedReferencePreservation],
  ["ChatGPT shared verification and pacing", testChatGptSharedVerificationAndPacing],
  ["production runtime regression guards", testProductionRuntimeRegressions],
];

try {
  for (const [name, test] of tests) {
    await test();
    process.stdout.write(`PASS ${name}\n`);
  }
  process.stdout.write(`PASS ${tests.length} Goldflow Studio suites\n`);
} finally {
  process.env = { ...originalEnvironment };
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
