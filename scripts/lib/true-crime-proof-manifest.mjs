import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TRUE_CRIME_PROOF_SCHEMA, planTrueCrimeProof } from './true-crime-proof-renderer.mjs';
import { inspectTrueCrimeProofWav } from './true-crime-proof-narration.mjs';

// This is an authored recipe for one exact editorial plan, not a shared crime-story heuristic.
export const HALDERSON_PROOF_PLAN_V3_SHA256 = '4900a5238f3130b9da9845d1a48bff692941ea1eefe17ea7268f259c82dc6ab7';
export const HALDERSON_PROOF_RECIPE_ID = 'halderson_document_cutout_proof_v3';
const REQUIRED_ASSETS = ['portrait_source', 'e01_initial', 'e01_cabin', 'e01_answer', 'e02_parade', 'chandler_cutout', 'detective_cutout'];
const CREAM = '#f3ecdb', INK = '#1b2933', LIGHT = '#f7f1e5', YELLOW = '#e5c85d', MUTED = '#bec9cd';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const need = (ok, message) => { if (!ok) throw new Error(`True-crime proof manifest: ${message}`); };
async function readBound(ref) {
  need(path.isAbsolute(ref?.path ?? '') && /^[a-f0-9]{64}$/u.test(ref?.sha256 ?? ''), 'exact absolute local binding required');
  const bytes = await fs.readFile(ref.path);
  need(sha(bytes) === ref.sha256, `bound input changed: ${ref.path}`);
  return bytes;
}
async function collection(input) {
  if (input?.preparation) return JSON.parse(await readBound(input.preparation));
  if (input?.path) return JSON.parse(await readBound(input));
  need(input && typeof input === 'object', 'asset or narration collection required');
  return input;
}
const words = (text) => text.trim().split(/\s+/u);
const frame = (time, x, y, extras = {}) => ({ time_sec: time, ...(x === undefined ? {} : { x }), ...(y === undefined ? {} : { y }), ...extras });
const title = (text) => ({ id: 'scene_heading', type: 'text', text, width: 1750, height: 125, x: 70, y: 106, font_size: 52, text_color: LIGHT });
const label = (id, text, x, y, width, fill = MUTED) => ({ id, type: 'text', text, width, height: 88, x, y, font_size: 26, text_color: fill });
const card = (id, text, x, y, width, height, font = 48, extra = {}) => ({ id, type: 'card', text, x, y, width, height, font_size: font, fill: CREAM, text_color: INK, ...extra });
const portraitCredit = 'Portrait: undated agency photograph via ABC News';
const HOLD_SECONDS = [3, 4, 3, 5, 4, 6, 5];
const HOLD_NOTES = [
  'Read the July 7 report date and the actual initial-report excerpt before the reported trip is unpacked.',
  'Read the reported repair purposes and the unidentified-friends detail beside the cited complaint excerpt.',
  'Establish July 7 evening at the family home and read the illustrative speaker labels before the document reading.',
  'Read the complete eight-word third-person sentence and compare the typeset reading with the actual complaint crop.',
  'Compare reported absence with the narrower fact that Chandler had not witnessed the departure.',
  'Read the July 4 message / July 3 parade comparison against the amended complaint excerpt.',
  'Let the explicit return to July 8 and the next cabin-search scene register after the later-record comparison.'
];

/** Build only; no rendering, image operations, audio synthesis, acquisition or output writes.
 * narration: producer/stage receipt with narration_audio + narration_receipt artifacts.
 * assets: completed source-assets receipt, {artifacts}, bound JSON ref or {preparation:ref}.
 */
