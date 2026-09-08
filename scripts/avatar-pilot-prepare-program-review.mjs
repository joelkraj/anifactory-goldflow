import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { SENTRY_PROGRAM_EDITORIAL } from './lib/sentry-program-editorial.mjs';
import { PROGRAM_REVIEW_SCHEMA, validateProgramReviewShape } from './lib/avatar-pilot-program-review.mjs';

const flags = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  if (!['--episode-dir', '--candidate-id'].includes(key) || !value || flags.has(key)) {
    throw new Error('Use --episode-dir <absolute episode path> --candidate-id <new review ID>.');
  }
  flags.set(key, value);
}
const episode = flags.get('--episode-dir'), candidateId = flags.get('--candidate-id');
if (!episode || !path.isAbsolute(episode) || !/^[a-z0-9][a-z0-9_-]{0,59}$/.test(candidateId ?? '')) {
  throw new Error('An explicit absolute episode directory and new candidate ID are required.');
}
const need = (ok, message) => { if (!ok) throw new Error(`Program request preparation blocked: ${message}`); };
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ref = async (file) => {
  const stat = await fs.lstat(file);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 512 * 1024 * 1024
    && await fs.realpath(file) === file, 'regular bounded local source required');
  return { path: file, sha256: sha(await fs.readFile(file)) };
};
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const bound = async (binding) => {
  need(binding?.path && binding.sha256 === (await ref(binding.path)).sha256, 'source hash changed');
  return binding;
};
const media = path.join(episode, 'pilot_media_work');
const outputDir = path.join(media, 'program_review_v1');
need(!await fs.lstat(outputDir).catch((error) => { if (error.code === 'ENOENT') return null; throw error; }),
  'the request directory already exists; preserve it and inspect the retained request');

const identityRef = await ref(path.join(episode, 'run_identity.json'));
const identity = await readJson(identityRef.path);
need(identity.content_profile === 'mcu_what_if_pilot_v1' && identity.media_workflow === 'avatar_footage_pilot_v1'
  && identity.source_script?.sha256 === SENTRY_PROGRAM_EDITORIAL.source_script_sha256,
  'the authored Sentry proof identity and exact approved script are required');
const narrationStage = await readJson(path.join(episode, 'pilot_narration.json'));
need(narrationStage.stage === 'pilot_narration' && narrationStage.identity_sha256 === identityRef.sha256,
  'accepted narration must belong to this identity');
const acceptedNarration = narrationStage.payload;
await bound(acceptedNarration.audio);
await bound(acceptedNarration.whisper_timing);
need(acceptedNarration.audio.sha256 === SENTRY_PROGRAM_EDITORIAL.narration_audio_sha256,
  'the authored timing binds a different narration master');
const timing = await readJson(acceptedNarration.whisper_timing.path);
need(timing.audio_duration_sec === 72.22 && timing.word_count === 232,
  'the exact accepted narration duration and word timing are required');

const previewRoot = path.join(episode, 'pilot_visual_reviews', 'sentry-style-repair-v4');
const previewRef = await ref(path.join(previewRoot, 'result.json'));
const previewResult = await readJson(previewRef.path);
need(previewResult.identity?.sha256 === identityRef.sha256 && previewResult.duration_frames === 360
  && previewResult.status === 'awaiting_visual_review' && previewResult.official_stage_completed === false,
  'the retained successful v4 style preview is required');
await bound(previewResult.output);
await bound(previewResult.request);
const preview = await readJson(previewResult.request.path);
need(preview.candidate_id === 'sentry-style-repair-v4' && preview.identity_sha256 === identityRef.sha256,
  'the retained v4 request identity does not match');

// Preserve each reviewed v4 asset row, including external-art provenance, exactly.
const assets = structuredClone(preview.assets);
for (const asset of assets) await bound(asset);
need(assets.find((row) => row.id === 'narration_joel')?.sha256 === acceptedNarration.audio.sha256,
  'the reviewed style must use the exact accepted narration');
for (const id of ['host_confident', 'host_thinking', 'host_skeptical']) {
  const file = await ref(path.join(media, id, `${id}_alpha_v1.png`));
  const receipt = await ref(path.join(media, id, 'provider_receipt_v1.json'));
  const providerReceipt = await readJson(receipt.path);
  need(providerReceipt.asset_id === id && providerReceipt.status === 'passed'
    && providerReceipt.output_sha256 === file.sha256 && providerReceipt.review?.approved === true,
  `the ${id} output must retain its actual accepted provider review`);
  assets.push({ id, kind: 'host_pose', ...file, provenance: { type: 'accepted_generated', receipt } });
}

