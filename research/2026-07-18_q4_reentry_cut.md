# Q4 Re-Entry After a Pre-Q4 Review Fire (Jul 18, 2026)

**Question (Manny):** If a review call fires pre-Q4, is a Q4 plus-money entry "the same backtested
58% bet at a better price"? Motivating spot: WSH@GS Jul 18 — WATCHLIST fired Q2 9:13 at GS −145;
GS later offered +165 (Q3_END, down 5) and +225 (Q4 5:51, down 3); GS won 74–69.

**Hypothesis:** No — the 58% is conditioned on pre-Q4 entry state; Q4 states are a different,
adversely-selected bet. Counter-hypothesis (Manny): the edge persists and Q4 prices overpay.

**Data:** [BACKTEST] 526-game corpus (2024–25), 2.5-min reconstructed checkpoints
(`wnba_xgb_training` via `export_xgb_training`), joined to `team_game_stats` on stripped bdl id.
As-of walk-forward records, both teams ≥8 GP (sensitivity ≥5 GP: all cells stable ±4pp).
Review-analog fire = gap ≥ .15 AND better team down 1–9 at any checkpoint Q2_7.5→Q3_2.5
(strictly pre-Q3_END). Conversion = better team wins.

## Results

**Population: n=133, base conversion 59.4%** — independently reproduces the tier-spec
WATCHLIST config (58.6%). Construction validated.

**Decomposition by Q4-entry state (state of those same 133 games):**

| State | B leading | tied | down 1–3 | down 4–6 | down 7–9 | down 10+ | still-down 1–9 pooled |
|---|---|---|---|---|---|---|---|
| Q3_END | 90.6% (64) | 66.7% (3) | 40.0% (20) | 42.9% (14) | 25.0% (12) | 10.0% (20) | **37.0% (46)** |
| Q4_7.5 | 85.9% (64) | 70.0% (10) | **64.7% (17)** | 26.7% (15) | 25.0% (8) | 0.0% (19) | 42.5% (40) |
| Q4_5 | 87.3% (71) | 70.0% (10) | **42.9% (14)** | 11.1% (9) | 33.3% (9) | 0.0% (20) | 31.2% (32) |
| Q4_2.5 | 93.5% (77) | 37.5% (8) | 20.0% (10) | 11.1% (9) | 10.0% (10) | 0.0% (19) | **13.8% (29)** |

Breakevens: +150=40.0% · +165=37.7% · +200=33.3% · +225=30.8% · +250=28.6% · +300=25.0%.

## Findings

1. **The 58% does NOT carry into Q4 — selection effect confirmed.** By Q4 start, 48% of review
   games have already recovered (those convert 91%); the still-down-1–9 remainder runs 37%,
   decaying 42.5% → 31% → 14% as Q4 burns. "Same bet at a better price" is quantitatively false:
   the better price exists because the bet got worse.
2. **But Q4 is not uniformly dead — time × deficit structure exists.** Down ≤3 with 5–7.5 min
   left converts 43–65% [LOW n=14–19]. Down 4+ anywhere in Q4: ~11–33%. Final 2.5 min: dead
   across all deficits. Ordering (monotone decay by time; monotone by deficit within state) is
   the reliable read; point estimates are soft.
3. **Price verdict on the motivating spot:** GS +225 at Q4 5:51 down 3 = the Q4_5 d1–3 cell
   (42.9–46.7%) vs 30.8% breakeven → plausibly +EV. The mechanism is NOT signal persistence —
   it's the market over-discounting small deficits in early-mid Q4 within this population.
4. **Q3_END soft cell (incidental):** down 7–9 at Q3_END = 21–25% [LOW n=12–14] — below every
   plus-money breakeven typically offered. Watch item for Q3_END entries at the deep end of the
   band (SEA@IND Jul 17 was d6–8, straddling the 43% / 25% cells and won).

## Candidate rule (pre-registered, ledger-first — NOT live, no code changes)

**Q4_REENTRY:** after a pre-Q4 review fire, a Q4 entry qualifies only if ALL of:
down ≤ 3 · ≥ 5:00 remaining in Q4 · price ≥ +200 (breakeven ≤ 33.3%).
Everything else in Q4: pass. Log qualifying spots (bet or pass) in the nightly ritual;
promotion requires the forward stream to hold ≥ ~45% at n ≥ 15 [pre-registered].

## Amendment 1 (same night — Manny's reframe): deepest-dip conditioning

Manny: "look how many of this season's review/A games were down >4 in Q4 [and won]." Correct —
and it exposes contamination in the per-checkpoint cells: standing-at-checkpoint mixes mid-dip
games with blowout-bound games (≤−10 converts 6.5%, n=31), dragging the down-4+ cells to 11–27%.

**[BACKTEST] conversion by DEEPEST sampled Q4 deficit (same pop, n=133):**
never trailed 96.3% (54) · bottomed −1..−3 61.9% (21) · **bottomed −4..−6 46.7% (15)** ·
**bottomed −7..−9 41.7% (12)** · hit ≤−10 6.5% (31). Of 79 winners, 18% dipped ≤−4 in Q4.

**[PROD] live 2026 tape (11 resolved review/A games):** 5 of 9 winners dipped ≤−4 in Q4
(CHI@DAL −7, SEA@WSH −6, PHX@MIN −8 [A-tier], SEA@IND −8; + WSH@GS −6 resolving Jul 18).
In-band deepest −4..−9: 5/6 converted (POR@CON lost). Live stream is dip-heavier than backtest
(56% vs 18% of winners) — plausible mechanism: killer-leader skew (two-sided variance → violent
swings; dips are the signature, not noise).

**Betting caveat:** the bottom is unobservable at decision time. Standing down 4–6 in Q4 you
cannot distinguish the 44–47% bottomed-here world from the 6.5% blowout waypoint — the
checkpoint conditional remains the mechanical-rule number; bottom-reading is discretionary alpha.

**Second registered stream (LOG-ONLY, no take rule):** Q4_DIP_WATCH — after a pre-Q4 review
fire: down 4–6 with ≥5:00 remaining in Q4. Count conversion forward; Manny's discretionary
takes/passes in this cell logged against it. Promotion discussion at n≥15 [pre-registered].
Q4_REENTRY take-rule unchanged.

## Power & provenance

All Q4 cells LOW (<80) [BACKTEST]. Pooled base MED-HIGH. Sensitivity: GP floor 5 vs 8 stable.
Not yet done: prod price-pairing (live review games' odds_history vs Q4 snapshot states — n≈12
today, revisit at n≥30); interaction with killer flag (cells too thin to cut).
