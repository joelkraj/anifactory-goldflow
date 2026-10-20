#!/usr/bin/env node
// Executing-code provenance (R01 item 4): every new stage_started/stage_completed
// event records git_commit, git_worktree and git_dirty; the CLI guard refuses a
// stage command whose HEAD does not contain the identity commit unless an
// --allow-code-drift reason code is passed and recorded. Legacy identities
// without a commit are untouched. No provider or production command runs.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  appendCodeDriftEvent,
  beginStageExecution,
  codeDriftDecision,
  finishStageExecution,
  gitExecutionProvenance,
  identityCodeCommit,
  resetGitExecutionProvenanceCacheForTests,
} from "../lib/execution-provenance.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
const parent = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: repoRoot, encoding: "utf8" }).trim();
const unknownCommit = "0".repeat(40);

async function readEvents(episodeDir) {
  const text = await fs.readFile(path.join(episodeDir, "execution_events.jsonl"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// A throwaway repository with two diverged branches, so a real non-ancestor exists.
async function divergedRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-drift-repo-"));
  const run = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  run("init", "-q", "-b", "main");
  await fs.writeFile(path.join(dir, "a.txt"), "a\n");
  run("add", "a.txt"); run("commit", "-q", "-m", "base");
  const base = run("rev-parse", "HEAD");
  run("checkout", "-q", "-b", "side");
  await fs.writeFile(path.join(dir, "b.txt"), "b\n");
  run("add", "b.txt"); run("commit", "-q", "-m", "side");
  const side = run("rev-parse", "HEAD");
  run("checkout", "-q", "main");
  await fs.writeFile(path.join(dir, "c.txt"), "c\n");
  run("add", "c.txt"); run("commit", "-q", "-m", "main-2");
  const tip = run("rev-parse", "HEAD");
  return { dir, base, side, tip };
}

test("stage events record the executing commit, worktree and dirty state (additive)", async () => {
  const episodeDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-provenance-"));
  const execution = await beginStageExecution({ stage: "final_qa", command: "final qa", flags: { "episode-dir": episodeDir }, repoRoot });
  assert.equal(execution.git_commit, head);
  assert.equal(typeof execution.git_dirty, "boolean");
  assert.ok(path.isAbsolute(execution.git_worktree));
  const report = await finishStageExecution(execution, { exitCode: 0 });
  assert.equal(report.git_commit, head);
  const events = await readEvents(episodeDir);
  const started = events.find((row) => row.event_type === "stage_started");
  const completed = events.find((row) => row.event_type === "stage_completed");
  for (const row of [started, completed]) {
    assert.equal(row.git_commit, head);
    assert.equal(row.git_worktree, execution.git_worktree);
    assert.equal(row.git_dirty, execution.git_dirty);
    assert.equal(row.code_drift, null);
  }
  // Legacy rows without the fields stay readable: nothing rewrites them.
  assert.equal(events.length, 2);
});

test("identityCodeCommit reads code_commit first, then git.commit, else legacy", () => {
  assert.equal(identityCodeCommit({ code_commit: head, git: { commit: parent } }), head);
  assert.equal(identityCodeCommit({ git: { commit: parent } }), parent);
  assert.equal(identityCodeCommit({ git: { commit: "fixture" } }), null, "non-hex markers are not commits");
  assert.equal(identityCodeCommit({}), null);
  assert.equal(identityCodeCommit(null), null);
});

test("ancestry rule: equal and ancestor commits pass, legacy is not applicable", () => {
  assert.deepEqual(codeDriftDecision({ identity: {}, repoRoot }).applicable, false);
  assert.equal(codeDriftDecision({ identity: { code_commit: head }, repoRoot }).allowed, true);
  const ancestor = codeDriftDecision({ identity: { git: { commit: parent } }, repoRoot });
  assert.equal(ancestor.applicable, true);
  assert.equal(ancestor.allowed, true);
  assert.equal(ancestor.ancestor, true);
  assert.equal(ancestor.reason, "head_contains_identity_commit");
});

test("ancestry rule: a non-ancestor or unknown commit is refused without a reason code", async () => {
  const repo = await divergedRepo();
  try {
    resetGitExecutionProvenanceCacheForTests();
    const drift = codeDriftDecision({ identity: { code_commit: repo.side }, repoRoot: repo.dir });
    assert.equal(drift.allowed, false);
    assert.equal(drift.reason, "head_does_not_contain_identity_commit");
    assert.equal(drift.head_commit, repo.tip);
    assert.equal(codeDriftDecision({ identity: { code_commit: repo.base }, repoRoot: repo.dir }).allowed, true, "the merge base is an ancestor of the tip");
    const unknown = codeDriftDecision({ identity: { code_commit: unknownCommit }, repoRoot: repo.dir });
    assert.equal(unknown.allowed, false);
    assert.equal(unknown.reason, "identity_commit_unknown_to_repository");
    // Free prose is not a reason code.
    assert.equal(codeDriftDecision({ identity: { code_commit: repo.side }, repoRoot: repo.dir, allowReasonCode: "because I said so" }).reason, "invalid_code_drift_reason_code");
    const allowed = codeDriftDecision({ identity: { code_commit: repo.side }, repoRoot: repo.dir, allowReasonCode: "hotfix_rebase_reviewed" });
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.ancestor, false);
    assert.equal(allowed.allow_reason_code, "hotfix_rebase_reviewed");

    // The allowed drift is recorded append-only beside the stage event.
    const episodeDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-drift-episode-"));
    const execution = await beginStageExecution({ stage: "final_qa", command: "final qa", flags: { "episode-dir": episodeDir }, repoRoot: repo.dir, codeDrift: allowed });
    const row = await appendCodeDriftEvent({ episodeDir, identity: { code_commit: repo.side }, decision: allowed, execution, repoRoot: repo.dir });
    assert.equal(row.event_type, "code_drift");
    assert.equal(row.reason_code, "hotfix_rebase_reviewed");
    assert.deepEqual(row.diff_paths.sort(), ["b.txt", "c.txt"]);
    assert.equal(row.git_commit, repo.tip);
    const events = await readEvents(episodeDir);
    assert.deepEqual(events.map((r) => r.event_type), ["stage_started", "code_drift"]);
    assert.deepEqual(events[0].code_drift, { identity_commit: repo.side, head_commit: repo.tip, ancestor: false, allow_reason_code: "hotfix_rebase_reviewed" });
    assert.equal(await appendCodeDriftEvent({ episodeDir, decision: codeDriftDecision({ identity: {}, repoRoot: repo.dir }), execution, repoRoot: repo.dir }), null, "nothing is written for a legacy identity");
  } finally {
    resetGitExecutionProvenanceCacheForTests();
    await fs.rm(repo.dir, { recursive: true, force: true });
  }
});

test("bin/goldflow.mjs refuses a drifted stage command and records an allowed drift; read-only status is untouched", async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-drift-cli-"));
  const episodeDir = path.join(scratch, "channels", "fixture", "weekly_runs", "run", "episodes", "ep_01");
  await fs.mkdir(episodeDir, { recursive: true });
  const identity = {
    schema: "goldflow_run_identity_v1", channel: "fixture", series_slug: "fixture", week: "run", episode: "ep_01",
    content_profile: "manhwa_recap_v1", media_workflow: undefined, audio_target: "narrator_only", run_intent: "proof",
    git: { commit: unknownCommit, branch: "fixture", dirty: false }, code_commit: unknownCommit,
  };
  await fs.writeFile(path.join(episodeDir, "run_identity.json"), `${JSON.stringify(identity, null, 2)}\n`);
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: scratch, ANIFACTORY_DATA_ROOT: scratch };
  const cli = (...args) => spawnSync(process.execPath, [path.join(repoRoot, "bin", "goldflow.mjs"), ...args], { cwd: repoRoot, env, encoding: "utf8", timeout: 60_000 });

  // Read-only: no stage, so no drift check and no event.
  const status = cli("run", "status", "--episode-dir", episodeDir, "--format", "markdown");
  assert.equal(status.status, 0, status.stderr);
  assert.doesNotMatch(status.stderr, /Code drift/);

  // A stage command on an identity whose commit HEAD does not contain is refused before any event.
  const blocked = cli("final", "qa", "--episode-dir", episodeDir, "--workflow-bypass", "true");
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /Code drift blocked: final qa/);
  assert.match(blocked.stderr, /identity_commit_unknown_to_repository/);
  assert.deepEqual(await readEvents(episodeDir), []);

  // A reason code admits the command; the drift is recorded append-only and the flag is not forwarded.
  const allowed = cli("final", "qa", "--episode-dir", episodeDir, "--workflow-bypass", "true", "--allow-code-drift", "fixture_drift_reviewed");
  assert.doesNotMatch(allowed.stderr, /Code drift blocked/);
  const events = await readEvents(episodeDir);
  assert.deepEqual(events.slice(0, 2).map((row) => row.event_type), ["stage_started", "code_drift"]);
  assert.equal(events[0].git_commit, head);
  assert.equal(events[0].flags["allow-code-drift"], "fixture_drift_reviewed");
  assert.ok(!events[0].args.includes("--allow-code-drift"), "the child never sees the guard flag");
  assert.equal(events[1].reason_code, "fixture_drift_reviewed");
  assert.equal(events[1].identity_commit_known, false);
  const completed = events.find((row) => row.event_type === "stage_completed");
  assert.ok(completed, "the stage still finishes with its own event");
  assert.deepEqual(completed.code_drift, events[0].code_drift);
  const identityAfter = JSON.parse(await fs.readFile(path.join(episodeDir, "run_identity.json"), "utf8"));
  assert.deepEqual(identityAfter, JSON.parse(JSON.stringify(identity)), "the identity is never rewritten");

  // A legacy identity without any commit field runs the same command without a drift check.
  const legacyDir = path.join(scratch, "channels", "fixture", "weekly_runs", "legacy", "episodes", "ep_01");
  await fs.mkdir(legacyDir, { recursive: true });
  const { git, code_commit, ...legacy } = identity;
  await fs.writeFile(path.join(legacyDir, "run_identity.json"), `${JSON.stringify(legacy, null, 2)}\n`);
  const legacyRun = cli("final", "qa", "--episode-dir", legacyDir, "--workflow-bypass", "true");
  assert.doesNotMatch(legacyRun.stderr, /Code drift/);
  const legacyEvents = await readEvents(legacyDir);
  assert.equal(legacyEvents[0]?.event_type, "stage_started");
  assert.equal(legacyEvents[0].code_drift, null);
  assert.equal(legacyEvents[0].git_commit, head);
  await fs.rm(scratch, { recursive: true, force: true });
});
