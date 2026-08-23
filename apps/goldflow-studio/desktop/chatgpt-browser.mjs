import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { chromium } from "playwright-core";

import { clearLoginMarker, markLoginVerified } from "./browser-login.mjs";
import { chatGptEffortSliderIndex } from "../lib/chatgpt-ui-contract.mjs";

const CHATGPT_URL = "https://chatgpt.com/";
const COMPOSER_SELECTOR = [
  'textarea[aria-label="Chat with ChatGPT"]',
  'textarea[placeholder*="Ask ChatGPT"]',
  '[data-testid="prompt-textarea"]',
  "#prompt-textarea",
  '[contenteditable="true"][data-placeholder]',
  '[contenteditable="true"][data-lexical-editor="true"]',
].join(", ");
const ASSISTANT_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="assistant"]',
  '[data-testid^="conversation-turn-"][data-message-author-role="assistant"]',
  '[data-message-author-role="assistant"]',
].join(", ");
const SIGNED_OUT_SELECTOR = [
  'button[data-testid="login-button"]',
  'button[data-testid="signup-button"]',
  'a[href*="/auth/login"]',
].join(", ");
const HISTORY_RATE_LIMIT_SELECTOR = '#modal-conversation-history-rate-limit, [data-testid="modal-conversation-history-rate-limit"]';
const CHATGPT_UPLOAD_PENDING_SELECTOR = '[aria-busy="true"][data-testid*="upload" i], [aria-label*="upload" i][aria-busy="true"], [class*="uploading" i], [role="progressbar"]';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const CHATGPT_INLINE_PROMPT_MAX_CHARS = 24_000;
export const DEFAULT_CHATGPT_LLM_RESPONSE_TIMEOUT_MS = 90 * 60_000;

