import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { chromium } from "playwright-core";

import { findReferenceEcho, normalizedImagePixels } from "../lib/image-pixel-contract.mjs";
import { clearLoginMarker, markLoginVerified } from "./browser-login.mjs";

const GOOGLE_FLOW_URL = "https://flow.google.com/";
const FLOW_ORIGINS = new Set(["https://flow.google.com", "https://labs.google"]);
const PROMPT_SELECTOR = '.ProseMirror[contenteditable="true"], [data-slate-editor="true"][role="textbox"]';
const SIGNED_OUT_SELECTOR = 'a:has-text("Sign in"), button:has-text("Sign in")';
const REFERENCE_BINDING_SCHEMA = "goldflow_google_flow_reference_binding_v1";
const REFERENCE_BINDING_RECEIPT_SCHEMA = "goldflow_google_flow_reference_binding_receipt_v1";
const FLOW_MEDIA_PATH_FRAGMENT = "media.getMediaUrlRedirect";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const FLOW_VIDEO_CONTROL_LABEL_PATTERN = /^Video\s*·\s*(?:\d+p\s*·\s*)?\d+s\b/i;
const FLOW_COMPOSER_MEDIA_CONTROL_PATTERN = /^(?:(?:🍌\s*)?Nano Banana\b|Veo\b|Video\s*·\s*(?:\d+p\s*·\s*)?\d+s\b)/i;
const PERSISTENT_FLOW_WORKER_POLICY = "persistent_project_per_worker_slot_v1";

async function dismissFlowChangelog(page) {
  const getStarted = await waitForVisible(
    page.getByRole("button", { name: /^get started$/i }),
    { timeoutMs: 2_000 },
  );
  if (!getStarted) return false;
  await getStarted.click();
  await getStarted.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
  return true;
}

export function redactBrowserDiagnostic(value) {
  return String(value ?? "")
    .replace(/(^|[\r\n])(?:\x1b\[[0-9;]*m|[ \t-])*(?:cookie|set-cookie|authorization|proxy-authorization)\s*:[^\r\n]*/gi, "$1[REDACTED REQUEST HEADER]")
    .replace(/\b(?:__Secure-|__Host-)?[^\s;=]*(?:session|auth)[^\s;=]*=[^\s;,)]+/gi, "[REDACTED SESSION COOKIE]")
    .replace(/\bBearer\s+[^\s,)]+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:X-Goog-Signature|Signature|token|access_token|auth|key)=)[^&\s,)]+/gi, "$1[REDACTED]");
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeName(value) {
  return String(value ?? "asset").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "asset";
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  return sha256Bytes(await fs.readFile(filePath));
}

function exactSha256(value, label) {
  const normalized = String(value ?? "").trim();
  if (!SHA256_PATTERN.test(normalized)) throw codedError("ui_contract_mismatch", `${label} must be an exact lowercase SHA-256.`);
  return normalized;
}

function parseFlowMedia(value) {
  try {
    const mediaUrl = new URL(String(value));
    const currentMediaId = mediaUrl.hostname === "flow-content.google" && mediaUrl.pathname.startsWith("/image/")
      ? mediaUrl.pathname.split("/").filter(Boolean).at(-1) ?? ""
      : "";
    if (!mediaUrl.pathname.includes(FLOW_MEDIA_PATH_FRAGMENT) && !currentMediaId) return null;
    const mediaId = mediaUrl.searchParams.get("name") ?? currentMediaId;
    if (!UUID_PATTERN.test(mediaId)) return null;
    return { media_id: mediaId, media_url: mediaUrl.href };
  } catch {
    return null;
  }
}

export function validateFlowReferenceDock({
  expectedReferences = [],
  observedChips = [],
  expectedPrompt,
  observedPrompt,
  noPendingUploads,
  createEnabled,
} = {}) {
  if (!Number.isInteger(expectedReferences.length) || expectedReferences.length < 0 || expectedReferences.length > 4) {
    throw codedError("ui_contract_mismatch", `Google Flow reference binding requires between zero and four ordered references; received ${expectedReferences.length}.`);
  }
  if (observedChips.length !== expectedReferences.length) {
    throw codedError("ui_contract_mismatch", `Google Flow composer has ${observedChips.length} reference chip(s); expected exactly ${expectedReferences.length}.`);
  }
  for (let index = 0; index < expectedReferences.length; index += 1) {
    const expected = expectedReferences[index];
    const observed = observedChips[index];
    if (!observed || observed.media_id !== expected.media_id) {
      throw codedError("ui_contract_mismatch", `Google Flow composer reference chip ${index + 1} is missing or out of order.`);
    }
    if (observed.loaded !== true) {
      throw codedError("ui_contract_mismatch", `Google Flow composer reference chip ${index + 1} is not fully loaded.`);
    }
  }
  if (noPendingUploads !== true) throw codedError("ui_contract_mismatch", "Google Flow still reports a pending reference upload.");
  if (normalizeFlowPromptText(observedPrompt) !== normalizeFlowPromptText(expectedPrompt)) {
    throw codedError("ui_contract_mismatch", "Google Flow prompt text changed while ordered references were attached.");
  }
  if (createEnabled !== true) throw codedError("ui_contract_mismatch", "Google Flow Create is not enabled after reference binding verification.");
  return true;
}

export function flowReferenceUploadOrder(references = []) {
  // Flow currently prepends each newly attached chip. Upload the highest slot
  // first so the settled left-to-right dock still matches canonical slot order.
  return [...references].sort((left, right) => Number(right.slot) - Number(left.slot));
}

export function identifyNewFlowComposerChip(previousMediaIds = [], observedChips = []) {
  const previous = new Set(previousMediaIds.map(String));
  const added = observedChips.filter((chip) => !previous.has(String(chip?.media_id ?? "")));
  if (added.length !== 1) {
    throw codedError("ui_contract_mismatch", `Google Flow composer added ${added.length} new reference chips; expected exactly one.`);
  }
  return added[0];
}

export function identifyAutoAttachedFlowComposerChip(previousMediaIds = [], composerState = null) {
  if (composerState?.busy !== false || !Array.isArray(composerState?.chips)) return null;
  const previous = previousMediaIds.map(String);
  const observed = composerState.chips;
  if (observed.length !== previous.length + 1) return null;
  if (!previous.every((mediaId, index) => String(observed[index]?.media_id ?? "") === mediaId)) return null;
  if (!observed.every((chip) => chip?.loaded === true)) return null;
  return identifyNewFlowComposerChip(previous, observed);
}

export function shouldRetryFlowPreSubmissionTransport({
  errorCode,
  errorName,
  errorMessage,
  creativeSubmissionStarted = false,
  attempt = 1,
  maxAttempts = 2,
} = {}) {
  const code = String(errorCode ?? "");
  const transientBrowserAction = String(errorName ?? "") === "TimeoutError"
    || /locator\.(?:click|fill|setInputFiles)|Timeout \d+ms exceeded|element (?:was )?(?:detached|not stable)/i.test(String(errorMessage ?? ""));
  const terminalCode = ["account_mismatch", "rate_limited", "usage_limited", "content_policy_rejected"].includes(code);
  return (["ui_contract_mismatch", "provider_response_timeout"].includes(code) || (!terminalCode && transientBrowserAction))
    && creativeSubmissionStarted !== true
    && attempt < maxAttempts;
}

async function sleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function visibleLocator(locator) {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}

async function waitForVisible(locator, { timeoutMs = 60_000, pollMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidate = await visibleLocator(locator);
    if (candidate) return candidate;
    await sleep(pollMs);
  }
  return null;
}

export function flowBlockingCode(text) {
  const value = String(text ?? "");
  if (/generation might violate (?:our )?polic(?:y|ies)|violat(?:e|es|ed|ion).*polic(?:y|ies)/i.test(value)) return "content_policy_rejected";
  if (/unusual activity|suspicious activity|temporarily locked/i.test(value)) return "usage_limited";
  if (/too many requests|requesting generations too quickly|rate limit|try again later/i.test(value)) return "rate_limited";
  if (/generation failed|failed to generate|something went wrong/i.test(value)) return "google_flow_generation_error";
  return null;
}

export function flowPromptText(node) {
  if (!node) return "";
  return "value" in node ? String(node.value ?? "") : String(node.innerText ?? node.textContent ?? "");
}

export function normalizeFlowPromptText(value) {
  return String(value ?? "").replaceAll("\uFEFF", "").replace(/\s+/g, " ").trim();
}

export function flowPersistentComposerNeedsReplacement({
  terminalCardText = "",
  referenceChipCount = 0,
} = {}) {
  return Number(referenceChipCount) > 0
    || /(?:^|\s)Failed(?:\s|$)|unusual activity|generation might violate|failed to generate|something went wrong/i.test(String(terminalCardText ?? ""));
}

export function flowModelLabelMatches(actual, expected) {
  const normalize = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const actualLabel = normalize(actual);
  const expectedLabel = normalize(expected);
  return Boolean(expectedLabel)
    && actualLabel.includes(expectedLabel)
    && !actualLabel.includes("lowerpriority");
}

export function flowPlanVerificationEvidence(bodyText, expectedPlan, configuredModel) {
  const text = String(bodyText ?? "");
  const escape = (value) => String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (expectedPlan && new RegExp(`\\b${escape(expectedPlan)}\\b`, "i").test(text)) return "visible_plan_badge";
  if (configuredModel && new RegExp(escape(configuredModel), "i").test(text)) return "visible_model_entitlement";
  return null;
}

export function nearestFlowVideoDuration(requested, available = [4, 6, 8]) {
  const options = [...new Set(available.map(Number).filter((value) => Number.isFinite(value) && value > 0))]
    .sort((left, right) => left - right);
  if (!options.length) throw new Error("Google Flow exposed no supported video durations.");
  const target = Number.isFinite(Number(requested)) ? Number(requested) : 8;
  return options.find((value) => value >= target) ?? options.at(-1);
}

export function isFlowVideoDetailUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    return FLOW_ORIGINS.has(url.origin)
      && /^(?:\/fx\/tools\/flow)?\/project\/[^/]+\/edit\/[^/]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

export function isFlowProjectWorkspaceUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    return FLOW_ORIGINS.has(url.origin)
      && /^(?:\/fx\/tools\/flow)?\/project\/[^/]+(?:\/|$)/.test(url.pathname);
  } catch {
    return false;
  }
}

export function isSameFlowProjectWorkspaceUrl(currentValue, expectedValue) {
  try {
    const projectId = (value) => new URL(String(value ?? "")).pathname
      .match(/^(?:\/fx\/tools\/flow)?\/project\/([^/]+)/)?.[1] ?? null;
    const currentProjectId = projectId(currentValue);
    return Boolean(currentProjectId) && currentProjectId === projectId(expectedValue);
  } catch {
    return false;
  }
}

export class GoogleFlowBrowser {
  constructor({
    profileDir,
    downloadsRoot,
    chromeExecutable,
    headless = false,
    concurrency = 1,
    flowProjectUrl = null,
    flowPlanLabel = "PLUS",
    flowModelLabel = "Nano Banana Pro",
    flowVideoModelLabel = "Veo 3.1 Fast",
    log = () => {},
  } = {}) {
    this.profileDir = profileDir;
    this.downloadsRoot = downloadsRoot;
    this.chromeExecutable = chromeExecutable;
    this.headless = headless;
    this.concurrency = concurrency;
    this.flowProjectUrl = flowProjectUrl;
    this.flowPlanLabel = flowPlanLabel;
    this.flowModelLabel = flowModelLabel;
    this.flowVideoModelLabel = flowVideoModelLabel;
    this.log = log;
    this.context = null;
    this.loginPage = null;
    this.clipboardQueue = Promise.resolve();
    this.workerPages = new Map();
    this.workerPagePromises = new Map();
  }

