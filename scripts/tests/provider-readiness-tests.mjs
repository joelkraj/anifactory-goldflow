import assert from "node:assert/strict";

import { productionProfileById } from "../lib/production-profiles.mjs";
import {
  inspectProviderLane,
  providerLaneSpecs,
  providerReadinessDecision,
} from "../lib/provider-readiness.mjs";
import { buildProductionSloState } from "../lib/production-slo.mjs";

const identity = {
  image_provider_options: {
    google_flow: { plan_label: "ULTRA", model_label: "Nano Banana Pro" },
    google_gemini: { plan_label: "Ultra", model_label: "Nano Banana 2" },
  },
};
const profile = productionProfileById("fast_premium_v2");
const nowMs = Date.parse("2026-08-27T12:00:00.000Z");
const specs = providerLaneSpecs(identity, profile, { stateRoot: "/tmp/goldflow-readiness-test" });
assert.equal(specs.length, 2);
assert.equal(specs[0].provider, "google-flow");
assert.equal(specs[0].concurrency, 5);
assert.equal(specs[1].provider, "google-gemini");
assert.equal(specs[1].concurrency, 3);
assert.equal(specs[1].runtime_freshness_max_ms, 60_000);

function passedRuntime(spec, filePath) {
  if (filePath === spec.studio_runtime_path) {
    return {
      status: "running",
      pid: 101,
      port: spec.port,
      browser_provider: spec.provider,
    };
  }
  if (filePath === spec.worker_runtime_path) {
    return {
      status: "running",
      pid: 102,
      browser_provider: spec.provider,
      concurrency: spec.concurrency,
      updated_at: new Date(nowMs - 15_000).toISOString(),
      worker_pool: {
        policy: spec.worker_session_policy,
        prepared_session_policies: [spec.worker_session_policy],
        ready_slots: Array.from({ length: spec.concurrency }, (_, slot) => spec.provider === "google-flow"
          ? { slot, project_url: `https://labs.google/fx/tools/flow/project/slot-${slot}/edit` }
          : { slot, surface_url: "https://gemini.google.com/images" }),
      },
      dispatch_policy: { provider_circuit: null },
    };
  }
  return null;
}

for (const spec of specs) {
  const lane = await inspectProviderLane(spec, {
    readJsonImpl: async (filePath) => passedRuntime(spec, filePath),
    processLiveImpl: () => true,
    fetchHealthImpl: async () => ({
      status: "ok",
      service: "goldflow-studio",
      browser_provider: spec.provider,
      ui_contract: { account_plan: spec.plan_label, model_label: spec.model_label },
      active_image_worker_session_policies: [spec.worker_session_policy],
    }),
    nowMs,
  });
  assert.equal(lane.status, "passed");
  assert.equal(lane.findings.length, 0);
}

// Ready slots may retain the legacy Flow workspace or use the current domain.
// A homepage, lookalike host, or missing project id is not a prepared workspace.
for (const [projectUrl, expectedReady] of [
  ["https://labs.google/fx/tools/flow/project/worker-1", true],
  ["https://labs.google/fx/tools/flow/project/worker-1/edit", true],
  ["https://flow.google.com/project/worker-1", true],
  ["https://flow.google.com/project/worker-1/edit", true],
  ["https://flow.google.com/", false],
  ["https://flow.google.com/project/", false],
  ["https://labs.google/fx/tools/flow/project/", false],
  ["https://flow.google.com/unrelated/project/worker-1", false],
  ["https://flow.google.com.evil.example/project/worker-1", false],
  ["https://flow.google.com@evil.example/project/worker-1", false],
  ["http://flow.google.com/project/worker-1", false],
  ["not a URL", false],
]) {
  const spec = specs[0];
  const lane = await inspectProviderLane(spec, {
    readJsonImpl: async (filePath) => {
      const value = passedRuntime(spec, filePath);
      if (filePath === spec.worker_runtime_path) {
        value.worker_pool.ready_slots = value.worker_pool.ready_slots.map((row) => ({
          ...row,
          project_url: projectUrl,
        }));
      }
      return value;
    },
    processLiveImpl: () => true,
    fetchHealthImpl: async () => ({
      status: "ok",
      service: "goldflow-studio",
      browser_provider: spec.provider,
      ui_contract: { account_plan: spec.plan_label, model_label: spec.model_label },
    }),
    nowMs,
  });
  assert.equal(lane.status, expectedReady ? "passed" : "blocked", projectUrl);
  assert.deepEqual(lane.findings.map((row) => row.code), expectedReady ? [] : ["worker_slot_surface_not_ready"], projectUrl);
}

