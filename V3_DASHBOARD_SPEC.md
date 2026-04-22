# DFT v3 Dashboard — Design Specification

**File:** `v3.html` (new file, runs alongside `bdl.html`)
**Primary device:** Mobile (iPhone)
**Design reference:** Mockup in project context (Geist font family, dark base, green accent system)
**Data sources:** All existing — BDL box scores, SR supplemental, ESPN WP, server snapshots, Sonnet analyses, sustainability audit, PBP depth

---

## 1. Design System

### Fonts
- **Sans:** Geist (primary — headings, labels, body)
- **Mono:** Geist Mono (scores, numbers, data values, code-like elements)
- Load from Google Fonts: `Geist:wght@300;400;500;600;700` + `Geist+Mono:wght@400;500;600`

### Color Tokens (CSS Variables)
```
--bg-base: #0D0E11          (app background)
--bg-surface: #16181D       (card background)
--bg-surface-2: #1C1F26     (hover states, nested surfaces)
--bg-surface-3: #22262F     (deep nested)

--hairline: rgba(255,255,255,0.06)
--hairline-strong: rgba(255,255,255,0.10)

--fg-primary: #F7F7F5       (main text)
--fg-secondary: #9A9DA6     (supporting text)
--fg-tertiary: #6B6E78      (labels, captions)
--fg-dim: #494D57           (lowest emphasis)

--green: #34D399             (positive, control, structural)
--green-soft: #6EE7B7        (FT bars, secondary green)
--green-dim: rgba(52,211,153,0.14)
--green-border: rgba(52,211,153,0.22)

--amber: #F5B544             (variance, trailing team, caution)
--amber-dim: rgba(245,181,68,0.14)
--amber-border: rgba(245,181,68,0.22)

--coral: #F87171             (danger, negative delta, critical)
--coral-dim: rgba(248,113,113,0.14)
--coral-border: rgba(248,113,113,0.22)

--blue: #7FA8E0              (ESPN WP, neutral data)
--blue-dim: rgba(127,168,224,0.14)
```

### Radii
```
--r-card: 16px     (game card)
--r-inner: 12px    (nested panels)
--r-button: 10px   (icon buttons)
--r-pill: 999px    (pills, chips)
```

### Easing
```
--ease: cubic-bezier(0.2, 0.8, 0.2, 1)
```

### Background
Subtle radial gradient glow from top center:
```
radial-gradient(1200px 600px at 50% -100px, rgba(52,211,153,0.045), transparent 60%), var(--bg-base)
```

---

## 2. Layout Architecture

### Hierarchy (top → bottom)
```
┌─────────────────────────────────────┐
│  Chrome (sticky top bar)            │  — wordmark, icon buttons
├─────────────────────────────────────┤
│  Game Pills (horizontal scroll)     │  — game selectors (pill per game)
├─────────────────────────────────────┤
│  Schedule Meta                      │  — date, game count, timezone
├─────────────────────────────────────┤
│  Game Card (single, swipeable)      │  — the main content area
│  ┌─────────────────────────────┐    │
│  │  Hero (score, status)       │    │
│  │  ESPN WP Chart              │    │
│  ├─────────────────────────────┤    │
│  │  Value Read (table+convict) │    │
│  │  Sonnet Signal (closing     │    │
│  │    summary + RISK/DISAGREE  │    │
│  │    indicators, expandable)  │    │
│  ├─────────────────────────────┤    │
│  │  Structural Read            │    │
│  │    Floor (first)            │    │
│  │    Windows                  │    │
│  │    Indicators               │    │
│  │    Sustainability           │    │
│  ├─────────────────────────────┤    │
│  │  ▸ Scoring Composition      │    │  collapsible
│  │  ▸ Depth Audit · Shot Zones │    │  collapsible
│  │  ▸ Scoring Runs · Margin    │    │  collapsible
│  ├─────────────────────────────┤    │
│  │  Deep Dive button → drawer  │    │
│  └─────────────────────────────┘    │
├─────────────────────────────────────┤
│  Alert Bar (fixed, edge glow)       │  — entry signals, auto-dismiss 5s
└─────────────────────────────────────┘

Drawer (slides up 92vh on Deep Dive tap):
  - Game Narrative (timeline)
  - Per-Quarter Breakdown (table)
  - Market · Odds
  - Game Log (snapshot history table with all alerts incl. suppressed)
```

### Single Card Focus + Swipe
- Only ONE game card visible at a time
- Horizontal swipe (touch) navigates between selected games
- Swipe indicator dots below the card show position (like iOS page dots)
- Game pills stay visible — tapping a pill jumps to that card
- Selecting a new game via pill auto-scrolls the card carousel to it

---

## 3. Chrome (Sticky Top Bar)

**Position:** `sticky`, top: 0, z-index: 20
**Background:** gradient fade `var(--bg-base) 75% → transparent` + `backdrop-filter: blur(14px)`

### Left: Wordmark
```
[●] DFT
```
- Green pulsing dot (6px, `animation: pulse 2.4s`)
- "DFT" in Geist Mono 600, 14px, tracking 0.02em

### Right: Action Buttons (icon buttons, 34×34px)
```
[WP] [⚡] [≡]
```
- **WP** — opens WP Profiles overlay (same as current `showWPProfiles()`)
- **⚡** — opens Upload Clutch panel (file input + L15/L10 segment selector)
- **≡** — opens utility menu (QA, Demo toggle, confidence table)

