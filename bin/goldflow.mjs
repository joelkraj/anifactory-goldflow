#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PIPELINE_STAGE_REGISTRY_VERSION,
  commandStageFor,
  helpCommandLines,
  productionOrderSummary,
} from "../scripts/lib/pipeline-stage-registry.mjs";
import {
  beginStageExecution,
  episodeDirForFlags,
  finishStageExecution,
} from "../scripts/lib/execution-provenance.mjs";
import { creativeStageRerunDecisionForEpisode } from "../scripts/lib/creative-stage-rerun-policy.mjs";
import { plannerRerunDecisionForEpisode } from "../scripts/lib/planner-rerun-policy.mjs";
import { failedRenderResumeDecision } from "../scripts/lib/failed-render-resume.mjs";
import { assertCommandWorkflowRoute, readEpisodeRoutingIdentity } from "../scripts/lib/episode-workflow-routing.mjs";
import { canonicalContentProfileArgument } from "../scripts/lib/content-profiles.mjs";
import { semanticRecoveryAdmission } from "../scripts/lib/semantic-planner-recovery.mjs";
import { visualPromptRecoveryAdmission } from "../scripts/lib/visual-prompt-recovery.mjs";
import { visualBeatRecoveryAdmission } from "../scripts/lib/visual-beat-recovery.mjs";
import { visualBeatExactRepairAdmission } from "../scripts/lib/visual-beat-exact-repair.mjs";
import { visualBeatDensityRepairAdmission } from "../scripts/lib/visual-beat-density-repair.mjs";
import { exactVisualPromptRepairAdmission } from "../scripts/lib/visual-prompt-exact-repair.mjs";
import { screenIdentityBlockerRepairAdmission } from "../scripts/lib/visual-screen-identity-blocker-repair.mjs";
import { visualReferenceRecoveryAdmission } from "../scripts/lib/visual-reference-recovery.mjs";
import { referenceImageQaRecoveryAdmission } from "../scripts/lib/reference-image-recovery.mjs";
import { partialSceneImageQaRecoveryAdmission } from "../scripts/lib/partial-scene-image-recovery.mjs";
import { orphanedImageStreamSealAdmission } from "../scripts/lib/orphaned-image-stream-seal.mjs";
import { openartTriageAdmission } from "../scripts/lib/openart-visual-restart.mjs";
import { falBlockedStageRecoveryAdmission } from "../scripts/lib/fal-production-state.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const command = args[0] ?? "help";
const subcommand = args[1] ?? "";
const flags = args.slice(command === "help" ? 1 : 2);
const helpRequested = args.some((arg) => arg === "--help" || arg === "-h");

function parseFlags(parts) {
  const parsed = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const equalsIndex = part.indexOf("=", 2);
    if (equalsIndex !== -1) {
      parsed[part.slice(2, equalsIndex)] = part.slice(equalsIndex + 1);
      continue;
    }
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--") ? parts[index + 1] : "true";
    parsed[key] = value;
    if (value !== "true") index += 1;
  }
  return parsed;
}

function isTrue(value) {
  return /^(true|1|yes)$/i.test(String(value ?? ""));
}

function commandStage(commandName, subcommandName, parsedFlags, episodeDir) {
  const identity = episodeDir ? readEpisodeRoutingIdentity(episodeDir) ?? {} : {};
  return commandStageFor(commandName, subcommandName, parsedFlags, identity);
}

function statusArgsFor(parsedFlags) {
  if (parsedFlags["episode-dir"]) return ["--episode-dir", parsedFlags["episode-dir"]];
  if (parsedFlags.channel && parsedFlags.week && parsedFlags.episode) {
    const out = ["--channel", parsedFlags.channel, "--week", parsedFlags.week, "--episode", parsedFlags.episode];
    if (parsedFlags.series) out.push("--series", parsedFlags.series);
    if (parsedFlags.seriesSlug) out.push("--seriesSlug", parsedFlags.seriesSlug);
    return out;
  }
  return null;
}

