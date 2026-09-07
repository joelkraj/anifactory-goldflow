import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { executePilotCommand, pilotStatus } from "../lib/avatar-pilot-workflow.mjs";
import { resolveMediaWorkflow, mediaWorkflowForPreflight } from "../lib/media-workflows.mjs";
import { stageRegistryFor } from "../lib/pipeline-stage-registry.mjs";
import { QWEN_JOEL_DRY_DEADPAN_PRIMARY_LOCK as JOEL } from "../lib/narration-tts-policy.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-pilot-workflow-test-"));
try {
  const repository = path.join(scratch, "code");
  await fs.mkdir(repository);
  const git = (...args) => execFileSync("git", args, { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--quiet", "--initial-branch=codex/pilot-fixture");
  const tracked = path.join(repository, "fixture.txt");
  await fs.writeFile(tracked, "Clean synthetic code fixture.\n");
  git("add", "fixture.txt");
  git("-c", "user.name=Goldflow Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Create synthetic fixture");
  const script = `${"We are exploring a hypothetical question together, weighing only the film evidence before considering an imagined outcome. ".repeat(6).trim()}\n`;
  const scriptPath = path.join(scratch, "candidate.md");
  await fs.writeFile(scriptPath, script);
  const scriptHash = hash(script);
  const config = {
    channel: "pilot-fixture", series_slug: "mcu-what-if", week: "sentry-proof", episode: "ep_01", title: "Synthetic what-if workflow fixture",
    content_profile: "mcu_what_if_pilot_v1", media_workflow: "avatar_footage_pilot_v1",
    run_intent: "proof", production_eligible: false, publish_allowed: false,
    audio_target: "commentary_with_optional_source_audio",
    proof_scope: { start_sec: 0, end_sec: 90, duration_frames: 2700, fps: 30, width: 1920, height: 1080 },
    source_script: { path: scriptPath, sha256: scriptHash },
    pilot_providers: {
      stills: [{ provider: "google_gemini_imagen", model: "Synthetic locked image model" }],
      video: { provider: "google_flow", model: "Synthetic locked video model", enabled: false },
      narration: { provider: "qwen_local", model: JOEL.model_id, model_revision: JOEL.model_revision, voice_id: JOEL.voice_id, voice_sha256: JOEL.voice_sha256, reference_audio_sha256: JOEL.reference_audio_sha256, reference_text_sha256: JOEL.reference_text_sha256 },
    },
  };
  const writeConfig = async (name, value = config) => {
    const configPath = path.join(scratch, `${name}.json`);
    await fs.writeFile(configPath, `${JSON.stringify(value, null, 2)}\n`);
    return configPath;
  };
  const configPath = await writeConfig("proof-config");
  const episodeDir = path.join(scratch, "runs", "valid", "ep_01");
  const run = (action, flags = {}, target = episodeDir) => executePilotCommand(action, { "episode-dir": target, ...flags }, { repoRoot: repository });
  const absent = async (target) => assert.equal(await fs.stat(target).then(() => false, (error) => error.code === "ENOENT"), true);

  assert.equal(resolveMediaWorkflow({}).id, "generated_visuals_v1");
  assert.equal(stageRegistryFor({}).length, 37);
  assert.throws(() => mediaWorkflowForPreflight({ contentProfile: "manhwa_recap_v1", mediaWorkflow: "avatar_footage_pilot_v1" }), /together|paired|requires/i);
  assert.throws(() => mediaWorkflowForPreflight({ contentProfile: "mcu_what_if_pilot_v1", mediaWorkflow: "generated_visuals_v1" }), /together|paired|requires/i);
  assert.throws(() => mediaWorkflowForPreflight({ contentProfile: "mcu_what_if_pilot_v1", mediaWorkflow: "unknown_workflow" }), /Unknown/);
  assert.throws(() => mediaWorkflowForPreflight({ contentProfile: "movie_tv_commentary_v1", mediaWorkflow: "source_footage_v1" }), /reserved/);
  await assert.rejects(() => executePilotCommand("preflight", { identity: configPath }, { repoRoot: repository }), /explicit --episode-dir/);
  await assert.rejects(() => run("preflight", { identity: configPath, "workflow-bypass": "true" }), /cannot be bypassed/);
  await absent(episodeDir);
  for (const [name, change] of [
    ["wrong-duration", { proof_scope: { ...config.proof_scope, end_sec: 91 } }],
    ["production", { run_intent: "production", production_eligible: true }],
    ["publish", { publish_allowed: true }],
    ["codex", { pilot_providers: { ...config.pilot_providers, stills: [{ provider: "codex_imagegen", model: "Not authorized" }] } }],
    ["wrong-joel", { pilot_providers: { ...config.pilot_providers, narration: { ...config.pilot_providers.narration, reference_audio_sha256: "0".repeat(64) } } }],
    ["wrong-model", { pilot_providers: { ...config.pilot_providers, narration: { ...config.pilot_providers.narration, model: "Unapproved model" } } }],
    ["wrong-profile", { content_profile: "manhwa_recap_v1" }],
    ["wrong-workflow", { media_workflow: "generated_visuals_v1" }],
  ]) {
    const badPath = await writeConfig(name, { ...config, ...change });
    const target = path.join(scratch, "runs", name);
    await assert.rejects(() => run("preflight", { identity: badPath }, target));
    await absent(target);
  }
  const initial = await run("preflight", { identity: configPath });
  assert.equal(initial.current_stage, "pilot_script");
  assert.equal(initial.identity.git.dirty, false);
  assert.equal(initial.identity.git.commit, git("rev-parse", "HEAD"));
  assert.equal(initial.publish_allowed, false);
  assert.equal(stageRegistryFor(initial.identity).length, 14);
  assert.deepEqual(initial.allowed_command_stages, ["pilot_script"]);
  const immutableIdentity = await fs.readFile(path.join(episodeDir, "run_identity.json"));
  await assert.rejects(() => run("preflight", { identity: configPath }), /never overwritten/);
  assert.deepEqual(await fs.readFile(path.join(episodeDir, "run_identity.json")), immutableIdentity);
  await assert.rejects(() => run("render"), /stopped at pilot_script/);
  await assert.rejects(() => run("publish"), /Unknown pilot action/);
  await assert.rejects(() => run("narrate"), /Unknown pilot action/);
  const priorBypass = process.env.GOLDFLOW_WORKFLOW_BYPASS;
  try {
    process.env.GOLDFLOW_WORKFLOW_BYPASS = "true";
    await assert.rejects(() => run("approve-script", { accept: "true", reviewer: "fixture", note: "Out of order" }), /stopped at pilot_script/);
  } finally {
    if (priorBypass === undefined) delete process.env.GOLDFLOW_WORKFLOW_BYPASS;
    else process.env.GOLDFLOW_WORKFLOW_BYPASS = priorBypass;
  }
  const ingested = await run("ingest", { script: scriptPath });
  assert.equal(ingested.current_stage, "pilot_script_approval");
  const immutableScript = await fs.readFile(path.join(episodeDir, "pilot_script.json"));
  await assert.rejects(() => run("ingest", { script: scriptPath }), /cannot be rerun/);
  await assert.rejects(() => run("approve-script", { reviewer: "fixture", note: "Missing accept" }), /--accept true/);
  assert.equal((await pilotStatus(episodeDir)).current_stage, "pilot_script_approval");
  const approved = await run("approve-script", { accept: "true", reviewer: "fixture", note: "Reviewed exact synthetic candidate" });
  assert.equal(approved.current_stage, "pilot_evidence");
  const evidence = {
    schema: "goldflow_avatar_pilot_evidence_v1", source_script_sha256: scriptHash,
    claims: [
      { id: "fact", kind: "film_fact", text: "Synthetic test claim only", source: { title: "Synthetic", edition: "Fixture edition", source_in_sec: 0, source_out_sec: 4, locator: "Synthetic locator", reviewed: true, rights_basis: "Synthetic fixture permission" } },
      { id: "assumption", kind: "assumption", text: "The changed assumption" },
      { id: "speculation", kind: "speculation", text: "An imagined consequence" },
      { id: "limitation", kind: "limitation", text: "An unresolved question" },
    ],
    review: { reviewer: "fixture", note: "Synthetic recorded review only", all_factual_abilities_reviewed: true, mcu_only: true },
  };
  const evidencePath = await writeConfig("evidence", evidence);
  const differentReviewer = await run("approve-evidence", { input: evidencePath, reviewer: "fixture", note: "Recorded synthetic source/rights review" });
  assert.equal(differentReviewer.current_stage, "pilot_voice_sample");
  assert.equal(differentReviewer.capabilities.narration, "blocked_pending_proven_canonical_lineage_import_and_scoped_synthesis_adapter");
  assert.deepEqual(differentReviewer.allowed_command_stages, [], "voice import cannot advance while its canonical lineage adapter is unproven");
  const events = (await fs.readFile(path.join(episodeDir, "execution_events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(events.some((event) => event.status === "blocked"));
  assert.equal(events.filter((event) => event.status === "passed").length, 4);
  assert.ok(events.every((event) => event.creative_submissions === 0 && event.provider_cost === 0));
  assert.deepEqual(await fs.readFile(path.join(episodeDir, "pilot_script.json")), immutableScript);

  await fs.writeFile(evidencePath, JSON.stringify({ ...evidence, source_script_sha256: "d".repeat(64) }));
  const staleEvidence = await pilotStatus(episodeDir);
  assert.equal(staleEvidence.current_stage, "pilot_evidence");
  assert.deepEqual(staleEvidence.allowed_command_stages, []);
  await assert.rejects(() => run("import-voice-sample", { input: evidencePath }), /stopped at pilot_evidence/);
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  assert.equal((await pilotStatus(episodeDir)).current_stage, "pilot_voice_sample");
  await fs.appendFile(scriptPath, "Changed candidate after approval.\n");
  assert.equal((await pilotStatus(episodeDir)).current_stage, "pilot_script");
  await fs.writeFile(scriptPath, script);

  await fs.appendFile(tracked, "Uncommitted fixture change.\n");
  const dirtyTarget = path.join(scratch, "runs", "dirty");
  await assert.rejects(() => run("preflight", { identity: configPath }, dirtyTarget), /clean code/);
  await absent(dirtyTarget);
  await assert.rejects(() => run("preflight", { identity: configPath, "allow-dirty-worktree": "true", "dirty-reason": "short" }, dirtyTarget), /meaningful/);
  const dirty = await run("preflight", { identity: configPath, "allow-dirty-worktree": "true", "dirty-reason": "Explicit bounded synthetic fixture diagnostics" }, dirtyTarget);
  assert.equal(dirty.identity.git.dirty, true);
  assert.equal(dirty.identity.run_intent, "proof");
  const untracked = path.join(repository, "untracked-fixture.txt");
  await fs.writeFile(untracked, "Untracked contents one.\n");
  const dirtyOne = await run("preflight", { identity: configPath, "allow-dirty-worktree": "true", "dirty-reason": "Explicit bounded untracked provenance fixture" }, path.join(scratch, "runs", "untracked-one"));
  await fs.writeFile(untracked, "Untracked contents two.\n");
  const dirtyTwo = await run("preflight", { identity: configPath, "allow-dirty-worktree": "true", "dirty-reason": "Explicit bounded untracked provenance fixture" }, path.join(scratch, "runs", "untracked-two"));
  assert.notEqual(dirtyOne.identity.git.dirty_diff_sha256, dirtyTwo.identity.git.dirty_diff_sha256, "untracked content changes must change proof provenance");
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
console.log("Avatar pilot workflow tests passed (temporary Git fixtures, no providers or real episodes).");
