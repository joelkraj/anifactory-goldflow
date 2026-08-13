#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runChatGptWebPlanner } from "./chatgpt-web-planner-helper.mjs";

function flagsFrom(parts) {
  const flags = {};
  for (let i = 0; i < parts.length; i += 1) {
    if (!parts[i].startsWith("--")) continue;
    const next = parts[i + 1];
    flags[parts[i].slice(2)] = next && !next.startsWith("--") ? next : "true";
    if (next && !next.startsWith("--")) i += 1;
  }
  return flags;
}

const personas = [
  ["instant_payoff_scroller", "You need frequent visible reversals and dominance receipts, but you leave when mechanics become paperwork."],
  ["emotional_kdrama_viewer", "You want power to alter relationships, shame, trust, and status rather than becoming empty combat spectacle."],
  ["system_power_fantasy_viewer", "You want clever, escalating applications of Theft and 100X, strong opponent reactions, and unmistakable superiority."],
  ["coherence_binge_viewer", "You want each power escalation causally planted, distinct from prior uses, and easy to follow at narration speed."],
  ["skeptical_niche_veteran", "You reject generic crowd shock and arbitrary upgrades; you want memorable original power scenes that feel earned."],
];

const flags = flagsFrom(process.argv.slice(2));
for (const key of ["script", "reference", "output-dir"]) if (!flags[key]) throw new Error(`Missing --${key}`);
const [script, reference] = await Promise.all([
  fs.readFile(path.resolve(flags.script), "utf8"),
  fs.readFile(path.resolve(flags.reference), "utf8"),
]);
const outputDir = path.resolve(flags["output-dir"]);
await fs.mkdir(outputDir, { recursive: true });
const digest = createHash("sha256").update(script).digest("hex").slice(0, 10);

await Promise.all(personas.map(async ([id, psychology]) => {
  const outputPath = path.join(outputDir, `${id}.json`);
  const prompt = `Act as one cold YouTube manhwa-recap viewer with this viewing psychology: ${psychology}

The candidate already beat the measured outlier 5-0 overall, 5-0 on estimated APV, and 5-0 at every timed checkpoint. The only remaining strict-gate loss is pure power-fantasy satisfaction. Your job is to identify the smallest candidate-script improvements that can reverse that one dimension without damaging its superior clarity, emotional causality, freshness, relationships, or complete ending.

Read both exact scripts. Return at most five enhancement opportunities. Each must quote an exact candidate excerpt, classify the change as intensify_existing_payoff, add_distinct_power_application, compress_procedure_for_payoff, strengthen_antagonist_humiliation, or preserve_no_change, and describe a concrete story-level revision. Added power must use already-established Theft, 100X Assimilation, Echo Trace, or Binding rules; do not invent an unrelated system, new arc, arbitrary ability, disposable opponent, crowd-gasp montage, or sequel tease. A note may recommend preserving a section unchanged.

Also name three protected candidate strengths that must survive. Do not write replacement prose.

Return JSON only:
{
  "schema": "goldflow_power_fantasy_viewer_notes_v1",
  "persona_id": "${id}",
  "enhancement_opportunities": [{"priority":1,"exact_candidate_anchor":"...","classification":"intensify_existing_payoff|add_distinct_power_application|compress_procedure_for_payoff|strengthen_antagonist_humiliation|preserve_no_change","viewer_deficit":"...","concrete_revision_intent":"...","why_not_empty_spectacle":"..."}],
  "protected_strengths": ["..."],
  "would_candidate_win_power_fantasy_after_these_changes": "yes|uncertain|no",
  "reason": "..."
}

EXACT CANDIDATE SCRIPT:
${script}

EXACT MEASURED OUTLIER TRANSCRIPT:
${reference}`;
  await runChatGptWebPlanner({
    prompt,
    outputPath,
    workId: `power_fantasy_notes_${id}_${digest}`,
    effort: "low",
    timeoutMs: 1_800_000,
    rateClass: "ordinary",
  });
}));
console.log(JSON.stringify({ status: "completed", output_dir: outputDir, viewer_count: personas.length }, null, 2));
