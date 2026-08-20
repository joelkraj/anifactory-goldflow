function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteDate(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 2) {
  return value == null ? null : Number(Number(value).toFixed(digits));
}

export function telemetryPercentile(values, quantile) {
  const sorted = values
    .map(finiteNumber)
    .filter((value) => value != null)
    .sort((left, right) => left - right);
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const bounded = Math.max(0, Math.min(1, Number(quantile) || 0));
  const position = (sorted.length - 1) * bounded;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + ((sorted[upper] - sorted[lower]) * (position - lower));
}

function accepted(row) {
  return ["passed", "completed", "generated", "accepted"].includes(String(row?.status ?? "").toLowerCase());
}

function finalized(row) {
  return accepted(row) || ["failed", "omitted", "rejected", "needs_triage"].includes(String(row?.status ?? "").toLowerCase());
}

function failureCode(row) {
  return String(row?.failure_code ?? row?.error_code ?? "").trim().toLowerCase();
}

function peakConcurrency(rows) {
  const events = [];
  for (const row of rows) {
    const start = finiteDate(row.started_at);
    const end = finiteDate(row.completed_at);
    if (start == null || end == null || end < start) continue;
    events.push({ at: start, delta: 1 });
    events.push({ at: end, delta: -1 });
  }
  events.sort((left, right) => left.at - right.at || left.delta - right.delta);
  let active = 0;
  let peak = 0;
  for (const event of events) {
    active += event.delta;
    peak = Math.max(peak, active);
  }
  return peak;
}

function metricPercentiles(rows, field) {
  const values = rows.map((row) => finiteNumber(row?.[field])).filter((value) => value != null);
  return {
    sample_count: values.length,
    p50: round(telemetryPercentile(values, 0.50)),
    p90: round(telemetryPercentile(values, 0.90)),
  };
}

function groupKey(row) {
  return `${String(row?.provider ?? "unknown").trim() || "unknown"}::${String(row?.task_class ?? "unknown").trim() || "unknown"}`;
}

export function buildProviderTaskTelemetry(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const key = groupKey(row);
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  const task_classes = [...groups.values()].map((groupRows) => {
    const provider = String(groupRows[0]?.provider ?? "unknown");
    const taskClass = String(groupRows[0]?.task_class ?? "unknown");
    const cacheRows = groupRows.filter((row) => row.reused === true);
    const creativeRows = groupRows.filter((row) => row.reused !== true);
    const finalizedRows = creativeRows.filter(finalized);
    const passedRows = finalizedRows.filter(accepted);
    const failedRows = finalizedRows.filter((row) => !accepted(row));
    const firstPassRows = finalizedRows.filter((row) => Number(row.attempt_number ?? 1) <= 1 && row.exact_repair !== true);
    const firstPassAcceptedRows = firstPassRows.filter(accepted);
    const repairRows = creativeRows.filter((row) => row.exact_repair === true || Number(row.attempt_number ?? 1) > 1);
    const failureCodes = {};
    for (const row of failedRows) {
      const code = failureCode(row) || "unknown";
      failureCodes[code] = Number(failureCodes[code] ?? 0) + 1;
    }
    const codeRows = creativeRows.map((row) => failureCode(row));
    const rateLimitCount = codeRows.filter((code) => /rate|quota|usage|cooldown/.test(code)).length;
    const timeoutCount = codeRows.filter((code) => /timeout|timed_out/.test(code)).length;
    const malformedCount = codeRows.filter((code) => /json|schema|malformed|validation/.test(code)).length;
    const attemptCount = creativeRows.length;
    const percent = (count, denominator = attemptCount) => round(denominator ? count / denominator * 100 : 0);
    return {
      provider,
      task_class: taskClass,
      observation_count: groupRows.length,
      creative_attempt_count: attemptCount,
      cache_reuse_count: cacheRows.length,
      completed_count: finalizedRows.length,
      accepted_count: passedRows.length,
      failed_or_omitted_count: failedRows.length,
      acceptance_rate_percent: percent(passedRows.length, finalizedRows.length),
      first_pass_count: firstPassRows.length,
      first_pass_accepted_count: firstPassAcceptedRows.length,
      first_pass_acceptance_rate_percent: percent(firstPassAcceptedRows.length, firstPassRows.length),
      exact_repair_count: repairRows.length,
      exact_repair_rate_percent: percent(repairRows.length),
      timeout_count: timeoutCount,
      timeout_rate_percent: percent(timeoutCount),
      malformed_output_count: malformedCount,
      malformed_output_rate_percent: percent(malformedCount),
      rate_or_quota_limit_count: rateLimitCount,
      rate_or_quota_limit_rate_percent: percent(rateLimitCount),
      queue_wait_ms: metricPercentiles(creativeRows, "queue_wait_ms"),
      service_ms: metricPercentiles(creativeRows, "service_ms"),
      total_ms: metricPercentiles(creativeRows, "total_ms"),
      peak_observed_concurrency: peakConcurrency(creativeRows),
      quota_units_observed: round(creativeRows.reduce((sum, row) => sum + (finiteNumber(row.quota_units) ?? 0), 0)),
      failure_codes: failureCodes,
    };
  }).sort((left, right) => (
    left.provider.localeCompare(right.provider)
    || left.task_class.localeCompare(right.task_class)
  ));
  return {
    schema: "goldflow_provider_task_telemetry_v1",
    status: "passed",
    generated_at: new Date().toISOString(),
    observation_count: rows.length,
    task_class_count: task_classes.length,
    task_classes,
  };
}
