#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NARRATION_TTS_SELECTION_POLICY_VERSION,
  PRIMARY_TTS_PROVIDER,
  QWEN_LIAM_MINIMUM_COSINE_SIMILARITY,
  QWEN_LIAM_WARNING_BELOW_COSINE_SIMILARITY,
  candidateDisposition,
  confirmableDeliveryFindingCodes,
  deterministicTtsSeed,
  fullStreamDecision,
  isAutomaticConfirmedRetryCode,
  softenPrimaryQa,
  validateSelectedUnitOrder,
  voiceContinuityDecision,
} from "./lib/tts-selection-policy.mjs";
import {
  NARRATION_TTS_QA_POLICY_VERSION,
  QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
  QWEN_LIAM_UNIT_CONTRACT,
  QWEN_JOEL_PRIMARY_LOCK,
  qwenPrimaryLockForVoice,
  QWEN_LIAM_PRIMARY_LOCK,
  narrationPlanRunIdentityBindingFinding,
  narrationPlanVoiceIdentityFindings,
  narrationTtsRetryReportPolicy,
  narrationTtsPolicyForIdentity,
  validateNarrationTtsPolicy,
} from "./lib/narration-tts-policy.mjs";
import {
  QWEN_LIAM_EXACT_UNIT_RECOVERY_MODE,
  QWEN_LIAM_INCOMPLETE_UNIT_RESUME_MODE,
  buildQwenLiamBatchPlan,
  canonicalQwenBatchSha256,
  qwenBatchBindingByUnit,
  validateQwenLiamBatchPlan,
} from "./lib/qwen-liam-batch-contract.mjs";
import { hasTtsTerminalPunctuation } from "./lib/tts-text-boundaries.mjs";
import {
  validateNarrationPerformanceBakeoffApproval,
} from "./lib/narration-performance-contract.mjs";
import {
  narrationQualityContractForIdentity,
} from "./lib/narration-quality-contract.mjs";
import {
  adjudicateNarrationDeliveryConsensus,
  exactNarrationListenReviewPacket,
  exactNarrationRepairPacket,
  narrationDeliveryNeedsConfirmation,
  strictNarrationDeliveryDecision,
} from "./lib/narration-delivery-quality.mjs";
import {
  validateNarrationStitchAccounting,
} from "./lib/narration-boundary-editor.mjs";
import {
  buildNarrationProviderOutputManifest,
} from "./lib/narration-provider-adapter.mjs";
import {
  authorizeNarrationPreSynthesisGate,
  buildNarrationPreSynthesisBootstrapGate,
  buildNarrationPreSynthesisGate,
  narrationPreSynthesisGateSha256,
} from "./lib/narration-pre-synthesis-gate.mjs";

const DATA_ROOT = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const DEFAULT_PYTHON = "/Users/joel/AniFactoryData/voice_bank/bakeoff/.venv-kokoro-mlx-audio-0.4.6/bin/python";
const DEFAULT_SIMILARITY_PYTHON = "/Users/joel/AniFactoryData/voice_bank/bakeoff/.venv-speaker-similarity/bin/python";
function qwenPinForVoiceId(voiceId, referenceVariantId = null) {
  const voiceLock = qwenPrimaryLockForVoice(voiceId, referenceVariantId);
  return Object.freeze({
    ...voiceLock,
    model_source: voiceLock.model_id,
    model_weights_sha256: "b965c581ccf6aa852a4124feeb7a8a111542ee7b213139368b4cc7ba7fd4728b",
    speech_tokenizer_weights_sha256: "836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258",
    runtime: "mlx-audio",
    runtime_version: "0.4.6",
  });
}
const QA_POLICY_VERSION = NARRATION_TTS_QA_POLICY_VERSION;
const STITCH_POLICY_VERSION = "narration_tts_stitch_v1";
const STITCH_POLICY_VERSION_V2 = "narration_alignment_safe_semantic_stitch_v2";
const SAMPLE_RATE = 24000;
const UNIT_GAP_SEC = 0.08;
const SEGMENT_GAP_SEC = 0.08;
const FADE_SEC = 0.008;
const EDGE_PAD_SEC = 0.05;
const EFFECTIVE_CONCURRENCY = 1;

function parseFlags(parts) {
  const output = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--")
      ? parts[index + 1]
      : "true";
    output[key] = value;
    if (value !== "true") index += 1;
  }
  return output;
}

function boolFlag(value) {
  return /^(?:1|true|yes|on)$/i.test(String(value ?? ""));
}

export function recoveryScopeForTests(rawUnitIds, units) {
  if (rawUnitIds == null || String(rawUnitIds).trim() === "") return null;
  const requestedUnitIds = String(rawUnitIds)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!requestedUnitIds.length) {
    throw new Error("--confirmed-retry-unit-ids requires at least one unit ID");
  }
  const duplicateUnitIds = requestedUnitIds.filter(
    (unitId, index) => requestedUnitIds.indexOf(unitId) !== index,
  );
  if (duplicateUnitIds.length) {
    throw new Error(
      `--confirmed-retry-unit-ids contains duplicate unit IDs: ${[...new Set(duplicateUnitIds)].join(", ")}`,
    );
  }
  const availableUnitIds = new Set(units.map((unit) => String(unit.unit_id)));
  const unknownUnitIds = requestedUnitIds.filter((unitId) => !availableUnitIds.has(unitId));
  if (unknownUnitIds.length) {
    throw new Error(
      `--confirmed-retry-unit-ids contains IDs absent from the current narration plan: ${unknownUnitIds.join(", ")}`,
    );
  }
  const requestedSet = new Set(requestedUnitIds);
  return {
    mode: "confirmed_exact_unit_retry",
    requested_unit_ids: units
      .map((unit) => String(unit.unit_id))
      .filter((unitId) => requestedSet.has(unitId)),
    requested_unit_count: requestedUnitIds.length,
  };
}

export function preservedTtsSelectionsForTests({
  units = [],
  priorReport = null,
  priorUnitQa = null,
  policy = null,
  canonicalPlanSha256 = null,
  planFileSha256 = null,
  requestedUnitIds = [],
  requireAllUnrequested = false,
} = {}) {
  const findings = [];
  const requested = new Set(requestedUnitIds.map(String));
  const resultRows = priorReport?.results ?? [];
  const selectedRows = priorUnitQa?.selected_units ?? [];
  const reportResults = new Map(
    resultRows.map((row) => [String(row?.unit_id ?? ""), row]),
  );
  const selectedQaRows = new Map(
    selectedRows.map((row) => [String(row?.unit_id ?? ""), row]),
  );
  const currentUnitIds = new Set(units.map((unit) => String(unit?.unit_id ?? "")));
  if (reportResults.size !== resultRows.length) {
    findings.push({ code: "preserved_tts_prior_report_duplicate_unit" });
  }
  if (selectedQaRows.size !== selectedRows.length) {
    findings.push({ code: "preserved_tts_prior_unit_qa_duplicate_unit" });
  }
  if (resultRows.some((row) => !currentUnitIds.has(String(row?.unit_id ?? "")))) {
    findings.push({ code: "preserved_tts_prior_report_unknown_unit" });
  }
  if (selectedRows.some((row) => !currentUnitIds.has(String(row?.unit_id ?? "")))) {
    findings.push({ code: "preserved_tts_prior_unit_qa_unknown_unit" });
  }
  const expectedPlanHash = canonicalPlanSha256 ?? planFileSha256;
  if (!priorReport
    || priorReport.narration_generation_plan_sha256 !== expectedPlanHash
    || (canonicalPlanSha256
      && priorReport.narration_generation_plan_file_sha256 !== planFileSha256)) {
    findings.push({ code: "preserved_tts_prior_report_plan_binding_stale" });
  }
  if (!priorUnitQa
    || priorUnitQa.narration_generation_plan_sha256 !== expectedPlanHash
    || (canonicalPlanSha256
      && priorUnitQa.narration_generation_plan_file_sha256 !== planFileSha256)) {
    findings.push({ code: "preserved_tts_prior_unit_qa_plan_binding_stale" });
  }
  const rows = [];
  for (const unit of units) {
    const unitId = String(unit?.unit_id ?? "");
    if (requested.has(unitId)) continue;
    const result = reportResults.get(unitId);
    const selectedQa = selectedQaRows.get(unitId);
    if (!result && !selectedQa) {
      if (requireAllUnrequested) {
        findings.push({
          code: "preserved_tts_selection_missing_or_stale",
          unit_id: unitId,
        });
      }
      continue;
    }
    const qa = selectedQa?.qa ?? result?.selected_qa ?? null;
    const accepted = candidateDisposition(qa, PRIMARY_TTS_PROVIDER).accepted;
    if (!result
      || !selectedQa
      || !accepted
      || !result.audio_path
      || !result.audio_sha256
      || result.audio_path !== selectedQa.audio_path
      || result.audio_sha256 !== selectedQa.audio_sha256
      || result.synthesis_identity_sha256
        !== selectedQa.synthesis_identity_sha256
      || result.spoken_text_sha256 !== unit.spoken_text_sha256
      || selectedQa.spoken_text_sha256 !== unit.spoken_text_sha256
      || result.provider !== policy?.primary?.provider
      || result.model_id !== policy?.primary?.model_id
      || result.voice_id !== policy?.primary?.voice_id
      || (result.voice_sha256 ?? policy?.primary?.voice_sha256)
        !== policy?.primary?.voice_sha256
      || (result.voice_continuity_contract
        ?? policy?.primary?.voice_continuity_contract)
        !== policy?.primary?.voice_continuity_contract
      || selectedQa.provider !== policy?.primary?.provider
      || selectedQa.model_id !== policy?.primary?.model_id
      || selectedQa.voice_id !== policy?.primary?.voice_id
      || selectedQa.voice_sha256 !== policy?.primary?.voice_sha256
      || selectedQa.voice_continuity_contract
        !== policy?.primary?.voice_continuity_contract
      || !result.synthesis_identity_sha256) {
      findings.push({
        code: "preserved_tts_selection_missing_or_stale",
        unit_id: unitId,
      });
      continue;
    }
    rows.push({
      unit,
      result,
      selected_qa: selectedQa,
      qa,
    });
  }
  return {
    status: findings.length ? "blocked" : "passed",
    findings,
    rows,
    preserved_unit_ids: rows.map((row) => String(row.unit.unit_id)),
  };
}

export function narrationSynthesisScopeForTests({
  units = [],
  preservedCandidates = [],
  requestedRecoveryScope = null,
  manualReviewEvidencePath = null,
  evidencePath = null,
  evidenceSha256 = null,
} = {}) {
  const requestedIds = new Set(
    requestedRecoveryScope?.requested_unit_ids?.map(String) ?? [],
  );
  const preserved = preservedCandidates.filter(
    (candidate) => !requestedIds.has(String(candidate.unit_id)),
  );
  const preservedArtifacts = preserved.map((candidate) => ({
    unit_id: String(candidate.unit_id),
    spoken_text_sha256: candidate.spoken_text_sha256,
    audio_path: candidate.audio_path,
    audio_sha256: candidate.audio_sha256,
    synthesis_sidecar_path:
      candidate.preservation_provenance?.synthesis_sidecar_path,
    synthesis_sidecar_sha256:
      candidate.preservation_provenance?.synthesis_sidecar_sha256,
    synthesis_identity_sha256: candidate.synthesis_identity_sha256,
    selected_report_synthesis_identity_sha256:
      candidate.selected_report_synthesis_identity_sha256,
    attempt: candidate.attempt,
    seed: candidate.seed,
    synthesis_mode: candidate.synthesis_mode,
    batch_plan_sha256: candidate.batch_plan_sha256,
    cohort_id: candidate.cohort_id,
    cohort_sha256: candidate.cohort_sha256,
  }));
  const common = {
    preserved_unit_ids: preserved.map((candidate) => String(candidate.unit_id)),
    preserved_artifacts: preservedArtifacts,
  };
  if (requestedRecoveryScope) {
    return {
      ...common,
      mode: "confirmed_exact_unit_retry",
      authorized_synthesis_unit_ids:
        requestedRecoveryScope.requested_unit_ids.map(String),
      evidence_path: evidencePath,
      evidence_sha256: evidenceSha256,
    };
  }
  if (manualReviewEvidencePath) {
    return {
      ...common,
      mode: "hash_bound_manual_accept_first_take",
      authorized_synthesis_unit_ids: [],
      evidence_path: manualReviewEvidencePath,
      evidence_sha256: evidenceSha256,
    };
  }
  if (preserved.length === units.length && units.length > 0) {
    return {
      ...common,
      mode: "already_complete_no_synthesis_authorized",
      authorized_synthesis_unit_ids: [],
    };
  }
  return {
    ...common,
    mode: preserved.length
      ? "interrupted_full_synthesis_resume_preserving_accepted_units"
      : "initial_full_synthesis",
    authorized_synthesis_unit_ids: units
      .map((unit) => String(unit.unit_id))
      .filter((unitId) => !common.preserved_unit_ids.includes(unitId)),
  };
}

function preservedSelectionRow(unit, candidate, unitQa, policy) {
  return {
    ...unit,
    text: unit.spoken_text,
    segment_id: unit.segment_id
      ?? unit.source_segment_ids?.[0]
      ?? unit.inherited_segment_id
      ?? unit.unit_id,
    speaker: unit.speaker ?? "NARRATOR",
    voice_id: policy.primary.voice_id,
    voice_sha256: policy.primary.voice_sha256,
    voice_continuity_contract: policy.primary.voice_continuity_contract,
    provider: candidate.provider,
    model_id: candidate.model_id,
    attempt: candidate.attempt,
    wav: candidate.audio_path,
    duration_sec: candidate.duration_sec,
    synthesis_mode: candidate.synthesis_mode ?? null,
    batch_plan_sha256: candidate.batch_plan_sha256 ?? null,
    cohort_id: candidate.cohort_id ?? null,
    cohort_sha256: candidate.cohort_sha256 ?? null,
    generated_token_count: candidate.generated_token_count ?? null,
    effective_token_limit: candidate.effective_token_limit ?? null,
    token_limit_reached: candidate.token_limit_reached ?? null,
    recovery_provenance: candidate.recovery_provenance ?? null,
    synthesis_identity: candidate.synthesis_identity ?? null,
    synthesis_identity_sha256: candidate.synthesis_identity_sha256,
    unit_qa: unitQa,
  };
}

export function preservedTtsFinalInputsForTests({
  units = [],
  candidatePool = [],
  preservedForInvocation = [],
  priorSynthesisRuns = [],
  policy,
} = {}) {
  const candidateKeys = new Set();
  const candidates = candidatePool.filter((candidate) => {
    const key = `${candidate?.unit_id ?? ""}:${candidate?.attempt ?? ""}:${candidate?.audio_sha256 ?? ""}`;
    if (candidateKeys.has(key)) return false;
    candidateKeys.add(key);
    return true;
  });
  const runKeys = new Set();
  const synthesisRuns = (candidatePool.length ? priorSynthesisRuns : []).filter((runRow) => {
    const key = String(
      runRow?.report_sha256
        ?? `${runRow?.attempt ?? ""}:${runRow?.report_path ?? ""}:${runRow?.jobs_sha256 ?? ""}`,
    );
    if (runKeys.has(key)) return false;
    runKeys.add(key);
    return true;
  });
  const unitById = new Map(
    units.map((unit) => [String(unit.unit_id), unit]),
  );
  const selectedRows = preservedForInvocation.flatMap((candidate) => {
    const unit = unitById.get(String(candidate.unit_id));
    return unit
      ? [preservedSelectionRow(unit, candidate, candidate.qa, policy)]
      : [];
  });
  return { candidates, synthesisRuns, selectedRows };
}

export function incompleteUnitResumeProvenanceForTests({
  unit,
  cohortBinding,
  batchPlanSha256,
  preSynthesisGateSha256,
} = {}) {
  if (!unit?.unit_id
    || !unit?.spoken_text_sha256
    || !cohortBinding?.cohort_sha256
    || cohortBinding.batch_plan_sha256 !== batchPlanSha256
    || !preSynthesisGateSha256) {
    throw new Error("Incomplete-unit resume lacks a current unit, cohort, or gate binding.");
  }
  return {
    schema: "goldflow_qwen_incomplete_unit_resume_provenance_v1",
    resume_mode: QWEN_LIAM_INCOMPLETE_UNIT_RESUME_MODE,
    reason: "unit_has_no_hash_verified_accepted_selection_after_interrupted_invocation",
    unit_id: String(unit.unit_id),
    spoken_text_sha256: unit.spoken_text_sha256,
    batch_plan_sha256: batchPlanSha256,
    origin_cohort_id: cohortBinding.cohort_id,
    origin_cohort_sha256: cohortBinding.cohort_sha256,
    pre_synthesis_gate_sha256: preSynthesisGateSha256,
  };
}

export function exactUnitRecoveryProvenanceForTests({
  unit,
  candidate,
  cohortBinding,
  batchPlanSha256,
  confirmedDefect = null,
  confirmedEvidencePath = null,
  confirmedEvidenceSha256 = null,
} = {}) {
  if (!unit?.unit_id || !candidate?.synthesis_identity_sha256) {
    throw new Error(
      "Exact-unit recovery requires the original unit and batch synthesis identity.",
    );
  }
  if (!cohortBinding?.cohort_sha256
    || cohortBinding.batch_plan_sha256 !== batchPlanSha256) {
    throw new Error(
      `Exact-unit recovery lacks the original batch cohort for ${unit.unit_id}.`,
    );
  }
  const automaticCodes = [...new Set(
    candidate.disposition?.blocker_codes
      ?? candidate.qa?.findings
        ?.filter((finding) => finding.severity === "blocker")
        .map((finding) => finding.code)
      ?? [],
  )].map(String).sort();
  const triggerCodes = confirmedDefect
    ? [`operator_confirmed_${String(confirmedDefect).toLowerCase()}`]
    : automaticCodes;
  if (!triggerCodes.length) {
    throw new Error(
      `Exact-unit recovery has no objective or operator-confirmed trigger for ${unit.unit_id}.`,
    );
  }
  const triggerEvidence = {
    unit_id: String(unit.unit_id),
    spoken_text_sha256: unit.spoken_text_sha256,
    origin_audio_sha256: candidate.audio_sha256 ?? null,
    origin_synthesis_identity_sha256:
      candidate.synthesis_identity_sha256,
    origin_runner_report_sha256: candidate.runner_report_sha256 ?? null,
    trigger_codes: triggerCodes,
    candidate_qa: candidate.qa ?? null,
    confirmed_evidence_sha256: confirmedEvidenceSha256,
  };
  return {
    schema: "goldflow_qwen_exact_unit_recovery_provenance_v1",
    recovery_mode: QWEN_LIAM_EXACT_UNIT_RECOVERY_MODE,
    unit_id: String(unit.unit_id),
    spoken_text_sha256: unit.spoken_text_sha256,
    batch_plan_sha256: batchPlanSha256,
    origin_cohort_id: cohortBinding.cohort_id,
    origin_cohort_sha256: cohortBinding.cohort_sha256,
    origin_synthesis_identity_sha256:
      candidate.synthesis_identity_sha256,
    origin_audio_sha256: candidate.audio_sha256 ?? null,
    origin_runner_report_path: candidate.runner_report_path ?? null,
    origin_runner_report_sha256: candidate.runner_report_sha256 ?? null,
    trigger_codes: triggerCodes,
    trigger_evidence_sha256: canonicalQwenBatchSha256(triggerEvidence),
    confirmed_evidence_path: confirmedEvidencePath,
    confirmed_evidence_sha256: confirmedEvidenceSha256,
  };
}

export function validateConfirmedRetryEvidenceForTests({
  evidence,
  requestedUnitIds,
  planSha256,
  priorReport,
  priorReportSha256,
  currentCandidates,
} = {}) {
  if (!evidence || typeof evidence !== "object") {
    throw new Error("Confirmed retry evidence must be a JSON object.");
  }
  if (evidence.narration_generation_plan_sha256 !== planSha256) {
    throw new Error(
      "Confirmed retry evidence is not bound to the current narration generation plan hash.",
    );
  }
  if (!priorReport || typeof priorReport !== "object" || !priorReportSha256) {
    throw new Error(
      "Confirmed retry requires an exact pre-retry narration report and selected audio artifact.",
    );
  }
  if (evidence.pre_retry_narration_report_sha256 !== priorReportSha256) {
    throw new Error(
      "Confirmed retry evidence is not bound to the exact pre-retry narration report hash.",
    );
  }
  const allowedDefects = new Set(["skip", "truncation", "stutter"]);
  const evidenceRows = Array.isArray(evidence.confirmed_units)
    ? evidence.confirmed_units
    : [];
  const requested = [...new Set((requestedUnitIds ?? []).map(String))];
  const evidenceById = new Map(
    evidenceRows.map((row) => [String(row?.unit_id ?? ""), row]),
  );
  const priorById = new Map(
    (priorReport.results ?? []).map((row) => [String(row?.unit_id ?? ""), row]),
  );
  const currentById = new Map(
    (currentCandidates ?? [])
      .filter((row) => Number(row?.attempt) === 1 && row?.audio_sha256)
      .map((row) => [String(row.unit_id), row]),
  );
  const validated = [];
  for (const unitId of requested) {
    const row = evidenceById.get(unitId);
    if (!row) {
      throw new Error(`Confirmed retry evidence does not cover requested unit: ${unitId}`);
    }
    if (!allowedDefects.has(String(row.defect_type ?? "").toLowerCase())
      || !String(row.listen_note ?? "").trim()) {
      throw new Error(
        `Confirmed retry evidence for ${unitId} must record defect_type `
        + "(skip, truncation, or stutter) and a non-empty listen_note.",
      );
    }
    const prior = priorById.get(unitId);
    if (!prior?.audio_sha256 || !prior?.synthesis_identity_sha256) {
      throw new Error(
        `Pre-retry narration report lacks an exact selected audio/synthesis identity for ${unitId}.`,
      );
    }
    const current = currentById.get(unitId);
    const currentSelectedIdentitySha256 = current
      ?.selected_report_synthesis_identity_sha256
      ?? current?.synthesis_identity_sha256;
    const expectedAttempt = Number(prior.attempt);
    if (!Number.isInteger(expectedAttempt)
      || Number(row.selected_attempt) !== expectedAttempt
      || row.audio_sha256 !== prior.audio_sha256
      || row.synthesis_identity_sha256 !== prior.synthesis_identity_sha256) {
      throw new Error(
        `Confirmed retry evidence is stale for the selected pre-retry artifact of ${unitId}.`,
      );
    }
    if (!current
      || current.audio_sha256 !== prior.audio_sha256
      || currentSelectedIdentitySha256 !== prior.synthesis_identity_sha256) {
      throw new Error(
        `Current cached attempt-one artifact does not match the listened pre-retry artifact for ${unitId}.`,
      );
    }
    validated.push({
      unit_id: unitId,
      defect_type: String(row.defect_type).toLowerCase(),
      selected_attempt: expectedAttempt,
      audio_sha256: prior.audio_sha256,
      synthesis_identity_sha256: prior.synthesis_identity_sha256,
    });
  }
  return validated;
}

