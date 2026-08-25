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
const specs = providerLaneSpecs(identity, profile, { stateRoot: "/tmp/goldflow-readiness-test" });
assert.equal(specs.length, 2);
assert.equal(specs[0].provider, "google-flow");
assert.equal(specs[0].concurrency, 5);
assert.equal(specs[1].provider, "google-gemini");
assert.equal(specs[1].concurrency, 3);

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
      worker_pool: {
        policy: spec.worker_session_policy,
        prepared_session_policies: [spec.worker_session_policy],
        ready_slots: Array.from({ length: spec.concurrency }, (_, slot) => ({ slot })),
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
  });
  assert.equal(lane.status, "passed");
  assert.equal(lane.findings.length, 0);
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
});
assert.equal(blockedGemini.status, "blocked");
assert.equal(blockedGemini.findings.some((row) => row.code === "health_model_mismatch"), true);

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
});
assert.equal(slo.elapsed_minutes, 110);
assert.equal(slo.checkpoints.find((row) => row.id === "audio_semantic_join").state, "passed");
assert.equal(slo.checkpoints.find((row) => row.id === "first_scene_wave_leased").state, "pending");
assert.equal(slo.state, "on_track");

console.log("provider readiness tests passed");
