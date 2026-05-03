# MC Production Integration — Architecture Spec (v3)

**Date:** May 3, 2026
**Status:** SPEC — awaiting approval before implementation
**Touches:** `poll-live-bdl.mjs` (primary), `db-api.js` (init), `v3.html` (dashboard)
**Replaces:** VULNERABILITY alert system (dead code removal)

---

## Design Thesis

Monte Carlo is a **graduation guard** — a stateful investigation that detects structural collapse in ctrl-leading games where cumulative signals (floor, XGB) are anchored to stale early-game data. It answers the one question the existing system can't: "this team graduated and is leading, but are they collapsing RIGHT NOW?"

MC replaces VULNERABILITY entirely. The MC canary fire IS the vulnerability detection (wider scope, no XGB gate, any margin), and the investigation that follows is pure upside VULNERABILITY never had — it classifies whether the threat is sustained (CLEAN), oscillating (WAVE), or noise (NORMALIZED/FALSE_ALARM).

---

## How MC Works (Plain English)

### The Canary

Every minute during Q3+, when the ctrl team is leading, the system looks at the last 20 possessions from the PBP log. It extracts exact per-team rates — 2PT%, 3PT%, turnover rate, offensive rebound rate, free throw rate — directly from those 20 possessions. Then it simulates the rest of the game 200 times using those rates plus the actual current score. If the ctrl team wins fewer than 70% of simulations, OR the gap between the cumulative floor and the MC probability exceeds 15%, the canary fires.

### The Investigation

When the canary fires, the system photographs the box score at that exact moment. Every minute after that, it subtracts the photograph from the current box score to get "what has each team produced SINCE the alarm went off." From those diffs it computes post-trigger rates, then simulates the rest of the game 500 times. Each verdict measures ONLY what happened after the alarm — not from game start, not from a rolling window.

### The Pattern

Each minute produces a verdict based on the ctrl team's sim win rate:
- **CONF** (≤25%): "at this rate, they lose"
- **LIKELY** (25-40%): "probably collapsing"
- **CONT** (40-60%): "contested, unclear"
- **NORM** (>60%): "rates recovered"
- **INV** (<8 post-trigger possessions): "not enough data yet"

The pattern classifies the sequence of verdicts:
- **CLEAN**: Hit CONF/LIKELY and never recovered. Sustained collapse. (72.6% precision)
- **WAVE**: Collapsed → recovered → collapsed again. Oscillating. (60% precision)
- **NORMALIZED**: Alarmed but rates recovered. Noise. (86-91% ctrl survives)
- **FALSE_ALARM**: Never reached LIKELY/CONF. False alarm. (91% ctrl survives)

### What MC Knows

- Per-team shooting rates (2PT%, 3PT% regressed to 36% baseline, FT%)
- Turnover rate, offensive rebound rate per team
- Actual current score
- Remaining possessions (estimated from pace + clock)

### What MC Doesn't Know

- **Per-team 3PT baseline** — regresses everyone to 36% league average. GSW should regress to 38%, a bad shooting team to 33%. (Queued improvement — per-team baselines from season cache.)
- **Who's on the floor** — if bench is in, rates reflect bench play. If starters return, rates change.
- **Foul situation** — bonus/double bonus creates more FT possessions than the window rate suggests.
- **Late-game intentional fouling** — trailing team fouls to stop clock. The possession tree breaks down because fouls create FT possessions that skip normal shot attempts.
- **Clutch pressure** — rates under pressure differ from mid-game rates.
- **Timeout effects** — timeouts can reset momentum, change lineup, draw up a play.

---

## Why MC Replaces VULNERABILITY

| Dimension | VULNERABILITY | MC |
|-----------|--------------|-----|
| Margin gate | 0-5 only | Any ctrl-leading margin |
| XGB gate | < 0.65 required | None — catches collapses XGB misses |
| PBP window | 15-poss, binary fire | 20-poss canary, then post-trigger investigation |
| Precision | 47.4% | CLEAN 72.6% (backtest), 100% (prod playoffs) |
| Information | Binary: fired or not | Pattern: CLEAN/WAVE/NORMALIZED/FALSE_ALARM |
| Persistence | Single-shot, one context injection | Multi-cycle investigation with verdict sequence |
| Inverse value | None | NORMALIZED/FALSE_ALARM = 88-91% hold confidence |

