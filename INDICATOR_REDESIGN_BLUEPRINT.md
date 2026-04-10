# DFT Indicator Redesign Blueprint
**Created:** April 10, 2026
**Purpose:** Complete reference for building the indicator redesign across all files. This document captures every decision, data point, and implementation detail from the Apr 10 session.

---

## EXECUTIVE SUMMARY

Data-validated redesign of all 5 indicators across 109 NBA games. Every change is backed by historical simulation against actual game outcomes. I2 was already shipped during this session. I1, I4, I5 need building. I3 is unchanged. Weights shift from 25/25/20/20/10 to 15/20/20/20/25.

**Composite floor accuracy improvement:** Current weights 79.8% → Best new weights 85.3% (+5.5pp)

---

## THE FIVE INDICATORS — BEFORE AND AFTER

### I1: Disruption & Conversion (was "Possession & Transition")
**Weight: 15% (was 25%)**
**Status: NEEDS BUILDING**

#### Old Formula
```
Gen: steals + oreb - turnovers (who creates extra possessions)
Conv: fast_break_pts + points_off_TO + 2nd_chance_pts (what you scored)
Chaos: ±0.5 when forced/unforced TO gap ≥ 4 (shipped Apr 10)
Each sub-signal ±1, chaos ±0.5. Positive → 1.0, zero → 0.5, negative → 0.0
```

#### Why It Changed
Individual metric accuracy (109 games):
- Steals: 71.4% ✓
- POT: 69.2% ✓
- Oreb: 50.5% — coin flip, DROP
- SCP: 58.5% — weak, DROP
- FBP: always zero from BDL — dead, DROP
- Raw TO count: 32.4% — ACTIVELY INVERTED (more TOs = more aggressive = winning team)
- Blocks: 62.8% alone, but combined with steals as "disruption" = 73.3%

The gen formula (`steals + oreb - TO`) was self-sabotaging: steals at 71.4% minus TOs at 32.4% inverted = net drag. Conv was carried entirely by POT — FBP dead, SCP coin flip.

#### New Formula
```
Sub-A: Disruption = (steals + blocks) diff
  > +1 → 1, < -1 → -1, else 0
Sub-B: Points Off Turnovers diff
  > +4 → 1, < -4 → -1, else 0
No tiebreaker. Split = EVEN.
```

#### Accuracy
- Overall: 74.2% (93 decisive, 16 EVEN)
- Both agree: 85.7%
- Old I1: 75.3% (89 decisive, 20 EVEN)
- Marginal overall improvement, but much cleaner architecture and higher agreement accuracy

#### Chaos Layer
Shipped earlier in this session at ±0.5/±4 on both server and client. It was only on the client before. Decision for next session: keep it as-is on I1 (it modifies i1raw before bucketing) or kill it since steals already captures the strongest forced-TO signal. Steals ⊂ forced TOs so there's some redundancy. My lean: keep it, it's a light touch and enriches the read.

#### What Gets Dropped
- Raw turnover count (from gen)
- Offensive rebounds (from gen)
- Fast break points (from conv — always zero)
- Second chance points (from conv)
- The entire gen/conv composite structure

#### What Gets Added
- Blocks (orphaned from old I2 redesign) join steals as "disruption"

#### Key Data
- Disruption (stl+blk) tested at 73.3% standalone
- POT tested at 69.2% standalone
- When both agree: 85.7% — the quality signal
- BDL box scores have stl and blk per player (confirmed available)
- POT comes from PBP parsing (pendPOT tracking after turnovers)

---

### I2: Interior Control (was "Rim Pressure & Foul")
**Weight: 20% (was 25%)**
**Status: ALREADY SHIPPED (Apr 10)**

#### New Formula (live in production)
```
Sub-A: Paint points diff
  > +6 → 1, < -6 → -1, else 0
Sub-B: Rim FG% diff (min 6 attempts per team)
  > +10% → 1, < -10% → -1, else 0
No tiebreaker. Split = EVEN.
Window variant: paint ±3 (half-game volume), rim FG% ±10% (rate, unchanged)
```

#### Accuracy
- Overall: 77.0% (74 decisive, 35 EVEN)
- Both agree: 90.3% (31 games)

