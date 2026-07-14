#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  completeWorkItem,
  createCodexWorkManifest,
  failWorkItem,
  getCodexWorkStatus,
  heartbeatWorkItem,
  leaseNextWorkItem,
  parseIdScope,
  validateCodexWorkManifest,
} from "./lib/codex-image-work-contract.mjs";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";

export function parseFlags(parts) {
  const flags = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--") ? parts[index + 1] : "true";
    flags[key] = value;
    if (value !== "true") index += 1;
  }
  return flags;
}

function boolFlag(value) {
  return String(value ?? "false").toLowerCase() === "true";
}

function required(flags, ...keys) {
  for (const key of keys) {
    if (flags[key] !== undefined && String(flags[key]).trim()) return flags[key];
  }
  throw new Error(`Missing required flag: --${keys[0]}.`);
}

export async function runCodexImageWork(flags) {
  const action = String(flags.action ?? "status").trim().toLowerCase();
  if (action === "create") {
    const referencesOnly = boolFlag(flags["references-only"]);
    const mode = referencesOnly || flags.mode === "reference" ? "reference" : "scene";
    const episodeDir = flags["episode-dir"]
      ? path.resolve(flags["episode-dir"])
      : path.join(
          dataRoot,
          "channels",
          flags.channel ?? "53rebirth",
          "weekly_runs",
          flags.week ?? "current",
          "episodes",
          flags.episode ?? "ep_01",
        );
    const promptsPath = flags.prompts ? path.resolve(flags.prompts) : path.join(episodeDir, "section_image_prompts_hardened.json");
    const referencePlanPath = flags["reference-plan"] ?? flags.referencePlan ?? path.join(episodeDir, "visual_reference_plan.json");
    const characterStateRefsPath = flags["character-state-refs"] ?? flags.characterStateRefs ?? path.join(episodeDir, "character_state_refs.json");
    const result = await createCodexWorkManifest({
      mode,
      episodeDir,
      promptsPath,
      referencePlanPath: referencePlanPath ? path.resolve(referencePlanPath) : null,
      characterStateRefsPath: characterStateRefsPath ? path.resolve(characterStateRefsPath) : null,
      stagingRoot: flags["staging-root"] ? path.resolve(flags["staging-root"]) : null,
      imageIds: parseIdScope(flags["image-ids"], flags["image-id"]),
      cutIds: parseIdScope(flags["cut-ids"], flags["cut-id"]),
      referenceIds: parseIdScope(flags["reference-ids"], flags["reference-id"]),
      maxAttempts: flags["max-attempts"],
      leaseSeconds: flags["lease-sec"],
      recommendedConcurrency: flags["recommended-concurrency"],
      maxConcurrency: flags["max-concurrency"],
    });
    return {
      status: "ready",
      created: result.created,
      manifest_id: result.manifest.manifest_id,
      manifest_path: result.manifest.manifest_path,
      mode: result.manifest.mode,
      item_count: result.manifest.item_count,
      asset_ids: result.manifest.items.map((item) => item.asset_id),
    };
  }

  const manifestPath = required(flags, "manifest");
  if (action === "lease") {
    return leaseNextWorkItem({
      manifestPath,
      workerId: required(flags, "worker-id"),
      leaseSeconds: flags["lease-sec"],
    });
  }
  if (action === "heartbeat") {
    return heartbeatWorkItem({
      manifestPath,
      assetId: required(flags, "asset-id"),
      leaseToken: required(flags, "lease-token"),
      workerId: flags["worker-id"],
      leaseSeconds: flags["lease-sec"],
    });
  }
  if (action === "complete") {
    return completeWorkItem({
      manifestPath,
      assetId: required(flags, "asset-id"),
      leaseToken: required(flags, "lease-token"),
      workerId: flags["worker-id"],
      sourcePath: required(flags, "source"),
      reportedSha256: required(flags, "sha256"),
    });
  }
  if (action === "fail") {
    return failWorkItem({
      manifestPath,
      assetId: required(flags, "asset-id"),
      leaseToken: required(flags, "lease-token"),
      workerId: flags["worker-id"],
      error: flags.error ?? flags.reason,
    });
  }
  if (action === "status") return getCodexWorkStatus({ manifestPath });
  if (action === "validate") return validateCodexWorkManifest({ manifestPath });
  throw new Error(`Unknown Codex image work action: ${action}.`);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  try {
    const result = await runCodexImageWork(flags);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (String(flags.action ?? "status").toLowerCase() === "validate" && result.status !== "passed") process.exitCode = 2;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      status: "failed",
      action: String(flags.action ?? "status"),
      error: error instanceof Error ? error.message : String(error),
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) await main();
