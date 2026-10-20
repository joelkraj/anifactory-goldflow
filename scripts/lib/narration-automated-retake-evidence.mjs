import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalQwenBatchSha256 } from "./qwen-liam-batch-contract.mjs";

// Stabilization roadmap R05(1): under `automated_asr_v1`, `tts narrate` authors
// its own versioned, hash-bound retake evidence instead of waiting for a hand
// file. The shape extends the automated `recovery_authorization` already
// emitted by `tts repair-pronunciation-auto` / `tts repair-contraction`
// (evidence_basis reviewed_automated_delivery_qa, human_listening_performed
// false) and is exactly what validateConfirmedRetryEvidenceForTests requires:
// bound to the canonical plan hash, the plan file hash, the source script hash
// and the exact blocked pre-retry report, one retake per first take, and one
// confirmed_units row per blocked unit carrying its reviewed blocker codes and
// selected-QA hash. It never claims a listen.

export const AUTOMATED_RETAKE_EVIDENCE_SCHEMA = "goldflow_confirmed_tts_retry_evidence_v2";
export const AUTOMATED_RETAKE_EVIDENCE_WRITER_SCHEMA =
  "goldflow_automated_retake_evidence_writer_v1";
export const AUTOMATED_RETAKE_EVIDENCE_WRITER_VERSION =
  "automated_delivery_qa_retake_evidence_writer_v1";
export const AUTOMATED_RETAKE_EVIDENCE_BASIS = "reviewed_automated_delivery_qa";
export const AUTOMATED_RETAKE_AUTHORIZATION_ORIGIN = "user_authorized_autonomous_asr_qa";
export const AUTOMATED_RETAKE_AUTHORIZED_BY = "automated:delivery_qa_v1";
export const AUTOMATED_RETAKE_MAXIMUM_ATTEMPTS_PER_UNIT = 1;

const SHA256 = /^[a-f0-9]{64}$/u;

function canonicalize(value, omitted = new Set()) {
  if (Array.isArray(value)) return value.map((child) => canonicalize(child, omitted));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !omitted.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child, omitted)]),
  );
}

export function automatedRetakeEvidenceSha256(evidence) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(evidence, new Set(["evidence_sha256"]))))
    .digest("hex");
}

export class AutomatedRetakeEvidenceError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

export function automatedRetakeOperatorReason({ blockedUnitCount, totalUnitCount, blockerCodes }) {
  return `Automated delivery QA (reviewed_automated_delivery_qa, no human listening) blocked `
    + `${blockedUnitCount} of ${totalUnitCount} selected first-take units on `
    + `${blockerCodes.join(", ")}. Authorize exactly one exact-unit retake per blocked unit; `
    + "preserve every other selected WAV byte-for-byte; a unit still failing after its retake "
    + "stops the stage for structured triage. Approved spoken text is never rewritten.";
}

