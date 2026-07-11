# July 3 Production Notes

## Family Scapegoat Sin Ledger

- Run identity is locked to `family-scapegoat-sin-ledger` / `family_scapegoat_sin_ledger_2026_07_03-v1` / `ep_01`.
- Source candidate is `/Users/joel/youtube-niche-research/manhwa-webtoon-recap/review/family_scapegoat_sin_ledger_2026_07_03/family_scapegoat_sin_ledger_upload_candidate_clean.txt`.
- Image lane is `hybrid_codex_refs_opening_risky_modelslab_rest` with `codex_opening_sec: 600`: all refs through Codex, first 10 minutes through Codex, later risky shots through Codex, lower-risk later cuts through ModelsLab.
- Voice is operator-locked to original Joel clone: `joel_owned_narrator_clone`.
- Pace target for this run is lowered around 160 WPM. Actual audio pace accepted at about `159.503 WPM`; do not tempo-normalize this run just to chase the old 195-220 gate.

## Manual Fixes Made

- Replaced three bad Joey references before approval:
  - `char_joey_manhwa_ref`
  - `char_joey_ref`
  - `joey_burden_scar_state`
- Archived bad source/final rasters under the episode review folder and wrote `manual_blocker_triage_reference_generation_ep_01.json`.
- Ref approval note records the manual replacements and current location-ref strategy.

## Pipeline Hardening From This Run

- Derived location refs must stay text-only contracts until a clean seed cut exists.
- Promotion of derived location refs must only use clean environment/location seed cuts.
- Do not promote cuts dominated by named characters, character refs, signature props, UI, action/effect refs, object inserts, portraits, or reaction shots into location anchors.
- If no clean location seed exists, keep the location as prompt-anchor text or generate a standalone environment ref.
- `run status` and `imagegen promote-derived-refs` now share the clean-location-seed selection rule.

## Next Improvements To Consider

- Make voice reports echo the locked narrator voice id from `run_identity.json`; `qwen_generation_plan.json` currently does not make that obvious even when the run identity is correct.
- Add a reference-review summary that flags likely gender/identity drift automatically before approval.
- Add a derived-location promotion report field for rejected candidate cuts and contamination reasons, so agents can see why a location stayed text-only.
- For adult female character refs, author prompts for conventionally attractive, strong manhwa appeal while respecting story role and avoiding sexualized treatment of minors or child/student characters.
- Full visual prompt review on this run reviewed 693 prompts, took about 85 minutes from planned prompts to reviewed prompts, found 12 true blockers, and auto-resolved all 12 in one cut-scoped iteration.
- Full review was useful for this complex episode, but too expensive as a blanket default. Consider a faster default lane: deterministic harden plus blocker-only LLM review for out-of-scope refs, missing visible character refs, location contract mismatch, wrong subject, and severe character staging; then manual agent spot-check first 10 minutes plus major character intros and random later cuts.
- Keep full LLM review for new pipeline changes, new concepts, high-risk fantasy continuity, or episodes with dense multi-character/ref traffic.

## Visual Review Decision Report

- Review completed with status `passed`; unresolved blockers are `0`.
- Initial prompt count and reviewed prompt count were both `693`, so image IDs were preserved.
- Auto-resolve wrote one scoped correction pass under `_visual_resolution` and corrected `12` blocked cuts without rerunning the full visual plan.
- The 12 auto-resolved blockers were: 4 missing location/reference coverage cuts, 6 out-of-scope location-reference cuts, 1 multi-character staging/bleed-risk cut, and 1 missing visible-character state-ref cut.
- The final report kept repaired/soft findings for audit: top categories were character attribute bleed risk, repeated tableaus, vague actions, missing refs, wrong subject, identity blend, wardrobe contradiction, reference pose lock, literalized metaphor, and metadata/overlay misuse.
- Concrete examples caught before imagegen: wrong post-reversal Professor Halven state before the story reversal, location refs from the wrong scene, Joey/Malrec/Victor visible without correct attachable identity refs, and prompts asking the image model to draw overlay text that should be handled by render.
- Recommendation: keep full review for this run type until the new director refs plus beat planner have proven stable across several episodes. For routine proven lanes, add/use a quicker blocker-only review mode and reserve manual agent review for first 10 minutes, major character entrances, major location changes, and a random late-video sample.
- Expected quality loss if full review is skipped on a fresh complex episode: at minimum the known blocker cuts would reach imagegen wrong, and scattered identity/location drift would survive. A blocker-only quick review likely preserves most of the value at materially lower time cost; manual-only review is faster for tiny samples but not reliable enough across hundreds of cuts.

