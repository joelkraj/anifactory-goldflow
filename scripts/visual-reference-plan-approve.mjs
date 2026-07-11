#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const flags = parseFlags(process.argv.slice(2));
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";

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

function requiredFlag(name, value) {
  if (!value) throw new Error(`Missing required --${name}.`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  const episodeDir = flags["episode-dir"]
    ? path.resolve(flags["episode-dir"])
    : (() => {
        requiredFlag("channel", flags.channel);
        requiredFlag("week", flags.week);
        requiredFlag("episode", flags.episode);
        return path.join(dataRoot, "channels", flags.channel, "weekly_runs", flags.week, "episodes", flags.episode);
      })();
  const episode = flags.episode ?? path.basename(episodeDir);
  const planPath = path.resolve(flags.plan ?? flags["reference-plan"] ?? path.join(episodeDir, "visual_reference_plan.json"));
  const plan = await readJson(planPath, null);
  if (plan?.status !== "passed") throw new Error(`Reference plan must be passed before approval: ${planPath}`);
  const blockers = (plan.findings ?? []).filter((finding) => finding.severity === "blocker");
  if (blockers.length) throw new Error(`Reference plan has ${blockers.length} unresolved blocker(s).`);
  const targets = Array.isArray(plan.reference_targets) ? plan.reference_targets : [];
  if (!targets.length) throw new Error("Reference plan has no selected targets.");
  const planHash = sha256(await fs.readFile(planPath));
  const outputPath = path.resolve(flags.output ?? path.join(episodeDir, "reference_plan_approval.json"));
  const report = {
    schema: "goldflow_reference_plan_approval_v1",
    status: "approved",
    episode,
    visual_reference_plan_path: planPath,
    visual_reference_plan_sha256: planHash,
    reference_director_contract_version: plan.reference_director_contract_version ?? null,
    selected_target_count: targets.length,
    selected_targets: targets.map((target) => ({
      ref_id: target.ref_id,
      kind: target.kind,
      generation_mode: target.generation_mode,
      scene_ids: target.scene_ids ?? [],
      conditioning_subject_count: target.conditioning_subject_count ?? null,
      conditioning_asset_role: target.conditioning_asset_role ?? null,
    })),
    approved_by: flags["approved-by"] ?? "codex-agent",
    approval_note: flags.note ?? "Reference Director selection, evidence, scopes, and clean conditioning contracts reviewed before generation spend.",
    updated_at: new Date().toISOString(),
  };
  await writeJson(outputPath, report);
  console.log(JSON.stringify({ status: "approved", approval_path: outputPath, selected_target_count: targets.length }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
