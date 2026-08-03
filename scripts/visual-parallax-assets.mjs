#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  buildParallaxForegroundEvidence,
  completeParallaxAssetsFromForegroundEvidence,
} from "./editorial-parallax-assets.mjs";
import { sha256File } from "./lib/file-hash.mjs";
import { parallaxAssetContractSha256 } from "./lib/parallax-contract.mjs";
import {
  authoredParallaxCandidatePool,
  classifyParallaxSeparationEvidence,
  inspectedParallaxCandidateOverrides,
  selectEvidenceBackedParallaxCandidates,
} from "./lib/parallax-policy.mjs";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));

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

function isTrue(value) {
  return /^(true|1|yes)$/i.test(String(value ?? ""));
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function parseList(value) {
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(items.length || 1, concurrency)) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function svgLabel(label, width, height) {
  const clean = String(label ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#111111"/>
    <text x="10" y="29" fill="#ffffff" font-family="Arial" font-size="16" font-weight="700">${clean}</text>
  </svg>`);
}

async function reviewPanel(filePath, label, { width = 400, imageHeight = 225, flatten = false } = {}) {
  let pipeline = sharp(filePath).resize({ width, height: imageHeight, fit: "contain", background: "#202020" });
  if (flatten) pipeline = pipeline.flatten({ background: "#202020" });
  const image = await pipeline.png().toBuffer();
  return sharp({
    create: { width, height: imageHeight + 42, channels: 3, background: "#111111" },
  }).composite([
    { input: image, top: 0, left: 0 },
    { input: svgLabel(label, width, 42), top: imageHeight, left: 0 },
  ]).jpeg({ quality: 90 }).toBuffer();
}

async function writeReviewSheet(candidates, outputPath) {
  if (!candidates.length) return null;
  const width = 400;
  const rowHeight = 267;
  const columns = 4;
  const composites = [];
  for (let rowIndex = 0; rowIndex < candidates.length; rowIndex += 1) {
    const row = candidates[rowIndex];
    const panels = [
      [row.image_path, `${row.image_id} source`, false],
      [row.asset_report.mask_path, `mask instances=${row.asset_report.mask_report?.instance_count ?? "?"}`, true],
      [row.asset_report.foreground_path, "foreground RGBA", true],
      [row.asset_report.background_path, "background plate", false],
    ];
    for (let column = 0; column < panels.length; column += 1) {
      const [filePath, label, flatten] = panels[column];
      composites.push({
        input: await reviewPanel(filePath, label, { width, flatten }),
        left: column * width,
        top: rowIndex * rowHeight,
      });
    }
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await sharp({
    create: {
      width: columns * width,
      height: candidates.length * rowHeight,
      channels: 3,
      background: "#080808",
    },
  }).composite(composites).jpeg({ quality: 90 }).toFile(outputPath);
  return outputPath;
}

async function writeForegroundEvidenceSheet(rows, outputPath) {
  if (!rows.length) return null;
  const width = 400;
  const rowHeight = 267;
  const columns = 3;
  const composites = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const evidence = row.foreground_evidence;
    const classification = row.separation_evidence_classification;
    const coverage = evidence?.local_separation_evidence?.foreground_coverage_ratio;
    const panels = [
      [row.image_path, `${row.image_id} accepted source`, false],
      [evidence.mask_path, `${classification.separation_class}; coverage=${coverage ?? "?"}`, true],
      [evidence.foreground_path, `local foreground; ${classification.recommended_disposition}`, true],
    ];
    for (let column = 0; column < panels.length; column += 1) {
      const [filePath, label, flatten] = panels[column];
      composites.push({
        input: await reviewPanel(filePath, label, { width, flatten }),
        left: column * width,
        top: rowIndex * rowHeight,
      });
    }
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await sharp({
    create: {
      width: columns * width,
      height: rows.length * rowHeight,
      channels: 3,
      background: "#080808",
    },
  }).composite(composites).jpeg({ quality: 90 }).toFile(outputPath);
  return outputPath;
}

async function main() {
  const channel = flags.channel ?? "53rebirth";
  const series = flags.series ?? flags.seriesSlug ?? "series";
  const week = flags.week ?? "current";
  const episode = flags.episode ?? "ep_01";
  const episodeDir = flags["episode-dir"]
    ? path.resolve(flags["episode-dir"])
    : path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode);
  const promptPath = path.resolve(flags.prompts ?? path.join(episodeDir, "section_image_prompts_hardened.json"));
  const imagegenPath = path.resolve(flags["imagegen-report"] ?? path.join(episodeDir, `imagegen_report_${episode}.json`));
  const imageQaPath = path.resolve(flags["image-output-qa"] ?? path.join(episodeDir, `image_output_qa_${episode}.json`));
  const identityPath = path.resolve(flags["run-identity"] ?? path.join(episodeDir, "run_identity.json"));
  const candidateOverridesPath = flags["candidate-overrides"] ? path.resolve(flags["candidate-overrides"]) : null;
  const outputPath = path.resolve(flags.output ?? path.join(episodeDir, `parallax_asset_report_${episode}.json`));
  const assetsDir = path.resolve(flags["assets-dir"] ?? path.join(episodeDir, "assets", "motion", "parallax"));
  const reviewSheetPath = path.resolve(flags["review-sheet"] ?? path.join(episodeDir, "review_samples", "parallax_assets", `parallax_asset_review_${episode}.jpg`));
  const foregroundEvidencePath = path.resolve(flags["foreground-evidence-report"] ?? path.join(episodeDir, `parallax_foreground_evidence_${episode}.json`));
  const foregroundEvidenceSheetPath = path.resolve(flags["foreground-evidence-sheet"] ?? path.join(episodeDir, "review_samples", "parallax_assets", `parallax_foreground_evidence_${episode}.jpg`));
  const repairIds = new Set(parseList(flags["image-ids"]));
  const [promptPlan, imagegenReport, imageQa, identity, candidateOverrides] = await Promise.all([
    readJson(promptPath),
    readJson(imagegenPath),
    readJson(imageQaPath),
    readJson(identityPath, {}),
    candidateOverridesPath ? readJson(candidateOverridesPath) : null,
  ]);
  if (promptPlan?.status !== "passed") throw new Error(`Missing passed hardened prompt plan: ${promptPath}`);
  if (imagegenReport?.status !== "passed") throw new Error(`Missing passed imagegen report: ${imagegenPath}`);
  if (imageQa?.status !== "passed") throw new Error(`Parallax assets require passed image QA: ${imageQaPath}`);
  const parallaxPolicy = String(identity.parallax_policy ?? "disabled");
  const maxCandidates = Math.floor(boundedNumber(flags["max-candidates"] ?? identity.parallax_target_max, 15, 0, 20));
  const minSpacingSec = boundedNumber(flags["min-spacing-sec"] ?? identity.parallax_min_spacing_sec, 3, 0, 120);
  const openingWindowSec = boundedNumber(flags["opening-window-sec"] ?? identity.parallax_opening_window_sec, 180, 0, 600);
  const firstWindowSec = boundedNumber(flags["first-window-sec"] ?? identity.parallax_first_window_sec, 30, 0, openingWindowSec);
  const firstWindowTarget = Math.floor(boundedNumber(flags["first-window-target"] ?? identity.parallax_first_window_target, 5, 0, maxCandidates));
  const retentionWindowTarget = Math.floor(boundedNumber(flags["retention-window-target"] ?? identity.parallax_retention_window_target, 10, 0, maxCandidates));
  const backgroundProvider = String(
    flags["background-provider"]
      ?? identity.parallax_background_provider
      ?? (identity.image_provider === "modelslab" ? "modelslab_flux_klein" : "local_blur_legacy"),
  ).trim();
  if (!["modelslab_flux_klein", "local_blur_legacy"].includes(backgroundProvider)) {
    throw new Error(`Unsupported parallax background provider: ${backgroundProvider}`);
  }
  const acceptedHashes = imageQa.accepted_image_hashes ?? {};
  const scopedRepairEvidence = repairIds.size ? await readJson(foregroundEvidencePath, null) : null;
  const inspectedOverrides = candidateOverrides
    ? inspectedParallaxCandidateOverrides(promptPlan.prompts, candidateOverrides, { maxCandidates: 20, openingWindowSec })
    : null;
  let evidencePool = parallaxPolicy === "selective_inspected"
    ? (inspectedOverrides ?? authoredParallaxCandidatePool(promptPlan.prompts, {
        openingWindowSec,
        acceptedImageIds: acceptedHashes,
      }))
    : [];
  if (repairIds.size) {
    const poolById = new Map([
      ...evidencePool,
      ...(scopedRepairEvidence?.candidates ?? []),
    ].map((row) => [String(row.image_id ?? ""), row]));
    evidencePool = [...poolById.values()].filter((row) => row.image_id);
    const knownPoolIds = new Set(evidencePool.map((row) => row.image_id));
    const unknownRepairIds = [...repairIds].filter((imageId) => !knownPoolIds.has(imageId));
    if (unknownRepairIds.length) throw new Error(`Scoped parallax repair ids are not eligible accepted cuts: ${unknownRepairIds.join(", ")}`);
    evidencePool = evidencePool.filter((row) => repairIds.has(row.image_id));
  }
  const sourceHashes = Object.fromEntries(await Promise.all(
    [promptPath, imagegenPath, imageQaPath, identityPath, candidateOverridesPath].filter(Boolean).map(async (filePath) => [filePath, await sha256File(filePath)]),
  ));
  if (isTrue(flags["revalidate-existing"])) {
    const existing = await readJson(outputPath);
    if (existing?.status !== "passed" || !Array.isArray(existing.candidates)) {
      throw new Error(`Parallax revalidation requires an existing passed asset report: ${outputPath}`);
    }
    const promptById = new Map((promptPlan.prompts ?? []).map((prompt) => [String(prompt.image_id ?? ""), prompt]));
    const candidates = [];
    for (const candidate of existing.candidates) {
      const imageId = String(candidate.image_id ?? "");
      const prompt = promptById.get(imageId);
      if (!prompt) throw new Error(`Parallax revalidation could not find current prompt cut: ${imageId}`);
      const imageHash = await sha256File(candidate.image_path);
      if (!imageHash || imageHash !== candidate.image_sha256 || acceptedHashes[imageId] !== imageHash) {
        throw new Error(`Parallax revalidation image hash mismatch: ${imageId}`);
      }
      for (const [assetPath, expectedHash] of [
        [candidate.asset_report?.mask_path, candidate.asset_report?.mask_sha256],
        [candidate.asset_report?.foreground_path, candidate.asset_report?.foreground_sha256],
        [candidate.asset_report?.background_path, candidate.asset_report?.background_sha256],
      ]) {
        if (!assetPath || !expectedHash || await sha256File(assetPath) !== expectedHash) {
          throw new Error(`Parallax revalidation asset hash mismatch for ${imageId}: ${assetPath ?? "<missing>"}`);
        }
      }
      candidates.push({
        ...candidate,
        scene_id: prompt.scene_id ?? candidate.scene_id,
        visual_beat_id: prompt.visual_beat_id ?? candidate.visual_beat_id,
        start_sec: Number(prompt.start_sec ?? candidate.start_sec ?? 0),
        duration_sec: Number(prompt.duration_sec ?? candidate.duration_sec ?? 0),
      });
    }
    const report = {
      ...existing,
      source_hashes: sourceHashes,
      candidates,
      candidate_count: candidates.length,
      timing_revalidated_without_asset_generation: true,
      timing_revalidated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    report.asset_contract_sha256 = parallaxAssetContractSha256(report);
    await writeJson(outputPath, report);
    console.log(JSON.stringify({
      status: report.status,
      output_path: outputPath,
      candidate_count: report.candidate_count,
      timing_revalidated_without_asset_generation: true,
    }, null, 2));
    return;
  }
  const resultById = new Map((imagegenReport.results ?? []).map((row) => [String(row.image_id ?? ""), row]));
  const priorReport = repairIds.size ? await readJson(outputPath, null) : null;
  const priorEvidence = scopedRepairEvidence;
  const retainedCandidates = (priorReport?.candidates ?? []).filter((row) => !repairIds.has(String(row.image_id ?? "")));
  const retainedEvidenceRows = (priorEvidence?.candidates ?? []).filter((row) => !repairIds.has(String(row.image_id ?? "")));
  const retainedFailures = (priorReport?.candidate_failures ?? []).filter((row) => !repairIds.has(String(row.image_id ?? "")));
  const evidenceResults = await mapWithConcurrency(evidencePool, Number(flags["mask-concurrency"] ?? 6), async (candidate) => {
    try {
      const generated = resultById.get(candidate.image_id);
      const generatedImagePath = String(generated?.image_path ?? "").trim();
      if (!generatedImagePath) return { candidate: null, failure: {
        image_id: candidate.image_id,
        phase: "accepted_image_binding",
        critical: true,
        error: `Missing generated image for accepted parallax cut ${candidate.image_id}.`,
      } };
      const imagePath = path.resolve(generatedImagePath);
      const imageHash = await sha256File(imagePath);
      if (acceptedHashes[candidate.image_id] !== imageHash) return { candidate: null, failure: {
        image_id: candidate.image_id,
        phase: "accepted_image_binding",
        critical: true,
        error: `Parallax candidate is not bound to the accepted image hash: ${candidate.image_id}.`,
      } };
      const slug = candidate.image_id.replace(/[^a-zA-Z0-9._-]+/g, "-");
      const foregroundEvidence = await buildParallaxForegroundEvidence({
        imagePath,
        outputDir: path.join(assetsDir, slug),
        slug,
      });
      return { candidate: {
        ...candidate,
        image_path: imagePath,
        image_sha256: imageHash,
        foreground_evidence_path: foregroundEvidence.report_path,
        foreground_evidence: foregroundEvidence,
        separation_evidence_classification: classifyParallaxSeparationEvidence(foregroundEvidence),
      }, failure: null };
    } catch (error) {
      return { candidate: null, failure: {
        image_id: candidate.image_id,
        phase: "local_foreground_evidence",
        critical: false,
        error: error instanceof Error ? error.message : String(error),
      } };
    }
  });
  const freshEvidenceRows = evidenceResults.map((row) => row.candidate).filter(Boolean);
  const evidenceFailures = evidenceResults.map((row) => row.failure).filter(Boolean);
  const allEvidenceRows = [...retainedEvidenceRows, ...freshEvidenceRows]
    .sort((left, right) => Number(left.start_sec ?? 0) - Number(right.start_sec ?? 0));
  const evidenceSheet = await writeForegroundEvidenceSheet(allEvidenceRows, foregroundEvidenceSheetPath);
  const evidenceReport = {
    schema: "goldflow_parallax_foreground_evidence_report_v1",
    status: evidenceFailures.some((row) => row.critical) ? "blocked" : "passed",
    policy: "Accepted source images are checked with local foreground masks before any Flux Klein rear-plate spend. Aesthetic separation weakness is nonblocking and falls back to single-plane motion.",
    automatic_retry_count: 0,
    candidate_pool_count: allEvidenceRows.length + evidenceFailures.length,
    evidence_count: allEvidenceRows.length,
    candidates: allEvidenceRows,
    failures: [...(priorEvidence?.failures ?? []).filter((row) => !repairIds.has(String(row.image_id ?? ""))), ...evidenceFailures],
    review_sheet_path: evidenceSheet,
    updated_at: new Date().toISOString(),
  };
  await writeJson(foregroundEvidencePath, evidenceReport);
  const selected = selectEvidenceBackedParallaxCandidates(freshEvidenceRows, {
    maxCandidates,
    minSpacingSec,
    firstWindowSec,
    openingWindowSec,
    firstWindowTarget,
    retentionWindowTarget,
  });
  const assetResults = await Promise.all(selected.map(async (candidate) => {
    try {
      const slug = candidate.image_id.replace(/[^a-zA-Z0-9._-]+/g, "-");
      const assetReport = await completeParallaxAssetsFromForegroundEvidence({
        foregroundEvidence: candidate.foreground_evidence,
        outputDir: path.join(assetsDir, slug),
        slug,
        backgroundProvider,
        foregroundSubject: candidate.foreground_subject,
        backgroundPlane: candidate.background_plane,
      });
      return { candidate: {
        ...candidate,
        asset_report_path: assetReport.report_path,
        asset_report: assetReport,
      }, failure: null };
    } catch (error) {
      return { candidate: null, failure: {
        image_id: candidate.image_id,
        phase: "rear_plate_generation",
        critical: false,
        disposition: "repairable",
        error: error instanceof Error ? error.message : String(error),
      } };
    }
  }));
  const freshCandidates = assetResults.map((row) => row.candidate).filter(Boolean);
  const assetFailures = assetResults.map((row) => row.failure).filter(Boolean);
  const candidates = [...retainedCandidates, ...freshCandidates]
    .sort((left, right) => Number(left.start_sec ?? 0) - Number(right.start_sec ?? 0));
  const candidateFailures = [...retainedFailures, ...evidenceFailures, ...assetFailures];
  const criticalFailures = candidateFailures.filter((row) => row.critical);
  const repairableFailureIds = [...new Set(candidateFailures.filter((row) => !row.critical).map((row) => row.image_id))];
  const criticalFailureIds = [...new Set(criticalFailures.map((row) => row.image_id))];
  const reviewSheet = await writeReviewSheet(candidates, reviewSheetPath);
  const status = criticalFailures.length ? "blocked" : "passed";
  const report = {
    schema: "goldflow_parallax_asset_report_v2",
    status,
    review_status: candidates.length ? "needs_review" : "automatic_single_plane_fallback",
    channel,
    series_slug: series,
    week,
    episode,
    parallax_policy: parallaxPolicy,
    background_provider: backgroundProvider,
    candidate_count: candidates.length,
    selected_candidate_count: candidates.length + assetFailures.length,
    candidate_failures: candidateFailures,
    critical_failure_ids: criticalFailureIds,
    repairable_failure_ids: repairableFailureIds,
    automatic_retry_count: 0,
    target_max: maxCandidates,
    min_spacing_sec: minSpacingSec,
    first_window_sec: firstWindowSec,
    first_window_target: firstWindowTarget,
    retention_window_target: retentionWindowTarget,
    opening_window_sec: openingWindowSec,
    first_window_candidate_count: candidates.filter((row) => row.start_sec < firstWindowSec).length,
    retention_window_candidate_count: candidates.filter((row) => row.start_sec >= firstWindowSec && row.start_sec < openingWindowSec).length,
    selection_source: candidateOverrides
      ? "inspected_override_plus_accepted_image_local_separation_evidence"
      : "accepted_image_local_separation_evidence",
    candidate_overrides_path: candidateOverridesPath,
    foreground_evidence_report_path: foregroundEvidencePath,
    foreground_evidence_report_sha256: await sha256File(foregroundEvidencePath),
    foreground_evidence_review_sheet_path: evidenceSheet,
    review_sheet_path: reviewSheet,
    candidates,
    no_suitable_parallax: candidates.length ? null : {
      disposition: "accepted_single_plane_motion_fallback",
      reason: evidencePool.length
        ? "No locally evidenced separation produced a reviewable rear plate; the accepted still treatment remains valid."
        : "No eligible accepted frame required layered separation; the accepted still treatment remains valid.",
      aesthetic_outcome_nonblocking: true,
    },
    blockers: criticalFailures.length ? [{
      code: "parallax_accepted_image_binding_failed",
      image_ids: criticalFailureIds,
      message: "Accepted-image provenance is missing or stale. Repair only these exact image ids; all passed mask/rear-plate assets remain preserved.",
    }] : [],
    next_command_shape: criticalFailureIds.length
      ? `node bin/goldflow.mjs visual parallax-assets --channel ${channel} --series ${series} --week ${week} --episode ${episode} --image-ids ${criticalFailureIds.join(",")}`
      : null,
    optional_repair_command_shape: repairableFailureIds.length
      ? `node bin/goldflow.mjs visual parallax-assets --channel ${channel} --series ${series} --week ${week} --episode ${episode} --image-ids ${repairableFailureIds.join(",")}`
      : null,
    estimated_background_cost_usd: Number(candidates.reduce(
      (sum, row) => sum + Number(row.asset_report?.background_provider_result?.estimated_cost_usd ?? 0),
      0,
    ).toFixed(4)),
    source_hashes: sourceHashes,
    updated_at: new Date().toISOString(),
  };
  report.asset_contract_sha256 = parallaxAssetContractSha256(report);
  await writeJson(outputPath, report);
  console.log(JSON.stringify({
    status,
    output_path: outputPath,
    candidate_count: candidates.length,
    failed_candidate_count: candidateFailures.length,
    critical_failure_count: criticalFailures.length,
    repairable_failure_count: repairableFailureIds.length,
    review_sheet_path: reviewSheet,
    review_status: report.review_status,
  }, null, 2));
  if (status !== "passed") process.exitCode = 2;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
