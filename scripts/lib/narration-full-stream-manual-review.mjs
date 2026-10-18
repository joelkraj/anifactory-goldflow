import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { sha256File } from "./file-hash.mjs";
import { NARRATION_DELIVERY_CONSENSUS_VERSION } from "./narration-delivery-quality.mjs";

export const FULL_STREAM_REVIEW_SCHEMA = "goldflow_narration_full_stream_manual_review_v1";
export const FULL_STREAM_REVIEW_ATTESTATION =
  "human_listened_to_each_bound_affected_passage_and_individually_decided";
const need = (condition, message) => {
  if (!condition) throw new Error(`Full-stream manual review: ${message}.`);
};
const hashValid = (value) => /^[a-f0-9]{64}$/u.test(String(value ?? ""));
const canonical = (value) => JSON.stringify(value, (_key, item) => (
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
    : item
));
const same = (left, right) => canonical(left) === canonical(right);
const execFile = promisify(execFileCallback);
const localFinding = ({ confirmation_window_id, unit_ids, unit_id, boundary_id, ...finding }) => finding;
export const fullStreamFindingSha256 = (finding) => createHash("sha256")
  .update(canonical(finding)).digest("hex");
export const fullStreamWindowBindingSha256 = (window) => createHash("sha256").update(JSON.stringify({
  source_audio_sha256: window.source_audio_sha256, start_sample: window.start_sample,
  end_sample_exclusive: window.end_sample_exclusive, intended_text_sha256: window.intended_text_sha256,
  unit_ids: window.unit_ids, boundary_ids: window.boundary_ids,
})).digest("hex");

// Listening cannot accept missing/corrupt media, order, alignment, sample-count,
// or join failures. Only exact window-backed delivery findings are reviewable.
const REVIEWABLE_CODES = new Set([
  "narration_confirmed_word_omission", "narration_confirmed_unexpected_word",
  "narration_confirmed_opening_word_missing", "narration_confirmed_final_word_missing",
  "narration_confirmed_contiguous_words_missing", "narration_confirmed_insertion_burst",
  "narration_confirmed_tts_transcript_protected_value_mismatch",
  "narration_confirmed_tts_transcript_protected_value_missing",
  "narration_confirmed_tts_transcript_unexpected_protected_value",
]);
const BINDING_FIELDS = [
  "source_script_hash", "narration_generation_plan_sha256",
  "narration_generation_plan_file_sha256", "narration_quality_contract_sha256",
  "audio_path", "audio_sha256", "intended_text_sha256", "transcript_comparison_version",
  "delivery_consensus_version",
];

async function boundFile(filePath, sha256, label, json = false) {
  need(path.isAbsolute(filePath ?? "") && hashValid(sha256), `${label} path/hash missing`);
  need(await sha256File(filePath).catch(() => null) === sha256, `${label} hash is stale`);
  return json ? JSON.parse(await fs.readFile(filePath, "utf8")) : null;
}

