/** Local subtitle parsing and lexical lookup; never calls an AI or provider API. */
export const MAX_SUBTITLE_BYTES = 10 * 1024 * 1024;
export const MAX_SUBTITLE_CUES = 100_000;
const MAX_CUE_TEXT_BYTES = 64 * 1024;
const MAX_QUERY_BYTES = 4096;

function subtitleError(line, message) {
  return new Error(`Subtitle line ${line}: ${message}`);
}

function subtitleText(input) {
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > MAX_SUBTITLE_BYTES) {
      throw new Error(`Subtitle input exceeds ${MAX_SUBTITLE_BYTES} bytes (10 MiB).`);
    }
    if (input.includes("\0")) throw new Error("Subtitle input contains NUL bytes; convert the file to UTF-8 first.");
    return input;
  }
  if (input instanceof Uint8Array) {
    if (input.byteLength > MAX_SUBTITLE_BYTES) {
      throw new Error(`Subtitle input exceeds ${MAX_SUBTITLE_BYTES} bytes (10 MiB).`);
    }
    let decoded;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(input);
    } catch {
      throw new Error("Subtitle input must be valid UTF-8; convert the file to UTF-8 first.");
    }
    return subtitleText(decoded);
  }
  throw new TypeError("Subtitle input must be a UTF-8 string or Uint8Array.");
}

