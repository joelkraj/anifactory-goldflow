#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256File } from "./lib/file-hash.mjs";

export const PLANNER_BENCHMARK_SCHEMA = "goldflow_planner_benchmark_v1";
export const PLANNER_BENCHMARK_PROVIDERS = Object.freeze(["codex_cli", "antigravity_cli", "gemini_web", "chatgpt_web"]);
const WORKLOADS = Object.freeze([
  ...[1, 2, 3].map((index) => ({ id: `semantic_${index}`, class: "semantic_extraction" })),
  ...[1, 2, 3].map((index) => ({ id: `beat_${index}`, class: "editorial_beat" })),
  ...[1, 2, 3].map((index) => ({ id: `reference_${index}`, class: "reference_direction" })),
  ...[1, 2, 3].map((index) => ({ id: `scene_prompt_${index}`, class: "scene_prompt_15_cut" })),
  { id: "global_reconciliation_1", class: "global_continuity_reconciliation" },
  { id: "package_opening_audit_1", class: "package_opening_audit" },
]);
const SCORE_KEYS = Object.freeze([
  "schema_validity", "source_fidelity", "continuity", "editorial_usefulness",
  "recoverability", "determinism",
]);

const action = process.argv[2] ?? "status";
const flags = parseFlags(process.argv.slice(3));
function parseFlags(parts) { const out = {}; for (let i = 0; i < parts.length; i += 1) { const part = parts[i]; if (!part.startsWith("--")) continue; const key = part.slice(2); const value = parts[i + 1] && !parts[i + 1].startsWith("--") ? parts[++i] : "true"; out[key] = value; } return out; }
function clean(value) { return String(value ?? "").trim(); }
function required(name, value) { if (!clean(value)) throw new Error(`Missing required --${name}.`); }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
async function readJson(filePath) { try { return JSON.parse(await fs.readFile(filePath, "utf8")); } catch { return null; } }
async function writeJson(filePath, value) { await fs.mkdir(path.dirname(filePath), { recursive: true }); const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`; await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`); await fs.rename(temp, filePath); }
function outputPath() { return path.resolve(flags.output ?? flags.benchmark ?? "docs/proofs/planner_benchmark_v1.json"); }

async function initialize() {
  const filePath = outputPath();
  if (await readJson(filePath)) throw new Error(`Planner benchmark already exists: ${filePath}`);
  const artifact = {
    schema: PLANNER_BENCHMARK_SCHEMA,
    status: "incomplete",
    created_at: new Date().toISOString(),
    providers: PLANNER_BENCHMARK_PROVIDERS,
    workloads: WORKLOADS,
    expected_run_count: WORKLOADS.length * PLANNER_BENCHMARK_PROVIDERS.length,
    runs: [],
    routing_recommendation: null,
  };
  await writeJson(filePath, artifact);
  console.log(JSON.stringify({ status: "passed", benchmark_path: filePath, expected_run_count: artifact.expected_run_count }, null, 2));
}

async function record() {
  const filePath = outputPath();
  const artifact = await readJson(filePath);
  if (artifact?.schema !== PLANNER_BENCHMARK_SCHEMA) throw new Error(`Initialize benchmark first: ${filePath}`);
  for (const name of ["provider", "workload", "result", "score"]) required(name, flags[name]);
  const provider = clean(flags.provider);
  const workload = clean(flags.workload);
  if (!PLANNER_BENCHMARK_PROVIDERS.includes(provider)) throw new Error(`Unknown planner provider: ${provider}`);
  if (!WORKLOADS.some((row) => row.id === workload)) throw new Error(`Unknown benchmark workload: ${workload}`);
  if (artifact.runs.some((row) => row.provider === provider && row.workload_id === workload && row.status === "passed")) {
    throw new Error(`Passed benchmark result is immutable: ${provider}/${workload}`);
  }
  const resultPath = path.resolve(flags.result);
  const scorePath = path.resolve(flags.score);
  const [resultSha256, scoreSha256, score] = await Promise.all([
    sha256File(resultPath).catch(() => null), sha256File(scorePath).catch(() => null), readJson(scorePath),
  ]);
  if (!resultSha256 || !scoreSha256 || !score) throw new Error("Result and score must be readable files; score must be JSON.");
  const invalidScores = SCORE_KEYS.filter((key) => !(number(score[key]) >= 0 && number(score[key]) <= 5));
  if (invalidScores.length) throw new Error(`Score fields must be 0-5: ${invalidScores.join(", ")}`);
  artifact.runs.push({
    status: "passed",
    provider,
    workload_id: workload,
    workload_class: WORKLOADS.find((row) => row.id === workload).class,
    result_path: resultPath,
    result_sha256: resultSha256,
    score_path: scorePath,
    score_sha256: scoreSha256,
    scores: Object.fromEntries(SCORE_KEYS.map((key) => [key, number(score[key])])),
    unsupported_invention_count: number(score.unsupported_invention_count),
    latency_sec: number(score.latency_sec),
    throughput_units_per_hour: number(score.throughput_units_per_hour),
    safe_concurrency: number(score.safe_concurrency),
    quota_or_cost_units: number(score.quota_or_cost_units),
    human_correction_minutes: number(score.human_correction_minutes),
    recorded_at: new Date().toISOString(),
  });
  artifact.status = artifact.runs.length >= artifact.expected_run_count ? "ready_for_analysis" : "incomplete";
  artifact.updated_at = new Date().toISOString();
  await writeJson(filePath, artifact);
  console.log(JSON.stringify({ status: "passed", benchmark_path: filePath, completed: artifact.runs.length, expected: artifact.expected_run_count }, null, 2));
}

