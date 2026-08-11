# Deepfuckingthesis — Project Knowledge

**Version:** 5.3
**Last updated:** August 11, 2026
**Live URL:** https://poetic-starlight-aa8938.netlify.app
**GitHub:** MannyBanda/Deepfuckingthesis (private)

*(v5.3 integrates everything shipped and learned since v5.2: JUICE/squeeze watch, the ACA one-copy-source architecture, the FUEL×TEMP×GAP and takeaway-decay research, dashboard parity, the checkpoint-arena spec cuts, the retraction ledger, updated record/ledger state, and a formal section on how research findings get presented. NBA indicator/state-machine sections are unchanged and stable — that system is off-season.)*

**How we got here (Jul 17 → Aug 11):** v5.2 closed with the Sweet Spot engine live and the flagged stream 6-0. Since then: JUICE (live price stalking) shipped v1.2 → v1.3; Decision Support v1 was approved; the LA@MIN row-1197 loss triggered a full post-mortem that produced the **ACA architecture — one copy source, three surfaces** — shipped in phases P0→P3; dashboard parity closed the last surface gap. Then a research week that mattered more than any of it: the checkpoint arena (576 games, both-seasons rule) killed three candidate layers, validated the 9-point band, found the **deficit cliff at 3-4**, and forced two public retractions of my own prior claims. Real money: flagged stream **14-3 by position, +$8,566**.

-----

## WHAT THIS IS

A multi-league live betting intelligence platform combining real-time game data (BallDontLie, ESPN, Sportradar), server-side polling with autonomous alert generation, Claude-powered structural narration, and agentic reasoning layers to identify structural betting edges.

Two analytical frameworks run:

1. **NBA indicator/state-machine stack** (I1–I5, conviction engine, XGB/MC, BWC/graduation) — mature, validated on 1,235+ games, off-season.
2. **WNBA Sweet Spot engine** — the live edge, real money on. Core thesis: identify moments where a structurally better team trails a weaker leader whose lead is built on unsustainable variance, then buy the trailer at plus-money odds.

**The server is the primary analytical engine.** The dashboard exists for deep inspection; the system is designed for dashboard-free monitoring via ntfy push (topic `manny_nba_control`). Alert bodies must be plain English: lead with action, explain the structural edge, translate jargon, name what to watch. Manny is the sole alert recipient and runs DFT from his phone.

-----

## ARCHITECTURE

```
Client:
  bdl.html (~12,340)          — NBA client dashboard (MUST always be named exactly this)
  v3.html (~3,983)            — V3 NBA dashboard
  wnba-bdl.html (~5,247)      — WNBA dashboard (verdict strip, EK chip, matchup sheet,
                                fuel block w/ mirrored ssCautionLines)
  ncaamb-bdl.html (~9,846)    — NCAAMB dashboard
  debug.html (~3,295)         — Diagnostic dashboard (7 sections)

Server (netlify/functions/):
  poll-live-bdl.mjs (~11,010)      — Polling, mechanical alerts, XGB, MC, narration,
                                     alert reasoning agent, Sweet Spot engine, fuel/temp,
                                     caution kernels, regime tripwire, pregame briefs
  db-api.js (~3,253)               — Database API (Neon Postgres)
  odds-squeeze.mjs (~704)          — JUICE: live price stalking on pushed SS rows (v1.3)
  team-profiles-nightly.mjs (~542) — Nightly team profiles: splits, elite tiers, killer fields
  post-game-agent.mjs (~1,261)     — Nightly learning agent + SS resolver sweep + digest
                                     (cron 11:45pm MST)
  mc-backtest.mjs (~5,647)         — Monte Carlo backtest harness (12+ phases)
  backtest-wnba.mjs                — WNBA backtest harness; read-only export_states and
                                     export_checkpoints phases feed the checkpoint arena
  backtest-nba-snapshots.mjs (~8,891)
  analyze.js (~1,047) / pregame-agent.mjs (~1,323, NBA-hardcoded)
  sr-data.js / bdl-data.js / bdl-enrich.js / bdl-pbp-adapter.js / espn-data.js / odds-api.js
  generate-thesis.mjs (NBA only) / clutch-ocr.js / xgb-replay.js / test harnesses

Models:
  xgb-model.json            — NBA windowed XGB
  xgb-model-wnba.json       — WNBA windowed biglead XGB (13 features)

Config & research:
  netlify.toml
  research/                 — dated findings (*.md), scripts (*.py/*.mjs), fixture harnesses
  *_SPEC.md at repo root    — active specs; superseded versions move to specs/superseded/
```

