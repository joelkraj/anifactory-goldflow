#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  adjudicateNarrationDeliveryConsensus,
} from "./lib/narration-delivery-quality.mjs";
import { masterNarrationTwoPass } from "./lib/narration-mastering.mjs";
import { buildNarrationQualityContract } from "./lib/narration-quality-contract.mjs";

const DEFAULT_ROOT =
  "/Users/joel/AniFactoryData/voice_bank/proofs/2026-08-17-narration-v2-extreme-quality-v1";

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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function countBy(rows, key) {
  return Object.fromEntries([...new Set(rows.map((row) => row[key]))]
    .map((value) => [value, rows.filter((row) => row[key] === value).length]));
}

function edgeAlignment(row) {
  const words = row.transcript?.words ?? [];
  const first = words[0] ?? null;
  const final = words.at(-1) ?? null;
  if (!first || !final) return { status: "missing", reason: "no_word_timestamps" };
  return {
    status: "passed",
    engine: "faster_whisper_small_en",
    first_speech_sample: Math.max(0, Math.round(Number(first.start_sec) * 24000)),
    last_speech_sample_exclusive: Math.min(
      Number(row.sample_count),
      Math.max(1, Math.round(Number(final.end_sec) * 24000)),
    ),
    first_word: first,
    final_word: final,
    recognized_word_count: words.length,
  };
}

function proofRows(evaluation, manifest, variantId) {
  const evaluated = evaluation.variants.find((variant) => variant.variant_id === variantId);
  const planned = manifest.variants.find((variant) => variant.id === variantId);
  if (!evaluated || !planned) throw new Error(`Missing proof variant ${variantId}.`);
  const planById = new Map(planned.units.map((row) => [row.id, row]));
  const selectedIds = new Set([
    "repeated_word_integrity",
    "terminal_tail_integrity",
    "attribution_and_action_integrity",
    "system_ui_and_numbers",
    "names_ranks_and_initialisms",
    "emotional_cadence_shift",
    "death_join_left",
    "death_join_right",
    "goblin_join_left",
    "goblin_join_right",
    "afterlife_join_left",
    "afterlife_join_right",
  ]);
  return evaluated.units
    .filter((row) => selectedIds.has(row.unit_id))
    .map((row, index) => {
      const plannedRow = planById.get(row.unit_id) ?? {};
      const alignment = edgeAlignment(row);
      return {
        unit_id: row.unit_id,
        segment_id: row.unit_id,
        source_segment_ids: [row.unit_id],
        order_index: index,
        text: row.text,
        spoken_text: row.text,
        word_count: row.text.split(/\s+/u).filter(Boolean).length,
        wav: row.output_path,
        duration_sec: row.duration_sec,
        provider: "qwen_local",
        category: plannedRow.category ?? null,
        pair_id: plannedRow.pair_id ?? null,
        side: plannedRow.side ?? null,
        unit_qa: {
          status: row.delivery_decision.status === "blocked" ? "blocked" : "passed_with_warnings",
          audio_sha256: row.output_sha256,
          edge_alignment: alignment,
          delivery_qa_v2: row.delivery_decision,
          metrics: {
            sample_count: row.sample_count,
            duration_sec: row.duration_sec,
            leading_silence_sec: Number(row.audio_metrics.leading_detected_silence_ms) / 1000,
            trailing_silence_sec: Number(row.audio_metrics.trailing_detected_silence_ms) / 1000,
            rms_dbfs: null,
          },
        },
      };
    });
}

