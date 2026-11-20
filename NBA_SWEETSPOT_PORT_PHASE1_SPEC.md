# NBA SWEET SPOT PORT — Phase 1 Spec (gates + snapshot columns, store-only)

**Parent:** `NBA_SWEETSPOT_PORT_SPEC.md` v1 §4 Phase 1 · **Date:** 2026-11-19 · **PM go:** "Port it regardless. Go ahead and spec" → "Go ahead and handle 1 and 1b" · **Status:** BUILT 2026-11-19 (Phase 1 + Amendment 1 / Phase 1b in one commit; WNBA goldens pinned first in `385b257`). Flags `NBA_SS_WATCHLIST_ON` / `NBA_SS_LEDGER_ON` ship OFF.

**Goal:** the Sweet Spot compute core runs on every NBA snapshot and writes the `ss_*` columns — quality gap, leader/trailer as-of win%, leader eFG, variance share, lead class — exactly as it does for the WNBA, with every WNBA-calibrated piece (eFG bands, comeback priors, tier ladder, edge/Kelly) **null for NBA** and every fire path **off by config**. Zero Anthropic calls. Zero pushes. Zero `sweetspot_alerts` rows. WNBA byte-identical, fixture-pinned.

**Why this phase matters today:** the Nov 19 exploratory (`aaf0ec8`) found the hot-leader × better-trailer cell at +24pp vs ESPN on this season's tape, reconstructed offline from `raw_stats_json`. After Phase 1 that cell logs itself forward on every poll — `ss_quality_gap` and `ss_leader_efg` at every state — so Phase 2's prereg has a clean forward tape without a single reconstruction step.

---

## 1. What an NBA snapshot carries after Phase 1

| column | NBA value | source | WNBA |
|---|---|---|---|
| `ss_leader_alias` | written | scoreboard | unchanged |
| `ss_leader_wp`, `ss_trailer_wp` | written (as-of win%, both ≥ **5 GP** else null) | `standings_cache` via BDL `/nba/v1/standings` | unchanged (≥ 4 GP) |
| `ss_quality_gap` | written (trailer − leader) | derived | unchanged |
| `ss_leader_efg` | written (×100, 1 dp) | `summary.{home,away}.statistics` (`field_goals_made/att`, `three_points_made` — the BDL-built summary already uses these names) | unchanged |
| `ss_variance_share` | written | `computeScoringComp(game._bdlPbp, …).vPct` | unchanged |
| `ss_lead_class` | written (EVEN / STRUCT / VOL / MIXED) | `computeScoringComp(...).classification` | unchanged |
| `ss_leader_efg_band` | **null** | needs NBA bands (Phase 2) | WNBA `EFG_BANDS` |
| `ss_fade_tier` | **null** | `divergenceRead` depends on `efgTier` → WNBA bands | unchanged |
| `ss_collapse_tier`, `ss_collapse_true` | **null** | `comebackProb` carries WNBA priors (leader < .400 etc.) | unchanged |
| `ss_line_used` | written as **observed** (best-book ML, live/pregame mix — see parent §4.3) | `odds` | unchanged |
| `ss_implied`, `ss_edge`, `ss_kelly_size` | **null** | no price-derived fields until the stale-quote filter ships | unchanged |
| `ss_alert_tier` | **null** · `ss_alert_fired` **false** | tiers all off | unchanged |

No schema change: `snapshots.ss_*` already exist for every league.

## 2. Code changes — `netlify/functions/poll-live-bdl.mjs` only