The utility menu (≡) is a small dropdown or bottom sheet containing:
- **QA** — runs `runClientQA()`
- **Demo** — toggles demo mode with preset strip (TRAIL -10 / LEAD +6 / CLOSE +2)
- **Confidence Table** — toggles confidence table visibility (slides down below pills)

---

## 4. Game Pills

**Position:** Below chrome, horizontal scroll, no scrollbar
**Interaction:** Tap to select/deselect (multi-select up to 5). Tapping navigates the card carousel to that game.

### Pill States
| State | Style |
|-------|-------|
| Default | `--bg-surface` bg, `--hairline` border, `--fg-secondary` text |
| Selected | `green-dim` bg, `green-border` border, `--green` text |
| Live | Same as selected + pulsing green dot before label |
| Final | Default + "F" suffix |
| Pre-game | Default + tip time suffix |

### Pill Label Format
```
GSW@PHX Q3     (live)
DAL@LAC F      (final)
BOS@MIA 7:30p  (pre-game)
```

### Search / Filter
Small search input in the pill strip area (or above it). Same as current — filters pills by team name/alias. Geist Mono, 12px, subtle border.

---

## 5. Schedule Meta

One-line contextual info below pills:
```
2026-04-17 · 2 NBA games · MST
```
- Geist Mono, 11px, `--fg-tertiary`
- Date in `--fg-secondary` (accent)

---

## 6. Game Card Anatomy

### Container
```css
background: var(--bg-surface);
border: 1px solid var(--hairline);
border-radius: var(--r-card);
box-shadow: inset 0 1px 0 rgba(255,255,255,0.03),
            0 1px 2px rgba(0,0,0,0.4),
            0 8px 24px -12px rgba(0,0,0,0.5);
overflow: hidden;
```

The card fills the container width (max-width: 720px, centered). The card is inside a horizontal swipe container that holds all selected game cards side-by-side, snapping to each card.

---

### 6a. Hero Section

**Background:** Radial gradient glow from top: `rgba(52,211,153,0.06)` fading out

#### Status Line (top of hero)
```
Mortgage Matchup Center · Phoenix          FINAL · 00:00
```
- Left: venue/context — Geist Sans 11px, 500wt, uppercase, tracking 0.08em, `--fg-tertiary`
- Right: game state — Geist Mono, `--fg-secondary`
- States: `PRE · 2h 14m` | `LIVE · Q3 4:22` | `FINAL · 00:00`

#### Score Row (centered, 3-column grid)
```
GSW                96 — 111               PHX
Warriors · 10th     (dash)     Suns · 7th
```
- Team abbr: Geist Sans 600, 15px, tracking 0.03em
- Sub: Geist Sans 11px, `--fg-tertiary` (team name + conference rank)
- Score: Geist Mono 500, 38px, tracking -0.02em, `font-feature-settings: "tnum"`
- Em-dash: `--fg-dim`, 400wt, margin 0 6px
- Right team: `text-align: right`

#### Pre-Game State
When `state === 'PRE'`: replace score with countdown timer
```
TIP OFF IN
2h 14m 03s
```
- "TIP OFF IN" — Geist Sans 10px, uppercase, `--fg-tertiary`
- Countdown — Geist Mono 600, large
- Below: "Indicators activate at tip" in `--fg-tertiary`

---

### 6b. ESPN WP Chart

**Visibility:** Always visible when WP data exists (not gated by indicators). Hidden pre-game.

**Layout:**
```
┌───────────────────────────────────────┐
│ ESPN WP    PHX 86%  ▲ +34    open 52% │
│ ┌───────────────────────────────────┐ │
│ │  PHX                              │ │  ← team label, top-left
│ │  ~~~~~~~~area chart~~~~~~~~~~     │ │  ← SVG area chart, 96px tall
│ │  GSW                              │ │  ← team label, bottom-left
│ └───────────────────────────────────┘ │
│    1st      2nd      3rd      4th     │  ← quarter labels
└───────────────────────────────────────┘
```

**Header row:**
- "ESPN WP" — Geist Sans 10px, 600wt, uppercase, tracking 0.14em, `--fg-tertiary`
- WP value — Geist Mono 14px, 600wt, `--fg-primary` (e.g. "PHX 86%")
- Trend arrow — `--green` for up, `--coral` for down (e.g. "▲ +34")
- Opening — Geist Mono 10.5px, `--fg-secondary` (e.g. "open 52%")

**Chart:**
- SVG `viewBox="0 0 600 80"`, `preserveAspectRatio="none"`
- 50% baseline: dashed line `rgba(255,255,255,0.05)`
- Quarter dividers at 25/50/75%: `rgba(255,255,255,0.04)`
- Area fill: linear gradient from `#34D399` 35% opacity → 0%
- Line: gradient stroke `#34D399` 0.6→1.0 opacity, 1.5px, rounded joins
- End dot: outer circle 4px at 25% opacity + inner 2px solid

**Data source:** `cs.espnWPHistory` array → map to SVG path points. Same logic as current `bdl.html` lines 9925-9985, but with the new color tokens.

---

### 6c. Value Read Section (Always Visible — Slot #1 after WP)

