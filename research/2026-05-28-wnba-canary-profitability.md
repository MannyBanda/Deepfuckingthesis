# WNBA MC Canary — Signal & Profitability at Scale

**Date:** 2026-05-28
**Author:** Manny + Claude
**Status:** Validated exploratory finding. NOT yet shipped. Odds are MODELED (see caveat).
**Sample:** 576 WNBA games, 6,336 checkpoints (Q2_7.5 → Q4_2.5, 2.5-min spacing), reconstructed from `wnba_backtest.bdl_pbp`.

## Question
Is the MC canary (windowed MC dipping while the control team leads) a profitable BUY signal on the
trailing beneficiary? Can it be made more accurate while preserving plus-money odds? Compared at scale
against the small (4-week, n=36) production sample that suggested +59% ROI unfiltered.

## Method
- Pulled per-checkpoint cumulative box scores via `backtest-wnba?phase=export_checkpoint_xgb` (576 games).
- Reconstructed MC in-sandbox (numpy, 1000 sims) — NOT from prod, NOT from DB. Two flavors:
  - **MC Cum**: forward sim from cumulative possession rates + cumulative pace.
  - **MC windowed (canary)**: forward sim from the box-score DELTA between consecutive checkpoints
    (~2.5-min window ≈ 10-13 possessions). Coarser than prod's 20-possession window — the
    "watered-down" signal we accepted going in.
- MC engine validated: calibration near-perfect (pred 0.25→act 0.25, 0.71→0.71, 0.90→0.90).
- Canary fire = first checkpoint with ctrl leading (margin>0) AND MC windowed < 0.70. Buy = trailing opponent.
- Odds proxy: fit P(win | margin, period) from the 576 games' own outcomes → fair ML; payout shaded 4% for vig.

## Findings

### 1. Raw canary is NOT profitable at scale (small sample was inflated)
- Base collapse rate (buy-team wins) drops 44% (prod n=36) → **32% (n=531)**.
- All canary fires: **-9.6% ROI**.
- Plus-money-only filter alone: **-21.8% ROI** (concentrates into low-prob bets without confirmation).

### 2. MC Cum confirmation is the discriminator — and it replicates at scale
| Strategy | n | Win% | ROI (modeled) |
|---|---|---|---|
| All canary fires | 531 | 32% | -10% |
| +150 only (no confirm) | 323 | 21% | -22% |
| Canary + MC Cum dips <0.50 (next 2 cps) | 101 | 53% | +31% |
| **Canary + ≥+150 + MC Cum<0.50** | 31 | 58% | **+73%** |
| Reject bucket: MC Cum holds ≥0.65 | 329 | 20% | -31% |

- Win-rate separation (53% confirmed / 32% base / 20% rejected) is PURE OUTCOME DATA, no odds dependency,
  n=531 — this is the trustworthy core.
- 62% of all canary fires fall in the reject bucket (MC Cum holds) → 20% buy-team win → strong FADE signal
  (bet the leader to hold).

### 3. Best play respecting the +150 rule
Buy trailing team only when: (a) canary fires, (b) MC Cum dips <~0.50 within 2 checkpoints, (c) price ≥ +150.
→ 58% win, +73% modeled ROI, n=31.

## Caveats (load-bearing)
- **Odds are MODELED, not market.** Fair odds fit from the same outcomes being graded (mild circularity).
  Real WNBA live markets likely SOFTER than fair on deep dogs (thesis) → real edge possibly larger, but
  direction not guaranteed. ROI magnitudes (+31/+73%) carry a real asterisk; win-rate separation does not.
- **Checkpoint MC is coarser than prod** (2.5-min window vs 20-possession). Prod should detect the co-dip
  faster/cleaner → live signal likely beats 53-58%.
- n on the best cut (31) is still modest.

## Next threads (not yet run)
- Tighten co-dip timing at finer resolution.
- Productionize the reject bucket as a "fade the comeback / leader holds" signal (same engine, opposite side).
- Re-validate odds against any captured live ML before sizing real money.

## Artifacts
- `2026-05-28-wnba-canary-mc-checkpoints.csv` — 6,336 checkpoints w/ MC cum + MC windowed (permanent data).
- `2026-05-28-wnba-canary-events.csv` — 531 reconstructed canary fires w/ outcome, co-dip, fair ML.
- `2026-05-28-wnba-canary-mc-engine.py` — MC reconstruction engine.
- `2026-05-28-wnba-canary-ev-analysis.py` — fires, discriminator, odds proxy, EV.
