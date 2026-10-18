import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function semanticChunkId(chunkIndex) {
  return `chunk_${String(Number(chunkIndex)).padStart(2, "0")}`;
}

export function semanticCheckpointPath(episodeDir, chunkId, inputHash) {
  return path.join(
    episodeDir,
    "planner_checkpoints",
    "semantic_scene_plan",
    `${chunkId}_${String(inputHash).slice(0, 24)}.json`,
  );
}

export function semanticRequestedUnitIds(flags = {}) {
  const raw = flags["semantic-chunk-ids"]
    ?? flags["semantic-chunk-id"]
    ?? flags["chunk-ids"]
    ?? flags["chunk-id"]
    ?? "";
  return [...new Set(String(raw).split(",").map((value) => value.trim()).filter(Boolean))];
}

export function semanticSceneCountFindings(sceneCount, policy = {}) {
  const count = Number(sceneCount ?? 0);
  const minimum = Number(policy.minimum ?? 0);
  const maximum = Number(policy.maximum ?? Number.POSITIVE_INFINITY);
  const findings = [];
  if (Number.isFinite(minimum) && count < minimum) {
    findings.push({
      severity: "warning",
      code: "semantic_scene_count_below_editorial_goal",
      actual_scene_count: count,
      target_minimum: minimum,
      message: "Scene density is below the editorial goal; this is advisory and does not invalidate structurally complete semantic coverage.",
    });
  }
  if (Number.isFinite(maximum) && count > maximum) {
    findings.push({
      severity: "warning",
      code: "semantic_scene_count_above_editorial_goal",
      actual_scene_count: count,
      target_maximum: maximum,
      message: "Scene density is above the editorial goal; this is advisory and does not invalidate structurally complete semantic coverage.",
    });
  }
  return findings;
}

