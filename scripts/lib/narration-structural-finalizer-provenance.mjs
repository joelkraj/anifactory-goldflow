import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256File } from "./file-hash.mjs";
import { canonicalQwenBatchSha256, QWEN_LIAM_EXACT_UNIT_RECOVERY_MODE } from "./qwen-liam-batch-contract.mjs";
import { narrationTtsRetryReportPolicy } from "./narration-tts-policy.mjs";
import { validateStructuralNoAudioRetryEvidence } from "./tts-structural-no-audio-retry.mjs";

const inside = (root, target) => path.isAbsolute(String(target ?? ""))
  && path.resolve(target).startsWith(`${path.resolve(root)}${path.sep}`);
const equal = (left, right) => canonicalQwenBatchSha256(left) === canonicalQwenBatchSha256(right);
const readJson = async (target) => JSON.parse(await fs.readFile(target, "utf8"));

// A provider-neutral finalizer can replace the Qwen blocked report after a
// one-unit token-limit recovery. Rebuild only its omitted report metadata from
// the passed manifest and the immutable, hash-named first-attempt archives.
export async function verifiedStructuralRecoveryFromManifest({ episodeDir, manifest,
  manifestPath, plan, planFileSha256, sourceScriptSha256 } = {}) {
  const structural = (manifest?.units ?? []).filter((row) =>
    row?.recovery_provenance?.evidence_basis === "reviewed_structural_no_audio");
  if (!structural.length) return null;
  if (manifest?.status !== "passed" || manifest.provider !== "qwen_local"
    || structural.length !== 1 || !inside(episodeDir, manifestPath)
    || manifest.narration_generation_plan_sha256 !== plan?.plan_sha256
    || manifest.narration_generation_plan_file_sha256 !== planFileSha256
    || plan?.source_script_hash !== sourceScriptSha256) {
    throw new Error("Structural recovery manifest has stale episode, source, or plan bindings.");
  }
  const [output] = structural;
  const recovery = output.recovery_provenance;
  const evidencePath = recovery?.confirmed_evidence_path;
  if (Number(output.attempt) !== 2 || output.status !== "accepted"
    || recovery?.schema !== "goldflow_qwen_exact_unit_recovery_provenance_v1"
    || recovery.recovery_mode !== QWEN_LIAM_EXACT_UNIT_RECOVERY_MODE
    || recovery.unit_id !== output.unit_id
    || recovery.human_listening_performed !== false
    || recovery.origin_audio_sha256 !== null
    || !equal(recovery.trigger_codes, ["tts_batch_token_limit_reached"])
    || !inside(episodeDir, evidencePath)
    || !inside(episodeDir, output.audio_path)
    || await sha256File(evidencePath).catch(() => null) !== recovery.confirmed_evidence_sha256
    || await sha256File(output.audio_path).catch(() => null) !== output.audio_sha256) {
    throw new Error("Selected structural retry lacks exact episode-local evidence or WAV provenance.");
  }
  const evidence = await readJson(evidencePath);
  const retryRunnerPath = output.runner_report_path;
  if (!inside(episodeDir, retryRunnerPath)
    || await sha256File(retryRunnerPath).catch(() => null) !== output.runner_report_sha256) {
    throw new Error("Structural retry attempt-two runner report is absent or hash-stale.");
  }
  const retryRunner = await readJson(retryRunnerPath);
  const retryResults = (retryRunner.results ?? []).filter((row) => row.unit_id === output.unit_id);
  const retryResult = retryResults[0];
  if (retryRunner.status !== "passed" || retryResults.length !== 1
    || retryResult?.status !== "generated" || Number(retryResult.attempt) !== 2
    || retryResult.output_path !== output.audio_path
    || retryResult.output_sha256 !== output.audio_sha256
    || retryResult.synthesis_identity_sha256 !== output.synthesis_identity_sha256
    || retryResult.spoken_text_sha256 !== output.spoken_text_sha256
    || retryResult.token_limit_reached !== false
    || output.token_limit_reached !== false) {
    throw new Error("Structural retry selected WAV differs from the exact attempt-two runner.");
  }
  const archiveDir = path.join(episodeDir, "assets/audio/narration_tts/structural-retry-predecessors");
  const priorReportPath = path.join(archiveDir,
    `narration-report-${evidence.pre_retry_narration_report_sha256}.json`);
  const priorQaPath = path.join(archiveDir,
    `unit-qa-${evidence.pre_retry_unit_qa_sha256}.json`);
  if (!inside(episodeDir, priorReportPath) || !inside(episodeDir, priorQaPath)
    || await sha256File(priorReportPath).catch(() => null)
      !== evidence.pre_retry_narration_report_sha256
    || await sha256File(priorQaPath).catch(() => null)
      !== evidence.pre_retry_unit_qa_sha256) {
    throw new Error("Structural retry predecessor archive is absent or hash-stale.");
  }
  const [priorReport, priorUnitQa] = await Promise.all([
    readJson(priorReportPath), readJson(priorQaPath),
  ]);
  const candidate = (priorUnitQa.candidates ?? []).find((row) => row.unit_id === output.unit_id);
  const runnerPath = candidate?.runner_report_path;
  if (!inside(episodeDir, runnerPath)
    || await sha256File(runnerPath).catch(() => null) !== candidate.runner_report_sha256
    || recovery.origin_runner_report_path !== runnerPath
    || recovery.origin_runner_report_sha256 !== candidate.runner_report_sha256) {
    throw new Error("Structural retry original runner report is absent or hash-stale.");
  }
  validateStructuralNoAudioRetryEvidence({
    evidence, requestedUnitIds: [output.unit_id], sourceScriptSha256,
    planSha256: plan.plan_sha256, planFileSha256,
    priorReport, priorReportSha256: evidence.pre_retry_narration_report_sha256,
    priorUnitQa, priorUnitQaSha256: evidence.pre_retry_unit_qa_sha256,
    runnerReport: await readJson(runnerPath),
    runnerReportSha256: candidate.runner_report_sha256,
    units: plan.units, batchPlan: plan.qwen_liam_batch_plan,
  });
  if (recovery.origin_synthesis_identity_sha256
      !== evidence.confirmed_units[0].synthesis_identity_sha256
    || recovery.spoken_text_sha256 !== output.spoken_text_sha256
    || output.spoken_text_sha256 !== evidence.confirmed_units[0].spoken_text_sha256
    || output.batch_plan_sha256 !== plan.qwen_liam_batch_plan.batch_plan_sha256) {
    throw new Error("Selected structural retry differs from the reviewed original cohort.");
  }
  const currentById = new Map((manifest.units ?? []).map((row) => [row.unit_id, row]));
  if (currentById.size !== manifest.units.length || manifest.units.length !== plan.units.length) {
    throw new Error("Structural retry manifest has missing or duplicate selected units.");
  }
  for (const prior of priorReport.results ?? []) {
    const current = currentById.get(prior.unit_id);
    if (!current) throw new Error(`Structural retry lost retained unit ${prior.unit_id}.`);
    if (Number(current.attempt) === 1 && (current.audio_sha256 !== prior.audio_sha256
      || current.synthesis_identity_sha256 !== prior.synthesis_identity_sha256
      || current.spoken_text_sha256 !== prior.spoken_text_sha256)) {
      throw new Error(`Structural retry changed retained first take ${prior.unit_id}.`);
    }
    if (Number(current.attempt) > 1 && !current.recovery_provenance) {
      throw new Error(`Structural retry manifest has unreviewed later take ${prior.unit_id}.`);
    }
  }
  return {
    unit_id: output.unit_id,
    recovery_provenance: recovery,
    recovery_scope: {
      pre_retry_narration_report_sha256: evidence.pre_retry_narration_report_sha256,
      pre_retry_narration_report_archive_path: priorReportPath,
      pre_retry_unit_qa_sha256: evidence.pre_retry_unit_qa_sha256,
      pre_retry_unit_qa_archive_path: priorQaPath,
    },
  };
}

