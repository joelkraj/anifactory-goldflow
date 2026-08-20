import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  acquireChatGptWebWorkerLease,
  CHATGPT_WEB_MEDIUM_REASONING_START_INTERVAL_MS,
  waitForChatGptWebStartWindow,
} from "./lib/chatgpt-web-worker-pool.mjs";
import {
  assertChatGptWebCooldownClear,
  recordChatGptWebRateLimit,
} from "./lib/chatgpt-web-throttle-state.mjs";

const execFileAsync = promisify(execFile);
const bridgeRoot = process.env.GOLDFLOW_CHATGPT_WEB_ROOT || "/Users/joel/codex-chatgpt-web-goldflow";
const runtimePath = process.env.GOLDFLOW_CHATGPT_WEB_RUNTIME
  || path.join(bridgeRoot, ".goldflow-runtime", "goldflow-jobs.mjs");
const descriptorPath = process.env.GOLDFLOW_CHATGPT_WEB_DESCRIPTOR
  || path.join(process.env.HOME || "/Users/joel", ".codex-chatgpt-web", "runtime", "launcher-browser.json");

function safeId(value) {
  return String(value).replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 96);
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

export function normalizeChatGptWebPlannerText(value) {
  // The browser bridge can expose Markdown source escapes outside code fences.
  // Decode only Markdown punctuation; preserve JSON escapes such as \n, \t,
  // escaped quotes, Unicode escapes, and Windows path separators.
  return String(value ?? "").replace(/\\([_*`{}\[\]()#+.!>|~-])/g, "$1");
}

export function chatGptWebPlannerStartWindowOptionsForTests({
  prompt,
  effort,
  timeoutMs,
  rateClass = null,
  minimumStartIntervalMs = null,
}) {
  const productionSizedPrompt = String(prompt ?? "").length >= 1_500;
  const productionSizedReasoning = productionSizedPrompt
    || effort === "high"
    || effort === "xhigh"
    || effort === "max";
  const mediumReasoning = productionSizedPrompt && effort === "medium";
  return {
    kind: "planner",
    rateClass: rateClass ?? (mediumReasoning ? "medium_reasoning" : productionSizedReasoning ? "reasoning" : "ordinary"),
    ...(minimumStartIntervalMs !== null
      && minimumStartIntervalMs !== undefined
      && Number.isFinite(Number(minimumStartIntervalMs))
      && Number(minimumStartIntervalMs) >= 0
      ? { minimumIntervalMs: Number(minimumStartIntervalMs) }
      : rateClass == null && mediumReasoning
        ? { minimumIntervalMs: CHATGPT_WEB_MEDIUM_REASONING_START_INTERVAL_MS }
        : {}),
    timeoutMs: Math.max(120_000, Number(timeoutMs) || 1_200_000),
  };
}

async function atomicWrite(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporaryPath, content, "utf8");
  await fs.rename(temporaryPath, filePath);
}

export async function runChatGptWebPlanner({
  prompt,
  outputPath,
  workId,
  model = "gpt-5.6-sol",
  effort,
  projectUrl = null,
  timeoutMs = 1_200_000,
  rateClass = null,
  minimumStartIntervalMs = null,
}) {
  await fs.access(runtimePath);
  await fs.access(descriptorPath);
  const id = safeId(workId || path.basename(outputPath, path.extname(outputPath)) || "planner");
  const runId = `goldflow_plan_${id}_${Date.now()}`;
  const runDir = path.join(path.dirname(outputPath), ".chatgpt-web-planner-jobs", runId);
  const manifestPath = path.join(runDir, "manifest.json");
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify({
    schema: "goldflow_chatgpt_jobs_v1",
    runId,
    descriptorPath,
    ...(projectUrl ? { projectUrl } : {}),
    outputDir: "./run",
    concurrency: 1,
    startIntervalMs: 0,
    rateLimitCooldownMs: 0,
    archiveSuccessfulImageChats: false,
    jobs: [{
      id: `plan_${id}`,
      kind: "llm",
      model,
      prompt: String(prompt ?? ""),
      effort,
      timeoutMs: Math.max(30_000, Math.min(3_600_000, Number(timeoutMs) || 1_200_000)),
    }],
  }, null, 2)}\n`, "utf8");

  await assertChatGptWebCooldownClear({ operation: `planner ${id}` });
  const lease = await acquireChatGptWebWorkerLease({ kind: "planner", workId: id, timeoutMs });
  let reasoningLease = null;
  let browserLease = null;
  let startGate = null;
  let processResult = null;
  let processError = null;
  try {
    if (effort === "xhigh" || effort === "max") {
      reasoningLease = await acquireChatGptWebWorkerLease({ kind: "deep_text", workId: id, timeoutMs });
    }
    const startWindowOptions = chatGptWebPlannerStartWindowOptionsForTests({
      prompt,
      effort,
      timeoutMs,
      rateClass,
      minimumStartIntervalMs,
    });
    startGate = await waitForChatGptWebStartWindow({
      ...startWindowOptions,
      workId: id,
    });
    browserLease = await acquireChatGptWebWorkerLease({ kind: "browser", workId: id, timeoutMs });
    await assertChatGptWebCooldownClear({ operation: `planner ${id}` });
    try {
      processResult = await execFileAsync(process.execPath, [runtimePath, "--manifest", manifestPath], {
        cwd: bridgeRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: Math.min(3_660_000, Number(timeoutMs) + 60_000),
      });
    } catch (error) {
      processError = error;
    }
    const reportPath = path.join(runDir, "run", "run_report.json");
    const report = await fs.readFile(reportPath, "utf8").then(JSON.parse).catch(() => null);
    const receipt = report?.receipts?.[0] ?? null;
    const artifact = receipt?.artifacts?.find((row) => row?.kind === "text") ?? null;
    const rawContent = artifact?.path
      ? await fs.readFile(artifact.path, "utf8").catch(() => "")
      : "";
    const content = normalizeChatGptWebPlannerText(rawContent);
    if (processError || receipt?.status !== "completed" || !artifact?.path || !content.trim()) {
      const detail = receipt?.error?.message
        || processError?.stderr
        || processError?.stdout
        || processError?.message
        || processResult?.stderr
        || processResult?.stdout
        || "missing receipt";
      throw new Error(`ChatGPT Web planning failed for ${id}: ${String(detail).slice(0, 2_000)}`);
    }
    await atomicWrite(outputPath, content);
    return {
      provider: "chatgpt_web",
      transport: "goldflow_authenticated_browser_jobs",
      model,
      reasoning_effort: effort,
      content,
      output_path: outputPath,
      source_path: artifact.path,
      source_sha256: artifact.sha256,
      normalized_output_sha256: sha256(content),
      response_normalization: rawContent === content ? "none" : "markdown_punctuation_unescape_v2",
      bridge_run_report_path: reportPath,
      bridge_receipt_path: path.join(runDir, "run", "receipts", `${receipt.jobId}.json`),
      bridge_duration_ms: receipt.durationMs ?? report.durationMs ?? null,
      browser_worker_pool: lease.pool,
      browser_worker_slot: lease.slot,
      browser_worker_wait_ms: lease.waited_ms,
      browser_reasoning_pool: reasoningLease?.pool ?? null,
      browser_reasoning_slot: reasoningLease?.slot ?? null,
      browser_reasoning_wait_ms: reasoningLease?.waited_ms ?? null,
      browser_host_pool: browserLease.pool,
      browser_host_slot: browserLease.slot,
      browser_host_wait_ms: browserLease.waited_ms,
      browser_start_gate: startGate,
      chatgpt_project_url: projectUrl,
    };
  } catch (error) {
    await recordChatGptWebRateLimit({ lane: "text", workId: id, error }).catch(() => null);
    throw error;
  } finally {
    await browserLease?.release();
    await reasoningLease?.release();
    await lease.release();
  }
}
