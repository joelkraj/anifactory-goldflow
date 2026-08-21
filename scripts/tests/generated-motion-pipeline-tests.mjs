#!/usr/bin/env node

import assert from "node:assert/strict";

import { runGeneratedMotionPipelineForTests } from "../generated-motion-generate.mjs";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const rows = Array.from({ length: 7 }, (_, index) => ({ image_id: `cut_${index + 1}` }));
const active = { submission: 0, provider_wait: 0, normalization: 0 };
const maximum = { submission: 0, provider_wait: 0, normalization: 0 };
let completedWaits = 0;
let normalizationOverlappedProviderWait = false;

function entered(stage) {
  active[stage] += 1;
  maximum[stage] = Math.max(maximum[stage], active[stage]);
}

function exited(stage) {
  active[stage] -= 1;
}

const pipeline = await runGeneratedMotionPipelineForTests({
  rows,
  submissionConcurrency: 3,
  providerWaitConcurrency: 2,
  normalizationConcurrency: 2,
  submit: async (row) => {
    entered("submission");
    await delay(2);
    exited("submission");
    return { row };
  },
  wait: async (submitted) => {
    entered("provider_wait");
    await delay(8);
    completedWaits += 1;
    exited("provider_wait");
    return submitted;
  },
  normalize: async (completed) => {
    entered("normalization");
    if (completedWaits < rows.length) normalizationOverlappedProviderWait = true;
    await delay(4);
    exited("normalization");
    return completed.row.image_id;
  },
});

assert.deepEqual(pipeline.results, rows.map((row) => row.image_id));
assert.deepEqual(pipeline.failures, []);
assert.equal(maximum.submission, 3);
assert.equal(maximum.provider_wait, 2);
assert.equal(maximum.normalization, 2);
assert.equal(normalizationOverlappedProviderWait, true, "normalization should start while other provider jobs are still pending");

const failed = await runGeneratedMotionPipelineForTests({
  rows: rows.slice(0, 3),
  submissionConcurrency: 3,
  providerWaitConcurrency: 3,
  normalizationConcurrency: 3,
  submit: async (row, index) => {
    if (index === 0) throw new Error("submit failure");
    return { row, index };
  },
  wait: async (submitted) => {
    if (submitted.index === 1) throw new Error("wait failure");
    return submitted;
  },
  normalize: async () => {
    throw new Error("normalize failure");
  },
});
assert.deepEqual(failed.failures.map((row) => row.stage), ["submission", "provider_wait", "normalization"]);

console.log("generated motion pipeline tests passed");
