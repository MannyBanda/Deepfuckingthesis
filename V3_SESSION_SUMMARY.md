# V3 Dashboard Build — Session Summary (Apr 22, 2026)

## Current State (2,465 lines, deployed at /v3.html)

### Phase 1: Shell + Navigation ✅
- Geist font family, dark design system with green accent
- SR schedule loading, BDL box score status correction
- All games mount cards on load (no selection needed)
- Pills = scroll-to navigation (tap pill → smooth scroll to card)
- Single card focus with horizontal swipe + snap scrolling + page dots
- Hero: scores, team abbreviation + conference rank, venue
- ESPN WP area chart with play-level resolution
- 10s poll loop for live score updates + alert polling
- Date navigation (yesterday/today/upcoming)

### Phase 2: DB Hydration + Value Read + Sonnet Signal + Structural Read ✅
- **DB Pipeline**: initDB → localStorage restore → hydrateFromServerSnapshots → syncAnalysesFromDB → syncCalibrationAnalyses → syncLatestSnapshotsFromDB → syncThesesFromDB → fetchPBPFromDB
- **Value Read**: Two-row FWP/Edge/ML/Spread table with winner row highlighted (green bg + ▶ arrow). Edge colored green/coral. Conviction bar with tier + combo. FWP always shows %. Winner detection from fwpLabeled/fwpTeam1/fwpVal1.
- **Sonnet Signal**: Collapsed view shows NARRATIVE (falls back to CLOSING). Tap to expand: Narrative → Risk → Disagreement → Closing signal cards. Collapsed text hides when expanded (no duplication). RISK nulled when starts with "NONE" (same as disagreement). CSS grid-template-rows transition.
- **Structural Read**: Floor score + meter bar + verdict. QTR/PBP window grid with deltas. I1-I5 indicator pills (won/even). Sustainability rows (leading/trailing) with tier pills. Combined read pill in header.

### Phase 3: Collapsible Evidence Sections ✅
- **Scoring Composition**: Per-team stacked bars with shooting %. Summary shows structural/variance team leaders with trend arrows (e.g., "S: BOS +14 ▼ · V: PHI +28 ▬"). Lead source classification.
- **Margin Flow + Scoring Runs**: SVG margin chart with shot markers and run overlay bands. Cross-interaction.
- **Pre-Game Thesis**: Dedicated collapsible on every card. Default OPEN for PRE games, collapsed for LIVE/FINAL. Hydrated from DB via syncThesesFromDB.

### Phase 4: Drawer + Deep Dive ✅
- 92vh slide-up panel with scrim overlay, handle bar, close button
- **Swipe-down-to-dismiss** (120px threshold, spring-back animation)
- Sections: Game Narrative → Quarter Dominance → Snapshot History (with ML from odds_history) → Game Log

### Phase 5: Toast + Line Shopping + Analysis ✅ (NEW this session)

#### Toast with Line Shopping
- **Auto-appears** on SEND entry alerts (BUY, WINDOW_BUY, BWC_EDGE, POSITION_OPEN, RE_ENTRY_VALUE)
- **Shows on page load** if unseen SEND alerts exist from earlier
- **⚡ button** in chrome: manual trigger with green badge indicator, shows latest SEND alert
- **Follows swipe**: toast updates to show the active game's latest alert when swiping cards
- **Dismissed alert memory**: dismissed alerts tracked in `_dismissedAlertIds`, won't auto-show again. Only new alerts trigger auto-toast.
- **The Odds API integration** (paid plan, 20K credits/month, key: `ODDS_API_KEY` env var)
  - Live games: `/v4/sports/basketball_nba/odds` (1 credit per call)
  - Completed games: `/v4/historical/sports/basketball_nba/odds?date=ISO` (10 credits)
  - Proxy function: `netlify/functions/odds-api.js`
  - Date format: `YYYY-MM-DDTHH:MM:SSZ` (no milliseconds)
- **Meticulous ML team matching**: alert `floor_team` → determine home/away → pick correct outcome from each bookmaker
- **Game matching**: exact `market + ' ' + name` match (e.g., "Boston Celtics")
- **20+ sportsbooks** supported: DraftKings, FanDuel, Caesars (williamhill_us key), BetMGM, BetRivers, Bovada, Fanatics, ESPN BET, BetOnline, LowVig, MyBookie, BetUS, BetParx, Fliff, Bally Bet, ReBet, Hard Rock, Pinnacle, etc.
- **Pagination**: top 7 books shown by default, "Show all N ▼" expands full list
- **Best line tagged green** with "BEST" label, sorted by highest ML
- **Universal Links**: web URLs open sportsbook apps automatically on iOS (no Safari error)
- **10s live refresh** while toast is open (stops for FINAL games, stops on dismiss)
- **Swipe-down-to-dismiss** (80px threshold)

