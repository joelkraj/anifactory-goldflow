// Exact, no-listening reconciliation of a contextual full-stream ASR omission.
// This is deliberately narrower than a delivery waiver: the selected unit must
// independently contain the entire affected sentence in both ASR passes, its
// complete text in the confirmation pass, and the same PCM must reach the
// retained raw stitch and mastered confirmation window.
import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256File } from "./file-hash.mjs";
import { fullStreamReviewScope } from "./narration-full-stream-manual-review.mjs";

export const CONTEXTUAL_ASR_SCHEMA = "goldflow_narration_full_stream_contextual_asr_v1";
const need = (ok, message) => { if (!ok) throw new Error(`Contextual ASR reconciliation: ${message}.`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const words = (text) => String(text ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const includesWords = (haystack, needle) => {
  const all = words(haystack); const part = words(needle);
  return part.length > 1 && all.some((_, i) => same(all.slice(i, i + part.length), part));
};
const exactWords = (a, b) => same(words(a), words(b));

async function bound(file, sha256, label, json = false) {
  need(path.isAbsolute(file ?? "") && /^[a-f0-9]{64}$/u.test(sha256 ?? ""), `${label} path/hash missing`);
  need(await sha256File(file).catch(() => null) === sha256, `${label} hash changed`);
  return json ? JSON.parse(await fs.readFile(file, "utf8")) : null;
}

// Read only the RIFF header and requested frames, even for a multi-hour master.
async function pcmInfo(file) {
  const handle = await fs.open(file, "r");
  try {
    const header = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    need(bytesRead >= 44 && header.toString("ascii", 0, 4) === "RIFF"
      && header.toString("ascii", 8, 12) === "WAVE", "unsupported WAV container");
    let format = null; let data = null;
    for (let at = 12; at + 8 <= bytesRead;) {
      const size = header.readUInt32LE(at + 4);
      const tag = header.toString("ascii", at, at + 4);
      if (tag === "fmt " && at + 24 <= bytesRead) {
        format = { codec: header.readUInt16LE(at + 8), channels: header.readUInt16LE(at + 10),
          rate: header.readUInt32LE(at + 12), bits: header.readUInt16LE(at + 22) };
      }
      if (tag === "data") { data = { offset: at + 8, bytes: size }; break; }
      at += 8 + size + (size % 2);
    }
    const stat = await handle.stat();
    need(format?.codec === 1 && format.channels === 1 && format.bits === 16
      && format.rate === 24000 && data && data.offset + data.bytes <= stat.size
      && data.bytes % 2 === 0, "expected 24 kHz mono 16-bit PCM WAV");
    return { ...data, frames: data.bytes / 2, rate: format.rate };
  } finally { await handle.close(); }
}

// Shared by narrowly scoped retained-audio reviews. Exporting these does not
// change the existing contextual-omission decision or its evidence contract.
export { pcmInfo };

async function pcm(file, start, count, info = null) {
  const meta = info ?? await pcmInfo(file);
  need(Number.isInteger(start) && Number.isInteger(count) && start >= 0
    && count > 0 && start + count <= meta.frames, "PCM slice out of bounds");
  const handle = await fs.open(file, "r");
  try {
    const bytes = Buffer.alloc(count * 2);
    const result = await handle.read(bytes, 0, bytes.length, meta.offset + start * 2);
    need(result.bytesRead === bytes.length, "PCM slice truncated");
    return bytes;
  } finally { await handle.close(); }
}
export { pcm };

function correlation(a, b) {
  need(a.length === b.length && a.length % 2 === 0, "PCM correlation length mismatch");
  const n = a.length / 2;
  let ax = 0; let by = 0; let aa = 0; let bb = 0; let ab = 0;
  for (let i = 0; i < n; i++) {
    const x = a.readInt16LE(i * 2); const y = b.readInt16LE(i * 2);
    ax += x; by += y; aa += x * x; bb += y * y; ab += x * y;
  }
  const left = aa - ax * ax / n; const right = bb - by * by / n;
  return left > 0 && right > 0 ? (ab - ax * by / n) / Math.sqrt(left * right) : 0;
}
export { correlation };

export async function loadContextualAsrReconciliation({ evidencePath, currentReportPath,
  currentStitchReportPath = null, currentUnitDeliveryPath = null,
  revalidateApplied = false } = {}) {
  const evidenceSha256 = await sha256File(evidencePath);
  const evidence = await bound(evidencePath, evidenceSha256, "evidence", true);
  need(evidence.schema === CONTEXTUAL_ASR_SCHEMA && evidence.status === "reviewed_evidence"
    && evidence.human_listening_performed === false
    && evidence.synthesis_authorized === false, "unsupported evidence or claimed listening/synthesis");
  need(!revalidateApplied || currentReportPath === evidence.prior_full_stream_qa_path,
    "applied validation must use the immutable prior report");
  need(revalidateApplied || path.resolve(currentReportPath) !== path.resolve(evidence.prior_full_stream_qa_path),
    "prior report must be an immutable snapshot");
  const prior = await bound(evidence.prior_full_stream_qa_path,
    evidence.prior_full_stream_qa_sha256, "prior full-stream report", true);
  need(await sha256File(currentReportPath) === evidence.prior_full_stream_qa_sha256,
    "current full-stream report differs from evidence");
  const scope = fullStreamReviewScope(prior);
  const target = scope.filter((row) => row.finding_sha256 === evidence.finding_sha256);
  need(target.length === 1 && target[0].finding.code === "narration_confirmed_word_omission"
    && target[0].finding.severity === "blocker", "only one exact word-omission finding is admissible");
  const { finding } = target[0];
  const window = prior.confirmation_windows.find((row) =>
    row.window_id === target[0].window.window_id);
  need(evidence.confirmation_window_id === window.window_id
    && evidence.confirmation_window_sha256 === window.audio_sha256
    && evidence.confirmation_window_binding_sha256 === window.binding_sha256
    && finding.unit_ids.includes(evidence.unit_id), "finding/window/unit binding differs");
  need(scope.filter((row) => row.window.window_id === window.window_id).length === 1,
    "another lexical blocker shares the target window");
  const passage = String(evidence.affected_passage_text ?? "");
  need(passage && includesWords(window.intended_text, passage)
    && (finding.intended_tokens ?? []).every((token) => words(passage).includes(words(token)[0])),
  "affected passage does not cover the exact omitted word");
  need(!includesWords(window.primary_recognized_text, passage)
    && !includesWords(window.confirmation_recognized_text, passage),
  "the full-stream discrepancy is no longer present");
  const manifest = await bound(evidence.provider_manifest_path,
    evidence.provider_manifest_sha256, "provider manifest", true);
  const delivery = await bound(evidence.unit_delivery_path,
    evidence.unit_delivery_sha256, "unit delivery", true);
  if (currentUnitDeliveryPath && !revalidateApplied) {
    need(await sha256File(currentUnitDeliveryPath) === evidence.unit_delivery_sha256,
      "current unit delivery differs from immutable evidence");
  }
  const stitch = await bound(evidence.stitch_report_path,
    evidence.stitch_report_sha256, "stitch report", true);
  if (currentStitchReportPath && !revalidateApplied) {
    need(await sha256File(currentStitchReportPath) === evidence.stitch_report_sha256,
      "current stitch report differs from immutable evidence");
  }
  need(prior.provider_output_manifest_file_sha256 === evidence.provider_manifest_sha256
    && prior.source_script_hash === stitch.source_script_hash
    && prior.narration_generation_plan_sha256 === stitch.narration_generation_plan_sha256
    && prior.audio_sha256 === stitch.final_wav_sha256
    && prior.audio_path === stitch.final_wav_path
    && stitch.sample_accounting?.status === "passed"
    && stitch.sample_accounting.exact_sample_accounting === true
    && stitch.stitch_qa_status === "passed", "current manifest/stitch lineage differs");
  const unit = (manifest.units ?? []).find((row) => row.unit_id === evidence.unit_id);
  const qa = (delivery.units ?? []).find((row) => row.unit_id === evidence.unit_id);
  const segments = stitch.segments ?? [];
  const index = segments.findIndex((row) => row.unit_id === evidence.unit_id);
  need(unit && qa && index >= 0 && segments.filter((row) => row.unit_id === evidence.unit_id).length === 1
    && unit.audio_sha256 === qa.audio_sha256
    && unit.spoken_text_sha256 === qa.intended_text_sha256
    && qa.audio_sha256 === segments[index].raw_audio_sha256
    && unit.audio_path === segments[index].raw_audio_path
    && qa.decision?.blockers?.length === 0
    && qa.decision?.confirmation_decision?.status === "passed", "selected unit lineage/QA is not clean");
  need(includesWords(qa.intended_text, passage)
    && includesWords(qa.primary_recognized_text, passage)
    && includesWords(qa.confirmation_recognized_text, passage)
    && exactWords(qa.intended_text, qa.confirmation_recognized_text)
    && qa.confirmation_transcript_qa?.deletions === 0
    && qa.confirmation_transcript_qa?.insertions === 0
    && qa.confirmation_transcript_qa?.substitutions === 0,
  "selected unit lacks dual-ASR passage and exact complete confirmation");
  await Promise.all([
    bound(unit.audio_path, unit.audio_sha256, "selected unit WAV"),
    bound(segments[index].prepared_audio_path, segments[index].prepared_audio_sha256, "prepared unit WAV"),
    bound(stitch.raw_output_path, stitch.raw_output_sha256, "raw stitch WAV"),
    bound(prior.audio_path, prior.audio_sha256, "master WAV"),
    bound(window.audio_path, window.audio_sha256, "confirmation window WAV"),
  ]);
  const sourceInfo = await pcmInfo(prior.audio_path);
  const windowInfo = await pcmInfo(window.audio_path);
  need(window.sample_rate_hz === sourceInfo.rate && window.sample_count === windowInfo.frames
    && window.end_sample_exclusive - window.start_sample === window.sample_count
    && (await pcm(prior.audio_path, window.start_sample, window.sample_count, sourceInfo))
      .equals(await pcm(window.audio_path, 0, window.sample_count, windowInfo)),
  "confirmation window PCM differs from current master range");
  let origin = 0;
  for (let i = 0; i < index; i++) {
    const item = segments[i];
    await bound(item.prepared_audio_path, item.prepared_audio_sha256, `preceding prepared unit ${i}`);
    const info = await pcmInfo(item.prepared_audio_path);
    need((stitch.boundaries?.[i]?.after_unit_id === item.unit_id)
      && stitch.boundaries[i].before_unit_id === segments[i + 1].unit_id
      && Number.isInteger(stitch.boundaries[i].gap_sample_count), "stitch boundary order changed");
    origin += info.frames + stitch.boundaries[i].gap_sample_count;
  }
  const unitInfo = await pcmInfo(unit.audio_path);
  const preparedInfo = await pcmInfo(segments[index].prepared_audio_path);
  const rawInfo = await pcmInfo(stitch.raw_output_path);
  need(unitInfo.frames === preparedInfo.frames
    && rawInfo.frames === stitch.sample_accounting.actual_sample_count,
  "stitch sample accounting changed");
  const start = evidence.excerpt_start_sample_in_unit;
  const end = evidence.excerpt_end_sample_in_unit;
  need(start === 0 && end === unitInfo.frames
    && origin + start >= window.start_sample
    && origin + end <= window.end_sample_exclusive,
  "entire selected unit must lie inside the exact confirmation window");
  const count = end - start;
  const selectedPcm = await pcm(unit.audio_path, start, count, unitInfo);
  need(selectedPcm.equals(await pcm(segments[index].prepared_audio_path, start, count, preparedInfo))
    && selectedPcm.equals(await pcm(stitch.raw_output_path, origin + start, count, rawInfo)),
  "selected passage was altered or omitted by stitch");
  const masterPcm = await pcm(prior.audio_path, origin + start, count, sourceInfo);
  const score = correlation(selectedPcm, masterPcm);
  need(score >= 0.98, "selected passage does not match mastered waveform");
  return { evidence, evidence_path: evidencePath, evidence_sha256: evidenceSha256,
    prior, scope, target: target[0], waveform_correlation: score,
    stitched_origin_sample: origin };
}

export function applyContextualAsrReconciliation({ fullStream, reconciliation } = {}) {
  const prior = reconciliation.prior;
  const current = { ...prior, ...fullStream, status: fullStream.decision?.status,
    blockers: fullStream.decision?.blockers };
  need(same(fullStreamReviewScope(current), reconciliation.scope),
    "current blockers/windows changed after reconciliation");
  const target = reconciliation.target;
  const receipt = { schema: CONTEXTUAL_ASR_SCHEMA,
    evidence_path: reconciliation.evidence_path,
    evidence_sha256: reconciliation.evidence_sha256,
    finding_sha256: target.finding_sha256, unit_id: reconciliation.evidence.unit_id,
    confirmation_window_id: target.window.window_id,
    unit_delivery_sha256: reconciliation.evidence.unit_delivery_sha256,
    human_listening_performed: false, synthesis_authorized: false,
    waveform_correlation: reconciliation.waveform_correlation };
  const apply = (decision, local = false) => {
    const matches = (row) => same(row, local ? (({ confirmation_window_id, unit_ids,
      unit_id, boundary_id, ...rest }) => rest)(target.finding) : target.finding);
    const found = (decision.blockers ?? []).filter(matches);
    need(found.length === 1, "target finding is no longer uniquely blocked");
    const blockers = decision.blockers.filter((row) => !matches(row));
    const warnings = [...(decision.warnings ?? []), { ...found[0], severity: "warning",
      original_severity: "blocker", contextual_asr_evidence_sha256: reconciliation.evidence_sha256,
      disposition: "unit_dual_asr_and_exact_waveform_corroboration" }];
    return { ...decision, blockers, warnings,
      status: blockers.length ? "blocked" : "passed_with_warnings" };
  };
  return { ...fullStream, decision: apply(fullStream.decision),
    confirmation_windows: fullStream.confirmation_windows.map((window) =>
      window.window_id === target.window.window_id
        ? { ...window, decision: apply(window.decision, true) } : window),
    full_stream_contextual_asr: receipt };
}

export async function validateAppliedContextualAsrReconciliation(report) {
  const receipt = report?.full_stream_contextual_asr;
  if (!receipt) {
    need(!(report?.warnings ?? []).some((row) => row.contextual_asr_evidence_sha256),
      "warning has no evidence receipt");
    return;
  }
  const evidence = await bound(receipt.evidence_path, receipt.evidence_sha256,
    "applied evidence", true);
  const reconciliation = await loadContextualAsrReconciliation({
    evidencePath: receipt.evidence_path,
    currentReportPath: evidence.prior_full_stream_qa_path, revalidateApplied: true });
  const expected = applyContextualAsrReconciliation({
    fullStream: reconciliation.prior, reconciliation });
  need(same(expected.decision, report.decision)
    && same(expected.confirmation_windows, report.confirmation_windows)
    && same(expected.full_stream_contextual_asr, receipt)
    && same(expected.decision.blockers, report.blockers)
    && same(expected.decision.warnings, report.warnings)
    && expected.decision.status === report.status
    && report.audio_sha256 === reconciliation.prior.audio_sha256
    && report.provider_output_manifest_file_sha256 === reconciliation.prior.provider_output_manifest_file_sha256,
  "applied decision or current media differs from evidence");
}
