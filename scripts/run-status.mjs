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

function normalizeImageProvider(value) {
  const normalized = String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (["codex", "codex_imagen", "codex_imagegen", "openai", "openai_imagegen", "gpt_image"].includes(normalized)) return "codex_imagegen";
  if ([
    "hybrid",
    "hybrid_codex_refs_multichar",
    "hybrid_codex_references_multichar",
    "codex_refs_multichar",
    "codex_refs_multichar_modelslab_simple",
    "codex_references_multichar_modelslab_simple",
  ].includes(normalized)) return "hybrid_codex_refs_multichar";
  if ([
    "hybrid_codex_opening_modelslab_rest",
    "hybrid_codex_first20_modelslab_rest",
    "hybrid_codex_first_20_modelslab_rest",
    "codex_first20_modelslab_rest",
    "codex_opening_modelslab_rest",
  ].includes(normalized)) return "hybrid_codex_opening_modelslab_rest";
  if ([
    "hybrid_modelslab_refs_codex_opening_modelslab_rest",
    "modelslab_refs_codex_opening_modelslab_rest",
    "modelslab_references_codex_opening_modelslab_rest",
    "modelslab_refs_codex_first5_modelslab_rest",
    "modelslab_refs_codex_first_5_modelslab_rest",
    "codex_first5_modelslab_rest_modelslab_refs",
  ].includes(normalized)) return "hybrid_modelslab_refs_codex_opening_modelslab_rest";
  return "modelslab";
}

function isNarratorOnlyAudio(identity) {
  return normalizeAudioTarget(identity.audio_target) === "narrator_only";
}

function codexOpeningSec(identity) {
  const value = Number(identity?.image_provider_options?.codex_opening_sec ?? identity?.codex_opening_sec ?? 120);
  return Number.isFinite(value) && value > 0 ? value : 120;
}

function imagegenOpeningFlag(identity) {
  const provider = normalizeImageProvider(identity?.image_provider ?? "modelslab");
  return provider === "hybrid_codex_opening_modelslab_rest" || provider === "hybrid_modelslab_refs_codex_opening_modelslab_rest" ? ` --codex-opening-sec ${codexOpeningSec(identity)}` : "";
}

function usesCodexReferences(identity) {
  const provider = normalizeImageProvider(identity?.image_provider ?? "modelslab");
  return provider === "codex_imagegen"
    || provider === "hybrid_codex_refs_multichar"
    || provider === "hybrid_codex_opening_modelslab_rest";
}

function usesCodexSceneCuts(identity) {
  const provider = normalizeImageProvider(identity?.image_provider ?? "modelslab");
  return provider === "codex_imagegen"
    || provider === "hybrid_codex_refs_multichar"
    || provider === "hybrid_codex_opening_modelslab_rest"
    || provider === "hybrid_modelslab_refs_codex_opening_modelslab_rest";
}

function paceDiagnosticOnly(identity) {
  return String(identity?.pace_policy ?? "").toLowerCase() === "diagnostic";
}

function renderCommand(identity, base, episode) {
  const smooth = String(identity?.render_profile ?? "").toLowerCase() === "smooth_fast_ken_burns";
  const common = `node bin/goldflow.mjs render start ${base} --prompts <episode-dir>/section_image_prompts_hardened.json --audio-bed-report <episode-dir>/<final-longform-audio-report>.json --transition-plan <episode-dir>/transition_edit_plan_${episode}.json --hook-xfade true --hook-xfade-duration-sec 0.28 --retention-xfade-sec 180`;
  if (smooth) {
    return `${common} --motion smooth_fast_ken_burns --motion-strength 1.75 --render-concurrency 4 --clip-preset veryfast --final-preset veryfast`;
  }
  return [
    `${common} --motion fill_ken_burns --motion-strength 1.75 --render-scale-multiplier 1.45 --render-concurrency 4 --clip-preset veryfast --final-preset veryfast`,
    `${common} --motion smooth_fast_ken_burns --motion-strength 1.75 --render-concurrency 4 --clip-preset veryfast --final-preset veryfast --output <episode-dir>/assets/renders/<title>-smooth-fast.mp4 --report-output <episode-dir>/render_report_${episode}-smooth-fast.json`,
  ].join("; optional A/B smoother sibling without overwriting premium: ");
}

function commandBase(identity) {
  const channel = identity.channel ?? "<channel>";
  const series = identity.series_slug ?? "<series>";
  const week = identity.week ?? "<week>";
  const episode = identity.episode ?? "<episode>";
  return `--channel ${channel} --series ${series} --week ${week} --episode ${episode}`;
}

function visualRefsApproveCommand(identity) {
  return `node bin/goldflow.mjs visual approve-refs ${commandBase(identity)} --note "<reference review notes>"`;
}

