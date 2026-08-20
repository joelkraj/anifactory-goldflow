#!/usr/bin/env node

import assert from "node:assert/strict";

import { sceneCriticalPathPriority } from "../lib/codex-image-work-contract.mjs";

const openingHeroMotion = sceneCriticalPathPriority({
  start_sec: 8,
  quality_budget: { tier: "hero", image_candidate_count: 2 },
  shot_manifest: { animation_intent: { eligibility: "animate", shot_class: "physical_contact" } },
  visual_job: "title betrayal proof and irreversible reveal",
});
const lateOrdinary = sceneCriticalPathPriority({
  start_sec: 2200,
  quality_budget: { tier: "ordinary", image_candidate_count: 1 },
  shot_manifest: { animation_intent: { eligibility: "still_preferred", shot_class: "reaction_closeup" } },
  visual_job: "quiet connective reaction",
});

assert.ok(openingHeroMotion.score > lateOrdinary.score);
assert.ok(openingHeroMotion.reasons.includes("opening_30s"));
assert.ok(openingHeroMotion.reasons.includes("hero_quality_tier"));
assert.ok(openingHeroMotion.reasons.includes("generated_motion_first_frame"));
assert.ok(openingHeroMotion.reasons.includes("high_risk_action_geometry"));

console.log("critical path priority tests passed");
