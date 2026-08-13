#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runCodexCli } from "./lib/codex-cli-runner.mjs";
import { parseJsonObjectFromPlannerOutput } from "./lib/json-output-repair.mjs";
import {
  REFERENCE_DENSITY_DIMENSION_IDS,
  REFERENCE_DENSITY_NORMALIZATION_POLICY,
  bindReferenceDensityAnchors,
  bindReferenceMeritFrontierAnchors,
  validateReferenceDensityDominance,
  validateReferenceMeritFrontier,
} from "./lib/winner-source-room-v2-contract.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function flagsFrom(parts) {
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

async function promptTemplate(fileName) {
  const markdown = await fs.readFile(path.join(repoRoot, "docs", "prompts", fileName), "utf8");
  const match = markdown.match(/```text\s*\n([\s\S]*?)\n```/i);
  if (!match) throw new Error(`Prompt template ${fileName} has no text fence.`);
  return match[1].trim();
}

function embedded(label, value) {
  return `\n\n===== ${label} =====\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`;
}

function compactFrontierForJudgment(frontier) {
  return {
    schema: frontier.schema,
    package_sha256: frontier.package_sha256,
    reference_sha256: frontier.reference_sha256,
    normalization_policy: frontier.normalization_policy,
    dimensions: frontier.dimensions.map((row) => ({
      id: row.id,
      viewer_appetite: row.viewer_appetite,
      reference_anchor: row.reference_anchor,
      reference_strength: row.reference_strength,
      reference_weakness: row.reference_weakness,
      candidate_dominance_obligation: row.candidate_dominance_obligation,
    })),
    material_reference_edges: frontier.material_reference_edges.map((row) => ({
      edge_id: row.edge_id,
      dimension_id: row.dimension_id,
      viewer_appetite: row.viewer_appetite,
      reference_anchor: row.reference_anchor,
      reference_advantage: row.reference_advantage,
      candidate_dominance_obligation: row.candidate_dominance_obligation,
    })),
  };
}

async function writeValidatedJson(outputPath, rawPath, validator, validatorOptions, normalizeDocument = null) {
  const content = await fs.readFile(rawPath, "utf8");
  const parsedDocument = parseJsonObjectFromPlannerOutput(content).value;
  const document = normalizeDocument ? normalizeDocument(parsedDocument) : parsedDocument;
  const validation = validator(document, validatorOptions);
  if (!validation.done) throw new Error(`${path.basename(outputPath)} is blocked: ${validation.blockers.join(", ")}`);
  await fs.writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx" });
  return { document, validation, sha256: sha256(await fs.readFile(outputPath)) };
}

