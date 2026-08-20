#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  NARRATION_SUBJECTIVE_REVIEW_ATTESTATION,
  buildNarrationSubjectiveReviewDecision,
  narrationSubjectiveReviewManifestSha256,
  validateNarrationSubjectiveReviewDecision,
} from "./lib/narration-subjective-review.mjs";

function flagsFrom(parts) {
  const flags = {};
  for (let index = 0; index < parts.length; index += 1) {
    if (!parts[index].startsWith("--")) continue;
    const key = parts[index].slice(2);
    const next = parts[index + 1];
    flags[key] = next && !next.startsWith("--") ? next : "true";
    if (flags[key] !== "true") index += 1;
  }
  return flags;
}

function csv(value) {
  return [...new Set(String(value ?? "").split(",").map((row) => row.trim()).filter(Boolean))];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function main() {
  const flags = flagsFrom(process.argv.slice(2));
  const episodeDir = path.resolve(flags["episode-dir"] ?? "");
  if (!flags["episode-dir"]) throw new Error("--episode-dir is required.");
  const identity = JSON.parse(await fs.readFile(path.join(episodeDir, "run_identity.json"), "utf8"));
  const episode = String(identity.episode ?? "ep_01");
  const manifestPath = path.resolve(flags.manifest ?? path.join(
    episodeDir,
    `narration_subjective_review_manifest_${episode}.json`,
  ));
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest.manifest_sha256 !== narrationSubjectiveReviewManifestSha256(manifest)) throw new Error("Subjective narration manifest is stale or hash-invalid.");
  const audioBytes = await fs.readFile(manifest.audio_path);
  if (sha256(audioBytes) !== manifest.audio_sha256) throw new Error("Canonical narration audio is missing or hash-stale.");
  const reviewer = String(flags.reviewer ?? "").trim();
  if (!reviewer) throw new Error("--reviewer <name> is required.");
  const attestation = String(flags.attestation ?? "").trim();
  if (attestation !== NARRATION_SUBJECTIVE_REVIEW_ATTESTATION) {
    throw new Error(`--attestation must be exactly ${NARRATION_SUBJECTIVE_REVIEW_ATTESTATION}.`);
  }
  const repairSampleIds = new Set(csv(flags["repair-sample-ids"]));
  const repairUnitIds = csv(flags["repair-unit-ids"]);
  const repairUnitSet = new Set(repairUnitIds);
  const defectType = String(flags["defect-type"] ?? "").trim();
  const sampleIds = manifest.samples.map((row) => String(row.sample_id));
  for (const sampleId of repairSampleIds) {
    if (!sampleIds.includes(sampleId)) throw new Error(`Unknown repair sample ${sampleId}.`);
  }
  if (repairSampleIds.size && (!repairUnitIds.length || !defectType)) throw new Error("Repairs require --repair-unit-ids and --defect-type.");
  if (!repairSampleIds.size && flags["accept-all"] !== "true") throw new Error("Use --accept-all true after listening to every sample, or name exact repair samples and units.");
  const decisions = manifest.samples.map((sample) => {
    const repair = repairSampleIds.has(String(sample.sample_id));
    const scopedUnits = repair
      ? sample.unit_ids.filter((unitId) => repairUnitSet.has(String(unitId)))
      : [];
    if (repair && !scopedUnits.length) throw new Error(`Repair sample ${sample.sample_id} does not contain any named repair unit.`);
    return {
      sample_id: sample.sample_id,
      decision: repair ? "repair_required" : "accept",
      repair_unit_ids: scopedUnits,
      defect_type: repair ? defectType : null,
      note: String(flags.note ?? "").trim() || null,
    };
  });
  const artifact = buildNarrationSubjectiveReviewDecision({
    manifest,
    reviewer,
    decisions,
    attestation,
  });
  const validation = validateNarrationSubjectiveReviewDecision(manifest, artifact);
  if (validation.status === "blocked") throw new Error(`Subjective narration review blocked: ${validation.findings.map((row) => row.code).join(", ")}`);
  artifact.validation = validation;
  const outputPath = path.join(episodeDir, `narration_subjective_review_decision_${episode}.json`);
  await atomicWriteJson(outputPath, artifact);
  console.log(JSON.stringify({
    status: validation.status,
    decision_path: outputPath,
    decision_sha256: artifact.decision_sha256,
    repair_unit_ids: validation.repair_unit_ids,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
