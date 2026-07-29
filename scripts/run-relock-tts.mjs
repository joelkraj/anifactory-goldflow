#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as narrationPolicy from "./lib/narration-tts-policy.mjs";
import { PIPELINE_STAGE_REGISTRY_VERSION } from "./lib/pipeline-stage-registry.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const QWEN_LIAM_PROFILE_ID = "qwen3_1_7b_base_liam_sentence_v1";

function parseFlags(parts) {
  const flags = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--")
      ? parts[++index]
      : "true";
    flags[key] = value;
  }
  return flags;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  return sha256(await fs.readFile(filePath));
}

async function exists(filePath) {
  return fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
}

function isTrue(value) {
  return /^(true|1|yes)$/i.test(String(value ?? ""));
}

function cleanValue(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function atomicWrite(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, contents);
  await fs.rename(temporary, filePath);
}

async function atomicWriteJson(filePath, value) {
  await atomicWrite(filePath, jsonBytes(value));
}

function gitCommand(args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 32,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return String(result.stdout ?? "").trim();
}

function cleanGitSnapshot() {
  const status = gitCommand(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status) {
    throw new Error(
      "Production TTS relock requires a clean Git worktree. Commit and validate the implementation before changing the run identity.",
    );
  }
  return {
    commit: gitCommand(["rev-parse", "HEAD"]),
    branch: gitCommand(["rev-parse", "--abbrev-ref", "HEAD"]),
    dirty: false,
    dirty_diff_sha256: null,
    dirty_status: [],
  };
}

function requireCanonicalQwenLiamOptions(options) {
  const primary = options?.primary ?? {};
  const unit = options?.unit_contract ?? {};
  const stitch = options?.stitch_contract ?? {};
  const mismatches = [];
  if (primary.provider !== "qwen_local") mismatches.push(`provider=${primary.provider ?? "missing"}`);
  if (primary.voice_id !== "am_liam") mismatches.push(`voice=${primary.voice_id ?? "missing"}`);
  if (options?.fallback != null) mismatches.push("fallback must be null");
  if (unit.sentence_complete !== true) mismatches.push("sentence_complete must be true");
  if (Number(unit.target_words_min) !== 45) mismatches.push(`target_words_min=${unit.target_words_min ?? "missing"}`);
  if (Number(unit.target_words_max) !== 60) mismatches.push(`target_words_max=${unit.target_words_max ?? "missing"}`);
  if (Number(unit.hard_words_max) !== 60) mismatches.push(`hard_words_max=${unit.hard_words_max ?? "missing"}`);
  if (unit.continuous_requests !== false) mismatches.push("continuous_requests must be false");
  if (Number(stitch.join_silence_ms) !== 80) mismatches.push(`join_silence_ms=${stitch.join_silence_ms ?? "missing"}`);
  if (stitch.post_tempo_processing !== false) mismatches.push("post_tempo_processing must be false");
  if (options?.retry_policy !== "confirmed_skips_truncations_or_stutters_only") {
    mismatches.push(`retry_policy=${options?.retry_policy ?? "missing"}`);
  }
  if (mismatches.length) {
    throw new Error(
      `Canonical ${QWEN_LIAM_PROFILE_ID} policy is unavailable or stale: ${mismatches.join(", ")}`,
    );
  }
  for (const field of [
    "model_id",
    "model_revision",
    "model_weights_sha256",
    "model_config_sha256",
    "generation_config_sha256",
    "speech_tokenizer_weights_sha256",
    "speech_tokenizer_config_sha256",
    "runtime",
    "runtime_version",
    "voice_sha256",
    "reference_audio_path",
    "reference_audio_sha256",
    "reference_text",
    "reference_text_sha256",
    "reference_manifest_path",
    "reference_manifest_sha256",
    "reference_voice_sha256",
    "voice_continuity_contract",
  ]) {
    if (primary[field] == null || primary[field] === "") {
      throw new Error(`Canonical ${QWEN_LIAM_PROFILE_ID} primary lock is missing ${field}.`);
    }
  }
  return options;
}

