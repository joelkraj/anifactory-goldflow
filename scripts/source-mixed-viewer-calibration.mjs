#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DEFAULT_MIXED_VIEWER_CALIBRATION_THRESHOLDS,
  MIXED_VIEWER_CALIBRATION_APPROVAL_SCHEMA,
  buildMixedViewerCalibrationPolicy,
  mixedViewerCalibrationApprovalSha256,
  validateMixedViewerCalibrationPolicy,
} from "./lib/source-mixed-viewer-calibration-contract.mjs";

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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function main() {
  const flags = flagsFrom(process.argv.slice(2));
  if (!flags["learning-ledger"] || !flags["output-dir"]) {
    throw new Error("Use --learning-ledger <source_learning_ledger.json> --output-dir <dir> [--approve-by <operator>].");
  }
  const ledgerPath = path.resolve(flags["learning-ledger"]);
  const outputDir = path.resolve(flags["output-dir"]);
  const ledgerBytes = await fs.readFile(ledgerPath);
  const ledger = JSON.parse(ledgerBytes.toString("utf8"));
  if (ledger?.schema !== "goldflow_source_learning_ledger_v1" || ledger?.status !== "observational") {
    throw new Error("Mixed-viewer calibration requires a valid observational source learning ledger.");
  }
  const ledgerSha256 = sha256(ledgerBytes);
  const prepared = buildMixedViewerCalibrationPolicy({
    learningLedger: ledger,
    learningLedgerSha256: ledgerSha256,
  });
  let approval = null;
  const approvedBy = String(flags["approve-by"] ?? "").trim();
  if (approvedBy) {
    if (!prepared.calibration_passed) {
      throw new Error(`Calibration thresholds have not passed: ${prepared.threshold_checks.filter((row) => !row.passed).map((row) => row.id).join(", ")}`);
    }
    const approvalBase = {
      schema: MIXED_VIEWER_CALIBRATION_APPROVAL_SCHEMA,
      status: "approved",
      production_mode: "calibrated_decision_support",
      learning_ledger_path: ledgerPath,
      learning_ledger_sha256: ledgerSha256,
      threshold_policy: DEFAULT_MIXED_VIEWER_CALIBRATION_THRESHOLDS,
      threshold_policy_sha256: prepared.threshold_policy_sha256,
      approved_by: approvedBy,
      approved_at: new Date().toISOString(),
      attestation: "reviewed_multi_episode_prediction_errors_and_approved_robust_mixed_majority_as_decision_support",
    };
    approval = {
      ...approvalBase,
      approval_sha256: mixedViewerCalibrationApprovalSha256(approvalBase),
    };
    await writeAtomic(path.join(outputDir, "calibration_promotion_approval.json"), approval);
  }
  const policy = buildMixedViewerCalibrationPolicy({
    learningLedger: ledger,
    learningLedgerSha256: ledgerSha256,
    approval,
    createdAt: prepared.created_at,
  });
  const validation = validateMixedViewerCalibrationPolicy(policy, { learningLedgerSha256: ledgerSha256 });
  if (!validation.done) throw new Error(`Calibration policy blocked: ${validation.blockers.join(", ")}`);
  const policyPath = path.join(outputDir, "calibration_policy.json");
  await writeAtomic(policyPath, policy);
  console.log(JSON.stringify({
    status: policy.status,
    production_mode: policy.production_mode,
    policy_path: policyPath,
    approval_path: approval ? path.join(outputDir, "calibration_promotion_approval.json") : null,
    failed_thresholds: policy.threshold_checks.filter((row) => !row.passed).map((row) => row.id),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
