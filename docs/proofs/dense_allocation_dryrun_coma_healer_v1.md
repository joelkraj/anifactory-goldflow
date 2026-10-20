# Dense allocation dry run v1: coma-healer, full episode (planner only)

Status: private proof. No image provider calls and no Fal spend. The source run was read only, and the candidate is **not importable**.

- **Inputs:** 867 beats and the passed reference plan from `2026-W43-coma-healer-fal-panel-v1/ep_01`.
  - The official input gate refused the run because its beat lineage points at the baseline run's `timed_scene_plan.json`, which was modified on 2026-10-20.
  - The proof script (`proofs/dense-allocation-dryrun-coma-healer/review/dryrun.mjs`) therefore read the beats directly. Lineage was not verified.
- **Code:** `authorDenseAllocationChunks` (follow-up 7c), run in 26 whole-scene chunks.
- **Planner calls:** 28 in total.
  - First pass: 26 calls; 21 chunks authored.
  - 5 chunks failed the people cap. The cause was groups such as "Crestwood security personnel" being counted as named people, fixed in `ff78520`.
  - Re-checked under the fixed rule, 3 of the retained answers passed and were kept. Their old records are in `chunks/superseded/`.
  - 2 chunks still genuinely exceeded the caps and were re-requested with 2 calls; both passed.

## Result

| | Today | Gala hand plan | Dense planner (full episode) |
| --- | ---: | ---: | ---: |
| Generations | 658 | 11 (gala chapter) | **214** (192 pages + 22 singles) |
| Beats per generation | 1.3 | 5.09 | **4.05** |
| Scene-art cost at billed rates | $11.58 | — | **≈ $5.4** (192 × $0.0262 + 22 × $0.0187) |

- **Templates:** P4H 52, P5L 44, P2V 37, P3H 37, P3L 20, P6G 1, P4G 1. Zones total 683.
- **Findings:**
  - No blockers.
  - 11 pages need a reference selection: more than 6 candidate references, so prompt planning must choose.
  - 11 pages mix locations; each needs review as a deliberate memory or insert page.

## Reading

- The planner reaches 4.05 beats per image, not 5.
  - It prefers 2–5-zone templates and almost never uses the 6-zone P6G grid.
  - It keeps 22 singles.
- Getting closer to 5 would need P5L/P6G encouraged for dialogue-heavy scenes, or zones that serve more consecutive beats.
- That is a prompt tuning question; it was not attempted here.

## Tuned run: per-scene budgets (2026-10-20, `9b9fdf5`)

The prompt now gives each scene a budget of max(1, round(beats ÷ 5)) generations, 176 for the episode. Rounding up would have allowed 207, which caps the episode near 4.2 beats per image.

It also asks for:
- 5–6-zone templates for dialogue, reaction and investigation runs;
- zones serving 2–3 consecutive beats when the narration stays on one moment;
- almost no singles.

The job is now keyed on the exact prompts. Run: 26 planner calls, all chunks valid first time, no Fal.

| | First run | Tuned run |
| --- | ---: | ---: |
| Generations | 214 (192 pages + 22 singles) | **179 pages, 0 singles** |
| Beats per generation | 4.05 | **4.84** |
| Zones per page | 3.6 | 4.2 |
| Beats per zone | 1.2 | 1.14 |
| Scene-art cost at $0.0262/page | ≈ $5.4 | **≈ $4.7** (vs $11.58 today) |

- **Templates:** P5L 77, P4H 50, P3H 21, P2V 12, P6G 9, P3L 8, P4G 2.
- **Over budget:** 3 scenes went one page over (046, 068, 073). The people cap is the stated reason.
- **Findings:**
  - No blockers.
  - 12 pages need a reference selection.
  - **28 mixed-location pages**, up from 11. These are scenes that move between rooms (e.g. elevator to room 412). Prompt planning must give such a page's shared context both places, and the image proof should check that each zone draws its own place.

The density gain came from fuller pages and dropping singles, not from more beats per drawing, so picture variety is preserved. Candidate: `jobs/71897bf1b52026fb/candidate-182939df5dd7.json`. It is proof-only and not importable.

## R10 re-run (2026-10-20, $0)

`review/dryrun.mjs` was run again from the R10 host code against a copy of the job's cached chunks (`jobs/71897bf1b52026fb/chunks`). The job key (`71897bf1b52026fb`), the candidate (`candidate-182939df5dd7.json`, sha256 `6bb21c12…b7551`) and the report's findings, density and scene budget were byte-for-byte identical, with 0 planner calls (`job_provider_calls` 26, the original run's calls). No Fal or planner spend.

Under R10's automatic import conditions this candidate would **not** import by itself: it is `candidate_ready` with no blocker findings and no failed chunk, but three scenes are over budget (046 4/3, 068 3/2, 073 4/3), so the gates handler writes a triage instead of an import receipt. It remains a proof-only candidate (lineage unverified, see above).