function commandFor(stage, identity) {
  const episode = identity.episode ?? "<episode>";
  const base = commandBase(identity);
  const narratorOnly = isNarratorOnlyAudio(identity);
  const paceFlag = paceDiagnosticOnly(identity) ? " --pace-policy diagnostic" : "";
  const provider = normalizeImageProvider(identity?.image_provider ?? "modelslab");
  const commands = {
    run_identity: `node bin/goldflow.mjs run preflight ${base} --title "<episode-title>" --source <source.md> --audio-target narrator_only`,
    source_ingest: `node bin/goldflow.mjs ingest source ${base} --source <source.md>`,
    script_approval: `node bin/goldflow.mjs script approve ${base} --hash <script_clean_hash>`,
    script_pace_check: `node bin/goldflow.mjs script pace-check ${base} --target-wpm-min 210 --target-wpm-max 220${paceFlag}${paceDiagnosticOnly(identity) ? " --allow-hook-warnings true" : ""}`,
    targeted_speakability: `node bin/goldflow.mjs script targeted ${base}`,
    semantic_scene_plan: `node bin/goldflow.mjs semantic plan ${base}`,
    voice_plan: `node bin/goldflow.mjs voice plan ${base}`,
    qwen_tts_stitch: `node bin/goldflow.mjs tts qwen ${base}`,
    local_whisper_word_timing: `node bin/goldflow.mjs audio whisper-timing ${base}`,
    audio_pace_check: `node bin/goldflow.mjs audio pace-check ${base} --target-wpm-min 210 --target-wpm-max 220${paceFlag}`,
    audio_tempo_normalize: `node bin/goldflow.mjs audio tempo-normalize ${base} --target-wpm 215`,
    timing_bind: `node bin/goldflow.mjs timing bind ${base}`,
    sfx_score_plan: narratorOnly ? "skipped because run_identity.audio_target is narrator_only" : `ANIFACTORY_SCORE_PROVIDER=local_ace_step node bin/goldflow.mjs audio enrich-sfx-score ${base} --score-mode drops_only --retention-mix true`,
    longform_audio_mix: narratorOnly
      ? `node bin/goldflow.mjs audio longform-bed ${base} --narration-only true --narration-volume-db 3 --target-lufs -13 --true-peak-db -1`
      : `ANIFACTORY_SCORE_PROVIDER=local_ace_step node bin/goldflow.mjs audio longform-bed ${base} --narration-volume-db 3 --score-drop-boost-db 3 --signature-sfx-boost-db 2 --incidental-sfx-boost-db 2 --ambience-sfx-boost-db -2 --target-lufs -13 --true-peak-db -1`,
    visual_beat_plan: `node bin/goldflow.mjs visual beats ${base} --hook-duration-sec 30 --hook-target-beat-sec 3.2 --hook-max-beat-sec 4.2 --retention-ramp-sec 180 --ramp-target-beat-sec 5.2 --ramp-max-beat-sec 6.5`,
    visual_reference_plan: `node bin/goldflow.mjs visual refs ${base}`,
    reference_generation: usesCodexReferences(identity)
      ? `Stage reference PNGs with built-in Codex imagegen workers, then: node bin/goldflow.mjs imagegen import-staged-codex ${base} --references-only true --staging-dir <staging-dir> --reference-ids <ref_ids>`
      : `node bin/goldflow.mjs imagegen start ${base} --image-provider ${provider} --references-only true`,
    visual_prompt_plan_review_harden: `node bin/goldflow.mjs visual plan ${base}`,
    transition_edit_plan: `node bin/goldflow.mjs visual transitions ${base} --prompts <episode-dir>/section_image_prompts_hardened.json${narratorOnly ? " --transition-sfx false" : ""}`,
    image_generation: usesCodexSceneCuts(identity)
      ? `Stage Codex-routed cut PNGs with built-in Codex imagegen workers, import them with: node bin/goldflow.mjs imagegen import-staged-codex ${base} --prompts <episode-dir>/section_image_prompts_hardened.json --staging-dir <staging-dir> --image-ids <codex_cut_ids> --output <episode-dir>/imagegen_report_${episode}.json; then generate the ModelsLab-routed remainder with: node bin/goldflow.mjs imagegen start ${base}${imagegenOpeningFlag(identity)} --image-provider ${provider} --prompts <episode-dir>/section_image_prompts_hardened.json --provider-filter modelslab --output <episode-dir>/imagegen_report_${episode}.json`
      : `node bin/goldflow.mjs imagegen start ${base}`,
    premium_render: renderCommand(identity, base, episode),
    final_qa: `ffprobe <final-render.mp4> && ffmpeg -i <final-audio-or-render> -af volumedetect -f null -`,
    upload_packaging: "Generate title, thumbnail, and description hooks after story/render review.",
  };
  return commands[stage] ?? null;
}

