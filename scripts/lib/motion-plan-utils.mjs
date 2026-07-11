const POSITION_ANCHORS = new Map([
  ["frame-left", { x: 0.3, y: 0.5 }],
  ["frame-right", { x: 0.7, y: 0.5 }],
  ["center", { x: 0.5, y: 0.5 }],
  ["foreground", { x: 0.5, y: 0.58 }],
  ["background-left", { x: 0.3, y: 0.42 }],
  ["background-right", { x: 0.7, y: 0.42 }],
]);

const BEHAVIORS = new Set(["static_hold", "slow_push_in", "reveal_zoom_out", "lateral_follow", "focus_shift"]);
const EASINGS = new Set(["linear", "ease_in", "ease_out", "ease_in_out"]);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}

function anchor(value, fallback = { x: 0.5, y: 0.5 }) {
  if (!value || !Number.isFinite(Number(value.x)) || !Number.isFinite(Number(value.y))) return { ...fallback };
  return { x: clamp(value.x, 0, 1), y: clamp(value.y, 0, 1) };
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
  return { primary: primary || stage?.name || null, stage };
}

function derivedIntent(prompt) {
  const manifest = prompt?.shot_manifest ?? {};
  const shotJob = String(manifest.shot_job ?? prompt?.suggested_shot_job ?? prompt?.visual_job ?? "").toLowerCase();
  const { primary, stage } = stagingForPrimary(prompt);
  const focalAnchor = POSITION_ANCHORS.get(String(stage?.screen_position ?? "")) ?? { x: 0.5, y: 0.5 };
  const hasAuthoredFocalIntent = Boolean(stage || manifest.primary_character || prompt?.primary_subject);
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
    };
  }
  if (/establish|location|environment|arrival|transition/.test(shotJob)) {
    return {
      focal_subject: primary,
      focal_source: stage ? "shot_manifest.character_staging" : "shot_manifest.shot_job",
      start_anchor: focalAnchor,
      end_anchor: { x: 0.5, y: 0.5 },
      start_scale: 1.08,
      end_scale: 1,
      easing: "ease_out",
      behavior: "reveal_zoom_out",
    };
  }
  if (/action|contact|fight|chase|impact|movement/.test(shotJob)) {
    return {
      focal_subject: primary,
      focal_source: stage ? "shot_manifest.character_staging" : "shot_manifest.shot_job",
      start_anchor: { x: 0.5, y: focalAnchor.y },
      end_anchor: focalAnchor,
      start_scale: 1.015,
      end_scale: 1.075,
      easing: "ease_in_out",
      behavior: Math.abs(focalAnchor.x - 0.5) > 0.08 ? "lateral_follow" : "slow_push_in",
    };
  }
  if (/ui|insert|detail|system|prop/.test(shotJob)) {
    return {
      focal_subject: primary ?? "authored insert focal point",
      focal_source: stage ? "shot_manifest.character_staging" : "shot_manifest.shot_job",
      start_anchor: focalAnchor,
      end_anchor: focalAnchor,
      start_scale: 1.01,
      end_scale: 1.065,
      easing: "ease_in_out",
      behavior: "slow_push_in",
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
  };
}

export function motionIntentForPrompt(prompt, imageSha256, decision = null) {
  const base = derivedIntent(prompt);
  const override = decision?.focal_override && typeof decision.focal_override === "object" ? decision.focal_override : null;
  const behavior = BEHAVIORS.has(String(override?.behavior ?? "")) ? String(override.behavior) : base.behavior;
  const easing = EASINGS.has(String(override?.easing ?? "")) ? String(override.easing) : base.easing;
  const startScale = clamp(override?.start_scale ?? base.start_scale, 1, 1.25);
  const endScale = clamp(override?.end_scale ?? base.end_scale, 1, 1.25);
  return {
    image_id: prompt.image_id,
    image_sha256: imageSha256,
    scene_id: prompt.scene_id ?? null,
    visual_beat_id: prompt.visual_beat_id ?? null,
    start_sec: Number(prompt.start_sec ?? 0),
    duration_sec: Math.max(1 / 60, Number(prompt.duration_sec ?? 6)),
    focal_subject: String(override?.focal_subject ?? base.focal_subject ?? "").trim() || null,
    focal_source: override ? "image_qa_focal_override" : base.focal_source,
    start_anchor: anchor(override?.start_anchor, base.start_anchor),
    end_anchor: anchor(override?.end_anchor, base.end_anchor),
    start_scale: startScale,
    end_scale: endScale,
    easing,
    behavior,
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

