// State-conditioned admissions for decision-bearing command shapes that the
// workflow guard used to refuse (R07). Each admission answers for exactly one
// (shape, state) pair and returns { applicable, allowed, reason, admission }.
// Nothing here widens a stage: an admission only recognises an authorized
// decision the ledger already asks for, so no `--workflow-bypass` is needed.
import { existsSync } from "node:fs";
import path from "node:path";
import { isAutomatedReviewer } from "./autopilot-policy.mjs";
import { narrationTtsPolicyForIdentity } from "./narration-tts-policy.mjs";
import { narrationUsesAutomatedAsrAcceptance } from "./narration-quality-contract.mjs";
import { goldflowArgv, flagValue } from "./autopilot-command-shape.mjs";
import { currentIdentityRevisionSync } from "./run-identity-revisions.mjs";

const isTrue = (value) => /^(true|1|yes)$/i.test(String(value ?? ""));
const ledgerRow = (status, stage) => status?.stage_ledger?.find((row) => row.stage === stage) ?? null;
const notApplicable = { applicable: false, allowed: false, reason: null, admission: null };
const admit = (admission) => ({ applicable: true, allowed: true, reason: null, admission });
const refuse = (admission, reason) => ({ applicable: true, allowed: false, reason, admission });
const hasRerunFlags = (flags) => isTrue(flags["allow-full-stage-rerun"]) || Object.hasOwn(flags, "rerun-reason") || isTrue(flags["workflow-bypass"]);
const splitIds = (value) => String(value ?? "").split(",").map((part) => part.trim()).filter(Boolean);

/** image_output_qa is awaiting decisions: ledger row blocked, or the QA report says needs_manual_review. */
export function imageQaDecisionState(status) {
  const row = ledgerRow(status, "image_output_qa");
  if (!row) return null;
  if (row.state === "blocked") return "blocked";
  if (/status=needs_manual_review\b/.test(String(row.evidence ?? ""))) return "needs_manual_review";
  return null;
}

/**
 * `imagegen qa --accept-cut-ids/--critical-reject-cut-ids/--reject-cut-ids … --reviewer <r> --note …`
 * when image_output_qa is needs_manual_review|blocked. The reviewer may be a
 * person or `automated:<method>`; the decision artifact is the same.
 */
export function imageQaDecisionAdmission(status, command, subcommand, flags = {}) {
  if (command !== "imagegen" || subcommand !== "qa") return notApplicable;
  const decisionFlags = ["accept-cut-ids", "accept-image-ids", "critical-reject-cut-ids", "reject-cut-ids"].filter((name) => splitIds(flags[name]).length);
  if (!decisionFlags.length || !String(flags.reviewer ?? "").trim()) return notApplicable;
  const state = imageQaDecisionState(status);
  const admission = "image_qa_decision";
  if (!state) return refuse(admission, "imagegen qa cut decisions are admitted only while image_output_qa is needs_manual_review or blocked.");
  if (!String(flags.note ?? "").trim()) return refuse(admission, "Image QA decisions require --note so output QA has review provenance.");
  if (hasRerunFlags(flags)) return refuse(admission, "Image QA decisions never combine with full-stage rerun flags.");
  return admit(admission);
}

/**
 * `final qa --approve true --reviewed-finding-codes <codes> --note …` when the
 * final_qa row is blocked|failed|needs_review|stale (findings exist and the
 * approval records which codes were reviewed), plus the autopilot
 * `--agent-review true --approved-by automated:<method>` form in those states.
 */
export function finalQaApprovalAdmission(status, command, subcommand, flags = {}) {
  if (command !== "final" || subcommand !== "qa") return notApplicable;
  const approves = isTrue(flags.approve) || isTrue(flags["agent-review"]);
  if (!approves) return notApplicable;
  const row = ledgerRow(status, "final_qa");
  const admission = "final_qa_approval";
  if (!row || !["blocked", "failed", "needs_review", "stale"].includes(String(row.state ?? ""))) {
    return refuse(admission, `final qa approval shapes are admitted only while final_qa is blocked, failed, needs_review or stale (now ${row?.state ?? "absent"}).`);
  }
  const reviewedCodes = Object.hasOwn(flags, "reviewed-finding-codes");
  const automated = isAutomatedReviewer(flags["approved-by"]) && isTrue(flags["agent-review"]);
  if (!reviewedCodes && !automated) return refuse(admission, "final qa --approve true requires --reviewed-finding-codes (or the automated --agent-review true --approved-by automated:<method> form).");
  if (hasRerunFlags(flags)) return refuse(admission, "final qa approval never combines with full-stage rerun flags.");
  return admit(admission);
}

export function narrationAutomatedAsr(identity = {}) {
  try {
    return narrationUsesAutomatedAsrAcceptance(narrationTtsPolicyForIdentity(identity).narration_quality_contract);
  } catch {
    return false;
  }
}

