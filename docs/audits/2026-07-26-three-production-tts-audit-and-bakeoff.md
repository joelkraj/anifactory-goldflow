# Three-production TTS audit and local-model bake-off

Date: 2026-07-26

## Fixed-voice follow-up

The later operator clarification removed Joel voice-clone similarity from the
requirement. A current fixed/preset-voice screen and full bake-off therefore
supersedes the continuity-first provider recommendation for future narration:
Supertonic 3 `M3`, 8 steps, speed 1.12 is the recommended bounded production proof
for clean, fast, coherent local TTS. See
`docs/audits/2026-07-26-fixed-voice-local-tts-bakeoff.md`. Existing productions
remain unchanged.

## Decision

Do not change TTS providers solely to fix these three episodes. The dominant failures were introduced before synthesis and during stitching:

1. the voice-plan transform deleted approved narration;
2. the batcher collapsed an intentional repeated word;
3. very large provider calls made localized failures expensive and hard to detect;
4. joins used a fixed block of digital zero without edge-aware fades; and
5. there was no unit-level transcript, endpoint, impulse, prepared-clip, or final-stitch gate.

Local Qwen3-TTS 1.7B 8-bit produced the highest combined index because it hit the target cadence and avoided network/queue latency. ModelsLab Qwen with the faster approved reference had the highest single-run passage acceptance, lowest WER, perfect edge score, and substantially closer speaker similarity. The local winner should therefore enter as a guarded pilot or fallback, not silently replace the channel voice.

## Production findings

| Production | Locked-script text absent from TTS plan | Confirmed examples | Measured narration pace |
| --- | ---: | --- | ---: |
| Death Ledger / Goddess of Death | 33 phrases, 84 words | attribution/action omissions; provider call 107 clipped the final word “repossess” before a hard-zero join | 178.37 WPM |
| Apocalypse Goblin Queen | 2 phrases, 19 words, plus one repeated word | “His voice was gravel and iron”; “Looking back is…”; “is, is” collapsed to one “is” | 217.23 WPM |
| Afterlife for One Coin | 56 phrases, 146 words | opening UI labels removed; “The ring snapped” removed; dialogue attributions removed, producing malformed joins such as “Cassian, listen to him nothing” | 172.93 WPM |

Cross-production evidence:

- All 345 provider requests omitted the authored `qwen_instruct`; the current ModelsLab v6 route did not submit those directions.
- The old batch topology synthesized 120, 100, and 125 very large requests. Nearly every call was over 100 words.
- Every boundary inserted 160 ms of absolute digital zero, with no fade or padding-aware gap calculation.
- The raw provider files did not show broad clipping. The audible “mic” symptoms were concentrated around active tails, breath/noise-like untranscribed energy, and hard joins.
- Medium Whisper showed that some apparent omissions from a smaller ASR pass were harmless number/initialism formatting differences. Only exact-script coverage plus equivalence-aware ASR separated real deletions from transcription spelling.

## Pipeline remediation

The implemented lane now:

- gates exact locked-script token coverage before TTS while keeping caption text separate from TTS-only pronunciation text;
- preserves intentional repeated words and standalone system/UI narration;
- creates stable, unique unit and timing IDs;
- produces balanced sentence-bounded units of at most 45 words while crossing only compatible source-segment boundaries;
- keeps independent exact-caption fragments so spoken overrides cannot leak into subtitles;
- includes reference audio, native speed, instruction delivery, text, speaker, and model settings in synthesis reuse identity;
- compares ASR with number, initialism, abbreviation, and approved-pronunciation equivalence;
- blocks missing opening/final words, contiguous omissions, protected-value changes, clipping, hard sample impulses, energetic active tails, and long untranscribed active bursts;
- checks raw units, post-trim/fade prepared clips, final stitch edges, and the final waveform;
- uses 8 ms fades and padding-aware insertion to reach the target gap instead of adding a fresh 160 ms after retained silence;
- hash-binds prepared assets and final WAV/M4A output;
- records exact unit/speaker retry scope without changing historical scope hashes; and
- preserves correct timing math for both the legacy stitch schema and the new prepared-audio schema.

