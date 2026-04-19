# DFT Graduation System — Production Replay Findings

**Data sources:** 1,230 full-season games (6-min checkpoints) · 476 close games (margin ≤ 8) · 34 production replays (60s resolution) · 8 close production replays

**Date:** April 19, 2026

---

## 1. Graduation Timing — When Does It Happen?

95% of first BWC fires are tier C at Q1_6 — just a team with lead ≥ 2 and floor ≥ 0.50. B arrives early but means almost nothing at that point. A is the real graduation event.

| Milestone | Full Season (checkpoint) | Prod Replay (60s) |
|---|---|---|
| First BWC fire | Q1_6 (73% of games) | Median Q1 9:55 (~2 min in) |
| First B | Q1_END (biggest cluster, n=404) | Median Q1 3:28 (~8.5 min) |
| First A | Q2_END (biggest cluster, n=296) | Median Q2 4:00 (~20 min) |

B is not a graduation — it's a co-arrival with first BWC eligibility. The median time from first BWC fire to B is 333 seconds (5.5 minutes) in production replay, and 24.2% graduate instantly (within one snapshot). A is the real graduation: median 17.75 minutes after first fire, zero instant graduations.

---

## 2. The Anchor Question — First to Graduate

**"Did the first team to graduate win?"**

This is the POSITION OPEN anchor question, and the answer depends entirely on whether you're looking at all games or close games.

### Full Season (n=1,230)

| Signal | n | Win Rate |
|---|---|---|
| First to B | 1,101 | **79.7%** |
| First to A | 732 | **93.4%** |
| Only one team reached B | 1,014 | **85.8%** |
| Both teams reached B | 87 | **8.0%** (first to B) |

First-to-A is near-lock territory. When only one team graduates to B, it's 85.8%. But when both teams reach B, the first to get there wins just 8% — the second team's graduation overtakes. This means graduation itself is the signal, not being first.

### Close Games (n=476)

| Signal | n | Win Rate |
|---|---|---|
| First to B | 384 | **62.2%** |
| First to A | 155 | **74.2%** |
| Only one team reached B | 356 | **65.4%** |
| Both teams reached B | 28 | **21.4%** (first to B) |

Everything compresses. First-to-B is barely above coin flip. First-to-A drops 19 points from full season. The "both graduated" dynamic holds — first to B still loses most of the time.

### First-B Win Rate by Checkpoint (close games)

| Checkpoint | n | First-B Wins |
|---|---|---|
| Q1_END | 141 | 52.5% |
| Q2_6 | 66 | 60.6% |
| Q2_END | 58 | 62.1% |
| Q3_6 | 54 | 66.7% |
| Q3_END | 24 | 79.2% |
| Q4_6 | 29 | 75.9% |
| Q4_END | 12 | 100% |

The signal doesn't become reliable until Q3_6 in close games (66.7%). Q1_END is a coin flip. POSITION OPEN should not fire on B-graduation before Q3 in close-game profiles.

---

## 3. Winner Backtrace — How Winners Actually Got There

Starting from winners and tracing backward reveals a completely different picture for close games vs blowouts.

### Full Season — 1,230 Winners

| Path | n | % of Winners |
|---|---|---|
| Graduated to A | 685 | 55.7% |
| Graduated to B only | 272 | 22.1% |
| Stayed C | 217 | 17.6% |
| Never BWC-eligible | 56 | 4.6% |

77.8% of winners graduated to B+. The typical winner follows C→A (43.3%, n=533). 64.6% were the first BWC team. 59.1% were wire-to-wire. The graduation system captures most winners in blowouts.

### Close Games — 476 Winners

| Path | n | % of Winners |
|---|---|---|
| Graduated to A | 115 | 24.2% |
| Graduated to B only | 146 | 30.7% |
| Stayed C | 160 | 33.6% |
| Never BWC-eligible | 55 | 11.6% |

**45.2% of close-game winners never graduated.** One third stayed C, one in nine were never even BWC-eligible. The graduation system is blind to nearly half the winners in close games.

Only 51.9% of close-game winners were the first BWC team (coin flip). 47.9% took over control from the other team. Wire-to-wire drops to 40.5%.

### Where Winners Graduate (close games)

Winners who reached B are spread across checkpoints: Q1_END (74), Q2_6 (40), Q2_END (37), Q3_6 (37), Q3_END (23), Q4_6 (29), Q4_END (21). No dominant cluster.

Winners who reached A cluster at Q2_END (40) and Q3_END (27), but with much smaller n than full season.

---

## 4. Floor Quality — What Metric Separates Winners?

### Mean Floor Is the Gate

Mean floor across BWC-eligible checkpoints shows the clearest separation:

**Full season:**

| Mean Floor | n | Win Rate |
|---|---|---|
| 0.50–0.59 | 27 | 40.7% |
| 0.60–0.69 | 284 | 52.1% |
| 0.70–0.79 | 478 | 57.5% |
| 0.80–0.89 | 333 | **79.9%** |
| 0.90+ | 93 | **93.5%** |

Hard cliff at 0.80. Below is coin-flip territory, above is strong signal.

**Close games:**

| Mean Floor | n | Win Rate |
|---|---|---|
| 0.50–0.59 | 18 | 22.2% |
| 0.60–0.69 | 167 | 49.1% |
| 0.70–0.79 | 203 | 52.2% |
| 0.80–0.89 | 68 | **66.2%** |
| 0.90+ | 7 | 71.4% |

