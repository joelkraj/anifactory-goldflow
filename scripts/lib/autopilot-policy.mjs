import path from "node:path";
import { episodeBudgetFor, fileSha256, writeSequencedRecord } from "./episode-budget.mjs";

// Autopilot runs a production episode to a final watch with two human steps.
// The policy is locked into the run identity at preflight; it never applies
// retroactively to historical identities or to proof lanes.
export const AUTOPILOT_POLICY_SCHEMA = "goldflow_autopilot_policy_v1";
export const AUTOPILOT_POLICY_VERSION = "2026-10-20.1";
export const AUTOPILOT_DECISION_SCHEMA = "goldflow_autopilot_decision_v1";
export const AUTOMATED_REVIEWER_PREFIX = "automated:";
export const AUTOPILOT_HUMAN_STEPS = Object.freeze(["final_watch", "publish_approval"]);

function need(value, message) {
  if (!value) throw new Error(message);
}

export function automatedReviewer(method) {
  need(/^[a-z][a-z0-9_]{2,63}$/.test(String(method ?? "")), `Invalid automated review method: ${method}`);
  return `${AUTOMATED_REVIEWER_PREFIX}${method}`;
}

export function isAutomatedReviewer(value) {
  return /^automated:[a-z][a-z0-9_]{2,63}$/.test(String(value ?? ""));
}

export function buildAutopilotPolicy({ lockedAt, runIntent }) {
  need(runIntent === "production", "--autopilot true is limited to production intent; proofs keep their approval gates.");
  return {
    schema: AUTOPILOT_POLICY_SCHEMA,
    version: AUTOPILOT_POLICY_VERSION,
    enabled: true,
    human_steps: [...AUTOPILOT_HUMAN_STEPS],
    automated_reviewer_prefix: AUTOMATED_REVIEWER_PREFIX,
    bounded_repairs_per_item: 1,
    initial_youtube_visibility: "private",
    locked_at: lockedAt,
  };
}

/** Validates the preflight --autopilot flag; returns { autopilot_policy } or {}. */
export function autopilotIdentityFields(flags = {}, { runIntent, lockedAt, episodeBudget = null, narrationAcceptanceMode = null } = {}) {
  if (!/^(true|1|yes)$/i.test(String(flags.autopilot ?? ""))) return {};
  need(episodeBudget, "--autopilot true requires --episode-budget-usd <usd>.");
  need(narrationAcceptanceMode === "automated_asr_v1",
    "--autopilot true requires a production profile with automated_asr_v1 narration acceptance (fast_premium_v2); listening attestations cannot be automated honestly.");
  return { autopilot_policy: buildAutopilotPolicy({ lockedAt, runIntent }) };
}

export function autopilotEnabled(identity = {}) {
  const policy = identity?.autopilot_policy;
  return policy?.schema === AUTOPILOT_POLICY_SCHEMA && policy.enabled === true
    && identity?.run_intent === "production" && episodeBudgetFor(identity) !== null;
}

/** Hash-binds evidence files: [{ role, path }] → [{ role, path, sha256 }]. */
export async function evidenceRefs(rows = []) {
  return Promise.all(rows.filter((row) => row?.path).map(async (row) => ({
    role: row.role, path: row.path, sha256: await fileSha256(row.path),
  })));
}

/** One receipt per automatic decision; the approval artifact itself is written by the gate's own command. */
export async function recordAutopilotDecision({ episodeDir, stage, method, decision, evidence = [], findings = [], command = null, note = null, now = new Date().toISOString() }) {
  need(["approve", "reject", "repair", "triage", "execute"].includes(decision), `Unknown autopilot decision: ${decision}`);
  return writeSequencedRecord(episodeDir, "autopilot/decisions", `${stage}_${method}`, {
    schema: AUTOPILOT_DECISION_SCHEMA,
    stage,
    method,
    reviewer: automatedReviewer(method),
    decision,
    note,
    findings,
    evidence: await evidenceRefs(evidence),
    run_identity_sha256: await fileSha256(path.join(episodeDir, "run_identity.json")),
    command,
    created_at: now,
  });
}
