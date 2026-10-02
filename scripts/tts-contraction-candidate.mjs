#!/usr/bin/env node

// One status-directed, source-preserving TTS-only contraction candidate.
// The candidate remains unselected until fresh automated delivery QA passes.
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
import { pcm, pcmInfo } from "./lib/narration-full-stream-contextual-asr.mjs";
import {
  CONTRACTION_ALIAS, CONTRACTION_MODE, CONTRACTION_REQUEST_SCHEMA,
  CONTRACTION_RESULT_SCHEMA, contractionGuardAdmission,
  loadContractionRecoveryState,
} from "./lib/narration-contraction-repair.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(DIR, "..");
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
  for (let index = 0; index < parts.length; index += 2) {
    if (!parts[index]?.startsWith("--") || !parts[index + 1]
      || parts[index + 1].startsWith("--")) {
      throw new Error("Expected exact --flag value pairs.");
    }
    const key = parts[index].slice(2);
    if (Object.hasOwn(result, key)) throw new Error(`Duplicate flag: ${key}`);
    result[key] = parts[index + 1];
  }
  return result;
}

async function writeNew(name, content) {
  await fs.mkdir(path.dirname(name), { recursive: true });
  try { await fs.writeFile(name, content, { flag: "wx" }); }
  catch (error) {
    if (error?.code !== "EEXIST"
      || !(await fs.readFile(name)).equals(Buffer.from(content))) throw error;
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

async function verifyCandidatePcm(result) {
  const wholePath = result.unit.audio_path;
  const firstPath = result.unit.expanded_fragment.audio_path;
  const remainderPath = result.unit.retained_remainder.audio_path;
  const [whole, first, remainder] = await Promise.all(
    [wholePath, firstPath, remainderPath].map(pcmInfo));
  if (result.unit.gap_sample_count !== 1920
    || whole.frames !== first.frames + 1920 + remainder.frames
    || Math.abs(result.unit.duration_sec - whole.frames / 24000) > 0.000001) {
    throw new Error("Contraction candidate sample accounting differs from its exact fragments.");
  }
  const [wholeFirst, firstPcm, gap, wholeRemainder, remainderPcm] = await Promise.all([
    pcm(wholePath, 0, first.frames, whole),
    pcm(firstPath, 0, first.frames, first),
    pcm(wholePath, first.frames, 1920, whole),
    pcm(wholePath, first.frames + 1920, remainder.frames, whole),
    pcm(remainderPath, 0, remainder.frames, remainder),
  ]);
  if (!wholeFirst.equals(firstPcm) || !wholeRemainder.equals(remainderPcm)
    || !gap.every((byte) => byte === 0)) {
    throw new Error("Contraction candidate does not retain the exact second-fragment PCM.");
  }
}

export function deriveContractionCandidateManifestForTests({ manifest, request, result,
  requestPath, resultPath, resultFileSha256, evidencePath } = {}) {
  if (manifest?.units?.length !== 909 || !request?.unit_id
    || result?.unit?.unit_id !== request.unit_id
    || result.unit.spoken_text_sha256 !== request.spoken_text_sha256
    || result.unit.retained_remainder?.audio_sha256
      !== request.retained_remainder?.audio_sha256
    || result.unit.expanded_fragment?.text !== CONTRACTION_ALIAS.to
    || result.unit.gap_sample_count !== 1920) {
    throw new Error("Contraction candidate requires one exact unit in the 909-unit bank.");
  }
  const next = structuredClone(manifest);
  const row = next.units.find((unit) => unit.unit_id === request.unit_id);
  if (!row || row.audio_sha256 !== request.prior_audio_sha256
    || row.synthesis_identity_sha256 !== request.prior_synthesis_identity_sha256) {
    throw new Error("Contraction candidate prior selected unit differs.");
  }
  const priorSelected = structuredClone(row);
  const synthesisIdentity = {
    schema: "goldflow_tts_exact_contraction_composite_identity_v1",
    provider: manifest.provider, model_id: manifest.model_id,
    model_revision: manifest.model_revision, voice_id: manifest.voice_id,
    voice_sha256: manifest.voice_sha256,
    voice_continuity_contract: manifest.voice_continuity_contract,
    unit_id: request.unit_id, spoken_text_sha256: request.spoken_text_sha256,
    request_sha256: request.request_sha256,
    defect_evidence_sha256: request.defect_evidence_sha256,
    prior_audio_sha256: request.prior_audio_sha256,
    prior_synthesis_identity_sha256: request.prior_synthesis_identity_sha256,
    source_first_fragment_sha256: sha(request.expected_first_fragment),
    tts_only_first_fragment_sha256: sha(request.tts_only_first_fragment),
    generated_fragment_audio_sha256: result.unit.expanded_fragment.audio_sha256,
    retained_remainder_audio_sha256: result.unit.retained_remainder.audio_sha256,
    composite_audio_sha256: result.unit.audio_sha256,
  };
  Object.assign(row, {
    audio_path: result.unit.audio_path, audio_sha256: result.unit.audio_sha256,
    duration_sec: result.unit.duration_sec, token_limit_reached: false,
    synthesis_mode: CONTRACTION_MODE,
    generated_token_count: result.unit.generated_token_count,
    effective_token_limit: result.unit.effective_token_limit,
    recovery_provenance: {
      schema: "goldflow_tts_exact_contraction_candidate_provenance_v1",
      request_path: requestPath, request_sha256: request.request_sha256,
      result_path: resultPath, result_sha256: resultFileSha256,
      defect_evidence_path: evidencePath,
      defect_evidence_sha256: request.defect_evidence_sha256,
      prior_audio_sha256: request.prior_audio_sha256,
      prior_synthesis_identity_sha256: request.prior_synthesis_identity_sha256,
      prior_boundary_request_path: request.prior_boundary_request_path,
      prior_boundary_request_file_sha256: request.prior_boundary_request_file_sha256,
      prior_boundary_result_path: request.prior_boundary_result_path,
      prior_boundary_result_file_sha256: request.prior_boundary_result_file_sha256,
      prior_selected: priorSelected,
      candidate_review_status: "pending_automated_asr",
      authorization_origin: "user_authorized_autonomous_production",
      human_listening_performed: false,
    },
    synthesis_identity: synthesisIdentity,
    synthesis_identity_sha256: narrationSynthesisIdentitySha256(synthesisIdentity),
    runner_report_path: resultPath, runner_report_sha256: resultFileSha256,
    provider_receipt: null, provider_unit_qa: null, provider_unit_qa_sha256: null,
  });
  for (const [index, previous] of manifest.units.entries()) {
    if (previous.unit_id !== request.unit_id
      && JSON.stringify(next.units[index]) !== JSON.stringify(previous)) {
      throw new Error(`Contraction candidate changed preserved unit ${previous.unit_id}.`);
    }
  }
  next.provider_execution = { ...next.provider_execution,
    contraction_candidate: {
      request_sha256: request.request_sha256,
      result_sha256: resultFileSha256,
      candidate_unit_id: request.unit_id,
      preserved_unit_count: 908,
      human_listening_performed: false,
    } };
  next.repair_history = [...(next.repair_history ?? []), {
    mode: CONTRACTION_MODE,
    prior_manifest_sha256: manifest.manifest_sha256,
    request_sha256: request.request_sha256,
  }];
  delete next.manifest_sha256;
  return next;
}

export async function main(parts = process.argv.slice(2)) {
  const options = flags(parts);
  if (Object.keys(options).sort().join(",") !== "episode-dir,evidence") {
    throw new Error("Usage: goldflow tts repair-contraction --episode-dir <dir> --evidence <exact-review.json>");
  }
  const episodeDir = path.resolve(options["episode-dir"]);
  const evidencePath = path.resolve(options.evidence);
  if (!within(episodeDir, evidencePath)) {
    throw new Error("Contraction evidence must be episode-local.");
  }
  const { out } = await run("node", ["bin/goldflow.mjs", "run", "status",
    "--episode-dir", episodeDir, "--format", "json"], REPO);
  const status = JSON.parse(out);
  if (!contractionGuardAdmission(status, "tts", "repair-contraction", {
    "episode-dir": episodeDir, evidence: evidencePath,
  }).allowed) {
    throw new Error("Goldflow status does not admit this exact contraction candidate.");
  }
  const episode = path.basename(episodeDir);
  const planPath = path.join(episodeDir, "narration_generation_plan.json");
  const identityPath = path.join(episodeDir, "run_identity.json");
  const scriptPath = path.join(episodeDir, "script_clean.md");
  const sourceScriptSha256 = await fileHash(scriptPath);
  const state = await loadContractionRecoveryState({ episodeDir, episode,
    sourceScriptSha256 });
  if (state?.kind !== "evidence_reviewed"
    || path.resolve(state.evidence_path) !== evidencePath) {
    throw new Error("One reviewed contraction candidate is already present or evidence is stale.");
  }
  const [identity, plan, manifest] = await Promise.all([
    read(identityPath), read(planPath), read(state.prior_manifest_path),
  ]);
  if (identity.tts_provider !== "qwen_local" || manifest.provider !== "qwen_local"
    || plan.units?.length !== 909 || manifest.units?.length !== 909) {
    throw new Error("Contraction candidate differs from the locked Qwen 909-unit episode.");
  }
  const selected = state.validated.selected;
  const priorBoundaryRequestPath = selected.recovery_provenance.request_path;
  const priorBoundaryResultPath = selected.recovery_provenance.result_path;
  const request = {
    schema: CONTRACTION_REQUEST_SCHEMA, episode_dir: episodeDir,
    identity_file_sha256: await fileHash(identityPath),
    source_script_sha256: sourceScriptSha256,
    plan_sha256: plan.plan_sha256, plan_file_sha256: await fileHash(planPath),
    defect_evidence_path: evidencePath,
    defect_evidence_sha256: state.evidence_file_sha256,
    prior_report_file_sha256: await fileHash(path.join(episodeDir,
      `narration_tts_report_${episode}.json`)),
    prior_delivery_file_sha256: await fileHash(path.join(episodeDir,
      `narration_unit_delivery_qa_${episode}.json`)),
    prior_manifest_path: state.prior_manifest_path,
    prior_manifest_sha256: manifest.manifest_sha256,
    prior_manifest_file_sha256: state.prior_manifest_file_sha256,
    prior_boundary_request_path: priorBoundaryRequestPath,
    prior_boundary_request_file_sha256: await fileHash(priorBoundaryRequestPath),
    prior_boundary_result_path: priorBoundaryResultPath,
    prior_boundary_result_file_sha256: await fileHash(priorBoundaryResultPath),
    unit_id: selected.unit_id, spoken_text_sha256: selected.spoken_text_sha256,
    prior_audio_sha256: selected.audio_sha256,
    prior_synthesis_identity_sha256: selected.synthesis_identity_sha256,
    expected_first_fragment: CONTRACTION_ALIAS.from,
    tts_only_first_fragment: CONTRACTION_ALIAS.to,
    remainder_text: state.validated.remainder_text,
    retained_remainder: {
      audio_path: state.validated.remainder.audio_path,
      audio_sha256: state.validated.remainder.audio_sha256,
      sidecar_path: state.validated.remainder.sidecar_path,
      sidecar_sha256: state.validated.remainder.sidecar_sha256,
    },
    recovery_authorization: {
      evidence_basis: "reviewed_automated_delivery_qa",
      authorization_origin: "user_authorized_autonomous_production",
      human_listening_performed: false, user_listening_claimed: false,
    },
    model_id: manifest.model_id, model_revision: manifest.model_revision,
    voice_id: manifest.voice_id, voice_sha256: manifest.voice_sha256,
    voice_continuity_contract: manifest.voice_continuity_contract,
  };
  request.request_sha256 = canonicalHash(request);
  const candidateDir = path.join(episodeDir,
    "assets/audio/narration_tts/contraction_candidates", request.request_sha256);
  const requestPath = path.join(candidateDir, "request.json");
  const resultPath = path.join(candidateDir, "repair-result.json");
  await writeNew(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  for (const [name, source] of [
    ["prior_manifest.json", state.prior_manifest_path],
    ["prior_report.json", path.join(episodeDir, `narration_tts_report_${episode}.json`)],
    ["prior_delivery.json", path.join(episodeDir, `narration_unit_delivery_qa_${episode}.json`)],
    ["prior_boundary_request.json", priorBoundaryRequestPath],
    ["prior_boundary_result.json", priorBoundaryResultPath],
  ]) await writeNew(path.join(candidateDir, name), await fs.readFile(source));
  await run(PYTHON, [path.join(DIR, "tts-exact-contraction-candidate.py"),
    "--request", requestPath, "--output-dir", candidateDir], DIR);
  const result = await read(resultPath);
  if (result.schema !== CONTRACTION_RESULT_SCHEMA
    || result.request_sha256 !== request.request_sha256
    || result.request_file_sha256 !== await fileHash(requestPath)
    || result.unit?.unit_id !== request.unit_id
    || result.unit?.spoken_text_sha256 !== request.spoken_text_sha256
    || !within(candidateDir, result.unit?.audio_path)
    || !within(candidateDir, result.unit?.expanded_fragment?.audio_path)
    || !within(candidateDir, result.unit?.expanded_fragment?.sidecar_path)
    || result.unit.expanded_fragment.text !== CONTRACTION_ALIAS.to
    || result.unit.expanded_fragment.text_sha256 !== sha(CONTRACTION_ALIAS.to)
    || result.unit.audio_sha256 !== await fileHash(result.unit.audio_path)
    || result.unit.expanded_fragment.audio_sha256
      !== await fileHash(result.unit.expanded_fragment.audio_path)
    || result.unit.expanded_fragment.sidecar_sha256
      !== await fileHash(result.unit.expanded_fragment.sidecar_path)
    || JSON.stringify(result.unit.retained_remainder)
      !== JSON.stringify(request.retained_remainder)) {
    throw new Error("Contraction runner result is not bound to the exact request and retained WAV.");
  }
  await verifyCandidatePcm(result);
  const resultFileSha256 = await fileHash(resultPath);
  const next = deriveContractionCandidateManifestForTests({ manifest, request, result,
    requestPath, resultPath, resultFileSha256, evidencePath });
  const expected = {
    generationPlanSha256: plan.plan_sha256,
    generationPlanFileSha256: await fileHash(planPath),
    qualityContractSha256: manifest.narration_quality_contract_sha256,
    provider: "qwen_local", voiceId: manifest.voice_id,
    voiceSha256: manifest.voice_sha256,
  };
  next.validation = validateNarrationProviderOutputManifest(next, plan.units, expected);
  next.status = next.validation.status;
  if (next.status !== "passed") {
    throw new Error(`Derived contraction manifest invalid: ${JSON.stringify(next.validation.findings)}`);
  }
  next.manifest_sha256 = narrationProviderOutputManifestSha256(next);
  const candidateManifestPath = path.join(candidateDir, "provider-output-manifest.json");
  await writeNew(candidateManifestPath, `${JSON.stringify(next, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    status: "candidate_pending_automated_asr", unit_id: request.unit_id,
    candidate_audio_path: result.unit.audio_path,
    candidate_audio_sha256: result.unit.audio_sha256,
    candidate_manifest_path: candidateManifestPath,
    candidate_manifest_file_sha256: await fileHash(candidateManifestPath),
    preserved_unit_count: 908, human_listening_performed: false,
  })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.stack ?? String(error)); process.exitCode = 1; });
}
