(() => {
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  function visible(element) {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  }

  function textOf(element) {
    return String(element?.innerText ?? element?.textContent ?? "").trim();
  }

  function errorWithCode(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  async function waitFor(predicate, { timeoutMs = 60_000, intervalMs = 250, label = "page state" } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      detectBlockingAlert();
      await sleep(intervalMs);
    }
    throw errorWithCode("ui_contract_mismatch", `Timed out waiting for ${label}.`);
  }

  function visibleAlerts() {
    return [...document.querySelectorAll('[role="alert"], [data-testid*="toast"], [data-testid*="error"]')]
      .filter(visible)
      .map(textOf)
      .filter(Boolean)
      .join("\n");
  }

  function detectBlockingAlert() {
    const alertText = visibleAlerts();
    if (!alertText) return;
    if (/usage limit|limit resets|try again later|reached.*limit/i.test(alertText)) throw errorWithCode("usage_limited", alertText);
    if (/rate limit|too many requests|slow down/i.test(alertText)) throw errorWithCode("rate_limited", alertText);
    if (/something went wrong|network error|failed to generate/i.test(alertText)) throw errorWithCode("chatgpt_generation_error", alertText);
  }

  function composer() {
    return [...document.querySelectorAll('textarea[aria-label="Chat with ChatGPT"], textarea[placeholder*="Ask ChatGPT"], #prompt-textarea, [contenteditable="true"][data-placeholder]')]
      .find(visible);
  }

  function sendButton() {
    return document.querySelector('button[data-testid="send-button"], button[aria-label="Send prompt"], #composer-submit-button');
  }

  function imageModePill() {
    return composer()?.querySelector('[data-inline-selection-pill][data-id="picture_v2"][data-keyword="Create image"]');
  }

  async function selectImageMode() {
    if (imageModePill()) return;
    const addButton = await waitFor(
      () => [...document.querySelectorAll('button')].find((button) => visible(button) && /add files and more/i.test(button.getAttribute("aria-label") ?? textOf(button))),
      { timeoutMs: 30_000, label: "the ChatGPT add-files menu" },
    );
    addButton.click();
    const menuItem = await waitFor(() => [...document.querySelectorAll('[tabindex="0"]')].find((element) => {
      if (!visible(element)) return false;
      return [...element.querySelectorAll("span")].some((span) => textOf(span) === "Create image");
    }), { timeoutMs: 10_000, label: "the ChatGPT Create image tool" });
    menuItem.click();
    await waitFor(() => imageModePill(), { timeoutMs: 10_000, label: "active ChatGPT Create image mode" });
  }

  function assistantTurns() {
    return [...document.querySelectorAll('[data-message-author-role="assistant"]')].filter(visible);
  }

  function generatedImages() {
    return [...document.querySelectorAll('img[alt*="Generated image"], button[aria-label^="Generated image"] img')]
      .filter((image) => visible(image) && image.naturalWidth >= 512 && image.naturalHeight >= 288);
  }

  async function openPowerMenu(powerButton) {
    powerButton.focus();
    powerButton.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons: 1,
    }));
    try {
      return await waitFor(() => [...document.querySelectorAll('[role="menu"]')].find(visible), { timeoutMs: 1500, label: "the ChatGPT power menu" });
    } catch {
      powerButton.click();
      return waitFor(() => [...document.querySelectorAll('[role="menu"]')].find(visible), { timeoutMs: 10_000, label: "the ChatGPT power menu" });
    }
  }

  function pressPowerKey(slider, key) {
    for (const type of ["keydown", "keyup"]) {
      slider.dispatchEvent(new KeyboardEvent(type, {
        key,
        code: key,
        bubbles: true,
        cancelable: true,
        composed: true,
      }));
    }
  }

  async function selectEffort(menu, effortLabel) {
    const targetKeys = effortLabel === "Pro" ? ["End"] : effortLabel === "Medium" ? ["Home", "ArrowRight"] : null;
    if (!targetKeys) throw errorWithCode("ui_contract_mismatch", `Goldflow cannot select unsupported effort ${effortLabel}.`);
    const slider = menu.querySelector('[role="slider"]');
    if (!slider) throw errorWithCode("ui_contract_mismatch", "ChatGPT power menu did not expose its effort slider.");
    slider.focus();
    for (const key of targetKeys) {
      pressPowerKey(slider, key);
      await sleep(150);
    }
    return waitFor(() => {
      const normalized = textOf(menu).replace(/\s+/g, " ").trim();
      return normalized.includes(`Effort ${effortLabel}`) ? normalized : null;
    }, { timeoutMs: 10_000, label: `effort ${effortLabel}` });
  }

  async function verifyUiContract(contract) {
    await waitFor(() => composer(), { timeoutMs: 60_000, label: "the ChatGPT composer" });
    const planPattern = new RegExp(`\\b${String(contract.account_plan).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    await waitFor(() => {
      const profileButtons = [...document.querySelectorAll('[data-testid="accounts-profile-button"], [role="button"][aria-label*="profile" i]')].filter((button) => {
        const controlText = `${button.getAttribute("aria-label") ?? ""} ${textOf(button)}`;
        return /open profile menu/i.test(controlText);
      });
      const profileText = profileButtons.map((button) => `${button.getAttribute("aria-label") ?? ""} ${textOf(button)}`).join(" ");
      return planPattern.test(profileText);
    }, { timeoutMs: 30_000, label: `a signed-in ${contract.account_plan} profile control` }).catch(() => {
      throw errorWithCode("account_mismatch", `Expected a signed-in ${contract.account_plan} account, but the profile control did not confirm it.`);
    });
    const powerButton = await waitFor(
      () => [...document.querySelectorAll('button[aria-haspopup="menu"]')].find((button) => visible(button) && button.querySelector(".uFxlGa_SliderTriggerChatSelectionLabel")),
      { timeoutMs: 30_000, label: "the ChatGPT power control" },
    ).catch(() => {
      throw errorWithCode("ui_contract_mismatch", "Expected the ChatGPT power control.");
    });
    const menu = await openPowerMenu(powerButton);
    let normalizedMenuText = textOf(menu).replace(/\s+/g, " ").trim();
    if (!normalizedMenuText.includes(`Effort ${contract.effort_label}`)) {
      normalizedMenuText = await selectEffort(menu, contract.effort_label);
    }
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    if (powerButton.getAttribute("aria-expanded") === "true") powerButton.click();
    if (!normalizedMenuText.includes(contract.model_label)) throw errorWithCode("ui_contract_mismatch", `Expected model ${contract.model_label}; visible menu was ${normalizedMenuText.slice(0, 300)}.`);
    if (!normalizedMenuText.includes(`Effort ${contract.effort_label}`)) throw errorWithCode("ui_contract_mismatch", `Expected effort ${contract.effort_label}; visible menu was ${normalizedMenuText.slice(0, 300)}.`);
    return {
      account_plan: contract.account_plan,
      model_label: contract.model_label,
      effort_label: contract.effort_label,
      verified_at: new Date().toISOString(),
    };
  }

  function setComposerValue(element, value, { preserveImageMode = false } = {}) {
    element.focus();
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      setter?.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    if (preserveImageMode) {
      const pill = imageModePill();
      if (!pill || !element.contains(pill)) throw errorWithCode("ui_contract_mismatch", "ChatGPT Create image mode disappeared before prompt submission.");
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand("insertText", false, value);
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      return;
    }
    element.textContent = "";
    document.execCommand("insertText", false, value);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  }

  function base64Bytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function attachReferences(job) {
    if (!job.references?.length) return;
    await chrome.runtime.sendMessage({ type: "GOLDFLOW_PHASE", phase: "attaching_references" }).catch(() => {});
    const existingAttachmentCount = document.querySelectorAll('button[aria-label^="Remove file"]').length;
    const input = await waitFor(() => document.querySelector('#upload-files, #upload-photos, input[data-testid="upload-photos-input"], input[type="file"][accept*="image"]'), { timeoutMs: 30_000, label: "the ChatGPT image upload input" });
    const transfer = new DataTransfer();
    for (const reference of job.references) {
      const response = await chrome.runtime.sendMessage({ type: "GOLDFLOW_FETCH_REFERENCE", route: reference.url });
      if (!response?.ok || !response.value?.base64) {
        throw errorWithCode("reference_download_failed", `Reference ${reference.ref_id} could not be retrieved by the Goldflow extension worker: ${response?.error ?? "empty response"}.`);
      }
      const blob = new Blob([base64Bytes(response.value.base64)], { type: response.value.mimeType || "application/octet-stream" });
      transfer.items.add(new File([blob], `${String(reference.slot).padStart(2, "0")}-${reference.ref_id}.${blob.type.includes("png") ? "png" : blob.type.includes("webp") ? "webp" : "jpg"}`, { type: blob.type }));
    }
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    await waitFor(() => {
      const attached = document.querySelectorAll('button[aria-label^="Remove file"]').length;
      return attached >= existingAttachmentCount + job.references.length;
    }, { timeoutMs: 30_000, intervalMs: 250, label: `${job.references.length} attached ChatGPT reference image(s)` });
    await chrome.runtime.sendMessage({ type: "GOLDFLOW_PHASE", phase: "references_attached" }).catch(() => {});
    detectBlockingAlert();
  }

  async function submitPrompt(prompt, { preserveImageMode = false } = {}) {
    const target = await waitFor(() => composer(), { timeoutMs: 30_000, label: "the ChatGPT composer" });
    setComposerValue(target, prompt, { preserveImageMode });
    const button = await waitFor(() => {
      const candidate = sendButton();
      return candidate && !candidate.disabled && visible(candidate) ? candidate : null;
    }, { timeoutMs: 30_000, label: "an enabled send button" });
    await chrome.runtime.sendMessage({ type: "GOLDFLOW_PHASE", phase: "submitting" }).catch(() => {});
    button.click();
    await chrome.runtime.sendMessage({ type: "GOLDFLOW_PHASE", phase: "submitted" }).catch(() => {});
  }

  function responseText(turn) {
    const preferred = turn.querySelector('.markdown, [class*="markdown"], [data-message-content]');
    return textOf(preferred || turn);
  }

  function generationActive() {
    return [...document.querySelectorAll("button")].some((button) => visible(button) && /stop generating|stop response/i.test(`${button.getAttribute("aria-label") ?? ""} ${textOf(button)}`));
  }

  async function waitForAssistant(startCount, resume) {
    let lastText = "";
    let stableSince = 0;
    return waitFor(() => {
      const turns = assistantTurns();
      if (turns.length <= (resume ? 0 : startCount)) return null;
      const content = responseText(turns.at(-1));
      if (!content || generationActive()) {
        lastText = content;
        stableSince = Date.now();
        return null;
      }
      if (content !== lastText) {
        lastText = content;
        stableSince = Date.now();
        return null;
      }
      return Date.now() - stableSince >= 1800 ? content : null;
    }, { timeoutMs: 45 * 60_000, intervalMs: 500, label: "a completed ChatGPT response" });
  }

  async function waitForGeneratedImage(baselineUrls, resume, startAssistantCount = 0) {
    return waitFor(() => {
      const candidate = generatedImages().find((image) => resume || !baselineUrls.has(image.currentSrc || image.src));
      const url = candidate?.currentSrc || candidate?.src;
      if (/^https:\/\/chatgpt\.com\//.test(url ?? "")) return url;
      const turns = assistantTurns();
      if (turns.length > startAssistantCount) {
        const response = responseText(turns.at(-1));
        if (/please upload|upload (?:the |your )?(?:visual |image )?reference|attach(?:ed)? (?:the |your )?(?:visual |image )?reference|need (?:the |your )?(?:visual |image )?reference|cannot generate|can't generate|unable to complete (?:the )?image generation|image tool incorrectly treated|image generation failed|failed to generate|clarif/i.test(response)) {
          throw errorWithCode("chatgpt_image_refusal", response.slice(0, 600));
        }
      }
      return null;
    }, { timeoutMs: 45 * 60_000, intervalMs: 750, label: "a generated ChatGPT image" });
  }

  async function runJob(message, resume = false) {
    const { job, uiContract, connection } = message;
    const verifiedContract = await verifyUiContract(uiContract);
    if (job.type === "image") {
      const baselineUrls = new Set(generatedImages().map((image) => image.currentSrc || image.src));
      const startAssistantCount = assistantTurns().length;
      if (!resume) {
        await selectImageMode();
        await attachReferences(job);
        const referenceInstruction = job.references?.length
          ? "Use attached images only as ordered visual references."
          : "No reference images are attached. Generate directly from the text prompt; do not ask for uploads or clarification.";
        const prompt = [
          "Create exactly one original landscape image in a 16:9 frame.",
          `${referenceInstruction} Do not create a collage, contact sheet, explanation, or multiple variants. Do not add borders.`,
          job.prompt,
        ].join("\n\n");
        await submitPrompt(prompt, { preserveImageMode: true });
      }
      return { imageUrl: await waitForGeneratedImage(baselineUrls, resume, resume ? 0 : startAssistantCount), conversationUrl: location.href, uiContract: verifiedContract };
    }
    const startCount = assistantTurns().length;
    if (!resume) await submitPrompt(job.prompt);
    return { content: await waitForAssistant(startCount, resume), conversationUrl: location.href, uiContract: verifiedContract };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "GOLDFLOW_PING") {
      sendResponse({ ready: true });
      return;
    }
    if (message?.type !== "GOLDFLOW_RUN_JOB" && message?.type !== "GOLDFLOW_RESUME_JOB") return;
    runJob(message, message.type === "GOLDFLOW_RESUME_JOB")
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: { code: error.code ?? "browser_worker_failure", message: error.message } }));
    return true;
  });
})();
