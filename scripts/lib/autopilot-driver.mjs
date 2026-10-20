import { promises as fs } from "node:fs";
import path from "node:path";
import { autopilotEnabled, recordAutopilotDecision } from "./autopilot-policy.mjs";
import { decideNext } from "./autopilot-gates.mjs";
import { repairScope, flagValue } from "./autopilot-command-shape.mjs";
import { EPISODE_BUDGET_STOP_PREFIX, listSequencedRecords, writeSequencedRecord } from "./episode-budget.mjs";
import { CODE_DRIFT_REASON_CODE, identityCodeCommit } from "./execution-provenance.mjs";
import { parseShape } from "./workflow-command-builder.mjs";

// `goldflow run auto`: status → next valid command → status, until a human
// step, a budget stop or a blocker. Every stop other than the two human steps
// writes a triage file; nothing is skipped silently.
//
// R08 hardening: one driver per episode (autopilot/driver.lock, the only
// mutable driver state), a code-drift check by ancestry with append-only drift
// events, terminal process-group child timeouts that never resubmit a Fal
// request, SLO breach as an event (never a stop), and a safe resume after an
// interrupted child. `run auto` refuses anything but production intent.
export const AUTOPILOT_TRIAGE_SCHEMA = "goldflow_autopilot_triage_v1";
export const AUTOPILOT_REPAIR_SCHEMA = "goldflow_autopilot_repair_v1";
export const AUTOPILOT_DRIVER_LOCK_SCHEMA = "goldflow_autopilot_driver_lock_v1";
export const AUTOPILOT_DRIVER_EVENT_SCHEMA = "goldflow_autopilot_driver_event_v1";
export const DRIVER_LOCK_RELATIVE_PATH = "autopilot/driver.lock";
export const DRIVER_EVENTS_RELATIVE_PATH = "autopilot/driver_events.jsonl";

/**
 * The explicit stop list. `run auto` returns one of these reasons and nothing
 * else; every reason except the two human steps and `complete` leaves a triage
 * file. `slo_breach` is deliberately absent: it is an event, never a stop.
 */
export const AUTOPILOT_STOP_REASONS = Object.freeze({
  final_watch: "Human step 1: watch the master, then run final-watch.",
  publish_approval: "Human step 2: youtube publish with --approved-by.",
  complete: "Every stage passed.",
  budget_stop: "The episode cap, the Fal hard budget or the paid-retry cap refused a dispatch.",
  blocker: "No automatic decision, a rejected decision without a repair route, a command that changed nothing, a repair item already repaired once, a paid dispatch already timed out or interrupted once, or the step limit.",
  code_drift: "The executing HEAD does not contain the identity commit, or the worktree is dirty, and no --allow-code-drift reason code was given.",
  lock_held: "Another live driver (or one on a different host) holds autopilot/driver.lock.",
  child_timeout: "A stage command exceeded its wall budget; its process group was killed and it will not be re-dispatched automatically.",
  status_timeout: "run status itself exceeded its wall budget or failed.",
});
export const AUTOPILOT_REFUSALS = Object.freeze({
  not_production: "run auto drives production identities only; proofs keep their gates.",
  not_autopilot: "run auto needs an identity locked with --autopilot true and --episode-budget-usd.",
});

/**
 * Per-stage child wall budgets. Basis: max(2 × the largest successful
 * wall_time_sec recorded for the stage, 900 s) over the two recorded 2026-W43
 * coma-healer runs (FAL and BASE; one episode each, so p95 is not computable).
 * Stages without a long measured success use the default. Provisional (n=1).
 */
export const STAGE_WALL_BUDGETS = Object.freeze({
  schema: "goldflow_autopilot_wall_budgets_v1",
  basis: "max(2 x max successful wall_time_sec, 900 s); recorded runs 2026-W43-coma-healer-fal-panel-v1 and -panel-baseline-v1; provisional (n=1 episode each)",
  default_sec: 1800,
  poll_sec: 300,
  status_sec: 600,
  kill_grace_sec: 15,
  stages: Object.freeze({
    premium_render: 4458,          // 2 x 2228.7 s
    qwen_tts_stitch: 2607,         // 2 x 1303.1 s
    visual_reference_plan: 2267,   // 2 x 1133.1 s
    semantic_scene_plan: 1800,
    visual_beat_plan: 1800,
    visual_prompt_plan: 1800,
    visual_prompt_blocker_repair: 1800,
    final_qa: 900,
    image_generation: 900,
    image_output_qa: 900,
    voice_plan: 900,
    longform_audio_mix: 900,
    local_whisper_word_timing: 900,
    motion_edit_plan: 900,
  }),
});

