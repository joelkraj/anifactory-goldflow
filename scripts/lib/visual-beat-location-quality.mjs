// Location-dependent diagnostics extracted from the visual beat planner for exact repair recalculation.
function normalizeComparable(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function locationMentionPhrases(text) {
  const source = String(text ?? "");
  const phrases = [];
  const venueNouns = "Hall|Room|Stage|Lobby|Campus|Arena|Court|Boardroom|Office|Dorm|Apartment|Kitchen|Elevator|Tower|District|Station|Gym|Street|Floor|Hallway|Corridor|Courtyard|Temple|Palace|Library|Classroom|Studio|Theater|Restaurant|Cafe|Hospital|Bank|Store|Market|Platform|Roof|Basement|Warehouse|Server";
  const properVenuePattern = new RegExp(`\\b([A-Z][\\p{L}\\p{N}'’-]*(?:\\s+[A-Z][\\p{L}\\p{N}'’-]*){0,3}\\s+(?:${venueNouns}))\\b`, "gu");
  for (const match of source.matchAll(properVenuePattern)) phrases.push(match[1]);
  const stop = "(?!(?:a|an|and|as|at|box|for|frame|from|gifts|his|her|in|inside|into|my|next|of|on|open|our|report|same|the|their|to|whole|with|your)\\b)";
  const commonVenuePattern = new RegExp(`\\b(?:the\\s+)?((?:${stop}[a-z][\\p{L}\\p{N}'’-]*\\s+){1,3}(?:${venueNouns.toLowerCase().replaceAll("|", "|")}))\\b`, "giu");
  for (const match of source.matchAll(commonVenuePattern)) phrases.push(match[1]);
  const genericMovementPattern = /\b(?:entered|arrived at|walked into|stepped into|crossed into|moved into|went into|inside|through|toward)\s+(?:the\s+)?(hall|room|stage|lobby|campus|arena|court|boardroom|office|dorm|apartment|kitchen|elevator|tower|district|station|gym|street|floor|hallway|corridor|courtyard|temple|palace|library|classroom|studio|theater|restaurant|cafe|hospital|bank|store|market|platform|roof|basement|warehouse|server)\b/giu;
  for (const match of source.matchAll(genericMovementPattern)) phrases.push(match[1]);
  return [...new Set(phrases.map((phrase) => phrase.trim()).filter(Boolean))];
}

function locationMentionCoverageFindings(beats) {
  const findings = [];
  for (const beat of beats) {
    const beatLocation = beat.local_location ?? beat.location ?? beat.location_timeline_label ?? "";
    const location = normalizeComparable(beatLocation);
    if (!location) continue;
    for (const phrase of locationMentionPhrases(beat.visual_beat_script_excerpt)) {
      const normalizedPhrase = normalizeComparable(phrase);
      const tokens = normalizedPhrase.split(/\s+/).filter((token) => token.length > 2);
      const matchingTokens = tokens.filter((token) => location.split(/\s+/).includes(token));
      const covered = normalizedPhrase && (
        location.includes(normalizedPhrase)
        || normalizedPhrase.includes(location)
        || (tokens.length > 0 && matchingTokens.length >= Math.min(2, tokens.length))
      );
      if (!covered) {
        findings.push({
          code: "location_mention_not_in_beat_location",
          severity: "warning",
          scene_id: beat.parent_scene_id ?? beat.scene_id,
          visual_beat_id: beat.visual_beat_id,
          mentioned_location: phrase,
          beat_location: beatLocation || null,
          message: `Beat excerpt names ${phrase}, but the beat location is ${beatLocation || "(missing)"}.`,
        });
      }
    }
  }
  return findings;
}

function repeatedBeatJobFindings(beats, {
  maxConsecutiveSameLocationJob = 3,
  retentionEndSec = 180,
} = {}) {
  const ordered = [...beats].sort((a, b) => Number(a.start_sec ?? 0) - Number(b.start_sec ?? 0));
  const findings = [];
  let current = null;
  for (const beat of ordered) {
    const start = Number(beat.start_sec ?? 0);
    if (start >= retentionEndSec) {
      if (current && current.count > maxConsecutiveSameLocationJob) findings.push(current);
      current = null;
      continue;
    }
    const location = normalizeComparable(beat.local_location ?? beat.location ?? "none") || "none";
    const job = String(beat.visual_job ?? "none");
    const key = `${location}|${job}`;
    if (!current || current.key !== key) {
      if (current && current.count > maxConsecutiveSameLocationJob) findings.push(current);
      current = {
        code: "repeated_location_visual_job_run",
        severity: "warning",
        key,
        location: beat.local_location ?? beat.location ?? null,
        visual_job: job,
        start_sec: beat.start_sec,
        end_sec: beat.end_sec,
        count: 1,
        first_visual_beat_id: beat.visual_beat_id,
        last_visual_beat_id: beat.visual_beat_id,
        message: "",
      };
    } else {
      current.count += 1;
      current.end_sec = beat.end_sec;
      current.last_visual_beat_id = beat.visual_beat_id;
    }
  }
  if (current && current.count > maxConsecutiveSameLocationJob) findings.push(current);
  return findings.map((finding) => ({
    ...finding,
    message: `Repeated ${finding.visual_job} beats in ${finding.location ?? "unknown location"} for ${finding.count} consecutive cuts.`,
  }));
}

function longSameLocationBeatFindings(beats, {
  maxSameLocationSpanSec = 150,
  retentionStartSec = 180,
} = {}) {
  const ordered = [...beats].sort((a, b) => Number(a.start_sec ?? 0) - Number(b.start_sec ?? 0));
  const findings = [];
  let current = null;
  for (const beat of ordered) {
    const location = normalizeComparable(beat.local_location ?? beat.location ?? "none") || "none";
    if (!current || current.location_key !== location) {
      if (current) findings.push(current);
      current = {
        code: "long_same_location_beat_span",
        severity: "warning",
        location_key: location,
        location: beat.local_location ?? beat.location ?? null,
        start_sec: Number(beat.start_sec ?? 0),
        end_sec: Number(beat.end_sec ?? beat.start_sec ?? 0),
        count: 1,
        first_visual_beat_id: beat.visual_beat_id,
        last_visual_beat_id: beat.visual_beat_id,
      };
    } else {
      current.end_sec = Number(beat.end_sec ?? current.end_sec);
      current.count += 1;
      current.last_visual_beat_id = beat.visual_beat_id;
    }
  }
  if (current) findings.push(current);
  return findings
    .filter((span) => {
      if (span.location_key === "none") return false;
      const measuredStart = Math.max(span.start_sec, retentionStartSec);
      return span.end_sec > measuredStart && span.end_sec - measuredStart > maxSameLocationSpanSec && span.count >= 8;
    })
    .map((span) => ({
      ...span,
      measured_after_retention_start_sec: Number((span.end_sec - Math.max(span.start_sec, retentionStartSec)).toFixed(3)),
      message: `Beat plan holds ${span.location ?? "one location"} for ${span.count} cuts and ${Number(span.end_sec - Math.max(span.start_sec, retentionStartSec)).toFixed(1)}s after the retention runway.`,
    }));
}

export function locationDependentQualityFindings(beats, retentionRampSec = 180) {
  return [
    ...locationMentionCoverageFindings(beats),
    ...repeatedBeatJobFindings(beats, { retentionEndSec: retentionRampSec }),
    ...longSameLocationBeatFindings(beats, { retentionStartSec: retentionRampSec }),
  ];
}
