export function longLocationSpanFindings(prompts, {
  maxSameLocationSpanSec = 150,
  retentionStartSec = 180,
} = {}) {
  const ordered = [...(Array.isArray(prompts) ? prompts : [])]
    .filter((prompt) => Number.isFinite(Number(prompt.start_sec)))
    .sort((a, b) => Number(a.start_sec) - Number(b.start_sec));
  const spans = [];
  let current = null;
  for (const prompt of ordered) {
    const locationId = prompt.shot_manifest?.location_ref_id || "none";
    const start = Number(prompt.start_sec);
    const end = start + Number(prompt.duration_sec ?? 0);
    if (!current || current.locationId !== locationId) {
      if (current) spans.push(current);
      current = { locationId, start, end, count: 1, firstImageId: prompt.image_id, lastImageId: prompt.image_id };
    } else {
      current.end = Math.max(current.end, end);
      current.count += 1;
      current.lastImageId = prompt.image_id;
    }
  }
  if (current) spans.push(current);
  return spans
    .filter((span) => {
      if (span.locationId === "none") return false;
      const measuredStart = Math.max(span.start, retentionStartSec);
      if (span.end <= measuredStart) return false;
      return span.end - measuredStart > maxSameLocationSpanSec && span.count >= 8;
    })
    .map((span) => ({
      ...span,
      measured_after_retention_start_sec: Number((span.end - Math.max(span.start, retentionStartSec)).toFixed(3)),
    }));
}

export function assertLocationSpanVariety(prompts, {
  allowLongLocationSpans = false,
  maxSameLocationSpanSec = 150,
  retentionStartSec = 180,
} = {}) {
  if (allowLongLocationSpans) return;
  const longSpans = longLocationSpanFindings(prompts, { maxSameLocationSpanSec, retentionStartSec });
  if (longSpans.length) {
    throw new Error(`Visual prompt plan has long repeated-location spans:\n${longSpans.slice(0, 20).map((span) => (
      `${span.locationId} ${span.count} cuts ${span.firstImageId}-${span.lastImageId} ${Number(span.start).toFixed(1)}s-${Number(span.end).toFixed(1)}s (${Number(span.measured_after_retention_start_sec).toFixed(1)}s after 3:00)`
    )).join("\n")}`);
  }
}

export function repeatedLocationShotJobFindings(prompts, {
  maxConsecutiveSameLocationShotJob = 3,
  retentionEndSec = 180,
} = {}) {
  const ordered = [...(Array.isArray(prompts) ? prompts : [])]
    .filter((prompt) => Number.isFinite(Number(prompt.start_sec)))
    .sort((a, b) => Number(a.start_sec) - Number(b.start_sec));
  const runs = [];
  let current = null;
  for (const prompt of ordered) {
    const start = Number(prompt.start_sec);
    if (start >= retentionEndSec) {
      if (current) runs.push(current);
      current = null;
      continue;
    }
    const locationId = prompt.shot_manifest?.location_ref_id || "none";
    const shotJob = prompt.shot_manifest?.shot_job || "none";
    const key = `${locationId}|${shotJob}`;
    const end = start + Number(prompt.duration_sec ?? 0);
    if (!current || current.key !== key) {
      if (current) runs.push(current);
      current = { key, locationId, shotJob, start, end, count: 1, firstImageId: prompt.image_id, lastImageId: prompt.image_id };
    } else {
      current.end = Math.max(current.end, end);
      current.count += 1;
      current.lastImageId = prompt.image_id;
    }
  }
  if (current) runs.push(current);
  return runs.filter((run) => (
    run.locationId !== "none"
    && run.shotJob !== "none"
    && run.count > maxConsecutiveSameLocationShotJob
  ));
}

export function assertRetentionShotJobVariety(prompts, {
  allowRepeatedRetentionShotJobs = false,
  maxConsecutiveSameLocationShotJob = 3,
  retentionEndSec = 180,
} = {}) {
  if (allowRepeatedRetentionShotJobs) return;
  const repeatedRuns = repeatedLocationShotJobFindings(prompts, {
    maxConsecutiveSameLocationShotJob,
    retentionEndSec,
  });
  if (repeatedRuns.length) {
    throw new Error(`Visual prompt plan repeats the same location/shot job too long in the retention runway:\n${repeatedRuns.slice(0, 20).map((run) => (
      `${run.locationId}/${run.shotJob} ${run.count} cuts ${run.firstImageId}-${run.lastImageId} ${Number(run.start).toFixed(1)}s-${Number(run.end).toFixed(1)}s`
    )).join("\n")}`);
  }
}
