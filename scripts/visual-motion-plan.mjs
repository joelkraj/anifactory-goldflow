#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { motionIntentFindings, motionIntentForPrompt } from "./lib/motion-plan-utils.mjs";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeDir = flags["episode-dir"] ? path.resolve(flags["episode-dir"]) : path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode);
const promptPath = flags.prompts ?? path.join(episodeDir, "section_image_prompts_hardened.json");
const imagegenReportPath = flags["imagegen-report"] ?? path.join(episodeDir, `imagegen_report_${episode}.json`);
const imageQaPath = flags["image-output-qa"] ?? path.join(episodeDir, `image_output_qa_${episode}.json`);
const decisionPath = flags.decisions ?? path.join(episodeDir, `image_output_review_decisions_${episode}.json`);
const ledgerPath = flags.ledger ?? path.join(episodeDir, "cut_execution_ledger.json");
const outputPath = flags.output ?? path.join(episodeDir, `motion_edit_plan_${episode}.json`);

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

async function readJson(filePath, fallback = null) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); } catch { return fallback; }
}

async function hashFile(filePath) {
  return fs.readFile(filePath).then((buffer) => sha256(buffer)).catch(() => null);
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  const [promptPlan, imagegenReport, imageQa, decisions, ledger] = await Promise.all([
    readJson(promptPath),
    readJson(imagegenReportPath),
    readJson(imageQaPath),
    readJson(decisionPath, { decisions: [] }),
    readJson(ledgerPath),
  ]);
  if (promptPlan?.status !== "passed" || !Array.isArray(promptPlan.prompts)) throw new Error(`Missing passed hardened prompt plan: ${promptPath}`);
  if (imagegenReport?.status !== "passed") throw new Error(`Missing passed imagegen report: ${imagegenReportPath}`);
  if (imageQa?.status !== "passed") throw new Error(`Motion planning requires passed per-cut image QA: ${imageQaPath}`);
  if (await hashFile(decisionPath) !== imageQa.review_decisions_sha256) throw new Error(`Motion planning refused stale image review decisions: ${decisionPath}`);
  const ledgerById = new Map((ledger?.cuts ?? []).map((row) => [String(row.image_id ?? ""), row]));
  const decisionById = new Map((decisions?.decisions ?? []).map((row) => [String(row.image_id ?? ""), row]));
  const acceptedHashes = imageQa.accepted_image_hashes ?? {};
  const intents = (promptPlan.prompts ?? []).filter((prompt) => prompt.image_generation_required !== false).map((prompt) => {
    const cut = ledgerById.get(String(prompt.image_id ?? ""));
    if (!String(cut?.image_qa_status ?? "").startsWith("passed")) throw new Error(`Motion planning refused unaccepted cut ${prompt.image_id}.`);
    return motionIntentForPrompt(prompt, cut.image_sha256, decisionById.get(String(prompt.image_id ?? "")));
  });
  const findings = motionIntentFindings(intents, acceptedHashes);
  const blockers = findings.filter((row) => row.severity === "blocker");
  const report = {
    schema: "goldflow_motion_edit_plan_v1",
    status: blockers.length ? "blocked" : "passed",
    channel,
    series_slug: series,
    week,
    episode,
    policy: "Motion is derived from LLM-authored shot staging or explicit image-QA focal overrides. Missing intent becomes a smooth static hold; hash-random motion is forbidden.",
    source_hashes: Object.fromEntries((await Promise.all([promptPath, imagegenReportPath, imageQaPath, decisionPath].map(async (filePath) => [path.resolve(filePath), await hashFile(filePath)]))).filter(([, hash]) => hash)),
    accepted_cut_hashes: Object.fromEntries(intents.map((row) => [row.image_id, row.image_sha256])),
    motion_intent_count: intents.length,
    static_hold_count: intents.filter((row) => row.behavior === "static_hold").length,
    qa_override_count: intents.filter((row) => row.qa_override).length,
    motion_intents: intents,
    findings,
    blocker_count: blockers.length,
    updated_at: new Date().toISOString(),
  };
  await writeJson(outputPath, report);
  console.log(JSON.stringify({ status: report.status, output_path: outputPath, motion_intent_count: report.motion_intent_count, static_hold_count: report.static_hold_count, blocker_count: report.blocker_count }, null, 2));
  if (blockers.length) process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    await writeJson(outputPath, { schema: "goldflow_motion_edit_plan_v1", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() }).catch(() => {});
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
