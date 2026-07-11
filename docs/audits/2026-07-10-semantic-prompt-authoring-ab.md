# Semantic Planning And Prompt Authoring A/B

Date: 2026-07-10

Episode:

`/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/2026-W28-weakest-extra-plot-skill-v1/episodes/ep_01`

Scope: first 300 seconds only. No references, scene images, audio, render, or official production artifacts were regenerated.

Final diagnostic artifacts:

- `diagnostics/visual_planner_ab_lean_editorial_v4/story_fact_ledger.json`
- `diagnostics/visual_planner_ab_lean_editorial_v4/variant_visual_beat_plan.json`
- `diagnostics/visual_planner_ab_lean_editorial_v4/variant_reference_scope_overlay.json`
- `diagnostics/visual_planner_ab_lean_editorial_v4/variant_section_image_prompts.json`
- `diagnostics/visual_planner_ab_lean_editorial_v4/evaluation_metrics.json`
- `diagnostics/visual_planner_ab_lean_editorial_v4/evaluation_samples.md`

## Compared Lanes

### A: Current Production Artifacts

- Existing broad semantic scene plan.
- Existing deterministic/heuristic visual beats.
- Existing production prompt plan.
- 52 cuts in the first five minutes.

### B: Thin Evidence Ledger And LLM Editorial Direction

- Exact timed narration remained the source of truth.
- A factual ledger canonicalized entities, locations, state transitions, and evidence excerpts without camera or prompt direction.
- An LLM editorial director assigned local visual jobs, depiction modes, visible/preview/mentioned entities, action, and composition intent.
- Proven production cut boundaries were preserved after the unconstrained trial showed that timing must remain a hard rail.
- Prompt authoring received thin semantic context and beat-scoped reference candidates.
- An exact-name diagnostic scope overlay simulated the ref-director rescoping that the new beats would require. It did not invent or replace refs.

## Verdict

Lane B is the prompt-quality winner and should become the architectural direction, but it is not ready to become the default until active continuity state and prompt-packet serialization are completed.

The winning division of responsibility is:

`locked script + Whisper -> factual continuity ledger -> LLM editorial beats under timing rails -> ref director -> provider-specific prompt author -> structural harden -> image QA`

Semantic planning should remain, but as evidence and continuity infrastructure rather than a visual director.

## Measured Results

| Metric | Current A | Variant B | Result |
| --- | ---: | ---: | --- |
| First-five-minute cuts | 52 | 52 | Same pacing |
| First 30-second cuts | 9 | 9 | Same hook pacing |
| Average provider prompt words | 152.7 | 129.4 | 15.3% shorter |
| P90 provider prompt words | 211 | 152 | 28.0% shorter |
| Repeated `Name: Name` clauses | 78 | 0 | Removed |
| Manifest characters absent from source beat | 20 | 0 | Removed |
| Top-level/manifest disagreement cuts | 44 | 9 | Substantially reduced |
| Average adjacent prompt Jaccard | 0.3556 | 0.2676 | More visual variety |
| Distinct visual jobs | 8 | 10 | Better editorial range |
| Average attached refs | 1.96 | 1.67 | Leaner, still identity-complete |
| Zero-ref cuts | 1 | 4 | All four were generic group or document inserts |
| Average four-cut author packet | 88,396 chars | 50,416 chars | 43.0% smaller |

## Semantic Findings

The ledger produced 52 evidence-bound atom rows, 12 canonical entities, and 8 distinct physical locations.

It correctly rejected:

- An unsupported semantic claim that Leon physically appeared in the courtyard scene.
- Unstated armor, age, and formal-attire details.
- Carrying rain, mud, or damage into atoms where those physical details were not stated or active.

This is a useful protection against semantic poisoning. Every factual row carries an exact source excerpt and a confidence class.

## Editorial Findings

The first unconstrained editorial pass merged the opening into seven cuts and created an 11.9-second hook hold. That version failed.

The corrected pass preserved all 52 proven cut boundaries while letting the LLM direct each cut. It added an explicit depiction mode so a subject can be:

- Physically present now.
- Visible through a screen or document.
- Visible as a system prediction or hypothetical route preview.
- Visible in a memory or flashback.
- Merely mentioned and kept offscreen.

That distinction materially improved the hook. The variant visibly staged:

- Ink Hounds attacking Joey in the fatal left-route preview.
- Joey reaching Arielle in the right-route preview.
- Leon standing over Joey in the execution preview.

The current lane either omitted those identities or represented them more abstractly.

## Prompt Findings

Beat-scoped candidate packets and binding exact character refs fixed the missing-ref behavior in the final diagnostic. The hook attached:

- Joey and Ink Hounds for the left-route death.
- Joey and Arielle for the rescue preview.
- Joey and Leon for the execution preview.
- Joey plus the system UI for the countdown and deviation beats.

The variant prompts were generally more direct and action-first. Archive document inserts stopped forcing Joey into frames where the page itself was the story object. Carriage and gate action retained named identities and clear contact geometry with less repeated boilerplate.

## Remaining Work Before Promotion

### 1. Active State Projection

The ledger correctly records that Arielle remains pinned under the wheel until the fire-and-wheel rescue frees her. The editorial prompt received atom facts but not the ledger's cumulative transition log. One approach cut therefore described her beside the wheel before the next cut restored the correct trapped state.

Before promotion, project active character/location/possession states onto every beat and pass them as binding `active_state_constraints`.

### 2. Prompt Packet Normalization

The variant cut author packet is 43% smaller, but still averages about 50,416 characters for four cuts. Identity anchors are repeated in the beat row, character-state list, and reference packet.

Normalize each chunk into:

- One entity/state dictionary keyed by ref ID.
- One location dictionary keyed by location ID.
- Small beat rows containing IDs plus only local action and editorial fields.
- One active-provider output schema rather than duplicate neutral/provider fields.

### 3. Remove Duplicate Output Truth

`shot_manifest` should be authoritative. Top-level `visible_subjects`, `primary_subject`, `location`, and `character_state_refs_used` should be derived metadata or removed from LLM output. Their duplication caused most remaining disagreement counts.

### 4. Full-Episode Reconciliation

Long-script fact extraction should use chunk overlap and one compact global reconciliation pass for aliases, location IDs, and state transitions. Independent chunk concatenation is not sufficient.

### 5. Ref Director Consumption

The ref director must consume final editorial beats, including `preview_visible_characters`, before prompt authoring. The diagnostic exact-name scope overlay proved the requirement but is not a replacement for the normal director pass.

## Promotion Recommendation

Promote the architecture after implementing active-state projection and normalized prompt packets, then repeat this no-image diagnostic on one second episode with different story structure. Keep deterministic timing, identity, scope, and schema checks. Let the LLM own visual job, depiction mode, composition, and prompt prose.

