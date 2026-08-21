import { createHash } from "node:crypto";
import path from "node:path";

import { stageDefinition } from "./pipeline-stage-registry.mjs";

export const DIRECTOR_WATCH_SCHEMA = "goldflow_agent_director_watch_v2";
export const DIRECTOR_EXECUTION_EVENTS_CURSOR_SCHEMA = "goldflow_execution_events_cursor_v1";

function clean(value) {
  return String(value ?? "").trim();
}

function stableCheckpointRows(checkpoints = {}) {
  return Object.entries(checkpoints?.approvals ?? {})
    .filter(([, row]) => row?.approved === true)
    .map(([id, row]) => ({
      id,
      approved_at: clean(row?.approved_at) || null,
      approved_by: clean(row?.approved_by) || null,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableObject(value[key])]),
  );
}

function stableExecutionCursor(cursor = null) {
  if (!cursor || typeof cursor !== "object") return null;
  return {
    schema: clean(cursor.schema) || DIRECTOR_EXECUTION_EVENTS_CURSOR_SCHEMA,
    byte_length: Number(cursor.byte_length ?? 0),
    line_count: Number(cursor.line_count ?? 0),
    event_count: Number(cursor.event_count ?? 0),
    sha256: clean(cursor.sha256) || sha256(""),
    last_event_sha256: clean(cursor.last_event_sha256) || null,
    last_execution_id: clean(cursor.last_execution_id) || null,
    last_event_type: clean(cursor.last_event_type) || null,
    open_execution_ids: [...new Set((cursor.open_execution_ids ?? []).map(clean).filter(Boolean))].sort(),
  };
}

export function executionEventsCursorFromText(text = "") {
  const raw = String(text ?? "");
  const lines = raw.split("\n").filter((line) => line.length > 0);
  const events = lines.flatMap((line) => {
    try {
      const parsed = JSON.parse(line);
      return parsed && typeof parsed === "object" ? [{ parsed, line }] : [];
    } catch {
      return [];
    }
  });
  const openExecutions = new Map();
  for (const { parsed } of events) {
    const executionId = clean(parsed.execution_id);
    if (!executionId) continue;
    if (parsed.event_type === "stage_started") {
      openExecutions.set(executionId, clean(parsed.stage) || null);
    } else if (parsed.event_type === "stage_completed") {
      openExecutions.delete(executionId);
    }
  }
  const last = events.at(-1) ?? null;
  return stableExecutionCursor({
    schema: DIRECTOR_EXECUTION_EVENTS_CURSOR_SCHEMA,
    byte_length: Buffer.byteLength(raw, "utf8"),
    line_count: lines.length,
    event_count: events.length,
    sha256: sha256(raw),
    last_event_sha256: last ? sha256(last.line) : null,
    last_execution_id: last?.parsed?.execution_id ?? null,
    last_event_type: last?.parsed?.event_type ?? null,
    open_execution_ids: [...openExecutions.keys()],
  });
}

export function executionEventsCursorMatches(left, right) {
  const a = stableExecutionCursor(left);
  const b = stableExecutionCursor(right);
  if (!a || !b) return a === b;
  return a.schema === b.schema
    && a.byte_length === b.byte_length
    && a.line_count === b.line_count
    && a.event_count === b.event_count
    && a.sha256 === b.sha256
    && a.last_event_sha256 === b.last_event_sha256;
}

export function directorWatchSignature(runStatus = {}, checkpoints = {}, executionEventsCursor = null) {
  const currentStage = clean(runStatus?.current_stage) || "complete";
  const currentRow = (runStatus?.stage_ledger ?? []).find((row) => row?.stage === currentStage) ?? null;
  const payload = {
    episode_dir: normalizedEpisodeDir(runStatus?.episode_dir),
    identity: stableObject(runStatus?.identity ?? {}),
    stage_registry_version: clean(runStatus?.stage_registry_version) || null,
    current_stage: currentStage,
    current_stage_state: clean(runStatus?.current_stage_state ?? currentRow?.state) || null,
    next_command_shape: clean(runStatus?.next_command_shape ?? currentRow?.next_command_shape) || null,
    current_required_input: clean(currentRow?.required_input) || null,
    current_output_artifact: clean(currentRow?.output_artifact ?? currentRow?.output) || null,
    current_evidence: clean(currentRow?.evidence) || null,
    checkpoints: stableCheckpointRows(checkpoints),
    execution_events_cursor: stableExecutionCursor(executionEventsCursor),
  };
  return sha256(JSON.stringify(payload));
}

