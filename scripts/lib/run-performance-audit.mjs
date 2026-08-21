import { PIPELINE_STAGE_REGISTRY } from "./pipeline-stage-registry.mjs";

const stageById = new Map(PIPELINE_STAGE_REGISTRY.map((stage) => [stage.id, stage]));
const stageIndexById = new Map(PIPELINE_STAGE_REGISTRY.map((stage, index) => [stage.id, index]));

const COSTLY_REPEAT_STAGES = new Set([
  "semantic_scene_plan",
  "voice_plan",
  "qwen_tts_stitch",
  "visual_beat_plan",
  "visual_reference_plan",
  "visual_prompt_plan",
  "transition_edit_plan",
  "reference_generation",
  "image_generation",
  "generated_video_motion",
  "parallax_asset_generation",
  "premium_render",
]);

function finiteDate(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 3) {
  return Number(Number(value ?? 0).toFixed(digits));
}

function percentile(values, quantile) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * Math.max(0, Math.min(1, quantile));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + ((sorted[upper] - sorted[lower]) * (position - lower));
}

function completedIntervals(events = []) {
  return events
    .filter((event) => event?.event_type === "stage_completed")
    .flatMap((event) => {
      const startMs = finiteDate(event.started_at);
      const endMs = finiteDate(event.completed_at);
      if (startMs === null || endMs === null || endMs < startMs) return [];
      return [{
        start_ms: startMs,
        end_ms: endMs,
        stage: String(event.stage ?? "unknown"),
        status: String(event.status ?? "unknown"),
        execution_id: event.execution_id ?? null,
        command: event.command ?? null,
      }];
    })
    .sort((left, right) => left.start_ms - right.start_ms || left.end_ms - right.end_ms);
}

function mergeIntervals(intervals) {
  const merged = [];
  for (const interval of intervals) {
    const current = merged.at(-1);
    if (!current || interval.start_ms > current.end_ms) {
      merged.push({
        start_ms: interval.start_ms,
        end_ms: interval.end_ms,
        intervals: [interval],
      });
      continue;
    }
    current.end_ms = Math.max(current.end_ms, interval.end_ms);
    current.intervals.push(interval);
  }
  return merged;
}

function edgeStage(group, edge) {
  const sorted = [...group.intervals].sort((left, right) => (
    edge === "end"
      ? right.end_ms - left.end_ms
      : left.start_ms - right.start_ms
  ));
  return sorted[0] ?? null;
}

function gapClassification(previous, next, durationSec, thresholdSec) {
  if (durationSec < thresholdSec) return "normal_transition";
  if (previous.intervals.some((interval) => interval.status === "failed")) return "blocker_recovery";
  const previousStage = edgeStage(previous, "end")?.stage;
  const nextStage = edgeStage(next, "start")?.stage;
  const previousIndex = stageIndexById.get(previousStage);
  const nextIndex = stageIndexById.get(nextStage);
  if (Number.isInteger(previousIndex) && Number.isInteger(nextIndex) && nextIndex < previousIndex) {
    return "out_of_order_rework";
  }
  const approval = stageById.get(nextStage)?.approval ?? "automatic";
  if (approval !== "automatic") return "operator_or_agent_checkpoint";
  return "avoidable_automatic_stage_idle";
}

function stageRows(intervals) {
  const grouped = new Map();
  for (const interval of intervals) {
    const rows = grouped.get(interval.stage) ?? [];
    rows.push(interval);
    grouped.set(interval.stage, rows);
  }
  return [...grouped.entries()].map(([stage, rows]) => {
    const merged = mergeIntervals(rows);
    const first = Math.min(...rows.map((row) => row.start_ms));
    const last = Math.max(...rows.map((row) => row.end_ms));
    const activeMs = merged.reduce((sum, row) => sum + row.end_ms - row.start_ms, 0);
    return {
      stage,
      invocation_count: rows.length,
      passed_invocation_count: rows.filter((row) => row.status === "passed").length,
      failed_invocation_count: rows.filter((row) => row.status === "failed").length,
      active_minutes: round(activeMs / 60_000),
      elapsed_span_minutes: round((last - first) / 60_000),
      within_stage_idle_minutes: round(Math.max(0, last - first - activeMs) / 60_000),
      first_started_at: new Date(first).toISOString(),
      last_completed_at: new Date(last).toISOString(),
    };
  }).sort((left, right) => finiteDate(left.first_started_at) - finiteDate(right.first_started_at));
}

