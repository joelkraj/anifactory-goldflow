import assert from "node:assert/strict";
import { GoogleFlowBrowser, waitForFlowModelSelection } from "../desktop/google-flow-browser.mjs";

let reads = 0;
const settled = await waitForFlowModelSelection(async () => ({
  async innerText() { return ++reads < 3 ? "🍌 Nano Banana 2" : "🍌 Nano Banana Pro"; },
}), "Nano Banana Pro", { timeoutMs: 100, pollMs: 1 });
assert.equal(settled.text, "🍌 Nano Banana Pro");
assert.equal(reads, 4, "A delayed update must settle across two matching observations");
let flicker = 0;
assert.equal(await waitForFlowModelSelection(async () => ({
  async innerText() { return ++flicker % 2 ? "Nano Banana Pro" : "Nano Banana 2"; },
}), "Nano Banana Pro", { timeoutMs: 20, pollMs: 1 }), null, "A transient matching label cannot pass");
assert.equal(await waitForFlowModelSelection(async () => ({ async innerText() { return "Nano Banana 2"; } }), "Nano Banana Pro", { timeoutMs: 10, pollMs: 1 }), null, "The persistent wrong model remains blocked");
assert.equal(await waitForFlowModelSelection(async () => null, "Nano Banana Pro", { timeoutMs: 10, pollMs: 1 }), null, "Missing controls cannot pass");

function delayedFlowFixture({ overlay, ratio = "16:9", count = "x1" }) {
  const state = { settingsOpen: false, menuOpen: false, pending: false, selected: false, reads: 0, selections: 0, escaped: 0, postCloseHiddenReads: 0 };
  const controlText = () => {
    if (state.pending && ++state.reads >= 3) { state.pending = false; state.selected = true; }
    return `🍌 Nano Banana ${state.selected ? "Pro" : "2"}`;
  };
  const element = (id, role, name, text, click = async () => {}) => ({ id, role, name, innerText: async () => typeof text === "function" ? text() : text, click, isVisible: async () => true });
  const controls = () => {
    const out = [];
    const composerText = () => `${controlText()} ${ratio} ${count}`;
    // Simulate a detached/replaced composer after closing the settings surface.
    const hideComposer = state.escaped && state.postCloseHiddenReads++ === 0;
    if (overlay && !hideComposer) out.push(element("composer", "button", "Settings trigger", composerText, async () => { state.settingsOpen = true; }));
    if (!overlay && !state.settingsOpen && !hideComposer) out.push(element("composer", "button", `🍌 Nano Banana ${state.selected ? "Pro" : "2"} ${ratio} ${count}`, composerText, async () => { state.settingsOpen = true; }));
    if (state.settingsOpen) {
      for (const label of ["Image", "16:9", "x1"]) out.push(element(label, overlay ? "radio" : "tab", label, label));
      out.push(element("family", "button", overlay ? "Select model family" : `🍌 Nano Banana ${state.selected ? "Pro" : "2"}`, controlText, async () => { state.menuOpen = true; }));
      out.push(element("settings", "menu", "", "Image 16:9 x1"));
    }
    if (state.menuOpen) out.push(element("wanted", "menuitem", "🍌 Nano Banana Pro", "🍌 Nano Banana Pro", async () => {
      state.selections += 1; state.pending = true; state.menuOpen = false;
    }));
    return out;
  };
  const matches = (value, condition) => condition instanceof RegExp ? condition.test(value) : condition == null || value === condition;
  const locator = (find) => ({
    async count() { return find().length; },
    nth(index) { return locator(() => find().slice(index, index + 1)); },
    async isVisible() { return find().length > 0; },
    async innerText() { const row = find()[0]; if (!row) throw new Error("detached"); return row.innerText(); },
    async click() { const row = find()[0]; assert(row); return row.click(); },
    filter({ hasText }) { return locator(() => find().filter((row) => matches(row.name || (row.id === "settings" ? "Image 16:9 x1" : ""), hasText))); },
    getByRole(role, options = {}) { return locator(() => controls().filter((row) => row.role === role && matches(row.name, options.name))); },
  });
  const page = {
    getByRole(role, options = {}) { return locator(() => controls().filter((row) => row.role === role && matches(row.name, options.name))); },
    locator(selector) { if (selector === "body") return { innerText: async () => "ULTRA" }; return locator(() => controls().filter((row) => row.role === "button")); },
    keyboard: { async press(key) {
      assert.equal(key, "Escape");
      assert(state.selected, "Escape before the committed model update would cancel this selection");
      state.escaped += 1; state.settingsOpen = false; state.menuOpen = false;
    } },
  };
  return { page, state };
}

for (const overlay of [true, false]) {
  const { page, state } = delayedFlowFixture({ overlay });
  const browser = new GoogleFlowBrowser({ flowPlanLabel: "ULTRA", flowModelLabel: "Nano Banana Pro" });
  browser.diagnostics = async () => null;
  const contract = await browser.verifyUiContract(page);
  assert.equal(contract.model_label, "Nano Banana Pro");
  assert.equal(contract.aspect_ratio, "16:9");
  assert.equal(contract.output_count, 1);
  assert.equal(state.selections, 1, "Exactly one model selection, with no transport or creative retry");
  assert.equal(state.escaped, 1, "Settings close only after the model update commits");
}
const wrongSettings = delayedFlowFixture({ overlay: true, ratio: "9:16", count: "x2" });
const browser = new GoogleFlowBrowser({ flowPlanLabel: "ULTRA", flowModelLabel: "Nano Banana Pro" });
browser.diagnostics = async () => null;
await assert.rejects(browser.verifyUiContract(wrongSettings.page), /did not retain 16:9 x1/, "Waiting for a model cannot waive the aspect/count contract");
console.log("PASS Flow delayed model selection and unchanged contract guards");
