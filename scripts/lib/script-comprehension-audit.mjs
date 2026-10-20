import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  POWER_SYSTEM_COMPREHENSION_SCHEMA,
  materializePowerSystemComprehensionAudit,
  validatePowerSystemComprehensionAudit,
} from "./power-system-comprehension-contract.mjs";
import { parseJsonObjectFromPlannerOutput } from "./json-output-repair.mjs";
import { assertEpisodeBudget, episodeBudgetFor } from "./episode-budget.mjs";

// The registered `script_comprehension_audit` stage (registry ≥ 2026-10-20.1): exactly one
// budgeted planner call through the codex-cli-runner call layer under the identity-locked
// planner, then the existing deterministic validator. A blocked audit is written as the triage
// evidence and holds; nothing re-calls the planner or edits the script. The same prompt is the
// one the autopilot gate authors a candidate with, so both paths produce identical candidates.
export const SCRIPT_COMPREHENSION_AUDIT_STAGE = "script_comprehension_audit";
export const SCRIPT_COMPREHENSION_AUDIT_REVIEWER = "automated:planner_comprehension_audit_v1";
export const SCRIPT_COMPREHENSION_AUDIT_MAX_SCRIPT_CHARS = 120_000;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const truncate = (text, max) => (text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text);

export const COMPREHENSION_AUDIT_REVIEW_RULES = [
  "You are Goldflow's automated production reviewer. Judge only what is asked.",
  "Never invent facts. Return exactly one JSON object and nothing else.",
].join("\n");

export async function comprehensionContractSource() {
  return fs.readFile(new URL("./power-system-comprehension-contract.mjs", import.meta.url), "utf8");
}

export function comprehensionAuditPrompt({ script, contractSource, rules = COMPREHENSION_AUDIT_REVIEW_RULES }) {
  return `${rules}\nAuthor a power-system comprehension audit candidate for this exact script. The candidate is validated by the JavaScript contract below (schema ${POWER_SYSTEM_COMPREHENSION_SCHEMA}); return only the candidate object with power_system_present, no_power_system_rationale (when false) and abilities. Every exact_excerpt must be copied verbatim from the script; offsets are computed for you.\n\nCONTRACT:\n${contractSource}\n\nSCRIPT:\n${truncate(script, SCRIPT_COMPREHENSION_AUDIT_MAX_SCRIPT_CHARS)}`;
}

// Offsets are deterministic: the first verbatim occurrence of each exact_excerpt.
export function fillAnchorOffsets(value, script) {
  if (Array.isArray(value)) return value.map((row) => fillAnchorOffsets(row, script));
  if (!value || typeof value !== "object") return value;
  const out = Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, fillAnchorOffsets(inner, script)]));
  if (typeof out.exact_excerpt === "string") {
    const start = script.indexOf(out.exact_excerpt.trim());
    if (start >= 0) Object.assign(out, { exact_excerpt: out.exact_excerpt.trim(), start_offset: start, end_offset: start + out.exact_excerpt.trim().length });
  }
  return out;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function defaultExecutor({ prompt, stageName, outputPath, repoRoot }) {
  const { runCodexCli } = await import("./codex-cli-runner.mjs");
  return runCodexCli({ prompt, stageName, repoRoot, outputPath, verbosity: "low", extraArgs: ["--sandbox", "read-only"] });
}

function callReceipt(result, outputPath, promptHash) {
  return {
    provider: result?.provider ?? null,
    transport: result?.transport ?? null,
    model: result?.model ?? null,
    reasoning_effort: result?.reasoning_effort ?? null,
    prompt_sha256: promptHash,
    output_path: outputPath,
    output_sha256: result?.output_sha256 ?? (typeof result?.content === "string" ? sha256(result.content) : null),
    metadata_path: `${outputPath}.meta.json`,
    started_at: result?.started_at ?? null,
    completed_at: result?.completed_at ?? null,
    call_count: 1,
    retry_policy: "none: a failed or blocked audit holds for triage",
  };
}

