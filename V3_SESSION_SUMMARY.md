# V3 Dashboard Build — Session Summary (Apr 22, 2026)

## Current State (1,895 lines, deployed at /v3.html)

### Phase 1: Shell + Navigation ✅
- Geist font family, dark design system with green accent
- SR schedule loading, BDL box score status correction
- All games mount cards on load (no selection needed)
- Pills = scroll-to navigation (tap pill → smooth scroll to card)
- Single card focus with horizontal swipe + snap scrolling + page dots
- Hero: scores, team abbreviation + conference rank, venue
- ESPN WP area chart with play-level resolution
- 90s poll loop for live score updates
- Date navigation (yesterday/today/upcoming)

### Phase 2: DB Hydration + Value Read + Sonnet Signal + Structural Read ✅
- **DB Pipeline**: initDB → localStorage restore → hydrateFromServerSnapshots (floor, WP, odds, sust, quarter diffs, full snapshot array) → syncAnalysesFromDB → syncCalibrationAnalyses → applyAutoAnalysesToCards → syncLatestSnapshotsFromDB → fetchPBPFromDB
- **Value Read**: Two-row FWP/Edge/ML/Spread table with winner row highlighted (green bg). Edge colored green/coral. Conviction bar with tier + combo. FWP always shows %.
- **Sonnet Signal**: Collapsed view shows NARRATIVE (falls back to CLOSING). Tap to expand: Narrative → Risk → Disagreement → Closing signal cards. CSS grid-template-rows transition.
- **Structural Read**: Floor score + meter bar + verdict. QTR/PBP window grid with deltas. I1-I5 indicator pills (won/even). Sustainability rows (leading/trailing) with tier pills. Combined read pill in header.

### Phase 3: Collapsible Evidence Sections ✅
- **Scoring Composition**: Per-team stacked bars (paint/FT/3PT/mid) with shooting % inside bars (black text). Made/attempted detail line below each bar. S:V percentage labels. Structural + Variance delta rows with **trend arrows** (current quarter vs cumulative average). Lead source classification (STRUCTURAL/VOLATILE/MIXED/EVEN) with durability text. Data computed from PBP audit zone data.
- **Margin Flow + Scoring Runs**: SVG margin chart (H=220, shot markers: filled circle=2PT r=4.5, crosshair=3PT r=5.5, square=FT 6x6). Run overlay bands. Quarter dividers. Scoring runs list sorted by size with mechanism bars. Bidirectional cross-interaction (tap run → highlight on chart).
- Collapsible framework: CSS grid-template-rows 0fr→1fr, chevron + title + summary.
- Deep Dive button at bottom of each card opens drawer.

### Phase 4: Drawer + Deep Dive ✅
- 92vh slide-up panel with scrim overlay, handle bar, close button
- **Section order**: Game Narrative → Quarter Dominance → Snapshot History → Game Log

#### 1. Game Narrative (horizontal scroll)
- Cards from `analysisHistory` (built from auto Q1/Q2/Q3 analyses)
- Each card (160px wide): Q/clock, score, floor, conviction detail, tier pill
- **Sustainability badges** per team (parsed from "LAL: LOCKED | HOU: DUR")
- Latest card highlighted with green border

#### 2. Quarter Dominance Grid
- Delta-based: +/- for each stat per quarter from control team perspective
- Columns: PNT, FTA, 3PM, TO (inverted correctly — fewer=green), STL, AST
- Green = control team winning, coral = losing
- TREND row with directional arrows (latest vs per-quarter average)
- Partial quarter marked with asterisk

#### 3. Snapshot History
- Uses `_allSnapshots` from DB (stored during hydration, every 60s)
- **Most recent first** (inverted), latest row highlighted with green border
- Columns: Time, Score, Floor, MF (running mean), Peak (max seen), I1-I5 (colored dots), TP, LS, Grad, ML, Alert, Decision
- **I1-I5 as colored dots**: green=won (≥0.6), grey=contested, coral=lost (≤0.4). **Control-team-relative** — flips when floor_team is away.
- **No leading zeros**: `.85` not `0.85`
- **ML odds**: Fetched from `odds_history` table (`action=get_odds`), cross-referenced by closest timestamp. Shows `away_ml/home_ml`.
- **Graduation**: From cross-referenced alerts (`graduation_rank`)
- **Column toggle buttons**: Tap to hide/show any column. Green=visible, dim=hidden. State persists per card.
- Sampled every 3rd snapshot to keep table manageable

