import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { canonicalQwenBatchSha256 } from "./qwen-liam-batch-contract.mjs";
import { narrationUnitTimeline } from "./narration-subjective-review.mjs";
import { narrationFinalizationUnitKey, narrationFinalizationStageKey } from "./narration-finalization-checkpoint.mjs";
import { validateNarrationStitchAccounting } from "./narration-boundary-editor.mjs";
import { exactNarrationListenReviewPacket, buildNarrationExactListenReviewDecision,
  validateNarrationExactListenReviewDecision, narrationExactListenReviewDecisionSha256,
  NARRATION_EXACT_LISTEN_ATTESTATION } from "./narration-delivery-quality.mjs";

export const PILOT_RAW_NARRATION_REVIEW_ATTESTATION = "entire_raw_proof_narration_listened_end_to_end";
export const PILOT_RAW_NARRATION_REVIEW_SCHEMA = "goldflow_avatar_pilot_raw_narration_review_v1";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => a === undefined || b === undefined ? a === b : canonicalQwenBatchSha256(a) === canonicalQwenBatchSha256(b);
const need = (ok, message) => { if (!ok) throw new Error(`Pilot raw narration review blocked: ${message}`); };
const exactIds = (rows, ids) => Array.isArray(rows) && same(rows.map((row) => row.unit_id), ids);
const integer = (value) => Number.isInteger(value) && value >= 0;
async function read(ref, json = true) {
  need(same(Object.keys(ref ?? {}).sort(), ["path", "sha256"])
    && path.isAbsolute(ref?.path ?? "") && /^[a-f0-9]{64}$/u.test(ref?.sha256 ?? ""), "exact artifact binding required");
  const stat = await fs.lstat(ref.path);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.size <= (json ? 32 : 512) * 1024 * 1024,
    "review inputs must be bounded regular files");
  need(await fs.realpath(ref.path) === ref.path, "review inputs cannot use symlink aliases");
  const bytes = await fs.readFile(ref.path);
  need(hash(bytes) === ref.sha256, `stale artifact: ${path.basename(ref.path)}`);
  return json ? JSON.parse(bytes.toString("utf8")) : bytes;
}

function pcm(bytes) {
  need(bytes.length >= 44 && bytes.toString("ascii", 0, 4) === "RIFF"
    && bytes.toString("ascii", 8, 12) === "WAVE" && bytes.readUInt32LE(4) + 8 === bytes.length, "invalid WAV container");
  let offset = 12, format = null, data = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8;
    need(start + size <= bytes.length, "truncated WAV chunk");
    if (id === "fmt ") {
      need(!format && size >= 16, "invalid WAV format chunk");
      format = { encoding: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2),
        rate: bytes.readUInt32LE(start + 4), byteRate: bytes.readUInt32LE(start + 8),
        blockAlign: bytes.readUInt16LE(start + 12), bits: bytes.readUInt16LE(start + 14) };
    } else if (id === "data") { need(data === null, "duplicate PCM payload"); data = bytes.subarray(start, start + size); }
    offset = start + size + size % 2;
  }
  need(offset === bytes.length && format?.encoding === 1 && format.channels === 1 && format.rate === 24000
    && format.bits === 16 && format.blockAlign === 2 && format.byteRate === 48000
    && data?.length > 0 && data.length % 2 === 0, "review mapping requires canonical mono 24kHz PCM16");
  return { data, samples: data.length / 2 };
}

