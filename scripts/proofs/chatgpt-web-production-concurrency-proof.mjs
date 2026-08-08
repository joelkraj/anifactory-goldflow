#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";
import { generateChatGptWebImage } from "../chatgpt-web-image-helper.mjs";
import { runCodexCli } from "../lib/codex-cli-runner.mjs";
import {
  CHATGPT_WEB_BROWSER_WORKER_LIMIT,
  CHATGPT_WEB_DEEP_TEXT_WORKER_LIMIT,
  CHATGPT_WEB_GLOBAL_START_INTERVAL_MS,
  CHATGPT_WEB_IMAGE_WORKER_LIMIT,
  CHATGPT_WEB_IMAGE_START_INTERVAL_MS,
  CHATGPT_WEB_REASONING_STARTS_PER_WINDOW,
  CHATGPT_WEB_REASONING_WINDOW_MS,
  CHATGPT_WEB_TEXT_WORKER_LIMIT,
  CHATGPT_WEB_TEXT_START_INTERVAL_MS,
} from "../lib/chatgpt-web-worker-pool.mjs";

function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !String(next).startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = "true";
    }
  }
  return flags;
}

function stripJsonFence(value) {
  return String(value ?? "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function compactError(error) {
  return String(error instanceof Error ? error.stack || error.message : error).slice(0, 4_000);
}

async function sha256File(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

const sourcePacket = `
EPISODE: Where Lost Luggage Goes When Nobody Claims It
VIEWER PROMISE: Follow one suitcase from a missed connection through tracing, custody transfer,
sorting, resale, donation, recycling, or destruction. Separate ordinary delayed baggage from the
rare bag that becomes truly unclaimed. Never imply that every airline, airport, or country uses one
identical process.

LOCKED FACTS:
- The bag misses a domestic connection after its tag is damaged near a transfer scan.
- The passenger files a delayed-baggage report and preserves the claim number and receipts.
- Airline tracing uses routing records and custody scans; airport lost property and security-screening
  property are separate systems and must not be merged into the airline baggage chain.
- Most delayed bags are reunited with owners. The episode follows the exceptional unresolved case.
- Compensation, ownership, storage duration, and disposition depend on carrier terms and jurisdiction.
- A documented United States case may involve a specialist buyer after an extended tracing period,
  but this must be labeled case-specific rather than universal law.
- At intake, the bag is opened and classified. Personal data-bearing devices require secure handling.
- Items may be resold, donated, repurposed, recycled, or destroyed according to condition and policy.
- The final verdict must identify what happened to the suitcase shell, clothing, electronics, documents,
  and any item that could not safely receive a second owner.

CONTINUITY:
- Hero object: one hard-shell red suitcase with a torn white destination tag and one black wheel scuff.
- The suitcase remains recognizably the same object until the final disposition montage.
- No invented airline logo, owner face, precise universal timer, or unsupported auction value.
- Tone: premium investigative documentary, concrete and visual, never a generic recycling explainer.

NARRATION EXCERPT:
The carousel stops, but one red suitcase never arrives. At first, nothing about it is mysterious. A tag
can tear, a transfer can be missed, and a bag can reach the correct city hours after its passenger. The
airline opens a tracing file and begins reconstructing the bag's last confirmed handoff. Each scan narrows
the search, but the missing scan matters most. It marks the point where an ordinary delayed bag can enter
a much stranger chain of custody. Days later, the passenger may be compensated, yet the suitcase can still
exist in a warehouse under somebody else's legal and financial responsibility. Storage now costs money.
Personal data creates risk. A working item can be worth more than the damaged shell around it. The final
decision is not simply recycle or discard. It is a sequence of inspections that determines which objects
can safely live again, which can be donated, and which must be destroyed.
`.trim();

const plannerJobs = [
  ["semantic_01", "semantic scene extraction", "concurrency_probe_semantic_scene_plan_chunk_001"],
  ["beats_01", "opening visual beat direction", "concurrency_probe_visual_beat_plan_chunk_001"],
  ["refs_01", "identity and prop reference selection", "concurrency_probe_visual_reference_plan_chunk_001"],
  ["prompts_01", "animation-ready scene prompt authoring", "concurrency_probe_visual_plan_chunk_001"],
  ["global_01", "global evidence-constrained reconciliation", "concurrency_probe_semantic_scene_plan_global_reconciliation"],
  ["semantic_02", "state and continuity extraction", "concurrency_probe_semantic_scene_plan_chunk_002"],
  ["beats_02", "custody-chain visual beat direction", "concurrency_probe_visual_beat_plan_chunk_002"],
  ["refs_02", "location reference selection", "concurrency_probe_visual_reference_plan_chunk_002"],
  ["semantic_03", "claim and uncertainty ledger", "concurrency_probe_semantic_scene_plan_chunk_003"],
  ["beats_03", "transformation and verdict visual beats", "concurrency_probe_visual_beat_plan_chunk_003"],
].map(([id, assignment, stageName]) => ({ id, assignment, stageName }));

const imagePrompts = [
  "A single scuffed red hard-shell suitcase sitting alone on a stopped airport baggage carousel after midnight, torn white destination tag clearly visible, vast terminal fading into darkness, strong foreground silhouette, premium investigative documentary composition, no logos, no readable text, one hero object, widescreen 16:9.",
  "The same scuffed red hard-shell suitcase on a clean inspection table inside a vast airline tracing warehouse, organized rows of baggage receding behind it, gloved worker hands entering only at frame edge, custody and investigation mood, premium documentary lighting, no logos, no readable text, widescreen 16:9.",
  "The same red suitcase opened at a professional disposition sorting station, contents separated into three visually clear destinations: careful resale inspection, donation bin, secure electronics handling, a consequential final-decision composition rather than a generic factory scene, no logos, no readable text, widescreen 16:9.",
];

function plannerPrompt(job) {
  return `You are executing a real Goldflow production planner unit: ${job.assignment}.

Analyze only the supplied evidence. Do not add external facts. Distinguish locked fact, necessary
inference, case-specific possibility, and prohibited invention. Think at the reasoning depth selected by
the caller, but return only the final JSON artifact.

${sourcePacket}

Return exactly one valid JSON object with no markdown fence and this shape:
{
  "probe_id": "${job.id}",
  "assignment": "${job.assignment}",
  "editorial_summary": "80 to 140 words",
  "items": [
    {
      "id": "stable snake_case id",
      "evidence_class": "locked_fact | necessary_inference | case_specific_possibility | prohibited_invention",
      "decision": "specific production decision",
      "continuity_or_risk": "specific constraint",
      "visual_payoff": "specific visible result"
    }
  ],
  "unresolved_questions": ["only questions the packet cannot answer"]
}

Produce 5 to 7 distinct items. Keep all JSON strings on one semantic layer: no JSON encoded inside strings.`;
}

async function runPlannerJob(job, outputRoot, reasoningEffort = null) {
  const outputPath = path.join(outputRoot, "text", `${job.id}.json`);
  const started = Date.now();
  const result = await runCodexCli({
    prompt: plannerPrompt(job),
    stageName: job.stageName,
    repoRoot: process.cwd(),
    outputPath,
    provider: "chatgpt_web",
    reasoningEffort,
    timeoutMs: 1_800_000,
  });
  const parsed = JSON.parse(stripJsonFence(result.content));
  if (parsed?.probe_id !== job.id) throw new Error(`${job.id} returned probe_id ${parsed?.probe_id}`);
  if (!Array.isArray(parsed.items) || parsed.items.length < 5) {
    throw new Error(`${job.id} returned ${parsed?.items?.length ?? 0} items; expected at least five`);
  }
  const metadata = JSON.parse(await fs.readFile(`${outputPath}.meta.json`, "utf8"));
  return {
    id: job.id,
    kind: "text",
    status: "passed",
    assignment: job.assignment,
    effort: metadata.reasoning_effort,
    pool: metadata.browser_worker_pool,
    slot: metadata.browser_worker_slot,
    worker_wait_ms: metadata.browser_worker_wait_ms,
    reasoning_pool: metadata.browser_reasoning_pool,
    reasoning_slot: metadata.browser_reasoning_slot,
    reasoning_wait_ms: metadata.browser_reasoning_wait_ms,
    host_pool: metadata.browser_host_pool,
    host_slot: metadata.browser_host_slot,
    host_wait_ms: metadata.browser_host_wait_ms,
    prompt_chars: plannerPrompt(job).length,
    output_chars: result.content.length,
    item_count: parsed.items.length,
    start_gate_wait_ms: metadata.browser_start_gate?.waited_ms ?? null,
    bridge_duration_ms: metadata.bridge_duration_ms,
    wall_ms: Date.now() - started,
    output_path: outputPath,
  };
}

async function runImageJob(index, outputRoot, referenceImagePath) {
  const id = `image_${String(index + 1).padStart(2, "0")}`;
  const outputPath = path.join(outputRoot, "images", `${id}.png`);
  const started = Date.now();
  const result = await generateChatGptWebImage({
    prompt: `${imagePrompts[index]} Use the attached image only as a style-language reference for line, shape, palette, and texture; do not copy its people, labels, panel layout, or subject matter.`,
    outputPath,
    referenceImagePaths: referenceImagePath ? [referenceImagePath] : [],
    workId: `concurrency_probe_${id}`,
  });
  const metadata = await sharp(outputPath).metadata();
  const ratio = Number(metadata.width) / Number(metadata.height);
  if (!Number.isFinite(ratio) || Math.abs(ratio - (16 / 9)) > 0.04) {
    throw new Error(`${id} returned ${metadata.width}x${metadata.height}, not an accepted 16:9 raster`);
  }
  return {
    id,
    kind: "image",
    status: "passed",
    pool: result.browser_worker_pool,
    slot: result.browser_worker_slot,
    worker_wait_ms: result.browser_worker_wait_ms,
    host_pool: result.browser_host_pool,
    host_slot: result.browser_host_slot,
    host_wait_ms: result.browser_host_wait_ms,
    width: metadata.width,
    height: metadata.height,
    sha256: await sha256File(outputPath),
    start_gate_wait_ms: result.browser_start_gate?.waited_ms ?? null,
    bridge_duration_ms: result.bridge_duration_ms,
    wall_ms: Date.now() - started,
    conversation_archive_status: result.conversation_archive_status,
    conversation_archive_error: result.conversation_archive_error,
    conversation_cleanup_status: result.conversation_cleanup_status,
    conversation_archive_queue_id: result.conversation_archive_queue_id,
    output_path: outputPath,
  };
}

const flags = parseFlags(process.argv.slice(2));
const mode = String(flags.mode ?? "mixed").trim().toLowerCase();
if (!new Set(["text", "image", "mixed"]).has(mode)) {
  throw new Error("--mode must be text, image, or mixed");
}
const referenceImagePath = flags["reference-image"] ? path.resolve(flags["reference-image"]) : null;
const textEffort = flags["text-effort"] ? String(flags["text-effort"]).trim().toLowerCase() : null;
if (textEffort && !new Set(["low", "medium", "high", "xhigh", "max"]).has(textEffort)) {
  throw new Error("--text-effort must be low, medium, high, xhigh, or max");
}
if ((mode === "image" || mode === "mixed") && referenceImagePath) await fs.access(referenceImagePath);
const textCount = Math.max(0, Math.min(
  CHATGPT_WEB_TEXT_WORKER_LIMIT,
  Number(flags["text-count"] ?? CHATGPT_WEB_TEXT_WORKER_LIMIT) || 0,
));
const imageCount = Math.max(0, Math.min(
  CHATGPT_WEB_IMAGE_WORKER_LIMIT,
  Number(flags["image-count"] ?? CHATGPT_WEB_IMAGE_WORKER_LIMIT) || 0,
));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputRoot = path.resolve(flags.output ?? `/tmp/goldflow-chatgpt-web-production-concurrency-${mode}-${stamp}`);
await fs.mkdir(outputRoot, { recursive: true });

const tasks = [];
if (mode === "text" || mode === "mixed") {
  tasks.push(...plannerJobs.slice(0, textCount).map((job) => ({
    id: job.id,
    kind: "text",
    run: () => runPlannerJob(job, outputRoot, textEffort),
  })));
}
if (mode === "image" || mode === "mixed") {
  tasks.push(...imagePrompts.slice(0, imageCount).map((_, index) => ({
    id: `image_${String(index + 1).padStart(2, "0")}`,
    kind: "image",
    run: () => runImageJob(index, outputRoot, referenceImagePath),
  })));
}

const began = Date.now();
const settled = await Promise.allSettled(tasks.map((task) => task.run()));
const results = settled.map((row, index) => row.status === "fulfilled"
  ? row.value
  : {
    id: tasks[index].id,
    kind: tasks[index].kind,
    status: "failed",
    error: compactError(row.reason),
  });
const passed = results.filter((row) => row.status === "passed");
const failed = results.filter((row) => row.status === "failed");
const report = {
  schema: "goldflow_chatgpt_web_production_concurrency_proof_v1",
  mode,
  started_at: new Date(began).toISOString(),
  completed_at: new Date().toISOString(),
  wall_ms: Date.now() - began,
  configured_limits: {
    text: CHATGPT_WEB_TEXT_WORKER_LIMIT,
    deep_text: CHATGPT_WEB_DEEP_TEXT_WORKER_LIMIT,
    image: CHATGPT_WEB_IMAGE_WORKER_LIMIT,
    browser_total: CHATGPT_WEB_BROWSER_WORKER_LIMIT,
    shared_start_interval_ms: CHATGPT_WEB_GLOBAL_START_INTERVAL_MS,
    text_start_interval_ms: CHATGPT_WEB_TEXT_START_INTERVAL_MS,
    image_start_interval_ms: CHATGPT_WEB_IMAGE_START_INTERVAL_MS,
    reasoning_starts_per_window: CHATGPT_WEB_REASONING_STARTS_PER_WINDOW,
    reasoning_window_ms: CHATGPT_WEB_REASONING_WINDOW_MS,
  },
  requested: {
    text: tasks.filter((task) => task.kind === "text").length,
    image: tasks.filter((task) => task.kind === "image").length,
    text_effort_override: textEffort,
  },
  outcome: {
    passed: passed.length,
    failed: failed.length,
    text_passed: passed.filter((row) => row.kind === "text").length,
    image_passed: passed.filter((row) => row.kind === "image").length,
    text_slots: [...new Set(passed.filter((row) => row.kind === "text").map((row) => row.slot))].sort((a, b) => a - b),
    deep_text_slots: [...new Set(passed.filter((row) => row.kind === "text" && row.reasoning_slot).map((row) => row.reasoning_slot))].sort((a, b) => a - b),
    browser_host_slots: [...new Set(passed.map((row) => row.host_slot).filter(Boolean))].sort((a, b) => a - b),
    image_slots: [...new Set(passed.filter((row) => row.kind === "image").map((row) => row.slot))].sort((a, b) => a - b),
    image_cleanup_not_queued: passed.filter((row) => row.kind === "image" && row.conversation_cleanup_status !== "queued").length,
  },
  results,
};
const reportPath = path.join(outputRoot, "concurrency_report.json");
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ report_path: reportPath, ...report.outcome, wall_ms: report.wall_ms }, null, 2));
if (failed.length) process.exitCode = 1;