function qwenLiamProviderLocks(primary, options) {
  return {
    tts_provider: primary.provider,
    tts_fallback_provider: null,
    narrator_voice_id: primary.voice_id,
    narrator_voice_sha256: primary.voice_sha256,
    primary_voice_sha256: primary.voice_sha256,
    tts_native_speed: null,
    tts_model: primary.model_id,
    tts_model_revision: primary.model_revision,
    tts_model_weights_sha256: primary.model_weights_sha256,
    tts_model_config_sha256: primary.model_config_sha256,
    tts_generation_config_sha256: primary.generation_config_sha256,
    tts_speech_tokenizer_weights_sha256: primary.speech_tokenizer_weights_sha256,
    tts_speech_tokenizer_config_sha256: primary.speech_tokenizer_config_sha256,
    tts_speed_control: "unsupported",
    tts_unit_target_words_min: Number(options.unit_contract.target_words_min),
    tts_unit_target_words_max: Number(options.unit_contract.target_words_max),
    tts_unit_hard_words_max: Number(options.unit_contract.hard_words_max),
    tts_sentence_complete_units: true,
    tts_join_silence_ms: Number(options.stitch_contract.join_silence_ms),
    tts_continuous_requests: false,
    post_tempo_processing: false,
    tts_retry_policy: options.retry_policy,
    tts_automatic_asr_retry: options.retry_contract?.automatic_asr_retry ?? false,
    tts_confirmed_defect_types: structuredClone(
      options.retry_contract?.confirmed_defect_types ?? ["skip", "truncation", "stutter"],
    ),
    narrator_voice_identity: primary.voice_id,
    primary_reference_audio_sha256: primary.reference_audio_sha256,
    primary_reference_manifest_sha256: primary.reference_manifest_sha256 ?? null,
    primary_reference_metadata_sha256: primary.reference_metadata_sha256 ?? null,
    primary_reference_voice_sha256: primary.reference_voice_sha256,
    primary_voice_continuity_contract: primary.voice_continuity_contract ?? null,
    primary_similarity_model_sha256: primary.speaker_similarity_model_sha256 ?? null,
    primary_similarity_calibration_sha256: primary.speaker_similarity_calibration_sha256 ?? null,
    primary_minimum_cosine_similarity: primary.minimum_cosine_similarity ?? null,
    primary_warning_below_cosine_similarity: primary.warning_below_cosine_similarity ?? null,
    fallback_tts_model: null,
    fallback_tts_model_revision: null,
    fallback_voice_identity: null,
    fallback_reference_audio_sha256: null,
    fallback_reference_metadata_sha256: null,
    fallback_similarity_model_sha256: null,
    fallback_similarity_calibration_sha256: null,
    fallback_minimum_cosine_similarity: null,
    fallback_warning_below_cosine_similarity: null,
    qwen_narrator_voice_id: null,
  };
}