// The observation signature above intentionally changes with the execution
// ledger and checkpoint UI state. Those are progress signals, not permission
// to submit the same work again. This key changes only when the authoritative
// stage or its canonical command/scope changes, and is therefore the watcher’s
// one-dispatch idempotency boundary.
export function directorWatchDispatchKey(runStatus = {}) {
  const currentStage = clean(runStatus?.current_stage) || "complete";
  const currentRow = (runStatus?.stage_ledger ?? []).find((row) => row?.stage === currentStage) ?? null;
  const identity = runStatus?.identity ?? {};
  const payload = {
    episode_dir: normalizedEpisodeDir(runStatus?.episode_dir),
    identity: {
      schema: clean(identity?.schema) || null,
      channel: clean(identity?.channel) || null,
      series_slug: clean(identity?.series_slug) || null,
      week: clean(identity?.week) || null,
      episode: clean(identity?.episode) || null,
    },
    stage_registry_version: clean(runStatus?.stage_registry_version) || null,
    current_stage: currentStage,
    current_stage_state: clean(runStatus?.current_stage_state ?? currentRow?.state) || null,
    next_command_shape: clean(runStatus?.next_command_shape ?? currentRow?.next_command_shape) || null,
    required_input: clean(currentRow?.required_input) || null,
    output_artifact: clean(currentRow?.output_artifact ?? currentRow?.output) || null,
  };
  return sha256(JSON.stringify(payload));
}

function normalizedEpisodeDir(value) {
  const cleaned = clean(value);
  return cleaned ? path.resolve(cleaned) : null;
}

function priorAdvanceInFlight(state = {}) {
  if (state?.in_flight_advance?.active === true) return true;
  return clean(state?.status) === "advancing" || state?.decision?.action === "advance";
}

function restartHold(reason, state, details = {}) {
  return {
    state_present: true,
    state_valid: false,
    preserve_last_actioned_signature: false,
    last_actioned_signature: null,
    preserve_last_actioned_dispatch_key: false,
    last_actioned_dispatch_key: null,
    hold: true,
    hold_reason: reason,
    in_flight_advance: state?.in_flight_advance ?? null,
    ...details,
  };
}

export function directorWatchRestartState({
  state = null,
  stateReadError = null,
  episodeDir = null,
  episode = null,
  runStatus = {},
  checkpoints = {},
  executionEventsCursor = null,
  signature = null,
  dispatchKey = null,
  isProcessAlive = () => false,
} = {}) {
  if (stateReadError) {
    return restartHold("restart_state_unreadable", state, {
      validation_error: stateReadError instanceof Error ? stateReadError.message : String(stateReadError),
    });
  }
  if (!state || typeof state !== "object") {
    return {
      state_present: false,
      state_valid: false,
      preserve_last_actioned_signature: false,
      last_actioned_signature: null,
      preserve_last_actioned_dispatch_key: false,
      last_actioned_dispatch_key: null,
      hold: false,
      hold_reason: null,
      in_flight_advance: null,
    };
  }

  const currentSignature = signature ?? directorWatchSignature(runStatus, checkpoints, executionEventsCursor);
  const currentDispatchKey = dispatchKey ?? directorWatchDispatchKey(runStatus);
  const currentStage = clean(runStatus?.current_stage) || "complete";
  const priorStage = clean(state?.in_flight_advance?.stage ?? state?.current_stage) || null;
  const schemaMatches = state.schema === DIRECTOR_WATCH_SCHEMA;
  const episodeDirMatches = normalizedEpisodeDir(state.episode_dir) === normalizedEpisodeDir(episodeDir);
  const episodeMatches = clean(state.episode) === clean(episode);
  const signatureMatches = clean(state.state_signature) === clean(currentSignature);
  const dispatchKeyMatches = clean(state.dispatch_key) === clean(currentDispatchKey);
  const cursorMatches = executionEventsCursorMatches(state.execution_events_cursor, executionEventsCursor)
    && clean(state.execution_events_cursor_sha256) === clean(executionEventsCursor?.sha256);
  const stageMatches = priorStage === currentStage;
  const bindingsMatch = schemaMatches
    && episodeDirMatches
    && episodeMatches
    && signatureMatches
    && dispatchKeyMatches
    && cursorMatches
    && stageMatches;
  const inFlight = priorAdvanceInFlight(state);
  const childPid = Number(state?.in_flight_advance?.child_pid);
  const childPidValid = Number.isInteger(childPid) && childPid > 0;
  const childAlive = childPidValid && Boolean(isProcessAlive(childPid));
  const openExecutionIds = [...new Set((executionEventsCursor?.open_execution_ids ?? []).map(clean).filter(Boolean))];

  if (!schemaMatches || !episodeDirMatches || !episodeMatches) {
    if (inFlight || clean(state.last_actioned_signature)) {
      return restartHold("restart_state_binding_unverifiable", state, {
        validation: { schema_matches: schemaMatches, episode_dir_matches: episodeDirMatches, episode_matches: episodeMatches },
      });
    }
    return {
      state_present: true,
      state_valid: false,
      preserve_last_actioned_signature: false,
      last_actioned_signature: null,
      preserve_last_actioned_dispatch_key: false,
      last_actioned_dispatch_key: null,
      hold: false,
      hold_reason: null,
      in_flight_advance: null,
    };
  }

  const priorLastDispatchKey = clean(state.last_actioned_dispatch_key) || null;
  if (!clean(state.dispatch_key) || (clean(state.last_actioned_signature) && !priorLastDispatchKey)) {
    return restartHold("restart_state_binding_unverifiable", state, {
      validation: {
        schema_matches: schemaMatches,
        episode_dir_matches: episodeDirMatches,
        episode_matches: episodeMatches,
        dispatch_key_present: Boolean(clean(state.dispatch_key)),
        last_actioned_dispatch_key_present: Boolean(priorLastDispatchKey),
      },
    });
  }

  if (openExecutionIds.length) {
    return restartHold("restart_inflight_execution_open", state, {
      child_pid: childPidValid ? childPid : null,
      open_execution_ids: openExecutionIds,
    });
  }

  if (inFlight) {
    if (childAlive) {
      return restartHold("restart_inflight_child_active", state, { child_pid: childPid });
    }
    if (stageMatches) {
      return restartHold(childPidValid
        ? "restart_inflight_stale_pid_stage_unchanged"
        : "restart_inflight_spawn_window_ambiguous", state, {
        child_pid: childPidValid ? childPid : null,
        cursor_matches: cursorMatches,
        signature_matches: signatureMatches,
      });
    }
  }

  if (priorLastDispatchKey === currentDispatchKey && !bindingsMatch) {
    return restartHold("restart_dispatch_unchanged_binding_changed", state, {
      cursor_matches: cursorMatches,
      signature_matches: signatureMatches,
      dispatch_key_matches: dispatchKeyMatches,
    });
  }

  const preservedSignature = bindingsMatch && clean(state.last_actioned_signature)
    ? clean(state.last_actioned_signature)
    : null;
  const preservedDispatchKey = bindingsMatch && priorLastDispatchKey
    ? priorLastDispatchKey
    : null;
  return {
    state_present: true,
    state_valid: bindingsMatch,
    preserve_last_actioned_signature: Boolean(preservedSignature),
    last_actioned_signature: preservedSignature,
    preserve_last_actioned_dispatch_key: Boolean(preservedDispatchKey),
    last_actioned_dispatch_key: preservedDispatchKey,
    hold: false,
    hold_reason: null,
    in_flight_advance: null,
    validation: {
      schema_matches: schemaMatches,
      episode_dir_matches: episodeDirMatches,
      episode_matches: episodeMatches,
      signature_matches: signatureMatches,
      dispatch_key_matches: dispatchKeyMatches,
      execution_cursor_matches: cursorMatches,
      stage_matches: stageMatches,
    },
  };
}

