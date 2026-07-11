# WNBA Prompt & Alert Parity Spec (v2 — with backtest findings)
**Date:** May 8, 2026
**Status:** READY FOR IMPLEMENTATION
**Goal:** NBA-parity agent prompts for WNBA — every decision rule backed by WNBA data.
**Sources:** `research/2026-05-08-wnba-architecture-research.md` + `research/2026-05-08-wnba-prompt-backtests.md`

---

## Overview

Two prompts need WNBA branches:
1. **`SONNET_SYSTEM_PROMPT`** (~130 lines) — auto-analysis at quarter transitions
2. **`buildV2AgentPrompt`** (~400 lines) — alert reasoning agent (SEND/SUPPRESS/DOWNGRADE)

**Approach:** Both prompts become league-aware. NBA text stays byte-identical. WNBA gets data-backed replacements for every section. All numbers below come from 312-game backtest (3,432 checkpoints).

---

## Section 1: Validated WNBA Prompt Text (ready to inject)

### 1A. Signal Trust Hierarchy
```
WNBA SIGNAL TRUST HIERARCHY (3,432 checkpoints, 312 games):
  Three signals, fundamentally different roles from NBA:
  - MC Cum: Best single predictor (AUC 0.822). Wins every checkpoint from Q2_5 onward.
  - XGB: Structural quality + collapse detector (AUC 0.809). 3x floor discrimination on losses.
  - Floor: Narrative context ONLY. When floor disagrees with MC+XGB, floor is wrong 80%.

  When they DISAGREE:
  Q2: XGB > MC > Floor. MC overconfident by ~20pp (same as NBA Q2). Use MC as early warning only.
  Q3: MC > XGB > Floor. MC best calibrated (0.6-0.7 bucket: actual 65.2%, perfect).
  Q4: MC >> XGB >> Floor. MC UNDERESTIMATES in WNBA Q4 (unlike NBA).
    MC 0.7-0.8 = actual 89.2% (+14pp). MC 0.8-0.9 = actual 93.3% (+8pp).
    Structural advantages hold MORE reliably in WNBA's shorter 40-min games.
    A 75% MC Cum in WNBA Q4 is functionally ~89% — treat as strong hold.

  CRITICAL DIFFERENCE FROM NBA: Floor is NEVER a decision gate in WNBA.
  Floor HIGH + MC+XGB LOW = 20.2% accuracy (floor confidently wrong).
  MC+XGB HIGH + Floor LOW = 83-86% (compound correct regardless of floor).
  When MC investigation active (CLEAN/WAVE): MC PBP > everything (same as NBA).
```

### 1B. Conviction Combos
```
WNBA conviction (203-game validated):
  DOMINANT = I3+I4 pair AND 3+ total indicators, OR 4+ indicators. 99.1% when I3+I4.
  STRONG = I3+I4 (99.1%), I3+I2, or I4+I2 killer pairs.
  MODEST = 2+ indicators without killer pairs.
  CONDITIONAL = 1 indicator only.
  NO ENTRY = 0 indicators.

  Key differences from NBA:
  - I3 (Shot Quality, 30% weight) is the anchor (NBA: I4 at 30%)
  - I4+I5 is NOT a killer pair (I5 has 0.500 AUC — no signal)
  - I2 measures perimeter/FT access (not paint/rim — paint is noise in WNBA)
  - Turnovers are INVERSE — more TOs = more aggressive = winning
```

### 1C. Compound Thresholds
```
WNBA compound: MC Cum >= 0.85 AND XGB >= 0.60 (floor is narrative, not gated).
  Establishment: MC >= 0.85 + XGB >= 0.60, Q2+.
  Sustain: Same thresholds, 5 consecutive holds.
  Overall accuracy: 90.9% (89.6% Q2-confirmed, 93.2% Q3-confirmed).
  LOCKED (5+ sustained holds, 0 flips): 94.8% (n=153).
  Coverage: 82% of games reach confirmation.
```

### 1D. XGB Feature Context
```
WNBA XGB (12 features, AUC 0.809, no biglead):
  Top SHAP drivers: assists, FT made, assist ratio, defensive rebounds (windowed), 3PT attempts.
  No biglead — excluded by design (circular with winning, 4x SHAP anchoring).
  No "scoreboard confirmation" concept — all features are box-score structural.
  Cumulative features (c_*) carry the weight; windowed features (w_*) detect recent shifts.
  Cumulative-dominated conviction: 84.0% accuracy. Windowed-dominated: 80.3% (3.7pp gap).

  Reading SHAP:
  - Strong assists + FT made = ball movement + aggression — sustainable edge.
  - Strong windowed features only = recent shift, not yet cumulative — watch for confirmation.
  - Near-zero for most features = structural edge is thin regardless of MC/floor.
```

