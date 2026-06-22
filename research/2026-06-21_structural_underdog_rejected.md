# Structural-Underdog Hypothesis — TESTED & REJECTED

**Date:** 2026-06-21
**Status:** KILLED. No edge. Do not revisit without a genuinely new (non-box-score) hypothesis.
**League:** WNBA
**Data:** 95 UUID games, 2026-05-08 → 2026-06-21. Reproducible from db-api `get_games` + `history` + `get_odds`, `&league=wnba`. Analysis cached to `/tmp/wnba_cache.json` this session.

---

## 1. Hypothesis (#10, the mirror of bad-leader collapse)

A **weak** trailer vs a **strong** leader, where the trailer is winning the paint + turnover battle while **not** inflating its eFG (shooting at/below the favorite), is a live underpriced dog. The eFG condition was the proposed discriminator, meant to separate: (a) hot-and-will-regress [trap], (b) hanging-around-hoping-favorite-cools [not actionable], (c) genuinely outplaying on structure [the supposed edge].

This lives in the region the comeback engine explicitly returns `NO_EDGE` on (competent/strong leader), so it was a candidate *new* bucket, not an overlap.

**Seed:** LA (.467) over NY (.833), 6/21 — down 6 at end-Q3 with paint +16, TO −6 (ball security: 8 vs 14, unforced 0 vs 5), eFG 54% vs 60% (LA shooting worse). Live ML +900 (10% implied). Won 98-97. No model flagged it (xgb 0.76 / mc 0.07 / espn_wp 20 all favored NY).

**Counter (rule should stay quiet):** WSH (.500) over MIN — WSH *lost* paint (−6) and committed 9 *more* TOs; won only on MIN's Q4 eFG crater. Variance, not structural control.

---

## 2. Method

- Decision point: **end-of-Q3 snapshot** (last clean checkpoint, longest dog price). Robustness also run at Q2-end and mid-Q3 (~5:00 left).
- Score/deficit computed from `raw_stats_json` fgm/fg3m/ftm (the top-level `home_pts`/`away_pts` and `deficit` columns are unreliable — `deficit` read 0 at the seed's Q3 buzzer).
- eFG = (fgm + 0.5·fg3m)/fga. Paint/TO from `raw_stats_json`. Team strength = season win% from the 95-game set (population-definition proxy; mild lookahead acknowledged — it defines the bucket, it is not a betting input).
- **Odds join is exact:** snapshot `ts` and `get_odds` `ts` are server-poll-aligned (dt ≈ 0s); nearest-ts match is the same row.
- Population = weak trailer vs strong leader (win% gap < −0.05). Structural dog = `paint>0 AND to<0 AND t_efg ≤ l_efg`. Metric = actual win rate − live implied prob (vig-inclusive, the real betting bar).

---

## 3. Results — no edge anywhere

**Structural dogs at end-Q3: 1-for-7 (14.3% WR vs 17.8% implied, edge −3.5%). The lone win is the seed (LA).** Strip the seed → **0-for-6, −19pp.**

The 7 structural dogs (leader eFG-heat shown for §4 context):

```
2026-05-10  WSH v NY   down 3   paint+? to<0  eFG 52<=61   leader heat +0.05   lost
2026-05-27  CHI v TOR  down 6                  eFG ..<=61   leader heat +0.10   lost
2026-06-03  TOR v NY   down12                  eFG ..<=56   leader heat -0.00   lost
2026-06-06  GS  v LV   down 3                  eFG ..<=52   leader heat -0.04   lost
2026-06-08  CON v NY   down 9                  eFG ..<=52   leader heat -0.04   lost
2026-06-11  ATL v NY   down16                  eFG ..<=71   leader heat +0.15   lost   (leader scorching, dog still lost)
2026-06-21  LA  v NY   down 6   paint+16 to-6  eFG 54<=60   leader heat +0.04   WON    (the seed)
```

**Checkpoint robustness — seed-removal kills it everywhere:**

| checkpoint | structural dogs | minus seed |
|---|---|---|
| Q2-end | n=12, edge −5.1% | n=11, **−13.4%** |
| Q3-mid | n=10, edge +0.6% | n=9, **−9.2%** |
| Q3-end | n=7, edge −3.5% | n=6, **−19.0%** (0-for-6) |

The only non-negative reading (Q3-mid +0.6%) is propped up entirely by the seed.

**Variants, all negative:** own-norm eFG discriminator (0-for-4, −14.4%); deficit cap 1–12 (1-for-6, −3.0%); paint+TO without eFG gate (1-for-9, −5.2%).

**Leader-mean-reversion (the opponent-stat test):** does not discriminate. On the population: leader hot >0 → −5.2% (n=38); hot >+0.04 → −1.3% (n=25); leader 3P hot → −5.6% (n=21); leader *cold* → −3.8%. The interaction struct-dog + leader-hot looked positive (+6.8%) but is **n=4, 1-for-4, win = seed** — same artifact in a smaller bucket. The six losers span the full leader-heat range (cold −0.04 to scorching +0.15); the lone winner is unremarkable on that axis.

**Population baseline:** weak trailers run negative at every checkpoint (−4.6% to −7.2%). The market is sharp on weak dogs.

---

## 4. Root cause

1. **The region is efficiently priced on visible features.** Paint, TOs, eFG, the leader's hot shooting — all public, all in the live box score the book prices off. Visible-feature engineering can't beat an efficient line.
2. **Weak teams don't complete comebacks even when the leader cools** — they're too weak to capitalize on the regression. This is the structural reason leader-mean-reversion (which *does* drive the bad-leader bucket) fails here: in the bad-leader bucket the chaser is the *better* team and grinds the lead back; here the chaser is the worse team and the lead, even when it fades, doesn't fade into the dog's hands.
3. **The apparent signal was one fat-tail event.** The +900 seed was a single realization. Every subset that looked positive just re-fenced that one win into a smaller bucket — textbook multiplicity, on a fixed dataset, with the hypothesis generated by the same event used to "confirm" it.

---

## 5. The contrast — the real edge is the opposite configuration

The same end-Q3 analysis shows the WNBA live-dog edge lives where the **trailer is the better team**: the "much-better-trailer" bucket (win% gap > +0.20) hit **57% vs 38% implied, +19.5pp edge, n=14**. That is the bad-leader-collapse / efficiency-divergence region the comeback engine **already targets** (`WNBA_COMEBACK_ENGINE_SPEC.md` §2.2–2.3). The structural-underdog was fishing in the one region (weak team trailing) with no edge to find.

---

## 6. Verdict

Killed. n is far below the precision bar (structural-dog subsets n=6–7), so this is "zero evidence of positive edge," not "proven −EV" — but across three checkpoints, multiple variants, leader-state cuts, and seed-removal, there is nothing here that isn't the single seed game. Chasing weak-team comebacks is a stroke of luck at a negative edge, not a repeatable signal.

**Do not revisit without a genuinely new non-box-score hypothesis. A new checkpoint or threshold on this same sample does not count.**
