function promptFields(prompt) {
  const seen = new Set();
  return ["image_prompt", "modelslab_image_prompt", "codex_image_prompt"]
    .map((field) => [field, String(prompt?.[field] ?? "")])
    .filter(([, value]) => value.trim())
    .filter(([field, value]) => {
      const key = value.trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function negativeLanguageMatches(value) {
  const text = String(value ?? "").toLowerCase();
  const patterns = [
    /--no\b/,
    /\bnegative\s+prompt\s*[:=]/,
  ];
  return patterns.filter((pattern) => pattern.test(text)).map(String);
}

export function negativePromptFindings(prompts) {
  const findings = [];
  for (const prompt of prompts) {
    for (const [field, rawValue] of Object.entries(prompt ?? {})) {
      if (!/(?:^|_)(negative_prompt|negativePrompt|avoid_list|avoidList|exclude_list|excludeList)(?:$|_)/.test(field)) continue;
      const value = Array.isArray(rawValue) ? rawValue.join(", ") : String(rawValue ?? "");
      if (!value.trim()) continue;
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "blocker",
        code: "negative_prompt",
        message: `${field} is a separate negative-prompt payload; keep all provider prompt content in the normal prompt fields and do not send a standalone negative prompt.`,
        target_field: field,
        resolved: false,
      });
    }
    for (const [field, value] of promptFields(prompt)) {
      const matches = negativeLanguageMatches(value);
      if (!matches.length) continue;
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "warning",
        code: "negative_prompt",
        message: `${field} appears to contain an embedded negative-prompt section or model argument: ${matches.join(", ")}`,
        target_field: field,
        resolved: false,
      });
    }
  }
  return findings;
}

export function beautyLanguageMatches(value) {
  const text = String(value ?? "");
  const patterns = [
    /\bcampus\s+goddess\b/i,
    /\bbreathtaking\s+adult\s+(?:campus\s+goddess|woman)\b/i,
    /\bgoddess\s+state\b/i,
    /\bgoddess\s+formal\s+styling\b/i,
    /\bhot\b/i,
    /\bsexy\b/i,
    /\bseductive\b/i,
    /\bsensual\b/i,
  ];
  return patterns.filter((pattern) => pattern.test(text)).map(String);
}

export function beautyLanguageFindings(prompts) {
  const findings = [];
  for (const prompt of prompts) {
    for (const [field, value] of promptFields(prompt)) {
      const matches = beautyLanguageMatches(value);
      if (!matches.length) continue;
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "warning",
        code: "beauty_language_risk",
        message: `${field} contains beauty/status shorthand that should be rewritten into concrete visual prose: ${matches.join(", ")}`,
        target_field: "people_clause",
        resolved: false,
      });
    }
  }
  return findings;
}

function countNameOccurrences(text, name) {
  const escaped = String(name ?? "").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  if (!escaped) return 0;
  const matches = String(text ?? "").match(new RegExp(`\\b${escaped}\\b`, "gi"));
  return matches ? matches.length : 0;
}

function characterDuplicationCueForName(text, name) {
  const escaped = String(name ?? "").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  if (!escaped) return false;
  const value = String(text ?? "");
  return [
    new RegExp(`\\b(?:duplicate|duplicated|second version|another version|same character again|same named character again|copy of|clone|twin|mirror version)\\s+(?:of\\s+)?${escaped}\\b`, "i"),
    new RegExp(`\\b${escaped}\\b[^.\\n]{0,80}\\b(?:second version|another version|same character again|same named character again|clone|twin|mirror version)\\b`, "i"),
  ].some((pattern) => pattern.test(value));
}

function isLikelyNamedCharacter(name) {
  const value = String(name ?? "").trim();
  if (!/[A-Z]/.test(value)) return false;
  if (/\b(?:crowd|audience|survivors?|guards?|officers?|workers?|customers?|families|witnesses|scryers|artificers|soldiers|students|extras)\b/i.test(value)) return false;
  return true;
}

export function namedCharacterDuplicationFindings(prompts) {
  const findings = [];
  const softDuplicationCue = /\b(?:split[- ]screen|split[- ]panel|panel grid|collage|montage|overlapping vignette)\b/i;
  for (const prompt of prompts) {
    const visibleCharacters = Array.isArray(prompt?.shot_manifest?.visible_characters) ? prompt.shot_manifest.visible_characters.filter(isLikelyNamedCharacter) : [];
    if (!visibleCharacters.length) continue;
    for (const [field, value] of promptFields(prompt)) {
      const softCue = softDuplicationCue.test(value);
      const duplicatedNames = visibleCharacters.filter((name) =>
        countNameOccurrences(value, name) >= 2
        && (characterDuplicationCueForName(value, name) || softCue)
      );
      if (!duplicatedNames.length) continue;
      const hardCue = duplicatedNames.some((name) => characterDuplicationCueForName(value, name));
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: hardCue ? "blocker" : "warning",
        code: "named_character_duplication_risk",
        message: `${field} appears to request more than one visible body for named character(s): ${duplicatedNames.join(", ")}.`,
        target_field: "people_clause",
        resolved: false,
      });
    }
  }
  return findings;
}