## Harden Diff Audit And Time-Cost Notes

- Harden diff audit artifact: `/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/family_scapegoat_sin_ledger_2026_07_03-v1/episodes/ep_01/harden_diff_audit_ep_01.json`.
- Harden audit result: `passed`. Reviewed prompts and hardened prompts both contain `693` cuts.
- Identity/timing preservation: no `image_id`, order, `scene_id`, `visual_beat_id`, `start_sec`, or `end_sec` drift found.
- Prompt prose mutation: `0` normalized `modelslab_image_prompt` changes and `0` normalized `codex_image_prompt` changes. Harden did not rewrite depicted content.
- Poison scan: no standalone provider-exclusion payloads, no process/meta prompt text, no chatbot hook markers, no thumbnail/CTR/upload copy leakage, and no hard prompt poison detected.
- Post-audit correction: normal prompt prose is creative-author-owned and may use story-faithful absence/refusal/exclusion wording when it protects shot intent. Only standalone provider-exclusion payloads, embedded `Negative prompt:` sections, provider flags such as `--no`, and process/meta leakage are poison.
- Harden reference changes: `45` rows had reference manifest canonicalization, with `45` removed alias/state ids and `44` added base ids. All removed ids had no direct generated target image path, so harden did not discard a real standalone reference image. It canonicalized non-attachable state aliases such as young Joey, prisoner Joey, Adrian watch state, marked-body Joey, and Halven branded-wrist state back to their generated base identity refs while leaving state depiction in the prompt prose/slot purpose.
- Quality risk to fix later: state alias fallback is acceptable here, but it is not ideal. For important one-off states, imagegen/provider prompt assembly should explicitly carry `source_state_ref_id` and `state_contract`, or the ref director should promote that state to a real standalone/generated ref. Otherwise the model sees the base identity image and must obey prose for the state.
- Harden blockers repaired manually before pass: `10` physical-location cuts were missing `shot_manifest.location_ref_id` even though harden listed the exact in-scope pending-derived location contract. Manual repair set only those manifest ids; prompt prose was not changed.

## Production Time Problem

- Operator-observed elapsed production time was already about `6h20m` before scene imagegen began. This is too slow for normal production.
- Full visual review is a major cost center. On this run it reviewed `693` prompts and took about `85 minutes`; it found and auto-resolved `12` true blocked cuts, so it was useful, but it should not remain the blanket default for proven lanes.
- Visual prompt planning is also a major cost center. We need to measure and report visual plan wall time per run, chunk count, chunk concurrency, failed/retried chunks, and prompt count so we can optimize it instead of guessing.
- Decision pressure from this run: if we are already past six hours before imagegen, the review/planning lane is too heavy. We should strongly consider removing full LLM review from the normal happy path and replacing it with deterministic harden first, blocker-only LLM repair for hard failures, and a manual agent spot-check checklist. Full review should become an opt-in high-risk lane.
- Proposed faster default lane after this episode: visual plan -> deterministic harden/check -> blocker-only LLM review for hard failures only -> manual agent spot-check first 10 minutes, major character entrances, major location changes, and a random late-video sample. Reserve full LLM review for new pipeline changes, new story families, dense fantasy continuity, or heavy multi-character/reference episodes.
- Review policy recommendation: keep full review available, but add a `--mode blocker-only` or `--severity blocker` review lane that only processes out-of-scope refs, missing visible-character refs, location contract mismatch, wrong subject, severe scene contradiction, and character staging blockers. This should preserve most quality value while cutting a large amount of review time.
- Visual planning speed recommendation: test `--visual-chunk-concurrency 10-12` and `--visual-review-concurrency 10-12` on stable runs, with provider retry telemetry. Keep scoped retry/resume; never rerun the full visual plan for a few bad cuts.
- Workflow bug from this run: `run status` suggested `imagegen start --seed-derived-refs` for Codex-routed seed cuts, but production Codex scene generation must use built-in Codex imagegen workers and `imagegen import-staged-codex`. Fix run-status so hybrid Codex seed-derived-ref cuts output the staged-worker/import command shape, not the direct `imagegen start` command that imagegen correctly refuses.
## Codex Scene Imagegen Staging Notes

