#!/usr/bin/env node
// R02: real cost recording. Billing reconciliation is append-only and optional
// (missing key / 403 -> billing_status unavailable without blocking); projections
// use the measured per-endpoint/canvas table or the episode's billed median;
// per-request caps are 3x measured, locked, never raised; stage events sum
// billed CLI cost and billed-or-projected Fal cost. No network, no spend: the
// real FAL episode is only replayed in dry-run and never written to.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectFalResultReceipts, reconcileFalBilling, FAL_ENDPOINTS } from "../lib/fal-provider.mjs";
import {
  FAL_DEFAULT_PAID_REQUEST_USD, FAL_MEASURED_PAID_REQUEST_USD, FAL_PROJECTED_PAID_REQUEST_USD,
  buildFalPerRequestCaps, falBilledRateState, falPerRequestCapUsd, falProjectedRateUsd, falProjectedSpendUsd,
  falSpendProjectionState, falSubmissionCostState,
} from "../lib/fal-retry-budget.mjs";
import { buildEpisodeBudget, episodeSpendState, listSequencedRecords } from "../lib/episode-budget.mjs";
import { beginStageExecution, finishStageExecution, providerCallUsageSince } from "../lib/execution-provenance.mjs";
import { commandStageFor } from "../lib/pipeline-stage-registry.mjs";
import { createFalRestartIdentity } from "../lib/fal-visual-restart.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FAL_EPISODE = "/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/2026-W43-coma-healer-fal-panel-v1/episodes/ep_01";
const EDIT = FAL_ENDPOINTS.primary_edit, TEXT = FAL_ENDPOINTS.primary_text;
const exists = (file) => fs.stat(file).then(() => true, () => false);

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
async function episode({ identity = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fal-billing-"));
  await writeJson(path.join(dir, "run_identity.json"), identity);
  return dir;
}
async function submission(dir, relativeDir, id, { endpoint = EDIT, size = { width: 1920, height: 1080 } } = {}) {
  await writeJson(path.join(dir, "fal", relativeDir, `${id}.json`), { schema: "goldflow_fal_submission_receipt_v1", image_id: id,
    assignment_sha256: "a".repeat(64), request_id: `req-${id}`, endpoint, params: { image_size: size }, submitted_at: "2026-10-19T16:00:00.000Z" });
}
async function result(dir, relativeDir, id, { endpoint = EDIT, size = { width: 1920, height: 1080 }, completedAt = "2026-10-19T16:30:00.000Z" } = {}) {
  await writeJson(path.join(dir, "fal", relativeDir, `${id}.json`), { schema: "goldflow_fal_result_receipt_v1", completed_at: completedAt,
    endpoint, request_id: `req-${id}`, width: size.width, height: size.height, output_sha256: "b".repeat(64) });
}
function billingFetch(costsByRequestId, { status = 200 } = {}) {
  const calls = [];
  return { calls, fetchImpl: async (url, init) => {
    const parsed = new URL(url);
    calls.push({ endpoint_id: parsed.searchParams.get("endpoint_id"), start: parsed.searchParams.get("start"), end: parsed.searchParams.get("end"), auth: init?.headers?.Authorization ?? null });
    if (status !== 200) return { ok: false, status, json: async () => ({}) };
    const events = Object.entries(costsByRequestId).map(([request_id, cost]) => ({ request_id, cost_total: cost, timestamp: "2026-10-19T17:00:00Z", quantity: 1 }));
    return { ok: true, status: 200, json: async () => ({ billing_events: events, has_more: false }) };
  } };
}

test.before(() => { process.env.FAL_BILLING_KEY = "test:billing-key"; });
test.after(() => { delete process.env.FAL_BILLING_KEY; });

test("measured rates replace the $0.022 constant; caps are 3x measured and a locked table is never raised", () => {
  assert.equal(FAL_DEFAULT_PAID_REQUEST_USD, 0.0176);
  assert.equal(FAL_PROJECTED_PAID_REQUEST_USD, 0.0176);
  assert.equal(falProjectedSpendUsd(658), 11.5808);
  assert.equal(FAL_MEASURED_PAID_REQUEST_USD[EDIT]["3840x2160"], 0.0263);
  assert.equal(falProjectedRateUsd({ endpoint: TEXT, imageSize: { width: 1920, height: 1080 } }).rate_usd, 0.0061);
  assert.equal(falProjectedRateUsd({ endpoint: EDIT, imageSize: { width: 3840, height: 2160 } }).rate_source, "measured_table");
  const caps = buildFalPerRequestCaps();
  assert.equal(caps[EDIT]["1920x1080"], 0.0528);
  assert.equal(caps[EDIT]["3840x2160"], 0.0789);
  assert.equal(caps[TEXT]["1920x1080"], 0.0183);
  assert.equal(falPerRequestCapUsd({ endpoint: EDIT, imageSize: { width: 1920, height: 1080 } }), 0.0528);
  const locked = { [EDIT]: { "1920x1080": 0.04 } };
  assert.equal(falPerRequestCapUsd({ endpoint: EDIT, imageSize: { width: 1920, height: 1080 }, caps: locked }), 0.04, "the identity's locked cap wins");
  assert.equal(falPerRequestCapUsd({ endpoint: EDIT, imageSize: { width: 3840, height: 2160 }, caps: locked }), 0.0789, "rows absent from the lock read the built-in table");
  assert.equal(commandStageFor("imagegen", "fal", { action: "billing-reconcile" }, {}), null, "reconciliation belongs to no stage and spends nothing");
});

test("a new Fal restart identity locks the cap table with the budget; a locked table is carried, never recomputed", async () => {
  const { mediaWorkflowForPreflight } = await import("../lib/media-workflows.mjs");
  const baseline = { schema: "goldflow_run_identity_v2", episode: "ep_01", episode_dir: "/b", week: "baseline", run_intent: "production", content_profile: "manhwa_recap_v1",
    ...mediaWorkflowForPreflight({ contentProfile: "manhwa_recap_v1", mediaWorkflow: "generated_visuals_v1" }),
    audio_target: "narrator_only", image_provider: "codex_imagegen", provider_locks: {}, model_versions: {} };
  const contract = { schema: "goldflow_fal_image_contract_v1", endpoints: FAL_ENDPOINTS, warning_budget_usd: 30, hard_budget_usd: 35, production_concurrency: 20, validation_concurrency: 8 };
  const make = (extra) => createFalRestartIdentity({ baseline, targetDir: "/t", week: "w", contract: { ...contract, ...extra }, git: {}, receiptSha256: "c".repeat(64), baselineIdentitySha256: "d".repeat(64), createdAt: "2026-10-20T00:00:00.000Z" });
  const next = make({});
  assert.deepEqual(next.image_provider_options.fal.per_request_caps_usd, buildFalPerRequestCaps());
  assert.equal(next.image_provider_options.fal.per_request_caps_locked_at, "2026-10-20T00:00:00.000Z");
  const lower = { [EDIT]: { "1920x1080": 0.04 } };
  assert.deepEqual(make({ per_request_caps_usd: lower }).image_provider_options.fal.per_request_caps_usd, lower);
});

test("billing-reconcile appends cost_reconciled records tied to request IDs; later runs query only unbilled IDs", async () => {
  const dir = await episode();
  try {
    await result(dir, "bulk/result-receipts", "s1"); await result(dir, "bulk/result-receipts", "s2");
    await result(dir, "reference/result-receipts", "r1", { endpoint: TEXT });
    await result(dir, "bulk/review-repair-result-receipts", "s3", { size: { width: 3840, height: 2160 }, completedAt: "2026-10-19T18:00:00.000Z" });
    const receipts = await collectFalResultReceipts(dir);
    assert.deepEqual(receipts.map((row) => row.request_id), ["req-r1", "req-s1", "req-s2", "req-s3"]);
    assert.equal(receipts.find((row) => row.request_id === "req-s3").image_size.width, 3840);

    const first = billingFetch({ "req-s1": 0.0170, "req-s2": 0.0182, "req-r1": 0.0061 });
    const run1 = await reconcileFalBilling({ episodeDir: dir, fetchImpl: first.fetchImpl, now: "2026-10-20T12:00:00.000Z" });
    assert.equal(run1.record.schema, "goldflow_fal_cost_reconciled_v1");
    assert.equal(run1.record.billing_status, "partial");
    assert.equal(run1.record.billed_count, 3);
    assert.deepEqual(run1.record.missing_request_ids, ["req-s3"]);
    assert.equal(run1.record.total_billed_usd, 0.0413);
    assert.equal(run1.record.key_source, "env_fal_billing_key");
    assert.ok(!JSON.stringify(run1.record).includes("billing-key"), "the key never lands in a record");
    assert.deepEqual(first.calls.map((call) => call.endpoint_id).sort(), [EDIT, TEXT]);
    const editQuery = first.calls.find((call) => call.endpoint_id === EDIT);
    assert.equal(editQuery.start, "2026-10-19T15:30:00.000Z", "window opens one hour before the first completion");
    assert.equal(editQuery.end, "2026-10-20T00:00:00.000Z", "and closes six hours after the last one");
    assert.match(path.basename(run1.path), /^0001_cost_reconciled\.json$/);
    const billedRow = run1.record.rows.find((row) => row.request_id === "req-s1");
    assert.equal(billedRow.cost_basis, "billed");
    assert.match(billedRow.result_receipt_sha256, /^[a-f0-9]{64}$/);
    assert.equal(run1.record.median_usd_by_key[`${EDIT}|1920x1080`].median_usd, 0.0176);

    const second = billingFetch({ "req-s3": 0.0265 });
    const run2 = await reconcileFalBilling({ episodeDir: dir, fetchImpl: second.fetchImpl, now: "2026-10-20T12:00:00.000Z" });
    assert.equal(second.calls.length, 1, "only the unbilled 3840 edit is queried again");
    assert.equal(run2.record.previously_billed_count, 3);
    assert.equal(run2.record.billing_status, "billed");
    assert.match(path.basename(run2.path), /^0002_/);
    const run1Again = JSON.parse(await fs.readFile(run1.path, "utf8"));
    assert.equal(run1Again.sequence, 1, "earlier records are immutable");

    const state = await falBilledRateState(dir);
    assert.equal(state.billed_by_request_id.size, 4);
    assert.equal(state.median_usd_by_key[`${EDIT}|3840x2160`].median_usd, 0.0265);
    assert.equal(falProjectedRateUsd({ endpoint: EDIT, imageSize: { width: 1920, height: 1080 }, billedState: state }).rate_source, "episode_billed_median");

    // Spend accounting mixes billed (reconciled) and projected (unreconciled) submissions.
    await submission(dir, "bulk/submission-receipts", "s1"); await submission(dir, "bulk/submission-receipts", "s2");
    await submission(dir, "bulk/submission-receipts", "s9");
    await submission(dir, "reference/submission-receipts", "r1", { endpoint: TEXT });
    const spend = await falSpendProjectionState({ episodeDir: dir, warningBudgetUsd: 30, hardBudgetUsd: 35 });
    assert.equal(spend.paid_submissions, 4);
    assert.equal(spend.billed_count, 3);
    assert.equal(spend.cost_basis, "mixed");
    assert.equal(spend.projected_spend_usd, 0.0589, "0.0170 + 0.0182 + 0.0061 billed, s9 at the billed median 0.0176");
    assert.deepEqual(spend.rate_sources, ["episode_billed_median"]);
    assert.equal(spend.actual_charge_usd, 0.0413);
    const identity = { episode_budget: buildEpisodeBudget({ usd: "1", lockedAt: "2026-10-20T00:00:00.000Z" }) };
    const budget = await episodeSpendState({ episodeDir: dir, identity });
    assert.equal(budget.fal_billed_usd, 0.0413);
    assert.equal(budget.fal_cost_basis, "mixed");
    assert.equal(budget.spent_usd, 0.0589);
    assert.equal(budget.estimate_only, true);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("a 403 (or missing) billing key records billing_status unavailable without blocking or printing a key", async () => {
  const dir = await episode();
  try {
    await result(dir, "bulk/result-receipts", "s1");
    const denied = billingFetch({}, { status: 403 });
    const run = await reconcileFalBilling({ episodeDir: dir, fetchImpl: denied.fetchImpl });
    assert.equal(run.record.billing_status, "unavailable");
    assert.match(run.record.unavailable_reason, /billing permission/);
    assert.deepEqual(run.record.missing_request_ids, ["req-s1"]);
    assert.ok(await exists(run.path));
    assert.ok(!JSON.stringify(run.record).includes("billing-key"));
    await submission(dir, "bulk/submission-receipts", "s1");
    const spend = await falSpendProjectionState({ episodeDir: dir, warningBudgetUsd: 30, hardBudgetUsd: 35 });
    assert.equal(spend.cost_basis, "projected", "guards keep using the projection");
    assert.equal(spend.projected_spend_usd, 0.0176);
    assert.equal(spend.estimate_only, true);
    assert.equal(spend.actual_charge_usd, null);
    assert.equal(falSubmissionCostState([{ request_id: "req-x", endpoint: EDIT, image_size: null }], await falBilledRateState(dir)).cost_basis, "projected");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("stage events sum the Claude cost field and codex tokens from call receipts, and debit the episode budget", async () => {
  const identity = { episode_budget: buildEpisodeBudget({ usd: "5", lockedAt: "2026-10-20T00:00:00.000Z" }) };
  const dir = await episode({ identity });
  try {
    await writeJson(path.join(dir, "reports", "old", "earlier.json.meta.json"), { schema: "goldflow_codex_call_metadata_v1", status: "passed", provider: "claude_cli", provider_cost_usd: 9.99, started_at: "2026-01-01T00:00:00.000Z" });
    const execution = await beginStageExecution({ stage: "visual_plan", command: "visual plan", flags: { "episode-dir": dir }, repoRoot });
    await writeJson(path.join(dir, "reports", "planner", "chunk_001.json.meta.json"), { schema: "goldflow_codex_call_metadata_v1", status: "passed", provider: "codex_cli",
      provider_usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50 }, provider_cost_usd: null, started_at: execution.started_at,
      attempts: [{ attempt: 1, class: "transport" }, { attempt: 2, class: "passed" }] });
    await writeJson(path.join(dir, "reports", "planner", "chunk_001.json.attempt-1.meta.json"), { schema: "goldflow_codex_call_attempt_v1", attempt: 1 });
    await writeJson(path.join(dir, "reports", "planner", "review.json.meta.json"), { schema: "goldflow_codex_call_metadata_v1", status: "passed", provider: "claude_cli",
      provider_usage: { input_tokens: 400, output_tokens: 20 }, provider_cost_usd: 0.12, started_at: execution.started_at });
    const usage = await providerCallUsageSince(dir, execution.started_at);
    assert.equal(usage.call_count, 2, "receipts from before the execution are excluded");
    assert.deepEqual(usage.by_provider.codex_cli.usage_totals, { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50 });
    assert.equal(usage.by_provider.codex_cli.cost_usd, null, "subscription CLI: tokens recorded, dollars null");
    assert.equal(usage.by_provider.codex_cli.transport_retries, 1);
    assert.equal(usage.by_provider.codex_cli.attempts, 2);
    assert.equal(usage.by_provider.claude_cli.cost_usd, 0.12);
    const report = await finishStageExecution(execution, { exitCode: 0 });
    assert.equal(report.cost_usd, 0.12);
    assert.equal(report.cost_basis, "billed");
    assert.equal(report.provider_calls.call_count, 2);
    const events = (await fs.readFile(path.join(dir, "execution_events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const completed = events.find((row) => row.event_type === "stage_completed");
    assert.equal(completed.cost_usd, 0.12);
    assert.equal(completed.provider_calls.by_provider.claude_cli.cost_usd, 0.12);
    const spend = await listSequencedRecords(dir, "episode_budget/spend");
    assert.equal(spend.length, 1);
    assert.deepEqual([spend[0].record.provider, spend[0].record.usd, spend[0].record.cost_basis], ["claude_cli", 0.12, "billed"]);
    assert.equal((await episodeSpendState({ episodeDir: dir, identity })).spent_usd, 0.12);
    const manifest = JSON.parse(await fs.readFile(path.join(dir, "production_manifest.json"), "utf8").catch(() => "{}"));
    if (manifest.cost) assert.equal(manifest.cost.provider_call_cost_usd, 0.12);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("an imagegen fal execution records the projected cost of the submissions it created", async () => {
  const dir = await episode();
  try {
    await submission(dir, "bulk/submission-receipts", "old");
    const execution = await beginStageExecution({ stage: "image_generation", command: "imagegen fal", flags: { "episode-dir": dir, action: "dispatch-bulk" }, repoRoot });
    await submission(dir, "bulk/submission-receipts", "n1");
    await submission(dir, "bulk/submission-receipts", "n2", { size: { width: 3840, height: 2160 } });
    const report = await finishStageExecution(execution, { exitCode: 0 });
    assert.deepEqual([report.fal_cost.new_submissions, report.fal_cost.usd, report.fal_cost.cost_basis], [2, 0.0439, "projected"]);
    assert.equal(report.cost_usd, 0.0439);
    assert.equal(report.cost_basis, "projected");
    assert.equal((await listSequencedRecords(dir, "episode_budget/spend")).length, 0, "Fal spend is read from receipts, never double-recorded");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("dry-run replay of the FAL episode's 787 request IDs plans the billing queries without network or writes", { skip: !(await exists(path.join(FAL_EPISODE, "fal"))) && "FAL episode not present" }, async () => {
  const billingDir = path.join(FAL_EPISODE, "fal", "billing");
  const hadBillingDir = await exists(billingDir);
  const guardFetch = async () => { throw new Error("network must not be used in dry-run"); };
  const run = await reconcileFalBilling({ episodeDir: FAL_EPISODE, fetchImpl: guardFetch, dryRun: true, now: "2026-10-20T12:00:00.000Z" });
  assert.equal(run.path, null);
  assert.equal(run.record.billing_status, "dry_run");
  assert.equal(run.record.network, false);
  assert.equal(run.record.receipt_count, 787);
  assert.equal(run.record.queried_count, 787 - run.record.previously_billed_count);
  const byEndpoint = Object.fromEntries(run.record.queries.map((query) => [query.endpoint, query.request_count]));
  assert.equal(Object.values(byEndpoint).reduce((sum, count) => sum + count, 0), run.record.queried_count);
  assert.ok(byEndpoint[EDIT] > 0 && byEndpoint[TEXT] > 0, "the episode mixes edit and text-to-image requests");
  for (const query of run.record.queries) assert.ok(query.start < query.end && query.end <= "2026-10-20T12:00:00.000Z");
  const receipts = await collectFalResultReceipts(FAL_EPISODE);
  assert.equal(new Set(receipts.map((row) => row.request_id)).size, 787, "787 distinct request IDs");
  assert.equal(receipts.filter((row) => row.result_receipt_path.includes("/reference/result-receipts/")).length, 124);
  assert.equal(receipts.filter((row) => row.result_receipt_path.includes("/bulk/result-receipts/")).length, 650);
  assert.equal(await exists(billingDir), hadBillingDir, "dry-run never writes into the episode");
  // The CLI action, direct script in dry-run (the guard maps this action to no stage).
  const cli = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "fal-production.mjs"), "--episode-dir", FAL_EPISODE, "--action", "billing-reconcile", "--dry-run", "true"], { encoding: "utf8", env: { ...process.env, FAL_BILLING_KEY: "test:billing-key" } });
  assert.equal(cli.status, 0, cli.stderr);
  const summary = JSON.parse(cli.stdout);
  assert.equal(summary.status, "dry_run");
  assert.equal(summary.receipt_count, 787);
  assert.ok(!cli.stdout.includes("billing-key"));
  assert.equal(await exists(billingDir), hadBillingDir);
});
