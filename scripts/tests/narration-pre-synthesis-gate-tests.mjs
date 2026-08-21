import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  authorizeNarrationPreSynthesisGate,
  buildNarrationPreSynthesisBootstrapGate,
  buildNarrationPreSynthesisGate,
  canonicalNarrationPlanSha256,
  narrationPreSynthesisGateSha256,
} from "../lib/narration-pre-synthesis-gate.mjs";
import {
  buildNarrationTextIr,
} from "../lib/narration-text-ir.mjs";
import {
  compileNarrationProviderRequest,
  narrationProviderRequestSha256,
  narrationSynthesisIdentitySha256,
} from "../lib/narration-provider-adapter.mjs";
import {
  buildTtsSpokenTextAudit,
} from "../lib/tts-spoken-text-audit.mjs";
import {
  incompleteUnitResumeProvenanceForTests,
  narrationSynthesisScopeForTests,
  preservedTtsFinalInputsForTests,
  preservedTtsSelectionsForTests,
} from "../narration-tts-episode.mjs";
import {
  stageOutputPathMatches,
} from "../lib/pipeline-stage-registry.mjs";

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function lineage(unitId, sourceText, spokenText) {
  const value = {
    schema: "goldflow_spoken_text_lineage_v1",
    policy: "fixture exact text-bearing lineage",
    components: [{
      source_unit_id: unitId,
      source_text: sourceText,
      source_text_sha256: sha256(sourceText),
      compiled_spoken_text: spokenText,
      compiled_spoken_text_sha256: sha256(spokenText),
      transformation_receipts: [],
    }],
    pre_direction_spoken_text: spokenText,
    pre_direction_spoken_text_sha256: sha256(spokenText),
    final_transformations: [],
    final_spoken_text: spokenText,
    final_spoken_text_sha256: sha256(spokenText),
  };
  return { ...value, lineage_sha256: sha256(JSON.stringify(value)) };
}

