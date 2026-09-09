import { SENTRY_PROGRAM_EDITORIAL as base } from './sentry-program-editorial.mjs';

/**
 * Human-authored sound/motion polish for the accepted private Sentry program.
 * This module is an edit candidate, never an approval or production route.
 * Speech, its placement, and both complete film/audio spotlights are unchanged.
 * Scene clocks survive framing cuts so a new camera view cannot restart action.
 */
const camera = (start, end, x = 960, y = 540, targetX = x, targetY = y, ease = 'smoothstep') => ({
  start_scale: start,
  end_scale: end,
  anchor_x: x,
  anchor_y: y,
  target_x: targetX,
  target_y: targetY,
  ease,
});
const frame = (id, focusAssetId, settings) => ({ id, focus_asset_id: focusAssetId, camera: settings });
const cut = { kind: 'cut', frames: 0, direction: null };
const match = (direction = 'right', frames = 5) => ({ kind: 'match_move', frames, direction });
const handoff = (direction = 'right', frames = 8) => ({ kind: 'card_handoff', frames, direction });

const motion = {
  doom_reaches: { duration_frames: 28, ease: 'ease_in_out_cubic', hold_frames: 12, rotation_deg: -1.2 },
  sentry_intercepts: { duration_frames: 12, ease: 'ease_out_quint', hold_frames: 10, rotation_deg: -1.5 },
  doom_recoils: { duration_frames: 9, ease: 'ease_out_quint', hold_frames: 14, rotation_deg: 5.5 },
  mastery_label_enters: { duration_frames: 8, ease: 'ease_out_back', hold_frames: 30, rotation_deg: 0 },
  sentry_blocks: { duration_frames: 12, ease: 'ease_out_quint', hold_frames: 18, rotation_deg: -1.2 },
  escape_route_moves: { duration_frames: 42, ease: 'ease_in_out_cubic', hold_frames: 10, rotation_deg: 0 },
  doom_counterplay: { duration_frames: 15, ease: 'ease_out_cubic', hold_frames: 15, rotation_deg: -1.5 },
  escape_route_drops: { duration_frames: 17, ease: 'ease_in_cubic', hold_frames: 10, rotation_deg: 3 },
  sentry_breaks_off: { duration_frames: 34, ease: 'ease_in_out_cubic', hold_frames: 6, rotation_deg: -2 },
  escape_route_recovers: { duration_frames: 28, ease: 'ease_out_cubic', hold_frames: 20, rotation_deg: 0 },
  doom_follows: { duration_frames: 30, ease: 'ease_in_out_cubic', hold_frames: 8, rotation_deg: -1 },
  sentry_turns_back: { duration_frames: 28, ease: 'ease_in_out_cubic', hold_frames: 12, rotation_deg: 0 },
  void_reveals: { duration_frames: 6, ease: 'ease_out_cubic', hold_frames: 16, rotation_deg: 0 },
  doom_detours: { duration_frames: 46, ease: 'ease_in_out_cubic', hold_frames: 4, rotation_deg: -1.5 },
  objective_exits: { duration_frames: 23, ease: 'ease_in_cubic', hold_frames: 12, rotation_deg: 0 },
  doom_arrives_late: { duration_frames: 20, ease: 'ease_out_cubic', hold_frames: 15, rotation_deg: 0 },
  rescue_reprise: { duration_frames: 20, ease: 'ease_out_cubic', hold_frames: 3, rotation_deg: 0 },
  sentry_returns: { duration_frames: 22, ease: 'ease_out_cubic', hold_frames: 14, rotation_deg: -1 },
  objective_lost: { duration_frames: 24, ease: 'ease_out_cubic', hold_frames: 25, rotation_deg: 2 },
};

function edit(sourceId, id, start, end, framing, details = {}) {
  const original = base.shots.find((row) => row.id === sourceId);
  if (!original) throw new Error(`Unknown source shot: ${sourceId}`);
  return {
    ...structuredClone(original),
    id,
    start_frame: start,
    end_frame: end,
    scene: { id: sourceId, start_frame: original.start_frame, end_frame: original.end_frame },
    framing,
    transition_in: cut,
    cues: (original.cues ?? []).map((cue) => ({
      ...cue,
      ...motion[cue.action],
      // The original label entered before its spoken phrase. Reveal it on
      // "deliberate control" while retaining the complete accepted speech.
      ...(cue.action === 'mastery_label_enters' ? { frame: 337 } : {}),
    })),
    ...details,
  };
}

