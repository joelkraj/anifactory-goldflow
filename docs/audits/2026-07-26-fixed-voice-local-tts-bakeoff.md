# Fixed-voice local TTS bake-off

Date: 2026-07-26

> Historical comparison only. This machine-scored screen recommended a
> Supertonic proof; a later listening round temporarily selected Kokoro
> `am_puck`, with `am_fenrir` second. Both policies are superseded by the
> operator-approved Qwen3-TTS 1.7B Base route with the exact Liam reference
> clone. See
> `docs/audits/2026-07-28-qwen-liam-production-default.md`. Neither Puck nor
> Fenrir is a selectable current production alternate.

## Decision

For the revised requirement—clean, fast, coherent narration without preserving Joel's
voice—the best fixed-voice candidate tested is:

- model: Supertonic 3;
- preset: `M3`;
- native speed: `1.12`;
- diffusion steps: `8`;
- language: `en`; and
- reference audio: none.

This is a recommendation for a bounded production proof, not yet an unqualified
full-episode default. Supertonic M3 met the 195–220 WPM production target at 208.6
WPM, generated at 0.182 RTF (about 5.5 times real time), and had no clipping,
near-silence, active-tail, impulsive-discontinuity, or simulated faded-join failures.
It also removes the reference-recording path that can carry room tone, breath,
mouth noise, or microphone character into cloned output.

The previous local Qwen3-TTS 1.7B clone remains the highest raw reliability-index
result and a useful control. It is not the best operational fit for this revised
requirement because voice cloning is unnecessary and it had one active-endpoint
failure in this run. The fixed Qwen CustomVoice presets were tested rather than
assumed to inherit that result; they were too slow in delivery and less stable at
the segment edges.

## Test design

The smoke screen evaluated sixteen fixed/preset configurations across Supertonic
3, Qwen3-TTS CustomVoice, Kokoro, and Inflect Micro v2. The selected fixed-voice
finalists then ran the full fifteen-passage production-derived suite alongside the
two strongest prior controls:

- intentional repeated words;
- terminal-word preservation;
- dialogue-attribution and action continuity;
- system/UI text, numbers, ratios, ranks, and initialisms;
- invented names and Manhwa terminology;
- emotional cadence;
- left, right, and combined joins derived from all three productions; and
- three production-style stitch simulations using 8 ms edge fades and a 160 ms
  effective segment gap.

The reliability index weights transcript fidelity, endpoint integrity, measured
pace, stability, and warm-generation throughput. It is not a human naturalness or
voice-preference score. Speaker similarity was deliberately excluded.

## Full bake-off results

| Rank | Candidate | Score | Passage pass | Whisper WER | WPM | RTF | Audio / wall time | Edge failures | Impulse failures | Faded joins |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | Local Qwen3-TTS 1.7B 8-bit clone control | 86.117 | 80.0% | 2.42% | 213.0 | 0.323 | 3.1x | 6.67% | 0% | 3/3 |
| 2 | ModelsLab Qwen clone control | 80.552 | 86.7% | 2.12% | 190.5 | 1.609 | 0.62x | 0% | 0% | 3/3 |
| 3 | Kokoro BF16 `af_heart`, speed 1.2 | 77.753 | 46.7% | 4.91% | 191.4 | 0.042 | 23.6x | 0% | 26.67% | 3/3 |
| 4 | Supertonic 3 `M3`, 8 steps, speed 1.12 | 76.695 | 73.3% | 6.77% | 208.6 | 0.182 | 5.5x | 0% | 0% | 3/3 |
| 5 | Inflect Micro v2 ONNX, speed 1.0 | 68.522 | 60.0% | 6.79% | 164.4 | 0.292 | 3.4x | 0% | 0% | 3/3 |

The numerical leaderboard and the operational decision answer different questions.
Qwen Base remains the best tested cloning/control model. Supertonic is the best
tested fixed voice for the actual requirement because it combines target cadence,
fast local synthesis, clean boundaries, and no microphone/reference dependency.

Supertonic's raw WER needs careful interpretation. Nine of fifteen passages were
Whisper-exact. The ordinary repetition, tail, attribution/action, emotional, and
Goblin Queen passages were exact. Much of the remaining edit distance came from
invented-name and homophone spellings such as `Cassian` / `cash and`,
`prophet sight` / `profit site`, and `Manhwa` / `manwa`. These are not evidence of
missing clauses, but they are evidence that episode-specific names and protected
terms need the existing targeted spoken overrides and a human spot-listen. The
`S S S` rank pronunciation is a real protected-term risk and must be explicitly
verified rather than dismissed as ASR spelling.

