#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runCodexCli } from "./lib/codex-cli-runner.mjs";
import { parseJsonObjectFromPlannerOutput } from "./lib/json-output-repair.mjs";
import {
  validateReferenceDensityDominance,
  validateReferenceMeritFrontier,
  validateSourceRevisionLedger,
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

function isTrue(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function embedded(label, value) {
  return `\n\n===== ${label} =====\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`;
}

function parseRevisionResponse(content) {
  const marker = "===REVISION_LEDGER===";
  const index = String(content).indexOf(marker);
  if (index < 0) throw new Error(`Revision response is missing ${marker}.`);
  const beforeMarker = String(content).slice(0, index);
  const script = beforeMarker.endsWith("\\") ? beforeMarker.slice(0, -1).trim() : beforeMarker.trim();
  if (!script) throw new Error("Revision response has no revised narration before the ledger marker.");
  const ledger = parseJsonObjectFromPlannerOutput(String(content).slice(index + marker.length)).value;
  return { script, ledger };
}

function normalizeExactText(value) {
  return String(value ?? "").replace(/\\n/g, "\n").trim();
}

function applyExactDensityTrim(script, trimDocument, protectedAnchors) {
  if (trimDocument?.schema !== "goldflow_source_density_trim_v1") {
    throw new Error("Density trim response has the wrong schema.");
  }
  const deletions = Array.isArray(trimDocument.deletions) ? trimDocument.deletions : [];
  if (deletions.length < 1 || deletions.length > 12) {
    throw new Error("Density trim must contain 1-12 exact deletions.");
  }
  const ranges = deletions.map((row, index) => {
    const exactText = normalizeExactText(row?.exact_text);
    if (!exactText) throw new Error(`Density trim deletion ${index + 1} has no exact_text.`);
    const start = script.indexOf(exactText);
    if (start < 0 || script.indexOf(exactText, start + 1) >= 0) {
      throw new Error(`Density trim deletion ${index + 1} is not a unique exact script excerpt.`);
    }
    const end = start + exactText.length;
    for (const protectedAnchor of protectedAnchors) {
      const protectedStart = script.indexOf(protectedAnchor);
      if (protectedStart < 0) continue;
      const protectedEnd = protectedStart + protectedAnchor.length;
      if (start < protectedEnd && end > protectedStart) {
        throw new Error(`Density trim deletion ${index + 1} overlaps a protected repair/opening/ending anchor.`);
      }
    }
    return { start, end, exactText };
  }).sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].start < ranges[index - 1].end) throw new Error("Density trim deletions overlap.");
  }
  let revised = script;
  for (const range of [...ranges].reverse()) {
    revised = `${revised.slice(0, range.start)}${revised.slice(range.end)}`;
  }
  revised = revised.replace(/\n{3,}/g, "\n\n").trim();
  return { script: revised, deleted_word_count: wordCount(script) - wordCount(revised), deletion_count: ranges.length };
}

function protectedWinRows(diagnostic) {
  return {
    dimensions: diagnostic.dimensions
      .filter((row) => row.decision === "candidate_win")
      .map((row) => ({
        id: row.id,
        protected_advantage: row.candidate_advantage_or_gap,
      })),
    material_edges: diagnostic.edge_verdicts
      .filter((row) => row.decision === "candidate_win")
      .map((row) => ({
        edge_id: row.edge_id,
        protected_advantage: row.candidate_advantage_or_gap,
      })),
  };
}

function compactDimensionRows(rows) {
  return rows.map((row) => ({
    id: row.id,
    decision: row.decision,
    candidate_advantage_or_gap: row.candidate_advantage_or_gap,
  }));
}

function compactEdgeRows(rows) {
  return rows.map((row) => ({
    edge_id: row.edge_id,
    decision: row.decision,
    candidate_advantage_or_gap: row.candidate_advantage_or_gap,
  }));
}

