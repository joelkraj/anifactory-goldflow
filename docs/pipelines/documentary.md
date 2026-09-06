# Factual Documentary Guidance

Required for `content_profile: asset_afterlife_v1`, including Asset Afterlife and lost-luggage documentaries. Read this complete guide, [the Asset Afterlife profile workflow](../workflows/asset_afterlife_profile.md), and [the generated-visuals operating contract](generated_visuals.md) before production actions.

## Lane Selection

New runs explicitly use `--content-profile asset_afterlife_v1 --media-workflow generated_visuals_v1`. This retains the shared narration, timing, generated-reference/image, motion, rendering, and approval infrastructure. New workflow-locked documentary runs stop at packaging until a profile-appropriate packaging adapter is implemented; the current manhwa packaging validator is not suitable for factual work. This does not make source-footage production operational and does not change existing provider selections or content-profile JSONs.

Do not use `source manufacture`, manhwa fiction templates, Joey or recurring-fiction cast rules, revenge/betrayal title formulas, `| Manhwa Recap`, anime styling, required reaction bubbles, or compulsory RPG overlays for this lane. Obtain a sourced factual narration candidate, review its claims separately, then lock the exact script through the ordinary approval chain. The documentary profile's visual jobs, style, factuality, audio treatment, and packaging govern instead of manhwa creative defaults.

## Evidence Before Production

- Bind a `goldflow_factual_evidence_ledger_v1` ledger at preflight; source ingest carries the exact ledger into `source_evidence_ledger.json`.
- Every factual number, legal rule, ownership claim, standard-practice claim, and named destination needs a claim ID and supporting source. Record jurisdiction, company, date, or other scope. Do not convert one airline's process or one documented case into a universal rule.
- Keep documented cases, general explanation, and illustrative composite journeys distinct. An invented character, quotation, custody step, logo, price, or outcome is not evidence.
- Automated evidence validation checks the ledger's structure and required fields; hashes bind the recorded bytes. Neither step reads and adjudicates all cited sources, proves that a source supports a claim, proves completeness, or determines legal accuracy. A reviewer must check the actual sources, material claims, scope, and currency before calling the narration fact-checked. Record the review evidence; never relabel structural validation as claim review.
- The approved script remains production-text truth; the evidence ledger and source review establish the factual basis. If a factual correction changes approved prose, preserve the old candidate and invalidate/reapprove affected downstream artifacts through the guarded workflow.

## Documentary Visual and Audio Direction

The object is the visual protagonist. Preserve its appearance and state while showing custody, transport, sorting, inspection, valuation, repair, resale, donation, recycling, or destruction only as supported. Favor one asset, process relationship, or evidence object per frame, with physically plausible materials, geometry, scale, and operations.

Generated visuals are illustrative reconstructions, not archival evidence or a recording of the documented event. Label reconstructions appropriately. Exact figures, legal text, quotations, labels, and routes belong in reviewed deterministic overlays; a correctly spelled generated label is not factual verification. Vary diagrams, maps, evidence/object inserts, process relationships, and before/after states without inventing a sequence to fill visual density.

Narrator-only remains a valid default. When a continuous documentary bed is explicitly selected, keep it fixed and narration-forward: measured `-16.23 dB` attenuation plus the `-3.5 dB` bed trim recorded by the Asset Afterlife command contract. Do not apply manhwa's dense hook SFX counts, sparse-score-drop quotas, or louder retention recipe as documentary defaults. Scanner chirps need a visible, relevant scan action. Provider and audio choices remain identity-locked.

Packaging asks a clear factual question about the asset and its terminal condition. Follow the Asset Afterlife limits—at most two thumbnail subjects, one arrow, three main text words, and no collage—not the manhwa title suffix or betrayal/revenge recipe. This is the intended documentary packaging contract, not a claim that its validator is implemented. New workflow-locked non-manhwa runs report an explicit unsupported-packaging gate and cannot approve or prepare YouTube packages. Never invent betrayal/revenge fields to pass the manhwa schema or bypass this boundary. Historical identities retain their existing validators and approvals without implicit migration; that compatibility does not establish that an old schema enforced documentary editorial rules. A future adapter must retain exact-hash approval and private-first release gates.

## Lost-Luggage Hybrid Proof Boundary

The repository contains Asset Afterlife/lost-luggage hybrid proof builders under `scripts/proofs/` and proof-specific review outputs. Those experiments demonstrate only their explicitly scoped inputs, rendering, overlays, narration, or audio. They are not the registered production artifact chain, do not authorize an unscoped full episode, and do not make documentary source-footage integration available.

Resume an actual episode from `goldflow run status`, not a proof builder or remembered proof result. Promote any desired proof behavior through reviewed reusable code, documentation, fixture tests, and the official guarded artifacts before production use. Existing proof/run identities retain their exact profile, provider, voice, and scope; this documentation split does not migrate them.
