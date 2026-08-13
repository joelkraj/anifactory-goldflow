#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  createGeminiLlmPromptDelivery,
  GEMINI_INLINE_PROMPT_MAX_CHARS,
  GoogleGeminiBrowser,
  isGeminiImageSurfaceUrl,
  normalizeGeminiPromptText,
  verifyGeminiComposerPrompt,
  verifyGeminiTextAttachmentRetained,
} from "../desktop/google-gemini-browser.mjs";

function composerWithInnerText(value) {
  return {
    async innerText() {
      return value;
    },
  };
}

function visibleMockLocator({ visible = true, text = "", onClick = null } = {}) {
  return {
    async count() { return visible ? 1 : 0; },
    nth() { return this; },
    async isVisible() { return visible; },
    async innerText() { return text; },
    async click() { if (onClick) await onClick(); },
  };
}

function longPromptPageMock() {
  let attachment = null;
  let filenameRevealed = false;
  const chooser = {
    async setFiles(files) {
      assert.equal(files.length, 1);
      [attachment] = files;
    },
  };
  return {
    get attachment() { return attachment; },
    getByRole(role, options) {
      if (role === "button" && options.name === "Upload & tools") return visibleMockLocator();
      return visibleMockLocator({ visible: false });
    },
    getByText(text) {
      if (text === "Upload files") return visibleMockLocator();
      return visibleMockLocator({ visible: Boolean(filenameRevealed && attachment && text === attachment.name), text });
    },
    locator(selector) {
      if (selector === "gem-attachment") {
        return visibleMockLocator({
          visible: Boolean(attachment),
          text: attachment ? `TXT${attachment.name.slice(0, 12)}...${attachment.name.slice(-12)}` : "",
          onClick: () => { filenameRevealed = true; },
        });
      }
      assert.match(selector, /progressbar|uploading/);
      return visibleMockLocator({ visible: false });
    },
    async waitForEvent(event) {
      assert.equal(event, "filechooser");
      return chooser;
    },
  };
}

function writableComposerMock() {
  let value = "";
  return {
    async fill(next) { value = next; },
    async innerText() { return value; },
  };
}

async function acceptsEditorNormalizationWithoutWeakeningContentBinding() {
  const expected = "Return café as JSON.\r\n\r\nKeep this exact clause: Joey chose mercy.";
  const observed = "Return cafe\u0301 as JSON.\u200b\nKeep\u00a0this exact clause: Joey chose mercy.\ufeff";
  const receipt = await verifyGeminiComposerPrompt(composerWithInnerText(observed), expected);
  assert.match(receipt.expected_sha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.observed_sha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.canonical_sha256, /^[a-f0-9]{64}$/);
  assert.notEqual(receipt.expected_sha256, receipt.observed_sha256, "raw prompt hashes must preserve the browser normalization difference");
  assert.equal(normalizeGeminiPromptText(expected), normalizeGeminiPromptText(observed));
}

async function acceptsCompleteLongContenteditablePrompt() {
  const paragraphs = Array.from({ length: 1_300 }, (_, index) => (
    `Beat ${String(index + 1).padStart(4, "0")}: Joey records evidence ${index + 17}; Sera changes tactic after consequence ${index + 29}.`
  ));
  const expected = paragraphs.join("\n\n");
  const observed = paragraphs
    .map((paragraph, index) => `${index % 3 === 0 ? "\u200b" : ""}${paragraph.replace("; ", ";\u00a0")}`)
    .join("\n");
  assert.ok(expected.length > 100_000, "fixture must exercise a genuinely long prompt");
  await verifyGeminiComposerPrompt(composerWithInnerText(observed), expected);
}