function stage(stage, requiredInput, output, approvalRequired, done, evidence, identity, nextCommandOverride = null) {
  return {
    stage,
    required_input: requiredInput,
    output_artifact: output,
    operator_approval_required: approvalRequired,
    exists: Boolean(done),
    evidence: evidence ?? null,
    next_command_shape: done ? null : nextCommandOverride ?? commandFor(stage, identity),
  };
}

async function visualPromptPlanReviewHardenCommand(episodeDir, identity) {
  const channel = identity.channel ?? "<channel>";
  const series = identity.series_slug ?? "<series>";
  const week = identity.week ?? "<week>";
  const episode = identity.episode ?? "<episode>";
  const base = `--channel ${channel} --series ${series} --week ${week} --episode ${episode}`;
  const planCommand = commandFor("visual_prompt_plan_review_harden", identity);
  const promptPlan = await readJson(path.join(episodeDir, "section_image_prompts.json"), null);
  if (promptPlan?.status !== "passed" || !Array.isArray(promptPlan.prompts) || !promptPlan.prompts.length) return planCommand;
  const reviewedPlan = await readJson(path.join(episodeDir, "section_image_prompts_reviewed.json"), null);
  const hardenedPlan = await readJson(path.join(episodeDir, "section_image_prompts_hardened.json"), null);
  const hardenReport = await readJson(path.join(episodeDir, `visual_prompt_hardening_${episode}.json`), null);
  const reviewedStatus = String(reviewedPlan?.status ?? "").toLowerCase();
  const hardenStatus = String(hardenReport?.status ?? "").toLowerCase();
  const reviewCommand = `node bin/goldflow.mjs visual review ${base} --auto-resolve true --max-resolve-iterations 2`;
  const scopedReviewCommand = `node bin/goldflow.mjs visual review ${base} --resume-blocked true --auto-resolve true --max-resolve-iterations 2`;
  const hardenCommand = `node bin/goldflow.mjs visual harden ${base}`;
  if (hardenedPlan?.status === "passed" && Array.isArray(hardenedPlan.prompts) && hardenedPlan.prompts.length) {
    return hardenCommand;
  }
  if (["blocked", "blocked_deadletter"].includes(reviewedStatus)) {
    return scopedReviewCommand;
  }
  if (reviewedStatus === "passed" && hardenStatus === "blocked") {
    return scopedReviewCommand;
  }
  if (reviewedStatus === "passed") {
    return hardenCommand;
  }
  return reviewCommand;
}

async function imageReportComplete(episodeDir, episode) {
  const promptPlanPath = path.join(episodeDir, "section_image_prompts_hardened.json");
  const promptPlan = await readJson(promptPlanPath, null);
  const promptCount = Array.isArray(promptPlan) ? promptPlan.length : Array.isArray(promptPlan?.prompts) ? promptPlan.prompts.length : 0;
  const promptPlanHash = promptCount > 0 ? await fileSha256(promptPlanPath) : null;
  if (!promptCount || !promptPlanHash) {
    return { done: false, evidence: `image files=0/${promptCount || "unknown"}; section_image_prompts_hardened.json missing or empty` };
  }
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
    const hashOk = report.prompt_plan_hash === promptPlanHash;
    const countOk = Number(report.expected_image_count ?? report.image_count ?? 0) >= promptCount
      && Number(report.image_count ?? 0) >= promptCount;
    return report.reference_only !== true && status === "passed" && missing === 0 && hashOk && countOk;
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
      || mode === "manual";
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
  const status = String(artifact.status ?? "").toLowerCase();
  const statusOk = !status || ["passed", "completed", "approved", "skipped", "draft_needs_manual_review"].includes(status);
  const done = artifactHash === currentScriptHash && statusOk;
  return {
    done,
    evidence: done
      ? `${label} -> ${currentScriptHash}${status ? `; status=${status}` : ""}`
      : `${label} ${status || "missing_status"} for hash ${artifactHash ?? "none"}; required hash ${currentScriptHash}`,
  };
}

