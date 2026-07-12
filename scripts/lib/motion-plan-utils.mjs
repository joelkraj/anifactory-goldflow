const POSITION_ANCHORS = new Map([
  ["frame-left", { x: 0.3, y: 0.5 }],
  ["frame-right", { x: 0.7, y: 0.5 }],
  ["center", { x: 0.5, y: 0.5 }],
  ["foreground", { x: 0.5, y: 0.58 }],
  ["background-left", { x: 0.3, y: 0.42 }],
  ["background-right", { x: 0.7, y: 0.42 }],
]);

const BEHAVIORS = new Set([
  "static_hold",
  "slow_push_in",
  "reveal_zoom_out",
  "lateral_follow",
  "diagonal_follow",
  "focus_shift",
  "impact_push",
  "reaction_hold",
  "ui_focus",
  "aftermath_reveal",
]);
const EASINGS = new Set(["linear", "ease_in", "ease_out", "ease_in_out"]);
const DEPTH_CONFIDENCE = new Set(["high", "medium", "low"]);
const MIN_KEYFRAMES = 2;
const MAX_KEYFRAMES = 5;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}

function anchor(value, fallback = { x: 0.5, y: 0.5 }) {
  if (!value || !Number.isFinite(Number(value.x)) || !Number.isFinite(Number(value.y))) return { ...fallback };
  return { x: clamp(value.x, 0, 1), y: clamp(value.y, 0, 1) };
}

function validAnchor(value) {
  return value
    && Number.isFinite(Number(value.x))
    && Number.isFinite(Number(value.y))
    && Number(value.x) >= 0
    && Number(value.x) <= 1
    && Number(value.y) >= 0
    && Number(value.y) <= 1;
}

export function sanitizeMotionKeyframes(value) {
  if (!Array.isArray(value) || value.length < MIN_KEYFRAMES || value.length > MAX_KEYFRAMES) return null;
  const rows = value.map((row, index) => {
    const at = Number(row?.at);
    const scale = Number(row?.scale);
    const easingToNext = String(row?.easing_to_next ?? "linear").trim();
    if (!Number.isFinite(at)
      || at < 0
      || at > 1
      || !validAnchor(row?.anchor)
      || !Number.isFinite(scale)
      || scale < 1
      || scale > 1.25
      || !EASINGS.has(easingToNext)) return null;
    if (index > 0 && at <= Number(value[index - 1]?.at)) return null;
    return {
      at,
      anchor: anchor(row.anchor),
      scale,
      easing_to_next: easingToNext,
    };
  });
  if (rows.some((row) => !row) || Math.abs(rows[0].at) > 1e-8 || Math.abs(rows.at(-1).at - 1) > 1e-8) return null;
  return rows;
}

export function sanitizeLayeredParallaxTreatment(value) {
  if (!value || typeof value !== "object" || String(value.mode ?? "") !== "layered_parallax") return null;
  const backgroundKeyframes = sanitizeMotionKeyframes(value.background_keyframes);
  const foregroundKeyframes = sanitizeMotionKeyframes(value.foreground_keyframes);
  const sourceImageSha256 = String(value.source_image_sha256 ?? "").trim().toLowerCase();
  const backgroundPath = String(value.background_path ?? "").trim();
  const foregroundPath = String(value.foreground_path ?? "").trim();
  const backgroundSha256 = String(value.background_sha256 ?? "").trim().toLowerCase();
  const foregroundSha256 = String(value.foreground_sha256 ?? "").trim().toLowerCase();
  const validHash = (hash) => /^[a-f0-9]{64}$/.test(hash);
  if (!backgroundKeyframes
    || !foregroundKeyframes
    || !backgroundPath
    || !foregroundPath
    || !validHash(sourceImageSha256)
    || !validHash(backgroundSha256)
    || !validHash(foregroundSha256)) return null;
  const foregroundCoverSafe = backgroundKeyframes.length === foregroundKeyframes.length
    && backgroundKeyframes.every((background, index) => {
      const foreground = foregroundKeyframes[index];
      return Math.abs(background.at - foreground.at) < 1e-8
        && Math.abs(background.anchor.x - foreground.anchor.x) < 1e-8
        && Math.abs(background.anchor.y - foreground.anchor.y) < 1e-8
        && background.easing_to_next === foreground.easing_to_next
        && foreground.scale >= background.scale;
    });
  if (!foregroundCoverSafe) return null;
  return {
    mode: "layered_parallax",
    occlusion_contract: "foreground_cover",
    source_image_sha256: sourceImageSha256,
    background_path: backgroundPath,
    background_sha256: backgroundSha256,
    foreground_path: foregroundPath,
    foreground_sha256: foregroundSha256,
    background_keyframes: backgroundKeyframes,
    foreground_keyframes: foregroundKeyframes,
  };
}

