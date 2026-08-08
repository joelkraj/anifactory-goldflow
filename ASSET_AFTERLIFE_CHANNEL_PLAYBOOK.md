# Asset Afterlife Channel Playbook

Last checkpoint: August 3, 2026

Status: **Preserved and ready to resume. Approved for a controlled channel test, not yet fully market-validated.**

This is the canonical restart document for the Asset Afterlife lane. The broader cross-channel backlog remains in [YOUTUBE_NICHE_RESEARCH.md](YOUTUBE_NICHE_RESEARCH.md), and the validation audit remains in [YOUTUBE_NICHE_FINAL_VALIDATION_REVIEW_2026-08-01.md](YOUTUBE_NICHE_FINAL_VALIDATION_REVIEW_2026-08-01.md).

## Channel Thesis

**Internal format name:** Asset Afterlife

**Viewer promise:** Follow a valuable object after its final public moment and reveal who controls it, what remains valuable, which decisions determine its fate, and where it ultimately ends up.

**Emotional promise:** Every episode should feel like an investigation, funeral, and possible resurrection. The object is the protagonist.

Possible viewer-facing channel language:

- The Secret Afterlife of Expensive Things
- Where Valuable Things Go to Die
- What Happens After the Final Use
- The Hidden Second Life of Machines

The final channel name has not been selected.

## Why We Are Testing It

The August 1 market snapshot found repeated small-channel breakouts around valuable things becoming lost, retired, abandoned, unsold, seized, wrecked, or decommissioned. The strongest click engine was:

> Something valuable disappeared. Where did it go?

The evidence supports a controlled test, not a claim that the cross-asset category is already validated. Topic-level outliers exist across aircraft, shipping containers, unsold cars, ship salvage, stadiums, subway cars, and lost property. We still need proof that viewers will follow the same editorial promise across materially different asset classes.

**Primary quality benchmark:** Jet Crumbs, especially its aviation disposition videos. The benchmark combines real footage, clean animated explanations, strong sound design, smooth narration, and frequent visual change. Goldflow should match or beat that editorial finish without copying its scripts or packaging.

## Non-Negotiable Episode Grammar

Every approved episode needs all six elements:

1. A valuable or high-scale asset.
2. A terminal event: final use, retirement, loss, seizure, shutdown, repossession, abandonment, wreck, or failure to sell.
3. A hidden chain of custody: owner, lender, insurer, regulator, storage party, buyer, or liable party.
4. A consequential decision: repair, store, auction, export, part out, salvage, repurpose, recycle, sink, or destroy.
5. A visible transformation.
6. A final verdict: what survived, what was lost, who paid, who profited, and where the asset ended up.

Reject generic recycling, factory-tour, graveyard, abandoned-place, or noun-swapped `What Happens to X?` ideas that lack custody, money, a decision fork, and a conclusive destination.

## Current Attack Plan

### Completed Warm-Up Proof

**Where Lost Luggage Goes When Nobody Claims It**

- Role: polished channel warm-up and production proof, not currently considered the strongest breakout premise.
- Runtime: 11 minutes 16.73 seconds.
- Voice: local Qwen using the Adam clone.
- Visual recipe: sourced footage, deterministic motion graphics, Flux Klein documentary images, restrained still motion, and one clear object protagonist.
- Current selected proof: `/Users/joel/AniFactoryData/channels/assetafterlife/weekly_runs/2026-W31-asset-afterlife-lost-luggage-proof-v5/episodes/ep_01/review_samples/audio_mix_fixed_duck_v3/lost_luggage_full_hybrid_proof_adam_qwen_fixed-duck-minus2-v3_visual-lock-exact.mp4`
- QA record: `/Users/joel/AniFactoryData/channels/assetafterlife/weekly_runs/2026-W31-asset-afterlife-lost-luggage-proof-v5/episodes/ep_01/review_samples/audio_mix_fixed_duck_v3/audio_mix_fixed_duck_final_qa.json`

### Leading Banger Candidate

**What Happens to Data Center Servers After a Data Center Shuts Down?**

Why it leads the next-premise discussion:

- Expensive, familiar but inaccessible equipment.
- Strong custody mystery involving operators, lessors, liquidators, data owners, resellers, recyclers, and security vendors.
- Built-in stakes around secure erasure, chain of custody, resale, parts harvesting, and precious-metal recovery.
- Excellent visual range: live data hall, shutdown, drive removal, audit, destruction, auction, refurbishment, and material recovery.
- Strong sponsor adjacency in cloud, cybersecurity, backup, enterprise software, IT asset disposition, and hardware.

This candidate still needs current YouTube competition research and a fully sourced case packet before script approval.