async function paceReportComplete(filePath, currentScriptHash, label) {
  if (!currentScriptHash) return { done: false, evidence: "script_clean.md missing" };
  const report = await readJson(filePath, null);
  if (!report) return { done: false, evidence: `${label} missing` };
  const artifactHash = report.source_script_hash ?? report.script_clean_hash ?? report.script_hash ?? null;
  const min = Number(report.target_wpm_min);
  const max = Number(report.target_wpm_max);
  const status = String(report.status ?? "").toLowerCase();
  const hookWarnings = Array.isArray(report.hook_milestone_report?.warnings)
    ? report.hook_milestone_report.warnings
    : [];
  const hookGateEnforced = report.hook_gate_enforced !== false && report.allow_hook_warnings !== true;
  const scriptHookBlocked = label === "script_pace_report.json" && hookWarnings.length > 0 && hookGateEnforced;
  const sourceHashes = report.source_hashes && typeof report.source_hashes === "object" && !Array.isArray(report.source_hashes)
    ? report.source_hashes
    : null;
  const staleSource = sourceHashes
    ? (await Promise.all(Object.entries(sourceHashes).map(async ([sourcePath, expectedHash]) => {
      const actualHash = await fileSha256(sourcePath);
      return actualHash && expectedHash && actualHash !== expectedHash ? `${path.basename(sourcePath)} stale` : null;
    }))).filter(Boolean)[0] ?? null
    : null;
  const done = artifactHash === currentScriptHash && status === "passed" && min === 210 && max === 220 && !scriptHookBlocked && !staleSource;
  const wpm = Number.isFinite(Number(report.actual_wpm)) ? `; actual_wpm=${Number(report.actual_wpm).toFixed(3)}` : "";
  const hook = scriptHookBlocked ? `; hook_warnings=${hookWarnings.length}` : "";
  const sourceHashEvidence = sourceHashes ? (staleSource ? `; ${staleSource}` : "; source_hashes=current") : "; source_hashes=missing";
  return {
    done,
    evidence: done
      ? `${label} -> ${currentScriptHash}; target_wpm=210-220${wpm}${sourceHashEvidence}`
      : `${label} ${status || "missing"} for hash ${artifactHash ?? "none"} target ${Number.isFinite(min) ? min : "?"}-${Number.isFinite(max) ? max : "?"}; required hash ${currentScriptHash} target 210-220${wpm}${hook}${sourceHashEvidence}`,
  };
}

async function audioPaceRecoveryCommand(episodeDir, identity) {
  if (paceDiagnosticOnly(identity)) return null;
  const report = await readJson(path.join(episodeDir, `narration_pace_report_${identity.episode}.json`), null);
  const status = String(report?.status ?? "").toLowerCase();
  const actualWpm = Number(report?.actual_wpm);
  if (status !== "blocked" || !Number.isFinite(actualWpm) || actualWpm <= 0) return null;
  return commandFor("audio_tempo_normalize", identity);
}

async function whisperTimingComplete(episodeDir, episode, currentScriptHash) {
  if (!currentScriptHash) return { done: false, evidence: "script_clean.md missing" };
  const timingPath = path.join(episodeDir, `narration_word_timing_${episode}.json`);
  const stitchPath = path.join(episodeDir, `audio_stitch_report_${episode}-modelslab-qwen.json`);
  const timing = await readJson(timingPath, null);
  if (!timing) return { done: false, evidence: `narration_word_timing_${episode}.json missing` };
  const artifactHash = timing.source_script_hash ?? null;
  if (artifactHash !== currentScriptHash) {
    return { done: false, evidence: `narration_word_timing_${episode}.json hash ${artifactHash ?? "none"}; required hash ${currentScriptHash}` };
  }
  const stitch = await readJson(stitchPath, null);
  const currentAudioPath = stitch?.output_path ?? null;
  const currentAudioHash = currentAudioPath ? await fileSha256(currentAudioPath) : null;
  if (currentAudioHash && timing.narration_audio_hash !== currentAudioHash) {
    return {
      done: false,
      evidence: `narration_word_timing_${episode}.json stale audio hash ${timing.narration_audio_hash ?? "none"}; current audio hash ${currentAudioHash}`,
    };
  }
  return {
    done: String(timing.status ?? "").toLowerCase() === "passed",
    evidence: `narration_word_timing_${episode}.json -> ${currentScriptHash}; audio_hash=${timing.narration_audio_hash ?? "none"}`,
  };
}

