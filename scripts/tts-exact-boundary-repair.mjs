#!/usr/bin/env node

// Guarded, exact-unit sentence-boundary recovery for persistent second-take
// Qwen defects. Existing WAVs and prior reports remain immutable evidence.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  narrationProviderOutputManifestSha256,
  narrationSynthesisIdentitySha256,
  validateNarrationProviderOutputManifest,
} from "./lib/narration-provider-adapter.mjs";
import { transcriptQaForTests } from "./modelslab-qwen-episode-audio.mjs";
import { adjudicateNarrationDeliveryConsensus } from "./lib/narration-delivery-quality.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PYTHON = "/Users/joel/AniFactoryData/voice_bank/bakeoff/.venv-kokoro-mlx-audio-0.4.6/bin/python";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fileHash = async (name) => hash(await fs.readFile(name));
const json = async (name) => JSON.parse(await fs.readFile(name, "utf8"));
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value;
const canonicalHash = (value) => hash(JSON.stringify(canonical(value)));
const sameIds = (left, right) => Array.isArray(left) && Array.isArray(right)
  && left.length === right.length
  && new Set(left).size === left.length
  && new Set(right).size === right.length
  && [...left].sort().join("\n") === [...right].sort().join("\n");
const sameCodes = sameIds;
const blockerKeys = (rows) => (rows ?? [])
  .filter((row) => row?.unit_id && row?.code)
  .map((row) => `${row.unit_id}|${row.code}`);

function flags(parts) {
  const result = {};
  for (let i = 0; i < parts.length; i += 2) {
    if (!parts[i]?.startsWith("--") || parts[i + 1]?.startsWith("--") || !parts[i + 1]) {
      throw new Error("Expected explicit --flag value pairs.");
    }
    result[parts[i].slice(2)] = parts[i + 1];
  }
  return result;
}

async function writeNew(name, content) {
  await fs.mkdir(path.dirname(name), { recursive: true });
  try {
    await fs.writeFile(name, content, { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST" || (await fs.readFile(name)).toString() !== content.toString()) {
      throw error;
    }
  }
}

async function run(command, args, { cwd = DIR } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk.toString(); });
    child.stderr.on("data", (chunk) => { err += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ out, err })
      : reject(new Error(`${command} exited ${code}: ${err.slice(-6000)} ${out.slice(-2000)}`)));
  });
}

