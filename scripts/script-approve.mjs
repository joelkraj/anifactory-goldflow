#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { scanScriptMetaContamination } from "./lib/script-meta-contamination-scan.mjs";
import { validatePowerSystemComprehensionAudit } from "./lib/power-system-comprehension-contract.mjs";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeDir = path.resolve(flags["episode-dir"] ?? path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode));
const scriptPath = path.join(episodeDir, "script_clean.md");
const powerAuditPath = path.resolve(flags["power-system-audit"] ?? path.join(episodeDir, "power_system_comprehension_audit.json"));
const acceptPowerSystemEditorialRisk = flags["accept-power-system-editorial-risk"] === "true";
const powerSystemEditorialReason = String(flags["power-system-editorial-reason"] ?? "").trim();

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

async function main() {
  const script = await fs.readFile(scriptPath, "utf8");
  const scriptHash = sha256(script);
  const expectedHash = flags.hash ?? flags["script-hash"] ?? null;
  if (expectedHash && expectedHash !== scriptHash) {
    throw new Error(`Refusing approval: expected hash ${expectedHash}, current script hash is ${scriptHash}.`);
  }
  if (acceptPowerSystemEditorialRisk) {
    if (!/^[a-f0-9]{64}$/.test(String(flags.hash ?? ""))) {
      throw new Error("Power-system editorial acceptance requires --hash <exact current script SHA-256>.");
    }
    if (powerSystemEditorialReason.replace(/\s+/g, " ").length < 40) {
      throw new Error("Power-system editorial acceptance requires --power-system-editorial-reason with at least 40 characters describing the operator's exact-source release and accepted editorial risk.");
    }
  } else if (powerSystemEditorialReason) {
    throw new Error("--power-system-editorial-reason requires --accept-power-system-editorial-risk true.");
  }
  const metaScan = {
    ...scanScriptMetaContamination(script),
    source_script_hash: scriptHash,
    source_script_path: scriptPath,
    updated_at: new Date().toISOString(),
  };
  await writeJson(path.join(episodeDir, "script_meta_contamination_report.json"), metaScan);
  if (metaScan.status !== "passed" && flags["allow-script-meta-contamination"] !== "true") {
    const preview = metaScan.blockers.slice(0, 5).map((row) => `${row.code} line ${row.line}: ${row.match}`).join("; ");
    throw new Error(`Refusing approval: script contains production/meta narration contamination (${preview}). Fix script_clean.md or pass --allow-script-meta-contamination true only for explicit diagnostic approval.`);
  }
  let powerAuditBytes = null;
  try {
    powerAuditBytes = await fs.readFile(powerAuditPath);
  } catch (error) {
    if (error?.code === "ENOENT" && !acceptPowerSystemEditorialRisk) {
      throw new Error(`Refusing approval: required power-system comprehension audit is missing at ${powerAuditPath}. Run scripts/power-system-comprehension-audit.mjs before script approval.`);
    }
    if (error?.code !== "ENOENT") {
      throw new Error(`Refusing approval: power-system comprehension audit is unreadable at ${powerAuditPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let powerAudit = null;
  if (powerAuditBytes) {
    try {
      powerAudit = JSON.parse(powerAuditBytes.toString("utf8"));
    } catch (error) {
      throw new Error(`Refusing approval: power-system comprehension audit is unreadable at ${powerAuditPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const powerAuditValidation = powerAuditBytes
    ? validatePowerSystemComprehensionAudit(powerAudit, script)
    : null;
  if (!acceptPowerSystemEditorialRisk
    && (powerAudit?.status !== "passed" || powerAuditValidation?.status !== "passed")) {
    const preview = powerAuditValidation?.blockers.slice(0, 8).map((row) => `${row.code}${row.ability_id ? ` (${row.ability_id})` : ""}`).join("; ");
    throw new Error(`Refusing approval: power-system comprehension audit is missing, stale, or blocked (${preview || `artifact status ${powerAudit?.status ?? "missing"}`}).`);
  }
  const powerAuditHash = powerAuditBytes ? sha256(powerAuditBytes) : null;
  const approvedAt = new Date().toISOString();
  const powerSystemEditorialException = acceptPowerSystemEditorialRisk ? {
    schema: "goldflow_power_system_editorial_exception_v1",
    status: powerAuditBytes
      ? "existing_audit_preserved_editorial_risk_accepted"
      : "not_performed_operator_editorial_exception",
    approval_scope: "exact_script_hash",
    source_script_hash: scriptHash,
    operator_release_basis_and_editorial_risk: powerSystemEditorialReason,
    comprehension_audit_pass_claimed: false,
    existing_audit_path: powerAuditBytes ? powerAuditPath : null,
    existing_audit_sha256: powerAuditHash,
    existing_audit_status: powerAudit?.status ?? null,
    existing_audit_validation: powerAuditValidation,
    recorded_at: approvedAt,
  } : null;
  const base = {
    channel,
    series_slug: series,
    week,
    episode,
    script_clean_path: scriptPath,
    script_clean_hash: scriptHash,
    script_hash: scriptHash,
    source_hash: scriptHash,
    source_script_hash: scriptHash,
    power_system_comprehension_audit_path: powerAuditBytes ? powerAuditPath : null,
    power_system_comprehension_audit_hash: powerAuditHash,
    ...(powerSystemEditorialException ? { power_system_editorial_exception: powerSystemEditorialException } : {}),
    approved: true,
    operator_approved: true,
    status: "approved",
    updated_at: approvedAt,
  };
  const manualReview = {
    schema: "goldflow_manual_agent_script_review_v1",
    ...base,
    manual_agent_script_review: true,
    review_summary: flags.summary ?? "Operator confirmed script_clean.md is approved for production.",
  };
  const operatorApproval = {
    schema: "goldflow_operator_script_approval_v1",
    ...base,
    approval_status: "operator_approved",
    approval_scope: "exact_script_hash",
  };
  const scriptLock = {
    schema: "goldflow_script_lock_v1",
    ...base,
    status: "script_locked",
  };
  await writeJson(path.join(episodeDir, "manual_agent_script_review.json"), manualReview);
  await writeJson(path.join(episodeDir, "operator_script_approval.json"), operatorApproval);
  await writeJson(path.join(episodeDir, "script_lock.json"), scriptLock);
  console.log(JSON.stringify({ status: "approved", script_clean_hash: scriptHash, power_system_comprehension_audit_hash: powerAuditHash, ...(powerSystemEditorialException ? { power_system_editorial_exception: powerSystemEditorialException } : {}), files_written: ["script_meta_contamination_report.json", "manual_agent_script_review.json", "operator_script_approval.json", "script_lock.json"] }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
