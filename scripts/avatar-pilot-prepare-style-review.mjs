import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--episode-dir' || !path.isAbsolute(args[1])) throw new Error('Use --episode-dir <absolute path>.');
const episode = args[1], media = path.join(episode, 'pilot_media_work'), sources = path.join(media, 'style_sources_v2');
const ref = async (p) => ({ path: p, sha256: createHash('sha256').update(await fs.readFile(p)).digest('hex') });
const write = async (p, j) => fs.writeFile(p, `${JSON.stringify(j, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
const identityRef = await ref(path.join(episode, 'run_identity.json'));
const identity = JSON.parse(await fs.readFile(identityRef.path));
if (identity.content_profile !== 'mcu_what_if_pilot_v1' || identity.media_workflow !== 'avatar_footage_pilot_v1') throw new Error('Wrong proof identity.');
const plan = JSON.parse(await fs.readFile(path.join(episode, 'pilot_concept_fallback', 'pilot_asset_plan.json'))).payload;
const assets = [];
for (const [id, kind] of [['narration_joel', 'narration'], ['film_sentry_window', 'movie_clip']]) {
  const asset = plan.assets.find((row) => row.id === id);
  assets.push({ id, kind, ...asset.existing_file, provenance: { type: kind === 'narration' ? 'accepted_narration' : 'accepted_movie_clip' } });
}
for (const id of ['host_open_palm', 'host_presenting', 'host_room']) {
  const file = id === 'host_room' ? 'host_room_candidate_v2_full_frame.jpeg' : `${id}_alpha_v1.png`;
  const receipt = id === 'host_room' ? 'provider_receipt_v2.json' : 'provider_receipt_v1.json';
  assets.push({ id, kind: id === 'host_room' ? 'background' : 'host_pose', ...await ref(path.join(media, id, file)),
    provenance: { type: 'accepted_generated', receipt: await ref(path.join(media, id, receipt)) } });
}
const doomFile = path.join(sources, 'doom_cutout_clean_v2.png'), sentryFile = path.join(sources, 'sentry_cutout_clean_v2.png');
for (const p of [doomFile, sentryFile]) if (await fs.stat(p).catch(() => null)) throw new Error('Prepared cutouts already exist; preserve and inspect them.');
const doomMask = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="938" height="1226"><path d="M350 8C443 12 535 76 582 167L702 310 938 300V1226H0V697L76 651 103 563 116 415 144 261 169 145 240 69Z" fill="white"/></svg>');
await sharp(path.join(sources, 'doom_cutout.png')).composite([{ input: doomMask, blend: 'dest-in' }]).png().toFile(doomFile);
await sharp(path.join(sources, 'sentry_cutout.png')).flop().modulate({ brightness: 1.13, saturation: 1.04 }).png().toFile(sentryFile);
assets.push({ id: 'doom_illustration', kind: 'illustration', ...await ref(doomFile), provenance: {
  type: 'external_illustration', truth_mode: 'illustration_only', source: await ref(path.join(sources, 'doom_alex_ross.jpg')),
  source_url: 'https://www.alexrossart.com/products/marvelocity-doctor-doom',
  description: 'Alex Ross Doctor Doom comic portrait from the artist website. Used as character illustration in a hypothetical encounter, not MCU appearance or ability evidence.',
  derivation: { method: 'macos_vision_foreground_mask_then_authored_left_background_alpha_cleanup', original_cutout: await ref(path.join(sources, 'doom_cutout.png')), cleanup_mask_sha256: createHash('sha256').update(doomMask).digest('hex') },
} });
assets.push({ id: 'sentry_illustration', kind: 'illustration', ...await ref(sentryFile), provenance: {
  type: 'external_illustration', truth_mode: 'illustration_only', source: await ref(path.join(sources, 'sentry_ilm_plate.jpg')),
  source_url: 'https://www.ilm.com/thunderbolts-marvel-chad-wiebe-interview-ilm/',
  description: 'ILM/Marvel Thunderbolts Lewis Pullman production plate, before Void VFX. Gold costume, brown hair. Used only as a cutout illustration of Bob in our invented scenario; not a finished Sentry film shot.',
  derivation: { method: 'macos_vision_foreground_mask_then_horizontal_flip_brightness_1.13_saturation_1.04', original_cutout: await ref(path.join(sources, 'sentry_cutout.png')) },
} });
const manifest = { schema: 'goldflow_avatar_pilot_style_preview_request_v1', intent: 'local_visual_review', candidate_id: 'sentry-style-repair-v2',
  identity_sha256: identityRef.sha256, duration_frames: 360, production_eligible: false, publish_allowed: false,
  narration: { asset_id: 'narration_joel', source_in_sec: 15, source_out_sec: 25.4, output_in_sec: .75 }, assets,
  recipe: { id: 'sentry_style_repair_v2', operator_direction: 'Fix the rejected placeholder boards using recognizable source artwork, independent moving stickers, accepted host/set and framed five-second film evidence.',
    shots: [
      { start_frame: 0, end_frame: 36, type: 'host_room', purpose: 'Host introduces the evidence.' },
      { start_frame: 36, end_frame: 186, type: 'film_card', source_in_sec: 0, duration_sec: 5, source_audio: 'muted', purpose: 'Show the accepted tower demonstration in a moving rounded card beside the host.' },
      { start_frame: 186, end_frame: 360, type: 'hypothetical_character_stickers', truth_label: 'OUR WHAT-IF', purpose: 'Sentry and Doom move independently; Doom is pushed away as the Avengers/device route opens.' },
    ], captions: [], new_synthesis: false, added_music_or_sfx: false,
    narration_excerpt: 'The tower fight gives us the starting point. Bob sends Red Guardian through a window and brings him back. Here, he\'d use that same ability to keep Doom away while the Avengers carry the device out.' },
};
const output = path.join(sources, 'style_review_request_v2.json'); await write(output, manifest);
console.log(output);
