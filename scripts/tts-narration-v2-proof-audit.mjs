#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { narrationRenderMasterReuseDecision } from "./lib/narration-mastering.mjs";
import { validateNarrationQualityContract } from "./lib/narration-quality-contract.mjs";
import { validateNarrationTextIr } from "./lib/narration-text-ir.mjs";

function parseFlags(parts) {
  const flags = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    flags[key] = parts[index + 1] && !parts[index + 1].startsWith("--")
      ? parts[++index]
      : "true";
  }
  return flags;
}

function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Value(value) {
  return sha256Buffer(Buffer.from(JSON.stringify(value)));
}

async function sha256File(filePath) {
  return sha256Buffer(await fs.readFile(filePath));
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeAtomic(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, contents);
  await fs.rename(temporary, filePath);
}

function check(condition, code, details = {}) {
  return condition ? null : { code, ...details };
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (!flags["proof-root"]) {
    throw new Error("--proof-root is required");
  }
  const proofRoot = path.resolve(flags["proof-root"]);
  const replayDir = path.resolve(
    flags["replay-dir"] ?? path.join(proofRoot, "provider_replay"),
  );
  const finalDir = path.join(proofRoot, "final");
  const sourcePaths = {
    evaluation: path.join(finalDir, "evaluation_report.json"),
    listening_proof: path.join(finalDir, "listening_proof", "proof_report.json"),
    replay_manifest: path.join(replayDir, "replay_proof_manifest.json"),
    run_identity: path.join(replayDir, "run_identity.json"),
    generation_plan: path.join(replayDir, "narration_generation_plan.json"),
    text_ir: path.join(replayDir, "narration_text_ir.json"),
    provider_manifest: path.join(replayDir, "narration_provider_output_manifest_ep_proof.json"),
    tts_report: path.join(replayDir, "narration_tts_report_ep_proof.json"),
    unit_delivery: path.join(replayDir, "narration_unit_delivery_qa_ep_proof.json"),
    full_stream: path.join(replayDir, "narration_full_stream_qa_ep_proof.json"),
    stitch: path.join(replayDir, "audio_stitch_report_ep_proof-narration.json"),
    continuity: path.join(replayDir, "narration_voice_continuity_qa_ep_proof.json"),
    mastering: path.join(replayDir, "narration_mastering_report_ep_proof-provider-neutral.json"),
    audio_bed: path.join(replayDir, "longform_audio_bed_report_ep_proof.json"),
    audio_bed_mastering: path.join(replayDir, "narration_mastering_report_ep_proof.json"),
    exact_listen: path.join(replayDir, "narration_exact_listen_review_packet_ep_proof.json"),
  };
  const entries = await Promise.all(
    Object.entries(sourcePaths).map(async ([key, filePath]) => [
      key,
      { path: filePath, value: await readJson(filePath), sha256: await sha256File(filePath) },
    ]),
  );
  const sources = Object.fromEntries(entries);
  const evaluation = sources.evaluation.value;
  const winner = evaluation.variants?.find(
    (row) => row.variant_id === evaluation.winner,
  ) ?? null;
  const replay = sources.replay_manifest.value;
  const runIdentity = sources.run_identity.value;
  const generationPlan = sources.generation_plan.value;
  const textIr = sources.text_ir.value;
  const providerManifest = sources.provider_manifest.value;
  const tts = sources.tts_report.value;
  const unitDelivery = sources.unit_delivery.value;
  const fullStream = sources.full_stream.value;
  const stitch = sources.stitch.value;
  const continuity = sources.continuity.value;
  const mastering = sources.mastering.value;
  const audioBed = sources.audio_bed.value;
  const audioBedMastering = sources.audio_bed_mastering.value;
  const exactListen = sources.exact_listen.value;
  const masteredPath = path.resolve(tts.final_wav ?? mastering.output_path);
  const masteredSha256 = await sha256File(masteredPath);
  const renderInputValue = audioBed.mix?.render_input_path ?? null;
  const renderInputPath = renderInputValue ? path.resolve(renderInputValue) : null;
  const renderInputSha256 = renderInputPath ? await sha256File(renderInputPath) : null;
  const renderMasterReuse = narrationRenderMasterReuseDecision({
    audioPath: renderInputPath,
    audioSha256: renderInputSha256,
    audioBedReport: audioBed,
    targetLufs: -16,
    truePeakDbtp: -1.5,
    loudnessRange: 11,
  });
  const qualityContractValidation = validateNarrationQualityContract(
    runIdentity.narration_quality_contract,
  );
  const textIrValidation = validateNarrationTextIr(
    textIr,
    generationPlan.units ?? [],
    {
      sourceScriptSha256: generationPlan.source_script_hash,
      generationPlanSha256: generationPlan.plan_sha256,
    },
  );
  const requestTextMismatchUnits = (generationPlan.units ?? []).filter((unit) => (
    String(unit.provider_request?.request?.text ?? "")
      !== String(unit.spoken_text ?? unit.tts_spoken_text ?? "")
  ));
  const performanceMetadataLeakUnits = (generationPlan.units ?? []).filter((unit) => (
    /^\s*\[[^\]]+\]/u.test(String(unit.provider_request?.request?.text ?? ""))
  ));
  const lineageComponentCount = (textIr.units ?? []).reduce(
    (sum, unit) => sum + Number(unit.spoken_text_lineage?.components?.length ?? 0),
    0,
  );

  const blockers = [
    check(evaluation.status === "passed_requires_listening", "bakeoff_status_invalid", { actual: evaluation.status }),
    check(Boolean(winner), "bakeoff_winner_missing", { expected: evaluation.winner }),
    check(replay.creative_submissions_performed === 0, "replay_performed_creative_submission"),
    check(qualityContractValidation.status === "passed", "quality_contract_failed", {
      findings: qualityContractValidation.findings,
    }),
    check(textIrValidation.status === "passed", "spoken_text_lineage_failed", {
      findings: textIrValidation.findings,
    }),
    check(requestTextMismatchUnits.length === 0, "provider_request_text_mismatch", {
      unit_ids: requestTextMismatchUnits.map((unit) => unit.unit_id),
    }),
    check(performanceMetadataLeakUnits.length === 0, "performance_metadata_entered_spoken_payload", {
      unit_ids: performanceMetadataLeakUnits.map((unit) => unit.unit_id),
    }),
    check(providerManifest.status === "passed", "provider_manifest_failed"),
    check(providerManifest.validation?.status === "passed", "provider_manifest_validation_failed"),
    check(tts.status === "passed", "tts_report_failed"),
    check(unitDelivery.status === "passed", "unit_delivery_failed"),
    check(fullStream.status === "passed", "full_stream_failed"),
    check(fullStream.order_qa?.status === "passed", "unit_order_failed"),
    check(fullStream.join_qa?.status === "passed", "join_qa_failed"),
    check(fullStream.primary_transcript_qa?.word_error_rate === 0, "full_stream_wer_nonzero", {
      actual: fullStream.primary_transcript_qa?.word_error_rate,
    }),
    check(stitch.status === "passed", "stitch_failed"),
    check(stitch.sample_accounting?.exact_sample_accounting === true, "sample_accounting_not_exact"),
    check(continuity.status === "passed", "voice_continuity_failed"),
    check(continuity.report?.aggregate_status === "passed", "voice_aggregate_failed"),
    check(mastering.status === "passed", "mastering_failed"),
    check(mastering.duration_delta_ms === 0, "mastering_duration_changed", {
      actual_ms: mastering.duration_delta_ms,
    }),
    check(masteredSha256 === tts.final_wav_sha256, "tts_mastered_hash_mismatch"),
    check(masteredSha256 === mastering.output_sha256, "mastering_output_hash_mismatch"),
    check(fullStream.audio_sha256 === masteredSha256, "full_stream_audio_hash_mismatch"),
    check(stitch.output_sha256 === masteredSha256, "stitch_output_hash_mismatch"),
    check(audioBed.status === "completed", "narrator_only_audio_bed_failed"),
    check(audioBed.narration_only === true, "audio_bed_not_narration_only"),
    check(audioBed.mix?.render_input_lossless === true, "render_input_not_lossless"),
    check(renderInputSha256 === masteredSha256, "render_input_changed_mastered_audio"),
    check(audioBed.final_audio_sha256 === renderInputSha256, "audio_bed_final_hash_mismatch"),
    check(audioBed.mix?.mastering?.passthrough === true, "audio_bed_remastered_canonical_audio"),
    check(audioBedMastering.output_sha256 === renderInputSha256, "audio_bed_mastering_hash_mismatch"),
    check(renderMasterReuse.status === "eligible", "render_would_remaster_canonical_audio", {
      findings: renderMasterReuse.findings,
    }),
    check(Number(exactListen.item_count ?? 0) === 0, "replay_has_unresolved_listen_items", {
      item_count: exactListen.item_count,
    }),
  ].filter(Boolean);

  const auditBase = {
    schema: "goldflow_narration_quality_v2_proof_audit_v1",
    status: blockers.length ? "blocked" : "passed",
    proof_root: proofRoot,
    provider_replay_dir: replayDir,
    conclusion: blockers.length
      ? "Proof artifacts do not satisfy the locked integrity contract."
      : "Real Qwen output passed the provider-neutral delivery, continuity, semantic stitch, full-stream, and mastering path without a new creative submission.",
    scope: {
      integrity_and_delivery: "automated_and_hash_verified",
      subjective_voice_preference: "human_listening_still_required",
    },
    bakeoff: {
      status: evaluation.status,
      winner: evaluation.winner,
      winner_metrics: winner ? {
        unit_count: winner.unit_count,
        blocked_unit_count: winner.blocked_unit_count,
        opening_or_final_missing_count: winner.opening_or_final_missing_count,
        token_limit_count: winner.token_limit_count,
        mean_word_error_rate: winner.mean_word_error_rate,
        maximum_word_error_rate: winner.maximum_word_error_rate,
        mean_voice_similarity: winner.mean_voice_similarity,
        minimum_voice_similarity: winner.minimum_voice_similarity,
        voice_below_minimum_count: winner.voice_below_minimum_count,
        mean_spoken_wpm: winner.mean_spoken_wpm,
        listen_review_unit_count: winner.listen_review_unit_count,
      } : null,
      listening_proof_status: sources.listening_proof.value.status,
    },
    provider_replay: {
      creative_submissions_performed: replay.creative_submissions_performed,
      provider: providerManifest.provider,
      model_id: providerManifest.model_id,
      model_revision: providerManifest.model_revision,
      unit_count: providerManifest.unit_count,
      provider_manifest_status: providerManifest.status,
      quality_contract_status: qualityContractValidation.status,
      spoken_text_lineage_status: textIrValidation.status,
      spoken_text_lineage_component_count: lineageComponentCount,
      spoken_text_transformation_receipt_count: (textIr.units ?? []).reduce(
        (sum, unit) => sum + Number(unit.transformation_receipt_count ?? 0),
        0,
      ),
      provider_request_text_mismatch_count: requestTextMismatchUnits.length,
      performance_metadata_leak_count: performanceMetadataLeakUnits.length,
      unit_delivery_status: unitDelivery.status,
      full_stream_status: fullStream.status,
      full_stream_word_error_rate: fullStream.primary_transcript_qa?.word_error_rate,
      exact_listen_item_count: Number(exactListen.item_count ?? 0),
      order_status: fullStream.order_qa?.status,
      semantic_join_status: fullStream.join_qa?.status,
      semantic_join_count: fullStream.join_qa?.boundary_count,
      expected_sample_count: stitch.sample_accounting?.expected_sample_count,
      actual_sample_count: stitch.sample_accounting?.actual_sample_count,
      exact_sample_accounting: stitch.sample_accounting?.exact_sample_accounting,
      reference_count: continuity.reference_count,
      candidate_count: continuity.candidate_count,
      voice_continuity_status: continuity.status,
      mean_voice_similarity: continuity.report?.candidate_aggregate?.mean_cosine_similarity,
      minimum_voice_similarity: continuity.report?.candidate_aggregate?.minimum_cosine_similarity,
      calibrated_warning_threshold: continuity.report?.warning_below_cosine_similarity,
      calibrated_hard_threshold: continuity.report?.minimum_cosine_similarity,
      mastering_status: mastering.status,
      integrated_lufs: mastering.measured_integrated_lufs,
      true_peak_dbtp: mastering.measured_true_peak_dbtp,
      duration_sec: mastering.output_probe?.duration_sec,
      duration_delta_ms: mastering.duration_delta_ms,
      mastered_audio_path: masteredPath,
      mastered_audio_sha256: masteredSha256,
      narrator_only_audio_bed_status: audioBed.status,
      narrator_only_master_passthrough: audioBed.mix?.mastering?.passthrough === true,
      render_input_path: renderInputPath,
      render_input_sha256: renderInputSha256,
      render_input_lossless: audioBed.mix?.render_input_lossless === true,
      render_master_reuse_status: renderMasterReuse.status,
      render_master_reuse_findings: renderMasterReuse.findings,
    },
    source_artifacts: Object.fromEntries(
      Object.entries(sources).map(([key, row]) => [key, {
        path: row.path,
        sha256: row.sha256,
      }]),
    ),
    blockers,
  };
  const audit = {
    ...auditBase,
    audit_sha256: sha256Value(auditBase),
  };
  const outputJson = path.resolve(
    flags.output ?? path.join(replayDir, "proof_audit.json"),
  );
  const outputMarkdown = path.resolve(
    flags.markdown ?? path.join(replayDir, "proof_audit.md"),
  );
  const replayMetrics = audit.provider_replay;
  const winnerMetrics = audit.bakeoff.winner_metrics ?? {};
  const markdown = `# Narration Quality V2 Proof Audit

Status: **${audit.status}**

${audit.conclusion}

## Real Qwen Bakeoff

- Winner: \`${audit.bakeoff.winner}\`
- Mean unit WER: \`${winnerMetrics.mean_word_error_rate}\`
- Maximum unit WER: \`${winnerMetrics.maximum_word_error_rate}\`
- Opening/final missing units: \`${winnerMetrics.opening_or_final_missing_count}\`
- Token-limit units: \`${winnerMetrics.token_limit_count}\`
- Mean calibrated voice similarity: \`${winnerMetrics.mean_voice_similarity}\`
- Minimum calibrated voice similarity: \`${winnerMetrics.minimum_voice_similarity}\`
- Mean spoken pace: \`${winnerMetrics.mean_spoken_wpm} WPM\`
- Listen-review units: \`${winnerMetrics.listen_review_unit_count}\`

## Provider-Neutral Replay

- New creative submissions: \`${replayMetrics.creative_submissions_performed}\`
- Imported provider/model: \`${replayMetrics.provider}\` / \`${replayMetrics.model_id}\`
- Units: \`${replayMetrics.unit_count}\`
- Quality contract / exact text lineage: \`${replayMetrics.quality_contract_status}\` / \`${replayMetrics.spoken_text_lineage_status}\`
- Lineage components / request text mismatches / performance-metadata leaks: \`${replayMetrics.spoken_text_lineage_component_count}\` / \`${replayMetrics.provider_request_text_mismatch_count}\` / \`${replayMetrics.performance_metadata_leak_count}\`
- Full-stream WER: \`${replayMetrics.full_stream_word_error_rate}\`
- Exact-listen items: \`${replayMetrics.exact_listen_item_count}\`
- Unit order / semantic joins: \`${replayMetrics.order_status}\` / \`${replayMetrics.semantic_join_status}\`
- Exact sample accounting: \`${replayMetrics.actual_sample_count}/${replayMetrics.expected_sample_count}\`
- Mean/minimum calibrated voice similarity: \`${replayMetrics.mean_voice_similarity}\` / \`${replayMetrics.minimum_voice_similarity}\`
- Mastering: \`${replayMetrics.integrated_lufs} LUFS\`, \`${replayMetrics.true_peak_dbtp} dBTP\`, \`${replayMetrics.duration_delta_ms} ms\` duration delta
- Narrator-only bed preserved master: \`${replayMetrics.narrator_only_master_passthrough}\`
- Lossless render input / render remaster decision: \`${replayMetrics.render_input_lossless}\` / \`${replayMetrics.render_master_reuse_status}\`
- Mastered audio: \`${replayMetrics.mastered_audio_path}\`
- Audio SHA-256: \`${replayMetrics.mastered_audio_sha256}\`

Automated integrity is hash-verified. Subjective voice preference remains a human listening decision.
`;
  await writeAtomic(outputJson, `${JSON.stringify(audit, null, 2)}\n`);
  await writeAtomic(outputMarkdown, markdown);
  console.log(JSON.stringify({
    status: audit.status,
    output_json: outputJson,
    output_markdown: outputMarkdown,
    mastered_audio_path: masteredPath,
    mastered_audio_sha256: masteredSha256,
    blockers,
  }, null, 2));
  if (blockers.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