/**
 * Runs the registered stage. Returns { status: "passed" | "blocked" | "already_passed" | "held", audit, auditPath, call }.
 * executor({ prompt, stageName, outputPath, repoRoot }) → { content, provider, model, ... } (runCodexCli's contract).
 */
export async function authorScriptComprehensionAudit({
  episodeDir,
  scriptPath = path.join(episodeDir, "script_clean.md"),
  auditPath = path.join(episodeDir, "power_system_comprehension_audit.json"),
  executor = defaultExecutor,
  reviewedBy = SCRIPT_COMPREHENSION_AUDIT_REVIEWER,
  repoRoot = REPO_ROOT,
  now = () => new Date().toISOString(),
} = {}) {
  const script = await fs.readFile(scriptPath, "utf8");
  const scriptHash = sha256(script);
  const existing = await readJson(auditPath);
  if (existing && existing.source_script_hash === scriptHash) {
    const validation = validatePowerSystemComprehensionAudit(existing, script);
    if (existing.status === "passed" && validation.status === "passed") {
      return { status: "already_passed", audit: existing, auditPath, call: null, scriptHash };
    }
    return {
      status: "held",
      audit: existing,
      auditPath,
      call: null,
      scriptHash,
      reason: `power_system_comprehension_audit.json for this exact script is ${existing.status ?? "unknown"} (${[...new Set(validation.blockers.map((row) => row.code))].slice(0, 6).join(", ") || "artifact status"}); held for triage, no automatic planner re-call. Resolve the triage (operator-released editorial exception or a new script hash) before approval.`,
    };
  }
  const identity = await readJson(path.join(episodeDir, "run_identity.json")) ?? {};
  // One budgeted call: a locked episode budget records a $0-estimate authorization receipt
  // (planner CLI calls are subscription-metered); the episode cap check still runs.
  const budget = episodeBudgetFor(identity)
    ? await assertEpisodeBudget({ episodeDir, identity, requestedUsd: 0, scope: SCRIPT_COMPREHENSION_AUDIT_STAGE, basis: "planner_cli_call_subscription_metered_zero_cash_estimate", now: now() })
    : { status: "not_locked" };
  const contractSource = await comprehensionContractSource();
  const prompt = comprehensionAuditPrompt({ script, contractSource });
  const promptHash = sha256(prompt);
  const outputPath = path.join(episodeDir, "_codex_calls", SCRIPT_COMPREHENSION_AUDIT_STAGE, `${scriptHash.slice(0, 16)}_${promptHash.slice(0, 8)}_response.txt`);
  const result = await executor({ prompt, stageName: SCRIPT_COMPREHENSION_AUDIT_STAGE, outputPath, repoRoot });
  const call = callReceipt(result, outputPath, promptHash);
  let candidate;
  try {
    const parsed = parseJsonObjectFromPlannerOutput(result?.content ?? "");
    candidate = parsed.value;
    call.syntax_repair = parsed.syntax_repair ?? null;
  } catch (error) {
    candidate = null;
    call.parse_error = error instanceof Error ? error.message : String(error);
  }
  const audit = {
    ...materializePowerSystemComprehensionAudit(candidate ? fillAnchorOffsets(candidate, script) : { power_system_present: null, abilities: [] }, script, {
      sourceScriptPath: scriptPath,
      reviewedBy,
      reviewedAt: now(),
    }),
    stage: SCRIPT_COMPREHENSION_AUDIT_STAGE,
    authoring: "registered_planner_stage_v1",
    planner_call: call,
    episode_budget_authorization: budget,
    candidate_path: null,
  };
  const candidatePath = path.join(episodeDir, "_codex_calls", SCRIPT_COMPREHENSION_AUDIT_STAGE, `${scriptHash.slice(0, 16)}_candidate.json`);
  if (candidate) {
    await writeJson(candidatePath, fillAnchorOffsets(candidate, script));
    audit.candidate_path = candidatePath;
  }
  await writeJson(auditPath, audit);
  return { status: audit.status, audit, auditPath, call, scriptHash };
}
