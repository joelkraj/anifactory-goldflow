import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { autopilotEnabled, autopilotIdentityFields, isAutomatedReviewer } from "../lib/autopilot-policy.mjs";
import { buildEpisodeBudget } from "../lib/episode-budget.mjs";
import { goldflowArgv, placeholdersIn, repairScope, tokenizeShape, useEpisodeBudgetToken } from "../lib/autopilot-command-shape.mjs";
import { classifyRiskCut, decideNext } from "../lib/autopilot-gates.mjs";
import { createModelReviewer } from "../lib/autopilot-reviewer.mjs";
import { runAutopilot } from "../lib/autopilot-driver.mjs";
import {
  autoPrivateUpload, autopilotPublishStatus, automatedUploadReceipt, finalWatchStatus, publishApproval, recordFinalWatch,
} from "../lib/autopilot-publish.mjs";
import { authorAutomatedPackaging, loadPackagingConfig } from "../lib/autopilot-packaging.mjs";
import { mediaWorkflowForPreflight } from "../lib/media-workflows.mjs";
import { materializePowerSystemComprehensionAudit } from "../lib/power-system-comprehension-contract.mjs";
import { PIPELINE_STAGE_REGISTRY, buildStageCommand, readyStageIds, stageChecklistFor } from "../lib/pipeline-stage-registry.mjs";
import { validateYoutubePackagingSpec, validateYoutubeUploadReceipt } from "../lib/youtube-publish-contract.mjs";

const lockedAt = "2026-10-20T00:00:00.000Z";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const autopilotIdentity = (extra = {}) => ({
  schema: "goldflow_run_identity_v2", run_intent: "production", channel: "chan", episode: "ep_01",
  content_profile: "manhwa_recap_v1",
  episode_budget: buildEpisodeBudget({ usd: "10", lockedAt }),
  ...autopilotIdentityFields({ autopilot: "true" }, { runIntent: "production", lockedAt, episodeBudget: {}, narrationAcceptanceMode: "automated_asr_v1" }),
  ...extra,
});

async function episodeDir(identity = autopilotIdentity()) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "goldflow-autopilot-"));
  await writeFile(path.join(dir, "run_identity.json"), JSON.stringify(identity));
  return dir;
}
const json = (file, value) => mkdir(path.dirname(file), { recursive: true }).then(() => writeFile(file, JSON.stringify(value, null, 2)));
const status = (stage, shape, extra = {}) => ({ current_stage: stage, current_stage_state: "missing", next_command_shape: shape, identity: autopilotIdentity(), stage_ledger: [], ...extra });
const neverReviewer = async () => { throw new Error("reviewer must not be called"); };

/* ---------- policy and budget lock ---------- */

test("autopilot locks only with a budget, automated narration acceptance and production intent", () => {
  const base = { runIntent: "production", lockedAt, episodeBudget: buildEpisodeBudget({ usd: "5", lockedAt }), narrationAcceptanceMode: "automated_asr_v1" };
  assert.deepEqual(autopilotIdentityFields({}, base), {});
  assert.equal(autopilotIdentityFields({ autopilot: "true" }, base).autopilot_policy.human_steps.join(","), "final_watch,publish_approval");
  assert.throws(() => autopilotIdentityFields({ autopilot: "true" }, { ...base, episodeBudget: null }), /episode-budget-usd/);
  assert.throws(() => autopilotIdentityFields({ autopilot: "true" }, { ...base, narrationAcceptanceMode: null }), /automated_asr_v1/);
  assert.throws(() => autopilotIdentityFields({ autopilot: "true" }, { ...base, runIntent: "proof" }), /production intent/);
  assert.equal(autopilotEnabled(autopilotIdentity()), true);
  assert.equal(autopilotEnabled(autopilotIdentity({ run_intent: "proof" })), false);
  assert.equal(autopilotEnabled(autopilotIdentity({ episode_budget: null })), false);
  assert.equal(isAutomatedReviewer("automated:image_qa_v1"), true);
  assert.equal(isAutomatedReviewer("joel"), false);
});

