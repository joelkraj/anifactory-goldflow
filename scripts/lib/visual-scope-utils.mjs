function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function sceneScopeId(scene) {
  return String(scene?.parent_scene_id ?? scene?.scene_id ?? "").trim();
}

export function normalizeRefId(value) {
  return String(value ?? "").trim();
}

export function normalizeRefKind(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function sceneLocationRequirementRefIds(scene) {
  return asArray(scene?.ref_requirements)
    .filter((requirement) => normalizeRefKind(requirement?.kind) === "location")
    .map((requirement) => normalizeRefId(requirement?.ref_id ?? requirement?.reference_id ?? requirement?.id))
    .filter(Boolean);
}

export function deriveLocationSceneIdsByRef(semanticScenes = []) {
  const byRefId = new Map();
  for (const scene of asArray(semanticScenes)) {
    const sceneId = sceneScopeId(scene);
    if (!sceneId) continue;
    for (const refId of sceneLocationRequirementRefIds(scene)) {
      if (!byRefId.has(refId)) byRefId.set(refId, new Set());
      byRefId.get(refId).add(sceneId);
    }
  }
  return byRefId;
}

export function applyDeterministicLocationSceneIds(referenceTargets = [], semanticScenes = []) {
  const derived = deriveLocationSceneIdsByRef(semanticScenes);
  const warnings = [];
  const targets = asArray(referenceTargets).map((target) => {
    if (normalizeRefKind(target?.kind) !== "location") return target;
    const refId = normalizeRefId(target?.ref_id);
    const merged = new Set(asArray(target?.scene_ids).map(normalizeRefId).filter(Boolean));
    for (const sceneId of derived.get(refId) ?? []) merged.add(sceneId);
    const sceneIds = [...merged];
    if (!sceneIds.length) {
      warnings.push({
        code: "unbound_location_ref",
        severity: "warning",
        ref_id: refId,
        message: `Location reference ${refId || "(missing ref_id)"} is not bound to any semantic scene.`,
      });
    }
    return { ...target, scene_ids: sceneIds };
  });
  return { targets, warnings };
}

export function isPhysicalLocationScene(scene) {
  const location = String(scene?.location ?? "").trim();
  if (!location) return false;
  return !/^(?:none|unknown|n\/a|na|abstract|unspecified)$/i.test(location);
}

export function locationCoverageFindings(referenceTargets = [], semanticScenes = []) {
  const locationTargets = asArray(referenceTargets).filter((target) => normalizeRefKind(target?.kind) === "location");
  const findings = [];
  for (const scene of asArray(semanticScenes)) {
    const sceneId = sceneScopeId(scene);
    const requiredLocationRefIds = sceneLocationRequirementRefIds(scene);
    if (!sceneId || !isPhysicalLocationScene(scene) || !requiredLocationRefIds.length) continue;
    const missingRefIds = requiredLocationRefIds.filter((requiredRefId) => {
      const exactTarget = locationTargets.find((target) => normalizeRefId(target?.ref_id) === requiredRefId);
      if (!exactTarget) return true;
      const targetSceneIds = new Set(asArray(exactTarget?.scene_ids).map(normalizeRefId).filter(Boolean));
      return !targetSceneIds.has(sceneId);
    });
    if (missingRefIds.length) {
      findings.push({
        code: "scene_missing_location_ref",
        severity: "blocker",
        scene_id: sceneId,
        location: scene.location,
        required_ref_ids: missingRefIds,
        message: `Scene ${sceneId} has physical location "${scene.location}" and requires exact location ref ${missingRefIds.join(", ")}, but no matching location reference target covers the scene.`,
      });
    }
  }
  return findings;
}

export function targetIsGlobal(target) {
  return normalizeRefKind(target?.kind) === "style";
}

export function targetIsInSceneScope(target, sceneId) {
  if (targetIsGlobal(target)) return true;
  const scopedIds = asArray(target?.scene_ids).map(normalizeRefId).filter(Boolean);
  return Boolean(sceneId) && scopedIds.includes(sceneId);
}

export function referenceTargetsForScene(scene, visualReferencePlan) {
  const sceneId = sceneScopeId(scene);
  return asArray(visualReferencePlan?.reference_targets).filter((target) => targetIsInSceneScope(target, sceneId));
}

export function allowedRefIdsForScene({ scene, visualReferencePlan, characterStateRefs = [] } = {}) {
  const sceneId = sceneScopeId(scene);
  const allowed = new Set(referenceTargetsForScene(scene, visualReferencePlan).map((target) => normalizeRefId(target.ref_id)).filter(Boolean));
  for (const ref of asArray(characterStateRefs)) {
    const scopedIds = asArray(ref?.scene_ids).map(normalizeRefId).filter(Boolean);
    if (scopedIds.length && sceneId && !scopedIds.includes(sceneId)) continue;
    for (const id of [ref?.state_ref_id, ref?.ref_id, ref?.source_ref_id, ref?.base_identity_ref_id]) {
      const normalized = normalizeRefId(id);
      if (normalized) allowed.add(normalized);
    }
  }
  return allowed;
}

export function dropOutOfScopePromptRefs(prompt, allowedRefIds) {
  const allowed = allowedRefIds instanceof Set ? allowedRefIds : new Set(asArray(allowedRefIds).map(normalizeRefId).filter(Boolean));
  let next = {
    ...prompt,
    reference_requirements: asArray(prompt?.reference_requirements),
    reference_usage: asArray(prompt?.reference_usage),
    shot_manifest: prompt?.shot_manifest && typeof prompt.shot_manifest === "object" && !Array.isArray(prompt.shot_manifest)
      ? { ...prompt.shot_manifest }
      : prompt?.shot_manifest,
  };
  const referenceUsage = [...next.reference_usage];
  const referenceLimitDropped = new Set(referenceUsage
    .filter((usage) => {
      const label = String(usage?.usage ?? "").trim();
      return label === "available_not_attached_reference_limit";
    })
    .map((usage) => normalizeRefId(usage?.ref_id))
    .filter((refId) => refId && allowed.has(refId)));
  const recordDrop = (refId, field) => {
    referenceUsage.push({
      ref_id: refId,
      usage: "out_of_scope_ref_dropped",
      field,
      reason: "Ref id is not in the current scene candidate set; deterministic validation drops it without guessing a replacement.",
    });
  };
  const keepRef = (refId, field) => {
    const normalized = normalizeRefId(refId);
    if (!normalized || allowed.has(normalized)) return Boolean(normalized);
    recordDrop(normalized, field);
    return false;
  };

  if (next.shot_manifest && typeof next.shot_manifest === "object" && !Array.isArray(next.shot_manifest)) {
    next.shot_manifest.forbidden_ref_ids = asArray(next.shot_manifest.forbidden_ref_ids)
      .map(normalizeRefId)
      .filter((refId) => {
        if (!refId) return false;
        if (referenceLimitDropped.has(refId)) {
          referenceUsage.push({
            ref_id: refId,
            usage: "non_forbidden_ref_removed_from_forbidden_ref_ids",
            field: "shot_manifest.forbidden_ref_ids",
            reason: "Ref id was in the current scene candidate set and was already reported as omitted only because the four-reference cap was full.",
          });
          return false;
        }
        return true;
      });
    if (next.shot_manifest.location_ref_id && !keepRef(next.shot_manifest.location_ref_id, "shot_manifest.location_ref_id")) {
      next.shot_manifest.location_ref_id = null;
    }
    next.shot_manifest.character_state_ref_ids = asArray(next.shot_manifest.character_state_ref_ids)
      .map(normalizeRefId)
      .filter((refId) => keepRef(refId, "shot_manifest.character_state_ref_ids"));
    if (next.shot_manifest.protagonist_state_ref_id && !keepRef(next.shot_manifest.protagonist_state_ref_id, "shot_manifest.protagonist_state_ref_id")) {
      next.shot_manifest.protagonist_state_ref_id = null;
    }
    next.shot_manifest.reference_slots = asArray(next.shot_manifest.reference_slots)
      .filter((slot) => keepRef(slot?.ref_id, "shot_manifest.reference_slots.ref_id"));
  }

  const keptRequirements = [];
  for (const requirement of next.reference_requirements) {
    const refId = normalizeRefId(requirement?.ref_id);
    if (!refId) continue;
    if (keepRef(refId, "reference_requirements.ref_id")) keptRequirements.push(requirement);
  }
  next.reference_requirements = keptRequirements;
  next.reference_usage = referenceUsage;

  return next;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function outOfScopeLocationRefMentions({ text, locationTargets = [], allowedLocationRefId = null } = {}) {
  const body = String(text ?? "");
  const allowed = normalizeRefId(allowedLocationRefId);
  return asArray(locationTargets)
    .map((target) => normalizeRefId(target?.ref_id))
    .filter((refId) => refId && refId !== allowed)
    .filter((refId) => new RegExp(`\\b${escapeRegExp(refId)}\\b`, "i").test(body))
    .map((refId) => ({
      ref_id: refId,
      code: "out_of_scope_location_ref_mentioned",
      severity: "blocker",
      message: `Prompt prose references out-of-scope location ref id ${refId}.`,
    }));
}
