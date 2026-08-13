import { promises as fs } from "node:fs";
import path from "node:path";

import {
  nowIso,
  randomToken,
  readJson,
  sha256,
  sha256File,
  sleep,
  stableStringify,
  writeJsonAtomic,
} from "./util.mjs";

export const MEDIA_JOB_SCHEMA = "goldflow_studio_media_job_v1";
export const DEFAULT_MEDIA_LEASE_SECONDS = 3600;

function clean(value) {
  return String(value ?? "").trim();
}

function normalizedReference(reference, index) {
  const filePath = path.resolve(clean(reference?.path));
  const fileHash = clean(reference?.sha256).toLowerCase();
  if (!path.isAbsolute(filePath) || !/^[a-f0-9]{64}$/.test(fileHash)) {
    throw new Error(`Media reference ${index + 1} requires an absolute path and lowercase SHA-256.`);
  }
  return {
    slot: index + 1,
    ref_id: clean(reference?.ref_id) || `reference-${index + 1}`,
    path: filePath,
    sha256: fileHash,
  };
}

function normalizedRequest(request = {}) {
  const type = clean(request.type).toLowerCase();
  if (type !== "video") throw new Error("Goldflow Studio media jobs currently support video only.");
  const prompt = clean(request.prompt);
  if (!prompt) throw new Error("Video generation requires a non-empty prompt.");
  const references = (Array.isArray(request.references) ? request.references : [])
    .map(normalizedReference);
  if (references.length !== 1) throw new Error("Google Flow video generation requires exactly one first-frame reference.");
  const durationSec = Math.max(4, Math.min(10, Math.round(Number(request.duration_sec ?? 8))));
  return {
    type,
    manifest_id: clean(request.manifest_id) || "goldflow-generated-motion",
    asset_id: clean(request.asset_id),
    prompt,
    prompt_sha256: sha256(prompt),
    model_id: clean(request.model_id) || "Veo 3.1 Fast",
    duration_sec: durationSec,
    references,
    source: request.source && typeof request.source === "object" ? request.source : {},
  };
}

