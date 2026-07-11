# SWEETSPOT OPS SPEC — Resolution, Read Access, Graduation & the Bet Join

**Date:** 2026-07-11 · **Status:** PROPOSED, awaiting PM decisions D-A..D-F + build go-ahead
**Baseline:** `ac34987` (tier ladder live: A + B + ledger + WATCHLIST all enabled 2026-07-10)
**Fulfills:** SWEETSPOT_TIER_BC_SPEC.md §2 graduation bar (n≥30, ±5pp) and §A1.4 "formalize the
discretionary layer" — the measurement loop those sections assume but nothing currently closes.

---

## 1. The problem (found live, night one)

The ladder now writes `sweetspot_alerts` rows (A/B pushes, WATCHLIST cues, silent GAP_BASE /
Q4_COLLAPSE ledger rows). Nothing downstream can see or score them:

1. **No read path.** db-api has zero actions against `sweetspot_alerts`. On 2026-07-10 the first
   live WATCHLIST slate could not be audited over HTTP — gate states had to be reconstructed
   from snapshot ss_ columns. Graduation audits are impossible without this.
2. **No resolution.** Rows never learn the final score. The D-5 graduation bar ("realized rate
   within 5pp of `collapse_true` mean") is uncomputable until every row carries `trailer_won`.
3. **WNBA finals are stubbed in the learning agent.** `post-game-agent.mjs:36` returns `[]` for
   WNBA (`fetchFinalScores`) because the BDL WNBA `games` endpoint returns null scores
   [FACT:prod, verified 2026-07-11]. WNBA arc scoring has been silently blind — this predates
   the ladder and is the root dependency for everything below.
4. **The bet join has no structured side.** §A1.4 wants `research/betting_log.md` joined against
   stored gate states. Markdown is the narrative record; the join needs rows.
5. **The nightly agent knows nothing about the ladder.** No SS scoring, no digest line, no
   graduation watchdog.

Poll hot path needs **zero changes** — everything below is db-api + post-game-agent.

## 2. WNBA finals fix (root dependency)

`fetchFinalScores('wnba')` reads the **last snapshot per game** and takes true scores from
`raw_stats_json` (per-league quirk: WNBA snapshot `home/away_pts` columns unreliable; raw is
authoritative). Zero extra BDL calls; proven manually on 2026-07-10 (DAL@TOR 108-95,
GS@CON 79-63, GS@ATL 88-83 all recovered exactly). Fallback if a game has no snapshots: sum
`/wnba/v1/player_stats?game_ids[]=` per team (the ss_diag pattern). This fix alone un-blinds
existing WNBA arc scoring — independent value even if the rest is deferred.

## 3. Schema (all `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`, via `?action=init`)

**`sweetspot_alerts` outcome columns:**
`resolved BOOLEAN DEFAULT FALSE` · `trailer_won BOOLEAN` · `final_trailer_pts INT` ·
`final_leader_pts INT` · `resolved_at TIMESTAMPTZ`. No index changes (idx_ssa_game covers reads).

**`bets` table (D-A):** the structured side of the betting log. One row per ticket **and per
graded pass** (passes are the alpha-mining gold — what separates takes from passes inside the
band).
```
CREATE TABLE IF NOT EXISTS bets (
  id SERIAL PRIMARY KEY,
  placed_date TEXT NOT NULL,          -- slate date
  league TEXT DEFAULT 'wnba',
  game_id TEXT,                        -- FK-ish to games.id when known
  matchup TEXT, side TEXT,
  bet_type TEXT,                       -- ml | spread | total | pass
  stake REAL DEFAULT 0, odds INT,      -- american; NULL when unlogged
  result TEXT,                         -- W | L | CASHOUT | PASS | PENDING
  pnl REAL DEFAULT 0,
  grade TEXT,                          -- log grade key (A+/A-/B/C/D/F, exec suffix free-text)
  system_state TEXT,                   -- tier/subtype at entry: A|B|WATCHLIST|GAP_BASE|none
  entry_period INT, entry_deficit INT, -- gate context at bet time when known
  notes TEXT, ts TIMESTAMPTZ DEFAULT NOW()
)
```
`betting_log.md` remains the narrative source of truth; Claude writes **both** during grading
sessions (md for humans, row for joins). Backfill: 9 rows from Jun-24 → Jul-10 entries.

**`learnings.ss_json JSONB DEFAULT '{}'`** — nightly SS section (fires, results, ledger
counters, calibration delta) stored alongside existing arc findings; no shape change to v2 arcs.

## 4. db-api actions (~75 lines total)

1. **`get_sweetspot_alerts`** — params: `league` (required for WNBA per house rule), `date`,
   `game_id`, `subtype`, `tier`, `unresolved=1`, `limit` (default 50, max 200). Ordered `ts DESC`.
   Returns all columns incl. carrier + outcome. ~15 lines.
2. **`ss_ledger_summary`** — per `(league, alert_subtype)`: `n_total`, `n_resolved`,
   `realized_rate` (trailer_won share of resolved), `mean_collapse_true`, `delta_pp`,
   `graduation` = `PENDING (<30)` | `REVIEW (n≥30, |delta|≤5pp)` | `MISCALIBRATED (n≥30,
   |delta|>5pp)`. One GROUP BY. The graduation audit becomes a single curl. ~20 lines.
3. **`log_bet`** (POST body) / **`get_bets`** (`date`, `league`, `result`, `limit`) — insert +
   read for the bets table. ~35 lines.
4. `init` additions for §3. ~10 lines.

## 5. post-game-agent changes (~95 lines, all isolated + try/catch — never touches v2 arc scoring)

1. **Finals fix (§2)** — replaces the WNBA stub in `fetchFinalScores`. ~30 lines.
2. **SS resolver sweep** — for each unresolved `sweetspot_alerts` row whose game is final
   (any age, so missed nights self-heal): set outcome columns from finals. Runs before scoring.
   ~20 lines.
3. **SS scoring — three buckets, NEVER pooled** (pooling would pollute the alert-accuracy
   metrics the dashboard trends):
   - **A/B (bet signals):** correct ⇔ trailer won. Feeds a per-tier accuracy line.
   - **WATCHLIST (review cues):** not correct/incorrect — tracked as **band conversion**
     (trailer won share). A cue can't be "wrong"; the pool quality is the claim [BT 58.6%].
   - **Ledger (calibration rows):** accumulation only — counters toward n≥30 + running
     realized-vs-`collapse_true` delta. Accuracy language never applies.
   ~25 lines.
4. **Opus prompt + digest** — SS section appended to the nightly analysis prompt (fires,
   results, Manny's `bets` rows for the slate when present → agent comments on
   signal-vs-discretionary streams); one ntfy digest line, e.g.
   `SS: A 0-0 · B 1-0 · WATCH 2 (1 converted) · ledger GAP_BASE 14/30 (+2.1pp) Q4C 3/30`.
   ~15 lines.
5. **Graduation watchdog** — when a ledger subtype **crosses** n≥30 (fire-once, tracked via
   `ss_json.graduation_notified`): priority-3 ntfy proposing promote / recalibrate / retire per
   the D-5 bar. Agent proposes; Manny decides (consistent with tiered-authority design). ~15 lines.

## 6. Cascading implications (traced)

- **Poll:** untouched. Hot path risk zero.
- **Alert reasoning agent / v2 state machine:** untouched — SS remains outside its authority.
- **Learning agent v2 arc scoring:** untouched; SS lives in parallel functions + `ss_json`.
  Mitigates the agent's fragility history — a thrown SS section degrades to today's behavior.
- **Force-test hygiene:** resolver must skip `game_id = 'SS_FORCE_TEST'` (never resolvable).
- **Dashboard:** none in scope; `ss_ledger_summary` is dashboard-ready when wanted.
- **Consumers unlocked:** team-conditional tier backtest (backlogged 2026-07-10), §A1.4
  mine-the-alpha join, nightly-log ritual (Claude inserts `bets` rows while grading — the ritual
  stops being md-only).

## 7. Test plan

- Fixtures (`research/ss_ops_fixtures.mjs`, extraction style): resolver outcome mapping
  (trailer/leader/tie edge), bucket routing (A/B vs WATCHLIST vs ledger), graduation state
  machine (29→30 crossing fires once), WNBA finals reader on a canned snapshot payload.
- Live validation: `?action=init` → resolver dry-run param (`&dry=1`) on 2026-07-10 → assert
  DAL@TOR WATCHLIST resolves `trailer_won=true, 108-95` and GS@CON resolves
  `trailer_won=true, 79-63` (GS trailed at fire time) → `ss_ledger_summary` returns sane counts.
- Rerun-safety: agent rerun (delete_learning → rerun) must not double-count SS or re-fire the
  graduation ntfy.

## 8. Rollout

```
commit → push → ?action=init → post-game-agent?date=2026-07-10&dry=1 (resolver preview)
→ live rerun for 2026-07-10 → verify vs known finals → backfill 9 bets rows from betting_log.md
→ observe next nightly cron end-to-end
```

## 9. PM decisions

| # | Decision | Rec |
|---|---|---|
| D-A | `bets` table now vs md-only until first graduation | now — forward OOS wants structure from day 1; backfill is 9 rows |
| D-B | WATCHLIST scored as separate band-conversion bucket (never in alert accuracy) | yes |
| D-C | Resolver lives in nightly agent (self-healing sweep) vs poll finalization hook | agent — keeps poll untouched; sweep heals missed nights automatically |
| D-D | Graduation watchdog: priority-3 ntfy, propose-only | as stated |
| D-E | Backfill-resolve all pre-existing rows (2026-07-10 onward) on first run | yes — the sweep does this for free |
| D-F | Log PASSes as `bets` rows (stake 0, result PASS) | yes — takes-vs-passes inside the band is the §A1.4 payload |

**LOE:** ~180 lines across db-api (~75) + post-game-agent (~95) + init (~10). No poll changes,
no new cron, no new external calls beyond the existing agent's budget.
