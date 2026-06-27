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
    /\bno\b/,
    /\bnot\b/,
    /\bwithout\b/,
    /\bavoid\b/,
    /\bexclude\b/,
    /\binstead\s+of\b/,
    /\brather\s+than\b/,
    /\bdo\s+not\b/,
    /\bdon't\b/,
    /--no\b/,
    /\bnegative\s+prompt\b/,
  ];
  return patterns.filter((pattern) => pattern.test(text)).map(String);
}

export function negativePromptFindings(prompts) {
  const findings = [];
  for (const prompt of prompts) {
    for (const [field, value] of promptFields(prompt)) {
      const matches = negativeLanguageMatches(value);
      if (!matches.length) continue;
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "blocker",
        code: "negative_prompt",
        message: `${field} contains negative visual language and must be rewritten as positive construction: ${matches.join(", ")}`,
        target_field: "people_clause",
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

export function namedCharacterDuplicationFindings(prompts) {
  const findings = [];
  const hardDuplicationCue = /\b(?:duplicate|duplicated|second version|another version|same character again|same named character again|copy of|clone|twin|mirror version|reflection of)\b/i;
  const softDuplicationCue = /\b(?:split[- ]screen|split[- ]panel|panel grid|collage|montage|overlapping vignette)\b/i;
  for (const prompt of prompts) {
    const visibleCharacters = Array.isArray(prompt?.shot_manifest?.visible_characters) ? prompt.shot_manifest.visible_characters.filter(Boolean) : [];
    if (!visibleCharacters.length) continue;
    for (const [field, value] of promptFields(prompt)) {
      const hardCue = hardDuplicationCue.test(value);
      const softCue = softDuplicationCue.test(value);
      if (!hardCue && !softCue) continue;
      const duplicatedNames = visibleCharacters.filter((name) => countNameOccurrences(value, name) >= 2);
      if (!duplicatedNames.length) continue;
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