### 1E. EXIT
```
WNBA EXIT: XGB < 0.45 (flat, 2-poll confirmed) + MC Cum < 0.70 gate.
  Overall accuracy: 70.1% (n=67).
  Floor confirms EXIT when low: floor < 0.55 at EXIT = 100% correct (n=8).
  Floor does NOT deny EXIT when high: floor 0.70+ at EXIT = only 66.7% correct.
  Same mechanical thresholds as NBA — already implemented.
```

---

## Section 2: Backtest Findings

### 2A. Close Game Accuracy
| Margin at confirmation | Accuracy | n |
|----------------------|----------|---|
| <= 4 | 72.2% | 36 |
| <= 6 | 65.8% | 73 |
| <= 8 | 69.4% | 108 |
| <= 10 | 71.8% | 149 |

**For prompt:** "Close games (margin <= 8): ~70%. Shorter 40-min games give structural edges less time to express."

### 2B. BUY Trailing Evidence (262 trailing checkpoints, 266 confirmed games)

**Deficit depth:**
| Deficit | Comeback % | n | vs NBA |
|---------|-----------|---|--------|
| Trail 1-4 | 38.6% | 197 | NBA 44.6% |
| Trail 5-9 | 23.8% | 63 | NBA 25% |
| Trail 10+ | 0.0% | 2 | Same |

**By indicator count (trailing):**
| Ctrl indicators | Comeback % | n |
|----------------|-----------|---|
| 0 | 11.1% | 27 |
| 1 | 35.4% | 144 |
| 2 | 41.7% | 84 |
| 3+ | 28.6% | 7 |

**Power pairs (trailing):**
| Pair | Comeback % | n | Role |
|------|-----------|---|------|
| **I2+I3** | **44.8%** | 67 | **WNBA BUY ANCHOR** |
| I1+I2 | 33.3% | 15 | Marginal |
| I1+I3 | 26.1% | 23 | **TRAP** |

**I3 Inversion (OPPOSITE of NBA):**
| Ctrl I3 | Comeback % | n |
|---------|-----------|---|
| WON | 39.2% | 166 |
| LOST | 17.6% | 17 |

NBA: lost I3 = 49% (variance thesis). WNBA: lost I3 = 17.6%. I3 at 30% weight IS the structural foundation — losing it is not a cold streak, it's losing the core.

**Opponent kills:**
| Opponent wins | Comeback % | n |
|--------------|-----------|---|
| Opp I1 (disruption) | 39.1% | 87 |
| **Opp I2 (perimeter/FT)** | **27.9%** | 61 |

### 2C. XGB BUY Quarter Gates

**Q2 (n=106):**
| XGB | Comeback % | n | Action |
|-----|-----------|---|--------|
| <0.35 | 24.5% | 53 | Suppress |
| 0.35-0.45 | 27.3% | 22 | Suppress |
| 0.45-0.55 | 35.7% | 14 | Marginal |
| 0.55+ | 92.3% | 17 | Strong |

**Q3 (n=92):**
| XGB | Comeback % | n | Action |
|-----|-----------|---|--------|
| <0.35 | 5.3% | 38 | Hard suppress |
| 0.35-0.45 | 25.0% | 12 | Suppress |
| 0.45-0.55 | 50.0% | 10 | Viable |
| 0.55+ | 90.6% | 32 | Strong |

**Q4 (n=64) — WNBA Q4 BUY IS NEARLY DEAD:**
| XGB | Comeback % | n | Action |
|-----|-----------|---|--------|
| <0.45 | 2.0% | 44 | **Absolute hard suppress** |
| 0.45-0.70 | 33.3% | 12 | Cautionary |
| 0.70+ | 75.0% | 8 | Only viable bucket |

### 2D. EXIT Floor Confirmation
| Floor at EXIT | Correct % | n |
|--------------|-----------|---|
| < 0.55 | 100% | 8 |
| 0.55-0.70 | 65.7% | 35 |
| 0.70+ | 66.7% | 24 |

### 2E. Conviction Quality
| Basis | Accuracy | n |
|-------|----------|---|
| Cumulative-dominated (>60%) | 84.0% | 488 |
| Windowed-dominated (>60%) | 80.3% | 543 |

3.7pp gap — softer than NBA's volatile/structural split.

---

## Section 3: Prompt Implementation — Exact Changes

### 3A. `SONNET_SYSTEM_PROMPT` -> `getSonnetSystemPrompt(league)`

Convert from `const` to function. NBA returns current string verbatim.

**WNBA replacements by section:**