function fixture({
  sourceText = "The lantern dimmed before the traveler entered.",
  spokenText = sourceText,
} = {}) {
  const scriptSha256 = "1".repeat(64);
  const identityFileSha256 = "2".repeat(64);
  const speakabilitySha256 = "3".repeat(64);
  const overridesSha256 = "4".repeat(64);
  const policy = {
    status: "passed",
    primary: {
      provider: "qwen_local",
      model_id: "fixture-qwen-model",
      model_revision: "fixture-revision",
      voice_id: "fixture-voice",
      voice_sha256: "5".repeat(64),
      voice_continuity_contract: "fixture-owned-voice-v1",
      reference_audio_path: "/fixture/reference.wav",
      reference_audio_sha256: "6".repeat(64),
      reference_text: "A stable owned reference sentence.",
      reference_text_sha256: sha256("A stable owned reference sentence."),
    },
    unit_contract: { hard_words_max: 60 },
    synthesis_contract: { mode: "fixture_fixed_batch" },
  };
  const unitId = "unit_001";
  const unit = {
    unit_id: unitId,
    order_index: 0,
    kind: "narration",
    source_text: sourceText,
    source_text_sha256: sha256(sourceText),
    caption_text: sourceText,
    caption_text_sha256: sha256(sourceText),
    spoken_text: spokenText,
    tts_spoken_text: spokenText,
    qwen_spoken_text: spokenText,
    spoken_text_sha256: sha256(spokenText),
    word_count: spokenText.trim().split(/\s+/u).length,
    source_unit_refs: [{
      source_unit_id: unitId,
      source_text: sourceText,
      source_text_sha256: sha256(sourceText),
      caption_text: sourceText,
      caption_text_sha256: sha256(sourceText),
    }],
    spoken_text_transformations: [],
    spoken_text_lineage: lineage(unitId, sourceText, spokenText),
  };
  unit.provider_request = compileNarrationProviderRequest(unit, {
    provider: policy.primary.provider,
    modelId: policy.primary.model_id,
    modelRevision: policy.primary.model_revision,
    voiceId: policy.primary.voice_id,
    voiceSha256: policy.primary.voice_sha256,
    voiceContinuityContract: policy.primary.voice_continuity_contract,
    referenceAudioPath: policy.primary.reference_audio_path,
    referenceText: policy.primary.reference_text,
    seed: 17,
  });
  const plan = {
    schema: "goldflow_tts_generation_plan_v2",
    status: "passed",
    source_script_hash: scriptSha256,
    source_hashes: {
      script_clean_sha256: scriptSha256,
      script_speakability_report_sha256: speakabilitySha256,
      tts_spoken_overrides_sha256: overridesSha256,
      run_identity_sha256: identityFileSha256,
    },
    unit_count: 1,
    units: [unit],
    segments: [{
      generation_units: [structuredClone(unit)],
      narration_generation_units: [structuredClone(unit)],
      qwen_generation_units: [structuredClone(unit)],
    }],
    sentence_unit_boundary_integrity: {
      status: "passed",
      unit_count: 1,
      clean_start_count: 1,
      terminal_punctuation_count: 1,
      within_hard_word_maximum_count: 1,
      within_voice_segment_boundary_count: 1,
      blocker_count: 0,
      blockers: [],
    },
    text_integrity_coverage: {
      status: "passed",
      script_to_plan_source: {
        status: "passed",
        expected_token_count: 8,
        actual_token_count: 8,
      },
      plan_source_to_spoken: {
        status: "passed",
        unit_count: 1,
        expected_token_count: 8,
        actual_token_count: 8,
        mismatch_unit_count: 0,
      },
      findings: [],
    },
    system_ui_speech_coverage: {
      status: "passed",
      expected_count: 0,
      planned_count: 0,
      missing_count: 0,
      unexpected_count: 0,
      missing: [],
      unexpected: [],
    },
  };
  const audit = buildTtsSpokenTextAudit({
    plan,
    sourceScriptSha256: scriptSha256,
    overridesSha256,
    provider: policy.primary.provider,
    voiceId: policy.primary.voice_id,
    generatedAt: "2026-08-21T00:00:00.000Z",
  });
  plan.tts_spoken_text_audit = {
    status: audit.status,
    audit_sha256: audit.audit_sha256,
    unit_contract_sha256: audit.unit_contract_sha256,
    blocker_count: audit.blocker_count,
  };
  plan.plan_sha256 = canonicalNarrationPlanSha256(plan);
  const textIr = buildNarrationTextIr({
    sourceScriptSha256: scriptSha256,
    generationPlanSha256: plan.plan_sha256,
    units: plan.units,
  });
  const inputs = {
    plan,
    planPath: "/fixture/narration_generation_plan.json",
    planFileSha256: "7".repeat(64),
    identityPath: "/fixture/run_identity.json",
    identityFileSha256,
    scriptPath: "/fixture/script_clean.md",
    scriptSha256,
    policy,
    planPolicy: { status: "passed", findings: [] },
    sourceArtifactHashes: {
      script_clean_sha256: scriptSha256,
      script_speakability_report_sha256: speakabilitySha256,
      tts_spoken_overrides_sha256: overridesSha256,
    },
    textIr,
    textIrPath: "/fixture/narration_text_ir.json",
    textIrFileSha256: "8".repeat(64),
    spokenTextAudit: audit,
    spokenTextAuditPath: "/fixture/tts_spoken_text_audit.json",
    spokenTextAuditFileSha256: "9".repeat(64),
    overridesSha256,
    referenceAssetHashes: {
      reference_audio: {
        path: policy.primary.reference_audio_path,
        expected: policy.primary.reference_audio_sha256,
        actual: policy.primary.reference_audio_sha256,
      },
      reference_text: {
        expected: policy.primary.reference_text_sha256,
        actual: policy.primary.reference_text_sha256,
      },
    },
    synthesisScope: {
      mode: "initial_full_synthesis",
      authorized_synthesis_unit_ids: [unitId],
      preserved_unit_ids: [],
      preserved_artifacts: [],
    },
  };
  return { inputs, plan, policy, audit, textIr };
}

function findingCodes(gate) {
  return new Set(gate.findings.map((finding) => finding.code));
}

const valid = fixture();
assert.equal(
  stageOutputPathMatches(
    "qwen_tts_stitch",
    "narration_tts_pre_synthesis_gate_ep_01.json",
  ),
  true,
);
const passedGate = buildNarrationPreSynthesisGate(valid.inputs);
assert.equal(passedGate.status, "passed");
assert.equal(passedGate.model_load_performed, false);
assert.equal(passedGate.synthesis_invoked, false);
assert.equal(typeof passedGate.updated_at, "string");
assert.equal(passedGate.gate_sha256, narrationPreSynthesisGateSha256(passedGate));

