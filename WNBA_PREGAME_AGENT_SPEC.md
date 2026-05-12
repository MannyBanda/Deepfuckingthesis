# WNBA Pregame Agent Spec

**Date:** May 12, 2026
**File:** `netlify/functions/pregame-agent.mjs` (1,323 lines → ~1,550 estimated)
**Scope:** Auto cron path only. Manual POST path (`generate-thesis.mjs`) is out of scope.
**Pattern:** Follows `post-game-agent.mjs` multi-league pattern — loop over `['nba', 'wnba']`.

---

## SUMMARY OF CHANGES

The pregame agent is currently hardcoded to NBA at 10 locations. This spec adds WNBA support by:

1. Adding WNBA to LEAGUE_CFG and SR_TEAM_IDS
2. League-parameterizing `runPregameAgent` (loop both leagues)
3. Adding WNBA-specific `computePreGameFloor` branch (different sub-indicators + thresholds)
4. Adding WNBA-specific `computeConviction` branch (I3 anchor, different killer pairs)
5. Adding WNBA-specific system prompt (`buildSystemPrompt(league)`)
6. Fixing `autoTrimStandings` for WNBA's no-division standings structure
7. Skipping depth chart SR calls for WNBA (endpoint returns 404)
8. League-parameterizing BDL odds fetch path + alias matching

---

## CHANGE 1: LEAGUE_CFG + SR_TEAM_IDS

### 1a. Add `wnba` entry to LEAGUE_CFG (line ~893)

```js
var LEAGUE_CFG = {
  nba:    { srBase: 'https://api.sportradar.com/nba/trial/v8/en/',    srKeyEnv: 'SR_API_KEY',    season: '2025' },
  ncaamb: { srBase: 'https://api.sportradar.com/ncaamb/trial/v8/en/', srKeyEnv: 'SR_NCAAMB_KEY', season: '2025' },
  wnba:   { srBase: 'https://api.sportradar.com/wnba/trial/v8/en/',  srKeyEnv: 'SR_WNBA_KEY',   season: '2026' },
};
```

**Note:** WNBA season is `2026` (calendar-year league, not split-year like NBA).

### 1b. Add SR_TEAM_IDS_WNBA (new block after SR_TEAM_IDS, line ~50)

```js
var SR_TEAM_IDS_WNBA = {
  NYL:'08ed8274-e29f-4248-bc2e-83cc8ed18d75',
  CHI:'3c409388-ab73-4c7f-953d-3a71062240f6',
  TOR:'4e4f726e-a015-4306-91a7-28e8576c7868',
  WAS:'5c0d47fe-8539-47b0-9f36-d0b3609ca89b',
  ATL:'5d70a9af-8c2b-4aec-9e68-9acc6ddb93e4',
  CON:'a015b02d-845c-40c1-8ef4-844984f47e4d',
  IND:'f073a15f-0486-4179-b0a3-dfd0294eb595',
  PHX:'0699edf3-5993-4182-b9b4-ec935cbd4fcc',
  LAS:'0a5ad38d-2fe3-43ba-894b-1ba3d5042ea9',
  LVA:'171b097d-01db-4ae8-9d56-035689402ec6',
  GSV:'4f57ec40-0d35-4b59-bea0-9d040f0d2292',
  DAL:'5f0b5caf-708b-4300-92f2-53b51d83ec06',
  MIN:'6f017f37-be96-4bdc-b6d3-0a0429c72e89',
  PDX:'d54283cc-c5ec-4dbd-bb61-166f217e3864',
  SEA:'d6a012ed-84aa-48d3-8265-2d3f3ff2199a',
};
```

### 1c. Add alias map for BDL matching (new, after SR_TEAM_IDS_WNBA)

SR aliases differ from BDL abbreviations for 7 WNBA teams. Needed for odds fetch matching.

```js
var WNBA_ALIAS_MAP = { NYL:'NY', LVA:'LV', LAS:'LA', GSV:'GS', WAS:'WSH', PDX:'POR', TOY:'TOR' };
```

**Cascading:** This is the same map as `cfg.aliasMap` in poll-live. Duplicated here because Netlify bundles functions separately — can't import across functions.

