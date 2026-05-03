# MC Production Integration — Architecture Spec (v4)

**Date:** May 3, 2026
**Status:** SPEC — awaiting approval before implementation
**Touches:** `poll-live-bdl.mjs`, `db-api.js`, `v3.html`
**Replaces:** VULNERABILITY alert system

---

## Design Thesis

Monte Carlo is a **graduation guard** — a stateful investigation that detects structural collapse in ctrl-leading games where cumulative signals (floor, XGB) are anchored to stale early-game data.

MC replaces VULNERABILITY entirely. The MC canary is strictly better on every dimension — wider scope (any margin, no XGB gate), higher precision (CLEAN 72.6% vs VULN 47.4%), and richer information (pattern classification vs binary fire).

---

## How MC Works

### The Canary (every eligible poll, ~5ms)

Every minute during Q3+, when the ctrl team is leading, the system extracts exact per-team rates from the last 20 possessions of the PBP log — 2PT%, 3PT%, TO rate, OREB rate, FT rate — directly from actual possessions, not box score approximations. Then it simulates the rest of the game 200 times. If ctrl wins < 70% of sims, OR the gap between floor and MC exceeds 15%, the canary fires.

### The Investigation (every poll after trigger, ~12ms)

At canary fire, the system photographs the box score. Every minute after, it subtracts the photograph from the current box score to get post-trigger rates — what each team has produced SINCE the alarm. It simulates the rest of the game 500 times using only post-trigger rates and classifies a verdict:

- **CONF** (≤25%): sustained collapse
- **LIKELY** (25-40%): probable collapse
- **CONT** (40-60%): contested
- **NORM** (>60%): rates recovered
- **INV** (<8 post-trigger poss): insufficient data

Investigation starts at canary fire (not 20 possessions ago). Canary detects, investigation confirms persistence. The INV period (~3-4 minutes) forces the system to wait for NEW evidence.

### The Pattern (verdict sequence classification)

- **CLEAN**: Hit CONF/LIKELY and never recovered. Sustained collapse. **72.6% precision.**
- **WAVE**: Collapsed → recovered → collapsed again. Oscillating. **60% precision.**
- **NORMALIZED**: Alarmed but rates recovered. **86-91% ctrl survives.**
- **FALSE_ALARM**: Never reached LIKELY/CONF. **91% ctrl survives.**

### What MC Knows

- Per-team shooting rates from PBP possessions (canary) or box score diff (investigation)
- Current actual score (sims start from real score)
- Remaining possessions (estimated from pace + clock)
- **Per-team 3PT baseline** from season cache (v4 — replaces flat 36%)
- **Q4 pressure adjustments** from clutch profiles (v4 — team-specific Q4 rate deltas)

### What MC Doesn't Know

- Who's on the floor (lineup changes)
- Foul situation (bonus/double bonus)
- Late-game intentional fouling (possession tree breaks down)
- Timeout effects on momentum

---

## Per-Team 3PT Baseline (v4)

### Problem

MC regresses small-sample 3PT% toward a flat 36% league average. GSW (actual 36.1%) barely affected, but BOS (37.2%) is pulled down and ORL (33.9%) is pulled up. The regression is biased.

### Solution

Season cache already has per-player `fg3m`, `fg3a`, `games_played` for all 30 teams. At function cold start, compute team-level 3PT% and cache alongside the existing season priors:

```javascript
// In loadSeasonCache or equivalent
for (const team of Object.keys(seasonCache)) {
  const players = seasonCache[team].players_json;
  let fg3m = 0, fg3a = 0;
  for (const p of players) {
    const gp = Number(p.games_played || 0);
    if (gp < 10) continue;
    fg3m += Number(p.fg3m || 0) * gp;
    fg3a += Number(p.fg3a || 0) * gp;
  }
  seasonCache[team]._team3ptPct = fg3a > 0 ? fg3m / fg3a : 0.36;
}
```

MC's regression step changes from:

```javascript
// Old: flat 36% for everyone
fg3Pct = fg3a >= 3 ? Math.min(samplePct * 0.6 + 0.36 * 0.4, 0.60) : 0.36;

// New: team-specific baseline
const baseline = clutchProfile?.q4_fg3pct || teamSeasonPct || 0.36;
fg3Pct = fg3a >= 3 ? Math.min(samplePct * 0.6 + baseline * 0.4, 0.60) : baseline;
```

