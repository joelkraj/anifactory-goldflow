#!/usr/bin/env node

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildStageCommand, stageDefinition, stageIsSatisfied } from "./lib/pipeline-stage-registry.mjs";
import { normalizeImageProvider } from "./lib/image-provider-routing.mjs";
import { isBrowserPoolImageProvider } from "./lib/image-provider-policy.mjs";
import { productionProfileById, productionProfileForIdentity } from "./lib/production-profiles.mjs";
import { buildProductionSloState } from "./lib/production-slo.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flags = parseFlags(process.argv.slice(2));
const maxSteps = Math.max(1, Number(flags["max-steps"] ?? 50));
// Normal production gets one command invocation per stage. A non-zero exit or
// unresolved artifact is a triage boundary, never an instruction to run the
// same command again. A later recovery is a separate exact-ID/chunk command.
const maxAttemptsPerStage = 1;
const dryRun = isTrue(flags["dry-run"]);
const allowSpend = isTrue(flags["allow-spend"]);
const explicitAllowPlannerSpend = allowSpend || isTrue(flags["allow-planner-spend"]);
const explicitAllowMediaSpend = allowSpend || isTrue(flags["allow-media-spend"]);
const explicitAllowRender = allowSpend || isTrue(flags["allow-render"]);
const ignoreProfileAuthorizations = isTrue(flags["ignore-profile-authorizations"]);
const untilStage = String(flags.until ?? "").trim() || null;
const AGENT_APPROVAL_STAGES = new Set([
  "visual_beat_plan",
  "reference_plan_approval",
  "reference_image_approval",
  "image_output_qa",
  "generated_video_motion_approval",
  "parallax_asset_approval",
  "final_qa",
]);

const PLANNER_SPEND_STAGES = new Set(["semantic_scene_plan", "visual_beat_plan", "visual_reference_plan", "visual_prompt_plan", "visual_prompt_blocker_repair"]);
const MEDIA_SPEND_STAGES = new Set(["qwen_tts_stitch", "reference_generation", "image_generation", "generated_video_motion", "parallax_asset_generation"]);
const RENDER_STAGES = new Set(["premium_render"]);

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

function isTrue(value) {
  return /^(?:true|1|yes)$/i.test(String(value ?? ""));
}

function statusArgs() {
  if (flags["episode-dir"]) return ["--episode-dir", path.resolve(flags["episode-dir"])];
  const required = ["channel", "week", "episode"];
  if (required.some((key) => !flags[key])) throw new Error("run advance requires --episode-dir or --channel/--week/--episode.");
  const args = ["--channel", flags.channel, "--week", flags.week, "--episode", flags.episode];
  if (flags.series) args.push("--series", flags.series);
  return args;
}

async function runNode(args, { capture = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: { ...process.env },
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    }
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: `${stderr}\n${error.message}`.trim() }));
    child.on("close", (code, signal) => resolve({ code: code ?? 1, signal, stdout, stderr }));
  });
}

async function readStatus() {
  const result = await runNode([path.join(repoRoot, "scripts", "run-status.mjs"), ...statusArgs()], { capture: true });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "run status failed");
  return JSON.parse(result.stdout);
}

function quoteAwareTokens(command) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (const character of String(command ?? "")) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current) tokens.push(current);
  return tokens;
}

export function autoAdvanceDecisionForTests(stageId, stageState, options = {}) {
  const definition = stageDefinition(stageId);
  if (!definition) return { executable: false, reason: "unknown_stage" };
  if (options.untilStage && stageId === options.untilStage) return { executable: false, reason: "until_stage_reached" };
  if (PLANNER_SPEND_STAGES.has(stageId) && ["blocked", "failed", "stale"].includes(String(stageState ?? ""))) {
    return { executable: false, reason: "planner_triage_and_scoped_recovery_required" };
  }
  if (["blocked", "failed", "stale"].includes(String(stageState ?? ""))) {
    return { executable: false, reason: "stage_blocker_triage_and_scoped_recovery_required" };
  }
  if (new Set(options.humanCheckpointStages ?? []).has(stageId)) {
    return { executable: false, reason: "human_checkpoint_requested" };
  }
  if (definition.approval === "operator") return { executable: false, reason: "approval_required" };
  if (definition.approval === "operator_or_agent") {
    const agentValidatedStages = new Set(options.agentValidatedStages ?? []);
    if (!agentValidatedStages.has(stageId)) return { executable: false, reason: "approval_required" };
  }
  if (definition.approval === "risk_cut_decisions" && stageState !== "missing") return { executable: false, reason: "risk_decisions_required" };
  if (PLANNER_SPEND_STAGES.has(stageId) && !options.allowPlannerSpend) return { executable: false, reason: "planner_spend_not_approved" };
  if (MEDIA_SPEND_STAGES.has(stageId) && !options.allowMediaSpend) return { executable: false, reason: "media_spend_not_approved" };
  if (RENDER_STAGES.has(stageId) && !options.allowRender) return { executable: false, reason: "render_not_approved" };
  return { executable: true, reason: "automatic_stage" };
}

