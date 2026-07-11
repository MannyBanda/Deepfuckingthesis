# WNBA XGB Retrain — BDL-Primary, Windowed-Only

**Date:** May 11, 2026
**Version:** 2.0 (FINAL)
**Status:** CONFIRMED — build next session
**Objective:** Retrain WNBA XGB model with 3x data, pure windowed features, BDL-only data path, kitchen-sink feature discovery including custom shot zone analysis.

---

## Why This Matters

The current WNBA XGB model has four structural problems:

1. **Anti-predictive in production** — AUC 0.4496 on 10 live games vs 0.815 in training. Actively worse than random.

2. **Cumulative anchoring** — Mixes 6 cumulative + 6 windowed features. NBA went through the same evolution and landed on pure windowed because cumulative features anchor stale early-game patterns into late-game reads. The WNBA model became "a worse version of MC Cum without its own unique value."

3. **Tiny training set** — Only ~200 games (2025 season with SR matches). BDL has 576 games across 2024+2025.

4. **Training/production data source mismatch** — Trained on SR game summaries. Production uses BDL team_stats + SR supplement. Training on BDL-native data aligns sources AND makes XGB robust to SR outages.

---

## Decisions Locked

| Decision | Answer |
|----------|--------|
| Checkpoint granularity | Every 2.5 game-minutes (~12 Q2+ rows/game, ~6,912 total) |
| Feature approach | Kitchen sink — test ALL reconstructable features, prune from data |
| Season weighting | 2025 games × 1.5 sample_weight vs 2024 (closer to 2026 distribution) |
| Deployment | Hot-swap if new model is proven/better |
| Poll interval | 2.5-min checkpoints. Same relative granularity as NBA (25% of quarter). Production polls at ~60s wall but finer training granularity adds correlated rows without improving model quality. |
| Architecture | Pure windowed for XGB. biglead + runs stay cumulative (inherently game-wide). MC Cum handles cumulative rate projection — clean signal role separation. |

---

## Infrastructure (Existing)

**File:** `backtest-wnba.mjs` (3,079 lines)

Already built:
- `phaseCollect` — BDL game collection
- `phaseCollectPBP` — PBP download + storage in `wnba_backtest.bdl_pbp` JSONB
- `reconstructCheckpoints()` — 178 lines. Reconstructs cumulative box scores at 2.5-min intervals from PBP. Already extracts: FGM, FGA, FG3M, FG3A, FTM, FTA, OREB, DREB, AST, STL, BLK, TOV, PF, POT, biglead. Has POT tracking (pendPOT state machine).
- `WNBA_CHECKPOINTS` — 2.5-min checkpoint grid for 10-min quarters
- `wnba_backtest` table with game outcomes, winner, margin

New code: ~400-500 lines across 4 new phases + zone parsing extension.

---

## Custom Shot Zone Feature — "Deep Paint" Hypothesis

**Hypothesis:** SR's `points_in_paint` (AUC 0.500) aggregates everything ≤16ft. This masks a structural signal: scoring deep (≤5ft rim attacks) requires penetrating the defense and correlates with physicality/aggression. Mid-range paint shots (11-16ft) are skill-dependent noise.

**Evidence (2 games, BDL PBP):**

| Zone | FG% | Character |
|------|-----|-----------|
| RIM (≤5ft) | 76.2% | Structural — getting past defense |
| SHORT (6-10ft) | 35.3% | Floaters, hooks |
| MID PAINT (11-16ft) | 44.4% | Noise that SR blends with rim |
| LONG 2 (17-22ft) | 25.0% | Dead zone |
| 3PT (22+ft) | 34.0% | Volume game |

**Parsing logic:**

1. **With distance:** Regex `(\d+)-foot` from play text → integer feet → zone classification
2. **Without distance (29% of shots):** Classify by play type:
   - RIM: Layup, Driving Layup, Running Layup, Cutting Layup, Reverse Layup, Dunk, Tip, Putback → assign 3ft
   - SHORT: Hook Shot, Turnaround Hook, Floating → assign 8ft
   - MID: Turnaround Jump Shot (no distance) → assign 12ft
   - UNKNOWN: exclude from zone features, still count in FGA/FGM

