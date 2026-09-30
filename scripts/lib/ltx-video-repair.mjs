function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function ltxCandidateId(imageId) {
  return `${imageId}-candidate-01`;
}

export function ltxPlanClipContract(clip = {}) {
  return {
    image_id: clip.image_id ?? null,
    scene_id: clip.scene_id ?? null,
    visual_beat_id: clip.visual_beat_id ?? null,
    start_sec: Number(clip.start_sec ?? 0),
    cut_duration_sec: Number(clip.cut_duration_sec ?? 0),
    duration_sec: Number(clip.duration_sec ?? 0),
    animation_sequence_id: clip.animation_sequence_id ?? null,
    sequence_mode: clip.sequence_mode ?? "standalone_shot",
    sequence_timeline_duration_sec: Number(clip.sequence_timeline_duration_sec ?? clip.cut_duration_sec ?? 0),
    coverage: clip.coverage ?? null,
    start_frame_contract: clip.start_frame_contract ?? null,
    end_frame_contract: clip.end_frame_contract ?? null,
    provider_image_inputs: clip.provider_image_inputs ?? null,
    source_image_path: clip.source_image_path ?? null,
    source_image_sha256: clip.source_image_sha256 ?? null,
    source_prompt_sha256: clip.source_prompt_sha256 ?? null,
    motion_prompt: clip.motion_prompt ?? null,
    motion_prompt_sha256: clip.motion_prompt_sha256 ?? null,
    negative_prompt: clip.negative_prompt ?? null,
    candidate_count: Number(clip.candidate_count ?? 1),
  };
}

export function ltxReportRowContract(row = {}) {
  return {
    image_id: row.image_id ?? null,
    scene_id: row.scene_id ?? null,
    visual_beat_id: row.visual_beat_id ?? null,
    start_sec: Number(row.start_sec ?? 0),
    cut_duration_sec: Number(row.cut_duration_sec ?? 0),
    requested_duration_sec: Number(row.requested_duration_sec ?? 0),
    animation_sequence_id: row.animation_sequence_id ?? null,
    sequence_mode: row.sequence_mode ?? "standalone_shot",
    sequence_timeline_duration_sec: Number(row.sequence_timeline_duration_sec ?? row.cut_duration_sec ?? 0),
    coverage: row.coverage ?? null,
    start_frame_contract: row.start_frame_contract ?? null,
    end_frame_contract: row.end_frame_contract ?? null,
    source_image_path: row.source_image_path ?? null,
    source_image_sha256: row.source_image_sha256 ?? null,
    source_prompt_sha256: row.source_prompt_sha256 ?? null,
    motion_prompt_sha256: row.motion_prompt_sha256 ?? null,
  };
}

export function reportRowMatchesPlanClip(row, clip) {
  const planContract = ltxPlanClipContract(clip);
  return jsonEqual(ltxReportRowContract(row), {
    image_id: planContract.image_id,
    scene_id: planContract.scene_id,
    visual_beat_id: planContract.visual_beat_id,
    start_sec: planContract.start_sec,
    cut_duration_sec: planContract.cut_duration_sec,
    requested_duration_sec: planContract.duration_sec,
    animation_sequence_id: planContract.animation_sequence_id,
    sequence_mode: planContract.sequence_mode,
    sequence_timeline_duration_sec: planContract.sequence_timeline_duration_sec,
    coverage: planContract.coverage,
    start_frame_contract: planContract.start_frame_contract,
    end_frame_contract: planContract.end_frame_contract,
    source_image_path: planContract.source_image_path,
    source_image_sha256: planContract.source_image_sha256,
    source_prompt_sha256: planContract.source_prompt_sha256,
    motion_prompt_sha256: planContract.motion_prompt_sha256,
  });
}

