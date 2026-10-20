// `--workflow-bypass true` is an operator exception, never a routine shape. Every
// new use must carry `--bypass-reason-code <code>` from this fixed enum; the code
// is written into the stage execution event (new writes only — historical
// events with prose reasons stay readable and are never backfilled). The
// environment bypass path no longer exists.
export const WORKFLOW_BYPASS_REASON_CODES = Object.freeze([
  // Automated test fixtures that exercise a child script out of stage order.
  "test_fixture",
  // Read-only or diagnostic run of a stage command outside its stage, no artifact kept.
  "operator_diagnostic",
  // Operator-approved exact-scope recovery whose shape the guard does not admit yet.
  "operator_approved_recovery",
  // Operator-approved full-stage rerun (pairs with --allow-full-stage-rerun --rerun-reason).
  "operator_approved_full_stage_rerun",
  // Operator-approved maintenance of a historical identity (legacy adapters, migrations).
  "legacy_identity_maintenance",
]);

export const BYPASS_REASON_FLAG = "bypass-reason-code";

export function isTrueFlag(value) {
  return /^(true|1|yes)$/i.test(String(value ?? ""));
}

/**
 * Decides whether a parsed flag set requests a bypass and whether that request is
 * well-formed. Returns { requested, allowed, reason_code, reason }.
 */
export function workflowBypassDecision(flags = {}) {
  const requested = isTrueFlag(flags["workflow-bypass"]);
  const code = Object.hasOwn(flags, BYPASS_REASON_FLAG) ? String(flags[BYPASS_REASON_FLAG] ?? "").trim() : null;
  if (!requested) {
    return code
      ? { requested: false, allowed: false, reason_code: code, reason: `--${BYPASS_REASON_FLAG} is only meaningful with --workflow-bypass true.` }
      : { requested: false, allowed: true, reason_code: null, reason: null };
  }
  if (!code) {
    return { requested: true, allowed: false, reason_code: null, reason: `--workflow-bypass true requires --${BYPASS_REASON_FLAG} <${WORKFLOW_BYPASS_REASON_CODES.join("|")}>.` };
  }
  if (!WORKFLOW_BYPASS_REASON_CODES.includes(code)) {
    return { requested: true, allowed: false, reason_code: code, reason: `Unknown --${BYPASS_REASON_FLAG} "${code}"; use one of ${WORKFLOW_BYPASS_REASON_CODES.join(", ")}.` };
  }
  return { requested: true, allowed: true, reason_code: code, reason: null };
}

/** The structured bypass field recorded on a new execution event, or null. */
export function workflowBypassRecord(flags = {}) {
  const decision = workflowBypassDecision(flags);
  if (!decision.requested) return null;
  return { reason_code: decision.reason_code, rerun_reason: flags["rerun-reason"] ?? null, allow_full_stage_rerun: isTrueFlag(flags["allow-full-stage-rerun"]) };
}
