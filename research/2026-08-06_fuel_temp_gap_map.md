# 2026-08-06 — FUEL × TEMP × GAP MAP (full-2026 unselected cut)

**Status:** COMPLETE. Research-only; no engine changes proposed or made.
**Motivation:** DAL@WSH Aug 5 (transient-heat leader, gap −.12 as-of, trailer converts) + the standing pool-expansion backlog item: does the transient-collapse effect (§10, winning-profiles cut) survive outside the quality-gap band?
**Data:** 2026 production archive, 199 finished games Jun 11–Aug 5 → **n=178 states**, live ML tape joined 178/178 (poll-aligned odds_history, ≤3 min gap).
**Recipe (v2, amended pre-results, disclosed):** first Q2–Q3 snapshot per (game, trailing side) with score-derived deficit 1–9 and a valid repo-extracted `computeFuelTemp` read (both FGA ≥12); as-of-date records via single-call true dates (§10 date-bug fix), GP ≥10 both; pot = pot_v2 ?? pot; vShare only when snapshot ss_leader_alias matches the score-derived leader (92/178). v1 (one state per game) made the gap ≥.15 cell non-comparable to §10 (n=29 vs 67) by consuming games on whichever side trailed first; v2 samples the actual betting-window surface and is kept as the independence sensitivity.
**Power convention:** all cells LOW (<80); band margins approach MED. Ordering language only below the cutoff.

## Primary — fuel × gap band, with the price test (H4 built in)

edge = conversion − mean de-vig implied from the trailer's live ML at state time.

| Gap band | Fuel | n | conv | market | edge | med ML |
|---|---|---|---|---|---|---|
| **≥ +.15** | TRANSIENT | 36 | **78%** | 64% | **+14pp** | −150 |
| | EARNED | 13 | 38% | 59% | **−21pp** | −138 |
| 0…+.15 | TRANSIENT | 23 | 48% | 48% | −1pp | +136 |
| | EARNED | 13 | 31% | 43% | −12pp | +185 |
| −.15…0 | TRANSIENT | 25 | 36% | 38% | −2pp | +155 |
| | EARNED | 6 | 50% | 44% | +6pp | +20 |
| < −.15 | TRANSIENT | 54 | 24% | 25% | −1pp | +362 |
| | EARNED | 8 | 12% | 26% | −13pp | +330 |

## Hypothesis verdicts

- **H1 (transient effect persists in 0…+.15 and −.15…0) — REJECTED.** Both bands sit at zero edge; conversion tracks the market. The transient-collapse effect is **gap-gated**: it is not "the lead is fake" standalone, it is "the lead is fake AND the trailer is structurally better." DAL@WSH was the 36% of its cell, priced correctly at +155. No pool expansion.
- **H2 (effect dies as gap goes negative) — CONFIRMED, earlier than hypothesized.** Already dead at 0…+.15.
- **H3 (temp is an interaction: warm > cold within transient) — CONFIRMED in the positive band.** ≥+.15 transient: cold 72% → warm 83% → hot 100% (n=5). Fourth independent source for the trailer-temp ordering. Hot-trailer cells elsewhere are single-digit noise (B-band 7/7 flagged as ordering-only curiosity, not actionable).
- **H4 (tradeable test):** the ONLY cells clearing the market are inside the locked band. Everything outside gap ≥.15 the market prices correctly.

## Secondary findings (ordering only, LOW)

- **Channel decomposition, ≥+.15 band:** takeaway 85% (+25pp edge, n=13) and heat+takeaway 83% (+16pp) carry the edge over the market; **heat-only is priced** (64%, −2pp, n=11). The market adjusts for a visibly hot-shooting leader but treats points-off-turnovers as real production. Matches §10's independent pot ≥6 → 86% cut. Doctrinal note extended: of the two transient channels, the takeaway channel is the market-blind one.
- **Deficit:** effect concentrates shallow (≥+.15 transient def ≤6: 82%, +13pp; def 7–9 across negative bands collapses to 7–17%).
- **Earned-lead pass signal:** the ≥+.15 EARNED cell ran **−21pp vs market** — trailing a genuinely earned lead is −EV even for the better team. Consistent with §10 (earned 36%) and the 2026 regime read. Already surfaced by the shipped FUEL read on review cards; no new machinery.

## Sensitivities

- **Engine-fired games excluded (n=124):** ≥+.15 transient attenuates to 62% conv, +2pp edge (n=16). The unselected transient+gap combination is much thinner than the full pool — **the A/B dual gates (leader <.40, heat confirm, band) add real selection value beyond generic fuel+gap.** Echoes §8's context caveat. Anti-loosening evidence.
- **One state per game (independence, n=114):** ≥+.15 transient 72%, +13pp — direction holds.
- **Era:** entire sample is ≥Jun 11 (GP filter), so pot_v2 attribution covers effectively all states.

## Placement (iterate, don't build)

1. **No pool expansion. No new streams.** The quality-gap filter is load-bearing and survived its own stress test — the map's chief value is bounding the regime signal's territory.
2. The earned-lead −21pp and takeaway-channel findings sharpen EXISTING surfaces only (FUEL/TEMP narration + D-12 review copy already render fuel and channel). Any copy change needs PM go-ahead.
3. All of this inherits the **2026 regime label** (§10: mechanism inverted vs 2024–25). Monthly REGIME PULSE remains the watchdog; nothing here is gate-eligible.

**Multiplicity record:** H1–H4 pre-registered in chat before the run; recipe v2 amendment made and disclosed before any outcome cross-tab; temp/channel/deficit splits pre-labeled ordering-only.

*Script: `research/2026-08-06_fuel_temp_gap_map.mjs` (repo-extracted computeFuelTemp; resumable cache; --pull / --odds phases).*