// A successful image result stays in its persistent conversation until the
// next job resets it. Readiness must not reject this ordinary idle state.
for (const [surfaceUrl, expectedReady] of [
  ["https://gemini.google.com/images", true],
  ["https://gemini.google.com/images?hl=en#home", true],
  ["https://gemini.google.com/app/92bd90b80ff7335c", true],
  ["https://gemini.google.com/app/abc123/?hl=en#result", true],
  ["https://gemini.google.com/app", false],
  ["https://gemini.google.com/app/", false],
  ["https://gemini.google.com/auth", false],
  ["https://gemini.google.com/app/auth", false],
  ["https://gemini.google.com/app/signin", false],
  ["https://accounts.google.com/signin", false],
  ["https://gemini.google.com/app/abc123/settings", false],
  ["https://gemini.google.com.evil.example/app/abc123", false],
  ["https://gemini.google.com@evil.example/app/abc123", false],
  ["http://gemini.google.com/app/abc123", false],
  ["not a URL", false],
]) {
  const spec = specs[1];
  const lane = await inspectProviderLane(spec, {
    readJsonImpl: async (filePath) => {
      const value = passedRuntime(spec, filePath);
      if (filePath === spec.worker_runtime_path) {
        value.worker_pool.ready_slots = value.worker_pool.ready_slots.map(row => ({ ...row, surface_url: surfaceUrl }));
      }
      return value;
    },
    processLiveImpl: () => true,
    fetchHealthImpl: async () => ({
      status: "ok", service: "goldflow-studio", browser_provider: spec.provider,
      ui_contract: { account_plan: spec.plan_label, model_label: spec.model_label },
    }),
    nowMs,
  });
  assert.equal(lane.status, expectedReady ? "passed" : "blocked", surfaceUrl);
  assert.deepEqual(lane.findings.map(row => row.code), expectedReady ? [] : ["worker_slot_surface_not_ready"], surfaceUrl);
}

const blockedGemini = await inspectProviderLane(specs[1], {
  readJsonImpl: async (filePath) => passedRuntime(specs[1], filePath),
  processLiveImpl: () => true,
  fetchHealthImpl: async () => ({
    status: "ok",
    service: "goldflow-studio",
    browser_provider: "google-gemini",
    ui_contract: { account_plan: "Ultra", model_label: "wrong-model" },
  }),
  nowMs,
});
assert.equal(blockedGemini.status, "blocked");
assert.equal(blockedGemini.findings.some((row) => row.code === "health_model_mismatch"), true);

const staleFlow = await inspectProviderLane(specs[0], {
  readJsonImpl: async (filePath) => {
    const value = passedRuntime(specs[0], filePath);
    return filePath === specs[0].worker_runtime_path
      ? { ...value, updated_at: new Date(nowMs - 61_000).toISOString() }
      : value;
  },
  processLiveImpl: () => true,
  fetchHealthImpl: async () => ({
    status: "ok",
    service: "goldflow-studio",
    browser_provider: "google-flow",
    ui_contract: { account_plan: "ULTRA", model_label: "Nano Banana Pro" },
  }),
  nowMs,
});
assert.equal(staleFlow.status, "blocked");
assert.equal(staleFlow.findings.some((row) => row.code === "worker_runtime_stale"), true);

const flowPassed = { provider: "google-flow", status: "passed" };
const geminiBlocked = { provider: "google-gemini", status: "blocked" };
assert.deepEqual(
  providerReadinessDecision([flowPassed, geminiBlocked], { phase: "reference_generation" }),
  {
    status: "blocked",
    phase: "reference_generation",
    flow_ready: true,
    gemini_ready: false,
    style_reference_barrier_pending: true,
    blocking_providers: ["google-gemini"],
    dispatch_policy: "flow_deadline_primary_only",
  },
);
assert.equal(providerReadinessDecision([flowPassed, geminiBlocked], { phase: "image_generation" }).status, "degraded");
assert.equal(providerReadinessDecision([{ provider: "google-flow", status: "blocked" }, { provider: "google-gemini", status: "passed" }], { phase: "image_generation" }).status, "blocked");

const slo = buildProductionSloState({
  runStatus: {
    current_stage: "reference_generation",
    stage_ledger: [
      { stage: "timing_bind", state: "passed" },
      { stage: "reference_plan_approval", state: "passed" },
      { stage: "upload_packaging", state: "missing" },
    ],
  },
  profile,
  startedAt: "2026-08-23T12:00:00.000Z",
  now: new Date("2026-08-23T13:50:00.000Z"),
  healthReady: true,
});
assert.equal(slo.elapsed_minutes, 110);
assert.equal(slo.checkpoints.find((row) => row.id === "audio_semantic_join").state, "passed");
assert.equal(slo.checkpoints.find((row) => row.id === "first_scene_wave_leased").state, "pending");
assert.equal(slo.state, "on_track");

const slowHealthSlo = buildProductionSloState({
  runStatus: { current_stage: "semantic_scene_plan", stage_ledger: [] },
  profile,
  startedAt: "2026-08-23T12:00:00.000Z",
  now: new Date("2026-08-23T12:11:00.000Z"),
  healthReady: false,
});
assert.equal(slowHealthSlo.checkpoints.find((row) => row.id === "health_ready").state, "missed");
assert.equal(slowHealthSlo.state, "at_risk");

console.log("provider readiness tests passed");