**Test:** If `rim_pts` or `rim_share` shows AUC significantly above 0.500 while `paint_pts` stays flat, deep paint is a real structural signal that SR's definition was masking.

---

## Feature Candidates (28 total — Kitchen Sink)

### Standard Box Score (18 windowed)

All computed as ctrl - opp differential from cross-fade windowed stats.

| # | Feature | What it measures |
|---|---------|-----------------|
| 1 | pot | Points off turnovers — conversion efficiency |
| 2 | to | Raw turnovers (inverse at n=200 — retest at n=576) |
| 3 | stl | Steals — disruption |
| 4 | blk | Blocks — rim protection |
| 5 | oreb | Offensive rebounds — second chances |
| 6 | dreb | Defensive rebounds — ending possessions |
| 7 | ast | Assists — ball movement |
| 8 | ast_ratio | Assisted FG% (ast/fgm) — structured offense |
| 9 | fta | Free throw attempts — aggression |
| 10 | ftm | Free throws made — execution |
| 11 | efg | Effective FG% — shooting efficiency |
| 12 | 3pa | 3PT attempts — perimeter volume |
| 13 | 3pm | 3PT makes — perimeter execution |
| 14 | 3pr | 3PT percentage (noise at n=200 — retest) |
| 15 | 2pr | 2PT percentage — interior accuracy |
| 16 | pf | Personal fouls (inverse at n=200 — retest) |
| 17 | disruption | Combined stl + blk |
| 18 | to_ratio | Steal-to-turnover ratio |

### Custom Shot Zones (8 windowed) — NEW

| # | Feature | What it measures |
|---|---------|-----------------|
| 19 | rim_pts | Points ≤5ft + layups/dunks — deep structural offense |
| 20 | rim_rate | Rim FG% — finishing at the basket |
| 21 | rim_share | Rim FGA / total FGA — how much rim attacking vs settling |
| 22 | short_pts | 6-10ft points — floaters, hooks |
| 23 | mid_paint_pts | 11-16ft points — mid-range paint |
| 24 | paint_pts | ≤16ft total — SR-equivalent baseline for comparison |
| 25 | long2_pts | 17-22ft non-3PT — dead zone |
| 26 | deep_paint_rate | Rim FG% differential — structural penetration hypothesis |

### Game-State (2 cumulative)

| # | Feature | Why cumulative |
|---|---------|---------------|
| 27 | biglead | Biggest lead = game-wide high-water mark |
| 28 | runs | Scoring sequences accumulate across game |

**Pruning target:** Start with 28, prune to 10-15 based on AUC + SHAP + forward selection.

---

## Pipeline Phases

### Phase 1: `collect_2024` (NEW ~40 lines)

Add 2024 season games to `wnba_backtest`.
- Fetch `/wnba/v1/games?seasons[]=2024&per_page=100` (paginate)
- INSERT if not exists, map aliases, determine winner
- Add `season INTEGER` column if missing
- **Output:** ~264 new rows

### Phase 2: `collect_pbp` (EXISTS — no changes)

Auto-picks up 2024 games. Console auto-runner: ~1,320 BDL calls.

### Phase 3: `collect_team_stats` (NEW ~30 lines)

Fetch BDL team_stats as validation ground truth.
- `/wnba/v1/team_stats?game_ids[]={id}` per game
- Store in new `bdl_team_stats JSONB` column
- ~576 calls

### Phase 4: `validate_reconstruction` (NEW ~80 lines)

**Non-negotiable.** Runs BEFORE training.

Compare PBP-reconstructed game totals vs BDL team_stats for: FGM, FGA, FG3M, FG3A, FTM, FTA, OREB, AST, STL, BLK, TOV.

Acceptable: ±2 per stat. Flag >3 for inspection. Fix systematic errors before proceeding.

### Phase 5: `compute_xgb_training` (NEW ~250 lines — core)

**5a.** Extend `reconstructCheckpoints()` with zone tracking (~40 lines in existing play loop)

