import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createPanelProductionContract } from '../lib/panel-production-policy.mjs';
import { mediaWorkflowForPreflight } from '../lib/media-workflows.mjs';
import { masterNarrationTwoPass } from '../lib/narration-mastering.mjs';
import { preparePanelAssetPlan, writePanelAssetPlan, expandPanelAssetPrompts } from '../lib/panel-production-assets.mjs';
import { writePageGeometry, panelPageGeometryDir } from '../lib/panel-page-geometry.mjs';

// A 640x360 P2V page: deterministic mid-tone noise split by one white gutter.
export async function fixturePageRaster({ gutterX = 320 } = {}) {
  const width = 640, height = 360, pixels = Buffer.alloc(width * height * 3);
  let seed = 11;
  for (let i = 0; i < pixels.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; pixels[i] = 30 + (seed % 140); }
  for (let y = 0; y < height; y++) for (let x = gutterX - 4; x < gutterX + 4; x++) pixels.fill(250, (y * width + x) * 3, (y * width + x) * 3 + 3);
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

export const digest = value => createHash('sha256').update(value).digest('hex');
export async function writeJson(file, value) { const bytes = `${JSON.stringify(value, null, 2)}\n`; await fs.writeFile(file, bytes); return digest(bytes); }
export async function panelProductionFixture(dir, { prerollSec = 0, pages = false } = {}) {
  await fs.mkdir(dir, { recursive: true }); const p = name => path.join(dir, name);
  const identity = { schema: 'goldflow_run_identity_v2', channel: 'fixture', series_slug: 'panel-fixture', week: 'fixture', episode: 'ep_01', run_intent: 'production', content_profile: 'manhwa_recap_v1', ...mediaWorkflowForPreflight({ contentProfile: 'manhwa_recap_v1', mediaWorkflow: 'generated_visuals_v1' }), render_profile: 'panel_composition_v1', panel_composition_contract: createPanelProductionContract(), audio_target: 'narrator_only', generated_motion_policy: 'disabled', parallax_policy: 'disabled', tts_provider: 'qwen_local', narration_quality_contract: { contract_sha256: 'c'.repeat(64), subjective_review: { hash_bound_sampling_manifest_required: false } } };
  const identityHash = await writeJson(p('run_identity.json'), identity);
  const source = 'I paid $2.'; await fs.writeFile(p('script_clean.md'), source); const sourceHash = digest(source);
  await writeJson(p('operator_script_approval.json'), { operator_approved: true, script_clean_hash: sourceHash });
  await writeJson(p('script_lock.json'), { script_clean_hash: sourceHash });
  const rate = 24000, samples = rate * 3, audioBytes = Buffer.alloc(44 + 2 * samples);
  audioBytes.write('RIFF'); audioBytes.writeUInt32LE(audioBytes.length - 8, 4); audioBytes.write('WAVEfmt ', 8); audioBytes.writeUInt32LE(16, 16); audioBytes.writeUInt16LE(1, 20); audioBytes.writeUInt16LE(1, 22); audioBytes.writeUInt32LE(rate, 24); audioBytes.writeUInt32LE(rate * 2, 28); audioBytes.writeUInt16LE(2, 32); audioBytes.writeUInt16LE(16, 34); audioBytes.write('data', 36); audioBytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) audioBytes.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / rate) * 1000), 44 + i * 2);
  await fs.writeFile(p('raw-fixture-tone.wav'), audioBytes);
  const mastering = await masterNarrationTwoPass({ inputPath: p('raw-fixture-tone.wav'), outputPath: p('canonical.wav'), targetLufs: -16, truePeakDbtp: -1.5, loudnessRange: 11, sampleRateHz: rate, channels: 1 });
  if (mastering.status !== 'passed') throw new Error(`Fixture mastering failed: ${JSON.stringify(mastering.blockers)}`);
  const audioHash = digest(await fs.readFile(p('canonical.wav')));
  const narration = { schema: 'goldflow_provider_neutral_narration_stitch_v2', status: 'passed', source_script_hash: sourceHash, output_path: p('canonical.wav'), output_sha256: audioHash, final_duration_sec: 3, mastering, segments: [{ unit_id: 'fixture_unit_01', source_text: source, caption_text: source, spoken_text: 'I paid two dollars.', start_sec: 0, end_sec: 3, duration_sec: 3 }] };
  const narrationHash = await writeJson(p('audio_stitch_report_ep_01-narration.json'), narration);
  await writeJson(p('narration_final_delivery_qa_ep_01.json'), { schema: 'goldflow_narration_final_delivery_qa_v2', status: 'passed', source_script_hash: sourceHash, narration_audio_hash: audioHash, quality_contract_sha256: identity.narration_quality_contract.contract_sha256, blockers: [] });
  const words = [{ index: 0, word: 'I', start_sec: prerollSec, end_sec: .4 }, { index: 1, word: 'paid', start_sec: .4, end_sec: .9 }, { index: 2, word: 'two', start_sec: 1, end_sec: 1.8 }, { index: 3, word: 'dollars.', start_sec: 1.8, end_sec: 2.8 }];
  const timing = { schema: 'goldflow_local_whisper_word_timing_v2', status: 'passed', source_script_hash: sourceHash, narration_audio_hash: audioHash, narration_audio_path: p('canonical.wav'), narration_report_sha256: narrationHash, run_identity_sha256: identityHash, word_count: words.length, words, word_timing_qa: { status: 'passed' }, full_stream_transcript_qa: { status: 'passed' }, source_hashes: { [p('run_identity.json')]: identityHash, [p('script_clean.md')]: sourceHash, [p('canonical.wav')]: audioHash, [p('audio_stitch_report_ep_01-narration.json')]: narrationHash } };
  const timingHash = await writeJson(p('narration_word_timing_ep_01.json'), timing);
  await writeJson(p('longform_audio_bed_report_ep_01.json'), { status: 'completed', narration_only: true, source_script_hash: sourceHash, narration_report_path: p('audio_stitch_report_ep_01-narration.json'), narration_report_sha256: narrationHash, narration_sha256: audioHash, narration_path: p('canonical.wav'), final_audio_path: p('canonical.wav'), final_audio_sha256: audioHash, mixed_duration_sec: 3, mix: { render_input_path: p('canonical.wav'), render_input_sha256: audioHash, wav_path: p('canonical.wav'), duration_sec: 3, narration_only: true, audio_design_enabled: false, transition_sfx_enabled: false, transition_sfx_event_count: 0, narration_volume_db: 0, target_lufs: -16, true_peak_db: -1.5, loudness_range: 11, mastering }, source_hashes: { [p('canonical.wav')]: audioHash, [p('audio_stitch_report_ep_01-narration.json')]: narrationHash } });
  const beats = [
    { visual_beat_id: 'beat_w000000_w000001', image_id_hint: 'image_a', scene_id: 'scene_01', source_word_start_index: 0, source_word_end_index: 1, start_sec: prerollSec, end_sec: 1, duration_sec: 1 - prerollSec, visual_beat_script_excerpt: 'I paid' },
    { visual_beat_id: 'beat_w000002_w000003', image_id_hint: 'image_b', scene_id: 'scene_01', source_word_start_index: 2, source_word_end_index: 3, start_sec: 1, end_sec: 3, duration_sec: 2, visual_beat_script_excerpt: '$2.' },
  ];
  const beatPlan = { schema: 'goldflow_visual_beat_plan_v2', status: 'passed', source_script_hash: sourceHash, word_timing_audio_hash: audioHash, beats, editorial_director: { grouping_lock_sha256: 'b'.repeat(64) }, source_hashes: { [p('script_clean.md')]: sourceHash, [p('narration_word_timing_ep_01.json')]: timingHash } };
  const beatHash = await writeJson(p('visual_beat_plan.json'), beatPlan);
  await writeJson(p('visual_beat_approval.json'), { status: 'approved', visual_beat_plan_sha256: beatHash, grouping_lock_sha256: 'b'.repeat(64) });
  const prepared = await preparePanelAssetPlan({ episodeDir: dir });
  const candidate = pages ? { ...prepared.candidate, schema: 'goldflow_panel_asset_plan_v2', author: 'Fixture editor', asset_orders: [{
    asset_id: 'page_0', kind: 'page', page_template: 'P2V', owner_beat_id: beats[0].visual_beat_id, beat_ids: beats.map(beat => beat.visual_beat_id),
    visual_brief: 'One page: the payment on the left, the price on the right.', editorial_reason: 'Both beats share one moment and location.',
    zones: beats.map((beat, i) => ({ zone_id: `page_0_z${i + 1}`, slot: i ? 'right' : 'left', beat_ids: [beat.visual_beat_id], visual_brief: `Fixture zone ${i}`, editorial_reason: 'One zone per beat.' })),
  }], beat_bindings: beats.map((beat, i) => ({ beat_id: beat.visual_beat_id, asset_id: 'page_0', zone_id: `page_0_z${i + 1}`, editorial_reason: 'Exact fixture zone binding.' })) } : { ...prepared.candidate, author: 'Fixture editor', asset_orders: beats.map((beat, i) => ({ asset_id: `art_${i}`, owner_beat_id: beat.visual_beat_id, beat_ids: [beat.visual_beat_id], visual_brief: `Fixture illustration ${i}`, editorial_reason: 'Separate fixture colors make image boundaries measurable.' })), beat_bindings: beats.map((beat, i) => ({ beat_id: beat.visual_beat_id, asset_id: `art_${i}`, editorial_reason: 'Exact fixture beat binding.' })) };
  await writeJson(prepared.candidatePath, candidate);
  const allocation = await writePanelAssetPlan({ episodeDir: dir, planPath: prepared.candidatePath });
  const prompts = expandPanelAssetPrompts(beats.map(beat => ({ ...beat, image_id: beat.image_id_hint, image_prompt: 'Fixture plain image', shot_manifest: {}, reference_requirements: [] })), { plan: allocation.plan, beats, planSha256: allocation.planSha256 });
  const promptHash = await writeJson(p('section_image_prompts_hardened.json'), { status: 'passed', prompts });
  const accepted = {}, results = [], cuts = [];
  for (const [index, beat] of beats.entries()) {
    const imagePath = p(`${beat.image_id_hint}.png`);
    // Page aliases are byte-identical copies of the one generated page.
    if (pages) await fs.writeFile(imagePath, await fixturePageRaster());
    else await sharp({ create: { width: 320, height: 180, channels: 3, background: index ? '#064080' : '#e04020' } }).png().toFile(imagePath);
    const hash = digest(await fs.readFile(imagePath)); accepted[beat.image_id_hint] = hash;
    results.push({ image_id: beat.image_id_hint, image_path: imagePath, status: 'generated', generated: { output_sha256: hash } });
    const prompt = prompts[index];
    cuts.push({ image_id: beat.image_id_hint, image_path: imagePath, image_sha256: hash, image_qa_status: 'passed', authored_prompt_hash: digest(JSON.stringify({ image_prompt: prompt.image_prompt ?? null, modelslab_image_prompt: prompt.modelslab_image_prompt ?? null, codex_image_prompt: prompt.codex_image_prompt ?? null, shot_manifest: prompt.shot_manifest ?? null, reference_requirements: prompt.reference_requirements ?? [] })), reference_ids: [], references: [] });
  }
  const imageHash = await writeJson(p('imagegen_report_ep_01.json'), { schema: 'goldflow_imagegen_report_v1', status: 'passed', prompt_plan_hash: promptHash, expected_image_count: 2, image_count: 2, missing_image_count: 0, results });
  const decisionsHash = await writeJson(p('image_output_review_decisions_ep_01.json'), { status: 'complete', decisions: Object.entries(accepted).map(([image_id, image_sha256]) => ({ image_id, image_sha256, decision: 'accepted' })) });
  const focalHash = await writeJson(p('image_focal_analysis_ep_01.json'), { status: 'passed', prompt_plan_sha256: promptHash, imagegen_report_sha256: imageHash, analyses: [] });
  await writeJson(p('image_output_qa_ep_01.json'), { status: 'passed', unresolved_blocker_count: 0, imagegen_report_sha256: imageHash, prompt_plan_sha256: promptHash, review_decisions_path: p('image_output_review_decisions_ep_01.json'), review_decisions_sha256: decisionsHash, focal_analysis_sha256: focalHash, accepted_image_hashes: accepted, critical_rejected_image_ids: [], not_inspected_image_ids: [] });
  await writeJson(p('cut_execution_ledger.json'), { cuts });
  const geometry = pages ? await writePageGeometry({ imagePath: p(`${beats[0].image_id_hint}.png`), template: 'P2V', outputDir: panelPageGeometryDir(dir, 'page_0') }) : null;
  return { geometry, episodeDir: dir, p, identity, beats, source, words, accepted, audioHash, allocation };
}
