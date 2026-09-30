import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { executeTrueCrimeProofCli } from "../true-crime-proof.mjs";
import { preflightTrueCrimeProof, trueCrimeProofStatus, runTrueCrimeProofStage, loadTrueCrimeProofIdentity,
  trueCrimeProofFileRef, trueCrimeProofWorkflowContract, beginTrueCrimeProofStage, finishTrueCrimeProofStage, failTrueCrimeProofStage } from "../lib/true-crime-proof-workflow.mjs";
const exec = promisify(execFile);
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "true-crime-workflow-tests-"));
test.after(() => fs.rm(scratch, { recursive: true, force: true }));
let sequence = 0;
async function file(directory, name, bytes) { const target = path.join(directory, name); await fs.writeFile(target, bytes); return trueCrimeProofFileRef(target); }
async function fixture() {
  const dir = path.join(scratch, `case-${++sequence}`); await fs.mkdir(dir);
  const repoDir = path.join(dir, "repo"); await fs.mkdir(repoDir);
  await file(repoDir, "tracked.txt", "synthetic fixture\n");
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) await exec("git", args, { cwd: repoDir });
  const source = await file(dir, "record.txt", "Synthetic record, not factual evidence.\n");
  const spoken = "This is a synthetic account used to test the private proof workflow.";
  const plan = { schema: "goldflow_true_crime_editorial_proof_plan_v1", status: "editorial_draft", production_eligible: false, title: "Synthetic proof", working_channel: "CrimeDungeon", target_duration_sec: 120,
    sources: [{ id: "E01", url: "https://example.invalid/record", title: "Synthetic record", kind: "record", locator: "paragraph 1", planned_use: "media_candidate", acquisition_status: "research_copy", use_basis_status: "documented", use_basis_note: "Locally authored fixture." }],
    claims: [{ id: "C01", text: "Synthetic statement.", source_ids: ["E01"] }],
    scenes: [{ id: "S01", start_sec: 0, end_sec: 120, claim_ids: ["C01"], source_ids: ["E01"], picture: { origin: "authored", description: "Synthetic explanatory board." }, audio: { origin: "narration", text_mode: "paraphrase", text: spoken, source_ids: ["E01"], exact_words_verified: false } }],
    readiness: { voice: "selected", voice_note: "Synthetic fixture voice, not an audition.", execution_route: "unsupported" } };
  const planRef = await file(dir, "plan.json", JSON.stringify(plan));
  const script = await file(dir, "script.txt", `${spoken}\n`);
  const voice = await file(dir, "reference.wav", "synthetic voice reference bytes, no model");
  const voiceText = await file(dir, "reference.txt", "Synthetic reference transcript.");
  const identity = { schema: "goldflow_true_crime_proof_identity_v1", content_profile: "true_crime_proof_v1", media_workflow: "true_crime_hybrid_proof_v1", channel: "crimedungeon", channel_name: "CrimeDungeon", series_slug: "case-files", run_slug: "synthetic-proof", episode: "ep_01", title: plan.title,
    run_intent: "proof", production_eligible: false, publish_allowed: false, plan: planRef, script,
    sources: [{ id: "E01", acquisition: "research_copy", ...source, locator: "paragraph 1", use_basis: "Locally authored test input." }],
    narration: { provider: "qwen_local", model: "fixture", model_revision: "fixture-revision", voice_id: "owned-fixture", voice_sha256: "a".repeat(64), reference_audio: voice, reference_text: voiceText },
    audio_target: "narration_with_document_reading", audio_mastering: { sample_rate_hz: 24000, channels: 1, integrated_lufs: -16, true_peak_dbtp: -1.5 },
    authorization: { operator: "Fixture only", authorized_at: "2026-09-08T12:00:00Z", note: "Synthetic test scope, not a real approval.", plan_sha256: planRef.sha256, script_sha256: script.sha256 },
    proof_scope: { min_duration_sec: 90, max_duration_sec: 150, fps: 30, width: 1920, height: 1080 } };
  return { dir, repoDir, proofDir: path.join(dir, "proof"), identity };
}
async function producer(context) {
  const stage = context.stage;
  const kinds = stage === "source_assets" ? ["document_crop"] : stage === "narration" ? ["narration_audio", "narration_receipt"] : ["program_video", "program_qa"];
  const artifacts = [];
  for (const kind of kinds) artifacts.push({ id: kind, kind, ...(await file(context.outputDir, `${kind}.fixture`, `Synthetic ${kind}, no real media`)), ...(stage === "source_assets" ? { source_ids: ["E01"] } : {}) });
  const metadata = stage === "source_assets" ? {} : { source_text_sha256: context.identity.script.sha256, tempo: 1, measured_duration_sec: stage === "narration" ? 78 : 112, technical_qa: "needs_review",
    ...(stage === "narration" ? { voice: Object.fromEntries(["provider", "model", "model_revision", "voice_id", "voice_sha256"].map((key) => [key, context.identity.narration[key]])) } : { whole_narration_preserved: true }) };
  return { artifacts, metadata, cost_usd: 0 };
}
const begin = async (f) => preflightTrueCrimeProof(f);
const run = (f, stage, callback = producer) => runTrueCrimeProofStage({ proofDir: f.proofDir, stage, producer: callback });