function timestampSeconds(value, format, line) {
  const match = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)([.,])(\d{3})$/.exec(value);
  if (!match || (format === "srt" && match[1] === undefined) || (format === "vtt" && match[4] !== ".")) {
    throw subtitleError(line, `invalid ${format.toUpperCase()} timestamp; expected ${format === "srt" ? "HH:MM:SS,mmm" : "[HH:]MM:SS.mmm"}.`);
  }
  const milliseconds = ((Number(match[1] || 0) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 + Number(match[5]);
  if (!Number.isSafeInteger(milliseconds)) throw subtitleError(line, "timestamp is outside the supported numeric range.");
  return milliseconds / 1000;
}

const ENTITIES = Object.freeze({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", lrm: "\u200e", rlm: "\u200f" });

function cuePlainText(value) {
  // Strip display syntax before decoding entities, so literal &lt;b&gt; stays text.
  // This is plain text, not trusted HTML: a UI must still escape it when rendering.
  const plain = value
    .replace(/<!--[^]*?-->/g, "")
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<\/?(?:b|i|u|s|strike|font|c|v|lang|ruby|rt)(?=[\s.>])[^>]*>/gi, "")
    .replace(/<(?:\d{2,}:)?[0-5]\d:[0-5]\d\.\d{3}>/g, "")
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/&(#(?:x[0-9a-f]+|\d+)|amp|lt|gt|quot|apos|nbsp|lrm|rlm);/gi, (whole, entity) => {
      if (!entity.startsWith("#")) return ENTITIES[entity.toLowerCase()] ?? whole;
      const hex = entity[1]?.toLowerCase() === "x";
      const codePoint = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return whole;
      return String.fromCodePoint(codePoint);
    });
  return plain.replace(/\s+/gu, " ").trim();
}

/**
 * Parse UTF-8 SRT/WebVTT into cue_000001-style references in source file order.
 * Source labels are intentionally not IDs: they may be missing or duplicated.
 * Each row is {id, start_sec, end_sec, text}; no synchronization is inferred.
 */
export function parseSubtitles(input, { format = "auto" } = {}) {
  if (typeof format !== "string") throw new TypeError("Subtitle format must be auto, srt, or vtt.");
  const requestedFormat = format.toLowerCase() === "webvtt" ? "vtt" : format.toLowerCase();
  if (!["auto", "srt", "vtt"].includes(requestedFormat)) throw new Error("Subtitle format must be auto, srt, or vtt.");
  const text = subtitleText(input).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  let cursor = 0;
  while (cursor < lines.length && !lines[cursor].trim()) cursor += 1;
  const hasVttHeader = /^WEBVTT(?:[ \t]|$)/.test(lines[cursor] || "");
  const resolvedFormat = requestedFormat === "auto" ? (hasVttHeader ? "vtt" : "srt") : requestedFormat;
  if (resolvedFormat === "srt" && hasVttHeader) throw subtitleError(cursor + 1, "WEBVTT header conflicts with requested SRT format.");
  if (resolvedFormat === "vtt") {
    if (!hasVttHeader) throw subtitleError(cursor + 1, "WebVTT requires a WEBVTT header.");
    while (cursor < lines.length && lines[cursor].trim()) {
      if (lines[cursor].includes("-->")) throw subtitleError(cursor + 1, "a blank line must separate the WebVTT header from its first cue.");
      cursor += 1;
    }
  }
  const cues = [];
  while (cursor < lines.length) {
    while (cursor < lines.length && !lines[cursor].trim()) cursor += 1;
    if (cursor >= lines.length) break;
    const blockStart = cursor;
    while (cursor < lines.length && lines[cursor].trim()) cursor += 1;
    const block = lines.slice(blockStart, cursor);
    if (resolvedFormat === "vtt" && /^(?:NOTE(?:[ \t]|$)|STYLE$|REGION$)/.test(block[0].trim())) continue;

    const timingIndex = block[0].includes("-->") ? 0 : 1;
    const timingLineNumber = blockStart + timingIndex + 1;
    const timing = /^\s*(\S+)\s+-->\s+(\S+)(?:[ \t]+(.+?))?\s*$/.exec(block[timingIndex] || "");
    if (!timing) throw subtitleError(Math.min(timingLineNumber, blockStart + block.length), "expected a timestamp range (start --> end), optionally after a cue identifier.");
    if (timing[3] && !timing[3].split(/[ \t]+/).every((setting) => /^[^:\s]+:[^\s]+$/.test(setting))) {
      throw subtitleError(timingLineNumber, "invalid trailing cue settings; expected name:value settings.");
    }
    const startSec = timestampSeconds(timing[1], resolvedFormat, timingLineNumber);
    const endSec = timestampSeconds(timing[2], resolvedFormat, timingLineNumber);
    if (endSec <= startSec) throw subtitleError(timingLineNumber, "cue end must be after its start.");
    const bodyLines = block.slice(timingIndex + 1);
    const extraTiming = bodyLines.findIndex((line) => /^\s*\d+:\d[^]*\s+--?>/.test(line));
    if (extraTiming >= 0) throw subtitleError(timingLineNumber + extraTiming + 1, "a blank line must separate subtitle cues.");
    const body = bodyLines.join("\n");
    if (Buffer.byteLength(body, "utf8") > MAX_CUE_TEXT_BYTES) throw subtitleError(timingLineNumber + 1, "cue text exceeds 64 KiB.");
    const plainText = cuePlainText(body);
    if (!plainText) throw subtitleError(timingLineNumber + 1, "cue has no display text.");
    if (cues.length >= MAX_SUBTITLE_CUES) throw subtitleError(timingLineNumber, `subtitle exceeds ${MAX_SUBTITLE_CUES} cues.`);
    cues.push({ id: `cue_${String(cues.length + 1).padStart(6, "0")}`, start_sec: startSec, end_sec: endSec, text: plainText });
  }
  if (!cues.length) throw new Error("No timed subtitle cues found; supply a non-empty UTF-8 SRT or WebVTT file.");
  return cues;
}

function normalizedWords(value) {
  return value.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Lexical candidates, not visual-scene detection. Phrase matches rank first.
 * Explicit synchronization is effectiveTime = sourceTime * scale + offsetSec.
 * Cues shifted before zero are omitted rather than silently clamped.
 */
export function searchSubtitles(cues, query, { limit = 10, offsetSec = 0, scale = 1 } = {}) {
  if (!Array.isArray(cues) || cues.length > MAX_SUBTITLE_CUES) throw new TypeError(`Subtitle cues must be an array of at most ${MAX_SUBTITLE_CUES} rows.`);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError("Subtitle search limit must be an integer from 1 to 1000.");
  if (!Number.isFinite(offsetSec)) throw new RangeError("Subtitle offsetSec must be finite.");
  if (!Number.isFinite(scale) || scale <= 0) throw new RangeError("Subtitle scale must be finite and greater than zero.");
  if (typeof query !== "string" || Buffer.byteLength(query, "utf8") > MAX_QUERY_BYTES) throw new TypeError(`Subtitle query must be a string of at most ${MAX_QUERY_BYTES} bytes.`);
  const normalizedQuery = normalizedWords(query);
  if (!normalizedQuery) throw new Error("Subtitle query must contain at least one letter or number.");
  const terms = new Set(normalizedQuery.split(" "));
  if (terms.size > 64) throw new Error("Subtitle query must contain at most 64 distinct terms.");
  const cueIds = new Set();
  let textBytes = 0;
  const candidates = [];
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index];
    if (!cue || typeof cue.id !== "string" || !cue.id.trim() || cueIds.has(cue.id) || typeof cue.text !== "string" || !cue.text.trim()
      || !Number.isFinite(cue.start_sec) || cue.start_sec < 0 || !Number.isFinite(cue.end_sec) || cue.end_sec <= cue.start_sec) {
      throw new Error(`Invalid subtitle cue at index ${index}; unique id, text, and finite ordered nonnegative times are required.`);
    }
    cueIds.add(cue.id);
    const cueBytes = Buffer.byteLength(cue.text, "utf8");
    textBytes += cueBytes;
    if (cueBytes > MAX_CUE_TEXT_BYTES || textBytes > MAX_SUBTITLE_BYTES) throw new Error("Subtitle cue text exceeds the supported input limits.");
    const startSec = cue.start_sec * scale + offsetSec;
    const endSec = cue.end_sec * scale + offsetSec;
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) throw new RangeError(`Synchronization produces invalid timestamps for cue ${cue.id}.`);
    if (startSec < 0) continue;
    const normalizedText = normalizedWords(cue.text);
    const cueTerms = new Set(normalizedText.split(" "));
    const matchedCount = [...terms].filter((term) => cueTerms.has(term)).length;
    if (!matchedCount) continue;
    const phraseMatch = ` ${normalizedText} `.includes(` ${normalizedQuery} `);
    const score = (phraseMatch ? 100 : 0) + (normalizedText === normalizedQuery ? 10 : 0) + Math.round((matchedCount / terms.size) * 1000) / 100;
    candidates.push({ cue_id: cue.id, start_sec: startSec, end_sec: endSec, text: cue.text, score, source_index: index });
  }
  return candidates.sort((a, b) => b.score - a.score || a.start_sec - b.start_sec || a.source_index - b.source_index)
    .slice(0, limit).map(({ source_index: _index, ...candidate }) => candidate);
}
