# Deepfuckingthesis — Project Knowledge

**Version:** 5.0
**Last updated:** May 11, 2026
**Live URL:** https://poetic-starlight-aa8938.netlify.app
**GitHub:** MannyBanda/Deepfuckingthesis (private)

-----

## WHAT THIS IS

A multi-league live betting intelligence platform that combines real-time game data (Sportradar, BallDontLie, ESPN), server-side polling with autonomous alert generation, Claude Opus-powered structural analysis, and agentic reasoning layers to identify structural betting edges. The core strategy: buy the structurally dominant team when they're trailing due to unsustainable opponent variance.

**The server is the primary analytical engine.** The dashboard exists for deep inspection, but the system is designed for dashboard-free game monitoring via ntfy push alerts (topic: `manny_nba_control`). Alert bodies must be plain English: lead with action, explain structural edge, translate jargon, include what to watch for.

-----

## ARCHITECTURE

```
Client:
  bdl.html (~12,340 lines)         — NBA client dashboard (MUST always be named exactly this)
  v3.html (~3,983 lines)           — V3 NBA dashboard (active development)
  wnba-bdl.html (~3,925 lines)     — WNBA client dashboard (deployed May 9)
  ncaamb-bdl.html (~9,846 lines)   — NCAAMB client dashboard
  debug.html (~3,295 lines)        — Diagnostic dashboard (7 sections)

Server (netlify/functions/):
  poll-live-bdl.mjs (~8,692 lines) — Server polling, mechanical alerts, XGB, MC, Opus analysis, alert reasoning agent
  db-api.js (~2,727 lines)         — Database API (Neon Postgres)
  mc-backtest.mjs (~5,647 lines)   — Monte Carlo backtest harness (12+ phases)
  analyze.js (~1,047 lines)        — Client Opus analysis endpoint
  pregame-agent.mjs (~1,323 lines) — Pre-game thesis generation (cron */5 min)
  post-game-agent.mjs (~719 lines) — Nightly post-game learning agent (cron 11:45pm MST)
  backtest-nba-snapshots.mjs (~8,891 lines) — NBA checkpoint backtest harness
  sr-data.js                       — Sportradar API proxy
  bdl-data.js                      — BallDontLie API proxy
  bdl-enrich.js                    — BDL enrichment (clutch, odds, tracking)
  bdl-pbp-adapter.js               — BDL play-by-play adapter
  espn-data.js                     — ESPN data proxy
  odds-api.js                      — The Odds API proxy (line shopping)
  generate-thesis.mjs              — Opus thesis generation
  clutch-ocr.js                    — Opus vision OCR for clutch screenshots
  xgb-replay.js                    — XGB retroactive replay on prod snapshots
  test-agent.js                    — Alert reasoning agent smoke test
  test-v2-engine.mjs               — V2 state machine test harness

Config:
  netlify.toml                     — Build config, function timeouts
  research/                        — Validated research findings (*.md, *.py)
  *_SPEC.md                        — Deployment specs at repo root
```

### Multi-League Architecture

**Single app, league-parameterized.** One set of Netlify functions, league passed as a parameter. NOT separate deployments. The `LEAGUE` config object in poll-live-bdl.mjs holds per-league settings: SR base URLs, BDL prefixes, period types (quarter vs half), game rules (foul limits, shot clock), feature flags, thresholds.

**Priority order:** NBA (fully operational) → WNBA (deployed May 9, live) → NCAAMB (March Madness sprint).

### CI/CD Pipeline

1. Claude clones repo to `/home/claude/dft` at session start
1. Runs `git config user.name "MannyBanda" && git config user.email "manny@dft.dev"`
1. Verifies actual file state (`wc -l` key files, `git log --oneline -10`, grep) before proceeding — never assumes prior session's changes are deployed
1. Searches recent chat history for continuity on active work
1. Reads relevant source files to understand available endpoints and data structures
1. Edits files, syntax checks with `node -c` (for HTML: `sed -n '/<script>/,/<\/script>/p' file.html | sed '1d;$d' > /tmp/check.js && node -c /tmp/check.js`)
1. Multi-file sessions: stages all modified files together in a single descriptive commit
1. Pushes directly to GitHub via PAT
1. Netlify auto-deploys from GitHub on push (~50 seconds)
1. Manny confirms deployment; Claude should communicate findings explicitly so Manny knows deployment state

### Infrastructure

- **Netlify Pro** (not free — never hedge about this). Basic Auth via `_headers` file (replaced JWT Apr 23 — no 1hr timeout). Internal Netlify-to-Netlify calls return 401 — use direct Anthropic API calls from poll function, not internal HTTP.
- **Neon Postgres** via Netlify DB. Schema migrations use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. Run `?action=init` after adding new columns.
- **GitHub auto-deploys** on push to main.

-----

## ENVIRONMENT & ACCESS

### API Keys

|Service  |Key                                       |Env Var            |Notes                      |
|---------|------------------------------------------|-------------------|---------------------------|
|BDL      |`[REDACTED]`    |`BDL_API_KEY`      |GOAT tier, all leagues     |
|SR NBA   |`[REDACTED]`|`SR_API_KEY`       |trial/v8, 1 req/sec        |
|SR NCAAMB|`[REDACTED]`|`SR_NCAAMB_KEY`    |trial/v8, separate from NBA|
|SR WNBA  |`[REDACTED]`|`SR_WNBA_KEY`      |replaced May 10 after rate limit|
|Anthropic|—                                         |`ANTHROPIC_API_KEY`|Opus calls                 |