Immediately below the ESPN WP chart. This is the first analytical data the user sees — the betting action.

Full-width table showing both teams' betting value:

```
VALUE READ                               8:52P · Q3

         FWP      Edge       ML      Spread
GSW ►    75%     +61.5%    +600     +10.5
PHX      25%       —      -1100     -10.5

┌──────────────────────────────────────────────┐
│ [● Strong cover · 86%]    +17.5 · FWP 75%   │
└──────────────────────────────────────────────┘
```

**Table styling:**
- Geist Mono for all values, 14px, `font-feature-settings: "tnum"`
- Headers: Geist Sans 10px, 600wt, uppercase, `--fg-dim`
- Winner row: `--fg-primary` text, green edge + FWP values
- Loser row: `--fg-secondary` text
- Winner row gets left border or subtle background highlight

**Conviction bar** below table:
- Green-bordered rounded bar
- Left: pill with conviction + cover probability
- Right: Geist Mono detail text (cover amount, FWP, remaining time)

**Conditional display:** Only shows when analysis data exists. Pre-game or pre-analysis: show "Predictive layer activates Q2+" placeholder with analyze button.

**Data source:** `cs.prediction` or computed from `pred.fwp`, `pred.edge`, `pred.ml`, `pred.spread`. Uses `cs.oddsData` for live odds.

---

### 6d. Sonnet Signal (Always Visible — Slot #2)

Sits directly below the Value Read. Shows Sonnet's forward-looking assessment at a glance.

**Default (collapsed) state:**
```
┌──────────────────────────────────────────────────────┐
│ GSW closes 16-8 in final 18 min as PHX's 3PT        │
│ shooting regresses from 34%...                       │
│                              [⚠ RISK] [⊘ DISAGREE]  │
└──────────────────────────────────────────────────────┘
```

- The closing text summary (first 1-2 sentences, truncated ~120 chars with ellipsis)
- Styled as a quote block: left border 2px `--green`, subtle green background `rgba(52,211,153,0.04)`, rounded right corners
- Geist Sans 14px, line-height 1.5, `--fg-primary`
- **Indicator badges** in the bottom-right corner:
  - `⚠ RISK` — amber pill, only visible when `pred.risk` exists and isn't "NONE"
  - `⊘ DISAGREE` — coral pill, only visible when `pred.disagreement` exists and isn't "NONE"
  - If neither exists, no badges shown
  - These badges signal "there's more to read" — they're the cue to expand
- Tap anywhere on this block to expand
- Small chevron (▸) on the right edge, rotates to ▾ when expanded

**Expanded state:**
Shows full CLOSING → RISK → DISAGREEMENT as signal cards:

```
┌── CLOSING ──────────────────────────────────────┐
│ GSW closes on a 16-8 run in the final 18        │
│ minutes as PHX's three-point shooting regresses  │
│ from 34% back toward season baseline while       │
│ Warriors exploit interior advantage.             │
└──────────────────────────────────────────────────┘

┌── RISK ─────────────────────────────────────────┐
│ PHX's variance-driven lead could extend if       │
│ Green stays nuclear (6/10 from three), but       │
│ GSW structural dominance suggests sustainability │
│ concerns favor the Warriors.                     │
└──────────────────────────────────────────────────┘

┌── DISAGREEMENT ─────────────────────────────────┐
│ CONDITIONAL conviction understates GSW's         │
│ position — massive paint disparity creates a     │
│ more robust structural edge than single-          │
│ indicator conviction suggests.                    │
└──────────────────────────────────────────────────┘
```

**Card styling:**
- **CLOSING:** left border 2px `--green`, bg `rgba(52,211,153,0.04)`
- **RISK:** left border 2px `--amber`, bg `rgba(245,181,68,0.04)`
- **DISAGREEMENT:** left border 2px `--coral`, bg `rgba(248,113,113,0.04)`
- Each card: border-radius `0 10px 10px 0`, padding 12px 14px, margin-bottom 8px
- Label: Geist Sans 10px, 600wt, uppercase, tracking 0.14em, colored per card type
- Body text: Geist Sans 13.5px, line-height 1.55, `--fg-primary`
- DISAGREEMENT card hides entirely if value is null or "NONE"
- Expansion uses `grid-template-rows: 0fr → 1fr` transition

**Fallback states:**
- No analysis yet: show thesis text (from `theses[id]`) in the same quote-block styling, with "⚡ ANALYZE" button prominently placed inside the block. The analyze button is the primary CTA in this section until analysis exists.
- Pre-game: show editable textarea for thesis input with "Generate" button
- Analyzing: show spinner + "Sonnet analyzing..."
- Analysis exists: the ⚡ button moves to a small refresh icon (↻) in the section header row, allowing re-analysis without taking up space. Positioned right-aligned next to the RISK/DISAGREE badges.

**Analyze button lives HERE, not in the chrome.** The chrome ⚡ button is Upload Clutch (different function). The analyze action belongs in the Sonnet Signal section because that's where its output renders. This keeps the chrome clean (3 buttons: WP, Upload Clutch, ≡ menu) and puts the action next to its result.

**Data source:** `pred.closing`, `pred.risk`, `pred.disagreement` parsed from Sonnet analysis text. Falls back to `theses[id]` for pre-analysis state.

