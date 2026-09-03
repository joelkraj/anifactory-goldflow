#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  createGeminiLlmPromptDelivery,
  GEMINI_INLINE_PROMPT_MAX_CHARS,
  geminiBlockingCode,
  GoogleGeminiBrowser,
  isGeminiConversationUrl,
  isGeminiImageSurfaceUrl,
  normalizeGeminiPromptText,
  observedGeminiImageFilename,
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
  const continued = await browser.persistentJobPage("image", 1);
  assert.equal(continued, first);
  assert.equal(continued.url(), "https://gemini.google.com/app/92bd90b80ff7335c");
  assert.deepEqual(first.navigations, [], "a successful generated-image conversation must not reset to Images home between cuts");
  await first.goto("https://gemini.google.com/app");
  first.navigations.length = 0;
  await browser.persistentJobPage("image", 1);
  assert.deepEqual(first.navigations, ["https://gemini.google.com/images"], "an empty home is not an existing conversation");
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
  });
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
    [[false], [], 0],
  ]) {
    const page = { locator(selector) {
      assert.ok(["gem-attachment", 'img[alt="attachment"]'].includes(selector));
      return collection(selector === "gem-attachment" ? legacy : modern);
    } };
    assert.equal(await browser.visibleImageComposerAttachmentCount(page), expected);
  }
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
  await assert.rejects(() => browser.waitForImageUploads(page, 1, {timeoutMs: 1, stableMs: 0}), /did not finish processing/);
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
await scopesUploadPixelChecksToLoadedComposerPreviews();
await waitsForUploadSpinnerEvenWithVisiblePreview();

console.log("google-gemini-browser tests passed");