export function validateBoundaryRepairScopeForTests({ plan, manifest, delivery,
  fullStream = null, report = null, spec, fileHashes = {} }) {
  const units = plan?.units ?? [];
  const unitById = new Map(units.map((row) => [row.unit_id, row]));
  const manifestById = new Map((manifest?.units ?? []).map((row) => [row.unit_id, row]));
  const deliveryById = new Map((delivery?.units ?? []).map((row) => [row.unit_id, row]));
  const blockedFullStream = fullStream?.status === "blocked" ? fullStream : null;
  const fullStreamIds = new Set((blockedFullStream?.blockers ?? [])
    .filter((row) => row.severity === "blocker" && row.unit_id)
    .map((row) => row.unit_id));
  const subset = spec?.schema === "goldflow_tts_exact_boundary_repair_spec_v2";
  if (!["goldflow_tts_exact_boundary_repair_spec_v1",
    "goldflow_tts_exact_boundary_repair_spec_v2"].includes(spec?.schema)
    || manifest?.status !== "passed"
    || (delivery?.status !== "blocked" && !fullStreamIds.size)
    || !Array.isArray(spec.units) || spec.units.length === 0) {
    throw new Error("Repair requires a blocked unit-delivery report and a valid exact spec.");
  }
  const blockedIds = [...new Set((delivery?.units ?? [])
    .filter((row) => row.decision?.status === "blocked")
    .map((row) => row.unit_id))];
  const qaBlockers = (delivery?.units ?? []).flatMap((row) =>
    (row.decision?.blockers ?? []).map((blocker) => ({
      unit_id: row.unit_id, code: blocker.code,
    })));
  if (subset && (blockedFullStream
    || report?.status !== "blocked"
    || report?.unit_qa_status !== "blocked"
    || report?.full_stream_qa_status !== "not_run_due_to_unit_blockers"
    || !Array.isArray(spec.blocked_unit_ids)
    || !Array.isArray(spec.preserved_blocked_unit_ids)
    || !sameIds(spec.blocked_unit_ids, blockedIds)
    || !sameIds(spec.blocked_unit_ids, [...new Set((report.blockers ?? [])
      .map((row) => row.unit_id))])
    || !sameIds(blockerKeys(qaBlockers), blockerKeys(delivery.blockers))
    || !sameIds(blockerKeys(qaBlockers), blockerKeys(report.blockers))
    || spec.source_script_sha256 !== report.source_script_hash
    || spec.narration_generation_plan_sha256 !== plan.plan_sha256
    || spec.narration_generation_plan_file_sha256 !== fileHashes.plan
    || spec.prior_report_file_sha256 !== fileHashes.report
    || spec.prior_delivery_file_sha256 !== fileHashes.delivery
    || spec.prior_manifest_file_sha256 !== fileHashes.manifest
    || report.provider_output_manifest_sha256 !== fileHashes.manifest)) {
    throw new Error("Subset boundary repair lacks exact blocked-report and manifest bindings.");
  }
  const selected = new Set();
  for (const entry of spec.units) {
    const unit = unitById.get(entry.unit_id);
    const output = manifestById.get(entry.unit_id);
    const qa = deliveryById.get(entry.unit_id);
    if (!unit || !output || !qa || selected.has(entry.unit_id)
      || (qa.decision?.status !== "blocked" && !fullStreamIds.has(entry.unit_id))
      || !Array.isArray(entry.fragments) || entry.fragments.length < 2
      || entry.fragments.some((part) => typeof part !== "string" || !part.trim())
      || entry.fragments.join(" ") !== unit.spoken_text
      || output.audio_sha256 !== qa.audio_sha256
      || (!qa.decision.blockers?.length && !fullStreamIds.has(entry.unit_id))
      || subset && (entry.spoken_text_sha256 !== unit.spoken_text_sha256
        || !sameCodes(entry.reviewed_blocker_codes,
          qa.decision.blockers.map((row) => row.code))
        || String(entry.review_reason ?? "").trim().length < 35)) {
      throw new Error(`Exact-boundary repair scope is not current: ${entry.unit_id}`);
    }
    selected.add(entry.unit_id);
  }
  const otherBlocked = (delivery?.units ?? []).filter((row) =>
    row.decision?.status === "blocked" && !selected.has(row.unit_id));
  if (subset) {
    const preservedBlocked = otherBlocked.map((row) => row.unit_id);
    if (!sameIds(spec.preserved_blocked_unit_ids, preservedBlocked)) {
      throw new Error("Subset boundary repair does not preserve every unselected blocker.");
    }
    return { selected: [...selected], orthographic: [], preservedBlocked };
  }
  for (const unitId of fullStreamIds) {
    if (!selected.has(unitId)) throw new Error(`Unrepaired full-stream blocker remains: ${unitId}`);
  }
  for (const row of otherBlocked) {
    // Re-adjudicate the retained dual-ASR evidence with the corrected
    // orthographic comparator. Advisory interior substitutions remain
    // advisory; confirmed edge loss and omitted spans still stop.
    if (!row.primary_recognized_text || !row.confirmation_recognized_text) {
      throw new Error(`Other blocked unit lacks dual ASR: ${row.unit_id}`);
    }
    const compare = (recognized) => transcriptQaForTests(row.intended_text, recognized, {
      blockAnySubstitution: false,
    });
    const refreshed = adjudicateNarrationDeliveryConsensus({
      primaryTranscriptQa: compare(row.primary_recognized_text),
      confirmationTranscriptQa: compare(row.confirmation_recognized_text),
      contract: plan.narration_quality_contract,
    });
    if (refreshed.blockers.length) {
      throw new Error(`Other blocked unit still has a substantive defect: ${row.unit_id}`);
    }
  }
  return { selected: [...selected], orthographic: otherBlocked.map((row) => row.unit_id) };
}

