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

export function narrationManualReviewAdmission(status, command, subcommand, flags = {}) {
  const applicable = command === 'tts' && subcommand === 'finalize-provider' && Boolean(flags['manual-review-evidence']);
  if (!applicable) return { applicable: false, allowed: false };
  const expected = `node bin/goldflow.mjs tts finalize-provider --episode-dir ${status.episode_dir} --manifest ${flags.manifest} --manual-review-evidence ${flags['manual-review-evidence']}`;
  const allowed = status.current_stage === 'qwen_tts_stitch' && status.current_stage_state === 'blocked'
    && status.next_command_shape === expected
    && Object.keys(flags).sort().join(',') === 'episode-dir,manifest,manual-review-evidence';
  return { applicable: true, allowed, reason: allowed ? null : 'Only the exact status-directed, hash-bound manual listening finalization is allowed.' };
}
