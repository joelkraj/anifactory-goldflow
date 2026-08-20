#!/usr/bin/env node

import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  adjudicateNarrationDeliveryConsensus,
  exactNarrationListenReviewPacket,
  exactNarrationRepairPacket,
  narrationDeliveryNeedsConfirmation,
  strictNarrationDeliveryDecision,
  validateNarrationExactListenReviewDecision,
} from "./lib/narration-delivery-quality.mjs";
import {
  buildNarrationQualityContract,
  narrationQualityContractForIdentity,
} from "./lib/narration-quality-contract.mjs";
import { validateNarrationProviderOutputManifest } from "./lib/narration-provider-adapter.mjs";
import { masterNarrationTwoPass } from "./lib/narration-mastering.mjs";
import {
  buildNarrationSubjectiveReviewManifest,
  validateNarrationSubjectiveReviewManifest,
} from "./lib/narration-subjective-review.mjs";
import {
  narrationTtsPolicyForIdentity,
  validateNarrationTtsPolicy,
} from "./lib/narration-tts-policy.mjs";
import { runNarrationVoiceContinuityQa } from "./lib/narration-voice-continuity.mjs";
import { sha256File } from "./lib/file-hash.mjs";
import { equivalentPhrasesForTests } from "./narration-tts-episode.mjs";

const execFile = promisify(execFileCb);
const CANONICAL_SAMPLE_RATE_HZ = 24000;

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

function boolFlag(value, fallback = false) {
  if (value == null) return fallback;
  return /^(?:1|true|yes|on)$/iu.test(String(value));
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
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

function sourceScriptHash(plan) {
  return plan?.source_script_hash
    ?? plan?.source_script_sha256
    ?? plan?.source_hashes?.script_clean_sha256
    ?? plan?.source_hashes?.script_sha256
    ?? null;
}

function exactOrderedIds(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => String(value) === String(right[index]));
}

function statusFor({ blockers = [], warnings = [] } = {}) {
  if (blockers.length) return "blocked";
  return warnings.length ? "passed_with_warnings" : "passed";
}

function mergeDecisionWarnings(decision, warnings = []) {
  const merged = [
    ...(decision?.warnings ?? []),
    ...warnings.filter((finding) => finding?.review_required === true),
  ];
  return {
    ...decision,
    status: statusFor({ blockers: decision?.blockers ?? [], warnings: merged }),
    warnings: merged,
    review_required: merged.length > 0,
  };
}

export function conservativeNarrationEdgeAlignmentForTests({
  recognitions = [],
  transcriptQas = [],
  sampleCount,
  durationSec,
} = {}) {
  if (!Number.isInteger(sampleCount) || sampleCount <= 0) {
    return { status: "missing", reason: "invalid_sample_count" };
  }
  const edgeUncertain = transcriptQas.some((qa) => (
    !qa
    || Number(qa.leading_deletion_run ?? 0) > 0
    || Number(qa.trailing_deletion_run ?? 0) > 0
  ));
  if (edgeUncertain) {
    return {
      status: "missing",
      reason: "transcript_edge_uncertain_preserve_entire_unit",
    };
  }
  const usable = recognitions
    .map((recognition) => recognition?.words ?? [])
    .filter((words) => words.length > 0);
  if (!usable.length) {
    return { status: "missing", reason: "no_word_timestamps" };
  }
  const firstWords = usable.map((words) => words[0]);
  const finalWords = usable.map((words) => words.at(-1));
  const firstWord = firstWords.reduce((earliest, word) => (
    Number(word.start_sec ?? 0) < Number(earliest.start_sec ?? 0)
      ? word
      : earliest
  ));
  const finalWord = finalWords.reduce((latest, word) => (
    Number(word.end_sec ?? durationSec) > Number(latest.end_sec ?? durationSec)
      ? word
      : latest
  ));
  const firstSpeechSample = Math.max(0, Math.round(
    Math.min(...firstWords.map((word) => Number(word.start_sec ?? 0)))
      * CANONICAL_SAMPLE_RATE_HZ,
  ));
  const lastSpeechSampleExclusive = Math.min(sampleCount, Math.max(
    firstSpeechSample + 1,
    Math.round(
      Math.max(...finalWords.map((word) => Number(word.end_sec ?? durationSec)))
        * CANONICAL_SAMPLE_RATE_HZ,
    ),
  ));
  return {
    status: "passed",
    engine: "faster_whisper_conservative_consensus_envelope_v2",
    sample_rate_hz: CANONICAL_SAMPLE_RATE_HZ,
    first_speech_sample: firstSpeechSample,
    last_speech_sample_exclusive: lastSpeechSampleExclusive,
    first_word: firstWord,
    final_word: finalWord,
  };
}