### 2.1 Config block (after the existing `WNBA_SS_*` env consts, ~line 50)
```js
// ── SS ENGINE PER LEAGUE (NBA_SWEETSPOT_PORT_PHASE1_SPEC) ─────────────────────
// The WNBA block is today's env flags, unchanged in meaning — the flags stay the source of truth.
// Values are booleans/keys only (never object refs like EFG_BANDS: it is a hoisted `var`
// defined later and would capture undefined here — hotfix #6 lesson). The compute core resolves keys.
const SS_CFG = {
  wnba: { enabled: !WNBA_SS_COMPUTE_OFF, minGP: 4, efgBands: 'wnba', comebackModel: 'wnba', divergenceGate: true,
          priceFields: 'full', standingsSeason: 'calendar',
          tiers: { A: WNBA_SS_ALERT_ON, B: WNBA_SS_B_ON, WATCHLIST: WNBA_SS_WATCHLIST_ON, GAP_BASE: WNBA_SS_LEDGER_ON } },
  nba:  { enabled: process.env.NBA_SS_COMPUTE_OFF !== '1', minGP: 5, efgBands: null, comebackModel: null, divergenceGate: false,
          priceFields: 'line_only', standingsSeason: 'oct_start',
          tiers: { A: false, B: false, WATCHLIST: false, GAP_BASE: false } },
};
const ssCfg = (l) => SS_CFG[l] || null;
const ssEnabled = (l) => !!(ssCfg(l) && ssCfg(l).enabled);
// NBA season label = the year the season started (Oct→Dec: this year; Jan→Sep: last year). WNBA = calendar year.
// Superseded by LEAGUES[league].season when the season-consolidation branch merges; byte-identical for WNBA today.
const ssStandingsSeason = (l, d) => (ssCfg(l)?.standingsSeason === 'oct_start' && d.getMonth() < 9) ? d.getFullYear() - 1 : d.getFullYear();
```
`NBA_SS_COMPUTE_OFF=1` is the NBA kill switch (same pattern as `WNBA_SS_COMPUTE_OFF`).

### 2.2 Standings fetch — `fetchStandingsCache` (~line 2583)
`const yr = new Date().getFullYear();` → `const yr = ssStandingsSeason(league, new Date());`. WNBA path returns the same value it does today. Verified: BDL `/nba/v1/standings?season=2026` returns 30 teams with `wins/losses` and `team.abbreviation` on the GOAT key. `standings_cache` is already keyed `(league, team_alias)`; NBA rows refresh every 20h like WNBA's.

### 2.3 Gate sites (two)
- ~8528: `const ssStandings = (league === 'wnba' && !WNBA_SS_COMPUTE_OFF) ? await fetchStandingsCache(sql, league) : {};` → `ssEnabled(league) ? … : {}`
- ~9264: `if (league === 'wnba' && !WNBA_SS_COMPUTE_OFF) {` → `if (ssEnabled(league)) {`

### 2.4 Extract the compute core into a pure function (the architectural change)
The ~45 inline lines from `_ssSc = computeScoringComp(...)` through `_ssFired` become:
```js
// Pure: no I/O, no league literals. Returns null when the PBP zones are missing (same as today's early-out).
function ssComputeShape({ league, standings, summary, pbp, hA, aA, hPts, aPts, period, clock, odds }) → {
  leadAl, trailAl, deficit, leadWP, trailWP, gap, leadEfg, leadBand, varShare, cls, fadeT, collT, pPoint,
  trailML, implied, edge, kelly, tier, fired, ladder }
```
Inside, every WNBA-calibrated step resolves through `ssCfg(league)`:
- `_ssWp`: `gp >= cfg.minGP`.
- `fadeRead = cfg.divergenceGate ? divergenceRead(sc) : null` (sets `sc.fadeRead` too — `comebackProb` reads it).
- `leadBand = cfg.efgBands === 'wnba' && leadEfg != null ? efgTier(leadEfg, period).tier : null`.
- `pr = cfg.comebackModel === 'wnba' ? comebackProb(...) : { tier: null, pPoint: null }`.
- `ev = cfg.priceFields === 'full' && pr.pPoint != null ? comebackEV(pr.pPoint, trailML) : null`; `implied = cfg.priceFields === 'full' && trailML != null ? americanToImplied(trailML) : null`.
- `ladder = ssClassifyTier(edge, period, deficit, collT, fadeT, cls)` only when `cfg.comebackModel` is set; otherwise `{ tier: null, ledgerSub: null }`.
The inline site becomes `const _ss = ssComputeShape({...}); if (_ss) { await sql\`UPDATE snapshots SET … \`; log(...); /* 2b */ }` with the UPDATE's column list **unchanged** and the log line gaining the league. The existing local names (`_ssGap`, `_ssTier`, …) are kept as destructured aliases so the 2b block below needs no renames.

