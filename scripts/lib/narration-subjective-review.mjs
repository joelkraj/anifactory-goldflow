import { createHash } from "node:crypto";
import { assertNarrationSourceStructure, narrationSourceChapterStarts, narrationSourceStructureSha256 } from "./narration-source-structure.mjs";

export const NARRATION_SUBJECTIVE_REVIEW_MANIFEST_SCHEMA =
  "goldflow_narration_subjective_review_manifest_v1";
export const NARRATION_SUBJECTIVE_REVIEW_DECISION_SCHEMA =
  "goldflow_narration_subjective_review_decision_v1";
export const NARRATION_SUBJECTIVE_REVIEW_ATTESTATION =
  "all_hash_bound_narration_samples_listened_end_to_end";
export const NARRATION_SUBJECTIVE_REVIEW_COVERAGE = Object.freeze([
  "complete_opening",
  "every_chapter_boundary",
  "system_or_pronunciation_risk",
  "middle_fatigue",
  "climax",
  "final_minute",
]);

const ACCEPT_CONFIRMATIONS = Object.freeze([
  "delivery_natural",
  "voice_identity_consistent",
  "pronunciation_acceptable",
  "joins_acceptable",
  "pacing_and_emphasis_acceptable",
  "no_listener_fatigue_defect",
]);

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

function canonicalSha256(value, omitted = []) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value, new Set(omitted))))
    .digest("hex");
}

export function narrationSubjectiveReviewManifestSha256(value) {
  return canonicalSha256(value, ["manifest_sha256"]);
}

export function narrationSubjectiveReviewDecisionSha256(value) {
  return canonicalSha256(value, ["decision_sha256", "validation"]);
}

