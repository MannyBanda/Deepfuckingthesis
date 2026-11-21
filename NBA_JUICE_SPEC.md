# NBA_JUICE_SPEC.md — v1: JUICE (price watch) for the NBA cue

**Status:** BUILT Nov 21 (§15) — NBA leg ships dark until `NBA_SQUEEZE_ON=1`. **PM ask (Nov 21):** "just port over juice. Please meticulously spec." PM go: "Looks good but we can just set the thresholds we don't have to research that."
**Parent:** `SQUEEZE_WATCH_SPEC.md` v1.3 (`odds-squeeze.mjs`, WNBA, live since Jul 23). Research for the threshold:
`research/2026-11-21_nba_juice_threshold_replay.py` + `_OUTPUT.md`.

**What JUICE is:** after the engine pushes a row, JUICE watches the trailer's live moneyline every 30 seconds
across a roster of legal books. While the trailer is still down 1–9, it pushes when the best book crosses a
threshold. It routes attention: eyes on a price, never a directive and never a size.
**NBA port:** arm on every pushed NBA WATCHLIST cue, and alert when the trailer's price has become
meaningfully cheaper than the price at the cue, inside the cue's own Q2–Q3 window.

---

## 1. Research basis (verified Nov 21 before writing)

**1.1 Source walk.** `odds-squeeze.mjs` is 704 lines. It is WNBA-bound in 13 places:
- `LEAGUE` const, the `NICK` alias map, the `basketball_wnba` sport key and the ESPN `/wnba/` scoreboard path;
- `PUSHED_SUBTYPES` and the killer/A-tier thresholds;
- the autoArm / loadWatches / loadOpenPositions league filters;
- two surge SQL reads, `team_profiles season = 2026`, and the `WNBA_SQUEEZE_*` flags.

Everything else is league-neutral mechanics: band state machine, clock gate, tape, routing, links, ntfy.
`research/2026-07-23_squeeze_fixtures.mjs` 77/77 imports `composeSqueeze, implied, leaderBandOf, trailerTempOf,
efgFromRaw, probToAmerican, pickThreshold, bandStep`.

**1.2 Odds API probe (1 credit).** The NBA response carries `bookmaker.last_update`, `market.last_update` and
per-outcome deep links (e.g. FanDuel `addToBetslip?marketId=…`).
- Books posting NBA h2h on `regions=us`: betmgm, betonlineag, betrivers, bovada, circasports, draftkings, fanatics,
  fanduel, lowvig, mybookieag, williamhill_us. espnbet and hardrockbet come in on `us2`.
- Credits: 43,081 used, 56,919 remaining. The plan is 100K/month, not the 20K the PK doc says.

**1.3 FINDING — the engine's NBA price stamp can come from books you can't use.** `poll-live-bdl.fetchOddsAPIBatch`
takes the best moneyline across *every* book returned. That includes offshore books that aren't legal in AZ
(Bovada, BetOnline, MyBookie, LowVig).
- Places this stamp feeds: `line_used`, the cue push's "Live price … at {book}", the dashboard's "engine saw", and
  the `odds-api` rows in `odds_history`.
- The book isn't stored on the row, so the offshore share can't be measured after the fact.
- Gaps between the stamp and the consensus price (5 of 8 live cues, 15–65 cents, e.g. LAL −180 vs −250 consensus)
  are consistent with outlier books setting it.
- **Consequence:** these are upper bounds on prices you could actually bet:
  - the Nov 21 "best prices" table;
  - every P&L-at-stamp number (the 2-week replay's +34%, Nov 20's +$121);
  - this spec's replay.
- **WNBA:** the same function feeds the WNBA engine, so `line_used`, edge stamps, the push price and the Q1 −150
  price gate have the same exposure.
- **JUICE itself is not affected:** it is roster-limited by construction.
- Fixing the engine stamp is a separate item (§12, recommended next).

**1.4 Threshold replay.** A JUICE watch armed on every NBA WATCHLIST cue on tape: 45 cues (37 replayed Nov 5–18 plus
8 live Nov 19–20).
- How it was run: the mechanics in this spec — band, grace, suspend, ESPN stale guard, re-arm, cap.
- Caveats: descriptive, outcome-aware, LOW power, upper-bound tape (1.3).
- Baseline, entering at the cue price on every cue: trailer won 31/45, +$1,343 flat $100.

