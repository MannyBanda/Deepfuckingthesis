# Player-Level Data Assessment — WNBA / Sweetspot §4c

**Date:** 2026-06-28
**Author:** Claude (lead eng), with Manny (PM)
**Scope:** The `SWEETSPOT_ENGINE_SPEC.md` §4c parked task — map how player-level data currently
enters the system and decide how the official BDL `/player_stats` feed is incorporated
(live analyst vs backtest; supersede vs complement). Plus Direction-2 (individual-heater)
backtest phase-1 exploration.
**Status:** Assessment complete. Decisions D1–D4 resolved. Direction-2 phase-2 scoped (not built).

---

## TL;DR

- The spec under-weighted what's already wired: **the WNBA poll loop already fetches
  `/player_stats` every cycle** (it's the primary box source — no `box_scores` endpoint for WNBA).
  The per-player rows already survive onto `modelSummary.{home,away}.players[]` via `bpa()`,
  **including `pf` (fouls), `plus_minus`, and `minutes`** — then get aggregated to team totals
  and the granularity is discarded.
- **Live analyst (4c) needs NO new fetch.** The per-player data is in-memory at the
  `fireSweetSpotAlert` call site; today that function receives only the ~6 gate outputs (`ss`),
  not the box. Integration = widen the signature + a concentration/foul digest in the composer.
- **Backtest needs a bulk pull** because `raw_stats_json` persists team-level aggregates only —
  no per-player rows on historical snapshots. Done here: 16,571 player-game rows, 720 games,
  2024–2026.
- **Direction-2 finding:** hot shooting has **zero between-game persistence** (β = −0.037) →
  strongest data-backed support for the fade thesis at the player level. But **final-box
  concentration does NOT separate winners from losers** → the edge is trigger-time +
  shot-sustainability, never raw final-box concentration. The exact live signal (within-game
  2nd-half regression) requires PBP reconstruction = Direction-2 phase-2.

---

## 1. Current player-data entry points (code-mapped)

| # | Path | Location | Fields | Notes |
|---|------|----------|--------|-------|
| A | `/player_stats` batch → `wnbaPlayerStatsCache` → `buildSummaryFromBDLPlayerStats`/`bpa()` → `modelSummary.*.players[]` | server poll (`poll-live-bdl.mjs`) | **full box incl `pf`, `plus_minus`, `min`** | Primary WNBA box source. Per-player computed then collapsed to team totals; granularity **discarded**. |
| B | `compilePBPPlayerStats` | **client only** (`wnba-bdl.html:1000`) | box from PBP text regex (**no `pf`/`min`/`+−`**) + shot zone/context | Dashboard display. ~95% name accuracy (regex → "?" on unparseable). |
| C | `season_cache` | `poll-live-bdl.mjs` / `db-api.js` | player season avgs | **NBA-only.** WNBA never populates it; no `/wnba/v1/season_averages` endpoint. |

Server-side per-player shot geography also exists but is unused: `parseBDLPBPServer` emits
`raw.shots[]` = `{ p, tm, z(zone), m(made), a(assisted), q(quarter), ctx(context), is3, x, y }`
every poll (server name-extractor `bdlExtractPlayerS` handles Jr./III/hyphens/apostrophes), but
the per-zone `byPlayer` arrays are returned empty `[]` — rows exist, not rolled up per player.

---

## 2. Official `/player_stats` vs PBP-derived — **complement, not supersede** (D2)

| Dimension | Official `/player_stats` (server) | PBP-derived (client `compilePBPPlayerStats`) |
|---|---|---|
| Fouls / minutes / +− | ✅ all three | ❌ none reconstructable |
| Box (pts/fg/reb/ast/stl/blk/to) | ✅ structured | ✅ ~95% (regex) |
| Shot zone / context (drive, pullup, above3) | ❌ | ✅ — its unique value |
| Where it lives | server poll | client only |

**Verdict:** complement. Official = box truth (concentration, fouls); PBP = shot geography.
For the server-side analyst the question is moot anyway — the PBP-player parse is client-only, so
the official feed (`modelSummary.*.players`) is the only server per-player source and it's correct.

**D2 sub-decision (per-player shot geography for the analyst) — LOE finding:** the raw per-player
shot rows already exist on `raw.shots` every poll. A per-player shot digest is a **~15–30 line
reduce** over data in hand (no new fetch/parse), and it's **quarter-filterable** (checkpoint-aware
for free). **Low LOE, real non-redundant value** (rim/drives = sustainable vs above-arc pullups =
mirage; the "shot-type variance-vs-rim" term of the Direction-2 composite). → **fold into 4c
context.** Build the reduce in the phase-2 research script first, port the proven logic into the
composer. The same reduce is the mechanism for trigger-time per-player state in the backtest.

---

## 3. Persistence — live vs backtest split

`raw_stats_json` serializes **team-level aggregates only** (`home:{stl,oreb,to,…}`, `away:{…}`,
`runs6`). No per-player rows persist. Therefore:

- **Live analyst:** data in-memory at the poll → zero new fetch, thread `modelSummary.*.players`
  (D1: uniform BDL shape; `summary` flips ESPN/BDL shape by ESPN availability) into
  `fireSweetSpotAlert`.
- **Backtest:** historical snapshots carry no per-player data → bulk `/player_stats` pull required
  (done, §5). The pull doubles as the source of per-player season baselines ("vs own norm"),
  since `season_cache` is NBA-only.

---

## 4. Data-quality flags (empirically verified)