test("registry adds the final watch; manual identities waive it and keep their commands", () => {
  const ids = PIPELINE_STAGE_REGISTRY.map((row) => row.id);
  assert.deepEqual(ids.slice(-3), ["youtube_studio_upload", "final_watch", "youtube_pinned_comment"]);
  assert.equal(stageChecklistFor({}).find((row) => row.stage === "final_watch").status, "skipped_with_waiver");
  assert.equal(stageChecklistFor(autopilotIdentity()).find((row) => row.stage === "final_watch").status, "missing");
  assert.match(buildStageCommand("youtube_studio_upload", {}), /youtube-studio-publish browser skill/);
  const auto = autopilotIdentity({ episode_dir: "/e" });
  assert.equal(buildStageCommand("youtube_studio_upload", auto), "node bin/goldflow.mjs youtube auto-upload --episode-dir /e");
  assert.equal(buildStageCommand("upload_packaging", auto), "node bin/goldflow.mjs youtube author-packaging --episode-dir /e");
  assert.match(buildStageCommand("youtube_pinned_comment", auto), /youtube publish --episode-dir \/e/);
  // A waived final watch never makes publishing ready before the private upload.
  const rows = PIPELINE_STAGE_REGISTRY.map((row) => ({ stage: row.id, state: row.id === "final_watch" ? "skipped_with_waiver" : row.id === "youtube_studio_upload" || row.id === "youtube_pinned_comment" ? "missing" : "passed" }));
  assert.deepEqual(readyStageIds(rows, {}), ["youtube_studio_upload"]);
});

/* ---------- command shapes ---------- */

test("command shapes tokenize exactly and refuse prose or compound commands", () => {
  assert.deepEqual(goldflowArgv(`node bin/goldflow.mjs imagegen fal --episode-dir '/a b' --note "x y"`), ["imagegen", "fal", "--episode-dir", "/a b", "--note", "x y"]);
  assert.equal(goldflowArgv("Operator hold: inspect the narration QA"), null);
  assert.equal(goldflowArgv("node bin/goldflow.mjs a b; rm -rf /"), null);
  assert.equal(tokenizeShape("node 'unterminated"), null);
  assert.deepEqual(placeholdersIn(["--plan", "<candidate.json>", "x"]), ["<candidate.json>"]);
  const budget = useEpisodeBudgetToken(["imagegen", "fal", "--confirm-spend", "exact_fal_zone_repair"], { budgetLocked: true });
  assert.equal(budget.at(-1), "episode_budget");
  assert.equal(useEpisodeBudgetToken(["x", "y", "--confirm-spend", "exact_fal_zone_repair"], { budgetLocked: false }).at(-1), "exact_fal_zone_repair");
  assert.deepEqual(repairScope(["imagegen", "fal", "--action", "dispatch-zone-repair", "--spec", "/s.json"], "image_output_qa").items, ["spec=/s.json"]);
  assert.equal(repairScope(["imagegen", "fal", "--action", "observe-bulk"], "image_generation"), null);
});

/* ---------- gate decisions ---------- */