export async function buildTrueCrimeProofManifest({ identity, narration, assets } = {}) {
  need(identity?.schema === 'goldflow_true_crime_proof_identity_v1' && identity.production_eligible === false && identity.publish_allowed === false, 'private true-crime identity required');
  need(identity.plan?.sha256 === HALDERSON_PROOF_PLAN_V3_SHA256, 'this authored recipe requires the exact selected Halderson v3 plan');
  const plan = JSON.parse(await readBound(identity.plan));
  const script = (await readBound(identity.script)).toString('utf8');
  need(plan.case_name === 'Chandler Halderson' && plan.scenes.map((s) => s.id).join(',') === 'S01,S02,S03,S04,S05,S06,S07', 'unexpected scene identity');
  need(script.trimEnd() === plan.scenes.map((s) => s.audio.text).join('\n\n'), 'script differs from exact plan speech');
  need(identity.title === plan.title && identity.channel_name === plan.working_channel, 'identity title/channel mismatch');
  const n = await collection(narration), a = await collection(assets);
  const receiptRef = n.artifacts?.find((row) => row.kind === 'narration_receipt');
  const audioRef = n.artifacts?.find((row) => row.kind === 'narration_audio');
  need(receiptRef && audioRef, 'narration producer receipt and audio artifact required');
  const receipt = JSON.parse(await readBound(receiptRef));
  need(receipt.schema === 'goldflow_true_crime_proof_narration_result_v1' && receipt.source_text_sha256 === identity.script.sha256 && receipt.editorial_plan_sha256 === identity.plan.sha256, 'narration text/plan provenance changed');
  need(receipt.audio?.path === audioRef.path && receipt.audio?.sha256 === audioRef.sha256, 'narration audio differs from producer receipt');
  need(Array.isArray(receipt.timeline) && receipt.timeline.length === 7, 'seven measured narration intervals required');
  const measured = inspectTrueCrimeProofWav(await readBound(audioRef));
  need(Math.abs(measured.duration_sec - receipt.measured_duration_sec) <= .010001, 'measured WAV differs from retained narration duration');
  const authoredDuration = measured.duration_sec + HOLD_SECONDS.reduce((sum, value) => sum + value, 0);
  need(authoredDuration >= 90 && authoredDuration <= 150, `${measured.duration_sec.toFixed(3)}s narration + 30s authored holds = ${authoredDuration.toFixed(3)}s, outside the 90–150s scope; revise the authored edit explicitly`);
  const inputAssets = new Map();
  need(Array.isArray(a.artifacts), 'completed source asset artifacts required');
  for (const item of a.artifacts) {
    need(!inputAssets.has(item.id), 'duplicate asset id');
    inputAssets.set(item.id, item);
  }
  for (const id of REQUIRED_ASSETS) { need(inputAssets.has(id), `missing prepared asset ${id}`); await readBound(inputAssets.get(id)); }
  const image = (id, assetId, x, y, width, height, extra = {}) => ({ id, type: 'image', path: inputAssets.get(assetId).path, sha256: inputAssets.get(assetId).sha256, x, y, width, height, fit: 'contain', ...extra });
  const document = (id, assetId, x, y, width, height, extra = {}) => ({ ...image(id, assetId, x, y, width, height, extra), type: 'card', fill: CREAM });
  const cutout = (id, assetId, x, y, width, height, extra = {}) => image(id, assetId, x, y, width, height, { cutout: true, ...extra });
  const units = receipt.timeline.map((unit, i) => {
    need(unit.scene_id === plan.scenes[i].id && unit.text === plan.scenes[i].audio.text && unit.source_text_sha256 === sha(unit.text), `scene ${i + 1} narration text changed`);
    need(Number.isFinite(unit.start_sec) && Number.isFinite(unit.end_sec) && unit.end_sec > unit.start_sec && (i ? unit.start_sec >= receipt.timeline[i - 1].end_sec : unit.start_sec === 0), 'invalid measured source unit interval');
    const end = i < 6 ? receipt.timeline[i + 1].start_sec : measured.duration_sec;
    need(end >= unit.end_sec - .010001, 'narration interval would be truncated');
    return { id: unit.unit_id, text: unit.text, start_sec: unit.start_sec, end_sec: end,
      measured_unit_end_sec: unit.end_sec, retained_paragraph_gap_sec: Math.max(0, end - unit.end_sec) };
  });
  const scenes = plan.scenes.map((scene, i) => {
    const unit = units[i], duration = unit.end_sec - unit.start_sec + HOLD_SECONDS[i];
    const spokenDuration = receipt.timeline[i].duration_sec;
    need(Number.isFinite(spokenDuration) && spokenDuration > 0, 'measured unit duration required');
    const cue = (phrase) => {
      const index = scene.audio.text.indexOf(phrase); need(index >= 0, `authored cue missing: ${phrase}`);
      const prefix = scene.audio.text.slice(0, index).trim();
      return Math.min(duration - .8, Math.max(.8, (prefix ? words(prefix).length : 0) / words(scene.audio.text).length * spokenDuration));
    };
    let layers;
    const end = duration;
    if (scene.id === 'S01') layers = [
      title('A trip he had not witnessed'),
      image('undated_portrait', 'portrait_source', 75, 255, 390, 510, { fit: 'cover' }),
      label('portrait_status', 'UNDATED AGENCY PHOTO', 74, 759, 445),
      card('report_date', 'JULY 7, 2021 · MISSING-PERSON REPORT', 515, 238, 1310, 135, 42),
      document('initial_report', 'e01_initial', 515, 403, 1310, 398, { keyframes: [frame(0, 555, 403), frame(.65, 515, 403, { easing: 'ease_out' }), frame(end, 507, 398, { scale: 1.006 })] })
    ];
    else if (scene.id === 'S02') layers = [
      title('His reported account · July 2'),
      cutout('chandler', 'chandler_cutout', 88, 230, 500, 570, { keyframes: [frame(0, -150, 235, { opacity: .2 }), frame(.6, 88, 230, { opacity: 1, easing: 'ease_out' }), frame(end, 102, 225, { scale: 1.015 })] }),
      label('portrait_status', 'CHANDLER · UNDATED PORTRAIT', 57, 767, 550),
      card('repair', 'REPAIR A WATER PUMP + FIRE PIT', 575, 208, 1255, 106, 38),
      card('friends', 'FRIENDS HE COULD NOT IDENTIFY', 575, 330, 1255, 106, 38, { keyframes: [frame(0, 630, 330, { opacity: 0 }), frame(cue("He couldn't"), 630, 330, { opacity: 0 }), frame(cue("He couldn't") + .55, 575, 330, { opacity: 1, easing: 'ease_out' })] }),
      image('cabin_account', 'e01_cabin', 575, 450, 1255, 360)
    ];
    else if (scene.id === 'S03') layers = [
      title('July 7 · Evening at the family home'),
      cutout('chandler', 'chandler_cutout', 1280, 247, 470, 555, { keyframes: [frame(0, 1355, 254, { opacity: .35 }), frame(.65, 1280, 247, { opacity: 1, easing: 'ease_out' }), frame(end, 1266, 247, { scale: 1.012 })] }),
      cutout('detective', 'detective_cutout', 160, 247, 460, 555, { keyframes: [frame(0, 90, 251, { opacity: .35 }), frame(.75, 160, 247, { opacity: 1, easing: 'ease_out' }), frame(end, 174, 247, { scale: 1.008 })] }),
      card('question_context', 'HAD HE SEEN OR HEARD THEM LEAVE?', 665, 330, 590, 300, 48),
      label('chandler_label', 'CHANDLER · UNDATED PORTRAIT', 1240, 768, 610),
      label('detective_label', 'DETECTIVE · ILLUSTRATION', 93, 768, 585)
    ];
    else if (scene.id === 'S04') layers = [
      title('The complaint records his answer'),
      card('exact_document_sentence', scene.audio.text, 90, 235, 1740, 250, 72),
      document('answer_source', 'e01_answer', 90, 525, 1740, 280)
    ];
    else if (scene.id === 'S05') layers = [
      title('What his account actually established'),
      card('reported_absence', 'REPORTED ABSENCE\nAROUND 6:15 A.M.', 86, 275, 825, 285, 57),
      card('not_witnessed', 'DEPARTURE NOT\nWITNESSED BY HIM', 1005, 275, 825, 285, 57, { keyframes: [frame(0, 1060, 275, { opacity: 0 }), frame(cue('The distinction'), 1060, 275, { opacity: 0 }), frame(cue('The distinction') + .7, 1005, 275, { opacity: 1, easing: 'ease_out' })] }),
      document('answer_context', 'e01_answer', 230, 602, 1460, 209)
    ];
    else if (scene.id === 'S06') layers = [
      title('The dates differed by one day'),
      card('message_date', 'REPORTED MESSAGE\nSUNDAY · JULY 4', 90, 245, 825, 220, 52),
      card('parade_date', 'PARADE DATE\nSATURDAY · JULY 3', 1005, 245, 825, 220, 52, { keyframes: [frame(0, 1045, 245, { opacity: 0 }), frame(cue('But the later'), 1045, 245, { opacity: 0 }), frame(cue('But the later') + .65, 1005, 245, { opacity: 1, easing: 'ease_out' })] }),
      image('parade_record', 'e02_parade', 90, 495, 1740, 315)
    ];
    else {
      const transition = cue('To follow');
      const fade = [frame(0, undefined, undefined, { opacity: 1 }), frame(transition, undefined, undefined, { opacity: 1 }), frame(transition + .65, undefined, undefined, { opacity: 0 })];
      layers = [
        title('A detail to check. Then, back to the search.'),
        card('message_date', 'REPORTED MESSAGE\nJULY 4', 100, 295, 820, 300, 66, { keyframes: fade }),
        card('parade_date', 'PARADE DATE\nJULY 3', 1000, 295, 820, 300, 66, { keyframes: fade }),
        label('comparison_limit', 'THE MISMATCH DID NOT ESTABLISH THEIR LOCATION', 260, 643, 1450, YELLOW),
        card('return_to_search', 'BACK TO JULY 8\nTHE CABIN SEARCH', 352, 296, 1216, 362, 75, { keyframes: [frame(0, 352, 322, { opacity: 0 }), frame(transition + .5, 352, 322, { opacity: 0 }), frame(transition + 1.2, 352, 296, { opacity: 1, easing: 'ease_out' })] })
      ];
      layers.find((l) => l.id === 'comparison_limit').keyframes = fade;
    }
    const sourceLabel = ['S06', 'S07'].includes(scene.id)
      ? `Sources: E02 · Amended complaint, Aug. 24, 2021 · Doc. 26 p17${scene.id === 'S07' ? ' | July 8 search context: V02 trial testimony (reference only)' : ' | E01 p3'}`
      : `Source: E01 · Criminal complaint, July 15, 2021 · ${['S03', 'S04', 'S05'].includes(scene.id) ? 'p3' : 'pp2–3'}${['S01', 'S02', 'S03'].includes(scene.id) ? ` | ${portraitCredit}` : ''}`;
    return { id: scene.id, narration_unit_ids: [unit.id], hold_before_sec: 0, hold_after_sec: HOLD_SECONDS[i], hold_note: HOLD_NOTES[i],
      disclosure: scene.audio.label ? `${scene.picture.label} · ${scene.audio.label}` : scene.picture.label,
      source_label: sourceLabel, background: { color: i === 3 ? '#24313a' : '#162630' }, layers,
      editorial_source_ids: scene.source_ids, editorial_claim_ids: scene.claim_ids, picture_origin: scene.picture.origin, audio_origin: scene.audio.origin };
  });
  const manifest = { schema: TRUE_CRIME_PROOF_SCHEMA, scope: 'private_proof', production_eligible: false,
    identity: { channel: identity.channel_name, series: identity.series_slug, run: identity.run_slug, episode: identity.episode, title: identity.title },
    narration: { path: audioRef.path, sha256: audioRef.sha256, units }, scenes,
    provenance: { recipe_id: HALDERSON_PROOF_RECIPE_ID, editorial_plan: identity.plan, source_script: identity.script, narration_receipt: receiptRef,
      narration_technical_qa: receipt.technical_qa, source_assets: REQUIRED_ASSETS.map((id) => inputAssets.get(id)),
      authored_hold_policy: 'Fixed scene reading holds totaling 30 seconds; no automatic padding to any target duration.',
      timing_policy: 'Complete narration WAV preserved. Existing paragraph gaps belong to preceding scenes. Caption and text-reveal timing is estimated within measured units, not word alignment.',
      portrait_disclosure: portraitCredit, detective_disclosure: 'Generic illustrative detective; no claim to reproduce a named officer likeness.',
      draft_scene_budgets_used_for_render: false, measured_narration_duration_sec: measured.duration_sec } };
  // This checks the actual duration, transforms, source labels and complete unit order without rendering.
  planTrueCrimeProof(manifest);
  return manifest;
}