**Impact:** Small but correct. Matters most for extreme teams (BOS/GSW high, low-volume shooters low). Eliminates systematic bias.

---

## Clutch Profiles (v4)

### Purpose

Give MC team-specific Q4 rate adjustments. Instead of assuming Q4 shooting rates equal full-game rates, MC models the pressure effect: teams that tighten up in Q4 vs teams that get sloppy.

### Table Schema

```sql
CREATE TABLE IF NOT EXISTS clutch_profiles (
  team_alias TEXT NOT NULL,
  league TEXT NOT NULL DEFAULT 'nba',
  season TEXT NOT NULL DEFAULT '2025',
  games INTEGER DEFAULT 0,
  -- Q4 running totals
  q4_fga INTEGER DEFAULT 0,
  q4_fgm INTEGER DEFAULT 0,
  q4_fg3a INTEGER DEFAULT 0,
  q4_fg3m INTEGER DEFAULT 0,
  q4_fta INTEGER DEFAULT 0,
  q4_ftm INTEGER DEFAULT 0,
  q4_to INTEGER DEFAULT 0,
  q4_oreb INTEGER DEFAULT 0,
  q4_poss REAL DEFAULT 0,
  -- Full-game running totals (for pressure delta computation)
  full_fga INTEGER DEFAULT 0,
  full_fgm INTEGER DEFAULT 0,
  full_fg3a INTEGER DEFAULT 0,
  full_fg3m INTEGER DEFAULT 0,
  full_fta INTEGER DEFAULT 0,
  full_ftm INTEGER DEFAULT 0,
  full_to INTEGER DEFAULT 0,
  full_oreb INTEGER DEFAULT 0,
  full_poss REAL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (team_alias, league, season)
);
```

### Auto-Update (in poll loop at game finalization)

The poll loop already detects game finalization and has quarter_data in memory. When a game goes final:

```javascript
// After final score detected, quarter_data boundaries available
const b3 = quarterData.boundaries['3'];
const b4 = quarterData.boundaries['4'];
if (b3 && b4) {
  for (const side of ['home', 'away']) {
    const teamAlias = side === 'home' ? hA : aA;
    const q4 = {
      fga: Number(b4[side].field_goals_att) - Number(b3[side].field_goals_att),
      fgm: Number(b4[side].field_goals_made) - Number(b3[side].field_goals_made),
      fg3a: Number(b4[side].three_points_att) - Number(b3[side].three_points_att),
      fg3m: Number(b4[side].three_points_made) - Number(b3[side].three_points_made),
      fta: Number(b4[side].free_throws_att) - Number(b3[side].free_throws_att),
      ftm: Number(b4[side].free_throws_made) - Number(b3[side].free_throws_made),
      to: Number(b4[side].turnovers) - Number(b3[side].turnovers),
      oreb: Number(b4[side].offensive_rebounds) - Number(b3[side].offensive_rebounds),
      poss: Number(b4[side].possessions) - Number(b3[side].possessions),
    };
    const full = b4[side]; // Q4 boundary = full-game cumulative
    await sql`
      INSERT INTO clutch_profiles (team_alias, league, season, games,
        q4_fga, q4_fgm, q4_fg3a, q4_fg3m, q4_fta, q4_ftm, q4_to, q4_oreb, q4_poss,
        full_fga, full_fgm, full_fg3a, full_fg3m, full_fta, full_ftm, full_to, full_oreb, full_poss)
      VALUES (${teamAlias}, ${league}, ${'2025'}, 1,
        ${q4.fga}, ${q4.fgm}, ${q4.fg3a}, ${q4.fg3m}, ${q4.fta}, ${q4.ftm}, ${q4.to}, ${q4.oreb}, ${q4.poss},
        ${Number(full.field_goals_att)}, ${Number(full.field_goals_made)},
        ${Number(full.three_points_att)}, ${Number(full.three_points_made)},
        ${Number(full.free_throws_att)}, ${Number(full.free_throws_made)},
        ${Number(full.turnovers)}, ${Number(full.offensive_rebounds)}, ${Number(full.possessions)})
      ON CONFLICT (team_alias, league, season) DO UPDATE SET
        games = clutch_profiles.games + 1,
        q4_fga = clutch_profiles.q4_fga + EXCLUDED.q4_fga,
        q4_fgm = clutch_profiles.q4_fgm + EXCLUDED.q4_fgm,
        q4_fg3a = clutch_profiles.q4_fg3a + EXCLUDED.q4_fg3a,
        q4_fg3m = clutch_profiles.q4_fg3m + EXCLUDED.q4_fg3m,
        q4_fta = clutch_profiles.q4_fta + EXCLUDED.q4_fta,
        q4_ftm = clutch_profiles.q4_ftm + EXCLUDED.q4_ftm,
        q4_to = clutch_profiles.q4_to + EXCLUDED.q4_to,
        q4_oreb = clutch_profiles.q4_oreb + EXCLUDED.q4_oreb,
        q4_poss = clutch_profiles.q4_poss + EXCLUDED.q4_poss,
        full_fga = clutch_profiles.full_fga + EXCLUDED.full_fga,
        full_fgm = clutch_profiles.full_fgm + EXCLUDED.full_fgm,
        full_fg3a = clutch_profiles.full_fg3a + EXCLUDED.full_fg3a,
        full_fg3m = clutch_profiles.full_fg3m + EXCLUDED.full_fg3m,
        full_fta = clutch_profiles.full_fta + EXCLUDED.full_fta,
        full_ftm = clutch_profiles.full_ftm + EXCLUDED.full_ftm,
        full_to = clutch_profiles.full_to + EXCLUDED.full_to,
        full_oreb = clutch_profiles.full_oreb + EXCLUDED.full_oreb,
        full_poss = clutch_profiles.full_poss + EXCLUDED.full_poss,
        updated_at = NOW()
    `;
  }
}
```

