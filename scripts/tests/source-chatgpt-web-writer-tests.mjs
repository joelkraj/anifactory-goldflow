#!/usr/bin/env node
// No-browser tests for the opt-in ChatGPT Web writer transport in the single-draft flow:
// `--transport chatgpt_web --writer-model gpt-6-astra [--writer-fallback <cli-model>]`.
// Every model call goes through an injected executor that mimics the runner's receipts.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "goldflow-web-writer-"));
process.env.ANIFACTORY_DATA_ROOT = path.join(tmpRoot, "data");
process.env.GOLDFLOW_CHATGPT_WEB_RUNTIME_ROOT = path.join(tmpRoot, "runtime");

const manufacturer = await import("../source-script-manufacturer.mjs");
const lockModule = await import("../lib/source-model-lock.mjs");
const { validateManufacturingPortfolio } = await import("../lib/source-manufacturer-contract.mjs");
const { chatGptModelLabel } = await import("../../apps/goldflow-studio/lib/chatgpt-ui-contract.mjs");
const { REVISION_DIMENSIONS } = await import("../lib/source-revision-contract.mjs");

// The production cooldown floor is 60 s; the test injects a short, recorded wait.
const waits = [];
manufacturer.setWriterTransportTimingForTests({ cooldownMs: 50, sleep: async (ms) => { waits.push(ms); await new Promise((resolve) => setTimeout(resolve, ms)); } });
const { CHATGPT_WEB_THROTTLE_COOLDOWN_MS } = await import("../lib/chatgpt-web-throttle-state.mjs");
assert.ok(CHATGPT_WEB_THROTTLE_COOLDOWN_MS >= 60_000, "production resubmits wait at least the shared one-minute floor");
const sha = (value) => createHash("sha256").update(String(value)).digest("hex");
const story = (label, count) => Array.from({ length: count }, (_, index) => `${label}${index % 50 === 0 ? "." : ""}`).join(" ");
const DRAFT = `Joey watched his fiancee sign away his class at the altar. ${story("draft", 1_999)}`;
const REVISION = `Joey watched his fiancee sign away his class at the altar while the hall cheered. ${story("revised", 2_050)}`;
const STAGE = "winner_source_script_v3_draft_56_1";

// Scripted writer outcomes per call: "pass", "throttle", "fail". Other stages always pass.
let writerPlan = [];
let calls = [];
manufacturer.setModelExecutorForTests(async ({ prompt, stageName, outputPath, provider, model, reasoningEffort }) => {
  calls.push({ stageName, provider, model, effort: reasoningEffort });
  const outcome = stageName === STAGE ? writerPlan.shift() ?? "pass" : "pass";
  await mkdir(path.dirname(outputPath), { recursive: true });
  const base = { provider, model, reasoning_effort: reasoningEffort, stage_name: stageName, prompt_sha256: sha(prompt), started_at: "2026-10-20T10:00:00.000Z" };
  if (outcome !== "pass") {
    // The real runner leaves a failed receipt and no output.
    const error = outcome === "throttle"
      ? Object.assign(new Error("Local ChatGPT Web Studio request failed (429): ChatGPT rate limit: wait before retrying."), { code: "rate_limited" })
      : Object.assign(new Error("Local ChatGPT Web Studio request failed (503): ChatGPT worker transport failed."), { code: "chatgpt_generation_error" });
    await writeFile(`${outputPath}.meta.json`, `${JSON.stringify({ ...base, status: "failed", error_code: error.code, error: error.message }, null, 2)}\n`);
    throw error;
  }
  const content = responder(stageName, prompt);
  await writeFile(outputPath, content);
  const metadata = { ...base, status: "passed", output_sha256: sha(content), completed_at: "2026-10-20T10:05:00.000Z" };
  await writeFile(`${outputPath}.meta.json`, `${JSON.stringify(metadata, null, 2)}\n`);
  return { content, ...metadata };
});