#### What Was Shipped
- Server `computeServer()` and window I2
- Client `compute()`, QD window, crossfade window (NBA + NCAAMB)
- NCAAMB `computeBDL()` with graceful fallback (Sub-B=0 when no at-rim data)
- `raw_stats_json` expanded with atRimM, paintM, paintA fields
- Sonnet prompt label: "I2 Interior Control"
- Evidence view text updated

#### What Was Removed
- FTA (55.0% — weak predictor)
- Blocks (59.9% — weak, moved to I1 disruption)
- At-rim attempts (double-counted with paint)
- Fouls drawn (always zero — dead)
- The entire rimScore composite

---

### I3: Shot Quality & Creation
**Weight: 20% (unchanged)**
**Status: UNCHANGED — NO BUILD NEEDED**

#### Formula (no changes)
```
Three sub-signals, each ±1:
  EFG% diff > ±0.02
  Assist ratio diff > ±5%
  C&S threes diff > ±2
Bucketed: positive → 1.0, zero → 0.5, negative → 0.0
```

#### Accuracy
- Overall: 83.7% (86 decisive, 23 EVEN)
- **Canary indicator:** When the floor was wrong (5 games in 50-game sample), I3 disagreed with floor 4/5 times — it catches what others miss

#### Key Combos
- I3+I5: 100% (38/38) — best pair in the system
- I2+I3: 90.7%
- I1+I3: 91.7%

---

### I4: Game Control (was "Lineup Integrity")
**Weight: 20% (unchanged)**
**Status: NEEDS BUILDING**

#### Old Formula
```
Three sub-signals, each ±1:
  Biggest lead diff > ±4
  Trend (last Q - first Q) > ±2
  Bench points diff > ±10
```

#### Why It Changed
Individual metric accuracy (109 games, PBP-derived biggest lead):
- **Biggest lead diff: 90.7%** (95.4% at ±8) — ELITE, was being dragged down
- Trend (lastQ - firstQ): **39.0% — INVERTED** (winning teams build early, coast late)
- Bench diff: 61.7% — weak
- Half trend: 41.5% — inverted same disease
- Last Q diff: 72.6% — legitimate closing signal
- Last Q diff ±4: 74.6%
- Quarters won diff ±1: 100% — tautological (restates final score)
- Starter +/- diff: 98.2% — tautological (restates final margin)

CRITICAL DATA QUALITY FINDING: BDL `box_scores` endpoint does NOT have `biggest_lead` field (0/109 games populated). This is why the full system sim showed I4 at 41.9% — it was computing 0 vs 0. The server adapter gets biggest_lead from PBP-derived `_bdl.biggestLeadHome/Away`. This data path works correctly in production.

Old I4 composite: 78.9% (71 decisive, 38 EVEN) — biggest_lead fighting through two inverted/weak sub-signals.

#### New Formula
```
Sub-A: Biggest lead diff (PBP-derived) > ±4
Sub-B: 
  - Before Q4 starts: season Q4 margin differential > ±2
  - Once Q4 starts: live last quarter diff > ±2
No tiebreaker. Split = EVEN.
```

#### Accuracy
- BL alone ±4: 92.1% (101 decisive, 8 EVEN)
- BL±4 + sznQ4±2: 93.1%, agree 98.0% (49/50) — available from tip-off
- BL±4 + liveQ4±2: 98.7%, agree 100% (55/55) — Q4 only
- Season Q4 never hurts BL: 0 games where BL was right but adding sznQ4 flipped wrong
- Season Q4 breaks 8 EVEN ties: 5 right, 2 wrong (71% tiebreaking)

#### What Gets Dropped
- Trend (lastQ - firstQ) — 39% inverted
- Bench points diff — 61.7% weak
- The three-sub-signal structure

#### What Gets Added
- Season Q4 profiles (avg Q4 margin per team)
- Live/season swap logic (use season prior until Q4 starts)

#### Season Q4 Data Pipeline
Team Q4 profiles need to be available at compute time. Options:
1. Compute from `games` table (has quarter scores) — ~11 games per team from 173 games in DB
2. Add to season_cache table as per-team Q4 avg margin
3. Compute on the fly from recent games in DB

The server already has access to the games table. Simplest path: query recent games for both teams' Q4 margins at the start of each poll cycle, cache per-slate.

