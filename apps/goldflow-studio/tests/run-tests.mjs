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
  GOOGLE_FLOW_BROWSER_PROVIDER,
  GOOGLE_GEMINI_BROWSER_PROVIDER,
  GOOGLE_GEMINI_IMAGE_CONCURRENCY,
  HYBRID_CHATGPT_IMAGE_CONCURRENCY,
  HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY,
  HYBRID_TOTAL_IMAGE_CONCURRENCY,
  HYBRID_WEB_FLOW_PROVIDER,
} from "../../../scripts/lib/image-provider-policy.mjs";
import {
  assertHostRuntime,
  chatGptImageFailureDisposition,
  hybridManifestDispatchOptions,
  materializedReferenceState,
  validateRepairSharedReferenceScope,
} from "../../../scripts/hybrid-browser-image-pool.mjs";
import { loginMarkerExists, loginVerificationMarkerPath, markLoginVerified } from "../desktop/browser-login.mjs";
import { ChatGptBrowser } from "../desktop/chatgpt-browser.mjs";
import { assertDesktopConfig, desktopConfig, normalizeBrowserProvider, parseDesktopFlags } from "../desktop/config.mjs";
import { flowBlockingCode, GoogleFlowBrowser, normalizeFlowPromptText, validateFlowReferenceDock } from "../desktop/google-flow-browser.mjs";
import { DesktopRuntimeState } from "../desktop/runtime-state.mjs";
import { validReferenceRoute } from "../desktop/worker-client.mjs";
import { GoldflowBridge, validateGoogleFlowReferenceBinding } from "../lib/goldflow-bridge.mjs";
import { chatGptEffortLabel, chatGptEffortSliderIndex, chatGptUiContractForLlmJob } from "../lib/chatgpt-ui-contract.mjs";
import { LlmJobStore } from "../lib/llm-job-store.mjs";
import { MediaJobStore } from "../lib/media-job-store.mjs";
import { createStudioServer, providerFailurePausesDispatch, studioServerOptionsFromFlags } from "../server.mjs";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-studio-tests-"));
const originalEnvironment = { ...process.env };

