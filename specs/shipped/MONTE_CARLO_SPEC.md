# Monte Carlo Possession Simulation Engine

## The Problem

XGB is a **snapshot model** — it sees 13 stat differentials at one moment with zero memory. When a team builds a 22-point lead, the `biglead` feature locks at that value permanently and overwhelms all other features, even as the opponent takes over every structural dimension. XGB fights the trajectory because it has no concept of trajectory.

DET@ORL Game 6 (May 1): PBP window detected DET's structural takeover at Q3 9:17 (PBP=0.27). XGB sat above 0.90 for another 15 minutes, anchored on biglead. The lead compressed from 22→0 while XGB insisted ORL was dominant. By the time XGB acknowledged reality, the game had already flipped.

**What's needed:** A model that answers "given CURRENT production rates, what happens in the remaining possessions?" — not "what does this snapshot look like historically?"

## The Solution

Monte Carlo possession simulation. Take each team's **rolling window rates** (not cumulative), model each remaining possession as a probability distribution, simulate 1,000 games forward from the current score and clock. Output a win probability distribution, not a point estimate.

## Why Monte Carlo vs Other Approaches

| Approach | Strength | Weakness |
|----------|----------|----------|
| XGB + PBP feature | Learns PBP signal | Still a snapshot, biglead still anchors, no trajectory memory |
| LSTM/Transformer | Sees sequences | Needs massive training data, 22-pt collapses are rare events |
| Monte Carlo | Uses current rates directly, gives distributions, no training needed | Assumes rates are stationary over remaining game |
| Deterministic TP | Fast, simple | One path, no variance modeling, no win probability |

Monte Carlo is **TP v2** — instead of one deterministic "can they close the gap," run 1,000 randomized games from this moment and report the distribution.

## Existing Infrastructure We Leverage

Everything needed already exists in `poll-live-bdl.mjs`:

1. **Rolling window rates** (`computeServerWindow`): Per-team cross-faded stats over recent 1.5-2 quarters. Weighted by recency. Already computed every poll cycle.

2. **Quarter data diffs** (`readQuarterData`): Per-quarter stat breakdowns. Boundaries captured at transitions.

3. **Possession estimation** (`computeSwingCoreServer`): Already estimates remaining possessions from elapsed pace.

4. **PBP 15-possession window** (`computePossWindowServer`): Micro-rates over last 15 possessions. Most recent signal available.

5. **Sustainability data** (`sust`): 3PT regression expectations, personnel shooting quality.

## Simulation Model

### Per-Possession Outcome Tree

Each possession for a team follows this decision tree:

```
POSSESSION START
  ├─ TURNOVER? (rate: TO / poss from window)
  │   └─ Yes → 0 points, opponent ball
  │   └─ No ↓
  ├─ SHOT TYPE: 2PT vs 3PT (rate: FG3A / FGA from window)
  │   ├─ 3PT attempt
  │   │   ├─ Make (rate: 3P% — REGRESSED toward season avg via sust data)
  │   │   │   → 3 points
  │   │   └─ Miss → OREB check
  │   └─ 2PT attempt
  │       ├─ Make (rate: 2P% from window)
  │       │   → 2 points
  │       └─ Miss → OREB check
  ├─ OREB CHECK (only on miss)
  │   ├─ OREB (rate: OREB / (FGA - FGM) from window)
  │   │   → new possession for same team (recursive, max 1 extra)
  │   └─ No OREB → opponent ball
  ├─ AND-ONE / FTA (independent of shot outcome)
  │   └─ FTA awarded? (rate: FTA / poss from window)
  │       └─ Yes → score FT_MADE (rate: FT% from window) per attempt
  │           (simplified: 2 FTA per foul event × FT%)
```

### Rate Extraction

For each team, extract from the **most recent data source available**, with preference:

1. **PBP 15-possession window** (if available and fresh): Most responsive signal, but may be noisy with small sample. Use for TO rate and scoring rate as sanity check.