async function stagesCompleteLongPromptAsAuditedUtf8Attachment() {
  const prompt = Array.from({ length: 1_800 }, (_, index) => (
    `Movement ${index}: Joey preserves receipt ${index}, Sera changes tactic at the caf\u00e9, and consequence ${index + 1} remains binding.\n`
  )).join("");
  assert.ok(prompt.length > 100_000);
  const expectedBytes = Buffer.from(prompt, "utf8");
  const expectedSha256 = createHash("sha256").update(expectedBytes).digest("hex");
  const delivery = createGeminiLlmPromptDelivery(prompt);
  assert.equal(delivery.mode, "utf8_text_attachment");
  assert.equal(delivery.source_sha256, expectedSha256);
  assert.equal(delivery.source_utf8_bytes, expectedBytes.length);
  assert.ok(delivery.source_utf8_bytes > prompt.length, "receipt must bind UTF-8 bytes rather than JavaScript character count");
  assert.deepEqual(delivery.attachment.buffer, expectedBytes);
  assert.equal(delivery.attachment.byte_count, expectedBytes.length);
  assert.match(delivery.attachment.name, new RegExp(`${expectedSha256}-${expectedBytes.length}b\\.txt$`));
  assert.match(delivery.composer_text, new RegExp(expectedSha256));
  assert.match(delivery.composer_text, new RegExp(`${expectedBytes.length} bytes`));

  const page = longPromptPageMock();
  const composer = writableComposerMock();
  const browser = new GoogleGeminiBrowser();
  const prepared = await browser.prepareLlmPromptSubmission(page, composer, prompt);
  assert.equal(prepared.delivery.mode, "utf8_text_attachment");
  assert.equal(prepared.attachment_receipt.status, "verified");
  assert.equal(prepared.attachment_receipt.visible_filename_retained, true);
  assert.equal(prepared.attachment_receipt.no_pending_uploads, true);
  assert.deepEqual(page.attachment.buffer, expectedBytes, "file chooser must receive every source byte");
  assert.equal(await composer.innerText(), delivery.composer_text, "composer must contain only the deterministic attachment instruction");
}

async function keepsSmallPromptsInline() {
  const prompt = "Return one exact JSON object.";
  const delivery = createGeminiLlmPromptDelivery(prompt);
  assert.equal(delivery.mode, "inline");
  assert.equal(delivery.attachment, null);
  assert.equal(delivery.composer_text, prompt);
  assert.ok(prompt.length < GEMINI_INLINE_PROMPT_MAX_CHARS);
}

async function blocksMissingOrPendingLongPromptAttachment() {
  const delivery = createGeminiLlmPromptDelivery("X".repeat(100_001));
  const missingPage = {
    getByText() { return visibleMockLocator({ visible: false }); },
    locator() { return visibleMockLocator({ visible: false }); },
  };
  await assert.rejects(
    () => verifyGeminiTextAttachmentRetained(missingPage, delivery.attachment, { timeoutMs: 2, pollMs: 0, stablePollsRequired: 1 }),
    (error) => error.code === "ui_contract_mismatch" && /did not visibly retain/.test(error.message),
  );
  const pendingPage = {
    getByText() { return visibleMockLocator(); },
    locator(selector) {
      return visibleMockLocator({ visible: selector === "gem-attachment" || /progressbar|uploading/.test(selector), text: "TXT prompt" });
    },
  };
  await assert.rejects(
    () => verifyGeminiTextAttachmentRetained(pendingPage, delivery.attachment, { timeoutMs: 2, pollMs: 0, stablePollsRequired: 1 }),
    (error) => error.code === "ui_contract_mismatch" && /did not visibly retain/.test(error.message),
  );
}

async function blocksChangedAttachmentBytesBeforeUpload() {
  const delivery = createGeminiLlmPromptDelivery("Y".repeat(100_001));
  const browser = new GoogleGeminiBrowser();
  const changed = { ...delivery.attachment, buffer: Buffer.from(delivery.attachment.buffer) };
  changed.buffer[500] ^= 1;
  await assert.rejects(
    () => browser.attachLlmPromptFile(longPromptPageMock(), changed),
    (error) => error.code === "ui_contract_mismatch" && /bytes changed before upload/.test(error.message),
  );
}

async function rejectsIncompleteOrChangedPrompt() {
  const prompt = "Joey preserves the receipt, confronts Cassian, and frees the dungeon.";
  const cases = [
    prompt.slice(0, -12),
    prompt.replace("preserves the receipt, ", ""),
    prompt.replace("Cassian", "Sera"),
    prompt.replace("dungeon.", "dungeon!"),
    `Joey preserves the receipt, confronts\u200d Cassian, and frees the dungeon.`,
    prompt.replace("the receipt", "the  receipt"),
  ];
  for (const observed of cases) {
    await assert.rejects(
      () => verifyGeminiComposerPrompt(composerWithInnerText(observed), prompt),
      (error) => error.code === "ui_contract_mismatch"
        && /expected \d+ chars\/[a-f0-9]{64}, observed \d+ chars\/[a-f0-9]{64}/.test(error.message),
    );
  }
}