const authorizedGate = authorizeNarrationPreSynthesisGate(passedGate, {
  generatedAt: "2026-08-21T00:00:01.000Z",
});
assert.equal(authorizedGate.model_load_performed, true);
assert.equal(authorizedGate.synthesis_invoked, true);
assert.equal(authorizedGate.updated_at, "2026-08-21T00:00:01.000Z");
assert.equal(
  authorizedGate.authorization.validation_gate_sha256,
  passedGate.gate_sha256,
);
assert.equal(
  authorizedGate.gate_sha256,
  narrationPreSynthesisGateSha256(authorizedGate),
);
assert.equal(authorizedGate.historical_synthesis_authorized, false);

const bootstrapAfterAuthorizedAttempt = buildNarrationPreSynthesisBootstrapGate({
  episodeDir: "/fixture/episode",
  identityPath: "/fixture/run_identity.json",
  priorGate: authorizedGate,
  generatedAt: "2026-08-21T00:00:02.000Z",
});
assert.equal(bootstrapAfterAuthorizedAttempt.status, "pending_validation");
assert.equal(bootstrapAfterAuthorizedAttempt.model_load_performed, false);
assert.equal(bootstrapAfterAuthorizedAttempt.synthesis_invoked, false);
assert.equal(
  bootstrapAfterAuthorizedAttempt.historical_synthesis_authorized,
  true,
);
assert.equal(
  bootstrapAfterAuthorizedAttempt.gate_sha256,
  narrationPreSynthesisGateSha256(bootstrapAfterAuthorizedAttempt),
);
const fullGateAfterAuthorizedAttempt = buildNarrationPreSynthesisGate({
  ...valid.inputs,
  historicalSynthesisAuthorized:
    bootstrapAfterAuthorizedAttempt.historical_synthesis_authorized,
});
assert.equal(fullGateAfterAuthorizedAttempt.status, "passed");
assert.equal(fullGateAfterAuthorizedAttempt.model_load_performed, false);
assert.equal(fullGateAfterAuthorizedAttempt.synthesis_invoked, false);
assert.equal(fullGateAfterAuthorizedAttempt.historical_synthesis_authorized, true);

const stalePlan = structuredClone(valid.inputs);
stalePlan.plan.units[0].spoken_text = "A stale mutation entered.";
const stalePlanGate = buildNarrationPreSynthesisGate(stalePlan);
assert.equal(stalePlanGate.status, "blocked");
assert.ok(findingCodes(stalePlanGate).has("pre_synthesis_canonical_plan_hash_stale"));

const staleLineage = structuredClone(valid.inputs);
staleLineage.plan.units[0].spoken_text_lineage.final_spoken_text = "Wrong lineage.";
staleLineage.plan.units[0].spoken_text_lineage.final_spoken_text_sha256 = sha256("Wrong lineage.");
const unsignedLineage = structuredClone(staleLineage.plan.units[0].spoken_text_lineage);
delete unsignedLineage.lineage_sha256;
staleLineage.plan.units[0].spoken_text_lineage.lineage_sha256 = sha256(
  JSON.stringify(unsignedLineage),
);
staleLineage.plan.plan_sha256 = canonicalNarrationPlanSha256(staleLineage.plan);
const staleLineageGate = buildNarrationPreSynthesisGate(staleLineage);
assert.equal(staleLineageGate.status, "blocked");
assert.ok(findingCodes(staleLineageGate).has("pre_synthesis_text_lineage_invalid"));

const staleIdentity = structuredClone(valid.inputs);
staleIdentity.policy.primary.voice_id = "wrong-voice";
const staleIdentityGate = buildNarrationPreSynthesisGate(staleIdentity);
assert.equal(staleIdentityGate.status, "blocked");
assert.ok(findingCodes(staleIdentityGate).has(
  "pre_synthesis_provider_request_identity_mismatch",
));

