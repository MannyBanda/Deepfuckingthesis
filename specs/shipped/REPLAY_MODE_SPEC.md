# REPLAY MODE — test-v2-engine Spec

**Version:** 1.0
**Date:** April 21, 2026

---

## Problem

The current test-v2-engine replays from **stored** i1-i5 and floor values. If we change an indicator threshold (e.g., I4 subA gap ±4 → ±2), adjust weights (e.g., WNBA I3=30%), or tweak VT parameters, we can't see the cascading effect without deploying to production and waiting for live games.

We need a replay mode that **recomputes indicators from raw box score data** with configurable parameters, then cascades those through floor → BWC state → graduation → alert triggers — showing original vs recomputed side-by-side.

This is the same tool we'd use for:
- Testing threshold tightenings (I4 subA backlog item)
- WNBA expansion (different weights, baselines, period structure)
- Any future indicator redesign
- Diagnosing specific games where indicators produced bad reads

---

## Endpoint

```
/.netlify/functions/test-v2-engine?mode=replay&game_id=X&config=BASE64_JSON
```

**Params:**
- `mode=replay` — activates replay recompute (existing modes `mechanical`/`context`/`agent` unchanged)
- `game_id=X` — single game (required; no `all=true` for replay — too expensive)
- `config=BASE64_JSON` — override config (optional; defaults to current NBA production values)
- `league=nba|wnba|ncaamb` — selects league-specific defaults before config overrides apply (default: `nba`)
- `diff_only=true` — only show snapshots where recomputed values diverge from stored (optional, default false)

---

## Config Object

Every field is optional. Omitted fields use the league default. This is the full schema with NBA production defaults shown:

```json
{
  "weights": {
    "I1": 0.10,
    "I2": 0.15,
    "I3": 0.20,
    "I4": 0.30,
    "I5": 0.25
  },

  "i1": {
    "disrupt_gap": 1,
    "pot_gap": 4,
    "chaos_gap": 4
  },

  "i2": {
    "paint_gap": 6,
    "rim_pct_gap": 0.10,
    "rim_min_att": 6
  },

  "i3": {
    "efg_gap": 0.02,
    "ar_gap": 5,
    "cs3_gap": 2
  },

  "i4": {
    "bigLead_gap": 2,
    "bigLead_contested_ratio": 0.75,
    "q4_gap": 2
  },

  "i5": {
    "run_share_hi": 0.55,
    "run_share_lo": 0.45,
    "min_total_runs": 4
  },

  "vt": {
    "projected_threshold": 34,
    "min_3pa": 15,
    "deviation_floor": -5,
    "deviation_ceiling": 15,
    "discount_base": 0.25,
    "discount_scale": 0.15,
    "discount_cap": 0.50,
    "mitigation_floor": 0.70,
    "vt_bonus_scaling": 0.50
  },

  "tp": {
    "baseline_2pt": 0.52,
    "quality_floor": 0.75,
    "min_fg2a": 6,
    "degradation_24": 0.70,
    "degradation_18": 0.85
  },

  "floor": {
    "control_threshold": 0.50
  },

  "alerts": {
    "buy_floor_min": 0.65,
    "buy_margin_max": 15,
    "buy_period_min": 2,
    "buy_ml_suppress": -400,
    "buy_ml_candidate": -250,
    "bwc_floor_min": 0.60,
    "bwc_lead_min": 2,
    "window_buy_floor_min": 0.45,
    "window_buy_margin_min": -15,
    "window_buy_margin_max": 5,
    "window_buy_qtr_window_min": 0.75,
    "recovery_floor_min": 0.30,
    "clock_gate_min": 1.0
  },

  "graduation": {
    "mf_gate": 0.65,
    "min_floor": 0.58,
    "b_rank_confirm_cp": "Q3_6",
    "flip_mf_min": 0.55,
    "flip_min_holds": 2
  }
}
```

### League Defaults

Pre-built configs loaded when `league=` is set, before user overrides apply:

**WNBA** (from WNBA_EXPANSION_SPEC):
```json
{
  "weights": { "I1": 0.15, "I2": 0.20, "I3": 0.30, "I4": 0.25, "I5": 0.10 },
  "tp": { "baseline_2pt": 0.48 },
  "vt": { "projected_threshold": 28 },
  "alerts": { "buy_floor_min": 0.60, "bwc_floor_min": 0.55 },
  "graduation": { "mf_gate": 0.60 }
}
```

**NCAAMB:**
```json
{
  "tp": { "baseline_2pt": 0.49 }
}
```

