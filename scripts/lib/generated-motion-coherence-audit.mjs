import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { runCodexCli } from "./codex-cli-runner.mjs";

const execFile = promisify(execFileCallback);

export const GENERATED_MOTION_COHERENCE_AUDIT_SCHEMA = "goldflow_generated_motion_coherence_audit_v1";
export const GENERATED_MOTION_COHERENCE_ROW_SCHEMA = "goldflow_generated_motion_coherence_row_v1";
export const GENERATED_MOTION_COHERENCE_POLICY = "all_generated_clips_source_plus_five_timeline_samples_v1";

const CHECK_VERDICTS = new Set(["pass", "fail", "uncertain", "not_applicable"]);
const BASE_DIMENSIONS = [
  "source_first_frame_fidelity",
  "identity_body_and_prop_continuity",
  "physical_reachability",
  "terminal_subject_state",
  "terminal_camera_and_composition",
  "next_shot_continuity_bridge",
  "artifact_and_motion_stability",
];

function cleanText(value) {
  return String(value ?? "").trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileHash(filePath) {
  return sha256(await fs.readFile(filePath));
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

function parseModelJson(value) {
  const text = cleanText(value);
  try {
    return JSON.parse(text);
  } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1]);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
  throw new Error("Generated-motion coherence auditor did not return a JSON object.");
}

function isContactAction(clip) {
  const intent = clip?.coverage?.[0]?.animation_intent ?? {};
  const text = [
    intent.shot_class,
    intent.primary_action,
    clip?.coverage?.[0]?.foreground_action,
    clip?.motion_prompt,
  ].map(cleanText).join(" ");
  return /contact|strike|hit|block|catch|grab|handoff|take|give|stab|pin|push|pull|lift|carry|embrace|kiss|collide|impact|touch/i.test(text);
}

function requiredDimensions(clip) {
  return isContactAction(clip)
    ? [...BASE_DIMENSIONS.slice(0, 3), "action_and_contact_continuity", ...BASE_DIMENSIONS.slice(3)]
    : BASE_DIMENSIONS;
}

function compactClipContract(clip) {
  return {
    image_id: clip?.image_id ?? null,
    candidate_id: clip?.candidate_id ?? clip?.image_id ?? null,
    timeline_duration_sec: Number(clip?.cut_duration_sec ?? 0),
    generated_duration_sec: Number(clip?.normalized_probe?.duration_sec ?? clip?.requested_duration_sec ?? 0),
    motion_prompt: clip?.motion_prompt ?? null,
    coverage: clip?.coverage ?? [],
    start_frame_contract: clip?.start_frame_contract ?? null,
    end_frame_contract: clip?.end_frame_contract ?? null,
    required_dimensions: requiredDimensions(clip),
  };
}

function rowCacheIdentity({ videoSha256, sourceImageSha256, contractSha256, model, reasoningEffort }) {
  return {
    video_sha256: videoSha256,
    source_image_sha256: sourceImageSha256,
    contract_sha256: contractSha256,
    audit_policy: GENERATED_MOTION_COHERENCE_POLICY,
    model: cleanText(model) || "codex_cli_default",
    reasoning_effort: cleanText(reasoningEffort) || "medium",
    sample_policy: "five_fixed_fraction_frames_v1",
  };
}

export function generatedMotionCoherenceRowCacheKeyForTests(options = {}) {
  return sha256(JSON.stringify(rowCacheIdentity(options)));
}

function sampleTimes(durationSec) {
  const duration = Math.max(0.2, Number(durationSec) || 0.2);
  const end = Math.max(0.04, duration - 0.08);
  return [0.04, duration * 0.25, duration * 0.5, duration * 0.75, end]
    .map((value) => Math.max(0, Math.min(end, value)))
    .map((value) => Number(value.toFixed(3)));
}

async function defaultFrameExtractor({ videoPath, frameDir, durationSec }) {
  await fs.mkdir(frameDir, { recursive: true });
  const frames = [];
  for (const [index, timestampSec] of sampleTimes(durationSec).entries()) {
    const framePath = path.join(frameDir, `sample-${String(index + 1).padStart(2, "0")}-${String(timestampSec).replace(".", "_")}s.jpg`);
    await execFile("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", timestampSec.toFixed(3),
      "-i", videoPath,
      "-frames:v", "1",
      "-q:v", "2",
      framePath,
    ], { maxBuffer: 8 * 1024 * 1024 });
    frames.push({ index: index + 1, timestamp_sec: timestampSec, path: framePath, sha256: await fileHash(framePath) });
  }
  return frames;
}

