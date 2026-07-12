#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { buildParallaxAssets } from "./editorial-parallax-assets.mjs";
import { sha256File } from "./lib/file-hash.mjs";
import { parallaxAssetContractSha256 } from "./lib/parallax-contract.mjs";
import { selectAuthoredParallaxCandidates } from "./lib/parallax-policy.mjs";

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
  const outputPath = path.resolve(flags.output ?? path.join(episodeDir, `parallax_asset_report_${episode}.json`));
  const assetsDir = path.resolve(flags["assets-dir"] ?? path.join(episodeDir, "assets", "motion", "parallax"));
  const reviewSheetPath = path.resolve(flags["review-sheet"] ?? path.join(episodeDir, "review_samples", "parallax_assets", `parallax_asset_review_${episode}.jpg`));
  const [promptPlan, imagegenReport, imageQa, identity] = await Promise.all([
    readJson(promptPath),
    readJson(imagegenPath),
    readJson(imageQaPath),
    readJson(identityPath, {}),
  ]);
  if (promptPlan?.status !== "passed") throw new Error(`Missing passed hardened prompt plan: ${promptPath}`);
  if (imagegenReport?.status !== "passed") throw new Error(`Missing passed imagegen report: ${imagegenPath}`);
  if (imageQa?.status !== "passed") throw new Error(`Parallax assets require passed image QA: ${imageQaPath}`);
  const parallaxPolicy = String(identity.parallax_policy ?? "disabled");
  const maxCandidates = Math.floor(boundedNumber(flags["max-candidates"] ?? identity.parallax_target_max, 3, 0, 5));
  const minSpacingSec = boundedNumber(flags["min-spacing-sec"] ?? identity.parallax_min_spacing_sec, 6, 0, 120);
  const selected = parallaxPolicy === "selective_inspected"
    ? selectAuthoredParallaxCandidates(promptPlan.prompts, {
        maxCandidates,
        minSpacingSec,
      })
    : [];
  const sourceHashes = Object.fromEntries(await Promise.all(
    [promptPath, imagegenPath, imageQaPath, identityPath].map(async (filePath) => [filePath, await sha256File(filePath)]),
  ));
  if (!selected.length) {
    const waiverRequested = isTrue(flags["no-suitable-parallax"]);
    const reviewer = String(flags.reviewer ?? "").trim();
    const note = String(flags.note ?? "").trim();
    const policyRequiresDecision = parallaxPolicy === "selective_inspected";
    const status = policyRequiresDecision && !waiverRequested ? "blocked" : "passed";
    if (waiverRequested && (!reviewer || !note)) throw new Error("A no-suitable-parallax waiver requires --reviewer and --note.");
    const report = {
      schema: "goldflow_parallax_asset_report_v1",
      status,
      review_status: status === "passed" ? "skipped_with_waiver" : "needs_no_candidate_decision",
      channel,
      series_slug: series,
      week,
      episode,
      parallax_policy: parallaxPolicy,
      candidate_count: 0,
      candidates: [],
      no_suitable_parallax_waiver: waiverRequested ? { reviewer, note, approved_at: new Date().toISOString() } : null,
      blockers: status === "blocked" ? [{ code: "parallax_no_candidate_decision_required", message: "No LLM-authored separable hero frame survived selection. Confirm the explicit no-suitable-parallax waiver or repair motion depth nominations." }] : [],
      next_command_shape: status === "blocked"
        ? `node bin/goldflow.mjs visual parallax-assets --channel ${channel} --series ${series} --week ${week} --episode ${episode} --no-suitable-parallax true --reviewer <name> --note "<reason>"`
        : null,
      source_hashes: sourceHashes,
      updated_at: new Date().toISOString(),
    };
    report.asset_contract_sha256 = parallaxAssetContractSha256(report);
    await writeJson(outputPath, report);
    console.log(JSON.stringify({ status, output_path: outputPath, candidate_count: 0, next_command_shape: report.next_command_shape }, null, 2));
    if (status !== "passed") process.exitCode = 2;
    return;
  }

  const resultById = new Map((imagegenReport.results ?? []).map((row) => [String(row.image_id ?? ""), row]));
  const acceptedHashes = imageQa.accepted_image_hashes ?? {};
  const candidates = [];
  for (const candidate of selected) {
    const generated = resultById.get(candidate.image_id);
    const generatedImagePath = String(generated?.image_path ?? "").trim();
    if (!generatedImagePath) throw new Error(`Missing generated image for parallax candidate ${candidate.image_id}.`);
    const imagePath = path.resolve(generatedImagePath);
    const imageHash = await sha256File(imagePath);
    if (acceptedHashes[candidate.image_id] !== imageHash) throw new Error(`Parallax candidate is not bound to an accepted image hash: ${candidate.image_id}`);
    const slug = candidate.image_id.replace(/[^a-zA-Z0-9._-]+/g, "-");
    const assetReport = await buildParallaxAssets({
      imagePath,
      outputDir: path.join(assetsDir, slug),
      slug,
    });
    candidates.push({
      ...candidate,
      image_path: imagePath,
      image_sha256: imageHash,
      asset_report_path: assetReport.report_path,
      asset_report: assetReport,
    });
  }
  const reviewSheet = await writeReviewSheet(candidates, reviewSheetPath);
  const report = {
    schema: "goldflow_parallax_asset_report_v1",
    status: "passed",
    review_status: "needs_review",
    channel,
    series_slug: series,
    week,
    episode,
    parallax_policy: parallaxPolicy,
    candidate_count: candidates.length,
    target_max: maxCandidates,
    min_spacing_sec: minSpacingSec,
    review_sheet_path: reviewSheet,
    candidates,
    source_hashes: sourceHashes,
    updated_at: new Date().toISOString(),
  };
  report.asset_contract_sha256 = parallaxAssetContractSha256(report);
  await writeJson(outputPath, report);
  console.log(JSON.stringify({
    status: "passed",
    output_path: outputPath,
    candidate_count: candidates.length,
    review_sheet_path: reviewSheet,
    review_status: report.review_status,
  }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
