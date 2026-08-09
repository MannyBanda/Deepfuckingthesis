# 2026-08-09 — Study 1: Team-Relative eFG Bands — NOT PROMOTED

**Pre-registered** (chat, PM go, Aug 9): delta = live leader eFG − own as-of season eFG
(shrunk K=6 toward league mean .5175, no lookahead). Cutpoint priors: cold ≤−5 /
neutral −5..+5 / warm +5..+12 / hot >+12. Success bar: delta hot-vs-neutral
separation ≥8pp in powered cells (n≥80) on the operative population (gap ≥ +.15,
pre-Q4), ordering holds OOS. H2 (PM theory): at matched absolute eFG,
high-baseline leaders hold better (trailers convert less).

**Sample:** 767 states / 128 games, 2026 live archive (211 finished games; states
require both teams ≥10 GP as-of, leader ≥5 prior games for baseline, FGA ≥12).
**Deviation from plan:** derived+validated on 2026 only (temporal split 07-15) —
historical 2024-25 checkpoints lack box-line eFG at state time.

## Results

**Operative (gap ≥ +.15, pre-Q4, n=137 — ALL CELLS LOW POWER):**
absolute cold/warm/hot = 35.7 / 63.8 / 69.2; delta cold/neu/warm/hot =
33.3 / 63.6 / 71.4 / 69.2. Delta hot-vs-neutral = **+5.6pp < 8pp bar. FAIL.**
Z-variant no better (warm-peak 76.0, hot 68.9).

**Control (gap < +.15, pre-Q4, n=406 — MED power):** absolute flat
(32.8/28.6/26.4); delta non-monotone zigzag (30.5/26.6/36.1/20.5). No signal.

**H2 — REJECTED at MED power:** within absolute-hot control states (n=201),
high-baseline 26.4% vs low-baseline 26.2% — dead flat. In the operative
population the sign even reverses at n=15/50 (80.0 vs 66.0, LOW, noise).

**OOS ordering (LOW power both halves):** cold<neutral<warm holds; warm peaks
above hot in both halves — ordering note only, no cutpoint claim.

## What stands
1. **Absolute bands stand.** No powered evidence that baseline-relative heat
   discriminates better. F4 definition unchanged.
2. **Gap gate re-confirmed at larger n:** hot leaders vs gap≥.15 trailers → 69%
   conversion; identical heat without gap → 26%. The map's core finding, again.
3. **Cold-leader note (LOW):** operative spots with a cold-shooting leader
   convert weak (~33-36%) — leader ahead WITHOUT shooting = structural lead.
   Existing A/B band gates already exclude these; no change.

## Verdict
NOT PROMOTED. Pre-registration did its job: plausible upgrade, no powered
support, absolute bands keep the gate. Revisit path if desired: rerun on NBA
snapshot backtest (16,910 rows, powered cells exist) before any WNBA re-test.