Cliff is softer but still present at 0.80 (66.2% vs 52.2%).

### Min Floor Shows the Collapse Risk

**Full season:** Min floor ≥ 0.70 across checkpoints wins 86.8% (n=258). Below 0.60 is 53.2% (n=532).

**Close games:** Min floor ≥ 0.70 wins 66.7% (n=57). Below 0.60 is 48.4% (n=252).

### Variance and Spread Are NOT Useful Gates

Variance (stddev) across checkpoints shows no meaningful separation: 47–68% across all buckets in full season, 31–65% in close. Mean-min spread is similarly flat. These are noise, not signal.

---

## 5. 60-Second Resolution Insights

The production replay (34 games) confirmed several things the checkpoint data couldn't test:

**Oscillation is noise.** 2.94 tier bounces per game at 60s resolution. Games with 2+ oscillations won 79.2% — more oscillation correlates with winning, not losing. This is because longer competitive engagement (more snapshots as ctrl) produces more oscillation mechanically.

**Checkpoints are the right cadence.** The oscillation finding proves that 60s resolution is too noisy for tier classification. Checkpoints at 5-6 minute intervals are a natural low-pass filter that smooths out basket-level margin fluctuations and momentary hold-count resets.

**Continuous hold time has a cliff but is contaminated.** 10+ minutes at peak tier = 100% (n=11 full), but runs that span halftime are stitched together. Checkpoint count (3+ cp = 93% in tier journey, n=385) is a cleaner measure because each checkpoint independently confirms the state.

**Wire-to-wire is the ultimate signal.** 23/23 (100%) in production replay, 99.7% (n=377) in full season, 98.3% (n=58) in close games.

---

## 6. Implications for the Graduation System

### What Works

The tier journey's existing checkpoint graduation at 6-minute intervals is validated. The production replay proved that finer resolution adds noise without signal. The system should keep 6-minute checkpoints as the graduation scaffold.

The S/A/B/C classification logic (conviction × lead × holds × opp count) produces meaningful separation — A-tier is genuinely different from B and C across every metric.

### What Needs to Change

**POSITION OPEN cannot anchor on first BWC fire.** In close games, first fire is 51.1% and first B-graduation is 52.5% at Q1_END. The system must wait for confirmation before declaring an anchor team.

**POSITION OPEN should wait for graduation + confirmation.** The data supports: fire POSITION OPEN when a team graduates to B at Q2_END or later (62.1%+), OR when a team graduates to A at any checkpoint (74.2%+ in close games). Q1 B-graduations are not reliable enough to anchor on.

**Mean floor ≥ 0.80 should gate POSITION OPEN.** Below 0.80, the first-to-graduate signal is marginal. Above 0.80, it has teeth even in close games (66.2%).

**The system must accept silence in ~45% of close games.** Nearly half of close-game winners never graduate. Forcing POSITION OPEN to fire in every game will produce bad anchors. No POSITION OPEN is better than a wrong POSITION OPEN.

**"Only one graduated" is the strongest variant.** When only one team reaches B, they win 85.8% full / 65.4% close. When both teams graduate, the first to get there is almost worthless. The system should track whether the opponent has ALSO graduated and adjust confidence accordingly.

### Proposed POSITION OPEN Firing Rules

1. **Gate:** Do not fire before Q2_END
2. **B-tier POSITION OPEN:** First team to graduate to B, confirmed at next checkpoint, mean floor ≥ 0.80, opponent has NOT also graduated to B
3. **A-tier POSITION OPEN:** First team to graduate to A at any checkpoint (74.2%+ even in close games)
4. **Silence:** If both teams have graduated to B, or if no team has graduated by Q3_END, suppress POSITION OPEN
5. **Wire-to-wire upgrade:** If the anchored team has held ctrl at every checkpoint since fire, upgrade confidence (98-100% historically)

### What the S/A/B/C Spec Should Lock

Based on the combined evidence:

- **S-tier:** Wire-to-wire, A-graduation, 0 ctrl flips. 98-100% across all datasets.
- **A-tier:** Graduation to A at Q2_END+, mean floor ≥ 0.80, 3+ checkpoints at peak. 93-95% full, 74-81% close.
- **B-tier:** Graduation to B, 2+ checkpoints at peak, opponent not graduated, mean floor ≥ 0.70. 79-86% full, 62-65% close.
- **C-tier:** First BWC fire, no graduation yet, or opponent also graduated. Track but do not anchor. 52-64% — not actionable without plus-money odds.

---

## Appendix: Data Cross-Reference

| Metric | Full (1,230) | Close (476) | Prod Full (34) | Prod Close (8) |
|---|---|---|---|---|
| First-to-B wins | 79.7% | 62.2% | 81.8% | 37.5% |
| First-to-A wins | 93.4% | 74.2% | 96.7% | 83.3% |
| Only-one-B wins | 85.8% | 65.4% | 93.1% | 60% |
| Wire-to-wire | 99.7% | 98.3% | 100% | 100% |
| Winners graduated B+ | 77.8% | 54.8% | 91.2% | 75% |
| Winners never graduated | 22.2% | 45.2% | 8.8% | 25% |
| Winner was first BWC team | 64.6% | 51.9% | 70.6% | 37.5% |
| Mean floor ≥ 0.80 win rate | 79.9% | 66.2% | 82.6% | 66.7% |
