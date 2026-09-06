# Asset Afterlife Content Profile

`asset_afterlife_v1` adapts the `generated_visuals_v1` Goldflow artifact chain for sourced factual documentaries without forking the renderer, audio spine, or production approvals. Read [the documentary guide](../pipelines/documentary.md) and [the generated-visuals operating contract](../pipelines/generated_visuals.md) completely before episode operations. Manhwa source manufacture, fiction/Joey rules, anime style, reaction/RPG graphic quotas, and manhwa packaging formulas do not apply.

New preflight requires explicit `--content-profile asset_afterlife_v1 --media-workflow generated_visuals_v1`. Missing selections are errors. Existing identities retain their recorded profile/provider/scope; identities without a workflow field remain on the legacy generated route. The new workflow contract does not promote the separate lost-luggage hybrid proofs or enable movie/TV source-footage production.

New workflow-locked documentary runs are explicitly blocked at `upload_packaging` until a documentary packaging adapter is implemented. The existing manhwa schema requires betrayal/revenge metadata and must not be treated as a factual-documentary contract. Legacy identities preserve their existing validators and approved artifacts; they are not silently migrated.

## Locked Differences

- A factual evidence ledger is mandatory at preflight and is hash-bound into `run_identity.json`.
- Source ingest copies that exact ledger into the episode as `source_evidence_ledger.json`.
- Semantic, editorial-beat, reference, visual-prompt, review, and imagegen stages read the embedded content profile from the run identity.
- Scene prompts must explicitly carry the factual-documentary style contract rather than anime/manhwa language.
- The object is treated as the visual protagonist. Custody, process, value, decision, transformation, and destination beats replace fiction-specific beat jobs.
- Generated visuals are illustrative reconstructions. Exact figures, legal text, labels, and routes belong in deterministic overlays rather than generated image text.
- Continuous documentary score beds stay narration-forward at one fixed level. The command contract bakes in the measured `-16.23 dB` under-voice attenuation and applies a further `-3.5 dB` operator trim (`--score-bed-level-mode fixed_ducked --score-bed-fixed-duck-db -16.23 --score-bed-trim-db -3.5`), so the bed never recovers between phrases. Short score accents and SFX retain their authored gain.
- Electronic scanner chirps require a visible, story-relevant scan action. Do not use generic UI beeps as unsynchronized retention punctuation.

## Evidence Ledger

Use schema `goldflow_factual_evidence_ledger_v1`. Every claim needs a stable `claim_id`, statement, claim type, jurisdiction or scope, and at least one source with URL, title, publisher, and source type. Distinguish universal rules, jurisdiction-specific rules, company-specific processes, documented cases, and illustrative composite narration.

The validator checks structural requirements and the identity binds exact ledger bytes. It does not prove that linked sources are accurate, current, actually support each claim, or cover every claim in the narration. A reviewer must inspect the sources and factual statements and record the claim-review evidence. Script-hash approval and a passed evidence schema are not substitutes for factual review.

## Flux Klein Proof

A standalone short proof uses a complete short narration as its own source rather than importing timing from a full episode. Lock it with:

```bash
node bin/goldflow.mjs run preflight \
  --channel assetafterlife \
  --series asset-afterlife \
  --week <stable-proof-slug> \
  --episode ep_01 \
  --title "<exact title>" \
  --source <proof-script.md> \
  --content-profile asset_afterlife_v1 \
  --media-workflow generated_visuals_v1 \
  --evidence-ledger <evidence-ledger.json> \
  --image-provider modelslab \
  --image-model flux-klein \
  --reference-model flux-klein \
  --audio-target narrator_only \
  --run-intent proof \
  --proof-scope 0-180 \
  --proof-source-complete true \
  --animation-policy disabled \
  --parallax-policy disabled
```

The proof still stops for exact script-hash approval, reference-plan approval, generated-reference approval, image QA, and final QA. It does not authorize a full episode or any non-Flux visual provider.

## Hybrid Proofs Are Not the Production Route

The existing lost-luggage/Asset Afterlife hybrid proof builders under `scripts/proofs/` and their `review_samples/hybrid_documentary_*` artifacts remain explicitly scoped experiments. Their manual timeline, overlay, audio, or source-media choices are not automatically accepted production inputs. Do not call those builders to bypass the official stage ledger or describe their completion as a completed production episode. Promote desired behavior into reusable code, workflow documentation, fixture tests, and guarded artifacts before scaling; preserve all existing run/provider/voice identities.