function normalizedCodeList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean))]
    .sort();
}

function exactStringLists(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function validateManualReviewEvidenceForTests({
  evidence,
  planSha256,
  preReviewNarrationReport,
  preReviewNarrationReportSha256,
  preReviewUnitQa,
  preReviewUnitQaSha256,
} = {}) {
  if (!evidence || typeof evidence !== "object") {
    throw new Error("Manual TTS review evidence must be a JSON object.");
  }
  if (evidence.schema !== "goldflow_narration_tts_manual_review_v1"
    || evidence.status !== "approved") {
    throw new Error(
      "Manual TTS review evidence requires schema "
      + "goldflow_narration_tts_manual_review_v1 and status approved.",
    );
  }
  if (!String(evidence.reviewer ?? "").trim()
    || !String(evidence.note ?? "").trim()
    || !String(evidence.reviewed_at ?? "").trim()) {
    throw new Error(
      "Manual TTS review evidence requires reviewer, note, and reviewed_at.",
    );
  }
  if (evidence.narration_generation_plan_sha256 !== planSha256) {
    throw new Error(
      "Manual TTS review evidence is not bound to the current narration plan hash.",
    );
  }
  if (!preReviewNarrationReport
    || preReviewNarrationReport.status !== "blocked"
    || preReviewNarrationReport.narration_generation_plan_sha256 !== planSha256
    || evidence.pre_review_narration_report_sha256
      !== preReviewNarrationReportSha256) {
    throw new Error(
      "Manual TTS review evidence is not bound to the exact blocked pre-review narration report.",
    );
  }
  if (!preReviewUnitQa
    || preReviewUnitQa.status !== "blocked"
    || preReviewUnitQa.narration_generation_plan_sha256 !== planSha256
    || evidence.pre_review_unit_qa_sha256 !== preReviewUnitQaSha256) {
    throw new Error(
      "Manual TTS review evidence is not bound to the exact blocked pre-review unit-QA report.",
    );
  }
  const acceptedUnits = Array.isArray(evidence.accepted_units)
    ? evidence.accepted_units
    : [];
  if (!acceptedUnits.length) {
    throw new Error(
      "Manual TTS review evidence requires at least one accepted first-take unit.",
    );
  }
  if (evidence.accepted_unit_count != null
    && Number(evidence.accepted_unit_count) !== acceptedUnits.length) {
    throw new Error(
      "Manual TTS review accepted_unit_count does not match accepted_units.",
    );
  }
  const duplicateIds = acceptedUnits
    .map((row) => String(row?.unit_id ?? ""))
    .filter((unitId, index, rows) => rows.indexOf(unitId) !== index);
  if (duplicateIds.length) {
    throw new Error(
      `Manual TTS review evidence contains duplicate unit IDs: ${[
        ...new Set(duplicateIds),
      ].join(", ")}`,
    );
  }
  const candidates = Array.isArray(preReviewUnitQa.candidates)
    ? preReviewUnitQa.candidates
    : [];
  const previouslySelectedIds = new Set(
    (preReviewUnitQa.selected_units ?? []).map((row) => String(row?.unit_id ?? "")),
  );
  return {
    reviewer: String(evidence.reviewer).trim(),
    note: String(evidence.note).trim(),
    reviewed_at: String(evidence.reviewed_at).trim(),
    accepted_units: acceptedUnits.map((row) => {
      const unitId = String(row?.unit_id ?? "").trim();
      if (!unitId) throw new Error("Manual TTS review evidence has a missing unit_id.");
      if (row.decision !== "accept_first_take"
        || Number(row.attempt) !== 1
        || row.provider !== PRIMARY_TTS_PROVIDER) {
        throw new Error(
          `Manual TTS review for ${unitId} must be an accept_first_take `
          + `decision for ${PRIMARY_TTS_PROVIDER} attempt 1.`,
        );
      }
      if (!String(row.listen_note ?? "").trim()) {
        throw new Error(`Manual TTS review for ${unitId} requires a listen_note.`);
      }
      const audibleReview = row.audible_review ?? {};
      for (const field of [
        "speech_complete",
        "no_skip",
        "no_truncation",
        "no_stutter",
        "voice_identity_acceptable",
        "endpoint_acceptable",
      ]) {
        if (audibleReview[field] !== true) {
          throw new Error(
            `Manual TTS review for ${unitId} must explicitly confirm audible_review.${field}=true.`,
          );
        }
      }
      if (previouslySelectedIds.has(unitId)) {
        throw new Error(
          `Manual TTS review may accept only unresolved blocked_manual_review candidates; ${unitId} was already selected.`,
        );
      }
      const matches = candidates.filter((candidate) => (
        String(candidate?.unit_id ?? "") === unitId
        && Number(candidate?.attempt) === 1
        && candidate?.provider === PRIMARY_TTS_PROVIDER
        && candidate?.audio_sha256 === row.audio_sha256
        && candidate?.synthesis_identity_sha256 === row.synthesis_identity_sha256
      ));
      if (matches.length !== 1) {
        throw new Error(
          `Manual TTS review for ${unitId} does not resolve to exactly one current first-take candidate.`,
        );
      }
      const candidate = matches[0];
      if (candidate.disposition?.status !== "blocked_manual_review"
        || candidate.disposition?.accepted !== false
        || candidate.qa?.status !== "blocked"
        || !candidate.audio_path
        || !candidate.audio_sha256
        || !candidate.synthesis_identity_sha256
        || !(Number(candidate.duration_sec) > 0)) {
        throw new Error(
          `Manual TTS review for ${unitId} may accept only a complete blocked_manual_review audio candidate.`,
        );
      }
      if (row.audio_path != null && row.audio_path !== candidate.audio_path) {
        throw new Error(
          `Manual TTS review for ${unitId} is bound to a stale audio path.`,
        );
      }
      const actualBlockerCodes = normalizedCodeList(
        (candidate.qa?.findings ?? [])
          .filter((finding) => finding?.severity === "blocker")
          .map((finding) => finding?.code),
      );
      const dispositionBlockerCodes = normalizedCodeList(
        candidate.disposition?.blocker_codes,
      );
      const reviewedBlockerCodes = normalizedCodeList(row.reviewed_blocker_codes);
      if (!actualBlockerCodes.length
        || !exactStringLists(actualBlockerCodes, dispositionBlockerCodes)
        || !exactStringLists(actualBlockerCodes, reviewedBlockerCodes)) {
        throw new Error(
          `Manual TTS review for ${unitId} must enumerate the exact current blocker codes.`,
        );
      }
      const forbiddenCodes = actualBlockerCodes.filter(
        (code) => isAutomaticConfirmedRetryCode(code),
      );
      if (forbiddenCodes.length) {
        throw new Error(
          `Manual TTS review cannot waive a structural missing, unreadable, empty, corrupt, token-limited, or failed synthesis result for ${unitId}: ${forbiddenCodes.join(", ")}`,
        );
      }
      return {
        unit_id: unitId,
        candidate,
        decision: row.decision,
        listen_note: String(row.listen_note).trim(),
        reviewed_blocker_codes: reviewedBlockerCodes,
        audible_review: {
          speech_complete: true,
          no_skip: true,
          no_truncation: true,
          no_stutter: true,
          voice_identity_acceptable: true,
          endpoint_acceptable: true,
        },
      };
    }),
  };
}

export function validateManualStitchRecoveryForTests({
  manualReviewEvidencePath,
  repairTailUnitIds = [],
  skipRenderedTranscriptQa = false,
  workflowBypass = false,
  validatedReview,
} = {}) {
  const repairIds = repairTailUnitIds.map(String).filter(Boolean);
  if ((repairIds.length || skipRenderedTranscriptQa) && !manualReviewEvidencePath) {
    throw new Error(
      "--stitch-repair-tail-unit-ids and --skip-rendered-transcript-qa "
      + "are allowed only with --manual-review-evidence.",
    );
  }
  if (new Set(repairIds).size !== repairIds.length) {
    throw new Error("--stitch-repair-tail-unit-ids contains duplicate unit IDs.");
  }
  if ((repairIds.length || skipRenderedTranscriptQa) && workflowBypass !== true) {
    throw new Error(
      "--stitch-repair-tail-unit-ids and --skip-rendered-transcript-qa "
      + "require explicit --workflow-bypass true.",
    );
  }
  if (skipRenderedTranscriptQa && !repairIds.length) {
    throw new Error(
      "--skip-rendered-transcript-qa true requires at least one "
      + "--stitch-repair-tail-unit-ids value.",
    );
  }
  if (validatedReview) {
    const reviewedById = new Map(
      (validatedReview.accepted_units ?? []).map((row) => [String(row.unit_id), row]),
    );
    for (const unitId of repairIds) {
      const reviewed = reviewedById.get(unitId);
      if (!reviewed
        || !reviewed.reviewed_blocker_codes.includes("tts_audio_tail_not_settled")) {
        throw new Error(
          `Tail repair unit ${unitId} is not an exact manually accepted `
          + "tts_audio_tail_not_settled first take.",
        );
      }
    }
  }
  return {
    repair_tail_unit_ids: repairIds,
    skip_rendered_transcript_qa: Boolean(skipRenderedTranscriptQa),
  };
}

export function adjudicateManualReviewQaForTests(qa, {
  reviewer,
  reviewedAt,
  listenNote,
  reviewedBlockerCodes,
  evidencePath = null,
  evidenceSha256 = null,
  preReviewNarrationReportPath = null,
  preReviewNarrationReportSha256 = null,
  preReviewUnitQaPath = null,
  preReviewUnitQaSha256 = null,
} = {}) {
  const reviewedCodes = new Set(normalizedCodeList(reviewedBlockerCodes));
  const findings = (qa?.findings ?? []).map((finding) => (
    finding?.severity === "blocker" && reviewedCodes.has(String(finding.code ?? ""))
      ? {
          ...finding,
          severity: "warning",
          original_severity: "blocker",
          disposition_policy: "hash_bound_manual_accept_first_take",
          reviewed_by: reviewer,
          reviewed_at: reviewedAt,
          listen_note: listenNote,
        }
      : finding
  ));
  const remainingBlockers = findings.filter((finding) => finding?.severity === "blocker");
  if (remainingBlockers.length) {
    throw new Error(
      `Manual TTS adjudication left unreviewed blockers: ${remainingBlockers
        .map((finding) => finding.code)
        .join(", ")}`,
    );
  }
  return {
    ...qa,
    status: findings.length ? "passed_with_warnings" : "passed",
    findings,
    delivery_first_gate: qa?.delivery_first_gate
      ? {
          ...qa.delivery_first_gate,
          hard_blocker_codes: [],
          manually_reviewed_blocker_codes: [...reviewedCodes].sort(),
        }
      : qa?.delivery_first_gate,
    manual_review_disposition: {
      schema: "goldflow_narration_tts_manual_review_disposition_v1",
      decision: "accept_first_take",
      reviewer,
      reviewed_at: reviewedAt,
      listen_note: listenNote,
      reviewed_blocker_codes: [...reviewedCodes].sort(),
      evidence_path: evidencePath,
      evidence_sha256: evidenceSha256,
      pre_review_narration_report_path: preReviewNarrationReportPath,
      pre_review_narration_report_sha256: preReviewNarrationReportSha256,
      pre_review_unit_qa_path: preReviewUnitQaPath,
      pre_review_unit_qa_sha256: preReviewUnitQaSha256,
      original_qa_status: qa?.status ?? null,
    },
  };
}

function sha256Text(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

async function sha256File(filePath) {
  const digest = createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return digest.digest("hex");
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function filesBelow(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const rows = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) rows.push(...await filesBelow(entryPath));
    else if (entry.isFile()) rows.push(entryPath);
  }
  return rows;
}

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`,
  );
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function hydratePreservedTtsSelections({
  selectionValidation,
  policy,
  batchPlan,
} = {}) {
  if (selectionValidation?.status !== "passed") {
    throw new Error(
      `Passed TTS work cannot be preserved: ${JSON.stringify(selectionValidation?.findings ?? [])}`,
    );
  }
  const bindingByUnit = qwenBatchBindingByUnit(batchPlan);
  const candidates = [];
  for (const row of selectionValidation.rows ?? []) {
    const unit = row.unit;
    const result = row.result;
    const unitId = String(unit.unit_id);
    const audioPath = path.resolve(result.audio_path);
    const actualAudioSha256 = await sha256File(audioPath).catch(() => null);
    if (!actualAudioSha256 || actualAudioSha256 !== result.audio_sha256) {
      throw new Error(`Passed TTS audio is missing or stale for ${unitId}: ${audioPath}`);
    }
    const sidecarPath = audioPath.replace(/\.wav$/iu, ".json");
    const sidecar = await readJson(sidecarPath, null);
    const sidecarFileSha256 = await sha256File(sidecarPath).catch(() => null);
    const synthesisIdentity = sidecar?.synthesis_identity;
    const synthesisIdentitySha256 = sidecar?.synthesis_identity_sha256;
    const expectedBinding = bindingByUnit.get(unitId);
    if (!sidecar
      || !sidecarFileSha256
      || sidecar.unit_id !== unitId
      || sidecar.output_sha256 !== result.audio_sha256
      || sidecar.spoken_text_sha256 !== unit.spoken_text_sha256
      || synthesisIdentitySha256 !== canonicalQwenBatchSha256(synthesisIdentity)
      || synthesisIdentity?.provider !== policy.primary.provider
      || synthesisIdentity?.model_id !== policy.primary.model_id
      || synthesisIdentity?.model_revision !== policy.primary.model_revision
      || synthesisIdentity?.voice !== policy.primary.voice_id
      || synthesisIdentity?.voice_sha256 !== policy.primary.voice_sha256
      || synthesisIdentity?.voice_continuity_contract
        !== policy.primary.voice_continuity_contract
      || synthesisIdentity?.batch_plan_sha256 !== batchPlan.batch_plan_sha256
      || synthesisIdentity?.cohort_id !== expectedBinding?.cohort_id
      || synthesisIdentity?.cohort_sha256 !== expectedBinding?.cohort_sha256) {
      throw new Error(
        `Passed TTS synthesis sidecar is missing or stale for ${unitId}: ${sidecarPath}`,
      );
    }
    candidates.push({
      unit_id: unitId,
      provider: policy.primary.provider,
      model_id: policy.primary.model_id,
      voice_id: policy.primary.voice_id,
      voice_sha256: policy.primary.voice_sha256,
      voice_continuity_contract: policy.primary.voice_continuity_contract,
      attempt: Number(result.attempt ?? sidecar.attempt ?? 1),
      seed: Number(
        sidecar.per_unit_serial_seed
          ?? deterministicTtsSeed(unitId, policy.primary.provider, Number(result.attempt ?? 1)),
      ),
      batch_seed: Number(sidecar.seed ?? synthesisIdentity.seed),
      spoken_text_sha256: unit.spoken_text_sha256,
      synthesis_identity_sha256: synthesisIdentitySha256,
      synthesis_identity: synthesisIdentity,
      selected_report_synthesis_identity_sha256:
        result.synthesis_identity_sha256,
      synthesis_mode: sidecar.synthesis_mode
        ?? synthesisIdentity.synthesis_mode,
      batch_plan_sha256: sidecar.batch_plan_sha256
        ?? synthesisIdentity.batch_plan_sha256,
      cohort_id: sidecar.cohort_id ?? synthesisIdentity.cohort_id,
      cohort_sha256: sidecar.cohort_sha256
        ?? synthesisIdentity.cohort_sha256,
      generated_token_count: sidecar.generated_token_count ?? null,
      effective_token_limit: sidecar.effective_token_limit ?? null,
      token_limit_reached: sidecar.token_limit_reached ?? false,
      recovery_provenance: sidecar.recovery_provenance
        ?? synthesisIdentity.recovery_provenance
        ?? null,
      runner_report_path: sidecarPath,
      runner_report_sha256: sidecarFileSha256,
      audio_path: audioPath,
      audio_sha256: result.audio_sha256,
      duration_sec: Number(sidecar.duration_sec ?? result.duration_sec),
      voice_continuity: row.qa?.voice_continuity ?? null,
      qa: row.qa,
      disposition: candidateDisposition(row.qa, PRIMARY_TTS_PROVIDER),
      preservation_provenance: {
        schema: "goldflow_preserved_tts_unit_v1",
        selected_report_synthesis_identity_sha256:
          result.synthesis_identity_sha256,
        synthesis_sidecar_path: sidecarPath,
        synthesis_sidecar_sha256: sidecarFileSha256,
        audio_sha256: result.audio_sha256,
      },
    });
  }
  return candidates;
}

function run(command, commandArgs, {
  cwd = process.cwd(),
  timeoutMs = 7_200_000,
  progressJsonlPath = null,
  onProgressEvent = null,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let progressOffset = 0;
    let progressCarry = "";
    let progressChain = Promise.resolve();
    const progressErrors = [];
    let pumping = false;
    const pumpProgress = async ({ final = false } = {}) => {
      if (!progressJsonlPath || pumping) return;
      pumping = true;
      try {
        const handle = await fs.open(progressJsonlPath, "r").catch(() => null);
        if (!handle) return;
        try {
          const stat = await handle.stat();
          if (stat.size < progressOffset) {
            progressOffset = 0;
            progressCarry = "";
          }
          if (stat.size > progressOffset) {
            const buffer = Buffer.alloc(stat.size - progressOffset);
            await handle.read(buffer, 0, buffer.length, progressOffset);
            progressOffset = stat.size;
            progressCarry += buffer.toString("utf8");
          }
        } finally {
          await handle.close();
        }
        const lines = progressCarry.split("\n");
        progressCarry = lines.pop() ?? "";
        if (final && progressCarry.trim()) {
          lines.push(progressCarry);
          progressCarry = "";
        }
        for (const line of lines) {
          if (!line.trim()) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch (error) {
            progressErrors.push({
              code: "tts_progress_event_parse_failed",
              error: error instanceof Error ? error.message : String(error),
            });
            continue;
          }
          if (typeof onProgressEvent === "function") {
            progressChain = progressChain
              .then(() => onProgressEvent(event))
              .catch((error) => {
                progressErrors.push({
                  code: "tts_progress_event_handler_failed",
                  cohort_id: event?.cohort_id ?? null,
                  error: error instanceof Error ? error.message : String(error),
                });
              });
          }
        }
      } finally {
        pumping = false;
      }
    };
    const progressTimer = progressJsonlPath
      ? setInterval(() => { void pumpProgress(); }, 250)
      : null;
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      if (progressTimer) clearInterval(progressTimer);
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (error) => {
      if (progressTimer) clearInterval(progressTimer);
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", async (code, signal) => {
      if (progressTimer) clearInterval(progressTimer);
      clearTimeout(timer);
      await pumpProgress({ final: true });
      await progressChain;
      if (code === 0) resolve({ stdout, stderr, progressErrors });
      else reject(new Error(
        `${command} exited ${code ?? "null"} signal ${signal ?? "null"}\n${stdout.slice(-2000)}\n${stderr.slice(-4000)}`,
      ));
    });
  });
}

function runBinary(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    let stderr = "";
    child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(`${command} exited ${code}\n${stderr.slice(-4000)}`));
    });
  });
}

function requiredExact(actual, expected, label, findings) {
  const normalizedActual = actual ?? null;
  const normalizedExpected = expected ?? null;
  if (!Object.is(normalizedActual, normalizedExpected)) {
    findings.push({
      code: "narration_tts_lock_mismatch",
      field: label,
      expected,
      actual: actual ?? null,
    });
  }
}

export function validateNarrationTtsPolicyForTests(identity) {
  const findings = [];
  const qwenPin = qwenPrimaryLockForVoice(
    identity?.narrator_voice_id,
    identity?.voice_provider_options?.primary?.reference_variant_id
      ?? identity?.provider_locks?.primary_reference_variant_id
      ?? null,
  );
  const qwenReferenceText = qwenPin.reference_text;
  let policy;
  try {
    policy = validateNarrationTtsPolicy(narrationTtsPolicyForIdentity(identity), {
      production: true,
    });
  } catch (error) {
    return {
      status: "blocked",
      findings: [{
        code: "narration_tts_identity_policy_invalid",
        message: error instanceof Error ? error.message : String(error),
      }],
      primary: null,
      fallback: null,
    };
  }
  const primary = policy.primary ?? {};
  const fallback = policy.fallback ?? null;
  if (primary.provider !== "qwen_local") {
    findings.push({
      code: "narration_tts_primary_provider_not_qwen_liam",
      expected: "qwen_local",
      actual: primary.provider ?? null,
    });
  }
  for (const [key, expected] of Object.entries({
    provider: qwenPin.provider,
    model_id: qwenPin.model_id,
    model_revision: qwenPin.model_revision,
    model_weights_sha256: qwenPin.model_weights_sha256,
    model_config_sha256: qwenPin.model_config_sha256,
    generation_config_sha256: qwenPin.generation_config_sha256,
    speech_tokenizer_weights_sha256: qwenPin.speech_tokenizer_weights_sha256,
    speech_tokenizer_config_sha256: qwenPin.speech_tokenizer_config_sha256,
    runtime: qwenPin.runtime,
    runtime_version: qwenPin.runtime_version,
    sample_rate_hz: qwenPin.sample_rate_hz,
    voice_id: qwenPin.voice_id,
    voice_sha256: qwenPin.voice_sha256,
    reference_audio_path: qwenPin.reference_audio_path,
    reference_audio_sha256: qwenPin.reference_audio_sha256,
    reference_text: qwenReferenceText,
    reference_text_sha256: qwenPin.reference_text_sha256,
    reference_manifest_path: qwenPin.reference_manifest_path,
    reference_manifest_sha256: qwenPin.reference_manifest_sha256,
    reference_metadata_path: qwenPin.reference_metadata_path,
    reference_metadata_sha256: qwenPin.reference_metadata_sha256,
    reference_voice_id: qwenPin.reference_voice_id,
    reference_voice_sha256: qwenPin.reference_voice_sha256,
    voice_continuity_contract: qwenPin.voice_continuity_contract,
    delivery_control: "base_icl_reference_audio_only",
    instruct_supported: false,
    speed_control_supported: false,
    native_speed: null,
    temperature: qwenPin.temperature,
    top_p: qwenPin.top_p,
    top_k: qwenPin.top_k,
    repetition_penalty: qwenPin.repetition_penalty,
    max_tokens: qwenPin.max_tokens,
  })) requiredExact(primary[key], expected, `primary.${key}`, findings);
  if (fallback !== null) {
    findings.push({
      code: "narration_tts_fallback_must_be_null",
      expected: null,
      actual: fallback?.provider ?? fallback,
    });
  }
  return {
    status: findings.length ? "blocked" : "passed",
    findings,
    primary: {
      ...qwenPin,
      ...primary,
      reference_text: primary.reference_text ?? qwenReferenceText,
    },
    fallback: null,
    narration_quality_contract: policy.narration_quality_contract ?? null,
    unit_contract: policy.unit_contract,
    stitch_contract: policy.stitch_contract,
    retry_policy: policy.retry_policy,
    retry_contract: policy.retry_contract,
    synthesis_contract: policy.synthesis_contract,
    qa_policy: policy.qa_policy,
  };
}

export function validateNarrationPerformanceGateForTests({
  plan,
  approval,
} = {}) {
  if (!plan?.performance_contract) {
    return {
      status: "legacy_not_required",
      findings: [],
      required: false,
    };
  }
  const validation = validateNarrationPerformanceBakeoffApproval({
    approval,
    contract: plan.performance_contract,
  });
  return {
    ...validation,
    required: true,
    performance_contract_sha256:
      plan.performance_contract.contract_sha256,
  };
}

function wordCount(value) {
  return String(value ?? "").trim().split(/\s+/).filter(Boolean).length;
}

export function normalizeNarrationUnitsForTests(plan, {
  voiceId = null,
  referenceVariantId = null,
} = {}) {
  const expectedVoiceLock = qwenPinForVoiceId(voiceId, referenceVariantId);
  const topLevel = Array.isArray(plan?.units) ? plan.units : null;
  const raw = topLevel ?? (plan?.segments ?? []).flatMap((segment) => {
    const rows = segment?.narration_units
      ?? segment?.narration_generation_units
      ?? segment?.tts_generation_units
      ?? segment?.qwen_generation_units
      ?? [];
    return rows.map((row) => ({
      ...row,
      source_segment_ids: row.source_segment_ids?.length
        ? row.source_segment_ids
        : [segment.segment_id].filter(Boolean),
      inherited_segment_id: segment.segment_id ?? null,
    }));
  });
  if (!raw.length) throw new Error("narration_generation_plan contains no units");
  const seen = new Set();
  const units = raw.map((row, index) => {
    const unitId = String(row?.unit_id ?? "").trim();
    if (!unitId || seen.has(unitId)) {
      throw new Error(`Missing or duplicate provider-neutral unit_id at index ${index}: ${unitId || "<missing>"}`);
    }
    seen.add(unitId);
    const aliases = [
      row.spoken_text,
      row.tts_spoken_text,
      row.qwen_spoken_text,
    ].filter((value) => value != null).map(String);
    if (!aliases.length || !aliases[0].trim()) throw new Error(`Unit ${unitId} has no spoken text`);
    if (aliases.some((value) => value !== aliases[0])) {
      throw new Error(`Unit ${unitId} spoken-text aliases are not byte-equal`);
    }
    const spokenText = aliases[0];
    const spokenTextSha256 = sha256Text(spokenText);
    if (row.spoken_text_sha256 && row.spoken_text_sha256 !== spokenTextSha256) {
      throw new Error(`Unit ${unitId} spoken_text_sha256 is stale`);
    }
    if (!Array.isArray(row.source_unit_refs) || !row.source_unit_refs.length) {
      throw new Error(`Unit ${unitId} lacks stable source_unit_refs`);
    }
    const sourceSegmentIds = [...new Set([
      ...(row.source_segment_ids ?? []),
      ...row.source_unit_refs.map((ref) => ref?.segment_id),
      row.inherited_segment_id,
    ].map((value) => String(value ?? "").trim()).filter(Boolean))];
    if (sourceSegmentIds.length > 1) {
      throw new Error(
        `Unit ${unitId} crosses a hard voice-segment boundary: ${sourceSegmentIds.join(", ")}`,
      );
    }
    const controls = row.provider_controls ?? {};
    const qwen = controls.qwen3 ?? controls.qwen_local ?? {};
    const unitVoiceId = String(
      qwen.reference_voice_id
        ?? qwen.target_voice_id
        ?? row.reference_id
        ?? "",
    );
    if ((voiceId && unitVoiceId !== voiceId)
      || unitVoiceId !== expectedVoiceLock.voice_id
      || qwen.provider !== "qwen_local"
      || qwen.model_id !== expectedVoiceLock.model_id
      || qwen.model_revision !== expectedVoiceLock.model_revision
      || qwen.reference_audio_sha256
        !== expectedVoiceLock.reference_audio_sha256
      || qwen.reference_manifest_sha256
        !== expectedVoiceLock.reference_manifest_sha256
      || qwen.voice_continuity_contract
        !== expectedVoiceLock.voice_continuity_contract
      || qwen.instruct_supported !== false
      || qwen.instruct_submitted !== false
      || qwen.speed_control_supported !== false
      || qwen.native_speed != null) {
      throw new Error(`Unit ${unitId} Qwen controls drift from the locked Base reference-clone policy`);
    }
    const unitWords = Number(row.word_count ?? wordCount(spokenText));
    if (unitWords > 60) {
      throw new Error(`Unit ${unitId} exceeds the hard 60-word Qwen request maximum`);
    }
    if (!hasTtsTerminalPunctuation(spokenText)) {
      throw new Error(`Unit ${unitId} does not end on a complete sentence boundary`);
    }
    const expectedOrder = Number(row.order_index ?? index);
    if (!Number.isInteger(expectedOrder)) throw new Error(`Unit ${unitId} has invalid order_index`);
    return {
      ...row,
      unit_id: unitId,
      order_index: expectedOrder,
      spoken_text: spokenText,
      tts_spoken_text: spokenText,
      qwen_spoken_text: spokenText,
      spoken_text_sha256: spokenTextSha256,
      word_count: unitWords,
      source_segment_ids: sourceSegmentIds,
      qwen_instruct: String(
        controls.qwen3?.instruct
          ?? controls.qwen_local?.instruct
          ?? row.qwen_instruct
          ?? "",
      ),
    };
  });
  const orderValues = units.map((unit) => unit.order_index);
  const base = orderValues[0];
  if (!orderValues.every((value, index) => value === base + index)) {
    throw new Error("narration_generation_plan unit order_index values are reordered or non-contiguous");
  }
  return units;
}

export function validateNarrationPlanPolicyForTests(plan, policy) {
  const controls = plan?.provider_controls?.qwen3
    ?? plan?.provider_controls?.qwen_local
    ?? {};
  const actual = {
    primary_provider: plan?.primary_provider ?? plan?.provider ?? plan?.tts_provider,
    fallback_provider: plan?.fallback_provider
      ?? plan?.provider_policy?.fallback_provider,
    narrator_voice_id: plan?.narrator_voice_id
      ?? controls.reference_voice_id
      ?? controls.target_voice_id,
    native_speed: plan?.tts_native_speed
      ?? controls.native_speed
      ?? null,
  };
  const findings = [];
  requiredExact(
    actual.primary_provider,
    policy.primary.provider,
    "plan.primary_provider",
    findings,
  );
  requiredExact(
    actual.fallback_provider ?? null,
    null,
    "plan.fallback_provider",
    findings,
  );
  requiredExact(
    actual.narrator_voice_id,
    policy.primary.voice_id,
    "plan.narrator_voice_id",
    findings,
  );
  if (actual.native_speed != null) {
    findings.push({
      code: "narration_tts_plan_lock_mismatch",
      field: "plan.native_speed",
      expected: null,
      actual: actual.native_speed,
    });
  }
  const unitContract = policy.unit_contract ?? QWEN_LIAM_UNIT_CONTRACT;
  requiredExact(
    plan?.qwen_liam_unit_grouping?.target_spoken_words_min,
    unitContract.target_words_min,
    "plan.qwen_liam_unit_grouping.target_spoken_words_min",
    findings,
  );
  requiredExact(
    plan?.qwen_liam_unit_grouping?.target_spoken_words_max,
    unitContract.target_words_max,
    "plan.qwen_liam_unit_grouping.target_spoken_words_max",
    findings,
  );
  requiredExact(
    plan?.qwen_liam_unit_grouping?.hard_spoken_words_max,
    unitContract.hard_words_max,
    "plan.qwen_liam_unit_grouping.hard_spoken_words_max",
    findings,
  );
  if (unitContract.soft_words_max != null) {
    requiredExact(
      plan?.qwen_liam_unit_grouping?.soft_spoken_words_max,
      unitContract.soft_words_max,
      "plan.qwen_liam_unit_grouping.soft_spoken_words_max",
      findings,
    );
  }
  requiredExact(
    plan?.qwen_liam_unit_grouping?.continuous_requests_allowed,
    false,
    "plan.qwen_liam_unit_grouping.continuous_requests_allowed",
    findings,
  );
  if (policy.synthesis_contract?.mode
    === QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.mode) {
    if (JSON.stringify(controls.synthesis_contract)
      !== JSON.stringify(policy.synthesis_contract)) {
      findings.push({
        code: "narration_tts_plan_synthesis_contract_mismatch",
        field: "plan.provider_controls.qwen3.synthesis_contract",
        expected: policy.synthesis_contract,
        actual: controls.synthesis_contract ?? null,
      });
    }
    const rawUnits = Array.isArray(plan?.units) && plan.units.length
      ? plan.units
      : (plan?.segments ?? []).flatMap((segment) => (
          segment?.narration_units
          ?? segment?.narration_generation_units
          ?? segment?.qwen_generation_units
          ?? []
        ));
    try {
      const batchValidation = validateQwenLiamBatchPlan(
        plan?.qwen_liam_batch_plan,
        rawUnits,
        policy.synthesis_contract,
      );
      findings.push(...batchValidation.findings);
    } catch (error) {
      findings.push({
        code: "narration_tts_plan_batch_contract_invalid",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  findings.push(...narrationPlanVoiceIdentityFindings(plan, policy));
  return {
    status: findings.length ? "blocked" : "passed",
    findings,
    actual,
  };
}

function normalizedWords(value) {
  return String(value ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function includesSequence(haystack, needle) {
  if (!needle.length) return true;
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    if (needle.every((token, index) => haystack[start + index] === token)) return true;
  }
  return false;
}

export function protectedTermFindingsForTests(unit, recognizedText) {
  const recognized = normalizedWords(recognizedText);
  const intended = normalizedWords(unit.spoken_text);
  const findings = [];
  for (const raw of unit.protected_terms ?? []) {
    const term = typeof raw === "string"
      ? raw
      : raw.spoken_form ?? raw.term ?? raw.text ?? "";
    const accepted = [
      term,
      ...(typeof raw === "object" && Array.isArray(raw.accepted_forms) ? raw.accepted_forms : []),
    ].filter(Boolean);
    const intendedTerm = normalizedWords(term);
    if (!intendedTerm.length || !includesSequence(intended, intendedTerm)) continue;
    if (!accepted.some((value) => includesSequence(recognized, normalizedWords(value)))) {
      findings.push({
        severity: "blocker",
        code: "tts_transcript_protected_term_missing",
        protected_term: term,
        accepted_forms: accepted,
      });
    }
  }
  return findings;
}

export function equivalentPhrasesForTests(unit) {
  return [
    ...(Array.isArray(unit.tts_override_replacements_applied)
      ? unit.tts_override_replacements_applied.filter(
        (row) => row?.asr_equivalence_allowed === true,
      )
      : []),
    ...(unit.asr_equivalent_phrases ?? []),
  ];
}

function selectedResultsForReport(units, selectedRows, candidates) {
  const selectedById = new Map(selectedRows.map((row) => [String(row.unit_id), row]));
  return units.flatMap((unit) => {
    const selected = selectedById.get(String(unit.unit_id));
    if (!selected) return [];
    const unitCandidates = candidates.filter(
      (candidate) => String(candidate.unit_id) === String(unit.unit_id),
    );
    return [{
      unit_id: unit.unit_id,
      selected_provider: selected.provider,
      provider: selected.provider,
      model_id: selected.model_id,
      voice_id: selected.voice_id,
      attempt: selected.attempt,
      spoken_text_sha256: unit.spoken_text_sha256,
      primary_spoken_text_sha256: unit.spoken_text_sha256,
      selected_spoken_text_sha256: unit.spoken_text_sha256,
      fallback_spoken_text_sha256: null,
      voice_continuity_contract:
        qwenPinForVoiceId(selected.voice_id).voice_continuity_contract,
      voice_continuity: selected.unit_qa?.voice_continuity ?? null,
      audio_path: selected.wav,
      audio_sha256: selected.unit_qa?.audio_sha256 ?? null,
      synthesis_mode: selected.synthesis_mode ?? null,
      batch_plan_sha256: selected.batch_plan_sha256 ?? null,
      cohort_id: selected.cohort_id ?? null,
      cohort_sha256: selected.cohort_sha256 ?? null,
      generated_token_count: selected.generated_token_count ?? null,
      effective_token_limit: selected.effective_token_limit ?? null,
      token_limit_reached: selected.token_limit_reached ?? null,
      recovery_provenance: selected.recovery_provenance ?? null,
      synthesis_identity: selected.synthesis_identity ?? null,
      synthesis_identity_sha256: selected.synthesis_identity_sha256 ?? null,
      selected_qa: selected.unit_qa,
      qa_status: selected.unit_qa?.status ?? null,
      candidate_attempts: unitCandidates.map((candidate) => ({
        provider: candidate.provider,
        attempt: candidate.attempt,
        seed: candidate.seed,
        audio_sha256: candidate.audio_sha256,
        synthesis_identity_sha256: candidate.synthesis_identity_sha256,
        synthesis_mode: candidate.synthesis_mode ?? null,
        batch_plan_sha256: candidate.batch_plan_sha256 ?? null,
        cohort_id: candidate.cohort_id ?? null,
        cohort_sha256: candidate.cohort_sha256 ?? null,
        generated_token_count: candidate.generated_token_count ?? null,
        effective_token_limit: candidate.effective_token_limit ?? null,
        token_limit_reached: candidate.token_limit_reached ?? null,
        recovery_provenance: candidate.recovery_provenance ?? null,
        disposition: candidate.disposition,
      })),
    }];
  });
}

export function selectedQaDecisionForTests(selectedRows, {
  unresolvedUnitIds = [],
  orderQa = { status: "passed", blockers: [] },
} = {}) {
  const selectedBlockers = selectedRows.flatMap((row) => (
    [
      ...(row.unit_qa?.findings ?? [])
      .filter((finding) => finding.severity === "blocker")
      .map((finding) => ({ unit_id: row.unit_id, provider: row.provider, ...finding })),
      ...(!["passed", "passed_with_warnings"].includes(
        String(row.unit_qa?.status ?? "").toLowerCase(),
      ) && !(row.unit_qa?.findings ?? []).some((finding) => finding.severity === "blocker")
        ? [{
            unit_id: row.unit_id,
            provider: row.provider,
            severity: "blocker",
            code: row.unit_qa
              ? "tts_selected_unit_qa_status_not_passed"
              : "tts_selected_unit_qa_missing",
          }]
        : []),
    ]
  ));
  return {
    status: unresolvedUnitIds.length || orderQa.status !== "passed" || selectedBlockers.length
      ? "blocked"
      : "passed",
    selected_blockers: selectedBlockers,
    blockers: [
      ...(orderQa.blockers ?? []),
      ...(unresolvedUnitIds.length ? [{
        code: "narration_tts_units_exhausted_qwen_liam_attempts",
        unit_ids: unresolvedUnitIds,
      }] : []),
      ...selectedBlockers,
    ],
  };
}

function ttsStatusContract({
  policy,
  units,
  selectedRows,
  candidates,
  unitQaStatus,
  fullStreamQaStatus,
  recoveryScope = null,
  batchPlan = null,
  synthesisRuns = [],
}) {
  const results = selectedResultsForReport(units, selectedRows, candidates);
  return {
    primary_provider: policy.primary.provider,
    primary_model_id: policy.primary.model_id,
    primary_model_revision: policy.primary.model_revision,
    narrator_voice_id: policy.primary.voice_id,
    tts_native_speed: null,
    primary: {
      provider: policy.primary.provider,
      model_id: policy.primary.model_id,
      model_revision: policy.primary.model_revision,
      voice_id: policy.primary.voice_id,
      voice_sha256: policy.primary.voice_sha256,
      native_speed: null,
      reference_audio_sha256: policy.primary.reference_audio_sha256,
      reference_manifest_sha256: policy.primary.reference_manifest_sha256,
      voice_continuity_contract: policy.primary.voice_continuity_contract,
    },
    post_tempo_normalized: false,
    effective_concurrency: EFFECTIVE_CONCURRENCY,
    synthesis_contract: policy.synthesis_contract,
    batch_plan_sha256: batchPlan?.batch_plan_sha256 ?? null,
    synthesis_runs: synthesisRuns,
    model_load_policy: recoveryScope?.mode === "hash_bound_manual_accept_first_take"
      ? "manual_review_existing_candidates_no_model_load"
      : policy.synthesis_contract?.mode
        === QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.mode
        ? "once_per_resident_qwen_batch_or_recovery_invocation"
        : "once_per_serial_qwen_attempt_invocation",
    qa_policy: QA_POLICY_VERSION,
    unit_qa_policy_version: QA_POLICY_VERSION,
    unit_qa_status: unitQaStatus,
    full_stream_qa_status: fullStreamQaStatus,
    expected_unit_count: units.length,
    selected_unit_count: selectedRows.length,
    fallback_unit_ids: [],
    fallback_selected_unit_ids: [],
    fallback_usage: null,
    retry_policy: narrationTtsRetryReportPolicy({
      provider: policy.primary.provider,
      qualityContract: policy.narration_quality_contract,
    }),
    results,
  };
}

function rebuildQaAggregate(rows, candidates) {
  const historicalCandidateBlockers = rows.flatMap((row) => (row.unit_qa?.findings ?? [])
    .filter((finding) => finding.severity === "blocker")
    .map((finding) => ({
      unit_id: row.unit_id,
      provider: row.provider,
      attempt: row.attempt,
      ...finding,
    })));
  const warnings = rows.flatMap((row) => (row.unit_qa?.findings ?? [])
    .filter((finding) => finding.severity === "warning")
    .map((finding) => ({
      unit_id: row.unit_id,
      provider: row.provider,
      attempt: row.attempt,
      ...finding,
    })));
  return {
    schema: "goldflow_narration_tts_unit_qa_v1",
    status: "pending_selection_adjudication",
    policy_version: QA_POLICY_VERSION,
    candidate_count: candidates.length,
    blocked_candidate_count: rows.filter((row) => row.unit_qa?.status === "blocked").length,
    historical_candidate_blocker_count: historicalCandidateBlockers.length,
    warning_count: warnings.length,
    historical_candidate_blockers: historicalCandidateBlockers,
    warnings,
    candidates,
  };
}

function stitchReviewWarnings(stitch) {
  return [
    ...(stitch?.prepared_qa?.warnings ?? []),
    ...(stitch?.boundary_qa?.warnings ?? []),
    ...(stitch?.final_qa?.warnings ?? []),
  ];
}

function applyProtectedTermQa(rows) {
  for (const row of rows) {
    const recognizedText = row.unit_qa?.transcript_cross_validation?.recognized_text
      ?? row.unit_qa?.transcript?.recognized_text;
    if (!recognizedText) continue;
    const protectedFindings = protectedTermFindingsForTests(row, recognizedText);
    if (!protectedFindings.length) continue;
    row.unit_qa.findings = [...(row.unit_qa.findings ?? []), ...protectedFindings];
    row.unit_qa.status = "blocked";
  }
}

async function wavSampleCount(filePath) {
  const buffer = await fs.readFile(filePath);
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "data") return Math.floor(size / 2);
    offset += 8 + size + (size % 2);
  }
  throw new Error(`Could not find WAV data chunk: ${filePath}`);
}

function dbfs(value) {
  return value > 0 ? Number((20 * Math.log10(value)).toFixed(3)) : null;
}

function pcmRms(values, start, end) {
  const from = Math.max(0, Math.min(values.length, Math.floor(start)));
  const to = Math.max(from, Math.min(values.length, Math.floor(end)));
  if (to <= from) return 0;
  let sum = 0;
  for (let index = from; index < to; index += 1) {
    const sample = values[index] / 32768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / (to - from));
}

function pcmHighFrequencyProxy(values, start, end) {
  const from = Math.max(1, Math.min(values.length, Math.floor(start)));
  const to = Math.max(from, Math.min(values.length, Math.floor(end)));
  if (to <= from) return 0;
  let sum = 0;
  for (let index = from; index < to; index += 1) {
    const delta = (values[index] - values[index - 1]) / 32768;
    sum += delta * delta;
  }
  return Math.sqrt(sum / (to - from));
}

function absoluteDbRatio(left, right) {
  if (!(left > 0) || !(right > 0)) return null;
  return Number(Math.abs(20 * Math.log10(left / right)).toFixed(3));
}

export function joinQaFromPcmForTests(samples, sampleRate, preparedInputs, boundaries) {
  const values = samples instanceof Int16Array ? samples : Int16Array.from(samples);
  const boundaryMap = new Map(boundaries.map((row) => [String(row.after_unit_id), row]));
  const requiredEffectiveGapSamples = Math.round(
    QWEN_LIAM_PRIMARY_LOCK.stitch_contract.join_silence_ms * sampleRate / 1000,
  );
  const rows = [];
  const blockers = [];
  const warnings = [];
  let cursor = 0;
  for (let index = 0; index < preparedInputs.length; index += 1) {
    const prepared = preparedInputs[index];
    const preparedSamples = Number(prepared.sample_count);
    if (!Number.isInteger(preparedSamples) || preparedSamples <= 0) {
      blockers.push({ code: "tts_join_prepared_sample_count_missing", unit_id: prepared.unit_id });
      continue;
    }
    cursor += preparedSamples;
    if (index >= preparedInputs.length - 1) continue;
    const boundary = boundaryMap.get(String(prepared.unit_id));
    if (!boundary) {
      blockers.push({ code: "tts_join_boundary_missing", after_unit_id: prepared.unit_id });
      continue;
    }
    const gapSamples = Number(boundary.gap_sample_count ?? 0);
    const nextPrepared = preparedInputs[index + 1];
    const actualRetainedLeft = Number(
      prepared?.retained_trailing_silence_sample_count
      ?? prepared?.prepared_qa?.metrics?.trailing_silence_sample_count,
    );
    const actualRetainedRight = Number(
      nextPrepared?.retained_leading_silence_sample_count
      ?? nextPrepared?.prepared_qa?.metrics?.leading_silence_sample_count,
    );
    const actualEffectiveGapSamples =
      actualRetainedLeft + gapSamples + actualRetainedRight;
    const boundaryContractFindings = [];
    const addBoundaryContractBlocker = (code, expected, actual) => {
      const finding = {
        code,
        after_unit_id: prepared.unit_id,
        before_unit_id: nextPrepared?.unit_id ?? null,
        expected_sample_count: expected,
        actual_sample_count: actual,
      };
      boundaryContractFindings.push(finding);
      blockers.push(finding);
    };
    if (!Number.isInteger(actualRetainedLeft) || actualRetainedLeft < 0) {
      addBoundaryContractBlocker(
        "tts_join_actual_left_retained_silence_samples_missing",
        "nonnegative integer",
        Number.isFinite(actualRetainedLeft) ? actualRetainedLeft : null,
      );
    }
    if (!Number.isInteger(actualRetainedRight) || actualRetainedRight < 0) {
      addBoundaryContractBlocker(
        "tts_join_actual_right_retained_silence_samples_missing",
        "nonnegative integer",
        Number.isFinite(actualRetainedRight) ? actualRetainedRight : null,
      );
    }
    if (Number.isInteger(actualRetainedLeft)
      && actualRetainedLeft > preparedSamples) {
      addBoundaryContractBlocker(
        "tts_join_actual_left_retained_silence_exceeds_prepared_audio",
        preparedSamples,
        actualRetainedLeft,
      );
    }
    const nextPreparedSamples = Number(nextPrepared?.sample_count);
    if (Number.isInteger(actualRetainedRight)
      && Number.isInteger(nextPreparedSamples)
      && actualRetainedRight > nextPreparedSamples) {
      addBoundaryContractBlocker(
        "tts_join_actual_right_retained_silence_exceeds_prepared_audio",
        nextPreparedSamples,
        actualRetainedRight,
      );
    }
    if (Number(boundary.target_gap_sample_count) !== requiredEffectiveGapSamples) {
      addBoundaryContractBlocker(
        "tts_join_target_gap_sample_count_mismatch",
        requiredEffectiveGapSamples,
        Number(boundary.target_gap_sample_count),
      );
    }
    if (Number(boundary.retained_left_trailing_silence_sample_count)
      !== actualRetainedLeft) {
      addBoundaryContractBlocker(
        "tts_join_declared_left_retained_silence_samples_mismatch",
        actualRetainedLeft,
        Number(boundary.retained_left_trailing_silence_sample_count),
      );
    }
    if (Number(boundary.retained_right_leading_silence_sample_count)
      !== actualRetainedRight) {
      addBoundaryContractBlocker(
        "tts_join_declared_right_retained_silence_samples_mismatch",
        actualRetainedRight,
        Number(boundary.retained_right_leading_silence_sample_count),
      );
    }
    if (Number(boundary.inserted_silence_sample_count) !== gapSamples) {
      addBoundaryContractBlocker(
        "tts_join_declared_inserted_silence_samples_mismatch",
        gapSamples,
        Number(boundary.inserted_silence_sample_count),
      );
    }
    if (Number(boundary.effective_gap_sample_count)
      !== actualEffectiveGapSamples) {
      addBoundaryContractBlocker(
        "tts_join_declared_effective_gap_sample_count_mismatch",
        actualEffectiveGapSamples,
        Number(boundary.effective_gap_sample_count),
      );
    }
    if (actualEffectiveGapSamples !== requiredEffectiveGapSamples) {
      addBoundaryContractBlocker(
        "tts_join_effective_gap_sample_count_mismatch",
        requiredEffectiveGapSamples,
        actualEffectiveGapSamples,
      );
    }
    const leftStep = cursor > 0 && cursor < values.length
      ? Math.abs(values[cursor] - values[cursor - 1]) / 32768
      : 0;
    let silencePeak = 0;
    for (let sample = cursor; sample < Math.min(values.length, cursor + gapSamples); sample += 1) {
      silencePeak = Math.max(silencePeak, Math.abs(values[sample]) / 32768);
    }
    const gapEnd = cursor + gapSamples;
    const rightStep = gapEnd > 0 && gapEnd < values.length
      ? Math.abs(values[gapEnd] - values[gapEnd - 1]) / 32768
      : 0;
    const maximumStep = Math.max(leftStep, rightStep);
    const blockerThreshold = 10 ** (-8 / 20);
    const warningThreshold = 10 ** (-12 / 20);
    const row = {
      after_unit_id: prepared.unit_id,
      before_unit_id: preparedInputs[index + 1].unit_id,
      boundary_sample_index: cursor,
      target_gap_sample_count: requiredEffectiveGapSamples,
      retained_left_trailing_silence_sample_count: actualRetainedLeft,
      retained_right_leading_silence_sample_count: actualRetainedRight,
      inserted_silence_sample_count: gapSamples,
      effective_gap_sample_count: actualEffectiveGapSamples,
      gap_sample_count: gapSamples,
      maximum_edge_step_dbfs: dbfs(maximumStep),
      inserted_gap_peak_dbfs: dbfs(silencePeak),
      status: boundaryContractFindings.length
        || silencePeak > 10 ** (-54 / 20)
        ? "blocked"
        : maximumStep > warningThreshold
          ? "passed_with_warning"
        : "passed",
    };
    rows.push(row);
    if (maximumStep > blockerThreshold) warnings.push({
      severity: "warning",
      code: "tts_join_impulsive_discontinuity",
      original_severity: "blocker",
      disposition_policy: "automated_tts_qa_review_warning",
      review_required: true,
      automatic_retry_allowed: false,
      blocks_stitching: false,
      ...row,
    });
    else if (maximumStep > warningThreshold) warnings.push({
      severity: "warning",
      code: "tts_join_possible_impulsive_discontinuity",
      disposition_policy: "automated_tts_qa_review_warning",
      review_required: true,
      automatic_retry_allowed: false,
      blocks_stitching: false,
      ...row,
    });
    if (silencePeak > 10 ** (-54 / 20)) blockers.push({
      code: "tts_join_inserted_gap_not_silent",
      ...row,
    });
    cursor = gapEnd;
  }
  if (cursor !== values.length) blockers.push({
    code: "tts_join_total_sample_count_mismatch",
    expected_sample_count: cursor,
    actual_sample_count: values.length,
  });
  return {
    status: blockers.length
      ? "blocked"
      : warnings.length ? "passed_with_warnings" : "passed",
    policy_version: STITCH_POLICY_VERSION,
    sample_rate_hz: sampleRate,
    required_effective_gap_ms: QWEN_LIAM_PRIMARY_LOCK.stitch_contract.join_silence_ms,
    required_effective_gap_sample_count: requiredEffectiveGapSamples,
    exact_effective_gap_sample_count_required: true,
    join_count: rows.length,
    joins: rows,
    blockers,
    warnings,
  };
}

export function joinQaV2FromPcmForTests(
  samples,
  sampleRate,
  preparedInputs,
  boundaries,
) {
  const values = samples instanceof Int16Array ? samples : Int16Array.from(samples);
  const accounting = validateNarrationStitchAccounting({
    preparedInputs,
    boundaries,
    finalSampleCount: values.length,
    sampleRate,
  });
  const blockers = [...accounting.blockers];
  const warnings = [...accounting.warnings];
  const joins = [];
  let cursor = 0;
  for (let index = 0; index < preparedInputs.length; index += 1) {
    const prepared = preparedInputs[index];
    const preparedSamples = Number(
      prepared.sample_count
        ?? prepared.prepared_sample_count
        ?? prepared.prepared_qa?.metrics?.sample_count,
    );
    if (!Number.isInteger(preparedSamples) || preparedSamples <= 0) continue;
    cursor += preparedSamples;
    if (index >= preparedInputs.length - 1) continue;
    const boundary = boundaries[index];
    if (!boundary) continue;
    const gapSamples = Number(boundary.gap_sample_count ?? 0);
    if (!Number.isInteger(gapSamples) || gapSamples < 0) continue;
    const leftStep = cursor > 0 && cursor < values.length
      ? Math.abs(values[cursor] - values[cursor - 1]) / 32768
      : 0;
    let silencePeak = 0;
    for (let sample = cursor; sample < Math.min(values.length, cursor + gapSamples); sample += 1) {
      silencePeak = Math.max(silencePeak, Math.abs(values[sample]) / 32768);
    }
    const gapEnd = cursor + gapSamples;
    const rightStep = gapEnd > 0 && gapEnd < values.length
      ? Math.abs(values[gapEnd] - values[gapEnd - 1]) / 32768
      : 0;
    const maximumStep = Math.max(leftStep, rightStep);
    const blockerThreshold = 10 ** (-8 / 20);
    const warningThreshold = 10 ** (-18 / 20);
    const analysisWindow = Math.max(1, Math.round(sampleRate * 0.04));
    const leftRetainedSilence = Number(prepared?.retained_trailing_silence_sample_count ?? 0);
    const rightPrepared = preparedInputs[index + 1];
    const rightRetainedSilence = Number(rightPrepared?.retained_leading_silence_sample_count ?? 0);
    const leftSpeechEnd = Math.max(0, cursor - Math.max(0, leftRetainedSilence));
    const rightSpeechStart = Math.min(values.length, gapEnd + Math.max(0, rightRetainedSilence));
    const leftSpeechRms = pcmRms(values, leftSpeechEnd - analysisWindow, leftSpeechEnd);
    const rightSpeechRms = pcmRms(values, rightSpeechStart, rightSpeechStart + analysisWindow);
    const leftHighFrequency = pcmHighFrequencyProxy(values, leftSpeechEnd - analysisWindow, leftSpeechEnd);
    const rightHighFrequency = pcmHighFrequencyProxy(values, rightSpeechStart, rightSpeechStart + analysisWindow);
    const leftNoiseRms = pcmRms(values, leftSpeechEnd, cursor);
    const rightNoiseRms = pcmRms(values, gapEnd, rightSpeechStart);
    const prosodicEnergyResetDb = absoluteDbRatio(leftSpeechRms, rightSpeechRms);
    const spectralEdgeResetDb = absoluteDbRatio(leftHighFrequency, rightHighFrequency);
    const noiseFloorResetDb = absoluteDbRatio(leftNoiseRms, rightNoiseRms);
    const row = {
      boundary_id: boundary.boundary_id ?? null,
      after_unit_id: boundary.after_unit_id ?? prepared.unit_id,
      before_unit_id: boundary.before_unit_id
        ?? preparedInputs[index + 1]?.unit_id
        ?? null,
      boundary_class: boundary.boundary_class ?? null,
      boundary_sample_index: cursor,
      target_pause_sample_count: boundary.target_pause_sample_count ?? null,
      retained_natural_silence_sample_count:
        boundary.retained_natural_silence_sample_count ?? null,
      inserted_silence_sample_count: gapSamples,
      effective_pause_sample_count: boundary.effective_pause_sample_count ?? null,
      maximum_edge_step_dbfs: dbfs(maximumStep),
      inserted_gap_peak_dbfs: dbfs(silencePeak),
      edge_analysis_window_ms: 40,
      left_speech_rms_dbfs: dbfs(leftSpeechRms),
      right_speech_rms_dbfs: dbfs(rightSpeechRms),
      prosodic_energy_reset_db: prosodicEnergyResetDb,
      left_high_frequency_proxy_dbfs: dbfs(leftHighFrequency),
      right_high_frequency_proxy_dbfs: dbfs(rightHighFrequency),
      spectral_edge_reset_db: spectralEdgeResetDb,
      left_noise_floor_dbfs: dbfs(leftNoiseRms),
      right_noise_floor_dbfs: dbfs(rightNoiseRms),
      noise_floor_reset_db: noiseFloorResetDb,
      status: "passed",
    };
    if (silencePeak > 10 ** (-54 / 20)) {
      const finding = {
        code: "narration_semantic_join_inserted_gap_not_silent",
        ...row,
      };
      blockers.push(finding);
      row.status = "blocked";
    }
    if (maximumStep > blockerThreshold) {
      const finding = {
        code: "narration_semantic_join_impulsive_discontinuity",
        repair_scope: "exact_boundary_only",
        ...row,
      };
      blockers.push(finding);
      row.status = "blocked";
    } else if (maximumStep > warningThreshold) {
      warnings.push({
        severity: "warning",
        code: "narration_semantic_join_possible_discontinuity",
        review_required: true,
        automatic_retry_allowed: false,
        ...row,
      });
      row.status = "passed_with_warning";
    }
    for (const [code, value, threshold] of [
      ["narration_semantic_join_prosodic_energy_reset", prosodicEnergyResetDb, 12],
      ["narration_semantic_join_spectral_edge_reset", spectralEdgeResetDb, 10],
      ["narration_semantic_join_noise_floor_reset", noiseFloorResetDb, 9],
    ]) {
      if (Number.isFinite(value) && value > threshold) {
        warnings.push({
          severity: "warning",
          code,
          measured_delta_db: value,
          warning_threshold_db: threshold,
          review_required: true,
          automatic_retry_allowed: false,
          repair_scope: "exact_boundary_only_after_listening_confirmation",
          ...row,
        });
        if (row.status === "passed") row.status = "passed_with_warning";
      }
    }
    joins.push(row);
    cursor = gapEnd;
  }
  return {
    schema: "goldflow_narration_semantic_join_qa_v2",
    status: blockers.length
      ? "blocked"
      : warnings.length ? "passed_with_warnings" : "passed",
    policy_version: STITCH_POLICY_VERSION_V2,
    sample_rate_hz: sampleRate,
    semantic_boundary_classes: true,
    amplitude_only_trimming: false,
    fade_over_speech: false,
    sample_accounting: accounting,
    join_count: joins.length,
    joins,
    blockers,
    warnings,
  };
}

async function runSynthesis({
  route,
  attempt,
  units,
  policy,
  batchPlan,
  synthesisMode,
  recoveryProvenanceByUnit = new Map(),
  outputDir,
  python,
  runnerPath,
  invocationId,
  preSynthesisGate,
  preSynthesisGatePath,
  preSynthesisGateFileSha256,
  planPath,
  planSha256,
  planFileSha256,
  identityPath,
  identityFileSha256,
  scriptPath,
  scriptSha256,
  onCohortComplete = null,
}) {
  if (route !== "qwen") {
    throw new Error(`Qwen Liam production forbids alternate synthesis route ${route}`);
  }
  const provider = PRIMARY_TTS_PROVIDER;
  const bindingByUnit = qwenBatchBindingByUnit(batchPlan);
  const batch4Identity = policy.synthesis_contract?.mode
    === QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.mode;
  const jobs = {
    schema: batch4Identity
      ? "goldflow_narration_tts_jobs_v2"
      : "goldflow_narration_tts_jobs_v1",
    route,
    provider,
    model_id: policy.primary.model_id,
    model_revision: policy.primary.model_revision,
    voice_id: policy.primary.voice_id,
    voice_sha256: policy.primary.voice_sha256,
    voice_continuity_contract: policy.primary.voice_continuity_contract,
    attempt,
    synthesis_contract: policy.synthesis_contract,
    synthesis_mode: synthesisMode,
    batch_plan: batch4Identity ? batchPlan : null,
    batch_plan_sha256: batchPlan.batch_plan_sha256,
    qwen_reference_audio_sha256: policy.primary.reference_audio_sha256,
    qwen_reference_text: policy.primary.reference_text,
    qwen_reference_manifest_sha256: policy.primary.reference_manifest_sha256,
    qwen_reference_voice_id: policy.primary.reference_voice_id,
    qwen_reference_voice_sha256: policy.primary.reference_voice_sha256,
    qwen_voice_continuity_contract:
      policy.primary.voice_continuity_contract,
    qwen_native_speed: null,
    qwen_post_tts_tempo_processing: false,
    continuous_longform_request: false,
    pre_synthesis_gate: {
      path: preSynthesisGatePath,
      file_sha256: preSynthesisGateFileSha256,
      gate_sha256: preSynthesisGate?.gate_sha256 ?? null,
    },
    narration_generation_plan_path: planPath,
    narration_generation_plan_sha256: planSha256,
    narration_generation_plan_file_sha256: planFileSha256,
    run_identity_path: identityPath,
    run_identity_file_sha256: identityFileSha256,
    source_script_path: scriptPath,
    source_script_sha256: scriptSha256,
    jobs: units.map((unit) => ({
      unit_id: unit.unit_id,
      spoken_text: unit.spoken_text,
      spoken_text_sha256: unit.spoken_text_sha256,
      original_order_index: unit.order_index,
      spoken_word_count: unit.word_count,
      spoken_text_utf8_bytes: Buffer.byteLength(unit.spoken_text, "utf8"),
      attempt,
      seed: deterministicTtsSeed(unit.unit_id, provider, attempt),
      qwen_instruct: unit.qwen_instruct,
      synthesis_cohort: bindingByUnit.get(String(unit.unit_id)) ?? null,
      recovery_provenance:
        recoveryProvenanceByUnit.get(String(unit.unit_id)) ?? null,
    })),
  };
  const jobsPath = path.join(outputDir, "jobs", `${invocationId}-${route}-attempt-${attempt}.json`);
  const reportPath = path.join(outputDir, "runs", `${invocationId}-${route}-attempt-${attempt}.json`);
  const cohortEventsPath = path.join(
    outputDir,
    "runs",
    `${invocationId}-${route}-attempt-${attempt}-cohorts.jsonl`,
  );
  await atomicWriteJson(jobsPath, jobs);
  const args = [
    runnerPath,
    "--route", route,
    "--jobs", jobsPath,
    "--output-dir", path.join(outputDir, "units", provider),
    "--report", reportPath,
    "--events", cohortEventsPath,
  ];
  args.push(
    "--qwen-reference-audio", policy.primary.reference_audio_path,
    "--qwen-reference-text", policy.primary.reference_text,
  );
  const runnerExecution = await run(python, args, {
    progressJsonlPath: cohortEventsPath,
    onProgressEvent: async (event) => {
      if (event?.schema !== "goldflow_local_tts_cohort_event_v1"
        || event?.event !== "cohort_complete") return;
      if (event.jobs_sha256 !== await sha256File(jobsPath)
        || event.batch_plan_sha256 !== batchPlan.batch_plan_sha256) {
        throw new Error(`Stale Qwen cohort event for ${event.cohort_id ?? "unknown"}`);
      }
      if (typeof onCohortComplete === "function") await onCohortComplete(event);
    },
  });
  const report = await readJson(reportPath, null);
  if (!["passed", "completed_with_job_failures"].includes(report?.status)
    || report.job_count !== units.length
    || report.result_count !== units.length
    || report.synthesis_mode !== synthesisMode
    || report.batch_plan_sha256 !== batchPlan.batch_plan_sha256
    || report.pre_synthesis_gate_sha256 !== preSynthesisGate.gate_sha256
    || report.pre_synthesis_gate_file_sha256 !== preSynthesisGateFileSha256
    || JSON.stringify(report.synthesis_contract)
      !== JSON.stringify(policy.synthesis_contract)) {
    throw new Error(`Invalid ${route} production runner report: ${reportPath}`);
  }
  const expectedModel = policy.primary;
  if (report.provider !== provider
    || report.model_id !== expectedModel.model_id
    || report.model_revision !== expectedModel.model_revision
    || report.effective_concurrency !== EFFECTIVE_CONCURRENCY
    || report.model_load_count !== 1
    || report.resident_model_count !== 1
    || report.model_instance_concurrency !== 1
    || report.continuous_batching !== false
    || report.token_limit_acceptance_allowed !== false
    || Number(report.accepted_token_limit_result_count) !== 0
    || report.voice_id !== policy.primary.voice_id
    || report.voice_sha256 !== policy.primary.voice_sha256
    || report.voice_clone_contract
      !== policy.primary.voice_clone_contract) {
    throw new Error(`Pinned ${route} worker identity mismatch: ${reportPath}`);
  }
  const reportedOrder = (report.results ?? []).map((row) => String(row.unit_id));
  const expectedOrder = units.map((unit) => String(unit.unit_id));
  if (JSON.stringify(reportedOrder) !== JSON.stringify(expectedOrder)
    || JSON.stringify(report.original_order_unit_ids)
      !== JSON.stringify(expectedOrder)
    || report.results_restored_to_original_order !== true) {
    throw new Error(`${route} runner did not restore original narration order`);
  }
  if (batch4Identity
    && synthesisMode === QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.mode) {
    const expectedCohorts = batchPlan.cohorts ?? [];
    const actualCohorts = report.cohort_executions ?? [];
    if (report.reference_audio_preloaded_once !== true
      || actualCohorts.length !== expectedCohorts.length
      || expectedCohorts.some((cohort, index) => {
        const actual = actualCohorts[index];
        return actual?.cohort_id !== cohort.cohort_id
          || actual?.cohort_sha256 !== cohort.cohort_sha256
          || Number(actual?.cohort_index) !== Number(cohort.cohort_index)
          || Number(actual?.nominal_batch_size)
            !== Number(cohort.nominal_batch_size)
          || Number(actual?.effective_batch_size)
            !== Number(cohort.effective_batch_size)
          || Number(actual?.batch_seed) !== Number(cohort.batch_seed)
          || JSON.stringify(actual?.unit_ids ?? [])
            !== JSON.stringify(
              cohort.members.map((member) => member.unit_id),
            );
      })) {
      throw new Error(`${route} runner cohort execution provenance is stale`);
    }
  }
  const resultMap = new Map(report.results.map((row) => [String(row.unit_id), row]));
  for (const unit of units) {
    const result = resultMap.get(unit.unit_id);
    if (!result || result.spoken_text_sha256 !== unit.spoken_text_sha256) {
      throw new Error(`${route} result failed exact spoken-text identity for ${unit.unit_id}`);
    }
    if (result.status === "failed") continue;
    const synthesisIdentity = result.synthesis_identity ?? {};
    if (synthesisIdentity.provider !== provider
      || synthesisIdentity.model_id !== expectedModel.model_id
      || synthesisIdentity.model_revision !== expectedModel.model_revision
      || synthesisIdentity.reference_audio_sha256
        !== policy.primary.reference_audio_sha256
      || synthesisIdentity.reference_text !== policy.primary.reference_text
      || synthesisIdentity.reference_manifest_sha256
        !== policy.primary.reference_manifest_sha256
      || synthesisIdentity.voice !== policy.primary.voice_id
      || synthesisIdentity.voice_sha256 !== policy.primary.voice_sha256
      || synthesisIdentity.voice_continuity_contract
        !== policy.primary.voice_continuity_contract
      || synthesisIdentity.voice_clone_contract
        !== policy.primary.voice_clone_contract
      || synthesisIdentity.native_speed_applied != null
      || synthesisIdentity.post_tts_tempo_processing !== false) {
      throw new Error(`${route} result pin identity mismatch for ${unit.unit_id}`);
    }
    if (batch4Identity
      && (synthesisIdentity.synthesis_mode !== synthesisMode
        || synthesisIdentity.synthesis_contract_id
          !== policy.synthesis_contract.contract_id
        || synthesisIdentity.batch_plan_sha256
          !== batchPlan.batch_plan_sha256)) {
      throw new Error(`${route} result synthesis-mode identity mismatch for ${unit.unit_id}`);
    }
    if (batch4Identity
      && synthesisMode === QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.mode) {
      const expectedBinding = bindingByUnit.get(String(unit.unit_id));
      for (const field of [
        "cohort_id",
        "cohort_index",
        "cohort_sha256",
        "cohort_position",
        "nominal_batch_size",
        "effective_batch_size",
        "batch_seed",
      ]) {
        if (synthesisIdentity[field] !== expectedBinding?.[field]) {
          throw new Error(
            `${route} result cohort identity mismatch for ${unit.unit_id}: ${field}`,
          );
        }
      }
    } else if (batch4Identity
      && synthesisMode === QWEN_LIAM_EXACT_UNIT_RECOVERY_MODE) {
      const expectedRecovery = recoveryProvenanceByUnit.get(String(unit.unit_id));
      if (!expectedRecovery
        || canonicalQwenBatchSha256(synthesisIdentity.recovery_provenance)
          !== canonicalQwenBatchSha256(expectedRecovery)) {
        throw new Error(
          `${route} result exact-unit recovery provenance mismatch for ${unit.unit_id}`,
        );
      }
    }
    const generatedTokenCount = Number(result.generated_token_count);
    const effectiveTokenLimit = Number(result.effective_token_limit);
    if (batch4Identity
      && (result.token_limit_reached !== false
        || !Number.isFinite(generatedTokenCount)
        || !Number.isFinite(effectiveTokenLimit)
        || effectiveTokenLimit <= 0
        || generatedTokenCount >= effectiveTokenLimit)) {
      throw new Error(
        `${route} result reached or lacks a safe generation token limit for ${unit.unit_id}`,
      );
    }
    if (result.output_sha256 !== await sha256File(result.output_path)) {
      throw new Error(`${route} result audio hash mismatch for ${unit.unit_id}`);
    }
  }
  return {
    report,
    reportPath,
    reportSha256: await sha256File(reportPath),
    results: units.map((unit) => resultMap.get(unit.unit_id)),
    cohortEventsPath,
    cohortEventsSha256: await sha256File(cohortEventsPath),
    progressErrors: runnerExecution.progressErrors ?? [],
  };
}

async function applyQwenVoiceContinuityQa({
  rows,
  policy,
  outputDir,
  invocationId,
  attempt,
  similarityPython,
  similarityRunnerPath,
  narrationQualityContract = null,
}) {
  if (!rows.length) return null;
  const reportPath = path.join(
    outputDir,
    "runs",
    `${invocationId}-qwen-voice-continuity-attempt-${attempt}.json`,
  );
  let report = null;
  let executionError = null;
  let referencePaths = [policy.primary.reference_audio_path];
  const calibratedContinuity = Boolean(
    narrationQualityContract?.voice_identity_qa
      ?.universal_absolute_similarity_threshold_forbidden,
  );
  if (narrationQualityContract?.voice_identity_qa?.reference_bank_centroid_required) {
    const referenceManifest = await readJson(
      policy.primary.reference_manifest_path,
      null,
    );
    const bankRows = referenceManifest?.references
      ?? referenceManifest?.reference_variants
      ?? referenceManifest?.samples
      ?? [];
    const bankPaths = bankRows
      .filter((row) => row?.status === "ready" && row?.wav_path)
      .map((row) => path.resolve(row.wav_path));
    if (bankPaths.length >= Number(
      narrationQualityContract.voice_identity_qa.minimum_reference_count ?? 3,
    )) {
      referencePaths = [...new Set(bankPaths)];
    }
  }
  try {
    await run(similarityPython, [
      similarityRunnerPath,
      "--model", policy.primary.speaker_similarity_model_path,
      ...referencePaths.flatMap((referencePath) => ["--reference", referencePath]),
      ...rows.flatMap((row) => ["--candidate", row.wav]),
      "--output", reportPath,
      ...(!calibratedContinuity ? [
        "--minimum-similarity", String(policy.primary.minimum_cosine_similarity),
        "--warning-below-similarity", String(
          policy.primary.warning_below_cosine_similarity,
        ),
      ] : []),
      "--reference-voice-id", policy.primary.reference_voice_id,
      "--reference-voice-sha256", policy.primary.reference_voice_sha256,
      ...(calibratedContinuity ? [
        "--threshold-mode", "reference_leave_one_out",
        "--calibration-hard-margin", "0.05",
        "--calibration-warning-margin", "0",
        "--calibration-aggregate-margin", "0.03",
      ] : []),
    ]);
    report = await readJson(reportPath, null);
  } catch (error) {
    executionError = error instanceof Error ? error.message : String(error);
    // The similarity helper exits non-zero when any candidate falls below its
    // diagnostic threshold, but it still writes a complete hash-bound report.
    // Load that report so automated continuity findings remain review warnings
    // instead of being misclassified as a missing structural artifact.
    report = await readJson(reportPath, null);
  }

  const reportReferences = report?.references ?? [];
  const reportCandidates = report?.candidates ?? [];
  const candidateByHash = new Map(
    reportCandidates
      .filter((candidate) => candidate?.audio_sha256)
      .map((candidate) => [String(candidate.audio_sha256), candidate]),
  );
  const thresholdIdentityValid = calibratedContinuity
    ? report?.threshold_mode === "reference_leave_one_out"
      && Number.isFinite(Number(report?.minimum_cosine_similarity))
      && Number.isFinite(Number(report?.warning_below_cosine_similarity))
      && Number.isFinite(Number(
        report?.calibration?.reference_leave_one_out_floor,
      ))
      && Number(report.minimum_cosine_similarity)
        < Number(report.warning_below_cosine_similarity)
    : Number(report?.minimum_cosine_similarity)
        === Number(policy.primary.minimum_cosine_similarity)
      && Number(report?.warning_below_cosine_similarity)
        === Number(policy.primary.warning_below_cosine_similarity);
  const reportIdentityValid = Boolean(
    report
    && report.schema === "goldflow_tts_voice_continuity_qa_v1"
    && report.method === policy.primary.speaker_similarity_method
    && report.model_sha256 === policy.primary.speaker_similarity_model_sha256
    && thresholdIdentityValid
    && report.reference_voice_id === policy.primary.reference_voice_id
    && report.reference_voice_sha256 === policy.primary.reference_voice_sha256
    && reportReferences.length === referencePaths.length
    && reportReferences.every((reference, index) => (
      path.resolve(reference.audio_path) === path.resolve(referencePaths[index])
    ))
    && reportCandidates.length === rows.length
  );
  for (const row of rows) {
    const audioSha256 = row.unit_qa?.audio_sha256 ?? null;
    const candidate = candidateByHash.get(String(audioSha256)) ?? null;
    const continuityQa = candidate
      ? {
          ...candidate,
          schema: "goldflow_tts_voice_continuity_unit_qa_v1",
          reference_voice_id: report.reference_voice_id,
          reference_voice_sha256: report.reference_voice_sha256,
          reference_audio_sha256:
            reportReferences.length === 1
              ? reportReferences[0]?.audio_sha256 ?? null
              : null,
          reference_audio_sha256s: reportReferences.map((row) => row.audio_sha256),
          reference_count: reportReferences.length,
          reference_policy: reportReferences.length > 1
            ? "owned_voice_bank_embedding_centroid"
            : "single_selected_style_reference",
          similarity_method: report.method,
          similarity_model_sha256: report.model_sha256,
          similarity_calibration_sha256:
            policy.primary.speaker_similarity_calibration_sha256,
          warning_below_cosine_similarity:
            report.warning_below_cosine_similarity,
          threshold_mode: report.threshold_mode ?? "fixed",
          reference_leave_one_out_calibration:
            report.reference_calibration ?? [],
          reference_leave_one_out_floor:
            report.calibration?.reference_leave_one_out_floor ?? null,
          aggregate_voice_similarity:
            report.candidate_aggregate ?? null,
          aggregate_status: report.aggregate_status ?? null,
          voice_continuity_contract: policy.primary.voice_continuity_contract,
          report_path: reportPath,
          report_sha256: await sha256File(reportPath),
        }
      : null;
    const decision = voiceContinuityDecision(
      reportIdentityValid ? continuityQa : null,
      {
        audioSha256,
        referenceVoiceId: policy.primary.voice_id,
        referenceVoiceSha256: policy.primary.voice_sha256,
        similarityModelSha256: policy.primary.speaker_similarity_model_sha256,
        minimumCosineSimilarity: calibratedContinuity
          ? report?.minimum_cosine_similarity
          : policy.primary.minimum_cosine_similarity,
        warningBelowCosineSimilarity:
          calibratedContinuity
            ? report?.warning_below_cosine_similarity
            : policy.primary.warning_below_cosine_similarity,
      },
    );
    if (calibratedContinuity && report?.aggregate_status === "blocked") {
      decision.findings.push({
        severity: "warning",
        code: "tts_primary_voice_aggregate_below_calibrated_floor",
        aggregate: report.candidate_aggregate ?? null,
        aggregate_minimum_cosine_similarity:
          report.aggregate_minimum_cosine_similarity ?? null,
        review_required: true,
        automatic_retry_allowed: false,
      });
    }
    if (!reportIdentityValid) {
      decision.findings.push({
        severity: "blocker",
        code: "tts_primary_voice_continuity_report_identity_invalid",
        report_path: reportPath,
        execution_error: executionError,
      });
      decision.status = "blocked";
    }
    row.unit_qa.voice_continuity = continuityQa;
    row.unit_qa.findings = [
      ...(row.unit_qa.findings ?? []),
      ...decision.findings,
    ];
    if (decision.status !== "passed") {
      row.unit_qa.status = "blocked";
    } else if (decision.findings.some(
      (finding) => finding.severity === "warning",
    ) && row.unit_qa.status === "passed") {
      row.unit_qa.status = "passed_with_warnings";
    }
  }
  return {
    report,
    reportPath,
    reportIdentityValid,
    executionError,
  };
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const channel = flags.channel ?? "53rebirth";
  const week = flags.week ?? "current";
  const episode = flags.episode ?? "ep_01";
  const episodeDir = path.resolve(
    flags["episode-dir"]
      ?? flags.episodeDir
      ?? path.join(DATA_ROOT, "channels", channel, "weekly_runs", week, "episodes", episode),
  );
  const planPath = path.resolve(
    flags.plan ?? path.join(episodeDir, "narration_generation_plan.json"),
  );
  const identityPath = path.resolve(
    flags.identity ?? path.join(episodeDir, "run_identity.json"),
  );
  const preSynthesisGatePath = path.join(
    episodeDir,
    `narration_tts_pre_synthesis_gate_${episode}.json`,
  );
  const [episodeStat, identityStat] = await Promise.all([
    fs.stat(episodeDir).catch(() => null),
    fs.stat(identityPath).catch(() => null),
  ]);
  if (!episodeStat?.isDirectory() || !identityStat?.isFile()) {
    throw new Error(
      "Narration TTS requires an existing episode directory and run_identity.json before gate bootstrap.",
    );
  }
  const priorPreSynthesisGate = await readJson(preSynthesisGatePath, null);
  const bootstrapGate = buildNarrationPreSynthesisBootstrapGate({
    episodeDir,
    identityPath,
    priorGate: priorPreSynthesisGate,
  });
  await atomicWriteJson(preSynthesisGatePath, bootstrapGate);
  const historicalSynthesisAuthorized =
    bootstrapGate.historical_synthesis_authorized;
  const scriptPath = path.resolve(
    flags.script ?? path.join(episodeDir, "script_clean.md"),
  );
  const outputDir = path.resolve(
    flags["output-dir"] ?? path.join(episodeDir, "assets/audio/narration_tts"),
  );
  const python = path.resolve(flags.python ?? process.env.ANIFACTORY_LOCAL_TTS_PYTHON ?? DEFAULT_PYTHON);
  const runnerPath = path.resolve(
    flags.runner ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "tts-local-production-runner.py"),
  );
  const similarityPython = path.resolve(
    flags["similarity-python"]
      ?? process.env.ANIFACTORY_TTS_SIMILARITY_PYTHON
      ?? DEFAULT_SIMILARITY_PYTHON,
  );
  const similarityRunnerPath = path.resolve(
    flags["similarity-runner"]
      ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "tts-speaker-similarity.py"),
  );
  const dryRun = boolFlag(flags["dry-run"]);
  const planOnly = boolFlag(flags["plan-only"]);
  const requestedConcurrency = Number(flags.concurrency ?? EFFECTIVE_CONCURRENCY);
  if (!Number.isInteger(requestedConcurrency)
    || requestedConcurrency !== EFFECTIVE_CONCURRENCY) {
    throw new Error(
      `Local narration TTS is production-locked to --concurrency ${EFFECTIVE_CONCURRENCY}; `
      + `got ${flags.concurrency ?? "<invalid>"}. Parallel model copies are forbidden.`,
    );
  }
  const requestedBatchSize = flags["batch-size"] == null
    ? null
    : Number(flags["batch-size"]);
  const invocationId = `${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${process.pid}`;
  const reportPath = path.join(episodeDir, `narration_tts_report_${episode}.json`);
  const unitQaPath = path.join(episodeDir, `narration_tts_unit_qa_${episode}.json`);
  const fullQaPath = path.join(episodeDir, `narration_full_stream_qa_${episode}.json`);
  const stitchReportPath = path.join(episodeDir, `audio_stitch_report_${episode}-narration.json`);
  const eventsPath = path.join(episodeDir, "narration_tts_attempt_events.jsonl");

  const [identity, plan, scriptBuffer] = await Promise.all([
    readJson(identityPath, null),
    readJson(planPath, null),
    fs.readFile(scriptPath),
  ]);
  if (!identity || !plan) throw new Error("Missing locked run_identity.json or narration_generation_plan.json");
  const [identityFileSha256, planFileSha256] = await Promise.all([
    sha256File(identityPath),
    sha256File(planPath),
  ]);
  const planSha256 = String(plan.plan_sha256 ?? planFileSha256);
  const narrationQualityContract = narrationQualityContractForIdentity(identity);
  const narrationQualityV2 = Boolean(narrationQualityContract);
  const scriptHash = createHash("sha256").update(scriptBuffer).digest("hex");
  const runIdentityBindingFinding = narrationPlanRunIdentityBindingFinding(
    plan,
    identity,
    identityFileSha256,
  );
  const sourceArtifactHashes = {};
  if (plan.schema === "goldflow_tts_generation_plan_v2") {
    const planSourceHashes = plan.source_hashes ?? {};
    for (const [field, sourcePath] of [
      ["script_clean_sha256", scriptPath],
      [
        "script_speakability_report_sha256",
        path.join(episodeDir, "script_speakability_report.json"),
      ],
      [
        "tts_spoken_overrides_sha256",
        path.join(episodeDir, "tts_spoken_overrides.json"),
      ],
    ]) {
      const expectedHash = String(planSourceHashes[field] ?? "").trim();
      const actualHash = await sha256File(sourcePath).catch(() => null);
      sourceArtifactHashes[field] = actualHash;
      void expectedHash;
    }
  }
  const performanceApprovalPath = path.resolve(
    flags["performance-bakeoff-approval"]
      ?? path.join(episodeDir, "narration_performance_bakeoff_approval.json"),
  );
  const performanceApproval = await readJson(performanceApprovalPath, null);
  const performanceGate = validateNarrationPerformanceGateForTests({
    plan,
    approval: performanceApproval,
  });
  const policy = validateNarrationTtsPolicyForTests(identity);
  const planPolicy = policy.status === "passed"
    ? validateNarrationPlanPolicyForTests(plan, policy)
    : {
        status: "blocked",
        findings: policy.findings ?? [],
      };
  const referenceAssetHashes = {};
  if (policy.status === "passed") {
    referenceAssetHashes.reference_audio = {
      path: policy.primary.reference_audio_path,
      expected: policy.primary.reference_audio_sha256,
      actual: await sha256File(policy.primary.reference_audio_path).catch(() => null),
    };
    referenceAssetHashes.reference_text = {
      path: null,
      expected: policy.primary.reference_text_sha256,
      actual: sha256Text(policy.primary.reference_text),
    };
  }
  for (const [assetPath, expectedSha256, label] of policy.status === "passed" ? [
    [
      policy.primary.reference_manifest_path,
      policy.primary.reference_manifest_sha256,
      "reference manifest",
    ],
    [
      policy.primary.reference_metadata_path,
      policy.primary.reference_metadata_sha256,
      "reference metadata",
    ],
    [
      policy.primary.speaker_similarity_model_path,
      policy.primary.speaker_similarity_model_sha256,
      "speaker-similarity model",
    ],
    [
      policy.primary.speaker_similarity_calibration_path,
      policy.primary.speaker_similarity_calibration_sha256,
      "speaker-similarity calibration",
    ],
  ] : []) {
    referenceAssetHashes[label.replaceAll(/[^a-z0-9]+/giu, "_")] = {
      path: assetPath,
      expected: expectedSha256,
      actual: await sha256File(assetPath).catch(() => null),
    };
  }
  const calibratedSimilarityLockValid = policy.status === "passed" && (narrationQualityContract
    ? policy.primary.minimum_cosine_similarity == null
      && policy.primary.warning_below_cosine_similarity == null
      && policy.primary.warning_floor_cosine_similarity == null
      && policy.primary.similarity_threshold_source
        === narrationQualityContract.voice_identity_qa.threshold_source
      && policy.primary.universal_absolute_similarity_threshold_forbidden === true
      && policy.primary.reference_bank_centroid_required === true
    : Number(policy.primary.minimum_cosine_similarity)
        === QWEN_LIAM_MINIMUM_COSINE_SIMILARITY
      && Number(policy.primary.warning_below_cosine_similarity)
        === QWEN_LIAM_WARNING_BELOW_COSINE_SIMILARITY
      && Number(policy.primary.warning_floor_cosine_similarity)
        === QWEN_LIAM_WARNING_BELOW_COSINE_SIMILARITY);
  const selectedVoiceLock = policy.status === "passed"
    ? qwenPinForVoiceId(
        policy.primary.voice_id,
        policy.primary.reference_variant_id ?? null,
      )
    : null;
  if (policy.status === "passed" && (policy.primary.reference_voice_id !== policy.primary.voice_id
    || policy.primary.reference_voice_sha256 !== policy.primary.voice_sha256
    || policy.primary.voice_continuity_contract
      !== selectedVoiceLock?.voice_continuity_contract
    || !calibratedSimilarityLockValid)) {
    planPolicy.findings.push({
      code: "narration_tts_selected_voice_continuity_lock_mismatch",
    });
    planPolicy.status = "blocked";
  }
  if (runIdentityBindingFinding) {
    planPolicy.findings.push(runIdentityBindingFinding);
    planPolicy.status = "blocked";
  }
  const narrationTextIrPath = path.resolve(
    plan?.narration_text_ir?.path
      ?? path.join(episodeDir, "narration_text_ir.json"),
  );
  const spokenTextAuditPath = path.resolve(
    plan?.tts_spoken_text_audit?.path
      ?? path.join(episodeDir, `tts_spoken_text_audit_${episode}.json`),
  );
  const [narrationTextIr, narrationTextIrFileSha256, spokenTextAudit,
    spokenTextAuditFileSha256] = await Promise.all([
    readJson(narrationTextIrPath, null),
    sha256File(narrationTextIrPath).catch(() => null),
    readJson(spokenTextAuditPath, null),
    sha256File(spokenTextAuditPath).catch(() => null),
  ]);
  const rawPlanUnits = Array.isArray(plan?.units) && plan.units.length
    ? plan.units
    : (plan?.segments ?? []).flatMap((segment) => (
        segment?.generation_units
        ?? segment?.narration_generation_units
        ?? segment?.tts_generation_units
        ?? segment?.qwen_generation_units
        ?? []
      ));
  const rawRequestedUnitIds = String(
    flags["confirmed-retry-unit-ids"] ?? flags["regenerate-unit-ids"] ?? "",
  ).split(",").map((value) => value.trim()).filter(Boolean);
  const preliminarySynthesisScope = {
    mode: rawRequestedUnitIds.length
      ? "confirmed_exact_unit_retry_pending_evidence_validation"
      : String(flags["manual-review-evidence"] ?? "").trim()
        ? "hash_bound_manual_accept_pending_evidence_validation"
        : dryRun || planOnly
          ? "plan_validation_only"
          : "initial_or_interrupted_full_synthesis",
    authorized_synthesis_unit_ids: rawRequestedUnitIds.length
      ? rawRequestedUnitIds
      : dryRun || planOnly || String(flags["manual-review-evidence"] ?? "").trim()
        ? []
        : rawPlanUnits.map((unit) => String(unit?.unit_id ?? "")),
    preserved_unit_ids: [],
  };
  const gateInputs = {
    plan,
    planPath,
    planFileSha256,
    identityPath,
    identityFileSha256,
    scriptPath,
    scriptSha256: scriptHash,
    policy,
    planPolicy,
    sourceArtifactHashes,
    textIr: narrationTextIr,
    textIrPath: narrationTextIrPath,
    textIrFileSha256: narrationTextIrFileSha256,
    spokenTextAudit,
    spokenTextAuditPath,
    spokenTextAuditFileSha256,
    overridesSha256: sourceArtifactHashes.tts_spoken_overrides_sha256 ?? null,
    referenceAssetHashes,
    historicalSynthesisAuthorized,
  };
  let preSynthesisGate = buildNarrationPreSynthesisGate({
    ...gateInputs,
    synthesisScope: preliminarySynthesisScope,
  });
  await atomicWriteJson(preSynthesisGatePath, preSynthesisGate);
  if (preSynthesisGate.gate_sha256
      !== narrationPreSynthesisGateSha256(preSynthesisGate)
    || preSynthesisGate.status !== "passed") {
    throw new Error(
      `Narration pre-synthesis gate blocked before helper import/model load: ${JSON.stringify(preSynthesisGate.findings)}`,
    );
  }
  if (performanceGate.status === "blocked") {
    throw new Error(
      "Full narration synthesis requires a human-approved short performance "
      + `bakeoff for this exact voice/reference/synthesis contract: ${JSON.stringify(performanceGate.findings)}. `
      + `Expected ${performanceApprovalPath}`,
    );
  }
  if (performanceGate.required) {
    for (const sample of performanceApproval.samples ?? []) {
      const samplePath = path.resolve(sample.audio_path);
      const actualSampleSha256 = await sha256File(samplePath).catch(() => null);
      if (!actualSampleSha256 || actualSampleSha256 !== sample.audio_sha256) {
        throw new Error(
          `Narration performance bakeoff sample is missing or stale: ${samplePath}`,
        );
      }
    }
  }
  const units = normalizeNarrationUnitsForTests(plan, {
    voiceId: policy.primary.voice_id,
    referenceVariantId: policy.primary.reference_variant_id ?? null,
  });
  const expectedBatchSize = Number(
    policy.synthesis_contract?.nominal_batch_size ?? 1,
  );
  if (requestedBatchSize != null
    && (!Number.isInteger(requestedBatchSize)
      || requestedBatchSize !== expectedBatchSize)) {
    throw new Error(
      `Local narration TTS is identity-locked to --batch-size ${expectedBatchSize}; `
      + `got ${flags["batch-size"] ?? "<invalid>"}.`,
    );
  }
  let batchPlan = null;
  if (policy.synthesis_contract?.mode
    === QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.mode) {
    const batchValidation = validateQwenLiamBatchPlan(
      plan.qwen_liam_batch_plan,
      units,
      policy.synthesis_contract,
    );
    if (batchValidation.status !== "passed") {
      throw new Error(
        `Narration plan deterministic batch-four contract failed: ${JSON.stringify(batchValidation.findings)}`,
      );
    }
    const expectedBindings = qwenBatchBindingByUnit(batchValidation.expected);
    const staleUnit = units.find((unit) => (
      JSON.stringify(unit.synthesis_cohort ?? null)
      !== JSON.stringify(expectedBindings.get(String(unit.unit_id)) ?? null)
    ));
    if (staleUnit) {
      throw new Error(
        `Narration unit ${staleUnit.unit_id} has a stale synthesis cohort binding.`,
      );
    }
    batchPlan = batchValidation.expected;
  } else {
    batchPlan = buildQwenLiamBatchPlan(
      units,
      policy.synthesis_contract,
    );
  }
  const requestedRecoveryScope = recoveryScopeForTests(
    flags["confirmed-retry-unit-ids"] ?? flags["regenerate-unit-ids"],
    units,
  );
  const manualReviewEvidencePath = String(
    flags["manual-review-evidence"] ?? "",
  ).trim()
    ? path.resolve(flags["manual-review-evidence"])
    : null;
  const stitchRepairTailUnitIds = String(
    flags["stitch-repair-tail-unit-ids"] ?? "",
  ).split(",").map((value) => value.trim()).filter(Boolean);
  const skipRenderedTranscriptQa = boolFlag(
    flags["skip-rendered-transcript-qa"],
  );
  const workflowBypass = boolFlag(flags["workflow-bypass"]);
  validateManualStitchRecoveryForTests({
    manualReviewEvidencePath,
    repairTailUnitIds: stitchRepairTailUnitIds,
    skipRenderedTranscriptQa,
    workflowBypass,
    validatedReview: null,
  });
  if (manualReviewEvidencePath && requestedRecoveryScope) {
    throw new Error(
      "--manual-review-evidence and --confirmed-retry-unit-ids are mutually exclusive. "
      + "Accept reviewed first takes or retry confirmed defects in separate guarded calls.",
    );
  }
  if (requestedRecoveryScope && !String(
    flags["confirmed-retry-evidence"] ?? "",
  ).trim()) {
    throw new Error(
      "--confirmed-retry-unit-ids requires --confirmed-retry-evidence <json> "
      + "recording the audible skip, truncation, or stutter that was confirmed.",
    );
  }
  const priorNarrationReportBuffer = await fs.readFile(reportPath).catch(() => null);
  const priorUnitQaBuffer = await fs.readFile(unitQaPath).catch(() => null);
  const priorNarrationReport = priorNarrationReportBuffer
    ? JSON.parse(priorNarrationReportBuffer.toString("utf8"))
    : null;
  const priorNarrationReportSha256 = priorNarrationReportBuffer
    ? createHash("sha256").update(priorNarrationReportBuffer).digest("hex")
    : null;
  const priorUnitQa = priorUnitQaBuffer
    ? JSON.parse(priorUnitQaBuffer.toString("utf8"))
    : null;
  const priorUnitQaSha256 = priorUnitQaBuffer
    ? createHash("sha256").update(priorUnitQaBuffer).digest("hex")
    : null;
  if (!priorNarrationReport || !priorUnitQa) {
    const orphanedUnitFiles = (await filesBelow(
      path.join(outputDir, "units"),
    )).filter((filePath) => /\.(?:wav|json)$/iu.test(filePath));
    if (orphanedUnitFiles.length) {
      throw new Error(
        "Found TTS unit outputs without the exact prior narration report and unit-QA report. "
        + "Interrupted synthesis is fail-closed so accepted audio cannot be silently regenerated; "
        + `triage these ${orphanedUnitFiles.length} artifacts before another model load.`,
      );
    }
  }
  let preservationValidation = null;
  let preservedCandidates = [];
  if (priorNarrationReport && priorUnitQa) {
    preservationValidation = preservedTtsSelectionsForTests({
      units,
      priorReport: priorNarrationReport,
      priorUnitQa,
      policy,
      canonicalPlanSha256: planSha256,
      planFileSha256,
      requestedUnitIds: [],
      requireAllUnrequested: false,
    });
    if (preservationValidation.status !== "passed") {
      throw new Error(
        "Existing narration selections are stale; refusing to load Qwen or overwrite audio: "
        + JSON.stringify(preservationValidation.findings),
      );
    }
    preservedCandidates = await hydratePreservedTtsSelections({
      selectionValidation: preservationValidation,
      policy,
      batchPlan,
    });
  }
  if ((requestedRecoveryScope || manualReviewEvidencePath)
    && (!priorNarrationReport || !priorUnitQa)) {
    throw new Error(
      "Scoped narration recovery requires the exact prior narration report and unit-QA report.",
    );
  }
  const requestedRecoveryIds = new Set(
    requestedRecoveryScope?.requested_unit_ids?.map(String) ?? [],
  );
  let confirmedRetryEvidencePath = null;
  let confirmedRetryEvidenceSha256 = null;
  let validatedConfirmedRetryEvidence = [];
  if (requestedRecoveryScope) {
    confirmedRetryEvidencePath = path.resolve(flags["confirmed-retry-evidence"]);
    const evidenceBuffer = await fs.readFile(confirmedRetryEvidencePath);
    const evidence = JSON.parse(evidenceBuffer.toString("utf8"));
    confirmedRetryEvidenceSha256 = createHash("sha256")
      .update(evidenceBuffer)
      .digest("hex");
    validatedConfirmedRetryEvidence = validateConfirmedRetryEvidenceForTests({
      evidence,
      requestedUnitIds: requestedRecoveryScope.requested_unit_ids,
      planSha256,
      priorReport: priorNarrationReport,
      priorReportSha256: priorNarrationReportSha256,
      currentCandidates: preservedCandidates,
    });
  }
  const finalSynthesisScope = narrationSynthesisScopeForTests({
    units,
    preservedCandidates,
    requestedRecoveryScope,
    manualReviewEvidencePath,
    evidencePath: requestedRecoveryScope
      ? confirmedRetryEvidencePath
      : manualReviewEvidencePath,
    evidenceSha256: requestedRecoveryScope
      ? confirmedRetryEvidenceSha256
      : manualReviewEvidencePath
        ? await sha256File(manualReviewEvidencePath).catch(() => null)
        : null,
  });
  const preservedForInvocation = preservedCandidates.filter((candidate) => (
    finalSynthesisScope.preserved_unit_ids.includes(String(candidate.unit_id))
  ));
  const alreadyComplete = finalSynthesisScope.mode
    === "already_complete_no_synthesis_authorized";
  if (finalSynthesisScope.mode
    === "interrupted_full_synthesis_resume_preserving_accepted_units") {
    const previouslySubmittedIds = new Set(
      (priorUnitQa?.candidates ?? []).map((candidate) => String(candidate?.unit_id ?? "")),
    );
    const unsafeResumeIds = finalSynthesisScope.authorized_synthesis_unit_ids
      .filter((unitId) => previouslySubmittedIds.has(String(unitId)));
    if (unsafeResumeIds.length) {
      throw new Error(
        "Interrupted resume may synthesize only never-submitted units. "
        + `These units already have candidate provenance and require exact repair triage: ${unsafeResumeIds.join(", ")}`,
      );
    }
  }
  preSynthesisGate = buildNarrationPreSynthesisGate({
    ...gateInputs,
    synthesisScope: finalSynthesisScope,
  });
  await atomicWriteJson(preSynthesisGatePath, preSynthesisGate);
  let preSynthesisGateFileSha256 = await sha256File(preSynthesisGatePath);
  if (preSynthesisGate.gate_sha256
      !== narrationPreSynthesisGateSha256(preSynthesisGate)
    || preSynthesisGate.status !== "passed") {
    throw new Error(
      `Narration pre-synthesis gate blocked before helper import/model load: ${JSON.stringify(preSynthesisGate.findings)}`,
    );
  }
  if (alreadyComplete) {
    throw new Error(
      "Narration TTS already has an exact accepted selection for every current unit. "
      + "An unscoped full rerun is forbidden; use exact unit or boundary repair evidence.",
    );
  }
  if (!manualReviewEvidencePath) {
    const [pythonStat, runnerStat, similarityPythonStat, similarityRunnerStat] = await Promise.all([
      fs.stat(python).catch(() => null),
      fs.stat(runnerPath).catch(() => null),
      fs.stat(similarityPython).catch(() => null),
      fs.stat(similarityRunnerPath).catch(() => null),
    ]);
    if (!pythonStat?.isFile()) throw new Error(`Pinned local TTS Python is missing: ${python}`);
    if (!runnerStat?.isFile()) throw new Error(`Local TTS production runner is missing: ${runnerPath}`);
    if (!similarityPythonStat?.isFile()) {
      throw new Error(`Pinned speaker-similarity Python is missing: ${similarityPython}`);
    }
    if (!similarityRunnerStat?.isFile()) {
      throw new Error(`Speaker-similarity runner is missing: ${similarityRunnerPath}`);
    }
  }
  const initialRecoveryScope = finalSynthesisScope;
  const validation = {
    schema: "goldflow_narration_tts_plan_validation_v1",
    status: "validated_plan_only_not_synthesized",
    production_stage_passed: false,
    source_script_hash: scriptHash,
    run_identity_path: identityPath,
    narration_generation_plan_path: planPath,
    narration_generation_plan_sha256: planSha256,
    narration_generation_plan_file_sha256: planFileSha256,
    unit_count: units.length,
    unit_ids: units.map((unit) => unit.unit_id),
    effective_concurrency: EFFECTIVE_CONCURRENCY,
    synthesis_contract: policy.synthesis_contract,
    batch_plan_sha256: batchPlan.batch_plan_sha256,
    model_load_policy: manualReviewEvidencePath
      ? "manual_review_existing_candidates_no_model_load"
      : policy.synthesis_contract.mode
        === QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.mode
        ? "once_per_resident_fixed_batch_invocation"
        : "once_per_serial_qwen_attempt_invocation",
    recovery_scope: initialRecoveryScope,
    runtime_preflight: {
      status: manualReviewEvidencePath
        ? "manual_review_existing_candidates_no_synthesis_runtime_required"
        : "launcher_paths_validated_models_not_loaded",
      python_path: manualReviewEvidencePath ? null : python,
      runner_path: manualReviewEvidencePath ? null : runnerPath,
      similarity_python_path: manualReviewEvidencePath ? null : similarityPython,
      similarity_runner_path: manualReviewEvidencePath ? null : similarityRunnerPath,
      model_pins_checked_during_plan_only: false,
    },
    policy,
    plan_policy: planPolicy,
    performance_gate: performanceGate,
    performance_bakeoff_approval_path: performanceApprovalPath,
    pre_synthesis_gate_path: preSynthesisGatePath,
    pre_synthesis_gate_file_sha256: preSynthesisGateFileSha256,
    pre_synthesis_gate_sha256: preSynthesisGate.gate_sha256,
  };
  if (dryRun || planOnly) {
    const validationPath = path.join(
      episodeDir,
      `narration_tts_plan_validation_${episode}.json`,
    );
    await atomicWriteJson(validationPath, validation);
    console.log(JSON.stringify({
      status: validation.status,
      production_stage_passed: false,
      unit_count: units.length,
      validation_path: validationPath,
    }, null, 2));
    return;
  }

  await fs.mkdir(outputDir, { recursive: true });

  // The shared QA/stitch module reads these exact settings from process.argv at
  // import time. Insert defaults only when the operator did not supply them.
  const ensureArg = (name, value) => {
    if (!process.argv.includes(name)) process.argv.push(name, String(value));
  };
  const ensureExactNumericArg = (name, key, value) => {
    if (flags[key] != null && Math.abs(Number(flags[key]) - value) > 0.000001) {
      throw new Error(`${name} is production-locked to ${value}; got ${flags[key]}`);
    }
    ensureArg(name, value);
  };
  ensureArg("--episode-dir", episodeDir);
  ensureArg("--outDir", "narration_tts");
  ensureExactNumericArg("--stitch-sample-rate", "stitch-sample-rate", SAMPLE_RATE);
  if (!narrationQualityContract) {
    ensureExactNumericArg("--unit-gap-sec", "unit-gap-sec", UNIT_GAP_SEC);
    ensureExactNumericArg("--segment-gap-sec", "segment-gap-sec", SEGMENT_GAP_SEC);
    ensureExactNumericArg("--stitch-edge-pad-sec", "stitch-edge-pad-sec", EDGE_PAD_SEC);
    ensureExactNumericArg("--stitch-fade-sec", "stitch-fade-sec", FADE_SEC);
  }
  if (flags["unit-transcript-qa"] != null
    && !/^(?:0|false|no|off)$/i.test(String(flags["unit-transcript-qa"]))) {
    throw new Error(
      "--unit-transcript-qa is production-locked off; transcript review "
      + "comes from the required final local Whisper timing stage.",
    );
  }
  ensureArg("--unit-transcript-qa", "false");
  if (flags["unit-qa-whisper-model"] != null
    && String(flags["unit-qa-whisper-model"]) !== "small") {
    throw new Error("--unit-qa-whisper-model is production-locked to small");
  }
  ensureArg("--unit-qa-whisper-model", "small");
  if (!manualReviewEvidencePath) {
    preSynthesisGate = authorizeNarrationPreSynthesisGate(preSynthesisGate);
    await atomicWriteJson(preSynthesisGatePath, preSynthesisGate);
    preSynthesisGateFileSha256 = await sha256File(preSynthesisGatePath);
  }
  const helpers = await import("./modelslab-qwen-episode-audio.mjs");

  const previousQa = priorUnitQa ?? await readJson(unitQaPath, null);
  const previousQaByAudioHash = new Map(
    (previousQa?.candidates ?? []).flatMap((candidate) => (
      candidate?.qa?.audio_sha256 ? [[candidate.qa.audio_sha256, candidate.qa]] : []
    )),
  );
  const prefetchedQaByAudioHash = new Map();
  const pipelinedQaEvents = [];
  const candidates = [];
  const attemptEvents = [];
  const synthesisRuns = [];
  const selected = new Map();
  const existingCandidateRow = (unit, candidate, unitQa) => (
    preservedSelectionRow(unit, candidate, unitQa, policy)
  );
  if (!manualReviewEvidencePath) {
    const preservedFinalInputs = preservedTtsFinalInputsForTests({
      units,
      candidatePool: preservedCandidates,
      preservedForInvocation,
      priorSynthesisRuns: priorNarrationReport?.synthesis_runs ?? [],
      policy,
    });
    candidates.push(...preservedFinalInputs.candidates);
    synthesisRuns.push(...preservedFinalInputs.synthesisRuns);
    for (const row of preservedFinalInputs.selectedRows) {
      selected.set(String(row.unit_id), row);
    }
  }

  const qaSynthesis = async (
    route,
    attempt,
    targetUnits,
    {
      synthesisMode,
      recoveryProvenanceByUnit = new Map(),
    } = {},
  ) => {
    const provider = PRIMARY_TTS_PROVIDER;
    const targetUnitById = new Map(
      targetUnits.map((unit) => [String(unit.unit_id), unit]),
    );
    const prefetchCohortQa = async (event) => {
      const qaStartedAtMs = Date.now();
      const rows = (event.results ?? []).flatMap((result) => {
        if (result?.status === "failed" || !result?.output_path || !result?.output_sha256) {
          return [];
        }
        const unit = targetUnitById.get(String(result.unit_id));
        if (!unit) return [];
        return [{
          ...unit,
          text: unit.spoken_text,
          segment_id: unit.segment_id
            ?? unit.source_segment_ids?.[0]
            ?? unit.inherited_segment_id
            ?? unit.unit_id,
          speaker: unit.speaker ?? "NARRATOR",
          voice_id: policy.primary.voice_id,
          provider,
          model_id: result.model_id,
          attempt,
          wav: result.output_path,
          duration_sec: result.duration_sec,
          synthesis_identity: result.synthesis_identity,
          synthesis_identity_sha256: result.synthesis_identity_sha256,
          unit_qa: previousQaByAudioHash.get(result.output_sha256)
            ?? prefetchedQaByAudioHash.get(result.output_sha256)
            ?? null,
        }];
      });
      try {
        await helpers.runUnitOutputQaForDiagnostics(rows);
        applyProtectedTermQa(rows);
        for (const row of rows) {
          row.unit_qa = softenPrimaryQa(row.unit_qa);
          if (row.unit_qa?.audio_sha256) {
            prefetchedQaByAudioHash.set(row.unit_qa.audio_sha256, row.unit_qa);
          }
        }
        pipelinedQaEvents.push({
          schema: "goldflow_narration_pipelined_cohort_qa_event_v1",
          status: "passed",
          attempt,
          cohort_id: event.cohort_id,
          cohort_sha256: event.cohort_sha256,
          cohort_index: event.cohort_index ?? null,
          cohort_recorded_at_unix_ms: event.recorded_at_unix_ms ?? null,
          qa_started_at_unix_ms: qaStartedAtMs,
          qa_completed_at_unix_ms: Date.now(),
          unit_count: rows.length,
          audio_sha256s: rows.map((row) => row.unit_qa?.audio_sha256).filter(Boolean),
          qa_scope: "waveform_and_enabled_unit_diagnostics_only",
          full_stream_qa_still_required: true,
        });
      } catch (error) {
        pipelinedQaEvents.push({
          schema: "goldflow_narration_pipelined_cohort_qa_event_v1",
          status: "failed_nonblocking_prefetch",
          attempt,
          cohort_id: event.cohort_id,
          cohort_sha256: event.cohort_sha256,
          cohort_index: event.cohort_index ?? null,
          cohort_recorded_at_unix_ms: event.recorded_at_unix_ms ?? null,
          qa_started_at_unix_ms: qaStartedAtMs,
          qa_completed_at_unix_ms: Date.now(),
          unit_count: rows.length,
          error: error instanceof Error ? error.message : String(error),
          final_serial_qa_still_required: true,
        });
        throw error;
      }
    };
    let synthesis;
    try {
      synthesis = await runSynthesis({
        route,
        attempt,
        units: targetUnits,
        policy,
        batchPlan,
        synthesisMode,
        recoveryProvenanceByUnit,
        outputDir,
        python,
        runnerPath,
        invocationId,
        preSynthesisGate,
        preSynthesisGatePath,
        preSynthesisGateFileSha256,
        planPath,
        planSha256,
        planFileSha256,
        identityPath,
        identityFileSha256,
        scriptPath,
        scriptSha256: scriptHash,
        onCohortComplete: prefetchCohortQa,
      });
    } catch (error) {
      for (const unit of targetUnits) {
        const event = {
          schema: "goldflow_narration_tts_attempt_event_v1",
          invocation_id: invocationId,
          recorded_at: new Date().toISOString(),
          unit_id: unit.unit_id,
          provider,
          attempt,
          seed: deterministicTtsSeed(unit.unit_id, provider, attempt),
          spoken_text_sha256: unit.spoken_text_sha256,
          status: "synthesis_failed",
          error: error instanceof Error ? error.message : String(error),
        };
        attemptEvents.push(event);
        await fs.appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
      }
      throw error;
    }
    const attemptPipelineEvents = pipelinedQaEvents
      .filter((event) => Number(event.attempt) === Number(attempt))
      .sort((left, right) => Number(left.cohort_index) - Number(right.cohort_index))
      .map((event, index, events) => ({
        ...event,
        next_cohort_completed_before_qa: Number.isFinite(Number(
          events[index + 1]?.cohort_recorded_at_unix_ms,
        ))
          ? Number(events[index + 1].cohort_recorded_at_unix_ms)
            <= Number(event.qa_completed_at_unix_ms)
          : false,
      }));
    synthesisRuns.push({
      attempt,
      synthesis_mode: synthesisMode,
      report_path: synthesis.reportPath,
      report_sha256: synthesis.reportSha256,
      batch_plan_sha256: synthesis.report.batch_plan_sha256,
      model_load_count: synthesis.report.model_load_count,
      resident_model_count: synthesis.report.resident_model_count,
      model_instance_concurrency:
        synthesis.report.model_instance_concurrency,
      results_restored_to_original_order:
        synthesis.report.results_restored_to_original_order,
      cohort_executions: synthesis.report.cohort_executions ?? [],
      cohort_events_path: synthesis.cohortEventsPath,
      cohort_events_sha256: synthesis.cohortEventsSha256,
      pipelined_cohort_qa: attemptPipelineEvents,
      pipelined_qa_progress_errors: synthesis.progressErrors ?? [],
    });
    const failedResults = synthesis.results.filter((result) => result.status === "failed");
    for (const result of failedResults) {
      const unit = targetUnits.find((row) => row.unit_id === result.unit_id);
      const qa = {
        status: "blocked",
        policy_version: QA_POLICY_VERSION,
        findings: [{
          severity: "blocker",
          code: result.error_code ?? "tts_synthesis_job_failed",
          error_type: result.error_type ?? null,
          error: result.error ?? "unknown per-unit synthesis failure",
        }],
      };
      const disposition = candidateDisposition(qa, provider);
      const candidate = {
        unit_id: result.unit_id,
        provider,
        model_id: result.model_id,
        voice_id: result.voice_id
          ?? policy.primary.voice_id,
        attempt,
        seed: result.seed,
        spoken_text_sha256: unit?.spoken_text_sha256 ?? result.spoken_text_sha256,
        synthesis_identity_sha256: result.synthesis_identity_sha256 ?? null,
        synthesis_identity: result.synthesis_identity ?? null,
        synthesis_mode: result.synthesis_mode
          ?? result.synthesis_identity?.synthesis_mode
          ?? synthesisMode,
        batch_plan_sha256: result.batch_plan_sha256
          ?? result.synthesis_identity?.batch_plan_sha256
          ?? batchPlan.batch_plan_sha256,
        cohort_id: result.cohort_id
          ?? result.synthesis_identity?.cohort_id
          ?? null,
        cohort_sha256: result.cohort_sha256
          ?? result.synthesis_identity?.cohort_sha256
          ?? null,
        generated_token_count: result.generated_token_count ?? null,
        effective_token_limit: result.effective_token_limit ?? null,
        token_limit_reached: result.token_limit_reached ?? null,
        recovery_provenance: result.recovery_provenance
          ?? result.synthesis_identity?.recovery_provenance
          ?? null,
        runner_report_path: synthesis.reportPath,
        runner_report_sha256: synthesis.reportSha256,
        audio_path: null,
        audio_sha256: null,
        duration_sec: null,
        qa,
        disposition,
      };
      candidates.push(candidate);
      const { qa: candidateQa, ...eventCandidate } = candidate;
      const event = {
        schema: "goldflow_narration_tts_attempt_event_v1",
        invocation_id: invocationId,
        recorded_at: new Date().toISOString(),
        status: "synthesis_failed",
        ...eventCandidate,
        qa_status: candidateQa.status,
        qa_blocker_codes: candidateDisposition(candidateQa, provider).blocker_codes,
      };
      attemptEvents.push(event);
      await fs.appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
    }
    const successfulResultById = new Map(
      synthesis.results
        .filter((result) => result.status !== "failed")
        .map((result) => [String(result.unit_id), result]),
    );
    const rows = targetUnits.flatMap((unit) => {
      const result = successfulResultById.get(unit.unit_id);
      if (!result) return [];
      return {
        ...unit,
        text: unit.spoken_text,
        segment_id: unit.segment_id
          ?? unit.source_segment_ids?.[0]
          ?? unit.inherited_segment_id
          ?? unit.unit_id,
        speaker: unit.speaker ?? "NARRATOR",
        voice_id: policy.primary.voice_id,
        provider,
        model_id: result.model_id,
        attempt,
        wav: result.output_path,
        duration_sec: result.duration_sec,
        synthesis_identity: result.synthesis_identity,
        synthesis_identity_sha256: result.synthesis_identity_sha256,
        synthesis_mode: result.synthesis_mode
          ?? result.synthesis_identity?.synthesis_mode
          ?? synthesisMode,
        batch_plan_sha256: result.batch_plan_sha256
          ?? result.synthesis_identity?.batch_plan_sha256
          ?? batchPlan.batch_plan_sha256,
        cohort_id: result.cohort_id
          ?? result.synthesis_identity?.cohort_id
          ?? null,
        cohort_sha256: result.cohort_sha256
          ?? result.synthesis_identity?.cohort_sha256
          ?? null,
        generated_token_count: result.generated_token_count ?? null,
        effective_token_limit: result.effective_token_limit ?? null,
        token_limit_reached: result.token_limit_reached ?? null,
        recovery_provenance: result.recovery_provenance
          ?? result.synthesis_identity?.recovery_provenance
          ?? null,
        runner_report_path: synthesis.reportPath,
        runner_report_sha256: synthesis.reportSha256,
        audio_sha256: result.output_sha256,
        audio_hash_verified: true,
        unit_qa: previousQaByAudioHash.get(result.output_sha256)
          ?? prefetchedQaByAudioHash.get(result.output_sha256)
          ?? null,
      };
    });
    await helpers.runUnitOutputQaForDiagnostics(rows, {
      reuseHashValidQa: true,
    });
    applyProtectedTermQa(rows);
    if (route === "qwen") {
      await applyQwenVoiceContinuityQa({
        rows,
        policy,
        outputDir,
        invocationId,
        attempt,
        similarityPython,
        similarityRunnerPath,
        narrationQualityContract,
      });
    }
    for (const row of rows) row.unit_qa = softenPrimaryQa(row.unit_qa);
    for (const row of rows) {
      const result = synthesis.results.find((candidate) => candidate.unit_id === row.unit_id);
      const disposition = candidateDisposition(row.unit_qa, provider);
      const candidate = {
        unit_id: row.unit_id,
        provider,
        model_id: row.model_id,
        voice_id: row.voice_id,
        attempt,
        seed: result.seed,
        spoken_text_sha256: row.spoken_text_sha256,
        synthesis_identity_sha256: row.synthesis_identity_sha256,
        synthesis_identity: row.synthesis_identity,
        synthesis_mode: row.synthesis_mode,
        batch_plan_sha256: row.batch_plan_sha256,
        cohort_id: row.cohort_id,
        cohort_sha256: row.cohort_sha256,
        generated_token_count: row.generated_token_count,
        effective_token_limit: row.effective_token_limit,
        token_limit_reached: row.token_limit_reached,
        recovery_provenance: row.recovery_provenance,
        runner_report_path: row.runner_report_path,
        runner_report_sha256: row.runner_report_sha256,
        audio_path: row.wav,
        audio_sha256: result.output_sha256,
        duration_sec: row.duration_sec,
        voice_continuity: row.unit_qa?.voice_continuity ?? null,
        qa: row.unit_qa,
        disposition,
      };
      candidates.push(candidate);
      const { qa: candidateQa, ...eventCandidate } = candidate;
      const event = {
        schema: "goldflow_narration_tts_attempt_event_v1",
        invocation_id: invocationId,
        recorded_at: new Date().toISOString(),
        ...eventCandidate,
        status: disposition.status,
        qa_status: candidateQa?.status ?? null,
        qa_audio_sha256: candidateQa?.audio_sha256 ?? null,
        qa_blocker_codes: disposition.blocker_codes,
        qa_warning_codes: (candidateQa?.findings ?? [])
          .filter((finding) => finding.severity === "warning")
          .map((finding) => finding.code),
        confirmable_delivery_finding_codes:
          confirmableDeliveryFindingCodes(candidateQa),
        retry_requires_confirmed_listen:
          confirmableDeliveryFindingCodes(candidateQa).length > 0
          && disposition.accepted,
      };
      attemptEvents.push(event);
      await fs.appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
      if (disposition.accepted && !selected.has(row.unit_id)) selected.set(row.unit_id, row);
    }
    return rows;
  };

  let recoveryScope = {
    ...finalSynthesisScope,
    status: "pre_synthesis_gate_validated",
    pre_synthesis_gate_path: preSynthesisGatePath,
    pre_synthesis_gate_sha256: preSynthesisGate.gate_sha256,
    pre_synthesis_gate_file_sha256: preSynthesisGateFileSha256,
  };
  if (manualReviewEvidencePath) {
    const evidenceBuffer = await fs.readFile(manualReviewEvidencePath);
    const evidenceSha256 = createHash("sha256").update(evidenceBuffer).digest("hex");
    const evidence = JSON.parse(evidenceBuffer.toString("utf8"));
    const validatedReview = validateManualReviewEvidenceForTests({
      evidence,
      planSha256,
      preReviewNarrationReport: priorNarrationReport,
      preReviewNarrationReportSha256: priorNarrationReportSha256,
      preReviewUnitQa: previousQa,
      preReviewUnitQaSha256: priorUnitQaSha256,
    });
    const manualStitchRecovery = validateManualStitchRecoveryForTests({
      manualReviewEvidencePath,
      repairTailUnitIds: stitchRepairTailUnitIds,
      skipRenderedTranscriptQa,
      workflowBypass,
      validatedReview,
    });
    const preReviewArchiveDir = path.join(
      episodeDir,
      "reports",
      "recovery",
      `${invocationId}-tts-manual-review`,
    );
    const preReviewNarrationReportPath = path.join(
      preReviewArchiveDir,
      `pre_review_narration_tts_report_${episode}.json`,
    );
    const preReviewUnitQaPath = path.join(
      preReviewArchiveDir,
      `pre_review_narration_tts_unit_qa_${episode}.json`,
    );
    await fs.mkdir(preReviewArchiveDir, { recursive: true });
    await Promise.all([
      fs.writeFile(preReviewNarrationReportPath, priorNarrationReportBuffer),
      fs.writeFile(preReviewUnitQaPath, priorUnitQaBuffer),
    ]);
    candidates.push(...(previousQa.candidates ?? []));
    synthesisRuns.push(...(priorNarrationReport?.synthesis_runs ?? []));
    const candidateRows = previousQa.candidates ?? [];
    const previousSelectionById = new Map(
      (previousQa.selected_units ?? []).map((row) => [String(row.unit_id), row]),
    );
    const reviewedById = new Map(
      validatedReview.accepted_units.map((row) => [row.unit_id, row]),
    );
    for (const unit of units) {
      const reviewed = reviewedById.get(unit.unit_id);
      const previousSelection = previousSelectionById.get(unit.unit_id);
      let candidate = null;
      let selectedQa = null;
      if (reviewed) {
        candidate = reviewed.candidate;
        const sidecarPath = String(candidate.audio_path).replace(/\.wav$/iu, ".json");
        const sidecar = await readJson(sidecarPath, null);
        if (!sidecar
          || sidecar.output_sha256 !== candidate.audio_sha256
          || sidecar.synthesis_identity_sha256
            !== candidate.synthesis_identity_sha256) {
          throw new Error(
            `Manual TTS review candidate ${unit.unit_id} lacks a matching synthesis sidecar.`,
          );
        }
        selectedQa = adjudicateManualReviewQaForTests(candidate.qa, {
          reviewer: validatedReview.reviewer,
          reviewedAt: validatedReview.reviewed_at,
          listenNote: reviewed.listen_note,
          reviewedBlockerCodes: reviewed.reviewed_blocker_codes,
          evidencePath: manualReviewEvidencePath,
          evidenceSha256,
          preReviewNarrationReportPath,
          preReviewNarrationReportSha256: priorNarrationReportSha256,
          preReviewUnitQaPath,
          preReviewUnitQaSha256: priorUnitQaSha256,
        });
        const event = {
          schema: "goldflow_narration_tts_manual_review_event_v1",
          invocation_id: invocationId,
          recorded_at: new Date().toISOString(),
          unit_id: unit.unit_id,
          provider: candidate.provider,
          attempt: candidate.attempt,
          status: "accepted_first_take_after_hash_bound_manual_review",
          spoken_text_sha256: candidate.spoken_text_sha256,
          audio_sha256: candidate.audio_sha256,
          synthesis_identity_sha256: candidate.synthesis_identity_sha256,
          reviewed_blocker_codes: reviewed.reviewed_blocker_codes,
          review_evidence_path: manualReviewEvidencePath,
          review_evidence_sha256: evidenceSha256,
        };
        attemptEvents.push(event);
        await fs.appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
      } else if (previousSelection) {
        const matches = candidateRows.filter((row) => (
          String(row?.unit_id ?? "") === unit.unit_id
          && Number(row?.attempt) === Number(previousSelection.attempt)
          && row?.audio_sha256 === previousSelection.audio_sha256
          && row?.synthesis_identity_sha256
            === previousSelection.synthesis_identity_sha256
        ));
        if (matches.length !== 1
          || candidateDisposition(previousSelection.qa, PRIMARY_TTS_PROVIDER).accepted !== true) {
          throw new Error(
            `Pre-review selected candidate provenance is stale for ${unit.unit_id}.`,
          );
        }
        [candidate] = matches;
        selectedQa = previousSelection.qa;
      }
      if (!candidate) continue;
      if (candidate.spoken_text_sha256 !== unit.spoken_text_sha256
        || candidate.provider !== policy.primary.provider
        || candidate.voice_id !== policy.primary.voice_id
        || candidate.model_id !== policy.primary.model_id
        || candidate.audio_sha256 !== selectedQa?.audio_sha256
        || await sha256File(candidate.audio_path) !== candidate.audio_sha256) {
        throw new Error(
          `Existing reviewed TTS candidate identity or audio hash is stale for ${unit.unit_id}.`,
        );
      }
      selected.set(
        unit.unit_id,
        existingCandidateRow(unit, candidate, selectedQa),
      );
    }
    recoveryScope = {
      mode: "hash_bound_manual_accept_first_take",
      status: "validated_existing_candidates_no_synthesis",
      evidence_path: manualReviewEvidencePath,
      evidence_sha256: evidenceSha256,
      pre_review_narration_report_sha256: priorNarrationReportSha256,
      pre_review_narration_report_path: preReviewNarrationReportPath,
      pre_review_unit_qa_sha256: priorUnitQaSha256,
      pre_review_unit_qa_path: preReviewUnitQaPath,
      reviewer: validatedReview.reviewer,
      reviewed_at: validatedReview.reviewed_at,
      accepted_unit_ids: validatedReview.accepted_units.map((row) => row.unit_id),
      accepted_unit_count: validatedReview.accepted_units.length,
      stitch_repair_tail_unit_ids: manualStitchRecovery.repair_tail_unit_ids,
      skip_rendered_transcript_qa:
        manualStitchRecovery.skip_rendered_transcript_qa,
      workflow_bypass: workflowBypass,
      model_loaded: false,
      synthesis_invoked: false,
    };
  } else if (requestedRecoveryScope) {
    // A recovery invocation never runs the full first-take batch. It hydrates
    // and hash-verifies accepted audio, then submits only the confirmed IDs.
    const confirmedEvidenceById = new Map(
      validatedConfirmedRetryEvidence.map((row) => [String(row.unit_id), row]),
    );
    const scopedRecoveryUnits = units.filter(
      (unit) => requestedRecoveryIds.has(String(unit.unit_id)),
    );
    recoveryScope = {
      ...recoveryScope,
      status: "validated_against_confirmed_listen_evidence",
      evidence_path: confirmedRetryEvidencePath,
      evidence_sha256: confirmedRetryEvidenceSha256,
      pre_retry_narration_report_sha256: priorNarrationReportSha256,
      confirmed_artifacts: validatedConfirmedRetryEvidence,
    };
    if (scopedRecoveryUnits.length) {
      if (policy.synthesis_contract.mode
        === QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.mode) {
        const attemptOneById = new Map(
          candidates
            .filter((candidate) => Number(candidate.attempt) === 1)
            .map((candidate) => [String(candidate.unit_id), candidate]),
        );
        const bindingByUnit = qwenBatchBindingByUnit(batchPlan);
        const recoveryProvenanceByUnit = new Map();
        for (const unit of scopedRecoveryUnits) {
          const unitId = String(unit.unit_id);
          const confirmed = confirmedEvidenceById.get(unitId);
          recoveryProvenanceByUnit.set(
            unitId,
            exactUnitRecoveryProvenanceForTests({
              unit,
              candidate: attemptOneById.get(unitId),
              cohortBinding: bindingByUnit.get(unitId),
              batchPlanSha256: batchPlan.batch_plan_sha256,
              confirmedDefect: confirmed?.defect_type ?? null,
              confirmedEvidencePath: confirmed
                ? confirmedRetryEvidencePath
                : null,
              confirmedEvidenceSha256: confirmed
                ? confirmedRetryEvidenceSha256
                : null,
            }),
          );
        }
        recoveryScope = {
          ...recoveryScope,
          synthesis_recovery_mode: QWEN_LIAM_EXACT_UNIT_RECOVERY_MODE,
          batch_plan_sha256: batchPlan.batch_plan_sha256,
          exact_unit_ids: scopedRecoveryUnits.map((unit) => unit.unit_id),
          exact_unit_provenance_sha256: Object.fromEntries(
            [...recoveryProvenanceByUnit.entries()].map(
              ([unitId, provenance]) => [
                unitId,
                canonicalQwenBatchSha256(provenance),
              ],
            ),
          ),
        };
        await qaSynthesis("qwen", 2, scopedRecoveryUnits, {
          synthesisMode: QWEN_LIAM_EXACT_UNIT_RECOVERY_MODE,
          recoveryProvenanceByUnit,
        });
      } else {
        await qaSynthesis("qwen", 2, scopedRecoveryUnits, {
          synthesisMode: policy.synthesis_contract.mode,
        });
      }
    }
  } else {
    // A fresh invocation uses the fixed cohort manifest. An interrupted
    // invocation switches to a source-ordered serial resume containing only
    // units that have no hash-verified accepted selection; accepted IDs never
    // enter the jobs manifest again.
    const authorizedIds = new Set(
      finalSynthesisScope.authorized_synthesis_unit_ids.map(String),
    );
    const targetUnits = units.filter(
      (unit) => authorizedIds.has(String(unit.unit_id)),
    );
    const incompleteBatchResume = preservedForInvocation.length > 0
      && policy.synthesis_contract.mode
        === QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.mode;
    const recoveryProvenanceByUnit = new Map();
    if (incompleteBatchResume) {
      const bindingByUnit = qwenBatchBindingByUnit(batchPlan);
      for (const unit of targetUnits) {
        recoveryProvenanceByUnit.set(
          String(unit.unit_id),
          incompleteUnitResumeProvenanceForTests({
            unit,
            cohortBinding: bindingByUnit.get(String(unit.unit_id)),
            batchPlanSha256: batchPlan.batch_plan_sha256,
            preSynthesisGateSha256: preSynthesisGate.gate_sha256,
          }),
        );
      }
    }
    await qaSynthesis("qwen", 1, targetUnits, {
      synthesisMode: incompleteBatchResume
        ? QWEN_LIAM_INCOMPLETE_UNIT_RESUME_MODE
        : policy.synthesis_contract.mode,
      recoveryProvenanceByUnit,
    });
  }
  let unresolved = units.filter((unit) => !selected.has(unit.unit_id));
  if (recoveryScope) {
    recoveryScope.primary_unresolved_unit_ids = unresolved.map((unit) => unit.unit_id);
  }

  const selectedRows = units.flatMap((unit) => {
    const row = selected.get(unit.unit_id);
    return row ? [row] : [];
  });
  let unitDeliveryQaV2 = null;
  let strictUnitDeliveryBlockers = [];
  let providerOutputManifest = null;
  const providerOutputManifestPath = path.join(
    episodeDir,
    `narration_provider_output_manifest_${episode}.json`,
  );
  if (narrationQualityV2) {
    providerOutputManifest = buildNarrationProviderOutputManifest({
      provider: policy.primary.provider,
      modelId: policy.primary.model_id,
      modelRevision: policy.primary.model_revision,
      voiceId: policy.primary.voice_id,
      voiceSha256: policy.primary.voice_sha256,
      voiceContinuityContract: policy.primary.voice_continuity_contract,
      generationPlanSha256: plan.plan_sha256 ?? planSha256,
      generationPlanFileSha256: planFileSha256,
      qualityContractSha256: narrationQualityContract.contract_sha256,
      providerExecution: {
        synthesis_contract: policy.synthesis_contract,
        batch_plan_sha256: batchPlan?.batch_plan_sha256 ?? null,
        synthesis_runs: synthesisRuns,
        effective_concurrency: 1,
      },
      units,
      results: selectedRows,
    });
    await atomicWriteJson(providerOutputManifestPath, providerOutputManifest);
    strictUnitDeliveryBlockers.push(
      ...(providerOutputManifest.validation?.findings ?? []).map((finding) => ({
        ...finding,
        repair_scope: "exact_unit_only",
      })),
    );
  }
  if (narrationQualityV2
    && unresolved.length === 0
    && providerOutputManifest?.status === "passed") {
    const { finalizeNarrationProviderOutput } = await import(
      "./narration-provider-output-finalize.mjs"
    );
    await finalizeNarrationProviderOutput([
      "--episode-dir", episodeDir,
      "--plan", planPath,
      "--manifest", providerOutputManifestPath,
    ]);
    return;
  }
  if (narrationQualityV2 && selectedRows.length) {
    const primaryAlignmentMap = await helpers.runFasterWhisperUnitBatchForDiagnostics(
      selectedRows.map((row) => ({ unit_id: row.unit_id, wav: row.wav })),
      {
        model: narrationQualityContract.delivery_qa.unit_screening_model ?? "small.en",
        device: "cpu",
        computeType: "int8_float32",
      },
    );
    const perUnitContract = narrationQualityContract;
    const maximumWordErrorRate = Number(
      narrationQualityContract.delivery_qa.maximum_word_error_rate,
    );
    const primaryById = new Map();
    const confirmationCandidates = [];
    for (const row of selectedRows) {
      const recognized = primaryAlignmentMap.get(String(row.unit_id)) ?? null;
      const transcriptQa = recognized
        ? helpers.transcriptQaForTests(row.text, recognized.text, {
            maxWer: maximumWordErrorRate,
            equivalentPhrases: equivalentPhrasesForTests(row),
            blockAnySubstitution: false,
          })
        : null;
      const primaryDecision = strictNarrationDeliveryDecision(transcriptQa, {
        orderQa: { blockers: [] },
        joinQa: { blockers: [], warnings: [] },
        contract: perUnitContract,
      });
      primaryById.set(String(row.unit_id), {
        recognized,
        transcriptQa,
        primaryDecision,
      });
      if (narrationDeliveryNeedsConfirmation(transcriptQa, primaryDecision)) {
        confirmationCandidates.push({ unit_id: row.unit_id, wav: row.wav });
      }
    }
    let confirmationMap = new Map();
    let confirmationError = null;
    if (confirmationCandidates.length) {
      try {
        confirmationMap = await helpers.runFasterWhisperUnitBatchForDiagnostics(
          confirmationCandidates,
          {
            model: narrationQualityContract.delivery_qa.exact_suspect_confirmation_model
              ?? "medium",
            device: "cpu",
            computeType: "int8_float32",
          },
        );
      } catch (error) {
        confirmationError = error instanceof Error ? error.message : String(error);
      }
    }
    const rows = [];
    for (const row of selectedRows) {
      const primary = primaryById.get(String(row.unit_id));
      const recognized = primary?.recognized ?? null;
      const transcriptQa = primary?.transcriptQa ?? null;
      const confirmation = confirmationMap.get(String(row.unit_id)) ?? null;
      const confirmationTranscriptQa = confirmation
        ? helpers.transcriptQaForTests(row.text, confirmation.text, {
            maxWer: maximumWordErrorRate,
            equivalentPhrases: equivalentPhrasesForTests(row),
            blockAnySubstitution: false,
          })
        : null;
      const alignmentRecognition = (recognized?.words?.length ?? 0) > 0
        ? recognized
        : confirmation;
      const words = alignmentRecognition?.words ?? [];
      const firstWord = words[0] ?? null;
      const finalWord = words.at(-1) ?? null;
      const edgeAlignment = firstWord && finalWord
        ? {
            status: "passed",
            engine: `faster_whisper_${alignmentRecognition === confirmation ? "medium" : "small_en"}`,
            first_speech_sample: Math.max(0, Math.round(Number(firstWord.start_sec ?? 0) * SAMPLE_RATE)),
            last_speech_sample_exclusive: Math.min(
              Number(row.unit_qa?.metrics?.sample_count ?? Math.round(row.duration_sec * SAMPLE_RATE)),
              Math.max(1, Math.round(Number(finalWord.end_sec ?? row.duration_sec) * SAMPLE_RATE)),
            ),
            first_word: firstWord,
            final_word: finalWord,
            recognized_word_count: words.length,
          }
        : {
            status: "missing",
            engine: "faster_whisper_consensus_v2",
            reason: "no_word_timestamps",
          };
      const decision = adjudicateNarrationDeliveryConsensus({
        primaryTranscriptQa: transcriptQa,
        confirmationTranscriptQa: confirmationCandidates.some(
          (candidate) => String(candidate.unit_id) === String(row.unit_id),
        ) ? confirmationTranscriptQa : transcriptQa,
        orderQa: { blockers: [] },
        joinQa: { blockers: [], warnings: [] },
        contract: perUnitContract,
        primaryModel: narrationQualityContract.delivery_qa.unit_screening_model ?? "small.en",
        confirmationModel: narrationQualityContract.delivery_qa.exact_suspect_confirmation_model
          ?? "medium",
      });
      row.unit_qa.edge_alignment = edgeAlignment;
      row.unit_qa.delivery_qa_v2 = {
        ...decision,
        intended_text: row.text,
        recognized_text: recognized?.text ?? null,
        confirmation_recognized_text: confirmation?.text ?? null,
        confirmation_error: confirmationError,
        transcript_qa: transcriptQa,
        confirmation_transcript_qa: confirmationTranscriptQa,
      };
      rows.push({
        unit_id: row.unit_id,
        audio_path: row.wav,
        audio_sha256: row.unit_qa?.audio_sha256 ?? null,
        edge_alignment: edgeAlignment,
        intended_text: row.text,
        recognized_text: recognized?.text ?? null,
        primary_recognized_text: recognized?.text ?? null,
        confirmation_recognized_text: confirmation?.text ?? null,
        confirmation_error: confirmationError,
        transcript_qa: transcriptQa,
        confirmation_transcript_qa: confirmationTranscriptQa,
        decision,
      });
      strictUnitDeliveryBlockers.push(...decision.blockers.map((finding) => ({
        ...finding,
        unit_id: row.unit_id,
      })));
    }
    const listenReviewPacket = exactNarrationListenReviewPacket({
      rows,
      generationPlanSha256: plan.plan_sha256 ?? planSha256,
      generationPlanFileSha256: planFileSha256,
      qualityContractSha256: narrationQualityContract.contract_sha256,
    });
    unitDeliveryQaV2 = {
      schema: "goldflow_narration_unit_delivery_qa_v2",
      status: strictUnitDeliveryBlockers.length
        ? "blocked"
        : listenReviewPacket.item_count
          ? "passed_with_warnings"
          : "passed",
      quality_contract_sha256: narrationQualityContract.contract_sha256,
      asr_consensus_policy: {
        screening_model: narrationQualityContract.delivery_qa.unit_screening_model ?? "small.en",
        confirmation_model: narrationQualityContract.delivery_qa.exact_suspect_confirmation_model ?? "medium",
        confirmation_candidate_count: confirmationCandidates.length,
        confirmation_error: confirmationError,
      },
      unit_count: rows.length,
      blocked_unit_count: new Set(strictUnitDeliveryBlockers.map((row) => row.unit_id)).size,
      listen_review_unit_count: listenReviewPacket.item_count,
      blockers: strictUnitDeliveryBlockers,
      units: rows,
    };
    await atomicWriteJson(
      path.join(episodeDir, `narration_unit_delivery_qa_${episode}.json`),
      unitDeliveryQaV2,
    );
    await atomicWriteJson(
      path.join(episodeDir, `narration_exact_listen_review_packet_${episode}.json`),
      listenReviewPacket,
    );
    await atomicWriteJson(
      path.join(episodeDir, `narration_exact_repair_packet_${episode}.json`),
      exactNarrationRepairPacket({
        decision: { status: unitDeliveryQaV2.status, blockers: strictUnitDeliveryBlockers },
        units: selectedRows,
      }),
    );
  }
  const orderQa = validateSelectedUnitOrder(units, selectedRows);
  const unitQaReport = rebuildQaAggregate(
    candidates.map((candidate) => ({
      unit_id: candidate.unit_id,
      provider: candidate.provider,
      attempt: candidate.attempt,
      unit_qa: candidate.qa,
    })),
    candidates,
  );
  unitQaReport.source_script_hash = scriptHash;
  unitQaReport.narration_generation_plan_path = planPath;
  unitQaReport.narration_generation_plan_sha256 = planSha256;
  unitQaReport.narration_generation_plan_file_sha256 = planFileSha256;
  unitQaReport.selection_policy_version = NARRATION_TTS_SELECTION_POLICY_VERSION;
  unitQaReport.recovery_scope = recoveryScope;
  unitQaReport.narration_quality_contract_sha256 =
    narrationQualityContract?.contract_sha256 ?? null;
  unitQaReport.provider_output_manifest = providerOutputManifest
    ? {
        path: providerOutputManifestPath,
        sha256: await sha256File(providerOutputManifestPath),
        status: providerOutputManifest.status,
      }
    : null;
  unitQaReport.unit_delivery_qa_v2 = unitDeliveryQaV2
    ? {
        status: unitDeliveryQaV2.status,
        path: path.join(episodeDir, `narration_unit_delivery_qa_${episode}.json`),
        blocked_unit_count: unitDeliveryQaV2.blocked_unit_count,
      }
    : null;
  unitQaReport.selected_units = selectedRows.map((row) => ({
    unit_id: row.unit_id,
    provider: row.provider,
    voice_id: row.voice_id,
    voice_sha256: policy.primary.voice_sha256,
    voice_continuity_contract: policy.primary.voice_continuity_contract,
    attempt: row.attempt,
    spoken_text_sha256: row.spoken_text_sha256,
    synthesis_mode: row.synthesis_mode,
    batch_plan_sha256: row.batch_plan_sha256,
    cohort_id: row.cohort_id,
    cohort_sha256: row.cohort_sha256,
    generated_token_count: row.generated_token_count,
    effective_token_limit: row.effective_token_limit,
    token_limit_reached: row.token_limit_reached,
    recovery_provenance: row.recovery_provenance,
    synthesis_identity_sha256: row.synthesis_identity_sha256,
    audio_path: row.wav,
    audio_sha256: row.unit_qa.audio_sha256,
    qa: row.unit_qa,
  }));
  const selectedQaDecision = selectedQaDecisionForTests(selectedRows, {
    unresolvedUnitIds: unresolved.map((unit) => unit.unit_id),
    orderQa,
  });
  unitQaReport.selected_blocker_count = selectedQaDecision.selected_blockers.length;
  unitQaReport.selected_blockers = selectedQaDecision.selected_blockers;
  unitQaReport.selected_blockers.push(...strictUnitDeliveryBlockers);
  unitQaReport.selected_blocker_count = unitQaReport.selected_blockers.length;
  unitQaReport.status = selectedQaDecision.status === "passed"
    && strictUnitDeliveryBlockers.length === 0
    ? "passed"
    : "blocked";
  await atomicWriteJson(unitQaPath, unitQaReport);

  if (unresolved.length || orderQa.status !== "passed" || strictUnitDeliveryBlockers.length) {
    const blockers = [
      ...selectedQaDecision.blockers,
      ...strictUnitDeliveryBlockers,
    ];
    const statusContract = ttsStatusContract({
      policy,
      units,
      selectedRows,
      candidates,
      unitQaStatus: unitQaReport.status,
      fullStreamQaStatus: "not_run_due_to_unit_blockers",
      recoveryScope,
      batchPlan,
      synthesisRuns,
    });
    await atomicWriteJson(fullQaPath, {
      schema: "goldflow_narration_full_stream_qa_v1",
      status: "not_run_due_to_unit_blockers",
      source_script_hash: scriptHash,
      narration_generation_plan_sha256: planSha256,
      narration_generation_plan_file_sha256: planFileSha256,
      recovery_scope: recoveryScope,
      blockers,
    });
    await atomicWriteJson(stitchReportPath, {
      schema: "goldflow_narration_stitch_report_v1",
      status: "blocked",
      source_script_hash: scriptHash,
      narration_generation_plan_path: planPath,
      narration_generation_plan_sha256: planSha256,
      narration_generation_plan_file_sha256: planFileSha256,
      recovery_scope: recoveryScope,
      stitch_repair_tail_unit_ids: stitchRepairTailUnitIds,
      skip_rendered_transcript_qa: skipRenderedTranscriptQa,
      primary_provider: policy.primary.provider,
      narrator_voice_id: policy.primary.voice_id,
      voice_sha256: policy.primary.voice_sha256,
      primary: {
        provider: policy.primary.provider,
        model_id: policy.primary.model_id,
        model_revision: policy.primary.model_revision,
        voice_id: policy.primary.voice_id,
        voice_sha256: policy.primary.voice_sha256,
        voice_continuity_contract: policy.primary.voice_continuity_contract,
      },
      native_speed: policy.primary.native_speed,
      post_tempo_normalized: false,
      stitch_qa_status: "not_run_due_to_unit_blockers",
      full_stream_qa_status: "not_run_due_to_unit_blockers",
      output_path: null,
      blockers,
    });
    await atomicWriteJson(reportPath, {
      schema: "goldflow_narration_tts_report_v1",
      status: "blocked",
      source_script_hash: scriptHash,
      narration_generation_plan_path: planPath,
      narration_generation_plan_sha256: planSha256,
      narration_generation_plan_file_sha256: planFileSha256,
      recovery_scope: recoveryScope,
      policy,
      ...statusContract,
      unit_qa_path: unitQaPath,
      full_stream_qa_path: fullQaPath,
      stitch_report_path: stitchReportPath,
      attempt_events_path: eventsPath,
      attempt_count: attemptEvents.length,
      selected_unit_count: selectedRows.length,
      fallback_selected_unit_ids: [],
      blockers,
    });
    process.exitCode = 1;
    return;
  }

  const finalWav = path.join(
    outputDir,
    `${episode}-narration-${policy.primary.voice_id}-primary.wav`,
  );
  const finalM4a = finalWav.replace(/\.wav$/, ".m4a");
  const stitchWorkingWav = path.join(
    outputDir,
    `.${path.basename(finalWav, ".wav")}.stitch-${invocationId}.wav`,
  );
  const stitch = await helpers.stitchWavsForDiagnostics(
    selectedRows,
    stitchWorkingWav,
    {
      repairTailUnitIds: new Set(stitchRepairTailUnitIds),
      skipRenderedTranscriptQa,
      unitGapSec: UNIT_GAP_SEC,
      segmentGapSec: SEGMENT_GAP_SEC,
      narrationQualityContract,
    },
  );
  if (stitch?.status !== "passed") {
    const blockers = [
      ...(stitch?.prepared_qa?.blockers ?? []),
      ...(stitch?.boundary_qa?.blockers ?? []),
      ...(stitch?.final_qa?.blockers ?? []),
      ...(!stitch ? [{ code: "narration_tts_stitch_report_missing" }] : []),
    ];
    const fullStreamQaStatus = "not_run_due_to_stitch_blockers";
    const statusContract = ttsStatusContract({
      policy,
      units,
      selectedRows,
      candidates,
      unitQaStatus: unitQaReport.status,
      fullStreamQaStatus,
      recoveryScope,
      batchPlan,
      synthesisRuns,
    });
    await atomicWriteJson(fullQaPath, {
      schema: "goldflow_narration_full_stream_qa_v1",
      status: fullStreamQaStatus,
      policy_version: QA_POLICY_VERSION,
      source_script_hash: scriptHash,
      narration_generation_plan_sha256: planSha256,
      narration_generation_plan_file_sha256: planFileSha256,
      recovery_scope: recoveryScope,
      blockers,
    });
    await atomicWriteJson(stitchReportPath, {
      schema: "goldflow_narration_stitch_report_v1",
      status: "blocked",
      source_script_hash: scriptHash,
      narration_generation_plan_path: planPath,
      narration_generation_plan_sha256: planSha256,
      narration_generation_plan_file_sha256: planFileSha256,
      recovery_scope: recoveryScope,
      stitch_repair_tail_unit_ids: stitchRepairTailUnitIds,
      skip_rendered_transcript_qa: skipRenderedTranscriptQa,
      primary_provider: policy.primary.provider,
      narrator_voice_id: policy.primary.voice_id,
      voice_sha256: policy.primary.voice_sha256,
      primary: {
        provider: policy.primary.provider,
        model_id: policy.primary.model_id,
        model_revision: policy.primary.model_revision,
        voice_id: policy.primary.voice_id,
        voice_sha256: policy.primary.voice_sha256,
        voice_continuity_contract: policy.primary.voice_continuity_contract,
      },
      native_speed: policy.primary.native_speed,
      post_tempo_normalized: false,
      stitch_qa_status: "blocked",
      full_stream_qa_status: fullStreamQaStatus,
      output_path: null,
      stitch_policy: stitch?.policy ?? null,
      boundary_qa: stitch?.boundary_qa ?? null,
      boundaries: stitch?.boundaries ?? [],
      blockers,
    });
    await atomicWriteJson(reportPath, {
      schema: "goldflow_narration_tts_report_v1",
      status: "blocked",
      source_script_hash: scriptHash,
      narration_generation_plan_path: planPath,
      narration_generation_plan_sha256: planSha256,
      narration_generation_plan_file_sha256: planFileSha256,
      recovery_scope: recoveryScope,
      policy,
      ...statusContract,
      unit_qa_path: unitQaPath,
      full_stream_qa_path: fullQaPath,
      stitch_report_path: stitchReportPath,
      attempt_events_path: eventsPath,
      attempt_count: attemptEvents.length,
      blockers,
    });
    console.error(`Narration stitch QA blocked: ${JSON.stringify(blockers)}`);
    process.exitCode = 1;
    return;
  }
  await fs.rename(stitchWorkingWav, finalWav);
  if (stitch.final_qa) stitch.final_qa.audio_path = finalWav;
  for (const prepared of stitch.prepared_inputs ?? []) {
    prepared.sample_count = await wavSampleCount(prepared.prepared_wav);
  }
  for (const boundary of stitch.boundaries ?? []) {
    boundary.gap_sample_count = boundary.gap_wav
      ? await wavSampleCount(boundary.gap_wav)
      : 0;
  }
  const finalPcm = await runBinary("ffmpeg", [
    "-nostdin", "-v", "error",
    "-i", finalWav,
    "-map", "0:a:0",
    "-ac", "1",
    "-ar", String(SAMPLE_RATE),
    "-f", "s16le",
    "pipe:1",
  ]);
  const samples = new Int16Array(Math.floor(finalPcm.byteLength / 2));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = finalPcm.readInt16LE(index * 2);
  }
  const joinQa = narrationQualityContract
    ? joinQaV2FromPcmForTests(
        samples,
        SAMPLE_RATE,
        stitch.prepared_inputs,
        stitch.boundaries,
      )
    : joinQaFromPcmForTests(
        samples,
        SAMPLE_RATE,
        stitch.prepared_inputs,
        stitch.boundaries,
      );
  // Transcript fidelity is verified once by the mandatory
  // local_whisper_word_timing stage on this exact stitched audio. Repeating a
  // medium-Whisper pass here adds latency without producing the timing
  // artifact consumed downstream.
  const fullRecognized = null;
  const intendedText = selectedRows.map((row) => row.text).join(" ");
  const allEquivalences = selectedRows.flatMap(equivalentPhrasesForTests);
  const fullTranscriptQa = fullRecognized
    ? helpers.transcriptQaForTests(intendedText, fullRecognized.text, {
      maxWer: 0.05,
      equivalentPhrases: allEquivalences,
      blockAnySubstitution: false,
    })
    : null;
  if (fullTranscriptQa && fullRecognized) {
    const protectedFindings = selectedRows.flatMap((row) => (
      protectedTermFindingsForTests(row, fullRecognized.text)
    ));
    fullTranscriptQa.findings.push(...protectedFindings);
  }
  const streamDecision = fullStreamDecision(fullTranscriptQa, {
    orderQa,
    joinQa,
    maximumWer: 0.05,
    transcriptDeferred: true,
  });
  streamDecision.warnings.push(...stitchReviewWarnings(stitch));
  const fullQaReport = {
    schema: "goldflow_narration_full_stream_qa_v1",
    status: streamDecision.status,
    policy_version: QA_POLICY_VERSION,
    source_script_hash: scriptHash,
    narration_generation_plan_sha256: planSha256,
    narration_generation_plan_file_sha256: planFileSha256,
    recovery_scope: recoveryScope,
    audio_path: finalWav,
    audio_sha256: await sha256File(finalWav),
    intended_text_sha256: sha256Text(intendedText),
    whisper_model: null,
    transcript_verification_stage: "local_whisper_word_timing",
    recognized_text: fullRecognized?.text ?? null,
    recognized_words: fullRecognized?.words ?? [],
    transcript_qa: fullTranscriptQa,
    order_qa: orderQa,
    join_qa: joinQa,
    blockers: streamDecision.blockers,
    warnings: streamDecision.warnings,
    warning_count: streamDecision.warnings.length,
  };
  await atomicWriteJson(fullQaPath, fullQaReport);
  if (fullQaReport.status === "passed") {
    const m4aWorkingPath = path.join(
      outputDir,
      `.${path.basename(finalM4a, ".m4a")}.encode-${invocationId}.m4a`,
    );
    await run("ffmpeg", [
      "-y", "-nostdin", "-v", "error",
      "-i", finalWav,
      "-c:a", "aac",
      "-b:a", "160k",
      "-ar", String(SAMPLE_RATE),
      "-ac", "1",
      m4aWorkingPath,
    ]);
    await fs.rename(m4aWorkingPath, finalM4a);
  }
  const finalWavSha256 = await sha256File(finalWav);
  const finalM4aSha256 = fullQaReport.status === "passed"
    ? await sha256File(finalM4a)
    : null;
  const preparedById = new Map(stitch.prepared_inputs.map((row) => [String(row.unit_id), row]));
  const boundaryById = new Map(stitch.boundaries.map((row) => [String(row.after_unit_id), row]));
  const segments = selectedRows.map((row, index) => {
    const prepared = preparedById.get(row.unit_id);
    const boundary = boundaryById.get(row.unit_id);
    return {
      unit_id: row.unit_id,
      segment_id: row.segment_id,
      text: row.text,
      caption_text: row.caption_text,
      source_segment_ids: row.source_segment_ids,
      source_unit_refs: row.source_unit_refs,
      tts_provider: row.provider,
      model_id: row.model_id,
      voice_id: row.voice_id,
      voice_sha256: policy.primary.voice_sha256,
      voice_continuity_contract: policy.primary.voice_continuity_contract,
      voice_continuity: row.unit_qa?.voice_continuity ?? null,
      native_speed: null,
      fallback_used: false,
      post_tempo_processed: false,
      raw_audio_path: row.wav,
      raw_audio_sha256: row.unit_qa.audio_sha256,
      synthesis_mode: row.synthesis_mode,
      batch_plan_sha256: row.batch_plan_sha256,
      cohort_id: row.cohort_id,
      cohort_sha256: row.cohort_sha256,
      recovery_provenance: row.recovery_provenance,
      synthesis_identity_sha256: row.synthesis_identity_sha256,
      prepared_audio_path: prepared?.prepared_wav ?? null,
      prepared_audio_sha256: prepared?.prepared_audio_sha256 ?? null,
      prepared_sample_count: prepared?.sample_count ?? null,
      prepared_leading_silence_sample_count:
        prepared?.retained_leading_silence_sample_count
        ?? prepared?.prepared_qa?.metrics?.leading_silence_sample_count
        ?? null,
      prepared_trailing_silence_sample_count:
        prepared?.retained_trailing_silence_sample_count
        ?? prepared?.prepared_qa?.metrics?.trailing_silence_sample_count
        ?? null,
      boundary_after_effective_gap_sample_count:
        boundary?.effective_gap_sample_count ?? null,
      duration_sec: Number((
        Number(prepared?.prepared_duration_sec ?? row.duration_sec)
        + (index < selectedRows.length - 1 ? Number(boundary?.inserted_silence_sec ?? 0) : 0)
      ).toFixed(6)),
      unit_qa: row.unit_qa,
    };
  });
  const status = fullQaReport.status === "passed" ? "passed" : "blocked";
  const statusContract = ttsStatusContract({
    policy,
    units,
    selectedRows,
    candidates,
    unitQaStatus: unitQaReport.status,
    fullStreamQaStatus: fullQaReport.status,
    recoveryScope,
    batchPlan,
    synthesisRuns,
  });
  await atomicWriteJson(stitchReportPath, {
    schema: "goldflow_narration_stitch_report_v1",
    status,
    provider: `${policy.primary.provider}_provider_neutral_unit_stitch`,
    primary_provider: policy.primary.provider,
    narrator_voice_id: policy.primary.voice_id,
    voice_sha256: policy.primary.voice_sha256,
    primary: {
      provider: policy.primary.provider,
      model_id: policy.primary.model_id,
      model_revision: policy.primary.model_revision,
      voice_id: policy.primary.voice_id,
      voice_sha256: policy.primary.voice_sha256,
      voice_continuity_contract: policy.primary.voice_continuity_contract,
    },
    native_speed: policy.primary.native_speed,
    post_tempo_normalized: false,
    source_script_hash: scriptHash,
    narration_generation_plan_path: planPath,
    narration_generation_plan_sha256: planSha256,
    narration_generation_plan_file_sha256: planFileSha256,
    narration_quality_contract_sha256:
      narrationQualityContract?.contract_sha256 ?? null,
    provider_output_manifest_path: providerOutputManifest
      ? providerOutputManifestPath
      : null,
    provider_output_manifest_sha256:
      providerOutputManifest?.manifest_sha256 ?? null,
    recovery_scope: recoveryScope,
    stitch_repair_tail_unit_ids: stitchRepairTailUnitIds,
    skip_rendered_transcript_qa: skipRenderedTranscriptQa,
    output_path: status === "passed" ? finalWav : null,
    output_sha256: status === "passed" ? finalWavSha256 : null,
    blocked_output_path: status === "blocked" ? finalWav : null,
    blocked_output_sha256: status === "blocked" ? finalWavSha256 : null,
    final_m4a_path: status === "passed" ? finalM4a : null,
    final_m4a_sha256: finalM4aSha256,
    final_duration_sec: Number(stitch.final_qa?.metrics?.duration_sec ?? 0),
    stitch_sample_rate: SAMPLE_RATE,
    unit_qa_policy_version: QA_POLICY_VERSION,
    ...(narrationQualityContract
      ? {
          stitch_policy_version: STITCH_POLICY_VERSION_V2,
          boundary_pause_policy: "semantic_class_with_preserved_natural_silence",
          amplitude_only_trimming: false,
          fade_over_speech: false,
          sample_accounting: stitch.sample_accounting ?? joinQa.sample_accounting,
        }
      : {
          unit_gap_sec: UNIT_GAP_SEC,
          segment_gap_sec: SEGMENT_GAP_SEC,
          stitch_edge_pad_sec: EDGE_PAD_SEC,
          stitch_fade_sec: FADE_SEC,
          stitch_policy_version: STITCH_POLICY_VERSION,
        }),
    stitch_policy: stitch.policy,
    boundary_qa: stitch.boundary_qa,
    boundaries: stitch.boundaries,
    stitch_qa_status: joinQa.status,
    full_stream_qa_status: fullQaReport.status,
    join_qa: joinQa,
    warnings: fullQaReport.warnings,
    warning_count: fullQaReport.warnings.length,
    full_stream_qa_path: fullQaPath,
    segments,
  });
  await atomicWriteJson(reportPath, {
    schema: "goldflow_narration_tts_report_v1",
    status,
    generated_at: new Date().toISOString(),
    source_script_hash: scriptHash,
    run_identity_path: identityPath,
    narration_generation_plan_path: planPath,
    narration_generation_plan_sha256: planSha256,
    narration_generation_plan_file_sha256: planFileSha256,
    recovery_scope: recoveryScope,
    policy,
    ...statusContract,
    narration_quality_contract_sha256:
      narrationQualityContract?.contract_sha256 ?? null,
    provider_output_manifest_path: providerOutputManifest
      ? providerOutputManifestPath
      : null,
    provider_output_manifest_sha256:
      providerOutputManifest?.manifest_sha256 ?? null,
    selection_policy_version: NARRATION_TTS_SELECTION_POLICY_VERSION,
    qa_policy: QA_POLICY_VERSION,
    qa_policy_version: QA_POLICY_VERSION,
    stitch_policy_version: STITCH_POLICY_VERSION,
    unit_count: units.length,
    selected_primary_unit_count: selectedRows.filter((row) => row.provider === PRIMARY_TTS_PROVIDER).length,
    selected_fallback_unit_count: 0,
    fallback_selected_unit_ids: [],
    fallback_scope_policy: "no_alternate_provider_or_voice",
    retry_scope_policy:
      "no_automatic_retry; later_hash_bound_exact_unit_repair_only",
    attempt_events_path: eventsPath,
    attempt_count: attemptEvents.length,
    unit_qa_path: unitQaPath,
    unit_qa_status: unitQaReport.status,
    full_stream_qa_path: fullQaPath,
    full_stream_qa_status: fullQaReport.status,
    stitch_report_path: stitchReportPath,
    final_wav: status === "passed" ? finalWav : null,
    final_wav_sha256: status === "passed" ? finalWavSha256 : null,
    final_m4a: status === "passed" ? finalM4a : null,
    final_m4a_sha256: finalM4aSha256,
    blockers: fullQaReport.blockers,
    warnings: [
      ...(unitQaReport.warnings ?? []),
      ...fullQaReport.warnings,
    ],
    warning_count:
      (unitQaReport.warnings?.length ?? 0)
      + fullQaReport.warnings.length,
  });
  console.log(JSON.stringify({
    status,
    unit_count: units.length,
    fallback_unit_count: 0,
    final_m4a: status === "passed" ? finalM4a : null,
    report_path: reportPath,
  }, null, 2));
  if (status !== "passed") process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
