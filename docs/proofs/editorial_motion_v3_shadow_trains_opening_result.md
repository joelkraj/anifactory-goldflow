# Editorial Motion V3 Opening Proof

## Scope

- Episode: `2026-W28-shadow-trains-1000-years-v1/ep_01`
- Diagnostic scope: `0-60s`
- Official render and final QA artifacts were not changed.
- Source images, narration, Whisper timing, image QA, and cut hashes were reused from the approved episode.

## Outputs

- Proof MP4: `review_samples/editorial_motion_v3/editorial_motion_v3_first_60.mp4`
- Side-by-side MP4: `review_samples/editorial_motion_v3/editorial_motion_v3_AB_first_60.mp4`
- Contact sheet: `review_samples/editorial_motion_v3/editorial_motion_v3_first_60_contact_sheet.jpg`
- Render report: `review_samples/editorial_motion_v3/render_report.json`
- Motion trace: `review_samples/editorial_motion_v3/motion_trace.jsonl`

## Result

- 16 accepted scene images.
- 16 image-aware multi-phase motion intents.
- 14 selected visual transitions; one opening boundary deliberately remains a hard cut.
- 12 transition SFX, resolved from seven calibrated SFX families to approved available bank assets.
- 3,784 traced motion frames with zero motion blockers.
- 14 planned transitions and 14 applied transitions.
- Output: 1920x1080, 60 fps, H.264, `yuv420p`, AAC, 60.0 seconds.
- Final measured audio: `-13.0 LUFS`, approximately `-2.1 dBFS` sample peak.
- Phrase-aware subtitle grouping reduced accidental hook fragments while preserving exact approved words and deliberate short emphasis.

## Inspection Notes

- Spear cuts track the attacker toward the impact point instead of applying generic centered pushes.
- Arena and barrier cuts use real zoom-outs that reveal more canvas.
- Reaction and UI cuts land quickly, settle, and hold long enough to read.
- The one-second contact sheet shows no incoherent head crops or focal drift introduced by motion.
- The first transition-SFX mix exposed an `amix` normalization defect that attenuated narration as sparse inputs were added. The renderer now uses `normalize=0` and measured two-pass loudnorm.
- Bank assets with long internal lead-ins are now family-calibrated with trim and pre-cut offsets so their audible peak lands near the selected transition instead of after it.

## Promotion Boundary

The reusable contracts and guards are production-ready, but this proof does not replace the approved full episode. Operator review of the proof and A/B decides whether to apply image-aware keyframe direction to a future full render.