export class MediaJobStore {
  constructor({ stateDir, downloadsRoot, leaseSeconds = DEFAULT_MEDIA_LEASE_SECONDS } = {}) {
    if (!stateDir || !downloadsRoot) throw new Error("MediaJobStore requires stateDir and downloadsRoot.");
    this.stateDir = path.resolve(stateDir);
    this.downloadsRoot = path.resolve(downloadsRoot);
    this.jobsDir = path.join(this.stateDir, "media-jobs");
    this.leaseSeconds = Math.max(60, Number(leaseSeconds) || DEFAULT_MEDIA_LEASE_SECONDS);
    this.queueLock = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.jobsDir, { recursive: true });
    await this.reconcileExpiredLeases();
    return this;
  }

  jobPath(jobId) {
    if (!/^[a-f0-9]{64}$/.test(String(jobId))) throw new Error("Invalid media job id.");
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
    if (!request.asset_id) throw new Error("Video generation requires asset_id.");
    for (const reference of request.references) {
      const stat = await fs.stat(reference.path).catch(() => null);
      if (!stat?.isFile()) throw new Error(`Media reference is missing: ${reference.path}`);
      if (await sha256File(reference.path) !== reference.sha256) {
        throw new Error(`Media reference hash is stale: ${reference.path}`);
      }
    }
    const requestSha256 = sha256(stableStringify(request));
    const filePath = this.jobPath(requestSha256);
    return this.withQueueLock(async () => {
      const existing = await readJson(filePath);
      if (existing) return { job: existing, created: false };
      const job = {
        schema: MEDIA_JOB_SCHEMA,
        job_id: requestSha256,
        request_sha256: requestSha256,
        status: "queued",
        attempt_count: 0,
        request,
        lease: null,
        result: null,
        error: null,
        created_at: nowIso(),
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
    const names = (await fs.readdir(this.jobsDir).catch(() => []))
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    const jobs = (await Promise.all(names.map((name) => readJson(path.join(this.jobsDir, name)))))
      .filter(Boolean);
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
          lease: null,
          error: {
            code: "lease_expired_after_submission",
            message: "The browser lease expired. Goldflow will not resubmit this creative video call automatically.",
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
    if (!clean(workerId)) throw new Error("Media lease requires workerId.");
    return this.withQueueLock(async () => {
      const jobs = await this.list();
      const existing = jobs.find((job) => job.status === "leased"
        && job.lease?.worker_id === workerId
        && Date.parse(job.lease?.expires_at ?? 0) > Date.now());
      if (existing) return { status: "leased", job: existing, reused_existing_lease: true };
      const candidate = jobs.find((job) => job.status === "queued" && Number(job.attempt_count ?? 0) === 0);
      if (!candidate) return { status: "no_work" };
      const leasedAt = nowIso();
      const leased = {
        ...candidate,
        status: "leased",
        attempt_count: 1,
        lease: {
          lease_token: randomToken(24),
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
    if (!job || job.status !== "leased") throw new Error("Media job has no live lease.");
    if (job.lease?.lease_token !== leaseToken) throw new Error("Media lease token does not own this job.");
    if (workerId && job.lease?.worker_id !== workerId) throw new Error("Worker does not own this media job.");
    if (Date.parse(job.lease?.expires_at ?? 0) <= Date.now()) throw new Error("Media job lease has expired.");
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

  async complete({ jobId, leaseToken, workerId, downloadPath, sourceUrl = null, conversationUrl = null, uiContract = null }) {
    const resolvedOutput = path.resolve(clean(downloadPath));
    const relative = path.relative(this.downloadsRoot, resolvedOutput);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Media completion path must be a generated file under the Studio downloads root.");
    }
    const stat = await fs.stat(resolvedOutput).catch(() => null);
    if (!stat?.isFile() || stat.size < 100_000) throw new Error("Media completion is missing, empty, or implausibly small.");
    const outputSha256 = await sha256File(resolvedOutput);
    return this.withQueueLock(async () => {
      const job = await this.get(jobId);
      this.assertLiveLease(job, { leaseToken, workerId });
      const completed = {
        ...job,
        status: "completed",
        result: {
          download_path: resolvedOutput,
          output_sha256: outputSha256,
          size_bytes: stat.size,
          source_url: sourceUrl,
          conversation_url: conversationUrl,
          ui_contract: uiContract,
          completed_at: nowIso(),
        },
        error: null,
        lease: null,
        updated_at: nowIso(),
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
        error: { code, message: clean(message), details, failed_at: nowIso() },
        lease: null,
        updated_at: nowIso(),
      };
      await writeJsonAtomic(this.jobPath(jobId), failed);
      return failed;
    });
  }

  async requeue(jobId, reason) {
    if (!clean(reason)) throw new Error("Explicit media requeue requires a reason.");
    return this.withQueueLock(async () => {
      const job = await this.get(jobId);
      if (!job) throw new Error("Unknown media job.");
      if (!new Set(["failed", "needs_triage"]).has(job.status)) {
        throw new Error(`Only failed or triage media jobs may be requeued; current status is ${job.status}.`);
      }
      const requeued = {
        ...job,
        status: "queued",
        attempt_count: 0,
        lease: null,
        result: null,
        error: null,
        manual_requeues: [...(job.manual_requeues ?? []), { reason: clean(reason), at: nowIso() }],
        updated_at: nowIso(),
      };
      await writeJsonAtomic(this.jobPath(jobId), requeued);
      return requeued;
    });
  }

  async waitForCompletion(jobId, { timeoutMs = 3_600_000, signal = null } = {}) {
    const deadline = Date.now() + Math.max(1_000, Number(timeoutMs));
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("Media generation wait was aborted.");
      const job = await this.get(jobId);
      if (!job) throw new Error("Media job disappeared from the durable queue.");
      if (job.status === "completed") return job;
      if (["failed", "needs_triage"].includes(job.status)) {
        const error = new Error(job.error?.message ?? `Media job ended as ${job.status}.`);
        error.code = job.error?.code ?? job.status;
        throw error;
      }
      await sleep(500);
    }
    throw new Error(`Timed out waiting for media job ${jobId}. The durable job remains queued or leased and will not be duplicated.`);
  }

  async summary() {
    const jobs = await this.list();
    const counts = Object.fromEntries(["queued", "leased", "completed", "failed", "needs_triage"]
      .map((status) => [status, jobs.filter((job) => job.status === status).length]));
    return {
      counts,
      jobs: jobs.slice(-50).reverse().map((job) => ({
        job_id: job.job_id,
        type: job.request?.type,
        asset_id: job.request?.asset_id,
        model_id: job.request?.model_id,
        status: job.status,
        attempt_count: job.attempt_count,
        worker_id: job.lease?.worker_id ?? null,
        created_at: job.created_at,
        updated_at: job.updated_at,
        error: job.error,
      })),
    };
  }
}
