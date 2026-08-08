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
import { loginMarkerExists, loginVerificationMarkerPath, markLoginVerified } from "../desktop/browser-login.mjs";
import { assertDesktopConfig, desktopConfig, parseDesktopFlags } from "../desktop/config.mjs";
import { DesktopRuntimeState } from "../desktop/runtime-state.mjs";
import { validReferenceRoute } from "../desktop/worker-client.mjs";
import { GoldflowBridge } from "../lib/goldflow-bridge.mjs";
import { LlmJobStore } from "../lib/llm-job-store.mjs";
import { createStudioServer } from "../server.mjs";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-studio-tests-"));
const originalEnvironment = { ...process.env };

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

async function testImageBridge() {
  const dataRoot = path.join(temporaryRoot, "data");
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "proof", "episodes", "ep_01");
  const stateDir = path.join(temporaryRoot, "image-state");
  const downloadsRoot = path.join(temporaryRoot, "downloads");
  await fs.mkdir(episodeDir, { recursive: true });
  const promptsPath = path.join(episodeDir, "section_image_prompts_hardened.json");
  await fs.writeFile(promptsPath, `${JSON.stringify({
    status: "passed",
    image_provider: "codex_imagegen",
    prompts: [{ image_id: "cut_001", image_generation_required: true, codex_image_prompt: "A precise landscape test frame.", reference_slots: [] }],
  }, null, 2)}\n`);
  const bridge = await new GoldflowBridge({ repoRoot, dataRoot, stateDir, downloadsRoot }).init();
  const created = await bridge.createManifest({ episodeDir, mode: "scene", imageIds: ["cut_001"], concurrency: 2 });
  assert.equal(created.item_count, 1);
  const leased = await bridge.leaseImage("image-worker");
  assert.equal(leased.job.asset_id, "cut_001");
  const downloadPath = path.join(downloadsRoot, "source-image.webp");
  await fs.mkdir(downloadsRoot, { recursive: true });
  await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#d94f2b" } }).webp().toFile(downloadPath);
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

    const completionPromise = jsonRequest(`${studio.url}/v1/chat/completions`, {
      method: "POST",
      token: studio.adminToken,
      body: { model: "gpt-5.6-sol", messages: [{ role: "user", content: "Return TEST_OK." }], metadata: { stage_name: "server-test" } },
    });
    const lease = await waitForLease(studio.url, workerToken);
    assert.match(lease.job.prompt, /Return TEST_OK/);
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

async function testExtensionPermissions() {
  const manifest = JSON.parse(await fs.readFile(path.join(repoRoot, "apps", "goldflow-studio", "extension", "manifest.json"), "utf8"));
  const contentWorker = await fs.readFile(path.join(repoRoot, "apps", "goldflow-studio", "extension", "content.js"), "utf8");
  const backgroundWorker = await fs.readFile(path.join(repoRoot, "apps", "goldflow-studio", "extension", "background.js"), "utf8");
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.host_permissions.sort(), ["http://127.0.0.1/*", "https://chatgpt.com/*"].sort());
  assert.match(contentWorker, /accounts-profile-button/, "account verification must support ChatGPT's role-button profile control");
  assert.match(contentWorker, /new PointerEvent\("pointerdown"/, "power-menu verification must use ChatGPT's pointer-trigger contract");
  assert.match(contentWorker, /querySelectorAll\([^\n]+\)\]\s*\.find\(visible\)/, "composer discovery must ignore ChatGPT's hidden fallback textarea");
  assert.match(contentWorker, /effortLabel === "Pro"[\s\S]+effortLabel === "Medium"/, "worker must select benchmarked Pro and Medium effort contracts explicitly");
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
  assert.match(hostSource, /lease_ambiguous/, "desktop restart recovery must fail closed rather than resubmit");
  assert.match(hostSource, /this\.stopStarted/, "desktop host must close browser resources even when startup fails");
  assert.match(configSource, /Math\.min\(5/, "desktop worker must retain the five-slot safety boundary");
  assert.match(launcher, /desktop\/main\.mjs/, "Finder launcher must start the supervised desktop host");
}

const tests = [
  ["durable LLM job policy", testLlmStore],
  ["Goldflow image contract bridge", testImageBridge],
  ["localhost API and planner adapter", testServerAndRunner],
  ["extension permission boundary", testExtensionPermissions],
  ["desktop browser host contract", testDesktopHostContract],
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