export function relockedIdentityForTests(identity, {
  voiceProviderOptions,
  git,
  timestamp,
  archiveDir,
  previousIdentitySha256,
  reason,
} = {}) {
  const options = requireCanonicalQwenLiamOptions(voiceProviderOptions);
  const primary = options.primary;
  const migrated = structuredClone(identity);
  migrated.stage_registry_version = PIPELINE_STAGE_REGISTRY_VERSION;
  migrated.tts_profile = QWEN_LIAM_PROFILE_ID;
  migrated.tts_provider = primary.provider;
  migrated.tts_fallback_provider = null;
  migrated.narrator_voice_id = primary.voice_id;
  migrated.tts_voice_id = primary.voice_id;
  migrated.tts_native_speed = null;
  migrated.voice_provider_options = structuredClone(options);
  delete migrated.qwen_narrator_voice_id;
  delete migrated.qwen_narrator_voice_policy;
  delete migrated.qwen_native_speed;
  migrated.provider_locks = {
    ...(migrated.provider_locks ?? {}),
    ...qwenLiamProviderLocks(primary, options),
  };
  migrated.model_versions = {
    ...(migrated.model_versions ?? {}),
    tts_model: primary.model_id,
    tts_model_revision: primary.model_revision,
    tts_runtime: `${primary.runtime}@${primary.runtime_version}`,
    fallback_tts_model: null,
    fallback_tts_model_revision: null,
    fallback_tts_runtime: null,
  };
  migrated.production_profile_config = {
    ...(migrated.production_profile_config ?? {}),
    media: {
      ...(migrated.production_profile_config?.media ?? {}),
      tts_concurrency: 1,
      kokoro_tts_concurrency: 1,
      qwen_tts_concurrency: 1,
      local_qwen_tts_concurrency: 1,
    },
  };
  migrated.production_gates = {
    ...(migrated.production_gates ?? {}),
    provider_native_tts_speed_required: false,
    tts_speed_control_supported: false,
    post_tempo_normalization_default: false,
    single_narrator_identity_required: true,
    fallback_must_clone_primary_voice_identity: false,
    sentence_complete_tts_units_required: true,
    tts_unit_hard_words_max: Number(options.unit_contract.hard_words_max),
    tts_join_silence_ms: Number(options.stitch_contract.join_silence_ms),
    continuous_longform_tts_requests_forbidden: true,
  };
  migrated.git = structuredClone(git);
  migrated.dirty_worktree_waiver = null;
  migrated.updated_at = timestamp;
  migrated.narration_identity_relock = {
    schema: "goldflow_narration_identity_relock_v1",
    profile: QWEN_LIAM_PROFILE_ID,
    relocked_at: timestamp,
    reason,
    previous_run_identity_sha256: previousIdentitySha256,
    archive_dir: archiveDir,
    invalidation_boundary: "voice_plan",
    preserved_upstream_boundary: "semantic_scene_plan",
    primary_provider: primary.provider,
    narrator_voice_id: primary.voice_id,
    reference_audio_sha256: primary.reference_audio_sha256,
    unit_contract: structuredClone(options.unit_contract),
    stitch_contract: structuredClone(options.stitch_contract),
    retry_policy: options.retry_policy ?? "confirmed_skips_truncations_or_stutters_only",
    retry_contract: structuredClone(options.retry_contract ?? null),
    preserves_script_and_semantic_artifacts: true,
    preserves_historical_audio_assets: true,
  };
  return migrated;
}

function archiveCandidateNames(episode) {
  return new Set([
    "run_identity.json",
    "narration_generation_plan.json",
    "qwen_generation_plan.json",
    "audio_performance_plan.json",
    "narration_text_integrity_coverage_report.json",
    "system_ui_speech_coverage_report.json",
    "voice_reference_completeness_report.json",
    "dialogue_map.json",
    `dialogue_performance_audit_${episode}.json`,
    "voice_artifact_contamination_report.json",
    `voice_artifact_contamination_report_${episode}.json`,
    `voice_direction_quality_report_${episode}.json`,
    `voice_direction_strategy_${episode}.json`,
    "voice_director_debug_script.txt",
    `narration_tts_report_${episode}.json`,
    `narration_tts_unit_qa_${episode}.json`,
    `narration_full_stream_qa_${episode}.json`,
    `audio_stitch_report_${episode}-narration.json`,
    `narration_tts_plan_validation_${episode}.json`,
    "narration_tts_attempt_events.jsonl",
    `narration_word_timing_${episode}.json`,
    `narration_pace_report_${episode}.json`,
    "timed_scene_plan.json",
    "audio_design_plan.json",
    "production_manifest.json",
    "run_advance_state.json",
  ]);
}

