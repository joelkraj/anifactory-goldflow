#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function wordCount(value) {
  return String(value ?? "").trim().split(/\s+/).filter(Boolean).length;
}

function decodePlannerLineBreaks(value) {
  return String(value ?? "").replaceAll("\\r\\n", "\n").replaceAll("\\n", "\n");
}

function mappedPreference(report, preference) {
  const selected = String(preference ?? "").replace(/^SCRIPT\s+/i, "").trim().toUpperCase();
  const candidate = String(report?.script_label_map?.candidate ?? "").replace(/^SCRIPT\s+/i, "").trim().toUpperCase();
  const reference = String(report?.script_label_map?.reference ?? "").replace(/^SCRIPT\s+/i, "").trim().toUpperCase();
  if (selected === candidate) return "candidate";
  if (selected === reference) return "reference";
  return "tie";
}

function compactViewerEvidence(reports) {
  const evidence = reports.map((report) => ({
    persona_id: report.persona_id,
    checkpoint_losses_or_ties: (report.checkpoint_preferences ?? [])
      .filter((row) => mappedPreference(report, row.preference) !== "candidate")
      .map((row) => ({
        checkpoint: row.checkpoint,
        result: mappedPreference(report, row.preference),
        candidate_anchor: String(report?.script_label_map?.candidate ?? "").endsWith("A") ? row.a_anchor : row.b_anchor,
        reference_anchor: String(report?.script_label_map?.reference ?? "").endsWith("A") ? row.a_anchor : row.b_anchor,
        viewing_effect: row.viewing_effect,
      })),
    overall_result: mappedPreference(report, report.overall_preference),
    apv_result: mappedPreference(report, report.apv_preference),
    candidate_estimated_apv: report?.estimated_percentage_viewed?.[
      String(report?.script_label_map?.candidate ?? "").replace(/^SCRIPT\s+/i, "").trim().toUpperCase()
    ],
    reference_estimated_apv: report?.estimated_percentage_viewed?.[
      String(report?.script_label_map?.reference ?? "").replace(/^SCRIPT\s+/i, "").trim().toUpperCase()
    ],
  }));
  return {
    panel_size: evidence.length,
    unanimous_candidate_overall: evidence.every((row) => row.overall_result === "candidate"),
    unanimous_candidate_apv: evidence.every((row) => row.apv_result === "candidate"),
    isolated_losses_or_ties: evidence.filter((row) => row.checkpoint_losses_or_ties.length),
  };
}