- **BDL returns `null` for zero, not 0** (`pf` sample `[None,6,2]`; `fg3m` populated 9/26 because
  most players hit no threes). Across the pull: null `pf` **34.1%**, null `plus_minus` **17.1%**.
  Coercion `Number(x)||0` mandatory in composer + all backtest scripts. `bpa()` already does this.
- `min` is a **string** (`'26'` or `'26:30'`).
- Live mid-game population confirmed (accumulating partial lines); **completed games expose the
  final line only** (no historical time-series from `/player_stats`).
- Name reliability favors the structured feed over the regex parse.

---

## 5. Direction-2 backtest — phase-1 exploration

**Sample:** 16,571 player-game rows, 720 games. Seasons 2024 (264 g), 2025 (312 g),
2026 (144 completed). Pulled via `/wnba/v1/player_stats?seasons[]=S` (cursor-paginated),
slimmed to `/tmp/wnba_ps_{season}.json`.

### 5.1 Coverage & baselines
546 player-seasons; **459 with ≥10 g** (median 20 g), 283 with ≥20 g. Season baselines
(ppg / TS% / eFG% / 3-rate / FTA-rate / mpg) built for the 459. Spot-check sane
(A'ja Wilson '24: 26.0 ppg, 59.2 TS; Plum '26: 65.3 TS on .43 three-rate). **The "vs own norm"
denominator is well-supported.**

### 5.2 Heater magnitude — raw TS-vs-norm is noise
Single-game TS deviation from own season norm (min ≥12, FGA ≥5, n=8,410): **SD = 0.183 (18pp)**;
**28%** of games run >+10pp over the player's own baseline, **19.7%** >+15pp. Heaters are frequent
and large → a **raw** "hot vs norm" trigger fires constantly → useless standalone. Strong argument
**for** the composite design, **against** any raw-TS heater trigger.

### 5.3 Final-box concentration — NULL result (guardrail)
Top-scorer share (n=1,440 team-games): **winners 0.271 vs losers 0.268 (Δ −0.003)**, flat across
close/mid/blowout buckets. Cutting the other way: high-concentration team-games (top scorer ≥35%)
win **52.2%**; balanced (<22%) win **44.7%** — i.e. concentration at the final box tilts *slightly
toward winning*, the opposite of the naïve "concentrated lead = fragile" read.
**Interpretation:** the final box is the wrong instrument (it reflects the outcome; the thesis is
about the *leader at the trigger* with *unsustainable* scoring). Raw concentration is **not** a
standalone signal — the edge lives in trigger-time + shot-sustainability. Kills a tempting shortcut.

### 5.4 Hot persistence — full between-game reversion (thesis support)
Consecutive qualifying games per player (n=7,726 pairs): **corr(dev_this, dev_next) = −0.037,
slope β = −0.037** → ~100% of a game's over/under-performance vs norm evaporates by the next game.
Regression curve flat at ~norm across the whole range (a +20pp scorching game → next-game −0.5pp).
After a scorching game (+15pp): **37.8% stay hot (>+5pp), 51.5% regress to/below norm**, mean next
dev −0.005. **Hot shooting is variance, not persistence** — the fade thesis's core premise, now
data-backed at the player level. Between-game reversion is a proxy/lower-bound for the within-game
2nd-half version.

### 5.5 Limitation → phase-2
`/player_stats` gives final lines only for completed games. The **live** signal (leader hot at
end-Q2/Q3 → 2nd-half regression closes the gap) needs **trigger-time per-player state**, obtainable
only via PBP reconstruction (period-filtered per-player accumulation + shot zones — the §2 reduce,
extended over historical PBP). That is Direction-2 phase-2.

---

## 6. Decisions (resolved)

- **D1 — analyst per-player source:** read off `modelSummary` (uniform BDL shape;
  `pf`/`plus_minus`/`min`) — NOT `summary` (ESPN/BDL shape-flip). Concrete correction to the §4c
  arch, which currently lists `summary`.
- **D2 — supersede vs complement:** complement; official = box-truth for the analyst; PBP-derived
  stays for shot context. Per-player shot geography folded in (low LOE, §2).
- **D3 — MVP signal set:** fold in the full set — scoring concentration, foul trouble (`pf≥3` on
  starters), who's-carrying-the-comeback, bench load, plus minutes/rotation and plus_minus.
- **D4 — backtest:** phase-1 bulk pull done (this doc). Phase-2 (PBP reconstruction) scoped, pending
  go-ahead.

---

## 7. Direction-2 phase-2 scope (NOT built — needs go-ahead)

**Hypothesis:** a leader whose lead is carried by a heater (concentrated + running hot vs own norm +
from unsustainable shot types), caught at a catchable deficit mid-game, regresses in the 2nd half
more than the line implies → fadeable.

**Build:** historical PBP pull (~720 games) → period-filtered per-player accumulation at end-Q2/Q3
(concentration + shot-zone mix at the checkpoint) → join to 2nd-half per-player regression + game
outcome + (where available) line. Metric = lead-DEPENDENCE composite (top-scorer share + TS/eFG vs
own norm + shot-type variance-vs-rim + support-cast vacuum), NOT raw TS. Clears the bar only if the
composite-at-trigger separates outcomes materially OOS.

**Artifacts:** `/tmp/wnba_ps_{2024,2025,2026}.json` (player rows), `/tmp/wnba_games_{season}.json`
(game meta). Baselines recomputable from the player rows.
