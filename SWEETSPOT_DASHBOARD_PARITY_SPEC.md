# SWEETSPOT_DASHBOARD_PARITY_SPEC — AMENDMENT 1 v3 (Aug 11 2026)

Supersedes v2 (archived at specs/superseded/). Base: parity mirror + HOLDER
READ shipped Aug 8 (c05b482). Evidence: checkpoint arena (576 games, 5,297
states, both-seasons rule) + 2026 live archive (211 games) + audit 372ae94.
NO CODE BEFORE PM GO. Scope: display + agent integrity only. Philosophy: the
card prints ONLY numbers that survived every sample — deficit bucket, time
phase, gap tier, leader country. Everything else is tagged context or absent.

## 1. STRUCTURAL NUMBERS MODULE
Constant block SS_STRUCT duplicated in wnba-bdl.html (client compose) and
poll-live-bdl.mjs (prompt copy) — Netlify bundles per-function, no shared
require — EQUALITY ENFORCED BY FIXTURE (byte-compare both JSON blocks; the
aliasMap lesson applied to numbers). Values pinned at build by re-running
research/2026-08-10_spec_cuts_regime.py; states file committed to
research/fixtures/spec_cut_states.json for permanent reproducibility.

SS_STRUCT = {
  deficit:  { d13:{p:60.8,n:232}, d46:{p:39.4,n:155}, d79:{p:32.0,n:97} },
  deficit26:{ d13:{p:65.4,n:104}, d46:{p:60.0,n:55},  d79:{p:42.9,n:35} },
  time:     { preQ4:{p:PIN,n:PIN}, q4e:{p:37.9,n:PIN}, q4l:{p:23.2,n:56} },
  gap:      { qual:{p:~44,n:PIN}, strong:{p:56.2,n:153} },
  leader:   { bad:{p:51.3,n:316}, mid:{p:44.0,n:134}, qual:{p:35.3,n:34} },
  holds:    { quality_lead:{p:75.0,n:136} },
  greenVeto:{ sub45:{p:42.2,n:45}, warm:{p:65.3,n:101} },
  riders26: { hotCell:{p:72.0,n:50}, killer:{p:67,n:45} }  // tag-mandatory
}
PIN = computed at build, frozen in fixture, never hand-typed.

COMPOSITION RULES (pre-registered, global):
R1 base = 2024-25 structural; live rider appended only when |2026-base|>10pp
   AND live n>=30 (currently: d46 only).
R2 every rate labeled trailer-WINS or lead-HOLDS. No bare "converts".
R3 riders26 render only with [this season] tag, only in fade country, never
   pooled with structural numbers.
R4 Q4 clock <5:00: numbers suppressed, suspension copy only.
R5 availability facts NEVER enter CELL READ or the gate line — they live
   exclusively in the AV chip / matchup AVAILABILITY block per
   AVAILABILITY_SPEC §0 (no gate authority, no percentages).

## 2. ITEM C — CLASSIFIER DEFINITIONS CONTRACT (SHIPS FIRST — agent integrity)
Narration prompt currently prints raw `(lead class ${row.lead_class})` with
no definition. Pinned block inserted VERBATIM into both narration templates
and backing the display translation:

  DEFINITIONS (fixed, do not reinterpret):
  - lead_class = WHAT THE MARGIN IS MADE OF. STRUCTURAL: paint+FT >= 60% of
    margin. VOLATILE: 3s+mid >= 60%. MIXED: neither. EVEN: margin <= 2 pts —
    too thin to classify (NOT "evenly composed").
  - fuel = LEADER'S REGRESSION CHANNELS. EARNED: no heat markers, no takeaway
    feed. TRANSIENT: heat and/or takeaway present.
  - trailer temp = absolute bands (cold <45 / warm 45-55 / hot >55), all
    quarters. DISPLAY ONLY — no validated predictive weight.
  - leader bands (green/orange/red) = period-adjusted transience detection
    (Q1 54/61 -> Q4 60/69). Green means "no heat markers", NOT "cold".
  Prose precedence: margin <= 2 -> thin-margin phrasing; else fuel leads,
  composition qualifies.

CONSUMER AUDIT TABLE (verify at build):
  SS narration prompt        poll-live-bdl.mjs  insert block; grep raw interpolations
  Review/WATCHLIST narration poll-live-bdl.mjs  same
  Push copy assembly         poll-live-bdl.mjs  vocabulary matches translation
  Trap kernel STRUCTURAL ref poll-live-bdl.mjs  read-only; verify semantics
  Verdict strip compose      wnba-bdl.html      audit + translate vocabulary
  Nightly digest copy        post-game-agent.mjs audit pinned fixtures
  EK chip / matchup sheet    wnba-bdl.html      audit only

