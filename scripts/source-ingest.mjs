#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  normalizeWinnerNarration,
  sha256Text,
  validateWinnerPackageContract,
  validateWinnerSourceRelease,
} from "./lib/winner-source-contract.mjs";
import {
  contentProfileForIdentity,
  contentProfileRequiresEvidenceLedger,
} from "./lib/content-profiles.mjs";
import {
  factualEvidenceBinding,
} from "./lib/factual-evidence-contract.mjs";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const weekDir = path.join(dataRoot, "channels", channel, "weekly_runs", week);
const episodeDir = path.join(weekDir, "episodes", episode);
const sourcePath = flags.source ? path.resolve(flags.source) : null;
const storyText = flags.story ?? null;
const explicitWinnerReleasePath = flags["winner-release"] ? path.resolve(flags["winner-release"]) : null;
const stripAnnotations = flags["strip-annotations"] === "true";
const allowMissingRunIdentity = flags["allow-missing-run-identity"] === "true";
const runIdentityPath = path.join(episodeDir, "run_identity.json");

function parseFlags(parts) {
  const parsed = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--") ? parts[index + 1] : "true";
    parsed[key] = value;
    if (value !== "true") index += 1;
  }
  return parsed;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readJsonWithBytes(filePath, label) {
  const bytes = await fs.readFile(filePath).catch(() => null);
  if (!bytes) throw new Error(`Missing ${label}: ${filePath}`);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid ${label} JSON at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { bytes, value };
}

function resolveReleaseArtifactPath(releaseFilePath, value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`Winner source release is missing ${label}.`);
  return path.isAbsolute(text) ? path.normalize(text) : path.resolve(path.dirname(releaseFilePath), text);
}

