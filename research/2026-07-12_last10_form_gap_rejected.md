# Last-10 Form in the Quality Gap — TESTED & REJECTED (2026-07-12)

**Hypothesis (Manny):** recent form (last-10 win%) should inform the quality-gap calculation —
motivated by POR@ATL Jul 11 (ATL a gap-trailer by season record, but skidding + Reese out; pass
was correct, ATL lost 92-102).

**Dataset:** 526 WNBA 2024-25 games via `backtest-wnba?phase=export_xgb_training` (5,260
checkpoints) joined to BDL game dates/teams; winners derived from checkpoint outcomes (100%
match, 0 inconsistencies). Spots = trailing 1-9 at Q2/Q3 checkpoints, deduped to one per
game-quarter (n=686). Entering-game win% computed strictly pre-game, same season (season ≥4 GP,
form = last 10, ≥5 GP). Baseline replicates Jun-21 monotonicity: worse 19.6% → even 36.0% →
better 48.1%.

## Findings

1. **Form gap is a noisier copy of season gap, not new information.** corr(season gap, form
   gap) = **0.868**. Standalone AUC: season **0.672** vs form **0.655** — form is strictly
   worse. Best blend (λ=0.25) adds +0.0014 AUC: noise.
2. **The disagreement cells are empty.** Season-better-but-form-worse: **n=2**.
   Season-worse-but-form-better: **n=4**. At the ±.10 threshold the two definitions almost
   never point opposite ways — there is nothing to learn from divergence at this sample size.
3. **The seductive cell is a confound.** "Better-by-season trailer on a skid" showed 77.4%
   comeback (n=31) — but you can only skid from a height: that cell carries mean season gap
   .343 vs .262 for surging trailers, AND shallower deficits (4.7 vs 5.7). Quality and
   deficit explain it, not form. Splits are non-monotonic and direction-flip across buckets
   (all cells n<80 → ordering only, and the ordering isn't stable). Same failure mode as the
   killed failure-profile split (May 29).

## The reframe (what POR@ATL actually was)

ATL's last-10 still mostly contained Reese games — a 10-game window LAGS roster changes; it
cannot see "star out tonight." What Manny's filter used was **availability + head-to-head
recency**, which is step-function roster state, not win% arithmetic at any window length.
The encodeable version of that instinct is the **injury/availability layer** (the §4c
player-context direction), not recency-weighted records. Until then it stays where it
demonstrably works: the discretionary layer (POR@ATL pass, A grade — now measured via `bets`).

## Verdict

- **Season win% stays the sole gap input** for comebackProb + WATCHLIST. No code changes.
- Do NOT revisit last-10/recency-weighted records without a genuinely new mechanism
  (e.g., availability-adjusted records — different data, different hypothesis).
- Caches: /tmp/xgb_export.json, /tmp/bdl_wnba_games.json, /tmp/qg_spots.json.
