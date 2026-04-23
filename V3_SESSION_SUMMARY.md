# V3 Dashboard Build — Session Summary (Apr 23, 2026)

## Current State (3,421 lines, deployed at /v3.html)

### Phase 1-5: ALL SHIPPED (prior session)
- Shell, pills, hero, WP chart, swipe navigation, 10s poll
- DB hydration pipeline, Value Read, Sonnet Signal, Structural Read
- Scoring Comp, Margin Flow, Drawer (narrative, quarter dom, snapshot history, game log)
- Toast + Line Shopping (Odds API), Analyze (Opus 4.6), client-side BDL compute
- PBP parser, ESPN WP persistence, thesis auto-hydration

### This Session (20 commits)

#### Toast Fixes
- **Scoped to active game** — auto-toast only fires for the currently swiped game
- **FINAL suppression** — no auto-toast for finalized games; swiping to FINAL dismisses visible toast

#### Snapshot History Enhancements
- **3 new columns**: Margin (+/- floor-team-relative, colored), Sustainability (ctrl team tier), Erosion (from alerts)
- **Hide All / Show All** toggle button — strips to Time+Score only, tap again restores defaults
- All columns default visible

#### Live Quarter Dominance
- **Pulsing partial row** for current quarter — computed from BDL box score vs last server boundary
- Updates every 10s with poll cycle
- **TO display fixed** — shows raw delta, green when fewer TOs (intuitive: -3 TO = good)
- **TREND fixed** — cumulative sum across all quarters (not latest vs average), inverted for TO

#### ESPN WP DB Persistence
- `games.espn_wp_json` JSONB column
- Server fetches full WP history at game finalization via `espnWPHistoryFull()`
- Client reads from DB first (via `get_quarter_data` response), localStorage fallback
- WP chart works next-day without client being awake

#### Team Colors (30 teams)
- `TC` lookup table + `tc(alias)` helper function
- Applied to: hero abbreviations, ESPN WP label, floor team, value read table, sustainability rows, scoring comp headers, toast bet team, quarter dominance perspective label
- Dark colors adjusted for dark background (DEN=gold, IND=gold, MIN=lighter blue, BKN=gray, etc.)

#### Confidence Table
- All games at a glance — toggled via ≡ hamburger button
- Slides between pills and card area
- Columns: Game, Floor, FWP, Edge, Conv, TP, LS, Sust, ML
- LIVE first → PRE → FINAL (dimmed). Tap row → closes table + scrolls to game
- Team colors on abbreviations, efficiency colors on values

#### Shot Zones (ported from bdl.html)
- **Zone bubbles** sized by attempt volume, colored by efficiency (green→yellow→orange→red)
- **Both teams** — home court (rim bottom) + away court (reflected, rim top)
- **Tap zone** → player detail panel (top 5 players, made/att/pct)
- **S:V%** structural vs variance header per team
- Renamed from "Depth Audit · Shot Zones" to "Shot Zones"
- Header shows most efficient player (min 4 FGA) with efficiency color

#### PBP Data Hydration Fix
- `fetchPBPFromDB` now has fallback chain: DB (raw shots) → DB (aggregates) → BDL plays direct fetch
- BDL plays fallback fetches `/plays?game_id=` and re-parses client-side via `parseBDLPBP`
- Fixes shot zones + margin flow for FINAL games (DB lacked raw.shots and scoringEvents)
- `get_pbp` endpoint now returns `box_score_json` alongside `pbp_json`
- `_lastBoxScore` hydrated from DB on card load (reshaped to BDL-compatible format)
- BDL polling overwrites with real per-player data

#### PBP Window
- `computePBPWindow()` — lightweight I1-I5 from last ~36 events (~30 possessions)
- I1: forced TO differential, I2: paint+rim makes, I3: eFG%, I4: point diff, I5: PPP
- Renders in structural read next to QTR window
- Wired into all 3 PBP paths (live fetch, DB with raw shots, BDL fallback)

#### Margin Flow Markers
- 3PT crosshair: r=5.5→7, arms ±7→±9
- FT square: 6×6→8×8
- 2PT dot: r=4.5→5.5
- Legend icons scaled to match

#### Collapsible Header Polish
- Summary text brightened (fg-dim → fg-secondary)
- **Scoring Comp**: S: in green, V: in amber, team names in team colors
- **Shot Zones**: top efficient player with efficiency color
- **Margin Flow**: biggest run team in team color

#### Indicator Evidence Panel (NEW)
- Tap any I1-I5 pill → inline expandable evidence panel
- Selected pill gets green outline, tap again to close
- **I1**: Steals, Blocks, Turnovers (inverted), Forced TO, Unforced TO
- **I2**: Rim FG, Paint FG (from PBP zones), FTA, FTM
- **I3**: eFG%, 3PT (compared by pct not string), Assists, Ast Ratio
- **I4**: Biggest Lead (from PBP), per-quarter scores with margin diff, lead changes + ties
- **I5**: Runs 6+ count + share, individual run point totals per team, FG%
- All rows: green/coral for winning/losing (no team colors = cleaner signal)
- Fraction comparisons fixed — passes actual percentage as comparison value
- Box score from DB on card load → BDL polling overwrites

### Files Modified This Session
- `v3.html` — 3,421 lines (was 2,857)
- `netlify/functions/db-api.js` — espn_wp_json column, box_score_json in get_pbp
- `netlify/functions/poll-live-bdl.mjs` — espnWPHistoryFull() + save at finalization

### Environment Variables Added
- None (all existing)

### Design Decisions Locked
- Team colors: green/coral for win/loss in evidence (no team brand colors = less noise)
- Shot Zones: both courts always visible (no toggle), zone bubbles not zone fills
- PBP Window: lightweight from raw shots (no possessionLog dependency)
- Toast: scoped to active game, no FINAL auto-pop
- Confidence table: ≡ button toggle, between pills and cards
- Snapshot history: all columns default visible, Hide All keeps Time+Score only
