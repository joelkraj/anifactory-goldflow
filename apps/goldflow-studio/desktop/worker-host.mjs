import { promises as fs } from "node:fs";

import { ChatGptBrowser } from "./chatgpt-browser.mjs";
import { GoogleFlowBrowser } from "./google-flow-browser.mjs";
import { GoogleGeminiBrowser } from "./google-gemini-browser.mjs";
import { assertDesktopConfig } from "./config.mjs";
import { DesktopRuntimeState } from "./runtime-state.mjs";
import { GoldflowWorkerClient } from "./worker-client.mjs";

function nowIso() {
  return new Date().toISOString();
}

function normalizeError(error, fallbackCode = "browser_worker_failure") {
  const normalized = error instanceof Error ? error : new Error(String(error));
  normalized.code = normalized.code ?? fallbackCode;
  return normalized;
}

const PERSISTENT_WORKER_SESSION_POLICIES = new Set([
  "persistent_project_per_worker_slot_v1",
  "persistent_tab_per_worker_slot_v1",
]);

const DEFAULT_PERSISTENT_IMAGE_POLICY_BY_PROVIDER = Object.freeze({
  "google-flow": "persistent_project_per_worker_slot_v1",
  "google-gemini": "persistent_tab_per_worker_slot_v1",
});

export function browserFailureDisposition(error) {
  const code = String(error?.code ?? "").toLowerCase();
  const message = String(error?.message ?? error ?? "").toLowerCase();
  if (code === "rate_limited" || /rate.?limit|too many requests|requesting generations too quickly|cooldown/.test(message)) {
    return { kind: "rate_limit", pausesDispatch: true };
  }
  if (code === "ui_contract_mismatch"
    && /timed out waiting for (?:a )?complete(?:d)? (?:chatgpt |gemini )?(?:text )?response/.test(message)) {
    return { kind: "transport", pausesDispatch: true };
  }
  if (code === "ui_contract_mismatch"
    && /google flow clipboard paste did not bind to the visible composer/.test(message)) {
    return { kind: "transport", pausesDispatch: true };
  }
  if (code === "ui_contract_mismatch"
    && /timed out waiting for (?:a )?generated (?:google flow |gemini |chatgpt )?(?:still )?image/.test(message)) {
    return { kind: "transport", pausesDispatch: true };
  }
  if (["auth_required", "account_mismatch", "ui_contract_mismatch", "usage_limited"].includes(code)) {
    return { kind: code, pausesDispatch: true };
  }
  if (/(?:google_flow|google_gemini|chatgpt)_generation_error/.test(code)
    || /timeout|timed out|transport|connection|socket|fetch failed|upload files.*not enabled|element is not enabled|failed to generate|generation failed|something went wrong/.test(message)) {
    return { kind: "transport", pausesDispatch: true };
  }
  return { kind: "asset", pausesDispatch: false };
}

export class GoldflowDesktopHost {
  constructor({ config, browser = null, log = null } = {}) {
    this.config = assertDesktopConfig(config);
    this.state = new DesktopRuntimeState({ stateDir: config.stateDir, namespace: config.browserProvider });
    this.client = new GoldflowWorkerClient({ serverUrl: config.serverUrl });
    this.logSink = log ?? ((message, level = "info") => process.stdout.write(`[${nowIso()}] ${level.toUpperCase()} ${message}\n`));
    this.browser = browser ?? (config.browserProvider === "google-flow"
      ? new GoogleFlowBrowser({ ...config, log: (message, level) => this.log(message, level) })
      : config.browserProvider === "google-gemini"
        ? new GoogleGeminiBrowser({ ...config, log: (message, level) => this.log(message, level) })
        : new ChatGptBrowser({ ...config, log: (message, level) => this.log(message, level) }));
    this.workerId = null;
    this.activeJobs = new Map();
    this.events = [];
    this.persistQueue = Promise.resolve();
    this.running = false;
    this.stopStarted = false;
    this.schedulerBusy = false;
    this.schedulerTimer = null;
    this.runtimeHeartbeatTimer = null;
    this.lastPauseMessage = null;
    this.lastPauseLoggedAt = 0;
    this.nextLeaseAt = 0;
    this.dispatchCooldownUntil = 0;
    this.submissionBurstCount = 0;
    this.voluntaryBurstCooldownUntil = 0;
    this.consecutiveTransportFailures = 0;
    this.providerCircuit = null;
    this.providerRecoveryProbe = false;
    this.preparedWorkerSessionPolicies = new Set();
    this.workerPoolPreparation = null;
    this.stopPromise = new Promise((resolve) => { this.resolveStopped = resolve; });
  }