- First Codex seed batch staging folder: `/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/family_scapegoat_sin_ledger_2026_07_03-v1/episodes/ep_01/assets/images/codex_worker_staging/seed_batch_001_cuts_001_060`.
- Six Codex workers produced cuts `001-060`, but cross-worker duplicate hash validation caught five bad copied outputs: `013`, `014`, `028`, `032`, and `035`.
- Root cause evidence: duplicate metadata for those cuts pointed at generated image paths from the wrong worker/cut, so this was staging/copy drift, not the image model intentionally producing identical art.
- Manual repair: archived the duplicate PNGs/sidecars under `duplicate_archive_20260704`, regenerated only the five affected cuts with built-in Codex imagegen, and wrote fresh metadata with `regenerated_reason: cross_worker_duplicate_hash_repair`.
- Validation artifact after repair: `staging_validation_001_060_after_repair.json` reports `60` PNGs, `0` missing, `0` duplicate hashes, and `0` bad files.
- Pipeline improvement: make `imagegen import-staged-codex` refuse staged duplicate hashes by default and require/produce a staging validation report before import. Also require workers to validate against the whole staging folder, not just their own assigned slice.

## Codex Import Progress

- Imported first Codex seed batch `001-060` into `imagegen_report_ep_01.json`; report now has `60` images and `633` remaining.
- Additional manual check caught `ep_01-cut-019` as wrong-source copy drift even after duplicate repair; it was regenerated and staged with `regenerated_reason: cross_worker_wrong_source_repair`. Future validation must include source-worker/cut-range ownership checks plus duplicate hash checks.

## Codex Seed Batch 002 Repair Notes

- Batch `seed_batch_002_derived_refs` initially had `34` staged Codex PNGs and all worker-local checks passed, but folder-level validation caught cross-worker duplicate hashes across `14` cut entries.
- Root cause pattern matched batch 001: bad cuts pointed at generated cache paths owned by a different worker, so the failure was stale/wrong-source copy drift, not intentional model duplication.
- Repaired wrong-source duplicate IDs by regenerating only `ep_01-cut-157`, `159`, `165`, `166`, `167`, `169`, `243`, and `347` with built-in Codex imagegen.
- Also regenerated portrait Codex scene cuts `ep_01-cut-160`, `161`, `163`, `168`, and `241` as 16:9 landscape replacements, because portrait scene cuts cause visible crop/zoom problems in YouTube landscape renders.
- Final batch validation artifact: `/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/family_scapegoat_sin_ledger_2026_07_03-v1/episodes/ep_01/assets/images/codex_worker_staging/seed_batch_002_derived_refs/staging_validation_002_final.json` with status `passed`, `0` duplicate hashes, `0` missing files, `0` SHA mismatches, and `0` non-landscape cuts.
- Pipeline hardening note: Codex worker imports must require folder-level validation across all workers before import: expected IDs, PNG magic, metadata/source SHA match, duplicate SHA detection across the entire staging folder, and landscape dimension check for scene cuts. Worker-local validation alone is not enough.

