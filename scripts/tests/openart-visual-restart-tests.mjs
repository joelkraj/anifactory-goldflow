import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BASELINE_STAGES, RESTART_SCHEMA, baselineFileAllowlist, requiredBaselineFiles,
  collectBaselineFiles, collectHistoricalVisualInventory, createOpenArtRestartIdentity, fileSha256, jsonBytes,
  nonvisualIdentityBinding, objectHash, openartRestartBaselineState, validateBaselineStages,
  validateOpenArtContract,
  openartTriageAdmission,
} from "../lib/openart-visual-restart.mjs";
import { normalizeImageProvider, providerSlug, routedProviderForPrompt } from "../lib/image-provider-routing.mjs";
import { commandStageFor } from "../lib/pipeline-stage-registry.mjs";
import { mediaWorkflowForPreflight } from "../lib/media-workflows.mjs";
import { assertCommandWorkflowRoute } from "../lib/episode-workflow-routing.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-openart-restart-test-"));
async function write(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof value === "string" ? value : jsonBytes(value));
}
try {
  const oldDir = path.join(root, "old", "ep_01");
  const newDir = path.join(root, "new", "ep_01");
  const discoveryPath = path.join(root, "discovery.json");
  await write(discoveryPath, { models: ["fixture-gpt-sunburst", "fixture-nb2"] });
  const contract = {
    schema: "goldflow_openart_image_contract_v1", transport: "openart_studio_browser",
    primary: { model_id: "fixture-gpt-sunburst", mode: "auto_t2i_i2i", quality: "low", resolution: "1k", aspect_ratio: "16:9" },
    repair_models: [{ model_id: "fixture-nb2", repair_only: true, exact_id_only: true }],
    discovery: { path: discoveryPath, sha256: await fileSha256(discoveryPath) },
    reference_bank_path: path.join(root, "bank"), normal_reference_count: 3, max_reference_count: 8,
    concurrency: 1, max_credit_cost: 30, total_credit_budget: 24000,
    automatic_retry: false, automatic_failover: false, discount_fraction: 0,
  };
  await validateOpenArtContract(contract);
  for (const edit of [c => { c.primary.quality = "medium"; }, c => { c.primary.model_id = "undiscovered"; }, c => { c.automatic_failover = true; }, c => { c.discount_fraction = 0.1; }, c => { c.max_credit_cost = Infinity; }, c => { c.repair_models[0].repair_only = false; }]) {
    const changed = structuredClone(contract); edit(changed);
    await assert.rejects(validateOpenArtContract(changed));
  }
  assert.equal(normalizeImageProvider("OpenArt"), "openart_cli");
  assert.equal(providerSlug("openart_cli"), "openart-cli");
  assert.equal(routedProviderForPrompt({ image_provider_route: "modelslab" }, "openart_cli"), "openart_cli");
  assert.equal(commandStageFor("visual", "openart-bank", { action: "approve-refs" }), "reference_image_approval");
  assert.equal(commandStageFor("imagegen", "openart", { action: "mark-submitted", "references-only": "true" }), "reference_generation");
  assert.equal(commandStageFor("imagegen", "openart", { action: "prepare" }), "image_generation");
  assert.equal(commandStageFor("visual", "openart-bank", { action: "status" }), null);
  const triageStatus = { identity: { image_provider: "openart_cli" }, current_stage: "reference_generation", current_stage_state: "blocked", next_command_shape: "node bin/goldflow.mjs imagegen openart --references-only true --action triage --repair <exact-id-repair.json>" };
  assert.equal(openartTriageAdmission(triageStatus, { action: "triage", "references-only": "true", repair: "/tmp/exact.json" }).allowed, true);
  assert.equal(openartTriageAdmission(triageStatus, { action: "triage", repair: "/tmp/exact.json" }).allowed, false);
  assert.equal(openartTriageAdmission({ ...triageStatus, next_command_shape: "node bin/goldflow.mjs imagegen openart --action prepare" }, { action: "triage", "references-only": "true", repair: "/tmp/exact.json" }).allowed, false);
  for (const forbidden of ["character_state_refs.json", "section_image_prompts.json", "visual_reference_plan.json", "reference_plan_approval.json", "reference_image_qa_ep_01.json", "imagegen_report_ep_01.json", "execution_events.jsonl", "production_manifest.json"]) assert(!baselineFileAllowlist("ep_01").includes(forbidden));
  for (const name of requiredBaselineFiles("ep_01")) await write(path.join(oldDir, name), { fixture: name });
  await write(path.join(oldDir, "script_clean.md"), "Exact approved narration.\n");
  const source = path.join(root, "source.md");
  await fs.copyFile(path.join(oldDir, "script_clean.md"), source);
  const wavPath = path.join(oldDir, "assets/audio/master.wav");
  await write(wavPath, "unit fixture audio bytes, not production media");
  const audioHash = await fileSha256(wavPath);
  await write(path.join(oldDir, "narration_word_timing_ep_01.json"), { narration_audio_path: wavPath, narration_audio_hash: audioHash });
  await write(path.join(oldDir, "longform_audio_bed_report_ep_01.json"), { narration_path: wavPath, narration_sha256: audioHash, final_audio_path: wavPath, final_audio_sha256: audioHash });
  const baseline = {
    schema: "goldflow_run_identity_v2", run_intent: "production", content_profile: "manhwa_recap_v1", ...mediaWorkflowForPreflight({ contentProfile: "manhwa_recap_v1", mediaWorkflow: "generated_visuals_v1" }),
    channel: "fixture", series_slug: "fixture", episode: "ep_01", week: "old", episode_dir: oldDir,
    title: "Approved fixture title", source_path: source, source_sha256: await fileSha256(source),
    audio_target: "narrator_only", proof_scope: { mode: "full_episode" }, image_provider: "federated_google_web_image_pool",
    provider_locks: { tts_provider: "fixture-tts", image_provider: "old", style_reference_provider: "old", reference_provider_pool: ["old"], google_flow_health_proof_path: "old", primary_reference_audio_sha256: audioHash },
    model_versions: { tts_model: "unchanged", image_model: "old", reference_model: "old" },
    production_profile_config: { media: { tts_concurrency: 1, default_image_provider: "old", google_flow_worker_session_policy: "old" }, render: { quality: "unchanged" } },
    voice_provider_options: { fixture: "voice-lock" }, visual_beat_timing_contract: { max_beat_sec: 8 },
  };
  await write(path.join(oldDir, "run_identity.json"), baseline);
  await write(path.join(oldDir, "assets/images/historical.png"), "Never import this historical visual");
  await write(path.join(oldDir, "imagegen_report_ep_01.json"), { results: [{ image_path: path.join(oldDir, "assets/images/historical.png") }] });
  const oldIdentityHash = await fileSha256(path.join(oldDir, "run_identity.json"));
  const status = { stage_ledger: ["run_identity", ...BASELINE_STAGES].map(stage => ({ stage, state: stage === "sfx_score_plan" ? "skipped_with_waiver" : "passed", evidence: "unit fixture" })) };
  validateBaselineStages(status);
  const badStatus = structuredClone(status); badStatus.stage_ledger.find(row => row.stage === "qwen_tts_stitch").state = "blocked";
  assert.throws(() => validateBaselineStages(badStatus), /not currently satisfied/);
  const files = await collectBaselineFiles(oldDir, baseline);
  assert(!files.some(row => row.relative_path.includes("images")));
  for (const row of files) { const out = path.join(newDir, row.relative_path); await fs.mkdir(path.dirname(out), { recursive: true }); await fs.copyFile(row.source_path, out); }
  await write(path.join(newDir, "baseline_status_snapshot.json"), status);
  const history = await collectHistoricalVisualInventory(oldDir, "ep_01");
  assert.equal(history.files.length, 2);
  assert(history.files.every(row => row.accepted_into_new_run === false));
  await write(path.join(newDir, "historical_visual_inventory.json"), history);
  const receipt = { schema: RESTART_SCHEMA, target_episode_dir: newDir, target_week: "new", baseline_identity_sha256: oldIdentityHash, files, script_sha256: baseline.source_sha256, baseline_status_sha256: await fileSha256(path.join(newDir, "baseline_status_snapshot.json")), historical_visual_inventory_sha256: await fileSha256(path.join(newDir, "historical_visual_inventory.json")) };
  await write(path.join(newDir, "visual_restart_receipt.json"), receipt);
  const identity = createOpenArtRestartIdentity({ baseline, targetDir: newDir, week: "new", contract, git: { dirty: false, commit: "fixture" }, receiptSha256: await fileSha256(path.join(newDir, "visual_restart_receipt.json")), baselineIdentitySha256: oldIdentityHash, createdAt: "fixture" });
  await write(path.join(newDir, "run_identity.json"), identity);
  assert.throws(() => assertCommandWorkflowRoute({ command: "imagegen", subcommand: "start", script: "imagegen.mjs", episodeDir: newDir, flags: { channel: "fixture", week: "new", episode: "ep_01", "workflow-bypass": "true" } }), /guarded OpenArt/);
  assert.throws(() => assertCommandWorkflowRoute({ command: "visual", subcommand: "plan", script: "visual-plan.mjs", episodeDir: newDir, flags: { channel: "fixture", week: "new", episode: "ep_01" } }), /guarded OpenArt/);
  assertCommandWorkflowRoute({ command: "imagegen", subcommand: "openart", script: "openart-production.mjs", episodeDir: newDir, flags: { "episode-dir": newDir, action: "prepare", "references-only": "true" } });
  assert.deepEqual(nonvisualIdentityBinding(identity), nonvisualIdentityBinding(baseline));
  assert.equal(identity.provider_locks.style_reference_provider, undefined);
  assert.equal(identity.provider_locks.google_flow_health_proof_path, undefined);
  assert.equal(identity.production_profile_config.media.google_flow_worker_session_policy, undefined);
  assert.equal(identity.provider_locks.primary_reference_audio_sha256, audioHash);
  assert.equal(await fileSha256(path.join(oldDir, "run_identity.json")), oldIdentityHash);
  let state = await openartRestartBaselineState({ episodeDir: newDir, identity });
  assert.equal(state.done, true, state.evidence);
  assert.equal(state.stageStates.voice_plan.done, true);
  assert.equal(state.stageStates.reference_generation, undefined);
  await fs.appendFile(path.join(oldDir, "assets/images/historical.png"), "mutated");
  const changedHistory = await openartRestartBaselineState({ episodeDir: newDir, identity });
  assert.equal(changedHistory.done, false); assert.match(changedHistory.evidence, /Historical visual evidence changed/);
  await write(path.join(oldDir, "assets/images/historical.png"), "Never import this historical visual");
  const changedVoice = structuredClone(identity); changedVoice.voice_provider_options.fixture = "other";
  assert.equal((await openartRestartBaselineState({ episodeDir: newDir, identity: changedVoice })).done, false);
  await write(path.join(newDir, "narration_word_timing_ep_01.json"), { changed: true });
  state = await openartRestartBaselineState({ episodeDir: newDir, identity });
  assert.equal(state.done, false); assert.match(state.evidence, /Carried artifact changed/);
  await fs.copyFile(path.join(oldDir, "narration_word_timing_ep_01.json"), path.join(newDir, "narration_word_timing_ep_01.json"));
  await fs.appendFile(wavPath, "modified");
  assert.equal((await openartRestartBaselineState({ episodeDir: newDir, identity })).done, false);
  assert.notEqual(objectHash(identity.voice_provider_options), objectHash(changedVoice.voice_provider_options));
  console.log("OpenArt restart tests passed: immutable nonvisual carryforward, exact model/cost contract, strict visual exclusions, stale narration/timing rejection, and stage routing.");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
