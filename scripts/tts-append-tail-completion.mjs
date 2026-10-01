#!/usr/bin/env node

// Recover exact low-energy Qwen raw tails without a model call. Every original
// PCM sample remains byte-identical; only a bounded zero tail is appended.
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendOnlySilentTailForTests, APPEND_ONLY_TAIL_MODE,
  pcm16MonoWavFactsForTests, validateAppendOnlyTailScopeForTests,
  verifyAppendOnlyTailSelection,
} from "./lib/narration-append-only-tail.mjs";
import {
  narrationProviderOutputManifestSha256, narrationSynthesisIdentitySha256,
  validateNarrationProviderOutputManifest,
} from "./lib/narration-provider-adapter.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = async (name) => JSON.parse(await fs.readFile(name, "utf8"));
const fileHash = async (name) => hash(await fs.readFile(name));
const inside = (root, name) => path.isAbsolute(String(name ?? ""))
  && path.resolve(name).startsWith(`${path.resolve(root)}${path.sep}`);
async function writeNew(name, bytes) {
  await fs.mkdir(path.dirname(name), { recursive: true });
  try { await fs.writeFile(name, bytes, { flag: "wx" }); }
  catch (error) {
    if (error?.code !== "EEXIST"
      || !(await fs.readFile(name)).equals(Buffer.from(bytes))) throw error;
  }
}
function parseFlags(parts) {
  const flags = {};
  for (let i = 0; i < parts.length; i += 2) {
    if (!parts[i]?.startsWith("--") || !parts[i + 1]
      || parts[i + 1].startsWith("--") || flags[parts[i].slice(2)]) {
      throw new Error("Append-only tail command requires unique flag/value pairs.");
    }
    flags[parts[i].slice(2)] = parts[i + 1];
  }
  if (Object.keys(flags).sort().join(",") !== "episode-dir,evidence") {
    throw new Error("Usage: goldflow tts complete-tail --episode-dir <dir> --evidence <reviewed.json>");
  }
  return flags;
}