DISPLAY TRANSLATION: VOLATILE->"variance-built" STRUCTURAL->"structurally
built" MIXED->"mixed" EVEN->"margin too thin to read" EARNED/TRANSIENT->
"earned"/"transient".

## 3. ITEM A — GATE LINE
One compact row per WNBA card, client-composed from already-fetched fields:
  GAP .19 [tier] · LDR .59 -> WATCH-ONLY · LEAD: earned · [temp chip color]
- Gap two-tier: qualified (.15-.35) / STRONG (.35+) / below = no-check.
- Country: FADE COUNTRY iff leader wp < .400, else WATCH-ONLY.
- Lead descriptor per §2 precedence. Temp chip color-only (§6).
- Pure function ssGateLine(state), fixture-covered.
- CARD LAYOUT CONTRACT (shared w/ AVAILABILITY_SPEC): gate line row ->
  CELL READ -> chips row (EK · AV · temp-color). Neither build reorders.

## 4. ITEM B — CELL READ v3
1-2 line plain-English expectation. Pure function ssCellRead(state) reading
only SS_STRUCT. Algorithm: country -> deficit bucket + time phase -> base
number (R1/R2) -> at most one rider (R3) -> R4 override. Pinned templates:
- Fade country in-band pre-Q4: "FADE SHAPE — real gap (.20) on a .18 leader.
  Down 4-6 like this, trailers WIN ~39% historically [n=155] — running ~60%
  this season [n=55]. Hot leader adds [this season: ~72%]."
- Watch-only (MIN@DAL shape): "WATCH-ONLY — real gap (.19) but the leader is
  quality (.59). The weakest qualified shape: trailers WIN ~35% [n=34,
  stable both seasons]. Price decides."
- Thin margin: "Margin too thin to read the lead. Gap qualified (.22); down
  1-3, trailers WIN ~61% [n=232]."
- Q4-late: "Inside 5:00 — comeback numbers suspended. Holding side: quality
  leads HOLD ~75%."

## 5. ITEM D — TAP-TO-LEGEND
Tap any band chip -> overlay: that quarter's leader thresholds + absolute
temp bands + one-line semantics ("green = no heat markers, not cold").
Static content, no fetch.

## 6. ITEM F — TEMP DEMOTION + COLOR FIX
Trailer-cold renders BLUE (kills green collision). Temp chip color-only —
no numeric copy anywhere (flat at power: 48.6/46.9/50.0). Audit: green
renders solely where it means leader-calm. STICKY chip retained display-only,
no directive copy (lane ruled out 2026-08-10).

## 7. ITEM E — SEASON eFG REFERENCE
"58.3 (szn 51.2)" beside live eFG, both teams, from team_profiles already
fetched by matchup sheet. Display-only (PM delta lens). NOT a gate change;
delta-cross timing question lives in companion queue.

## 8. FIXTURES & TEST PLAN
New: ssGateLine compose (>=8 cases incl strong-gap, sub-.400, thin-margin);
ssCellRead (>=10 incl rider trigger at exactly 10pp, R4 suppression);
definitions-pin (both prompts contain §2 block verbatim); SS_STRUCT
client/server equality; translation renders; blue swatch; legend content.
Existing suites stay green: verdict strip 41, digest pins, killer 51.
Manual QA: one live game, one closed, one pregame card, phone-width.
node -c / script-extract per file before every commit.

## 9. ROLLOUT & COMPANION QUEUE
Order: C (server, isolated) -> A+B (client + SS_STRUCT) -> D/E/F (display).
Three staged commits, fixtures green each stage, deploy-verify between.
COMPANION QUEUE (separate specs, priority): (1) AVAILABILITY_SPEC —
RESOLVED 2026-08-11: all four gate hypotheses FAILED pre-registered bars;
ships display-only facts w/ NO GATE AUTHORITY as its own ladder. Its §5a
nightly minutes capture is TIME-SENSITIVE (every uncaptured night is lost
forward sample) and may ship ahead of this spec's stages. Recency-drift
(trailing-10 wp) machinery from that study feeds queue item (4). (2) Killer historical
replication (promotion bar pending). (3) Delta-cross vs absolute-cross
timing. (4) Gap-reliability-by-GP. (5) JUICE quality-conditioned thresholds.
(6) Regime-pulse robustness (downgraded).
RISKS: prompt-text under-rigor (grep + verbatim pin) · number drift
(equality fixture) · card height (CELL READ <=2 lines, tap-expand) ·
get_ss_state untouched · zero polling-path SELECT changes.