### Initial Backfill

One-time script reads the 181 games with quarter_data, diffs Q4-Q3 for both teams, and populates running totals. Can run as a `?phase=backfill_clutch` in mc-backtest.mjs or a db-api action.

### Loading at Runtime

Same pattern as season cache — one query at function cold start:

```javascript
const clutchRows = await sql`SELECT * FROM clutch_profiles WHERE league = 'nba' AND season = '2025'`;
const clutchMap = {};
for (const r of clutchRows) {
  clutchMap[r.team_alias] = {
    games: r.games,
    q4_fg3pct: r.q4_fg3a > 0 ? r.q4_fg3m / r.q4_fg3a : null,
    q4_fg2pct: (r.q4_fga - r.q4_fg3a) > 0 ? (r.q4_fgm - r.q4_fg3m) / (r.q4_fga - r.q4_fg3a) : null,
    q4_to_rate: r.q4_poss > 0 ? r.q4_to / r.q4_poss : null,
    q4_oreb_rate: (r.q4_fga - r.q4_fgm) > 0 ? r.q4_oreb / (r.q4_fga - r.q4_fgm) : null,
    q4_ft_rate: r.q4_fga > 0 ? r.q4_fta / r.q4_fga : null,
    q4_ft_pct: r.q4_fta > 0 ? r.q4_ftm / r.q4_fta : null,
    // Pressure deltas (Q4 rate minus full-game rate)
    delta_fg3: (r.q4_fg3a > 20 && r.full_fg3a > 50)
      ? (r.q4_fg3m / r.q4_fg3a) - (r.full_fg3m / r.full_fg3a) : 0,
    delta_to: (r.q4_poss > 50 && r.full_poss > 200)
      ? (r.q4_to / r.q4_poss) - (r.full_to / r.full_poss) : 0,
  };
}
```

### MC Integration

When MC simulates Q4 possessions, it applies the team's clutch profile:

**For 3PT regression:**
```javascript
// Use Q4-specific 3PT% as baseline when simulating Q4
const period = currentPeriod;
const baseline = period >= 4 && clutchProfile?.q4_fg3pct != null
  ? clutchProfile.q4_fg3pct
  : teamSeasonPct || 0.36;
fg3Pct = fg3a >= 3 ? Math.min(samplePct * 0.6 + baseline * 0.4, 0.60) : baseline;
```

**For pressure adjustments (optional, can ship separately):**
```javascript
// When simulating Q4 possessions, adjust base rates by team's Q4 pressure delta
if (period >= 4 && clutchProfile) {
  rates.toRate = Math.max(0, rates.toRate + (clutchProfile.delta_to || 0));
  // Could also adjust: fg2Pct, orebRate, ftRate
}
```

The 3PT baseline swap is the immediate win. Pressure deltas are a follow-up once we validate Q4 profiles have enough sample (need ~30+ games per team for stable rates).

---

## State Machine & Alert Architecture

*(Unchanged from v3 — included for completeness)*

### State in `live_tracking` JSONB

