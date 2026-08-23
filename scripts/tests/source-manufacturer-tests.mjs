#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MANUFACTURING_BRIEF_SCHEMA,
  MANUFACTURING_PORTFOLIO_SCHEMA,
  MANUFACTURING_SELECTION_SCHEMA,
  MANUFACTURING_TOPIC_POOL_SCHEMA,
  MANUFACTURING_VIEWER_IDS,
  parseManufacturingTopicTitles,
  sha256Text,
  validateFilledManufacturingPrompt,
  validateManufacturingBrief,
  validateManufacturingPortfolio,
  validateManufacturingSelection,
  validateManufacturingTemplate,
  validateManufacturingTopicPool,
  validateManufacturingTopicShortlist,
} from "../lib/source-manufacturer-contract.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sha = sha256Text("fixture");
const candidateSpecs = [
  ["draft_56_1", "candidate_a", "gpt-5.6-sol"],
  ["draft_55_1", "candidate_b", "gpt-5.5"],
  ["draft_56_2", "candidate_c", "gpt-5.6-sol"],
  ["draft_55_2", "candidate_d", "gpt-5.5"],
  ["draft_56_3", "candidate_e", "gpt-5.6-sol"],
  ["draft_55_3", "candidate_f", "gpt-5.5"],
].map(([id, blind_id, model]) => ({ id, blind_id, model, provider: "chatgpt_web" }));

const brief = {
  schema: MANUFACTURING_BRIEF_SCHEMA,
  status: "approved",
  title: "My Party Sold My Memories, So I Filled the Empty Years With Monster Instincts",
  core_premise: "Joey's party sells ten years of his memories and he replaces each stolen skill with a monster instinct.",
  opening_target: "Joey watches his fiancee authorize the memory sale while the buyer erases his name.",
  target_word_count: 10_000,
  genre_elements: ["betrayal", "revenge", "power scaling"],
  reference_outlier: { title: "Measured outlier", url: "https://www.youtube.com/watch?v=fixture" },
  approved_by: "operator",
  approved_at: "2026-08-19T00:00:00.000Z",
};
assert.equal(validateManufacturingBrief(brief).done, true);

const rawTitles = Array.from({ length: 30 }, (_, index) => `${index + 1}. Original premise title ${index + 1}`).join("\n");
const parsedTitles = parseManufacturingTopicTitles(rawTitles);
assert.equal(parsedTitles.length, 30);
const rawUnnumberedTitles = Array.from({ length: 30 }, (_, index) => `Unnumbered original premise ${index + 1}`).join("\n\n");
const parsedUnnumberedTitles = parseManufacturingTopicTitles(rawUnnumberedTitles);
assert.deepEqual(parsedUnnumberedTitles[0], { number: 1, title: "Unnumbered original premise 1" });
assert.deepEqual(parsedUnnumberedTitles[29], { number: 30, title: "Unnumbered original premise 30" });
const topicPool = {
  schema: MANUFACTURING_TOPIC_POOL_SCHEMA,
  status: "completed",
  evidence_sha256: sha,
  raw_response_sha256: sha,
  candidates: parsedTitles,
};
assert.equal(validateManufacturingTopicPool(topicPool).done, true);
const shortlist = {
  schema: "goldflow_manhwa_topic_shortlist_v1",
  status: "shortlisted",
  rankings: parsedTitles.slice(0, 10).map((row, index) => ({
    rank: index + 1,
    candidate_number: row.number,
    title: row.title,
    core_premise: "A simple causal story premise.",
    opening_target: "The betrayal appears immediately.",
    demand_transfer: "Transfers visible reversal demand.",
    why_it_can_win: "It is immediately understandable.",
    complexity_risk: "low",
  })),
};
assert.equal(validateManufacturingTopicShortlist(shortlist, { topicPool }).done, true);

const legacyTemplate = await readFile(path.join(ROOT, "docs/prompts/manhwa_recap_manufacturing_template_v1.txt"), "utf8");
assert.equal(validateManufacturingTemplate(legacyTemplate).done, true);
assert.equal(legacyTemplate.includes("Treat these moments as an escalating reversal ladder"), true);
assert.equal(legacyTemplate.includes("A major reversal is incomplete until it causes a tangible consequence"), true);
assert.equal(legacyTemplate.includes("Omit any cameo whose only function is to act snide, look shocked, and disappear"), true);
const filledLegacyPrompt = legacyTemplate
  .replaceAll("[WORD COUNT]", "10000")
  .replaceAll("[TITLE]", brief.title)
  .replaceAll("[CORE PREMISE]", brief.core_premise)
  .replaceAll(/\[[A-Z][A-Z0-9 ,/'-]{2,}\]/g, "a concrete story-specific answer");
assert.equal(validateFilledManufacturingPrompt(filledLegacyPrompt, { brief, baseTemplate: legacyTemplate }).done, true);
const baseTemplate = await readFile(path.join(ROOT, "docs/prompts/manhwa_recap_manufacturing_template_v2.txt"), "utf8");
assert.equal(validateManufacturingTemplate(baseTemplate).done, true);
const filledPrompt = baseTemplate
  .replaceAll("[WORD COUNT]", "10000")
  .replaceAll("[TITLE]", brief.title)
  .replaceAll("[CORE PREMISE]", brief.core_premise)
  .replaceAll(/\[[A-Z][A-Z0-9 ,/'-]{2,}\]/g, "a concrete story-specific answer");
assert.equal(validateFilledManufacturingPrompt(filledPrompt, { brief, baseTemplate }).done, true);
const bloatedPrompt = `${filledPrompt}\n${"retention filler ".repeat(2_100)}`;
assert.equal(validateFilledManufacturingPrompt(bloatedPrompt, { brief, baseTemplate }).blockers.includes("manufacturing_prompt_compact_contract_exceeded"), true);

const portfolio = {
  schema: MANUFACTURING_PORTFOLIO_SCHEMA,
  status: "completed",
  filled_prompt_sha256: sha,
  candidates: candidateSpecs.map((spec) => ({
    ...spec,
    reasoning_effort: "max",
    output_path: `/tmp/${spec.id}.txt`,
    receipt_path: `/tmp/${spec.id}.meta.json`,
    output_sha256: sha,
    receipt_sha256: sha,
    prompt_sha256: sha,
    word_count: 8_750,
  })),
};
assert.equal(validateManufacturingPortfolio(portfolio, { promptSha256: sha, expectedCandidates: candidateSpecs }).done, true);

const rankings = candidateSpecs.map((spec, index) => {
  const average = 35 - index;
  return {
    rank: index + 1,
    blind_id: spec.blind_id,
    predicted_average_percentage_viewed: average,
    opening_survival_curve: {
      thirty_seconds: 80 - index,
      sixty_seconds: 75 - index,
      two_minutes: 70 - index,
      five_minutes: 60 - index,
    },
    viewer_simulation: MANUFACTURING_VIEWER_IDS.map((viewer_id) => ({
      viewer_id,
      predicted_percentage_viewed: average,
      predicted_exit_point: "around the final act",
      reason: "Fixture retention reason.",
    })),
    retention_reason: "The title promise is paid immediately.",
  };
});
const selection = {
  schema: MANUFACTURING_SELECTION_SCHEMA,
  status: "selected",
  selected_blind_id: "candidate_a",
  rankings,
  decision_rationale: "Candidate A has the highest predicted percentage viewed.",
};
assert.equal(validateManufacturingSelection(selection, { portfolio }).done, true);

console.log("source manufacturer tests passed");
