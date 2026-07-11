function normalizedTokens(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

function timedWordTokens(words) {
  const tokens = [];
  for (const word of words ?? []) {
    const startSec = Number(word?.start_sec ?? word?.start ?? 0);
    for (const token of normalizedTokens(word?.word ?? word?.text ?? "")) {
      tokens.push({ token, start_sec: startSec });
    }
  }
  return tokens;
}

function lowerBoundByTime(tokens, timeSec) {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (Number(tokens[mid]?.start_sec ?? 0) < timeSec) low = mid + 1;
    else high = mid;
  }
  return low;
}

function lcsLength(left, right) {
  const previous = new Uint16Array(right.length + 1);
  const current = new Uint16Array(right.length + 1);
  for (let i = 1; i <= left.length; i += 1) {
    current.fill(0);
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = left[i - 1] === right[j - 1]
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1]);
    }
    previous.set(current);
  }
  return previous[right.length];
}

function bestExcerptMatch(row, tokens, {
  textField,
  startField,
  searchWindowSec,
  targetTokenLimit,
} = {}) {
  const target = normalizedTokens(row?.[textField] ?? "").slice(0, targetTokenLimit);
  if (target.length < 4 || !tokens.length) return null;
  const expected = Number(row?.[startField] ?? 0);
  const low = lowerBoundByTime(tokens, Math.max(0, expected - searchWindowSec));
  const high = lowerBoundByTime(tokens, expected + searchWindowSec);
  let best = null;
  for (let index = low; index <= Math.max(low, high - target.length); index += 1) {
    const candidate = tokens.slice(index, index + target.length).map((entry) => entry.token);
    if (candidate.length !== target.length) continue;
    const score = lcsLength(target, candidate) / target.length;
    const distanceSec = Math.abs(Number(tokens[index]?.start_sec ?? expected) - expected);
    if (!best || score > best.score || (score === best.score && distanceSec < best.distance_sec)) {
      best = {
        score: Number(score.toFixed(6)),
        token_index: index,
        start_sec: Number(tokens[index].start_sec),
        distance_sec: Number(distanceSec.toFixed(3)),
      };
    }
  }
  return best;
}

function interpolateUnmatchedStarts(rows, matches, startField) {
  const starts = rows.map((row) => Number(row?.[startField] ?? 0));
  const anchors = matches
    .map((match, index) => match?.accepted ? { index, old: starts[index], next: match.start_sec } : null)
    .filter(Boolean);
  if (!anchors.length) return starts;
  const output = [...starts];
  for (let index = 0; index < rows.length; index += 1) {
    if (matches[index]?.accepted) {
      output[index] = matches[index].start_sec;
      continue;
    }
    const previous = [...anchors].reverse().find((anchor) => anchor.index < index) ?? null;
    const next = anchors.find((anchor) => anchor.index > index) ?? null;
    if (previous && next && next.old > previous.old) {
      const ratio = (starts[index] - previous.old) / (next.old - previous.old);
      output[index] = previous.next + ratio * (next.next - previous.next);
    } else if (previous) {
      output[index] = starts[index] + (previous.next - previous.old);
    } else if (next) {
      output[index] = starts[index] + (next.next - next.old);
    }
  }
  return output;
}

export function alignExcerptRowsToWhisper(rows, words, {
  textField = "visual_beat_script_excerpt",
  startField = "start_sec",
  endField = "end_sec",
  durationField = "duration_sec",
  searchWindowSec = 30,
  targetTokenLimit = 14,
  minimumScore = 0.78,
  minimumGapSec = 0.2,
} = {}) {
  const tokens = timedWordTokens(words);
  const matches = rows.map((row) => {
    const match = bestExcerptMatch(row, tokens, { textField, startField, searchWindowSec, targetTokenLimit });
    return match ? { ...match, accepted: match.score >= minimumScore } : { accepted: false, score: 0 };
  });
  const proposed = interpolateUnmatchedStarts(rows, matches, startField);
  const starts = [];
  for (let index = 0; index < proposed.length; index += 1) {
    const floor = index === 0 ? 0 : starts[index - 1] + minimumGapSec;
    starts.push(Number(Math.max(floor, proposed[index]).toFixed(3)));
  }
  const alignedRows = rows.map((row, index) => {
    const nextStart = index + 1 < starts.length ? starts[index + 1] : null;
    const oldStart = Number(row?.[startField] ?? 0);
    const oldEnd = Number(row?.[endField] ?? (oldStart + Number(row?.[durationField] ?? 0)));
    const endSec = nextStart ?? Math.max(starts[index] + minimumGapSec, oldEnd + (starts[index] - oldStart));
    return {
      ...row,
      [startField]: starts[index],
      [endField]: Number(endSec.toFixed(3)),
      [durationField]: Number(Math.max(minimumGapSec, endSec - starts[index]).toFixed(3)),
      whisper_excerpt_alignment: {
        status: matches[index]?.accepted ? "matched" : "interpolated_unspoken_or_low_confidence",
        score: matches[index]?.score ?? 0,
        previous_start_sec: oldStart,
        aligned_start_sec: starts[index],
        offset_sec: Number((starts[index] - oldStart).toFixed(3)),
      },
    };
  });
  return {
    rows: alignedRows,
    summary: {
      row_count: rows.length,
      matched_count: matches.filter((match) => match.accepted).length,
      interpolated_count: matches.filter((match) => !match.accepted).length,
      minimum_score: minimumScore,
      search_window_sec: searchWindowSec,
      max_absolute_offset_sec: Number(Math.max(0, ...alignedRows.map((row, index) => Math.abs(Number(row[startField]) - Number(rows[index]?.[startField] ?? 0)))).toFixed(3)),
    },
  };
}

