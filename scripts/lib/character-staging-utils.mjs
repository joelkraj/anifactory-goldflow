const STOPWORDS = new Set([
  "a", "an", "and", "anime", "as", "at", "be", "body", "by", "cinematic", "clean", "close", "clothing", "confident",
  "dark", "dramatic", "face", "features", "for", "frame", "from", "front", "full", "hair", "high", "in", "into",
  "is", "layered", "lighting", "longform", "manhwa", "medium", "of", "on", "one", "or", "portrait", "render",
  "scene", "shot", "silhouette", "single", "standing", "style", "subject", "the", "three", "tight", "view", "with",
]);

const WARDROBE_KEYWORDS = [
  "apron", "armor", "blazer", "blouse", "boots", "cape", "cardigan", "cloak", "coat", "corset", "dress", "earrings",
  "gloves", "gown", "hoodie", "jacket", "jeans", "kimono", "necklace", "overcoat", "pants", "robe", "scarf", "shirt",
  "shoes", "skirt", "sneakers", "stockings", "suit", "sweater", "tie", "trousers", "tunic", "uniform", "vest",
];

export const CHARACTER_STAGING_POSITIONS = [
  "frame-left",
  "frame-right",
  "center",
  "foreground",
  "background-left",
  "background-right",
];

function normalizeToken(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function positionPattern(value) {
  const normalized = String(value ?? "").toLowerCase().trim();
  if (!normalized) return null;
  return new RegExp(`\\b${normalized.replace(/[^a-z0-9]+/g, "[-\\s]+")}\\b`, "i");
}

function splitClauses(text) {
  return String(text ?? "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function normalizeCharacterName(value) {
  return normalizeToken(value);
}

function sanitizeString(value) {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function significantTokens(value, limit = 8) {
  const tokens = normalizeToken(value)
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !STOPWORDS.has(token));
  return [...new Set(tokens)].slice(0, limit);
}

function wardrobeFragments(anchor) {
  const parts = String(anchor ?? "")
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter(Boolean);
  const wardrobeParts = parts.filter((part) => WARDROBE_KEYWORDS.some((keyword) => new RegExp(`\\b${keyword}\\b`, "i").test(part)));
  if (wardrobeParts.length) return wardrobeParts.slice(0, 3);
  return parts.slice(0, 2);
}

function wardrobeEvidenceTokens(anchor) {
  const fragments = wardrobeFragments(anchor);
  const keywordTokens = fragments.flatMap((fragment) =>
    significantTokens(fragment, 6).filter((token) => WARDROBE_KEYWORDS.some((keyword) => keyword === token || token.includes(keyword)))
  );
  if (keywordTokens.length) return [...new Set(keywordTokens)].slice(0, 4);
  return significantTokens(fragments.join(" "), 6);
}

function stageRefIdCandidates(stage) {
  const ids = [];
  if (stage?.ref_id) ids.push(String(stage.ref_id));
  const wardrobeFrom = String(stage?.wardrobe_from ?? "");
  const match = wardrobeFrom.match(/^character_state_ref:(.+)$/i);
  if (match?.[1]) ids.push(match[1]);
  return [...new Set(ids)];
}

function characterStateRefMap(characterStateRefs = []) {
  const refs = Array.isArray(characterStateRefs?.character_state_refs)
    ? characterStateRefs.character_state_refs
    : Array.isArray(characterStateRefs)
      ? characterStateRefs
      : [];
  const byId = new Map();
  for (const ref of refs) {
    for (const id of [ref?.state_ref_id, ref?.source_ref_id, ref?.base_identity_ref_id].filter(Boolean)) {
      byId.set(String(id), ref);
    }
  }
  return byId;
}

function stagedCharacterSegment(promptText, stage, stagedNames) {
  const name = normalizeCharacterName(stage?.name);
  const namePattern = name ? new RegExp(`\\b${name.replace(/\s+/g, "\\s+")}\\b`, "i") : null;
  const screenPositionPattern = positionPattern(stage?.screen_position);
  const clauses = splitClauses(promptText);
  const matches = clauses.filter((clause) => (!namePattern || namePattern.test(normalizeToken(clause))) && (!screenPositionPattern || screenPositionPattern.test(clause)));
  if (!matches.length) return null;
  const merged = matches.find((clause) => {
    const beforeColon = clause.split(":")[0] ?? clause;
    return stagedNames.some((otherName) =>
      otherName !== name
      && new RegExp(`\\b${otherName.replace(/\s+/g, "\\s+")}\\b`, "i").test(normalizeToken(beforeColon))
    );
  });
  return { clause: matches[0], merged: merged ?? null };
}

function sameNames(left = [], right = []) {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

export function sanitizeCharacterStaging(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => ({
      name: sanitizeString(entry?.name),
      ref_id: sanitizeString(entry?.ref_id),
      screen_position: sanitizeString(entry?.screen_position),
      wardrobe_from: sanitizeString(entry?.wardrobe_from),
      pose: sanitizeString(entry?.pose),
    }))
    .filter((entry) => entry.name || entry.ref_id || entry.screen_position || entry.wardrobe_from || entry.pose);
}

export function multiCharacterBleedFindings(prompt, characterStateRefs = []) {
  const shotManifest = prompt?.shot_manifest ?? null;
  const visibleCharacters = Array.isArray(shotManifest?.visible_characters)
    ? shotManifest.visible_characters.map((name) => normalizeCharacterName(name)).filter(Boolean)
    : [];
  if (visibleCharacters.length < 2) return [];
  const characterStaging = sanitizeCharacterStaging(shotManifest?.character_staging);
  const promptText = String(prompt?.modelslab_image_prompt ?? prompt?.image_prompt ?? prompt?.codex_image_prompt ?? "");
  const byRefId = characterStateRefMap(characterStateRefs);
  const stagedNames = characterStaging.map((entry) => normalizeCharacterName(entry.name)).filter(Boolean);
  const findings = [];
  const baseFinding = {
    image_id: prompt?.image_id ?? null,
    scene_id: prompt?.scene_id ?? null,
    severity: "blocker",
    code: "character_attribute_bleed_risk",
    resolved: false,
    target_field: "people_clause",
  };

  if (!characterStaging.length) {
    findings.push({
      ...baseFinding,
      message: "Multi-character cut is missing shot_manifest.character_staging, so wardrobe and identity cannot be bound to discrete screen positions.",
    });
    return findings;
  }

  const missingVisible = visibleCharacters.filter((name) => !stagedNames.includes(name));
  const extraStaged = stagedNames.filter((name) => !visibleCharacters.includes(name));
  if (missingVisible.length || extraStaged.length || !sameNames(stagedNames, visibleCharacters)) {
    findings.push({
      ...baseFinding,
      message: `character_staging must cover every visible character in visible_characters order. Missing: ${missingVisible.join(", ") || "none"}. Extra or misordered: ${extraStaged.join(", ") || (sameNames(stagedNames, visibleCharacters) ? "none" : stagedNames.join(", "))}.`,
    });
  }

  for (const stage of characterStaging) {
    const normalizedName = normalizeCharacterName(stage.name);
    if (!normalizedName) {
      findings.push({
        ...baseFinding,
        message: "Each character_staging entry needs a named character.",
      });
      continue;
    }
    if (!CHARACTER_STAGING_POSITIONS.includes(String(stage.screen_position ?? ""))) {
      findings.push({
        ...baseFinding,
        message: `Character ${stage.name} uses invalid screen_position "${stage.screen_position ?? ""}". Allowed values: ${CHARACTER_STAGING_POSITIONS.join(", ")}.`,
      });
    }
    if (!stage.pose) {
      findings.push({
        ...baseFinding,
        message: `Character ${stage.name} is missing a distinct pose/action in character_staging.pose.`,
      });
    }
    const segment = stagedCharacterSegment(promptText, stage, stagedNames);
    if (!segment?.clause) {
      findings.push({
        ...baseFinding,
        message: `Prompt prose does not give ${stage.name} an explicit ${stage.screen_position} clause with the character name attached.`,
      });
      continue;
    }
    if (segment.merged) {
      findings.push({
        ...baseFinding,
        message: `Prompt prose merges multiple staged characters into one clause: "${segment.merged}". Each character needs a separate position-bound clause.`,
      });
      continue;
    }
    const ref = stageRefIdCandidates(stage).map((id) => byRefId.get(id)).find(Boolean);
    const anchor = String(ref?.scene_prompt_anchor ?? "");
    const expectedWardrobeTokens = wardrobeEvidenceTokens(anchor);
    if (expectedWardrobeTokens.length) {
      const clauseText = normalizeToken(segment.clause);
      const matched = expectedWardrobeTokens.filter((token) => clauseText.includes(token));
      if (matched.length < Math.min(2, expectedWardrobeTokens.length)) {
        findings.push({
          ...baseFinding,
          message: `Prompt clause for ${stage.name} does not carry enough wardrobe evidence from ${stage.wardrobe_from ?? stage.ref_id ?? "character_state_ref"} inside that character's own named segment.`,
        });
      }
    }
  }

  return findings;
}
