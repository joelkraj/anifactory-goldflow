#!/usr/bin/env node

import { randomInt, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeBrowserProvider } from "./desktop/config.mjs";
import { GoldflowBridge } from "./lib/goldflow-bridge.mjs";
import { chatGptUiContractForLlmJob } from "./lib/chatgpt-ui-contract.mjs";
import { LlmJobStore } from "./lib/llm-job-store.mjs";
import { MediaJobStore } from "./lib/media-job-store.mjs";
import { WorkerRegistry } from "./lib/worker-registry.mjs";
import { compactError, nowIso, randomToken, writeJsonAtomic } from "./lib/util.mjs";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(appRoot, "../..");
const publicRoot = path.join(appRoot, "public");
const MAX_JSON_BYTES = 16 * 1024 * 1024;

function parseFlags(parts) {
  const flags = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--") ? parts[++index] : "true";
    flags[key] = value;
  }
  return flags;
}

function tokenEquals(left, right) {
  const leftBytes = Buffer.from(String(left ?? ""));
  const rightBytes = Buffer.from(String(right ?? ""));
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw Object.assign(new Error("Request body exceeds 16 MiB."), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { statusCode: 400 });
  }
}

function bearerToken(request) {
  const match = String(request.headers.authorization ?? "").match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function setBaseHeaders(response, origin = null) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  if (origin && /^chrome-extension:\/\/[a-z]{32}$/.test(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
}

function sendJson(response, statusCode, value, origin = null) {
  setBaseHeaders(response, origin);
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function sendText(response, statusCode, value, contentType = "text/plain; charset=utf-8") {
  setBaseHeaders(response);
  response.statusCode = statusCode;
  response.setHeader("Content-Type", contentType);
  response.end(value);
}

function mimeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return extension === ".html" ? "text/html; charset=utf-8"
    : extension === ".js" ? "text/javascript; charset=utf-8"
      : extension === ".css" ? "text/css; charset=utf-8"
        : "application/octet-stream";
}

function publicJob(job) {
  return {
    type: "llm",
    job_id: job.job_id,
    lease_token: job.lease.lease_token,
    expires_at: job.lease.expires_at,
    prompt: job.web_prompt,
    model: job.request.model,
    reasoning_effort: job.request.reasoning_effort,
    stage_name: job.request.stage_name,
  };
}

function publicMediaJob(job) {
  return {
    type: job.request.type,
    job_id: job.job_id,
    manifest_id: job.request.manifest_id,
    asset_id: job.request.asset_id,
    lease_token: job.lease.lease_token,
    expires_at: job.lease.expires_at,
    prompt: job.request.prompt,
    prompt_sha256: job.request.prompt_sha256,
    model_id: job.request.model_id,
    duration_sec: job.request.duration_sec,
    references: job.request.references,
    source: job.request.source,
  };
}

function leaseWorkerId(worker, slotValue, slotCeiling) {
  const slot = Number(slotValue ?? 0);
  if (!Number.isInteger(slot) || slot < 0 || slot > slotCeiling) {
    throw Object.assign(new Error(`Worker slot must be an integer from 0 through ${slotCeiling}.`), { statusCode: 400 });
  }
  return { slot, workerId: `${worker.worker_id}-slot-${slot}` };
}

export async function createStudioServer(options = {}) {
  const host = "127.0.0.1";
  const port = Number(options.port ?? process.env.GOLDFLOW_STUDIO_PORT ?? 4317);
  const repoRoot = path.resolve(options.repoRoot ?? process.env.GOLDFLOW_REPO_ROOT ?? defaultRepoRoot);
  const dataRoot = path.resolve(options.dataRoot ?? process.env.ANIFACTORY_DATA_ROOT ?? "/Users/joel/AniFactoryData");
  const rootStateDir = path.resolve(options.stateDir ?? process.env.GOLDFLOW_STUDIO_STATE_DIR ?? path.join(os.homedir(), ".goldflow-studio"));
  const browserProvider = normalizeBrowserProvider(options.browserProvider ?? process.env.GOLDFLOW_DESKTOP_PROVIDER ?? "chatgpt");
  const stateDir = browserProvider === "chatgpt" ? rootStateDir : path.join(rootStateDir, "providers", browserProvider);
  const workerSlotCeiling = browserProvider === "google-flow" ? 19 : 4;
  const downloadsRoot = path.resolve(options.downloadsRoot ?? process.env.GOLDFLOW_STUDIO_DOWNLOADS_ROOT ?? path.join(os.homedir(), "Downloads", "GoldflowStudio"));
  const adminToken = String(options.adminToken ?? process.env.GOLDFLOW_STUDIO_ADMIN_TOKEN ?? randomToken(32));
  const pairingCode = String(options.pairingCode ?? randomInt(100000, 1000000));
  const expectedUiContract = browserProvider === "google-flow"
    ? {
        provider: "google-flow",
        account_plan: String(options.flowPlanLabel ?? process.env.GOLDFLOW_FLOW_PLAN ?? "ULTRA"),
        model_label: String(options.flowModelLabel ?? process.env.GOLDFLOW_FLOW_MODEL ?? "Nano Banana Pro"),
        video_model_label: String(options.flowVideoModelLabel ?? process.env.GOLDFLOW_FLOW_VIDEO_MODEL ?? "Veo 3.1 Fast"),
        aspect_ratio: "16:9",
        output_count: 1,
      }
    : browserProvider === "google-gemini"
      ? {
          provider: "google-gemini",
          account_plan: String(options.geminiPlanLabel ?? process.env.GOLDFLOW_GEMINI_PLAN ?? "Ultra"),
          model_label: String(options.geminiModelLabel ?? process.env.GOLDFLOW_GEMINI_MODEL ?? "Nano Banana 2"),
          aspect_ratio: "16:9",
          output_count: 1,
        }
      : {
        provider: "chatgpt",
        account_plan: String(process.env.GOLDFLOW_STUDIO_CHATGPT_PLAN ?? "Pro"),
        model_label: String(process.env.GOLDFLOW_STUDIO_CHATGPT_MODEL_LABEL ?? "GPT-5.6 Sol"),
        effort_label: String(process.env.GOLDFLOW_STUDIO_CHATGPT_EFFORT ?? "Medium"),
      };
  const llmJobs = await new LlmJobStore({ stateDir }).init();
  const mediaJobs = await new MediaJobStore({ stateDir, downloadsRoot }).init();
  const workers = await new WorkerRegistry({ stateDir }).init();
  const bridge = await new GoldflowBridge({ repoRoot, dataRoot, stateDir, downloadsRoot, browserProvider }).init();
  const runtime = {
    paused: false,
    pause_reason: null,
    started_at: nowIso(),
  };

  function routeEnvironment(actualPort) {
    if (browserProvider === "google-gemini") {
      return {
        ANIFACTORY_LLM_ROUTE: "gemini-web",
        ANIFACTORY_GEMINI_WEB_URL: `http://${host}:${actualPort}/v1`,
        ANIFACTORY_GEMINI_WEB_TOKEN: adminToken,
        ANIFACTORY_GEMINI_WEB_MODEL: String(options.geminiTextModelLabel ?? process.env.GOLDFLOW_GEMINI_TEXT_MODEL ?? "gemini-3.6-flash-web"),
      };
    }
    return {
      ANIFACTORY_LLM_ROUTE: "chatgpt-web",
      ANIFACTORY_CHATGPT_WEB_URL: `http://${host}:${actualPort}/v1`,
      ANIFACTORY_CHATGPT_WEB_TOKEN: adminToken,
      ANIFACTORY_CHATGPT_WEB_MODEL: "gpt-5.6-sol",
      ANIFACTORY_CHATGPT_WEB_REASONING_EFFORT: expectedUiContract.effort_label.toLowerCase(),
    };
  }

  async function requireAdmin(request) {
    if (!tokenEquals(bearerToken(request), adminToken)) throw Object.assign(new Error("Admin authorization required."), { statusCode: 401 });
  }

  async function requireWorker(request) {
    const worker = await workers.authenticate(bearerToken(request));
    if (!worker) throw Object.assign(new Error("Worker authorization required."), { statusCode: 401 });
    return worker;
  }

  async function handler(request, response) {
    const origin = String(request.headers.origin ?? "");
    if (request.method === "OPTIONS") {
      setBaseHeaders(response, origin);
      response.statusCode = 204;
      response.end();
      return;
    }
    const url = new URL(request.url, `http://${host}`);
    try {
      if (request.method === "GET" && url.pathname === "/v1/health") {
        sendJson(response, 200, {
          status: "ok",
          service: "goldflow-studio",
          paused: runtime.paused,
          started_at: runtime.started_at,
          browser_provider: browserProvider,
          worker_slot_ceiling: workerSlotCeiling,
          ui_contract: expectedUiContract,
        }, origin);
        return;
      }

      if (request.method === "GET" && url.pathname === "/app-config.js") {
        sendText(response, 200, `window.GOLDFLOW_STUDIO_CONFIG=${JSON.stringify({
          adminToken,
          pairingCode,
          apiBase: "/v1",
          dataRoot,
          downloadsRoot,
          browserProvider,
          workerSlotCeiling,
          uiContract: expectedUiContract,
        })};\n`, "text/javascript; charset=utf-8");
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/pair") {
        const body = await readJsonBody(request);
        if (!tokenEquals(body.code, pairingCode)) throw Object.assign(new Error("Pairing code is invalid."), { statusCode: 401 });
        const requestedProvider = normalizeBrowserProvider(body.browserProvider ?? "chatgpt");
        if (requestedProvider !== browserProvider) {
          throw Object.assign(new Error(`This Goldflow server accepts ${browserProvider} workers, not ${requestedProvider}.`), { statusCode: 409 });
        }
        const paired = await workers.pair(body.label);
        sendJson(response, 201, { status: "paired", ...paired, browser_provider: browserProvider, ui_contract: expectedUiContract }, origin);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        if (!["chatgpt", "google-gemini"].includes(browserProvider)) {
          throw Object.assign(new Error(`${browserProvider} does not expose text planning.`), { statusCode: 400 });
        }
        await requireAdmin(request);
        const body = await readJsonBody(request);
        if (body.stream === true) throw Object.assign(new Error("Streaming is not supported by the audited ChatGPT web transport."), { statusCode: 400 });
        const { job } = await llmJobs.createOrGet(body);
        if (job.status === "failed" || job.status === "needs_triage") {
          throw Object.assign(new Error(job.error?.message ?? `Job is ${job.status}; explicit requeue is required.`), { statusCode: 409, code: job.error?.code });
        }
        const finalJob = job.status === "completed"
          ? job
          : await llmJobs.waitForCompletion(job.job_id, { timeoutMs: Number(body.timeout_ms ?? 3_600_000) });
        sendJson(response, 200, {
          id: `chatcmpl-${finalJob.job_id.slice(0, 24)}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: finalJob.request.model,
          choices: [{ index: 0, message: { role: "assistant", content: finalJob.result.content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          goldflow_job_id: finalJob.job_id,
          cached: job.status === "completed",
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/media/jobs") {
        if (browserProvider !== "google-flow") {
          throw Object.assign(new Error(`${browserProvider} does not expose generated-video work.`), { statusCode: 400 });
        }
        await requireAdmin(request);
        const created = await mediaJobs.createOrGet(await readJsonBody(request));
        sendJson(response, created.created ? 201 : 200, {
          status: created.job.status,
          created: created.created,
          job: created.job,
        }, origin);
        return;
      }

      const mediaJobMatch = url.pathname.match(/^\/v1\/media\/jobs\/([a-f0-9]{64})$/);
      if (request.method === "GET" && mediaJobMatch) {
        await requireAdmin(request);
        const job = await mediaJobs.get(mediaJobMatch[1]);
        if (!job) throw Object.assign(new Error("Unknown media job."), { statusCode: 404 });
        sendJson(response, 200, { status: job.status, job }, origin);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/worker/lease") {
        const worker = await requireWorker(request);
        if (runtime.paused) {
          sendJson(response, 200, { status: "paused", reason: runtime.pause_reason }, origin);
          return;
        }
        const body = await readJsonBody(request);
        const leaseWorker = leaseWorkerId(worker, body.slot, workerSlotCeiling);
        const types = Array.isArray(body.types) ? body.types : ["llm", "image"];
        const allowedTypes = browserProvider === "chatgpt"
          ? new Set(["llm", "image"])
          : browserProvider === "google-gemini"
            ? new Set(["llm", "image"])
            : new Set(["image", "video"]);
        if (types.some((type) => !allowedTypes.has(type))) {
          throw Object.assign(new Error(`${browserProvider} workers may lease only ${[...allowedTypes].join(", ")} work.`), { statusCode: 400 });
        }
        if (types.includes("llm")) {
          const llmLease = await llmJobs.leaseNext({ workerId: leaseWorker.workerId });
          if (llmLease.status === "leased") {
            sendJson(response, 200, {
              status: "leased",
              job: publicJob(llmLease.job),
              worker_slot: leaseWorker.slot,
              reused_existing_lease: llmLease.reused_existing_lease === true,
              ui_contract: browserProvider === "chatgpt"
                ? chatGptUiContractForLlmJob(expectedUiContract, llmLease.job)
                : { ...expectedUiContract, task_type: "llm", model_label: llmLease.job.request.model },
            }, origin);
            return;
          }
        }
        const leaseImage = async () => {
          if (!types.includes("image")) return false;
          const imageLease = await bridge.leaseImage(leaseWorker.workerId);
          if (imageLease.status !== "leased") return false;
          sendJson(response, 200, { ...imageLease, worker_slot: leaseWorker.slot, ui_contract: expectedUiContract }, origin);
          return true;
        };
        const leaseVideo = async () => {
          if (!types.includes("video")) return false;
          const mediaLease = await mediaJobs.leaseNext({ workerId: leaseWorker.workerId });
          if (mediaLease.status !== "leased") return false;
          sendJson(response, 200, {
            status: "leased",
            job: publicMediaJob(mediaLease.job),
            worker_slot: leaseWorker.slot,
            reused_existing_lease: mediaLease.reused_existing_lease === true,
            ui_contract: {
              ...expectedUiContract,
              task_type: "video",
              model_label: mediaLease.job.request.model_id,
              duration_sec: mediaLease.job.request.duration_sec,
              input_binding: "first_frame",
            },
          }, origin);
          return true;
        };
        // Fast-premium Flow uses five slots. Slots four and five prefer motion,
        // while every idle slot may help the other queue.
        const videoPreferred = browserProvider === "google-flow" && leaseWorker.slot >= 3;
        if (videoPreferred ? await leaseVideo() || await leaseImage() : await leaseImage() || await leaseVideo()) return;
        sendJson(response, 200, { status: "no_work" }, origin);
        return;
      }

      const referenceMatch = url.pathname.match(/^\/v1\/worker\/image-reference\/([^/]+)\/([^/]+)\/(\d+)$/);
      if (request.method === "GET" && referenceMatch) {
        const worker = await requireWorker(request);
        const result = await bridge.imageReference({
          manifestId: decodeURIComponent(referenceMatch[1]),
          assetId: decodeURIComponent(referenceMatch[2]),
          slot: Number(referenceMatch[3]),
          leaseToken: url.searchParams.get("lease_token"),
          workerId: null,
        });
        setBaseHeaders(response, origin);
        response.statusCode = 200;
        response.setHeader("Content-Type", result.mimeType);
        response.setHeader("Content-Disposition", `inline; filename="${result.filename.replaceAll('"', "")}"`);
        response.end(result.bytes);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/worker/heartbeat") {
        const worker = await requireWorker(request);
        const body = await readJsonBody(request);
        const leaseWorker = leaseWorkerId(worker, body.slot, workerSlotCeiling);
        const result = body.type === "image"
          ? await bridge.heartbeatImage({ ...body, workerId: leaseWorker.workerId })
          : body.type === "video"
            ? await mediaJobs.heartbeat({ jobId: body.jobId, leaseToken: body.leaseToken, workerId: leaseWorker.workerId })
            : await llmJobs.heartbeat({ jobId: body.jobId, leaseToken: body.leaseToken, workerId: leaseWorker.workerId });
        sendJson(response, 200, { status: "live", result }, origin);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/worker/complete") {
        const worker = await requireWorker(request);
        const body = await readJsonBody(request);
        const leaseWorker = leaseWorkerId(worker, body.slot, workerSlotCeiling);
        const result = body.type === "image"
          ? await bridge.completeImage({ ...body, workerId: leaseWorker.workerId })
          : body.type === "video"
            ? await mediaJobs.complete({
                jobId: body.jobId,
                leaseToken: body.leaseToken,
                workerId: leaseWorker.workerId,
                downloadPath: body.downloadPath,
                sourceUrl: body.sourceUrl,
                conversationUrl: body.conversationUrl,
                uiContract: body.uiContract,
              })
            : await llmJobs.complete({
              jobId: body.jobId,
              leaseToken: body.leaseToken,
              workerId: leaseWorker.workerId,
              content: body.content,
              conversationUrl: body.conversationUrl,
              uiContract: body.uiContract,
            });
        sendJson(response, 200, { status: "completed", result }, origin);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/worker/fail") {
        const worker = await requireWorker(request);
        const body = await readJsonBody(request);
        const leaseWorker = leaseWorkerId(worker, body.slot, workerSlotCeiling);
        if ((browserProvider !== "chatgpt" && ["image", "video"].includes(body.type)) || ["rate_limited", "usage_limited", "account_mismatch", "ui_contract_mismatch"].includes(body.code)) {
          runtime.paused = true;
          runtime.pause_reason = {
            code: body.code,
            message: body.message,
            browser_provider: browserProvider,
            manifest_id: body.manifestId ?? null,
            asset_id: body.assetId ?? null,
            worker_id: worker.worker_id,
            at: nowIso(),
          };
        }
        const result = body.type === "image"
          ? await bridge.failImage({ ...body, workerId: leaseWorker.workerId, error: `${body.code ?? "browser_worker_failure"}: ${body.message ?? "unknown"}` })
          : body.type === "video"
            ? await mediaJobs.fail({
                jobId: body.jobId,
                leaseToken: body.leaseToken,
                workerId: leaseWorker.workerId,
                code: body.code,
                message: body.message,
                details: body.details,
              })
            : await llmJobs.fail({
              jobId: body.jobId,
              leaseToken: body.leaseToken,
              workerId: leaseWorker.workerId,
              code: body.code,
              message: body.message,
              details: body.details,
            });
        sendJson(response, 200, { status: "recorded", paused: runtime.paused, result }, origin);
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/dashboard/state") {
        await requireAdmin(request);
        sendJson(response, 200, {
          status: "ok",
          runtime,
          browser_provider: browserProvider,
          ui_contract: expectedUiContract,
          workers: await workers.list(),
          llm: await llmJobs.summary(),
          media: await mediaJobs.summary(),
          image_manifests: await bridge.allImageManifestSummaries(),
          config: { data_root: dataRoot, downloads_root: downloadsRoot, browser_provider: browserProvider, worker_slot_ceiling: workerSlotCeiling, route: ["chatgpt", "google-gemini"].includes(browserProvider) ? routeEnvironment(server.address()?.port ?? port) : null },
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/dashboard/pause") {
        await requireAdmin(request);
        const body = await readJsonBody(request);
        runtime.paused = body.paused !== false;
        runtime.pause_reason = runtime.paused ? { code: "operator_pause", message: String(body.reason ?? "Paused by operator."), at: nowIso() } : null;
        sendJson(response, 200, { status: runtime.paused ? "paused" : "running", runtime });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/dashboard/llm/requeue") {
        await requireAdmin(request);
        const body = await readJsonBody(request);
        sendJson(response, 200, { status: "requeued", job: await llmJobs.requeue(body.jobId, body.reason) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/dashboard/media/requeue") {
        await requireAdmin(request);
        const body = await readJsonBody(request);
        sendJson(response, 200, { status: "requeued", job: await mediaJobs.requeue(body.jobId, body.reason) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/dashboard/manifests/create") {
        await requireAdmin(request);
        sendJson(response, 201, await bridge.createManifest(await readJsonBody(request)));
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/dashboard/manifests/activate") {
        await requireAdmin(request);
        const body = await readJsonBody(request);
        sendJson(response, 200, { status: "active", manifest: await bridge.activateManifest(body.manifestPath) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/dashboard/manifests/deactivate") {
        await requireAdmin(request);
        const body = await readJsonBody(request);
        sendJson(response, 200, await bridge.deactivateManifest(body.manifestPath));
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/dashboard/run/status") {
        await requireAdmin(request);
        const body = await readJsonBody(request);
        sendJson(response, 200, await bridge.runStatus(body.episodeDir));
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/dashboard/run/advance") {
        if (browserProvider !== "chatgpt") throw Object.assign(new Error("Pipeline advance is disabled on the image-only Google Flow proof server."), { statusCode: 400 });
        await requireAdmin(request);
        const body = await readJsonBody(request);
        const actualPort = server.address()?.port ?? port;
        sendJson(response, 200, await bridge.runAdvance({
          episodeDir: body.episodeDir,
          dryRun: body.execute !== true,
          maxSteps: body.maxSteps ?? 1,
          routeEnvironment: routeEnvironment(actualPort),
        }));
        return;
      }

      if (request.method === "GET") {
        const relative = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
        const resolved = path.resolve(publicRoot, relative);
        if (resolved.startsWith(`${publicRoot}${path.sep}`) || resolved === path.join(publicRoot, "index.html")) {
          const bytes = await fs.readFile(resolved).catch(() => null);
          if (bytes) {
            setBaseHeaders(response);
            response.statusCode = 200;
            response.setHeader("Content-Type", mimeFor(resolved));
            response.end(bytes);
            return;
          }
        }
      }

      sendJson(response, 404, { status: "not_found", path: url.pathname }, origin);
    } catch (error) {
      sendJson(response, Number(error?.statusCode ?? 500), {
        status: "failed",
        code: error?.code ?? "studio_error",
        error: compactError(error),
      }, origin);
    }
  }

  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  await writeJsonAtomic(path.join(stateDir, "studio-runtime.json"), {
    schema: "goldflow_studio_runtime_v1",
    status: "running",
    pid: process.pid,
    host,
    port: actualPort,
    data_root: dataRoot,
    downloads_root: downloadsRoot,
    browser_provider: browserProvider,
    worker_slot_ceiling: workerSlotCeiling,
    ui_contract: expectedUiContract,
    started_at: runtime.started_at,
  });
  return {
    server,
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    adminToken,
    pairingCode,
    expectedUiContract,
    browserProvider,
    workerSlotCeiling,
    stateDir,
    llmJobs,
    mediaJobs,
    workers,
    bridge,
    routeEnvironment: () => routeEnvironment(actualPort),
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const studio = await createStudioServer(studioServerOptionsFromFlags(flags));
  process.stdout.write(["", "Goldflow Studio is ready.", `Dashboard: ${studio.url}`, `Chrome pairing code: ${studio.pairingCode}`, "Press Ctrl+C to stop.", ""].join("\n"));
  const stop = async () => {
    await studio.close().catch(() => {});
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

export function studioServerOptionsFromFlags(flags = {}) {
  return {
    port: flags.port ? Number(flags.port) : undefined,
    stateDir: flags["state-dir"],
    dataRoot: flags["data-root"],
    downloadsRoot: flags["downloads-root"],
    browserProvider: flags.provider,
    flowPlanLabel: flags["flow-plan"],
    flowModelLabel: flags["flow-model"],
    flowVideoModelLabel: flags["flow-video-model"],
    geminiPlanLabel: flags["gemini-plan"],
    geminiModelLabel: flags["gemini-model"],
  };
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(compactError(error));
    process.exitCode = 1;
  });
}