export function sanitizeDepthCandidate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const eligible = value.eligible === true;
  if (!eligible) {
    return {
      eligible: false,
      priority: 0,
      separation_confidence: "low",
      foreground_subject: null,
      background_plane: null,
      editorial_reason: String(value.editorial_reason ?? "").trim() || null,
    };
  }
  const priority = Number(value.priority);
  const separationConfidence = String(value.separation_confidence ?? "").trim().toLowerCase();
  const foregroundSubject = String(value.foreground_subject ?? "").trim();
  const backgroundPlane = String(value.background_plane ?? "").trim();
  const editorialReason = String(value.editorial_reason ?? "").trim();
  if (!Number.isFinite(priority)
    || priority < 0
    || priority > 100
    || !DEPTH_CONFIDENCE.has(separationConfidence)
    || !foregroundSubject
    || !backgroundPlane
    || !editorialReason) return null;
  return {
    eligible: true,
    priority: Number(priority.toFixed(3)),
    separation_confidence: separationConfidence,
    foreground_subject: foregroundSubject,
    background_plane: backgroundPlane,
    editorial_reason: editorialReason,
  };
}

export function motionKeyframesForIntent(value) {
  const authored = sanitizeMotionKeyframes(value?.motion_keyframes);
  if (authored) return authored;
  if (!validAnchor(value?.start_anchor)
    || !validAnchor(value?.end_anchor)
    || !Number.isFinite(Number(value?.start_scale))
    || !Number.isFinite(Number(value?.end_scale))) return null;
  const easing = EASINGS.has(String(value?.easing ?? "")) ? String(value.easing) : "linear";
  return [
    { at: 0, anchor: anchor(value.start_anchor), scale: Number(value.start_scale), easing_to_next: easing },
    { at: 1, anchor: anchor(value.end_anchor), scale: Number(value.end_scale), easing_to_next: "linear" },
  ];
}

export function sanitizeAuthoredMotionIntent(value) {
  if (!value || typeof value !== "object") return null;
  const behavior = String(value.behavior ?? "").trim();
  const hasKeyframes = value.motion_keyframes !== undefined && value.motion_keyframes !== null;
  const motionKeyframes = hasKeyframes ? sanitizeMotionKeyframes(value.motion_keyframes) : null;
  if (hasKeyframes && !motionKeyframes) return null;
  const firstKeyframe = motionKeyframes?.[0] ?? null;
  const lastKeyframe = motionKeyframes?.at(-1) ?? null;
  const easing = String(value.easing ?? firstKeyframe?.easing_to_next ?? "").trim();
  const startAnchor = firstKeyframe?.anchor ?? value.start_anchor;
  const endAnchor = lastKeyframe?.anchor ?? value.end_anchor;
  const startScale = Number(firstKeyframe?.scale ?? value.start_scale);
  const endScale = Number(lastKeyframe?.scale ?? value.end_scale);
  const hasDepthCandidate = value.depth_candidate !== undefined && value.depth_candidate !== null;
  const depthCandidate = hasDepthCandidate ? sanitizeDepthCandidate(value.depth_candidate) : null;
  const staticRows = motionKeyframes ?? [
    { anchor: startAnchor, scale: startScale },
    { anchor: endAnchor, scale: endScale },
  ];
  const staticContractValid = behavior !== "static_hold" || staticRows.every((row) => (
    Math.abs(Number(row.anchor?.x) - Number(staticRows[0].anchor?.x)) < 1e-8
    && Math.abs(Number(row.anchor?.y) - Number(staticRows[0].anchor?.y)) < 1e-8
    && Math.abs(Number(row.scale) - Number(staticRows[0].scale)) < 1e-8
  ));
  if (!BEHAVIORS.has(behavior)
    || !EASINGS.has(easing)
    || !validAnchor(startAnchor)
    || !validAnchor(endAnchor)
    || !Number.isFinite(startScale)
    || !Number.isFinite(endScale)
    || startScale < 1
    || startScale > 1.25
    || endScale < 1
    || endScale > 1.25
    || !staticContractValid
    || (hasDepthCandidate && !depthCandidate)) return null;
  return {
    behavior,
    focal_subject: String(value.focal_subject ?? "").trim() || null,
    start_anchor: anchor(startAnchor),
    end_anchor: anchor(endAnchor),
    start_scale: startScale,
    end_scale: endScale,
    easing,
    reason: String(value.reason ?? "").trim() || null,
    ...(motionKeyframes ? { motion_keyframes: motionKeyframes } : {}),
    ...(depthCandidate ? { depth_candidate: depthCandidate } : {}),
  };
}

