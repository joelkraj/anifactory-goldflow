import { createHash } from "node:crypto";

export const QWEN_LIAM_SERIAL_SYNTHESIS_CONTRACT = Object.freeze({
  schema: "goldflow_qwen_liam_synthesis_contract_v1",
  contract_id: "qwen_liam_serial_unit_v1",
  mode: "serial_unit_v1",
  api: "Model.generate",
  scheduler_version: "source_order_serial_v1",
  resident_model_count: 1,
  model_concurrency: 1,
  nominal_batch_size: 1,
  final_partial_cohort_allowed: false,
  continuous_batching: false,
  token_limit_acceptance_allowed: false,
  objective_recovery_mode: "serial_unit_v1",
});

export const QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT = Object.freeze({
  schema: "goldflow_qwen_liam_synthesis_contract_v1",
  contract_id: "qwen_liam_fixed_batch4_length_matched_v1",
  mode: "fixed_batch4_length_matched_v1",
  api: "Model.batch_generate",
  scheduler_version: "stable_length_word_byte_source_id_v1",
  resident_model_count: 1,
  model_concurrency: 1,
  nominal_batch_size: 4,
  final_partial_cohort_allowed: true,
  continuous_batching: false,
  token_limit_acceptance_allowed: false,
  objective_recovery_mode: "serial_exact_unit_recovery_v1",
});