---

## Validated Precision (1,235 backtest + 46 playoff production)

| Pattern | Backtest (ctrl-leading) | Production (playoffs) | Action |
|---------|------------------------|-----------------------|--------|
| CLEAN | 72.6% (197 games) | 100% (3 games) | Fire MC_COLLAPSE alert |
| WAVE | 61.1% (18 games) | 60% (5 games) | Agent context — "at risk" |
| NORMALIZED | 86.0% ctrl survives (129) | 100% ctrl survives (2) | Agent context — "noise, hold" |
| FALSE_ALARM | 90.8% ctrl survives (476) | 93.8% ctrl survives (16) | Silent — no action |

---

## Architecture: Stateful Investigation Across Poll Cycles

### State Machine

```
IDLE → [canary fires] → INVESTIGATING → [verdicts accumulate] → CLEAN / WAVE / NORMALIZED / FALSE_ALARM
                              ↑                                          |
                              └─── [each poll adds verdict] ─────────────┘
```

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
  trigger_mc: 0.32,                 // canary MC probability (from 20-poss PBP rates)
  trigger_stats: {                  // box score photograph at trigger for diffToRates
    home: { fgm, fga, fg3m, fg3a, ftm, fta, to, oreb },
    away: { fgm, fga, fg3m, fg3a, ftm, fta, to, oreb }
  },
  ctrl_team: 'ORL',
  ctrl_is_home: false,
  verdicts: [],                     // ['INV','INV','CONF','CONF','CONF']
  pattern: null,                    // CLEAN|WAVE|NORMALIZED|FALSE_ALARM|null
  alert_sent: false,
  current_mc: null,                 // latest investigation MC win prob
}
```

~400 bytes JSONB. Negligible.

---

## Computation Pipeline

### Phase 1: Canary (PBP-derived rates, ~5ms per eligible poll)

**Location:** Replaces VULNERABILITY block (~line 7003-7050).

**Gates:**
- `currentPeriod >= 3`
- `ind.controlTeam !== 'Neither'`
- Ctrl team IS leading (`ctrlMargin > 0`)
- `!lt.mc?.triggered`
- `alertMinsLeft >= 1.0`
- PBP possession log has ≥ 20 possessions

**Rate extraction from PBP log (last 20 possessions):**

```javascript
function extractMCRatesFromPossLog(possLog, windowSize, teamAlias) {
  const window = possLog.slice(-windowSize);
  const teamPoss = window.filter(p => p.team === teamAlias);
  const n = teamPoss.length;
  if (n < 5) return null;  // need minimum possessions

  const fga = teamPoss.reduce((s, p) => s + p.fga, 0);
  const fgm = teamPoss.reduce((s, p) => s + p.fgm, 0);
  const fg3a = teamPoss.reduce((s, p) => s + p.fg3a, 0);
  const fg3m = teamPoss.reduce((s, p) => s + p.fg3m, 0);
  const fta = teamPoss.reduce((s, p) => s + p.fta, 0);
  const ftm = teamPoss.reduce((s, p) => s + p.ftm, 0);
  const tos = teamPoss.reduce((s, p) => s + p.tos, 0);
  const misses = fga - fgm;
  const oreb = teamPoss.reduce((s, p) => s + p.oreb, 0);

  const fg2a = fga - fg3a;
  const fg2m = fgm - fg3m;

  return {
    toRate: tos / n,                                    // TOs per possession
    shotMix3: fga > 0 ? fg3a / fga : 0.30,            // fraction of shots that are 3s
    fg2Pct: fg2a > 0 ? fg2m / fg2a : 0.48,            // 2PT%
    fg3Pct: fg3a >= 3                                   // 3PT% with regression
      ? Math.min(fg3m / fg3a * 0.6 + 0.36 * 0.4, 0.60) // regress toward 36% baseline, cap 60%
      : 0.36,                                           // too few attempts, use baseline
    orebRate: misses > 0 ? oreb / misses : 0.25,       // OREB per miss
    ftRate: fga > 0 ? fta / fga : 0.25,                // FT trips per FGA
    ftPct: fta > 0 ? ftm / fta : 0.76,                // FT%
    _n: n, _fga: fga, _fg3a: fg3a,                    // diagnostics
  };
}
```

This gives MC exactly what it needs at the granularity it operates: per-possession rates from actual possessions. No box score diff approximation, no pace normalization.

**Canary computation:**
1. Extract rates for both teams from last 20 possessions of PBP log
2. Run MC sim (200 sims) using PBP rates + current score + remaining possessions
3. Combined canary: `(floor - mcWinProb) > 0.15 OR mcWinProb < 0.70`

**If canary fires:**
- Photograph current box score stats → `lt.mc.trigger_stats`
- Store canary MC probability → `lt.mc.trigger_mc`
- Store floor, XGB, margin at trigger
- Investigation starts from THIS moment forward (Option A — canary detects, investigation confirms persistence)
- Log: `${matchup}: ★ MC CANARY — floor=${floor} MC=${mcWP} margin=${ctrlMargin}`

### Phase 2: Investigation (box score diff from trigger, ~12ms per poll)

**Location:** Immediately after Phase 1.

**Why box score diff (not PBP) for investigation:**

The investigation asks "what has happened since the alarm fired?" The PBP possession log is a rolling window — it can't isolate "possessions since trigger." Box score stats are cumulative — subtracting the trigger snapshot gives exactly "production since trigger." The two phases use different rate sources because they answer different questions:

- **Canary:** "What's happening RIGHT NOW?" → PBP rolling window (most responsive)
- **Investigation:** "Has the collapse persisted since the alarm?" → Box score diff from fixed trigger point (anchored measurement)

**Computation:**
1. `diffToRates(currentStats, lt.mc.trigger_stats, 0.36, 0.60)` — rates since trigger
2. Count post-trigger possessions: `(homePostFGA + homePostTO + awayPostFGA + awayPostTO) / 2`
3. If `postPoss < 8`: push `INV`, skip sim (insufficient data, ~3-4 minutes from trigger)
4. If `postPoss >= 8`: run MC sim (500 sims) using post-trigger rates
5. Classify verdict:
   - `mcWP > 0.60` → `NORM`
   - `mcWP > 0.40` → `CONT`
   - `mcWP > 0.25` → `LIKELY`
   - `mcWP <= 0.25` → `CONF`
6. Append to `lt.mc.verdicts`, update `lt.mc.current_mc` and `lt.mc.pattern`

**Pattern classification:**
```
No LIKELY or CONF in verdicts → FALSE_ALARM
Has LIKELY/CONF:
  No NORM after first alarm → CLEAN
  NORM after alarm, then re-alarm → WAVE
  NORM after alarm, no re-alarm → NORMALIZED