async function qwenTtsStitchComplete(episodeDir, episode, currentScriptHash) {
  if (!currentScriptHash) return { done: false, evidence: "script_clean.md missing" };
  const ttsReportPath = path.join(episodeDir, `modelslab_qwen_tts_report_${episode}.json`);
  const stitchReportPath = path.join(episodeDir, `audio_stitch_report_${episode}-modelslab-qwen.json`);
  const ttsReport = await readJson(ttsReportPath, null);
  if (!ttsReport) return { done: false, evidence: `modelslab_qwen_tts_report_${episode}.json missing` };
  const ttsStatus = String(ttsReport.status ?? "").toLowerCase();
  if (!["passed", "completed"].includes(ttsStatus)) {
    return { done: false, evidence: `modelslab_qwen_tts_report_${episode}.json status=${ttsStatus || "missing_status"}` };
  }
  const ttsHash = ttsReport.source_script_hash ?? ttsReport.script_hash ?? null;
  if (ttsHash && ttsHash !== currentScriptHash) {
    return { done: false, evidence: `modelslab_qwen_tts_report_${episode}.json hash ${ttsHash}; required hash ${currentScriptHash}` };
  }
  const stitchReport = await readJson(stitchReportPath, null);
  if (!stitchReport) return { done: false, evidence: `audio_stitch_report_${episode}-modelslab-qwen.json missing` };
  const stitchStatus = String(stitchReport.status ?? "").toLowerCase();
  if (!["passed", "completed"].includes(stitchStatus)) {
    return { done: false, evidence: `audio_stitch_report_${episode}-modelslab-qwen.json status=${stitchStatus || "missing_status"}` };
  }
  const stitchHash = stitchReport.source_script_hash ?? stitchReport.script_hash ?? null;
  if (stitchHash && stitchHash !== currentScriptHash) {
    return { done: false, evidence: `audio_stitch_report_${episode}-modelslab-qwen.json hash ${stitchHash}; required hash ${currentScriptHash}` };
  }
  const outputPath = stitchReport.output_path ?? stitchReport.final_audio_path ?? stitchReport.final_wav_path ?? null;
  if (!outputPath) return { done: false, evidence: `audio_stitch_report_${episode}-modelslab-qwen.json missing output_path` };
  if (!(await exists(outputPath))) return { done: false, evidence: `stitched narration missing: ${outputPath}` };
  const duration = Number(stitchReport.final_duration_sec ?? stitchReport.duration_sec);
  return {
    done: true,
    evidence: `audio_stitch_report_${episode}-modelslab-qwen.json -> ${outputPath}${Number.isFinite(duration) ? `; duration=${duration.toFixed(3)}s` : ""}`,
  };
}

async function qwenVoicePlanComplete(episodeDir, currentScriptHash) {
  const label = "qwen_generation_plan.json";
  const base = await jsonArtifactHashComplete(path.join(episodeDir, label), currentScriptHash, label);
  if (!base.done) return base;
  const plan = await readJson(path.join(episodeDir, label), null);
  const overrides = await readJson(path.join(episodeDir, "tts_spoken_overrides.json"), null);
  const loadedOverrideCount = Array.isArray(overrides?.replacements) ? overrides.replacements.length : 0;
  const audit = plan?.tts_override_application_audit ?? null;
  if (loadedOverrideCount > 0 && !audit) {
    return {
      done: false,
      evidence: `${base.evidence}; missing tts_override_application_audit for ${loadedOverrideCount} loaded override(s)`,
    };
  }
  if (audit) {
    return {
      done: base.done,
      evidence: `${base.evidence}; tts_overrides applied=${audit.applied_rule_count ?? 0}/${audit.loaded_count ?? loadedOverrideCount}; unmatched=${audit.unmatched_rule_count ?? 0}`,
    };
  }
  return base;
}

async function jsonStatusComplete(filePath, label) {
  const artifact = await readJson(filePath, null);
  if (!artifact) return { done: false, evidence: `${label} missing` };
  const status = String(artifact.status ?? "").toLowerCase();
  const done = !["failed", "blocked", "blocked_deadletter", "failed_repairable"].includes(status);
  return { done, evidence: `${label}; status=${status || "missing_status"}` };
}

function statusAllowsDownstreamUse(status) {
  return !["failed", "blocked", "blocked_deadletter", "failed_repairable"].includes(String(status ?? "").toLowerCase());
}

async function sourceHashesCurrent(artifact) {
  const sourceHashes = artifact?.source_hashes && typeof artifact.source_hashes === "object" && !Array.isArray(artifact.source_hashes)
    ? artifact.source_hashes
    : null;
  if (!sourceHashes) return true;
  for (const [sourcePath, recordedHash] of Object.entries(sourceHashes)) {
    const currentHash = await fileSha256(sourcePath);
    if (!currentHash || currentHash !== recordedHash) return false;
  }
  return true;
}

function sortedJson(value) {
  if (Array.isArray(value)) return JSON.stringify([...value].sort());
  return JSON.stringify(value ?? null);
}

function characterStateRefsCompatible(dependentRefs, currentRefs) {
  const currentById = new Map((currentRefs ?? []).map((ref) => [ref.state_ref_id, ref]));
  for (const ref of dependentRefs ?? []) {
    const current = currentById.get(ref.state_ref_id);
    if (!current) return false;
    for (const key of ["character", "prompt_anchor", "scene_prompt_anchor", "source_ref_id", "base_identity_ref_id", "identity_usage"]) {
      if ((ref[key] ?? null) !== (current[key] ?? null)) return false;
    }
    if (sortedJson(ref.scene_ids) !== sortedJson(current.scene_ids)) return false;
  }
  return true;
}

