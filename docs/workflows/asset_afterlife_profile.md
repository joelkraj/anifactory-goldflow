# Asset Afterlife Content Profile

`asset_afterlife_v1` adapts the existing Goldflow artifact chain for sourced factual documentaries without forking the renderer, audio spine, approvals, or publishing workflow.

## Locked Differences

- A factual evidence ledger is mandatory at preflight and is hash-bound into `run_identity.json`.
- Source ingest copies that exact ledger into the episode as `source_evidence_ledger.json`.
- Semantic, editorial-beat, reference, visual-prompt, review, and imagegen stages read the embedded content profile from the run identity.
- Scene prompts must explicitly carry the factual-documentary style contract rather than anime/manhwa language.
- The object is treated as the visual protagonist. Custody, process, value, decision, transformation, and destination beats replace fiction-specific beat jobs.
- Generated visuals are illustrative reconstructions. Exact figures, legal text, labels, and routes belong in deterministic overlays rather than generated image text.

## Evidence Ledger

Use schema `goldflow_factual_evidence_ledger_v1`. Every claim needs a stable `claim_id`, statement, claim type, jurisdiction or scope, and at least one source with URL, title, publisher, and source type. Distinguish universal rules, jurisdiction-specific rules, company-specific processes, documented cases, and illustrative composite narration.

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
