import { createHash } from "node:crypto";

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function nonnegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function unitForTokenIndex(ranges, tokenIndex) {
  return ranges.find((range) => (
    tokenIndex >= range.token_start && tokenIndex < range.token_end_exclusive
  )) ?? null;
}

function addUnitAndEdgeNeighbors(indexes, unitIndex, tokenIndex, range, unitCount) {
  indexes.add(unitIndex);
  if (tokenIndex === range.token_start && unitIndex > 0) indexes.add(unitIndex - 1);
  if (tokenIndex === range.token_end_exclusive - 1 && unitIndex + 1 < unitCount) {
    indexes.add(unitIndex + 1);
  }
}

function contiguousGroups(indexes) {
  const ordered = [...indexes].sort((left, right) => left - right);
  const groups = [];
  for (const index of ordered) {
    const previous = groups.at(-1);
    if (previous && index === previous.end_index + 1) {
      previous.end_index = index;
    } else {
      groups.push({ start_index: index, end_index: index });
    }
  }
  return groups;
}

/**
 * Map every non-match in a full-stream ASR alignment to exact stitched units.
 *
 * The planner deliberately fails closed. It never falls back to a whole-file
 * confirmation when token coverage, unit order, or sample accounting cannot be
 * proven. Boundary-adjacent edits include both sides of the join, while edits
 * internal to a unit include only that unit.
 */