async function inspect({ priorResultRef, priorResult, packetRef, packet, checkpointRef, checkpoint, rawAudioRef }) {
  const episodeDir = path.dirname(path.dirname(priorResultRef?.path ?? ""));
  need(priorResultRef?.path === path.join(episodeDir, "pilot_narration_work", "narration_producer_result.json"),
    "only the original pending producer receipt can authorize continuation");
  need(same(await read(priorResultRef), priorResult), "prior result differs from its original bytes");
  const identity = await read({ path: path.join(episodeDir, "run_identity.json"), sha256: priorResult.identity_sha256 });
  const { validatePilotNarrationPendingReviewResult } = await import("./avatar-pilot-narration-validation.mjs");
  const pending = await validatePilotNarrationPendingReviewResult(priorResult, { episodeDir, identity });
  need(pending.status === "pending_delivery_review", `original raw result is not valid pending review: ${JSON.stringify(pending.findings ?? [])}`);
  need(!priorResult.review_continuation && priorResult.finalized?.delivery_accepted === false
    && priorResult.finalized.mastering_status === "deferred_until_delivery_acceptance", "prior result cannot already be reviewed or mastered");
  const namespace = path.join(episodeDir, "pilot_narration_work", "full_finalization");
  need(packetRef?.path === path.join(namespace, `narration_exact_listen_review_packet_${identity.episode}.json`)
    && packetRef.path === priorResult.finalized.listen_review_packet_path
    && same(packetRef, pending.listen_review_packet), "exact-listen packet is not the original pending scope");
  need(checkpointRef?.path === path.join(namespace, "audio", `narration-finalization-checkpoint-${identity.episode}.json`)
    && checkpointRef.path === priorResult.finalized.checkpoint_path, "checkpoint is not the original full finalization checkpoint");
  need(same(rawAudioRef, priorResult.finalization_artifacts.audio) && same(rawAudioRef, pending.raw_audio)
    && rawAudioRef.path === priorResult.finalized.raw_wav && rawAudioRef.sha256 === priorResult.finalized.raw_wav_sha256,
  "reviewed raw audio differs from the original pending take");
  need(same(await read(packetRef), packet) && same(await read(checkpointRef), checkpoint), "packet or checkpoint differs from bound bytes");
  const raw = pcm(await read(rawAudioRef, false));
  const plan = await read(priorResult.generation_plan), manifest = await read(priorResult.provider_output_manifest);
  const delivery = await read(priorResult.finalization_artifacts.unit_delivery_qa);
  const stitchReport = await read(priorResult.finalization_artifacts.stitch_report);
  const phase = priorResult.finalized.phase_context;
  for (const [key, expected] of Object.entries({ phase: "full_pilot", outputNamespace: namespace,
    unitIds: priorResult.unit_ids, identitySha256: priorResult.identity_sha256,
    sourceScriptSha256: priorResult.source_script_sha256, generationPlanFileSha256: priorResult.generation_plan.sha256,
    providerManifestFileSha256: priorResult.provider_output_manifest.sha256,
    preSynthesisGatePath: priorResult.pre_synthesis_gate.path, preSynthesisGateFileSha256: priorResult.pre_synthesis_gate.sha256,
    textIrPath: priorResult.spoken_text_ir.path, textIrFileSha256: priorResult.spoken_text_ir.sha256,
    spokenTextAuditPath: priorResult.spoken_text_audit.path, spokenTextAuditFileSha256: priorResult.spoken_text_audit.sha256,
    acceptedOpening: priorResult.accepted_opening,
  })) need(same(phase?.[key], expected), `original finalization phase context changed: ${key}`);
  need(same(priorResult.finalized.finalization_scope, stitchReport.finalization_scope), "original full finalization scope changed");
  const sourceHashes = (await read(priorResult.pre_synthesis_gate)).bindings.source_artifact_hashes;
  const externalSourceKeys = Object.keys(sourceHashes).filter((key) => !["script_clean_sha256", "run_identity_sha256"].includes(key));
  need(same(Object.keys(phase.sourceArtifacts ?? {}).sort(), externalSourceKeys.sort()), "original source-artifact scope changed");
  for (const key of externalSourceKeys) {
    need(phase.sourceArtifacts[key]?.sha256 === sourceHashes[key], `source artifact differs from the frozen gate: ${key}`);
    await read(phase.sourceArtifacts[key]);
  }
  const qualityHash = identity.narration_quality_contract.contract_sha256;
  const ids = plan.units.map((unit) => unit.unit_id);
  need(exactIds(delivery.units, ids) && exactIds(manifest.units, ids), "full delivery and manifest unit order must match the frozen plan");
  const canonicalPacket = exactNarrationListenReviewPacket({ rows: delivery.units,
    generationPlanSha256: plan.plan_sha256, generationPlanFileSha256: priorResult.generation_plan.sha256,
    qualityContractSha256: qualityHash });
  need(packet.item_count > 0 && same(packet, canonicalPacket), "packet does not enumerate the exact original review-required warnings");
  const context = checkpoint.context ?? {};
  need(checkpoint.schema === "goldflow_narration_finalization_checkpoint_v1" && checkpoint.status === "complete"
    && same(Object.keys(checkpoint.units ?? {}), ids) && !checkpoint.stages?.mastering,
  "checkpoint must retain every original unit and have no prior mastering stage");
  for (const [key, expected] of Object.entries({
    finalization_scope: stitchReport.finalization_scope,
    narration_generation_plan_sha256: plan.plan_sha256,
    narration_generation_plan_file_sha256: priorResult.generation_plan.sha256,
    provider_output_manifest_sha256: manifest.manifest_sha256,
    provider_output_manifest_file_sha256: priorResult.provider_output_manifest.sha256,
    narration_quality_contract_sha256: qualityHash,
    ...Object.fromEntries(["provider", "model_id", "model_revision", "voice_id", "voice_sha256", "voice_continuity_contract"].map((key) => [key, manifest[key]])),
  })) need(expected != null && same(context[key], expected), `checkpoint context changed: ${key}`);
  const keys = manifest.units.map((unit) => narrationFinalizationUnitKey({ unit, qualityContractSha256: qualityHash,
    provider: manifest.provider, modelId: manifest.model_id, modelRevision: manifest.model_revision,
    voiceId: manifest.voice_id, voiceSha256: manifest.voice_sha256, voiceContinuityContract: manifest.voice_continuity_contract }));
  for (const [index, unit] of manifest.units.entries()) {
    const cached = checkpoint.units[unit.unit_id];
    need(cached.unit_key === keys[index] && cached.audio_sha256 === unit.audio_sha256
      && cached.spoken_text_sha256 === unit.spoken_text_sha256 && same(cached.delivery_row, delivery.units[index]),
    `checkpoint original unit identity/QA changed: ${unit.unit_id}`);
  }
  const stage = checkpoint.stages.semantic_stitch;
  need(stage?.status === "passed" && stage.input_key === narrationFinalizationStageKey("semantic_stitch", {
    ordered_unit_keys: keys, quality_contract_sha256: qualityHash, stitch_sample_rate_hz: 24000,
    alignment_policy: "narration_alignment_safe_semantic_stitch_v2",
  }), "semantic stitch checkpoint key is stale");
  const stitch = stage.payload?.stitch;
  need(stage.payload.raw_wav_path === rawAudioRef.path && stage.payload.raw_wav_sha256 === rawAudioRef.sha256
    && stitch?.status === "passed" && exactIds(stitch.prepared_inputs, ids)
    && exactIds(stitchReport.segments, ids) && same(stitch.boundaries, stitchReport.boundaries)
    && same(stitch.sample_accounting, stitchReport.sample_accounting), "checkpoint stitch differs from the original raw stream/report");
  need(stitch.policy?.version === "narration_alignment_safe_semantic_stitch_v2"
    && stitch.policy.quality_contract_sha256 === qualityHash && stitch.policy.sample_rate === 24000
    && stitch.policy.amplitude_only_trimming === false && stitch.policy.alignment_required_for_trimming === true
    && stitch.policy.fade_over_speech === false, "only the original alignment-safe speech-preserving stitch is reviewable");
  need(validateNarrationStitchAccounting({ preparedInputs: stitch.prepared_inputs, boundaries: stitch.boundaries,
    finalSampleCount: raw.samples }).status === "passed", "raw stream sample accounting failed");
  const timeline = narrationUnitTimeline({ plan, stitch, sampleRateHz: 24000 });
  need(timeline.total_sample_count === raw.samples && timeline.rows.length === ids.length,
    "raw full-stream listening does not cover the complete source timeline");
  const segments = [];
  for (const [index, window] of timeline.rows.entries()) {
    const source = manifest.units[index], prepared = stitch.prepared_inputs[index], segment = stitchReport.segments[index];
    const sourceBytes = await read({ path: source.audio_path, sha256: source.audio_sha256 }, false);
    const original = pcm(sourceBytes);
    const preparedRef = { path: prepared.prepared_wav, sha256: prepared.prepared_audio_sha256 };
    need(path.dirname(preparedRef.path) === path.join(namespace, "audio", "stitch-inputs-v2"), "prepared unit escaped the original stitch namespace");
    const preparedPcm = pcm(await read(preparedRef, false));
    need(prepared.source_wav === source.audio_path && segment.raw_audio_path === source.audio_path
      && segment.raw_audio_sha256 === source.audio_sha256 && segment.synthesis_identity_sha256 === source.synthesis_identity_sha256
      && segment.prepared_audio_path === preparedRef.path && segment.prepared_audio_sha256 === preparedRef.sha256,
    `raw/prepared source binding changed: ${source.unit_id}`);
    const start = prepared.trim_start_sample, end = prepared.trim_end_sample, edit = prepared.edge_edit_plan;
    need(integer(start) && integer(end) && start < end && end <= original.samples
      && prepared.source_sample_count === original.samples && prepared.sample_count === preparedPcm.samples
      && preparedPcm.samples === end - start && prepared.fade_sec === 0
      && (prepared.diagnostic_repair_tail_silence_sample_count ?? 0) === 0,
    `unsupported audio alteration in reviewed unit: ${source.unit_id}`);
    const edge = prepared.preparation_policy?.edge_alignment;
    need(edit?.status === "passed" && edit.mode === "alignment_safe_trim" && edit.alignment_used === true
      && edit.trim_start_sample === start && edit.trim_end_sample === end
      && edit.source_sample_count === original.samples && edit.retained_sample_count === preparedPcm.samples
      && edit.fade_in_samples === 0 && edit.fade_out_samples === 0 && Array.isArray(edit.blockers) && edit.blockers.length === 0
      && edge?.status === "passed" && edge.sample_rate_hz === 24000
      && integer(edge.first_speech_sample) && integer(edge.last_speech_sample_exclusive)
      && edge.first_speech_sample < edge.last_speech_sample_exclusive
      && start <= edge.first_speech_sample && end >= edge.last_speech_sample_exclusive
      && same(edge, delivery.units[index].edge_alignment), `reviewed segment omits an aligned speech edge: ${source.unit_id}`);
    const sourcePcm = original.data.subarray(start * 2, end * 2);
    const streamPcm = raw.data.subarray(window.start_sample * 2, window.end_sample_exclusive * 2);
    need(sourcePcm.equals(preparedPcm.data) && streamPcm.equals(preparedPcm.data),
      `reviewed raw stream does not contain the exact original prepared PCM: ${source.unit_id}`);
    const nextStart = index + 1 < timeline.rows.length ? timeline.rows[index + 1].start_sample : raw.samples;
    need(raw.data.subarray(window.end_sample_exclusive * 2, nextStart * 2).every((byte) => byte === 0),
      "unreviewed content appears in a declared semantic silence gap");
    segments.push({ unit_id: source.unit_id, source_audio: { path: source.audio_path, sha256: source.audio_sha256 },
      synthesis_identity_sha256: source.synthesis_identity_sha256, spoken_text_sha256: source.spoken_text_sha256,
      prepared_audio: preparedRef, source_start_sample: start, source_end_sample_exclusive: end,
      original_source_sample_count: original.samples, unplayed_source_head_samples: start,
      unplayed_source_tail_samples: original.samples - end,
      raw_start_sample: window.start_sample, raw_end_sample_exclusive: window.end_sample_exclusive,
      raw_start_sec: window.start_sec, raw_end_sec: window.end_sec, pcm_sha256: hash(preparedPcm.data),
      aligned_speech_fully_present: true, pcm_identity_verified: true,
      warning_codes: packet.items.find((item) => item.unit_id === source.unit_id)?.warning_codes ?? [],
    });
  }
  return { episodeDir, identity, plan, checkpoint, rawAudio: rawAudioRef, rawSampleCount: raw.samples, segments,
    packet, packetRef, priorResult, priorResultRef, checkpointRef, pending };
}