function scopeHasExactIds(scope = {}) {
  return [
    ...(scope.cut_ids ?? []),
    ...(scope.scene_ids ?? []),
    ...(scope.beat_ids ?? []),
    ...(scope.planner_chunk_ids ?? []),
    ...(scope.reference_ids ?? []),
    ...(scope.tts_unit_ids ?? []),
    ...(scope.boundary_ids ?? []),
  ].length > 0;
}

function repeatInvocationCommandFamily(stage, command) {
  if (["reference_generation", "image_generation"].includes(stage)
    && ["imagegen browser-pool", "imagegen start", "imagegen codex-work"].includes(command)) {
    return "imagegen creative";
  }
  if (stage === "qwen_tts_stitch"
    && ["tts narrate", "tts qwen"].includes(command)) {
    return "tts synthesis";
  }
  return command;
}

export function buildRepeatInvocationTelemetry(events = []) {
  const completed = events.filter((event) => event?.event_type === "stage_completed");
  const groups = new Map();
  for (const event of completed) {
    const stage = String(event.stage ?? "unknown");
    const command = repeatInvocationCommandFamily(
      stage,
      String(event.command ?? "unknown"),
    );
    const scopeHash = String(event.scope_sha256 ?? JSON.stringify(event.scope ?? {}));
    const key = `${stage}\u0000${command}\u0000${scopeHash}`;
    const group = groups.get(key) ?? {
      stage,
      command,
      scope_sha256: event.scope_sha256 ?? null,
      exact_scope: scopeHasExactIds(event.scope),
      invocation_count: 0,
      failure_count: 0,
      active_minutes: 0,
      invocation_active_minutes: [],
    };
    group.invocation_count += 1;
    if (event.status === "failed") group.failure_count += 1;
    const recordedWallSec = Number(event.wall_time_sec);
    const startedAt = finiteDate(event.started_at);
    const completedAt = finiteDate(event.completed_at);
    const activeMinutes = Number.isFinite(recordedWallSec)
      ? Math.max(0, recordedWallSec / 60)
      : startedAt !== null && completedAt !== null
        ? Math.max(0, (completedAt - startedAt) / 60_000)
        : 0;
    group.active_minutes += activeMinutes;
    group.invocation_active_minutes.push(activeMinutes);
    groups.set(key, group);
  }
  const repeatedGroups = [...groups.values()]
    .filter((group) => group.invocation_count > 1)
    .map((group) => {
      const { invocation_active_minutes: invocationMinutes, ...summary } = group;
      return {
        ...summary,
        repeat_invocation_count: group.invocation_count - 1,
        active_minutes: round(group.active_minutes),
        repeated_active_minutes: round(invocationMinutes
          .slice(1)
          .reduce((sum, minutes) => sum + minutes, 0)),
      };
    })
    .sort((left, right) => right.active_minutes - left.active_minutes);
  const costlyGroups = repeatedGroups.filter((group) => COSTLY_REPEAT_STAGES.has(group.stage));
  return {
    schema: "goldflow_repeat_invocation_telemetry_v1",
    repeated_same_scope_invocation_count: repeatedGroups.reduce((sum, group) => sum + group.repeat_invocation_count, 0),
    repeated_full_scope_invocation_count: repeatedGroups
      .filter((group) => !group.exact_scope)
      .reduce((sum, group) => sum + group.repeat_invocation_count, 0),
    costly_repeated_invocation_count: costlyGroups.reduce((sum, group) => sum + group.repeat_invocation_count, 0),
    costly_repeated_active_minutes: round(costlyGroups.reduce((sum, group) => sum + group.repeated_active_minutes, 0)),
    groups: repeatedGroups,
  };
}

