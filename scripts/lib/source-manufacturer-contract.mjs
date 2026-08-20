import { createHash } from "node:crypto";

export const MANUFACTURING_BRIEF_SCHEMA = "goldflow_manhwa_manufacturing_brief_v1";
export const MANUFACTURING_TOPIC_POOL_SCHEMA = "goldflow_manhwa_topic_pool_v1";
export const MANUFACTURING_TOPIC_SHORTLIST_SCHEMA = "goldflow_manhwa_topic_shortlist_v1";
export const MANUFACTURING_PORTFOLIO_SCHEMA = "goldflow_manhwa_manufacturing_portfolio_v1";
export const MANUFACTURING_SELECTION_SCHEMA = "goldflow_manhwa_manufacturing_selection_v1";
export const MANUFACTURING_VIEWER_IDS = Object.freeze([
  "core_binge_fast",
  "core_binge_payoff",
  "core_binge_progression",
  "core_binge_revenge",
  "casual_mobile_impatient",
  "casual_mobile_distracted",
  "casual_mobile_title_literal",
  "casual_mobile_low_lore",
  "betrayal_fantasy",
  "revenge_payoff",
  "system_progression",
  "power_scaling",
  "emotional_relationship",
  "strategic_outplay",
  "longform_completion",
  "ad_break_sensitive",
  "repetition_sensitive",
  "ai_slop_skeptic",
  "cold_listener",
  "late_payoff_skeptic",
]);

export function sha256Text(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function text(value) {
  return String(value ?? "").trim();
}

function sha(value) {
  return /^[a-f0-9]{64}$/i.test(text(value));
}

export function validateManufacturingBrief(document) {
  const blockers = [];
  if (document?.schema !== MANUFACTURING_BRIEF_SCHEMA) blockers.push("manufacturing_brief_schema_invalid");
  if (document?.status !== "approved") blockers.push("manufacturing_brief_not_approved");
  for (const field of ["title", "core_premise", "opening_target", "approved_by", "approved_at"]) {
    if (!text(document?.[field])) blockers.push(`manufacturing_brief_${field}_missing`);
  }
  if (!Number.isInteger(Number(document?.target_word_count)) || Number(document.target_word_count) < 1_000) blockers.push("manufacturing_brief_target_word_count_invalid");
  if (!Array.isArray(document?.genre_elements) || document.genre_elements.length < 1) blockers.push("manufacturing_brief_genre_elements_missing");
  if (!text(document?.reference_outlier?.url) || !text(document?.reference_outlier?.title)) blockers.push("manufacturing_brief_reference_outlier_missing");
  return { done: blockers.length === 0, blockers };
}

export function parseManufacturingTopicTitles(value) {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(\d{1,3})[.)]\s+(.+?)\s*$/))
    .filter(Boolean)
    .map((match) => ({ number: Number(match[1]), title: match[2] }));
}

export function validateManufacturingTopicPool(document) {
  const blockers = [];
  if (document?.schema !== MANUFACTURING_TOPIC_POOL_SCHEMA) blockers.push("manufacturing_topic_pool_schema_invalid");
  if (document?.status !== "completed") blockers.push("manufacturing_topic_pool_not_completed");
  const candidates = Array.isArray(document?.candidates) ? document.candidates : [];
  if (candidates.length !== 30) blockers.push("manufacturing_topic_pool_count_invalid");
  const numbers = candidates.map((row) => Number(row?.number));
  const titles = candidates.map((row) => text(row?.title).toLowerCase());
  if (new Set(numbers).size !== candidates.length || numbers.some((number, index) => number !== index + 1)) blockers.push("manufacturing_topic_pool_numbering_invalid");
  if (new Set(titles).size !== candidates.length || titles.some((title) => !title)) blockers.push("manufacturing_topic_pool_titles_invalid");
  if (!sha(document?.evidence_sha256) || !sha(document?.raw_response_sha256)) blockers.push("manufacturing_topic_pool_hash_invalid");
  return { done: blockers.length === 0, blockers };
}

export function validateManufacturingTemplate(template) {
  const blockers = [];
  const value = text(template);
  if (!value) blockers.push("manufacturing_template_empty");
  for (const placeholder of ["[WORD COUNT]", "[TITLE]", "[CORE PREMISE]"]) {
    if (!value.includes(placeholder)) blockers.push(`manufacturing_template_placeholder_missing_${sha256Text(placeholder).slice(0, 8)}`);
  }
  for (const sentinel of [
    "The first forty words must fully show",
    "The first eighty words must clearly establish",
    "The first one hundred twenty words must reveal",
    "Within the first three hundred words",
    "Within the first six hundred words",
    "Every five hundred to eight hundred words",
    "Output only the raw narration script.",
  ]) {
    if (!value.includes(sentinel)) blockers.push(`manufacturing_template_sentinel_missing_${sha256Text(sentinel).slice(0, 8)}`);
  }
  return { done: blockers.length === 0, blockers };
}

