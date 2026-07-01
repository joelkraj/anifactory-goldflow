#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  const key = `${commandName} ${subcommandName}`.trim();
  if (key === "ingest source") return "source_ingest";
  if (key === "script approve") return "script_approval";
  if (key === "script pace-check") return "script_pace_check";
  if (key === "script targeted") return "targeted_speakability";
  if (key === "semantic plan") return "semantic_scene_plan";
  if (key === "voice plan") return "voice_plan";
  if (key === "tts qwen") return "qwen_tts_stitch";
  if (key === "audio whisper-timing") return "local_whisper_word_timing";
  if (key === "audio pace-check") return "audio_pace_check";
  if (key === "audio tempo-normalize") return "audio_pace_check";
  if (key === "timing bind") return "timing_bind";
  if (key === "audio enrich-sfx-score") return "sfx_score_plan";
  if (key === "audio score-drops-chunked") return "sfx_score_plan";
  if (key === "audio repair-ambience") return "sfx_score_plan";
  if (key === "audio longform-bed") return "longform_audio_mix";
  if (key === "visual beats") return "visual_beat_plan";
  if (key === "visual refs") return "visual_reference_plan";
  if (key === "visual approve-refs") return "visual_reference_plan";
  if (key === "visual plan") return "visual_prompt_plan_review_harden";
  if (key === "visual review") return "visual_prompt_plan_review_harden";
  if (key === "visual harden") return "visual_prompt_plan_review_harden";
  if (key === "visual engagement") return "transition_edit_plan";
  if (key === "visual transitions") return "transition_edit_plan";
  if (key === "imagegen start") return isTrue(parsedFlags["references-only"]) ? "reference_generation" : "image_generation";
  if (key === "imagegen promote-derived-refs") return "image_generation";
  if (key === "imagegen import-codex") return "image_generation";
  if (key === "imagegen import-staged-codex") return isTrue(parsedFlags["references-only"]) ? "reference_generation" : "image_generation";
  if (key === "render start") return "premium_render";
  return null;
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
  if (currentStage === expectedStage) return;
  console.error(`Workflow guard blocked: ${commandName} ${subcommandName}`);
  console.error(`Current stage is ${currentStage}; this command belongs to ${expectedStage}.`);
  if (result.next_command_shape) console.error(`Next valid command shape: ${result.next_command_shape}`);
  console.error("Use --workflow-bypass true only for an explicit operator-approved diagnostic or recovery action.");
  process.exit(1);
}

function run(script, scriptArgs = []) {
  enforceWorkflowGuard(command, subcommand, scriptArgs);
  const child = spawn(process.execPath, [path.join(repoRoot, "scripts", script), ...scriptArgs], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env },
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

function help() {
  console.log(`AniFactory Goldflow

One production path. No legacy fallbacks.
Production commands are guarded by the run-status ledger. Use --workflow-bypass true only for explicit diagnostic/recovery work.

Commands:
  goldflow run preflight           Lock run identity before ingest or folder creation
  goldflow run status              Print artifact-backed stage ledger before continuing
  goldflow run cleanup             Audit/prune safe unused episode intermediates; use --apply true to delete
  goldflow ingest source           Copy raw chatbot/script source into script_clean.md
  goldflow script approve          Write exact-hash review/approval lock artifacts
  goldflow script pace-check       Write approved-script 210-220 WPM target budget
  goldflow script speakability     Review approved script for broad TTS speakability and spoken overrides
  goldflow script targeted         Write targeted problem-area TTS overrides only
  goldflow semantic plan           Extract semantic scene plan from locked script
  goldflow voice plan              Build narrator-first Qwen generation plan
  goldflow tts qwen                Generate/stitch ModelsLab Qwen narration
  goldflow audio whisper-timing    Run local Whisper word timing on stitched narration
  goldflow audio pace-check        Verify stitched narration is 210-220 WPM from Whisper timing
  goldflow audio tempo-normalize   Recovery: non-destructively tempo-correct slow/fast narration, then rerun Whisper
  goldflow timing bind             Bind semantic scenes to Whisper timing
  goldflow visual beats            Split timed semantic scenes into visual image beats
  goldflow visual refs             Plan visual references, state refs, and anchor strategy
  goldflow visual approve-refs     Approve reviewed/generated refs for visual prompt planning
  goldflow visual plan             Author current-scene-only image prompts from visual beats
  goldflow visual review           Review/fix prompts with LLM auto-resolve; span repair belongs here
    use --resume-blocked true to continue an existing blocked review/harden repair without rerunning full visual plan
  goldflow visual harden           Generic-only prompt/ref sanitation and pre-imagegen sample QA
  goldflow visual engagement       Plan sparse render-layer comment/like/subscribe bubbles
  goldflow visual transitions      Plan xfade transitions from hardened cuts; transition SFX is opt-in
  goldflow imagegen start          Generate images from approved prompt plan
  goldflow imagegen promote-derived-refs Promote successful seed cuts into derive-from-cut reference images
  goldflow imagegen import-codex   Import one manually generated Codex/OpenAI scene-cut raster
  goldflow imagegen import-staged-codex Import staged built-in Codex rasters for scene cuts or --references-only refs
  goldflow render start            Render final video from mixed audio, images, Whisper subtitles
  goldflow audio enrich-sfx-score  Opt-in plan/generate Whisper-timed SFX and score
  goldflow audio score-drops-chunked Plan score drops in smaller LLM chunks
  goldflow audio repair-ambience   Add Codex-agent manual ambience beds when enrichment under-targets ambience
  goldflow audio longform-bed      Build the continuous audio bed; narrator-only by default

Common flags:
  --channel <channel>
  --series <series>
  --week <week>
  --episode ep_01

Render profiles:
  default premium: --motion fill_ken_burns --motion-strength 1.75 --render-scale-multiplier 1.45 --render-concurrency 4 --clip-preset veryfast --final-preset veryfast
  smoother A/B sibling: --motion smooth_fast_ken_burns --motion-strength 1.75 --render-concurrency 4 --clip-preset veryfast --final-preset veryfast
  The smoother sibling writes best to a separate --output/--report-output path so it can be reviewed alongside the premium render.

Validation-batch flags:
  --image-provider hybrid_modelslab_refs_codex_opening_modelslab_rest --codex-opening-sec 300
  Routes references through ModelsLab, scene cuts before the locked opening timestamp through staged Codex imagegen import, and later cuts through ModelsLab.
  --pace-policy diagnostic records actual WPM without blocking production solely for TTS pace.
  --render-profile smooth_fast_ken_burns makes premium_render use the smoother no-oversample profile as the primary render.

Production order:
  run preflight -> source prompt workflow -> ingest source -> script approve -> script pace-check -> script targeted -> semantic plan -> voice plan -> tts qwen -> audio whisper-timing -> audio pace-check -> timing bind -> audio longform-bed --narration-only true -> visual beats -> visual refs (director inventory + final refs) -> reference imagegen -> visual approve-refs -> visual plan -> visual review --auto-resolve true -> visual harden -> optional visual engagement -> visual transitions --transition-sfx false -> imagegen start --seed-derived-refs true when needed -> imagegen promote-derived-refs when seed cuts are ready -> imagegen start -> render start

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
} else if (command === "visual" && subcommand === "plan") {
  run("visual-plan.mjs", flags);
} else if (command === "visual" && subcommand === "refs") {
  run("visual-reference-plan.mjs", flags);
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
} else if (command === "render" && subcommand === "start") {
  run("render.mjs", flags);
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