#### ⚡ Analyze Button
- Manual Sonnet analysis trigger from v3 (uses Opus 4.6)
- Shows in Sonnet Signal section: green "⚡ Analyze" (no analysis) or amber "⚡ Re-Analyze" (has analysis)
- Shows for LIVE, HALF, and FINAL games
- Fetches BDL box score on demand → builds summary → calls analyze.js → parses response
- Updates prediction (FWP, edge, narrative, risk, closing, disagreement, conviction) → re-renders
- Thesis text sent to Opus for pre-game context
- 40s abort controller timeout

#### Model Upgrades
- `analyze.js`: Sonnet 4 → **Opus 4.6**
- `poll-live-bdl.mjs` auto-analysis: Sonnet 4 → **Opus 4.6**
- Alert agent: already Opus 4.6 (unchanged)

#### Other Changes
- Poll interval: 90s → **10s** for real-time monitoring
- Bet365 added to vendor list in bdl-enrich.js (though not returned by BDL/Odds API)
- BetMGM removed from BDL vendor priority order

## What's NOT Done Yet

### Phase 5 Remaining — Polish & Features
- **Client-side BDL compute loop** — currently all data comes from DB (server snapshots). Need to port `fetchSummaryBDL` → `parseBDLPBP` → indicator computation for real-time live updates between server polls.
- **Confidence table** — on-demand via ≡ menu, all games' structural state in one view
- **Team colors** — 30-team color lookup for abbreviations throughout
- **Depth Audit** — half-court SVG shot zones (deferred, complex)
- **Demo mode + presets** — for testing without live games
- **ESPN WP chart for FINAL games** — needs WP history cached
- **Sust column** in snapshot history table — available in `sust_json`, not parsed
- **Erosion column** in snapshot history — available in alerts, not cross-referenced

### Key Functions Ported to v3
| Function | Status | Notes |
|----------|--------|-------|
| `getFloor` | ✅ | Fallback chain: sonnet → client → server → window |
| `parseSonnetDecision` | ✅ | FWP, edge, conviction, v2 fields, RISK/NONE null handling |
| `hydrateFromServerSnapshots` | ✅ | Floor, WP, odds, sust, quarter diffs, full snapshot array |
| `syncAnalysesFromDB` | ✅ | Manual analyses |
| `syncCalibrationAnalyses` | ✅ | Auto Q1/Q2/Q3 analyses |
| `applyAutoAnalysesToCards` | ✅ | Prediction + analysisHistory from autos |
| `syncThesesFromDB` | ✅ | Theses from DB, re-renders on load |
| `fetchPBPFromDB` | ✅ | PBP from `get_pbp` action |
| `computeScoringComp` | ✅ | From PBP zone data |
| `fetchOddsHistory` | ✅ | ML odds from `get_odds` action |
| `buildV3Summary` | ✅ | Lightweight BDL box score → SR-shaped summary |
| `triggerAnalysis` | ✅ | Manual Opus analysis with thesis context |
| `pollAlerts` | ✅ | 10s alert polling for toast |
| `fetchLineShop` | ✅ | The Odds API integration with historical support |
| `computeIndicatorsBDL` | ❌ | Not ported — using server snapshots instead |
| `fetchSummaryBDL` | ❌ | Not ported — needed for real-time live updates |
| `parseBDLPBP` | ❌ | Not ported — PBP comes from DB |

### Design Decisions Locked
- All games open by default, no selection
- Single card focus with swipe navigation
- Toolbar: WP, ⚡ (toast/alerts with badge), ≡ menu
- Narrative leads Sonnet Signal (not CLOSING), hides when expanded
- Scoring comp summary: structural/variance leaders with trend arrows
- Drawer: swipe-down-to-dismiss (120px), sections: Narrative → Quarter Dominance → Snapshot History → Game Log
- Toast: auto on SEND, follows swipe, dismissed memory, top 7 + expandable, 10s refresh, Universal Links
- Thesis: dedicated collapsible, open for PRE, collapsed for LIVE/FINAL
- RISK/NONE nulled at parser level (same as disagreement)

### Files Modified This Session
- `v3.html` — 2,465 lines (Phase 1-5)
- `netlify/functions/odds-api.js` — NEW (The Odds API proxy with historical support)
- `netlify/functions/analyze.js` — model upgrade to Opus 4.6
- `netlify/functions/poll-live-bdl.mjs` — model upgrade to Opus 4.6
- `netlify/functions/bdl-enrich.js` — vendor order update (bet365 added, betmgm deprioritized)
- `V3_SESSION_SUMMARY.md` — this file

### Environment Variables Added
- `ODDS_API_KEY` — The Odds API paid plan key (20K credits/month)
