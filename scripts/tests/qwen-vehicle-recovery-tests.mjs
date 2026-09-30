#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decisionMatchesLatestAttempt,
  mergeImagegenResults,
  profileForAttempt,
  resolveSelectedAttempt,
  validatePlan,
} from "../qwen-vehicle-recovery.mjs";

assert.equal(profileForAttempt({ profiles: ["default", "secondary"], itemIndex: 0 }), 1);
assert.equal(profileForAttempt({ profiles: ["default", "secondary"], itemIndex: 1 }), 2);
assert.equal(profileForAttempt({ profiles: ["default", "secondary"], itemIndex: 9, priorAttempts: [{ account_slot: 1 }] }), 2);
assert.equal(profileForAttempt({ profiles: ["default", "secondary"], itemIndex: 9, priorAttempts: [{ account_slot: 2 }] }), 1);

const untouched = { image_id: "a", image_path: "/old/a.png", marker: "immutable" };
const oldB = { image_id: "b", image_path: "/old/b.png" };
const replacementB = { image_id: "b", image_path: "/new/b.png" };
const merged = mergeImagegenResults([untouched, oldB], [replacementB], new Set(["a", "b"]));
assert.deepEqual(merged, [untouched, replacementB]);
assert.equal(merged[0], untouched, "untouched result row must retain object identity and fields");

assert.throws(
  () => mergeImagegenResults([untouched], [{ image_id: "outside" }], new Set(["a"])),
  /outside the prompt plan/,
);

const prompt = "one coherent left-hand-drive sedan";
const promptHash = createHash("sha256").update(prompt).digest("hex");
const latest = { status: "passed", attempt_index: 2, candidate_path: "/candidate.png", candidate_sha256: "abc", prompt, prompt_sha256: promptHash };
assert.equal(decisionMatchesLatestAttempt({ attempt_index: 2, candidate_path: "/candidate.png", candidate_sha256: "abc", prompt_sha256: promptHash }, latest, prompt), true);
assert.equal(decisionMatchesLatestAttempt({ attempt_index: 1, candidate_path: "/candidate.png", candidate_sha256: "abc", prompt_sha256: promptHash }, latest, prompt), false);
assert.equal(decisionMatchesLatestAttempt({ attempt_index: 2, candidate_path: "/candidate.png", candidate_sha256: "abc", prompt_sha256: promptHash }, latest), true);
assert.equal(decisionMatchesLatestAttempt({ attempt_index: 2, candidate_path: "/candidate.png", candidate_sha256: "abc", prompt_sha256: promptHash }, latest, "different prompt"), false);

const firstPrompt = "original coherent sedan";
const firstPromptHash = createHash("sha256").update(firstPrompt).digest("hex");
const attempts = [
  { image_id: "car", status: "passed", attempt_index: 1, candidate_path: "/original.png", candidate_sha256: "original-hash", prompt: firstPrompt, prompt_sha256: firstPromptHash },
  { image_id: "car", status: "passed", attempt_index: 2, candidate_path: "/retry.png", candidate_sha256: "retry-hash", prompt, prompt_sha256: promptHash },
];
const selectedOriginal = resolveSelectedAttempt(attempts, {
  image_id: "car",
  selected_attempt_index: 1,
  selected_candidate_path: "/original.png",
  selected_candidate_sha256: "original-hash",
});
assert.equal(selectedOriginal.attempt_index, 1, "an accepted original may be selected over a later retry");
assert.equal(decisionMatchesLatestAttempt({
  attempt_index: 1,
  candidate_path: "/original.png",
  candidate_sha256: "original-hash",
  prompt_sha256: firstPromptHash,
}, selectedOriginal), true);
assert.throws(() => resolveSelectedAttempt(attempts, {
  image_id: "car",
  selected_attempt_index: 1,
  selected_candidate_path: "/original.png",
  selected_candidate_sha256: "stale-hash",
}), /path\/hash is stale/);

const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), "qwen-vehicle-plan-test-"));
try {
  const sourcePath = path.join(temporaryDir, "source.txt");
  await fs.writeFile(sourcePath, "locked source", "utf8");
  const sourceHash = createHash("sha256").update("locked source").digest("hex");
  const validated = await validatePlan({
    schema: "goldflow_qwen_vehicle_recovery_plan_v1",
    status: "approved",
    source_hashes: { script: { path: sourcePath, sha256: sourceHash } },
    items: [{ image_id: "a", qwen_prompt: prompt }],
  });
  assert.equal(validated.length, 1);
  await assert.rejects(() => validatePlan({
    schema: "goldflow_qwen_vehicle_recovery_plan_v1",
    status: "approved",
    source_hashes: { script: { path: sourcePath, sha256: "stale" } },
    items: [{ image_id: "a", qwen_prompt: prompt }],
  }), /source is stale/);
} finally {
  await fs.rm(temporaryDir, { recursive: true, force: true });
}

console.log("qwen vehicle recovery tests passed");
