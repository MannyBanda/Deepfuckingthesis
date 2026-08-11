# PRE-REGISTRATION — Availability-Adjusted Quality Gap ("injury nullification")

**Written:** 2026-08-11, BEFORE any outcome data was cut.
**Trigger:** CHI@SEA Aug 10 — engine fired WATCHLIST on CHI (gap .199) while CHI was
missing 3 rotation players (Diggins/Westbeld/Taylor). Bet lost. The gap is built from
season win%, which was earned by a roster that did not take the floor.
**Question:** does trailing-team availability degrade the locked quality-gap edge, and if
so at what threshold does the alert become a PASS?

---

## Arena

- **Primary:** checkpoint reconstruction, **2024 + 2025** (`wnba_backtest`, cached PBP,
  `backtest-wnba?phase=export_checkpoints`). Same recipe as
  `2026-08-10_spec_cuts_regime.py`.
- **Unit:** per-bucket dedupe — one state per (game_id | leader | timebucket).
- **Band:** margin 1–15 (primary cut also reported at in-band 1–9), periods 2–4,
  both teams ≥12 FGA, both teams ≥10 prior games for win% registration.
- **Transfer check (tagged separately, NEVER pooled):** 2026 prod GAP_BASE ledger.
- **STRUCTURAL RULE (house):** a cut is structural only if it holds in BOTH seasons.
  Sign-flips = regime-contingent, not promoted.

## Absence construction (as-of, no lookahead)

For team T at game date D:

1. `W` = T's last **10** games with date < D. Require ≥5, else drop the state.
2. `mpg[p]` = total minutes by p across W / |W| — **minutes per TEAM game**, absences
   count as 0. (Chosen over minutes-per-game-played because it captures expected
   contribution and self-down-weights chronically absent players.)
3. `rotation` = players with `mpg >= 8.0`. `top5` = 5 highest mpg. `top8` = 8 highest.
4. For game G: p is **OUT** if p ∈ rotation and (no player_stats row in G) OR (minutes == 0).
5. `out_core5` = |OUT ∩ top5|.
6. `out_min_share` = Σ mpg[p ∈ OUT] / 200  (WNBA team-minutes per regulation game).

Bands: `0` | `(0, .10]` | `(.10, .20]` | `>.20`.

## Hypotheses and PRE-SET bars

**H1 — trailer availability degrades conversion.**
Trailer conversion by trailer `out_min_share` band.
**PROMOTE if:** ≥**10pp** absolute drop, band-0 → band->.20; sign-consistent in both
seasons; pooled high-band n ≥ 80.

**H2 — leader availability strengthens the fade.**
**PROMOTE if:** ≥**8pp** lift, band-0 → leader band->.20; sign-consistent both seasons;
pooled high-band n ≥ 80.

**H3 — additivity, not redundancy.**
Within raw-gap strata (<.15 | .15–.30 | >.30), does trailer availability still separate
conversion? **PROMOTE if:** ≥**8pp** clean-vs-any-out separation surviving inside gap
strata. If separation vanishes within strata → **REDUNDANT**: availability is already
carried by the gap; build display warning ONLY, no gap adjustment.
(Precedent: 2026-08-09 delta-eFG was rejected on exactly this test.)

**H4 — the operational PASS rule.**
Rule **R**: trailer `out_core5 >= 2` **OR** trailer `out_min_share >= .25`.
**PROMOTE if:** flagged conversion ≥**10pp** below unflagged; sign-consistent both
seasons; pooled flagged n ≥ 40.
If promoted, R is the **provisional Phase-1 warning bar only**. Hard auto-PASS still
requires forward n ≥ 15 per the ledger-first governance rule.

## Power cutoffs (house)

HIGH 200+ | MED 80–200 | LOW <80. **No directive verbs below n=80.** Per-season cells
below n=40 → direction only, no point estimates quoted as findings.

## Sensitivity runs (reported, never promoted on)

K=6 window; mpg-among-games-played instead of per-team-game; top-8 core instead of top-5.

## Declared confounds and limits (fixed in advance)

1. **Absence ≠ injury.** Rest, DNP-CD, suspension are indistinguishable from box scores.
   Accepted — the engine's blindness is to absence regardless of cause.
2. **No historical live lines for 2024–25.** This measures CONVERSION, not edge vs price.
   A conversion drop already priced by the market is not an edge. This study cannot
   settle that and must not be reported as if it does.
3. **Box-derived absence is post-hoc.** The live injury feed may be later or less
   complete. Findings are a CEILING on deliverable value, not the delivered value.
4. **Selection.** Availability correlates with schedule density/travel; uncontrolled.
5. **Multiplicity.** 4 hypotheses × 2 seasons. Both-seasons rule is the defense.

## Negative-result commitment

If H1 fails, or H3 shows redundancy, the result is logged **NOT PROMOTED without
softening**, and the Phase-1 availability block ships as display-only context or not at
all. A null here is a real outcome: it would mean season win% already embeds absence.