export async function writeSemanticChunkCheckpoint({
  episodeDir,
  chunkId,
  inputHash,
  chunk,
  targets,
  llm,
  status = "passed",
  failure = null,
}) {
  const passedCheckpointPath = semanticCheckpointPath(episodeDir, chunkId, inputHash);
  const checkpointPath = status === "passed"
    ? passedCheckpointPath
    : passedCheckpointPath.replace(
      /\.json$/,
      `.failed_${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    );
  const artifact = {
    schema: "goldflow_semantic_chunk_checkpoint_v1",
    status,
    planner_stage: "semantic_scene_plan",
    chunk_id: chunkId,
    input_sha256: inputHash,
    expected_ids: [chunkId],
    chunk: {
      chunk_index: chunk?.chunk_index ?? null,
      chunk_count: chunk?.chunk_count ?? null,
      word_start_index: chunk?.word_start_index ?? null,
      word_end_index_exclusive: chunk?.word_end_index_exclusive ?? null,
      overlap_words: chunk?.overlap_words ?? 0,
      words: chunk?.words ?? null,
    },
    targets,
    parsed: llm?.parsed ?? null,
    scenes: Array.isArray(llm?.parsed?.scenes) ? llm.parsed.scenes : [],
    provider: llm?.provider ?? null,
    model: llm?.model ?? null,
    reasoning_effort: llm?.reasoning_effort ?? null,
    json_syntax_repair: llm?.json_syntax_repair ?? null,
    provider_output_path: llm?.output_path ?? null,
    raw_content: status === "failed" ? llm?.content ?? null : null,
    reused_cached_output: Boolean(llm?.reused_output),
    failure,
    updated_at: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(checkpointPath), { recursive: true });
  const temporaryPath = `${checkpointPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, checkpointPath);
  return {
    path: checkpointPath,
    sha256: sha256(`${JSON.stringify(artifact, null, 2)}\n`),
    artifact,
  };
}

export async function readPassedSemanticChunkCheckpoint({
  episodeDir,
  chunkId,
  inputHash,
}) {
  const checkpointPath = semanticCheckpointPath(episodeDir, chunkId, inputHash);
  let artifact;
  try {
    artifact = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
  } catch {
    return null;
  }
  const valid = artifact?.schema === "goldflow_semantic_chunk_checkpoint_v1"
    && artifact?.status === "passed"
    && artifact?.planner_stage === "semantic_scene_plan"
    && artifact?.chunk_id === chunkId
    && artifact?.input_sha256 === inputHash
    && JSON.stringify(artifact?.expected_ids ?? []) === JSON.stringify([chunkId])
    && Array.isArray(artifact?.scenes)
    && artifact.scenes.length > 0
    && artifact?.parsed
    && Array.isArray(artifact.parsed.scenes);
  if (!valid) return null;
  return {
    path: checkpointPath,
    sha256: sha256(await fs.readFile(checkpointPath)),
    artifact,
  };
}

export function semanticPartialFailureArtifact({
  identity = {},
  sourceScriptHash,
  sourceScriptPath,
  expectedUnitIds,
  passedResults,
  failedResults,
  sceneCountPolicy,
  requestedUnitIds = [],
  recoveryCommand = null,
}) {
  const passed = passedResults.map((result) => ({
    chunk_id: result.chunk_id,
    input_sha256: result.input_hash,
    checkpoint_path: result.checkpoint_path,
    checkpoint_sha256: result.checkpoint_sha256,
    scene_count: result.scenes?.length ?? 0,
    reused_checkpoint: Boolean(result.reused_checkpoint),
  }));
  const failed = failedResults.map((result) => ({
    chunk_id: result.chunk_id,
    input_sha256: result.input_hash,
    checkpoint_path: result.checkpoint_path ?? null,
    checkpoint_sha256: result.checkpoint_sha256 ?? null,
    error: result.error,
  }));
  const failedIds = failed.map((result) => result.chunk_id);
  return {
    schema: "goldflow_semantic_scene_plan_v2",
    status: "blocked",
    ...identity,
    source_script_hash: sourceScriptHash,
    source_script_path: sourceScriptPath,
    scene_count_policy: sceneCountPolicy,
    planner: {
      maximum_creative_submissions_per_unit_per_invocation: 1,
      passed_outputs_are_immutable: true,
      exact_scope_repair_only: true,
      partial_failure: {
        expected_ids: expectedUnitIds,
        passed_chunk_ids: passed.map((row) => row.chunk_id),
        failed_chunk_ids: failedIds,
        failed_expected_ids: failedIds,
        requested_unit_ids: requestedUnitIds,
        passed_checkpoints: passed,
        failed_checkpoints: failed,
        next_recovery_command: recoveryCommand,
      },
    },
    preserved_chunk_scenes: passedResults.flatMap((result) => (
      result.scenes ?? []
    ).map((scene) => ({ ...scene, semantic_source_chunk_id: result.chunk_id }))),
    updated_at: new Date().toISOString(),
  };
}

export function semanticFailedUnitIds(artifact) {
  return [...new Set([
    ...(artifact?.planner?.partial_failure?.failed_expected_ids ?? []),
    ...(artifact?.planner?.partial_failure?.failed_chunk_ids ?? []),
  ].map(String).filter(Boolean))];
}

// Repair admission is narrower than stage readiness: only the current source's
// explicitly failed semantic units may re-enter this blocked stage.
export function semanticFailedRecoveryScope(artifact, sourceScriptHash) {
  if (artifact?.schema !== "goldflow_semantic_scene_plan_v2"
    || artifact.status !== "blocked"
    || !/^[a-f0-9]{64}$/.test(String(sourceScriptHash ?? ""))
    || artifact.source_script_hash !== sourceScriptHash) return [];
  const partial = artifact.planner?.partial_failure;
  if (!Array.isArray(partial?.expected_ids) || !Array.isArray(partial?.passed_chunk_ids)
    || !Array.isArray(partial?.failed_expected_ids) || !Array.isArray(partial?.failed_chunk_ids)) return [];
  const expected = new Set(partial.expected_ids.map(String));
  const passed = new Set(partial.passed_chunk_ids.map(String));
  const failed = semanticFailedUnitIds(artifact);
  if (!failed.length || failed.some((id) => !/^(?:chunk_\d+|global_reconciliation)$/.test(id)
    || !expected.has(id) || passed.has(id))) return [];
  return failed;
}

export function semanticRecoveryAdmission(status = {}, flags = {}) {
  if (status.current_stage !== "semantic_scene_plan" || status.current_stage_state !== "blocked") {
    return { applicable: false, allowed: false, reason: "not_a_blocked_semantic_recovery" };
  }
  const scope = status.semantic_recovery_scope;
  const failed = Array.isArray(scope?.failed_unit_ids) ? scope.failed_unit_ids : [];
  if (!failed.length || !/^[a-f0-9]{64}$/.test(String(scope?.source_script_hash ?? ""))) {
    return { applicable: true, allowed: false, reason: "semantic_failed_scope_missing_or_stale" };
  }
  const requested = semanticRequestedUnitIds(flags);
  if (!requested.length) {
    return { applicable: true, allowed: false, reason: "semantic_recovery_requires_exact_failed_unit_ids" };
  }
  const rejected = requested.filter((id) => !failed.includes(id));
  return {
    applicable: true,
    allowed: rejected.length === 0,
    reason: rejected.length ? "semantic_recovery_scope_contains_unknown_or_passed_units" : "exact_failed_semantic_scope",
    requested_unit_ids: requested,
    rejected_unit_ids: rejected,
  };
}
