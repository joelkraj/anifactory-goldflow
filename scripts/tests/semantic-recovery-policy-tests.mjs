#!/usr/bin/env node

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordPlannerChunkCheckpoint } from "../lib/planner-chunk-ledger.mjs";
import { plannerInvocationScope } from "../lib/planner-rerun-policy.mjs";
import {
  readPassedSemanticChunkCheckpoint,
  semanticFailedRecoveryScope,
  semanticFailedUnitIds,
  semanticPartialFailureArtifact,
  semanticRecoveryAdmission,
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

  const scriptHash = partial.source_script_hash;
  assert.deepEqual(semanticFailedRecoveryScope(partial, scriptHash), ["chunk_02"]);
  const globalOnly = structuredClone(partial);
  globalOnly.planner.partial_failure.failed_expected_ids = ["global_reconciliation"];
  globalOnly.planner.partial_failure.failed_chunk_ids = ["global_reconciliation"];
  globalOnly.planner.partial_failure.passed_chunk_ids = ["chunk_01", "chunk_02"];
  assert.deepEqual(semanticFailedRecoveryScope(globalOnly, scriptHash), ["global_reconciliation"],
    "a failed global reconciliation remains repairable while all passed chunk outputs stay frozen");
  const invalidScopeArtifacts = [
    null,
    {},
    { ...partial, schema: "goldflow_semantic_chunk_checkpoint_v1" },
    { ...partial, status: "passed" },
    { ...partial, source_script_hash: undefined },
    { ...partial, source_script_hash: "not-a-hash" },
    { ...partial, source_script_hash: "f".repeat(64) },
  ];
  for (const changes of [
    { expected_ids: [] },
    { expected_ids: "chunk_02" },
    { expected_ids: null },
    { failed_expected_ids: [], failed_chunk_ids: [] },
    { failed_expected_ids: ["unknown"], failed_chunk_ids: ["unknown"] },
    { failed_expected_ids: ["chunk_01", "chunk_02"], failed_chunk_ids: ["chunk_01", "chunk_02"] },
    { failed_expected_ids: [null], failed_chunk_ids: [null] },
  ]) {
    const malformed = structuredClone(partial);
    Object.assign(malformed.planner.partial_failure, changes);
    invalidScopeArtifacts.push(malformed);
  }
  for (const artifact of invalidScopeArtifacts) {
    assert.deepEqual(semanticFailedRecoveryScope(artifact, scriptHash), [], "only blocked, current, structurally valid failure evidence grants a repair scope");
  }
  for (const invalidCurrentHash of [undefined, null, "", "short", "f".repeat(64)]) {
    assert.deepEqual(semanticFailedRecoveryScope(partial, invalidCurrentHash), [], "missing or mismatched current-source evidence cannot authorize recovery");
  }

  const blockedStatus = {
    current_stage: "semantic_scene_plan",
    current_stage_state: "blocked",
    stage_ledger: [{ stage: "semantic_scene_plan", state: "blocked" }],
    semantic_recovery_scope: { failed_unit_ids: ["global_reconciliation"], source_script_hash: scriptHash },
  };
  for (const alias of ["semantic-chunk-ids", "semantic-chunk-id", "chunk-ids", "chunk-id"]) {
    const admitted = semanticRecoveryAdmission(blockedStatus, { [alias]: " global_reconciliation,global_reconciliation " });
    assert.equal(admitted.applicable, true);
    assert.equal(admitted.allowed, true, `${alias} supports an explicit failed global-only repair`);
  }
  for (const flags of [
    {},
    { "resume-incomplete-chunks": "true" },
    { "semantic-chunk-ids": "" },
    { "semantic-chunk-ids": " , " },
    { "semantic-chunk-ids": "unknown" },
    { "semantic-chunk-ids": "chunk_01" },
    { "semantic-chunk-ids": "global_reconciliation,chunk_01" },
  ]) {
    const denied = semanticRecoveryAdmission(blockedStatus, flags);
    assert.equal(denied.applicable, true);
    assert.equal(denied.allowed, false, "a generic resume or scope containing any unfailed unit cannot bypass the blocked semantic stage");
    assert.ok(denied.reason, "denied recovery explains the exact-scope requirement");
  }
  const multipleFailedStatus = {
    ...blockedStatus,
    semantic_recovery_scope: { failed_unit_ids: ["chunk_02", "global_reconciliation"], source_script_hash: scriptHash },
  };
  assert.equal(semanticRecoveryAdmission(multipleFailedStatus, { "semantic-chunk-ids": "chunk_02" }).allowed, true,
    "an exact subset of failed units is admissible");
  assert.equal(semanticRecoveryAdmission(multipleFailedStatus, { "chunk-ids": "chunk_02,global_reconciliation" }).allowed, true);
  for (const scope of [undefined, null, {},
    { failed_unit_ids: [], source_script_hash: scriptHash },
    { failed_unit_ids: ["global_reconciliation"] },
    { failed_unit_ids: ["global_reconciliation"], source_script_hash: "not-a-hash" },
  ]) {
    const denied = semanticRecoveryAdmission({ ...blockedStatus, semantic_recovery_scope: scope }, { "semantic-chunk-id": "global_reconciliation" });
    assert.equal(denied.applicable, true);
    assert.equal(denied.allowed, false, "admission requires the current valid hash-bound failure scope");
  }
  for (const otherStatus of [
    { ...blockedStatus, current_stage: "voice_plan" },
    { ...blockedStatus, current_stage_state: "pending", stage_ledger: [{ stage: "semantic_scene_plan", state: "pending" }] },
    { ...blockedStatus, current_stage_state: "passed", stage_ledger: [{ stage: "semantic_scene_plan", state: "passed" }] },
    {},
  ]) {
    assert.equal(semanticRecoveryAdmission(otherStatus, { "semantic-chunk-id": "global_reconciliation" }).applicable, false,
      "the narrow admission rule cannot override another stage or a nonblocked semantic stage");
  }

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