Merge order: `league_default` → `user_config` → final. User config wins on any field.

---

## What Gets Recomputed vs What Falls Back

### Fully recomputable from current `raw_stats_json`

| Indicator | Sub-indicator | Fields used |
|-----------|--------------|-------------|
| I1 subA | Disruption diff | `stl + blk` both sides |
| I1 subB | Points off turnovers | `pot` both sides |
| I2 subA | Paint volume | `paint` both sides |
| I2 subB | Rim efficiency | `atRimM / atRimA` both sides |
| I3 partial | eFG | `fgm, fga, fg3m` both sides |
| I3 partial | Assist ratio | `ast / fgm` both sides |
| I4 subA | Biggest lead gap | `bigLead` both sides |
| I5 | Run share | `runs6.home / runs6.total` |

### NOT recomputable — requires data enrichment

| Sub-indicator | Missing field | Used by | Fallback |
|--------------|---------------|---------|----------|
| I1 chaos layer | `forced_to`, `unforced_to` | I1 ±0.5 adjustment | Use stored I1 score, flag `i1_chaos_fallback: true` |
| I3 catch-and-shoot | `assisted_3pm` | I3 third sub-component | Use stored I3 score, flag `i3_cs3_fallback: true` |
| I4 subB (pre-Q4) | `season_q4_margin` | Season Q4 prior | Use stored I4, flag `i4_szn_fallback: true` |
| VT cs3PM | `assisted_3pm` | vtBonus calculation | Recompute VT without cs3PM contribution (vtBonus = 0) |
| TP structRate | `ftm` (free throws made) | structRate denominator | Estimate: `ftm ≈ fta × 0.77` (NBA avg), flag `tp_ftm_estimated: true` |

### Data enrichment (prerequisite — one-time production change)

Add to `raw_stats_json` construction in poll-live-bdl.mjs (~line 4789):

```
forced_to: pbpResult?.home?.tos?.forced || 0,    // on each side
unforced_to: pbpResult?.home?.tos?.unforced || 0,
assisted_3pm: pbpResult?.home?.threes?.assisted || 0,
ftm: _hs.free_throws_made || 0
```

This is additive — existing snapshots keep working, new snapshots gain recompute coverage. The replay engine checks for field presence and falls back gracefully.

### I4 subB — special handling

For Q4+ snapshots, I4 subB uses live Q4 scoring diff. In replay, we derive this from the snapshot sequence:

1. Find the last snapshot where `period < 4` — that's the end-of-Q3 score
2. Current snapshot score minus Q3-end score = Q4 scoring diff per side
3. Apply the `q4_gap` threshold

For pre-Q4 snapshots, I4 subB needs `seasonQ4` margin. Three options:
- **Option A:** Store `season_q4_diff` in raw_stats_json (cleanest, requires enrichment)
- **Option B:** Query `season_cache` at replay time (adds DB round-trip per game)
- **Option C:** Fall back to stored I4 for pre-Q4 snapshots

**Recommendation:** Option C for now (pre-Q4 I4 subB changes are rare enough to not matter for most replay scenarios), add Option A to the enrichment batch later.

---

## Recompute Function

New function `recomputeIndicators(rawStats, config, context)`:

```
Input:
  rawStats    — parsed raw_stats_json from snapshot
  config      — merged config object (league defaults + user overrides)
  context     — { period, clock, q4ScoringDiff (if Q4+), minsElapsed, hA, aA }

Output:
  {
    I1: { score, leader, subA, subB, chaos (if available), raw },
    I2: { score, leader, subA, subB, raw },
    I3: { score, leader, subEFG, subAR, subCS3 (if available), raw },
    I4: { score, leader, subA, subB, raw },
    I5: { score, leader, runShare, raw },
    composite: 0.XX,
    controlTeam: 'XXX',
    floor: 0.XX,
    fallbacks: ['i1_chaos', 'i3_cs3', ...]   // which sub-indicators used stored values
  }
```

The function is **pure** — no DB calls, no side effects. Takes data in, returns indicators out. This is what makes it portable to WNBA or any future league: swap the config, same function.

---

## Cascade Chain

The replay processes snapshots chronologically and cascades recomputed values through the full state machine:

