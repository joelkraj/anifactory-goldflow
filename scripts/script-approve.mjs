#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { scanScriptMetaContamination } from "./lib/script-meta-contamination-scan.mjs";
import { validatePowerSystemComprehensionAudit } from "./lib/power-system-comprehension-contract.mjs";
import { PIPELINE_STAGE_REGISTRY_VERSION, generatedRegistryVersionFor } from "./lib/pipeline-stage-registry.mjs";
import { buildScriptPaceReport } from "./lib/script-pace-diagnostics.mjs";
import { buildTargetedSpeakabilityArtifacts } from "./lib/script-speakability-targeted.mjs";

export const SCRIPT_LOCK_V2_SCHEMA = "goldflow_script_lock_v2";

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
    approved_by: String(flags["approved-by"] ?? "operator").trim() || "operator",
    status: "approved",
    updated_at: approvedAt,
  };
  const reviewSummary = flags.summary ?? "Operator confirmed script_clean.md is approved for production.";
  const identity = await readJson(path.join(episodeDir, "run_identity.json"));
  if (identity && generatedRegistryVersionFor(identity) === PIPELINE_STAGE_REGISTRY_VERSION) {
    const written = await writeFoldedScriptLock({ identity, script, scriptHash, base, reviewSummary, approvedAt });
    console.log(JSON.stringify({ status: "approved", lock_schema: SCRIPT_LOCK_V2_SCHEMA, script_clean_hash: scriptHash, power_system_comprehension_audit_hash: powerAuditHash, ...(powerSystemEditorialException ? { power_system_editorial_exception: powerSystemEditorialException } : {}), folded_validators: written.lock.folded_validators, files_written: written.files }, null, 2));
    return;
  }
  const manualReview = {
    schema: "goldflow_manual_agent_script_review_v1",
    ...base,
    manual_agent_script_review: true,
    review_summary: reviewSummary,
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

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

// A previous lock for a different script is archived, never overwritten in place.
async function archiveStaleLock(lockPath, scriptHash) {
  const existing = await readJson(lockPath);
  if (!existing || existing.script_clean_hash === scriptHash) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archivePath = path.join(episodeDir, "_archived_script_locks", `${stamp}-script_lock.json`);
  await fs.mkdir(path.dirname(archivePath), { recursive: true });
  await fs.copyFile(lockPath, archivePath);
  return archivePath;
}

// Registry ≥ 2026-10-20.1: one lock artifact (goldflow_script_lock_v2) carries the approval
// and the folded pace + targeted-speakability validators. The files those historical stages
// emitted (script_pace_report.json, script_speakability_report.json,
// tts_spoken_overrides.json, script_speakability_problem_areas_report.json) and the two
// approval files legacy readers load are written from the same lock as derived views.
async function writeFoldedScriptLock({ identity, script, scriptHash, base, reviewSummary, approvedAt }) {
  const identityChannel = identity.channel ?? channel;
  const identitySeries = identity.series_slug ?? series;
  const identityWeek = identity.week ?? week;
  const identityEpisode = identity.episode ?? episode;
  const paceReport = await buildScriptPaceReport({
    script,
    scriptPath,
    sourceScriptHash: scriptHash,
    channel: identityChannel,
    series: identitySeries,
    week: identityWeek,
    episode: identityEpisode,
    targetMinWpm: Number(identity.target_wpm_min ?? 180),
    targetMaxWpm: Number(identity.target_wpm_max ?? 195),
    requestedPacePolicy: identity.pace_policy ?? "diagnostic",
    allowHookWarnings: true,
    hookMilestonesPath: null,
    sourceHashes: { [scriptPath]: scriptHash },
    updatedAt: approvedAt,
  });
  const speakability = buildTargetedSpeakabilityArtifacts({
    script,
    scriptPath,
    scriptHash,
    channel: identityChannel,
    series: identitySeries,
    week: identityWeek,
    episode: identityEpisode,
    updatedAt: approvedAt,
  });
  const lockPath = path.join(episodeDir, "script_lock.json");
  const archivedLockPath = await archiveStaleLock(lockPath, scriptHash);
  const derived = {
    "script_pace_report.json": paceReport,
    "script_speakability_report.json": speakability.report,
    "tts_spoken_overrides.json": speakability.overrides,
    "script_speakability_problem_areas_report.json": speakability.problemReport,
  };
  const derivedHashes = Object.fromEntries(Object.entries(derived).map(([name, value]) => [name, sha256(`${JSON.stringify(value, null, 2)}\n`)]));
  const lock = {
    schema: SCRIPT_LOCK_V2_SCHEMA,
    ...base,
    status: "script_locked",
    approval_status: "operator_approved",
    approval_scope: "exact_script_hash",
    manual_agent_script_review: true,
    review_summary: reviewSummary,
    stage_registry_version: PIPELINE_STAGE_REGISTRY_VERSION,
    folded_validators: {
      policy: "script_pace_check and targeted_speakability run inside the script lock; their reports are derived from this lock and bound to the same script hash.",
      script_pace_check: {
        status: paceReport.status,
        validator: "script_pace_hash_and_policy",
        pace_policy: paceReport.pace_policy,
        pace_gate_enforced: paceReport.pace_gate_enforced,
        script_word_count: paceReport.script_word_count,
        estimated_runtime_at_target_mid_sec: paceReport.estimated_runtime_at_target_mid_sec,
        report_path: path.join(episodeDir, "script_pace_report.json"),
        report_sha256: derivedHashes["script_pace_report.json"],
      },
      targeted_speakability: {
        status: speakability.report.status,
        validator: "speakability_hashes",
        ruleset: speakability.report.ruleset,
        finding_count: speakability.findings.length,
        replacement_count: speakability.replacements.length,
        report_path: path.join(episodeDir, "script_speakability_report.json"),
        report_sha256: derivedHashes["script_speakability_report.json"],
        overrides_path: path.join(episodeDir, "tts_spoken_overrides.json"),
        overrides_sha256: derivedHashes["tts_spoken_overrides.json"],
      },
    },
    derived_views: {
      "operator_script_approval.json": "goldflow_operator_script_approval_v1",
      "manual_agent_script_review.json": "goldflow_manual_agent_script_review_v1",
      ...Object.fromEntries(Object.entries(derived).map(([name, value]) => [name, value.schema])),
    },
    archived_previous_lock_path: archivedLockPath,
  };
  const operatorApproval = {
    schema: "goldflow_operator_script_approval_v1",
    ...base,
    approval_status: "operator_approved",
    approval_scope: "exact_script_hash",
    derived_from: "script_lock.json",
    lock_schema: SCRIPT_LOCK_V2_SCHEMA,
  };
  const manualReview = {
    schema: "goldflow_manual_agent_script_review_v1",
    ...base,
    manual_agent_script_review: true,
    review_summary: reviewSummary,
    derived_from: "script_lock.json",
    lock_schema: SCRIPT_LOCK_V2_SCHEMA,
  };
  await writeJson(lockPath, lock);
  for (const [name, value] of Object.entries(derived)) await writeJson(path.join(episodeDir, name), value);
  await writeJson(path.join(episodeDir, "operator_script_approval.json"), operatorApproval);
  await writeJson(path.join(episodeDir, "manual_agent_script_review.json"), manualReview);
  return { lock, files: ["script_meta_contamination_report.json", "script_lock.json", ...Object.keys(derived), "operator_script_approval.json", "manual_agent_script_review.json"] };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