---

## CHANGE 2: INDICATOR WEIGHTS (line ~20)

Currently a single hardcoded `var W = { I1: 0.10, I2: 0.15, I3: 0.20, I4: 0.30, I5: 0.25 };`

Replace with league-parameterized:

```js
var WEIGHTS = {
  nba:  { I1: 0.10, I2: 0.15, I3: 0.20, I4: 0.30, I5: 0.25 },
  wnba: { I1: 0.15, I2: 0.20, I3: 0.30, I4: 0.25, I5: 0.10 },
};
```

### Consumers of `W` that must switch to `WEIGHTS[league]`:

1. **`computePreGameFloor`** — line 723: `var raw = I1.score * W.I1 + ...` → pass league, use `WEIGHTS[league]`
2. **`formatMechanicalFloor`** — mentions weight percentages in text output (cosmetic but should match)
3. **`buildSystemPrompt`** — mentions indicator weight percentages in prompt text

---

## CHANGE 3: `computePreGameFloor` — WNBA BRANCH

This is the largest code change. Currently computes all 5 indicators with NBA-specific sub-indicators and thresholds. The WNBA live system (`computeServer` in poll-live, lines 3060–3210) uses different sub-indicators for I1, I2, I3, I5 and different thresholds for I4.

### Function signature change

```js
// BEFORE:
function computePreGameFloor(homeStats, awayStats, standings, seasonQ4, siaCaps, homeAlias, awayAlias)

// AFTER:
function computePreGameFloor(homeStats, awayStats, standings, seasonQ4, siaCaps, homeAlias, awayAlias, league)
```

### I1 Disruption — threshold changes only

```
NBA pregame:   subA steals+blocks diff ±1,  subB POT diff ±2
WNBA pregame:  subA steals+blocks diff ±2,  subB POT diff ±3
```

Implementation: add `var disruptThresh = league === 'wnba' ? 2 : 1;` and `var potThresh = league === 'wnba' ? 3 : 2;`

**Note:** NBA pregame uses ±2 for POT but live NBA uses ±4. WNBA live uses ±3. Pregame thresholds are from season averages (smoother), so they're tighter than live thresholds. For consistency with the WNBA live system, use ±3 for WNBA pregame POT.

### I2 — COMPLETELY DIFFERENT SUB-INDICATORS

This is the critical divergence. NBA I2 = paint volume + paint/rim FG%. WNBA I2 = 3PT% + FTA.

```js
if (league === 'wnba') {
  // I2 subA: 3PT% differential (season averages)
  var h3Pct = h.fg3m / (h.fga > 0 ? (h.fg3m / (h.fga * (h.fg3aShare || 0.345))) : 1);
  // Actually simpler — compute from season stats:
  // h.fg3m and h.fg3a aren't in avg() yet. Need to add fg3a extraction.
  // See DATA EXTRACTION section below.
  var h3Pct = h.fg3a >= 3 ? (h.fg3m / h.fg3a) * 100 : null;
  var a3Pct = a.fg3a >= 3 ? (a.fg3m / a.fg3a) * 100 : null;
  var wi2a = 0;
  if (h3Pct != null && a3Pct != null) {
    if (h3Pct - a3Pct > 3) wi2a = 1;
    else if (a3Pct - h3Pct > 3) wi2a = -1;
  }

  // I2 subB: FTA differential (season per-game averages)
  var wi2b = (h.fta - a.fta > 2) ? 1 : (a.fta - h.fta > 2) ? -1 : 0;

  i2raw = wi2a + wi2b;
} else {
  // existing NBA I2 (paint + rim FG%)
}
```

**Data needed:** `fg3a` (three_points_att) per-game average. Already extracted in `avg()` function — `h.fga` is field_goals_att but we also need three_points_att specifically. Check: `avg()` already extracts `fg3m` (three_points_made). Need to add:

```js
fg3a: a.three_points_att || (t.three_points_att ? t.three_points_att/gp : 0),
```

to the `avg()` helper inside `computePreGameFloor`.

### I3 Shot Quality — different thresholds + raw assists