-----

## AMENDMENT 2 — SEASON26 TAP PANEL (PM-approved Aug 13; raw-render variant)

**§1 Interaction.** The CELL READ line in the verdict box becomes tappable (caret affordance). Tap → compact SEASON CONTEXT panel expands beneath it; tap again → collapses. Collapsed by default; open-state is per-game in-memory only (`_ssSeasonOpen`, survives the 60s re-render, not persisted). The row matching the current cell (deficit bucket / time phase / gap tier / leader stratum / eFG band) renders highlighted. When ssCellRead returns null (below-bar gap / out-of-band) there is no line and no panel — the gate line owns those states.

**§2 Data contract.** Client-only generated block `SS_SEASON26` in wnba-bdl.html between `SS_SEASON26_BEGIN/END` markers — deficit/time/gap/leader/holds/greenVeto cells + `asof` + qualifying-game count. GENERATED, never hand-edit: `research/build_ss_season26.mjs` computes every cell from the committed `fixtures_fine26_states.json.gz` using the build_ss_struct population recipes verbatim and value-verifies the HTML block (exit 1 on mismatch — joins the pre-push gate). `SS_STRUCT` untouched; server and narration never read `SS_SEASON26` (no pooling by construction). Static-pinned v1 with printed as-of date; refresh = rerun extraction + builder + commit. Nightly auto-refresh is a v2 decision, out of scope.

**§3 Composition rules.** Inherits R2 (every rate labeled trailer-WINS or lead-HOLDS), R3 (panel header carries the [2026] this-season tag; nothing pools into CELL READ or narration), R4 (Q4 inside 5:00 → suspension copy only, conservative degrade on unknown clock, mirroring ssCellRead), R5 (no availability facts). **RAW RENDER (PM decision): no minimum-n floor — every cell prints its rate, n, and power tag (HIGH ≥200 / MED ≥80 / LOW <80), including sub-n=20 cells.** Empty cells print "no 2026 sample".

**§4 Implementation.** Pure renderer `ssSeasonPanel(st)` + `ssToggleSeason(id)` + `_ssSeasonOpen` global (var, per TDZ learning) in wnba-bdl.html; wired at the renderSSVerdictBox cell-read site. Zero server changes, zero schema changes, zero polling-path reads. Fixtures: `research/ss_season26_fixtures.mjs` (R4 suppression, raw low-n render, empty-cell copy, highlight selection, header tag, WIN/HOLD labels) + builder value-verify. SS_STRUCT byte-equality and ss_parity 30/30 must remain green.

**§5 Continuum rev (PM-approved via rendered mock, Aug 13).** Each feature row renders a horizontal track — band segments (gray = pass/veto territory, warm tint = the R3 hot cell) with labeled boundary ticks — and an amber dot at this game's live value; the current segment's season rate renders amber. Scales: DEFICIT domain [0.5, 9.5] ticks 3|4, 6|7 · GAP [0, .60] ticks .15/.35 with sub-.15 gray "below bar" · LEADER wp [.15, .75] ticks .400/.550 · LDR eFG [30, 75] ticks 45/55 · TIME segments 70/15/15 (readability over strict proportion; ticks at Q4 and 5:00 are honest) with a piecewise elapsed-time dot. Out-of-domain values pin the dot to the track edge while the label prints the raw number; tied games label "tied" with no bucket highlight; missing values drop the dot, never the track; HOLDS stays a plain line (single cell). **DEFICIT live sourcing:** the deficit row reads `st.liveMargin` — `g.homePoints/awayPoints`, the same 10s ESPN score the card header uses — with the scoringComp margin as fallback. Mechanism note: renderCard already re-renders every card on the 10s tick; the panel's prior lag was the scoringComp margin only recomputing on BDL play-count change (~90s pbp cadence). Sourcing the header score at the data layer closes it with zero nudge machinery; gate line and CELL READ deliberately keep scoringComp/server semantics (Item B untouched). Fixtures: 29/29 incl. dot geometry pins, clamps, tied/missing/out-of-band states, liveMargin precedence, R4 unchanged.

