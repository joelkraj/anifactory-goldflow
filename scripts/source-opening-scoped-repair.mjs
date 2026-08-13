#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runChatGptWebPlanner } from "./chatgpt-web-planner-helper.mjs";
import { parseJsonObjectFromPlannerOutput } from "./lib/json-output-repair.mjs";

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

function words(text) {
  return String(text ?? "").trim().split(/\s+/).filter(Boolean);
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
for (const key of ["script", "reference", "viewer-dir", "output", "handoff-marker"]) {
  if (!flags[key]) throw new Error(`Missing --${key}`);
}

const scriptPath = path.resolve(flags.script);
const referencePath = path.resolve(flags.reference);
const viewerDir = path.resolve(flags["viewer-dir"]);
const outputPath = path.resolve(flags.output);
const handoffMarker = String(flags["handoff-marker"]);
const activationTerm = String(flags["activation-term"] ?? "").trim();
const proofTerm = String(flags["proof-term"] ?? "").trim();
const activationByWord = Number.parseInt(flags["activation-by-word"] ?? "100", 10);
const proofByWord = Number.parseInt(flags["proof-by-word"] ?? "190", 10);
const minimumWords = Number.parseInt(flags["min-words"] ?? "500", 10);
const maximumWords = Number.parseInt(flags["max-words"] ?? "700", 10);
const candidateTitle = String(flags["candidate-title"] ?? "Candidate title");
const referenceTitle = String(flags["reference-title"] ?? "Reference title");

if (!Number.isInteger(activationByWord) || activationByWord < 1) throw new Error("Invalid --activation-by-word.");
if (!Number.isInteger(proofByWord) || proofByWord < activationByWord) throw new Error("Invalid --proof-by-word.");
if (!Number.isInteger(minimumWords) || !Number.isInteger(maximumWords) || minimumWords < 100 || maximumWords < minimumWords) {
  throw new Error("Invalid opening word bounds.");
}

const [script, reference] = await Promise.all([
  fs.readFile(scriptPath, "utf8"),
  fs.readFile(referencePath, "utf8"),
]);
const markerIndex = script.indexOf(handoffMarker);
if (markerIndex < 0) throw new Error("Current script does not contain the exact immutable handoff marker.");
if (script.indexOf(handoffMarker, markerIndex + handoffMarker.length) >= 0) {
  throw new Error("The immutable handoff marker is not unique in the current script.");
}

const currentOpening = script.slice(0, markerIndex).trim();
const immutableTail = script.slice(markerIndex);
const reportNames = (await fs.readdir(viewerDir))
  .filter((name) => name.endsWith(".json") && !["manifest.json", "aggregation.json"].includes(name))
  .sort();
if (reportNames.length !== 10) throw new Error(`Expected ten fixed-panel viewer reports, found ${reportNames.length}.`);
const reports = await Promise.all(reportNames.map(async (name) => {
  const raw = await fs.readFile(path.join(viewerDir, name), "utf8");
  return parseJsonObjectFromPlannerOutput(raw).value;
}));

const openingEvidence = reports.map((report) => ({
  persona_id: report.persona_id,
  candidate_label: report?.script_label_map?.candidate,
  checkpoint_30_seconds: (report.checkpoint_preferences ?? []).find((row) => row.checkpoint === "30_seconds"),
  checkpoint_60_seconds: (report.checkpoint_preferences ?? []).find((row) => row.checkpoint === "60_seconds"),
  opening_quality: (report.dimension_preferences ?? []).find((row) => row.dimension === "opening_quality"),
  candidate_leave_risk: report?.earliest_leave_risk?.[String(report?.script_label_map?.candidate ?? "").replace(/^SCRIPT\s+/i, "")],
}));
const openingTallies = Object.fromEntries(["30_seconds", "60_seconds"].map((checkpoint) => {
  const tally = { candidate: 0, reference: 0, tie: 0 };
  for (const report of reports) {
    const row = (report.checkpoint_preferences ?? []).find((item) => item.checkpoint === checkpoint);
    tally[mappedPreference(report, row?.preference)] += 1;
  }
  return [checkpoint, tally];
}));
const openingQualityTally = { candidate: 0, reference: 0, tie: 0 };
for (const report of reports) {
  const row = (report.dimension_preferences ?? []).find((item) => item.dimension === "opening_quality");
  openingQualityTally[mappedPreference(report, row?.preference)] += 1;
}

const referenceOpening = words(reference).slice(0, 1_200).join(" ");
const tailContext = words(immutableTail).slice(0, 500).join(" ");
const deadlineContract = [
  activationTerm ? `- The visible title activation ${JSON.stringify(activationTerm)} must appear by spoken word ${activationByWord}.` : "",
  proofTerm ? `- The first unmistakable result ${JSON.stringify(proofTerm)} must appear by spoken word ${proofByWord}.` : "",
].filter(Boolean).join("\n");

const prompt = `Rewrite only the candidate's opening segment as spoken manhwa-recap narration. Output only the replacement opening prose. No heading, notes, analysis, handoff marker, or Markdown.

This is a surgical repair after one fixed, blinded ten-viewer tournament. The candidate already wins all ten overall and APV votes, and it wins every checkpoint from three minutes onward ten to zero. Preserve that winning story. Your replacement will be joined byte-for-byte to the immutable sentence beginning ${JSON.stringify(handoffMarker)}.

The only repair target is the first sixty seconds. Use the supplied viewer evidence to make the drama instantly legible and visibly pay the clicked title mechanism before fragile viewers must decode secondary lore. Preserve the protagonist's defining human choice, the antagonist's immediate pressure, the relationship stake, the physical action, and the exact ending state required by the continuation.

Binding requirements:
- Keep the same POV, story facts, chronology, relationships, power outcome, injuries, possessions, and legal or institutional state at the handoff.
- Start inside a visible act of humiliation, betrayal, danger, or coercion. The protagonist must make an active choice, not merely receive power.
- Use concrete action and consequence before terminology. Introduce only the proper nouns and rules needed to understand the current choice.
- Convert explanations into visible cause and effect. Defer any rule the immutable continuation can teach later.
- Deliver one clean emotional question, one clean power-fantasy question, and one unmistakable reversal in the first minute.
${deadlineContract}
- Keep the replacement between ${minimumWords} and ${maximumWords} spoken words.
- Preserve the exact final state and causal bridge into the immutable handoff context below.
- Do not copy the reference's wording, characters, plot, world, or proper nouns. Transfer only the demonstrated appetite for speed, clarity, emotional force, and visible payoff.
- Do not write a trailer, flash-forward, channel intro, recap preamble, or explanatory summary. Let one continuous scene happen.
- End immediately before the immutable handoff marker. Do not include any part of that handoff.

CANDIDATE TITLE:
${candidateTitle}

REFERENCE TITLE:
${referenceTitle}

DETERMINISTIC OPENING TALLIES:
${JSON.stringify({ checkpoints: openingTallies, opening_quality: openingQualityTally }, null, 2)}

FIXED-PANEL OPENING EVIDENCE:
${JSON.stringify(openingEvidence, null, 2)}

CURRENT CANDIDATE OPENING SEGMENT:
${currentOpening}

IMMUTABLE CONTINUATION CONTEXT:
${tailContext}

MEASURED OUTLIER OPENING FOR EXPERIENCE COMPARISON ONLY:
${referenceOpening}`;

const responsePath = `${outputPath}.opening-response.txt`;
const result = await runChatGptWebPlanner({
  prompt,
  outputPath: responsePath,
  workId: `source_opening_scoped_repair_${sha256(script).slice(0, 12)}`,
  effort: "max",
  timeoutMs: 3_600_000,
});
const replacement = (await fs.readFile(responsePath, "utf8")).trim();
if (replacement.includes(handoffMarker)) throw new Error("Scoped opening response included the immutable handoff marker.");
const replacementWords = words(replacement);
if (replacementWords.length < minimumWords || replacementWords.length > maximumWords) {
  throw new Error(`Scoped opening response has ${replacementWords.length} words; expected ${minimumWords}-${maximumWords}.`);
}
for (const [term, maximum] of [[activationTerm, activationByWord], [proofTerm, proofByWord]]) {
  if (!term) continue;
  const index = replacement.indexOf(term);
  if (index < 0) throw new Error(`Scoped opening response omitted ${term}.`);
  const position = words(replacement.slice(0, index)).length;
  if (position > maximum) throw new Error(`${term} lands at word ${position}; required by ${maximum}.`);
}

const revised = `${replacement}\n\n${immutableTail}`;
await fs.writeFile(outputPath, revised, "utf8");
const report = {
  schema: "goldflow_scoped_opening_repair_v2",
  source_script_path: scriptPath,
  source_script_sha256: sha256(script),
  reference_path: referencePath,
  reference_sha256: sha256(reference),
  viewer_dir: viewerDir,
  viewer_manifest_sha256: sha256(await fs.readFile(path.join(viewerDir, "manifest.json"))),
  opening_tallies: openingTallies,
  opening_quality_tally: openingQualityTally,
  output_path: outputPath,
  output_sha256: sha256(revised),
  replacement_word_count: replacementWords.length,
  total_word_count: words(revised).length,
  immutable_tail_sha256: sha256(immutableTail),
  activation_term: activationTerm || null,
  activation_word_position: activationTerm ? words(replacement.slice(0, replacement.indexOf(activationTerm))).length : null,
  proof_term: proofTerm || null,
  proof_word_position: proofTerm ? words(replacement.slice(0, replacement.indexOf(proofTerm))).length : null,
  provider: result.provider,
  model: result.model,
  reasoning_effort: result.reasoning_effort,
  receipt_path: result.bridge_receipt_path,
  completed_at: new Date().toISOString(),
};
await fs.writeFile(`${outputPath}.report.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