```
NBA pregame:   eFG% diff ±2%,   assist ratio diff ±3
WNBA pregame:  eFG% diff ±3%,   raw assists/gm diff ±2
```

```js
if (league === 'wnba') {
  i3raw = (hEFG > aEFG + 0.03 ? 1 : hEFG < aEFG - 0.03 ? -1 : 0)
        + (h.ast - a.ast > 2 ? 1 : a.ast - h.ast > 2 ? -1 : 0);
  // Store diffs for display
  diffs.i3sub1_diff = +((hEFG - aEFG) * 100).toFixed(1);
  diffs.i3sub2_diff = +(h.ast - a.ast).toFixed(1);
} else {
  // existing NBA I3 (eFG% ±2%, assist ratio ±3)
}
```

### I4 Game Control — same proxy, keep existing thresholds

Both NBA and WNBA pregame use the same proxy (avg win margin for subA, season Q4 margin for subB). Live WNBA uses ±4 for biggest_lead, but biggest_lead has no pregame equivalent. The margin proxy at ±2.5 is acceptable for both leagues.

**No change needed for I4.** Same thresholds, same proxy.

### I5 Momentum — different inputs

```
NBA pregame:   net rating diff ±3
WNBA pregame:  total rebounds/gm diff ±3 (FBP skipped — always 0 from BDL)
```

```js
if (league === 'wnba') {
  // I5: rebounds differential (FBP not available in season stats, net rating has no signal)
  var hReb = h.oreb + h.dreb;
  var aReb = a.oreb + a.dreb;
  diffs.i5_diff = +(hReb - aReb).toFixed(1);
  I5 = {
    score: diffs.i5_diff > 3 ? 1 : diffs.i5_diff < -3 ? 0 : 0.5,
    leader: diffs.i5_diff > 3 ? homeAlias : diffs.i5_diff < -3 ? awayAlias : 'EVEN'
  };
} else {
  // existing NBA I5 (net rating)
}
```

**Data needed:** `dreb` (defensive_rebounds) per-game average. Currently `avg()` extracts `oreb` but not `dreb`. Add:

```js
dreb: a.def_rebounds || a.defensive_rebounds || (t.defensive_rebounds ? t.defensive_rebounds/gp : 0),
```

### Composite score — use league weights

```js
var W = WEIGHTS[league] || WEIGHTS.nba;
var raw = I1.score * W.I1 + I2.score * W.I2 + I3.score * W.I3 + I4.score * W.I4 + I5.score * W.I5;
```

### Summary of `avg()` helper additions

Two new fields needed:

```js
fg3a: a.three_points_att || (t.three_points_att ? t.three_points_att/gp : 0),
dreb: a.def_rebounds || a.defensive_rebounds || (t.defensive_rebounds ? t.defensive_rebounds/gp : 0),
```

Both are available in SR statistics endpoint (confirmed identical schema for WNBA).

---

## CHANGE 4: `computeConviction` — WNBA BRANCH

Currently uses NBA-only conviction rules. Add league parameter and WNBA branch matching poll-live (lines 3249–3270).

```js
// BEFORE:
function computeConviction(ind)

// AFTER:
function computeConviction(ind, league)
```

### WNBA conviction rules (from poll-live, 203-game validated):

```js
if (league === 'wnba') {
  var hasI3I4 = has('I3', 'I4');
  var hasI3I2 = has('I3', 'I2');
  var hasI4I2 = has('I4', 'I2');
  var hasKillerPair = hasI3I4 || hasI3I2 || hasI4I2;

  if (count >= 4 || (hasI3I4 && count >= 3)) tier = 'DOMINANT';
  else if (hasKillerPair) tier = 'STRONG';
  else if (count >= 2) tier = 'MODEST';
  else if (count >= 1) tier = 'CONDITIONAL';
  else tier = 'NO ENTRY';

  if (hasI3I4) pairs.push('I3+I4');
  if (hasI3I2) pairs.push('I3+I2');
  if (hasI4I2) pairs.push('I4+I2');
} else {
  // existing NBA rules (I4+I5 killer pair, danger combos, etc.)
}
```

**Key difference:** No danger combos in WNBA. I4+I5 is NOT a killer pair (I5 AUC = 0.500). I3 is the anchor.