  log(message, level = "info") {
    const entry = { at: nowIso(), level, message: String(message) };
    this.events.unshift(entry);
    this.events = this.events.slice(0, 60);
    this.logSink(entry.message, level);
    this.persistRuntime().catch(() => {});
  }

  runtimeRecord() {
    return {
      status: this.running ? "running" : "stopped",
      pid: process.pid,
      worker_id: this.workerId,
      server_url: this.config.serverUrl,
      concurrency: this.config.concurrency,
      types: this.config.types,
      profile_dir: this.config.profileDir,
      browser_provider: this.config.browserProvider,
      worker_pool: typeof this.browser.workerPoolState === "function"
        ? {
            ...this.browser.workerPoolState(),
            prepared_session_policies: [...this.preparedWorkerSessionPolicies].sort(),
          }
        : null,
      active_jobs: [...this.activeJobs.values()].map((active) => ({
        slot: active.slot,
        job: active.job,
        uiContract: active.uiContract,
        phase: active.phase,
        startedAt: active.startedAt,
      })),
      dispatch_policy: {
        mode: "staggered_top_off_v1",
        submission_stagger_ms: this.config.submissionStaggerMs,
        submission_burst_size: this.config.submissionBurstSize,
        submission_burst_count: this.submissionBurstCount,
        submission_burst_cooldown_ms: this.config.submissionBurstCooldownMs,
        voluntary_burst_cooldown_until: this.voluntaryBurstCooldownUntil
          ? new Date(this.voluntaryBurstCooldownUntil).toISOString()
          : null,
        next_lease_at: this.nextLeaseAt ? new Date(this.nextLeaseAt).toISOString() : null,
        cooldown_until: this.dispatchCooldownUntil ? new Date(this.dispatchCooldownUntil).toISOString() : null,
        consecutive_transport_failures: this.consecutiveTransportFailures,
        transport_failure_threshold: this.config.transportFailureThreshold,
        provider_circuit: this.providerCircuit,
      },
      events: this.events,
      updated_at: nowIso(),
    };
  }

  persistRuntime() {
    const snapshot = this.runtimeRecord();
    const save = this.persistQueue.then(() => this.state.saveRuntime(snapshot));
    this.persistQueue = save.catch(() => {});
    return save;
  }

  async ensureCredentials() {
    const health = await this.client.health();
    if (health.browser_provider !== this.config.browserProvider) {
      throw new Error(`Desktop provider ${this.config.browserProvider} cannot attach to a ${health.browser_provider ?? "provider-unbound"} Goldflow server.`);
    }
    const saved = await this.state.credentials();
    const savedProvider = saved?.browser_provider ?? "chatgpt";
    if (saved?.server_url === this.config.serverUrl && savedProvider === this.config.browserProvider && saved.worker_token && saved.worker_id) {
      this.workerId = saved.worker_id;
      this.client.workerToken = saved.worker_token;
      return;
    }
    if (!this.config.pairingCode) throw new Error("Desktop worker is not paired. Start through desktop/main.mjs or pass --pairing-code.");
    const paired = await this.client.pair(this.config.pairingCode, this.config.label, this.config.browserProvider);
    if (paired.browser_provider !== this.config.browserProvider) {
      throw new Error(`Goldflow paired a ${paired.browser_provider ?? "provider-unbound"} worker instead of ${this.config.browserProvider}.`);
    }
    this.workerId = paired.worker.worker_id;
    await this.state.saveCredentials({
      server_url: this.config.serverUrl,
      browser_provider: this.config.browserProvider,
      worker_id: this.workerId,
      worker_token: paired.token,
      paired_at: nowIso(),
    });
    this.log(`Paired desktop worker ${this.workerId}.`);
  }