```javascript
lt.mc = {
  triggered: true,
  trigger_ts: Date.now(),
  trigger_period: 3,
  trigger_clock: '8:42',
  trigger_margin: 7,
  trigger_floor: 0.88,
  trigger_xgb: 0.926,
  trigger_mc: 0.32,
  trigger_stats: {
    home: { fgm, fga, fg3m, fg3a, ftm, fta, to, oreb },
    away: { fgm, fga, fg3m, fg3a, ftm, fta, to, oreb }
  },
  ctrl_team: 'ORL',
  ctrl_is_home: false,
  verdicts: [],
  pattern: null,
  alert_sent: false,
  current_mc: null,
}
```

### MC_COLLAPSE Alert (CLEAN pattern)

Mechanical fire, no agent call, plain English ntfy.

```
PHI 88-75 BOS · Q3 2:01
Structural collapse detected — ORL leading by 9 but post-trigger rates
show sustained deterioration since Q3 8:42. Floor (0.90) and XGB (0.93)
anchored to early game. MC: 4.2%.
[If position: Active A-rank position on ORL — consider exit.]
```

Priority 5 if graduated position, 4 otherwise.

### Agent Context

WAVE → agent context "oscillating, position at risk." NORMALIZED → agent context "investigated and cleared, hold confidence." FALSE_ALARM → silent.

---

## Agent Context Injection

### Context Object

Replace `vulnerabilityWarning: lt._vuln_fired` with:

```javascript
mcInvestigation: lt.mc ? {
  active: lt.mc.triggered,
  pattern: lt.mc.pattern,
  verdicts: lt.mc.verdicts,
  trigger_period: lt.mc.trigger_period,
  trigger_clock: lt.mc.trigger_clock,
  trigger_margin: lt.mc.trigger_margin,
  trigger_floor: lt.mc.trigger_floor,
  trigger_xgb: lt.mc.trigger_xgb,
  trigger_mc: lt.mc.trigger_mc,
  current_mc: lt.mc.current_mc,
  ctrl_team: lt.mc.ctrl_team,
  alert_sent: lt.mc.alert_sent,
} : null,
```

### Agent Rules

```
- MC_COLLAPSE: Fires mechanically on CLEAN pattern. Post-trigger rates show
  sustained collapse that never normalized. 72.6% precision (197 games), 100%
  production playoffs (3 games). Floor and XGB are ANCHORED — weight MC above
  both for EXIT, BWC_EDGE, POSITION_SAFE. If graduated position, frame as exit.

- MC WAVE: Oscillating collapse. 60% precision. RISK signal, not confirmed.
  BWC_EDGE: prominent RISK line. POSITION_SAFE: DOWNGRADE or SUPPRESS.

- MC NORMALIZED: Rates recovered. 86-91% ctrl survives. CONFIDENCE signal —
  MC investigated and cleared. Validates position beyond cumulative indicators.
```

---

## Dead Code Removal: VULNERABILITY

| Location | Code | Action |
|----------|------|--------|
| ~553-558 | VULNERABILITY WARNING prompt section | Replace with MC INVESTIGATION |
| ~770 | VULNERABILITY agent rule | Replace with MC rules |
| ~4700 | `'VULNERABILITY'` in POSITION_TYPES | → `'MC_COLLAPSE'` |
| ~4814 | `'VULNERABILITY':'Vulnerability'` | → `'MC_COLLAPSE':'Structural Collapse'` |
| ~4835 | `'VULNERABILITY':'Vulnerability'` | → `'MC_COLLAPSE':'Structural Collapse'` |
| ~6023 | `'VULNERABILITY': 'VULNERABILITY'` | → `'MC_COLLAPSE': 'MC_COLLAPSE'` |
| ~6155 | `vulnerabilityWarning: lt._vuln_fired` | Replace with mcInvestigation |
| ~7003-7050 | Entire VULNERABILITY block | Remove — MC replaces |

Dead state: `lt._vuln_fired`, `lt._vuln_warnings` — no migration needed.

---

## New DB Schema