### Callers of `computeConviction` that must pass league:

1. Line ~1216: `var conviction = floor ? computeConviction(floor) : ...` → `computeConviction(floor, league)`

---

## CHANGE 5: `formatMechanicalFloor` — WNBA labels

Currently hardcodes NBA sub-indicator labels in the raw differentials output. For WNBA, the labels should match the actual sub-indicators computed.

```js
// BEFORE:
function formatMechanicalFloor(floor, conviction, homeAlias, awayAlias)

// AFTER:
function formatMechanicalFloor(floor, conviction, homeAlias, awayAlias, league)
```

Changes to differential labels:

```js
if (league === 'wnba') {
  // I2 labels: 3PT% and FTA instead of paint and rim
  '  I2 subA: 3PT% diff = ' + ... + ' (threshold ±3%)',
  '  I2 subB: FTA/gm diff = ' + ... + ' (threshold ±2)',
  // I3 labels: raw assists instead of assist ratio
  '  I3 sub2: assists/gm diff = ' + ... + ' (threshold ±2)',
  // I5 label: rebounds instead of net rating
  '  I5: rebounds/gm diff = ' + ... + ' (threshold ±3)',
} else {
  // existing NBA labels
}
```

Also update the weight percentages in the header text to match WNBA weights if league is WNBA.

### Callers:

1. Line ~1220: `var floorText = floor ? formatMechanicalFloor(floor, conviction, hA, aA) : ''` → add `league`

---

## CHANGE 6: `buildSystemPrompt` — WNBA VERSION

```js
// BEFORE:
function buildSystemPrompt()

// AFTER:
function buildSystemPrompt(league)
```

If `league === 'wnba'`, return a WNBA-specific prompt. Key differences from the NBA prompt:

1. **Role:** "WNBA pre-game structural analyst" (not NBA)
2. **Indicator weights:** I1:15%, I2:20%, I3:30% (ANCHOR), I4:25%, I5:10%
3. **I2 definition:** "Perimeter & FT Access — 3PT%, FTA differential" (not paint/rim)
4. **I3 emphasis:** "I3 (Shot Quality, 30%) is the ANCHOR indicator. Losing I3 = 17.6% win rate — this is structural death, not a cold streak."
5. **I5 warning:** "I5 (10%) has AUC = 0.500 — literally random. Do not use I5 for conviction."
6. **Conviction rules:** I3+I4 (99.1%), I3+I2, I4+I2 killer pairs. I4+I5 is NOT a killer pair.
7. **Signal trust hierarchy:** "Floor is narrative only in WNBA — never a decision gate. MC Cum and XGB are the decision signals."
8. **Paint context:** "Paint points are noise in WNBA (winner has more paint only 50% of the time). Do NOT treat paint dominance as structural."
9. **Pregame proxy notes:** Same structure as NBA but adapted for WNBA sub-indicators.
10. **Depth chart:** Remove depth chart references since WNBA has no SR depth charts.

### Callers:

1. Line ~1231: `var systemPrompt = buildSystemPrompt()` → `buildSystemPrompt(league)`

---

## CHANGE 7: `autoTrimStandings` — FIX WNBA PARSING

Currently only parses `conf.divisions[].teams` (three-level nesting). WNBA standings have no division layer — teams are directly under conferences.

```js
// BEFORE (line ~992):
function autoTrimStandings(s) {
  if (!s) return '(unavailable)';
  var teams = [];
  (s.conferences||[]).forEach(function(conf){(conf.divisions||[]).forEach(function(div){(div.teams||[]).forEach(function(t){
    teams.push(...);
  });});});
  return teams.join('\n');
}

// AFTER:
function autoTrimStandings(s) {
  if (!s) return '(unavailable)';
  var teams = [];
  (s.conferences||[]).forEach(function(conf){
    // Direct teams (WNBA — no division layer)
    (conf.teams||[]).forEach(function(t){
      teams.push((t.name||'?')+' '+(t.wins||0)+'-'+(t.losses||0)+' ('+(t.win_pct||0).toFixed(3)+') PF:'+(t.calc_points?.for||'?')+' PA:'+(t.calc_points?.against||'?'));
    });
    // Division teams (NBA)
    (conf.divisions||[]).forEach(function(div){(div.teams||[]).forEach(function(t){
      teams.push((t.name||'?')+' '+(t.wins||0)+'-'+(t.losses||0)+' ('+(t.win_pct||0).toFixed(3)+') PF:'+(t.calc_points?.for||'?')+' PA:'+(t.calc_points?.against||'?'));
    });});
  });
  return teams.join('\n');
}
```