### Original Controlled-Test Slate

1. Where Lost Luggage Goes When Nobody Claims It.
2. What Happens to a Passenger Jet After Its Final Flight?
3. The Five-Year Afterlife of the Costa Concordia.

The slate is no longer assumed to be the final upload order. Lost luggage is the warm-up proof, and the strongest validated banger should lead or immediately follow it. Data-center servers, a passenger jet, a failed grid transformer, a seized superyacht, or another high-value subject may take priority after live packaging research.

## Packaging Contract

Titles explain the entire video in plain language. The title should name the asset and its terminal condition rather than tease vaguely.

Thumbnails use:

- One hero object, or two states of the same object.
- One obvious before-and-after contrast.
- At most one arrow.
- One visibly missing, stripped, broken, seized, or transformed component.
- Two or three words maximum.
- No collage and no presenter face by default.

Useful thumbnail labels:

- `FINAL FLIGHT`
- `NO OWNER`
- `LAST STOP`
- `CUT APART`
- `NEVER SOLD`
- `LEFT BEHIND`
- `WORTH MORE DEAD`
- `WHO OWNS IT?`

The title supplies the complete question. The thumbnail supplies the emotional consequence.

## Episode Structure

Initial target: 10 to 14 minutes.

1. `0:00-0:25` - The death scene: final flight, route, voyage, sale attempt, shutdown, or operating shift.
2. `0:25-2:00` - Why the asset cannot simply disappear: ownership, regulation, hazards, storage, and cost.
3. `2:00-4:30` - The hidden journey begins: transport, inspection, decommissioning, auction, or reclamation.
4. `4:30-7:00` - The value reveal: the component, right, inventory, or material worth unexpected money.
5. `7:00-9:30` - The decision or obstacle: repair versus scrap, resale versus export, liability, certification, or environmental constraint.
6. `9:30-12:00` - Visible transformation.
7. Final minute - Destination, recovered value, loss, and beneficiary.

## Production Profile Preserved

Asset Afterlife uses the normal Goldflow artifact chain through the dedicated `asset_afterlife_v1` content profile. It is a profile, not a separate pipeline fork.

Canonical implementation:

- [docs/content_profiles/asset_afterlife_v1.json](docs/content_profiles/asset_afterlife_v1.json)
- [docs/workflows/asset_afterlife_profile.md](docs/workflows/asset_afterlife_profile.md)
- [scripts/proofs/build-asset-afterlife-full-proof-v1.mjs](scripts/proofs/build-asset-afterlife-full-proof-v1.mjs)

Current production lessons:

- Flux Klein can produce launch-quality documentary reconstructions when prompts emphasize physical plausibility, one subject, and clean composition.
- The strongest result is hybrid: real footage for credibility and motion, deterministic graphics for explanation, and generated images for inaccessible moments.
- Avoid long runs of static AI images. Prefer footage, maps, diagrams, process graphics, and motivated motion.
- Open with motion plus a synchronized sound cue. A static hero image is acceptable only when the internal movement and sound design create immediate progression.
- SFX must be sourced and synchronized to a visible or narrated action. Generic scanner chirps and arbitrary UI beeps are prohibited.
- The continuous score stays at one fixed low level. It must not recover or jump between narration phrases.
- The current profile bakes in the measured `-16.23 dB` under-voice attenuation, preserves the earlier `-1.5 dB` trim, and adds the requested `-2 dB` reduction for an effective `-19.73 dB` score adjustment.
- Short local score accents and intentional SFX may retain authored gain, but they cannot disguise weak visual pacing.
- Adam/Qwen narration is viable. Future scripts should continue improving punctuation, cadence, and sentence length rather than relying on post-TTS speed changes.

## Premise Bank

### Ready Or Near-Ready

- Lost luggage nobody claims.
- Passenger jet after its final flight.
- Named cruise-ship salvage and dismantling case.
- Hard drives after secure destruction.
- Banknotes after a currency is withdrawn.
- ATM after a bank branch closes.
- City bus after fleet retirement.

### Strong Next Research

- Data-center servers after shutdown.
- Failed grid transformer.
- Fire truck after decommissioning.
- Mining haul truck after retirement.
- Offshore oil-rig decommissioning.
- Wind-turbine blades after retirement.
- Telecom tower after a network shutdown.
- Construction crane after a megaproject.
- Satellite after its mission ends.
- Stadium after closure.
- Theme-park ride after closure.
- Unclaimed cargo left at a port.
- Seized superyacht.
- Repossessed excavator or crane.
- Totaled electric-vehicle battery.

### Transportation And Aviation

