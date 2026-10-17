import { createHash } from "node:crypto";

export const COHERENT_SUBMISSION_POLICY = "coherent_thought_groups_v1";
export const SUBMISSION_RISK_SCHEMA = "goldflow_narration_submission_risks_v1";
const sha256 = (text) => createHash("sha256").update(String(text)).digest("hex");

// This is a review inventory, not a text rewriter. Context and exact receipt
// chains decide pronunciation; a regex cannot decide what "I'd" means.
export function narrationSubmissionRisks(unit = {}) {
  const source = String(unit.source_text ?? unit.caption_text ?? "");
  const spoken = String(unit.spoken_text ?? unit.tts_spoken_text ?? "");
  const rows = [];
  const add = (category, match, disposition) => {
    const start = match.index;
    const end = start + match[0].length;
    rows.push({
      risk_id: `submission_${sha256(`${unit.unit_id ?? ""}\0${source}\0${category}\0${start}\0${end}`).slice(0, 20)}`,
      category,
      source_start: start,
      source_end: end,
      source_text: match[0],
      context: source.slice(Math.max(0, start - 80), Math.min(source.length, end + 80)),
      source_text_sha256: sha256(source),
      spoken_text_sha256: sha256(spoken),
      disposition,
    });
  };
  const patterns = [
    ["currency", /[$£€¥]\s*\d[\d,]*(?:\.\d+)?/g, "verify_currency_unit_and_decimal_reading"],
    ["decimal", /\b\d[\d,]*\.\d+\b/g, "verify_decimal_value_and_context"],
    ["percentage", /\b\d[\d,]*(?:\.\d+)?\s*%/g, "verify_percent_spoken_form"],
    ["ratio_date_or_time", /\b\d+(?:[/:]\d+)+\b/g, "context_required_do_not_assume_ratio_or_clock"],
    ["rank", /\b(?:[A-Z]{1,3}[- ]rank|rank[- :]+[A-Z]{1,3})\b/g, "verify_letters_and_rank_context"],
    ["initialism_or_capitalized_word", /\b[A-Z]{2,}\b/g, "verify_initialism_or_word_do_not_spell_all_caps_generically"],
    ["ambiguous_contraction", /\b(?:I|you|he|she|it|we|they)['’]d\b/gi, "retain_contraction_or_author_exact_contextual_override_no_blanket_expansion"],
    ["quotation", /["“”]/g, "preserve_dialogue_meaning_not_an_automatic_request_boundary"],
    ["ellipsis", /\.{3,}|…+/g, "review_intentional_hesitation_do_not_flatten_globally"],
    ["dash", /—|–|--/g, "review_interruption_or_aside_do_not_flatten_globally"],
    ["line_break", /\r?\n+/g, "formatting_alone_is_not_a_spoken_pause"],
    ["repetition", /\b([\p{L}]+)(?:[\s,]+\1)\b/giu, "preserve_approved_repetition_no_automatic_deletion"],
  ];
  for (const [category, pattern, disposition] of patterns) {
    for (const match of source.matchAll(pattern)) add(category, match, disposition);
  }
  const numberWord = "(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)";
  const spokenValue = `${numberWord}(?:[- ](?:${numberWord}|and|point))*`;
  for (const match of source.matchAll(new RegExp(`\\b${spokenValue} (?:dollars?|cents?|pounds?|euros?|yen|percent)\\b`, "gi"))) {
    add("written_out_value", match, "verify_existing_spoken_amount_preserve_exact_words");
  }
  for (const term of new Set(unit.protected_terms ?? [])) {
    if (!String(term).trim()) continue;
    let cursor = 0;
    while (cursor < source.length) {
      const start = source.indexOf(String(term), cursor);
      if (start < 0) break;
      add("protected_term", Object.assign([String(term)], { index: start }), "retain_name_or_term_unless_exact_pronunciation_override_is_justified");
      cursor = start + String(term).length;
    }
  }
  if (source.trim() && source.trim().split(/\s+/).length < 8) {
    add("short_source_component", Object.assign([source], { index: 0 }), "review_connected_thought_or_intentional_short_line_no_hard_minimum");
  }
  return rows.sort((a, b) => a.source_start - b.source_start || a.category.localeCompare(b.category));
}

export function narrationSubmissionPayloadBlockers(spokenText) {
  const text = String(spokenText ?? "");
  const codes = [];
  if (/[$£€¥%]/u.test(text)) codes.push("unresolved_currency_or_percent_symbol_in_spoken_text");
  if (/<\/?(?:speak|voice|prosody|break|emphasis|phoneme|say-as|sub|audio|lang)\b[^>]*>/i.test(text)
    || /(?:^|\n)\s*(?:speaker\s*\d*|narrator|delivery|emotion|instruction)\s*:/i.test(text)
    || /\[[^\]\n]+\]/u.test(text)
    || /<\|[^|]+\|>/u.test(text)) {
    codes.push("submission_instruction_or_markup_leak");
  }
  return codes;
}

export function buildNarrationSubmissionRiskLedger(units = []) {
  const entries = units.flatMap((unit) => narrationSubmissionRisks(unit).map((row) => ({ unit_id: unit.unit_id, ...row })));
  const ledger = {
    schema: SUBMISSION_RISK_SCHEMA,
    policy: "Inventory only: author context-sensitive exact TTS-only overrides when warranted; preserve approved words, repetition and intentional punctuation. Structural lineage validation remains mandatory.",
    entry_count: entries.length,
    category_counts: Object.fromEntries([...new Set(entries.map((row) => row.category))].sort().map((category) => [category, entries.filter((row) => row.category === category).length])),
    entries,
  };
  return { ...ledger, ledger_sha256: sha256(JSON.stringify(ledger)) };
}