**Note:** `getTeamGP` (line 76) and `computePythagorean` (line 388) already handle both patterns correctly — they check both `conf.teams` and `conf.divisions[].teams`. Only `autoTrimStandings` needs fixing.

---

## CHANGE 8: MAIN LOOP — MULTI-LEAGUE

### 8a. Extract per-league processing into `processLeagueTheses(sql, apiKey, league, dateKey, now, log)`

Follow the `post-game-agent.mjs` pattern. Move lines 1030–1300 (everything from `var league = 'nba'` through the ntfy send) into a new function that takes `league` as a parameter.

### 8b. Loop over leagues in `runPregameAgent`

```js
var leagues = ['nba', 'wnba'];
var allGenerated = [];

for (var league of leagues) {
  try {
    var result = await processLeagueTheses(sql, apiKey, league, dateKey, now, log);
    allGenerated = allGenerated.concat(result);
  } catch (e) {
    log(league.toUpperCase() + ' error: ' + e.message);
  }
}

// Single ntfy with all generated theses
if (allGenerated.length > 0) { ... }
```

### 8c. Inside `processLeagueTheses`, league-parameterize:

| Line | Current | Change |
|------|---------|--------|
| ~1030 | `var league = 'nba'` | Removed — league is a parameter |
| ~1100 | `var hId = SR_TEAM_IDS[hA]` | `var teamIds = league === 'wnba' ? SR_TEAM_IDS_WNBA : SR_TEAM_IDS; var hId = teamIds[hA]` |
| ~1128-1135 | 10 SR calls including 2 depth charts | Skip depth charts for WNBA (see Change 9) |
| ~1153 | `bdlFetchDirect('/nba/v1/games?...')` | `bdlFetchDirect('/' + (league === 'wnba' ? 'wnba' : 'nba') + '/v1/games?...')` |
| ~1155 | Match by `hA` / `aA` directly | Apply aliasMap for WNBA (see Change 10) |
| ~1159 | `bdlFetchDirect('/nba/v1/odds?...')` | `bdlFetchDirect('/' + (league === 'wnba' ? 'wnba' : 'nba') + '/v1/odds?...')` |
| ~1215 | `computePreGameFloor(..., hA, aA)` | Add `league` parameter |
| ~1216 | `computeConviction(floor)` | Add `league` parameter |
| ~1220 | `formatMechanicalFloor(floor, conviction, hA, aA)` | Add `league` parameter |
| ~1229 | `'...for this NBA matchup'` | `'...for this ' + (league === 'wnba' ? 'WNBA' : 'NBA') + ' matchup'` |
| ~1231 | `buildSystemPrompt()` | `buildSystemPrompt(league)` |

---

## CHANGE 9: SKIP DEPTH CHARTS FOR WNBA

SR WNBA returns 404 on depth chart endpoint (confirmed live). Remove depth chart calls from the SR call list when league is WNBA.

