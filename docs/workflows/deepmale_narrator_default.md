# Operator selected deep male narrator

The user selected `deepmale_narration_reference_20261019` as the default for future videos and explicitly requested a Coma Healer narration rebuild after receiving the reference and reuse demo. This is direct operator selection, not a claimed blind comparison or fatigue approval. Existing run locks remain unchanged until an explicit guarded relock.

New preflights and source auditions use the new voice. `DEFAULT_NARRATOR_VOICE_ID` remains the historical Joel compatibility identifier; `DEFAULT_NEW_NARRATOR_VOICE_ID` selects new runs. Explicit Joel identities remain readable with their original reference variants. The shared reference lock is `config/qwen_deepmale_voice.json`; JS and Python consume the same hashes. The neutral-only delivery bank preserves the other style requests as unpromoted fallbacks and records explicit operator authority without fabricating a blind approval.

The durable reference, transcript, source, two test generations, calibration and operator-selection metadata live under `/Users/joel/AniFactoryData/voice_bank/qwen/reference_samples/deepmale_voicedesign_20261019/`. Metadata, reference WAV, manifest and calibration each have separate hashes. Continuity calibration uses the user-provided sample and two distinct synthetic passages, not three independent human recordings.

To migrate the requested episode, use a clean committed worktree and the guarded command:

```sh
node bin/goldflow.mjs run relock-tts --episode-dir <exact-episode-dir> --tts-profile qwen3_1_7b_base_deepmale_sentence_v1 --narrator-voice-id deepmale_narration_reference_20261019 --operator-approved true --workflow-bypass true --reason <exact-user-authority-and-safe-recovery-scope>
```

This archives the prior identity, reports and canonical mastered audio bytes with hashes before rebinding the selected voice. It preserves source and semantic facts. Resume from `run status`; rebuild narration, Whisper, pace and timing-dependent output. Do not reuse historical voice approval or stale rendered timing. No automatic retries, voice failover, speech-edge trimming or tempo changes are authorized by this selection. Current raw-edge safeguards and delivery QA remain required.