function referencedIdsFromPromptPlan(artifact) {
  const ids = new Set();
  for (const prompt of artifact?.prompts ?? []) {
    for (const req of prompt.reference_requirements ?? []) {
      if (req?.ref_id) ids.add(req.ref_id);
    }
    const manifest = prompt.shot_manifest ?? {};
    if (manifest.location_ref_id) ids.add(manifest.location_ref_id);
    if (manifest.protagonist_state_ref_id) ids.add(manifest.protagonist_state_ref_id);
    for (const refId of manifest.character_state_ref_ids ?? []) {
      if (refId) ids.add(refId);
    }
  }
  return ids;
}

async function visualReferencePlanHashDriftIsVolatile(sourcePath, dependentArtifact) {
  if (path.basename(sourcePath) !== "visual_reference_plan.json") return false;
  const currentPlan = await readJson(sourcePath, null);
  if (!currentPlan || !statusAllowsDownstreamUse(currentPlan.status) || !(await sourceHashesCurrent(currentPlan))) return false;
  if (Array.isArray(dependentArtifact?.character_state_refs)) {
    return characterStateRefsCompatible(dependentArtifact.character_state_refs, currentPlan.character_state_refs ?? []);
  }
  if (Array.isArray(dependentArtifact?.prompts)) {
    const targetIds = new Set((currentPlan.reference_targets ?? []).map((target) => target.ref_id).filter(Boolean));
    for (const ref of currentPlan.character_state_refs ?? []) {
      if (ref.state_ref_id) targetIds.add(ref.state_ref_id);
      if (ref.source_ref_id) targetIds.add(ref.source_ref_id);
    }
    for (const refId of referencedIdsFromPromptPlan(dependentArtifact)) {
      if (!targetIds.has(refId)) return false;
    }
  }
  return true;
}

async function characterStateRefsHashDriftIsVolatile(sourcePath, dependentArtifact) {
  if (path.basename(sourcePath) !== "character_state_refs.json") return false;
  const currentRefs = await readJson(sourcePath, null);
  if (!currentRefs || !statusAllowsDownstreamUse(currentRefs.status)) return false;
  const sourceHashes = currentRefs.source_hashes && typeof currentRefs.source_hashes === "object" && !Array.isArray(currentRefs.source_hashes)
    ? currentRefs.source_hashes
    : null;
  if (sourceHashes) {
    for (const [currentSourcePath, recordedHash] of Object.entries(sourceHashes)) {
      const currentHash = await fileSha256(currentSourcePath);
      if (!currentHash) return false;
      if (currentHash !== recordedHash && !(await visualReferencePlanHashDriftIsVolatile(currentSourcePath, currentRefs))) return false;
    }
  }
  if (Array.isArray(dependentArtifact?.prompts)) {
    const currentIds = new Set();
    for (const ref of currentRefs.character_state_refs ?? []) {
      if (ref.state_ref_id) currentIds.add(ref.state_ref_id);
      if (ref.source_ref_id) currentIds.add(ref.source_ref_id);
      if (ref.base_identity_ref_id) currentIds.add(ref.base_identity_ref_id);
    }
    for (const sourcePath of Object.keys(sourceHashes ?? {})) {
      if (path.basename(sourcePath) !== "visual_reference_plan.json") continue;
      const visualPlan = await readJson(sourcePath, null);
      for (const target of visualPlan?.reference_targets ?? []) {
        if (target.ref_id) currentIds.add(target.ref_id);
      }
      for (const ref of visualPlan?.character_state_refs ?? []) {
        if (ref.state_ref_id) currentIds.add(ref.state_ref_id);
        if (ref.source_ref_id) currentIds.add(ref.source_ref_id);
        if (ref.base_identity_ref_id) currentIds.add(ref.base_identity_ref_id);
      }
    }
    for (const prompt of dependentArtifact.prompts ?? []) {
      const manifest = prompt.shot_manifest ?? {};
      const stateIds = [
        manifest.protagonist_state_ref_id,
        ...(manifest.character_state_ref_ids ?? []),
      ].filter(Boolean);
      for (const refId of stateIds) {
        if (!currentIds.has(refId)) return false;
      }
    }
  }
  return true;
}