function firstPositionValue(text, candidates, fallback) {
  const matches = candidates
    .map(({ pattern, value }) => ({ match: pattern.exec(text), value }))
    .filter((row) => row.match)
    .sort((left, right) => left.match.index - right.match.index);
  return matches[0]?.value ?? fallback;
}

export function positionAnchorFromStaging(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return { x: 0.5, y: 0.5 };
  const exact = POSITION_ANCHORS.get(text);
  if (exact) return { ...exact };
  const x = firstPositionValue(text, [
    { pattern: /(?:frame[-\s]?left|lower[-\s]?left|upper[-\s]?left|background[-\s]?left|\bleft\b)/, value: 0.3 },
    { pattern: /(?:frame[-\s]?right|lower[-\s]?right|upper[-\s]?right|background[-\s]?right|\bright\b)/, value: 0.7 },
    { pattern: /(?:lower[-\s]?center|upper[-\s]?center|frame[-\s]?center|\bcenter(?:ed)?\b|\bmiddle\b)/, value: 0.5 },
  ], 0.5);
  const y = firstPositionValue(text, [
    { pattern: /(?:\blower\b|\bbottom\b|beneath)/, value: 0.65 },
    { pattern: /(?:\bupper\b|\btop\b|above)/, value: 0.35 },
    { pattern: /(?:\bforeground\b|near plane)/, value: 0.58 },
    { pattern: /(?:\bbackground\b|\brear\b|\bdeep\b|far plane)/, value: 0.42 },
    { pattern: /(?:\bmidground\b|middle plane)/, value: 0.5 },
  ], 0.5);
  return { x, y };
}

export function easingProgress(value, easing = "linear") {
  const t = clamp(value, 0, 1);
  if (easing === "ease_in") return t * t;
  if (easing === "ease_out") return 1 - ((1 - t) * (1 - t));
  if (easing === "ease_in_out") return t * t * t * ((t * ((t * 6) - 15)) + 10);
  return t;
}

function stagingForPrimary(prompt) {
  const manifest = prompt?.shot_manifest ?? {};
  const stages = Array.isArray(manifest.character_staging) ? manifest.character_staging : [];
  const primary = String(manifest.primary_character ?? prompt?.primary_subject ?? stages[0]?.name ?? "").trim();
  const stage = stages.find((row) => String(row?.name ?? "").trim() === primary) ?? stages[0] ?? null;
  return { primary: primary || stage?.name || null, stage, stages };
}

