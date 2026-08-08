#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const EPISODE_DIR = "/Users/joel/AniFactoryData/channels/immersivepov/weekly_runs/2026-W32-immersive-pov-illegal-brothel-proof-v1/episodes/ep_01";
const STYLE_REFERENCE = "/Users/joel/AniFactoryData/channels/immersivepov/style_references/immersive_pov_crayon_style_ref_v1.png";
const RUN_DIR = path.join(EPISODE_DIR, "review_samples/gpt_web_crayon_full_proof_v1");
const PROMPT_DIR = path.join(RUN_DIR, "prompts");

const firstReportPath = path.join(EPISODE_DIR, "review_samples/gpt_crayon_style_first10_v1/test_report.json");
const firstPromptsPath = path.join(EPISODE_DIR, "review_samples/gpt_crayon_style_first10_v1/first_10_cut_prompts.txt");
const remainingManifestPath = path.join(EPISODE_DIR, "review_samples/gpt_crayon_style_full_proof_v1/remaining_37_manifest.json");
const remainingPromptsPath = path.join(EPISODE_DIR, "review_samples/gpt_crayon_style_full_proof_v1/remaining_37_prompts.txt");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function promptLines(value, expectedCount, label) {
  const lines = value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== expectedCount) {
    throw new Error(`${label} contains ${lines.length} prompts; expected ${expectedCount}`);
  }
  return lines;
}

await fs.mkdir(PROMPT_DIR, { recursive: true });

const firstReport = JSON.parse(await fs.readFile(firstReportPath, "utf8"));
const firstIds = [...firstReport.completed_cut_ids];
const firstPrompts = promptLines(await fs.readFile(firstPromptsPath, "utf8"), 10, "First-ten packet");
const remainingManifest = JSON.parse(await fs.readFile(remainingManifestPath, "utf8"));
const remainingIds = remainingManifest.cuts.map((cut) => cut.image_id);
const remainingPrompts = promptLines(await fs.readFile(remainingPromptsPath, "utf8"), 37, "Remaining packet");
const cutIds = [...firstIds, ...remainingIds];
const prompts = [...firstPrompts.slice(0, firstIds.length), ...remainingPrompts];

if (new Set(cutIds).size !== 46) throw new Error("The scoped image packet must contain 46 unique cut IDs");

const jobs = [];
const cutLedger = [];
for (let index = 0; index < cutIds.length; index += 1) {
  const cutId = cutIds[index];
  const prompt = prompts[index];
  const promptName = `${String(index + 1).padStart(2, "0")}-${cutId}.txt`;
  const promptPath = path.join(PROMPT_DIR, promptName);
  await fs.writeFile(promptPath, `${prompt}\n`, { flag: "wx" });
  jobs.push({
    id: `crayon_${String(index + 1).padStart(2, "0")}_${cutId}`,
    kind: "image",
    promptPath: path.relative(RUN_DIR, promptPath),
    effort: "medium",
    references: [{ path: STYLE_REFERENCE, name: "immersive_pov_crayon_style_ref_v1.png" }],
    expectedImageCount: 1,
    expectedAspectRatio: "16:9",
    timeoutMs: 1_200_000,
  });
  cutLedger.push({
    ordinal: index + 1,
    cut_id: cutId,
    job_id: jobs.at(-1).id,
    prompt_path: promptPath,
    prompt_sha256: sha256(prompt),
  });
}

const manifest = {
  schema: "goldflow_chatgpt_jobs_v1",
  runId: "immersive_pov_brothel_crayon_full_v1",
  descriptorPath: "/Users/joel/.codex-chatgpt-web/runtime/launcher-browser.json",
  outputDir: "./chatgpt_web_run",
  concurrency: 5,
  jobs,
};

await fs.writeFile(path.join(RUN_DIR, "jobs.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
await fs.writeFile(path.join(RUN_DIR, "cut_job_ledger.json"), `${JSON.stringify({
  schema: "immersive_pov_chatgpt_web_cut_job_ledger_v1",
  intent: "bounded_proof_0_180_seconds",
  style_reference_path: STYLE_REFERENCE,
  style_reference_sha256: sha256(await fs.readFile(STYLE_REFERENCE)),
  cut_count: cutLedger.length,
  cuts: cutLedger,
}, null, 2)}\n`, { flag: "wx" });

console.log(JSON.stringify({ run_dir: RUN_DIR, manifest: path.join(RUN_DIR, "jobs.json"), cut_count: jobs.length }, null, 2));