#### 4. Game Log (bottom)
- All alerts sorted **most recent first**
- Alert type + tier, Q/clock/floor, agent decision (SEND green / SUPPRESS coral at 50% opacity)
- Full agent reasoning text
- Conviction tier + combo
- Correct/Wrong outcome badges for FINAL games

## What's NOT Done Yet

### Phase 5 — Polish & Live Features
- **Client-side BDL compute loop** — currently all data comes from DB (60s behind). Need to port `fetchSummaryBDL` → `parseBDLPBP` → indicator computation for real-time live updates. DB hydration becomes fallback for cold starts.
- **Confidence table** — on-demand via ≡ menu
- **Toast alerts** — with Bet365 deep link (skeleton exists, not wired)
- **Depth Audit** — half-court SVG shot zones (deferred, complex)
- **Analyze button** — trigger Sonnet analysis from v3 (currently view-only)
- **Demo mode + presets** — for testing without live games
- **Team colors** — 30-team color lookup for abbreviations throughout
- **ESPN WP chart for FINAL games** — needs WP history cached to snapshots during game
- **Erosion column** — on alerts table but not yet in snapshot cross-reference
- **Sust column in snapshot table** — available in `sust_json` JSONB on snapshots, not yet parsed for table

### Key Functions Ported to v3
| Function | Status | Notes |
|----------|--------|-------|
| `getFloor` | ✅ | Fallback chain: sonnet → client → server → window |
| `parseSonnetDecision` | ✅ | FWP, edge, conviction, v2 fields |
| `hydrateFromServerSnapshots` | ✅ | Floor, WP, odds, sust, quarter diffs, full snapshot array |
| `syncAnalysesFromDB` | ✅ | Manual analyses |
| `syncCalibrationAnalyses` | ✅ | Auto Q1/Q2/Q3 analyses |
| `applyAutoAnalysesToCards` | ✅ | Prediction + analysisHistory from autos |
| `fetchPBPFromDB` | ✅ | PBP from `get_pbp` action |
| `computeScoringComp` | ✅ | From PBP zone data (rim/paint/mid/threes) |
| `fetchOddsHistory` | ✅ | ML odds from `get_odds` action |
| `computeIndicatorsBDL` | ❌ | Not ported — using server snapshots instead |
| `fetchSummaryBDL` | ❌ | Not ported — needed for real-time live updates |
| `parseBDLPBP` | ❌ | Not ported — PBP comes from DB |
| `computeLeadCompositionClient` | Partial | Simplified version in scoringComp |
| `computeAcceleration` | ❌ | Not needed yet (server computes) |
| `classifyCombinedRead` | ❌ | Not needed yet (server computes) |

### Design Decisions Locked
- All games open by default, no selection
- Single card focus with swipe navigation
- Toolbar: WP, Upload Clutch, ≡ menu
- Narrative leads Sonnet Signal (not CLOSING)
- Expanded order: Narrative → Risk → Disagreement → Closing
- Scoring comp bars: black text, shooting % inside, made/att below
- Margin flow: H=220, large markers, run cross-interaction
- Drawer order: Narrative → Quarter Dominance → Snapshot History → Game Log
- Snapshot history: most recent first, column toggles, dot indicators
- Game log: most recent first
- Trend arrows: current quarter vs cumulative (not last completed quarter)

### Files Modified This Session
- `v3.html` — 1,895 lines (Phase 1-4 complete)
- `V3_DASHBOARD_SPEC.md` — 926 lines (original spec, some sections superseded by implementation)
- `V3_SESSION_SUMMARY.md` — this file
