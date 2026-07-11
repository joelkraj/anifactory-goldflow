#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
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
  finishStageExecution,
} from "../scripts/lib/execution-provenance.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const command = args[0] ?? "help";
const subcommand = args[1] ?? "";
const flags = args.slice(command === "help" ? 1 : 2);

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
  return /^(true|1|yes)$/i.test(String(value ?? ""));
}

function commandStage(commandName, subcommandName, parsedFlags) {
  return commandStageFor(commandName, subcommandName, parsedFlags);
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

function enforceWorkflowGuard(commandName, subcommandName, scriptArgs) {
  const parsedFlags = parseFlags(scriptArgs);
  if (isTrue(parsedFlags["workflow-bypass"]) || isTrue(process.env.GOLDFLOW_WORKFLOW_BYPASS)) return;
  const expectedStage = commandStage(commandName, subcommandName, parsedFlags);
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
  if (allowedStages.includes(expectedStage)) return;
  console.error(`Workflow guard blocked: ${commandName} ${subcommandName}`);
  console.error(`Current stage is ${currentStage}; this command belongs to ${expectedStage}.`);
  if (result.next_command_shape) console.error(`Next valid command shape: ${result.next_command_shape}`);
  console.error("Use --workflow-bypass true only for an explicit operator-approved diagnostic or recovery action.");
  process.exit(1);
}

function run(script, scriptArgs = []) {
  enforceWorkflowGuard(command, subcommand, scriptArgs);
  const parsedFlags = parseFlags(scriptArgs);
  const stage = commandStage(command, subcommand, parsedFlags);
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
      stdio: "inherit",
      env: { ...process.env },
    });
    child.on("error", async (error) => {
      if (execution) await finishStageExecution(execution, { exitCode: 1, error: error.message });
      console.error(error.message);
      process.exitCode = 1;
    });
    child.on("exit", async (code, signal) => {
      if (execution) await finishStageExecution(execution, { exitCode: code ?? 1, signal });
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

One production path. No legacy fallbacks.
Production commands are guarded by the run-status ledger. Use --workflow-bypass true only for explicit diagnostic/recovery work.
Stage registry: ${PIPELINE_STAGE_REGISTRY_VERSION}

Commands:
${registryCommands}
  goldflow run codex-doctor        Inspect the pinned Codex runtime
  goldflow run status              Print the artifact-backed stage ledger
  goldflow run cleanup             Audit or prune safe intermediates
  goldflow visual planner-ab       Run the diagnostic editorial A/B
  goldflow script speakability     Run optional broad speakability review
  goldflow imagegen promote-derived-refs Promote explicitly approved legacy derived refs

Common flags:
  --channel <channel>
  --series <series>
  --week <week>
  --episode ep_01
  --run-intent proof --proof-scope 0-300 locks an isolated bounded proof
  --allow-dirty-worktree true --dirty-reason <reason> is diagnostic/proof-only

Render profiles:
  default premium: --motion smooth_fast_ken_burns --motion-strength 1.75 --render-concurrency 4 --clip-preset veryfast --final-preset veryfast
  legacy diagnostic: --motion fill_ken_burns --motion-strength 1.75 --render-scale-multiplier 1.45 --render-concurrency 4 --clip-preset veryfast --final-preset veryfast
  Motion clips are hash cached; compliant concat streams skip the redundant normalization encode.

Validation-batch flags:
  --qwen-native-speed 1.25 locks provider-native narration speed at preflight; run status adjusts this natively when enforced WPM misses.
  --image-provider hybrid_modelslab_refs_codex_opening_modelslab_rest --codex-opening-sec 300
  Routes references through ModelsLab, scene cuts before the locked opening timestamp through staged Codex imagegen import, and later cuts through ModelsLab.
  --image-provider hybrid_codex_refs_opening_risky_modelslab_rest --codex-opening-sec 600
  Routes all references, opening-window cuts, and risky multi-character or explicitly Codex-routed cuts through staged Codex imagegen import, and later simple cuts through ModelsLab.
  --pace-policy diagnostic records actual WPM without blocking production solely for TTS pace.
  --render-profile smooth_fast_ken_burns is the default; use --render-profile fill_ken_burns only for a deliberate legacy comparison.

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

if (command === "help" || command === "--help" || command === "-h") {
  help();
} else if (command === "run" && subcommand === "preflight") {
  run("run-preflight.mjs", flags);
} else if (command === "run" && subcommand === "codex-doctor") {
  run("codex-runtime-doctor.mjs", flags);
} else if (command === "run" && subcommand === "status") {
  run("run-status.mjs", flags);
} else if (command === "run" && subcommand === "cleanup") {
  run("run-cleanup.mjs", flags);
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
} else if (command === "tts" && subcommand === "qwen") {
  run("modelslab-qwen-episode-audio.mjs", flags);
} else if (command === "audio" && subcommand === "whisper-timing") {
  run("local-whisper-word-timing.mjs", flags);
} else if (command === "audio" && subcommand === "pace-check") {
  run("narration-pace-check.mjs", ["--mode", "audio", ...flags]);
} else if (command === "audio" && subcommand === "tempo-normalize") {
  run("narration-tempo-normalize.mjs", flags);
} else if (command === "timing" && subcommand === "bind") {
  run("timing-bind.mjs", flags);
} else if (command === "visual" && subcommand === "beats") {
  run("visual-beat-plan.mjs", flags);
} else if (command === "visual" && subcommand === "planner-ab") {
  run("visual-planner-ab.mjs", flags);
} else if (command === "visual" && subcommand === "plan") {
  run("visual-plan.mjs", flags);
} else if (command === "visual" && subcommand === "refs") {
  run("visual-reference-plan.mjs", flags);
} else if (command === "visual" && subcommand === "approve-ref-plan") {
  run("visual-reference-plan-approve.mjs", flags);
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
} else if (command === "imagegen" && subcommand === "start") {
  run("imagegen.mjs", flags);
} else if (command === "imagegen" && subcommand === "promote-derived-refs") {
  run("imagegen.mjs", ["--promote-derived-refs", "true", ...flags]);
} else if (command === "imagegen" && subcommand === "import-codex") {
  run("codex-image-manual-import.mjs", flags);
} else if (command === "imagegen" && subcommand === "import-staged-codex") {
  run("codex-image-import-staged.mjs", flags);
} else if (command === "imagegen" && subcommand === "qa") {
  run("image-output-qa.mjs", flags);
} else if (command === "render" && subcommand === "start") {
  run("render.mjs", flags);
} else if (command === "final" && subcommand === "qa") {
  run("final-qa.mjs", flags);
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