function average(rows, selector) { const values = rows.map(selector).map(Number).filter(Number.isFinite); return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function providerScore(rows) {
  const quality = average(rows, (row) => SCORE_KEYS.reduce((sum, key) => sum + Number(row.scores[key] ?? 0), 0) / SCORE_KEYS.length) ?? 0;
  const corrections = average(rows, (row) => row.human_correction_minutes) ?? 0;
  const inventions = average(rows, (row) => row.unsupported_invention_count) ?? 0;
  return Number((quality - Math.min(2, corrections / 30) - Math.min(2, inventions / 3)).toFixed(4));
}

async function analyze() {
  const filePath = outputPath();
  const artifact = await readJson(filePath);
  if (artifact?.schema !== PLANNER_BENCHMARK_SCHEMA) throw new Error(`Benchmark missing: ${filePath}`);
  const missing = [];
  for (const provider of PLANNER_BENCHMARK_PROVIDERS) for (const workload of WORKLOADS) {
    if (!artifact.runs.some((row) => row.provider === provider && row.workload_id === workload.id && row.status === "passed")) missing.push(`${provider}/${workload.id}`);
  }
  if (missing.length && clean(flags["allow-partial"]) !== "true") throw new Error(`Benchmark incomplete (${missing.length} runs): ${missing.slice(0, 12).join(", ")}`);
  const classes = [...new Set(WORKLOADS.map((row) => row.class))];
  const byClass = {};
  for (const workloadClass of classes) {
    const rows = artifact.runs.filter((row) => row.workload_class === workloadClass);
    const ranked = PLANNER_BENCHMARK_PROVIDERS.map((provider) => {
      const providerRows = rows.filter((row) => row.provider === provider);
      return {
        provider,
        sample_count: providerRows.length,
        adjusted_score: providerScore(providerRows),
        average_latency_sec: average(providerRows, (row) => row.latency_sec),
        safe_concurrency: average(providerRows, (row) => row.safe_concurrency),
        average_human_correction_minutes: average(providerRows, (row) => row.human_correction_minutes),
      };
    }).filter((row) => row.sample_count).sort((left, right) => right.adjusted_score - left.adjusted_score);
    byClass[workloadClass] = { ranked, recommended_provider: ranked[0]?.provider ?? null };
  }
  artifact.status = missing.length ? "partial_measured" : "measured";
  artifact.routing_recommendation = {
    by_workload_class: byClass,
    policy: "Choose task-specific routes. Codex remains the local artifact authority and deterministic reconciler regardless of benchmark winner.",
    missing_runs: missing,
    analyzed_at: new Date().toISOString(),
  };
  await writeJson(filePath, artifact);
  console.log(JSON.stringify({ status: artifact.status, benchmark_path: filePath, routing_recommendation: artifact.routing_recommendation }, null, 2));
}

async function main() {
  if (action === "init") return initialize();
  if (action === "record") return record();
  if (action === "analyze") return analyze();
  console.log(JSON.stringify(await readJson(outputPath()) ?? { status: "missing", benchmark_path: outputPath() }, null, 2));
}
if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