## Derived Ref Promotion Ledger Drift

- `imagegen promote-derived-refs` promoted `6` derived refs after seed batch 002, but changed `visual_reference_plan.json` / `character_state_refs.json` hashes and pushed `run status` back to `visual_reference_plan` even though no creative plan changed.
- Recovery used metadata-only `visual approve-refs --workflow-bypass true` to restore the ledger. Pipeline fix needed: derived-ref promotion should either update approval/source hashes atomically or `run status` should understand promoted reference paths as an imagegen subflow, not a reason to rerun visual refs/harden.

## Scoped ModelsLab Seed Cut Still Reattempts Codex Refs

- Running `imagegen start --seed-derived-refs true --provider-filter modelslab --cut-ids ep_01-cut-512` generated the one ModelsLab cut and increased `imagegen_report_ep_01.json` to `115` images, but first logged a long series of Codex reference-generation refusals.
- This is wasted time/noise and can confuse status interpretation. Pipeline fix: when `--provider-filter modelslab` and `--cut-ids` are set for seed-derived scene cuts, imagegen should skip already-approved Codex references entirely and operate as cut-only.

## Codex Seed Batch 003 Notes

- Seed batch `003` covered `59` Codex-routed derived-ref seed cuts, with the remaining cut `ep_01-cut-512` routed through ModelsLab.
- Five Codex workers staged all `59` PNGs using stricter per-worker cache rules: source paths had to come from each worker's own Codex cache/tool output, not the global newest cache image.
- Final validation artifact: `/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/family_scapegoat_sin_ledger_2026_07_03-v1/episodes/ep_01/assets/images/codex_worker_staging/seed_batch_003_derived_refs/staging_validation_003_final.json` with status `passed`, `59/59` staged, `0` duplicate hashes, `0` missing metadata/source files, `0` SHA mismatches, and `0` non-landscape scene cuts.

## 2026-07-04 Reference Approval Ledger Recovery
- After Codex seed batch 003 imported successfully, `run status` regressed to `visual_reference_plan` because derived-reference path metadata changed the `visual_reference_plan.json` / `character_state_refs.json` hashes after the previous approval.
- Evidence checked: current `visual_reference_plan.json` status `passed`, 98 targets, 40 required/attachable refs, 0 missing required refs; `character_state_refs.json` status `approved`, 53 refs; `imagegen_report_ep_01.json` image_count 174 / missing 519 with all seed batch 003 IDs present.
- Recovery: ran metadata-only `visual approve-refs --workflow-bypass true` using the existing reference imagegen report. No visual refs, prompts, or harden artifacts were rerun.
- Pipeline improvement: `run status` should distinguish stale approval caused only by derived-ref path promotion from stale approval caused by creative target/content changes, and should suggest metadata-only reapproval rather than `visual refs` rerun when required refs are present and prompt/content hashes are otherwise stable.

## 2026-07-04 Run Status Provider Command Shape Bug
- `goldflow run status` suggested `imagegen promote-derived-refs` without the locked provider. The command defaulted to `modelslab` and blocked because `run_identity.json` locks `hybrid_codex_refs_opening_risky_modelslab_rest`.
- Recovery: rerun the same stage with `--image-provider hybrid_codex_refs_opening_risky_modelslab_rest`, matching run identity. This is not a provider fallback or route change.
- Pipeline improvement: `run status` next command shapes for imagegen/promote-derived-refs must include the locked `--image-provider` for hybrid lanes to avoid false provider mismatch blocks.

