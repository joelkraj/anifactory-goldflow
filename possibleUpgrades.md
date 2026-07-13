# Possible Goldflow Upgrades

This is a prioritized roadmap for improving quality, speed, and operational reliability. It is intentionally not a production checklist. Each upgrade should be proven in a bounded run before changing the default lane.

## 1. Multimodal Visual Critic

Add a conservative image-aware critic that compares every generated risk cut with its shot manifest, active state constraints, and attached references. It should verify identity/likeness, wardrobe and injury state, visible cast, action geometry, named location, composition, and obvious subject fusion. It should only reject clear failures and route those exact cut IDs to review or regeneration.

Why this matters: structural prompt validation cannot see that a character has drifted, an action is physically wrong, a named person is absent, or a location was replaced by a generic room.

## 2. Empirical Provider Benchmark and Routing

Before full image generation, generate a small representative benchmark set: solo identity, two-character interaction, action geometry, UI-heavy shot, named location, and dense crowd. Track image quality decisions, latency, retry rate, cost, native dimensions, reference adherence, and style consistency. Use the evidence to choose the provider lane per run rather than relying on habit.

Why this matters: ModelsLab, Codex Imagen, GPT Image, and future providers each fail differently. Routing should be earned by measured results.

## 3. TTS Calibration Proof

Create a short, representative TTS calibration stage before full synthesis. Generate several 60-90 second samples covering hook narration, dialogue, system lines, names, numbers, and emotional escalation. Whisper-measure actual WPM, compare ASR against the intended spoken plan, spot-listen, then lock voice model and native speed for the run.

Why this matters: production speed and pronunciation should be selected before an entire episode is synthesized, not repaired afterward.

## 4. Durable Control Plane

Add a lightweight queue/worker dashboard on top of the artifact ledger. It should show active batches, provider concurrency, retry/backoff state, cost-to-date, stage owner, blocked decision, and the exact next valid command. The ledger remains the source of truth; the control plane makes long runs observable without manual file hunting.

Why this matters: a multi-hour production should be resumable and visible even when the desktop session sleeps or a provider stalls.

## 5. Analytics-Driven Editorial Policy

Keep the current file-based YouTube retention ingest path, then add optional API-backed retrieval when access is available. Aggregate multiple published episodes before changing policy. Compare retention against visual job, shot duration, transition behavior, motion behavior, provider, and hook timing. Treat the result as evidence for experiments, not as an automatic rewrite engine.

Why this matters: visual and pacing choices should improve from real audience behavior instead of single-video impressions.

## 6. Selective Image-to-Video Hero Shots

Use image-to-video only for a small number of approved hero beats: a system awakening, a public reversal, a major reveal, or a chapter transition. Keep the current directed still-image motion as the default. Require a bounded quality and cost proof before enabling a new video model.

Why this matters: a few genuinely moving shots can add perceived production value, while broad use risks inconsistency, cost, and delay.

## 7. Better Reference Candidate Selection

For high-value anchors only, generate a small candidate set and use the multimodal critic to select the strongest identity/location/state image. Do not apply this to every prop or one-scene asset. The selection criteria should be explicit: character likeness, correct wardrobe/state, clean background, native landscape framing, and reference usability.

Why this matters: one weak protagonist or primary location reference can poison a large part of an episode.

## 8. Script-to-Visual Counterfactual QA

For the first three minutes and all high-risk turns, have an independent critic answer: "What must the viewer understand from this beat, and does the image show it without narration?" Record the answer alongside the beat. This is stronger than checking whether the prompt technically contains the right nouns.

Why this matters: the pipeline must protect clarity and emotion, not merely asset contracts.

## Recommended Order

1. Multimodal visual critic.
2. Provider benchmark and evidence-based routing.
3. TTS calibration proof.
4. Durable control plane.
5. Analytics-driven editorial experiments.
6. Selective image-to-video hero shots.

## Principles To Preserve

- Keep scripts locked after operator approval.
- Keep transcript-first editorial beats and fact-evidenced state continuity.
- Keep scoped retries and per-cut invalidation.
- Keep provenance, cumulative cost, and immutable batch history.
- Keep image QA selective and meaningful, not a blanket full-episode toll.
- Never let deterministic layers invent creative story content.
- Prove any new default in a bounded, auditable run before broad production use.