function derivedIntent(prompt) {
  const manifest = prompt?.shot_manifest ?? {};
  const shotJob = String(manifest.shot_job ?? prompt?.suggested_shot_job ?? prompt?.visual_job ?? "").toLowerCase();
  const visualJob = String(prompt?.visual_job ?? "").toLowerCase();
  const { primary, stage, stages } = stagingForPrimary(prompt);
  const focalAnchor = positionAnchorFromStaging(stage?.screen_position);
  const secondaryStage = stages.find((row) => row !== stage) ?? null;
  const secondaryAnchor = positionAnchorFromStaging(secondaryStage?.screen_position);
  const stagedSubjectsSeparated = Boolean(secondaryStage)
    && (Math.abs(secondaryAnchor.x - focalAnchor.x) > 0.12 || Math.abs(secondaryAnchor.y - focalAnchor.y) > 0.12);
  const hasAuthoredFocalIntent = Boolean(stage || manifest.primary_character || prompt?.primary_subject);
  const authoredMotion = sanitizeAuthoredMotionIntent(manifest.motion_intent);
  if (authoredMotion) {
    return {
      ...authoredMotion,
      focal_source: "llm_authored_shot_manifest_motion_intent",
      intent_reason: authoredMotion.reason,
    };
  }
  if (!hasAuthoredFocalIntent && !shotJob) {
    return {
      focal_subject: null,
      focal_source: "missing_intent_static_hold",
      start_anchor: { x: 0.5, y: 0.5 },
      end_anchor: { x: 0.5, y: 0.5 },
      start_scale: 1,
      end_scale: 1,
      easing: "linear",
      behavior: "static_hold",
      intent_reason: "Preserve the full composition because no trustworthy focal movement was authored.",
    };
  }
  if (/establish|location|environment|arrival|transition/.test(shotJob) || /location.transition/.test(visualJob)) {
    return {
      focal_subject: primary,
      focal_source: stage ? "shot_manifest.character_staging" : "shot_manifest.shot_job",
      start_anchor: focalAnchor,
      end_anchor: { x: 0.5, y: 0.5 },
      start_scale: 1.08,
      end_scale: 1,
      easing: "ease_out",
      behavior: "reveal_zoom_out",
      intent_reason: "Expose the authored environment and spatial context.",
    };
  }
  if (/physical.action|(?:^|[^a-z])action(?:[^a-z]|$)|contact|fight|chase|impact|movement/.test(shotJob)) {
    if (stagedSubjectsSeparated) {
      return {
        focal_subject: `${primary ?? "primary subject"} toward ${secondaryStage?.name ?? "impact subject"}`,
        focal_source: "shot_manifest.character_staging_action_pair",
        start_anchor: focalAnchor,
        end_anchor: secondaryAnchor,
        start_scale: 1.015,
        end_scale: 1.07,
        easing: "ease_in_out",
        behavior: Math.abs(secondaryAnchor.y - focalAnchor.y) > 0.08 ? "diagonal_follow" : "lateral_follow",
        intent_reason: "Track the authored action from its primary subject toward the visible impact or opponent.",
      };
    }
    return {
      focal_subject: primary,
      focal_source: stage ? "shot_manifest.character_staging" : "shot_manifest.shot_job",
      start_anchor: { x: 0.5, y: focalAnchor.y },
      end_anchor: focalAnchor,
      start_scale: 1.015,
      end_scale: 1.075,
      easing: "ease_in_out",
      behavior: Math.abs(focalAnchor.x - 0.5) > 0.08 ? "lateral_follow" : "impact_push",
      intent_reason: "Drive toward the authored action focal point without inventing a second target.",
    };
  }
  if (/ui|insert|detail|system|prop/.test(shotJob)) {
    const insertSubject = (manifest.ui_elements ?? [])[0]
      ?? (manifest.visible_props ?? [])[0]
      ?? "authored insert focal point";
    const insertSource = (manifest.ui_elements ?? []).length
      ? "shot_manifest.ui_elements"
      : (manifest.visible_props ?? []).length ? "shot_manifest.visible_props" : "shot_manifest.shot_job";
    return {
      focal_subject: insertSubject,
      focal_source: insertSource,
      start_anchor: { x: 0.5, y: 0.5 },
      end_anchor: { x: 0.5, y: 0.5 },
      start_scale: 1.01,
      end_scale: 1.045,
      easing: "ease_in_out",
      behavior: "ui_focus",
      intent_reason: "Settle attention on the authored UI or prop without over-cropping it.",
    };
  }
  if (/emotional.reaction|reaction/.test(shotJob)) {
    return {
      focal_subject: primary,
      focal_source: stage ? "shot_manifest.character_staging" : "shot_manifest.shot_job",
      start_anchor: focalAnchor,
      end_anchor: focalAnchor,
      start_scale: 1.01,
      end_scale: 1.035,
      easing: "ease_out",
      behavior: "reaction_hold",
      intent_reason: "Hold the authored reaction long enough to read the face and body language.",
    };
  }
  if (/interaction|confront|dialogue|body.state/.test(shotJob) && stagedSubjectsSeparated) {
    return {
      focal_subject: `${secondaryStage?.name ?? "secondary subject"} to ${primary ?? "primary subject"}`,
      focal_source: "shot_manifest.character_staging_pair",
      start_anchor: secondaryAnchor,
      end_anchor: focalAnchor,
      start_scale: 1.02,
      end_scale: 1.06,
      easing: "ease_in_out",
      behavior: "focus_shift",
      intent_reason: "Move attention between the two separately staged subjects.",
    };
  }
  if (/consequence/.test(shotJob) || /consequence/.test(visualJob)) {
    return {
      focal_subject: primary,
      focal_source: stage ? "shot_manifest.character_staging" : "shot_manifest.shot_job",
      start_anchor: focalAnchor,
      end_anchor: { x: 0.5, y: 0.5 },
      start_scale: 1.065,
      end_scale: 1.005,
      easing: "ease_out",
      behavior: "aftermath_reveal",
      intent_reason: "Reveal the authored aftermath around the focal subject.",
    };
  }
  if (/threat|reveal/.test(shotJob) && Math.abs(focalAnchor.x - 0.5) > 0.08) {
    return {
      focal_subject: primary,
      focal_source: stage ? "shot_manifest.character_staging" : "shot_manifest.shot_job",
      start_anchor: { x: 0.5, y: focalAnchor.y },
      end_anchor: focalAnchor,
      start_scale: 1.015,
      end_scale: 1.065,
      easing: "ease_in_out",
      behavior: "focus_shift",
      intent_reason: "Shift from context into the authored off-center threat.",
    };
  }
  return {
    focal_subject: primary,
    focal_source: stage ? "shot_manifest.character_staging" : "shot_manifest.primary_character",
    start_anchor: focalAnchor,
    end_anchor: focalAnchor,
    start_scale: 1.01,
    end_scale: 1.05,
    easing: "ease_in_out",
    behavior: "slow_push_in",
    intent_reason: "Use a restrained push toward the authored primary focal subject.",
  };
}

