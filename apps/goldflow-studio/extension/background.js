const DEFAULT_SETTINGS = {
  serverUrl: "http://127.0.0.1:4317",
  workerId: null,
  workerToken: null,
  enabled: false,
  concurrency: 3,
  types: ["llm", "image"],
};

let schedulerRunning = false;
let activeJobs = new Map();
let recentEvents = [];

async function persistActiveJobs() {
  await chrome.storage.local.set({ activeJobs: [...activeJobs.values()] });
}

function event(message, level = "info") {
  recentEvents.unshift({ at: new Date().toISOString(), level, message });
  recentEvents = recentEvents.slice(0, 30);
  chrome.storage.local.set({ recentEvents });
}

function validServerUrl(value) {
  return /^http:\/\/127\.0\.0\.1:\d+$/.test(String(value ?? ""));
}

async function settings() {
  const stored = await chrome.storage.local.get(["settings"]);
  return { ...DEFAULT_SETTINGS, ...(stored.settings ?? {}) };
}

async function saveSettings(next) {
  const normalized = {
    ...DEFAULT_SETTINGS,
    ...next,
    concurrency: Math.min(5, Math.max(1, Number(next.concurrency ?? 3))),
    types: [...new Set((next.types ?? ["llm", "image"]).filter((type) => ["llm", "image"].includes(type)))],
  };
  if (!validServerUrl(normalized.serverUrl)) throw new Error("Studio URL must be a 127.0.0.1 HTTP address with an explicit port.");
  await chrome.storage.local.set({ settings: normalized });
  return normalized;
}

