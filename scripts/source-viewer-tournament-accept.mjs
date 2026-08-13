#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  evaluateViewerTournament,
  mapViewerPreference,
  validateViewerTournamentAcceptance,
} from "./lib/source-viewer-tournament-contract.mjs";
import { parseJsonObjectFromPlannerOutput } from "./lib/json-output-repair.mjs";

export { evaluateViewerTournament, mapViewerPreference } from "./lib/source-viewer-tournament-contract.mjs";

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

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  for (const required of ["candidate", "reference", "viewer-dir", "output"]) {
    if (!flags[required]) throw new Error(`Missing --${required}`);
  }
  const candidatePath = path.resolve(flags.candidate);
  const referencePath = path.resolve(flags.reference);
  const viewerDir = path.resolve(flags["viewer-dir"]);
  const outputPath = path.resolve(flags.output);
  const manifestPath = path.join(viewerDir, "manifest.json");
  const [candidate, reference, manifestBytes] = await Promise.all([
    fs.readFile(candidatePath, "utf8"),
    fs.readFile(referencePath, "utf8"),
    fs.readFile(manifestPath),
  ]);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const candidateSha256 = sha256(candidate);
  const referenceSha256 = sha256(reference);
  if (manifest.schema !== "goldflow_simulated_manhwa_viewer_tournament_v2") throw new Error("Tournament manifest schema is not APV v2.");
  if (!String(manifest.panel_seed ?? "").trim()) throw new Error("Tournament manifest is missing its fixed panel seed.");
  if (manifest.viewer_count !== 10 || manifest.control_viewer_count !== 5 || manifest.rotating_viewer_count !== 5) {
    throw new Error("Tournament manifest does not contain five controls plus five rotating challengers.");
  }
  if (manifest.candidate_sha256 !== candidateSha256) throw new Error("Tournament candidate hash does not match the current candidate.");
  if (manifest.reference_sha256 !== referenceSha256) throw new Error("Tournament reference hash does not match the current reference.");
  const reportNames = (await fs.readdir(viewerDir))
    .filter((name) => name.endsWith(".json") && !["manifest.json", "aggregation.json"].includes(name))
    .sort();
  const reportRecords = await Promise.all(reportNames.map(async (name) => {
    const bytes = await fs.readFile(path.join(viewerDir, name));
    const parsed = parseJsonObjectFromPlannerOutput(bytes.toString("utf8"));
    return { name, bytes, document: parsed.value, syntax_repair: parsed.syntax_repair };
  }));
  const reports = reportRecords.map((record) => record.document);
  const viewerReportSha256s = Object.fromEntries(reportRecords.map((record) => [record.document.persona_id, sha256(record.bytes)]));
  const evaluation = evaluateViewerTournament(reports, {
    candidateText: candidate,
    referenceText: reference,
    requireExactAnchors: true,
  });
  const artifact = {
    schema: "goldflow_simulated_manhwa_viewer_acceptance_v2",
    ...evaluation,
    candidate_path: candidatePath,
    candidate_sha256: candidateSha256,
    candidate_word_count: candidate.trim().split(/\s+/).filter(Boolean).length,
    reference_path: referencePath,
    reference_sha256: referenceSha256,
    viewer_manifest_path: manifestPath,
    viewer_manifest_sha256: sha256(JSON.stringify(manifest)),
    viewer_manifest_file_sha256: sha256(manifestBytes),
    viewer_report_sha256s: viewerReportSha256s,
    viewer_report_syntax_repairs: Object.fromEntries(reportRecords
      .filter((record) => record.syntax_repair)
      .map((record) => [record.document.persona_id, record.syntax_repair])),
    evaluated_at: new Date().toISOString(),
    interpretation: "Strict challenger acceptance requires unanimous simulated dominance at every checkpoint and major story dimension. It is not a guarantee of real APV, CTR, or views.",
  };
  const validation = validateViewerTournamentAcceptance(artifact, {
    candidateSha256,
    referenceSha256,
    candidateText: candidate,
    referenceText: reference,
    manifest,
    manifestFileSha256: sha256(manifestBytes),
    reports,
    reportSha256s: viewerReportSha256s,
  });
  if (!validation.done) throw new Error(`Viewer acceptance is structurally blocked: ${validation.blockers.join(", ")}`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(artifact, null, 2));
  if (artifact.status !== "accepted") process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  await main();
}
