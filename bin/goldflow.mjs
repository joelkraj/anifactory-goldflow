#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const command = args[0] ?? "help";
const subcommand = args[1] ?? "";
const flags = args.slice(command === "help" ? 1 : 2);

function run(script, scriptArgs = []) {
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

Commands:
  goldflow ingest source           Copy raw chatbot/script source into script_clean.md
  goldflow script approve          Write exact-hash review/approval lock artifacts
  goldflow script speakability     Review approved script for broad TTS speakability and spoken overrides
  goldflow script targeted         Write targeted problem-area TTS overrides only
  goldflow semantic plan           Extract semantic scene plan from locked script
  goldflow voice plan              Build narrator-first Qwen generation plan
  goldflow tts qwen                Generate/stitch ModelsLab Qwen narration
  goldflow audio whisper-timing    Run local Whisper word timing on stitched narration
  goldflow timing bind             Bind semantic scenes to Whisper timing
  goldflow visual beats            Split timed semantic scenes into visual image beats
  goldflow visual refs             Plan visual references, state refs, and anchor strategy
  goldflow visual plan             Author current-scene-only image prompts from visual beats
  goldflow visual review           Review/fix image prompts with LLM, then validate blockers
  goldflow visual harden           Deterministically repair prompt refs and write pre-imagegen sample QA
  goldflow imagegen start          Generate images from approved prompt plan
  goldflow render start            Render final video from mixed audio, images, Whisper subtitles
  goldflow audio enrich-sfx-score  Plan/generate Whisper-timed SFX and score
  goldflow audio longform-bed      Mix narration + SFX + score

Common flags:
  --channel <channel>
  --series <series>
  --week <week>
  --episode ep_01

Production order:
  source prompt workflow -> ingest source -> script approve -> script targeted -> semantic plan -> voice plan -> tts qwen -> audio whisper-timing -> timing bind -> audio enrich-sfx-score -> audio longform-bed -> visual beats -> visual refs -> visual plan -> visual review -> visual harden -> imagegen start -> render start
`);
}

if (command === "help" || command === "--help" || command === "-h") {
  help();
} else if (command === "ingest" && subcommand === "source") {
  run("source-ingest.mjs", flags);
} else if (command === "script" && subcommand === "approve") {
  run("script-approve.mjs", flags);
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
} else if (command === "timing" && subcommand === "bind") {
  run("timing-bind.mjs", flags);
} else if (command === "visual" && subcommand === "beats") {
  run("visual-beat-plan.mjs", flags);
} else if (command === "visual" && subcommand === "plan") {
  run("visual-plan.mjs", flags);
} else if (command === "visual" && subcommand === "refs") {
  run("visual-reference-plan.mjs", flags);
} else if (command === "visual" && subcommand === "review") {
  run("visual-prompt-review.mjs", flags);
} else if (command === "visual" && subcommand === "harden") {
  run("visual-prompt-harden.mjs", flags);
} else if (command === "imagegen" && subcommand === "start") {
  run("imagegen.mjs", flags);
} else if (command === "render" && subcommand === "start") {
  run("render.mjs", flags);
} else if (command === "audio" && subcommand === "enrich-sfx-score") {
  run("audio-sfx-score-enrichment.mjs", flags);
} else if (command === "audio" && subcommand === "longform-bed") {
  run("modelslab-longform-audio-bed.mjs", ["start", ...flags]);
} else {
  console.error(`Unknown command: ${args.join(" ")}`);
  help();
  process.exitCode = 1;
}