```js
var srCalls = [
  { key: 'homeProfile', path: 'teams/' + hId + '/profile.json' },
  { key: 'awayProfile', path: 'teams/' + aId + '/profile.json' },
];

// Depth charts — NBA only (WNBA returns 404)
if (league !== 'wnba') {
  srCalls.push(
    { key: 'homeDepth', path: 'seasons/' + LEAGUE_CFG[league].season + '/REG/teams/' + hId + '/depth_chart.json' },
    { key: 'awayDepth', path: 'seasons/' + LEAGUE_CFG[league].season + '/REG/teams/' + aId + '/depth_chart.json' },
  );
}

// Stats + splits (both leagues)
srCalls.push(
  { key: 'homeStats', path: 'seasons/' + LEAGUE_CFG[league].season + '/REG/teams/' + hId + '/statistics.json' },
  { key: 'awayStats', path: 'seasons/' + LEAGUE_CFG[league].season + '/REG/teams/' + aId + '/statistics.json' },
  { key: 'homeSplitsGame', path: 'seasons/' + LEAGUE_CFG[league].season + '/REG/teams/' + hId + '/splits/game.json' },
  { key: 'awaySplitsGame', path: 'seasons/' + LEAGUE_CFG[league].season + '/REG/teams/' + aId + '/splits/game.json' },
  { key: 'homeSplitsSchedule', path: 'seasons/' + LEAGUE_CFG[league].season + '/REG/teams/' + hId + '/splits/schedule.json' },
  { key: 'awaySplitsSchedule', path: 'seasons/' + LEAGUE_CFG[league].season + '/REG/teams/' + aId + '/splits/schedule.json' },
);
```

**8 SR calls for WNBA, 10 for NBA.** Saves rate limit budget.

### Impact on SIA pipeline:

`computeRedistribution` and `computeBHV` use `analytical.homeDepth` / `analytical.awayDepth`. When null, they already degrade gracefully (skip depth-dependent logic). The depth chart sections in the user prompt will show "(unavailable)" via `autoTrimDepth(null)`.

---

## CHANGE 10: BDL ODDS — ALIAS MAPPING

BDL uses different abbreviations than SR for 7 WNBA teams. The current BDL match code:

```js
var bdlGame = (bdlGames.data||[]).find(function(bg) {
  return (bg.home_team?.abbreviation === hA && (...));
});
```

This won't match for WNBA because `hA` is the SR alias (e.g., `NYL`) but BDL returns `NY`.

**Fix:**

```js
var bdlHomeAlias = league === 'wnba' ? (WNBA_ALIAS_MAP[hA] || hA) : hA;
var bdlAwayAlias = league === 'wnba' ? (WNBA_ALIAS_MAP[aA] || aA) : aA;
var bdlGame = (bdlGames.data||[]).find(function(bg) {
  return (bg.home_team?.abbreviation === bdlHomeAlias &&
         (bg.visitor_team?.abbreviation === bdlAwayAlias || bg.away_team?.abbreviation === bdlAwayAlias));
});
```

---

## CHANGE 11: USER PROMPT — WNBA ADAPTATIONS

### 11a. Matchup label

```js
var userPrompt = 'Build a complete pre-game thesis for this ' +
  (league === 'wnba' ? 'WNBA' : 'NBA') + ' matchup.\n\n' + ...
```

### 11b. Depth chart sections — conditional

```js
// Only include depth chart sections for NBA
if (league !== 'wnba') {
  userPrompt += '=== ' + hA + ' DEPTH CHART ===\n' + sections.homeDepth + '\n\n';
  userPrompt += '=== ' + aA + ' DEPTH CHART ===\n' + sections.awayDepth + '\n\n';
}
```

### 11c. Ground truth instruction — WNBA-specific

```js
var groundTruthNote = league === 'wnba'
  ? 'IMPORTANT: The PRE-COMPUTED STRUCTURAL ASSESSMENT contains SIA context. The MECHANICAL PREGAME FLOOR provides indicator scores as ground truth — do not override them. I3 (Shot Quality, 30%) is the ANCHOR indicator in WNBA. Floor is narrative context only — never a decision gate. Show SIA notation in AVAILABILITY. Add DISAGREEMENT if your contextual read differs from the mechanical floor.\n\nOutput the compact thesis format.'
  : 'IMPORTANT: The PRE-COMPUTED STRUCTURAL ASSESSMENT contains SIA context. The MECHANICAL PREGAME FLOOR provides indicator scores as ground truth — do not override them. Show SIA notation in AVAILABILITY. Add DISAGREEMENT if your contextual read differs from the mechanical floor.\n\nOutput the compact thesis format.';
```

---

## CHANGE 12: NTFY — LEAGUE LABELING

Currently: `'DFT Pre-Game: ' + generated.length + ' thesis(es) ready'`

Change to include league when WNBA:

