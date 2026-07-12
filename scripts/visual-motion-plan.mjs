#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  editorialMotionDistributionFindings,
  motionIntentFindings,
  motionIntentForPrompt,
} from "./lib/motion-plan-utils.mjs";
import { parallaxApprovalMatches } from "./lib/parallax-contract.mjs";
import { noticeableParallaxTreatment } from "./lib/parallax-policy.mjs";

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
const audioBedReportPath = flags["audio-bed-report"] ?? path.join(episodeDir, `longform_audio_bed_report_${episode}.json`);
const identityPath = flags["run-identity"] ?? path.join(episodeDir, "run_identity.json");
const parallaxReportPath = flags["parallax-report"] ?? path.join(episodeDir, `parallax_asset_report_${episode}.json`);
const parallaxApprovalPath = flags["parallax-approval"] ?? path.join(episodeDir, `parallax_asset_approval_${episode}.json`);
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

function countBy(rows, selector) {
  const counts = {};
  for (const row of rows) {
    const key = String(selector(row) ?? "unknown");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function main() {
  const [promptPlan, imagegenReport, imageQa, decisions, ledger, audioBedReport, identity, parallaxReport, parallaxApproval] = await Promise.all([
    readJson(promptPath),
    readJson(imagegenReportPath),
    readJson(imageQaPath),
    readJson(decisionPath, { decisions: [] }),
    readJson(ledgerPath),
    readJson(audioBedReportPath),
    readJson(identityPath, {}),
    readJson(parallaxReportPath, null),
    readJson(parallaxApprovalPath, null),
  ]);
  if (promptPlan?.status !== "passed" || !Array.isArray(promptPlan.prompts)) throw new Error(`Missing passed hardened prompt plan: ${promptPath}`);
  if (imagegenReport?.status !== "passed") throw new Error(`Missing passed imagegen report: ${imagegenReportPath}`);
  if (imageQa?.status !== "passed") throw new Error(`Motion planning requires passed per-cut image QA: ${imageQaPath}`);
  const audioTimelineEndSec = Number(audioBedReport?.mixed_duration_sec ?? audioBedReport?.mix?.duration_sec);
  if (!Number.isFinite(audioTimelineEndSec) || audioTimelineEndSec <= 0) throw new Error(`Motion planning requires a valid mixed audio duration: ${audioBedReportPath}`);
  if (await hashFile(decisionPath) !== imageQa.review_decisions_sha256) throw new Error(`Motion planning refused stale image review decisions: ${decisionPath}`);
  const ledgerById = new Map((ledger?.cuts ?? []).map((row) => [String(row.image_id ?? ""), row]));
  const decisionById = new Map((decisions?.decisions ?? []).map((row) => [String(row.image_id ?? ""), row]));
  const acceptedHashes = imageQa.accepted_image_hashes ?? {};
  let intents = (promptPlan.prompts ?? []).filter((prompt) => prompt.image_generation_required !== false).map((prompt) => {
    const cut = ledgerById.get(String(prompt.image_id ?? ""));
    if (!String(cut?.image_qa_status ?? "").startsWith("passed")) throw new Error(`Motion planning refused unaccepted cut ${prompt.image_id}.`);
    return motionIntentForPrompt(prompt, cut.image_sha256, decisionById.get(String(prompt.image_id ?? "")), { timelineEndSec: audioTimelineEndSec });
  });
  const parallaxPolicy = String(identity?.parallax_policy ?? "disabled");
  let parallaxSourcePaths = [];
  const approvedParallaxById = new Map();
  if (parallaxPolicy === "selective_inspected") {
    if (parallaxReport?.status !== "passed") throw new Error(`Motion planning requires a passed parallax asset decision: ${parallaxReportPath}`);
    parallaxSourcePaths = [parallaxReportPath];
    if (Number(parallaxReport.candidate_count ?? 0) === 0) {
      const waiver = parallaxReport.no_suitable_parallax_waiver;
      if (!waiver?.reviewer || !waiver?.note) throw new Error("Motion planning requires an explicit no-suitable-parallax waiver when no candidate is selected.");
    } else {
      const reportHash = await hashFile(parallaxReportPath);
      if (!parallaxApprovalMatches(parallaxReport, parallaxApproval, { reportSha256: reportHash })) {
        throw new Error(`Motion planning requires current per-candidate parallax approval: ${parallaxApprovalPath}`);
      }
      parallaxSourcePaths.push(parallaxApprovalPath);
      const approvedIds = new Set(parallaxApproval.approved_image_ids ?? []);
      for (const candidate of parallaxReport.candidates ?? []) {
        if (!approvedIds.has(candidate.image_id)) continue;
        for (const [assetPath, expectedHash] of [
          [candidate.asset_report?.foreground_path, candidate.asset_report?.foreground_sha256],
          [candidate.asset_report?.background_path, candidate.asset_report?.background_sha256],
        ]) {
          if (!assetPath || !expectedHash || await hashFile(assetPath) !== expectedHash) {
            throw new Error(`Approved parallax layer is missing or stale for ${candidate.image_id}: ${assetPath ?? "missing path"}`);
          }
        }
        approvedParallaxById.set(String(candidate.image_id), candidate);
      }
    }
  }
  intents = intents.map((intent) => {
    const candidate = approvedParallaxById.get(String(intent.image_id));
    if (!candidate) return intent;
    if (candidate.image_sha256 !== intent.image_sha256 || candidate.asset_report?.image_sha256 !== intent.image_sha256) {
      throw new Error(`Approved parallax source image is stale for ${intent.image_id}.`);
    }
    const treatment = noticeableParallaxTreatment({
      intent,
      assetReport: candidate.asset_report,
      candidate,
    });
    if (!treatment) throw new Error(`Approved parallax treatment is invalid for ${intent.image_id}.`);
    return {
      ...intent,
      depth_treatment: treatment,
      depth_candidate: {
        priority: candidate.priority,
        foreground_subject: candidate.foreground_subject,
        background_plane: candidate.background_plane,
        editorial_reason: candidate.editorial_reason,
      },
    };
  });
  const findings = [
    ...motionIntentFindings(intents, acceptedHashes),
    ...(identity?.motion_policy === "selective_editorial_v1" ? editorialMotionDistributionFindings(intents) : []),
  ];
  const blockers = findings.filter((row) => row.severity === "blocker");
  const sourcePaths = [
    promptPath,
    imagegenReportPath,
    imageQaPath,
    decisionPath,
    audioBedReportPath,
    identityPath,
    ...parallaxSourcePaths,
  ];
  const report = {
    schema: "goldflow_motion_edit_plan_v1",
    status: blockers.length ? "blocked" : "passed",
    channel,
    series_slug: series,
    week,
    episode,
    policy: "LLM-authored shot_manifest.motion_intent is the baseline. Explicit image-QA focal overrides supersede it after inspecting the generated frame. Legacy prompts without authored motion use conservative shot-staging fallback; missing focal intent becomes a smooth static hold. Hash-random motion is forbidden. Only reviewed, hash-bound parallax candidates may add layered depth.",
    motion_policy: identity?.motion_policy ?? "legacy",
    parallax_policy: parallaxPolicy,
    parallax_asset_report_path: parallaxPolicy === "selective_inspected" ? parallaxReportPath : null,
    parallax_asset_approval_path: parallaxPolicy === "selective_inspected" && Number(parallaxReport?.candidate_count ?? 0) > 0 ? parallaxApprovalPath : null,
    source_hashes: Object.fromEntries((await Promise.all(sourcePaths.map(async (filePath) => [path.resolve(filePath), await hashFile(filePath)]))).filter(([, hash]) => hash)),
    timeline_end_sec: audioTimelineEndSec,
    accepted_cut_hashes: Object.fromEntries(intents.map((row) => [row.image_id, row.image_sha256])),
    motion_intent_count: intents.length,
    static_hold_count: intents.filter((row) => row.behavior === "static_hold").length,
    layered_parallax_count: intents.filter((row) => row.depth_treatment?.mode === "layered_parallax").length,
    approved_parallax_candidate_count: approvedParallaxById.size,
    qa_override_count: intents.filter((row) => row.qa_override).length,
    llm_authored_intent_count: intents.filter((row) => row.focal_source === "llm_authored_shot_manifest_motion_intent").length,
    legacy_fallback_intent_count: intents.filter((row) => !row.qa_override && row.focal_source !== "llm_authored_shot_manifest_motion_intent").length,
    behavior_distribution: countBy(intents, (row) => row.behavior),
    easing_distribution: countBy(intents, (row) => row.easing),
    focal_source_distribution: countBy(intents, (row) => row.focal_source),
    motion_intents: intents,
    findings,
    blocker_count: blockers.length,
    updated_at: new Date().toISOString(),
  };
  await writeJson(outputPath, report);
  console.log(JSON.stringify({ status: report.status, output_path: outputPath, motion_intent_count: report.motion_intent_count, static_hold_count: report.static_hold_count, layered_parallax_count: report.layered_parallax_count, blocker_count: report.blocker_count }, null, 2));
  if (blockers.length) process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    await writeJson(outputPath, { schema: "goldflow_motion_edit_plan_v1", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() }).catch(() => {});
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