export function parseHumanCheckpointStagesForTests(value, agentStages = AGENT_APPROVAL_STAGES) {
  const entries = String(value ?? "").split(",").map((row) => row.trim()).filter(Boolean);
  if (entries.some((row) => row.toLowerCase() === "all")) return new Set(agentStages);
  return new Set(entries);
}

export function agentApprovalCommandForTests(stageId, episodeDir) {
  const base = `--episode-dir ${episodeDir}`;
  const commands = {
    reference_plan_approval: `node bin/goldflow.mjs visual approve-ref-plan ${base} --approved-by codex-agent --note "Agent verified the selected consistency-complete reference library, evidence scopes, source bindings, and one-concept conditioning contracts."`,
    reference_image_approval: `node bin/goldflow.mjs visual approve-refs ${base} --agent-review true --approved-by codex-agent --note "Agent verified every selected reference hash, readable raster geometry, approved source binding, and conditioning contract; identity-critical scene QA remains active."`,
    image_output_qa: `node bin/goldflow.mjs imagegen qa ${base} --semantic-audit true --semantic-audit-concurrency 8 --semantic-audit-effort medium --semantic-audit-sample-rate 0.02 --agent-review true`,
    generated_video_motion_approval: `node bin/goldflow.mjs visual approve-generated-motion ${base} --agent-review true`,
    parallax_asset_approval: `node bin/goldflow.mjs visual approve-parallax ${base} --agent-review true`,
    final_qa: `node bin/goldflow.mjs final qa ${base} --master-scan true --agent-review true --approved-by codex-agent`,
  };
  return commands[stageId] ?? null;
}

export function advanceCommandTokensForTests(command, episodeDir, sourcePath = null) {
  const resolved = String(command ?? "")
    .replaceAll("<episode-dir>", episodeDir)
    .replaceAll("<source.md>", sourcePath ?? "<source.md>");
  if (!resolved.startsWith("node bin/goldflow.mjs ") || /[;<>]/.test(resolved)) return null;
  const tokens = quoteAwareTokens(resolved);
  if (tokens[0] !== "node" || tokens[1] !== "bin/goldflow.mjs") return null;
  return [path.join(repoRoot, tokens[1]), ...tokens.slice(2)];
}