export function validateManufacturingTopicShortlist(document, { topicPool = null } = {}) {
  const blockers = [];
  if (document?.schema !== MANUFACTURING_TOPIC_SHORTLIST_SCHEMA) blockers.push("manufacturing_topic_shortlist_schema_invalid");
  if (document?.status !== "shortlisted") blockers.push("manufacturing_topic_shortlist_not_completed");
  const rankings = Array.isArray(document?.rankings) ? document.rankings : [];
  if (rankings.length !== 10) blockers.push("manufacturing_topic_shortlist_count_invalid");
  const candidates = new Map((topicPool?.candidates ?? []).map((row) => [Number(row.number), row.title]));
  const seen = new Set();
  for (const [index, row] of rankings.entries()) {
    const rank = Number(row?.rank);
    const number = Number(row?.candidate_number);
    if (rank !== index + 1) blockers.push(`manufacturing_topic_shortlist_rank_${index}_invalid`);
    if (!candidates.has(number) || candidates.get(number) !== row?.title) blockers.push(`manufacturing_topic_shortlist_rank_${index}_candidate_mismatch`);
    if (seen.has(number)) blockers.push(`manufacturing_topic_shortlist_rank_${index}_duplicate`);
    seen.add(number);
    for (const field of ["core_premise", "opening_target", "demand_transfer", "why_it_can_win"]) {
      if (!text(row?.[field])) blockers.push(`manufacturing_topic_shortlist_rank_${index}_${field}_missing`);
    }
    if (!["low", "medium", "high"].includes(row?.complexity_risk)) blockers.push(`manufacturing_topic_shortlist_rank_${index}_complexity_risk_invalid`);
  }
  return { done: blockers.length === 0, blockers };
}

