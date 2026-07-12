import { sanitizeLayeredParallaxTreatment } from "./motion-plan-utils.mjs";

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

export function selectAuthoredParallaxCandidates(prompts, options = {}) {
  const maxCandidates = boundedInteger(options.maxCandidates, 3, 0, 5);
  const minSpacingSec = Math.max(0, Number(options.minSpacingSec ?? 6));
  if (!maxCandidates) return [];
  const authored = (prompts ?? []).map((prompt) => {
    const motionIntent = prompt?.shot_manifest?.motion_intent;
    const candidate = motionIntent?.depth_candidate;
    if (candidate?.eligible !== true) return null;
    if (motionIntent?.behavior === "static_hold") return null;
    return {
      image_id: String(prompt.image_id ?? ""),
      scene_id: prompt.scene_id ?? null,
      visual_beat_id: prompt.visual_beat_id ?? null,
      start_sec: Number(prompt.start_sec ?? 0),
      duration_sec: Number(prompt.duration_sec ?? 0),
      priority: Number(candidate.priority ?? 0),
      separation_confidence: String(candidate.separation_confidence ?? "low"),
      foreground_subject: String(candidate.foreground_subject ?? ""),
      background_plane: String(candidate.background_plane ?? ""),
      editorial_reason: String(candidate.editorial_reason ?? ""),
    };
  }).filter((row) => row
    && row.image_id
    && Number.isFinite(row.start_sec)
    && Number.isFinite(row.priority)
    && ["high", "medium"].includes(row.separation_confidence));
  authored.sort((left, right) => right.priority - left.priority || left.start_sec - right.start_sec || left.image_id.localeCompare(right.image_id));

  const selected = [];
  for (const candidate of authored) {
    if (selected.some((row) => Math.abs(row.start_sec - candidate.start_sec) < minSpacingSec)) continue;
    selected.push(candidate);
    if (selected.length >= maxCandidates) break;
  }
  return selected.sort((left, right) => left.start_sec - right.start_sec);
}

export function noticeableParallaxTreatment({ intent, assetReport, candidate }) {
  if (assetReport?.status !== "passed" || intent?.behavior === "static_hold") return null;
  const priority = Number(candidate?.priority ?? 0);
  const anchor = intent?.end_anchor ?? intent?.start_anchor ?? { x: 0.5, y: 0.5 };
  const backgroundStart = priority >= 90 ? 1.025 : priority >= 75 ? 1.02 : 1.015;
  const foregroundEnd = priority >= 90 ? 1.075 : priority >= 75 ? 1.065 : 1.055;
  const backgroundEnd = 1.005;
  const backgroundKeyframes = [
    { at: 0, anchor, scale: backgroundStart, easing_to_next: "linear" },
    { at: 0.1, anchor, scale: backgroundStart, easing_to_next: "ease_in_out" },
    { at: 0.88, anchor, scale: backgroundEnd, easing_to_next: "linear" },
    { at: 1, anchor, scale: backgroundEnd, easing_to_next: "linear" },
  ];
  const foregroundKeyframes = [
    { at: 0, anchor, scale: backgroundStart, easing_to_next: "linear" },
    { at: 0.1, anchor, scale: backgroundStart, easing_to_next: "ease_in_out" },
    { at: 0.88, anchor, scale: foregroundEnd, easing_to_next: "linear" },
    { at: 1, anchor, scale: foregroundEnd, easing_to_next: "linear" },
  ];
  return sanitizeLayeredParallaxTreatment({
    mode: "layered_parallax",
    source_image_sha256: assetReport.image_sha256,
    background_path: assetReport.background_path,
    background_sha256: assetReport.background_sha256,
    foreground_path: assetReport.foreground_path,
    foreground_sha256: assetReport.foreground_sha256,
    background_keyframes: backgroundKeyframes,
    foreground_keyframes: foregroundKeyframes,
  });
}
