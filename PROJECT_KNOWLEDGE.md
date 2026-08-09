# Deepfuckingthesis — Project Knowledge

**Version:** 5.2
**Last updated:** July 17, 2026
**Live URL:** https://poetic-starlight-aa8938.netlify.app
**GitHub:** MannyBanda/Deepfuckingthesis (private)

*(v5.2 = the full refresh v5.1 promised. Integrates the WNBA Sweet Spot engine as a first-class section: the locked trailing-buy signal, tier system, verdict strip, elite definition + one-consumer-definition contract, killer flag, override lane, tiered sizing, and the live betting record. Also: presentation rule, updated architecture/table state, updated env flags. The NBA indicator/state-machine stack sections are unchanged from v5.1 — that system is stable and off-season.)*

**How we got here (May 11 → Jul 17):** v5.0 closed with the NBA stack mature and WNBA freshly deployed. Since then the center of gravity moved to WNBA live season. The quality-gap trailing-buy signal was discovered, triple-confirmed across three independent samples, and locked. The Sweet Spot engine was specced, built, and went fully live Jul 12 (A/B tiers + WATCHLIST + ledger + ops layer). The verdict strip shipped to the dashboard. Team profiles nightly infrastructure shipped, which enabled the elite definition, schedule-inflation research, the override lane, and the killer flag — all shipped end-to-end by Jul 16. Real money is on: the flagged stream is 6-0, +$4,694.

-----

## WHAT THIS IS

A multi-league live betting intelligence platform that combines real-time game data (Sportradar, BallDontLie, ESPN), server-side polling with autonomous alert generation, Claude Opus-powered structural analysis, and agentic reasoning layers to identify structural betting edges.

The platform now runs **two analytical frameworks**:

1. **NBA indicator/state-machine stack** (I1–I5, conviction engine, XGB/MC, BWC/graduation) — mature, validated on 1,235+ games, currently off-season.
2. **WNBA Sweet Spot engine** — the live, in-season edge. Core thesis: identify moments where a structurally better team trails a weaker leader whose lead is built on unsustainable variance, then buy the trailer at plus-money odds.

**The server is the primary analytical engine.** The dashboard exists for deep inspection, but the system is designed for dashboard-free game monitoring via ntfy push alerts (topic: `manny_nba_control`). Alert bodies must be plain English: lead with action, explain structural edge, translate jargon, include what to watch for. Manny is the sole alert recipient.

-----

## ARCHITECTURE

```
Client:
  bdl.html (~12,340 lines)         — NBA client dashboard (MUST always be named exactly this)
  v3.html (~3,983 lines)           — V3 NBA dashboard
  wnba-bdl.html (~5,067 lines)     — WNBA dashboard (verdict strip, EK chip, matchup sheet w/ BRIEFING)
  ncaamb-bdl.html (~9,846 lines)   — NCAAMB client dashboard
  debug.html (~3,295 lines)        — Diagnostic dashboard (7 sections)

Server (netlify/functions/):
  poll-live-bdl.mjs (~10,795 lines)     — Server polling, mechanical alerts, XGB, MC, Opus analysis,
                                          alert reasoning agent, Sweet Spot engine + narration + pregame briefs
  db-api.js (~3,190 lines)              — Database API (Neon Postgres)
  team-profiles-nightly.mjs (~542 lines)— Nightly team profiles: season splits, elite tiers, killer fields
  post-game-agent.mjs (~1,119 lines)    — Nightly learning agent + SS resolver sweep + plain-English digest
                                          (cron 11:45pm MST)
  mc-backtest.mjs (~5,647 lines)        — Monte Carlo backtest harness (12+ phases)
  analyze.js (~1,047 lines)             — Client Opus analysis endpoint
  pregame-agent.mjs (~1,323 lines)      — Pre-game thesis generation (cron */5 min; NBA-hardcoded)
  backtest-nba-snapshots.mjs (~8,891 lines) — NBA checkpoint backtest harness
  backtest-wnba.mjs                     — WNBA backtest harness (524-game historical sample)
  sr-data.js / bdl-data.js / bdl-enrich.js / bdl-pbp-adapter.js / espn-data.js / odds-api.js — data proxies
  generate-thesis.mjs                   — Opus thesis generation (NBA only)
  clutch-ocr.js                         — Opus vision OCR for clutch screenshots
  xgb-replay.js                         — XGB retroactive replay on prod snapshots
  test-agent.js / test-v2-engine.mjs    — test harnesses

Models:
  netlify/functions/xgb-model.json      — NBA windowed XGB (220KB)
  netlify/functions/xgb-model-wnba.json — WNBA XGB (windowed biglead)

Config & research:
  netlify.toml                     — Build config, function timeouts
  research/                        — Validated research findings (*.md, *.py, fixtures)
  *_SPEC.md at repo root           — Active/deployment specs; specs/shipped|rejected at ship
```