async function loadWinnerSourceReleaseContext(releaseFilePath, {
  sourceText,
  expectedChannel,
  expectedTitle,
  identityBinding,
  expectedRawSourceSha256,
}) {
  const resolvedReleasePath = path.resolve(releaseFilePath);
  const { bytes: releaseBytes, value: release } = await readJsonWithBytes(
    resolvedReleasePath,
    "winner source release",
  );
  const releaseSourcePath = resolveReleaseArtifactPath(
    resolvedReleasePath,
    release.source_path,
    "source_path",
  );
  const winnerPackagePath = resolveReleaseArtifactPath(
    resolvedReleasePath,
    release.winner_package_path ?? release.package_path,
    "winner_package_path",
  );
  const releaseSourceBytes = await fs.readFile(releaseSourcePath).catch(() => null);
  if (!releaseSourceBytes) throw new Error(`Missing winner release source: ${releaseSourcePath}`);
  const { bytes: packageBytes, value: packageContract } = await readJsonWithBytes(
    winnerPackagePath,
    "winner package",
  );
  const packageValidation = validateWinnerPackageContract(packageContract);
  if (!packageValidation.done) {
    throw new Error(`Invalid winner package contract: ${packageValidation.blockers.join(", ")}`);
  }
  const releaseValidation = validateWinnerSourceRelease(release, {
    sourceText: releaseSourceBytes.toString("utf8"),
    packageContract,
  });
  if (!releaseValidation.done) {
    throw new Error(`Invalid winner source release: ${releaseValidation.blockers.join(", ")}`);
  }
  const actualReleaseSha256 = sha256(releaseBytes);
  const actualPackageSha256 = sha256(packageBytes);
  if (release.winner_package_sha256 !== actualPackageSha256) {
    throw new Error(`Winner package hash mismatch: release records ${release.winner_package_sha256}, current file is ${actualPackageSha256}.`);
  }
  const currentSourceScriptSha256 = sha256Text(normalizeWinnerNarration(sourceText));
  if (currentSourceScriptSha256 !== release.source_script_sha256) {
    throw new Error(`Ingest source does not match the released narration: expected ${release.source_script_sha256}, found ${currentSourceScriptSha256}.`);
  }
  if (expectedRawSourceSha256 && sha256(Buffer.from(sourceText, "utf8")) !== expectedRawSourceSha256) {
    throw new Error("Ingest source bytes do not match run_identity.json source_sha256.");
  }
  if (release.channel !== expectedChannel || packageContract.channel !== expectedChannel) {
    throw new Error(`Winner release channel mismatch: expected ${expectedChannel}, release has ${release.channel}, package has ${packageContract.channel}.`);
  }
  if (expectedTitle && (release.selected_title !== expectedTitle || packageContract.selected_title !== expectedTitle)) {
    throw new Error(`Winner release title mismatch: run identity has "${expectedTitle}", approved package has "${packageContract.selected_title}".`);
  }
  if (release.development_slug !== packageContract.development_slug) {
    throw new Error("Winner release development_slug does not match the current winner package.");
  }
  if (release.selected_candidate_id && release.selected_candidate_id !== packageContract.selected_candidate_id) {
    throw new Error("Winner release selected_candidate_id does not match the current winner package.");
  }
  if (release.formula_version && release.formula_version !== packageContract.formula_version) {
    throw new Error("Winner release formula_version does not match the current winner package.");
  }
  if (release.formula_sha256 && release.formula_sha256 !== packageContract.formula_sha256) {
    throw new Error("Winner release formula_sha256 does not match the current winner package.");
  }
  if (identityBinding) {
    const exactChecks = [
      ["release_sha256", identityBinding.release_sha256, actualReleaseSha256],
      ["source_file_sha256", identityBinding.source_file_sha256, sha256(releaseSourceBytes)],
      ["source_script_sha256", identityBinding.source_script_sha256, release.source_script_sha256],
      ["winner_package_sha256", identityBinding.winner_package_sha256, actualPackageSha256],
      ["winner_gate_sha256", identityBinding.winner_gate_sha256, release.winner_gate_sha256],
      ["channel", identityBinding.channel, release.channel],
      ["development_slug", identityBinding.development_slug, release.development_slug],
      ["selected_candidate_id", identityBinding.selected_candidate_id, packageContract.selected_candidate_id],
      ["selected_title", identityBinding.selected_title, release.selected_title],
      ["formula_version", identityBinding.formula_version, packageContract.formula_version],
      ["formula_sha256", identityBinding.formula_sha256, packageContract.formula_sha256],
    ];
    for (const [field, boundValue, currentValue] of exactChecks) {
      if (boundValue !== currentValue) {
        throw new Error(`Winner release binding mismatch for ${field}: run identity has ${boundValue}, current artifact has ${currentValue}.`);
      }
    }
  }
  return {
    schema: "goldflow_ingest_winner_source_lineage_v1",
    binding_source: identityBinding ? "run_identity" : "explicit_ingest_flag",
    release_path: resolvedReleasePath,
    release_sha256: actualReleaseSha256,
    channel: release.channel,
    development_slug: release.development_slug,
    selected_candidate_id: packageContract.selected_candidate_id,
    selected_title: release.selected_title,
    source_path: releaseSourcePath,
    source_file_sha256: sha256(releaseSourceBytes),
    source_script_sha256: release.source_script_sha256,
    winner_package_path: winnerPackagePath,
    winner_package_sha256: actualPackageSha256,
    winner_gate_sha256: release.winner_gate_sha256,
    formula_version: packageContract.formula_version,
    formula_sha256: packageContract.formula_sha256,
    released_by: release.released_by,
    released_at: release.released_at,
    validated_at: new Date().toISOString(),
  };
}

function normalizeNewlines(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim() + "\n";
}

function stripSceneAnnotations(value) {
  return normalizeNewlines(value)
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (/^SC\d{3}\s*[—-]/.test(trimmed)) return false;
      if (/^#{1,6}\s+/.test(trimmed)) return false;
      if (/^\*\*.*(?:raw narration script|target:|pov:|ledger-verified).*?\*\*$/i.test(trimmed)) return false;
      if (/^-{3,}$/.test(trimmed)) return false;
      if (/^BLOCK\s+\d+\s*[—-]/i.test(trimmed)) return false;
      if (/^\[(?:SCENE|END\s+OF\s+EPISODE)\b[^\]]*\]$/i.test(trimmed)) return false;
      return true;
    })
    .map((line) => line.trim() === "NARRATOR:" ? "" : line)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim() + "\n";
}