**5b.** Compute per-quarter boundary diffs:
```
Q2_stats = cumulative_at_Q2_END - cumulative_at_Q1_END
Q3_stats = cumulative_at_Q3_END - cumulative_at_Q2_END
Q4_stats = cumulative_at_Q4_END - cumulative_at_Q3_END
```

**5c.** Cross-fade window (matching production `computeServerWindow`, 10-min quarters):
```
At checkpoint in quarter Q at progress P:
  window = prior_Q_stats × (1-P) + current_Q_partial × P
```

**5d.** Extract 28 features per checkpoint Q2+ as ctrl-opp differentials.

**5e.** Store in new table `wnba_xgb_training`:
```sql
CREATE TABLE IF NOT EXISTS wnba_xgb_training (
  id SERIAL PRIMARY KEY,
  game_id TEXT NOT NULL,
  bdl_game_id INTEGER,
  season INTEGER,
  checkpoint TEXT NOT NULL,
  quarter INTEGER NOT NULL,
  game_seconds INTEGER,
  ctrl_team TEXT,
  ctrl_won BOOLEAN,
  features JSONB NOT NULL,
  margin INTEGER,
  UNIQUE(game_id, checkpoint)
);
```

### Phase 6: `export_xgb` (NEW ~40 lines)

Paginated JSON export: `?phase=export_xgb&batch=200&offset=0`

---

## Training (Python, sandbox)

### Stage 1: Individual Feature AUC Discovery

Per-feature AUC at Q2, Q3, Q4 across 576 games. Tests:
- Deep paint hypothesis: `rim_pts` / `rim_share` vs `paint_pts`
- Inverse features at scale: `to`, `pf` still inverse?
- Noise features at scale: `3pr` emerge from noise?

### Stage 2: Full Model Training (28 features)

- 5-fold stratified by game_id
- 2025 sample_weight 1.5×
- OOF predictions for honest AUC
- Hyperparam grid: depth [3,4,5], trees [200,300,400], lr [0.02,0.03,0.05], subsample [0.7,0.8], colsample [0.7,0.8], min_child [2,3,5]

### Stage 3: Feature Pruning

1. SHAP importance ranking
2. Forward selection (top feature → add one → track OOF AUC)
3. Drop features where removal doesn't decrease AUC by >0.005
4. Redundancy check: correlation with MC Cum > 0.85 → flag as doing MC's job

### Stage 4: Final Model

- Retrain pruned set, export compact JSON
- Verify AUC increases Q2→Q4
- OOF vs resubstitution gap < 0.05

### Success Criteria

| Metric | Threshold |
|--------|-----------|
| OOF AUC overall | > 0.75 |
| Q4 AUC | > 0.80 |
| AUC trend Q2→Q4 | Increasing |
| OOF vs resub gap | < 0.05 |
| MC Cum correlation | < 0.85 |

---

## Deployment

1. Model → `netlify/functions/xgb-model-wnba.json`
2. `extractXGBFeatures` WNBA branch updated with locked feature order (set after Stage 4)
3. Zone accumulators added to production PBP parser (~30 lines in `poll-live-bdl.mjs`)
4. Agent prompt updated if feature narrative changes
5. Hot-swap deploy, monitor first live slate

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| PBP parsing errors | Phase 4 validation. Fix before training. |
| Zone classification errors | Type fallback covers 29% no-distance shots. Validate rim = 30-40% of FGA. |
| 2024 distribution shift | Season weighting. Both seasons in every fold. |
| Kitchen sink overfitting (28 features) | XGB regularization + forward selection pruning to 10-15. |
| Feature order mismatch | Locked after Stage 4. Shared constant between training and production. |
| Deep paint = noise | Valid finding if so. No harm from testing. |

---

## Timeline

| Step | Est. |
|------|------|
| Phases 1-4 (data collection + validation) | 75 min |
| Phase 5-6 (feature extraction + export) | 40 min |
| Python training (Stages 1-4) | 75 min |
| Deployment + alignment | 20 min |
| **Total** | **~3.5 hours (1-2 sessions)** |

PBP parsing (hardest part) is already built. Phases 1-3 run as auto-runners while we write training code.
