import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createPanelProductionContract, createLegacyPanelProductionContract, assertPanelProductionIdentity, assertPanelProductionPreflightFlags, panelAllocationRoute } from '../lib/panel-production-policy.mjs';
import { mediaWorkflowForPreflight, GENERATED_VISUALS_STAGE_REGISTRY_VERSION } from '../lib/media-workflows.mjs';
import { stageRegistryFor, PIPELINE_STAGE_REGISTRY, PIPELINE_STAGE_REGISTRY_CURRENT, PIPELINE_STAGE_REGISTRY_VERSION, stageChecklistFor, stageDefinition, commandStageFor, buildStageCommand } from '../lib/pipeline-stage-registry.mjs';
import { assertCommandWorkflowRoute, assertEpisodeWorkflowFlags } from '../lib/episode-workflow-routing.mjs';
import { creativeStageRerunDecision } from '../lib/creative-stage-rerun-policy.mjs';
import { plannerRerunDecision } from '../lib/planner-rerun-policy.mjs';
import { panelArtifactComplete, imageReportComplete, imageOutputQaComplete } from '../run-status.mjs';
import { preparePanelAssetPlan, writePanelAssetPlan, expandPanelAssetPrompts } from '../lib/panel-production-assets.mjs';
import { sha256File } from '../lib/file-hash.mjs';