async function writeAdvanceState(episodeDir, payload) {
  if (dryRun) return;
  const filePath = path.join(episodeDir, "run_advance_state.json");
  await fs.writeFile(filePath, `${JSON.stringify({ schema: "goldflow_run_advance_state_v1", ...payload, updated_at: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

async function writeSloState(episodeDir, runStatus, profile, startedAt) {
  if (!startedAt || dryRun) return null;
  const imageReport = await fs.readFile(path.join(episodeDir, `imagegen_report_${runStatus.identity?.episode ?? "ep_01"}.json`), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => null);
  const completedSceneImages = (imageReport?.results ?? []).filter((row) => row?.image_path).length;
  const state = buildProductionSloState({
    runStatus,
    profile,
    startedAt,
    firstHundredMeasured: completedSceneImages >= Number(profile.orchestration?.provider_readiness_gate?.production_soak_scene_image_count ?? 100),
  });
  if (state) await fs.writeFile(path.join(episodeDir, "production_slo_state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state;
}

async function main() {
  const steps = [];
  const attemptsByStage = new Map();
  let status = await readStatus();
  const episodeDir = path.resolve(status.episode_dir);
  const resumeAfterResolutionCommand = `node bin/goldflow.mjs run director --episode-dir ${episodeDir} --action babysit`;
  const profile = flags.profile || flags["production-profile"]
    ? productionProfileById(flags.profile ?? flags["production-profile"])
    : productionProfileForIdentity(status.identity ?? {});
  const commandIdentity = {
    ...(status.identity ?? {}),
    production_profile: profile.id,
  };
  const profileAdvance = ignoreProfileAuthorizations ? {} : profile.advance;
  const allowPlannerSpend = explicitAllowPlannerSpend || profileAdvance.authorize_planner_spend === true;
  const allowMediaSpend = explicitAllowMediaSpend || profileAdvance.authorize_media_spend === true;
  const allowRender = explicitAllowRender || profileAdvance.authorize_render === true;
  const configuredHumanCheckpoints = flags["human-checkpoints"]
    ?? status.identity?.approval_control?.human_checkpoints?.join(",")
    ?? "";
  const humanCheckpointStages = parseHumanCheckpointStagesForTests(configuredHumanCheckpoints);
  const agentValidatedStages = (profileAdvance.agent_validated_stages ?? [])
    .filter((stageId) => !humanCheckpointStages.has(stageId));
  const readinessChecked = new Set();
  const priorSlo = await fs.readFile(path.join(episodeDir, "production_slo_state.json"), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => null);
  let sloStartedAt = priorSlo?.started_at ?? null;
  for (let step = 0; step < maxSteps; step += 1) {
    const stageId = status.current_stage;
    const stageState = status.current_stage_state ?? status.stage_ledger?.find((row) => row.stage === stageId)?.state ?? "missing";
    if (!stageId || stageId === "complete") {
      await writeAdvanceState(episodeDir, { status: "complete", stop_reason: "pipeline_complete", steps });
      console.log(JSON.stringify({ status: "complete", stop_reason: "pipeline_complete", steps }, null, 2));
      return;
    }
    const useParallelAudioSemantic = stageId === "semantic_scene_plan"
      && profile.orchestration?.parallel_audio_semantic === true;
    const normalizedImageProvider = normalizeImageProvider(status.identity?.image_provider);
    const useVisualWavefront = stageId === "visual_prompt_plan"
      && profile.orchestration?.visual_wavefront_prefetch === true
      && (normalizedImageProvider === "modelslab" || isBrowserPoolImageProvider(normalizedImageProvider));
    const decision = autoAdvanceDecisionForTests(stageId, stageState, {
      untilStage,
      allowPlannerSpend,
      allowMediaSpend,
      allowRender,
      agentValidatedStages,
      humanCheckpointStages: [...humanCheckpointStages],
    });
    let command = status.next_command_shape ?? buildStageCommand(stageId, commandIdentity);
    const readinessPhase = ["script_pace_check", "targeted_speakability", "semantic_scene_plan"].includes(stageId)
      ? "early"
      : stageId === "reference_generation" ? "reference_generation"
        : stageId === "image_generation" ? "image_generation" : null;
    if (readinessPhase
      && decision.executable
      && profile.orchestration?.provider_readiness_gate?.required === true
      && !readinessChecked.has(readinessPhase)) {
      if (dryRun) {
        steps.push({ stage: "provider_readiness", phase: readinessPhase, status: "would_run" });
      } else {
        const readinessResult = await runNode([
          path.join(repoRoot, "scripts", "run-media-readiness.mjs"),
          "--episode-dir", episodeDir,
          "--phase", readinessPhase,
          "--prepare", "true",
        ]);
        steps.push({
          stage: "provider_readiness",
          phase: readinessPhase,
          status: readinessResult.code === 0 ? "passed" : "failed",
          exit_code: readinessResult.code,
          completed_at: new Date().toISOString(),
        });
        if (readinessResult.code !== 0) {
          await writeAdvanceState(episodeDir, {
            status: "held",
            production_profile: profile.id,
            current_stage: stageId,
            current_stage_state: stageState,
            stop_reason: "provider_readiness_required",
            next_command: `node bin/goldflow.mjs run media-ready --episode-dir ${episodeDir} --phase ${readinessPhase} --prepare true`,
            steps,
          });
          console.log(JSON.stringify({
            status: "held",
            production_profile: profile.id,
            current_stage: stageId,
            stop_reason: "provider_readiness_required",
            readiness_phase: readinessPhase,
            steps,
          }, null, 2));
          return;
        }
        if (readinessPhase === "early" && !sloStartedAt) sloStartedAt = new Date().toISOString();
      }
      readinessChecked.add(readinessPhase);
    }
    await writeSloState(episodeDir, status, profile, sloStartedAt);
    if (agentValidatedStages.includes(stageId)) {
      command = agentApprovalCommandForTests(stageId, episodeDir) ?? command;
    }
    if ((useParallelAudioSemantic || useVisualWavefront) && !allowMediaSpend) {
      await writeAdvanceState(episodeDir, {
        status: "held",
        production_profile: profile.id,
        current_stage: stageId,
        current_stage_state: stageState,
        stop_reason: "wavefront_or_parallel_media_spend_not_approved",
        next_command: command,
        steps,
      });
      console.log(JSON.stringify({
        status: "held",
        production_profile: profile.id,
        current_stage: stageId,
        stop_reason: "wavefront_or_parallel_media_spend_not_approved",
        next_command: command,
        steps,
      }, null, 2));
      return;
    }
    if (useParallelAudioSemantic) {
      command = `node bin/goldflow.mjs run audio-semantic-fork --episode-dir ${episodeDir}`;
    } else if (useVisualWavefront) {
      command = `node bin/goldflow.mjs run visual-wavefront --episode-dir ${episodeDir} --min-cuts ${profile.orchestration.wavefront_min_cuts ?? 15} --max-wait-ms ${profile.orchestration.wavefront_max_wait_ms ?? 5000}`;
    }
    if (!decision.executable) {
      await writeAdvanceState(episodeDir, { status: "held", production_profile: profile.id, current_stage: stageId, current_stage_state: stageState, stop_reason: decision.reason, next_command: command, resume_after_resolution_command: resumeAfterResolutionCommand, steps });
      console.log(JSON.stringify({ status: "held", production_profile: profile.id, current_stage: stageId, current_stage_state: stageState, stop_reason: decision.reason, next_command: command, resume_after_resolution_command: resumeAfterResolutionCommand, steps }, null, 2));
      return;
    }
    const invocation = advanceCommandTokensForTests(command, episodeDir, status.identity?.source_path ?? null);
    if (!invocation) {
      await writeAdvanceState(episodeDir, { status: "held", current_stage: stageId, current_stage_state: stageState, stop_reason: "command_requires_manual_materialization", next_command: command, steps });
      console.log(JSON.stringify({ status: "held", current_stage: stageId, stop_reason: "command_requires_manual_materialization", next_command: command, steps }, null, 2));
      return;
    }
    const attempt = (attemptsByStage.get(stageId) ?? 0) + 1;
    if (attempt > maxAttemptsPerStage) {
      await writeAdvanceState(episodeDir, { status: "held", current_stage: stageId, current_stage_state: stageState, stop_reason: "stage_attempt_cap_reached", next_command: command, steps });
      console.log(JSON.stringify({ status: "held", current_stage: stageId, stop_reason: "stage_attempt_cap_reached", steps }, null, 2));
      return;
    }
    attemptsByStage.set(stageId, attempt);
    const stepRow = { stage: stageId, attempt, command, started_at: new Date().toISOString(), dry_run: dryRun };
    if (dryRun) {
      steps.push({ ...stepRow, status: "would_run" });
      await writeAdvanceState(episodeDir, { status: "dry_run", current_stage: stageId, stop_reason: "dry_run", steps });
      console.log(JSON.stringify({ status: "dry_run", current_stage: stageId, invocation, steps }, null, 2));
      return;
    }
    await writeAdvanceState(episodeDir, { status: "running", production_profile: profile.id, current_stage: stageId, steps: [...steps, stepRow] });
    const result = await runNode(invocation);
    steps.push({ ...stepRow, status: result.code === 0 ? "passed_command" : "failed_command", exit_code: result.code, signal: result.signal ?? null, completed_at: new Date().toISOString() });
    status = await readStatus();
    const sloState = await writeSloState(episodeDir, status, profile, sloStartedAt);
    if (sloState?.state === "breached") {
      process.stderr.write(`[goldflow-slo] Hard ceiling exceeded at ${sloState.elapsed_minutes} minutes; continuing only the existing critical path.\n`);
    }
    if (result.code !== 0 || ["blocked", "failed", "stale"].includes(String(status.current_stage_state ?? ""))) {
      const stopReason = result.code !== 0 ? "command_failed" : `stage_${status.current_stage_state}`;
      await writeAdvanceState(episodeDir, { status: "held", current_stage: status.current_stage, current_stage_state: status.current_stage_state, stop_reason: stopReason, next_command: status.next_command_shape, resume_after_resolution_command: resumeAfterResolutionCommand, steps });
      console.log(JSON.stringify({ status: "held", current_stage: status.current_stage, current_stage_state: status.current_stage_state, stop_reason: stopReason, next_command: status.next_command_shape, resume_after_resolution_command: resumeAfterResolutionCommand, steps }, null, 2));
      return;
    }
    if (stageIsSatisfied(status.stage_ledger?.find((row) => row.stage === stageId)?.state)) attemptsByStage.delete(stageId);
  }
  await writeAdvanceState(episodeDir, { status: "held", current_stage: status.current_stage, stop_reason: "max_steps_reached", next_command: status.next_command_shape, steps });
  console.log(JSON.stringify({ status: "held", current_stage: status.current_stage, stop_reason: "max_steps_reached", steps }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