function annotationWarnings(value) {
  const lines = normalizeNewlines(value).split("\n");
  const tags = ["LOCATION:", "TIME:", "VISIBLE SUBJECTS:", "PRIMARY SUBJECT:", "UI / TEXT ON SCREEN:", "SFX:", "MUSIC:", "VISUAL INTENT:", "NARRATOR:"];
  return tags
    .map((tag) => ({ tag, count: lines.filter((line) => line.trim().startsWith(tag)).length }))
    .filter((row) => row.count > 0);
}

async function main() {
  let runIdentity = null;
  try {
    runIdentity = await readJson(runIdentityPath);
  } catch {
    if (!allowMissingRunIdentity) {
      throw new Error(`Missing run identity preflight: ${runIdentityPath}. Run "node bin/goldflow.mjs run preflight --channel ${channel} --series <series> --week <stable-run-slug> --episode ${episode} --title <title>" before ingest.`);
    }
  }
  if (runIdentity) {
    for (const [key, actual, expected] of [
      ["channel", channel, runIdentity.channel],
      ["series", series, runIdentity.series_slug],
      ["week", week, runIdentity.week],
      ["episode", episode, runIdentity.episode],
    ]) {
      if (actual !== expected) throw new Error(`Run identity mismatch for ${key}: command has ${actual}, run_identity.json has ${expected}.`);
    }
  }
  const contentProfile = contentProfileForIdentity(runIdentity ?? {});
  const boundFactualEvidence = runIdentity?.factual_evidence ?? null;
  if (contentProfileRequiresEvidenceLedger(contentProfile) && !boundFactualEvidence) {
    throw new Error(`Content profile ${contentProfile.id} requires a factual evidence ledger bound during preflight.`);
  }
  let factualEvidenceLineage = null;
  let factualEvidenceBytes = null;
  if (boundFactualEvidence) {
    factualEvidenceBytes = await fs.readFile(boundFactualEvidence.path).catch(() => null);
    if (!factualEvidenceBytes) throw new Error(`Missing preflight-bound factual evidence ledger: ${boundFactualEvidence.path}`);
    let factualEvidenceLedger;
    try {
      factualEvidenceLedger = JSON.parse(factualEvidenceBytes.toString("utf8"));
    } catch (error) {
      throw new Error(`Invalid preflight-bound factual evidence ledger JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    factualEvidenceLineage = factualEvidenceBinding(
      factualEvidenceLedger,
      factualEvidenceBytes,
      boundFactualEvidence.path,
      { expectedProfileId: contentProfile.id },
    );
    for (const field of ["sha256", "content_profile", "title", "claim_count", "source_count"]) {
      if (factualEvidenceLineage[field] !== boundFactualEvidence[field]) {
        throw new Error(`Factual evidence binding mismatch for ${field}: run identity has ${boundFactualEvidence[field]}, current ledger has ${factualEvidenceLineage[field]}.`);
      }
    }
  }
  const source = storyText ?? (sourcePath ? await fs.readFile(sourcePath, "utf8") : "");
  if (!source.trim()) throw new Error("source-ingest requires --source <path> or --story <text>.");
  const identityWinnerRelease = runIdentity?.winner_source_release ?? null;
  const identityWinnerReleasePath = identityWinnerRelease?.release_path ?? identityWinnerRelease?.path ?? null;
  if (explicitWinnerReleasePath && identityWinnerReleasePath) {
    const explicitReleaseBytes = await fs.readFile(explicitWinnerReleasePath).catch(() => null);
    if (!explicitReleaseBytes) throw new Error(`Missing explicit winner source release: ${explicitWinnerReleasePath}`);
    if (identityWinnerRelease.release_sha256 && sha256(explicitReleaseBytes) !== identityWinnerRelease.release_sha256) {
      throw new Error("Explicit --winner-release does not match the release hash bound in run_identity.json.");
    }
  }
  const effectiveWinnerReleasePath = explicitWinnerReleasePath ?? identityWinnerReleasePath;
  const winnerSourceLineage = effectiveWinnerReleasePath
    ? await loadWinnerSourceReleaseContext(effectiveWinnerReleasePath, {
        sourceText: source,
        expectedChannel: channel,
        expectedTitle: runIdentity?.title ?? null,
        identityBinding: identityWinnerRelease,
        expectedRawSourceSha256: identityWinnerRelease ? runIdentity?.source_sha256 ?? null : null,
      })
    : null;
  if (winnerSourceLineage && stripAnnotations) {
    throw new Error("--strip-annotations is forbidden for a released winner source; ingest must preserve the exact approved narration hash.");
  }
  const operatorSource = normalizeNewlines(source);
  const scriptClean = stripAnnotations ? stripSceneAnnotations(operatorSource) : operatorSource;
  const sourceHash = sha256(operatorSource);
  const scriptHash = sha256(scriptClean);
  if (winnerSourceLineage && (sourceHash !== winnerSourceLineage.source_script_sha256 || scriptHash !== winnerSourceLineage.source_script_sha256)) {
    throw new Error("Normalized ingest/script hashes drifted from the approved winner source release.");
  }
  const operatorSourcePath = path.join(episodeDir, "operator_source_story.md");
  const scriptPath = path.join(episodeDir, "script_clean.md");
  const evidenceOutputPath = factualEvidenceBytes
    ? path.join(episodeDir, "source_evidence_ledger.json")
    : null;
  await fs.mkdir(episodeDir, { recursive: true });
  await fs.writeFile(operatorSourcePath, operatorSource, "utf8");
  await fs.writeFile(scriptPath, scriptClean, "utf8");
  if (evidenceOutputPath) await fs.writeFile(evidenceOutputPath, factualEvidenceBytes);
  const report = {
    schema: "goldflow_source_ingest_v1",
    status: "source_ingested_pending_review_and_approval",
    channel,
    series_slug: series,
    week,
    episode,
    source_path: sourcePath,
    run_identity_path: runIdentity ? runIdentityPath : null,
    operator_source_story_path: operatorSourcePath,
    script_clean_path: scriptPath,
    operator_source_hash: sourceHash,
    script_clean_hash: scriptHash,
    content_profile: contentProfile.id,
    content_profile_version: contentProfile.version,
    factual_evidence: factualEvidenceLineage ? {
      ...factualEvidenceLineage,
      ingested_path: evidenceOutputPath,
      ingested_sha256: sha256(factualEvidenceBytes),
    } : null,
    strip_annotations_applied: stripAnnotations,
    annotation_warnings: annotationWarnings(operatorSource),
    winner_source_release: winnerSourceLineage,
    policy: "Ingest preserves source text. If annotation stripping is enabled, only scene headings and NARRATOR labels are removed; creative prose is not rewritten.",
    next_required_stage: "manual review + operator approval for script_clean_hash",
    updated_at: new Date().toISOString(),
  };
  await writeJson(path.join(episodeDir, "source_story_ingest_report.json"), report);
  await writeJson(path.join(episodeDir, "operator_story_lock.json"), {
    schema: "goldflow_operator_story_lock_v1",
    status: "source_locked_ingest",
    channel,
    series_slug: series,
    week,
    episode,
    operator_source_hash: sourceHash,
    script_clean_hash: scriptHash,
    script_clean_path: scriptPath,
    content_profile: contentProfile.id,
    factual_evidence: factualEvidenceLineage ? {
      source_path: boundFactualEvidence.path,
      source_sha256: factualEvidenceLineage.sha256,
      ingested_path: evidenceOutputPath,
      ingested_sha256: sha256(factualEvidenceBytes),
    } : null,
    winner_source_release: winnerSourceLineage,
    updated_at: report.updated_at,
  });
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
