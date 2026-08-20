#!/usr/bin/env node

import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildNarrationSynthesisIdentity,
  buildNarrationProviderOutputManifest,
  narrationProviderAdapter,
  narrationProviderRequestSha256,
  narrationSynthesisIdentitySha256,
} from "./lib/narration-provider-adapter.mjs";
import {
  buildNarrationQualityContract,
  narrationQualityContractForIdentity,
} from "./lib/narration-quality-contract.mjs";
import { sha256File } from "./lib/file-hash.mjs";

const execFile = promisify(execFileCb);

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function parseFlags(parts) {
  const flags = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--")
      ? parts[++index]
      : "true";
    flags[key] = value;
  }
  return flags;
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function durationSec(filePath) {
  const { stdout } = await execFile("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  const value = Number(stdout.trim());
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Provider audio has no positive duration: ${filePath}`);
  }
  return value;
}

function planUnits(plan) {
  if (Array.isArray(plan?.units) && plan.units.length) return plan.units;
  return (plan?.segments ?? []).flatMap((segment) => (
    segment?.narration_units
      ?? segment?.tts_generation_units
      ?? segment?.qwen_generation_units
      ?? segment?.generation_units
      ?? []
  ));
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const inputFlag = flags.input ?? flags.results;
  if (!flags["episode-dir"] || !inputFlag) {
    throw new Error(
      "--episode-dir and --input <provider-results.json> are required.",
    );
  }
  const episodeDir = path.resolve(flags["episode-dir"]);
  const identityPath = path.join(episodeDir, "run_identity.json");
  const planPath = path.resolve(
    flags.plan ?? path.join(episodeDir, "narration_generation_plan.json"),
  );
  const [identity, plan, raw, planFileSha256] = await Promise.all([
    readJson(identityPath, {}),
    readJson(planPath),
    readJson(path.resolve(inputFlag)),
    sha256File(planPath),
  ]);
  if (!plan) throw new Error(`Narration generation plan is missing: ${planPath}`);
  if (!raw || !Array.isArray(raw.results)) {
    throw new Error("Provider input must contain a results array.");
  }
  const units = planUnits(plan);
  if (!units.length) throw new Error("Narration plan has no generation units.");
  const provider = narrationProviderAdapter(
    flags.provider ?? raw.provider ?? identity.tts_provider,
  ).provider;
  const modelId = flags["model-id"] ?? raw.model_id ?? null;
  const modelRevision = flags["model-revision"] ?? raw.model_revision ?? null;
  const voiceId = flags["voice-id"]
    ?? raw.voice_id
    ?? identity.narrator_voice_id
    ?? null;
  const voiceSha256 = flags["voice-sha256"]
    ?? raw.voice_sha256
    ?? identity.voice_provider_options?.primary?.voice_sha256
    ?? null;
  const voiceContinuityContract = flags["voice-continuity-contract"]
    ?? raw.voice_continuity_contract
    ?? identity.voice_provider_options?.primary?.voice_continuity_contract
    ?? null;
  if (!modelId || !modelRevision || !voiceId || !voiceSha256
    || !voiceContinuityContract) {
    throw new Error(
      "Provider import requires locked model ID/revision and voice ID/hash/continuity contract.",
    );
  }
  const planProvider = narrationProviderAdapter(
    plan.primary_provider ?? plan.provider ?? provider,
  ).provider;
  if (planProvider !== provider) {
    throw new Error(
      `Provider import ${provider} does not match the voice plan ${planProvider}.`,
    );
  }
  const rawIds = raw.results.map((row) => String(row?.unit_id ?? ""));
  const duplicatedRawIds = rawIds.filter((unitId, index) => (
    !unitId || rawIds.indexOf(unitId) !== index
  ));
  if (duplicatedRawIds.length) {
    throw new Error(
      `Provider results contain missing or duplicate unit IDs: ${[...new Set(duplicatedRawIds)].join(",")}`,
    );
  }
  const rawById = new Map(
    raw.results.map((row) => [String(row?.unit_id ?? ""), row]),
  );
  const expectedIds = units.map((unit) => String(unit.unit_id));
  const unknownIds = [...rawById.keys()].filter((unitId) => !expectedIds.includes(unitId));
  if (unknownIds.length || rawById.size !== expectedIds.length) {
    throw new Error(
      `Provider result scope differs from the plan; unknown=${unknownIds.join(",") || "none"}, `
      + `received=${rawById.size}, expected=${expectedIds.length}.`,
    );
  }
  const results = [];
  for (const unit of units) {
    const row = rawById.get(String(unit.unit_id));
    if (!row?.audio_path) {
      throw new Error(`Provider result is missing audio_path for ${unit.unit_id}.`);
    }
    const audioPath = path.resolve(row.audio_path);
    const [audioSha256, duration] = await Promise.all([
      sha256File(audioPath),
      durationSec(audioPath),
    ]);
    if (row.audio_sha256 && row.audio_sha256 !== audioSha256) {
      throw new Error(`Provider-declared audio hash is stale for ${unit.unit_id}.`);
    }
    const providerRequest = unit?.provider_request;
    if (providerRequest?.status !== "compiled"
      || providerRequest?.adapter?.provider !== provider) {
      throw new Error(
        `Voice plan has no current ${provider} request contract for ${unit.unit_id}.`,
      );
    }
    const requestSha256 = providerRequest.request_sha256
      ?? narrationProviderRequestSha256(providerRequest.request ?? providerRequest);
    const synthesisIdentity = buildNarrationSynthesisIdentity({
      provider,
      adapterId: providerRequest.adapter?.adapter_id,
      modelId,
      modelRevision,
      voiceId,
      voiceSha256,
      voiceContinuityContract,
      unitId: String(unit.unit_id),
      spokenTextSha256: providerRequest.synthesis_identity?.spoken_text_sha256
        ?? sha256(unit.spoken_text ?? unit.tts_spoken_text ?? ""),
      providerRequestSha256: requestSha256,
    });
    const synthesisIdentitySha256 = narrationSynthesisIdentitySha256(
      synthesisIdentity,
    );
    if (providerRequest.synthesis_identity_sha256
      && providerRequest.synthesis_identity_sha256 !== synthesisIdentitySha256) {
      throw new Error(
        `Voice plan synthesis identity is stale for ${unit.unit_id}; regenerate only the voice plan before provider spend.`,
      );
    }
    if (row.synthesis_identity_sha256
      && row.synthesis_identity_sha256 !== synthesisIdentitySha256) {
      throw new Error(
        `Provider synthesis identity differs from the locked request for ${unit.unit_id}.`,
      );
    }
    results.push({
      ...row,
      unit_id: String(unit.unit_id),
      status: "accepted",
      audio_path: audioPath,
      audio_sha256: audioSha256,
      duration_sec: duration,
      model_id: modelId,
      model_revision: modelRevision,
      voice_id: voiceId,
      voice_sha256: voiceSha256,
      voice_continuity_contract: voiceContinuityContract,
      synthesis_identity: synthesisIdentity,
      synthesis_identity_sha256: synthesisIdentitySha256,
    });
  }
  const qualityContract = narrationQualityContractForIdentity(identity)
    ?? buildNarrationQualityContract({ provider, modelId, modelRevision });
  const manifest = buildNarrationProviderOutputManifest({
    provider,
    modelId,
    modelRevision,
    voiceId,
    voiceSha256,
    voiceContinuityContract,
    generationPlanSha256: plan.plan_sha256 ?? planFileSha256,
    generationPlanFileSha256: planFileSha256,
    qualityContractSha256: qualityContract.contract_sha256,
    providerExecution: raw.provider_execution ?? null,
    units,
    results,
  });
  if (manifest.status !== "passed") {
    throw new Error(
      `Provider output manifest failed validation: ${manifest.validation.findings
        .map((finding) => finding.code)
        .join(", ")}`,
    );
  }
  const episode = String(identity.episode ?? flags.episode ?? "ep_01");
  const outputPath = path.resolve(
    flags.output
      ?? path.join(episodeDir, `narration_provider_output_manifest_${episode}.json`),
  );
  await atomicWriteJson(outputPath, manifest);
  console.log(JSON.stringify({
    status: "passed",
    provider,
    adapter_id: manifest.adapter_id,
    unit_count: manifest.unit_count,
    output_path: outputPath,
    manifest_sha256: manifest.manifest_sha256,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
