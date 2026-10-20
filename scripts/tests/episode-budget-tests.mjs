import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildEpisodeBudget, episodeBudgetFor, parseEpisodeBudgetUsd, assertEpisodeBudget, episodeSpendState, recordEpisodeSpend, spendAuthorization, guardFlagsForEpisodeBudget,
  EpisodeBudgetExceededError, EPISODE_BUDGET_SPEND_TOKEN,
} from "../lib/episode-budget.mjs";

const lockedAt = "2026-10-20T00:00:00.000Z";

async function episode(identity) {
  const episodeDir = await mkdtemp(path.join(os.tmpdir(), "goldflow-episode-budget-"));
  await writeFile(path.join(episodeDir, "run_identity.json"), JSON.stringify(identity));
  return episodeDir;
}
async function falReceipt(episodeDir, relativeDir, id) {
  const dir = path.join(episodeDir, "fal", relativeDir);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${id}.json`), JSON.stringify({ schema: "goldflow_fal_submission_receipt_v1",
    image_id: id, assignment_sha256: "a".repeat(64), request_id: `request-${id}` }));
}

test("episode budget flag parses strictly and locks a bounded USD cap", () => {
  assert.equal(parseEpisodeBudgetUsd("12.50"), 12.5);
  for (const bad of ["0", "-1", "abc", "12.345", "201", ""]) assert.throws(() => parseEpisodeBudgetUsd(bad));
  const budget = buildEpisodeBudget({ usd: "8", lockedAt });
  assert.deepEqual(budget, { schema: "goldflow_episode_budget_v1", usd_cap: 8, currency: "USD",
    authorizes: "automatic_paid_dispatch_within_cap", spend_token: "episode_budget", hard_caps_preserved: true, locked_at: lockedAt });
  assert.equal(episodeBudgetFor({ episode_budget: budget }).usd_cap, 8);
  assert.equal(episodeBudgetFor({ episode_budget: { ...budget, usd_cap: 9999 } }), null);
  assert.equal(episodeBudgetFor({}), null);
});

test("exact tokens keep working; the episode token needs a locked budget", () => {
  const locked = { episode_budget: buildEpisodeBudget({ usd: "5", lockedAt }) };
  assert.deepEqual(spendAuthorization({ identity: {}, flags: { "confirm-spend": "exact_fal_bulk_batch" }, token: "exact_fal_bulk_batch" }),
    { authorized: true, basis: "exact_token", token: "exact_fal_bulk_batch" });
  assert.equal(spendAuthorization({ identity: {}, flags: { "confirm-spend": EPISODE_BUDGET_SPEND_TOKEN }, token: "exact_fal_bulk_batch" }).authorized, false);
  assert.deepEqual(spendAuthorization({ identity: locked, flags: { "confirm-spend": EPISODE_BUDGET_SPEND_TOKEN }, token: "exact_fal_zone_repair" }),
    { authorized: true, basis: "episode_budget", token: "exact_fal_zone_repair" });
  assert.equal(spendAuthorization({ identity: locked, flags: { "confirm-spend": "exact_fal_wrong" }, token: "exact_fal_zone_repair" }).authorized, false);
  assert.equal(spendAuthorization({ identity: locked, flags: {}, token: "exact_fal_zone_repair" }).authorized, false);
});

test("guard admission maps the episode token onto the exact token status names", () => {
  const status = { identity: { episode_budget: buildEpisodeBudget({ usd: "5", lockedAt }) },
    next_command_shape: "node bin/goldflow.mjs imagegen fal --episode-dir /x --action dispatch-zone-repair --spec /x/s.json --confirm-spend exact_fal_zone_repair" };
  assert.equal(guardFlagsForEpisodeBudget(status, { "confirm-spend": "episode_budget" })["confirm-spend"], "exact_fal_zone_repair");
  assert.equal(guardFlagsForEpisodeBudget({ ...status, identity: {} }, { "confirm-spend": "episode_budget" })["confirm-spend"], "episode_budget");
  const exact = { "confirm-spend": "exact_fal_bulk_batch" };
  assert.equal(guardFlagsForEpisodeBudget(status, exact), exact);
});

test("dispatch within the cap writes an authorization receipt; overspend is a hard stop", async () => {
  const identity = { episode_budget: buildEpisodeBudget({ usd: "0.10", lockedAt }) };
  const episodeDir = await episode(identity);
  try {
    // Two paid Fal submissions project $0.044 at the conservative observed rate.
    await falReceipt(episodeDir, "bulk/submission-receipts", "a");
    await falReceipt(episodeDir, "bulk/submission-receipts", "b");
    const state = await episodeSpendState({ episodeDir, identity });
    assert.equal(state.spent_usd, 0.044);
    assert.equal(state.remaining_usd, 0.056);
    const ok = await assertEpisodeBudget({ episodeDir, identity, requestedUsd: 0.044, scope: "fal_dispatch-bulk", basis: "episode_budget", now: lockedAt });
    assert.equal(ok.status, "authorized");
    assert.equal(ok.projected_after_usd, 0.088);
    const receipts = await readdir(path.join(episodeDir, "episode_budget", "authorizations"));
    assert.equal(receipts.length, 1);
    const receipt = JSON.parse(await readFile(path.join(episodeDir, "episode_budget", "authorizations", receipts[0]), "utf8"));
    assert.equal(receipt.schema, "goldflow_episode_budget_authorization_v1");
    assert.equal(receipt.basis, "episode_budget");
    assert.match(receipt.run_identity_sha256, /^[a-f0-9]{64}$/);
    // A preflight check does not write a receipt.
    assert.equal((await assertEpisodeBudget({ episodeDir, identity, requestedUsd: 0.01, scope: "fal_repair", basis: "episode_budget", record: false })).status, "within_cap");
    assert.equal((await readdir(path.join(episodeDir, "episode_budget", "authorizations"))).length, 1);
    // Non-Fal spend counts against the same cap.
    await recordEpisodeSpend({ episodeDir, provider: "thumbnail_route", usd: 0.05, scope: "packaging", now: lockedAt });
    await assert.rejects(
      assertEpisodeBudget({ episodeDir, identity, requestedUsd: 0.022, scope: "fal_dispatch-zone-repair", basis: "episode_budget" }),
      (error) => error instanceof EpisodeBudgetExceededError && /^Episode budget hard stop:/.test(error.message) && error.state.spent_usd === 0.094,
    );
    assert.equal((await readdir(path.join(episodeDir, "episode_budget", "authorizations"))).length, 1);
  } finally {
    await rm(episodeDir, { recursive: true, force: true });
  }
});

test("a run without a locked budget is unaffected by the episode cap", async () => {
  const episodeDir = await episode({});
  try {
    assert.deepEqual(await assertEpisodeBudget({ episodeDir, identity: {}, requestedUsd: 1000, scope: "fal", basis: "exact_token" }), { status: "not_locked" });
  } finally {
    await rm(episodeDir, { recursive: true, force: true });
  }
});

test("malformed spend records fail closed", async () => {
  const identity = { episode_budget: buildEpisodeBudget({ usd: "1", lockedAt }) };
  const episodeDir = await episode(identity);
  try {
    await mkdir(path.join(episodeDir, "episode_budget", "spend"), { recursive: true });
    await writeFile(path.join(episodeDir, "episode_budget", "spend", "0001_x.json"), JSON.stringify({ schema: "other", usd: -1 }));
    await assert.rejects(episodeSpendState({ episodeDir, identity }), /Invalid episode spend record/);
  } finally {
    await rm(episodeDir, { recursive: true, force: true });
  }
});