---

### 6e. Structural Read Section (Always Visible — Slot #3)

Below the Sonnet Signal. The structural evidence supporting the value read.

**Section header:**
```
STRUCTURAL READ                    [● Eroding]
```
- "STRUCTURAL READ" — Geist Sans 10.5px, 600wt, uppercase, tracking 0.14em, `--fg-secondary`
- Combined read pill on the right (DOMINANT/STRONG/ERODING/COLLAPSING/etc) — color-coded

Vertical stack of structural evidence. **Floor is the first thing displayed:**

#### Row 1: Floor (Primary — the foundation of everything)
```
PHX  0.80  ████████████████████░░░░    Strong
```
- Team tag: Geist Sans 11px, 500wt, uppercase, `--fg-tertiary`
- Floor number: Geist Mono 22px, 600wt, `--fg-primary`
- Meter bar: 4px height, green gradient fill at floor percentage
- Verdict label: Geist Mono 12px, colored by verdict (green/amber/coral)
- No "Foundation" badge — the floor speaks for itself

#### Row 2: Windows
```
┌─────────────┐ ┌─────────────┐
│ QTR · Q2-Q4  │ │ PBP · 79pos │
│ PHX 0.77 -3  │ │ PHX 0.65 -15│
└─────────────┘ └─────────────┘
```
- Two-column grid of window cells
- QTR window: cross-fade rolling average of per-quarter indicator scores
- PBP window: play-by-play possession-level computation
- Delta shown in red/green relative to cumulative floor

**Data source:** Quarter data from `cs.quarterData`, PBP from `cs.pbpAudit`

#### Row 3: Indicators
```
[I1 PHX] [I2 Even] [I3 PHX] [I4 PHX] [I5 Even]
```
- Horizontal strip of pill-like cells
- Winning team highlighted green, "Even" in tertiary
- Each cell: Geist Mono code (I1-I5) + Geist Sans team name

**Data source:** `ind.I1` through `ind.I5`, each has `.leader` and `.score`/`.rawScore`

#### Row 4: Sustainability
```
LEADING  PHX   [● Locked In]    ast% 59% · R:MIN S:MIX
TRAILING GSW   [● Locked In]    ast% 67% · R:MIN S:DUR
```
- Two rows (leading team, trailing team)
- Sustainability tier pill (color-coded)
- Detail: assist ratio, regression tier, shot type tier

**Data source:** `cs.sustainabilityAudit` (server-computed, saved to every snapshot)

---

### 6f. Collapsible Sections

Three collapsible panels below the structural read. Each has:
- **Header button:** section title + summary line + chevron
- **Body:** `grid-template-rows: 0fr → 1fr` transition (CSS-only, no JS height calc)
- Chevron rotates 90° when open

#### ▸ Scoring Composition
**Summary line:** `S:V 64/36 · Structural GSW +20 · Variance PHX +35`

**Body content:**
- Per-team scoring breakdown with stacked bar (paint/FT/3PT/mid segments)
- Legend with shot counts (e.g. "Paint 21/38", "FT 19/23", "3PT 11/33")
- Structural vs Variance delta bar
- Insight callout (left green border) — is the lead structural or variance-driven?

**Data source:** `cs.scoringComp` — `.home` and `.away` objects with `paint`, `ft`, `three`, `midOther`, `structural`, `variance`, `structuralPct`, `variancePct`

#### ▸ Depth Audit · Shot Zones
**Summary line:** `156 shots · GSW rim 58% vs PHX 67% · paint delta +14`

**Body content:**
- Per-team half-court SVG with zone bubbles (rim/mid/3PT zones)
- Each zone: made/attempted count + percentage
- Zone coloring: hot (green) / warm (amber) / cold (coral) / neutral (grey)
- Paint delta summary bar

**Data source:** `cs.pbpAudit` from `fetchPBP()` — zone-level shot data

#### ▸ Scoring Runs · Margin Flow
**Summary line:** `16 runs · Biggest: PHX 13-0 Q1 · PHX 11-0 Q3 · Final PHX +15`

**Layout:** Margin flow chart sits ABOVE the scoring runs list. Both are visible when the collapsible is open. They are cross-linked interactively.

**Margin Flow chart** (SVG): game-long margin trajectory — matches current bdl.html implementation closely.
  - X-axis: game time (0→2880 seconds)
  - Y-axis: margin (positive = home leading, negative = away leading)
  - Team labels on left edge outside plot area (top = home team color, bottom = away team color)
  - Zero-margin dashed baseline
  - Quarter dividers at 25/50/75%
  - **Run overlay bands** (rendered BEHIND the margin path): Each scoring run renders as a semi-transparent colored vertical band spanning the run's time range. Home team runs = home team color at ~10% opacity. Away team runs = away team color at ~10% opacity. These bands make momentum swings visible at a glance without tapping. When a run is selected (tapped), its band intensifies to ~20% opacity with dashed borders.
  - **Shot type markers on the margin path** (this is critical — preserve from current, layered ON TOP of run bands):
    - **2-pointers:** filled circles (●) — `r="3"`, team color fill
    - **Free throws:** small filled squares (■) — `4×4px rect`, team color fill
    - **3-pointers:** crosshair circles (⊕) — circle with cross lines through center, team color stroke
  - Margin path: `stroke: rgba(255,255,255,0.32)`, 1.5px, rounded joins
  - Highlight overlay (DIV positioned absolutely over SVG): green tinted band with dashed borders, transitions smoothly via CSS (`left` + `width` as percentages) — this is the SELECTED run highlight, distinct from the passive run bands
  - Status line above chart: "Tap a run to inspect →" (default) or "Showing: PHX 13-0 · Q1 9:30 → 5:45" (when run selected)
  - Final margin line below chart: "Final PHX +15"
  - **Rendering order (back to front):** quarter dividers → run overlay bands → zero baseline → margin path → shot markers → selection highlight