## 2026-07-04 Derived Promotion Hash Churn
- `imagegen promote-derived-refs` promoted 8 refs total and reduced unresolved derived refs to 43, but it again changed visual reference artifact hashes and regressed the ledger to `visual_reference_plan`.
- Recovery: ran metadata-only `visual approve-refs --workflow-bypass true` again. This only refreshed approval hashes after derived ref path promotion; it did not rerun visual refs, prompt review, or harden.
- Pipeline improvement: derived-reference promotion should either update a path-only metadata sidecar that does not invalidate creative approvals, or `run status` should treat path-only derived promotions as compatible with existing prompt/harden artifacts.

## 2026-07-04 ModelsLab Filter Hang
- Attempted scoped ModelsLab generation for seed cuts `ep_01-cut-623,624,620` with `--provider-filter modelslab` and locked hybrid provider.
- The command still attempted Codex reference generation first, printed disabled-Codex-reference failures, wrote a failed report snapshot, and then hung without reaching the three scene cuts.
- Recovery: stopped the hung process. Need restore/validate `imagegen_report_ep_01.json` before continuing, then avoid this path until `imagegen start --provider-filter modelslab --cut-ids ...` skips already-approved Codex references entirely.
- Pipeline improvement: for scoped modelslab cut retries, `imagegen start` must not rewrite the main report to failed before scene generation and must not attempt unrelated Codex reference generation.

## 2026-07-04 Image Report Repair
- The hung scoped ModelsLab retry overwrote `imagegen_report_ep_01.json` with a failed stub containing no results.
- Evidence checked: `assets/images` still had 176 generated scene PNGs and 176 sidecar metadata files; the retry produced `ep_01-cut-620` and `ep_01-cut-624` but not `ep_01-cut-623`.
- Recovery: archived the failed stub and rebuilt `imagegen_report_ep_01.json` from existing image files plus sidecar metadata. Repaired report now shows status `partial`, image_count 176, missing_image_count 517.
- Pipeline improvement: imagegen should use atomic report writes or keep a prior-report backup before any scoped retry, so a failed retry cannot erase the successful merged result ledger.
- Immediate operator-agent lesson: for scoped scene-only retries after refs are approved, use `--skip-reference-generation true` with `imagegen start` so the command does not attempt reference refresh. `run status` should include this in retry command shapes once reference approval exists.

## 2026-07-04 Codex Seed Batch 004
- Routed run-status seed set into 57 Codex cuts and 3 ModelsLab cuts. Codex cuts were staged through five built-in Codex workers under `assets/images/codex_worker_staging/seed_batch_004_derived_refs`.
- Full staging validation passed: 57/57 PNGs, matching metadata, landscape dimensions, valid PNG magic, no duplicate SHA, and metadata/file SHA agreement.
- Imported all 57 staged Codex cuts with `imagegen import-staged-codex`; image report advanced to image_count 233, missing_image_count 460.
- ModelsLab side produced `ep_01-cut-620` and `ep_01-cut-624`; `ep_01-cut-623` remains to generate with `--skip-reference-generation true`.
- Generated remaining ModelsLab seed cut `ep_01-cut-623` successfully with `--skip-reference-generation true`; image report advanced to image_count 234.
- The single-cut ModelsLab retry marked the report `passed` for the current batch even though the full episode was incomplete. Rebuilt `imagegen_report_ep_01.json` again from image files so it correctly reports `partial`, image_count 234, missing_image_count 459.
- Pipeline improvement: report status should distinguish `current_batch_status` from full-episode `status`; a successful scoped batch must not mark the episode report passed while cuts are still missing.

