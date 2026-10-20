#!/usr/bin/env node
// No-network tests for the single-draft source flow: auto-title, one Pro draft, and the
// diagnose/revise/verify loop. Every model call goes through an injected executor.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "goldflow-single-draft-"));
process.env.ANIFACTORY_DATA_ROOT = path.join(tmpRoot, "data");

const manufacturer = await import("../source-script-manufacturer.mjs");
const { sourceWriterPolicy } = await import("../lib/source-writer-policy.mjs");
const {
  REVISION_DIMENSIONS,
  autoTitleBrief,
  decideRevisionRound,
  openingDeadlineWindows,
  validateRevisionNotes,
} = await import("../lib/source-revision-contract.mjs");
const { validateManufacturingBrief } = await import("../lib/source-manufacturer-contract.mjs");

const sha = (value) => createHash("sha256").update(String(value)).digest("hex");
const story = (label, count) => Array.from({ length: count }, (_, index) => `${label}${index % 50 === 0 ? "." : ""}`).join(" ");
const DRAFT = `Joey watched his fiancee sign away his class at the altar. ${story("draft", 1_999)}`;
const REVISION_1 = `Joey watched his fiancee sign away his class at the altar while the hall cheered. ${story("revisedone", 2_050)}`;
const REVISION_2 = `Joey watched his fiancee sign away his class at the altar, and the buyer laughed. ${story("revisedtwo", 2_080)}`;

let calls = [];
let responder = () => { throw new Error("No responder configured."); };

manufacturer.setModelExecutorForTests(async ({ prompt, stageName, outputPath, provider, model, reasoningEffort }) => {
  calls.push({ stageName, provider, model, effort: reasoningEffort, prompt });
  const content = await responder(stageName, prompt);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content);
  const metadata = {
    status: "passed",
    provider,
    model,
    reasoning_effort: reasoningEffort,
    stage_name: stageName,
    prompt_sha256: sha(prompt),
    output_sha256: sha(content),
    started_at: "2026-10-20T10:00:00.000Z",
    completed_at: "2026-10-20T10:05:00.000Z",
  };
  await writeFile(`${outputPath}.meta.json`, `${JSON.stringify(metadata, null, 2)}\n`);
  return { content, ...metadata };
});

function notesFor(script, { material = true, empty = false } = {}) {
  const anchor = script.split(/\s+/).slice(0, 8).join(" ");
  return JSON.stringify({
    schema: "goldflow_manhwa_revision_notes_v1",
    dimension_review: Object.fromEntries(REVISION_DIMENSIONS.map((dimension) => [dimension, { status: empty ? "ok" : "issues", summary: `${dimension} reviewed.` }])),
    notes: empty ? [] : [
      { id: "n01", dimension: "opening_deadlines", severity: material ? "material" : "minor", anchor, problem: "The low status lands late.", direction: "Make the class loss cost him his job immediately." },
      { id: "n02", dimension: "cold_viewer_explanation", severity: "minor", anchor, problem: "The class system is undefined.", direction: "Explain classes once in plain words." },
    ],
    keep: ["the altar betrayal"],
    summary: "Fix the opening and explain classes.",
  });
}

function verdict(decision, remaining = []) {
  return `\`\`\`json\n${JSON.stringify({
    schema: "goldflow_manhwa_revision_verdict_v1",
    decision,
    dimension_comparison: Object.fromEntries(REVISION_DIMENSIONS.map((dimension) => [dimension, { better: decision === "keep_revision" ? "revision" : "incumbent", reason: "Compared both." }])),
    notes_addressed: [{ note_id: "n01", status: "addressed" }, { note_id: "n02", status: "partial" }],
    regressions: decision === "revert" ? ["The climax became a summary."] : [],
    remaining_material_issues: remaining.map((problem) => ({ dimension: "payoff", anchor: "Joey watched his fiancee", problem })),
    reasons: `Fixture verify decided ${decision}.`,
  })}\n\`\`\``;
}

function scriptFromPrompt(prompt) {
  return prompt.split("EXACT NARRATION\n").pop() ?? prompt.split("EXACT INCUMBENT NARRATION\n").pop();
}

// Rounds are scripted per test: each entry gives the revise output and the verify response.
function loopResponder(rounds, { emptyNotes = false } = {}) {
  return (stageName, prompt) => {
    const round = Number(stageName.match(/_r(\d+)$/)?.[1] ?? 0);
    const plan = rounds[round - 1];
    if (stageName.startsWith("winner_source_script_revision_diagnose")) return notesFor(scriptFromPrompt(prompt), { empty: emptyNotes });
    if (stageName.startsWith("winner_source_script_revision_rewrite")) return plan.revision;
    if (stageName.startsWith("winner_source_script_revision_verify")) return verdict(...plan.verify);
    throw new Error(`Unexpected stage ${stageName}`);
  };
}

async function newDirectory(name) {
  const directory = path.join(tmpRoot, "channels", "53rebirth", "source_development", name);
  await mkdir(directory, { recursive: true });
  return directory;
}