export function validateFilledManufacturingPrompt(prompt, { brief = null, baseTemplate = null } = {}) {
  const blockers = [];
  const value = text(prompt);
  if (!value) blockers.push("manufacturing_prompt_empty");
  if (brief?.title && !value.includes(brief.title)) blockers.push("manufacturing_prompt_title_missing");
  if (brief?.core_premise && !value.includes(brief.core_premise)) blockers.push("manufacturing_prompt_core_premise_missing");
  if (/\[[A-Z][A-Z0-9 ,/'-]{2,}\]/.test(value)) blockers.push("manufacturing_prompt_unfilled_placeholders");
  for (const sentinel of [
    "The first forty words must fully show",
    "The first eighty words must clearly establish",
    "The first one hundred twenty words must reveal",
    "Within the first three hundred words",
    "Within the first six hundred words",
    "Every five hundred to eight hundred words",
    "Output only the raw narration script.",
  ]) {
    if (!value.includes(sentinel)) blockers.push(`manufacturing_prompt_sentinel_missing_${sha256Text(sentinel).slice(0, 8)}`);
  }
  if (baseTemplate && value.length < Math.floor(String(baseTemplate).length * 0.75)) blockers.push("manufacturing_prompt_template_truncated");
  return { done: blockers.length === 0, blockers };
}

export function validateManufacturingPortfolio(document, { promptSha256 = null, expectedCandidates = [] } = {}) {
  const blockers = [];
  if (document?.schema !== MANUFACTURING_PORTFOLIO_SCHEMA) blockers.push("manufacturing_portfolio_schema_invalid");
  if (document?.status !== "completed") blockers.push("manufacturing_portfolio_not_completed");
  if (promptSha256 && document?.filled_prompt_sha256 !== promptSha256) blockers.push("manufacturing_portfolio_prompt_hash_mismatch");
  const rows = Array.isArray(document?.candidates) ? document.candidates : [];
  if (rows.length !== expectedCandidates.length) blockers.push("manufacturing_portfolio_candidate_count_mismatch");
  const ids = rows.map((row) => row?.id);
  if (new Set(ids).size !== ids.length) blockers.push("manufacturing_portfolio_candidate_ids_duplicate");
  for (const spec of expectedCandidates) {
    const row = rows.find((candidate) => candidate?.id === spec.id);
    if (!row) {
      blockers.push(`manufacturing_portfolio_${spec.id}_missing`);
      continue;
    }
    if (row.model !== spec.model || row.provider !== spec.provider || row.reasoning_effort !== "max") blockers.push(`manufacturing_portfolio_${spec.id}_model_contract_mismatch`);
    if (!sha(row.output_sha256) || !sha(row.receipt_sha256) || !sha(row.prompt_sha256)) blockers.push(`manufacturing_portfolio_${spec.id}_hash_invalid`);
    if (!text(row.output_path) || !text(row.receipt_path)) blockers.push(`manufacturing_portfolio_${spec.id}_path_missing`);
    if (!Number.isInteger(row.word_count) || row.word_count < 1) blockers.push(`manufacturing_portfolio_${spec.id}_empty`);
  }
  return { done: blockers.length === 0, blockers };
}

export function validateManufacturingSelection(document, { portfolio = null } = {}) {
  const blockers = [];
  if (document?.schema !== MANUFACTURING_SELECTION_SCHEMA) blockers.push("manufacturing_selection_schema_invalid");
  if (document?.status !== "selected") blockers.push("manufacturing_selection_not_selected");
  const candidates = Array.isArray(portfolio?.candidates) ? portfolio.candidates : [];
  const expected = new Map(candidates.map((row) => [row.blind_id, row]));
  if (!expected.has(document?.selected_blind_id)) blockers.push("manufacturing_selection_winner_unknown");
  const rankings = Array.isArray(document?.rankings) ? document.rankings : [];
  if (rankings.length !== expected.size) blockers.push("manufacturing_selection_ranking_count_mismatch");
  const ranks = rankings.map((row) => Number(row?.rank));
  if (new Set(ranks).size !== rankings.length) blockers.push("manufacturing_selection_ranks_duplicate");
  for (const [index, row] of rankings.entries()) {
    if (!expected.has(row?.blind_id)) blockers.push(`manufacturing_selection_ranking_${index}_unknown`);
    if (!Number.isInteger(Number(row?.rank)) || Number(row.rank) < 1 || Number(row.rank) > expected.size) blockers.push(`manufacturing_selection_ranking_${index}_rank_invalid`);
    const viewers = Array.isArray(row?.viewer_simulation) ? row.viewer_simulation : [];
    const viewerIds = viewers.map((viewer) => viewer?.viewer_id);
    for (const viewerId of MANUFACTURING_VIEWER_IDS) if (!viewerIds.includes(viewerId)) blockers.push(`manufacturing_selection_ranking_${index}_${viewerId}_missing`);
    if (viewers.length !== MANUFACTURING_VIEWER_IDS.length || new Set(viewerIds).size !== viewers.length) blockers.push(`manufacturing_selection_ranking_${index}_viewer_set_invalid`);
    for (const viewer of viewers) {
      const percentage = Number(viewer?.predicted_percentage_viewed);
      if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) blockers.push(`manufacturing_selection_ranking_${index}_viewer_percentage_invalid`);
      if (!text(viewer?.reason)) blockers.push(`manufacturing_selection_ranking_${index}_viewer_reason_missing`);
      if (!text(viewer?.predicted_exit_point)) blockers.push(`manufacturing_selection_ranking_${index}_viewer_exit_point_missing`);
    }
    const survival = row?.opening_survival_curve ?? {};
    for (const checkpoint of ["thirty_seconds", "sixty_seconds", "two_minutes", "five_minutes"]) {
      const percentage = Number(survival?.[checkpoint]);
      if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) blockers.push(`manufacturing_selection_ranking_${index}_${checkpoint}_invalid`);
    }
    const average = Number(row?.predicted_average_percentage_viewed);
    if (!Number.isFinite(average) || average < 0 || average > 100) blockers.push(`manufacturing_selection_ranking_${index}_average_invalid`);
    if (viewers.length === MANUFACTURING_VIEWER_IDS.length) {
      const computed = viewers.reduce((sum, viewer) => sum + Number(viewer.predicted_percentage_viewed), 0) / viewers.length;
      if (Math.abs(computed - average) > 0.11) blockers.push(`manufacturing_selection_ranking_${index}_average_mismatch`);
    }
    if (!text(row?.retention_reason)) blockers.push(`manufacturing_selection_ranking_${index}_retention_reason_missing`);
  }
  const ordered = [...rankings].sort((left, right) => Number(left.rank) - Number(right.rank));
  for (let index = 1; index < ordered.length; index += 1) {
    if (Number(ordered[index - 1]?.predicted_average_percentage_viewed) < Number(ordered[index]?.predicted_average_percentage_viewed)) blockers.push(`manufacturing_selection_rank_${index}_apv_order_invalid`);
  }
  if (ordered[0]?.blind_id !== document?.selected_blind_id) blockers.push("manufacturing_selection_winner_not_rank_one");
  if (!text(document?.decision_rationale)) blockers.push("manufacturing_selection_rationale_missing");
  return { done: blockers.length === 0, blockers };
}