export function motionIntentForPrompt(prompt, imageSha256, decision = null, options = {}) {
  const base = derivedIntent(prompt);
  const override = decision?.focal_override && typeof decision.focal_override === "object" ? decision.focal_override : null;
  const behavior = BEHAVIORS.has(String(override?.behavior ?? "")) ? String(override.behavior) : base.behavior;
  const easing = EASINGS.has(String(override?.easing ?? "")) ? String(override.easing) : base.easing;
  const overrideKeyframes = sanitizeMotionKeyframes(override?.motion_keyframes);
  const hasSinglePointOverride = Boolean(override)
    && ["start_anchor", "end_anchor", "start_scale", "end_scale", "easing"].some((field) => override[field] !== undefined);
  const selectedKeyframes = overrideKeyframes ?? (!hasSinglePointOverride ? sanitizeMotionKeyframes(base.motion_keyframes) : null);
  const startScale = clamp(selectedKeyframes?.[0]?.scale ?? override?.start_scale ?? base.start_scale, 1, 1.25);
  const endScale = clamp(selectedKeyframes?.at(-1)?.scale ?? override?.end_scale ?? base.end_scale, 1, 1.25);
  const startSec = Number(prompt.start_sec ?? 0);
  const authoredDurationSec = Math.max(1 / 60, Number(prompt.duration_sec ?? 6));
  const timelineEndSec = Number(options.timelineEndSec);
  const remainingTimelineSec = Number.isFinite(timelineEndSec) ? timelineEndSec - startSec : authoredDurationSec;
  const durationSec = Math.max(1 / 60, Math.min(authoredDurationSec, remainingTimelineSec));
  return {
    image_id: prompt.image_id,
    image_sha256: imageSha256,
    scene_id: prompt.scene_id ?? null,
    visual_beat_id: prompt.visual_beat_id ?? null,
    start_sec: startSec,
    duration_sec: durationSec,
    focal_subject: String(override?.focal_subject ?? base.focal_subject ?? "").trim() || null,
    focal_source: override ? "image_qa_focal_override" : base.focal_source,
    start_anchor: anchor(selectedKeyframes?.[0]?.anchor ?? override?.start_anchor, base.start_anchor),
    end_anchor: anchor(selectedKeyframes?.at(-1)?.anchor ?? override?.end_anchor, base.end_anchor),
    start_scale: startScale,
    end_scale: endScale,
    easing,
    behavior,
    intent_reason: String(override?.reason ?? base.intent_reason ?? "").trim() || null,
    qa_override: override ?? null,
    ...(selectedKeyframes ? { motion_keyframes: selectedKeyframes } : {}),
    ...(base.depth_candidate ? { depth_candidate: base.depth_candidate } : {}),
  };
}

