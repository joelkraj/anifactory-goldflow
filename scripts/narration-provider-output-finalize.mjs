#!/usr/bin/env node

import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  NARRATION_DELIVERY_CONSENSUS_VERSION,
  adjudicateNarrationDeliveryConsensus,
  blockAutomatedNarrationEdgeRisks,
  exactNarrationListenReviewPacket,
  exactNarrationRepairPacket,
  narrationDeliveryNeedsConfirmation,
  strictNarrationDeliveryDecision,
  validateNarrationExactListenReviewDecision,
} from "./lib/narration-delivery-quality.mjs";
import {
  buildNarrationQualityContract,
  narrationQualityContractForIdentity,
  narrationUsesAutomatedAsrAcceptance,
} from "./lib/narration-quality-contract.mjs";
import {
  narrationProviderUnitQaSha256,
  validateNarrationProviderOutputManifest,
} from "./lib/narration-provider-adapter.mjs";
import { masterNarrationTwoPass } from "./lib/narration-mastering.mjs";
import {
  buildNarrationSubjectiveReviewManifest,
  narrationSubjectiveReviewManifestSha256,
  narrationUnitTimeline,
  validateNarrationSubjectiveReviewManifest,
} from "./lib/narration-subjective-review.mjs";
import {
  narrationTtsRetryReportPolicy,
  narrationTtsPolicyForIdentity,
  validateNarrationTtsPolicy,
} from "./lib/narration-tts-policy.mjs";
import { runNarrationVoiceContinuityQa } from "./lib/narration-voice-continuity.mjs";
import { sha256File } from "./lib/file-hash.mjs";
import {
  localWhisperContractForIdentity,
  validateLocalWhisperIdentityContract,
} from "./lib/local-whisper-policy.mjs";
import {
  buildLocalWhisperTimingCandidate,
  localWhisperTimingCandidateSha256,
} from "./lib/local-whisper-timing-candidate.mjs";
import {
  planNarrationConfirmationWindows,
} from "./lib/narration-confirmation-windows.mjs";
import {
  emptyNarrationFinalizationCheckpoint,
  narrationFinalizationStageKey,
  narrationFinalizationUnitKey,
  reusableNarrationFinalizationStage,
  reusableNarrationFinalizationUnit,
} from "./lib/narration-finalization-checkpoint.mjs";
import {
  buildNarrationProviderUnitAsrContract,
  validateNarrationProviderUnitAsrReuse,
} from "./lib/narration-provider-unit-asr-reuse.mjs";
import { equivalentPhrasesForTests } from "./narration-tts-episode.mjs";
import { runFasterWhisperForDiagnostics } from "./local-whisper-word-timing.mjs";
import { prepareOpeningNarrationFinalization, validateOpeningFinalizationFlags } from "./lib/narration-opening-finalization.mjs";
import { prepareFullPilotNarrationFinalization } from "./lib/narration-full-pilot-finalization.mjs";
import { loadNarrationSourceStructure } from "./lib/narration-source-structure.mjs";
import { applyLowMarginDisposition, assertLowMarginActiveBindings, loadLowMarginDisposition } from "./lib/narration-low-margin-disposition.mjs";
import { applyFullStreamManualReview, loadFullStreamManualReview } from "./lib/narration-full-stream-manual-review.mjs";

const execFile = promisify(execFileCb);
const CANONICAL_SAMPLE_RATE_HZ = 24000;
const NARRATION_DELIVERY_MANUAL_REVIEW_SCHEMA =
  "goldflow_narration_delivery_manual_review_v1";
const NARRATION_DELIVERY_MANUAL_REVIEW_ATTESTATION =
  "all_hash_bound_blocked_narration_units_listened_end_to_end";
const NARRATION_DELIVERY_MIXED_REVIEW_ATTESTATION =
  "all_hash_bound_blocked_narration_units_listened_and_individually_decided";

function parseFlags(parts) {
  const flags = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--")
      ? parts[++index]
      : "true";
    flags[key] = value;
  }
  return flags;
}

function boolFlag(value, fallback = false) {
  if (value == null) return fallback;
  return /^(?:1|true|yes|on)$/iu.test(String(value));
}

function assertOperatorNarrationWaiver({
  requested,
  workflowBypass,
  reason,
  label,
}) {
  if (!requested) return;
  if (!workflowBypass) {
    throw new Error(`${label} requires --workflow-bypass true.`);
  }
  if (!String(reason ?? "").trim()) {
    throw new Error(`${label} requires --delivery-waiver-reason.`);
  }
}

const FULL_STREAM_ASR_ONLY_CODES = new Set([
  "narration_contiguous_words_missing",
  "narration_confirmation_alignment_intended_coverage_mismatch",
  "tts_transcript_isolated_word_deletion",
  "tts_transcript_isolated_insertion",
  "tts_transcript_protected_value_mismatch",
  "tts_transcript_protected_value_missing",
  "tts_transcript_unexpected_protected_value",
]);

function asrOnlyDeliveryFinding(finding) {
  const code = String(finding?.code ?? "");
  return code.startsWith("narration_confirmed_")
    || FULL_STREAM_ASR_ONLY_CODES.has(code);
}

function operatorWaiveAsrDecision(decision, waiver) {
  const blockers = decision?.blockers ?? [];
  if (!blockers.length || !blockers.every(asrOnlyDeliveryFinding)) {
    return decision;
  }
  return {
    ...decision,
    status: "passed_with_warnings",
    blockers: [],
    warnings: [
      ...(decision?.warnings ?? []),
      ...blockers.map((finding) => ({
        ...finding,
        severity: "warning",
        review_required: false,
        automatic_retry_allowed: false,
        disposition: "operator_accepted_asr_diagnostic_without_resynthesis",
        operator_waiver_id: waiver.waiver_id,
      })),
    ],
    operator_asr_waiver: waiver,
  };
}

function operatorWaiveReviewWarnings(decision, waiver) {
  const warnings = (decision?.warnings ?? []).map((finding) => (
    finding?.review_required === true
      ? {
          ...finding,
          review_required: false,
          automatic_retry_allowed: false,
          disposition: "operator_accepted_advisory_without_resynthesis",
          operator_waiver_id: waiver.waiver_id,
        }
      : finding
  ));
  return {
    ...decision,
    status: (decision?.blockers ?? []).length
      ? "blocked"
      : warnings.length ? "passed_with_warnings" : "passed",
    review_required: false,
    warnings,
    operator_review_warning_waiver: waiver,
  };
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function synthesisRunsWithFirstTakeProvenance({
  episodeDir,
  expectedUnitIds,
  batchPlanSha256,
  synthesisMode,
  synthesisRuns = [],
}) {
  const deduped = [];
  const seen = new Set();
  const append = (run) => {
    const key = String(
      run?.report_sha256
        ?? `${run?.attempt ?? ""}:${run?.report_path ?? ""}`,
    );
    if (!key || seen.has(key)) return;
    seen.add(key);
    deduped.push(run);
  };
  for (const run of synthesisRuns) append(run);
  if (deduped.some((run) => (
    Number(run?.attempt) === 1 && run?.synthesis_mode === synthesisMode
  ))) {
    return deduped;
  }

  // Exact-unit recovery manifests may contain only the repair runs. Recover
  // immutable first-take provenance from the original resident-run report.
  const runsDir = path.join(
    episodeDir,
    "assets",
    "audio",
    "narration_tts",
    "runs",
  );
  const names = await fs.readdir(runsDir).catch(() => []);
  const candidates = [];
  for (const name of names.sort()) {
    if (!/-qwen-attempt-1\.json$/u.test(name)) continue;
    const reportPath = path.join(runsDir, name);
    const report = await readJson(reportPath, null);
    if (!report
      || report.status !== "passed"
      || report.synthesis_mode !== synthesisMode
      || report.batch_plan_sha256 !== batchPlanSha256
      || !exactOrderedIds(expectedUnitIds, report.original_order_unit_ids)) {
      continue;
    }
    const cohortEventsPath = report.cohort_event_path ?? null;
    candidates.push({
      attempt: 1,
      synthesis_mode: report.synthesis_mode,
      report_path: reportPath,
      report_sha256: await sha256File(reportPath),
      batch_plan_sha256: report.batch_plan_sha256,
      model_load_count: report.model_load_count,
      resident_model_count: report.resident_model_count,
      model_instance_concurrency: report.model_instance_concurrency,
      results_restored_to_original_order:
        report.results_restored_to_original_order,
      cohort_executions: report.cohort_executions ?? [],
      cohort_events_path: cohortEventsPath,
      cohort_events_sha256: cohortEventsPath
        ? await sha256File(cohortEventsPath).catch(() => null)
        : null,
      pipelined_cohort_qa: [],
      pipelined_qa_progress_errors: [],
    });
  }
  if (candidates.length === 1) {
    deduped.unshift(candidates[0]);
  }
  return deduped;
}

async function fileMatchesSha256(filePath, expectedSha256) {
  if (!filePath || !expectedSha256) return false;
  return await sha256File(filePath).catch(() => null) === expectedSha256;
}

function planUnits(plan) {
  if (Array.isArray(plan?.units) && plan.units.length) return plan.units;
  return (plan?.segments ?? []).flatMap((segment) => (
    segment?.narration_units
      ?? segment?.tts_generation_units
      ?? segment?.qwen_generation_units
      ?? segment?.generation_units
      ?? []
  ));
}

function sourceScriptHash(plan) {
  return plan?.source_script_hash
    ?? plan?.source_script_sha256
    ?? plan?.source_hashes?.script_clean_sha256
    ?? plan?.source_hashes?.script_sha256
    ?? null;
}

function exactOrderedIds(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => String(value) === String(right[index]));
}

function statusFor({ blockers = [], warnings = [] } = {}) {
  if (blockers.length) return "blocked";
  return warnings.length ? "passed_with_warnings" : "passed";
}

function mergeDecisionWarnings(decision, warnings = []) {
  const merged = [
    ...(decision?.warnings ?? []),
    ...warnings.filter((finding) => finding?.review_required === true),
  ];
  return {
    ...decision,
    status: statusFor({ blockers: decision?.blockers ?? [], warnings: merged }),
    warnings: merged,
    review_required: merged.length > 0,
  };
}

function normalizedFindingCodes(findings = []) {
  return [...new Set((findings ?? [])
    .map((finding) => String(finding?.code ?? finding ?? "").trim())
    .filter(Boolean))]
    .sort();
}

