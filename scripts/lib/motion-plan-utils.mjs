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

export function sanitizeAuthoredMotionIntent(value) {
  if (!value || typeof value !== "object") return null;
  const behavior = String(value.behavior ?? "").trim();
  const easing = String(value.easing ?? "").trim();
  const startScale = Number(value.start_scale);
  const endScale = Number(value.end_scale);
  if (!BEHAVIORS.has(behavior)
    || !EASINGS.has(easing)
    || !validAnchor(value.start_anchor)
    || !validAnchor(value.end_anchor)
    || !Number.isFinite(startScale)
    || !Number.isFinite(endScale)
    || startScale < 1
    || startScale > 1.25
    || endScale < 1
    || endScale > 1.25) return null;
  return {
    behavior,
    focal_subject: String(value.focal_subject ?? "").trim() || null,
    start_anchor: anchor(value.start_anchor),
    end_anchor: anchor(value.end_anchor),
    start_scale: startScale,
    end_scale: endScale,
    easing,
    reason: String(value.reason ?? "").trim() || null,
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
  if (easing === "ease_in_out") return t * t * (3 - (2 * t));
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
  const startScale = clamp(override?.start_scale ?? base.start_scale, 1, 1.25);
  const endScale = clamp(override?.end_scale ?? base.end_scale, 1, 1.25);
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
    start_anchor: anchor(override?.start_anchor, base.start_anchor),
    end_anchor: anchor(override?.end_anchor, base.end_anchor),
    start_scale: startScale,
    end_scale: endScale,
    easing,
    behavior,
    intent_reason: String(override?.reason ?? base.intent_reason ?? "").trim() || null,
    qa_override: override ?? null,
  };
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
    if (!Number.isFinite(Number(row.start_scale)) || !Number.isFinite(Number(row.end_scale)) || row.start_scale < 1 || row.end_scale < 1) findings.push({ severity: "blocker", code: "motion_scale_invalid", image_id: row.image_id });
    if (!BEHAVIORS.has(String(row.behavior ?? ""))) findings.push({ severity: "blocker", code: "motion_behavior_invalid", image_id: row.image_id });
    if (!EASINGS.has(String(row.easing ?? ""))) findings.push({ severity: "blocker", code: "motion_easing_invalid", image_id: row.image_id });
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
  const rows = [];
  for (let frame = 0; frame < frameCount; frame += 1) {
    const raw = frameCount === 1 ? 1 : frame / (frameCount - 1);
    const progress = easingProgress(raw, intent.easing);
    rows.push({
      image_id: intent.image_id,
      frame,
      time_sec: Number((frame / fps).toFixed(6)),
      x: Number((intent.start_anchor.x + ((intent.end_anchor.x - intent.start_anchor.x) * progress)).toFixed(7)),
      y: Number((intent.start_anchor.y + ((intent.end_anchor.y - intent.start_anchor.y) * progress)).toFixed(7)),
      scale: Number((intent.start_scale + ((intent.end_scale - intent.start_scale) * progress)).toFixed(7)),
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
    if (!byImage.has(row.image_id)) byImage.set(row.image_id, []);
    byImage.get(row.image_id).push(row);
  }
  for (const [imageId, rows] of byImage) {
    rows.sort((left, right) => left.frame - right.frame);
    for (const field of ["x", "y", "scale"]) {
      const values = rows.map((row) => Number(row[field]));
      const expectedDirection = direction(values);
      for (let index = 1; index < values.length; index += 1) {
        const delta = values[index] - values[index - 1];
        if (expectedDirection && Math.sign(delta) && Math.sign(delta) !== expectedDirection) findings.push({ severity: "blocker", code: "motion_direction_reversal", image_id: imageId, field, frame: index });
        const maxDelta = field === "scale" ? 0.012 : 0.025;
        if (Math.abs(delta) > maxDelta) findings.push({ severity: "blocker", code: "motion_frame_discontinuity", image_id: imageId, field, frame: index, delta });
      }
    }
  }
  return findings;
}
