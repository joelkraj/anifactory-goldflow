#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildStageCommand, stageIsSatisfied } from "./lib/pipeline-stage-registry.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

function statusArgs() {
  if (flags["episode-dir"]) return ["--episode-dir", path.resolve(flags["episode-dir"])];
  const required = ["channel", "week", "episode"];
  if (required.some((key) => !flags[key])) {
    throw new Error("run audio-semantic-fork requires --episode-dir or --channel/--week/--episode.");
  }
  const args = ["--channel", flags.channel, "--week", flags.week, "--episode", flags.episode];
  if (flags.series) args.push("--series", flags.series);
  return args;
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

function runNode(args, { capture = false } = {}) {
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

function stageState(status, stageId) {
  return status.stage_ledger?.find((row) => row.stage === stageId)?.state ?? "missing";
}

async function executeStage(stageId, identity, extraArgs = []) {
  const command = buildStageCommand(stageId, identity);
  const tokens = quoteAwareTokens(command);
  if (tokens[0] !== "node" || tokens[1] !== "bin/goldflow.mjs" || tokens.some((token) => /[<>;]/.test(token))) {
    throw new Error(`Cannot materialize ${stageId} command for parallel execution: ${command}`);
  }
  const result = await runNode([path.join(repoRoot, tokens[1]), ...tokens.slice(2), ...extraArgs]);
  if (result.code !== 0) throw new Error(`${stageId} failed with exit code ${result.code}.`);
  return { stage: stageId, status: "passed_command" };
}

async function main() {
  const initial = await readStatus();
  const identity = initial.identity;
  if (!identity) throw new Error("run audio-semantic-fork requires a valid run_identity.json.");
  const allowed = new Set(initial.allowed_command_stages ?? []);
  const semanticState = stageState(initial, "semantic_scene_plan");
  const voiceState = stageState(initial, "voice_plan");
  const ttsState = stageState(initial, "qwen_tts_stitch");
  if (!stageIsSatisfied(semanticState) && !allowed.has("semantic_scene_plan")) {
    throw new Error(`Semantic branch is not ready; state=${semanticState}.`);
  }
  if (!stageIsSatisfied(voiceState) && !allowed.has("voice_plan")) {
    throw new Error(`Voice branch is not ready; state=${voiceState}.`);
  }

  const startedAt = Date.now();
  const semanticBranch = stageIsSatisfied(semanticState)
    ? Promise.resolve([{ stage: "semantic_scene_plan", status: "reused_passed" }])
    : executeStage("semantic_scene_plan", identity).then((row) => [row]);
  const audioBranch = (async () => {
    const rows = [];
    let status = initial;
    for (const stageId of [
      "voice_plan",
      "qwen_tts_stitch",
      "local_whisper_word_timing",
      "audio_pace_check",
    ]) {
      if (stageIsSatisfied(stageState(status, stageId))) {
        rows.push({ stage: stageId, status: "reused_passed" });
        continue;
      }
      if (!(status.allowed_command_stages ?? []).includes(stageId)) {
        throw new Error(`${stageId} is not ready on the audio branch; allowed=${(status.allowed_command_stages ?? []).join(",")}.`);
      }
      rows.push(await executeStage(stageId, identity));
      status = await readStatus();
    }
    return rows;
  })();

  const [semanticRows, audioRows] = await Promise.all([semanticBranch, audioBranch]);
  const finalStatus = await readStatus();
  console.log(JSON.stringify({
    status: "passed",
    orchestration: "semantic_and_audio_timing_parallel_fork",
    elapsed_sec: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
    branches: {
      semantic: semanticRows,
      audio: audioRows,
    },
    next_stage: finalStatus.current_stage,
    next_command_shape: finalStatus.next_command_shape,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
