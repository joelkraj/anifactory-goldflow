import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { chromium } from "playwright-core";

import { findReferenceEcho, normalizedImagePixels } from "../lib/image-pixel-contract.mjs";
import { clearLoginMarker, markLoginVerified } from "./browser-login.mjs";

const GOOGLE_FLOW_URL = "https://labs.google/fx/tools/flow";
const PROMPT_SELECTOR = '[data-slate-editor="true"][role="textbox"]';
const SIGNED_OUT_SELECTOR = 'a:has-text("Sign in"), button:has-text("Sign in")';
const REFERENCE_BINDING_SCHEMA = "goldflow_google_flow_reference_binding_v1";
const REFERENCE_BINDING_RECEIPT_SCHEMA = "goldflow_google_flow_reference_binding_receipt_v1";
const FLOW_MEDIA_PATH_FRAGMENT = "media.getMediaUrlRedirect";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

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
    if (!mediaUrl.pathname.includes(FLOW_MEDIA_PATH_FRAGMENT)) return null;
    const mediaId = mediaUrl.searchParams.get("name") ?? "";
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
  }

  async start() {
    if (this.concurrency > 1 && this.flowProjectUrl) {
      throw codedError("ui_contract_mismatch", "Concurrent Google Flow work requires a fresh project per job; a shared flowProjectUrl is unsafe.");
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
    await this.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://labs.google" });
    this.loginPage = this.context.pages()[0] ?? await this.context.newPage();
    await this.loginPage.goto(this.flowProjectUrl ?? GOOGLE_FLOW_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
    return this;
  }

  async waitForAuthentication({ pollMs = 1200 } = {}) {
    let announced = false;
    while (this.context) {
      const signedOut = await visibleLocator(this.loginPage.locator(SIGNED_OUT_SELECTOR));
      const authenticatedSurface = await visibleLocator(this.loginPage.locator([
        PROMPT_SELECTOR,
        'button:has-text("New project")',
      ].join(", ")));
      if (authenticatedSurface && !signedOut) {
        await markLoginVerified(this.profileDir, { url: this.loginPage.url() }, "google-flow");
        this.log("Google Flow authentication verified.");
        return;
      }
      if (signedOut) {
        await clearLoginMarker(this.profileDir, "google-flow");
        throw codedError("auth_required", "The dedicated Goldflow Google Flow profile is signed out. Run the normal Chrome login bootstrap.");
      }
      if (!announced) {
        announced = true;
        this.log("Sign in to Google Flow in the Goldflow browser window. Dispatch remains stopped until an authenticated Flow surface is visible.", "warn");
        if (!this.headless) await this.loginPage.bringToFront();
      }
      await sleep(pollMs);
    }
    throw new Error("Goldflow browser closed before Google Flow authentication completed.");
  }

  async close() {
    const context = this.context;
    this.context = null;
    if (context) await context.close().catch(() => {});
  }

  async newJobPage() {
    if (!this.context) throw new Error("Goldflow Google Flow browser is not running.");
    const page = await this.context.newPage();
    await page.goto(this.flowProjectUrl ?? GOOGLE_FLOW_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
    if (await visibleLocator(page.locator(SIGNED_OUT_SELECTOR))) throw codedError("account_mismatch", "The dedicated Goldflow Google Flow profile is signed out.");
    let composer = await waitForVisible(page.locator(PROMPT_SELECTOR), { timeoutMs: 15_000 });
    if (!composer) {
      const newProject = await visibleLocator(page.getByRole("button", { name: /new project/i }));
      if (!newProject) throw codedError("ui_contract_mismatch", "Google Flow did not expose a project composer or New project control.");
      await newProject.click();
      composer = await waitForVisible(page.locator(PROMPT_SELECTOR), { timeoutMs: 60_000 });
    }
    if (!composer) throw codedError("ui_contract_mismatch", "Google Flow project did not expose its prompt composer.");
    return page;
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
      failure: { code: error.code ?? "ui_contract_mismatch", message: error.message },
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
      if (!new RegExp(`\\b${this.flowPlanLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(bodyText)) {
        throw codedError("account_mismatch", `Expected Google Flow plan badge ${this.flowPlanLabel}.`);
      }

      let modelControl = await visibleLocator(page.getByRole("button", { name: /Nano Banana/i }));
      if (!modelControl) {
        const agentToggle = await visibleLocator(page.getByRole("button", { name: "Agent", exact: true }));
        if (!agentToggle) throw codedError("ui_contract_mismatch", "Google Flow media-mode toggle is missing.");
        await agentToggle.click();
        modelControl = await waitForVisible(page.getByRole("button", { name: /Nano Banana/i }), { timeoutMs: 10_000 });
      }
      if (!modelControl) throw codedError("ui_contract_mismatch", "Google Flow image settings control is missing.");
      await modelControl.click();
      const settingsMenu = await waitForVisible(page.getByRole("menu").filter({ hasText: /16:9/ }), { timeoutMs: 10_000 });
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
      return { ...contract, verified_at: new Date().toISOString() };
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      const diagnosticPath = await this.diagnostics(page, contract, error).catch(() => null);
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
    const result = await composer.evaluate((node) => {
      document.querySelectorAll('[data-goldflow-composer-add="true"]').forEach((element) => element.removeAttribute("data-goldflow-composer-add"));
      const visible = (element) => Boolean(element?.getClientRects().length)
        && getComputedStyle(element).visibility !== "hidden"
        && getComputedStyle(element).display !== "none";
      const buttons = [...document.querySelectorAll('button[aria-haspopup="dialog"][aria-controls]')]
        .filter((button) => visible(button) && (button.textContent?.trim() === "add_2"
          || [...button.querySelectorAll("*")].some((element) => element.textContent?.trim() === "add_2")));
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
      throw codedError("ui_contract_mismatch", "Google Flow did not expose one unambiguous composer add_2 button controlling a media dialog.");
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
    const { button, dialogId } = await this.composerAddButton(page);
    let dialog = this.controlledDialog(page, dialogId);
    if (!await dialog.isVisible().catch(() => false)) {
      await button.click();
      dialog = await waitForVisible(this.controlledDialog(page, dialogId), { timeoutMs: 10_000 });
    }
    if (!dialog) throw codedError("ui_contract_mismatch", `Google Flow composer add button did not open its controlled dialog ${dialogId}.`);
    return { dialog, dialogId };
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
      if (!await checkbox.isVisible().catch(() => false)) continue;
      if (!await checkbox.isChecked().catch(() => false)) await checkbox.click();
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
            if (!url.pathname.includes(fragment)) continue;
            const mediaId = url.searchParams.get("name") ?? "";
            if (!mediaId || seen.has(mediaId)) continue;
            seen.add(mediaId);
            rows.push({ media_id: mediaId, media_url: url.href });
          } catch {}
        }
      }
      return rows;
    }, FLOW_MEDIA_PATH_FRAGMENT);
  }

  async selectUploadedPreview(dialog, { filename, priorMediaIds, timeoutMs = 90_000 }) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
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
                if (!url.pathname.includes(fragment)) continue;
                const mediaId = url.searchParams.get("name") ?? "";
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
      }, { filename, fragment: FLOW_MEDIA_PATH_FRAGMENT }).catch(() => null);
      if (marked?.ambiguous) throw codedError("ui_contract_mismatch", `Google Flow media dialog matched ${filename} to more than one media item.`);
      if (marked?.media) {
        const parsed = parseFlowMedia(marked.media.media_url);
        if (!parsed) throw codedError("ui_contract_mismatch", `Google Flow selected preview ${filename} has an invalid media URL.`);
        const target = dialog.locator('[data-goldflow-upload-preview="true"]');
        if (await target.count() !== 1) throw codedError("ui_contract_mismatch", `Google Flow selected preview ${filename} is not unique.`);
        const alreadySelected = await visibleLocator(dialog.getByRole("button", { name: /add to prompt/i }));
        if (!alreadySelected) await target.click();
        return parsed;
      }
      const media = await this.dialogMedia(dialog);
      const fresh = media.filter((row) => !priorMediaIds.has(row.media_id));
      const exactNameVisible = await dialog.getByText(filename, { exact: true }).count().catch(() => 0);
      if (exactNameVisible > 0 && fresh.length === 1) {
        const parsed = parseFlowMedia(fresh[0].media_url);
        if (!parsed) throw codedError("ui_contract_mismatch", `Google Flow uploaded preview ${filename} has an invalid media URL.`);
        const alreadySelected = await visibleLocator(dialog.getByRole("button", { name: /add to prompt/i }));
        if (!alreadySelected) await dialog.getByText(filename, { exact: true }).first().click();
        return parsed;
      }
      await sleep(250);
    }
    throw codedError("ui_contract_mismatch", `Google Flow did not expose an exact selected preview for uploaded file ${filename}.`);
  }

  async markComposerDock(page) {
    const composer = await this.composer(page);
    const marked = await composer.evaluate((node) => {
      document.querySelectorAll('[data-goldflow-composer-dock="true"]').forEach((element) => element.removeAttribute("data-goldflow-composer-dock"));
      for (let current = node.parentElement; current && current !== document.body; current = current.parentElement) {
        const buttons = [...current.querySelectorAll("button")];
        const hasAdd = buttons.some((button) => button.getAttribute("aria-haspopup") === "dialog"
          && (button.textContent?.trim() === "add_2"
            || [...button.querySelectorAll("*")].some((element) => element.textContent?.trim() === "add_2")));
        const hasCreate = buttons.some((button) => /Create/i.test(button.textContent ?? ""));
        if (!hasAdd || !hasCreate) continue;
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
            if (!url.pathname.includes(fragment)) continue;
            const mediaId = url.searchParams.get("name") ?? "";
            if (!mediaId || seen.has(mediaId)) continue;
            seen.add(mediaId);
            rows.push({
              media_id: mediaId,
              media_url: url.href,
              loaded: !(element instanceof HTMLImageElement) || (element.complete && element.naturalWidth > 0 && element.naturalHeight > 0),
            });
          } catch {}
        }
      }
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

  async attachReferences(page, job, client, onPhase) {
    const references = Array.isArray(job.references) ? job.references : [];
    if (job.references?.length > 4) throw codedError("ui_contract_mismatch", "Google Flow supports at most four ordered prompt references.");
    await onPhase("attaching_references");
    const initial = await this.waitForComposerChips(page, []);
    if (initial.chips.length !== 0) throw codedError("ui_contract_mismatch", "Google Flow composer started with stale reference chips.");
    const referenceInputs = [];
    const boundReferences = [];

    for (let index = 0; index < references.length; index += 1) {
      const reference = references[index];
      const expectedSlot = index + 1;
      if (Number(reference.slot) !== expectedSlot) throw codedError("ui_contract_mismatch", `Google Flow reference ${reference.ref_id} is not in contiguous slot ${expectedSlot}.`);
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
      const priorMediaIds = new Set((await this.dialogMedia(dialog)).map((row) => row.media_id));
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
      const selected = await this.selectUploadedPreview(dialog, { filename: uploadFilename, priorMediaIds });
      const addToPrompt = await waitForVisible(dialog.getByRole("button", { name: /add to prompt/i }), { timeoutMs: 30_000 });
      if (!addToPrompt) throw codedError("ui_contract_mismatch", `Google Flow selected preview ${uploadFilename} has no Add to Prompt action.`);
      const enabledDeadline = Date.now() + 30_000;
      while (Date.now() < enabledDeadline && await addToPrompt.isDisabled().catch(() => true)) await sleep(200);
      if (await addToPrompt.isDisabled().catch(() => true)) {
        throw codedError("ui_contract_mismatch", `Google Flow Add to Prompt never enabled for ${uploadFilename}.`);
      }
      await addToPrompt.click();
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
        media_id: selected.media_id,
        media_url: selected.media_url,
      };
      boundReferences.push(row);
      await this.waitForComposerChips(page, boundReferences.map((item) => item.media_id));
      referenceInputs.push({
        slot: expectedSlot,
        ref_id: reference.ref_id,
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
    return visibleLocator(page.locator("button").filter({ hasText: "arrow_forward" }).filter({ hasText: "Create" }));
  }

  async generatedImageUrls(page) {
    return page.locator("img").evaluateAll((images) => images
      .filter((image) => image instanceof HTMLImageElement && image.offsetParent !== null && image.naturalWidth >= 512 && image.naturalHeight >= 288)
      .map((image) => image.currentSrc || image.src)
      .filter(Boolean));
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
        this.log(`Google Flow baseline image could not be fingerprinted: ${error.message}`, "warn");
      }
    }
    return fingerprints;
  }

  async waitForGeneratedImage(page, baseline, referenceInputs = [], baselineFingerprints = new Map()) {
    const deadline = Date.now() + 30 * 60_000;
    let nextExistingUrlFingerprintAt = 0;
    while (Date.now() < deadline) {
      await this.blockingAlert(page);
      const urls = await this.generatedImageUrls(page);
      const fresh = urls.filter((url) => !baseline.has(url));
      for (const sourceUrl of fresh) {
        try {
          const bytes = await this.imageBytes(page, sourceUrl);
          const echo = await findReferenceEcho(bytes, referenceInputs);
          if (echo) {
            baseline.add(sourceUrl);
            this.log(`Ignored a late Google Flow reference-media echo for slot ${echo.slot ?? "unknown"} (${echo.ref_id ?? "unknown"}; pixel MAE ${echo.mean_absolute_difference.toFixed(4)}).`, "warn");
            continue;
          }
          return { sourceUrl, bytes };
        } catch (error) {
          this.log(`Google Flow fresh-image candidate was not downloadable yet: ${error.message}`, "warn");
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
            const echo = await findReferenceEcho(candidate.bytes, referenceInputs);
            if (echo) {
              baselineFingerprints.set(sourceUrl, candidate.sha256);
              this.log(`Ignored a Google Flow reference-media replacement for slot ${echo.slot ?? "unknown"} (${echo.ref_id ?? "unknown"}; pixel MAE ${echo.mean_absolute_difference.toFixed(4)}).`, "warn");
              continue;
            }
            this.log("Detected a completed Google Flow image whose existing media URL was reused.", "info");
            return { sourceUrl, bytes: candidate.bytes };
          } catch (error) {
            this.log(`Google Flow existing-image candidate could not be fingerprinted yet: ${error.message}`, "warn");
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
    const response = await page.request.get(sourceUrl, { timeout: 120_000 });
    if (!response.ok()) {
      try {
        return await fetchThroughPage(sourceUrl);
      } catch (error) {
        try {
          return await renderedImageBytes(sourceUrl);
        } catch (renderError) {
          throw new Error(`Google Flow image download returned HTTP ${response.status()}, page-session fetch failed (${error.message}), and rendered-image capture failed (${renderError.message})`);
        }
      }
    }
    return Buffer.from(await response.body());
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

  async verifyVideoUiContract(page, job = {}) {
    const durationSec = Math.max(4, Math.min(10, Math.round(Number(job.duration_sec ?? 8))));
    const contract = {
      provider: "google-flow",
      media_type: "video",
      account_plan: this.flowPlanLabel,
      model_label: String(job.model_id ?? this.flowVideoModelLabel),
      aspect_ratio: "16:9",
      output_count: 1,
      duration_sec: durationSec,
      input_binding: "first_frame",
    };
    try {
      const bodyText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
      if (!new RegExp(`\\b${this.flowPlanLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(bodyText)) {
        throw codedError("account_mismatch", `Expected Google Flow plan badge ${this.flowPlanLabel}.`);
      }
      let mediaControl = await visibleLocator(page.getByRole("button", { name: /Nano Banana|Veo|Video/i }));
      if (!mediaControl) {
        const agentToggle = await visibleLocator(page.getByRole("button", { name: "Agent", exact: true }));
        if (agentToggle) await agentToggle.click();
        mediaControl = await waitForVisible(page.getByRole("button", { name: /Nano Banana|Veo|Video/i }), { timeoutMs: 10_000 });
      }
      if (!mediaControl) throw codedError("ui_contract_mismatch", "Google Flow video settings control is missing.");
      await mediaControl.click();
      const menu = await waitForVisible(page.getByRole("menu"), { timeoutMs: 10_000 });
      if (!menu) throw codedError("ui_contract_mismatch", "Google Flow video settings menu did not open.");
      const videoTab = await visibleLocator(menu.getByRole("tab", { name: /Video/i }));
      if (!videoTab) throw codedError("ui_contract_mismatch", "Google Flow Video mode is unavailable for this account.");
      await videoTab.click();
      const landscape = await visibleLocator(menu.getByRole("tab", { name: /16:9/ }));
      const oneOutput = await visibleLocator(menu.getByRole("tab", { name: "x1", exact: true }));
      if (landscape) await landscape.click();
      if (oneOutput) await oneOutput.click();
      const modelPattern = new RegExp(String(contract.model_label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const currentModel = await visibleLocator(menu.getByRole("button", { name: /Veo/i }));
      if (currentModel && !modelPattern.test(await currentModel.innerText())) {
        await currentModel.click();
        const wanted = await waitForVisible(page.getByRole("menuitem").filter({ hasText: modelPattern }), { timeoutMs: 10_000 });
        if (!wanted) throw codedError("ui_contract_mismatch", `Expected Google Flow video model ${contract.model_label}.`);
        await wanted.click();
      }
      const durationControl = await visibleLocator(page.getByRole("button", { name: new RegExp(`^${durationSec}(?:\\s*seconds?|s)$`, "i") }));
      if (durationControl) await durationControl.click();
      await page.keyboard.press("Escape").catch(() => {});
      return { ...contract, verified_at: new Date().toISOString() };
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      const diagnosticPath = await this.diagnostics(page, contract, error).catch(() => null);
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
    const response = await page.request.get(sourceUrl, { timeout: 180_000 });
    if (!response.ok()) {
      try {
        return await fetchThroughPage(sourceUrl);
      } catch (error) {
        throw new Error(`Google Flow video download returned HTTP ${response.status()}, and page-session fetch failed: ${error.message}`);
      }
    }
    return Buffer.from(await response.body());
  }

  async waitForGeneratedVideo(page, baseline = new Set()) {
    const deadline = Date.now() + 45 * 60_000;
    while (Date.now() < deadline) {
      await this.blockingAlert(page);
      const sourceUrl = (await this.generatedVideoUrls(page)).find((url) => !baseline.has(url));
      if (sourceUrl) {
        try {
          const bytes = await this.mediaBytes(page, sourceUrl);
          if (bytes.length > 100_000) return { sourceUrl, bytes };
        } catch (error) {
          this.log(`Google Flow video candidate is not downloadable yet: ${error.message}`, "warn");
        }
      }
      await sleep(1_000);
    }
    throw codedError("ui_contract_mismatch", "Timed out waiting for a generated Google Flow video.");
  }

  async runVideoJob({ job, client, onPhase = async () => {} }) {
    if (!Array.isArray(job.references) || job.references.length !== 1) {
      throw codedError("ui_contract_mismatch", "Google Flow image-to-video requires exactly one accepted first-frame image.");
    }
    const page = await this.newJobPage();
    let preservePage = false;
    try {
      const verified = await this.verifyVideoUiContract(page, job);
      const prompt = [
        "Animate the attached accepted image as the exact first frame of one continuous 16:9 shot.",
        "Preserve identity, wardrobe, anatomy, objects, environment, lighting, and spatial continuity. Do not add cuts, panels, text, duplicate subjects, or unrelated objects.",
        job.prompt,
      ].join("\n\n");
      await this.pastePrompt(page, prompt);
      const { boundReferences } = await this.attachReferences(page, job, client, onPhase);
      const baseline = new Set(await this.generatedVideoUrls(page));
      const { create, referenceBinding } = await this.recordReferenceBindingEvidence(page, job, prompt, boundReferences);
      await onPhase("submitting");
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
        uiContract: { ...verified, reference_binding: referenceBinding },
        browserProvider: "google-flow",
      };
    } catch (error) {
      preservePage = ["rate_limited", "usage_limited", "account_mismatch", "ui_contract_mismatch"].includes(error.code);
      throw error;
    } finally {
      if (!preservePage) await page.close().catch(() => {});
    }
  }

  async runJob({ job, client, onPhase = async () => {} }) {
    if (job.type === "video") return this.runVideoJob({ job, client, onPhase });
    if (job.type !== "image") throw codedError("ui_contract_mismatch", "Google Flow browser received unsupported work.");
    const page = await this.newJobPage();
    let preservePage = false;
    try {
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
      await create.click();
      await onPhase("submitted");
      const generated = await this.waitForGeneratedImage(page, baseline, referenceInputs, baselineFingerprints);
      await onPhase("result_ready");
      const downloadPath = await this.saveGeneratedImage(page, job, generated.sourceUrl, generated.bytes);
      return {
        downloadPath,
        sourceUrl: generated.sourceUrl,
        conversationUrl: page.url(),
        uiContract: { ...verified, reference_binding: referenceBinding },
        browserProvider: "google-flow",
      };
    } catch (error) {
      preservePage = ["rate_limited", "usage_limited", "account_mismatch", "ui_contract_mismatch"].includes(error.code);
      throw error;
    } finally {
      if (!preservePage) await page.close().catch(() => {});
    }
  }
}

export { GOOGLE_FLOW_URL, PROMPT_SELECTOR, SIGNED_OUT_SELECTOR };
