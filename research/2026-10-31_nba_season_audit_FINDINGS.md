# NBA 2026-27 SEASON AUDIT — alerts, agent, mechanical layer (Oct 20 – Oct 30)

**Status:** descriptive audit, not a pre-registered test. No cell here promotes anything. Every number is regenerable from `research/2026-10-31_nba_season_audit.py` against the production db-api (alerts, games, analyses, snapshot histories).

**Instrument:** production tape, 11 slate nights, 80 games with finals, 791 alert rows (775 scored), 9,137 snapshots, 240 Opus calibration analyses. Transfer: exact production surface. Power tags: HIGH 200+ / MED 80–200 / LOW <80.

**Scoring conventions (mirrors post-game-agent):** a row is *correct* when the position team won; exit-class rows (EXIT, TRACKING_INVALIDATED, XGB_INVALIDATED) invert — correct when the position team lost. One row per fire; arcs = one per game-team, terminal = last non-TRACKING pushed alert. AUC = probability a model ranks a random winner above a random loser (0.5 = coin flip). Brier = mean squared error of the stated probability (lower is better). ESPN WP = ESPN's scoreboard+clock win probability, carried on every snapshot — the free baseline every in-house signal has to beat.

---

## VERDICT

1. **The system's headline accuracy is the scoreboard.** Arcs score 87% (n=94, MED) — but 44/45 (98%) when the terminal alert fired with the position team up 9+, and 15/20 (75%) at ≤8. Hold-stream pushes (POSITION_OPEN, TRACKING) win *less* often than ESPN said at the fire moment (77% vs 85%; 74% vs 78%). The structural layer is not adding to the scoreboard on the pushes.
2. **Early-game mechanical signals are noise this season.** At end of Q1: XGB AUC 0.47, MC Cum 0.53 (n=80, MED) vs ESPN 0.70. Conviction DOMINANT in a close game (lead 0–8) wins 57% where ESPN said 72% (n=28, LOW). The floor ≥.65 in close games at end-Q3/Q4 is 58% (n=19, LOW). This is the "cumulative floor anchors stale early data" failure mode, measured live.
3. **The late MC is the one mechanical signal performing at its prior.** Q4 ≤6:00: MC AUC 0.93, 0.92 in close games, MC≥.70 → 95% (n=59). Q4-boundary MC≥.70 → 89% vs prior 92%. Everything earlier is below prior (Q2 60% vs 76; Q3 75% vs 85).
4. **The Opus calibration call is the best in-house forecaster from end-Q2 on** — AUC 0.80/0.85 at end-Q2/end-Q3 vs ESPN 0.76/0.78, XGB 0.71/0.74, MC 0.72/0.81 (n≈80 each, MED); when Opus and ESPN disagree on the favorite, Opus is right 15/22. Its advantage vanishes in close games (end-Q3 close: Opus 0.65 ≈ ESPN 0.69, n=32 LOW). It costs ~6.9k input + ≤2.5k output tokens per call, ~19 calls/night, and is store-only — nothing bets on it.
5. **The agent is a good veto and a mediocre picker.** SUPPRESS: 70/100 would have been wrong (MED). XGB gate: 45/56 would have been wrong (LOW-MED). SEND: 67% correct (n=290) — but see point 1; the pushes mostly ride the scoreboard.
6. **Exit-class pushes mostly arrive after the scoreboard has spoken.** EXIT 95% "correct" (n=20), but 13/20 fired with ESPN already <35% for the position team. TRACKING_INVALIDATED: 20/31 already obvious, the other 11 go 5/11. XGB_INVALIDATED: 8/12 already obvious, the other 4 go 0/4. MC_COLLAPSE: team lost 20/42 (48%) with ESPN at 62% — the stress alert carries no information over the scoreboard, confirming the Oct 23 fine-arena finding (bet-time canary 42%) on live tape.
7. **Dead streams:** VALUE 6/17 (35%); BUY 8-9 pushed, +1pp vs implied; XGB_INVALIDATED 4/12; MC_COLLAPSE 48%. All LOW.
8. **Two instrument faults found:**
   - **NBA price stamps are partly pregame.** 10/55 POSITION_OPEN rows on teams up 9+ carry a plus-money ML on the leader (POR up 26 in Q2 at +136). The Odds API batch returns pregame h2h when books have no in-play market, and the stamp does not distinguish. Every NBA `ml`/`edge`/`implied` field, the BUY `ML > −250` gate and the CANDIDATE tier are running on a mix of live and pregame lines. The flat-ROI figures below are therefore unreliable and are reported only to show the shape.
   - **Nightly scorer exit-list mismatch.** `post-game-agent.mjs` `EXIT_TYPES` names `XGB_THESIS_INVALIDATED`; the poller writes `XGB_INVALIDATED`. BUY arcs ending in invalidation are scored inverted. Season effect: 3 arcs (88% stored vs 87% correct). Small now, wrong by construction.
