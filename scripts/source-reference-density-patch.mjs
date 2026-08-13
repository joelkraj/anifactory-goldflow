#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { runChatGptWebPlanner } from "./chatgpt-web-planner-helper.mjs";
import { parseJsonObjectFromPlannerOutput } from "./lib/json-output-repair.mjs";
import { validateReferenceDensityDominance } from "./lib/winner-source-room-v2-contract.mjs";

function parseFlags(parts) {
  const flags = {};
  for (let index = 0; index < parts.length; index += 1) {
    if (!parts[index].startsWith("--")) continue;
    const key = parts[index].slice(2);
    const next = parts[index + 1];
    flags[key] = next && !next.startsWith("--") ? next : "true";
    if (next && !next.startsWith("--")) index += 1;
  }
  return flags;
}

function required(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`Missing ${label}.`);
  return text;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function wordCount(value) {
  return String(value ?? "").trim().split(/\s+/).filter(Boolean).length;
}

function normalizePlannerText(value) {
  return String(value ?? "").replaceAll("\\r\\n", "\n").replaceAll("\\n", "\n");
}

function applyExactTrim(script, document, protectedTexts) {
  if (document?.schema !== "goldflow_source_density_trim_v1") throw new Error("Density trim response has the wrong schema.");
  const deletions = Array.isArray(document.deletions) ? document.deletions : [];
  if (deletions.length < 1 || deletions.length > 12) throw new Error("Density trim requires 1-12 exact deletions.");
  const ranges = deletions.map((row, index) => {
    const exactText = normalizePlannerText(row?.exact_text).trim();
    const start = script.indexOf(exactText);
    if (!exactText || start < 0 || script.indexOf(exactText, start + exactText.length) >= 0) {
      throw new Error(`Density trim deletion ${index + 1} is not a unique exact excerpt.`);
    }
    const end = start + exactText.length;
    for (const protectedText of protectedTexts) {
      const protectedStart = script.indexOf(protectedText);
      if (protectedStart >= 0 && start < protectedStart + protectedText.length && end > protectedStart) {
        throw new Error(`Density trim deletion ${index + 1} overlaps a protected patch.`);
      }
    }
    return { start, end };
  }).sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].start < ranges[index - 1].end) throw new Error("Density trim deletions overlap.");
  }
  let revised = script;
  for (const range of [...ranges].reverse()) revised = `${revised.slice(0, range.start)}${revised.slice(range.end)}`;
  return revised.replace(/\n{3,}/g, "\n\n").trim();
}

function applyPatches(script, document, findingIds) {
  if (document?.schema !== "goldflow_reference_density_patch_v1") throw new Error("Density patch response has the wrong schema.");
  const patches = Array.isArray(document.patches) ? document.patches : [];
  if (patches.length < 1 || patches.length > 6) throw new Error(`Density patch requires 1-6 exact patches; found ${patches.length}.`);
  const covered = new Set();
  let revised = script;
  let totalReplacementWords = 0;
  const applied = [];
  for (const [index, row] of patches.entries()) {
    const findingId = String(row?.finding_id ?? "").trim();
    if (!findingIds.has(findingId)) throw new Error(`Patch ${index + 1} names an unknown finding_id.`);
    const find = normalizePlannerText(row?.find);
    const replace = normalizePlannerText(row?.replace);
    if (!find.trim() || !replace.trim()) throw new Error(`Patch ${index + 1} has an empty find or replace value.`);
    const start = revised.indexOf(find);
    if (start < 0 || revised.indexOf(find, start + find.length) >= 0) throw new Error(`Patch ${index + 1} find text is not unique in the current script.`);
    const findWords = wordCount(find);
    const replacementWords = wordCount(replace);
    if (findWords < 5 || findWords > 420) throw new Error(`Patch ${index + 1} find span has ${findWords} words; expected 5-420.`);
    if (replacementWords > 460) throw new Error(`Patch ${index + 1} replacement exceeds 460 words.`);
    totalReplacementWords += replacementWords;
    revised = `${revised.slice(0, start)}${replace}${revised.slice(start + find.length)}`;
    covered.add(findingId);
    applied.push({
      finding_id: findingId,
      rationale: String(row?.rationale ?? "").trim(),
      find_sha256: sha256(find),
      replacement_sha256: sha256(replace),
      find_word_count: findWords,
      replacement_word_count: replacementWords,
    });
  }
  if (totalReplacementWords > 900) throw new Error(`Density patch replaces ${totalReplacementWords} words; maximum is 900.`);
  for (const findingId of findingIds) {
    if (!covered.has(findingId)) throw new Error(`Density patch does not address ${findingId}.`);
  }
  const delta = Math.abs(wordCount(revised) - wordCount(script));
  if (delta > 180) throw new Error(`Density patch changes total length by ${delta} words; maximum is 180.`);
  return { revised, applied };
}