export function projectVerifiedStructuralRecoveryReport({ report, manifest,
  manifestFileSha256, structuralRecovery, qualityContract } = {}) {
  if (!structuralRecovery) return report;
  if (report?.provider_output_manifest_path == null
    || report.source_script_hash == null
    || report.provider_output_manifest_sha256 !== manifestFileSha256
    || report.narration_generation_plan_sha256
      !== manifest.narration_generation_plan_sha256
    || report.narration_generation_plan_file_sha256
      !== manifest.narration_generation_plan_file_sha256
    || (report.results ?? []).length !== manifest.units.length) {
    throw new Error("Provider-neutral report is not bound to the structural manifest.");
  }
  const manifestById = new Map(manifest.units.map((row) => [row.unit_id, row]));
  const results = report.results.map((row) => {
    const output = manifestById.get(row.unit_id);
    if (!output || Number(row.attempt) !== Number(output.attempt)
      || row.audio_sha256 !== output.audio_sha256
      || row.synthesis_identity_sha256 !== output.synthesis_identity_sha256
      || row.spoken_text_sha256 !== output.spoken_text_sha256
      || (row.recovery_provenance != null
        && !equal(row.recovery_provenance, output.recovery_provenance ?? null))) {
      throw new Error(`Provider-neutral result differs from manifest: ${row.unit_id}.`);
    }
    return { ...row, recovery_provenance: output.recovery_provenance ?? null };
  });
  const scope = structuralRecovery.recovery_scope;
  if (report.recovery_scope && Object.keys(scope).some((key) =>
    report.recovery_scope[key] !== scope[key])) {
    throw new Error("Provider-neutral structural recovery scope conflicts with archived evidence.");
  }
  const policy = narrationTtsRetryReportPolicy({ provider: manifest.provider,
    qualityContract, recoveryProvenances: results.map((row) => row.recovery_provenance) });
  if (report.retry_policy && !equal(report.retry_policy, policy)) {
    throw new Error("Provider-neutral retry policy conflicts with selected recovery provenance.");
  }
  return { ...report, results,
    recovery_scope: { ...(report.recovery_scope ?? {}), ...scope },
    retry_policy: report.retry_policy ?? policy };
}

export function providerNeutralRetryReportFieldsForTests({ structuralRecovery,
  provider, qualityContract, rows } = {}) {
  return {
    ...(structuralRecovery ? { recovery_scope: structuralRecovery.recovery_scope } : {}),
    retry_policy: narrationTtsRetryReportPolicy({ provider, qualityContract,
      recoveryProvenances: (rows ?? []).map((row) => row.recovery_provenance) }),
  };
}
