# Dr Insanity format study

**Research date: September 8, 2026.** This study establishes an editorial reference for Goldflow's archive-based true-crime development. The working direction is an investigation carried by recorded encounters, with narration and evidence graphics explaining how the case develops.

The resulting [working format](../../docs/designs/true_crime_archive_format_v1.md) is a design document, not an implemented Goldflow profile. An earlier Halderson paper edit applied it to the already accepted title and thumbnail concept; that draft is retained privately.

## What was examined

Three deliberately selected long videos received full-video automated analysis, followed by independent native-caption and actual-frame spot checks. Twelve recent titles and thumbnail images were also inspected. This is not a claim of end-to-end human listening, an exhaustive channel audit, or access to retention/CTR analytics.

| Video | Reference purpose | Duration metadata | Detailed notes |
|---|---|---|---|
| [Hidden Camera Reveals Wanted Killer Living Inside Family's Attic](https://www.youtube.com/watch?v=FoqxhS_cMJ4) | Recent bodycam/manhunt structure | 34:10 | [Attic sample](sample-attic.md) |
| [College Killer Thinks He Can Get Away With It](https://www.youtube.com/watch?v=vzGJuS8S-Kk) | Interview, witness and evidence structure | 48:57 | [College sample](sample-college.md) |
| [Rich Mass Killer Realizes She's Been Caught 8 Years Later](https://www.youtube.com/watch?v=hALTeHQ_wh0) | Cold-case time jumps and later confrontation | 46:41 | [Cold-case sample](sample-cold-case.md) |

The first 12 recent long uploads returned by the metadata query matched the live Latest-tab packaging sample. Their median duration is **45:16**, range **28:06–1:29:57**. This sample describes current output, not an ideal runtime or a channel-wide lifetime statistic. Player durations occasionally differ from metadata by one second. [Metadata and sample selection](channel-sample.json), [live channel](https://www.youtube.com/@DrInsanityCrime/videos).

Research tool use: three metadata calls and three full-video analyses. Reference-video media was not downloaded.

## Findings and working decisions

| Observed reference pattern | Our working decision |
|---|---|
| Source interaction opens each sample; main chronological setup starts around **1:16–1:40**. | Begin with a consequential actual exchange, add brief orientation, then a visible date/location reset. Aim for about 60–100 seconds for the complete opening, subject to the source. |
| Interview/bodycam passages often last roughly a minute or two, sometimes three; narration length varies materially. | Preserve questions, answers and useful follow-ups. Insert narration when it explains a change, limitation or next step. Do not force a universal footage percentage or a cut every few seconds. |
| Narration previews later evidence and interprets conduct, sometimes assertively. | Use the unanswered investigative question to create anticipation. Attribute claims and avoid presenting thoughts or demeanor as proof. |
| Maps, timelines, evidence highlights, audio waveforms and outcome cards supply information absent from the picture. | Use one readable evidence relationship per graphic, bound to the source and date. Keep the source's recording environment visible when it matters. |
| Some passages are reconstructions; the Attic opening visibly labels an **AUDIO RECREATION**. | Give original recordings, later testimony, narration and recreations separate provenance. Do not count a recreation as recorded evidence. |
| The 12-thumbnail sample has **11 with no added headline**, one with two words; no evidence insets or panel collages. All have recorder-style decoration. | Favor a clear scene and a specific title. Preserve Halderson's accepted three-word concept as our own variant; do not claim yellow headline text is the reference's current norm. |
| The three video endings resolve the investigation with later outcome information; some have brief promotional material. | Close our case with accurately dated verdict, sentence and current disposition, with a respectful return to the people harmed. |

These decisions follow the [timestamped sample notes](sample-attic.md), [College notes](sample-college.md), [cold-case notes](sample-cold-case.md) and [12-pair packaging study](packaging-study.md). They are editorial judgments, not proven explanations of channel performance.

## Reliability corrections

The automated College report's **80.6% source-audio** estimate contradicted the native captions and was rejected. The Attic report misclassified a visibly labeled recreation as original emergency audio. Sound characterizations remain provider-only; there are no measured loudness, speech-rate or shot-duration specifications here. These limits are reflected in the working format rather than hidden behind a precise-looking template.

For Halderson, 11 logged windows total **16:11** before trimming, contextual listening, acquisition or approval. A source-driven 25-minute film needs additional logging to have meaningful editorial choices; a 45-minute target is not justified by this pool. The next paper edit therefore retains a provisional 25-minute spine, expands the source requirements and makes the outstanding physical-evidence footage explicit.
