export const DEFAULT_SOURCE_WRITER_POLICY = "three_56_pro_v1";
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

const gpt6Candidates = Object.freeze(legacyCandidates.map((row) => Object.freeze(row.model === "gpt-5.5"
  ? { ...row, id: row.id.replace("draft_55_", "draft_6_"), model: "gpt-6-astra" }
  : { ...row })));

export function sourceWriterPolicy(portfolio = null, requestedPolicy = null) {
  // Completed historical portfolios keep their original identities, never new spend.
  if (portfolio?.writer_policy && requestedPolicy && portfolio.writer_policy !== requestedPolicy) {
    throw new Error("Requested writer policy does not match the recorded portfolio.");
  }
  const name = portfolio?.writer_policy ?? requestedPolicy ?? (portfolio?.candidates?.some((row) => row.model === "gpt-5.5")
    ? LEGACY_SOURCE_WRITER_POLICY : DEFAULT_SOURCE_WRITER_POLICY);
  if (![DEFAULT_SOURCE_WRITER_POLICY, LEGACY_SOURCE_WRITER_POLICY, GPT6_COMPARISON_WRITER_POLICY].includes(name)) throw new Error(`Unknown writer policy: ${name}`);
  if (name === GPT6_COMPARISON_WRITER_POLICY) return { name, candidates: gpt6Candidates };
  return { name, candidates: name === LEGACY_SOURCE_WRITER_POLICY
    ? legacyCandidates : legacyCandidates.filter((row) => row.model === "gpt-5.6-sol") };
}

export function improvementEfforts(value = "medium,high", maxRounds = 2) {
  const efforts = String(value).split(",").map((part) => part.trim());
  if (!efforts.length || efforts.some((effort) => !["medium", "high"].includes(effort))) {
    throw new Error("Improvement editors support only medium or high; Pro is reserved for drafts.");
  }
  return Array.from({ length: maxRounds }, (_, index) => efforts[Math.min(index, efforts.length - 1)]);
}
