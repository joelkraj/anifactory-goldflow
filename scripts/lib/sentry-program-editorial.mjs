/**
 * Authored edit for the operator-approved Sentry visual direction.
 * This is private review data, not an official media/timeline approval.
 * Source boundaries fall inside accepted Whisper sentence gaps. The canonical
 * narration is partitioned contiguously at its original tempo, including silence.
 */
const FPS = 30;
const narration = [
  ['opening_encounter', 0, 129, 6, 0, 16],
  ['scope_and_mastery', 129, 453, 153, 16, 45],
  ['tower_demonstration', 453, 613, 501, 45, 64],
  ['interception_application', 613, 762, 820, 64, 81],
  ['doom_diversion_and_rescue', 762, 1017, 984, 81, 108],
  ['void_doorway', 1017, 1158, 1260, 108, 122],
  ['void_evidence_and_limit', 1158, 1316, 1560, 122, 138],
  ['doom_takes_long_route', 1316, 1416, 1733, 138, 151],
  ['hold_the_position', 1416, 1614, 1851, 151, 172],
  ['escape_payoff', 1614, 1756, 2079, 172, 188],
  ['control_and_team', 1756, 1956, 2245, 188, 208],
  ['decisive_result', 1956, 2075, 2460, 208, 221],
  ['final_verdict', 2075, 2166.6, 2600, 221, 232],
].map(([id, sourceStart, sourceEnd, outputStart, wordStart, wordEnd]) => ({
  id,
  asset_id: 'narration_joel',
  source_in_sec: sourceStart / FPS,
  source_out_sec: sourceEnd / FPS,
  output_start_frame: outputStart,
  output_end_frame: outputStart + sourceEnd - sourceStart,
  word_start_index: wordStart,
  word_end_index_exclusive: wordEnd,
  tempo: 1,
}));

const shot = (id, start, end, type, variant, details) => ({
  id, start_frame: start, end_frame: end, type, variant, ...details,
});