test("invalid identity, stale inputs and missing authorization refuse before directory creation", async () => {
  for (const mutate of [(id) => { id.media_workflow = "source_footage_v1"; }, (id) => { id.publish_allowed = true; }, (id) => { id.authorization.script_sha256 = "b".repeat(64); }, (id) => { id.sources[0].sha256 = "b".repeat(64); }]) {
    const f = await fixture(); mutate(f.identity);
    await assert.rejects(begin(f)); await assert.rejects(fs.stat(f.proofDir), { code: "ENOENT" });
  }
});
test("proof preflight requires explicit dirty scope and never overwrites an identity", async () => {
  const f = await fixture(); await file(f.repoDir, "untracked.txt", "dirty fixture");
  await assert.rejects(begin(f), /Dirty proof/);
  await assert.rejects(begin({ ...f, allowDirtyWorktree: true, dirtyReason: "test" }), /Dirty proof/);
  await begin({ ...f, allowDirtyWorktree: true, dirtyReason: "Isolated provider-free proof fixture." });
  const loaded = await loadTrueCrimeProofIdentity({ proofDir: f.proofDir });
  assert.equal(loaded.identity.git.dirty, true);
  assert.deepEqual(loaded.identity.workflow_contract, trueCrimeProofWorkflowContract());
  await assert.rejects(begin(f), /existing proof directories/);
});
test("ordered local candidate stages preserve sub-90-second narration and never grant approval", async () => {
  const f = await fixture(); await begin(f);
  let calls = 0;
  await assert.rejects(run(f, "narration", async (context) => { calls++; return producer(context); }), /Next valid stage/);
  assert.equal(calls, 0);
  assert.equal((await run(f, "source_assets")).next_stage, "narration");
  assert.equal((await run(f, "narration")).next_stage, "program_review");
  const result = await run(f, "program_review");
  assert.equal(result.state, "awaiting_program_review"); assert.equal(result.approval_recorded, false); assert.equal(result.publish_allowed, false);
  for (const stage of ["source_assets", "narration", "program_review"]) {
    const receipt = JSON.parse(await fs.readFile(path.join(f.proofDir, `${stage}.json`), "utf8")); assert.equal(receipt.approved, false);
  }
  await assert.rejects(run(f, "publish"), /Unsupported action/);
  await assert.rejects(run(f, "narration"), /do not rerun/);
});
test("source/text and upstream media mutations stop before the next producer", async () => {
  const f = await fixture(); await begin(f); await run(f, "source_assets");
  const receipt = JSON.parse(await fs.readFile(path.join(f.proofDir, "source_assets.json"), "utf8"));
  await fs.appendFile(receipt.artifacts[0].path, "changed");
  let calls = 0;
  await assert.rejects(run(f, "narration", async () => { calls++; }), /Stale or changed/); assert.equal(calls, 0);
  const g = await fixture(); await begin(g); await fs.appendFile(g.identity.script.path, "Different text.");
  await assert.rejects(run(g, "source_assets", async () => { calls++; }), /Stale or changed/); assert.equal(calls, 0);
});
test("producer failure retains partial outputs, audit history and a non-rerunnable attempt", async () => {
  const f = await fixture(); await begin(f);
  await assert.rejects(run(f, "source_assets", async ({ outputDir }) => { await file(outputDir, "partial.fixture", "retained"); throw new Error("Synthetic provider failure; never retried."); }), /Synthetic provider failure/);
  assert.equal(await fs.readFile(path.join(f.proofDir, "attempts/source_assets/output/partial.fixture"), "utf8"), "retained");
  assert.equal((await trueCrimeProofStatus({ proofDir: f.proofDir })).state, "needs_triage");
  await assert.rejects(run(f, "source_assets"), /do not rerun/);
  const events = (await fs.readFile(path.join(f.proofDir, "execution_events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.map((event) => event.status), ["locked", "started", "needs_triage"]);
  assert.equal(events[2].cost_usd, null);
  assert.ok(!JSON.stringify(events).includes("Synthetic provider failure"));
  for (const event of events) assert.deepEqual(await trueCrimeProofFileRef(event.report.path), event.report);
});
test("wrong hashes, output escape and voice drift preserve failed outputs without accepting stages", async () => {
  for (const mode of ["hash", "escape", "voice"]) {
    const f = await fixture(); await begin(f); if (mode === "voice") await run(f, "source_assets");
    const stage = mode === "voice" ? "narration" : "source_assets";
    await assert.rejects(run(f, stage, async (context) => { const result = await producer(context);
      if (mode === "hash") result.artifacts[0].sha256 = "f".repeat(64);
      if (mode === "escape") Object.assign(result.artifacts[0], await file(f.dir, "escaped.fixture", "external output"));
      if (mode === "voice") result.metadata.voice.voice_id = "different-speaker";
      return result;
    }));
    await assert.rejects(fs.stat(path.join(f.proofDir, `${stage}.json`)), { code: "ENOENT" });
    assert.equal((await trueCrimeProofStatus({ proofDir: f.proofDir })).state, "needs_triage");
  }
});
test("pending URL acquisition is locked before bytes and evidence-only sources never require media", async () => {
  const f = await fixture();
  f.identity.sources.push({ id: "P01", acquisition: "pending", url: "https://example.invalid/portrait.png", locator: "Selected portrait version", use_basis: "Synthetic fixture image." }, { id: "V02", acquisition: "evidence_only", url: "https://example.invalid/testimony", locator: "01:20", use_basis: "Citation only; no imported media." });
  await begin(f);
  await run(f, "source_assets", async (context) => { const result = await producer(context); result.acquired_sources = [{ id: "P01", url: f.identity.sources[1].url, ...(await file(context.outputDir, "portrait.fixture", "synthetic image bytes")) }]; return result; });
  assert.equal((await trueCrimeProofStatus({ proofDir: f.proofDir })).next_stage, "narration");
  const g = await fixture(); g.identity.sources.push(f.identity.sources[1]); await begin(g);
  await assert.rejects(run(g, "source_assets"), /acquired-byte provenance/);
});
test("external source-assets lifecycle uses a single exact token and cannot bypass stage scope", async () => {
  const f = await fixture(); await begin(f);
  const context = await beginTrueCrimeProofStage({ proofDir: f.proofDir, stage: "source_assets" });
  assert.equal((await trueCrimeProofStatus({ proofDir: f.proofDir })).state, "running");
  await assert.rejects(beginTrueCrimeProofStage({ proofDir: f.proofDir, stage: "source_assets" }), /Next valid stage/);
  const result = await producer(context);
  await assert.rejects(finishTrueCrimeProofStage({ proofDir: f.proofDir, stage: "source_assets", attempt_token: "wrong", result }), /token mismatch/);
  await finishTrueCrimeProofStage({ proofDir: f.proofDir, stage: "source_assets", attempt_token: context.attempt_token, result });
  await assert.rejects(finishTrueCrimeProofStage({ proofDir: f.proofDir, stage: "source_assets", attempt_token: context.attempt_token, result }));
  await assert.rejects(beginTrueCrimeProofStage({ proofDir: f.proofDir, stage: "narration" }), /source_assets only/);
});
test("external failure preserves evidence and closes the attempt without a retry", async () => {
  const f = await fixture(); await begin(f); const context = await beginTrueCrimeProofStage({ proofDir: f.proofDir, stage: "source_assets" });
  await file(context.outputDir, "request.json", JSON.stringify({ prompt: "Synthetic request; no tool called" }));
  await failTrueCrimeProofStage({ proofDir: f.proofDir, stage: "source_assets", attempt_token: context.attempt_token });
  assert.equal((await trueCrimeProofStatus({ proofDir: f.proofDir })).state, "needs_triage");
});
test("image generation requires selected operations and hash-bound actual attempt receipts", async () => {
  const f = await fixture();
  f.identity.providers = { stills: { provider: "openai_builtin_imagegen", model: "tool_managed", operations: ["background_extraction", "illustrative_detective"], max_submissions: 2 } };
  await begin(f);
  await run(f, "source_assets", async (context) => {
    const result = await producer(context);
    result.metadata.generation_submissions = [{ operation: "background_extraction", provider: "openai_builtin_imagegen", model: "tool_managed", request: await file(context.outputDir, "request.json", "{}"), result: await file(context.outputDir, "result.json", "{}"), output: await file(context.outputDir, "generated.fixture", "Synthetic, not generated media") }];
    return result;
  });
  const receipt = JSON.parse(await fs.readFile(path.join(f.proofDir, "source_assets.json"), "utf8"));
  await fs.appendFile(receipt.metadata.generation_submissions[0].request.path, "changed");
  await assert.rejects(run(f, "narration"), /Stale or changed/);
});
test("unreported built-in source-tool cost stays unknown and cannot disguise narration cost", async () => {
  const f = await fixture(); await begin(f);
  await run(f, "source_assets", async (context) => { const result = await producer(context); result.cost_usd = null; result.metadata.cost_status = "provider_cost_not_reported"; return result; });
  const status = await trueCrimeProofStatus({ proofDir: f.proofDir });
  assert.match(status.next_command_shape, /crime-proof narrate --episode-dir/);
  const receipt = JSON.parse(await fs.readFile(path.join(f.proofDir, "source_assets.json"), "utf8")); assert.equal(receipt.cost_usd, null);
  await assert.rejects(run(f, "narration", async (context) => { const result = await producer(context); result.cost_usd = null; result.metadata.cost_status = "provider_cost_not_reported"; return result; }), /nonnegative cost/);
});
test("actual CLI dispatch locks a fixture, reports next command and refuses narration before assets", async () => {
  const f = await fixture(); const config = await file(f.dir, "identity.json", JSON.stringify(f.identity));
  const bin = fileURLToPath(new URL("../../bin/goldflow.mjs", import.meta.url));
  const args = ["crime-proof", "preflight", "--episode-dir", f.proofDir, "--identity", config.path, "--repo-dir", f.repoDir];
  const initialized = JSON.parse((await exec(process.execPath, [bin, ...args])).stdout);
  assert.equal(initialized.next_stage, "source_assets");
  const status = (await exec(process.execPath, [bin, "crime-proof", "status", "--episode-dir", f.proofDir, "--format", "markdown"])).stdout;
  assert.match(status, /crime-proof begin-assets/);
  await assert.rejects(exec(process.execPath, [bin, "crime-proof", "narrate", "--episode-dir", f.proofDir]), (error) => /Next valid stage is source_assets/.test(error.stderr));
  await assert.rejects(executeTrueCrimeProofCli(["--action", "narrate", "--episode-dir", f.proofDir, "--workflow-bypass", "true"]), /Unknown flags/);
  await assert.rejects(executeTrueCrimeProofCli(["--action", "status", "--episode-dir", f.proofDir, "--episode-dir", f.proofDir]), /Repeated/);
});
test("CLI external lifecycle binds recipe before preparation and preserves exact finish token", async () => {
  const f = await fixture(); await begin(f);
  const recipe = await file(f.dir, "assets.json", JSON.stringify({ schema: "goldflow_true_crime_proof_assets_v1", downloads: [], documents: [], image_operations: [] }));
  const prepared = await executeTrueCrimeProofCli(["--action", "begin-assets", "--episode-dir", f.proofDir, "--recipe", recipe.path]);
  const context = JSON.parse(await fs.readFile(prepared.attempt_context, "utf8"));
  const mode = (await fs.stat(prepared.attempt_context)).mode & 0o777; assert.equal(mode, 0o600);
  const artifact = await file(prepared.outputDir, "fixture-asset.txt", "Synthetic candidate, not actual media");
  const output = await file(f.dir, "assets-result.json", JSON.stringify({ artifacts: [{ id: "fixture-asset", kind: "document_crop", ...artifact, source_ids: ["E01"] }], metadata: {}, cost_usd: 0 }));
  const status = await executeTrueCrimeProofCli(["--action", "finish-assets", "--episode-dir", f.proofDir, "--result", output.path, "--attempt-token", context.attempt_token]);
  assert.equal(status.next_stage, "narration");
});