Other Netlify env vars: `DATABASE_URL`, `NTFY_TOPIC` (manny_nba_control), `ODDS_API_KEY` (The Odds API paid plan, 20K credits/month).

### GitHub PAT

`[REDACTED — see Claude project settings]` (fine-grained, repo-scoped, expires ~Jul 2026). Git config: user MannyBanda, remote uses x-access-token auth. Clone to `/home/claude/dft`, pull –rebase before push.

### Claude Sandbox Network Access

Both `poetic-starlight-aa8938.netlify.app` and `ep-divine-moon-am705tkz-pooler.c-5.us-east-1.aws.neon.tech` are in the network allowlist. Claude can directly hit all db-api endpoints via curl. See **Direct Access Workflow** below. Direct TCP to Neon on port 5432 is blocked — HTTP only via db-api layer.

### Database Tables

**`alerts`** — i1-i5, conviction_tier/combo, alert_tier, agent_decision/reasoning, ntfy_sent, bwc_state, erosion_level, peak_floor, exit_severity, graduation_rank, mf_trajectory, combined_read, cp_eligible_count, cp_ctrl_flips, lane, position_closed, is_flip_buy, cp_mean_floor, `position_team` (BWC team for EXIT, control_team for all others), xgb_win_prob, xgb_aligned.

**`games`** — live_tracking JSONB (BWC state machine persistence, checkpoint data, MC state, buy_position).

**`snapshots`** — raw_stats_json, tp/ls columns, sust_json, xgb_win_prob, xgb_divergence, mc_win_prob (always-on Q2+), mc_cum_win_prob.

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

- **Model:** `claude-opus-4-6` (Opus 4.6)
- **Used by:** analyze.js (client analysis), poll-live-bdl.mjs (server auto-analysis + alert agent), post-game-agent.mjs (nightly learning), clutch-ocr.js (screenshot OCR), pregame-agent.mjs (thesis generation)

-----

## ANALYTICAL FRAMEWORK

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

**Model v2 (Apr 30):** Retrained without progress feature — 13 raw-stat features computed control-team-relative. 300 trees, 394KB at `netlify/functions/xgb-model.json`. OOF AUC 0.749.

**Features:** paint, pot, to, stl, oreb, ast, blk, fta, efg, biglead, 3pr, rim_pct, runs. All diffs are ctrl-relative. `extractXGBFeatures()` computes from BDL box scores.

**JS TreeSHAP:** `computeXGBContributions()` provides per-feature SHAP values on every checkpoint. Stored in `live_tracking.checkpoints[].shap`.

**XGB Entry Gates (enabled Apr 28):** BUY: Q2<0.40, Q3<0.45, Q4<0.60. BWC/WB: flat <0.40. POSITION_SAFE: <0.50. BWC establishment gated at XGB<0.40.

**XGB EXIT (Apr 28, replaces control-flip EXIT):** `checkXGBExit()` — Q2-Q3 <0.50, Q4 <0.55. 2-poll confirmation (90s), fast-path <0.15, recovery at threshold+0.10. `_xgbBwcProb` computed separately from BWC team's perspective. Backtest: 77.2% exit accuracy vs flip 54.1%.

**XGB Conviction Quality (Apr 30):** Three layers injected into agent context + auto-analysis Opus: (1) Scoreboard — biglead SHAP discriminator (anchored=95% WR, flat=19% loss). (2) Vol/Str basis — VOLATILE={pot,oreb,stl,to,runs}, STRUCTURAL={paint,ast,blk,fta,efg,biglead,3pr,rim_pct}. (3) Trajectory — efg delta/divergence/volatile persistence warnings. `formatSonnetPrompt` sees XGB+SHAP+conviction+trajectory.

**Windowed XGB (deployed May 6):** `extractXGBFeatures` uses 2Q cross-fade window stats from `computeServerWindow`. Retrained model 220KB, AUC 0.786 vs cumulative 0.769. Advantage grows with game time (Q4 +0.021). biglead and runs stay cumulative even in windowed model. EXIT threshold flat 0.45 (minimizes total damage in windowed backtest).

### Monte Carlo Engine (May 4, live — replaces VULNERABILITY)

**Architecture:** Always-on MC trajectory stored on every snapshot Q2+. Combined canary fires when MC<0.70 OR divergence>0.15. Investigation uses post-trigger box-score diff rates → verdicts → pattern classification. 7 core functions in `poll-live-bdl.mjs`. 500 sims for canary/trajectory, 1000 sims for investigation.

**Canary → Investigation → Verdict → Pattern:**

1. **Canary** fires on ctrl-leading games Q2+ when combined threshold met
1. **Investigation** computes post-trigger rates from box-score diffs
1. **Verdicts:** CONFIRMED, LIKELY, CONTESTED, NORMALIZED → mapped to patterns
1. **Patterns:** CLEAN (277 games, 77.6% precision), WAVE (21, 66.7%), NORMALIZED (148, ctrl survives 85%), FALSE_ALARM (437, ctrl survives 86.5%)
1. **CLEAN fires Structural Stress ntfy.** NORMALIZED/FALSE_ALARM reset for re-trigger.

**MC Cumulative (validated May 5):** AUC 0.794 — strongest single signal in DFT. Beats XGB and floor in every quarter. When MC Cum and XGB disagree in Q4, MC is right 87% of the time. MC uses cumulative rates (not windowed) because more data = more stable rate estimates for forward projection. This is architecturally correct: XGB wants recency, MC wants volume.

