# Editorial Motion V4 Opening Proof

## Scope

- Episode: `2026-W28-shadow-trains-1000-years-v1/ep_01`
- Diagnostic scope: `0-60s`
- Official render, render report, final QA, and cut ledger hashes were recorded before and after the proof and remained unchanged.
- Source images, narration, Whisper timing, image QA, and accepted cut hashes were reused from the approved episode.

## Editorial Design

- 16 accepted scene images.
- 6 true static holds for reaction, tension, and readable UI beats.
- 7 restrained single-plane directed moves.
- 3 layered 2.5D hero treatments: Nox reveal, stopped spear, and system reveal.
- 8 selected transitions across 15 boundaries; all other boundaries remain hard cuts.
- 7 selected transition SFX.

## Layer Safety

- Apple Vision foreground-instance masks were inspected before render.
- Layer files and source images are bound by SHA-256 in the proof motion plan.
- The first parallax pass exposed blurred duplicate silhouettes when foreground and background translated independently.
- The final pass enforces `foreground_cover`: matching anchor/timing/easing keyframes with foreground scale always greater than or equal to background scale.
- Full-resolution start/mid/end inspection found no doubled heads, exposed duplicate bodies, or system-panel ghosts in the final proof.
- Unsafe treatment now fails sanitation and falls back to a single-plane move or static hold.

## Result

- Output: 1920x1080, 60 fps, H.264 `yuv420p`, AAC, exactly 60.0 seconds.
- 25 phrase-aware subtitles from approved script text timed by Whisper.
- 8 planned transitions and 8 applied transitions.
- 7 transition SFX applied with narrator-only proof override.
- 5,327 motion-trace rows across camera, foreground, and background layers.
- Zero motion-trace blockers.
- Maximum anchor change: `0.00396245` normalized units per frame.
- Maximum scale change: `0.0006469` per frame.
- Final measured loudness: `-13.0 LUFS`; decoded true peak approximately `-2.2 dBFS`.
- Scoped correction reused 13 motion clips and regenerated only the 3 changed parallax clips.

## Outputs

- V4 proof: `review_samples/editorial_motion_v4/editorial_motion_v4_first_60.mp4`
- V3-left / V4-right comparison: `review_samples/editorial_motion_v4/editorial_motion_v3_vs_v4_AB_first_60.mp4`
- Contact sheet: `review_samples/editorial_motion_v4/editorial_motion_v4_first_60_contact_sheet.jpg`
- Hero strips: `review_samples/editorial_motion_v4/parallax_nox_strip.jpg`, `parallax_spear_strip.jpg`, and `parallax_system_strip.jpg`
- Render report: `review_samples/editorial_motion_v4/render_report.json`
- Motion trace: `review_samples/editorial_motion_v4/motion_trace.jsonl`

## Verdict

V4 is the stronger editorial direction for future premium renders: stillness creates contrast, ordinary movement has a single purpose, and depth is reserved for inspected hero beats. It is a validated proof, not a replacement for the already approved full episode. Operator playback review decides whether to promote this distribution to the next full production.