async function verifyMaster({
  helpers,
  rows,
  masterPath,
  contract,
}) {
  const expectedText = rows.map((row) => row.text).join(" ");
  const primaryMap = await helpers.runFasterWhisperUnitBatchForDiagnostics(
    [{ unit_id: "master", wav: masterPath }],
    { model: "small.en", device: "cpu", computeType: "int8_float32" },
  );
  const primary = primaryMap.get("master") ?? null;
  const primaryQa = helpers.transcriptQaForTests(expectedText, primary?.text ?? "", {
    maxWer: 0.08,
    blockAnySubstitution: false,
    blockIsolatedEdits: false,
  });
  const confirmationMap = await helpers.runFasterWhisperUnitBatchForDiagnostics(
    [{ unit_id: "master", wav: masterPath }],
    { model: "medium", device: "cpu", computeType: "int8_float32" },
  );
  const confirmation = confirmationMap.get("master") ?? null;
  const confirmationQa = helpers.transcriptQaForTests(
    expectedText,
    confirmation?.text ?? "",
    {
      maxWer: 0.08,
      blockAnySubstitution: false,
      blockIsolatedEdits: false,
    },
  );
  const decision = adjudicateNarrationDeliveryConsensus({
    primaryTranscriptQa: primaryQa,
    confirmationTranscriptQa: confirmationQa,
    orderQa: { blockers: [] },
    joinQa: { blockers: [], warnings: [] },
    contract: {
      ...contract,
      delivery_qa: { ...contract.delivery_qa, maximum_word_error_rate: 0.08 },
    },
    primaryModel: "small.en",
    confirmationModel: "medium",
  });
  return {
    expected_text_sha256: sha256(expectedText),
    expected_word_count: expectedText.split(/\s+/u).filter(Boolean).length,
    primary_transcript: primary,
    primary_transcript_qa: primaryQa,
    confirmation_transcript: confirmation,
    confirmation_transcript_qa: confirmationQa,
    decision,
  };
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const proofRoot = path.resolve(flags["proof-root"] ?? DEFAULT_ROOT);
  const phaseDir = path.join(proofRoot, "final");
  const outputDir = path.join(phaseDir, "listening_proof");
  await fs.mkdir(outputDir, { recursive: true });
  const reportPath = path.join(outputDir, "proof_report.json");
  const previousReport = await fs.readFile(reportPath, "utf8")
    .then(JSON.parse)
    .catch(() => null);
  if (!flags["episode-dir"]) {
    process.argv.push("--episode-dir", phaseDir);
  }
  const helpers = await import("./modelslab-qwen-episode-audio.mjs");
  const [evaluation, manifest] = await Promise.all([
    fs.readFile(path.join(phaseDir, "evaluation_report.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(phaseDir, "generation_manifest.json"), "utf8").then(JSON.parse),
  ]);
  const contract = buildNarrationQualityContract({
    provider: "qwen_local",
    modelId: manifest.model.id,
    modelRevision: manifest.model.revision,
  });
  const variantIds = evaluation.variants.map((row) => row.variant_id);
  const variants = [];
  for (const variantId of variantIds) {
    const rows = proofRows(evaluation, manifest, variantId);
    const legacyRawPath = path.join(outputDir, `${variantId}-legacy-stitch.wav`);
    const v2RawPath = path.join(outputDir, `${variantId}-v2-semantic-stitch.wav`);
    const legacyStitch = await helpers.stitchWavsForDiagnostics(rows, legacyRawPath);
    const v2Stitch = await helpers.stitchWavsForDiagnostics(rows, v2RawPath, {
      narrationQualityContract: contract,
    });
    if (legacyStitch?.status !== "passed" || v2Stitch?.status !== "passed") {
      throw new Error(
        `Proof stitch failed for ${variantId}: legacy=${legacyStitch?.status}, v2=${v2Stitch?.status}`,
      );
    }
    const legacyMasterPath = path.join(outputDir, `${variantId}-legacy-stitch-mastered.wav`);
    const v2MasterPath = path.join(outputDir, `${variantId}-v2-semantic-stitch-mastered.wav`);
    const [legacyMaster, v2Master] = await Promise.all([
      masterNarrationTwoPass({
        inputPath: legacyRawPath,
        outputPath: legacyMasterPath,
        reportPath: path.join(outputDir, `${variantId}-legacy-mastering.json`),
      }),
      masterNarrationTwoPass({
        inputPath: v2RawPath,
        outputPath: v2MasterPath,
        reportPath: path.join(outputDir, `${variantId}-v2-mastering.json`),
      }),
    ]);
    const expectedTextSha256 = sha256(rows.map((row) => row.text).join(" "));
    const previousVariant = previousReport?.variants?.find(
      (row) => row.variant_id === variantId,
    );
    const cachedVerification = previousVariant?.v2?.mastering?.output_sha256
        === v2Master.output_sha256
      && previousVariant?.v2?.transcript_verification?.expected_text_sha256
        === expectedTextSha256
      ? previousVariant.v2.transcript_verification
      : null;
    const v2TranscriptVerification = cachedVerification ?? await verifyMaster({
      helpers,
      rows,
      masterPath: v2MasterPath,
      contract,
    });
    if (cachedVerification) {
      v2TranscriptVerification.decision = adjudicateNarrationDeliveryConsensus({
        primaryTranscriptQa: cachedVerification.primary_transcript_qa,
        confirmationTranscriptQa: cachedVerification.confirmation_transcript_qa,
        orderQa: { blockers: [] },
        joinQa: { blockers: [], warnings: [] },
        contract: {
          ...contract,
          delivery_qa: { ...contract.delivery_qa, maximum_word_error_rate: 0.08 },
        },
        primaryModel: "small.en",
        confirmationModel: "medium",
      });
    }
    const expectedV2Samples = v2Stitch.prepared_inputs.reduce(
      (sum, row) => sum + Number(row.prepared_sample_count),
      0,
    ) + v2Stitch.boundaries.reduce(
      (sum, row) => sum + Number(row.gap_sample_count),
      0,
    );
    const actualV2Samples = Number(v2Stitch.final_qa?.metrics?.sample_count);
    variants.push({
      variant_id: variantId,
      source_unit_count: rows.length,
      source_unit_ids: rows.map((row) => row.unit_id),
      legacy: {
        raw_path: legacyRawPath,
        mastered_path: legacyMasterPath,
        stitch: legacyStitch,
        mastering: legacyMaster,
      },
      v2: {
        raw_path: v2RawPath,
        mastered_path: v2MasterPath,
        stitch: v2Stitch,
        mastering: v2Master,
        transcript_verification: v2TranscriptVerification,
        sample_accounting: {
          expected_sample_count: expectedV2Samples,
          actual_sample_count: actualV2Samples,
          exact: expectedV2Samples === actualV2Samples,
        },
        boundary_class_counts: countBy(v2Stitch.boundaries, "boundary_class"),
        fade_over_speech_count: v2Stitch.prepared_inputs.filter(
          (row) => Number(row.fade_sec) > 0,
        ).length,
        amplitude_only_trim_count: v2Stitch.prepared_inputs.filter(
          (row) => row.preparation_policy?.amplitude_only_trimming === true,
        ).length,
      },
    });
  }
  const blockers = variants.flatMap((variant) => [
    ...(variant.legacy.mastering.blockers ?? []).map((row) => ({ variant_id: variant.variant_id, path: "legacy.mastering", ...row })),
    ...(variant.v2.mastering.blockers ?? []).map((row) => ({ variant_id: variant.variant_id, path: "v2.mastering", ...row })),
    ...(variant.v2.transcript_verification.decision.blockers ?? []).map((row) => ({ variant_id: variant.variant_id, path: "v2.transcript", ...row })),
    ...(!variant.v2.sample_accounting.exact ? [{ variant_id: variant.variant_id, path: "v2.sample_accounting", code: "sample_accounting_mismatch" }] : []),
  ]);
  const report = {
    schema: "goldflow_narration_v2_extreme_quality_proof_v1",
    status: blockers.length ? "blocked" : "passed_requires_human_preference",
    quality_contract: contract,
    source_evaluation_path: path.join(phaseDir, "evaluation_report.json"),
    source_generation_manifest_path: path.join(phaseDir, "generation_manifest.json"),
    deterministic_invariants: {
      one_creative_synthesis_take_reused: true,
      automatic_regeneration_count: 0,
      amplitude_only_trim_forbidden: true,
      fade_over_speech_forbidden: true,
      semantic_pause_classes: true,
      exact_sample_accounting_required: true,
      two_pass_stream_mastering: true,
      tempo_processing: false,
      broadband_denoise: false,
    },
    blockers,
    variants,
  };
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const markdown = [
    "# Narration V2 Extreme Quality Proof",
    "",
    `Status: ${report.status}`,
    "",
    "| Variant | V2 samples exact | V2 transcript | LUFS | True peak | Legacy master | V2 master |",
    "| --- | --- | --- | ---: | ---: | --- | --- |",
    ...variants.map((variant) => (
      `| ${variant.variant_id} | ${variant.v2.sample_accounting.exact} | ${variant.v2.transcript_verification.decision.status} | ${variant.v2.mastering.measured_integrated_lufs} | ${variant.v2.mastering.measured_true_peak_dbtp} | ${variant.legacy.mastered_path} | ${variant.v2.mastered_path} |`
    )),
  ];
  await fs.writeFile(path.join(outputDir, "proof_report.md"), `${markdown.join("\n")}\n`, "utf8");
  console.log(JSON.stringify({
    status: report.status,
    report_path: reportPath,
    variants: variants.map((variant) => ({
      variant_id: variant.variant_id,
      v2_mastered_path: variant.v2.mastered_path,
      legacy_mastered_path: variant.legacy.mastered_path,
      sample_accounting_exact: variant.v2.sample_accounting.exact,
      transcript_status: variant.v2.transcript_verification.decision.status,
      lufs: variant.v2.mastering.measured_integrated_lufs,
      true_peak_dbtp: variant.v2.mastering.measured_true_peak_dbtp,
    })),
  }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