**Scoring Runs list** (below chart): Clickable rows sorted by run size
  - Each row: team color + score (e.g. "PHX 13-0") | mini stacked bar (paint/FT/3PT segments) | quarter label
  - **Cross-interaction (bidirectional):**
    - Tapping a run row highlights the corresponding time range on the margin flow chart AND marks the run row as selected (green border + subtle green bg)
    - Tapping the same row again deselects (clears highlight)
    - Tapping a different run replaces the previous selection
    - Tapping directly on a shot marker in the margin flow chart highlights the run that contains it
  - Mini stacked bar segments use same colors: paint=green, FT=green-soft, 3PT=amber

**Data source:** Play-by-play data from BDL/SR, processed into runs and margin trajectory. Currently computed in `buildPossessionLog()` and `buildScoringComp()`.

---

### 6g. Deep Dive Button

Full-width button at card bottom:
```
Deep Dive — narrative timeline, per-quarter, odds & more    [→]
```
- Geist Sans 13.5px, 500wt
- Arrow in green circle (32px, `--green-dim` bg, `--green-border`)
- Arrow shifts right 2px on hover
- Opens the drawer

---

## 7. Deep Dive Drawer

**Trigger:** Deep Dive button at bottom of card
**Behavior:** Slides up from bottom, covers 92% of viewport height
**Dismiss:** Tap scrim (dark overlay behind drawer), tap ✕, swipe down on handle, Escape key

### Structure
```
┌──── handle bar (40×4px) ────┐
│ DEEP DIVE                   │
│ GSW @ PHX · 96 — 111 Final  │  ← header with close button
├─────────────────────────────┤
│ scrollable body:            │
│                             │
│ § Game Narrative · N reads  │  ← timeline of Sonnet analyses
│ § Per-Quarter Breakdown     │  ← stat table (Paint/FTA/3PM/AST/TO/STL/BLK)
│ § Market · Odds             │  ← spread, ML, total with movement
│ § Game Log                  │  ← snapshot history table with alerts
│                             │
└─────────────────────────────┘
```

### § Game Narrative
Timeline of auto-analysis snapshots (from `get_auto_analyses` or `get_analyses`).

Each entry:
```
┌──────┬────────────────────────────┬───────────┐
│Q1 7:46│ 25-35  PHX 0.85            │ [● Strong]│
│       │ Dominant · I1+I3+I4+I5     │           │
└──────┴────────────────────────────┴───────────┘
```
- Time: Geist Mono 10.5px
- Score + floor: Geist Mono 13px
- Signal summary: Geist Sans 11px, `--fg-tertiary`
- Strong entries get green left border

**Data source:** `get_auto_analyses` from db-api (server auto-analyses at quarter transitions) + any manual analyses

### § Per-Quarter Breakdown
Table with rows per quarter (Q1-Q4+OT), columns per stat:
```
     Pnt   FTA   3PM   3PA   AST   TO   STL   BLK
Q1   8·16  5·4   5·1  18·9   8·6  5·9  6·4   2·0
Q2   4·10  5·6   2·2   6·4   1·4  4·2  1·1   1·0
...
```
- Format: `home·away` per cell, color-coded (green for advantage, coral for disadvantage)
- Geist Mono 12px, `font-feature-settings: "tnum"`

**Data source:** `cs.quarterData` (per-quarter stat diffs computed at quarter boundaries)

### § Market · Odds
Three-card grid:
```
┌──────────┐ ┌──────────┐ ┌──────────┐
│ SPREAD   │ │MONEYLINE │ │ TOTAL    │
│ PHX -17.5│ │PHX -99230│ │ 204.5    │
│ move -6.0│ │GSW +8530 │ │ O/U -6.0 │
└──────────┘ └──────────┘ └──────────┘
```
- Movement indicators: green for favorable, coral for unfavorable

**Data source:** `cs.oddsData` from BDL enrichment

### § Snapshot History Table

**Position:** Bottom of the drawer, below Signal Cards. Always visible (not collapsible) — it's the raw data log.

**Header:** "GAME LOG" with snapshot count badge

**Table columns:**

