# V3 Dashboard Build — Session Summary (Apr 22, 2026)

## What Was Done This Session

### Design & Spec
- Created `V3_DASHBOARD_SPEC.md` (920 lines) — complete design specification for the v3 mobile-first dashboard
- Built interactive mockup (`v3-mockup.html`) demonstrating all UI patterns
- Iterated through 6 rounds of design feedback with Manny, refining:
  - Card layout order: Hero → WP → Value Read → Sonnet Signal → Structural Read → Collapsibles → Deep Dive
  - Killed "Foundation" badge/stats grid — floor display leads structural read directly
  - Sonnet Signal: collapsible on-card (not in drawer), shows CLOSING summary with ⚠ RISK / ⊘ DISAGREE badges
  - Margin flow: shot markers (circles=2PT, squares=FT, crosshairs=3PT) + run overlay bands behind path
  - Toast with Bet365 deep link, future multi-book line shopping spec
  - Game log table in drawer with ALL alerts including suppressed (at 50% opacity)
  - Analyze button lives in Sonnet Signal section, not chrome
  - Team colors noted as future enhancement

### Phase 1 Build (SHIPPED)
- Created `v3.html` (577 lines) — working dashboard alongside `bdl.html`
- **3 deploys shipped:**
  1. Initial shell: schedule loading, pills, hero, WP chart
  2. Bug fixes: date switch card persistence + card width overflow
  3. All-games-open: pills become scroll-to navigation

### Current State (Live at /v3.html)
- Schedule loads from SR, corrected with BDL box scores
- ALL games mount cards on load (no selection needed)
- Pills = scroll-to navigation (tap pill → smooth scroll to card)
- Active pill tracks centered card via scroll listener
- Hero renders with real scores, team names, conference rank
- ESPN WP area chart with play-level resolution
- 90s poll loop updates all game scores
- Date navigation (yesterday/today/upcoming)
- Swipe between cards with snap scrolling + page dots
- Placeholder sections for value read, sonnet signal, structural read

## What's Next: Phase 2

### Priority Order
1. **Port `computeIndicatorsBDL()`** (~400 lines from bdl.html lines ~2827-3500)
   - Server-side indicators from BDL box score data
   - I1-I5 scores + composite floor + control team
   - This unlocks the Structural Read section

2. **Port snapshot hydration** (~300 lines)
   - `hydrateFromServerSnapshots()` (line 491) — fills cardState from DB snapshots
   - `syncAnalysesFromDB()` (line 923) — loads auto-analyses for all games
   - `syncLatestSnapshotsFromDB()` (line 992) — latest snapshot per game
   - `applyAutoAnalysesToCards()` (line 1039) — applies auto-analysis to cardState

3. **Port analysis parsing** (~200 lines)
   - `parseSonnetDecision()` — extracts FWP, edge, conviction, CLOSING, RISK, DISAGREEMENT
   - `parseSonnetScores()` — extracts I1-I5 from Sonnet text
   - These unlock Value Read and Sonnet Signal

4. **Port sustainability** (~100 lines)
   - `computeSustainabilityDirect()` or hydrate from `sust_json` on snapshots
   - Unlocks sustainability pills in Structural Read

5. **Render Value Read** (~150 lines new)
   - FWP/edge/ML/spread table
   - Conviction bar
   - Winner row highlighting

6. **Render Sonnet Signal** (~100 lines new)
   - Collapsed: CLOSING summary text + RISK/DISAGREE badges
   - Expanded: signal cards (CLOSING/RISK/DISAGREEMENT)
   - ⚡ ANALYZE button in fallback state

7. **Render Structural Read** (~200 lines new)
   - Floor display (team + score + meter + verdict)
   - Windows (QTR + PBP)
   - Indicator strip (I1-I5 pills)
   - Sustainability rows (leading + trailing)

### Key bdl.html Line References for Porting
| Function | Lines | Purpose |
|----------|-------|---------|
| `computeIndicatorsBDL` | ~2827-3500 | Core I1-I5 from BDL data |
| `fetchSummaryBDL` | ~2550-2710 | Full BDL summary fetch + indicator compute |
| `hydrateFromServerSnapshots` | 491-678 | DB snapshot → cardState |
| `hydrateFromServerContext` | 679-816 | Server context → cardState |
| `syncAnalysesFromDB` | 923-991 | Load all auto-analyses |
| `applyAutoAnalysesToCards` | 1039-1247 | Parse + apply analyses |
| `parseSonnetDecision` | grep for function | FWP/edge/conviction parser |
| `parseSonnetScores` | grep for function | I1-I5 from Sonnet text |
| `getFloor` | grep for function | Floor fallback chain |
| `computeSustainabilityDirect` | grep for function | Client sust computation |
| `buildScoringComp` / lead comp | ~7000-7120 | S:V scoring composition |

### Files Modified
- `v3.html` — new file (577 lines, Phase 1)
- `V3_DASHBOARD_SPEC.md` — new file (920 lines, complete spec)

### Design Decisions Locked
- All games open by default, no selection
- Single card focus with swipe navigation
- Toolbar: WP, Upload Clutch, ≡ menu (killed 7 controls)
- Alert bar (top, edge glow) + Toast (bottom, Bet365 link)
- Drawer for deep dive: narrative → per-quarter → odds → game log
- Confidence table on-demand via ≡ menu