9. **Cost:** ≈42 pushes/night; ≈74 Opus calls/night (44 alert-agent, 19 calibration, 10 position-update agent, 1 invalidation) plus pregame theses and the nightly; ≈150k input tokens/night on the calibration path alone. 15/79 games had position arcs on both teams.

**What changes: nothing mechanical ships from this doc.** It is the evidence base for the pause decision and for which streams a forward log should keep.

---

## 1. Mechanical layer vs backtest priors

Control-relative: XGB and MC are P(floor team wins). Boundary = first snapshot of the period (≈ previous quarter's end). n=80 games per cut.

| cut | floor≥.65 acc | XGB AUC | MC Cum AUC | ESPN AUC | MC≥.70 acc (prior) | XGB Brier | MC Brier |
|---|---|---|---|---|---|---|---|
| end Q1 | .59 (n=54) | **.474** | .529 | .722 | .60 n=52 (76) | .296 | .339 |
| end Q2 | .75 (n=51) | .714 | .723 | .759 | .75 n=56 (85) | .196 | .218 |
| end Q3 | .86 (n=63) | .761 | .825 | .845 | .89 n=64 (92) | .136 | .136 |
| Q4 ≤6:00 | .91 (n=56) | .851 | **.933** | .922 | **.95** n=59 | .113 | .078 |

Close games only (|margin| ≤ 8 at the cut):

| cut | n | floor≥.65 acc | XGB AUC | MC AUC | MC≥.70 acc |
|---|---|---|---|---|---|
| end Q2 | 41 | .58 (n=19) | .652 | .645 | .59 (n=17) |
| end Q3 | 32 | .58 (n=19) | .651 | .592 | .69 (n=16) |
| Q4 ≤6:00 | 33 | .75 (n=16) | .763 | **.917** | **.92** (n=13) |

Q4 MC-vs-XGB disagreement (prior: MC right 87%): 16 of 160 states, MC right 10/16 (LOW).

**Mechanism.** Early-game XGB/MC are rate models on 12–24 minutes of box score; at end-Q1 the sample is one quarter and the model is fitting noise (an AUC below .5 at n=80 is within noise of ~.55 but nowhere near the .67–.75 prior). ESPN wins early because the scoreboard is the only thing with signal. By Q4 ≤6:00 the possession budget is small and MC's simulation of the remaining game is the right instrument — it is the one place the stack beats the scoreboard, including in close games.

## 2. Opus calibration FWP vs everything else, same moment

Matched to the nearest snapshot within 2 min (n=235 of 240). Control-relative.

| trigger | n | Opus AUC / Brier | ESPN | XGB | MC |
|---|---|---|---|---|---|
| end Q1 | 80 | .692 / .220 | .704 / .218 | .474 / .295 | .534 / .339 |
| end Q2 | 79 | **.804 / .179** | .755 / .201 | .709 / .198 | .717 / .220 |
| end Q3 | 76 | **.851 / .127** | .776 / .195 | .742 / .143 | .813 / .143 |
| close only, end Q3 | 32 | .649 / .242 | .686 / .248 | .651 / .256 | .592 / .275 |

Opus vs ESPN disagree on the favorite: n=22, Opus right 15, ESPN right 7 (LOW).
Opus calibration buckets: said 31% → won 32% (n=19); 49% → 37% (43); 61% → 62% (40); 77% → 75% (52); 94% → 88% (83). Well calibrated above 55%; over-confident in the 40–55 band.

Conviction tier controlled for scoreboard (control team's margin at the trigger):

| tier | trailing | lead 0–8 | lead 9+ |
|---|---|---|---|
| DOMINANT | 0/3 | **57%** n=28 (ESPN 72%) | 90% n=70 (ESPN 83%) |
| STRONG | 44% n=9 | 61% n=23 (ESPN 60%) | 75% n=16 |
| MODEST | 44% n=16 | 50% n=20 (ESPN 62%) | 72% n=18 |
| CONDITIONAL | 45% n=11 | 65% n=17 | 50% n=2 |

**Mechanism.** The Opus call sees the box score, the indicators, the injury/rotation context and the score — it is a synthesizer, and from halftime on it synthesizes better than any single input. Its edge is in games that are *not* close, where it is not bettable. The conviction engine's "DOMINANT = I4+I5 = 100%" prior does not survive a scoreboard control: a DOMINANT team in a close game underperforms a generic leader. The indicator stack is reading early-game variance as structure.

## 3. Every pushed stream

| type | pushed | correct | correct% | stamped-ML ROI (unreliable, see §8) | implied→real |
|---|---|---|---|---|---|
| AUTO_ANALYSIS (position update) | 69 | 58 | 84% | +17.9% | 75→84 |
| POSITION_OPEN | 74 | 56 | 76% | +15.7% | 68→77 |
| TRACKING | 78 | 56 | 72% | +18.4% | 63→74 |
| BWC_EDGE | 43 | 28 | 65% | +13.2% | 57→65 |
| POSITION_SAFE | 33 | 20 | 61% | +9.5% | 55→61 |
| POSITION_RECOVERING | 20 | 10 | 50% | +31.8% | 45→50 |
| BUY | 22 (17 positions) | 11 | 50% | +8.3% / −2.6% by position | 46→47 |
| VALUE | 17 | 6 | **35%** | **−28.4%** | 52→35 |
| EXIT (team lost) | 20 | 19 | 95% | — | — |
| TRACKING_INVALIDATED (team lost) | 31 | 22 | 71% | — | — |
| MC_COLLAPSE (team lost) | 42 | 20 | **48%** | — | — |
| XGB_INVALIDATED (team lost) | 12 | 4 | **33%** | — | — |

Hold streams vs the scoreboard at the fire moment: POSITION_OPEN market-implied 68% · **ESPN 85%** · won 77%; TRACKING 63 · 78 · 74; BWC_EDGE 57 · 64 · 65; POSITION_SAFE 55 · 66 · 61. The positions win less often than the scoreboard predicted. The gap between market-implied and ESPN is the pregame-stamp fault (§8), not a market inefficiency.

POSITION_OPEN by rank (priors CONFIRMED 86 / RECOVERING 73 / LOCKED 92): CONFIRMED 75% (n=68; 10/16 at margin ≤8, 41/52 at >8); RECOVERING 5/6; no LOCKED fires.

## 4. Agent decisions (routeV2Alert path)

| type | SEND | DOWNGRADE | SUPPRESS | XGB_SUPPRESS |
|---|---|---|---|---|
| BUY | 11/22 | – | 0/10 | 6/44 |
| BWC_EDGE | 22/34 | 6/9 | 9/24 | – |
| POSITION_OPEN | 50/66 | 6/8 | – | – |
| POSITION_SAFE | 20/33 | – | 9/17 | 5/12 |
| POSITION_RECOVERING | 10/20 | – | 4/16 | – |
| VALUE | 6/17 | – | 8/28 | – |
| EXIT | 19/20 | – | 0/1 | – |
| THESIS_ALIVE | – | – | 0/4 | – |
| TRACKING | 56/78 | – | – | – |
| **ALL** | **194/290 (67%)** | 12/17 (71%) | **30/100 (30%)** | **11/56 (20%)** |

Read the SUPPRESS and XGB_SUPPRESS columns as "would have been correct had it been sent": 30% and 20% — i.e. the agent's vetoes were right 70% of the time (n=100, MED) and the XGB gate's 80% (n=56, LOW-MED). On BUY specifically the agent is 0-for-10 suppressed = 10 saves, 0 misses.

## 5. Exit-class timing (was the push news?)

| type | n | fired in Q4 (≤6:00) | ESPN WP of position team at fire | already <35% on ESPN | the rest |
|---|---|---|---|---|---|
| EXIT | 20 | 12 (7) | 29% | 13/20 | team lost 6/7 |
| TRACKING_INVALIDATED | 31 | 16 (6) | 31% | 20/31 | 5/11 |
| XGB_INVALIDATED | 12 | 4 (1) | 33% | 8/12 | **0/4** |
| MC_COLLAPSE | 42 | 10 (4) | 62% | 6/42 | 14/36 lost (39%) |

**Mechanism.** EXIT fires on MC Cum <.30 after a hold — by then the team is usually down and the market has repriced; the 7 non-obvious EXITs going 6/7 is the only exit-class cell with information (LOW). MC_COLLAPSE fires with the team still favored (ESPN 62%) and the team then wins 61% — the stress signal is not predicting anything the scoreboard isn't.

## 6. Arcs (nightly convention, invalidation bug corrected)

94 arcs, 82 correct (87%). By terminal: AUTO_ANALYSIS 35/36, TRACKING_INVALIDATED 16/20, POSITION_OPEN 10/10, POSITION_SAFE 7/9, EXIT 6/6, MC_COLLAPSE 3/6, XGB_INVALIDATED 1/3, BWC_EDGE 2/2, POSITION_RECOVERING 2/2. Hold/entry terminals at margin ≤8: 15/20 (75%); at ≥9: 44/45 (98%). Games with arcs on both teams: 15/79. Nightly stored accuracy by night: 100, 100, 100, 86, 90, 83, 78, 67, 79, 80, 92.

## 7. Cost (11 nights)

Opus calls: alert agent 480 (≈44/night), calibration 211 (≈19/night, ~6.9k in + ≤2.5k out each ≈ 150k input tok/night), position-update agent 112 (≈10/night), invalidation narrative 12; plus pregame theses (~1 per game, 2k out each) and the nightly. Pushes ≈42/night.

## 8. Instrument faults

**8a. Pregame price stamps.** `fetchOddsAPIBatch` pulls `/v4/sports/basketball_nba/odds?markets=h2h,...` once per poll; for games without a posted in-play h2h, books return the pregame line and the stamp carries it as if live. Evidence: 10/55 POSITION_OPEN fires on teams up 9+ stamp a plus-money leader (OKC +205 up 13 Q2; POR +136 up 26 Q2; CLE +130 up 20 Q2). Consequences: `ml`, `edge`, `implied` on NBA alerts are a live/pregame mix; the BUY `ML > −250` gate and CANDIDATE tier operate on it; every stamped-ROI figure in this doc is an upper bound at best. The WNBA path uses a separate price join (odds_history, 69/69 verified) and is not implicated. **Fix candidate (spec-first):** compare the stamped line's implied probability to ESPN WP at stamp time and flag |Δ| > 25pp as STALE; or require the bookmaker's `last_update` to be within the game window.

**8b. Nightly scorer.** `EXIT_TYPES = ['EXIT','TRACKING_INVALIDATED','XGB_THESIS_INVALIDATED']` — the third name is never written. One-token fix; 3 arcs this season.

## 9. What this means for the pause decision

- Nothing in the NBA push stream is beating the scoreboard; the one thing beating it (late MC) is not a push and keeps running under `NBA_PAUSED`.
- The agent's vetoes are the most valuable AI call in the chain (70% save rate). The dark log removes them by design — so the dark log measures the mechanical system, which this tape says is weaker than the hybrid. That is the right thing to measure if the question is "is there a mechanical edge worth rebuilding on"; it is the wrong thing if the question is "is the hybrid worth its tokens" (this doc already answers that: not on these streams).
- The Opus calibration call is the strongest in-house forecaster but nothing is wired to it, and its edge lives in unbettable games.
- If anything keeps running, the candidates are: late-MC-only (Q4 ≤6:00, MC≥.70, close games) as a *display* line, and EXIT. Everything else is tokens.

## Retractions / corrections carried by this doc

- "MC_COLLAPSE CLEAN precision 77.6%" — live stream 48% (n=42): the Oct 23 fine-arena correction (bet-time 42%) holds on production tape.
- "XGB exit accuracy 77.2%" — live XGB_INVALIDATED 33% (n=12, LOW): ordering only, but the sign is wrong.
- "POSITION_OPEN CONFIRMED 86%" — live 75% (n=68, LOW-MED), 63% at margin ≤8.
- "DOMINANT = I4+I5 = 100%" — 57% in close games (n=28, LOW).
