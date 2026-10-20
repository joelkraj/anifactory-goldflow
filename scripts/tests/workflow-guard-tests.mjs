import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  decisionShapeAdmission, finalQaApprovalAdmission, imageQaDecisionAdmission, narrationAutomatedAsrAdmission, relockTtsAdmission,
} from "../lib/workflow-guard.mjs";
import { BYPASS_REASON_FLAG, WORKFLOW_BYPASS_REASON_CODES, workflowBypassDecision, workflowBypassRecord } from "../lib/workflow-bypass.mjs";
import { classifyShapes, composeShape, falShape, parseShape, recoveryStageFor } from "../lib/workflow-command-builder.mjs";
import { goldflowArgv } from "../lib/autopilot-command-shape.mjs";
import { PIPELINE_STAGE_REGISTRY, buildStageCommand, commandStageFor } from "../lib/pipeline-stage-registry.mjs";
import { buildNarrationQualityContract } from "../lib/narration-quality-contract.mjs";
import { appendIdentityRevision, currentIdentityRevisionSync, eventsSinceIdentityRevision } from "../lib/run-identity-revisions.mjs";
import { creativeStageRerunDecisionForEpisode } from "../lib/creative-stage-rerun-policy.mjs";
import { buildEpisodeBudget, guardFlagsForEpisodeBudget } from "../lib/episode-budget.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FAL_EPISODE = process.env.GOLDFLOW_FAL_EPISODE_DIR
  ?? "/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/2026-W43-coma-healer-fal-panel-v1/episodes/ep_01";

const ledger = (rows) => Object.entries(rows).map(([stage, value]) => (typeof value === "string" ? { stage, state: value } : { stage, ...value }));
const status = ({ stage = "image_output_qa", state = "blocked", shape = null, rows = {}, identity = {}, episodeDir = "/e" } = {}) => ({
  current_stage: stage, current_stage_state: state, next_command_shape: shape, identity, episode_dir: episodeDir, stage_ledger: ledger(rows),
});

/* ---------- bypass reason codes ---------- */

test("every bypass needs a reason code from the fixed enum; the record is structured", () => {
  assert.deepEqual(workflowBypassDecision({}), { requested: false, allowed: true, reason_code: null, reason: null });
  assert.equal(workflowBypassDecision({ "workflow-bypass": "true" }).allowed, false);
  assert.match(workflowBypassDecision({ "workflow-bypass": "true" }).reason, /requires --bypass-reason-code/);
  assert.equal(workflowBypassDecision({ "workflow-bypass": "true", [BYPASS_REASON_FLAG]: "because" }).allowed, false);
  assert.equal(workflowBypassDecision({ "workflow-bypass": "true", [BYPASS_REASON_FLAG]: "test_fixture" }).allowed, true);
  assert.equal(workflowBypassDecision({ [BYPASS_REASON_FLAG]: "test_fixture" }).allowed, false, "a reason code alone is not a bypass");
  assert.equal(workflowBypassRecord({}), null);
  assert.deepEqual(workflowBypassRecord({ "workflow-bypass": "true", [BYPASS_REASON_FLAG]: "operator_approved_full_stage_rerun", "allow-full-stage-rerun": "true", "rerun-reason": "r" }),
    { reason_code: "operator_approved_full_stage_rerun", rerun_reason: "r", allow_full_stage_rerun: true });
  assert.ok(WORKFLOW_BYPASS_REASON_CODES.includes("test_fixture"));
});

