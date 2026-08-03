#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { backgroundPopulationIsRequired } from "./lib/background-population-utils.mjs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  promptHasEquipmentGeometryRisk,
  promptHasImmutableAnatomyRisk,
} from "./lib/shot-manifest-risk-contracts.mjs";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeDir = flags["episode-dir"]
  ? path.resolve(flags["episode-dir"])
  : path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode);
const promptPath = flags.prompts ?? path.join(episodeDir, "section_image_prompts_hardened.json");
const imagegenReportPath = flags["imagegen-report"] ?? path.join(episodeDir, `imagegen_report_${episode}.json`);
const ledgerPath = flags.ledger ?? path.join(episodeDir, "cut_execution_ledger.json");
const outputPath = flags.output ?? path.join(episodeDir, `image_output_qa_${episode}.json`);
const reviewDecisionsPath = flags.decisions
  ?? flags["review-decisions"]
  ?? path.join(episodeDir, `image_output_review_decisions_${episode}.json`);
const runIdentityPath = flags["run-identity"] ?? path.join(episodeDir, "run_identity.json");
const focalAnalysisPath = flags["focal-analysis"] ?? path.join(episodeDir, `image_focal_analysis_${episode}.json`);
const reviewDir = flags["review-dir"] ?? path.join(episodeDir, "review_samples", "image_output_qa");
const approve = flags.approve === "true" || flags["approve-risk"] === "true";
const legacyBulkApproval = flags["legacy-bulk-approval"] === "true";
const reviewer = String(flags.reviewer ?? "").trim();
const reviewNote = String(flags.note ?? "").trim();
const rejectedIds = new Set(parseList(flags["reject-cut-ids"] ?? flags["reject-image-ids"]));
const acceptedIds = new Set(parseList(flags["accept-cut-ids"] ?? flags["accept-image-ids"]));
const criticalRejectedIds = new Set(parseList(
  flags["critical-reject-cut-ids"]
  ?? flags["structural-reject-cut-ids"]
  ?? flags["critical-reject-image-ids"],
));
const openingReviewSec = Math.max(0, Number(flags["opening-review-sec"] ?? 180));
const contactWindowSec = Math.max(60, Number(flags["contact-window-sec"] ?? 300));
const integrationSampleRate = Math.max(0, Math.min(1, Number(flags["integration-sample-rate"] ?? 0.08)));
const writeFullContactSheets = flags["write-full-contact-sheets"] === "true";
const incrementalPacket = flags["incremental-packet"] === "true";
const updateCutLedger = flags["update-ledger"] !== "false";

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

