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
    this.lastPauseMessage = null;
    this.lastPauseLoggedAt = 0;
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
      worker_id: this.workerId,
      server_url: this.config.serverUrl,
      concurrency: this.config.concurrency,
      types: this.config.types,
      profile_dir: this.config.profileDir,
      browser_provider: this.config.browserProvider,
      active_jobs: [...this.activeJobs.values()].map((active) => ({
        slot: active.slot,
        job: active.job,
        uiContract: active.uiContract,
        phase: active.phase,
        startedAt: active.startedAt,
      })),
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
    this.running = true;
    await this.persistRuntime();
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
        this.runSlot(slot, lease).catch((error) => this.log(`Slot ${slot} crashed: ${error.message}`, "error"));
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
    };
    this.activeJobs.set(slot, active);
    await this.persistRuntime();
    this.log(`Slot ${slot + 1} leased ${lease.job.job_id}.`);
    const heartbeat = setInterval(() => {
      this.client.heartbeat(lease.job, slot).catch((error) => this.log(`Heartbeat failed for ${lease.job.job_id}: ${error.message}`, "error"));
    }, 60_000);
    try {
      const result = await this.browser.runJob({
        job: lease.job,
        uiContract: lease.ui_contract,
        client: this.client,
        onPhase: (phase) => this.setPhase(slot, phase),
      });
      await this.client.complete(lease.job, slot, result);
      this.log(`Completed ${lease.job.job_id}.`);
    } catch (caught) {
      const error = normalizeError(caught);
      await this.client.fail(lease.job, slot, error).catch((reportError) => {
        this.log(`Could not record failure for ${lease.job.job_id}: ${reportError.message}`, "error");
      });
      this.log(`${lease.job.job_id} failed: ${error.message}`, "error");
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