**MC Quarter Accuracy (13,177 checkpoints):** MC>0.70 accuracy: Q2=76.3%, Q3=84.7%, Q4=91.9%. MC 70-80% calibration: Q2 off by 10pp, Q3 off by 2pp, Q4 off by 0.1pp (perfectly calibrated). Brier: Q2=0.2755, Q3=0.2215, Q4=0.1237.

**Trust Hierarchy (shipped to all 3 agent prompts):** Q2: Floor≈XGB>MC. Q3: MC≈XGB>Floor. Q4: MC>XGB>Floor. MC vs floor disagreement in Q4: MC right 82.1%.

**Signal Agreement (Q4):** All 3 high (MC≥0.70 + XGB≥0.65 + Floor≥0.65) = 95.9% accuracy (n=2,213).

**Clutch Profiles:** `clutch_profiles` table — per-team Q4 rates auto-UPSERT at game finalization. Used by MC engine for team-specific simulation inputs.

**Halftime MC (validated, prompt queued):** Floor>0.70+MC>0.70 ALIGNED=87% ctrl wins. Floor>0.70+MC<0.50 ANCHORING=72%. 15-point spread is the validated value. Data already stored at `mc_win_prob` on Q2_END snapshot — just needs prompt wiring.

**MC Validation (1,235 games):** Speed: slow collapses (26+ possessions) = 73.2% vs fast (≤12) = 62.3% — sustained collapses more reliable. Driver type (VOLATILE/STRUCTURAL/MIXED) doesn't predict precision — PATTERN does. Driver useful for narrative only. Combined canary cuts silent losses 41% (118→70) at only -0.6% CLEAN precision cost. Remaining 58 silent losses are blowout reversals where floor anchors at 0.90+ preventing canary divergence.

### Cross-Fade Window (validated May 5)

Window >0.65 in Q4 = 98.2% accuracy (n=446) vs floor >0.65 = 89.7% (n=526). Window beats floor Brier every quarter. XGB beats both Brier every quarter. Window is tighter/more selective — says >0.65 less often but almost never wrong when it does.

### Throughput (TP) & Lead Safety (LS)

Mechanical gate layer. Computed server-side every poll cycle.

- **TP** projects whether a trailing team can close a deficit given structural edge + remaining possessions. Classifications: STRONG RECOVERY, PROBABLE, CONTESTED, UNLIKELY, NO PATH.
- **LS** projects whether a leading team's margin is sustainable. Classifications: SAFE, CUSHIONED, AT RISK, CRITICAL.
- **2PT quality factor:** structRate × clamp(team2ptPct/baseline, 0.75, 1.0) — applies to both teams before VT bonus. NBA baseline 52%, NCAAMB 49%, min 6 fg2a.

**CRITICAL: TP is a veto layer, not a green light.** BLOCK (UNLIKELY/NO PATH) is 95%+ reliable. PASS is only ~25-33% — don't use for sizing confidence. TP gate REMOVED from BUY/WB/CANDIDATE — TP fed to agent as context only, not a veto.

**Known TP limitation:** structRate formula (paint+FTM+POT+SCP)/poss gives same score to effort-based hustle (tanking team) and talent-based execution (playoff team). Needs quality-of-possession adjustment.

### Sustainability Audit

Pre-computed server-side. Three dimensions: Personnel (40%), Bayesian Regression (35%), Shot Type Proxy (25%).

**5-tier output:** LOCKED IN → DURABLE → MIXED → FRAGILE → UNSUSTAINABLE

**STALLED tier:** LOCKED IN downgrades to STALLED when 2PT% < baseline. Blue UI. Blocks WINDOW BUY sust gate. Perimeter production is real but paint/FT engine may be compromised.

Server saves full `sust_json` to every snapshot. Fallback chain: baselines → `computeSustainabilityDirect()` → stored audit → parsed prediction text. Always-on — never skip.

**Volume threat:** vtBonus adjusts structRate in swing core so TP/LS naturally downgrades against perimeter schemes. Threshold: 34 projected 3PA. VT min gate: 15 3PA.

### Synthesizer Decision Tree

BWC path: edge > 0 → BWC; edge ≤ 0 → NO VALUE; `garbageLine` → NO VALUE "line dead"; null edge → DEVELOPING. Lead safety: AT RISK/CRITICAL downgrades BWC → WATCH, upgrades NO VALUE → WATCH. Throughput: CONTESTED → WATCH; UNLIKELY/NO PATH → TOO DEEP. Crunch time gate: 0.3 min (not 2.0). MIP garbage guard: ±50,000 ML.

### Trajectory Signals (T1-T8)

T1 Role Player Heater, T2 Star Process Integrity, T3 Current Period Delta (highest weight), T4 Foul Gate, T5 Interior Trend, T6 Period Assist Ratio, T7 Closing Lineup, T8 Shot Diet Misalignment.

-----

## SERVER POLLING & ALERT SYSTEM

`poll-live-bdl.mjs` runs every minute via Netlify scheduled function. For each live game:

1. Fetch BDL box score (primary) + SR game summary (supplemental)
1. Compute I1–I5 indicators server-side (`computeServer()`)
1. Compute sustainability audit (both teams)
1. Fetch ESPN Win Probability
1. Compute TP (throughput) and LS (lead safety)
1. Compute XGB win probability + SHAP contributions
1. Compute MC win probability (always-on Q2+)
1. Run MC canary check on ctrl-leading tracked games
1. Save snapshot to Neon Postgres
1. Check alert thresholds → route through alert reasoning agent
1. Detect quarter transitions → fire calibration snapshots + auto Opus analysis
1. Check BWC Death (control flip away from tracked team)

### Alert System (Two-tier)