  async reconcileInterruptedJobs() {
    const previous = await this.state.runtime();
    for (const active of previous.active_jobs ?? []) {
      if (!active?.job || !Number.isInteger(active.slot)) continue;
      const error = normalizeError(new Error(`Desktop host restarted during ${active.phase ?? "unknown"}; Goldflow will not guess or resubmit this lease.`), "lease_ambiguous");
      error.code = "lease_ambiguous";
      await this.client.fail(active.job, active.slot, error).catch((failure) => {
        this.log(`Could not reconcile interrupted ${active.job.job_id}: ${failure.message}`, "error");
      });
    }
  }

  async preparePersistentWorkerPool(policyValue, reason = "persistent image manifest") {
    const policy = String(policyValue ?? "");
    if (!PERSISTENT_WORKER_SESSION_POLICIES.has(policy)) return false;
    if (this.preparedWorkerSessionPolicies.has(policy)) return true;
    if (typeof this.browser.prepareWorkerSlots !== "function") {
      throw new Error(`${this.config.browserProvider} cannot satisfy persistent worker-session policy ${policy}.`);
    }
    if (this.workerPoolPreparation) {
      await this.workerPoolPreparation;
      return this.preparePersistentWorkerPool(policy, reason);
    }
    this.workerPoolPreparation = this.browser.prepareWorkerSlots()
      .then(() => {
        this.preparedWorkerSessionPolicies.add(policy);
        this.log(`Prepared persistent browser workers for ${policy} (${reason}).`);
      })
      .finally(() => { this.workerPoolPreparation = null; });
    await this.workerPoolPreparation;
    return true;
  }

  async start() {
    if (this.running) return this;
    await Promise.all([
      fs.mkdir(this.config.stateDir, { recursive: true }),
      fs.mkdir(this.config.downloadsRoot, { recursive: true }),
    ]);
    await this.ensureCredentials();
    await this.reconcileInterruptedJobs();
    await this.browser.start();
    await this.browser.waitForAuthentication();
    const health = await this.client.health();
    const startupPolicies = new Set(health.active_image_worker_session_policies ?? []);
    if (this.config.prewarmPersistentWorkerPool === true && this.config.types.includes("image")) {
      const defaultPolicy = DEFAULT_PERSISTENT_IMAGE_POLICY_BY_PROVIDER[this.config.browserProvider];
      if (defaultPolicy) startupPolicies.add(defaultPolicy);
    }
    for (const policy of startupPolicies) {
      const reason = (health.active_image_worker_session_policies ?? []).includes(policy)
        ? "active manifest at startup"
        : "production media preflight";
      await this.preparePersistentWorkerPool(policy, reason);
    }
    this.running = true;
    await this.persistRuntime();
    clearInterval(this.runtimeHeartbeatTimer);
    this.runtimeHeartbeatTimer = setInterval(() => {
      if (this.running) this.persistRuntime().catch(() => {});
    }, 15_000);
    this.runtimeHeartbeatTimer.unref?.();
    this.log(`Desktop worker ready with ${this.config.concurrency} browser slot(s): ${this.config.types.join(", ")}.`);
    this.schedule(0);
    return this;
  }

  schedule(delayMs = 700) {
    if (!this.running) return;
    clearTimeout(this.schedulerTimer);
    this.schedulerTimer = setTimeout(() => this.tick().catch((error) => this.log(`Scheduler failed: ${error.message}`, "error")), delayMs);
  }