- Airline fleet after a shutdown.
- Spare jet engine after an airline collapse.
- Private-jet repossession.
- Cargo-aircraft retirement.
- Ferry after its final crossing.
- Cargo-ship retirement.
- Abandoned freighter trapped in port.
- Oil-tanker decommissioning.
- Locomotive retirement.
- School-bus fleet retirement.
- Police car after retirement.
- Rental-car fleet disposal.

### Lost, Seized, And Unclaimed

- Shipping container lost at sea.
- Unclaimed air cargo.
- Seized airport goods.
- Returned e-commerce packages.
- Casino assets after closure.
- Armored cash truck after retirement.

### Industrial And Infrastructure

- Solar panels at end of life.
- Nuclear-plant equipment decommissioning.
- Rocket stage after launch.
- Hospital machinery after replacement.
- Elevator after building closure.
- Airport ground vehicles after fleet retirement.
- Cargo crane after port modernization.
- Amusement-park machinery after permanent closure.

### Case-Only Or Sensitive

- Wrecked-ship salvage and final disposition.
- Aircraft cleanup and disposition after a crash.
- Military-aircraft boneyard.
- Storm-damaged wind turbines.
- Flooded subway cars.
- Burned warehouse inventory.

### Hold Or Reject Until Better Evidence

- Subway car after its last ride: blocked on a current disposition contract and final-destination evidence.
- New cars that never sell: crowded and frequently packaged with misleading claims.
- Shipping containers lost at sea: demand is proven, but the exact noun is heavily copied.
- Generic cruise-ship afterlife: use a named vessel and jurisdiction instead.
- Abandoned storage-unit contents: mature entertainment category with little information moat.
- Generic recycling/factory videos: too easy to noun-swap and too vulnerable to fabricated workflows.

## Research And Factuality Gates

Before any production script is approved:

- Lock jurisdiction and year.
- Build a claim ledger for every number, ownership assertion, legal rule, price, destination, and standard practice.
- Separate universal practice, jurisdiction-specific rules, company claims, one documented case, and illustrative composite narration.
- Prefer primary authorities, official operators, technical standards, contracts, court filings, auction records, and reputable reporting.
- Never depict invented machinery, impossible workflows, fake documents, or unsupported destinations as fact.
- Generated scenes are labeled or understood as reconstructions, not archival evidence.

Remaining market-validation work:

- Complete the formal ten-query YouTube sample and deduplication.
- Rebuild strict previous-ten comparable channel medians for major outliers.
- Classify five comments from each of five strong videos.
- Count direct channels publishing the complete six-element format at least twice monthly.
- Refresh competitor supply, thumbnails, view velocity, and moving totals before approving the next package.
- Validate sponsor fit and realistic RPM using comparable monetized channels.

## Stock And Rights Decision Still Open

The proof used downloaded footage and SFX without establishing the final production licensing stack. Before public production, select a service with usable API access and multi-channel coverage or build a documented source-by-source rights workflow.

Storyblocks Business was identified as a possible multi-channel option because organization coverage can whitelist multiple YouTube channels. No subscription decision has been made. Do not treat proof-source availability as production clearance.

## Resume Checklist

When returning to Asset Afterlife:

1. Do not rebuild the profile or lost-luggage proof.
2. Refresh live YouTube research for the strongest banger candidates.
3. Compare Data Center Servers, Passenger Jet, Grid Transformer, Seized Superyacht, Theme-Park Ride, Satellite, and one wildcard.
4. Approve one exact title and thumbnail concept before commissioning the full source packet.
5. Build the factual claim ledger and named-case evidence.
6. Generate the polished 10-to-14-minute narration externally or through the approved source-script workflow.
7. Run Goldflow with `content_profile: asset_afterlife_v1`.
8. Keep the lost-luggage proof as the visual, pacing, narration, and audio baseline.
9. Decide the licensed footage/SFX provider before the first public upload.
10. Evaluate three materially different uploads before scaling the channel or cloning adjacent explainer channels.

## Decision Snapshot

- **Keep:** Asset Afterlife as the highest-priority factual channel test.
- **Do not scale yet:** The cross-asset audience promise remains conditionally validated.
- **Proof quality:** Strong enough to prepare a launch channel.
- **Warm-up episode:** Lost luggage.
- **Leading next banger:** Data-center server afterlife, pending live validation and sourcing.
- **Benchmark:** Jet Crumbs-level hybrid documentary polish.
- **Pipeline strategy:** One Goldflow pipeline with an Asset Afterlife content profile, not a permanent fork.
- **Visual strategy:** Sourced footage plus graphics plus selective Flux Klein, with fewer static holds.
- **Audio strategy:** Adam/Qwen narration, synchronized SFX only, fixed low score with no gap recovery.