FIRED alerts pass all mechanical thresholds. CANDIDATE alerts fail a soft gate but might have value. Both route through the alert reasoning agent (Opus 4.6, 600 tokens) which returns SEND/SUPPRESS/DOWNGRADE.

**Hard gates (never loosen):** Clock < 1 min, garbage line (±50K ML), period < Q2, "Neither" control team.

**FIRED thresholds:**

|Alert                   |Conditions                                                                                                |
|------------------------|----------------------------------------------------------------------------------------------------------|
|BUY                     |floor ≥ 0.65, trailing 1-15, ML > -250                                                                    |
|BWC (Buy Window Closing)|floor ≥ 0.60, leading 2+, edge > 0, ML > -250, LS not AT RISK/CRITICAL, ctrl_sust not FRAGILE+            |
|WINDOW BUY              |floor ≥ 0.45, margin -15 to +5, QTR window ≥ 0.75, sust LOCKED/DURABLE (not STALLED), trailing: TP OR LS gate|

**CANDIDATE types (6):** BUY floor 0.55-0.65, BUY margin 16-20, BUY with TP CONTESTED, BWC with FRAGILE ctrl sust, BWC with ML -250 to -400, WINDOW BUY with MIXED sust.

**Alert dedup:** `alertKey = gameId_alertType_alertTier_Q{period}`. BWC dedup per-type, re-fire 5min OR floor +0.10.

### BUY/PO Decoupled System (Apr 28)

BUY tracks via `lt.buy_position` (team, period, warm/cold flag, XGB at entry, flip flag). Exits via XGB_INVALIDATED only — one-shot per game after BUY SEND if XGB drops below quarter gate. PO graduation fires independently on checkpoint merit. Learning agent classifies BUY + XGB_INVALIDATED arcs as `standalone_buy`.

### BWC Death (May 4)

First poll where control flips away from BWC team → clears all BWC state (bwc_fired, po_fired, checkpoints, graduation). Fires TRACKING_INVALIDATED ntfy regardless of graduation state. Sets `lt._is_second_bwc=true` → second BWC team bypasses Q3_6 gate for B-rank graduation. Preserves `lt.mc`, `buy_position`, `halftime_mc` across death. Fixes stale `_xgbBwcProb` EXIT bug from FLIP PO.

### Position/Exit System (Apr 21, updated Apr 28)

BUY SEND sets `po_fired={rank:'BUY'}`, activates V2 state machine. EXIT via XGB only (see XGB EXIT above). PO upgrades BUY→A/B. FLIP BUY: EXIT + opponent BUY lifts position gate, evaluates as structural reversal.

Agent stress override: POSITION_OPEN/BWC_EDGE/POSITION_SAFE MAY SUPPRESS when window significantly weaker than cumulative.

**BWC_EDGE (Apr 29):** Subscriber label "Lead Compressing" (not "Holding"). Only fires on LOCK→EDGE (degrading), never EDGE→EDGE.

### Graduation System (Compound Thresholds, implemented May 8)

Compound thresholds replace S/A/B/C ranks. 5 poll holds at MC ≥ 0.80 + Floor ≥ 0.65. Q2 early confirmation adds lead ≥ 5 + 0 flips (95.5% accuracy).

**Tiers:** TRACKING → CONFIRMED (86%) → RECOVERING (73%, 1+ flips) → LOCKED (92%, 10+ holds). Close games plateau at 75%.

`classifyRank` kept for NCAAMB. Poll interval ~30s game clock (~60s wall). Deduplication required (45% concurrent cron duplicates).

`EXIT` compound fully validated and specced (phases 11–14 in graduation simplification spec v3, commit `7dde597`).

`game_checkpoints` table — PK (game_id, label). Atomic INSERT ON CONFLICT DO NOTHING. Catch-up loop for missed checkpoints. Graduation swap on control flip.

### Post-Game Learning Agent

`post-game-agent.mjs` — Netlify scheduled function, 11:45pm MST daily.

1. **COLLECT:** Query alerts table, fetch final scores from BDL
1. **BUILD ARCS:** Group alerts by `game_id + position_team` (falls back to `control_team` for older data). Sort by game time (period + clock), not wall-clock timestamp. Terminal = last non-TRACKING delivered alert.
1. **SCORE:** Arc correct when: non-EXIT terminal → position_team won; EXIT terminal → position_team lost (EXIT was justified). Exit-class scoring for MC_COLLAPSE (Structural Stress) events.
1. **ANALYZE:** Opus call per slate — cascade games, conflicting signals, agent decision quality.
1. **STORE:** To `learnings` table. **NOTIFY:** ntfy summary.

**Failure types:** left_hanging (HOLD terminal, team lost — no EXIT fired), premature_exit (EXIT terminal, team won), wrong_entry, false_recovery, false_dip.

**Status (May 11):** Currently broken — fix is top priority. The learning agent is the system's self-correction loop; without it, post-game audits are manual.

### Tier Journey Data (Apr 18)

Close games (≤8, n=476): First fire = 51.1% coin flip. C→A = 81.5%, C→B = 71%. Value window: A@lead5-8 = 93.1%, B@lead1-4 = 82.2%. Zero flips = 73.1%, 1 flip = 37.7%. Wire-to-wire = 98.3% (S-tier). 3+ cp grad = 77–80%. Full (n=1230): C→A = 95%, 0 flips = 92.8%, 3+ cp = 93%. **POSITION OPEN must wait for graduation, not first BWC fire.**

-----

## WNBA (Deployed May 9)

### Backtest & Validation

