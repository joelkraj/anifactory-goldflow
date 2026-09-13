import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  beginCodexWorkManifestDrain,
  completeWorkItem,
  getCodexWorkStatus,
  heartbeatWorkItem,
  leaseNextWorkItem,
  openCodexWorkManifestStream,
  sha256File,
} from "../lib/codex-image-work-contract.mjs";
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

test("a lease arriving after the idle snapshot drains before import, with later admission closed", async () => {
  const episodeDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-pool-drain-race-"));
  try {
    const promptsPath = path.join(episodeDir, "prompts.json");
    await fs.writeFile(promptsPath, JSON.stringify({
      status: "passed", image_provider: "codex_imagegen",
      prompts: ["first", "late", "pending"].map((image_id) => ({
        image_id, image_generation_required: true,
        codex_image_prompt: `Distinct ${image_id} landscape.`, reference_slots: [],
      })),
    }));
    const { manifest } = await openCodexWorkManifestStream({
      streamId: "drain-race", mode: "scene", episodeDir, promptsPath,
      imageIds: ["first", "late", "pending"], maxAttempts: 1, leaseSeconds: 60,
    });
    const manifestPath = manifest.manifest_path;
    const originalManifestHash = await sha256File(manifestPath);
    async function complete(lease, workerId, color) {
      const assignment = lease.assignment;
      await sharp({ create: { width: 640, height: 360, channels: 3, background: color } })
        .png().toFile(assignment.expected_output_path);
      await completeWorkItem({ manifestPath, assetId: assignment.asset_id,
        leaseToken: assignment.lease_token, workerId,
        sourcePath: assignment.expected_output_path,
        reportedSha256: await sha256File(assignment.expected_output_path) });
    }
    const first = await leaseNextWorkItem({ manifestPath, workerId: "worker-first", leaseSeconds: 60 });
    await complete(first, "worker-first", "#102030");
    const firstHash = await sha256File(first.assignment.expected_output_path);
    const staleSnapshot = await getCodexWorkStatus({ manifestPath });
    assert.equal(staleSnapshot.counts.leased, 0);

    // The host wins a lease while the controller awaits its provider check.
    const late = await leaseNextWorkItem({ manifestPath, workerId: "worker-late", leaseSeconds: 60 });
    assert.equal(late.status, "leased");
    const reason = "Gemini provider circuit is open.";
    const drain = await beginCodexWorkManifestDrain({ manifestPath, reason });
    assert.equal(drain.policy, "no_new_leases_existing_completions_retained");
    assert.deepEqual(await beginCodexWorkManifestDrain({ manifestPath, reason }), drain, "the receipt is immutable");
    const blocked = await leaseNextWorkItem({ manifestPath, workerId: "worker-next", leaseSeconds: 60 });
    assert.equal(blocked.no_work_reason, "manifest_draining");
    const fresh = await getCodexWorkStatus({ manifestPath });
    assert.equal(fresh.counts.leased, 1, "the stale zero snapshot cannot authorize final import");
    assert.equal(fresh.dispatch_drain.reason, reason, "other streamed waiters see the same drain");
    await heartbeatWorkItem({ manifestPath, assetId: late.assignment.asset_id,
      leaseToken: late.assignment.lease_token, workerId: "worker-late", leaseSeconds: 60 });
    await complete(late, "worker-late", "#807060");
    const settled = await getCodexWorkStatus({ manifestPath, reconcile: false });
    assert.deepEqual(settled.counts, { pending: 1, leased: 0, completed: 2, deadlettered: 0 });
    assert.equal(await sha256File(first.assignment.expected_output_path), firstHash);
    assert.equal(await sha256File(manifestPath), originalManifestHash, "drain does not rewrite creative work");
    assert.equal((await leaseNextWorkItem({ manifestPath, workerId: "worker-next", leaseSeconds: 60 })).no_work_reason,
      "manifest_draining", "cooldown expiry cannot reopen this stopped queue");
  } finally {
    await fs.rm(episodeDir, { recursive: true, force: true });
  }
});
