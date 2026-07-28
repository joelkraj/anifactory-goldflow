# Joey Manhwa Human Shield Comment-Criticism Gate

Date: 2026-07-28

## Candidate Identity

- Script: `docs/source-candidates/joey_manhwa_human_shield_chatgpt_v4_1_rescued_2026_07_28_86091cb5.txt`
- SHA-256: `86091cb58269a8f9618e39adedcca64cf025276dd4a68d6bf843cfe70d750481`
- Words: 14,010
- Runtime at 215 WPM: 65.16 minutes
- Title: `His S Rank Girlfriend Used Him As A Human Shield, So He Quit And Became The Strongest Tank`
- Thumbnail promise: zero-score Joey is abandoned as the sixth party member while Serena and four elites escape, then returns as the strongest verified tank
- Premise: Serena's elite party takes credit for Joey's protection, abandons him, and loses him to a consent-based rescue crew after his defensive mechanic awakens
- Canonical mechanics: Threat Transfer forces hostile priority only while Serena maintains it nearby; Burden Reclaimed releases finite Guard Experience only after Joey freely intercepts real danger for another person and the qualifying danger fully ends
- Script-level decision: `PASS`
- Production state: release-gate passed; ready for production preflight and exact-hash ingest

## Rescue Integrity

The rescued candidate differs from the selected ChatGPT V4.1 source in exactly one sentence.

Removed:

`The qualifying burden came from the charge Joey intercepted for the lead driver, the second impact against the ambulance, and the support he held for Lena and the patient during the roll.`

Replaced with:

`The qualifying burden came from the charge Joey intercepted for the lead driver and the support he held for Lena and the patient during the roll.`

Reversing this replacement reproduces the original candidate byte-for-byte. No other narration, punctuation, paragraph break, mechanic, name, number, or scene changed.

## Delivery Check

| Measurement | Rescued script | Direct-winner benchmark |
| --- | ---: | ---: |
| Mean sentence length | 9.07 | 9.46 |
| Median sentence length | 8 | 8 |
| Ninetieth percentile | 15 | 17 |
| Sentences with eight words or fewer | 52.0% | 50.2% |
| Sentences longer than twenty-five words | 0.2% | Not a release concern |

The narration remains inside the requested 13,800 to 14,300 word range and closely matches the selected direct-winner cadence.

## Structural Timing

| Milestone | Word position | Time at 215 WPM |
| --- | ---: | ---: |
| Replacement announcement | 527 | 2.45 min |
| Five recall signatures selected | 873 | 4.06 min |
| Joey refuses | 1,084 | 5.04 min |
| Burden Reclaimed awakens | 1,285 | 5.98 min |
| First physical proof | 1,565 | 7.28 min |
| Joey reaches the surface | 1,930 | 8.98 min |
| Joey leaves Apex | 2,055 | 9.56 min |
| Lantern is named | 2,128 | 9.90 min |
| Crown Station begins | 9,547 | 44.40 min |
| Crown Station danger ends | 12,862 | 59.82 min |
| Final equilibrium begins | 13,827 | 64.31 min |

The primary climax resolves at 91.8 percent of the narration. The remaining 8.2 percent performs Serena's concrete loss, Joey's final boundary, and the concise Lantern equilibrium.

## Six-Gate Review

| Gate | Status | Word-position evidence and short excerpts |
| --- | --- | --- |
| Joey competence and learning | `PASS` | Word 1 establishes that five elites live because zero-score Joey stands in front. Around word 1,085 he refuses Serena: `No. You chose five.` His one later relapse is the three-minute Quarry hold after reporting a ninety-second limit; Oren's permanent injury follows. Around words 7,794-8,064 Joey owns the concealment, accepts restricted duty, and begins reporting exact limits. He never repeats the lie. |
| Plot logic and payoff | `PASS` | Around word 1,260 the awakening explicitly `did not offer rescue` or choose a target. Around word 4,751 Serena builds her counter only from what cameras showed. The Quarry defeat follows Joey's false limit, while the climax uses the seeded second branch, portable anchors, Adrian, and all four attackers. Around word 12,886 the final payout arrives only after victory and `changed nothing about how the victory happened`. |
| Pacing and non-repetition | `PASS` | The replacement lands at word 527, recall selection around 873, refusal around 1,085, awakening at 1,285, physical proof at 1,565, surface escape at 1,930, Apex exit at 2,055, and Lantern at 2,128. Sunken Rail, North Causeway, Quarry, restricted recovery, the apartment rescue, and Crown Station each change the objective, threat mechanism, relationship, or consequence. |
| Joey versus the system | `PASS` | Around word 1,260 Burden Reclaimed supplies neither rescue nor a target. Around words 2,589-2,683 Joey and Mira define the rescue objective and mechanic limits. Allies repeatedly alter the route and execution; the system never chooses the moral objective or completes the victory. |
| First-time viewer clarity | `PASS` | Around word 2,589 Mira states the objective in plain terms; around word 2,613 the script clarifies that killing every creature is unnecessary; around word 2,683 Joey states what Burden Reclaimed cannot do. Names arrive with functions, and every major movement restates the current objective, obstacle, usable limit, choice, and result. |
| Growth, revenge, and closure | `PASS` | Around word 13,301 Serena's authority collapses when the people whose endurance built it walk away. Official confirmation stays brief. Around word 13,763 Joey delivers the final boundary: `You never lost your tank. You lost the man who agreed to disappear for you.` The relationship ends, and the final equilibrium begins around word 13,827 with Lantern choosing risk together. |

## Mechanic Ledger

The explicit available Guard Experience arithmetic reconciles:

1. Opening inheritance: 12,000.
2. Compression Brace and Anchored Frame: 12,000 minus 1,800 minus 2,200 equals 8,000.
3. Resonance Damping and Sunken Rail payout: 8,000 minus 1,600 plus 3,100 equals 9,500.
4. Deflection Guard and North Causeway payout: 9,500 minus 2,000 plus 1,700 equals 9,200.
5. Quarry payout and Load Relay: 9,200 plus 2,800 minus 3,000 equals 9,000.
6. Apartment rescue payout: 9,000 plus 2,200 equals 11,200.
7. Crown Station spending: 11,200 minus 2,400 minus 2,800 minus 1,800 minus 1,600 minus 2,300 equals 300.

The Crown Station payout arrives only after the boss can no longer reach any protected person and does not contribute to the victory.

## TTS Source Scan

The exact candidate contains no digits, brackets, parentheses, em dashes, en dashes, semicolons, colons, slash notation, headings, markdown markers, or production directions.

This source review does not replace operator script approval or downstream targeted speakability. The next valid production actions are production preflight, exact-hash source ingest, and then operator approval of the resulting `script_clean.md` hash.