export function buildAutomatedRetakeEvidence({
  priorReport,
  priorReportSha256,
  priorReportPath,
  sourceScriptSha256,
  planSha256,
  planFileSha256,
  qualityContractSha256 = null,
  unitIds = null,
  authorizedAt = new Date().toISOString(),
} = {}) {
  if (priorReport?.schema !== "goldflow_narration_tts_report_v1" || priorReport.status !== "blocked") {
    throw new AutomatedRetakeEvidenceError(
      "automated_retake_requires_blocked_report",
      "Automated retake evidence requires an exact blocked narration report.",
    );
  }
  for (const [label, value] of [
    ["pre-retry report", priorReportSha256],
    ["source script", sourceScriptSha256],
    ["canonical plan", planSha256],
    ["plan file", planFileSha256],
  ]) {
    if (!SHA256.test(String(value ?? ""))) {
      throw new AutomatedRetakeEvidenceError(
        "automated_retake_binding_hash_invalid",
        `Automated retake evidence needs a SHA-256 for the ${label}.`,
      );
    }
  }
  if (priorReport.source_script_hash !== sourceScriptSha256
    || priorReport.narration_generation_plan_sha256 !== planSha256
    || priorReport.narration_generation_plan_file_sha256 !== planFileSha256) {
    throw new AutomatedRetakeEvidenceError(
      "automated_retake_report_not_current",
      "The blocked report is not bound to the current source script and narration plan.",
    );
  }
  if (!path.isAbsolute(String(priorReportPath ?? ""))) {
    throw new AutomatedRetakeEvidenceError(
      "automated_retake_report_path_invalid",
      "The pre-retry report path must be absolute.",
    );
  }
  const blockers = Array.isArray(priorReport.blockers) ? priorReport.blockers : [];
  const blockersByUnit = new Map();
  for (const finding of blockers) {
    const unitId = String(finding?.unit_id ?? "").trim();
    if (!unitId) continue;
    if (!blockersByUnit.has(unitId)) blockersByUnit.set(unitId, []);
    blockersByUnit.get(unitId).push(finding);
  }
  if (!blockersByUnit.size) {
    throw new AutomatedRetakeEvidenceError(
      "automated_retake_no_unit_blockers",
      "The blocked report carries no unit-scoped delivery blockers to retake.",
    );
  }
  const results = Array.isArray(priorReport.results) ? priorReport.results : [];
  const resultById = new Map(results.map((row) => [String(row?.unit_id ?? ""), row]));
  const orderedIds = results.map((row) => String(row.unit_id)).filter((id) => blockersByUnit.has(id));
  const requested = unitIds ? unitIds.map(String) : orderedIds;
  if (requested.length !== blockersByUnit.size
    || new Set(requested).size !== requested.length
    || requested.some((id) => !blockersByUnit.has(id))) {
    throw new AutomatedRetakeEvidenceError(
      "automated_retake_scope_mismatch",
      "Automated retake evidence must cover every blocked unit exactly once.",
      { requested, blocked: [...blockersByUnit.keys()] },
    );
  }
  const confirmedUnits = [];
  const capReached = [];
  for (const unitId of orderedIds) {
    const prior = resultById.get(unitId);
    const unitBlockers = blockersByUnit.get(unitId);
    if (!prior || !SHA256.test(String(prior.audio_sha256 ?? ""))
      || !SHA256.test(String(prior.synthesis_identity_sha256 ?? "")) || !prior.selected_qa) {
      throw new AutomatedRetakeEvidenceError(
        "automated_retake_result_binding_missing",
        `Blocked report lacks an exact selected audio/synthesis identity for ${unitId}.`,
      );
    }
    if (prior.qa_status === "passed") {
      throw new AutomatedRetakeEvidenceError(
        "automated_retake_unit_not_blocked",
        `Blocked report marks ${unitId} as passed; it cannot be retaken.`,
      );
    }
    if (Number(prior.attempt ?? 1) !== 1) {
      capReached.push({ unit_id: unitId, attempt: Number(prior.attempt) });
      continue;
    }
    confirmedUnits.push({
      unit_id: unitId,
      defect_type: "delivery",
      selected_attempt: 1,
      audio_sha256: prior.audio_sha256,
      synthesis_identity_sha256: prior.synthesis_identity_sha256,
      reviewed_blocker_codes: [...new Set(unitBlockers.map((finding) => String(finding.code)))].sort(),
      selected_qa_sha256: canonicalQwenBatchSha256(prior.selected_qa),
      evidence_note: `Reviewed exact automated delivery findings: ${JSON.stringify(unitBlockers)}. `
        + "No human listening claimed. Preserve the immutable first take and authorize one exact replacement.",
    });
  }
  if (capReached.length) {
    // The one-retake bound is hard: a second take that still fails is never
    // retaken again. The caller records a structured blocker instead.
    throw new AutomatedRetakeEvidenceError(
      "automated_retake_cap_reached",
      `${capReached.length} blocked unit(s) already consumed their one automated retake: `
      + capReached.map((row) => row.unit_id).join(", "),
      { units: capReached },
    );
  }
  const blockerCodes = [...new Set(blockers.map((finding) => String(finding.code)))].sort();
  const evidence = {
    schema: AUTOMATED_RETAKE_EVIDENCE_SCHEMA,
    evidence_basis: AUTOMATED_RETAKE_EVIDENCE_BASIS,
    human_listening_performed: false,
    user_listening_claimed: false,
    authorization_origin: AUTOMATED_RETAKE_AUTHORIZATION_ORIGIN,
    operator_reason: automatedRetakeOperatorReason({
      blockedUnitCount: confirmedUnits.length,
      totalUnitCount: results.length,
      blockerCodes,
    }),
    authorized_by: AUTOMATED_RETAKE_AUTHORIZED_BY,
    authorized_at: authorizedAt,
    maximum_attempts_per_unit: AUTOMATED_RETAKE_MAXIMUM_ATTEMPTS_PER_UNIT,
    source_script_sha256: sourceScriptSha256,
    narration_generation_plan_sha256: planSha256,
    narration_generation_plan_file_sha256: planFileSha256,
    narration_quality_contract_sha256: qualityContractSha256,
    pre_retry_narration_report_path: priorReportPath,
    pre_retry_narration_report_sha256: priorReportSha256,
    recovery_authorization: {
      evidence_basis: AUTOMATED_RETAKE_EVIDENCE_BASIS,
      authorization_origin: AUTOMATED_RETAKE_AUTHORIZATION_ORIGIN,
      human_listening_performed: false,
      user_listening_claimed: false,
      authorized_by: AUTOMATED_RETAKE_AUTHORIZED_BY,
      writer: {
        schema: AUTOMATED_RETAKE_EVIDENCE_WRITER_SCHEMA,
        version: AUTOMATED_RETAKE_EVIDENCE_WRITER_VERSION,
      },
    },
    confirmed_units: confirmedUnits,
  };
  evidence.evidence_sha256 = automatedRetakeEvidenceSha256(evidence);
  return evidence;
}

