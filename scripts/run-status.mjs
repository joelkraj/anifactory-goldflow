#!/usr/bin/env node

import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));

function parseFlags(parts) {
  const parsed = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--") ? parts[index + 1] : "true";
    parsed[key] = value;
    if (value !== "true") index += 1;
  }
  return parsed;
}

async function exists(filePath) {
  if (!filePath) return false;
  return fs.stat(filePath).then((stat) => stat.isFile() || stat.isDirectory()).catch(() => false);
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileSha256(filePath) {
  try {
    return sha256(await fs.readFile(filePath));
  } catch {
    return null;
  }
}

async function listFiles(dirPath) {
  try {
    return await fs.readdir(dirPath);
  } catch {
    return [];
  }
}

async function latestMatching(dirPath, pattern) {
  const names = await listFiles(dirPath);
  const matches = [];
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const filePath = path.join(dirPath, name);
    const stat = await fs.stat(filePath).catch(() => null);
    if (stat?.isFile()) matches.push({ name, filePath, mtimeMs: stat.mtimeMs });
  }
  matches.sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));
  return matches[0] ?? null;
}

function requiredFlag(name, value) {
  if (!value) throw new Error(`Missing required --${name}. Pass --episode-dir, or pass --channel --week --episode.`);
}

function normalizeAudioTarget(value) {
  const normalized = String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!normalized || ["narrator", "narration", "narrator_only", "narration_only", "voice_only"].includes(normalized)) return "narrator_only";
  return normalized;
}

function isNarratorOnlyAudio(identity) {
  return normalizeAudioTarget(identity.audio_target) === "narrator_only";
}

function commandFor(stage, identity) {
  const channel = identity.channel ?? "<channel>";
  const series = identity.series_slug ?? "<series>";
  const week = identity.week ?? "<week>";
  const episode = identity.episode ?? "<episode>";
  const base = `--channel ${channel} --series ${series} --week ${week} --episode ${episode}`;
  const narratorOnly = isNarratorOnlyAudio(identity);
  const commands = {
    run_identity: `node bin/goldflow.mjs run preflight ${base} --title "<episode-title>" --source <source.md>`,
    source_ingest: `node bin/goldflow.mjs ingest source ${base} --source <source.md>`,
    script_approval: `node bin/goldflow.mjs script approve ${base} --hash <script_clean_hash>`,
    targeted_speakability: `node bin/goldflow.mjs script targeted ${base}`,
    semantic_scene_plan: `node bin/goldflow.mjs semantic plan ${base}`,
    voice_plan: `node bin/goldflow.mjs voice plan ${base}`,
    qwen_tts_stitch: `node bin/goldflow.mjs tts qwen ${base}`,
    local_whisper_word_timing: `node bin/goldflow.mjs audio whisper-timing ${base}`,
    timing_bind: `node bin/goldflow.mjs timing bind ${base}`,
    sfx_score_plan: narratorOnly ? "skipped because run_identity.audio_target is narrator_only" : `ANIFACTORY_SCORE_PROVIDER=local_ace_step node bin/goldflow.mjs audio enrich-sfx-score ${base} --score-mode drops_only --retention-mix true`,
    longform_audio_mix: narratorOnly
      ? `node bin/goldflow.mjs audio longform-bed ${base} --narration-only true --narration-volume-db 3 --target-lufs -13 --true-peak-db -1`
      : `ANIFACTORY_SCORE_PROVIDER=local_ace_step node bin/goldflow.mjs audio longform-bed ${base} --narration-volume-db 3 --score-drop-boost-db 3 --signature-sfx-boost-db 2 --incidental-sfx-boost-db 2 --ambience-sfx-boost-db -2 --target-lufs -13 --true-peak-db -1`,
    visual_beat_plan: `node bin/goldflow.mjs visual beats ${base} --hook-duration-sec 30 --hook-target-beat-sec 3.2 --hook-max-beat-sec 4.2 --retention-ramp-sec 180 --ramp-target-beat-sec 5.2 --ramp-max-beat-sec 6.5`,
    visual_reference_plan: `node bin/goldflow.mjs visual refs ${base}`,
    reference_generation: `node bin/goldflow.mjs imagegen start ${base} --references-only true`,
    visual_prompt_plan_review_harden: `node bin/goldflow.mjs visual plan ${base} && node bin/goldflow.mjs visual review ${base} && node bin/goldflow.mjs visual harden ${base}`,
    transition_edit_plan: `node bin/goldflow.mjs visual transitions ${base} --prompts <episode-dir>/section_image_prompts_hardened.json${narratorOnly ? " --transition-sfx false" : ""}`,
    image_generation: `node bin/goldflow.mjs imagegen start ${base}`,
    premium_render: `node bin/goldflow.mjs render start ${base} --prompts <episode-dir>/section_image_prompts_hardened.json --audio-bed-report <episode-dir>/<final-longform-audio-report>.json --transition-plan <episode-dir>/transition_edit_plan_${episode}.json --hook-xfade true --hook-xfade-duration-sec 0.28 --retention-xfade-sec 180 --motion fill_ken_burns --motion-strength 1.75 --render-scale-multiplier 1.45 --render-concurrency 4 --clip-preset veryfast --final-preset veryfast`,
    final_qa: `ffprobe <final-render.mp4> && ffmpeg -i <final-audio-or-render> -af volumedetect -f null -`,
    upload_packaging: "Generate title, thumbnail, and description hooks after story/render review.",
  };
  return commands[stage] ?? null;
}

