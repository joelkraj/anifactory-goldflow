import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { chromium } from "playwright-core";

import { findReferenceEcho, normalizedImagePixels } from "../lib/image-pixel-contract.mjs";
import { clearLoginMarker, markLoginVerified } from "./browser-login.mjs";

const GEMINI_IMAGES_URL = "https://gemini.google.com/images";
const PERSISTENT_GEMINI_WORKER_POLICY = "persistent_tab_per_worker_slot_v1";
const GEMINI_APP_URL = "https://gemini.google.com/app";
const PROMPT_SELECTOR = '[contenteditable="true"][aria-label="Enter a prompt for Gemini"]';
const SIGNED_OUT_SELECTOR = 'a:has-text("Sign in"), button:has-text("Sign in")';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GEMINI_UPLOAD_PENDING_SELECTOR = 'gem-attachment[aria-busy="true"], gem-attachment [aria-busy="true"], gem-attachment [class*="uploading" i], gem-attachment [role="progressbar"], .gem-attachment-content.loading, .gem-attachment-loading-container [role="progressbar"]';
export const GEMINI_INLINE_PROMPT_MAX_CHARS = 24_000;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeName(value) {
  return String(value ?? "asset").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "asset";
}

function diagnosticText(value) {
  return String(value ?? "")
    .replace(/\b(?:https?:\/\/|blob:|data:)[^\s<>"']+/gi, "[REDACTED URL]")
    .replace(/\bBearer\s+[^\s,;)"']+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:cookie|set-cookie|authorization|proxy-authorization)\s*:[^\r\n]*/gi, "[REDACTED HEADER]")
    .replace(/\b[\w-]*(?:token|secret|password|session|auth|cookie|api[_-]?key)[\w-]*["']?\s*[=:]\s*["']?[^\s,;)"']+/gi, "[REDACTED CREDENTIAL]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED EMAIL]")
    .slice(0, 2_000);
}

export function observedGeminiImageFilename(body, expectedFilename) {
  const lines = new Set(String(body ?? "").split(/\r?\n/).map((line) => line.trim()));
  if (lines.has(expectedFilename)) return expectedFilename;
  if (!/\.(?:png|jpe?g|webp)$/i.test(expectedFilename)) return null;
  const stem = expectedFilename.replace(/\.(?:png|jpe?g|webp)$/i, "");
  // Gemini's image composer transcodes uploads while retaining the exact stem.
  return [`${stem}.jpg`, `${stem}.jpeg`].find((name) => lines.has(name)) ?? null;
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  return sha256Bytes(await fs.readFile(filePath));
}

async function sleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function visibleLocator(locator) {
  for (let index = 0; index < await locator.count(); index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}

async function waitForVisible(locator, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidate = await visibleLocator(locator);
    if (candidate) return candidate;
    await sleep(200);
  }
  return null;
}

async function waitForVisibleEnabled(locator, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let index = 0; index < await locator.count(); index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)
        && await candidate.isEnabled().catch(() => false)) return candidate;
    }
    await sleep(200);
  }
  return null;
}

async function waitForGeminiUploadTools(page, timeoutMs = 30_000) {
  const exact = await waitForVisible(
    page.getByRole("button", { name: "Upload & tools", exact: true }),
    timeoutMs,
  );
  if (exact) return exact;
  return waitForVisible(
    page.getByRole("button", { name: /Upload\s*&\s*tools/i }),
    2_000,
  );
}

function exactSha256(value, label) {
  const normalized = String(value ?? "").trim();
  if (!SHA256_PATTERN.test(normalized)) throw codedError("ui_contract_mismatch", `${label} must be an exact lowercase SHA-256.`);
  return normalized;
}

const GEMINI_EDITOR_FORMATTING_MARKS = /[\u200B\u2060\uFEFF]/g;