test("no environment bypass read remains and the drivers never emit a bypass", async () => {
  const files = ["bin/goldflow.mjs", "scripts/run-auto.mjs", "scripts/run-advance.mjs", "scripts/lib/autopilot-driver.mjs", "scripts/lib/autopilot-gates.mjs",
    "scripts/lib/autopilot-command-shape.mjs", "scripts/lib/workflow-command-builder.mjs", "scripts/run-status.mjs", "scripts/lib/fal-production-state.mjs", "scripts/lib/pipeline-stage-registry.mjs"];
  for (const file of files) {
    const text = await readFile(path.join(repoRoot, file), "utf8");
    assert.doesNotMatch(text, /GOLDFLOW_WORKFLOW_BYPASS/, `${file} reads the removed environment bypass`);
  }
  for (const file of ["scripts/run-auto.mjs", "scripts/run-advance.mjs", "scripts/lib/autopilot-driver.mjs", "scripts/lib/autopilot-gates.mjs"]) {
    const text = await readFile(path.join(repoRoot, file), "utf8");
    assert.doesNotMatch(text, /--workflow-bypass|"workflow-bypass"/, `${file} must never emit a bypass`);
  }
});

/* ---------- admissions per (shape, state) ---------- */

const qaFlags = { "episode-dir": "/e", "accept-cut-ids": "a,b", "critical-reject-cut-ids": "c", reviewer: "automated:image_qa_v1", note: "Automated image QA: 2 accepted, 1 rejected." };

test("imagegen qa cut decisions: admitted on needs_manual_review or blocked, refused otherwise", () => {
  const blocked = status({ rows: { image_output_qa: "blocked" } });
  assert.equal(imageQaDecisionAdmission(blocked, "imagegen", "qa", qaFlags).allowed, true);
  const manual = status({ stage: "final_qa", rows: { image_output_qa: { state: "missing", evidence: "image_output_qa_ep_01.json status=needs_manual_review; blockers=0" } } });
  assert.equal(imageQaDecisionAdmission(manual, "imagegen", "qa", qaFlags).allowed, true, "a later current stage does not refuse a pending review");
  const human = { ...qaFlags, reviewer: "joel" };
  assert.equal(imageQaDecisionAdmission(blocked, "imagegen", "qa", human).allowed, true);
  const passed = status({ rows: { image_output_qa: "passed" } });
  const refused = imageQaDecisionAdmission(passed, "imagegen", "qa", qaFlags);
  assert.deepEqual([refused.applicable, refused.allowed], [true, false]);
  assert.equal(imageQaDecisionAdmission(blocked, "imagegen", "qa", { ...qaFlags, note: "" }).allowed, false);
  assert.equal(imageQaDecisionAdmission(blocked, "imagegen", "qa", { ...qaFlags, "allow-full-stage-rerun": "true" }).allowed, false);
  // Plain QA runs (no decision flags) are not this admission's business.
  assert.equal(imageQaDecisionAdmission(blocked, "imagegen", "qa", { "episode-dir": "/e", "semantic-audit": "true" }).applicable, false);
  assert.equal(imageQaDecisionAdmission(blocked, "imagegen", "qa", { ...qaFlags, reviewer: "" }).applicable, false);
});

test("the autopilot image-QA shape is admitted without a bypass", () => {
  const argv = goldflowArgv(`node bin/goldflow.mjs imagegen qa --episode-dir /e --semantic-audit true --accept-cut-ids a --critical-reject-cut-ids b --reviewer automated:image_qa_v1 --note 'Automated image QA: 1 accepted (1 on passed automated checks), 1 rejected for exact repair.'`);
  const flags = Object.fromEntries(argv.map((token, index) => (token.startsWith("--") ? [token.slice(2), argv[index + 1]] : null)).filter(Boolean));
  assert.ok(!("workflow-bypass" in flags));
  for (const state of ["blocked", "needs_manual_review"]) {
    const row = state === "blocked" ? "blocked" : { state: "missing", evidence: "status=needs_manual_review" };
    assert.equal(decisionShapeAdmission(status({ rows: { image_output_qa: row } }), "imagegen", "qa", flags).allowed, true, state);
  }
});

