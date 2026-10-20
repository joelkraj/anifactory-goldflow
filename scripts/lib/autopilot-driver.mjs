import { promises as fs } from "node:fs";
import path from "node:path";
import { autopilotEnabled, recordAutopilotDecision } from "./autopilot-policy.mjs";
import { decideNext } from "./autopilot-gates.mjs";
import { repairScope, flagValue } from "./autopilot-command-shape.mjs";
import { EPISODE_BUDGET_STOP_PREFIX, listSequencedRecords, writeSequencedRecord } from "./episode-budget.mjs";

// `goldflow run auto`: status → next valid command → status, until a human
// step, a budget stop or a blocker. Every stop other than the two human steps
// writes a triage file; nothing is skipped silently.
export const AUTOPILOT_TRIAGE_SCHEMA = "goldflow_autopilot_triage_v1";
export const AUTOPILOT_REPAIR_SCHEMA = "goldflow_autopilot_repair_v1";
const BUDGET_STOP = [
  new RegExp(EPISODE_BUDGET_STOP_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  /projected spend reaches the locked \$[\d.]+ hard budget/i,
  /Projected Fal episode spend reaches the locked hard budget/i,
  /Fal paid retry cap reached/i,
];
const POLL_VERB = /^(observe|billing-observe|await|poll)/;

function fingerprint(status) {
  const row = status.stage_ledger?.find((entry) => entry.stage === status.current_stage);
  return JSON.stringify([status.current_stage, status.current_stage_state, status.next_command_shape, row?.evidence ?? null]);
}

async function appendEvent(episodeDir, event) {
  const dir = path.join(episodeDir, "autopilot");
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, "driver_events.jsonl"), `${JSON.stringify(event)}\n`);
}

export async function writeTriage({ episodeDir, status, reason, kind, findings = [], command = null, output = null, now }) {
  const stage = status?.current_stage ?? "unknown";
  const record = await writeSequencedRecord(episodeDir, "autopilot/triage", `${kind}_${stage}`, {
    schema: AUTOPILOT_TRIAGE_SCHEMA, kind, stage, stage_state: status?.current_stage_state ?? null,
    reason, findings, next_command_shape: status?.next_command_shape ?? null, command,
    output_tail: output ? String(output).slice(-4000) : null,
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
 * deps: { readStatus(): status, runCommand(argv): { code, output }, reviewer, sleep(ms), now() }
 * Returns { status: "stopped", reason, detail?, triage_path?, steps }.
 */
export async function runAutopilot({ episodeDir, deps, maxSteps = 400, maxPolls = 120, pollDelayMs = 30_000 }) {
  const now = deps.now ?? (() => new Date().toISOString());
  const repairLedger = await loadRepairKeys(episodeDir);
  let status = await deps.readStatus();
  if (!autopilotEnabled(status.identity ?? {})) {
    return { status: "refused", reason: "not_autopilot", detail: "run auto needs an identity locked with --autopilot true and --episode-budget-usd.", steps: 0 };
  }
  let polls = 0;
  for (let steps = 0; steps < maxSteps; steps += 1) {
    let decision;
    try {
      decision = await decideNext({ status, episodeDir, deps: { reviewer: deps.reviewer, repairLedger } });
    } catch (error) {
      decision = { kind: "triage", stage: status.current_stage, reason: `automatic decision failed: ${error.message}` };
    }
    if (decision.kind === "stop") {
      await appendEvent(episodeDir, { at: now(), event: "stop", reason: decision.reason, stage: status.current_stage, detail: decision.detail });
      return { status: "stopped", reason: decision.reason, detail: decision.detail, steps };
    }
    if (decision.kind === "triage") {
      const triagePath = await writeTriage({ episodeDir, status, reason: decision.reason, kind: "blocker", findings: decision.findings, now });
      await appendEvent(episodeDir, { at: now(), event: "triage", stage: status.current_stage, reason: decision.reason, triage_path: triagePath });
      return { status: "stopped", reason: "blocker", detail: decision.reason, triage_path: triagePath, steps };
    }
    const keys = repairKeysFor(decision);
    const repeated = keys.filter((key) => repairLedger.has(key));
    if (repeated.length) {
      const triagePath = await writeTriage({ episodeDir, status, kind: "blocker", command: decision.argv, now,
        reason: `bounded repair exhausted: ${repeated.join(", ")} already had its one automatic exact-scope repair` });
      await appendEvent(episodeDir, { at: now(), event: "triage", stage: status.current_stage, reason: "repair_bound", triage_path: triagePath });
      return { status: "stopped", reason: "blocker", detail: "repair bound reached", triage_path: triagePath, steps };
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
    await appendEvent(episodeDir, { at: now(), event: "run", stage: decision.stage, argv: decision.argv });
    const result = await deps.runCommand(decision.argv);
    await appendEvent(episodeDir, { at: now(), event: "exit", stage: decision.stage, code: result.code });
    if (result.code !== 0 && BUDGET_STOP.some((pattern) => pattern.test(String(result.output ?? "")))) {
      const triagePath = await writeTriage({ episodeDir, status, kind: "budget_stop", command: decision.argv, output: result.output, now,
        reason: "A hard budget refused this dispatch (episode cap, Fal hard budget or paid-retry cap). Raising a cap is an operator decision." });
      await appendEvent(episodeDir, { at: now(), event: "budget_stop", triage_path: triagePath });
      return { status: "stopped", reason: "budget_stop", detail: decision.argv.join(" "), triage_path: triagePath, steps: steps + 1 };
    }
    status = await deps.readStatus();
    if (fingerprint(status) !== before) {
      polls = 0;
      continue;
    }
    const verb = flagValue(decision.argv, "action") ?? decision.argv[1] ?? "";
    if (result.code === 0 && POLL_VERB.test(verb) && polls < maxPolls) {
      polls += 1;
      await deps.sleep(pollDelayMs);
      status = await deps.readStatus();
      continue;
    }
    const triagePath = await writeTriage({ episodeDir, status, kind: "blocker", command: decision.argv, output: result.output, now,
      reason: `command exited ${result.code} and did not change run status; not retried automatically` });
    await appendEvent(episodeDir, { at: now(), event: "triage", stage: status.current_stage, reason: "no_progress", triage_path: triagePath });
    return { status: "stopped", reason: "blocker", detail: "no progress", triage_path: triagePath, steps: steps + 1 };
  }
  const triagePath = await writeTriage({ episodeDir, status, kind: "blocker", reason: `step limit ${maxSteps} reached`, now });
  return { status: "stopped", reason: "blocker", detail: "step limit", triage_path: triagePath, steps: maxSteps };
}
