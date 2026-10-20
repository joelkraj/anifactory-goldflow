import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { falPaidSubmissionCount, falProjectedSpendUsd } from "./fal-retry-budget.mjs";

// One episode spend budget replaces per-dispatch confirmation tokens. It is a
// cap, not a quote: Fal spend is projected from paid submission receipts at the
// conservative observed rate; other paid providers append spend records.
export const EPISODE_BUDGET_SPEND_TOKEN = "episode_budget";
export const EPISODE_BUDGET_AUTHORIZATION_SCHEMA = "goldflow_episode_budget_authorization_v1";
export const EPISODE_BUDGET_SPEND_RECORD_SCHEMA = "goldflow_episode_budget_spend_v1";
export const EPISODE_BUDGET_STOP_PREFIX = "Episode budget hard stop:";

export const EPISODE_BUDGET_SCHEMA = "goldflow_episode_budget_v1";
// Hard upper bound for a single episode budget; a typo must not authorize a large spend.
export const EPISODE_BUDGET_MAX_USD = 200;

function need(value, message) {
  if (!value) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function fileSha256(filePath) {
  try {
    return sha256(await fs.readFile(filePath));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function parseEpisodeBudgetUsd(value) {
  const text = String(value ?? "").trim();
  need(/^\d+(\.\d{1,2})?$/.test(text), "--episode-budget-usd must be a positive dollar amount with at most two decimals.");
  const usd = Number(text);
  need(usd > 0 && usd <= EPISODE_BUDGET_MAX_USD, `--episode-budget-usd must be greater than 0 and at most ${EPISODE_BUDGET_MAX_USD}.`);
  return usd;
}

/** The identity field locked at preflight by --episode-budget-usd. */
export function buildEpisodeBudget({ usd, lockedAt }) {
  return {
    schema: EPISODE_BUDGET_SCHEMA,
    usd_cap: parseEpisodeBudgetUsd(usd),
    currency: "USD",
    authorizes: "automatic_paid_dispatch_within_cap",
    spend_token: "episode_budget",
    hard_caps_preserved: true,
    locked_at: lockedAt,
  };
}

export function episodeBudgetFor(identity = {}) {
  const budget = identity?.episode_budget;
  if (budget?.schema !== EPISODE_BUDGET_SCHEMA || budget.currency !== "USD") return null;
  const usd = Number(budget.usd_cap);
  if (!Number.isFinite(usd) || usd <= 0 || usd > EPISODE_BUDGET_MAX_USD) return null;
  return { ...budget, usd_cap: usd };
}

/** Writes an append-only, exclusively created JSON record under episodeDir/<subdir>. */
export async function writeSequencedRecord(episodeDir, subdir, stem, record) {
  const dir = path.join(episodeDir, subdir);
  await fs.mkdir(dir, { recursive: true });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const sequence = (await fs.readdir(dir)).filter((name) => /^\d{4}_/.test(name)).length + 1;
    const filePath = path.join(dir, `${String(sequence).padStart(4, "0")}_${stem}.json`);
    try {
      await fs.writeFile(filePath, `${JSON.stringify({ ...record, sequence }, null, 2)}\n`, { flag: "wx" });
      return { path: filePath };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Could not allocate an append-only record in ${subdir}.`);
}

export async function listSequencedRecords(episodeDir, subdir) {
  const dir = path.join(episodeDir, subdir);
  const names = await fs.readdir(dir).catch((error) => (error.code === "ENOENT" ? [] : Promise.reject(error)));
  const rows = [];
  for (const name of names.filter((value) => /^\d{4}_.*\.json$/.test(value)).sort()) {
    rows.push({ path: path.join(dir, name), record: JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) });
  }
  return rows;
}

export class EpisodeBudgetExceededError extends Error {
  constructor(message, state) {
    super(`${EPISODE_BUDGET_STOP_PREFIX} ${message}`);
    this.name = "EpisodeBudgetExceededError";
    this.state = state;
  }
}

function roundUsd(value) {
  return Number(Number(value).toFixed(4));
}

/** Current projected episode spend from immutable receipts. */
export async function episodeSpendState({ episodeDir, identity }) {
  const budget = episodeBudgetFor(identity);
  const falSubmissions = await falPaidSubmissionCount(episodeDir);
  const falUsd = falProjectedSpendUsd(falSubmissions);
  const ledger = await listSequencedRecords(episodeDir, "episode_budget/spend");
  const otherUsd = ledger.reduce((sum, row) => {
    const usd = Number(row.record?.usd);
    if (row.record?.schema !== EPISODE_BUDGET_SPEND_RECORD_SCHEMA || !Number.isFinite(usd) || usd < 0) {
      throw new Error(`Invalid episode spend record: ${row.path}`);
    }
    return sum + usd;
  }, 0);
  const spentUsd = roundUsd(falUsd + otherUsd);
  return {
    budget_locked: Boolean(budget),
    cap_usd: budget?.usd_cap ?? null,
    spent_usd: spentUsd,
    remaining_usd: budget ? roundUsd(Math.max(0, budget.usd_cap - spentUsd)) : null,
    fal_paid_submissions: falSubmissions,
    fal_projected_usd: falUsd,
    other_spend_usd: roundUsd(otherUsd),
    estimate_only: true,
  };
}

/**
 * Refuses a dispatch whose projected spend would exceed the locked cap and
 * records an append-only authorization receipt when it fits. A run without a
 * locked budget is unaffected (its own hard caps still apply).
 */
export async function assertEpisodeBudget({ episodeDir, identity, requestedUsd, scope, basis, record = true, now = new Date().toISOString() }) {
  const budget = episodeBudgetFor(identity);
  if (!budget) return { status: "not_locked" };
  const requested = roundUsd(requestedUsd);
  if (!Number.isFinite(requested) || requested < 0) throw new Error("Episode budget check needs a nonnegative requested amount.");
  const state = await episodeSpendState({ episodeDir, identity });
  const projectedAfter = roundUsd(state.spent_usd + requested);
  if (projectedAfter > budget.usd_cap) {
    throw new EpisodeBudgetExceededError(`$${state.spent_usd} projected + $${requested} requested for ${scope} exceeds the locked $${budget.usd_cap} episode cap.`, state);
  }
  if (!record) return { status: "within_cap", ...state, requested_usd: requested, projected_after_usd: projectedAfter };
  const receipt = await writeSequencedRecord(episodeDir, "episode_budget/authorizations", String(scope).replace(/[^a-z0-9_]+/gi, "_").slice(0, 60), {
    schema: EPISODE_BUDGET_AUTHORIZATION_SCHEMA,
    basis,
    scope,
    cap_usd: budget.usd_cap,
    spent_before_usd: state.spent_usd,
    requested_usd: requested,
    projected_after_usd: projectedAfter,
    run_identity_sha256: await fileSha256(path.join(episodeDir, "run_identity.json")),
    estimate_only: true,
    created_at: now,
  });
  return { status: "authorized", ...state, requested_usd: requested, projected_after_usd: projectedAfter, receipt_path: receipt.path };
}

/** Records non-Fal paid usage so it counts against the episode cap. */
export async function recordEpisodeSpend({ episodeDir, provider, usd, scope, receipt = null, now = new Date().toISOString() }) {
  const amount = Number(usd);
  if (!Number.isFinite(amount) || amount < 0) throw new Error("Episode spend record needs a nonnegative usd amount.");
  return writeSequencedRecord(episodeDir, "episode_budget/spend", `${provider}_${scope}`.replace(/[^a-z0-9_]+/gi, "_").slice(0, 60), {
    schema: EPISODE_BUDGET_SPEND_RECORD_SCHEMA, provider, scope, usd: roundUsd(amount), receipt, created_at: now,
  });
}

/**
 * The exact per-dispatch token still authorizes manual spend. On a budget-locked
 * identity, the single `episode_budget` token authorizes any dispatch; the
 * episode cap is then checked at submission time with the exact pending count.
 */
export function spendAuthorization({ identity, flags = {}, token }) {
  const provided = String(flags["confirm-spend"] ?? "");
  if (provided === token) return { authorized: true, basis: "exact_token", token };
  if (provided === EPISODE_BUDGET_SPEND_TOKEN && episodeBudgetFor(identity)) {
    return { authorized: true, basis: "episode_budget", token };
  }
  return { authorized: false, basis: null, token };
}

/**
 * The workflow guard admits exact Fal recovery commands by their token. On a
 * budget-locked identity, `--confirm-spend episode_budget` stands in for the
 * exact token that the current status shape names.
 */
export function guardFlagsForEpisodeBudget(status = {}, flags = {}) {
  if (flags["confirm-spend"] !== EPISODE_BUDGET_SPEND_TOKEN) return flags;
  if (!episodeBudgetFor(status.identity ?? {})) return flags;
  const match = /--confirm-spend\s+(exact_[a-z0-9_]+)/.exec(String(status.next_command_shape ?? ""));
  return match ? { ...flags, "confirm-spend": match[1] } : flags;
}