const shots = [
  shot('01_opening_intercept', 0, 144, 'intercept', 'opening_intercept', {
    truth_mode: 'hypothetical', label: 'OUR WHAT-IF', heading: 'INTERCEPT',
    action: 'Doom reaches across the board; Sentry cuts across his route and pushes Doom back. Keep the objective as a clean type label, not a cartoon device.',
    host_pose: null,
    cues: [
      { frame: 6, action: 'doom_reaches', asset_id: 'doom_illustration' },
      { frame: 64, action: 'sentry_intercepts', asset_id: 'sentry_illustration' },
      { frame: 80, action: 'doom_recoils', asset_id: 'doom_illustration' },
    ],
  }),
  shot('02_host_owns_premise', 144, 225, 'room', 'premise', {
    truth_mode: 'hypothetical', label: 'OUR WHAT-IF', heading: '',
    host_pose: 'host_confident',
    action: 'Cut to the familiar room as Joel owns this version of the encounter. A small host entrance settles quickly.',
  }),
  shot('03_movie_only_scope', 225, 375, 'room', 'scope', {
    truth_mode: 'commentary', label: 'MCU SENTRY', heading: 'MOVIE-SHOWN ABILITIES',
    host_pose: 'host_presenting',
    action: 'Present the movie-only premise. Keep Sentry as a separate small cutout beside the host; give the host the larger visual weight.',
    cues: [{ frame: 311, action: 'mastery_label_enters', text: 'DELIBERATE CONTROL' }],
  }),
  shot('04_two_forms_one_scope', 375, 501, 'comparison', 'scope_forms', {
    truth_mode: 'commentary', label: 'MCU SENTRY', heading: 'SENTRY + THE VOID',
    host_pose: 'host_open_palm',
    action: 'Sentry and Void stickers enter independently on a cream field. The host bridges the forms. Include the small scope label MOVIE ABILITIES ONLY.',
    left_asset_id: 'sentry_illustration', right_asset_id: 'void_illustration',
    secondary_label: 'MOVIE ABILITIES ONLY',
  }),
  shot('05_tower_evidence_setup', 501, 666, 'room', 'tower_setup', {
    truth_mode: 'commentary', label: 'THUNDERBOLTS*', heading: 'THE TOWER FIGHT',
    host_pose: 'host_presenting',
    action: 'The host describes the reviewed demonstration. Let his presenting pose point into the direction from which the evidence card arrives.',
  }),
  shot('06_sentry_film_spotlight', 666, 816, 'evidence', 'sentry', {
    truth_mode: 'film_evidence', label: 'FILM EVIDENCE', heading: 'THUNDERBOLTS*',
    host_pose: 'host_presenting',
    film: { asset_id: 'film_sentry_window', source_in_sec: 0, source_out_sec: 5, loop: false },
    action: 'Play all five seconds at normal speed in a large rounded white card beside the host. Card slides a short distance into its settled reading position; no scale punch over the decisive action.',
  }),
  shot('07_interception_application', 816, 984, 'intercept', 'deny_access', {
    truth_mode: 'hypothetical', label: 'OUR WHAT-IF', heading: 'KEEP DOOM AWAY',
    host_pose: null,
    action: 'Return to the approved red sticker composition. Sentry moves to block Doom, then the AVENGERS + DEVICE route slides independently toward the exit.',
    cues: [
      { frame: 893, action: 'sentry_blocks', asset_id: 'sentry_illustration' },
      { frame: 923, action: 'escape_route_moves', text: 'AVENGERS + DEVICE' },
    ],
  }),
  shot('08_doom_counterplay', 984, 1148, 'rescue', 'doom_diversion', {
    truth_mode: 'hypothetical', label: 'OUR WHAT-IF', heading: 'DOOM CHANGES THE PROBLEM',
    host_pose: null,
    action: 'Doom holds the foreground while the escape route behind Sentry splits and drops. Use restrained board geometry and character movement, without illustrated explosion icons or invented movie footage.',
    cues: [
      { frame: 1049, action: 'doom_counterplay', asset_id: 'doom_illustration' },
      { frame: 1116, action: 'escape_route_drops' },
    ],
  }),
  shot('09_sentry_rescues', 1148, 1260, 'rescue', 'sentry_rescue', {
    truth_mode: 'hypothetical', label: 'OUR WHAT-IF', heading: 'SAVE THE TEAM',
    host_pose: null,
    action: 'Sentry breaks from the confrontation and travels toward the dropped route. The AVENGERS route rises to a safe landing while Doom remains a separate distant layer.',
    cues: [
      { frame: 1165, action: 'sentry_breaks_off', asset_id: 'sentry_illustration' },
      { frame: 1200, action: 'escape_route_recovers' },
    ],
  }),
  shot('10_void_doorway', 1260, 1406, 'void', 'doorway', {
    truth_mode: 'hypothetical', label: 'OUR WHAT-IF', heading: 'BLOCK THE DOORWAY',
    host_pose: null,
    action: 'Doom advances from one side while Sentry returns toward the doorway. Swap Sentry to the actual film-derived Void sticker at the named reveal; do not portray a new VFX transformation as film evidence.',
    cues: [
      { frame: 1277, action: 'doom_follows', asset_id: 'doom_illustration' },
      { frame: 1328, action: 'sentry_turns_back', asset_id: 'sentry_illustration' },
      { frame: 1384, action: 'void_reveals', asset_id: 'void_illustration' },
    ],
  }),
  shot('11_void_film_spotlight', 1406, 1556, 'evidence', 'void', {
    truth_mode: 'film_evidence', label: 'FILM EVIDENCE', heading: 'THUNDERBOLTS*',
    host_pose: 'host_thinking',
    film: { asset_id: 'film_void_shadow', source_in_sec: 0, source_out_sec: 5, loop: false },
    action: 'A complete five-second source-audio spotlight demonstrates the reviewed Void effect. Use the same readable evidence-card grammar on a blue presentation field.',
  }),
  shot('12_void_effect_context', 1556, 1650, 'comparison', 'void_effect', {
    truth_mode: 'commentary', label: 'MOVIE-SHOWN EFFECT', heading: 'THE VOID',
    host_pose: 'host_thinking',
    action: 'The Void sticker settles beside the thinking host as Joel describes the effect just demonstrated. This is contextual illustration following the clip.',
    left_asset_id: 'void_illustration', right_asset_id: null,
  }),
  shot('13_uncertain_matchup', 1650, 1733, 'room', 'uncertain_limit', {
    truth_mode: 'commentary', label: 'UNRESOLVED', heading: 'DOOM’S RESISTANCE?',
    host_pose: 'host_skeptical',
    action: 'Return to the host for the exact limit of our evidence. A small Doom illustration may sit to one side; no immunity meter or assumed feat.',
  }),
  shot('14_doom_long_route', 1733, 1851, 'void', 'long_route', {
    truth_mode: 'hypothetical', label: 'OUR WHAT-IF', heading: 'THE LONGER ROUTE',
    host_pose: null,
    action: 'Void remains planted in the doorway. Doom backs away and travels around the board’s perimeter on an independent curved route.',
    cues: [{ frame: 1800, action: 'doom_detours', asset_id: 'doom_illustration' }],
  }),
  shot('15_bob_holds', 1851, 1938, 'hold', 'hold_position', {
    truth_mode: 'hypothetical', label: 'OUR WHAT-IF', heading: 'HOLD POSITION',
    host_pose: null,
    action: 'Push toward Void holding the threshold; Doom continues moving away in the background. The stillness belongs to Bob’s tactical choice, not an inactive composition.',
  }),
  shot('16_protect_escape_route', 1938, 2079, 'hold', 'protect_route', {
    truth_mode: 'hypothetical', label: 'OUR WHAT-IF', heading: 'KEEP THE EXIT OPEN',
    host_pose: 'host_presenting',
    action: 'Widen the same spatial arrangement. The AVENGERS + DEVICE route passes behind the fixed Void sticker while the host points out why chasing would reopen Doom’s path.',
  }),
  shot('17_seconds_are_enough', 2079, 2145, 'payoff', 'time_won', {
    truth_mode: 'hypothetical', label: 'OUR WHAT-IF', heading: 'TIME WON',
    host_pose: null,
    action: 'Hold Void at the doorway while the route reaches its last stretch. Use a clean visual beat, without a fake countdown or claimed numeric advantage.',
  }),
  shot('18_objective_clear', 2145, 2245, 'payoff', 'objective_clear', {
    truth_mode: 'hypothetical', label: 'OUR WHAT-IF', heading: 'OBJECTIVE CLEAR',
    host_pose: null,
    action: 'The AVENGERS + DEVICE route clears the frame. Doom arrives on his separate detour only after it has left. Settle on the empty objective route long enough to read the consequence.',
    cues: [
      { frame: 2184, action: 'objective_exits' },
      { frame: 2210, action: 'doom_arrives_late', asset_id: 'doom_illustration' },
    ],
  }),
  shot('19_host_argument', 2245, 2355, 'room', 'earned_opinion', {
    truth_mode: 'commentary', label: 'OUR VERDICT', heading: 'CONTROL CHANGES THE OUTCOME',
    host_pose: 'host_confident',
    action: 'Return to the room for the central opinion. Confident pose and a gentle push-in give this line its weight.',
  }),
  shot('20_counterplay_did_not_break_team', 2355, 2460, 'comparison', 'team_survives', {
    truth_mode: 'hypothetical', label: 'OUR WHAT-IF', heading: 'DIVERSION ≠ DEFEAT',
    host_pose: 'host_open_palm',
    left_asset_id: 'doom_illustration', right_asset_id: 'sentry_illustration',
    action: 'Doom and Sentry enter opposite sides around the host. Reference the already-shown diversion with one restrained lateral shift of Sentry; the escape route stays intact.',
  }),
  shot('21_causal_payoff', 2460, 2600, 'payoff', 'decisive_sequence', {
    truth_mode: 'hypothetical', label: 'OUR WHAT-IF', heading: 'DECISIVE',
    host_pose: null,
    action: 'Reprise the spatial result with independently timed moves: route rises for the rescue, Sentry returns to center, Doom loses access to the cleared objective. No extra hypothetical feat.',
    cues: [
      { frame: 2482, action: 'rescue_reprise' },
      { frame: 2505, action: 'sentry_returns', asset_id: 'sentry_illustration' },
      { frame: 2544, action: 'objective_lost', asset_id: 'doom_illustration' },
    ],
  }),
  shot('22_host_final_verdict', 2600, 2700, 'room', 'conclusion', {
    truth_mode: 'commentary', label: 'OUR VERDICT', heading: '',
    host_pose: 'host_confident',
    action: 'Finish on the masked host in the room. A gentle push settles by the last word. Preserve the entire final speech sample and the last 0.28 seconds of visual breathing room.',
  }),
];