| Column | Width | Source | Format |
|--------|-------|--------|--------|
| Time | 60px | `period` + `clock` | `Q3 4:22` |
| Score | 50px | `home_pts` - `away_pts` | `96-111` |
| Margin | 40px | ctrl-relative | `+7` or `-3` (green/coral) |
| Floor | 55px | `floor_score` + `floor_team` | `PHX .80` |
| MF | 35px | running mean floor | `.74` |
| Peak | 35px | peak floor to date | `.85` |
| Erosion | 50px | peak-to-current delta | `-0.05` (colored by level: STABLE=green, CAUTION=amber, COLLAPSE=coral) |
| I1-I5 | 80px | `i1`-`i5` | mini 5-dot strip (green=ctrl wins, grey=even, coral=opp wins) |
| TP | 45px | `tp_class` | color-coded pill (`STRONG`=green, `PROBABLE`=green-soft, `CONTESTED`=amber, `UNLIKELY`=coral, `NO PATH`=coral) |
| LS | 45px | `ls_class` | color-coded pill (`SAFE`=green, `CUSHIONED`=green-soft, `AT RISK`=amber, `CRITICAL`=coral) |
| Sust | 50px | `lead_sust` / `lead_class` | tier pill |
| Alert | 120px | joined from `alerts` table | type badge + agent decision |
| Reason | expandable | `agent_reasoning` | truncated to ~40 chars, tap to expand full text in a tooltip or inline expansion |

**Alert column detail:**
- Shows ALL alerts for this game, including SUPPRESSED ones
- Badge format: `[SEND] BUY` (green badge) or `[SUPPRESS] BWC` (grey/dim badge) or `[DOWNGRADE] WINDOW` (amber badge)
- SUPPRESSED alerts shown with reduced opacity (0.5) but still visible — Manny wants to see what got killed and why
- If multiple alerts fired at the same snapshot time, stack them vertically in the cell

**Checkpoint graduation columns (computed client-side from snapshot history):**
- **MF (Mean Floor):** Running average of all floor readings for the control team up to that snapshot. Computed as: sum of all `floor_score` values where `floor_team` matches current ctrl team, divided by count. Shows the stability of the structural read over the game.
- **Peak:** Highest floor reading for the control team up to that snapshot. Source: scan all prior snapshots for max `floor_score` where `floor_team` matches.
- **Erosion:** `current_floor - peak_floor`. Colored by erosion level thresholds:
  - STABLE (delta ≥ 0 or within 40% of edge above 0.50): `--green`
  - CAUTION (delta crossed 40% erosion threshold): `--amber`
  - COLLAPSE (delta crossed 70% erosion threshold): `--coral`

**Additional checkpoint data (available from `live_tracking` JSONB on games table):**
- `ctrl_team_holds` — consecutive holds by current control team
- `bwc_fired` — when/if BWC was established (period, floor)
- `peak_floor` per side
- BWC state (`LOCK`/`EDGE`/`VALUE`/`EXIT`/`DEEP_TRAIL`)

**Note on graduation rank:** Full S/A/B rank classification requires tracking control flips across the game, which isn't currently in `live_tracking`. For v3, we can compute a simplified version client-side:
- Count control team changes across snapshots = flip count
- If flip count = 0 and floor qualifies for A → S rank (wire-to-wire)
- If graduated A with flips → A rank
- B rank = all others that pass MF ≥ 0.65 + minF ≥ 0.58
- Display as a small rank badge in the table header or as a running annotation

**Table styling:**
- Horizontal scroll on mobile (table wider than viewport)
- Geist Mono 11px for all values, `font-feature-settings: "tnum"`
- Headers: Geist Sans 9px, 600wt, uppercase, `--fg-dim`, sticky top
- Alternating row backgrounds: transparent / `rgba(255,255,255,0.02)`
- Current/latest row highlighted with subtle green left border
- Rows ordered chronologically (oldest at top, newest at bottom)

**Data source:** `get_latest_snapshots` from db-api (all snapshots for the game with `source='server'`), joined with `get_alerts` for the alert column. Mean floor, peak floor, and erosion computed client-side from the snapshot array.

---

## 8. Alert System

### Alert Bar (Top)
**Same behavior as current `abar`:**
- Fixed position bar (top of viewport, below chrome)
- Auto-dismiss after 5 seconds
- Edge glow: `box-shadow` on the alert bar, colored by alert type:
  - Entry/BUY signals: green glow
  - Warning/erosion: amber glow
  - Exit/danger: coral glow

### Toast (Bottom — Entry Signals Only)
Floating notification bar pinned to bottom of viewport. Auto-appears when an actionable entry signal fires (BUY, WINDOW BUY, BWC).

#### V1 (Ship First)
```
┌─────────────────────────────────────────────────┐
│ ●  ENTRY SIGNAL                                  │
│    GSW Strong · trailing 14 · PHX variance  [×]  │
│                                    [Open Bet365]  │
└─────────────────────────────────────────────────┘
```

**Styling:**
- Fixed bottom, 16px inset from edges, max-width 560px, centered
- `--bg-surface-2` background, `--green-border` border, 14px radius
- Green glow shadow: `0 0 24px -8px rgba(52,211,153,0.35)`
- Pulsing green dot (8px), "ENTRY SIGNAL" label in `--green`
- Body text: Geist Sans 13px, `--fg-primary`
- Close button (×): 28px circle, `--hairline` border
- **Bet365 button:** Small pill/link in bottom-right of toast. Tapping opens Bet365 app via deep link (`bet365://` URL scheme on iOS, falls back to `https://www.bet365.com` if app not installed)
- Slide-in animation from bottom: `translateY(20px) → 0` over 0.6s
- Auto-dismiss after 8 seconds (longer than alert bar since it has an action)
- Tapping the toast body (not close, not Bet365) scrolls to the relevant game card