function behaviorForEditorialRow(row) {
  return String(row?.behavior ?? row?.shot_manifest?.motion_intent?.behavior ?? "").trim();
}

export function editorialMotionDistributionFindings(rows, options = {}) {
  const ordered = (rows ?? [])
    .filter((row) => row?.image_generation_required !== false)
    .map((row) => ({
      image_id: row?.image_id ?? null,
      start_sec: Number(row?.start_sec ?? 0),
      behavior: behaviorForEditorialRow(row),
    }))
    .filter((row) => row.behavior)
    .sort((left, right) => left.start_sec - right.start_sec || String(left.image_id).localeCompare(String(right.image_id)));
  const findings = [];
  const minimumCuts = Math.max(1, Number(options.minimumCuts ?? 8));
  if (ordered.length < minimumCuts) return findings;
  const minimumStaticShare = Math.max(0, Math.min(1, Number(options.minimumStaticShare ?? 0.12)));
  const maximumStaticShare = Math.max(minimumStaticShare, Math.min(1, Number(options.maximumStaticShare ?? 0.55)));
  const staticCount = ordered.filter((row) => row.behavior === "static_hold").length;
  const staticShare = staticCount / ordered.length;
  if (staticShare < minimumStaticShare) {
    findings.push({
      severity: "blocker",
      code: "motion_static_hold_share_too_low",
      image_id: ordered[0]?.image_id ?? null,
      cut_count: ordered.length,
      static_hold_count: staticCount,
      static_hold_share: Number(staticShare.toFixed(4)),
      minimum_static_hold_share: minimumStaticShare,
    });
  } else if (staticShare > maximumStaticShare) {
    findings.push({
      severity: "warning",
      code: "motion_static_hold_share_high",
      image_id: ordered[0]?.image_id ?? null,
      cut_count: ordered.length,
      static_hold_count: staticCount,
      static_hold_share: Number(staticShare.toFixed(4)),
      maximum_recommended_static_hold_share: maximumStaticShare,
    });
  }
  const openingEndSec = Math.max(0, Number(options.openingEndSec ?? 60));
  const opening = ordered.filter((row) => row.start_sec < openingEndSec);
  if (opening.length >= 6 && !opening.some((row) => row.behavior === "static_hold")) {
    findings.push({
      severity: "blocker",
      code: "motion_opening_has_no_static_contrast",
      image_id: opening[0]?.image_id ?? null,
      opening_end_sec: openingEndSec,
      opening_cut_count: opening.length,
    });
  }
  const maxAnimatedStreak = Math.max(2, Number(options.maxAnimatedStreak ?? 8));
  let streak = [];
  for (const row of [...ordered, { behavior: "static_hold" }]) {
    if (row.behavior !== "static_hold") {
      streak.push(row);
      continue;
    }
    if (streak.length >= maxAnimatedStreak) {
      findings.push({
        severity: "blocker",
        code: "motion_continuous_movement_streak_too_long",
        image_id: streak[0]?.image_id ?? null,
        end_image_id: streak.at(-1)?.image_id ?? null,
        animated_cut_count: streak.length,
        maximum_animated_streak: maxAnimatedStreak - 1,
      });
    }
    streak = [];
  }
  return findings;
}

