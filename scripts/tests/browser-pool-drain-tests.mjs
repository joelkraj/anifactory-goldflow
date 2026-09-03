import assert from "node:assert/strict";
import test from "node:test";
import { manifestQueueStopReason } from "../hybrid-browser-image-pool.mjs";

const snapshot = (overrides = {}) => ({
  status: "blocked_deadletter",
  counts: { pending: 6, leased: 0, completed: 18, deadlettered: 2 },
  verification_wave: { required: true, status: "passed", asset_ids: ["first"] },
  items: [{ asset_id: "first", status: "completed" }, { asset_id: "failed", status: "deadlettered" }],
  ...overrides,
});

test("isolated failures do not stop runnable pending work during any stagger", () => {
  for (const idleMs of [0, 15000, 30000, 45000, 60000]) {
    assert.equal(manifestQueueStopReason(snapshot({ idleMs })), null);
  }
});
test("drained failures and complete queues finish", () => {
  assert.equal(manifestQueueStopReason(snapshot({ counts: { pending: 0, leased: 0, completed: 18, deadlettered: 2 } })), "drained_deadletters");
  assert.equal(manifestQueueStopReason(snapshot({ status: "completed" })), "completed");
});
test("a failed required verification wave stops without spending on the rest", () => {
  const failed = snapshot({ verification_wave: { required: true, status: "in_progress", asset_ids: ["failed"] } });
  assert.equal(manifestQueueStopReason(failed), "failed_verification_wave");
  assert.equal(manifestQueueStopReason({ ...failed, counts: { ...failed.counts, leased: 1 } }), null);
});
test("explicitly bypassed or optional verification does not block pending work", () => {
  for (const verification_wave of [
    { required: true, bypassed: true, status: "bypassed_with_prior_health_proof", asset_ids: ["failed"] },
    { required: false, status: "in_progress", asset_ids: ["failed"] },
  ]) assert.equal(manifestQueueStopReason(snapshot({ verification_wave })), null);
});
