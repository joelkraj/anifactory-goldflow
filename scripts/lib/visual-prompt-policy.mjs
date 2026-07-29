const HARD_STOP_CODES = new Set([
  "prompt_text_unusable",
  "prompt_image_id_missing",
  "prompt_image_id_duplicate",
  "required_source_identity_unavailable",
  "required_source_identity_ambiguous",
  "visible_character_ref_scope_missing",
  "unknown_manifest_character_ref",
]);

function normalizedKind(kind) {
  return String(kind ?? "").trim().toLowerCase();
}

function referencePriority(kind) {
  const value = normalizedKind(kind);
  if (value.includes("character")) return 0;
  if (value.includes("location")) return 1;
  if (value.includes("prop") || value.includes("ui")) return 2;
  if (value.includes("action") || value.includes("effect")) return 3;
  if (value.includes("style")) return 9;
  return 6;
}

export function isHardStopPromptFinding(finding) {
  if (!finding || finding.resolved === true) return false;
  if (finding.production_blocking === true) return true;
  return HARD_STOP_CODES.has(String(finding.code ?? ""));
}

export function classifyPromptHardeningFindings(findings = []) {
  const normalized = findings.map((finding) => {
    if (!finding || finding.resolved === true || finding.severity !== "blocker") {
      return finding;
    }
    if (isHardStopPromptFinding(finding)) {
      return {
        ...finding,
        production_blocking: true,
        review_disposition: "must_fix",
      };
    }
    return {
      ...finding,
      severity: "warning",
      original_severity: "blocker",
      production_blocking: false,
      review_required: true,
      review_disposition: "manual_fix_or_accept",
      resolved: false,
    };
  });
  const hardStops = normalized.filter((finding) => (
    finding?.severity === "blocker"
    && finding?.resolved !== true
    && isHardStopPromptFinding(finding)
  ));
  const reviewFindings = normalized.filter((finding) => (
    finding?.review_required === true
    && finding?.resolved !== true
  ));
  return {
    findings: normalized,
    hard_stops: hardStops,
    review_findings: reviewFindings,
  };
}

export function normalizeReferenceLimit(requirements = [], maxReferences = 4) {
  const max = Math.max(1, Number(maxReferences) || 4);
  if (requirements.length <= max) {
    return {
      selected: requirements.map((requirement, index) => ({
        ...requirement,
        slot_order: index + 1,
      })),
      dropped: [],
    };
  }
  const ranked = requirements.map((requirement, index) => ({ requirement, index }))
    .sort((left, right) => (
      referencePriority(left.requirement?.kind) - referencePriority(right.requirement?.kind)
      || left.index - right.index
    ));
  const selectedEntries = ranked.slice(0, max);
  const selectedIndexSet = new Set(selectedEntries.map((entry) => entry.index));
  const selected = selectedEntries.map(({ requirement }, index) => ({
    ...requirement,
    slot_order: index + 1,
  }));
  const dropped = requirements
    .map((requirement, index) => ({ requirement, index }))
    .filter(({ index }) => !selectedIndexSet.has(index))
    .map(({ requirement }) => requirement);
  return { selected, dropped };
}

export function promptIdentityFindings(prompts = []) {
  const findings = [];
  const counts = new Map();
  for (const prompt of prompts) {
    const imageId = String(prompt?.image_id ?? "").trim();
    const text = String(
      prompt?.provider_prompt
      ?? prompt?.modelslab_image_prompt
      ?? prompt?.codex_image_prompt
      ?? prompt?.image_prompt
      ?? "",
    ).trim();
    if (!imageId) {
      findings.push({
        image_id: null,
        scene_id: prompt?.scene_id ?? null,
        severity: "blocker",
        code: "prompt_image_id_missing",
        message: "A cut has no stable image_id, so it cannot be generated or recovered safely.",
        production_blocking: true,
        resolved: false,
      });
    } else {
      counts.set(imageId, (counts.get(imageId) ?? 0) + 1);
    }
    if (!text) {
      findings.push({
        image_id: imageId || null,
        scene_id: prompt?.scene_id ?? null,
        severity: "blocker",
        code: "prompt_text_unusable",
        message: "The cut has no usable provider prompt text.",
        production_blocking: true,
        resolved: false,
      });
    }
  }
  for (const [imageId, count] of counts) {
    if (count < 2) continue;
    findings.push({
      image_id: imageId,
      scene_id: null,
      severity: "blocker",
      code: "prompt_image_id_duplicate",
      message: `Stable image_id ${imageId} appears ${count} times.`,
      duplicate_count: count,
      production_blocking: true,
      resolved: false,
    });
  }
  return findings;
}
