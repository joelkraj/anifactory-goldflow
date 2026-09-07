import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { executePilotCommand, pilotStatus, pilotWorkflowFixtureHarness, PILOT_OPENING_SYNTHESIS_ADAPTER_STATUS,
  PILOT_REMAINING_SYNTHESIS_ADAPTER_STATUS } from "../lib/avatar-pilot-workflow.mjs";
import { buildNarrationSubjectiveReviewManifest, validateNarrationSubjectiveReviewDecision } from "../lib/narration-subjective-review.mjs";
import { resolveMediaWorkflow, mediaWorkflowForPreflight } from "../lib/media-workflows.mjs";
import { stageRegistryFor } from "../lib/pipeline-stage-registry.mjs";
import { contentProfileForIdentity } from "../lib/content-profiles.mjs";
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
    ["conflicting-canonical-provider", { tts_provider: "fish_audio" }],
    ["conflicting-canonical-speed", { tts_native_speed: 1.1 }],
    ["conflicting-whisper-lock", { provider_locks: { local_whisper_timing: { model: "tiny" } } }],
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
  assert.equal(initial.identity.content_profile_config.version, "2026-09-07.1");
  assert.equal(initial.identity.voice_provider_options.primary.reference_audio_sha256, JOEL.reference_audio_sha256);
  assert.equal(initial.identity.voice_provider_options.synthesis_contract.nominal_batch_size, 4);
  assert.equal(initial.identity.pilot_narration_contract.synthesis_authorized, false);
  assert.match(initial.identity.content_profile_config.planner_roles.narration_performance, /assured.*decisions and consequences/);
  assert.ok(initial.identity.content_profile_config.voice.performance_directives.some((directive) => /do not add audience questions/.test(directive)));
  const historicalProfile = structuredClone(initial.identity.content_profile_config);
  historicalProfile.version = "2026-09-06.1";
  historicalProfile.planner_roles.narration_performance = "a conversational on-screen theorist exploring a movie what-if with the audience";
  assert.deepEqual(contentProfileForIdentity({ ...initial.identity, content_profile_config: historicalProfile }), historicalProfile, "a new pilot direction must not overwrite a historical embedded profile");
  assert.equal(initial.publish_allowed, false);
  assert.equal(stageRegistryFor(initial.identity).length, 14);
  assert.deepEqual(initial.allowed_command_stages, ["pilot_script"]);
  const immutableIdentity = await fs.readFile(path.join(episodeDir, "run_identity.json"));
  const changedVoiceIdentity = JSON.parse(immutableIdentity);
  changedVoiceIdentity.voice_provider_options.primary.reference_audio_sha256 = "0".repeat(64);
  await fs.writeFile(path.join(episodeDir, "run_identity.json"), JSON.stringify(changedVoiceIdentity));
  assert.equal((await pilotStatus(episodeDir)).current_stage, "run_identity", "status must reject changed canonical narration settings before media work");
  await fs.writeFile(path.join(episodeDir, "run_identity.json"), immutableIdentity);
  const historicalIdentity = JSON.parse(immutableIdentity);
  for (const key of ["tts_provider", "tts_fallback_provider", "narrator_voice_id", "tts_voice_id", "tts_native_speed", "voice_provider_options", "narration_quality_contract", "narration_delivery_reference_bank", "provider_locks", "production_profile_config", "production_gates", "model_versions", "pilot_narration_contract"]) delete historicalIdentity[key];
  historicalIdentity.content_profile_config = historicalProfile;
  await fs.writeFile(path.join(episodeDir, "run_identity.json"), JSON.stringify(historicalIdentity));
  const historicalBytes = await fs.readFile(path.join(episodeDir, "run_identity.json"));
  assert.equal((await pilotStatus(episodeDir)).current_stage, "pilot_script");
  assert.deepEqual(await fs.readFile(path.join(episodeDir, "run_identity.json")), historicalBytes, "read-only status must not retrofit canonical fields into historical identities");
  const partiallyStripped = JSON.parse(immutableIdentity);
  for (const key of ["pilot_narration_contract", "voice_provider_options", "tts_provider"]) delete partiallyStripped[key];
  await fs.writeFile(path.join(episodeDir, "run_identity.json"), JSON.stringify(partiallyStripped));
  assert.equal((await pilotStatus(episodeDir)).current_stage, "run_identity", "removing the three former discriminator keys cannot downgrade a canonical identity to historical");
  for (const field of [
    "pilot_narration_contract", "voice_provider_options", "tts_provider",
    "tts_fallback_provider", "narrator_voice_id", "tts_voice_id", "tts_native_speed",
    "narration_quality_contract", "narration_delivery_reference_bank",
    "provider_locks.local_whisper_timing",
    "production_profile_config.audio.local_whisper_timing",
    "production_gates.local_whisper_contract_required",
    "model_versions.tts_model", "model_versions.tts_model_revision",
    "model_versions.local_whisper_model",
  ]) {
    const partial = structuredClone(historicalIdentity);
    const keys = field.split(".");
    let parent = partial;
    for (const key of keys.slice(0, -1)) parent = parent[key] ??= {};
    // Presence, even null/false, must require the complete canonical contract.
    parent[keys.at(-1)] = null;
    await fs.writeFile(path.join(episodeDir, "run_identity.json"), JSON.stringify(partial));
    const report = await pilotStatus(episodeDir);
    assert.equal(report.current_stage, "run_identity", `partial canonical identity must block: ${field}`);
    assert.deepEqual(report.allowed_command_stages, []);
  }
  const legacyWithSharedMetadata = {
    ...historicalIdentity,
    provider_locks: { still_provider: "google_flow" },
    production_profile_config: { audio: { unrelated_fixture: true } },
    production_gates: { unrelated_fixture: true },
    model_versions: { image_model: "Synthetic image model" },
  };
  const sharedMetadataBytes = Buffer.from(JSON.stringify(legacyWithSharedMetadata));
  await fs.writeFile(path.join(episodeDir, "run_identity.json"), sharedMetadataBytes);
  assert.equal((await pilotStatus(episodeDir)).current_stage, "pilot_script", "unrelated shared metadata must not turn a genuine historical identity into a partial canonical one");
  assert.deepEqual(await fs.readFile(path.join(episodeDir, "run_identity.json")), sharedMetadataBytes);
  await fs.writeFile(path.join(episodeDir, "run_identity.json"), immutableIdentity);
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
  const openingReleased = PILOT_OPENING_SYNTHESIS_ADAPTER_STATUS === "proven";
  assert.equal(differentReviewer.capabilities.narration, openingReleased
    ? PILOT_REMAINING_SYNTHESIS_ADAPTER_STATUS === "proven"
      ? "scoped_opening_and_remaining_synthesis_with_separate_listening_gates"
      : "opening_only_scoped_synthesis_and_listening_full_narration_blocked"
    : "blocked_pending_proven_canonical_lineage_import_and_scoped_synthesis_adapter");
  assert.deepEqual(differentReviewer.allowed_command_stages, openingReleased ? ["pilot_voice_sample"] : [], "only a separately proven opening may advance");
  await assert.rejects(() => run("import-voice-sample", { input: evidencePath }), /stopped at|imports remain blocked/u);
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

  // The fixture dependency seam proves released workflow behavior while the
  // public capability remains independently release-gated. It never calls TTS.
  let producedCount = 0, forceInvalid = false;
  const fixtureAdapter = pilotWorkflowFixtureHarness({ status: "proven",
    async produce({ episodeDir: target, editorialPath }) {
      producedCount++;
      assert(path.isAbsolute(editorialPath));
      assert(await fs.stat(path.join(target, ".pilot-stage.lock")), "normal stage lease must cover production");
      const work = path.join(target, "pilot_narration_work"); await fs.mkdir(work);
      const outputDir = path.join(work, "opening_finalization"); await fs.mkdir(outputDir);
      const audioPath = path.join(outputDir, "fixture.wav");
      const sampleCount = 16 * 24000; const audio = Buffer.alloc(44 + sampleCount * 2);
      audio.write("RIFF"); audio.writeUInt32LE(audio.length - 8, 4); audio.write("WAVEfmt ", 8);
      audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
      audio.writeUInt32LE(24000, 24); audio.writeUInt32LE(48000, 28); audio.writeUInt16LE(2, 32);
      audio.writeUInt16LE(16, 34); audio.write("data", 36); audio.writeUInt32LE(sampleCount * 2, 40);
      await fs.writeFile(audioPath, audio);
      const unitIds = ["synthetic-opening-1", "synthetic-opening-2"];
      const plan = { units: unitIds.map((unit_id) => ({ unit_id, segment_id: "fixture", spoken_text: "Synthetic fixture sentence." })) };
      const planPath = path.join(work, "plan.json"); await fs.writeFile(planPath, JSON.stringify(plan));
      const planHash = hash(await fs.readFile(planPath));
      const manifest = buildNarrationSubjectiveReviewManifest({ plan,
        stitch: { prepared_inputs: unitIds.map((unit_id) => ({ unit_id, sample_count: sampleCount / 2 })) },
        audioPath, audioSha256: hash(audio), generationPlanSha256: planHash, generationPlanFileSha256: planHash,
        qualityContractSha256: hash("Synthetic fixture quality only") });
      const manifestPath = path.join(outputDir, "subjective.json");
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
      const payload = { schema: "goldflow_avatar_pilot_opening_producer_result_v1", phase: "opening",
        production_eligible: false, publish_allowed: false, subjective_approval: null,
        unit_ids: unitIds, generation_plan: { path: planPath, sha256: planHash },
        finalization_artifacts: { audio: { path: audioPath, sha256: hash(audio) },
          subjective_manifest: { path: manifestPath, sha256: hash(await fs.readFile(manifestPath)) } } };
      await fs.writeFile(path.join(work, "opening_producer_result.json"), `${JSON.stringify(payload)}\n`);
      return payload;
    },
    async validate(payload) {
      return { status: forceInvalid || payload.schema !== "goldflow_avatar_pilot_opening_producer_result_v1" ? "blocked" : "passed",
        findings: forceInvalid ? [{ code: "Synthetic invalid opening" }] : [] };
    },
  });
  const fixtureRun = (action, flags = {}, target) => fixtureAdapter.executePilotCommand(action, { "episode-dir": target, ...flags }, { repoRoot: repository });
  async function readyOpeningTarget(name, legacy = false) {
    const target = path.join(scratch, "runs", name);
    await fixtureRun("preflight", { identity: configPath }, target);
    if (legacy) {
      const file = path.join(target, "run_identity.json"); const old = JSON.parse(await fs.readFile(file));
      for (const key of ["tts_provider", "tts_fallback_provider", "narrator_voice_id", "tts_voice_id", "tts_native_speed", "voice_provider_options", "narration_quality_contract", "narration_delivery_reference_bank", "provider_locks", "production_profile_config", "production_gates", "model_versions", "pilot_narration_contract"]) delete old[key];
      await fs.writeFile(file, JSON.stringify(old));
    }
    await fixtureRun("ingest", { script: scriptPath }, target);
    await fixtureRun("approve-script", { accept: "true", reviewer: "fixture", note: "Synthetic exact script approval" }, target);
    await fixtureRun("approve-evidence", { input: evidencePath, reviewer: "fixture", note: "Synthetic evidence approval" }, target);
    return target;
  }
  const openingTarget = await readyOpeningTarget("opening-route");
  const editorialPath = await writeConfig("opening-editorial", { fixture: "provider-free workflow injection only" });
  const legacyTarget = await readyOpeningTarget("legacy-opening-route", true);
  const legacyReady = await fixtureAdapter.pilotStatus(legacyTarget);
  assert.equal(legacyReady.current_stage, "pilot_voice_sample"); assert.deepEqual(legacyReady.allowed_command_stages, []);
  await assert.rejects(() => fixtureRun("create-voice-sample", { input: editorialPath }, legacyTarget), /stopped at/u);
  assert.equal(producedCount, 0, "a historical identity cannot enter the new opening producer");
  const openingReady = await fixtureAdapter.pilotStatus(openingTarget);
  assert.equal(stageRegistryFor(openingReady.identity).length, 14, "aliases cannot change an existing registry");
  assert.match(openingReady.next_command_shape, /create-voice-sample.*--input/u);
  assert.deepEqual(openingReady.allowed_command_stages, ["pilot_voice_sample"]);
  await assert.rejects(() => fixtureRun("import-voice-sample", { input: editorialPath }, openingTarget), /imports remain blocked/u);
  await assert.rejects(() => fixtureRun("create-voice-sample", { input: editorialPath, "workflow-bypass": "true" }, openingTarget), /cannot be bypassed/u);
  assert.equal(producedCount, 0);
  if (!openingReleased) {
    await assert.rejects(() => executePilotCommand("create-voice-sample", { "episode-dir": openingTarget, input: editorialPath,
      "opening-capability": "proven" }, { repoRoot: repository }), /stopped at/u);
    assert.equal(producedCount, 0, "a CLI-like flag must not release the real adapter");
  }
  const created = await fixtureRun("create-voice-sample", { input: editorialPath }, openingTarget);
  assert.equal(created.current_stage, "pilot_voice_sample_approval"); assert.equal(producedCount, 1);
  await absent(path.join(openingTarget, ".pilot-stage.lock"));
  const openingReceiptPath = path.join(openingTarget, "pilot_voice_sample.json");
  const openingReceiptBytes = await fs.readFile(openingReceiptPath);
  const openingReceipt = JSON.parse(openingReceiptBytes);
  assert(openingReceipt.inputs.some((row) => row.role === "produced_opening"));
  await assert.rejects(() => fixtureRun("create-voice-sample", { input: editorialPath }, openingTarget), /cannot be rerun/u);
  const decisionPath = path.join(openingTarget, "pilot_narration_work", "opening_finalization", "narration_subjective_review_decision_ep_01.json");
  await absent(decisionPath);
  await assert.rejects(() => fixtureRun("approve-voice-sample", { accept: "true", reviewer: "fixture", note: "Missing listening" }, openingTarget), /attestation/u);
  await absent(decisionPath);
  const reviewed = await fixtureRun("approve-voice-sample", { accept: "true", reviewer: " fixture ", note: " Synthetic listening attestation for workflow fixture only ",
    attestation: "complete_opening_listened_end_to_end" }, openingTarget);
  assert.equal(reviewed.current_stage, "pilot_narration"); assert.deepEqual(reviewed.allowed_command_stages, []);
  const approval = JSON.parse(await fs.readFile(path.join(openingTarget, "pilot_voice_sample_approval.json")));
  const decision = JSON.parse(await fs.readFile(decisionPath));
  const subjective = JSON.parse(await fs.readFile(openingReceipt.payload.finalization_artifacts.subjective_manifest.path));
  assert.equal(validateNarrationSubjectiveReviewDecision(subjective, decision).status, "approved");
  assert.equal(approval.payload.listening_attestation_mapping.all_samples_contained_in_opening, true);
  assert.equal(decision.attestation, "all_hash_bound_narration_samples_listened_end_to_end");
  assert.deepEqual(await fs.readFile(openingReceiptPath), openingReceiptBytes, "approval preserves the opening receipt byte-for-byte");
  await assert.rejects(() => fixtureRun("import-narration", { input: editorialPath }, openingTarget), /stopped at pilot_narration/u);
  await fs.appendFile(decisionPath, " ");
  assert.equal((await fixtureAdapter.pilotStatus(openingTarget)).current_stage, "pilot_voice_sample_approval", "changed canonical decision invalidates the listening gate");
  assert.equal(producedCount, 1);
  const failedTarget = await readyOpeningTarget("failed-opening");
  forceInvalid = true;
  await assert.rejects(() => fixtureRun("create-voice-sample", { input: editorialPath }, failedTarget), /Synthetic invalid opening/u);
  forceInvalid = false;
  const failedStatus = await fixtureAdapter.pilotStatus(failedTarget);
  assert.equal(failedStatus.current_stage, "pilot_voice_sample"); assert.deepEqual(failedStatus.allowed_command_stages, []);
  assert.match(failedStatus.next_command_shape, /manual|triage/u);
  await assert.rejects(() => fixtureRun("create-voice-sample", { input: editorialPath }, failedTarget), /cannot be rerun/u);
  assert.equal(producedCount, 2, "failed execution must never call its producer again");
  await absent(path.join(failedTarget, ".pilot-stage.lock"));

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