export function fullStreamReviewScope(report) {
  need(report?.schema === "goldflow_narration_full_stream_qa_v2"
    && report.status === "blocked", "a blocked full-stream report is required");
  const blockers = report.blockers ?? [];
  need(blockers.length && same(blockers, report.decision?.blockers), "current blocker set is missing or inconsistent");
  const windows = new Map((report.confirmation_windows ?? []).map((row) => [row.window_id, row]));
  need(windows.size === (report.confirmation_windows ?? []).length, "duplicate confirmation window IDs");
  const scope = blockers.map((finding) => {
    need(REVIEWABLE_CODES.has(finding.code), `non-delivery blocker ${finding.code} cannot be accepted by listening`);
    const window = windows.get(finding.confirmation_window_id);
    need(window && window.audio_path && hashValid(window.audio_sha256)
      && hashValid(window.binding_sha256), "blocker lacks its exact confirmation window");
    need(window.source_audio_path === report.audio_path
      && window.source_audio_sha256 === report.audio_sha256,
    "confirmation window source differs from the full stream");
    need(window.binding_sha256 === fullStreamWindowBindingSha256(window), "confirmation window binding hash is stale");
    need((window.decision?.blockers ?? []).some((row) => same(row, localFinding(finding))),
      "blocker is not present in its confirmation window");
    need(same(finding.unit_ids, window.unit_ids), "blocker unit scope differs from its window");
    need(finding.unit_id === (window.unit_ids.length === 1 ? window.unit_ids[0] : undefined)
      && finding.boundary_id === (window.boundary_ids.length === 1 ? window.boundary_ids[0] : undefined),
    "blocker unit/boundary aliases differ from its window");
    return {
      finding_sha256: fullStreamFindingSha256(finding),
      finding: structuredClone(finding),
      window: Object.fromEntries([
        "window_id", "audio_path", "audio_sha256", "binding_sha256", "source_audio_path",
        "source_audio_sha256", "sample_rate_hz", "sample_count", "start_sample",
        "end_sample_exclusive", "intended_text_sha256", "unit_ids", "boundary_ids",
      ].map((key) => [key, window[key]])),
    };
  });
  for (const window of windows.values()) {
    const globalFindings = blockers.filter((row) => row.confirmation_window_id === window.window_id).map(localFinding);
    need(same(globalFindings, window.decision?.blockers ?? []), "unreviewed local window blockers differ from global scope");
  }
  need(new Set(scope.map((row) => row.finding_sha256)).size === scope.length, "duplicate blockers");
  return scope;
}

async function verifyWindowSource(window) {
  need(Number.isInteger(window.start_sample) && window.start_sample >= 0
    && Number.isInteger(window.end_sample_exclusive) && window.end_sample_exclusive > window.start_sample
    && window.sample_count === window.end_sample_exclusive - window.start_sample
    && Number.isInteger(window.sample_rate_hz) && window.sample_rate_hz > 0,
  "confirmation window sample bounds are invalid");
  const decode = (file, filters = []) => execFile("ffmpeg", ["-v", "error", "-i", file, ...filters,
    "-ar", String(window.sample_rate_hz), "-ac", "1", "-acodec", "pcm_s16le", "-f", "s16le", "pipe:1"],
  { encoding: "buffer", maxBuffer: 32 * 1024 * 1024, timeout: 120000 });
  const [source, actual] = await Promise.all([
    decode(window.source_audio_path, ["-af", `atrim=start_sample=${window.start_sample}:end_sample=${window.end_sample_exclusive},asetpts=N/SR/TB`]),
    decode(window.audio_path),
  ]);
  need(source.stdout.length === window.sample_count * 2 && source.stdout.equals(actual.stdout),
    "confirmation window PCM does not match its exact current master sample range");
}