203-game backtest 88.7%, DOMINANT 99%, I3+I4 99.1%. WNBA-specific indicators: I3 Shot Quality 30% (anchor), I4 Game Control 25%, I2 Perimeter+FT 20%, I1 Disruption 15%, I5 Momentum 10%. Paint/rim = noise, TOs inverse.

### Server Pipeline

Full SR + BDL integration deployed. `analyze.js` has WNBA-specific prompt. `odds-api.js` supports league param. SR standings integrated. Signal strip below WP chart (MC + XGB + PBP ON by default). ESPN scoreboard fallback for schedule discovery. Poll function handles both leagues with 2s stagger between league poll loops.

### WNBA Dashboard

`wnba-bdl.html` (~3,925 lines). v5.2 spec committed (858 lines). ESPN_ALIAS_MAP verified from live data (all 15 teams). BDL_TEAM_MATCH verified. ESPN live score refresh (10s via scoreboard). Signal strip, WP chart, indicator evidence panels, snapshot history.

### BDL WNBA Quirks

No `box_scores` endpoint. No per-player stats endpoint (404). No `shooting_play` field on plays (regex fallback at 3 locations). `team_stats` uses `fouls` not `pf`, `turnovers` not `to`, no `pts` field. No x/y coordinates on plays (court visual uses text-based zone classification).

BDL abbreviations differ from SR: LVA→LV, NYL→NY, GSV→GS, WAS→WSH, LAS→LA, PDX→POR, TOY→TOR. **CRITICAL:** `cfg.aliasMap` must ONLY apply at `parseBDLPBPServer` for WNBA — NBA BDL plays use same abbreviations as SR (SAS not SA). Applying aliasMap globally breaks NBA PBP parsing.

BDL WNBA date boundary: late-ET games land on next UTC day; `bdlGameData` fetches both dates.

### WNBA Key Findings

- I3 anti-inversion: losing I3 = 17.6% win rate vs NBA's 49% — opposite direction
- Q4 BUY nearly dead: XGB < 0.45 = 2% win rate; only ≥ 0.70 viable
- I2 + I3 is the BUY anchor (44.8%)
- Floor is narrative only in WNBA (wrong 80% vs MC + XGB)
- MC Q4 underestimates by +8–14pp
- BUY trailing max should be 1–9 (not 1–15)
- XGB gates: Q2 < 0.45, Q3 < 0.45, Q4 < 0.70

### WNBA Remaining Gaps

- `pregame-agent.mjs` hardcoded to NBA at line ~1030
- ESPN ID mid-game fallback (SR retry works pre-tip only; when SR fails mid-game with ESPN numeric IDs, game gets skipped)

-----

## KEY DATA PIPELINES

### Season Cache

`season_cache` table stores weekly BDL player averages. NBA: per-player calls; NCAAMB: batch endpoint. Poll reads cache-first, fetches stale (>7 days) teams. Client syncs via `syncSeasonCacheFromDB()`, merges via `mergeBdlSeasonPriors()`. Season cache provides real BDL priors instead of 36% fallback.

### Quarter Data

`quarter_data` JSONB on games table. Server captures boundary stats at quarter transitions, computes diffs. Cross-fade rolling window activates Q2+. QD hydration must be ABOVE `gapLog` guard. Poll BDL date uses `getSlateDate(dateOffset)` not `(0)`. Live partial quarter row: client diffs current box score minus last boundary, renders Q(n+1)* row in amber with dashed border. Boundaries stored on `cs._serverQuarterBoundaries`.

### Sustainability

Server saves full `sust_json` to every snapshot. Fallback chain: baselines → `computeSustainabilityDirect()` → stored audit → parsed prediction text. Always-on — never skip.

### getFloor() Fallback Chain

`sonnetIndicators` → `clientInd` → `_serverFloor` → `rollingWindow`

-----

## RESEARCH FINDINGS (validated, stable)

### Research Ruled Out

These approaches were rigorously tested and found not to improve the system:

- **Bayesian recency weighting** (+0.0 AUC — cumulative floor improves Q1→Q4, more data = better)
- **Change-point detection** (CUSUM/sliding window/BOCPD all at chance AUC — floor already IS a change-point detector)
- **Holly auto-tuning** (adaptive weights HURT by -0.02 AUC, overfits on 100-200 game windows)
- **SHAP delta model** (flip target AUC 0.729, loss target 0.629 — neither reliably improves BUY decisions after removing leakage. Raw vol_concentration metric and biglead SHAP signal outperform any second model — deploy as agent context, not a model)
- **Opponent rising canary** (mathematically coupled to ctrl collapse canary — same 2-checkpoint window, zero-sum — zero timing gain, 450 games tested)
- **EXIT confirmation via MC** (MC doesn't discriminate — MC disagrees 75.9% vs confirms 70.1%. XGB EXIT already well-calibrated)
- **Conformal prediction** (XGB distance from 0.50 already captures confidence. Formal intervals add statistical formalism but don't change agent decisions)
- **Production indicator weights** [0.10, 0.15, 0.20, 0.30, 0.25] are near-optimal (global opt [0.15, 0.15, 0.15, 0.35, 0.20] only +0.01 AUC). Floor's AUC gap vs continuous features is discretization of eFG/3PT — XGB already covers this.
- **Position monitoring as separate alert layer** (85% of confirmed positions never dip below MC 0.90; 0.70–0.90 middle zone too small and benign to support a separate alert layer)

### Key Architecture Decisions

- **Transition Alerts (Apr 29):** RECOVERY PATH, LEAD CRUMBLING, LEAD LOST, VARIANCE BREAKING will NOT be built. Trust the validated state machine backed by 1,235 games. Adding parallel non-state-tracking alerts creates cascade risk and contradicts the rigorously backtested system.
- **MC uses cumulative rates, XGB uses windowed rates:** Architecturally correct — MC wants volume for stable rate estimates, XGB wants recency for structural shifts.
- **Signal roles (codified May 6):** Windowed XGB for early EXIT detection (100% recall on 10 playoff losses at 0.45 threshold). MC Cum for EXIT confirmation gate (< 0.70 paired with XGB improves precision to 73%, 80% recall). PBP MC (20-possession windowed) for investigation trigger only — too volatile for EXIT gate. Floor score for narrative/analytical context only.

-----

## KEY LEARNINGS & PRINCIPLES

### Structural Analysis

- BLOCK signal is 95%+ reliable for vetoing entries; PASS is only 25–33% reliable for sizing confidence
- `structRate` cannot distinguish effort-based production (tanking team crashing boards) from talent-based production
- Sustainability baseline regression: teams with no shooters never regress up
- C&S 3PT scheme production is structural offense, not variance — the framework had a paint-dominance bias
- **Cumulative floor anchors stale early-game data into late-game reads — biggest known accuracy failure mode.** Floor is anti-predictive in lead-change games (AUC 0.329). MC trajectory is the right signal for collapse detection.
- Fix the data, not the machine — clean signals into the existing agent rather than restructuring the state machine
- The agent is not just a gate — it's a narrator that builds game context for all downstream alerts. Never bypass it.

### Alert/Position Design

- POSITION OPEN must wait for graduation, not first BWC fire
- TP gate removed from BUY/WB/CANDIDATE — TP has cumulative anchoring limitation; agent uses it as context only
- Alert cascade (BWC firing after LEAD CRUMBLING) is the biggest UX problem — suppress correctly
- Alert bodies must lead with action, explain why, translate all jargon
- Betting journal approach replaces CLV tracking

### Team-Specific

- **OKC** defense is system-driven, not star-dependent: full offensive downgrade when stars out, minimal defensive downgrade. I2 + I1 steals near full strength
- Post-deadline integration risk: discount season TO rates for teams with new ball-handlers acquired < 4 weeks ago
- Live TO gate: if team's live TO count tracks 5+ above season per-game avg by mid-Q3, structural edge is compromised
- Defensive disruption escalation: opponent top-7 steals + volatile ball-handlers = elevate chaos risk
- Clutch execution gate: teams with weak clutch net rating get conviction downgraded when protecting a lead

### Engineering Patterns

- Quarter data hydration must be ABOVE gapLog guard (gapLog fills during loadSchedule, blocks re-entry)
- Poll BDL date uses `getSlateDate(dateOffset)` not `(0)` — prevents Yesterday cache overwrite
- `getFloor()` fallback chain: `sonnetIndicators` → `clientInd` → `_serverFloor` → `rollingWindow`
- Anthropic API credits exhausting causes auto-analyses to fail silently
- Netlify serverless: missing `await` kills unawaited promises when handler returns; emojis in HTTP headers crash Node (ASCII-only ByteString required)
- Server is sole `game_context` writer (DO UPDATE not DO NOTHING)
- BDL stats are strings — wrap all math in `Number()`
- `let`/`const` at line ~10,000 causes TDZ when referenced earlier — use `var` for globals
- Netlify bundles each function separately — can't `require('./analyze.js')` from poll function
- Any `await` >1 second creates a concurrent invocation race window requiring a DB lock row before the slow call
- Never add new columns to existing SELECTs on critical polling paths — always fetch in separate isolated queries
- After scoping fixes, audit all log lines in the same block for the same variable-name pattern

-----

## COLLABORATION & WORKFLOW

### Roles

Manny is PM, product owner, and domain expert. Claude is lead engineer, UI/UX designer, and co-pilot. Manny drives product direction, framework design, and analytical methodology. Claude writes and ships code, proposes experiments, and asks "what about X?"

Manny describes this to others as: "I designed the framework and product direction, but I build it collaboratively with Claude. I describe what I want, we architect it together, Claude writes the code, I test and deploy."

### Collaboration Tone

Relaxed, joking dynamic — not a military briefing. Manny thinks in frameworks, not features. He pressure-tests architecture, catches logical errors in production, and values directness and honest pushback. When he says "you're grasping at straws," stop the current line of reasoning and go back to the data. Manny refers to Claude as "son."

### CRITICAL WORKFLOW RULE

**Never implement code changes without explicit confirmation from Manny.** Questions are questions, not directives — answer, then wait. Spec proposals are fine to share proactively, but code requires explicit go-ahead. Violating this breaks trust.

### Co-Pilot Mode (established May 2)

Manny explicitly asked Claude to be inquisitive — don't just answer questions, propose experiments and ask "what about X?" Don't constrain insights to what Manny asks for. Be a co-pilot, not just an executor. This led to the MC oscillation pattern discovery, speed findings, and combined canary optimization.

### Architectural Advisory (established May 11)

Manny lives in "what's possible / what optimizes betting value" — he has technical blinders by his own admission and leans on Claude as the technical expert. Before building any substantial feature, Claude must proactively surface the architectural decision: "this is N functions and ~X lines — should it live in its own module or go inline? Here are the tradeoffs." Manny makes the prioritization call with full technical information.

Architecture improves alongside feature work, not as separate refactoring sprints. The discussion costs five minutes and prevents silent debt accumulation. Don't wait for a monolith to become painful — surface the decision when the feature is being scoped.

### Testing Ownership (established May 11)

Claude owns operationalizing unit and integration testing. Manny wants it but needs Claude to drive the strategy, tooling, and implementation. When launching new features, include a test plan as part of the spec.

**Starting point:** Functions that have regressed in production — `parseBDLPBPServer` (aliasMap regression where WNBA fix broke NBA PBP), `extractXGBFeatures` (leaf `c` vs `w` bug), alert threshold logic (compound establishment dedup break). The aliasMap regression is the canonical example of what tests would have caught.

### Backlog Management (established May 11)

The project knowledge doc describes the system as it exists — shipped features and decisions. Active backlog, queued items, and in-progress research live in Claude's memories, not this doc.

When backlog items persist across multiple sessions without being worked, Claude should ask "still want this or should we kill it?" rather than continuing to resurface. Manny owns prioritization decisions. Items move from memory into this doc only when they ship.

### Architecture-First Development

Manny's standing instruction for any non-trivial change: **"Architect/spec required changes meticulously, trace cascading implications and identify mitigation options. Identify dead code to be cleaned up if needed. I don't want to introduce any bugs when we move to implementation."**

This means:

1. Map every code path that touches the change (grep, read surrounding context)
1. Identify all consumers of modified functions/data
1. Trace 1st, 2nd, and 3rd order effects
1. Flag dead code that can be cleaned up
1. Present the full spec with cascading implications before building

### Thinking Level

Always operate as a senior solution architect / engineering manager. Before ANY solution: map full system topology, trace all cascading implications (state machines, agent context, learning agent, subscriber UX, betting value). Never jump to code — exhaust the strategic design space first. Default to "what does this touch end-to-end" before "here's the fix."

### Diagnostic Methodology — MANDATORY before any fix

Claude has a tendency to jump from symptom to solution. Manny's approach is rigorous and exploratory. Follow this process for every bug:

1. **PULL THE DATA FIRST.** Snapshots, alerts, analyses, quarter data, raw stats, odds movement. Use direct DB access (see below).
1. **LOOK FROM MULTIPLE PERSPECTIVES.** Server mechanical, server Opus, client mechanical, client Opus, market, final outcome. When these disagree, the disagreement IS the diagnosis.
1. **IDENTIFY THE EXACT DIVERGENCE.** Not "the floor was wrong" — specify which floor, which component, which time, what value.
1. **HYPOTHESIS, NOT CONCLUSION.** Name the suspected root cause explicitly. Trace the code path. Verify with data.
1. **PROPOSE THE FIX ONLY AFTER DIAGNOSIS.** Explain what changes, what stays the same, what could break.

Hit the endpoint first, get the real error, fix in two minutes. Never add diagnostic logging and theorize — direct access before speculation.

### Research Methodology (established May 2)

For analytical/data-science work (as opposed to feature development):

1. **Hypothesis first.** State what you expect and why.
1. **Pull backtest data** via endpoint (e.g., `mc-backtest?phase=...` or `backtest-nba-snapshots?phase=export_xgb`).
1. **Run analysis scripts** in Python or Node in the sandbox.
1. **Validate against known games** — pick specific games where you know the outcome and trace the signal.
1. **Commit findings** to `research/` directory with date prefix.
1. **Write deployment spec** (`*_SPEC.md` at repo root) only after findings are validated.
1. **Only then implement.** Research ≠ deployment. Spec first, code after confirmation.

### Session Startup Protocol

Every session begins with:

1. Clone repo to `/home/claude/dft`
1. `git config user.name "MannyBanda" && git config user.email "manny@dft.dev"`
1. `wc -l` key files (poll-live-bdl.mjs, db-api.js, v3.html, mc-backtest.mjs)
1. `git log --oneline -10`
1. Search recent chats for continuity
1. Read relevant source files before touching anything

This prevents the "phantom completion" bug where Claude assumes prior session's changes are deployed. File line counts are the ground truth for detecting state drift between sessions.

### Presentation Preferences

- **URLs and scripts:** Present as code blocks for easy copy-paste on mobile. Manny runs DFT from his phone — one-tap copy matters.
- **Implementation:** Chunked, file-by-file with status table tracking progress. One command at a time during live testing sequences.

### Known Blindspots (self-correcting)

1. **Prompt text gets less rigor than code** — numbers in template literal prompts are functional like code constants. Grep old values, verify all replaced.
1. **Additive bias** — adds new content well but under-audits existing content needing updates.
1. **When tempted to simplify a data source vs spec, stop and re-read WHY spec specified the harder option** — the specificity is usually the point.

-----

## DIRECT ACCESS WORKFLOW (Apr 25)

Claude's sandbox can reach both the Netlify site and Neon DB host. This fundamentally changes the collaboration workflow.

### What Claude Can Do Directly

- **Pull live data:** `curl -s "https://poetic-starlight-aa8938.netlify.app/.netlify/functions/db-api?action=get_alerts&limit=50"` — alerts, snapshots, learnings, poll_state, games, calibration, live_tracking, odds, and more. Basic Auth: `[REDACTED]`.
- **Run schema migrations:** Hit `?action=init` to create new columns and run backfills.
- **Rerun learning agent:** Delete (`?action=delete_learning&date=YYYY-MM-DD`) then rerun (`/post-game-agent?date=YYYY-MM-DD`).
- **Validate fixes end-to-end:** Push code → wait for deploy → hit endpoints → verify data.
- **Write trace scripts:** Node scripts that query live endpoints and simulate system logic against real data.
- **Hit poll endpoint directly:** `/.netlify/functions/poll-live-bdl` — trigger and get errors immediately.

### What This Replaces

Before Apr 25, diagnosis required round-trips: Claude writes console script → Manny pastes in browser → Manny shares output → Claude diagnoses. Now the entire diagnosis→spec→build→validate cycle happens in one session without Manny pasting output.

**Console scripts are still needed for:** anything requiring the authenticated dashboard context (client-side cardState, localStorage, DOM inspection). But most data-layer debugging is now direct.

### Key db-api Endpoints

`get_alerts` (limit, date, type), `get_games` (date), `get_learnings` (limit), `get_poll_state`, `get_poll_history`, `get_latest_snapshots` (game_ids — plural), `get_live_tracking` (game_id), `get_calibration`, `get_odds` (game_id), `snapshot_diagnostic` (game_id), `get_checkpoints` (game_id), `get_clutch_profiles`, `history` (game_id — all snapshots with raw_stats_json), `init`, `delete_learning` (date).

**League parameterization:** All db-api queries are league-parameterized. Always pass `&league=wnba` for WNBA data (get_alerts, get_games, get_poll_state, etc). Default is NBA. Forgetting this returns empty results and leads to wrong conclusions.

**Backtest endpoint:** `backtest-nba-snapshots?phase={phase_name}`. `mc-backtest.mjs` has 12+ phases including opp_canary, halftime_primer, exit_confirm, window_xgb_export, backfill_mc_pbp. `export_xgb` phase for bulk data pull. `backfill_mc_pbp` supports `from`, `to`, `batch`, `offset`, `dry`, `sims`; `batch=2` is safe ceiling (BDL rate limiting + Netlify timeout).

### DNS Workaround

When curl returns "DNS cache overflow," switch to `python3 -c "import urllib.request..."` with `urllib.request.urlopen`. Save results to `/tmp/*.json` before parsing to avoid re-fetching.

### Live Game Collaboration

With direct access, Manny can chat during a live slate and Claude can pull real-time data to confirm what he's seeing:

- **"SAS floor feels wrong"** → Claude pulls snapshots, traces indicator scores, identifies divergence.
- **"Did the EXIT fire?"** → Claude queries alerts, checks agent decision + reasoning.
- **"What does the learning agent say about tonight?"** → Claude pulls latest learnings entry.
- **Post-game audit** → Claude pulls all alerts + final scores, traces each arc.

-----

## MEMORY MANAGEMENT STRATEGY

Claude's memory system has a 30-slot limit. Memories should be reserved for **dynamic, frequently-changing information** — not stable architecture facts.

### What Belongs in Project Knowledge (this doc)

- Architecture decisions that are shipped and stable
- Framework principles and learnings from post-game audits
- API keys, env vars, operational config
- Alert thresholds, conviction engine rules, graduation spec
- Team-specific insights, validated research findings
- Workflow preferences and development patterns
- Data source details and schema
- Decisions and research that's been ruled out

### What Belongs in Memories

- **Active work items** — what's being built right now
- **Queued items** — validated and ready, waiting for timing
- **Active research threads** — remove when concluded (shipped or ruled out)
- **Recent changes not yet in project doc** — migrate to doc at next update
- **Behavioral directives** that need reinforcement (workflow rules, blindspots)

### Maintenance Process

When memories approach the 30-slot limit:

1. Audit which memories are already covered in project knowledge
1. Remove duplicates
1. Migrate stable new info into this doc
1. Keep memories focused on dynamic/recent/behavioral items

When backlog items persist across multiple sessions without being worked, ask Manny: "still want this or should we kill it?" Items that are done should be removed from memories immediately.

This doc should be updated after major architectural changes or at natural breakpoints (end of season, major feature ship). Manny uploads the updated version to the Claude project settings.

-----

## V3 DASHBOARD (Apr 22 – ongoing)

~3,983 lines. Mobile-first single-card swipe interface. Demo mode shipped (POR@DEN/GSW@SAC/MIA@CHA presets, util menu). Toast with live line shopping (The Odds API, 20+ books), scoped to currently viewed game. ⚡ Analyze button (Opus 4.6). 10s client poll cycle. ESPN/XGB toggle on WP chart. XGB column in snapshot history (cyan/amber/red). MC Cum signal row + drivers + snapshot column. Collapsible MC investigation strip. Confidence table (≡ menu). 30-team color map. Shot zones with zone bubbles. Indicator evidence panels (tap I1-I5 pills). Collapsible section headers. Margin flow with shot markers.

-----

## DEBUG DASHBOARD

`debug.html` — 7 sections:

1. **DB & Data** — DB stats, theses, analyses, poll state, poll history
1. **Calibration** — Per-quarter calibration snapshots, Q3 gold standard, all-quarters comparison
1. **Analytics** — Season cache, PBP stats, shot profiles, player zone baselines, run patterns
1. **Game Inspector** — Game selector, snapshots, odds, sustainability, quarter data
1. **QA Suite** — League-aware automated checks (13 checks; NCAAMB uses H1/H2 labels)
1. **Alert Accuracy** — Filter by type/date, summary accuracy cards, per-type/per-date breakdowns
1. **Nightly Learnings** — Post-game agent results: accuracy trend, cumulative agent accuracy, per-night findings/patterns/recommendations

-----

## ALERT ACCURACY BASELINE (Apr 6-7, 15 games)

43/71 overall (61%). BUY 75%, BWC 71%, WINDOW BUY 67%, RECOVERY PATH 63%, LEAN BUY 17% (killed).

Key finding: 89% of wrong alerts came from blowout games where the floor was fundamentally wrong. 64% of wrong alerts required TP passing as prerequisite. TP STRONG RECOVERY only closes margin 33% of the time. LS SAFE holds 94%, CRITICAL erodes 72%.

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