On the three real plans, the rebuilt topology is:

| Production | New units | Units below the 20-word target | Maximum words | Exact script coverage |
| --- | ---: | ---: | ---: | ---: |
| Death Ledger | 365 | 11 | 45 | 16,063 / 16,063 |
| Apocalypse Goblin Queen | 346 | 0 | 45 | 15,613 / 15,613 |
| Afterlife for One Coin | 397 | 31 | 45 | 16,392 / 16,392 |

The sub-20-word rows are unavoidable protected barriers or residual sentence tails; they are not the old one-word fragmentation pattern.

## Bake-off design

Fifteen production-derived passages covered:

- repeated-word preservation;
- terminal-tail integrity;
- narration attribution/action joins;
- system/UI labels, numbers, ratios, and initialisms;
- names and ranks;
- emotional cadence;
- left, right, and combined passages from each of the three productions; and
- three simulated production stitches per model using the remediated 8 ms fade and 160 ms target gap.

The score is an objective reliability index, not a listener MOS:

- transcript fidelity: 45 points;
- edge integrity: 20;
- pace: 15;
- stability: 10; and
- warm-generation throughput: 10.

Speaker similarity is reported separately as WeSpeaker VoxCeleb ResNet34 LM cosine similarity against the centroid of six approved Joel references. Hosted real-time factor includes network and provider queue time, so it is not a pure model-speed comparison.

## Principal bake-off

| Rank | Model | Reliability score | Passage pass | WER | WPM | RTF | Joel similarity |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | Local Qwen3-TTS 1.7B 8-bit | 86.117 | 80.0% | 2.42% | 213.0 | 0.323 | 0.843 |
| 2 | Local Qwen3-TTS 0.6B 4-bit | 84.955 | 73.3% | 3.16% | 193.4 | 0.221 | 0.839 |
| 3 | ModelsLab Qwen, fast ref, speed 1.0 | 80.552 | 86.7% | 2.12% | 190.5 | 1.609 | 0.884 |
| 4 | Local VoxCPM2 4-bit | 78.581 | 53.3% | 4.54% | 218.8 | 0.706 | 0.891 |
| 5 | Local Higgs Audio v2 3B q6 | 77.897 | 53.3% | 4.75% | 205.2 | 0.462 | 0.896 |
| 6 | Local Chatterbox Turbo 4-bit | 75.694 | 60.0% | 6.61% | 197.7 | 0.169 | 0.703 |
| 7 | ModelsLab Qwen, fast ref, speed 1.25 | 75.639 | 73.3% | 3.01% | 188.8 | 1.982 | 0.872 |
| 8 | ModelsLab Qwen, fast ref, speed 1.10 | 75.391 | 73.3% | 3.20% | 192.3 | 2.430 | 0.881 |
| 9 | ModelsLab Qwen, current ref, speed 1.25 | 68.551 | 60.0% | 3.49% | 171.1 | 1.926 | 0.885 |

No ranked model clipped, collapsed into silence, or failed the simulated faded joins. Qwen 1.7B had one endpoint/edge failure in the principal seed; Higgs and the current hosted reference each had two edge failures across fifteen passages.

The provider-native speed setting did not produce monotonic measured WPM in the hosted trials. Reference performance and stochastic generation dominated the nominal speed value, so speed must continue to be measured rather than trusted as deterministic tempo.

## Seed stability

The two local Qwen finalists were each evaluated across three seeds (45 passages per model including the principal seed):

| Model | Mean WER | Mean passage pass | Mean WPM | Observed failure |
| --- | ---: | ---: | ---: | --- |
| Qwen3-TTS 1.7B 8-bit | 3.89% | 73.3% | 212.9 | one “repossess” → “repossessed”; one edge flag |
| Qwen3-TTS 0.6B 4-bit | 3.38% | 68.9% | 190.9 | one opening hallucination (“In the, in the…”); two edge flags |