const shots = [
  edit('01_opening_intercept', '01_opening_intercept', 0, 144,
    frame('intercept_wide', 'sentry_illustration', camera(1, 1.045)), {
      action: 'Start inside the hypothetical encounter. Doom reaches; Sentry intercepts with a short acceleration, Doom recoils with a small rotation, then both settle. Let the impact have a readable held result, not a flash or a full-frame shake.',
    }),
  edit('02_host_owns_premise', '02_host_owns_premise', 144, 225,
    frame('host_medium', 'host_confident', camera(1, 1.035, 510, 550)), {
      action: 'The familiar room lands cleanly after the hit. Hold the confident mask and hand as Joel owns this alternate scenario; no decorative bobbing.',
    }),
  edit('03_movie_only_scope', '03_movie_only_scope', 225, 311,
    frame('host_scope_wide', 'host_presenting', camera(1, 1.025)), {
      action: 'Give the presenting host and the film-derived Sentry illustration their established sides of the room. This is the movie-version boundary, not new movie evidence.',
    }),
  edit('03_movie_only_scope', '04_mastery_assumption', 311, 375,
    frame('host_scope_close', 'host_presenting', camera(1.08, 1.12, 960, 620)), {
      transition_in: match('in', 4),
      action: 'Reframe closer on the same presenter and Sentry, then pop in DELIBERATE CONTROL on frame 337. The label names our changed assumption, with one small sound accent.',
    }),
  edit('04_two_forms_one_scope', '05_two_forms_one_scope', 375, 501,
    frame('forms_comparison', 'void_illustration', camera(1, 1.035, 1010, 630)), {
      action: 'Move Sentry and Void in independently around the open-palm host. Give the Void its own reveal beat when named. Keep MOVIE ABILITIES ONLY plainly readable through the no-comic-upgrades line.',
      cues: [
        { frame: 386, action: 'sentry_form_settles', asset_id: 'sentry_illustration', duration_frames: 12, ease: 'ease_out_cubic', hold_frames: 80, rotation_deg: 0 },
        { frame: 400, action: 'void_form_enters', asset_id: 'void_illustration', duration_frames: 14, ease: 'ease_out_cubic', hold_frames: 72, rotation_deg: 0 },
        { frame: 437, action: 'movie_scope_emphasis', duration_frames: 6, ease: 'ease_out_cubic', hold_frames: 58, rotation_deg: 0 },
      ],
    }),
  edit('05_tower_evidence_setup', '06_tower_setup', 501, 578,
    frame('host_explainer_medium', 'host_thinking', camera(1, 1.035, 530, 550)), {
      host_pose: 'host_thinking',
      action: 'Use the thinking mask for the starting-point line. Keep the tower heading as a compact room card; no prematurely playing or freezing source footage.',
    }),
  edit('05_tower_evidence_setup', '07_tower_demonstration_setup', 578, 666,
    frame('host_presenting_medium', 'host_presenting', camera(1.04, 1.06, 520, 550)), {
      transition_in: match('right', 5),
      action: 'Change to the presenting pose as Bob sends Red Guardian through the window. The host gestures toward the coming card; a short audible handoff ends before the source-audio spotlight.',
    }),
  edit('06_sentry_film_spotlight', '08_sentry_film_spotlight', 666, 816,
    frame('evidence_card_full', 'film_sentry_window', camera(1, 1)), {
      transition_in: handoff('right', 8),
      action: 'Preserve all 150 source frames and exact source-audio timing. The full card is visible from the first frame; only its short settling travel changes. Do not crop, scale-punch or obscure the demonstrated action. Soundtrack is absent during the spotlight.',
    }),
  edit('07_interception_application', '09_interception_application', 816, 923,
    frame('interception_two_shot', 'sentry_illustration', camera(1, 1.05)), {
      transition_in: handoff('left', 8),
      action: 'Match the evidence-card exit into the red hypothetical board. Sentry occupies Doom’s path with a fast, short blocking move, followed by a still result. Do not move every layer at the same speed.',
    }),
  edit('07_interception_application', '10_device_escape_detail', 923, 984,
    frame('interception_route_detail', null, camera(1.1, 1.14, 1010, 780, 1010, 750)), {
      transition_in: match('right', 5),
      heading: 'THE TEAM MOVES',
      action: 'Reframe toward the AVENGERS + DEVICE route as it crosses the protected space. Preserve the block’s final positions from the prior view; this is a new camera emphasis, not another shove.',
    }),
  edit('08_doom_counterplay', '11_doom_counterplay_reaction', 984, 1049,
    frame('doom_counterplay_close', 'doom_illustration', camera(1.25, 1.3, 1480, 600, 1190, 610)), {
      heading: 'A DIFFERENT PROBLEM',
      action: 'Crop toward Doom for the instead-of-charging line. His small forward tilt is intent, not an invented facial animation or comic feat. Keep the route visible at the edge to establish what he changes next.',
    }),
  edit('08_doom_counterplay', '12_corridor_drop', 1049, 1148,
    frame('corridor_drop_wide', null, camera(1.035, 1)), {
      transition_in: match('out', 5),
      heading: 'THE CORRIDOR DROPS',
      action: 'Widen to the same spatial arrangement when Doom detonates the corridor. The route and its platform fall with accelerating motion on floor; pair the fall with a restrained wood/structural accent and hold the consequence.',
    }),
  edit('09_sentry_rescues', '13_sentry_rescues', 1148, 1260,
    frame('rescue_travel', 'sentry_illustration', camera(1, 1.035, 1030, 640)), {
      transition_in: match('right', 5),
      action: 'Sentry breaks off with smooth travel toward the fallen route. Raise the team route onto the next visible landing, ease into a soft settle, then leave a brief readable hold before Doom follows. Avoid a second generic impact.',
    }),
  edit('10_void_doorway', '14_doom_follows', 1260, 1328,
    frame('doorway_wide', 'doom_illustration', camera(1, 1.035)), {
      action: 'Reestablish doorway geography: Doom enters left, Bob returns right-to-center, the escape remains to the right. Let Doom’s advance carry across the next camera cut.',
    }),
  edit('10_void_doorway', '15_void_reveal', 1328, 1406,
    frame('doorway_reveal_close', 'void_illustration', camera(1.08, 1.16, 1050, 610, 1030, 620)), {
      transition_in: match('in', 4),
      heading: 'THE VOID',
      action: 'Move closer as Bob turns back. On the word Void, replace the Sentry layer with the exact film-derived Void cutout, a restrained scale settle and a short low reveal sound. Hold the silhouette; no strobe, invented transformation footage or full-frame blur.',
    }),
  edit('11_void_film_spotlight', '16_void_film_spotlight', 1406, 1556,
    frame('evidence_card_full', 'film_void_shadow', camera(1, 1)), {
      transition_in: handoff('right', 8),
      action: 'Preserve the complete 150-frame Void card and its source-audio spotlight. The visual handoff must leave the movie wholly readable from frame one. Reveal SFX ends before this shot and the music is silent for its exact duration.',
    }),
  edit('12_void_effect_context', '17_void_effect_context', 1556, 1650,
    frame('void_host_comparison', 'void_illustration', camera(1, 1.055, 1050, 630)), {
      transition_in: handoff('left', 8),
      action: 'Come back to the thinking host and the Void sticker. The host owns the explanation of the demonstrated effect; no repeated film frames and no visual implication that Doom’s resistance was tested on screen.',
    }),
  edit('13_uncertain_matchup', '18_uncertain_matchup', 1650, 1733,
    frame('host_skeptical_close', 'host_skeptical', camera(1.07, 1.115, 560, 570)), {
      action: 'The skeptical host is the evidence-limit punctuation. Keep the Doom illustration separate and the resistance question readable, with genuine stillness at the end rather than a comedic bounce.',
    }),
  edit('14_doom_long_route', '19_doom_risk_reaction', 1733, 1800,
    frame('doom_risk_close', 'doom_illustration', camera(1.5, 1.58, 330, 600, 960, 620)), {
      heading: 'NOT WORTH THE RISK',
      action: 'Make Doom’s artwork the dominant crop as Joel says he will not gamble on the effect. Void is only an edge or background threat here. The hypothetical label stays clear; do not fake a new facial expression.',
    }),
  edit('14_doom_long_route', '20_doom_takes_detour', 1800, 1851,
    frame('detour_geography_wide', 'doom_illustration', camera(1, 1)), {
      transition_in: match('out', 5),
      action: 'Widen sharply enough to reveal the spatial cost. Move Doom along the actual authored curved detour around the fixed doorway, not diagonally beside a decorative arrow. Keep a clear visual start, turn and exit.',
    }),
  edit('15_bob_holds', '21_void_holds_threshold', 1851, 1938,
    frame('void_hold_close', 'void_illustration', camera(1.3, 1.36, 1050, 610, 1030, 620)), {
      action: 'Let the Void and doorway fill this view. A genuine slow camera push contrasts with Doom’s movement; Bob stays planted. His stillness is the tactical point, not another drifting portrait.',
    }),
  edit('16_protect_escape_route', '22_escape_route_detail', 1938, 2016,
    frame('protected_route_detail', null, camera(1.26, 1.3, 1420, 850, 1120, 745)), {
      heading: 'KEEP THE PATH OPEN',
      host_pose: null,
      action: 'Give the protected exit and AVENGERS + DEVICE route the screen. Void’s shoulder/doorway edge provides spatial context. The route crosses behind the held threshold; do not draw a fresh invented action or a fake countdown.',
    }),
  edit('16_protect_escape_route', '23_protected_exit_wide', 2016, 2079,
    frame('protected_exit_wide', 'void_illustration', camera(1.035, 1)), {
      transition_in: match('out', 5),
      host_pose: null,
      action: 'Restore the wide relationship at still using to escape. The route continues from its exact earlier position and the fixed Void blocks Doom’s direct line. Leave enough space to see the exit, not an oversized host over the geography.',
    }),
  edit('17_seconds_are_enough', '24_objective_approaches_exit', 2079, 2145,
    frame('objective_approach_detail', null, camera(1.18, 1.22, 1450, 850, 1120, 745)), {
      action: 'Stay with the route nearing its destination while the few-seconds line lands. The change of framing provides momentum; do not add a numeric timer, clock tick or an unsupported measure of Bob’s power.',
    }),
  edit('18_objective_clear', '25_objective_clear', 2145, 2245,
    frame('objective_payoff_wide', null, camera(1, 1.035, 1260, 650)), {
      transition_in: match('out', 5),
      action: 'The route exits on the named clear beat, then Doom arrives after it has left. A short resolution cue punctuates success. Hold the empty destination long enough that the objective result is unmistakable.',
    }),
  edit('19_host_argument', '26_host_earned_opinion', 2245, 2355,
    frame('host_verdict_close', 'host_confident', camera(1.045, 1.11, 535, 565)), {
      action: 'Cut cleanly to the confident host for the earned opinion. Give the mask a real progressive push-in, then settle at punch. The soundtrack supports the thought without scoring it as a trailer climax.',
    }),
  edit('20_counterplay_did_not_break_team', '27_counterplay_not_defeat', 2355, 2460,
    frame('team_comparison', 'host_open_palm', camera(1, 1.04, 960, 650)), {
      action: 'Use the open-palm host between opposing Doom and Sentry illustrations. One small Sentry displacement acknowledges that the diversion worked; the team route remains whole. The unchanged spatial result earns DIVERSION ≠ DEFEAT.',
      cues: [
        { frame: 2378, action: 'diversion_moves_bob', asset_id: 'sentry_illustration', duration_frames: 16, ease: 'ease_out_cubic', hold_frames: 40, rotation_deg: -1 },
        { frame: 2412, action: 'team_route_holds', duration_frames: 8, ease: 'ease_out_cubic', hold_frames: 40, rotation_deg: 0 },
      ],
    }),
  edit('21_causal_payoff', '28_rescue_reprise', 2460, 2505,
    frame('rescue_result_detail', 'sentry_illustration', camera(1.13, 1.16, 1090, 750, 1060, 725)), {
      heading: 'SAVE THE TEAM',
      action: 'Use a brief, explicitly hypothetical visual reprise of the route reaching its landing. This is the already-established rescue, not a new feat or a third source excerpt.',
    }),
  edit('21_causal_payoff', '29_decisive_result', 2505, 2600,
    frame('decisive_result_wide', 'sentry_illustration', camera(1, 1.04)), {
      transition_in: match('out', 5),
      action: 'Widen as Sentry returns to the fight. The route clears and Doom loses access on objective, with one restrained low accent. Preserve the same scene clock across the cut so rescue is not replayed.',
    }),
  edit('22_host_final_verdict', '30_host_final_verdict', 2600, 2700,
    frame('host_final_medium', 'host_confident', camera(1, 1.055, 535, 565)), {
      action: 'End at a slightly wider confident-host framing than the preceding opinion. The slow push settles before decisive, music eases out through the ending, and the entire final narration sample plus 0.28-second visual hold survives.',
    }),
];