const stalePayload = structuredClone(valid.inputs);
const compiled = stalePayload.plan.units[0].provider_request;
compiled.request.text = "Provider payload diverged.";
compiled.request_sha256 = narrationProviderRequestSha256(compiled.request);
compiled.synthesis_identity.provider_request_sha256 = compiled.request_sha256;
compiled.synthesis_identity_sha256 = narrationSynthesisIdentitySha256(
  compiled.synthesis_identity,
);
stalePayload.plan.plan_sha256 = canonicalNarrationPlanSha256(stalePayload.plan);
const stalePayloadGate = buildNarrationPreSynthesisGate(stalePayload);
assert.equal(stalePayloadGate.status, "blocked");
assert.ok(findingCodes(stalePayloadGate).has(
  "pre_synthesis_provider_payload_text_mismatch",
));

const initialism = fixture({
  sourceText: "The CEO approved the sealed transfer before dawn.",
  spokenText: "The CEO approved the sealed transfer before dawn.",
});
assert.equal(initialism.audit.status, "blocked");
assert.ok(initialism.audit.blockers.some(
  (finding) => finding.code
    === "unresolved_known_initialism_in_spoken_text:CEO",
));
const initialismGate = buildNarrationPreSynthesisGate(initialism.inputs);
assert.equal(initialismGate.status, "blocked");
assert.ok(findingCodes(initialismGate).has("pre_synthesis_spoken_text_audit_invalid"));

const numericDigit = fixture({
  sourceText: "Agent 7 approved the sealed transfer before dawn.",
  spokenText: "Agent 7 approved the sealed transfer before dawn.",
});
const numericDigitGate = buildNarrationPreSynthesisGate(numericDigit.inputs);
assert.equal(numericDigitGate.status, "blocked");
assert.ok(findingCodes(numericDigitGate).has("pre_synthesis_unresolved_numeric_digit"));

const qa = {
  status: "passed",
  audio_sha256: "a".repeat(64),
  findings: [],
};
const preservedPolicy = {
  primary: {
    provider: "qwen_local",
    model_id: "fixture-qwen-model",
    voice_id: "fixture-voice",
    voice_sha256: "b".repeat(64),
    voice_continuity_contract: "fixture-owned-voice-v1",
  },
};
const preservationUnits = [
  { unit_id: "u1", spoken_text_sha256: "c".repeat(64) },
  { unit_id: "u2", spoken_text_sha256: "d".repeat(64) },
];
const priorResult = {
  unit_id: "u1",
  attempt: 1,
  provider: "qwen_local",
  model_id: "fixture-qwen-model",
  voice_id: "fixture-voice",
  voice_sha256: "b".repeat(64),
  voice_continuity_contract: "fixture-owned-voice-v1",
  spoken_text_sha256: "c".repeat(64),
  synthesis_identity_sha256: "e".repeat(64),
  audio_path: "/fixture/u1.wav",
  audio_sha256: "a".repeat(64),
};
const preservation = preservedTtsSelectionsForTests({
  units: preservationUnits,
  priorReport: {
    narration_generation_plan_sha256: "f".repeat(64),
    narration_generation_plan_file_sha256: "0".repeat(64),
    results: [priorResult],
  },
  priorUnitQa: {
    narration_generation_plan_sha256: "f".repeat(64),
    narration_generation_plan_file_sha256: "0".repeat(64),
    selected_units: [{ ...priorResult, qa }],
  },
  policy: preservedPolicy,
  canonicalPlanSha256: "f".repeat(64),
  planFileSha256: "0".repeat(64),
});
assert.equal(preservation.status, "passed");
assert.deepEqual(preservation.preserved_unit_ids, ["u1"]);

