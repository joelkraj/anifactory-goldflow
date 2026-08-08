import { promises as fs } from "node:fs";
import path from "node:path";

import { chromium } from "playwright-core";

import { clearLoginMarker, markLoginVerified } from "./browser-login.mjs";

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

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeName(value) {
  return String(value ?? "asset").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "asset";
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

function escapedPattern(value) {
  return new RegExp(`\\b${String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
}

export class ChatGptBrowser {
  constructor({ profileDir, downloadsRoot, chromeExecutable, headless = false, log = () => {} } = {}) {
    this.profileDir = profileDir;
    this.downloadsRoot = downloadsRoot;
    this.chromeExecutable = chromeExecutable;
    this.headless = headless;
    this.log = log;
    this.context = null;
    this.loginPage = null;
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
        await markLoginVerified(this.profileDir, { url: this.loginPage.url() });
        this.log("ChatGPT authentication verified.");
        return;
      }
      if (signedOutControl) {
        await clearLoginMarker(this.profileDir);
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
    await profileControl.click({ timeout: 10_000 });
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
      if (!escapedPattern(contract.account_plan).test(profileText)) {
        throw codedError("account_mismatch", `Expected a signed-in ${contract.account_plan} ChatGPT account.`);
      }

      const powerButton = await waitForVisible(page.locator('button[aria-haspopup="menu"]:has(.uFxlGa_SliderTriggerChatSelectionLabel)'), { timeoutMs: 30_000 });
      if (!powerButton) throw codedError("ui_contract_mismatch", "Expected the ChatGPT model and effort control.");
      await powerButton.click();
      const menu = await waitForVisible(page.locator('[role="menu"]:has([role="slider"]), [role="group"]:has([role="slider"])'), { timeoutMs: 10_000 });
      if (!menu) throw codedError("ui_contract_mismatch", "ChatGPT did not expose its effort menu.");
      const slider = menu.locator('[role="slider"]').first();
      let menuText = (await menu.innerText()).replace(/\s+/g, " ").trim();
      if (!menuText.includes(`Effort ${contract.effort_label}`)) {
        await slider.focus();
        if (contract.effort_label === "Pro") {
          await slider.press("End");
        } else if (contract.effort_label === "Medium") {
          await slider.press("Home");
          await slider.press("ArrowRight");
        } else {
          throw codedError("ui_contract_mismatch", `Unsupported ChatGPT effort ${contract.effort_label}.`);
        }
        await sleep(250);
        menuText = (await menu.innerText()).replace(/\s+/g, " ").trim();
      }
      await page.keyboard.press("Escape");
      if (!menuText.includes(contract.model_label)) throw codedError("ui_contract_mismatch", `Expected model ${contract.model_label}; visible control was ${menuText.slice(0, 300)}.`);
      if (!menuText.includes(`Effort ${contract.effort_label}`)) throw codedError("ui_contract_mismatch", `Expected effort ${contract.effort_label}; visible control was ${menuText.slice(0, 300)}.`);
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

  async composer(page) {
    const target = await visibleLocator(page.locator(COMPOSER_SELECTOR));
    if (!target) throw codedError("ui_contract_mismatch", "ChatGPT composer is not visible.");
    return target;
  }

  async selectImageMode(page) {
    const pill = page.locator('[data-inline-selection-pill][data-id="picture_v2"][data-keyword="Create image"]');
    if (await pill.isVisible().catch(() => false)) return;
    const addButton = await visibleLocator(page.locator('button[aria-label*="Add files and more" i]'));
    if (!addButton) throw codedError("ui_contract_mismatch", "ChatGPT add-files control is missing.");
    await addButton.click();
    const createImage = await visibleLocator(page.getByText("Create image", { exact: true }));
    if (!createImage) throw codedError("ui_contract_mismatch", "ChatGPT Create image tool is missing.");
    await createImage.click();
    await pill.waitFor({ state: "visible", timeout: 10_000 });
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
    if (await preferred.count()) return (await preferred.innerText().catch(() => "")).trim();
    return (await turn.innerText().catch(() => "")).trim();
  }

  async waitForAssistant(page, startCount) {
    const deadline = Date.now() + 45 * 60_000;
    let lastText = "";
    let stableSince = 0;
    while (Date.now() < deadline) {
      await this.blockingAlert(page);
      const turns = page.locator(ASSISTANT_SELECTOR);
      if (await turns.count() > startCount) {
        const text = await this.responseText(turns.last());
        const generating = await page.locator('button[data-testid="stop-button"], button[aria-label*="Stop generating" i]').isVisible().catch(() => false);
        if (text && !generating) {
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
    const page = await this.newJobPage();
    let preservePage = false;
    try {
      const verified = await this.verifyUiContract(page, uiContract);
      if (job.type === "image") {
        const baseline = new Set(await this.generatedImageUrls(page));
        const startAssistantCount = await page.locator(ASSISTANT_SELECTOR).count();
        await this.selectImageMode(page);
        await this.attachReferences(page, job, client, onPhase);
        const referenceInstruction = job.references?.length
          ? "Use attached images only as ordered visual references."
          : "No reference images are attached. Generate directly from the text prompt; do not ask for uploads or clarification.";
        const prompt = [
          "Create exactly one original landscape image in a 16:9 frame.",
          `${referenceInstruction} Do not create a collage, contact sheet, explanation, or multiple variants. Do not add borders.`,
          job.prompt,
        ].join("\n\n");
        await this.submit(page, prompt, { preserveImageMode: true, onPhase });
        const sourceUrl = await this.waitForGeneratedImage(page, baseline, startAssistantCount);
        await onPhase("result_ready");
        const downloadPath = await this.saveGeneratedImage(page, job, sourceUrl);
        return { downloadPath, sourceUrl, conversationUrl: page.url(), uiContract: verified };
      }
      const startCount = await page.locator(ASSISTANT_SELECTOR).count();
      await this.submit(page, job.prompt, { onPhase });
      const content = await this.waitForAssistant(page, startCount);
      await onPhase("result_ready");
      return { content, conversationUrl: page.url(), uiContract: verified };
    } catch (error) {
      preservePage = ["rate_limited", "usage_limited", "account_mismatch", "ui_contract_mismatch"].includes(error.code);
      throw error;
    } finally {
      if (!preservePage) await page.close().catch(() => {});
    }
  }
}

export { CHATGPT_URL, COMPOSER_SELECTOR, SIGNED_OUT_SELECTOR };