assert.equal(providerFailurePausesDispatch("content_policy_rejected"), false, "one asset rejection must not pause its provider queue");
assert.equal(providerFailurePausesDispatch("ui_contract_mismatch"), true, "a provider UI-contract break must pause dispatch");

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
  const first = await store.createOrGet({ model: "gpt-test", messages: [{ role: "user", content: "Return one word." }] });
  const duplicate = await store.createOrGet({ model: "gpt-test", messages: [{ role: "user", content: "Return one word." }] });
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(first.job.job_id, duplicate.job.job_id);
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
  await assert.rejects(() => store.createOrGet({ ...request, references: [] }), /exactly one first-frame reference/);

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
      body: { model: "gpt-5.6-sol", messages: [{ role: "user", content: "Return TEST_OK." }], metadata: { stage_name: "server-test", reasoning_effort: "max" } },
    });
    const lease = await waitForLease(studio.url, workerToken);
    assert.match(lease.job.prompt, /Return TEST_OK/);
    assert.equal(lease.ui_contract.effort_label, "Pro");
    const completed = await jsonRequest(`${studio.url}/v1/worker/complete`, {
      method: "POST",
      token: workerToken,
      body: { type: "llm", jobId: lease.job.job_id, leaseToken: lease.job.lease_token, slot: 0, content: "TEST_OK" },
    });
    assert.equal(completed.response.status, 200);
    const completion = await completionPromise;
    assert.equal(completion.value.choices[0].message.content, "TEST_OK");

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
  assert.equal(chatGptUiContractForLlmJob({ account_plan: "Pro", model_label: "GPT-5.6 Sol", effort_label: "Medium" }, {
    request: { reasoning_effort: "max" },
  }).effort_label, "Pro");
  const flags = parseDesktopFlags(["--server-url", "http://127.0.0.1:4317", "--concurrency", "5", "--types", "llm,image"]);
  const config = assertDesktopConfig(desktopConfig({
    ...flags,
    "state-dir": path.join(temporaryRoot, "desktop-state"),
    "profile-dir": path.join(temporaryRoot, "desktop-profile"),
    "downloads-root": path.join(temporaryRoot, "desktop-downloads"),
  }, {}));
  assert.equal(config.concurrency, 5);
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
  assert.equal(desktopConfig({ ...flowConfig, provider: "google-flow", concurrency: "20" }, {}).concurrency, 20);
  assert.equal(desktopConfig({ ...flowConfig, provider: "google-flow", concurrency: "21" }, {}).concurrency, 20);
  assert.equal(desktopConfig({ ...config, provider: "chatgpt", concurrency: "20" }, {}).concurrency, 5);
  assert.throws(() => assertDesktopConfig({ ...flowConfig, types: ["llm", "image"] }), /image or video work/);
  assert.throws(() => assertDesktopConfig({ ...flowConfig, concurrency: 2, flowProjectUrl: "https://labs.google/fx/tools/flow/project/example" }), /fresh project per job/);
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
  assert.match(browserSource, /Create image/, "desktop host must select the explicit ChatGPT image surface");
  assert.match(flowBrowserSource, /navigator\.clipboard\.writeText/, "Flow prompts must use the real clipboard-paste path that enables Create");
  assert.match(flowBrowserSource, /baseline = new Set/, "Flow completion must distinguish generated output from uploaded references");
  assert.match(flowBrowserSource, /baselineImageFingerprints/, "Flow completion must detect generated pixels when the provider reuses an existing media URL");
  assert.match(flowBrowserSource, /browserProvider: "google-flow"/, "Flow receipts must identify their browser provider");
  assert.match(flowBrowserSource, /project_url: page\.url\(\)/, "Flow receipts must preserve the exact project URL for duplicate-safe recovery");
  assert.match(hostSource, /lease_ambiguous/, "desktop restart recovery must fail closed rather than resubmit");
  assert.match(hostSource, /this\.persistQueue\.then/, "desktop runtime snapshots must preserve call order so completed jobs cannot remain falsely active");
  assert.match(hostSource, /this\.stopStarted/, "desktop host must close browser resources even when startup fails");
  assert.match(configSource, /browserProvider === "google-flow" \? 20 : 5/, "Flow may test twenty slots while ChatGPT retains its five-slot ceiling");
  assert.match(launcher, /desktop\/main\.mjs/, "Finder launcher must start the supervised desktop host");
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
  const chatgptOnly = hybridManifestDispatchOptions({ chatgptOnly: true });
  assert.deepEqual(chatgptOnly.allowedBrowserProviders, ["chatgpt"]);
  assert.deepEqual(chatgptOnly.browserProviderConcurrency, {
    chatgpt: HYBRID_CHATGPT_IMAGE_CONCURRENCY,
  });
  assert.equal(chatgptOnly.maxConcurrency, HYBRID_CHATGPT_IMAGE_CONCURRENCY);
  const federated = hybridManifestDispatchOptions({ federated: true });
  assert.equal(federated.workProvider, FEDERATED_WEB_IMAGE_PROVIDER);
  assert.deepEqual(federated.allowedBrowserProviders, [GOOGLE_FLOW_BROWSER_PROVIDER, GOOGLE_GEMINI_BROWSER_PROVIDER, "chatgpt"]);
  assert.deepEqual(federated.browserProviderConcurrency, {
    [GOOGLE_FLOW_BROWSER_PROVIDER]: HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY,
    [GOOGLE_GEMINI_BROWSER_PROVIDER]: GOOGLE_GEMINI_IMAGE_CONCURRENCY,
    chatgpt: HYBRID_CHATGPT_IMAGE_CONCURRENCY,
  });
  assert.equal(federated.maxConcurrency, FEDERATED_TOTAL_IMAGE_CONCURRENCY);
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
  const [first, second] = await Promise.all([
    browser.verifyUiContractOnce({}, contract),
    browser.verifyUiContractOnce({}, contract),
  ]);
  assert.deepEqual(first, second);
  assert.equal(verificationCalls, 1, "concurrent ChatGPT slots must share one account/model verification");

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