```sql
-- MC investigation WP on snapshots
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS mc_win_prob REAL;

-- Clutch profiles (auto-updating)
CREATE TABLE IF NOT EXISTS clutch_profiles (
  team_alias TEXT NOT NULL,
  league TEXT NOT NULL DEFAULT 'nba',
  season TEXT NOT NULL DEFAULT '2025',
  games INTEGER DEFAULT 0,
  q4_fga INTEGER DEFAULT 0, q4_fgm INTEGER DEFAULT 0,
  q4_fg3a INTEGER DEFAULT 0, q4_fg3m INTEGER DEFAULT 0,
  q4_fta INTEGER DEFAULT 0, q4_ftm INTEGER DEFAULT 0,
  q4_to INTEGER DEFAULT 0, q4_oreb INTEGER DEFAULT 0,
  q4_poss REAL DEFAULT 0,
  full_fga INTEGER DEFAULT 0, full_fgm INTEGER DEFAULT 0,
  full_fg3a INTEGER DEFAULT 0, full_fg3m INTEGER DEFAULT 0,
  full_fta INTEGER DEFAULT 0, full_ftm INTEGER DEFAULT 0,
  full_to INTEGER DEFAULT 0, full_oreb INTEGER DEFAULT 0,
  full_poss REAL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (team_alias, league, season)
);
```

---

## Implementation Inventory

### New Functions (in poll-live-bdl.mjs)

| Function | ~Lines | Purpose |
|----------|--------|---------|
| `extractMCRatesFromPossLog()` | 35 | PBP-derived per-team rates from last N possessions |
| `runMonteCarloSim()` | 80 | Per-possession tree sim engine |
| `diffToRates()` | 30 | Post-trigger rates from box score diff |
| `estimateRemainingPoss()` | 15 | Remaining possessions from pace + clock |
| `classifyMCPattern()` | 25 | Pattern from verdict sequence |
| `updateClutchProfile()` | 20 | UPSERT Q4 stats at game finalization |

### Poll Loop Changes

| Component | ~Lines |
|-----------|--------|
| Load clutch profiles at cold start | 15 |
| Compute team 3PT baselines from season cache | 10 |
| MC canary check (Phase 1) | 40 |
| MC investigation (Phase 2) | 50 |
| MC_COLLAPSE alert + ntfy | 30 |
| Clutch profile UPSERT at game finalization | 25 |

### Agent Context + Prompt

| Component | ~Lines |
|-----------|--------|
| gatherAgentContext mcInvestigation | 12 |
| formatSonnetPrompt MC section | 15 |
| Agent rules | 20 |

### Other Files

| File | Change | ~Lines |
|------|--------|--------|
| db-api.js | clutch_profiles table in init, get_clutch_profiles action | 25 |
| mc-backtest.mjs | backfill_clutch phase (one-time, reads 181 games) | 60 |

**Total new code: ~430 lines.** Remove ~62 lines (VULN). **Net: ~370 lines.**

---

## Implementation Order

### Phase A: Clutch Profiles Foundation
1. `clutch_profiles` table in db-api.js init
2. `backfill_clutch` phase in mc-backtest.mjs — seed from 181 games
3. Auto-update UPSERT in poll loop at game finalization
4. Load clutch profiles at cold start

### Phase B: MC Engine + VULNERABILITY Replacement
5. Port MC functions (runMonteCarloSim, diffToRates, estimateRemainingPoss, classifyMCPattern)
6. Add extractMCRatesFromPossLog (PBP-derived canary rates)
7. Per-team 3PT baseline from season cache + clutch profiles
8. Remove VULNERABILITY block + dead state
9. Insert MC canary + investigation
10. MC_COLLAPSE alert + ntfy
11. Agent context + rules
12. Update POSITION_TYPES + readable maps
13. Add snapshots.mc_win_prob column

### Phase C: Dashboard (deferred)
14. MC strip on game cards (badge: Investigating / COLLAPSE / Oscillating / Cleared)

Phase A ships first (can deploy independently — no functional change, just data collection). Phase B ships as a single deploy. Phase C follows.

---

## Verification Plan

### Phase A Verification
- Run backfill_clutch, verify 30 teams populated with reasonable Q4 rates
- Manually check: ORL Q4 from DET@ORL G6 (the collapse game) should show terrible Q4 FG%
- Verify auto-update fires on next game finalization

### Phase B Verification
- Syntax check, grep for remaining VULNERABILITY refs (zero expected)
- Monitor logs for MC canary fires on live slate
- Verify lt.mc persists across polls
- Verify pattern classification progresses correctly
- Confirm MC_COLLAPSE ntfy fires with correct body
- Confirm agent sees MC INVESTIGATION context
- Compare MC regression: team-specific baseline vs old flat 36%

### Regression
- PBP window computation unchanged
- XGB EXIT unchanged
- BWC state machine unchanged
- Graduation system unchanged