export function applyExactViewerPatches(script, patchDocument, options = {}) {
  if (patchDocument?.schema !== "goldflow_viewer_tournament_patch_v1") {
    throw new Error("Viewer repair response has the wrong schema.");
  }
  const patches = Array.isArray(patchDocument.patches) ? patchDocument.patches : [];
  if (patches.length < 1 || patches.length > 3) {
    throw new Error(`Viewer repair must contain one to three exact patches; found ${patches.length}.`);
  }

  const maxFindWords = Number(options.maxFindWords ?? 260);
  const maxReplacementWords = Number(options.maxReplacementWords ?? 320);
  const maxTotalReplacementWords = Number(options.maxTotalReplacementWords ?? 600);
  const maxTotalWordDelta = Number(options.maxTotalWordDelta ?? 240);
  let revised = script;
  let replacementWords = 0;
  const applied = [];
  for (const [index, patch] of patches.entries()) {
    const find = decodePlannerLineBreaks(patch?.find);
    const replace = decodePlannerLineBreaks(patch?.replace);
    if (!find.trim() || !replace.trim()) throw new Error(`Patch ${index + 1} has an empty find or replace value.`);
    const first = revised.indexOf(find);
    if (first < 0) throw new Error(`Patch ${index + 1} find text does not occur in the exact candidate.`);
    if (revised.indexOf(find, first + find.length) >= 0) throw new Error(`Patch ${index + 1} find text is not unique.`);
    const findWords = wordCount(find);
    const replaceWords = wordCount(replace);
    if (findWords < 8 || findWords > maxFindWords) throw new Error(`Patch ${index + 1} find span has ${findWords} words; expected 8-${maxFindWords}.`);
    if (replaceWords > maxReplacementWords) throw new Error(`Patch ${index + 1} replacement has ${replaceWords} words; maximum is ${maxReplacementWords}.`);
    replacementWords += replaceWords;
    revised = `${revised.slice(0, first)}${replace}${revised.slice(first + find.length)}`;
    applied.push({
      patch_index: index + 1,
      checkpoint: String(patch?.checkpoint ?? "").trim(),
      rationale: String(patch?.rationale ?? "").trim(),
      find_sha256: sha256(find),
      replacement_sha256: sha256(replace),
      find_word_count: findWords,
      replacement_word_count: replaceWords,
    });
  }
  if (replacementWords > maxTotalReplacementWords) throw new Error(`Viewer repair replaces ${replacementWords} words; maximum is ${maxTotalReplacementWords}.`);
  const delta = Math.abs(wordCount(revised) - wordCount(script));
  if (delta > maxTotalWordDelta) throw new Error(`Viewer repair changes total length by ${delta} words; maximum is ${maxTotalWordDelta}.`);
  return { revised, applied };
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  for (const required of ["candidate", "reference", "viewer-dir", "output"]) {
    if (!flags[required]) throw new Error(`Missing --${required}`);
  }
  const candidatePath = path.resolve(flags.candidate);
  const referencePath = path.resolve(flags.reference);
  const viewerDir = path.resolve(flags["viewer-dir"]);
  const outputPath = path.resolve(flags.output);
  const [candidate, reference, manifest] = await Promise.all([
    fs.readFile(candidatePath, "utf8"),
    fs.readFile(referencePath, "utf8"),
    fs.readFile(path.join(viewerDir, "manifest.json"), "utf8").then(JSON.parse),
  ]);
  const candidateHash = sha256(candidate);
  const referenceHash = sha256(reference);
  if (manifest.candidate_sha256 !== candidateHash || manifest.reference_sha256 !== referenceHash) {
    throw new Error("Viewer tournament manifest does not match the current candidate/reference hashes.");
  }
  const reportNames = (await fs.readdir(viewerDir))
    .filter((name) => name.endsWith(".json") && !["manifest.json", "aggregation.json"].includes(name))
    .sort();
  if (reportNames.length !== 10) throw new Error(`Expected ten viewer reports; found ${reportNames.length}.`);
  const reports = await Promise.all(reportNames.map(async (name) => {
    const raw = await fs.readFile(path.join(viewerDir, name), "utf8");
    return parseJsonObjectFromPlannerOutput(raw).value;
  }));
  const expectedPersonaIds = new Set(manifest.panel_profile_ids ?? []);
  const actualPersonaIds = reports.map((report) => String(report?.persona_id ?? "").trim());
  if (actualPersonaIds.some((id) => !id || !expectedPersonaIds.has(id)) || new Set(actualPersonaIds).size !== reports.length) {
    throw new Error("Viewer reports do not match the hash-bound tournament manifest panel.");
  }
  const viewerEvidence = compactViewerEvidence(reports);

  const prompt = `You are making the smallest possible surgical repair to an original manhwa-recap narration after a blinded ten-viewer comparison. Return JSON only.

Do not rewrite the complete script. Return one to three exact find-and-replace patches that address only checkpoints where the candidate lost or tied. Preserve every winning checkpoint, all established facts, chronology, names, system rules, causal setup/payoff, emotional consequences, and ending. A patch may intensify or reposition existing material, but must not invent a new subplot or copy the reference's characters, world, wording, or events.

For each patch, copy a unique contiguous span from the candidate into "find" and provide its polished replacement in "replace". Keep each patch local. Across all patches, replace at most 600 words and change total script length by at most 240 words. Aim to transfer the losing viewer appetite without surrendering the strengths preferred by the other viewers.

Schema:
{
  "schema": "goldflow_viewer_tournament_patch_v1",
  "diagnosis": "one concise paragraph",
  "patches": [
    {
      "checkpoint": "one checkpoint named by the reports",
      "rationale": "the precise viewing effect repaired",
      "find": "exact unique candidate prose",
      "replace": "replacement narration prose"
    }
  ]
}

CANDIDATE TITLE:
${String(flags["candidate-title"] ?? "Candidate")}

REFERENCE TITLE:
${String(flags["reference-title"] ?? "Measured outlier reference")}

BOUNDED TEN-VIEWER EVIDENCE:
The complete panel unanimously preferred the candidate overall and for APV. Repair only the isolated checkpoint losses or ties below. A missing persona means that viewer had no losing checkpoint.
${JSON.stringify(viewerEvidence, null, 2)}

EXACT CANDIDATE SCRIPT:
${candidate}`;
  const responsePath = `${outputPath}.patch-response.txt`;
  const existingResponse = await fs.readFile(responsePath, "utf8").catch(() => "");
  const result = existingResponse.trim()
    ? {
        provider: "chatgpt_web_reused_response",
        model: "gpt-5.6-sol",
        reasoning_effort: "max",
        bridge_receipt_path: null,
      }
    : await runChatGptWebPlanner({
        prompt,
        outputPath: responsePath,
        workId: `source_viewer_patch_${candidateHash.slice(0, 12)}`,
        effort: "max",
        timeoutMs: 3_600_000,
        rateClass: "source_revision",
      });
  const patchDocument = parseJsonObjectFromPlannerOutput(await fs.readFile(responsePath, "utf8")).value;
  const { revised, applied } = applyExactViewerPatches(candidate, patchDocument);
  await fs.writeFile(outputPath, revised, "utf8");
  const report = {
    schema: "goldflow_viewer_tournament_patch_report_v1",
    source_candidate_path: candidatePath,
    source_candidate_sha256: candidateHash,
    reference_path: referencePath,
    reference_sha256: referenceHash,
    viewer_manifest_path: path.join(viewerDir, "manifest.json"),
    output_path: outputPath,
    output_sha256: sha256(revised),
    source_word_count: wordCount(candidate),
    output_word_count: wordCount(revised),
    diagnosis: String(patchDocument.diagnosis ?? "").trim(),
    patches: applied,
    provider: result.provider,
    model: result.model,
    reasoning_effort: result.reasoning_effort,
    receipt_path: result.bridge_receipt_path,
    completed_at: new Date().toISOString(),
  };
  await fs.writeFile(`${outputPath}.report.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