function parseList(value) {
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function exists(filePath) {
  return Boolean(filePath) && fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
}

async function hashFile(filePath) {
  return sha256(await fs.readFile(filePath));
}

function visibleCharacterCount(prompt) {
  const manifest = prompt?.shot_manifest ?? {};
  return new Set([
    ...(manifest.visible_characters ?? []),
    ...(prompt.visible_characters ?? []),
  ].map((value) => String(value ?? "").trim()).filter(Boolean)).size;
}

export function imageRiskReasons(prompt, { openingSec = 180 } = {}) {
  const reasons = [];
  if (Number(prompt?.start_sec ?? 0) < openingSec) reasons.push("opening_retention");
  const job = String(prompt?.shot_manifest?.shot_job ?? prompt?.suggested_shot_job ?? "").toLowerCase();
  const action = `${prompt?.shot_manifest?.foreground_action ?? ""} ${prompt?.visual_beat_action ?? ""}`;
  if (job === "physical_action" || /\b(?:lift|carry|catch|pin|restrain|shield|stab|strike|hit|shove|grab|rescue|fight)\b/i.test(action)) reasons.push("physical_action_geometry");
  if (promptHasImmutableAnatomyRisk(prompt)) reasons.push("immutable_anatomy_adherence");
  if (promptHasEquipmentGeometryRisk(prompt)) reasons.push("equipment_count_hand_and_contact_geometry");
  if (visibleCharacterCount(prompt) >= 3) reasons.push("dense_cast");
  if (backgroundPopulationIsRequired(prompt?.shot_manifest?.background_population)) reasons.push("background_population");
  const referenceCount = Math.max(prompt?.reference_slots?.length ?? 0, prompt?.reference_requirements?.length ?? 0);
  if (referenceCount >= 4) reasons.push("four_reference_integration");
  const providerRoute = String(prompt?.target_provider_route ?? prompt?.image_provider_route ?? "");
  const providerRisk = String(prompt?.provider_risk_tier ?? prompt?.risk_tier ?? "").toLowerCase();
  if (providerRoute === "codex_imagegen" || /hero|high|risky/.test(providerRisk)) reasons.push("provider_routed_hero_or_risky_cut");
  return [...new Set(reasons)];
}

function deterministicSampleSelected(imageId, rate) {
  if (rate <= 0) return false;
  const bucket = Number.parseInt(sha256(String(imageId)).slice(0, 8), 16) / 0xffffffff;
  return bucket < rate;
}

export function imageManualReviewPolicy(prompt, compositionFindings = [], options = {}) {
  const reasons = imageRiskReasons(prompt, { openingSec: options.openingSec ?? 180 });
  const compositionReasons = [];
  for (const finding of compositionFindings) {
    if (String(finding?.severity ?? "").toLowerCase() === "needs_review") {
      const reason = `composition:${finding.code}`;
      compositionReasons.push(reason);
    }
  }
  const sampleCandidate = reasons.includes("four_reference_integration");
  const sampled = sampleCandidate && deterministicSampleSelected(prompt?.image_id, Number(options.integrationSampleRate ?? 0.08));
  const advisoryReasons = [...new Set([
    ...(sampled ? ["sampled_four_reference_integration"] : []),
    ...reasons,
    ...compositionReasons,
  ])];
  if (advisoryReasons.length) {
    return { tier: "advisory_review_log", requires_manual_review: false, reasons: advisoryReasons, sampled };
  }
  return { tier: "structural_auto_pass", requires_manual_review: false, reasons: [], sampled: false };
}

const REVIEW_DECISIONS = new Set(["accepted", "rejected", "not_inspected"]);

function normalizedReviewDecision(value) {
  const normalized = String(value ?? "not_inspected").trim().toLowerCase();
  return REVIEW_DECISIONS.has(normalized) ? normalized : "not_inspected";
}

export function mergeRiskReviewDecisions(rows, prior = {}, options = {}) {
  const reviewerValue = String(options.reviewer || prior.reviewer || "").trim();
  const noteValue = String(options.note || prior.note || "").trim();
  const acceptIds = new Set(options.acceptedIds ?? []);
  const rejectIds = new Set(options.rejectedIds ?? []);
  const priorById = new Map((prior.decisions ?? []).map((row) => [String(row.image_id ?? ""), row]));
  const currentDecisions = rows.filter((row) => (
    row.requires_manual_risk_review
    || acceptIds.has(row.image_id)
    || rejectIds.has(row.image_id)
    || priorById.get(row.image_id)?.image_sha256 === row.image_sha256
  )).map((row) => {
    const previous = priorById.get(row.image_id);
    const hashMatches = previous?.image_sha256 === row.image_sha256;
    let decision = hashMatches ? normalizedReviewDecision(previous?.decision) : "not_inspected";
    if (acceptIds.has(row.image_id)) decision = "accepted";
    if (rejectIds.has(row.image_id)) decision = "rejected";
    return {
      image_id: row.image_id,
      image_sha256: row.image_sha256,
      image_path: row.image_path,
      start_sec: row.start_sec,
      risk_reasons: row.risk_reasons,
      decision,
      note: hashMatches ? previous?.note ?? "" : "",
      focal_override: hashMatches ? previous?.focal_override ?? null : null,
    };
  });
  const currentIds = new Set(rows.map((row) => row.image_id));
  const decisions = options.preserveUnseen === true
    ? [
        ...currentDecisions,
        ...(prior.decisions ?? []).filter((row) => !currentIds.has(String(row?.image_id ?? ""))),
      ]
    : currentDecisions;
  const counts = Object.fromEntries([...REVIEW_DECISIONS].map((value) => [value, decisions.filter((row) => row.decision === value).length]));
  const status = counts.not_inspected > 0 ? "pending_review" : "complete";
  return {
    schema: "goldflow_image_output_review_decisions_v2",
    status,
    reviewer: reviewerValue,
    note: noteValue,
    decision_contract: "Hash-bound accepted/rejected decisions are advisory packaging and replacement notes. Only an explicit critical rejection or a deterministic structural failure blocks the exact cut. Generated-image spelling is outside this review contract.",
    counts,
    decisions,
    updated_at: new Date().toISOString(),
  };
}

export function donorRecoveryFinding(metadata, imageId) {
  if (metadata?.editorial_reuse_approved === true && metadata?.reuse_source_image_id) return null;
  const mode = String(metadata?.recovery_mode ?? metadata?.generated?.recovery_mode ?? "").toLowerCase();
  const donorId = metadata?.donor_image_id ?? metadata?.copied_from_image_id ?? metadata?.source_image_id ?? null;
  const perturbed = metadata?.hash_perturbation === true || metadata?.generated?.hash_perturbation === true;
  if (!donorId && !/donor|nearest.?neighbor|copied.?scene|hash.?perturb/.test(mode) && !perturbed) return null;
  return {
    image_id: imageId,
    severity: "blocker",
    code: "scene_image_donor_recovery_forbidden",
    message: `Scene image ${imageId} was recovered from donor ${donorId ?? "unknown"}; generate the actual cut instead of laundering a copied frame.`,
  };
}

export function duplicateHashFindingsForRows(rows = []) {
  const byHash = new Map();
  for (const row of rows) {
    const imageId = String(row?.image_id ?? "").trim();
    const imageHash = String(row?.image_sha256 ?? "").trim();
    if (!imageId || !imageHash) continue;
    const group = byHash.get(imageHash) ?? [];
    group.push(row);
    byHash.set(imageHash, group);
  }
  const findings = [];
  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    const canonicalRows = group.filter((row) => row?.editorial_reuse_approved !== true);
    if (canonicalRows.length === 1) {
      const canonicalId = String(canonicalRows[0].image_id ?? "").trim();
      for (const row of group) {
        const imageId = String(row.image_id ?? "").trim();
        if (imageId === canonicalId) continue;
        if (row?.editorial_reuse_approved === true
          && String(row?.reuse_source_image_id ?? "").trim() === canonicalId) continue;
        findings.push({
          image_id: imageId,
          severity: "blocker",
          code: "scene_image_duplicate_hash",
          message: `${imageId} is byte-identical to ${canonicalId}.`,
        });
      }
      continue;
    }
    const ownerId = String(group[0].image_id ?? "").trim();
    for (const row of group.slice(1)) {
      const imageId = String(row.image_id ?? "").trim();
      findings.push({
        image_id: imageId,
        severity: "blocker",
        code: "scene_image_duplicate_hash",
        message: `${imageId} is byte-identical to ${ownerId}.`,
      });
    }
  }
  return findings;
}

