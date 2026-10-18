import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256File } from './file-hash.mjs';

const need = (ok, message) => { if (!ok) throw new Error(message); };
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const inside = (root, file) => path.isAbsolute(file ?? '') && path.resolve(file).startsWith(`${path.resolve(root)}${path.sep}`);

/** Admit the existing no-synthesis listening finalizer only for current, exact reviewed evidence. */
export async function narrationManualReviewStatus({ episodeDir, episode, report, sourceScriptSha256 }) {
  const evidencePath = path.join(episodeDir, `narration_delivery_manual_review_${episode}.json`);
  const evidence = await read(evidencePath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!evidence || report?.status !== 'blocked') return null;
  const evidenceHash = await sha256File(evidencePath);
  if (report.manual_review_evidence_sha256 === evidenceHash) return null;
  const reportPath = path.join(episodeDir, `narration_tts_report_${episode}.json`);
  const qaPath = path.join(episodeDir, `narration_unit_delivery_qa_${episode}.json`);
  const planPath = path.join(episodeDir, 'narration_generation_plan.json');
  const manifestPath = report.provider_output_manifest_path;
  need(inside(episodeDir, manifestPath) && inside(episodeDir, evidence.pre_review_unit_delivery_qa_path)
    && inside(episodeDir, evidence.pre_review_narration_report_path), 'Manual narration review snapshots or manifest escape the episode.');
  const [plan, qa, manifest, priorQa, priorReport] = await Promise.all([
    read(planPath), read(qaPath), read(manifestPath), read(evidence.pre_review_unit_delivery_qa_path), read(evidence.pre_review_narration_report_path),
  ]);
  const manifestHash = await sha256File(manifestPath);
  const qaHash = await sha256File(qaPath), reportHash = await sha256File(reportPath);
  need(report.source_script_hash === sourceScriptSha256 && qa.source_script_hash === sourceScriptSha256
    && plan.plan_sha256 === report.narration_generation_plan_sha256
    && await sha256File(planPath) === report.narration_generation_plan_file_sha256
    && manifestHash === report.provider_output_manifest_sha256
    && evidence.pre_review_narration_report_sha256 === reportHash
    && await sha256File(evidence.pre_review_narration_report_path) === reportHash
    && evidence.pre_review_unit_delivery_qa_sha256 === qaHash
    && await sha256File(evidence.pre_review_unit_delivery_qa_path) === qaHash
    && priorQa.status === 'blocked' && priorReport.status === 'blocked'
    && manifest.status === 'passed', 'Manual narration review source, plan, report or QA bindings are stale.');
  const { validateNarrationDeliveryManualReviewEvidenceForTests } = await import('../narration-provider-output-finalize.mjs');
  const decision = await validateNarrationDeliveryManualReviewEvidenceForTests({ evidence, evidencePath,
    canonicalPlanSha256: plan.plan_sha256, manifestFileSha256: manifestHash,
    priorUnitDeliveryPath: evidence.pre_review_unit_delivery_qa_path, priorUnitDeliverySha256: qaHash,
    rows: manifest.units.map(row => ({ ...row, wav: row.audio_path, provider: row.provider ?? manifest.provider })),
    deliveryRows: qa.units, blockers: qa.blockers,
  });
  return { done: false, state: 'blocked',
    evidence: `Exact human listening decisions cover ${decision.accepted_unit_ids.length} accepted units; no-synthesis re-adjudication required`,
    next_command_shape: `node bin/goldflow.mjs tts finalize-provider --episode-dir ${episodeDir} --manifest ${manifestPath} --manual-review-evidence ${evidencePath}` };
}