function exactStringSet(left = [], right = []) {
  const normalizedLeft = [...new Set(left.map(String))].sort();
  const normalizedRight = [...new Set(right.map(String))].sort();
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

export async function validateNarrationDeliveryManualReviewEvidenceForTests({
  evidence,
  evidencePath,
  canonicalPlanSha256,
  manifestFileSha256,
  priorUnitDeliveryPath,
  priorUnitDeliverySha256,
  rows = [],
  deliveryRows = [],
  blockers = [],
} = {}) {
  if (!evidence || typeof evidence !== "object"
    || evidence.schema !== NARRATION_DELIVERY_MANUAL_REVIEW_SCHEMA
    || evidence.status !== "approved") {
    throw new Error(
      `Narration delivery manual review requires ${NARRATION_DELIVERY_MANUAL_REVIEW_SCHEMA} with approved status.`,
    );
  }
  const acceptedUnits = Array.isArray(evidence.accepted_units)
    ? evidence.accepted_units
    : [];
  const rejectedUnits = Array.isArray(evidence.rejected_units)
    ? evidence.rejected_units
    : [];
  const expectedAttestation = rejectedUnits.length
    ? NARRATION_DELIVERY_MIXED_REVIEW_ATTESTATION
    : NARRATION_DELIVERY_MANUAL_REVIEW_ATTESTATION;
  if (!String(evidence.reviewer ?? "").trim()
    || !String(evidence.reviewed_at ?? "").trim()
    || !String(evidence.note ?? "").trim()
    || evidence.attestation !== expectedAttestation) {
    throw new Error(
      "Narration delivery manual review requires reviewer, reviewed_at, note, and the exact listening attestation.",
    );
  }
  if (evidence.narration_generation_plan_sha256 !== canonicalPlanSha256
    || evidence.provider_output_manifest_sha256 !== manifestFileSha256
    || evidence.pre_review_unit_delivery_qa_sha256 !== priorUnitDeliverySha256
    || !priorUnitDeliveryPath) {
    throw new Error(
      "Narration delivery manual review is stale against the current plan, provider manifest, or blocked QA artifact.",
    );
  }
  const evidencePriorUnitDeliveryPath = String(
    evidence.pre_review_unit_delivery_qa_path ?? "",
  ).trim();
  if (!evidencePriorUnitDeliveryPath
    || path.resolve(evidencePriorUnitDeliveryPath)
      !== path.resolve(priorUnitDeliveryPath)) {
    throw new Error(
      "Narration delivery manual review does not bind the exact blocked QA artifact path.",
    );
  }
  if (!await fileMatchesSha256(
    priorUnitDeliveryPath,
    evidence.pre_review_unit_delivery_qa_sha256,
  )) {
    throw new Error("Narration delivery manual review cannot verify the blocked QA artifact hash.");
  }
  if (evidence.review_reel_path || evidence.review_reel_sha256) {
    if (!await fileMatchesSha256(
      evidence.review_reel_path,
      evidence.review_reel_sha256,
    )) {
      throw new Error("Narration delivery manual review reel is missing or hash-stale.");
    }
  }
  const blockedIds = [...new Set(
    blockers.map((finding) => String(finding?.unit_id ?? "")).filter(Boolean),
  )];
  if (!blockedIds.length) {
    throw new Error("Narration delivery manual review has no current blocker scope.");
  }
  const acceptedIds = acceptedUnits.map((row) => String(row?.unit_id ?? ""));
  const rejectedIds = rejectedUnits.map((row) => String(row?.unit_id ?? ""));
  const decidedIds = [...acceptedIds, ...rejectedIds];
  if (Number(evidence.accepted_unit_count) !== acceptedUnits.length
    || (evidence.rejected_units != null && !Array.isArray(evidence.rejected_units))
    || (rejectedUnits.length
      ? Number(evidence.rejected_unit_count) !== rejectedUnits.length
      : Number(evidence.rejected_unit_count ?? 0) !== 0)
    || new Set(decidedIds).size !== decidedIds.length
    || !exactStringSet(decidedIds, blockedIds)) {
    throw new Error(
      "Narration delivery manual review must cover every currently blocked unit exactly once.",
    );
  }
  const sourceById = new Map(rows.map((row) => [String(row.unit_id), row]));
  const deliveryById = new Map(
    deliveryRows.map((row) => [String(row.unit_id), row]),
  );
  for (const accepted of acceptedUnits) {
    const unitId = String(accepted?.unit_id ?? "");
    const source = sourceById.get(unitId);
    const delivery = deliveryById.get(unitId);
    const audible = accepted?.audible_review ?? {};
    if (!source || !delivery
      || accepted.decision !== "accept_first_take"
      || accepted.provider !== source.provider
      || Number(accepted.attempt) !== Number(source.attempt ?? 1)
      || accepted.audio_path !== source.wav
      || accepted.audio_sha256 !== source.audio_sha256
      || accepted.synthesis_identity_sha256 !== source.synthesis_identity_sha256
      || !String(accepted.listen_note ?? "").trim()) {
      throw new Error(`Narration delivery manual review is stale for ${unitId}.`);
    }
    for (const field of [
      "speech_complete",
      "no_skip",
      "no_truncation",
      "no_stutter",
      "voice_identity_acceptable",
      "endpoint_acceptable",
    ]) {
      if (audible[field] !== true) {
        throw new Error(
          `Narration delivery manual review for ${unitId} must confirm audible_review.${field}=true.`,
        );
      }
    }
    const actualCodes = normalizedFindingCodes(delivery.decision?.blockers);
    if (!actualCodes.length
      || !exactStringSet(actualCodes, accepted.reviewed_blocker_codes ?? [])) {
      throw new Error(
        `Narration delivery manual review for ${unitId} does not enumerate the exact blocker codes.`,
      );
    }
    if (!await fileMatchesSha256(source.wav, source.audio_sha256)) {
      throw new Error(`Narration delivery manual review audio is stale for ${unitId}.`);
    }
  }
  for (const rejected of rejectedUnits) {
    const unitId = String(rejected?.unit_id ?? "");
    const source = sourceById.get(unitId);
    const delivery = deliveryById.get(unitId);
    if (!source || !delivery
      || rejected.decision !== "repair_required"
      || rejected.provider !== source.provider
      || Number(rejected.attempt) !== Number(source.attempt ?? 1)
      || rejected.audio_path !== source.wav
      || rejected.audio_sha256 !== source.audio_sha256
      || rejected.synthesis_identity_sha256 !== source.synthesis_identity_sha256
      || !String(rejected.listen_note ?? "").trim()
      || !String(rejected.operator_quote ?? "").trim()) {
      throw new Error(`Narration delivery manual rejection is stale or incomplete for ${unitId}.`);
    }
    const actualCodes = normalizedFindingCodes(delivery.decision?.blockers);
    if (!actualCodes.length
      || !exactStringSet(actualCodes, rejected.reviewed_blocker_codes ?? [])) {
      throw new Error(
        `Narration delivery manual rejection for ${unitId} does not enumerate the exact blocker codes.`,
      );
    }
    if (!await fileMatchesSha256(source.wav, source.audio_sha256)) {
      throw new Error(`Narration delivery manual rejection audio is stale for ${unitId}.`);
    }
  }
  return {
    status: "approved",
    reviewer: String(evidence.reviewer).trim(),
    reviewed_at: String(evidence.reviewed_at).trim(),
    note: String(evidence.note).trim(),
    accepted_unit_ids: acceptedIds,
    accepted_unit_count: acceptedIds.length,
    rejected_unit_ids: rejectedIds,
    rejected_unit_count: rejectedIds.length,
    accepted_blocker_codes_by_unit: Object.fromEntries(
      acceptedUnits.map((row) => [
        String(row.unit_id),
        normalizedFindingCodes(row.reviewed_blocker_codes ?? []),
      ]),
    ),
    evidence_path: evidencePath,
  };
}

export function applyNarrationDeliveryManualReviewForTests({
  deliveryRows,
  blockers,
  review,
  evidenceSha256,
} = {}) {
  const acceptedIds = new Set(review.accepted_unit_ids.map(String));
  for (const row of deliveryRows) {
    if (!acceptedIds.has(String(row.unit_id))) continue;
    const originalBlockers = structuredClone(row.decision?.blockers ?? []);
    const reviewedWarnings = [
      ...(row.decision?.warnings ?? []).map((finding) => ({
        ...finding,
        review_required: false,
        manual_review_completed: true,
      })),
      ...originalBlockers.map((finding) => ({
        ...finding,
        severity: "warning",
        original_severity: finding.severity ?? "blocker",
        review_required: false,
        manual_review_completed: true,
        manual_review_disposition: "accepted_first_take_after_exact_listen",
      })),
    ];
    row.decision = {
      ...row.decision,
      status: "passed_with_warnings",
      blockers: [],
      warnings: reviewedWarnings,
      review_required: false,
      manual_review: {
        status: "approved",
        reviewer: review.reviewer,
        reviewed_at: review.reviewed_at,
        evidence_path: review.evidence_path,
        evidence_sha256: evidenceSha256,
        reviewed_blocker_codes: normalizedFindingCodes(originalBlockers),
      },
    };
    if (row.acoustic_qa?.delivery_qa_v2) {
      row.acoustic_qa.delivery_qa_v2 = structuredClone(row.decision);
    }
  }
  return blockers.filter(
    (finding) => !acceptedIds.has(String(finding?.unit_id ?? "")),
  );
}

function manualReviewMatchesFullStreamFinding({
  finding,
  defaultUnitIds = [],
  review,
} = {}) {
  const code = String(finding?.code ?? "").trim();
  if (!code) return [];
  const scopedUnitIds = [...new Set([
    String(finding?.unit_id ?? "").trim(),
    ...(finding?.unit_ids ?? []).map(String),
    ...defaultUnitIds.map(String),
  ].filter(Boolean))];
  return scopedUnitIds.filter((unitId) => (
    review?.accepted_blocker_codes_by_unit?.[unitId]?.includes(code)
  ));
}

function applyManualReviewToFullStreamDecision({
  decision,
  defaultUnitIds = [],
  review,
  evidenceSha256,
} = {}) {
  const remainingBlockers = [];
  const reviewedWarnings = [];
  for (const finding of decision?.blockers ?? []) {
    const matchedUnitIds = manualReviewMatchesFullStreamFinding({
      finding,
      defaultUnitIds,
      review,
    });
    if (!matchedUnitIds.length) {
      remainingBlockers.push(finding);
      continue;
    }
    reviewedWarnings.push({
      ...finding,
      severity: "warning",
      original_severity: finding.severity ?? "blocker",
      review_required: false,
      manual_review_completed: true,
      manual_review_disposition:
        "accepted_first_take_after_exact_listen",
      manual_review_matched_unit_ids: matchedUnitIds,
      manual_review_evidence_sha256: evidenceSha256,
    });
  }
  const warnings = [...(decision?.warnings ?? []), ...reviewedWarnings];
  return {
    ...decision,
    status: statusFor({ blockers: remainingBlockers, warnings }),
    blockers: remainingBlockers,
    warnings,
    review_required: warnings.some((finding) => finding.review_required === true),
    manual_review: reviewedWarnings.length ? {
      status: "approved",
      reviewer: review.reviewer,
      reviewed_at: review.reviewed_at,
      evidence_path: review.evidence_path,
      evidence_sha256: evidenceSha256,
      matched_finding_count: reviewedWarnings.length,
    } : null,
  };
}

export function applyNarrationFullStreamManualReviewForTests({
  fullStream,
  review,
  evidenceSha256,
} = {}) {
  const reviewed = structuredClone(fullStream);
  reviewed.confirmation_windows = (reviewed.confirmation_windows ?? []).map(
    (window) => ({
      ...window,
      decision: applyManualReviewToFullStreamDecision({
        decision: window.decision,
        defaultUnitIds: window.unit_ids ?? [],
        review,
        evidenceSha256,
      }),
    }),
  );
  reviewed.decision = applyManualReviewToFullStreamDecision({
    decision: reviewed.decision,
    review,
    evidenceSha256,
  });
  return reviewed;
}

function waveformQaWithoutVoiceAggregate(value) {
  if (!value || typeof value !== "object") return null;
  const qa = structuredClone(value);
  delete qa.voice_continuity;
  delete qa.delivery_qa_v2;
  delete qa.edge_alignment;
  qa.findings = (qa.findings ?? []).filter((finding) => !(
    /(?:voice_continuity|voice_similarity|voice_aggregate)/iu.test(
      String(finding?.code ?? ""),
    )
  ));
  const blockerCount = qa.findings.filter(
    (finding) => finding?.severity === "blocker",
  ).length;
  qa.status = blockerCount
    ? "blocked"
    : qa.findings.length ? "passed_with_warnings" : "passed";
  return qa;
}

export function conservativeNarrationEdgeAlignmentForTests({
  recognitions = [],
  transcriptQas = [],
  sampleCount,
  durationSec,
} = {}) {
  if (!Number.isInteger(sampleCount) || sampleCount <= 0) {
    return { status: "missing", reason: "invalid_sample_count" };
  }
  const edgeUncertain = transcriptQas.some((qa) => (
    !qa
    || Number(qa.leading_deletion_run ?? 0) > 0
    || Number(qa.trailing_deletion_run ?? 0) > 0
  ));
  if (edgeUncertain) {
    return {
      status: "missing",
      reason: "transcript_edge_uncertain_preserve_entire_unit",
    };
  }
  const usable = recognitions
    .map((recognition) => recognition?.words ?? [])
    .filter((words) => words.length > 0);
  if (!usable.length) {
    return { status: "missing", reason: "no_word_timestamps" };
  }
  const firstWords = usable.map((words) => words[0]);
  const finalWords = usable.map((words) => words.at(-1));
  const firstWord = firstWords.reduce((earliest, word) => (
    Number(word.start_sec ?? 0) < Number(earliest.start_sec ?? 0)
      ? word
      : earliest
  ));
  const finalWord = finalWords.reduce((latest, word) => (
    Number(word.end_sec ?? durationSec) > Number(latest.end_sec ?? durationSec)
      ? word
      : latest
  ));
  const firstSpeechSample = Math.max(0, Math.round(
    Math.min(...firstWords.map((word) => Number(word.start_sec ?? 0)))
      * CANONICAL_SAMPLE_RATE_HZ,
  ));
  const lastSpeechSampleExclusive = Math.min(sampleCount, Math.max(
    firstSpeechSample + 1,
    Math.round(
      Math.max(...finalWords.map((word) => Number(word.end_sec ?? durationSec)))
        * CANONICAL_SAMPLE_RATE_HZ,
    ),
  ));
  return {
    status: "passed",
    engine: "faster_whisper_conservative_consensus_envelope_v2",
    sample_rate_hz: CANONICAL_SAMPLE_RATE_HZ,
    first_speech_sample: firstSpeechSample,
    last_speech_sample_exclusive: lastSpeechSampleExclusive,
    first_word: firstWord,
    final_word: finalWord,
  };
}

function joinQaFromStitch(stitch) {
  const blockers = stitch?.boundary_qa?.blockers ?? [];
  const warnings = stitch?.boundary_qa?.warnings ?? [];
  return {
    schema: "goldflow_narration_semantic_join_qa_v2",
    status: statusFor({ blockers, warnings }),
    sample_rate_hz: CANONICAL_SAMPLE_RATE_HZ,
    boundary_count: stitch?.boundaries?.length ?? 0,
    joins: (stitch?.boundaries ?? []).map((boundary) => ({
      boundary_id: boundary.boundary_id,
      after_unit_id: boundary.after_unit_id,
      before_unit_id: boundary.before_unit_id,
      boundary_class: boundary.boundary_class,
      retained_natural_silence_sample_count:
        boundary.retained_natural_silence_sample_count,
      inserted_silence_sample_count: boundary.inserted_silence_sample_count,
      effective_pause_sample_count: boundary.effective_pause_sample_count,
      effective_pause_ms: boundary.effective_pause_ms,
      status: (boundary.blockers ?? []).length ? "blocked" : "passed",
    })),
    blockers,
    warnings,
  };
}

async function audioSampleCount(audioPath) {
  const { stdout } = await execFile("ffprobe", [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=sample_rate,duration_ts,time_base",
    "-of", "json",
    audioPath,
  ]);
  const stream = JSON.parse(stdout)?.streams?.[0] ?? {};
  const sampleRate = Number(stream.sample_rate);
  const durationTs = Number(stream.duration_ts);
  const timeBase = String(stream.time_base ?? "");
  const [numerator, denominator] = timeBase.split("/").map(Number);
  if (!Number.isInteger(sampleRate) || sampleRate <= 0
    || !Number.isInteger(durationTs) || durationTs <= 0
    || !Number.isFinite(numerator) || !Number.isFinite(denominator)
    || numerator <= 0 || denominator <= 0) {
    throw new Error(`Cannot prove exact sample count for ${audioPath}.`);
  }
  const samples = Math.round(durationTs * numerator / denominator * sampleRate);
  if (!Number.isInteger(samples) || samples <= 0) {
    throw new Error(`Invalid exact sample count for ${audioPath}.`);
  }
  return { sample_rate_hz: sampleRate, sample_count: samples };
}

export async function narrationAudioSampleCountForTests(audioPath) {
  return audioSampleCount(audioPath);
}

async function extractConfirmationWindow({
  audioPath,
  outputPath,
  startSample,
  endSampleExclusive,
  sampleRateHz,
}) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await execFile("ffmpeg", [
    "-y", "-nostdin", "-hide_banner", "-v", "error",
    "-i", audioPath,
    "-af", `atrim=start_sample=${startSample}:end_sample=${endSampleExclusive},asetpts=N/SR/TB`,
    "-ar", String(sampleRateHz),
    "-ac", "1",
    "-acodec", "pcm_s16le",
    outputPath,
  ]);
  const probe = await audioSampleCount(outputPath);
  const expectedSamples = endSampleExclusive - startSample;
  if (probe.sample_rate_hz !== sampleRateHz
    || probe.sample_count !== expectedSamples) {
    throw new Error(
      `Confirmation window sample mismatch for ${outputPath}: `
      + `expected ${expectedSamples}, got ${probe.sample_count}.`,
    );
  }
  return {
    audio_path: outputPath,
    audio_sha256: await sha256File(outputPath),
    sample_rate_hz: sampleRateHz,
    sample_count: probe.sample_count,
  };
}