export function normalizeGeminiPromptText(value) {
  return String(value ?? "")
    .normalize("NFC")
    .replace(GEMINI_EDITOR_FORMATTING_MARKS, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t\f\v]+\n/g, "\n")
    .replace(/\n[ \t\f\v]+/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export async function verifyGeminiComposerPrompt(composer, expectedPrompt) {
  const expected = String(expectedPrompt ?? "");
  const observed = String(await composer.innerText());
  const normalizedExpected = normalizeGeminiPromptText(expected);
  const normalizedObserved = normalizeGeminiPromptText(observed);
  if (!normalizedExpected || normalizedObserved !== normalizedExpected) {
    throw codedError(
      "ui_contract_mismatch",
      `Gemini text prompt changed before submission (expected ${expected.length} chars/${sha256Bytes(Buffer.from(expected, "utf8"))}, observed ${observed.length} chars/${sha256Bytes(Buffer.from(observed, "utf8"))}).`,
    );
  }
  return {
    expected_sha256: sha256Bytes(Buffer.from(expected, "utf8")),
    observed_sha256: sha256Bytes(Buffer.from(observed, "utf8")),
    canonical_sha256: sha256Bytes(Buffer.from(normalizedExpected, "utf8")),
  };
}

export function createGeminiLlmPromptDelivery(prompt) {
  const source = String(prompt ?? "");
  const sourceBytes = Buffer.from(source, "utf8");
  const sourceSha256 = sha256Bytes(sourceBytes);
  const byteCount = sourceBytes.length;
  if (source.length <= GEMINI_INLINE_PROMPT_MAX_CHARS) {
    return {
      mode: "inline",
      source,
      source_sha256: sourceSha256,
      source_utf8_bytes: byteCount,
      composer_text: source,
      attachment: null,
    };
  }
  const filename = `goldflow-prompt-${sourceSha256}-${byteCount}b.txt`;
  const composerText = [
    `Read the complete attached UTF-8 text file "${filename}" from beginning to end.`,
    "Treat the entire file contents as the user prompt and follow every instruction in it exactly.",
    `The attached file contains exactly ${byteCount} bytes and has SHA-256 ${sourceSha256}.`,
    "Do not summarize, omit, shorten, or reinterpret the attached prompt before executing it.",
  ].join(" ");
  return {
    mode: "utf8_text_attachment",
    source,
    source_sha256: sourceSha256,
    source_utf8_bytes: byteCount,
    composer_text: composerText,
    attachment: {
      name: filename,
      mimeType: "text/plain;charset=utf-8",
      buffer: sourceBytes,
      source_sha256: sourceSha256,
      byte_count: byteCount,
    },
  };
}

export async function verifyGeminiTextAttachmentRetained(page, attachment, {
  timeoutMs = 90_000,
  pollMs = 250,
  stablePollsRequired = 2,
} = {}) {
  const sourceSha256 = exactSha256(attachment?.source_sha256, "Gemini text prompt attachment");
  const filename = String(attachment?.name ?? "");
  const byteCount = Number(attachment?.byte_count);
  if (!filename || !filename.includes(sourceSha256) || !filename.includes(`${byteCount}b`) || !filename.endsWith(".txt")) {
    throw codedError("ui_contract_mismatch", "Gemini text prompt attachment filename is not bound to its SHA-256 and byte count.");
  }
  const deadline = Date.now() + timeoutMs;
  let stablePolls = 0;
  while (Date.now() <= deadline) {
    const attachmentTiles = page.locator("gem-attachment");
    const visibleTiles = [];
    for (let index = 0; index < await attachmentTiles.count(); index += 1) {
      const tile = attachmentTiles.nth(index);
      if (await tile.isVisible().catch(() => false)) visibleTiles.push(tile);
    }
    if (visibleTiles.length > 1) {
      throw codedError("ui_contract_mismatch", `Gemini retained ${visibleTiles.length} text attachments; expected exactly one hash-bound prompt file.`);
    }
    let filenameChip = await visibleLocator(page.getByText(filename, { exact: true }));
    if (!filenameChip && visibleTiles.length === 1) {
      await visibleTiles[0].click();
      filenameChip = await waitForVisible(page.getByText(filename, { exact: true }), 2_000);
    }
    const pendingUpload = await visibleLocator(page.locator(GEMINI_UPLOAD_PENDING_SELECTOR));
    const oneExactAttachment = visibleTiles.length === 1;
    const exactFilenameVisible = Boolean(filenameChip);
    if ((oneExactAttachment || exactFilenameVisible) && visibleTiles.length <= 1 && !pendingUpload) {
      stablePolls += 1;
      if (stablePolls >= stablePollsRequired) {
        return {
          status: "verified",
          upload_filename: filename,
          source_sha256: sourceSha256,
          utf8_byte_count: byteCount,
          visible_filename_retained: true,
          no_pending_uploads: true,
        };
      }
    } else {
      stablePolls = 0;
    }
    await sleep(pollMs);
  }
  throw codedError("ui_contract_mismatch", `Gemini did not visibly retain complete text prompt attachment ${filename} before submission.`);
}

export function geminiBlockingCode(text) {
  const value = String(text ?? "");
  if (/\b(?:daily limit|limit resets|generation limit)\b/i.test(value)) return "usage_limited";
  if (/\b(?:too many requests|rate limit|try again later)\b/i.test(value)) return "rate_limited";
  if (/can.t help with that|violat(?:e|es|ed|ion).*polic/i.test(value)) return "content_policy_rejected";
  if (/something went wrong|failed to generate|couldn.t generate|encountered an error doing what you asked/i.test(value)) return "google_gemini_generation_error";
  if (/\b(?:having a hard time fulfilling your request|seem to be encountering an error)\b/i.test(value)) return "google_gemini_generation_error";
  return null;
}

export function isGeminiImageSurfaceUrl(value) {
  return /^https:\/\/gemini\.google\.com\/images(?:[/?#]|$)/i.test(String(value ?? ""));
}

export function isGeminiConversationUrl(value) {
  return /^https:\/\/gemini\.google\.com\/app\/[a-z0-9_-]+(?:[/?#]|$)/i.test(String(value ?? ""));
}

export class GoogleGeminiBrowser {
  constructor({
    profileDir,
    downloadsRoot,
    chromeExecutable,
    headless = false,
    concurrency = 1,
    geminiPlanLabel = "Ultra",
    geminiModelLabel = "Nano Banana 2",
    log = () => {},
  } = {}) {
    this.profileDir = profileDir;
    this.downloadsRoot = downloadsRoot;
    this.chromeExecutable = chromeExecutable;
    this.headless = headless;
    this.concurrency = concurrency;
    this.geminiPlanLabel = geminiPlanLabel;
    this.geminiModelLabel = geminiModelLabel;
    this.log = log;
    this.context = null;
    this.loginPage = null;
    this.llmJobsStarted = 0;
    this.workerPages = new Map();
    this.workerPagePromises = new Map();
  }

  async start() {
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
      ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
      args: ["--start-maximized", "--disable-features=Translate"],
    });
    this.loginPage = this.context.pages()[0] ?? await this.context.newPage();
    // Keep the persistent authentication tab in ordinary Gemini chat. Image
    // jobs open their own /images tab and verify image mode independently.
    await this.loginPage.goto(GEMINI_APP_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
    return this;
  }

  async waitForAuthentication() {
    const signedOut = await visibleLocator(this.loginPage.locator(SIGNED_OUT_SELECTOR));
    const composer = await waitForVisible(this.loginPage.locator(PROMPT_SELECTOR), 30_000);
    if (composer && !signedOut) {
      await markLoginVerified(this.profileDir, { url: this.loginPage.url() }, "google-gemini");
      this.log("Google Gemini authentication verified.");
      return;
    }
    await clearLoginMarker(this.profileDir, "google-gemini");
    throw codedError("auth_required", "The dedicated Goldflow Google profile is not authenticated in Gemini.");
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
      policy: PERSISTENT_GEMINI_WORKER_POLICY,
      configured_slots: this.concurrency,
      ready_slots: [...this.workerPages.entries()]
        .filter(([, page]) => page && !page.isClosed())
        .map(([slot, page]) => ({ slot, surface_url: page.url() })),
    };
  }

  assertWorkerSlot(slot) {
    const value = Number(slot);
    if (!Number.isInteger(value) || value < 0 || value >= this.concurrency) {
      throw codedError("ui_contract_mismatch", `Google Gemini worker slot must be an integer from 0 through ${this.concurrency - 1}.`);
    }
    return value;
  }

  async createPersistentWorkerPage(slot) {
    if (!this.context) throw new Error("Goldflow Google Gemini browser is not running.");
    const page = slot === 0 && this.loginPage && !this.loginPage.isClosed()
      ? this.loginPage
      : await this.context.newPage();
    try {
      await page.goto(GEMINI_IMAGES_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
      if (!isGeminiImageSurfaceUrl(page.url())) {
        throw codedError("ui_contract_mismatch", `Gemini persistent image-worker tab routed to ${page.url()} instead of ${GEMINI_IMAGES_URL}.`);
      }
      if (await visibleLocator(page.locator(SIGNED_OUT_SELECTOR))) {
        throw codedError("auth_required", `Gemini Images is not authenticated at ${page.url()}.`);
      }
      if (!await waitForVisible(page.locator(PROMPT_SELECTOR), 30_000)) {
        throw codedError("ui_contract_mismatch", "Gemini persistent image-worker tab did not expose its prompt composer.");
      }
      return page;
    } catch (caught) {
      if (page !== this.loginPage) await page.close().catch(() => {});
      throw caught;
    }
  }

  async ensurePersistentWorkerPage(slotValue) {
    const slot = this.assertWorkerSlot(slotValue);
    const existing = this.workerPages.get(slot);
    if (existing && !existing.isClosed()) return existing;
    const pending = this.workerPagePromises.get(slot);
    if (pending) return pending;
    const promise = this.createPersistentWorkerPage(slot)
      .then((page) => {
        this.workerPages.set(slot, page);
        this.workerPagePromises.delete(slot);
        return page;
      })
      .catch((error) => {
        this.workerPagePromises.delete(slot);
        throw error;
      });
    this.workerPagePromises.set(slot, promise);
    return promise;
  }

  async prepareWorkerSlots() {
    await Promise.all(Array.from({ length: this.concurrency }, async (_, slot) => {
      if (slot > 0) await sleep(slot * 1_200);
      return this.ensurePersistentWorkerPage(slot);
    }));
    this.log(`Google Gemini persistent worker pool ready: ${this.concurrency} tabs.`);
    return this.workerPoolState();
  }

  async persistentJobPage(type, slotValue) {
    const slot = this.assertWorkerSlot(slotValue);
    const page = await this.ensurePersistentWorkerPage(slot);
    const expectedUrl = type === "llm" ? GEMINI_APP_URL : GEMINI_IMAGES_URL;
    const isCorrectSurface = () => (type === "llm"
      ? /^https:\/\/gemini\.google\.com\/app(?:[/?#]|$)/i.test(page.url())
      : isGeminiImageSurfaceUrl(page.url()));
    let composer = isCorrectSurface()
      ? await waitForVisible(page.locator(PROMPT_SELECTOR), 2_000)
      : null;
    if (!composer) {
      await page.goto(expectedUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
      composer = await waitForVisible(page.locator(PROMPT_SELECTOR), 30_000);
    }
    if (!composer) {
      throw codedError("ui_contract_mismatch", `Gemini persistent worker slot ${slot + 1} lost its ${type} composer.`);
    }
    if (!isCorrectSurface()) throw codedError("ui_contract_mismatch", `Gemini persistent ${type} worker routed to ${page.url()} instead of ${expectedUrl}.`);
    if (type === "image" && await visibleLocator(page.locator(SIGNED_OUT_SELECTOR))) {
      throw codedError("auth_required", `Gemini Images is not authenticated at ${page.url()}.`);
    }
    return page;
  }

  async visibleImageComposerAttachmentCount(page) {
    const attachments = page.locator("gem-attachment");
    let visibleCount = 0;
    for (let index = 0; index < await attachments.count(); index += 1) {
      if (await attachments.nth(index).isVisible().catch(() => false)) visibleCount += 1;
    }
    if (visibleCount) return visibleCount;
    const previews = page.locator('img[alt="attachment"]');
    for (let index = 0; index < await previews.count(); index += 1) {
      if (await previews.nth(index).isVisible().catch(() => false)) visibleCount += 1;
    }
    return visibleCount;
  }

  async ensureCleanImageComposer(page) {
    if (await this.visibleImageComposerAttachmentCount(page) === 0) return page;
    this.log("Resetting a Gemini Images composer that retained stale attachments before submission.", "warn");
    await page.goto(GEMINI_IMAGES_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
    if (!await waitForVisible(page.locator(PROMPT_SELECTOR), 30_000)) {
      throw codedError("ui_contract_mismatch", "Gemini Images composer did not return while clearing stale attachments.");
    }
    if (await this.visibleImageComposerAttachmentCount(page) !== 0) {
      throw codedError("ui_contract_mismatch", "Gemini Images composer retained stale attachments after one local reset.");
    }
    return page;
  }

  async imageUploadState(page, expectedCount) {
    const observedCount = await this.visibleImageComposerAttachmentCount(page);
    const pending = Boolean(await visibleLocator(page.locator(GEMINI_UPLOAD_PENDING_SELECTOR)));
    return { expected_count: expectedCount, observed_count: observedCount, no_pending_uploads: !pending,
      ready: observedCount === expectedCount && !pending };
  }

  async waitForImageUploads(page, expectedCount, { timeoutMs = 90_000, stableMs = 750 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let readySince = null;
    while (Date.now() < deadline) {
      const state = await this.imageUploadState(page, expectedCount);
      if (state.ready) {
        readySince ??= Date.now();
        if (Date.now() - readySince >= stableMs) return state;
      } else readySince = null;
      await sleep(250);
    }
    throw codedError("ui_contract_mismatch", "Gemini reference uploads did not finish processing before submission.");
  }

  async newJobPage(type = "image") {
    const page = await this.context.newPage();
    const expectedUrl = type === "llm" ? GEMINI_APP_URL : GEMINI_IMAGES_URL;
    await page.goto(expectedUrl, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    if (type === "llm") this.llmJobsStarted += 1;
    if (!await waitForVisible(page.locator(PROMPT_SELECTOR), 30_000)) {
      throw codedError("ui_contract_mismatch", "Gemini did not expose its prompt composer.");
    }
    const routedCorrectly = type === "llm"
      ? /^https:\/\/gemini\.google\.com\/app(?:[/?#]|$)/i.test(page.url())
      : isGeminiImageSurfaceUrl(page.url());
    if (!routedCorrectly) {
      throw codedError("ui_contract_mismatch", `Gemini ${type} job routed to ${page.url()} instead of ${expectedUrl}.`);
    }
    if (type === "image") {
      await page.bringToFront();
      const signedOut = await visibleLocator(page.locator(SIGNED_OUT_SELECTOR));
      if (signedOut) {
        throw codedError("auth_required", `Gemini Images is not authenticated at ${page.url()}. Sign in on the preserved /images tab before image dispatch.`);
      }
    }
    this.log(`Gemini ${type} job surface verified: ${page.url()}`);
    return page;
  }

  async visibleModelResponses(page) {
    const selectors = [
      "message-content",
      "model-response message-content",
      ".model-response-text",
      '[data-test-id="model-response"]',
      '[data-message-author-role="model"]',
    ];
    for (const selector of selectors) {
      const rows = page.locator(selector);
      if (await rows.count()) return rows;
    }
    return page.locator("message-content");
  }

  async runLlmJob({ slot = 0, job, onPhase = async () => {} }) {
    const persistentWorker = job.worker_session_policy === PERSISTENT_GEMINI_WORKER_POLICY;
    const page = persistentWorker
      ? await this.persistentJobPage("llm", slot)
      : await this.newJobPage("llm");
    try {
      await onPhase("verifying_ui_contract");
      const textModel = await this.selectTextModel(page);
      const composer = await this.composer(page);
      const baselineCount = await (await this.visibleModelResponses(page)).count();
      const priorResponseIds = new Set(await this.responseMessageIds(page));
      await onPhase("entering_prompt");
      const prompt = String(job.prompt ?? "");
      const promptPreparation = await this.prepareLlmPromptSubmission(page, composer, prompt, onPhase);
      const send = await waitForVisible(page.getByRole("button", { name: /Send message/i }), 30_000);
      if (!send) throw codedError("ui_contract_mismatch", "Gemini Send message control is missing for text planning.");
      const sendDeadline = Date.now() + 90_000;
      while (Date.now() < sendDeadline && await send.isDisabled().catch(() => true)) await sleep(250);
      if (await send.isDisabled().catch(() => true)) throw codedError("ui_contract_mismatch", "Gemini Send message remained disabled after text prompt preparation.");
      await onPhase("submitting");
      await send.click();
      await onPhase("waiting_for_completion");
      const deadline = Date.now() + 60 * 60_000;
      let previous = "";
      let stableSince = 0;
      while (Date.now() < deadline) {
        const body = await this.providerStatusText(page, priorResponseIds);
        const blockingCode = geminiBlockingCode(body);
        if (blockingCode) throw codedError(blockingCode, body.slice(-1600));
        const responses = await this.visibleModelResponses(page);
        if (await responses.count() > baselineCount) {
          const content = String(await responses.last().innerText().catch(() => "")).trim();
          if (content && content === previous) {
            if (!stableSince) stableSince = Date.now();
            const stopControl = await visibleLocator(page.getByRole("button", {
              name: /(?:Stop|Cancel)(?: response| generating| generation)?/i,
            }));
            if (!stopControl && Date.now() - stableSince >= 5_000) {
              return {
                content,
                conversationUrl: page.url(),
                uiContract: {
                  provider: "google-gemini",
                  account_plan: this.geminiPlanLabel,
                  model_label: textModel.model_label,
                  extended_thinking: textModel.extended_thinking,
                  task_type: "llm",
                  prompt_sha256: promptPreparation.delivery.source_sha256,
                  prompt_utf8_bytes: promptPreparation.delivery.source_utf8_bytes,
                  prompt_delivery: promptPreparation.delivery.mode,
                  composer_instruction_sha256: promptPreparation.verification.expected_sha256,
                  composer_observed_sha256: promptPreparation.verification.observed_sha256,
                  composer_canonical_sha256: promptPreparation.verification.canonical_sha256,
                  prompt_attachment: promptPreparation.attachment_receipt,
                  creative_submission_count: 1,
                  verified_at: new Date().toISOString(),
                },
              };
            }
          } else {
            previous = content;
            stableSince = content ? Date.now() : 0;
          }
        }
        await sleep(500);
      }
      throw codedError("ui_contract_mismatch", "Timed out waiting for a complete Gemini text response.");
    } finally {
      if (!persistentWorker && page !== this.loginPage) await page.close().catch(() => {});
    }
  }

  async verifyUiContract(page) {
    // Gemini's dedicated /images surface is itself the stable image-mode
    // contract. The optional Images chip has changed its accessible label more
    // than once and may be absent entirely on fresh /images job tabs.
    const imageSurface = isGeminiImageSurfaceUrl(page.url());
    let imageMode = await visibleLocator(page.getByRole("button", { name: /Deselect Images/i }));
    if (!imageSurface && !imageMode) {
      const imageToggle = await visibleLocator(page.getByRole("button", { name: "Images", exact: true }));
      if (imageToggle) await imageToggle.click();
      imageMode = await waitForVisible(page.getByRole("button", { name: /Deselect Images/i }), 15_000);
    }
    if (!imageSurface && !imageMode) throw codedError("ui_contract_mismatch", "Gemini Images mode could not be selected.");
    return {
      provider: "google-gemini",
      account_plan: this.geminiPlanLabel,
      model_label: this.geminiModelLabel,
      aspect_ratio: "16:9",
      output_count: 1,
      verified_at: new Date().toISOString(),
    };
  }

  async composer(page) {
    const composer = await visibleLocator(page.locator(PROMPT_SELECTOR));
    if (!composer) throw codedError("ui_contract_mismatch", "Gemini prompt composer is not visible.");
    return composer;
  }

  async selectTextModel(page, { freshChatRetry = true } = {}) {
    const imageMode = await visibleLocator(page.getByRole("button", { name: /Deselect Images/i }));
    if (imageMode) {
      await imageMode.click();
      await imageMode.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {});
    }
    let plainFlash = await waitForVisible(page.getByRole("button", { name: /Open mode picker, currently (?:Flash|Fast)$/i }), 5_000);
    if (plainFlash) {
      return { model_label: "Gemini 3.7 Flash", extended_thinking: false, verified_picker_label: "Open mode picker, currently Flash or Fast" };
    }
    let picker = await waitForVisible(page.getByRole("button", { name: /Open mode picker/i }), 30_000);
    if (!picker) throw codedError("ui_contract_mismatch", "Gemini text model picker is missing.");
    const extendedPicker = await visibleLocator(page.getByRole("button", { name: /Open mode picker, currently Flash Extended$/i }));
    if (!extendedPicker) {
      await picker.click();
      const flash = await waitForVisible(page.getByText("3.7 Flash", { exact: true }), 15_000);
      if (!flash) {
        const visibleModeOptions = await page.locator("gem-menu-item").allInnerTexts().catch(() => []);
        throw codedError(
          "ui_contract_mismatch",
          `Gemini 3.7 Flash is not available in the authenticated account. Visible mode options: ${visibleModeOptions.map((value) => value.trim()).filter(Boolean).join(" | ") || "none"}.`,
        );
      }
      const flashRow = flash.locator("xpath=ancestor::gem-menu-item[1]");
      const flashDeadline = Date.now() + 60_000;
      while (Date.now() < flashDeadline && await flashRow.getAttribute("aria-disabled").catch(() => "true") === "true") await sleep(250);
      if (await flashRow.getAttribute("aria-disabled").catch(() => "true") === "true") {
        if (freshChatRetry) {
          await page.keyboard.press("Escape").catch(() => {});
          await page.goto(GEMINI_APP_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
          if (!await waitForVisible(page.locator(PROMPT_SELECTOR), 30_000)) {
            throw codedError("ui_contract_mismatch", "Gemini fresh text chat did not expose its prompt composer.");
          }
          return this.selectTextModel(page, { freshChatRetry: false });
        }
        throw codedError("ui_contract_mismatch", "Gemini 3.7 Flash is visible but disabled in the authenticated chat.");
      }
      await flashRow.click();
      picker = await waitForVisible(page.getByRole("button", { name: /Open mode picker/i }), 15_000);
    }
    if (await visibleLocator(page.getByRole("button", { name: /Open mode picker, currently Flash Extended$/i }))) {
      await picker.click();
      const extended = await waitForVisible(page.getByText("Extended thinking", { exact: true }), 15_000);
      if (!extended) throw codedError("ui_contract_mismatch", "Gemini Extended thinking toggle is missing.");
      await extended.locator("xpath=ancestor::gem-menu-item[1]").click();
    }
    plainFlash = await waitForVisible(page.getByRole("button", { name: /Open mode picker, currently (?:Flash|Fast)$/i }), 15_000);
    if (!plainFlash) throw codedError("ui_contract_mismatch", "Gemini 3.7 Flash selection was not retained.");
    return { model_label: "Gemini 3.7 Flash", extended_thinking: false, verified_picker_label: "Open mode picker, currently Flash or Fast" };
  }

  async openGeminiFileChooser(page) {
    const uploadTools = await waitForGeminiUploadTools(page);
    if (!uploadTools) throw codedError("ui_contract_mismatch", "Gemini Upload & tools control is missing for long text planning.");
    await uploadTools.click();
    let uploadButton = await waitForVisible(page.getByText("Upload files", { exact: true }), 15_000);
    if (!uploadButton) throw codedError("ui_contract_mismatch", "Gemini Upload files action did not become visible for long text planning.");
    let chooserPromise = page.waitForEvent("filechooser", { timeout: 2_000 }).catch(() => null);
    await uploadButton.click({ force: true });
    let chooser = await chooserPromise;
    if (chooser) return chooser;
    const agree = await waitForVisible(page.getByRole("button", { name: /^Agree\b/i }), 10_000);
    if (!agree) throw codedError("ui_contract_mismatch", "Gemini text attachment upload did not open a file chooser or the one-time rights notice.");
    await agree.click();
    await agree.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
    await uploadTools.click();
    uploadButton = await waitForVisible(page.getByText("Upload files", { exact: true }), 10_000);
    if (!uploadButton) throw codedError("ui_contract_mismatch", "Gemini Upload files action did not return after accepting the rights notice.");
    chooserPromise = page.waitForEvent("filechooser", { timeout: 10_000 });
    await uploadButton.click({ force: true });
    return chooserPromise;
  }

  async attachLlmPromptFile(page, attachment) {
    if (!Buffer.isBuffer(attachment?.buffer)
      || attachment.buffer.length !== Number(attachment.byte_count)
      || sha256Bytes(attachment.buffer) !== exactSha256(attachment.source_sha256, "Gemini text prompt attachment")) {
      throw codedError("ui_contract_mismatch", "Gemini text prompt attachment bytes changed before upload.");
    }
    const chooser = await this.openGeminiFileChooser(page);
    await chooser.setFiles([{ name: attachment.name, mimeType: attachment.mimeType, buffer: attachment.buffer }]);
    return verifyGeminiTextAttachmentRetained(page, attachment);
  }

  async prepareLlmPromptSubmission(page, composer, prompt, onPhase = async () => {}) {
    const delivery = createGeminiLlmPromptDelivery(prompt);
    let attachmentReceipt = null;
    if (delivery.attachment) {
      await onPhase("attaching_prompt_file");
      attachmentReceipt = await this.attachLlmPromptFile(page, delivery.attachment);
      await onPhase("prompt_file_attached");
    }
    await composer.fill(delivery.composer_text);
    const verification = await verifyGeminiComposerPrompt(composer, delivery.composer_text);
    if (delivery.attachment) {
      attachmentReceipt = await verifyGeminiTextAttachmentRetained(page, delivery.attachment);
    }
    return { delivery, verification, attachment_receipt: attachmentReceipt };
  }

  async attachReferences(page, job, client, onPhase) {
    const references = Array.isArray(job.references) ? job.references : [];
    if (references.length > 4) throw codedError("ui_contract_mismatch", "Gemini accepts at most four ordered references in Goldflow.");
    await onPhase("attaching_references");
    const files = [];
    const referenceInputs = [];
    const orderedReferences = [];
    for (let index = 0; index < references.length; index += 1) {
      const reference = references[index];
      const slot = index + 1;
      if (Number(reference.slot) !== slot) throw codedError("ui_contract_mismatch", `Gemini reference ${reference.ref_id} is not in contiguous slot ${slot}.`);
      const sourceSha256 = exactSha256(reference.sha256, `Gemini reference ${reference.ref_id}`);
      const downloaded = await client.fetchReference(reference.url);
      if (sha256Bytes(downloaded.bytes) !== sourceSha256) throw codedError("ui_contract_mismatch", `Gemini reference ${reference.ref_id} hash changed before upload.`);
      const extension = downloaded.mimeType.includes("png") ? "png" : downloaded.mimeType.includes("webp") ? "webp" : "jpg";
      const filename = `${String(slot).padStart(2, "0")}-${safeName(reference.ref_id)}-${sourceSha256.slice(0, 12)}.${extension}`;
      files.push({ name: filename, mimeType: downloaded.mimeType, buffer: downloaded.bytes });
      referenceInputs.push({ slot, ref_id: reference.ref_id, normalized_pixels: await normalizedImagePixels(downloaded.bytes) });
      orderedReferences.push({ slot, ref_id: reference.ref_id, source_sha256: sourceSha256, upload_filename: filename });
    }
    if (!files.length) return { referenceInputs, orderedReferences };
    const uploadTools = await waitForGeminiUploadTools(page);
    if (!uploadTools) throw codedError("ui_contract_mismatch", "Gemini Upload & tools control is missing.");
    const verifiedReferenceIds = new Set();
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const baselineImageUrls = new Set(await this.imageComposerPreviewUrls(page));
      // The /images surface retains stale hidden/disabled menu rows after a
      // previous attachment. Reopen the active tools menu and target its
      // enabled menu item instead of clicking the first matching text node.
      await page.keyboard.press("Escape").catch(() => {});
      await uploadTools.click();
      const uploadLabels = page.getByText("Upload files", { exact: true });
      let uploadButton = await waitForVisibleEnabled(
        uploadLabels.locator("xpath=ancestor::*[@role='menuitem' or self::gem-menu-item][1]"),
        15_000,
      );
      if (!uploadButton) uploadButton = await waitForVisibleEnabled(uploadLabels, 2_000);
      if (!uploadButton) throw codedError("ui_contract_mismatch", "Gemini /images Upload files action is missing or disabled in the active tools menu.");
      let chooserPromise = page.waitForEvent("filechooser", { timeout: 2_000 }).catch(() => null);
      await uploadButton.click();
      let chooser = await chooserPromise;
      if (!chooser) {
        const agree = await waitForVisible(page.getByRole("button", { name: /^Agree\b/i }), 10_000);
        if (!agree) throw codedError("ui_contract_mismatch", "Gemini upload did not open a file chooser or the one-time rights notice.");
        await agree.click();
        await agree.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
        await page.keyboard.press("Escape").catch(() => {});
        await uploadTools.click();
        uploadButton = await waitForVisibleEnabled(
          page.getByText("Upload files", { exact: true }).locator("xpath=ancestor::*[@role='menuitem' or self::gem-menu-item][1]"),
          10_000,
        );
        if (!uploadButton) throw codedError("ui_contract_mismatch", "Gemini /images Upload files action did not return enabled after accepting the rights notice.");
        chooserPromise = page.waitForEvent("filechooser", { timeout: 10_000 });
        await uploadButton.click();
        chooser = await chooserPromise;
      }
      await chooser.setFiles([file]);
      const deadline = Date.now() + 90_000;
      let observedFilename = null;
      while (Date.now() < deadline && !verifiedReferenceIds.has(orderedReferences[index].ref_id)) {
        const body = await page.locator("body").innerText();
        // Upload-name notifications can disappear before preview pixels load.
        observedFilename = observedGeminiImageFilename(body, file.name) ?? observedFilename;
        const countMatches = await this.visibleImageComposerAttachmentCount(page) === index + 1;
        if (observedFilename === file.name && countMatches) {
          verifiedReferenceIds.add(orderedReferences[index].ref_id);
          orderedReferences[index].observed_upload_filename = observedFilename;
          orderedReferences[index].verification_method = "exact_filename_and_attachment_count";
          break;
        }
        for (const sourceUrl of (await this.imageComposerPreviewUrls(page)).filter((url) => !baselineImageUrls.has(url))) {
          if (!countMatches) break;
          try {
            const bytes = await this.imageBytes(page, sourceUrl);
            const match = await findReferenceEcho(bytes, [referenceInputs[index]], {
              // Allow only bounded lossy-preview drift when the hash-bearing
              // filename stem also matches. Generated-output checks stay strict.
              threshold: observedFilename && observedFilename !== file.name ? 3 : 1,
            });
            if (match) {
              verifiedReferenceIds.add(orderedReferences[index].ref_id);
              orderedReferences[index].observed_upload_filename = observedFilename;
              orderedReferences[index].verification_method = "preview_pixels_and_attachment_count";
              orderedReferences[index].preview_mean_absolute_difference = match.mean_absolute_difference;
              break;
            }
          } catch {
            // The attachment preview can exist before its rendered pixels are readable.
          }
        }
        if (!verifiedReferenceIds.has(orderedReferences[index].ref_id)) await sleep(250);
      }
      if (!verifiedReferenceIds.has(orderedReferences[index].ref_id)) {
        throw codedError("ui_contract_mismatch", `Gemini did not visibly retain ordered reference ${file.name} before submission.`);
      }
    }
    if (!orderedReferences.every((row) => verifiedReferenceIds.has(row.ref_id))) {
      throw codedError("ui_contract_mismatch", "Gemini did not visibly retain every ordered reference filename before submission.");
    }
    await this.waitForImageUploads(page, files.length);
    await onPhase("references_attached");
    return { referenceInputs, orderedReferences };
  }

  async pastePrompt(page, prompt) {
    const composer = await this.composer(page);
    await composer.fill(prompt);
    const observed = String(await composer.innerText()).replace(/\s+/g, " ").trim();
    if (observed !== String(prompt).replace(/\s+/g, " ").trim()) {
      throw codedError("ui_contract_mismatch", "Gemini prompt text changed before submission.");
    }
  }

  async visibleImageUrls(page) {
    return page.locator("img").evaluateAll((images) => images
      .filter((image) => {
        return image.offsetParent !== null
          && image.complete
          && image.naturalWidth >= 256
          && image.naturalHeight >= 256;
      })
      .map((image) => image.currentSrc || image.src)
      .filter(Boolean));
  }

  async imageComposerPreviewUrls(page) {
    // Never download unrelated gallery images while validating an upload.
    return page.locator('gem-attachment img, img[alt="attachment"]').evaluateAll((images) => [...new Set(images
      .filter((image) => image.offsetParent !== null && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0)
      .map((image) => image.currentSrc || image.src)
      .filter(Boolean))]);
  }

  async responseMessageIds(page) {
    return page.locator('model-response message-content[id]').evaluateAll((nodes) => nodes.map((node) => node.id).filter(Boolean));
  }

  async providerStatusText(page, priorResponseIds = new Set()) {
    return page.locator("body").evaluate((root, previousIds) => {
      const prior = new Set(previousIds);
      const document = root.ownerDocument;
      const walker = document.createTreeWalker(root, 4);
      const lines = [];
      let node;
      while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (!parent || !node.textContent.trim()) continue;
        // User prompts and old turns are content, never current provider status.
        if (parent.closest('user-query, [data-message-author-role="user"], [contenteditable="true"], textarea, script, style, [hidden], [aria-hidden="true"]')) continue;
        const response = parent.closest("model-response");
        if (response && prior.has(response.querySelector("message-content[id]")?.id)) continue;
        if (!parent.getClientRects().length) continue;
        const style = document.defaultView.getComputedStyle(parent);
        if (style.visibility === "hidden" || style.visibility === "collapse") continue;
        lines.push(node.textContent.trim());
      }
      return lines.join("\n");
    }, [...priorResponseIds]);
  }

  async generatedResponseImageUrls(page, priorResponseIds = new Set()) {
    const response = page.locator("model-response").last();
    if (!await response.count()) return [];
    const responseId = await response.locator("message-content[id]").first().getAttribute("id").catch(() => null);
    if (!responseId || priorResponseIds.has(responseId)) return [];
    const generatedImages = response.getByRole("img", { name: /AI generated/i });
    const urls = [];
    for (let index = 0; index < await generatedImages.count(); index += 1) {
      const image = generatedImages.nth(index);
      if (!await image.isVisible().catch(() => false)) continue;
      const details = await image.evaluate((node) => ({
        complete: node.complete,
        width: node.naturalWidth,
        height: node.naturalHeight,
        sourceUrl: node.currentSrc || node.src,
      })).catch(() => null);
      if (details?.complete && details.width >= 256 && details.height >= 256 && details.sourceUrl) {
        urls.push(details.sourceUrl);
      }
    }
    return [...new Set(urls)];
  }

  async imageBytes(page, sourceUrl) {
    if (sourceUrl.startsWith("blob:")) {
      const dataUrl = await page.locator("img").evaluateAll((images, url) => {
        const image = images.find((candidate) => (candidate.currentSrc || candidate.src) === url);
        if (!image || !image.complete || !image.naturalWidth || !image.naturalHeight) return null;
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext("2d").drawImage(image, 0, 0);
        return canvas.toDataURL("image/png");
      }, sourceUrl);
      if (!dataUrl?.startsWith("data:image/png;base64,")) throw new Error("Gemini blob image is not fully rendered yet.");
      return Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64");
    }
    const response = await page.request.get(sourceUrl, { timeout: 120_000 });
    if (!response.ok()) throw new Error(`Gemini image download returned HTTP ${response.status()}.`);
    return Buffer.from(await response.body());
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
        const candidate = await this.imagePixelFingerprint(page, sourceUrl);
        fingerprints.set(sourceUrl, candidate.sha256);
      } catch (error) {
        this.log(`Gemini baseline image could not be fingerprinted: ${error.message}`, "warn");
      }
    }
    return fingerprints;
  }

  async waitForGeneratedImage(page, baseline, referenceInputs, baselineFingerprints = new Map(), priorResponseIds = new Set()) {
    const startedAt = Date.now();
    const deadline = Date.now() + 15 * 60_000;
    const baselinePixelSha256s = new Set(baselineFingerprints.values());
    while (Date.now() < deadline) {
      const body = await this.providerStatusText(page, priorResponseIds);
      const blockingCode = geminiBlockingCode(body);
      if (blockingCode) throw codedError(blockingCode, body.slice(-1600));
      if (Date.now() - startedAt > 60_000 && /^https:\/\/gemini\.google\.com\/app\/?(?:[?#].*)?$/.test(page.url())
        && await page.locator("user-query").count() === 0 && await page.locator("model-response").count() === 0) {
        throw codedError("provider_response_timeout", "Gemini returned to an empty home page after submission; no request or response was retained. Do not resubmit automatically.");
      }
      // Gemini labels response rasters as "AI generated". That DOM contract is
      // stronger evidence than pixel dissimilarity: identity-preserving edits
      // can intentionally resemble their attached character reference closely.
      for (const sourceUrl of await this.generatedResponseImageUrls(page, priorResponseIds)) {
        try {
          const candidate = await this.imagePixelFingerprint(page, sourceUrl);
          if (baselinePixelSha256s.has(candidate.sha256)) {
            baseline.add(sourceUrl);
            baselineFingerprints.set(sourceUrl, candidate.sha256);
            this.log("Ignored a stale Gemini result whose blob URL changed but pixels did not.", "warn");
            continue;
          }
          return {
            sourceUrl,
            bytes: candidate.bytes,
            generatedResult: {
              schema: "goldflow_browser_generated_result_v1",
              status: "verified",
              browser_provider: "google-gemini",
              source_url: sourceUrl,
            },
          };
        } catch (error) {
          this.log(`Gemini generated response is not downloadable yet: ${error.message}`, "warn");
        }
      }
      // Gallery cards and upload previews are never generated-output evidence,
      // even when a new URL or JPEG recompression changes their pixel hash.
      await sleep(750);
    }
    throw codedError("ui_contract_mismatch", "Timed out waiting for a generated Gemini image.");
  }

  async saveGeneratedImage(job, bytes) {
    const directory = path.join(this.downloadsRoot, safeName(job.manifest_id));
    await fs.mkdir(directory, { recursive: true });
    const outputPath = path.join(directory, `${safeName(job.asset_id)}-${safeName(job.lease_token).slice(0, 12)}.img`);
    await fs.writeFile(outputPath, bytes);
    return outputPath;
  }

  async recordEvidence(page, job, prompt, orderedReferences) {
    const directory = path.join(this.downloadsRoot, safeName(job.manifest_id), "reference-binding-evidence", `${safeName(job.asset_id)}-${safeName(job.lease_token).slice(0, 12)}`);
    await fs.mkdir(directory, { recursive: true });
    const screenshotPath = path.join(directory, "pre-submit-full.png");
    const receiptPath = path.join(directory, "reference-binding-receipt.json");
    await page.screenshot({ path: screenshotPath, fullPage: false });
    const receipt = {
      schema: "goldflow_google_gemini_reference_binding_receipt_v1",
      status: "verified",
      browser_provider: "google-gemini",
      manifest_id: job.manifest_id,
      asset_id: job.asset_id,
      conversation_url: page.url(),
      submitted_prompt_sha256: sha256Bytes(Buffer.from(prompt, "utf8")),
      reference_binding: {
        status: "verified",
        expected_count: orderedReferences.length,
        observed_count: orderedReferences.length,
        no_pending_uploads: true,
        prompt_text_verified: true,
        ordered_references: orderedReferences,
      },
      screenshot_path: screenshotPath,
      screenshot_sha256: await sha256File(screenshotPath),
      recorded_at: new Date().toISOString(),
    };
    await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    return { ...receipt.reference_binding, evidence: { receipt_path: receiptPath, receipt_sha256: await sha256File(receiptPath), screenshot_path: screenshotPath, screenshot_sha256: receipt.screenshot_sha256 } };
  }

  async imageFailureDiagnostics(page, job, error) {
    const directory = path.join(this.downloadsRoot, "_google-gemini-ui-diagnostics");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const screenshotPath = path.join(directory, `${stamp}.png`);
    const receiptPath = path.join(directory, `${stamp}.json`);
    const readVisible = async (selector) => {
      const snapshot = await page.locator(selector).evaluateAll((nodes) => {
        const isVisible = (node) => {
          if (node.closest('user-query, [data-message-author-role="user"], [contenteditable="true"], textarea, nav, aside, [role="navigation"], [hidden], [aria-hidden="true"]')) return false;
          const style = node.ownerDocument.defaultView.getComputedStyle(node);
          return node.getClientRects().length && style.visibility !== "hidden" && style.visibility !== "collapse";
        };
        const visible = nodes.filter(isVisible);
        return { matched_count: nodes.length, visible_count: visible.length,
          visible_items: visible.slice(0, 12).map((node) => {
            // A status/dialog container may contain a prompt or hidden descendant.
            const walker = node.ownerDocument.createTreeWalker(node, 4);
            let text = "", child;
            while (text.length < 2_000 && (child = walker.nextNode())) {
              if (child.parentElement && isVisible(child.parentElement)) text += `${child.textContent}\n`;
            }
            return { text: text.slice(0, 2_000), alt: String(node.getAttribute("alt") ?? "").slice(0, 2_000) };
          }) };
      }).catch(() => null);
      return snapshot && { ...snapshot, visible_items: snapshot.visible_items.map((item) => ({
        text: diagnosticText(item.text), alt: diagnosticText(item.alt),
      })) };
    };
    // Counts stay independent: mixed attachment UI is evidence, not a new admission rule.
    const attachments = await readVisible("gem-attachment");
    const previews = await readVisible('img[alt="attachment"]');
    const loading = [];
    for (const selector of GEMINI_UPLOAD_PENDING_SELECTOR.split(", ")) {
      loading.push({ selector, observed: await readVisible(selector) });
    }
    const errors = await readVisible('[role="alert"], [role="status"], [role="dialog"], [class*="error" i]');
    let screenshot = null;
    try {
      const bytes = await page.screenshot({ fullPage: false, timeout: 5_000, mask: [
        page.locator('user-query, [data-message-author-role="user"], [contenteditable="true"], input, textarea, nav, aside, [role="navigation"]'),
        page.getByText(/https?:\/\/|blob:|data:|Bearer\s+|(?:cookie|authorization|token|secret|password|session|api[_-]?key)\s*[=:]|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i),
      ] });
      await fs.writeFile(screenshotPath, bytes, { flag: "wx", mode: 0o600 });
      screenshot = { path: screenshotPath, sha256: sha256Bytes(bytes) };
    } catch { /* Text evidence remains useful when the page cannot be captured. */ }
    const receipt = {
      schema: "goldflow_google_gemini_image_failure_diagnostic_v1",
      captured_at: new Date().toISOString(), browser_provider: "google-gemini",
      manifest_id: job.manifest_id, asset_id: job.asset_id,
      expected_reference_count: Array.isArray(job.references) ? job.references.length : 0,
      failure: { code: diagnosticText(error?.code), message: diagnosticText(error?.message) },
      attachments, previews, loading, visible_error_containers: errors, screenshot,
      observation_scope: "Visible UI only; historical errors are not attributed to this submission.",
    };
    await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return receiptPath;
  }

  async runJob({ slot = 0, job, client, onPhase = async () => {}, submitGeneration = async (click) => click() }) {
    if (job.type === "llm") return this.runLlmJob({ slot, job, onPhase });
    if (job.type !== "image") throw codedError("ui_contract_mismatch", `Gemini browser received unsupported ${job.type} work.`);
    const persistentWorker = job.worker_session_policy === PERSISTENT_GEMINI_WORKER_POLICY;
    let page = persistentWorker
      ? await this.persistentJobPage("image", slot)
      : await this.newJobPage("image");
    let preservePage = false;
    try {
      page = await this.ensureCleanImageComposer(page);
      await onPhase("verifying_ui_contract");
      const uiContract = await this.verifyUiContract(page);
      const baseline = new Set(await this.generatedResponseImageUrls(page));
      const { referenceInputs, orderedReferences } = await this.attachReferences(page, job, client, onPhase);
      await onPhase("entering_prompt");
      const referenceMap = orderedReferences.length
        ? orderedReferences.map((row) => {
            const source = (Array.isArray(job.references) ? job.references : [])
              .find((reference) => Number(reference.slot) === row.slot);
            const purpose = String(source?.purpose ?? "visual identity and continuity").trim();
            return `Attachment ${row.slot} (${row.observed_upload_filename ?? row.upload_filename}) = ${row.ref_id}. Purpose: ${purpose}.`;
          }).join("\n")
        : "No reference images are attached.";
      const prompt = `Create exactly one original landscape still image in a 16:9 frame.\n\nUse the attached images only as ordered visual references. Do not create a collage, contact sheet, explanation, border, or multiple variants.\n\nREFERENCE MAP:\n${referenceMap}\nMatch each named subject or element in the scene prompt to its explicitly mapped attachment. Do not swap identities between attachments.\n\n${job.prompt}`;
      await this.pastePrompt(page, prompt);
      const sendButtons = page.getByRole("button", { name: /Send message/i });
      if (!await waitForVisible(sendButtons, 30_000)) {
        throw codedError("ui_contract_mismatch", "Gemini Send message control is missing.");
      }
      // Gemini replaces the composer controls as attachments finish processing.
      // Reacquire the enabled control instead of polling a stale disabled node.
      const send = await waitForVisibleEnabled(sendButtons, 90_000);
      if (!send) throw codedError("ui_contract_mismatch", "Gemini Send message remained disabled after reference processing.");
      // Bind output to a new model response, not a newly loaded gallery raster.
      await sleep(1_500);
      const priorResponseIds = new Set(await this.responseMessageIds(page));
      for (const sourceUrl of await this.generatedResponseImageUrls(page)) baseline.add(sourceUrl);
      const baselineFingerprints = await this.baselineImageFingerprints(page, baseline);
      const uploadState = await this.imageUploadState(page, orderedReferences.length);
      if (!uploadState.ready) throw codedError("ui_contract_mismatch", "Gemini attachments changed or are still uploading at the submission checkpoint.");
      const referenceBinding = await this.recordEvidence(page, job, prompt, orderedReferences);
      await onPhase("refs_ready");
      await submitGeneration(async () => {
        const ready = await this.imageUploadState(page, orderedReferences.length);
        if (!ready.ready) throw codedError("ui_contract_mismatch", "Gemini attachments changed while waiting for the submission gate.");
        await onPhase("submitting");
        const currentSend = await waitForVisibleEnabled(sendButtons, 30_000);
        if (!currentSend) throw codedError("ui_contract_mismatch", "Gemini Send message is no longer enabled after the submission wait.");
        await currentSend.click();
        await onPhase("submitted");
      });
      await onPhase("waiting_for_image");
      const generated = await this.waitForGeneratedImage(page, baseline, referenceInputs, baselineFingerprints, priorResponseIds);
      await onPhase("result_ready");
      const downloadPath = await this.saveGeneratedImage(job, generated.bytes);
      return {
        downloadPath,
        sourceUrl: generated.sourceUrl,
        conversationUrl: page.url(),
        uiContract: {
          ...uiContract,
          reference_binding: referenceBinding,
          generated_result: generated.generatedResult ?? null,
          worker_session_policy: job.worker_session_policy ?? "fresh_session_per_job_v1",
          worker_slot: slot,
        },
        browserProvider: "google-gemini",
      };
    } catch (error) {
      preservePage = ["auth_required", "ui_contract_mismatch"].includes(error?.code);
      try {
        const diagnosticPath = await this.imageFailureDiagnostics(page, job, error);
        this.log(`Gemini image failure diagnostics: ${diagnosticPath}`, "warn");
      } catch { /* Diagnostics must never replace or modify the original job failure. */ }
      throw error;
    } finally {
      if (!persistentWorker && !preservePage) await page.close().catch(() => {});
    }
  }
}