async function api(route, { method = "GET", body = null, auth = true } = {}) {
  const current = await settings();
  const response = await fetch(`${current.serverUrl}${route}`, {
    method,
    headers: {
      ...(auth && current.workerToken ? { authorization: `Bearer ${current.workerToken}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : null,
  });
  const value = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) throw new Error(value.error || `Studio request failed ${response.status}.`);
  return value;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function fetchReferenceForContentScript(route) {
  if (!/^\/v1\/worker\/image-reference\/[^/?]+\/[^/?]+\/\d+\?lease_token=[^&]+$/.test(String(route ?? ""))) {
    throw new Error("Rejected an invalid Goldflow reference route.");
  }
  const current = await settings();
  const response = await fetch(`${current.serverUrl}${route}`, {
    headers: current.workerToken ? { authorization: `Bearer ${current.workerToken}` } : {},
  });
  if (!response.ok) throw new Error(`Goldflow reference returned HTTP ${response.status}.`);
  const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "application/octet-stream";
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) throw new Error("Goldflow reference was empty.");
  return { mimeType, base64: bytesToBase64(bytes) };
}

async function pair(code, label) {
  const value = await api("/v1/pair", { method: "POST", body: { code, label }, auth: false });
  const current = await settings();
  await saveSettings({ ...current, workerId: value.worker.worker_id, workerToken: value.token });
  event(`Paired ${value.worker.worker_id}.`);
  return value;
}

function waitForTab(tabId, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("ChatGPT tab did not finish loading.")), timeoutMs);
    const listener = (changedTabId, changeInfo) => {
      if (changedTabId === tabId && changeInfo.status === "complete") finish();
    };
    const finish = (error = null) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      error ? reject(error) : resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") finish();
    }).catch(finish);
  });
}

async function waitForContentScript(tabId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const answer = await chrome.tabs.sendMessage(tabId, { type: "GOLDFLOW_PING" });
      if (answer?.ready) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Goldflow content worker did not attach to the ChatGPT tab.");
}

function waitForDownload(downloadId, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Generated-image download timed out.")), timeoutMs);
    const listener = (delta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === "complete") {
        chrome.downloads.search({ id: downloadId }).then((items) => finish(null, items[0])).catch(finish);
      } else if (delta.state.current === "interrupted") {
        finish(new Error("Generated-image download was interrupted."));
      }
    };
    const finish = (error = null, item = null) => {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(listener);
      error ? reject(error) : resolve(item);
    };
    chrome.downloads.onChanged.addListener(listener);
  });
}

function safeFilename(value) {
  return String(value ?? "asset").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "asset";
}

async function downloadGeneratedImage(job, sourceUrl) {
  if (!/^https:\/\/chatgpt\.com\//.test(sourceUrl)) throw new Error("Generated image URL is not a ChatGPT same-origin asset.");
  const filename = `${safeFilename(job.manifest_id)}/${safeFilename(job.asset_id)}-${safeFilename(job.lease_token.slice(0, 12))}.png`;
  const downloadId = await chrome.downloads.download({
    url: sourceUrl,
    filename: `GoldflowStudio/${filename}`,
    conflictAction: "uniquify",
    saveAs: false,
  });
  const item = await waitForDownload(downloadId);
  if (!item?.filename) throw new Error("Chrome did not report the generated image path.");
  return item.filename;
}

async function reportFailure(job, error, slot) {
  const code = String(error?.code ?? "browser_worker_failure");
  const message = String(error?.message ?? error ?? "Browser worker failed.");
  try {
    await api("/v1/worker/fail", {
      method: "POST",
      body: {
        type: job.type,
        jobId: job.job_id,
        manifestId: job.manifest_id,
        assetId: job.asset_id,
        leaseToken: job.lease_token,
        slot,
        code,
        message,
      },
    });
  } catch (reportError) {
    event(`Could not record failure for ${job.job_id}: ${reportError.message}`, "error");
  }
  event(`${job.job_id} failed: ${message}`, "error");
}

async function runJob(slot, leaseResponse, { resume = false, restored = null } = {}) {
  const job = leaseResponse.job;
  const active = restored ?? { slot, job, uiContract: leaseResponse.ui_contract, phase: "leased", tabId: null, startedAt: new Date().toISOString() };
  activeJobs.set(slot, active);
  await persistActiveJobs();
  const current = await settings();
  let tab = null;
  let preserveFailedTab = false;
  const heartbeatTimer = setInterval(() => {
    api("/v1/worker/heartbeat", {
      method: "POST",
      body: {
        type: job.type,
        jobId: job.job_id,
        manifestId: job.manifest_id,
        assetId: job.asset_id,
        leaseToken: job.lease_token,
        slot,
      },
    }).catch((error) => event(`Heartbeat failed for ${job.job_id}: ${error.message}`, "error"));
  }, 60_000);
  try {
    if (resume) {
      tab = await chrome.tabs.get(active.tabId);
    } else {
      tab = await chrome.tabs.create({ url: "https://chatgpt.com/", active: false });
      active.tabId = tab.id;
      active.phase = "tab_open";
      await persistActiveJobs();
      await waitForTab(tab.id);
    }
    await waitForContentScript(tab.id);
    const result = await chrome.tabs.sendMessage(tab.id, {
      type: resume ? "GOLDFLOW_RESUME_JOB" : "GOLDFLOW_RUN_JOB",
      job,
      uiContract: active.uiContract ?? leaseResponse.ui_contract,
      connection: { serverUrl: current.serverUrl, workerToken: current.workerToken },
    });
    if (!result?.ok) {
      const error = new Error(result?.error?.message ?? "ChatGPT worker returned no result.");
      error.code = result?.error?.code ?? "browser_worker_failure";
      throw error;
    }
    active.phase = "result_ready";
    await persistActiveJobs();
    if (job.type === "image") {
      const downloadPath = await downloadGeneratedImage(job, result.imageUrl);
      await api("/v1/worker/complete", {
        method: "POST",
        body: {
          type: "image",
          manifestId: job.manifest_id,
          assetId: job.asset_id,
          leaseToken: job.lease_token,
          slot,
          downloadPath,
          sourceUrl: result.imageUrl,
          conversationUrl: result.conversationUrl,
          uiContract: result.uiContract,
        },
      });
    } else {
      await api("/v1/worker/complete", {
        method: "POST",
        body: {
          type: "llm",
          jobId: job.job_id,
          leaseToken: job.lease_token,
          slot,
          content: result.content,
          conversationUrl: result.conversationUrl,
          uiContract: result.uiContract,
        },
      });
    }
    event(`Completed ${job.job_id}.`);
  } catch (error) {
    preserveFailedTab = ["rate_limited", "usage_limited", "account_mismatch", "ui_contract_mismatch"].includes(error.code);
    await reportFailure(job, error, slot);
  } finally {
    clearInterval(heartbeatTimer);
    activeJobs.delete(slot);
    await persistActiveJobs();
    if (tab?.id && !preserveFailedTab) await chrome.tabs.remove(tab.id).catch(() => {});
    scheduleSoon();
  }
}

async function tick() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    const current = await settings();
    if (!current.enabled || !current.workerToken || !current.workerId) return;
    for (let slot = 0; slot < current.concurrency; slot += 1) {
      if (activeJobs.has(slot)) continue;
      let lease;
      try {
        lease = await api("/v1/worker/lease", { method: "POST", body: { types: current.types, slot } });
      } catch (error) {
        event(`Controller unavailable: ${error.message}`, "error");
        break;
      }
      if (lease.status === "paused") {
        event(`Dispatch paused: ${lease.reason?.message ?? "operator hold"}`, "warn");
        break;
      }
      if (lease.status !== "leased") break;
      if (lease.reused_existing_lease === true) {
        const error = new Error("A prior browser submission still owns this slot lease. It was moved to triage rather than submitted again.");
        error.code = "lease_ambiguous";
        await reportFailure(lease.job, error, slot);
        continue;
      }
      runJob(slot, lease);
    }
  } finally {
    schedulerRunning = false;
  }
}

function scheduleSoon() {
  setTimeout(() => tick(), 700);
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  await ensureSchedulerAlarm();
  event("Goldflow Studio worker installed.");
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureSchedulerAlarm();
  event("Chrome restarted. Submitted tabs will resume; ambiguous pre-submit leases move to triage.", "warn");
  scheduleSoon();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "goldflow-tick") tick();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GOLDFLOW_PHASE" && sender.tab?.id) {
    for (const active of activeJobs.values()) {
      if (active.tabId === sender.tab.id) active.phase = message.phase;
    }
    persistActiveJobs();
    sendResponse({ ok: true });
    return;
  }
  (async () => {
    if (message?.type === "GOLDFLOW_GET_STATUS") {
      const current = await settings();
      if (current.enabled) scheduleSoon();
      return { settings: { ...current, workerToken: current.workerToken ? "paired" : null }, activeJobs: [...activeJobs.values()], recentEvents };
    }
    if (message?.type === "GOLDFLOW_FETCH_REFERENCE") return fetchReferenceForContentScript(message.route);
    if (message?.type === "GOLDFLOW_PAIR") return pair(message.code, message.label);
    if (message?.type === "GOLDFLOW_SAVE_SETTINGS") {
      const current = await settings();
      const saved = await saveSettings({ ...current, ...message.settings });
      if (saved.enabled) scheduleSoon();
      return { status: "saved", settings: { ...saved, workerToken: saved.workerToken ? "paired" : null } };
    }
    if (message?.type === "GOLDFLOW_OPEN_STUDIO") {
      const current = await settings();
      await chrome.tabs.create({ url: current.serverUrl, active: true });
      return { status: "opened" };
    }
    throw new Error("Unknown Goldflow extension message.");
  })().then((value) => sendResponse({ ok: true, value })).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function restoreActiveJobs() {
  const stored = await chrome.storage.local.get(["recentEvents", "activeJobs"]);
  recentEvents = stored.recentEvents ?? [];
  for (const active of stored.activeJobs ?? []) {
    const slot = Number(active.slot);
    if (!Number.isInteger(slot) || slot < 0 || slot > 4 || !active.job) continue;
    if (["submitted", "result_ready"].includes(active.phase) && active.tabId) {
      activeJobs.set(slot, active);
      runJob(slot, { job: active.job, ui_contract: active.uiContract }, { resume: true, restored: active });
      continue;
    }
    const error = new Error("Chrome stopped during an ambiguous pre-submit phase. Goldflow will not guess or resubmit it.");
    error.code = "lease_ambiguous";
    await reportFailure(active.job, error, slot);
    if (active.tabId) await chrome.tabs.remove(active.tabId).catch(() => {});
  }
  await persistActiveJobs();
  scheduleSoon();
}

async function ensureSchedulerAlarm() {
  const alarm = await chrome.alarms.get("goldflow-tick");
  if (!alarm) await chrome.alarms.create("goldflow-tick", { periodInMinutes: 0.5 });
}

ensureSchedulerAlarm()
  .then(() => restoreActiveJobs())
  .catch((error) => event(`Worker restore failed: ${error.message}`, "error"));