```
raw_stats_json + config
    ↓
recomputeIndicators()     →  new I1-I5, floor, controlTeam
    ↓
recomputeVT()             →  new VT active/discount/vtBonus (if fg3a/fg3m available)
    ↓
recomputeTP/LS()          →  new TP classification, LS classification
    ↓
updateLiveTracking()      →  new peak_floor, consecutive_holds, ctrl_team_holds
    ↓
computeBwcState()         →  new BWC state (using recomputed floor + margin)
    ↓
checkGraduation()         →  new checkpoint captures, rank, MF trajectory
    ↓
checkAlertTriggers()      →  would BUY/POSITION_OPEN/EXIT/etc. fire under new values?
```

Each step uses the RECOMPUTED values from the step above, not stored values. The full BWC state machine replays from scratch with new floors.

---

## Output Format

### Per-snapshot row (JSON array)

```json
{
  "idx": 42,
  "period": 3, "clock": "8:15",
  "home_pts": 67, "away_pts": 71,

  "stored": {
    "floor": 0.72, "controlTeam": "DEN",
    "I1": 1.0, "I2": 0.5, "I3": 0.0, "I4": 1.0, "I5": 0.5,
    "tp": "PROBABLE", "ls": null,
    "bwcState": "EDGE", "graduation": "B"
  },

  "recomputed": {
    "floor": 0.65, "controlTeam": "DEN",
    "I1": 1.0, "I2": 0.5, "I3": 0.5, "I4": 0.5, "I5": 0.5,
    "tp": "CONTESTED", "ls": null,
    "bwcState": "LOCK", "graduation": "C",
    "fallbacks": ["i1_chaos", "i3_cs3"]
  },

  "divergence": {
    "floor_delta": -0.07,
    "indicators_changed": ["I3", "I4"],
    "control_flipped": false,
    "bwc_state_changed": true,
    "graduation_changed": true,
    "tp_changed": true
  }
}
```

### Summary section

```json
{
  "game": "MIN@DEN G2 4/20",
  "config_applied": { "i4.bigLead_gap": 3 },
  "total_snapshots": 147,
  "snapshots_diverged": 38,
  "divergence_rate": "25.9%",

  "indicator_changes": {
    "I1": { "changed": 0, "pct": "0%" },
    "I3": { "changed": 12, "pct": "8.2%" },
    "I4": { "changed": 31, "pct": "21.1%" }
  },

  "floor_impact": {
    "avg_delta": -0.04,
    "max_delta": -0.12,
    "control_flips": 3,
    "flip_details": [
      { "idx": 67, "period": 3, "clock": "4:22", "from": "DEN", "to": "MIN" }
    ]
  },

  "bwc_impact": {
    "stored_fire_idx": 15,
    "recomputed_fire_idx": 22,
    "fire_delay_snaps": 7,
    "stored_graduation": "B @ Q3_6",
    "recomputed_graduation": "C @ Q3_9 (never reaches B)",
    "state_divergences": 12
  },

  "alert_impact": {
    "stored_triggers": 8,
    "recomputed_triggers": 5,
    "new_triggers": 1,
    "removed_triggers": 4,
    "changed_triggers": [
      {
        "idx": 89, "type": "BUY", "tier": "FIRED",
        "stored": "fires (floor 0.72, trailing 4)",
        "recomputed": "suppressed (floor 0.58, below 0.65 gate)"
      }
    ]
  }
}
```

### diff_only mode

When `diff_only=true`, the per-snapshot array only includes rows where at least one divergence field is non-zero. Summary section always included.

---

## Alert Trigger Recheck

At each snapshot, apply alert threshold logic using recomputed values AND configurable gates from `config.alerts`:

**BUY check:**
- Recomputed floor ≥ `alerts.buy_floor_min` (default 0.65)
- ctrl team trailing 1–`alerts.buy_margin_max` (default 15)
- Period ≥ `alerts.buy_period_min` (default 2)
- TP not UNLIKELY/NO PATH (using recomputed TP)
- ML gate: suppress < `alerts.buy_ml_suppress`, candidate < `alerts.buy_ml_candidate` (stored ML — not recomputable)
- Clock ≥ `alerts.clock_gate_min` (default 1.0 min)

**POSITION_OPEN check:**
- Recomputed floor crosses `graduation.mf_gate` (default 0.65)
- minFloor ≥ `graduation.min_floor` (default 0.58)
- B-rank confirmation at `graduation.b_rank_confirm_cp` (default Q3_6)
- Full graduation cascade with recomputed floors at each checkpoint

**EXIT check:**
- Erosion computed from recomputed peak floor trajectory

**BWC/WINDOW BUY/RECOVERY PATH:**
- All gates use `config.alerts` thresholds instead of hardcoded values