function notesFor(script) {
  const anchor = script.split(/\s+/).slice(0, 8).join(" ");
  return JSON.stringify({
    schema: "goldflow_manhwa_revision_notes_v1",
    dimension_review: Object.fromEntries(REVISION_DIMENSIONS.map((dimension) => [dimension, { status: "issues", summary: `${dimension} reviewed.` }])),
    notes: [{ id: "n01", dimension: "opening_deadlines", severity: "material", anchor, problem: "The low status lands late.", direction: "Make the loss immediate." }],
    keep: ["the altar betrayal"],
    summary: "Fix the opening.",
  });
}
function verdict() {
  return `\`\`\`json\n${JSON.stringify({
    schema: "goldflow_manhwa_revision_verdict_v1",
    decision: "keep_revision",
    dimension_comparison: Object.fromEntries(REVISION_DIMENSIONS.map((dimension) => [dimension, { better: "revision", reason: "Compared both." }])),
    notes_addressed: [{ note_id: "n01", status: "addressed" }],
    regressions: [],
    remaining_material_issues: [],
    reasons: "Fixture verify kept the revision.",
  })}\n\`\`\``;
}
const topTitle = "My Fiancee Sold My SSS Class, So I Bought Her Whole Guild";
const titles = [topTitle, ...Array.from({ length: 29 }, (_, index) => `Original premise title ${index + 2}`)];
function shortlistJson() {
  return JSON.stringify({
    schema: "goldflow_manhwa_topic_shortlist_v1",
    status: "shortlisted",
    title_selection_policy: "story_led_hooks_v1",
    rankings: titles.slice(0, 10).map((title, index) => ({
      rank: index + 1, candidate_number: index + 1, title,
      hook_contract: { primary_hook: "class theft", hook_phrase: title.split(" ").slice(0, 3).join(" "), payoff_phrase: title.split(" ").slice(-3).join(" "), why_this_hook: "Theft is clearer than rank.",
        story_support: [{ title_phrase: title.split(" ").slice(0, 3).join(" "), evidence: "Altar scene." }, { title_phrase: title.split(" ").slice(-3).join(" "), evidence: "Guild purchase." }] },
      core_premise: `Premise ${index + 1}: Joey's fiancee sells his class and he buys her guild.`,
      opening_target: "Joey watches the class transfer at the altar.",
      demand_transfer: "Betrayal then ownership reversal.",
      why_it_can_win: "Instant betrayal with a concrete ownership payoff.",
      complexity_risk: "low",
      genre_elements: ["betrayal", "ownership revenge"],
      reference_outlier: { title: "Reborn to Reject My Cheating Fiancee", url: "https://www.youtube.com/watch?v=fixture" },
    })),
  });
}
function fillerFrom(prompt) {
  const template = prompt.split("OPERATOR TEMPLATE\n").pop();
  const brief = JSON.parse(prompt.match(/PREMISE BRIEF\n([\s\S]*?)\n\nOPERATOR TEMPLATE/)[1]);
  return template
    .replaceAll("[WORD COUNT]", String(brief.target_word_count))
    .replaceAll("[TITLE]", brief.title)
    .replaceAll("[CORE PREMISE]", brief.core_premise)
    .replaceAll(/\[[A-Z][A-Z0-9 ,/'-]{2,}\]/g, "a concrete story-specific answer");
}
function responder(stageName, prompt) {
  if (stageName === "winner_source_premise_manufacturing_pool") return titles.map((title, index) => `${index + 1}. ${title}`).join("\n");
  if (stageName === "winner_source_premise_manufacturing_shortlist") return shortlistJson();
  if (stageName === "winner_source_script_manufacturing_prompt") return fillerFrom(prompt);
  if (stageName === STAGE) return DRAFT;
  if (stageName.startsWith("winner_source_script_revision_diagnose")) return notesFor(prompt.split("EXACT NARRATION\n").pop());
  if (stageName.startsWith("winner_source_script_revision_rewrite")) return REVISION;
  if (stageName.startsWith("winner_source_script_revision_verify")) return verdict();
  throw new Error(`Unexpected stage ${stageName}`);
}

const evidenceText = "Measured own-channel winner: My Wife Sold My Class... 41% APV.\nExternal outlier: Reborn to Reject My Cheating Fiancee https://www.youtube.com/watch?v=fixture";
async function newDirectory(name) {
  const directory = path.join(tmpRoot, "channels", "53rebirth", "source_development", name);
  await mkdir(directory, { recursive: true });
  const evidencePath = path.join(directory, "evidence.md");
  await writeFile(evidencePath, evidenceText);
  return { directory, evidencePath };
}
const writerCalls = () => calls.filter((call) => call.stageName === STAGE);
const ledger = async (directory) => JSON.parse(await readFile(path.join(directory, "manufactured_drafts", "writer_transport_ledger.json"), "utf8"));
const lockOf = async (directory) => JSON.parse(await readFile(path.join(directory, "manufacturing_model_lock.json"), "utf8"));
const portfolioOf = async (directory) => JSON.parse(await readFile(path.join(directory, "manufacturing_portfolio.json"), "utf8"));

// --- picker label and lock contract ----------------------------------------------------
{
  assert.equal(chatGptModelLabel("gpt-6-astra"), "GPT-6", "label read from the live Studio picker on 2026-10-20");
  assert.throws(() => chatGptModelLabel("gpt-6.1-sol"), /Unsupported ChatGPT Web model/, "no 6.1 Sol label exists in the web picker");
  assert.deepEqual(lockModule.SUPPORTED_SOURCE_MODELS.chatgpt_web, ["gpt-6-astra"]);
  assert.equal(lockModule.providerForSourceModel("gpt-6-astra"), "chatgpt_web");
  const roles = lockModule.requestedModelLock({ "writer-model": "gpt-6-astra" });
  assert.deepEqual(roles.writer, { provider: "chatgpt_web", model: "gpt-6-astra", reasoning_effort: "max" });
  assert.equal(roles.planning.provider, "codex_cli", "planning stays on the CLI default");
  assert.throws(() => lockModule.requestedModelLock({ "planning-model": "gpt-6-astra" }), /draft only/);
  assert.throws(() => lockModule.requestedModelLock({ "revision-model": "gpt-6-astra" }), /draft only/);
  assert.deepEqual(lockModule.requestedWriterFallback({ "writer-fallback": "claude-fable-5-1" }, roles), { provider: "claude_cli", model: "claude-fable-5-1", reasoning_effort: "max" });
  assert.equal(lockModule.requestedWriterFallback({}, roles), null);
  assert.throws(() => lockModule.requestedWriterFallback({ "writer-fallback": "gpt-6-astra" }, roles), /must name a CLI model/);
  assert.throws(() => lockModule.requestedWriterFallback({ "writer-fallback": "claude-fable-5-1" }, lockModule.requestedModelLock({})), /applies only to a ChatGPT Web writer/);
  const lock = { schema: lockModule.MANUFACTURING_MODEL_LOCK_SCHEMA, roles, writer_fallback: { provider: "claude_cli", model: "claude-fable-5-1", reasoning_effort: "max" } };
  assert.equal(lockModule.validateModelLock(lock).done, true);
  assert.ok(lockModule.validateModelLock({ ...lock, writer_fallback: { provider: "chatgpt_web", model: "gpt-6-astra", reasoning_effort: "max" } }).blockers.includes("model_lock_writer_fallback_not_cli"));
  assert.ok(lockModule.validateModelLock({ ...lock, roles: lockModule.requestedModelLock({}) }).blockers.includes("model_lock_writer_fallback_without_browser_writer"));
  assert.deepEqual(lockModule.modelLockConflicts(lock, { "writer-fallback": "claude-opus-5-5" }), ["writer_fallback"]);
  assert.deepEqual(lockModule.modelLockConflicts(lock, { "writer-fallback": "claude-fable-5-1", "writer-model": "gpt-6-astra" }), []);
  // Historical locks that recorded the retired gpt-6-sol browser writer still validate.
  assert.equal(lockModule.validateModelLock({ schema: lockModule.MANUFACTURING_MODEL_LOCK_SCHEMA, roles: { ...roles, writer: { provider: "chatgpt_web", model: "gpt-6-sol", reasoning_effort: "max" } } }).done, true);
  assert.ok(manufacturer.isWriterThrottleError(Object.assign(new Error("x"), { code: "rate_limited" })));
  assert.ok(manufacturer.isWriterThrottleError(new Error("ChatGPT Web cooldown active for 400 more seconds before planner draft")));
  assert.ok(!manufacturer.isWriterThrottleError(Object.assign(new Error("ChatGPT worker transport failed."), { code: "chatgpt_generation_error" })));
}

// --- the browser writer needs the explicit transport flag ---------------------------------
{
  const { directory, evidencePath } = await newDirectory("no-transport");
  calls = [];
  await manufacturer.ideateTopics(directory, { evidence: evidencePath, "writer-model": "gpt-6-astra" });
  await assert.rejects(manufacturer.writeCandidates(directory, { "writer-model": "gpt-6-astra" }), /--transport chatgpt_web/);
  assert.equal(writerCalls().length, 0, "no browser submission without the flag");
}

manufacturer.allowChatGptWebTransport(true);
try {
  // --- clean draft: same receipts, lock and hand-off as the CLI transports -------------------
  {
    const { directory, evidencePath } = await newDirectory("clean");
    calls = [];
    writerPlan = ["pass"];
    const result = await manufacturer.runSingleDraftFlow(directory, { evidence: evidencePath, "writer-model": "gpt-6-astra" });
    assert.deepEqual(writerCalls(), [{ stageName: STAGE, provider: "chatgpt_web", model: "gpt-6-astra", effort: "max" }], "exactly one Pro browser draft");
    assert.ok(calls.filter((call) => call.stageName !== STAGE).every((call) => call.provider === "codex_cli"), "ideation, filling and revision stay on the CLI");
    const lock = await lockOf(directory);
    assert.deepEqual(lock.roles.writer, { provider: "chatgpt_web", model: "gpt-6-astra", reasoning_effort: "max" });
    assert.equal(lock.writer_transport, "chatgpt_web");
    assert.equal(lock.writer_resubmit_policy, manufacturer.WRITER_TRANSPORT_POLICY);
    assert.equal(lock.writer_fallback, null, "no fallback unless --writer-fallback names one");
    const portfolio = await portfolioOf(directory);
    assert.equal(portfolio.model_lock_sha256, sha(await readFile(path.join(directory, "manufacturing_model_lock.json"))));
    const candidate = portfolio.candidates[0];
    assert.deepEqual([candidate.provider, candidate.model, candidate.writer_fallback_used, candidate.writer_transport_attempts, candidate.requested_writer], ["chatgpt_web", "gpt-6-astra", false, 1, null]);
    const receipt = JSON.parse(await readFile(candidate.receipt_path, "utf8"));
    assert.deepEqual([receipt.status, receipt.provider, receipt.model, receipt.reasoning_effort, receipt.stage_name], ["passed", "chatgpt_web", "gpt-6-astra", "max", STAGE]);
    assert.equal(candidate.receipt_sha256, sha(await readFile(candidate.receipt_path)));
    const attempts = (await ledger(directory)).attempts;
    assert.deepEqual(attempts.map((row) => [row.kind, row.provider, row.outcome]), [["submit", "chatgpt_web", "passed"]]);
    const handoff = JSON.parse(await readFile(result.source_handoff_path, "utf8"));
    assert.equal(handoff.schema, "goldflow_source_handoff_v1");
    assert.equal(handoff.model_lock_sha256, portfolio.model_lock_sha256, "the hand-off binds the lock that records the browser writer");
    assert.equal(handoff.sha256, result.final_script_sha256);
    assert.match(result.next_action, /run preflight/);
    calls = [];
    await manufacturer.writeCandidates(directory, { "writer-model": "gpt-6-astra" });
    assert.equal(calls.length, 0, "a completed browser portfolio reloads without new spend");
    await assert.rejects(manufacturer.writeCandidates(directory, { "writer-fallback": "claude-fable-5-1" }), /writer_fallback/, "adding a fallback later conflicts with the lock");
  }

  // --- one throttle: exactly one recorded resubmit after the cooldown -------------------------
  {
    const { directory, evidencePath } = await newDirectory("throttle-once");
    await manufacturer.ideateTopics(directory, { evidence: evidencePath, "writer-model": "gpt-6-astra" });
    calls = [];
    writerPlan = ["throttle", "pass"];
    waits.length = 0;
    const written = await manufacturer.writeCandidates(directory, { "writer-model": "gpt-6-astra" });
    assert.deepEqual(waits, [50], "the resubmit waits exactly one cooldown");
    assert.equal(writerCalls().length, 2, "one submit and one resubmit");
    assert.ok(writerCalls().every((call) => call.provider === "chatgpt_web" && call.model === "gpt-6-astra"));
    const attempts = (await ledger(directory)).attempts;
    assert.deepEqual(attempts.map((row) => [row.kind, row.outcome]), [["submit", "throttled"], ["cooldown", "waiting"], ["resubmit", "passed"]]);
    assert.equal(attempts[0].error_code, "rate_limited");
    assert.equal(attempts[1].cooldown_ms, 50);
    assert.match(attempts[0].archived_receipt_path, /failed_receipts\/draft_56_1\./, "the throttled receipt is archived, not overwritten");
    const archived = JSON.parse(await readFile(attempts[0].archived_receipt_path, "utf8"));
    assert.equal(archived.status, "failed");
    assert.deepEqual((await readdir(path.join(directory, "manufactured_drafts", "failed_receipts"))).length, 1);
    assert.equal(written.document.candidates[0].writer_transport_attempts, 2);
    assert.equal(written.document.candidates[0].writer_fallback_used, false);
    assert.equal(JSON.parse(await readFile(written.document.candidates[0].receipt_path, "utf8")).status, "passed");
  }

  // --- two throttles without a locked fallback: stop, no third submission ----------------------
  {
    const { directory, evidencePath } = await newDirectory("throttle-twice");
    await manufacturer.ideateTopics(directory, { evidence: evidencePath, "writer-model": "gpt-6-astra" });
    calls = [];
    writerPlan = ["throttle", "throttle", "pass"];
    await assert.rejects(manufacturer.writeCandidates(directory, { "writer-model": "gpt-6-astra" }), /Manufacturing candidates incomplete: draft_56_1/);
    assert.equal(writerCalls().length, 2, "no creative retry loop: two browser attempts at most");
    const attempts = (await ledger(directory)).attempts;
    assert.deepEqual(attempts.map((row) => [row.kind, row.outcome]), [["submit", "throttled"], ["cooldown", "waiting"], ["resubmit", "throttled"], ["stop", "no_fallback_locked"]]);
    const failures = JSON.parse(await readFile(path.join(directory, "manufactured_drafts", "manufacturing_candidate_failures.json"), "utf8"));
    assert.match(failures.failures[0].error, /rate limit/);
    assert.equal(await readdir(path.join(directory, "manufactured_drafts")).then((names) => names.includes("draft_56_1.txt")), false, "no output without a passed receipt");
    assert.equal((await readdir(path.join(directory, "manufactured_drafts", "failed_receipts"))).length, 2);
  }

  // --- transport failure with a locked fallback: one CLI draft, same prompt and stage ---------
  {
    const { directory, evidencePath } = await newDirectory("fallback");
    calls = [];
    writerPlan = ["fail"];
    const flags = { evidence: evidencePath, "writer-model": "gpt-6-astra", "writer-fallback": "claude-fable-5-1" };
    const result = await manufacturer.runSingleDraftFlow(directory, flags);
    assert.deepEqual(writerCalls().map((call) => [call.provider, call.model, call.effort]), [["chatgpt_web", "gpt-6-astra", "max"], ["claude_cli", "claude-fable-5-1", "max"]], "a non-throttle failure goes straight to the locked fallback");
    const lock = await lockOf(directory);
    assert.deepEqual(lock.writer_fallback, { provider: "claude_cli", model: "claude-fable-5-1", reasoning_effort: "max" });
    const candidate = (await portfolioOf(directory)).candidates[0];
    assert.deepEqual([candidate.provider, candidate.model, candidate.writer_fallback_used, candidate.writer_transport_attempts], ["claude_cli", "claude-fable-5-1", true, 2]);
    assert.deepEqual(candidate.requested_writer, { provider: "chatgpt_web", model: "gpt-6-astra" });
    const receipt = JSON.parse(await readFile(candidate.receipt_path, "utf8"));
    assert.deepEqual([receipt.status, receipt.provider, receipt.model, receipt.stage_name], ["passed", "claude_cli", "claude-fable-5-1", STAGE]);
    const attempts = (await ledger(directory)).attempts;
    assert.deepEqual(attempts.map((row) => [row.kind, row.provider, row.outcome]), [["submit", "chatgpt_web", "failed"], ["fallback", "claude_cli", "passed"]]);
    assert.equal(attempts[0].error_code, "chatgpt_generation_error");
    assert.match(attempts[1].after_error, /transport failed/);
    assert.equal(attempts[0].prompt_sha256, attempts[1].prompt_sha256, "the fallback resubmits the identical prompt");
    assert.equal(attempts[0].prompt_sha256, candidate.prompt_sha256);
    const handoff = JSON.parse(await readFile(result.source_handoff_path, "utf8"));
    assert.equal(handoff.model_lock_sha256, sha(await readFile(path.join(directory, "manufacturing_model_lock.json"))));
    calls = [];
    const reloaded = await manufacturer.writeCandidates(directory, { "writer-model": "gpt-6-astra", "writer-fallback": "claude-fable-5-1" });
    assert.equal(calls.length, 0, "a fallback-written portfolio validates against the lock on reload");
    assert.equal(reloaded.document.candidates[0].provider, "claude_cli");
    // Contract: a fallback row is accepted only when it names the requested browser writer.
    const spec = { id: "draft_56_1", provider: "chatgpt_web", model: "gpt-6-astra", fallback: { provider: "claude_cli", model: "claude-fable-5-1" } };
    assert.equal(validateManufacturingPortfolio(reloaded.document, { expectedCandidates: [spec] }).done, true);
    const unflagged = { ...reloaded.document, candidates: [{ ...candidate, writer_fallback_used: false }] };
    assert.ok(validateManufacturingPortfolio(unflagged, { expectedCandidates: [spec] }).blockers.includes("manufacturing_portfolio_draft_56_1_model_contract_mismatch"));
    assert.ok(validateManufacturingPortfolio(reloaded.document, { expectedCandidates: [{ ...spec, fallback: undefined }] }).blockers.includes("manufacturing_portfolio_draft_56_1_model_contract_mismatch"));
  }

  // --- throttle twice, then the locked fallback -----------------------------------------------
  {
    const { directory, evidencePath } = await newDirectory("throttle-then-fallback");
    await manufacturer.ideateTopics(directory, { evidence: evidencePath, "writer-model": "gpt-6-astra", "writer-fallback": "claude-opus-5-5" });
    calls = [];
    writerPlan = ["throttle", "throttle", "pass"];
    const written = await manufacturer.writeCandidates(directory, { "writer-model": "gpt-6-astra", "writer-fallback": "claude-opus-5-5" });
    assert.deepEqual(writerCalls().map((call) => call.provider), ["chatgpt_web", "chatgpt_web", "claude_cli"]);
    assert.deepEqual((await ledger(directory)).attempts.map((row) => row.kind), ["submit", "cooldown", "resubmit", "fallback"]);
    assert.deepEqual([written.document.candidates[0].model, written.document.candidates[0].writer_transport_attempts], ["claude-opus-5-5", 3]);
  }

  // --- a failing fallback stops too; the CLI writer path is untouched --------------------------
  {
    const { directory, evidencePath } = await newDirectory("fallback-fails");
    await manufacturer.ideateTopics(directory, { evidence: evidencePath, "writer-model": "gpt-6-astra", "writer-fallback": "claude-fable-5-1" });
    calls = [];
    writerPlan = ["fail", "fail"];
    await assert.rejects(manufacturer.writeCandidates(directory, { "writer-model": "gpt-6-astra", "writer-fallback": "claude-fable-5-1" }), /incomplete/);
    assert.equal(writerCalls().length, 2);
    assert.deepEqual((await ledger(directory)).attempts.map((row) => [row.kind, row.outcome]), [["submit", "failed"], ["fallback", "failed"]]);

    const cli = await newDirectory("cli-unchanged");
    await manufacturer.ideateTopics(cli.directory, { evidence: cli.evidencePath });
    calls = [];
    writerPlan = ["fail", "pass"];
    await assert.rejects(manufacturer.writeCandidates(cli.directory, {}), /incomplete/);
    assert.equal(writerCalls().length, 1, "CLI writers keep their no-retry contract");
    assert.equal(await readdir(path.join(cli.directory, "manufactured_drafts")).then((names) => names.includes("writer_transport_ledger.json")), false, "no browser ledger for a CLI writer");
  }
} finally {
  manufacturer.allowChatGptWebTransport(false);
}

await rm(tmpRoot, { recursive: true, force: true });
console.log("source chatgpt web writer tests passed");
