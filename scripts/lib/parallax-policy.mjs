import { sanitizeLayeredParallaxTreatment } from "./motion-plan-utils.mjs";

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function acceptedImageIdSet(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value.map(String));
  if (value && typeof value === "object") return new Set(Object.keys(value));
  return null;
}

export function authoredParallaxCandidatePool(prompts, options = {}) {
  const openingWindowSec = Math.max(0, Number(options.openingWindowSec ?? 180));
  const acceptedIds = acceptedImageIdSet(options.acceptedImageIds);
  return (prompts ?? []).map((prompt) => {
    const motionIntent = prompt?.shot_manifest?.motion_intent;
    const candidate = motionIntent?.depth_candidate;
    const imageId = String(prompt?.image_id ?? "").trim();
    const startSec = Number(prompt?.start_sec ?? 0);
    if (!imageId
      || candidate?.eligible !== true
      || motionIntent?.behavior === "static_hold"
      || !Number.isFinite(startSec)
      || startSec < 0
      || startSec >= openingWindowSec
      || (acceptedIds && !acceptedIds.has(imageId))) return null;
    return {
      image_id: imageId,
      scene_id: prompt.scene_id ?? null,
      visual_beat_id: prompt.visual_beat_id ?? null,
      start_sec: startSec,
      duration_sec: Number(prompt.duration_sec ?? 0),
      priority: Number(candidate.priority ?? 0),
      authored_separation_confidence: String(candidate.separation_confidence ?? "low"),
      foreground_subject: String(candidate.foreground_subject ?? ""),
      background_plane: String(candidate.background_plane ?? ""),
      editorial_reason: String(candidate.editorial_reason ?? ""),
      selection_source: "accepted_image_local_separation_pool",
    };
  }).filter(Boolean).sort((left, right) =>
    left.start_sec - right.start_sec
    || right.priority - left.priority
    || left.image_id.localeCompare(right.image_id));
}

export function classifyParallaxSeparationEvidence(value) {
  const evidence = value?.local_separation_evidence ?? value?.foreground_evidence?.local_separation_evidence ?? value ?? {};
  const width = Number(evidence.width ?? 0);
  const height = Number(evidence.height ?? 0);
  const coverage = Number(evidence.foreground_coverage_ratio);
  const instanceCount = Number(evidence.instance_count ?? 0);
  const edges = evidence.edge_contact_ratios ?? {};
  const left = Number(edges.left ?? 0);
  const right = Number(edges.right ?? 0);
  const top = Number(edges.top ?? 0);
  const bottom = Number(edges.bottom ?? 0);
  const reasons = [];
  if (!(width > 0 && height > 0) || !Number.isFinite(coverage)) reasons.push("missing_mask_geometry");
  if (instanceCount < 1) reasons.push("no_isolated_foreground_instance");
  if (coverage < 0.025) reasons.push("foreground_too_small");
  if (coverage > 0.88) reasons.push("foreground_covers_nearly_entire_frame");
  if (top > 0.5 || left > 0.65 || right > 0.65) reasons.push("foreground_heavily_clipped_at_frame_edge");
  if (reasons.length) {
    return {
      recommended_disposition: "repairable",
      separation_class: "repairable",
      quality_rank: 0,
      reasons,
    };
  }
  const cleanSingleSubject = instanceCount === 1
    && coverage >= 0.07
    && coverage <= 0.68
    && top <= 0.18
    && left <= 0.25
    && right <= 0.25;
  if (cleanSingleSubject) {
    return {
      recommended_disposition: "approved",
      separation_class: "strong",
      quality_rank: 2,
      reasons: bottom > 0.75 ? ["foreground_grounded_at_bottom_edge"] : [],
    };
  }
  return {
    recommended_disposition: "approved_low_motion",
    separation_class: "usable_low_motion",
    quality_rank: 1,
    reasons: [
      ...(instanceCount > 1 ? ["multiple_foreground_instances"] : []),
      ...((coverage < 0.07 || coverage > 0.68) ? ["marginal_foreground_coverage"] : []),
      ...((top > 0.18 || left > 0.25 || right > 0.25 || bottom > 0.9) ? ["foreground_contacts_frame_edge"] : []),
    ],
  };
}

export function selectEvidenceBackedParallaxCandidates(evidenceRows, options = {}) {
  const maxCandidates = boundedInteger(options.maxCandidates, 15, 0, 20);
  const minSpacingSec = Math.max(0, Number(options.minSpacingSec ?? 3));
  const firstWindowSec = Math.max(0, Number(options.firstWindowSec ?? 30));
  const openingWindowSec = Math.max(firstWindowSec, Number(options.openingWindowSec ?? 180));
  const firstWindowTarget = boundedInteger(options.firstWindowTarget, 5, 0, maxCandidates);
  const retentionWindowTarget = boundedInteger(options.retentionWindowTarget, Math.max(0, maxCandidates - firstWindowTarget), 0, maxCandidates);
  if (!maxCandidates) return [];
  const viable = (evidenceRows ?? []).map((row) => {
    const classification = classifyParallaxSeparationEvidence(row);
    return { ...row, separation_evidence_classification: classification };
  }).filter((row) => row.separation_evidence_classification.quality_rank > 0
    && Number.isFinite(Number(row.start_sec))
    && Number(row.start_sec) >= 0
    && Number(row.start_sec) < openingWindowSec);
  viable.sort((left, right) =>
    right.separation_evidence_classification.quality_rank - left.separation_evidence_classification.quality_rank
    || Number(right.priority ?? 0) - Number(left.priority ?? 0)
    || Number(left.start_sec) - Number(right.start_sec)
    || String(left.image_id).localeCompare(String(right.image_id)));
  const selected = [];
  const selectedIds = new Set();
  const addFromPool = (pool, targetCount, enforceSpacing) => {
    let added = 0;
    for (const candidate of pool) {
      if (selected.length >= maxCandidates || added >= targetCount) break;
      if (selectedIds.has(candidate.image_id)) continue;
      if (enforceSpacing && selected.some((row) => Math.abs(Number(row.start_sec) - Number(candidate.start_sec)) < minSpacingSec)) continue;
      selected.push(candidate);
      selectedIds.add(candidate.image_id);
      added += 1;
    }
  };
  addFromPool(viable.filter((row) => Number(row.start_sec) < firstWindowSec), firstWindowTarget, true);
  addFromPool(viable.filter((row) => Number(row.start_sec) >= firstWindowSec), retentionWindowTarget, true);
  addFromPool(viable, maxCandidates - selected.length, true);
  // Spacing and window quotas are editorial goals, not blockers. If clean
  // evidence exists, fill the remaining cheap Flux budget without rejecting a
  // useful frame merely because it is close to another candidate.
  addFromPool(viable, maxCandidates - selected.length, false);
  return selected.sort((left, right) => Number(left.start_sec) - Number(right.start_sec));
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

export function noticeableParallaxTreatment({ intent, assetReport, candidate, disposition = "approved" }) {
  if (assetReport?.status !== "passed" || intent?.behavior === "static_hold") return null;
  const priority = Number(candidate?.priority ?? 0);
  const anchor = intent?.end_anchor ?? intent?.start_anchor ?? { x: 0.5, y: 0.5 };
  const lowMotion = disposition === "approved_low_motion";
  const backgroundStart = lowMotion ? 1.012 : priority >= 90 ? 1.025 : priority >= 75 ? 1.02 : 1.015;
  const foregroundEnd = lowMotion ? 1.032 : priority >= 90 ? 1.075 : priority >= 75 ? 1.065 : 1.055;
  const backgroundEnd = lowMotion ? 1.006 : 1.005;
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