export const SENTRY_POLISH_EDITORIAL = {
  ...structuredClone(base),
  schema: 'goldflow_sentry_polish_editorial_review_v1',
  status: 'authored_review_candidate',
  revision_intent: 'Operator-requested polish of the existing private 90-second program: authored sound punctuation, actual camera changes, motion continuity, and clearer tactical geography. No script, voice, film timing, or source change.',
  shots,
  added_music_or_sfx: true,
  sound_design: {
    status: 'mix_intent_exact_assets_bound_separately',
    narration_priority: true,
    source_spotlights_unchanged: true,
    source_spotlight_soundtrack_silent: true,
    music: {
      asset_id: 'music_crypto',
      intent: 'One restrained instrumental continuity bed. Quiet beneath Joel, absent throughout both exact movie-audio spotlights, slightly restrained at the evidence-limit line, and gently resolved at the close. No trailer build or added vocal layer.',
      source_start_sec: 0,
      loop: false,
      fade_in_sec: 1,
      fade_out_sec: 2,
    },
    cues: [
      { id: 'opening_recoil', frame: 80, asset_id: 'sfx_impact', role: 'impact', gain_db: -16, source_in_sec: 0, source_out_sec: 0.649025, intent: 'Single muted physical hit, with the visual recoil.' },
      { id: 'mastery_assumption', frame: 337, asset_id: 'sfx_soft_pop', role: 'pop', gain_db: -20, source_in_sec: 0, source_out_sec: 0.102426, intent: 'One light label punctuation, never a click per word.' },
      { id: 'sentry_evidence_handoff', frame: 660, asset_id: 'sfx_swish_in', role: 'swish', gain_db: -20, source_in_sec: 0, source_out_sec: 0.147778, intent: 'Short pre-handoff; ends before frame 666 and does not cover source audio.' },
      { id: 'interception_block', frame: 893, asset_id: 'sfx_swish_out', role: 'swish', gain_db: -20, source_in_sec: 0, source_out_sec: 0.147778, intent: 'A small accelerated move, not a second enormous punch.' },
      { id: 'corridor_drop', frame: 1116, asset_id: 'sfx_collapse', role: 'impact', gain_db: -17, source_in_sec: 0, source_out_sec: 0.779002, intent: 'Structural drop linked to the descending route; no explosion spectacle.' },
      { id: 'rescue_landing', frame: 1200, asset_id: 'sfx_soft_settle', role: 'settle', gain_db: -20, source_in_sec: 0, source_out_sec: 0.505102, intent: 'Soft weight returning to the next landing.' },
      { id: 'void_reveal', frame: 1384, asset_id: 'sfx_void_reveal', role: 'reveal', gain_db: -18, source_in_sec: 0, source_out_sec: 0.7, fade_out_sec: 0.18, intent: 'One low, short reveal; ends at frame 1405 before the movie-audio spotlight.' },
      { id: 'doom_detour', frame: 1800, asset_id: 'sfx_swish_out', role: 'swish', gain_db: -21, source_in_sec: 0, source_out_sec: 0.147778, intent: 'A restrained route-change accent, not comic humiliation.' },
      { id: 'objective_clears', frame: 2184, asset_id: 'sfx_resolve', role: 'resolve', gain_db: -19, source_in_sec: 0, source_out_sec: 0.289841, intent: 'Small positive resolution when the objective leaves Doom’s reach.' },
      { id: 'objective_lost', frame: 2544, asset_id: 'sfx_impact', role: 'impact', gain_db: -22, source_in_sec: 0, source_out_sec: 0.649025, intent: 'Quieter consequence punctuation for the opinion, not a repeated opening hit.' },
    ],
  },
  camera_contract: {
    coordinates: '1920x1080_scene_pixels',
    transform: 'target+(scene_point-anchor)*scale',
    scene_clock_not_shot_clock: true,
    labels_and_credits_in_output_space: true,
    film_frame_crop_unchanged: true,
    no_blank_frame_edges: true,
    no_decorative_full_frame_shake_or_flash: true,
  },
  visual_direction: {
    ...structuredClone(base.visual_direction),
    approved_program_visuals_preserved: true,
    meaningful_changes_not_cut_quota: true,
    framing_sequence_57_to_75_sec: ['doom_risk_close', 'detour_geography_wide', 'void_hold_close', 'protected_route_detail', 'protected_exit_wide', 'objective_approach_detail', 'objective_payoff_wide'],
    no_new_source_or_character_asset: true,
    no_new_character_expression_generated: true,
  },
};

export default SENTRY_POLISH_EDITORIAL;
