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
- MC_COLLAPSE (CLEAN pattern):
  Fires mechanically. Post-trigger rates show sustained collapse that never
  normalized. 72.6% precision (295 games backtest), 83.3% production (6 games).

  TRUST HIERARCHY depends on XGB agreement (validated, n=295):
    • CLEAN + XGB LOW (<0.50)  = CONFIRMED COLLAPSE. 86.9% precision (n=84).
      Both signals agree ctrl is collapsing. Max conviction EXIT.
    • CLEAN + XGB MED (0.50-0.70) = DEVELOPING COLLAPSE. 70.4% precision (n=108).
      MC is leading, XGB starting to waver. Strong EXIT signal.
    • CLEAN + XGB HIGH (>0.70) = PROBABLE COLLAPSE. 73.8% precision (n=103).
      MC vs XGB disagree. Agent should scrutinize heavily — floor and XGB are
      anchored to stale data, but MC is not infallible here. Frame as high risk,
      not certainty. Do NOT auto-override XGB.

  MARGIN QUALIFIER — ctrl lead at trigger (validated, n=292):
    • Tight (≤3):      81.0% precision (n=179). Highest conviction.
    • Mid (4-8):       72.2% precision (n=79). Standard CLEAN.
    • Comfortable (9-15): 63.3% precision (n=30). Cushion absorbs decay.
    • Blowout (16+):   50.0% precision (n=4). Ignore — noise.
    Average CLEAN trigger margin is only +1.7. Most collapses fire in tight games.
    Agent should weight margin into confidence: CLEAN at +2 is much more urgent
    than CLEAN at +12.

  Floor state at trigger is weakly discriminative (77.6% HIGH vs 75.6% MED) —
  floor does not meaningfully change CLEAN precision. This confirms floor is
  the anchored signal MC was designed to catch.

- MC WAVE: Oscillating collapse. 60% precision. RISK signal, not confirmed.
  BWC_EDGE: prominent RISK line. POSITION_SAFE: DOWNGRADE or SUPPRESS.

- MC NORMALIZED: Rates recovered. 86-91% ctrl survives. CONFIDENCE signal —
  MC investigated and cleared. Validates position beyond cumulative indicators.

- MC as BUY trigger: MC_COLLAPSE on ctrl does NOT justify buying the opponent
  by itself. Validated findings (1,235 games):
    • MC<0.30 + ctrl leading Q4: opponent wins only 49.5% (n=97) — coin flip.
    • MC<0.30 + ctrl floor STILL ANCHORED HIGH (>0.75): opponent wins 25.8% (n=213).
    • MC<0.30 + ctrl floor DROPPING (<0.60): opponent wins 59.9% (n=182).
  MC collapse alone means floor anchoring is masking decay. Only when floor
  ALSO starts dropping (confirming the collapse) does the opponent BUY signal
  become actionable. Agent should treat MC collapse + floor drop as the compound
  BUY trigger, not MC alone.

- MARGIN_COMPRESS context (Q3 more dangerous than Q4):
    • Q3 margin compression (dropped 6+ over 2 checkpoints): ctrl wins 57.1% (n=84).
    • Q4 margin compression: ctrl wins 75.7% (n=37) — less time to complete reversal.
    • MC stacking: when margin compresses AND MC_VERY_LOW (<0.30): ctrl wins 60.0% (n=95).
      When margin compresses but MC neutral (>0.55): ctrl wins 91.7% (n=639).
    MC discriminates well during margin compression — use MC to distinguish
    real collapses from normal variance in close games.
