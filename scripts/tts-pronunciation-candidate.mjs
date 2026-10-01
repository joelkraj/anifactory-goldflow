#!/usr/bin/env node

// One user-heard, one-word pronunciation candidate. This command spends one
// Qwen fragment only; the result is not selected until the user listens again.
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
import {
  PRONUNCIATION_REQUEST_SCHEMA, PRONUNCIATION_RESULT_SCHEMA,
  PRONUNCIATION_MODE, validatePronunciationDefectEvidenceForTests,
} from "./lib/narration-pronunciation-repair.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PYTHON = "/Users/joel/AniFactoryData/voice_bank/bakeoff/.venv-kokoro-mlx-audio-0.4.6/bin/python";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const fileHash = async (name) => sha(await fs.readFile(name));
const read = async (name) => JSON.parse(await fs.readFile(name, "utf8"));
const within = (root, target) => typeof target === "string" && path.isAbsolute(target)
  && path.resolve(target).startsWith(`${path.resolve(root)}${path.sep}`);
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value;
const canonicalHash = (value) => sha(JSON.stringify(canonical(value)));

function flags(parts) {
  const result = {};
  for (let i = 0; i < parts.length; i += 2) {
    if (!parts[i]?.startsWith("--") || !parts[i + 1] || parts[i + 1].startsWith("--")) {
      throw new Error("Expected explicit --flag value pairs.");
    }
    result[parts[i].slice(2)] = parts[i + 1];
  }
  return result;
}

async function writeNew(name, content) {
  await fs.mkdir(path.dirname(name), { recursive: true });
  try { await fs.writeFile(name, content, { flag: "wx" }); }
  catch (error) {
    if (error?.code !== "EEXIST" || (await fs.readFile(name)).toString() !== content.toString()) {
      throw error;
    }
  }
}

async function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; let err = "";
    child.stdout.on("data", (data) => { out += data.toString(); });
    child.stderr.on("data", (data) => { err += data.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ out, err })
      : reject(new Error(`${command} exited ${code}: ${err.slice(-6000)} ${out.slice(-1000)}`)));
  });
}