async function existingValidated(outputPath, validator, options) {
  try {
    const document = JSON.parse(await fs.readFile(outputPath, "utf8"));
    const validation = validator(document, options);
    if (!validation.done) throw new Error(`${path.basename(outputPath)} is blocked: ${validation.blockers.join(", ")}`);
    return { document, validation, sha256: sha256(await fs.readFile(outputPath)), resumed: true };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

const flags = flagsFrom(process.argv.slice(2));
const candidatePath = path.resolve(required(flags.candidate, "--candidate <path>"));
const referencePath = path.resolve(required(flags.reference, "--reference <path>"));
const outputDir = path.resolve(required(flags["output-dir"], "--output-dir <path>"));
const candidateTitle = required(flags["candidate-title"], "--candidate-title <title>");
const referenceTitle = required(flags["reference-title"], "--reference-title <title>");
const sourceOutlierId = String(flags["reference-entry-id"] ?? path.basename(referencePath, path.extname(referencePath))).trim();
const frontierProvider = String(flags["frontier-provider"] ?? "gemini_web").trim();
const diagnosticProvider = String(flags["diagnostic-provider"] ?? "chatgpt_web").trim();
const allowedProviders = new Set(["chatgpt_web", "gemini_web"]);
if (!allowedProviders.has(frontierProvider)) throw new Error("--frontier-provider must be chatgpt_web or gemini_web.");
if (!allowedProviders.has(diagnosticProvider)) throw new Error("--diagnostic-provider must be chatgpt_web or gemini_web.");
const [candidateText, referenceText] = await Promise.all([
  fs.readFile(candidatePath, "utf8"),
  fs.readFile(referencePath, "utf8"),
]);
const candidateSha256 = sha256(candidateText);
const referenceSha256 = sha256(referenceText);
const packageSha256 = sha256(JSON.stringify({ candidate_title: candidateTitle, reference_title: referenceTitle }));
await fs.mkdir(outputDir, { recursive: true });

const frontierPath = path.join(outputDir, "reference_merit_frontier.json");
const frontierOptions = {
  packageSha256,
  referenceText,
  referenceSha256,
  referencePath,
  referenceTitle,
  requireMaterialEdges: true,
};
let frontier = await existingValidated(frontierPath, validateReferenceMeritFrontier, frontierOptions);
if (!frontier) {
  const template = await promptTemplate("manhwa_recap_reference_merit_frontier_v1.md");
  const prompt = template
    + embedded("LOCKED PACKAGE JSON", { title: candidateTitle })
    + embedded("EXACT MEASURED OUTLIER TRANSCRIPT", referenceText)
    + `\n\nUse package_sha256 ${packageSha256}, reference_sha256 ${referenceSha256}, reference_path ${referencePath}, source_outlier_id ${sourceOutlierId}, reference_title ${JSON.stringify(referenceTitle)}, reference_word_count ${wordCount(referenceText)}, and normalization_policy ${REFERENCE_DENSITY_NORMALIZATION_POLICY}. Include exactly these dimension IDs: ${REFERENCE_DENSITY_DIMENSION_IDS.join(", ")}.`;
  const rawPath = path.join(outputDir, "reference_merit_frontier.raw.txt");
  await runCodexCli({
    prompt,
    stageName: "winner_source_reference_merit_frontier_audit",
    repoRoot,
    outputPath: rawPath,
    provider: frontierProvider,
    model: frontierProvider === "gemini_web" ? "gemini-3.6-flash-web" : "gpt-5.6-sol",
    reasoningEffort: frontierProvider === "gemini_web" ? "high" : "max",
    timeoutMs: Number(flags["timeout-ms"] ?? 3_600_000),
  });
  frontier = await writeValidatedJson(
    frontierPath,
    rawPath,
    validateReferenceMeritFrontier,
    frontierOptions,
    (document) => bindReferenceMeritFrontierAnchors(document, { referenceText }),
  );
}

const diagnosticPath = path.join(outputDir, "reference_density_dominance_diagnostic.json");
const diagnosticOptions = {
  scriptText: candidateText,
  scriptSha256: candidateSha256,
  referenceText,
  referenceSha256,
  frontierSha256: frontier.sha256,
  referenceMeritFrontier: frontier.document,
};
let diagnostic = await existingValidated(diagnosticPath, validateReferenceDensityDominance, diagnosticOptions);
if (!diagnostic) {
  const template = await promptTemplate("manhwa_recap_reference_density_diagnostic_v1.md");
  const prompt = template
    + embedded("BINDING REFERENCE MERIT FRONTIER JUDGMENT PROJECTION", compactFrontierForJudgment(frontier.document))
    + embedded("EXACT CANDIDATE SCRIPT", candidateText)
    + `\n\nThe bound frontier is the exhaustive downstream representation of the measured reference. Reuse its exact reference anchors; do not invent reference evidence outside it.\nBINDING SCRIPT SHA256: ${candidateSha256}\nBINDING REFERENCE SHA256: ${referenceSha256}\nBINDING FRONTIER SHA256: ${frontier.sha256}\nNORMALIZATION POLICY: ${REFERENCE_DENSITY_NORMALIZATION_POLICY}\nREQUIRED DIMENSIONS: ${REFERENCE_DENSITY_DIMENSION_IDS.join(", ")}`;
  const suppliedResponsePath = String(flags["diagnostic-response-path"] ?? "").trim();
  const rawPath = suppliedResponsePath
    ? path.resolve(suppliedResponsePath)
    : path.join(outputDir, "reference_density_dominance_diagnostic.raw.txt");
  if (!suppliedResponsePath) {
    await runCodexCli({
      prompt,
      stageName: "winner_source_reference_density_dominance_diagnostic_v2",
      repoRoot,
      outputPath: rawPath,
      provider: diagnosticProvider,
      model: diagnosticProvider === "gemini_web" ? "gemini-3.6-flash-web" : "gpt-5.6-sol",
      reasoningEffort: diagnosticProvider === "gemini_web" ? "high" : "max",
      timeoutMs: Number(flags["timeout-ms"] ?? 3_600_000),
    });
  }
  diagnostic = await writeValidatedJson(
    diagnosticPath,
    rawPath,
    validateReferenceDensityDominance,
    diagnosticOptions,
    (document) => bindReferenceDensityAnchors(document, { scriptText: candidateText, referenceText }),
  );
}

const report = {
  schema: "goldflow_reference_density_audit_proof_v1",
  status: diagnostic.document.status,
  candidate_path: candidatePath,
  candidate_sha256: candidateSha256,
  candidate_word_count: wordCount(candidateText),
  reference_path: referencePath,
  reference_sha256: referenceSha256,
  reference_word_count: wordCount(referenceText),
  frontier_path: frontierPath,
  frontier_sha256: frontier.sha256,
  diagnostic_path: diagnosticPath,
  diagnostic_sha256: diagnostic.sha256,
  dimension_decisions: Object.fromEntries(diagnostic.document.dimensions.map((row) => [row.id, row.decision])),
  finding_ids: diagnostic.validation.accepted_findings.map((finding) => finding.id),
  provider_contract: {
    frontier_provider: frontierProvider,
    diagnostic_provider: diagnosticProvider,
    independent_provider_judgment: frontierProvider !== diagnosticProvider,
  },
};
await fs.writeFile(path.join(outputDir, "audit_proof_report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