  async tick() {
    if (!this.running || this.schedulerBusy) return;
    this.schedulerBusy = true;
    let nextDelayMs = 700;
    try {
      const now = Date.now();
      if (now < this.dispatchCooldownUntil) {
        nextDelayMs = Math.min(5_000, this.dispatchCooldownUntil - now);
        return;
      }
      if (this.voluntaryBurstCooldownUntil && now >= this.voluntaryBurstCooldownUntil) {
        this.voluntaryBurstCooldownUntil = 0;
        this.submissionBurstCount = 0;
        this.log("Voluntary provider burst cooldown elapsed; resuming dispatch.");
        await this.persistRuntime();
      }
      if (this.providerCircuit?.status === "open") {
        this.providerCircuit = null;
        this.consecutiveTransportFailures = 0;
        this.providerRecoveryProbe = true;
        this.log("Provider cooldown elapsed; allowing one recovery probe.");
        await this.persistRuntime();
      }
      if (this.providerRecoveryProbe && this.activeJobs.size > 0) {
        nextDelayMs = 1_000;
        return;
      }
      if (now < this.nextLeaseAt) {
        nextDelayMs = Math.min(1_000, this.nextLeaseAt - now);
        return;
      }
      if (this.config.submissionBurstSize > 0
        && this.submissionBurstCount >= this.config.submissionBurstSize) {
        this.voluntaryBurstCooldownUntil = now + this.config.submissionBurstCooldownMs;
        this.dispatchCooldownUntil = Math.max(this.dispatchCooldownUntil, this.voluntaryBurstCooldownUntil);
        this.log(`Voluntary provider burst limit reached after ${this.submissionBurstCount} submissions; cooling down until ${new Date(this.voluntaryBurstCooldownUntil).toISOString()}.`, "warn");
        await this.persistRuntime();
        nextDelayMs = Math.min(5_000, this.config.submissionBurstCooldownMs);
        return;
      }
      for (let slot = 0; slot < this.config.concurrency; slot += 1) {
        if (!this.running || this.activeJobs.has(slot)) continue;
        let lease;
        try {
          lease = await this.client.lease(this.config.types, slot);
        } catch (error) {
          this.log(`Controller unavailable: ${error.message}`, "error");
          break;
        }
        if (lease.status === "paused") {
          const pauseMessage = lease.reason?.message ?? "operator hold";
          if (pauseMessage !== this.lastPauseMessage || Date.now() - this.lastPauseLoggedAt >= 30_000) {
            this.log(`Dispatch paused: ${pauseMessage}.`, "warn");
            this.lastPauseMessage = pauseMessage;
            this.lastPauseLoggedAt = Date.now();
          }
          nextDelayMs = 5_000;
          break;
        }
        this.lastPauseMessage = null;
        if (lease.status !== "leased") break;
        if (lease.reused_existing_lease === true) {
          const error = normalizeError(new Error("A prior browser submission still owns this lease. It will not be submitted again."), "lease_ambiguous");
          error.code = "lease_ambiguous";
          await this.client.fail(lease.job, slot, error);
          continue;
        }
        this.nextLeaseAt = Date.now() + this.config.submissionStaggerMs;
        this.submissionBurstCount += 1;
        this.runSlot(slot, lease).catch((error) => this.log(`Slot ${slot} crashed: ${error.message}`, "error"));
        nextDelayMs = this.config.submissionStaggerMs;
        break;
      }
    } finally {
      this.schedulerBusy = false;
      this.schedule(nextDelayMs);
    }
  }

  async setPhase(slot, phase) {
    const active = this.activeJobs.get(slot);
    if (!active) return;
    active.phase = phase;
    await this.persistRuntime();
  }

