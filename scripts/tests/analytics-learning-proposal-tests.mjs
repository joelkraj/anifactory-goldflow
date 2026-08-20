#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  buildAnalyticsLearningApproval,
  buildAnalyticsLearningProposal,
  validateAnalyticsLearningProposal,
} from "../lib/analytics-learning-proposal.mjs";

const aggregate = {
  schema: "goldflow_youtube_performance_feedback_aggregate_v1",
  status: "passed",
  learning_readiness: {
    domains: {
      source_room: {
        status: "operator_review_allowed",
        minimum_distinct_episode_count: 3,
        episode_ids: ["a", "b", "c"],
      },
      packaging: {
        status: "hold",
        minimum_distinct_episode_count: 3,
        episode_ids: ["a"],
      },
    },
  },
};

const change = {
  id: "opening_event_test",
  domain: "source_room",
  target: "dramatic cold open",
  observed_pattern: "Three native episodes retained better when the betrayal was visible immediately.",
  supporting_episode_ids: ["a", "b", "c"],
  supporting_metrics: { first_30_sec_retention_percent: [81, 79, 83] },
  counterevidence: "No matched counterexample in the eligible cohort.",
  confidence: "medium",
  proposed_change: "Test a visible betrayal event in sentence one for the next three native scripts.",
  validation_plan: "Compare matched 72-hour first-30 retention across three episodes.",
  rollback_plan: "Restore the prior opening contract if the matched cohort declines.",
};

const proposal = buildAnalyticsLearningProposal({
  aggregate,
  aggregatePath: "/tmp/aggregate.json",
  aggregateSha256: "a".repeat(64),
  changes: [change],
  createdAt: "2026-08-18T18:00:00.000Z",
});
assert.equal(validateAnalyticsLearningProposal(proposal).status, "passed");
assert.equal(proposal.automatic_application_allowed, false);
assert.throws(() => buildAnalyticsLearningProposal({
  aggregate,
  aggregatePath: "/tmp/aggregate.json",
  aggregateSha256: "a".repeat(64),
  changes: [{ ...change, domain: "packaging", supporting_episode_ids: ["a"] }],
}), /not ready/i);

const approval = buildAnalyticsLearningApproval({
  proposal,
  approvedChangeIds: ["opening_event_test"],
  approvedBy: "joel",
  approvedAt: "2026-08-18T19:00:00.000Z",
});
assert.equal(approval.status, "approved_for_controlled_test");
assert.equal(approval.automatic_application_allowed, false);
assert.equal(approval.proposal_sha256, proposal.proposal_sha256);

console.log("analytics learning proposal tests passed");