const exec = promisify(execFile), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'panel-production-policy-'));
const json = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
const binding = mediaWorkflowForPreflight({ contentProfile: 'manhwa_recap_v1', mediaWorkflow: 'generated_visuals_v1' });
const base = { schema: 'goldflow_run_identity_v2', ...binding, channel: 'fixture', series_slug: 'fixture', week: 'fixture', episode: 'ep_01', content_profile: 'manhwa_recap_v1', run_intent: 'production', audio_target: 'narrator_only', render_profile: 'smooth_subpixel_ken_burns', generated_motion_policy: 'disabled', animation_policy: 'disabled', ltx_video_policy: 'disabled', parallax_policy: 'selective_inspected' };
const panel = { ...base, render_profile: 'panel_composition_v1', panel_composition_contract: createPanelProductionContract(), parallax_policy: 'disabled' };
let count = 0;
const test = async (name, work) => { await work(); count++; console.log(`ok - ${name}`); };
async function tree(dir) {
  const result = [];
  for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name);
    result.push(entry.isDirectory() ? [entry.name, await tree(file)] : [entry.name, await sha256File(file)]);
  }
  return result;
}
try {
  await test('new profile preserves generated registry and ordinary defaults', () => {
    // A newly bound identity takes the current generated chain; the historical export stays
    // the 2026-08-22.1 row set and shares every row after the script lock.
    assert.equal(stageRegistryFor(base), PIPELINE_STAGE_REGISTRY_CURRENT);
    assert.equal(stageRegistryFor(panel), PIPELINE_STAGE_REGISTRY_CURRENT);
    assert.deepEqual(PIPELINE_STAGE_REGISTRY_CURRENT.map(row => row.id).slice(4), PIPELINE_STAGE_REGISTRY.map(row => row.id).slice(5));
    assert.equal(PIPELINE_STAGE_REGISTRY_VERSION, GENERATED_VISUALS_STAGE_REGISTRY_VERSION);
    assert.equal(stageChecklistFor(base).find(row => row.stage === 'transition_edit_plan').status, 'missing');
    assert.equal(stageChecklistFor(panel).find(row => row.stage === 'transition_edit_plan').status, 'skipped_with_waiver');
    assert.match(buildStageCommand('motion_edit_plan', base), /visual motion-plan/);
    assert.match(buildStageCommand('motion_edit_plan', panel), /visual panel-plan.*--action prepare/);
    assert.match(buildStageCommand('premium_render', panel), /--motion panel_composition_v1 --fps 30/);
    assert.equal(commandStageFor('visual', 'panel-assets'), 'visual_prompt_plan');
    assert.equal(commandStageFor('visual', 'panel-plan'), 'motion_edit_plan');
    assert.equal(commandStageFor('imagegen', 'panel-reconcile'), 'image_generation');
    assert.match(stageDefinition('motion_edit_plan', panel).output_artifact, /panel_timeline/);
  });
  await test('contract is exact, immutable in value, and production only', () => {
    assert.deepEqual(assertPanelProductionIdentity(panel), createPanelProductionContract());
    const mutable = createPanelProductionContract(); mutable.canvas.fps = 60;
    assert.equal(createPanelProductionContract().canvas.fps, 30);
    for (const change of [{ workflow_contract: null }, { run_intent: 'proof' }, { content_profile: 'asset_afterlife_v1' }, { schema: 'goldflow_run_identity_v1' }, { audio_target: 'score' }, { generated_motion_policy: 'selective_generated_video' }, { parallax_policy: 'selective_inspected' }, { panel_composition_contract: mutable }]) assert.throws(() => assertPanelProductionIdentity({ ...panel, ...change }));
    assert.throws(() => stageRegistryFor({ ...base, panel_composition_contract: createPanelProductionContract() }));
    // New identities lock the dense-page route; a historical contract without it stays valid and is read as legacy.
    assert.equal(createPanelProductionContract().allocation_route.id, 'dense_pages_v1');
    assert.equal(panelAllocationRoute(panel), 'dense_pages_v1');
    const legacy = createLegacyPanelProductionContract();
    assert.equal(legacy.allocation_route, undefined); assert.equal(legacy.version, '2026-10-17.1');
    assert.deepEqual(assertPanelProductionIdentity({ ...panel, panel_composition_contract: legacy }), legacy);
    assert.equal(panelAllocationRoute({ ...panel, panel_composition_contract: legacy }), 'legacy_authored_v1');
    assert.throws(() => assertPanelProductionIdentity({ ...panel, panel_composition_contract: { ...legacy, allocation_route: createPanelProductionContract().allocation_route } }));
  });
  await test('explicit incompatible requests fail before defaults suppress them', () => {
    const route = { contentProfile: 'manhwa_recap_v1', mediaWorkflow: 'generated_visuals_v1' };
    assert.equal(assertPanelProductionPreflightFlags({ 'render-profile': 'panel_composition_v1' }, route), true);
    for (const flags of [{ 'parallax-policy': 'selective_inspected' }, { 'animation-policy': 'selective_generated_video' }, { 'generated-motion-provider': 'flow' }, { 'audio-target': 'narrator_sfx_score' }, { fps: '60' }, { intent: 'proof' }, { render: 'premium' }]) assert.throws(() => assertPanelProductionPreflightFlags({ 'render-profile': 'panel_composition_v1', ...flags }, route));
    assert.equal(assertPanelProductionPreflightFlags({}, route), false);
  });
  const episodeDir = path.join(scratch, 'episode'); await fs.mkdir(episodeDir); await json(path.join(episodeDir, 'run_identity.json'), panel);
  await test('routing prevents migrated identities and old motion paths even under bypass', () => {
    assert.throws(() => assertEpisodeWorkflowFlags(base, { motion: 'panel_composition_v1' }), /new run identity/);
    for (const subcommand of ['transitions', 'motion-plan', 'animation-plan', 'generated-motion', 'parallax-assets']) assert.throws(() => assertCommandWorkflowRoute({ command: 'visual', subcommand, script: 'unused.mjs', flags: { 'workflow-bypass': 'true' }, episodeDir }), /unavailable/);
    assert.throws(() => assertCommandWorkflowRoute({ command: 'run', subcommand: 'visual-wavefront', script: 'run-visual-wavefront.mjs', episodeDir }), /unavailable/);
    for (const subcommand of ['panel-assets', 'panel-plan']) assert.doesNotThrow(() => assertCommandWorkflowRoute({ command: 'visual', subcommand, script: 'panel-production.mjs', episodeDir }));
  });
  await test('rejected CLI routing writes no episode state or execution events', async () => {
    const before = await tree(scratch);
    for (const args of [
      ['visual', 'motion-plan', '--episode-dir', episodeDir, '--workflow-bypass', 'true', '--bypass-reason-code', 'test_fixture'],
      ['run', 'preflight', '--channel', 'fixture', '--series', 'fixture', '--week', 'fixture', '--episode', 'ep_02', '--content-profile', 'manhwa_recap_v1', '--media-workflow', 'generated_visuals_v1', '--render-profile', 'panel_composition_v1', '--fps', '60'],
    ]) {
      await assert.rejects(exec(process.execPath, ['bin/goldflow.mjs', ...args], { cwd: root, env: { PATH: process.env.PATH, ANIFACTORY_DATA_ROOT: scratch }, timeout: 20000 }), error => error.code === 1 && /[Pp]anel|panel_composition_v1/.test(error.stderr));
      assert.deepEqual(await tree(scratch), before);
    }
  });
  await test('prepare and compile remain non-provider control actions', () => {
    for (const subcommand of ['panel-assets', 'panel-plan']) assert.equal(creativeStageRerunDecision({ command: 'visual', subcommand, stage: commandStageFor('visual', subcommand), priorEvents: [{ stage: 'motion_edit_plan', event_type: 'stage_completed', command: 'visual panel-plan', status: 'passed' }] }).allowed, true);
  });
  await test('asset preparation history does not consume the first actual planner attempt', () => {
    const preparation = { stage: 'visual_prompt_plan', event_type: 'stage_completed', command: 'visual panel-assets', status: 'passed' };
    assert.equal(plannerRerunDecision({ command: 'visual', subcommand: 'panel-assets', stage: 'visual_prompt_plan', priorEvents: [preparation] }).allowed, true);
    assert.equal(plannerRerunDecision({ command: 'visual', subcommand: 'plan', stage: 'visual_prompt_plan', priorEvents: [preparation] }).allowed, true);
    assert.equal(plannerRerunDecision({ command: 'visual', subcommand: 'plan', stage: 'visual_prompt_plan', priorEvents: [preparation, { ...preparation, command: 'visual plan' }] }).allowed, false);
  });
  await test('asset status requires approved exact beat dependencies', async () => {
    assert.equal((await panelArtifactComplete({ episodeDir, identity: panel, kind: 'assets' })).done, false);
    const script = path.join(episodeDir, 'script_clean.md'); await fs.writeFile(script, 'The door opened. Joey watched.');
    const scriptHash = await sha256File(script);
    await json(path.join(episodeDir, 'script_lock.json'), { script_clean_hash: scriptHash });
    await json(path.join(episodeDir, 'operator_script_approval.json'), { operator_approved: true, script_clean_hash: scriptHash });
    const beats = [{ visual_beat_id: 'beat_01', image_id_hint: 'image_01', start_sec: 0, end_sec: 1 }, { visual_beat_id: 'beat_02', image_id_hint: 'image_02', start_sec: 1, end_sec: 2 }];
    const beatPath = path.join(episodeDir, 'visual_beat_plan.json');
    await json(beatPath, { status: 'passed', source_script_hash: scriptHash, beats, editorial_director: { grouping_lock_sha256: 'fixture' } });
    await json(path.join(episodeDir, 'visual_beat_approval.json'), { status: 'approved', visual_beat_plan_sha256: await sha256File(beatPath), grouping_lock_sha256: 'fixture' });
    const prepared = await preparePanelAssetPlan({ episodeDir });
    const candidate = { ...prepared.candidate, author: 'fixture', asset_orders: [{ asset_id: 'asset_01', owner_beat_id: 'beat_01', beat_ids: ['beat_01', 'beat_02'], visual_brief: 'Joey at the open doorway.', editorial_reason: 'Both beats show the same moment.' }], beat_bindings: beats.map(beat => ({ beat_id: beat.visual_beat_id, asset_id: 'asset_01', editorial_reason: 'Hold the same scene.' })) };
    await json(prepared.candidatePath, candidate);
    const loaded = await writePanelAssetPlan({ episodeDir, planPath: prepared.candidatePath });
    assert.equal((await panelArtifactComplete({ episodeDir, identity: panel, kind: 'assets' })).done, true);
    const prompts = expandPanelAssetPrompts([{ image_id: 'image_01', visual_beat_id: 'beat_01', prompt: 'Fixture art.' }], { plan: loaded.plan, beats, planSha256: loaded.planSha256 });
    const promptPath = path.join(episodeDir, 'section_image_prompts_hardened.json'); await json(promptPath, { status: 'passed', prompts });
    const imageDir = path.join(episodeDir, 'assets/images'); await fs.mkdir(imageDir, { recursive: true });
    const owner = path.join(imageDir, 'image_01-fixture.png'), alias = path.join(imageDir, 'image_02-fixture.png');
    await fs.writeFile(owner, 'exact raster fixture bytes'); await fs.copyFile(owner, alias);
    const rasterHash = await sha256File(owner);
    const aliasMetadata = { editorial_reuse_approved: true, reuse_source_image_id: 'image_01', source_image_sha256: rasterHash, panel_asset_id: 'asset_01', panel_asset_plan_sha256: loaded.planSha256 };
    await json(`${alias}.metadata.json`, aliasMetadata);
    const imageReport = { status: 'passed', expected_image_count: 2, image_count: 2, missing_image_count: 0, prompt_plan_hash: await sha256File(promptPath), results: [{ image_id: 'image_01', image_path: owner, status: 'generated', generated: { output_sha256: rasterHash } }, { image_id: 'image_02', image_path: alias, status: 'editorial_reuse' }] };
    await json(path.join(episodeDir, 'imagegen_report_ep_01.json'), imageReport);
    assert.equal((await imageReportComplete(episodeDir, 'ep_01', panel)).done, true, 'declared exact same-art alias is valid');
    await fs.writeFile(alias, 'changed alias bytes');
    assert.equal((await imageReportComplete(episodeDir, 'ep_01', panel)).state, 'stale', 'changed alias cannot sneak through as a unique raster');
    await fs.copyFile(alias, owner);
    assert.equal((await imageReportComplete(episodeDir, 'ep_01', panel)).state, 'stale', 'identical mutations of owner and alias cannot replace accepted raster hashes');
    await fs.writeFile(owner, 'exact raster fixture bytes');
    await fs.copyFile(owner, alias);
    await json(`${alias}.metadata.json`, { editorial_reuse_approved: true, reuse_source_image_id: 'image_01', panel_asset_id: 'asset_01', panel_asset_plan_sha256: '0'.repeat(64) });
    assert.equal((await imageReportComplete(episodeDir, 'ep_01', panel)).state, 'stale', 'standalone reuse boolean cannot approve a stale allocation');
    await json(`${alias}.metadata.json`, aliasMetadata);
    const browserIdentity = { ...panel, image_provider: 'federated_google_web_image_pool' };
    // Provider is only a status command preference here; the immutable identity
    // and allocation used by the loader remain unchanged.
    await json(path.join(episodeDir, 'imagegen_report_ep_01.json'), { ...imageReport, status: 'failed', image_count: 0, missing_image_count: 2, results: [{ image_id: 'image_01', status: 'failed' }, { image_id: 'image_02', status: 'failed' }] });
    let recovery = await imageReportComplete(episodeDir, 'ep_01', browserIdentity);
    assert.match(recovery.next_command_shape, /--image-ids image_01\b/);
    assert.doesNotMatch(recovery.next_command_shape, /image_02/);
    await fs.rm(alias);
    await json(path.join(episodeDir, 'imagegen_report_ep_01.json'), { ...imageReport, status: 'partial', image_count: 1, missing_image_count: 1, results: [imageReport.results[0]] });
    recovery = await imageReportComplete(episodeDir, 'ep_01', browserIdentity);
    assert.match(recovery.next_command_shape, /imagegen panel-reconcile --episode-dir/);
    assert.doesNotMatch(recovery.next_command_shape, /--image-ids|--repair-reason/);
    await fs.copyFile(owner, alias);
    await json(path.join(episodeDir, 'imagegen_report_ep_01.json'), imageReport);
    await json(path.join(episodeDir, 'image_output_qa_ep_01.json'), { status: 'blocked', critical_rejected_image_ids: ['image_02'], next_command: 'node bin/goldflow.mjs imagegen browser-pool --image-ids image_02 --qa-recovery true' });
    recovery = await imageOutputQaComplete(episodeDir, 'ep_01', { ...browserIdentity, image_output_qa_required: true });
    assert.equal(recovery.state, 'blocked');
    assert.match(recovery.next_command_shape, /Review the authored panel allocation/);
    assert.doesNotMatch(recovery.next_command_shape, /--image-ids/);
    await fs.appendFile(script, ' Changed.');
    assert.equal((await panelArtifactComplete({ episodeDir, identity: panel, kind: 'assets' })).state, 'stale');
  });
  console.log(`${count} panel production policy tests passed.`);
} finally { await fs.rm(scratch, { recursive: true, force: true }); }
