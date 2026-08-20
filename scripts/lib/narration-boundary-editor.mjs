function integer(value, fallback = 0) {
  return Number.isInteger(Number(value)) ? Number(value) : fallback;
}

function millisecondsToSamples(value, sampleRate) {
  return Math.round((Number(value) / 1000) * sampleRate);
}

export function classifyNarrationBoundary(leftUnit = {}, rightUnit = null) {
  if (!rightUnit) return "episode_end";
  const explicit = String(
    leftUnit.boundary_after ?? rightUnit.boundary_before ?? "",
  ).trim().toLowerCase();
  if ([
    "continuation",
    "clause",
    "sentence",
    "emphasized_sentence",
    "paragraph",
    "reveal",
  ].includes(explicit)) return explicit;
  if (/reveal|dramatic/i.test(String(explicit))) return "reveal";
  if (/paragraph|segment/i.test(String(explicit))) return "paragraph";
  const text = String(leftUnit.spoken_text ?? leftUnit.tts_spoken_text ?? "").trim();
  if (/…$|\.\.\.$/.test(text)) return "reveal";
  if (/[!?]$/.test(text) || leftUnit.delivery_class === "climax") return "emphasized_sentence";
  if (/\.$/.test(text)) return "sentence";
  if (/[,;:]$/.test(text)) return "clause";
  return "continuation";
}

export function planAlignmentSafeUnitEdit({
  unitId,
  sampleCount,
  sampleRate,
  alignment = null,
  contract,
} = {}) {
  const sourceSamples = integer(sampleCount);
  const rate = integer(sampleRate, 24000);
  const policy = contract?.edge_editing ?? {};
  const headSafety = millisecondsToSamples(policy.preserve_before_first_aligned_word_ms ?? 80, rate);
  const tailSafety = millisecondsToSamples(policy.preserve_after_last_aligned_word_ms ?? 140, rate);
  const alignmentUsable = alignment?.status === "passed"
    && Number.isInteger(alignment.first_speech_sample)
    && Number.isInteger(alignment.last_speech_sample_exclusive)
    && alignment.first_speech_sample >= 0
    && alignment.last_speech_sample_exclusive > alignment.first_speech_sample
    && alignment.last_speech_sample_exclusive <= sourceSamples;
  if (!alignmentUsable) {
    return {
      status: "passed",
      unit_id: unitId,
      mode: "preserve_entire_unit_without_alignment",
      source_sample_count: sourceSamples,
      trim_start_sample: 0,
      trim_end_sample: sourceSamples,
      retained_sample_count: sourceSamples,
      fade_in_samples: 0,
      fade_out_samples: 0,
      alignment_used: false,
      warnings: [{
        code: "narration_alignment_missing_edges_preserved",
        severity: "warning",
      }],
      blockers: [],
    };
  }
  const trimStart = Math.max(0, alignment.first_speech_sample - headSafety);
  const trimEnd = Math.min(sourceSamples, alignment.last_speech_sample_exclusive + tailSafety);
  const blockers = [];
  if (trimStart > alignment.first_speech_sample) {
    blockers.push({ code: "narration_trim_crosses_first_aligned_word" });
  }
  if (trimEnd < alignment.last_speech_sample_exclusive) {
    blockers.push({ code: "narration_trim_crosses_last_aligned_word" });
  }
  return {
    status: blockers.length ? "blocked" : "passed",
    unit_id: unitId,
    mode: "alignment_safe_trim",
    source_sample_count: sourceSamples,
    trim_start_sample: trimStart,
    trim_end_sample: trimEnd,
    retained_sample_count: Math.max(0, trimEnd - trimStart),
    retained_head_safety_sample_count: alignment.first_speech_sample - trimStart,
    retained_tail_safety_sample_count: trimEnd - alignment.last_speech_sample_exclusive,
    fade_in_samples: 0,
    fade_out_samples: 0,
    alignment_used: true,
    warnings: [],
    blockers,
  };
}

export function planNarrationBoundary({
  leftUnit,
  rightUnit,
  leftPrepared,
  rightPrepared,
  contract,
} = {}) {
  const boundaryClass = classifyNarrationBoundary(leftUnit, rightUnit);
  const policy = contract?.boundary_classes?.[boundaryClass];
  if (!policy) {
    return {
      status: "blocked",
      boundary_class: boundaryClass,
      blockers: [{ code: "narration_boundary_class_policy_missing" }],
      warnings: [],
    };
  }
  const sampleRate = contract?.edge_editing?.sample_rate_hz ?? 24000;
  const targetSamples = millisecondsToSamples(policy.target_ms, sampleRate);
  const retainedNaturalSamples = integer(leftPrepared?.retained_trailing_silence_sample_count)
    + integer(rightPrepared?.retained_leading_silence_sample_count);
  const insertedSamples = Math.max(0, targetSamples - retainedNaturalSamples);
  const effectiveSamples = retainedNaturalSamples + insertedSamples;
  const warnings = [];
  if (effectiveSamples > millisecondsToSamples(policy.maximum_ms, sampleRate)) {
    warnings.push({
      code: "narration_boundary_natural_pause_above_class_maximum",
      severity: "warning",
      effective_pause_ms: Math.round((effectiveSamples / sampleRate) * 1000),
      maximum_ms: policy.maximum_ms,
      disposition: "preserved_to_avoid_unaligned_speech_cut",
    });
  }
  return {
    status: "passed",
    boundary_class: boundaryClass,
    target_pause_ms: policy.target_ms,
    target_pause_sample_count: targetSamples,
    retained_natural_silence_sample_count: retainedNaturalSamples,
    inserted_silence_sample_count: insertedSamples,
    effective_pause_sample_count: effectiveSamples,
    effective_pause_ms: Math.round((effectiveSamples / sampleRate) * 1000),
    blockers: [],
    warnings,
  };
}