function svgEscape(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function contactTile(row, width = 400, imageHeight = 225, labelHeight = 70) {
  const input = await sharp(row.image_path).resize({ width, height: imageHeight, fit: "contain", background: "#000000" }).png().toBuffer();
  const detail = [
    row.visual_job ?? row.shot_job ?? "",
    ...(row.risk_reasons ?? []),
  ].filter(Boolean).join(" | ");
  const label = `${row.image_id}  ${Number(row.start_sec ?? 0).toFixed(1)}s\n${String(detail).slice(0, 74)}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${labelHeight}">
    <rect width="100%" height="100%" fill="#111111"/>
    <text x="12" y="25" fill="#ffffff" font-family="Arial" font-size="17" font-weight="700">${svgEscape(label.split("\n")[0])}</text>
    <text x="12" y="51" fill="#d7d7d7" font-family="Arial" font-size="15">${svgEscape(label.split("\n")[1] ?? "")}</text>
  </svg>`;
  return sharp({ create: { width, height: imageHeight + labelHeight, channels: 3, background: "#111111" } })
    .composite([{ input, top: 0, left: 0 }, { input: Buffer.from(svg), top: imageHeight, left: 0 }])
    .jpeg({ quality: 88 })
    .toBuffer();
}

async function writeContactSheet(rows, outputPath, { columns = 4, pageSize = 24 } = {}) {
  const pages = [];
  for (let offset = 0; offset < rows.length; offset += pageSize) {
    const pageRows = rows.slice(offset, offset + pageSize);
    const tileWidth = 400;
    const tileHeight = 295;
    const rowCount = Math.ceil(pageRows.length / columns);
    const composites = [];
    for (let index = 0; index < pageRows.length; index += 1) {
      composites.push({
        input: await contactTile(pageRows[index], tileWidth, 225, 70),
        left: (index % columns) * tileWidth,
        top: Math.floor(index / columns) * tileHeight,
      });
    }
    const pagePath = rows.length <= pageSize
      ? outputPath
      : outputPath.replace(/\.jpg$/i, `-page-${String(Math.floor(offset / pageSize) + 1).padStart(2, "0")}.jpg`);
    await fs.mkdir(path.dirname(pagePath), { recursive: true });
    await sharp({ create: { width: columns * tileWidth, height: Math.max(tileHeight, rowCount * tileHeight), channels: 3, background: "#080808" } })
      .composite(composites)
      .jpeg({ quality: 88 })
      .toFile(pagePath);
    pages.push(pagePath);
  }
  return pages;
}

async function structuralAudit(promptPlan, imagegenReport, focalAnalysis = null) {
  const resultById = new Map((imagegenReport?.results ?? []).map((row) => [String(row.image_id ?? ""), row]));
  const focalById = new Map((focalAnalysis?.analyses ?? []).map((row) => [String(row.image_id ?? ""), row]));
  const rows = [];
  const findings = [];
  const duplicateAuditRows = [];
  for (const prompt of promptPlan.prompts ?? []) {
    if (prompt.image_generation_required === false) continue;
    const imageId = String(prompt.image_id ?? "");
    const result = resultById.get(imageId);
    const imagePath = result?.image_path ?? null;
    if (!imagePath || !(await exists(imagePath))) {
      findings.push({ image_id: imageId, severity: "blocker", code: "scene_image_missing", message: `Missing generated image for ${imageId}.` });
      continue;
    }
    let metadata;
    try {
      metadata = await sharp(imagePath).metadata();
    } catch {
      findings.push({ image_id: imageId, severity: "blocker", code: "scene_image_unreadable", message: `Unreadable generated image for ${imageId}: ${imagePath}` });
      continue;
    }
    const width = Number(metadata.width ?? 0);
    const height = Number(metadata.height ?? 0);
    const aspect = height > 0 ? width / height : 0;
    if (!(width > height) || Math.abs(aspect - 16 / 9) > 0.08) {
      findings.push({ image_id: imageId, severity: "blocker", code: "scene_image_not_landscape", message: `${imageId} is ${width}x${height}; expected native 16:9 landscape.` });
    }
    const imageHash = await hashFile(imagePath);
    const sidecar = await readJson(`${imagePath}.metadata.json`, null);
    duplicateAuditRows.push({
      image_id: imageId,
      image_sha256: imageHash,
      editorial_reuse_approved: sidecar?.editorial_reuse_approved === true,
      reuse_source_image_id: sidecar?.reuse_source_image_id ?? null,
    });
    const donorFinding = donorRecoveryFinding(sidecar, imageId);
    if (donorFinding) findings.push(donorFinding);
    const focal = focalById.get(imageId) ?? null;
    const reviewPolicy = imageManualReviewPolicy(prompt, focal?.findings ?? [], {
      openingSec: openingReviewSec,
      integrationSampleRate,
    });
    rows.push({
      image_id: imageId,
      scene_id: prompt.scene_id ?? null,
      visual_beat_id: prompt.visual_beat_id ?? null,
      start_sec: Number(prompt.start_sec ?? 0),
      duration_sec: Number(prompt.duration_sec ?? 0),
      visual_job: prompt.visual_job ?? null,
      shot_job: prompt.shot_manifest?.shot_job ?? null,
      image_path: imagePath,
      image_sha256: imageHash,
      width,
      height,
      risk_reasons: reviewPolicy.reasons,
      qa_tier: reviewPolicy.tier,
      deterministic_sample: reviewPolicy.sampled,
      requires_manual_risk_review: reviewPolicy.requires_manual_review,
      focal_anchor: focal?.focal_anchor ?? null,
      focal_confidence: focal?.confidence ?? null,
      composition_findings: focal?.findings ?? [],
    });
  }
  findings.push(...duplicateHashFindingsForRows(duplicateAuditRows));
  return { rows, findings };
}

async function writeReviewPackets(rows) {
  await fs.mkdir(reviewDir, { recursive: true });
  const allSheets = [];
  if (writeFullContactSheets) {
    const maxStart = Math.max(0, ...rows.map((row) => row.start_sec));
    for (let start = 0; start <= maxStart; start += contactWindowSec) {
      const windowRows = rows.filter((row) => row.start_sec >= start && row.start_sec < start + contactWindowSec);
      if (!windowRows.length) continue;
      const name = `contact_${String(Math.floor(start / 60)).padStart(3, "0")}-${String(Math.ceil((start + contactWindowSec) / 60)).padStart(3, "0")}min.jpg`;
      allSheets.push(...await writeContactSheet(windowRows, path.join(reviewDir, name)));
    }
  }
  const riskRows = rows.filter((row) => row.requires_manual_risk_review);
  const riskSheets = riskRows.length ? await writeContactSheet(riskRows, path.join(reviewDir, "risk_cuts.jpg")) : [];
  const advisoryRows = rows.filter((row) => row.qa_tier === "advisory_review_log");
  const advisorySheets = advisoryRows.length ? await writeContactSheet(advisoryRows, path.join(reviewDir, "advisory_risk_cuts.jpg")) : [];
  return { all_sheets: allSheets, risk_sheets: riskSheets, advisory_risk_sheets: advisorySheets };
}

export function applyImageQaDecisionsToLedger(ledger, rows, decisionLedger, structuralBlockerIds, note, now = new Date().toISOString()) {
  if (!ledger?.cuts?.length) return { ledger, invalidated_motion_image_ids: [] };
  const rowById = new Map(rows.map((row) => [row.image_id, row]));
  const decisionById = new Map((decisionLedger?.decisions ?? []).map((row) => [row.image_id, row]));
  const invalidatedMotionIds = [];
  const cuts = ledger.cuts.map((cut) => {
    const row = rowById.get(String(cut.image_id ?? ""));
    if (!row || (cut.image_sha256 && cut.image_sha256 !== row.image_sha256)) return cut;
    const decision = decisionById.get(row.image_id)?.decision ?? (row.requires_manual_risk_review ? "not_inspected" : "accepted");
    const structuralReject = structuralBlockerIds.has(row.image_id);
    const aestheticReplacementRequested = decision === "rejected" && !structuralReject;
    if (structuralReject && (cut.motion_profile_hash || cut.motion_clip_path || cut.motion_clip_sha256)) invalidatedMotionIds.push(row.image_id);
    const imageQaStatus = structuralReject
      ? "rejected"
      : aestheticReplacementRequested
        ? "passed_with_aesthetic_advisory"
      : row.requires_manual_risk_review
        ? decision === "accepted" ? "passed_manual_risk" : "pending_manual_risk"
        : "passed_structural";
    return {
      ...cut,
      image_path: row.image_path,
      image_sha256: row.image_sha256,
      image_qa_status: imageQaStatus,
      image_qa_note: structuralReject
        ? "Critical structural image failure; repair this exact cut only."
        : aestheticReplacementRequested
          ? "Aesthetic replacement requested; current usable image remains non-blocking."
          : note,
      image_qa_reviewed_at: imageQaStatus.startsWith("passed") || structuralReject ? now : null,
      motion_profile_hash: structuralReject ? null : cut.motion_profile_hash ?? null,
      motion_clip_path: structuralReject ? null : cut.motion_clip_path ?? null,
      motion_clip_sha256: structuralReject ? null : cut.motion_clip_sha256 ?? null,
    };
  });
  const updated = {
    ...ledger,
    image_output_qa_report_path: outputPath,
    pending_image_qa_count: cuts.filter((cut) => !String(cut.image_qa_status ?? "").startsWith("passed")).length,
    cuts,
    updated_at: now,
  };
  return { ledger: updated, invalidated_motion_image_ids: [...new Set(invalidatedMotionIds)] };
}

async function updateLedgerQa(rows, decisionLedger, structuralBlockerIds, note) {
  const ledger = await readJson(ledgerPath, null);
  if (!ledger?.cuts?.length) return null;
  const result = applyImageQaDecisionsToLedger(ledger, rows, decisionLedger, structuralBlockerIds, note);
  const updated = result.ledger;
  await writeJson(ledgerPath, updated);
  return result;
}

function isCodexRoute(value) {
  return /codex/i.test(String(value ?? ""));
}

export function scopedQaRecoveryCommand(imageIds, promptPlan, imagegenReport, runIdentity) {
  const promptById = new Map((promptPlan.prompts ?? []).map((prompt) => [String(prompt.image_id ?? ""), prompt]));
  const resultById = new Map((imagegenReport.results ?? []).map((row) => [String(row.image_id ?? ""), row]));
  const codexIds = [];
  const modelslabIds = [];
  for (const imageId of imageIds) {
    const route = resultById.get(imageId)?.image_provider
      ?? resultById.get(imageId)?.image_provider_route
      ?? promptById.get(imageId)?.image_provider_route
      ?? promptById.get(imageId)?.provider
      ?? "modelslab";
    (isCodexRoute(route) ? codexIds : modelslabIds).push(imageId);
  }
  const provider = String(runIdentity?.image_provider ?? imagegenReport.image_provider ?? "modelslab");
  const base = `--channel ${channel} --series ${series} --week ${week} --episode ${episode}`;
  const commands = [];
  if (codexIds.length) {
    commands.push(`node bin/goldflow.mjs imagegen codex-work ${base} --action create --prompts <episode-dir>/section_image_prompts_hardened.json --image-ids ${codexIds.join(",")} --qa-recovery true --max-attempts 1 --lease-sec 900`);
  }
  if (modelslabIds.length) {
    const providerFilter = /hybrid/i.test(provider) ? " --provider-filter modelslab" : "";
    commands.push(`node bin/goldflow.mjs imagegen start ${base} --image-provider ${provider} --prompts <episode-dir>/section_image_prompts_hardened.json --skip-reference-generation true --cut-ids ${modelslabIds.join(",")} --force-images true --qa-recovery true${providerFilter} --concurrency 15`);
  }
  return commands.join("; then ");
}

export function imageQaNeedsRecovery(structuralBlockers = [], rejectedDecisionIds = []) {
  // Aesthetic dislikes may request a later replacement but do not invalidate a
  // readable, hash-bound cut. Only structural failures require repair.
  return structuralBlockers.length > 0;
}

export function acceptedImageHashesForRows(rows = [], structuralBlockerIds = new Set()) {
  return Object.fromEntries(
    rows
      .filter((row) => !structuralBlockerIds.has(row.image_id))
      .map((row) => [row.image_id, row.image_sha256]),
  );
}

async function main() {
  const [promptPlan, imagegenReport, runIdentity, focalAnalysis] = await Promise.all([
    readJson(promptPath, null),
    readJson(imagegenReportPath, null),
    readJson(runIdentityPath, {}),
    readJson(focalAnalysisPath, null),
  ]);
  if (promptPlan?.status !== "passed" || !Array.isArray(promptPlan.prompts)) throw new Error(`Missing passed prompt plan: ${promptPath}`);
  if (imagegenReport?.status !== "passed" || !Array.isArray(imagegenReport.results)) throw new Error(`Missing passed imagegen report: ${imagegenReportPath}`);
  const isV2 = runIdentity?.schema === "goldflow_run_identity_v2" || runIdentity?.run_identity_schema === "goldflow_run_identity_v2";
  const focalRequired = isV2 && String(runIdentity.stage_registry_version ?? "") >= "2026-07-12.2";
  if (focalRequired && focalAnalysis?.status !== "passed") throw new Error(`Image QA requires passed hash-bound focal analysis: ${focalAnalysisPath}`);
  if (focalAnalysis?.status === "passed") {
    if (focalAnalysis.prompt_plan_sha256 !== await hashFile(promptPath) || focalAnalysis.imagegen_report_sha256 !== await hashFile(imagegenReportPath)) {
      throw new Error(`Image focal analysis is stale; rerun imagegen analyze: ${focalAnalysisPath}`);
    }
  }
  if (approve && isV2 && !legacyBulkApproval) {
    throw new Error(`Per-cut review required for v2 runs. Edit ${reviewDecisionsPath} or use --accept-cut-ids/--reject-cut-ids with --reviewer and --note. --approve true is legacy-only.`);
  }
  if ((approve || acceptedIds.size || rejectedIds.size || criticalRejectedIds.size) && (!reviewer || !reviewNote)) {
    throw new Error("Image decisions require --reviewer and --note so output QA has review provenance.");
  }

  const audit = await structuralAudit(promptPlan, imagegenReport, focalAnalysis);
  const packets = await writeReviewPackets(audit.rows);
  const currentImageIds = new Set(audit.rows.map((row) => row.image_id));
  const unknownCriticalIds = [...criticalRejectedIds].filter((imageId) => !currentImageIds.has(imageId));
  if (unknownCriticalIds.length) {
    throw new Error(`Critical rejection ids are not current readable cuts: ${unknownCriticalIds.join(", ")}`);
  }
  for (const imageId of criticalRejectedIds) {
    audit.findings.push({
      image_id: imageId,
      severity: "blocker",
      code: "operator_confirmed_story_or_identity_failure",
      message: `${imageId} was explicitly classified as a story-critical or identity-critical failure by ${reviewer}: ${reviewNote}`,
    });
  }
  const structuralBlockers = audit.findings.filter((finding) => finding.severity === "blocker");
  const riskIds = new Set(audit.rows.filter((row) => row.requires_manual_risk_review).map((row) => row.image_id));
  const unknownDecisionIds = [...new Set([...acceptedIds, ...rejectedIds])].filter((imageId) => !currentImageIds.has(imageId));
  if (unknownDecisionIds.length) throw new Error(`Decision ids are not current readable cuts: ${unknownDecisionIds.join(", ")}`);
  const priorDecisions = await readJson(reviewDecisionsPath, {});
  const decisionLedger = mergeRiskReviewDecisions(audit.rows, priorDecisions, {
    reviewer,
    note: reviewNote,
    acceptedIds: approve && legacyBulkApproval ? [...riskIds] : [...acceptedIds],
    rejectedIds: [...rejectedIds],
    preserveUnseen: incrementalPacket,
  });
  if (decisionLedger.decisions.some((row) => row.decision !== "not_inspected") && (!decisionLedger.reviewer || !decisionLedger.note)) {
    throw new Error(`Accepted/rejected decisions in ${reviewDecisionsPath} require top-level reviewer and note.`);
  }
  const contactSheets = incrementalPacket
    ? {
        all_sheets: [...new Set([
          ...(priorDecisions?.contact_sheets?.all_sheets ?? []),
          ...packets.all_sheets,
        ])],
        risk_sheets: [...new Set([
          ...(priorDecisions?.contact_sheets?.risk_sheets ?? []),
          ...packets.risk_sheets,
        ])],
        advisory_risk_sheets: [...new Set([
          ...(priorDecisions?.contact_sheets?.advisory_risk_sheets ?? []),
          ...packets.advisory_risk_sheets,
        ])],
      }
    : packets;
  await writeJsonAtomic(reviewDecisionsPath, { ...decisionLedger, contact_sheets: contactSheets });
  const structuralBlockerIds = new Set(structuralBlockers.map((finding) => finding.image_id).filter(Boolean));
  const rejectedDecisionIds = decisionLedger.decisions.filter((row) => row.decision === "rejected").map((row) => row.image_id);
  const notInspectedIds = decisionLedger.decisions.filter((row) => row.decision === "not_inspected").map((row) => row.image_id);
  const recoveryRequired = imageQaNeedsRecovery(structuralBlockers, rejectedDecisionIds);
  const status = structuralBlockers.length
    ? "blocked"
    : notInspectedIds.length
      ? "needs_manual_review"
      : "passed";
  const failedImageIds = [...structuralBlockerIds].filter(Boolean);
  const ledgerUpdate = updateCutLedger
    ? await updateLedgerQa(audit.rows, decisionLedger, structuralBlockerIds, decisionLedger.note || null)
    : null;
  const acceptedRows = audit.rows.filter((row) => !structuralBlockerIds.has(row.image_id));
  const acceptedImageHashes = acceptedImageHashesForRows(audit.rows, structuralBlockerIds);
  const report = {
    schema: incrementalPacket ? "goldflow_incremental_image_output_qa_v1" : "goldflow_image_output_qa_v2",
    status,
    channel,
    series_slug: series,
    week,
    episode,
    prompt_plan_path: promptPath,
    prompt_plan_sha256: await hashFile(promptPath),
    imagegen_report_path: imagegenReportPath,
    imagegen_report_sha256: await hashFile(imagegenReportPath),
    focal_analysis_path: focalAnalysis?.status === "passed" ? focalAnalysisPath : null,
    focal_analysis_sha256: focalAnalysis?.status === "passed" ? await hashFile(focalAnalysisPath) : null,
    image_generation_estimated_cost: imagegenReport.estimated_cost ?? null,
    provider_health_report_path: imagegenReport.provider_health_report_path ?? null,
    provider_circuit_open: imagegenReport.provider_circuit_open ?? false,
    cut_execution_ledger_path: ledgerPath,
    image_count: audit.rows.length,
    structurally_valid_count: acceptedRows.length,
    risk_cut_count: audit.rows.filter((row) => row.requires_manual_risk_review).length,
    advisory_risk_cut_count: audit.rows.filter((row) => row.qa_tier === "advisory_review_log").length,
    qa_policy: {
      mode: "exception_driven_v1",
      opening_review_sec: openingReviewSec,
      integration_sample_rate: integrationSampleRate,
      full_contact_sheets_enabled: writeFullContactSheets,
      manual_review_tiers: [],
      advisory_review_tiers: ["advisory_review_log"],
      structural_auto_pass_count: audit.rows.filter((row) => row.qa_tier === "structural_auto_pass").length,
      advisory_review_log_count: audit.rows.filter((row) => row.qa_tier === "advisory_review_log").length,
      mandatory_exception_review_count: 0,
      deterministic_sample_count: audit.rows.filter((row) => row.deterministic_sample).length,
      review_reason_counts: audit.rows.flatMap((row) => row.risk_reasons ?? []).reduce((counts, reason) => ({ ...counts, [reason]: (counts[reason] ?? 0) + 1 }), {}),
    },
    unique_raster_count: new Set(audit.rows.map((row) => row.image_sha256)).size,
    editorial_reuse_cut_count: audit.rows.length - new Set(audit.rows.map((row) => row.image_sha256)).size,
    opening_review_sec: openingReviewSec,
    findings: audit.findings,
    unresolved_blocker_count: structuralBlockers.length,
    rejected_image_ids: rejectedDecisionIds,
    aesthetic_replacement_requested_image_ids: rejectedDecisionIds,
    critical_rejected_image_ids: [...criticalRejectedIds],
    not_inspected_image_ids: notInspectedIds,
    manual_review_required: notInspectedIds.length > 0,
    review_decisions_path: reviewDecisionsPath,
    review_decisions_sha256: await hashFile(reviewDecisionsPath),
    review_decision_counts: decisionLedger.counts,
    invalidated_motion_image_ids: ledgerUpdate?.invalidated_motion_image_ids ?? [],
    review_packets: contactSheets,
    accepted_image_hashes: acceptedImageHashes,
    preserved_passed_image_count: acceptedRows.length,
    incremental_packet: incrementalPacket,
    incremental_accepted_images: incrementalPacket
      ? acceptedRows.map((row) => ({
          image_id: row.image_id,
          image_path: row.image_path,
          image_sha256: row.image_sha256,
          start_sec: row.start_sec,
          qa_tier: row.qa_tier,
        }))
      : [],
    generated_text_accuracy_checked: false,
    generated_text_accuracy_policy: "out_of_scope_by_operator_direction",
    next_command: recoveryRequired
      ? scopedQaRecoveryCommand(failedImageIds, promptPlan, imagegenReport, runIdentity)
      : status === "needs_manual_review"
        ? `Inspect ${packets.risk_sheets.join(", ")}; record each risk-cut decision in ${reviewDecisionsPath}; then rerun imagegen qa`
        : null,
    updated_at: new Date().toISOString(),
  };
  await writeJson(outputPath, report);
  console.log(JSON.stringify({ status, report_path: outputPath, image_count: report.image_count, risk_cut_count: report.risk_cut_count, unresolved_blocker_count: report.unresolved_blocker_count, review_packets: packets }, null, 2));
  if (!incrementalPacket && status !== "passed") process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    await writeJson(outputPath, { schema: "goldflow_image_output_qa_v2", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() }).catch(() => {});
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
