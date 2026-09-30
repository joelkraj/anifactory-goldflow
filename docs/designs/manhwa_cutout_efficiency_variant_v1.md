# Manhwa Cutout Efficiency Variant v1

## Status and Scope

This is a design-only proposal for a future `manhwa_recap_v1` production proof. It is not enabled, does not modify `generated_visuals_v1`, and must not be applied retroactively to an episode whose visual planning has started. Existing and historical run identities remain unchanged.

The proposal borrows only the general production mechanic proven useful in the Sentry-versus-Doom pilot work: reusable transparent character poses, layered editorial composites, and authored compositor movement. It does not copy that proof's characters, assets, choreography, source-footage rules, or story-specific heuristics.

## Goal

Preserve the manhwa lane's visual-change density, including the hard eight-second ceiling and the denser first twenty minutes, while reducing the number of unique Gemini/Flow scene generations and the provider time spent producing them.

The core principle is:

> Visual beat count does not need to equal generated-still count.

A generated background, an approved transparent character pose, a foreground prop, and a graphic insert can support several distinct authored cuts without pretending they are separate generated scenes.

## Hybrid Visual Grammar

Use full generated scene images for beats where novelty, scale, or emotional specificity carries retention:

- the betrayal and title promise;
- first appearances of important characters, locations, wardrobe states, and powers;
- public humiliations, major reversals, status upgrades, wealth reveals, and romance payoffs;
- decisive fight actions, new enemies, new combat abilities, and major environmental destruction;
- close reactions whose expression is central to the story;
- periodic visual resets that restore cinematic scale.

Use local cutout composites for connective beats that need fresh screen activity more than a new illustration:

- dialogue exchanges and reaction counters in an established location;
- phone calls, trading explanations, system decisions, and short causal bridges;
- repeated office, mansion, street, lobby, courtroom, or boardroom coverage;
- crowd reactions, witnesses, status comparisons, and foreground interruptions;
- transitions that can be carried by a pose change, framing change, prop insert, split panel, or graphic overlay.

This must not become a sticker slideshow. Cutouts should enter, cross, turn, scale, or swap poses for an editorial reason. A light or white keyline and a restrained shadow may separate a character from the plate, but the treatment should be selective rather than stamped onto every shot. Full generated frames should regularly reset depth, lighting, environment, and spectacle.

## Reusable Asset Model

Each recurring major character may receive a small approved pose bank tied to exact identity, wardrobe, injury, and power-state hashes. A useful initial target is four to six poses chosen from roles such as:

- neutral or listening;
- confident or socially dominant;
- pointing, refusing, or presenting evidence;
- attacking or defensive;
- shocked, exposed, or frightened;
- defeated, pleading, or turned away.

Pose banks are not turnaround sheets sent as scene-conditioning references. Each usable cutout is a separately approved transparent asset. Do not mirror a cutout when scars, jewelry, clothing closures, injuries, handed props, or power effects are asymmetric.

Background plates receive stable location and state IDs. A changed time of day, damaged room, altered ownership signage, or materially different crowd state is a new state rather than an unrecorded reuse.

Every composite recipe should retain exact hashes and authored values for:

- background and foreground assets;
- character cutout and state IDs;
- layer order, crop, anchor, scale, and opacity;
- outline, shadow, and effect treatment;
- motion path, easing, entrance, hold, and exit timing;
- overlays, props, and transition type.

No arbitrary web image, untracked donor asset, or ad hoc identity substitution enters this route.

## Density and Quality Guardrails

- Keep the existing maximum visual duration: no cut exceeds eight seconds, and the first twenty minutes retain the stricter manhwa retention-ramp targets.
- Give every new character, location, power, major reversal, and status reveal a full generated scene unless an approved proof demonstrates an equally strong composite.
- Do not use more than two consecutive cutout-composite beats without a full-scene image, strong insert, or other meaningful visual reset during the opening retention runway.
- Avoid repeating the same character-pose/background/framing combination within ninety seconds. Reusing one component is acceptable; repeating the whole composition is not.
- Change pose, screen side, shot scale, foreground element, or narrative overlay only when the change matches the spoken beat. Random drift does not count as visual novelty.
- Preserve continuity. Cutout efficiency never excuses wrong wardrobe, vanished injuries, duplicated faces, reversed scars, impossible props, or a power state shown before it is earned.
- Reserve the strongest full-frame images for the thumbnail promise, betrayal, public revenge, combat escalation, wealth/status escalation, and ending payoff.

These are initial proof constraints, not permission for deterministic code to rewrite an approved creative plan merely to hit a ratio.

## Motion and Parallax

Cutout composition and single-still parallax are separate tools.

Clean transparent character assets can move over approved background plates without pretending that a rear plate was reconstructed from a flattened scene. This supports controlled entrances, lateral crosses, scale changes, foreground occlusion, pose swaps, and impact displacement.

Existing generated-still parallax policy remains unchanged. A flattened generated scene still needs accepted raster inspection, a viable foreground mask, a safe reconstructed background, and explicit approval before layered 2.5D motion. Cutout availability is not a parallax waiver.

## Initial Efficiency Hypothesis

A seventy-eight-minute episode averaging about seven seconds per visual beat requires roughly 670 beat changes. The proof should test whether one newly generated scene package can support two or three meaningfully different edited beats through backgrounds, cutouts, inserts, overlays, and selective parallax.

An initial planning hypothesis is 240-320 unique generated scene images for that runtime, approximately a 40-60 percent reduction from one-generation-per-beat production. This is a measurement target, not a promised quota or a reason to weaken visual density. Provider cadence, reference spend, and retry policy remain governed by the existing workflow until the proof supplies retained evidence.

## Required Proof

Test the variant on a new, explicitly designated two-to-three-minute manhwa section after the current production is complete. Produce both:

1. A conventional generated-stills version using the current visual grammar.
2. A hybrid version using the same narration and beat timing with approved cutouts and composites.

Record and compare:

- unique generated images and reference assets;
- provider submissions, failures, and elapsed provider time;
- local extraction/compositing and review time;
- average and maximum visual duration;
- identity, wardrobe, pose, edge, and continuity defects;
- perceived repetition, clarity, spectacle, and pacing from a complete watch;
- any available retention proxy without claiming that a short proof predicts upload analytics.

The variant advances only if it preserves the density ceiling and story comprehension, creates no meaningful identity regression, avoids a visibly cheap cutout rhythm, and produces a material reduction in Imagen demand or total production time.

## Future Integration Boundary

If the proof passes, introduce the behavior through a new explicit versioned workflow or media-policy identity, such as `generated_visuals_cutout_hybrid_v1`. Do not silently alter `generated_visuals_v1` or reinterpret an existing run.

Implementation would require reviewed schemas for pose banks, background states, and composite recipes; hash-bound approvals; a reusable multi-layer compositor; render tests; status routing; cost and timing receipts; and scoped recovery. Extract only general compositor behavior. Never promote proof-specific characters, poses, choreography, or episode assets into shared production logic.