```js
var ntfyTitle = 'DFT Pre-Game' + (league === 'wnba' ? ' (WNBA)' : '') + ': ' +
  result.length + ' ' + (result.length === 1 ? 'thesis' : 'theses') + ' ready';
```

Or, if both leagues produce theses in the same invocation, send a single combined ntfy with league labels per game:

```js
var ntfyBody = allGenerated.map(function(g) {
  return (g.league === 'wnba' ? '[WNBA] ' : '') + g.matchup + '\nFloor: ' + g.controlTeam + ' ' + g.floor + ' ' + g.verdict + ' (' + g.conviction + ')';
}).join('\n\n');
```

---

## CASCADING IMPLICATIONS

### Functions that need league parameter added:

| Function | Current signature | New parameter | Callers |
|----------|------------------|---------------|---------|
| `computePreGameFloor` | `(homeStats, awayStats, standings, seasonQ4, siaCaps, hA, aA)` | `league` (8th param) | 1 call in processLeagueTheses |
| `computeConviction` | `(ind)` | `league` (2nd param) | 1 call in processLeagueTheses |
| `formatMechanicalFloor` | `(floor, conviction, hA, aA)` | `league` (5th param) | 1 call in processLeagueTheses |
| `buildSystemPrompt` | `()` | `league` (1st param) | 1 call in processLeagueTheses |

### Functions that need internal fixes (no signature change):

| Function | Fix |
|----------|-----|
| `autoTrimStandings` | Add `conf.teams` iteration alongside `conf.divisions[].teams` |
| `avg()` inside `computePreGameFloor` | Add `fg3a` and `dreb` extraction |

### Functions that need NO changes:

| Function | Why |
|----------|-----|
| `getTeamGP` | Already handles both division and no-division standings |
| `computePythagorean` | Already handles both standings structures |
| `computeRosterAudit` | Uses injuries + profiles — league-agnostic |
| `computeSIA` | Uses roster audit output — league-agnostic |
| `computeRedistribution` | Depth is optional (null-safe) |
| `computeSRM` | Uses stats — league-agnostic |
| `computeDepletionGate` | Uses roster audit — league-agnostic |
| `computeBHV` | Depth is optional (null-safe) |
| `applyAdjustments` | Uses SIA output — league-agnostic |
| `formatPreComputed` | Uses SIA output — league-agnostic |
| `srFetchDirect` | Already league-parameterized |
| `bdlFetchDirect` | Path is passed in — caller handles league |
| `loadSeasonQ4Auto` | Already takes league parameter |
| `sendNtfy` | Body is passed in — caller handles league |
| `autoTrimProfile` | Player data is identical across leagues |
| `autoTrimDepth` | Returns "(unavailable)" for null — safe |
| `autoTrimStats` | Stats structure is identical across leagues |
| `autoTrimInjuries` | Injury data is identical across leagues |

---

## DEAD CODE

None. No code is being removed — only branching and parameterization added.

---

## DATA FLOW VERIFICATION

End-to-end path for a WNBA pregame thesis:

```
1. Cron fires → runPregameAgent()
2. Loop: league = 'wnba'
3. Read poll_state WHERE league='wnba' → schedule_json
   ✓ Confirmed: WNBA schedule_json has SR game UUIDs + SR aliases (NYL, PDX, etc.)
4. Find games tipping in 0-75 minutes
5. Check theses table for existing → INSERT PENDING sentinel
6. Fetch shared SR data:
   - league/injuries.json (WNBA key, confirmed working)
   - seasons/2026/REG/standings.json (WNBA, no division layer → autoTrimStandings fix)
   - loadSeasonQ4Auto(sql, 'wnba') → reads games WHERE league='wnba'
7. Per game:
   a. Look up team IDs: SR_TEAM_IDS_WNBA[hA], SR_TEAM_IDS_WNBA[aA]
   b. Fetch 8 SR calls (no depth charts):
      - 2x profile, 2x statistics, 4x splits
   c. Fetch BDL odds:
      - /wnba/v1/games?dates[]=YYYY-MM-DD
      - Match using WNBA_ALIAS_MAP (NYL→NY, etc.)
      - /wnba/v1/odds?game_id=BDL_ID
   d. Build analytical object (homeDepth/awayDepth = null)
   e. Run SIA pipeline (roster audit, SIA, redistribution, SRM, BHV, pyth)
      - Redistribution/BHV degrade gracefully with null depth
   f. computePreGameFloor(..., 'wnba')
      - WNBA weights {0.15, 0.20, 0.30, 0.25, 0.10}
      - WNBA I2: 3PT% + FTA (not paint)
      - WNBA I3: eFG% ±3% + assists ±2 (not ratio ±3)
      - WNBA I5: rebounds ±3 (not net rating)
   g. computeConviction(floor, 'wnba')
      - I3 anchor, I3+I4/I3+I2/I4+I2 killer pairs
   h. formatMechanicalFloor(..., 'wnba') — WNBA sub-indicator labels
   i. buildSystemPrompt('wnba') — WNBA-specific prompt
   j. Sonnet call with WNBA user prompt
   k. UPDATE theses SET text = thesis WHERE game_id = X
   l. Add to generated array with league label
8. Send ntfy with league labels
```

