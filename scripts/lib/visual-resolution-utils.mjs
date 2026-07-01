function sameOptional(actual, expected) {
  if (actual == null || actual === "" || expected == null || expected === "") return true;
  return String(actual) === String(expected);
}

export function unresolvedBlockerFindings(findings) {
  return (findings ?? []).filter((finding) => finding?.severity === "blocker" && finding.resolved !== true);
}

export function blockerImageIds(blockers) {
  return [...new Set((blockers ?? []).map((finding) => String(finding?.image_id ?? "").trim()).filter(Boolean))];
}

export function blockerSceneIds(blockers) {
  return [...new Set((blockers ?? []).map((finding) => String(finding?.scene_id ?? "").trim()).filter(Boolean))];
}

export function visualResolveScopeForBlockers(blockers) {
  const unresolved = unresolvedBlockerFindings(blockers);
  const imageIds = blockerImageIds(unresolved);
  const sceneIds = blockerSceneIds(unresolved);
  const allBlockersHaveImageIds = unresolved.length > 0
    && unresolved.every((finding) => String(finding?.image_id ?? "").trim().length > 0);
  if (allBlockersHaveImageIds && imageIds.length) {
    return {
      mode: "cut_ids",
      args: ["--cut-ids", imageIds.join(",")],
      image_ids: imageIds,
      scene_ids: sceneIds,
    };
  }
  return {
    mode: "scene_ids",
    args: sceneIds.length ? ["--only-scenes", sceneIds.join(",")] : [],
    image_ids: imageIds,
    scene_ids: sceneIds,
  };
}

export function mergeScopedPromptReplacements(basePrompts, replacementPrompts, scope) {
  const replacementsById = new Map((replacementPrompts ?? []).map((prompt) => [prompt.image_id, prompt]));
  const imageSet = new Set(scope?.image_ids ?? []);
  const sceneSet = new Set(scope?.scene_ids ?? []);
  return (basePrompts ?? []).map((prompt) => {
    if (imageSet.size) return imageSet.has(prompt.image_id) ? (replacementsById.get(prompt.image_id) ?? prompt) : prompt;
    if (sceneSet.size) return sceneSet.has(prompt.scene_id) ? (replacementsById.get(prompt.image_id) ?? prompt) : prompt;
    return prompt;
  });
}

export function hasHardenFeedbackFindings(findings) {
  return unresolvedBlockerFindings(findings).some((finding) => finding.source_stage === "visual_harden");
}

export function compatibleHardenFeedbackBlockers({
  hardenReport,
  promptPlan,
  channel = null,
  series = null,
  week = null,
  episode = null,
  hardenReportPath = null,
} = {}) {
  if (!hardenReport || hardenReport.status !== "blocked") return [];
  if (!sameOptional(hardenReport.channel, channel)) return [];
  if (!sameOptional(hardenReport.series_slug ?? hardenReport.series, series)) return [];
  if (!sameOptional(hardenReport.week, week)) return [];
  if (!sameOptional(hardenReport.episode, episode)) return [];
  if (!sameOptional(hardenReport.source_script_hash, promptPlan?.source_script_hash)) return [];
  const expectedCount = Number(hardenReport.input_prompt_count);
  if (Number.isFinite(expectedCount) && Array.isArray(promptPlan?.prompts) && expectedCount !== promptPlan.prompts.length) return [];
  return unresolvedBlockerFindings(hardenReport.findings ?? hardenReport.unresolved_blockers).map((finding) => ({
    ...finding,
    severity: "blocker",
    resolved: false,
    source_stage: "visual_harden",
    source_report_path: hardenReportPath,
  }));
}

export function resolvedDeadletterPayload(existing, {
  channel = null,
  series = null,
  week = null,
  episode = null,
  reviewReportPath = null,
  reviewedPromptPlanPath = null,
  now = new Date().toISOString(),
} = {}) {
  if (!existing || existing.status !== "blocked_deadletter") return null;
  if (!sameOptional(existing.channel, channel)) return null;
  if (!sameOptional(existing.series_slug ?? existing.series, series)) return null;
  if (!sameOptional(existing.week, week)) return null;
  if (!sameOptional(existing.episode, episode)) return null;
  return {
    ...existing,
    previous_status: existing.status,
    status: "resolved",
    resolved: true,
    resolution_reason: "visual review passed and superseded the stale dead-lettered blocker set",
    scene_ids: [],
    unresolved_blockers: [],
    resolved_by_review_report_path: reviewReportPath,
    reviewed_prompt_plan_path: reviewedPromptPlanPath,
    resolved_at: now,
    updated_at: now,
  };
}
