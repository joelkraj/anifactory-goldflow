import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODEX_CALL_ATTEMPT_SCHEMA,
  TRANSPORT_EXHAUSTED_CODE,
  TRANSPORT_RETRY_BACKOFF_MS,
  TRANSPORT_RETRY_MAX_ATTEMPTS,
  TRANSPORT_RETRY_POLICY_ID,
  classifyCodexCliFailure,
  codexCallAttemptPaths,
  codexExecArgs,
  codexExecEventsFromStdout,
  codexStderrDiagnosticLines,
  receiptAttempts,
  runCodexCli,
  runCodexExec,
  transportRetryPolicyForIdentity,
} from "../lib/codex-cli-runner.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const chunk010Stderr = await fs.readFile(path.join(here, "fixtures/codex-transport/chunk_010_stderr.txt"), "utf8");
const validationStderr = "2026-10-19T18:20:01.000000Z WARN codex_skills::interface: ignoring interface.icon_small\nERROR: output did not match the required schema: decisions[3].decision must be one of accepted|rejected\n";
const lockedIdentity = { provider_locks: { transport_retry_policy: TRANSPORT_RETRY_POLICY_ID } };
const backoff = [10, 20];

// Fake codex: FAKE_CODEX_PLAN is a JSON array of per-call behaviours consumed in order.
async function fakeCodex(root) {
  const dir = path.join(root, "fake-codex");
  await fs.mkdir(dir, { recursive: true });
  const executable = path.join(dir, "codex");
  const counter = path.join(dir, "calls");
  const stderrFixture = path.join(dir, "chunk_010_stderr.txt");
  await fs.writeFile(stderrFixture, chunk010Stderr);
  await fs.writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli 0.163.0"); process.exit(0); }
const plan = JSON.parse(process.env.FAKE_CODEX_PLAN || "[]");
const n = fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, "utf8")) : 0;
fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
const mode = plan[n] ?? "ok";
let stdin = "";
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", () => {
  const out = args[args.indexOf("-o") + 1];
  if (mode === "transport") { process.stderr.write(fs.readFileSync(${JSON.stringify(stderrFixture)}, "utf8")); process.exit(1); }
  if (mode === "validation") { process.stderr.write(${JSON.stringify(validationStderr)}); process.exit(1); }
  if (mode === "hang") { setTimeout(() => process.exit(0), 5000); return; }
  if (mode === "output_then_fail") { fs.writeFileSync(out, "partial"); process.stderr.write(fs.readFileSync(${JSON.stringify(stderrFixture)}, "utf8")); process.exit(1); }
  const hasJson = args.includes("--json");
  if (hasJson) {
    process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thr_fake" }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "OK from fake codex" } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 0, output_tokens: 7 } }) + "\\n");
  }
  fs.writeFileSync(out, "OK from fake codex");
  process.exit(0);
});
`);
  await fs.chmod(executable, 0o755);
  return { executable, calls: async () => Number(await fs.readFile(counter, "utf8").catch(() => "0")) };
}

async function withFake(plan, run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-transport-retry-"));
  const fake = await fakeCodex(root);
  const previous = { path: process.env.ANIFACTORY_CODEX_CLI_PATH, plan: process.env.FAKE_CODEX_PLAN };
  process.env.ANIFACTORY_CODEX_CLI_PATH = fake.executable;
  process.env.FAKE_CODEX_PLAN = JSON.stringify(plan);
  try {
    return await run({ root, fake });
  } finally {
    if (previous.path === undefined) delete process.env.ANIFACTORY_CODEX_CLI_PATH; else process.env.ANIFACTORY_CODEX_CLI_PATH = previous.path;
    if (previous.plan === undefined) delete process.env.FAKE_CODEX_PLAN; else process.env.FAKE_CODEX_PLAN = previous.plan;
    await fs.rm(root, { recursive: true, force: true });
  }
}

const exists = (file) => fs.stat(file).then(() => true, () => false);

test("classifier returns transport only for exit!=0, no -o output and an anchored stderr signature", () => {
  assert.equal(classifyCodexCliFailure({ exitCode: 1, outputPresent: false, stderr: chunk010Stderr }), "transport");
  assert.equal(classifyCodexCliFailure({ exitCode: 1, outputPresent: false, stderr: "read ECONNRESET" }), "transport");
  assert.equal(classifyCodexCliFailure({ exitCode: 1, outputPresent: false, stderr: "stream disconnected before completion" }), "transport");
  assert.equal(classifyCodexCliFailure({ exitCode: 1, outputPresent: true, stderr: chunk010Stderr }), "failed_with_output");
  assert.equal(classifyCodexCliFailure({ exitCode: 1, outputPresent: false, stderr: chunk010Stderr, timedOut: true }), "timeout");
  assert.equal(classifyCodexCliFailure({ exitCode: 1, outputPresent: false, stderr: validationStderr }), "failure");
  assert.equal(classifyCodexCliFailure({ exitCode: 1, outputPresent: false, stderr: "ERROR: Selected model is at capacity." }), "failure");
  assert.equal(classifyCodexCliFailure({ exitCode: 0, outputPresent: true, stderr: "" }), "passed");
});

test("identity lock decides the attempt budget; legacy identities keep one attempt", () => {
  assert.deepEqual(transportRetryPolicyForIdentity(lockedIdentity), { policy: TRANSPORT_RETRY_POLICY_ID, max_attempts: 3, backoff_ms: [15_000, 60_000] });
  assert.deepEqual(transportRetryPolicyForIdentity(null), { policy: null, max_attempts: 1, backoff_ms: [] });
  assert.deepEqual(transportRetryPolicyForIdentity({ provider_locks: { planning_provider: "codex_cli" } }).max_attempts, 1);
  assert.equal(TRANSPORT_RETRY_MAX_ATTEMPTS, 3);
  assert.deepEqual([...TRANSPORT_RETRY_BACKOFF_MS], [15_000, 60_000]);
  assert.deepEqual(receiptAttempts({ status: "passed" }), [{ attempt: 1, class: "passed", legacy_single_attempt: true }]);
  assert.deepEqual(receiptAttempts({ status: "passed", attempts: [{ attempt: 1, class: "passed" }] }), [{ attempt: 1, class: "passed" }]);
});

test("diagnostic lines keep ERROR/WARN lines and drop the prompt echo; --json events yield usage", () => {
  const lines = codexStderrDiagnosticLines(chunk010Stderr);
  assert.ok(!lines.includes("PROMPT_ECHO_MARKER"), "prompt echo must not reach error messages");
  assert.match(lines, /Transport channel closed/);
  assert.match(lines, /workspace routing discovery failed/);
  const parsed = codexExecEventsFromStdout('{"type":"thread.started","thread_id":"t1"}\n{"type":"item.completed","item":{"type":"agent_message","text":"long answer"}}\n{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":2}}\nnot json\n');
  assert.deepEqual(parsed.usage, { input_tokens: 5, output_tokens: 2 });
  assert.equal(parsed.thread_id, "t1");
  assert.deepEqual(parsed.receipt_events.map((event) => event.type), ["thread.started", "turn.completed"]);
  assert.ok(codexExecArgs({ model: "gpt-6.1-sol", effort: "medium", workdir: "/w", lastMessagePath: "/w/l" }).includes("--json"));
});

test("recorded chunk_010 transport stderr then success: attempts[]=2, two immutable attempt sidecars, one receipt", async () => {
  await withFake(["transport", "ok"], async ({ root, fake }) => {
    const outputPath = path.join(root, "out", "chunk_010.json");
    const result = await runCodexExec({ prompt: "plan it", stageName: "chunk_010", outputPath, model: "gpt-6.1-sol", reasoningEffort: "medium", identity: lockedIdentity, transportBackoffMsForTests: backoff });
    assert.equal(result.content, "OK from fake codex");
    assert.equal(await fake.calls(), 2);
    const receipt = JSON.parse(await fs.readFile(`${outputPath}.meta.json`, "utf8"));
    assert.equal(receipt.status, "passed");
    assert.equal(receipt.transport_retry_policy, TRANSPORT_RETRY_POLICY_ID);
    assert.deepEqual(receipt.attempts.map((row) => [row.attempt, row.class, row.exit_code, row.backoff_ms_before_next]), [[1, "transport", 1, 10], [2, "passed", 0, null]]);
    assert.ok(receipt.attempts.every((row) => Number.isFinite(row.elapsed_ms) && row.stderr_path));
    assert.deepEqual(receipt.provider_usage, { input_tokens: 120, cached_input_tokens: 0, output_tokens: 7 });
    assert.equal(receipt.provider_cost_usd, null, "subscription CLI records null, never 0");
    assert.ok(!JSON.stringify(receipt).includes("PROMPT_ECHO_MARKER"), "the receipt must not echo the prompt");
    for (const attempt of [1, 2]) {
      const paths = codexCallAttemptPaths(outputPath, attempt);
      assert.ok(await exists(paths.meta), `attempt ${attempt} meta`);
      assert.ok(await exists(paths.stderr), `attempt ${attempt} stderr`);
      const meta = JSON.parse(await fs.readFile(paths.meta, "utf8"));
      assert.equal(meta.schema, CODEX_CALL_ATTEMPT_SCHEMA);
      assert.equal(meta.attempt, attempt);
      await assert.rejects(fs.writeFile(paths.meta, "x", { flag: "wx" }), /EEXIST/, "attempt sidecars are immutable");
    }
    assert.ok((await fs.readFile(codexCallAttemptPaths(outputPath, 1).stderr, "utf8")).includes("PROMPT_ECHO_MARKER"), "the full stderr lives only in the sidecar");
    assert.ok(await exists(codexCallAttemptPaths(outputPath, 2).events), "--json events sidecar for the passed attempt");
    assert.ok(!await exists(codexCallAttemptPaths(outputPath, 3).meta));
  });
});

test("a validation failure stays at one attempt and is not transport", async () => {
  await withFake(["validation", "ok"], async ({ root, fake }) => {
    const outputPath = path.join(root, "out", "chunk_067.json");
    await assert.rejects(
      runCodexExec({ prompt: "plan it", stageName: "chunk_067", outputPath, model: "gpt-6.1-sol", reasoningEffort: "medium", identity: lockedIdentity, transportBackoffMsForTests: backoff }),
      (error) => error.failure_class === "failure" && error.code === undefined && /exited 1 \(failure\) after 1 attempt/.test(error.message) && /required schema/.test(error.message),
    );
    assert.equal(await fake.calls(), 1);
    const receipt = JSON.parse(await fs.readFile(`${outputPath}.meta.json`, "utf8"));
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.failure_class, "failure");
    assert.equal(receipt.attempts.length, 1);
  });
});

test("the runner's own timeout and an exit that produced -o output are never retried", async () => {
  await withFake(["hang", "ok"], async ({ root, fake }) => {
    const outputPath = path.join(root, "out", "timeout.json");
    await assert.rejects(
      runCodexExec({ prompt: "x", stageName: "timeout", outputPath, model: "gpt-6.1-sol", reasoningEffort: "medium", identity: lockedIdentity, timeoutMs: 400, transportBackoffMsForTests: backoff }),
      (error) => error.failure_class === "timeout" && /timed out/.test(error.message),
    );
    assert.equal(await fake.calls(), 1);
    assert.equal(JSON.parse(await fs.readFile(`${outputPath}.meta.json`, "utf8")).attempts.length, 1);
  });
  await withFake(["output_then_fail", "ok"], async ({ root, fake }) => {
    const outputPath = path.join(root, "out", "with_output.json");
    await assert.rejects(
      runCodexExec({ prompt: "x", stageName: "with_output", outputPath, model: "gpt-6.1-sol", reasoningEffort: "medium", identity: lockedIdentity, transportBackoffMsForTests: backoff }),
      (error) => error.failure_class === "failed_with_output",
    );
    assert.equal(await fake.calls(), 1);
  });
});

test("exhausted transport retries block with transport_exhausted after three attempts", async () => {
  await withFake(["transport", "transport", "transport", "ok"], async ({ root, fake }) => {
    const outputPath = path.join(root, "out", "exhausted.json");
    await assert.rejects(
      runCodexExec({ prompt: "x", stageName: "exhausted", outputPath, model: "gpt-6.1-sol", reasoningEffort: "medium", identity: lockedIdentity, transportBackoffMsForTests: backoff }),
      (error) => error.code === TRANSPORT_EXHAUSTED_CODE && error.attempts.length === 3 && !error.message.includes("PROMPT_ECHO_MARKER"),
    );
    assert.equal(await fake.calls(), 3);
    const receipt = JSON.parse(await fs.readFile(`${outputPath}.meta.json`, "utf8"));
    assert.equal(receipt.error_code, TRANSPORT_EXHAUSTED_CODE);
    assert.deepEqual(receipt.attempts.map((row) => row.backoff_ms_before_next), [10, 20, null]);
    assert.ok(!JSON.stringify(receipt).includes("PROMPT_ECHO_MARKER"));
  });
});

test("a legacy identity without the lock field runs one attempt even on a transport signature", async () => {
  await withFake(["transport", "ok"], async ({ root, fake }) => {
    const outputPath = path.join(root, "out", "legacy.json");
    await assert.rejects(
      runCodexExec({ prompt: "x", stageName: "legacy", outputPath, model: "gpt-6.1-sol", reasoningEffort: "medium", identity: { provider_locks: {} }, transportBackoffMsForTests: backoff }),
      (error) => error.code === TRANSPORT_EXHAUSTED_CODE && error.attempts.length === 1,
    );
    assert.equal(await fake.calls(), 1);
    const receipt = JSON.parse(await fs.readFile(`${outputPath}.meta.json`, "utf8"));
    assert.equal(receipt.transport_retry_policy, null);
    assert.equal(receipt.transport_retry_max_attempts, 1);
  });
});

test("the planner codex path (runCodexCli) reads the lock from the episode identity and retries once", async () => {
  await withFake(["transport", "ok"], async ({ root, fake }) => {
    const episodeDir = path.join(root, "episode");
    await fs.mkdir(episodeDir, { recursive: true });
    await fs.writeFile(path.join(episodeDir, "run_identity.json"), JSON.stringify({
      episode: "ep_01",
      provider_locks: { planning_provider: "codex_cli", planning_model: "gpt-6.1-sol", transport_retry_policy: TRANSPORT_RETRY_POLICY_ID },
    }));
    const argv = process.argv;
    process.argv = [argv[0], argv[1], "--episode-dir", episodeDir];
    try {
      const outputPath = path.join(episodeDir, "reports", "planner", "chunk_010.json");
      const result = await runCodexCli({ prompt: "plan it", stageName: "ep_01_visual_plan_chunk_010", repoRoot, outputPath, provider: "codex_cli", model: "gpt-6.1-sol", reasoningEffort: "medium", timeoutMs: 10_000, transportBackoffMsForTests: backoff });
      assert.equal(result.content, "OK from fake codex");
      assert.equal(await fake.calls(), 2);
      const receipt = JSON.parse(await fs.readFile(`${outputPath}.meta.json`, "utf8"));
      assert.equal(receipt.transport, "codex_cli");
      assert.deepEqual(receipt.attempts.map((row) => row.class), ["transport", "passed"]);
      assert.deepEqual(receipt.provider_usage, { input_tokens: 120, cached_input_tokens: 0, output_tokens: 7 });
      assert.equal(receipt.provider_cost_usd, null);
    } finally {
      process.argv = argv;
    }
  });
});