export const SENTRY_PROGRAM_EDITORIAL = {
  schema: 'goldflow_sentry_program_editorial_review_v1',
  status: 'authored_review_candidate',
  source_script_sha256: '46b5069ee56113f986e623873f5bf3965bad326db866be24b5b8cd9d9bb5236e',
  narration_audio_sha256: '48f675a7a2a732588c5e3427f29e6b0409424faed52a30fd68f943efe9d23f7a',
  width: 1920, height: 1080, fps: FPS, duration_frames: 2700,
  production_eligible: false, publish_allowed: false,
  narration,
  shots,
  source_audio: [
    { asset_id: 'film_sentry_window', source_in_sec: 0, source_out_sec: 5, start_frame: 666, end_frame: 816, mode: 'spotlight', gain_db: -4, loop: false },
    { asset_id: 'film_void_shadow', source_in_sec: 0, source_out_sec: 5, start_frame: 1406, end_frame: 1556, mode: 'spotlight', gain_db: -4, loop: false },
  ],
  captions: [],
  added_music_or_sfx: false,
  narration_policy: {
    source_duration_sec: 72.22,
    source_samples_preserved_once: true,
    resynthesis: false,
    tempo_changed: false,
    sentence_gap_partitions_only: true,
    added_space_sec: 17.78,
    film_spotlights_sec: 10,
    last_speech_source_end_sec: 72.06,
    final_narration_sample_output_sec: 89.72,
    ending_visual_hold_sec: 0.28,
  },
  visual_direction: {
    approved_reference: 'sentry-style-repair-v4',
    palette: ['cream', 'red', 'blue', 'host_room'],
    independently_animated_assets: ['sentry_illustration', 'doom_illustration', 'void_illustration'],
    host_pose_swaps: ['host_confident', 'host_presenting', 'host_open_palm', 'host_thinking', 'host_skeptical'],
    titles_are_tactical_labels_not_captions: true,
    doom_art_is_illustration_not_mcu_evidence: true,
    no_unapproved_source_acquisition: true,
  },
};

export default SENTRY_PROGRAM_EDITORIAL;