This variation requires per-unit reject/retry even for the local winner.

## Voice similarity

The six approved source references had 0.919 mean leave-one-out self-consistency. Principal-run model means:

| Model | Mean cosine similarity |
| --- | ---: |
| Higgs Audio v2 3B q6 | 0.896 |
| VoxCPM2 4-bit | 0.891 |
| ModelsLab Qwen, current ref, speed 1.25 | 0.885 |
| ModelsLab Qwen, fast ref, speed 1.0 | 0.884 |
| Local Qwen3-TTS 1.7B 8-bit | 0.843 |
| Local Qwen3-TTS 0.6B 4-bit | 0.839 |
| Chatterbox Turbo 4-bit | 0.703 |

Higgs is the most promising second local candidate for perceptual review because it best preserved Joel’s speaker embedding, but its 53.3% passage acceptance and 4.75% WER make it unsuitable as the primary lane without the same reject/retry gate.

Fish Speech S2 was also probed with both a slow and a fast reference. Both outputs were near-silent (about 7–8 seconds, roughly -54 dBFS mean, empty Whisper transcript), so Fish was disqualified from ranking. Its license also requires separate commercial licensing review.

## Recommended operating decision

1. Keep ModelsLab Qwen as the immediate continuity-safe production route, using the stronger fast reference and all new integrity gates.
2. Add local Qwen3-TTS 1.7B 8-bit as the first shadow/pilot route. It won the combined score through cadence and throughput, supports local instruction control, and avoids network queues, but it must use per-unit QA/retry and pass a human blind voice check.
3. Keep Higgs Audio v2 as the second local listening finalist for voice likeness, not as the default synthesizer yet.
4. Do not use Chatterbox or Fish as the primary longform lane from this result.
5. Do not mix hosted and local voices inside one episode unless a perceptual continuity test explicitly approves it.

## Existing-production recovery

The old TTS reports have no stable unit IDs, and the remediated topology has no safe one-to-one reuse mapping to the legacy provider calls. All three narrations therefore need a full official voice-plan/TTS rebuild, followed by fresh Whisper timing, pace report, timing bind, longform bed, render, and final QA. A narrow patch of legacy batch numbers would preserve unknown omissions and stale timing.

No production audio or render was regenerated during this audit. All three ledgers still resolve to `upload_packaging`; the new hash enforcement remains backward-compatible with their historical report schema.

## Artifacts

- Bake-off report: `/Users/joel/AniFactoryData/voice_bank/bakeoff/2026-07-26-goldflow-tts-integrity-v1/bakeoff_report.md`
- Machine-readable results: `/Users/joel/AniFactoryData/voice_bank/bakeoff/2026-07-26-goldflow-tts-integrity-v1/bakeoff_results.json`
- Speaker-similarity results: `/Users/joel/AniFactoryData/voice_bank/bakeoff/2026-07-26-goldflow-tts-integrity-v1/speaker_similarity.json`
- Three-seed finalist results: `/Users/joel/AniFactoryData/voice_bank/bakeoff/2026-07-26-goldflow-tts-integrity-v1/finalist-stability/bakeoff_results.json`
- Blinded listening pack: `/Users/joel/AniFactoryData/voice_bank/bakeoff/2026-07-26-goldflow-tts-integrity-v1/blind`

## Upstream references

- Qwen3-TTS official implementation and model capabilities: https://github.com/QwenLM/Qwen3-TTS
- MLX-Audio local Apple Silicon runtime: https://github.com/Blaizzy/mlx-audio
- VoxCPM official implementation: https://github.com/OpenBMB/VoxCPM
- Chatterbox official implementation: https://github.com/resemble-ai/chatterbox
- Higgs Audio official implementation: https://github.com/boson-ai/higgs-audio
- WeSpeaker evaluation model: https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34-LM
- Fish Speech license: https://github.com/fishaudio/fish-speech/blob/main/LICENSE
