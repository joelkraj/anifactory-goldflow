// Carry a previously accepted, exact-unit spacing review across one retained
// full-stream confirmation window. This is an ASR orthography decision only:
// it neither edits audio/text nor claims that a person listened to the clip.
import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256File } from "./file-hash.mjs";
import { fullStreamReviewScope } from "./narration-full-stream-manual-review.mjs";
import { pcmInfo, pcm, correlation } from "./narration-full-stream-contextual-asr.mjs";

export const FULL_STREAM_SPACING_BRIDGE_SCHEMA = "goldflow_narration_full_stream_spacing_bridge_v1";
const need = (ok, message) => { if (!ok) throw new Error(`Full-stream spacing bridge: ${message}.`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const words = (value) => String(value ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const validHash = (value) => /^[a-f0-9]{64}$/u.test(String(value ?? ""));

async function bound(file, sha256, label, json = false) {
  need(path.isAbsolute(file ?? "") && validHash(sha256), `${label} path/hash missing`);
  need(await sha256File(file).catch(() => null) === sha256, `${label} hash changed`);
  return json ? JSON.parse(await fs.readFile(file, "utf8")) : null;
}

function oneSpacingJoin(intended, recognized, expected, observed) {
  const source = words(intended); const heard = words(recognized);
  const part = words(expected); const joined = words(observed);
  if (part.length !== 2 || joined.length !== 1
    || part.join("") !== joined[0] || heard.length !== source.length - 1) return false;
  const starts = source.flatMap((_, i) => same(source.slice(i, i + 2), part) ? [i] : []);
  return starts.length === 1
    && same([...source.slice(0, starts[0]), joined[0], ...source.slice(starts[0] + 2)], heard);
}

function comparatorHasOnlyJoin(qa, expected, observed) {
  const changes = (qa?.operations ?? []).filter((row) => row.type !== "match");
  const part = words(expected); const joined = words(observed)[0];
  return qa?.deletions === 1 && qa?.insertions === 0 && qa?.substitutions === 1
    && changes.length === 2 && changes[0].type === "deletion"
    && changes[0].intended === part[0] && changes[1].type === "substitution"
    // The transcript comparator protects the separate word "one" as num:1.
    && part[1] === "one" && changes[1].intended === "num:1"
    && changes[1].recognized === joined;
}

async function acceptedV2Review(prior, evidence) {
  let file = prior.asr_orthography_review?.evidence_path;
  let hash = prior.asr_orthography_review?.evidence_sha256;
  need(file && hash, "current unit orthography lineage is missing");
  const seen = new Set();
  for (let depth = 0; depth < 8; depth++) {
    need(!seen.has(file), "cyclic unit orthography lineage");
    seen.add(file);
    const row = await bound(file, hash, `orthography ancestor ${depth}`, true);
    if (row.schema === "goldflow_narration_asr_orthography_extension_v2") {
      need(file === evidence.unit_v2_review_path && hash === evidence.unit_v2_review_sha256
        && row.status === "reviewed" && row.human_listening_performed === false,
      "accepted V2 unit spacing review differs from the active lineage");
      return row;
    }
    need(row.predecessor_evidence_path && row.predecessor_evidence_sha256,
      "unit orthography lineage does not reach V2");
    file = row.predecessor_evidence_path;
    hash = row.predecessor_evidence_sha256;
  }
  throw new Error("Full-stream spacing bridge: unit orthography lineage is too deep.");
}

export async function loadFullStreamSpacingBridge({ evidencePath, currentReportPath,
  currentStitchReportPath = null, currentUnitDeliveryPath = null,
  revalidateApplied = false } = {}) {
  const evidenceSha256 = await sha256File(evidencePath);
  const evidence = await bound(evidencePath, evidenceSha256, "evidence", true);
  need(evidence.schema === FULL_STREAM_SPACING_BRIDGE_SCHEMA
    && evidence.status === "reviewed_evidence"
    && evidence.human_listening_performed === false
    && evidence.synthesis_authorized === false,
  "unsupported evidence or claimed listening/synthesis");
  need(revalidateApplied || path.resolve(currentReportPath) !== path.resolve(evidence.prior_full_stream_qa_path),
    "prior report must be an immutable snapshot");
  const prior = await bound(evidence.prior_full_stream_qa_path,
    evidence.prior_full_stream_qa_sha256, "prior full-stream report", true);
  need(await sha256File(currentReportPath) === evidence.prior_full_stream_qa_sha256,
    "current full-stream report differs from evidence");
  const scope = fullStreamReviewScope(prior);
  need(scope.length === 2 && same(scope.map((row) => row.finding.code).sort(), [
    "narration_confirmed_tts_transcript_protected_value_mismatch",
    "narration_confirmed_word_omission",
  ]) && scope[0].window.window_id === scope[1].window.window_id,
  "only the paired spacing-join findings in one window are admissible");
  const window = prior.confirmation_windows.find((row) => row.window_id === scope[0].window.window_id);
  need(window && evidence.confirmation_window_id === window.window_id
    && evidence.confirmation_window_sha256 === window.audio_sha256
    && evidence.confirmation_window_binding_sha256 === window.binding_sha256
    && same(evidence.finding_sha256s, scope.map((row) => row.finding_sha256))
    && window.unit_ids.length === 2 && window.boundary_ids.length === 1
    && window.unit_ids[0] === evidence.unit_id
    && window.unit_ids[1] === evidence.following_unit_id,
  "window, finding, and unit scope differs");
  const protectedFinding = scope.find((row) => row.finding.code.includes("protected_value"))?.finding;
  const omissionFinding = scope.find((row) => row.finding.code === "narration_confirmed_word_omission")?.finding;
  const expected = String(evidence.expected_phrase ?? "");
  const observed = String(evidence.observed_phrase ?? "");
  need(same(omissionFinding?.intended_tokens, [words(expected)[0]])
    && protectedFinding?.operations?.length === 1
    && protectedFinding.operations[0].type === "substitution"
    && protectedFinding.operations[0].intended === "num:1"
    && protectedFinding.operations[0].recognized === words(observed)[0]
    && comparatorHasOnlyJoin(window.primary_transcript_qa, expected, observed)
    && comparatorHasOnlyJoin(window.confirmation_transcript_qa, expected, observed)
    && oneSpacingJoin(window.intended_text, window.primary_recognized_text, expected, observed)
    && oneSpacingJoin(window.intended_text, window.confirmation_recognized_text, expected, observed),
  "both ASR passes must differ only by the same protected spacing join");
  await bound(evidence.source_script_path,
    evidence.source_script_sha256, "approved source");
  const sourceText = await fs.readFile(evidence.source_script_path, "utf8");
  need(prior.source_script_hash === evidence.source_script_sha256
    && String(evidence.source_excerpt ?? "").includes(expected)
    && sourceText.includes(evidence.source_excerpt)
    && window.intended_text.includes(evidence.source_excerpt),
  "approved source does not contain the exact affected passage");
  const v2 = await acceptedV2Review(prior, evidence);
  const manifest = await bound(evidence.provider_manifest_path,
    evidence.provider_manifest_sha256, "provider manifest", true);
  const delivery = await bound(evidence.unit_delivery_path,
    evidence.unit_delivery_sha256, "unit delivery", true);
  const stitch = await bound(evidence.stitch_report_path,
    evidence.stitch_report_sha256, "stitch report", true);
  need(prior.provider_output_manifest_file_sha256 === evidence.provider_manifest_sha256
    && prior.source_script_hash === stitch.source_script_hash
    && prior.narration_generation_plan_sha256 === stitch.narration_generation_plan_sha256
    && prior.audio_sha256 === stitch.final_wav_sha256
    && prior.audio_path === stitch.final_wav_path
    && stitch.stitch_qa_status === "passed"
    && stitch.sample_accounting?.status === "passed"
    && stitch.sample_accounting.exact_sample_accounting === true,
  "manifest/stitch/master lineage differs");
  if (currentStitchReportPath && !revalidateApplied) {
    need(await sha256File(currentStitchReportPath) === evidence.stitch_report_sha256,
      "current stitch report differs");
  }
  if (currentUnitDeliveryPath && !revalidateApplied) {
    need(await sha256File(currentUnitDeliveryPath) === evidence.unit_delivery_sha256,
      "current unit delivery differs");
  }
  const unit = (manifest.units ?? []).find((row) => row.unit_id === evidence.unit_id);
  const qa = (delivery.units ?? []).find((row) => row.unit_id === evidence.unit_id);
  const v2unit = (v2.units ?? []).find((row) => row.unit_id === evidence.unit_id);
  const segments = stitch.segments ?? [];
  const index = segments.findIndex((row) => row.unit_id === evidence.unit_id);
  need(unit && qa && v2unit && index >= 0
    && (manifest.units ?? []).filter((row) => row.unit_id === evidence.unit_id).length === 1
    && (delivery.units ?? []).filter((row) => row.unit_id === evidence.unit_id).length === 1
    && segments.filter((row) => row.unit_id === evidence.unit_id).length === 1
    && unit.audio_path === qa.audio_path && unit.audio_path === segments[index].raw_audio_path
    && unit.audio_sha256 === qa.audio_sha256 && unit.audio_sha256 === segments[index].raw_audio_sha256
    && unit.audio_path === v2unit.audio_path && unit.audio_sha256 === v2unit.audio_sha256
    && unit.attempt === v2unit.selected_attempt
    && unit.synthesis_identity_sha256 === v2unit.synthesis_identity_sha256
    && unit.spoken_text_sha256 === qa.intended_text_sha256
    && unit.spoken_text_sha256 === v2unit.intended_text_sha256
    && unit.audio_sha256 === evidence.unit_audio_sha256
    && qa.decision?.blockers?.length === 0,
  "selected unit differs from accepted V2 review or current stitch");
  const span = (v2unit.spans ?? []).find((row) => row.relation === "spacing_join"
    && row.expected_phrase === expected
    && row.primary_observed_phrase === observed
    && row.confirmation_observed_phrase === observed);
  need(span && v2unit.intended_text === qa.intended_text
    && v2unit.primary_recognized_text === qa.primary_recognized_text
    && v2unit.confirmation_recognized_text === qa.confirmation_recognized_text
    && oneSpacingJoin(qa.intended_text, qa.primary_recognized_text, expected, observed)
    && oneSpacingJoin(qa.intended_text, qa.confirmation_recognized_text, expected, observed)
    && qa.decision?.warnings?.some((row) => row.code === "narration_reviewed_asr_orthography_equivalence"
      && row.reviewed_spans?.some((item) => same(item, span))
      && row.evidence_sha256 === prior.asr_orthography_review.evidence_sha256
      && row.review_required === false && row.human_listening_performed === false),
  "selected unit's accepted spelling review is absent or changed");
  await Promise.all([
    bound(unit.audio_path, unit.audio_sha256, "selected unit WAV"),
    bound(segments[index].prepared_audio_path, segments[index].prepared_audio_sha256, "prepared unit WAV"),
    bound(stitch.raw_output_path, stitch.raw_output_sha256, "raw stitch WAV"),
    bound(prior.audio_path, prior.audio_sha256, "master WAV"),
    bound(window.audio_path, window.audio_sha256, "confirmation window WAV"),
  ]);
  const rawInfo = await pcmInfo(unit.audio_path);
  const preparedInfo = await pcmInfo(segments[index].prepared_audio_path);
  const stitchInfo = await pcmInfo(stitch.raw_output_path);
  const masterInfo = await pcmInfo(prior.audio_path);
  const windowInfo = await pcmInfo(window.audio_path);
  need(preparedInfo.frames <= rawInfo.frames
    && stitchInfo.frames === stitch.sample_accounting.actual_sample_count
    && window.sample_rate_hz === masterInfo.rate
    && window.sample_count === windowInfo.frames
    && window.end_sample_exclusive - window.start_sample === window.sample_count
    && (await pcm(prior.audio_path, window.start_sample, window.sample_count, masterInfo))
      .equals(await pcm(window.audio_path, 0, window.sample_count, windowInfo)),
  "window/master PCM or stitch accounting differs");
  const prepared = await pcm(segments[index].prepared_audio_path, 0, preparedInfo.frames, preparedInfo);
  need(prepared.equals(await pcm(unit.audio_path, 0, preparedInfo.frames, rawInfo)),
    "prepared audio is not an exact prefix of the selected unit");
  let origin = 0;
  for (let i = 0; i < index; i++) {
    const item = segments[i];
    await bound(item.prepared_audio_path, item.prepared_audio_sha256, `preceding prepared unit ${i}`);
    const info = await pcmInfo(item.prepared_audio_path);
    need(stitch.boundaries?.[i]?.after_unit_id === item.unit_id
      && stitch.boundaries[i].before_unit_id === segments[i + 1].unit_id
      && Number.isInteger(stitch.boundaries[i].gap_sample_count),
    "stitch boundary order changed");
    origin += info.frames + stitch.boundaries[i].gap_sample_count;
  }
  need(origin >= window.start_sample
    && origin + preparedInfo.frames <= window.end_sample_exclusive,
  "entire prepared unit is outside the confirmation window");
  need(prepared.equals(await pcm(stitch.raw_output_path, origin, preparedInfo.frames, stitchInfo)),
    "selected unit PCM is not preserved in the raw stitch");
  const score = correlation(prepared,
    await pcm(prior.audio_path, origin, preparedInfo.frames, masterInfo));
  need(score >= 0.98, "selected unit does not match the mastered waveform");
  return { evidence, evidence_path: evidencePath, evidence_sha256: evidenceSha256,
    prior, scope, window, waveform_correlation: score, stitched_origin_sample: origin };
}

export function applyFullStreamSpacingBridge({ fullStream, bridge } = {}) {
  const prior = bridge.prior;
  const current = { ...prior, ...fullStream, status: fullStream.decision?.status,
    blockers: fullStream.decision?.blockers };
  need(same(fullStreamReviewScope(current), bridge.scope),
    "full-stream findings changed after evidence validation");
  const receipt = { schema: FULL_STREAM_SPACING_BRIDGE_SCHEMA,
    evidence_path: bridge.evidence_path, evidence_sha256: bridge.evidence_sha256,
    confirmation_window_id: bridge.window.window_id,
    finding_sha256s: bridge.scope.map((row) => row.finding_sha256),
    unit_id: bridge.evidence.unit_id,
    unit_audio_sha256: bridge.evidence.unit_audio_sha256,
    unit_v2_review_sha256: bridge.evidence.unit_v2_review_sha256,
    unit_delivery_sha256: bridge.evidence.unit_delivery_sha256,
    stitch_report_sha256: bridge.evidence.stitch_report_sha256,
    waveform_correlation: bridge.waveform_correlation,
    stitched_origin_sample: bridge.stitched_origin_sample,
    human_listening_performed: false, synthesis_authorized: false,
    full_transcript_equivalence_claimed: false };
  const apply = (decision, local = false) => {
    const target = bridge.scope.map((row) => local
      ? (({ confirmation_window_id, unit_ids, unit_id, boundary_id, ...rest }) => rest)(row.finding)
      : row.finding);
    need(same(decision.blockers, target), "only the exact paired findings may be reviewed");
    const warnings = [...(decision.warnings ?? []), ...target.map((row) => ({
      ...row, severity: "warning", original_severity: "blocker",
      code: "narration_reviewed_full_stream_spacing_join",
      original_blocker_code: row.code,
      disposition: "accepted_unit_spacing_review_and_retained_waveform_corroboration",
      review_required: false, human_listening_performed: false,
      full_stream_spacing_bridge_evidence_sha256: bridge.evidence_sha256,
    }))];
    return { ...decision, blockers: [], warnings, status: "passed_with_warnings" };
  };
  return { ...fullStream, decision: apply(fullStream.decision),
    confirmation_windows: fullStream.confirmation_windows.map((window) =>
      window.window_id === bridge.window.window_id
        ? { ...window, decision: apply(window.decision, true) } : window),
    full_stream_spacing_bridge: receipt };
}

export async function validateAppliedFullStreamSpacingBridge(report) {
  const receipt = report?.full_stream_spacing_bridge;
  if (!receipt) {
    need(!(report?.warnings ?? []).some((row) => row.full_stream_spacing_bridge_evidence_sha256),
      "spacing warning has no evidence receipt");
    return;
  }
  const evidence = await bound(receipt.evidence_path, receipt.evidence_sha256,
    "applied evidence", true);
  const bridge = await loadFullStreamSpacingBridge({
    evidencePath: receipt.evidence_path,
    currentReportPath: evidence.prior_full_stream_qa_path,
    revalidateApplied: true,
  });
  const expected = applyFullStreamSpacingBridge({ fullStream: bridge.prior, bridge });
  need(same(expected.decision, report.decision)
    && same(expected.confirmation_windows, report.confirmation_windows)
    && same(expected.full_stream_spacing_bridge, receipt)
    && same(expected.decision.blockers, report.blockers)
    && same(expected.decision.warnings, report.warnings)
    && expected.decision.status === report.status
    && report.audio_sha256 === bridge.prior.audio_sha256
    && report.provider_output_manifest_file_sha256 === bridge.prior.provider_output_manifest_file_sha256,
  "applied decision or media differs from evidence");
}