**Trigger:** Entry signals from poll loop — BUY, WINDOW BUY, or BWC alerts that pass mechanical thresholds.

#### V2 (Future — Multi-Book Line Shopping)

**Persistent pill:** After the toast auto-dismisses, a small floating pill stays in the bottom-right corner:
```
[GSW +600 · tap to open]
```
- 36px height, `--bg-surface-2`, `--green-border`, rounded pill
- Geist Mono 11px, subtle green glow
- Tapping re-opens the full toast
- Disappears when the entry signal is no longer valid (game ends, signal expires, etc.)

**Expanded toast becomes a mini odds comparison grid:**
```
┌─────────────────────────────────────────────────┐
│ ●  ENTRY SIGNAL · GSW Strong                     │
│    Trailing 14 · PHX variance lead          [×]  │
│ ─────────────────────────────────────────────── │
│  Bet365      +600    ML     [Open]               │
│  DraftKings  +580    ML     [Open]               │
│  FanDuel     +620    ML     [Open]  ← best       │
│  BetMGM      +550    ML     [Open]               │
└─────────────────────────────────────────────────┘
```

- Each row shows: book name, odds, bet type, deep link button
- Best line highlighted with `--green` text and a "← best" label
- Data source: `cs.oddsData.oddsAll` from BDL enrichment (already returns odds from multiple vendors: DraftKings, FanDuel, BetMGM, Bet365, etc.)
- Deep links per book:
  - Bet365: `bet365://`
  - DraftKings: `draftkings://`
  - FanDuel: `fanduel://`
  - BetMGM: `betmgm://`
  - Each falls back to web URL if app not installed
- Rows sorted by best odds (highest ML for underdogs, lowest ML for favorites)
- Could later include spread + total tabs, not just ML

---

## 9. Confidence Table (On-Demand)

**Trigger:** ≡ menu → "Confidence Table" toggle
**Position:** Slides down between pills and game card area
**Dismiss:** Same toggle, or tap a "close" button on the table

Same data as current `renderConfidenceTable()` but styled with the v3 design tokens. Horizontal scroll for the table on mobile.

---

## 10. Swipe Navigation

### Implementation
- CSS `scroll-snap-type: x mandatory` on a horizontal container
- Each game card is `scroll-snap-align: center`, `min-width: 100%`
- `overflow-x: auto` with hidden scrollbar
- JavaScript `IntersectionObserver` or `scroll` event listener to detect which card is centered → update pill selection + page dots

### Page Dots
Below the card container:
```
        ● ○ ○ ○ ○
```
- One dot per selected game
- Active dot: `--green`, 8px
- Inactive dot: `--fg-dim`, 6px
- Centered, 8px gap

### Pill Sync
- Swiping to a card updates which pill appears selected
- Tapping a pill scrolls the card container to that card (`scrollIntoView` with `behavior: 'smooth'`)

---

## 11. Toolbar Controls Summary

### Kept (relocated)
| Control | Location | Function |
|---------|----------|----------|
| Filter/Search | Pill strip area | Filters game pills by team |
| WP Profiles | Chrome icon button | Opens WP overlay |
| Upload Clutch | Chrome icon button | Opens clutch file upload + L15/L10 selector |
| Demo | ≡ menu | Toggles demo mode + preset strip |
| QA | ≡ menu | Runs client-side QA checks |
| Confidence Table | ≡ menu | Toggles confidence table |
| Date Nav | Below chrome | Yesterday / Today / Upcoming tabs |

### Killed
| Control | Reason |
|---------|--------|
| LIVE / PAUSE | Never used |
| ↻ REFRESH | Never used |
| Poll frequency (30s/60s/90s) | Hardcode 90s, no UI |
| CLR THESIS | Never used |
| CLR MKT | Never used |
| 📊 CAL | Lives in debug.html |
| 🔔 ALERTS config | Server-driven via ntfy |

---

## 12. Data Flow — What Renders From Where

| UI Element | Data Source | Function/Path |
|------------|------------|---------------|
| Game list + scores | BDL box score via `loadSchedule()` | `buildBdlGameMap()` |
| Indicator scores (I1-I5) | `computeAny(game)` or `cs.sonnetIndicators` | Client compute or server hydration |
| Floor / control team | `ind.score`, `ind.controlTeam` | From indicators |
| Verdict (DOMINANT/STRONG/etc) | `getVerdict(ind.score)` | Threshold lookup |
| ESPN WP current | `cs.espnWP` | Hydrated from server snapshots |
| ESPN WP history | `cs.espnWPHistory` | From `get_latest_snapshots` or poll |
| Value read (FWP/edge/ML) | `cs.prediction` or computed | From Sonnet analysis parse |
| Odds (spread/ML/total) | `cs.oddsData` | BDL enrichment via `bdl-enrich.js` |
| Sustainability audit | `cs.sustainabilityAudit` | Server-computed, on snapshots |
| Scoring composition | `cs.scoringComp` | `buildScoringComp()` from box score |
| Shot zones | `cs.pbpAudit` | `fetchPBP()` → zone aggregation |
| Quarter breakdown | `cs.quarterData` | Server quarter_data JSONB |
| Margin flow | Play-by-play scoring events | `buildPossessionLog()` |
| Thesis | `theses[id]` | localStorage + DB |
| Auto-analyses | `get_auto_analyses` from DB | Server fires at quarter transitions |
| Signal cards (CLOSING/RISK/DISAGREE) | `pred.closing`, `pred.risk`, `pred.disagreement` | Parsed from Sonnet `raw_text` via regex |
| Confidence table | All games' cardState | `renderConfidenceTable()` |
| Alerts | `showAlert()` from poll loop | Client entry signal detection |
| Snapshot history table | `get_latest_snapshots` + `get_alerts` | All server snapshots + all alerts (including SUPPRESS) |
| Mean floor / peak / erosion | Computed from snapshot array | Client-side running calculations |
| Checkpoint graduation | `live_tracking` JSONB on games table | `ctrl_team_holds`, `bwc_fired`, `peak_floor`, BWC state |