function preparedSampleCount(row) {
  const candidates = [
    row?.sample_count,
    row?.prepared_sample_count,
    row?.prepared_qa?.metrics?.sample_count,
  ];
  for (const value of candidates) {
    const count = Number(value);
    if (Number.isInteger(count) && count > 0) return count;
  }
  return null;
}

export function validateNarrationStitchAccounting({
  preparedInputs = [],
  boundaries = [],
  finalSampleCount = null,
  sampleRate = 24000,
} = {}) {
  const blockers = [];
  const warnings = [];
  const expectedBoundaryCount = Math.max(0, preparedInputs.length - 1);
  if (boundaries.length !== expectedBoundaryCount) {
    blockers.push({
      code: "narration_stitch_boundary_count_mismatch",
      expected: expectedBoundaryCount,
      actual: boundaries.length,
    });
  }

  let expectedSampleCount = 0;
  for (const [index, prepared] of preparedInputs.entries()) {
    const count = preparedSampleCount(prepared);
    if (count == null) {
      blockers.push({
        code: "narration_stitch_prepared_sample_count_missing",
        unit_id: prepared?.unit_id ?? null,
      });
    } else {
      expectedSampleCount += count;
    }
    if (index >= preparedInputs.length - 1) continue;
    const boundary = boundaries[index];
    const next = preparedInputs[index + 1];
    if (!boundary
      || String(boundary.after_unit_id) !== String(prepared?.unit_id)
      || String(boundary.before_unit_id) !== String(next?.unit_id)) {
      blockers.push({
        code: "narration_stitch_boundary_order_mismatch",
        boundary_index: index,
        expected_after_unit_id: prepared?.unit_id ?? null,
        expected_before_unit_id: next?.unit_id ?? null,
        actual_after_unit_id: boundary?.after_unit_id ?? null,
        actual_before_unit_id: boundary?.before_unit_id ?? null,
      });
      continue;
    }
    const inserted = Number(boundary.gap_sample_count ?? 0);
    const declaredInserted = Number(boundary.inserted_silence_sample_count);
    if (!Number.isInteger(inserted) || inserted < 0) {
      blockers.push({
        code: "narration_stitch_gap_sample_count_invalid",
        boundary_id: boundary.boundary_id ?? null,
        actual: boundary.gap_sample_count ?? null,
      });
      continue;
    }
    if (declaredInserted !== inserted) {
      blockers.push({
        code: "narration_stitch_inserted_sample_count_mismatch",
        boundary_id: boundary.boundary_id ?? null,
        expected: inserted,
        actual: Number.isFinite(declaredInserted) ? declaredInserted : null,
      });
    }
    const retained = Number(boundary.retained_natural_silence_sample_count);
    const effective = Number(boundary.effective_pause_sample_count);
    if (!Number.isInteger(retained) || retained < 0
      || !Number.isInteger(effective) || effective !== retained + inserted) {
      blockers.push({
        code: "narration_stitch_effective_pause_accounting_mismatch",
        boundary_id: boundary.boundary_id ?? null,
        retained_natural_sample_count: Number.isFinite(retained) ? retained : null,
        inserted_sample_count: inserted,
        declared_effective_sample_count: Number.isFinite(effective) ? effective : null,
      });
    }
    if (!boundary.boundary_class) {
      blockers.push({
        code: "narration_stitch_semantic_boundary_class_missing",
        boundary_id: boundary.boundary_id ?? null,
      });
    }
    expectedSampleCount += inserted;
  }

  const actualSampleCount = Number(finalSampleCount);
  if (!Number.isInteger(actualSampleCount) || actualSampleCount <= 0) {
    blockers.push({
      code: "narration_stitch_final_sample_count_missing",
      actual: finalSampleCount ?? null,
    });
  } else if (actualSampleCount !== expectedSampleCount) {
    blockers.push({
      code: "narration_stitch_total_sample_count_mismatch",
      expected_sample_count: expectedSampleCount,
      actual_sample_count: actualSampleCount,
    });
  }

  return {
    schema: "goldflow_narration_stitch_sample_accounting_v2",
    status: blockers.length ? "blocked" : warnings.length ? "passed_with_warnings" : "passed",
    sample_rate_hz: Number(sampleRate),
    prepared_unit_count: preparedInputs.length,
    boundary_count: boundaries.length,
    expected_sample_count: expectedSampleCount,
    actual_sample_count: Number.isInteger(actualSampleCount) ? actualSampleCount : null,
    exact_sample_accounting: blockers.every(
      (finding) => finding.code !== "narration_stitch_total_sample_count_mismatch"
        && finding.code !== "narration_stitch_final_sample_count_missing",
    ) && Number.isInteger(actualSampleCount) && actualSampleCount === expectedSampleCount,
    blockers,
    warnings,
  };
}
