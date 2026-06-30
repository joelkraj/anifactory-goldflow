# Goldflow TODO

## Audio / TTS

- [ ] Debug why ModelsLab Qwen TTS lands far below the 215 WPM target on longform runs.
  - Current observed case: streamer-system-simp `ep_01` stitched narration measured `163.62 WPM` from local Whisper timing against the required `210-220 WPM` gate.
  - Five-minute proof reproduced the issue: 1,162 source words generated 416.714 seconds of Qwen audio, and local Whisper measured `163.278 WPM`.
  - Root cause found in `voice-direction-gate.mjs`: Qwen narration instructions told paragraph delivery to target `150-170 words per minute`; this must stay aligned to the production `210-220 WPM` gate.
  - Confirm whether the root cause is voice direction, Qwen voice defaults, segment pacing tags, stitch gaps, provider speech-rate controls, or post-TTS tempo correction policy.
  - Decide and document the production fix so future runs naturally land near `215 WPM` without needing emergency downstream speed-up.
  - Add a first-5-minute pace smoke check after TTS starts so slow narration is caught before a full episode finishes.
- [ ] Expand TTS homograph QA from the streamer test run.
  - Known failures: live-stream "live" misread as "liv"; media/clip "content" misread as emotional content.
  - Confirm `script_speakability_report.json` catches these and `tts_spoken_overrides.json` changes only Qwen spoken text, not captions, visuals, or script text.

## Source Script / Hook Authoring

- [ ] Use a 5-minute proof run to validate the condensed streamer hook before repairing the long episode.
  - Hook/story timing is a chatbot/source-script responsibility; Goldflow should verify and block drift, not invent the hook downstream.
  - Source prompt now targets title payoff by 0:30, first live/system proof around 0:45 for streamer/system stories, and next major arc around 1:00 when the premise supports it.
- [ ] Build a first-3-minute source-script acceptance report.
  - Check 30/45/60/90/180 second story milestones at 215 WPM before ingest.
  - Reject creator-facing meta lines such as "that was the hook" or "viewer anticipation verified."