```

---

## Alert Generation

### MC_COLLAPSE (on CLEAN pattern)

**Trigger:** Pattern = CLEAN AND `!lt.mc.alert_sent` AND ≥ 3 non-INV verdicts.

**Mechanical fire.** No agent call. Plain English ntfy + DB insert.

**Alert type:** `MC_COLLAPSE`

**ntfy body:**
```
PHI 88-75 BOS · Q3 2:01
Structural collapse detected — ORL leading by 9 but post-trigger rates
show sustained deterioration since Q3 8:42. Floor (0.90) and XGB (0.93)
anchored to early game. MC: 4.2%.
[If position: Active A-rank position on ORL — consider exit.]
```

**Priority:** 5 if graduated position exists, 4 otherwise.

### No ntfy for WAVE / NORMALIZED / FALSE_ALARM

Agent context only. WAVE at 60% is too noisy for subscriber alerts.

---

## Agent Context Injection

### Context Object

In `gatherAgentContext()`, replace `vulnerabilityWarning: lt._vuln_fired` with:

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

### Prompt Section

Replace VULNERABILITY WARNING block (~line 553-558) with:

```javascript
${ctx.mcInvestigation?.active ? `
MC STRUCTURAL INVESTIGATION${ctx.mcInvestigation.pattern ? ' — ' + ctx.mcInvestigation.pattern : ' (active)'}:
  Triggered Q${ctx.mcInvestigation.trigger_period} ${ctx.mcInvestigation.trigger_clock}
  when ${ctx.mcInvestigation.ctrl_team} led by ${ctx.mcInvestigation.trigger_margin}.
  Floor at trigger: ${ctx.mcInvestigation.trigger_floor?.toFixed(2)}
  XGB at trigger: ${(ctx.mcInvestigation.trigger_xgb * 100).toFixed(0)}%
  Canary MC at trigger: ${(ctx.mcInvestigation.trigger_mc * 100).toFixed(1)}%
  Current MC win prob: ${ctx.mcInvestigation.current_mc != null
    ? (ctx.mcInvestigation.current_mc * 100).toFixed(1) + '%' : 'investigating...'}
  Verdicts: ${ctx.mcInvestigation.verdicts?.join(' → ') || 'none yet'}
  Pattern: ${ctx.mcInvestigation.pattern || 'classifying...'}` : ''}
