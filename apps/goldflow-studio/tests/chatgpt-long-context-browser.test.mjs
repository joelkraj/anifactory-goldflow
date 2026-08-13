#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  CHATGPT_INLINE_PROMPT_MAX_CHARS,
  ChatGptBrowser,
  createChatGptLlmPromptDelivery,
  createChatGptLlmUiContract,
  isChatGptTransientAssistantStatus,
  stabilizeChatGptComposerPrompt,
  stripChatGptAttachmentCitationArtifacts,
  verifyChatGptComposerPrompt,
  verifyChatGptTextAttachmentRetained,
} from "../desktop/chatgpt-browser.mjs";

function mockLocator({ visible = true, text = "", onFiles = null } = {}) {
  return {
    async count() { return visible ? 1 : 0; },
    first() { return this; },
    nth() { return this; },
    async isVisible() { return visible; },
    async innerText() { return text; },
    async setInputFiles(files) { if (onFiles) await onFiles(files); },
    async waitFor() {},
  };
}

function composerMock() {
  let value = "";
  return {
    async fill(next) { value = next; },
    async evaluate() { return value; },
    get value() { return value; },
  };
}

function restoringComposerMock() {
  let value = "";
  let fillCount = 0;
  let readsAfterFill = 0;
  return {
    async fill(next) { value = next; fillCount += 1; readsAfterFill = 0; },
    async evaluate() {
      readsAfterFill += 1;
      if (fillCount === 1 && readsAfterFill >= 2) return `${value}\nstale restored draft`;
      return value;
    },
    get fillCount() { return fillCount; },
  };
}

function attachmentPageMock() {
  let attachedFile = null;
  return {
    get attachedFile() { return attachedFile; },
    getByText(text) {
      return mockLocator({ visible: Boolean(attachedFile && text === attachedFile.name), text });
    },
    locator(selector) {
      if (selector === '#upload-files, input[type="file"]') {
        return mockLocator({
          onFiles(files) {
            assert.equal(files.length, 1, "long prompts must use exactly one attachment");
            [attachedFile] = files;
          },
        });
      }
      if (/progressbar|uploading|aria-busy/.test(selector)) return mockLocator({ visible: false });
      return mockLocator({ visible: false });
    },
  };
}

async function transportsMoreThanOneHundredThousandCharactersAsExactUtf8Bytes() {
  const prompt = Array.from({ length: 1_700 }, (_, index) => (
    `Movement ${index}: Joey preserves café receipt ${index}; consequence ${index + 1} changes Sera's next choice.\n`
  )).join("");
  assert.ok(prompt.length > 100_000, "fixture must exceed the live-failure prompt size");
  const sourceBytes = Buffer.from(prompt, "utf8");
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  const delivery = createChatGptLlmPromptDelivery(prompt);
  assert.equal(delivery.mode, "utf8_text_attachment");
  assert.equal(delivery.source_sha256, sourceSha256);
  assert.equal(delivery.source_utf8_bytes, sourceBytes.length);
  assert.deepEqual(delivery.attachment.buffer, sourceBytes);
  assert.equal(delivery.attachment.byte_count, sourceBytes.length);
  assert.match(delivery.attachment.name, new RegExp(`${sourceSha256}-${sourceBytes.length}b\\.txt$`));

  const page = attachmentPageMock();
  const composer = composerMock();
  const browser = new ChatGptBrowser();
  const prepared = await browser.prepareLlmPromptSubmission(page, composer, prompt);
  assert.deepEqual(page.attachedFile.buffer, sourceBytes, "the uploaded file must retain every original UTF-8 byte");
  assert.equal(composer.value, delivery.composer_text, "the composer must contain only the deterministic attachment instruction");
  assert.ok(!composer.value.includes(prompt.slice(0, 500)), "long source content must never be partially inserted into the composer");
  assert.equal(prepared.attachment_receipt.status, "verified");
  assert.equal(prepared.attachment_receipt.visible_filename_retained, true);
  assert.equal(prepared.attachment_receipt.no_pending_uploads, true);

  const receipt = createChatGptLlmUiContract({ provider: "chatgpt-web" }, prepared);
  assert.equal(receipt.prompt_sha256, sourceSha256);
  assert.equal(receipt.prompt_utf8_bytes, sourceBytes.length);
  assert.equal(receipt.prompt_delivery, "utf8_text_attachment");
  assert.equal(receipt.prompt_attachment.upload_filename, delivery.attachment.name);
  assert.equal(receipt.prompt_attachment.source_sha256, sourceSha256);
  assert.equal(receipt.prompt_attachment.utf8_byte_count, sourceBytes.length);
}

async function refusesMutatedOrTruncatedContent() {
  const prompt = "Joey preserves the evidence, changes Sera's next move, and closes the causal loop.";
  const composer = composerMock();
  await composer.fill(prompt.slice(0, -8));
  await assert.rejects(
    () => verifyChatGptComposerPrompt(composer, prompt),
    (error) => error.code === "ui_contract_mismatch" && /changed before submission/.test(error.message),
  );

  const delivery = createChatGptLlmPromptDelivery("Z".repeat(CHATGPT_INLINE_PROMPT_MAX_CHARS + 1));
  const changed = { ...delivery.attachment, buffer: Buffer.from(delivery.attachment.buffer) };
  changed.buffer[100] ^= 1;
  const browser = new ChatGptBrowser();
  await assert.rejects(
    () => browser.attachLlmPromptFile(attachmentPageMock(), changed),
    (error) => error.code === "ui_contract_mismatch" && /bytes changed before upload/.test(error.message),
  );
}