  async runSlot(slot, lease) {
    const active = {
      slot,
      job: lease.job,
      uiContract: lease.ui_contract,
      phase: "leased",
      startedAt: nowIso(),
      recoveryProbe: this.providerRecoveryProbe,
    };
    this.activeJobs.set(slot, active);
    await this.persistRuntime();
    this.log(`Slot ${slot + 1} leased ${lease.job.job_id}.`);
    const heartbeat = setInterval(() => {
      this.client.heartbeat(lease.job, slot).catch((error) => this.log(`Heartbeat failed for ${lease.job.job_id}: ${error.message}`, "error"));
    }, 60_000);
    try {
      await this.preparePersistentWorkerPool(
        lease.job.worker_session_policy,
        `leased ${lease.job.job_id}`,
      );
      const result = await this.browser.runJob({
        slot,
        job: lease.job,
        uiContract: lease.ui_contract,
        client: this.client,
        onPhase: (phase) => this.setPhase(slot, phase),
      });
      await this.client.complete(lease.job, slot, result);
      const circuitOpenedAt = Date.parse(this.providerCircuit?.opened_at ?? "");
      const jobStartedAt = Date.parse(active.startedAt ?? "");
      const inFlightBeforeOpenCircuit = this.providerCircuit?.status === "open"
        && Number.isFinite(circuitOpenedAt)
        && Number.isFinite(jobStartedAt)
        && jobStartedAt <= circuitOpenedAt;
      if (!inFlightBeforeOpenCircuit) {
        this.consecutiveTransportFailures = 0;
        this.providerCircuit = null;
      }
      this.providerRecoveryProbe = false;
      this.log(`Completed ${lease.job.job_id}.`);
    } catch (caught) {
      const error = normalizeError(caught);
      if (String(error.code).toLowerCase() === "ui_contract_mismatch"
        && /^timed out waiting for /i.test(String(error.message ?? ""))) {
        error.code = "provider_response_timeout";
      }
      const disposition = browserFailureDisposition(error);
      if (disposition.kind === "transport") this.consecutiveTransportFailures += 1;
      if (["auth_required", "account_mismatch", "ui_contract_mismatch", "usage_limited"].includes(disposition.kind)) {
        this.providerCircuit = {
          status: "open",
          reason: disposition.kind,
          failure_count: 1,
          opened_at: nowIso(),
        };
      } else if (disposition.kind === "transport"
        && (active.recoveryProbe || this.consecutiveTransportFailures >= this.config.transportFailureThreshold)) {
        const originalCode = String(error.code ?? "browser_worker_failure");
        error.code = "provider_transient_circuit_open";
        error.message = `${originalCode}: ${error.message}`;
        this.providerCircuit = {
          status: "open",
          reason: "consecutive_transient_provider_failures",
          failure_count: this.consecutiveTransportFailures,
          opened_at: nowIso(),
        };
      }
      if (disposition.kind === "rate_limit") {
        this.dispatchCooldownUntil = Date.now() + this.config.rateLimitCooldownMs;
      } else if (["auth_required", "account_mismatch", "ui_contract_mismatch", "usage_limited"].includes(disposition.kind)) {
        this.dispatchCooldownUntil = Date.now() + this.config.transportCooldownMs;
      } else if (disposition.kind === "transport"
        && (active.recoveryProbe || this.consecutiveTransportFailures >= this.config.transportFailureThreshold)) {
        this.dispatchCooldownUntil = Date.now() + this.config.transportCooldownMs;
      }
      this.providerRecoveryProbe = false;
      await this.client.fail(lease.job, slot, error).catch((reportError) => {
        this.log(`Could not record failure for ${lease.job.job_id}: ${reportError.message}`, "error");
      });
      this.log(`${lease.job.job_id} failed: ${error.message}`, "error");
      if (this.dispatchCooldownUntil > Date.now()) {
        this.submissionBurstCount = 0;
        this.voluntaryBurstCooldownUntil = 0;
        this.log(`Browser dispatch cooling down until ${new Date(this.dispatchCooldownUntil).toISOString()} after ${disposition.kind} failure.`, "warn");
      }
    } finally {
      clearInterval(heartbeat);
      this.activeJobs.delete(slot);
      await this.persistRuntime();
      this.schedule(0);
    }
  }

  async stop({ drainMs = 300_000 } = {}) {
    if (this.stopStarted) return;
    this.stopStarted = true;
    this.running = false;
    clearTimeout(this.schedulerTimer);
    clearInterval(this.runtimeHeartbeatTimer);
    this.runtimeHeartbeatTimer = null;
    const deadline = Date.now() + drainMs;
    while (this.activeJobs.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
    await this.browser.close();
    await this.persistRuntime();
    this.resolveStopped();
  }

  waitUntilStopped() {
    return this.stopPromise;
  }
}
