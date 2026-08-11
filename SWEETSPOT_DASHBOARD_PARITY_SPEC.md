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
COMPANION QUEUE (separate specs, priority): (1) PREFIRE_LINEUP_SPEC — the
staleness program, two losses of evidence, TOP. (2) Killer historical
replication (promotion bar pending). (3) Delta-cross vs absolute-cross
timing. (4) Gap-reliability-by-GP. (5) JUICE quality-conditioned thresholds.
(6) Regime-pulse robustness (downgraded).
RISKS: prompt-text under-rigor (grep + verbatim pin) · number drift
(equality fixture) · card height (CELL READ <=2 lines, tap-expand) ·
get_ss_state untouched · zero polling-path SELECT changes.