function stage(stage, requiredInput, output, approvalRequired, done, evidence, identity) {
  return {
    stage,
    required_input: requiredInput,
    output_artifact: output,
    operator_approval_required: approvalRequired,
    exists: Boolean(done),
    evidence: evidence ?? null,
    next_command_shape: done ? null : commandFor(stage, identity),
  };
}

async function imageReportComplete(episodeDir, episode) {
  const names = await listFiles(episodeDir);
  const reports = [];
  for (const name of names.filter((item) => /^imagegen_report.*\.json$/.test(item))) {
    const filePath = path.join(episodeDir, name);
    const stat = await fs.stat(filePath).catch(() => null);
    const report = await readJson(filePath, null);
    if (!stat?.isFile() || !report) continue;
    reports.push({ name, filePath, report, mtimeMs: stat.mtimeMs });
  }
  reports.sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));
  async function duplicateSummary(report) {
    const byHash = new Map();
    for (const row of report.results ?? []) {
      if (!row?.image_id || !row.image_path || !(await exists(row.image_path))) continue;
      const hash = row.generated?.output_sha256 ?? await fileSha256(row.image_path);
      if (!hash) continue;
      const rows = byHash.get(hash) ?? [];
      rows.push(row.image_id);
      byHash.set(hash, rows);
    }
    return [...byHash.values()].filter((rows) => rows.length > 1).map((rows) => rows.join("="));
  }
  const passed = reports.find(({ report }) => {
    const status = String(report.status ?? "").toLowerCase();
    const missing = Number(report.missing_image_count ?? report.missing_count ?? 0);
    return status === "passed" && missing === 0;
  });
  if (passed) {
    const duplicates = await duplicateSummary(passed.report);
    if (duplicates.length) {
      return {
        done: false,
        evidence: `${passed.name}; duplicate_hashes=${duplicates.slice(0, 4).join(", ")}${duplicates.length > 4 ? ` +${duplicates.length - 4} more` : ""}`,
      };
    }
    return { done: true, evidence: passed.name };
  }
  const imageDir = path.join(episodeDir, "assets", "images");
  const imageNames = await listFiles(imageDir);
  const generated = imageNames.filter((name) => new RegExp(`^${episode}-cut-.*\\.(png|jpe?g|webp)$`, "i").test(name)).length;
  const promptPlan = await readJson(path.join(episodeDir, "section_image_prompts_hardened.json"), null);
  const promptCount = Array.isArray(promptPlan) ? promptPlan.length : Array.isArray(promptPlan?.prompts) ? promptPlan.prompts.length : 0;
  const failedProbe = reports.find(({ report }) => String(report.status ?? "").toLowerCase() === "failed");
  const latestReport = reports[0]?.report ?? null;
  const duplicates = latestReport ? await duplicateSummary(latestReport) : [];
  return {
    done: promptCount > 0 && generated >= promptCount && duplicates.length === 0,
    evidence: `image files=${generated}/${promptCount || "unknown"}${duplicates.length ? `; duplicate_hashes=${duplicates.slice(0, 4).join(", ")}${duplicates.length > 4 ? ` +${duplicates.length - 4} more` : ""}` : ""}${failedProbe ? `; failed probe/report also present: ${failedProbe.name}` : ""}`,
  };
}

