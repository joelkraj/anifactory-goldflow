import { createHash } from "node:crypto";

export const ANALYTICS_LEARNING_PROPOSAL_SCHEMA = "goldflow_analytics_learning_proposal_v1";
export const ANALYTICS_LEARNING_APPROVAL_SCHEMA = "goldflow_analytics_learning_approval_v1";

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function clean(value) {
  return String(value ?? "").trim();
}

function unique(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function contractHash(value, omittedKey) {
  const copy = { ...value };
  delete copy[omittedKey];
  return sha256(`${JSON.stringify(copy, null, 2)}\n`);
}

export function learningProposalSha256(proposal) {
  return contractHash(proposal, "proposal_sha256");
}

export function learningApprovalSha256(approval) {
  return contractHash(approval, "approval_sha256");
}

export function buildAnalyticsLearningProposal({
  aggregate,
  aggregatePath,
  aggregateSha256,
  changes,
  createdAt = new Date(),
} = {}) {
  if (aggregate?.schema !== "goldflow_youtube_performance_feedback_aggregate_v1" || aggregate?.status !== "passed") {
    throw new Error("Learning proposal requires a passed analytics aggregate.");
  }
  if (!aggregateSha256 || !aggregatePath) throw new Error("Learning proposal requires a hash-bound aggregate path.");
  if (!Array.isArray(changes) || changes.length === 0) throw new Error("Learning proposal requires at least one specific change.");
  const normalizedChanges = changes.map((change, index) => {
    const id = clean(change?.id ?? `change_${String(index + 1).padStart(2, "0")}`);
    const domain = clean(change?.domain);
    const readiness = aggregate?.learning_readiness?.domains?.[domain];
    if (!readiness) throw new Error(`Unknown learning domain for ${id}: ${domain || "missing"}.`);
    if (readiness.status !== "operator_review_allowed") {
      throw new Error(`Learning domain ${domain} is not ready for operator review.`);
    }
    const supportingEpisodeIds = unique(change?.supporting_episode_ids ?? []);
    if (supportingEpisodeIds.length < readiness.minimum_distinct_episode_count) {
      throw new Error(`${id} lacks the minimum distinct supporting episodes.`);
    }
    const eligible = new Set(readiness.episode_ids ?? []);
    const ineligible = supportingEpisodeIds.filter((episodeId) => !eligible.has(episodeId));
    if (ineligible.length) throw new Error(`${id} cites ineligible ${domain} episodes: ${ineligible.join(", ")}.`);
    for (const field of ["target", "observed_pattern", "proposed_change", "validation_plan", "rollback_plan"]) {
      if (!clean(change?.[field])) throw new Error(`${id} is missing ${field}.`);
    }
    return {
      id,
      domain,
      target: clean(change.target),
      observed_pattern: clean(change.observed_pattern),
      supporting_episode_ids: supportingEpisodeIds,
      supporting_metrics: change.supporting_metrics ?? {},
      counterevidence: clean(change.counterevidence) || "No counterevidence recorded.",
      confidence: clean(change.confidence) || "unrated",
      proposed_change: clean(change.proposed_change),
      validation_plan: clean(change.validation_plan),
      rollback_plan: clean(change.rollback_plan),
    };
  });
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
  const proposal = {
    schema: ANALYTICS_LEARNING_PROPOSAL_SCHEMA,
    status: "operator_review_required",
    policy: "This packet proposes tests only. It cannot edit defaults, prompts, policies, profiles, or production artifacts.",
    aggregate_path: aggregatePath,
    aggregate_sha256: aggregateSha256,
    changes: normalizedChanges,
    automatic_application_allowed: false,
    operator_approval_required: true,
    created_at: created.toISOString(),
  };
  return { ...proposal, proposal_sha256: learningProposalSha256(proposal) };
}

export function validateAnalyticsLearningProposal(proposal) {
  const findings = [];
  if (proposal?.schema !== ANALYTICS_LEARNING_PROPOSAL_SCHEMA) findings.push("proposal_schema_invalid");
  if (proposal?.status !== "operator_review_required") findings.push("proposal_status_invalid");
  if (!Array.isArray(proposal?.changes) || proposal.changes.length === 0) findings.push("proposal_changes_missing");
  if (proposal?.automatic_application_allowed !== false) findings.push("proposal_auto_apply_not_disabled");
  if (proposal?.proposal_sha256 !== learningProposalSha256(proposal)) findings.push("proposal_hash_invalid");
  return { status: findings.length ? "blocked" : "passed", findings };
}

export function buildAnalyticsLearningApproval({ proposal, approvedChangeIds, approvedBy, note, approvedAt = new Date() } = {}) {
  const validation = validateAnalyticsLearningProposal(proposal);
  if (validation.status !== "passed") throw new Error(`Learning proposal is invalid: ${validation.findings.join(", ")}.`);
  const known = new Set(proposal.changes.map((change) => change.id));
  const approvedIds = unique(approvedChangeIds ?? []);
  if (!approvedIds.length) throw new Error("Learning approval requires at least one approved change ID.");
  const unknown = approvedIds.filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`Unknown learning change IDs: ${unknown.join(", ")}.`);
  if (!clean(approvedBy)) throw new Error("Learning approval requires approvedBy.");
  const approved = approvedAt instanceof Date ? approvedAt : new Date(approvedAt);
  const approval = {
    schema: ANALYTICS_LEARNING_APPROVAL_SCHEMA,
    status: "approved_for_controlled_test",
    proposal_sha256: proposal.proposal_sha256,
    aggregate_sha256: proposal.aggregate_sha256,
    approved_change_ids: approvedIds,
    rejected_change_ids: proposal.changes.map((change) => change.id).filter((id) => !approvedIds.includes(id)),
    approved_by: clean(approvedBy),
    approval_note: clean(note) || "Approved for a controlled test; not approved as an automatic default change.",
    automatic_application_allowed: false,
    approved_at: approved.toISOString(),
  };
  return { ...approval, approval_sha256: learningApprovalSha256(approval) };
}