| Threshold option (Q2–Q3 window, cap 3 / re-arm .05) | Cues alerted | Alerts | Trailer won, alerted cues | $100 at 1st alert | $100 at cue, same cues | Median 1st alert |
|---|---|---|---|---|---|---|
| A — plus money (+100 or better) | 30/45 | 57 | 17/30 | +1,132 | +830 | +120 |
| **B — 10pp cheaper than the cue price** | **22/45** | **44** | **12/22** | **+599** | **−158** | **+105** |
| C — 15pp cheaper than the cue price | 16/45 | 31 | 7/16 | +377 | −330 | +130 |
| D — at/under ESPN fair (value vs ESPN) | 37/45 | 61 | 25/37 | +1,416 | +1,357 | −111 |

- **Drift split (B):** cues whose price drifted 10pp+ cheaper won **12/22**. Cues that held won **19/23**. At the cue
  price, the drifted cues made −$158 and the held cues +$1,502.
- **Through Q4 2:00 instead of Q2–Q3 (B):** +5 alerted cues, +2 wins, −$25. Q4 adds pushes and nothing else.
- **Cap 6 / .035 (WNBA) vs 3 / .05:** same first alerts, 56 vs 44 pushes.

**How to read it:**
- JUICE is a price tool for the weaker half of cues, not an edge-maker.
- On the 22 cues that drifted, the first B alert turned the cue-price result of −$158 into +$599.
- Waiting for JUICE *instead of* the cue would have skipped 23 cues that made +$1,502 at the cue.
- The better price comes with a worse game; the copy has to say so.
- Nov 20, when all five cues drifted, was not typical (22 of 45).
- D fires on nearly every cue at roughly the cue price (median −111), so it is noise.
- A duplicates the cue whenever the cue was already plus money.

---

## 2. Architecture — league-parameterize in place (recommended)

| | (a) `SQ_CFG` per league inside `odds-squeeze.mjs` ✅ | (b) separate `odds-squeeze-nba.mjs` |
|---|---|---|
| WNBA risk | refactor touches live WNBA code → pinned goldens first | zero |
| Drift | one copy of band/tape/routing/links/ntfy | two copies under source-equality fixtures |
| Ops | one cron, one `job_locks` row, one odds key | two crons racing the same lock + key |
| Precedent | `SS_CFG` engine port (`05dfcc2`, WNBA goldens `385b257`) | — |

**Shape:**
- WNBA constants move verbatim into `SQ_CFG.wnba`, and the module's functions take `cfg`.
- Handler loop: for each league whose flag is on → `autoArm(sql,cfg)` → `loadWatches(sql,cfg)`. Then
  pass 1 → sleep 30s → pass 2; each pass fetches ESPN + odds once per league that has live watches.
- The early `return {watches:0}` moves after the loop: today it would stop the NBA leg whenever the WNBA has none.
- Budget: at most 4 external calls per pass plus row writes, well inside the 60s timeout.

---

## 3. What ports, what's configured, what never crosses

- **Verbatim:** `bandStep` (band 1–9, tie / 10–11 grace on strikes 1–2, suspend on the 3rd, resume + breadcrumb) ·
  clock-frozen gate + period-flip catch-up · one watch per game (newest wins) · TTL 3h · tape write with `deficit` ·
  best-of-roster routing + Caesars tie-break + top-3 shop line · `fixLink` deep links · open-bet `posLine` ·
  ASCII ntfy titles · cycle lock · `?dry=1` / `?test=1`.
- **Configured per league:** sport key · ESPN path · alias map · roster · fallback links · armed subtypes · threshold
  function · window · cap · re-arm · priority · composer · stale guards · flags.
- **Never crosses (WNBA-calibrated or WNBA-only):**
  - thresholds −150 / +117 / −200;
  - cell rates 67 / 53 and the F5 Q4 re-entry recipe;
  - eFG period bands, fuel/temp / SHAPE NOW / STICKY, caution kernels;
  - the surge CASHOUT CHECK (cold-at-fire, −400, 7% haircut);
  - tier caps $1,400 / $600 and the lane.

---

## 4. `SQ_CFG.nba`

