import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sha256File } from "../lib/file-hash.mjs";
import { fullStreamReviewScope, fullStreamWindowBindingSha256 } from "../lib/narration-full-stream-manual-review.mjs";
import { loadFullStreamSpacingBridge, applyFullStreamSpacingBridge,
  validateAppliedFullStreamSpacingBridge } from "../lib/narration-full-stream-spacing-bridge.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const wav = (samples) => {
  const data = Buffer.alloc(44 + samples.length * 2);
  data.write("RIFF", 0); data.writeUInt32LE(data.length - 8, 4);
  data.write("WAVEfmt ", 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(24000, 24); data.writeUInt32LE(48000, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write("data", 36); data.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, i) => data.writeInt16LE(sample, 44 + i * 2));
  return data;
};
const write = async (file, value) => { await fs.writeFile(file, json(value)); return sha256File(file); };

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-spacing-bridge-"));
try {
  const targetId = "unit-swords";
  const nextId = "unit-adrian";
  const targetText = "The swords disappeared. Every one.";
  const targetAsr = "The swords disappeared. Everyone.";
  const intended = `${targetText} Adrian looked at me.`;
  const recognized = `${targetAsr} Adrian looked at me.`;
  const sourcePath = path.join(dir, "script.md");
  await fs.writeFile(sourcePath, "Sever.\n\nThe swords disappeared.\n\nEvery one.\n\nAdrian looked at me.\n");
  const sourceHash = await sha256File(sourcePath);
  const target = Array.from({ length: 2400 }, (_, i) => Math.round(Math.sin(i / 17) * 9000));
  const prepared = target.slice(0, 2100); // The accepted stitch trims only the trailing raw tail.
  const following = Array.from({ length: 1400 }, (_, i) => Math.round(Math.sin(i / 23) * 7500));
  const joined = [...prepared, ...Array(120).fill(0), ...following];
  const targetPath = path.join(dir, "unit.wav");
  const preparedPath = path.join(dir, "prepared.wav");
  const followingPath = path.join(dir, "following.wav");
  const stitchPath = path.join(dir, "stitch.wav");
  const masterPath = path.join(dir, "master.wav");
  const windowPath = path.join(dir, "window.wav");
  await Promise.all([
    fs.writeFile(targetPath, wav(target)), fs.writeFile(preparedPath, wav(prepared)),
    fs.writeFile(followingPath, wav(following)), fs.writeFile(stitchPath, wav(joined)),
    fs.writeFile(masterPath, wav(joined)), fs.writeFile(windowPath, wav(joined)),
  ]);
  const targetHash = await sha256File(targetPath);
  const preparedHash = await sha256File(preparedPath);
  const stitchHash = await sha256File(stitchPath);
  const masterHash = await sha256File(masterPath);
  const windowHash = await sha256File(windowPath);
  const v2path = path.join(dir, "unit-review-v2.json");
  const span = { position: "final", relation: "spacing_join", expected_phrase: "Every one",
    primary_observed_phrase: "Everyone", confirmation_observed_phrase: "Everyone" };
  const v2 = { schema: "goldflow_narration_asr_orthography_extension_v2", status: "reviewed",
    human_listening_performed: false, units: [{ unit_id: targetId, selected_attempt: 1,
      audio_path: targetPath, audio_sha256: targetHash, synthesis_identity_sha256: hash("identity"),
      intended_text_sha256: hash(targetText), intended_text: targetText,
      primary_recognized_text: targetAsr, confirmation_recognized_text: targetAsr,
      spans: [span] }] };
  const v2hash = await write(v2path, v2);
  const v5path = path.join(dir, "unit-review-v5.json");
  const v5hash = await write(v5path, { schema: "goldflow_narration_asr_orthography_extension_v5",
    predecessor_evidence_path: v2path, predecessor_evidence_sha256: v2hash });
  const manifestPath = path.join(dir, "manifest.json");
  const manifestHash = await write(manifestPath, { units: [{ unit_id: targetId,
    attempt: 1, audio_path: targetPath, audio_sha256: targetHash,
    spoken_text_sha256: hash(targetText), synthesis_identity_sha256: hash("identity") }] });
  const deliveryPath = path.join(dir, "unit-qa.json");
  const unitQa = { units: [{ unit_id: targetId, audio_path: targetPath, audio_sha256: targetHash,
    intended_text_sha256: hash(targetText), intended_text: targetText,
    primary_recognized_text: targetAsr, confirmation_recognized_text: targetAsr,
    decision: { blockers: [], warnings: [{ code: "narration_reviewed_asr_orthography_equivalence",
      reviewed_spans: [span], evidence_sha256: v5hash,
      review_required: false, human_listening_performed: false }] } }] };
  const deliveryHash = await write(deliveryPath, unitQa);
  const stitchReportPath = path.join(dir, "stitch-report.json");
  const stitch = { source_script_hash: sourceHash, narration_generation_plan_sha256: hash("plan"),
    final_wav_path: masterPath, final_wav_sha256: masterHash,
    raw_output_path: stitchPath, raw_output_sha256: stitchHash,
    stitch_qa_status: "passed", sample_accounting: { status: "passed",
      exact_sample_accounting: true, actual_sample_count: joined.length },
    segments: [{ unit_id: targetId, raw_audio_path: targetPath, raw_audio_sha256: targetHash,
      prepared_audio_path: preparedPath, prepared_audio_sha256: preparedHash },
    { unit_id: nextId, raw_audio_path: followingPath,
      prepared_audio_path: followingPath, prepared_audio_sha256: await sha256File(followingPath) }],
    boundaries: [{ after_unit_id: targetId, before_unit_id: nextId, gap_sample_count: 120 }] };
  let stitchReportHash = await write(stitchReportPath, stitch);
  const stitchPriorPath = path.join(dir, "stitch-pre-bridge.json");
  await fs.copyFile(stitchReportPath, stitchPriorPath);
  const boundary = `${targetId}__${nextId}`;
  const commonFinding = { severity: "blocker", confirmation_window_id: "window-1",
    unit_ids: [targetId, nextId], boundary_id: boundary };
  const protectedFinding = { ...commonFinding,
    code: "narration_confirmed_tts_transcript_protected_value_mismatch",
    operations: [{ type: "substitution", intended: "num:1", recognized: "everyone" }] };
  const omissionFinding = { ...commonFinding,
    code: "narration_confirmed_word_omission", intended_tokens: ["every"] };
  const local = (finding) => (({ confirmation_window_id, unit_ids, boundary_id, ...rest }) => rest)(finding);
  const operations = ["the", "swords", "disappeared"].map((value) => ({
    type: "match", intended: value, recognized: value,
  }));
  operations.push({ type: "deletion", intended: "every", recognized: null },
    { type: "substitution", intended: "num:1", recognized: "everyone" });
  operations.push(...["adrian", "looked", "at", "me"].map((value) => ({
    type: "match", intended: value, recognized: value,
  })));
  const transcriptQa = { deletions: 1, insertions: 0, substitutions: 1, operations };
  const window = { window_id: "window-1", audio_path: windowPath, audio_sha256: windowHash,
    source_audio_path: masterPath, source_audio_sha256: masterHash,
    sample_rate_hz: 24000, sample_count: joined.length, start_sample: 0,
    end_sample_exclusive: joined.length, intended_text: intended,
    intended_text_sha256: hash(intended), unit_ids: [targetId, nextId],
    boundary_ids: [boundary], primary_recognized_text: recognized,
    confirmation_recognized_text: recognized,
    primary_transcript_qa: transcriptQa, confirmation_transcript_qa: transcriptQa,
    decision: { status: "blocked", blockers: [local(protectedFinding), local(omissionFinding)],
      warnings: [] } };
  window.binding_sha256 = fullStreamWindowBindingSha256(window);
  const reportPath = path.join(dir, "current-full-qa.json");
  const priorPath = path.join(dir, "prior-full-qa.json");
  const report = { schema: "goldflow_narration_full_stream_qa_v2", status: "blocked",
    source_script_hash: sourceHash, narration_generation_plan_sha256: hash("plan"),
    provider_output_manifest_file_sha256: manifestHash,
    audio_path: masterPath, audio_sha256: masterHash,
    primary_recognized_text: recognized, confirmation_recognized_text: recognized,
    asr_orthography_review: { evidence_path: v5path, evidence_sha256: v5hash },
    blockers: [protectedFinding, omissionFinding], warnings: [],
    decision: { status: "blocked", blockers: [protectedFinding, omissionFinding], warnings: [] },
    confirmation_windows: [window] };
  await write(reportPath, report);
  let priorHash = await write(priorPath, report);
  const evidencePath = path.join(dir, "evidence.json");
  const evidence = { schema: "goldflow_narration_full_stream_spacing_bridge_v1",
    status: "reviewed_evidence", human_listening_performed: false,
    synthesis_authorized: false, prior_full_stream_qa_path: priorPath,
    prior_full_stream_qa_sha256: priorHash,
    confirmation_window_id: window.window_id,
    confirmation_window_sha256: windowHash,
    confirmation_window_binding_sha256: window.binding_sha256,
    finding_sha256s: fullStreamReviewScope(report).map((row) => row.finding_sha256),
    source_script_path: sourcePath, source_script_sha256: sourceHash,
    source_excerpt: "Every one.", expected_phrase: "Every one", observed_phrase: "Everyone",
    unit_id: targetId, following_unit_id: nextId, unit_audio_sha256: targetHash,
    unit_v2_review_path: v2path, unit_v2_review_sha256: v2hash,
    provider_manifest_path: manifestPath, provider_manifest_sha256: manifestHash,
    unit_delivery_path: deliveryPath, unit_delivery_sha256: deliveryHash,
    stitch_report_path: stitchPriorPath, stitch_report_sha256: stitchReportHash };
  await write(evidencePath, evidence);
  const load = () => loadFullStreamSpacingBridge({ evidencePath,
    currentReportPath: reportPath, currentStitchReportPath: stitchReportPath,
    currentUnitDeliveryPath: deliveryPath });
  const bridge = await load();
  assert.equal(bridge.waveform_correlation, 1);
  const applied = applyFullStreamSpacingBridge({ fullStream: bridge.prior, bridge });
  assert.equal(applied.decision.status, "passed_with_warnings");
  assert.equal(applied.decision.blockers.length, 0);
  assert.equal(applied.decision.warnings.filter((row) => row.code
    === "narration_reviewed_full_stream_spacing_join").length, 2);
  assert.equal(applied.primary_recognized_text, recognized); // No ASR rewrite.
  assert.equal(applied.confirmation_recognized_text, recognized);
  await validateAppliedFullStreamSpacingBridge({ ...applied,
    status: applied.decision.status, blockers: applied.decision.blockers,
    warnings: applied.decision.warnings });
  // The canonical stitch report gains a receipt after finalization; its
  // immutable pre-review snapshot must still validate the applied decision.
  await write(stitchReportPath, { ...stitch,
    full_stream_spacing_bridge: applied.full_stream_spacing_bridge });
  await validateAppliedFullStreamSpacingBridge({ ...applied,
    status: applied.decision.status, blockers: applied.decision.blockers,
    warnings: applied.decision.warnings });
  await write(stitchReportPath, stitch);
  const reject = async (update, pattern) => {
    const variant = path.join(dir, `invalid-${Math.random()}.json`);
    await write(variant, { ...evidence, ...update });
    await assert.rejects(loadFullStreamSpacingBridge({ evidencePath: variant,
      currentReportPath: reportPath, currentStitchReportPath: stitchReportPath,
      currentUnitDeliveryPath: deliveryPath }), pattern);
  };
  await reject({ source_script_sha256: hash("stale") }, /approved source hash changed/);
  await reject({ provider_manifest_sha256: hash("stale") }, /provider manifest hash changed/);
  await reject({ prior_full_stream_qa_sha256: hash("stale") }, /prior full-stream report hash changed/);
  await reject({ confirmation_window_id: "wrong-window" }, /window, finding, and unit scope differs/);
  await reject({ expected_phrase: "Each one" }, /protected spacing join/);
  const lexicalReport = structuredClone(report);
  lexicalReport.confirmation_windows[0].primary_recognized_text =
    "The swords vanished. Everyone. Adrian looked at me.";
  await write(reportPath, lexicalReport);
  priorHash = await write(priorPath, lexicalReport);
  await write(evidencePath, { ...evidence, prior_full_stream_qa_sha256: priorHash });
  await assert.rejects(load(), /both ASR passes must differ only/);
  await write(reportPath, report);
  priorHash = await write(priorPath, report);
  evidence.prior_full_stream_qa_sha256 = priorHash;
  await write(evidencePath, evidence);
  const corrupted = prepared.map((sample) => -sample);
  await fs.writeFile(preparedPath, wav(corrupted));
  stitch.segments[0].prepared_audio_sha256 = await sha256File(preparedPath);
  stitchReportHash = await write(stitchReportPath, stitch);
  await fs.copyFile(stitchReportPath, stitchPriorPath);
  await write(evidencePath, { ...evidence, stitch_report_sha256: stitchReportHash });
  await assert.rejects(load(), /prepared audio is not an exact prefix/);
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
console.log("narration-full-stream-spacing-bridge-tests: passed");