export function directorWatchDecision({
  runStatus = {},
  director = {},
  profile = {},
  signature = null,
  lastActionedSignature = null,
  dispatchKey = null,
  lastActionedDispatchKey = null,
  idleElapsedMs = 0,
  idleTimeoutMs = 0,
} = {}) {
  const stageId = clean(runStatus?.current_stage) || "complete";
  const stageState = clean(
    runStatus?.current_stage_state
      ?? runStatus?.stage_ledger?.find((row) => row?.stage === stageId)?.state,
  ) || "missing";

  if (stageId === "complete") return { action: "stop", reason: "pipeline_complete" };
  if (["blocked", "failed", "stale"].includes(stageState)) {
    return { action: "stop", reason: "blocker_triage_required" };
  }
  if (Number(idleTimeoutMs) > 0 && Number(idleElapsedMs) >= Number(idleTimeoutMs)) {
    return { action: "stop", reason: "idle_timeout_reached" };
  }
  if (Array.isArray(director?.checkpoint_hold) && director.checkpoint_hold.length) {
    return { action: "wait", reason: "operator_checkpoint_required" };
  }

  const definition = stageDefinition(stageId);
  if (!definition) return { action: "stop", reason: "unknown_stage" };
  if (definition.approval === "operator") {
    return { action: "wait", reason: "operator_stage_approval_required" };
  }
  if (definition.approval === "operator_or_agent") {
    const agentValidated = new Set(profile?.advance?.agent_validated_stages ?? []);
    if (!agentValidated.has(stageId)) return { action: "wait", reason: "operator_or_agent_approval_required" };
  }
  if (definition.approval === "risk_cut_decisions" && stageState !== "missing") {
    return { action: "wait", reason: "risk_cut_review_required" };
  }
  const currentActionKey = clean(dispatchKey) || clean(signature) || null;
  const previousActionKey = clean(lastActionedDispatchKey) || clean(lastActionedSignature) || null;
  if (currentActionKey && currentActionKey === previousActionKey) {
    return { action: "wait", reason: "awaiting_state_change" };
  }
  return { action: "advance", reason: "automatic_stage_ready" };
}