const plan = (await readJson(path.join(episode, 'pilot_concept_fallback', 'pilot_asset_plan.json'))).payload;
const voidClip = plan.assets.find((row) => row.id === 'film_void_shadow');
need(voidClip?.kind === 'movie_clip', 'the existing planned Void movie excerpt is required');
await bound(voidClip.existing_file);
assets.push({ id: 'film_void_shadow', kind: 'movie_clip', ...voidClip.existing_file,
  provenance: { type: 'accepted_movie_clip' } });
const voidCutout = await ref(path.join(media, 'local_composites', 'void_cutout.png'));
const recipeRef = await ref(path.join(media, 'local_composites', 'recipe.json'));
const recipe = await readJson(recipeRef.path);
need(recipe.intermediate_hashes?.void_cutout === voidCutout.sha256
  && recipe.source_frame_offsets_sec?.film_void_shadow === 2,
  'the retained Void cutout must match its source-frame recipe');
assets.push({ id: 'void_illustration', kind: 'illustration', ...voidCutout, provenance: {
  type: 'source_movie_cutout', truth_mode: 'illustration_only', source_asset_id: 'film_void_shadow',
  source: structuredClone(voidClip.existing_file),
  description: 'The retained Void foreground cutout from two seconds inside the exact accepted five-second movie excerpt. Used as an independently moving illustration; source film evidence stays in its separate five-second card.',
  derivation: { method: 'ffmpeg_frame_then_macos_vision_foreground_mask_then_sharp_sticker_board',
    recipe: recipeRef, intermediate_key: 'void_cutout', frame_time_sec: 2 },
} });

const editorialRef = await ref(fileURLToPath(new URL('./lib/sentry-program-editorial.mjs', import.meta.url)));
const request = {
  schema: PROGRAM_REVIEW_SCHEMA, intent: 'local_program_review', candidate_id: candidateId,
  identity_sha256: identityRef.sha256, width: 1920, height: 1080, fps: 30, duration_frames: 2700,
  production_eligible: false, publish_allowed: false,
  narration: { asset_id: 'narration_joel', source_in_sec: 0, source_out_sec: 72.22, output_in_sec: 0 },
  narration_placements: SENTRY_PROGRAM_EDITORIAL.narration.map((row) => ({
    asset_id: row.asset_id, source_in_sec: row.source_in_sec, source_out_sec: row.source_out_sec,
    output_in_sec: row.output_start_frame / 30,
  })),
  accepted_style_preview: previewRef,
  style_direction_approval: {
    reviewer: 'Joel',
    note: 'Joel praised the displayed v4 twelve-second proof, then answered yes to carrying its visual direction through the full ninety seconds. This authorizes creation of the complete private edit for viewing; it does not claim that the unrendered ninety-second program has already been reviewed or accepted.',
    operator_messages: ['that is fucking beautiful you amazing machine', 'yes'],
    authorizes_full_90_second_review: true,
  },
  assets,
  recipe: {
    id: 'sentry_program_review_v1',
    operator_direction: 'Carry the accepted v4 style through the existing ninety-second Sentry what-if proof: recognizable independently moving character cutouts, the masked host and room, short film cards, and the complete approved Joel narration.',
    editorial_source: editorialRef,
    accepted_word_timing: structuredClone(acceptedNarration.whisper_timing),
    timeline: structuredClone(SENTRY_PROGRAM_EDITORIAL),
    captions: [], new_synthesis: false, added_music_or_sfx: false,
  },
};
validateProgramReviewShape(request);
for (const original of preview.assets) {
  need(JSON.stringify(assets.find((row) => row.id === original.id)) === JSON.stringify(original),
    'the accepted v4 asset rows must remain identical');
}
await fs.mkdir(outputDir, { recursive: false, mode: 0o700 });
const output = path.join(outputDir, 'request.json');
await fs.writeFile(output, `${JSON.stringify(request, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ request: await ref(output), candidate_id: candidateId, assets: assets.length,
  duration_frames: request.duration_frames, official_stage_completed: false, provider_calls: 0 }));