function timingDerivedName(name, episode) {
  return name === `narration_word_timing_${episode}.json`
    || name === `narration_pace_report_${episode}.json`
    || name === "timed_scene_plan.json"
    || name === "audio_design_plan.json"
    || /^longform_audio_bed_report_.*\.json$/.test(name)
    || /^sfx_event_plan_.*\.json$/.test(name)
    || /^score_drop_plan_.*\.json$/.test(name);
}

async function snapshotRecoveryArtifacts(episodeDir, archiveDir, episode) {
  const names = await fs.readdir(episodeDir).catch(() => []);
  const selected = archiveCandidateNames(episode);
  for (const name of names) {
    if (timingDerivedName(name, episode)) selected.add(name);
  }
  const snapshots = [];
  for (const name of [...selected].sort()) {
    const source = path.join(episodeDir, name);
    if (!(await exists(source))) continue;
    const destination = path.join(archiveDir, "artifacts", name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
    snapshots.push({
      path: source,
      archived_path: destination,
      sha256: await sha256File(source),
      invalidated_by_relock: name !== "production_manifest.json"
        && name !== "run_advance_state.json"
        && name !== "run_identity.json",
      invalidation_reason: timingDerivedName(name, episode)
        ? "depends_on_superseded_narration_audio_or_timing"
        : "depends_on_superseded_tts_identity_or_voice_plan",
    });
  }
  return snapshots;
}

async function currentHashes(episodeDir, names) {
  const rows = [];
  for (const name of names) {
    const filePath = path.join(episodeDir, name);
    if (!(await exists(filePath))) continue;
    rows.push({ path: filePath, sha256: await sha256File(filePath) });
  }
  return rows;
}

async function retainedNarrationAudioAssets(episodeDir, episode) {
  const candidates = [];
  for (const reportName of [
    `narration_tts_report_${episode}.json`,
    `audio_stitch_report_${episode}-narration.json`,
  ]) {
    const reportPath = path.join(episodeDir, reportName);
    const report = await fs.readFile(reportPath, "utf8").then(JSON.parse).catch(() => null);
    if (!report) continue;
    candidates.push(
      report.final_wav,
      report.final_m4a,
      report.output_path,
      report.final_audio_path,
      report.final_wav_path,
      report.final_m4a_path,
    );
  }
  const assets = [];
  for (const filePath of [...new Set(candidates.map(cleanValue).filter(Boolean))]) {
    const resolved = path.resolve(filePath);
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat?.isFile()) continue;
    assets.push({
      path: resolved,
      sha256: await sha256File(resolved),
      size_bytes: stat.size,
      retained_in_place: true,
      selected_for_new_production: false,
    });
  }
  return assets;
}