export async function main(parts = process.argv.slice(2)) {
  const options = flags(parts);
  if (!options["episode-dir"] || !options.evidence || options["workflow-bypass"]) {
    throw new Error("Usage: goldflow tts repair-pronunciation --episode-dir <dir> --evidence <user-heard.json>");
  }
  const episodeDir = path.resolve(options["episode-dir"]);
  const evidencePath = path.resolve(options.evidence);
  if (!within(episodeDir, evidencePath)) throw new Error("Defect receipt must be episode-local.");
  const expectedCommand = `node bin/goldflow.mjs tts repair-pronunciation --episode-dir ${episodeDir} --evidence ${evidencePath}`;
  const status = await run("node", ["bin/goldflow.mjs", "run", "status", "--episode-dir", episodeDir,
    "--format", "markdown"], path.resolve(DIR, ".."));
  if (!status.out.includes("Current stage: qwen_tts_stitch")
    || !status.out.includes(`Next command shape: \`${expectedCommand}\``)) {
    throw new Error("Goldflow status does not admit this exact pronunciation candidate.");
  }
  const episode = path.basename(episodeDir);
  const planPath = path.join(episodeDir, "narration_generation_plan.json");
  const reportPath = path.join(episodeDir, `narration_tts_report_${episode}.json`);
  const deliveryPath = path.join(episodeDir, `narration_unit_delivery_qa_${episode}.json`);
  const identityPath = path.join(episodeDir, "run_identity.json");
  const scriptPath = path.join(episodeDir, "script_clean.md");
  const [plan, report, delivery, identity, evidence] = await Promise.all(
    [planPath, reportPath, deliveryPath, identityPath, evidencePath].map(read));
  const manifestPath = report.provider_output_manifest_path;
  if (!within(episodeDir, manifestPath)) throw new Error("Prior provider manifest escaped the episode.");
  const manifest = await read(manifestPath);
  if (identity.tts_provider !== "qwen_local"
    || manifest.provider !== "qwen_local"
    || report.provider_output_manifest_sha256 !== await fileHash(manifestPath)
    || manifest.manifest_sha256 !== narrationProviderOutputManifestSha256(manifest)) {
    throw new Error("Current Qwen identity or provider manifest changed.");
  }
  const selected = manifest.units.find((row) => row.unit_id === evidence.unit_id);
  const priorBoundaryRequestPath = selected?.recovery_provenance?.request_path;
  const priorBoundaryResultPath = selected?.recovery_provenance?.result_path;
  if (!within(episodeDir, priorBoundaryRequestPath) || !within(episodeDir, priorBoundaryResultPath)
    || selected.recovery_provenance.result_sha256 !== await fileHash(priorBoundaryResultPath)) {
    throw new Error("Prior boundary provenance is absent or escaped the episode.");
  }
  const [priorBoundaryRequest, priorBoundaryResult] = await Promise.all([
    read(priorBoundaryRequestPath), read(priorBoundaryResultPath),
  ]);
  const validated = validatePronunciationDefectEvidenceForTests({
    evidence, evidenceFileSha256: await fileHash(evidencePath),
    sourceScriptSha256: await fileHash(scriptPath), plan,
    planFileSha256: await fileHash(planPath), report, reportFileSha256: await fileHash(reportPath),
    delivery, deliveryFileSha256: await fileHash(deliveryPath),
    manifest, manifestFileSha256: await fileHash(manifestPath),
    selectedAudioFileSha256: await fileHash(selected.audio_path),
    priorBoundaryRequest, priorBoundaryResult,
    priorBoundaryResultFileSha256: await fileHash(priorBoundaryResultPath),
  });
  const expected = { generationPlanSha256: plan.plan_sha256,
    generationPlanFileSha256: await fileHash(planPath),
    qualityContractSha256: manifest.narration_quality_contract_sha256,
    provider: "qwen_local", voiceId: manifest.voice_id,
    voiceSha256: manifest.voice_sha256 };
  if (validateNarrationProviderOutputManifest(manifest, plan.units, expected).status !== "passed") {
    throw new Error("Prior provider manifest does not validate against the locked plan.");
  }
  for (const row of manifest.units) {
    if (!within(episodeDir, row.audio_path) || await fileHash(row.audio_path) !== row.audio_sha256) {
      throw new Error(`Prior selected audio changed: ${row.unit_id}`);
    }
  }
  for (const file of [validated.retained_remainder.audio_path,
    validated.retained_remainder.sidecar_path]) {
    if (!within(episodeDir, file)) throw new Error("Retained remainder escaped the episode.");
  }
  if (await fileHash(validated.retained_remainder.audio_path)
      !== validated.retained_remainder.audio_sha256
    || await fileHash(validated.retained_remainder.sidecar_path)
      !== validated.retained_remainder.sidecar_sha256) {
    throw new Error("Retained exact-text remainder changed.");
  }
  const request = {
    schema: PRONUNCIATION_REQUEST_SCHEMA, episode_dir: episodeDir,
    identity_file_sha256: await fileHash(identityPath),
    source_script_sha256: await fileHash(scriptPath),
    plan_sha256: plan.plan_sha256, plan_file_sha256: await fileHash(planPath),
    defect_evidence_path: evidencePath, defect_evidence_sha256: await fileHash(evidencePath),
    prior_report_file_sha256: await fileHash(reportPath),
    prior_delivery_file_sha256: await fileHash(deliveryPath),
    prior_manifest_path: manifestPath, prior_manifest_sha256: manifest.manifest_sha256,
    prior_manifest_file_sha256: await fileHash(manifestPath),
    prior_boundary_request_path: priorBoundaryRequestPath,
    prior_boundary_request_file_sha256: await fileHash(priorBoundaryRequestPath),
    prior_boundary_result_path: priorBoundaryResultPath,
    prior_boundary_result_file_sha256: await fileHash(priorBoundaryResultPath),
    unit_id: evidence.unit_id,
    spoken_text_sha256: selected.spoken_text_sha256,
    prior_audio_sha256: selected.audio_sha256,
    prior_synthesis_identity_sha256: selected.synthesis_identity_sha256,
    expected_word: validated.intended_word,
    tts_only_phonetic_word: validated.tts_only_phonetic_word,
    remainder_text: validated.remainder_text,
    retained_remainder: validated.retained_remainder,
    model_id: manifest.model_id, model_revision: manifest.model_revision,
    voice_id: manifest.voice_id, voice_sha256: manifest.voice_sha256,
    voice_continuity_contract: manifest.voice_continuity_contract,
  };
  request.request_sha256 = canonicalHash(request);
  const candidateDir = path.join(episodeDir,
    "assets/audio/narration_tts/pronunciation_candidates", request.request_sha256);
  const requestPath = path.join(candidateDir, "request.json");
  const resultPath = path.join(candidateDir, "repair-result.json");
  await writeNew(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  for (const [name, source] of [
    ["prior_manifest.json", manifestPath], ["prior_report.json", reportPath],
    ["prior_delivery.json", deliveryPath],
  ]) await writeNew(path.join(candidateDir, name), await fs.readFile(source));
  await run(PYTHON, [path.join(DIR, "tts-exact-pronunciation-candidate.py"),
    "--request", requestPath, "--output-dir", candidateDir], DIR);
  const result = await read(resultPath);
  if (result.schema !== PRONUNCIATION_RESULT_SCHEMA
    || result.request_sha256 !== request.request_sha256
    || result.request_file_sha256 !== await fileHash(requestPath)
    || result.unit?.unit_id !== request.unit_id
    || result.unit?.spoken_text_sha256 !== request.spoken_text_sha256
    || !within(candidateDir, result.unit?.audio_path)
    || result.unit?.audio_sha256 !== await fileHash(result.unit.audio_path)) {
    throw new Error("Pronunciation runner result is not bound to its exact request.");
  }
  const next = structuredClone(manifest);
  const row = next.units.find((unit) => unit.unit_id === request.unit_id);
  const synthesisIdentity = {
    schema: "goldflow_tts_pronunciation_fragment_identity_v1",
    provider: manifest.provider, model_id: manifest.model_id,
    model_revision: manifest.model_revision, voice_id: manifest.voice_id,
    voice_sha256: manifest.voice_sha256,
    voice_continuity_contract: manifest.voice_continuity_contract,
    unit_id: request.unit_id, spoken_text_sha256: request.spoken_text_sha256,
    request_sha256: request.request_sha256,
    defect_evidence_sha256: request.defect_evidence_sha256,
    prior_audio_sha256: request.prior_audio_sha256,
    prior_synthesis_identity_sha256: request.prior_synthesis_identity_sha256,
    expected_word_sha256: sha(request.expected_word),
    tts_only_phonetic_word_sha256: sha(request.tts_only_phonetic_word),
    generated_fragment_audio_sha256: result.unit.phonetic_fragment.audio_sha256,
    retained_remainder_audio_sha256: result.unit.retained_remainder.audio_sha256,
    composite_audio_sha256: result.unit.audio_sha256,
  };
  Object.assign(row, {
    audio_path: result.unit.audio_path, audio_sha256: result.unit.audio_sha256,
    duration_sec: result.unit.duration_sec, token_limit_reached: false,
    synthesis_mode: PRONUNCIATION_MODE,
    generated_token_count: result.unit.generated_token_count,
    effective_token_limit: result.unit.effective_token_limit,
    recovery_provenance: {
      schema: "goldflow_tts_pronunciation_candidate_provenance_v1",
      request_path: requestPath, request_sha256: request.request_sha256,
      result_path: resultPath, result_sha256: await fileHash(resultPath),
      defect_evidence_path: evidencePath,
      defect_evidence_sha256: request.defect_evidence_sha256,
      prior_audio_sha256: request.prior_audio_sha256,
      prior_synthesis_identity_sha256: request.prior_synthesis_identity_sha256,
      candidate_review_status: "pending_user_listening",
    },
    synthesis_identity: synthesisIdentity,
    synthesis_identity_sha256: narrationSynthesisIdentitySha256(synthesisIdentity),
    runner_report_path: resultPath, runner_report_sha256: await fileHash(resultPath),
    provider_receipt: null, provider_unit_qa: null, provider_unit_qa_sha256: null,
  });
  next.provider_execution = { ...next.provider_execution,
    pronunciation_candidate: { request_sha256: request.request_sha256,
      result_sha256: await fileHash(resultPath), candidate_unit_id: request.unit_id,
      preserved_unit_count: next.units.length - 1 } };
  next.repair_history = [...(next.repair_history ?? []), {
    mode: PRONUNCIATION_MODE, prior_manifest_sha256: manifest.manifest_sha256,
    request_sha256: request.request_sha256 }];
  delete next.manifest_sha256;
  next.validation = validateNarrationProviderOutputManifest(next, plan.units, expected);
  next.status = next.validation.status;
  if (next.status !== "passed") throw new Error(`Derived candidate manifest invalid: ${JSON.stringify(next.validation.findings)}`);
  next.manifest_sha256 = narrationProviderOutputManifestSha256(next);
  const candidateManifestPath = path.join(candidateDir, "provider-output-manifest.json");
  await writeNew(candidateManifestPath, `${JSON.stringify(next, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: "candidate_pending_user_listening",
    unit_id: request.unit_id, candidate_audio_path: row.audio_path,
    candidate_audio_sha256: row.audio_sha256,
    candidate_manifest_path: candidateManifestPath,
    candidate_manifest_file_sha256: await fileHash(candidateManifestPath),
    preserved_unit_count: next.units.length - 1 })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.stack ?? String(error)); process.exitCode = 1; });
}