export function planNarrationConfirmationWindows({
  units = [],
  timeline = [],
  operations = [],
  audioSampleCount = null,
} = {}) {
  const blockers = [];
  const normalizedUnits = units.map((unit, index) => ({
    unit_id: String(unit?.unit_id ?? ""),
    order_index: index,
    spoken_text: String(unit?.spoken_text ?? unit?.tts_spoken_text ?? "").trim(),
    canonical_token_count: positiveInteger(unit?.canonical_token_count),
  }));
  const timelineRows = timeline.map((row) => ({
    unit_id: String(row?.unit_id ?? ""),
    start_sample: nonnegativeInteger(row?.start_sample),
    end_sample_exclusive: positiveInteger(row?.end_sample_exclusive),
  }));
  if (!normalizedUnits.length || normalizedUnits.length !== timelineRows.length) {
    blockers.push({ code: "narration_confirmation_unit_timeline_count_mismatch" });
  }
  for (const [index, unit] of normalizedUnits.entries()) {
    const timing = timelineRows[index];
    if (!unit.unit_id || !unit.spoken_text || unit.canonical_token_count == null) {
      blockers.push({
        code: "narration_confirmation_unit_token_identity_invalid",
        unit_id: unit.unit_id || null,
      });
    }
    if (!timing
      || timing.unit_id !== unit.unit_id
      || timing.start_sample == null
      || timing.end_sample_exclusive == null
      || timing.end_sample_exclusive <= timing.start_sample) {
      blockers.push({
        code: "narration_confirmation_unit_timeline_mapping_invalid",
        unit_id: unit.unit_id || null,
      });
    }
  }
  const expectedAudioSamples = nonnegativeInteger(audioSampleCount);
  const timelineAudioSamples = timelineRows.at(-1)?.end_sample_exclusive ?? null;
  if (expectedAudioSamples == null || timelineAudioSamples !== expectedAudioSamples) {
    blockers.push({
      code: "narration_confirmation_audio_sample_accounting_mismatch",
      expected_audio_sample_count: timelineAudioSamples,
      actual_audio_sample_count: expectedAudioSamples,
    });
  }
  if (blockers.length) {
    return {
      status: "blocked",
      blockers,
      windows: [],
      suspect_count: 0,
    };
  }

  let tokenCursor = 0;
  const ranges = normalizedUnits.map((unit) => {
    const tokenStart = tokenCursor;
    tokenCursor += unit.canonical_token_count;
    return {
      ...unit,
      token_start: tokenStart,
      token_end_exclusive: tokenCursor,
    };
  });
  const affectedIndexes = new Set();
  const suspects = [];
  let intendedCursor = 0;
  let recognizedCursor = 0;
  for (const [operationIndex, operation] of operations.entries()) {
    const type = String(operation?.type ?? "");
    const consumesIntended = operation?.intended != null;
    const consumesRecognized = operation?.recognized != null;
    if (!new Set(["match", "substitution", "deletion", "insertion"]).has(type)
      || (type === "match" && (!consumesIntended || !consumesRecognized))
      || (type === "substitution" && (!consumesIntended || !consumesRecognized))
      || (type === "deletion" && (!consumesIntended || consumesRecognized))
      || (type === "insertion" && (consumesIntended || !consumesRecognized))) {
      blockers.push({
        code: "narration_confirmation_alignment_operation_invalid",
        operation_index: operationIndex,
      });
      continue;
    }
    const intendedIndex = consumesIntended ? intendedCursor : null;
    const recognizedIndex = consumesRecognized ? recognizedCursor : null;
    if (consumesIntended) intendedCursor += 1;
    if (consumesRecognized) recognizedCursor += 1;
    if (type === "match") continue;

    const mappedUnitIndexes = new Set();
    let boundaryId = null;
    if (intendedIndex != null) {
      const range = unitForTokenIndex(ranges, intendedIndex);
      if (!range) {
        blockers.push({
          code: "narration_confirmation_intended_token_unmapped",
          operation_index: operationIndex,
          intended_token_index: intendedIndex,
        });
        continue;
      }
      addUnitAndEdgeNeighbors(
        mappedUnitIndexes,
        range.order_index,
        intendedIndex,
        range,
        ranges.length,
      );
      if (intendedIndex === range.token_start && range.order_index > 0) {
        boundaryId = `${ranges[range.order_index - 1].unit_id}__${range.unit_id}`;
      } else if (intendedIndex === range.token_end_exclusive - 1
        && range.order_index + 1 < ranges.length) {
        boundaryId = `${range.unit_id}__${ranges[range.order_index + 1].unit_id}`;
      }
    } else {
      // An insertion lives between intended tokens. At an exact unit edge both
      // sides are required; inside a unit only that unit is required.
      const right = unitForTokenIndex(ranges, Math.min(intendedCursor, tokenCursor - 1));
      const left = unitForTokenIndex(ranges, Math.max(0, intendedCursor - 1));
      if (!right && !left) {
        blockers.push({
          code: "narration_confirmation_insertion_unmapped",
          operation_index: operationIndex,
          intended_cursor: intendedCursor,
        });
        continue;
      }
      if (left) mappedUnitIndexes.add(left.order_index);
      if (right) mappedUnitIndexes.add(right.order_index);
      if (left && right && left.order_index !== right.order_index) {
        boundaryId = `${left.unit_id}__${right.unit_id}`;
      }
    }
    for (const index of mappedUnitIndexes) affectedIndexes.add(index);
    suspects.push({
      operation_index: operationIndex,
      type,
      intended: operation?.intended ?? null,
      recognized: operation?.recognized ?? null,
      intended_token_index: intendedIndex,
      recognized_token_index: recognizedIndex,
      unit_ids: [...mappedUnitIndexes]
        .sort((left, right) => left - right)
        .map((index) => ranges[index].unit_id),
      boundary_id: boundaryId,
    });
  }
  if (intendedCursor !== tokenCursor) {
    blockers.push({
      code: "narration_confirmation_alignment_intended_coverage_mismatch",
      expected_token_count: tokenCursor,
      actual_token_count: intendedCursor,
    });
  }
  if (suspects.some((row) => row.unit_ids.length === 0)) {
    blockers.push({ code: "narration_confirmation_suspect_scope_empty" });
  }
  if (blockers.length) {
    return {
      status: "blocked",
      blockers,
      windows: [],
      suspect_count: suspects.length,
      suspects,
    };
  }

  const windows = contiguousGroups(affectedIndexes).map((group, index) => {
    const scopedUnits = normalizedUnits.slice(group.start_index, group.end_index + 1);
    const scopedTimeline = timelineRows.slice(group.start_index, group.end_index + 1);
    const unitIds = scopedUnits.map((unit) => unit.unit_id);
    const boundaryIds = suspects
      .filter((suspect) => suspect.unit_ids.some((unitId) => unitIds.includes(unitId)))
      .map((suspect) => suspect.boundary_id)
      .filter(Boolean);
    const intendedText = scopedUnits.map((unit) => unit.spoken_text).join(" ");
    const descriptor = {
      unit_ids: unitIds,
      boundary_ids: [...new Set(boundaryIds)],
      start_sample: scopedTimeline[0].start_sample,
      end_sample_exclusive: scopedTimeline.at(-1).end_sample_exclusive,
      intended_text_sha256: sha256(intendedText),
    };
    return {
      window_id: `confirmation_window_${String(index + 1).padStart(3, "0")}_${sha256(JSON.stringify(descriptor)).slice(0, 12)}`,
      ...descriptor,
      intended_text: intendedText,
      suspect_operation_indexes: suspects
        .filter((suspect) => suspect.unit_ids.some((unitId) => unitIds.includes(unitId)))
        .map((suspect) => suspect.operation_index),
    };
  });
  const firstUnitId = normalizedUnits[0].unit_id;
  const finalUnitId = normalizedUnits.at(-1).unit_id;
  const openingNeedsConfirmation = suspects.some((row) => row.unit_ids.includes(firstUnitId));
  const finalNeedsConfirmation = suspects.some((row) => row.unit_ids.includes(finalUnitId));
  return {
    schema: "goldflow_narration_confirmation_window_plan_v1",
    status: "passed",
    blockers: [],
    intended_token_count: tokenCursor,
    recognized_token_count: recognizedCursor,
    suspect_count: suspects.length,
    suspects,
    window_count: windows.length,
    windows,
    coverage: {
      opening_unit_id: firstUnitId,
      final_unit_id: finalUnitId,
      opening_primary_coverage_required: true,
      final_primary_coverage_required: true,
      opening_confirmation_required: openingNeedsConfirmation,
      final_confirmation_required: finalNeedsConfirmation,
      opening_confirmation_window_ids: windows
        .filter((window) => window.unit_ids.includes(firstUnitId))
        .map((window) => window.window_id),
      final_confirmation_window_ids: windows
        .filter((window) => window.unit_ids.includes(finalUnitId))
        .map((window) => window.window_id),
    },
  };
}

