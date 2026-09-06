import assert from "node:assert/strict";
import test from "node:test";
import {
  googleManifestActivationConflict,
  manifestHasRunnableWork,
} from "../../apps/goldflow-studio/lib/goldflow-bridge.mjs";
import { manifestQueueStopReason } from "../hybrid-browser-image-pool.mjs";

const snapshot = (overrides = {}) => ({
  status: "blocked_deadletter",
  counts: { pending: 6, leased: 0, completed: 18, deadlettered: 2 },
  verification_wave: { required: true, status: "passed", asset_ids: ["first"] },
  items: [{ asset_id: "first", status: "completed" }, { asset_id: "failed", status: "deadlettered" }],
  ...overrides,
});

test("isolated failures do not stop runnable pending work during any stagger", () => {
  for (const idleMs of [0, 15000, 30000, 45000, 60000]) {
    assert.equal(manifestQueueStopReason(snapshot({ idleMs })), null);
  }
});
test("drained failures and complete queues finish", () => {
  assert.equal(manifestQueueStopReason(snapshot({ counts: { pending: 0, leased: 0, completed: 18, deadlettered: 2 } })), "drained_deadletters");
  assert.equal(manifestQueueStopReason(snapshot({ status: "completed" })), "completed");
});
test("a failed required verification wave stops without spending on the rest", () => {
  const failed = snapshot({ verification_wave: { required: true, status: "in_progress", asset_ids: ["failed"] } });
  assert.equal(manifestQueueStopReason(failed), "failed_verification_wave");
  assert.equal(manifestQueueStopReason({ ...failed, counts: { ...failed.counts, leased: 1 } }), null);
});
test("explicitly bypassed or optional verification does not block pending work", () => {
  for (const verification_wave of [
    { required: true, bypassed: true, status: "bypassed_with_prior_health_proof", asset_ids: ["failed"] },
    { required: false, status: "in_progress", asset_ids: ["failed"] },
  ]) assert.equal(manifestQueueStopReason(snapshot({ verification_wave })), null);
});

test("Flow and Gemini may share one federated manifest", () => {
  const manifestPath = "/tmp/episode/codex-work-federated/work_manifest.json";
  assert.equal(googleManifestActivationConflict({
    incomingManifestPath: manifestPath,
    activeManifestEntries: [
      { browser_provider: "google-flow", manifest_path: manifestPath, runnable: true },
      { browser_provider: "google-gemini", manifest_path: manifestPath, runnable: true },
    ],
  }), null);
});

test("Flow-only and Gemini-only cannot activate separate runnable manifests", () => {
  const conflict = googleManifestActivationConflict({
    incomingManifestPath: "/tmp/episode/codex-work-gemini/work_manifest.json",
    activeManifestEntries: [{
      browser_provider: "google-flow",
      manifest_path: "/tmp/episode/codex-work-flow/work_manifest.json",
      runnable: true,
    }],
  });
  assert.match(conflict, /cannot run from separate manifests/);
});

test("drained manifests do not block the next Google queue", () => {
  assert.equal(googleManifestActivationConflict({
    incomingManifestPath: "/tmp/episode/codex-work-next/work_manifest.json",
    activeManifestEntries: [{
      browser_provider: "google-flow",
      manifest_path: "/tmp/episode/codex-work-drained/work_manifest.json",
      runnable: false,
    }],
  }), null);
});

test("worker lease scans ignore drained manifest registrations", () => {
  assert.equal(manifestHasRunnableWork({ counts: { pending: 0, leased: 0, completed: 44, deadlettered: 3 } }), false);
  assert.equal(manifestHasRunnableWork({ counts: { pending: 1, leased: 0, completed: 44, deadlettered: 3 } }), true);
  assert.equal(manifestHasRunnableWork({ counts: { pending: 0, leased: 1, completed: 44, deadlettered: 3 } }), true);
  assert.equal(manifestHasRunnableWork({
    counts: { pending: 0, leased: 0, completed: 44, deadlettered: 0 },
    streaming_queue: { sealed: false },
  }), true, "an open wavefront stream retains Google-manifest exclusivity between appended chunks");
});
