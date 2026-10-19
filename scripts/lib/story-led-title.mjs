// Creative hook selection belongs to the planner, never a keyword-scoring heuristic.
export const STORY_LED_TITLE_POLICY = "story_led_hooks_v1";
const clean = value => String(value ?? "").trim();
export function validateStoryLedTitle(title, contract, { sourceText, requireSourceQuotes = false } = {}) {
  const blockers = [];
  const value = clean(title).toLowerCase();
  for (const field of ["primary_hook", "hook_phrase", "payoff_phrase", "why_this_hook"]) {
    if (!clean(contract?.[field])) blockers.push(`title_hook_${field}_missing`);
  }
  for (const field of ["hook_phrase", "payoff_phrase"]) {
    if (clean(contract?.[field]) && !value.includes(clean(contract[field]).toLowerCase())) blockers.push(`title_hook_${field}_not_in_title`);
  }
  const support = Array.isArray(contract?.story_support) ? contract.story_support : [];
  if (!support.length) blockers.push("title_hook_story_support_missing");
  for (const phrase of [contract?.hook_phrase, contract?.payoff_phrase].map(clean).filter(Boolean)) {
    if (!support.some(row => clean(row?.title_phrase).toLowerCase() === phrase.toLowerCase())) blockers.push("title_hook_claim_support_missing");
  }
  if (requireSourceQuotes && !clean(sourceText)) blockers.push("title_hook_locked_script_missing");
  for (const row of support) {
    if (!clean(row?.title_phrase) || !value.includes(clean(row.title_phrase).toLowerCase()) || !clean(row?.evidence)) blockers.push("title_hook_support_invalid");
    if (requireSourceQuotes && (!clean(row?.source_quote) || !String(sourceText ?? "").includes(clean(row.source_quote)))) blockers.push("title_hook_source_quote_not_in_script");
  }
  // Exact quotation proves provenance, not the semantic truth of a claim. Editorial review still applies.
  return [...new Set(blockers)];
}
