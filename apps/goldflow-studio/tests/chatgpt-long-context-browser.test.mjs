#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  CHATGPT_INLINE_PROMPT_MAX_CHARS,
  COMPOSER_SELECTOR,
  DEFAULT_CHATGPT_LLM_RESPONSE_TIMEOUT_MS,
  MODEL_MENU_TRIGGER_SELECTOR,
  ChatGptBrowser,
  chatGptEffortAnnouncement,
  chatGptEffortTextMatches,
  chatGptLlmResponseTimeoutMs,
  createChatGptLlmPromptDelivery,
  createChatGptLlmUiContract,
  isChatGptTransientAssistantStatus,
  selectChatGptModelAndEffort,
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

async function routesTheRequestTimeoutOnlyToLlmResponseWaiting() {
  assert.equal(chatGptLlmResponseTimeoutMs({ response_timeout_ms: 5_400_000 }), 5_400_000);
  assert.equal(
    chatGptLlmResponseTimeoutMs({}),
    DEFAULT_CHATGPT_LLM_RESPONSE_TIMEOUT_MS,
    "legacy jobs without timeout metadata must not undercut a 90-minute source writer",
  );

  const browser = new ChatGptBrowser();
  let observedTimeoutMs = null;
  const page = {
    locator() { return { async count() { return 0; } }; },
    url() { return "https://chatgpt.com/c/test-timeout"; },
    async close() {},
  };
  browser.newJobPage = async () => page;
  browser.blockingAlert = async () => {};
  browser.verifyUiContractOnce = async () => ({ provider: "chatgpt-web" });
  browser.composer = async () => ({});
  browser.prepareLlmPromptSubmission = async () => ({
    delivery: {
      mode: "inline",
      source_sha256: "a".repeat(64),
      source_utf8_bytes: 4,
      attachment: null,
    },
    composer_receipt: {
      expected_sha256: "a".repeat(64),
      observed_sha256: "a".repeat(64),
    },
    attachment_receipt: null,
  });
  browser.submitPreparedLlm = async () => {};
  browser.waitForAssistant = async (_page, _startCount, timeoutMs) => {
    observedTimeoutMs = timeoutMs;
    return "DONE";
  };
  const result = await browser.runJob({
    job: { type: "llm", prompt: "test", response_timeout_ms: 5_400_000 },
    uiContract: {},
    client: {},
  });
  assert.equal(observedTimeoutMs, 5_400_000, "the leased request timeout must control only the LLM response wait");
  assert.equal(result.content, "DONE");
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

// Fake chatgpt.com model/effort menu, shaped after the live DOM read on 2026-10-20
// (docs/proofs/chatgpt_web_picker_probe_2026-10-20.json): one trigger button labelled
// "Select ChatGPT model"; one role=menu holding a "Select model" view toggle, a "Power"
// menuitem that owns ArrowLeft/ArrowRight, an aria-hidden slider (0..4) and the
// menuitemradio choices, which are clickable only in the model view.
const EFFORT_LABELS_BY_INDEX = ["Instant", "Medium", "High", "Extra High", "Pro"];

function fakeChatGptModelMenuPage({
  models = [{ label: "GPT-6", checked: true }, { label: "GPT-5.6 Sol", checked: false }],
  effortIndex = 4,
  triggerPresent = true,
  reasoningEffortAttribute = "medium",
} = {}) {
  const state = {
    expanded: false,
    view: "default",
    models: models.map((model) => ({ ...model })),
    effortIndex,
    log: [],
  };
  const menuText = () => [
    "Pro",
    `${EFFORT_LABELS_BY_INDEX[state.effortIndex]}, ${state.effortIndex + 1} of 5. Use Left and Right arrow keys to adjust power`,
    ...state.models.map((model) => model.label),
  ].join(" ");
  const trigger = {
    async getAttribute(name) {
      if (name === "aria-expanded") return state.expanded ? "true" : "false";
      if (name === "data-selected-reasoning-effort") return reasoningEffortAttribute;
      return null;
    },
    async click() { state.expanded = true; state.view = "default"; state.log.push("open"); },
  };
  const radioLocator = (model, { visibleOnlyInModelView }) => ({
    async count() { return visibleOnlyInModelView && state.view !== "model" ? 0 : 1; },
    nth() { return this; },
    first() { return this; },
    async isVisible() { return state.expanded && (!visibleOnlyInModelView || state.view === "model"); },
    async innerText() { return model.label; },
    async getAttribute(name) { return name === "aria-checked" ? String(model.checked) : null; },
    async click() {
      if (state.view !== "model") throw new Error("model choices are not clickable outside the Select model view");
      for (const entry of state.models) entry.checked = entry === model;
      state.expanded = false;
      state.log.push(`select:${model.label}`);
    },
    async press() { return this.click(); },
  });
  const listLocator = (entries) => ({
    async count() { return entries.length; },
    nth(index) { return entries[index]; },
    first() { return entries[0] ?? { async count() { return 0; } }; },
  });
  const powerControl = {
    async count() { return 1; },
    nth() { return this; },
    async isVisible() { return state.expanded; },
    async getAttribute(name) { return name === "aria-disabled" ? (state.view === "model" ? "true" : null) : null; },
    async focus() {},
    async press(key) {
      if (state.view === "model") throw new Error("Power control is disabled in the model view");
      if (key === "ArrowLeft") state.effortIndex = Math.max(0, state.effortIndex - 1);
      if (key === "ArrowRight") state.effortIndex = Math.min(4, state.effortIndex + 1);
      state.log.push(key);
    },
  };
  const slider = {
    async count() { return 1; },
    first() { return this; },
    async getAttribute(name) { return name === "aria-valuenow" ? String(state.effortIndex) : null; },
  };
  const viewToggle = {
    async count() { return 1; },
    nth() { return this; },
    async isVisible() { return state.expanded; },
    async evaluate(fn) { fn({ click() { state.view = "model"; state.log.push("view:model"); } }); },
    async click() { state.view = "model"; state.log.push("view:model"); },
  };
  const menu = {
    async count() { return state.expanded ? 1 : 0; },
    nth() { return this; },
    first() { return this; },
    async isVisible() { return state.expanded; },
    async innerText() { return menuText(); },
    locator(selector) {
      if (selector === '[role="menuitemradio"]') return listLocator(state.models.map((model) => radioLocator(model, { visibleOnlyInModelView: false })));
      if (selector === '[role="slider"]') return slider;
      if (/aria-label="Power"/.test(selector)) return powerControl;
      return listLocator([]);
    },
    getByRole(role, { name, exact } = {}) {
      assert.equal(exact, true, "visible identity lookups must be exact");
      if (role === "menuitemradio") {
        const model = state.models.find((entry) => entry.label === name);
        return model ? radioLocator(model, { visibleOnlyInModelView: true }) : listLocator([]);
      }
      if (role === "menuitem" && name === "Select model") return viewToggle;
      return listLocator([]);
    },
  };
  const page = {
    state,
    keyboard: { async press(key) { if (key === "Escape") { state.expanded = false; state.view = "default"; state.log.push("escape"); } } },
    locator(selector) {
      if (selector === MODEL_MENU_TRIGGER_SELECTOR) return listLocator(triggerPresent ? [{ ...trigger, async isVisible() { return true; } }] : []);
      if (/role="menu"/.test(selector)) return menu;
      return listLocator([]);
    },
    url() { return "https://chatgpt.com/"; },
    async title() { return "ChatGPT"; },
  };
  return page;
}

const PRO_GPT6_CONTRACT = { account_plan: "Pro", model_label: "GPT-6", effort_label: "Pro" };

async function verifiesAnAlreadySelectedModelAndEffortWithoutChangingAnything() {
  const page = fakeChatGptModelMenuPage();
  const receipt = await selectChatGptModelAndEffort(page, PRO_GPT6_CONTRACT);
  assert.deepEqual(receipt.model_choices, ["GPT-6", "GPT-5.6 Sol"]);
  assert.equal(receipt.effort_slider_value, 4);
  assert.equal(receipt.effort_announcement, "Pro, 5 of 5");
  assert.equal(receipt.selected_reasoning_effort_attribute, "medium", "the trigger attribute is recorded, not trusted");
  assert.deepEqual(page.state.log, ["open", "escape"], "a matching menu must only be opened and closed");
  assert.equal(page.state.expanded, false, "the menu must be closed before the composer is used");
}

async function selectsTheModelByVisibleIdentityThroughTheSelectModelView() {
  const page = fakeChatGptModelMenuPage({
    models: [{ label: "GPT-6", checked: false }, { label: "GPT-5.6 Sol", checked: true }],
  });
  const receipt = await selectChatGptModelAndEffort(page, PRO_GPT6_CONTRACT);
  assert.deepEqual(page.state.models, [{ label: "GPT-6", checked: true }, { label: "GPT-5.6 Sol", checked: false }]);
  assert.deepEqual(page.state.log.slice(0, 4), ["open", "view:model", "select:GPT-6", "open"], "selection must go through the Select model view and reverify after reopening");
  assert.equal(receipt.effort_slider_value, 4);
}

async function setsTheEffortThroughThePowerSliderFromAnyStartingPosition() {
  const page = fakeChatGptModelMenuPage({ effortIndex: 1 });
  const receipt = await selectChatGptModelAndEffort(page, PRO_GPT6_CONTRACT);
  assert.equal(page.state.effortIndex, 4);
  assert.equal(receipt.effort_slider_value, 4);
  assert.equal(page.state.log.filter((entry) => entry === "ArrowLeft").length, 4, "walk to the leftmost stop first");
  assert.equal(page.state.log.filter((entry) => entry === "ArrowRight").length, 4);

  const mediumPage = fakeChatGptModelMenuPage({ effortIndex: 4 });
  const medium = await selectChatGptModelAndEffort(mediumPage, { ...PRO_GPT6_CONTRACT, effort_label: "Medium" });
  assert.equal(mediumPage.state.effortIndex, 1);
  assert.equal(medium.effort_announcement, "Medium, 2 of 5");
}

async function failsClosedOnModelMenuDrift() {
  await assert.rejects(
    () => selectChatGptModelAndEffort(fakeChatGptModelMenuPage({ triggerPresent: false }), PRO_GPT6_CONTRACT),
    (error) => error.code === "ui_contract_mismatch" && /Select ChatGPT model/.test(error.message),
  );
  const staleLabelPage = fakeChatGptModelMenuPage();
  await assert.rejects(
    () => selectChatGptModelAndEffort(staleLabelPage, { ...PRO_GPT6_CONTRACT, model_label: "GPT-6 Sol" }),
    (error) => error.code === "ui_contract_mismatch" && /did not expose model GPT-6 Sol; visible choices were GPT-6 \(selected\), GPT-5\.6 Sol/.test(error.message),
  );
  assert.equal(staleLabelPage.state.expanded, false, "a failed verification must still close the menu");
  assert.equal(staleLabelPage.state.models[0].checked, true, "a mismatch must never change the account's selected model");
}

async function readsThePlanFromTheProfileMenuAfterItRenders() {
  // A decoy [data-state="open"] element carries text before the profile menu renders.
  let clicks = 0;
  let menuRendered = false;
  const control = {
    async count() { return 1; },
    nth() { return this; },
    async isVisible() { return true; },
    async getAttribute(name) {
      if (name === "aria-label") return "Open profile menu";
      if (name === "aria-expanded") return clicks > 0 ? "true" : "false";
      if (name === "aria-controls") return clicks > 0 ? "radix-profile-menu" : null;
      return null;
    },
    async innerText() { return ""; },
    async click() { clicks += 1; setTimeout(() => { menuRendered = true; }, 200); },
  };
  const decoy = { async isVisible() { return true; }, async innerText() { return "Chat Work"; } };
  const menu = { async isVisible() { return menuRendered; }, async innerText() { return "joliepolie Pro Personalization Settings Log out"; } };
  const page = {
    keyboard: { async press() {} },
    locator(selector) {
      if (/radix-profile-menu/.test(selector)) return { async count() { return 1; }, nth() { return menu; } };
      if (/profile/.test(selector)) return control;
      return { async count() { return 2; }, nth(index) { return index === 0 ? decoy : menu; } };
    },
  };
  const text = await new ChatGptBrowser().profilePlanText(page);
  assert.match(text, /\bPro\b/, "the plan must be read from the rendered profile menu, not the first open overlay");
  assert.equal(clicks, 1, "a menu that renders within the window must not be re-clicked");
}

async function verifyUiContractReportsTheSelectionAndKeepsDiagnosticsOnFailure() {
  const browser = new ChatGptBrowser();
  browser.profilePlanText = async () => "Open profile menu joliepolie Pro Personalization Settings";
  const diagnostics = [];
  browser.writeUiContractDiagnostics = async (_page, contract, error) => { diagnostics.push({ contract, code: error.code }); return "/tmp/diag.json"; };
  const verified = await browser.verifyUiContract(fakeChatGptModelMenuPage({ effortIndex: 0 }), PRO_GPT6_CONTRACT);
  assert.equal(verified.model_label, "GPT-6");
  assert.equal(verified.effort_label, "Pro");
  assert.equal(verified.effort_slider_value, 4);
  assert.deepEqual(diagnostics, []);

  await assert.rejects(
    () => browser.verifyUiContract(fakeChatGptModelMenuPage(), { ...PRO_GPT6_CONTRACT, account_plan: "Team" }),
    (error) => error.code === "account_mismatch" && /Diagnostics: \/tmp\/diag\.json/.test(error.message),
  );
  assert.deepEqual(diagnostics.map((entry) => entry.code), ["account_mismatch"]);
}

function matchesTheLiveComposerAndEffortAnnouncements() {
  assert.match(COMPOSER_SELECTOR, /\[role="textbox"\]\[contenteditable="true"\]\[aria-label="Ask ChatGPT"\]/, "the ProseMirror composer must be found by its accessible name");
  assert.match(COMPOSER_SELECTOR, /data-placeholder="Ask ChatGPT"/);
  assert.match(COMPOSER_SELECTOR, /^#prompt-textarea,/, "the historical id stays first as a cheap fallback");
  assert.match(MODEL_MENU_TRIGGER_SELECTOR, /^button\[aria-label="Select ChatGPT model"\]/);
  assert.equal(chatGptEffortAnnouncement("Pro"), "Pro, 5 of 5");
  assert.equal(chatGptEffortAnnouncement("Instant"), "Instant, 1 of 5");
  assert.equal(chatGptEffortTextMatches("Pro Pro, 5 of 5. Use Left and Right arrow keys to adjust power GPT-6", "Pro"), true);
  assert.equal(chatGptEffortTextMatches("Pro Medium, 2 of 5. Use Left and Right arrow keys GPT-6", "Pro"), false);
  assert.equal(chatGptEffortTextMatches("Advanced Effort Pro Model GPT-6", "Pro"), true, "the legacy Effort row stays accepted as a cheap fallback");
}

await transportsMoreThanOneHundredThousandCharactersAsExactUtf8Bytes();
await refusesMutatedOrTruncatedContent();
await preservesDirectComposerFillForShortPrompts();
await acceptsOneRetainedAttachmentControlWhenFilenameIsVisuallyTruncated();
await restabilizesAComposerBeforeSubmission();
await acceptsAnExactLexicalBlockSerialization();
await serializesOnlyTheLlmSubmissionCriticalSection();
await routesTheRequestTimeoutOnlyToLlmResponseWaiting();
stripsOnlyStandaloneAttachmentCitationChrome();
refusesTransientThinkingChromeAsACompletedAnswer();
await verifiesAnAlreadySelectedModelAndEffortWithoutChangingAnything();
await selectsTheModelByVisibleIdentityThroughTheSelectModelView();
await setsTheEffortThroughThePowerSliderFromAnyStartingPosition();
await failsClosedOnModelMenuDrift();
await readsThePlanFromTheProfileMenuAfterItRenders();
await verifyUiContractReportsTheSelectionAndKeepsDiagnosticsOnFailure();
matchesTheLiveComposerAndEffortAnnouncements();

console.log("chatgpt long-context browser tests passed");
