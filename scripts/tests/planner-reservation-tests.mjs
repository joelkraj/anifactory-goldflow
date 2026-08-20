#!/usr/bin/env node

import assert from "node:assert/strict";

import { planningReservationStateForJobs } from "../../apps/goldflow-studio/lib/llm-job-store.mjs";

const nowMs = Date.parse("2026-08-18T12:00:00.000Z");
const active = planningReservationStateForJobs([
  { status: "leased" },
  { status: "queued" },
], { reservedSlots: 2, nowMs });
assert.equal(active.active, true);
assert.equal(active.reserved_slots, 2);
assert.equal(active.queued_count, 1);
assert.equal(active.leased_count, 1);

const lingering = planningReservationStateForJobs([
  { status: "completed", completed_at: "2026-08-18T11:59:15.000Z" },
], { reservedSlots: 1, lingerMs: 120_000, nowMs });
assert.equal(lingering.active, true);
assert.equal(lingering.reserved_slots, 1);

const expired = planningReservationStateForJobs([
  { status: "completed", completed_at: "2026-08-18T11:55:00.000Z" },
], { reservedSlots: 2, lingerMs: 120_000, nowMs });
assert.equal(expired.active, false);
assert.equal(expired.reserved_slots, 0);

console.log("planner reservation tests passed");
