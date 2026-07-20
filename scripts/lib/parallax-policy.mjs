import { sanitizeLayeredParallaxTreatment } from "./motion-plan-utils.mjs";

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

export function selectAuthoredParallaxCandidates(prompts, options = {}) {
  const maxCandidates = boundedInteger(options.maxCandidates, 15, 0, 20);
  const minSpacingSec = Math.max(0, Number(options.minSpacingSec ?? 3));
  const firstWindowSec = Math.max(0, Number(options.firstWindowSec ?? 30));
  const openingWindowSec = Math.max(firstWindowSec, Number(options.openingWindowSec ?? 180));
  const firstWindowTarget = boundedInteger(options.firstWindowTarget, 5, 0, maxCandidates);
  const retentionWindowTarget = boundedInteger(
    options.retentionWindowTarget,
    Math.max(0, maxCandidates - firstWindowTarget),
    0,
    maxCandidates,
  );
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
  const selectedIds = new Set();
  const addFromPool = (pool, targetCount) => {
    let added = 0;
    for (const candidate of pool) {
      if (selected.length >= maxCandidates || added >= targetCount || selectedIds.has(candidate.image_id)) break;
      if (selected.some((row) => Math.abs(row.start_sec - candidate.start_sec) < minSpacingSec)) continue;
      selected.push(candidate);
      selectedIds.add(candidate.image_id);
      added += 1;
    }
  };
  const firstWindow = authored.filter((row) => row.start_sec < firstWindowSec);
  const retentionWindow = authored.filter((row) => row.start_sec >= firstWindowSec && row.start_sec < openingWindowSec);
  addFromPool(firstWindow, firstWindowTarget);
  addFromPool(retentionWindow, retentionWindowTarget);
  addFromPool(authored.filter((row) => row.start_sec < openingWindowSec), maxCandidates - selected.length);
  if (selected.length < maxCandidates) {
    addFromPool(authored.filter((row) => row.start_sec >= openingWindowSec), maxCandidates - selected.length);
  }
  return selected.sort((left, right) => left.start_sec - right.start_sec);
}

export function inspectedParallaxCandidateOverrides(prompts, payload, options = {}) {
  if (!payload) return [];
  if (payload.status !== "approved" || !String(payload.reviewer ?? "").trim() || !String(payload.note ?? "").trim()) {
    throw new Error("Inspected parallax candidate overrides require status approved plus reviewer and note.");
  }
  const maxCandidates = boundedInteger(options.maxCandidates, 15, 0, 20);
  const openingWindowSec = Math.max(0, Number(options.openingWindowSec ?? 180));
  const promptById = new Map((prompts ?? []).map((prompt) => [String(prompt.image_id ?? ""), prompt]));
  const seen = new Set();
  const candidates = [];
  for (const override of payload.candidates ?? []) {
    const imageId = String(override?.image_id ?? "").trim();
    if (!imageId || seen.has(imageId)) throw new Error(`Duplicate or empty inspected parallax candidate id: ${imageId || "<empty>"}`);
    const prompt = promptById.get(imageId);
    if (!prompt) throw new Error(`Unknown inspected parallax candidate id: ${imageId}`);
    const startSec = Number(prompt.start_sec);
    if (!Number.isFinite(startSec) || startSec < 0 || startSec >= openingWindowSec) {
      throw new Error(`Inspected parallax candidate falls outside the locked opening window: ${imageId}`);
    }
    if (prompt?.shot_manifest?.motion_intent?.behavior === "static_hold") {
      throw new Error(`Inspected parallax candidate is an authored static hold: ${imageId}`);
    }
    const foregroundSubject = String(override.foreground_subject ?? "").trim();
    const backgroundPlane = String(override.background_plane ?? "").trim();
    const editorialReason = String(override.editorial_reason ?? "").trim();
    if (!foregroundSubject || !backgroundPlane || !editorialReason) {
      throw new Error(`Inspected parallax candidate requires foreground_subject, background_plane, and editorial_reason: ${imageId}`);
    }
    seen.add(imageId);
    candidates.push({
      image_id: imageId,
      scene_id: prompt.scene_id ?? null,
      visual_beat_id: prompt.visual_beat_id ?? null,
      start_sec: startSec,
      duration_sec: Number(prompt.duration_sec ?? 0),
      priority: boundedInteger(override.priority, 90, 1, 100),
      separation_confidence: ["high", "medium"].includes(String(override.separation_confidence ?? ""))
        ? String(override.separation_confidence)
        : "high",
      foreground_subject: foregroundSubject,
      background_plane: backgroundPlane,
      editorial_reason: editorialReason,
      selection_source: "inspected_candidate_override",
    });
  }
  if (candidates.length > maxCandidates) {
    throw new Error(`Inspected parallax candidates exceed the locked maximum of ${maxCandidates}.`);
  }
  return candidates.sort((left, right) => left.start_sec - right.start_sec);
}

export function noticeableParallaxTreatment({ intent, assetReport, candidate }) {
  if (assetReport?.status !== "passed" || intent?.behavior === "static_hold") return null;
  const priority = Number(candidate?.priority ?? 0);
  const anchor = intent?.end_anchor ?? intent?.start_anchor ?? { x: 0.5, y: 0.5 };
  const backgroundStart = priority >= 90 ? 1.025 : priority >= 75 ? 1.02 : 1.015;
  const foregroundEnd = priority >= 90 ? 1.075 : priority >= 75 ? 1.065 : 1.055;
  const backgroundEnd = 1.005;
  const backgroundKeyframes = [
    { at: 0, anchor, scale: backgroundStart, easing_to_next: "ease_in_out" },
    { at: 1, anchor, scale: backgroundEnd, easing_to_next: "linear" },
  ];
  const foregroundKeyframes = [
    { at: 0, anchor, scale: backgroundStart, easing_to_next: "ease_in_out" },
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
