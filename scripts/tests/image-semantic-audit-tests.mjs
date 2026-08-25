#!/usr/bin/env node

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";

import {
  buildImageSemanticAudit,
  semanticAuditSelectionForTests,
} from "../lib/image-semantic-audit.mjs";
import { semanticAuditHasMaterialFailure, structuralAuditForTests } from "../image-output-qa.mjs";

const heroPrompt = {
  image_id: "cut_hero",
  start_sec: 400,
  provider_prompt: "Joey turns the shield and sends the Crown Ram into the pit.",
  quality_budget: { tier: "hero", image_candidate_count: 2 },
  shot_manifest: {
    shot_job: "physical_action",
    foreground_action: "Joey turns the shield seven degrees at contact",
    visible_characters: ["Joey", "Crown Ram"],
    visible_props: ["shield", "maintenance pit"],
    character_staging: [],
  },
};
const ordinaryPrompt = {
  image_id: "cut_ordinary",
  start_sec: 500,
  provider_prompt: "An empty fire-station yard in morning light.",
  quality_budget: { tier: "connective", image_candidate_count: 1 },
  shot_manifest: { shot_job: "location_wide", foreground_action: null, visible_characters: [], visible_props: [] },
};
const locationUiPriorityPrompt = {
  image_id: "cut_location_ui_priority",
  start_sec: 20,
  provider_prompt: "A quiet guild terminal in the established command room.",
  quality_budget: { tier: "priority", image_candidate_count: 1 },
  shot_manifest: {
    shot_job: "ui_insert",
    foreground_action: null,
    visible_characters: [],
    visible_props: [],
    ui_elements: ["status panel"],
    location_contract_id: "guild_command_room",
  },
};
const identityCriticalPrompt = {
  image_id: "cut_identity_critical",
  start_sec: 500,
  provider_prompt: "Joey and Mira face the tribunal together.",
  quality_budget: { tier: "connective", image_candidate_count: 1 },
  visual_information_delta: { kind: "new_relationship_evidence" },
  sequence_grammar: { sequence_role: "reveal" },
  shot_manifest: {
    shot_job: "relationship_reveal",
    foreground_action: null,
    visible_characters: ["Joey", "Mira"],
    reference_slots: [
      { ref_id: "joey", kind: "character_state", reference_priority: "decisive_subject" },
      { ref_id: "mira", kind: "character_state", reference_priority: "readable_identity" },
    ],
    visible_props: [],
  },
};
const reversalPrompt = {
  image_id: "cut_reversal",
  start_sec: 900,
  visual_job: "public revenge payoff",
  quality_budget: { tier: "connective", image_candidate_count: 1 },
  shot_manifest: { shot_job: "reaction", foreground_action: "the betrayer grovels", visible_characters: ["Joey", "Betrayer"] },
};

assert.equal(semanticAuditSelectionForTests(heroPrompt, { ordinarySampleRate: 0 }).selected, true);
assert.equal(semanticAuditSelectionForTests(heroPrompt, { ordinarySampleRate: 0 }).reasons.includes("hero_beat"), true);
assert.equal(semanticAuditSelectionForTests(ordinaryPrompt, { ordinarySampleRate: 0 }).selected, false);
assert.equal(
  semanticAuditSelectionForTests(locationUiPriorityPrompt, { ordinarySampleRate: 0 }).selected,
  true,
  "the retention opening is an essential semantic-review surface",
);
assert.equal(semanticAuditSelectionForTests(locationUiPriorityPrompt, { ordinarySampleRate: 0 }).reasons.includes("opening_retention"), true);
assert.equal(
  semanticAuditSelectionForTests(locationUiPriorityPrompt, { ordinarySampleRate: 0 }).required_dimensions.includes("location_continuity"),
  true,
  "location remains an audit dimension when another true-risk reason selects the cut",
);
assert.equal(
  semanticAuditSelectionForTests(locationUiPriorityPrompt, { ordinarySampleRate: 0 }).required_dimensions.includes("ui_hierarchy"),
  true,
  "UI remains an audit dimension when another true-risk reason selects the cut",
);
assert.deepEqual(
  semanticAuditSelectionForTests(identityCriticalPrompt, { ordinarySampleRate: 0 }).reasons,
  ["identity_critical"],
);
assert.equal(semanticAuditSelectionForTests(reversalPrompt, { ordinarySampleRate: 0 }).reasons.includes("major_reversal_or_payoff"), true);
assert.equal(semanticAuditHasMaterialFailure({ status: "audited", checks: [{ verdict: "uncertain" }], critical_discrepancies: [] }), false);
assert.equal(semanticAuditHasMaterialFailure({ status: "audited", checks: [{ verdict: "fail" }], critical_discrepancies: [] }), true);