## 2026-07-04 Derived Location Ref Manual Triage
- After seed batch 004, `run status` blocked because 39 derived location refs had no candidate_image_ids and no clean environment-only prompt candidates.
- Inspection showed all 39 were location refs with `required_before_imagegen: false`; many were useful text contracts but unsafe to promote from character/action scene cuts.
- Recovery: wrote `manual_blocker_triage_derived_location_refs_ep_01.json` and changed those 39 targets from derive-later to `no_ref_needed` text-only contracts, preserving their `prompt_anchor` and scene scope while removing the impossible derived promotion obligation.
- Quality rationale: generating 39 standalone Codex environment refs mid-production would delay the run heavily; promoting contaminated character/action cuts as location anchors would poison future imagegen. Text-only contracts are the safest speed/quality tradeoff for this run.
- Pipeline improvement: ref director should not assign derive-from-clean-cut to locations unless the visual beat plan has an actual clean environment/establishing candidate, or it should request a standalone environment ref before imagegen for key recurring locations.

## 2026-07-04 ModelsLab Remaining Batch
- Generated the remaining 30 ModelsLab-routed scene cuts with `--skip-reference-generation true --concurrency 15`.
- The CLI again marked the scoped batch report as `passed`; rebuilt the episode-level report from disk so it correctly shows `partial`, image_count 264, missing_image_count 429.

## 2026-07-04 Codex Risky-Shot Scope Override
- The hybrid Codex opening+risky route inflated to hundreds of Codex-routed scene cuts, far beyond the intended "risky shots" footprint. In practice this made imagegen the production bottleneck even after subagent concurrency.
- Batch 005 was assigned 100 Codex cuts but only staged 16 valid PNGs after extended monitoring. Those 16 were validated and imported, bringing the report to image_count 280, missing_image_count 413.
- Operator approved switching all remaining cuts to ModelsLab for speed. Recovery command uses `--image-provider modelslab --confirm-image-provider true --skip-reference-generation true --concurrency 15` and the current missing cut list from the report.
- Pipeline improvement: risky-shot routing needs a hard cap or director budget. Multi-character/risky should mean a small curated set, not every ordinary family/group scene. Add a report showing counts by route before imagegen spend, and require operator confirmation when Codex-routed scene cuts exceed a threshold such as 20-40 or a configured opening window.
- Pipeline improvement: scoped imagegen reports must preserve episode-level status and `missing_image_ids`; batch success should be recorded separately as `current_batch_status`.
- ModelsLab all-remaining retry at concurrency 15 produced many cuts but hit provider queue/rate limits once `current_queue` rose past roughly 16. Stopped the hot batch, cooled down, and retried the same scoped set at concurrency 6 so existing files were reused and missing cuts completed.
- Final imagegen verification: `imagegen_report_ep_01.json` passed with 693/693 results. Direct disk audit found 693/693 expected PNGs, zero duplicate SHA hashes, and zero missing PNG metadata/prompt SHA sidecars.
- Pipeline improvement: ModelsLab concurrency should be adaptive. Start high only when the account queue is empty, but automatically back off on `Rate limit exceeded` / `current_queue` responses instead of letting hundreds of cuts fail in a hot batch.

## 2026-07-04 Final Render And Packaging
- Render completed with `smooth_fast_ken_burns` and continuous narrator-only audio: `/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/family_scapegoat_sin_ledger_2026_07_03-v1/episodes/ep_01/assets/renders/ep_01-53rebirth-goldflow.mp4`.
- Final render duration is `6453.9` sec (`1:47:33.9`), 1920x1080, H.264, yuv420p, 60 fps, AAC stereo. File size is about `2.5G`.
- Final loudness probe: mean volume `-16.1 dB`, max volume `-1.6 dB`.
- Final QA artifact: `/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/family_scapegoat_sin_ledger_2026_07_03-v1/episodes/ep_01/final_qa_ep_01.json`, status `passed_agent_review_with_notes`.
- Contact sheets checked: opening and timeline sheets showed coherent story/location variety; residual risk is aesthetic consistency from the emergency switch to ModelsLab for remaining cuts, not missing assets or render failure.
- Upload package completed: `/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/family_scapegoat_sin_ledger_2026_07_03-v1/episodes/ep_01/upload_packaging_ep_01.md`.
- `goldflow run status` reports current stage `complete`.