---

## SR RATE LIMIT BUDGET

Per invocation (2-game cap):

| | NBA | WNBA |
|---|---|---|
| Shared calls | 2 (injuries + standings) | 2 (injuries + standings) |
| Per-game calls | 10 × 2 = 20 | 8 × 2 = 16 |
| **Total** | **22** | **18** |
| At 1.1s delay | ~24s | ~20s |

If both leagues have candidates in the same invocation: worst case 22 + 18 = 40 SR calls at 1.1s each = ~44s. Under the 120s Netlify timeout but worth monitoring. Rate limits are per-key (separate NBA and WNBA keys), so they don't compete.

**Important:** Shared data (injuries, standings) must be fetched separately per league since they use different SR keys and different base URLs. Can NOT reuse NBA injuries for WNBA.

---

## TESTING PLAN

### Pre-deploy (in sandbox):

1. `node -c` syntax check on modified pregame-agent.mjs
2. Verify `SR_TEAM_IDS_WNBA` covers all 15 teams against known aliases from `schedule_json`
3. Grep for remaining hardcoded `/nba/v1/` in pregame-agent.mjs — should only appear in NBA branch

### Post-deploy:

1. **Manual trigger:** Hit `/.netlify/functions/pregame-agent` during a WNBA slate window → verify ntfy fires with WNBA thesis
2. **Verify DB:** Check `theses` table for `league='wnba'` entry with non-PENDING text
3. **Verify prompt:** Pull the generated thesis, confirm I3 is positioned as anchor (not I4), confirm no depth chart sections, confirm WNBA weights in mechanical floor text
4. **Verify odds:** Confirm odds section is present (or "(unavailable)" if BDL odds not yet available for WNBA)
5. **Verify standings:** Confirm standings section is populated (not empty from parser bug)
6. **NBA regression:** Verify NBA thesis still generates correctly — run on a night with both leagues

### Known risk:

WNBA season may have limited `quarter_data` in the games table → `loadSeasonQ4Auto` may return empty → I4 subB falls back to null (threshold skipped). This is fine — I4 subA (win margin proxy) still computes, and the thesis is still generated. I4 subB will populate as more WNBA games accumulate.

---

## IMPLEMENTATION ORDER

1. Add constants (`SR_TEAM_IDS_WNBA`, `WNBA_ALIAS_MAP`, `WEIGHTS`, LEAGUE_CFG entry)
2. Fix `autoTrimStandings` (non-breaking, improves NBA too)
3. Add `league` parameter to `computePreGameFloor`, `computeConviction`, `formatMechanicalFloor`, `buildSystemPrompt`
4. Implement WNBA branches in each function
5. Build `buildSystemPrompt('wnba')` prompt text
6. Extract `processLeagueTheses` from `runPregameAgent`, add league loop
7. League-parameterize SR calls (skip depth), BDL calls (prefix + alias map), user prompt
8. Update ntfy with league labels
9. Syntax check, commit, push

**Estimated delta:** ~225 new lines (WNBA prompt ~80 lines, WNBA indicator branches ~60 lines, multi-league refactor ~40 lines, constants ~30 lines, misc ~15 lines).