export function validateSubsetBoundaryFinalizationForTests({
  priorManifest, derivedManifest, priorDelivery, finalDelivery, priorReport, finalReport,
  repairedUnitIds, preservedBlockedUnitIds,
} = {}) {
  const repaired = new Set(repairedUnitIds ?? []);
  const priorById = new Map((priorManifest?.units ?? []).map((row) => [row.unit_id, row]));
  const finalById = new Map((derivedManifest?.units ?? []).map((row) => [row.unit_id, row]));
  const oldQaById = new Map((priorDelivery?.units ?? []).map((row) => [row.unit_id, row]));
  const newQaById = new Map((finalDelivery?.units ?? []).map((row) => [row.unit_id, row]));
  const oldResultById = new Map((priorReport?.results ?? []).map((row) => [row.unit_id, row]));
  const newResultById = new Map((finalReport?.results ?? []).map((row) => [row.unit_id, row]));
  if (!sameIds([...priorById.keys()], [...finalById.keys()])
    || !sameIds([...oldQaById.keys()], [...newQaById.keys()])
    || !sameIds([...oldResultById.keys()], [...newResultById.keys()])
    || !sameIds([...priorById.keys()], [...oldResultById.keys()])
    || !sameIds([...priorById.keys()], [...oldQaById.keys()])
    || !sameIds(preservedBlockedUnitIds, (priorDelivery?.units ?? [])
      .filter((row) => row.decision?.status === "blocked" && !repaired.has(row.unit_id))
      .map((row) => row.unit_id))
    || !sameIds(blockerKeys(finalDelivery?.blockers), blockerKeys(finalReport?.blockers))
    || finalReport?.provider_output_manifest_sha256 !== hash(JSON.stringify(derivedManifest,
      null, 2) + "\n")
    || finalReport?.selected_unit_count !== priorById.size) {
    throw new Error("Subset boundary finalization changed scope or manifest binding.");
  }
  for (const id of priorById.keys()) {
    if (repaired.has(id)) continue;
    const old = priorById.get(id);
    const current = finalById.get(id);
    const oldQa = oldQaById.get(id);
    const newQa = newQaById.get(id);
    const oldResult = oldResultById.get(id);
    const newResult = newResultById.get(id);
    if (JSON.stringify(old) !== JSON.stringify(current)
      || oldQa?.audio_sha256 !== newQa?.audio_sha256
      || oldQa?.audio_path !== newQa?.audio_path
      || oldResult?.audio_path !== newResult?.audio_path
      || oldResult?.audio_sha256 !== newResult?.audio_sha256
      || oldResult?.attempt !== newResult?.attempt
      || oldQa?.decision?.status !== newQa?.decision?.status
      || !sameCodes((oldQa?.decision?.blockers ?? []).map((row) => row.code),
        (newQa?.decision?.blockers ?? []).map((row) => row.code))) {
      throw new Error(`Subset boundary finalization changed an unrequested unit: ${id}.`);
    }
  }
  if (preservedBlockedUnitIds.length
    && (finalReport?.status !== "blocked" || finalDelivery?.status !== "blocked"
      || finalReport.full_stream_qa_status !== "not_run_due_to_unit_blockers")) {
    throw new Error("Subset boundary finalization ran full-stream QA while blockers remained.");
  }
  return { preserved_blocked_unit_count: preservedBlockedUnitIds.length };
}

