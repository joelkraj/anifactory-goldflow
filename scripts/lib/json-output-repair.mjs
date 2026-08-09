function quoteCanTerminateJsonString(text, quoteIndex) {
  let cursor = quoteIndex + 1;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  if (cursor >= text.length) return true;
  const next = text[cursor];
  if (next !== ",") return [":", "}", "]"].includes(next);

  // A quoted phrase inside prose can legitimately end before a comma. Treat
  // the quote as structural only when the token after that comma can begin the
  // next JSON value or object property.
  cursor += 1;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  if (cursor >= text.length) return true;
  return ["\"", "{", "[", "}", "]"].includes(text[cursor])
    || /[-0-9tfn]/.test(text[cursor]);
}

export function escapeUnescapedJsonStringQuotes(text) {
  const source = String(text ?? "");
  let output = "";
  let inString = false;
  let escaped = false;
  let repairCount = 0;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (!inString) {
      output += character;
      if (character === '"') inString = true;
      continue;
    }
    if (escaped) {
      output += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      output += character;
      escaped = true;
      continue;
    }
    if (character !== '"') {
      output += character;
      continue;
    }
    if (quoteCanTerminateJsonString(source, index)) {
      output += character;
      inString = false;
      continue;
    }
    output += '\\"';
    repairCount += 1;
  }

  return {
    text: output,
    repair_count: repairCount,
  };
}

function parseCandidate(candidate) {
  try {
    return {
      value: JSON.parse(candidate),
      syntax_repair: null,
    };
  } catch (originalError) {
    const repaired = escapeUnescapedJsonStringQuotes(candidate);
    if (!repaired.repair_count) throw originalError;
    try {
      return {
        value: JSON.parse(repaired.text),
        syntax_repair: {
          schema: "goldflow_json_syntax_repair_v1",
          kind: "escape_unescaped_string_quotes",
          repair_count: repaired.repair_count,
        },
      };
    } catch {
      throw originalError;
    }
  }
}

export function parseJsonObjectFromPlannerOutput(text) {
  const raw = String(text ?? "").trim();
  const candidates = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));

  let lastError = null;
  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    try {
      return parseCandidate(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  throw new Error(`LLM output did not contain JSON: ${raw.slice(0, 600)}`);
}