```

---

## Cross-Signal Validation Findings (May 3, 2026)

Eight phases of cross-signal analysis (`cross_concordance` through `cross_deep`) on 1,235 backtest games + 50 production games.

### Temporal AUC — XGB dominates raw prediction at every checkpoint

| Checkpoint | Floor | MC | XGB | Adaptive |
|-----------|-------|-----|-----|----------|
| Q2_END | 0.680 | 0.670 | 0.851 | 0.810 |
| Q3_END | 0.744 | 0.737 | 0.915 | 0.848 |
| Q4_3 | 0.769 | 0.918 | 0.955 | 0.943 |

MC catches up to floor by late Q4 but never beats XGB on raw AUC. MC's value is as a **targeted collapse detector**, not a better overall predictor.

### CLEAN × XGB (n=295 backtest, the spec-defining finding)

| XGB State | N | CLEAN Precision | Interpretation |
|-----------|---|-----------------|----------------|
| XGB LOW (<0.50) — signals agree | 84 | **86.9%** | CONFIRMED COLLAPSE |
| XGB MED (0.50-0.70) — XGB wavering | 108 | 70.4% | DEVELOPING COLLAPSE |
| XGB HIGH (>0.70) — MC vs XGB disagree | 103 | 73.8% | PROBABLE COLLAPSE |

Pattern classification (CLEAN vs NORMALIZED vs FALSE_ALARM) does massive lifting: raw CONFIRMED verdict + XGB_HIGH is a coin flip (53.3%); CLEAN + XGB_HIGH is 73.8%.

### MC Collapse NOT a Standalone BUY Trigger

| Ctrl State at Collapse | N | Opponent Win% |
|------------------------|---|---------------|
| MC<0.30, leading, Q4 | 97 | 49.5% |
| MC<0.30, floor ANCHORED HIGH (>0.75) | 213 | 25.8% |
| MC<0.30, floor DROPPING (<0.60) | 182 | **59.9%** |

BUY trigger requires **MC collapse + floor confirmation (dropping)**. MC alone detects anchoring; floor dropping confirms the collapse is real.

### MARGIN_COMPRESS Timing

| Period | N | Ctrl Win% |
|--------|---|-----------|
| Q3 | 84 | 57.1% |
| Q4 | 37 | 75.7% |

Q3 compression is more dangerous — full quarter remains for opponent to finish reversal. MC discriminates well: MC_VERY_LOW during compression → ctrl wins 60.0% (n=95); MC neutral → ctrl wins 91.7% (n=639).

### Key Design Principles from Validation

1. **MC is a targeted tool, not a better predictor.** Use for collapse detection, not general win probability.
2. **Pattern classification is essential.** Without CLEAN/WAVE/NORMALIZED, MC investigation is noise against XGB consensus.
3. **Trust hierarchy is conditional on XGB agreement**, not blanket "MC > XGB > Floor."
4. **MC collapse + floor alignment = compound BUY trigger.** Neither signal alone is sufficient.
5. **Margin at trigger is the strongest CLEAN precision modifier.** ≤3 = 81%, 9-15 = 63%. Average CLEAN trigger margin is only +1.7 — most collapses fire in tight games where the cushion can't absorb.

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

### Phase C: Dashboard MC Graphic (v3.html)

MC investigation renders inside the **Structural Read** section of each game card, between the window grid (QTR/PBP) and the indicator strip (I1-I5). It uses the existing visual language: window-cell containers, color-coded badges, monospace values.

#### Display States

**Not active (Q1-Q2, or Q3+ with no canary fire):** Nothing rendered. No placeholder. Clean card.

**FALSE_ALARM (canary fired, verdicts never reached LIKELY/CONF):** Nothing rendered. Showing it adds noise with no actionable information.

**INVESTIGATING (canary fired, pattern not yet classified):**

```
┌─────────────────────────────────────────────────┐
│  ◉ MC INVESTIGATING          since Q3 8:42 · +7 │
│  ┌──────────┐  ┌──────────────────────────────┐ │
│  │ MC  38.2%│  │ ○ ○ ○ ·  ·  ·               │ │
│  │ ▓▓▓▓░░░░ │  │ INV INV INV                  │ │
│  └──────────┘  └──────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

- Pulsing amber dot (◉) with `animation: pulse` — same as live chip indicator
- "MC INVESTIGATING" label in amber, mono 9.5px uppercase
- Trigger context right-aligned: "since Q{period} {clock} · +{margin}" in dim mono
- Left cell: MC win prob (mono 14px) + mini meter bar (same as floor meter, 4px tall)
- Right cell: verdict dots — gray circles for INV, building left to right as verdicts arrive
- Container: `window-cell` styling (bg-surface-2, hairline border, r-inner radius)

**CLEAN — Structural Collapse (highest visual weight):**

```
┌─────────────────────────────────────────────────┐
│  ▼ COLLAPSE                  since Q3 8:42 · +7 │
│  ┌──────────┐  ┌──────────────────────────────┐ │
│  │ MC   4.2%│  │ ○ ○ ◆ ◆ ● ● ●              │ │
│  │ ▓░░░░░░░ │  │ INV  CONT LIKELY  CONF      │ │
│  └──────────┘  └──────────────────────────────┘ │
│  XGB: 92% · Margin: +3 → tight (81%)           │
└─────────────────────────────────────────────────┘
```

- Coral down-arrow (▼) with "COLLAPSE" badge — coral color, coral-dim bg, coral-border
- MC win prob in coral (large, prominent)
- Verdict timeline: gray (INV) → amber (CONT) → coral filled (LIKELY/CONF)
- Bottom context line (mono 9px, dim): XGB state at trigger, margin qualifier with precision
- Container border changes to coral-border (1px solid) — visually pops from the card
- If graduated position exists, append: "· Active {rank}-rank on {team}"

**WAVE — Oscillating Collapse:**