### 2.5 The 2b fire block (~9330–9460) — config, not flags
```js
var _ssDoFire   = ((_ssTier === 'A' && cfg.tiers.A) || (_ssTier === 'B' && cfg.tiers.B)) && !_ssQ1BSupp;
var _ssDoLedger = !_ssTier && _ssLad.ledgerSub != null && cfg.tiers.GAP_BASE;
var _ssDoWatch  = cfg.tiers.WATCHLIST && ssWatchGate(currentPeriod, _ssGap, _ssDeficit, _ssTrailML);
```
For WNBA `cfg.tiers.*` are the same env flags → byte-equivalent. For NBA all false → no push, no row, no narration enqueue, no squeeze arm. `WNBA_SS_ALERT_ON / _B_ON / _LEDGER_ON / _WATCHLIST_ON` keep exactly one consumer each (the `SS_CFG.wnba` block) — grep-gated.

### 2.6 Left as-is in Phase 1 (by design)
GAME_BRIEF seeding (`WNBA_GAME_BRIEF_ON && league === 'wnba'`, ~9190), `ssNarrationSweep`, squeeze auto-arm, post-game SS resolver (`league !== 'wnba' → null`), `get_ss_state`/verdict strip (WNBA dashboard only), `team-profiles-nightly`. None is reached for NBA because no NBA row is ever written.

## 3. Cascading implications (traced)
- **Snapshot UPDATE volume:** one extra UPDATE per NBA snapshot per poll (~7–10 live games × 1/min). The WNBA already pays this; the WHERE matches `(game_id, period, clock, home_pts, away_pts)` as today. Netlify budget impact: milliseconds (pure compute + one indexed UPDATE).
- **BDL:** one standings call per ~20h per league. Zero Anthropic. Zero ntfy.
- **`NBA_PAUSED`:** orthogonal. The SS compute is not an alert, a push or a model call; it runs under the pause and writes columns only.
- **`raw_stats_json`/`espn_*`:** untouched — the compute adds columns, it reads nothing new from the DB.
- **Dashboards:** `bdl.html` does not read `ss_*`; `wnba-bdl.html` reads only WNBA games. `debug.html` QA checks that assert `ss_*` population are to be confirmed league-aware at build time (if a check assumes `ss_* IS NULL` for NBA, it flips — build step, not a design risk).
- **`ss_ledger_summary&league=nba`:** returns empty (no rows) — correct.
- **Season consolidation branch:** Phase 1 adds one derivation (`ssStandingsSeason`) that the branch will replace; no season literal is added.
- **Dead code:** none. `_bEfg` moves into the core; the WNBA flag consts remain as the single source of the WNBA config values.

## 4. Fixtures (new) — `research/ss_league_param_fixtures.mjs`
1. **WNBA golden (byte-equal):** six hand-built inputs (standings map, PBP zone object with `home/away.{rim,paint,mid,threes}`, summary stats, scores, period/clock, odds) spanning: A-tier shape, B shape, ledger shape, no-PBP early-out, GP<4, leader ≥ .400. Expected outputs are pinned **before** the refactor by running the current inline logic on the same inputs (a one-off extraction script, committed with the pins). After the refactor `ssComputeShape` must reproduce every field exactly.
2. **NBA shape:** same inputs with `league:'nba'` → `gap/leadWP/trailWP/leadEfg/varShare/cls/leadAl/trailML` populated; `leadBand/fadeT/collT/pPoint/implied/edge/kelly/tier` all null; `fired === false`; GP 4 → wp null (minGP 5).
3. **Config pins:** `SS_CFG.wnba.tiers.A === WNBA_SS_ALERT_ON` (and the other three); `SS_CFG.nba.tiers` all false; `SS_CFG.nba.efgBands === null`, `comebackModel === null`, `divergenceGate === false`.
4. **Source-equality grep gate:** `league === 'wnba' && !WNBA_SS_COMPUTE_OFF` appears **0** times; `ssEnabled(league)` appears at both gate sites; `WNBA_SS_ALERT_ON` / `_B_ON` / `_LEDGER_ON` / `_WATCHLIST_ON` each appear exactly twice (definition + `SS_CFG.wnba`).
5. **Season derivation:** `ssStandingsSeason('nba', 2026-11-19) === 2026` · `('nba', 2027-01-05) === 2026` · `('nba', 2027-10-20) === 2027` · `('wnba', 2027-01-05) === 2027`.
Plus every standing harness green (tier B/C 81, parity 30, narration 67, ops 35, decision support 124, squeeze 77, season26 35, verdict 42, availability 35, fine arena 19, matchup 36) and `node -c`.

