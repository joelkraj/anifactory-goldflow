# ModelsLab Flux Klein Prompting Procedure

This is the production contract for ModelsLab Flux Klein references and scene cuts. It exists to reduce duplicated hands or weapons, identity bleed, and recurring boss/creature drift without adding a full-episode review toll.

The procedure follows Black Forest Labs' current FLUX.2 guidance: describe a concrete subject, action, style, and context; explain the role of each reference image; and use positive visual construction instead of a separate negative prompt. Klein accepts at most four reference images. See the official [FLUX.2 prompting guide](https://docs.bfl.ai/guides/prompting_guide_flux2), [FLUX.2 model overview](https://docs.bfl.ai/flux_2/flux2_overview), and [Klein fast-generation guide](https://help.bfl.ai/articles/7592221790-how-do-i-generate-quickly-with-flux-2-klein).

## 1. Canonicalize Every Acting Subject

- A person, creature, boss, guardian, construct, summon, or recurring creature system that moves, attacks, reacts, is fought, or is physically contacted is an identity-bearing entity.
- An acting nonhuman must never be stored as a prop. Props are inert objects.
- Give every recurring or signature nonhuman one canonical entity ID, one display name, evidence-backed aliases, and one stable anatomy contract.
- The anatomy contract states one coherent silhouette, story-correct limb count, head/body construction, materials, markings, and the exact attachment point of integrated object-like anatomy.
- Generic collectives such as `ordinary monsters` may remain a group. A distinct actor such as `Bell Guardian`, `Crown Ram`, or `the final guardian` may not.

Semantic reconciliation reports a structural omission when a distinct visible actor is missing from `canonical_entities`. The reference director separately logs any distinct nonhuman actor for which it did not select a standalone identity/anatomy reference. That selection finding is review-only: manually add the reference before approval or explicitly accept text-only continuity.

## 2. Build Clean Conditioning References

Each reference image contains exactly one conditioning concept.

Human identity/state reference:

- Exactly one person on a plain studio background.
- Stable face, hair, age, body type, wardrobe, expression, and materials.
- Both hands relaxed and empty.
- No detachable bow, sword, spear, shield, or carried prop. The scene prompt introduces and owns the current weapon.

Creature or construct identity reference:

- `kind: character_state`
- `conditioning_asset_role: creature_identity`
- `identity_subtype: creature|construct`
- Exactly one canonical nonhuman actor on a plain background.
- One full coherent silhouette with explicit head, face, limb, torso, material, marking, and eye construction.
- Any bell, crown, crystal, wheel, blade, shell, or similar integrated feature is visibly joined at its exact body attachment point. It is not worn, held, floating nearby, or substituted for a different body part.

The first full reveal and every later individually readable depiction attach the approved creature identity ref when the four-slot budget permits. Do not establish a boss from text alone and begin using its reference on the next cut.

## 3. Author the Shot Manifest Before Prose

For every cut:

1. Choose one decisive present-tense instant.
2. List every individually readable person, creature, or construct in `visible_characters` for compatibility.
3. Set the decisive subject, affected/contact counterpart, physical location, foreground action, and screen positions.
4. Keep at most three individually readable foreground actors in a physical-action frame. Preserve additional participants as a subordinate, spatially separate `background_population` group.
5. Bind every held weapon or object to one named owner and one exact hand.
6. Default to one visible weapon instance per wielder. If both hands grip it, state that both hands share the same single weapon. If it was drawn from a sheath or holder, state that the same holder is empty.
7. Describe every readable actor as one coherent body silhouette with the story-correct limb count and spatially separated hands.

Use `shot_manifest.anatomy_contracts` whenever the cut contains an amputation, prosthetic rule, nonstandard limb count, or signature integrated anatomy. Record the identity ref, immutable body fact, expected visible hand count when relevant, missing limb, whether a prosthetic is allowed, and whether this frame must visibly prove the invariant.

Use `shot_manifest.equipment_contracts` for every visible weapon or combat object. Record the named owner, item, exact visible count, hand assignment, holder/sheath state, contact target, and whether any extra instance is allowed.

