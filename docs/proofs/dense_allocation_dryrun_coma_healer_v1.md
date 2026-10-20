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
