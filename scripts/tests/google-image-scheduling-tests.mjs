import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { googleImageSchedulingPolicy, googleImageSchedulingForIdentity } from "../lib/google-image-scheduling.mjs";
import { federatedWebImageIdentityOptions, federatedWebImageProviderLocks, federatedWebImageConcurrencyForIdentity, federatedWebImageIdentityStatus, loadGoogleFlowHealthProof } from "../lib/image-provider-policy.mjs";
import { hybridManifestDispatchOptions, monitoredProviderRuntimes, assertHostRuntime } from "../hybrid-browser-image-pool.mjs";
import { createCodexWorkManifest, leaseNextWorkItem } from "../lib/codex-image-work-contract.mjs";
import { providerLaneSpecs, inspectProviderLane } from "../lib/provider-readiness.mjs";
import { productionProfileById } from "../lib/production-profiles.mjs";
import { desktopConfig } from "../../apps/goldflow-studio/desktop/config.mjs";
import { GoogleSubmitGate } from "../../apps/goldflow-studio/desktop/google-submit-gate.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-three-lane-test-"));
const writeJson = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value)); };
try {
  const options = federatedWebImageIdentityOptions({ healthProof: { path: "/fixture/proof.json", sha256: "a".repeat(64) }, schedulingPolicy: "conservative_three_lane_v1" });
  const identity = { image_provider: "federated_google_web_image_pool", image_provider_options: options, provider_locks: federatedWebImageProviderLocks(options) };
  const schedule = googleImageSchedulingForIdentity(identity);
  assert.equal(federatedWebImageConcurrencyForIdentity(identity), 3);
  assert.equal(options.google_flow.concurrency, 2);
  assert.equal(options.google_gemini.concurrency, 1);
  assert.equal(identity.provider_locks.federated_google_primary_concurrency, 3);
  const verifiedOptions = federatedWebImageIdentityOptions({ healthProof: await loadGoogleFlowHealthProof(), schedulingPolicy: "conservative_three_lane_v1" });
  assert.equal((await federatedWebImageIdentityStatus({ image_provider: identity.image_provider, image_provider_options: verifiedOptions, provider_locks: federatedWebImageProviderLocks(verifiedOptions) })).done, true, "the opt-in identity passes the production identity validator with the retained health proof");
  assert.throws(() => googleImageSchedulingPolicy("unknown"), /Unsupported/);
  const tampered = structuredClone(identity);
  tampered.provider_locks.image_scheduling.total_concurrency = 8;
  assert.throws(() => googleImageSchedulingForIdentity(tampered), /mismatch/);
  delete tampered.image_provider_options.scheduling;
  assert.throws(() => googleImageSchedulingForIdentity(tampered), /missing/);
  const legacyOptions = federatedWebImageIdentityOptions({ healthProof: { path: "/fixture/proof.json", sha256: "a".repeat(64) } });
  const legacy = { image_provider: identity.image_provider, image_provider_options: legacyOptions, provider_locks: federatedWebImageProviderLocks(legacyOptions) };
  assert.equal(googleImageSchedulingForIdentity(legacy), null);
  assert.equal(federatedWebImageConcurrencyForIdentity(legacy), 8);
  assert.equal(legacyOptions.google_flow.concurrency, 5);
  assert.equal(legacyOptions.google_gemini.concurrency, 3);
  assert.equal(hybridManifestDispatchOptions({ federated: true }).maxConcurrency, 8);
  assert.equal(desktopConfig({}, {}).googleSubmitIntervalMs, 30_000);
  assert.equal(desktopConfig({}, {}).googleSubmitJitterMaxMs, 0);
  assert.equal(desktopConfig({ "google-submit-interval-ms": "45000", "google-submit-jitter-max-ms": "5000" }, {}).googleSubmitJitterMaxMs, 5_000);

  for (const mode of ["reference", "scene"]) {
    const dispatch = hybridManifestDispatchOptions({ federated: true, googleScheduling: schedule, persistentWorkerPool: true, mode });
    assert.equal(dispatch.maxConcurrency, 3);
    assert.deepEqual(dispatch.browserProviderConcurrency, { "google-flow": 2, "google-gemini": 1 });
    assert.equal(hybridManifestDispatchOptions({ federated: true, googleScheduling: schedule, styleOnly: true, mode }).maxConcurrency, 1);
    assert.equal(hybridManifestDispatchOptions({ federated: true, googleScheduling: schedule, geminiOnly: true, mode }).maxConcurrency, 1);
    assert.equal(hybridManifestDispatchOptions({ federated: true, googleScheduling: schedule, flowOnly: true, mode }).maxConcurrency, 2);
  }
  assert.throws(() => hybridManifestDispatchOptions({ federated: true, googleScheduling: schedule, flowConcurrency: 3 }), /exceeds/);
  const runtimes = [{ provider: "google-flow" }, { provider: "google-gemini" }];
  assert.equal(monitoredProviderRuntimes(runtimes, { federated: true }).length, 1);
  assert.equal(monitoredProviderRuntimes(runtimes, { federated: true, schedulingRequired: true }).length, 2);

  const episodeDir = path.join(root, "episode");
  const promptsPath = path.join(episodeDir, "prompts.json");
  const ids = ["cut_1", "cut_2", "cut_3", "cut_4"];
  await writeJson(promptsPath, { status: "passed", image_provider: identity.image_provider, prompts: ids.map((image_id) => ({ image_id, provider_prompt: `Landscape image ${image_id}.`, reference_slots: [] })) });
  const created = await createCodexWorkManifest({ mode: "scene", episodeDir, promptsPath, imageIds: ids, maxAttempts: 1, ...hybridManifestDispatchOptions({ federated: true, googleScheduling: schedule, persistentWorkerPool: true }) });
  const manifestPath = created.manifest.manifest_path;
  const leased = await Promise.all(["google-flow", "google-flow", "google-gemini", "google-flow", "google-gemini"].map((browserProvider, i) => leaseNextWorkItem({ manifestPath, browserProvider, workerId: `worker_${i}` })));
  assert.equal(leased.filter((row) => row.status === "leased").length, 3, "concurrent provider processes share a global three-lease ceiling");
  for (const browserProvider of ["google-flow", "google-gemini"]) {
    assert.equal((await leaseNextWorkItem({ manifestPath, browserProvider, workerId: `extra_${browserProvider}` })).no_work_reason, "max_concurrency_reached");
  }
  assert.equal(created.manifest.policy.max_attempts, 1);

  const specs = providerLaneSpecs(identity, productionProfileById("fast_premium_v2"), { stateRoot: root });
  assert.deepEqual(specs.map((spec) => spec.concurrency), [2, 1]);
  assert.equal(specs[0].google_submit_gate_dir, specs[1].google_submit_gate_dir);
  assert.ok(specs.every((spec) => spec.worker_types === "image"));
  for (const spec of specs) {
    const worker = { status: "running", pid: process.pid, browser_provider: spec.provider, concurrency: spec.concurrency, types: ["image"], updated_at: new Date().toISOString(), worker_pool: { policy: spec.worker_session_policy, prepared_session_policies: [spec.worker_session_policy], ready_slots: Array.from({ length: spec.concurrency }, (_, slot) => spec.provider === "google-flow" ? { slot, project_url: `https://labs.google/fx/tools/flow/project/${slot}` } : { slot, surface_url: "https://gemini.google.com/images" }) }, dispatch_policy: { google_submit_gate_dir: spec.google_submit_gate_dir, google_submit_interval_ms: 45_000, google_submit_jitter_max_ms: 5_000 } };
    const health = { status: "ok", service: "goldflow-studio", browser_provider: spec.provider, ui_contract: { account_plan: spec.plan_label, model_label: spec.model_label } };
    const studio = { status: "running", pid: process.pid, port: spec.port, browser_provider: spec.provider, ui_contract: health.ui_contract };
    const inspect = (candidate) => inspectProviderLane(spec, { readJsonImpl: async (file) => file === spec.worker_runtime_path ? candidate : studio, processLiveImpl: () => true, fetchHealthImpl: async () => health });
    assert.equal((await inspect(worker)).status, "passed");
    const badVariants = [
      { ...worker, concurrency: spec.provider === "google-flow" ? 5 : 3 },
      { ...worker, dispatch_policy: { ...worker.dispatch_policy, google_submit_interval_ms: 30_000 } },
      { ...worker, dispatch_policy: { ...worker.dispatch_policy, google_submit_jitter_max_ms: 0 } },
      { ...worker, dispatch_policy: { ...worker.dispatch_policy, google_submit_gate_dir: "/different/account" } },
      { ...worker, types: ["llm", "image"] },
    ];
    for (const candidate of badVariants) assert.equal((await inspect(candidate)).status, "blocked");

    const server = http.createServer((_req, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(health)); });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await writeJson(spec.studio_runtime_path, { ...studio, host: "127.0.0.1", port: server.address().port });
      await writeJson(spec.worker_runtime_path, worker);
      const hostOptions = { expectedPlanLabel: spec.plan_label, expectedModelLabel: spec.model_label, requirePreparedWorkerPool: true, expectedConcurrency: spec.concurrency, googleScheduling: schedule };
      await assertHostRuntime(spec.studio_runtime_path, spec.provider, hostOptions);
      for (const candidate of badVariants) {
        await writeJson(spec.worker_runtime_path, candidate);
        await assert.rejects(() => assertHostRuntime(spec.studio_runtime_path, spec.provider, hostOptions), /not production-ready|does not match/);
      }
    } finally { await new Promise((resolve) => server.close(resolve)); }
  }

  const gate = new GoogleSubmitGate({ directory: path.join(root, "real-interval"), intervalMs: 45_000, jitterMaxMs: 5_000, sampleJitter: () => 5_000 });
  const receipt = await gate.submit({ provider: "google-flow", jobId: "jitter-bound", click: async () => {} });
  assert.equal(receipt.interval_ms, 45_000);
  assert.equal(receipt.jitter_ms, 5_000);
  assert.equal(receipt.spacing_ms, 50_000);
  const state = JSON.parse(await fs.readFile(gate.statePath, "utf8"));
  assert.equal(state.next_submit_at - Date.parse(receipt.click_finished_at), 50_000);
  console.log("Google conservative image scheduling tests passed (identity, defaults, provider/global caps, host checks, jitter).");
} finally { await fs.rm(root, { recursive: true, force: true }); }
