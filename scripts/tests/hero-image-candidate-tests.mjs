#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildHeroCandidatePromptPlan,
  heroCandidateGroups,
  selectHeroCandidate,
  writeCanonicalHeroSelectionReceipt,
} from "../lib/hero-image-candidate-contract.mjs";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

const canonicalPrompt = {
  image_id: "cut_hero",
  image_generation_required: true,
  provider_prompt: "Joey turns one curved shield seven degrees and sends the Crown Ram into the pit.",
  image_prompt: "Joey turns one curved shield seven degrees and sends the Crown Ram into the pit.",
  codex_image_prompt: "Joey turns one curved shield seven degrees and sends the Crown Ram into the pit.",
  prompt_hash: "b".repeat(64),
  quality_budget: { tier: "hero", image_candidate_count: 2 },
  shot_manifest: { shot_job: "physical_action", foreground_action: "Joey turns the shield seven degrees" },
};
const ordinaryPrompt = {
  image_id: "cut_plain",
  image_generation_required: true,
  provider_prompt: "An empty corridor.",
  quality_budget: { tier: "connective", image_candidate_count: 1 },
};
const plan = buildHeroCandidatePromptPlan({ status: "passed", prompts: [canonicalPrompt, ordinaryPrompt] }, {
  sourcePath: "/tmp/canonical.json",
  sourceSha256: "a".repeat(64),
});
assert.equal(plan.prompts.length, 2);
assert.equal(plan.canonical_hero_image_ids.length, 1);
assert.equal(plan.prompts.every((row) => row.hero_candidate.canonical_image_id === "cut_hero"), true);
assert.equal(new Set(plan.prompts.map((row) => row.image_id)).size, 2);
assert.equal(plan.prompts.every((row) => row.image_id.includes("bbbbbbbbbb")), true);
assert.equal(heroCandidateGroups(plan)[0].prompts.map((row) => row.hero_candidate.candidate_label).join(""), "AB");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-hero-candidate-"));
try {
  const candidateAPath = path.join(root, "a.png");
  const candidateBPath = path.join(root, "b.png");
  await fs.writeFile(candidateAPath, "candidate-a");
  await fs.writeFile(candidateBPath, "candidate-b");
  const candidates = [
    { image_id: plan.prompts[0].image_id, candidate_label: "A", image_path: candidateAPath, image_sha256: hash("candidate-a"), browser_provider: "google-flow" },
    { image_id: plan.prompts[1].image_id, candidate_label: "B", image_path: candidateBPath, image_sha256: hash("candidate-b"), browser_provider: "google-gemini" },
  ];
  const dimensions = ["scene_event", "composition", "action_and_contact_geometry"];
  const semanticRows = [
    { image_id: candidates[0].image_id, confidence: "high", checks: dimensions.map((dimension) => ({ dimension, verdict: "pass" })) },
    { image_id: candidates[1].image_id, confidence: "high", checks: dimensions.map((dimension) => ({ dimension, verdict: dimension === "composition" ? "uncertain" : "pass" })) },
  ];
  const dominant = await selectHeroCandidate({
    canonicalPrompt,
    candidates,
    semanticAuditRows: semanticRows,
    outputPath: path.join(root, "selector.json"),
    repoRoot: root,
    blindSelector: async () => {
      throw new Error("semantic dominance should avoid selector spend");
    },
    selectedAt: new Date("2026-08-18T00:00:00.000Z"),
  });
  assert.equal(dominant.selected_candidate.label, "A");
  assert.equal(dominant.selection_method, "semantic_contract_dominance");

  const tiedRows = semanticRows.map((row) => ({ ...row, checks: dimensions.map((dimension) => ({ dimension, verdict: "pass" })) }));
  const blinded = await selectHeroCandidate({
    canonicalPrompt,
    candidates,
    semanticAuditRows: tiedRows,
    outputPath: path.join(root, "selector.json"),
    repoRoot: root,
    blindSelector: async () => ({ winner: "B", confidence: "high" }),
    selectedAt: new Date("2026-08-18T00:00:00.000Z"),
  });
  assert.equal(blinded.selected_candidate.label, "B");
  assert.equal(blinded.selection_method, "blind_visual_selector");

  const providerReceiptPath = path.join(root, "provider.json");
  await fs.writeFile(providerReceiptPath, `${JSON.stringify({ accepted_png_sha256: candidates[1].image_sha256 })}\n`);
  blinded.selected_candidate.provider_receipt_path = providerReceiptPath;
  blinded.selected_candidate.provider_receipt_sha256 = hash(await fs.readFile(providerReceiptPath));
  const canonicalReceiptPath = path.join(root, "canonical.json");
  const canonicalReceipt = await writeCanonicalHeroSelectionReceipt({
    selection: blinded,
    outputPath: canonicalReceiptPath,
    canonicalPromptPlanPath: "/tmp/canonical.json",
    canonicalPromptPlanSha256: "a".repeat(64),
  });
  assert.equal(canonicalReceipt.receipt.asset_id, "cut_hero");
  assert.equal(canonicalReceipt.receipt.accepted_png_sha256, candidates[1].image_sha256);
  assert.equal(canonicalReceipt.sha256, hash(await fs.readFile(canonicalReceiptPath)));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

process.stdout.write("hero image candidate tests passed\n");