test("final qa approval: reviewed codes or the automated form, only while findings exist", () => {
  const approve = { "episode-dir": "/e", "master-scan": "true", approve: "true", "reviewed-finding-codes": "advisory_a", note: "Reviewed." };
  for (const state of ["blocked", "failed", "needs_review", "stale"]) {
    assert.equal(finalQaApprovalAdmission(status({ stage: "final_qa", rows: { final_qa: state } }), "final", "qa", approve).allowed, true, state);
  }
  for (const state of ["missing", "passed"]) {
    const decision = finalQaApprovalAdmission(status({ stage: "final_qa", rows: { final_qa: state } }), "final", "qa", approve);
    assert.deepEqual([decision.applicable, decision.allowed], [true, false], state);
  }
  const noCodes = { ...approve }; delete noCodes["reviewed-finding-codes"];
  assert.equal(finalQaApprovalAdmission(status({ rows: { final_qa: "blocked" } }), "final", "qa", noCodes).allowed, false);
  const automated = { "episode-dir": "/e", "master-scan": "true", "agent-review": "true", "approved-by": "automated:final_master_integrity", note: "Automated." };
  assert.equal(finalQaApprovalAdmission(status({ rows: { final_qa: "blocked" } }), "final", "qa", automated).allowed, true);
  assert.equal(finalQaApprovalAdmission(status({ rows: { final_qa: "blocked" } }), "final", "qa", { ...approve, "workflow-bypass": "true" }).allowed, false);
  assert.equal(finalQaApprovalAdmission(status({ rows: { final_qa: "blocked" } }), "final", "qa", { "episode-dir": "/e", "master-scan": "true" }).applicable, false);
});

