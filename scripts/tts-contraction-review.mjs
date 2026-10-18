#!/usr/bin/env node

// Create one machine-reviewed, hash-bound contraction evidence receipt.
// This reads the selected source-text boundary composite; it does not synthesize
// audio, alter the source/captions, or claim that a person listened.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  narrationProviderOutputManifestSha256,
  validateNarrationProviderOutputManifest,
} from "./lib/narration-provider-adapter.mjs";
import { pcm, pcmInfo } from "./lib/narration-full-stream-contextual-asr.mjs";
import {
  CONTRACTION_ALIAS, CONTRACTION_EVIDENCE_SCHEMA,
  validateContractionEvidenceForTests,
} from "./lib/narration-contraction-repair.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(DIR, "..");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const fileHash = async (name) => sha(await fs.readFile(name));
const read = async (name) => JSON.parse(await fs.readFile(name, "utf8"));
const within = (root, target) => typeof target === "string" && path.isAbsolute(target)
  && path.resolve(target).startsWith(`${path.resolve(root)}${path.sep}`);

function flags(parts) {
  if (parts.length !== 2 || parts[0] !== "--episode-dir" || !parts[1]
    || parts[1].startsWith("--")) {
    throw new Error("Usage: goldflow tts review-contraction --episode-dir <dir>");
  }
  return { "episode-dir": parts[1] };
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

async function verifySelectedComposite(selectedPath, firstPath, remainderPath) {
  const [whole, first, remainder] = await Promise.all(
    [selectedPath, firstPath, remainderPath].map(pcmInfo));
  if (whole.frames !== first.frames + 1920 + remainder.frames) {
    throw new Error("Contraction review selected WAV has changed sample accounting.");
  }
  const [wholeFirst, firstPcm, gap, wholeRemainder, remainderPcm] = await Promise.all([
    pcm(selectedPath, 0, first.frames, whole),
    pcm(firstPath, 0, first.frames, first),
    pcm(selectedPath, first.frames, 1920, whole),
    pcm(selectedPath, first.frames + 1920, remainder.frames, whole),
    pcm(remainderPath, 0, remainder.frames, remainder),
  ]);
  if (!wholeFirst.equals(firstPcm) || !wholeRemainder.equals(remainderPcm)
    || !gap.every((byte) => byte === 0)) {
    throw new Error("Contraction review selected WAV differs from its retained fragments.");
  }
}

export function buildContractionReviewEvidenceForTests({ unitId, sourceScriptSha256,
  identityFileSha256, plan, planFileSha256, report, reportFileSha256,
  deliveryFileSha256, manifestFileSha256, selected,
  boundaryRequestFileSha256, boundaryResultFileSha256,
  reviewedAt,
} = {}) {
  if (report?.blockers?.length !== 1 || report.blockers[0]?.unit_id !== unitId
    || report.blockers[0]?.code !== "narration_confirmed_opening_token_mismatch"
    || !selected || !Number.isFinite(Date.parse(reviewedAt))) {
    throw new Error("Contraction review requires the sole exact opening ASR blocker.");
  }
  const spoken = plan?.units?.find((row) => row.unit_id === unitId)?.spoken_text;
  if (!spoken?.startsWith(`${CONTRACTION_ALIAS.from} `)) {
    throw new Error("Contraction review differs from the locked source phrase.");
  }
  return {
    schema: CONTRACTION_EVIDENCE_SCHEMA,
    status: "reviewed",
    evidence_basis: "reviewed_automated_delivery_qa",
    authorization_origin: "user_authorized_autonomous_production",
    human_listening_performed: false,
    user_listening_claimed: false,
    reviewed_by: "Goldflow automated QA",
    reviewed_at: reviewedAt,
    review_note: "Both independent ASR passes report the sole opening She for locked She’d, while all later tokens match. This receipt authorizes only the TTS-first-fragment literal expansion and retains the exact second WAV; no human listening is claimed.",
    unit_id: unitId,
    expected_first_fragment: CONTRACTION_ALIAS.from,
    tts_only_first_fragment: CONTRACTION_ALIAS.to,
    remainder_text: spoken.slice(CONTRACTION_ALIAS.from.length + 1),
    source_script_sha256: sourceScriptSha256,
    run_identity_file_sha256: identityFileSha256,
    narration_generation_plan_sha256: plan.plan_sha256,
    narration_generation_plan_file_sha256: planFileSha256,
    prior_narration_report_sha256: reportFileSha256,
    prior_unit_delivery_qa_sha256: deliveryFileSha256,
    prior_provider_manifest_file_sha256: manifestFileSha256,
    prior_audio_sha256: selected.audio_sha256,
    prior_synthesis_identity_sha256: selected.synthesis_identity_sha256,
    prior_boundary_request_sha256: boundaryRequestFileSha256,
    prior_boundary_result_sha256: boundaryResultFileSha256,
  };
}

export function contractionReviewStatusAdmissionForTests(status, episodeDir) {
  const expectedCommand = `node bin/goldflow.mjs tts review-contraction --episode-dir ${episodeDir}`;
  return status?.episode_dir === episodeDir
    && status.current_stage === "qwen_tts_stitch"
    && status.current_stage_state === "blocked"
    && status.next_command_shape === expectedCommand;
}

export async function main(parts = process.argv.slice(2)) {
  const options = flags(parts);
  const episodeDir = path.resolve(options["episode-dir"]);
  const { out } = await run("node", ["bin/goldflow.mjs", "run", "status",
    "--episode-dir", episodeDir, "--format", "json"], REPO);
  const status = JSON.parse(out);
  if (!contractionReviewStatusAdmissionForTests(status, episodeDir)) {
    throw new Error("Goldflow status does not admit this exact contraction review.");
  }
  const episode = path.basename(episodeDir);
  const evidencePath = path.join(episodeDir,
    `narration_automated_contraction_expansion_${episode}.json`);
  const planPath = path.join(episodeDir, "narration_generation_plan.json");
  const identityPath = path.join(episodeDir, "run_identity.json");
  const scriptPath = path.join(episodeDir, "script_clean.md");
  const reportPath = path.join(episodeDir, `narration_tts_report_${episode}.json`);
  const deliveryPath = path.join(episodeDir,
    `narration_unit_delivery_qa_${episode}.json`);
  const [identity, plan, report, delivery] = await Promise.all([
    identityPath, planPath, reportPath, deliveryPath,
  ].map(read));
  const manifestPath = report.provider_output_manifest_path;
  if (!within(episodeDir, manifestPath)) {
    throw new Error("Contraction review report-bound manifest escaped the episode.");
  }
  const manifest = await read(manifestPath);
  const [sourceScriptSha256, identityFileSha256, planFileSha256,
    reportFileSha256, deliveryFileSha256, manifestFileSha256] = await Promise.all([
    scriptPath, identityPath, planPath, reportPath, deliveryPath, manifestPath,
  ].map(fileHash));
  if (identity.tts_provider !== "qwen_local" || manifest.provider !== "qwen_local"
    || report.provider_output_manifest_sha256 !== manifestFileSha256
    || manifest.manifest_sha256 !== narrationProviderOutputManifestSha256(manifest)
    || validateNarrationProviderOutputManifest(manifest, plan.units, {
      generationPlanSha256: plan.plan_sha256,
      generationPlanFileSha256: planFileSha256,
      qualityContractSha256: manifest.narration_quality_contract_sha256,
      provider: "qwen_local", voiceId: manifest.voice_id,
      voiceSha256: manifest.voice_sha256,
    }).status !== "passed") {
    throw new Error("Contraction review source, plan, or manifest is stale.");
  }
  const unitId = report.blockers?.length === 1 ? report.blockers[0].unit_id : null;
  const selected = manifest.units.find((row) => row.unit_id === unitId);
  const boundaryRequestPath = selected?.recovery_provenance?.request_path;
  const boundaryResultPath = selected?.recovery_provenance?.result_path;
  if (!selected || !within(episodeDir, selected.audio_path)
    || !within(episodeDir, boundaryRequestPath)
    || !within(episodeDir, boundaryResultPath)) {
    throw new Error("Contraction review selected boundary lineage is absent.");
  }
  const [boundaryRequest, boundaryResult] = await Promise.all([
    read(boundaryRequestPath), read(boundaryResultPath),
  ]);
  const made = boundaryResult.units?.find((row) => row.unit_id === unitId);
  if (made?.fragments?.length !== 2 || ![
    made.fragments[0].audio_path, made.fragments[0].sidecar_path,
    made.fragments[1].audio_path, made.fragments[1].sidecar_path,
  ].every((target) => within(episodeDir, target))) {
    throw new Error("Contraction review requires the selected two-fragment boundary result.");
  }
  const [firstSidecar, remainderSidecar,
    selectedAudioFileSha256, boundaryRequestFileSha256,
    boundaryResultFileSha256, firstAudioFileSha256,
    firstSidecarFileSha256, remainderAudioFileSha256,
    remainderSidecarFileSha256] = await Promise.all([
    read(made.fragments[0].sidecar_path), read(made.fragments[1].sidecar_path),
    fileHash(selected.audio_path), fileHash(boundaryRequestPath), fileHash(boundaryResultPath),
    fileHash(made.fragments[0].audio_path),
    fileHash(made.fragments[0].sidecar_path),
    fileHash(made.fragments[1].audio_path),
    fileHash(made.fragments[1].sidecar_path),
  ]);
  await verifySelectedComposite(selected.audio_path,
    made.fragments[0].audio_path, made.fragments[1].audio_path);
  const evidence = buildContractionReviewEvidenceForTests({
    unitId, sourceScriptSha256, identityFileSha256, plan, planFileSha256,
    report, reportFileSha256, deliveryFileSha256, manifestFileSha256,
    selected, boundaryRequestFileSha256, boundaryResultFileSha256,
    reviewedAt: new Date().toISOString(),
  });
  validateContractionEvidenceForTests({ evidence,
    sourceScriptSha256, identityFileSha256, plan, planFileSha256,
    report, reportFileSha256, delivery, deliveryFileSha256,
    manifest, manifestFileSha256, selectedAudioFileSha256,
    boundaryRequest, boundaryRequestFileSha256,
    boundaryResult, boundaryResultFileSha256,
    firstAudioFileSha256, firstSidecar, firstSidecarFileSha256,
    remainderAudioFileSha256, remainderSidecar, remainderSidecarFileSha256,
  });
  for (const row of manifest.units) {
    if (!within(episodeDir, row.audio_path)
      || await fileHash(row.audio_path) !== row.audio_sha256) {
      throw new Error(`Contraction review preserved WAV hash changed: ${row.unit_id}.`);
    }
  }
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify({
    status: "contraction_reviewed_automated_qa",
    evidence_path: evidencePath,
    evidence_sha256: await fileHash(evidencePath),
    unit_id: unitId,
    human_listening_performed: false,
  })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.stack ?? String(error)); process.exitCode = 1; });
}
