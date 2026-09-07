import { createHash } from "node:crypto";
import {
  narrationProviderRequestSha256,
  narrationSynthesisIdentitySha256,
} from "./narration-provider-adapter.mjs";
import {
  validateNarrationTextIr,
} from "./narration-text-ir.mjs";
import {
  ttsSpokenTextAuditMatches,
  ttsSpokenTextAuditSha256,
} from "./tts-spoken-text-audit.mjs";
import { hasTtsTerminalPunctuation } from "./tts-text-boundaries.mjs";
import { validateQwenLiamBatchPlan } from "./qwen-liam-batch-contract.mjs";

export const NARRATION_PRE_SYNTHESIS_GATE_SCHEMA =
  "goldflow_narration_pre_synthesis_gate_v2";

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function canonicalize(value, omittedKeys = new Set()) {
  if (Array.isArray(value)) return value.map((child) => canonicalize(child, omittedKeys));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !omittedKeys.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child, omittedKeys)]),
  );
}

export function canonicalNarrationPlanSha256(plan) {
  return sha256(JSON.stringify(canonicalize(
    plan,
    new Set(["generated_at", "plan_sha256", "canonical_plan_sha256"]),
  )));
}

export function narrationPreSynthesisGateSha256(value) {
  return sha256(JSON.stringify(canonicalize(
    value,
    new Set(["generated_at", "updated_at", "gate_sha256"]),
  )));
}