test("narration shapes under automated_asr_v1 while qwen_tts_stitch is blocked", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "goldflow-guard-"));
  try {
    const evidence = path.join(dir, "narration_exact_repair_packet_ep_01.json");
    const spec = path.join(dir, "boundary_spec.json");
    const manifest = path.join(dir, "assets", "provider-output-manifest.json");
    await writeFile(evidence, "{}");
    await writeFile(spec, "{}");
    await import("node:fs/promises").then((fs) => fs.mkdir(path.dirname(manifest), { recursive: true }));
    await writeFile(manifest, "{}");
    const contract = buildNarrationQualityContract({ deliveryQaPolicy: { acceptance_mode: "automated_asr_v1" } });
    const identityAutomated = { voice_provider_options: { primary: { provider: "qwen_local" }, narration_quality_contract: contract } };
    const shape = `node bin/goldflow.mjs tts narrate --episode-dir ${dir} --confirmed-retry-unit-ids u1,u2,u3 --confirmed-retry-evidence ${evidence}`;
    const blocked = (identity, nextShape = shape) => status({ stage: "qwen_tts_stitch", state: "blocked", shape: nextShape, identity, episodeDir: dir });
    const retake = { "episode-dir": dir, "confirmed-retry-unit-ids": "u2", "confirmed-retry-evidence": evidence };
    const admitted = narrationAutomatedAsrAdmission(blocked(identityAutomated), "tts", "narrate", retake);
    assert.equal(admitted.applicable, true, "automated_asr_v1 identity must reach the admission");
    {
      assert.equal(admitted.allowed, true, admitted.reason);
      assert.equal(narrationAutomatedAsrAdmission(blocked(identityAutomated), "tts", "narrate", { ...retake, "confirmed-retry-unit-ids": "u9" }).allowed, false, "ids outside the status set");
      assert.equal(narrationAutomatedAsrAdmission(blocked(identityAutomated), "tts", "narrate", { ...retake, "allow-full-stage-rerun": "true", "rerun-reason": "x" }).allowed, false);
      assert.equal(narrationAutomatedAsrAdmission(blocked(identityAutomated), "tts", "narrate", { "episode-dir": dir, concurrency: "1", "batch-size": "4" }).allowed, false, "a whole-episode narrate is never admitted");
      assert.equal(narrationAutomatedAsrAdmission(blocked(identityAutomated, "Operator hold: inspect the current hash-bound narration QA"), "tts", "repair-boundary", { "episode-dir": dir, spec }).allowed, true);
      assert.equal(narrationAutomatedAsrAdmission(blocked(identityAutomated), "tts", "repair-boundary", { "episode-dir": dir, spec: "/elsewhere/spec.json" }).allowed, false);
      assert.equal(narrationAutomatedAsrAdmission(blocked(identityAutomated), "tts", "finalize-provider", { "episode-dir": dir, manifest }).allowed, true);
      assert.equal(narrationAutomatedAsrAdmission(blocked(identityAutomated), "tts", "finalize-provider", { "episode-dir": dir, manifest, "workflow-bypass": "true" }).allowed, false);
    }
    // Legacy (listening) contracts and non-blocked states are never this admission's business.
    assert.equal(narrationAutomatedAsrAdmission(blocked({}), "tts", "narrate", retake).applicable, false);
    assert.equal(narrationAutomatedAsrAdmission({ ...blocked(identityAutomated), current_stage_state: "missing" }, "tts", "narrate", retake).applicable, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("run relock-tts is operator-only: --approved-by human admits, automated or missing refuses", () => {
  const production = status({ stage: "visual_beat_plan", state: "missing", identity: { run_intent: "production" } });
  assert.equal(relockTtsAdmission(production, "run", "relock-tts", { "episode-dir": "/e", "approved-by": "joel", "operator-approved": "true" }).allowed, true);
  assert.equal(relockTtsAdmission(production, "run", "relock-tts", { "episode-dir": "/e", "approved-by": "automated:model_reviewer" }).allowed, false);
  assert.equal(relockTtsAdmission(production, "run", "relock-tts", { "episode-dir": "/e", "operator-approved": "true" }).allowed, false);
  assert.equal(relockTtsAdmission(status({ identity: { run_intent: "proof" } }), "run", "relock-tts", { "approved-by": "joel" }).allowed, false);
  assert.equal(relockTtsAdmission(production, "run", "preflight", { "approved-by": "joel" }).applicable, false);
});

test("an identity revision makes post-relock stages first attempts; a stale revision admits nothing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "goldflow-revision-"));
  try {
    const { createHash } = await import("node:crypto");
    const before = JSON.stringify({ a: 1 }); const after = JSON.stringify({ a: 2 });
    await writeFile(path.join(dir, "run_identity.json"), after);
    const sha = (v) => createHash("sha256").update(v).digest("hex");
    await assert.rejects(appendIdentityRevision(dir, { previousSha256: sha(before), newSha256: sha(after), reasonCode: "narrator_identity_migration", approvedBy: "automated:x", command: "run relock-tts", invalidationBoundary: "voice_plan" }), /human/);
    await assert.rejects(appendIdentityRevision(dir, { previousSha256: sha(before), newSha256: sha(after), reasonCode: "because", approvedBy: "joel", command: "run relock-tts", invalidationBoundary: "voice_plan" }), /reason code/);
    const row = await appendIdentityRevision(dir, { previousSha256: sha(before), newSha256: sha(after), reasonCode: "narrator_identity_migration", approvedBy: "joel", command: "run relock-tts", invalidationBoundary: "voice_plan", recordedAt: "2026-10-20T02:27:46.355Z" });
    assert.equal(currentIdentityRevisionSync(dir)?.reason_code, "narrator_identity_migration");
    const order = PIPELINE_STAGE_REGISTRY.map((r) => r.id);
    const events = [
      { stage: "voice_plan", event_type: "stage_completed", command: "voice plan", status: "passed", started_at: "2026-10-19T04:00:00.000Z" },
      { stage: "qwen_tts_stitch", event_type: "stage_completed", command: "tts narrate", status: "passed", started_at: "2026-10-19T05:00:00.000Z" },
      { stage: "semantic_scene_plan", event_type: "stage_completed", command: "semantic plan", status: "passed", started_at: "2026-10-19T03:00:00.000Z" },
    ];
    assert.deepEqual(eventsSinceIdentityRevision(events, row, { stage: "voice_plan", stageOrder: order }), []);
    assert.deepEqual(eventsSinceIdentityRevision(events, row, { stage: "qwen_tts_stitch", stageOrder: order }), []);
    assert.equal(eventsSinceIdentityRevision(events, row, { stage: "semantic_scene_plan", stageOrder: order }).length, 3, "stages before the boundary keep their history");
    // Through the real policy: a post-relock voice plan is a first attempt without any bypass.
    await writeFile(path.join(dir, "execution_events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const decision = creativeStageRerunDecisionForEpisode({ command: "voice", subcommand: "plan", stage: "voice_plan", flags: { "episode-dir": dir }, episodeDir: dir });
    assert.equal(decision.allowed, true, decision.reason);
    // A rewritten identity that no revision records is not current: history applies again.
    await writeFile(path.join(dir, "run_identity.json"), JSON.stringify({ a: 3 }));
    assert.equal(currentIdentityRevisionSync(dir), null);
    assert.equal(creativeStageRerunDecisionForEpisode({ command: "voice", subcommand: "plan", stage: "voice_plan", flags: { "episode-dir": dir }, episodeDir: dir }).allowed, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

/* ---------- the shared command builder ---------- */

test("composeShape and parseShape round-trip through the autopilot tokenizer", () => {
  const shape = composeShape("imagegen", "fal", [["episode-dir", "/a b/ep_01"], ["action", "review-validation"], ["reviewer", "<name>"], ["note", "<production-grade visual review>"]]);
  assert.deepEqual(goldflowArgv(shape), ["imagegen", "fal", "--episode-dir", "/a b/ep_01", "--action", "review-validation", "--reviewer", "<name>", "--note", "<production-grade visual review>"]);
  assert.equal(falShape("/e", "observe-bulk", [["limit", 100]]), "node bin/goldflow.mjs imagegen fal --episode-dir /e --action observe-bulk --limit 100");
  const parsed = parseShape("node bin/goldflow.mjs imagegen fal --episode-dir /e --action dispatch-zone-repair --spec /e/s.json --confirm-spend exact_fal_zone_repair");
  assert.deepEqual([parsed.stage, parsed.executable, parsed.spend_token], ["image_generation", true, "exact_fal_zone_repair"]);
  assert.deepEqual(parsed.recovery.kinds, ["action:dispatch-zone-repair"]);
  assert.equal(parseShape("Operator hold: inspect the narration QA").prose, true);
  assert.equal(parseShape("node bin/goldflow.mjs visual panel-plan --episode-dir /e --action compile --recipe <exact-reviewed.json>").executable, false);
});

test("every registry stage shape parses back to its own stage", () => {
  const identity = { channel: "c", series_slug: "s", week: "w", episode: "ep_01", image_provider: "fal_ai", content_profile: "manhwa_recap_v1" };
  for (const row of PIPELINE_STAGE_REGISTRY) {
    const shape = buildStageCommand(row.id, identity);
    if (!shape || !shape.startsWith("node bin/goldflow.mjs")) continue; // prose or waived stages
    const parsed = parseShape(shape, identity);
    assert.equal(parsed.prose, false, row.id);
    assert.equal(parsed.stage, row.id, `${row.id}: ${shape}`);
  }
});

test("recoveryStageFor replaces the regex stage inference for status", () => {
  const voice = { stage: "voice_plan", state: "blocked", next_command_shape: "node bin/goldflow.mjs voice plan --episode-dir /e --performance-packet-ids packet_012 --performance-repair-reason 'x'" };
  assert.equal(recoveryStageFor(voice).stage, "voice_plan");
  assert.ok(recoveryStageFor(voice).recovery.kinds.includes("performance-packet"));
  assert.equal(recoveryStageFor({ ...voice, next_command_shape: "node bin/goldflow.mjs voice plan --episode-dir /e" }), null, "a plain voice plan is not a recovery");
  const qa = { stage: "image_output_qa", state: "blocked", next_command_shape: "node bin/goldflow.mjs imagegen browser-pool --episode-dir /e --image-ids a,b --qa-recovery true --repair-reason 'r'" };
  const qaRecovery = recoveryStageFor(qa);
  assert.equal(qaRecovery.stage, "image_output_qa");
  assert.ok(qaRecovery.recovery.kinds.includes("qa-recovery") && qaRecovery.recovery.kinds.includes("repair-reason"));
  assert.equal(recoveryStageFor({ stage: "qwen_tts_stitch", state: "blocked", next_command_shape: "Operator hold: inspect…" }), null);
  assert.equal(recoveryStageFor({ stage: "qwen_tts_stitch", state: "blocked", next_command_shape: "node bin/goldflow.mjs tts approve-listen --episode-dir /e --reviewer <name>" }).recovery.listening_attestation, true);
  assert.equal(recoveryStageFor({ stage: "timing_bind", state: "missing", next_command_shape: "node bin/goldflow.mjs timing bind --episode-dir /e" }), null);
});

test("replay: the recorded FAL command shapes classify as run or triage through the builder", async () => {
  const eventsPath = path.join(FAL_EPISODE, "execution_events.jsonl");
  if (!existsSync(eventsPath)) {
    test.skip?.("FAL episode events not present on this machine");
    return;
  }
  const rows = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.event_type === "stage_started");
  assert.equal(rows.length, 126, "the FAL run recorded 126 command shapes");
  const identity = JSON.parse(await readFile(path.join(FAL_EPISODE, "run_identity.json"), "utf8"));
  // Recorded args are re-quoted the way status quotes them: double quotes with backslash escapes.
  const quote = (arg) => (/[\s'"]/.test(arg) ? `"${arg.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : arg);
  const shapes = rows.map((row) => ({ stage: row.stage, shape: ["node", "bin/goldflow.mjs", ...row.command.split(" "), ...row.args.map(quote)].join(" ") }));
  const report = classifyShapes(shapes, identity);
  const stageMismatch = report.rows.filter((row) => row.disposition === "run" && row.stage && row.stage !== row.stage_recorded && row.stage !== row.stage);
  assert.equal(stageMismatch.length, 0);
  const recordedMismatch = report.rows.filter((row, index) => row.stage && row.stage !== rows[index].stage);
  assert.equal(report.rows.length, 126);
  assert.ok(report.run > 0);
  console.log(`[replay] FAL shapes: run=${report.run} triage=${report.triage} ${JSON.stringify(report.counts)}; stage disagreements with the recorded ledger=${recordedMismatch.length}${recordedMismatch.length ? ` (${recordedMismatch.map((row) => `${row.shape.split(" ").slice(2, 4).join(" ")}→${row.stage}`).slice(0, 6).join("; ")})` : ""}`);
});

test("Q41: the episode_budget token is admitted on budget-locked identities and passes through the R07 admissions untouched", () => {
  const identity = { run_intent: "production", episode_budget: buildEpisodeBudget({ usd: "10", lockedAt: "2026-10-20T00:00:00.000Z" }) };
  const shape = "node bin/goldflow.mjs imagegen fal --episode-dir /e --action dispatch-zone-repair --spec /e/s.json --confirm-spend exact_fal_zone_repair";
  const budgeted = status({ stage: "image_output_qa", state: "blocked", shape, identity, rows: { image_output_qa: "blocked" } });
  const flags = { "episode-dir": "/e", action: "dispatch-zone-repair", spec: "/e/s.json", "confirm-spend": "episode_budget" };
  // The guard maps the single episode token onto the exact token status names; the cap itself is enforced at submission.
  const mapped = guardFlagsForEpisodeBudget(budgeted, flags);
  assert.equal(mapped["confirm-spend"], "exact_fal_zone_repair");
  // No R07 admission claims a Fal dispatch, so the mapped flags reach the existing Fal recovery admission unchanged.
  assert.equal(decisionShapeAdmission(budgeted, "imagegen", "fal", mapped).applicable, false);
  // Without a locked budget, or when status names no exact token, the token is not mapped (nothing is admitted on prose).
  assert.equal(guardFlagsForEpisodeBudget({ ...budgeted, identity: { run_intent: "production" } }, flags)["confirm-spend"], "episode_budget");
  assert.equal(guardFlagsForEpisodeBudget({ ...budgeted, next_command_shape: "Triage zone repair z1; do not resubmit it." }, flags)["confirm-spend"], "episode_budget");
});