function prerequisiteStageIds(stageId) {
  const stage = stageById.get(stageId);
  if (!stage) return [];
  if (Array.isArray(stage.depends_on) && stage.depends_on.length) return stage.depends_on;
  const index = stageIndexById.get(stageId);
  return Number.isInteger(index) && index > 0
    ? [PIPELINE_STAGE_REGISTRY[index - 1].id]
    : [];
}

function reviewTollClass(approval) {
  if (approval === "operator_or_agent") return "agent_delegation_or_packet_readiness";
  if (approval === "risk_cut_decisions") return "exception_packet_readiness";
  return "operator_scheduling_or_packet_readiness";
}

export function buildOperatorReviewTelemetry(events = [], {
  reviewTollThresholdMinutes = 15,
} = {}) {
  const intervals = completedIntervals(events);
  const waits = [];
  for (const review of intervals) {
    const stage = stageById.get(review.stage);
    if (!stage || stage.approval === "automatic") continue;
    const prerequisites = new Set(prerequisiteStageIds(review.stage));
    const ready = intervals
      .filter((row) => prerequisites.has(row.stage))
      .filter((row) => row.status === "passed" && row.end_ms <= review.start_ms)
      .sort((left, right) => right.end_ms - left.end_ms)[0] ?? null;
    if (!ready) continue;
    const waitMinutes = Math.max(0, (review.start_ms - ready.end_ms) / 60_000);
    waits.push({
      stage: review.stage,
      approval_type: stage.approval,
      prerequisite_stage: ready.stage,
      ready_at: new Date(ready.end_ms).toISOString(),
      review_started_at: new Date(review.start_ms).toISOString(),
      wait_minutes: round(waitMinutes),
      exceeded_review_toll_threshold: waitMinutes >= reviewTollThresholdMinutes,
      review_toll_class: waitMinutes >= reviewTollThresholdMinutes
        ? reviewTollClass(stage.approval)
        : "within_target",
    });
  }
  const waitValues = waits.map((row) => row.wait_minutes);
  const byApprovalType = Object.fromEntries(
    [...new Set(waits.map((row) => row.approval_type))].map((approvalType) => {
      const rows = waits.filter((row) => row.approval_type === approvalType);
      const values = rows.map((row) => row.wait_minutes);
      return [approvalType, {
        sample_count: rows.length,
        wait_minutes_p50: round(percentile(values, 0.5)),
        wait_minutes_p90: round(percentile(values, 0.9)),
        wait_minutes_total: round(values.reduce((sum, value) => sum + value, 0)),
        review_toll_candidate_count: rows.filter((row) => row.exceeded_review_toll_threshold).length,
      }];
    }),
  );
  return {
    schema: "goldflow_operator_review_telemetry_v1",
    policy: "Measures readiness-to-review-start latency. It does not treat the time spent making a consequential operator decision as waste.",
    review_toll_threshold_minutes: reviewTollThresholdMinutes,
    sample_count: waits.length,
    wait_minutes_p50: waitValues.length ? round(percentile(waitValues, 0.5)) : null,
    wait_minutes_p90: waitValues.length ? round(percentile(waitValues, 0.9)) : null,
    wait_minutes_total: round(waitValues.reduce((sum, value) => sum + value, 0)),
    review_toll_candidate_count: waits.filter((row) => row.exceeded_review_toll_threshold).length,
    by_approval_type: byApprovalType,
    waits,
    reduction_priority: waits
      .filter((row) => row.exceeded_review_toll_threshold)
      .sort((left, right) => right.wait_minutes - left.wait_minutes),
  };
}