export function motionIntentFindings(intents, acceptedHashes = {}) {
  const findings = [];
  const seen = new Set();
  for (const row of intents ?? []) {
    if (!row?.image_id || seen.has(row.image_id)) findings.push({ severity: "blocker", code: "motion_image_id_missing_or_duplicate", image_id: row?.image_id ?? null });
    seen.add(row?.image_id);
    if (!row.image_sha256 || acceptedHashes[row.image_id] !== row.image_sha256) findings.push({ severity: "blocker", code: "motion_image_hash_not_accepted", image_id: row.image_id });
    for (const [field, point] of [["start_anchor", row.start_anchor], ["end_anchor", row.end_anchor]]) {
      if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y)) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) {
        findings.push({ severity: "blocker", code: "motion_anchor_invalid", image_id: row.image_id, field });
      }
    }
    if (!Number.isFinite(Number(row.duration_sec)) || row.duration_sec <= 0) findings.push({ severity: "blocker", code: "motion_duration_invalid", image_id: row.image_id });
    if (!Number.isFinite(Number(row.start_scale)) || !Number.isFinite(Number(row.end_scale)) || row.start_scale < 1 || row.end_scale < 1 || row.start_scale > 1.25 || row.end_scale > 1.25) findings.push({ severity: "blocker", code: "motion_scale_invalid", image_id: row.image_id });
    if (!BEHAVIORS.has(String(row.behavior ?? ""))) findings.push({ severity: "blocker", code: "motion_behavior_invalid", image_id: row.image_id });
    if (row.behavior === "static_hold") {
      const keyframes = motionKeyframesForIntent(row);
      const first = keyframes?.[0];
      const moves = !first || keyframes.some((keyframe) => (
        Math.abs(Number(keyframe.anchor?.x) - Number(first.anchor?.x)) >= 1e-8
        || Math.abs(Number(keyframe.anchor?.y) - Number(first.anchor?.y)) >= 1e-8
        || Math.abs(Number(keyframe.scale) - Number(first.scale)) >= 1e-8
      ));
      if (moves) findings.push({ severity: "blocker", code: "motion_static_hold_is_not_static", image_id: row.image_id });
      if (row.depth_treatment) findings.push({ severity: "blocker", code: "motion_static_hold_has_depth_movement", image_id: row.image_id });
    }
    if (!EASINGS.has(String(row.easing ?? ""))) findings.push({ severity: "blocker", code: "motion_easing_invalid", image_id: row.image_id });
    if (row.motion_keyframes !== undefined && !sanitizeMotionKeyframes(row.motion_keyframes)) findings.push({ severity: "blocker", code: "motion_keyframes_invalid", image_id: row.image_id });
    if (row.qa_override?.motion_keyframes !== undefined && !sanitizeMotionKeyframes(row.qa_override.motion_keyframes)) findings.push({ severity: "blocker", code: "motion_qa_override_keyframes_invalid", image_id: row.image_id });
    if (row.depth_treatment !== undefined && !sanitizeLayeredParallaxTreatment(row.depth_treatment)) findings.push({ severity: "blocker", code: "motion_depth_treatment_invalid", image_id: row.image_id });
  }
  let streakStart = 0;
  const direction = (value, epsilon = 0.015) => value > epsilon ? "positive" : value < -epsilon ? "negative" : "still";
  const signature = (row) => [
    row?.behavior ?? "unknown",
    direction(Number(row?.end_anchor?.x) - Number(row?.start_anchor?.x)),
    direction(Number(row?.end_anchor?.y) - Number(row?.start_anchor?.y)),
    direction(Number(row?.end_scale) - Number(row?.start_scale), 0.004),
  ].join(":");
  for (let index = 1; index <= (intents ?? []).length; index += 1) {
    const samePattern = index < intents.length && signature(intents[index]) === signature(intents[streakStart]);
    if (samePattern) continue;
    const streakLength = index - streakStart;
    if (streakLength >= 4) {
      findings.push({
        severity: "warning",
        code: "motion_pattern_repeated_local_sequence",
        image_id: intents[streakStart]?.image_id ?? null,
        end_image_id: intents[index - 1]?.image_id ?? null,
        behavior: intents[streakStart]?.behavior ?? null,
        repeated_cut_count: streakLength,
      });
    }
    streakStart = index;
  }
  return findings;
}