function enforceWorkflowGuard(commandName, subcommandName, scriptArgs, episodeDir) {
  const parsedFlags = parseFlags(scriptArgs);
  if (isTrue(parsedFlags["workflow-bypass"]) || isTrue(process.env.GOLDFLOW_WORKFLOW_BYPASS)) return;
  const expectedStage = commandStage(commandName, subcommandName, parsedFlags, episodeDir);
  if (!expectedStage) return;
  const statusArgs = statusArgsFor(parsedFlags);
  if (!statusArgs) return;
  const status = spawnSync(process.execPath, [
    path.join(repoRoot, "scripts", "run-status.mjs"),
    ...statusArgs,
  ], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 16,
  });
  if (status.status !== 0) {
    console.error(status.stderr || status.stdout || "Workflow guard could not read run status.");
    process.exit(1);
  }
  let result;
  try {
    result = JSON.parse(status.stdout);
  } catch {
    console.error("Workflow guard could not parse run status JSON.");
    process.exit(1);
  }
  const currentStage = result.current_stage;
  const allowedStages = Array.isArray(result.allowed_command_stages)
    ? result.allowed_command_stages
    : [currentStage];
  if (commandName === "voice" && subcommandName === "plan"
    && currentStage === "voice_plan" && result.current_stage_state === "failed"
    && !parsedFlags["performance-packet-ids"]
    && String(result.next_command_shape ?? "").startsWith("node bin/goldflow.mjs voice plan ")) {
    try {
      const direction = JSON.parse(readFileSync(path.join(result.episode_dir, "narration_actionable_direction.json"), "utf8"));
      const plan = JSON.parse(readFileSync(path.join(result.episode_dir, "narration_generation_plan.json"), "utf8"));
      if (direction.status === "approved" && plan.status === "failed_repairable"
        && direction.source_script_sha256 === plan.source_script_hash) return;
    } catch { /* Retain the ordinary workflow guard on missing or malformed evidence. */ }
  }
  if (commandName === "imagegen" && subcommandName === "openart" && parsedFlags.action === "triage") {
    const recovery = openartTriageAdmission(result, parsedFlags);
    if (!recovery.allowed) {
      console.error(`Workflow guard blocked OpenArt triage: ${recovery.reason}`);
      process.exit(1);
    }
    return;
  }
  if (commandName === "imagegen" && subcommandName === "fal") {
    const recovery = falBlockedStageRecoveryAdmission(result, parsedFlags);
    if (recovery.applicable && !recovery.allowed) {
      console.error(`Workflow guard blocked Fal recovery: ${recovery.reason}`);
      process.exit(1);
    }
    if (recovery.applicable && recovery.allowed) return;
  }
  if (commandName === "imagegen" && subcommandName === "codex-work") {
    const recovery = orphanedImageStreamSealAdmission(result, parsedFlags);
    if (recovery.applicable && !recovery.allowed) {
      console.error(`Workflow guard blocked orphan stream seal: ${recovery.reason}.`);
      process.exit(1);
    }
    if (recovery.applicable && recovery.allowed) return;
  }
  if (commandName === "semantic" && subcommandName === "plan") {
    const recovery = semanticRecoveryAdmission(result, parsedFlags);
    if (recovery.applicable && !recovery.allowed) {
      console.error(`Workflow guard blocked semantic recovery: ${recovery.reason}.`);
      if (result.next_command_shape) console.error(`Next valid command shape: ${result.next_command_shape}`);
      process.exit(1);
    }
  }
  if (commandName === "visual" && subcommandName === "beats") {
    const recovery = visualBeatRecoveryAdmission(result, parsedFlags);
    if (recovery.applicable && !recovery.allowed) {
      console.error(`Workflow guard blocked visual beat recovery: ${recovery.reason}.`);
      if (result.next_command_shape) console.error(`Next valid command shape: ${result.next_command_shape}`);
      process.exit(1);
    }
  }
  if (commandName === "visual" && subcommandName === "repair-beats") {
    const repair = visualBeatExactRepairAdmission(result, parsedFlags);
    if (!repair.allowed) {
      console.error(`Workflow guard blocked exact visual beat repair: ${repair.reason}.`);
      if (result.next_command_shape) console.error(`Next valid command shape: ${result.next_command_shape}`);
      process.exit(1);
    }
    return;
  }
  if (commandName === "visual" && subcommandName === "repair-beat-density") {
    const repair = visualBeatDensityRepairAdmission(result, parsedFlags);
    if (!repair.allowed) {
      console.error(`Workflow guard blocked visual beat density repair: ${repair.reason}.`);
      if (result.next_command_shape) console.error(`Next valid command shape: ${result.next_command_shape}`);
      process.exit(1);
    }
    return;
  }
  if (commandName === "visual" && subcommandName === "repair-prompt") {
    const repair = exactVisualPromptRepairAdmission(result, parsedFlags);
    if (!repair.allowed) {
      console.error(`Workflow guard blocked exact visual prompt repair: ${repair.reason}.`);
      process.exit(1);
    }
    return;
  }
  if (commandName === "visual" && subcommandName === "repair-screen-identity") {
    const repair = screenIdentityBlockerRepairAdmission(result, parsedFlags);
    if (!repair.allowed) {
      console.error(`Workflow guard blocked screen identity repair: ${repair.reason}.`);
      process.exit(1);
    }
    return;
  }
  if (commandName === "visual" && subcommandName === "plan") {
    const recovery = visualPromptRecoveryAdmission(result, parsedFlags);
    if (recovery.applicable && !recovery.allowed) {
      console.error(`Workflow guard blocked visual prompt recovery: ${recovery.reason}.`);
      if (result.next_command_shape) console.error(`Next valid command shape: ${result.next_command_shape}`);
      process.exit(1);
    }
    if (recovery.applicable && recovery.allowed) return;
  }
  if (commandName === "visual" && subcommandName === "refs") {
    const recovery = visualReferenceRecoveryAdmission(result, parsedFlags);
    if (recovery.applicable && !recovery.allowed) {
      console.error(`Workflow guard blocked visual reference recovery: ${recovery.reason}.`);
      if (result.next_command_shape) console.error(`Next valid command shape: ${result.next_command_shape}`);
      process.exit(1);
    }
    if (recovery.applicable && recovery.allowed) return;
  }
  if (commandName === "imagegen" && subcommandName === "browser-pool") {
    const partialRecovery = partialSceneImageQaRecoveryAdmission(result, parsedFlags);
    if (partialRecovery.applicable && !partialRecovery.allowed) {
      console.error(`Workflow guard blocked partial scene image QA recovery: ${partialRecovery.reason}.`);
      process.exit(1);
    }
    if (partialRecovery.applicable && partialRecovery.allowed) return;
    const recovery = referenceImageQaRecoveryAdmission(result, parsedFlags);
    if (recovery.applicable && !recovery.allowed) {
      console.error(`Workflow guard blocked reference image QA recovery: ${recovery.reason}.`);
      if (result.next_command_shape) console.error(`Next valid command shape: ${result.next_command_shape}`);
      process.exit(1);
    }
    if (recovery.applicable && recovery.allowed) return;
  }
  if (allowedStages.includes(expectedStage)) return;
  const renderRecovery = failedRenderResumeDecision({ command: commandName, subcommand: subcommandName, flags: parsedFlags, status: result, repoRoot });
  if (renderRecovery.allowed) {
    console.error(`Resuming failed render from reviewed recovery receipt: ${renderRecovery.triage_path}`);
    return;
  }
  if (parsedFlags["render-recovery-triage"] && renderRecovery.reason) console.error(`Render recovery refused: ${renderRecovery.reason}`);
  console.error(`Workflow guard blocked: ${commandName} ${subcommandName}`);
  console.error(`Current stage is ${currentStage}; this command belongs to ${expectedStage}.`);
  if (result.next_command_shape) console.error(`Next valid command shape: ${result.next_command_shape}`);
  console.error("Use --workflow-bypass true only for an explicit operator-approved diagnostic or recovery action.");
  process.exit(1);
}

