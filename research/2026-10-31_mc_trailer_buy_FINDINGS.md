# FINDINGS — Windowed-MC trailer BUY at first perception (NBA)

**Prereg:** `research/2026-10-31_mc_trailer_buy_PREREG.md` (`ac002a2`) · **Phase 0:** `cfae7f2` · **Instrument A:** fine NBA arena 2025-26, 1,221 walk-ok games, `research/2026-10-31_mc_trailer_buy_replay.mjs` (production MC sliced by name, 1,000 seeded sims) · **Reader:** `research/2026-10-31_mc_trailer_buy_phase1.py` · every number regenerates from the committed fires file.

---

## VERDICT: H1 NOT PROMOTED

**The trailer whose windowed Monte Carlo first crosses .55 in the second half wins exactly as often as the scoreboard says it should.** Edge **−1.2pp** vs the margin×time fair proxy, **n=895, HIGH, 95% ±3.1**. Both halves fair (H1 +0.8, H2 −3.3). Three of five H1 clauses failed; the two that passed (n, deficit ordering) are the ones that don't carry the claim.

This is the same answer the Oct 23 study gave for the *confirmed* canary moment (42.1% vs 41.9%). The hypothesis was that *first perception* — before confirmation — might be different. It is not, and §H3 shows why: at 30s grain, first perception and confirmation are the same moment.

**The motivating in-sample read is retracted as noise.** The 2026-27 production tape (n=52, contaminated) shows +16.2pp (±13.6) on the arena's own proxy — the proxy and ESPN agree to the decimal, so the instruments are on one ruler. A 2.5-SE draw selected from several exploratory cuts; the HIGH-power instrument says fair.

**What changes:** nothing. Per the pre-committed ladder, *windowed-MC trailer entries* — at any threshold, at first perception or at confirmation, with or without floor conditioning, with or without persistence — join the do-not-revisit list absent a genuinely new hypothesis.

---

## H1 — primary stratum

Definitions: windowed MC = `runMonteCarloSim` on each team's last ~20 possessions' rates (box-diff window, FGA ≥ 5 both sides), control = trailer, so the number is P(trailer wins). Fair = 1 − leader-holds rate in the same period × 2-min bucket × margin bucket over all Q2+ states (min cell n 207). Edge = trailer-WIN − fair.

| cell | n | power | trailer-WIN | fair | edge (±95%) |
|---|---|---|---|---|---|
| **all** | **895** | HIGH | 33.0% | 34.2% | **−1.2 (±3.1)** |
| half H1 (to 2026-01-13) | 449 | HIGH | 35.4 | 34.6 | +0.8 (±4.4) |
| half H2 (from 2026-01-14) | 446 | HIGH | 30.5 | 33.7 | −3.3 (±4.3) |
| deficit 1–3 | 337 | HIGH | 41.5 | 44.6 | −3.1 (±5.3) |
| deficit 4–6 | 230 | HIGH | 35.7 | 31.2 | +4.5 (±6.2) |
| deficit 7–9 | 328 | HIGH | 22.3 | 25.5 | −3.2 (±4.5) |

Clauses: edge ≥ +8pp all — FAIL · H1 — FAIL · H2 — FAIL · n ≥ 40/half — PASS · 7–9 lowest — PASS.

**Secondary (MC ≥ .70, ordering only):** all −0.1 (n=829 HIGH) · H1 +2.1 / H2 −2.3 · bands 1–3 −0.7 / 4–6 **+6.7 (±6.5, n=214)** / 7–9 −4.6. The 4–6 band at .70 is the only HIGH-power cell on the board with a positive point estimate; it is below bar, inside its own interval of zero, and it is the band the contaminated cut flagged (+40pp) — which is exactly the pattern the no-threshold-search rule exists for. Not a candidate.

**Descriptive:** Q3 fires −1.1 (n=810), Q4 −2.4 (n=85) · Q3-open (mins ≥ 23) +2.2 (n=359), 17–23 min −3.4, < 17 −3.5 · MC magnitude at the crossing makes no difference (.55–.70 −2.3 · .70–.90 −2.5 · ≥ .90 +1.5).

## H2 — persistence (report-only)

| next state (30s) | n | trailer-WIN | fair | edge |
|---|---|---|---|---|
| persisted (≥ .55) | 597 HIGH | 33.7 | 32.8 | +0.8 (±3.8) |
| faded | 199 MED | 23.6 | 33.2 | **−9.6 (±5.9)** |
| unavailable | 99 MED | 47.5 | 44.1 | +3.4 |