const flags = flagsFrom(process.argv.slice(2));
const candidatePath = path.resolve(required(flags.candidate, "--candidate <path>"));
const referencePath = path.resolve(required(flags.reference, "--reference <path>"));
const frontierPath = path.resolve(required(flags.frontier, "--frontier <path>"));
const diagnosticPath = path.resolve(required(flags.diagnostic, "--diagnostic <path>"));
const outputPath = path.resolve(required(flags.output, "--output <path>"));
const ledgerPath = path.resolve(required(flags["ledger-output"], "--ledger-output <path>"));
const rawPath = path.resolve(flags["raw-output"] ?? `${outputPath}.raw.txt`);
const provider = String(flags.provider ?? "chatgpt_web").trim();
const productionShapeRevision = isTrue(flags["production-shape-revision"]);
const productionShapeAnchor = productionShapeRevision
  ? required(flags["production-shape-anchor"], "--production-shape-anchor <exact text>")
  : null;
const productionShapeMaxPayoffPercent = Number(flags["production-shape-max-payoff-percent"] ?? 35);
const productionShapeRepairIntent = productionShapeRevision
  ? required(flags["production-shape-repair-intent"], "--production-shape-repair-intent <text>")
  : null;
if (provider !== "chatgpt_web") throw new Error("Reference-density revision is locked to chatgpt_web.");
if (productionShapeRevision && (!Number.isFinite(productionShapeMaxPayoffPercent) || productionShapeMaxPayoffPercent <= 0 || productionShapeMaxPayoffPercent >= 100)) {
  throw new Error("--production-shape-max-payoff-percent must be between 0 and 100.");
}

const [candidateText, referenceText, frontierBytes, diagnosticBytes] = await Promise.all([
  fs.readFile(candidatePath, "utf8"),
  fs.readFile(referencePath, "utf8"),
  fs.readFile(frontierPath),
  fs.readFile(diagnosticPath),
]);
const candidateSha256 = sha256(candidateText);
const referenceSha256 = sha256(referenceText);
const frontierSha256 = sha256(frontierBytes);
const diagnosticSha256 = sha256(diagnosticBytes);
const frontier = JSON.parse(frontierBytes.toString("utf8"));
const diagnostic = JSON.parse(diagnosticBytes.toString("utf8"));

const frontierValidation = validateReferenceMeritFrontier(frontier, {
  packageSha256: frontier.package_sha256,
  referenceText,
  referenceSha256,
  referencePath,
  referenceTitle: frontier.reference_title,
  requireMaterialEdges: true,
});
if (!frontierValidation.done) throw new Error(`Frontier is blocked: ${frontierValidation.blockers.join(", ")}`);
const diagnosticValidation = validateReferenceDensityDominance(diagnostic, {
  scriptText: candidateText,
  scriptSha256: candidateSha256,
  referenceText,
  referenceSha256,
  frontierSha256,
  referenceMeritFrontier: frontier,
});
if (!diagnosticValidation.done) throw new Error(`Diagnostic is blocked: ${diagnosticValidation.blockers.join(", ")}`);
if (!productionShapeRevision && (diagnostic.status !== "findings" || diagnosticValidation.accepted_findings.length < 1)) {
  throw new Error("Reference-density revision requires a validated diagnostic with material findings.");
}

const productionShapeOffset = productionShapeRevision ? candidateText.indexOf(productionShapeAnchor) : -1;
const revisionFindings = productionShapeRevision
  ? [{
    id: "production_shape_runtime_and_late_title_payoff",
    dimension_id: "title_fantasy_delivery",
    severity: "material",
    start_offset: productionShapeOffset,
    end_offset: productionShapeOffset + productionShapeAnchor.length,
    exact_text: productionShapeAnchor,
    defect: `The ${wordCount(candidateText)}-word candidate delays its explicit title-fantasy decision until approximately ${Math.round((wordCount(candidateText.slice(0, productionShapeOffset)) / wordCount(candidateText)) * 100)} percent, beyond the binding first-${productionShapeMaxPayoffPercent}-percent payoff obligation and the 9,500-10,500-word production target.`,
    audience_effect: "The title fantasy arrives after too many structurally similar intermediate loops, reducing urgency despite strong individual scenes.",
    smallest_repair_intent: productionShapeRepairIntent,
  }]
  : diagnosticValidation.accepted_findings;
if (productionShapeRevision && productionShapeOffset < 0) throw new Error("Production-shape revision could not bind its exact acquisition anchor.");