function joinQaFromStitch(stitch) {
  const blockers = stitch?.boundary_qa?.blockers ?? [];
  const warnings = stitch?.boundary_qa?.warnings ?? [];
  return {
    schema: "goldflow_narration_semantic_join_qa_v2",
    status: statusFor({ blockers, warnings }),
    sample_rate_hz: CANONICAL_SAMPLE_RATE_HZ,
    boundary_count: stitch?.boundaries?.length ?? 0,
    joins: (stitch?.boundaries ?? []).map((boundary) => ({
      boundary_id: boundary.boundary_id,
      after_unit_id: boundary.after_unit_id,
      before_unit_id: boundary.before_unit_id,
      boundary_class: boundary.boundary_class,
      retained_natural_silence_sample_count:
        boundary.retained_natural_silence_sample_count,
      inserted_silence_sample_count: boundary.inserted_silence_sample_count,
      effective_pause_sample_count: boundary.effective_pause_sample_count,
      effective_pause_ms: boundary.effective_pause_ms,
      status: (boundary.blockers ?? []).length ? "blocked" : "passed",
    })),
    blockers,
    warnings,
  };
}

async function runFullStreamDeliveryQa({
  helpers,
  audioPath,
  units,
  qualityContract,
  orderQa,
  joinQa,
}) {
  const intendedText = units.map((unit) => (
    String(unit.spoken_text ?? unit.tts_spoken_text ?? "").trim()
  )).filter(Boolean).join(" ");
  const row = { unit_id: "__full_stream__", wav: audioPath };
  const primaryModel = qualityContract.delivery_qa.full_stream_screening_model
    ?? "small.en";
  const confirmationModel = qualityContract.delivery_qa.full_stream_confirmation_model
    ?? "medium";
  const primaryMap = await helpers.runFasterWhisperUnitBatchForDiagnostics(
    [row],
    { model: primaryModel, device: "cpu", computeType: "int8_float32" },
  );
  const primary = primaryMap.get(row.unit_id) ?? null;
  const equivalentPhrases = units.flatMap((unit) => equivalentPhrasesForTests(unit));
  const primaryTranscriptQa = primary
    ? helpers.transcriptQaForTests(intendedText, primary.text, {
        maxWer: qualityContract.delivery_qa.maximum_word_error_rate,
        equivalentPhrases,
        blockAnySubstitution: false,
      })
    : null;
  const primaryDecision = strictNarrationDeliveryDecision(primaryTranscriptQa, {
    orderQa,
    joinQa,
    contract: qualityContract,
  });
  const confirmationRequired = qualityContract.delivery_qa
    .full_stream_dual_asr_on_any_difference === true
      ? narrationDeliveryNeedsConfirmation(primaryTranscriptQa, primaryDecision)
      : primaryDecision.blockers.length > 0;
  let confirmation = null;
  let confirmationTranscriptQa = null;
  if (confirmationRequired) {
    const confirmationMap = await helpers.runFasterWhisperUnitBatchForDiagnostics(
      [row],
      { model: confirmationModel, device: "cpu", computeType: "int8_float32" },
    );
    confirmation = confirmationMap.get(row.unit_id) ?? null;
    confirmationTranscriptQa = confirmation
      ? helpers.transcriptQaForTests(intendedText, confirmation.text, {
          maxWer: qualityContract.delivery_qa.maximum_word_error_rate,
          equivalentPhrases,
          blockAnySubstitution: false,
        })
      : null;
  }
  const decision = adjudicateNarrationDeliveryConsensus({
    primaryTranscriptQa,
    confirmationTranscriptQa: confirmationRequired
      ? confirmationTranscriptQa
      : primaryTranscriptQa,
    orderQa,
    joinQa,
    contract: qualityContract,
    primaryModel,
    confirmationModel,
  });
  return {
    intended_text: intendedText,
    intended_text_sha256: sha256(intendedText),
    primary_model: primaryModel,
    primary_recognized_text: primary?.text ?? null,
    primary_recognized_words: primary?.words ?? [],
    primary_transcript_qa: primaryTranscriptQa,
    confirmation_required: confirmationRequired,
    confirmation_model: confirmationRequired ? confirmationModel : null,
    confirmation_recognized_text: confirmation?.text ?? null,
    confirmation_recognized_words: confirmation?.words ?? [],
    confirmation_transcript_qa: confirmationTranscriptQa,
    decision,
  };
}

async function encodeM4a(inputPath, outputPath) {
  await execFile("ffmpeg", [
    "-y", "-nostdin", "-hide_banner", "-v", "error",
    "-i", inputPath,
    "-c:a", "aac", "-b:a", "192k",
    outputPath,
  ]);
  return sha256File(outputPath);
}