export function motionTraceForIntent(intent, fps = 60) {
  const frameCount = Math.max(1, Math.round(Number(intent.duration_sec) * fps));
  const keyframes = motionKeyframesForIntent(intent);
  if (!keyframes) return [];
  const rows = [];
  for (let frame = 0; frame < frameCount; frame += 1) {
    const raw = frameCount === 1 ? 1 : frame / (frameCount - 1);
    let segmentIndex = Math.max(0, keyframes.length - 2);
    for (let index = 0; index < keyframes.length - 1; index += 1) {
      if (raw <= keyframes[index + 1].at + 1e-10) {
        segmentIndex = index;
        break;
      }
    }
    const current = keyframes[segmentIndex];
    const next = keyframes[segmentIndex + 1];
    const localRaw = next.at === current.at ? 1 : (raw - current.at) / (next.at - current.at);
    const progress = easingProgress(localRaw, current.easing_to_next);
    rows.push({
      image_id: intent.image_id,
      frame,
      time_sec: Number((frame / fps).toFixed(6)),
      segment_index: segmentIndex,
      keyframe_count: keyframes.length,
      x: Number((current.anchor.x + ((next.anchor.x - current.anchor.x) * progress)).toFixed(7)),
      y: Number((current.anchor.y + ((next.anchor.y - current.anchor.y) * progress)).toFixed(7)),
      scale: Number((current.scale + ((next.scale - current.scale) * progress)).toFixed(7)),
    });
  }
  return rows;
}

function direction(values) {
  const delta = values.at(-1) - values[0];
  return Math.abs(delta) < 1e-8 ? 0 : Math.sign(delta);
}

export function motionTraceFindings(traceRows) {
  const findings = [];
  const byImage = new Map();
  for (const row of traceRows ?? []) {
    const layer = String(row.layer ?? "camera");
    const key = `${row.image_id}::${layer}`;
    if (!byImage.has(key)) byImage.set(key, []);
    byImage.get(key).push(row);
  }
  for (const [key, rows] of byImage) {
    const [imageId, layer] = key.split("::");
    rows.sort((left, right) => left.frame - right.frame);
    for (const field of ["x", "y", "scale"]) {
      const segmentIds = [...new Set(rows.map((row) => Number(row.segment_index ?? 0)))];
      for (const segmentId of segmentIds) {
        const segmentRows = rows.filter((row) => Number(row.segment_index ?? 0) === segmentId);
        const values = segmentRows.map((row) => Number(row[field]));
        const expectedDirection = direction(values);
        for (let index = 1; index < values.length; index += 1) {
          const delta = values[index] - values[index - 1];
          if (expectedDirection && Math.sign(delta) && Math.sign(delta) !== expectedDirection) findings.push({ severity: "blocker", code: "motion_direction_reversal", image_id: imageId, layer, field, frame: segmentRows[index].frame, segment_index: segmentId });
        }
      }
      const values = rows.map((row) => Number(row[field]));
      for (let index = 1; index < values.length; index += 1) {
        const delta = values[index] - values[index - 1];
        const maxDelta = field === "scale" ? 0.012 : 0.025;
        if (Math.abs(delta) > maxDelta) findings.push({ severity: "blocker", code: "motion_frame_discontinuity", image_id: imageId, layer, field, frame: index, delta });
        const keyframeVelocityLimit = field === "scale" ? 0.0045 : 0.004;
        if (Number(rows[index].keyframe_count ?? 2) > 2 && Math.abs(delta) > keyframeVelocityLimit) {
          findings.push({ severity: "blocker", code: "motion_keyframe_velocity_excessive", image_id: imageId, layer, field, frame: index, delta, limit: keyframeVelocityLimit });
        }
      }
    }
  }
  return findings;
}