*(Line counts drift with active development — the session startup protocol's `wc -l` is the ground truth, not this table.)*

### Multi-League Architecture

**Single app, league-parameterized.** One set of Netlify functions, league passed as a parameter. NOT separate deployments. The `LEAGUE` config object in poll-live-bdl.mjs holds per-league settings: SR base URLs, BDL prefixes, period types, game rules, feature flags, thresholds.

**Current priority:** WNBA (in season, Sweet Spot engine live, real money on) → NBA (mature, off-season) → NCAAMB (March Madness sprint).

**Active specs at repo root:** `SWEETSPOT_ENGINE_SPEC.md`, `SWEETSPOT_4C_SPEC.md`, `SWEETSPOT_TIER_BC_SPEC.md`, `SWEETSPOT_NARRATION_V2_SPEC.md`, `SWEETSPOT_VERDICT_STRIP_SPEC.md`, `KILLER_FLAG_SPEC.md`, `OVERRIDE_LANE_SPEC.md`, `TEAM_PROFILES_SPEC.md`, `TEAM_CTX_SURFACING_SPEC.md`, `WNBA_PREGAME_AGENT_SPEC.md`.

### CI/CD Pipeline

1. Claude clones repo to `/home/claude/dft` at session start
1. Runs `git config user.name "MannyBanda" && git config user.email "manny@dft.dev"`
1. Verifies actual file state (`wc -l` key files, `git log --oneline`, grep) before proceeding — never assumes prior session's changes are deployed
1. Searches recent chat history for continuity on active work
1. Reads relevant source files to understand available endpoints and data structures
1. Edits files, syntax checks with `node -c` (for HTML: extract script block first)
1. Multi-file sessions: stages all modified files together in a single descriptive commit
1. Pushes directly to GitHub via PAT
1. Netlify auto-deploys from GitHub on push (~50 seconds)
1. Manny confirms deployment; Claude communicates findings explicitly so Manny knows deployment state

### Infrastructure

- **Netlify Pro** (not free — never hedge about this). Basic Auth via `_headers` file (replaced JWT Apr 23 — no 1hr timeout). Internal Netlify-to-Netlify calls return 401 — use direct Anthropic API calls from poll function, not internal HTTP.
- **Neon Postgres** via Netlify DB. Schema migrations use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. Run `?action=init` after adding new columns.
- **GitHub auto-deploys** on push to main.

-----

## ENVIRONMENT & ACCESS

### API Keys

|Service  |Key                                       |Env Var            |Notes                           |
|---------|------------------------------------------|-------------------|--------------------------------|
|BDL      |`ee78e074-2f89-4ee5-807a-181fc324398c`    |`BDL_API_KEY`      |GOAT tier, all leagues          |
|SR NBA   |`HE9cr9RYzuQnPmD7PO8ueCuirC65QyyCv9jYH2cU`|`SR_API_KEY`       |trial/v8, 1 req/sec             |
|SR NCAAMB|`OZ1P5Dnx0WjWHGy6yNFlMIT8rqQVQILftOR9xOpO`|`SR_NCAAMB_KEY`    |trial/v8, separate from NBA     |
|SR WNBA  |`kQEMwYyZ35p5kHcBKQEfQdyJvamU3XlCHBzGxc5C`|`SR_WNBA_KEY`      |replaced Jul 19 (prior: May 10)|
|Anthropic|—                                         |`ANTHROPIC_API_KEY`|Opus calls                      |

Other Netlify env vars: `DATABASE_URL`, `NTFY_TOPIC` (manny_nba_control), `ODDS_API_KEY` (The Odds API paid plan, 20K credits/month).

**Sweet Spot flag family:** `WNBA_SS_ALERT_ON` (A-tier, =1 since Jul 2), `WNBA_SS_B_ON` (B tiers), `WNBA_SS_WATCHLIST_ON`, `WNBA_SS_LEDGER_ON` (GAP_BASE/Q4_COLLAPSE streams), `WNBA_SS_NARRATE_WATCHLIST` (=1, D-12 review narration), `WNBA_SS_NARRATE_V` (narration version), `WNBA_SS_COMPUTE_OFF` (kill switch). All tiers + ledger enabled since Jul 12.

### GitHub PAT

`github_pat_11AEAFZZA0th…` — REDACTED in this repo copy (GitHub push protection); the full token lives in the project-settings copy of this doc, which is the copy Claude reads at session start. (Fine-grained, Contents read/write, scoped to Deepfuckingthesis, issued Aug 6, 2026 — replaced the Jul 2, 2026 PAT). Git config: user MannyBanda, remote uses x-access-token auth. Clone to `/home/claude/dft`, pull --rebase before push.

### Claude Sandbox Network Access

Both `poetic-starlight-aa8938.netlify.app` and `ep-divine-moon-am705tkz-pooler.c-5.us-east-1.aws.neon.tech` are in the network allowlist. Claude can directly hit all db-api endpoints via curl. Basic Auth: `manny:DFT2025!`. Direct TCP to Neon on port 5432 is blocked — HTTP only via db-api layer.

### Database Tables

**`alerts`** — i1-i5, conviction_tier/combo, alert_tier, agent_decision/reasoning, ntfy_sent, bwc_state, erosion_level, peak_floor, exit_severity, graduation_rank, mf_trajectory, combined_read, cp_eligible_count, cp_ctrl_flips, lane, position_closed, is_flip_buy, cp_mean_floor, `position_team`, xgb_win_prob, xgb_aligned.

**`games`** — live_tracking JSONB (BWC state machine persistence, checkpoint data, MC state, buy_position).

**`snapshots`** — raw_stats_json, tp/ls columns, sust_json, xgb_win_prob, xgb_divergence, mc_win_prob (always-on Q2+), mc_cum_win_prob, `ss_*` gate columns (Sweet Spot state read by verdict strip).

**`sweetspot_alerts`** — the Sweet Spot engine's row store. Per row: alert_subtype (EFG_FADE / B tiers / WATCHLIST / GAP_BASE / Q4_COLLAPSE / GAME_BRIEF), alert_tier, period/clock, leader/trailer aliases + wp, quality_gap, leader_efg + band, variance_share, lead_class, fade/collapse tiers, deficit/margin, line_used/consensus/implied/edge, kelly_size, narration_text + narration_attempts, ntfy_sent, §4c carrier_* + player_ctx_json, resolver fields (resolved, trailer_won, final scores, resolved_at), killer fields (leader_killer, leader_scalps — stamped at fire-site from cached team ctx, NULL-degrading; first live-stamped row: 435, SEA@IND Jul 17).

**`bets`** — Manny's bet log (21 rows as of Jul 17). Matchup, side, odds, stake, result, pnl. Grading conventions below. Book default: bet365.

**`team_profiles`** — nightly-computed per-team season profile JSONB (PK team_alias/league/season): splits, archetypes, schedule inflation, `elite`/`killer`/`tiers_elite` consumer fields, def-A tiers (internal-only). Written solely by team-profiles-nightly. **`team_game_stats`** — per-game team lines feeding profile computation. **`job_locks`** — nightly job dedup.

**`game_checkpoints`** — PK (game_id, label). Atomic INSERT ON CONFLICT DO NOTHING. Race-safe checkpoint graduation.

**`clutch_profiles`** — PK (team_alias, league, season). Auto-UPSERT Q4 rates at game finalization. Used by MC engine.

**`nba_snapshot_backtest`** — 16,910 rows (integer `bdl_game_id`, join through `nba_backtest` not `games` table).

**Other:** theses, analyses, clutch, odds_history, wp_profiles, poll_state, poll_heartbeats, season_cache, game_context (server-only writer; DO UPDATE not DO NOTHING), game_pbp, learnings (nightly post-game agent output).

**Dead columns:** prev_home/away_tp/ls/opp_sust, lead_degraded_at, monitor_* on alerts/poll_state.

-----

## DATA SOURCES

### BallDontLie (Primary — all leagues)

- **Base:** `https://api.balldontlie.io`
- **NBA:** Full coverage (basic + advanced stats, odds, clutch, plays, box scores)
- **NCAAMB/WNBA:** Basic stats + plays only (no advanced stats, no clutch)
- BDL is the primary data path for live game polling and box scores.
- `game.period = 0` during live games — extract period from `game.time` string (e.g., `"Q4 8:03"` → 4).

### Sportradar (Supplemental + Schedule)

|League|Base URL                                        |
|------|------------------------------------------------|
|NBA   |`https://api.sportradar.com/nba/trial/v8/en/`   |
|NCAAMB|`https://api.sportradar.com/ncaamb/trial/v8/en/`|
|WNBA  |`https://api.sportradar.com/wnba/trial/v8/en/`  |

**Used for:** Schedule, injuries, team profiles, depth charts, seasonal stats, splits, standings, pre-game context. SR supplements BDL, not the other way around.

**Rate limits:** Trial tier — 1 req/sec, daily cap per key. Separate keys per league isolate rate limits.

SR game summary has full per-period TEAM stats under `home.statistics.periods[]` (paint, POT, SCP, FBP, biggest_lead, possessions).

### ESPN (Win Probability + WNBA Schedule)

Scoreboard and win probability endpoints polled server-side. WP displayed on client with line chart, current %, trend arrow. ESPN scoreboard is the fallback for WNBA schedule discovery when SR has no preseason data (404). ESPN scoreboard proxy returns homeScore/awayScore/period/clock for live score refresh (10s cadence on WNBA dashboard).

### Claude Opus (Analysis Engine)

- **Models:** `claude-opus-4-6` (Opus 4.6) for alert agent, auto-analysis, nightly learning, OCR, theses. Sweet Spot Stage-2 narration uses `claude-opus-4-8`.
- **Used by:** analyze.js, poll-live-bdl.mjs (agent + auto-analysis + SS narration), post-game-agent.mjs, clutch-ocr.js, pregame-agent.mjs.

-----

## WNBA SWEET SPOT ENGINE (live — the current primary edge)

### The Locked Trailing-Buy Signal (triple-confirmed)

**Quality-gap comeback edge:** a BETTER team trailing a BEATABLE leader at a CATCHABLE deficit. Confirmed across three independent samples:

- **WNBA live 2026** (n=95): +19.5pp edge
- **NBA deficit-controlled** (1,235 games): at Q3_END, worse-team trailers convert 22% → better-team trailers convert 58%
- **WNBA historical 2024–25** (524 games OOS): worse 16.5% → better 48%

**Operative signal = quality gap (trailer win% − leader win%) + deficit + live line.** No eFG/divergence machinery needed for the base edge.

**The "whose variance is it?" check:** the variance-share delta must favor the LEADER for a fade to apply. The full SWEET SPOT requires BOTH: (a) leader genuinely bad (<.40 win%) AND (b) leader's lead is the unsustainable part (elevated eFG ± variance share >55% from 3PT+mid), in band (deficit ≤9), pre-Q4. POR@CHI Jun 24 is the teaching-pair negative: POR was the variance team, CHI was the structural dominant — the quality gap alone was a siren.

**Ruled out (do not revisit without a genuinely new hypothesis):**
- **eFG-heat is not operative** — NBA deficit-controlled null (n=1,200); WNBA appearance was a small-sample artifact. The engine's fadeRead "+3pp STRONG FADE" confirm is a candidate to drop (no change without go-ahead).
- **Structural underdog (#10) killed** — 1-for-7 at Q3_END, negative/zero edge across all variants.
- **Failure-profile 72%/44% killed** (margin-unconditioned; mcOnlyFailure routes to [STRUCT] BUY-setup language — no number, no directive). The 44% suppress bucket did replicate OOS (40%).

### Tier System & Ledger

- **A-tier (EFG_FADE):** the full sweet spot — dual-gate confirmed. Live since Jul 2.
- **B-tier (B1/B2/B3):** relaxed variants. Live since Jul 12.
- **WATCHLIST:** qualifying quality-gap spots below alert bar — surfaced for discretionary review. D-12 review narration live (`WNBA_SS_NARRATE_WATCHLIST=1`, review prompt, 2h claim window, priority 2).
- **Ledger streams (log-only, no push):** GAP_BASE (every in-band quality-gap spot — the forward OOS sample) and Q4_COLLAPSE.
- **GAME_BRIEF:** pregame brief rows — `ssSeedPregameBriefs` seeds period-0 skeletons for not-yet-tipped slate games every cycle (idempotent PK dedup, self-heals missed windows); narration sweep is row-aware (period-0 briefs get pregame-honest season-lens reason, no push; tip-seeded briefs keep at-tip push).

### Ops Layer

Resolver sweep in post-game agent (nightly 11:45pm MST) resolves SS rows with trailer_won + final scores; WNBA finals computed via BDL player_stats sums. db-api actions: `get_sweetspot_alerts`, `ss_ledger_summary`, `get_ss_state`, `log_bet`, `get_bets`, `update_bet`, `update_ss_killer`, `get_team_profiles`. Plain-English nightly digest with pinned copy fixtures, including the OVERRIDE LANE line (`ssOverrideLaneLine`). Graduation watchdog (n≥30, propose-only).

### Verdict Strip (dashboard)

Full verdict strip on WNBA cards. `get_ss_state` returns three isolated queries (latest snapshot ss_* gates; game row with winner-derived status via `CASE WHEN winner IS NOT NULL THEN 'closed'`; alert rows with leader/trailer anchors). `ssVerdictCompose` V0–V8 priority chain + VX fallback; `ssGapFmt` widens to 3 decimals near .15/.20 thresholds. Fetch/cache/timer plumbing: `_ssStateCache` 55s TTL, 60s timer, staggered SS-state prefetch during Phase-2 hydration, render-miss kick, in-flight guard (cold-start fix). **Row-anchoring amendment (D-7/D-8):** V8 outcome checks `row.trailer === games.winner`; V1/V2/V3 are subject to the row's trailer/leader; V2/V3 apply only while the row's trailer still trails 1–9 (fixed the CHI@DAL regression). Fixture harness: 41 passing cases.

### Elite Definition & the One-Consumer-Definition Contract

**Elite (PM-adopted):** hysteresis state machine — ENTER at win% ≥.600 with ≥15 GP, DEMOTE crossing <.550, RE-ENTER at ≥.600. Validated identical to alternatives on current data; hysteresis chosen for stability.

**Contract (KILLER_FLAG_SPEC §7):** ALL consumer-facing surfaces use the hysteresis definition (`elite`/`killer`/`tiers_elite` fields in profile JSONB, "vs elite" prompt copy with the definition supplied to the agent, EK dashboard chip). **def-A tiers (current >.600) are INTERNAL-ONLY** — used for lane inflation computation and frozen honest-gap registration. Never mix the two definitions on any surface.

**Schedule inflation:** infl = vs-rest win% − vs-top win% (internal def-A tiers). Bands: INFLATED ≥ +.30, DEFLATED ≤ −.05. Anchors fixture-pinned: GS +.69, IND +.01, MIN −.11. Matchup-sheet badge renders from this; small-n/bare splits render no badge (never a fake HONEST 0).

**GS re-read:** elite with a super-elite problem — 8-6 vs elite tier (eFGd −0.1) but 0-5 vs MIN/LV at −8.5. Classified DUAL_EDGE.

### Killer Flag (shipped end-to-end Jul 16)

**Definition:** leader_killer = team win% <.450 AND ≥2 scalps vs elite-as-of-EVALUATION-date. Eval-date semantics validated (66%/n=59 vs 50%/n=62 for as-of-game-date).

**Pipeline:** `computeKillerFields` in team-profiles-nightly (separate pure function; fixtures 51/51 including as-of replay) → profile JSONB → fire-site stamp on all SS rows (leader_killer/scalps, ctx-cached, NULL-degrading) → EK chip on wnba-bdl → GAP_BASE back-tagged via `update_ss_killer`.

**Evidence:** within band, <.400 leaders: killer 67% trailer-conversion (62/71 weighting, n=45) vs no-scalp 53% (n=76). Effect concentrated in modest gaps .15–.30 (75% vs 46%). Modest-gap no-scalp spots need ~+117 price — candidate pass rule, ledger-first. The .450 extension is DEAD. **Mechanism:** scalps are two-sided variance events (+3.9 own heat, −3.7 opp cold); live tells, decay, and frequency cuts are all dead. Killer forward stream: 4-0 vs no-scalp 1-2.

**Promotion bar (pre-registered):** killer rows ≥60% at n≥15 → sizing-confidence within tier caps. NEVER tier elevation. Narration flag-mention is gated on promotion (ctx line reverted Jul 16 pending it).

**Killer set (as of Jul 17):** POR(5), LA(3), CHI(2), SEA(2), PHX(2). CON/TOR: never-beats-anyone.

### Override Lane (OVERRIDE_LANE_SPEC.md)

WATCHLIST cap lifts $300 → $600 when the TRAILER is a top team (wp ≥.600) with **negative schedule inflation** (infl <0, ≥5 vs-top games, internal def-A tiers — never tiers_elite). Lane members as of Jul 17: **MIN (−.10) + LV (−.05)** — the second member firing was the build trigger. Nightly digest LANE LINE built & live. Rules: declared-before-entry, max ONE open lane position, lane bets tagged LANE.

### Sizing, Grading & Graduation

**Tiered sizing (Jul 13, amended Jul 15/16):** A-tier up to $1,400 total per position; B-tier up to $600; WATCHLIST up to $300 (override lane: $600). Staged entries grade as ONE position against the tier cap (entry order, price patience, and declined adds all count toward the grade). Bankroll $22K — deliberate under-sizing during graduation.

**Exit rule:** compare breakeven probability (offer ÷ payout) vs honest win probability.

**Graduation bar:** ~25–40 logged clean dual-gate triggers + realized win% within ~5pp of predicted + clean grade ledger → jump to ¼-Kelly (capped 12%, comebackEV output). Graduation watchdog is propose-only.

**Nightly log ritual:** every qualifying spot logged (matchup, timing, leader/trailer + win%, quality gap, deficit, live line/implied, bet Y/N + size, Manny's reasoning, outcome/P&L). Running log: `research/betting_log.md` (newest-on-top). This builds the forward OOS sample.

### Human-in-the-Loop (two streams, never conflate)

Manny bets discretionarily on top of the signal and adds real selection-edge. Measure separately: (1) signal base edge — all qualifying spots; (2) Manny's realized edge — spots he bet. Discretionary alpha = the difference. Mine his bet-vs-pass reasoning over time (e.g., Jul 17: bet SEA@IND at +150, passed ATL@TOR per the price rule — the pass is logged discipline, not a miss).

**Record as of Jul 17:** flagged above-bar positions **6-0, +$4,694 net**; unflagged speculatives 0-2, −$300. All bets on bet365 (book of choice — default for logging). Bet log highlights: row 20 LA@MIN (MIN −135 $500, +$370.37, grades A-/C/A — the C spawned the override lane), row 21 SEA@IND (IND +150 $300, +$450, A/A/A, entered Q3_END down 6-8).

### WNBA Signal-Layer Findings (model context for the engine)

- **XGB reads structure, not wins:** 3/3 structural collapses caught (XGB Q4 min <0.30); 2/2 variance losses were correct structural reads. In BUY territory XGB is the only usable signal (MC pinned <0.30 on 64% of trailing games). XGB extremes actionable (≥0.90, <0.30); the middle adds little.
- **MC Cum = margin-tracker** (96.8% echo rate); value is compound agreement + narrative. Score-state sim dead. Windowed MC killed for WNBA (full 526-game backtest: Cum 0.801 vs Wind 0.787) — "MC wants volume" confirmed both leagues.
- **WNBA XGB mechanics:** native JSON uses l=-1,r=-1 for leaves; base_score is a probability (not logit); w at internal nodes = sum_hessian, at leaves = leaf_weight. XGBoost float32 vs JS float64 → ~0.6% edge-case path differences (expected, not a bug). Windowed biglead correct for WNBA (AUC 0.770→0.798); cumulative biglead correct for NBA.
- **Trajectory features:** NO-GO at 3-min checkpoint resolution (+0.0003 AUC); may work at 60s production resolution or close-game filtered.

### Rigor Principles (govern all SS research)

1. **Provenance over raw n** — tag findings by power AND transfer (backtest vs prod).
1. **No precision in underpowered regions** — cutoffs: HIGH 200+, MED 80–200, LOW <80; below cutoff report ordering only.
1. **OOS validation is the multiplicity defense.**
1. Pre-register promotion/pass rules before the data arrives (killer promotion bar, modest-gap price rule).

-----

## ANALYTICAL FRAMEWORK (NBA stack)

### Five Indicators (I1-I5)

|Indicator                 |Weight|Key Fields                                                                                    |
|--------------------------|------|----------------------------------------------------------------------------------------------|
|I1 Possession & Transition|25%   |turnovers, steals, offensive_rebounds, points_off_turnovers, second_chance_pts, fast_break_pts|
|I2 Rim Pressure & Foul    |25%   |points_in_paint, points_in_paint_att/made, free_throws_att, blocks, personal_fouls, bonus     |
|I3 Shot Quality & Creation|20%   |assists, field_goals_made, effective_fg_pct, three_points_att/made/pct                        |
|I4 Lineup Integrity       |20%   |biggest_lead, bench_points, on_court, per-period pls_min                                      |
|I5 Tempo & Efficiency     |10%   |possessions, pace, offensive_points_per_possession, defensive_points_per_possession           |

Control thresholds: 0.90+ DOMINANT | 0.75-0.89 STRONG | 0.60-0.74 EARNED | 0.45-0.59 NO EDGE | <0.45 WAIT

I1-I5 scores sent control-team-relative to all prompts via `ctrlI` helper (not home-relative). Paint/FTA stats use inline team labels.

**I4 subA:** biggest_lead gap ±4 threshold. subB: live Q4 scoring diff ±2; pre-Q4 uses season Q4 margin prior.

### Conviction Engine (Apr 11)

Combo-pattern-driven from 171 games. DOMINANT = I4+I5 (100%) or 4+ indicators. STRONG = I3+I4 (99%) or I3+I5 (96%). MODEST = 2+ without killer pairs. CONDITIONAL = 1 indicator. NO ENTRY = 0. Danger combos: I1+I5 (50%), I1+I2+I5 (40%), I2+I3+I5 (63%). I4 won = 98% win rate, I4 lost = 0%. `conviction_tier` + `conviction_combo` on alerts + analyses tables.

### Judge/Jury Architecture (v2, Apr 11)

Engine computes I1–I5 + conviction mechanically. Opus receives as ground truth, produces FWP + NARRATIVE + RISK + CLOSING + DISAGREEMENT (flags where it disagrees with mechanical conviction but cannot override). `parseAnalysisText` backward compat. `getFloor()` no longer uses `sonnetIndicators`.

### XGBoost Win Probability (Apr 27, live)

**Model v2 (Apr 30):** Retrained without progress feature — 13 raw-stat features computed control-team-relative. OOF AUC 0.749.

**Features:** paint, pot, to, stl, oreb, ast, blk, fta, efg, biglead, 3pr, rim_pct, runs. All diffs are ctrl-relative. `extractXGBFeatures()` computes from BDL box scores.

**JS TreeSHAP:** `computeXGBContributions()` provides per-feature SHAP values on every checkpoint. Stored in `live_tracking.checkpoints[].shap`.

**XGB Entry Gates (Apr 28):** BUY: Q2<0.40, Q3<0.45, Q4<0.60. BWC/WB: flat <0.40. POSITION_SAFE: <0.50. BWC establishment gated at XGB<0.40.

**XGB EXIT (Apr 28, replaces control-flip EXIT):** `checkXGBExit()` — Q2-Q3 <0.50, Q4 <0.55. 2-poll confirmation (90s), fast-path <0.15, recovery at threshold+0.10. `_xgbBwcProb` computed separately from BWC team's perspective. Backtest: 77.2% exit accuracy vs flip 54.1%.

**XGB Conviction Quality (Apr 30):** Three layers injected into agent context + auto-analysis Opus: (1) Scoreboard — biglead SHAP discriminator (anchored=95% WR, flat=19% loss). (2) Vol/Str basis — VOLATILE={pot,oreb,stl,to,runs}, STRUCTURAL={paint,ast,blk,fta,efg,biglead,3pr,rim_pct}. (3) Trajectory — efg delta/divergence/volatile persistence warnings.

**Windowed XGB (May 6):** 2Q cross-fade window stats from `computeServerWindow`. AUC 0.786 vs cumulative 0.769. Advantage grows with game time (Q4 +0.021). biglead and runs stay cumulative even in windowed model. EXIT threshold flat 0.45.

### Monte Carlo Engine (May 4, live)

**Architecture:** Always-on MC trajectory stored on every snapshot Q2+. Combined canary fires when MC<0.70 OR divergence>0.15. Investigation uses post-trigger box-score diff rates → verdicts → pattern classification. 500 sims for canary/trajectory, 1000 for investigation.

**Canary → Investigation → Verdict → Pattern:** CLEAN (277 games, 77.6% precision) fires Structural Stress ntfy. WAVE (21, 66.7%), NORMALIZED (148, ctrl survives 85%), FALSE_ALARM (437, ctrl survives 86.5%) — NORMALIZED/FALSE_ALARM reset for re-trigger.

**MC Cumulative (May 5):** AUC 0.794 — strongest single NBA signal. When MC Cum and XGB disagree in Q4, MC is right 87%. MC uses cumulative rates (volume for stable estimates); XGB uses windowed (recency) — architecturally correct.

**MC Quarter Accuracy (13,177 checkpoints):** MC>0.70 accuracy Q2=76.3%, Q3=84.7%, Q4=91.9%. Q4 70-80% band perfectly calibrated (off 0.1pp). Brier: Q2=0.2755, Q3=0.2215, Q4=0.1237.

**Trust Hierarchy (in all 3 agent prompts):** Q2: Floor≈XGB>MC. Q3: MC≈XGB>Floor. Q4: MC>XGB>Floor. Signal agreement Q4 (MC≥0.70 + XGB≥0.65 + Floor≥0.65) = 95.9% accuracy (n=2,213).

**Clutch Profiles:** per-team Q4 rates auto-UPSERT at game finalization; feed MC simulation inputs.

**Halftime MC (validated, prompt queued):** Floor>0.70+MC>0.70 ALIGNED=87% ctrl wins; Floor>0.70+MC<0.50 ANCHORING=72%.

**MC Validation (1,235 games):** slow collapses (26+ possessions) 73.2% vs fast (≤12) 62.3%. PATTERN predicts precision, driver type is narrative only. Combined canary cuts silent losses 41% at −0.6% CLEAN precision cost.

### Cross-Fade Window (May 5)

Window >0.65 in Q4 = 98.2% accuracy (n=446) vs floor >0.65 = 89.7% (n=526). Window beats floor Brier every quarter; XGB beats both.

### Throughput (TP) & Lead Safety (LS)

Mechanical gate layer, computed server-side every poll cycle. TP: STRONG RECOVERY → NO PATH. LS: SAFE → CRITICAL. 2PT quality factor: structRate × clamp(team2ptPct/baseline, 0.75, 1.0); NBA baseline 52%, NCAAMB 49%, min 6 fg2a.

**CRITICAL: TP is a veto layer, not a green light.** BLOCK (UNLIKELY/NO PATH) is 95%+ reliable. PASS is only ~25-33%. TP gate REMOVED from BUY/WB/CANDIDATE — agent context only. Known limitation: structRate can't distinguish effort-based hustle from talent-based execution.

### Sustainability Audit

Pre-computed server-side. Personnel (40%), Bayesian Regression (35%), Shot Type Proxy (25%). 5-tier: LOCKED IN → DURABLE → MIXED → FRAGILE → UNSUSTAINABLE. STALLED tier: LOCKED IN downgrades when 2PT% < baseline; blocks WINDOW BUY sust gate. Full `sust_json` on every snapshot; always-on. Volume threat: vtBonus at 34 projected 3PA, VT min gate 15 3PA.

### Synthesizer Decision Tree

BWC path: edge > 0 → BWC; edge ≤ 0 → NO VALUE; `garbageLine` → NO VALUE "line dead"; null edge → DEVELOPING. LS AT RISK/CRITICAL downgrades BWC → WATCH, upgrades NO VALUE → WATCH. TP CONTESTED → WATCH; UNLIKELY/NO PATH → TOO DEEP. Crunch time gate 0.3 min. MIP garbage guard ±50,000 ML.

### Trajectory Signals (T1-T8)

T1 Role Player Heater, T2 Star Process Integrity, T3 Current Period Delta (highest weight), T4 Foul Gate, T5 Interior Trend, T6 Period Assist Ratio, T7 Closing Lineup, T8 Shot Diet Misalignment.

-----

## SERVER POLLING & ALERT SYSTEM (NBA stack)

`poll-live-bdl.mjs` runs every minute via Netlify scheduled function. Per live game: BDL box (primary) + SR summary (supplemental) → I1–I5 (`computeServer()`) → sustainability (both teams) → ESPN WP → TP/LS → XGB + SHAP → MC (Q2+) → MC canary on ctrl-leading tracked games → snapshot to Neon → alert thresholds through reasoning agent → quarter transitions fire calibration snapshots + auto Opus analysis → BWC Death check. WNBA games additionally run the Sweet Spot engine (gates, tier evaluation, ledger writes, narration, verdict-strip state). 2s stagger between league poll loops.

### Alert System (Two-tier)

FIRED alerts pass all mechanical thresholds. CANDIDATE alerts fail a soft gate but might have value. Both route through the alert reasoning agent (Opus, 600 tokens): SEND/SUPPRESS/DOWNGRADE.

**Hard gates (never loosen):** Clock < 1 min, garbage line (±50K ML), period < Q2, "Neither" control team.

**FIRED thresholds:**

|Alert                   |Conditions                                                                                                   |
|------------------------|-------------------------------------------------------------------------------------------------------------|
|BUY                     |floor ≥ 0.65, trailing 1-15, ML > -250                                                                       |
|BWC (Buy Window Closing)|floor ≥ 0.60, leading 2+, edge > 0, ML > -250, LS not AT RISK/CRITICAL, ctrl_sust not FRAGILE+               |
|WINDOW BUY              |floor ≥ 0.45, margin -15 to +5, QTR window ≥ 0.75, sust LOCKED/DURABLE (not STALLED), trailing: TP OR LS gate|

**CANDIDATE types (6):** BUY floor 0.55-0.65, BUY margin 16-20, BUY with TP CONTESTED, BWC with FRAGILE ctrl sust, BWC with ML -250 to -400, WINDOW BUY with MIXED sust.

**Alert dedup:** `alertKey = gameId_alertType_alertTier_Q{period}`. BWC dedup per-type, re-fire 5min OR floor +0.10.

### BUY/PO Decoupled System (Apr 28)

BUY tracks via `lt.buy_position`. Exits via XGB_INVALIDATED only — one-shot per game after BUY SEND if XGB drops below quarter gate. PO graduation fires independently on checkpoint merit. Learning agent classifies BUY + XGB_INVALIDATED arcs as `standalone_buy`.

### BWC Death (May 4)

First poll where control flips away from BWC team → clears all BWC state. Fires TRACKING_INVALIDATED ntfy regardless of graduation state. Sets `lt._is_second_bwc=true` → second BWC team bypasses Q3_6 gate for B-rank graduation. Preserves `lt.mc`, `buy_position`, `halftime_mc` across death.

### Position/Exit System (Apr 21/28)

BUY SEND sets `po_fired={rank:'BUY'}`, activates V2 state machine. EXIT via XGB only. PO upgrades BUY→A/B. FLIP BUY: EXIT + opponent BUY lifts position gate, evaluates as structural reversal. Agent stress override: POSITION_OPEN/BWC_EDGE/POSITION_SAFE MAY SUPPRESS when window significantly weaker than cumulative. BWC_EDGE label "Lead Compressing"; only fires LOCK→EDGE.

### Graduation System (Compound Thresholds, May 8)

Compound thresholds replace S/A/B/C ranks. 5 poll holds at MC ≥ 0.80 + Floor ≥ 0.65. Q2 early confirmation adds lead ≥ 5 + 0 flips (95.5%). Tiers: TRACKING → CONFIRMED (86%) → RECOVERING (73%, 1+ flips) → LOCKED (92%, 10+ holds). Close games plateau at 75%. `classifyRank` kept for NCAAMB. `game_checkpoints` atomic INSERT, catch-up loop, graduation swap on control flip. EXIT compound validated (spec v3, commit `7dde597`).

### Post-Game Learning Agent

`post-game-agent.mjs` — nightly 11:45pm MST. COLLECT (alerts + BDL finals) → BUILD ARCS (by game_id + position_team, sorted by game time; terminal = last non-TRACKING delivered alert) → SCORE (non-EXIT terminal correct if position_team won; EXIT terminal correct if position_team lost) → ANALYZE (Opus per slate) → STORE (`learnings`) → NOTIFY (ntfy). Failure types: left_hanging, premature_exit, wrong_entry, false_recovery, false_dip. **The same nightly run executes the WNBA Sweet Spot resolver sweep + plain-English digest** (ledger status, lane line, watchdog proposals).

### Tier Journey Data (Apr 18)

Close games (≤8, n=476): first fire = 51.1% coin flip. C→A = 81.5%, C→B = 71%. Value window: A@lead5-8 = 93.1%, B@lead1-4 = 82.2%. Zero flips = 73.1%, 1 flip = 37.7%. Wire-to-wire = 98.3%. Full (n=1230): C→A = 95%, 0 flips = 92.8%, 3+ cp = 93%. **POSITION OPEN must wait for graduation, not first BWC fire.**

-----

## WNBA PLATFORM NOTES

### Indicator Backtest (legacy layer — superseded by Sweet Spot for betting)

203-game backtest 88.7%, DOMINANT 99%, I3+I4 99.1%. WNBA weights: I3 Shot Quality 30% (anchor), I4 Game Control 25%, I2 Perimeter+FT 20%, I1 Disruption 15%, I5 Momentum 10%. Paint/rim = noise, TOs inverse. Key findings: I3 anti-inversion (losing I3 = 17.6% win rate vs NBA's 49%); Q4 BUY nearly dead (XGB <0.45 = 2% win rate, only ≥0.70 viable); floor is narrative only in WNBA (wrong 80% vs MC+XGB); MC Q4 underestimates by +8–14pp; trailing band 1–9 (not 1–15); XGB gates Q2/Q3 <0.45, Q4 <0.70.

### WNBA Dashboard

`wnba-bdl.html` (~5,067 lines). Signal strip, WP chart, verdict strip, EK (elite-killer) chip, indicator evidence panels, snapshot history, ESPN live score refresh (10s). Matchup sheet: metrics, schedule-inflation badge (fixed-height badge line both columns), BRIEFING block (expanded by default, awaits narration store on open, age chip per entry) — reachable pregame via always-present micro-strip.

### BDL WNBA Quirks

No `box_scores` endpoint. **`/wnba/v1/player_stats` IS live and is the primary WNBA box-score source**: supports `game_ids[]` batching and `seasons[]`/`player_ids[]` filters, requires cursor pagination, updates live mid-game, returns full per-player box including `pf`, `plus_minus`, `min`. **BDL returns `null` for zero values** — always coerce `Number(x)||0`. Completed games expose final lines only (no historical time-series). No `shooting_play` field on plays (regex fallback at 3 locations). `team_stats` uses `fouls` not `pf`, `turnovers` not `to`, no `pts` field. No x/y coordinates on plays. No lineups endpoint — `starter` flags structurally absent (bench/foul-trouble logic falls back to minutes).

BDL abbreviations differ from SR: LVA→LV, NYL→NY, GSV→GS, WAS→WSH, LAS→LA, PDX→POR, TOY→TOR. **CRITICAL:** `cfg.aliasMap` must ONLY apply at `parseBDLPBPServer` for WNBA — NBA BDL plays use same abbreviations as SR. Applying aliasMap globally breaks NBA PBP parsing.

BDL WNBA date boundary: late-ET games land on next UTC day; `bdlGameData` fetches both dates. WNBA does not populate season_cache (no `/wnba/v1/season_averages` endpoint) — Sweet Spot carrier baselines use lazy per-player `/player_stats` fetches.

### WNBA Remaining Gaps

- `pregame-agent.mjs` hardcoded to NBA (~line 1030); WNBA pregame briefs run through the Sweet Spot GAME_BRIEF path instead (see `WNBA_PREGAME_AGENT_SPEC.md`)
- `generate-thesis.mjs` has no WNBA support
- ESPN ID mid-game fallback (SR retry works pre-tip only)
- Killer split in `ss_ledger_summary` (n≥8/cell) not yet built — summary groups by subtype only

-----

## KEY DATA PIPELINES

### Season Cache

`season_cache` table stores weekly BDL player averages (NBA per-player, NCAAMB batch). Poll reads cache-first, fetches stale (>7 days) teams. Client syncs via `syncSeasonCacheFromDB()`, merges via `mergeBdlSeasonPriors()`.

### Team Profiles Nightly (WNBA)

`team-profiles-nightly.mjs` (nightly, job-locked): ingests per-game team lines into `team_game_stats`, recomputes all league-season profiles in memory, UPSERTs `team_profiles`. Profile JSONB carries splits, archetypes, schedule inflation, consumer elite/killer/tiers_elite fields, and internal def-A tiers. `computeKillerFields` is a separate pure function with a golden-fixture harness (`research/team_profiles_fixtures.mjs` — ATL golden + as-of replay, 51/51). Consumed by: SS fire-site killer stamp (ctx-cached), agent prompt copy, EK chip, matchup sheet, override lane.

### Quarter Data

`quarter_data` JSONB on games table. Server captures boundary stats at quarter transitions, computes diffs. Cross-fade rolling window activates Q2+. QD hydration must be ABOVE `gapLog` guard. Poll BDL date uses `getSlateDate(dateOffset)` not `(0)`. Live partial quarter row: client diffs current box minus last boundary, renders Q(n+1)* in amber. Boundaries on `cs._serverQuarterBoundaries`.

### Sustainability

Server saves full `sust_json` to every snapshot. Fallback chain: baselines → `computeSustainabilityDirect()` → stored audit → parsed prediction text. Always-on.

### getFloor() Fallback Chain

`sonnetIndicators` → `clientInd` → `_serverFloor` → `rollingWindow`

-----

## RESEARCH FINDINGS (validated, stable)

### Research Ruled Out — NBA stack

- **Bayesian recency weighting** (+0.0 AUC — cumulative floor improves Q1→Q4)
- **Change-point detection** (CUSUM/sliding window/BOCPD all at chance — floor already IS a change-point detector)
- **Holly auto-tuning** (adaptive weights HURT by −0.02 AUC, overfits)
- **SHAP delta model** (raw vol_concentration + biglead SHAP outperform any second model — agent context, not a model)
- **Opponent rising canary** (mathematically coupled to ctrl collapse canary — zero timing gain)
- **EXIT confirmation via MC** (MC doesn't discriminate; XGB EXIT already well-calibrated)
- **Conformal prediction** (XGB distance from 0.50 already captures confidence)
- **Production indicator weights** near-optimal (global opt only +0.01 AUC)
- **Position monitoring as separate alert layer** (85% of confirmed positions never dip below MC 0.90)

### Research Ruled Out — WNBA Sweet Spot

- **eFG-heat as operative signal** (NBA deficit-controlled null n=1,200; WNBA artifact)
- **Structural underdog (#10)** (1-for-7 Q3_END, dead across all variants)
- **Failure-profile 72%/44%** (margin-unconditioned; superseded)
- **Windowed MC for WNBA** (526-game backtest: Cum 0.801 > Wind 0.787)
- **Killer .450 extension, killer live-tells/decay/frequency cuts** (all dead — mechanism is two-sided variance)
- **Trajectory features at 3-min resolution** (+0.0003 AUC; may revisit at 60s production resolution)

### Key Architecture Decisions

- **Transition Alerts (Apr 29) will NOT be built** — trust the validated state machine (1,235 games). Parallel non-state-tracking alerts create cascade risk.
- **MC cumulative / XGB windowed** — MC wants volume, XGB wants recency. Confirmed both leagues.
- **NBA signal roles (May 6):** Windowed XGB for early EXIT (100% recall on 10 playoff losses at 0.45). MC Cum for EXIT confirmation gate. PBP MC for investigation trigger only. Floor for narrative.
- **WNBA signal roles (May 18):** XGB reads structure not wins; XGB extremes actionable, middle adds little; MC leads production AUC (0.748 vs 0.668) but pins <0.30 on trailing games, so XGB is the only usable signal in BUY territory.
- **Sweet Spot ledger-first governance:** new dimensions (killer, price rules, lane) enter as logged ledger streams with pre-registered promotion bars — never direct tier changes.

-----

## KEY LEARNINGS & PRINCIPLES

### Structural Analysis

- BLOCK signal is 95%+ reliable for vetoing entries; PASS is only 25–33% reliable for sizing confidence
- `structRate` cannot distinguish effort-based production from talent-based production
- Sustainability baseline regression: teams with no shooters never regress up
- C&S 3PT scheme production is structural offense, not variance — the framework had a paint-dominance bias
- **Cumulative floor anchors stale early-game data into late-game reads — biggest known NBA accuracy failure mode.** Floor is anti-predictive in lead-change games (AUC 0.329).
- Fix the data, not the machine — clean signals into the existing agent rather than restructuring the state machine
- The agent is not just a gate — it's a narrator that builds game context for all downstream alerts. Never bypass it.
- **The quality gap alone is not the sweet spot** — always run the whose-variance check. A quality gap where the TRAILER is the variance team is a siren (POR@CHI Jun 24).

### Alert/Position Design

- POSITION OPEN must wait for graduation, not first BWC fire
- TP gate removed from BUY/WB/CANDIDATE — agent context only
- Alert cascade is the biggest UX problem — suppress correctly
- Alert bodies must lead with action, explain why, translate all jargon
- Betting journal approach replaces CLV tracking
- Staged entries are ONE position; discipline (passes on price, declined adds) is logged and graded, not just wins

### Team-Specific

- **OKC** defense is system-driven, not star-dependent
- Post-deadline integration risk: discount season TO rates for teams with new ball-handlers < 4 weeks
- Live TO gate: 5+ above season avg by mid-Q3 = structural edge compromised
- Defensive disruption escalation: opponent top-7 steals + volatile ball-handlers = elevated chaos risk
- Clutch execution gate: weak clutch net rating downgrades lead-protection conviction
- **WNBA (Jul 17):** GS = elite with super-elite problem (DUAL_EDGE); killer set POR/LA/CHI/SEA/PHX; CON/TOR never-beats-anyone; MIN + LV = deflated top teams (override lane)

### Engineering Patterns

- Quarter data hydration must be ABOVE gapLog guard
- Poll BDL date uses `getSlateDate(dateOffset)` not `(0)`
- `getFloor()` fallback chain: `sonnetIndicators` → `clientInd` → `_serverFloor` → `rollingWindow`
- Anthropic API credits exhausting causes auto-analyses to fail silently
- Netlify serverless: missing `await` kills unawaited promises; emojis in HTTP headers crash Node
- Server is sole `game_context` writer (DO UPDATE not DO NOTHING)
- BDL stats are strings — wrap all math in `Number()`
- `let`/`const` at line ~10,000 causes TDZ when referenced earlier — use `var` for globals
- Netlify bundles each function separately — no cross-function `require`
- Any `await` >1 second creates a concurrent invocation race window requiring a DB lock row
- Never add new columns to existing SELECTs on critical polling paths — always fetch in separate isolated queries (this is why `get_ss_state` is three isolated queries)
- After scoping fixes, audit all log lines in the same block for the same variable-name pattern
- Pure-function extraction + golden fixtures for anything with definitional semantics (computeKillerFields, ssVerdictCompose, digest copy) — fixtures are the regression net

-----

## COLLABORATION & WORKFLOW

### Roles

Manny is PM, product owner, sole bettor, and domain expert. Claude is lead engineer, UI/UX designer, and co-pilot with high autonomy on implementation once PM decisions are aligned. Manny drives product direction, betting framework, and analytical methodology. Claude writes and ships code, proposes experiments, and asks "what about X?"

Manny describes this to others as: "I designed the framework and product direction, but I build it collaboratively with Claude. I describe what I want, we architect it together, Claude writes the code, I test and deploy."

### Collaboration Tone

Relaxed, joking dynamic — not a military briefing. Manny thinks in frameworks, not features. He pressure-tests architecture, catches logical errors in production, and values directness and honest pushback. When he says "you're grasping at straws," stop the current line of reasoning and go back to the data. Manny refers to Claude as "son."

### CRITICAL WORKFLOW RULE

**Never implement code changes without explicit confirmation from Manny.** Questions are questions, not directives — answer, then wait. Spec proposals are fine to share proactively, but code requires explicit go-ahead. Violating this breaks trust.

### PRESENTATION RULE (Jul 15)

**Always present full spec contents in chat when creating or amending a spec — never just commit and reference a filename.** Manny runs DFT from his phone; making him open the repo is exactly the back-and-forth this rule kills.

### Co-Pilot Mode (May 2)

Manny explicitly asked Claude to be inquisitive — don't just answer questions, propose experiments and ask "what about X?" "The insights come from me and are constrained by how creative I can think." Be a co-pilot, not just an executor. This led to the MC oscillation discovery, the killer mechanism finding, and the override lane.

### Architectural Advisory (May 11)

Before building any substantial feature, Claude proactively surfaces the architectural decision: "this is N functions and ~X lines — own module or inline? Here are the tradeoffs." Manny makes the prioritization call with full technical information. Architecture improves alongside feature work, not as separate refactoring sprints.

### Testing Ownership (May 11)

Claude owns operationalizing unit and integration testing. When launching new features, include a test plan as part of the spec. Fixture harnesses are the standing pattern: verdict strip (41 cases), computeKillerFields (51/51 incl. as-of replay), override lane (35/35), digest copy (pinned fixtures). The aliasMap regression is the canonical example of what tests would have caught.

### Backlog Management (May 11)

This doc describes the system as it exists — shipped features and decisions. Active backlog, queued items, and in-progress research live in Claude's memories. When backlog items persist across sessions without being worked, Claude asks "still want this or should we kill it?" Manny owns prioritization. Items move from memory into this doc only when they ship.

### Architecture-First Development

Manny's standing instruction for any non-trivial change: **"Architect/spec required changes meticulously, trace cascading implications and identify mitigation options. Identify dead code to be cleaned up if needed. I don't want to introduce any bugs when we move to implementation."**

1. Map every code path that touches the change
1. Identify all consumers of modified functions/data
1. Trace 1st, 2nd, and 3rd order effects
1. Flag dead code for cleanup
1. Present the full spec with cascading implications before building

### Thinking Level

Always operate as a senior solution architect / engineering manager. Before ANY solution: map full system topology, trace all cascading implications (state machines, agent context, learning agent, subscriber UX, betting value). Never jump to code — exhaust the strategic design space first.

### Diagnostic Methodology — MANDATORY before any fix

1. **PULL THE DATA FIRST.** Snapshots, alerts, analyses, quarter data, raw stats, odds movement. Direct DB access.
1. **LOOK FROM MULTIPLE PERSPECTIVES.** Server mechanical, server Opus, client, market, final outcome. When these disagree, the disagreement IS the diagnosis.
1. **IDENTIFY THE EXACT DIVERGENCE.** Which value, which component, which time.
1. **HYPOTHESIS, NOT CONCLUSION.** Name the suspected root cause, trace the code path, verify with data.
1. **PROPOSE THE FIX ONLY AFTER DIAGNOSIS.**

Hit the endpoint first, get the real error. Never add diagnostic logging and theorize.

### Research Methodology (May 2)

1. **Hypothesis first.** 2. **Pull backtest data** via endpoint. 3. **Run analysis scripts** in the sandbox. 4. **Validate against known games.** 5. **Commit findings** to `research/` with date prefix. 6. **Write deployment spec** only after validation. 7. **Only then implement.** Research ≠ deployment. Spec first, code after confirmation. Pre-register promotion/pass rules before forward data arrives.

### Data Pulling Discipline

Always read source code / project knowledge BEFORE writing pull scripts. Guessing field names wastes time chasing phantom missing data. Key patterns: `get_alerts→{alerts}`, `get_games→{games}`, `history→{snapshots}`, `get_sweetspot_alerts→{sweetspot_alerts}`; always `&league=wnba`; WNBA uses `id` (UUID) not `game_id`.

### Session Startup Protocol

1. Clone repo to `/home/claude/dft`; git config
1. `wc -l` key files (poll-live-bdl.mjs, db-api.js, post-game-agent.mjs, wnba-bdl.html, team-profiles-nightly.mjs)
1. `git log --oneline -10`
1. Verify live poll state; pull recent SS alerts, ledger summary, bets, learnings
1. Search recent chats for continuity
1. Read relevant source files before touching anything

This prevents the "phantom completion" bug. File line counts are ground truth for detecting state drift.

### Presentation Preferences

- **URLs and scripts:** code blocks for one-tap copy on mobile.
- **Specs:** full contents in chat (presentation rule above).
- **Implementation:** chunked, file-by-file with status table. One command at a time during live testing.
- **Bet slips:** bet365 is the book of choice — default for bet logging. Recognize the bet365 slip UI in screenshots (dark slate card, mint-green header/settled banner, Money Line selection rows, Wager/To Return footer, Cash Out button on live slips).

### Known Blindspots (self-correcting)

1. **Prompt text gets less rigor than code** — numbers in template literals are functional constants. Grep old values, verify all replaced.
1. **Additive bias** — adds new content well but under-audits existing content needing updates.
1. **When tempted to simplify vs spec, re-read WHY the spec specified the harder option.**
1. **Jumps to pull scripts with guessed field names** — read source first.

-----

## DIRECT ACCESS WORKFLOW (Apr 25)

Claude's sandbox reaches both the Netlify site and Neon DB host directly.

### What Claude Can Do Directly

- **Pull live data:** `curl -s -u manny:DFT2025! "https://poetic-starlight-aa8938.netlify.app/.netlify/functions/db-api?action=..."`
- **Run schema migrations:** `?action=init`
- **Rerun learning agent:** `?action=delete_learning&date=...` then `/post-game-agent?date=...`
- **Validate fixes end-to-end:** push → deploy → hit endpoints → verify
- **Hit poll endpoint directly:** `/.netlify/functions/poll-live-bdl` (`?diag=1&diag_step=N` DIAG MODE: steps 0–4 pass, 5=XGB, 6=sust)

Console scripts are still needed only for authenticated dashboard context (client cardState, localStorage, DOM).

### Key db-api Endpoints

`get_alerts` (limit, date, type), `get_games` (date), `get_learnings`, `get_poll_state`, `get_poll_history`, `get_latest_snapshots` (game_ids — plural), `get_live_tracking`, `get_calibration`, `get_odds`, `snapshot_diagnostic`, `get_checkpoints`, `get_clutch_profiles`, `history` (game_id — all snapshots with raw_stats_json), `init`, `delete_learning`.

**Sweet Spot:** `get_sweetspot_alerts`, `ss_ledger_summary`, `get_ss_state` (game_id), `log_bet`, `get_bets`, `update_bet`, `update_ss_killer`, `get_team_profiles` (league, season, team).

**League parameterization:** always pass `&league=wnba` for WNBA. Default is NBA. Forgetting this returns empty results and leads to wrong conclusions.

**Backtest endpoints:** `backtest-nba-snapshots?phase=...` (incl. `export_xgb`); `mc-backtest?phase=...` (12+ phases; `backfill_mc_pbp` supports from/to/batch/offset/dry/sims, `batch=2` safe ceiling); `backtest-wnba` for the 524-game WNBA historical sample.

### DNS Workaround

When curl returns "DNS cache overflow," switch to `python3 urllib.request`. Save results to `/tmp/*.json` before parsing.

### Live Game Collaboration

Manny chats during a live slate; Claude pulls real-time data to confirm what he's seeing — snapshots, agent decisions, verdict-strip state, SS rows, latest learnings, post-game arc audits — all direct, no console round-trips.

-----

## MEMORY MANAGEMENT STRATEGY

Claude's memory system has a 30-slot limit. Memories are for **dynamic, frequently-changing information** — not stable architecture facts.

### What Belongs in Project Knowledge (this doc)

Shipped architecture decisions; framework principles and validated learnings; API keys and operational config; alert thresholds and engine rules; team-specific insights; ruled-out research; workflow rules; data source details and schema.

### What Belongs in Memories

Active work items; queued items; active research threads (removed when concluded); recent changes not yet migrated here; behavioral directives needing reinforcement.

### Maintenance Process

When memories approach the limit: audit against this doc, remove duplicates, migrate stable info here, keep memories focused on dynamic/recent/behavioral items. This doc updates after major architectural changes or natural breakpoints; Manny uploads the updated version to the Claude project settings. **A copy also lives at repo root (`PROJECT_KNOWLEDGE.md`) and should be committed with each version bump so repo and project settings never drift.**

-----

## V3 DASHBOARD (Apr 22)

~3,983 lines. Mobile-first single-card swipe interface. Demo mode (POR@DEN/GSW@SAC/MIA@CHA presets). Toast with live line shopping (The Odds API, 20+ books), scoped to viewed game. ⚡ Analyze button. 10s client poll. ESPN/XGB toggle on WP chart. XGB column in snapshot history. MC Cum signal row + drivers + snapshot column. Collapsible MC investigation strip. Confidence table. 30-team color map. Shot zones. Indicator evidence panels. Margin flow with shot markers.

-----

## DEBUG DASHBOARD

`debug.html` — 7 sections: DB & Data; Calibration; Analytics; Game Inspector; QA Suite (13 league-aware checks); Alert Accuracy; Nightly Learnings.

-----

## ALERT ACCURACY BASELINE (Apr 6-7, 15 games)

43/71 overall (61%). BUY 75%, BWC 71%, WINDOW BUY 67%, RECOVERY PATH 63%, LEAN BUY 17% (killed). 89% of wrong alerts came from blowout games where the floor was fundamentally wrong. 64% required TP passing as prerequisite. LS SAFE holds 94%, CRITICAL erodes 72%.

-----

## HOTFIX LEARNINGS (permanent — never repeat)

1. BDL clock `"Q4 8:03"` format — strip prefix via regex before `parseInt`
1. Node `fetch` requires ASCII-only headers — no emoji in HTTP `Title` header
1. Netlify kills unawaited promises — always `await` `sendNtfy` and similar calls
1. `.catch(() => {})` silently swallows errors — always log
1. BDL stats are strings — wrap all math in `Number()`
1. `let`/`const` at line ~10,000 causes TDZ when referenced at line ~1,800 — use `var` for globals
1. Netlify bundles each function separately — can't `require('./analyze.js')` from poll function
1. Netlify password protection returns 401 on internal HTTP calls — embed Anthropic calls directly
1. `BDL game.period = 0` during live games — extract period from `game.time` string
1. `_headers` file `/*` pattern blocks cron functions — scope to `/*.html` only
1. Concurrent Netlify invocations create race conditions — use DB lock rows (PENDING sentinel) before any await >1s