export const QWEN_LIAM_EXACT_UNIT_RECOVERY_MODE =
  "serial_exact_unit_recovery_v1";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (
          left < right ? -1 : left > right ? 1 : 0
        ))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function canonicalQwenBatchSha256(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function spokenText(unit = {}) {
  return String(
    unit.spoken_text
      ?? unit.tts_spoken_text
      ?? unit.qwen_spoken_text
      ?? "",
  );
}

function spokenWordCount(unit = {}) {
  const recorded = Number(unit.word_count);
  if (Number.isInteger(recorded) && recorded >= 0) return recorded;
  return spokenText(unit).trim().split(/\s+/u).filter(Boolean).length;
}

function sourceOrder(unit = {}, fallback) {
  const recorded = Number(unit.order_index);
  return Number.isInteger(recorded) && recorded >= 0 ? recorded : fallback;
}

function normalizedUnit(unit, fallbackIndex) {
  const text = spokenText(unit);
  const unitId = String(unit.unit_id ?? "").trim();
  if (!unitId) throw new Error(`Qwen batch scheduler unit ${fallbackIndex} lacks unit_id.`);
  if (!text.trim()) throw new Error(`Qwen batch scheduler unit ${unitId} has empty spoken text.`);
  const computedTextHash = createHash("sha256").update(text).digest("hex");
  const declaredTextHash = String(unit.spoken_text_sha256 ?? computedTextHash);
  if (declaredTextHash !== computedTextHash) {
    throw new Error(`Qwen batch scheduler spoken-text hash is stale for ${unitId}.`);
  }
  return {
    unit_id: unitId,
    original_order_index: sourceOrder(unit, fallbackIndex),
    spoken_text_sha256: computedTextHash,
    spoken_word_count: spokenWordCount(unit),
    spoken_text_utf8_bytes: Buffer.byteLength(text, "utf8"),
  };
}

function compareLengthMatched(left, right) {
  return left.spoken_word_count - right.spoken_word_count
    || left.spoken_text_utf8_bytes - right.spoken_text_utf8_bytes
    || left.original_order_index - right.original_order_index
    || (left.unit_id < right.unit_id ? -1 : left.unit_id > right.unit_id ? 1 : 0);
}

function seedFromHash(hash) {
  return Number.parseInt(String(hash).slice(0, 8), 16);
}

export function buildQwenLiamBatchPlan(
  units,
  synthesisContract = QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
) {
  if (!Array.isArray(units) || !units.length) {
    throw new Error("Qwen batch scheduling requires at least one narration unit.");
  }
  const normalized = units.map(normalizedUnit);
  const unitIds = normalized.map((unit) => unit.unit_id);
  if (new Set(unitIds).size !== unitIds.length) {
    throw new Error("Qwen batch scheduling requires unique narration unit IDs.");
  }
  const orderIndexes = normalized.map((unit) => unit.original_order_index);
  if (new Set(orderIndexes).size !== orderIndexes.length) {
    throw new Error("Qwen batch scheduling requires unique original order indexes.");
  }
  const originalOrder = [...normalized]
    .sort((left, right) => left.original_order_index - right.original_order_index);
  const originalOrderBinding = originalOrder.map((unit) => ({
    unit_id: unit.unit_id,
    original_order_index: unit.original_order_index,
    spoken_text_sha256: unit.spoken_text_sha256,
  }));
  const originalOrderSha256 = canonicalQwenBatchSha256(originalOrderBinding);

  const serial = synthesisContract.mode === QWEN_LIAM_SERIAL_SYNTHESIS_CONTRACT.mode;
  const ordered = serial
    ? originalOrder
    : [...normalized].sort(compareLengthMatched);
  const nominalBatchSize = Number(synthesisContract.nominal_batch_size);
  if (!Number.isInteger(nominalBatchSize) || nominalBatchSize < 1) {
    throw new Error("Qwen synthesis contract has an invalid nominal batch size.");
  }
  const cohorts = [];
  for (let offset = 0; offset < ordered.length; offset += nominalBatchSize) {
    const members = ordered.slice(offset, offset + nominalBatchSize);
    const cohortIndex = cohorts.length;
    const memberRows = members.map((member, cohortPosition) => ({
      ...member,
      cohort_position: cohortPosition,
    }));
    const cohortIdentity = {
      schema: "goldflow_qwen_liam_synthesis_cohort_v1",
      synthesis_contract_id: synthesisContract.contract_id,
      synthesis_mode: synthesisContract.mode,
      scheduler_version: synthesisContract.scheduler_version,
      nominal_batch_size: nominalBatchSize,
      effective_batch_size: memberRows.length,
      cohort_index: cohortIndex,
      members: memberRows,
    };
    const cohortSha256 = canonicalQwenBatchSha256(cohortIdentity);
    cohorts.push({
      ...cohortIdentity,
      cohort_id: `qwen-cohort-${String(cohortIndex + 1).padStart(4, "0")}-${cohortSha256.slice(0, 12)}`,
      cohort_sha256: cohortSha256,
      batch_seed: seedFromHash(cohortSha256),
    });
  }

  const planIdentity = {
    schema: "goldflow_qwen_liam_batch_plan_v1",
    synthesis_contract: synthesisContract,
    original_order_sha256: originalOrderSha256,
    original_order_unit_ids: originalOrder.map((unit) => unit.unit_id),
    synthesis_order_unit_ids: cohorts.flatMap(
      (cohort) => cohort.members.map((member) => member.unit_id),
    ),
    unit_count: normalized.length,
    cohort_count: cohorts.length,
    cohorts,
  };
  return {
    ...planIdentity,
    batch_plan_sha256: canonicalQwenBatchSha256(planIdentity),
  };
}

export function qwenBatchBindingByUnit(batchPlan = {}) {
  return new Map((batchPlan.cohorts ?? []).flatMap((cohort) => (
    (cohort.members ?? []).map((member) => [
      String(member.unit_id),
      {
        synthesis_contract_id: batchPlan.synthesis_contract?.contract_id ?? null,
        synthesis_mode: batchPlan.synthesis_contract?.mode ?? null,
        batch_plan_sha256: batchPlan.batch_plan_sha256 ?? null,
        cohort_id: cohort.cohort_id,
        cohort_index: cohort.cohort_index,
        cohort_sha256: cohort.cohort_sha256,
        cohort_position: member.cohort_position,
        nominal_batch_size: cohort.nominal_batch_size,
        effective_batch_size: cohort.effective_batch_size,
        batch_seed: cohort.batch_seed,
      },
    ])
  )));
}

export function validateQwenLiamBatchPlan(
  batchPlan,
  units,
  synthesisContract,
) {
  const findings = [];
  let expected = null;
  try {
    expected = buildQwenLiamBatchPlan(units, synthesisContract);
  } catch (error) {
    return {
      status: "blocked",
      findings: [{
        code: "qwen_batch_plan_inputs_invalid",
        error: error instanceof Error ? error.message : String(error),
      }],
      expected: null,
    };
  }
  if (!batchPlan || typeof batchPlan !== "object" || Array.isArray(batchPlan)) {
    return {
      status: "blocked",
      findings: [{
        code: "qwen_batch_plan_missing",
        expected: expected.batch_plan_sha256,
        actual: null,
      }],
      expected,
    };
  }
  if (batchPlan?.batch_plan_sha256 !== expected.batch_plan_sha256) {
    findings.push({
      code: "qwen_batch_plan_hash_mismatch",
      expected: expected.batch_plan_sha256,
      actual: batchPlan?.batch_plan_sha256 ?? null,
    });
  }
  if (canonicalQwenBatchSha256(batchPlan) !== canonicalQwenBatchSha256(expected)) {
    findings.push({
      code: "qwen_batch_plan_content_mismatch",
      expected_contract_id: synthesisContract?.contract_id ?? null,
    });
  }
  return { status: findings.length ? "blocked" : "passed", findings, expected };
}