## 5. Build → ship → verify
1. Pin the WNBA golden from the current inline code (commit the pins first).
2. Config + helpers + extraction + gate edits + 2b config, one commit. `node -c`, all harnesses, grep gate.
3. Push → Netlify deploy. Nothing changes for WNBA (off-season, and fixture-pinned); NBA starts writing on the next poll.
4. **Verify on the next slate:** `history&game_id=<live NBA game>` shows `ss_quality_gap`, `ss_leader_efg`, `ss_variance_share`, `ss_lead_class` populated and `ss_alert_fired=false`, `ss_leader_efg_band/ss_fade_tier/ss_collapse_tier/ss_edge` null; `get_alerts&league=nba` and `get_sweetspot_alerts&league=nba` show no new row types; no push. Standings cache has 30 NBA rows.
5. Rollback: `NBA_SS_COMPUTE_OFF=1` (env), no redeploy.

## 6. Size
~150 lines in `poll-live-bdl.mjs` (config 20 · helpers 6 · core extraction ~70 moved + ~15 new · gates/2b 8), ~120 lines of fixtures + the pin script. One function file touched. No DB migration. No new env var required to ship (the kill switch is opt-in).

## 7. What Phase 1 does not decide
NBA eFG bands by period, NBA comeback priors, the GAP_BASE/WATCHLIST ledgers, the verdict strip on `bdl.html`, the A-selector — all Phase 2+ and each behind its own prereg or go. The regime prereg (hot-leader × better-trailer, Oct–Nov vs rest, both arenas) is the recommended next research step and is independent of this build.

---

## AMENDMENT 1 (2026-11-19, PM go "handle 1 and 1b") — pause independence + Phase 1b

### A1.1 `NBA_PAUSED` does not gate Sweet Spot pushes
`NBA_PAUSED` gates the legacy stack only (routeV2Alert, calibration Opus, pregame theses, invalidation narratives, nightly Opus). NBA Sweet Spot rows and pushes are governed solely by `SS_CFG.nba.tiers.*` — env `NBA_SS_WATCHLIST_ON`, `NBA_SS_LEDGER_ON` (both default off). Graduation stays dark while Sweet Spot pushes. Fixture-pinned: no `_isPaused` reference inside the SS block or `fireSweetSpotAlert`.