export function mergeLtxPlanForRepair({
  freshPlan,
  priorPlan,
  scopeIds,
  preserveUntouchedSourceStable = false,
}) {
  const scope = scopeIds instanceof Set ? scopeIds : new Set(scopeIds ?? []);
  if (!scope.size) throw new Error("Scoped LTX repair requires at least one exact cut ID.");
  const freshClips = Array.isArray(freshPlan?.clips) ? freshPlan.clips : [];
  const priorById = new Map((priorPlan?.clips ?? []).map((row) => [String(row.image_id ?? ""), row]));
  const freshIds = new Set(freshClips.map((row) => String(row.image_id ?? "")));
  const unknown = [...scope].filter((id) => !freshIds.has(id));
  if (unknown.length) throw new Error(`Scoped LTX repair IDs are absent from the current animation plan: ${unknown.join(", ")}`);
  const removedPrior = [...priorById.keys()].filter((id) => id && !freshIds.has(id));
  if (removedPrior.length) {
    throw new Error(`Scoped LTX repair cannot silently remove prior canonical clips: ${removedPrior.join(", ")}`);
  }
  const preservedContractDriftImageIds = [];
  const clips = freshClips.map((fresh) => {
    const imageId = String(fresh.image_id ?? "");
    if (scope.has(imageId)) return fresh;
    const prior = priorById.get(imageId);
    if (!prior) return fresh;
    if (!jsonEqual(ltxPlanClipContract(prior), ltxPlanClipContract(fresh))) {
      const sourceStable = prior.image_id === fresh.image_id
        && prior.scene_id === fresh.scene_id
        && prior.visual_beat_id === fresh.visual_beat_id
        && prior.source_image_path === fresh.source_image_path
        && prior.source_image_sha256 === fresh.source_image_sha256;
      if (!preserveUntouchedSourceStable || !sourceStable) {
        throw new Error(`Untouched LTX plan clip changed outside repair scope: ${imageId}.`);
      }
      preservedContractDriftImageIds.push(imageId);
    }
    return prior;
  });
  return {
    ...freshPlan,
    clips,
    clip_count: clips.length,
    preserved_untouched_source_stable_contract_count: preservedContractDriftImageIds.length,
    preserved_untouched_source_stable_contract_image_ids: preservedContractDriftImageIds,
  };
}

export function omittedLtxRowForPlanClip(clip, {
  reason = "not_selected_in_prior_full_stage",
  creativeGenerationAttempt = 0,
} = {}) {
  return {
    image_id: clip.image_id,
    candidate_id: ltxCandidateId(clip.image_id),
    candidate_index: 1,
    creative_generation_attempt: creativeGenerationAttempt,
    automatic_generation_retry_allowed: false,
    scene_id: clip.scene_id ?? null,
    visual_beat_id: clip.visual_beat_id ?? null,
    start_sec: clip.start_sec,
    cut_duration_sec: clip.cut_duration_sec,
    requested_duration_sec: clip.duration_sec,
    animation_sequence_id: clip.animation_sequence_id ?? null,
    sequence_mode: clip.sequence_mode ?? "standalone_shot",
    sequence_timeline_duration_sec: clip.sequence_timeline_duration_sec ?? clip.cut_duration_sec,
    coverage: clip.coverage ?? null,
    start_frame_contract: clip.start_frame_contract ?? null,
    end_frame_contract: clip.end_frame_contract ?? null,
    source_image_path: clip.source_image_path,
    source_image_sha256: clip.source_image_sha256,
    source_prompt_sha256: clip.source_prompt_sha256,
    motion_prompt_sha256: clip.motion_prompt_sha256,
    request_id: null,
    status: "omitted",
    disposition: "accepted_still_fallback",
    omission_stage: "scoped_repair_plan_completion",
    error: reason,
  };
}

export function mergeLtxReportRowsForRepair({
  mergedPlan,
  priorReport,
  scopeIds,
  scopedRows,
}) {
  const scope = scopeIds instanceof Set ? scopeIds : new Set(scopeIds ?? []);
  const scopedById = new Map((scopedRows ?? []).map((row) => [String(row.image_id ?? ""), row]));
  const priorRows = [...(priorReport?.clips ?? []), ...(priorReport?.omitted_clips ?? [])];
  const priorById = new Map(priorRows.map((row) => [String(row.image_id ?? ""), row]));
  if (priorById.size !== priorRows.length) throw new Error("Prior LTX report contains duplicate image IDs.");
  const rows = (mergedPlan?.clips ?? []).map((clip) => {
    const imageId = String(clip.image_id ?? "");
    if (scope.has(imageId)) {
      const replacement = scopedById.get(imageId);
      if (!replacement) throw new Error(`Scoped LTX repair did not produce a replacement row for ${imageId}.`);
      if (!reportRowMatchesPlanClip(replacement, clip)) {
        throw new Error(`Scoped LTX replacement row does not match the current plan for ${imageId}.`);
      }
      return replacement;
    }
    const prior = priorById.get(imageId);
    if (!prior) return omittedLtxRowForPlanClip(clip);
    if (!reportRowMatchesPlanClip(prior, clip)) {
      throw new Error(`Untouched LTX report row changed outside repair scope: ${imageId}.`);
    }
    return prior;
  });
  return {
    rows,
    generated: rows.filter((row) => row.status === "generated"),
    omitted: rows.filter((row) => row.status !== "generated"),
  };
}