// Versioned, never overwriting: `narration_confirmed_retry_evidence_<ep>.json`,
// then `_r2`, `_r3`, … (the baseline episode already follows this convention).
export async function nextAutomatedRetakeEvidencePath(episodeDir, episode) {
  const base = path.join(episodeDir, `narration_confirmed_retry_evidence_${episode}`);
  for (let revision = 1; revision < 1000; revision += 1) {
    const candidate = revision === 1 ? `${base}.json` : `${base}_r${revision}.json`;
    const stat = await fs.stat(candidate).catch(() => null);
    if (!stat) return { path: candidate, revision };
  }
  throw new AutomatedRetakeEvidenceError(
    "automated_retake_evidence_revisions_exhausted",
    "Too many retry evidence revisions exist for this episode.",
  );
}

export async function writeAutomatedRetakeEvidence(episodeDir, episode, evidence) {
  const target = await nextAutomatedRetakeEvidencePath(episodeDir, episode);
  const bytes = `${JSON.stringify(evidence, null, 2)}\n`;
  await fs.writeFile(target.path, bytes, { flag: "wx" });
  return {
    path: target.path,
    revision: target.revision,
    file_sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

// Deterministic sentence-boundary fragments for the exact-boundary repair spec
// authored from the same QA rows (R05(2)). Fragments always rejoin to the exact
// spoken text; tail defects isolate the final sentence, opening defects the
// first, anything else splits at the boundary nearest the midpoint.
export function authoredBoundaryFragments(spokenText, blockerCodes = []) {
  const text = String(spokenText ?? "");
  const boundaries = [];
  const pattern = /[.!?…]["”’')\]]*\s(?=\S)/gu;
  for (const match of text.matchAll(pattern)) {
    const splitAt = match.index + match[0].length - 1;
    if (text[splitAt] === " " && text[splitAt - 1] !== " ") boundaries.push(splitAt);
  }
  if (!boundaries.length) return null;
  const codes = blockerCodes.map(String);
  const tail = codes.some((code) => /final|tail|trailing|contiguous_words_missing/u.test(code));
  const opening = !tail && codes.some((code) => /opening|head/u.test(code));
  let splitAt;
  if (tail) splitAt = boundaries.at(-1);
  else if (opening) splitAt = boundaries[0];
  else {
    const midpoint = text.length / 2;
    splitAt = boundaries.reduce((best, index) => (
      Math.abs(index - midpoint) < Math.abs(best - midpoint) ? index : best
    ), boundaries[0]);
  }
  const fragments = [text.slice(0, splitAt), text.slice(splitAt + 1)];
  if (fragments.join(" ") !== text || fragments.some((part) => !part.trim())) return null;
  return {
    fragments,
    policy: tail ? "isolate_final_sentence" : opening ? "isolate_first_sentence" : "split_nearest_midpoint_sentence_boundary",
  };
}