export async function main(parts = process.argv.slice(2)) {
  const options = flags(parts);
  const episodeDir = path.resolve(options["episode-dir"] ?? "");
  const specPath = path.resolve(options.spec ?? "");
  if (!options["episode-dir"] || !options.spec || options["workflow-bypass"]) {
    throw new Error("Usage: goldflow tts repair-boundary --episode-dir <dir> --spec <reviewed.json>");
  }
  if (!specPath.startsWith(`${episodeDir}${path.sep}`)) {
    throw new Error("Exact boundary repair spec must be inside the episode directory.");
  }
  const status = await run("node", ["bin/goldflow.mjs", "run", "status", "--episode-dir", episodeDir, "--format", "markdown"], { cwd: path.resolve(DIR, "..") });
  if (!status.out.includes("Current stage: qwen_tts_stitch")
    || !status.out.includes("tts repair-boundary")) {
    throw new Error("Goldflow status does not authorize exact-boundary repair here.");
  }
  const episode = path.basename(episodeDir);
  const planPath = path.join(episodeDir, "narration_generation_plan.json");
  const identityPath = path.join(episodeDir, "run_identity.json");
  const reportPath = path.join(episodeDir, `narration_tts_report_${episode}.json`);
  const report = await json(reportPath);
  const manifestPath = path.resolve(report.provider_output_manifest_path
    ?? path.join(episodeDir, `narration_provider_output_manifest_${episode}.json`));
  if (!manifestPath.startsWith(`${episodeDir}${path.sep}`)) {
    throw new Error("Prior provider manifest path escaped the episode directory.");
  }
  const deliveryPath = path.join(episodeDir, `narration_unit_delivery_qa_${episode}.json`);
  const fullStreamPath = path.join(episodeDir, `narration_full_stream_qa_${episode}.json`);
  const [plan, identity, manifest, delivery, fullStreamCandidate, spec] = await Promise.all([
    json(planPath), json(identityPath), json(manifestPath), json(deliveryPath),
    fs.readFile(fullStreamPath, "utf8").then(JSON.parse).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    }), json(specPath),
  ]);
  // A prior unit-QA attempt may leave a full-stream placeholder with stale
  // blockers. Only an actually blocked full-stream result is repair evidence.
  const fullStream = fullStreamCandidate?.status === "blocked" ? fullStreamCandidate : null;
  if (identity.tts_provider !== "qwen_local"
    || manifest.provider !== "qwen_local"
    || report.status !== "blocked"
    || report.provider_output_manifest_sha256 !== await fileHash(manifestPath)
    || manifest.manifest_sha256 !== narrationProviderOutputManifestSha256(manifest)) {
    throw new Error("Locked Qwen identity or prior report binding is stale.");
  }
  const validated = validateNarrationProviderOutputManifest(manifest, plan.units, {
    generationPlanSha256: plan.plan_sha256,
    generationPlanFileSha256: await fileHash(planPath),
    qualityContractSha256: manifest.narration_quality_contract_sha256,
    provider: "qwen_local", voiceId: manifest.voice_id,
    voiceSha256: manifest.voice_sha256,
  });
  if (validated.status !== "passed") throw new Error("Prior provider manifest is invalid.");
  if (fullStream && (fullStream.source_script_hash !== report.source_script_hash
    || fullStream.provider_output_manifest_file_sha256 !== await fileHash(manifestPath)
    || report.full_stream_qa_path !== fullStreamPath)) {
    throw new Error("Full-stream blocker evidence is stale.");
  }
  const scope = validateBoundaryRepairScopeForTests({ plan, manifest, delivery,
    fullStream, report, spec,
    fileHashes: { plan: await fileHash(planPath), report: await fileHash(reportPath),
      delivery: await fileHash(deliveryPath), manifest: await fileHash(manifestPath) } });
  const unitById = new Map(plan.units.map((row) => [row.unit_id, row]));
  const priorById = new Map(manifest.units.map((row) => [row.unit_id, row]));
  for (const row of manifest.units) {
    if (await fileHash(row.audio_path) !== row.audio_sha256) {
      throw new Error(`Prior unit audio changed: ${row.unit_id}`);
    }
  }
  const request = {
    schema: "goldflow_tts_exact_boundary_repair_request_v1",
    episode_dir: episodeDir,
    identity_sha256: await fileHash(identityPath),
    plan_sha256: plan.plan_sha256,
    plan_file_sha256: await fileHash(planPath),
    prior_manifest_sha256: manifest.manifest_sha256,
    prior_manifest_path: manifestPath,
    prior_manifest_file_sha256: await fileHash(manifestPath),
    prior_delivery_file_sha256: await fileHash(deliveryPath),
    ...(fullStream ? { prior_full_stream_file_sha256: await fileHash(fullStreamPath) } : {}),
    prior_report_file_sha256: await fileHash(reportPath),
    spec_path: specPath,
    spec_file_sha256: await fileHash(specPath),
    model_id: manifest.model_id, model_revision: manifest.model_revision,
    voice_id: manifest.voice_id, voice_sha256: manifest.voice_sha256,
    voice_continuity_contract: manifest.voice_continuity_contract,
    units: spec.units.map((entry) => ({
      unit_id: entry.unit_id,
      spoken_text: unitById.get(entry.unit_id).spoken_text,
      spoken_text_sha256: unitById.get(entry.unit_id).spoken_text_sha256,
      prior_audio_sha256: priorById.get(entry.unit_id).audio_sha256,
      prior_synthesis_identity_sha256: priorById.get(entry.unit_id).synthesis_identity_sha256,
      prior_blocker_codes: [
        ...delivery.units.find((row) => row.unit_id === entry.unit_id).decision.blockers.map((row) => row.code),
        ...(fullStream?.blockers ?? []).filter((row) => row.unit_id === entry.unit_id).map((row) => row.code),
      ],
      fragments: entry.fragments,
    })),
    orthographic_equivalence_unit_ids: scope.orthographic,
    ...(spec.schema === "goldflow_tts_exact_boundary_repair_spec_v2"
      ? { repair_scope_schema: spec.schema,
        preserved_blocked_unit_ids: scope.preservedBlocked } : {}),
  };
  request.request_sha256 = canonicalHash(request);
  const repairDir = path.join(episodeDir, "assets/audio/narration_tts/exact_boundary_repairs", request.request_sha256);
  const requestPath = path.join(repairDir, "request.json");
  await writeNew(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  for (const [name, original] of [["prior_manifest.json", manifestPath], ["prior_delivery.json", deliveryPath], ["prior_report.json", reportPath], ...(fullStream ? [["prior_full_stream.json", fullStreamPath]] : [])]) {
    await writeNew(path.join(repairDir, name), await fs.readFile(original));
  }
  if (options["dry-run"] === "true") {
    process.stdout.write(`${JSON.stringify({ status: "validated_no_synthesis", request_path: requestPath,
      repair_dir: repairDir, repaired_unit_ids: scope.selected,
      orthographic_equivalence_unit_ids: scope.orthographic,
      preserved_blocked_unit_ids: scope.preservedBlocked ?? [] })}\n`);
    return;
  }
  await run(PYTHON, [path.join(DIR, "tts-exact-boundary-repair.py"), "--request", requestPath, "--output-dir", repairDir]);
  const resultPath = path.join(repairDir, "repair-result.json");
  const result = await json(resultPath);
  if (result.request_sha256 !== request.request_sha256
    || result.units.length !== request.units.length) {
    throw new Error("Boundary repair result does not bind the request.");
  }
  const next = structuredClone(manifest);
  const resultById = new Map(result.units.map((row) => [row.unit_id, row]));
  for (const row of next.units) {
    const replacement = resultById.get(row.unit_id);
    if (!replacement) continue;
    const prior = priorById.get(row.unit_id);
    if (replacement.spoken_text_sha256 !== row.spoken_text_sha256
      || await fileHash(replacement.audio_path) !== replacement.audio_sha256
      || replacement.fragments.length !== request.units.find((unit) => unit.unit_id === row.unit_id).fragments.length) {
      throw new Error(`Boundary repair output is stale for ${row.unit_id}`);
    }
    const synthesisIdentity = {
      schema: "goldflow_tts_exact_boundary_composite_identity_v1",
      provider: manifest.provider, model_id: manifest.model_id,
      model_revision: manifest.model_revision,
      voice_id: manifest.voice_id, voice_sha256: manifest.voice_sha256,
      voice_continuity_contract: manifest.voice_continuity_contract,
      unit_id: row.unit_id, spoken_text_sha256: row.spoken_text_sha256,
      request_sha256: request.request_sha256,
      prior_audio_sha256: prior.audio_sha256,
      prior_synthesis_identity_sha256: prior.synthesis_identity_sha256,
      fragments: replacement.fragments.map((part) => ({
        text_sha256: part.text_sha256,
        audio_sha256: part.audio_sha256,
        sidecar_sha256: part.sidecar_sha256,
      })),
      composite_audio_sha256: replacement.audio_sha256,
    };
    Object.assign(row, {
      audio_path: replacement.audio_path,
      audio_sha256: replacement.audio_sha256,
      duration_sec: replacement.duration_sec,
      token_limit_reached: false,
      synthesis_mode: "exact_sentence_boundary_composite_v1",
      generated_token_count: replacement.fragments.reduce((sum, part) => sum + part.generated_token_count, 0),
      recovery_provenance: {
        schema: "goldflow_tts_exact_boundary_repair_provenance_v1",
        request_path: requestPath, request_sha256: request.request_sha256,
        result_path: resultPath, result_sha256: await fileHash(resultPath),
        prior_audio_sha256: prior.audio_sha256,
        prior_synthesis_identity_sha256: prior.synthesis_identity_sha256,
      },
      synthesis_identity: synthesisIdentity,
      synthesis_identity_sha256: narrationSynthesisIdentitySha256(synthesisIdentity),
      runner_report_path: resultPath,
      runner_report_sha256: await fileHash(resultPath),
      provider_receipt: null,
      provider_unit_qa: null,
      provider_unit_qa_sha256: null,
    });
  }
  next.provider_execution = {
    ...next.provider_execution,
    exact_boundary_repair: {
      request_sha256: request.request_sha256,
      result_sha256: await fileHash(resultPath),
      repaired_unit_ids: scope.selected,
      preserved_unit_count: next.units.length - scope.selected.length,
    },
  };
  next.repair_history = [...(next.repair_history ?? []), {
    mode: "exact_sentence_boundary_composite_v1",
    prior_manifest_sha256: manifest.manifest_sha256,
    request_sha256: request.request_sha256,
  }];
  delete next.manifest_sha256;
  next.validation = validateNarrationProviderOutputManifest(next, plan.units, {
    generationPlanSha256: plan.plan_sha256,
    generationPlanFileSha256: await fileHash(planPath),
    qualityContractSha256: manifest.narration_quality_contract_sha256,
    provider: "qwen_local", voiceId: manifest.voice_id,
    voiceSha256: manifest.voice_sha256,
  });
  next.status = next.validation.status;
  if (next.status !== "passed") throw new Error(`Derived provider manifest invalid: ${JSON.stringify(next.validation.findings)}`);
  next.manifest_sha256 = narrationProviderOutputManifestSha256(next);
  const nextManifestPath = path.join(repairDir, "provider-output-manifest.json");
  await writeNew(nextManifestPath, `${JSON.stringify(next, null, 2)}\n`);
  const { finalizeNarrationProviderOutput } = await import("./narration-provider-output-finalize.mjs");
  let finalizationError = null;
  try {
    await finalizeNarrationProviderOutput(["--episode-dir", episodeDir,
      "--plan", planPath, "--manifest", nextManifestPath,
      ...(scope.preservedBlocked?.length ? ["--require-unit-blockers", "true"] : [])]);
  } catch (error) {
    finalizationError = error;
  }
  if (spec.schema === "goldflow_tts_exact_boundary_repair_spec_v2") {
    if (finalizationError
      && !/^Provider-neutral delivery QA blocked \d+ unit\(s\)\.$/u.test(
        String(finalizationError.message))) throw finalizationError;
    const [finalDelivery, finalReport] = await Promise.all([
      json(deliveryPath), json(reportPath),
    ]);
    validateSubsetBoundaryFinalizationForTests({
      priorManifest: manifest, derivedManifest: next,
      priorDelivery: delivery, finalDelivery, priorReport: report, finalReport,
      repairedUnitIds: scope.selected,
      preservedBlockedUnitIds: scope.preservedBlocked,
    });
  }
  if (finalizationError) throw finalizationError;
  process.stdout.write(`${JSON.stringify({ status: "passed", repair_dir: repairDir,
    repaired_unit_ids: scope.selected, orthographic_equivalence_unit_ids: scope.orthographic,
    preserved_blocked_unit_ids: scope.preservedBlocked ?? [],
    manifest_path: nextManifestPath })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.stack ?? String(error)); process.exitCode = 1; });
}