export function buildNarrationPreSynthesisBootstrapGate({
  episodeDir = null,
  identityPath = null,
  priorGate = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  const report = {
    schema: NARRATION_PRE_SYNTHESIS_GATE_SCHEMA,
    status: "pending_validation",
    generated_at: generatedAt,
    updated_at: generatedAt,
    phase: "bootstrap_before_throw_prone_validation",
    production_stage_passed: false,
    model_load_performed: false,
    synthesis_invoked: false,
    historical_synthesis_authorized: Boolean(
      priorGate?.historical_synthesis_authorized
        || priorGate?.model_load_performed
        || priorGate?.synthesis_invoked,
    ),
    bindings: {
      episode_dir: episodeDir,
      run_identity_path: identityPath,
      prior_gate_sha256: priorGate?.gate_sha256 ?? null,
    },
    findings: [{ code: "pre_synthesis_validation_pending" }],
  };
  report.gate_sha256 = narrationPreSynthesisGateSha256(report);
  return report;
}

export function authorizeNarrationPreSynthesisGate(
  gate,
  { generatedAt = new Date().toISOString() } = {},
) {
  if (gate?.status !== "passed"
    || gate?.model_load_performed !== false
    || gate?.synthesis_invoked !== false
    || gate?.gate_sha256 !== narrationPreSynthesisGateSha256(gate)) {
    throw new Error(
      "Only a passed, hash-valid zero-spend narration gate may authorize synthesis.",
    );
  }
  const validationGateSha256 = gate.gate_sha256;
  const authorized = {
    ...structuredClone(gate),
    generated_at: generatedAt,
    updated_at: generatedAt,
    phase: "synthesis_authorized_immediately_before_helper_import",
    model_load_performed: true,
    synthesis_invoked: true,
    authorization: {
      schema: "goldflow_narration_synthesis_authorization_v1",
      validation_gate_sha256: validationGateSha256,
      authorized_at: generatedAt,
      timing: "atomically_persisted_immediately_before_helper_import_and_runner_execution",
    },
  };
  authorized.gate_sha256 = narrationPreSynthesisGateSha256(authorized);
  return authorized;
}

function planUnits(plan = {}) {
  if (Array.isArray(plan.units) && plan.units.length) return plan.units;
  return (plan.segments ?? []).flatMap((segment) => (
    segment?.generation_units
      ?? segment?.narration_generation_units
      ?? segment?.tts_generation_units
      ?? segment?.qwen_generation_units
      ?? []
  ));
}

function flattenedSegmentUnits(plan, field) {
  return (plan?.segments ?? []).flatMap((segment) => (
    Array.isArray(segment?.[field]) ? segment[field] : []
  ));
}

function unitBinding(row) {
  return {
    unit_id: String(row?.unit_id ?? ""),
    order_index: Number(row?.order_index),
    spoken_text_sha256: String(row?.spoken_text_sha256 ?? ""),
    source_text_sha256: sha256(row?.source_text ?? ""),
  };
}

function addFinding(findings, code, detail = {}) {
  findings.push({ code, ...detail });
}

function exactOrderedBindings(left, right) {
  if (left.length !== right.length) return false;
  return left.every((row, index) => (
    JSON.stringify(unitBinding(row)) === JSON.stringify(unitBinding(right[index]))
  ));
}

function validateProviderRequest(unit, policy, findings) {
  const unitId = String(unit?.unit_id ?? "");
  const compiled = unit?.provider_request;
  const request = compiled?.request;
  const lineage = unit?.spoken_text_lineage;
  const spokenText = String(unit?.spoken_text ?? unit?.tts_spoken_text ?? "");
  const primaryControls = unit?.provider_controls?.primary
    ?? unit?.provider_controls?.qwen3
    ?? unit?.provider_controls?.qwen_local
    ?? {};
  if (compiled?.status !== "compiled"
    || compiled?.adapter?.provider !== policy?.primary?.provider
    || !request) {
    addFinding(findings, "pre_synthesis_provider_request_missing", { unit_id: unitId });
    return;
  }
  if (request.unit_id !== unitId
    || request.text !== spokenText
    || request.text !== lineage?.final_spoken_text) {
    addFinding(findings, "pre_synthesis_provider_payload_text_mismatch", {
      unit_id: unitId,
      spoken_text_sha256: sha256(spokenText),
      provider_text_sha256: sha256(request.text),
      lineage_text_sha256: sha256(lineage?.final_spoken_text),
    });
  }
  const requestSha256 = narrationProviderRequestSha256(request);
  if (compiled.request_sha256 !== requestSha256) {
    addFinding(findings, "pre_synthesis_provider_request_hash_stale", {
      unit_id: unitId,
    });
  }
  const synthesisIdentity = compiled?.synthesis_identity;
  if (!synthesisIdentity
    || compiled.synthesis_identity_sha256
      !== narrationSynthesisIdentitySha256(synthesisIdentity)
    || synthesisIdentity.provider_request_sha256 !== requestSha256
    || synthesisIdentity.unit_id !== unitId
    || synthesisIdentity.spoken_text_sha256 !== sha256(spokenText)
    || synthesisIdentity.provider !== policy?.primary?.provider
    || synthesisIdentity.model_id !== policy?.primary?.model_id
    || synthesisIdentity.model_revision !== policy?.primary?.model_revision
    || synthesisIdentity.voice_id !== policy?.primary?.voice_id
    || synthesisIdentity.voice_sha256 !== policy?.primary?.voice_sha256
    || synthesisIdentity.voice_continuity_contract
      !== policy?.primary?.voice_continuity_contract) {
    addFinding(findings, "pre_synthesis_compiled_identity_stale", {
      unit_id: unitId,
    });
  }
  const expectedSeed = unit?.synthesis_cohort?.batch_seed ?? null;
  if (expectedSeed != null && Number(request.seed) !== Number(expectedSeed)) {
    addFinding(findings, "pre_synthesis_provider_request_seed_stale", {
      unit_id: unitId,
      expected: expectedSeed,
      actual: request.seed ?? null,
    });
  }
  for (const [field, expected] of Object.entries({
    provider: policy?.primary?.provider,
    model_id: policy?.primary?.model_id,
    model_revision: policy?.primary?.model_revision,
    voice_id: policy?.primary?.voice_id,
    voice_sha256: policy?.primary?.voice_sha256,
    voice_continuity_contract: policy?.primary?.voice_continuity_contract,
    reference_audio_path: primaryControls.reference_audio_path
      ?? policy?.primary?.reference_audio_path,
    reference_text: primaryControls.reference_text
      ?? primaryControls.reference_transcript
      ?? policy?.primary?.reference_text,
  })) {
    if ((request?.[field] ?? null) !== (expected ?? null)) {
      addFinding(findings, "pre_synthesis_provider_request_identity_mismatch", {
        unit_id: unitId,
        field,
        expected: expected ?? null,
        actual: request?.[field] ?? null,
      });
    }
  }
  if (request.instruction != null
    || request.style_tags != null
    || request.native_speed != null) {
    addFinding(findings, "pre_synthesis_unsupported_control_in_payload", {
      unit_id: unitId,
    });
  }
}

function validateUnits(plan, policy, findings) {
  const units = planUnits(plan);
  const strictV2 = plan?.schema === "goldflow_tts_generation_plan_v2";
  if (!units.length) {
    addFinding(findings, "pre_synthesis_units_missing");
    return units;
  }
  if (strictV2 && (!Array.isArray(plan.units) || !plan.units.length)) {
    addFinding(findings, "pre_synthesis_canonical_units_missing");
  }
  if (Number(plan?.unit_count) !== units.length) {
    addFinding(findings, "pre_synthesis_unit_count_stale", {
      expected: units.length,
      actual: plan?.unit_count ?? null,
    });
  }
  const seenUnitIds = new Set();
  const seenSourceUnitIds = new Set();
  const hardWordMaximum = Number(policy?.unit_contract?.hard_words_max ?? 60);
  for (const [index, unit] of units.entries()) {
    const unitId = String(unit?.unit_id ?? "").trim();
    const aliases = [unit?.spoken_text, unit?.tts_spoken_text, unit?.qwen_spoken_text]
      .filter((value) => value != null)
      .map(String);
    const spokenText = aliases[0] ?? "";
    const words = spokenText.trim().split(/\s+/u).filter(Boolean).length;
    if (!unitId || seenUnitIds.has(unitId)) {
      addFinding(findings, "pre_synthesis_unit_id_missing_or_duplicate", {
        unit_id: unitId || null,
        order_index: index,
      });
    }
    seenUnitIds.add(unitId);
    if (Number(unit?.order_index) !== index) {
      addFinding(findings, "pre_synthesis_unit_order_not_zero_based_contiguous", {
        unit_id: unitId,
        expected: index,
        actual: unit?.order_index ?? null,
      });
    }
    if (!spokenText.trim() || aliases.some((value) => value !== spokenText)) {
      addFinding(findings, "pre_synthesis_spoken_text_alias_mismatch", {
        unit_id: unitId,
      });
    }
    if (unit?.spoken_text_sha256 !== sha256(spokenText)) {
      addFinding(findings, "pre_synthesis_spoken_text_hash_stale", {
        unit_id: unitId,
      });
    }
    if (Number(unit?.word_count) !== words || words > hardWordMaximum) {
      addFinding(findings, "pre_synthesis_unit_word_contract_failed", {
        unit_id: unitId,
        computed_word_count: words,
        recorded_word_count: unit?.word_count ?? null,
        hard_word_maximum: hardWordMaximum,
      });
    }
    if (!hasTtsTerminalPunctuation(spokenText)) {
      addFinding(findings, "pre_synthesis_unit_not_sentence_complete", {
        unit_id: unitId,
      });
    }
    if (/\p{N}/u.test(spokenText)) {
      addFinding(findings, "pre_synthesis_unresolved_numeric_digit", {
        unit_id: unitId,
      });
    }
    const sourceRefs = Array.isArray(unit?.source_unit_refs)
      ? unit.source_unit_refs
      : [];
    if (!sourceRefs.length) {
      addFinding(findings, "pre_synthesis_source_unit_refs_missing", {
        unit_id: unitId,
      });
    }
    for (const ref of sourceRefs) {
      const sourceUnitId = String(ref?.source_unit_id ?? "").trim();
      const sourceText = String(ref?.source_text ?? "");
      const captionText = String(ref?.caption_text ?? sourceText);
      if (!sourceUnitId || seenSourceUnitIds.has(sourceUnitId)) {
        addFinding(findings, "pre_synthesis_source_component_missing_or_duplicate", {
          unit_id: unitId,
          source_unit_id: sourceUnitId || null,
        });
      }
      seenSourceUnitIds.add(sourceUnitId);
      if (ref?.source_text_sha256 !== sha256(sourceText)
        || ref?.caption_text_sha256 !== sha256(captionText)) {
        addFinding(findings, "pre_synthesis_source_component_hash_stale", {
          unit_id: unitId,
          source_unit_id: sourceUnitId || null,
        });
      }
    }
    validateProviderRequest(unit, policy, findings);
  }
  if (strictV2) {
    for (const field of [
      "generation_units",
      "narration_generation_units",
      "qwen_generation_units",
    ]) {
      const rows = flattenedSegmentUnits(plan, field);
      if (!rows.length || !exactOrderedBindings(rows, units)) {
        addFinding(findings, "pre_synthesis_segment_unit_alias_stale", {
          field,
          expected_count: units.length,
          actual_count: rows.length,
        });
      }
    }
  }
  const boundary = plan?.sentence_unit_boundary_integrity;
  if (boundary?.status !== "passed"
    || Number(boundary?.unit_count) !== units.length
    || Number(boundary?.clean_start_count) !== units.length
    || Number(boundary?.terminal_punctuation_count) !== units.length
    || Number(boundary?.within_hard_word_maximum_count) !== units.length
    || Number(boundary?.within_voice_segment_boundary_count) !== units.length
    || Number(boundary?.blocker_count) !== 0
    || (boundary?.blockers ?? []).length !== 0) {
    addFinding(findings, "pre_synthesis_sentence_boundary_coverage_stale");
  }
  return units;
}

export function buildNarrationPreSynthesisGate({
  plan,
  planPath = null,
  planFileSha256 = null,
  identityPath = null,
  identityFileSha256 = null,
  scriptPath = null,
  scriptSha256 = null,
  policy,
  planPolicy,
  sourceArtifactHashes = {},
  textIr = null,
  textIrPath = null,
  textIrFileSha256 = null,
  spokenTextAudit = null,
  spokenTextAuditPath = null,
  spokenTextAuditFileSha256 = null,
  overridesSha256 = null,
  referenceAssetHashes = {},
  synthesisScope = null,
  historicalSynthesisAuthorized = false,
  generatedAt = new Date().toISOString(),
} = {}) {
  const findings = [];
  if (plan?.schema !== "goldflow_tts_generation_plan_v2") {
    addFinding(findings, "pre_synthesis_plan_schema_invalid", {
      actual: plan?.schema ?? null,
    });
  }
  if (plan?.status !== "passed") {
    addFinding(findings, "pre_synthesis_plan_not_passed", {
      actual: plan?.status ?? null,
    });
  }
  const canonicalPlanSha256 = canonicalNarrationPlanSha256(plan);
  if (!plan?.plan_sha256 || plan.plan_sha256 !== canonicalPlanSha256) {
    addFinding(findings, "pre_synthesis_canonical_plan_hash_stale", {
      expected: canonicalPlanSha256,
      actual: plan?.plan_sha256 ?? null,
    });
  }
  if (!planFileSha256 || !identityFileSha256 || !scriptSha256) {
    addFinding(findings, "pre_synthesis_primary_artifact_hash_missing");
  }
  if (plan?.source_script_hash !== scriptSha256
    || plan?.source_hashes?.script_clean_sha256 !== scriptSha256) {
    addFinding(findings, "pre_synthesis_script_hash_stale", {
      expected: scriptSha256,
      actual: plan?.source_script_hash ?? null,
    });
  }
  if (plan?.source_hashes?.run_identity_sha256 !== identityFileSha256) {
    addFinding(findings, "pre_synthesis_run_identity_hash_stale", {
      expected: identityFileSha256,
      actual: plan?.source_hashes?.run_identity_sha256 ?? null,
    });
  }
  for (const [field, actual] of Object.entries(sourceArtifactHashes)) {
    if (!actual || plan?.source_hashes?.[field] !== actual) {
      addFinding(findings, "pre_synthesis_source_artifact_hash_stale", {
        field,
        expected: actual ?? null,
        actual: plan?.source_hashes?.[field] ?? null,
      });
    }
  }
  if (policy?.status !== "passed") {
    addFinding(findings, "pre_synthesis_identity_policy_blocked", {
      policy_findings: policy?.findings ?? [],
    });
  }
  if (planPolicy?.status !== "passed") {
    addFinding(findings, "pre_synthesis_plan_policy_blocked", {
      policy_findings: planPolicy?.findings ?? [],
    });
  }
  const units = validateUnits(plan, policy, findings);
  const coverage = plan?.text_integrity_coverage;
  if (coverage?.status !== "passed"
    || coverage?.script_to_plan_source?.status !== "passed"
    || coverage?.plan_source_to_spoken?.status !== "passed"
    || Number(coverage?.plan_source_to_spoken?.unit_count) !== units.length
    || Number(coverage?.script_to_plan_source?.expected_token_count) <= 0
    || Number(coverage?.script_to_plan_source?.expected_token_count)
      !== Number(coverage?.script_to_plan_source?.actual_token_count)
    || Number(coverage?.plan_source_to_spoken?.expected_token_count)
      !== Number(coverage?.plan_source_to_spoken?.actual_token_count)
    || Number(coverage?.plan_source_to_spoken?.mismatch_unit_count) !== 0
    || (coverage?.findings ?? []).length !== 0) {
    addFinding(findings, "pre_synthesis_source_coverage_incomplete");
  }
  const systemCoverage = plan?.system_ui_speech_coverage;
  if (systemCoverage?.status !== "passed"
    || Number(systemCoverage?.expected_count) !== Number(systemCoverage?.planned_count)
    || Number(systemCoverage?.missing_count) !== 0
    || Number(systemCoverage?.unexpected_count) !== 0
    || (systemCoverage?.missing ?? []).length !== 0
    || (systemCoverage?.unexpected ?? []).length !== 0) {
    addFinding(findings, "pre_synthesis_system_ui_coverage_incomplete");
  }
  const textIrValidation = validateNarrationTextIr(textIr, units, {
    sourceScriptSha256: scriptSha256,
    generationPlanSha256: plan?.plan_sha256,
  });
  if (!textIrFileSha256 || textIrValidation.status !== "passed") {
    addFinding(findings, "pre_synthesis_text_lineage_invalid", {
      text_ir_findings: textIrValidation.findings,
    });
  }
  const spokenAuditMatches = ttsSpokenTextAuditMatches({
    audit: spokenTextAudit,
    plan,
    sourceScriptSha256: scriptSha256,
    overridesSha256,
  });
  if (!spokenTextAuditFileSha256
    || !spokenAuditMatches
    || plan?.tts_spoken_text_audit?.audit_sha256
      !== ttsSpokenTextAuditSha256(spokenTextAudit)
    || plan?.tts_spoken_text_audit?.unit_contract_sha256
      !== spokenTextAudit?.unit_contract_sha256
    || Number(spokenTextAudit?.blocker_count) !== 0) {
    addFinding(findings, "pre_synthesis_spoken_text_audit_invalid", {
      audit_status: spokenTextAudit?.status ?? null,
      blocker_count: spokenTextAudit?.blocker_count ?? null,
    });
  }
  for (const [label, binding] of Object.entries(referenceAssetHashes)) {
    if (!binding?.expected || binding.actual !== binding.expected) {
      addFinding(findings, "pre_synthesis_reference_asset_hash_stale", {
        label,
        expected: binding?.expected ?? null,
        actual: binding?.actual ?? null,
        path: binding?.path ?? null,
      });
    }
  }
  const allUnitIds = units.map((unit) => String(unit.unit_id));
  const authorizedIds = (
    synthesisScope?.authorized_synthesis_unit_ids ?? allUnitIds
  ).map(String);
  const preservedIds = (synthesisScope?.preserved_unit_ids ?? []).map(String);
  const preservedArtifacts = Array.isArray(synthesisScope?.preserved_artifacts)
    ? synthesisScope.preserved_artifacts
    : [];
  const duplicateAuthorizedIds = authorizedIds.filter(
    (unitId, index, rows) => rows.indexOf(unitId) !== index,
  );
  if (duplicateAuthorizedIds.length
    || authorizedIds.some((unitId) => !allUnitIds.includes(unitId))) {
    addFinding(findings, "pre_synthesis_scope_invalid", {
      authorized_synthesis_unit_ids: authorizedIds,
    });
  }
  const duplicatePreservedIds = preservedIds.filter(
    (unitId, index, rows) => rows.indexOf(unitId) !== index,
  );
  if (duplicatePreservedIds.length
    || preservedIds.some((unitId) => !allUnitIds.includes(unitId))) {
    addFinding(findings, "pre_synthesis_preserved_scope_invalid", {
      preserved_unit_ids: preservedIds,
    });
  }
  const overlappingScopeIds = authorizedIds.filter((unitId) => (
    preservedIds.includes(unitId)
  ));
  if (overlappingScopeIds.length) {
    addFinding(findings, "pre_synthesis_authorized_scope_overlaps_preserved", {
      unit_ids: overlappingScopeIds,
    });
  }
  const preservedArtifactIds = preservedArtifacts.map((row) => String(row?.unit_id ?? ""));
  let boundBatchPlan = plan?.qwen_liam_batch_plan;
  // A pilot opening is a fresh, explicit phase of a complete immutable plan.
  // It must not borrow the full episode's cohorts or authorize the remainder.
  if (synthesisScope?.mode === "pilot_opening_only") {
    boundBatchPlan = plan?.pilot_phase_batch_plans?.opening;
    const prefix = units.slice(0, authorizedIds.length);
    const batchValidation = validateQwenLiamBatchPlan(
      boundBatchPlan, prefix, policy?.synthesis_contract,
    );
    if (!authorizedIds.length || authorizedIds.length >= allUnitIds.length
      || authorizedIds.some((id, index) => id !== allUnitIds[index])
      || preservedIds.length || preservedArtifacts.length
      || !synthesisScope?.evidence_path
      || !/^[a-f0-9]{64}$/u.test(String(synthesisScope?.evidence_sha256 ?? ""))
      || batchValidation.status !== "passed") {
      addFinding(findings, "pre_synthesis_pilot_opening_scope_invalid", {
        batch_findings: batchValidation.findings,
      });
    }
  }
  // Remaining synthesis is a distinct, already-frozen phase. The accepted
  // opening is preserved with its original batch identity, never re-cohorted.
  if (synthesisScope?.mode === "pilot_remaining_only") {
    boundBatchPlan = plan?.pilot_phase_batch_plans?.remaining;
    const openingIds = plan?.pilot_opening_unit_ids ?? [];
    const tail = units.slice(openingIds.length);
    const batchValidation = validateQwenLiamBatchPlan(boundBatchPlan, tail, policy?.synthesis_contract);
    if (!openingIds.length || !tail.length
      || openingIds.some((id, index) => id !== allUnitIds[index])
      || JSON.stringify(preservedIds) !== JSON.stringify(openingIds)
      || JSON.stringify(authorizedIds) !== JSON.stringify(tail.map((unit) => String(unit.unit_id)))
      || preservedArtifacts.length !== openingIds.length
      || !synthesisScope?.evidence_path
      || !/^[a-f0-9]{64}$/u.test(String(synthesisScope?.evidence_sha256 ?? ""))
      || batchValidation.status !== "passed") {
      addFinding(findings, "pre_synthesis_pilot_remaining_scope_invalid", {
        batch_findings: batchValidation.findings,
      });
    }
  }
  if (preservedArtifactIds.length !== preservedIds.length
    || preservedArtifactIds.some((unitId, index) => unitId !== preservedIds[index])
    || preservedArtifacts.some((row) => (
      !row?.audio_path
      || !/^[a-f0-9]{64}$/u.test(String(row?.audio_sha256 ?? ""))
      || !row?.synthesis_sidecar_path
      || !/^[a-f0-9]{64}$/u.test(String(row?.synthesis_sidecar_sha256 ?? ""))
      || !/^[a-f0-9]{64}$/u.test(String(row?.synthesis_identity_sha256 ?? ""))
      || !/^[a-f0-9]{64}$/u.test(String(
        row?.selected_report_synthesis_identity_sha256 ?? "",
      ))
      || !/^[a-f0-9]{64}$/u.test(String(row?.spoken_text_sha256 ?? ""))
    ))) {
    addFinding(findings, "pre_synthesis_preserved_artifact_bindings_invalid");
  }
  const report = {
    schema: NARRATION_PRE_SYNTHESIS_GATE_SCHEMA,
    status: findings.length ? "blocked" : "passed",
    generated_at: generatedAt,
    updated_at: generatedAt,
    phase: "before_model_load_and_synthesis",
    production_stage_passed: false,
    model_load_performed: false,
    synthesis_invoked: false,
    historical_synthesis_authorized: Boolean(historicalSynthesisAuthorized),
    bindings: {
      run_identity_path: identityPath,
      run_identity_file_sha256: identityFileSha256,
      script_path: scriptPath,
      script_sha256: scriptSha256,
      narration_generation_plan_path: planPath,
      narration_generation_plan_sha256: plan?.plan_sha256 ?? null,
      narration_generation_plan_file_sha256: planFileSha256,
      narration_text_ir_path: textIrPath,
      narration_text_ir_file_sha256: textIrFileSha256,
      narration_text_ir_sha256: textIr?.ir_sha256 ?? null,
      tts_spoken_text_audit_path: spokenTextAuditPath,
      tts_spoken_text_audit_file_sha256: spokenTextAuditFileSha256,
      tts_spoken_text_audit_sha256: spokenTextAudit?.audit_sha256 ?? null,
      tts_spoken_overrides_sha256: overridesSha256,
      source_artifact_hashes: sourceArtifactHashes,
      reference_asset_hashes: referenceAssetHashes,
      batch_plan_sha256: boundBatchPlan?.batch_plan_sha256 ?? null,
    },
    scope: {
      mode: synthesisScope?.mode ?? "initial_full_synthesis",
      authorized_synthesis_unit_ids: authorizedIds,
      authorized_synthesis_unit_count: authorizedIds.length,
      preserved_unit_ids: preservedIds,
      preserved_unit_count: preservedIds.length,
      preserved_artifacts: preservedArtifacts,
      evidence_path: synthesisScope?.evidence_path ?? null,
      evidence_sha256: synthesisScope?.evidence_sha256 ?? null,
    },
    contract: {
      provider: policy?.primary?.provider ?? null,
      model_id: policy?.primary?.model_id ?? null,
      model_revision: policy?.primary?.model_revision ?? null,
      voice_id: policy?.primary?.voice_id ?? null,
      voice_sha256: policy?.primary?.voice_sha256 ?? null,
      voice_continuity_contract:
        policy?.primary?.voice_continuity_contract ?? null,
      reference_audio_sha256:
        policy?.primary?.reference_audio_sha256 ?? null,
      reference_text_sha256:
        policy?.primary?.reference_text_sha256 ?? null,
      synthesis_contract: policy?.synthesis_contract ?? null,
      unit_contract: policy?.unit_contract ?? null,
      no_automatic_retry: true,
      exact_unit_or_boundary_repair_only: true,
    },
    unit_count: units.length,
    source_component_count: units.reduce(
      (sum, unit) => sum + Number(unit?.source_unit_refs?.length ?? 0),
      0,
    ),
    findings,
  };
  report.gate_sha256 = narrationPreSynthesisGateSha256(report);
  return report;
}