async function verifyListenedExcerpt(heard, window) {
  await boundFile(heard.path, heard.sha256, "listened audio");
  if (heard.sha256 === window.audio_sha256) {
    need(heard.start_sample_in_window === 0 && heard.end_sample_in_window === window.sample_count,
      "whole-window playback cannot claim a partial excerpt");
    return;
  }
  need(heard.encoding === "ffmpeg_libmp3lame_q2_v1", "excerpt requires the supported reproducible MP3 recipe");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-listened-excerpt-"));
  try {
    const rendered = path.join(temp, "verify.mp3");
    await execFile("ffmpeg", ["-v", "error", "-i", window.audio_path,
      "-af", `atrim=start_sample=${heard.start_sample_in_window}:end_sample=${heard.end_sample_in_window},asetpts=PTS-STARTPTS`,
      "-c:a", "libmp3lame", "-q:a", "2", rendered], { timeout: 120000 });
    need(await sha256File(rendered) === heard.sha256,
      "listened clip is not the exact source-window excerpt under the recorded encoding recipe");
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

/** Read-only validation; a prepared clip or ASR result is never an approval. */
export async function loadFullStreamManualReview({ evidencePath, currentReportPath,
  expectedBindings, providerManifestSha256, unitReviewEvidencePath = null,
  revalidateApplied = false } = {}) {
  const evidenceSha256 = await sha256File(evidencePath);
  const evidence = await boundFile(evidencePath, evidenceSha256, "review evidence", true);
  need(evidence.schema === FULL_STREAM_REVIEW_SCHEMA && evidence.status === "reviewed",
    "review schema/status invalid");
  need(evidence.delivery_consensus_version === NARRATION_DELIVERY_CONSENSUS_VERSION,
    "delivery consensus version is stale; refresh QA separately");
  need(evidence.reviewer_kind === "human" && String(evidence.reviewer ?? "").trim()
    && Number.isFinite(Date.parse(evidence.reviewed_at)) && String(evidence.note ?? "").trim()
    && evidence.attestation === FULL_STREAM_REVIEW_ATTESTATION,
  "human reviewer, date, note and affected-passage listening attestation are required");
  const prior = await boundFile(evidence.prior_full_stream_qa_path,
    evidence.prior_full_stream_qa_sha256, "prior full-stream report", true);
  need(revalidateApplied || path.resolve(evidence.prior_full_stream_qa_path) !== path.resolve(currentReportPath),
    "prior full-stream report must be an immutable snapshot, not the canonical output");
  need(await sha256File(currentReportPath) === evidence.prior_full_stream_qa_sha256,
    "review does not bind the exact current full-stream report");
  for (const field of BINDING_FIELDS) {
    need(evidence[field] != null && evidence[field] === prior[field], `review ${field} is stale`);
    if (Object.hasOwn(expectedBindings ?? {}, field)) {
      need(evidence[field] === expectedBindings[field], `active ${field} is stale`);
    }
  }
  need(evidence.provider_output_manifest_file_sha256 === providerManifestSha256
    && hashValid(providerManifestSha256), "provider manifest binding is stale");
  need((prior.manual_review_evidence_path ?? null) === unitReviewEvidencePath,
    "existing unit review must be preserved with --manual-review-evidence");
  if (prior.manual_review_evidence_path) {
    await boundFile(prior.manual_review_evidence_path, prior.manual_review_evidence_sha256, "existing unit review");
  }
  await boundFile(prior.audio_path, prior.audio_sha256, "full-stream audio");
  const scope = fullStreamReviewScope(prior);
  need(same(evidence.scope, scope), "exact blocker/window scope is stale or incomplete");
  const decisions = evidence.decisions ?? [];
  need(decisions.length === scope.length
    && new Set(decisions.map((row) => row.finding_sha256)).size === scope.length,
  "every current blocker must be decided exactly once");
  const byId = new Map(decisions.map((row) => [row.finding_sha256, row]));
  const verifiedWindows = new Set();
  for (const item of scope) {
    const row = byId.get(item.finding_sha256);
    need(row && ["accept", "reject"].includes(row.decision)
      && row.human_listened === true && row.affected_passage_complete === true
      && String(row.listen_note ?? "").trim(), "unreviewed blocker or incomplete human decision");
    const window = prior.confirmation_windows.find((entry) => entry.window_id === item.window.window_id);
    need(String(row.intended_passage_text ?? "").trim()
      && window.intended_text.includes(row.intended_passage_text),
    "affected passage must quote an exact span of the window's intended text");
    await boundFile(item.window.audio_path, item.window.audio_sha256, "confirmation window");
    if (!verifiedWindows.has(item.window.window_id)) {
      await verifyWindowSource(item.window);
      verifiedWindows.add(item.window.window_id);
    }
    const heard = row.listened_audio;
    need(heard && heard.source_window_id === item.window.window_id
      && heard.source_window_sha256 === item.window.audio_sha256,
    "listened audio must name the exact source window");
    need(Number.isInteger(heard.start_sample_in_window) && Number.isInteger(heard.end_sample_in_window)
      && heard.start_sample_in_window >= 0 && heard.end_sample_in_window > heard.start_sample_in_window
      && heard.end_sample_in_window <= item.window.sample_count,
    "listened excerpt sample range is invalid");
    await verifyListenedExcerpt(heard, item.window);
  }
  return { evidence, evidence_path: evidencePath, evidence_sha256: evidenceSha256, prior, scope };
}

/** Revalidate after retained QA is loaded; never silently accept a changed finding. */
export function applyFullStreamManualReview({ fullStream, review, bindings } = {}) {
  for (const field of BINDING_FIELDS) {
    const actual = Object.hasOwn(bindings ?? {}, field) ? bindings[field] : fullStream[field];
    need(actual === review.prior[field], `current ${field} changed after review`);
  }
  const current = { ...review.prior, ...fullStream, blockers: fullStream.decision?.blockers,
    status: fullStream.decision?.status };
  need(same(fullStreamReviewScope(current), review.scope), "current blockers/windows changed after review");
  const accepted = new Set(review.evidence.decisions.filter((row) => row.decision === "accept")
    .map((row) => row.finding_sha256));
  const receipt = {
    schema: FULL_STREAM_REVIEW_SCHEMA, evidence_path: review.evidence_path,
    evidence_sha256: review.evidence_sha256, reviewer: review.evidence.reviewer,
    reviewed_at: review.evidence.reviewed_at, human_listening_performed: true,
    accepted_finding_sha256s: [...accepted],
    rejected_finding_sha256s: review.scope.map((row) => row.finding_sha256).filter((id) => !accepted.has(id)),
    synthesis_authorized: false,
  };
  const apply = (decision, windowId = null) => {
    const matched = review.scope.filter((row) => accepted.has(row.finding_sha256)
      && (windowId == null || row.window.window_id === windowId));
    const matches = (finding) => matched.some((row) => {
      if (!windowId) return same(finding, row.finding);
      return same(finding, localFinding(row.finding));
    });
    const blockers = (decision.blockers ?? []).filter((row) => !matches(row));
    const warnings = [...(decision.warnings ?? []), ...(decision.blockers ?? []).filter(matches).map((row) => ({
      ...row, severity: "warning", original_severity: row.severity,
      review_required: false, manual_review_completed: true,
      manual_review_disposition: "accepted_after_exact_full_stream_passage_listen",
      full_stream_review_evidence_sha256: review.evidence_sha256,
    }))];
    return { ...decision, blockers, warnings,
      status: blockers.length ? "blocked" : warnings.length ? "passed_with_warnings" : "passed",
      full_stream_manual_review: receipt };
  };
  return { ...fullStream, decision: apply(fullStream.decision),
    confirmation_windows: fullStream.confirmation_windows.map((window) => ({
      ...window, decision: apply(window.decision, window.window_id),
    })), full_stream_manual_review: receipt };
}

/** Status validation keeps an accepted decision bound to its immutable evidence. */
export async function validateAppliedFullStreamManualReview(report) {
  const receipt = report?.full_stream_manual_review;
  if (!receipt) {
    need(!(report?.warnings ?? []).some((row) => row.full_stream_review_evidence_sha256),
      "applied review receipt is missing");
    return;
  }
  const evidence = await boundFile(receipt.evidence_path, receipt.evidence_sha256, "applied review", true);
  const prior = await boundFile(evidence.prior_full_stream_qa_path,
    evidence.prior_full_stream_qa_sha256, "prior full-stream report", true);
  // Validate against the immutable pre-review snapshot instead of the now-reviewed output.
  const review = await loadFullStreamManualReview({ evidencePath: receipt.evidence_path,
    currentReportPath: evidence.prior_full_stream_qa_path,
    expectedBindings: report,
    providerManifestSha256: report.provider_output_manifest_file_sha256,
    unitReviewEvidencePath: report.manual_review_evidence_path ?? null,
    revalidateApplied: true,
  });
  const expected = applyFullStreamManualReview({ fullStream: prior, review, bindings: report });
  need(same(expected.decision, report.decision)
    && same(expected.decision.blockers, report.blockers)
    && same(expected.decision.warnings, report.warnings)
    && same(expected.confirmation_windows, report.confirmation_windows)
    && expected.decision.status === report.status
    && same(expected.full_stream_manual_review, receipt)
    && same(report.decision?.full_stream_manual_review, receipt),
  "applied review decision differs from its evidence");
}
