# PHASE 0 — windowed-MC trailer BUY at first perception (counts only, no outcomes read)

**Prereg:** `research/2026-10-31_mc_trailer_buy_PREREG.md` (`ac002a2`) · **Instrument A run:** `research/2026-10-31_mc_trailer_buy_replay.mjs` → `research/2026-10-31_mc_trailer_buy_fires.json.gz` (1,000 sims, seed 20261031, `mulberry32(seed+gid)`, 67s) · **Reader:** `research/2026-10-31_mc_trailer_buy_phase0.py` (strips `winner`/`trailer_won`/`final_margin` before reading).

## Coverage
1,221 walk-ok games · 61,050 Q3+ states · 27,058 eligible (deficit 1–9, Q4 ≥ 1:00) · 26,909 trailer evaluations · window unavailable 0 · FGA<5 149 · 222 games with no eligible state (never within 1–9 in the second half).

## Primary stratum — trailer windowed MC ≥ .55, first perception, one row per game
- **n = 895 (73% of games)** · halves **H1 449 / H2 446** → the n ≥ 40/half clause of H1 is met (HIGH).
- Period of first perception: Q3 810 · Q4 85.
- Deficit band: 1–3 **337** · 4–6 **230** · 7–9 **328** (H1: 179/107/163 · H2: 158/123/165).
- Floor holder at fire: trailer holds floor 149 · leader holds 746 (no missing ctrl).
- Control-floor band when the leader holds: < .60 113 · .60–.75 277 · > .75 356.
- Persistence (next state 30s later): persisted 597 · faded 199 · next unavailable 99.
- Timing: mins-left at fire median **22** (p10 12, p90 24) · MC at fire median .797, p90 .994 · window ≈ 21 possessions.
- Proxy cells at fire: median n 1,250, minimum 207; none under 30.

## Secondary — MC ≥ .70 (ordering only)
n = 829 (68%) · H1 421 / H2 408 · Q3 732 / Q4 97 · bands 344/214/271 · persisted 616 / faded 116.

## Instrument facts to carry into Phase 1
1. **First perception is front-loaded at the top of Q3.** p90 of mins-left is 24 — the first Q3 state. The modal fire is "the trailer whose last ~20 possessions (mostly late Q2) project them to win, perceived as Q3 opens." The signal is closer to a halftime read than a mid-Q3 run detector. Phase 1 reports the Q3-open (mins ≥ 23) vs later split as a descriptive cut so this is visible, not hidden.
2. **The windowed sim is extreme.** Median MC at a .55 crossing is .797; .70 fires in 68% of games vs .55 in 73%. The threshold separates little; the population is "any trailer the window favors at all." Bars are unchanged (no threshold search), but the findings must read the signal as broad, not selective.
3. Deficit 7–9 is the second-largest band (328) — the H1 clause that 7–9 must be the lowest-edge band is well powered.

No outcome field has been read. Phase 1 next.
