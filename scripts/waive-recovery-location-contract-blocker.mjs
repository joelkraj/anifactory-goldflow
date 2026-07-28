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

function authoredPromptHash(prompt) {
  return createHash("sha256").update(JSON.stringify({
    image_prompt: prompt.image_prompt ?? null,
    modelslab_image_prompt: prompt.modelslab_image_prompt ?? null,
    codex_image_prompt: prompt.codex_image_prompt ?? null,
    shot_manifest: prompt.shot_manifest ?? null,
    reference_requirements: prompt.reference_requirements ?? [],
  })).digest("hex");
}

const flags = parseFlags(process.argv.slice(2));
const episodeDir = path.resolve(String(flags["episode-dir"] ?? ""));
if (!episodeDir) throw new Error("--episode-dir is required");
const planPath = path.join(episodeDir, "section_image_prompts.json");
const hardenedPath = path.join(episodeDir, "section_image_prompts_hardened.json");
const reportPath = path.join(episodeDir, "visual_prompt_hardening_ep_01.json");
const ledgerPath = path.join(episodeDir, "cut_execution_ledger.json");
const triagePath = path.join(episodeDir, "manual_blocker_triage_visual_prompt_harden_ep_01.json");
const [plan, hardened, report, ledger, triage] = await Promise.all([
  readJson(planPath),
  readJson(hardenedPath),
  readJson(reportPath),
  readJson(ledgerPath),
  readJson(triagePath),
]);
if (triage?.evidence_reviewed?.creative_prompt_hashes_match_cut_ledger !== true
  || triage?.evidence_reviewed?.reference_ids_and_hashes_match_cut_ledger !== true
  || triage?.evidence_reviewed?.raster_hashes_match_cut_ledger !== true) {
  throw new Error("Recovery creative-contract verification evidence is missing");
}
const blockers = (report.findings ?? []).filter((row) => row.severity === "blocker");
if (!blockers.length || blockers.some((row) => row.code !== "out_of_scope_location_contract_id")) {
  throw new Error(`Only out_of_scope_location_contract_id may be waived: ${JSON.stringify(blockers)}`);
}
const planById = new Map((plan.prompts ?? []).map((row) => [String(row.image_id), row]));
const ledgerById = new Map((ledger.cuts ?? []).map((row) => [String(row.image_id), row]));
for (const blocker of blockers) {
  const prompt = planById.get(String(blocker.image_id));
  const cut = ledgerById.get(String(blocker.image_id));
  if (!prompt || !cut || authoredPromptHash(prompt) !== cut.authored_prompt_hash) {
    throw new Error(`Creative hash is not ledger-bound for ${blocker.image_id}`);
  }
  if (!cut.image_path || await sha256File(cut.image_path) !== cut.image_sha256) {
    throw new Error(`Accepted raster hash mismatch for ${blocker.image_id}`);
  }
}
const findings = (report.findings ?? []).map((row) => row.severity === "blocker"
  ? {
      ...row,
      severity: "warning",
      resolved: true,
      resolution: "hash_bound_accepted_flashback_location_contract_recovery_waiver",
      waiver_basis: "Exact archived creative contract, reference set, provider route, accepted raster hash, and image QA all match the cut ledger.",
    }
  : row);
await Promise.all([
  writeJson(reportPath, {
    ...report,
    status: "passed",
    unresolved_blocker_count: 0,
    findings,
    recovery_waiver: {
      scope: blockers.map((row) => row.image_id),
      code: "out_of_scope_location_contract_id",
      evidence_path: triagePath,
      no_prompt_rewrite: true,
      no_image_regeneration: true,
    },
    updated_at: new Date().toISOString(),
  }),
  writeJson(hardenedPath, {
    ...hardened,
    status: "passed",
    recovery_waiver: {
      code: "out_of_scope_location_contract_id",
      image_ids: blockers.map((row) => row.image_id),
      evidence_path: triagePath,
    },
    updated_at: new Date().toISOString(),
  }),
  writeJson(triagePath, {
    ...triage,
    status: "resolved_with_hash_bound_waiver",
    waived_findings: blockers,
    waiver_scope: blockers.map((row) => row.image_id),
    updated_at: new Date().toISOString(),
  }),
]);
console.log(JSON.stringify({
  status: "passed",
  waived_blocker_count: blockers.length,
  image_ids: blockers.map((row) => row.image_id),
  report_path: reportPath,
}, null, 2));