async function referenceGenerationComplete(episodeDir) {
  const planPath = path.join(episodeDir, "visual_reference_plan.json");
  const plan = await readJson(planPath, null);
  if (!plan) return { done: false, evidence: "visual_reference_plan.json missing" };
  const targets = Array.isArray(plan.reference_targets) ? plan.reference_targets : [];
  const required = targets.filter((target) => {
    const mode = String(target.generation_mode ?? "");
    return Boolean(target.required_before_imagegen)
      || mode === "standalone_ref"
      || mode === "manual"
      || mode === "manual_review";
  });
  const missing = [];
  const byHash = new Map();
  let present = 0;
  for (const target of required) {
    if (target.reference_image_path && await exists(target.reference_image_path)) {
      present += 1;
      const hash = await fileSha256(target.reference_image_path);
      if (hash) {
        const rows = byHash.get(hash) ?? [];
        rows.push(target.ref_id ?? target.id ?? "unknown_ref");
        byHash.set(hash, rows);
      }
    } else {
      missing.push(target.ref_id ?? target.id ?? "unknown_ref");
    }
  }
  const duplicates = [...byHash.values()].filter((rows) => rows.length > 1);
  const duplicateSummary = duplicates.map((rows) => rows.join("="));
  return {
    done: required.length > 0 && missing.length === 0 && duplicates.length === 0,
    evidence: `required refs=${present}/${required.length}${missing.length ? `; missing=${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ` +${missing.length - 8} more` : ""}` : ""}${duplicates.length ? `; duplicate_hashes=${duplicateSummary.slice(0, 4).join(", ")}${duplicates.length > 4 ? ` +${duplicates.length - 4} more` : ""}` : ""}`,
  };
}

async function longformMixComplete(episodeDir, episode) {
  const latest = await latestMatching(episodeDir, new RegExp(`^longform_audio_bed_report_${episode}.*\\.json$`));
  if (!latest) return { done: false, evidence: null };
  const report = await readJson(latest.filePath, {});
  const finalAudio = report.final_audio_path
    ?? report.final_m4a_path
    ?? report.output_m4a_path
    ?? report.output_path
    ?? report.mix?.m4a_path
    ?? report.mix?.wav_path;
  return {
    done: Boolean(finalAudio && await exists(finalAudio)),
    evidence: `${latest.name}${finalAudio ? ` -> ${finalAudio}` : ""}`,
  };
}

async function renderComplete(episodeDir, episode) {
  const latest = await latestMatching(episodeDir, new RegExp(`^render_report_${episode}.*\\.json$`));
  if (!latest) return { done: false, evidence: null };
  const report = await readJson(latest.filePath, {});
  const finalVideo = report.final_video_path ?? report.output_path ?? report.render_path;
  return {
    done: Boolean(finalVideo && await exists(finalVideo)),
    evidence: `${latest.name}${finalVideo ? ` -> ${finalVideo}` : ""}`,
  };
}

async function scriptApprovalComplete(episodeDir, currentScriptHash) {
  if (!currentScriptHash) return { done: false, evidence: "script_clean.md missing" };
  const approvalPath = path.join(episodeDir, "operator_script_approval.json");
  const lockPath = path.join(episodeDir, "script_lock.json");
  const approval = await readJson(approvalPath, null);
  const lock = await readJson(lockPath, null);
  const approvalHash = approval?.script_clean_hash ?? approval?.script_hash ?? null;
  const lockHash = lock?.script_clean_hash ?? lock?.script_hash ?? null;
  const done = Boolean(approval?.operator_approved && approvalHash === currentScriptHash && lockHash === currentScriptHash);
  return {
    done,
    evidence: done ? `operator_script_approval.json -> ${currentScriptHash}` : `stale/missing approval for current script hash ${currentScriptHash}`,
  };
}

async function jsonArtifactHashComplete(filePath, currentScriptHash, label) {
  if (!currentScriptHash) return { done: false, evidence: "script_clean.md missing" };
  const artifact = await readJson(filePath, null);
  if (!artifact) return { done: false, evidence: `${label} missing` };
  const artifactHash = artifact.script_clean_hash
    ?? artifact.script_hash
    ?? artifact.source_script_hash
    ?? artifact.source_hash
    ?? null;
  return {
    done: artifactHash === currentScriptHash,
    evidence: artifactHash === currentScriptHash
      ? `${label} -> ${currentScriptHash}`
      : `${label} stale/missing hash ${artifactHash ?? "none"} for current script hash ${currentScriptHash}`,
  };
}

