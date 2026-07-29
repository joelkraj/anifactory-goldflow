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
const PUCK_TO_QWEN_RECOVERY_KIND = "puck_to_qwen_liam_identity_migration";
const QWEN_PLANNER_FIX_RECOVERY_KIND = "qwen_liam_planner_fix_relock";
const INTERRUPTED_QWEN_REUSE_POLICY =
  "reuse_allowed_only_for_exact_unchanged_single_segment_content_addressed_units";

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
  const synthesis = options?.synthesis_contract ?? {};
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
  if (JSON.stringify(synthesis)
    !== JSON.stringify(narrationPolicy.QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT)) {
    mismatches.push(
      `synthesis_contract=${synthesis.contract_id ?? "missing"}`,
    );
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

export function recoveryKindForIdentityForTests(identity = {}) {
  const provider = cleanValue(identity.tts_provider);
  const voiceId = cleanValue(identity.narrator_voice_id ?? identity.tts_voice_id);
  const fallback = identity.tts_fallback_provider
    ?? identity.voice_provider_options?.fallback?.provider
    ?? null;
  if (provider === "kokoro_local" && voiceId === "am_puck") {
    return PUCK_TO_QWEN_RECOVERY_KIND;
  }
  if (provider === "qwen_local" && voiceId === "am_liam" && fallback == null) {
    return QWEN_PLANNER_FIX_RECOVERY_KIND;
  }
  throw new Error(
    `run relock-tts supports only Kokoro/Puck migration or canonical Qwen/Liam planner-fix recovery; found ${provider ?? "missing"}/${voiceId ?? "missing"} with fallback ${fallback ?? "none"}.`,
  );
}

function recoveryArchiveLabel(recoveryKind) {
  return recoveryKind === PUCK_TO_QWEN_RECOVERY_KIND
    ? "puck-to-qwen-liam"
    : "qwen-liam-planner-fix-relock";
}

function recoveryDisposition(recoveryKind) {
  return recoveryKind === PUCK_TO_QWEN_RECOVERY_KIND
    ? "full_official_qwen_liam_voice_plan_and_narration_rebuild"
    : "full_official_qwen_liam_voice_plan_and_narration_rebuild_after_committed_planner_fix";
}

function recoveryTriageFilename(recoveryKind, episode, archiveSlug) {
  return recoveryKind === PUCK_TO_QWEN_RECOVERY_KIND
    ? `manual_blocker_triage_qwen_liam_relock_${episode}.json`
    : `manual_blocker_triage_qwen_liam_planner_fix_relock_${episode}_${archiveSlug}.json`;
}

function recoveryEvidence(
  recoveryKind,
  interruptedQwenTts = {},
  { synthesisContractChanged = false } = {},
) {
  return recoveryKind === PUCK_TO_QWEN_RECOVERY_KIND
    ? [
        "The operator explicitly superseded the Puck primary lock with the audited Qwen3-TTS 1.7B Base Liam-clone profile.",
        ...(synthesisContractChanged
          ? ["The operator-approved target profile also locks deterministic length-matched batch-four synthesis through one resident model."]
          : []),
        "The approved script, speakability overrides, semantic scene plan, and fact ledger are script-hash-bound and do not depend on narrator identity.",
        "The existing narration plan embeds the superseded run identity hash, so voice_plan is the narrowest valid invalidation boundary.",
        "No historical artifact or audio asset is deleted; affected root artifacts are hash-snapshotted in the immutable recovery archive before replacement.",
      ]
    : [
        synthesisContractChanged
          ? "The operator approved the deterministic batch-four production synthesis contract after the throughput bake-off; the audited Qwen3-TTS 1.7B Base Liam-clone voice identity and delivery controls remain unchanged."
          : "The operator approved recovery after a tested TTS planner unit-boundary defect; the audited Qwen3-TTS 1.7B Base Liam-clone identity and canonical delivery profile remain unchanged.",
        synthesisContractChanged
          ? "The batch-four implementation is committed at a new clean Git HEAD, and this explicit relock records the synthesis-contract change before invalidating downstream voice-plan provenance."
          : "The planner correction is committed at a new clean Git HEAD, and the relock updates only the run Git/stage pins plus downstream voice-plan provenance.",
        "The interrupted qwen_tts_stitch execution has no matching completion event, so the pre-fix narration plan and its partial synthesis cannot be selected as production truth.",
        `The recovery report hash-inventories ${Number(interruptedQwenTts.interrupted_partial_unit_wav_count ?? 0)} retained Qwen unit WAVs and the orphaned active job manifest without moving, deleting, or selecting them.`,
        "The approved script, speakability overrides, semantic scene plan, and fact ledger are script-hash-bound and remain preserved upstream of voice_plan.",
        "voice_plan is the narrowest valid invalidation boundary because it authored the defective cross-segment request grouping.",
      ];
}

function qwenLiamProviderLocks(primary, options) {
  const synthesis = options.synthesis_contract;
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
    tts_synthesis_contract_id: synthesis.contract_id,
    tts_synthesis_mode: synthesis.mode,
    tts_synthesis_api: synthesis.api,
    tts_model_instance_count: Number(synthesis.resident_model_count),
    tts_model_concurrency: Number(synthesis.model_concurrency),
    tts_nominal_batch_size: Number(synthesis.nominal_batch_size),
    tts_batch_scheduler_version: synthesis.scheduler_version,
    tts_token_limit_acceptance_allowed:
      synthesis.token_limit_acceptance_allowed,
    tts_objective_recovery_mode: synthesis.objective_recovery_mode,
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
  recoveryKind = recoveryKindForIdentityForTests(identity),
} = {}) {
  const options = requireCanonicalQwenLiamOptions(voiceProviderOptions);
  const primary = options.primary;
  const previousSynthesisContract =
    narrationPolicy.narrationTtsPolicyForIdentity(identity).synthesis_contract
    ?? null;
  const synthesisContractChanged =
    JSON.stringify(previousSynthesisContract)
    !== JSON.stringify(options.synthesis_contract);
  const voiceIdentityChanged = recoveryKind === PUCK_TO_QWEN_RECOVERY_KIND;
  const identityChanged = voiceIdentityChanged || synthesisContractChanged;
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
      qwen_tts_batch_size: Number(
        options.synthesis_contract.nominal_batch_size,
      ),
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
    deterministic_length_matched_tts_batching_required: true,
    tts_nominal_batch_size: Number(
      options.synthesis_contract.nominal_batch_size,
    ),
    tts_single_resident_model_required: true,
    tts_token_limit_outputs_forbidden: true,
    tts_objective_recovery_exact_unit_only: true,
  };
  migrated.git = structuredClone(git);
  migrated.dirty_worktree_waiver = null;
  migrated.updated_at = timestamp;
  const previousRelock = migrated.narration_identity_relock
    ? structuredClone(migrated.narration_identity_relock)
    : null;
  const previousHistory = Array.isArray(migrated.narration_identity_relock_history)
    ? structuredClone(migrated.narration_identity_relock_history)
    : [];
  migrated.narration_identity_relock_history = [
    ...previousHistory,
    ...(previousRelock ? [previousRelock] : []),
  ];
  migrated.narration_identity_relock = {
    schema: "goldflow_narration_identity_relock_v1",
    profile: QWEN_LIAM_PROFILE_ID,
    recovery_kind: recoveryKind,
    identity_changed: identityChanged,
    voice_identity_changed: voiceIdentityChanged,
    synthesis_contract_changed: synthesisContractChanged,
    operator_approved_batch4_promotion:
      synthesisContractChanged,
    recovery_scope: recoveryKind === PUCK_TO_QWEN_RECOVERY_KIND
      ? "operator_approved_narrator_identity_migration"
      : synthesisContractChanged
        ? "same_voice_batch4_synthesis_contract_promotion"
        : "same_identity_relock_after_committed_tts_planner_fix",
    invalidation_reason: recoveryKind === PUCK_TO_QWEN_RECOVERY_KIND
      ? "operator_selected_qwen_liam_as_the_production_narrator"
      : synthesisContractChanged
        ? "operator_approved_batch4_synthesis_promotion_and_committed_tts_planner_fix_invalidate_the_prior_voice_plan"
        : "committed_tts_planner_unit_boundary_fix_invalidates_the_prior_voice_plan",
    relocked_at: timestamp,
    reason,
    previous_run_identity_sha256: previousIdentitySha256,
    previous_git_commit: identity.git?.commit ?? null,
    relock_git_commit: git?.commit ?? null,
    archive_dir: archiveDir,
    invalidation_boundary: "voice_plan",
    preserved_upstream_boundary: "semantic_scene_plan",
    primary_provider: primary.provider,
    narrator_voice_id: primary.voice_id,
    reference_audio_sha256: primary.reference_audio_sha256,
    unit_contract: structuredClone(options.unit_contract),
    stitch_contract: structuredClone(options.stitch_contract),
    previous_synthesis_contract:
      structuredClone(previousSynthesisContract),
    synthesis_contract: structuredClone(options.synthesis_contract),
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
    "qwen_text_integrity_coverage_report.json",
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

async function snapshotRecoveryArtifacts(
  episodeDir,
  archiveDir,
  episode,
  recoveryKind,
) {
  const names = await fs.readdir(episodeDir).catch(() => []);
  const selected = archiveCandidateNames(episode);
  for (const name of names) {
    if (timingDerivedName(name, episode)) selected.add(name);
    if (/^manual_blocker_triage_qwen_liam.*relock.*\.json$/.test(name)) {
      selected.add(name);
    }
  }
  const snapshots = [];
  for (const name of [...selected].sort()) {
    const source = path.join(episodeDir, name);
    if (!(await exists(source))) continue;
    const destination = path.join(archiveDir, "artifacts", name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
    const priorRecoveryRecord =
      /^manual_blocker_triage_qwen_liam.*relock.*\.json$/.test(name);
    const invalidatedByRelock = ![
      "production_manifest.json",
      "run_advance_state.json",
      "run_identity.json",
    ].includes(name) && !priorRecoveryRecord;
    snapshots.push({
      path: source,
      archived_path: destination,
      sha256: await sha256File(source),
      invalidated_by_relock: invalidatedByRelock,
      archive_classification: priorRecoveryRecord
        ? "prior_recovery_record"
        : invalidatedByRelock ? "invalidated_stage_artifact" : "historical_context",
      invalidation_reason: !invalidatedByRelock
        ? null
        : timingDerivedName(name, episode)
          ? "depends_on_invalidated_narration_audio_or_timing"
          : recoveryKind === PUCK_TO_QWEN_RECOVERY_KIND
            ? "depends_on_superseded_puck_identity_or_voice_plan"
            : "depends_on_pre_fix_voice_plan_or_interrupted_qwen_tts_attempt",
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
    const resolved = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(episodeDir, filePath);
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

async function readJsonOptional(filePath) {
  return fs.readFile(filePath, "utf8").then(JSON.parse).catch(() => null);
}

function sourceSegmentIdsForPlanUnit(unit) {
  return [...new Set([
    ...(Array.isArray(unit?.source_segment_ids) ? unit.source_segment_ids : []),
    ...(!unit?.source_segment_ids?.length && unit?.segment_id ? [unit.segment_id] : []),
  ].map(cleanValue).filter(Boolean))];
}

export async function interruptedQwenTtsInventoryForTests(episodeDir) {
  const mediaRoot = path.join(episodeDir, "assets", "audio", "narration_tts");
  const jobsDir = path.join(mediaRoot, "jobs");
  const runsDir = path.join(mediaRoot, "runs");
  const unitsDir = path.join(mediaRoot, "units", "qwen_local");
  const jobNames = (await fs.readdir(jobsDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  const orphanedQwenJobManifests = [];
  for (const name of jobNames) {
    const manifestPath = path.join(jobsDir, name);
    const manifest = await readJsonOptional(manifestPath);
    if (manifest?.schema !== "goldflow_narration_tts_jobs_v1"
      || manifest.provider !== "qwen_local") {
      continue;
    }
    const matchingRunReportPath = path.join(runsDir, name);
    if (await exists(matchingRunReportPath)) continue;
    const stat = await fs.stat(manifestPath);
    orphanedQwenJobManifests.push({
      path: manifestPath,
      sha256: await sha256File(manifestPath),
      size_bytes: stat.size,
      job_count: Array.isArray(manifest.jobs) ? manifest.jobs.length : 0,
      provider: manifest.provider,
      attempt: manifest.attempt ?? null,
      matching_run_report_path: matchingRunReportPath,
      matching_run_report_exists: false,
      retained_in_place: true,
      selected_for_new_production: false,
      manifest,
    });
  }
  orphanedQwenJobManifests.sort((left, right) => (
    path.basename(right.path).localeCompare(path.basename(left.path))
  ));
  const activeManifestInternal = orphanedQwenJobManifests[0] ?? null;
  const activeJobs = new Map(
    (activeManifestInternal?.manifest?.jobs ?? []).map((row) => [
      cleanValue(row?.unit_id),
      row,
    ]).filter(([unitId]) => unitId),
  );
  const currentPlan = await readJsonOptional(
    path.join(episodeDir, "narration_generation_plan.json"),
  );
  const currentPlanUnits = new Map(
    (Array.isArray(currentPlan?.units) ? currentPlan.units : []).map((row) => [
      cleanValue(row?.unit_id),
      row,
    ]).filter(([unitId]) => unitId),
  );
  const wavNames = (await fs.readdir(unitsDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".wav"))
    .map((entry) => entry.name)
    .sort();
  const partialUnitWavs = [];
  for (const name of wavNames) {
    const wavPath = path.join(unitsDir, name);
    const sidecarPath = path.join(unitsDir, `${path.basename(name, path.extname(name))}.json`);
    const sidecar = await readJsonOptional(sidecarPath);
    const wavStat = await fs.stat(wavPath);
    const wavSha256 = await sha256File(wavPath);
    const sidecarExists = Boolean(sidecar);
    const sidecarSha256 = sidecarExists ? await sha256File(sidecarPath) : null;
    const unitId = cleanValue(sidecar?.unit_id);
    const spokenTextSha256 = cleanValue(sidecar?.spoken_text_sha256);
    const activeJob = unitId ? activeJobs.get(unitId) : null;
    const activeManifestExactMatch = Boolean(
      activeJob
      && cleanValue(activeJob.spoken_text_sha256) === spokenTextSha256,
    );
    const currentPlanUnit = unitId ? currentPlanUnits.get(unitId) : null;
    const currentPlanExactMatch = Boolean(
      currentPlanUnit
      && cleanValue(currentPlanUnit.spoken_text_sha256) === spokenTextSha256,
    );
    const sourceSegmentIds = currentPlanExactMatch
      ? sourceSegmentIdsForPlanUnit(currentPlanUnit)
      : [];
    partialUnitWavs.push({
      path: wavPath,
      sha256: wavSha256,
      size_bytes: wavStat.size,
      unit_id: unitId,
      spoken_text_sha256: spokenTextSha256,
      synthesis_identity_sha256: cleanValue(sidecar?.synthesis_identity_sha256),
      sidecar_path: sidecarExists ? sidecarPath : null,
      sidecar_sha256: sidecarSha256,
      sidecar_output_sha256_matches: sidecarExists
        ? cleanValue(sidecar.output_sha256) === wavSha256
        : null,
      exact_match_in_active_job_manifest: activeManifestExactMatch,
      exact_match_in_interrupted_plan: currentPlanExactMatch,
      interrupted_plan_source_segment_ids: sourceSegmentIds,
      interrupted_plan_source_segment_count: currentPlanExactMatch
        ? sourceSegmentIds.length
        : null,
      cross_segment_under_interrupted_plan: currentPlanExactMatch
        ? sourceSegmentIds.length > 1
        : null,
      retained_in_place: true,
      selected_for_new_production: false,
      future_reuse_status: "not_selected_pending_corrected_plan_exact_match",
      future_reuse_policy: INTERRUPTED_QWEN_REUSE_POLICY,
    });
  }
  const activeJobPartialWavs = partialUnitWavs.filter(
    (row) => row.exact_match_in_active_job_manifest,
  );
  const activeJobCrossSegmentWavs = activeJobPartialWavs.filter(
    (row) => row.cross_segment_under_interrupted_plan === true,
  );
  const activeJobSingleSegmentWavs = activeJobPartialWavs.filter(
    (row) => row.interrupted_plan_source_segment_count === 1,
  );
  const publicManifest = activeManifestInternal
    ? Object.fromEntries(
        Object.entries(activeManifestInternal).filter(([key]) => key !== "manifest"),
      )
    : null;
  return {
    schema: "goldflow_interrupted_qwen_tts_inventory_v1",
    status: "retained_unselected_history",
    unit_directory: unitsDir,
    active_job_manifest_selection:
      "latest_qwen_jobs_manifest_without_a_matching_run_report",
    active_job_manifest: publicManifest,
    orphaned_qwen_job_manifest_count: orphanedQwenJobManifests.length,
    orphaned_qwen_job_manifests: orphanedQwenJobManifests.map((row) => (
      Object.fromEntries(Object.entries(row).filter(([key]) => key !== "manifest"))
    )),
    interrupted_partial_unit_wav_count: partialUnitWavs.length,
    active_job_partial_unit_wav_count: activeJobPartialWavs.length,
    active_job_cross_segment_partial_unit_wav_count:
      activeJobCrossSegmentWavs.length,
    active_job_single_segment_partial_unit_wav_count:
      activeJobSingleSegmentWavs.length,
    historical_partial_unit_wav_count_outside_active_job:
      partialUnitWavs.length - activeJobPartialWavs.length,
    selected_for_new_production_count: 0,
    reuse_policy: INTERRUPTED_QWEN_REUSE_POLICY,
    reuse_requires: [
      "the corrected narration plan contains the exact same content-addressed unit",
      "the unit is bound to exactly one source segment",
      "spoken text and spoken-text hash are unchanged",
      "the pinned Qwen/Liam synthesis identity is unchanged",
      "the retained WAV hash matches its synthesis sidecar",
    ],
    partial_unit_wavs: partialUnitWavs,
  };
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
  const recoveryKind = recoveryKindForIdentityForTests(identity);
  const existingNarrationPolicy =
    narrationPolicy.narrationTtsPolicyForIdentity(identity);
  const promotesExistingSerialQwen =
    recoveryKind === QWEN_PLANNER_FIX_RECOVERY_KIND
    && existingNarrationPolicy.synthesis_contract?.mode
      === narrationPolicy.QWEN_LIAM_SERIAL_SYNTHESIS_CONTRACT.mode;
  if (promotesExistingSerialQwen && !isTrue(flags["promote-batch4"])) {
    throw new Error(
      "This existing Qwen/Liam identity is pinned to serial synthesis. "
      + "Pass --promote-batch4 true only after explicit operator approval "
      + "to migrate it to deterministic length-matched batch-four synthesis.",
    );
  }
  if (recoveryKind === QWEN_PLANNER_FIX_RECOVERY_KIND) {
    if (identity.tts_profile !== QWEN_LIAM_PROFILE_ID) {
      throw new Error(
        `Qwen/Liam planner-fix relock requires the existing canonical profile ${QWEN_LIAM_PROFILE_ID}; found ${identity.tts_profile ?? "missing"}.`,
      );
    }
    narrationPolicy.validateNarrationTtsPolicy(
      narrationPolicy.narrationTtsPolicyForIdentity(identity),
      { production: true },
    );
  }

  const git = cleanGitSnapshot();
  if (recoveryKind === QWEN_PLANNER_FIX_RECOVERY_KIND) {
    const previousCommit = cleanValue(identity.git?.commit);
    if (!previousCommit) {
      throw new Error(
        "Qwen/Liam planner-fix relock requires the prior committed Git pin in run_identity.json.",
      );
    }
    if (previousCommit === git.commit) {
      throw new Error(
        "Qwen/Liam planner-fix relock requires a new clean committed implementation; current HEAD still matches run_identity.git.commit.",
      );
    }
  }
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
    `${archiveSlug}-${recoveryArchiveLabel(recoveryKind)}`,
  );
  await fs.mkdir(path.dirname(archiveDir), { recursive: true });
  await fs.mkdir(archiveDir, { recursive: false });
  const snapshots = await snapshotRecoveryArtifacts(
    episodeDir,
    archiveDir,
    identity.episode,
    recoveryKind,
  );
  const retainedAudioAssets = await retainedNarrationAudioAssets(
    episodeDir,
    identity.episode,
  );
  const interruptedQwenTts = await interruptedQwenTtsInventoryForTests(
    episodeDir,
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
    recoveryKind,
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
  const abandonedQwenTtsStarts = executionEvents
    .filter((row) => (
      row.event_type === "stage_started"
      && row.stage === "qwen_tts_stitch"
    ))
    .filter((row) => !completedExecutionIds.has(row.execution_id))
    .map((row) => row.execution_id)
    .filter(Boolean);

  const evidenceReviewed = recoveryEvidence(
    recoveryKind,
    interruptedQwenTts,
    {
      synthesisContractChanged:
        migrated.narration_identity_relock.synthesis_contract_changed,
    },
  );

  const triage = {
    schema: "goldflow_manual_blocker_triage_v1",
    status: "approved_recovery",
    stage: "voice_plan",
    episode: identity.episode,
    recorded_at: timestamp,
    operator_request: reason,
    workflow_bypass_authorized: true,
    recovery_kind: recoveryKind,
    operator_approved_batch4_promotion:
      migrated.narration_identity_relock.synthesis_contract_changed,
    identity_changed: migrated.narration_identity_relock.identity_changed,
    voice_identity_changed:
      migrated.narration_identity_relock.voice_identity_changed,
    synthesis_contract_changed:
      migrated.narration_identity_relock.synthesis_contract_changed,
    disposition: recoveryDisposition(recoveryKind),
    evidence_reviewed: evidenceReviewed,
    tts_profile: QWEN_LIAM_PROFILE_ID,
    run_identity_before_sha256: beforeHash,
    run_identity_after_sha256: afterHash,
    previous_git_commit: identity.git?.commit ?? null,
    relock_git_commit: git.commit,
    recovery_archive_dir: archiveDir,
    preserved_artifacts: preservedArtifacts,
    invalidated_artifacts: snapshots.filter((row) => row.invalidated_by_relock),
    retained_historical_audio_assets: retainedAudioAssets,
    retained_interrupted_qwen_tts_summary: {
      status: interruptedQwenTts.status,
      active_job_manifest: interruptedQwenTts.active_job_manifest,
      interrupted_partial_unit_wav_count:
        interruptedQwenTts.interrupted_partial_unit_wav_count,
      active_job_partial_unit_wav_count:
        interruptedQwenTts.active_job_partial_unit_wav_count,
      active_job_cross_segment_partial_unit_wav_count:
        interruptedQwenTts.active_job_cross_segment_partial_unit_wav_count,
      active_job_single_segment_partial_unit_wav_count:
        interruptedQwenTts.active_job_single_segment_partial_unit_wav_count,
      selected_for_new_production_count: 0,
      reuse_policy: interruptedQwenTts.reuse_policy,
    },
    abandoned_qwen_tts_stitch_stage_start_execution_ids:
      abandonedQwenTtsStarts,
    abandoned_whisper_stage_start_execution_ids: abandonedWhisperStarts,
    abandoned_stage_start_execution_ids: {
      qwen_tts_stitch: abandonedQwenTtsStarts,
      local_whisper_word_timing: abandonedWhisperStarts,
    },
    invalidation_boundary: "voice_plan",
    preserved_upstream_boundary: "semantic_scene_plan",
    next_required_artifact: "narration_generation_plan.json",
    next_required_command: `node bin/goldflow.mjs voice plan --channel ${identity.channel} --series ${identity.series_slug} --week ${identity.week} --episode ${identity.episode}`,
  };
  const triagePath = path.join(
    episodeDir,
    recoveryTriageFilename(recoveryKind, identity.episode, archiveSlug),
  );
  const recoveryReport = {
    schema: "goldflow_tts_identity_relock_report_v1",
    status: "passed",
    recovery_id: randomUUID(),
    recorded_at: timestamp,
    episode_dir: episodeDir,
    episode: identity.episode,
    recovery_kind: recoveryKind,
    operator_approved_batch4_promotion:
      migrated.narration_identity_relock.synthesis_contract_changed,
    identity_changed: migrated.narration_identity_relock.identity_changed,
    voice_identity_changed:
      migrated.narration_identity_relock.voice_identity_changed,
    synthesis_contract_changed:
      migrated.narration_identity_relock.synthesis_contract_changed,
    disposition: recoveryDisposition(recoveryKind),
    tts_profile: QWEN_LIAM_PROFILE_ID,
    run_identity_before_sha256: beforeHash,
    run_identity_after_sha256: afterHash,
    previous_git_commit: identity.git?.commit ?? null,
    relock_git_commit: git.commit,
    git,
    preserved_artifacts: preservedArtifacts,
    archived_artifacts: snapshots,
    retained_historical_audio_assets: retainedAudioAssets,
    retained_interrupted_qwen_tts: interruptedQwenTts,
    abandoned_qwen_tts_stitch_stage_start_execution_ids:
      abandonedQwenTtsStarts,
    abandoned_whisper_stage_start_execution_ids: abandonedWhisperStarts,
    abandoned_stage_start_execution_ids: {
      qwen_tts_stitch: abandonedQwenTtsStarts,
      local_whisper_word_timing: abandonedWhisperStarts,
    },
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
    recovery_kind: recoveryKind,
    operator_approved_batch4_promotion:
      migrated.narration_identity_relock.synthesis_contract_changed,
    identity_changed: migrated.narration_identity_relock.identity_changed,
    voice_identity_changed:
      migrated.narration_identity_relock.voice_identity_changed,
    synthesis_contract_changed:
      migrated.narration_identity_relock.synthesis_contract_changed,
    run_identity_path: identityPath,
    run_identity_before_sha256: beforeHash,
    run_identity_after_sha256: afterHash,
    archive_dir: archiveDir,
    archived_artifact_count: snapshots.length,
    retained_interrupted_qwen_partial_unit_wav_count:
      interruptedQwenTts.interrupted_partial_unit_wav_count,
    abandoned_qwen_tts_stitch_stage_start_execution_ids:
      abandonedQwenTtsStarts,
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
  INTERRUPTED_QWEN_REUSE_POLICY,
  PUCK_TO_QWEN_RECOVERY_KIND,
  QWEN_PLANNER_FIX_RECOVERY_KIND,
  QWEN_LIAM_PROFILE_ID,
  recoveryDisposition,
  recoveryEvidence,
  recoveryTriageFilename,
  requireCanonicalQwenLiamOptions,
};