The provider prompt begins with subject, decisive action or reaction, contact geometry, and current location. Then it gives identity/anatomy anchors, environment, lighting, composition, and concise anime/manhwa style.

## 4. Spend the Four Reference Slots Deliberately

Four is a hard maximum, not a target.

Use this order:

1. `decisive_subject`
2. `contact_counterpart`
3. remaining `readable_identity` references
4. `location_geometry`
5. critical prop, UI, or action/effect language
6. `supporting_reference`

The boss, creature, construct, or contacted target that defines the shot outranks a peripheral human. Mark peripheral cast and optional helpers as `supporting_reference` so they are the first omitted under the cap.

Hardening canonicalizes the selected order once. `shot_manifest.reference_slots`, `reference_requirements`, top-level `reference_slots`, and `required_reference_paths` must describe the same ordered attachment set. Imagegen consumes this hardened order and does not re-rank it.

## 5. Submit a Scene-First Klein Prompt

The submitted string uses this shape:

```text
The Hollow-Bell Boss lunges frame-right through the sunken chamber. One deep hollow bell is integrated into the center of its black-stone chest beneath a separate stone head.

Reference mapping: Image 1 = exact Hollow-Bell Boss anatomy, silhouette, texture, and markings. Image 2 = exact Joey identity and wardrobe. Keep referenced subjects distinct; use the scene prompt for pose, position, action, setting, lighting, and composition.
```

The reference mapping is concise and follows the scene prose. Do not prepend a long paragraph of `Use Image N` instructions, and do not repeat those wrapper sentences inside the authored prompt.

Repeat a creature's compact anatomy anchor materially unchanged in every cut. For example, a hollow-bell boss whose bell is integrated into its chest must remain chest-belled with a separate head; do not alternate among `bell head`, `bell chest`, `stone giant`, and `muscular humanoid`.

## 6. Harden, Review, and Move

- Unusable text, missing or ambiguous required approved identity, corrupt reference paths, and structurally impossible packets remain hard stops.
- Dense Klein action, four-plus foreground actors, and repeated weapon mentions are review-log warnings with `manual_fix_or_accept`.
- Missing structured anatomy/equipment contracts are also review-log warnings. Cuts carrying either contract are written to an advisory image-output review log and contact sheet; this does not stop production or trigger regeneration. If the cut is already mandatory for opening, physical-action, dense-cast, or composition risk, the anatomy/equipment reasons remain visible in that mandatory review row.
- A warning does not trigger automatic prompt regeneration or a full planner retry.
- Manually simplify a risky cut when the fix is obvious: choose one contact instant, reduce individually readable cast, clarify weapon ownership, or replace a peripheral ref with the defining boss/contact ref.
- Generated spelling remains outside this contract.

## 7. Bind and Record the Provider Request

Every image cache identity and metadata record includes the effective ModelsLab request settings:

- endpoint
- model ID
- width and height or provider size
- sample count
- `enhance_prompt`
- guidance scale
- img2img strength
- reference count
- seed, explicitly `null` when none is submitted

The full submitted prompt and its length are retained. The default Klein referenced route is `/api/v6/images/img2img`; the text-only route is `/api/v6/images/text2img`. ModelsLab documents the image-to-image parameters in its [Flux Klein API reference](https://docs.modelslab.com/enterprise-api/flux-klein/img2img).

Changing any effective request setting invalidates the image cache rather than silently reusing an output created under a different contract.

## 8. Diagnose Before Switching Providers

When continuity fails, inspect in this order:

1. Was the subject canonicalized as an actor or incorrectly as a prop?
2. Did it receive one clean approved identity/anatomy reference?
3. Was that reference attached on the first full reveal and every important later cut?
4. Did the four-slot selection keep the decisive boss/contact identity?
5. Did the anatomy anchor remain materially unchanged?
6. Did the prompt ask for more than three readable foreground actors or ambiguous weapon ownership?
7. Do the hardened slot order, submitted reference array, and request metadata match?

Only run a bounded provider/model bakeoff after these contracts pass and the same exact cuts still fail. A missing boss reference or contradictory anatomy wording is not evidence that Klein itself is the wrong default.
