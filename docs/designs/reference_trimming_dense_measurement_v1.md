# Reference trimming under dense pages: measurement v1 (follow-up 9)

Data: the coma-healer reference plan (124 `standalone_ref` + 3 `manual_review`) against the tuned dense allocation dry run (179 pages, `docs/proofs/dense_allocation_dryrun_coma_healer_v1.md`). No spend.

## What "≥ 3 projected pages" keeps under dense pages

- **78 of 124** standalone refs actually appear on 3 or more pages. That set contains every ref used in 3 or more scenes (56).
- Adding identity-base plates for recurring characters (design §1, basis 2) adds up to 8 more: Elena, the bus driver, Priya, the bank manager, the deputy, plus the Lily, Henry and firefighter plates.
- **Exact rule: about 86 refs, down from 124 (−38).**

## Beat-plan-only proxies (refs must be planned before allocation today)

| Proxy | Kept | Refs on ≥ 3 pages wrongly dropped | Kept unnecessarily |
| --- | ---: | ---: | ---: |
| ≥ 3 uses | 107 | **0** | 29 |
| ≥ 6 uses | 86 | 10 | 18 |
| ≥ 3 scenes or ≥ 8 uses | 74 | 10 | 6 |
| per-scene page estimate (ceil(uses ÷ 5)) ≥ 3 | 68 | 12 | 2 |

The design's "≥ 7 owner uses" proxy was calibrated for pages of about 2.7 zones. With dense pages (4.2 zones), every proxy that trims meaningfully drops 10–12 refs that really span 3 or more pages. Those are mostly wardrobe states and props spread through long scenes, which is where drift costs most.

## Options

1. **Conservative proxy (≥ 3 uses + identity bases), no stage change.**
   - About 107 refs (−17).
   - Saves roughly $0.10 and 17 reference reviews per episode.
2. **Allocation before references.**
   - Run the dense allocation planner (planner calls only) before reference planning, then apply the exact page rule.
   - About 86 refs (−38).
   - Saves roughly $0.23 and 38 reference reviews per episode.
   - It reorders two production stages: the allocation needs only approved beats, but status routing, packets and the reference director contract change. It needs its own reviewed change.
3. **Leave the director's full selection as is.**
   - The page-level 6-reference cap already selects per page.

The money is small next to scene art (about $3.5 per episode now). The real saving is operator review time on 17–38 fewer references.

## Derived-reference promotion (design §3)

Not implemented. It amends the rule in `docs/pipelines/generated_visuals.md` that forbids story cuts as identity references; the amendment is limited to wardrobe, location, prop and UI continuity, always re-anchored on the original identity plate. It needs Joel's explicit approval of that policy before any code. With references kept on every page they appear on, its value is also lower: it mainly helps refs used on exactly 2 pages.