| Key | Value |
|---|---|
| sport / ESPN | `basketball_nba` · `…/basketball/nba/scoreboard?dates={YYYYMMDD of each live watch's game_date}` (see §6.1) |
| alias map | `NBA_NICK`, 30 nicknames (Hawks→ATL … '76ers'→PHI, 'Trail Blazers'→POR, Wizards→WAS); **word-boundary** match (`name === nick || name.endsWith(' ' + nick)`) — never `includes` (Hornets/Nets) |
| roster | Caesars, ESPN Bet, FanDuel, BetRivers, Hard Rock, DraftKings **+ BetMGM + Fanatics** (D-J5). Offshore books never. |
| armed subtypes | `['WATCHLIST']` (GAP_BASE is the silent ledger — never arms) |
| threshold | `nbaCueThreshold(row)` — §5 |
| window | Q2–Q3; first sample in Q4 → terminal disarm `q4-window` (D-J2) |
| cap / re-arm | 3 alerts per arm / ≥ .05 implied drop between alerts (D-J7) |
| priority | 4 (D-J3) |
| stale guards | per-book freshness 180s + ESPN guard via `ssPriceStale` mirror at .25 (§6) |
| surge | off |
| flags | `NBA_SQUEEZE_ON` (unset = dark; `'1'` enables) · `NBA_SQUEEZE_AUTOARM` (`'0'` = manual arm only) |

---

## 5. Threshold (D-J1) — cue-relative, 10 points of implied probability

`nbaCueThreshold(row) = toAmerican(implied(row.line_used) − 0.10)`. It is stored on `squeeze_threshold` at arm.
An alert fires when `implied(best) ≤ implied(threshold)`.
- `toAmerican` uses a NBA-specific clamp of .05–.95. The WNBA `probToAmerican` clamps at .35–.90, which would push
  an underdog's threshold the *wrong* way (+255 → +186).
- Pinned examples: −200 → −131 · −125 → +120 · −180 → −119 · −285 → −178 · −430 → −246 · −525 → −285 ·
  +105 → +158 · +180 → +289 · +255 → +450.
- No cue price stamped (`line_used` null) → fallback +100.
- Manual `arm_squeeze` on an NBA row with no threshold → stored NULL, and the next cycle's `loadWatches` fills it via
  `cfg.threshold(row)`. The db-api default today is a WNBA killer CASE that would set +117.

---

## 6. Gates per sample (NBA, in order)

1. **ESPN state**:
   - *6.1 dates:* the NBA fetch passes `dates=` for each distinct `game_date` among live watches (usually one call).
     A late West Coast game must not vanish when ESPN's default day rolls over; if it does, the watch reads `no-espn`
     and skips, never alerting on stale state.
   - `post` → disarm `final` · period ≥ 4 → disarm `q4-window` · `pre` → skip.
2. **Clock gate:** verbatim. A frozen clock skips the odds pull, except one catch-up pull on a period flip.
3. **Band:** `bandStep` verbatim, with the deficit from the ESPN score against the row's leader/trailer anchors.
4. **Odds:** one `basketball_nba` call per pass (`us,us2 × h2h`, `includeLinks`) = 2 credits, made only if ≥ 1 NBA
   watch passes gates 1–3.
5. **Per-book freshness (NBA only):**
   - a book's quote is dropped when its `market.last_update` is > 180s old at sample time;
   - field missing → kept and logged;
   - WNBA config off, so the WNBA path stays byte-identical.
6. **Best price** across the roster.
7. **Tape:** every live sample writes `odds_history` (`source 'squeeze:{book}'`, `deficit`), including samples the
   next gate rejects.
8. **ESPN stale guard:** trailer WP from the latest snapshot's `espn_wp_home`. If
   `ssPriceStale(best, espnWp, .25).stale` → no alert (`stale-quote`). No ESPN read → guard skipped, logged.
9. **Threshold cross → re-arm spacing → cap → push.** At the cap → disarm `max-alerts`.

---

## 7. Copy (fixture-pinned)

Title: `JUICE NBA: {TRAILER} {price} ({Book})`
```
{TRAILER} {price} at {Book} - was {cue} at the cue (Q{p} {clock}), {N} points cheaper.
{TRAILER} down {d}, Q{p} {clock}.
ESPN fair now: {x}%.
{LEADER} shooting {e}% eFG now ({e0}% at the cue).
Cheaper because the game got worse - cues that drifted this far have won less often than cues that held [this season, LOW].
Best: FanDuel +135 | DraftKings +130 | Caesars +125.
Tap opens: FanDuel slip.
$300 class (NBA watchlist). Staged adds = one position vs cap. Your read - not a directive.
```
- `{N}` = implied points between the cue price and now.
- `{e0}` = the row's `leader_efg`. `{e}` = the latest snapshot's `ss_leader_efg`, used only when `ss_leader_alias`
  matches the row's leader (D-7/D-8 guard); otherwise it comes from the raw box.

