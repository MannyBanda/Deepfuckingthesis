# EXPLORATORY APPENDIX (post-verdict, contaminated) — touch-the-lead outcome + fire-time variable scan

**Status:** exploratory on the same arena whose outcomes the Phase 1 verdict already read for this population. Nothing here is a finding. It is on record so that any future prereg on these variables discloses this contact. Script: `research/2026-10-31_mc_trailer_buy_exploratory_touch.py` (reads the committed fires file + states; builds a TOUCH base table — trailer leads at any later regulation state — keyed period × 2-min bucket × deficit bucket, same keys as the fair proxy).

## Touch the lead (PM's cash-out outcome) — primary fires, n=895 HIGH
- TOUCH 57.8% vs cell base 59.0% → **−1.2pp (±3.2)**; halves +1.4 / −3.8. Same answer as WIN.
- By deficit: 1–3 → 79.8% vs 78.5 (+1.3) · 4–6 → 55.7% vs 51.2 (+4.4 ±6.4) · 7–9 → 36.6% vs 44.3 (**−7.7 ±5.2**).
- Time from fire to first lead (touchers): median 4.5 game-min (p25 1.5, p75 9.0). **230 of 517 touchers then lost** (44%) — cash-out timing is the whole trade.
- Base touch rates the market already carries: Q3-open deficit 1–3 → 81%; 4–8 → 55%; Q4 8–10 min, 4–8 → 13%.

## Variable scan — 34 fire-time variables × {WIN, TOUCH} × terciles = 204 cells
- Cells with |edge| ≥ 8pp: **1**. Variable-outcome pairs with both-halves agreement ≥ 4pp same sign: 10 of 68 (≈ the chance rate for 34 mostly-noise variables).
- **Paint gap** (trailer cumulative paint pts − leader's) is the only split that is coherent, both-halves, and mechanism-consistent:

| paint gap at fire | n | WIN edge (H1 / H2) | TOUCH edge |
|---|---|---|---|
| ≤ −6 (leader owns the paint) | 309 HIGH | **−8.2** (−8.4 / −7.9) | −5.6 |
| −5 … +1 | 226 HIGH | −1.2 (+3.5 / −7.7) | −4.6 |
| ≥ +2 (trailer owns the paint) | 360 HIGH | +3.5 (+6.1 / +1.4) | +4.7 (±4.9) |

- Filtering out the bad tercile leaves the remainder at WIN +1.7 / TOUCH +1.1 — fair. **The scan finds an avoid-filter, not a winner-picker.**
- Leader cumulative 3P% < .368 (cold; the lead is earned in the paint/defense) → trailer WIN −6.3 (±5.2, n=290); hot leader (> .448) → +1.3. The NBA reading of "fear earned leads": it says *avoid* the structural leader, not *buy* against the hot one.
- Compound, exploratory-on-exploratory (ceiling only, not a candidate): paint gap ≥ +2 AND deficit 1–6 → n=233, WIN +4.8 (±6.4; halves +6.7 / +3.1), **TOUCH +9.1 (±5.3; 78% vs 69%)**.

## If anything is ever pre-registered from this
Hypothesis: MC-favored trailer × paint gap ≥ +2 × deficit 1–6 → TOUCH ≥ +8pp over the cell base, both halves, n ≥ 40/half. **Instrument must be fresh:** the 2025-26 arena is contaminated for this population; the 2024-25 fine arena (same `export_fine` walker, prior season of BDL plays) is the HIGH-power OOS candidate, with the 2026-27 forward tape as transfer. Cash-out mechanics need a price model at the touch moment before any ROI claim; the NBA stale-quote filter remains a prerequisite.