function run(script, scriptArgs = []) {
  // Child scripts generally parse separate flag/value tokens. Normalize once so
  // dispatch, identity routing, and provenance all see the same final values,
  // including repeated flags that mix --key=value and --key value syntax.
  scriptArgs = scriptArgs.flatMap((arg) => {
    const equalsIndex = arg.startsWith("--") ? arg.indexOf("=", 2) : -1;
    return equalsIndex === -1 ? [arg] : [arg.slice(0, equalsIndex), arg.slice(equalsIndex + 1)];
  });
  if (command !== "footage") {
    scriptArgs = scriptArgs.map((arg, index) => (
      index > 0 && scriptArgs[index - 1] === "--episode-dir" && arg && !arg.startsWith("--")
        ? path.resolve(arg)
        : arg
    ));
  }
  const parsedFlags = parseFlags(scriptArgs);
  const episodeDir = episodeDirForFlags(parsedFlags, process.env);
  try {
    assertCommandWorkflowRoute({ command, subcommand, script, flags: parsedFlags, episodeDir });
    if (command !== "footage" && Object.hasOwn(parsedFlags, "content-profile")) {
      const canonicalProfile = canonicalContentProfileArgument(parsedFlags["content-profile"]);
      if (canonicalProfile !== parsedFlags["content-profile"]) {
        // Preserve last-value precedence for repeated flags in both parsers.
        scriptArgs.push("--content-profile", canonicalProfile);
        parsedFlags["content-profile"] = canonicalProfile;
      }
    }
  } catch (error) {
    console.error(`Workflow routing blocked: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  enforceWorkflowGuard(command, subcommand, scriptArgs, episodeDir);
  const stage = commandStage(command, subcommand, parsedFlags, episodeDir);
  const plannerRerunDecision = command === "visual" && ["repair-beats", "repair-beat-density", "repair-prompt", "repair-screen-identity"].includes(subcommand)
    ? { allowed: true }
    : plannerRerunDecisionForEpisode({ stage, flags: parsedFlags, episodeDir });
  if (!plannerRerunDecision.allowed) {
    console.error(`Planner rerun blocked: ${command} ${subcommand}`);
    console.error(`Reason: ${plannerRerunDecision.reason}. Prior attempts: ${plannerRerunDecision.prior_attempt_count}.`);
    if (plannerRerunDecision.failed_expected_ids?.length) {
      console.error(`Failed planner units: ${plannerRerunDecision.failed_expected_ids.slice(0, 40).join(", ")}`);
    }
    console.error(plannerRerunDecision.required_recovery);
    process.exit(1);
  }
  const creativeRerunDecision = creativeStageRerunDecisionForEpisode({
    command,
    subcommand,
    stage,
    flags: parsedFlags,
    episodeDir,
  });
  if (!creativeRerunDecision.allowed) {
    console.error(`Full-stage rerun blocked: ${command} ${subcommand}`);
    console.error(`Reason: ${creativeRerunDecision.reason}.`);
    if (creativeRerunDecision.command_lane) {
      console.error(`Command lane: ${creativeRerunDecision.command_lane}.`);
    }
    if (creativeRerunDecision.required_recovery) {
      console.error(creativeRerunDecision.required_recovery);
    }
    process.exit(1);
  }
  void (async () => {
    const execution = stage ? await beginStageExecution({
      stage,
      command: `${command} ${subcommand}`.trim(),
      flags: parsedFlags,
      args: scriptArgs,
      env: process.env,
    }) : null;
    const child = spawn(process.execPath, [path.join(repoRoot, "scripts", script), ...scriptArgs], {
      cwd: repoRoot,
      stdio: ["inherit", "pipe", "pipe"],
      env: { ...process.env },
    });
    const maxTailChars = 32 * 1024;
    let stdoutTail = "";
    let stderrTail = "";
    let spawnError = null;
    let finalized = false;
    const appendTail = (current, chunk) => `${current}${chunk}`.slice(-maxTailChars);
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      stdoutTail = appendTail(stdoutTail, chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      stderrTail = appendTail(stderrTail, chunk.toString("utf8"));
    });
    child.on("error", async (error) => {
      spawnError = error;
      console.error(error.message);
    });
    child.on("close", async (code, signal) => {
      if (finalized) return;
      finalized = true;
      const failureDetail = spawnError?.message
        ?? ((code ?? 1) !== 0 ? stderrTail.trim().split("\n").filter(Boolean).at(-1) ?? `Child exited ${code ?? 1}` : null);
      if (execution) await finishStageExecution(execution, {
        exitCode: code ?? 1,
        signal,
        error: failureDetail,
        stdoutTail,
        stderrTail,
      });
      process.exitCode = code ?? 1;
    });
  })().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

function help() {
  const registryCommands = helpCommandLines().join("\n");
  console.log(`AniFactory Goldflow

Profile-routed production with identity-locked media workflows.
Production commands are guarded by the run-status ledger. Use --workflow-bypass true only for explicit diagnostic/recovery work.
Episode commands require an explicit target: --episode-dir where supported, otherwise complete --channel, --week, and --episode flags.
New preflights require --content-profile <manhwa_recap_v1|asset_afterlife_v1|profile.json> --media-workflow generated_visuals_v1.
Content profile selects editorial rules; media workflow selects the stage chain. Existing identities retain their legacy route.
source_footage_v1 / movie_tv_commentary_v1 are reserved, not production-ready. Use standalone footage commands for private clip tests.
Stage registry: ${PIPELINE_STAGE_REGISTRY_VERSION}

Commands:
${registryCommands}
  goldflow run codex-doctor        Inspect the identity-locked Web/Codex planning runtime
  goldflow run status              Print the artifact-backed stage ledger
  goldflow run media-ready         Prepare and verify persistent Flow/Gemini image lanes
  goldflow run advance             Advance automatic stages continuously using the locked production profile
  goldflow run director            Show, advance, or persistently babysit the eight-phase production view
  goldflow run audio-semantic-fork Run semantic planning and the voice/TTS/Whisper branch concurrently
  goldflow run visual-wavefront    Prefetch hardened provider-bound cuts while prompt chunks are authored
  goldflow run web-archive-cleanup Archive legacy unscoped GPT Image chats through one throttled maintenance lane
  goldflow run cleanup             Audit or prune safe intermediates
  goldflow pilot preflight         Initialize the distinct private 90-second avatar proof (see docs/workflows/avatar_pilot_workflow.md)
  goldflow pilot status            Show scoped opening/remaining synthesis and separate listening gates; arbitrary narration imports and publishing remain blocked
  goldflow pilot create-voice-sample Create only two approved opening units via --input <opening-editorial.json>; full-source plan and frozen phase cohorts, no media dispatch
  goldflow pilot approve-voice-sample Accept the exact opening after --attestation complete_opening_listened_end_to_end --accept true --reviewer <name> --note <review>
  goldflow pilot create-narration   Preserve approved opening raw units; synthesize frozen remaining units and run full canonical QA, leaving listening pending
  goldflow pilot review-narration   Resolve a retained raw take's exact-listen warnings; --attestation entire_raw_proof_narration_listened_end_to_end --accept true --reviewer <name> --note <review>; no synthesis/restitch
  goldflow pilot approve-narration Accept the exact full candidate and timing after --attestation entire_proof_narration_listened_end_to_end --accept true --reviewer <name> --note <review>
  goldflow pilot revise-asset-plan One pre-approval revision; --input <plan> --prior-stage-sha256 <hash> --affected-asset-ids <exact-IDs> --reviewer <name> --note <reason>; preserves original, no generation/approval
  goldflow pilot revise-host-design One post-approval host-only amendment after a rejected neutral candidate; --input <request.json> --accept true --reviewer <name> --note <reason>; authorizes exactly one replacement neutral submission
  goldflow pilot approve-host-identity Accept the exact replacement neutral and reviewed real-alpha cutout; --input <request.json> --accept true --reviewer <name> --note <review>; authorizes only its five planned dependent poses
  goldflow pilot use-local-concept-fallback Replace all three refused AI concept stills with source-bound local editorial composites; --input <request.json> --accept true --reviewer <name> --note <reason>
  goldflow pilot preview-style        Render an isolated 8–12-second local visual-review candidate at pilot_media; --input <request.json>; no approvals, provider calls, stage completion or publishing
  goldflow pilot preview-program      Extend an operator-accepted style preview into one separate exactly 90-second private review candidate; --input <request.json>; no exact-edit approval or official stage completion
  goldflow visual planner-ab       Run the diagnostic editorial A/B
  goldflow visual prompt-benchmark Run the locked 25-cut provider prompt benchmark
  goldflow visual parallax-proof-assets Build foreground/background layers for an isolated diagnostic proof
  goldflow visual motion-proof-plan Build isolated image-aware motion/transition proof plans
  goldflow visual motion-promote-proof Promote an approved bounded motion proof into a full-timeline variant
  goldflow visual generated-motion Generate identity-locked Flow video (or dispatch the legacy LTX adapter)
  goldflow visual approve-generated-motion Review every generated clip before motion planning
  goldflow render finalize-report  Stream-hash and finalize an existing passed render report
  goldflow youtube approve-ab-test Approve two or three native title/thumbnail package variants
  goldflow youtube record-ab-test  Record the verified native YouTube experiment
  goldflow analytics ingest        Attribute a YouTube retention export to exact Goldflow cuts
  goldflow analytics aggregate     Aggregate multiple episode feedback reports
  goldflow analytics plan-followups Schedule non-blocking 24h, 72h, and 7d upload reviews
  goldflow analytics record-followup Record one hash-bound YouTube analytics checkpoint
  goldflow analytics followup-status Show due and captured post-publish checkpoints
  goldflow analytics monitor       Discover every due, pending, captured, or unanchored checkpoint
  goldflow analytics classify-script-origins Classify uploaded scripts without conflating production lineage
  goldflow analytics propose-learning Create a hash-bound, non-applying analytics improvement packet
  goldflow analytics approve-learning Approve selected improvements for a controlled test only
  goldflow analytics notify-approval Send one deduplicated local iMessage approval alert
  goldflow benchmark quota          Record isolated Gemini, Flow, and Antigravity quota evidence
  goldflow benchmark planners       Compare task-specific Codex, Antigravity, Gemini, and ChatGPT planning
  goldflow source research         Produce a cited ChatGPT Web Pro research dossier for source development
  goldflow source manufacture      Run three 5.6 Pro drafts, Medium selection, or bounded Medium/High improvement
  goldflow source ideate           Generate and independently rank package-first story candidates before run preflight
  goldflow source approve-package  Operator-approve one exact title/thumbnail/story package
  goldflow source blueprint        Author the package-bound dramatic engine, canon, causal movements, climax, and ending
  goldflow source blueprint-audit  Audit audience trust, package payment, agency, and continuity before blueprint approval
  goldflow source approve-blueprint Hash-approve the exact dramatic blueprint before prose spend
  goldflow source retention-map    Turn the blueprint into question/payoff/change and anti-repetition direction
  goldflow source opening          Write the exact first five minutes as a separately reviewable cold open
  goldflow source approve-opening  Hash-approve the cold open and its endpoint before long-form continuation
  goldflow source script           Continue the approved opening through the complete standalone ending
  goldflow source diagnose         Run causal, emotional-drama, and retention specialist review passes
  goldflow source revise           Integrate grounded specialist findings in one canon-preserving pass
  goldflow source polish           Apply the final narration line-and-flow polish without changing plot
  goldflow source audit            Write an optional non-blocking script/retention review log
  goldflow source release          Operator-release the exact source hash for preflight and ingest
  goldflow footage --help          Opt-in private source library, subtitle search, and bounded 3-5 second clips
  goldflow run performance-audit   Measure active time, idle gaps, blockers, approvals, and provider failures
  goldflow run reference-roi       Measure generated-reference use, timing, downstream acceptance, and recorded risk evidence
  goldflow source evidence-registry Import the measured evidence registry for Evidence Story Room V2
  goldflow source package-outliers Import exact measured own-channel and niche-outlier title packages
  goldflow source premise-discover Discover and select raw story movies before title packaging
  goldflow source promote-premise-movie Lock one operator-selected raw movie before package competition
  goldflow source ideate-v2        Run independent GPT/Gemini package slates, blind judging, and a six-finalist tournament
  goldflow source package-tournament Independently compare all six finalist packages with GPT Web and Gemini Web
  goldflow source adjudicate-package Record an operator's hash-bound package choice after tournament disagreement
  goldflow source approve-package-v2 Hash-approve the exact selected V2 package
  goldflow source reference-frontier Bind and chart the complete measured outlier transcript the story must beat per minute
  goldflow source reference-density-audit Audit any exact candidate against a measured reference using the same density frontier contract
  goldflow source reference-density-revise Apply one integrated, hash-bound repair from a validated density audit
  goldflow source reference-density-patch Apply exact-anchor patches for a small validated density finding set
  goldflow source treatments       Author three competing treatments concurrently across GPT Web and Gemini Web
  goldflow source select-treatment Select the treatment independently with Gemini Web
  goldflow source approve-treatment Hash-approve the exact selected treatment
  goldflow source architecture     Author the unified 10K-word story architecture with GPT Web
  goldflow source architecture-audit Red-team the exact architecture with Gemini Web
  goldflow source approve-architecture Hash-approve the audited architecture
  goldflow source story-truth      Lock package promises, causal chains, agency, mechanics, and state into Story Truth IR
  goldflow source story-truth-audit Independently audit the exact Story Truth IR before prose spend
  goldflow source script-v2        Draft six complete blinded 10K-word candidates across GPT-5.6 Sol Pro and GPT-5.5 Pro
  goldflow source opening-audio-audition  Blind-listen the top two ranked openings with the locked Qwen narrator
  goldflow source mixed-viewer-panel Run the mandatory five-GPT/five-Gemini panel with evidence-gated authority
  goldflow source mixed-viewer-calibration Build or explicitly promote the multi-episode calibration policy
  goldflow source diagnose-v2      Run exact-anchor GPT Web and Gemini Web diagnostics concurrently
  goldflow source revise-v2        Apply one scoped GPT Web developmental revision
  goldflow source narration-revise-v2 Apply one plot-locked narration cadence and speakability polish
  goldflow source story-map-v2      Bind every Story Truth obligation to exact final-script passages
  goldflow source accept-v2        Run Gemini Web semantic acceptance and approve the exact final script
  goldflow source release-v2       Release the complete hash-bound Evidence Story Room V2 lineage
  goldflow source viewer-tournament Run ten fixed-panel blinded ChatGPT Web audience simulations against an exact outlier
  goldflow source viewer-opening-repair Repair only the losing first-minute span while preserving the accepted tail byte-for-byte
  goldflow source viewer-patch     Apply one to three exact bounded patches for isolated fixed-panel losses
  goldflow source viewer-revise    Revise the candidate with GPT Web from ten hash-bound fixed-panel viewer reports
  goldflow source viewer-accept    Require unanimous candidate wins from all ten fixed-panel viewers
  goldflow script speakability     Run optional broad speakability review
  goldflow imagegen promote-derived-refs Promote explicitly approved legacy derived refs
  goldflow audio modelslab-stt-candidate Run an opt-in, spend-confirmed ModelsLab STT timing candidate without replacing local Whisper
  goldflow tts throughput-bakeoff  Run an isolated serial/batch-2/batch-4 Qwen/Liam diagnostic
  goldflow tts import-provider     Import hash-bound WAV results from the identity-locked TTS provider
  goldflow tts finalize-provider   Run delivery, continuity, stitch, mastering, and full-stream QA
  goldflow tts repair-boundary     Repair only reviewed blocked Qwen sentence/word boundaries, then rerun narration QA
  goldflow tts approve-listen      Record hash-bound decisions for exact narration listen items
  goldflow tts approve-subjective  Approve the mandatory hash-bound whole-episode narration sample manifest
  goldflow tts source-structure    Record reviewed narrative chapters separately from technical voice segments
  goldflow tts low-margin-disposition Record an exact-unit advisory policy for passing voice measurements
  goldflow tts delivery-bank       Audit or promote the owned same-speaker delivery-reference bank
  goldflow tts provider-bakeoff    Prepare or approve a blind longform Qwen-versus-Fish/ElevenLabs bakeoff

Common flags:
  --channel <channel>
  --series <series>
  --week <week>
  --episode ep_01
  --run-intent proof --proof-scope 0-300 locks an isolated bounded proof
  --planning-provider chatgpt_web --planning-effort-policy web_pro_adaptive_v1 locks authenticated Web planning (default for new runs)
  --chatgpt-project-url https://chatgpt.com/g/g-p-<id>/project scopes Web planning and GPT Image chats to one disposable run project
  --production-profile fast-premium locks provider-aware planner concurrency and authorized continuous automatic stages
  --allow-dirty-worktree true --dirty-reason <reason> is diagnostic/proof-only

Production profiles:
  fast-premium (default for new preflights): ChatGPT Web text queue 10, heavy starts 2/15 min, Extra High/Pro 1, GPT Image 3, shared browser host 10; local Qwen narration 1; render 4
  fast-premium orchestration: semantic || voice/TTS/Whisper fork, scoped-only planner recovery, identity-locked prompt-to-image wavefront prefetch
  balanced: legacy 4/4/6/6 planner concurrency and explicit spend flags for run advance
  Selecting fast-premium at preflight authorizes planner/media/render spend for run advance. Creative review gates still hold.

Render profiles:
  default premium: --motion smooth_subpixel_ken_burns --motion-strength 1.75 --render-concurrency 4 --clip-preset veryfast --final-preset veryfast
  integer fast fallback: --motion smooth_fast_ken_burns --motion-strength 1.75 --render-concurrency 4 --clip-preset veryfast --final-preset veryfast
  legacy diagnostic: --motion fill_ken_burns --motion-strength 1.75 --render-scale-multiplier 1.45 --render-concurrency 4 --clip-preset veryfast --final-preset veryfast
  Motion clips are hash cached; compliant concat streams skip the redundant normalization encode.

Validation-batch flags:
  --image-provider chatgpt_web_gpt_image --image-model chatgpt_web_gpt_image --reference-model chatgpt_web_gpt_image
  (production default; uses three authenticated GPT Image workers; pass --chatgpt-project-url to avoid per-chat cleanup)
  --image-provider modelslab --image-model gpt-image-2-t2i --reference-model gpt-image-2-i2i --image-fallback-provider codex_imagegen --image-fallback-condition modelslab_credit_exhausted
  Locks GPT Image 2 end to end and permits built-in Codex Imagen fallback only after an explicit ModelsLab insufficient-credit response.
  Default narration is local Qwen3-TTS 1.7B Base with the pinned owned Joel reference clone: sentence-complete 20-42-word preferred units (48 soft/60 hard), semantic joins, alignment-safe edges, deterministic batch-four synthesis, no fallback, no continuous request, and no speed or post-tempo control.
  --image-provider hybrid_modelslab_refs_codex_opening_modelslab_rest --codex-opening-sec 300
  Routes references through ModelsLab, scene cuts before the locked opening timestamp through staged Codex imagegen import, and later cuts through ModelsLab.
  --image-provider hybrid_codex_refs_opening_risky_modelslab_rest --codex-opening-sec 600
  Routes all references, opening-window cuts, and risky multi-character or explicitly Codex-routed cuts through staged Codex imagegen import, and later simple cuts through ModelsLab.
  Actual WPM is always recorded diagnostically and never blocks production.
  --render-profile smooth_subpixel_ken_burns is the default; smooth_fast_ken_burns and fill_ken_burns are explicit fallback/diagnostic profiles.

Production order:
  ${productionOrderSummary()}

Prompt-repair migration guardrails:
  Part F ships before Part G.
  Part F: instrument visual-prompt-harden branch hits -> classify existing prompt plans in scratch outputs -> delete only provably-dead episode-prose branches -> promote live generic rules into data/bible-driven helpers -> add lint to block episode-specific .replace() prose.
  Part G: add span-level repair inside visual review --auto-resolve. Span patches are LLM-authored from structured blocker codes, diff-guarded, revalidated, and escalated to cut re-plan/dead-letter on guard failure.
  visual harden must stay sanitation/generic-only; do not add deterministic story-prose patching there.
  canonical_entities.json is the recurring-cast allowlist; refer to recurring characters by stable ids, not embedded episode sentences.
`);
}

if (command === "pilot" && !helpRequested) {
  try {
    const { executePilotCommand } = await import("../scripts/lib/avatar-pilot-workflow.mjs");
    const result = await executePilotCommand(subcommand, parseFlags(flags), { repoRoot });
    console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
} else if (command === "footage") {
  run("footage.mjs", args.slice(1));
} else if (command === "help" || command === "--help" || command === "-h" || helpRequested) {
  help();
} else if (command === "run" && subcommand === "preflight") {
  run("run-preflight.mjs", flags);
} else if (command === "run" && subcommand === "restart-visuals") {
  run("run-restart-visuals.mjs", flags);
} else if (command === "run" && subcommand === "restart-visuals-fal") {
  run("run-restart-visuals-fal.mjs", flags);
} else if (command === "run" && subcommand === "relock-tts") {
  run("run-relock-tts.mjs", flags);
} else if (command === "run" && subcommand === "codex-doctor") {
  run("codex-runtime-doctor.mjs", flags);
} else if (command === "run" && subcommand === "status") {
  run("run-status.mjs", flags);
} else if (command === "run" && subcommand === "performance-audit") {
  run("run-performance-audit.mjs", flags);
} else if (command === "run" && subcommand === "reference-roi") {
  run("reference-roi-audit.mjs", flags);
} else if (command === "run" && subcommand === "media-ready") {
  run("run-media-readiness.mjs", flags);
} else if (command === "run" && subcommand === "advance") {
  run("run-advance.mjs", flags);
} else if (command === "run" && subcommand === "director") {
  run("run-agent-director.mjs", flags);
} else if (command === "run" && subcommand === "audio-semantic-fork") {
  run("run-audio-semantic-fork.mjs", flags);
} else if (command === "run" && subcommand === "visual-wavefront") {
  run("run-visual-wavefront.mjs", flags);
} else if (command === "run" && subcommand === "web-archive-cleanup") {
  run("chatgpt-web-archive-cleanup.mjs", flags);
} else if (command === "run" && subcommand === "import-proof-baseline") {
  run("proof-baseline-import.mjs", flags);
} else if (command === "run" && subcommand === "cleanup") {
  run("run-cleanup.mjs", flags);
} else if (command === "source" && subcommand === "opening-audio-audition") {
  run("source-opening-audio-audition.mjs", flags);
} else if (command === "source" && subcommand === "manufacture") {
  run("source-script-manufacturer.mjs", flags);
} else if (command === "source" && ["mixed-viewer-shadow", "mixed-viewer-panel"].includes(subcommand)) {
  run("source-mixed-viewer-shadow.mjs", flags);
} else if (command === "source" && subcommand === "mixed-viewer-calibration") {
  run("source-mixed-viewer-calibration.mjs", flags);
} else if (command === "source" && [
  "evidence-registry",
  "package-outliers",
  "premise-discover",
  "promote-premise-movie",
  "ideate-v2",
  "package-tournament",
  "adjudicate-package",
  "revise-package-thumbnail",
  "approve-package-v2",
  "reference-frontier",
  "treatments",
  "select-treatment",
  "approve-treatment",
  "architecture",
  "architecture-audit",
  "approve-architecture",
  "story-truth",
  "story-truth-audit",
  "script-v2",
  "diagnose-v2",
  "revise-v2",
  "narration-revise-v2",
  "story-map-v2",
  "accept-v2",
  "release-v2",
].includes(subcommand)) {
  run("winner-source-room-v2.mjs", [subcommand, ...flags]);
} else if (command === "source" && subcommand === "reference-density-audit") {
  run("source-reference-density-audit.mjs", flags);
} else if (command === "source" && subcommand === "reference-density-revise") {
  run("source-reference-density-revise.mjs", flags);
} else if (command === "source" && subcommand === "reference-density-patch") {
  run("source-reference-density-patch.mjs", flags);
} else if (command === "source" && subcommand === "viewer-tournament") {
  run("source-opening-viewer-tournament.mjs", flags);
} else if (command === "source" && subcommand === "viewer-opening-repair") {
  run("source-opening-scoped-repair.mjs", flags);
} else if (command === "source" && subcommand === "viewer-patch") {
  run("source-viewer-tournament-patch.mjs", flags);
} else if (command === "source" && subcommand === "viewer-revise") {
  run("source-viewer-tournament-revise.mjs", flags);
} else if (command === "source" && subcommand === "viewer-accept") {
  run("source-viewer-tournament-accept.mjs", flags);
} else if (command === "source" && [
  "research",
  "ideate",
  "approve-package",
  "blueprint",
  "blueprint-audit",
  "approve-blueprint",
  "retention-map",
  "opening",
  "approve-opening",
  "script",
  "diagnose",
  "revise",
  "polish",
  "audit",
  "gate",
  "release",
].includes(subcommand)) {
  run("winner-source.mjs", [subcommand, ...flags]);
} else if (command === "ingest" && subcommand === "source") {
  run("source-ingest.mjs", flags);
} else if (command === "script" && subcommand === "approve") {
  run("script-approve.mjs", flags);
} else if (command === "script" && subcommand === "pace-check") {
  run("narration-pace-check.mjs", ["--mode", "script", ...flags]);
} else if (command === "script" && subcommand === "speakability") {
  run("script-speakability-plan.mjs", flags);
} else if (command === "script" && subcommand === "targeted") {
  run("script-targeted-speakability.mjs", flags);
} else if (command === "semantic" && subcommand === "plan") {
  run("semantic-scene-plan.mjs", flags);
} else if (command === "voice" && subcommand === "plan") {
  run("voice-direction-gate.mjs", flags);
} else if (command === "tts" && subcommand === "narrate") {
  run("narration-tts-episode.mjs", flags);
} else if (command === "tts" && subcommand === "import-provider") {
  run("narration-provider-output-import.mjs", flags);
} else if (command === "tts" && subcommand === "finalize-provider") {
  run("narration-provider-output-finalize.mjs", flags);
} else if (command === "tts" && subcommand === "repair-boundary") {
  run("tts-exact-boundary-repair.mjs", flags);
} else if (command === "tts" && subcommand === "approve-listen") {
  run("narration-exact-listen-review.mjs", flags);
} else if (command === "tts" && subcommand === "approve-subjective") {
  run("narration-subjective-review.mjs", flags);
} else if (command === "tts" && subcommand === "source-structure") {
  run("narration-source-structure.mjs", flags);
} else if (command === "tts" && subcommand === "low-margin-disposition") {
  run("narration-low-margin-disposition.mjs", flags);
} else if (command === "tts" && subcommand === "delivery-bank") {
  run("narration-delivery-bank.mjs", flags);
} else if (command === "tts" && subcommand === "provider-bakeoff") {
  run("narration-provider-bakeoff.mjs", flags);
} else if (command === "tts" && subcommand === "throughput-bakeoff") {
  run("tts-qwen-throughput-bakeoff.mjs", flags);
} else if (command === "tts" && subcommand === "qwen") {
  run("modelslab-qwen-episode-audio.mjs", flags);
} else if (command === "audio" && subcommand === "whisper-timing") {
  run("local-whisper-word-timing.mjs", flags);
} else if (command === "audio" && subcommand === "modelslab-stt-candidate") {
  run("modelslab-stt-candidate.mjs", flags);
} else if (command === "audio" && subcommand === "pace-check") {
  run("narration-pace-check.mjs", ["--mode", "audio", ...flags]);
} else if (command === "audio" && subcommand === "tempo-normalize") {
  run("narration-tempo-normalize.mjs", flags);
} else if (command === "timing" && subcommand === "bind") {
  run("timing-bind.mjs", flags);
} else if (command === "visual" && subcommand === "openart-bank") {
  run("openart-production.mjs", flags);
} else if (command === "imagegen" && subcommand === "openart") {
  run("openart-production.mjs", flags);
} else if (command === "imagegen" && subcommand === "fal") {
  run("fal-production.mjs", flags);
} else if (command === "visual" && subcommand === "beats") {
  run("visual-beat-plan.mjs", flags);
} else if (command === "visual" && subcommand === "repair-beats") {
  run("visual-beat-exact-repair.mjs", flags);
} else if (command === "visual" && subcommand === "repair-beat-density") {
  run("visual-beat-density-repair.mjs", flags);
} else if (command === "visual" && subcommand === "planner-ab") {
  run("visual-planner-ab.mjs", flags);
} else if (command === "visual" && subcommand === "prompt-benchmark") {
  run("visual-prompt-benchmark.mjs", flags);
} else if (command === "visual" && subcommand === "plan") {
  run("visual-plan.mjs", flags);
} else if (command === "visual" && subcommand === "repair-prompt") {
  run("visual-prompt-exact-repair.mjs", flags);
} else if (command === "visual" && subcommand === "repair-screen-identity") {
  run("visual-screen-identity-blocker-repair.mjs", flags);
} else if (command === "visual" && subcommand === "refs") {
  run("visual-reference-plan.mjs", flags);
} else if (command === "visual" && subcommand === "approve-ref-plan") {
  run("visual-reference-plan-approve.mjs", flags);
} else if (command === "visual" && subcommand === "repair-ref-plan") {
  run("visual-reference-plan-exact-repair.mjs", flags);
} else if (command === "visual" && subcommand === "approve-refs") {
  run("visual-reference-approve.mjs", flags);
} else if (command === "visual" && subcommand === "review") {
  run("visual-prompt-review.mjs", flags);
} else if (command === "visual" && subcommand === "harden") {
  run("visual-prompt-harden.mjs", flags);
} else if (command === "visual" && subcommand === "engagement") {
  run("engagement-overlay-plan.mjs", flags);
} else if (command === "visual" && subcommand === "transitions") {
  run("visual-transition-plan.mjs", flags);
} else if (command === "visual" && subcommand === "motion-plan") {
  run("visual-motion-plan.mjs", flags);
} else if (command === "visual" && subcommand === "parallax-assets") {
  run("visual-parallax-assets.mjs", flags);
} else if (command === "visual" && subcommand === "approve-parallax") {
  run("parallax-asset-approve.mjs", flags);
} else if (command === "visual" && subcommand === "animation-plan") {
  run("visual-animation-plan.mjs", flags);
} else if (command === "visual" && subcommand === "generated-motion") {
  run("generated-motion-generate.mjs", flags);
} else if (command === "visual" && subcommand === "approve-generated-motion") {
  run("generated-motion-approve.mjs", flags);
} else if (command === "visual" && subcommand === "ltx-video") {
  run("ltx-video-generate.mjs", flags);
} else if (command === "visual" && subcommand === "approve-ltx-video") {
  run("ltx-video-approve.mjs", flags);
} else if (command === "visual" && subcommand === "import-ltx-proof") {
  run("ltx-video-import-proof.mjs", flags);
} else if (command === "visual" && subcommand === "parallax-proof-assets") {
  run("editorial-parallax-assets.mjs", flags);
} else if (command === "visual" && subcommand === "motion-proof-plan") {
  run("editorial-motion-proof-plan.mjs", flags);
} else if (command === "visual" && subcommand === "motion-promote-proof") {
  run("editorial-motion-promote-proof.mjs", flags);
} else if (command === "imagegen" && subcommand === "start") {
  run("imagegen.mjs", flags);
} else if (command === "imagegen" && subcommand === "codex-work") {
  run("codex-image-work.mjs", flags);
} else if (command === "imagegen" && subcommand === "browser-pool") {
  run("hybrid-browser-image-pool.mjs", flags);
} else if (command === "imagegen" && subcommand === "promote-derived-refs") {
  run("imagegen.mjs", ["--promote-derived-refs", "true", ...flags]);
} else if (command === "imagegen" && subcommand === "import-codex") {
  run("codex-image-manual-import.mjs", flags);
} else if (command === "imagegen" && subcommand === "import-staged-codex") {
  run("codex-image-import-staged.mjs", flags);
} else if (command === "imagegen" && subcommand === "qa") {
  run("image-output-qa.mjs", flags);
} else if (command === "imagegen" && subcommand === "analyze") {
  run("image-focal-analysis.mjs", flags);
} else if (command === "render" && subcommand === "start") {
  run("render.mjs", flags);
} else if (command === "render" && subcommand === "finalize-report") {
  run("render-report-finalize.mjs", flags);
} else if (command === "final" && subcommand === "qa") {
  run("final-qa.mjs", flags);
} else if (command === "youtube" && subcommand === "approve-packaging") {
  run("youtube-publish.mjs", ["approve-packaging", ...flags]);
} else if (command === "youtube" && subcommand === "approve-ab-test") {
  run("youtube-publish.mjs", ["approve-ab-test", ...flags]);
} else if (command === "youtube" && subcommand === "prepare") {
  run("youtube-publish.mjs", ["prepare", ...flags]);
} else if (command === "youtube" && subcommand === "record-upload") {
  run("youtube-publish.mjs", ["record-upload", ...flags]);
} else if (command === "youtube" && subcommand === "record-schedule") {
  run("youtube-publish.mjs", ["record-schedule", ...flags]);
} else if (command === "youtube" && subcommand === "record-ab-test") {
  run("youtube-publish.mjs", ["record-ab-test", ...flags]);
} else if (command === "youtube" && subcommand === "record-thumbnail-update") {
  run("youtube-publish.mjs", ["record-thumbnail-update", ...flags]);
} else if (command === "youtube" && subcommand === "record-comment") {
  run("youtube-publish.mjs", ["record-comment", ...flags]);
} else if (command === "analytics" && subcommand === "ingest") {
  run("youtube-analytics-feedback.mjs", ["ingest", ...flags]);
} else if (command === "analytics" && subcommand === "aggregate") {
  run("youtube-analytics-feedback.mjs", ["aggregate", ...flags]);
} else if (command === "analytics" && subcommand === "plan-followups") {
  run("youtube-analytics-followup.mjs", ["plan", ...flags]);
} else if (command === "analytics" && subcommand === "record-followup") {
  run("youtube-analytics-followup.mjs", ["record", ...flags]);
} else if (command === "analytics" && subcommand === "followup-status") {
  run("youtube-analytics-followup.mjs", ["status", ...flags]);
} else if (command === "analytics" && subcommand === "aggregate-followups") {
  run("youtube-analytics-followup.mjs", ["aggregate", ...flags]);
} else if (command === "analytics" && subcommand === "monitor") {
  run("youtube-analytics-monitor.mjs", flags);
} else if (command === "analytics" && subcommand === "classify-script-origins") {
  run("youtube-script-origin-registry.mjs", flags);
} else if (command === "analytics" && subcommand === "propose-learning") {
  run("analytics-learning-proposal.mjs", ["propose", ...flags]);
} else if (command === "analytics" && subcommand === "approve-learning") {
  run("analytics-learning-proposal.mjs", ["approve", ...flags]);
} else if (command === "analytics" && subcommand === "notify-approval") {
  run("analytics-imessage-notify.mjs", flags);
} else if (command === "benchmark" && subcommand === "quota") {
  run("provider-quota-proof.mjs", flags);
} else if (command === "benchmark" && subcommand === "planners") {
  run("planner-benchmark.mjs", flags);
} else if (command === "audio" && subcommand === "enrich-sfx-score") {
  run("audio-sfx-score-enrichment.mjs", flags);
} else if (command === "audio" && subcommand === "score-drops-chunked") {
  run("audio-score-drop-plan-chunked.mjs", flags);
} else if (command === "audio" && subcommand === "repair-ambience") {
  run("audio-ambience-repair.mjs", flags);
} else if (command === "audio" && subcommand === "longform-bed") {
  run("modelslab-longform-audio-bed.mjs", ["start", ...flags]);
} else if (command === "sfx-bank" && subcommand === "rebuild") {
  run("sfx-bank-maintain.mjs", ["rebuild", ...flags]);
} else if (command === "sfx-bank" && subcommand === "audit") {
  run("sfx-bank-maintain.mjs", ["audit", ...flags]);
} else if (command === "sfx-bank" && subcommand === "list") {
  run("sfx-bank-maintain.mjs", ["list", ...flags]);
} else if (command === "sfx-bank" && subcommand === "reject") {
  run("sfx-bank-maintain.mjs", ["reject", ...flags]);
} else if (command === "sfx-bank" && subcommand === "prefer") {
  run("sfx-bank-maintain.mjs", ["prefer", ...flags]);
} else if (command === "score-bank" && subcommand === "rebuild") {
  run("score-bank-maintain.mjs", ["rebuild", ...flags]);
} else if (command === "score-bank" && subcommand === "audit") {
  run("score-bank-maintain.mjs", ["audit", ...flags]);
} else if (command === "score-bank" && subcommand === "list") {
  run("score-bank-maintain.mjs", ["list", ...flags]);
} else if (command === "score-bank" && subcommand === "approve") {
  run("score-bank-maintain.mjs", ["approve", ...flags]);
} else if (command === "score-bank" && subcommand === "reject") {
  run("score-bank-maintain.mjs", ["reject", ...flags]);
} else {
  console.error(`Unknown command: ${args.join(" ")}`);
  help();
  process.exitCode = 1;
}