/** Preserve the earlier unit review when applying an exact mastered-passage listening decision. */
export async function narrationFullStreamReviewStatus({ episodeDir, episode, report, sourceScriptSha256 }) {
  const evidencePath = path.join(episodeDir, `narration_full_stream_manual_review_${episode}.json`);
  const evidence = await read(evidencePath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!evidence || report?.status !== 'blocked') return null;
  if (report.full_stream_manual_review?.evidence_sha256 === await sha256File(evidencePath)) return null;
  const manifestPath = report.provider_output_manifest_path;
  need(inside(episodeDir, manifestPath) && inside(episodeDir, evidence.prior_full_stream_qa_path), 'Full-stream listening review paths escape the episode.');
  const [plan, qa] = await Promise.all([read(path.join(episodeDir, 'narration_generation_plan.json')),
    read(path.join(episodeDir, `narration_unit_delivery_qa_${episode}.json`))]);
  need(report.source_script_hash === sourceScriptSha256 && qa.source_script_hash === sourceScriptSha256
    && ['passed', 'passed_with_warnings'].includes(qa.status) && !(qa.blockers ?? []).length
    && Number(qa.blocked_unit_count ?? 0) === 0
    && report.full_stream_qa_status === 'blocked'
    && plan.plan_sha256 === report.narration_generation_plan_sha256
    && await sha256File(path.join(episodeDir, 'narration_generation_plan.json')) === report.narration_generation_plan_file_sha256
    && await sha256File(manifestPath) === report.provider_output_manifest_sha256,
  'Full-stream listening review requires unchanged source, plan, manifest and passed unit QA.');
  const { loadFullStreamManualReview } = await import('./narration-full-stream-manual-review.mjs');
  const review = await loadFullStreamManualReview({ evidencePath,
    currentReportPath: path.join(episodeDir, `narration_full_stream_qa_${episode}.json`),
    expectedBindings: { source_script_hash: sourceScriptSha256,
      narration_generation_plan_sha256: plan.plan_sha256,
      narration_generation_plan_file_sha256: report.narration_generation_plan_file_sha256,
      narration_quality_contract_sha256: report.narration_quality_contract_sha256,
      audio_path: report.final_wav, audio_sha256: report.final_wav_sha256 },
    providerManifestSha256: report.provider_output_manifest_sha256,
    unitReviewEvidencePath: report.manual_review_evidence_path ?? null });
  const unitArg = report.manual_review_evidence_path ? ` --manual-review-evidence ${report.manual_review_evidence_path}` : '';
  return { done: false, state: 'blocked', evidence: `Exact human passage review covers ${review.scope.length} full-stream delivery findings; no-synthesis re-adjudication required`,
    next_command_shape: `node bin/goldflow.mjs tts finalize-provider --episode-dir ${episodeDir} --manifest ${manifestPath}${unitArg} --full-stream-review-evidence ${evidencePath}` };
}

export function narrationManualReviewAdmission(status, command, subcommand, flags = {}) {
  const applicable = command === 'tts' && subcommand === 'finalize-provider' && Boolean(flags['manual-review-evidence'] || flags['full-stream-review-evidence']);
  if (!applicable) return { applicable: false, allowed: false };
  const unitArg = flags['manual-review-evidence'] ? ` --manual-review-evidence ${flags['manual-review-evidence']}` : '';
  const fullArg = flags['full-stream-review-evidence'] ? ` --full-stream-review-evidence ${flags['full-stream-review-evidence']}` : '';
  const expected = `node bin/goldflow.mjs tts finalize-provider --episode-dir ${status.episode_dir} --manifest ${flags.manifest}${unitArg}${fullArg}`;
  const allowedKeys = ['episode-dir', 'manifest', ...(unitArg ? ['manual-review-evidence'] : []), ...(fullArg ? ['full-stream-review-evidence'] : [])].sort().join(',');
  const allowed = status.current_stage === 'qwen_tts_stitch' && status.current_stage_state === 'blocked'
    && flags['episode-dir'] === status.episode_dir
    && status.next_command_shape === expected
    && Object.keys(flags).sort().join(',') === allowedKeys;
  return { applicable: true, allowed, reason: allowed ? null : 'Only the exact status-directed, hash-bound manual listening finalization is allowed.' };
}
