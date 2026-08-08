#!/usr/bin/env node

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordPlannerChunkCheckpoint } from "../lib/planner-chunk-ledger.mjs";
import { plannerInvocationScope } from "../lib/planner-rerun-policy.mjs";
import {
  readPassedSemanticChunkCheckpoint,
  semanticFailedUnitIds,
  semanticPartialFailureArtifact,
  semanticRequestedUnitIds,
  semanticSceneCountFindings,
  writeSemanticChunkCheckpoint,
} from "../lib/semantic-planner-recovery.mjs";
import { semanticRecoveryCommandForTests } from "../run-status.mjs";
import { semanticSceneCoverageFindingsForTests } from "../semantic-scene-plan.mjs";

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-semantic-recovery-"));

try {
  const episodeDir = path.join(temporaryRoot, "episode");
  const chunk = {
    chunk_index: 1,
    chunk_count: 2,
    word_start_index: 0,
    word_end_index_exclusive: 100,
    overlap_words: 0,
    words: 100,
  };
  const inputHash = "a".repeat(64);
  const passed = await writeSemanticChunkCheckpoint({
    episodeDir,
    chunkId: "chunk_01",
    inputHash,
    chunk,
    targets: { minimum: 2, maximum: 8 },
    llm: {
      provider: "test",
      parsed: { scenes: [{ scene_id: "local_1", title: "Preserved" }] },
    },
    status: "passed",
  });
  const failed = await writeSemanticChunkCheckpoint({
    episodeDir,
    chunkId: "chunk_01",
    inputHash,
    chunk,
    targets: { minimum: 2, maximum: 8 },
    llm: { provider: "test", parsed: { scenes: [] } },
    status: "failed",
    failure: { code: "test_failure", message: "bad packet" },
  });
  assert.notEqual(failed.path, passed.path, "failed packets must not overwrite a passed checkpoint");
  const recovered = await readPassedSemanticChunkCheckpoint({ episodeDir, chunkId: "chunk_01", inputHash });
  assert.equal(recovered?.artifact?.scenes?.[0]?.title, "Preserved");
  assert.deepEqual(recovered?.artifact?.expected_ids, ["chunk_01"]);

  await recordPlannerChunkCheckpoint({
    episodeDir,
    plannerStage: "semantic_scene_plan",
    chunkId: "chunk_01",
    inputHash,
    expectedIds: ["chunk_01"],
    status: "passed",
    outputPath: passed.path,
  });
  await recordPlannerChunkCheckpoint({
    episodeDir,
    plannerStage: "semantic_scene_plan",
    chunkId: "chunk_01",
    inputHash,
    expectedIds: ["chunk_01"],
    status: "failed",
    outputPath: failed.path,
    findings: [{ code: "later_failure" }],
  });
  const ledger = JSON.parse(await fs.readFile(path.join(episodeDir, "planner_chunk_ledger.json"), "utf8"));
  const ledgerEntry = Object.values(ledger.entries)[0];
  assert.equal(ledgerEntry.status, "passed", "a later failed write cannot demote an immutable passed checkpoint");
  assert.equal(ledgerEntry.attempts.length, 2, "accepted and failed packets remain in checkpoint history");
  assert.deepEqual(ledgerEntry.expected_ids, ["chunk_01"]);

  const partial = semanticPartialFailureArtifact({
    identity: { channel: "c", series_slug: "s", week: "w", episode: "ep_01" },
    sourceScriptHash: "b".repeat(64),
    sourceScriptPath: "/tmp/script.md",
    expectedUnitIds: ["chunk_01", "chunk_02", "global_reconciliation"],
    passedResults: [{
      chunk_id: "chunk_01",
      input_hash: inputHash,
      checkpoint_path: passed.path,
      checkpoint_sha256: passed.sha256,
      scenes: [{ scene_id: "local_1" }],
    }],
    failedResults: [{
      chunk_id: "chunk_02",
      input_hash: "c".repeat(64),
      checkpoint_path: failed.path,
      checkpoint_sha256: failed.sha256,
      error: "provider failed",
    }],
    sceneCountPolicy: { minimum: 8, maximum: 20 },
    recoveryCommand: "semantic plan --semantic-chunk-ids chunk_02",
  });
  assert.equal(partial.status, "blocked");
  assert.deepEqual(semanticFailedUnitIds(partial), ["chunk_02"]);
  assert.deepEqual(partial.planner.partial_failure.passed_chunk_ids, ["chunk_01"]);
  assert.equal(partial.preserved_chunk_scenes[0].semantic_source_chunk_id, "chunk_01");
  assert.match(partial.planner.partial_failure.next_recovery_command, /--semantic-chunk-ids chunk_02/);

  const statusCommand = semanticRecoveryCommandForTests(partial, {
    channel: "c",
    series_slug: "s",
    week: "w",
    episode: "ep_01",
  });
  assert.match(statusCommand, /--semantic-chunk-ids chunk_02$/);
  assert.doesNotMatch(statusCommand, /resume-incomplete-chunks/);

  assert.deepEqual(semanticRequestedUnitIds({ "semantic-chunk-ids": "chunk_02,global_reconciliation" }), [
    "chunk_02",
    "global_reconciliation",
  ]);
  assert.equal(plannerInvocationScope({ "semantic-chunk-ids": "chunk_02" }).scoped, true);

  const densityFindings = semanticSceneCountFindings(1, { minimum: 3, maximum: 8 });
  assert.equal(densityFindings.length, 1);
  assert.equal(densityFindings[0].severity, "warning");
  assert.equal(densityFindings[0].code, "semantic_scene_count_below_editorial_goal");
  const longSpanFindings = semanticSceneCoverageFindingsForTests([{
    scene_id: "scene_001",
    script_excerpt_start: "start",
    script_excerpt_end: "end",
  }], `start ${"word ".repeat(30)}end`, 10);
  assert.equal(longSpanFindings.find((finding) => finding.code === "semantic_scene_span_too_large")?.severity, "warning");

  console.log("semantic recovery policy tests: passed");
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