async function rejectsEmptyPrompt() {
  await assert.rejects(
    () => verifyGeminiComposerPrompt(composerWithInnerText("\u200b\ufeff"), ""),
    (error) => error.code === "ui_contract_mismatch",
  );
}

async function acceptsOnlyVerifiedGemini36FlashWithoutExtendedThinking() {
  const browser = new GoogleGeminiBrowser();
  const page = {
    getByRole(role, options) {
      assert.equal(role, "button");
      return visibleMockLocator({
        visible: options.name instanceof RegExp
          && options.name.test("Open mode picker, currently Flash"),
      });
    },
  };
  assert.deepEqual(await browser.selectTextModel(page), {
    model_label: "Gemini 3.6 Flash",
    extended_thinking: false,
    verified_picker_label: "Open mode picker, currently Flash",
  });
}

async function opensEveryTextJobOnAnIndependentAppTab() {
  const browser = new GoogleGeminiBrowser();
  const pages = [];
  browser.context = {
    async newPage() {
      const navigations = [];
      let currentUrl = "about:blank";
      const page = {
        navigations,
        async goto(url) { navigations.push(url); currentUrl = url; },
        url() { return currentUrl; },
        async bringToFront() {},
        locator() { return visibleMockLocator(); },
      };
      pages.push(page);
      return page;
    },
  };
  const first = await browser.newJobPage("llm");
  const second = await browser.newJobPage("llm");
  assert.notEqual(first, second);
  assert.deepEqual(first.navigations, ["https://gemini.google.com/app"]);
  assert.deepEqual(second.navigations, ["https://gemini.google.com/app"]);
}

async function routesImageJobsOnlyToDedicatedImagesSurface() {
  const browser = new GoogleGeminiBrowser();
  let currentUrl = "about:blank";
  let broughtToFront = false;
  browser.context = {
    async newPage() {
      return {
        async goto(url) { currentUrl = url; },
        url() { return currentUrl; },
        async bringToFront() { broughtToFront = true; },
        locator(selector) {
          if (/Sign in/.test(selector)) return visibleMockLocator({ visible: false });
          return visibleMockLocator();
        },
      };
    },
  };
  await browser.newJobPage("image");
  assert.equal(currentUrl, "https://gemini.google.com/images");
  assert.equal(broughtToFront, true);
}

async function blocksUnauthenticatedImagesSurfaceWithoutFallingBackToApp() {
  const browser = new GoogleGeminiBrowser();
  let currentUrl = "about:blank";
  browser.context = {
    async newPage() {
      return {
        async goto(url) { currentUrl = url; },
        url() { return currentUrl; },
        async bringToFront() {},
        locator(selector) {
          if (/Sign in/.test(selector)) return visibleMockLocator();
          return visibleMockLocator();
        },
      };
    },
  };
  await assert.rejects(
    () => browser.newJobPage("image"),
    (error) => error.code === "auth_required" && /\/images/.test(error.message),
  );
  assert.equal(currentUrl, "https://gemini.google.com/images");
}

function recognizesTheDedicatedImageSurfaceWithoutABrittleChipLabel() {
  assert.equal(isGeminiImageSurfaceUrl("https://gemini.google.com/images"), true);
  assert.equal(isGeminiImageSurfaceUrl("https://gemini.google.com/images?hl=en"), true);
  assert.equal(isGeminiImageSurfaceUrl("https://gemini.google.com/app"), false);
}

await acceptsEditorNormalizationWithoutWeakeningContentBinding();
await acceptsCompleteLongContenteditablePrompt();
await stagesCompleteLongPromptAsAuditedUtf8Attachment();
await keepsSmallPromptsInline();
await blocksMissingOrPendingLongPromptAttachment();
await blocksChangedAttachmentBytesBeforeUpload();
await rejectsIncompleteOrChangedPrompt();
await rejectsEmptyPrompt();
await acceptsOnlyVerifiedGemini36FlashWithoutExtendedThinking();
await opensEveryTextJobOnAnIndependentAppTab();
await routesImageJobsOnlyToDedicatedImagesSurface();
await blocksUnauthenticatedImagesSurfaceWithoutFallingBackToApp();
recognizesTheDedicatedImageSurfaceWithoutABrittleChipLabel();

console.log("google-gemini-browser tests passed");
