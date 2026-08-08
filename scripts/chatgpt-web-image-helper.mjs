import { execFile } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { chatGptWebConversationScope } from "./lib/chatgpt-web-project.mjs";
import {
  acquireChatGptWebWorkerLease,
  waitForChatGptWebStartWindow,
} from "./lib/chatgpt-web-worker-pool.mjs";
import { queueChatGptWebConversationArchive } from "./lib/chatgpt-web-archive-queue.mjs";
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

export async function generateChatGptWebImage({
  prompt,
  outputPath,
  referenceImagePaths = [],
  workId,
  projectUrl = null,
}) {
  await fs.access(runtimePath);
  await fs.access(descriptorPath);
  const id = safeId(workId || path.basename(outputPath, path.extname(outputPath)));
  const runId = `goldflow_prod_${id}_${Date.now()}`;
  const runDir = path.join(path.dirname(outputPath), ".chatgpt-web-jobs", runId);
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
    // Conversation mutation has a much lower throttle than image generation.
    // Queue successful chats for one serialized cleanup lane instead.
    archiveSuccessfulImageChats: false,
    jobs: [{
      id: `image_${id}`,
      kind: "image",
      prompt,
      effort: "medium",
      references: referenceImagePaths.map((referencePath, index) => ({
        path: referencePath,
        name: `reference_${String(index + 1).padStart(2, "0")}${path.extname(referencePath).toLowerCase() || ".png"}`,
      })),
      expectedImageCount: 1,
      expectedAspectRatio: "16:9",
      timeoutMs: 1_200_000,
    }],
  }, null, 2)}\n`, "utf8");
  await assertChatGptWebCooldownClear({ operation: `image ${id}` });
  const lease = await acquireChatGptWebWorkerLease({ kind: "image", workId: id, timeoutMs: 1_200_000 });
  let browserLease = null;
  let startGate = null;
  let processResult = null;
  let processError = null;
  try {
    startGate = await waitForChatGptWebStartWindow({ kind: "image", workId: id });
    browserLease = await acquireChatGptWebWorkerLease({ kind: "browser", workId: id, timeoutMs: 1_200_000 });
    await assertChatGptWebCooldownClear({ operation: `image ${id}` });
    try {
      processResult = await execFileAsync(process.execPath, [runtimePath, "--manifest", manifestPath], {
        cwd: bridgeRoot,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: 1_260_000,
      });
    } catch (error) {
      processError = error;
    }
    const reportPath = path.join(runDir, "run", "run_report.json");
    const report = await fs.readFile(reportPath, "utf8").then(JSON.parse).catch(() => null);
    const receipt = report?.receipts?.[0] ?? null;
    const artifact = receipt?.artifacts?.find((row) => row?.kind === "image") ?? null;
    if (processError || receipt?.status !== "completed" || !artifact?.path) {
      throw new Error(`ChatGPT Web image generation failed for ${id}: ${receipt?.error?.message || processError?.stderr || processError?.stdout || processError?.message || processResult?.stderr || processResult?.stdout || "missing receipt"}`.slice(0, 2_000));
    }
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.copyFile(artifact.path, outputPath, fsConstants.COPYFILE_EXCL);
    const conversationScope = chatGptWebConversationScope(artifact.conversationUrl);
    const archiveQueue = conversationScope === "regular"
      ? await queueChatGptWebConversationArchive({
        conversationUrl: artifact.conversationUrl,
        workId: id,
      })
      : null;
    return {
      provider: "chatgpt_web_gpt_image",
      model: "chatgpt_web_gpt_image",
      downloaded_path: outputPath,
      source_path: artifact.path,
      source_sha256: artifact.sha256,
      source_file_id: artifact.sourceFileId ?? null,
      conversation_url: artifact.conversationUrl ?? null,
      conversation_archive_status: artifact.conversationArchiveStatus ?? null,
      conversation_archive_error: artifact.conversationArchiveError ?? null,
      conversation_scope: conversationScope,
      conversation_cleanup_status: archiveQueue
        ? "queued"
        : conversationScope === "project"
          ? "project_scoped"
          : conversationScope === "temporary"
            ? "temporary_chat"
            : "not_applicable",
      conversation_archive_queue_id: archiveQueue?.queue_id ?? null,
      conversation_archive_queue_path: archiveQueue?.queue_path ?? null,
      bridge_run_report_path: reportPath,
      bridge_duration_ms: report.durationMs ?? null,
      browser_worker_pool: lease.pool,
      browser_worker_slot: lease.slot,
      browser_worker_wait_ms: lease.waited_ms,
      browser_host_pool: browserLease.pool,
      browser_host_slot: browserLease.slot,
      browser_host_wait_ms: browserLease.waited_ms,
      browser_start_gate: startGate,
      estimated_cost_usd: 0,
    };
  } catch (error) {
    await recordChatGptWebRateLimit({ lane: "image", workId: id, error }).catch(() => null);
    throw error;
  } finally {
    await browserLease?.release();
    await lease.release();
  }
}
