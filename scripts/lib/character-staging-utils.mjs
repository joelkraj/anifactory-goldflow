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

function escapedNamePattern(name) {
  return String(name ?? "")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
}

function sharedWardrobeMerge(clause, stagedNames) {
  const normalizedClause = normalizeToken(clause);
  const present = stagedNames.filter((name) => new RegExp(`\\b${escapedNamePattern(name)}\\b`, "i").test(normalizedClause));
  if (present.length < 2) return false;
  const wardrobePattern = WARDROBE_KEYWORDS.map((keyword) => `${keyword}s?`).join("|");
  const wardrobeRegex = new RegExp(`\\b(?:${wardrobePattern})\\b`, "i");
  const hasWardrobe = wardrobeRegex.test(normalizedClause);
  if (!hasWardrobe) return false;
  const sharedWardrobeCue = /\b(matching|same|identical|shared|coordinated)\b/i.test(normalizedClause);
  const wardrobeVerbPattern = "\\b(?:wear|wears|wearing|wore|dressed|clad|outfitted|in|share|shares|sharing)\\b";
  const bothShareWardrobe = new RegExp(`\\b(?:both|each)\\b.{0,80}${wardrobeVerbPattern}.{0,100}\\b(?:${wardrobePattern})\\b`, "i").test(normalizedClause);
  const pairSharesWardrobe = present.some((left) => present.some((right) => {
    if (left === right) return false;
    const pairPattern = `\\b${escapedNamePattern(left)}\\s+(?:and|&|with)\\s+${escapedNamePattern(right)}\\b`;
    const pairThenWardrobe = new RegExp(`${pairPattern}.{0,100}${wardrobeVerbPattern}.{0,100}\\b(?:${wardrobePattern})\\b`, "i").test(normalizedClause);
    const pairWithSharedCue = new RegExp(pairPattern, "i").test(normalizedClause) && sharedWardrobeCue;
    return pairThenWardrobe || pairWithSharedCue;
  }));
  return bothShareWardrobe || pairSharesWardrobe;
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

function characterNameAliases(value) {
  const name = normalizeCharacterName(value);
  const aliases = new Set([name]);
  const baseBeforeContext = name
    .replace(/\b(?:in|on|inside)\s+(?:crown night|sponsor|headset|meme|thumbnail|mockup|mockups|printout|printouts|screen|clip|replay|media frame|panel|monitor).*/i, "")
    .trim();
  if (baseBeforeContext) aliases.add(baseBeforeContext);
  if (/\bstudents?\b/i.test(name)) {
    aliases.add("students");
    aliases.add("student");
  }
  if (/\baudience\b/i.test(name)) aliases.add("audience");
  if (/\b(?:clip|replay|mockup|mockups|printout|printouts|thumbnail|thumbnails)\b/i.test(name)) {
    aliases.add(name.replace(/\b(?:in|on|inside)\b.*$/i, "").trim());
    if (/\bjoey\b/i.test(name)) {
      aliases.add("old joey");
      aliases.add("past joey");
      aliases.add("replayed joey");
      aliases.add("joey past self");
      aliases.add("joey s past self");
    }
  }
  if (/\bon\s+screen\b|\bscreen\b|\bheadset\b|\bmonitor\b|\bpanel\b/i.test(name)) {
    aliases.add(name.replace(/\b(?:on|inside)\s+(?:screen|headset screen|monitor|panel)\b.*$/i, "").trim());
  }
  return [...aliases].map((alias) => normalizeToken(alias)).filter(Boolean);
}

function clauseMatchesCharacterName(clause, name) {
  const normalizedClause = normalizeToken(clause);
  const aliases = characterNameAliases(name);
  if (aliases.some((alias) => new RegExp(`\\b${alias.replace(/\s+/g, "\\s+")}\\b`, "i").test(normalizedClause))) return true;
  const nameTokens = significantTokens(name, 8);
  if (/\bstudent pushing cart\b/i.test(name)) return /\bstudent\b.*\bcart\b|\bcart\b.*\bstudent\b/i.test(normalizedClause);
  if (/\b(?:clip|replay|mockup|mockups|printout|printouts|thumbnail|thumbnails|screen|monitor|panel)\b/i.test(name)) {
    const baseTokens = nameTokens.filter((token) => !["crown", "night", "clip", "replay", "mockup", "mockups", "printout", "printouts", "thumbnail", "thumbnails", "screen", "monitor", "panel", "headset"].includes(token));
    const contextHit = /\b(?:old|past|replay|replayed|screen|monitor|panel|clip|mockup|thumbnail|printout)\b/i.test(normalizedClause);
    if (contextHit && baseTokens.some((token) => normalizedClause.includes(token))) return true;
  }
  const usefulTokens = nameTokens.filter((token) => !["class", "crown", "night"].includes(token));
  if (usefulTokens.length && usefulTokens.every((token) => normalizedClause.includes(token))) return true;
  return false;
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
    for (const id of [ref?.state_ref_id, ref?.source_ref_id, ref?.base_identity_ref_id, ref?.ref_id].filter(Boolean)) {
      byId.set(String(id), ref);
    }
  }
  return byId;
}

function referenceIsAttachable(ref) {
  return Boolean(ref?.reference_image_path || ref?.required_reference_path || ref?.resolved_reference_image_path);
}

function stageHasAttachableRef(stage, byRefId) {
  return stageRefIdCandidates(stage).some((id) => referenceIsAttachable(byRefId.get(id)));
}

function genericOrGroupStageName(name) {
  return /\b(?:agents?|guards?|workers?|owners?|executives?|passengers?|employees?|students?|people|crowd|clerks?|staff|team|representatives?|moderators?|editors?|musicians?|girls?|boys?|men|women|clients?|shareholders?|board members?)\b/i.test(String(name ?? ""));
}

function characterWindow(promptText, stage, stagedNames) {
  const name = normalizeCharacterName(stage?.name);
  if (!name) return null;
  const others = stagedNames.filter((other) => other !== name);
  const clauses = splitClauses(promptText);
  const index = clauses.findIndex((clause) => clauseMatchesCharacterName(clause, stage?.name));
  if (index === -1) return { hasName: false };
  let end = index;
  for (let current = index + 1; current < clauses.length; current += 1) {
    if (others.some((other) => clauseMatchesCharacterName(clauses[current], other))) break;
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
      const softClause = !stageHasAttachableRef(stage, byRefId) || genericOrGroupStageName(stage.name);
      findings.push({
        ...baseFinding,
        severity: softClause ? "warning" : "blocker",
        resolved: softClause,
        generic_or_text_only_people_clause: softClause,
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