#### Biggest Lead Source
MUST come from PBP data (`pbpResult._bdl.biggestLeadHome/Away`), NOT from BDL box_scores (field doesn't exist). The server adapter already populates this correctly via `parseBDLPBPServer()`. In computeServer, it's accessed as `hs.biggest_lead` / `as.biggest_lead` because `buildSummaryFromBDLServer` copies it from `bdl.biggestLeadHome/Away`.

Verify this path is working in production before changing the formula — if biggest_lead is 0 in snapshots, we have the same data quality issue.

---

### I5: Sustained Execution (was "Tempo & Efficiency")
**Weight: 25% (was 10%)**
**Status: NEEDS BUILDING — NEW INDICATOR**

#### Old Formula
```
effD = (hOPPP - aDPPP) - (aOPPP - hDPPP)
> +0.08 → 1.0, < -0.08 → 0.0, else 0.5
```

#### Why It Was Replaced
- effD agrees with score margin only 34.5% — INVERTED
- 44.4% accuracy (worse than coin flip)
- EVEN 82% of the time (decisive in only 9/50 games)
- Mathematically broken: OPPP/DPPP formula collapses to near-zero because both teams have ~equal possessions
- Alternative metrics (ORtg, NetRtg) were 100% but tautological (restate final score)

#### New Formula
```
Run detection: 6+ consecutive points by one team from PBP score log
runShare = team's runs / total runs in game
Minimum volume gate: totalRuns < 4 → EVEN regardless

runShare > 0.60 → 1.0
runShare < 0.40 → 0.0
else → 0.5 (EVEN)
```

#### Accuracy
- Run count diff (raw): 91.6% (95 decisive, 14 EVEN)
- Run share (60/40): 96.6% (58 decisive, 51 EVEN) — this is what we're shipping
- Run count diff ±2: 100% (45/45)
- Run pts share ±15%: 100% (44/44)
- When count and pts agree: 93.5% (93 games, only 1 split in 109 games)

#### Why Run Share > Raw Diff
Run share naturally accounts for volume. 3-of-4 runs (75%) is more dominant than 7-of-13 (54%) even though raw diff is larger in the second case. The 60/40 threshold tested at 96.6% — highest precision signal in the system.

#### Why Runs Are Independent
A scoring run requires BOTH offense (scoring) AND defense (stopping the opponent) across multiple consecutive possessions. No other indicator measures sequential execution quality:
- I1 counts disruptions in aggregate
- I2 measures interior efficiency in aggregate  
- I3 measures shot quality in aggregate
- I4 measures peak leads and closing
- I5 (runs) measures the PROCESS of chaining stops into scores

You can win the steal battle without generating runs (isolated transition plays). You can generate runs without winning steals (half-court stops + execution). Genuinely independent.

#### Implementation Requirements
- PBP score log → run detection algorithm
- Already exists in server PBP parser (`parseBDLPBPServer`) — `runs` array with team, pts, count, mechanism
- Need to compute runShare from existing runs data
- Add to computeServer and all compute variants

#### Run Detection Algorithm (from existing server code)
```javascript
// Existing: runs tracked in parseBDLPBPServer
// scoreLog: [{team, pts, hScore, aScore, q}, ...]
// Consecutive scoring by same team, 6+ pts = run
// runs: [{team, pts, count, q, mechanism, si, ei}, ...]
```

The run data already flows through — we just need to compute runShare from it and use it in the indicator calculation.

---

## WEIGHT DISTRIBUTION

### Sim Results (109 games)
```
Current (25/25/20/20/10): 79.8%
Equal (20/20/20/20/20):   84.4%
I5-heavy (20/20/20/15/25): 85.3% ← BEST
I5-heavy2 (15/20/20/20/25): 85.3% ← BEST (tied)
I5-max (15/20/20/20/25): 85.3% ← BEST (tied)
I1-light (10/25/25/20/20): 83.5%
I1-drop (0/25/25/25/25): 79.8%
```

### Recommended Weights: 15/20/20/20/25
- I1 at 15%: weakest reliable signal (74.2%)
- I2 at 20%: solid mid-tier (77.0%)
- I3 at 20%: strong + canary role (83.7%)
- I4 at 20%: elite when data is correct (92.1-97.5%)
- I5 at 25%: highest precision (96.5%)

NOTE: The weight sim was run with corrupted I4 data (biggest_lead = 0 from BDL). Re-sim with correct I4 data before finalizing weights. I4 at 97.5% might warrant higher weight.

---

## 2-INDICATOR COMBO ACCURACY

When any two indicators agree (both decisive, same direction):

| Combo | Accuracy | Games |
|-------|----------|-------|
| I3+I5 | **100%** | 38 |
| I1+I5 | 97.1% | 35 |
| I2+I5 | 96.7% | 30 |
| I4+I5 | 95.0% | 20 |
| I1+I3 | 91.7% | 48 |
| I2+I3 | 90.7% | 43 |
| I1+I2 | 87.8% | 49 |
| I2+I4 | 60.0% | 25 (I4 data corrupted) |
| I1+I4 | 54.5% | 33 (I4 data corrupted) |

I5 paired with anything is 95%+. I3 paired with anything is 87%+. These are the conviction anchors.

---

## BUILD PLAN — IMPLEMENTATION DETAILS

### Files That Need Changes

| File | I1 Changes | I4 Changes | I5 Changes | Weights |
|------|-----------|-----------|-----------|---------|
| `poll-live-bdl.mjs` | computeServer, window, raw_stats_json, Sonnet prompt | computeServer, window, season Q4 pipeline | computeServer, window, run detection | W object |
| `bdl.html` | compute(), QD window, crossfade window, evidence | compute(), QD window, crossfade window | compute(), QD window, crossfade window | W object (×5 locations) |
| `ncaamb-bdl.html` | compute(), QD window, crossfade window, computeBDL() | same | same | W object |

### Server Changes (`poll-live-bdl.mjs`)

#### 1. computeServer() — I1 block (~line 1045-1062)
Replace gen+conv+chaos with disruption+POT:
```javascript
// I1 — Disruption & Conversion
const disruptDiff = (hs.steals||0) + (hs.blocks||0) - (as.steals||0) - (as.blocks||0);
let i1subA = disruptDiff > 1 ? 1 : disruptDiff < -1 ? -1 : 0;
const hPOT = hs.points_off_turnovers || 0, aPOT = as.points_off_turnovers || 0;
const potDiff = hPOT - aPOT;
let i1subB = potDiff > 4 ? 1 : potDiff < -4 ? -1 : 0;
const i1raw = i1subA + i1subB;
const I1 = { score: i1raw > 0 ? 1 : i1raw === 0 ? 0.5 : 0, leader: ... };
```
NOTE: Decide whether to keep chaos layer (±0.5 on i1raw). If keeping, it applies AFTER i1subA+i1subB, same as current.

#### 2. computeServer() — I4 block (~line 1095-1107)
Replace trend+bench with biggestLead+lastQ/sznQ4:
```javascript
// I4 — Game Control
const hBigLead = hs.biggest_lead || 0, aBigLead = as.biggest_lead || 0;
const bigLeadDiff = hBigLead - aBigLead;
let i4subA = bigLeadDiff > 4 ? 1 : bigLeadDiff < -4 ? -1 : 0;
// Sub-B: live lastQ if Q4+, else season Q4 prior
let i4subB = 0;
if (currentPeriod >= 4) {
  // Use live last quarter diff
  const lastQ = periods[periods.length - 1];
  const lastQDiff = (lastQ?.home_points || 0) - (lastQ?.away_points || 0);
  i4subB = lastQDiff > 2 ? 1 : lastQDiff < -2 ? -1 : 0;
} else {
  // Use season Q4 margin differential (from cached profiles)
  const sznQ4diff = (seasonQ4[hA] || 0) - (seasonQ4[aA] || 0);
  i4subB = sznQ4diff > 2 ? 1 : sznQ4diff < -2 ? -1 : 0;
}
const i4raw = i4subA + i4subB;
const I4 = { score: i4raw > 0 ? 1 : i4raw === 0 ? 0.5 : 0, leader: ... };
```

#### 3. computeServer() — I5 block (~line 1109-1115)
Replace effD with runShare:
```javascript
// I5 — Sustained Execution
let I5 = { score: 0.5, leader: 'EVEN' };
if (pbpData?.runs) {
  const hRuns = pbpData.runs.filter(r => r.team === hA).length;
  const aRuns = pbpData.runs.filter(r => r.team === aA).length;
  const totalRuns = hRuns + aRuns;
  if (totalRuns >= 4) {
    const runShare = hRuns / totalRuns;
    I5 = { score: runShare > 0.60 ? 1 : runShare < 0.40 ? 0 : 0.5,
           leader: runShare > 0.60 ? hA : runShare < 0.40 ? aA : 'EVEN' };
  }
}
```
NOTE: Run detection already exists in `parseBDLPBPServer`. The `runs` array is on `pbpResult`. But the current run threshold is 8+ pts or 3+ scores. For I5, we need 6+ pts. Check and align the threshold.

#### 4. Server window I2 — already shipped
#### 5. Server window I1/I4/I5 — same formula adjustments with scaled thresholds

#### 6. Weights — W object
```javascript
const W = { I1: 0.15, I2: 0.20, I3: 0.20, I4: 0.20, I5: 0.25 };
```
Search for ALL W object declarations (server has at least 2, each client has 4-5).

#### 7. raw_stats_json expansion
Add to snapshot INSERT:
```
stl, blk (already there for stl, add blk tracking)
runs: { home: hRunCount, away: aRunCount, total: totalRuns, homeShare: runShare }
```

#### 8. Sonnet prompt labels
- I1: "Disruption & Conversion" (was "Possession")
- I4: "Game Control" (was "Lineup")  
- I5: "Sustained Execution" (was "Tempo")
- Update system prompt descriptions for each

#### 9. Season Q4 pipeline for I4
- Query games table for team Q4 margins at poll start
- Cache per-slate (same pattern as season_cache)
- Pass into computeServer context

### Client Changes (bdl.html, ncaamb-bdl.html)
Mirror all formula changes in:
- Main `compute()` function
- QD window (possession-based data from PBP)
- Crossfade window (stats-based data from quarter boundaries)
- Evidence view text
- `computeBDL()` in NCAAMB (graceful fallback for missing data)

### What Does NOT Change
- I2 formula (already shipped)
- I3 formula (unchanged)
- TP/structRate (independent — reads paint/FTM/POT/SCP directly)
- Sustainability audit (independent — reads 3PT stats)
- Alert thresholds (gate on floor score, not individual indicators)
- Snapshot table schema (i1-i5 columns still store 0/0.5/1.0)
- Rolling window recompute (reads stored i1-i5 values)

---

## DATA SOURCES FOR EACH INDICATOR

| Indicator | Sub-A Source | Sub-B Source |
|-----------|-------------|-------------|
| I1 | Box score: stl, blk per player | PBP: POT tracking (pendPOT after turnovers) |
| I2 | PBP: paint zone made shots × 2 | PBP: rim zone made/att |
| I3 | Box score: FGM, FGA, 3PM, AST | PBP: C&S threes (assisted 3PM) |
| I4 | PBP: score progression → biggest lead | Periods array (live Q4) OR games table (season Q4) |
| I5 | PBP: score log → run detection → runShare | (single signal) |

I1 Sub-A can work without PBP (stl/blk from box score). Everything else needs PBP.
For NCAAMB `computeBDL()` where PBP may not be available: I4 Sub-A may be 0 (no biggest_lead), I5 = EVEN (no runs). Graceful degradation.

---

## RUN THRESHOLD ALIGNMENT

Current server run detection threshold: `runPts >= 8 || runCount >= 3`
I5 needs: `runPts >= 6`

These need to be aligned. Either:
- Lower the existing threshold to 6 (affects most_unanswered and other run consumers)
- Create a separate run count for I5 with the 6-pt threshold

Safer path: separate I5 run count at 6+ pts to avoid breaking existing consumers.

---

## NEXT SESSION CHECKLIST

1. Clone repo, verify file state
2. Re-run full system sim with CORRECT I4 data (PBP-derived biggest_lead) to validate weights
3. Finalize weights based on corrected sim
4. Build I1 changes (all files)
5. Build I4 changes (all files + season Q4 pipeline)
6. Build I5 changes (all files + run detection alignment)
7. Update weights everywhere
8. Update Sonnet prompts and evidence text
9. Syntax check all files
10. Push and deploy
11. Verify on live games