**§6 Errata (Aug 13, PM-caught, same night).** Two integration-level defects in §1/§5 as shipped, both invisible to the pure-renderer fixtures by construction: (a) **tap collision** — the verdict box's own onclick opens the matchup sheet (TEAM_CTX P1), and the caret handler did not stop propagation, so a caret tap toggled the panel AND opened the sheet over it; fixed with `event.stopPropagation()` on the caret line and on the panel container (taps inside the open panel are inert). Tap zones after fix: caret/cell-read line → panel toggle only; anywhere else in the verdict box → matchup sheet, unchanged. (b) **finals leak** — the gate-line block renders from the last snapshot + retained cardState, which FINAL games keep, so yesterday's cards grew carets; the panel is now gated to `getState(g)==='LIVE'` and finals render the plain pre-§5 cell read. Rationale: the panel is a live decision aid; post-game review context belongs to the row's fire-time stamps, and a final-score dot on season conversion tracks reads as decision support for a decided game. A finals review mode (dots at fire-time state from the row stamps) is a possible future amendment, not shipped.

**§7 Fire-time review mode (PM-approved Aug 13).** FINAL games with at least one fired SS row render the season panel in **FIRE-TIME REVIEW**: an amber header line (`FIRE-TIME REVIEW — <subtype> fired Q<p> <clock>`) above the tracks, with every dot positioned at the row's fire stamps (deficit, quality_gap, leader_wp, leader_efg, period/clock) rather than final-game state. Data: **fifth isolated query** in get_ss_state (`fire_review`, DS v1.1 B pattern, house rule preserved) — highest-priority fired row (EFG_FADE > SOFT > B* > WATCHLIST > GAP_BASE > other; GAME_BRIEF excluded; earliest row of the top subtype = the fire moment), NULL-degrading. GAP_BASE rows qualify deliberately: every qualifying spot is a review target per the nightly ritual. R4 applies to the fire state itself — a row fired inside 5:00 renders the suspension copy, which is the honest statement of what the numbers were at fire time. The TIME dot domain now includes Q1 (fires can land there — row 1400). **No fired row → no caret, plain cell read (recommendation adopted):** no decision point means nothing to review; a caret opening "nothing here" is UI noise, and the review surface for fire-less games is the brief + digest. Live games are unchanged (§5/§6 semantics).

**§8 Pre-gate SEASON CONTEXT line (PM-approved Aug 13).** Before the engine's first SS read (gates open Q2), the verdict box renders a minimal tappable `SEASON CONTEXT ▸` line for LIVE games, opening the same continuum panel with what is honestly computable client-side: margin from the live header score (`g.homePoints/awayPoints`), gap and leader wp from `_teamProfiles` (the identical source the gate line's LDR segment reads), period/clock live; leader eFG omitted until the live compute exists (dotless track — the panel's missing-value contract). Panel header carries an "engine gates not yet open — season context only" note. Tied game: no leader to read — margin/time dots only, noted in the header. Mutual exclusion by construction: the line renders only when the gate-line block does not (`_glRendered` flag), so element ids never collide and the surface hands off to the full cell-read caret the moment the first server read lands. NULL-degrading throughout; profiles absent → line still renders with margin/time dots only.

**§9 Persistent single entry point + theme (PM-approved Aug 13; supersedes the §1 caret, the §7 no-fire silence, and the §8 pre-gate duality).** One `SEASON CONTEXT ▸` line renders in the same verdict-box slot in EVERY game state, and it is the one and only opener for the SEASON26 panel — the cell-read line is plain text again. Dot overlay by state: LIVE with gates open → the gate line's own `_glSt` (server-stamped gap/LDR, fuel-compute eFG, live-score margin); LIVE pre-gate → client state with the **§9 eFG bug fix** — leader eFG now computed via the SAME `_ftClientStats` + `computeFuelTemp` path the gate line uses (it was omitted pre-gate while the fuel block proved it computable — ATL@CON Aug 13); FINAL with a fired row → FIRE-TIME REVIEW (green header, fire stamps); FINAL without a fire → reference-only panel, no dots, "no qualifying spot fired" note ("always render" supersedes the §7 silence recommendation); PRE → reference-only, "pregame" note. Time-bucket highlight guarded against unknown period (empty-state fixture caught Q4-late leaking onto reference panels). **Theme:** amber → `var(--green)` on the dot, current-segment rates, row-title values, and the FIRE-TIME REVIEW header; navy track segments → greys (#3a4149 live / #22262c dead) with the R3 hot cell a green-grey tint (#2f3d36). `_glRendered` duality removed (dead code cleaned). Fixtures 35/35 incl. theme pins and the empty-state pin.
