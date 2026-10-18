import { promises as fs } from "node:fs";
import path from "node:path";

import {
  nowIso,
  pathExists,
  randomToken,
  readJson,
  sha256,
  sleep,
  stableStringify,
  writeJsonAtomic,
} from "./util.mjs";

export const LLM_JOB_SCHEMA = "goldflow_studio_llm_job_v1";
export const DEFAULT_LLM_LEASE_SECONDS = 1800;
export const DEFAULT_PLANNER_RESERVATION_LINGER_MS = 120_000;

export function planningReservationStateForJobs(jobs = [], {
  reservedSlots = 2,
  lingerMs = DEFAULT_PLANNER_RESERVATION_LINGER_MS,
  nowMs = Date.now(),
} = {}) {
  const activeJobs = jobs.filter((job) => ["queued", "leased"].includes(String(job?.status)));
  const recentlyCompleted = jobs.filter((job) => {
    if (job?.status !== "completed") return false;
    const completedMs = Date.parse(job?.completed_at ?? job?.result?.completed_at ?? "");
    return Number.isFinite(completedMs) && nowMs - completedMs <= Math.max(0, Number(lingerMs) || 0);
  });
  const active = activeJobs.length > 0 || recentlyCompleted.length > 0;
  return {
    active,
    reserved_slots: active ? Math.max(0, Math.round(Number(reservedSlots) || 0)) : 0,
    queued_count: activeJobs.filter((job) => job.status === "queued").length,
    leased_count: activeJobs.filter((job) => job.status === "leased").length,
    recently_completed_count: recentlyCompleted.length,
    linger_ms: Math.max(0, Number(lingerMs) || 0),
  };
}

function normalizedRequest(request) {
  const messages = Array.isArray(request?.messages)
    ? request.messages.map((message) => ({
        role: String(message?.role ?? "user"),
        content: typeof message?.content === "string" ? message.content : stableStringify(message?.content ?? ""),
      }))
    : [];
  if (!messages.length) throw new Error("Chat completion requires at least one message.");
  return {
    model: String(request?.model ?? "gpt-6-sol").trim() || "gpt-6-sol",
    messages,
    temperature: request?.temperature ?? null,
    top_p: request?.top_p ?? null,
    max_tokens: request?.max_tokens ?? request?.max_completion_tokens ?? null,
    reasoning_effort: String(request?.reasoning_effort ?? request?.metadata?.reasoning_effort ?? "medium"),
    verbosity: String(request?.verbosity ?? request?.metadata?.verbosity ?? "medium"),
    stage_name: String(request?.metadata?.stage_name ?? request?.stage_name ?? "goldflow-planner"),
    response_format: request?.response_format ?? null,
  };
}

function normalizedResponseTimeoutMs(value) {
  const timeoutMs = Number(value);
  return Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.max(1_000, Math.round(timeoutMs))
    : null;
}

export function renderChatGptWebPrompt(request) {
  const sections = request.messages.map((message, index) => {
    const heading = String(message.role || "user").toUpperCase();
    return `--- ${heading} MESSAGE ${index + 1} ---\n${message.content}`;
  });
  return [
    "Complete this isolated Goldflow pipeline task.",
    "Follow the message hierarchy below. Return only the requested final answer, with no preface, progress report, or markdown fence unless the request explicitly requires one.",
    "Do not claim to have read local files or used tools unless their contents appear in these messages.",
    ...sections,
  ].join("\n\n");
}

