#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { referencePlanApprovalContractSha256 } from "./lib/reference-plan-contract.mjs";

const flags = parseFlags(process.argv.slice(2));
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const REFERENCE_CLEANLINESS_CONTRACT_VERSION = "empty_hands_no_detachable_props_v1";
const SOURCE_ONLY_ORIGINS = new Set(["owned_source", "accepted_production_cut"]);
const PRODUCTION_CUT_REFERENCE_KINDS = new Set(["location", "prop", "ui"]);

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

function requiredFlag(name, value) {
  if (!value) throw new Error(`Missing required --${name}.`);
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

function normalizedText(value) {
  return String(value ?? "").trim();
}

function sourceOnlyReferencePath(target, planPath) {
  const rawPath = normalizedText(
    target.conditioning_image_path
    ?? target.reference_image_path
    ?? target.source_image_path
    ?? target.path,
  );
  if (!rawPath) return null;
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(path.dirname(planPath), rawPath);
}

function sourceOnlyCleanlinessStatus(target) {
  return normalizedText(
    target.cleanliness_status
    ?? target.reference_cleanliness_status
    ?? target.source_cleanliness_status
    ?? target.source_review_status,
  ).toLowerCase();
}

function sourceOnlyOrigin(target) {
  const origin = normalizedText(
    target.origin
    ?? target.reference_origin
    ?? target.source_origin
    ?? target.source_asset_origin,
  ).toLowerCase();
  if (["owned_source_face", "owned_clean_asset"].includes(origin)) return "owned_source";
  return origin;
}

function sourceOnlyReviewReceiptPath(target, planPath) {
  const rawPath = normalizedText(
    target.source_review_receipt_path
    ?? target.source_review_path
    ?? target.review_receipt_path,
  );
  if (!rawPath) return null;
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(path.dirname(planPath), rawPath);
}

function sourceOnlyQaReceiptPath(target, planPath) {
  const rawPath = normalizedText(
    target.source_image_qa_receipt_path
    ?? target.source_qa_receipt_path
    ?? target.accepted_production_cut?.image_qa_receipt_path,
  );
  if (!rawPath) return null;
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(path.dirname(planPath), rawPath);
}

function receiptRows(receipt) {
  const characterRows = Array.isArray(receipt?.characters) ? receipt.characters : [];
  return [
    ...(receipt && typeof receipt === "object" ? [receipt] : []),
    ...(Array.isArray(receipt?.source_face_anchors) ? receipt.source_face_anchors : []),
    ...(Array.isArray(receipt?.sourceFaceAnchors) ? receipt.sourceFaceAnchors : []),
    ...characterRows,
    ...characterRows.flatMap((row) => [row?.source_face_anchor, row?.sourceFaceAnchor].filter(Boolean).map((anchor) => ({ ...row, ...anchor }))),
    ...(Array.isArray(receipt?.source_references) ? receipt.source_references : []),
    ...(Array.isArray(receipt?.reference_decisions) ? receipt.reference_decisions : []),
    ...(Array.isArray(receipt?.cuts) ? receipt.cuts : []),
    ...(Array.isArray(receipt?.decisions) ? receipt.decisions : []),
    ...(Array.isArray(receipt?.rows) ? receipt.rows : []),
    ...(Array.isArray(receipt?.review_rows) ? receipt.review_rows : []),
  ].filter((row) => row && typeof row === "object");
}

function sourceCleanlinessReceiptDecision(receipt, { refId, sourceImageId, sourceImageSha256, origin }) {
  return receiptRows(receipt).find((row) => {
    const rowIds = [
      row?.ref_id,
      row?.source_image_id,
      row?.image_id,
      row?.cut_id,
      row?.source_cut_id,
    ].map(normalizedText).filter(Boolean);
    const idMatches = rowIds.includes(sourceImageId) || rowIds.includes(refId);
    const rowHash = normalizedText(
      row?.source_image_sha256
      ?? row?.image_sha256
      ?? row?.reference_image_sha256
      ?? row?.source_reference_sha256
      ?? row?.sha256,
    ).toLowerCase();
    const status = normalizedText(
      row?.cleanliness_status
      ?? row?.source_review_status
      ?? row?.reference_cleanliness_status
      ?? row?.decision
      ?? row?.review_decision
      ?? row?.status,
    ).toLowerCase();
    const clean = status === "approved_clean" || (origin === "owned_source" && row?.approved === true);
    return idMatches && rowHash === sourceImageSha256 && clean;
  }) ?? null;
}

function productionCutQaReceiptDecision(receipt, sourceImageId, sourceImageSha256) {
  const reportStatus = normalizedText(receipt?.status).toLowerCase();
  const reportPassed = /^passed(?:_|$)/.test(reportStatus);
  const acceptedHash = normalizedText(receipt?.accepted_image_hashes?.[sourceImageId]).toLowerCase();
  if (reportPassed && acceptedHash === sourceImageSha256) {
    return {
      image_id: sourceImageId,
      image_sha256: sourceImageSha256,
      image_qa_status: reportStatus,
      receipt_shape: "accepted_image_hashes",
    };
  }
  const rows = [
    ...(Array.isArray(receipt?.cuts) ? receipt.cuts : []),
    ...(Array.isArray(receipt?.decisions) ? receipt.decisions : []),
    ...(Array.isArray(receipt?.rows) ? receipt.rows : []),
    ...(Array.isArray(receipt?.review_rows) ? receipt.review_rows : []),
    ...(reportPassed && Array.isArray(receipt?.incremental_accepted_images) ? receipt.incremental_accepted_images : []),
  ];
  return rows.find((row) => {
    const rowId = normalizedText(row?.image_id ?? row?.cut_id ?? row?.source_image_id);
    const rowHash = normalizedText(row?.image_sha256 ?? row?.source_image_sha256 ?? row?.reference_image_sha256).toLowerCase();
    const qaStatus = normalizedText(row?.image_qa_status ?? row?.qa_status ?? row?.status ?? (reportPassed ? reportStatus : "")).toLowerCase();
    return rowId === sourceImageId && rowHash === sourceImageSha256 && /^passed(?:_|$)/.test(qaStatus);
  }) ?? null;
}

function sourceOnlyImageId(target) {
  return normalizedText(
    target.source_image_id
    ?? target.source_cut_id
    ?? target.accepted_production_cut?.image_id,
  );
}

function sourceOnlyImageQaStatus(target) {
  return normalizedText(
    target.source_image_qa_status
    ?? target.source_cut_qa_status
    ?? target.image_qa_status
    ?? target.accepted_production_cut?.image_qa_status
    ?? target.accepted_production_cut?.qa_status,
  ).toLowerCase();
}

function sourceOnlyDeclaredHash(target) {
  return normalizedText(
    target.source_image_sha256
    ?? target.source_cut_sha256
    ?? target.source_reference_sha256
    ?? target.accepted_production_cut?.source_image_sha256
    ?? target.accepted_production_cut?.image_sha256,
  ).toLowerCase();
}

async function sourceOnlyApprovalRows(targets, planPath) {
  const rows = [];
  for (const target of targets) {
    if (normalizedText(target.generation_mode).toLowerCase() !== "source_only") continue;
    const refId = normalizedText(target.ref_id) || "unknown_source_reference";
    const referencePath = sourceOnlyReferencePath(target, planPath);
    if (!referencePath) throw new Error(`Source-only reference ${refId} is missing a source reference path.`);
    let sourceReferenceHash;
    try {
      sourceReferenceHash = sha256(await fs.readFile(referencePath));
    } catch {
      throw new Error(`Source-only reference ${refId} does not exist or is unreadable: ${referencePath}`);
    }
    const cleanlinessStatus = sourceOnlyCleanlinessStatus(target);
    if (cleanlinessStatus !== "approved_clean") {
      throw new Error(`Source-only reference ${refId} must declare cleanliness_status=approved_clean.`);
    }
    const origin = sourceOnlyOrigin(target);
    if (!SOURCE_ONLY_ORIGINS.has(origin)) {
      throw new Error(`Source-only reference ${refId} must declare origin=owned_source or origin=accepted_production_cut.`);
    }
    const kind = normalizedText(target.kind).toLowerCase();
    const sourceImageId = sourceOnlyImageId(target);
    const sourceImageQaStatus = sourceOnlyImageQaStatus(target);
    const declaredSourceHash = sourceOnlyDeclaredHash(target);
    if (!/^[a-f0-9]{64}$/.test(declaredSourceHash)) {
      throw new Error(`Source-only reference ${refId} must declare its exact 64-character source_image_sha256.`);
    }
    if (declaredSourceHash !== sourceReferenceHash) {
      throw new Error(`Source-only reference ${refId} source_image_sha256 does not match ${referencePath}.`);
    }
    const sourceReviewReceiptPath = sourceOnlyReviewReceiptPath(target, planPath);
    if (!sourceReviewReceiptPath) {
      throw new Error(`Source-only reference ${refId} is missing source_review_receipt_path.`);
    }
    let sourceReviewReceiptHash;
    let sourceReviewReceipt;
    try {
      const receiptBytes = await fs.readFile(sourceReviewReceiptPath);
      sourceReviewReceiptHash = sha256(receiptBytes);
      sourceReviewReceipt = JSON.parse(receiptBytes.toString("utf8"));
    } catch {
      throw new Error(`Source-only reference ${refId} has a missing, unreadable, or non-JSON source review receipt: ${sourceReviewReceiptPath}`);
    }
    if (!sourceCleanlinessReceiptDecision(sourceReviewReceipt, {
      refId,
      sourceImageId,
      sourceImageSha256: sourceReferenceHash,
      origin,
    })) {
      throw new Error(`Source-only reference ${refId} is not approved_clean with the same source id and SHA-256 in ${sourceReviewReceiptPath}.`);
    }
    let sourceImageQaReceiptPath = null;
    let sourceImageQaReceiptHash = null;
    if (origin === "accepted_production_cut") {
      if (!PRODUCTION_CUT_REFERENCE_KINDS.has(kind)) {
        throw new Error(`Accepted production cut ${refId} may be promoted only as kind location, prop, or ui; received ${kind || "missing"}.`);
      }
      if (!sourceImageId) throw new Error(`Accepted production cut reference ${refId} is missing source_image_id.`);
      if (!/^passed(?:_|$)/.test(sourceImageQaStatus)) {
        throw new Error(`Accepted production cut reference ${refId} requires a passed source_image_qa_status.`);
      }
      sourceImageQaReceiptPath = sourceOnlyQaReceiptPath(target, planPath);
      if (!sourceImageQaReceiptPath) {
        throw new Error(`Accepted production cut reference ${refId} is missing source_image_qa_receipt_path.`);
      }
      let sourceImageQaReceipt;
      try {
        const receiptBytes = await fs.readFile(sourceImageQaReceiptPath);
        sourceImageQaReceiptHash = sha256(receiptBytes);
        sourceImageQaReceipt = JSON.parse(receiptBytes.toString("utf8"));
      } catch {
        throw new Error(`Accepted production cut reference ${refId} has a missing, unreadable, or non-JSON image-QA receipt: ${sourceImageQaReceiptPath}`);
      }
      if (!productionCutQaReceiptDecision(sourceImageQaReceipt, sourceImageId, sourceReferenceHash)) {
        throw new Error(`Accepted production cut reference ${refId} is not passed with the same image id and SHA-256 in ${sourceImageQaReceiptPath}.`);
      }
    }
    rows.push({
      ref_id: refId,
      kind: kind || null,
      origin,
      source_origin: origin,
      cleanliness_status: cleanlinessStatus,
      source_review_status: cleanlinessStatus,
      reference_image_path: referencePath,
      reference_image_sha256: sourceReferenceHash,
      source_reference_sha256: sourceReferenceHash,
      source_image_id: sourceImageId || null,
      source_image_qa_status: sourceImageQaStatus || null,
      declared_source_image_sha256: declaredSourceHash || null,
      source_review_receipt_path: sourceReviewReceiptPath,
      source_review_receipt_sha256: sourceReviewReceiptHash,
      source_image_qa_receipt_path: sourceImageQaReceiptPath,
      source_image_qa_receipt_sha256: sourceImageQaReceiptHash,
    });
  }
  return rows;
}

async function main() {
  const episodeDir = flags["episode-dir"]
    ? path.resolve(flags["episode-dir"])
    : (() => {
        requiredFlag("channel", flags.channel);
        requiredFlag("week", flags.week);
        requiredFlag("episode", flags.episode);
        return path.join(dataRoot, "channels", flags.channel, "weekly_runs", flags.week, "episodes", flags.episode);
      })();
  const episode = flags.episode ?? path.basename(episodeDir);
  const planPath = path.resolve(flags.plan ?? flags["reference-plan"] ?? path.join(episodeDir, "visual_reference_plan.json"));
  const plan = await readJson(planPath, null);
  if (plan?.status !== "passed") throw new Error(`Reference plan must be passed before approval: ${planPath}`);
  const blockers = (plan.findings ?? []).filter((finding) => finding.severity === "blocker");
  if (blockers.length) throw new Error(`Reference plan has ${blockers.length} unresolved blocker(s).`);
  const targets = Array.isArray(plan.reference_targets) ? plan.reference_targets : [];
  if (!targets.length) throw new Error("Reference plan has no selected targets.");
  const cleanlinessContractVersion = normalizedText(plan.reference_cleanliness_contract_version);
  if (cleanlinessContractVersion && cleanlinessContractVersion !== REFERENCE_CLEANLINESS_CONTRACT_VERSION) {
    throw new Error(`Unsupported reference_cleanliness_contract_version: ${cleanlinessContractVersion}`);
  }
  const sourceReferences = cleanlinessContractVersion === REFERENCE_CLEANLINESS_CONTRACT_VERSION
    ? await sourceOnlyApprovalRows(targets, planPath)
    : [];
  const sourceReferencesById = new Map(sourceReferences.map((row) => [row.ref_id, row]));
  const planHash = sha256(await fs.readFile(planPath));
  const planContractHash = referencePlanApprovalContractSha256(plan);
  const outputPath = path.resolve(flags.output ?? path.join(episodeDir, "reference_plan_approval.json"));
  const report = {
    schema: cleanlinessContractVersion === REFERENCE_CLEANLINESS_CONTRACT_VERSION
      ? "goldflow_reference_plan_approval_v3"
      : "goldflow_reference_plan_approval_v2",
    status: "approved",
    episode,
    visual_reference_plan_path: planPath,
    visual_reference_plan_sha256: planHash,
    reference_plan_contract_sha256: planContractHash,
    reference_director_contract_version: plan.reference_director_contract_version ?? null,
    ...(cleanlinessContractVersion === REFERENCE_CLEANLINESS_CONTRACT_VERSION ? {
      reference_cleanliness_contract_version: cleanlinessContractVersion,
      source_only_provenance_enforced: true,
    } : {}),
    selected_target_count: targets.length,
    selected_targets: targets.map((target) => ({
      ref_id: target.ref_id,
      kind: target.kind,
      generation_mode: target.generation_mode,
      scene_ids: target.scene_ids ?? [],
      conditioning_subject_count: target.conditioning_subject_count ?? null,
      conditioning_asset_role: target.conditioning_asset_role ?? null,
      ...(sourceReferencesById.has(String(target.ref_id ?? "")) ? {
        source_reference_origin: sourceReferencesById.get(String(target.ref_id)).origin,
        source_reference_sha256: sourceReferencesById.get(String(target.ref_id)).source_reference_sha256,
      } : {}),
    })),
    ...(cleanlinessContractVersion === REFERENCE_CLEANLINESS_CONTRACT_VERSION ? {
      source_reference_count: sourceReferences.length,
      source_reference_hashes: sourceReferences,
      source_reference_hash_by_ref_id: Object.fromEntries(
        sourceReferences.map((row) => [row.ref_id, row.source_reference_sha256]),
      ),
    } : {}),
    approved_by: flags["approved-by"] ?? "codex-agent",
    approval_note: flags.note ?? "Reference Director selection, evidence, scopes, and clean conditioning contracts reviewed before generation spend.",
    updated_at: new Date().toISOString(),
  };
  await writeJson(outputPath, report);
  console.log(JSON.stringify({
    status: "approved",
    approval_path: outputPath,
    selected_target_count: targets.length,
    ...(cleanlinessContractVersion === REFERENCE_CLEANLINESS_CONTRACT_VERSION ? {
      source_reference_count: sourceReferences.length,
      reference_cleanliness_contract_version: cleanlinessContractVersion,
    } : {}),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