/** Build a truthful raw-content listening receipt. This never asserts that a
 * future mastered WAV or an unplayed trimmed tail was heard by the reviewer. */
export async function buildPilotRawNarrationReview({ priorResultRef, priorResult, packetRef, packet,
  checkpointRef, checkpoint, rawAudioRef, reviewer, note, attestation,
  reviewedAt = new Date().toISOString() } = {}) {
  need(typeof reviewer === "string" && reviewer.trim() && typeof note === "string" && note.trim()
    && attestation === PILOT_RAW_NARRATION_REVIEW_ATTESTATION && typeof reviewedAt === "string" && Number.isFinite(Date.parse(reviewedAt)),
  "explicit genuine complete-raw listening attestation, reviewer and note are required");
  const context = await inspect({ priorResultRef, priorResult, packetRef, packet, checkpointRef, checkpoint, rawAudioRef });
  const mapping = { schema: "goldflow_pilot_raw_stream_exact_listen_mapping_v1",
    operator_attestation: attestation, canonical_attestation: NARRATION_EXACT_LISTEN_ATTESTATION,
    basis: "full_raw_stream_alignment_preserved_unit_speech_and_endpoints",
    listened_audio: rawAudioRef, start_sample: 0, end_sample_exclusive: context.rawSampleCount, sample_rate_hz: 24000,
    original_unit_files_listened_in_isolation: false, unplayed_source_tails_claimed_listened: false,
    segments: context.segments.filter((row) => packet.unit_ids.includes(row.unit_id)) };
  let listenDecision = buildNarrationExactListenReviewDecision({ packet, reviewer: reviewer.trim(), reviewedAt,
    attestation: NARRATION_EXACT_LISTEN_ATTESTATION,
    decisions: packet.unit_ids.map((unit_id) => ({ unit_id, decision: "accept", note: note.trim() })) });
  listenDecision = { ...listenDecision, listening_attestation_mapping: mapping, mastered_audio_listened: false };
  listenDecision.decision_sha256 = narrationExactListenReviewDecisionSha256(listenDecision);
  need(validateNarrationExactListenReviewDecision(packet, listenDecision).status === "approved", "mapped exact-listen decision is invalid");
  const receipt = { schema: PILOT_RAW_NARRATION_REVIEW_SCHEMA, status: "approved_raw_delivery_only",
    reviewer: reviewer.trim(), note: note.trim(), reviewed_at: reviewedAt, attestation,
    identity_sha256: priorResult.identity_sha256, source_script_sha256: priorResult.source_script_sha256,
    prior_result: priorResultRef, checkpoint: checkpointRef, raw_audio: rawAudioRef, exact_listen_packet: packetRef,
    exact_listen_packet_sha256: packet.packet_sha256, exact_listen_decision_sha256: listenDecision.decision_sha256,
    generation_plan: priorResult.generation_plan, provider_output_manifest: priorResult.provider_output_manifest,
    spoken_text_ir: priorResult.spoken_text_ir, spoken_text_audit: priorResult.spoken_text_audit,
    original_finalization_artifacts: priorResult.finalization_artifacts,
    accepted_opening: priorResult.accepted_opening,
    full_program_unit_ids: priorResult.unit_ids, reviewed_warning_unit_ids: packet.unit_ids,
    raw_sample_count: context.rawSampleCount, sample_rate_hz: 24000, raw_duration_sec: context.rawSampleCount / 24000,
    raw_stream_segments: context.segments, listening_attestation_mapping: mapping,
    authorized_actions: ["reuse_immutable_raw_stitch", "stream_mastering", "technical_finalization_without_synthesis"],
    synthesis_authorized: false, restitch_authorized: false, mastered_audio_listened: false,
    mastered_subjective_review_status: "pending", production_eligible: false, publish_allowed: false };
  return { reviewReceipt: { ...receipt, review_sha256: canonicalQwenBatchSha256(receipt) }, listenDecision };
}

