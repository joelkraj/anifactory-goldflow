#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

function parseFlags(parts) {
  const out = {};
  for (let index = 0; index < parts.length; index += 1) {
    if (!parts[index].startsWith("--")) continue;
    const key = parts[index].slice(2);
    out[key] = parts[index + 1] && !parts[index + 1].startsWith("--")
      ? parts[++index]
      : "true";
  }
  return out;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function sha256File(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function authoredPromptHash(prompt) {
  return sha256(JSON.stringify({
    image_prompt: prompt.image_prompt ?? null,
    modelslab_image_prompt: prompt.modelslab_image_prompt ?? null,
    codex_image_prompt: prompt.codex_image_prompt ?? null,
    shot_manifest: prompt.shot_manifest ?? null,
    reference_requirements: prompt.reference_requirements ?? [],
  }));
}

const flags = parseFlags(process.argv.slice(2));
const episodeDir = path.resolve(String(flags["episode-dir"] ?? ""));
const archivePlanPath = path.resolve(String(flags["archive-plan"] ?? ""));
if (!episodeDir || !archivePlanPath) {
  throw new Error("Usage: restore-retimed-prompt-creative-contracts --episode-dir <dir> --archive-plan <archived hardened plan>");
}

const planPath = path.join(episodeDir, "section_image_prompts.json");
const ledgerPath = path.join(episodeDir, "cut_execution_ledger.json");
const [current, archived, ledger] = await Promise.all([
  readJson(planPath),
  readJson(archivePlanPath),
  readJson(ledgerPath),
]);
const archivedById = new Map((archived.prompts ?? []).map((row) => [String(row.image_id), row]));
const ledgerById = new Map((ledger.cuts ?? []).map((row) => [String(row.image_id), row]));
const findings = [];
let verifiedCount = 0;
let restoredCount = 0;

const prompts = [];
for (const currentPrompt of current.prompts ?? []) {
  const imageId = String(currentPrompt.image_id ?? "");
  const archivedPrompt = archivedById.get(imageId);
  const cut = ledgerById.get(imageId);
  if (!archivedPrompt || !cut) {
    findings.push({ code: "prompt_recovery_identity_missing", image_id: imageId });
    prompts.push(currentPrompt);
    continue;
  }
  const archivedHash = authoredPromptHash(archivedPrompt);
  if (archivedHash !== cut.authored_prompt_hash) {
    findings.push({
      code: "archived_creative_hash_mismatch",
      image_id: imageId,
      archived_hash: archivedHash,
      ledger_hash: cut.authored_prompt_hash,
    });
    prompts.push(currentPrompt);
    continue;
  }
  const archivedRefIds = (archivedPrompt.reference_slots ?? archivedPrompt.reference_requirements ?? [])
    .map((row) => String(row.ref_id ?? ""))
    .filter(Boolean)
    .sort();
  const ledgerRefIds = (cut.reference_ids ?? []).map(String).sort();
  if (JSON.stringify(archivedRefIds) !== JSON.stringify(ledgerRefIds)) {
    findings.push({
      code: "archived_reference_ids_mismatch",
      image_id: imageId,
      archived_ref_ids: archivedRefIds,
      ledger_ref_ids: ledgerRefIds,
    });
    prompts.push(currentPrompt);
    continue;
  }
  if (!cut.image_path || await sha256File(cut.image_path) !== cut.image_sha256) {
    findings.push({ code: "accepted_image_hash_mismatch", image_id: imageId });
    prompts.push(currentPrompt);
    continue;
  }
  let referenceMismatch = false;
  for (const reference of cut.references ?? []) {
    if (!reference.path || await sha256File(reference.path) !== reference.sha256) {
      referenceMismatch = true;
      findings.push({
        code: "accepted_reference_hash_mismatch",
        image_id: imageId,
        path: reference.path ?? null,
      });
    }
  }
  if (referenceMismatch) {
    prompts.push(currentPrompt);
    continue;
  }
  verifiedCount += 1;
  const restored = {
    ...archivedPrompt,
    scene_id: currentPrompt.scene_id,
    visual_beat_id: currentPrompt.visual_beat_id,
    start_sec: currentPrompt.start_sec,
    duration_sec: currentPrompt.duration_sec,
    location_timeline_label: currentPrompt.location_timeline_label,
    active_state_constraints: currentPrompt.active_state_constraints,
    timing_recovery: {
      source: "current_puck_whisper_retime",
      creative_contract_source: archivePlanPath,
      creative_contract_sha256: archivedHash,
      accepted_image_sha256: cut.image_sha256,
      identity_preserved: true,
    },
  };
  if (JSON.stringify(restored) !== JSON.stringify(currentPrompt)) restoredCount += 1;
  prompts.push(restored);
}

if (findings.length || verifiedCount !== (current.prompts ?? []).length) {
  throw new Error(`Prompt recovery verification failed: ${JSON.stringify(findings.slice(0, 20))}`);
}

const output = {
  ...current,
  prompts,
  prompt_count: prompts.length,
  timing_recovery: {
    mode: "retimed_locked_beats_with_archived_creative_contracts",
    archive_plan_path: archivePlanPath,
    archive_plan_sha256: await sha256File(archivePlanPath),
    verified_cut_count: verifiedCount,
    restored_cut_count: restoredCount,
    creative_prompt_hashes_match_cut_ledger: true,
    reference_ids_and_hashes_match_cut_ledger: true,
    raster_hashes_match_cut_ledger: true,
    provider_routes_preserved: true,
  },
  updated_at: new Date().toISOString(),
};
await writeJson(planPath, output);

const triagePath = path.join(
  episodeDir,
  "manual_blocker_triage_visual_prompt_harden_ep_01.json",
);
await writeJson(triagePath, {
  schema: "goldflow_manual_blocker_triage_v1",
  status: "resolved",
  stage: "visual_prompt_harden",
  resolution: "restore_exact_accepted_creative_contracts_after_timing_only_rebind",
  evidence_reviewed: output.timing_recovery,
  no_image_regeneration: true,
  updated_at: new Date().toISOString(),
});

console.log(JSON.stringify({
  status: "passed",
  output_path: planPath,
  triage_path: triagePath,
  verified_cut_count: verifiedCount,
  restored_cut_count: restoredCount,
}, null, 2));
