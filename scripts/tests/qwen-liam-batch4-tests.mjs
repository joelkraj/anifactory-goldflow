import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
  QWEN_LIAM_SERIAL_SYNTHESIS_CONTRACT,
  defaultNarrationVoiceProviderOptions,
  narrationTtsPolicyForIdentity,
} from "../lib/narration-tts-policy.mjs";
import {
  QWEN_LIAM_EXACT_UNIT_RECOVERY_MODE,
  buildQwenLiamBatchPlan,
  qwenBatchBindingByUnit,
  validateQwenLiamBatchPlan,
} from "../lib/qwen-liam-batch-contract.mjs";
import {
  exactUnitRecoveryProvenanceForTests,
} from "../narration-tts-episode.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function unit(unitId, orderIndex, wordCount, suffix = "") {
  const spokenText = `${Array.from(
    { length: wordCount },
    (_, index) => `word${index + 1}`,
  ).join(" ")}${suffix}.`;
  return {
    unit_id: unitId,
    order_index: orderIndex,
    spoken_text: spokenText,
    spoken_text_sha256: sha256(spokenText),
    word_count: wordCount,
  };
}

function testLengthMatchedCohortsAndOriginalOrder() {
  const units = [
    unit("unit-c", 2, 55),
    unit("unit-a", 0, 20),
    unit("unit-e", 4, 60),
    unit("unit-b", 1, 21),
    unit("unit-d", 3, 56),
  ];
  const plan = buildQwenLiamBatchPlan(
    units,
    QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
  );
  assert.equal(plan.unit_count, 5);
  assert.equal(plan.cohort_count, 2);
  assert.deepEqual(plan.original_order_unit_ids, [
    "unit-a",
    "unit-b",
    "unit-c",
    "unit-d",
    "unit-e",
  ]);
  assert.deepEqual(plan.synthesis_order_unit_ids, [
    "unit-a",
    "unit-b",
    "unit-c",
    "unit-d",
    "unit-e",
  ]);
  assert.equal(plan.cohorts[0].effective_batch_size, 4);
  assert.equal(plan.cohorts[1].effective_batch_size, 1);
  assert.equal(plan.cohorts[1].nominal_batch_size, 4);
  assert.equal(
    validateQwenLiamBatchPlan(
      structuredClone(plan),
      units,
      QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
    ).status,
    "passed",
  );
  const bindings = qwenBatchBindingByUnit(plan);
  assert.equal(bindings.get("unit-e").cohort_index, 1);
  assert.equal(bindings.get("unit-e").cohort_position, 0);
}

function testSchedulerIsDeterministicAndHashSensitive() {
  const original = [
    unit("unit-a", 0, 50),
    unit("unit-b", 1, 47),
    unit("unit-c", 2, 47, " longer"),
    unit("unit-d", 3, 59),
  ];
  const shuffled = [original[3], original[1], original[0], original[2]];
  const first = buildQwenLiamBatchPlan(
    original,
    QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
  );
  const second = buildQwenLiamBatchPlan(
    shuffled,
    QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
  );
  assert.equal(first.batch_plan_sha256, second.batch_plan_sha256);
  assert.deepEqual(first.synthesis_order_unit_ids, [
    "unit-b",
    "unit-c",
    "unit-a",
    "unit-d",
  ]);

  const changed = structuredClone(original);
  changed[0].spoken_text = `${changed[0].spoken_text} Changed.`;
  changed[0].spoken_text_sha256 = sha256(changed[0].spoken_text);
  changed[0].word_count += 1;
  assert.notEqual(
    buildQwenLiamBatchPlan(
      changed,
      QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
    ).batch_plan_sha256,
    first.batch_plan_sha256,
  );

  const tampered = structuredClone(first);
  tampered.cohorts[0].members.reverse();
  assert.equal(
    validateQwenLiamBatchPlan(
      tampered,
      original,
      QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
    ).status,
    "blocked",
  );
  assert.equal(
    validateQwenLiamBatchPlan(
      null,
      original,
      QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
    ).findings[0].code,
    "qwen_batch_plan_missing",
  );
  assert.equal(
    validateQwenLiamBatchPlan(
      first,
      [],
      QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
    ).findings[0].code,
    "qwen_batch_plan_inputs_invalid",
  );
}

function testLegacySerialAdapterAndNewBatchDefault() {
  const legacyIdentity = {
    episode: "ep_01",
    tts_provider: "qwen_local",
    tts_fallback_provider: null,
    narrator_voice_id: "am_liam",
    tts_native_speed: null,
    voice_provider_options: {
      primary: {
        provider: "qwen_local",
        voice_id: "am_liam",
      },
      fallback: null,
    },
  };
  assert.deepEqual(
    narrationTtsPolicyForIdentity(legacyIdentity).synthesis_contract,
    QWEN_LIAM_SERIAL_SYNTHESIS_CONTRACT,
  );
  const newOptions = defaultNarrationVoiceProviderOptions();
  assert.deepEqual(
    newOptions.synthesis_contract,
    QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
  );
  assert.deepEqual(
    narrationTtsPolicyForIdentity({
      ...legacyIdentity,
      voice_provider_options: newOptions,
    }).synthesis_contract,
    QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
  );
}

function testExactUnitRecoveryProvenance() {
  const units = [unit("unit-a", 0, 50)];
  const plan = buildQwenLiamBatchPlan(
    units,
    QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
  );
  const binding = qwenBatchBindingByUnit(plan).get("unit-a");
  const provenance = exactUnitRecoveryProvenanceForTests({
    unit: units[0],
    candidate: {
      unit_id: "unit-a",
      synthesis_identity_sha256: "origin-synthesis-sha",
      audio_sha256: null,
      runner_report_path: "/tmp/origin-run.json",
      runner_report_sha256: "origin-run-sha",
      qa: {
        status: "blocked",
        findings: [{
          severity: "blocker",
          code: "tts_batch_token_limit_reached",
        }],
      },
      disposition: {
        blocker_codes: ["tts_batch_token_limit_reached"],
      },
    },
    cohortBinding: binding,
    batchPlanSha256: plan.batch_plan_sha256,
  });
  assert.equal(
    provenance.recovery_mode,
    QWEN_LIAM_EXACT_UNIT_RECOVERY_MODE,
  );
  assert.equal(provenance.origin_cohort_sha256, binding.cohort_sha256);
  assert.deepEqual(
    provenance.trigger_codes,
    ["tts_batch_token_limit_reached"],
  );
  assert.match(provenance.trigger_evidence_sha256, /^[a-f0-9]{64}$/);
}

testLengthMatchedCohortsAndOriginalOrder();
testSchedulerIsDeterministicAndHashSensitive();
testLegacySerialAdapterAndNewBatchDefault();
testExactUnitRecoveryProvenance();
