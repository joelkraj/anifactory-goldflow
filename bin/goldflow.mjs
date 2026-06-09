#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname, "..");
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
  goldflow voice plan              Build narrator-first Qwen generation plan
  goldflow tts qwen                Generate/stitch ModelsLab Qwen narration
  goldflow audio whisper-timing    Run local Whisper word timing on stitched narration
  goldflow audio enrich-sfx-score  Plan/generate Whisper-timed SFX and score
  goldflow audio longform-bed      Mix narration + SFX + score

Common flags:
  --channel <channel>
  --series <series>
  --week <week>
  --episode ep_01

Production order:
  voice plan -> tts qwen -> audio whisper-timing -> audio enrich-sfx-score -> audio longform-bed
`);
}

if (command === "help" || command === "--help" || command === "-h") {
  help();
} else if (command === "voice" && subcommand === "plan") {
  run("voice-direction-gate.mjs", flags);
} else if (command === "tts" && subcommand === "qwen") {
  run("modelslab-qwen-episode-audio.mjs", flags);
} else if (command === "audio" && subcommand === "whisper-timing") {
  run("local-whisper-word-timing.mjs", flags);
} else if (command === "audio" && subcommand === "enrich-sfx-score") {
  run("audio-sfx-score-enrichment.mjs", flags);
} else if (command === "audio" && subcommand === "longform-bed") {
  run("modelslab-longform-audio-bed.mjs", ["start", ...flags]);
} else {
  console.error(`Unknown command: ${args.join(" ")}`);
  help();
  process.exitCode = 1;
}