/** Validate before any continuation effects. The exact five-reference contract
 * authenticates immutable raw delivery only; mastered listening stays pending. */
export async function validatePilotNarrationReviewAuthorization({ reviewContinuation, episodeDir, identity } = {}) {
  need(same(Object.keys(reviewContinuation ?? {}).sort(), ["priorResult", "reviewReceipt", "listenDecision", "checkpoint", "rawAudio"].sort()),
    "review continuation requires exactly five bound artifacts");
  const reviewDir = path.join(episodeDir, "pilot_narration_work", "narration_review");
  need(reviewContinuation.priorResult.path === path.join(episodeDir, "pilot_narration_work", "narration_producer_result.json")
    && reviewContinuation.reviewReceipt.path === path.join(reviewDir, "raw_listening_approval.json")
    && reviewContinuation.listenDecision.path === path.join(reviewDir, "exact_listen_decision.json"),
  "review authorization paths do not match the dedicated immutable namespaces");
  const priorResult = await read(reviewContinuation.priorResult), reviewReceipt = await read(reviewContinuation.reviewReceipt);
  const listenDecision = await read(reviewContinuation.listenDecision), checkpoint = await read(reviewContinuation.checkpoint);
  const currentIdentity = await read({ path: path.join(episodeDir, "run_identity.json"), sha256: priorResult.identity_sha256 });
  need(same(identity, currentIdentity), "review authorization identity changed");
  const packetRef = reviewReceipt.exact_listen_packet, packet = await read(packetRef);
  const expected = await buildPilotRawNarrationReview({ priorResultRef: reviewContinuation.priorResult, priorResult,
    packetRef, packet, checkpointRef: reviewContinuation.checkpoint, checkpoint, rawAudioRef: reviewContinuation.rawAudio,
    reviewer: reviewReceipt.reviewer, note: reviewReceipt.note, attestation: reviewReceipt.attestation,
    reviewedAt: reviewReceipt.reviewed_at });
  need(same(reviewReceipt, expected.reviewReceipt) && same(listenDecision, expected.listenDecision),
    "raw approval or exact listening decision differs from the actual bound PCM/QA scope");
  return { priorResult, reviewReceipt, listenDecision, checkpoint, rawAudio: reviewContinuation.rawAudio,
    packet, packetRef, status: "authorized_technical_continuation_only", synthesis_authorized: false,
    mastered_audio_listened: false, mastered_subjective_review_status: "pending" };
}