```
┌─────────────────────────────────────────────────┐
│  ◈ OSCILLATING               since Q3 8:42 · +5 │
│  ┌──────────┐  ┌──────────────────────────────┐ │
│  │ MC  31.7%│  │ ○ ◆ ● ● ◇ ◇ ◆ ●            │ │
│  │ ▓▓▓░░░░░ │  │ INV CONT CONF NORM CONT CONF │ │
│  └──────────┘  └──────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

- Amber diamond (◈) with "OSCILLATING" badge — amber color
- Verdict timeline shows the wave pattern: coral → green recovery → coral again
- Green circles (◇) for NORM verdicts make the oscillation visually obvious
- Container border: amber-border

**NORMALIZED — Investigated & Cleared:**

```
┌─────────────────────────────────────────────────┐
│  ✓ CLEARED                   Q3 8:42 → Q3 2:15  │
│  MC investigated structural shift — rates        │
│  recovered. Hold validated.                      │
└─────────────────────────────────────────────────┘
```

- Green checkmark (✓) with "CLEARED" badge — green color, green-dim bg
- Single line of context (mono 10px): investigation window Q{start} → Q{end}
- Brief explanation (sans 11px, fg-secondary): "MC investigated structural shift — rates recovered. Hold validated."
- Compact: no meter, no verdict dots. The investigation is over and positive.
- Container: subtle green-border (low visual weight — positive signal shouldn't dominate)

#### Verdict Timeline Implementation

The verdict timeline is the visual signature of the MC graphic. Each verdict is a small circle (8px) with color:

| Verdict | Color | Shape | Meaning |
|---------|-------|-------|---------|
| INV | `var(--fg-dim)` | ○ hollow | Insufficient data |
| CONT | `var(--amber)` | ◆ filled | Contested |
| LIKELY | `var(--coral)` | ● filled | Probable collapse |
| CONF | `var(--coral)` | ● filled (brighter) | Confirmed collapse |
| NORM | `var(--green)` | ◇ hollow | Rates recovered |

Dots are 8px circles with 4px gaps, rendered left-to-right as verdicts arrive. This creates a visual "heartbeat" — a healthy investigation has gray→green (normalized), a collapse has gray→amber→coral (worsening), and a wave shows coral→green→coral (oscillation).

```css
.mc-strip { padding: 10px 12px; margin-bottom: 14px; background: var(--bg-surface-2);
  border: 1px solid var(--hairline); border-radius: var(--r-inner); }
.mc-strip.collapse { border-color: var(--coral-border); background: var(--coral-dim); }
.mc-strip.wave { border-color: var(--amber-border); background: var(--amber-dim); }
.mc-strip.cleared { border-color: var(--green-border); }
.mc-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.mc-badge { font: 600 9.5px/1 var(--sans); letter-spacing: 0.08em; text-transform: uppercase;
  padding: 3px 8px; border-radius: var(--r-pill); }
.mc-badge.investigating { color: var(--amber); background: var(--amber-dim); border: 1px solid var(--amber-border); }
.mc-badge.collapse { color: var(--coral); background: var(--coral-dim); border: 1px solid var(--coral-border); }
.mc-badge.wave { color: var(--amber); background: var(--amber-dim); border: 1px solid var(--amber-border); }
.mc-badge.cleared { color: var(--green); background: var(--green-dim); border: 1px solid var(--green-border); }
.mc-trigger { font: 9.5px var(--mono); color: var(--fg-dim); }
.mc-body { display: grid; grid-template-columns: auto 1fr; gap: 8px; }
.mc-wp { font: 500 14px var(--mono); font-feature-settings: "tnum"; }
.mc-meter { height: 4px; background: var(--bg-surface-3); border-radius: 2px; overflow: hidden; margin-top: 4px; }
.mc-verdict-row { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; padding-top: 2px; }
.mc-dot { width: 8px; height: 8px; border-radius: 999px; }
.mc-context { font: 9px var(--mono); color: var(--fg-dim); margin-top: 6px; }
```

#### Data Flow: Server → Client

`lt.mc` state persists in `live_tracking` JSONB. The client receives it via snapshot polling. The `renderCard` function reads `cs._serverMC` (hydrated from `lt.mc` on the latest snapshot) and renders the appropriate state.

```javascript
// In snapshot hydration (where lt.* fields are read)
if (lt.mc) cs._serverMC = lt.mc;

// In renderCard, after window grid, before indicator strip:
if (cs._serverMC && cs._serverMC.triggered) {
  html += renderMCStrip(cs._serverMC, g, cs);
}
```

#### ~Lines: 80 (CSS) + 60 (renderMCStrip function) = ~140 lines in v3.html

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

### Phase C Verification
- MC strip renders in INVESTIGATING state during active canary (amber pulsing dot)
- CLEAN pattern renders coral container with verdict timeline
- WAVE renders amber container with oscillation visible in dot colors
- NORMALIZED renders compact green "CLEARED" strip
- FALSE_ALARM renders nothing (no noise)
- Verdict dots update in real-time as new snapshots arrive
- Margin qualifier + XGB state show in context line for CLEAN
- Strip disappears cleanly when MC state resets between games

### Regression
- PBP window computation unchanged
- XGB EXIT unchanged
- BWC state machine unchanged
- Graduation system unchanged