async function jsonStatusWithSourceHashesComplete(filePath, label) {
  const artifact = await readJson(filePath, null);
  if (!artifact) return { done: false, evidence: `${label} missing` };
  const status = String(artifact.status ?? "").toLowerCase();
  if (!statusAllowsDownstreamUse(status)) {
    return { done: false, evidence: `${label}; status=${status || "missing_status"}` };
  }
  const sourceHashes = artifact.source_hashes && typeof artifact.source_hashes === "object" && !Array.isArray(artifact.source_hashes)
    ? artifact.source_hashes
    : null;
  if (!sourceHashes) return { done: true, evidence: `${label}; status=${status || "missing_status"}; source_hashes=missing` };
  const stale = [];
  const ignored = [];
  for (const [sourcePath, recordedHash] of Object.entries(sourceHashes)) {
    const currentHash = await fileSha256(sourcePath);
    if (!currentHash) {
      stale.push(`${path.basename(sourcePath)} missing`);
    } else if (currentHash !== recordedHash) {
      if (await visualReferencePlanHashDriftIsVolatile(sourcePath, artifact)) {
        ignored.push(`${path.basename(sourcePath)} reference_paths_updated`);
      } else if (await characterStateRefsHashDriftIsVolatile(sourcePath, artifact)) {
        ignored.push(`${path.basename(sourcePath)} reference_paths_updated`);
      } else {
        stale.push(`${path.basename(sourcePath)} stale`);
      }
    }
  }
  if (stale.length) {
    return { done: false, evidence: `${label}; status=${status || "missing_status"}; ${stale.slice(0, 4).join(", ")}` };
  }
  return {
    done: true,
    evidence: `${label}; status=${status || "missing_status"}; source_hashes=current${ignored.length ? `; ignored=${ignored.slice(0, 4).join(", ")}` : ""}`,
  };
}

