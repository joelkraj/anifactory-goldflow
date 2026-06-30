const META_PATTERNS = [
  {
    code: "viewer_anticipation_meta",
    pattern: /\bviewer anticipation(?:\s+\w+)?\b/i,
    reason: "Viewer-retention analysis leaked into narration prose.",
  },
  {
    code: "hook_meta_line",
    pattern: /\b(?:that was the hook|the first hook was|hook\s+(?:verified|established|complete))\b/i,
    reason: "Hook-analysis language leaked into story narration.",
  },
  {
    code: "opening_retention_meta",
    pattern: /\bopening retention\b/i,
    reason: "Retention analytics language leaked into narration prose.",
  },
  {
    code: "title_score_meta",
    pattern: /\btitle score\b/i,
    reason: "Packaging-analysis language leaked into narration prose.",
  },
  {
    code: "click_driver_meta",
    pattern: /\bclick driver\b/i,
    reason: "CTR/packaging analysis leaked into narration prose.",
  },
  {
    code: "retention_promise_meta",
    pattern: /\bretention promise\b/i,
    reason: "Audience-retention planning language leaked into narration prose.",
  },
  {
    code: "comment_bait_meta",
    pattern: /\bcomment bait\b/i,
    reason: "Upload-packaging language leaked into narration prose.",
  },
  {
    code: "retention_battle_meta",
    pattern: /\bretention battle\b/i,
    reason: "Retention-planning language leaked into narration prose.",
  },
  {
    code: "anticipation_loop_meta",
    pattern: /\bcreate anticipation loop\b/i,
    reason: "Writer-planning instruction leaked into narration prose.",
  },
  {
    code: "strong_opening_required_meta",
    pattern: /\bstrong opening required\b/i,
    reason: "Script-development note leaked into narration prose.",
  },
  {
    code: "ctr_meta",
    pattern: /\bCTR\b/,
    reason: "CTR analytics language leaked into narration prose.",
  },
  {
    code: "retention_graph_meta",
    pattern: /\bretention graphs?\b/i,
    reason: "Analytics-dashboard language leaked into narration prose.",
  },
  {
    code: "audience_retention_meta",
    pattern: /\baudience retention\b/i,
    reason: "Audience-retention analytics language leaked into narration prose.",
  },
  {
    code: "retention_metric_meta",
    pattern: /\b(?:final average retention|retention\s*:\s*\d+(?:\.\d+)?%?)\b/i,
    reason: "Retention metric leaked into narration prose.",
  },
  {
    code: "roll_credits_meta",
    pattern: /\broll credits\b/i,
    reason: "Screenplay/editing shorthand leaked into narration prose.",
  },
];

export function lineNumberForIndex(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

export function excerptAround(text, index, length, radius = 90) {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

export function scanScriptMetaContamination(script) {
  const blockers = [];
  for (const row of META_PATTERNS) {
    const pattern = new RegExp(row.pattern.source, row.pattern.flags.includes("g") ? row.pattern.flags : `${row.pattern.flags}g`);
    for (const match of script.matchAll(pattern)) {
      blockers.push({
        code: row.code,
        line: lineNumberForIndex(script, match.index ?? 0),
        match: match[0],
        excerpt: excerptAround(script, match.index ?? 0, match[0].length),
        reason: row.reason,
      });
    }
  }
  blockers.sort((a, b) => a.line - b.line || a.code.localeCompare(b.code));
  return {
    schema: "goldflow_script_meta_contamination_scan_v1",
    status: blockers.length ? "blocked" : "passed",
    blocker_count: blockers.length,
    blockers,
  };
}