*(Line counts drift — the startup protocol's `wc -l` is ground truth, not this table.)*

**Active specs at root:** `SWEETSPOT_ENGINE_SPEC`, `SWEETSPOT_4C_SPEC`, `SWEETSPOT_TIER_BC_SPEC`, `SWEETSPOT_NARRATION_V2_SPEC`, `SWEETSPOT_VERDICT_STRIP_SPEC`, `SWEETSPOT_DASHBOARD_PARITY_SPEC` (Amendment 1 v3 — pending PM go), `ALERT_CONTEXT_ALIGNMENT_SPEC`, `SQUEEZE_WATCH_SPEC` (v1.3), `DECISION_SUPPORT_V1_SPEC`, `KILLER_FLAG_SPEC`, `OVERRIDE_LANE_SPEC`, `TEAM_PROFILES_SPEC`, `TEAM_CTX_SURFACING_SPEC`, `WNBA_PREGAME_AGENT_SPEC`.

### Multi-League Architecture

**Single app, league-parameterized.** One set of Netlify functions, league as a parameter — NOT separate deployments. The `LEAGUE` config object in poll-live-bdl.mjs holds per-league SR base URLs, BDL prefixes, period types, game rules, feature flags, thresholds.

**Priority:** WNBA (in season, real money) → NBA (mature, off-season) → NCAAMB (March sprint).

### CI/CD Pipeline

1. Clone repo to `/home/claude/dft`; `git config user.name/email`
2. Verify actual state (`wc -l`, `git log --oneline`, targeted greps) — never assume the prior session's changes deployed
3. Search recent chats for continuity
4. Read relevant source before touching anything
5. Edit → `node -c` syntax check (HTML: extract script block first) → fixture harnesses green
6. Multi-file sessions stage together in one descriptive commit
7. Push via PAT → Netlify auto-deploys (~50s) → verify by hitting endpoints

### Infrastructure

- **Netlify Pro** (not free — never hedge about this). Basic Auth via `_headers` (scope to `/*.html` only; `/*` blocks cron functions). Internal Netlify-to-Netlify calls 401 → call the Anthropic API directly from the poll function.
- **Neon Postgres** via Netlify DB. Migrations use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`; run `?action=init` after adding columns.
- **GitHub auto-deploys** on push to main.

-----

## ENVIRONMENT & ACCESS

### API Keys

|Service  |Key                                       |Env Var            |Notes                      |
|---------|------------------------------------------|-------------------|---------------------------|
|BDL      |`ee78e074-2f89-4ee5-807a-181fc324398c`    |`BDL_API_KEY`      |GOAT tier, all leagues     |
|SR NBA   |`HE9cr9RYzuQnPmD7PO8ueCuirC65QyyCv9jYH2cU`|`SR_API_KEY`       |trial/v8, 1 req/sec        |
|SR NCAAMB|`OZ1P5Dnx0WjWHGy6yNFlMIT8rqQVQILftOR9xOpO`|`SR_NCAAMB_KEY`    |trial/v8                   |
|SR WNBA  |`foQyHxS5MPKxDAcroxAEKaEb8OTquSOI79RE8UML`|`SR_WNBA_KEY`      |replaced May 10            |
|Anthropic|—                                         |`ANTHROPIC_API_KEY`|narration + agents         |

Other env vars: `DATABASE_URL`, `NTFY_TOPIC` (manny_nba_control), `ODDS_API_KEY` (The Odds API, 20K credits/month).

**Feature flags (live inventory):** `WNBA_SS_ALERT_ON` (A-tier), `WNBA_SS_B_ON`, `WNBA_SS_WATCHLIST_ON`, `WNBA_SS_LEDGER_ON`, `WNBA_SS_NARRATE_WATCHLIST`, `WNBA_SS_NARRATE_V2`, `WNBA_SS_COMPUTE_OFF` (kill switch), `WNBA_SQUEEZE_ON`, `WNBA_SQUEEZE_AUTOARM`, `SQUEEZE_STATE`, `WNBA_GAME_BRIEF_ON`, `WNBA_LEGACY_ALERTS_OFF`, `TEAM_CTX_ON`, `XGB_GATES_ENABLED`.

### GitHub PAT

`github_pat_11AEAFZZA08p…` — **REDACTED in this repo copy** (GitHub secret-scanning push protection rejects commits containing a live token). The full token lives only in the project-settings copy of this doc, which is the copy Claude reads at session start. Fine-grained, Contents read/write, scoped to Deepfuckingthesis, **issued Aug 11, 2026** (replaced the Aug 8 token, which replaced Aug 6, which replaced Jul 2).

**Rotation drill:** `git remote set-url origin https://x-access-token:<PAT>@github.com/MannyBanda/Deepfuckingthesis.git` → `git fetch -q origin` to confirm before any work. Git config: user MannyBanda. Clone to `/home/claude/dft`, `pull --rebase` before push.

### Claude Sandbox Network Access

`poetic-starlight-aa8938.netlify.app` and the Neon pooler host are allowlisted. All db-api endpoints reachable by curl; Basic Auth `manny:DFT2025!`. Direct TCP to Neon (5432) is blocked — HTTP only via db-api. When curl returns "DNS cache overflow," switch to `python3 urllib.request` and save to `/tmp/*.json` before parsing.

### Database Tables

**`sweetspot_alerts`** — the engine's row store. Per row: alert_subtype (EFG_FADE / EFG_FADE_SOFT / B tiers / WATCHLIST / GAP_BASE / Q4_COLLAPSE / GAME_BRIEF), alert_tier, period/clock, leader/trailer aliases + wp, quality_gap, leader_efg + band, variance_share, lead_class, fade/collapse tiers, deficit/margin, line_used/consensus/implied/edge, kelly_size, narration_text + attempts, ntfy_sent, §4c carrier_* + player_ctx_json, resolver fields (resolved, trailer_won, finals, resolved_at), killer fields (leader_killer, leader_scalps), **fuel/temp stamp**, **squeeze_\*** (armed, threshold, last_alert_price, alert_count, expires_at, state), **trailer_lane**, game_date, away_alias, home_alias.

**`bets`** — Manny's bet log (37 rows as of Aug 11). Matchup, side, odds, stake, result, pnl, grade, system_state, entry_period, entry_deficit, notes. Book: bet365 default, Caesars frequently. *Housekeeping:* result vocabulary is inconsistent across eras (`WIN`/`W`, `LOST`/`LOSS`/`L`, plus `CASHOUT`, `PASS`) — normalize before any aggregate query, or counts will be wrong.

**`team_profiles`** — nightly per-team season profile JSONB (PK team_alias/league/season): splits, archetypes, schedule inflation, consumer `elite`/`killer`/`tiers_elite`, internal-only def-A tiers. Written solely by team-profiles-nightly. **`team_game_stats`** — per-game team lines feeding profiles. **`job_locks`** — nightly dedup.

**`snapshots`** — raw_stats_json (BDL), **espn_raw_stats_json** (ESPN, dual-persisted), tp/ls, sust_json, xgb_win_prob, xgb_divergence, mc_win_prob, mc_cum_win_prob, `ss_*` gate columns (read by verdict strip).

**`alerts`** — i1-i5, conviction_tier/combo, alert_tier, agent_decision/reasoning, ntfy_sent, bwc_state, erosion_level, peak_floor, exit_severity, graduation_rank, mf_trajectory, combined_read, cp_* fields, lane, position_closed, is_flip_buy, position_team, xgb_win_prob, xgb_aligned.

**`games`** — live_tracking JSONB (BWC state machine, checkpoints, MC state, buy_position, `_wnbaV2` structural overlay).

**Others:** game_checkpoints (PK game_id+label, atomic INSERT ON CONFLICT DO NOTHING), clutch_profiles, odds_history, theses, analyses, wp_profiles, poll_state, poll_heartbeats, season_cache, game_context (server-only writer, DO UPDATE), game_pbp, learnings, nba_snapshot_backtest (16,910 rows).

**Dead columns:** prev_home/away_tp/ls/opp_sust, lead_degraded_at, monitor_* on alerts/poll_state.

-----

## DATA SOURCES

### BallDontLie (primary)

- **Base:** `https://api.balldontlie.io`; NBA full coverage; NCAAMB/WNBA basic stats + plays only.
- `game.period = 0` during live games — extract period from `game.time` (`"Q4 8:03"` → 4).
- **BDL returns `null` for zero** — always `Number(x)||0`. All BDL stats are strings — wrap math in `Number()`.

### ESPN

Scoreboard + win probability polled server-side. ESPN is the WNBA schedule fallback when SR has no preseason data, drives 10s live score refresh on the dashboard, and its box parse is **dual-persisted** to `espn_raw_stats_json` alongside BDL's `raw_stats_json`.

### Sportradar (supplemental)

Schedule, injuries, depth charts, seasonal splits, standings, pre-game context; per-period team stats under `home.statistics.periods[]` (paint, POT, SCP, FBP, biggest_lead, possessions). Trial tier — 1 req/sec, separate keys per league. Cached SR summaries feed the `export_states` backtest phase with zero live API cost.

### Anthropic models

- **`claude-fable-5`** — primary Sweet Spot narration, high effort (`output_config: {effort:'high'}`). **Text-block filtering required** — Fable prepends a thinking block; filter to text blocks before parsing.
- **`claude-opus-4-8`** — fallback narration + alert reasoning agent, auto-analysis, nightly learning, OCR, theses.
- Legacy `claude-sonnet-4-*` references remain in older paths.

-----

## WNBA SWEET SPOT ENGINE (live — the primary edge)

### The Locked Trailing-Buy Signal (now six-way confirmed)

**Quality-gap comeback edge:** a BETTER team trailing a BEATABLE leader at a CATCHABLE deficit.

- WNBA live 2026 (n=95): +19.5pp edge
- NBA deficit-controlled (1,235 games): 22% → 38% → 58% monotonic
- WNBA historical 2024–25 (524 games OOS): 16.5% → 33% → 48%
- Checkpoint arena (576 games, 2,724 states): gap staircase invariant in **both** seasons independently

**Operative signal = quality gap (trailer win% − leader win%) + deficit + time + live line.**

**The "whose variance is it?" check:** the variance-share delta must favor the LEADER. If the trailer is the variance team, the fade inverts — pass (POR@CHI Jun 24, the teaching case).

### Structural shape of the edge (checkpoint arena, both-seasons validated)

These four axes survived every sample and are the only ones allowed to carry numbers on consumer surfaces:

- **Deficit cliff at 3-4:** gap ≥.15 trailer conversion — **1-3 = 60.8% (n=232) | 4-6 = 39.4% (n=155) | 7-9 = 32.0% (n=97)** | 10-12 = 25.0% | 13-15 = 14.5%. A 21pp cliff between 1-3 and 4-6, same direction both seasons. The 1-9 band contains two different populations.
- **The 9-point band edge is VALIDATED, not conservative** (7-9 vs 10-12 = 7pp > the 5pp bar). Band widening is dead.
- **Continuous time decay, no Q4 cliff:** Q2e 61.0 → Q2l 54.3 → Q3e 53.3 → Q3l 44.9 → Q4e 37.9 → Q4l 23.2 (n=56). Monotone both seasons. Q4-early is comparable to a pre-Q4 deficit-4-6 state — not death. Death zone is Q4-late.
- **Gap saturates with a top tier:** <.05 = 22.7% | .05-.15 = 43.8 | .15-.25 = 43.7 | .25-.35 = 45.5 | **.35+ = 56.2% (n=153, stable 55.9/56.7)**. The edge is a STEP, not a curve — it turns on by ~.15 then flattens to .35. A .30 gap is not better than a .16 gap. Two-tier grading, not a gradient. Gate-lowering to .05 is NOT supported (season-inconsistent).
- **Leader strata:** <.400 = 51.3% (n=316) | .400-.550 = 44.0% | ≥.550 = 35.3%. Ordering consistent, but no adjacent pair clears 10pp in both seasons → **no new alert countries**; ordering informs copy, not tiering.

### Tier System & Ledger

- **A-tier (EFG_FADE):** full dual-gate sweet spot. Live since Jul 2.
- **B-tier (B1/B2/B3):** relaxed variants. Live since Jul 12.
- **WATCHLIST:** qualifying quality-gap spots below the alert bar, surfaced for discretionary review (D-12 review narration, 2h claim window).
- **Ledger streams (log-only, no push):** GAP_BASE (every in-band quality-gap spot — the forward OOS sample) and Q4_COLLAPSE.
- **GAME_BRIEF:** pregame skeletons seeded every cycle for not-yet-tipped slate games (idempotent, self-healing); period-0 briefs narrate a pregame-honest season lens with no push.

**Ledger state (Aug 11):**

|Stream        |n  |resolved|realized|predicted|delta |status          |
|--------------|---|--------|--------|---------|------|----------------|
|EFG_FADE      |5  |5       |100%    |68.6%    |+31.4 |—               |
|EFG_FADE_SOFT |1  |1       |100%    |71.1%    |+28.9 |—               |
|GAP_BASE      |15 |15      |80%     |70.8%    |+9.2  |PENDING (15/30) |
|WATCHLIST     |30 |30      |70%     |64.9%    |+5.1  |—               |
|GAME_BRIEF    |69 |65      |40%     |—        |—     |context only    |

**Regime:** TRANSIENT_COLLAPSE ACTIVE.

### JUICE — Squeeze Watch (odds-squeeze.mjs, v1.3)

Stalks the trailer's live price on every pushed SS row and pushes a plain-English alert when the best book crosses a cell-aware threshold. **Alerts are eyes, never directives.**

- Auto-arms on SS push (`WNBA_SQUEEZE_AUTOARM`); polls 6 books — Caesars (default/tiebreak), ESPN Bet, FanDuel, BetRivers, Hard Rock, DraftKings.
- **v1.3 band grace:** band-exit is no longer terminal — the watch SUSPENDS (ESPN-only), RESUMES on band re-entry. Price is evaluated *before* the out-of-band counter increments. Both fixes came from the TOR@GS incident where the first live A-tier arm died in 90 seconds with a +110 window open.
- `deficit` stamped on the squeeze tape; `trailer_lane` stamped at fire-site (def-A tiers, NULL-degrading).
- Real tier cap lines (lane-aware WATCHLIST $300/$600-declared); open-position ADD line via isolated bets SELECT.
- **Shape confirmation (ACA P2b):** live `computeFuelTemp` recomputed at juice time, with a SHAPE NOW line comparing against the fire stamp (SHAPE HAS CHANGED / Unchanged since fire) and the pinned caution kernels appended.
- F5 cushion provenance gate: in Q4 the fire-state cell rate is swapped for a market-honest line plus a re-entry recipe.

### ACA — Alert Context Alignment (shipped Aug 6-7)

Origin: the LA@MIN row-1197 loss, where the decisive pass context (EARNED lead, cold sticky trailer) existed in the system and reached neither push surface. **Architectural principle: ONE COPY SOURCE, THREE SURFACES (mechanical push → narration → dashboard); the model narrates AROUND pinned facts, never mediates them.**

- **P0/P1 — T+0 FACT block:** fuel/temp/cautions/trap ride the Stage-1b *mechanical* push with zero model latency. B1 breadcrumb regression fixed (push.body rebuild had dropped the D-13 escalation line). STRUCTURAL-LEADER trap line pinned in `ssCautionLines`.
- **P2/P2b — JUICE intelligence** (above); `computeFuelTemp` / `ssCautionLines` / `efgTier` / `FUELTEMP_TH` mirrored into squeeze under **verbatim source-equality fixture contracts** (Netlify bundles per-function, so no shared require — equality is enforced by byte-compare fixtures; the aliasMap lesson applied to copy).
- **P3 — legacy inline narration deleted.** The V2 sweep on Fable-5 high-effort is the only narration path. Prompt contract v2 for both builders: a **5-element decision brief** — shape / case-for with mandatory provenance tags / case-against argued / watch conditions / price-breakeven — capped at 210 words. XGB reduced to extremes-only and MC dropped from snapState. Schedule-inflation band added to teamCtx (def-A derived, badge parity).
- **Regime tripwire** plumbed server + client: an INVERTED pulse suspends the numeric 2026 lines everywhere at once; trap lines always render.

### Dashboard Parity (c05b482)

`ssCautionLines` verbatim-mirrored into wnba-bdl.html (source-equality pinned) so the fuel block renders the same time-conditioned kernels as the alerts; the trap line is excluded on that surface because the verdict box already owns it. HOLDER READ giveback (~24%) was six-bucket cut and came back **flat and market-priced in every bucket** — time-robust, tagged as such rather than gated. The EARNED holder superlative was softened to the mechanism statement (earned 21% vs transient ~22% is indistinguishable below-bar).

### Verdict Strip

`get_ss_state` returns three isolated queries (latest snapshot ss_* gates; game row with winner-derived status; alert rows with leader/trailer anchors). `ssVerdictCompose` V0–V8 priority chain + VX fallback; `ssGapFmt` widens to 3 decimals near thresholds. Row-anchoring amendment (D-7/D-8): V8 checks `row.trailer === games.winner`; V1/V2/V3 are subject to the row's trailer/leader; V2/V3 apply only while that trailer still trails 1–9. Cache 55s TTL, 60s timer, staggered prefetch, render-miss kick, in-flight guard.

### Elite Definition & the One-Consumer-Definition Contract

**Elite:** hysteresis state machine — ENTER at win% ≥.600 with ≥15 GP, DEMOTE crossing <.550, RE-ENTER at ≥.600.

**Contract (KILLER_FLAG_SPEC §7):** ALL consumer-facing surfaces use the hysteresis definition (`elite`/`killer`/`tiers_elite`, "vs elite" prompt copy with the definition supplied to the agent, EK chip). **def-A tiers (current >.600) are INTERNAL-ONLY** — lane inflation computation and frozen honest-gap registration. Never mix the two on any surface.

**Schedule inflation:** infl = vs-rest win% − vs-top win% (internal def-A). INFLATED ≥ +.30, DEFLATED ≤ −.05. Anchors fixture-pinned: GS +.69, IND +.01, MIN −.11. Small-n/bare splits render no badge — never a fake HONEST 0.

### Killer Flag

**Definition:** leader_killer = team win% <.450 AND ≥2 scalps vs elite-as-of-EVALUATION-date (eval-date semantics validated 66%/n=59 vs 50%/n=62).

**Pipeline:** `computeKillerFields` (pure function, fixtures 51/51 incl. as-of replay) → profile JSONB → fire-site stamp on all SS rows (ctx-cached, NULL-degrading) → EK chip → GAP_BASE back-tagged via `update_ss_killer`.

**Evidence:** within band, <.400 leaders — killer 67% trailer conversion (n=45) vs no-scalp 53% (n=76); concentrated in modest gaps .15–.30 (75% vs 46%). **Mechanism:** scalps are two-sided variance events (+3.9 own heat, −3.7 opp cold). The .450 extension, live tells, decay, and frequency cuts are all dead. Promotion bar (pre-registered): killer rows ≥60% at n≥15 → sizing confidence within tier caps, NEVER tier elevation.

**Killer set:** POR, LA, CHI, SEA, PHX. CON/TOR: never-beats-anyone.

### Override Lane

WATCHLIST cap lifts $300 → $600 when the TRAILER is a top team (wp ≥.600) with **negative schedule inflation** (infl <0, ≥5 vs-top games, internal def-A — never tiers_elite). Members: **MIN (−.10), LV (−.05)**. Rules: declared-before-entry, max ONE open lane position, bets tagged LANE.

### Sizing, Grading & Graduation

**Tiered caps (test-sizing phase, bankroll $22K — deliberate under-sizing during graduation):** A-tier ≤$1,400 total per position; B-tier ≤$600; WATCHLIST ≤$300 (lane $600). **Staged entries grade as ONE position** against the tier cap — entry order, price patience, and declined adds all count toward the grade.

**Exit rule:** compare breakeven probability (offer ÷ payout) vs honest win probability. Sources straddling breakeven = NO EDGE = defensible partial de-risk, not a mandate.

**Three-tier grade key:** A+ clean dual-gate trigger · A−/B+ strong discretionary · B one gate clean, other soft · C/D/F pass-column bets taken anyway. **Grade process, not results.**

**Graduation bar:** ~25–40 logged clean dual-gate triggers + realized win% within ~5pp of predicted + clean grade ledger → ¼-Kelly (capped 12%). Watchdog is propose-only.

**Nightly log ritual:** every qualifying spot logged to `research/betting_log.md` (newest-on-top) with matchup, timing, leader/trailer + win%, gap, deficit, live line/implied, bet Y/N + size, reasoning, outcome/P&L.

### Human-in-the-Loop (two streams, never conflate)

Manny bets discretionarily on top of the signal and adds real selection edge. Measure separately: (1) **signal base edge** — all qualifying spots; (2) **realized edge** — spots he bet. Discretionary alpha = the difference. **Passes are logged as first-class rows** (row 36 DAL@MIN, graded A pass: MIN's eFG unsustainable at heavy juice, DAL elite so not a beatable leader, lead earned-ish — and MIN winning on a record shooting night does not retro-grade the pass).

### Record (Aug 11, 2026)

- **Flagged stream: 14-3 by position (23-4 by ticket), +$8,565.69 on $9,700 staked, 88.3% ROI**, plus 3 logged passes.
- Unflagged / pre-system speculatives: 4-3, +$1,835.
- All-in: +$10,400.69 on $12,070 (86.2% ROI).
- Counting note: staged legs are separate DB rows but ONE graded position — always state which convention a number uses.
- Loss anatomy: row 33 (LA@MIN, context-withheld → ACA), row 37 (CHI@SEA, stale gap stamp).

### Open failure class: the STALE GAP STAMP

The gap stamp captures team-level season quality at fire time and is blind to who is actually on the floor. **CHI@SEA (row 37)** fired on CHI .375 while CHI had two starters out plus a key shooter — the number overstated the team on the floor. Same class as the **Plum problem** on the leader side. A pre-fire personnel/injury check is the architectural fix; BDL exposes no lineups endpoint and `starter` flags are structurally absent from `/wnba/v1/player_stats`, while the ESPN boxscore parse *does* carry `starter` correctly. Injury-read track: **1-1** (Leite exit Aug 8 correctly capped-not-passed; CHI depletion Aug 10 not checked pre-fire).

-----

## RESEARCH FINDINGS SINCE v5.2 (WNBA)

### Instruments

- **2026 live archive** — production snapshots, ~211 finished games, live ML tape joinable from `odds_history` (≤3-4 min). Transfer: exact production surface. Power: usually LOW per cell.
- **Checkpoint arena** — 576 historical games reconstructed server-side to 2.5-min checkpoint box lines (incl. reconstructed POT) via `backtest-wnba?phase=export_checkpoints`; 2,724+ in-band states, splittable by season. Transfer: near-production. Power: MED–HIGH.
- **Both-seasons rule:** a cut is STRUCTURAL (spec-eligible) only if it holds in 2024 **and** 2025 independently. Sign-flips are regime-contingent at best, noise at worst.

### FUEL × TEMP × GAP map (Aug 6, n=178 states, ML tape 178/178)

The transient-collapse effect is **gap-gated**. Edge vs de-vig market by band:

|Gap band |Fuel      |n |conv|market|edge  |
|---------|----------|--|----|------|------|
|≥ +.15   |TRANSIENT |36|78% |64%   |**+14pp**|
|≥ +.15   |EARNED    |13|38% |59%   |**−21pp**|
|0…+.15   |TRANSIENT |23|48% |48%   |−1pp  |
|−.15…0   |TRANSIENT |25|36% |38%   |−2pp  |
|< −.15   |TRANSIENT |54|24% |25%   |−1pp  |

H1 (effect survives outside the band) rejected. The takeaway channel carries the market edge; fired-excluded attenuation is anti-loosening evidence.

### Takeaway decay × net-POT (Aug 6, n=703 states, six time buckets)

- **H1 CONFIRMED as a STEP, not a slope:** takeaway-fed edge vs market (gap≥0) = +19 / +13 / +13 / +13 / +11 / −2 across Q2-early → Q4-late. Intact through **early** Q4, dead inside 5:00 — a regression-*window* mechanism. Row-1197's juice fired in the dead bucket.
- **H2 net-POT REJECTED:** absolute leader POT ≥6 (current gate) beats the differential gate at 3× coverage (+14pp over n=142). The "mislabel" cell is fully alive.
- Shipped as a **three-form time-conditioned CHANNEL NOTE kernel**: pre-Q4 unchanged / Q4-early tempered / Q4-late number suspended, with a conservative degrade when the clock is unknown.

### eFG bar sensitivity (Aug 9) — BAR STANDS

On the operative population (pre-Q4, deficit 1-9, gap ≥.15, leader <.400): <45 = 16.7% (n=6) | 45-55 = 60.0% (n=35) | **>55 = 72.0% (n=50)**. Separation 12pp — the bar is *not* conservative. The earlier "warm converts nearly as well" read was a **mixing artifact**: on the un-conditioned population warm 63.8 vs hot 69.2, but conditioning on leader <.400 (the actual gate) widens it to 12pp. Context cell confirms the mechanism — with gap ≥.15 but leader ≥.400 the relationship **inverts** (warm 69.6 vs hot 60.0): decent teams' heat is more often genuinely theirs; bad teams' heat is variance. Consistent with the killer two-sided-variance mechanism.

### Team-relative eFG bands (Aug 9) — NOT PROMOTED

Delta = live leader eFG − own shrunk season baseline. Hot-vs-neutral separation +5.6pp < the pre-registered 8pp bar. H2 (high-baseline leaders hold better at matched absolute eFG) rejected at MED power. **Absolute bands stand.**

### STICKY HOLD (Aug 10) — FINAL KILL

Phase 1-2 looked strong: all-sticky holds +16.3pp vs market (n=28), dog cell +26.4pp (n=12). Phase 3 replication on 2025 **failed** (dog cell inverted, 22% vs 58%) while the calibration control **passed** (gap staircase confirmed a 4th time — 60/35/20 monotone), which is what makes the failure interpretable rather than an instrument problem. Phase 3b at checkpoint granularity pooled the dog cell to **n=43 ≥ the 40 bar and holds 37.2%** — the bar was met and **failed on merits, not power.** Mechanism in hindsight: a much-worse team leading with no fuel against a cold-but-better trailer is a thin lead with 25+ minutes left; the better team just wins.

**Rider — "fear earned leads" is LEADER-QUALITY-CONDITIONED:**
- DOG leaders (gap ≥.15): EARNED holds **35.4%** (n=65) vs TRANSIENT 51.7% (n=151) — earned-no-fuel dog leads are the *weakest* holds, not the strongest.
- QUALITY leaders (gap <0): EARNED 75.0% (n=136) ≈ TRANSIENT 78.0% (n=359) — quality leads hold regardless of fuel.
- **Revised card:** respect the LEADER'S QUALITY first; fuel/earned reads modify *within* quality class. An earned dog lead is a sell, not a hold.

### Retraction ledger (Aug 10-11)

Two of my own claims were withdrawn within 24 hours of being made — recorded here because the retraction is as load-bearing as the finding:

1. **"Heat layer is regime-dependent" (a3fae32) → DOWNGRADED to unproven.** The hot-cell oscillation (2024 64.2% / 2025 39.3% / 2026 72.0%) is ~2.7 SE across ~30 examined cells and is **not** backed by an independent regime measure — the independent league-wide pulse says the two historical seasons were in *similar* regimes (48.1% vs 43.6%). More parsimonious explanation: subcell sampling noise at n≈55. The tripwire's elevation to "mission-critical" is retracted; it stays as a sensible monitor without the historical mandate.
2. **Trailer temp × lead type = NOISE.** Every cell flips sign across seasons; pooled trailer temp is flat (cold 48.6 / warm 46.9 / hot 50.0). The 2026 separation (cold 45 / warm 80 / hot 87 at n=22/15/15) does **not** replicate at power. "Cold trailer = edge cut in half" is **withdrawn from the mindset card**; trailer temp earns no place in CELL READ and is display-only.
3. **Trailer eliteness adds nothing** within leader <.400 (53.3% vs 49.4%, sign flips by season) — do not add an elite-trailer field; the gap stamp already carries it.
4. **Cut 5c — the MIN@DAL shape isolated:** elite trailer vs leader ≥.550 = 35.3% (n=34, stable across seasons) — the weakest gap-qualified shape on the board. The Aug 9 pass at −200 was correct by a wide margin, not a close call.

### Pending spec: Dashboard Parity Amendment 1 v3 (awaiting PM go)

`SS_STRUCT` constant block duplicated in wnba-bdl.html and poll-live-bdl.mjs with **byte-compare fixture equality** (numbers get the aliasMap treatment), values pinned at build by re-running the spec-cuts script, states file committed for permanent reproducibility. Composition rules: **R1** base = 2024-25 structural, 2026 rider appended only when |2026−base| >10pp AND live n≥30; **R2** every rate labeled trailer-WINS or lead-HOLDS, no bare "converts"; **R3** 2026 riders render only with a `[this season]` tag, only in fade country, never pooled with structural numbers; **R4** Q4 clock <5:00 suppresses numbers, suspension copy only. Ships first: the **classifier definitions contract** (lead_class / fuel / trailer temp / leader bands defined verbatim in both narration templates — the prompt currently prints raw `lead_class` with no definition, so the model has been interpreting a label it was never given).

-----

## ANALYTICAL FRAMEWORK (NBA stack — stable, off-season)

### Five Indicators (I1-I5)

|Indicator|Weight|Key Fields|
|---|---|---|
|I1 Possession & Transition|25%|turnovers, steals, offensive_rebounds, points_off_turnovers, second_chance_pts, fast_break_pts|
|I2 Rim Pressure & Foul|25%|points_in_paint, paint att/made, free_throws_att, blocks, personal_fouls, bonus|
|I3 Shot Quality & Creation|20%|assists, field_goals_made, effective_fg_pct, three_points_att/made/pct|
|I4 Lineup Integrity|20%|biggest_lead, bench_points, on_court, per-period pls_min|
|I5 Tempo & Efficiency|10%|possessions, pace, offensive/defensive points_per_possession|

Control thresholds: 0.90+ DOMINANT | 0.75-0.89 STRONG | 0.60-0.74 EARNED | 0.45-0.59 NO EDGE | <0.45 WAIT. Scores sent control-team-relative via `ctrlI`.

**Conviction engine:** DOMINANT = I4+I5 (100%) or 4+ indicators. STRONG = I3+I4 (99%) or I3+I5 (96%). MODEST = 2+ without killer pairs. CONDITIONAL = 1. Danger combos: I1+I5 (50%), I1+I2+I5 (40%), I2+I3+I5 (63%). I4 won = 98%, I4 lost = 0%.

**Judge/Jury (v2):** engine computes I1–I5 + conviction mechanically; Opus receives them as ground truth and produces FWP + NARRATIVE + RISK + CLOSING + DISAGREEMENT (can flag disagreement, cannot override).

### XGBoost Win Probability

Model v2: 13 raw-stat features, control-relative, OOF AUC 0.749. Features: paint, pot, to, stl, oreb, ast, blk, fta, efg, biglead, 3pr, rim_pct, runs. JS TreeSHAP on every checkpoint (`live_tracking.checkpoints[].shap`).

**Entry gates:** BUY Q2<0.40, Q3<0.45, Q4<0.60; BWC/WB flat <0.40; POSITION_SAFE <0.50. **EXIT:** Q2-Q3 <0.50, Q4 <0.55, 2-poll confirm (90s), fast-path <0.15, recovery at threshold+0.10; 77.2% exit accuracy vs 54.1% for control-flip. **Windowed XGB** (2Q cross-fade): AUC 0.786 vs 0.769 cumulative, advantage grows late; biglead and runs stay cumulative.

**Conviction quality layers:** scoreboard (biglead SHAP discriminator — anchored 95% WR, flat 19%), VOLATILE={pot,oreb,stl,to,runs} vs STRUCTURAL={paint,ast,blk,fta,efg,biglead,3pr,rim_pct}, trajectory warnings.

**WNBA XGB mechanics:** native JSON uses l=-1,r=-1 for leaves; base_score is a probability (not logit); w = sum_hessian at internal nodes, leaf_weight at leaves. XGBoost float32 vs JS float64 → ~0.6% edge-case path differences (expected). Windowed biglead correct for WNBA (AUC 0.770→0.798); cumulative correct for NBA.

### Monte Carlo Engine

Always-on trajectory Q2+. Combined canary fires when MC<0.70 OR divergence>0.15. Canary → Investigation → Verdict → Pattern: CLEAN (n=277, 77.6% precision) fires Structural Stress ntfy; WAVE (66.7%); NORMALIZED/FALSE_ALARM reset for re-trigger. **MC Cumulative AUC 0.794** — strongest single NBA signal; when MC Cum and XGB disagree in Q4, MC is right 87%. Quarter accuracy at MC>0.70: Q2 76.3% / Q3 84.7% / Q4 91.9%.

**Trust hierarchy (all agent prompts):** Q2 Floor≈XGB>MC · Q3 MC≈XGB>Floor · Q4 MC>XGB>Floor. Q4 signal agreement (MC≥0.70 + XGB≥0.65 + Floor≥0.65) = 95.9% (n=2,213).

### TP / LS / Sustainability / Synthesizer

**TP is a veto layer, not a green light** — BLOCK (UNLIKELY/NO PATH) is 95%+ reliable; PASS only ~25-33%. TP gate removed from BUY/WB/CANDIDATE, agent context only. LS SAFE holds 94%, CRITICAL erodes 72%. Sustainability: Personnel 40% / Bayesian regression 35% / shot-type proxy 25%; 5-tier LOCKED IN → UNSUSTAINABLE plus STALLED downgrade. Synthesizer: edge >0 → BWC; ≤0 → NO VALUE; garbage line → NO VALUE; null edge → DEVELOPING; LS AT RISK/CRITICAL downgrades BWC → WATCH.

### Alerts, Positions, Graduation (NBA)

**Hard gates (never loosen):** clock <1 min, garbage line (±50K ML), period <Q2, "Neither" control team.

|Alert|Conditions|
|---|---|
|BUY|floor ≥0.65, trailing 1-15, ML >−250|
|BWC|floor ≥0.60, leading 2+, edge >0, ML >−250, LS not AT RISK/CRITICAL, ctrl_sust not FRAGILE+|
|WINDOW BUY|floor ≥0.45, margin −15..+5, QTR window ≥0.75, sust LOCKED/DURABLE|

Dedup key `gameId_alertType_alertTier_Q{period}`; BWC re-fire 5min OR floor +0.10. BUY tracks via `lt.buy_position`, exits via XGB_INVALIDATED only. BWC Death clears state on control flip and fires TRACKING_INVALIDATED. **Graduation (compound):** 5 poll holds at MC ≥0.80 + Floor ≥0.65; TRACKING → CONFIRMED (86%) → RECOVERING (73%) → LOCKED (92%). **POSITION OPEN must wait for graduation, not first BWC fire.**

**Post-game learning agent** (nightly 11:45pm MST): COLLECT → BUILD ARCS → SCORE → ANALYZE (Opus per slate) → STORE → NOTIFY. The same run executes the **WNBA SS resolver sweep + plain-English digest** (ledger status, lane line, fuel pulse, cash shadow, watchdog proposals).

-----

## WNBA PLATFORM NOTES

### Indicator backtest (legacy layer — superseded by Sweet Spot for betting)

203-game backtest 88.7%; WNBA weights I3 30% / I4 25% / I2 20% / I1 15% / I5 10%. I3 anti-inversion (losing I3 = 17.6% win rate vs NBA 49%); paint/rim = noise; TOs inverse; floor is narrative only in WNBA (wrong 80% vs MC+XGB); MC Q4 underestimates by +8–14pp; trailing band 1–9.

### BDL WNBA quirks

- No `box_scores` endpoint. **`/wnba/v1/player_stats` is the primary box source** — `game_ids[]` batching, cursor pagination, live mid-game, full per-player line incl. `pf`, `plus_minus`, `min`.
- **No lineups endpoint; `starter` flags structurally absent** — bench/foul-trouble logic falls back to minutes. `/players/active` carries no lineup data either (and has weight/college swapped — a BDL data bug, harmless to us). **ESPN's boxscore parse does carry `starter` correctly.**
- No `shooting_play` field on plays (regex fallback, 3 locations); no x/y coordinates. `team_stats` uses `fouls`/`turnovers`, no `pts`.
- Odds endpoints require `dates[]` **with brackets**; `game_ids[]` returns nothing there. `/odds/opening` is fully populated for 2025 but returns zero rows for 2026.
- Alias map: LVA→LV, NYL→NY, GSV→GS, WAS→WSH, LAS→LA, PDX→POR, TOY→TOR. **CRITICAL:** `cfg.aliasMap` applies ONLY at `parseBDLPBPServer` for WNBA — global application breaks NBA PBP parsing (the canonical regression).
- Date boundary: late-ET games land on the next UTC day; `bdlGameData` fetches both. No `season_averages` endpoint → SS carrier baselines use lazy per-player `/player_stats` fetches.

### Known WNBA gaps

- `pregame-agent.mjs` hardcoded to NBA; WNBA briefs run through the GAME_BRIEF path
- `generate-thesis.mjs` has no WNBA support
- ESPN ID mid-game fallback (SR retry works pre-tip only)
- Killer split in `ss_ledger_summary` (n≥8/cell) not built — summary groups by subtype only

-----

## RESEARCH RULED OUT (do not revisit without a genuinely new hypothesis)

**NBA stack:** Bayesian recency weighting (+0.0 AUC) · change-point detection (CUSUM/sliding/BOCPD all at chance — the floor already *is* a change-point detector) · Holly auto-tuning (−0.02 AUC, overfits) · SHAP delta model · opponent rising canary (mathematically coupled) · EXIT confirmation via MC · conformal prediction · production weight re-optimization (+0.01) · position monitoring as a separate alert layer · Transition Alerts (cascade risk — trust the validated state machine).

**WNBA Sweet Spot:** eFG-heat as the operative base signal (NBA deficit-controlled null, n=1,200) · structural underdog #10 (1-for-7 at Q3_END) · failure-profile 72%/44% · windowed MC for WNBA (Cum 0.801 > Wind 0.787) · killer .450 extension, live tells, decay, frequency cuts · trajectory features at 3-min resolution (+0.0003 AUC; may revisit at 60s) · **team-relative eFG bands** · **sticky hold** · **trailer temp as a predictive field** · **trailer eliteness as a card field** · band widening past 9 · gap-gate lowering to .05.

-----

## KEY LEARNINGS & PRINCIPLES

### Structural analysis

- BLOCK is 95%+ reliable for vetoing; PASS is 25–33% reliable for sizing confidence
- `structRate` cannot distinguish effort-based from talent-based production
- Teams with no shooters never regress up
- C&S 3PT scheme production is structural offense, not variance
- **Cumulative floor anchors stale early-game data into late-game reads** — the biggest known NBA failure mode (AUC 0.329 in lead-change games)
- Fix the data, not the machine
- **The agent is a narrator, not just a gate** — it builds game context for all downstream alerts. Never bypass it
- **The quality gap alone is not the sweet spot** — always run the whose-variance check
- **Respect the leader's quality first**; fuel/earned reads modify within quality class
- **A-tier alerts don't recover, they detonate** (the scissor mechanic) — tier-dependent price lesson: A-tier take the fire price; B-tier/WATCHLIST need patience

### Alert / position design

- POSITION OPEN waits for graduation, not first BWC fire
- Alert cascade is the biggest UX problem — suppress correctly
- Alert bodies lead with action, explain why, translate all jargon
- Staged entries are ONE position; declined adds and price passes are graded, not just wins
- **Pinned facts ride the mechanical push; the model narrates around them** (ACA) — anything the model can paraphrase away is a fact you will lose on the night it matters

### Team-specific

- **OKC** defense is system-driven, not star-dependent; post-deadline TO-rate discount for new ball-handlers <4 weeks; live TO gate 5+ above season avg by mid-Q3
- **WNBA:** GS = elite with a super-elite problem (DUAL_EDGE, 0-5 vs MIN/LV); killer set POR/LA/CHI/SEA/PHX; CON/TOR never-beats-anyone; MIN + LV = deflated top teams (override lane)

### Engineering patterns

- Quarter data hydration must be ABOVE the `gapLog` guard
- Poll BDL date uses `getSlateDate(dateOffset)` not `(0)`
- `getFloor()` chain: `sonnetIndicators` → `clientInd` → `_serverFloor` → `rollingWindow`
- Netlify: missing `await` kills unawaited promises; emojis in HTTP headers crash Node; each function bundles separately (no cross-function require — mirrored code needs **fixture-enforced source equality**)
- Any `await` >1s creates a concurrent-invocation race requiring a DB lock row
- Never add columns to existing SELECTs on critical polling paths — fetch in separate isolated queries (why `get_ss_state` is three queries)
- After scoping fixes, audit all log lines in the same block for the same variable-name pattern
- Pure-function extraction + golden fixtures for anything with definitional semantics (`computeKillerFields`, `ssVerdictCompose`, `ssCautionLines`, `computeFuelTemp`, digest copy)
- `let`/`const` at line ~10,000 causes TDZ when referenced earlier — use `var` for globals
- Anthropic credit exhaustion makes auto-analyses fail silently

-----

## COLLABORATION & WORKFLOW

### Roles

Manny is PM, product owner, sole bettor, and domain expert. Claude is lead engineer, UI/UX designer, and co-pilot with high autonomy on implementation once PM decisions are aligned.

Manny describes it as: *"I designed the framework and product direction, but I build it collaboratively with Claude. I describe what I want, we architect it together, Claude writes the code, I test and deploy."*

### Tone

Relaxed, joking — not a military briefing. Manny thinks in frameworks, not features. He pressure-tests architecture and catches logical errors in production. He values directness and honest pushback. When he says "you're grasping at straws," stop the current line of reasoning and go back to the data. He calls Claude "son."

### CRITICAL WORKFLOW RULE

**Never implement code changes without explicit confirmation.** Questions are questions, not directives — answer, then wait. Spec proposals can be shared proactively; code requires explicit go-ahead. Violating this breaks trust.

### PRESENTATION RULE

**Always present full spec contents in chat when creating or amending a spec — never just commit and reference a filename.** Manny runs DFT from his phone; making him open the repo is exactly the back-and-forth this rule kills. Same for URLs and scripts: code blocks for one-tap copy.

### HOW RESEARCH FINDINGS ARE PRESENTED (standing contract)

**Register: explain it fresh, every time.** Define every metric, term, and field name at first use — including ones used a hundred times before. State what is being measured, how it was measured, and what it means at the betting window. Never assume a term carries its meaning across sessions.

**Structure of a findings delivery:**
1. **Verdict first** — PROMOTED / NOT PROMOTED / KILLED / RETRACTED / BAR STANDS. No burying the lede under methodology.
2. **The number**, with n, and the **power tag** (HIGH 200+ / MED 80–200 / LOW <80).
3. **Provenance** — which instrument (2026 live archive / checkpoint arena / historical OOS), which seasons, backtest vs production transfer. Provenance over raw n.
4. **What changes** — engine, copy, sizing, or nothing. "Nothing" is a legitimate and frequent answer.
5. **Mechanism** — why the number is what it is. A number without a mechanism is a candidate, not a finding.

**Rules that govern the numbers:**
- **No directive language below MED power.** Below the cutoff, report ordering only — never precision, never "do X."
- **Pre-register in chat before cutting:** hypothesis, population, primary metric, success bar, and the promotion rule. Amendments must be disclosed and dated (as in the FUEL map's v2 recipe).
- **Both-seasons rule** for any structural claim on the checkpoint arena.
- **Edge vs de-vig market is the primary metric** wherever a price exists — implied odds control deficit and time, which makes cross-bucket comparison honest. A conversion rate with no price attached is half a finding.
- **Dedupe to one row per game** (priority EFG_FADE > WATCHLIST > GAP_BASE) or losses double-count.
- **Riders vs structure:** 2026-only numbers never pool with multi-season structural numbers and always carry a `[this season]` tag.
- **Retraction is a first-class output.** When a claim fails to replicate, say so loudly, name the commit that made it, and strip the copy that depended on it. Two claims were withdrawn within 24 hours in August; that is the system working.
- **Tables where they help, prose where the mechanism lives.** Manny reads on a phone — lead with the finding, keep the table tight, put the reasoning in sentences.
- Findings commit to `research/` with a date prefix, alongside the script and (where feasible) the states file, so any number can be regenerated.

### Co-Pilot Mode

Don't just answer questions — propose experiments, ask "what about X?" *"The insights come from me and are constrained by how creative I can think."* This produced the MC oscillation discovery, the killer mechanism, the override lane, and the takeaway-decay step function.

### Architectural Advisory

Before building any substantial feature, surface the architectural decision: "this is N functions and ~X lines — own module or inline? Here are the tradeoffs." Architecture improves alongside feature work, not as separate refactoring sprints.

### Architecture-First Development

Standing instruction for any non-trivial change: **"Architect/spec required changes meticulously, trace cascading implications and identify mitigation options. Identify dead code to be cleaned up. I don't want to introduce any bugs when we move to implementation."**

1. Map every code path that touches the change
2. Identify all consumers of modified functions/data
3. Trace 1st, 2nd, 3rd order effects
4. Flag dead code for cleanup
5. Present the full spec with cascading implications **before** building

### Testing Ownership

Claude owns unit/integration testing; test plans ship as part of the spec. `node -c` before every commit; fixture harnesses green before push. Standing harnesses: verdict strip (41), computeKillerFields (51/51 incl. as-of replay), override lane (35/35), decision support / caution copy (124/124), squeeze (77/77), narration (50/50), matchup sheet, team ctx (server + client). **Source-equality fixtures** byte-compare any logic or copy mirrored across functions — the aliasMap regression is the canonical example of what tests catch.

### Diagnostic Methodology — MANDATORY before any fix

1. **Pull the data first** — snapshots, alerts, analyses, quarter data, raw stats, odds tape. Direct DB access.
2. **Look from multiple perspectives** — server mechanical, server model, client, market, final outcome. When they disagree, **the disagreement is the diagnosis**.
3. **Identify the exact divergence** — which value, which component, which time.
4. **Hypothesis, not conclusion** — name the suspected root cause, trace the code path, verify against data.
5. **Propose the fix only after diagnosis.** Hit the endpoint first and get the real error; never add logging and theorize.

### Data Pulling Discipline

Read source / project knowledge BEFORE writing pull scripts — guessed field names waste time chasing phantom missing data. Patterns: `get_alerts→{alerts}`, `get_games→{games}`, `history→{snapshots}`, `get_sweetspot_alerts→{sweetspot_alerts}`, `get_bets→{bets}`; **always `&league=wnba`**; WNBA games use `id` (UUID) not `game_id`.

### Session Startup Protocol

1. Clone repo to `/home/claude/dft`; git config; if the PAT rotated, `git remote set-url` then `git fetch -q origin`
2. `wc -l` key files (poll-live-bdl, db-api, post-game-agent, team-profiles-nightly, odds-squeeze, wnba-bdl)
3. `git log --oneline -12` (use `--date=short` when reconstructing a timeline)
4. Pull live state: `get_poll_state`, `ss_ledger_summary`, `get_bets`, `get_sweetspot_alerts`, `get_learnings`
5. Search recent chats for continuity
6. Read relevant source files before touching anything

This prevents the phantom-completion bug. **Line counts are ground truth for detecting state drift** — memory and chat summaries are not.

### Backlog Management

This doc describes the system as it exists — shipped features and decisions. Active backlog and in-progress research live in Claude's memories. When backlog items persist across sessions without being worked, ask "still want this or should we kill it?" Items move into this doc when they ship.

### Known Blindspots (self-correcting)

1. **Prompt text gets less rigor than code** — numbers in template literals are functional constants. Grep old values; verify all replaced.
2. **Additive bias** — adds new content well, under-audits existing content that needs updating.
3. **When tempted to simplify vs spec, re-read WHY the spec chose the harder option.**
4. **Jumps to pull scripts with guessed field names** — read source first.
5. **Overweighting the freshest finding at the moment of decision** — the row-37 loss leaned on a LOW-power 2026-only mechanism that was explicitly tagged hold-loosely. Recency is not power.

-----

## DIRECT ACCESS WORKFLOW

`curl -s -u manny:DFT2025! "https://poetic-starlight-aa8938.netlify.app/.netlify/functions/db-api?action=..."`

**Core:** `get_alerts` · `get_games` · `get_learnings` · `get_poll_state` · `get_poll_history` · `get_latest_snapshots` · `get_live_tracking` · `get_calibration` · `get_odds` · `history` · `get_checkpoints` · `get_clutch_profiles` · `get_quarter_data` · `get_snapshot_timeline` · `snapshot_diagnostic` · `init` · `delete_learning`

**Sweet Spot:** `get_sweetspot_alerts` · `ss_ledger_summary` · `get_ss_state` · `stamp_ss_fueltemp` · `update_ss_killer` · `arm_squeeze` · `disarm_squeeze` · `log_bet` · `get_bets` · `update_bet` · `get_team_profiles` · `get_team_game_stats` · `get_wnba_official` / `upsert_wnba_official`

**Backtest:** `backtest-nba-snapshots?phase=...` (incl. `export_xgb`) · `mc-backtest?phase=...` (12+ phases; `batch=2` safe ceiling) · `backtest-wnba?phase=...` (524-game historical; read-only `export_states` and `export_checkpoints` build the checkpoint arena with zero SR API calls)

**Also:** rerun the learning agent via `?action=delete_learning&date=...` then `/post-game-agent?date=...`; poll directly at `/.netlify/functions/poll-live-bdl` (`?diag=1&diag_step=N`, steps 0–4 pass, 5=XGB, 6=sust).

**League parameterization:** always pass `&league=wnba` for WNBA. Default is NBA. Forgetting this returns empty results and leads to wrong conclusions.

### Live Game Collaboration

Manny chats during a live slate; Claude pulls real-time data to confirm what he's seeing — snapshots, agent decisions, verdict-strip state, SS rows, squeeze tape, learnings, post-game arc audits — all direct, no console round-trips. Console scripts are needed only for authenticated dashboard context (cardState, localStorage, DOM).

-----

## MEMORY MANAGEMENT STRATEGY

**In project knowledge (this doc):** shipped architecture; framework principles and validated learnings; API keys and operational config; alert thresholds and engine rules; team-specific insights; ruled-out research and retractions; workflow rules; data source details and schema.

**In memories:** active work items; queued items; live research threads (removed when concluded); recent changes not yet migrated; behavioral directives needing reinforcement.

When memories approach the limit: audit against this doc, remove duplicates, migrate stable info here. This doc updates at major architectural changes or natural breakpoints; Manny uploads the new version to project settings. **A copy lives at repo root and is committed with each version bump so repo and project settings never drift.**

-----

## V3 DASHBOARD / DEBUG DASHBOARD

**v3.html** (~3,983): mobile-first single-card swipe, demo mode, live line shopping toast, ⚡ Analyze, 10s poll, ESPN/XGB WP toggle, XGB column, MC Cum row + drivers, collapsible MC investigation strip, confidence table, 30-team color map, shot zones, margin flow.

**debug.html** (~3,295): 7 sections — DB & Data; Calibration; Analytics; Game Inspector; QA Suite (13 league-aware checks); Alert Accuracy; Nightly Learnings.

**Alert accuracy baseline (Apr 6-7, 15 games):** 43/71 (61%). BUY 75%, BWC 71%, WINDOW BUY 67%, RECOVERY PATH 63%, LEAN BUY 17% (killed). 89% of wrong alerts came from blowouts where the floor was fundamentally wrong.

-----

## HOTFIX LEARNINGS (permanent — never repeat)

1. BDL clock `"Q4 8:03"` — strip prefix via regex before `parseInt`
2. Node `fetch` requires ASCII-only headers — no emoji in HTTP `Title`
3. Netlify kills unawaited promises — always `await sendNtfy` and similar
4. `.catch(() => {})` silently swallows errors — always log
5. BDL stats are strings — wrap all math in `Number()`; BDL zeros arrive as `null`
6. `let`/`const` at line ~10,000 causes TDZ when referenced at ~1,800 — use `var` for globals
7. Netlify bundles each function separately — can't `require` across functions; mirrored logic needs source-equality fixtures
8. Netlify password protection returns 401 on internal HTTP calls — embed Anthropic calls directly
9. `BDL game.period = 0` during live games — extract period from `game.time`
10. `_headers` `/*` pattern blocks cron functions — scope to `/*.html` only
11. Concurrent Netlify invocations create races — use DB lock rows (PENDING sentinel) before any await >1s
12. `cfg.aliasMap` applies only at WNBA PBP parse — global application breaks NBA
13. Fable 5 prepends a thinking block — filter to text blocks before parsing narration
