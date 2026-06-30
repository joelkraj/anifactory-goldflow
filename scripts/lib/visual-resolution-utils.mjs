function sameOptional(actual, expected) {
  if (actual == null || actual === "" || expected == null || expected === "") return true;
  return String(actual) === String(expected);
}

export function unresolvedBlockerFindings(findings) {
  return (findings ?? []).filter((finding) => finding?.severity === "blocker" && finding.resolved !== true);
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
