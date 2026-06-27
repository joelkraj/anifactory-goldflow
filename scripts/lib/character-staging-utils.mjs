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

const POSITION_SYNONYMS = {
  "frame-left": [/\bframe[-\s]*left\b/i, /\bon (?:his|her|their|the) left\b/i, /\bto (?:his|her|their|the) left\b/i, /\bleft (?:side|of frame)\b/i, /\bstage left\b/i],
  "frame-right": [/\bframe[-\s]*right\b/i, /\bon (?:his|her|their|the) right\b/i, /\bto (?:his|her|their|the) right\b/i, /\bright (?:side|of frame)\b/i, /\bstage right\b/i],
  center: [/\bcenter(?:ed)?\b/i, /\bcentre\b/i, /\bmiddle\b/i, /\bcentral\b/i],
  foreground: [/\bforeground\b/i, /\bup front\b/i, /\bin front\b/i, /\bclosest to (?:the )?camera\b/i],
  "background-left": [/\bback(?:ground)?[-\s]*left\b/i, /\brear[-\s]*left\b/i, /\bfar left\b/i],
  "background-right": [/\bback(?:ground)?[-\s]*right\b/i, /\brear[-\s]*right\b/i, /\bfar right\b/i],
};

function positionMatchesText(position, text) {
  const patterns = POSITION_SYNONYMS[String(position ?? "").toLowerCase()] || [];
  return patterns.some((pattern) => pattern.test(String(text ?? "")));
}

function sharedWardrobeMerge(clause, stagedNames) {
  const present = stagedNames.filter((name) => new RegExp(`\\b${name.replace(/\s+/g, "\\s+")}\\b`, "i").test(normalizeToken(clause)));
  if (present.length < 2) return false;
  const hasWardrobe = WARDROBE_KEYWORDS.some((keyword) => new RegExp(`\\b${keyword}s?\\b`, "i").test(clause));
  if (!hasWardrobe) return false;
  const conjoined = present.some((left) => present.some((right) =>
    left !== right && new RegExp(`\\b${left.replace(/\s+/g, "\\s+")}\\s+(?:and|&|with)\\s+${right.replace(/\s+/g, "\\s+")}\\b`, "i").test(normalizeToken(clause))
  ));
  const sharedCue = /\b(both|together|matching|same|identical|each other)\b/i.test(clause);
  return conjoined || sharedCue;
}

function normalizeToken(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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

function characterWindow(promptText, stage, stagedNames) {
  const name = normalizeCharacterName(stage?.name);
  if (!name) return null;
  const selfPattern = new RegExp(`\\b${name.replace(/\s+/g, "\\s+")}\\b`, "i");
  const others = stagedNames.filter((other) => other !== name);
  const clauses = splitClauses(promptText);
  const index = clauses.findIndex((clause) => selfPattern.test(normalizeToken(clause)));
  if (index === -1) return { hasName: false };
  let end = index;
  for (let current = index + 1; current < clauses.length; current += 1) {
    if (others.some((other) => new RegExp(`\\b${other.replace(/\s+/g, "\\s+")}\\b`, "i").test(normalizeToken(clauses[current])))) break;
    end = current;
  }
  const windowText = clauses.slice(index, end + 1).join(" ");
  return {
    hasName: true,
    windowText,
    hasPosition: positionMatchesText(stage?.screen_position, windowText),
  };
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
    const window = characterWindow(promptText, stage, stagedNames);
    if (!window?.hasName) {
      findings.push({
        ...baseFinding,
        message: `Prompt prose has no clause naming ${stage.name}.`,
      });
      continue;
    }
    if (!window.hasPosition) {
      findings.push({
        ...baseFinding,
        severity: "warning",
        message: `No positional cue for ${stage.name} (expected ${stage.screen_position}); soft check.`,
      });
    }
    const ref = stageRefIdCandidates(stage).map((id) => byRefId.get(id)).find(Boolean);
    const tokens = wardrobeEvidenceTokens(String(ref?.scene_prompt_anchor ?? ""));
    if (tokens.length) {
      const clauseText = normalizeToken(window.windowText);
      if (tokens.filter((token) => clauseText.includes(token)).length < Math.min(2, tokens.length)) {
        findings.push({
          ...baseFinding,
          severity: "warning",
          message: `Wardrobe for ${stage.name} not clearly carried in prose (paraphrase/missing); soft check.`,
        });
      }
    }
  }

  for (const clause of splitClauses(promptText)) {
    if (sharedWardrobeMerge(clause, stagedNames)) {
      findings.push({
        ...baseFinding,
        message: `Two staged characters share one wardrobe clause (bleed risk): "${clause.trim()}". Give each their own wardrobe clause.`,
      });
    }
  }

  return findings;
}
