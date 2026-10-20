# page_build engine proof v1 (silent, no spend)

Status: engine proof only. It renders artwork that was already accepted and makes zero provider calls. It is not production approval and not a playback-reviewed edit.

- Code: commit `ddf8c7c` (`page_build` layout, placeholder layers, zone disclosure binding), rendered from a clean worktree.
- Page: the accepted coma-healer opening montage `fal/bulk/review-repair-outputs/ep_01-w000037-w000041-v2.png`, copied read-only. Measured gutters: vertical at x 1066–1069 and 1460–1462 (full height), horizontal at y 508–511 (right block). Each zone is inset 3 px from the measured gutters.
- Timeline: five 2.4 s beats over 13.5 s, silent fixture, 1920×1080 at 30 fps. Each beat discloses one zone in reading order:
  - Joey (left half) is visible from the start.
  - calendar, locker, rescue and door enter up, left, down and right respectively, over 0.45 s each, with a 0.04 travel and a fade from 0.
  - Zones not yet reached stay empty frames.
  - The last beat pushes the whole page in toward the door zone between 11.0 and 12.4 s.
- Result: `goldflow_panel_render_report_v1` passed: 405 frames, 13.5 s, h264/yuv420p, 8.1 s render time, output sha256 `4e454886…fa4e7`.

What the contact sheet shows:
- No artwork of a later zone appears before its beat. Undisclosed zones render as solid frames.
- Entrances land on the measured zone rectangles.
- During the push-in all zones stay locked to one page rectangle, and the gutters stay straight.
- At the push-in endpoint, part of the page sheet's top edge and some canvas outside the page are visible. That comes from the authored push-in rectangle in this proof, not from the engine. Real authoring should pick the endpoint from the actual frame.

Not covered here:
- Real narration timing.
- Playback review of the movement.
- The native planner offering `page_build`. That waits for zone allocation (Phase 0 piece 3), because today every production beat panel is a whole image.
- Motion revision (`revise-motion`) does not yet recognize `page_build` decisions. Keep page_build recipes out of motion revision until it does.