---

## 13. Pre-Game Card State

When `state === 'PRE'`:
- Hero shows countdown timer instead of scores
- WP chart hidden
- Value read shows "Predictive layer activates Q2+"
- Sonnet signal shows editable textarea for thesis input (paste/generate thesis)
- Structural read hidden
- Collapsibles hidden
- Deep dive button hidden

---

## 14. Migration Notes

### JS Functions to Port (from bdl.html)
These functions contain the core logic and must be copied/adapted:

- `loadSchedule()`, `buildBdlGameMap()`, `getSlateDate()`, `switchDate()`
- `computeAny()`, `computeIndicatorsBDL()` (or equivalent)
- `getVerdict()`, `getState()`
- `renderPills()`, `updateCounts()`
- `renderConfidenceTable()` (on-demand)
- `showWPProfiles()`, `buildWPProfiles()`
- `fetchPBP()`, `buildPossessionLog()`
- `buildScoringComp()`, sustainability parsing
- `toggleDemo()`, `applyDemoPreset()`
- `runClientQA()`
- `handleClutchUpload()`, OCR flow
- `showAlert()`, `hideAlert()`
- `syncSeasonCacheFromDB()`, `mergeBdlSeasonPriors()`
- All polling logic (poll loop, snapshot hydration, auto-analysis hydration)
- `parseThesis()`, `parseSonnetScores()`, `crossRef()`
- `buildTrajectoryBDL()`, `buildPlayerBaselines()`
- `esc()` utility

### New JS to Write
- Swipe container with `scroll-snap` + `IntersectionObserver`
- Drawer open/close with scrim
- Collapsible sections (CSS `grid-template-rows` toggle)
- Margin flow SVG rendering (new visualization)
- `renderCard()` rewrite (the big one — all new HTML generation)
- Page dot sync
- ≡ menu dropdown

### CSS
- Complete rewrite using the v3 design tokens
- No carryover from bdl.html — clean sheet

### localStorage Keys
Same keys as bdl.html (`nba4:theses`, `nba4:clutch`, `nba4:odds`, `nba4:oddsHist`, `nba4:confTable`, `nba4:globalClutch`). Both dashboards can share cached data.

---

## 15. File Size Estimate

Current `bdl.html` = 12,307 lines. The v3 rewrite should be significantly smaller because:
- Clean CSS (no accumulated cruft)
- Single `renderCard()` function instead of scattered inline HTML
- Drawer content rendered on-demand, not always in DOM
- Shared localStorage means no data migration

Target: ~6,000-8,000 lines for v3.html (CSS + HTML + JS).

---

## 16. Implementation Plan

### Phase 1: Shell + Navigation
- Chrome, pills, date nav, swipe container
- Empty card shells that respond to game selection
- Alert bar

### Phase 2: Card Hero + Stats
- Score rendering, game state, countdown
- ESPN WP chart
- Stats grid (control + value)
- Thesis block

### Phase 3: Evidence Sections
- Value read table + conviction bar
- Structural read (floor, windows, indicators, sustainability)
- Three collapsible sections

### Phase 4: Drawer + Deep Dive
- Drawer slide-up with scrim
- Narrative timeline
- Per-quarter table
- Odds cards
- Full analysis

### Phase 5: Polish + Features
- Confidence table (on-demand)
- Demo mode + presets
- QA integration
- Upload clutch
- WP profiles overlay

Each phase should be deployable and testable independently.

---

## 17. Future Enhancements (Post-V1)

### Team Colors
Team abbreviations throughout the dashboard should render in each team's primary color (e.g. "PHX" in Suns orange, "GSW" in Warriors blue). Requires a 30-team color lookup table mapping team alias → primary hex color. Apply to: hero team abbrs, indicator pills, margin flow labels, sustainability rows, scoring comp headers, value read team names, toast signal text.

**Implementation:** CSS custom properties set dynamically per card (`--team-home-color`, `--team-away-color`), or a JS lookup object. WNBA expansion would extend the table.

### Multi-Book Toast (V2 Toast)
See Section 8 — Toast V2 for the full multi-book line shopping spec with persistent pill and odds comparison grid.

### Swipe Gestures on Drawer
Swipe down on the drawer handle to dismiss (currently only tap × or tap scrim). Requires touch event tracking with velocity threshold.

### Live Checkpoint Graduation
Add `flip_count` to `live_tracking` JSONB so the server tracks control team flips in real-time. This enables exact S/A/B rank classification matching the backtest spec, rendered as a rank badge in the game log table header and potentially in the structural read section.
