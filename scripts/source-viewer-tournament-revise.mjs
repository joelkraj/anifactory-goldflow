#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runChatGptWebPlanner } from "./chatgpt-web-planner-helper.mjs";

function parseFlags(parts) {
  const flags = {};
  for (let index = 0; index < parts.length; index += 1) {
    const token = parts[index];
    if (!token.startsWith("--")) continue;
    const next = parts[index + 1];
    flags[token.slice(2)] = next && !next.startsWith("--") ? next : "true";
    if (next && !next.startsWith("--")) index += 1;
  }
  return flags;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function mappedPreference(report, preference) {
  const label = String(preference ?? "").replace(/^SCRIPT\s+/i, "");
  const candidate = String(report?.script_label_map?.candidate ?? "").replace(/^SCRIPT\s+/i, "");
  const reference = String(report?.script_label_map?.reference ?? "").replace(/^SCRIPT\s+/i, "");
  if (label === candidate) return "candidate";
  if (label === reference) return "reference";
  return "tie";
}

const flags = parseFlags(process.argv.slice(2));
for (const required of ["candidate", "reference", "viewer-dir", "output"]) {
  if (!flags[required]) throw new Error(`Missing --${required}`);
}
const candidatePath = path.resolve(flags.candidate);
const referencePath = path.resolve(flags.reference);
const viewerDir = path.resolve(flags["viewer-dir"]);
const outputPath = path.resolve(flags.output);
const candidateTitle = String(flags["candidate-title"] ?? "Candidate title");
const referenceTitle = String(flags["reference-title"] ?? "Reference title");
const [candidate, reference, template] = await Promise.all([
  fs.readFile(candidatePath, "utf8"),
  fs.readFile(referencePath, "utf8"),
  fs.readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "prompts", "manhwa_recap_viewer_tournament_revision_v1.md"), "utf8"),
]);
const manifest = JSON.parse(await fs.readFile(path.join(viewerDir, "manifest.json"), "utf8"));
const names = (await fs.readdir(viewerDir)).filter((name) => name.endsWith(".json") && !["manifest.json", "aggregation.json"].includes(name)).sort();
if (names.length !== manifest.viewer_count) throw new Error(`Expected ${manifest.viewer_count} viewer reports, found ${names.length}.`);
const reports = await Promise.all(names.map(async (name) => JSON.parse(await fs.readFile(path.join(viewerDir, name), "utf8"))));

const checkpointTallies = {};
const dimensionTallies = {};
for (const report of reports) {
  for (const row of report.checkpoint_preferences ?? []) {
    checkpointTallies[row.checkpoint] ??= { candidate: 0, reference: 0, tie: 0 };
    checkpointTallies[row.checkpoint][mappedPreference(report, row.preference)] += 1;
  }
  for (const row of report.dimension_preferences ?? []) {
    dimensionTallies[row.dimension] ??= { candidate: 0, reference: 0, tie: 0 };
    dimensionTallies[row.dimension][mappedPreference(report, row.preference)] += 1;
  }
}
const aggregation = {
  schema: "goldflow_simulated_manhwa_viewer_aggregation_v1",
  candidate_sha256: sha256(candidate),
  reference_sha256: sha256(reference),
  viewer_count: reports.length,
  panel_seed: manifest.panel_seed,
  checkpoint_tallies: checkpointTallies,
  dimension_tallies: dimensionTallies,
  consensus_interpretation: {
    repair_target: "Derive the smallest high-value revision target from the exact current losses and repeated viewer notes. Do not assume the loss is opening-only.",
    protected_strengths: "Preserve every dimension and checkpoint where the candidate already wins, as evidenced by the current reports.",
    prohibited_shortcut: "Do not imitate the reference's characters, plot, world, or wording. Transfer only the underlying viewer appetite supported by current exact-anchor evidence.",
  },
};
await fs.writeFile(path.join(viewerDir, "aggregation.json"), `${JSON.stringify(aggregation, null, 2)}\n`, "utf8");

const prompt = `${template}\n\nCANDIDATE TITLE:\n${candidateTitle}\n\nREFERENCE TITLE:\n${referenceTitle}\n\nBINDING REFERENCE SHA256:\n${sha256(reference)}\n\nDETERMINISTIC AGGREGATION JSON:\n${JSON.stringify(aggregation, null, 2)}\n\nEXACT CONTROL AND ROTATING VIEWER REPORTS JSON:\n${JSON.stringify(reports, null, 2)}\n\nEXACT CANDIDATE SCRIPT:\n${candidate}`;
const result = await runChatGptWebPlanner({
  prompt,
  outputPath,
  workId: `source_viewer_revision_${sha256(candidate).slice(0, 12)}`,
  effort: "max",
  timeoutMs: 3_600_000,
});
const revised = await fs.readFile(outputPath, "utf8");
const report = {
  schema: "goldflow_viewer_tournament_revision_report_v1",
  source_candidate_path: candidatePath,
  source_candidate_sha256: sha256(candidate),
  reference_path: referencePath,
  reference_sha256: sha256(reference),
  viewer_aggregation_path: path.join(viewerDir, "aggregation.json"),
  output_path: outputPath,
  output_sha256: sha256(revised),
  output_word_count: revised.trim().split(/\s+/).length,
  provider: result.provider,
  model: result.model,
  reasoning_effort: result.reasoning_effort,
  receipt_path: result.bridge_receipt_path,
  completed_at: new Date().toISOString(),
};
await fs.writeFile(`${outputPath}.report.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