Persistence is a loss filter, not an edge: a crossing that fades inside 30s loses ~10pp to fair; a crossing that holds is fair. Nothing to build.

## H3 — timing vs the Oct 23 CLEAN (the mechanism test)

462 of 895 primary rows have a same-leader CLEAN in the Oct 23 fires. First perception precedes CLEAN by a **median 0.5 game-minutes** (p10 −9.0, p90 +8.0); **192 of 462 first perceptions come *after* the CLEAN.** The claimed mechanism — the windowed sim sees the run before the market confirms it — does not hold: perception and confirmation are the same event at production grain.

| cell | n | trailer-WIN | fair | edge |
|---|---|---|---|---|
| games with a CLEAN, at first perception | 462 HIGH | 38.7 | 34.0 | +4.7 (±4.4) |
| same games at the CLEAN moment | 462 HIGH | 38.7 | 33.6 | +5.2 (±4.4) |
| first perception ≥ 5 min before CLEAN | 77 LOW | 58.4 | 36.1 | +22.3 (±11.0) |
| within 5 min of CLEAN | 193 MED | 34.7 | 33.1 | +1.6 |
| **no same-leader CLEAN ever** | **433 HIGH** | **26.8** | **34.3** | **−7.5 (±4.2)** |

Read the last two rows together: the fair −1.2 is the average of runs that later get confirmed (+) and runs that never do (−). Which half a given fire is in is **not knowable at the fire** — the +22pp cell conditions on a CLEAN that happens *later*. It is hindsight by construction and is reported only to show where the average comes from. Not a candidate.

## H4 — floor reconciliation (report-only)

| floor at first perception | n | edge |
|---|---|---|
| trailer holds floor (structural-control shape) | 149 MED | +0.7 (±7.9) |
| leader holds, ctrl floor < .60 | 113 MED | −1.3 |
| leader holds, ctrl floor .60–.75 | 277 HIGH | +0.4 (±5.6) |
| leader holds, ctrl floor > .75 | 356 HIGH | −3.2 (±4.7) |

The Oct 23 .60–.75 cell (+6.7pp on canary-CLEAN rows, floor at *trigger*) does not transfer to the first-perception population; the contaminated cut's inversion of it (−13pp, n=13) was noise in the other direction. Floor conditioning does nothing here.

## Transfer check — Instrument B (2026-27 production, contaminated)

n=52 · trailer-WIN 50.0% · arena-proxy fair 33.8% · edge +16.2pp (±13.6) · ESPN fair 33.8% (identical). By band: 1–3 53% vs 44 · 4–6 **75% vs 32** · 7–9 26% vs 26. The proxy is well calibrated against ESPN on live data, which rules out an instrument gap between A and B. The gap is sampling on a cut chosen after looking.

**On the regime question** (early, sloppy regular season → leads collapse): the arena's own early-season half (Oct–Jan 2025-26) is fair at +0.8pp (n=449). The regime story does not rescue the cell.

## Mechanism (why it is fair)

The windowed sim is a run detector: it crosses to the trailer when the last ~20 possessions favored them, which at first perception is usually the trailer closing the first half well (median 22 min left; p90 = the first Q3 state). The market prices runs. Runs that continue win; runs that don't, lose; and the mix — 433 never confirmed vs 462 confirmed — lands on the scoreboard's own number. There is no information in the crossing that the deficit and the clock do not already carry. The only cells that beat fair are the ones that know the future (H3 ≥ 5 min) or the past (H2 faded, negatively).

## Retractions carried by this doc

- Oct 31 exploratory claim "windowed MC trailer first perception +16pp vs ESPN, n=52" — **RETRACTED as noise** (HIGH-power −1.2).
- Oct 31 exploratory claim "deficit 4–6 +40pp" — **RETRACTED** (HIGH-power +4.5, ±6.2).
- Oct 31 exploratory claim "control floor .60–.75 inverted (−13pp)" — **RETRACTED** (HIGH-power +0.4).
- Oct 31 audit framing "late MC Cum is the one signal at its prior" — **CORRECTED** to "late MC Cum agrees with ESPN" (leader MC Cum ≥ .80 in Q4: 81% vs ESPN 83%; MC Cum favors a Q4 trailer in 2/80 games). Not an edge source. Carried into the audit doc.

## Do-not-revisit (per ladder §9)

Windowed-MC trailer entries: any threshold; first perception or confirmation; any deficit band inside 1–9; with or without floor conditioning (trailer-holds or control-floor bands); with or without persistence. The canary family is now closed on both the confirmation moment (Oct 23, HIGH) and the perception moment (this doc, HIGH).