async function visualReferencePlanComplete(episodeDir, currentScriptHash, identity) {
  const visualPlanPath = path.join(episodeDir, "visual_reference_plan.json");
  const characterRefsPath = path.join(episodeDir, "character_state_refs.json");
  const visual = await jsonStatusWithSourceHashesComplete(visualPlanPath, "visual_reference_plan.json");
  const characterRefs = await readJson(characterRefsPath, null);
  if (!characterRefs) {
    return { done: false, evidence: `${visual.evidence}; character_state_refs.json missing` };
  }
  const characterStatus = String(characterRefs.status ?? "").toLowerCase();
  const needsApproval = characterStatus === "draft_needs_manual_review";
  const statusOk = ["approved", "passed", "draft_needs_manual_review"].includes(characterStatus);
  const characterHash = characterRefs.source_script_hash ?? characterRefs.script_hash ?? characterRefs.script_clean_hash ?? null;
  if (!statusOk || characterHash !== currentScriptHash) {
    return {
      done: false,
      evidence: `${visual.evidence}; character_state_refs.json ${characterStatus || "missing_status"} for hash ${characterHash ?? "none"}; required hash ${currentScriptHash}`,
    };
  }
  if (needsApproval) {
    return {
      done: false,
      evidence: `${visual.evidence}; character_state_refs.json status=draft_needs_manual_review`,
      next_command_shape: visualRefsApproveCommand(identity),
    };
  }
  const charSourceHashes = characterRefs.source_hashes && typeof characterRefs.source_hashes === "object" && !Array.isArray(characterRefs.source_hashes)
    ? characterRefs.source_hashes
    : null;
  if (charSourceHashes) {
    const stale = [];
    const ignored = [];
    for (const [sourcePath, recordedHash] of Object.entries(charSourceHashes)) {
      const currentHash = await fileSha256(sourcePath);
      if (!currentHash) stale.push(`${path.basename(sourcePath)} missing`);
      else if (currentHash !== recordedHash) {
        if (await visualReferencePlanHashDriftIsVolatile(sourcePath, characterRefs)) {
          ignored.push(`${path.basename(sourcePath)} reference_paths_updated`);
        } else {
          stale.push(`${path.basename(sourcePath)} stale`);
        }
      }
    }
    if (stale.length) {
      return { done: false, evidence: `${visual.evidence}; character_state_refs.json ${stale.slice(0, 4).join(", ")}` };
    }
    if (ignored.length) {
      return {
        done: visual.done,
        evidence: `${visual.evidence}; character_state_refs.json status=${characterStatus}; source_hashes=current; ignored=${ignored.slice(0, 4).join(", ")}`,
      };
    }
  }
  return {
    done: visual.done,
    evidence: `${visual.evidence}; character_state_refs.json status=${characterStatus}${charSourceHashes ? "; source_hashes=current" : ""}`,
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
    image_provider: flags["image-provider"] ?? flags.provider ?? runIdentity.image_provider ?? "modelslab",
    image_provider_options: runIdentity.image_provider_options ?? {},
    pace_policy: flags["pace-policy"] ?? flags["wpm-policy"] ?? runIdentity.pace_policy ?? "enforced",
    render_profile: flags["render-profile"] ?? runIdentity.render_profile ?? "fill_ken_burns",
  };
  const episode = identity.episode;
  const scriptHash = await fileSha256(path.join(episodeDir, "script_clean.md"));
  const scriptApproval = await scriptApprovalComplete(episodeDir, scriptHash);
  const scriptPace = await paceReportComplete(path.join(episodeDir, "script_pace_report.json"), scriptHash, "script_pace_report.json");
  const speakability = await jsonArtifactHashComplete(path.join(episodeDir, "script_speakability_report.json"), scriptHash, "script_speakability_report.json");
  const ttsOverrides = await jsonArtifactHashComplete(path.join(episodeDir, "tts_spoken_overrides.json"), scriptHash, "tts_spoken_overrides.json");
  const qwenVoicePlan = await qwenVoicePlanComplete(episodeDir, scriptHash);
  const qwenTtsStitch = await qwenTtsStitchComplete(episodeDir, episode, scriptHash);
  const whisperTiming = await whisperTimingComplete(episodeDir, episode, scriptHash);
  const audioPace = await paceReportComplete(path.join(episodeDir, `narration_pace_report_${episode}.json`), scriptHash, `narration_pace_report_${episode}.json`);
  const audioPaceNextCommand = await audioPaceRecoveryCommand(episodeDir, identity);
  const semanticPlan = await jsonStatusComplete(path.join(episodeDir, "semantic_scene_plan.json"), "semantic_scene_plan.json");
  const timedScenePlan = await jsonStatusComplete(path.join(episodeDir, "timed_scene_plan.json"), "timed_scene_plan.json");
  const visualBeatPlan = await jsonStatusWithSourceHashesComplete(path.join(episodeDir, "visual_beat_plan.json"), "visual_beat_plan.json");
  const visualReferencePlan = await visualReferencePlanComplete(episodeDir, scriptHash, identity);
  const hardenedPromptPlan = await jsonStatusWithSourceHashesComplete(path.join(episodeDir, "section_image_prompts_hardened.json"), "section_image_prompts_hardened.json");
  const longformMix = await longformMixComplete(episodeDir, episode);
  const referenceGeneration = await referenceGenerationComplete(episodeDir);
  const imagegen = await imageReportComplete(episodeDir, episode);
  const render = await renderComplete(episodeDir, episode);
  const latestQa = await latestMatching(episodeDir, /^final_qa_.*\.json$|^upload_qa_.*\.json$|^qa_report_.*\.json$/);
  const latestPackaging = await latestMatching(episodeDir, /^upload_packaging.*\.md$|^title_thumbnail.*\.json$|^thumbnail.*\.png$/);
  const visualPromptNextCommand = await visualPromptPlanReviewHardenCommand(episodeDir, identity);
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
    stage("script_pace_check", "approved script hash", "script_pace_report.json", false, scriptPace.done, scriptPace.evidence, identity),
    stage("targeted_speakability", "approved script hash", "script_speakability_report.json + tts_spoken_overrides.json", false, speakability.done && ttsOverrides.done, `${speakability.evidence}; ${ttsOverrides.evidence}`, identity),
    stage("semantic_scene_plan", "approved script + bibles", "semantic_scene_plan.json", false, semanticPlan.done, semanticPlan.evidence, identity),
    stage("voice_plan", "speakability report + overrides", "qwen_generation_plan.json", false, qwenVoicePlan.done, qwenVoicePlan.evidence, identity),
    stage("qwen_tts_stitch", "voice plan + approved TTS text", `modelslab_qwen_tts_report_${episode}.json + stitched narration`, false, qwenTtsStitch.done, qwenTtsStitch.evidence, identity),
    stage("local_whisper_word_timing", "final stitched narration", `narration_word_timing_${episode}.json`, false, whisperTiming.done, whisperTiming.evidence, identity),
    stage("audio_pace_check", "local Whisper word timing", `narration_pace_report_${episode}.json`, false, audioPace.done, audioPace.evidence, identity, audioPaceNextCommand),
    stage("timing_bind", "local Whisper word timing", "timed_scene_plan.json", false, timedScenePlan.done, timedScenePlan.evidence, identity),
    stage("sfx_score_plan", narratorOnly ? "skipped for narrator_only audio target" : "local Whisper timing + timed scenes", narratorOnly ? "skipped" : `sfx_event_plan_${episode}.json + score_drop_plan_${episode}.json`, false, sfxScoreDone.done, sfxScoreDone.evidence, identity),
    stage("longform_audio_mix", narratorOnly ? "stitched narration/Qwen report" : "locked SFX/score assets + narration", "longform_audio_bed_report_*.json + final mix", false, longformMix.done, longformMix.evidence, identity),
    stage("visual_beat_plan", "timed scenes + Whisper timing", "visual_beat_plan.json", false, visualBeatPlan.done, visualBeatPlan.evidence, identity),
    stage("visual_reference_plan", "visual beats + semantic facts", "visual_reference_plan.json + character_state_refs.json", true, visualReferencePlan.done, visualReferencePlan.evidence, identity, visualReferencePlan.next_command_shape),
    stage("reference_generation", "approved reference prompts", "assets/images/references/*", true, referenceGeneration.done, referenceGeneration.evidence, identity),
    stage("visual_prompt_plan_review_harden", "visual beats + approved refs", "section_image_prompts_hardened.json", false, hardenedPromptPlan.done, hardenedPromptPlan.evidence, identity, visualPromptNextCommand),
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
