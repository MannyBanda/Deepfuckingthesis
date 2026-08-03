# NBA Sweet Spot Validation — E1/E2/Tiering/Form (Jul 24, 2026)

**Status:** PRIOR (checkpoint backtest, RS 2025-26). Nothing here is promoted to production.
**Sample:** `nba_snapshot_backtest` export (16,910 rows, 1,235 games) → 1,172 games after joins/gates. Regular season only (BDL `postseason=false` verified on all 1,235). Finals + as-of ledger built from BDL season pull (1,322 games), strictly pre-game, min 4 GP both teams.
**Granularity note:** 3-min checkpoints, NOT production 60s snapshots. Prod-granularity arms (E3 timing, E4 price-vs-line) are designed but NOT run — see "Not run" below.
**Method:** conversion = trailer wins game; one spot-observation per game per checkpoint (no snapshot inflation); Wilson 95% CIs; power labels HIGH ≥200 / MED 80–200 / LOW <80.

---

## E1 — Base signal replicates (HIGH power)

Deficit 1–9, pre-Q4. Independent from-scratch pipeline hit both published anchors.

| Q3_END | conv | n |
|---|---|---|
| worse-team trailer (gap<0) | 22.5% | 302 |
| better-team trailer (gap>0) | 46.5% | 226 |
| gap ≥ .30 | 59.2% | 49 |

Q2_END better-trailers: **53.1%** (n=262) — Q2 > Q3 for conversion. Benchmarks (22% / 47.3%) reproduced.

**Deficit gradient (better-trailers, Q3_END):** 1–3 = 53.8%, 4–6 = 47.8%, 7–9 = 34.4%, 10–15 = 15.7%. The 1–9 band transfers from WNBA; outside it collapses.

**Gap gradient differs from WNBA:** flat ~50–53% across .10/.15/.20; lifts only at **≥.30** (Q2 63.8%, Q3 59.2%). Do NOT port the WNBA .15–.30 concentration — NBA action is big-gap-only.

## E2 — Floor vs gap: wrong frame, real finding

Binary BUY gate (floor ≥.65 + ctrl=trailer) and gap gate are **nearly disjoint populations**: floor gate fires on ~25–30 in-band spots per season vs ~230 for gap (matches prod: 48 BUY games all season). Raw 2×2 "BOTH 68%" is a deficit-selection artifact — floor-ON cell mean deficit 2.0 vs 5.0 OFF; deficit-stratified deltas flip sign at n=3–21. **The binary floor gate adds nothing demonstrable to the gap.**

Continuous trailer-relative floor (MED power): Q3_END tertiles 38.8 → 46.7 → 52.4%; Q2_END 43.8 → 57.0 → 56.2%. Monotone-ish, +12–14pp LOW→HIGH. Sizing-confidence-shaped candidate only (killer-flag pattern: inside tiers, never tier elevation). Needs pre-registered confirmation before any use.

## Tiering screen — ~60 mechanism cuts, one survivor

**Dead or sign-flipped between checkpoints (= noise):** leader 3PT-share, leader FT-share, leader/trailer rim%, lead-decay class (at-peak vs decayed), trailer assist-rate, TO differential, Q2→Q3 deficit compression (compressing trailers convert WORSE, 40.6% vs 52.7% flat — NBA comebacks don't telegraph), trailer-won individual indicators (marginal at Q2, flat at Q3).

**eFG-heat killed a third time:** leader-eFG tertiles 43.5/56.8/58.4 (Q2) vs 52.0/45.3/42.1 (Q3) — opposite signs. Third independent pipeline confirming the null. CLOSED.

**Structural conclusion:** the WNBA→NBA accuracy gap (GAP_BASE ~85% vs ~47%) is league physics — longer games, deeper rotations, stickier leads — not a missing filter. No unsustainable-lead forensics layer exists in NBA box/pbp data at this granularity.

### The headline cell

**Q2_END, gap ≥ .30, deficit ≤ 6 → 71.7% (n=46, CI 57–83). ~46 spots/season (~2/wk).**

Multiplicity defense: this is the intersection of the two gradients E1 validated independently at high n BEFORE the screen (gap monotone to .30+, deficit monotone) — implied, not discovered. Date-split: 76.7% early (n=30) / 62.5% late (n=16), both above base. Same gate at Q3_END: 65.6% (n=32), split 63.6/70.0. Honest forward expectation: **mid-60s**, not 72.

Runner-up cells (gap≥.20+I4, FT-share combos, I3&I4) all either sign-flip at Q3 or are screened interactions — expect shrinkage, not promoted.

## Form variant (L10/L15/net-15, strictly pre-game, min 8 recent GP)

1. **Form is a noisier season gap, not a sharper one.** Form-gap ≥.30: 59.6% (Q2) vs season ≥.30: 63.8%. Underperforms at every band.
2. **Headline cell is form-saturated:** zero rows inside gap≥.30 & deficit≤6 have form-cold trailers — a .30 season gap implies positive form by construction. Cell holds 72.1% (n=43) with the filter, identical without.
3. **Staleness null triangulated (3rd pipeline):** season-better/form-cold trailers convert 55.6%/52.9% — no veto power. Consistent with 2026-07-23 wp-freshness rejection. Roster events (row 545) ≠ form patterns.
4. **RISING-TEAM TRAP (the keeper):** worse season record + better recent form trailer converts **30.2% Q2 / 15.0% Q3** (n=43/40), below the worse-team base. Sign-consistent both checkpoints. Mechanism: the trailer IS the variance — whose-variance check in team-form clothing. **Rule: form can never promote a team into better-trailer eligibility. Season gap defines eligibility.** (Cheap to honor: it's "don't relax the existing gate.")

## Provenance & artifacts

All numbers PRIOR unless noted. Pipeline (sandbox, reproducible): export via `backtest-nba-snapshots?phase=export_xgb` (paged) + BDL `seasons[]=2025` pull → as-of ledger → spot table → cuts. Scripts archived: `research/2026-07-24_nba_ss_pipeline.py` (consolidated). Prod NBA inventory checked and rejected as primary sample: Mar 31–Jun only, 113/337 finalized, March cohort predates XGB/MC, playoff-heavy tail — kept for E3/E4 only.

## Not run (designed, queued)

- **E3 — entry-timing sweep** (prod snapshots only; feeds squeeze thresholds)
- **E4 — price test vs live ML** (prod odds_history; THE gate between "true" and "tradeable" — a 70% prior on −6 halftime dogs may already be priced)
- **E2-deployed** — descriptive read of the 62 actual agent-filtered BUY SENDs (48 games)
- **E6 — killer transfer:** deferred; 5 weeks of prod RS cannot support an as-of scalp ledger

## Pre-registered, before any forward data

If NBA sweet spot ever goes live: candidate A-gate = Q2_END/HALF entry, season gap ≥ .30, deficit 1–6, rising-team veto enforced. Promotion bar: ledger-first stream, n≥30 forward spots, realized within ±5pp of the mid-60s expectation. Continuous trailer-floor and form-net (ngap≥8: 62.9% n=97 MED) are sizing-confidence candidates only, each requiring its own pre-registered confirmation. No tier elevation from any of this.
