#!/usr/bin/env node

import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildNarrationProviderBakeoffManifest,
  buildNarrationProviderPromotion,
  validateNarrationProviderBakeoffManifest,
  validateNarrationProviderPromotion,
} from "./lib/narration-provider-bakeoff-contract.mjs";

const execFile = promisify(execFileCb);

function flagsFrom(parts) {
  const flags = {};
  for (let index = 0; index < parts.length; index += 1) {
    if (!parts[index].startsWith("--")) continue;
    const key = parts[index].slice(2);
    const next = parts[index + 1];
    flags[key] = next && !next.startsWith("--") ? next : "true";
    if (flags[key] !== "true") index += 1;
  }
  return flags;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileBinding(filePath) {
  const resolved = path.resolve(filePath);
  return { path: resolved, sha256: sha256(await fs.readFile(resolved)) };
}

async function durationSec(filePath) {
  const { stdout } = await execFile("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", filePath,
  ]);
  const value = Number(stdout.trim());
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Could not measure audio duration: ${filePath}`);
  return Number(value.toFixed(3));
}

async function audioBinding(filePath) {
  const binding = await fileBinding(filePath);
  return { ...binding, audio_path: binding.path, audio_sha256: binding.sha256, duration_sec: await durationSec(binding.path) };
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function treatment(flags, prefix, defaultProvider) {
  const representative = await audioBinding(flags[`${prefix}-representative-audio`]);
  const fatigue = await audioBinding(flags[`${prefix}-fatigue-audio`]);
  const repeatFirst = await audioBinding(flags[`${prefix}-repeat-first-audio`]);
  const repeatSecond = await audioBinding(flags[`${prefix}-repeat-second-audio`]);
  return {
    provider: flags[`${prefix}-provider`] ?? defaultProvider,
    model_id: flags[`${prefix}-model`],
    model_revision: flags[`${prefix}-model-revision`] ?? null,
    voice_id: flags[`${prefix}-voice-id`],
    voice_sha256: flags[`${prefix}-voice-sha256`],
    representative,
    fatigue,
    repeatability: {
      first_audio_path: repeatFirst.audio_path,
      first_audio_sha256: repeatFirst.audio_sha256,
      second_audio_path: repeatSecond.audio_path,
      second_audio_sha256: repeatSecond.audio_sha256,
    },
    economics: {
      latency_sec: Number(flags[`${prefix}-latency-sec`]),
      estimated_cost_usd: Number(flags[`${prefix}-cost-usd`]),
    },
  };
}

async function main() {
  const flags = flagsFrom(process.argv.slice(2));
  const action = String(flags.action ?? "prepare");
  if (action === "prepare") {
    for (const key of ["representative-text", "fatigue-text", "baseline-representative-audio", "baseline-fatigue-audio", "baseline-repeat-first-audio", "baseline-repeat-second-audio", "challenger-representative-audio", "challenger-fatigue-audio", "challenger-repeat-first-audio", "challenger-repeat-second-audio", "baseline-model", "baseline-voice-id", "baseline-voice-sha256", "challenger-provider", "challenger-model", "challenger-voice-id", "challenger-voice-sha256", "voice-similarity-evidence", "repeatability-evidence"]) {
      if (!flags[key]) throw new Error(`--${key} is required.`);
    }
    const [representativeText, fatigueText, baseline, challenger, similarity, repeatability] = await Promise.all([
      fileBinding(flags["representative-text"]),
      fileBinding(flags["fatigue-text"]),
      treatment(flags, "baseline", "qwen_local"),
      treatment(flags, "challenger", flags["challenger-provider"]),
      fileBinding(flags["voice-similarity-evidence"]),
      fileBinding(flags["repeatability-evidence"]),
    ]);
    const manifest = buildNarrationProviderBakeoffManifest({
      representativeTextSha256: representativeText.sha256,
      fatigueTextSha256: fatigueText.sha256,
      voiceIdentitySha256: flags["baseline-voice-sha256"],
      baseline,
      challenger,
      voiceSimilarityEvidence: similarity,
      repeatabilityEvidence: repeatability,
    });
    const validation = validateNarrationProviderBakeoffManifest(manifest);
    if (validation.status !== "passed") throw new Error(`Bakeoff manifest blocked: ${validation.findings.map((row) => row.code).join(", ")}`);
    const output = path.resolve(flags.output ?? "narration_provider_bakeoff_manifest.json");
    await writeJson(output, manifest);
    console.log(JSON.stringify({ status: "ready_for_blind_review", output, blind_packet: manifest.blind.reviewer_packet }, null, 2));
    return;
  }
  if (action !== "approve") throw new Error("--action must be prepare or approve.");
  const manifestPath = path.resolve(flags.manifest ?? "");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const promotion = buildNarrationProviderPromotion({
    manifest,
    winnerLabel: flags["winner-label"],
    reviewer: flags.reviewer,
    blindPreference: flags["blind-preference"] ?? flags["winner-label"],
    representativePass: flags["representative-pass"] === "true",
    fatiguePass: flags["fatigue-pass"] === "true",
    repeatabilityPass: flags["repeatability-pass"] === "true",
    voiceIdentityPass: flags["voice-identity-pass"] === "true",
    voiceDriftVetoClear: flags["voice-drift-clear"] === "true",
    costLatencyJustified: flags["cost-latency-justified"] === "true",
    rationale: flags.rationale,
  });
  const validation = validateNarrationProviderPromotion(promotion, manifest);
  if (validation.status !== "passed") throw new Error(`Provider promotion blocked: ${validation.findings.map((row) => row.code).join(", ")}`);
  const output = path.resolve(flags.output ?? path.join(path.dirname(manifestPath), "narration_provider_promotion.json"));
  await writeJson(output, promotion);
  console.log(JSON.stringify({ status: promotion.status, promoted_provider: promotion.promoted_provider, output }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
