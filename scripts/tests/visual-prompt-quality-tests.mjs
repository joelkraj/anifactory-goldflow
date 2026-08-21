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
import {
  VISUAL_PROMPT_SAFE_MAX_BYTES,
  sizeBoundVisualPromptChunksForTests,
} from "../visual-plan.mjs";
import {
  TRANSITION_PROMPT_SAFE_MAX_BYTES,
  acceptedTransitionCacheForTests,
  sizeBoundTransitionChunksForTests,
  transitionChunkAcceptanceForTests,
  transitionContentAddressedPathsForTests,
  transitionRepairScopeForTests,
} from "../visual-transition-plan.mjs";
import {
  VISUAL_REFERENCE_CHUNK_SAFE_MAX_BYTES,
  VISUAL_REFERENCE_DIRECTOR_SAFE_MAX_BYTES,
  assertVisualReferencePromptBytesForTests,
  splitVisualReferenceChunkForTests,
} from "../visual-reference-plan.mjs";

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

const multibyteVisualRows = Array.from({ length: 4 }, (_, index) => ({
  visual_beat_id: `beat_${index + 1}`,
  evidence: "🔥".repeat(180),
}));
const fittedVisualChunks = sizeBoundVisualPromptChunksForTests([multibyteVisualRows], {
  maxBytes: 1_900,
  promptForRows: (rows) => JSON.stringify(rows),
});
assert.ok(fittedVisualChunks.length > 1);
assert.ok(fittedVisualChunks.every((rows) => Buffer.byteLength(JSON.stringify(rows), "utf8") <= 1_900));
assert.deepEqual(fittedVisualChunks.flat().map((row) => row.visual_beat_id), multibyteVisualRows.map((row) => row.visual_beat_id));
assert.throws(() => sizeBoundVisualPromptChunksForTests([[{
  visual_beat_id: "beat_too_large",
  evidence: "🔥".repeat(600),
}]], {
  maxBytes: 1_900,
  promptForRows: (rows) => JSON.stringify(rows),
}), /exact unit beat_too_large.*bytes/);
assert.equal(VISUAL_PROMPT_SAFE_MAX_BYTES, 48_000);

const transitionBoundaries = Array.from({ length: 12 }, (_, index) => ({
  boundary_id: `boundary_${index + 1}`,
  to_image_id: `cut_${index + 2}`,
  context: "界".repeat(140),
}));
const transitionPromptBuilder = (rows) => JSON.stringify({ boundaries: rows });
const fittedTransitionChunks = sizeBoundTransitionChunksForTests(transitionBoundaries, {
  chunkSize: 12,
  maxBytes: 2_400,
  promptBuilder: transitionPromptBuilder,
});
assert.ok(fittedTransitionChunks.length > 1);
assert.ok(fittedTransitionChunks.every((rows) => Buffer.byteLength(transitionPromptBuilder(rows), "utf8") <= 2_400));
assert.equal(TRANSITION_PROMPT_SAFE_MAX_BYTES, 36_000);
const firstTransitionAddress = transitionContentAddressedPathsForTests("/tmp/transition-calls", transitionPromptBuilder(fittedTransitionChunks[0]));
const resumedTransitionAddress = transitionContentAddressedPathsForTests("/tmp/transition-calls", transitionPromptBuilder(fittedTransitionChunks[0]));
assert.deepEqual(resumedTransitionAddress, firstTransitionAddress);
assert.match(firstTransitionAddress.output_path, new RegExp(`${firstTransitionAddress.prompt_sha256}-output\\.json$`));
const acceptedTransitionContent = JSON.stringify({
  transition_events: [{ boundary_id: "boundary_1", to_image_id: "cut_2" }],
  warnings: [],
});
const transitionAcceptance = transitionChunkAcceptanceForTests({
  content: acceptedTransitionContent,
  promptSha256: firstTransitionAddress.prompt_sha256,
  boundaries: fittedTransitionChunks[0],
  acceptedAt: "2026-08-21T00:00:00.000Z",
});
assert.equal(acceptedTransitionCacheForTests({
  content: acceptedTransitionContent,
  acceptance: transitionAcceptance,
  promptSha256: firstTransitionAddress.prompt_sha256,
  boundaries: fittedTransitionChunks[0],
})?.transition_events.length, 1);
assert.throws(() => transitionChunkAcceptanceForTests({
  content: "not valid provider JSON",
  promptSha256: firstTransitionAddress.prompt_sha256,
  boundaries: fittedTransitionChunks[0],
}), /did not contain JSON/);
assert.equal(acceptedTransitionCacheForTests({
  content: "not valid provider JSON",
  acceptance: transitionAcceptance,
  promptSha256: firstTransitionAddress.prompt_sha256,
  boundaries: fittedTransitionChunks[0],
}), null, "malformed provider output must never be reusable as an accepted chunk");
const transitionRepair = transitionRepairScopeForTests({
  boundaries: transitionBoundaries,
  existingPlan: {
    status: "blocked",
    failed_boundary_ids: ["boundary_1", "boundary_2"],
    transition_events: [{ boundary_id: "boundary_3", start_sec: 3 }],
  },
  requestedBoundaryIds: ["boundary_1"],
});
assert.deepEqual(transitionRepair.boundaries.map((row) => row.boundary_id), ["boundary_1"]);
assert.deepEqual(transitionRepair.remaining_failed_boundary_ids, ["boundary_2"]);
assert.deepEqual(transitionRepair.preserved_transition_events.map((event) => event.boundary_id), ["boundary_3"]);
assert.throws(() => transitionRepairScopeForTests({
  boundaries: transitionBoundaries,
  existingPlan: { status: "blocked", failed_boundary_ids: ["boundary_1"] },
}), /unscoped resubmission is forbidden/);
assert.throws(() => transitionRepairScopeForTests({
  boundaries: transitionBoundaries,
  existingPlan: { status: "blocked", failed_boundary_ids: ["boundary_1"] },
  requestedBoundaryIds: ["boundary_3"],
}), /not failed in the blocked artifact.*Passed boundaries are immutable/);

assert.equal(VISUAL_REFERENCE_CHUNK_SAFE_MAX_BYTES, 48_000);
assert.equal(VISUAL_REFERENCE_DIRECTOR_SAFE_MAX_BYTES, 96 * 1024);
assert.deepEqual(
  splitVisualReferenceChunkForTests([{
    scene_id: "scene_dense",
    visual_beats: Array.from({ length: 8 }, (_, index) => ({ visual_beat_id: `beat_${index + 1}` })),
  }]).map((rows) => rows[0].visual_beats.length),
  [4, 4],
);
assert.equal(assertVisualReferencePromptBytesForTests("界".repeat(1_000), { maxBytes: 4_000 }), 3_000);
assert.throws(() => assertVisualReferencePromptBytesForTests("界".repeat(30_000), {
  label: "visual-reference exact chunk fixture",
  maxBytes: 1_000_000,
}), /above safe ceiling 48000/);

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