## Smoke-screen findings

- Supertonic `M3`, 8 steps, speed 1.12 won the six-passage fixed-voice screen:
  81.935 score, 83.3% passage pass, 203.5 WPM, 0.173 RTF, and no edge or impulse
  failures.
- Raising Supertonic to 12 steps increased runtime without improving the selected
  result. Other male presets were materially slower in delivery.
- Qwen3-TTS CustomVoice `Aiden` averaged 156.3 WPM and failed the edge check on
  half of the smoke passages. `Ryan` averaged 120.1 WPM and had an impulse
  failure; an instruction requesting a brisk 205 WPM delivery made it slower,
  not faster.
- Kokoro was the throughput winner. Its full run exposed impulsive sample
  discontinuities in four of fifteen passages, so it is not suitable for this
  clean-audio lane without additional model-side or output repair work.
- Inflect Micro v2 was deterministic and clean at the edges, but its 164.4 WPM
  delivery and lower transcript result missed the production requirement.

## Recommended proof configuration

Use Supertonic 3 `M3`, `total_steps=8`, `speed=1.12`, and `lang=en`. Pin the
model assets, Supertonic Python SDK `1.3.1`, ONNX Runtime version, preset-style
JSON hash, and runner hash.

Keep the remediated Goldflow narration controls:

1. sentence-bounded units, normally 20–45 words;
2. exact locked-script coverage before synthesis;
3. TTS-only number, initialism, and narrow pronunciation overrides;
4. per-unit Whisper equivalence, first/final-token, endpoint, clipping, impulse,
   and untranscribed-energy gates;
5. retry only rejected units;
6. 8 ms edge fades with a padding-aware 160 ms effective segment gap; and
7. fresh local Whisper timing and pace measurement after the final stitch.

Run one representative 10–20 minute proof or roughly fifty real production units
before promoting the provider for full episodes. The proof must include every
episode-specific name, rank, UI label, acronym, and emotionally intense passage,
then pass a blinded human listen for naturalness and continuity. Do not regenerate
all three productions until that listen passes.

## Current-model and licensing check

This shortlist was refreshed against official sources on 2026-07-26. Supertonic 3
was released on 2026-04-29 as a 99M-parameter, 44.1 kHz, fixed-voice ONNX model;
its official runtime supports ten built-in voices, 5–12 steps, and native speed
control from 0.7–2.0. Qwen3-TTS's current official release includes the English
CustomVoice presets Ryan and Aiden, which were both tested here rather than inferred
from the Base cloning model. Kokoro and Inflect were also tested from their official
open-weight releases.

There are two Supertonic deployment caveats:

- The official repository announced on 2026-07-23 that it will be archived and
  receive no further open-source development or support. Production use therefore
  requires vendoring/pinning the tested assets and retaining a fallback provider.
- The Supertonic 3 model uses OpenRAIL-M terms whose use restrictions include an
  express, intelligible machine-generated-content disclosure. The channel's
  disclosure and commercial-use posture must be reviewed before production
  promotion. This audit is not legal advice.

Official sources:

- https://github.com/supertone-inc/supertonic
- https://github.com/supertone-inc/supertonic-py
- https://huggingface.co/Supertone/supertonic-3
- https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE
- https://github.com/QwenLM/Qwen3-TTS
- https://huggingface.co/hexgrad/Kokoro-82M
- https://huggingface.co/owensong/Inflect-Micro-v2

## Artifacts and validation

- Full report:
  `/Users/joel/AniFactoryData/voice_bank/bakeoff/2026-07-26-fixed-voice-clean-fast-v1/full/bakeoff_report.md`
- Machine-readable full results:
  `/Users/joel/AniFactoryData/voice_bank/bakeoff/2026-07-26-fixed-voice-clean-fast-v1/full/bakeoff_results.json`
- Blinded listening pack:
  `/Users/joel/AniFactoryData/voice_bank/bakeoff/2026-07-26-fixed-voice-clean-fast-v1/full/blind`
- Smoke results:
  `/Users/joel/AniFactoryData/voice_bank/bakeoff/2026-07-26-fixed-voice-clean-fast-v1/smoke/bakeoff_results.json`

Validation completed:

- all five full candidates contain fifteen analyzed passages and three join
  simulations;
- all Python bake-off runners compile;
- the ModelsLab bake-off runner passes Node syntax checking;
- `git diff --check` passes; and
- the Goldflow fixture suite passes all 142 tests.

No production episode, narration, timing artifact, or render was changed during
this fixed-voice diagnostic.