export function providerRetryDelayMs(value) {
  const text = String(value ?? "");
  const minuteMatch = text.match(/try again in\s+(\d+)\s+minute/i);
  if (minuteMatch) return (Number(minuteMatch[1]) * 60 + 5) * 1000;
  const secondMatch = text.match(/try again in\s+(\d+)\s+second/i);
  if (secondMatch) return (Number(secondMatch[1]) + 5) * 1000;
  return null;
}

export function providerRetryDeadlineMs(row = {}, fallbackTimestamp = null, nowMs = Date.now()) {
  const value = row ?? {};
  const explicit = Date.parse(String(value.cooldown_until ?? ""));
  if (Number.isFinite(explicit)) return explicit;
  const retryDelayMs = providerRetryDelayMs(value.error);
  if (retryDelayMs == null) return null;
  const basis = [value.omitted_at, value.request_started_at, fallbackTimestamp]
    .map((value) => Date.parse(String(value ?? "")))
    .find(Number.isFinite);
  return (basis ?? nowMs) + retryDelayMs;
}

export function isTransientLtxOmission(row = {}) {
  const value = row ?? {};
  if (String(value.status ?? "") !== "omitted") return false;
  const text = `${value.omission_stage ?? ""} ${value.error ?? ""}`;
  return /rate.?limit|try again in|\b429\b|timed?\s*out|timeout|non-json\s+(?:5\d\d|#)|\b(?:500|502|503|504|520|522|524)\b|gateway|service unavailable|temporarily unavailable|network (?:error|failure)|fetch failed|socket hang up|econn(?:reset|refused|aborted|timedout)/i.test(text);
}

export function mergeLtxApprovalDecisions({
  report,
  priorApproval,
  approveIds,
  rejectIds,
  reviewer,
  note,
  repairExisting,
}) {
  const approve = approveIds instanceof Set ? approveIds : new Set(approveIds ?? []);
  const reject = rejectIds instanceof Set ? rejectIds : new Set(rejectIds ?? []);
  const clips = Array.isArray(report?.clips) ? report.clips : [];
  const known = new Set(clips.map((row) => String(row.candidate_id ?? row.image_id ?? "")));
  const unknown = [...new Set([...approve, ...reject])].filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`Unknown LTX clip id in approval flags: ${unknown.join(", ")}`);
  const overlap = [...approve].filter((id) => reject.has(id));
  if (overlap.length) throw new Error(`LTX clips cannot be both approved and rejected: ${overlap.join(", ")}`);
  const priorById = new Map((priorApproval?.decisions ?? []).map((row) => [String(row.candidate_id ?? row.image_id ?? ""), row]));
  const decisions = clips.map((clip) => {
    const id = String(clip.candidate_id ?? clip.image_id ?? "");
    const selected = approve.has(id) || reject.has(id);
    if (selected) {
      if (!reviewer || !note) throw new Error("--reviewer and --note are required for new LTX decisions.");
      return {
        image_id: clip.image_id,
        candidate_id: id,
        decision: approve.has(id) ? "accepted" : "rejected",
        source_image_sha256: clip.source_image_sha256,
        video_sha256: clip.normalized_video_sha256,
        reviewer,
        note,
      };
    }
    const prior = repairExisting ? priorById.get(id) : null;
    if (prior
      && prior.image_id === clip.image_id
      && prior.source_image_sha256 === clip.source_image_sha256
      && prior.video_sha256 === clip.normalized_video_sha256
      && ["accepted", "rejected"].includes(String(prior.decision ?? ""))) {
      return prior;
    }
    throw new Error(`Every generated LTX clip requires a current decision. Missing: ${id}`);
  });
  return decisions;
}