async function main() {
  const episodeDir = flags["episode-dir"]
    ? path.resolve(flags["episode-dir"])
    : (() => {
        requiredFlag("channel", flags.channel);
        requiredFlag("week", flags.week);
        requiredFlag("episode", flags.episode);
        return path.join(dataRoot, "channels", flags.channel, "weekly_runs", flags.week, "episodes", flags.episode);
      })();
  const runIdentityPath = path.join(episodeDir, "run_identity.json");
  const runIdentity = await readJson(runIdentityPath, {});
  const identity = {
    channel: flags.channel ?? runIdentity.channel,
    series_slug: flags.series ?? flags.seriesSlug ?? runIdentity.series_slug,
    week: flags.week ?? runIdentity.week,
    episode: flags.episode ?? runIdentity.episode ?? path.basename(episodeDir),
    audio_target: flags["audio-target"] ?? runIdentity.audio_target ?? "narrator_only",
  };
  const episode = identity.episode;
  const scriptHash = await fileSha256(path.join(episodeDir, "script_clean.md"));
  const scriptApproval = await scriptApprovalComplete(episodeDir, scriptHash);
  const speakability = await jsonArtifactHashComplete(path.join(episodeDir, "script_speakability_report.json"), scriptHash, "script_speakability_report.json");
  const ttsOverrides = await jsonArtifactHashComplete(path.join(episodeDir, "tts_spoken_overrides.json"), scriptHash, "tts_spoken_overrides.json");
  const qwenVoicePlan = await jsonArtifactHashComplete(path.join(episodeDir, "qwen_generation_plan.json"), scriptHash, "qwen_generation_plan.json");
  const longformMix = await longformMixComplete(episodeDir, episode);
  const referenceGeneration = await referenceGenerationComplete(episodeDir);
  const imagegen = await imageReportComplete(episodeDir, episode);
  const render = await renderComplete(episodeDir, episode);
  const latestQa = await latestMatching(episodeDir, /^final_qa_.*\.json$|^upload_qa_.*\.json$|^qa_report_.*\.json$/);
  const latestPackaging = await latestMatching(episodeDir, /^upload_packaging.*\.md$|^title_thumbnail.*\.json$|^thumbnail.*\.png$/);
  const narratorOnly = isNarratorOnlyAudio(identity);
  const sfxScoreDone = narratorOnly
    ? { done: true, evidence: "skipped: audio_target narrator_only" }
    : {
        done: await exists(path.join(episodeDir, `sfx_event_plan_${episode}.json`)) && await exists(path.join(episodeDir, `score_drop_plan_${episode}.json`)),
        evidence: `sfx_event_plan_${episode}.json`,
      };

  const rows = [
    stage("run_identity", "operator/run intent", "run_identity.json", false, await exists(runIdentityPath), "run_identity.json", identity),
    stage("source_ingest", "run_identity.json + source story", "script_clean.md + source_story_ingest_report.json", false, await exists(path.join(episodeDir, "script_clean.md")) && await exists(path.join(episodeDir, "source_story_ingest_report.json")), "script_clean.md", identity),
    stage("script_approval", "script_clean.md", "operator_script_approval.json + script_lock.json", true, scriptApproval.done, scriptApproval.evidence, identity),
    stage("targeted_speakability", "approved script hash", "script_speakability_report.json + tts_spoken_overrides.json", false, speakability.done && ttsOverrides.done, `${speakability.evidence}; ${ttsOverrides.evidence}`, identity),
    stage("semantic_scene_plan", "approved script + bibles", "semantic_scene_plan.json", false, await exists(path.join(episodeDir, "semantic_scene_plan.json")), "semantic_scene_plan.json", identity),
    stage("voice_plan", "speakability report + overrides", "qwen_generation_plan.json", false, qwenVoicePlan.done || await exists(path.join(episodeDir, `voice_casting_lock_${episode}.json`)) || await exists(path.join(episodeDir, `modelslab_qwen_voice_lock_${episode}.json`)), qwenVoicePlan.evidence, identity),
    stage("qwen_tts_stitch", "voice plan + approved TTS text", `modelslab_qwen_tts_report_${episode}.json + stitched narration`, false, await exists(path.join(episodeDir, `modelslab_qwen_tts_report_${episode}.json`)) && await exists(path.join(episodeDir, `audio_stitch_report_${episode}-modelslab-qwen.json`)), `modelslab_qwen_tts_report_${episode}.json`, identity),
    stage("local_whisper_word_timing", "final stitched narration", `narration_word_timing_${episode}.json`, false, await exists(path.join(episodeDir, `narration_word_timing_${episode}.json`)), `narration_word_timing_${episode}.json`, identity),
    stage("timing_bind", "local Whisper word timing", "timed_scene_plan.json", false, await exists(path.join(episodeDir, "timed_scene_plan.json")), "timed_scene_plan.json", identity),
    stage("sfx_score_plan", narratorOnly ? "skipped for narrator_only audio target" : "local Whisper timing + timed scenes", narratorOnly ? "skipped" : `sfx_event_plan_${episode}.json + score_drop_plan_${episode}.json`, false, sfxScoreDone.done, sfxScoreDone.evidence, identity),
    stage("longform_audio_mix", narratorOnly ? "stitched narration/Qwen report" : "locked SFX/score assets + narration", "longform_audio_bed_report_*.json + final mix", false, longformMix.done, longformMix.evidence, identity),
    stage("visual_beat_plan", "timed scenes + Whisper timing", "visual_beat_plan.json", false, await exists(path.join(episodeDir, "visual_beat_plan.json")), "visual_beat_plan.json", identity),
    stage("visual_reference_plan", "visual beats + semantic facts", "visual_reference_plan.json + character_state_refs.json", true, await exists(path.join(episodeDir, "visual_reference_plan.json")) && await exists(path.join(episodeDir, "character_state_refs.json")), "visual_reference_plan.json", identity),
    stage("reference_generation", "approved reference prompts", "assets/images/references/*", true, referenceGeneration.done, referenceGeneration.evidence, identity),
    stage("visual_prompt_plan_review_harden", "visual beats + approved refs", "section_image_prompts_hardened.json", false, await exists(path.join(episodeDir, "section_image_prompts_hardened.json")), "section_image_prompts_hardened.json", identity),
    stage("transition_edit_plan", "hardened prompt plan", `transition_edit_plan_${episode}.json`, false, await exists(path.join(episodeDir, `transition_edit_plan_${episode}.json`)), `transition_edit_plan_${episode}.json`, identity),
    stage("image_generation", "hardened prompt plan + generated refs", `imagegen_report_${episode}.json + assets/images`, false, imagegen.done, imagegen.evidence, identity),
    stage("premium_render", "hardened prompts + final longform mix", `render_report_${episode}*.json + final MP4`, false, render.done, render.evidence, identity),
    stage("final_qa", "final MP4", "ffprobe/loudness/spot-check QA report", true, Boolean(latestQa), latestQa?.name ?? null, identity),
    stage("upload_packaging", "story/render understanding", "title + thumbnail + description package", true, Boolean(latestPackaging), latestPackaging?.name ?? null, identity),
  ];

  const next = rows.find((row) => !row.exists) ?? null;
  const result = {
    schema: "goldflow_run_status_v1",
    episode_dir: episodeDir,
    identity,
    run_identity_path: await exists(runIdentityPath) ? runIdentityPath : null,
    current_stage: next?.stage ?? "complete",
    next_required_input: next?.required_input ?? null,
    next_output_artifact: next?.output_artifact ?? null,
    operator_approval_required: next?.operator_approval_required ?? false,
    next_command_shape: next?.next_command_shape ?? null,
    stage_ledger: rows,
  };

  if (flags.format === "markdown" || flags.md === "true") {
    console.log(`# Goldflow Run Status\n`);
    console.log(`Episode dir: ${episodeDir}`);
    console.log(`Current stage: ${result.current_stage}`);
    if (result.next_command_shape) console.log(`Next command shape: \`${result.next_command_shape}\``);
    console.log("\n| Stage | Exists | Approval | Output |");
    console.log("| --- | --- | --- | --- |");
    for (const row of rows) {
      console.log(`| ${row.stage} | ${row.exists ? "yes" : "no"} | ${row.operator_approval_required ? "yes" : "no"} | ${row.output_artifact} |`);
    }
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