export function buildRunPerformanceAudit(events = [], {
  targetWallClockMinutes = null,
  idleThresholdSec = 60,
  reviewTollThresholdMinutes = 15,
  now = new Date(),
} = {}) {
  const intervals = completedIntervals(events);
  if (!intervals.length) throw new Error("Performance audit requires at least one completed stage event.");
  const merged = mergeIntervals(intervals);
  const firstMs = Math.min(...intervals.map((row) => row.start_ms));
  const lastMs = Math.max(...intervals.map((row) => row.end_ms));
  const elapsedMs = lastMs - firstMs;
  const activeMs = merged.reduce((sum, row) => sum + row.end_ms - row.start_ms, 0);
  const gaps = [];
  for (let index = 1; index < merged.length; index += 1) {
    const previous = merged[index - 1];
    const next = merged[index];
    const durationSec = (next.start_ms - previous.end_ms) / 1000;
    const previousStage = edgeStage(previous, "end");
    const nextStage = edgeStage(next, "start");
    gaps.push({
      started_at: new Date(previous.end_ms).toISOString(),
      ended_at: new Date(next.start_ms).toISOString(),
      duration_minutes: round(durationSec / 60),
      after_stage: previousStage?.stage ?? null,
      after_status: previousStage?.status ?? null,
      before_stage: nextStage?.stage ?? null,
      classification: gapClassification(previous, next, durationSec, idleThresholdSec),
    });
  }
  const idleByClassification = {};
  for (const gap of gaps) {
    idleByClassification[gap.classification] = round(
      Number(idleByClassification[gap.classification] ?? 0) + gap.duration_minutes,
    );
  }
  const startedIds = new Set(events
    .filter((event) => event?.event_type === "stage_started")
    .map((event) => event.execution_id)
    .filter(Boolean));
  const completedIds = new Set(intervals.map((interval) => interval.execution_id).filter(Boolean));
  const orphanedExecutionIds = [...startedIds].filter((id) => !completedIds.has(id));
  const target = Number.isFinite(Number(targetWallClockMinutes))
    ? Number(targetWallClockMinutes)
    : null;
  const elapsedMinutes = elapsedMs / 60_000;
  const avoidableIdleMinutes = Number(idleByClassification.avoidable_automatic_stage_idle ?? 0);
  const operatorReviewTelemetry = buildOperatorReviewTelemetry(events, {
    reviewTollThresholdMinutes,
  });
  const repeatInvocationTelemetry = buildRepeatInvocationTelemetry(events);
  const findings = [];
  if (target !== null && elapsedMinutes > target) {
    findings.push({
      severity: "high",
      code: "target_wall_clock_exceeded",
      message: `Observed wall clock exceeded the ${target}-minute target by ${round(elapsedMinutes - target)} minutes.`,
    });
  }
  if (avoidableIdleMinutes > 30) {
    findings.push({
      severity: "high",
      code: "automatic_stage_idle_dominates",
      message: `${round(avoidableIdleMinutes)} minutes elapsed between automatic stages without a recorded approval gate or failed predecessor.`,
    });
  }
  if (orphanedExecutionIds.length) {
    findings.push({
      severity: "medium",
      code: "orphaned_stage_starts",
      message: `${orphanedExecutionIds.length} stage starts have no completion event.`,
    });
  }
  if (operatorReviewTelemetry.review_toll_candidate_count > 0) {
    findings.push({
      severity: "medium",
      code: "operator_review_readiness_wait_detected",
      message: `${operatorReviewTelemetry.review_toll_candidate_count} approval checkpoint(s) waited at least ${reviewTollThresholdMinutes} minutes after their prerequisite was ready; inspect packet readiness, notifications, or agent delegation without weakening the approval itself.`,
    });
  }
  if (repeatInvocationTelemetry.repeated_full_scope_invocation_count > 0) {
    findings.push({
      severity: "high",
      code: "repeated_full_scope_stage_invocations",
      message: `${repeatInvocationTelemetry.repeated_full_scope_invocation_count} repeated full-scope invocation(s) were recorded; recovery should name only exact failed IDs or reuse content-addressed passed chunks.`,
    });
  }
  return {
    schema: "goldflow_run_performance_audit_v1",
    status: "passed",
    generated_at: now.toISOString(),
    observation: {
      first_stage_started_at: new Date(firstMs).toISOString(),
      last_stage_completed_at: new Date(lastMs).toISOString(),
      elapsed_minutes: round(elapsedMinutes),
      active_union_minutes: round(activeMs / 60_000),
      idle_minutes: round(Math.max(0, elapsedMs - activeMs) / 60_000),
      utilization_percent: round(elapsedMs > 0 ? activeMs / elapsedMs * 100 : 100, 2),
      target_wall_clock_minutes: target,
      target_overrun_minutes: target === null ? null : round(Math.max(0, elapsedMinutes - target)),
    },
    execution: {
      completed_invocation_count: intervals.length,
      failed_invocation_count: intervals.filter((row) => row.status === "failed").length,
      orphaned_started_execution_ids: orphanedExecutionIds,
    },
    idle_by_classification_minutes: idleByClassification,
    largest_gaps: [...gaps].sort((left, right) => right.duration_minutes - left.duration_minutes).slice(0, 20),
    stages: stageRows(intervals),
    repeat_invocation_telemetry: repeatInvocationTelemetry,
    operator_review_telemetry: operatorReviewTelemetry,
    findings,
  };
}

