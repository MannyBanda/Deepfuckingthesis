# Cross-League Sweet-Spot Portability Scan — T1 FINDINGS
**Date:** 2026-08-14 · **Prereg:** `2026-08-14_crossleague_scan_PREREG.md` (committed 1d83d13, before data contact)
**Instrument:** walker2.py (v2, uniform across all leagues + WNBA) · **Data:** 6,372 games / 13 leagues / 2 seasons each, SR Global Basketball timelines, `research/crossleague/*_states.json.gz`

## VERDICT
**ALL 13 LEAGUES PASS the pre-registered bars** (staircase monotone + better-cell premium ≥ +8pp at n ≥ 40). The quality-gap comeback structure is a general property of basketball, not a WNBA artifact. **Three leagues outrank the WNBA on the matched instrument: Greek A1 (+30.9pp), ABA Liga (+27.5pp), Liga ACB (+22.8pp, HIGH power).** Dispersion hypothesis SUPPORTED but PARTIAL (r ≈ .48; ~¼ of variance).

## RETRACTION (first-class, same session)
The T1 pilot claim that **EuroLeague outranks the WNBA (+14.4 vs the WNBA's historical staircase) is RETRACTED.** It compared a game-weighted EL walk (walker.py v1) against the state-weighted WNBA fine arena over mismatched windows — a counting-rule artifact, same failure class as the deficit-cliff sampling-moment bias. On the common instrument (750–1800s window, identical dedup, identical code path) EuroLeague ranks **11th of 13** with +11.9pp vs WNBA +18.7pp. v1 (walker.py) is retained in-repo for provenance only; walker2.py supersedes it for all claims.

## INSTRUMENT (v2, applied uniformly per tranche discipline)
30s walk, window **750 ≤ t < 1800s** (pre-Q4 both formats; WNBA fine arena floor is 750), deficit 1–9, as-of records (prior same-season completed games only, ≥5 GP both teams), gap = trailer wp − leader wp, cells worse ≤ −.15 / even / better ≥ +.15, rate = trailer-WINS. **Dual construction:** STATE-weighted (every 30s state; production-transfer-correct; game-clustered) and GAME-weighted (first perception per game × trailing team; independent observations; the ranking instrument). True per-state deficit cells (v1's nested "deepest-reached" bands replaced). WNBA fine-arena states re-walked through the identical reducer.

## RANKING (game-weighted premium; state-weighted ordering agrees)
| rank | league | disp | worse/even/better (n) | premium | better power | bettability |
|---|---|---|---|---|---|---|
| 1 | Greek A1 | .207 | 13.1/36.6/**67.5** (83) | **+30.9** | MED | EXPECTED |
| 2 | ABA Liga | .199 | 15.9/39.7/**67.2** (134) | **+27.5** | MED | EXPECTED |
| 3 | Liga ACB | .171 | 19.5/39.6/**62.4** (202) | **+22.8** | **HIGH** | EXPECTED |
| — | **WNBA (fine arena)** | — | 23.4/39.1/57.8 (173) | **+18.7** | MED | live |
| 4 | Turkish BSL | .176 | 23.7/40.0/58.5 (171) | +18.5 | MED | EXPECTED |
| 5 | Israel Super | .191 | 19.3/40.7/58.6 (133) | +17.9 | MED | EXPECTED |
| 6 | Champions League | .221 | 30.0/44.1/59.8 (82) | +15.7 | MED | EXPECTED |
| 7 | Germany BBL | .142 | 26.6/38.5/52.3 (172) | +13.8 | MED | EXPECTED |
| 8 | Italy Serie A | .163 | 26.0/42.1/55.8 (163) | +13.7 | MED | EXPECTED |
| 9 | Eurocup | .182 | 21.7/42.0/55.6 (99) | +13.6 | MED | EXPECTED |
| 10 | Lithuania LKL | .211 | 15.4/42.1/55.1 (49) | +13.0 | **LOW** | UNKNOWN |
| 11 | EuroLeague | .133 | 31.1/39.1/51.0 (198) | +11.9 | MED | **CONFIRMED** |
| 12 | France LNB | .175 | 20.4/42.3/53.1 (147) | +10.8 | MED | EXPECTED |
| 13 | NBL Australia | .145 | 28.0/39.6/50.0 (92) | +10.4 | MED | EXPECTED |

Bettability per prereg amendment: CONFIRMED = seen on PM's book (EuroLeague, Aug 14 screenshot). All others unverifiable until season tip (~late Sep); October logging is gated per-league on PM catalog check.

## BOTH-SEASONS RULE
Game-weighted staircase monotone in **both seasons independently for 12 of 13 leagues → STRUCTURAL tag.** Exception: **Lithuania LKL fails leg 122355 (24/25) on both constructions** and is LOW power — ordering only, no directive language. Champions League fails one *state-weighted* leg but passes both game-weighted legs (ranking instrument) — STRUCTURAL with note.

## DISPERSION HYPOTHESIS
Pearson r (dispersion = SD of final team win%, ≥5 GP; vs game premium) = **.478**; vs state premium = **.449** (n=13 leagues). Direction confirmed — lopsided leagues fit better; balanced EuroLeague near-bottom — but ~¼ of variance. Counterexamples: BCL (highest disp .221, mid-table +15.7), LKL (.211, +13.0 LOW). Something beyond table lopsidedness drives fit; candidate factors (pace, possession value, foul-game dynamics, blowout culture) NOT tested here.

## DEFICIT SHAPE IS LEAGUE-SPECIFIC (state-weighted, gap ≥ .15, true per-state cells)
| league | 1–3 | 4–6 | 7–9 |
|---|---|---|---|
| ABA Liga | 68.9 (859) | 62.8 (639) | **46.1** (358) |
| WNBA | 59.1 (242) | 57.8 (102) | 40.3 (77) |
| Israel Super | 62.9 (780) | 51.8 (593) | **27.5** (491) |
| Lithuania LKL | 67.1 (237) | 27.9 (233) | **15.2** (165) |
| EuroLeague | 54.4 (1205) | 45.0 (1081) | 36.9 (870) |

WNBA's flat-then-break shape is **not universal**; most leagues decay smoothly, and 7–9 conversion ranges 15–46% by league. **SS_STRUCT constants (deficit bands, time decay, comeback curves) CANNOT be ported to any league without independent calibration.**

## WHAT CHANGES
**Nothing.** No engine, copy, sizing, or gate changes. WNBA production untouched. This scan carries **no prices** — it measures comeback frequency, not market mispricing; a fully-priced pattern makes no money. Edge study = separate future prereg, winners only.

## QA / PROVENANCE
Clock QA: coverage 98.9–99.6% across all 26 season-files; clock = cumulative elapsed seconds (period ceilings exact at 599/1199/1799/2399). 2.2% of games missing buzzer-tail events (winners from SR result field, pre-Q4 unaffected). 2 games league-wide with empty tapes (skipped). France LNB 25/26: 38 transient pull errors, cleared on resume, 0 remaining. Feeds chronologically sorted (as-of validity verified). All numbers regenerable: `python3 walker2.py` over committed states.

## NEXT (pending PM)
1. Edge-stage prereg for winners (Greek A1 / ABA / ACB) — requires odds source; The Odds API carries none of the top 3 (verify), bet365 untapeable.
2. October bettability check at season tip (gate for any logging).
3. Optional: factor study on the unexplained ¾ of premium variance.
