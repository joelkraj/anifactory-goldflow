# Editorial Motion V5 Full Render

## Scope

- Episode: `2026-W28-shadow-trains-1000-years-v1/ep_01`
- Approved editorial proof scope: `0-60s`
- Full variant duration: `4,846.630998s` (`01:20:46.63`)
- The approved production render, render report, final QA, and official cut ledger remained unchanged.

## V5 Depth Change

- Kept V4's 16-cut rhythm, 6 true static holds, 7 restrained single-plane moves, 8 selected transitions, and 7 opening transition accents.
- Strengthened only the three inspected layered hero shots: Nox reveal, stopped spear, and system reveal.
- Each layered shot now uses readable opposing-plane scale: the background eases outward while the foreground eases inward.
- Foreground and background retain identical anchors, timing, and easing under the `foreground_cover` contract.
- A diagnostic attempt ending the background at exactly `1.000` exposed an FFmpeg perspective-boundary edge case. Production V5 ends at `1.005`, preserving the pullback with valid geometry.
- Full-resolution endpoint and five-frame strip inspection found no exposed source silhouettes, doubled subjects, cutout holes, or layer drift.

## Promotion Contract

- `goldflow visual motion-promote-proof` promotes only approved in-scope creative motion and transition choices.
- 16 opening motion intents were promoted.
- 549 later motion intents remained byte-for-byte unchanged.
- The proof-truncated boundary cut was restored to its full-timeline duration.
- 8 proof transitions replaced opening boundaries; 75 later base transitions were retained.
- Full variant total: 565 motion intents, 6 static holds, 3 layered parallax shots, and 83 transitions.

## Full Render QA

- 1920x1080, 60 fps, H.264 `yuv420p`, AAC stereo at 44.1 kHz.
- 565 unique accepted images; zero duplicate hashes and zero donor recoveries.
- 2,059 final-script subtitles timed by Whisper.
- 83 planned transitions and 83 applied transitions.
- 7 transition SFX applied only in the approved opening variant.
- 293,672 motion-trace rows and zero motion-trace blockers.
- Final loudness: `-13.00 LUFS`; measured true peak `-1.63 dBTP`.
- Decoded AAC check: `-16.0 dB` mean and `-1.8 dB` maximum.
- Final size: `2,481,658,296` bytes.
- Final SHA-256: `c6d1922beaa2ecc1f5014bfdb8e1314b616859a4eb9a563b457e6682bd87fee4`.
- Variant final QA status: `passed`, zero blockers.

## Outputs

- First-minute V5 proof: `review_samples/editorial_motion_v5/editorial_motion_v5_first_60.mp4`
- Full upload-safe variant: `assets/renders/ep_01-53rebirth-editorial-motion-v5.mp4`
- Promotion report: `review_samples/editorial_motion_v5_full/editorial_motion_promotion_editorial-v5_report.json`
- Full render report: `review_samples/editorial_motion_v5_full/render_report.json`
- Full final QA: `review_samples/editorial_motion_v5_full/final_qa.json`
- Full motion trace: `review_samples/editorial_motion_v5_full/motion_trace.jsonl`
- Opening/middle/ending contact sheets: `review_samples/editorial_motion_v5_full/*_contact_sheet.jpg`

## Pipeline Hardening

- Added a resumable proof-to-full promotion command with timing restoration and untouched-intent validation.
- Replaced single-buffer media hashing with streaming SHA-256 in render and final QA.
- Added `goldflow render finalize-report` for repairing a passed legacy/variant report with null output hashes without rerendering media.

## Verdict

V5 keeps the approved restraint and pacing while making the three hero depth moments visibly dimensional. The separate full-length variant passed structural, visual, motion, audio, subtitle, hash, and media QA and is ready for operator playback review.