/**
 * Narration shapes under `automated_asr_v1` while qwen_tts_stitch is blocked:
 *  - `tts narrate --confirmed-retry-unit-ids <ids ⊆ status ids> --confirmed-retry-evidence <status path>`
 *    (a narrower exact retake of what status already asks for);
 *  - `tts repair-boundary --spec <existing episode file>`;
 *  - `tts finalize-provider --manifest <existing episode file> [evidence flags]`.
 * None may carry rerun flags; a legacy (listening) contract is never admitted here.
 */
export function narrationAutomatedAsrAdmission(status, command, subcommand, flags = {}) {
  if (command !== "tts" || !["narrate", "repair-boundary", "finalize-provider"].includes(subcommand)) return notApplicable;
  if (status?.current_stage !== "qwen_tts_stitch" || status?.current_stage_state !== "blocked") return notApplicable;
  const admission = `narration_automated_asr_${subcommand.replaceAll("-", "_")}`;
  if (!narrationAutomatedAsr(status.identity ?? {})) return notApplicable;
  if (hasRerunFlags(flags)) return refuse(admission, "Blocked narration never admits full-stage rerun flags; repair the exact units instead.");
  const episodeDir = status.episode_dir;
  const inside = (file) => typeof file === "string" && file.length > 0 && episodeDir && path.resolve(file).startsWith(`${path.resolve(episodeDir)}${path.sep}`) && existsSync(file);
  const statusArgv = goldflowArgv(status.next_command_shape) ?? [];
  if (subcommand === "narrate") {
    const keys = Object.keys(flags).sort().join(",");
    if (keys !== "confirmed-retry-evidence,confirmed-retry-unit-ids,episode-dir") return refuse(admission, "Blocked narration admits only --episode-dir, --confirmed-retry-unit-ids and --confirmed-retry-evidence.");
    const requested = splitIds(flags["confirmed-retry-unit-ids"]);
    const named = splitIds(flagValue(statusArgv, "confirmed-retry-unit-ids"));
    const evidence = flagValue(statusArgv, "confirmed-retry-evidence");
    if (!requested.length || !named.length) return refuse(admission, "Status names no confirmed retry units for this blocked narration.");
    if (!requested.every((id) => named.includes(id))) return refuse(admission, `Retake units must be a subset of the status-named units (${named.join(", ")}).`);
    if (flags["confirmed-retry-evidence"] !== evidence || !inside(evidence)) return refuse(admission, "Retake evidence must be the hash-bound packet status names.");
    return admit(admission);
  }
  if (subcommand === "repair-boundary") {
    if (!inside(flags.spec)) return refuse(admission, "tts repair-boundary needs --spec pointing at an existing repair spec inside the episode directory.");
    return admit(admission);
  }
  const manifest = flags.manifest;
  if (manifest !== undefined && !inside(manifest)) return refuse(admission, "tts finalize-provider --manifest must name an existing provider-output manifest inside the episode directory.");
  const allowedKeys = new Set(["episode-dir", "manifest", "asr-orthography-evidence", "pronunciation-review-evidence", "automated-pronunciation-evidence", "contraction-expansion-evidence", "contextual-asr-evidence", "full-stream-spacing-bridge-evidence", "manual-review-evidence", "full-stream-review-evidence"]);
  const extra = Object.keys(flags).filter((key) => !allowedKeys.has(key));
  if (extra.length) return refuse(admission, `tts finalize-provider admits only evidence flags here; unexpected: ${extra.join(", ")}.`);
  return admit(admission);
}

/**
 * `run relock-tts … --approved-by <human>`: operator-only. Admitted without a
 * bypass on a production identity; the command itself appends an identity
 * revision record. Automated reviewers and `run auto` never reach this.
 */
export function relockTtsAdmission(status, command, subcommand, flags = {}) {
  if (command !== "run" || subcommand !== "relock-tts") return notApplicable;
  const admission = "operator_relock_tts";
  const approvedBy = String(flags["approved-by"] ?? "").trim();
  if (!approvedBy) return refuse(admission, "run relock-tts requires --approved-by <operator>; it is never dispatched automatically.");
  if (isAutomatedReviewer(approvedBy)) return refuse(admission, "run relock-tts cannot be approved by an automated reviewer.");
  if (String(status?.identity?.run_intent ?? "production") !== "production") return refuse(admission, "run relock-tts is scoped to production identities.");
  return admit(admission);
}

/** Post-relock first attempts: the current identity revision makes a stage at/after its boundary fresh. */
export function identityRevisionFor(episodeDir) {
  return episodeDir ? currentIdentityRevisionSync(episodeDir) : null;
}

export const R07_ADMISSIONS = Object.freeze([
  imageQaDecisionAdmission,
  finalQaApprovalAdmission,
  narrationAutomatedAsrAdmission,
  relockTtsAdmission,
]);

/**
 * Runs the R07 admissions in order. Returns the first applicable decision or
 * { applicable: false } when none applies (the ordinary guard then decides).
 */
export function decisionShapeAdmission(status, command, subcommand, flags = {}) {
  for (const admission of R07_ADMISSIONS) {
    const decision = admission(status, command, subcommand, flags);
    if (decision.applicable) return decision;
  }
  return notApplicable;
}