### A1.2 Phase 1b — NBA WATCHLIST cue + GAP_BASE ledger (ships with Phase 1, flags off)
- **Cue predicate (pure, `ssNbaWatchCue(shape, period, cfg)`):** gap ≥ .15 · leader eFG ≥ 57 (×100) · period ≤ 3 · deficit 1–9 · both win%s present (≥ 5 GP). Thresholds live in `SS_CFG.nba.cue`. One row per game (`ON CONFLICT (game_id, alert_subtype)` as today), subtype `WATCHLIST`, tier null. Expected ≈ 1–2/night (39 fires in 30 days on the Nov 19 tape).
- **Ledger predicate (`ssNbaGapBase`):** gap ≥ .15 · period ≤ 3 · deficit 1–9 → subtype `GAP_BASE`, `ledgerOnly` (rows only, no push). The base rate the cue is scored against.
- **Push composer `ssComposePushNba(ss)`** (fixture-pinned copy; priority 2; title ASCII only): records + gap in plain English · leader eFG and lead class (via `ssLeadClassDisplay`) · deficit/period/clock · ESPN fair for the trailer · `Live price: {trailer} {ML} at {book}` with **`(may be pregame)`** appended when `priceStale` · closing line: `NBA watchlist ($300 class). Eyes, not a bet call — the cell is exploratory (+24pp, n=39, one month); the forward log is the point.` No `SS_STRUCT` cells, no caution kernels, no team-ctx line, no fuel/temp block for NBA.
- **Stale-price flag (parent §4.3, minimal):** `priceStale = trailML != null && espnTrailerWP != null && |americanToImplied(trailML) − espnTrailerWP| > 0.25`. Stamped into `player_ctx_json.priceStale` (no new column). `ss_implied/ss_edge/kelly` stay null for NBA regardless.
- **`fireSweetSpotAlert` by config:** composer (`cfg.pushComposer`), dashboard link (`cfg.dashUrl` — `bdl.html` for NBA), team-ctx line only when `cfg.teamCtx` (false for NBA: the cached WNBA map shares aliases like `MIN`), fuel/temp block only when `cfg.fuelTempBlock`, pctx digest only when `cfg.pctx`, narration: `if (!cfg.narration) return` after the push (the tail sweep is `league='wnba'`-filtered anyway; squeeze has `LEAGUE='wnba'` hard-coded — neither can touch NBA rows).
- **Resolver (`post-game-agent.mjs` `processSweetSpot`):** `league !== 'wnba'` → `!SS_RESOLVE_LEAGUES.includes(league)` with `['wnba','nba']`; resolves NBA rows from finals exactly as WNBA; the graduation watchdog / crossing proposals stay WNBA-only (gated inside). Runs under `NBA_PAUSED` (mechanical, no Opus).
- **Fixtures added:** cue/ledger predicates (positive, each clause negative), `ssComposePushNba` copy pins incl. the stale suffix, stale-flag arithmetic, config pins for the two new flags, grep gate (no `_isPaused` in the SS block/fire path).
- **Verify on the next slate with flags on:** `get_sweetspot_alerts&league=nba` shows WATCHLIST rows with `ntfy_sent=true` and GAP_BASE rows with `ntfy_sent=false`; the push body matches the composer; `get_alerts&league=nba` still only `PAUSED_LOG`; next morning `ss_ledger_summary&league=nba` has resolved counts.
- **Size:** ~120 lines on top of Phase 1 (predicates 25 · composer 25 · fireSweetSpotAlert config branches 15 · resolver 5 · fixtures 50).

### A1.3 Build notes (as shipped)
- `SS_CFG[league].tiers` keys are `A / B / WATCHLIST / LEDGER` — `LEDGER` (not `GAP_BASE` as §2.5 wrote) because the WNBA flag it mirrors, `WNBA_SS_LEDGER_ON`, gates **both** ledger subtypes (GAP_BASE and Q4_COLLAPSE). Same semantics, honest name.
- Config also carries the per-league fire-path switches the fire function reads: `pushComposer`, `dashUrl`, `teamCtx` (gates the killer/lane stamps AND the profile line — the WNBA profile map shares aliases with the NBA), `fuelTemp`, `pctx`, `narration`, plus `ledgerModel` / `watchModel` (which GAP_BASE / WATCHLIST predicate) and, NBA only, `cue` + `staleGapPp`.
- `ssComputeShape` resolves the NBA `GAP_BASE` predicate into `ladder.ledgerSub` itself (`ledgerModel: 'nba'`), so the 2b fire block's `_ssDoLedger` line is unchanged in form for both leagues.
- `WNBA_SS_ALERT_ON` keeps a third, pre-existing consumer: the A-tier repush sweep (`ssRepushSweep`, `league='wnba'`-literal SQL). The grep gate pins 3 for that flag, 2 for the other four.
- Stale-price flag stamps `player_ctx_json.priceStale = { stale, implied, espnWp }` (no new column); the WNBA stamp JSON is byte-identical (key absent).
- Pre-existing, untouched: `research/team_ctx_fixtures.mjs` is 28/30 on `main` before and after this change (copy drift in the full block — not this work).

### A1.4 Cue period floor (2026-11-19, same day, pre-first-fire) — Q1 excluded
The exploratory that motivates the cue (`aaf0ec8`, `research/2026-11-19_nba_ss_season_exploratory.py`) selected first perceptions from **Q2 onward** (`p<2 → skip`); §A1.2 wrote "pre-Q4" and the shipped predicate admitted Q1. Corrected before any row was written: `SS_CFG.nba.cue.minPeriod = 2` — both `ssNbaGapBase` and `ssNbaWatchCue` now require Q2–Q3, so the forward log scores exactly the population the cell was measured on, and Q1 shot samples (often <12 FGA) never drive an eFG cue. Expected volume unchanged in substance (the exploratory's n=39 / n=66 were already Q2–Q3). Fixtures updated (Q1 negative on both predicates).
