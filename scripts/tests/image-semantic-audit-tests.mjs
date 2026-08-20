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

assert.equal(semanticAuditSelectionForTests(heroPrompt, { ordinarySampleRate: 0 }).selected, true);
assert.equal(semanticAuditSelectionForTests(heroPrompt, { ordinarySampleRate: 0 }).reasons.includes("hero_beat"), true);
assert.equal(semanticAuditSelectionForTests(ordinaryPrompt, { ordinarySampleRate: 0 }).selected, false);

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
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

process.stdout.write("image semantic audit tests passed\n");