export async function finalizeNarrationProviderOutput(
  argv = process.argv.slice(2),
) {
  const flags = parseFlags(argv);
  if (!flags["episode-dir"]) throw new Error("--episode-dir is required.");
  const episodeDir = path.resolve(flags["episode-dir"]);
  const identity = await readJson(path.join(episodeDir, "run_identity.json"), {});
  const episode = String(identity.episode ?? flags.episode ?? "ep_01");
  const planPath = path.resolve(
    flags.plan ?? path.join(episodeDir, "narration_generation_plan.json"),
  );
  const manifestPath = path.resolve(
    flags.manifest
      ?? path.join(episodeDir, `narration_provider_output_manifest_${episode}.json`),
  );
  const [plan, manifest, planFileSha256] = await Promise.all([
    readJson(planPath),
    readJson(manifestPath),
    sha256File(planPath),
  ]);
  if (!plan || !manifest) {
    throw new Error("Narration plan and provider output manifest are required.");
  }
  const units = planUnits(plan);
  if (!units.length) throw new Error("Narration plan contains no synthesis units.");
  const policy = validateNarrationTtsPolicy(
    narrationTtsPolicyForIdentity(identity),
    { production: true },
  );
  const qualityContract = narrationQualityContractForIdentity(identity)
    ?? buildNarrationQualityContract({
      provider: manifest.provider,
      modelId: manifest.model_id,
      modelRevision: manifest.model_revision,
    });
  if (qualityContract.contract_sha256 !== policy.narration_quality_contract?.contract_sha256) {
    throw new Error("Narration quality contract differs from the identity-locked TTS policy.");
  }
  const canonicalPlanSha256 = plan.plan_sha256 ?? planFileSha256;
  const manifestValidation = validateNarrationProviderOutputManifest(
    manifest,
    units,
    {
      generationPlanSha256: canonicalPlanSha256,
      generationPlanFileSha256: planFileSha256,
      qualityContractSha256: qualityContract.contract_sha256,
      provider: policy.primary.provider,
      voiceId: policy.primary.voice_id,
      voiceSha256: policy.primary.voice_sha256,
    },
  );
  if (manifestValidation.status !== "passed") {
    throw new Error(
      `Provider manifest is stale: ${manifestValidation.findings
        .map((finding) => finding.code)
        .join(", ")}`,
    );
  }
  if (manifest.model_id !== policy.primary.model_id
    || manifest.model_revision !== policy.primary.model_revision
    || manifest.voice_continuity_contract
      !== policy.primary.voice_continuity_contract) {
    throw new Error("Provider manifest model or voice identity differs from run identity.");
  }

  const manifestById = new Map(
    manifest.units.map((row) => [String(row.unit_id), row]),
  );
  for (const row of manifest.units) {
    if (await sha256File(row.audio_path) !== row.audio_sha256) {
      throw new Error(`Provider audio hash is stale for ${row.unit_id}.`);
    }
  }
  const workDir = path.resolve(
    flags["output-dir"]
      ?? path.join(episodeDir, "assets/audio/narration_provider_neutral"),
  );
  await fs.mkdir(workDir, { recursive: true });
  const helpers = await import("./modelslab-qwen-episode-audio.mjs");
  const rows = units.map((unit, orderIndex) => {
    const output = manifestById.get(String(unit.unit_id));
    const spokenText = String(unit.spoken_text ?? unit.tts_spoken_text ?? "");
    return {
      ...unit,
      order_index: orderIndex,
      text: spokenText,
      spoken_text: spokenText,
      spoken_text_sha256: unit.spoken_text_sha256 ?? sha256(spokenText),
      provider: manifest.provider,
      model_id: output.model_id,
      model_revision: output.model_revision,
      voice_id: output.voice_id,
      voice_sha256: output.voice_sha256,
      voice_continuity_contract: output.voice_continuity_contract,
      wav: output.audio_path,
      audio_path: output.audio_path,
      audio_sha256: output.audio_sha256,
      duration_sec: output.duration_sec,
      token_limit_reached: output.token_limit_reached === true,
      attempt: output.attempt ?? 1,
      synthesis_mode: output.synthesis_mode ?? null,
      batch_plan_sha256: output.batch_plan_sha256 ?? null,
      cohort_id: output.cohort_id ?? null,
      cohort_sha256: output.cohort_sha256 ?? null,
      generated_token_count: output.generated_token_count ?? null,
      effective_token_limit: output.effective_token_limit ?? null,
      recovery_provenance: output.recovery_provenance ?? null,
      synthesis_identity: output.synthesis_identity ?? null,
      synthesis_identity_sha256: output.synthesis_identity_sha256,
      runner_report_path: output.runner_report_path ?? null,
      runner_report_sha256: output.runner_report_sha256 ?? null,
      provider_receipt: output.provider_receipt,
    };
  });

  const continuityPath = path.join(
    episodeDir,
    `narration_voice_continuity_qa_${episode}.json`,
  );
  const similarityEvidencePath = path.join(
    episodeDir,
    `narration_speaker_similarity_${episode}.json`,
  );
  const [acousticQa, primaryMap, voiceContinuity] = await Promise.all([
    helpers.runUnitOutputQaForDiagnostics(rows),
    helpers.runFasterWhisperUnitBatchForDiagnostics(
      rows.map((row) => ({ unit_id: row.unit_id, wav: row.wav })),
      {
        model: qualityContract.delivery_qa.unit_screening_model ?? "small.en",
        device: "cpu",
        computeType: "int8_float32",
      },
    ),
    runNarrationVoiceContinuityQa({
      rows,
      profile: policy.primary,
      qualityContract,
      reportPath: similarityEvidencePath,
    }),
  ]);
  await atomicWriteJson(continuityPath, voiceContinuity);
  const continuityArtifactSha256 = await sha256File(continuityPath);
  const primaryById = new Map();
  const confirmationCandidates = [];
  for (const row of rows) {
    const recognized = primaryMap.get(String(row.unit_id)) ?? null;
    const transcriptQa = recognized
      ? helpers.transcriptQaForTests(row.text, recognized.text, {
          maxWer: qualityContract.delivery_qa.maximum_word_error_rate,
          equivalentPhrases: equivalentPhrasesForTests(row),
          blockAnySubstitution: false,
        })
      : null;
    const decision = strictNarrationDeliveryDecision(transcriptQa, {
      orderQa: { blockers: [] },
      joinQa: { blockers: [], warnings: [] },
      contract: qualityContract,
    });
    primaryById.set(String(row.unit_id), { recognized, transcriptQa, decision });
    if (narrationDeliveryNeedsConfirmation(transcriptQa, decision)) {
      confirmationCandidates.push({ unit_id: row.unit_id, wav: row.wav });
    }
  }
  const confirmationMap = confirmationCandidates.length
    ? await helpers.runFasterWhisperUnitBatchForDiagnostics(
        confirmationCandidates,
        {
          model: qualityContract.delivery_qa.exact_suspect_confirmation_model
            ?? "medium",
          device: "cpu",
          computeType: "int8_float32",
        },
      )
    : new Map();
  const continuityById = new Map(
    (voiceContinuity.units ?? []).map((row) => [String(row.unit_id), row]),
  );
  const deliveryRows = [];
  const blockers = [
    ...(acousticQa.blockers ?? []),
    ...(voiceContinuity.blockers ?? []),
  ];
  for (const row of rows) {
    const primary = primaryById.get(String(row.unit_id));
    const confirmation = confirmationMap.get(String(row.unit_id)) ?? null;
    const confirmationQa = confirmation
      ? helpers.transcriptQaForTests(row.text, confirmation.text, {
          maxWer: qualityContract.delivery_qa.maximum_word_error_rate,
          equivalentPhrases: equivalentPhrasesForTests(row),
          blockAnySubstitution: false,
        })
      : null;
    const confirmationRequired = confirmationCandidates.some(
      (candidate) => String(candidate.unit_id) === String(row.unit_id),
    );
    let decision = adjudicateNarrationDeliveryConsensus({
      primaryTranscriptQa: primary.transcriptQa,
      confirmationTranscriptQa: confirmationRequired
        ? confirmationQa
        : primary.transcriptQa,
      orderQa: { blockers: [] },
      joinQa: { blockers: [], warnings: [] },
      contract: qualityContract,
      primaryModel: qualityContract.delivery_qa.unit_screening_model ?? "small.en",
      confirmationModel:
        qualityContract.delivery_qa.exact_suspect_confirmation_model ?? "medium",
    });
    const continuity = continuityById.get(String(row.unit_id)) ?? null;
    const acousticReviewWarnings = (row.unit_qa?.findings ?? []).filter(
      (finding) => finding?.severity === "warning"
        && finding?.review_required === true,
    );
    decision = mergeDecisionWarnings(decision, [
      ...acousticReviewWarnings,
      ...(continuity?.warnings ?? []),
    ]);
    const sampleCount = Number(row.unit_qa?.metrics?.sample_count ?? 0);
    const alignment = conservativeNarrationEdgeAlignmentForTests({
      recognitions: [
        primary.recognized,
        ...(confirmationRequired ? [confirmation] : []),
      ],
      transcriptQas: [
        primary.transcriptQa,
        ...(confirmationRequired ? [confirmationQa] : []),
      ],
      sampleCount,
      durationSec: row.duration_sec,
    });
    row.unit_qa.edge_alignment = alignment;
    row.unit_qa.delivery_qa_v2 = decision;
    row.unit_qa.voice_continuity = continuity;
    const deliveryRow = {
      unit_id: row.unit_id,
      audio_path: row.wav,
      audio_sha256: row.audio_sha256,
      edge_alignment: alignment,
      intended_text: row.text,
      intended_text_sha256: row.spoken_text_sha256,
      primary_recognized_text: primary.recognized?.text ?? null,
      confirmation_recognized_text: confirmation?.text ?? null,
      transcript_qa: primary.transcriptQa,
      confirmation_transcript_qa: confirmationQa,
      acoustic_qa: row.unit_qa,
      voice_continuity: continuity,
      decision,
    };
    deliveryRows.push(deliveryRow);
    blockers.push(...(decision.blockers ?? []).map((finding) => ({
      ...finding,
      unit_id: row.unit_id,
    })));
  }

  const listenPacket = exactNarrationListenReviewPacket({
    rows: deliveryRows,
    generationPlanSha256: canonicalPlanSha256,
    generationPlanFileSha256: planFileSha256,
    qualityContractSha256: qualityContract.contract_sha256,
  });
  const unitDeliveryPath = path.join(
    episodeDir,
    `narration_unit_delivery_qa_${episode}.json`,
  );
  const unitQaPath = path.join(
    episodeDir,
    `narration_tts_unit_qa_${episode}.json`,
  );
  const listenPacketPath = path.join(
    episodeDir,
    `narration_exact_listen_review_packet_${episode}.json`,
  );
  const repairPacketPath = path.join(
    episodeDir,
    `narration_exact_repair_packet_${episode}.json`,
  );
  const unitDeliveryArtifact = {
    schema: "goldflow_narration_unit_delivery_qa_v2",
    status: blockers.length
      ? "blocked"
      : listenPacket.item_count ? "passed_with_warnings" : "passed",
    source_script_hash: sourceScriptHash(plan),
    narration_generation_plan_path: planPath,
    narration_generation_plan_sha256: canonicalPlanSha256,
    narration_generation_plan_file_sha256: planFileSha256,
    quality_contract_sha256: qualityContract.contract_sha256,
    provider: manifest.provider,
    unit_count: rows.length,
    blocked_unit_count: new Set(
      blockers.map((finding) => finding.unit_id).filter(Boolean),
    ).size,
    listen_review_unit_count: listenPacket.item_count,
    voice_continuity_status: voiceContinuity.status,
    voice_continuity_report_path: continuityPath,
    voice_continuity_report_sha256: continuityArtifactSha256,
    speaker_similarity_evidence_path: similarityEvidencePath,
    speaker_similarity_evidence_sha256: voiceContinuity.report_sha256 ?? null,
    blockers,
    units: deliveryRows,
  };
  const selectedUnits = rows.map((row) => {
    const delivery = deliveryRows.find(
      (item) => String(item.unit_id) === String(row.unit_id),
    );
    return {
      unit_id: row.unit_id,
      provider: row.provider,
      model_id: row.model_id,
      model_revision: row.model_revision,
      voice_id: row.voice_id,
      voice_sha256: row.voice_sha256,
      voice_continuity_contract: row.voice_continuity_contract,
      spoken_text: row.text,
      spoken_text_sha256: row.spoken_text_sha256,
      synthesis_identity_sha256: row.synthesis_identity_sha256,
      synthesis_identity: row.synthesis_identity,
      synthesis_mode: row.synthesis_mode,
      batch_plan_sha256: row.batch_plan_sha256,
      cohort_id: row.cohort_id,
      cohort_sha256: row.cohort_sha256,
      generated_token_count: row.generated_token_count,
      effective_token_limit: row.effective_token_limit,
      recovery_provenance: row.recovery_provenance,
      runner_report_path: row.runner_report_path,
      runner_report_sha256: row.runner_report_sha256,
      audio_path: row.wav,
      audio_sha256: row.audio_sha256,
      qa_status: delivery?.decision?.status ?? "blocked",
      qa: {
        status: delivery?.decision?.status ?? "blocked",
        acoustic: delivery?.acoustic_qa ?? null,
        delivery: delivery?.decision ?? null,
        voice_continuity: delivery?.voice_continuity ?? null,
      },
    };
  });
  const selectedBlockers = blockers.filter((finding) => finding.unit_id);
  const unitQaArtifact = {
    schema: "goldflow_narration_tts_unit_qa_v2",
    status: blockers.length
      ? "blocked"
      : listenPacket.item_count ? "passed_with_warnings" : "passed",
    source_script_hash: sourceScriptHash(plan),
    narration_generation_plan_path: planPath,
    narration_generation_plan_sha256: canonicalPlanSha256,
    narration_generation_plan_file_sha256: planFileSha256,
    narration_quality_contract_sha256: qualityContract.contract_sha256,
    expected_unit_count: rows.length,
    selected_unit_count: selectedUnits.length,
    selected_blocker_count: selectedBlockers.length,
    selected_blockers: selectedBlockers,
    selected_units: selectedUnits,
  };
  await Promise.all([
    atomicWriteJson(unitDeliveryPath, unitDeliveryArtifact),
    atomicWriteJson(unitQaPath, unitQaArtifact),
    atomicWriteJson(listenPacketPath, listenPacket),
    atomicWriteJson(repairPacketPath, exactNarrationRepairPacket({
      decision: { status: blockers.length ? "blocked" : "passed", blockers },
      units: rows,
    })),
  ]);
  if (blockers.length) {
    throw new Error(
      `Provider-neutral delivery QA blocked ${new Set(
        blockers.map((finding) => finding.unit_id).filter(Boolean),
      ).size} unit(s).`,
    );
  }

  let listenDecisionValidation = null;
  const listenDecisionPath = flags["listen-decision"]
    ? path.resolve(flags["listen-decision"])
    : path.join(
      episodeDir,
      `narration_exact_listen_review_decision_${episode}.json`,
    );
  const listenDecision = await readJson(listenDecisionPath, null);
  if (listenPacket.item_count > 0 && listenDecision) {
    listenDecisionValidation = validateNarrationExactListenReviewDecision(
      listenPacket,
      listenDecision,
    );
  }
  const deliveryAccepted = listenPacket.item_count === 0
    || listenDecisionValidation?.status === "approved";

  const rawWav = path.join(workDir, `${episode}-narration-provider-neutral-raw.wav`);
  const stitch = await helpers.stitchWavsForDiagnostics(rows, rawWav, {
    narrationQualityContract: qualityContract,
    workDir,
    skipRenderedTranscriptQa: true,
  });
  if (!stitch || stitch.status !== "passed") {
    throw new Error("Provider-neutral semantic stitch did not pass.");
  }
  const rawWavSha256 = await sha256File(rawWav);
  const masteringRequested = boolFlag(flags.master, true);
  let mastering = {
    status: masteringRequested
      ? "deferred_until_delivery_acceptance"
      : "diagnostic_disabled",
    reason: masteringRequested
      ? "Exact listen items must be approved before mastering."
      : "Mastering was explicitly disabled for a diagnostic run.",
  };
  let canonicalWav = rawWav;
  let canonicalWavSha256 = rawWavSha256;
  if (masteringRequested && deliveryAccepted) {
    const masteredPath = path.join(
      workDir,
      `${episode}-narration-provider-neutral-mastered.wav`,
    );
    mastering = await masterNarrationTwoPass({
      inputPath: rawWav,
      outputPath: masteredPath,
      reportPath: path.join(
        episodeDir,
        `narration_mastering_report_${episode}-provider-neutral.json`,
      ),
      targetLufs: qualityContract.mastering.integrated_lufs_target,
      truePeakDbtp: qualityContract.mastering.true_peak_dbtp_max,
      sampleRateHz: qualityContract.mastering.sample_rate_hz,
      channels: qualityContract.mastering.mono ? 1 : 2,
      integratedTolerance: qualityContract.mastering.integrated_lufs_tolerance,
      durationDeltaMsMax: qualityContract.mastering.duration_delta_ms_max,
    });
    if (mastering.status !== "passed") {
      throw new Error("Final stream-level narration mastering did not pass.");
    }
    canonicalWav = mastering.output_path;
    canonicalWavSha256 = mastering.output_sha256;
  }
  const subjectiveManifestPath = path.join(
    episodeDir,
    `narration_subjective_review_manifest_${episode}.json`,
  );
  let subjectiveManifest = null;
  if (qualityContract.subjective_review?.hash_bound_sampling_manifest_required === true
    && mastering.status === "passed"
    && deliveryAccepted) {
    subjectiveManifest = buildNarrationSubjectiveReviewManifest({
      plan,
      stitch,
      audioPath: canonicalWav,
      audioSha256: canonicalWavSha256,
      generationPlanSha256: canonicalPlanSha256,
      generationPlanFileSha256: planFileSha256,
      qualityContractSha256: qualityContract.contract_sha256,
      sampleRateHz: CANONICAL_SAMPLE_RATE_HZ,
    });
    const subjectiveValidation = validateNarrationSubjectiveReviewManifest(
      subjectiveManifest,
    );
    if (subjectiveValidation.status !== "passed") {
      throw new Error(
        `Canonical narration subjective sample manifest blocked: ${subjectiveValidation.findings
          .map((finding) => finding.code)
          .join(", ")}`,
      );
    }
    await atomicWriteJson(subjectiveManifestPath, subjectiveManifest);
  }

  const expectedIds = rows.map((row) => String(row.unit_id));
  const actualIds = stitch.prepared_inputs.map((row) => String(row.unit_id));
  const exactOrder = exactOrderedIds(expectedIds, actualIds);
  const orderQa = {
    schema: "goldflow_narration_unit_order_qa_v2",
    status: exactOrder ? "passed" : "blocked",
    expected_unit_ids: expectedIds,
    actual_unit_ids: actualIds,
    blockers: exactOrder
      ? []
      : [{ code: "narration_full_stream_unit_order_mismatch" }],
  };
  const joinQa = joinQaFromStitch(stitch);
  const fullStream = await runFullStreamDeliveryQa({
    helpers,
    audioPath: canonicalWav,
    units: rows,
    qualityContract,
    orderQa,
    joinQa,
  });
  const fullStreamPath = path.join(
    episodeDir,
    `narration_full_stream_qa_${episode}.json`,
  );
  const fullStreamArtifact = {
    schema: "goldflow_narration_full_stream_qa_v2",
    status: fullStream.decision.status,
    source_script_hash: sourceScriptHash(plan),
    narration_generation_plan_path: planPath,
    narration_generation_plan_sha256: canonicalPlanSha256,
    narration_generation_plan_file_sha256: planFileSha256,
    narration_quality_contract_sha256: qualityContract.contract_sha256,
    audio_path: canonicalWav,
    audio_sha256: canonicalWavSha256,
    intended_text_sha256: fullStream.intended_text_sha256,
    order_qa: orderQa,
    join_qa: joinQa,
    primary_model: fullStream.primary_model,
    primary_recognized_text: fullStream.primary_recognized_text,
    primary_recognized_words: fullStream.primary_recognized_words,
    primary_transcript_qa: fullStream.primary_transcript_qa,
    confirmation_required: fullStream.confirmation_required,
    confirmation_model: fullStream.confirmation_model,
    confirmation_recognized_text: fullStream.confirmation_recognized_text,
    confirmation_recognized_words: fullStream.confirmation_recognized_words,
    confirmation_transcript_qa: fullStream.confirmation_transcript_qa,
    decision: fullStream.decision,
    blockers: fullStream.decision.blockers,
    warnings: fullStream.decision.warnings,
  };
  await atomicWriteJson(fullStreamPath, fullStreamArtifact);

  const finalM4a = path.join(
    workDir,
    `${episode}-narration-provider-neutral.m4a`,
  );
  const finalM4aSha256 = await encodeM4a(canonicalWav, finalM4a);
  const sourceHash = sourceScriptHash(plan);
  const primary = {
    ...policy.primary,
    provider: manifest.provider,
    model_id: manifest.model_id,
    model_revision: manifest.model_revision,
    voice_id: manifest.voice_id,
    voice_sha256: manifest.voice_sha256,
    voice_continuity_contract: manifest.voice_continuity_contract,
  };
  const segmentRows = rows.map((row, index) => ({
    unit_id: row.unit_id,
    provider: row.provider,
    tts_provider: row.provider,
    model_id: row.model_id,
    model_revision: row.model_revision,
    voice_id: row.voice_id,
    voice_sha256: row.voice_sha256,
    voice_continuity_contract: row.voice_continuity_contract,
    text: row.text,
    spoken_text_sha256: row.spoken_text_sha256,
    synthesis_identity_sha256: row.synthesis_identity_sha256,
    synthesis_identity: row.synthesis_identity,
    synthesis_mode: row.synthesis_mode,
    batch_plan_sha256: row.batch_plan_sha256,
    cohort_id: row.cohort_id,
    cohort_sha256: row.cohort_sha256,
    generated_token_count: row.generated_token_count,
    effective_token_limit: row.effective_token_limit,
    recovery_provenance: row.recovery_provenance,
    runner_report_path: row.runner_report_path,
    runner_report_sha256: row.runner_report_sha256,
    raw_audio_path: row.wav,
    raw_audio_sha256: row.audio_sha256,
    qa_status: selectedUnits[index].qa_status,
    unit_qa: selectedUnits[index].qa,
    voice_continuity: selectedUnits[index].qa.voice_continuity,
    prepared_audio_path: stitch.prepared_inputs[index]?.prepared_wav ?? null,
    prepared_audio_sha256:
      stitch.prepared_inputs[index]?.prepared_qa?.audio_sha256 ?? null,
    prepared_leading_silence_sample_count:
      stitch.prepared_inputs[index]?.retained_leading_silence_sample_count ?? null,
    prepared_trailing_silence_sample_count:
      stitch.prepared_inputs[index]?.retained_trailing_silence_sample_count ?? null,
  }));
  const ttsStatus = fullStream.decision.status === "blocked"
    ? "blocked"
    : listenPacket.item_count && !deliveryAccepted
      ? "passed_with_warnings"
      : fullStream.decision.warnings.length || listenPacket.item_count
        ? "passed_with_warnings"
        : "passed";
  const stitchReport = {
    schema: "goldflow_provider_neutral_narration_stitch_v2",
    status: fullStream.decision.status === "blocked" ? "blocked" : "passed",
    source_script_hash: sourceHash,
    narration_generation_plan_path: planPath,
    narration_generation_plan_sha256: canonicalPlanSha256,
    narration_generation_plan_file_sha256: planFileSha256,
    narration_quality_contract_sha256: qualityContract.contract_sha256,
    primary_provider: manifest.provider,
    narrator_voice_id: manifest.voice_id,
    voice_id: manifest.voice_id,
    voice_sha256: manifest.voice_sha256,
    primary,
    stitch_policy_version: "narration_alignment_safe_semantic_stitch_v2",
    stitch_policy: stitch.policy,
    stitch_sample_rate: CANONICAL_SAMPLE_RATE_HZ,
    stitch_qa_status: stitch.status,
    full_stream_qa_status: fullStreamArtifact.status,
    full_stream_qa_path: fullStreamPath,
    boundary_qa: stitch.boundary_qa,
    boundaries: stitch.boundaries,
    join_qa: joinQa,
    sample_accounting: stitch.sample_accounting,
    segments: segmentRows,
    raw_output_path: rawWav,
    raw_output_sha256: rawWavSha256,
    output_path: canonicalWav,
    output_sha256: canonicalWavSha256,
    final_wav_path: canonicalWav,
    final_wav_sha256: canonicalWavSha256,
    final_m4a_path: finalM4a,
    final_m4a_sha256: finalM4aSha256,
    final_duration_sec:
      mastering.output_probe?.duration_sec
      ?? stitch.final_qa?.metrics?.duration_sec
      ?? null,
    mastering,
    subjective_review_manifest_path: subjectiveManifest
      ? subjectiveManifestPath
      : null,
    subjective_review_manifest_sha256:
      subjectiveManifest?.manifest_sha256 ?? null,
  };
  const ttsReport = {
    schema: "goldflow_provider_neutral_narration_tts_report_v2",
    status: ttsStatus,
    source_script_hash: sourceHash,
    narration_generation_plan_path: planPath,
    narration_generation_plan_sha256: canonicalPlanSha256,
    narration_generation_plan_file_sha256: planFileSha256,
    narration_quality_contract_sha256: qualityContract.contract_sha256,
    primary_provider: manifest.provider,
    primary_model_id: manifest.model_id,
    primary_model_revision: manifest.model_revision,
    narrator_voice_id: manifest.voice_id,
    voice_id: manifest.voice_id,
    voice_sha256: manifest.voice_sha256,
    primary,
    tts_native_speed: policy.primary.native_speed ?? null,
    post_tempo_normalized: false,
    synthesis_contract: policy.synthesis_contract,
    batch_plan_sha256:
      manifest.provider_execution?.batch_plan_sha256 ?? null,
    synthesis_runs:
      manifest.provider_execution?.synthesis_runs ?? [],
    effective_concurrency:
      manifest.provider_execution?.effective_concurrency ?? null,
    qa_policy: policy.qa_policy,
    unit_qa_policy_version: "narration_delivery_qa_v2",
    unit_qa_status: unitQaArtifact.status,
    unit_qa_path: unitQaPath,
    full_stream_qa_status: fullStreamArtifact.status,
    full_stream_qa_path: fullStreamPath,
    expected_unit_count: rows.length,
    selected_unit_count: rows.length,
    fallback_unit_ids: [],
    fallback_usage: null,
    provider_output_manifest_path: manifestPath,
    provider_output_manifest_sha256: await sha256File(manifestPath),
    voice_continuity_report_path: continuityPath,
    voice_continuity_report_sha256: continuityArtifactSha256,
    speaker_similarity_evidence_path: similarityEvidencePath,
    speaker_similarity_evidence_sha256: voiceContinuity.report_sha256 ?? null,
    listen_review_packet_path: listenPacketPath,
    listen_review_packet_sha256: listenPacket.packet_sha256,
    listen_review_status: listenPacket.item_count === 0
      ? "not_required"
      : listenDecisionValidation?.status ?? "pending",
    results: rows.map((row, index) => ({
      unit_id: row.unit_id,
      attempt: row.attempt ?? 1,
      selected_provider: row.provider,
      provider: row.provider,
      model_id: row.model_id,
      model_revision: row.model_revision,
      voice_id: row.voice_id,
      voice_sha256: row.voice_sha256,
      voice_continuity_contract: row.voice_continuity_contract,
      spoken_text_sha256: row.spoken_text_sha256,
      selected_spoken_text_sha256: row.spoken_text_sha256,
      audio_path: row.wav,
      audio_sha256: row.audio_sha256,
      token_limit_reached: row.token_limit_reached,
      generated_token_count: row.generated_token_count,
      effective_token_limit: row.effective_token_limit,
      synthesis_mode: row.synthesis_mode,
      batch_plan_sha256: row.batch_plan_sha256,
      cohort_id: row.cohort_id,
      cohort_sha256: row.cohort_sha256,
      recovery_provenance: row.recovery_provenance,
      synthesis_identity: row.synthesis_identity,
      synthesis_identity_sha256: row.synthesis_identity_sha256,
      selected_qa: selectedUnits[index].qa,
      qa_status: selectedUnits[index].qa_status,
      voice_continuity: selectedUnits[index].qa.voice_continuity,
    })),
    raw_wav: rawWav,
    raw_wav_sha256: rawWavSha256,
    final_wav: canonicalWav,
    final_wav_sha256: canonicalWavSha256,
    final_m4a: finalM4a,
    final_m4a_sha256: finalM4aSha256,
    mastering,
    subjective_review_manifest_path: subjectiveManifest
      ? subjectiveManifestPath
      : null,
    subjective_review_manifest_sha256:
      subjectiveManifest?.manifest_sha256 ?? null,
    subjective_review_status: subjectiveManifest
      ? "pending"
      : "not_required_or_not_materialized",
  };
  const stitchReportPath = path.join(
    episodeDir,
    `audio_stitch_report_${episode}-narration.json`,
  );
  const ttsReportPath = path.join(
    episodeDir,
    `narration_tts_report_${episode}.json`,
  );
  await Promise.all([
    atomicWriteJson(stitchReportPath, stitchReport),
    atomicWriteJson(ttsReportPath, ttsReport),
    atomicWriteJson(repairPacketPath, exactNarrationRepairPacket({
      decision: fullStream.decision,
      units: rows,
      boundaries: stitch.boundaries,
    })),
  ]);
  if (fullStream.decision.status === "blocked") {
    throw new Error(
      `Canonical full-stream delivery QA blocked: ${fullStream.decision.blockers
        .map((finding) => finding.code)
        .join(", ")}`,
    );
  }
  const result = {
    status: ttsReport.status,
    provider: manifest.provider,
    unit_count: rows.length,
    delivery_blocker_count: 0,
    listen_review_unit_count: listenPacket.item_count,
    delivery_accepted: deliveryAccepted,
    exact_sample_accounting: stitch.sample_accounting?.exact_sample_accounting,
    raw_wav: rawWav,
    raw_wav_sha256: rawWavSha256,
    final_wav: canonicalWav,
    final_wav_sha256: canonicalWavSha256,
    mastering_status: mastering.status,
    subjective_review_manifest_path: subjectiveManifest
      ? subjectiveManifestPath
      : null,
    subjective_review_sample_count: subjectiveManifest?.sample_count ?? 0,
    full_stream_qa_status: fullStreamArtifact.status,
    tts_report_path: ttsReportPath,
    stitch_report_path: stitchReportPath,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  finalizeNarrationProviderOutput().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