export function renderRunPerformanceAuditMarkdown(report) {
  const observation = report.observation;
  const lines = [
    "# Goldflow Run Performance Audit",
    "",
    `Generated: ${report.generated_at}`,
    "",
    "## Summary",
    "",
    `- Elapsed: ${observation.elapsed_minutes} minutes`,
    `- Active union: ${observation.active_union_minutes} minutes`,
    `- Idle: ${observation.idle_minutes} minutes`,
    `- Utilization: ${observation.utilization_percent}%`,
    `- Target: ${observation.target_wall_clock_minutes ?? "not recorded"} minutes`,
    `- Target band: ${report.target_wall_clock_band_minutes
      ? `${report.target_wall_clock_band_minutes.minimum}-${report.target_wall_clock_band_minutes.maximum} minutes`
      : "not recorded"}`,
    `- Failed invocations: ${report.execution.failed_invocation_count}`,
    `- Repeated full-scope invocations: ${report.repeat_invocation_telemetry?.repeated_full_scope_invocation_count ?? 0}`,
    "",
    "## Findings",
    "",
    ...(report.findings.length
      ? report.findings.map((finding) => `- **${finding.severity.toUpperCase()} ${finding.code}:** ${finding.message}`)
      : ["- No threshold findings."]),
    "",
    "## Largest Gaps",
    "",
    "| Minutes | Classification | After | Before |",
    "| ---: | --- | --- | --- |",
    ...report.largest_gaps.map((gap) => `| ${gap.duration_minutes} | ${gap.classification} | ${gap.after_stage ?? "-"} | ${gap.before_stage ?? "-"} |`),
    "",
    "## Stage Timing",
    "",
    "| Stage | Calls | Failed | Active min | Span min |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...report.stages.map((stage) => `| ${stage.stage} | ${stage.invocation_count} | ${stage.failed_invocation_count} | ${stage.active_minutes} | ${stage.elapsed_span_minutes} |`),
    "",
  ];
  if (report.repeat_invocation_telemetry?.groups?.length) {
    lines.push(
      "## Repeated Invocation Scope",
      "",
      "| Stage | Command | Invocations | Repeats | Exact scope | Total active min | Repeat active min |",
      "| --- | --- | ---: | ---: | --- | ---: | ---: |",
      ...report.repeat_invocation_telemetry.groups.map((group) => `| ${group.stage} | ${group.command} | ${group.invocation_count} | ${group.repeat_invocation_count} | ${group.exact_scope ? "yes" : "no"} | ${group.active_minutes} | ${group.repeated_active_minutes} |`),
      "",
    );
  }
  if (report.operator_review_telemetry) {
    const review = report.operator_review_telemetry;
    lines.push(
      "## Approval Readiness",
      "",
      `- Checkpoints measured: ${review.sample_count}`,
      `- Ready-to-review wait p50/p90: ${review.wait_minutes_p50 ?? "-"}/${review.wait_minutes_p90 ?? "-"} minutes`,
      `- Review-toll candidates: ${review.review_toll_candidate_count}`,
      "",
      "| Stage | Approval | Prerequisite | Wait min | Classification |",
      "| --- | --- | --- | ---: | --- |",
      ...review.waits.map((row) => `| ${row.stage} | ${row.approval_type} | ${row.prerequisite_stage} | ${row.wait_minutes} | ${row.review_toll_class} |`),
      "",
    );
  }
  if (report.image_provider_attempts) {
    lines.push(
      "## Image Providers",
      "",
      "| Provider | Attempts | Failures | Failure rate |",
      "| --- | ---: | ---: | ---: |",
      ...report.image_provider_attempts.providers.map((row) => `| ${row.provider} | ${row.attempt_count} | ${row.failure_count} | ${row.failure_rate_percent}% |`),
      "",
    );
  }
  if (report.provider_task_telemetry?.task_classes?.length) {
    lines.push(
      "## Provider And Task-Class Telemetry",
      "",
      "| Provider | Task | Attempts | First-pass accept | Repair | Queue p50/p90 | Service p50/p90 | Limits | Peak |",
      "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...report.provider_task_telemetry.task_classes.map((row) => (
        `| ${row.provider} | ${row.task_class} | ${row.creative_attempt_count} | ${row.first_pass_acceptance_rate_percent}% | ${row.exact_repair_rate_percent}% | ${row.queue_wait_ms.p50 ?? "-"}/${row.queue_wait_ms.p90 ?? "-"} ms | ${row.service_ms.p50 ?? "-"}/${row.service_ms.p90 ?? "-"} ms | ${row.rate_or_quota_limit_count} | ${row.peak_observed_concurrency} |`
      )),
      "",
    );
  }
  if (report.planner_adaptive_eligibility) {
    const eligibility = report.planner_adaptive_eligibility;
    lines.push(
      "## Planner Adaptive Eligibility",
      "",
      "| Planner | Samples | Fail rate | Service p50/p90 | Control signal | Disposition |",
      "| --- | ---: | ---: | ---: | --- | --- |",
      ...Object.entries(eligibility.stages).map(([stage, row]) => (
        `| ${stage} | ${row.sample_count} | ${row.failure_rate == null ? "-" : Number(row.failure_rate * 100).toFixed(1)}% | ${row.service_ms_p50 ?? "-"}/${row.service_ms_p90 ?? "-"} ms | ${row.useful_control_signal ? "yes" : "no"} | ${row.disposition} |`
      )),
      "",
    );
  }
  if (report.production_forecast) {
    const forecast = report.production_forecast;
    lines.push(
      "## Episode-Size Forecast",
      "",
      `- Policy: ${forecast.policy}`,
      `- Automated p50: ${forecast.forecast.automated_p50_minutes} minutes`,
      `- Automated p90: ${forecast.forecast.automated_p90_minutes} minutes`,
      `- Operator p50: ${forecast.forecast.operator_p50_minutes} minutes`,
      `- Total p50: ${forecast.forecast.total_p50_minutes} minutes`,
      `- Total p90: ${forecast.forecast.total_p90_minutes} minutes`,
      `- Stretch target: ${forecast.forecast.stretch_target_minutes ?? "none"} minutes`,
      "",
      "| Workstream | p50 min | p90 min | Basis |",
      "| --- | ---: | ---: | --- |",
      ...forecast.workstreams.map((row) => `| ${row.id} | ${row.p50_minutes} | ${row.p90_minutes} | ${row.basis} |`),
      "",
    );
  }
  if (report.reference_roi) {
    lines.push(
      "## Reference ROI",
      "",
      `- Status: ${report.reference_roi.status}`,
      `- Selected assets: ${report.reference_roi.summary?.selected_asset_count ?? "not ready"}`,
      `- Zero-attachment generated references: ${report.reference_roi.summary?.zero_attachment_reference_count ?? "not ready"}`,
      `- Detailed report: ${report.reference_roi.markdown_path}`,
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}