async function seedSingleDraft(directory) {
  const draftPath = path.join(directory, "manufactured_drafts", "draft_56_1.txt");
  await mkdir(path.dirname(draftPath), { recursive: true });
  await writeFile(draftPath, DRAFT);
  await writeFile(path.join(directory, "manufacturing_portfolio.json"), JSON.stringify({
    schema: "goldflow_manhwa_manufacturing_portfolio_v1",
    status: "completed",
    writer_policy: "single_6_sol_pro_v1",
    candidates: [{ id: "draft_56_1", blind_id: "candidate_a", model: "gpt-6-sol", provider: "chatgpt_web", output_path: draftPath, output_sha256: sha(DRAFT) }],
  }));
  return draftPath;
}

const evidenceText = "Measured own-channel winner: My Wife Sold My Class... 41% APV.\nExternal outlier: Reborn to Reject My Cheating Fiancee https://www.youtube.com/watch?v=fixture";
const topTitle = "My Fiancee Sold My SSS Class, So I Bought Her Whole Guild";
const titles = [topTitle, ...Array.from({ length: 29 }, (_, index) => `Original premise title ${index + 2}`)];

function shortlistJson() {
  return JSON.stringify({
    schema: "goldflow_manhwa_topic_shortlist_v1",
    status: "shortlisted",
    title_selection_policy: "story_led_hooks_v1",
    rankings: titles.slice(0, 10).map((title, index) => {
      const hook = title.split(" ").slice(0, 3).join(" ");
      const payoff = title.split(" ").slice(-3).join(" ");
      return {
        rank: index + 1,
        candidate_number: index + 1,
        title,
        hook_contract: { primary_hook: "class theft", hook_phrase: hook, payoff_phrase: payoff, why_this_hook: "Theft is clearer than rank.",
          story_support: [{ title_phrase: hook, evidence: "Altar scene." }, { title_phrase: payoff, evidence: "Guild purchase." }] },
        core_premise: `Premise ${index + 1}: Joey's fiancee sells his class and he buys her guild.`,
        opening_target: "Joey watches the class transfer at the altar.",
        demand_transfer: "Betrayal then ownership reversal.",
        why_it_can_win: index === 0 ? "Instant betrayal with a concrete ownership payoff." : "Reasonable.",
        complexity_risk: "low",
        genre_elements: ["betrayal", "ownership revenge"],
        reference_outlier: { title: "Reborn to Reject My Cheating Fiancee", url: "https://www.youtube.com/watch?v=fixture" },
      };
    }),
  });
}