const preservedCandidate = {
  ...priorResult,
  seed: 17,
  synthesis_mode: "fixed_batch4_length_matched_v1",
  batch_plan_sha256: "1".repeat(64),
  cohort_id: "cohort-1",
  cohort_sha256: "2".repeat(64),
  selected_report_synthesis_identity_sha256: "3".repeat(64),
  preservation_provenance: {
    synthesis_sidecar_path: "/fixture/u1.json",
    synthesis_sidecar_sha256: "4".repeat(64),
  },
};
const interruptedScope = narrationSynthesisScopeForTests({
  units: preservationUnits,
  preservedCandidates: [preservedCandidate],
});
assert.equal(
  interruptedScope.mode,
  "interrupted_full_synthesis_resume_preserving_accepted_units",
);
assert.deepEqual(interruptedScope.authorized_synthesis_unit_ids, ["u2"]);
assert.deepEqual(interruptedScope.preserved_unit_ids, ["u1"]);
assert.equal(interruptedScope.preserved_artifacts[0].audio_sha256, "a".repeat(64));
const runnerFacingResumeJobs = preservationUnits.filter((unit) => (
  interruptedScope.authorized_synthesis_unit_ids.includes(unit.unit_id)
));
assert.deepEqual(runnerFacingResumeJobs.map((unit) => unit.unit_id), ["u2"]);
assert.equal(runnerFacingResumeJobs.some((unit) => unit.unit_id === "u1"), false);
const preservedFinalInputs = preservedTtsFinalInputsForTests({
  units: preservationUnits,
  candidatePool: [preservedCandidate, preservedCandidate],
  preservedForInvocation: [preservedCandidate],
  priorSynthesisRuns: [
    { report_sha256: "8".repeat(64), report_path: "/fixture/run-1.json" },
    { report_sha256: "8".repeat(64), report_path: "/fixture/run-1.json" },
  ],
  policy: preservedPolicy,
});
assert.deepEqual(
  preservedFinalInputs.selectedRows.map((row) => row.unit_id),
  ["u1"],
);
assert.equal(preservedFinalInputs.selectedRows[0].wav, "/fixture/u1.wav");
assert.equal(preservedFinalInputs.candidates.length, 1);
assert.equal(preservedFinalInputs.synthesisRuns.length, 1);
const resumeProvenance = incompleteUnitResumeProvenanceForTests({
  unit: preservationUnits[1],
  cohortBinding: {
    batch_plan_sha256: "1".repeat(64),
    cohort_id: "cohort-2",
    cohort_sha256: "6".repeat(64),
  },
  batchPlanSha256: "1".repeat(64),
  preSynthesisGateSha256: "7".repeat(64),
});
assert.equal(resumeProvenance.unit_id, "u2");
assert.equal(
  resumeProvenance.reason,
  "unit_has_no_hash_verified_accepted_selection_after_interrupted_invocation",
);

const exactScope = narrationSynthesisScopeForTests({
  units: preservationUnits,
  preservedCandidates: [preservedCandidate],
  requestedRecoveryScope: {
    requested_unit_ids: ["u2"],
  },
  evidencePath: "/fixture/retry.json",
  evidenceSha256: "5".repeat(64),
});
assert.deepEqual(exactScope.authorized_synthesis_unit_ids, ["u2"]);
assert.deepEqual(exactScope.preserved_unit_ids, ["u1"]);

const stalePreservation = preservedTtsSelectionsForTests({
  units: preservationUnits,
  priorReport: {
    narration_generation_plan_sha256: "stale",
    narration_generation_plan_file_sha256: "0".repeat(64),
    results: [priorResult],
  },
  priorUnitQa: {
    narration_generation_plan_sha256: "f".repeat(64),
    narration_generation_plan_file_sha256: "0".repeat(64),
    selected_units: [{ ...priorResult, qa }],
  },
  policy: preservedPolicy,
  canonicalPlanSha256: "f".repeat(64),
  planFileSha256: "0".repeat(64),
});
assert.equal(stalePreservation.status, "blocked");
assert.ok(stalePreservation.findings.some(
  (finding) => finding.code === "preserved_tts_prior_report_plan_binding_stale",
));

const stalePreservedIdentity = preservedTtsSelectionsForTests({
  units: preservationUnits,
  priorReport: {
    narration_generation_plan_sha256: "f".repeat(64),
    narration_generation_plan_file_sha256: "0".repeat(64),
    results: [priorResult],
  },
  priorUnitQa: {
    narration_generation_plan_sha256: "f".repeat(64),
    narration_generation_plan_file_sha256: "0".repeat(64),
    selected_units: [{
      ...priorResult,
      synthesis_identity_sha256: "9".repeat(64),
      qa,
    }],
  },
  policy: preservedPolicy,
  canonicalPlanSha256: "f".repeat(64),
  planFileSha256: "0".repeat(64),
});
assert.equal(stalePreservedIdentity.status, "blocked");
assert.ok(stalePreservedIdentity.findings.some(
  (finding) => finding.code === "preserved_tts_selection_missing_or_stale",
));

console.log("narration pre-synthesis gate tests passed");
