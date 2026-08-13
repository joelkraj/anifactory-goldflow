#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256File } from "./lib/file-hash.mjs";

export const PROVIDER_QUOTA_PROOF_SCHEMA = "goldflow_provider_quota_proof_v1";
export const QUOTA_TEST_IDS = Object.freeze([
  "gemini_web_text",
  "gemini_web_image",
  "google_flow_image",
  "google_flow_video",
  "antigravity_planning",
]);

const action = process.argv[2] ?? "status";
const flags = parseFlags(process.argv.slice(3));

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

function clean(value) { return String(value ?? "").trim(); }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function required(name, value) { if (!clean(value)) throw new Error(`Missing required --${name}.`); }
async function readJson(filePath) { try { return JSON.parse(await fs.readFile(filePath, "utf8")); } catch { return null; } }
async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temp, filePath);
}
function proofPath() { return path.resolve(flags.output ?? flags.proof ?? "docs/proofs/google_product_quota_proof_v1.json"); }

function flattenNumbers(value, prefix = "", output = {}) {
  if (Number.isFinite(Number(value)) && value !== "") {
    output[prefix] = Number(value);
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) flattenNumbers(child, prefix ? `${prefix}.${key}` : key, output);
  }
  return output;
}

function counterDeltas(before, after) {
  const left = flattenNumbers(before);
  const right = flattenNumbers(after);
  return Object.fromEntries([...new Set([...Object.keys(left), ...Object.keys(right)])]
    .sort()
    .map((key) => [key, left[key] == null || right[key] == null ? null : Number((right[key] - left[key]).toFixed(6))]));
}

async function initialize() {
  const outputPath = proofPath();
  const existing = await readJson(outputPath);
  if (existing) throw new Error(`Quota proof already exists: ${outputPath}`);
  const artifact = {
    schema: PROVIDER_QUOTA_PROOF_SCHEMA,
    status: "incomplete",
    created_at: new Date().toISOString(),
    hypothesis: "Gemini Apps, Google Flow media, and Antigravity have distinct included product limits; purchased Google AI credits may act as shared overflow.",
    required_counter_groups: ["gemini_apps", "google_flow", "antigravity", "purchased_ai_credits"],
    tests: QUOTA_TEST_IDS.map((id) => ({ id, status: "pending", observation: null })),
    conclusion: null,
  };
  await writeJson(outputPath, artifact);
  console.log(JSON.stringify({ status: "passed", proof_path: outputPath, tests: QUOTA_TEST_IDS }, null, 2));
}

async function record() {
  const outputPath = proofPath();
  const artifact = await readJson(outputPath);
  if (artifact?.schema !== PROVIDER_QUOTA_PROOF_SCHEMA) throw new Error(`Initialize quota proof first: ${outputPath}`);
  required("test", flags.test);
  required("before", flags.before);
  required("after", flags.after);
  const testId = clean(flags.test);
  if (!QUOTA_TEST_IDS.includes(testId)) throw new Error(`Unknown quota test: ${testId}`);
  const row = artifact.tests.find((test) => test.id === testId);
  if (row.status === "passed") throw new Error(`Quota test is immutable after passing: ${testId}`);
  const beforePath = path.resolve(flags.before);
  const afterPath = path.resolve(flags.after);
  const [before, after, beforeSha256, afterSha256] = await Promise.all([
    readJson(beforePath), readJson(afterPath), sha256File(beforePath).catch(() => null), sha256File(afterPath).catch(() => null),
  ]);
  if (!before || !after || !beforeSha256 || !afterSha256) throw new Error("Before/after counter snapshots must be valid JSON files.");
  const evidencePaths = clean(flags.evidence).split(",").map(clean).filter(Boolean).map(path.resolve);
  const evidenceHashes = Object.fromEntries(await Promise.all(evidencePaths.map(async (filePath) => [filePath, await sha256File(filePath)])));
  row.status = "passed";
  row.observation = {
    recorded_at: new Date().toISOString(),
    before_path: beforePath,
    before_sha256: beforeSha256,
    after_path: afterPath,
    after_sha256: afterSha256,
    evidence_hashes: evidenceHashes,
    request_count: number(flags.requests),
    success_count: number(flags.successes),
    failure_count: number(flags.failures),
    safe_concurrency: number(flags.concurrency),
    duration_sec: number(flags["duration-sec"]),
    cooldown_sec: number(flags["cooldown-sec"]),
    failed_generation_credit_refund: clean(flags["failed-credits-refunded"]) || "unknown",
    counter_deltas: counterDeltas(before, after),
    notes: clean(flags.note) || null,
  };
  artifact.status = artifact.tests.every((test) => test.status === "passed") ? "ready_for_analysis" : "incomplete";
  artifact.updated_at = new Date().toISOString();
  await writeJson(outputPath, artifact);
  console.log(JSON.stringify({ status: "passed", proof_path: outputPath, test: testId, overall_status: artifact.status }, null, 2));
}

async function analyze() {
  const outputPath = proofPath();
  const artifact = await readJson(outputPath);
  if (artifact?.schema !== PROVIDER_QUOTA_PROOF_SCHEMA) throw new Error(`Quota proof missing: ${outputPath}`);
  const incomplete = artifact.tests.filter((test) => test.status !== "passed").map((test) => test.id);
  if (incomplete.length) throw new Error(`Quota proof is incomplete: ${incomplete.join(", ")}`);
  const changedCounters = Object.fromEntries(artifact.tests.map((test) => [test.id,
    Object.entries(test.observation.counter_deltas ?? {}).filter(([, delta]) => delta !== 0 && delta != null).map(([counter, delta]) => ({ counter, delta })),
  ]));
  artifact.status = "measured";
  artifact.conclusion = {
    changed_counters_by_test: changedCounters,
    product_limit_separation: clean(flags.conclusion) || "operator_review_required",
    production_capacity_policy: "Use only measured safe concurrency and observed counters. Do not infer unlimited capacity from subscription labels.",
    analyzed_at: new Date().toISOString(),
    analyzed_by: clean(flags["analyzed-by"]) || "goldflow",
  };
  await writeJson(outputPath, artifact);
  console.log(JSON.stringify({ status: "passed", proof_path: outputPath, conclusion: artifact.conclusion }, null, 2));
}

async function main() {
  if (action === "init") return initialize();
  if (action === "record") return record();
  if (action === "analyze") return analyze();
  const artifact = await readJson(proofPath());
  console.log(JSON.stringify(artifact ?? { status: "missing", proof_path: proofPath() }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