export async function completeAppendOnlyTail(parts = process.argv.slice(2)) {
  const flags = parseFlags(parts);
  const episodeDir = path.resolve(flags["episode-dir"]);
  const evidencePath = path.resolve(flags.evidence);
  const episode = path.basename(episodeDir);
  if (!inside(episodeDir, evidencePath)) throw new Error("Tail evidence must be episode-local.");
  const paths = {
    identity: path.join(episodeDir, "run_identity.json"),
    script: path.join(episodeDir, "script_clean.md"),
    plan: path.join(episodeDir, "narration_generation_plan.json"),
    report: path.join(episodeDir, `narration_tts_report_${episode}.json`),
    delivery: path.join(episodeDir, `narration_unit_delivery_qa_${episode}.json`),
  };
  const [identity, plan, report, delivery, evidence] = await Promise.all([
    readJson(paths.identity), readJson(paths.plan), readJson(paths.report),
    readJson(paths.delivery), readJson(evidencePath),
  ]);
  const manifestPath = report.provider_output_manifest_path;
  if (!inside(episodeDir, manifestPath)) throw new Error("Report-bound provider manifest escaped the episode.");
  const manifest = await readJson(manifestPath);
  const hashes = {
    identity: await fileHash(paths.identity), script: await fileHash(paths.script),
    plan: await fileHash(paths.plan), report: await fileHash(paths.report),
    delivery: await fileHash(paths.delivery), manifest: await fileHash(manifestPath),
    evidence: await fileHash(evidencePath),
  };
  if (identity?.tts_provider !== "qwen_local"
    || hashes.script !== report.source_script_hash
    || evidence.run_identity_file_sha256 !== hashes.identity
    || manifest.manifest_sha256 !== narrationProviderOutputManifestSha256(manifest)
    || validateNarrationProviderOutputManifest(manifest, plan.units, {
      generationPlanSha256: plan.plan_sha256,
      generationPlanFileSha256: hashes.plan,
      qualityContractSha256: manifest.narration_quality_contract_sha256,
      provider: "qwen_local", voiceId: manifest.voice_id,
      voiceSha256: manifest.voice_sha256,
    }).status !== "passed") {
    throw new Error("Tail completion source, identity, or provider manifest is stale.");
  }
  const sourceBytes = new Map(), audioFacts = {};
  const byId = new Map(manifest.units.map((row) => [row.unit_id, row]));
  for (const row of manifest.units) {
    if (!inside(episodeDir, row.audio_path)
      || await fileHash(row.audio_path) !== row.audio_sha256) {
      throw new Error(`Tail completion found a changed selected WAV: ${row.unit_id}.`);
    }
  }
  for (const row of evidence.units ?? []) {
    const selected = byId.get(row.unit_id);
    if (!selected) throw new Error(`Unknown tail completion unit ${row.unit_id}.`);
    const bytes = await fs.readFile(selected.audio_path);
    sourceBytes.set(row.unit_id, bytes);
    audioFacts[row.unit_id] = pcm16MonoWavFactsForTests(bytes);
  }
  const scope = validateAppendOnlyTailScopeForTests({
    evidence, episodeDir, report, delivery, manifest, plan, hashes, audioFacts,
  });
  const request = {
    schema: "goldflow_narration_append_only_tail_request_v1",
    episode_dir: episodeDir,
    source_script_sha256: hashes.script,
    plan_sha256: plan.plan_sha256,
    plan_file_sha256: hashes.plan,
    identity_file_sha256: hashes.identity,
    prior_report_file_sha256: hashes.report,
    prior_delivery_file_sha256: hashes.delivery,
    prior_manifest_file_sha256: hashes.manifest,
    evidence_path: evidencePath,
    evidence_file_sha256: hashes.evidence,
    unit_ids: scope.selected_unit_ids,
    preserved_blocked_unit_ids: scope.preserved_blocked_unit_ids,
    pad_sample_count_by_unit: Object.fromEntries(evidence.units.map((row) =>
      [row.unit_id, row.pad_sample_count])),
  };
  const requestBytes = Buffer.from(`${JSON.stringify(request, null, 2)}\n`);
  const requestSha = hash(requestBytes);
  const repairDir = path.join(episodeDir,
    "assets/audio/narration_tts/append_only_tail_completions", requestSha);
  const requestPath = path.join(repairDir, "request.json");
  const resultPath = path.join(repairDir, "result.json");
  const nextManifestPath = path.join(repairDir, "provider-output-manifest.json");
  await writeNew(requestPath, requestBytes);
  for (const [name, from] of [
    ["prior_manifest.json", manifestPath], ["prior_report.json", paths.report],
    ["prior_delivery.json", paths.delivery], ["evidence.json", evidencePath],
  ]) await writeNew(path.join(repairDir, name), await fs.readFile(from));

  const results = [];
  for (const selected of evidence.units) {
    const old = byId.get(selected.unit_id);
    const bytes = appendOnlySilentTailForTests(
      sourceBytes.get(selected.unit_id), selected.pad_sample_count);
    const outputSha = hash(bytes);
    const outputPath = path.join(repairDir, "units", `${selected.unit_id}-${outputSha.slice(0, 24)}.wav`);
    await writeNew(outputPath, bytes);
    results.push({ unit_id: selected.unit_id, source_audio_path: old.audio_path,
      source_audio_sha256: old.audio_sha256, output_audio_path: outputPath,
      output_audio_sha256: outputSha,
      source_sample_count: audioFacts[selected.unit_id].sample_count,
      output_sample_count: audioFacts[selected.unit_id].sample_count + selected.pad_sample_count,
      pad_sample_count: selected.pad_sample_count });
  }
  const result = { schema: "goldflow_narration_append_only_tail_result_v1",
    status: "passed", request_path: requestPath, request_file_sha256: requestSha,
    units: results, preserved_unit_count: scope.preserved_unit_count,
    preserved_blocked_unit_ids: scope.preserved_blocked_unit_ids };
  const resultBytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`);
  const resultSha = hash(resultBytes);
  await writeNew(resultPath, resultBytes);

  const next = structuredClone(manifest);
  const resultsById = new Map(results.map((row) => [row.unit_id, row]));
  for (const row of next.units) {
    const replacement = resultsById.get(row.unit_id);
    if (!replacement) continue;
    const old = byId.get(row.unit_id);
    const synthesisIdentity = {
      schema: "goldflow_narration_append_only_tail_identity_v1",
      provider: row.provider, model_id: row.model_id,
      model_revision: row.model_revision, voice_id: row.voice_id,
      voice_sha256: row.voice_sha256,
      voice_continuity_contract: row.voice_continuity_contract,
      unit_id: row.unit_id, spoken_text_sha256: row.spoken_text_sha256,
      source_synthesis_identity_sha256: old.synthesis_identity_sha256,
      source_audio_sha256: old.audio_sha256,
      output_audio_sha256: replacement.output_audio_sha256,
      pad_sample_count: replacement.pad_sample_count,
      request_file_sha256: requestSha,
    };
    Object.assign(row, {
      audio_path: replacement.output_audio_path,
      audio_sha256: replacement.output_audio_sha256,
      duration_sec: replacement.output_sample_count / 24000,
      synthesis_mode: APPEND_ONLY_TAIL_MODE,
      recovery_provenance: {
        schema: "goldflow_narration_append_only_tail_provenance_v1",
        request_path: requestPath, request_file_sha256: requestSha,
        result_path: resultPath, result_file_sha256: resultSha,
        source_audio_sha256: old.audio_sha256,
        source_synthesis_identity_sha256: old.synthesis_identity_sha256,
        pad_sample_count: replacement.pad_sample_count,
        human_listening_performed: false,
        audio_synthesis_performed: false,
      },
      synthesis_identity: synthesisIdentity,
      synthesis_identity_sha256: narrationSynthesisIdentitySha256(synthesisIdentity),
      runner_report_path: resultPath, runner_report_sha256: resultSha,
      provider_receipt: null, provider_unit_qa: null,
      provider_unit_qa_sha256: null,
    });
  }
  next.provider_execution = { ...next.provider_execution,
    append_only_tail_completion: { request_file_sha256: requestSha,
      result_file_sha256: resultSha, repaired_unit_ids: scope.selected_unit_ids,
      preserved_unit_count: scope.preserved_unit_count } };
  next.repair_history = [...(next.repair_history ?? []), {
    mode: APPEND_ONLY_TAIL_MODE,
    prior_manifest_file_sha256: hashes.manifest,
    request_path: requestPath, request_file_sha256: requestSha,
    result_path: resultPath, result_file_sha256: resultSha,
    evidence_path: evidencePath, evidence_file_sha256: hashes.evidence,
    output_manifest_path: nextManifestPath,
  }];
  delete next.manifest_sha256;
  next.validation = validateNarrationProviderOutputManifest(next, plan.units, {
    generationPlanSha256: plan.plan_sha256,
    generationPlanFileSha256: hashes.plan,
    qualityContractSha256: manifest.narration_quality_contract_sha256,
    provider: "qwen_local", voiceId: manifest.voice_id,
    voiceSha256: manifest.voice_sha256,
  });
  next.status = next.validation.status;
  if (next.status !== "passed") {
    throw new Error(`Append-only tail derived manifest is invalid: ${JSON.stringify(next.validation.findings)}`);
  }
  next.manifest_sha256 = narrationProviderOutputManifestSha256(next);
  await writeNew(nextManifestPath, `${JSON.stringify(next, null, 2)}\n`);
  await verifyAppendOnlyTailSelection({ episodeDir, report,
    manifest: next, plan, expectedManifestPath: nextManifestPath });
  process.stdout.write(`${JSON.stringify({ status: "passed_no_synthesis",
    manifest_path: nextManifestPath,
    repaired_unit_ids: scope.selected_unit_ids,
    preserved_blocked_unit_ids: scope.preserved_blocked_unit_ids })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  completeAppendOnlyTail().catch((error) => {
    console.error(error.stack ?? String(error)); process.exitCode = 1;
  });
}