2. **Rolling window** (primary): Cross-faded 1.5-2 quarter rates from `computeServerWindow`. This is the workhorse — recent enough to capture shifts, large enough sample to be stable.

3. **Cumulative** (fallback for Q1/early Q2 when window isn't available): Full-game stats from `summary.home/away.statistics`.

**Rates to extract per team:**

```javascript
{
  possRate:     possessions / minutes,        // pace
  toRate:       turnovers / possessions,       // turnover probability per possession
  fg3aShare:    three_points_att / field_goals_att,  // 3PT attempt share
  fg3Pct:       three_points_made / three_points_att, // 3PT% (REGRESSED — see below)
  fg2Pct:       (FGM - FG3M) / (FGA - FG3A),  // 2PT%
  orebRate:     off_rebounds / (FGA - FGM),     // OREB rate on misses
  ftaRate:      free_throws_att / possessions,  // FTA rate per possession
  ftPct:        free_throws_made / free_throws_att, // FT%
  ppp:          points / possessions,           // points per possession (validation check)
}
```

### 3PT Regression

Critical: raw live 3PT% is noisy and mean-reverts. Use sustainability data to regress:

```
regressed3Pct = (live3Pct × sampleWeight) + (season3Pct × (1 - sampleWeight))
sampleWeight  = min(0.7, (attempts / 30))  // 30 3PA to reach 70% weight on live
```

Season baseline comes from `sust.seasonPrior`. This prevents a team shooting 50% from 3 on 8 attempts from being projected to maintain that rate.

### Remaining Possessions

From `computeSwingCoreServer` logic:
```
avgPoss    = (homePoss + awayPoss) / 2
possPerMin = avgPoss / minutesElapsed
remainPoss = possPerMin × minutesRemaining  // per team
```

Minutes remaining: `(4 - currentPeriod) × 12 + clockMinutes` (NBA).

### Simulation Loop

```
for sim = 1 to 1000:
    homeScore = currentHomePoints
    awayScore = currentAwayPoints
    homePossLeft = remainingPossPerTeam
    awayPossLeft = remainingPossPerTeam

    // Alternate possessions (coin flip for first possession)
    homeHasBall = random() < 0.5
    while homePossLeft > 0 || awayPossLeft > 0:
        team = homeHasBall ? home : away
        rates = homeHasBall ? homeRates : awayRates
        ptsScored = simulatePossession(rates)
        if homeHasBall: homeScore += ptsScored; homePossLeft--
        else: awayScore += ptsScored; awayPossLeft--
        homeHasBall = !homeHasBall  // alternate

    record(homeScore, awayScore)
```

### simulatePossession(rates)

```
function simulatePossession(rates):
    // Turnover check
    if random() < rates.toRate: return 0

    // FTA check (simplified: independent of shot, ~1 FTA event per possession at rate)
    ftPoints = 0
    if random() < rates.ftaRate / 2:  // /2 because ftaRate counts individual FTs
        ftPoints = (random() < rates.ftPct ? 1 : 0) + (random() < rates.ftPct ? 1 : 0)

    // Shot type
    shotPoints = 0
    isMake = false
    if random() < rates.fg3aShare:
        // 3PT attempt
        isMake = random() < rates.fg3Pct
        if isMake: shotPoints = 3
    else:
        // 2PT attempt
        isMake = random() < rates.fg2Pct
        if isMake: shotPoints = 2

    // OREB on miss → bonus attempt (simplified: 2PT at fg2Pct)
    if !isMake && random() < rates.orebRate:
        if random() < rates.fg2Pct: shotPoints = 2

    return shotPoints + ftPoints
```

## Output

```javascript
{
  // Core
  winProb:          0.34,     // fraction of sims ctrl team wins
  medianMargin:     +4,       // median final margin (ctrl-relative)
  currentMargin:    +17,      // for reference

  // Distribution
  margin10pct:      -8,       // 10th percentile final margin
  margin90pct:      +16,      // 90th percentile final margin

  // Actionable signals
  collapseProb:     0.23,     // fraction of sims where leading team loses lead
  blowoutProb:      0.41,     // fraction of sims margin stays > 10

  // Metadata
  simCount:         1000,
  rateSource:       'window', // or 'cumulative' or 'pbp'
  remainingPoss:    62,       // estimated remaining possessions per team
}
```

### Key Derived Signals

**`collapseProb`** — For the DET@ORL case: at Q3 9:17, cumulative says ORL 97%, but MC using window rates might show collapseProb = 0.35 (35% of simulations show DET taking the lead). That's the actionable signal.

**`winProb` vs XGB** — When MC winProb diverges significantly from XGB, it means current rates don't support the cumulative picture. The divergence IS the signal.

**`margin10pct`** — "Even in a bad scenario, what's the floor?" If you're up 17 but margin10pct is -3, that lead is fragile.

## Integration

### 1. Computation Location

New function `runMonteCarloSim(summary, qd, sust, ind, period, clock, league, pbpResult)` in `poll-live-bdl.mjs`. Pure function, no DB, no side effects.

**When to compute:**
- Every poll cycle where rolling window is available (Q2+)
- ~1,000 sims × ~60 possessions × simple arithmetic = <50ms. Well within serverless budget.

### 2. Agent Context (v2Ctx + buildV2AgentPrompt)

Add `monteCarlo` field to v2Ctx. Agent prompt renders:

```
MONTE CARLO SIMULATION (1,000 games from current rates):
MC win probability: 34% (XGB: 92%, Floor: 0.95)
Median final margin: +4 (current: +17)
Collapse probability: 23% (sims where lead is lost)
10th/90th percentile margin: -8 to +16
Rate source: rolling window (2.1 quarters)
WARNING: MC sees 58% lower win probability than XGB — current production rates
do not support the cumulative structural picture. Lead is compressing.
```

### 3. Agent Rules

```
- MONTE CARLO SIMULATION: When provided, MC uses CURRENT production rates (not cumulative)
  to simulate 1,000 remaining games. Key signals:
  - MC winProb << XGB: cumulative stats are stale, current rates favor opponent. Elevate scrutiny.
  - MC winProb >> XGB: current rates stronger than cumulative picture. Structural edge may be emerging.
  - collapseProb > 0.25: leading team has >25% chance of losing the lead at current rates. RISK flag.
  - MC winProb and XGB aligned: both views agree. High confidence in the structural picture.
  MC is most valuable for BUY (is the deficit actually closeable at current rates?),
  BWC_EDGE (is this lead sustainable?), and EXIT decisions (has the structural picture shifted?).
  For POSITION_OPEN, MC collapseProb > 0.30 = flag as RISK, not auto-SUPPRESS.
```

### 4. Auto-Analysis (formatSonnetPrompt)

Add MC section after XGB conviction quality. Sonnet analysis gains:
- MC win probability vs floor vs XGB (three-way comparison)
- Collapse probability for FWP calibration
- MC-XGB divergence as leading indicator of cumulative anchoring

### 5. Dashboard (v3.html)

**New data point on XGB chart or snapshot history:** MC win probability line (or overlay). Color-coded when diverging from XGB.

**Or simpler:** MC summary in the deep-dive panel: "MC: 34% win | Collapse: 23% | Margin range: -8 to +16"

### 6. Snapshot Storage

Add `mc_win_prob` and `mc_collapse_prob` columns to snapshots table. Lightweight — two floats per snapshot. Enables historical analysis of MC accuracy vs XGB accuracy.

### 7. Alerts

**MC-XGB Divergence Alert** (future — evaluate after live observation):
When MC winProb diverges from XGB by >30 percentage points for 2+ consecutive polls, the cumulative picture is stale. This is the mechanical version of what PBP window detected in the DET@ORL game.

Not shipping as an alert initially — inject into agent context and let the agent use it for SEND/SUPPRESS decisions. Graduate to mechanical alert after backtesting.

## Performance

**1,000 simulations × ~60 remaining possessions × 5 operations per possession = 300,000 random() calls.**

JavaScript `Math.random()` handles this in <20ms. No external dependencies. No model loading. No tree traversal. Just arithmetic and random number generation.

Total added latency per poll cycle: **<50ms** including rate extraction and output aggregation.

## Validation Plan

### Accuracy Test

Replay against `nba_snapshot_backtest` (16,910 snapshots, ~1,235 games):
1. At each snapshot, extract rolling window rates, run MC sim
2. Compare MC win probability vs actual game outcome
3. Compare MC accuracy vs XGB accuracy, especially in games with >15-point leads that collapsed

### Key Metrics

- **MC AUC** vs **XGB AUC** overall
- **MC AUC in lead-change games** (games where one team led by 10+ and lost) — this is where MC should dominate
- **MC-XGB divergence as collapse predictor** — when MC << XGB, how often does the lead actually compress?
- **Calibration** — is MC 34% really 34%?

### Expected Outcome

MC should underperform XGB in blowouts (where cumulative anchoring is correct — the dominant team stays dominant). MC should dramatically outperform XGB in competitive games where momentum shifts, especially in Q3/Q4 lead compressions.

The combination of both signals should be more powerful than either alone.

## What Changes

| Component | Change |
|-----------|--------|
| poll-live-bdl.mjs | New function `runMonteCarloSim()` (~80-100 lines) |
| poll-live-bdl.mjs | Add `monteCarlo` to v2Ctx + calibration ctx |
| poll-live-bdl.mjs | Add MC section to `buildV2AgentPrompt()` + rules |
| poll-live-bdl.mjs | Add MC section to inline prompt in `runAlertAgent()` + rules |
| poll-live-bdl.mjs | Add MC section to `formatSonnetPrompt()` |
| poll-live-bdl.mjs | Add MC section to `SONNET_SYSTEM_PROMPT` |
| db-api.js | Add `mc_win_prob`, `mc_collapse_prob` columns to snapshots (via init) |
| v3.html | MC summary in deep-dive panel (Phase 2) |

## What Does NOT Change

- XGB model, inference, thresholds, SHAP
- Conviction quality / trajectory signals
- Floor computation, indicators, sustainability
- Alert mechanical gates
- Position/EXIT logic
- Checkpoint graduation
- VULNERABILITY alert
- PBP window computation
- Learning agent

## Build Order

1. **`runMonteCarloSim()` function** — pure function, rate extraction + simulation loop + output aggregation
2. **Agent context injection** — v2Ctx + calibration ctx + both prompt paths
3. **Snapshot storage** — two new columns, save on every snapshot
4. **Backtest replay** — validate accuracy before relying on it for decisions
5. **Dashboard rendering** — after live observation confirms value

## Open Questions

1. **Rate blending:** Pure rolling window, or blend with PBP 15-possession window for micro-sensitivity? PBP is noisier but more responsive. Possible: use PBP when it diverges >0.20 from window as a "momentum override" multiplier.

2. **Shooting regression strength:** How aggressively to regress 3PT% toward season average? Too aggressive = model ignores hot shooting nights. Too conservative = model overreacts to small-sample streaks.

3. **Pace adjustment:** Should remaining possessions account for game-state pace changes? (Teams play faster when trailing in Q4, slower when leading.) Currently uses constant pace from elapsed game.

4. **Overtime handling:** If sims end tied, simulate 5-min OT with same rates? Or count ties as 0.5 wins?

5. **Alert threshold:** At what MC-XGB divergence should we flag it in the agent prompt? 20 points? 30 points? Need backtest data to calibrate.