test("terminal states stop at exactly the two human steps", async () => {
  const dir = await episodeDir();
  try {
    assert.equal((await decideNext({ status: status("final_watch", "Watch …", { final_watch_video_path: "/v.mp4" }), episodeDir: dir, deps: {} })).reason, "final_watch");
    assert.equal((await decideNext({ status: status("youtube_pinned_comment", "node bin/goldflow.mjs youtube publish …"), episodeDir: dir, deps: {} })).reason, "publish_approval");
    assert.equal((await decideNext({ status: status("complete", null), episodeDir: dir, deps: {} })).reason, "complete");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("script approval is automatic only after ingest and the deterministic checks pass", async () => {
  const dir = await episodeDir();
  try {
    const script = "Mara walked into the hall. The doors closed behind her, and the vote began.\n";
    await writeFile(path.join(dir, "script_clean.md"), script);
    const shape = "node bin/goldflow.mjs script approve --channel chan --series s --week w --episode ep_01 --hash <script_clean_hash>";
    const ingested = { stage_ledger: [{ stage: "source_ingest", state: "passed" }] };
    assert.equal((await decideNext({ status: status("script_approval", shape), episodeDir: dir, deps: { reviewer: neverReviewer } })).kind, "triage");
    // Missing audit: the model authors a candidate; offsets are filled deterministically.
    const authored = await decideNext({ status: status("script_approval", shape, ingested), episodeDir: dir,
      deps: { reviewer: async () => ({ power_system_present: false, no_power_system_rationale: "A courtroom drama without supernatural abilities." }) } });
    assert.deepEqual(authored.argv.slice(0, 2), ["script", "power-audit"]);
    assert.equal(authored.argv.at(-1), "automated:model_reviewer");
    assert.match(authored.receipt.repairKey, /^power_audit:/);
    const audit = materializePowerSystemComprehensionAudit(JSON.parse(await readFile(authored.argv[5], "utf8")), script, { reviewedBy: "automated:model_reviewer" });
    assert.equal(audit.status, "passed");
    await json(path.join(dir, "power_system_comprehension_audit.json"), audit);
    const approved = await decideNext({ status: status("script_approval", shape, ingested), episodeDir: dir, deps: { reviewer: neverReviewer } });
    assert.equal(approved.kind, "run");
    assert.equal(approved.argv[approved.argv.indexOf("--hash") + 1], sha(script));
    assert.equal(approved.argv[approved.argv.indexOf("--approved-by") + 1], "automated:deterministic_script_checks");
    await writeFile(path.join(dir, "script_clean.md"), "That was the hook. The hall fell silent.\n");
    const contaminated = await decideNext({ status: status("script_approval", shape, ingested), episodeDir: dir, deps: { reviewer: neverReviewer } });
    assert.equal(contaminated.kind, "triage");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("reference plan approval uses the model reviewer; a rejection is a triage, not a retry", async () => {
  const dir = await episodeDir();
  try {
    await json(path.join(dir, "visual_reference_plan.json"), { status: "passed", targets: [{ id: "mara" }] });
    const shape = `node bin/goldflow.mjs visual approve-ref-plan --episode-dir ${dir} --note "<reference plan review notes>"`;
    const approve = await decideNext({ status: status("reference_plan_approval", shape), episodeDir: dir,
      deps: { reviewer: async ({ task, validate }) => { assert.equal(task, "reference_plan"); const v = { verdict: "approve", note: "Every recurring identity has one coherent reference.", findings: [] }; assert.deepEqual(validate(v), []); return v; } } });
    assert.equal(approve.argv[approve.argv.indexOf("--approved-by") + 1], "automated:model_reviewer");
    assert.match(approve.argv[approve.argv.indexOf("--note") + 1], /^Automated reference plan review/);
    assert.deepEqual(placeholdersIn(approve.argv), []);
    const reject = await decideNext({ status: status("reference_plan_approval", shape), episodeDir: dir,
      deps: { reviewer: async () => ({ verdict: "reject", note: "Two references describe the same character differently.", findings: ["mara duplicated"] }) } });
    assert.equal(reject.kind, "triage");
    assert.deepEqual(reject.findings, ["mara duplicated"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the model reviewer fails closed on malformed output", async () => {
  const dir = await episodeDir();
  try {
    const review = createModelReviewer({ episodeDir: dir, repoRoot: dir, executor: async () => "looks fine to me" });
    await assert.rejects(review({ task: "x", prompt: "p" }), /no JSON object/);
    const invalid = createModelReviewer({ episodeDir: dir, repoRoot: dir, executor: async () => "```json\n{\"verdict\":\"maybe\"}\n```" });
    await assert.rejects(invalid({ task: "x", prompt: "p", validate: (v) => (v.verdict === "approve" ? [] : ["bad verdict"]) }), /invalid: bad verdict/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("image QA accepts cuts whose automated checks passed and sends only flagged cuts to the model", async () => {
  assert.equal(classifyRiskCut({ risk_reasons: ["hero_beat", "semantic:hero_beat"] }).automated, true);
  assert.equal(classifyRiskCut({ risk_reasons: ["hero_beat"] }).automated, false);
  assert.equal(classifyRiskCut({ risk_reasons: ["semantic:x", "zone_lettering_garbled"] }).automated, false);
  const dir = await episodeDir();
  try {
    await json(path.join(dir, "section_image_prompts_hardened.json"), { prompts: [{ image_id: "c1", prompt: "a" }, { image_id: "c2", prompt: "b" }] });
    await json(path.join(dir, "image_output_review_decisions_ep_01.json"), { decisions: [
      { image_id: "c1", image_sha256: "1".repeat(64), image_path: "/c1.png", risk_reasons: ["hero_beat", "semantic:hero_beat"], decision: "not_inspected" },
      { image_id: "c2", image_sha256: "2".repeat(64), image_path: "/c2.png", review_image_path: "/c2-zone.png", risk_reasons: ["semantic:dense_cast", "zone_lettering_garbled"], decision: "not_inspected" },
    ] });
    const reviewed = [];
    const decision = await decideNext({ status: status("image_output_qa", `node bin/goldflow.mjs imagegen qa --episode-dir ${dir} --semantic-audit true`), episodeDir: dir,
      deps: { reviewer: async ({ images, validate }) => { reviewed.push(...images); const v = { verdict: "reject", note: "The speech bubble repeats a garbled word.", defect: "Garbled doubled lettering in the zone bubble.", replacement_prompt: "x".repeat(130) }; assert.deepEqual(validate(v), []); return v; } } });
    assert.deepEqual(reviewed, ["/c2-zone.png"]);
    assert.equal(decision.argv[decision.argv.indexOf("--accept-cut-ids") + 1], "c1");
    assert.equal(decision.argv[decision.argv.indexOf("--critical-reject-cut-ids") + 1], "c2");
    assert.equal(decision.argv[decision.argv.indexOf("--reviewer") + 1], "automated:image_qa_v1");
    assert.equal(decision.receipt.decision, "reject");
    assert.equal((await readdir(path.join(dir, "autopilot", "image_qa_verdicts"))).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a rejected page zone becomes one exact zone repair request, then the bound is reached", async () => {
  const dir = await episodeDir();
  try {
    const pageSha = "a".repeat(64);
    await json(path.join(dir, "section_image_prompts_hardened.json"), { prompts: [
      { image_id: "b1", panel_zone_id: "Z1", panel_asset_id: "page_1" }, { image_id: "b2", panel_zone_id: "Z2", panel_asset_id: "page_1" },
    ] });
    await json(path.join(dir, "cut_execution_ledger.json"), { cuts: [{ image_id: "b1", image_sha256: pageSha }, { image_id: "b2", image_sha256: pageSha }] });
    await json(path.join(dir, "autopilot", "image_qa_verdicts", `b1_${pageSha.slice(0, 16)}.json`), {
      image_id: "b1", verdict: "reject", note: "The zone shows a third arm on the captain.", defect: "Extra arm on the captain in zone Z1.", replacement_prompt: "y".repeat(130),
    });
    const shape = `node bin/goldflow.mjs imagegen fal --episode-dir '${dir}' --action prepare-zone-repair --request <absolute_reviewed_zone_repair_request.json>`;
    const blocked = status("image_output_qa", shape, { current_stage_state: "blocked", stage_ledger: [{ stage: "image_output_qa", evidence: "image_output_qa_ep_01.json blocks page zones=Z1" }] });
    const decision = await decideNext({ status: blocked, episodeDir: dir, deps: { repairLedger: new Set() } });
    const request = JSON.parse(await readFile(decision.argv.at(-1), "utf8"));
    assert.deepEqual([request.zone_id, request.page_asset_id, request.rejected_page_sha256, request.evidence, request.reviewer], ["Z1", "page_1", pageSha, "review_rejected", "automated:model_reviewer"]);
    assert.equal(request.replacement_prompt, "y".repeat(130));
    assert.equal(decision.receipt.repairKey, "zone:Z1");
    assert.equal((await decideNext({ status: blocked, episodeDir: dir, deps: { repairLedger: new Set(["zone:Z1"]) } })).kind, "triage");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("existing agent-review modes replace the human approvals for motion, parallax and final QA", async () => {
  const dir = await episodeDir();
  try {
    const motion = await decideNext({ status: status("generated_video_motion_approval", `node bin/goldflow.mjs visual approve-generated-motion --episode-dir ${dir} --reviewer <name> --note "<clip review notes>" --approve-ids <ids> --reject-ids <ids>`), episodeDir: dir, deps: {} });
    assert.deepEqual(placeholdersIn(motion.argv), []);
    assert.equal(motion.argv[motion.argv.indexOf("--agent-review") + 1], "true");
    assert.equal(motion.argv[motion.argv.indexOf("--reviewer") + 1], "automated:motion_coherence_audit");
    const finalQa = await decideNext({ status: status("final_qa", `node bin/goldflow.mjs final qa --episode-dir ${dir} --master-scan true --approve true --reviewed-finding-codes <comma_separated_codes_if_any> --note "<QA review notes>"`), episodeDir: dir, deps: {} });
    assert.equal(finalQa.argv.includes("--approve"), false);
    assert.equal(finalQa.argv[finalQa.argv.indexOf("--approved-by") + 1], "automated:final_master_integrity");
    assert.equal(finalQa.argv[finalQa.argv.indexOf("--master-scan") + 1], "true");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("listening attestations, prose holds and unknown authored inputs go to triage; spend tokens use the budget", async () => {
  const dir = await episodeDir();
  try {
    const listen = await decideNext({ status: status("qwen_tts_stitch", `node bin/goldflow.mjs tts approve-listen --episode-dir ${dir} --reviewer <name> --accept-unit-ids u1 --attestation exact_audio_listened_end_to_end`), episodeDir: dir, deps: {} });
    assert.match(listen.reason, /never claims to have listened/);
    assert.equal((await decideNext({ status: status("qwen_tts_stitch", "Operator hold: inspect the narration QA"), episodeDir: dir, deps: {} })).kind, "triage");
    const recipe = await decideNext({ status: status("motion_edit_plan", `node bin/goldflow.mjs visual panel-plan --episode-dir ${dir} --action compile --recipe <exact-reviewed-panel-composition-recipe.json>`), episodeDir: dir, deps: {} });
    assert.match(recipe.reason, /authored input/);
    const dispatch = await decideNext({ status: status("image_generation", `node bin/goldflow.mjs imagegen fal --episode-dir ${dir} --action dispatch-bulk --confirm-spend exact_fal_bulk_batch --prompts <episode-dir>/p.json`), episodeDir: dir, deps: {} });
    assert.equal(dispatch.argv[dispatch.argv.indexOf("--confirm-spend") + 1], "episode_budget");
    assert.equal(dispatch.argv[dispatch.argv.indexOf("--prompts") + 1], `${dir}/p.json`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

/* ---------- driver ---------- */

function scriptedRun(statuses, outcomes = []) {
  let index = 0;
  const ran = [];
  return {
    ran,
    deps: {
      readStatus: async () => statuses[Math.min(index, statuses.length - 1)],
      runCommand: async (argv) => { ran.push(argv); const outcome = outcomes.shift() ?? { code: 0, output: "" }; if (outcome.advance !== false) index += 1; return outcome; },
      reviewer: neverReviewer, sleep: async () => {}, now: () => lockedAt,
    },
  };
}
const concrete = (stage, verb) => status(stage, `node bin/goldflow.mjs ${verb} --episode-dir /e`);

test("the driver runs status commands until the final watch and logs every step", async () => {
  const dir = await episodeDir();
  try {
    const run = scriptedRun([concrete("timing_bind", "timing bind"), concrete("visual_reference_plan", "visual refs"), status("final_watch", "Watch …", { final_watch_video_path: "/v.mp4" })]);
    const result = await runAutopilot({ episodeDir: dir, deps: run.deps });
    assert.deepEqual([result.reason, result.detail], ["final_watch", "/v.mp4"]);
    assert.deepEqual(run.ran.map((argv) => argv.slice(0, 2).join(" ")), ["timing bind", "visual refs"]);
    const events = (await readFile(path.join(dir, "autopilot", "driver_events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(events.map((row) => row.event), ["run", "exit", "run", "exit", "stop"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the driver refuses non-autopilot identities", async () => {
  const dir = await episodeDir({});
  try {
    const run = scriptedRun([{ ...concrete("timing_bind", "timing bind"), identity: {} }]);
    assert.equal((await runAutopilot({ episodeDir: dir, deps: run.deps })).status, "refused");
    assert.equal(run.ran.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("no progress is a triage file, never a silent retry", async () => {
  const dir = await episodeDir();
  try {
    const run = scriptedRun([concrete("timing_bind", "timing bind")], [{ code: 1, output: "boom", advance: false }]);
    const result = await runAutopilot({ episodeDir: dir, deps: run.deps });
    assert.equal(result.reason, "blocker");
    assert.equal(run.ran.length, 1);
    const triage = JSON.parse(await readFile(result.triage_path, "utf8"));
    assert.equal(triage.schema, "goldflow_autopilot_triage_v1");
    assert.match(triage.reason, /did not change run status/);
    assert.equal(triage.output_tail, "boom");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a hard budget refusal stops the driver with a budget triage", async () => {
  const dir = await episodeDir();
  try {
    const run = scriptedRun([status("image_generation", "node bin/goldflow.mjs imagegen fal --episode-dir /e --action dispatch-bulk --confirm-spend exact_fal_bulk_batch")],
      [{ code: 1, output: "Episode budget hard stop: $9.98 projected + $0.44 requested exceeds the locked $10 episode cap.", advance: false }]);
    const result = await runAutopilot({ episodeDir: dir, deps: run.deps });
    assert.equal(result.reason, "budget_stop");
    assert.equal(run.ran[0].at(-1), "episode_budget");
    assert.equal(JSON.parse(await readFile(result.triage_path, "utf8")).kind, "budget_stop");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("each failed item gets at most one exact-scope repair, even across driver restarts", async () => {
  const dir = await episodeDir();
  try {
    const repair = status("qwen_tts_stitch", "node bin/goldflow.mjs tts narrate --episode-dir /e --confirmed-retry-unit-ids u7 --confirmed-retry-evidence /e/ev.json", { current_stage_state: "blocked" });
    const first = scriptedRun([repair, { ...repair, stage_ledger: [{ stage: "qwen_tts_stitch", evidence: "changed" }] }]);
    const result = await runAutopilot({ episodeDir: dir, deps: first.deps });
    assert.equal(first.ran.length, 1);
    assert.match(result.detail, /repair bound/);
    const second = scriptedRun([repair]);
    assert.equal((await runAutopilot({ episodeDir: dir, deps: second.deps })).reason, "blocker");
    assert.equal(second.ran.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("observe steps poll with a bounded wait instead of failing", async () => {
  const dir = await episodeDir();
  try {
    const observe = concrete("image_generation", "imagegen fal --action observe-bulk");
    const statuses = [observe, observe, observe, status("final_watch", "Watch …")];
    let reads = 0;
    let sleeps = 0;
    const ran = [];
    const result = await runAutopilot({ episodeDir: dir, maxPolls: 5, deps: {
      readStatus: async () => statuses[Math.min(reads++, statuses.length - 1)],
      runCommand: async (argv) => { ran.push(argv); return { code: 0, output: "pending" }; },
      reviewer: neverReviewer, sleep: async () => { sleeps += 1; }, now: () => lockedAt,
    } });
    assert.equal(result.reason, "final_watch");
    assert.equal(sleeps, 1);
    assert.equal(ran.length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("automatic gate decisions leave a hash-bound decision receipt", async () => {
  const dir = await episodeDir();
  try {
    await json(path.join(dir, "visual_reference_plan.json"), { status: "passed" });
    const statuses = [status("reference_plan_approval", `node bin/goldflow.mjs visual approve-ref-plan --episode-dir ${dir} --note "<n>"`), status("final_watch", "Watch …")];
    let index = 0;
    await runAutopilot({ episodeDir: dir, deps: {
      readStatus: async () => statuses[index], runCommand: async () => { index += 1; return { code: 0, output: "" }; },
      reviewer: async () => ({ verdict: "approve", note: "Coherent references for every recurring identity.", findings: [] }), sleep: async () => {}, now: () => lockedAt,
    } });
    const [name] = await readdir(path.join(dir, "autopilot", "decisions"));
    const receipt = JSON.parse(await readFile(path.join(dir, "autopilot", "decisions", name), "utf8"));
    assert.deepEqual([receipt.schema, receipt.reviewer, receipt.decision], ["goldflow_autopilot_decision_v1", "automated:model_reviewer", "approve"]);
    assert.match(receipt.evidence[0].sha256, /^[a-f0-9]{64}$/);
    assert.match(receipt.run_identity_sha256, /^[a-f0-9]{64}$/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

/* ---------- private upload, final watch, publish approval ---------- */

async function publishFixture() {
  const dir = await episodeDir(autopilotIdentity());
  const video = path.join(dir, "final.mp4");
  await writeFile(video, "master");
  const manifest = { schema: "goldflow_youtube_publish_manifest_v1", status: "passed", title: "T", description: "D",
    publish_settings: { initial_visibility: "private", made_for_kids: false, mid_roll_mode: "automatic" }, pinned_comment: { text: "Who was right?" } };
  await json(path.join(dir, "youtube_publish_manifest_ep_01.json"), manifest);
  await json(path.join(dir, "final_qa_ep_01.json"), { status: "passed", final_video_path: video, final_video_sha256: sha("master") });
  return { dir, video, manifest };
}
const apiUpload = { status: "uploaded_private", channel: { id: "UC1" }, video_id: "vid1", watch_url: "https://www.youtube.com/watch?v=vid1",
  title: "T", description: "D", privacy_status: "private", self_declared_made_for_kids: false, thumbnail_uploaded: true };

test("automatic private upload verifies API-readable fields and defers only Studio-only settings", async () => {
  const { dir, manifest } = await publishFixture();
  try {
    const receipt = automatedUploadReceipt({ manifest, manifestPath: "/m", manifestSha256: "h", api: apiUpload, episode: "ep_01", now: lockedAt });
    assert.deepEqual(receipt.deferred_field_verification, ["monetization", "comments"]);
    assert.equal(validateYoutubeUploadReceipt(receipt, { manifest, manifestHash: "h" }).status, "passed");
    assert.equal(validateYoutubeUploadReceipt({ ...receipt, recorded_by: "joel" }, { manifest, manifestHash: "h" }).status, "blocked");
    assert.equal(validateYoutubeUploadReceipt({ ...receipt, visibility: "public", publish_approval: { approved: true, approved_by: "x" } }, { manifest, manifestHash: "h" }).status, "blocked");
    const mismatch = automatedUploadReceipt({ manifest, manifestPath: "/m", manifestSha256: "h", api: { ...apiUpload, title: "Other" }, episode: "ep_01", now: lockedAt });
    assert.equal(validateYoutubeUploadReceipt(mismatch, { manifest, manifestHash: "h" }).status, "blocked");
    let uploads = 0;
    const result = await autoPrivateUpload({ episodeDir: dir, episode: "ep_01", uploader: async () => { uploads += 1; return apiUpload; }, now: lockedAt });
    assert.equal(result.status, "passed");
    await assert.rejects(autoPrivateUpload({ episodeDir: dir, episode: "ep_01", uploader: async () => { uploads += 1; return apiUpload; } }), /never upload twice/);
    assert.equal(uploads, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("final watch and publish approval are human steps bound to the exact master", async () => {
  const { dir } = await publishFixture();
  try {
    const identity = autopilotIdentity();
    await autoPrivateUpload({ episodeDir: dir, episode: "ep_01", uploader: async () => apiUpload, now: lockedAt });
    const pending = await finalWatchStatus({ episodeDir: dir, episode: "ep_01", identity });
    assert.equal(pending.state, "missing");
    assert.match(pending.next_command_shape, /run final-watch/);
    assert.equal((await finalWatchStatus({ episodeDir: dir, episode: "ep_01", identity: {} })).state, "skipped_with_waiver");
    await assert.rejects(recordFinalWatch({ episodeDir: dir, episode: "ep_01", decision: "accept", reviewer: "automated:model_reviewer", note: "watched it all" }), /human step/);
    await recordFinalWatch({ episodeDir: dir, episode: "ep_01", decision: "accept", reviewer: "joel", note: "Watched end to end; pacing good." });
    assert.equal((await finalWatchStatus({ episodeDir: dir, episode: "ep_01", identity })).done, true);
    assert.equal((await autopilotPublishStatus({ episodeDir: dir, episode: "ep_01" })).state, "missing");
    const publisher = async ({ videoId, visibility, commentText }) => ({ video_id: videoId, privacy_status: visibility === "public" ? "public" : "private", comment_id: "c1", comment_text: commentText });
    await assert.rejects(publishApproval({ episodeDir: dir, episode: "ep_01", visibility: "public", approvedBy: "joel", studioSettingsVerified: false, publisher }), /studio-settings-verified/);
    await assert.rejects(publishApproval({ episodeDir: dir, episode: "ep_01", visibility: "public", approvedBy: "automated:x_y", studioSettingsVerified: true, publisher }), /human step/);
    const published = await publishApproval({ episodeDir: dir, episode: "ep_01", visibility: "public", approvedBy: "joel", studioSettingsVerified: true, publisher, now: lockedAt });
    assert.equal(published.status, "published");
    const done = await autopilotPublishStatus({ episodeDir: dir, episode: "ep_01" });
    assert.equal(done.done, true);
    assert.match(done.evidence, /pin it in Studio/);
    await assert.rejects(publishApproval({ episodeDir: dir, episode: "ep_01", visibility: "public", approvedBy: "joel", studioSettingsVerified: true, publisher }), /already has a publish/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a rejected final watch blocks publishing and names the rejection", async () => {
  const { dir } = await publishFixture();
  try {
    await recordFinalWatch({ episodeDir: dir, episode: "ep_01", decision: "reject", reviewer: "joel", note: "Narration clips at 12:04." });
    const state = await finalWatchStatus({ episodeDir: dir, episode: "ep_01", identity: autopilotIdentity() });
    assert.equal(state.state, "blocked");
    assert.match(state.evidence, /12:04/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

/* ---------- packaging ---------- */

test("packaging is authored automatically, validated, and never invents research evidence", async () => {
  const dir = await episodeDir();
  try {
    const script = "The council stripped Kael of his rank. Years later he returned with the dragon's oath and took the throne they denied him.\n";
    await writeFile(path.join(dir, "script_clean.md"), script);
    await assert.rejects(loadPackagingConfig(path.join(dir, "missing.json")), /recorded research evidence/);
    const recent = new Date().toISOString();
    const config = {
      schema: "goldflow_autopilot_packaging_config_v1",
      research_evidence: [
        { id: "own1", source_type: "own_channel", title: "Own outlier", source_ref: "yt:1", observed_at: recent, lesson: "Exile and return hooks win.", metrics: { views: 1000 } },
        { id: "niche1", source_type: "niche_outlier", title: "Niche outlier", source_ref: "yt:2", observed_at: recent, lesson: "Name the payoff.", metrics: { vph: 50 } },
        { id: "niche2", source_type: "niche_outlier", title: "Niche two", source_ref: "yt:3", observed_at: recent, lesson: "One clear face.", metrics: { views: 900 } },
      ],
      youtube_channel: { expected_name: "Chan" },
      publish_settings: { initial_visibility: "private", desired_visibility: "operator_decides", monetization: "off", made_for_kids: false, age_restricted: false, altered_content: false, comments: "on" },
    };
    const support = [{ title_phrase: "Stripped Of His Rank", evidence: "Opening", source_quote: "The council stripped Kael of his rank." }, { title_phrase: "Took The Throne", evidence: "Ending", source_quote: "took the throne they denied him" }];
    const titles = ["Stripped Of His Rank, He Came Back And Took The Throne | Manhwa Recap", "He Was Stripped Of His Rank Then Took The Throne | Manhwa Recap", "Stripped Of His Rank, Kael Took The Throne Anyway | Manhwa Recap"]
      .map((title) => ({ title, explains_full_video: true, research_evidence_ids: ["own1"], hook_contract: { primary_hook: "exile", hook_phrase: "Stripped Of His Rank", payoff_phrase: "Took The Throne", why_this_hook: "Exile then payoff.", story_support: support } }));
    const thumbs = ["t1", "t2"].map((id) => ({ id, subjects: [{ role: "Kael", emotion: "cold" }], main_text: "HE RETURNED", labels: [], arrows: [], hook_signal: "exile", payoff_signal: "throne", single_scene: true, no_collage: true, simple_read_order: true, research_evidence_ids: ["niche1"], image_prompt: "Kael on the throne, the words HE RETURNED in bold letters, 16:9" }));
    const reviewer = async ({ task }) => (task === "upload_packaging" ? {
      title_candidates: titles, selected_title: titles[0].title, title_selection_reason: "Clearest payoff.", thumbnail_candidates: thumbs,
      description: "Manhwa recap: Kael is stripped of his rank, then returns to take the throne.", description_contract: { primary_keywords: ["manhwa recap"], opening_explains_hook_and_payoff: true },
      tags: ["manhwa"], pinned_comment: { text: "Would you have forgiven the council?", viewer_dilemma: "forgive or not" },
    } : { selected_id: "t2", readable_at_mobile_size: true, note: "Large legible text and one face." });
    const thumbnailGenerator = async ({ jobs }) => Promise.all(jobs.map(async (job) => {
      await sharp({ create: { width: 1280, height: 720, channels: 3, background: "#224" } }).png().toFile(job.outputPath);
      return { provider: "google-gemini", reference_count: 0, output_path: job.outputPath };
    }));
    const identity = autopilotIdentity();
    const result = await authorAutomatedPackaging({ episodeDir: dir, episode: "ep_01", identity, config, reviewer, thumbnailGenerator, now: lockedAt });
    assert.equal(result.status, "draft_ready", JSON.stringify(result.blockers));
    const spec = JSON.parse(await readFile(result.spec_path, "utf8"));
    assert.deepEqual(spec.research_evidence, config.research_evidence);
    assert.equal(spec.selected_thumbnail_candidate_id, "t2");
    assert.equal(spec.thumbnail_candidates[1].provider, "google_gemini_imagen");
    assert.equal(spec.authored_by, "automated:packaging_author");
    const approved = { ...spec, status: "approved", approved_by: "automated:packaging_validator", approved_at: recent };
    const markdown = await readFile(result.package_path, "utf8");
    assert.equal(validateYoutubePackagingSpec(approved, { runIdentity: identity, markdown, scriptText: script }).status, "passed");
    await assert.rejects(authorAutomatedPackaging({ episodeDir: dir, episode: "ep_01", identity: { ...identity, content_profile: "asset_afterlife_v1", ...mediaWorkflowForPreflight({ contentProfile: "asset_afterlife_v1", mediaWorkflow: "generated_visuals_v1" }) }, config, reviewer, thumbnailGenerator }), /Packaging workflow unsupported/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