const flags = parseFlags(process.argv.slice(2));
const candidatePath = path.resolve(required(flags.candidate, "--candidate <path>"));
const referencePath = path.resolve(required(flags.reference, "--reference <path>"));
const frontierPath = path.resolve(required(flags.frontier, "--frontier <path>"));
const diagnosticPath = path.resolve(required(flags.diagnostic, "--diagnostic <path>"));
const outputPath = path.resolve(required(flags.output, "--output <path>"));
const responsePath = path.resolve(flags["response-path"] ?? `${outputPath}.patch-response.txt`);
const reportPath = path.resolve(flags["report-output"] ?? `${outputPath}.report.json`);
const [candidate, reference, frontierBytes, diagnosticBytes] = await Promise.all([
  fs.readFile(candidatePath, "utf8"),
  fs.readFile(referencePath, "utf8"),
  fs.readFile(frontierPath),
  fs.readFile(diagnosticPath),
]);
const frontier = JSON.parse(frontierBytes.toString("utf8"));
const diagnostic = JSON.parse(diagnosticBytes.toString("utf8"));
const validation = validateReferenceDensityDominance(diagnostic, {
  scriptText: candidate,
  scriptSha256: sha256(candidate),
  referenceText: reference,
  referenceSha256: sha256(reference),
  frontierSha256: sha256(frontierBytes),
  referenceMeritFrontier: frontier,
});
if (!validation.done) throw new Error(`Density diagnostic is blocked: ${validation.blockers.join(", ")}`);
const findingIds = new Set(validation.accepted_findings.map((row) => row.id));
if (findingIds.size < 1 || diagnostic.status !== "findings") throw new Error("Density patch requires a validated diagnostic with findings.");
const nonwinningEdges = diagnostic.edge_verdicts.filter((row) => row.decision !== "candidate_win").map((row) => ({
  edge_id: row.edge_id,
  decision: row.decision,
  candidate_advantage_or_gap: row.candidate_advantage_or_gap,
  candidate_anchor: row.candidate_anchor,
}));
const prompt = `Make the smallest possible surgical repair to an original manhwa-recap narration so its remaining measured density ties/losses become decisive wins. Return JSON only.

Do not rewrite the complete script. Return one to six exact find-and-replace patches. Every patch must name one validated finding_id. Copy each find span exactly and uniquely from the candidate. Preserve chronology, names, central mechanics, all existing dimension wins, all existing material-edge wins, title truth, emotional logic, and ending. Several patches may address one finding when setup and payoff must move together.

For a concealed-plan finding, remove or veil the pre-announced mechanism and reveal the logic only after the opponent has visibly committed. Preserve fair setup through concrete objects, signals, or choices rather than advance explanation. For opening density, improve the first visible receipt inside the existing confrontation without adding lore or delaying Theft/100X. For visual body horror, externalize the existing injury through one legible bodily manifestation; do not introduce another mechanic.

Across all patches, replace at most 900 words and change total length by at most 180 words. The final script must remain 9,500-10,500 words. No new subplot, disposable character, stat dump, legal/ledger procedure, or copied reference event.

Schema: {"schema":"goldflow_reference_density_patch_v1","diagnosis":"concise integrated diagnosis","patches":[{"finding_id":"validated ID","rationale":"viewer effect repaired","find":"exact unique candidate prose","replace":"polished replacement narration"}]}.

VALIDATED FINDINGS:
${JSON.stringify(validation.accepted_findings, null, 2)}

NONWINNING MATERIAL EDGES:
${JSON.stringify(nonwinningEdges, null, 2)}

EXACT CURRENT SCRIPT:
${candidate}`;
let providerReceipt = null;
const existingResponse = await fs.readFile(responsePath, "utf8").catch(() => "");
if (!existingResponse.trim()) {
  providerReceipt = await runChatGptWebPlanner({
    prompt,
    outputPath: responsePath,
    workId: `source_reference_density_patch_${sha256(candidate).slice(0, 12)}`,
    effort: "max",
    timeoutMs: Number(flags["timeout-ms"] ?? 3_600_000),
    rateClass: "source_revision",
  });
}
const document = parseJsonObjectFromPlannerOutput(await fs.readFile(responsePath, "utf8")).value;
let { revised, applied } = applyPatches(candidate, document, findingIds);
let densityTrim = null;
if (wordCount(revised) > 10_500 && wordCount(revised) <= 10_750) {
  const trimResponsePath = path.resolve(flags["trim-response-path"] ?? `${outputPath}.density-trim-response.txt`);
  const protectedTexts = document.patches.map((row) => normalizePlannerText(row.replace)).filter(Boolean);
  const existingTrim = await fs.readFile(trimResponsePath, "utf8").catch(() => "");
  if (!existingTrim.trim()) {
    const minimumDeletion = wordCount(revised) - 10_480;
    const trimPrompt = `Return JSON only. Select 1-12 unique exact contiguous excerpts to delete from this completed manhwa-recap narration. Delete ${minimumDeletion}-${minimumDeletion + 100} words total. Preserve the first 220 words, final 350 words, every protected patch, chronology, causal logic, setup/payoff, and emotional consequence. Prefer redundant explanation, repeated reaction, or second-pass description. Do not rewrite or add prose. Schema: {"schema":"goldflow_source_density_trim_v1","deletions":[{"exact_text":"byte-for-byte unique script excerpt","reason":"why deletion is safe"}]}.

PROTECTED PATCHES:
${JSON.stringify(protectedTexts, null, 2)}

EXACT PATCHED SCRIPT:
${revised}`;
    providerReceipt = await runChatGptWebPlanner({
      prompt: trimPrompt,
      outputPath: trimResponsePath,
      workId: `source_reference_density_patch_trim_${sha256(revised).slice(0, 12)}`,
      effort: "max",
      timeoutMs: Number(flags["timeout-ms"] ?? 3_600_000),
      rateClass: "source_revision",
    });
  }
  const trimDocument = parseJsonObjectFromPlannerOutput(await fs.readFile(trimResponsePath, "utf8")).value;
  const beforeWords = wordCount(revised);
  revised = applyExactTrim(revised, trimDocument, protectedTexts);
  densityTrim = { deletion_count: trimDocument.deletions.length, deleted_word_count: beforeWords - wordCount(revised) };
}
if (wordCount(revised) < 9_500 || wordCount(revised) > 10_500) throw new Error(`Density-patched script has ${wordCount(revised)} words; expected 9500-10500.`);
await fs.writeFile(outputPath, revised, { flag: "wx" });
const report = {
  schema: "goldflow_reference_density_patch_report_v1",
  status: "passed",
  candidate_path: candidatePath,
  candidate_sha256: sha256(candidate),
  diagnostic_path: diagnosticPath,
  diagnostic_sha256: sha256(diagnosticBytes),
  output_path: outputPath,
  output_sha256: sha256(revised),
  source_word_count: wordCount(candidate),
  output_word_count: wordCount(revised),
  diagnosis: String(document.diagnosis ?? "").trim(),
  patches: applied,
  ...(densityTrim ? { density_trim: densityTrim } : {}),
  provider: providerReceipt?.provider ?? "reused_response",
  model: providerReceipt?.model ?? "gpt-5.6-sol",
  reasoning_effort: providerReceipt?.reasoning_effort ?? "max",
  receipt_path: providerReceipt?.bridge_receipt_path ?? null,
  completed_at: new Date().toISOString(),
};
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify(report, null, 2));
