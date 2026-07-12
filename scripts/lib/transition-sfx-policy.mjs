const FAMILY_POLICIES = Object.freeze({
  none: {
    description: "No transition accent; let narration and picture carry the boundary.",
    cue_ids: [],
  },
  swipe_up: {
    description: "Bright upward sweep for escalation, status rise, or a panel entering upward.",
    cue_ids: ["hook_swipe_up_flash", "swipe_up_flash"],
    match_terms: ["swipe up", "upward sweep", "rise whoosh"],
    asset_trim_start_sec: 0,
    sfx_offset_sec: -0.35,
    duration_sec: 0.75,
    fade_out_sec: 0.12,
    hook_gain_db: -16,
    later_gain_db: -21,
  },
  swipe_down: {
    description: "Downward whoosh for impact, defeat, descent, or a panel dropping into place.",
    cue_ids: ["hook_swipe_down_whoosh", "swipe_down_whoosh"],
    match_terms: ["swipe down", "downward whoosh", "drop whoosh"],
    asset_trim_start_sec: 0.55,
    sfx_offset_sec: -0.25,
    duration_sec: 0.75,
    fade_out_sec: 0.12,
    hook_gain_db: -16,
    later_gain_db: -21,
  },
  lateral_whoosh: {
    description: "Clean side-to-side editorial sweep for lateral slides, covers, and scene moves.",
    cue_ids: ["hard_scene_card_whoosh", "hook_hard_scene_card_whoosh"],
    match_terms: ["scene card whoosh", "lateral whoosh", "side sweep"],
    asset_trim_start_sec: 0.82,
    sfx_offset_sec: -0.25,
    duration_sec: 0.66,
    fade_out_sec: 0.14,
    hook_gain_db: -17,
    later_gain_db: -22,
  },
  manga_snap: {
    description: "Short paper-panel snap for hard editorial cuts, manga panels, and title-card punctuation.",
    cue_ids: ["hook_scene_card_snap", "dark_paper_title_snap"],
    match_terms: ["scene card snap", "paper title snap", "manga snap"],
    asset_trim_start_sec: 0,
    sfx_offset_sec: -0.015,
    duration_sec: 0.42,
    fade_out_sec: 0.08,
    hook_gain_db: -15,
    later_gain_db: -21,
  },
  impact: {
    description: "Compact impact flash with controlled low-end for attacks, reversals, and decisive reveals.",
    cue_ids: ["hook_impact_flash_with_muted_sub_thud", "impact_flash", "impact_flash_soft", "low_reversal_impact"],
    match_terms: ["impact flash", "muted sub thud", "reversal impact"],
    asset_trim_start_sec: 0,
    sfx_offset_sec: -0.015,
    duration_sec: 0.72,
    fade_out_sec: 0.14,
    hook_gain_db: -14,
    later_gain_db: -20,
  },
  system_scan: {
    description: "Clean digital scan or interface sweep for system panels, stats, quests, and UI reveals.",
    cue_ids: ["system_scan_sweep", "screen_scan_zip", "system_ping"],
    match_terms: ["system scan", "screen scan", "interface sweep"],
    asset_trim_start_sec: 0.4,
    sfx_offset_sec: -0.35,
    duration_sec: 0.75,
    fade_out_sec: 0.14,
    hook_gain_db: -17,
    later_gain_db: -22,
  },
  memory_wash: {
    description: "Soft temporal wash for memory, dream, flashback, or disorientation transitions.",
    cue_ids: ["memory_overlay_whoosh", "memory_wash"],
    match_terms: ["memory overlay", "memory wash", "dream whoosh"],
    asset_trim_start_sec: 0.2,
    sfx_offset_sec: -0.3,
    duration_sec: 0.82,
    fade_out_sec: 0.18,
    hook_gain_db: -19,
    later_gain_db: -24,
  },
});

function cueRows(manifest) {
  return Array.isArray(manifest?.cues) ? manifest.cues : Object.values(manifest?.cues ?? {});
}

function availableAsset(cue) {
  return cue?.assets?.find((asset) => asset.asset_id === cue.preferred_asset_id && asset.status === "available" && asset.path)
    ?? [...(cue?.assets ?? [])].reverse().find((asset) => asset?.status === "available" && asset?.path)
    ?? null;
}

function searchableCueText(cue, asset) {
  return [cue?.cue_id, cue?.generation_prompt, ...(cue?.aliases ?? []), asset?.prompt]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function transitionSfxFamilyGuide() {
  return Object.entries(FAMILY_POLICIES).map(([family, policy]) => ({ family, description: policy.description }));
}

export function transitionSfxFamilyNames() {
  return Object.keys(FAMILY_POLICIES);
}

export function resolveTransitionSfxFamily(manifest, requestedFamily, options = {}) {
  const family = String(requestedFamily ?? "none").trim().toLowerCase();
  const policy = FAMILY_POLICIES[family];
  if (!policy || family === "none") return null;
  const rows = cueRows(manifest).map((cue) => ({ cue, asset: availableAsset(cue) })).filter((row) => row.asset);
  let selected = null;
  for (const cueId of policy.cue_ids ?? []) {
    selected = rows.find((row) => String(row.cue.cue_id) === cueId) ?? null;
    if (selected) break;
  }
  if (!selected) {
    selected = rows
      .map((row) => ({
        ...row,
        score: (policy.match_terms ?? []).reduce((score, term) => score + (searchableCueText(row.cue, row.asset).includes(term) ? 1 : 0), 0),
      }))
      .filter((row) => row.score > 0)
      .sort((left, right) => right.score - left.score || String(left.cue.cue_id).localeCompare(String(right.cue.cue_id)))[0] ?? null;
  }
  if (!selected) return null;
  return {
    sfx_family: family,
    cue_id: selected.cue.cue_id,
    asset_id: selected.asset.asset_id ?? null,
    asset_path: selected.asset.path,
    asset_trim_start_sec: Number(policy.asset_trim_start_sec ?? 0),
    sfx_offset_sec: Number(policy.sfx_offset_sec ?? -0.015),
    duration_sec: Number(policy.duration_sec ?? 0.65),
    fade_out_sec: Number(policy.fade_out_sec ?? 0.12),
    gain_db: Number(options.inHook ? policy.hook_gain_db : policy.later_gain_db),
    resolution_source: (policy.cue_ids ?? []).includes(selected.cue.cue_id) ? "preferred_family_cue" : "family_tag_fallback",
  };
}

export function availableTransitionCueById(manifest, cueId) {
  const cue = cueRows(manifest).find((row) => String(row?.cue_id ?? "") === String(cueId ?? ""));
  const asset = availableAsset(cue);
  if (!cue || !asset) return null;
  return {
    cue_id: cue.cue_id,
    asset_id: asset.asset_id ?? null,
    asset_path: asset.path,
  };
}