try {
  const [existingScript, existingLedger] = await Promise.all([
    fs.readFile(outputPath, "utf8"),
    fs.readFile(ledgerPath, "utf8").then(JSON.parse),
  ]);
  const existingSha256 = sha256(existingScript);
  const validation = validateSourceRevisionLedger(existingLedger, {
    sourceScriptSha256: candidateSha256,
    revisedScriptSha256: existingSha256,
    acceptedFindingIds: revisionFindings.map((finding) => finding.id),
  });
  if (!validation.done) throw new Error(`Existing revision is blocked: ${validation.blockers.join(", ")}`);
  console.log(JSON.stringify({ status: "passed", resumed: true, output_path: outputPath, revised_script_sha256: existingSha256, ledger_path: ledgerPath }, null, 2));
  process.exit(0);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const tiedDimensions = diagnostic.dimensions.filter((row) => row.decision !== "candidate_win");
const nonWinningEdges = diagnostic.edge_verdicts.filter((row) => row.decision !== "candidate_win");
const prompt = `Revise one exact manhwa-recap narration script so it decisively beats its measured reference by viewer-payoff density, while remaining a coherent human story.

This is one integrated repair, not a new draft. Preserve chronology, identities, relationships, central mechanic architecture, ending, title truth, and every protected win. Make the smallest causally complete changes that resolve every validated finding. Several findings may share one elegant repair. Do not create one scene per finding.

Repair the viewer appetite behind each reference edge; do not copy reference plot facts. A reference edge such as a secondary relationship payoff may be beaten by an equally strong existing-character payoff if that produces the same or better attachment per minute. Do not add checklist-shaped subplots, procedural explanation, legal or ledger narration, lore tax, stat dumps, disposable characters, or a second power system.

Derive every repair strictly from the current validated findings and nonwinning edges below. Do not carry episode-specific instructions forward from an earlier candidate or diagnostic. When a finding concerns a rule, relationship, name collision, tracked limit, environmental tactic, or custody/payoff question, repair that exact causal thread in the fewest existing scenes that can set it up and pay it off. Preserve Joey Manhwa's name.

Strengthen the story through drama and action: hard deadlines should create choices, mechanical limits should create anticipation, relationship repairs should alter behavior, and environmental additions should do more than decorate. Keep the narration natural, imageable, and easy to follow after one listen.

Target 9,500-10,500 spoken words. Do not pad to reach the range. Return the complete revised narration prose only, followed by the exact marker ===REVISION_LEDGER=== and JSON matching the supplied ledger contract. Include one ledger entry for every finding ID, even when several share the same integrated repair. revised_script_sha256 may be PENDING_DETERMINISTIC_BIND; Goldflow binds it after parsing.`
  + embedded("BINDING HASHES", { candidate_sha256: candidateSha256, reference_sha256: referenceSha256, frontier_sha256: frontierSha256, diagnostic_sha256: diagnosticSha256 })
  + embedded("TIED DIMENSION JUDGMENTS", compactDimensionRows(tiedDimensions))
  + embedded("NONWINNING MATERIAL REFERENCE EDGES", compactEdgeRows(nonWinningEdges))
  + embedded("VALIDATED FINDINGS", revisionFindings)
  + embedded("PROTECTED CANDIDATE WINS", protectedWinRows(diagnostic))
  + embedded("REVISION LEDGER CONTRACT", {
    schema: "goldflow_source_revision_ledger_v1",
    status: "revised",
    source_script_sha256: candidateSha256,
    revised_script_sha256: "PENDING_DETERMINISTIC_BIND",
    entries: [{ finding_id: "every validated finding ID exactly once", repair_intent: "...", source_anchor: "...", revised_anchor: "...", dependent_spans_changed: ["..."] }],
  })
  + embedded("EXACT CURRENT SCRIPT", candidateText);

await fs.mkdir(path.dirname(outputPath), { recursive: true });
const suppliedRevisionResponsePath = String(flags["revision-response-path"] ?? "").trim();
const revisionResponsePath = suppliedRevisionResponsePath ? path.resolve(suppliedRevisionResponsePath) : rawPath;
if (!suppliedRevisionResponsePath) {
  await runCodexCli({
    prompt,
    stageName: "winner_source_reference_density_integrated_revision_v1",
    repoRoot,
    outputPath: revisionResponsePath,
    provider,
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
    timeoutMs: Number(flags["timeout-ms"] ?? 3_600_000),
  });
}
const parsed = parseRevisionResponse(await fs.readFile(revisionResponsePath, "utf8"));
let words = wordCount(parsed.script);
let densityTrim = null;
if (words > 10_500 && words <= 11_000) {
  const trimRawPath = path.resolve(flags["trim-raw-output"] ?? `${outputPath}.density-trim.raw.txt`);
  const suppliedTrimResponsePath = String(flags["trim-response-path"] ?? "").trim();
  const trimResponsePath = suppliedTrimResponsePath ? path.resolve(suppliedTrimResponsePath) : trimRawPath;
  const protectedAnchors = [
    parsed.script.slice(0, 2_000),
    parsed.script.slice(-2_800),
    ...(Array.isArray(parsed.ledger?.entries) ? parsed.ledger.entries.map((row) => normalizeExactText(row?.revised_anchor)).filter(Boolean) : []),
  ];
  if (!suppliedTrimResponsePath) {
    const excess = words - 10_480;
    const trimPrompt = `You are performing a surgical density trim on a completed manhwa-recap narration. Return JSON only. Do not rewrite, paraphrase, reorder, or add prose. Select 1-12 unique, exact, contiguous excerpts that can be deleted with no continuity damage. Remove ${excess}-${Math.min(excess + 120, 360)} spoken words total so the final script lands at or below 10,480 words. Prefer redundant explanation, repeated reaction, and second-pass description. Preserve the first 220 words, final 350 words, every protected repair anchor, chronology, causal logic, emotional payoff, and all named rule receipts. Every exact_text must be copied byte-for-byte from the supplied script. Schema: {"schema":"goldflow_source_density_trim_v1","deletions":[{"exact_text":"unique exact excerpt","reason":"why its removal preserves meaning"}]}.`
      + embedded("PROTECTED REPAIR ANCHORS", protectedAnchors.slice(2))
      + embedded("COMPLETE REVISED SCRIPT", parsed.script);
    await runCodexCli({
      prompt: trimPrompt,
      stageName: "winner_source_reference_density_surgical_trim_v1",
      repoRoot,
      outputPath: trimResponsePath,
      provider,
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
      timeoutMs: Number(flags["timeout-ms"] ?? 3_600_000),
    });
  }
  const trimDocument = parseJsonObjectFromPlannerOutput(await fs.readFile(trimResponsePath, "utf8")).value;
  densityTrim = applyExactDensityTrim(parsed.script, trimDocument, protectedAnchors);
  parsed.script = densityTrim.script;
  words = wordCount(parsed.script);
}
if (words < 9_500 || words > 10_500) throw new Error(`Revised script has ${words} words; expected 9500-10500.`);
const scriptBytes = Buffer.from(`${parsed.script}\n`, "utf8");
const revisedSha256 = sha256(scriptBytes);
parsed.ledger.source_script_sha256 = candidateSha256;
parsed.ledger.revised_script_sha256 = revisedSha256;
const ledgerValidation = validateSourceRevisionLedger(parsed.ledger, {
  sourceScriptSha256: candidateSha256,
  revisedScriptSha256: revisedSha256,
  acceptedFindingIds: revisionFindings.map((finding) => finding.id),
});
if (!ledgerValidation.done) throw new Error(`Revision ledger is blocked: ${ledgerValidation.blockers.join(", ")}`);
await fs.writeFile(outputPath, scriptBytes, { flag: "wx" });
await fs.writeFile(ledgerPath, `${JSON.stringify(parsed.ledger, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({
  status: "passed",
  output_path: outputPath,
  revised_script_sha256: revisedSha256,
  revised_word_count: words,
  ledger_path: ledgerPath,
  repaired_finding_count: revisionFindings.length,
  revision_mode: productionShapeRevision ? "production_shape" : "density_findings",
  protected_dimension_wins: diagnostic.dimensions.filter((row) => row.decision === "candidate_win").length,
  protected_edge_wins: diagnostic.edge_verdicts.filter((row) => row.decision === "candidate_win").length,
  ...(densityTrim ? {
    density_trim: {
      deleted_word_count: densityTrim.deleted_word_count,
      deletion_count: densityTrim.deletion_count,
    },
  } : {}),
}, null, 2));