**Variants:**
- tie → `{TRAILER} tied it, Q… (grace read).`
- out-of-band grace → `(out of band - grace read)`
- resume → `Back in band since Q{p} {clock}.`
- open bet → the `posLine` ADD sentence after the state line
- no ESPN → ESPN line omitted
- no snapshot → eFG line omitted
- no cue price → first line reads `… - no cue price was stamped; plus-money line.`

**Drift line (D-J4):** ordering only, no numbers — the house rule is no precision and no directive below MED power.
Revisit at n ≥ 80 drifted cues.

---

## 8. Data writes and cascading consumers (traced)

**Writes:**
- `squeeze_*` columns on NBA WATCHLIST rows. The columns already exist and are league-agnostic, so there is no
  migration.
- `odds_history` tape rows with best-of-roster MLs, `deficit`, and spread/total NULL.

| Consumer | Effect on an armed NBA game | Action |
|---|---|---|
| v3 `fetchOddsHistory` (init + drawer) | latest row may be a squeeze row → the card's MARKET ML switches to best-of-roster, refreshed every 30s; spread/total untouched (null-guarded) | accept. WNBA has shipped this since Jul; arguably better (legal books). The SS price line already labels engine stamp vs card line (A1.3) |
| db-api `get_latest_snapshots` odds map | may carry a squeeze row (null spread/total) | no NBA page reads it (grepped). D-J6 |
| db-api `get_calibration` / `get_calibration_q3` joins | squeeze rows can displace the poll's line for armed games | D-J6: add `AND (source IS NULL OR source NOT LIKE 'squeeze:%')` to the three "line" reads (also corrects the WNBA research endpoints) |
| poll spread lookup (`poll-live-bdl` ~8916) | filters `home_spread IS NOT NULL` | none |
| research replays | the JUICE replay filters `source='odds-api'`; future scripts must too | noted |
| `get_ss_state`, dashboards, resolver | squeeze columns never read on the hot path; watches disarm on final | none |

---

## 9. Flags, failure modes, credits

- **Flags:** NBA flag unset → the NBA leg never runs, so the build deploys dark. WNBA flags unchanged. Each league can
  be killed independently.
- **Failures:** odds/ESPN errors are logged skips and never throw (verbatim).
- **Credits:** 2 per NBA odds call, up to 2 calls/min while ≥ 1 NBA watch is live and in band.
  - About 2.5–3.5h of armed window per night ≈ 600–840 credits/night ≈ 18–25K/month.
  - Fits the 100K plan alongside current use.
  - Log `x-requests-remaining` every call, and log a warning under 10K.

## 10. Fixtures (new `research/squeeze_league_fixtures.mjs`; the existing harness must stay 77/77 untouched)

- **[0] WNBA goldens, pinned from the pre-refactor module in their own commit:** the 24 `composeSqueeze` cases,
  `pickThreshold`, `bandStep`, aliasFromName (15 teams), and `bestPrice` on a committed WNBA event fixture —
  byte-identical after the refactor.
- **[1] NBA aliases:** every `ODDS_API_TEAMS` key, read from `poll-live-bdl.mjs` source, maps to the same alias via
  `NBA_NICK`. ESPN variants ('LA Clippers', 'Trail Blazers', '76ers') map too. No cross-hits.
- **[2]** `nbaCueThreshold` pins (§5) + clamp + null fallback.
- **[3]** `ssPriceStale` body byte-equal to `poll-live-bdl.mjs`; `SQ_CFG.nba` stale gap === `SS_CFG.nba.staleGapPp`.
- **[4] Freshness filter:** 181s dropped / 179s kept / field missing → kept; WNBA config off.
- **[5] Window:** NBA Q4 → disarm `q4-window`; WNBA Q4 2:01 → continues.
- **[6]** Cap/re-arm per league.
- **[7]** `composeSqueezeNba` — all §7 variants.
- **[8]** Armed subtypes per league (GAP_BASE never arms).
- **[9] Decision-replay golden:** the pure pipeline over a committed Nov 20 tape slice for the 5 cues reproduces the
  replay script's first-alert price, time and count.
