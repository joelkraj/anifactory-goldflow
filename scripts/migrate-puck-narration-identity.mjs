#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DEFAULT_NARRATOR_VOICE_ID,
  DEFAULT_TTS_FALLBACK_PROVIDER,
  DEFAULT_TTS_NATIVE_SPEED,
  DEFAULT_TTS_PROVIDER,
  KOKORO_MODEL_LOCK,
  QWEN_LOCAL_FALLBACK_LOCK,
  defaultNarrationVoiceProviderOptions,
  narrationTtsPolicyForIdentity,
  validateNarrationTtsPolicy,
} from "./lib/narration-tts-policy.mjs";

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
  const contents = await fs.readFile(filePath);
  return sha256(contents);
}

async function exists(filePath) {
  return fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

const flags = parseFlags(process.argv.slice(2));
const episodeDir = path.resolve(String(flags["episode-dir"] ?? ""));
const reason = String(flags.reason ?? "").trim();
if (!episodeDir || episodeDir === path.parse(episodeDir).root) {
  throw new Error("--episode-dir must resolve to one exact episode directory.");
}
if (!reason) throw new Error("--reason is required for the recovery record.");

const identityPath = path.join(episodeDir, "run_identity.json");
const identityRaw = await fs.readFile(identityPath);
const identity = JSON.parse(identityRaw);
const beforeHash = sha256(identityRaw);
const timestamp = new Date().toISOString();
const archiveSlug = timestamp.replace(/[:.]/g, "-");
const archiveDir = path.join(episodeDir, "reports", "recovery", `${archiveSlug}-legacy-qwen-to-puck`);
await fs.mkdir(archiveDir, { recursive: true });
await fs.writeFile(path.join(archiveDir, "run_identity.before.json"), identityRaw);

const snapshotNames = [
  "narration_generation_plan.json",
  "qwen_generation_plan.json",
  "audio_performance_plan.json",
  "narration_text_integrity_coverage_report.json",
  "qwen_text_integrity_coverage_report.json",
  "system_ui_speech_coverage_report.json",
  `narration_word_timing_${identity.episode}.json`,
  `narration_pace_report_${identity.episode}.json`,
  "timed_scene_plan.json",
  "visual_beat_plan.json",
  "visual_beat_approval.json",
  "section_image_prompts.json",
  "section_image_prompts_hardened.json",
  `transition_edit_plan_${identity.episode}.json`,
  `image_output_qa_${identity.episode}.json`,
  `motion_edit_plan_${identity.episode}.json`,
  `render_report_${identity.episode}.json`,
  `final_qa_${identity.episode}.json`,
];
const snapshots = [];
for (const name of snapshotNames) {
  const source = path.join(episodeDir, name);
  if (!(await exists(source))) continue;
  const destination = path.join(archiveDir, name);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  snapshots.push({ path: source, sha256: await sha256File(source) });
}

const voiceProviderOptions = defaultNarrationVoiceProviderOptions();
const migrated = structuredClone(identity);
migrated.tts_provider = DEFAULT_TTS_PROVIDER;
migrated.tts_fallback_provider = DEFAULT_TTS_FALLBACK_PROVIDER;
migrated.narrator_voice_id = DEFAULT_NARRATOR_VOICE_ID;
migrated.tts_voice_id = DEFAULT_NARRATOR_VOICE_ID;
migrated.tts_native_speed = DEFAULT_TTS_NATIVE_SPEED;
migrated.voice_provider_options = voiceProviderOptions;
delete migrated.qwen_narrator_voice_id;
delete migrated.qwen_narrator_voice_policy;
delete migrated.qwen_native_speed;
migrated.provider_locks = {
  ...(migrated.provider_locks ?? {}),
  tts_provider: DEFAULT_TTS_PROVIDER,
  tts_fallback_provider: DEFAULT_TTS_FALLBACK_PROVIDER,
  narrator_voice_id: DEFAULT_NARRATOR_VOICE_ID,
  tts_native_speed: DEFAULT_TTS_NATIVE_SPEED,
  tts_model: KOKORO_MODEL_LOCK.model_id,
  tts_model_revision: KOKORO_MODEL_LOCK.model_revision,
  fallback_tts_model: QWEN_LOCAL_FALLBACK_LOCK.model_id,
  fallback_tts_model_revision: QWEN_LOCAL_FALLBACK_LOCK.model_revision,
  narrator_voice_identity: DEFAULT_NARRATOR_VOICE_ID,
  fallback_voice_identity: QWEN_LOCAL_FALLBACK_LOCK.reference_voice_id,
  fallback_reference_audio_sha256: QWEN_LOCAL_FALLBACK_LOCK.reference_audio_sha256,
  fallback_reference_metadata_sha256: QWEN_LOCAL_FALLBACK_LOCK.reference_metadata_sha256,
  fallback_similarity_model_sha256: QWEN_LOCAL_FALLBACK_LOCK.speaker_similarity_model_sha256,
  fallback_similarity_calibration_sha256: QWEN_LOCAL_FALLBACK_LOCK.speaker_similarity_calibration_sha256,
  fallback_minimum_cosine_similarity: QWEN_LOCAL_FALLBACK_LOCK.minimum_cosine_similarity,
  fallback_warning_below_cosine_similarity: QWEN_LOCAL_FALLBACK_LOCK.warning_below_cosine_similarity,
  qwen_narrator_voice_id: null,
};
migrated.model_versions = {
  ...(migrated.model_versions ?? {}),
  tts_model: KOKORO_MODEL_LOCK.model_id,
  tts_model_revision: KOKORO_MODEL_LOCK.model_revision,
  tts_runtime: `${KOKORO_MODEL_LOCK.runtime}@${KOKORO_MODEL_LOCK.runtime_version}`,
  fallback_tts_model: QWEN_LOCAL_FALLBACK_LOCK.model_id,
  fallback_tts_model_revision: QWEN_LOCAL_FALLBACK_LOCK.model_revision,
  fallback_tts_runtime: `${QWEN_LOCAL_FALLBACK_LOCK.runtime}@${QWEN_LOCAL_FALLBACK_LOCK.runtime_version}`,
};
migrated.production_gates = {
  ...(migrated.production_gates ?? {}),
  provider_native_tts_speed_required: true,
  post_tempo_normalization_default: false,
  single_narrator_identity_required: true,
  fallback_must_clone_primary_voice_identity: true,
};
migrated.updated_at = timestamp;
migrated.narration_identity_migration = {
  schema: "goldflow_narration_identity_migration_v1",
  migrated_at: timestamp,
  reason,
  previous_run_identity_sha256: beforeHash,
  archive_dir: archiveDir,
  primary_provider: DEFAULT_TTS_PROVIDER,
  narrator_voice_id: DEFAULT_NARRATOR_VOICE_ID,
  native_speed: DEFAULT_TTS_NATIVE_SPEED,
  fallback_provider: DEFAULT_TTS_FALLBACK_PROVIDER,
  fallback_scope: "exact_failed_unit_only",
  preserves_visual_assets: true,
};

validateNarrationTtsPolicy(narrationTtsPolicyForIdentity(migrated), {
  production: migrated.run_intent === "production",
});
await writeJson(identityPath, migrated);
const afterHash = await sha256File(identityPath);
const triagePath = path.join(
  episodeDir,
  `manual_blocker_triage_qwen_tts_stitch_${identity.episode}.json`,
);
await writeJson(triagePath, {
  schema: "goldflow_manual_blocker_triage_v1",
  status: "approved_recovery",
  stage: "qwen_tts_stitch",
  episode: identity.episode,
  recorded_at: timestamp,
  operator_request: reason,
  evidence_reviewed: [
    "The legacy narration reports have no safe stable-unit mapping to the Puck topology.",
    "The operator selected Kokoro am_puck as the sole production narrator and local Qwen as exact-failed-unit fallback.",
    "The recovery preserves existing approved images and reruns timing-dependent artifacts only.",
  ],
  disposition: "full_official_voice_plan_and_narration_rebuild",
  workflow_bypass_authorized: true,
  run_identity_before_sha256: beforeHash,
  run_identity_after_sha256: afterHash,
  recovery_archive_dir: archiveDir,
  snapshotted_artifacts: snapshots,
  next_required_artifact: "narration_generation_plan.json",
});

console.log(JSON.stringify({
  status: "passed",
  episode_dir: episodeDir,
  run_identity_path: identityPath,
  run_identity_before_sha256: beforeHash,
  run_identity_after_sha256: afterHash,
  archive_dir: archiveDir,
  triage_path: triagePath,
  snapshotted_artifact_count: snapshots.length,
}, null, 2));