function localizedConsensusDecision({
  windowRows,
  orderQa,
  joinQa,
  primaryModel,
  confirmationModel,
}) {
  const blockers = [
    ...(orderQa?.blockers ?? []),
    ...(joinQa?.blockers ?? []),
  ];
  const warnings = [...(joinQa?.warnings ?? [])];
  for (const row of windowRows) {
    const scope = {
      confirmation_window_id: row.window_id,
      unit_ids: row.unit_ids,
      ...(row.unit_ids.length === 1 ? { unit_id: row.unit_ids[0] } : {}),
      ...(row.boundary_ids.length === 1
        ? { boundary_id: row.boundary_ids[0] }
        : {}),
    };
    blockers.push(...(row.decision?.blockers ?? []).map((finding) => ({
      ...finding,
      ...scope,
    })));
    warnings.push(...(row.decision?.warnings ?? []).map((finding) => ({
      ...finding,
      ...scope,
    })));
  }
  return {
    schema: "goldflow_narration_localized_delivery_consensus_v1",
    status: blockers.length ? "blocked" : warnings.length ? "passed_with_warnings" : "passed",
    primary_model: primaryModel,
    confirmation_model: confirmationModel,
    confirmation_required: windowRows.length > 0,
    review_required: warnings.some((finding) => finding.review_required === true),
    blockers,
    warnings,
  };
}

export function narrationFullStreamDerivedDecisionsCurrent(fullStream, comparisonVersion) {
  return fullStream?.transcript_comparison_version === comparisonVersion
    && fullStream?.delivery_consensus_version === NARRATION_DELIVERY_CONSENSUS_VERSION;
}

export async function runFullStreamDeliveryQa({
  helpers,
  audioPath,
  audioSha256,
  units,
  qualityContract,
  orderQa,
  joinQa,
  stitch,
  workDir,
  localWhisperContract,
  retainedEvidence = null,
}) {
  const intendedText = units.map((unit) => (
    String(unit.spoken_text ?? unit.tts_spoken_text ?? "").trim()
  )).filter(Boolean).join(" ");
  const primaryModel = qualityContract.delivery_qa.full_stream_screening_model
    ?? "small.en";
  const confirmationModel = qualityContract.delivery_qa.full_stream_confirmation_model
    ?? "medium";
  const priorConfirmationEvidence = [
    ...(retainedEvidence?.retained_confirmation_evidence ?? []),
    ...(retainedEvidence?.confirmation_windows ?? []),
  ];
  if (primaryModel !== localWhisperContract.model) {
    throw new Error(
      `Full-stream screening model ${primaryModel} does not match the locked `
      + `official timing model ${localWhisperContract.model}.`,
    );
  }
  // The caller admits retained evidence only for the same full-stream input
  // key and verified window audio hashes. A comparator revision invalidates
  // derived decisions, not the unchanged recognizer output.
  const primary = retainedEvidence?.primary_transcription
    ?? await runFasterWhisperForDiagnostics(audioPath, localWhisperContract);
  const equivalentPhrases = units.flatMap((unit) => equivalentPhrasesForTests(unit));
  const primaryTranscriptQa = primary
    ? helpers.transcriptQaForTests(intendedText, primary.text, {
        maxWer: qualityContract.delivery_qa.maximum_word_error_rate,
        equivalentPhrases,
        blockAnySubstitution: false,
      })
    : null;
  const primaryDecision = strictNarrationDeliveryDecision(primaryTranscriptQa, {
    orderQa,
    joinQa,
    contract: qualityContract,
  });
  const confirmationRequired = qualityContract.delivery_qa
    .full_stream_dual_asr_on_any_difference === true
      ? narrationDeliveryNeedsConfirmation(primaryTranscriptQa, primaryDecision)
      : primaryDecision.blockers.length > 0;
  let windowPlan = null;
  let confirmationWindows = [];
  let decision = primaryDecision;
  if (confirmationRequired) {
    const probe = await audioSampleCount(audioPath);
    if (probe.sample_rate_hz !== CANONICAL_SAMPLE_RATE_HZ) {
      throw new Error(
        `Canonical narration sample rate is ${probe.sample_rate_hz}; `
        + `${CANONICAL_SAMPLE_RATE_HZ} is required for exact confirmation windows.`,
      );
    }
    const timeline = narrationUnitTimeline({
      plan: { units },
      stitch,
      sampleRateHz: CANONICAL_SAMPLE_RATE_HZ,
    });
    const mappedUnits = units.map((unit) => ({
      ...unit,
      canonical_token_count: helpers.transcriptQaForTests(
        String(unit.spoken_text ?? unit.tts_spoken_text ?? ""),
        String(unit.spoken_text ?? unit.tts_spoken_text ?? ""),
        { equivalentPhrases: equivalentPhrasesForTests(unit) },
      ).intended_canonical_token_count,
    }));
    windowPlan = planNarrationConfirmationWindows({
      units: mappedUnits,
      timeline: timeline.rows,
      operations: primaryTranscriptQa?.operations ?? [],
      audioSampleCount: probe.sample_count,
    });
    if (windowPlan.status !== "passed" || windowPlan.window_count === 0) {
      decision = {
        ...primaryDecision,
        schema: "goldflow_narration_localized_delivery_consensus_v1",
        status: "blocked",
        confirmation_required: true,
        confirmation_model: confirmationModel,
        review_required: true,
        blockers: [
          ...(primaryDecision.blockers ?? []),
          ...((windowPlan?.blockers?.length ? windowPlan.blockers : [{
            code: "narration_confirmation_window_scope_empty",
          }]).map((finding) => ({
            ...finding,
            severity: "blocker",
          }))),
        ],
      };
    } else {
      const windowDir = path.join(workDir, "full-stream-confirmation-windows");
      const materialized = [];
      const retainedWindows = new Map(priorConfirmationEvidence
        .map((window) => [window.binding_sha256, window]));
      const cachedConfirmations = new Map();
      for (const window of windowPlan.windows) {
        const bindingSha256 = sha256(JSON.stringify({
          source_audio_sha256: audioSha256,
          start_sample: window.start_sample,
          end_sample_exclusive: window.end_sample_exclusive,
          intended_text_sha256: window.intended_text_sha256,
          unit_ids: window.unit_ids,
          boundary_ids: window.boundary_ids,
        }));
        const outputPath = path.join(
          windowDir,
          `${window.window_id}-${bindingSha256.slice(0, 12)}.wav`,
        );
        const retained = retainedWindows.get(bindingSha256);
        const audio = retained ?? await extractConfirmationWindow({
          audioPath,
          outputPath,
          startSample: window.start_sample,
          endSampleExclusive: window.end_sample_exclusive,
          sampleRateHz: CANONICAL_SAMPLE_RATE_HZ,
        });
        if (retained?.confirmation_recognized_text != null
          && (retained.confirmation_model ?? retainedEvidence.confirmation_model) === confirmationModel) {
          cachedConfirmations.set(window.window_id, {
            text: retained.confirmation_recognized_text,
            words: retained.confirmation_recognized_words ?? [],
          });
        }
        materialized.push({
          ...audio,
          ...window,
          source_audio_path: audioPath,
          source_audio_sha256: audioSha256,
          binding_sha256: bindingSha256,
        });
      }
      const needsConfirmation = materialized.filter((window) => (
        !cachedConfirmations.has(window.window_id)
      ));
      const freshConfirmations = needsConfirmation.length
        ? await helpers.runFasterWhisperUnitBatchForDiagnostics(
            needsConfirmation.map((window) => ({
              unit_id: window.window_id,
              wav: window.audio_path,
            })),
            { model: confirmationModel, device: "cpu", computeType: "int8_float32" },
          ) : new Map();
      const confirmationMap = new Map([...cachedConfirmations, ...freshConfirmations]);
      confirmationWindows = materialized.map((window) => {
        const startSec = window.start_sample / CANONICAL_SAMPLE_RATE_HZ;
        const endSec = window.end_sample_exclusive / CANONICAL_SAMPLE_RATE_HZ;
        const primaryWords = (primary?.words ?? []).filter((word) => (
          Number(word.end_sec ?? 0) > startSec
            && Number(word.start_sec ?? 0) < endSec
        ));
        const primaryText = primaryWords.map((word) => word.word).join(" ");
        const confirmation = confirmationMap.get(window.window_id) ?? null;
        const scopedUnits = units.filter((unit) => (
          window.unit_ids.includes(String(unit.unit_id))
        ));
        const scopedEquivalences = scopedUnits.flatMap(equivalentPhrasesForTests);
        const primaryQa = helpers.transcriptQaForTests(
          window.intended_text,
          primaryText,
          {
            maxWer: qualityContract.delivery_qa.maximum_word_error_rate,
            equivalentPhrases: scopedEquivalences,
            blockAnySubstitution: false,
          },
        );
        const confirmationQa = confirmation
          ? helpers.transcriptQaForTests(
              window.intended_text,
              confirmation.text,
              {
                maxWer: qualityContract.delivery_qa.maximum_word_error_rate,
                equivalentPhrases: scopedEquivalences,
                blockAnySubstitution: false,
              },
            )
          : null;
        const windowDecision = adjudicateNarrationDeliveryConsensus({
          primaryTranscriptQa: primaryQa,
          confirmationTranscriptQa: confirmationQa,
          orderQa: { blockers: [] },
          joinQa: { blockers: [], warnings: [] },
          contract: qualityContract,
          primaryModel,
          confirmationModel,
        });
        return {
          ...window,
          primary_recognized_text: primaryText,
          primary_recognized_words: primaryWords,
          primary_transcript_qa: primaryQa,
          confirmation_recognized_text: confirmation?.text ?? null,
          confirmation_recognized_words: confirmation?.words ?? [],
          confirmation_model: confirmationModel,
          confirmation_transcript_qa: confirmationQa,
          decision: windowDecision,
        };
      });
      decision = localizedConsensusDecision({
        windowRows: confirmationWindows,
        orderQa,
        joinQa,
        primaryModel,
        confirmationModel,
      });
    }
  } else {
    decision = adjudicateNarrationDeliveryConsensus({
      primaryTranscriptQa,
      confirmationTranscriptQa: primaryTranscriptQa,
      orderQa,
      joinQa,
      contract: qualityContract,
      primaryModel,
      confirmationModel,
    });
  }
  return {
    transcript_comparison_version: helpers.TRANSCRIPT_QA_COMPARISON_VERSION,
    delivery_consensus_version: NARRATION_DELIVERY_CONSENSUS_VERSION,
    intended_text: intendedText,
    intended_text_sha256: sha256(intendedText),
    primary_model: primaryModel,
    primary_recognized_text: primary?.text ?? null,
    primary_recognized_words: primary?.words ?? [],
    primary_transcript_qa: primaryTranscriptQa,
    confirmation_required: confirmationRequired,
    primary_transcription: primary,
    primary_alignment_contract: localWhisperContract,
    confirmation_scope: confirmationRequired
      ? "exact_hash_bound_suspect_and_boundary_windows"
      : "not_required",
    confirmation_model: confirmationRequired ? confirmationModel : null,
    confirmation_recognized_text: confirmationWindows
      .map((window) => window.confirmation_recognized_text)
      .filter(Boolean)
      .join(" ") || null,
    confirmation_recognized_words: confirmationWindows.flatMap(
      (window) => window.confirmation_recognized_words ?? [],
    ),
    confirmation_transcript_qa: null,
    confirmation_window_plan: windowPlan,
    confirmation_windows: confirmationWindows,
    // Retire obsolete comparison scopes without deleting the raw ASR evidence
    // or letting their old decisions influence current QA.
    retained_confirmation_evidence: [...new Map(priorConfirmationEvidence
      .filter((window) => !confirmationWindows.some((current) => (
        current.binding_sha256 === window.binding_sha256
      )))
      .map((window) => {
        const { primary_transcript_qa: _primaryQa, confirmation_transcript_qa: _confirmationQa,
          decision: _decision, ...raw } = window;
        return [window.binding_sha256, { ...raw,
          confirmation_model: window.confirmation_model ?? retainedEvidence.confirmation_model }];
      })).values()],
    decision,
  };
}

async function encodeM4a(inputPath, outputPath) {
  await execFile("ffmpeg", [
    "-y", "-nostdin", "-hide_banner", "-v", "error",
    "-i", inputPath,
    "-c:a", "aac", "-b:a", "192k",
    outputPath,
  ]);
  return sha256File(outputPath);
}