- **[10] Isolation:** NBA flag off → zero NBA fetches (mocked fetch counter); WNBA `'0'` → the NBA leg still runs.
- Plus `node -c` and every standing harness green.

## 11. Rollout

1. Spec go.
2. Commit A: the WNBA goldens pinned against the untouched module.
3. Commit B: refactor + NBA config + fixtures + db-api arm default (+ D-J6). Deploys with the NBA dark.
4. Validate:
   - `?test=1&league=nba` → real NBA odds; tap the deep link to confirm it opens the slip;
   - `?dry=1` during a live slate → gate audit per watch.
5. You set `NBA_SQUEEZE_ON=1`.

## 12. Out of scope — separate items

- **Engine price-stamp roster (finding 1.3), recommended next:** restrict `fetchOddsAPIBatch`'s best price to legal
  books, or at least stamp the book on the row. Touches both leagues' push price, `line_used`, edge stamps and the
  WNBA Q1 price gate, so it needs its own spec with cascades.
- NBA cash-out check (the WNBA surge is WNBA-calibrated).
- A v3 JUICE row on the live card (armed · alerts · last price).
- Notification limits + escalation parity (queued). JUICE's cap is per-arm; a nightly push budget belongs there.
- The nightly review counts JUICE alerts.

## 13. Size

- `odds-squeeze.mjs` 704 → ~920 lines.
- `db-api.js` +3 lines (arm default), +3 more with D-J6.
- New harness ~280 lines + a tape fixture.
- No schema change, no `poll-live-bdl` change, no dashboard change.

## 14. PM decisions

| # | Decision | Recommended | Alternatives |
|---|---|---|---|
| D-J1 | Threshold | **B — 10pp cheaper than the cue** | A plus money · C 15pp · D ESPN value |
| D-J2 | Window | **Q2–Q3** (cue window; Q4 added nothing on tape) | through Q4 2:00 (WNBA parity) |
| D-J3 | Push priority | **4** | 5 (WNBA juice) · 2 (NBA cue) |
| D-J4 | Drift line in copy | **on, ordering only** | off |
| D-J5 | Roster | **WNBA six + BetMGM + Fanatics** | WNBA six only |
| D-J6 | "Line" joins skip squeeze tape | **yes** | no |
| D-J7 | Cap / re-arm | **3 / .05** | 6 / .035 (WNBA) |

---

## 15. Build notes (Nov 21)

- **Decisions:** D-J1–D-J7 as recommended. The threshold gap is a setting, not research: env `NBA_SQUEEZE_PP`
  (default `0.10`; anything outside 0–0.5 falls back to 0.10). It is read when a row arms and stored on
  `squeeze_threshold`, so a change applies to the next cue, not to watches already armed.
- **Commit A** pinned WNBA behavior from the untouched module: 22 `samplePass` traces (every DB write, every push) +
  arm/load + pure helpers → `research/fixtures_squeeze_wnba_goldens.json`. The refactor reproduces them byte-for-byte.
- **Pre-existing bug fixed (both leagues):** pass 2 of an invocation reused the watch object from pass 1, but an
  alert's last price / count were written only to the DB. Pass 2 could push the same price again 30s later (and burn
  NBA's cap of 3 in two pushes). The watch object now syncs after each alert. Two-pass fixture pins it.
- **`?league=nba|wnba`** scopes manual `?dry=1` / `?test=1` calls. `?dry=1&league=nba` audits NBA gates with the flag
  off; a plain `?dry=1` still runs only the legs whose flags are on.
- **Fixture [9]:** the real `samplePass` over the committed Nov 20 tape (`research/fixtures_nba_juice_tape_nov20.json`)
  matches the replay script (cap 3 / .05, option B, Q2–Q3) on all 5 cues: first-alert price, period, clock and count.
  The harness neutralizes the clock gate (snapshots ~95s are coarser than the tape ~67s, so a shared snapshot is not a
  stopped clock).
- **Harness:** `research/squeeze_league_fixtures.mjs` 182/182; `2026-07-23_squeeze_fixtures.mjs` 77/77 untouched.
- **Size:** `odds-squeeze.mjs` 704 → ~990 lines; `db-api.js` +4.