| Section | NBA (keep) | WNBA replacement |
|---------|-----------|-------------------|
| Opening line | "NBA structural analyst" | "WNBA structural analyst" |
| Conviction combos | I4+I5=100%, I3+I4=99%, I3+I5=96% | Section 1B text |
| XGB quality | Biglead, volatile/structural NBA features | Section 1D text |
| Trust hierarchy | NBA AUCs, Q2:Floor~XGB>MC, Q4:MC>XGB>Floor | Section 1A text |
| MC investigation | Same for both | No change |
| Paint data note | "SR often delays paint..." | Remove (paint not used) |
| Sustainability STALLED | 2PT baseline 52% | 2PT baseline 46% |

**Callsite:** `system: SONNET_SYSTEM_PROMPT` -> `system: getSonnetSystemPrompt(league)`

### 3B. `buildV2AgentPrompt` — branched sections

`ctx.league` already in scope. Each section gets `if (ctx.league === 'wnba')` branch.

| Section | Line | WNBA text |
|---------|------|-----------|
| Trust hierarchy | ~703 | Section 1A |
| TRACKING rule | ~722 | "MC Cum (>=0.85) AND XGB (>=0.60) confirm — floor is narrative" |
| POSITION_OPEN tiers | ~724-731 | "90.9% overall. LOCKED 94.8%. Q2_EARLY 89.6%. RECOVERING: note 40-min less recovery time." |
| Close game | ~737 | "~70% in close games (margin <= 8). Shorter format, less compounding." |
| Post-EXIT re-entry | ~736 | "MC >= 0.85 + XGB >= 0.60 to re-establish" |
| BUY evidence | ~762-780 | Full Section 2B text (deficit, pairs, I3 anti-inversion, opp kills, Q4 dead) |
| BWC warm BUY | ~772 | "MC >= 0.85 + XGB >= 0.60 at establishment" |
| EXIT confirmation | ~834 | Section 2D text (floor confirms low, doesn't deny high) |
| BWC + I4 EVEN | ~921 | "I4 at 25% — less pivotal. Focus on I3 (30% anchor)." |
| XGB_INVALIDATED | ~935 | Port NBA gates initially, note Q4 is much harsher |
| CANDIDATE rule | ~939 | "I3 COMBO (I3 decisive + 1 other)" |
| Conviction quality | ~817-835 | Section 1D (no biglead, cumulative 84% vs windowed 80%) |

### 3C. Alert Threshold Adjustments (mechanical gates in poll loop)

| Gate | Current | WNBA change | Rationale |
|------|---------|-------------|-----------|
| BUY trailing max | 1-15 | **1-9** | Trail 10+ = 0%. No structural case in 40-min game. |
| XGB BUY gates | Q2<0.40, Q3<0.45, Q4<0.60 | **Q2<0.45, Q3<0.45, Q4<0.70** | Backtest 2C: Q2 0.35-0.45=27%, Q3 same. Q4 only 0.70+ viable. |
| BUY floor | >= 0.65 | Keep | Floor still computed; threshold means strong indicator agreement |
| XGB EXIT | 0.45 flat | Keep | Validated for WNBA |

---

## Section 4: Implementation Order

1. `getSonnetSystemPrompt(league)` — convert const, WNBA branch
2. `buildV2AgentPrompt` sections — branch with `ctx.league`
3. Alert thresholds — trailing max, XGB gates
4. Syntax check + deploy
5. Commit research + specs

**Files modified:** `netlify/functions/poll-live-bdl.mjs`
**Risk:** Moderate. NBA byte-identical. All WNBA sections data-backed.
**Scope:** ~200 lines prompt templates + ~10 lines thresholds.

---

## Section 5: League Plumbing Gap (CRITICAL — must fix before prompt branching)

### Finding
`league` does not flow into either prompt system. Without fixing this first, all `if (ctx.league === 'wnba')` branches would evaluate to `undefined === 'wnba'` → false, and every WNBA game would silently receive NBA prompt text with no indication of failure.

### Five fixes required (all have `league` in scope at the callsite):

| # | Component | Line | Current | Fix |
|---|-----------|------|---------|-----|
| 1 | `v2Ctx` object | 7081 | No `league` property | Add `league,` to object literal |
| 2 | `_invV2Ctx` object | 8164 | No `league` property | Add `league,` to object literal |
| 3 | `formatSonnetPrompt` signature | 4630 | No `league` in destructured params | Add `league` to param list |
| 4 | `formatSonnetPrompt` callsites | 5255, 5658 | Not passing `league` | Add `league` to passed object |
| 5 | `SONNET_SYSTEM_PROMPT` usage | 5315 | Uses const directly | Change to `getSonnetSystemPrompt(league)` |

### Why this is silent
- `ctx.league` is `undefined`, not an error
- `if (ctx.league === 'wnba')` evaluates to `false` → falls through to NBA text
- Agent produces valid-looking output with NBA rules applied to WNBA game
- No crash, no log, no indication of wrong prompt — only detectable by inspecting agent reasoning content

### Implementation order
Fix all 5 plumbing points BEFORE adding any league-branched prompt text. Verify with a log line: `log(\`${matchup}: agent prompt league=${v2Ctx.league}\`)` to confirm WNBA games get `league=wnba`.

### No contamination risk
- `league` is `const` in the for-loop (block-scoped) — cannot leak between iterations
- No global `var league` exists anywhere in the file
- Concurrent Netlify invocations each get independent execution contexts
- Sequential NBA→NCAAMB→WNBA loop within one invocation is safe due to block scoping

---

## Section 6: WNBA Odds Integration (The Odds API primary, BDL fallback)

### Current State
- `fetchOddsAPIBatch()` (line 1420) hardcoded to `basketball_nba` sport key
- Line 6226: `const oddsAPICache = league === 'nba' ? await fetchOddsAPIBatch() : {};` — WNBA skipped entirely
- `bdlOdds(league, bdlGid)` (line 1386) already league-aware — newly available for WNBA per BDL (Danny confirmed May 8)
- `ODDS_API_TEAMS` mapping (line 389) — NBA only, 30 teams

### Changes

**1. `fetchOddsAPIBatch` → league-aware (line 1420)**

Add `league` parameter, branch sport key:
```javascript
async function fetchOddsAPIBatch(league) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return {};
  const sportKey = league === 'wnba' ? 'basketball_wnba' : 'basketball_nba';
  const teamMap = league === 'wnba' ? ODDS_API_TEAMS_WNBA : ODDS_API_TEAMS;
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?apiKey=${apiKey}&regions=us,us2&markets=h2h,spreads,totals&oddsFormat=american`;
  // ... rest unchanged, but use teamMap instead of ODDS_API_TEAMS
```

**2. `ODDS_API_TEAMS_WNBA` mapping (new, after line ~420)**

15 WNBA teams — full names as they appear in The Odds API → our SR aliases:
```javascript
const ODDS_API_TEAMS_WNBA = {
  'Atlanta Dream': 'ATL',
  'Chicago Sky': 'CHI',
  'Connecticut Sun': 'CON',
  'Dallas Wings': 'DAL',
  'Golden State Valkyries': 'GSV',
  'Indiana Fever': 'IND',
  'Las Vegas Aces': 'LVA',
  'Los Angeles Sparks': 'LAS',
  'Minnesota Lynx': 'MIN',
  'New York Liberty': 'NYL',
  'Phoenix Mercury': 'PHO',
  'Portland Fire': 'PDX',
  'Seattle Storm': 'SEA',
  'Toronto Tempo': 'TOY',
  'Washington Mystics': 'WAS',
};
```

**NOTE:** These team names must match EXACTLY what The Odds API returns. Verify against a live response on opening night. New expansion teams (Portland Fire, Toronto Tempo) may use different names in the API.

**3. Poll loop odds fetch (line 6226)**

```javascript
// Current:
const oddsAPICache = league === 'nba' ? await fetchOddsAPIBatch() : {};

// Change:
const oddsAPICache = (league === 'nba' || league === 'wnba') ? await fetchOddsAPIBatch(league) : {};
```

**4. `fetchOddsAPIBatch` internal team mapping**

Current code at line ~1436 uses `ODDS_API_TEAMS[g.home_team]` — needs to use the league-specific map:
```javascript
// Pass teamMap into the function or select based on league param
const homeAlias = teamMap[g.home_team];
const awayAlias = teamMap[g.away_team];
```

All downstream odds usage (ML gates, lane classification, odds display, alert context) already works — they read from `odds.homeML`, `odds.awayML`, `odds.homeSpread` which the batch fetch populates. No changes needed downstream.

### What This Enables
- ML gates functional for WNBA (BUY ML > -250, CANDIDATE ML -250 to -400)
- Lane classification (FAVORITE/DOG/PICK) for position tracking
- Line shopping across 20+ books in agent context and dashboard
- Odds movement tracking (odds_history table)

### Credit Budget
- Each `fetchOddsAPIBatch` call = 1 credit (batch — all games for that sport, not per-game)
- Poll has pre-tip gate + all_final skip — odds only fetched during active game window
- NBA game night: ~150 credits (2.5hr window)
- WNBA game night: ~270 credits (4.5hr window, 3 games staggered)
- Overlap night (both live): ~420 credits
- **Peak month (June — Finals + WNBA): ~7,500 credits = 37.5% of 20K plan**
- July-Sep (WNBA only): ~6,750/month = 33.8% of plan
- Plenty of headroom. No concern.

### Verification
After deployment, hit the odds endpoint during a live WNBA game and verify:
1. The Odds API returns WNBA games with correct team names
2. Team name → alias mapping resolves correctly
3. ML/spread values flow through to alerts and agent context
4. BDL fallback works when Odds API doesn't return a game