export async function finalizeNarrationProviderOutput(
  argv = process.argv.slice(2),
  { phaseContext = null } = {},
) {
  const flags = parseFlags(argv);
  if (!flags["episode-dir"]) throw new Error("--episode-dir is required.");
  if (phaseContext) validateOpeningFinalizationFlags(flags);
  const workflowBypass = boolFlag(flags["workflow-bypass"]);
  const acceptAsrDeliveryBlockers = boolFlag(
    flags["accept-asr-delivery-blockers"],
  );
  const fullStreamReviewEvidencePath = String(flags["full-stream-review-evidence"] ?? "").trim()
    ? path.resolve(flags["full-stream-review-evidence"]) : null;
  if (fullStreamReviewEvidencePath && acceptAsrDeliveryBlockers) {
    throw new Error("Exact full-stream review cannot be combined with --accept-asr-delivery-blockers.");
  }
  const acceptReviewWarnings = boolFlag(flags["accept-review-warnings"]);
  const skipSubjectiveReview = boolFlag(flags["skip-subjective-review"]);
  const deliveryWaiverReason = String(
    flags["delivery-waiver-reason"] ?? "",
  ).trim();
  for (const [requested, label] of [
    [acceptAsrDeliveryBlockers, "ASR-only delivery waiver"],
    [acceptReviewWarnings, "narration review-warning waiver"],
    [skipSubjectiveReview, "subjective narration-review waiver"],
  ]) {
    assertOperatorNarrationWaiver({
      requested,
      workflowBypass,
      reason: deliveryWaiverReason,
      label,
    });
  }
  const episodeDir = path.resolve(flags["episode-dir"]);
  const identityPath = path.join(episodeDir, "run_identity.json");
  const identity = await readJson(identityPath, {});
  if (identity.media_workflow === "avatar_footage_pilot_v1" && !phaseContext) {
    throw new Error("Pilot narration requires the guarded opening-phase finalizer context; generic/full finalization is unavailable.");
  }
  const localWhisperIdentity = validateLocalWhisperIdentityContract(identity);
  if (!localWhisperIdentity.done) {
    throw new Error(localWhisperIdentity.evidence);
  }
  const officialLocalWhisperContract = localWhisperContractForIdentity(identity);
  const episode = String(identity.episode ?? flags.episode ?? "ep_01");
  const planPath = path.resolve(
    flags.plan ?? path.join(episodeDir, "narration_generation_plan.json"),
  );
  const manifestPath = path.resolve(
    flags.manifest
      ?? path.join(episodeDir, `narration_provider_output_manifest_${episode}.json`),
  );
  const [
    plan,
    manifest,
    planFileSha256,
    manifestFileSha256,
    identityFileSha256,
  ] = await Promise.all([
    readJson(planPath),
    readJson(manifestPath),
    sha256File(planPath),
    sha256File(manifestPath),
    sha256File(identityPath),
  ]);
  if (!plan || !manifest) {
    throw new Error("Narration plan and provider output manifest are required.");
  }
  let units = planUnits(plan);
  if (!units.length) throw new Error("Narration plan contains no synthesis units.");
  const policy = validateNarrationTtsPolicy(
    narrationTtsPolicyForIdentity(identity),
    { production: true },
  );
  const qualityContract = narrationQualityContractForIdentity(identity)
    ?? buildNarrationQualityContract({
      provider: manifest.provider,
      modelId: manifest.model_id,
      modelRevision: manifest.model_revision,
    });
  if (qualityContract.contract_sha256 !== policy.narration_quality_contract?.contract_sha256) {
    throw new Error("Narration quality contract differs from the identity-locked TTS policy.");
  }
  const canonicalPlanSha256 = plan.plan_sha256 ?? planFileSha256;
  // Verify the actual approved source before any output directory, QA helper,
  // ASR or voice model can be touched. Keep the later recheck for mid-run changes.
  const scriptPath = path.resolve(flags.script ?? path.join(episodeDir, "script_clean.md"));
  const actualSourceScriptSha256 = await sha256File(scriptPath);
  if (sourceScriptHash(plan) && actualSourceScriptSha256 !== sourceScriptHash(plan)) {
    throw new Error("Narration plan source hash differs from the actual approved script.");
  }
  const sourceStructure = !phaseContext ? await loadNarrationSourceStructure({
    episodeDir, episode, plan,
    sourceScriptSha256: actualSourceScriptSha256,
    generationPlanSha256: canonicalPlanSha256,
    generationPlanFileSha256: planFileSha256,
  }) : null;
  const preparePilotPhase = phaseContext?.phase === "full_pilot" ? prepareFullPilotNarrationFinalization : prepareOpeningNarrationFinalization;
  const pilotFinalization = phaseContext ? await preparePilotPhase({
    phaseContext, episodeDir, identityPath, identity, scriptPath, planPath, plan, manifestPath, manifest, policy, flags,
  }) : null;
  if (pilotFinalization) units = pilotFinalization.units;
  const artifactDir = pilotFinalization?.outputNamespace ?? episodeDir;
  const fullStreamPath = path.join(artifactDir, `narration_full_stream_qa_${episode}.json`);
  // Validate before checkpoint/report writes. This mode consumes a reviewed
  // snapshot and retained media; it cannot rebuild media or refresh ASR.
  const fullStreamManualReview = fullStreamReviewEvidencePath
    ? await loadFullStreamManualReview({
      evidencePath: fullStreamReviewEvidencePath, currentReportPath: fullStreamPath,
      expectedBindings: {
        source_script_hash: actualSourceScriptSha256,
        narration_generation_plan_sha256: canonicalPlanSha256,
        narration_generation_plan_file_sha256: planFileSha256,
        narration_quality_contract_sha256: qualityContract.contract_sha256,
      },
      providerManifestSha256: manifestFileSha256,
      unitReviewEvidencePath: flags["manual-review-evidence"]
        ? path.resolve(flags["manual-review-evidence"]) : null,
    }) : null;
  const scopeFields = pilotFinalization ? { finalization_scope: pilotFinalization.scope } : {};
  const operatorNarrationWaiver = {
    schema: "goldflow_operator_narration_qa_waiver_v1",
    waiver_id: sha256(JSON.stringify({
      canonical_plan_sha256: canonicalPlanSha256,
      provider_output_manifest_sha256: manifestFileSha256,
      reason: deliveryWaiverReason,
      accept_asr_delivery_blockers: acceptAsrDeliveryBlockers,
      accept_review_warnings: acceptReviewWarnings,
      skip_subjective_review: skipSubjectiveReview,
    })),
    status: "operator_authorized",
    reason: deliveryWaiverReason || null,
    workflow_bypass: workflowBypass,
    human_listening_performed: false,
    no_resynthesis_authorized: true,
    accept_asr_delivery_blockers: acceptAsrDeliveryBlockers,
    accept_review_warnings: acceptReviewWarnings,
    skip_subjective_review: skipSubjectiveReview,
    narration_generation_plan_sha256: canonicalPlanSha256,
    narration_generation_plan_file_sha256: planFileSha256,
    provider_output_manifest_file_sha256: manifestFileSha256,
  };
  const manifestValidation = validateNarrationProviderOutputManifest(
    manifest,
    units,
    {
      generationPlanSha256: canonicalPlanSha256,
      generationPlanFileSha256: planFileSha256,
      qualityContractSha256: qualityContract.contract_sha256,
      provider: policy.primary.provider,
      voiceId: policy.primary.voice_id,
      voiceSha256: policy.primary.voice_sha256,
    },
  );
  if (manifestValidation.status !== "passed") {
    throw new Error(
      `Provider manifest is stale: ${manifestValidation.findings
        .map((finding) => finding.code)
        .join(", ")}`,
    );
  }
  if (manifest.model_id !== policy.primary.model_id
    || manifest.model_revision !== policy.primary.model_revision
    || manifest.voice_continuity_contract
      !== policy.primary.voice_continuity_contract) {
    throw new Error("Provider manifest model or voice identity differs from run identity.");
  }

  const manifestById = new Map(
    manifest.units.map((row) => [String(row.unit_id), row]),
  );
  for (const row of manifest.units) {
    if (await sha256File(row.audio_path) !== row.audio_sha256) {
      throw new Error(`Provider audio hash is stale for ${row.unit_id}.`);
    }
  }
  const workDir = pilotFinalization ? path.join(artifactDir, "audio") : path.resolve(
    flags["output-dir"]
      ?? path.join(episodeDir, "assets/audio/narration_provider_neutral"),
  );
  if (pilotFinalization) await fs.mkdir(artifactDir, { recursive: false });
  await fs.mkdir(workDir, { recursive: true });
  const checkpointPath = path.resolve(
    flags["checkpoint"]
      ?? path.join(workDir, `narration-finalization-checkpoint-${episode}.json`),
  );
  const reviewContinuation = pilotFinalization?.reviewContinuation ?? null;
  const priorCheckpoint = reviewContinuation
    ? structuredClone(reviewContinuation.checkpoint)
    : await readJson(checkpointPath, null);
  const checkpoint = priorCheckpoint?.schema
    === "goldflow_narration_finalization_checkpoint_v1"
      ? priorCheckpoint
      : emptyNarrationFinalizationCheckpoint({});
  checkpoint.status = "in_progress";
  checkpoint.context = {
    ...scopeFields,
    narration_generation_plan_sha256: canonicalPlanSha256,
    narration_generation_plan_file_sha256: planFileSha256,
    provider_output_manifest_sha256:
      manifest.manifest_sha256 ?? manifestFileSha256,
    provider_output_manifest_file_sha256: manifestFileSha256,
    narration_quality_contract_sha256: qualityContract.contract_sha256,
    provider: manifest.provider,
    model_id: manifest.model_id,
    model_revision: manifest.model_revision,
    voice_id: manifest.voice_id,
    voice_sha256: manifest.voice_sha256,
    voice_continuity_contract: manifest.voice_continuity_contract,
  };
  checkpoint.units ??= {};
  checkpoint.stages ??= {};
  if (reviewContinuation) {
    // The operator reviewed the old raw stream, not a new master. Only exact
    // unit QA and the semantic stitch are reusable across this boundary.
    for (const stage of ["mastering", "full_stream_delivery_qa", "encode_m4a", "local_whisper_timing_candidate"]) {
      delete checkpoint.stages[stage];
    }
  }
  const helpers = await import("./modelslab-qwen-episode-audio.mjs");
  const rows = units.map((unit, orderIndex) => {
    const output = manifestById.get(String(unit.unit_id));
    const spokenText = String(unit.spoken_text ?? unit.tts_spoken_text ?? "");
    return {
      ...unit,
      order_index: orderIndex,
      text: spokenText,
      spoken_text: spokenText,
      spoken_text_sha256: unit.spoken_text_sha256 ?? sha256(spokenText),
      provider: manifest.provider,
      model_id: output.model_id,
      model_revision: output.model_revision,
      voice_id: output.voice_id,
      voice_sha256: output.voice_sha256,
      voice_continuity_contract: output.voice_continuity_contract,
      wav: output.audio_path,
      audio_path: output.audio_path,
      audio_sha256: output.audio_sha256,
      duration_sec: output.duration_sec,
      token_limit_reached: output.token_limit_reached === true,
      attempt: output.attempt ?? 1,
      synthesis_mode: output.synthesis_mode ?? null,
      batch_plan_sha256: output.batch_plan_sha256 ?? null,
      cohort_id: output.cohort_id ?? null,
      cohort_sha256: output.cohort_sha256 ?? null,
      generated_token_count: output.generated_token_count ?? null,
      effective_token_limit: output.effective_token_limit ?? null,
      recovery_provenance: output.recovery_provenance ?? null,
      synthesis_identity: output.synthesis_identity ?? null,
      synthesis_identity_sha256: output.synthesis_identity_sha256,
      runner_report_path: output.runner_report_path ?? null,
      runner_report_sha256: output.runner_report_sha256 ?? null,
      provider_receipt: output.provider_receipt,
      provider_unit_qa: output.provider_unit_qa ?? null,
      provider_unit_qa_sha256: output.provider_unit_qa_sha256 ?? null,
      unit_qa: output.provider_unit_qa
        ? waveformQaWithoutVoiceAggregate(output.provider_unit_qa)
        : null,
      audio_hash_verified: true,
    };
  });
  for (const row of rows) {
    row.finalization_unit_key = narrationFinalizationUnitKey({
      unit: row,
      qualityContractSha256: qualityContract.contract_sha256,
      provider: manifest.provider,
      modelId: manifest.model_id,
      modelRevision: manifest.model_revision,
      voiceId: manifest.voice_id,
      voiceSha256: manifest.voice_sha256,
      voiceContinuityContract: manifest.voice_continuity_contract,
    });
    const cached = reusableNarrationFinalizationUnit(
      checkpoint,
      row.unit_id,
      row.finalization_unit_key,
    );
    if (!row.unit_qa && cached?.acoustic_qa) {
      row.unit_qa = waveformQaWithoutVoiceAggregate(cached.acoustic_qa);
    }
  }

  const continuityPath = path.join(
    artifactDir,
    `narration_voice_continuity_qa_${episode}.json`,
  );
  const similarityEvidencePath = path.join(
    artifactDir,
    `narration_speaker_similarity_${episode}.json`,
  );
  const cachedPrimaryMap = new Map();
  const embeddedPrimaryMap = new Map();
  const primaryRecognitionSourceById = new Map();
  const embeddedPrimaryReuseDecisions = [];
  const primaryNeeds = [];
  const primaryAsrContract = buildNarrationProviderUnitAsrContract({
    model: qualityContract.delivery_qa.unit_screening_model ?? "small.en",
    device: "cpu",
    computeType: "int8_float32",
  });
  for (const row of rows) {
    const cached = reusableNarrationFinalizationUnit(
      checkpoint,
      row.unit_id,
      row.finalization_unit_key,
    );
    if (cached?.primary_recognition) {
      cachedPrimaryMap.set(String(row.unit_id), cached.primary_recognition);
      primaryRecognitionSourceById.set(
        String(row.unit_id),
        cached.primary_recognition_source ?? "finalization_checkpoint",
      );
    } else {
      const embeddedReuse = validateNarrationProviderUnitAsrReuse({
        unitId: row.unit_id,
        audioSha256: row.audio_sha256,
        audioHashVerified: row.audio_hash_verified,
        providerUnitQa: row.provider_unit_qa,
        providerUnitQaSha256: row.provider_unit_qa_sha256,
        narrationQualityContractSha256: qualityContract.contract_sha256,
        expectedAsrContract: primaryAsrContract,
        providerUnitQaContentSha256: narrationProviderUnitQaSha256,
      });
      embeddedPrimaryReuseDecisions.push({
        unit_id: row.unit_id,
        status: embeddedReuse.status,
        findings: embeddedReuse.findings,
      });
      if (embeddedReuse.recognition) {
        embeddedPrimaryMap.set(String(row.unit_id), embeddedReuse.recognition);
        primaryRecognitionSourceById.set(
          String(row.unit_id),
          "provider_unit_qa_exact_bound_small_asr",
        );
      } else {
        primaryNeeds.push({ unit_id: row.unit_id, wav: row.wav });
        primaryRecognitionSourceById.set(
          String(row.unit_id),
          "fresh_finalizer_small_asr",
        );
      }
    }
  }
  const voiceContinuityInputKey = narrationFinalizationStageKey(
    "voice_continuity",
    {
      unit_keys: rows.map((row) => row.finalization_unit_key),
      quality_contract_sha256: qualityContract.contract_sha256,
      reference_manifest_sha256: policy.primary.reference_manifest_sha256,
      similarity_model_sha256: policy.primary.speaker_similarity_model_sha256,
      similarity_calibration_sha256:
        policy.primary.speaker_similarity_calibration_sha256,
    },
  );
  const cachedContinuityStage = reusableNarrationFinalizationStage(
    checkpoint,
    "voice_continuity",
    voiceContinuityInputKey,
  );
  const embeddedContinuityRows = rows.map(
    (row) => row.provider_unit_qa?.voice_continuity ?? null,
  );
  const embeddedContinuityPaths = new Set(
    embeddedContinuityRows.map((row) => row?.report_path).filter(Boolean),
  );
  const embeddedContinuityHashes = new Set(
    embeddedContinuityRows.map((row) => row?.report_sha256).filter(Boolean),
  );
  const embeddedContinuityComplete = embeddedContinuityRows.every(Boolean)
    && embeddedContinuityPaths.size === 1
    && embeddedContinuityHashes.size === 1;
  const reuseContinuityPath = cachedContinuityStage?.payload?.report_path
    ?? (embeddedContinuityComplete ? [...embeddedContinuityPaths][0] : null);
  const reuseContinuitySha256 = cachedContinuityStage?.payload?.report_sha256
    ?? (embeddedContinuityComplete ? [...embeddedContinuityHashes][0] : null);
  if (fullStreamManualReview && primaryNeeds.length) {
    throw new Error("Exact full-stream review requires retained unit ASR; refresh QA separately.");
  }
  const [acousticQa, freshPrimaryMap, voiceContinuity] = await Promise.all([
    helpers.runUnitOutputQaForDiagnostics(rows, {
      reuseHashValidQa: true,
    }),
    primaryNeeds.length
      ? helpers.runFasterWhisperUnitBatchForDiagnostics(
          primaryNeeds,
          {
            model: qualityContract.delivery_qa.unit_screening_model ?? "small.en",
            device: "cpu",
            computeType: "int8_float32",
          },
        )
      : Promise.resolve(new Map()),
    runNarrationVoiceContinuityQa({
      rows,
      profile: policy.primary,
      qualityContract,
      reportPath: similarityEvidencePath,
      reuseReportPath: reuseContinuityPath,
      reuseReportSha256: reuseContinuitySha256,
    }),
  ]);
  const primaryMap = new Map([
    ...cachedPrimaryMap,
    ...embeddedPrimaryMap,
    ...freshPrimaryMap,
  ]);
  checkpoint.stages.voice_continuity = {
    input_key: voiceContinuityInputKey,
    status: voiceContinuity.status === "blocked" ? "blocked" : "passed",
    payload: {
      report_path: voiceContinuity.report_path,
      report_sha256: voiceContinuity.report_sha256,
      reused_exact_hash_report:
        voiceContinuity.reused_exact_hash_report === true,
    },
  };
  await atomicWriteJson(continuityPath, voiceContinuity);
  // Read after exact continuity evidence is available. No sidecar preserves the
  // existing review policy; an explicit receipt changes only named low margins.
  const lowMarginDisposition = await loadLowMarginDisposition({ episodeDir, episode });
  if (lowMarginDisposition && phaseContext) {
    throw new Error("Low-margin policy disposition is not supported for proof-phase finalization.");
  }
  assertLowMarginActiveBindings(lowMarginDisposition, {
    source_script_sha256: actualSourceScriptSha256,
    run_identity_sha256: identityFileSha256,
    narration_generation_plan_file_sha256: planFileSha256,
    provider_output_manifest_file_sha256: manifestFileSha256,
    speaker_similarity_file_sha256: voiceContinuity.report_sha256,
    narration_generation_plan_sha256: canonicalPlanSha256,
    narration_quality_contract_sha256: qualityContract.contract_sha256,
  });
  const lowMarginProvenance = lowMarginDisposition
    ? { voice_low_margin_disposition: lowMarginDisposition } : {};
  const continuityArtifactSha256 = await sha256File(continuityPath);
  const primaryById = new Map();
  const confirmationCandidates = [];
  const cachedConfirmationMap = new Map();
  const confirmationRequiredIds = new Set();
  for (const row of rows) {
    const recognized = primaryMap.get(String(row.unit_id)) ?? null;
    const transcriptQa = recognized
      ? helpers.transcriptQaForTests(row.text, recognized.text, {
          maxWer: qualityContract.delivery_qa.maximum_word_error_rate,
          equivalentPhrases: equivalentPhrasesForTests(row),
          blockAnySubstitution: false,
        })
      : null;
    const decision = strictNarrationDeliveryDecision(transcriptQa, {
      orderQa: { blockers: [] },
      joinQa: { blockers: [], warnings: [] },
      contract: qualityContract,
    });
    primaryById.set(String(row.unit_id), { recognized, transcriptQa, decision });
    const cached = reusableNarrationFinalizationUnit(
      checkpoint,
      row.unit_id,
      row.finalization_unit_key,
    );
    // Keep the raw confirmation even when a comparison repair removes the
    // need for it. It remains evidence; only the decision is recomputed.
    if (cached?.confirmation_recognition) {
      cachedConfirmationMap.set(String(row.unit_id), cached.confirmation_recognition);
    }
    if (narrationDeliveryNeedsConfirmation(transcriptQa, decision)) {
      confirmationRequiredIds.add(String(row.unit_id));
      if (!cached?.confirmation_recognition) {
        confirmationCandidates.push({ unit_id: row.unit_id, wav: row.wav });
      }
    }
  }
  if (fullStreamManualReview && confirmationCandidates.length) {
    throw new Error("Exact full-stream review requires retained unit confirmation ASR; refresh QA separately.");
  }
  for (const row of rows) {
    const primary = primaryById.get(String(row.unit_id));
    const cached = reusableNarrationFinalizationUnit(
      checkpoint,
      row.unit_id,
      row.finalization_unit_key,
    );
    checkpoint.units[String(row.unit_id)] = {
      unit_key: row.finalization_unit_key,
      audio_sha256: row.audio_sha256,
      spoken_text_sha256: row.spoken_text_sha256,
      acoustic_qa: waveformQaWithoutVoiceAggregate(row.unit_qa),
      primary_recognition: primary?.recognized ?? null,
      primary_recognition_source:
        primaryRecognitionSourceById.get(String(row.unit_id)) ?? null,
      primary_transcript_qa: primary?.transcriptQa ?? null,
      confirmation_recognition: cached?.confirmation_recognition ?? null,
      confirmation_transcript_qa: cached?.confirmation_transcript_qa ?? null,
      checkpoint_state: "primary_and_waveform_complete",
    };
  }
  await atomicWriteJson(checkpointPath, checkpoint);
  const freshConfirmationMap = confirmationCandidates.length
    ? await helpers.runFasterWhisperUnitBatchForDiagnostics(
        confirmationCandidates,
        {
          model: qualityContract.delivery_qa.exact_suspect_confirmation_model
            ?? "medium",
          device: "cpu",
          computeType: "int8_float32",
        },
      )
    : new Map();
  const confirmationMap = new Map([
    ...cachedConfirmationMap,
    ...freshConfirmationMap,
  ]);
  const continuityById = new Map(
    (voiceContinuity.units ?? []).map((row) => [String(row.unit_id), row]),
  );
  const deliveryRows = [];
  let blockers = [
    ...(acousticQa.blockers ?? []),
    ...(voiceContinuity.blockers ?? []),
  ];
  for (const row of rows) {
    const primary = primaryById.get(String(row.unit_id));
    const confirmation = confirmationMap.get(String(row.unit_id)) ?? null;
    const confirmationQa = confirmation
      ? helpers.transcriptQaForTests(row.text, confirmation.text, {
          maxWer: qualityContract.delivery_qa.maximum_word_error_rate,
          equivalentPhrases: equivalentPhrasesForTests(row),
          blockAnySubstitution: false,
        })
      : null;
    const confirmationRequired = confirmationRequiredIds.has(String(row.unit_id));
    let decision = adjudicateNarrationDeliveryConsensus({
      primaryTranscriptQa: primary.transcriptQa,
      confirmationTranscriptQa: confirmationRequired
        ? confirmationQa
        : primary.transcriptQa,
      orderQa: { blockers: [] },
      joinQa: { blockers: [], warnings: [] },
      contract: qualityContract,
      primaryModel: qualityContract.delivery_qa.unit_screening_model ?? "small.en",
      confirmationModel:
        qualityContract.delivery_qa.exact_suspect_confirmation_model ?? "medium",
    });
    const continuity = continuityById.get(String(row.unit_id)) ?? null;
    const acousticReviewWarnings = (row.unit_qa?.findings ?? []).filter(
      (finding) => finding?.severity === "warning"
        && finding?.review_required === true,
    );
    decision = mergeDecisionWarnings(decision, [
      ...acousticReviewWarnings,
      ...(continuity?.warnings ?? []),
    ]);
    decision = blockAutomatedNarrationEdgeRisks(
      decision,
      row.unit_qa?.findings ?? [],
      qualityContract,
    );
    decision = applyLowMarginDisposition(decision, row.unit_id, lowMarginDisposition);
    if (acceptAsrDeliveryBlockers) {
      decision = operatorWaiveAsrDecision(
        decision,
        operatorNarrationWaiver,
      );
    }
    if (acceptReviewWarnings) {
      decision = operatorWaiveReviewWarnings(
        decision,
        operatorNarrationWaiver,
      );
    }
    const sampleCount = Number(row.unit_qa?.metrics?.sample_count ?? 0);
    const alignment = conservativeNarrationEdgeAlignmentForTests({
      recognitions: [
        primary.recognized,
        ...(confirmationRequired ? [confirmation] : []),
      ],
      transcriptQas: [
        primary.transcriptQa,
        ...(confirmationRequired ? [confirmationQa] : []),
      ],
      sampleCount,
      durationSec: row.duration_sec,
    });
    row.unit_qa.edge_alignment = alignment;
    row.unit_qa.delivery_qa_v2 = decision;
    row.unit_qa.voice_continuity = continuity;
    const deliveryRow = {
      unit_id: row.unit_id,
      audio_path: row.wav,
      audio_sha256: row.audio_sha256,
      edge_alignment: alignment,
      intended_text: row.text,
      intended_text_sha256: row.spoken_text_sha256,
      primary_recognized_text: primary.recognized?.text ?? null,
      primary_recognition_source:
        primaryRecognitionSourceById.get(String(row.unit_id)) ?? null,
      confirmation_recognized_text: confirmation?.text ?? null,
      transcript_qa: primary.transcriptQa,
      confirmation_transcript_qa: confirmationQa,
      acoustic_qa: row.unit_qa,
      voice_continuity: continuity,
      decision,
    };
    deliveryRows.push(deliveryRow);
    blockers.push(...(decision.blockers ?? []).map((finding) => ({
      ...finding,
      unit_id: row.unit_id,
    })));
    checkpoint.units[String(row.unit_id)] = {
      unit_key: row.finalization_unit_key,
      audio_sha256: row.audio_sha256,
      spoken_text_sha256: row.spoken_text_sha256,
      acoustic_qa: waveformQaWithoutVoiceAggregate(row.unit_qa),
      primary_recognition: primary.recognized,
      primary_recognition_source:
        primaryRecognitionSourceById.get(String(row.unit_id)) ?? null,
      primary_transcript_qa: primary.transcriptQa,
      confirmation_recognition: confirmation,
      confirmation_transcript_qa: confirmationQa,
      delivery_row: structuredClone(deliveryRow),
    };
  }

  const originalDeliveryBlockers = [...blockers];
  if (acceptAsrDeliveryBlockers && blockers.length) {
    const nonAsrBlockers = blockers.filter(
      (finding) => !asrOnlyDeliveryFinding(finding),
    );
    if (nonAsrBlockers.length) {
      throw new Error(
        "ASR-only delivery waiver refused non-ASR blockers: "
        + nonAsrBlockers.map((finding) => finding.code).join(", "),
      );
    }
    blockers = [];
  }

  const unitDeliveryPath = path.join(
    artifactDir,
    `narration_unit_delivery_qa_${episode}.json`,
  );
  const unitQaPath = path.join(
    artifactDir,
    `narration_tts_unit_qa_${episode}.json`,
  );
  const listenPacketPath = path.join(
    artifactDir,
    `narration_exact_listen_review_packet_${episode}.json`,
  );
  const repairPacketPath = path.join(
    artifactDir,
    `narration_exact_repair_packet_${episode}.json`,
  );
  const manualReviewEvidencePath = String(
    flags["manual-review-evidence"] ?? "",
  ).trim()
    ? path.resolve(flags["manual-review-evidence"])
    : null;
  let manualReview = null;
  let manualReviewEvidenceSha256 = null;
  if (manualReviewEvidencePath) {
    const evidence = await readJson(manualReviewEvidencePath, null);
    const evidencePriorUnitDeliveryPath = String(
      evidence?.pre_review_unit_delivery_qa_path ?? "",
    ).trim();
    const priorUnitDeliveryPath = evidencePriorUnitDeliveryPath
      ? path.resolve(evidencePriorUnitDeliveryPath)
      : unitDeliveryPath;
    const priorUnitDeliverySha256 = await sha256File(priorUnitDeliveryPath)
      .catch(() => null);
    manualReviewEvidenceSha256 = await sha256File(manualReviewEvidencePath);
    manualReview = await validateNarrationDeliveryManualReviewEvidenceForTests({
      evidence,
      evidencePath: manualReviewEvidencePath,
      canonicalPlanSha256,
      manifestFileSha256,
      priorUnitDeliveryPath,
      priorUnitDeliverySha256,
      rows,
      deliveryRows,
      blockers,
    });
    blockers = applyNarrationDeliveryManualReviewForTests({
      deliveryRows,
      blockers,
      review: manualReview,
      evidenceSha256: manualReviewEvidenceSha256,
    });
    checkpoint.stages.delivery_manual_review = {
      input_key: narrationFinalizationStageKey(
        "delivery_manual_review",
        {
          evidence_sha256: manualReviewEvidenceSha256,
          accepted_unit_ids: manualReview.accepted_unit_ids,
          rejected_unit_ids: manualReview.rejected_unit_ids,
          provider_output_manifest_sha256: manifestFileSha256,
        },
      ),
      status: "passed",
      payload: {
        evidence_path: manualReviewEvidencePath,
        evidence_sha256: manualReviewEvidenceSha256,
        reviewer: manualReview.reviewer,
        reviewed_at: manualReview.reviewed_at,
        accepted_unit_ids: manualReview.accepted_unit_ids,
        rejected_unit_ids: manualReview.rejected_unit_ids,
      },
    };
  }
  const listenPacket = exactNarrationListenReviewPacket({
    rows: deliveryRows,
    generationPlanSha256: canonicalPlanSha256,
    generationPlanFileSha256: planFileSha256,
    qualityContractSha256: qualityContract.contract_sha256,
  });
  if (reviewContinuation && validateNarrationExactListenReviewDecision(
    listenPacket, reviewContinuation.listenDecision,
  ).status !== "approved") {
    throw new Error("Reviewed continuation no longer matches the exact approved listen packet.");
  }
  const unitDeliveryArtifact = {
    ...lowMarginProvenance,
    schema: "goldflow_narration_unit_delivery_qa_v2",
    transcript_comparison_version: helpers.TRANSCRIPT_QA_COMPARISON_VERSION,
    status: blockers.length
      ? "blocked"
      : listenPacket.item_count ? "passed_with_warnings" : "passed",
    source_script_hash: sourceScriptHash(plan),
    narration_generation_plan_path: planPath,
    narration_generation_plan_sha256: canonicalPlanSha256,
    narration_generation_plan_file_sha256: planFileSha256,
    quality_contract_sha256: qualityContract.contract_sha256,
    provider: manifest.provider,
    unit_count: rows.length,
    blocked_unit_count: new Set(
      blockers.map((finding) => finding.unit_id).filter(Boolean),
    ).size,
    listen_review_unit_count: listenPacket.item_count,
    voice_continuity_status: voiceContinuity.status,
    voice_continuity_report_path: continuityPath,
    voice_continuity_report_sha256: continuityArtifactSha256,
    speaker_similarity_evidence_path: similarityEvidencePath,
    speaker_similarity_evidence_sha256: voiceContinuity.report_sha256 ?? null,
    manual_review_evidence_path: manualReviewEvidencePath,
    manual_review_evidence_sha256: manualReviewEvidenceSha256,
    manual_review_accepted_unit_ids: manualReview?.accepted_unit_ids ?? [],
    manual_review_rejected_unit_ids: manualReview?.rejected_unit_ids ?? [],
    operator_narration_qa_waiver:
      acceptAsrDeliveryBlockers || acceptReviewWarnings
        ? operatorNarrationWaiver
        : null,
    waived_blockers: acceptAsrDeliveryBlockers
      ? originalDeliveryBlockers
      : [],
    blockers,
    units: deliveryRows,
  };
  const selectedUnits = rows.map((row) => {
    const delivery = deliveryRows.find(
      (item) => String(item.unit_id) === String(row.unit_id),
    );
    return {
      unit_id: row.unit_id,
      provider: row.provider,
      model_id: row.model_id,
      model_revision: row.model_revision,
      voice_id: row.voice_id,
      voice_sha256: row.voice_sha256,
      voice_continuity_contract: row.voice_continuity_contract,
      spoken_text: row.text,
      spoken_text_sha256: row.spoken_text_sha256,
      synthesis_identity_sha256: row.synthesis_identity_sha256,
      synthesis_identity: row.synthesis_identity,
      synthesis_mode: row.synthesis_mode,
      batch_plan_sha256: row.batch_plan_sha256,
      cohort_id: row.cohort_id,
      cohort_sha256: row.cohort_sha256,
      generated_token_count: row.generated_token_count,
      effective_token_limit: row.effective_token_limit,
      recovery_provenance: row.recovery_provenance,
      runner_report_path: row.runner_report_path,
      runner_report_sha256: row.runner_report_sha256,
      audio_path: row.wav,
      audio_sha256: row.audio_sha256,
      qa_status: delivery?.decision?.status ?? "blocked",
      qa: {
        status: delivery?.decision?.status ?? "blocked",
        acoustic: delivery?.acoustic_qa ?? null,
        delivery: delivery?.decision ?? null,
        voice_continuity: delivery?.voice_continuity ?? null,
      },
    };
  });
  const selectedBlockers = blockers.filter((finding) => finding.unit_id);
  const unitQaArtifact = {
    ...lowMarginProvenance,
    schema: "goldflow_narration_tts_unit_qa_v2",
    status: blockers.length
      ? "blocked"
      : listenPacket.item_count ? "passed_with_warnings" : "passed",
    source_script_hash: sourceScriptHash(plan),
    narration_generation_plan_path: planPath,
    narration_generation_plan_sha256: canonicalPlanSha256,
    narration_generation_plan_file_sha256: planFileSha256,
    narration_quality_contract_sha256: qualityContract.contract_sha256,
    expected_unit_count: rows.length,
    selected_unit_count: selectedUnits.length,
    reused_exact_hash_waveform_qa_unit_count:
      acousticQa.reused_exact_hash_waveform_qa_unit_count ?? 0,
    decoded_waveform_qa_unit_count:
      acousticQa.decoded_waveform_qa_unit_count ?? rows.length,
    reused_exact_hash_voice_continuity_report:
      voiceContinuity.reused_exact_hash_report === true,
    reused_exact_bound_provider_small_asr_unit_count:
      embeddedPrimaryMap.size,
    fresh_finalizer_small_asr_unit_count: primaryNeeds.length,
    provider_small_asr_reuse_decisions: embeddedPrimaryReuseDecisions,
    manual_review_evidence_path: manualReviewEvidencePath,
    manual_review_evidence_sha256: manualReviewEvidenceSha256,
    manual_review_accepted_unit_ids: manualReview?.accepted_unit_ids ?? [],
    manual_review_rejected_unit_ids: manualReview?.rejected_unit_ids ?? [],
    operator_narration_qa_waiver:
      acceptAsrDeliveryBlockers || acceptReviewWarnings
        ? operatorNarrationWaiver
        : null,
    waived_blockers: acceptAsrDeliveryBlockers
      ? originalDeliveryBlockers.filter((finding) => finding.unit_id)
      : [],
    selected_blocker_count: selectedBlockers.length,
    selected_blockers: selectedBlockers,
    selected_units: selectedUnits,
  };
  await Promise.all([
    atomicWriteJson(unitDeliveryPath, unitDeliveryArtifact),
    atomicWriteJson(unitQaPath, unitQaArtifact),
    atomicWriteJson(listenPacketPath, listenPacket),
    atomicWriteJson(repairPacketPath, exactNarrationRepairPacket({
      decision: { status: blockers.length ? "blocked" : "passed", blockers },
      units: rows,
    })),
    atomicWriteJson(checkpointPath, checkpoint),
  ]);
  if (blockers.length) {
    // Preserve the exact selected first takes before failing closed so a later
    // confirmed exact-unit repair can validate and reuse every unaffected WAV.
    const blockedTtsReportPath = path.join(
      artifactDir,
      `narration_tts_report_${episode}.json`,
    );
    await atomicWriteJson(blockedTtsReportPath, {
      ...lowMarginProvenance,
      ...scopeFields,
      schema: "goldflow_narration_tts_report_v1",
      status: "blocked",
      generated_at: new Date().toISOString(),
      source_script_hash: sourceScriptHash(plan),
      run_identity_path: identityPath,
      narration_generation_plan_path: planPath,
      narration_generation_plan_sha256: canonicalPlanSha256,
      narration_generation_plan_file_sha256: planFileSha256,
      policy,
      narration_quality_contract_sha256: qualityContract.contract_sha256,
      provider_output_manifest_path: manifestPath,
      provider_output_manifest_sha256: manifestFileSha256,
      synthesis_contract: policy.synthesis_contract,
      batch_plan_sha256:
        manifest.provider_execution?.batch_plan_sha256 ?? null,
      synthesis_runs:
        manifest.provider_execution?.synthesis_runs ?? [],
      effective_concurrency:
        manifest.provider_execution?.effective_concurrency ?? null,
      unit_qa_path: unitQaPath,
      unit_qa_status: unitQaArtifact.status,
      full_stream_qa_status: "not_run_due_to_unit_blockers",
      manual_review_evidence_path: manualReviewEvidencePath,
      manual_review_evidence_sha256: manualReviewEvidenceSha256,
      manual_review_accepted_unit_ids: manualReview?.accepted_unit_ids ?? [],
      manual_review_rejected_unit_ids: manualReview?.rejected_unit_ids ?? [],
      expected_unit_count: rows.length,
      selected_unit_count: rows.length,
      retry_scope_policy:
        "no_automatic_retry; later_hash_bound_exact_unit_repair_only",
      results: rows.map((row, index) => ({
        unit_id: row.unit_id,
        attempt: row.attempt ?? 1,
        selected_provider: row.provider,
        provider: row.provider,
        model_id: row.model_id,
        model_revision: row.model_revision,
        voice_id: row.voice_id,
        voice_sha256: row.voice_sha256,
        voice_continuity_contract: row.voice_continuity_contract,
        spoken_text_sha256: row.spoken_text_sha256,
        audio_path: row.wav,
        audio_sha256: row.audio_sha256,
        synthesis_identity: row.synthesis_identity,
        synthesis_identity_sha256: row.synthesis_identity_sha256,
        selected_qa: selectedUnits[index].qa,
        qa_status: selectedUnits[index].qa_status,
      })),
      blockers,
      listen_review_packet_path: listenPacketPath,
      listen_review_packet_sha256: listenPacket.packet_sha256,
      listen_review_status: "blocked_before_review",
    });
    throw new Error(
      `Provider-neutral delivery QA blocked ${new Set(
        blockers.map((finding) => finding.unit_id).filter(Boolean),
      ).size} unit(s).`,
    );
  }

  let listenDecisionValidation = null;
  const listenDecisionPath = phaseContext?.reviewContinuation?.listenDecision?.path ?? (flags["listen-decision"]
    ? path.resolve(flags["listen-decision"])
    : path.join(
      artifactDir,
      `narration_exact_listen_review_decision_${episode}.json`,
    ));
  const listenDecision = reviewContinuation?.listenDecision ?? await readJson(listenDecisionPath, null);
  if (listenPacket.item_count > 0 && listenDecision) {
    listenDecisionValidation = validateNarrationExactListenReviewDecision(
      listenPacket,
      listenDecision,
    );
  }
  const automatedAsrAcceptance = narrationUsesAutomatedAsrAcceptance(qualityContract);
  const deliveryAccepted = automatedAsrAcceptance
    || listenPacket.item_count === 0
    || listenDecisionValidation?.status === "approved";

  const rawWav = reviewContinuation?.rawAudio.path
    ?? path.join(workDir, `${episode}-narration-provider-neutral-raw.wav`);
  const stitchInputKey = narrationFinalizationStageKey("semantic_stitch", {
    ordered_unit_keys: rows.map((row) => row.finalization_unit_key),
    quality_contract_sha256: qualityContract.contract_sha256,
    stitch_sample_rate_hz: CANONICAL_SAMPLE_RATE_HZ,
    alignment_policy: "narration_alignment_safe_semantic_stitch_v2",
  });
  const cachedStitchStage = reusableNarrationFinalizationStage(
    checkpoint,
    "semantic_stitch",
    stitchInputKey,
  );
  let stitch = cachedStitchStage?.payload?.stitch ?? null;
  let rawWavSha256 = cachedStitchStage?.payload?.raw_wav_sha256 ?? null;
  if (stitch && !(await fileMatchesSha256(rawWav, rawWavSha256))) {
    stitch = null;
    rawWavSha256 = null;
  }
  if (stitch) {
    const preparedValid = (await Promise.all(
      (stitch.prepared_inputs ?? []).map((prepared) => fileMatchesSha256(
        prepared.prepared_wav,
        prepared.prepared_audio_sha256
          ?? prepared.prepared_qa?.audio_sha256,
      )),
    )).every(Boolean);
    if (!preparedValid) {
      stitch = null;
      rawWavSha256 = null;
    }
  }
  if (!stitch) {
    if (fullStreamManualReview) throw new Error("Exact full-stream review requires the retained stitch; media rebuilding is forbidden.");
    if (reviewContinuation) {
      throw new Error("Reviewed continuation lost its exact cached raw stitch; restitching is forbidden.");
    }
    stitch = await helpers.stitchWavsForDiagnostics(rows, rawWav, {
      narrationQualityContract: qualityContract,
      workDir,
      skipRenderedTranscriptQa: true,
    });
  }
  if (!stitch || stitch.status !== "passed") {
    throw new Error("Provider-neutral semantic stitch did not pass.");
  }
  rawWavSha256 ??= await sha256File(rawWav);
  checkpoint.stages.semantic_stitch = {
    input_key: stitchInputKey,
    status: "passed",
    payload: {
      raw_wav_path: rawWav,
      raw_wav_sha256: rawWavSha256,
      stitch,
    },
  };
  await atomicWriteJson(checkpointPath, checkpoint);
  const masteringRequested = boolFlag(flags.master, true);
  let mastering = {
    status: masteringRequested
      ? "deferred_until_delivery_acceptance"
      : "diagnostic_disabled",
    reason: masteringRequested
      ? "Narration delivery QA must pass before mastering."
      : "Mastering was explicitly disabled for a diagnostic run.",
  };
  let canonicalWav = rawWav;
  let canonicalWavSha256 = rawWavSha256;
  if (masteringRequested && deliveryAccepted) {
    const masteredPath = path.join(
      workDir,
      `${episode}-narration-provider-neutral-mastered.wav`,
    );
    const masteringInputKey = narrationFinalizationStageKey("mastering", {
      raw_wav_sha256: rawWavSha256,
      mastering_contract: qualityContract.mastering,
      delivery_accepted: true,
    });
    const cachedMasteringStage = reusableNarrationFinalizationStage(
      checkpoint,
      "mastering",
      masteringInputKey,
    );
    const cachedMastering = cachedMasteringStage?.payload?.mastering ?? null;
    if (cachedMastering?.status === "passed"
      && await fileMatchesSha256(
        cachedMastering.output_path,
        cachedMastering.output_sha256,
      )) {
      mastering = cachedMastering;
    } else {
      if (fullStreamManualReview) throw new Error("Exact full-stream review requires the retained master; media rebuilding is forbidden.");
      mastering = await masterNarrationTwoPass({
        inputPath: rawWav,
        outputPath: masteredPath,
        reportPath: path.join(
          artifactDir,
          `narration_mastering_report_${episode}-provider-neutral.json`,
        ),
        targetLufs: qualityContract.mastering.integrated_lufs_target,
        truePeakDbtp: qualityContract.mastering.true_peak_dbtp_max,
        sampleRateHz: qualityContract.mastering.sample_rate_hz,
        channels: qualityContract.mastering.mono ? 1 : 2,
        integratedTolerance: qualityContract.mastering.integrated_lufs_tolerance,
        durationDeltaMsMax: qualityContract.mastering.duration_delta_ms_max,
      });
    }
    if (mastering.status !== "passed") {
      throw new Error("Final stream-level narration mastering did not pass.");
    }
    if (reviewContinuation && (mastering.input_path !== rawWav || mastering.input_sha256 !== rawWavSha256
      || !(await fileMatchesSha256(rawWav, rawWavSha256)))) {
      throw new Error("Reviewed continuation mastering input changed from the approved raw stream.");
    }
    canonicalWav = mastering.output_path;
    canonicalWavSha256 = mastering.output_sha256;
    checkpoint.stages.mastering = {
      input_key: masteringInputKey,
      status: "passed",
      payload: { mastering },
    };
    await atomicWriteJson(checkpointPath, checkpoint);
  }
  const subjectiveManifestPath = path.join(
    artifactDir,
    `narration_subjective_review_manifest_${episode}.json`,
  );
  let subjectiveManifest = null;
  if (qualityContract.subjective_review?.hash_bound_sampling_manifest_required === true
    && mastering.status === "passed"
    && deliveryAccepted
    && !skipSubjectiveReview) {
    subjectiveManifest = buildNarrationSubjectiveReviewManifest({
      plan: pilotFinalization ? { ...plan, units } : plan,
      stitch,
      audioPath: canonicalWav,
      audioSha256: canonicalWavSha256,
      generationPlanSha256: canonicalPlanSha256,
      generationPlanFileSha256: planFileSha256,
      qualityContractSha256: qualityContract.contract_sha256,
      sampleRateHz: CANONICAL_SAMPLE_RATE_HZ,
      sourceStructure,
    });
    if (pilotFinalization) {
      subjectiveManifest.finalization_scope = pilotFinalization.scope;
      subjectiveManifest.manifest_sha256 = narrationSubjectiveReviewManifestSha256(subjectiveManifest);
    }
    const subjectiveValidation = validateNarrationSubjectiveReviewManifest(
      subjectiveManifest,
    );
    if (subjectiveValidation.status !== "passed") {
      throw new Error(
        `Canonical narration subjective sample manifest blocked: ${subjectiveValidation.findings
          .map((finding) => finding.code)
          .join(", ")}`,
      );
    }
    await atomicWriteJson(subjectiveManifestPath, subjectiveManifest);
  }
  const subjectiveReviewWaiver = skipSubjectiveReview
    ? {
        ...operatorNarrationWaiver,
        status: "skipped_with_waiver",
        narration_audio_path: canonicalWav,
        narration_audio_sha256: canonicalWavSha256,
        narration_quality_contract_sha256: qualityContract.contract_sha256,
      }
    : null;

  const expectedIds = rows.map((row) => String(row.unit_id));
  const actualIds = stitch.prepared_inputs.map((row) => String(row.unit_id));
  const exactOrder = exactOrderedIds(expectedIds, actualIds);
  const orderQa = {
    schema: "goldflow_narration_unit_order_qa_v2",
    status: exactOrder ? "passed" : "blocked",
    expected_unit_ids: expectedIds,
    actual_unit_ids: actualIds,
    blockers: exactOrder
      ? []
      : [{ code: "narration_full_stream_unit_order_mismatch" }],
  };
  const joinQa = joinQaFromStitch(stitch);
  const fullStreamInputKey = narrationFinalizationStageKey(
    "full_stream_delivery_qa",
    {
      audio_sha256: canonicalWavSha256,
      intended_text_sha256: sha256(rows.map((row) => row.text).join(" ")),
      quality_contract_sha256: qualityContract.contract_sha256,
      local_whisper_contract: officialLocalWhisperContract,
      order_qa: orderQa,
      join_qa: joinQa,
    },
  );
  const checkpointFullStreamStage = checkpoint?.stages
    ?.full_stream_delivery_qa ?? null;
  const cachedFullStreamStage = checkpointFullStreamStage?.input_key
      === fullStreamInputKey
      && checkpointFullStreamStage?.payload?.full_stream
    ? structuredClone(checkpointFullStreamStage)
    : null;
  let cachedFullStream = cachedFullStreamStage?.payload?.full_stream ?? null;
  if (cachedFullStream) {
    const confirmationEvidenceValid = (await Promise.all(
      [...(cachedFullStream.confirmation_windows ?? []),
        ...(cachedFullStream.retained_confirmation_evidence ?? [])].map((window) => (
        fileMatchesSha256(window.audio_path, window.audio_sha256)
      )),
    )).every(Boolean);
    if (!confirmationEvidenceValid) cachedFullStream = null;
  }
  if (fullStreamManualReview && !narrationFullStreamDerivedDecisionsCurrent(
    cachedFullStream, helpers.TRANSCRIPT_QA_COMPARISON_VERSION,
  )) {
    throw new Error("Exact full-stream review requires current retained ASR; refresh QA separately before listening review.");
  }
  const rawFullStream = narrationFullStreamDerivedDecisionsCurrent(
    cachedFullStream, helpers.TRANSCRIPT_QA_COMPARISON_VERSION,
  )
    ? cachedFullStream
    : await runFullStreamDeliveryQa({
      helpers,
      audioPath: canonicalWav,
      audioSha256: canonicalWavSha256,
      units: rows,
      qualityContract,
      orderQa,
      joinQa,
      stitch,
      workDir,
      localWhisperContract: officialLocalWhisperContract,
      retainedEvidence: cachedFullStream,
    });
  checkpoint.stages.full_stream_delivery_qa = {
    input_key: fullStreamInputKey,
    status: rawFullStream.decision.status === "blocked" ? "blocked" : "passed",
    payload: { full_stream: rawFullStream },
  };
  await atomicWriteJson(checkpointPath, checkpoint);
  let fullStream = manualReview
    ? applyNarrationFullStreamManualReviewForTests({
        fullStream: rawFullStream,
        review: manualReview,
        evidenceSha256: manualReviewEvidenceSha256,
      })
    : rawFullStream;
  if (fullStreamManualReview) {
    fullStream = applyFullStreamManualReview({ fullStream, review: fullStreamManualReview,
      bindings: {
        source_script_hash: actualSourceScriptSha256,
        narration_generation_plan_sha256: canonicalPlanSha256,
        narration_generation_plan_file_sha256: planFileSha256,
        narration_quality_contract_sha256: qualityContract.contract_sha256,
        audio_path: canonicalWav, audio_sha256: canonicalWavSha256,
      },
    });
    checkpoint.stages.full_stream_manual_review = {
      input_key: narrationFinalizationStageKey("full_stream_manual_review", fullStream.full_stream_manual_review),
      status: fullStream.decision.status === "blocked" ? "blocked" : "passed",
      payload: fullStream.full_stream_manual_review,
    };
  }
  const originalFullStreamBlockers = [
    ...(fullStream.decision?.blockers ?? []),
  ];
  if (acceptAsrDeliveryBlockers && originalFullStreamBlockers.length) {
    const waivedDecision = operatorWaiveAsrDecision(
      fullStream.decision,
      operatorNarrationWaiver,
    );
    if ((waivedDecision?.blockers ?? []).length) {
      throw new Error(
        "ASR-only full-stream waiver refused non-ASR blockers: "
        + waivedDecision.blockers.map((finding) => finding.code).join(", "),
      );
    }
    fullStream = { ...fullStream, decision: waivedDecision };
  }
  if (acceptReviewWarnings) {
    fullStream = {
      ...fullStream,
      decision: operatorWaiveReviewWarnings(
        fullStream.decision,
        operatorNarrationWaiver,
      ),
    };
  }
  checkpoint.stages.full_stream_delivery_qa = {
    input_key: fullStreamInputKey,
    status: fullStream.decision.status === "blocked" ? "blocked" : "passed",
    payload: { full_stream: rawFullStream },
  };
  const fullStreamArtifact = {
    ...scopeFields,
    schema: "goldflow_narration_full_stream_qa_v2",
    transcript_comparison_version: fullStream.transcript_comparison_version,
    delivery_consensus_version: fullStream.delivery_consensus_version,
    status: fullStream.decision.status,
    source_script_hash: sourceScriptHash(plan),
    narration_generation_plan_path: planPath,
    narration_generation_plan_sha256: canonicalPlanSha256,
    narration_generation_plan_file_sha256: planFileSha256,
    narration_quality_contract_sha256: qualityContract.contract_sha256,
    provider_output_manifest_file_sha256: manifestFileSha256,
    audio_path: canonicalWav,
    audio_sha256: canonicalWavSha256,
    intended_text_sha256: fullStream.intended_text_sha256,
    order_qa: orderQa,
    join_qa: joinQa,
    primary_model: fullStream.primary_model,
    primary_recognized_text: fullStream.primary_recognized_text,
    primary_recognized_words: fullStream.primary_recognized_words,
    primary_transcript_qa: fullStream.primary_transcript_qa,
    confirmation_required: fullStream.confirmation_required,
    confirmation_scope: fullStream.confirmation_scope,
    confirmation_model: fullStream.confirmation_model,
    confirmation_recognized_text: fullStream.confirmation_recognized_text,
    confirmation_recognized_words: fullStream.confirmation_recognized_words,
    confirmation_transcript_qa: fullStream.confirmation_transcript_qa,
    confirmation_window_plan: fullStream.confirmation_window_plan,
    confirmation_windows: fullStream.confirmation_windows,
    retained_confirmation_evidence: fullStream.retained_confirmation_evidence ?? [],
    primary_alignment_contract: fullStream.primary_alignment_contract,
    manual_review_evidence_path: manualReviewEvidencePath,
    manual_review_evidence_sha256: manualReviewEvidenceSha256,
    manual_review_accepted_unit_ids: manualReview?.accepted_unit_ids ?? [],
    manual_review_rejected_unit_ids: manualReview?.rejected_unit_ids ?? [],
    full_stream_manual_review: fullStream.full_stream_manual_review ?? null,
    operator_narration_qa_waiver:
      acceptAsrDeliveryBlockers || acceptReviewWarnings
        ? operatorNarrationWaiver
        : null,
    waived_blockers: acceptAsrDeliveryBlockers
      ? originalFullStreamBlockers
      : [],
    decision: fullStream.decision,
    blockers: fullStream.decision.blockers,
    warnings: fullStream.decision.warnings,
  };
  await Promise.all([
    atomicWriteJson(fullStreamPath, fullStreamArtifact),
    atomicWriteJson(checkpointPath, checkpoint),
  ]);

  const finalM4a = path.join(
    workDir,
    `${episode}-narration-provider-neutral.m4a`,
  );
  const encodeInputKey = narrationFinalizationStageKey("encode_m4a", {
    canonical_wav_sha256: canonicalWavSha256,
    codec: "aac",
    bitrate: "192k",
  });
  const cachedEncodeStage = reusableNarrationFinalizationStage(
    checkpoint,
    "encode_m4a",
    encodeInputKey,
  );
  let finalM4aSha256 = cachedEncodeStage?.payload?.final_m4a_sha256 ?? null;
  if (!(await fileMatchesSha256(finalM4a, finalM4aSha256))) {
    if (fullStreamManualReview) throw new Error("Exact full-stream review requires the retained encode; media rebuilding is forbidden.");
    finalM4aSha256 = await encodeM4a(canonicalWav, finalM4a);
  }
  checkpoint.stages.encode_m4a = {
    input_key: encodeInputKey,
    status: "passed",
    payload: {
      final_m4a_path: finalM4a,
      final_m4a_sha256: finalM4aSha256,
    },
  };
  const sourceHash = sourceScriptHash(plan);
  const primary = {
    ...policy.primary,
    provider: manifest.provider,
    model_id: manifest.model_id,
    model_revision: manifest.model_revision,
    voice_id: manifest.voice_id,
    voice_sha256: manifest.voice_sha256,
    voice_continuity_contract: manifest.voice_continuity_contract,
  };
  const segmentRows = rows.map((row, index) => ({
    unit_id: row.unit_id,
    provider: row.provider,
    tts_provider: row.provider,
    model_id: row.model_id,
    model_revision: row.model_revision,
    voice_id: row.voice_id,
    voice_sha256: row.voice_sha256,
    voice_continuity_contract: row.voice_continuity_contract,
    text: row.text,
    spoken_text_sha256: row.spoken_text_sha256,
    synthesis_identity_sha256: row.synthesis_identity_sha256,
    synthesis_identity: row.synthesis_identity,
    synthesis_mode: row.synthesis_mode,
    batch_plan_sha256: row.batch_plan_sha256,
    cohort_id: row.cohort_id,
    cohort_sha256: row.cohort_sha256,
    generated_token_count: row.generated_token_count,
    effective_token_limit: row.effective_token_limit,
    recovery_provenance: row.recovery_provenance,
    runner_report_path: row.runner_report_path,
    runner_report_sha256: row.runner_report_sha256,
    raw_audio_path: row.wav,
    raw_audio_sha256: row.audio_sha256,
    qa_status: selectedUnits[index].qa_status,
    unit_qa: selectedUnits[index].qa,
    voice_continuity: selectedUnits[index].qa.voice_continuity,
    prepared_audio_path: stitch.prepared_inputs[index]?.prepared_wav ?? null,
    prepared_audio_sha256:
      stitch.prepared_inputs[index]?.prepared_qa?.audio_sha256 ?? null,
    prepared_leading_silence_sample_count:
      stitch.prepared_inputs[index]?.retained_leading_silence_sample_count ?? null,
    prepared_trailing_silence_sample_count:
      stitch.prepared_inputs[index]?.retained_trailing_silence_sample_count ?? null,
  }));
  const ttsStatus = fullStream.decision.status === "blocked"
    ? "blocked"
    : listenPacket.item_count && !deliveryAccepted
      ? "passed_with_warnings"
      : fullStream.decision.warnings.length || listenPacket.item_count
        ? "passed_with_warnings"
        : "passed";
  const synthesisRuns = pilotFinalization?.synthesisRuns ?? await synthesisRunsWithFirstTakeProvenance({
    episodeDir,
    expectedUnitIds: units.map((unit) => String(unit.unit_id)),
    batchPlanSha256: manifest.provider_execution?.batch_plan_sha256 ?? null,
    synthesisMode: policy.synthesis_contract?.mode ?? null,
    synthesisRuns: manifest.provider_execution?.synthesis_runs ?? [],
  });
  const stitchReport = {
    ...scopeFields,
    ...(pilotFinalization?.phaseBatchPlans ? { phase_batch_plans: pilotFinalization.phaseBatchPlans } : {}),
    schema: "goldflow_provider_neutral_narration_stitch_v2",
    status: fullStream.decision.status === "blocked" ? "blocked" : "passed",
    source_script_hash: sourceHash,
    narration_generation_plan_path: planPath,
    narration_generation_plan_sha256: canonicalPlanSha256,
    narration_generation_plan_file_sha256: planFileSha256,
    narration_quality_contract_sha256: qualityContract.contract_sha256,
    primary_provider: manifest.provider,
    narrator_voice_id: manifest.voice_id,
    voice_id: manifest.voice_id,
    voice_sha256: manifest.voice_sha256,
    primary,
    stitch_policy_version: "narration_alignment_safe_semantic_stitch_v2",
    stitch_policy: stitch.policy,
    stitch_sample_rate: CANONICAL_SAMPLE_RATE_HZ,
    stitch_qa_status: stitch.status,
    full_stream_qa_status: fullStreamArtifact.status,
    full_stream_qa_path: fullStreamPath,
    full_stream_manual_review: fullStream.full_stream_manual_review ?? null,
    boundary_qa: stitch.boundary_qa,
    boundaries: stitch.boundaries,
    join_qa: joinQa,
    sample_accounting: stitch.sample_accounting,
    segments: segmentRows,
    raw_output_path: rawWav,
    raw_output_sha256: rawWavSha256,
    output_path: canonicalWav,
    output_sha256: canonicalWavSha256,
    final_wav_path: canonicalWav,
    final_wav_sha256: canonicalWavSha256,
    final_m4a_path: finalM4a,
    final_m4a_sha256: finalM4aSha256,
    final_duration_sec:
      mastering.output_probe?.duration_sec
      ?? stitch.final_qa?.metrics?.duration_sec
      ?? null,
    mastering,
    subjective_review_manifest_path: subjectiveManifest
      ? subjectiveManifestPath
      : null,
    subjective_review_manifest_sha256:
      subjectiveManifest?.manifest_sha256 ?? null,
    subjective_review_waiver: subjectiveReviewWaiver,
  };
  const ttsReport = {
    ...lowMarginProvenance,
    ...scopeFields,
    ...(pilotFinalization?.phaseBatchPlans ? { phase_batch_plans: pilotFinalization.phaseBatchPlans } : {}),
    schema: "goldflow_provider_neutral_narration_tts_report_v2",
    full_stream_manual_review: fullStream.full_stream_manual_review ?? null,
    status: ttsStatus,
    source_script_hash: sourceHash,
    narration_generation_plan_path: planPath,
    narration_generation_plan_sha256: canonicalPlanSha256,
    narration_generation_plan_file_sha256: planFileSha256,
    narration_quality_contract_sha256: qualityContract.contract_sha256,
    primary_provider: manifest.provider,
    primary_model_id: manifest.model_id,
    primary_model_revision: manifest.model_revision,
    narrator_voice_id: manifest.voice_id,
    voice_id: manifest.voice_id,
    voice_sha256: manifest.voice_sha256,
    primary,
    tts_native_speed: policy.primary.native_speed ?? null,
    post_tempo_normalized: false,
    synthesis_contract: policy.synthesis_contract,
    batch_plan_sha256:
      manifest.provider_execution?.batch_plan_sha256 ?? null,
    synthesis_runs: synthesisRuns,
    effective_concurrency:
      manifest.provider_execution?.effective_concurrency ?? null,
    qa_policy: policy.qa_policy,
    unit_qa_policy_version: "narration_delivery_qa_v2",
    unit_qa_status: unitQaArtifact.status,
    unit_qa_path: unitQaPath,
    full_stream_qa_status: fullStreamArtifact.status,
    full_stream_qa_path: fullStreamPath,
    expected_unit_count: rows.length,
    selected_unit_count: rows.length,
    fallback_unit_ids: [],
    fallback_usage: null,
    retry_policy: narrationTtsRetryReportPolicy({
      provider: manifest.provider,
      qualityContract,
      recoveryProvenances: rows.map((row) => row.recovery_provenance),
    }),
    provider_output_manifest_path: manifestPath,
    provider_output_manifest_sha256: await sha256File(manifestPath),
    voice_continuity_report_path: continuityPath,
    voice_continuity_report_sha256: continuityArtifactSha256,
    speaker_similarity_evidence_path: similarityEvidencePath,
    speaker_similarity_evidence_sha256: voiceContinuity.report_sha256 ?? null,
    manual_review_evidence_path: manualReviewEvidencePath,
    manual_review_evidence_sha256: manualReviewEvidenceSha256,
    manual_review_accepted_unit_ids: manualReview?.accepted_unit_ids ?? [],
    manual_review_rejected_unit_ids: manualReview?.rejected_unit_ids ?? [],
    operator_narration_qa_waiver:
      acceptAsrDeliveryBlockers || acceptReviewWarnings || skipSubjectiveReview
        ? operatorNarrationWaiver
        : null,
    listen_review_packet_path: listenPacketPath,
    listen_review_packet_sha256: listenPacket.packet_sha256,
    listen_review_status: automatedAsrAcceptance
      ? "automated_asr_qa"
      : listenPacket.item_count === 0
      ? "not_required"
      : listenDecisionValidation?.status ?? "pending",
    ...(reviewContinuation ? {
      listen_review_decision_path: phaseContext.reviewContinuation.listenDecision.path,
      listen_review_decision_sha256: phaseContext.reviewContinuation.listenDecision.sha256,
    } : {}),
    results: rows.map((row, index) => ({
      unit_id: row.unit_id,
      attempt: row.attempt ?? 1,
      selected_provider: row.provider,
      provider: row.provider,
      model_id: row.model_id,
      model_revision: row.model_revision,
      voice_id: row.voice_id,
      voice_sha256: row.voice_sha256,
      voice_continuity_contract: row.voice_continuity_contract,
      spoken_text_sha256: row.spoken_text_sha256,
      selected_spoken_text_sha256: row.spoken_text_sha256,
      audio_path: row.wav,
      audio_sha256: row.audio_sha256,
      token_limit_reached: row.token_limit_reached,
      generated_token_count: row.generated_token_count,
      effective_token_limit: row.effective_token_limit,
      synthesis_mode: row.synthesis_mode,
      batch_plan_sha256: row.batch_plan_sha256,
      cohort_id: row.cohort_id,
      cohort_sha256: row.cohort_sha256,
      recovery_provenance: row.recovery_provenance,
      synthesis_identity: row.synthesis_identity,
      synthesis_identity_sha256: row.synthesis_identity_sha256,
      selected_qa: selectedUnits[index].qa,
      qa_status: selectedUnits[index].qa_status,
      voice_continuity: selectedUnits[index].qa.voice_continuity,
    })),
    raw_wav: rawWav,
    raw_wav_sha256: rawWavSha256,
    final_wav: canonicalWav,
    final_wav_sha256: canonicalWavSha256,
    final_m4a: finalM4a,
    final_m4a_sha256: finalM4aSha256,
    mastering,
    subjective_review_manifest_path: subjectiveManifest
      ? subjectiveManifestPath
      : null,
    subjective_review_manifest_sha256:
      subjectiveManifest?.manifest_sha256 ?? null,
    subjective_review_status: subjectiveManifest
      ? "pending"
      : subjectiveReviewWaiver
        ? "skipped_with_waiver"
        : "not_required_or_not_materialized",
    subjective_review_waiver: subjectiveReviewWaiver,
  };
  const stitchReportPath = path.join(
    artifactDir,
    `audio_stitch_report_${episode}-narration.json`,
  );
  const ttsReportPath = path.join(
    artifactDir,
    `narration_tts_report_${episode}.json`,
  );
  await Promise.all([
    atomicWriteJson(stitchReportPath, stitchReport),
    atomicWriteJson(ttsReportPath, ttsReport),
    atomicWriteJson(repairPacketPath, exactNarrationRepairPacket({
      decision: fullStream.decision,
      units: rows,
      boundaries: stitch.boundaries,
    })),
  ]);
  if (await sha256File(scriptPath) !== actualSourceScriptSha256) {
    throw new Error(
      "Cannot emit official Whisper timing candidate: the narration plan "
      + "source hash differs from script_clean.md.",
    );
  }
  const stitchReportSha256 = await sha256File(stitchReportPath);
  const timingCandidate = buildLocalWhisperTimingCandidate({
    transcription: fullStream.primary_transcription,
    contract: officialLocalWhisperContract,
    sourceScriptPath: scriptPath,
    sourceScriptSha256: actualSourceScriptSha256,
    narrationAudioPath: canonicalWav,
    narrationAudioSha256: canonicalWavSha256,
    narrationReportPath: stitchReportPath,
    narrationReportSha256: stitchReportSha256,
    runIdentityPath: identityPath,
    runIdentitySha256: identityFileSha256,
    narrationQualityContractSha256: qualityContract.contract_sha256,
  });
  if (pilotFinalization) {
    timingCandidate.finalization_scope = pilotFinalization.scope;
    timingCandidate.candidate_sha256 = localWhisperTimingCandidateSha256(timingCandidate);
  }
  const timingCandidatePath = path.join(
    artifactDir,
    `narration_word_timing_candidate_${episode}.json`,
  );
  await atomicWriteJson(timingCandidatePath, timingCandidate);
  checkpoint.stages.local_whisper_timing_candidate = {
    input_key: narrationFinalizationStageKey(
      "local_whisper_timing_candidate",
      {
        source_script_sha256: actualSourceScriptSha256,
        narration_audio_sha256: canonicalWavSha256,
        narration_report_sha256: stitchReportSha256,
        run_identity_sha256: identityFileSha256,
        local_whisper_contract: officialLocalWhisperContract,
      },
    ),
    status: timingCandidate.status === "passed" ? "passed" : "blocked",
    payload: {
      candidate_path: timingCandidatePath,
      candidate_sha256: timingCandidate.candidate_sha256,
    },
  };
  checkpoint.status = fullStream.decision.status === "blocked"
    || timingCandidate.status !== "passed"
    ? "blocked"
    : "complete";
  await atomicWriteJson(checkpointPath, checkpoint);
  if (fullStream.decision.status === "blocked") {
    throw new Error(
      `Canonical full-stream delivery QA blocked: ${fullStream.decision.blockers
        .map((finding) => finding.code)
        .join(", ")}`,
    );
  }
  if (timingCandidate.status !== "passed") {
    throw new Error(
      "Official local-Whisper timing candidate failed structural word-timing QA.",
    );
  }
  if (reviewContinuation) {
    for (const ref of Object.values(phaseContext.reviewContinuation)) {
      if (!(await fileMatchesSha256(ref.path, ref.sha256))) {
        throw new Error("Reviewed continuation original evidence changed during finalization.");
      }
    }
  }
  const result = {
    ...scopeFields,
    ...(pilotFinalization ? {
      phase_context: structuredClone(phaseContext),
      subjective_review_status: subjectiveManifest ? "pending" : "not_materialized_due_to_delivery_review",
      full_stream_qa_path: fullStreamPath,
      voice_continuity_qa_path: continuityPath,
      unit_delivery_qa_path: unitDeliveryPath,
      unit_qa_path: unitQaPath,
      listen_review_packet_path: listenPacketPath,
    } : {}),
    status: ttsReport.status,
    provider: manifest.provider,
    unit_count: rows.length,
    delivery_blocker_count: 0,
    listen_review_unit_count: listenPacket.item_count,
    delivery_accepted: deliveryAccepted,
    exact_sample_accounting: stitch.sample_accounting?.exact_sample_accounting,
    raw_wav: rawWav,
    raw_wav_sha256: rawWavSha256,
    final_wav: canonicalWav,
    final_wav_sha256: canonicalWavSha256,
    mastering_status: mastering.status,
    subjective_review_manifest_path: subjectiveManifest
      ? subjectiveManifestPath
      : null,
    subjective_review_sample_count: subjectiveManifest?.sample_count ?? 0,
    full_stream_qa_status: fullStreamArtifact.status,
    timing_candidate_path: timingCandidatePath,
    timing_candidate_sha256: timingCandidate.candidate_sha256,
    checkpoint_path: checkpointPath,
    tts_report_path: ttsReportPath,
    stitch_report_path: stitchReportPath,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  finalizeNarrationProviderOutput().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