export function chatGptLlmResponseTimeoutMs(job) {
  const requested = Number(job?.response_timeout_ms);
  return Number.isFinite(requested) && requested > 0
    ? Math.max(1_000, Math.round(requested))
    : DEFAULT_CHATGPT_LLM_RESPONSE_TIMEOUT_MS;
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

function exactSha256(value, label) {
  const normalized = String(value ?? "").trim();
  if (!SHA256_PATTERN.test(normalized)) throw codedError("ui_contract_mismatch", `${label} must be an exact lowercase SHA-256.`);
  return normalized;
}

function composerDifferenceSummary(expected, observed) {
  let index = 0;
  const limit = Math.min(expected.length, observed.length);
  while (index < limit && expected[index] === observed[index]) index += 1;
  return {
    first_difference_index: index,
    expected_excerpt: expected.slice(Math.max(0, index - 80), index + 180),
    observed_excerpt: observed.slice(Math.max(0, index - 80), index + 440),
  };
}

export async function verifyChatGptComposerPrompt(composer, expectedPrompt) {
  const expected = String(expectedPrompt ?? "");
  const expectedBytes = Buffer.from(expected, "utf8");
  const rawRepresentations = await composer.evaluate((node) => ({
    value: "value" in node ? String(node.value ?? "") : null,
    block_text: Array.from(node.childNodes ?? []).map((child) => String(child.textContent ?? "")).join("\n"),
    text_content: node.textContent == null ? null : String(node.textContent),
    inner_text: node.innerText == null ? null : String(node.innerText),
  }));
  const representations = typeof rawRepresentations === "string"
    ? [{ kind: "mock", text: rawRepresentations }]
    : Object.entries(rawRepresentations ?? {})
      .filter(([, value]) => value != null)
      .map(([kind, value]) => ({ kind, text: String(value) }));
  const exact = representations.find(({ text }) => expectedBytes.equals(Buffer.from(text, "utf8")));
  const observed = exact?.text ?? representations.find(({ kind }) => kind === "inner_text")?.text ?? representations[0]?.text ?? "";
  const observedBytes = Buffer.from(observed, "utf8");
  if (!expected || !exact) {
    const difference = composerDifferenceSummary(expected, observed);
    const representationReceipts = representations.map(({ kind, text }) => ({
      kind,
      utf8_bytes: Buffer.byteLength(text, "utf8"),
      sha256: sha256Bytes(Buffer.from(text, "utf8")),
    }));
    throw codedError(
      "ui_contract_mismatch",
      `ChatGPT text prompt changed before submission (expected ${expectedBytes.length} bytes/${sha256Bytes(expectedBytes)}, representations ${JSON.stringify(representationReceipts)}, first difference ${difference.first_difference_index}, expected ${JSON.stringify(difference.expected_excerpt)}, observed ${JSON.stringify(difference.observed_excerpt)}).`,
    );
  }
  return {
    expected_sha256: sha256Bytes(expectedBytes),
    observed_sha256: sha256Bytes(observedBytes),
    expected_utf8_bytes: expectedBytes.length,
    observed_utf8_bytes: observedBytes.length,
    exact_dom_representation: exact.kind,
  };
}

export async function stabilizeChatGptComposerPrompt(composer, expectedPrompt, {
  maxAttempts = 3,
  stablePollMs = 350,
} = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await composer.fill(String(expectedPrompt ?? ""), { timeout: 30_000 });
    await sleep(stablePollMs);
    try {
      const first = await verifyChatGptComposerPrompt(composer, expectedPrompt);
      await sleep(stablePollMs);
      const second = await verifyChatGptComposerPrompt(composer, expectedPrompt);
      return { ...second, stable_polls: 2, stabilization_attempts: attempt, initial_observed_sha256: first.observed_sha256 };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? codedError("ui_contract_mismatch", "ChatGPT text prompt could not be stabilized before submission.");
}

export function createChatGptLlmPromptDelivery(prompt) {
  const source = String(prompt ?? "");
  const sourceBytes = Buffer.from(source, "utf8");
  const sourceSha256 = sha256Bytes(sourceBytes);
  const byteCount = sourceBytes.length;
  if (source.length <= CHATGPT_INLINE_PROMPT_MAX_CHARS) {
    return {
      mode: "inline",
      source_sha256: sourceSha256,
      source_utf8_bytes: byteCount,
      composer_text: source,
      attachment: null,
    };
  }
  const filename = `goldflow-prompt-${sourceSha256}-${byteCount}b.txt`;
  return {
    mode: "utf8_text_attachment",
    source_sha256: sourceSha256,
    source_utf8_bytes: byteCount,
    composer_text: [
      `Read the complete attached UTF-8 text file "${filename}" from beginning to end.`,
      "Treat the entire file contents as the user prompt and follow every instruction in it exactly.",
      `The attached file contains exactly ${byteCount} bytes and has SHA-256 ${sourceSha256}.`,
      "Do not summarize, omit, shorten, or reinterpret the attached prompt before executing it.",
    ].join(" "),
    attachment: {
      name: filename,
      mimeType: "text/plain;charset=utf-8",
      buffer: sourceBytes,
      source_sha256: sourceSha256,
      byte_count: byteCount,
    },
  };
}

export function stripChatGptAttachmentCitationArtifacts(value) {
  return String(value ?? "")
    .split("\n")
    .filter((line) => !/^\s*goldflow-prompt-[a-f0-9]{12,64}(?:…|\.\.\.).*?(?:\+\d+)?\s*$/i.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function isChatGptTransientAssistantStatus(value) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!text) return true;
  return /^(?:(?:pro|instant|thinking)\s+)?thinking(?:\.{1,3}|…)?$/i.test(text)
    || /^(?:working|generating|analyzing|reasoning)(?:\.{1,3}|…)?$/i.test(text);
}

export async function verifyChatGptTextAttachmentRetained(page, attachment, {
  timeoutMs = 90_000,
  pollMs = 250,
  stablePollsRequired = 2,
} = {}) {
  const sourceSha256 = exactSha256(attachment?.source_sha256, "ChatGPT text prompt attachment");
  const filename = String(attachment?.name ?? "");
  const byteCount = Number(attachment?.byte_count);
  if (!filename || !filename.includes(sourceSha256) || !filename.includes(`${byteCount}b`) || !filename.endsWith(".txt")) {
    throw codedError("ui_contract_mismatch", "ChatGPT text prompt attachment filename is not bound to its SHA-256 and byte count.");
  }
  const deadline = Date.now() + timeoutMs;
  let stablePolls = 0;
  while (Date.now() <= deadline) {
    const filenameChip = await visibleLocator(page.getByText(filename, { exact: true }));
    const removeControls = page.locator('button[aria-label^="Remove file" i], button[data-testid*="remove-file" i]');
    const visibleRemoveControls = [];
    for (let index = 0; index < await removeControls.count(); index += 1) {
      const control = removeControls.nth(index);
      if (await control.isVisible().catch(() => false)) visibleRemoveControls.push(control);
    }
    if (visibleRemoveControls.length > 1) {
      throw codedError("ui_contract_mismatch", `ChatGPT retained ${visibleRemoveControls.length} prompt attachments; expected exactly one hash-bound text file.`);
    }
    const retainedAttachmentControl = visibleRemoveControls[0] ?? null;
    const pendingUpload = await visibleLocator(page.locator(CHATGPT_UPLOAD_PENDING_SELECTOR));
    if ((filenameChip || retainedAttachmentControl) && !pendingUpload) {
      stablePolls += 1;
      if (stablePolls >= stablePollsRequired) {
        return {
          status: "verified",
          upload_filename: filename,
          source_sha256: sourceSha256,
          utf8_byte_count: byteCount,
          visible_filename_retained: Boolean(filenameChip),
          visible_attachment_control_retained: Boolean(retainedAttachmentControl),
          no_pending_uploads: true,
        };
      }
    } else {
      stablePolls = 0;
    }
    await sleep(pollMs);
  }
  throw codedError("ui_contract_mismatch", `ChatGPT did not visibly retain complete text prompt attachment ${filename} before submission.`);
}

export function createChatGptLlmUiContract(verifiedUiContract, promptPreparation) {
  return {
    ...verifiedUiContract,
    prompt_sha256: promptPreparation.delivery.source_sha256,
    prompt_utf8_bytes: promptPreparation.delivery.source_utf8_bytes,
    prompt_delivery: promptPreparation.delivery.mode,
    composer_instruction_sha256: promptPreparation.composer_receipt.expected_sha256,
    composer_observed_sha256: promptPreparation.composer_receipt.observed_sha256,
    prompt_attachment: promptPreparation.attachment_receipt,
    creative_submission_count: 1,
  };
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

async function dismissHistoryRateLimitModal(page) {
  const modal = await visibleLocator(page.locator(HISTORY_RATE_LIMIT_SELECTOR));
  if (!modal) return false;
  const acknowledgement = await visibleLocator(modal.getByRole("button", { name: /got it|okay|ok|dismiss|close/i }))
    ?? await visibleLocator(page.getByRole("button", { name: /got it|okay|ok|dismiss|close/i }));
  if (!acknowledgement) return false;
  await acknowledgement.click({ timeout: 10_000 }).catch(() => acknowledgement.click({ timeout: 10_000, force: true }));
  await modal.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
  return !await modal.isVisible().catch(() => false);
}

function escapedPattern(value) {
  return new RegExp(`\\b${String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
}

function normalizedModelIdentity(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\bgpt\b/g, "")
    .replace(/[^a-z0-9.]+/g, " ")
    .trim();
}

export function chatGptModelControlMatches(actualText, expectedLabel) {
  const actual = normalizedModelIdentity(actualText);
  const expected = normalizedModelIdentity(expectedLabel);
  return Boolean(expected) && actual.includes(expected);
}

async function openChatGptPowerMenu(page, powerButton) {
  if (await powerButton.getAttribute("aria-expanded") !== "true") {
    try {
      await powerButton.click();
    } catch (error) {
      if (!await dismissHistoryRateLimitModal(page)) throw error;
      await powerButton.click();
    }
  }
  return waitForVisible(page.locator('[role="menu"]:has([role="slider"]), [role="group"]:has([role="slider"])'), { timeoutMs: 10_000 });
}

async function expandChatGptAdvancedOptions(menu) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const control = await visibleLocator(menu.getByRole("menuitem", { name: /advanced/i }));
    if (!control || await control.getAttribute("aria-expanded") === "true") return;
    try {
      // ChatGPT re-renders this animated row before Playwright's stability wait
      // completes. A DOM activation avoids the animation race; the next loop
      // reacquires the row and verifies the expanded state.
      await control.evaluate((node) => node.click());
    } catch {
      await control.press("Enter", { timeout: 5_000 })
        .catch(() => control.click({ timeout: 5_000, force: true }));
    }
    await sleep(250);
  }
  const control = await visibleLocator(menu.getByRole("menuitem", { name: /advanced/i }));
  if (control && await control.getAttribute("aria-expanded") !== "true") {
    throw codedError("ui_contract_mismatch", "ChatGPT Advanced options remained collapsed after bounded activation.");
  }
}

export class ChatGptBrowser {
  constructor({ profileDir, downloadsRoot, chromeExecutable, headless = false, log = () => {}, imageStartIntervalMs = 90_000 } = {}) {
    this.profileDir = profileDir;
    this.downloadsRoot = downloadsRoot;
    this.chromeExecutable = chromeExecutable;
    this.headless = headless;
    this.log = log;
    this.context = null;
    this.loginPage = null;
    this.contractVerificationByPage = new WeakMap();
    this.imageStartGate = Promise.resolve();
    this.llmSubmissionGate = Promise.resolve();
    this.lastImageStartAt = 0;
    this.imageStartIntervalMs = Math.max(0, Number(imageStartIntervalMs) || 0);
    this.lastCooldownLogAt = 0;
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
    await this.loginPage.goto(CHATGPT_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
    return this;
  }

  async waitForAuthentication({ pollMs = 1200 } = {}) {
    let announced = false;
    while (this.context) {
      const composer = await visibleLocator(this.loginPage.locator(COMPOSER_SELECTOR));
      const signedOutControl = await visibleLocator(this.loginPage.locator(SIGNED_OUT_SELECTOR));
      if (composer && !signedOutControl) {
        const cooldown = await visibleLocator(this.loginPage.locator(HISTORY_RATE_LIMIT_SELECTOR));
        if (cooldown) {
          const dismissed = await dismissHistoryRateLimitModal(this.loginPage);
          if (!dismissed) {
            if (Date.now() - this.lastCooldownLogAt >= 60_000) {
              this.lastCooldownLogAt = Date.now();
              this.log("ChatGPT conversation cooldown acknowledgement is blocking the browser.", "warn");
            }
            await sleep(15_000);
            continue;
          }
          this.log("Dismissed a stale ChatGPT conversation-history cooldown acknowledgement.", "info");
        }
        await markLoginVerified(this.profileDir, { url: this.loginPage.url() }, "chatgpt");
        this.log("ChatGPT authentication verified.");
        return;
      }
      if (signedOutControl) {
        await clearLoginMarker(this.profileDir, "chatgpt");
        throw codedError("auth_required", "The dedicated Goldflow ChatGPT profile is signed out. Run the normal Chrome login bootstrap.");
      }
      if (!announced) {
        announced = true;
        this.log("Sign in to ChatGPT in the Goldflow browser window. Dispatch will remain stopped until the composer is visible.", "warn");
        if (!this.headless) await this.loginPage.bringToFront();
      }
      await sleep(pollMs);
    }
    throw new Error("Goldflow browser closed before ChatGPT authentication completed.");
  }

  async close() {
    const context = this.context;
    this.context = null;
    if (context) await context.close().catch(() => {});
  }

  async newJobPage() {
    if (!this.context) throw new Error("Goldflow ChatGPT browser is not running.");
    const page = await this.context.newPage();
    await page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
    const composer = await waitForVisible(page.locator(COMPOSER_SELECTOR));
    if (!composer) throw codedError("account_mismatch", "The Goldflow browser page does not expose a signed-in ChatGPT composer.");
    if (await visibleLocator(page.locator(SIGNED_OUT_SELECTOR))) {
      throw codedError("account_mismatch", "The dedicated Goldflow ChatGPT profile is signed out.");
    }
    return page;
  }

  async blockingAlert(page) {
    const historyCooldown = await visibleLocator(page.locator(HISTORY_RATE_LIMIT_SELECTOR));
    if (historyCooldown) {
      const message = (await historyCooldown.innerText().catch(() => "")).trim();
      if (await dismissHistoryRateLimitModal(page)) {
        this.log(`Dismissed ChatGPT conversation-history acknowledgement${message ? `: ${message.replace(/\s+/g, " ").slice(0, 180)}` : ""}.`, "warn");
      } else {
        throw codedError("rate_limited", message || "ChatGPT conversation-history cooldown is active.");
      }
    }
    const alerts = page.locator('[role="alert"], [data-testid*="toast"], [data-testid*="error"]');
    const values = [];
    for (let index = 0; index < await alerts.count(); index += 1) {
      const alert = alerts.nth(index);
      if (await alert.isVisible().catch(() => false)) values.push((await alert.innerText().catch(() => "")).trim());
    }
    const text = values.filter(Boolean).join("\n");
    if (!text) return;
    if (/usage limit|limit resets|try again later|reached.*limit/i.test(text)) throw codedError("usage_limited", text);
    if (/rate limit|too many requests|slow down/i.test(text)) throw codedError("rate_limited", text);
    if (/something went wrong|network error|failed to generate/i.test(text)) throw codedError("chatgpt_generation_error", text);
  }

  async profilePlanText(page) {
    const profileControl = await waitForVisible(page.locator([
      '[data-testid="accounts-profile-button"]',
      'button[aria-label*="profile menu" i]',
      '[role="button"][aria-label*="profile menu" i]',
      '[role="button"][aria-label*="profile" i]',
    ].join(", ")), { timeoutMs: 30_000 });
    if (!profileControl) return "";
    const closedText = `${await profileControl.getAttribute("aria-label").catch(() => "") ?? ""} ${await profileControl.innerText().catch(() => "")}`;
    // ChatGPT now exposes the account tier directly in the closed profile control.
    // Avoid opening the sidebar menu when that is already enough to verify the plan.
    if (/\b(?:Pro|Plus|Team|Business|Enterprise)\b/i.test(closedText)) return closedText.trim();
    await profileControl.click({ timeout: 10_000 }).catch(async () => {
      await profileControl.click({ timeout: 10_000, force: true });
    });
    try {
      const overlays = page.locator('[role="menu"], [role="dialog"], [data-radix-menu-content], [data-state="open"]');
      const deadline = Date.now() + 5_000;
      let openedText = "";
      while (Date.now() < deadline) {
        const parts = [];
        for (let index = 0; index < await overlays.count(); index += 1) {
          const overlay = overlays.nth(index);
          if (!await overlay.isVisible().catch(() => false)) continue;
          parts.push(await overlay.innerText().catch(() => ""));
        }
        openedText = parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
        if (openedText) break;
        await sleep(150);
      }
      return `${closedText} ${openedText}`.trim();
    } finally {
      await page.keyboard.press("Escape").catch(() => {});
    }
  }

  async writeUiContractDiagnostics(page, contract, error) {
    const directory = path.join(this.downloadsRoot, "_ui-contract-diagnostics");
    await fs.mkdir(directory, { recursive: true });
    const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const jsonPath = path.join(directory, `${stamp}.json`);
    const screenshotPath = path.join(directory, `${stamp}.png`);
    const controls = await page.locator('button, [role="button"], [role="menu"], [role="dialog"], [role="slider"]').evaluateAll((nodes) => nodes
      .filter((node) => node instanceof HTMLElement && node.offsetParent !== null)
      .slice(0, 120)
      .map((node) => ({
        tag: node.tagName,
        role: node.getAttribute("role"),
        test_id: node.getAttribute("data-testid"),
        aria_label: node.getAttribute("aria-label"),
        aria_expanded: node.getAttribute("aria-expanded"),
        text: (node.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
      })))
      .catch(() => []);
    await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
    await fs.writeFile(jsonPath, `${JSON.stringify({
      captured_at: new Date().toISOString(),
      url: page.url(),
      title: await page.title().catch(() => ""),
      expected_contract: contract,
      failure: { code: error.code ?? "ui_contract_mismatch", message: error.message },
      visible_controls: controls,
      screenshot_path: screenshotPath,
    }, null, 2)}\n`);
    return jsonPath;
  }

  async verifyUiContract(page, contract) {
    try {
      const profileText = await this.profilePlanText(page);
      await dismissHistoryRateLimitModal(page);
      if (!escapedPattern(contract.account_plan).test(profileText)) {
        throw codedError("account_mismatch", `Expected a signed-in ${contract.account_plan} ChatGPT account.`);
      }

      const powerButton = await waitForVisible(page.locator('button[aria-haspopup="menu"]:has(.uFxlGa_SliderTriggerChatSelectionLabel)'), { timeoutMs: 30_000 });
      if (!powerButton) throw codedError("ui_contract_mismatch", "Expected the ChatGPT model and effort control.");
      let menu = await openChatGptPowerMenu(page, powerButton);
      if (!menu) throw codedError("ui_contract_mismatch", "ChatGPT did not expose its effort menu.");

      await expandChatGptAdvancedOptions(menu);
      let modelControl = await visibleLocator(menu.getByRole("menuitem", { name: /^model\b/i }));
      if (!modelControl) throw codedError("ui_contract_mismatch", "ChatGPT Advanced options did not expose its model selector.");
      if (!chatGptModelControlMatches(await modelControl.innerText(), contract.model_label)) {
        await modelControl.click();
        const wantedModel = await waitForVisible(page.getByRole("menuitemradio", { name: contract.model_label, exact: true }), { timeoutMs: 10_000 });
        if (!wantedModel) throw codedError("ui_contract_mismatch", `ChatGPT did not expose model ${contract.model_label}.`);
        await wantedModel.press("Enter");
        await sleep(250);
        await page.keyboard.press("Escape").catch(() => {});
        if (await powerButton.getAttribute("aria-expanded") !== "true") {
          menu = await openChatGptPowerMenu(page, powerButton);
        } else {
          menu = await waitForVisible(page.locator('[role="menu"]:has([role="slider"]), [role="group"]:has([role="slider"])'), { timeoutMs: 10_000 });
        }
        if (!menu) throw codedError("ui_contract_mismatch", "ChatGPT model selection closed the effort menu unexpectedly.");
        await expandChatGptAdvancedOptions(menu);
        modelControl = await visibleLocator(menu.getByRole("menuitem", { name: /^model\b/i }));
      }

      const slider = menu.locator('[role="slider"]').first();
      let menuText = (await menu.innerText()).replace(/\s+/g, " ").trim();
      if (!menuText.includes(`Effort ${contract.effort_label}`)) {
        await slider.focus();
        const effortIndex = chatGptEffortSliderIndex(contract.effort_label);
        await slider.press("Home");
        for (let index = 0; index < effortIndex; index += 1) await slider.press("ArrowRight");
        await sleep(250);
        menuText = (await menu.innerText()).replace(/\s+/g, " ").trim();
      }
      if (!menuText.includes(`Effort ${contract.effort_label}`)) {
        const effortControl = await visibleLocator(menu.getByRole("menuitem", { name: /^effort\b/i }));
        if (effortControl) {
          await effortControl.click();
          const effortMenus = page.locator('[role="menu"]');
          const wantedEffort = await waitForVisible(
            effortMenus.getByRole("menuitemradio", { name: contract.effort_label, exact: true }),
            { timeoutMs: 10_000 },
          ) ?? await waitForVisible(
            effortMenus.getByText(contract.effort_label, { exact: true }),
            { timeoutMs: 2_000 },
          );
          if (!wantedEffort) {
            throw codedError("ui_contract_mismatch", `ChatGPT did not expose effort ${contract.effort_label}.`);
          }
          await wantedEffort.press("Enter").catch(() => wantedEffort.click());
          await sleep(250);
          await page.keyboard.press("Escape").catch(() => {});
          menu = await openChatGptPowerMenu(page, powerButton);
          if (!menu) throw codedError("ui_contract_mismatch", "ChatGPT effort selection closed the power menu unexpectedly.");
          await expandChatGptAdvancedOptions(menu);
          modelControl = await visibleLocator(menu.getByRole("menuitem", { name: /^model\b/i }));
          menuText = (await menu.innerText()).replace(/\s+/g, " ").trim();
        }
      }
      if (!modelControl || !chatGptModelControlMatches(await modelControl.innerText(), contract.model_label)) {
        throw codedError("ui_contract_mismatch", `Expected model ${contract.model_label}; visible control was ${menuText.slice(0, 300)}.`);
      }
      if (!menuText.includes(`Effort ${contract.effort_label}`)) throw codedError("ui_contract_mismatch", `Expected effort ${contract.effort_label}; visible control was ${menuText.slice(0, 300)}.`);
      await page.keyboard.press("Escape");
      return {
        account_plan: contract.account_plan,
        model_label: contract.model_label,
        effort_label: contract.effort_label,
        verified_at: new Date().toISOString(),
      };
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      const diagnosticPath = await this.writeUiContractDiagnostics(page, contract, error).catch(() => null);
      if (diagnosticPath) error.message = `${error.message} Diagnostics: ${diagnosticPath}`;
      throw error;
    }
  }

  async verifyUiContractOnce(page, contract) {
    const key = JSON.stringify({
      account_plan: contract.account_plan,
      model_label: contract.model_label,
      effort_label: contract.effort_label,
    });
    let pageVerifications = this.contractVerificationByPage.get(page);
    if (!pageVerifications) {
      pageVerifications = new Map();
      this.contractVerificationByPage.set(page, pageVerifications);
    }
    const existing = pageVerifications.get(key);
    if (existing) return existing;
    const verification = this.verifyUiContract(page, contract);
    pageVerifications.set(key, verification);
    try {
      return await verification;
    } catch (error) {
      pageVerifications.delete(key);
      throw error;
    }
  }

  async waitForImageStartGate() {
    const turn = this.imageStartGate.then(async () => {
      const waitMs = Math.max(0, this.lastImageStartAt + this.imageStartIntervalMs - Date.now());
      if (waitMs > 0) await sleep(waitMs);
      this.lastImageStartAt = Date.now();
    });
    this.imageStartGate = turn.catch(() => {});
    await turn;
  }

  async runWithLlmSubmissionGate(operation) {
    const previous = this.llmSubmissionGate;
    let release = () => {};
    this.llmSubmissionGate = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async composer(page) {
    const target = await visibleLocator(page.locator(COMPOSER_SELECTOR));
    if (!target) throw codedError("ui_contract_mismatch", "ChatGPT composer is not visible.");
    return target;
  }

  async selectImageMode(page) {
    const pill = page.locator('[data-inline-selection-pill][data-id="picture_v2"][data-keyword="Create image"]');
    if (await pill.isVisible().catch(() => false)) return true;
    const addButton = await visibleLocator(page.locator('button[aria-label*="Add files and more" i]'));
    if (!addButton) throw codedError("ui_contract_mismatch", "ChatGPT add-files control is missing.");
    await addButton.click();
    const createImage = await waitForVisible(page.locator([
      '[role="menuitem"]:has-text("Create image")',
      '[data-id="picture_v2"]',
      '[data-keyword="Create image"]',
    ].join(", ")), { timeoutMs: 10_000 });
    // The current ChatGPT composer can invoke GPT Image directly from an image
    // request and no longer exposes the legacy Create image menu item.
    if (!createImage) {
      await page.keyboard.press("Escape").catch(() => {});
      return false;
    }
    await createImage.click();
    await pill.waitFor({ state: "visible", timeout: 10_000 });
    return true;
  }

  async attachReferences(page, job, client, onPhase) {
    if (!job.references?.length) return;
    await onPhase("attaching_references");
    const files = [];
    for (const reference of job.references) {
      const downloaded = await client.fetchReference(reference.url);
      const extension = downloaded.mimeType.includes("png") ? "png" : downloaded.mimeType.includes("webp") ? "webp" : "jpg";
      files.push({
        name: `${String(reference.slot).padStart(2, "0")}-${safeName(reference.ref_id)}.${extension}`,
        mimeType: downloaded.mimeType,
        buffer: downloaded.bytes,
      });
    }
    const existing = await page.locator('button[aria-label^="Remove file"]').count();
    const input = page.locator('#upload-files, #upload-photos, input[data-testid="upload-photos-input"], input[type="file"][accept*="image"]').first();
    await input.setInputFiles(files, { timeout: 30_000 });
    await page.waitForFunction(
      ({ expected }) => document.querySelectorAll('button[aria-label^="Remove file"]').length >= expected,
      { expected: existing + files.length },
      { timeout: 30_000 },
    );
    await onPhase("references_attached");
  }

  async attachLlmPromptFile(page, attachment) {
    const sourceSha256 = exactSha256(attachment?.source_sha256, "ChatGPT text prompt attachment");
    if (!Buffer.isBuffer(attachment?.buffer)
      || attachment.buffer.length !== Number(attachment.byte_count)
      || sha256Bytes(attachment.buffer) !== sourceSha256) {
      throw codedError("ui_contract_mismatch", "ChatGPT text prompt attachment bytes changed before upload.");
    }
    const staleChip = await visibleLocator(page.getByText(attachment.name, { exact: true }));
    if (staleChip) throw codedError("ui_contract_mismatch", `ChatGPT composer already contains attachment ${attachment.name}.`);
    const staleAttachmentControl = await visibleLocator(page.locator('button[aria-label^="Remove file" i], button[data-testid*="remove-file" i]'));
    if (staleAttachmentControl) throw codedError("ui_contract_mismatch", "ChatGPT composer already contains an unrelated attachment before long text planning.");
    let input = page.locator('#upload-files, input[type="file"]').first();
    if (!await input.count()) {
      const addButton = await visibleLocator(page.locator('button[aria-label*="Add files and more" i], button[aria-label*="Attach" i]'));
      if (!addButton) throw codedError("ui_contract_mismatch", "ChatGPT add-files control is missing for long text planning.");
      await addButton.click();
      input = page.locator('#upload-files, input[type="file"]').first();
      await input.waitFor({ state: "attached", timeout: 15_000 }).catch(() => {});
    }
    if (!await input.count()) throw codedError("ui_contract_mismatch", "ChatGPT file input is missing for long text planning.");
    await input.setInputFiles([{
      name: attachment.name,
      mimeType: attachment.mimeType,
      buffer: attachment.buffer,
    }], { timeout: 30_000 });
    return verifyChatGptTextAttachmentRetained(page, attachment);
  }

  async prepareLlmPromptSubmission(page, composer, prompt, onPhase = async () => {}) {
    const delivery = createChatGptLlmPromptDelivery(prompt);
    const composerReceipt = await stabilizeChatGptComposerPrompt(composer, delivery.composer_text);
    let attachmentReceipt = null;
    if (delivery.attachment) {
      await onPhase("attaching_prompt_file");
      attachmentReceipt = await this.attachLlmPromptFile(page, delivery.attachment);
      await onPhase("prompt_file_attached");
    }
    if (delivery.attachment) attachmentReceipt = await verifyChatGptTextAttachmentRetained(page, delivery.attachment);
    return { delivery, composer_receipt: composerReceipt, attachment_receipt: attachmentReceipt };
  }

  async submitPreparedLlm(page, prepared, { onPhase = async () => {} } = {}) {
    const composer = await this.composer(page);
    if (prepared.delivery.attachment) {
      const first = await verifyChatGptComposerPrompt(composer, prepared.delivery.composer_text);
      await sleep(350);
      const second = await verifyChatGptComposerPrompt(composer, prepared.delivery.composer_text);
      prepared.composer_receipt = { ...second, stable_polls: 2, stabilization_attempts: 1, initial_observed_sha256: first.observed_sha256 };
      prepared.attachment_receipt = await verifyChatGptTextAttachmentRetained(page, prepared.delivery.attachment);
    } else {
      prepared.composer_receipt = await stabilizeChatGptComposerPrompt(composer, prepared.delivery.composer_text);
    }
    const sendCandidates = page.locator('button[data-testid="send-button"], button[aria-label="Send prompt"], #composer-submit-button');
    const deadline = Date.now() + (prepared.delivery.attachment ? 90_000 : 15_000);
    let send = null;
    while (Date.now() <= deadline) {
      send = await visibleLocator(sendCandidates);
      if (send && !await send.isDisabled().catch(() => true)) break;
      send = null;
      if (prepared.delivery.attachment) {
        prepared.attachment_receipt = await verifyChatGptTextAttachmentRetained(page, prepared.delivery.attachment, {
          timeoutMs: 5_000,
          stablePollsRequired: 1,
        });
      }
      await sleep(500);
    }
    if (!send) throw codedError("ui_contract_mismatch", "ChatGPT send button did not become available after prompt preparation completed.");
    await onPhase("submitting");
    await send.click();
    await onPhase("submitted");
  }

  async submit(page, prompt, { preserveImageMode = false, onPhase = async () => {} } = {}) {
    const composer = await this.composer(page);
    if (preserveImageMode) {
      const pill = page.locator('[data-inline-selection-pill][data-id="picture_v2"]');
      if (!await pill.isVisible().catch(() => false)) throw codedError("ui_contract_mismatch", "ChatGPT Create image mode disappeared before submission.");
      await composer.click();
      await page.keyboard.insertText(prompt);
    } else {
      await composer.fill(prompt);
    }
    const send = await visibleLocator(page.locator('button[data-testid="send-button"], button[aria-label="Send prompt"], #composer-submit-button'));
    if (!send || await send.isDisabled().catch(() => true)) throw codedError("ui_contract_mismatch", "ChatGPT send button did not become available.");
    await onPhase("submitting");
    await send.click();
    await onPhase("submitted");
  }

  async responseText(turn) {
    const preferred = turn.locator('.markdown, [class*="markdown"], [data-message-content]').first();
    if (await preferred.count()) {
      return stripChatGptAttachmentCitationArtifacts(await preferred.evaluate((node) => {
        const clone = node.cloneNode(true);
        clone.querySelectorAll([
          'button[data-testid*="citation" i]',
          'button[aria-label*="citation" i]',
          '[data-testid*="file-citation" i]',
          'a[href*="/files/"]',
          'a[href*="backend-api/files"]',
        ].join(", ")).forEach((element) => element.remove());
        const wrapper = document.createElement("div");
        wrapper.style.cssText = "position:fixed;left:-100000px;top:0;width:1200px;white-space:normal;";
        wrapper.appendChild(clone);
        document.body.appendChild(wrapper);
        const text = wrapper.innerText;
        wrapper.remove();
        return text;
      }).catch(() => ""));
    }
    return stripChatGptAttachmentCitationArtifacts(await turn.innerText().catch(() => ""));
  }

  async waitForAssistant(page, startCount, timeoutMs = DEFAULT_CHATGPT_LLM_RESPONSE_TIMEOUT_MS) {
    const effectiveTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Math.max(1_000, Math.round(Number(timeoutMs)))
      : DEFAULT_CHATGPT_LLM_RESPONSE_TIMEOUT_MS;
    const deadline = Date.now() + effectiveTimeoutMs;
    let lastText = "";
    let stableSince = 0;
    while (Date.now() < deadline) {
      await this.blockingAlert(page);
      const turns = page.locator(ASSISTANT_SELECTOR);
      if (await turns.count() > startCount) {
        const text = await this.responseText(turns.last());
        const generating = await page.locator('button[data-testid="stop-button"], button[aria-label*="Stop generating" i]').isVisible().catch(() => false);
        if (text && !isChatGptTransientAssistantStatus(text) && !generating) {
          if (text !== lastText) {
            lastText = text;
            stableSince = Date.now();
          } else if (Date.now() - stableSince >= 1800) {
            return text;
          }
        }
      }
      await sleep(500);
    }
    throw codedError("ui_contract_mismatch", "Timed out waiting for a completed ChatGPT response.");
  }

  async generatedImageUrls(page) {
    return page.locator('img[alt*="Generated image"], button[aria-label^="Generated image"] img').evaluateAll((images) => images
      .filter((image) => image instanceof HTMLImageElement && image.offsetParent !== null && image.naturalWidth >= 512 && image.naturalHeight >= 288)
      .map((image) => image.currentSrc || image.src)
      .filter(Boolean));
  }

  async waitForGeneratedImage(page, baseline, startAssistantCount) {
    const deadline = Date.now() + 45 * 60_000;
    while (Date.now() < deadline) {
      await this.blockingAlert(page);
      const urls = await this.generatedImageUrls(page);
      const fresh = urls.find((url) => !baseline.has(url));
      if (fresh) return fresh;
      const turns = page.locator(ASSISTANT_SELECTOR);
      if (await turns.count() > startAssistantCount) {
        const response = await this.responseText(turns.last());
        if (/please upload|upload (?:the |your )?(?:visual |image )?reference|attach(?:ed)? (?:the |your )?(?:visual |image )?reference|need (?:the |your )?(?:visual |image )?reference|cannot generate|can't generate|unable to complete (?:the )?image generation|image tool incorrectly treated|image generation failed|failed to generate|clarif/i.test(response)) {
          throw codedError("chatgpt_image_refusal", response.slice(0, 600));
        }
      }
      await sleep(750);
    }
    throw codedError("ui_contract_mismatch", "Timed out waiting for a generated ChatGPT image.");
  }

  async imageBytes(page, sourceUrl) {
    if (sourceUrl.startsWith("blob:")) {
      const base64 = await page.evaluate(async (url) => {
        const response = await fetch(url);
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = "";
        const chunkSize = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
        return btoa(binary);
      }, sourceUrl);
      return Buffer.from(base64, "base64");
    }
    const response = await page.request.get(sourceUrl, { timeout: 120_000 });
    if (!response.ok()) throw new Error(`Generated image download returned HTTP ${response.status()}.`);
    return Buffer.from(await response.body());
  }

  async saveGeneratedImage(page, job, sourceUrl) {
    const directory = path.join(this.downloadsRoot, safeName(job.manifest_id ?? "llm"));
    await fs.mkdir(directory, { recursive: true });
    const filePath = path.join(directory, `${safeName(job.asset_id)}-${safeName(job.lease_token.slice(0, 12))}.img`);
    const bytes = await this.imageBytes(page, sourceUrl);
    if (!bytes.length) throw new Error("Generated image download was empty.");
    await fs.writeFile(filePath, bytes);
    return filePath;
  }

  async runJob({ job, uiContract, client, onPhase = async () => {} }) {
    if (job.type === "image") await this.waitForImageStartGate();
    const page = await this.newJobPage();
    let preservePage = false;
    try {
      await this.blockingAlert(page);
      const verified = await this.verifyUiContractOnce(page, uiContract);
      if (job.type === "image") {
        const baseline = new Set(await this.generatedImageUrls(page));
        const startAssistantCount = await page.locator(ASSISTANT_SELECTOR).count();
        const imageModeSelected = await this.selectImageMode(page);
        await this.attachReferences(page, job, client, onPhase);
        const referenceInstruction = job.references?.length
          ? "Use attached images only as ordered visual references."
          : "This is a standalone text-to-image request. Generate a brand-new image directly from the written description.";
        const imagePrompt = job.references?.length
          ? String(job.prompt ?? "")
          : String(job.prompt ?? "")
            .replace(/\b(?:no|without) image references\b[.,;:]?/gi, "")
            .replace(/[ \t]{2,}/g, " ")
            .trim();
        const prompt = [
          "Create exactly one original landscape image in a 16:9 frame.",
          `${referenceInstruction} Do not create a collage, contact sheet, explanation, or multiple variants. Do not add borders.`,
          imagePrompt,
        ].join("\n\n");
        await this.submit(page, prompt, { preserveImageMode: imageModeSelected, onPhase });
        const sourceUrl = await this.waitForGeneratedImage(page, baseline, startAssistantCount);
        await onPhase("result_ready");
        const downloadPath = await this.saveGeneratedImage(page, job, sourceUrl);
        return { downloadPath, sourceUrl, conversationUrl: page.url(), uiContract: verified };
      }
      const startCount = await page.locator(ASSISTANT_SELECTOR).count();
      const promptPreparation = await this.runWithLlmSubmissionGate(async () => {
        const composer = await this.composer(page);
        await onPhase("entering_prompt");
        const prepared = await this.prepareLlmPromptSubmission(page, composer, job.prompt, onPhase);
        await this.submitPreparedLlm(page, prepared, { onPhase });
        return prepared;
      });
      const content = await this.waitForAssistant(page, startCount, chatGptLlmResponseTimeoutMs(job));
      await onPhase("result_ready");
      return {
        content,
        conversationUrl: page.url(),
        uiContract: createChatGptLlmUiContract(verified, promptPreparation),
      };
    } catch (error) {
      preservePage = ["rate_limited", "usage_limited", "account_mismatch", "ui_contract_mismatch"].includes(error.code);
      throw error;
    } finally {
      if (!preservePage) await page.close().catch(() => {});
    }
  }
}

export { CHATGPT_URL, COMPOSER_SELECTOR, SIGNED_OUT_SELECTOR };