function auditPrompt(clip, frames) {
  const attachmentMap = [
    "Attachment 1 is the exact accepted source image and expected first-frame identity/composition.",
    ...frames.map((frame, index) => `Attachment ${index + 2} is generated-video sample ${index + 1} at ${frame.timestamp_sec.toFixed(3)} seconds.`),
  ].join("\n");
  return `You are a strict generated-video continuity reviewer. Compare the attached accepted source image and ordered generated-video samples against the authored single-shot contract. Judge visible pixels only. Do not reward cinematic beauty when the action, identity, body state, contact, ending, or geography is wrong. The action must be physically reachable from the source frame in one uninterrupted shot. A terminal state must be visibly established rather than merely starting to happen.

ATTACHMENT MAP:
${attachmentMap}

SHOT CONTRACT:
${JSON.stringify(compactClipContract(clip), null, 2)}

For every required dimension return pass, fail, uncertain, or not_applicable with concise visible evidence. Mark action/contact continuity fail when bodies or objects teleport, merge, pass through each other, change owner impossibly, or never make the required contact. Mark terminal checks fail when the requested ending is absent or contradicted. Ordinary generated motion is not a failure unless it causes a story, identity, state, geography, or watchability defect.

Recommend the longest usable contiguous window. Use only timestamps represented by the supplied samples; choose the full clip when no trim is needed. Recommend reject when no coherent window pays the authored action.

Return JSON only:
{
  "schema":"${GENERATED_MOTION_COHERENCE_ROW_SCHEMA}",
  "candidate_id":${JSON.stringify(clip?.candidate_id ?? clip?.image_id ?? null)},
  "checks":[{"dimension":"one required dimension","verdict":"pass|fail|uncertain|not_applicable","visible_evidence":"specific visible evidence","discrepancy":null}],
  "overall_verdict":"pass|needs_review|reject_recommended",
  "usable_window":{"disposition":"full_clip|trim_head|trim_tail|trim_both|reject","start_sec":0,"end_sec":${Number(clip?.normalized_probe?.duration_sec ?? clip?.requested_duration_sec ?? 0)}},
  "critical_discrepancies":[],
  "confidence":"low|medium|high",
  "one_sentence_verdict":"literal motion verdict"
}`;
}

function normalizeAuditResponse(clip, response) {
  const required = requiredDimensions(clip);
  const sourceChecks = new Map((Array.isArray(response?.checks) ? response.checks : [])
    .map((row) => [cleanText(row?.dimension), row]));
  const checks = required.map((dimension) => {
    const source = sourceChecks.get(dimension) ?? {};
    const rawVerdict = cleanText(source.verdict).toLowerCase();
    return {
      dimension,
      verdict: CHECK_VERDICTS.has(rawVerdict) ? rawVerdict : "uncertain",
      visible_evidence: cleanText(source.visible_evidence) || "No grounded visible evidence supplied.",
      discrepancy: cleanText(source.discrepancy) || null,
    };
  });
  const failCount = checks.filter((row) => row.verdict === "fail").length;
  const unresolvedCount = checks.filter((row) => !["pass", "not_applicable"].includes(row.verdict)).length;
  const durationSec = Math.max(0, Number(clip?.normalized_probe?.duration_sec ?? clip?.requested_duration_sec ?? 0));
  const windowSource = response?.usable_window ?? {};
  const allowedDisposition = new Set(["full_clip", "trim_head", "trim_tail", "trim_both", "reject"]);
  const disposition = allowedDisposition.has(cleanText(windowSource.disposition).toLowerCase())
    ? cleanText(windowSource.disposition).toLowerCase()
    : unresolvedCount ? "reject" : "full_clip";
  const startSec = Math.max(0, Math.min(durationSec, Number(windowSource.start_sec) || 0));
  const endSec = Math.max(startSec, Math.min(durationSec, Number(windowSource.end_sec) || durationSec));
  const normalizedDisposition = endSec - startSec < 0.5 ? "reject" : disposition;
  const overallVerdict = failCount || normalizedDisposition === "reject"
    ? "reject_recommended"
    : unresolvedCount ? "needs_review" : "pass";
  return {
    schema: GENERATED_MOTION_COHERENCE_ROW_SCHEMA,
    candidate_id: cleanText(clip?.candidate_id ?? clip?.image_id),
    image_id: cleanText(clip?.image_id),
    checks,
    overall_verdict: overallVerdict,
    usable_window: {
      disposition: normalizedDisposition,
      start_sec: Number(startSec.toFixed(3)),
      end_sec: Number(endSec.toFixed(3)),
    },
    critical_discrepancies: Array.isArray(response?.critical_discrepancies)
      ? response.critical_discrepancies.map(cleanText).filter(Boolean)
      : [],
    confidence: new Set(["low", "medium", "high"]).has(cleanText(response?.confidence).toLowerCase())
      ? cleanText(response.confidence).toLowerCase()
      : "low",
    one_sentence_verdict: cleanText(response?.one_sentence_verdict)
      || (overallVerdict === "pass" ? "The generated shot satisfies the authored motion contract." : "The generated shot requires exact-clip review."),
  };
}

