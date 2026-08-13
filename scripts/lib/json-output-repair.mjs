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

export function removeInvalidMarkdownJsonEscapes(text) {
  const source = String(text ?? "");
  let repairCount = 0;
  const repaired = source.replace(/\\([_*\[\]()#+.!-])/g, (_match, character) => {
    repairCount += 1;
    return character;
  });
  return {
    text: repaired,
    repair_count: repairCount,
  };
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

export function removeStrayNumericValueQuotes(text) {
  const source = String(text ?? "");
  let output = "";
  let inString = false;
  let escaped = false;
  let repairCount = 0;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      let cursor = index + 1;
      while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
      const previous = output.trimEnd().at(-1);
      if (/[0-9]/.test(previous ?? "") && [",", "}", "]"].includes(source[cursor])) {
        repairCount += 1;
        continue;
      }
      inString = true;
    }
    output += character;
  }

  return {
    text: output,
    repair_count: repairCount,
  };
}

export function escapeJsonStringControlCharacters(text) {
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
    if (character === '"') {
      output += character;
      inString = false;
      continue;
    }
    const code = character.charCodeAt(0);
    if (code >= 0x20) {
      output += character;
      continue;
    }
    const replacement = character === "\n"
      ? "\\n"
      : character === "\r"
        ? "\\r"
        : character === "\t"
          ? "\\t"
          : character === "\b"
            ? "\\b"
            : character === "\f"
              ? "\\f"
              : `\\u${code.toString(16).padStart(4, "0")}`;
    output += replacement;
    repairCount += 1;
  }

  return { text: output, repair_count: repairCount };
}

function parseCandidate(candidate) {
  try {
    return {
      value: JSON.parse(candidate),
      syntax_repair: null,
    };
  } catch (originalError) {
    const markdownEscapes = removeInvalidMarkdownJsonEscapes(candidate);
    const repaired = escapeUnescapedJsonStringQuotes(candidate);
    const candidates = [];
    if (markdownEscapes.repair_count) {
      candidates.push({
        ...markdownEscapes,
        kind: "remove_invalid_markdown_json_escapes",
      });
      const markdownAndQuotes = escapeUnescapedJsonStringQuotes(markdownEscapes.text);
      if (markdownAndQuotes.repair_count) {
        candidates.push({
          text: markdownAndQuotes.text,
          repair_count: markdownEscapes.repair_count + markdownAndQuotes.repair_count,
          kind: "remove_markdown_escapes_and_escape_unescaped_quotes",
        });
      }
    }
    if (repaired.repair_count) {
      candidates.push({
        ...repaired,
        kind: "escape_unescaped_string_quotes",
      });
    }
    const numeric = removeStrayNumericValueQuotes(candidate);
    if (numeric.repair_count) {
      candidates.push({
        ...numeric,
        kind: "remove_stray_numeric_value_quotes",
      });
    }
    const controls = escapeJsonStringControlCharacters(candidate);
    if (controls.repair_count) {
      candidates.push({
        ...controls,
        kind: "escape_json_string_control_characters",
      });
      const quoteAndControls = escapeJsonStringControlCharacters(repaired.text);
      if (repaired.repair_count && quoteAndControls.repair_count) {
        candidates.push({
          text: quoteAndControls.text,
          repair_count: repaired.repair_count + quoteAndControls.repair_count,
          kind: "escape_unescaped_quotes_and_control_characters",
        });
      }
    }
    for (const syntaxCandidate of candidates) {
      try {
        return {
          value: JSON.parse(syntaxCandidate.text),
          syntax_repair: {
            schema: "goldflow_json_syntax_repair_v1",
            kind: syntaxCandidate.kind,
            repair_count: syntaxCandidate.repair_count,
          },
        };
      } catch {}
    }
    throw originalError;
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