const BUDGET_STOP = [
  new RegExp(EPISODE_BUDGET_STOP_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  /projected spend reaches the locked \$[\d.]+ hard budget/i,
  /Projected Fal episode spend reaches the locked hard budget/i,
  /Fal paid retry cap reached/i,
];
const POLL_VERB = /^(observe|billing-observe|await|poll)/;
const PAID_DISPATCH_ACTION = /^(dispatch-|billing-submit|repair-|recover-)/;
// A timed-out or interrupted Fal dispatch is observed, never resubmitted.
const FAL_OBSERVE_FOR = Object.freeze({
  "dispatch-bulk": "observe-bulk", "dispatch-references": "observe-references", "dispatch-validation": "observe-validation",
  "dispatch-validation-recovery": "observe-validation-recovery", "dispatch-validation-second": "observe-validation-second",
  "dispatch-zone-repair": "observe-zone-repair", "dispatch-adjudicated": "observe-adjudicated",
  "billing-submit": "billing-observe", "billing-submit-reference": "billing-observe-reference",
  "repair-reviewed-bulk": "observe-reviewed-bulk", "repair-failures": "observe-repairs", "repair-reference-failures": "observe-reference-repairs",
  "repair-reviewed-references": "observe-reviewed-references", "repair-failed-repair": "observe-repair-v2",
  "repair-failed-reviewed-reference": "observe-failed-reviewed-reference", "repair-successful-reviewed-references": "observe-successful-reviewed-references",
  "recover-holds": "observe-transport-recovery", "recover-reference-holds": "observe-reference-transport-recovery",
  "recover-reviewed-bulk-hold": "observe-reviewed-bulk",
});

function fingerprint(status) {
  const row = status.stage_ledger?.find((entry) => entry.stage === status.current_stage);
  return JSON.stringify([status.current_stage, status.current_stage_state, status.next_command_shape, row?.evidence ?? null]);
}

async function readJsonLines(filePath) {
  try {
    return (await fs.readFile(filePath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function readDriverEvents(episodeDir) {
  return readJsonLines(path.join(episodeDir, DRIVER_EVENTS_RELATIVE_PATH));
}

export async function writeTriage({ episodeDir, status, reason, kind, findings = [], command = null, output = null, now, extra = {} }) {
  const stage = status?.current_stage ?? "unknown";
  const record = await writeSequencedRecord(episodeDir, "autopilot/triage", `${kind}_${stage}`, {
    schema: AUTOPILOT_TRIAGE_SCHEMA, kind, stage, stage_state: status?.current_stage_state ?? null,
    reason, findings, next_command_shape: status?.next_command_shape ?? null, command,
    output_tail: output ? String(output).slice(-4000) : null,
    ...extra,
    policy: "A blocker is a triage point, not a rerun order: inspect the evidence, record the narrowest repair, then run `goldflow run auto` again.",
    created_at: now(),
  });
  return record.path;
}

async function loadRepairKeys(episodeDir) {
  const rows = await listSequencedRecords(episodeDir, "autopilot/repair_ledger");
  return new Set(rows.flatMap((row) => row.record.keys ?? []));
}

function repairKeysFor(decision) {
  const explicit = [decision.receipt?.repairKey].flat().filter(Boolean);
  const scope = repairScope(decision.argv, decision.stage);
  return [...explicit, ...(scope ? scope.items.map((item) => `${scope.stage}:${scope.verb}:${item}`) : [])];
}

/**
 * A dispatch's identity for the bound check. Recorded in the repair ledger only
 * when the dispatch timed out or was interrupted; afterwards the same dispatch
 * is never re-run automatically (a Fal dispatch is observed instead).
 */
export function dispatchKeyFor(argv = [], stage = null) {
  if (!argv.length) return null;
  const verb = flagValue(argv, "action") ?? argv[1] ?? "";
  const ids = ["image-id", "image-ids", "spec", "directives", "request", "cut-ids", "unit-ids"].map((flag) => flagValue(argv, flag)).filter(Boolean);
  return `dispatch:${stage ?? "unknown"}:${argv[0]} ${verb}:${ids.join(",") || "all"}`;
}

/** The dispatch key of a paid (--confirm-spend) command, else null. */
export function paidDispatchKey(argv = [], stage = null) {
  return flagValue(argv, "confirm-spend") ? dispatchKeyFor(argv, stage) : null;
}

/** The observe shape to run after a Fal dispatch was cut off, or null for non-Fal commands. */
export function falObserveArgvFor(argv = []) {
  if (argv[0] !== "imagegen" || argv[1] !== "fal") return null;
  const action = flagValue(argv, "action") ?? "";
  if (!PAID_DISPATCH_ACTION.test(action) && !flagValue(argv, "confirm-spend")) return null;
  const observe = FAL_OBSERVE_FOR[action] ?? action.replace(/^dispatch-/, "observe-").replace(/^billing-submit/, "billing-observe").replace(/^(repair|recover)-/, "observe-");
  const out = ["imagegen", "fal", "--episode-dir", flagValue(argv, "episode-dir") ?? "<episode-dir>", "--action", observe];
  const imageId = flagValue(argv, "image-id");
  if (imageId) out.push("--image-id", imageId);
  return out;
}

export function wallBudgetSecFor(stage, argv = [], budgets = STAGE_WALL_BUDGETS) {
  const verb = flagValue(argv, "action") ?? argv[1] ?? "";
  if (POLL_VERB.test(verb)) return budgets.poll_sec;
  return budgets.stages[stage] ?? budgets.default_sec;
}

/* ---------- lock ---------- */

async function readLock(episodeDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(episodeDir, DRIVER_LOCK_RELATIVE_PATH), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return { schema: AUTOPILOT_DRIVER_LOCK_SCHEMA, corrupt: true, error: error.message };
  }
}

async function writeLock(episodeDir, lock, { exclusive = false } = {}) {
  const file = path.join(episodeDir, DRIVER_LOCK_RELATIVE_PATH);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(lock, null, 2)}\n`, exclusive ? { flag: "wx" } : {});
}

/**
 * Acquires autopilot/driver.lock {pid, host, started_at, head, heartbeat_at}.
 * Same host + dead pid → takeover (recorded); a live pid or a different host →
 * { held: true }. Returns { acquired, lock, takeover, held, previous }.
 */
export async function acquireDriverLock({ episodeDir, lockDeps, head, now }) {
  const mine = { schema: AUTOPILOT_DRIVER_LOCK_SCHEMA, pid: lockDeps.pid, host: lockDeps.host, started_at: now(), head: head?.commit ?? null, heartbeat_at: now() };
  const previous = await readLock(episodeDir);
  if (!previous) {
    try {
      await writeLock(episodeDir, mine, { exclusive: true });
      return { acquired: true, lock: mine, takeover: false, held: false, previous: null };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      return { acquired: false, held: true, lock: null, takeover: false, previous: await readLock(episodeDir) };
    }
  }
  const sameHost = previous.host === lockDeps.host;
  const alive = sameHost && !previous.corrupt && Number.isInteger(previous.pid) ? lockDeps.processAlive(previous.pid) : null;
  if (previous.corrupt || (sameHost && alive === false)) {
    await writeLock(episodeDir, mine);
    return { acquired: true, lock: mine, takeover: true, held: false, previous };
  }
  return { acquired: false, held: true, lock: null, takeover: false, previous };
}

async function heartbeat(episodeDir, lock, now) {
  lock.heartbeat_at = now();
  await writeLock(episodeDir, lock);
}

async function releaseDriverLock(episodeDir, lock) {
  const current = await readLock(episodeDir);
  if (current && current.pid === lock.pid && current.host === lock.host && current.started_at === lock.started_at) {
    await fs.rm(path.join(episodeDir, DRIVER_LOCK_RELATIVE_PATH), { force: true });
  }
}

/* ---------- code drift (ancestry, never equality) ---------- */

/**
 * identity commit ⊑ HEAD and a clean worktree → continue (a `code_drift` event
 * lists the intervening commits once per distinct HEAD). Not a descendant, or
 * dirty → triage, unless a valid --allow-code-drift reason code was given (then
 * the drift is recorded with that code and the command carries the operator's
 * flag). The identity is never rewritten.
 */
export function codeDriftByAncestry({ identity, head, git, allowReasonCode = null }) {
  const identityCommit = identityCodeCommit(identity);
  const reasonCode = allowReasonCode && CODE_DRIFT_REASON_CODE.test(String(allowReasonCode)) ? String(allowReasonCode) : null;
  if (!identityCommit) return { applicable: false, continue: true, kind: "legacy_identity_without_code_commit", identity_commit: null, head_commit: head?.commit ?? null, dirty: head?.dirty ?? null, reason_code: null, intervening_commits: [] };
  if (!head?.commit) return { applicable: true, continue: false, kind: "executing_worktree_has_no_git_head", identity_commit: identityCommit, head_commit: null, dirty: null, reason_code: reasonCode, intervening_commits: [] };
  const ancestor = git.isAncestor(identityCommit, head.commit);
  const same = identityCommit === head.commit.toLowerCase() || head.commit.toLowerCase().startsWith(identityCommit);
  const intervening = ancestor && !same ? git.intervening(identityCommit, head.commit) : [];
  const base = { applicable: true, identity_commit: identityCommit, head_commit: head.commit, dirty: head.dirty === true, dirty_diff_sha256: head.dirty_diff_sha256 ?? null, intervening_commits: intervening, reason_code: null };
  if (ancestor && head.dirty !== true) return { ...base, continue: true, kind: same ? "head_equals_identity_commit" : "head_descends_from_identity_commit" };
  const kind = !ancestor ? "head_does_not_contain_identity_commit" : "worktree_dirty";
  if (reasonCode) return { ...base, continue: true, kind, reason_code: reasonCode, forward_flag: !ancestor };
  return { ...base, continue: false, kind };
}

/* ---------- SLO (an event, never a stop) ---------- */

async function sloState(episodeDir, identity, now) {
  const file = await fs.readFile(path.join(episodeDir, "production_slo_state.json"), "utf8").then(JSON.parse).catch(() => null);
  if (file) return { source: "production_slo_state.json", state: file.state ?? null, elapsed_minutes: file.elapsed_minutes ?? null, hard_ceiling_minutes: file.hard_ceiling_minutes ?? null, target_minutes: file.target_minutes ?? null };
  const startedAt = Date.parse(identity?.autopilot_policy?.locked_at ?? "");
  if (!Number.isFinite(startedAt)) return null;
  const elapsed = Math.max(0, (Date.parse(now()) - startedAt) / 60_000);
  const hardCeiling = 420;
  const target = 360;
  return { source: "autopilot_policy.locked_at", state: elapsed > hardCeiling ? "breached" : elapsed > target ? "over_target" : "on_track", elapsed_minutes: Number(elapsed.toFixed(3)), hard_ceiling_minutes: hardCeiling, target_minutes: target };
}

/* ---------- resume ---------- */

/** The last `run` event with no matching `exit`/`child_timeout`: a child that was cut off. */
export function interruptedChildFrom(events = []) {
  let open = null;
  for (const event of events) {
    if (event.event === "run") open = event;
    else if (["exit", "child_timeout"].includes(event.event)) open = null;
  }
  return open;
}

/* ---------- plan (dry run) ---------- */

/**
 * `run auto --dry-run`: the schedule from the recorded ledger. Reads status
 * once and the autopilot records; executes nothing, writes nothing, takes no lock.
 */
export async function planAutopilot({ episodeDir, deps, allowCodeDrift = null, wallBudgets = STAGE_WALL_BUDGETS }) {
  const now = deps.now ?? (() => new Date().toISOString());
  const status = await deps.readStatus();
  const identity = status.identity ?? {};
  const repairKeys = await loadRepairKeys(episodeDir);
  const events = await readDriverEvents(episodeDir);
  const triage = await listSequencedRecords(episodeDir, "autopilot/triage");
  const parsed = parseShape(status.next_command_shape, identity);
  const head = deps.git?.head?.() ?? null;
  const drift = codeDriftByAncestry({ identity, head, git: deps.git, allowReasonCode: allowCodeDrift });
  const interrupted = interruptedChildFrom(events);
  const eventCounts = {};
  for (const event of events) eventCounts[event.event] = (eventCounts[event.event] ?? 0) + 1;
  const refusal = String(identity.run_intent ?? "") !== "production" ? "not_production" : autopilotEnabled(identity) ? null : "not_autopilot";
  const paidKey = parsed.argv ? paidDispatchKey(parsed.argv, status.current_stage) : null;
  return {
    schema: "goldflow_autopilot_plan_v1",
    dry_run: true,
    episode_dir: episodeDir,
    refusal,
    refusal_detail: refusal ? AUTOPILOT_REFUSALS[refusal] : null,
    current_stage: status.current_stage,
    current_stage_state: status.current_stage_state,
    next_command_shape: status.next_command_shape,
    next_shape: { executable: parsed.executable, prose: parsed.prose, stage: parsed.stage, recovery: parsed.recovery, placeholders: parsed.placeholders, spend_token: parsed.spend_token,
      disposition: parsed.prose ? "triage:prose" : parsed.placeholders.length ? "triage:placeholder" : repairKeysFor({ argv: parsed.argv, stage: status.current_stage, receipt: null }).some((key) => repairKeys.has(key)) ? "triage:repair_bound" : paidKey && repairKeys.has(paidKey) ? "triage:dispatch_bound" : "run" },
    wall_budget_sec: parsed.argv ? wallBudgetSecFor(status.current_stage, parsed.argv, wallBudgets) : null,
    wall_budget_basis: wallBudgets.basis,
    lock: await readLock(episodeDir),
    code_drift: drift,
    slo: await sloState(episodeDir, identity, now),
    repair_ledger_keys: [...repairKeys].sort(),
    driver_events: { count: events.length, by_event: eventCounts, last: events.slice(-5), interrupted_child: interrupted ? { at: interrupted.at, stage: interrupted.stage, argv: interrupted.argv } : null },
    triage_files: triage.map((row) => ({ path: row.path, kind: row.record.kind, stage: row.record.stage, reason: row.record.reason })),
    stop_reasons: AUTOPILOT_STOP_REASONS,
    generated_at: now(),
  };
}

/* ---------- the driver ---------- */

/**
 * deps: {
 *   readStatus({ timeoutMs }) → status (throws on failure/timeout),
 *   runCommand(argv, { timeoutMs, stage }) → { code, output, timed_out?, signal? },
 *   reviewer, sleep(ms), now(),
 *   lock: { pid, host, processAlive(pid) },
 *   git: { head() → { commit, dirty, dirty_diff_sha256 }, isAncestor(a, b), intervening(a, b) },
 * }
 * Returns { status: "stopped"|"refused", reason, detail?, triage_path?, steps }.
 */
export async function runAutopilot({ episodeDir, deps, maxSteps = 400, maxPolls = 120, pollDelayMs = 30_000, allowCodeDrift = null, wallBudgets = STAGE_WALL_BUDGETS }) {
  const now = deps.now ?? (() => new Date().toISOString());
  const git = deps.git ?? { head: () => null, isAncestor: () => false, intervening: () => [] };
  const lockDeps = deps.lock ?? { pid: process.pid, host: "unknown-host", processAlive: () => true };
  const headNow = () => git.head?.() ?? null;
  let head = headNow();
  const appendEvent = async (event) => {
    const dir = path.join(episodeDir, "autopilot");
    await fs.mkdir(dir, { recursive: true });
    const row = { schema: AUTOPILOT_DRIVER_EVENT_SCHEMA, at: now(), ...event, head_commit: head?.commit ?? null, worktree_dirty: head?.dirty ?? null, dirty_diff_sha256: head?.dirty_diff_sha256 ?? null, driver_pid: lockDeps.pid, driver_host: lockDeps.host };
    await fs.appendFile(path.join(dir, "driver_events.jsonl"), `${JSON.stringify(row)}\n`);
    return row;
  };

  let status;
  try {
    status = await deps.readStatus({ timeoutMs: wallBudgets.status_sec * 1000 });
  } catch (error) {
    const triagePath = await writeTriage({ episodeDir, status: null, kind: "status_timeout", reason: `run status failed or exceeded ${wallBudgets.status_sec} s: ${error.message}`, now });
    return { status: "stopped", reason: "status_timeout", detail: error.message, triage_path: triagePath, steps: 0 };
  }
  const identity = status.identity ?? {};
  if (String(identity.run_intent ?? "") !== "production") {
    return { status: "refused", reason: "not_production", detail: AUTOPILOT_REFUSALS.not_production, steps: 0 };
  }
  if (!autopilotEnabled(identity)) {
    return { status: "refused", reason: "not_autopilot", detail: AUTOPILOT_REFUSALS.not_autopilot, steps: 0 };
  }

  // (a) One driver per episode.
  const lock = await acquireDriverLock({ episodeDir, lockDeps, head, now });
  if (!lock.acquired) {
    const triagePath = await writeTriage({ episodeDir, status, kind: "lock_held", now,
      reason: `autopilot/driver.lock is held by pid ${lock.previous?.pid ?? "?"} on ${lock.previous?.host ?? "?"} (started ${lock.previous?.started_at ?? "?"}, heartbeat ${lock.previous?.heartbeat_at ?? "?"}); a second driver never runs beside it.`,
      extra: { lock: lock.previous } });
    await appendEvent({ event: "lock_held", stage: status.current_stage, lock: lock.previous, triage_path: triagePath });
    return { status: "stopped", reason: "lock_held", detail: "another driver holds the lock", triage_path: triagePath, steps: 0 };
  }
  if (lock.takeover) await appendEvent({ event: "lock_takeover", stage: status.current_stage, previous_lock: lock.previous, lock: lock.lock });

  try {
    // (b) Code drift by ancestry.
    const drift = codeDriftByAncestry({ identity, head, git, allowReasonCode: allowCodeDrift });
    const priorEvents = await readDriverEvents(episodeDir);
    if (drift.applicable && drift.continue && drift.kind !== "head_equals_identity_commit") {
      const alreadyRecorded = priorEvents.some((event) => event.event === "code_drift" && event.head_commit === drift.head_commit && event.kind === drift.kind && (event.reason_code ?? null) === drift.reason_code);
      if (!alreadyRecorded) await appendEvent({ event: "code_drift", stage: status.current_stage, kind: drift.kind, identity_commit: drift.identity_commit, intervening_commits: drift.intervening_commits, dirty: drift.dirty, reason_code: drift.reason_code });
    }
    if (drift.applicable && !drift.continue) {
      const triagePath = await writeTriage({ episodeDir, status, kind: "code_drift", now,
        reason: `${drift.kind}: identity commit ${drift.identity_commit}, executing HEAD ${drift.head_commit ?? "unknown"}${drift.dirty ? ", worktree dirty" : ""}. Run from a clean worktree whose HEAD contains the identity commit, or pass --allow-code-drift <reason-code> to record the drift; the identity is never rewritten.`,
        extra: { code_drift: drift } });
      await appendEvent({ event: "triage", stage: status.current_stage, reason: "code_drift", kind: drift.kind, triage_path: triagePath });
      return { status: "stopped", reason: "code_drift", detail: drift.kind, triage_path: triagePath, steps: 0 };
    }
    const forwardDrift = drift.forward_flag ? ["--allow-code-drift", drift.reason_code] : [];

    // (e) Resume: the repair ledger already blocks re-dispatch of recorded repairs;
    // an interrupted in-flight child is recorded, and a cut-off paid dispatch is
    // observed rather than resubmitted.
    const repairLedger = await loadRepairKeys(episodeDir);
    const interrupted = interruptedChildFrom(priorEvents);
    if (interrupted) {
      const key = paidDispatchKey(interrupted.argv ?? [], interrupted.stage);
      await appendEvent({ event: "interrupted_child", stage: interrupted.stage, argv: interrupted.argv, interrupted_at: interrupted.at, paid_dispatch_key: key,
        fal_observe_argv: falObserveArgvFor(interrupted.argv ?? []), note: "The previous driver stopped while this child was running; its partial outputs are left for status to judge." });
      if (key && !repairLedger.has(key)) {
        await writeSequencedRecord(episodeDir, "autopilot/repair_ledger", `interrupted_${interrupted.stage}`, { schema: AUTOPILOT_REPAIR_SCHEMA, keys: [key], command: interrupted.argv, reason: "interrupted paid dispatch; observe, never resubmit", created_at: now() });
        repairLedger.add(key);
      }
    }

    let polls = 0;
    let sloRecorded = priorEvents.some((event) => event.event === "slo_breach");
    for (let steps = 0; steps < maxSteps; steps += 1) {
      head = headNow();
      await heartbeat(episodeDir, lock.lock, now);
      // (d) SLO breach is an event, never a stop.
      const slo = await sloState(episodeDir, identity, now);
      if (slo?.state === "breached" && !sloRecorded) {
        sloRecorded = true;
        await appendEvent({ event: "slo_breach", stage: status.current_stage, ...slo, policy: "continue the single critical path; never start optional retries or hide elapsed time" });
      }
      let decision;
      try {
        decision = await decideNext({ status, episodeDir, deps: { reviewer: deps.reviewer, repairLedger } });
      } catch (error) {
        decision = { kind: "triage", stage: status.current_stage, reason: `automatic decision failed: ${error.message}` };
      }
      if (decision.kind === "stop") {
        await appendEvent({ event: "stop", reason: decision.reason, stage: status.current_stage, detail: decision.detail });
        return { status: "stopped", reason: decision.reason, detail: decision.detail, steps };
      }
      if (decision.kind === "run" && decision.argv[0] === "run" && decision.argv[1] === "relock-tts") {
        decision = { kind: "triage", stage: status.current_stage, reason: "run relock-tts is operator-only and never dispatched by run auto" };
      }
      if (decision.kind === "triage") {
        const triagePath = await writeTriage({ episodeDir, status, reason: decision.reason, kind: "blocker", findings: decision.findings, now });
        await appendEvent({ event: "triage", stage: status.current_stage, reason: decision.reason, triage_path: triagePath });
        return { status: "stopped", reason: "blocker", detail: decision.reason, triage_path: triagePath, steps };
      }
      const keys = repairKeysFor(decision);
      const repeated = keys.filter((key) => repairLedger.has(key));
      if (repeated.length) {
        const triagePath = await writeTriage({ episodeDir, status, kind: "blocker", command: decision.argv, now,
          reason: `bounded repair exhausted: ${repeated.join(", ")} already had its one automatic exact-scope repair` });
        await appendEvent({ event: "triage", stage: status.current_stage, reason: "repair_bound", triage_path: triagePath });
        return { status: "stopped", reason: "blocker", detail: "repair bound reached", triage_path: triagePath, steps };
      }
      const dispatchKey = dispatchKeyFor(decision.argv, decision.stage);
      if (dispatchKey && repairLedger.has(dispatchKey)) {
        const observe = falObserveArgvFor(decision.argv);
        const triagePath = await writeTriage({ episodeDir, status, kind: "blocker", command: decision.argv, now,
          reason: `dispatch ${dispatchKey} already timed out or was interrupted once; it is never re-run automatically. ${observe ? `Observe the already-submitted request IDs with: node bin/goldflow.mjs ${observe.join(" ")}, then` : "Inspect its partial outputs, then"} record the narrowest repair.`,
          extra: { fal_observe_argv: observe } });
        await appendEvent({ event: "triage", stage: status.current_stage, reason: "dispatch_bound", triage_path: triagePath });
        return { status: "stopped", reason: "blocker", detail: "dispatch bound reached", triage_path: triagePath, steps };
      }
      if (decision.receipt && decision.receipt.method !== "status_command") {
        await recordAutopilotDecision({ episodeDir, stage: decision.stage, method: decision.receipt.method, decision: decision.receipt.decision,
          evidence: decision.receipt.evidence, findings: decision.receipt.findings, note: decision.receipt.note, command: decision.argv, now: now() });
      }
      if (keys.length) {
        // Recorded before running, so an interrupted repair is never retried automatically.
        await writeSequencedRecord(episodeDir, "autopilot/repair_ledger", decision.stage, { schema: AUTOPILOT_REPAIR_SCHEMA, keys, command: decision.argv, created_at: now() });
        keys.forEach((key) => repairLedger.add(key));
      }
      const before = fingerprint(status);
      const argv = [...decision.argv, ...forwardDrift];
      const budgetSec = wallBudgetSecFor(decision.stage, decision.argv, wallBudgets);
      await appendEvent({ event: "run", stage: decision.stage, argv, wall_budget_sec: budgetSec });
      const result = await deps.runCommand(argv, { timeoutMs: budgetSec * 1000, stage: decision.stage });
      if (result.timed_out) {
        // (c) Terminal: the process group is already killed by runCommand; the
        // dispatch counts against its key so it is never re-dispatched, and a Fal
        // dispatch is observed, never resubmitted. Spend authorizations stay as recorded.
        const timeoutKey = dispatchKey;
        await writeSequencedRecord(episodeDir, "autopilot/repair_ledger", `timeout_${decision.stage}`, { schema: AUTOPILOT_REPAIR_SCHEMA, keys: [timeoutKey], command: decision.argv, reason: `child exceeded ${budgetSec} s wall budget`, created_at: now() });
        repairLedger.add(timeoutKey);
        const observe = falObserveArgvFor(decision.argv);
        const triagePath = await writeTriage({ episodeDir, status, kind: "child_timeout", command: argv, output: result.output, now,
          reason: `child exceeded its ${budgetSec} s wall budget (${wallBudgets.basis}); its process group was signalled (${result.signal ?? "SIGTERM"}) and it will not be re-dispatched automatically${observe ? `. Observe the already-submitted Fal request IDs with: node bin/goldflow.mjs ${observe.join(" ")}; never resubmit` : ""}.`,
          extra: { wall_budget_sec: budgetSec, repair_key: timeoutKey, fal_observe_argv: observe } });
        await appendEvent({ event: "child_timeout", stage: decision.stage, wall_budget_sec: budgetSec, signal: result.signal ?? null, repair_key: timeoutKey, fal_observe_argv: observe, triage_path: triagePath });
        return { status: "stopped", reason: "child_timeout", detail: `${decision.argv.slice(0, 2).join(" ")} exceeded ${budgetSec} s`, triage_path: triagePath, steps: steps + 1 };
      }
      await appendEvent({ event: "exit", stage: decision.stage, code: result.code });
      if (result.code !== 0 && BUDGET_STOP.some((pattern) => pattern.test(String(result.output ?? "")))) {
        const triagePath = await writeTriage({ episodeDir, status, kind: "budget_stop", command: argv, output: result.output, now,
          reason: "A hard budget refused this dispatch (episode cap, Fal hard budget or paid-retry cap). Raising a cap is an operator decision." });
        await appendEvent({ event: "budget_stop", triage_path: triagePath });
        return { status: "stopped", reason: "budget_stop", detail: decision.argv.join(" "), triage_path: triagePath, steps: steps + 1 };
      }
      try {
        status = await deps.readStatus({ timeoutMs: wallBudgets.status_sec * 1000 });
      } catch (error) {
        const triagePath = await writeTriage({ episodeDir, status, kind: "status_timeout", command: argv, now, reason: `run status failed or exceeded ${wallBudgets.status_sec} s after the command: ${error.message}` });
        await appendEvent({ event: "status_timeout", stage: decision.stage, triage_path: triagePath });
        return { status: "stopped", reason: "status_timeout", detail: error.message, triage_path: triagePath, steps: steps + 1 };
      }
      if (fingerprint(status) !== before) {
        polls = 0;
        continue;
      }
      const verb = flagValue(decision.argv, "action") ?? decision.argv[1] ?? "";
      if (result.code === 0 && POLL_VERB.test(verb) && polls < maxPolls) {
        polls += 1;
        await deps.sleep(pollDelayMs);
        status = await deps.readStatus({ timeoutMs: wallBudgets.status_sec * 1000 });
        continue;
      }
      const triagePath = await writeTriage({ episodeDir, status, kind: "blocker", command: argv, output: result.output, now,
        reason: `command exited ${result.code} and did not change run status; not retried automatically` });
      await appendEvent({ event: "triage", stage: status.current_stage, reason: "no_progress", triage_path: triagePath });
      return { status: "stopped", reason: "blocker", detail: "no progress", triage_path: triagePath, steps: steps + 1 };
    }
    const triagePath = await writeTriage({ episodeDir, status, kind: "blocker", reason: `step limit ${maxSteps} reached`, now });
    await appendEvent({ event: "triage", stage: status.current_stage, reason: "step_limit", triage_path: triagePath });
    return { status: "stopped", reason: "blocker", detail: "step limit", triage_path: triagePath, steps: maxSteps };
  } finally {
    await releaseDriverLock(episodeDir, lock.lock);
  }
}