function unitsFromPlan(plan = {}) {
  if (Array.isArray(plan.units)) return plan.units;
  return (plan.segments ?? []).flatMap((segment) => (
    segment.generation_units
      ?? segment.narration_generation_units
      ?? segment.qwen_generation_units
      ?? []
  ));
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

export function narrationUnitTimeline({ plan, stitch, sampleRateHz = 24000 } = {}) {
  const units = unitsFromPlan(plan);
  const preparedById = new Map(
    (stitch?.prepared_inputs ?? []).map((row) => [String(row.unit_id), row]),
  );
  const boundaryByAfterId = new Map(
    (stitch?.boundaries ?? []).map((row) => [String(row.after_unit_id), row]),
  );
  let cursor = 0;
  const rows = [];
  for (const [index, unit] of units.entries()) {
    const unitId = String(unit.unit_id ?? "");
    const prepared = preparedById.get(unitId);
    const sampleCount = positiveInteger(
      prepared?.sample_count
        ?? prepared?.prepared_sample_count
        ?? prepared?.prepared_qa?.metrics?.sample_count,
    );
    if (!unitId || sampleCount == null || sampleCount <= 0) continue;
    const startSample = cursor;
    const endSample = startSample + sampleCount;
    const boundary = boundaryByAfterId.get(unitId) ?? null;
    const gapSampleCount = index < units.length - 1
      ? positiveInteger(
          boundary?.gap_sample_count
            ?? boundary?.inserted_silence_sample_count
            ?? 0,
        ) ?? 0
      : 0;
    rows.push({
      unit_id: unitId,
      order_index: index,
      segment_id: String(
        unit.segment_id
          ?? unit.source_segment_ids?.[0]
          ?? unit.source_unit_refs?.[0]?.segment_id
          ?? "",
      ) || null,
      start_sample: startSample,
      end_sample_exclusive: endSample,
      start_sec: Number((startSample / sampleRateHz).toFixed(6)),
      end_sec: Number((endSample / sampleRateHz).toFixed(6)),
      prepared_sample_count: sampleCount,
      boundary_after_sample_count: gapSampleCount,
      boundary_after_id: boundary?.boundary_id ?? null,
      risk_flags: [...new Set((unit.risk_flags ?? []).map(String))],
      performance_intent: unit.performance_intent ?? null,
      spoken_text_sha256: unit.spoken_text_sha256 ?? null,
    });
    cursor = endSample + gapSampleCount;
  }
  return {
    rows,
    total_sample_count: cursor,
    duration_sec: Number((cursor / sampleRateHz).toFixed(6)),
  };
}

function overlappingUnits(timeline, startSample, endSample) {
  return timeline.filter((row) => (
    row.end_sample_exclusive > startSample && row.start_sample < endSample
  ));
}

function boundedRange(startSample, endSample, totalSamples) {
  const start = Math.max(0, Math.min(totalSamples, Math.floor(startSample)));
  const end = Math.max(start + 1, Math.min(totalSamples, Math.ceil(endSample)));
  return { start, end };
}

function sampleRow({
  id,
  coverageClass,
  description,
  startSample,
  endSample,
  totalSamples,
  sampleRateHz,
  timeline,
  boundaryIds = [],
  evidence = null,
}) {
  const range = boundedRange(startSample, endSample, totalSamples);
  const units = overlappingUnits(timeline, range.start, range.end);
  return {
    sample_id: id,
    coverage_class: coverageClass,
    description,
    start_sample: range.start,
    end_sample_exclusive: range.end,
    start_sec: Number((range.start / sampleRateHz).toFixed(3)),
    end_sec: Number((range.end / sampleRateHz).toFixed(3)),
    duration_sec: Number(((range.end - range.start) / sampleRateHz).toFixed(3)),
    unit_ids: units.map((row) => row.unit_id),
    boundary_ids: [...new Set(boundaryIds.filter(Boolean).map(String))],
    evidence,
    requested_action:
      "Listen to this exact range in the hash-bound canonical narration. Confirm delivery, voice identity, pronunciation, joins, pacing, emphasis, and fatigue. Name only exact affected unit IDs if repair is required.",
  };
}

function riskUnit(unit) {
  const flags = (unit.risk_flags ?? []).map(String);
  const joined = flags.join(" ").toLowerCase();
  return /system|ui|pronun|homograph|initialism|currency|number|proper.name|protected.term|tts.override/u.test(joined);
}

function climaxTimelineRow(plan, timeline) {
  const spine = plan?.chapter_prosody_spine
    ?? plan?.direction_metadata?.chapter_prosody_spine
    ?? null;
  const chapters = Array.isArray(spine?.chapters) ? spine.chapters : [];
  const candidates = chapters
    .map((chapter, index) => ({
      chapter,
      index,
      score:
        (/climax|final confrontation|decisive|payoff/u.test(String(chapter.dramatic_function ?? "").toLowerCase()) ? 20 : 0)
        + Number(chapter.tension_peak ?? 0) * 2
        + Number(chapter.reveal_weight ?? 0)
        + index / Math.max(1, chapters.length),
    }))
    .sort((left, right) => right.score - left.score);
  for (const candidate of candidates) {
    const segmentId = String(candidate.chapter?.segment_id ?? "");
    const rows = timeline.filter((row) => row.segment_id === segmentId);
    if (rows.length) return rows[Math.floor(rows.length / 2)];
  }
  const highTension = timeline
    .filter((row) => row.order_index >= Math.floor(timeline.length * 0.55))
    .map((row) => ({
      row,
      score:
        (row.performance_intent?.tension === "high" ? 10 : 0)
        + (row.performance_intent?.energy === "urgent" ? 5 : 0)
        + (row.performance_intent?.energy === "high" ? 3 : 0)
        + row.order_index / Math.max(1, timeline.length),
    }))
    .sort((left, right) => right.score - left.score);
  return highTension[0]?.row ?? timeline[Math.floor(timeline.length * 0.82)] ?? null;
}

export function buildNarrationSubjectiveReviewManifest({
  plan,
  stitch,
  audioPath,
  audioSha256,
  generationPlanSha256,
  generationPlanFileSha256,
  qualityContractSha256,
  sampleRateHz = 24000,
  sourceStructure = null,
} = {}) {
  const { rows: timeline, total_sample_count: totalSamples, duration_sec: durationSec } =
    narrationUnitTimeline({ plan, stitch, sampleRateHz });
  const samples = [];
  const add = (row) => samples.push(row);
  const seconds = (value) => Math.round(Number(value) * sampleRateHz);

  add(sampleRow({
    id: "subjective_opening_complete",
    coverageClass: "complete_opening",
    description: "Complete opening audition from the first sample through 90 seconds or the episode end.",
    startSample: 0,
    endSample: Math.min(totalSamples, seconds(90)),
    totalSamples,
    sampleRateHz,
    timeline,
  }));

  let explicitChapterStarts = null;
  if (sourceStructure) {
    if (!sourceStructure.path || !/^[a-f0-9]{64}$/.test(String(sourceStructure.file_sha256 ?? ""))) {
      throw new Error("Narration source structure requires its sidecar path and file hash.");
    }
    assertNarrationSourceStructure(sourceStructure.map, {
      plan,
      sourceScriptSha256: plan.source_script_hash ?? plan.source_hashes?.script_clean_sha256,
      generationPlanSha256,
      generationPlanFileSha256,
    });
    explicitChapterStarts = new Map(narrationSourceChapterStarts(sourceStructure.map, plan)
      .slice(1).map((chapter) => [String(chapter.unit_id), chapter]));
  }
  let chapterIndex = 0;
  let observedVoiceTransitions = 0;
  for (let index = 1; index < timeline.length; index += 1) {
    const previous = timeline[index - 1];
    const current = timeline[index];
    const voiceTransition = Boolean(previous.segment_id && previous.segment_id !== current.segment_id);
    if (voiceTransition) observedVoiceTransitions += 1;
    const declaredChapter = explicitChapterStarts?.get(current.unit_id);
    if (explicitChapterStarts ? !declaredChapter : !voiceTransition) continue;
    chapterIndex += 1;
    const boundarySample = previous.end_sample_exclusive;
    add(sampleRow({
      id: `subjective_chapter_boundary_${String(chapterIndex).padStart(3, "0")}`,
      coverageClass: "every_chapter_boundary",
      description: declaredChapter
        ? `Declared narrative chapter ${declaredChapter.chapter_id} begins at ${declaredChapter.first_source_ref_key}.`
        : `Chapter transition ${previous.segment_id} to ${current.segment_id}.`,
      startSample: boundarySample - seconds(8),
      endSample: boundarySample + seconds(8),
      totalSamples,
      sampleRateHz,
      timeline,
      boundaryIds: [previous.boundary_after_id],
      evidence: { from_segment_id: previous.segment_id, to_segment_id: current.segment_id,
        ...(declaredChapter ? { chapter_id: declaredChapter.chapter_id, first_source_ref_key: declaredChapter.first_source_ref_key } : {}) },
    }));
  }
  if (explicitChapterStarts && chapterIndex !== explicitChapterStarts.size) {
    throw new Error("Declared narrative chapter starts are missing from the canonical narration timeline.");
  }

  let riskIndex = 0;
  for (const unit of timeline.filter(riskUnit)) {
    riskIndex += 1;
    add(sampleRow({
      id: `subjective_risk_passage_${String(riskIndex).padStart(3, "0")}`,
      coverageClass: "system_or_pronunciation_risk",
      description: `System, pronunciation, or protected-token risk in ${unit.unit_id}.`,
      startSample: unit.start_sample - seconds(2),
      endSample: unit.end_sample_exclusive + seconds(2),
      totalSamples,
      sampleRateHz,
      timeline,
      evidence: { unit_id: unit.unit_id, risk_flags: unit.risk_flags },
    }));
  }

  add(sampleRow({
    id: "subjective_middle_fatigue",
    coverageClass: "middle_fatigue",
    description: "Thirty-second midpoint fatigue and voice-consistency sample.",
    startSample: Math.floor(totalSamples / 2) - seconds(15),
    endSample: Math.floor(totalSamples / 2) + seconds(15),
    totalSamples,
    sampleRateHz,
    timeline,
  }));

  const climax = climaxTimelineRow(plan, timeline);
  const climaxCenter = climax
    ? Math.floor((climax.start_sample + climax.end_sample_exclusive) / 2)
    : Math.floor(totalSamples * 0.82);
  add(sampleRow({
    id: "subjective_climax",
    coverageClass: "climax",
    description: "Forty-five-second climax delivery, intensity, and intelligibility sample.",
    startSample: climaxCenter - seconds(22.5),
    endSample: climaxCenter + seconds(22.5),
    totalSamples,
    sampleRateHz,
    timeline,
    evidence: { selected_unit_id: climax?.unit_id ?? null, selection: climax ? "prosody_or_intent" : "duration_fallback" },
  }));

  add(sampleRow({
    id: "subjective_final_minute",
    coverageClass: "final_minute",
    description: "Complete final minute through the exact last sample.",
    startSample: Math.max(0, totalSamples - seconds(60)),
    endSample: totalSamples,
    totalSamples,
    sampleRateHz,
    timeline,
  }));

  const coverage = Object.fromEntries(NARRATION_SUBJECTIVE_REVIEW_COVERAGE.map(
    (coverageClass) => [coverageClass, samples.filter((row) => row.coverage_class === coverageClass).length],
  ));
  const artifact = {
    schema: NARRATION_SUBJECTIVE_REVIEW_MANIFEST_SCHEMA,
    status: "review_required",
    policy_version: "narration_subjective_sampling_v1",
    audio_path: audioPath,
    audio_sha256: audioSha256,
    sample_rate_hz: sampleRateHz,
    total_sample_count: totalSamples,
    duration_sec: durationSec,
    narration_generation_plan_sha256: generationPlanSha256,
    narration_generation_plan_file_sha256: generationPlanFileSha256,
    narration_quality_contract_sha256: qualityContractSha256,
    required_coverage: [...NARRATION_SUBJECTIVE_REVIEW_COVERAGE],
    coverage,
    expected_chapter_boundary_count: chapterIndex,
    ...(sourceStructure ? {
      chapter_boundary_policy: "explicit_source_structure_v1",
      source_structure: sourceStructure,
      observed_voice_segment_transition_count: observedVoiceTransitions,
    } : {}),
    expected_system_or_pronunciation_risk_count: riskIndex,
    sample_count: samples.length,
    samples,
    repair_policy: "A confirmed defect names only exact affected unit IDs. Every other selected unit and audio hash remains immutable.",
  };
  return { ...artifact, manifest_sha256: narrationSubjectiveReviewManifestSha256(artifact) };
}

export function validateNarrationSubjectiveReviewManifest(manifest, {
  requireCompleteCoverage = true,
} = {}) {
  const findings = [];
  if (manifest?.schema !== NARRATION_SUBJECTIVE_REVIEW_MANIFEST_SCHEMA) findings.push({ code: "narration_subjective_manifest_schema_invalid" });
  if (manifest?.manifest_sha256 !== narrationSubjectiveReviewManifestSha256(manifest)) findings.push({ code: "narration_subjective_manifest_hash_invalid" });
  if (!manifest?.audio_path || !/^[a-f0-9]{64}$/u.test(String(manifest?.audio_sha256 ?? ""))) findings.push({ code: "narration_subjective_audio_binding_invalid" });
  const samples = Array.isArray(manifest?.samples) ? manifest.samples : [];
  if (manifest?.source_structure || manifest?.chapter_boundary_policy === "explicit_source_structure_v1") {
    const binding = manifest.source_structure;
    const map = binding?.map;
    const expected = map?.structure_kind === "continuous_narrative" ? [] : (map?.chapters ?? []).slice(1);
    const actual = samples.filter((row) => row.coverage_class === "every_chapter_boundary");
    if (!binding?.path || !/^[a-f0-9]{64}$/.test(String(binding?.file_sha256 ?? ""))
      || map?.structure_sha256 !== narrationSourceStructureSha256(map)
      || map?.narration_generation_plan_sha256 !== manifest.narration_generation_plan_sha256
      || map?.narration_generation_plan_file_sha256 !== manifest.narration_generation_plan_file_sha256
      || manifest.chapter_boundary_policy !== "explicit_source_structure_v1"
      || Number(manifest.expected_chapter_boundary_count) !== expected.length
      || JSON.stringify(actual.map((row) => [row.evidence?.chapter_id, row.evidence?.first_source_ref_key]))
        !== JSON.stringify(expected.map((row) => [row.chapter_id, row.first_source_ref_key]))) {
      findings.push({ code: "narration_subjective_source_structure_invalid" });
    }
  }
  if (!samples.length || Number(manifest?.sample_count ?? -1) !== samples.length) findings.push({ code: "narration_subjective_samples_missing" });
  if (new Set(samples.map((row) => row.sample_id)).size !== samples.length) findings.push({ code: "narration_subjective_sample_ids_duplicated" });
  for (const row of samples) {
    if (!row.sample_id || !NARRATION_SUBJECTIVE_REVIEW_COVERAGE.includes(row.coverage_class)) findings.push({ code: "narration_subjective_sample_identity_invalid", sample_id: row.sample_id ?? null });
    if (!Number.isInteger(row.start_sample) || !Number.isInteger(row.end_sample_exclusive) || row.start_sample < 0 || row.end_sample_exclusive <= row.start_sample || row.end_sample_exclusive > Number(manifest?.total_sample_count ?? 0)) findings.push({ code: "narration_subjective_sample_range_invalid", sample_id: row.sample_id ?? null });
    if (!Array.isArray(row.unit_ids) || !row.unit_ids.length) findings.push({ code: "narration_subjective_sample_unit_scope_missing", sample_id: row.sample_id ?? null });
  }
  if (requireCompleteCoverage) {
    for (const coverageClass of NARRATION_SUBJECTIVE_REVIEW_COVERAGE) {
      if (!Object.hasOwn(manifest?.coverage ?? {}, coverageClass)) findings.push({ code: "narration_subjective_coverage_accounting_missing", coverage_class: coverageClass });
      const mayBeEmpty = coverageClass === "every_chapter_boundary"
        || coverageClass === "system_or_pronunciation_risk";
      if (!mayBeEmpty && !samples.some((row) => row.coverage_class === coverageClass)) findings.push({ code: "narration_subjective_coverage_missing", coverage_class: coverageClass });
    }
    if (Number(manifest?.coverage?.every_chapter_boundary ?? -1)
      !== Number(manifest?.expected_chapter_boundary_count ?? -2)) findings.push({ code: "narration_subjective_chapter_boundary_coverage_incomplete" });
    if (Number(manifest?.coverage?.system_or_pronunciation_risk ?? -1)
      !== Number(manifest?.expected_system_or_pronunciation_risk_count ?? -2)) findings.push({ code: "narration_subjective_risk_coverage_incomplete" });
  }
  return { status: findings.length ? "blocked" : "passed", findings };
}

export function buildNarrationSubjectiveReviewDecision({
  manifest,
  reviewer,
  decisions = [],
  attestation = null,
  reviewedAt = new Date().toISOString(),
} = {}) {
  const byId = new Map((manifest?.samples ?? []).map((row) => [String(row.sample_id), row]));
  const rows = decisions.map((decision) => {
    const sample = byId.get(String(decision.sample_id)) ?? {};
    const disposition = String(decision.decision ?? "");
    const accepted = disposition === "accept";
    return {
      sample_id: String(decision.sample_id),
      coverage_class: sample.coverage_class ?? null,
      start_sample: sample.start_sample ?? null,
      end_sample_exclusive: sample.end_sample_exclusive ?? null,
      decision: disposition,
      confirmations: accepted
        ? Object.fromEntries(ACCEPT_CONFIRMATIONS.map((key) => [key, true]))
        : {},
      repair_unit_ids: accepted ? [] : [...new Set((decision.repair_unit_ids ?? []).map(String))],
      defect_type: accepted ? null : String(decision.defect_type ?? "").trim() || null,
      note: String(decision.note ?? "").trim() || null,
    };
  });
  const repairRequired = rows.some((row) => row.decision === "repair_required");
  const artifact = {
    schema: NARRATION_SUBJECTIVE_REVIEW_DECISION_SCHEMA,
    status: repairRequired ? "repair_required" : "approved",
    manifest_sha256: manifest?.manifest_sha256 ?? null,
    audio_sha256: manifest?.audio_sha256 ?? null,
    reviewer: String(reviewer ?? "").trim() || null,
    reviewed_at: reviewedAt,
    attestation,
    decision_count: rows.length,
    decisions: rows,
  };
  return { ...artifact, decision_sha256: narrationSubjectiveReviewDecisionSha256(artifact) };
}

export function validateNarrationSubjectiveReviewDecision(manifest, decision) {
  const findings = [];
  const manifestValidation = validateNarrationSubjectiveReviewManifest(manifest);
  findings.push(...manifestValidation.findings);
  if (decision?.schema !== NARRATION_SUBJECTIVE_REVIEW_DECISION_SCHEMA) findings.push({ code: "narration_subjective_decision_schema_invalid" });
  if (decision?.decision_sha256 !== narrationSubjectiveReviewDecisionSha256(decision)) findings.push({ code: "narration_subjective_decision_hash_invalid" });
  if (decision?.manifest_sha256 !== manifest?.manifest_sha256 || decision?.audio_sha256 !== manifest?.audio_sha256) findings.push({ code: "narration_subjective_decision_lineage_invalid" });
  if (!String(decision?.reviewer ?? "").trim()) findings.push({ code: "narration_subjective_reviewer_missing" });
  const samples = Array.isArray(manifest?.samples) ? manifest.samples : [];
  const sampleById = new Map(samples.map((row) => [String(row.sample_id), row]));
  const rows = Array.isArray(decision?.decisions) ? decision.decisions : [];
  const sampleIds = samples.map((row) => String(row.sample_id));
  const decisionIds = rows.map((row) => String(row.sample_id));
  if (sampleIds.length !== decisionIds.length || new Set(decisionIds).size !== decisionIds.length || sampleIds.some((id) => !decisionIds.includes(id))) findings.push({ code: "narration_subjective_decision_scope_invalid" });
  for (const row of rows) {
    const sample = sampleById.get(String(row.sample_id));
    if (!sample || row.coverage_class !== sample.coverage_class || row.start_sample !== sample.start_sample || row.end_sample_exclusive !== sample.end_sample_exclusive) findings.push({ code: "narration_subjective_decision_sample_binding_invalid", sample_id: row.sample_id ?? null });
    if (row.decision === "accept") {
      if (decision.attestation !== NARRATION_SUBJECTIVE_REVIEW_ATTESTATION || ACCEPT_CONFIRMATIONS.some((key) => row.confirmations?.[key] !== true)) findings.push({ code: "narration_subjective_acceptance_incomplete", sample_id: row.sample_id ?? null });
    } else if (row.decision === "repair_required") {
      const allowed = new Set(sample?.unit_ids ?? []);
      if (!String(row.defect_type ?? "").trim() || !Array.isArray(row.repair_unit_ids) || !row.repair_unit_ids.length || row.repair_unit_ids.some((id) => !allowed.has(String(id)))) findings.push({ code: "narration_subjective_repair_scope_invalid", sample_id: row.sample_id ?? null });
    } else findings.push({ code: "narration_subjective_disposition_invalid", sample_id: row.sample_id ?? null });
  }
  const repairUnitIds = [...new Set(rows.flatMap((row) => row.repair_unit_ids ?? []).map(String))];
  const expectedStatus = repairUnitIds.length ? "repair_required" : "approved";
  if (decision?.status !== expectedStatus || Number(decision?.decision_count ?? -1) !== rows.length) findings.push({ code: "narration_subjective_decision_status_invalid" });
  return {
    status: findings.length ? "blocked" : expectedStatus,
    findings,
    repair_unit_ids: repairUnitIds,
  };
}
