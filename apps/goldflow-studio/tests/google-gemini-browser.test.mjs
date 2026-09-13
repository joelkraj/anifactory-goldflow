#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

import {
  createGeminiLlmPromptDelivery,
  GEMINI_INLINE_PROMPT_MAX_CHARS,
  geminiBlockingCode,
  GoogleGeminiBrowser,
  isGeminiConversationUrl,
  isGeminiImageSurfaceUrl,
  isProportionalReferenceDownscale,
  normalizeGeminiPromptText,
  observedGeminiImageFilename,
  verifyGeminiComposerPrompt,
  verifyGeminiTextAttachmentRetained,
} from "../desktop/google-gemini-browser.mjs";
import { findReferenceEcho } from "../lib/image-pixel-contract.mjs";

function composerWithInnerText(value) {
  return {
    async innerText() {
      return value;
    },
  };
}

function visibleMockLocator({ visible = true, enabled = true, text = "", onClick = null } = {}) {
  return {
    async count() { return visible ? 1 : 0; },
    nth() { return this; },
    async isVisible() { return visible; },
    async isEnabled() { return enabled; },
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
    model_label: "Gemini 3.7 Flash",
    extended_thinking: false,
    verified_picker_label: "Open mode picker, currently Flash or Fast",
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

async function reusesThreePersistentImageWorkerTabsBySlot() {
  const browser = new GoogleGeminiBrowser({ concurrency: 3 });
  const createdSlots = [];
  const pages = new Map();
  browser.createPersistentWorkerPage = async (slot) => {
    createdSlots.push(slot);
    let currentUrl = "https://gemini.google.com/images";
    const navigations = [];
    const page = {
      navigations,
      async goto(url) { currentUrl = url; navigations.push(url); },
      url() { return currentUrl; },
      isClosed() { return false; },
      locator(selector) {
        return visibleMockLocator({ visible: !/Sign in/i.test(selector) });
      },
    };
    pages.set(slot, page);
    return page;
  };
  const ready = await browser.prepareWorkerSlots();
  assert.deepEqual(createdSlots.sort((left, right) => left - right), [0, 1, 2], "Gemini must prewarm exactly three stable worker tabs");
  assert.equal(ready.ready_slots.length, 3);
  assert.equal(ready.ready_slots.every((row) => isGeminiImageSurfaceUrl(row.surface_url)), true, "every prewarmed Gemini slot must be on the dedicated Images surface");
  const first = await browser.persistentJobPage("image", 1);
  const second = await browser.persistentJobPage("image", 1);
  assert.equal(first, second, "successive image jobs on one Gemini slot must reuse the same tab object");
  assert.deepEqual(first.navigations, [], "healthy Gemini Images tabs must not reload between jobs");
  assert.equal(createdSlots.filter((slot) => slot === 1).length, 1, "Gemini slot reuse must not create a replacement tab");
  await first.goto("https://gemini.google.com/app/92bd90b80ff7335c");
  first.navigations.length = 0;
  const freshComposer = await browser.persistentJobPage("image", 1);
  assert.equal(freshComposer, first, "a fresh image composer must keep the same worker tab");
  assert.equal(freshComposer.url(), "https://gemini.google.com/images");
  assert.deepEqual(first.navigations, ["https://gemini.google.com/images"], "the next image job must leave the previous cut's conversation with exactly one navigation");
  assert.equal(createdSlots.filter((slot) => slot === 1).length, 1, "resetting the image conversation must not create another tab");
  await first.goto("https://gemini.google.com/app");
  first.navigations.length = 0;
  await browser.persistentJobPage("image", 1);
  assert.deepEqual(first.navigations, ["https://gemini.google.com/images"], "an empty home is not an existing conversation");
  await first.goto("https://gemini.google.com/app/92bd90b80ff7335c");
  first.navigations.length = 0;
  assert.equal(await browser.persistentJobPage("llm", 1), first);
  assert.equal(first.url(), "https://gemini.google.com/app/92bd90b80ff7335c");
  assert.deepEqual(first.navigations, [], "persistent text jobs must retain their existing App conversation behavior");
  assert.equal(isGeminiConversationUrl("https://gemini.google.com/app/abc123?hl=en"), true);
  assert.equal(isGeminiConversationUrl("https://gemini.google.com/app"), false);
  assert.equal(isGeminiConversationUrl("https://gemini.google.com.evil.test/app/abc123"), false);
  await assert.rejects(() => browser.ensurePersistentWorkerPage(3), /integer from 0 through 2/);
}

async function keepsPersistentImageTabOpenAfterSingleSubmission() {
  const browser = new GoogleGeminiBrowser({ concurrency: 3 });
  let currentUrl = "https://gemini.google.com/images";
  let closeCalls = 0;
  let sendClicks = 0;
  let gateCalls = 0;
  const page = {
    async goto(url) { currentUrl = url; },
    url() { return currentUrl; },
    isClosed() { return false; },
    async close() { closeCalls += 1; },
    locator(selector) { return visibleMockLocator({ visible: !/Sign in/i.test(selector) }); },
    getByRole(role, options) {
      assert.equal(role, "button");
      assert.match(String(options.name), /Send message/i);
      return visibleMockLocator({ onClick: () => { sendClicks += 1; } });
    },
  };
  browser.workerPages.set(1, page);
  let cleanComposerChecks = 0;
  browser.ensureCleanImageComposer = async (candidate) => { cleanComposerChecks += 1; return candidate; };
  browser.verifyUiContract = async () => ({ model_label: "Nano Banana 2" });
  browser.visibleImageUrls = async () => [];
  browser.generatedResponseImageUrls = async () => [];
  browser.responseMessageIds = async () => [];
  browser.attachReferences = async () => ({ referenceInputs: [], orderedReferences: [] });
  browser.imageUploadState = async () => ({ready: true, expected_count: 0, observed_count: 0, no_pending_uploads: true});
  browser.pastePrompt = async () => {};
  browser.recordEvidence = async () => ({ status: "verified", expected_count: 0, observed_count: 0 });
  browser.waitForGeneratedImage = async () => ({ sourceUrl: "blob:persistent-gemini-success", bytes: Buffer.from("image") });
  browser.saveGeneratedImage = async () => "/tmp/persistent-gemini-success.img";
  const result = await browser.runJob({
    slot: 1,
    job: {
      type: "image",
      manifest_id: "persistent-gemini-manifest",
      asset_id: "cut_persistent_gemini",
      lease_token: "persistent-gemini-lease",
      worker_session_policy: "persistent_tab_per_worker_slot_v1",
      prompt: "A single test landscape.",
      references: [],
    },
    client: {},
    submitGeneration: async (click) => {
      assert.equal(sendClicks, 0, "Gemini must not send before its final submission gate");
      gateCalls += 1;
      await click();
    },
  });
  assert.equal(gateCalls, 1);
  assert.equal(sendClicks, 1, "one Gemini asset must receive exactly one creative submission");
  assert.equal(cleanComposerChecks, 1, "every Gemini image lease must verify a clean composer before submission");
  assert.equal(closeCalls, 0, "a successful persistent Gemini image job must leave its slot tab open");
  assert.equal(result.uiContract.worker_slot, 1);
  assert.equal(result.uiContract.worker_session_policy, "persistent_tab_per_worker_slot_v1");
}

async function resetsOnlyAContaminatedGeminiComposer() {
  const browser = new GoogleGeminiBrowser({ concurrency: 3 });
  let attachmentCounts = [2, 0];
  let navigations = 0;
  const page = {
    async goto(url) {
      assert.equal(url, "https://gemini.google.com/images");
      navigations += 1;
    },
    locator() { return visibleMockLocator({ visible: true }); },
  };
  browser.visibleImageComposerAttachmentCount = async () => attachmentCounts.shift() ?? 0;
  assert.equal(await browser.ensureCleanImageComposer(page), page);
  assert.equal(navigations, 1, "a contaminated Gemini composer must receive exactly one local reset before submission");

  attachmentCounts = [0];
  assert.equal(await browser.ensureCleanImageComposer(page), page);
  assert.equal(navigations, 1, "a clean Gemini composer must not reload");
}

async function ignoresStaleGeminiPixelsAfterABlobUrlChange() {
  const browser = new GoogleGeminiBrowser();
  browser.providerStatusText = async () => "Generating";
  browser.generatedResponseImageUrls = async () => ["blob:stale-renamed", "blob:actual-result"];
  browser.visibleImageUrls = async () => [];
  browser.imagePixelFingerprint = async (_page, sourceUrl) => sourceUrl === "blob:stale-renamed"
    ? { bytes: Buffer.from("stale"), sha256: "stale-pixels" }
    : { bytes: Buffer.from("fresh"), sha256: "fresh-pixels" };
  const result = await browser.waitForGeneratedImage(
    { locator() { return { async innerText() { return "Generating"; } }; } },
    new Set(["blob:stale-original"]),
    [],
    new Map([["blob:stale-original", "stale-pixels"]]),
  );
  assert.equal(result.sourceUrl, "blob:actual-result");
  assert.equal(result.bytes.toString(), "fresh");
}

async function acceptsOnlyNewModelResponseRasters() {
  const browser = new GoogleGeminiBrowser();
  browser.providerStatusText = async () => "Generating";
  let polls = 0;
  browser.generatedResponseImageUrls = async (_page, priorIds) => {
    assert.equal(priorIds.has("message-content-id-old"), true);
    return ++polls === 1 ? [] : ["blob:real-response"];
  };
  browser.visibleImageUrls = async () => { throw new Error("Gallery must never be consulted"); };
  browser.imagePixelFingerprint = async (_page, source) => {
    assert.equal(source, "blob:real-response");
    return { bytes: Buffer.from("real"), sha256: "new-pixels" };
  };
  const result = await browser.waitForGeneratedImage(
    { locator() { return { async innerText() { return "Generating"; } }; } },
    new Set(), [], new Map(), new Set(["message-content-id-old"]),
  );
  assert.equal(result.generatedResult.status, "verified");
  assert.equal(polls, 2);
}

async function ignoresOldResponseEvenWhenItsImageUrlChanges() {
  const browser = new GoogleGeminiBrowser();
  const page = { locator(selector) {
    assert.equal(selector, "model-response");
    return { last() { return {
      async count() { return 1; },
      locator(selector) {
        assert.equal(selector, "message-content[id]");
        return { first() { return { async getAttribute() { return "old-response"; } }; } };
      },
      getByRole() { throw new Error("Old response images must never be read"); },
    }; } };
  } };
  assert.deepEqual(await browser.generatedResponseImageUrls(page, new Set(["old-response"])), []);
}

function recognizesTheDedicatedImageSurfaceWithoutABrittleChipLabel() {
  assert.equal(isGeminiImageSurfaceUrl("https://gemini.google.com/images"), true);
  assert.equal(isGeminiImageSurfaceUrl("https://gemini.google.com/images?hl=en"), true);
  assert.equal(isGeminiImageSurfaceUrl("https://gemini.google.com/app"), false);
}

function recognizesOnlyTheExactTranscodedReferenceFilename() {
  const expected = "01-character-state-abcdef012345.png";
  assert.equal(observedGeminiImageFilename(`Image uploaded\n${expected}`, expected), expected);
  assert.equal(observedGeminiImageFilename("Image uploaded\n01-character-state-abcdef012345.jpg", expected), "01-character-state-abcdef012345.jpg");
  assert.equal(observedGeminiImageFilename("01-character-state-abcdef012345.jpeg", expected), "01-character-state-abcdef012345.jpeg");
  for (const wrong of [
    "02-character-state-abcdef012345.jpg",
    "01-character-state-000000000000.jpg",
    "01-other-state-abcdef012345.jpg",
    "01-character-state-abcdef012345.png.jpg",
    "Mentioned 01-character-state-abcdef012345.jpg in chat",
  ]) assert.equal(observedGeminiImageFilename(wrong, expected), null);
  assert.equal(observedGeminiImageFilename("prompt.jpg", "prompt.txt"), null);
}

async function countsModernAndLegacyImageAttachmentsWithoutDoubleCounting() {
  const browser = new GoogleGeminiBrowser();
  const collection = (visible) => ({
    async count() { return visible.length; },
    nth(index) { return visibleMockLocator({ visible: visible[index] }); },
  });
  for (const [legacy, modern, expected] of [
    [[], [true, true, false], 2],
    [[true, true], [true, true], 2],
    [[true], [true, true, true], 1],
    [[false], [], 0],
  ]) {
    const page = { locator(selector) {
      assert.ok(["gem-attachment", 'img[alt="attachment"]'].includes(selector));
      return collection(selector === "gem-attachment" ? legacy : modern);
    } };
    assert.equal(await browser.visibleImageComposerAttachmentCount(page), expected);
  }
}

async function settlesEachMatchingReferenceBeforeOpeningTheNextChooser() {
  const browser = new GoogleGeminiBrowser();
  const buffers = await Promise.all(["#204060", "#e0b080"].map((background) =>
    sharp({ create: { width: 16, height: 16, channels: 3, background } }).png().toBuffer()));
  const references = buffers.map((buffer, index) => ({ slot: index + 1, ref_id: `fixture-${index + 1}`,
    sha256: createHash("sha256").update(buffer).digest("hex"), url: `fixture:${index}` }));
  const uploaded = [];
  const phasesObserved = [];
  const pixelReads = [];
  let phase = -1;
  let firstMatchedAt = null;
  const chooser = { async setFiles(files) {
    assert.equal(files.length, 1);
    if (uploaded.length === 1) {
      assert.equal(phase, 3, "Filename-only, pending and wrong pixels cannot open the next upload");
      assert.ok(Date.now() - firstMatchedAt >= 750, "The prior matching preview must settle before the next file");
    }
    assert.deepEqual(files[0].buffer, buffers[uploaded.length], "Upload the original exact bytes once in order");
    uploaded.push(files[0]);
  } };
  const page = {
    keyboard: { async press(key) { assert.equal(key, "Escape"); } },
    getByRole(role, options) {
      assert.equal(role, "button");
      assert.equal(options.name, "Upload & tools");
      return visibleMockLocator();
    },
    getByText(text) {
      assert.equal(text, "Upload files");
      return { locator() { return visibleMockLocator(); } };
    },
    async waitForEvent(event) { assert.equal(event, "filechooser"); return chooser; },
    locator(selector) {
      assert.equal(selector, "body");
      return { async innerText() {
        if (uploaded.length === 1) {
          phase += 1;
          phasesObserved.push(phase);
        }
        // The hash-bearing filename is visible even before the upload is ready.
        return uploaded.at(-1).name;
      } };
    },
  };
  browser.visibleImageComposerAttachmentCount = async () => uploaded.length;
  browser.imageUploadState = async (_page, expectedCount) => {
    const pending = uploaded.length === 1 && phase === 1;
    return { expected_count: expectedCount, observed_count: uploaded.length, no_pending_uploads: !pending,
      ready: uploaded.length === expectedCount && !pending };
  };
  browser.imageComposerPreviewUrls = async () => {
    if (!uploaded.length || phase === 0) return [];
    return uploaded.map((_, index) => `blob:fixture-${index}`);
  };
  browser.imageBytes = async (_page, url) => {
    const index = Number(url.split("-").at(-1));
    pixelReads.push({ index, phase });
    assert.notEqual(phase, 1, "A loaded preview with pending upload must not be accepted");
    if (index === 0 && phase === 2) return buffers[1];
    if (index === 0) firstMatchedAt ??= Date.now();
    return buffers[index];
  };
  const result = await browser.attachReferences(page, { references }, {
    async fetchReference(url) { return { bytes: buffers[Number(url.split(":")[1])], mimeType: "image/png" }; },
  }, async () => {});
  assert.deepEqual(phasesObserved, [0, 1, 2, 3]);
  assert.ok(pixelReads.every((read) => read.phase !== 1), "Pending uploads must not enter pixel acceptance even when preview-read errors are caught");
  assert.ok(pixelReads.some((read) => read.phase === 2), "The mismatched preview was checked and rejected");
  assert.equal(uploaded.length, 2, "No reference was reattached or retried");
  assert.deepEqual(result.orderedReferences.map((row) => row.verification_method),
    ["preview_pixels_and_attachment_count", "preview_pixels_and_attachment_count"]);
}

async function scopesUploadPixelChecksToLoadedComposerPreviews() {
  const browser = new GoogleGeminiBrowser();
  const preview = { offsetParent: {}, complete: true, naturalWidth: 128, naturalHeight: 72, src: "blob:reference" };
  const page = { locator(selector) {
    assert.equal(selector, 'gem-attachment img, img[alt="attachment"]');
    return { async evaluateAll(callback) {
      return callback([preview, preview,
        { ...preview, src: "blob:hidden", offsetParent: null },
        { ...preview, src: "blob:pending", complete: false },
      ]);
    } };
  } };
  assert.deepEqual(await browser.imageComposerPreviewUrls(page), ["blob:reference"]);
}

async function retainsBoundedEvidenceForALoadedWrongPreview() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gemini-preview-verification-"));
  const browser = new GoogleGeminiBrowser({ downloadsRoot: root });
  const [expected, wrong] = await Promise.all(["#000000", "#ffffff"].map((background) =>
    sharp({ create: { width: 16, height: 16, channels: 3, background } }).png().toBuffer()));
  const sourceSha256 = createHash("sha256").update(expected).digest("hex");
  const reference = { slot: 1, ref_id: "workshop", sha256: sourceSha256, url: "private-reference-url" };
  let uploaded = null;
  let uploadCount = 0;
  let clock = 1_000;
  const originalNow = Date.now;
  const page = {
    keyboard: { async press() {} },
    getByRole() { return visibleMockLocator(); },
    getByText() { return { locator() { return visibleMockLocator(); } }; },
    async waitForEvent() { return { async setFiles(files) { uploaded = files[0]; uploadCount += 1; } }; },
    locator() { return { async innerText() { return uploaded.name; } }; },
  };
  browser.imageComposerPreviewUrls = async () => uploaded ? ["blob:private-preview-session"] : [];
  browser.imageUploadState = async () => ({ expected_count: 1, observed_count: 1, no_pending_uploads: true, ready: true });
  browser.imageBytes = async () => { clock += 90_001; return wrong; };
  browser.waitForImageUploads = async () => assert.fail("Wrong pixels must not reach stabilization or acceptance");
  let failure;
  try {
    Date.now = () => clock;
    await assert.rejects(() => browser.attachReferences(page, { references: [reference] }, {
      async fetchReference() { return { bytes: expected, mimeType: "image/png" }; },
    }, async () => {}), (error) => { failure = error; return error.code === "ui_contract_mismatch" && /slot 1/.test(error.message); });
  } finally { Date.now = originalNow; }
  try {
    assert.equal(uploadCount, 1, "Diagnostics must not retry or reattach the reference");
    assert.equal(failure.reference_upload_verification.length, 1, "Keep a single latest slot record, not poll history");
    const trace = failure.reference_upload_verification[0];
    assert.deepEqual({ slot: trace.slot, ref_id: trace.ref_id, source_sha256: trace.source_sha256 },
      { slot: 1, ref_id: "workshop", source_sha256: sourceSha256 });
    assert.equal(trace.baseline_preview_count, 0);
    assert.equal(trace.eligible_preview_count, 1);
    assert.equal(trace.fresh_eligible_preview_count, 1);
    assert.equal(trace.upload_ready, true);
    assert.equal(trace.no_pending_uploads, true);
    assert.equal(trace.observed_count, 1);
    assert.equal(trace.preview_read_succeeded, true);
    assert.equal(trace.pixel_comparison_succeeded, true);
    assert.equal(trace.latest_pixel_mae, 255);
    assert.equal(trace.minimum_pixel_mae, 255);
    assert.equal(trace.pixel_threshold, 1);
    assert.equal(trace.pixel_match, false);
    assert.equal(trace.stability_reached, false);
    assert.equal(trace.verified, false);
    const diagnosticPage = {
      locator() { return { async evaluateAll() { return { matched_count: 0, visible_count: 0, visible_items: [] }; } }; },
      getByText() { return {}; }, async screenshot() { throw new Error("No test screenshot"); },
    };
    const receiptPath = await browser.imageFailureDiagnostics(diagnosticPage,
      { manifest_id: "fixture", asset_id: "fixture-cut", references: [reference] }, failure);
    const text = await fs.readFile(receiptPath, "utf8");
    assert.deepEqual(JSON.parse(text).reference_upload_verification, [trace]);
    assert.doesNotMatch(text, /private-preview-session|private-reference-url|blob:|data:|https?:/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function acceptsOnlyBoundedProportionalUploadThumbnailDrift() {
  const width = 1376, height = 768;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) for (let channel = 0; channel < 3; channel += 1) {
    pixels[(y * width + x) * 3 + channel] = 80 + ((Math.floor(x / 7) + Math.floor(y / 11)) % 2) * 40 + channel * 15;
  }
  const source = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
  const thumbnail = await sharp(source).resize(1024, 571, { fit: "fill", kernel: "nearest" }).png().toBuffer();
  const distorted = await sharp(source).resize(1024, 500, { fit: "fill", kernel: "nearest" }).png().toBuffer();
  const unrelated = await sharp({ create: { width: 1024, height: 571, channels: 3, background: "white" } }).png().toBuffer();
  const swappedReference = await sharp(source).negate().png().toBuffer();
  const sameSizeDrift = await sharp(source).linear(1, 2).png().toBuffer();
  assert.equal(isProportionalReferenceDownscale({ width, height }, { width: 1024, height: 571 }), true);
  for (const dimensions of [{ width, height }, { width: 2048, height: 1143 }, { width: 1024, height: 500 }, { width: 0, height: 0 }]) {
    assert.equal(isProportionalReferenceDownscale({ width, height }, dimensions), false);
  }
  assert.equal(await findReferenceEcho(thumbnail, [{ input: source }]), null,
    "Generated-output/default pixel checks must retain strict threshold 1");
  const verify = async (expected, preview, shouldPass) => {
    const browser = new GoogleGeminiBrowser();
    let uploads = 0, clock = 1_000;
    const originalNow = Date.now;
    const page = {
      keyboard: { async press() {} },
      getByRole() { return visibleMockLocator(); },
      getByText() { return { locator() { return visibleMockLocator(); } }; },
      async waitForEvent() { return { async setFiles(files) { assert.deepEqual(files[0].buffer, expected); uploads += 1; } }; },
      locator() { return { async innerText() { return ""; } }; }, // No filename snackbar.
    };
    browser.imageComposerPreviewUrls = async () => uploads ? ["blob:fresh-reference"] : [];
    browser.imageUploadState = async () => ({ expected_count: 1, observed_count: 1, no_pending_uploads: true, ready: true });
    browser.imageBytes = async () => { if (!shouldPass) clock += 90_001; return preview; };
    let result, failure;
    try {
      if (!shouldPass) Date.now = () => clock;
      try {
        result = await browser.attachReferences(page, { references: [{ slot: 1, ref_id: "fixture",
          sha256: createHash("sha256").update(expected).digest("hex"), url: "fixture:source" }] }, {
          async fetchReference() { return { bytes: expected, mimeType: "image/png" }; },
        }, async () => {});
      } catch (error) { failure = error; }
    } finally { Date.now = originalNow; }
    assert.equal(uploads, 1, "No automatic reattachment or reference swap");
    if (shouldPass) { assert.equal(failure, undefined); return result.orderedReferences[0]; }
    assert.equal(failure?.code, "ui_contract_mismatch");
    assert.equal(failure.reference_upload_verification[0].verified, false);
    return failure.reference_upload_verification[0];
  };
  const accepted = await verify(source, thumbnail, true);
  assert.equal(accepted.observed_upload_filename, null);
  assert.equal(accepted.preview_proportional_downscale, true);
  assert.equal(accepted.preview_pixel_threshold, 3);
  assert.ok(accepted.preview_mean_absolute_difference > 1 && accepted.preview_mean_absolute_difference <= 3);
  assert.deepEqual(accepted.source_dimensions, { width, height });
  assert.deepEqual(accepted.preview_dimensions, { width: 1024, height: 571 });
  assert.equal((await verify(source, unrelated, false)).pixel_threshold, 3);
  assert.equal((await verify(swappedReference, thumbnail, false)).pixel_threshold, 3);
  assert.equal((await verify(source, distorted, false)).pixel_threshold, 1);
  assert.equal((await verify(source, sameSizeDrift, false)).pixel_threshold, 1);
}

async function waitsForUploadSpinnerEvenWithVisiblePreview() {
  const browser = new GoogleGeminiBrowser();
  browser.visibleImageComposerAttachmentCount = async () => 1;
  let loading = true;
  const page = { locator(selector) {
    assert.match(selector, /gem-attachment-content\.loading/);
    return visibleMockLocator({visible: loading});
  } };
  assert.deepEqual(await browser.imageUploadState(page, 1), {
    ready: false, expected_count: 1, observed_count: 1, no_pending_uploads: false,
  });
  await assert.rejects(() => browser.waitForImageUploads(page, 1, {timeoutMs: 1, stableMs: 0}), /could not verify the complete ordered reference set/);
  loading = false;
  assert.equal((await browser.waitForImageUploads(page, 1, {timeoutMs: 100, stableMs: 0})).ready, true);
  assert.equal((await browser.imageUploadState(page, 2)).ready, false, "Missing attachments must still block");
}

async function excludesPromptsAndPreviousTurnsFromProviderErrors() {
  const browser = new GoogleGeminiBrowser();
  const fixtures = [
    { text: "Rate limit reached", excluded: true },
    { text: "Try again later", excluded: true },
    { text: "Daily limit", responseId: "old" },
    { text: "Failed to generate", hidden: true },
    { text: "Something went wrong", visibility: "hidden" },
    { text: "Generating image", responseId: "new" },
    { text: "Too many requests. Try again later." },
  ];
  const nodes = fixtures.map((fixture) => ({ textContent: fixture.text, parentElement: {
    closest(selector) {
      if (selector === "model-response") return fixture.responseId
        ? { querySelector() { return { id: fixture.responseId }; } } : null;
      assert.match(selector, /user-query/);
      assert.match(selector, /contenteditable/);
      return fixture.excluded ? {} : null;
    },
    getClientRects() { return fixture.hidden ? [] : [{}]; },
    visibility: fixture.visibility ?? "visible",
  } }));
  const page = { locator(selector) {
    assert.equal(selector, "body");
    return { async evaluate(callback, ids) {
      let index = 0;
      const root = { ownerDocument: {
        createTreeWalker() { return { nextNode() { return nodes[index++] ?? null; } }; },
        defaultView: { getComputedStyle(parent) { return { visibility: parent.visibility }; } },
      } };
      return callback(root, ids);
    } };
  } };
  const status = await browser.providerStatusText(page, new Set(["old"]));
  assert.equal(status, "Generating image\nToo many requests. Try again later.");
  assert.equal(geminiBlockingCode(status), "rate_limited");
  fixtures.pop(); nodes.pop();
  assert.equal(geminiBlockingCode(await browser.providerStatusText(page, new Set(["old"]))), null);
  assert.equal(geminiBlockingCode("two separate limitation notices aligned at right"), null);
  assert.equal(geminiBlockingCode("Rate limit reached. Try again later."), "rate_limited");
  assert.equal(geminiBlockingCode("You reached your daily limit"), "usage_limited");
  assert.equal(geminiBlockingCode("This violates our policies"), "content_policy_rejected");
  assert.equal(geminiBlockingCode("I'm having a hard time fulfilling your request. Can I help you with something else instead?"), "google_gemini_generation_error");
  assert.equal(geminiBlockingCode("I seem to be encountering an error. Can I try something else for you?"), "google_gemini_generation_error");
}

async function capturesPresubmitImageFailureWithoutChangingTheFailure() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gemini-image-failure-"));
  const original = new Error('Uploads did not finish; https://media.example/image?Signature=private-url Bearer private-bearer "token":"private-token"');
  original.code = "ui_contract_mismatch";
  const originalMessage = original.message;
  const logs = [];
  let submissions = 0;
  let screenshotFails = false;
  const referenceSha256 = `abcdef012345${"0".repeat(52)}`;
  const node = (text, { visible = true, excluded = false, alt = "", title = "", ariaLabel = "", errorLabels = [], nestedPrompt = null } = {}) => {
    const element = {
      closest() { return excluded ? {} : null; },
      getClientRects() { return visible ? [{}] : []; },
      getAttribute(name) { assert.ok(["alt", "title", "aria-label"].includes(name)); return { alt, title, "aria-label": ariaLabel }[name]; },
      querySelectorAll(selector) { assert.equal(selector, '[role="alert"], [class*="error" i]'); return errorLabels; },
      ownerDocument: {
        defaultView: { getComputedStyle() { return { visibility: "visible" }; } },
        createTreeWalker(root) {
          let index = 0;
          return { nextNode() { return root.textNodes[index++] ?? null; } };
        },
      },
    };
    element.textNodes = [{ textContent: text, parentElement: element }];
    if (nestedPrompt) element.textNodes.push({ textContent: nestedPrompt, parentElement: node("", { excluded: true }) });
    return element;
  };
  const page = {
    locator(selector) {
      let nodes = [];
      if (selector === "gem-attachment") nodes = [node("01-state...abcdef012345", {
        title: "01-state-abcdef012345.png", ariaLabel: "Upload failed token=private-aria-token",
        errorLabels: [node("Upload error cookie: private-error-cookie", { title: "https://media.example/private-title-url", ariaLabel: "Upload failed" }),
          node("hidden error detail", { visible: false }), node("excluded error detail", { excluded: true })],
      }), node("hidden", { visible: false })];
      else if (selector === 'img[alt="attachment"]') nodes = [node("", { alt: "attachment" }), node("", { alt: "attachment" })];
      else if (selector === 'gem-attachment[aria-busy="true"]') nodes = [node("Uploading")];
      else if (selector.startsWith('[role="alert"]')) nodes = [
        node('Upload failed https://media.example/file?token=private-ui-url Authorization: private-header', { nestedPrompt: "Do not capture nested prompt" }),
        node('Do not capture prompt', { excluded: true }),
      ];
      return { async evaluateAll(callback) { return callback(nodes); } };
    },
    getByText(pattern) { assert.ok(pattern instanceof RegExp); return {}; },
    async screenshot(options) {
      assert.equal(options.fullPage, false);
      assert.equal(options.mask.length, 2);
      if (screenshotFails) throw new Error("Screenshot unavailable");
      return Buffer.from("private screenshot fixture");
    },
  };
  const browser = new GoogleGeminiBrowser({ downloadsRoot: root, log: (message) => logs.push(message) });
  browser.persistentJobPage = async () => page;
  browser.ensureCleanImageComposer = async () => page;
  browser.verifyUiContract = async () => ({});
  browser.generatedResponseImageUrls = async () => [];
  browser.attachReferences = async () => { throw original; };
  const run = () => browser.runJob({
    job: { type: "image", worker_session_policy: "persistent_tab_per_worker_slot_v1", manifest_id: "fixture-manifest", asset_id: "fixture-cut",
      references: [{ slot: 1, ref_id: "state", sha256: referenceSha256, url: "https://media.example/private-reference-url", purpose: "private-reference-purpose" }] },
    submitGeneration: async () => { submissions += 1; },
  });
  try {
    for (const failedScreenshot of [false, true]) {
      screenshotFails = failedScreenshot;
      await assert.rejects(run, (error) => error === original && error.message === originalMessage && error.code === "ui_contract_mismatch");
      const receiptPath = logs.at(-1).replace("Gemini image failure diagnostics: ", "");
      assert.ok(receiptPath.startsWith(path.join(root, "_google-gemini-ui-diagnostics")));
      const text = await fs.readFile(receiptPath, "utf8");
      const receipt = JSON.parse(text);
      assert.equal(receipt.attachments.visible_count, 1);
      assert.equal(receipt.previews.visible_count, 2, "mixed wrappers and previews must be retained independently");
      assert.equal(receipt.loading[0].observed.visible_count, 1);
      assert.equal(receipt.expected_reference_count, 1);
      assert.deepEqual(receipt.expected_references, [{ slot: 1, ref_id: "state", source_sha256: referenceSha256,
        expected_upload_name_stem: "01-state-abcdef012345",
        expected_mime_dependent_upload_names: ["01-state-abcdef012345.png", "01-state-abcdef012345.webp", "01-state-abcdef012345.jpg"] }]);
      assert.equal(receipt.attachments.visible_items[0].title, "01-state-abcdef012345.png");
      assert.match(receipt.attachments.visible_items[0].aria_label, /Upload failed/);
      assert.equal(receipt.attachments.visible_items[0].visible_error_labels.length, 1);
      assert.equal(receipt.attachments.visible_items[0].visible_error_labels[0].aria_label, "Upload failed");
      assert.match(text, /01-state-abcdef012345\.png/);
      assert.doesNotMatch(text, /private-url|private-bearer|private-token|private-ui-url|private-header|private-aria-token|private-error-cookie|private-title-url|private-reference-url|private-reference-purpose|hidden error detail|excluded error detail|Do not capture (?:nested )?prompt/);
      assert.equal(Boolean(receipt.screenshot), !failedScreenshot);
      assert.equal((await fs.stat(receiptPath)).mode & 0o777, 0o600);
      if (receipt.screenshot) assert.equal((await fs.stat(receipt.screenshot.path)).mode & 0o777, 0o600);
    }
    browser.imageFailureDiagnostics = async () => { throw new Error("Diagnostic storage unavailable"); };
    await assert.rejects(run, (error) => error === original && error.message === originalMessage && error.code === "ui_contract_mismatch");
    assert.equal(submissions, 0, "presubmit failure and diagnostics must not submit generation");
    assert.equal(logs.length, 2, "failed diagnostics must not claim a retained receipt");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

await capturesPresubmitImageFailureWithoutChangingTheFailure();
await excludesPromptsAndPreviousTurnsFromProviderErrors();
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
await reusesThreePersistentImageWorkerTabsBySlot();
await keepsPersistentImageTabOpenAfterSingleSubmission();
await resetsOnlyAContaminatedGeminiComposer();
await ignoresStaleGeminiPixelsAfterABlobUrlChange();
await acceptsOnlyNewModelResponseRasters();
await ignoresOldResponseEvenWhenItsImageUrlChanges();
recognizesTheDedicatedImageSurfaceWithoutABrittleChipLabel();
recognizesOnlyTheExactTranscodedReferenceFilename();
await countsModernAndLegacyImageAttachmentsWithoutDoubleCounting();
await settlesEachMatchingReferenceBeforeOpeningTheNextChooser();
await retainsBoundedEvidenceForALoadedWrongPreview();
await acceptsOnlyBoundedProportionalUploadThumbnailDrift();
await scopesUploadPixelChecksToLoadedComposerPreviews();
await waitsForUploadSpinnerEvenWithVisiblePreview();

console.log("google-gemini-browser tests passed");