export class LlmJobStore {
  constructor({ stateDir, leaseSeconds = DEFAULT_LLM_LEASE_SECONDS } = {}) {
    if (!stateDir) throw new Error("LlmJobStore requires stateDir.");
    this.stateDir = path.resolve(stateDir);
    this.jobsDir = path.join(this.stateDir, "llm-jobs");
    this.leaseSeconds = Math.max(60, Number(leaseSeconds) || DEFAULT_LLM_LEASE_SECONDS);
    this.queueLock = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.jobsDir, { recursive: true });
    await this.reconcileExpiredLeases();
    return this;
  }

  jobPath(jobId) {
    if (!/^[a-f0-9]{64}$/.test(String(jobId))) throw new Error("Invalid LLM job id.");
    return path.join(this.jobsDir, `${jobId}.json`);
  }

  async withQueueLock(callback) {
    const previous = this.queueLock;
    let release;
    this.queueLock = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }

  async createOrGet(rawRequest) {
    const request = normalizedRequest(rawRequest);
    const responseTimeoutMs = normalizedResponseTimeoutMs(rawRequest?.timeout_ms);
    const requestSha256 = sha256(stableStringify(request));
    const filePath = this.jobPath(requestSha256);
    return this.withQueueLock(async () => {
      const existing = await readJson(filePath);
      if (existing) {
        const existingTimeoutMs = normalizedResponseTimeoutMs(existing.response_timeout_ms);
        if (existing.status !== "completed"
          && responseTimeoutMs != null
          && (existingTimeoutMs == null || responseTimeoutMs > existingTimeoutMs)) {
          const updated = {
            ...existing,
            response_timeout_ms: responseTimeoutMs,
            updated_at: nowIso(),
          };
          await writeJsonAtomic(filePath, updated);
          return { job: updated, created: false };
        }
        return { job: existing, created: false };
      }
      const job = {
        schema: LLM_JOB_SCHEMA,
        job_id: requestSha256,
        request_sha256: requestSha256,
        status: "queued",
        attempt_count: 0,
        request,
        response_timeout_ms: responseTimeoutMs,
        web_prompt: renderChatGptWebPrompt(request),
        lease: null,
        result: null,
        error: null,
        created_at: nowIso(),
        first_leased_at: null,
        last_leased_at: null,
        completed_at: null,
        updated_at: nowIso(),
      };
      await writeJsonAtomic(filePath, job);
      return { job, created: true };
    });
  }

  async get(jobId) {
    return readJson(this.jobPath(jobId));
  }

  async list() {
    const names = (await fs.readdir(this.jobsDir).catch(() => [])).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    const jobs = (await Promise.all(names.map((name) => readJson(path.join(this.jobsDir, name))))).filter(Boolean);
    return jobs.sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
  }

  async reconcileExpiredLeases() {
    return this.withQueueLock(async () => {
      const changed = [];
      for (const job of await this.list()) {
        if (job.status !== "leased" || Date.parse(job.lease?.expires_at ?? 0) > Date.now()) continue;
        const repaired = {
          ...job,
          status: "needs_triage",
          error: {
            code: "lease_expired_after_submission",
            message: "The browser lease expired. Goldflow will not resubmit this creative call automatically.",
          },
          updated_at: nowIso(),
        };
        await writeJsonAtomic(this.jobPath(job.job_id), repaired);
        changed.push(job.job_id);
      }
      return changed;
    });
  }

  async leaseNext({ workerId, leaseSeconds = this.leaseSeconds } = {}) {
    if (!String(workerId ?? "").trim()) throw new Error("LLM lease requires workerId.");
    return this.withQueueLock(async () => {
      const jobs = await this.list();
      const existing = jobs.find((job) => job.status === "leased" && job.lease?.worker_id === workerId && Date.parse(job.lease?.expires_at ?? 0) > Date.now());
      if (existing) return { status: "leased", job: existing, reused_existing_lease: true };
      const candidate = jobs.find((job) => job.status === "queued" && Number(job.attempt_count ?? 0) === 0);
      if (!candidate) return { status: "no_work" };
      const leaseToken = randomToken(24);
      const leasedAt = nowIso();
      const leased = {
        ...candidate,
        status: "leased",
        attempt_count: 1,
        first_leased_at: candidate.first_leased_at ?? leasedAt,
        last_leased_at: leasedAt,
        lease: {
          lease_token: leaseToken,
          worker_id: workerId,
          leased_at: leasedAt,
          expires_at: new Date(Date.now() + Math.max(60, Number(leaseSeconds)) * 1000).toISOString(),
        },
        updated_at: leasedAt,
      };
      await writeJsonAtomic(this.jobPath(candidate.job_id), leased);
      return { status: "leased", job: leased, reused_existing_lease: false };
    });
  }

  assertLiveLease(job, { leaseToken, workerId }) {
    if (!job || job.status !== "leased") throw new Error("LLM job has no live lease.");
    if (job.lease?.lease_token !== leaseToken) throw new Error("LLM lease token does not own this job.");
    if (workerId && job.lease?.worker_id !== workerId) throw new Error("Worker does not own this LLM job.");
    if (Date.parse(job.lease?.expires_at ?? 0) <= Date.now()) throw new Error("LLM job lease has expired.");
  }

  async heartbeat({ jobId, leaseToken, workerId, leaseSeconds = this.leaseSeconds }) {
    return this.withQueueLock(async () => {
      const job = await this.get(jobId);
      this.assertLiveLease(job, { leaseToken, workerId });
      const updated = {
        ...job,
        lease: {
          ...job.lease,
          last_heartbeat_at: nowIso(),
          expires_at: new Date(Date.now() + Math.max(60, Number(leaseSeconds)) * 1000).toISOString(),
        },
        updated_at: nowIso(),
      };
      await writeJsonAtomic(this.jobPath(jobId), updated);
      return updated;
    });
  }

  async complete({ jobId, leaseToken, workerId, content, conversationUrl = null, uiContract = null }) {
    const finalContent = String(content ?? "").trim();
    if (!finalContent) throw new Error("LLM completion is empty.");
    return this.withQueueLock(async () => {
      const job = await this.get(jobId);
      this.assertLiveLease(job, { leaseToken, workerId });
      const completedAt = nowIso();
      const completed = {
        ...job,
        status: "completed",
        result: {
          content: finalContent,
          response_sha256: sha256(finalContent),
          conversation_url: conversationUrl,
          ui_contract: uiContract,
          completed_at: completedAt,
        },
        error: null,
        lease: null,
        completed_at: completedAt,
        updated_at: completedAt,
      };
      await writeJsonAtomic(this.jobPath(jobId), completed);
      return completed;
    });
  }

  async fail({ jobId, leaseToken, workerId, code = "browser_worker_failure", message = "Browser worker failed.", details = null }) {
    return this.withQueueLock(async () => {
      const job = await this.get(jobId);
      this.assertLiveLease(job, { leaseToken, workerId });
      const failed = {
        ...job,
        status: code === "lease_ambiguous" ? "needs_triage" : "failed",
        error: { code, message: String(message), details, failed_at: nowIso() },
        lease: null,
        updated_at: nowIso(),
      };
      await writeJsonAtomic(this.jobPath(jobId), failed);
      return failed;
    });
  }

  async requeue(jobId, reason) {
    if (!String(reason ?? "").trim()) throw new Error("Explicit requeue requires a reason.");
    return this.withQueueLock(async () => {
      const job = await this.get(jobId);
      if (!job) throw new Error("Unknown LLM job.");
      if (!new Set(["failed", "needs_triage"]).has(job.status)) throw new Error(`Only failed or triage jobs may be requeued; current status is ${job.status}.`);
      const requeued = {
        ...job,
        status: "queued",
        attempt_count: 0,
        lease: null,
        result: null,
        error: null,
        completed_at: null,
        manual_requeues: [...(job.manual_requeues ?? []), { reason: String(reason), at: nowIso() }],
        updated_at: nowIso(),
      };
      await writeJsonAtomic(this.jobPath(jobId), requeued);
      return requeued;
    });
  }

  async cancelQueued(jobId, reason) {
    if (!String(reason ?? "").trim()) throw new Error("Canceling an LLM job requires a reason.");
    return this.withQueueLock(async () => {
      const job = await this.get(jobId);
      if (!job) throw new Error("Unknown LLM job.");
      if (job.status !== "queued") throw new Error(`Only queued LLM jobs may be canceled; current status is ${job.status}.`);
      const canceled = {
        ...job,
        status: "failed",
        error: {
          code: "operator_canceled_before_lease",
          message: String(reason),
          failed_at: nowIso(),
        },
        lease: null,
        updated_at: nowIso(),
      };
      await writeJsonAtomic(this.jobPath(jobId), canceled);
      return canceled;
    });
  }

  async waitForCompletion(jobId, { timeoutMs = 600_000, signal = null } = {}) {
    const deadline = Date.now() + Math.max(1_000, Number(timeoutMs));
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("Chat completion request was aborted.");
      const job = await this.get(jobId);
      if (!job) throw new Error("LLM job disappeared from the durable queue.");
      if (job.status === "completed") return job;
      if (job.status === "failed" || job.status === "needs_triage") {
        const error = new Error(job.error?.message ?? `LLM job ended as ${job.status}.`);
        error.code = job.error?.code ?? job.status;
        throw error;
      }
      await sleep(250);
    }
    throw new Error(`Timed out waiting for ChatGPT web job ${jobId}. The job remains durable and will not be duplicated.`);
  }

  async summary() {
    const jobs = await this.list();
    const counts = Object.fromEntries(["queued", "leased", "completed", "failed", "needs_triage"].map((status) => [status, jobs.filter((job) => job.status === status).length]));
    return {
      counts,
      jobs: jobs.slice(-50).reverse().map((job) => ({
        job_id: job.job_id,
        stage_name: job.request?.stage_name,
        model: job.request?.model,
        status: job.status,
        attempt_count: job.attempt_count,
        worker_id: job.lease?.worker_id ?? null,
        created_at: job.created_at,
        first_leased_at: job.first_leased_at ?? null,
        last_leased_at: job.last_leased_at ?? null,
        completed_at: job.completed_at ?? job.result?.completed_at ?? null,
        updated_at: job.updated_at,
        error: job.error,
      })),
    };
  }

  async planningReservationState(options = {}) {
    return planningReservationStateForJobs(await this.list(), options);
  }
}
