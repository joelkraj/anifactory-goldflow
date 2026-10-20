export const DEFAULT_SOURCE_WRITER_POLICY = "single_6_sol_pro_v1";
export const THREE_6_SOL_WRITER_POLICY = "three_6_sol_pro_v1";
export const HISTORICAL_THREE_56_WRITER_POLICY = "three_56_pro_v1";
export const LEGACY_SOURCE_WRITER_POLICY = "six_dual_pro_v1";
export const GPT6_COMPARISON_WRITER_POLICY = "six_56_6_pro_v1";

const legacyCandidates = Object.freeze([
  ["draft_56_1", "candidate_a", "gpt-5.6-sol"],
  ["draft_55_1", "candidate_b", "gpt-5.5"],
  ["draft_56_2", "candidate_c", "gpt-5.6-sol"],
  ["draft_55_2", "candidate_d", "gpt-5.5"],
  ["draft_56_3", "candidate_e", "gpt-5.6-sol"],
  ["draft_55_3", "candidate_f", "gpt-5.5"],
].map(([id, blind_id, model]) => Object.freeze({ id, blind_id, model, provider: "chatgpt_web" })));

const currentCandidates = Object.freeze(legacyCandidates.filter((row) => row.model === "gpt-5.6-sol")
  .map((row) => Object.freeze({ ...row, model: "gpt-6-sol" })));
const gpt6Candidates = Object.freeze(legacyCandidates.map((row) => Object.freeze({
  ...row,
  id: row.id.replace("draft_55_", "draft_6_"),
  model: "gpt-6-sol",
})));

// The one-draft default keeps the Pro writer's exact model contract and the historical first ID.
const singleCandidates = Object.freeze([currentCandidates[0]]);

function inferredHistoricalPolicy(portfolio) {
  const candidates = Array.isArray(portfolio?.candidates) ? portfolio.candidates : null;
  if (!candidates) return null;
  if (candidates.some((row) => row.model === "gpt-5.5")) return LEGACY_SOURCE_WRITER_POLICY;
  // Unlabelled three-draft portfolios predate the single-draft default.
  if (candidates.length === 3) return candidates.some((row) => row.model === "gpt-5.6-sol") ? HISTORICAL_THREE_56_WRITER_POLICY : THREE_6_SOL_WRITER_POLICY;
  return null;
}

export function sourceWriterPolicy(portfolio = null, requestedPolicy = null) {
  // Completed historical portfolios keep their original identities, never new spend.
  if (portfolio?.writer_policy && requestedPolicy && portfolio.writer_policy !== requestedPolicy) {
    throw new Error("Requested writer policy does not match the recorded portfolio.");
  }
  const name = portfolio?.writer_policy ?? requestedPolicy ?? inferredHistoricalPolicy(portfolio) ?? DEFAULT_SOURCE_WRITER_POLICY;
  if (![DEFAULT_SOURCE_WRITER_POLICY, THREE_6_SOL_WRITER_POLICY, HISTORICAL_THREE_56_WRITER_POLICY, LEGACY_SOURCE_WRITER_POLICY, GPT6_COMPARISON_WRITER_POLICY].includes(name)) throw new Error(`Unknown writer policy: ${name}`);
  if (name === DEFAULT_SOURCE_WRITER_POLICY) return { name, candidates: singleCandidates };
  if (name === GPT6_COMPARISON_WRITER_POLICY) return { name, candidates: gpt6Candidates };
  if (name === LEGACY_SOURCE_WRITER_POLICY) return { name, candidates: legacyCandidates };
  if (name === HISTORICAL_THREE_56_WRITER_POLICY) return { name, candidates: legacyCandidates.filter((row) => row.model === "gpt-5.6-sol") };
  return { name, candidates: currentCandidates };
}

export function improvementEfforts(value = "medium,high", maxRounds = 2) {
  const efforts = String(value).split(",").map((part) => part.trim());
  if (!efforts.length || efforts.some((effort) => !["medium", "high"].includes(effort))) {
    throw new Error("Improvement editors support only medium or high; Pro is reserved for drafts.");
  }
  return Array.from({ length: maxRounds }, (_, index) => efforts[Math.min(index, efforts.length - 1)]);
}