```

### Agent Rules (replace VULNERABILITY rule at ~line 770)

```
- MC_COLLAPSE: Fires mechanically when triggered MC investigation reaches CLEAN
  pattern — post-trigger possession rates show sustained deterioration that never
  normalized. Backtest: 72.6% (197 games). Production playoffs: 100% (3 games).
  When you see MC_COLLAPSE in priorAlerts or MC STRUCTURAL INVESTIGATION section,
  the cumulative floor and XGB are ANCHORED to early-game data and do NOT reflect
  current structural reality. Weight MC above floor and XGB for EXIT, BWC_EDGE,
  and POSITION_SAFE decisions. If graduated position exists, frame as exit signal.

- MC WAVE (in MC STRUCTURAL INVESTIGATION): Oscillating collapse — rates collapsed,
  recovered, collapsed again. 60% precision. RISK signal, not confirmed collapse.
  BWC_EDGE: add prominent RISK line. POSITION_SAFE: DOWNGRADE or SUPPRESS.

- MC NORMALIZED: Investigation triggered but rates RECOVERED. CONFIDENCE signal —
  86-91% ctrl survives. Reference for POSITION_SAFE and BWC_EDGE bodies — MC
  investigated and cleared. Structural hold validated beyond cumulative indicators.
```

Update all existing rules that reference "VULNERABILITY in priorAlerts" → "MC_COLLAPSE in priorAlerts" or "MC STRUCTURAL INVESTIGATION section."

---

## Graduation System Interaction

### MC_COLLAPSE + Graduated Position (PO_ACTIVE)
Highest-value scenario. Agent weights MC above graduation badge — badge reflects past control, MC reflects current reality.

### MC_COLLAPSE + TRACKING (Pre-Graduation)
Early flip buy signal. Existing FLIP BUY logic evaluates opponent independently. MC provides the EXIT signal.

### MC NORMALIZED + Graduated Position
Confidence boost — "MC investigated and cleared." Context enrichment for POSITION_SAFE bodies.

---

## Dead Code Removal: VULNERABILITY

### poll-live-bdl.mjs — Remove

| Lines (approx) | Code | Action |
|-----------------|------|--------|
| 553-558 | `${ctx.vulnerabilityWarning ? ...}` prompt section | Replace with MC INVESTIGATION section |
| 770 | VULNERABILITY agent rule (~5 lines) | Replace with MC rules |
| 4700 | `'VULNERABILITY'` in POSITION_TYPES | Replace with `'MC_COLLAPSE'` |
| 4814 | `'VULNERABILITY':'Vulnerability'` in _alertReadable | Replace with `'MC_COLLAPSE':'Structural Collapse'` |
| 4835 | `'VULNERABILITY':'Vulnerability'` in _alertReadableW | Replace with `'MC_COLLAPSE':'Structural Collapse'` |
| 6023 | `'VULNERABILITY': 'VULNERABILITY'` in alert type map | Replace with `'MC_COLLAPSE': 'MC_COLLAPSE'` |
| 6155 | `vulnerabilityWarning: lt._vuln_fired` | Replace with `mcInvestigation: lt.mc ? {...} : null` |
| 7003-7050 | Entire VULNERABILITY block (~47 lines) | Remove — MC canary + investigation replaces |

### Dead State in live_tracking

| Key | Action |
|-----|--------|
| `lt._vuln_fired` | Dead — replaced by `lt.mc` |
| `lt._vuln_warnings` | Dead — replaced by `lt.mc.triggered` gate |

No migration needed — runtime JSONB fields reset each game.

### Other Files

| File | Reference | Action |
|------|-----------|--------|
| `v3.html` | VULNERABILITY in alert rendering labels | Update to MC_COLLAPSE / Structural Collapse |
| `post-game-agent.mjs` | If VULNERABILITY in arc scoring | Update to MC_COLLAPSE |

---

## New DB Schema

```sql
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS mc_win_prob REAL;
```

Populated when MC investigation is active. NULL otherwise.

---

## Implementation Inventory

### New Functions

| Function | ~Lines | Purpose |
|----------|--------|---------|
| `extractMCRatesFromPossLog()` | 35 | PBP-derived per-team rates from last N possessions |
| `runMonteCarloSim()` | 80 | Per-possession tree sim engine |
| `diffToRates()` | 30 | Rates from box score stat diffs, 3PT regression |
| `estimateRemainingPoss()` | 15 | Remaining possessions from pace + clock |
| `classifyMCPattern()` | 25 | Pattern from verdict sequence |
| **Total functions:** | **~185** | |

### Poll Loop Integration

| Component | ~Lines |
|-----------|--------|
| Canary check (Phase 1) | 40 |
| Investigation (Phase 2) | 50 |
| MC_COLLAPSE alert fire + ntfy | 30 |
| **Total poll loop:** | **~120** |

### Context + Prompt

| Component | ~Lines |
|-----------|--------|
| gatherAgentContext mcInvestigation | 12 |
| formatSonnetPrompt MC section | 15 |
| Agent rules | 20 |
| **Total context:** | **~47** |

**Net code change:** Remove ~47 lines (VULN block) + ~15 lines (VULN refs). Add ~352 lines. **Net: +290 lines.**

---

## Implementation Order

1. Port MC functions (top of poll-live-bdl.mjs near utilities)
2. Add `extractMCRatesFromPossLog()` (new — uses PBP log structure)
3. Remove VULNERABILITY block (~7003-7050) and dead state refs
4. Insert MC canary + investigation in same location
5. MC_COLLAPSE alert fire — DB insert + ntfy
6. Agent context — replace vulnerabilityWarning with mcInvestigation
7. Agent rules — replace VULNERABILITY with MC rules
8. Update POSITION_TYPES + readable maps
9. Add `snapshots.mc_win_prob` column in db-api.js init
10. Dashboard MC strip (deferred)

Steps 1-9 = single deploy.

---

## Verification Plan

### Pre-Deploy
- Syntax check
- Grep for remaining VULNERABILITY/vuln references (zero expected)
- Unit test: feed known PBP log to extractMCRatesFromPossLog, verify rates

### Post-Deploy (live slate dry run)
- Monitor logs for MC canary fires
- Verify lt.mc persists across polls
- Verify pattern classification progresses
- Confirm MC_COLLAPSE ntfy body is plain English
- Confirm agent sees MC INVESTIGATION context
- Confirm no VULNERABILITY references remain

### Regression
- PBP window computation still works (shared infra, different consumer)
- XGB EXIT unaffected
- BWC state machine unaffected
- Graduation system unaffected