async function verifyCanonicalAssets(primary) {
  if (await sha256File(primary.reference_audio_path) !== primary.reference_audio_sha256) {
    throw new Error("Canonical Liam reference audio is missing or its hash has changed.");
  }
  if (sha256(primary.reference_text) !== primary.reference_text_sha256) {
    throw new Error("Canonical Liam reference transcript hash does not match.");
  }
  for (const [filePath, expected, label] of [
    [primary.reference_manifest_path, primary.reference_manifest_sha256, "reference manifest"],
    [primary.reference_text_path, primary.reference_text_file_sha256, "reference transcript file"],
    [primary.reference_metadata_path, primary.reference_metadata_sha256, "reference metadata"],
    [primary.speaker_similarity_model_path, primary.speaker_similarity_model_sha256, "speaker-similarity model"],
    [primary.speaker_similarity_calibration_path, primary.speaker_similarity_calibration_sha256, "speaker-similarity calibration"],
  ]) {
    if (!filePath && !expected) continue;
    if (!filePath || !expected || await sha256File(filePath) !== expected) {
      throw new Error(`Canonical Liam ${label} is missing or its hash has changed.`);
    }
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const episodeDir = path.resolve(String(flags["episode-dir"] ?? ""));
  const reason = cleanValue(flags.reason);
  const requestedProfile = cleanValue(flags["tts-profile"]);
  if (!episodeDir || episodeDir === path.parse(episodeDir).root) {
    throw new Error("--episode-dir must resolve to one exact episode directory.");
  }
  if (!isTrue(flags["operator-approved"])) {
    throw new Error("--operator-approved true is required for a production narrator identity relock.");
  }
  if (!isTrue(flags["workflow-bypass"])) {
    throw new Error("--workflow-bypass true is required because this recovery intentionally returns an established run to voice_plan.");
  }
  if (!reason) throw new Error("--reason is required for the append-only recovery record.");
  if (requestedProfile !== QWEN_LIAM_PROFILE_ID) {
    throw new Error(`--tts-profile must be the exact audited profile ${QWEN_LIAM_PROFILE_ID}.`);
  }

  const identityPath = path.join(episodeDir, "run_identity.json");
  const identityRaw = await fs.readFile(identityPath);
  const identity = JSON.parse(identityRaw);
  if (identity.schema !== "goldflow_run_identity_v2") {
    throw new Error(`run relock-tts requires goldflow_run_identity_v2; got ${identity.schema ?? "missing"}.`);
  }
  if (String(identity.run_intent ?? "production") !== "production") {
    throw new Error("run relock-tts is scoped to an explicit production identity.");
  }
  if (identity.proof_scope?.mode !== "full_episode") {
    throw new Error("run relock-tts refuses a bounded proof identity.");
  }
  if (identity.tts_provider !== "kokoro_local"
    || identity.narrator_voice_id !== "am_puck") {
    throw new Error(
      `run relock-tts currently supports only the explicit Kokoro/Puck to Qwen/Liam recovery; found ${identity.tts_provider ?? "missing"}/${identity.narrator_voice_id ?? "missing"}.`,
    );
  }

  const git = cleanGitSnapshot();
  const voiceProviderOptions = requireCanonicalQwenLiamOptions(
    narrationPolicy.defaultNarrationVoiceProviderOptions(),
  );
  await verifyCanonicalAssets(voiceProviderOptions.primary);

  const timestamp = new Date().toISOString();
  const archiveSlug = timestamp.replace(/[:.]/g, "-");
  const archiveDir = path.join(
    episodeDir,
    "reports",
    "recovery",
    `${archiveSlug}-puck-to-qwen-liam`,
  );
  await fs.mkdir(path.dirname(archiveDir), { recursive: true });
  await fs.mkdir(archiveDir, { recursive: false });
  const snapshots = await snapshotRecoveryArtifacts(
    episodeDir,
    archiveDir,
    identity.episode,
  );
  const retainedAudioAssets = await retainedNarrationAudioAssets(
    episodeDir,
    identity.episode,
  );
  const beforeHash = sha256(identityRaw);
  const preservedArtifacts = await currentHashes(episodeDir, [
    "script_clean.md",
    "operator_script_approval.json",
    "script_lock.json",
    "script_pace_report.json",
    "script_speakability_report.json",
    "tts_spoken_overrides.json",
    "semantic_scene_plan.json",
    "story_fact_ledger.json",
    `manual_semantic_location_ref_repairs_${identity.episode}.json`,
  ]);
  const migrated = relockedIdentityForTests(identity, {
    voiceProviderOptions,
    git,
    timestamp,
    archiveDir,
    previousIdentitySha256: beforeHash,
    reason,
  });
  narrationPolicy.validateNarrationTtsPolicy(
    narrationPolicy.narrationTtsPolicyForIdentity(migrated),
    { production: true },
  );
  const migratedBytes = jsonBytes(migrated);
  const afterHash = sha256(migratedBytes);
  const executionEvents = (await fs.readFile(
    path.join(episodeDir, "execution_events.jsonl"),
    "utf8",
  ).catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  const completedExecutionIds = new Set(executionEvents
    .filter((row) => row.event_type === "stage_completed")
    .map((row) => row.execution_id)
    .filter(Boolean));
  const abandonedWhisperStarts = executionEvents
    .filter((row) => (
      row.event_type === "stage_started"
      && row.stage === "local_whisper_word_timing"
    ))
    .filter((row) => !completedExecutionIds.has(row.execution_id))
    .map((row) => row.execution_id)
    .filter(Boolean);

  const triage = {
    schema: "goldflow_manual_blocker_triage_v1",
    status: "approved_recovery",
    stage: "voice_plan",
    episode: identity.episode,
    recorded_at: timestamp,
    operator_request: reason,
    workflow_bypass_authorized: true,
    disposition: "full_official_qwen_liam_voice_plan_and_narration_rebuild",
    evidence_reviewed: [
      "The operator explicitly superseded the Puck primary lock with the audited Qwen3-TTS 1.7B Base Liam-clone profile.",
      "The approved script, speakability overrides, semantic scene plan, and fact ledger are script-hash-bound and do not depend on narrator identity.",
      "The existing narration plan embeds the superseded run identity hash, so voice_plan is the narrowest valid invalidation boundary.",
      "No historical artifact or audio asset is deleted; affected root artifacts are hash-snapshotted in the immutable recovery archive before replacement.",
    ],
    tts_profile: QWEN_LIAM_PROFILE_ID,
    run_identity_before_sha256: beforeHash,
    run_identity_after_sha256: afterHash,
    recovery_archive_dir: archiveDir,
    preserved_artifacts: preservedArtifacts,
    invalidated_artifacts: snapshots.filter((row) => row.invalidated_by_relock),
    retained_historical_audio_assets: retainedAudioAssets,
    abandoned_whisper_stage_start_execution_ids: abandonedWhisperStarts,
    invalidation_boundary: "voice_plan",
    preserved_upstream_boundary: "semantic_scene_plan",
    next_required_artifact: "narration_generation_plan.json",
    next_required_command: `node bin/goldflow.mjs voice plan --channel ${identity.channel} --series ${identity.series_slug} --week ${identity.week} --episode ${identity.episode}`,
  };
  const triagePath = path.join(
    episodeDir,
    `manual_blocker_triage_qwen_liam_relock_${identity.episode}.json`,
  );
  const recoveryReport = {
    schema: "goldflow_tts_identity_relock_report_v1",
    status: "passed",
    recovery_id: randomUUID(),
    recorded_at: timestamp,
    episode_dir: episodeDir,
    episode: identity.episode,
    tts_profile: QWEN_LIAM_PROFILE_ID,
    run_identity_before_sha256: beforeHash,
    run_identity_after_sha256: afterHash,
    git,
    preserved_artifacts: preservedArtifacts,
    archived_artifacts: snapshots,
    retained_historical_audio_assets: retainedAudioAssets,
    triage_path: triagePath,
    next_stage: "voice_plan",
  };

  await atomicWrite(identityPath, migratedBytes);
  await atomicWriteJson(triagePath, triage);
  const recoveryReportPath = path.join(archiveDir, "tts_identity_relock_report.json");
  await atomicWriteJson(recoveryReportPath, recoveryReport);

  console.log(JSON.stringify({
    status: "passed",
    episode_dir: episodeDir,
    tts_profile: QWEN_LIAM_PROFILE_ID,
    run_identity_path: identityPath,
    run_identity_before_sha256: beforeHash,
    run_identity_after_sha256: afterHash,
    archive_dir: archiveDir,
    archived_artifact_count: snapshots.length,
    triage_path: triagePath,
    recovery_report_path: recoveryReportPath,
    next_required_stage: "voice_plan",
  }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  QWEN_LIAM_PROFILE_ID,
  requireCanonicalQwenLiamOptions,
};