async function preservesDirectComposerFillForShortPrompts() {
  const prompt = "Return one exact JSON object with the strongest premise.";
  const delivery = createChatGptLlmPromptDelivery(prompt);
  assert.equal(delivery.mode, "inline");
  assert.equal(delivery.attachment, null);
  assert.equal(delivery.composer_text, prompt);
  const page = attachmentPageMock();
  const composer = composerMock();
  const prepared = await new ChatGptBrowser().prepareLlmPromptSubmission(page, composer, prompt);
  assert.equal(page.attachedFile, null);
  assert.equal(composer.value, prompt);
  assert.equal(prepared.attachment_receipt, null);
  assert.equal(prepared.composer_receipt.expected_utf8_bytes, Buffer.byteLength(prompt, "utf8"));
}

async function acceptsOneRetainedAttachmentControlWhenFilenameIsVisuallyTruncated() {
  const delivery = createChatGptLlmPromptDelivery("A".repeat(CHATGPT_INLINE_PROMPT_MAX_CHARS + 1));
  const page = {
    getByText() { return mockLocator({ visible: false }); },
    locator(selector) {
      if (/Remove file|remove-file/.test(selector)) return mockLocator({ visible: true });
      if (/progressbar|uploading|aria-busy/.test(selector)) return mockLocator({ visible: false });
      return mockLocator({ visible: false });
    },
  };
  const receipt = await verifyChatGptTextAttachmentRetained(page, delivery.attachment, {
    timeoutMs: 10,
    pollMs: 0,
    stablePollsRequired: 1,
  });
  assert.equal(receipt.visible_filename_retained, false);
  assert.equal(receipt.visible_attachment_control_retained, true);
  assert.equal(receipt.no_pending_uploads, true);
}

async function restabilizesAComposerBeforeSubmission() {
  const composer = restoringComposerMock();
  const receipt = await stabilizeChatGptComposerPrompt(composer, "exact protected prompt", {
    maxAttempts: 3,
    stablePollMs: 0,
  });
  assert.equal(composer.fillCount, 2, "a restored stale draft should trigger one bounded exact refill");
  assert.equal(receipt.stabilization_attempts, 2);
  assert.equal(receipt.stable_polls, 2);
}

async function acceptsAnExactLexicalBlockSerialization() {
  const expected = "first line\n\nthird line";
  const composer = {
    async evaluate() {
      return {
        value: null,
        block_text: expected,
        text_content: "first linethird line",
        inner_text: "first line\n\n\n\n\nthird line",
      };
    },
  };
  const receipt = await verifyChatGptComposerPrompt(composer, expected);
  assert.equal(receipt.exact_dom_representation, "block_text");
}

async function serializesOnlyTheLlmSubmissionCriticalSection() {
  const browser = new ChatGptBrowser();
  const events = [];
  let releaseFirst;
  const first = browser.runWithLlmSubmissionGate(async () => {
    events.push("first-start");
    await new Promise((resolve) => { releaseFirst = resolve; });
    events.push("first-end");
  });
  const second = browser.runWithLlmSubmissionGate(async () => { events.push("second"); });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ["first-start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "first-end", "second"]);
}

function stripsOnlyStandaloneAttachmentCitationChrome() {
  const input = `Observed fact.\n\ngoldflow-prompt-1d2aa9c16682f17…\n\nAuthored analysis remains.\n\ngoldflow-prompt-1d2aa9c16682f17… +1\n\nA legitimate sentence naming evidence remains.`;
  assert.equal(
    stripChatGptAttachmentCitationArtifacts(input),
    "Observed fact.\n\nAuthored analysis remains.\n\nA legitimate sentence naming evidence remains.",
  );
}

function refusesTransientThinkingChromeAsACompletedAnswer() {
  for (const value of ["Pro thinking", "Thinking", "Thinking...", "Generating…", "Analyzing..."]) {
    assert.equal(isChatGptTransientAssistantStatus(value), true, `${value} must remain transient`);
  }
  for (const value of ["PRO", "The protagonist is thinking.", "{\"status\":\"passed\"}", "Selected candidate_02"]) {
    assert.equal(isChatGptTransientAssistantStatus(value), false, `${value} must remain usable output`);
  }
}

await transportsMoreThanOneHundredThousandCharactersAsExactUtf8Bytes();
await refusesMutatedOrTruncatedContent();
await preservesDirectComposerFillForShortPrompts();
await acceptsOneRetainedAttachmentControlWhenFilenameIsVisuallyTruncated();
await restabilizesAComposerBeforeSubmission();
await acceptsAnExactLexicalBlockSerialization();
await serializesOnlyTheLlmSubmissionCriticalSection();
stripsOnlyStandaloneAttachmentCitationChrome();
refusesTransientThinkingChromeAsACompletedAnswer();

console.log("chatgpt long-context browser tests passed");
