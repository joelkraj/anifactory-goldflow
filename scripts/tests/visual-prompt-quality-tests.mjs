#!/usr/bin/env node

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  compileVisualPrompt,
  validateVisualPromptCompilerReceipt,
} from "../lib/visual-prompt-compiler.mjs";
import { runVisualPromptHardCutBenchmark } from "../lib/visual-prompt-benchmark.mjs";
import {
  createCodexWorkManifest,
  leaseNextWorkItem,
  sha256,
} from "../lib/codex-image-work-contract.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = JSON.parse(await fs.readFile(path.join(repoRoot, "scripts", "fixtures", "visual_prompt_hard_cut_benchmark_v1.json"), "utf8"));

const report = runVisualPromptHardCutBenchmark(fixture, { generatedAt: new Date("2026-08-18T00:00:00.000Z") });
assert.equal(report.status, "passed");
assert.equal(report.scope.locked_case_count, 25);
assert.equal(report.scope.compiled_prompt_count, 75);
assert.equal(report.failed_count, 0);
assert.deepEqual(Object.values(report.provider_summary).map((row) => row.passed), [25, 25, 25]);

const sample = fixture.cases[4];
const references = [{ slot: 1, ref_id: "kael", purpose: "identity", sha256: "a".repeat(64) }];
const flow = compileVisualPrompt({
  provider: "google-flow",
  neutralPrompt: sample.neutral_prompt,
  shotManifest: sample.shot_manifest,
  orderedReferences: references,
  assetId: sample.case_id,
});
const gemini = compileVisualPrompt({
  provider: "google-gemini",
  neutralPrompt: sample.neutral_prompt,
  shotManifest: sample.shot_manifest,
  orderedReferences: references,
  assetId: sample.case_id,
});
assert.notEqual(flow.prompt_sha256, gemini.prompt_sha256);
assert.equal(flow.prompt.includes(sample.neutral_prompt), true);
assert.deepEqual(validateVisualPromptCompilerReceipt({
  prompt: flow.prompt,
  receipt: flow.receipt,
  neutralPrompt: sample.neutral_prompt,
  provider: "google-flow",
  orderedReferences: references,
}), []);
assert.equal(validateVisualPromptCompilerReceipt({
  prompt: `${flow.prompt} changed`,
  receipt: flow.receipt,
  neutralPrompt: sample.neutral_prompt,
  provider: "google-flow",
  orderedReferences: references,
}).includes("compiler_output_hash_mismatch"), true);

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-visual-prompt-quality-"));
try {
  const episodeDir = path.join(temporaryRoot, "episode");
  await fs.mkdir(episodeDir, { recursive: true });
  const promptsPath = path.join(episodeDir, "section_image_prompts_hardened.json");
  const neutralPrompt = "Kael catches one falling beam while the evacuation lane clears behind him.";
  await fs.writeFile(promptsPath, `${JSON.stringify({
    status: "passed",
    image_provider: "federated_web_image",
    prompts: [{
      image_id: "cut_001",
      image_generation_required: true,
      codex_image_prompt: neutralPrompt,
      shot_manifest: {
        shot_job: "physical_action",
        foreground_action: "Kael catches the falling beam",
        visible_characters: ["Kael"],
      },
      sequence_grammar: { shot_size: "medium wide", camera_angle: "low angle", vantage: "front three-quarter" },
      spatial_continuity: { primary_screen_position: "frame-left", travel_direction: "left-to-right" },
      quality_budget: { image_candidate_count: 2 },
      reference_slots: [],
    }],
  }, null, 2)}\n`, "utf8");
  const created = await createCodexWorkManifest({
    mode: "scene",
    episodeDir,
    promptsPath,
    imageIds: ["cut_001"],
    allowedBrowserProviders: ["google-gemini"],
    browserProviderConcurrency: { "google-gemini": 1 },
    browserProviderReceiptRequired: true,
  });
  const manifestItem = created.manifest.items[0];
  assert.equal(manifestItem.neutral_prompt, neutralPrompt);
  assert.equal(manifestItem.neutral_prompt_sha256, sha256(neutralPrompt));
  assert.equal(manifestItem.quality_budget.image_candidate_count, 2);
  const leased = await leaseNextWorkItem({
    manifestPath: created.manifest.manifest_path,
    workerId: "gemini-benchmark-worker",
    browserProvider: "google-gemini",
  });
  assert.equal(leased.status, "leased");
  assert.equal(leased.assignment.item.prompt_compiler_receipt.provider, "google-gemini");
  assert.equal(leased.assignment.item.prompt.includes("DECISIVE ACTION: Kael catches the falling beam."), true);
  assert.equal(leased.assignment.item.prompt.includes("medium wide"), true);
  assert.notEqual(leased.assignment.item.prompt_sha256, manifestItem.prompt_sha256);
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write("visual prompt quality tests passed\n");
