// Targeted TTS speakability: shared-lane homograph rules only (no story-specific phrase
// list). Shared by `script targeted` (historical registry row) and the folded script lock
// (registry ≥ 2026-10-20.1). Findings become TTS-only spoken-text replacements; the script
// text itself is never mutated.
export const SCRIPT_SPEAKABILITY_REPORT_SCHEMA = "goldflow_script_speakability_report_v1";
export const TTS_SPOKEN_OVERRIDES_SCHEMA = "goldflow_tts_spoken_overrides_v1";
export const TARGETED_SPEAKABILITY_PROBLEM_AREAS_SCHEMA = "goldflow_targeted_speakability_problem_areas_v1";
export const TARGETED_SPEAKABILITY_RULESET = "shared_lane_homographs_v2";

export function lineNumberForIndex(text, index) {
  return String(text ?? "").slice(0, Math.max(0, index)).split("\n").length;
}

export function excerptAround(text, index, length) {
  const start = Math.max(0, index - 120);
  const end = Math.min(text.length, index + length + 160);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function preserveCase(source, replacement) {
  const text = String(source ?? "");
  if (!text) return replacement;
  return /^[A-Z]/.test(text) ? replacement.charAt(0).toUpperCase() + replacement.slice(1) : replacement;
}

function homographLiveSuggestion(value) {
  const text = String(value ?? "");
  const lower = text.toLowerCase();
  if (lower.startsWith("go live")) return preserveCase(text, "start a livestream");
  if (lower.startsWith("going live")) return preserveCase(text, "starting a livestream");
  if (lower.startsWith("went live")) return preserveCase(text, "started livestreaming");
  if (lower.startsWith("goes live")) return preserveCase(text, "starts livestreaming");
  if (lower.startsWith("is live")) return preserveCase(text, "is livestreaming");
  if (lower.startsWith("was live")) return preserveCase(text, "was livestreaming");
  if (lower.startsWith("were live")) return preserveCase(text, "were livestreaming");
  if (lower.startsWith("be live")) return preserveCase(text, "be livestreaming");
  if (lower.startsWith("being live")) return preserveCase(text, "being on a livestream");
  if (lower.startsWith("stayed live")) return preserveCase(text, "kept livestreaming");
  if (lower.startsWith("stay live")) return preserveCase(text, "keep livestreaming");
  return preserveCase(text, `${text} on stream`);
}

function homographContentSuggestion(value) {
  const text = String(value ?? "");
  const lower = text.toLowerCase();
  if (/\b(?:became|become|becoming)\b/.test(lower)) return text.replace(/\bcontent\b/i, "a clip");
  if (/\binto\b/.test(lower)) return text.replace(/\bcontent\b/i, "a clip");
  if (/\b(?:her|his|their|the)\s+content\b/i.test(text)) return text.replace(/\bcontent\b/i, "stream content");
  return text.replace(/\bcontent\b/i, "video content");
}

const HOMOGRAPH_RULES = [
  {
    code: "tts_homograph_live_stream",
    pattern: /\b(?:go|went|going|goes|is|was|were|be|being|stayed|stay)\s+live\b/gi,
    suggest: homographLiveSuggestion,
    reason: "The word live can be misread as liv instead of live-stream live; use an explicit streaming phrase in TTS spoken text only.",
  },
  {
    code: "tts_homograph_streaming_live",
    pattern: /\bstreaming\s+live\b/gi,
    suggest: (match) => preserveCase(match, "livestreaming"),
    reason: "The phrase streaming live can still make TTS choose the wrong live pronunciation; use livestreaming in TTS spoken text only.",
  },
  {
    code: "tts_homograph_live_stream_noun",
    pattern: /\blive\s+stream\b/gi,
    suggest: (match) => preserveCase(match, "livestream"),
    reason: "The phrase live stream should be collapsed to livestream for stable Qwen pronunciation.",
  },
  {
    code: "tts_homograph_live_content",
    pattern: /\blive\s+content\b/gi,
    suggest: (match) => preserveCase(match, "livestream video content"),
    reason: "The phrase live content can be misread as liv/contented wording; use livestream video content in TTS spoken text only.",
  },
  {
    code: "tts_homograph_stream_content",
    pattern: /\bstream\s+content\b/gi,
    suggest: (match) => preserveCase(match, "stream videos"),
    reason: "The phrase stream content can make TTS choose the adjective content pronunciation; use stream videos in TTS spoken text only.",
  },
  {
    code: "tts_homograph_content_noun",
    pattern: /\b(?:became|become|becoming|is|was|were|are|as|into)\s+(?:her\s+|his\s+|their\s+|the\s+)?content\b/gi,
    suggest: homographContentSuggestion,
    reason: "The noun content can be misread like satisfied/content; use clip, video content, or stream content in TTS spoken text only.",
  },
];

export function targetedFindings(script) {
  const findings = [];
  for (const rule of HOMOGRAPH_RULES) {
    for (const match of script.matchAll(rule.pattern)) {
      findings.push({
        severity: "warning",
        code: rule.code,
        line: lineNumberForIndex(script, match.index ?? 0),
        source_text: match[0],
        suggested_spoken_text: rule.suggest(match[0]),
        excerpt: excerptAround(script, match.index ?? 0, match[0].length),
        reason: rule.reason,
      });
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.source_text.localeCompare(b.source_text));
}

export function replacementsFromFindings(findings) {
  const byContract = new Map();
  for (const finding of findings) {
    const replacement = {
      from: finding.source_text,
      to: finding.suggested_spoken_text,
      regex: false,
      flags: "g",
      scope: "tts_spoken_text",
      reason: finding.reason,
    };
    const key = JSON.stringify([replacement.from, replacement.to, replacement.regex, replacement.flags, replacement.scope]);
    if (!byContract.has(key)) byContract.set(key, replacement);
  }
  return [...byContract.values()];
}

/** The three artifacts `script targeted` writes, built from one script read. */
export function buildTargetedSpeakabilityArtifacts({
  script,
  scriptPath,
  scriptHash,
  channel,
  series,
  week,
  episode,
  archivedReportPath = null,
  archivedOverridesPath = null,
  updatedAt = new Date().toISOString(),
} = {}) {
  const findings = targetedFindings(script);
  const replacements = replacementsFromFindings(findings);
  const report = {
    schema: SCRIPT_SPEAKABILITY_REPORT_SCHEMA,
    status: "passed",
    mode: "targeted_problem_areas_only",
    ruleset: TARGETED_SPEAKABILITY_RULESET,
    channel,
    series_slug: series,
    week,
    episode,
    source_script_hash: scriptHash,
    source_script_path: scriptPath,
    policy: "Targeted TTS-only problem-area replacements. Do not mutate script_clean.md, captions, semantic scenes, or visual prompts. Broad speakability is intentionally skipped.",
    planner: { provider: "deterministic_targeted", model: null, output_path: null },
    deterministic_risk_count: findings.length,
    deterministic_risks: findings,
    summary: `Targeted speakability found ${findings.length} TTS problem-area phrase(s).`,
    warnings: findings,
    pronunciation_map: [],
    pacing_notes: [],
    blocked_story_rewrite_requests: [],
    replacements,
    archived_previous_report_path: archivedReportPath,
    archived_previous_overrides_path: archivedOverridesPath,
    updated_at: updatedAt,
  };
  const overrides = {
    schema: TTS_SPOKEN_OVERRIDES_SCHEMA,
    status: "passed",
    mode: "targeted_problem_areas_only",
    channel,
    series_slug: series,
    week,
    episode,
    source_script_hash: scriptHash,
    source_script_path: scriptPath,
    apply_to: [
      "narration_generation_plan.spoken_text",
      "narration_generation_plan.tts_spoken_text",
      "qwen_generation_plan.qwen_spoken_text",
    ],
    accepted_scope_aliases: ["qwen_spoken_text"],
    script_text_policy: "Do not mutate script_clean.md, captions, semantic scenes, or visual prompts.",
    replacements,
    pronunciation_map: [],
    archived_previous_overrides_path: archivedOverridesPath,
    updated_at: updatedAt,
  };
  const problemReport = {
    schema: TARGETED_SPEAKABILITY_PROBLEM_AREAS_SCHEMA,
    status: "passed",
    scope: "known_problem_areas_only",
    ruleset: TARGETED_SPEAKABILITY_RULESET,
    source_script_hash: scriptHash,
    source_script_path: scriptPath,
    mutated_script: false,
    mutated_tts_overrides: true,
    finding_count: findings.length,
    findings,
    updated_at: updatedAt,
  };
  return { findings, replacements, report, overrides, problemReport };
}
