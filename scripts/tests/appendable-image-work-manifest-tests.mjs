#!/usr/bin/env node

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";

import {
  appendCodexWorkManifestStream,
  completeWorkItem,
  getCodexWorkStatus,
  leaseNextWorkItem,
  loadWorkManifest,
  openCodexWorkManifestStream,
  sealCodexWorkManifestStream,
  sha256File,
} from "../lib/codex-image-work-contract.mjs";

async function writePlan(filePath, imageId, prompt) {
  await fs.writeFile(filePath, `${JSON.stringify({
    status: "passed",
    image_provider: "codex_imagegen",
    prompts: [{
      image_id: imageId,
      image_generation_required: true,
      codex_image_prompt: prompt,
      reference_slots: [],
    }],
  }, null, 2)}\n`, "utf8");
}

async function completeLease(manifestPath, workerId, color) {
  const lease = await leaseNextWorkItem({ manifestPath, workerId, leaseSeconds: 60 });
  assert.equal(lease.status, "leased");
  await sharp({ create: { width: 640, height: 360, channels: 3, background: color } })
    .png()
    .toFile(lease.assignment.expected_output_path);
  await completeWorkItem({
    manifestPath,
    assetId: lease.assignment.asset_id,
    leaseToken: lease.assignment.lease_token,
    workerId,
    sourcePath: lease.assignment.expected_output_path,
    reportedSha256: await sha256File(lease.assignment.expected_output_path),
  });
  return lease.assignment.asset_id;
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-appendable-image-manifest-"));
try {
  const episodeDir = path.join(root, "episode");
  await fs.mkdir(episodeDir, { recursive: true });
  const planOne = path.join(episodeDir, "wave-001.json");
  const planTwo = path.join(episodeDir, "wave-002.json");
  const planThree = path.join(episodeDir, "wave-003.json");
  await writePlan(planOne, "cut_001", "First exact creative contract, anime/manhwa landscape.");
  await writePlan(planTwo, "cut_002", "Second exact creative contract, anime/manhwa landscape.");
  await writePlan(planThree, "cut_003", "Third exact creative contract, anime/manhwa landscape.");

  const stream = await openCodexWorkManifestStream({
    streamId: "episode-wavefront-v1",
    mode: "scene",
    episodeDir,
    promptsPath: planOne,
    imageIds: ["cut_001"],
    maxAttempts: 1,
    leaseSeconds: 60,
  });
  const manifestPath = stream.manifest.manifest_path;
  assert.equal(stream.manifest.streaming_queue.sealed, false);
  await assert.rejects(() => openCodexWorkManifestStream({
    streamId: "episode-wavefront-v1:exact-repair:cut-001",
    mode: "scene",
    episodeDir,
    promptsPath: planOne,
    imageIds: ["cut_001"],
    maxAttempts: 1,
    leaseSeconds: 60,
  }), /active unsealed streaming manifest/, "an interrupted episode stream must block a competing exact-repair manifest");
  assert.equal(await completeLease(manifestPath, "worker-1", "#112233"), "cut_001");
  assert.equal(
    (await getCodexWorkStatus({ manifestPath })).status,
    "in_progress",
    "an unsealed stream must remain active after its current tail drains",
  );

  const [secondAppend, thirdAppend] = await Promise.all([
    appendCodexWorkManifestStream({
      manifestPath,
      mode: "scene",
      episodeDir,
      promptsPath: planTwo,
      imageIds: ["cut_002"],
      maxAttempts: 1,
      leaseSeconds: 60,
    }),
    appendCodexWorkManifestStream({
      manifestPath,
      mode: "scene",
      episodeDir,
      promptsPath: planThree,
      imageIds: ["cut_003"],
      maxAttempts: 1,
      leaseSeconds: 60,
    }),
  ]);
  assert.equal(secondAppend.appended_count, 1);
  assert.equal(thirdAppend.appended_count, 1);
  const appendedManifest = (await loadWorkManifest(manifestPath)).manifest;
  assert.equal(appendedManifest.manifest_id, stream.manifest.manifest_id);
  assert.deepEqual(new Set(appendedManifest.items.map((row) => row.asset_id)), new Set(["cut_001", "cut_002", "cut_003"]));
  assert.equal(appendedManifest.policy.max_attempts, 1);

  const idempotentAppend = await appendCodexWorkManifestStream({
    manifestPath,
    mode: "scene",
    episodeDir,
    promptsPath: planTwo,
    imageIds: ["cut_002"],
    maxAttempts: 1,
    leaseSeconds: 60,
  });
  assert.equal(idempotentAppend.appended_count, 0);
  assert.deepEqual(idempotentAppend.reused_asset_ids, ["cut_002"]);

  const conflictingPlan = path.join(episodeDir, "wave-002-conflict.json");
  await writePlan(conflictingPlan, "cut_002", "A conflicting creative submission must be rejected.");
  await assert.rejects(() => appendCodexWorkManifestStream({
    manifestPath,
    mode: "scene",
    episodeDir,
    promptsPath: conflictingPlan,
    imageIds: ["cut_002"],
    maxAttempts: 1,
    leaseSeconds: 60,
  }), /different creative contract/);

  const completedTail = await Promise.all([
    completeLease(manifestPath, "worker-2", "#334455"),
    completeLease(manifestPath, "worker-3", "#556677"),
  ]);
  assert.deepEqual(new Set(completedTail), new Set(["cut_002", "cut_003"]));
  const sealed = await sealCodexWorkManifestStream({ manifestPath, streamId: "episode-wavefront-v1" });
  assert.equal(sealed.sealed, true);
  assert.equal((await getCodexWorkStatus({ manifestPath })).status, "completed");
  assert.equal((await sealCodexWorkManifestStream({ manifestPath })).reused, true);
  await assert.rejects(() => appendCodexWorkManifestStream({
    manifestPath,
    mode: "scene",
    episodeDir,
    promptsPath: planTwo,
    imageIds: ["cut_002"],
    maxAttempts: 1,
    leaseSeconds: 60,
  }), /sealed/);

  const eventDir = path.join(path.dirname(manifestPath), "append-events");
  const events = (await fs.readdir(eventDir)).filter((name) => name.endsWith(".json"));
  assert.equal(events.length, 4, "open, two atomic appends, and seal must be durably recorded");
  const attempts = await fs.readdir(path.join(path.dirname(manifestPath), "attempts", "cut_002"));
  assert.equal(attempts.length, 1, "an appended item receives exactly one creative submission attempt");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

process.stdout.write("appendable image work manifest tests passed\n");