async function defaultAuditExecutor({ clip, frames, outputPath, repoRoot, model, reasoningEffort, timeoutMs }) {
  const result = await runCodexCli({
    prompt: auditPrompt(clip, frames),
    stageName: "generated_motion_coherence_audit",
    repoRoot,
    outputPath,
    model,
    reasoningEffort,
    verbosity: "low",
    timeoutMs,
    provider: "codex_cli",
    extraArgs: ["--sandbox", "read-only", "--image", clip.source_image_path, ...frames.flatMap((frame) => ["--image", frame.path])],
  });
  return parseModelJson(result.content);
}

async function runPool(rows, concurrency, worker) {
  const output = new Array(rows.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), rows.length || 1) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= rows.length) return;
      output[index] = await worker(rows[index], index);
    }
  }));
  return output;
}

export function normalizeGeneratedMotionAuditForTests(clip, response) {
  return normalizeAuditResponse(clip, response);
}

export function generatedMotionSampleTimesForTests(durationSec) {
  return sampleTimes(durationSec);
}

export async function buildGeneratedMotionCoherenceAudit({
  report,
  reportPath,
  outputPath,
  framesRoot,
  callsDir,
  repoRoot,
  concurrency = 4,
  model = null,
  reasoningEffort = "medium",
  timeoutMs = 600_000,
  frameExtractor = defaultFrameExtractor,
  auditExecutor = defaultAuditExecutor,
  rowCacheDir,
  generatedAt = new Date(),
} = {}) {
  if (!Array.isArray(report?.clips)) throw new Error("Generated-motion coherence audit requires generated clips.");
  const reportSha256 = reportPath ? await fileHash(reportPath) : sha256(JSON.stringify(report));
  const auditConfiguration = {
    audit_policy: GENERATED_MOTION_COHERENCE_POLICY,
    model: cleanText(model) || "codex_cli_default",
    reasoning_effort: cleanText(reasoningEffort) || "medium",
    sample_policy: "five_fixed_fraction_frames_v1",
  };
  const auditConfigurationSha256 = sha256(JSON.stringify(auditConfiguration));
  const prior = outputPath ? await readJson(outputPath, null) : null;
  if (
    prior?.status === "passed"
    && prior.report_sha256 === reportSha256
    && prior.audit_configuration_sha256 === auditConfigurationSha256
  ) return { ...prior, reused: true };
  const resolvedFramesRoot = path.resolve(framesRoot ?? path.join(path.dirname(outputPath), "coherence_frames"));
  const resolvedCallsDir = path.resolve(callsDir ?? path.join(path.dirname(outputPath), "coherence_calls"));
  const resolvedRowCacheDir = path.resolve(rowCacheDir ?? path.join(path.dirname(outputPath), "coherence_row_cache"));
  await Promise.all([
    fs.mkdir(resolvedFramesRoot, { recursive: true }),
    fs.mkdir(resolvedCallsDir, { recursive: true }),
    fs.mkdir(resolvedRowCacheDir, { recursive: true }),
  ]);
  const rows = await runPool(report.clips, concurrency, async (clip) => {
    const candidateId = cleanText(clip?.candidate_id ?? clip?.image_id);
    const videoPath = path.resolve(clip.normalized_video_path);
    const sourceImagePath = path.resolve(clip.source_image_path);
    const [videoSha256, sourceImageSha256] = await Promise.all([fileHash(videoPath), fileHash(sourceImagePath)]);
    if (videoSha256 !== clip.normalized_video_sha256) throw new Error(`Generated-motion video is stale for ${candidateId}.`);
    if (sourceImageSha256 !== clip.source_image_sha256) throw new Error(`Generated-motion source image is stale for ${candidateId}.`);
    const contractSha256 = sha256(JSON.stringify(compactClipContract(clip)));
    const cacheIdentity = rowCacheIdentity({ videoSha256, sourceImageSha256, contractSha256, model, reasoningEffort });
    const rowCacheKey = sha256(JSON.stringify(cacheIdentity));
    const priorRow = prior?.rows?.find((row) => row.candidate_id === candidateId
      && row.video_sha256 === videoSha256
      && row.source_image_sha256 === sourceImageSha256
      && row.contract_sha256 === contractSha256
      && row.row_cache_key === rowCacheKey
      && row.status === "audited");
    if (priorRow) return { ...priorRow, reused: true };
    const rowCachePath = path.join(resolvedRowCacheDir, `${rowCacheKey}.json`);
    const cachedRow = await readJson(rowCachePath, null);
    if (
      cachedRow?.schema === GENERATED_MOTION_COHERENCE_ROW_SCHEMA
      && cachedRow?.status === "audited"
      && cachedRow?.row_cache_key === rowCacheKey
      && cachedRow?.video_sha256 === videoSha256
      && cachedRow?.source_image_sha256 === sourceImageSha256
      && cachedRow?.contract_sha256 === contractSha256
    ) {
      return { ...cachedRow, reused: true, reuse_source: "content_addressed_row_cache" };
    }
    const frameDir = path.join(resolvedFramesRoot, `${candidateId}-${videoSha256.slice(0, 12)}`);
    const frames = await frameExtractor({
      videoPath,
      frameDir,
      durationSec: Number(clip?.normalized_probe?.duration_sec ?? clip?.requested_duration_sec ?? 0),
      clip,
    });
    const callOutputPath = path.join(resolvedCallsDir, `${candidateId}-${videoSha256.slice(0, 12)}.json`);
    try {
      const response = await auditExecutor({ clip, frames, outputPath: callOutputPath, repoRoot, model, reasoningEffort, timeoutMs });
      const auditedRow = {
        ...normalizeAuditResponse(clip, response),
        status: "audited",
        video_sha256: videoSha256,
        source_image_sha256: sourceImageSha256,
        contract_sha256: contractSha256,
        sampled_frames: frames,
        call_output_path: callOutputPath,
        row_cache_key: rowCacheKey,
        row_cache_identity: cacheIdentity,
      };
      await writeJsonAtomic(rowCachePath, auditedRow);
      return auditedRow;
    } catch (error) {
      return {
        schema: GENERATED_MOTION_COHERENCE_ROW_SCHEMA,
        status: "unavailable",
        candidate_id: candidateId,
        image_id: cleanText(clip?.image_id),
        video_sha256: videoSha256,
        source_image_sha256: sourceImageSha256,
        contract_sha256: contractSha256,
        sampled_frames: frames,
        checks: requiredDimensions(clip).map((dimension) => ({
          dimension,
          verdict: "uncertain",
          visible_evidence: "The automated coherence audit was unavailable.",
          discrepancy: "audit_unavailable",
        })),
        overall_verdict: "needs_review",
        usable_window: { disposition: "reject", start_sec: 0, end_sec: 0 },
        critical_discrepancies: ["audit_unavailable"],
        confidence: "high",
        one_sentence_verdict: `Automated coherence audit unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });
  const summary = {
    clip_count: rows.length,
    pass_count: rows.filter((row) => row.overall_verdict === "pass").length,
    needs_review_count: rows.filter((row) => row.overall_verdict === "needs_review").length,
    reject_recommended_count: rows.filter((row) => row.overall_verdict === "reject_recommended").length,
    unavailable_count: rows.filter((row) => row.status === "unavailable").length,
    row_cache_reused_count: rows.filter((row) => row.reuse_source === "content_addressed_row_cache").length,
  };
  const artifact = {
    schema: GENERATED_MOTION_COHERENCE_AUDIT_SCHEMA,
    status: "passed",
    report_path: reportPath ? path.resolve(reportPath) : null,
    report_sha256: reportSha256,
    audit_policy: GENERATED_MOTION_COHERENCE_POLICY,
    audit_configuration: auditConfiguration,
    audit_configuration_sha256: auditConfigurationSha256,
    row_cache_dir: resolvedRowCacheDir,
    model_findings_policy: "advisory_exact_clip_review_no_automatic_regeneration",
    summary,
    rows,
    generated_at: generatedAt.toISOString(),
  };
  if (outputPath) await writeJsonAtomic(outputPath, artifact);
  return artifact;
}