function fillerFrom(prompt) {
  const template = prompt.split("OPERATOR TEMPLATE\n").pop();
  const briefJson = prompt.match(/PREMISE BRIEF\n([\s\S]*?)\n\nOPERATOR TEMPLATE/)[1];
  const brief = JSON.parse(briefJson);
  return template
    .replaceAll("[WORD COUNT]", String(brief.target_word_count))
    .replaceAll("[TITLE]", brief.title)
    .replaceAll("[CORE PREMISE]", brief.core_premise)
    .replaceAll(/\[[A-Z][A-Z0-9 ,/'-]{2,}\]/g, "a concrete story-specific answer");
}

function fullRunResponder(rounds) {
  const loop = loopResponder(rounds);
  return (stageName, prompt) => {
    if (stageName === "winner_source_premise_manufacturing_pool") return titles.map((title, index) => `${index + 1}. ${title}`).join("\n");
    if (stageName === "winner_source_premise_manufacturing_shortlist") return shortlistJson();
    if (stageName === "winner_source_script_manufacturing_prompt") return fillerFrom(prompt);
    if (stageName.startsWith("winner_source_script_v3_")) return DRAFT;
    return loop(stageName, prompt);
  };
}

// --- contract units ---------------------------------------------------------------
{
  const windows = openingDeadlineWindows(story("w", 700));
  assert.deepEqual(windows.map((row) => [row.first_word, row.last_word]), [[1, 40], [41, 80], [81, 120], [121, 300], [301, 600]]);
  assert.equal(windows[0].text.split(" ").length, 40);
  assert.equal(validateRevisionNotes(JSON.parse(notesFor(DRAFT)), DRAFT).done, true);
  const misquoted = JSON.parse(notesFor(DRAFT));
  misquoted.notes = misquoted.notes.map((note) => ({ ...note, anchor: "words that never appear in the script" }));
  assert.ok(validateRevisionNotes(misquoted, DRAFT).blockers.includes("revision_notes_anchors_not_in_script"));
  const emptyWithIssues = { ...JSON.parse(notesFor(DRAFT)), notes: [] };
  assert.ok(validateRevisionNotes(emptyWithIssues, DRAFT).blockers.includes("revision_notes_empty"));
  assert.equal(validateRevisionNotes(JSON.parse(notesFor(DRAFT, { empty: true })), DRAFT).nothing_to_fix, true);
  const capped = decideRevisionRound({ verdict: { decision: "keep_revision", remaining_material_issues: [{}] }, length: { plausibly_complete: true }, round: 2, maxRounds: 9 });
  assert.equal(capped.next_round, false, "the hard cap is two rounds even when more are requested");
}

// --- historical writer policies stay readable ---------------------------------------
{
  assert.equal(sourceWriterPolicy().name, "single_6_sol_pro_v1");
  assert.deepEqual(sourceWriterPolicy().candidates.map((row) => [row.id, row.model, row.provider]), [["draft_56_1", "gpt-6.1-sol", "codex_cli"]]);
  const three = [1, 2, 3].map((n) => ({ id: `draft_56_${n}`, model: "gpt-6-sol" }));
  assert.equal(sourceWriterPolicy({ candidates: three }).name, "three_6_sol_pro_v1", "unlabelled three-draft portfolios keep the three-writer contract");
  assert.equal(sourceWriterPolicy({ candidates: three.map((row) => ({ ...row, model: "gpt-5.6-sol" })) }).name, "three_56_pro_v1");
  assert.equal(sourceWriterPolicy({ candidates: [...three, { id: "draft_55_1", model: "gpt-5.5" }] }).name, "six_dual_pro_v1");
  assert.equal(sourceWriterPolicy({ writer_policy: "three_6_sol_pro_v1" }).candidates.length, 3);
  assert.equal(sourceWriterPolicy({ writer_policy: "six_56_6_pro_v1" }).candidates.length, 6);
}

// --- auto-title -------------------------------------------------------------------
{
  const directory = await newDirectory("auto-title");
  const evidencePath = path.join(directory, "evidence.md");
  await writeFile(evidencePath, evidenceText);
  calls = [];
  responder = fullRunResponder([]);
  const result = await manufacturer.ideateTopics(directory, { evidence: evidencePath });
  assert.equal(calls.length, 2);
  assert.equal(result.brief.created, true);
  const brief = JSON.parse(await readFile(path.join(directory, "manufacturing_brief.json"), "utf8"));
  assert.equal(brief.status, "auto_selected");
  assert.equal(brief.title, topTitle, "rank one title is copied byte-for-byte");
  assert.equal(brief.core_premise, "Premise 1: Joey's fiancee sells his class and he buys her guild.");
  assert.equal(brief.selection_basis.rank, 1);
  assert.equal(brief.selection_basis.rationale, "Instant betrayal with a concrete ownership payoff.");
  assert.equal(brief.selection_basis.shortlist_sha256, sha(await readFile(path.join(directory, "manufacturing_topic_shortlist.json"))));
  assert.equal(brief.selection_basis.evidence_sha256, sha(evidenceText));
  assert.equal(brief.reference_outlier.url, "https://www.youtube.com/watch?v=fixture");
  assert.equal(validateManufacturingBrief(brief).done, true);
  assert.equal(brief.approved_by, undefined, "no operator approval is fabricated");
  const again = await manufacturer.autoSelectTitle(directory, {}, { shortlistPath: path.join(directory, "manufacturing_topic_shortlist.json") });
  assert.equal(again.created, false, "an existing brief is never replaced");
  assert.ok(validateManufacturingBrief({ ...brief, selection_basis: { ...brief.selection_basis, shortlist_sha256: "x" } }).blockers.includes("manufacturing_brief_selection_basis_incomplete"));
  assert.throws(() => autoTitleBrief({ rankings: [] }), /rank-one/);
}

// --- single write -------------------------------------------------------------------
{
  const directory = await newDirectory("single-write");
  const evidencePath = path.join(directory, "evidence.md");
  await writeFile(evidencePath, evidenceText);
  responder = fullRunResponder([]);
  await manufacturer.ideateTopics(directory, { evidence: evidencePath });
  calls = [];
  const written = await manufacturer.writeCandidates(directory, {});
  const writerCalls = calls.filter((call) => call.stageName.startsWith("winner_source_script_v3_"));
  assert.equal(writerCalls.length, 1, "exactly one Pro writer call");
  assert.deepEqual([writerCalls[0].stageName, writerCalls[0].model, writerCalls[0].effort, writerCalls[0].provider], ["winner_source_script_v3_draft_56_1", "gpt-6.1-sol", "max", "codex_cli"]);
  assert.ok(!writerCalls[0].prompt.includes("Do not compare with or anticipate another candidate"));
  assert.equal(written.document.writer_policy, "single_6_sol_pro_v1");
  assert.equal(written.document.candidates.length, 1);
  await assert.rejects(manufacturer.selectCandidate(directory, {}), /no selection stage/);
  calls = [];
  await manufacturer.writeCandidates(directory, {});
  assert.equal(calls.length, 0, "a completed portfolio is reused without new spend");
}

// --- revise loop: keep in one round ---------------------------------------------------
{
  const directory = await newDirectory("revise-keep");
  await seedSingleDraft(directory);
  calls = [];
  responder = loopResponder([{ revision: REVISION_1, verify: ["keep_revision", []] }]);
  const { report } = await manufacturer.reviseScript(directory, {});
  assert.deepEqual(calls.map((call) => [call.stageName, call.effort]), [
    ["winner_source_script_revision_diagnose_r01", "high"],
    ["winner_source_script_revision_rewrite_r01", "high"],
    ["winner_source_script_revision_verify_r01", "medium"],
  ]);
  assert.ok(calls[0].prompt.includes("OPENING WORD WINDOWS"));
  assert.ok(calls[2].prompt.includes("INCUMBENT (") && calls[2].prompt.includes("REVISION ("));
  assert.equal(report.initial_source, "single_draft");
  assert.equal(report.kept_rounds, 1);
  assert.equal(report.rounds.length, 1, "no remaining material issues means no second round");
  assert.equal(await readFile(report.final_script_path, "utf8"), `${REVISION_1}\n`);
  assert.equal(report.final_script_sha256, sha(`${REVISION_1}\n`));
  const roundFiles = (await readdir(path.join(directory, "revision_loop", "round_01"))).sort();
  for (const file of ["incumbent.txt", "notes.json", "revision.txt", "verdict.json", "decision.json", "diagnose_response.txt.meta.json", "revise_response.txt.meta.json", "verify_response.txt.meta.json"]) {
    assert.ok(roundFiles.includes(file), `round artifact ${file} is preserved`);
  }
  assert.equal(await readFile(path.join(directory, "revision_loop", "v00_incumbent.txt"), "utf8"), DRAFT);
  const timing = JSON.parse(await readFile(report.timing_report_path, "utf8"));
  assert.equal(timing.call_count, 3);
  assert.equal(timing.calls[0].minutes, 5);
  calls = [];
  const resumed = await manufacturer.reviseScript(directory, {});
  assert.equal(calls.length, 0, "a completed loop resumes without new calls");
  assert.equal(resumed.report.final_script_sha256, report.final_script_sha256);
}

// --- revise loop: revert ---------------------------------------------------------------
{
  const directory = await newDirectory("revise-revert");
  await seedSingleDraft(directory);
  calls = [];
  responder = loopResponder([{ revision: REVISION_1, verify: ["revert", []] }]);
  const { report } = await manufacturer.reviseScript(directory, {});
  assert.equal(calls.length, 3);
  assert.equal(report.kept_rounds, 0);
  assert.equal(report.rounds[0].status, "incumbent_retained");
  assert.equal(await readFile(report.final_script_path, "utf8"), DRAFT, "verify revert keeps the original");
  assert.equal(await readFile(path.join(directory, "revision_loop", "round_01", "revision.txt"), "utf8"), `${REVISION_1}\n`, "the rejected challenger is preserved");
}

// --- revise loop: second round after remaining issues, then the cap ---------------------
{
  const directory = await newDirectory("revise-two-rounds");
  await seedSingleDraft(directory);
  calls = [];
  responder = loopResponder([
    { revision: REVISION_1, verify: ["keep_revision", ["The guild purchase is summarized."]] },
    { revision: REVISION_2, verify: ["keep_revision", ["Still one thin ally."]] },
  ]);
  const { report } = await manufacturer.reviseScript(directory, { "max-rounds": "5" });
  assert.equal(report.max_rounds, 2, "requested rounds are capped at two");
  assert.equal(calls.length, 6);
  assert.equal(report.rounds.length, 2, "remaining issues after round two do not start a third round");
  assert.equal(report.kept_rounds, 2);
  assert.ok(calls[3].prompt.includes("The guild purchase is summarized."), "round two diagnose sees the remaining issues");
  assert.ok(calls[3].prompt.includes(REVISION_1), "round two starts from the kept revision");
  const round2 = JSON.parse(await readFile(path.join(directory, "revision_loop", "round_02", "decision.json"), "utf8"));
  assert.equal(round2.incumbent.sha256, sha(`${REVISION_1}\n`));
  assert.equal(await readFile(report.final_script_path, "utf8"), `${REVISION_2}\n`);
}

// --- revise loop: revert in round one still allows one directed retry -----------------
{
  const directory = await newDirectory("revise-revert-then-keep");
  await seedSingleDraft(directory);
  calls = [];
  responder = loopResponder([
    { revision: REVISION_1, verify: ["revert", ["The opening still hides the low status."]] },
    { revision: REVISION_2, verify: ["keep_revision", []] },
  ]);
  const { report } = await manufacturer.reviseScript(directory, {});
  assert.equal(calls.length, 6);
  assert.ok(calls[3].prompt.includes(DRAFT) && calls[3].prompt.includes("reverted"));
  assert.equal(await readFile(report.final_script_path, "utf8"), `${REVISION_2}\n`);
  calls = [];
  responder = loopResponder([{ revision: REVISION_1, verify: ["keep_revision", ["more"]] }]);
  const directoryOne = await newDirectory("revise-one-round");
  await seedSingleDraft(directoryOne);
  const one = await manufacturer.reviseScript(directoryOne, { "max-rounds": "1" });
  assert.equal(one.report.rounds.length, 1, "an explicit one-round limit is honored");
}

// --- truncated revision and nothing-to-fix spend no verify call -----------------------
{
  const directory = await newDirectory("revise-truncated");
  await seedSingleDraft(directory);
  calls = [];
  responder = loopResponder([{ revision: story("short", 300), verify: ["keep_revision", []] }]);
  const { report } = await manufacturer.reviseScript(directory, {});
  assert.equal(calls.length, 2, "no verify call for an incomplete revision");
  assert.equal(report.rounds[0].status, "revision_incomplete_reverted");
  assert.equal(await readFile(report.final_script_path, "utf8"), DRAFT);

  const clean = await newDirectory("revise-nothing");
  await seedSingleDraft(clean);
  calls = [];
  responder = loopResponder([], { emptyNotes: true });
  const nothing = await manufacturer.reviseScript(clean, {});
  assert.equal(calls.length, 1);
  assert.equal(nothing.report.rounds[0].status, "no_issues_found");
  assert.equal(await readFile(nothing.report.final_script_path, "utf8"), DRAFT);
}

// --- brought script -----------------------------------------------------------------
{
  const broughtDirectory = path.join(tmpRoot, "brought");
  await mkdir(broughtDirectory, { recursive: true });
  const broughtPath = path.join(broughtDirectory, "my_script.txt");
  await writeFile(broughtPath, DRAFT);
  const flags = { script: broughtPath };
  const directory = manufacturer.developmentDirectory(flags, "revise");
  assert.equal(directory, path.join(broughtDirectory, "my_script_revision"));
  calls = [];
  responder = loopResponder([{ revision: REVISION_1, verify: ["revert", []] }]);
  const { report } = await manufacturer.reviseScript(directory, flags);
  assert.equal(report.initial_source, "operator_script");
  assert.equal(report.brief_sha256, null);
  assert.ok(calls[0].prompt.includes("No brief was supplied"));
  assert.equal(await readFile(broughtPath, "utf8"), DRAFT, "the brought file is never modified");
  assert.equal(await readFile(report.final_script_path, "utf8"), DRAFT, "verify keeps the original when the revision is not better");
  // A brought script gets a hand-off too: no brief, so no title; preflight needs --title.
  const broughtHandoff = JSON.parse(await readFile(path.join(directory, "revision_loop", "source_handoff.json"), "utf8"));
  assert.equal(broughtHandoff.schema, "goldflow_source_handoff_v1");
  assert.equal(broughtHandoff.status, "ready_for_preflight");
  assert.equal(broughtHandoff.title, null);
  assert.equal(broughtHandoff.brief_sha256, null);
  assert.equal(broughtHandoff.sha256, sha(DRAFT));
  assert.equal(broughtHandoff.final_script_path, report.final_script_path);
  assert.match(broughtHandoff.model_lock_sha256, /^[a-f0-9]{64}$/);
  assert.equal(broughtHandoff.incumbent_source, "operator_script");
  await writeFile(path.join(broughtDirectory, "other.txt"), REVISION_2);
  await assert.rejects(manufacturer.reviseScript(directory, { script: path.join(broughtDirectory, "other.txt") }), /differs from the requested script/);
}

// --- end-to-end run with no operator stop -------------------------------------------
{
  const directory = await newDirectory("full-run");
  const evidencePath = path.join(directory, "evidence.md");
  await writeFile(evidencePath, evidenceText);
  calls = [];
  responder = fullRunResponder([{ revision: REVISION_1, verify: ["keep_revision", []] }]);
  const result = await manufacturer.runSingleDraftFlow(directory, { evidence: evidencePath });
  assert.deepEqual(calls.map((call) => call.stageName), [
    "winner_source_premise_manufacturing_pool",
    "winner_source_premise_manufacturing_shortlist",
    "winner_source_script_manufacturing_prompt",
    "winner_source_script_v3_draft_56_1",
    "winner_source_script_revision_diagnose_r01",
    "winner_source_script_revision_rewrite_r01",
    "winner_source_script_revision_verify_r01",
  ]);
  assert.equal(result.auto_selected_title, true);
  assert.equal(result.title, topTitle);
  assert.equal(result.final_script_sha256, sha(await readFile(result.final_script_path, "utf8")));
  assert.match(result.next_action, /run preflight/);
  assert.match(result.next_action, /--source-handoff /);
  assert.match(result.next_action, /--channel-preset /);
  assert.match(result.next_action, /--content-profile manhwa_recap_v1 --media-workflow generated_visuals_v1 --run-intent production/);
  // The hand-off binds script, brief, model lock and evidence by hash and names no profile/workflow/intent.
  const handoff = JSON.parse(await readFile(result.source_handoff_path, "utf8"));
  assert.equal(handoff.schema, "goldflow_source_handoff_v1");
  assert.equal(handoff.status, "ready_for_preflight");
  assert.equal(handoff.title, topTitle);
  assert.equal(handoff.final_script_path, result.final_script_path);
  assert.equal(handoff.sha256, result.final_script_sha256);
  const brief = JSON.parse(await readFile(path.join(directory, "manufacturing_brief.json"), "utf8"));
  assert.equal(handoff.brief_sha256, sha(await readFile(path.join(directory, "manufacturing_brief.json"))));
  assert.equal(handoff.evidence_sha256, brief.selection_basis.evidence_sha256);
  assert.equal(handoff.evidence_sha256, sha(evidenceText));
  assert.equal(handoff.model_lock_sha256, sha(await readFile(path.join(directory, "manufacturing_model_lock.json"))));
  assert.deepEqual(handoff.never_supplies, ["content-profile", "media-workflow", "run-intent"]);
  assert.equal(result.source_handoff_sha256, sha(await readFile(result.source_handoff_path)));
  // The rank-one brief notice is a non-gate file written before the one draft call.
  const notice = JSON.parse(await readFile(path.join(directory, "rank_one_brief_notice.json"), "utf8"));
  assert.equal(notice.schema, "goldflow_manhwa_rank_one_brief_notice_v1");
  assert.equal(notice.gate, false);
  assert.equal(notice.title, topTitle);
  assert.equal(notice.brief_sha256, handoff.brief_sha256);
  // Re-running the loop (all rounds cached) keeps the hand-off byte-for-byte.
  const handoffBytes = await readFile(result.source_handoff_path);
  const again = await manufacturer.reviseScript(directory, {});
  assert.equal(again.handoff.created, false);
  assert.deepEqual(await readFile(result.source_handoff_path), handoffBytes);
  const timing = JSON.parse(await readFile(result.timing_report_path, "utf8"));
  assert.equal(timing.writer_policy, "single_6_sol_pro_v1");
  assert.equal(timing.stages.revision.call_count, 3);
  assert.equal(timing.stages.selection, undefined);
}

// --- per-run model lock ---------------------------------------------------------------
{
  const directory = await newDirectory("model-lock-default");
  const evidencePath = path.join(directory, "evidence.md");
  await writeFile(evidencePath, evidenceText);
  responder = fullRunResponder([{ revision: REVISION_1, verify: ["keep_revision", []] }]);
  calls = [];
  await manufacturer.runSingleDraftFlow(directory, { evidence: evidencePath });
  const lock = JSON.parse(await readFile(path.join(directory, "manufacturing_model_lock.json"), "utf8"));
  assert.deepEqual(lock.roles.writer, { provider: "codex_cli", model: "gpt-6.1-sol", reasoning_effort: "max" }, "the default writer is Codex CLI gpt-6.1-sol at max");
  assert.deepEqual(lock.roles.planning, { provider: "codex_cli", model: "gpt-6.1-sol", reasoning_effort: "medium" });
  assert.ok(Object.values(lock.roles).every((role) => role.provider === "codex_cli"), "no default role uses a browser");
  assert.ok(calls.every((call) => call.provider === "codex_cli"), "every default call goes through the Codex CLI");
  assert.deepEqual(Object.fromEntries(["diagnose", "revise", "verify"].map((role) => [role, lock.roles[role].reasoning_effort])), { diagnose: "high", revise: "high", verify: "medium" });
  const portfolio = JSON.parse(await readFile(path.join(directory, "manufacturing_portfolio.json"), "utf8"));
  assert.equal(portfolio.model_lock_sha256, sha(await readFile(path.join(directory, "manufacturing_model_lock.json"))));
  const receipt = JSON.parse(await readFile(path.join(directory, "revision_loop", "round_01", "verify_response.txt.meta.json"), "utf8"));
  assert.deepEqual([receipt.provider, receipt.model, receipt.reasoning_effort], ["codex_cli", "gpt-6.1-sol", "medium"]);
  await assert.rejects(manufacturer.writeCandidates(directory, { "writer-model": "claude-fable-5-1" }), /conflict with the locked run choice/);
  await assert.rejects(manufacturer.reviseScript(directory, { "verify-effort": "high" }), /verify_effort/);
}
{
  const directory = await newDirectory("model-lock-claude-writer");
  const evidencePath = path.join(directory, "evidence.md");
  await writeFile(evidencePath, evidenceText);
  responder = fullRunResponder([{ revision: REVISION_1, verify: ["keep_revision", []] }]);
  calls = [];
  const flags = { evidence: evidencePath, "writer-model": "claude-fable-5-1", "revision-model": "claude-opus-5-5" };
  await manufacturer.runSingleDraftFlow(directory, flags);
  const writer = calls.find((call) => call.stageName === "winner_source_script_v3_draft_56_1");
  assert.deepEqual([writer.provider, writer.model, writer.effort], ["claude_cli", "claude-fable-5-1", "max"]);
  const revisionCalls = calls.filter((call) => call.stageName.startsWith("winner_source_script_revision_"));
  assert.ok(revisionCalls.every((call) => call.provider === "claude_cli" && call.model === "claude-opus-5-5"));
  const filler = calls.find((call) => call.stageName === "winner_source_script_manufacturing_prompt");
  assert.deepEqual([filler.provider, filler.model], ["codex_cli", "gpt-6.1-sol"], "planning keeps its own role when the writer is Claude");
  const portfolio = JSON.parse(await readFile(path.join(directory, "manufacturing_portfolio.json"), "utf8"));
  assert.deepEqual([portfolio.candidates[0].provider, portfolio.candidates[0].model], ["claude_cli", "claude-fable-5-1"]);
  calls = [];
  await manufacturer.writeCandidates(directory, {});
  assert.equal(calls.length, 0, "a locked Claude-written portfolio reloads under its recorded contract");
}
{
  const { requestedModelLock } = await import("../lib/source-model-lock.mjs");
  assert.throws(() => requestedModelLock({ "writer-model": "gpt-7-sol" }), /Unsupported source model/, "unconfirmed slugs are refused, not guessed");
  assert.equal(requestedModelLock({ "writer-model": "gpt-6-sol" }).writer.provider, "codex_cli", "gpt-6-sol is now a Codex CLI choice");
  assert.throws(() => requestedModelLock({ "verify-effort": "max" }), /only medium or high/);
  const directory = await newDirectory("model-lock-historical");
  await seedSingleDraft(directory);
  responder = loopResponder([{ revision: REVISION_1, verify: ["revert", []] }]);
  await manufacturer.reviseScript(directory, {});
  const lock = JSON.parse(await readFile(path.join(directory, "manufacturing_model_lock.json"), "utf8"));
  assert.equal(lock.roles.writer, null, "a pre-lock portfolio keeps its recorded writer");
  assert.equal(lock.writer_recorded_in_portfolio, true);
}

// --- retired browser transport and ideation reuse -----------------------------------------
{
  const directory = await newDirectory("legacy-browser-gate");
  const evidencePath = path.join(directory, "evidence.md");
  await writeFile(evidencePath, evidenceText);
  responder = fullRunResponder([]);
  await manufacturer.ideateTopics(directory, { evidence: evidencePath });
  calls = [];
  await manufacturer.ideateTopics(directory, { evidence: evidencePath });
  assert.equal(calls.length, 0, "completed ideation is reused without new calls");
  await assert.rejects(manufacturer.writeCandidates(directory, { "writer-policy": "three_6_sol_pro_v1" }), /--transport chatgpt_web/);
  assert.ok(calls.every((call) => call.provider !== "chatgpt_web"), "no browser call is made without the explicit transport");
  manufacturer.allowChatGptWebTransport(true);
  try {
    calls = [];
    const legacy = await manufacturer.writeCandidates(directory, { "writer-policy": "three_6_sol_pro_v1", "writer-stagger-ms": "0" });
    assert.equal(legacy.document.candidates.length, 3);
    assert.ok(calls.filter((call) => call.stageName.startsWith("winner_source_script_v3_")).every((call) => call.provider === "chatgpt_web"));
  } finally {
    manufacturer.allowChatGptWebTransport(false);
  }
}

// --- Codex exec provider through a fake executable (no real CLI call) ---------------------
{
  const { codexExecArgs, runCodexExec } = await import("../lib/codex-cli-runner.mjs");
  const fakeDirectory = path.join(tmpRoot, "fake-codex");
  await mkdir(fakeDirectory, { recursive: true });
  const fakePath = path.join(fakeDirectory, "codex");
  const logPath = path.join(fakeDirectory, "calls.jsonl");
  await writeFile(fakePath, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli " + (process.env.FAKE_CODEX_VERSION || "0.163.0")); process.exit(0); }
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin, cwd: process.cwd() }) + "\\n");
  if (process.env.FAKE_CODEX_MODE === "fail") { console.error("model not available"); process.exit(1); }
  fs.writeFileSync(args[args.indexOf("-o") + 1], "OK from fake codex");
});
`);
  await chmod(fakePath, 0o755);
  const previousPath = process.env.ANIFACTORY_CODEX_CLI_PATH;
  process.env.ANIFACTORY_CODEX_CLI_PATH = fakePath;
  try {
    const args = codexExecArgs({ model: "gpt-6.1-sol", effort: "max", workdir: "/tmp/w", lastMessagePath: "/tmp/w/last.txt" });
    for (const pair of [["--sandbox", "read-only"], ["-m", "gpt-6.1-sol"], ["-c", "model_reasoning_effort=\"max\""], ["-C", "/tmp/w"]]) {
      assert.equal(args[args.indexOf(pair[0], pair[0] === "-c" ? args.indexOf("-m") : 0) + 1], pair[1], pair[0]);
    }
    for (const flag of ["--ephemeral", "--ignore-user-config", "--skip-git-repo-check"]) assert.ok(args.includes(flag), flag);
    assert.equal(args.at(-1), "-", "the prompt is read from stdin");
    assert.throws(() => codexExecArgs({ model: "gpt-6.1-sol", effort: "ultra", workdir: "/w", lastMessagePath: "/w/l" }), /Unsupported Codex reasoning effort/);

    const outputPath = path.join(fakeDirectory, "out", "writer.txt");
    const result = await runCodexExec({ prompt: "Write the script.", stageName: "fixture", outputPath, model: "gpt-6.1-sol", reasoningEffort: "max" });
    assert.equal(result.content, "OK from fake codex");
    const receipt = JSON.parse(await readFile(`${outputPath}.meta.json`, "utf8"));
    assert.deepEqual([receipt.status, receipt.provider, receipt.transport, receipt.model, receipt.reasoning_effort, receipt.sandbox, receipt.codex_cli_version],
      ["passed", "codex_cli", "codex_exec_cli", "gpt-6.1-sol", "max", "read-only", "0.163.0"]);
    assert.equal(receipt.output_sha256, sha("OK from fake codex"));
    const logged = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(logged.length, 1);
    assert.equal(logged[0].stdin, "Write the script.");
    assert.ok(!logged[0].cwd.startsWith(path.resolve(".")), "the call runs in an empty scratch directory, not the repo");
    await assert.rejects(runCodexExec({ prompt: "x", stageName: "fixture", outputPath, model: "gpt-6.1-sol", reasoningEffort: "max" }), /EEXIST/, "a passed output is never overwritten");

    process.env.FAKE_CODEX_MODE = "fail";
    const failedPath = path.join(fakeDirectory, "out", "failed.txt");
    await assert.rejects(runCodexExec({ prompt: "x", stageName: "fixture", outputPath: failedPath, model: "gpt-6.1-sol", reasoningEffort: "medium" }), /exited 1/);
    assert.equal(JSON.parse(await readFile(`${failedPath}.meta.json`, "utf8")).status, "failed");
    assert.equal((await readFile(logPath, "utf8")).trim().split("\n").length, 2, "no automatic retry");
    delete process.env.FAKE_CODEX_MODE;

    process.env.FAKE_CODEX_VERSION = "0.150.0";
    await assert.rejects(runCodexExec({ prompt: "x", stageName: "fixture", outputPath: path.join(fakeDirectory, "out", "old.txt"), model: "gpt-6.1-sol", reasoningEffort: "medium" }), /older than 0\.159\.1/);
    assert.equal((await readFile(logPath, "utf8")).trim().split("\n").length, 2, "an old CLI is refused before any submission");
  } finally {
    delete process.env.FAKE_CODEX_MODE;
    delete process.env.FAKE_CODEX_VERSION;
    if (previousPath == null) delete process.env.ANIFACTORY_CODEX_CLI_PATH;
    else process.env.ANIFACTORY_CODEX_CLI_PATH = previousPath;
  }
}

// --- Claude Code print provider through a fake executable (no real CLI call) -------------
{
  const { claudeCodePrintArgs, runClaudeCodePrint } = await import("../lib/codex-cli-runner.mjs");
  const fakeDirectory = path.join(tmpRoot, "fake-claude");
  await mkdir(fakeDirectory, { recursive: true });
  const fakePath = path.join(fakeDirectory, "claude");
  const logPath = path.join(fakeDirectory, "calls.jsonl");
  await writeFile(fakePath, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("0.0.0 (fake Claude Code)"); process.exit(0); }
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
  const mode = process.env.FAKE_CLAUDE_MODE || "loop";
  if (mode === "error") { console.log(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" })); return; }
  if (mode === "hang") { setTimeout(() => {}, 60000); return; }
  const dir = ${JSON.stringify(fakeDirectory)};
  const kind = stdin.includes("REVISION (") ? "verify" : stdin.includes("EXACT INCUMBENT NARRATION") ? "rewrite" : "diagnose";
  const result = fs.readFileSync(dir + "/" + kind + ".txt", "utf8");
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result, duration_ms: 1500, total_cost_usd: 0 }));
});
`);
  await chmod(fakePath, 0o755);
  await writeFile(path.join(fakeDirectory, "diagnose.txt"), notesFor(DRAFT));
  await writeFile(path.join(fakeDirectory, "rewrite.txt"), REVISION_1);
  await writeFile(path.join(fakeDirectory, "verify.txt"), verdict("keep_revision", []));
  const previousPath = process.env.ANIFACTORY_CLAUDE_CLI_PATH;
  process.env.ANIFACTORY_CLAUDE_CLI_PATH = fakePath;
  try {
    const args = claudeCodePrintArgs({ model: "claude-fable-5-1", effort: "high" });
    assert.deepEqual(args.slice(0, 7), ["-p", "--output-format", "json", "--model", "claude-fable-5-1", "--effort", "high"]);
    assert.equal(args[args.indexOf("--tools") + 1], "", "all built-in tools are disabled");
    for (const flag of ["--no-session-persistence", "--disallowedTools", "--strict-mcp-config", "--disable-slash-commands", "--settings"]) assert.ok(args.includes(flag), flag);
    assert.throws(() => claudeCodePrintArgs({ model: "", effort: "high" }), /explicit --model/);

    // Real dispatch path (no injected executor) routes claude_cli roles to the print runner.
    manufacturer.setModelExecutorForTests(null);
    const directory = await newDirectory("claude-dispatch");
    await seedSingleDraft(directory);
    const { report } = await manufacturer.reviseScript(directory, { "revision-model": "claude-fable-5-1" });
    const logged = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(logged.length, 3, "one CLI process per call, no retries");
    assert.ok(logged[0].stdin.includes("EXACT NARRATION"), "the prompt is sent on stdin");
    assert.ok(logged.every((row) => row.args.includes("claude-fable-5-1")));
    const receipt = JSON.parse(await readFile(path.join(directory, "revision_loop", "round_01", "diagnose_response.txt.meta.json"), "utf8"));
    assert.deepEqual([receipt.status, receipt.provider, receipt.transport, receipt.model, receipt.reasoning_effort, receipt.claude_cli_version], ["passed", "claude_cli", "claude_code_headless_print", "claude-fable-5-1", "high", "0.0.0 (fake Claude Code)"]);
    assert.equal(receipt.output_sha256, sha(await readFile(path.join(directory, "revision_loop", "round_01", "diagnose_response.txt"), "utf8")));
    assert.equal(await readFile(report.final_script_path, "utf8"), `${REVISION_1}\n`);

    process.env.FAKE_CLAUDE_MODE = "error";
    const errorOutput = path.join(fakeDirectory, "error_case.txt");
    await assert.rejects(runClaudeCodePrint({ prompt: "x", stageName: "fixture", outputPath: errorOutput, model: "claude-fable-5-1", reasoningEffort: "medium" }), /boom/);
    assert.equal(JSON.parse(await readFile(`${errorOutput}.meta.json`, "utf8")).status, "failed");
    await assert.rejects(readFile(errorOutput, "utf8"), /ENOENT/, "a failed call leaves no output");
    process.env.FAKE_CLAUDE_MODE = "hang";
    await assert.rejects(runClaudeCodePrint({ prompt: "x", stageName: "fixture", outputPath: path.join(fakeDirectory, "hang_case.txt"), model: "claude-fable-5-1", reasoningEffort: "medium", timeoutMs: 500 }), /timed out/);
  } finally {
    delete process.env.FAKE_CLAUDE_MODE;
    if (previousPath == null) delete process.env.ANIFACTORY_CLAUDE_CLI_PATH;
    else process.env.ANIFACTORY_CLAUDE_CLI_PATH = previousPath;
  }
}

await rm(tmpRoot, { recursive: true, force: true });
console.log("source single-draft flow tests passed");