This means WNBA can ship with different alert gates (e.g., `buy_floor_min: 0.60`) and validate them in replay before going live.

---

## Implementation Plan

### Phase 1 — Core recompute (ship first)

1. **Data enrichment** — add `ftm`, `forced_to`, `unforced_to`, `assisted_3pm` to `raw_stats_json` in poll-live-bdl.mjs (~4 fields, 2 locations: regular snapshot + calibration snapshot). Additive, no breaking changes.

2. **`replay_configs` table** — create via db-api init action. Add `save_preset`, `list_presets`, `delete_preset` actions to db-api.js.

3. **`recomputeIndicators()` function** — pure function in test-v2-engine.mjs. Takes raw_stats_json + config + context → returns full indicator set with fallback flags.

4. **`recomputeVT()` function** — pure function. Takes raw_stats_json + config + sust data → returns VT per side.

5. **Replay loop** — new branch in `replayGame()` when `mode=replay`. Processes snapshots chronologically, calls recompute at each step, cascades through live_tracking/BWC state/erosion/graduation/alert triggers. Uses `config.alerts` and `config.graduation` for threshold checks.

6. **Output builder** — per-snapshot comparison + summary + alert trigger recheck.

### Phase 2 — TP/LS recompute (after enrichment bakes)

Once new snapshots have `ftm`, enable full structRate recompute instead of estimation. Add TP/LS parameter overrides to config (degradation thresholds, band rates).

### Phase 3 — Agent integration (optional)

Add `mode=replay_agent` that runs the recomputed context through the alert agent. Shows: "with these indicator changes, would the agent SEND or SUPPRESS differently?" Expensive (API calls per trigger) but valuable for validating agent prompt changes alongside mechanical changes.

---

## WNBA Usage Example

```
config = {
  "weights": { "I1": 0.15, "I2": 0.20, "I3": 0.30, "I4": 0.25, "I5": 0.10 },
  "i2": { "paint_gap": 4 },
  "tp": { "baseline_2pt": 0.48 },
  "vt": { "projected_threshold": 28, "min_3pa": 10 },
  "alerts": { "buy_floor_min": 0.60, "bwc_floor_min": 0.55 },
  "graduation": { "mf_gate": 0.60 }
}
```

Save as preset: `?action=save_preset&name=wnba_v1&league=wnba&config=BASE64&description=Initial WNBA weights from backtest`

Replay a game: `?mode=replay&preset=wnba_v1&game_id=X`

Tweak one param: `?mode=replay&preset=wnba_v1&game_id=X&config=eyJpMiI6eyJwYWludF9nYXAiOjZ9fQ==` (override paint_gap to 6)

---

## Decisions Locked

1. **Alert firing gates are configurable.** Added `alerts` section to config (BUY floor, margin, ML gates, BWC floor, WINDOW BUY params, RECOVERY floor, clock gate). Current production values are defaults — WNBA can ship with different gates and validate in replay.

2. **Full cascade including graduation.** Recomputed floors feed into checkpoint MF trajectory, rank classification, and PO firing. Added `graduation` section to config (MF gate, minFloor, B-rank confirmation CP, flip criteria).

3. **Multi-game batch replay deferred to Phase 2.** Single-game first, batch is a loop wrapper with aggregate stats.

4. **Named config presets stored in DB.** New `replay_configs` table: `name` (PK), `league`, `config_json`, `description`, `created_at`. Endpoint: `?preset=wnba_v1` loads config by name before user overrides. Also supports `?action=save_preset&name=X&config=BASE64` and `?action=list_presets` for management.

---

## Config Presets

### Table schema

```sql
CREATE TABLE IF NOT EXISTS replay_configs (
  name TEXT PRIMARY KEY,
  league TEXT NOT NULL DEFAULT 'nba',
  config_json JSONB NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Endpoints (via test-v2-engine)

- `?action=list_presets` — returns all saved configs
- `?action=save_preset&name=X&league=nba&config=BASE64&description=...` — upsert a named config
- `?action=delete_preset&name=X` — remove a named config
- `?mode=replay&preset=X&game_id=Y` — load preset, apply any additional `&config=` overrides on top

### Merge order

`league_default` → `preset` → `inline config` → final

This means you can save a base WNBA config as a preset, then override a single threshold inline to A/B test: `?preset=wnba_v1&config=eyJpNCI6eyJiaWdMZWFkX2dhcCI6M319` (I4 bigLead_gap: 3 on top of WNBA defaults).
