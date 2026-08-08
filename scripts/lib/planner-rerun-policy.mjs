import { readFileSync } from "node:fs";
import path from "node:path";

export const PLANNER_STAGE_IDS = Object.freeze(new Set([
  "semantic_scene_plan",
  "visual_beat_plan",
  "visual_reference_plan",
  "visual_prompt_plan",
  "visual_prompt_blocker_repair",
]));

const SCOPED_FLAGS = Object.freeze([
  "only-scenes",
  "scene-ids",
  "scene-id",
  "semantic-chunk-ids",
  "semantic-chunk-id",
  "chunk-ids",
  "chunk-id",
  "cut-ids",
  "cut-id",
  "image-ids",
  "image-id",
  "beat-ids",
  "beat-id",
  "reference-ids",
  "reference-id",
  "repair-chunk-ids",
  "repair-scene-ids",
  "scope-start-sec",
  "scope-end-sec",
  "proof-start-sec",
  "proof-end-sec",
  "blockers-only",
]);

function isTrue(value) {
  return /^(?:true|1|yes)$/i.test(String(value ?? ""));
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

export function plannerInvocationScope(flags = {}) {
  const scopeFlags = SCOPED_FLAGS.filter((name) => hasValue(flags[name]) && (
    name !== "blockers-only" || isTrue(flags[name])
  ));
  if (isTrue(flags["repair-global"])) scopeFlags.push("repair-global");
  const resumesIncompleteChunks = isTrue(flags["resume-incomplete-chunks"]);
  return {
    scoped: scopeFlags.length > 0,
    scope_flags: scopeFlags,
    resumes_incomplete_chunks: resumesIncompleteChunks,
  };
}

export function plannerRerunDecision({
  stage,
  flags = {},
  priorEvents = [],
  unresolvedExpectedIds = [],
} = {}) {
  if (!PLANNER_STAGE_IDS.has(stage)) return { allowed: true, reason: "not_a_planner_stage" };
  const deterministicNonAuthoringRerun = (
    stage === "visual_beat_plan"
    && (isTrue(flags["retime-locked-grouping"]) || isTrue(flags["reproject-active-state-only"]))
  ) || (
    stage === "visual_reference_plan"
    && isTrue(flags["revalidate-existing"])
  ) || (
    stage === "visual_prompt_plan"
    && isTrue(flags["revalidate-existing"])
  );
  if (deterministicNonAuthoringRerun) {
    return {
      allowed: true,
      reason: "deterministic_non_authoring_revalidation",
    };
  }
  const priorAttempts = priorEvents.filter((row) => (
    row?.event_type === "stage_completed"
    && row?.stage === stage
  ));
  const priorStarts = priorEvents.filter((row) => (
    row?.event_type === "stage_started"
    && row?.stage === stage
  ));
  if (!priorAttempts.length && !priorStarts.length) {
    return { allowed: true, reason: "first_planner_attempt" };
  }
  const scope = plannerInvocationScope(flags);
  const cacheDisabled = String(flags["codex-reuse-cache"] ?? "true") === "false"
    || String(flags["codex-reuse-latest"] ?? "true") === "false";
  const latestAttempt = priorAttempts.at(-1) ?? null;
  const latestAttemptFailed = latestAttempt && String(latestAttempt.status ?? "failed") !== "passed";
  const interruptedAttempt = priorStarts.length > priorAttempts.length;
  const unresolvedIds = [...new Set(unresolvedExpectedIds.map(String).filter(Boolean))];
  if (scope.scoped) {
    return {
      allowed: true,
      reason: "scoped_planner_recovery",
      prior_attempt_count: priorAttempts.length,
      ...scope,
    };
  }
  if (
    stage === "visual_prompt_plan"
    && scope.resumes_incomplete_chunks
    && (latestAttemptFailed || interruptedAttempt || unresolvedIds.length > 0)
  ) {
    return {
      allowed: false,
      reason: "visual_prompt_resume_requires_exact_failed_scope",
      prior_attempt_count: priorAttempts.length,
      unresolved_expected_ids: unresolvedIds,
      ...scope,
      required_recovery: unresolvedIds.length
        ? `Retry only the failed visual beats/cuts: ${unresolvedIds.join(", ")}. Preserve the complete blocked base plan and every passed content-addressed chunk.`
        : "Inspect the blocked visual prompt plan and planner_chunk_ledger.json, then pass exact --cut-ids or --beat-ids. Whole-stage visual prompt retries are not automatic recovery.",
    };
  }
  if (
    scope.resumes_incomplete_chunks
    && !cacheDisabled
    && (latestAttemptFailed || interruptedAttempt || unresolvedIds.length > 0)
  ) {
    return {
      allowed: true,
      reason: "content_addressed_incomplete_chunk_resume",
      prior_attempt_count: priorAttempts.length,
      unresolved_expected_ids: unresolvedIds,
      ...scope,
    };
  }
  return {
    allowed: false,
    reason: cacheDisabled
      ? "planner_retry_cache_disabled"
      : scope.resumes_incomplete_chunks
        ? "completed_planner_requires_exact_scope"
        : "unscoped_planner_rerun_forbidden",
    prior_attempt_count: priorAttempts.length,
    unresolved_expected_ids: unresolvedIds,
    ...scope,
    required_recovery: "Inspect planner_chunk_ledger.json and the blocked artifact. Prefer a manual structured repair when small; otherwise pass exact scene/cut/beat/reference IDs. Use --resume-incomplete-chunks true only after a failed or interrupted planner batch.",
  };
}

function readJsonLines(filePath) {
  try {
    return readFileSync(filePath, "utf8").split("\n").filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function unresolvedPlannerIds(episodeDir, stage) {
  try {
    const ledger = JSON.parse(readFileSync(path.join(episodeDir, "planner_chunk_ledger.json"), "utf8"));
    const stageEntries = Object.values(ledger?.entries ?? {})
      .filter((row) => row?.planner_stage === stage);
    const passedIds = new Set(stageEntries
      .filter((row) => row?.status === "passed")
      .flatMap((row) => row?.expected_ids ?? [])
      .map(String)
      .filter(Boolean));
    return [...new Set(stageEntries
      .filter((row) => row?.status === "failed")
      .flatMap((row) => row?.expected_ids ?? [])
      .map(String)
      .filter((id) => id && !passedIds.has(id)))];
  } catch {
    return [];
  }
}

export function plannerRerunDecisionForEpisode({ stage, flags = {}, episodeDir }) {
  const priorEvents = episodeDir
    ? readJsonLines(path.join(episodeDir, "execution_events.jsonl"))
    : [];
  const unresolvedExpectedIds = episodeDir ? unresolvedPlannerIds(episodeDir, stage) : [];
  const decision = plannerRerunDecision({
    stage,
    flags,
    priorEvents,
    unresolvedExpectedIds,
  });
  return {
    ...decision,
    failed_expected_ids: unresolvedExpectedIds,
  };
}