const root = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-image-semantic-audit-"));
try {
  const imagePath = path.join(root, "hero.png");
  await sharp({ create: { width: 640, height: 360, channels: 3, background: "#333333" } }).png().toFile(imagePath);
  const promptPlanPath = path.join(root, "prompts.json");
  const imagegenReportPath = path.join(root, "images.json");
  const outputPath = path.join(root, "semantic.json");
  const promptPlan = { status: "passed", prompts: [heroPrompt, ordinaryPrompt] };
  const imagegenReport = { status: "passed", results: [{ image_id: "cut_hero", image_path: imagePath }] };
  await fs.writeFile(promptPlanPath, `${JSON.stringify(promptPlan)}\n`);
  await fs.writeFile(imagegenReportPath, `${JSON.stringify(imagegenReport)}\n`);
  const calls = [];
  const report = await buildImageSemanticAudit({
    promptPlan,
    imagegenReport,
    promptPlanPath,
    imagegenReportPath,
    outputPath,
    callsDir: path.join(root, "calls"),
    repoRoot: root,
    ordinarySampleRate: 0,
    concurrency: 4,
    generatedAt: new Date("2026-08-18T00:00:00.000Z"),
    auditExecutor: async ({ prompt, outputPath: callOutputPath }) => {
      calls.push(prompt.image_id);
      const dimensions = semanticAuditSelectionForTests(prompt).required_dimensions;
      const response = {
        schema: "goldflow_image_semantic_audit_row_v1",
        image_id: prompt.image_id,
        checks: dimensions.map((dimension) => ({
          dimension,
          verdict: dimension === "action_and_contact_geometry" ? "uncertain" : "pass",
          visible_evidence: "Mock visible evidence.",
          discrepancy: dimension === "action_and_contact_geometry" ? "contact point is obscured" : null,
        })),
        overall_verdict: "needs_review",
        critical_discrepancies: ["contact point is obscured"],
        confidence: "medium",
        one_sentence_verdict: "The contact point needs review.",
      };
      await fs.mkdir(path.dirname(callOutputPath), { recursive: true });
      await fs.writeFile(callOutputPath, `${JSON.stringify(response)}\n`);
      return response;
    },
  });
  assert.deepEqual(calls, ["cut_hero"]);
  assert.equal(report.status, "passed");
  assert.equal(report.selected_count, 1);
  assert.equal(report.audited_count, 1);
  assert.equal(report.needs_review_count, 1);
  assert.equal(report.rows[0].checks.find((row) => row.dimension === "action_and_contact_geometry").verdict, "uncertain");
  const reused = await buildImageSemanticAudit({
    promptPlan,
    imagegenReport,
    promptPlanPath,
    imagegenReportPath,
    outputPath,
    callsDir: path.join(root, "calls"),
    repoRoot: root,
    ordinarySampleRate: 0,
    auditExecutor: async () => {
      throw new Error("cache should prevent a second call");
    },
  });
  assert.equal(reused.reused, true);

  const officialPromptPlanPath = path.join(root, "official-prompts.json");
  const officialImagegenReportPath = path.join(root, "official-images.json");
  const officialOutputPath = path.join(root, "official-semantic.json");
  const officialPromptPlan = { status: "passed", prompts: [ordinaryPrompt, heroPrompt] };
  const officialImagegenReport = { status: "passed", results: [{ image_id: "cut_hero", image_path: imagePath }] };
  await fs.writeFile(officialPromptPlanPath, `${JSON.stringify(officialPromptPlan)}\n`);
  await fs.writeFile(officialImagegenReportPath, `${JSON.stringify(officialImagegenReport)}\n`);
  const crossReportReuse = await buildImageSemanticAudit({
    promptPlan: officialPromptPlan,
    imagegenReport: officialImagegenReport,
    promptPlanPath: officialPromptPlanPath,
    imagegenReportPath: officialImagegenReportPath,
    outputPath: officialOutputPath,
    callsDir: path.join(root, "calls"),
    repoRoot: root,
    ordinarySampleRate: 0,
    auditExecutor: async () => {
      throw new Error("durable row cache should be shared across incremental and official reports");
    },
  });
  assert.equal(crossReportReuse.reused, undefined);
  assert.equal(crossReportReuse.row_cache_hit_count, 1);
  assert.equal(crossReportReuse.row_cache_miss_count, 0);
  assert.equal(crossReportReuse.rows[0].reused, true);
  assert.match(crossReportReuse.rows[0].row_cache_path, /row-cache/);

  const ordinaryImagePath = path.join(root, "ordinary.png");
  await sharp({ create: { width: 640, height: 360, channels: 3, background: "#555555" } }).png().toFile(ordinaryImagePath);
  const structural = await structuralAuditForTests(
    { prompts: [heroPrompt, ordinaryPrompt] },
    { results: [
      { image_id: heroPrompt.image_id, image_path: imagePath },
      { image_id: ordinaryPrompt.image_id, image_path: ordinaryImagePath },
    ] },
    null,
    crossReportReuse,
  );
  assert.equal(structural.rows.length, 2, "structural QA must still inspect every generated cut");
  assert.equal(structural.rows.find((row) => row.image_id === ordinaryPrompt.image_id)?.semantic_audit, null);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

process.stdout.write("image semantic audit tests passed\n");