  async start() {
    if (this.concurrency > 1 && this.flowProjectUrl) {
      throw codedError("ui_contract_mismatch", "Concurrent Google Flow work requires one dedicated project per persistent worker slot; a single shared flowProjectUrl is unsafe.");
    }
    await Promise.all([
      fs.mkdir(this.profileDir, { recursive: true }),
      fs.mkdir(this.downloadsRoot, { recursive: true }),
      fs.access(this.chromeExecutable),
    ]);
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      executablePath: this.chromeExecutable,
      headless: this.headless,
      acceptDownloads: true,
      downloadsPath: this.downloadsRoot,
      viewport: null,
      permissions: ["clipboard-read", "clipboard-write"],
      ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
      args: ["--start-maximized", "--disable-features=Translate"],
    });
    await Promise.all([...FLOW_ORIGINS].map((origin) => (
      this.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin }).catch(() => {})
    )));
    this.loginPage = this.context.pages()[0] ?? await this.context.newPage();
    await this.loginPage.goto(this.flowProjectUrl ?? GOOGLE_FLOW_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
    return this;
  }

  async waitForAuthentication({ pollMs = 1200 } = {}) {
    let announced = false;
    let enteredCreativeStudio = false;
    while (this.context) {
      const signedOut = await visibleLocator(this.loginPage.locator(SIGNED_OUT_SELECTOR));
      const authenticatedSurface = await visibleLocator(this.loginPage.locator([
        PROMPT_SELECTOR,
        'button:has-text("New project")',
        'a[href*="/fx/tools/flow/project/"]',
        'button[aria-label*="User profile"]',
      ].join(", ")));
      if (authenticatedSurface && !signedOut) {
        await dismissFlowChangelog(this.loginPage);
        await markLoginVerified(this.profileDir, { url: this.loginPage.url() }, "google-flow");
        this.log("Google Flow authentication verified.");
        return;
      }
      if (!enteredCreativeStudio) {
        const createWithFlow = this.loginPage.locator("button").filter({ hasText: /Create with Google Flow/i }).first();
        if (await createWithFlow.count()) {
          enteredCreativeStudio = true;
          const priorPages = new Set(this.context.pages());
          await createWithFlow.evaluate((button) => button.click());
          await sleep(pollMs);
          const openedPage = this.context.pages().find((page) => !priorPages.has(page));
          if (openedPage) this.loginPage = openedPage;
          continue;
        }
      }
      if (signedOut) {
        await clearLoginMarker(this.profileDir, "google-flow");
        throw codedError("auth_required", "The dedicated Goldflow Google Flow profile is signed out. Run the normal Chrome login bootstrap.");
      }
      if (!announced) {
        announced = true;
        const diagnosticPath = await this.diagnostics(this.loginPage, {
          provider: "google-flow",
          media_type: "authentication",
        }, codedError("auth_surface_pending", "Google Flow authentication surface is not yet recognizable.")).catch(() => null);
        this.log(`Sign in to Google Flow in the Goldflow browser window. Dispatch remains stopped until an authenticated Flow surface is visible.${diagnosticPath ? ` Diagnostics: ${diagnosticPath}` : ""}`, "warn");
        if (!this.headless) await this.loginPage.bringToFront();
      }
      await sleep(pollMs);
    }
    throw new Error("Goldflow browser closed before Google Flow authentication completed.");
  }

  async close() {
    const context = this.context;
    this.context = null;
    this.workerPages.clear();
    this.workerPagePromises.clear();
    if (context) await context.close().catch(() => {});
  }

  workerPoolState() {
    return {
      policy: PERSISTENT_FLOW_WORKER_POLICY,
      configured_slots: this.concurrency,
      ready_slots: [...this.workerPages.entries()]
        .filter(([, worker]) => worker?.page && !worker.page.isClosed())
        .map(([slot, worker]) => ({ slot, project_url: worker.projectUrl })),
    };
  }

  assertWorkerSlot(slot) {
    const value = Number(slot);
    if (!Number.isInteger(value) || value < 0 || value >= this.concurrency) {
      throw codedError("ui_contract_mismatch", `Google Flow worker slot must be an integer from 0 through ${this.concurrency - 1}.`);
    }
    return value;
  }

  async prepareWorkerSlots() {
    await Promise.all(Array.from(
      { length: this.concurrency },
      async (_, slot) => {
        if (slot > 0) await sleep(slot * 1_200);
        return this.ensurePersistentWorkerPage(slot);
      },
    ));
    this.log(`Google Flow persistent worker pool ready: ${this.concurrency} tabs/projects.`);
    return this.workerPoolState();
  }

  async createPersistentWorkerPage(slot) {
    if (!this.context) throw new Error("Goldflow Google Flow browser is not running.");
    const page = slot === 0 && this.loginPage && !this.loginPage.isClosed()
      ? this.loginPage
      : await this.context.newPage();
    try {
      await page.goto(
        this.concurrency === 1 && this.flowProjectUrl ? this.flowProjectUrl : GOOGLE_FLOW_URL,
        { waitUntil: "domcontentloaded", timeout: 90_000 },
      );
      if (await visibleLocator(page.locator(SIGNED_OUT_SELECTOR))) {
        throw codedError("account_mismatch", "The dedicated Goldflow Google Flow profile is signed out.");
      }
      await dismissFlowChangelog(page);
      if (!isFlowProjectWorkspaceUrl(page.url())) {
        const newProject = await waitForVisible(
          page.getByRole("button", { name: /new project/i }),
          { timeoutMs: 30_000 },
        );
        if (!newProject) throw codedError("ui_contract_mismatch", "Google Flow did not expose a New project control for the persistent worker slot.");
        await newProject.click();
        await page.waitForURL((url) => isFlowProjectWorkspaceUrl(url.href), { timeout: 15_000 }).catch(() => {});
      }
      if (!isFlowProjectWorkspaceUrl(page.url())) {
        throw codedError("ui_contract_mismatch", `Google Flow worker slot ${slot + 1} did not materialize a dedicated project URL.`);
      }
      const composer = await waitForVisible(page.locator(PROMPT_SELECTOR), { timeoutMs: 60_000 });
      if (!composer) throw codedError("ui_contract_mismatch", "Google Flow persistent worker project did not expose its prompt composer.");
      return {
        slot,
        page,
        projectUrl: page.url(),
        preparedAt: new Date().toISOString(),
      };
    } catch (caught) {
      if (page !== this.loginPage) await page.close().catch(() => {});
      throw caught;
    }
  }

  async ensurePersistentWorkerPage(slotValue) {
    const slot = this.assertWorkerSlot(slotValue);
    const existing = this.workerPages.get(slot);
    if (existing?.page && !existing.page.isClosed()) return existing;
    const pending = this.workerPagePromises.get(slot);
    if (pending) return pending;
    const promise = this.createPersistentWorkerPage(slot)
      .then((worker) => {
        this.workerPages.set(slot, worker);
        this.workerPagePromises.delete(slot);
        return worker;
      })
      .catch((error) => {
        this.workerPagePromises.delete(slot);
        throw error;
      });
    this.workerPagePromises.set(slot, promise);
    return promise;
  }

  async replacePersistentWorkerPage(slotValue, priorWorker, reason) {
    const slot = this.assertWorkerSlot(slotValue);
    if (priorWorker?.page && priorWorker.page !== this.loginPage) {
      await priorWorker.page.close().catch(() => {});
    }
    this.workerPages.delete(slot);
    this.workerPagePromises.delete(slot);
    this.log(`Recreating Google Flow worker slot ${slot + 1}: ${reason}`, "warn");
    try {
      return await this.ensurePersistentWorkerPage(slot);
    } catch (error) {
      throw codedError(
        "provider_response_timeout",
        `Timed out recovering Google Flow persistent worker slot ${slot + 1}: ${redactBrowserDiagnostic(error.message)}`,
      );
    }
  }

  async persistentJobPage(slotValue, { composerTimeoutMs = 30_000 } = {}) {
    const slot = this.assertWorkerSlot(slotValue);
    let worker = await this.ensurePersistentWorkerPage(slot);
    if (worker.page.isClosed()) worker = await this.ensurePersistentWorkerPage(slot);
    let composer = null;
    if (isSameFlowProjectWorkspaceUrl(worker.page.url(), worker.projectUrl)) {
      composer = await waitForVisible(worker.page.locator(PROMPT_SELECTOR), {
        timeoutMs: Math.min(2_000, composerTimeoutMs),
      });
    }
    if (!composer) {
      await worker.page.goto(worker.projectUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
      composer = await waitForVisible(worker.page.locator(PROMPT_SELECTOR), { timeoutMs: composerTimeoutMs });
    }
    if (await visibleLocator(worker.page.locator(SIGNED_OUT_SELECTOR))) {
      throw codedError("account_mismatch", "The dedicated Goldflow Google Flow profile is signed out.");
    }
    if (!composer) {
      worker = await this.replacePersistentWorkerPage(
        slot,
        worker,
        "the slot-bound project no longer exposed its composer before submission",
      );
    }
    return worker.page;
  }

  async newJobPage() {
    if (!this.context) throw new Error("Goldflow Google Flow browser is not running.");
    const page = await this.context.newPage();
    try {
      await page.goto(this.flowProjectUrl ?? GOOGLE_FLOW_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
      if (await visibleLocator(page.locator(SIGNED_OUT_SELECTOR))) {
        throw codedError("account_mismatch", "The dedicated Goldflow Google Flow profile is signed out.");
      }
      await dismissFlowChangelog(page);
      let composer = await waitForVisible(page.locator(PROMPT_SELECTOR), { timeoutMs: 15_000 });
      if (!composer) {
        const newProject = await visibleLocator(page.getByRole("button", { name: /new project/i }));
        if (!newProject) {
          throw codedError("ui_contract_mismatch", "Google Flow did not expose a project composer or New project control.");
        }
        await newProject.click();
        composer = await waitForVisible(page.locator(PROMPT_SELECTOR), { timeoutMs: 60_000 });
      }
      if (!composer) throw codedError("ui_contract_mismatch", "Google Flow project did not expose its prompt composer.");
      return page;
    } catch (caught) {
      await page.close().catch(() => {});
      throw caught;
    }
  }

  async blockingAlert(page) {
    const candidates = page.locator('[role="alert"], [role="dialog"], [class*="toast" i], [class*="error" i]');
    const values = [];
    for (let index = 0; index < await candidates.count(); index += 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isVisible().catch(() => false)) values.push(await candidate.innerText().catch(() => ""));
    }
    // Flow sometimes renders policy rejections as ordinary card text rather
    // than an alert/dialog. Match that known terminal message explicitly so a
    // rejected request does not occupy a worker until the image timeout.
    const policyText = page.getByText(/This generation might violate (?:our )?polic(?:y|ies)/i).first();
    if (await policyText.isVisible().catch(() => false)) {
      values.push(await policyText.innerText({ timeout: 1_000 }).catch(() => "This generation might violate our policies"));
    }
    const terminalFailureText = page.getByText(
      /We noticed some unusual activity|suspicious activity|temporarily locked|failed to generate|something went wrong/i,
    ).first();
    if (await terminalFailureText.isVisible().catch(() => false)) {
      values.push(await terminalFailureText.innerText({ timeout: 1_000 }).catch(() => "We noticed some unusual activity"));
    }
    const text = values.filter(Boolean).join("\n");
    const code = flowBlockingCode(text);
    if (code) throw codedError(code, text.slice(0, 1000));
  }

  async diagnostics(page, contract, error) {
    const directory = path.join(this.downloadsRoot, "_google-flow-ui-diagnostics");
    await fs.mkdir(directory, { recursive: true });
    const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const screenshotPath = path.join(directory, `${stamp}.png`);
    const jsonPath = path.join(directory, `${stamp}.json`);
    await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
    const visibleText = await page.locator("body").innerText().catch(() => "");
    await fs.writeFile(jsonPath, `${JSON.stringify({
      captured_at: new Date().toISOString(),
      url: page.url(),
      expected_contract: contract,
      failure: { code: error.code ?? "ui_contract_mismatch", message: redactBrowserDiagnostic(error.message) },
      visible_text: visibleText.slice(0, 12_000),
      screenshot_path: screenshotPath,
    }, null, 2)}\n`);
    return jsonPath;
  }

  async verifyUiContract(page) {
    const contract = {
      provider: "google-flow",
      account_plan: this.flowPlanLabel,
      model_label: this.flowModelLabel,
      aspect_ratio: "16:9",
      output_count: 1,
    };
    try {
      let bodyText = (await page.locator("body").innerText()).replace(/\s+/g, " ");

      // Flow's current project UI opens in Video mode and exposes media
      // settings through one overlay trigger. Keep this path ahead of the
      // legacy Agent/Nano Banana menu without removing legacy compatibility.
      const settingsTrigger = await visibleLocator(page.getByRole("button", {
        name: "Settings trigger",
        exact: true,
      }));
      if (settingsTrigger) {
        const escapedModelLabel = this.flowModelLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const currentSettingsText = (await settingsTrigger.innerText()).replace(/\s+/g, " ");
        const alreadyConfigured = new RegExp(escapedModelLabel, "i").test(currentSettingsText)
          && /16:9|crop_16_9/.test(currentSettingsText)
          && /x1\b/.test(currentSettingsText);
        if (alreadyConfigured) {
          const accountPlanEvidence = flowPlanVerificationEvidence(bodyText, this.flowPlanLabel, this.flowModelLabel);
          if (!accountPlanEvidence) {
            throw codedError("account_mismatch", `Google Flow exposed neither plan ${this.flowPlanLabel} nor entitled model ${this.flowModelLabel}.`);
          }
          return { ...contract, account_plan_evidence: accountPlanEvidence, verified_at: new Date().toISOString() };
        }

        await settingsTrigger.click().catch(() => settingsTrigger.click({ force: true }));
        const imageRadio = await waitForVisible(
          page.getByRole("radio", { name: /\bImage\b/i }),
          { timeoutMs: 10_000 },
        ) ?? await visibleLocator(
          page.locator('button[role="radio"]').filter({ hasText: /\bImage\b/i }),
        );
        if (!imageRadio) throw codedError("ui_contract_mismatch", "Google Flow Image media-mode control is missing.");
        await imageRadio.click({ force: true });

        const landscapeRadio = await waitForVisible(
          page.getByRole("radio", { name: /16:9/ }),
          { timeoutMs: 10_000 },
        ) ?? await visibleLocator(
          page.locator('button[role="radio"]').filter({ hasText: /16:9/ }),
        );
        const oneOutputRadio = await waitForVisible(
          page.getByRole("radio", { name: /^x1$/i }),
          { timeoutMs: 10_000 },
        ) ?? await visibleLocator(
          page.locator('button[role="radio"]').filter({ hasText: /\bx1\b/i }),
        );
        if (!landscapeRadio || !oneOutputRadio) {
          throw codedError("ui_contract_mismatch", "Google Flow 16:9 or x1 image setting is missing.");
        }
        await landscapeRadio.click({ force: true });
        await oneOutputRadio.click({ force: true });

        let currentModel = await visibleLocator(page.getByRole("button", {
          name: "Select model family",
          exact: true,
        }));
        if (!currentModel) {
          currentModel = await visibleLocator(page.locator("button").filter({ hasText: /Nano Banana/i }));
        }
        if (!currentModel) throw codedError("ui_contract_mismatch", "Google Flow model dropdown is missing.");
        if (!new RegExp(escapedModelLabel, "i").test(await currentModel.innerText())) {
          await currentModel.click({ force: true });
          const wantedModel = await waitForVisible(
            page.getByRole("menuitem").filter({ hasText: new RegExp(`^\\s*🍌?\\s*${escapedModelLabel}\\s*$`, "i") }),
            { timeoutMs: 10_000 },
          );
          if (!wantedModel) throw codedError("ui_contract_mismatch", `Expected Google Flow model ${this.flowModelLabel}.`);
          await wantedModel.click({ force: true });
        }

        await page.keyboard.press("Escape").catch(() => {});
        bodyText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
        const configuredSettings = await visibleLocator(page.getByRole("button", {
          name: "Settings trigger",
          exact: true,
        }));
        if (!configuredSettings) throw codedError("ui_contract_mismatch", "Google Flow image settings trigger disappeared after configuration.");
        const configuredText = (await configuredSettings.innerText()).replace(/\s+/g, " ");
        if (!new RegExp(escapedModelLabel, "i").test(configuredText)) {
          throw codedError("ui_contract_mismatch", `Google Flow did not retain model ${this.flowModelLabel}.`);
        }
        if (!/16:9|crop_16_9/.test(configuredText) || !/x1\b/.test(configuredText)) {
          throw codedError("ui_contract_mismatch", `Google Flow did not retain 16:9 x1 settings: ${configuredText}.`);
        }
        const accountPlanEvidence = flowPlanVerificationEvidence(bodyText, this.flowPlanLabel, this.flowModelLabel);
        if (!accountPlanEvidence) {
          throw codedError("account_mismatch", `Google Flow exposed neither plan ${this.flowPlanLabel} nor entitled model ${this.flowModelLabel}.`);
        }
        return { ...contract, account_plan_evidence: accountPlanEvidence, verified_at: new Date().toISOString() };
      }

      let modelControl = await visibleLocator(page.getByRole("button", { name: /Nano Banana/i }));
      if (!modelControl) {
        const agentToggle = await visibleLocator(page.getByRole("button", { name: "Agent", exact: true }));
        if (!agentToggle) throw codedError("ui_contract_mismatch", "Google Flow media-mode toggle is missing.");
        await agentToggle.click();
        modelControl = await waitForVisible(page.getByRole("button", { name: /Nano Banana/i }), { timeoutMs: 10_000 });
      }
      if (!modelControl) throw codedError("ui_contract_mismatch", "Google Flow image settings control is missing.");
      await modelControl.click().catch(() => modelControl.click({ force: true }));
      let settingsMenu = await waitForVisible(page.getByRole("menu").filter({ hasText: /16:9/ }), { timeoutMs: 5_000 });
      if (!settingsMenu) {
        await page.keyboard.press("Escape").catch(() => {});
        await modelControl.click({ force: true });
        settingsMenu = await waitForVisible(page.getByRole("menu").filter({ hasText: /16:9/ }), { timeoutMs: 10_000 });
      }
      if (!settingsMenu) throw codedError("ui_contract_mismatch", "Google Flow image settings menu did not open.");
      const imageTab = await visibleLocator(settingsMenu.getByRole("tab", { name: /Image/i }));
      const landscapeTab = await visibleLocator(settingsMenu.getByRole("tab", { name: /16:9/ }));
      const oneOutputTab = await visibleLocator(settingsMenu.getByRole("tab", { name: "x1", exact: true }));
      if (!imageTab || !landscapeTab || !oneOutputTab) throw codedError("ui_contract_mismatch", "Google Flow Image, 16:9, or x1 setting is missing.");
      await imageTab.click();
      await landscapeTab.click();
      await oneOutputTab.click();

      const currentModel = await visibleLocator(settingsMenu.getByRole("button", { name: /Nano Banana/i }));
      if (!currentModel) throw codedError("ui_contract_mismatch", "Google Flow model dropdown is missing.");
      if (!new RegExp(this.flowModelLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(await currentModel.innerText())) {
        await currentModel.click();
        const wantedModel = await waitForVisible(page.getByRole("menuitem").filter({ hasText: new RegExp(`^\\s*🍌?\\s*${this.flowModelLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i") }), { timeoutMs: 10_000 });
        if (!wantedModel) throw codedError("ui_contract_mismatch", `Expected Google Flow model ${this.flowModelLabel}.`);
        await wantedModel.click();
      }
      await page.keyboard.press("Escape").catch(() => {});
      bodyText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
      const configuredModel = await visibleLocator(page.getByRole("button", { name: new RegExp(this.flowModelLabel, "i") }));
      if (!configuredModel) throw codedError("ui_contract_mismatch", `Google Flow did not retain model ${this.flowModelLabel}.`);
      const configuredText = (await configuredModel.innerText()).replace(/\s+/g, " ");
      if (!/16:9|crop_16_9/.test(configuredText) || !/x1\b/.test(configuredText)) {
        throw codedError("ui_contract_mismatch", `Google Flow did not retain 16:9 x1 settings: ${configuredText}.`);
      }
      const accountPlanEvidence = flowPlanVerificationEvidence(bodyText, this.flowPlanLabel, this.flowModelLabel);
      if (!accountPlanEvidence) {
        throw codedError("account_mismatch", `Google Flow exposed neither plan ${this.flowPlanLabel} nor entitled model ${this.flowModelLabel}.`);
      }
      return { ...contract, account_plan_evidence: accountPlanEvidence, verified_at: new Date().toISOString() };
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      const diagnosticPath = await this.diagnostics(page, contract, error).catch(() => null);
      error.message = redactBrowserDiagnostic(error.message);
      if (diagnosticPath) error.message = `${error.message} Diagnostics: ${diagnosticPath}`;
      throw error;
    }
  }

  async composer(page) {
    const composer = await visibleLocator(page.locator(PROMPT_SELECTOR));
    if (!composer) throw codedError("ui_contract_mismatch", "Google Flow prompt composer is not visible.");
    return composer;
  }

  async composerAddButton(page) {
    const composer = await this.composer(page);
    const currentAddButton = await visibleLocator(page.getByRole("button", {
      name: /Add ingredients to the prompt box/i,
    }));
    if (currentAddButton) {
      await currentAddButton.evaluate((button) => {
        document.querySelectorAll('[data-goldflow-composer-add="true"]').forEach((element) => element.removeAttribute("data-goldflow-composer-add"));
        button.setAttribute("data-goldflow-composer-add", "true");
      });
      return {
        button: page.locator('[data-goldflow-composer-add="true"]'),
        dialogId: await currentAddButton.getAttribute("aria-controls"),
        popup: await currentAddButton.getAttribute("aria-haspopup"),
      };
    }
    const result = await composer.evaluate((node) => {
      document.querySelectorAll('[data-goldflow-composer-add="true"]').forEach((element) => element.removeAttribute("data-goldflow-composer-add"));
      const visible = (element) => Boolean(element?.getClientRects().length)
        && getComputedStyle(element).visibility !== "hidden"
        && getComputedStyle(element).display !== "none";
      const buttons = [...document.querySelectorAll('button[aria-haspopup="dialog"][aria-controls]')]
        .filter((button) => visible(button) && (["add", "add_2"].includes(button.textContent?.trim())
          || [...button.querySelectorAll("*")].some((element) => ["add", "add_2"].includes(element.textContent?.trim()))));
      const ancestry = (element) => {
        const rows = [];
        for (let current = element; current; current = current.parentElement) rows.push(current);
        return rows;
      };
      const composerAncestors = ancestry(node);
      const ranked = buttons.map((button) => {
        const buttonAncestors = ancestry(button);
        const common = composerAncestors.find((ancestor) => buttonAncestors.includes(ancestor));
        const score = common
          ? composerAncestors.indexOf(common) + buttonAncestors.indexOf(common)
          : Number.MAX_SAFE_INTEGER;
        return { button, score };
      }).sort((left, right) => left.score - right.score);
      if (!ranked.length || ranked[0].score === Number.MAX_SAFE_INTEGER) return null;
      if (ranked.length > 1 && ranked[0].score === ranked[1].score) return { ambiguous: true };
      const button = ranked[0].button;
      button.setAttribute("data-goldflow-composer-add", "true");
      return {
        ambiguous: false,
        controls: button.getAttribute("aria-controls"),
        popup: button.getAttribute("aria-haspopup"),
      };
    });
    if (!result || result.ambiguous || result.popup !== "dialog" || !result.controls) {
      throw codedError("ui_contract_mismatch", "Google Flow did not expose one unambiguous composer add-media button controlling a media dialog.");
    }
    const button = page.locator('[data-goldflow-composer-add="true"]');
    if (await button.count() !== 1 || !await button.isVisible().catch(() => false)) {
      throw codedError("ui_contract_mismatch", "Google Flow composer add-media control could not be bound to the visible composer.");
    }
    return { button, dialogId: result.controls };
  }

  controlledDialog(page, dialogId) {
    return page.locator(`[role="dialog"][id=${JSON.stringify(dialogId)}]`).first();
  }

  async openMediaDialog(page) {
    const visibleMediaDialog = async (timeoutMs = 0) => {
      const deadline = Date.now() + timeoutMs;
      do {
        const dialogs = page.locator('[role="dialog"], .add-menu-popover-container.flow-menu-panel');
        for (let index = 0; index < await dialogs.count(); index += 1) {
          const candidate = dialogs.nth(index);
          if (!await candidate.isVisible().catch(() => false)) continue;
          const hasMediaAction = await candidate.getByRole("button", { name: /upload media|add to prompt/i }).count().catch(() => 0);
          if (hasMediaAction > 0) return candidate;
        }
        if (Date.now() < deadline) await sleep(100);
      } while (Date.now() < deadline);
      return null;
    };

    const alreadyOpen = await visibleMediaDialog();
    if (alreadyOpen) return { dialog: alreadyOpen, dialogId: await alreadyOpen.getAttribute("id").catch(() => null) };

    try {
      const { button, dialogId } = await this.composerAddButton(page);
      let dialog = dialogId ? this.controlledDialog(page, dialogId) : null;
      if (!dialog || !await dialog.isVisible().catch(() => false)) {
        await button.click();
        dialog = dialogId
          ? await waitForVisible(this.controlledDialog(page, dialogId), { timeoutMs: 10_000 })
          : await visibleMediaDialog(10_000);
      }
      if (!dialog) {
        throw codedError(
          "ui_contract_mismatch",
          dialogId
            ? `Google Flow composer add button did not open its controlled dialog ${dialogId}.`
            : "Google Flow composer add button did not open its media picker.",
        );
      }
      return { dialog, dialogId };
    } catch (error) {
      if (error?.code !== "ui_contract_mismatch") throw error;
      const videoModeControl = await visibleLocator(page.getByRole("button", { name: FLOW_VIDEO_CONTROL_LABEL_PATTERN }));
      const startSlot = videoModeControl
        ? await visibleLocator(page.locator('[role="button"][aria-label*="Start frame" i], [aria-label*="Start frame" i]'))
          ?? await visibleLocator(page.getByText("Start", { exact: true }))
        : null;
      if (!startSlot) throw error;
      await startSlot.click();
      await this.acceptUploadNotice(page);
      let dialog = await visibleMediaDialog(2_000);
      if (!dialog && await startSlot.isVisible().catch(() => false)) {
        await startSlot.click();
        dialog = await visibleMediaDialog(10_000);
      }
      if (!dialog) throw codedError("ui_contract_mismatch", "Google Flow Start frame control did not open a media dialog.");
      return { dialog, dialogId: await dialog.getAttribute("id").catch(() => null) };
    }
  }

  async addToPromptControl(page) {
    const result = await page.evaluate(() => {
      document.querySelectorAll('[data-goldflow-add-to-prompt="true"]').forEach((element) => element.removeAttribute("data-goldflow-add-to-prompt"));
      const visible = (element) => Boolean(element?.getClientRects().length)
        && getComputedStyle(element).visibility !== "hidden"
        && getComputedStyle(element).display !== "none";
      const controls = [...document.querySelectorAll("*")]
        .filter((element) => visible(element) && element.textContent?.trim().toLowerCase() === "add to prompt")
        .map((element) => element.closest('button, [role="button"]') ?? element)
        .filter(visible)
        .filter((element, index, rows) => rows.indexOf(element) === index);
      if (controls.length !== 1) return { count: controls.length };
      controls[0].setAttribute("data-goldflow-add-to-prompt", "true");
      return { count: 1 };
    }).catch(() => ({ count: 0 }));
    if (result.count === 1) {
      const control = page.locator('[data-goldflow-add-to-prompt="true"]');
      if (await control.count() === 1 && await control.isVisible().catch(() => false)) return control;
    }
    // Playwright text selectors pierce Flow's open shadow roots, while a page
    // evaluate query cannot. In the current picker the action label is exposed
    // only through that shadow-DOM path.
    const button = await visibleLocator(page.getByRole("button", { name: /^Add to prompt$/i }));
    return button ?? visibleLocator(page.getByText(/^Add to prompt$/i));
  }

  async waitForAddToPromptControl(page, { timeoutMs = 30_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const control = await this.addToPromptControl(page);
      if (control) return control;
      await sleep(100);
    }
    return null;
  }

  async uploadedAssetControl(page, filename) {
    const optionRows = page.getByRole("option");
    for (let index = 0; index < await optionRows.count(); index += 1) {
      const candidate = optionRows.nth(index);
      if (!await candidate.isVisible().catch(() => false)) continue;
      const exactFilename = await candidate.locator(".asset-title").first().innerText().catch(() => "");
      if (exactFilename.trim() === filename) return candidate;
    }
    const selectors = [
      page.getByText(filename, { exact: true }),
      page.locator(`[alt=${JSON.stringify(filename)}], [aria-label=${JSON.stringify(filename)}], [title=${JSON.stringify(filename)}]`),
    ];
    const visible = [];
    for (const locator of selectors) {
      for (let index = 0; index < await locator.count(); index += 1) {
        const candidate = locator.nth(index);
        if (!await candidate.isVisible().catch(() => false)) continue;
        const box = await candidate.boundingBox().catch(() => null);
        if (box) visible.push({ candidate, box });
      }
    }
    visible.sort((left, right) => left.box.y - right.box.y || left.box.x - right.box.x);
    return visible[0]?.candidate ?? null;
  }

  async acceptUploadNotice(page, { mediaDialogId = null } = {}) {
    const dialogs = page.locator('[role="dialog"]');
    for (let index = 0; index < await dialogs.count(); index += 1) {
      const dialog = dialogs.nth(index);
      if (!await dialog.isVisible().catch(() => false)) continue;
      // Flow can remove a dialog between count() and nth(). Avoid inheriting
      // Playwright's 30-second locator timeout for an element that has vanished.
      const dialogId = await dialog.getAttribute("id", { timeout: 1_000 }).catch(() => null);
      if (mediaDialogId && dialogId === mediaDialogId) continue;
      const text = await dialog.innerText().catch(() => "");
      if (!/(before you upload|rights? to|terms|policy|responsib|acknowledge|I agree)/i.test(text)) continue;
      const checkbox = dialog.locator('input[type="checkbox"], [role="checkbox"]').first();
      if (await checkbox.isVisible().catch(() => false)
        && !await checkbox.isChecked().catch(() => false)) await checkbox.click();
      const accept = await visibleLocator(dialog.getByRole("button", { name: /accept|agree|continue|confirm/i }));
      if (!accept) throw codedError("ui_contract_mismatch", "Google Flow upload notice has no explicit accept/agree control.");
      await accept.click();
    }
  }

  async dialogMedia(dialog) {
    return dialog.evaluate((root, fragment) => {
      const visible = (element) => Boolean(element?.getClientRects().length)
        && getComputedStyle(element).visibility !== "hidden"
        && getComputedStyle(element).display !== "none";
      const values = (element) => {
        const candidates = [];
        if (element instanceof HTMLImageElement && element.currentSrc) candidates.push(element.currentSrc);
        for (const name of ["src", "href", "data-src", "data-url"]) {
          const value = element.getAttribute?.(name);
          if (value) candidates.push(value);
        }
        const background = element instanceof HTMLElement ? element.style.backgroundImage : "";
        if (background) candidates.push(...[...background.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map((match) => match[1]));
        return candidates;
      };
      const rows = [];
      const seen = new Set();
      for (const element of root.querySelectorAll("img, [src], [href], [data-src], [data-url], [style*='background']")) {
        if (!visible(element)) continue;
        for (const value of values(element)) {
          try {
            const url = new URL(value, location.href);
            const currentMediaId = url.hostname === "flow-content.google" && url.pathname.startsWith("/image/")
              ? url.pathname.split("/").filter(Boolean).at(-1) ?? ""
              : "";
            if (!url.pathname.includes(fragment) && !currentMediaId) continue;
            const mediaId = url.searchParams.get("name") ?? currentMediaId;
            if (!mediaId || seen.has(mediaId)) continue;
            seen.add(mediaId);
            rows.push({ media_id: mediaId, media_url: url.href });
          } catch {}
        }
      }
      return rows;
    }, FLOW_MEDIA_PATH_FRAGMENT, { timeout: 1_000 });
  }

  async selectUploadedPreview(page, dialog, {
    filename,
    priorMediaIds,
    priorComposerMediaIds = [],
    timeoutMs = 90_000,
  }) {
    const deadline = Date.now() + timeoutMs;
    let lastParsedMedia = null;
    let lastProbe = null;
    while (Date.now() < deadline) {
      const pageVisibleLines = (await page.locator("body").innerText().catch(() => ""))
        .split(/\r?\n/)
        .map((line) => line.trim());
      const pageExactNameVisible = pageVisibleLines.includes(filename);
      const pageAddToPrompt = await this.addToPromptControl(page);
      const pageAddToPromptDisabled = pageAddToPrompt
        ? await pageAddToPrompt.isDisabled().catch(() => true)
        : null;
      lastProbe = {
        exact_name_visible: pageExactNameVisible,
        add_to_prompt_visible: Boolean(pageAddToPrompt),
        add_to_prompt_disabled: pageAddToPromptDisabled,
        add_to_prompt_html: pageAddToPrompt
          ? await pageAddToPrompt.evaluate((element) => element.outerHTML.slice(0, 800)).catch(() => null)
          : null,
      };
      if (pageExactNameVisible && pageAddToPrompt) {
        if (!pageAddToPromptDisabled) return lastParsedMedia ?? { media_id: null, media_url: null };
        const uploadedAsset = await this.uploadedAssetControl(page, filename);
        if (uploadedAsset) {
          await uploadedAsset.click({ force: true });
          await sleep(300);
          continue;
        }
      }
      if (pageExactNameVisible && !pageAddToPrompt) {
        // Flow can bypass the library-selection step and attach a freshly
        // uploaded file directly to the composer. Accept that path only when
        // the exact filename is visible and the ordered composer dock proves
        // exactly one fully loaded chip was appended.
        const composerState = await this.composerDockState(page).catch(() => null);
        const autoAttached = identifyAutoAttachedFlowComposerChip(priorComposerMediaIds, composerState);
        if (autoAttached) return { ...autoAttached, already_attached: true };
        // The current asset-list picker first exposes the uploaded filename as
        // an unselected row and does not render Add to Prompt until that exact
        // row is selected.
        const uploadedAsset = await this.uploadedAssetControl(page, filename);
        if (uploadedAsset) {
          await uploadedAsset.click({ force: true });
          await sleep(300);
          continue;
        }
      }
      const marked = await dialog.evaluate((root, { filename: wanted, fragment }) => {
        root.querySelectorAll('[data-goldflow-upload-preview="true"]').forEach((element) => element.removeAttribute("data-goldflow-upload-preview"));
        const visible = (element) => Boolean(element?.getClientRects().length)
          && getComputedStyle(element).visibility !== "hidden"
          && getComputedStyle(element).display !== "none";
        const exactName = (element) => [
          element.getAttribute?.("alt"),
          element.getAttribute?.("aria-label"),
          element.getAttribute?.("title"),
          element.textContent?.trim(),
        ].some((value) => value === wanted);
        const urlRows = (scope) => {
          const rows = [];
          for (const element of scope.querySelectorAll("img, [src], [href], [data-src], [data-url], [style*='background']")) {
            const candidates = [];
            if (element instanceof HTMLImageElement && element.currentSrc) candidates.push(element.currentSrc);
            for (const name of ["src", "href", "data-src", "data-url"]) {
              const value = element.getAttribute?.(name);
              if (value) candidates.push(value);
            }
            const background = element instanceof HTMLElement ? element.style.backgroundImage : "";
            if (background) candidates.push(...[...background.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map((match) => match[1]));
            for (const value of candidates) {
              try {
                const url = new URL(value, location.href);
                const currentMediaId = url.hostname === "flow-content.google" && url.pathname.startsWith("/image/")
                  ? url.pathname.split("/").filter(Boolean).at(-1) ?? ""
                  : "";
                if (!url.pathname.includes(fragment) && !currentMediaId) continue;
                const mediaId = url.searchParams.get("name") ?? currentMediaId;
                if (mediaId) rows.push({ media_id: mediaId, media_url: url.href });
              } catch {}
            }
          }
          return rows;
        };
        const named = [...root.querySelectorAll("*")].filter((element) => visible(element) && exactName(element));
        const candidates = [];
        for (const element of named) {
          let current = element;
          for (let depth = 0; current && current !== root && depth < 8; depth += 1, current = current.parentElement) {
            const rows = urlRows(current);
            if (!rows.length) continue;
            const candidate = current.matches('button, [role="button"], [role="option"], [role="gridcell"], [tabindex]')
              ? current
              : current.closest('button, [role="button"], [role="option"], [role="gridcell"], [tabindex]') ?? current;
            const clickable = root.contains(candidate) ? candidate : current;
            candidates.push({ clickable, rows });
            break;
          }
        }
        const mediaIds = [...new Set(candidates.flatMap((candidate) => candidate.rows.map((row) => row.media_id)))];
        if (mediaIds.length > 1) return { ambiguous: true, named_count: named.length };
        const selected = candidates.find((candidate) => candidate.rows.some((row) => row.media_id === mediaIds[0]));
        if (!selected) return { ambiguous: false, named_count: named.length, media: null };
        selected.clickable.setAttribute("data-goldflow-upload-preview", "true");
        return {
          ambiguous: false,
          named_count: named.length,
          media: selected.rows.find((row) => row.media_id === mediaIds[0]),
        };
      }, { filename, fragment: FLOW_MEDIA_PATH_FRAGMENT }, { timeout: 1_000 }).catch(() => null);
      if (marked?.ambiguous) throw codedError("ui_contract_mismatch", `Google Flow media dialog matched ${filename} to more than one media item.`);
      if (marked?.media) {
        const parsed = parseFlowMedia(marked.media.media_url);
        if (!parsed) throw codedError("ui_contract_mismatch", `Google Flow selected preview ${filename} has an invalid media URL.`);
        lastParsedMedia = parsed;
        const target = dialog.locator('[data-goldflow-upload-preview="true"]');
        // Flow replaces the upload tile while its percentage indicator settles.
        // A marker can therefore disappear between evaluate() and locator()
        // without indicating ambiguity; wait for the stable replacement.
        if (await target.count() !== 1 || !await target.isVisible().catch(() => false)) {
          await sleep(250);
          continue;
        }
        const alreadySelected = await this.addToPromptControl(page);
        if (!alreadySelected) await target.click();
        return parsed;
      }
      const media = await this.dialogMedia(dialog).catch(() => []);
      const fresh = media.filter((row) => !priorMediaIds.has(row.media_id));
      // Frames mode exposes the selected upload name on the underlying media
      // canvas instead of inside the picker dialog. Keep the proof exact and
      // page-scoped so the opaque preview can still be bound safely.
      const exactNameVisible = Number(marked?.named_count ?? 0) > 0
        || await dialog.getByText(filename, { exact: true }).count().catch(() => 0) > 0
        || await page.getByText(filename, { exact: true }).count().catch(() => 0) > 0
        || pageVisibleLines.includes(filename);
      const addToPrompt = await this.addToPromptControl(page);
      const addToPromptDisabled = addToPrompt
        ? await addToPrompt.isDisabled().catch(() => true)
        : null;
      lastProbe = {
        exact_name_visible: exactNameVisible,
        add_to_prompt_visible: Boolean(addToPrompt),
        add_to_prompt_disabled: addToPromptDisabled,
        add_to_prompt_html: addToPrompt
          ? await addToPrompt.evaluate((element) => element.outerHTML.slice(0, 800)).catch(() => null)
          : null,
      };
      if (exactNameVisible && addToPrompt && addToPromptDisabled) {
        const uploadedAsset = await this.uploadedAssetControl(page, filename);
        if (uploadedAsset) {
          await uploadedAsset.click({ force: true });
          await sleep(300);
          continue;
        }
      }
      if (exactNameVisible && addToPrompt && !addToPromptDisabled) {
        // The current Frames picker can render a selected preview through an
        // opaque canvas with no stable media URL. The exact filename plus the
        // enabled Add to Prompt action proves selection; the materialized
        // composer chip supplies the durable media identity immediately after.
        return lastParsedMedia ?? { media_id: null, media_url: null };
      }
      if (exactNameVisible && !addToPrompt) {
        const uploadedAsset = await this.uploadedAssetControl(page, filename);
        if (uploadedAsset) {
          await uploadedAsset.click({ force: true });
          await sleep(300);
          continue;
        }
      }
      if (exactNameVisible && fresh.length === 1) {
        const parsed = parseFlowMedia(fresh[0].media_url);
        if (!parsed) throw codedError("ui_contract_mismatch", `Google Flow uploaded preview ${filename} has an invalid media URL.`);
        const alreadySelected = await this.addToPromptControl(page);
        if (!alreadySelected) await dialog.getByText(filename, { exact: true }).first().click();
        return parsed;
      }
      await sleep(250);
    }
    throw codedError("provider_response_timeout", `Timed out waiting for Google Flow to expose an exact selected preview for uploaded file ${filename}. Probe: ${JSON.stringify(lastProbe)}.`);
  }

  async markComposerDock(page) {
    const composer = await this.composer(page);
    const marked = await composer.evaluate((node) => {
      document.querySelectorAll('[data-goldflow-composer-dock="true"]').forEach((element) => element.removeAttribute("data-goldflow-composer-dock"));
      const visible = (element) => Boolean(element?.getClientRects().length)
        && getComputedStyle(element).visibility !== "hidden"
        && getComputedStyle(element).display !== "none";
      for (let current = node.parentElement; current && current !== document.body; current = current.parentElement) {
        const buttons = [...current.querySelectorAll("button")].filter(visible);
        const hasCreate = buttons.some((button) => {
          const controlText = [
            button.textContent,
            button.getAttribute("aria-label"),
            button.getAttribute("title"),
          ].filter(Boolean).join(" ");
          return button.getAttribute("type") === "submit"
            || /(?:Create|Generate|Submit|arrow_forward|send)/i.test(controlText);
        });
        // Frames mode replaces the add-media control with Start/End slots as
        // soon as the first frame is attached. The composer itself plus its
        // unique visible Create control is therefore the stable dock boundary.
        if (!hasCreate) continue;
        current.setAttribute("data-goldflow-composer-dock", "true");
        return true;
      }
      return false;
    });
    if (!marked) throw codedError("ui_contract_mismatch", "Google Flow composer dock could not be isolated for reference verification.");
    const dock = page.locator('[data-goldflow-composer-dock="true"]');
    if (await dock.count() !== 1 || !await dock.isVisible().catch(() => false)) {
      throw codedError("ui_contract_mismatch", "Google Flow composer dock evidence target is missing or ambiguous.");
    }
    return dock;
  }

  async composerDockState(page) {
    const dock = await this.markComposerDock(page);
    return dock.evaluate((root, fragment) => {
      const visible = (element) => Boolean(element?.getClientRects().length)
        && getComputedStyle(element).visibility !== "hidden"
        && getComputedStyle(element).display !== "none";
      const busy = [...root.querySelectorAll('[aria-busy="true"], [role="progressbar"], [data-state="loading"], [class*="uploading" i]')]
        .some((element) => visible(element));
      const rows = [];
      const seen = new Set();
      for (const element of root.querySelectorAll("img, [src], [href], [data-src], [data-url], [style*='background']")) {
        if (!visible(element)) continue;
        const values = [];
        if (element instanceof HTMLImageElement && element.currentSrc) values.push(element.currentSrc);
        for (const name of ["src", "href", "data-src", "data-url"]) {
          const value = element.getAttribute?.(name);
          if (value) values.push(value);
        }
        const background = element instanceof HTMLElement ? element.style.backgroundImage : "";
        if (background) values.push(...[...background.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map((match) => match[1]));
        for (const value of values) {
          try {
            const url = new URL(value, location.href);
            const currentMediaId = url.hostname === "flow-content.google" && url.pathname.startsWith("/image/")
              ? url.pathname.split("/").filter(Boolean).at(-1) ?? ""
              : "";
            if (!url.pathname.includes(fragment) && !currentMediaId) continue;
            const mediaId = url.searchParams.get("name") ?? currentMediaId;
            if (!mediaId || seen.has(mediaId)) continue;
            seen.add(mediaId);
            const rect = element.getBoundingClientRect();
            rows.push({
              media_id: mediaId,
              media_url: url.href,
              loaded: !(element instanceof HTMLImageElement) || (element.complete && element.naturalWidth > 0 && element.naturalHeight > 0),
              top: rect.top,
              left: rect.left,
            });
          } catch {}
        }
      }
      rows.sort((left, right) => Math.abs(left.top - right.top) > 4
        ? left.top - right.top
        : left.left - right.left);
      return { busy, chips: rows };
    }, FLOW_MEDIA_PATH_FRAGMENT);
  }

  async waitForComposerChips(page, expectedMediaIds, { timeoutMs = 30_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let latest = { busy: true, chips: [] };
    while (Date.now() < deadline) {
      latest = await this.composerDockState(page);
      if (!latest.busy
        && latest.chips.length === expectedMediaIds.length
        && latest.chips.every((chip, index) => chip.loaded === true && chip.media_id === expectedMediaIds[index])) return latest;
      await sleep(200);
    }
    throw codedError("ui_contract_mismatch", `Google Flow composer reference chips did not settle in exact order (${latest.chips.map((row) => row.media_id).join(", ") || "none"}).`);
  }

  async waitForComposerChipCount(page, expectedCount, { timeoutMs = 90_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let latest = { busy: true, chips: [] };
    while (Date.now() < deadline) {
      latest = await this.composerDockState(page);
      if (!latest.busy
        && latest.chips.length === expectedCount
        && latest.chips.every((chip) => chip.loaded === true)) return latest;
      await sleep(200);
    }
    const chips = latest.chips.map((row) => `${row.media_id}:${row.loaded === true ? "loaded" : "pending"}`).join(", ") || "none";
    throw codedError("ui_contract_mismatch", `Google Flow composer reference chip count did not settle at ${expectedCount} (busy=${latest.busy}; ${chips}).`);
  }

  async ensureCleanImageComposer(page, { slot = 0, persistentWorker = false } = {}) {
    await dismissFlowChangelog(page);
    await this.composer(page);
    const dockState = await this.waitForComposerChips(page, [], { timeoutMs: 1_500 }).catch(async () => this.composerDockState(page));
    const terminalCardText = (await page.getByText(
      /We noticed some unusual activity|This generation might violate|failed to generate|something went wrong/i,
    ).allInnerTexts().catch(() => [])).join("\n");
    const needsReplacement = flowPersistentComposerNeedsReplacement({
      terminalCardText,
      referenceChipCount: dockState?.chips?.length ?? 0,
    });
    if (!needsReplacement && dockState?.busy === false) return page;
    if (!persistentWorker) {
      throw codedError("ui_contract_mismatch", "Google Flow fresh image composer started with stale references or failed-generation state.");
    }
    const workerSlot = this.assertWorkerSlot(slot);
    const priorWorker = this.workerPages.get(workerSlot);
    const replacement = await this.replacePersistentWorkerPage(
      workerSlot,
      priorWorker,
      "the prior job left stale references or failed-generation state in the composer",
    );
    await this.waitForComposerChips(replacement.page, [], { timeoutMs: 15_000 });
    return replacement.page;
  }

  async attachReferences(page, job, client, onPhase) {
    const references = Array.isArray(job.references) ? job.references : [];
    if (job.references?.length > 4) throw codedError("ui_contract_mismatch", "Google Flow supports at most four ordered prompt references.");
    await onPhase("attaching_references");
    const initial = await this.waitForComposerChips(page, []);
    if (initial.chips.length !== 0) throw codedError("ui_contract_mismatch", "Google Flow composer started with stale reference chips.");
    const referenceInputs = [];
    const boundReferences = [];
    let composerMediaIds = initial.chips.map((chip) => chip.media_id);

    const expectedSlots = references.map((reference) => Number(reference.slot)).sort((left, right) => left - right);
    if (expectedSlots.some((slot, index) => slot !== index + 1)) {
      throw codedError("ui_contract_mismatch", "Google Flow references are not assigned to contiguous ordered slots.");
    }
    // Flow prepends each newly materialized composer chip, so upload in reverse
    // slot order to preserve canonical visible dock order.
    for (const reference of flowReferenceUploadOrder(references)) {
      const expectedSlot = Number(reference.slot);
      const sourceSha256 = exactSha256(reference.sha256, `Google Flow reference ${reference.ref_id} assignment hash`);
      const downloaded = reference.path
        ? {
            bytes: await fs.readFile(path.resolve(reference.path)),
            mimeType: /\.webp$/i.test(reference.path) ? "image/webp"
              : /\.jpe?g$/i.test(reference.path) ? "image/jpeg" : "image/png",
          }
        : await client.fetchReference(reference.url);
      const fetchedSha256 = sha256Bytes(downloaded.bytes);
      if (fetchedSha256 !== sourceSha256) {
        throw codedError("ui_contract_mismatch", `Google Flow reference ${reference.ref_id} fetched bytes do not match the assigned SHA-256.`);
      }
      const extension = downloaded.mimeType.includes("png") ? "png" : downloaded.mimeType.includes("webp") ? "webp" : "jpg";
      const uploadFilename = `${String(expectedSlot).padStart(2, "0")}-${safeName(reference.ref_id)}-${sourceSha256.slice(0, 12)}-${safeName(job.lease_token).slice(0, 8)}.${extension}`;
      const file = { name: uploadFilename, mimeType: downloaded.mimeType, buffer: downloaded.bytes };
      let { dialog, dialogId } = await this.openMediaDialog(page);
      const priorMediaIds = new Set((await this.dialogMedia(dialog).catch(() => [])).map((row) => row.media_id));
      const upload = await visibleLocator(dialog.getByRole("button", { name: /upload media/i }));
      if (!upload) throw codedError("ui_contract_mismatch", "Google Flow controlled media dialog has no Upload media action.");
      const chooserPromise = page.waitForEvent("filechooser", { timeout: 10_000 }).catch(() => null);
      await upload.click();
      const chooser = await chooserPromise;
      if (chooser) {
        await chooser.setFiles(file);
      } else {
        const input = dialog.locator('input[type="file"]').first();
        if (!await input.count()) throw codedError("ui_contract_mismatch", "Google Flow controlled media dialog did not expose a scoped file chooser.");
        await input.setInputFiles(file);
      }
      await this.acceptUploadNotice(page, { mediaDialogId: dialogId });
      ({ dialog, dialogId } = await this.openMediaDialog(page));
      const selected = await this.selectUploadedPreview(page, dialog, {
        filename: uploadFilename,
        priorMediaIds,
        priorComposerMediaIds: composerMediaIds,
      });
      if (selected.already_attached !== true) {
        const addToPrompt = await this.waitForAddToPromptControl(page, { timeoutMs: 30_000 });
        if (!addToPrompt) throw codedError("ui_contract_mismatch", `Google Flow selected preview ${uploadFilename} has no Add to Prompt action.`);
        const enabledDeadline = Date.now() + 30_000;
        while (Date.now() < enabledDeadline && await addToPrompt.isDisabled().catch(() => true)) await sleep(200);
        if (await addToPrompt.isDisabled().catch(() => true)) {
          throw codedError("ui_contract_mismatch", `Google Flow Add to Prompt never enabled for ${uploadFilename}.`);
        }
        await addToPrompt.click();
      } else if (await dialog.isVisible().catch(() => false)) {
        await page.keyboard.press("Escape");
      }
      const closeDeadline = Date.now() + 10_000;
      while (Date.now() < closeDeadline && await dialog.isVisible().catch(() => false)) await sleep(100);
      if (await dialog.isVisible().catch(() => false)) {
        throw codedError("ui_contract_mismatch", `Google Flow controlled media dialog did not close after Add to Prompt for ${uploadFilename}.`);
      }
      const row = {
        slot: expectedSlot,
        ref_id: reference.ref_id,
        source_sha256: sourceSha256,
        upload_filename: uploadFilename,
        upload_media_id: selected.media_id,
        upload_media_url: selected.media_url,
      };
      // Flow materializes a new UUID when a library asset becomes a composer
      // chip. Bind the exact newly appeared chip, not the library preview UUID.
      const settled = await this.waitForComposerChipCount(page, boundReferences.length + 1);
      const composerChip = identifyNewFlowComposerChip(composerMediaIds, settled.chips);
      row.media_id = composerChip.media_id;
      row.media_url = composerChip.media_url;
      row.upload_media_id ??= composerChip.media_id;
      row.upload_media_url ??= composerChip.media_url;
      composerMediaIds = settled.chips.map((chip) => chip.media_id);
      boundReferences.push(row);
      boundReferences.sort((left, right) => left.slot - right.slot);
      const expectedComposerOrder = boundReferences.map((item) => item.media_id);
      if (!settled.chips.every((chip, index) => chip.media_id === expectedComposerOrder[index])) {
        throw codedError("ui_contract_mismatch", `Google Flow composer reference chips settled out of canonical slot order (${settled.chips.map((chip) => chip.media_id).join(", ")}).`);
      }
      referenceInputs.push({
        slot: expectedSlot,
        ref_id: reference.ref_id,
        upload_filename: uploadFilename,
        normalized_pixels: await normalizedImagePixels(downloaded.bytes),
      });
    }
    await onPhase("references_attached");
    return { referenceInputs, boundReferences };
  }

  async recordReferenceBindingEvidence(page, job, prompt, boundReferences) {
    const state = await this.waitForComposerChips(page, boundReferences.map((row) => row.media_id));
    const composer = await this.composer(page);
    const observedPrompt = await composer.evaluate(flowPromptText);
    const create = await this.createButton(page);
    const createEnabled = Boolean(create) && !await create.isDisabled().catch(() => true);
    const visibleDialogs = page.locator('[role="dialog"]');
    let openDialogCount = 0;
    for (let index = 0; index < await visibleDialogs.count(); index += 1) {
      if (await visibleDialogs.nth(index).isVisible().catch(() => false)) openDialogCount += 1;
    }
    const noPendingUploads = state.busy === false && openDialogCount === 0;
    validateFlowReferenceDock({
      expectedReferences: boundReferences,
      observedChips: state.chips,
      expectedPrompt: prompt,
      observedPrompt,
      noPendingUploads,
      createEnabled,
    });

    const evidenceDir = path.join(
      this.downloadsRoot,
      safeName(job.manifest_id),
      "reference-binding-evidence",
      `${safeName(job.asset_id)}-${safeName(job.lease_token).slice(0, 12)}`,
    );
    await fs.mkdir(evidenceDir, { recursive: true });
    const fullScreenshotPath = path.join(evidenceDir, "pre-submit-full.png");
    const composerScreenshotPath = path.join(evidenceDir, "pre-submit-composer-dock.png");
    const receiptPath = path.join(evidenceDir, "reference-binding-receipt.json");
    await page.screenshot({ path: fullScreenshotPath, fullPage: true });
    const dock = await this.markComposerDock(page);
    await dock.screenshot({ path: composerScreenshotPath });
    const [fullScreenshotSha256, composerScreenshotSha256] = await Promise.all([
      sha256File(fullScreenshotPath),
      sha256File(composerScreenshotPath),
    ]);
    const verifiedAt = new Date().toISOString();
    const bindingCore = {
      schema: REFERENCE_BINDING_SCHEMA,
      status: "verified",
      expected_count: boundReferences.length,
      observed_count: state.chips.length,
      add_to_prompt_clicked: true,
      no_pending_uploads: true,
      prompt_text_verified: true,
      ordered_references: boundReferences,
      verified_at: verifiedAt,
    };
    await fs.writeFile(receiptPath, `${JSON.stringify({
      schema: REFERENCE_BINDING_RECEIPT_SCHEMA,
      status: "verified",
      browser_provider: "google-flow",
      manifest_id: job.manifest_id,
      asset_id: job.asset_id,
      project_url: page.url(),
      assignment_prompt_sha256: job.prompt_sha256,
      submitted_prompt_sha256: sha256Bytes(Buffer.from(prompt, "utf8")),
      zero_reference_evidence: boundReferences.length === 0,
      reference_binding: bindingCore,
      screenshots: {
        full_screenshot_path: fullScreenshotPath,
        full_screenshot_sha256: fullScreenshotSha256,
        composer_screenshot_path: composerScreenshotPath,
        composer_screenshot_sha256: composerScreenshotSha256,
      },
      recorded_at: verifiedAt,
    }, null, 2)}\n`, "utf8");
    const receiptSha256 = await sha256File(receiptPath);
    return {
      create,
      referenceBinding: {
        ...bindingCore,
        evidence: {
          project_url: page.url(),
          receipt_path: receiptPath,
          receipt_sha256: receiptSha256,
          full_screenshot_path: fullScreenshotPath,
          full_screenshot_sha256: fullScreenshotSha256,
          composer_screenshot_path: composerScreenshotPath,
          composer_screenshot_sha256: composerScreenshotSha256,
        },
      },
    };
  }

  async pastePrompt(page, prompt) {
    const previous = this.clipboardQueue;
    let release;
    this.clipboardQueue = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      const composer = await this.composer(page);
      await composer.click();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await page.keyboard.press("Backspace");
      await page.evaluate(async (value) => navigator.clipboard.writeText(value), prompt);
      await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
      const deadline = Date.now() + 10_000;
      let actual = "";
      while (Date.now() < deadline) {
        actual = await composer.evaluate((node) => "value" in node ? node.value : node.innerText ?? node.textContent ?? "");
        if (normalizeFlowPromptText(actual) === normalizeFlowPromptText(prompt)) return;
        await sleep(100);
      }
      throw codedError("ui_contract_mismatch", `Google Flow clipboard paste did not bind to the visible composer (received ${normalizeFlowPromptText(actual).slice(0, 120)}).`);
    } finally {
      release();
    }
  }

  async createButton(page) {
    return await visibleLocator(page.getByRole("button", { name: /^(?:Start generation|Create|Generate)$/i }))
      ?? visibleLocator(page.locator('button[type="submit"]').filter({ hasText: /arrow_forward|send/i }));
  }

  async generatedImageUrls(page) {
    return page.locator("img").evaluateAll((images) => images
      .filter((image) => image instanceof HTMLImageElement && image.offsetParent !== null && image.naturalWidth >= 512 && image.naturalHeight >= 288)
      .map((image) => image.currentSrc || image.src)
      .filter(Boolean));
  }

  async generatedOutputImageCandidates(page, referenceInputs = []) {
    const uploadFilenames = referenceInputs.map((row) => row.upload_filename).filter(Boolean);
    return page.locator("img").evaluateAll((images, filenames) => {
      const visible = (element) => Boolean(element?.getClientRects().length)
        && getComputedStyle(element).visibility !== "hidden"
        && getComputedStyle(element).display !== "none";
      const rows = [];
      const seen = new Set();
      for (const image of images) {
        if (!(image instanceof HTMLImageElement)
          || !visible(image)
          || !image.complete
          || image.naturalWidth < 512
          || image.naturalHeight < 288) continue;
        let card = image.parentElement;
        let editLink = image.closest('a[href*="/edit/"]');
        for (let depth = 0; card && depth < 8; depth += 1, card = card.parentElement) {
          editLink ??= card.querySelector?.('a[href*="/edit/"]');
          if (!editLink) continue;
          const caption = String(card.innerText ?? card.textContent ?? "").trim();
          if (!caption) continue;
          if (filenames.some((filename) => caption.includes(filename))) break;
          const sourceUrl = image.currentSrc || image.src;
          if (!sourceUrl || seen.has(sourceUrl)) break;
          seen.add(sourceUrl);
          rows.push({
            source_url: sourceUrl,
            media_edit_url: editLink.href,
            caption: caption.slice(0, 500),
          });
          break;
        }
      }
      return rows;
    }, uploadFilenames);
  }

  async waitForVisibleImagesToSettle(page, { stableMs = 2500, timeoutMs = 30_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastSignature = null;
    let stableSince = Date.now();
    let latest = [];
    while (Date.now() < deadline) {
      latest = await this.generatedImageUrls(page);
      const signature = JSON.stringify([...latest].sort());
      if (signature !== lastSignature) {
        lastSignature = signature;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= stableMs) {
        return latest;
      }
      await sleep(200);
    }
    return latest;
  }

  async imagePixelFingerprint(page, sourceUrl) {
    const bytes = await this.imageBytes(page, sourceUrl);
    return {
      bytes,
      sha256: sha256Bytes(await normalizedImagePixels(bytes)),
    };
  }

  async baselineImageFingerprints(page, sourceUrls) {
    const fingerprints = new Map();
    for (const sourceUrl of sourceUrls) {
      try {
        const fingerprint = await this.imagePixelFingerprint(page, sourceUrl);
        fingerprints.set(sourceUrl, fingerprint.sha256);
      } catch (error) {
        this.log(`Google Flow baseline image could not be fingerprinted: ${redactBrowserDiagnostic(error.message)}`, "warn");
      }
    }
    return fingerprints;
  }

  async waitForGeneratedImage(page, baseline, referenceInputs = [], baselineFingerprints = new Map()) {
    const deadline = Date.now() + 30 * 60_000;
    const baselinePixelSha256s = new Set(baselineFingerprints.values());
    let nextExistingUrlFingerprintAt = 0;
    while (Date.now() < deadline) {
      await this.blockingAlert(page);
      for (const outputCandidate of await this.generatedOutputImageCandidates(page, referenceInputs)) {
        if (baseline.has(outputCandidate.source_url)) continue;
        try {
          const candidate = await this.imagePixelFingerprint(page, outputCandidate.source_url);
          if (baselinePixelSha256s.has(candidate.sha256)) {
            baseline.add(outputCandidate.source_url);
            baselineFingerprints.set(outputCandidate.source_url, candidate.sha256);
            this.log("Ignored a stale Google Flow result whose media URL changed but pixels did not.", "warn");
            continue;
          }
          return {
            sourceUrl: outputCandidate.source_url,
            bytes: candidate.bytes,
            generatedResult: {
              schema: "goldflow_browser_generated_result_v1",
              status: "verified",
              browser_provider: "google-flow",
              source_url: outputCandidate.source_url,
              media_edit_url: outputCandidate.media_edit_url,
              caption: outputCandidate.caption,
            },
          };
        } catch (error) {
          this.log(`Google Flow generated-result card was not downloadable yet: ${redactBrowserDiagnostic(error.message)}`, "warn");
        }
      }
      const urls = await this.generatedImageUrls(page);
      const fresh = urls.filter((url) => !baseline.has(url));
      for (const sourceUrl of fresh) {
        try {
          const candidate = await this.imagePixelFingerprint(page, sourceUrl);
          if (baselinePixelSha256s.has(candidate.sha256)) {
            baseline.add(sourceUrl);
            baselineFingerprints.set(sourceUrl, candidate.sha256);
            this.log("Ignored a stale Google Flow image whose media URL changed but pixels did not.", "warn");
            continue;
          }
          const echo = await findReferenceEcho(candidate.bytes, referenceInputs);
          if (echo) {
            baseline.add(sourceUrl);
            baselineFingerprints.set(sourceUrl, candidate.sha256);
            baselinePixelSha256s.add(candidate.sha256);
            this.log(`Ignored a late Google Flow reference-media echo for slot ${echo.slot ?? "unknown"} (${echo.ref_id ?? "unknown"}; pixel MAE ${echo.mean_absolute_difference.toFixed(4)}).`, "warn");
            continue;
          }
          return { sourceUrl, bytes: candidate.bytes };
        } catch (error) {
          this.log(`Google Flow fresh-image candidate was not downloadable yet: ${redactBrowserDiagnostic(error.message)}`, "warn");
        }
      }
      if (!fresh.length && baselineFingerprints.size && Date.now() >= nextExistingUrlFingerprintAt) {
        nextExistingUrlFingerprintAt = Date.now() + 5_000;
        for (const sourceUrl of urls) {
          const baselineSha256 = baselineFingerprints.get(sourceUrl);
          if (!baselineSha256) continue;
          try {
            const candidate = await this.imagePixelFingerprint(page, sourceUrl);
            if (candidate.sha256 === baselineSha256) continue;
            if (baselinePixelSha256s.has(candidate.sha256)) {
              baselineFingerprints.set(sourceUrl, candidate.sha256);
              this.log("Ignored stale Google Flow pixels that moved onto an existing media URL.", "warn");
              continue;
            }
            const echo = await findReferenceEcho(candidate.bytes, referenceInputs);
            if (echo) {
              baselineFingerprints.set(sourceUrl, candidate.sha256);
              baselinePixelSha256s.add(candidate.sha256);
              this.log(`Ignored a Google Flow reference-media replacement for slot ${echo.slot ?? "unknown"} (${echo.ref_id ?? "unknown"}; pixel MAE ${echo.mean_absolute_difference.toFixed(4)}).`, "warn");
              continue;
            }
            this.log("Detected a completed Google Flow image whose existing media URL was reused.", "info");
            return { sourceUrl, bytes: candidate.bytes };
          } catch (error) {
            this.log(`Google Flow existing-image candidate could not be fingerprinted yet: ${redactBrowserDiagnostic(error.message)}`, "warn");
          }
        }
      }
      await sleep(750);
    }
    throw codedError("ui_contract_mismatch", "Timed out waiting for a generated Google Flow image.");
  }

  async imageBytes(page, sourceUrl) {
    const renderedImageBytes = async (url) => {
      const candidate = page.locator("img");
      for (let index = 0; index < await candidate.count(); index += 1) {
        const image = candidate.nth(index);
        const matches = await image.evaluate((node, wanted) => node instanceof HTMLImageElement
          && (node.currentSrc === wanted || node.src === wanted)
          && node.complete
          && node.naturalWidth >= 512
          && node.naturalHeight >= 288, url).catch(() => false);
        if (matches) return Buffer.from(await image.screenshot({ type: "png" }));
      }
      throw new Error("rendered image element is unavailable");
    };
    const fetchThroughPage = async (url) => {
      const base64 = await page.evaluate(async (url) => {
        const response = await fetch(url, { credentials: "include" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        return btoa(binary);
      }, url);
      return Buffer.from(base64, "base64");
    };
    if (sourceUrl.startsWith("blob:")) {
      return fetchThroughPage(sourceUrl);
    }
    let directError = null;
    try {
      const response = await page.request.get(sourceUrl, { timeout: 120_000 });
      if (response.ok()) return Buffer.from(await response.body());
      directError = new Error(`HTTP ${response.status()}`);
    } catch (error) {
      directError = error instanceof Error ? error : new Error(String(error));
    }
    try {
      return await fetchThroughPage(sourceUrl);
    } catch (error) {
      try {
        return await renderedImageBytes(sourceUrl);
      } catch (renderError) {
        throw new Error(`Google Flow direct image download failed (${redactBrowserDiagnostic(directError?.message ?? "unknown error")}), page-session fetch failed (${redactBrowserDiagnostic(error.message)}), and rendered-image capture failed (${redactBrowserDiagnostic(renderError.message)})`);
      }
    }
  }

  async saveGeneratedImage(page, job, sourceUrl, bytes = null) {
    const directory = path.join(this.downloadsRoot, safeName(job.manifest_id));
    await fs.mkdir(directory, { recursive: true });
    const filePath = path.join(directory, `${safeName(job.asset_id)}-${safeName(job.lease_token.slice(0, 12))}.img`);
    const image = bytes ?? await this.imageBytes(page, sourceUrl);
    if (!image.length) throw new Error("Google Flow generated image download was empty.");
    await fs.writeFile(filePath, image);
    return filePath;
  }

  async verifyVideoUiContract(page, job = {}, configurationAttempt = 1) {
    const requestedDurationSec = Math.max(4, Math.min(10, Math.round(Number(job.duration_sec ?? 8))));
    const contract = {
      provider: "google-flow",
      media_type: "video",
      account_plan: this.flowPlanLabel,
      model_label: String(job.model_id ?? this.flowVideoModelLabel),
      aspect_ratio: "16:9",
      output_count: 1,
      requested_duration_sec: requestedDurationSec,
      duration_sec: null,
      input_binding: "first_frame",
    };
    try {
      let bodyText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
      let mediaControl = await visibleLocator(page.getByRole("button", { name: FLOW_COMPOSER_MEDIA_CONTROL_PATTERN }));
      if (!mediaControl) {
        const agentToggle = await visibleLocator(page.getByRole("button", { name: "Agent", exact: true }));
        if (agentToggle) await agentToggle.click();
        mediaControl = await waitForVisible(page.getByRole("button", { name: FLOW_COMPOSER_MEDIA_CONTROL_PATTERN }), { timeoutMs: 10_000 });
      }
      if (!mediaControl) throw codedError("ui_contract_mismatch", "Google Flow video settings control is missing.");
      await mediaControl.click();
      const menu = await waitForVisible(page.getByRole("menu"), { timeoutMs: 10_000 });
      if (!menu) throw codedError("ui_contract_mismatch", "Google Flow video settings menu did not open.");
      const videoTab = await visibleLocator(menu.getByRole("tab", { name: /Video/i }));
      if (!videoTab) throw codedError("ui_contract_mismatch", "Google Flow Video mode is unavailable for this account.");
      await videoTab.click();
      const framesTab = await waitForVisible(menu.getByRole("tab", { name: /Frames/i }), { timeoutMs: 10_000 });
      if (!framesTab) throw codedError("ui_contract_mismatch", "Google Flow first-frame video mode is unavailable for this account.");
      await framesTab.click();
      const landscape = await visibleLocator(menu.getByRole("tab", { name: /16:9/ }));
      const oneOutput = await visibleLocator(menu.getByRole("tab", { name: "x1", exact: true }));
      if (landscape) await landscape.click();
      if (oneOutput) await oneOutput.click();
      const currentModel = await visibleLocator(menu.getByRole("button", { name: /Veo|Omni/i }));
      if (!currentModel) throw codedError("ui_contract_mismatch", "Google Flow video model control is unavailable.");
      if (!flowModelLabelMatches(await currentModel.innerText(), contract.model_label)) {
        await currentModel.click();
        const modelItems = page.getByRole("menuitem");
        let wanted = null;
        const modelDeadline = Date.now() + 10_000;
        while (!wanted && Date.now() < modelDeadline) {
          for (let index = 0; index < await modelItems.count(); index += 1) {
            const candidate = modelItems.nth(index);
            if (await candidate.isVisible().catch(() => false)
              && flowModelLabelMatches(await candidate.innerText(), contract.model_label)) {
              wanted = candidate;
              break;
            }
          }
          if (!wanted) await sleep(200);
        }
        if (!wanted) throw codedError("ui_contract_mismatch", `Expected Google Flow video model ${contract.model_label}.`);
        await wanted.click();
      }
      const durationTabs = menu.getByRole("tab", { name: /^\d+s$/i });
      const durationOptions = [];
      for (let index = 0; index < await durationTabs.count(); index += 1) {
        const candidate = durationTabs.nth(index);
        if (!await candidate.isVisible().catch(() => false)) continue;
        const value = Number.parseInt(await candidate.innerText(), 10);
        if (Number.isFinite(value)) durationOptions.push(value);
      }
      const durationSec = nearestFlowVideoDuration(requestedDurationSec, durationOptions);
      const durationControl = await visibleLocator(menu.getByRole("tab", { name: `${durationSec}s`, exact: true }));
      if (!durationControl) throw codedError("ui_contract_mismatch", `Google Flow video duration ${durationSec}s is unavailable.`);
      await durationControl.click();
      contract.duration_sec = durationSec;
      contract.ui_model_label = String(await (await visibleLocator(menu.getByRole("button", { name: /Veo|Omni/i })))?.innerText() ?? contract.model_label).trim();
      await page.keyboard.press("Escape").catch(() => {});
      const configuredVideoControl = await waitForVisible(page.getByRole("button", { name: FLOW_VIDEO_CONTROL_LABEL_PATTERN }), { timeoutMs: 5_000 });
      const configuredStartSlot = await waitForVisible(page.getByText("Start", { exact: true }), { timeoutMs: 5_000 });
      if (!configuredVideoControl || !configuredStartSlot) {
        if (configurationAttempt < 3) {
          await sleep(500);
          return this.verifyVideoUiContract(page, job, configurationAttempt + 1);
        }
        throw codedError("ui_contract_mismatch", "Google Flow did not retain Video Frames mode after configuration.");
      }
      bodyText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
      const accountPlanEvidence = flowPlanVerificationEvidence(bodyText, this.flowPlanLabel, contract.model_label);
      if (!accountPlanEvidence) {
        throw codedError("account_mismatch", `Google Flow exposed neither plan ${this.flowPlanLabel} nor entitled model ${contract.model_label}.`);
      }
      return { ...contract, account_plan_evidence: accountPlanEvidence, verified_at: new Date().toISOString() };
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      const diagnosticPath = await this.diagnostics(page, contract, error).catch(() => null);
      error.message = redactBrowserDiagnostic(error.message);
      if (diagnosticPath) error.message = `${error.message} Diagnostics: ${diagnosticPath}`;
      throw error;
    }
  }

  async generatedVideoUrls(page) {
    return page.locator("video, a").evaluateAll((elements, mediaFragment) => {
      const rows = [];
      for (const element of elements) {
        if (element instanceof HTMLVideoElement) {
          const value = element.currentSrc || element.src;
          if (element.offsetParent !== null && value) rows.push(value);
        } else if (element instanceof HTMLAnchorElement && element.offsetParent !== null && element.href.includes(mediaFragment)) {
          rows.push(element.href);
        }
      }
      return [...new Set(rows)];
    }, FLOW_MEDIA_PATH_FRAGMENT);
  }

  async generatedVideoDetailUrls(page) {
    const candidates = await page.locator('a[href*="/fx/tools/flow/project/"][href*="/edit/"]').evaluateAll((elements) => elements
      .filter((element) => element instanceof HTMLAnchorElement
        && element.offsetParent !== null
        && [...element.querySelectorAll("img")].some((image) => /video thumbnail/i.test(image.alt ?? "")))
      .map((element) => element.href));
    return [...new Set(candidates)].filter(isFlowVideoDetailUrl);
  }

  async mediaBytes(page, sourceUrl) {
    const fetchThroughPage = async (url) => {
      const base64 = await page.evaluate(async (url) => {
        const response = await fetch(url, { credentials: "include" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        return btoa(binary);
      }, url);
      return Buffer.from(base64, "base64");
    };
    if (sourceUrl.startsWith("blob:")) {
      return fetchThroughPage(sourceUrl);
    }
    let directError = null;
    try {
      const response = await page.request.get(sourceUrl, { timeout: 180_000 });
      if (response.ok()) return Buffer.from(await response.body());
      directError = new Error(`HTTP ${response.status()}`);
    } catch (error) {
      directError = error instanceof Error ? error : new Error(String(error));
    }
    try {
      return await fetchThroughPage(sourceUrl);
    } catch (error) {
      throw new Error(`Google Flow direct video download failed (${redactBrowserDiagnostic(directError?.message ?? "unknown error")}), and page-session fetch failed: ${redactBrowserDiagnostic(error.message)}`);
    }
  }

  async waitForGeneratedVideo(page, baseline = {}) {
    const baselineMediaUrls = baseline instanceof Set ? baseline : baseline.mediaUrls ?? new Set();
    const baselineDetailUrls = baseline instanceof Set ? new Set() : baseline.detailUrls ?? new Set();
    const deadline = Date.now() + 45 * 60_000;
    while (Date.now() < deadline) {
      await this.blockingAlert(page);
      const sourceUrl = (await this.generatedVideoUrls(page)).find((url) => !baselineMediaUrls.has(url));
      if (sourceUrl) {
        try {
          const bytes = await this.mediaBytes(page, sourceUrl);
          if (bytes.length > 100_000) return { sourceUrl, bytes };
        } catch (error) {
          this.log(`Google Flow video candidate is not downloadable yet: ${redactBrowserDiagnostic(error.message)}`, "warn");
        }
      }
      const detailUrl = (await this.generatedVideoDetailUrls(page)).find((url) => !baselineDetailUrls.has(url));
      if (detailUrl) {
        await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
        await waitForVisible(page.locator("video"), { timeoutMs: 90_000 });
        continue;
      }
      await sleep(1_000);
    }
    throw codedError("ui_contract_mismatch", "Timed out waiting for a generated Google Flow video.");
  }

  async runVideoJob({ slot = 0, job, client, onPhase = async () => {} }) {
    if (!Array.isArray(job.references) || job.references.length !== 1) {
      throw codedError("ui_contract_mismatch", "Google Flow image-to-video requires exactly one accepted first-frame image.");
    }
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let page = null;
      let preservePage = false;
      let creativeSubmissionStarted = false;
      try {
        const persistentWorker = job.worker_session_policy === PERSISTENT_FLOW_WORKER_POLICY;
        page = persistentWorker ? await this.persistentJobPage(slot) : await this.newJobPage();
        const verified = await this.verifyVideoUiContract(page, job);
        const prompt = [
          "Animate the attached accepted image as the exact first frame of one continuous 16:9 shot.",
          "Preserve identity, wardrobe, anatomy, objects, environment, lighting, and spatial continuity. Do not add cuts, panels, text, duplicate subjects, or unrelated objects.",
          job.prompt,
        ].join("\n\n");
        await this.pastePrompt(page, prompt);
        const { boundReferences } = await this.attachReferences(page, job, client, onPhase);
        const baseline = {
          mediaUrls: new Set(await this.generatedVideoUrls(page)),
          detailUrls: new Set(await this.generatedVideoDetailUrls(page)),
        };
        const { create, referenceBinding } = await this.recordReferenceBindingEvidence(page, job, prompt, boundReferences);
        await onPhase("submitting");
        creativeSubmissionStarted = true;
        await create.click();
        await onPhase("submitted");
        const generated = await this.waitForGeneratedVideo(page, baseline);
        const directory = path.join(this.downloadsRoot, safeName(job.manifest_id));
        await fs.mkdir(directory, { recursive: true });
        const downloadPath = path.join(directory, `${safeName(job.asset_id)}-${safeName(job.lease_token).slice(0, 12)}.mp4`);
        await fs.writeFile(downloadPath, generated.bytes);
        return {
          downloadPath,
          sourceUrl: generated.sourceUrl,
          conversationUrl: page.url(),
          uiContract: {
            ...verified,
            reference_binding: referenceBinding,
            generated_result: generated.generatedResult ?? null,
            worker_session_policy: job.worker_session_policy ?? "fresh_project_per_job",
            worker_slot: slot,
          },
          browserProvider: "google-flow",
        };
      } catch (error) {
        preservePage = ["rate_limited", "usage_limited", "account_mismatch"].includes(error.code);
        if (!creativeSubmissionStarted && error.code === "ui_contract_mismatch" && page) {
          const diagnosticPath = await this.diagnostics(page, {
            provider: "google-flow",
            media_type: "video",
            stage: "pre_submission_transport",
          }, error).catch(() => null);
          if (diagnosticPath) this.log(`Google Flow video pre-submission diagnostics: ${diagnosticPath}`, "warn");
        }
        if (shouldRetryFlowPreSubmissionTransport({
          errorCode: error.code,
          errorName: error.name,
          errorMessage: error.message,
          creativeSubmissionStarted,
          attempt,
        })) {
          this.log(`Google Flow video transport failed before submission; retrying once in the dedicated worker project: ${redactBrowserDiagnostic(error.message)}`, "warn");
          await sleep(1_000);
          continue;
        }
        error.message = redactBrowserDiagnostic(error.message);
        throw error;
      } finally {
        if (page && job.worker_session_policy !== PERSISTENT_FLOW_WORKER_POLICY && !preservePage) await page.close().catch(() => {});
      }
    }
    throw codedError("ui_contract_mismatch", "Google Flow video transport exhausted its pre-submission attempts.");
  }

  async runJob({ slot = 0, job, client, onPhase = async () => {} }) {
    if (job.type === "video") return this.runVideoJob({ slot, job, client, onPhase });
    if (job.type !== "image") throw codedError("ui_contract_mismatch", "Google Flow browser received unsupported work.");
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let page = null;
      let preservePage = false;
      let creativeSubmissionStarted = false;
      try {
        const persistentWorker = job.worker_session_policy === PERSISTENT_FLOW_WORKER_POLICY;
        page = persistentWorker ? await this.persistentJobPage(slot) : await this.newJobPage();
        page = await this.ensureCleanImageComposer(page, { slot, persistentWorker });
        const verified = await this.verifyUiContract(page);
        const prompt = [
          "Create exactly one original landscape still image in a 16:9 frame.",
          job.references?.length
            ? "Use the attached images only as ordered visual references. Do not create a collage, contact sheet, explanation, border, or multiple variants."
            : "No reference images are attached. Generate directly from the text prompt without asking for uploads or clarification.",
          job.prompt,
        ].join("\n\n");
        await this.pastePrompt(page, prompt);
        const { referenceInputs, boundReferences } = await this.attachReferences(page, job, client, onPhase);
        const baseline = new Set(await this.waitForVisibleImagesToSettle(page));
        const baselineFingerprints = await this.baselineImageFingerprints(page, baseline);
        const { create, referenceBinding } = await this.recordReferenceBindingEvidence(page, job, prompt, boundReferences);
        await onPhase("submitting");
        creativeSubmissionStarted = true;
        await create.click();
        await onPhase("submitted");
        const generated = await this.waitForGeneratedImage(page, baseline, referenceInputs, baselineFingerprints);
        await onPhase("result_ready");
        const downloadPath = await this.saveGeneratedImage(page, job, generated.sourceUrl, generated.bytes);
        return {
          downloadPath,
          sourceUrl: generated.sourceUrl,
          conversationUrl: page.url(),
          uiContract: {
            ...verified,
            reference_binding: referenceBinding,
            worker_session_policy: job.worker_session_policy ?? "fresh_project_per_job",
            worker_slot: slot,
          },
          browserProvider: "google-flow",
        };
      } catch (error) {
        preservePage = ["rate_limited", "usage_limited", "account_mismatch"].includes(error.code);
        if (shouldRetryFlowPreSubmissionTransport({
          errorCode: error.code,
          errorName: error.name,
          errorMessage: error.message,
          creativeSubmissionStarted,
          attempt,
        })) {
          if (job.worker_session_policy === PERSISTENT_FLOW_WORKER_POLICY) {
            const workerSlot = this.assertWorkerSlot(slot);
            await this.replacePersistentWorkerPage(
              workerSlot,
              this.workerPages.get(workerSlot),
              "the pre-submission transport left the slot-bound editor in an uncertain UI state",
            );
          }
          this.log(`Google Flow image transport failed before submission; retrying once in the dedicated worker project: ${redactBrowserDiagnostic(error.message)}`, "warn");
          await sleep(1_000);
          continue;
        }
        error.message = redactBrowserDiagnostic(error.message);
        throw error;
      } finally {
        if (page && job.worker_session_policy !== PERSISTENT_FLOW_WORKER_POLICY && !preservePage) await page.close().catch(() => {});
      }
    }
    throw codedError("ui_contract_mismatch", "Google Flow image transport exhausted its pre-submission attempts.");
  }
}

export { GOOGLE_FLOW_URL, PROMPT_SELECTOR, SIGNED_OUT_SELECTOR };
