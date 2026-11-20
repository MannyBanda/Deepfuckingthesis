# NBA SWEET SPOT DASHBOARD — `bdl.html` pregame + live Sweet Spot views

**Parent:** `NBA_SWEETSPOT_PORT_SPEC.md` v1 · `NBA_SWEETSPOT_PORT_PHASE1_SPEC.md` (Phase 1 + 1b SHIPPED `05dfcc2`/`c01a4d0`) · sibling of `SWEETSPOT_VERDICT_STRIP_SPEC.md`, `SWEETSPOT_DASHBOARD_PARITY_SPEC.md`, `TEAM_CTX_SURFACING_SPEC.md`
**Date:** 2026-11-19 · **PM ask:** "spec dashboard changes to get the nba app the same sweetspot pregame and live game views as the wnba" · **Status:** SPEC — nothing built. Each phase is its own go.

**Goal:** `bdl.html` gets the Sweet Spot surfaces `wnba-bdl.html` has — a server-authoritative verdict box on every live card, a matchup sheet behind the hero, a pregame read, a season-context panel — **rendering only what the NBA engine can honestly say today**. The WNBA surfaces are built on five calibrated layers the NBA does not have (fine-arena cells, comeback priors, eFG bands, fuel/temp kernels, killer/lane profiles). The NBA versions carry the facts the engine writes (gap, as-of records, leader eFG, lead class, observed line, ESPN fair, the forward ledger) and print **no number the NBA has not earned** — the exploratory cell appears once, tagged, and is replaced by the forward log on a pre-named switch.

---

## 1. What exists today (inventory, both dashboards)

### 1.1 `wnba-bdl.html` Sweet Spot surfaces (what "the same views" means)
| # | Surface | Where | Reads | NBA-portable? |
|---|---|---|---|---|
| W1 | Record badge + **EK chip** on hero aliases | hero | `get_team_profiles` (killer flag) | badge YES (from `standings_cache`) · EK **NO** (killer mechanism validated on WNBA; tooltip quotes WNBA 67/53) |
| W2 | **ctx micro-strip → MATCHUP SHEET** (archetype, eFG/TO/FTA/OREB diffs, vs-top/rest, inflation badge, L5 tags, H2H, GAP line, killer-cell candidate) | under hero, tap | `team_profiles` (nightly, WNBA-only) | **lite version only** — no NBA profiles exist; see §4 |
| W3 | **BRIEFING** block (GAME_BRIEF pregame narration + fired-row narration) | inside sheet | `get_sweetspot_alerts` narration_text | **NO** (NBA narration off by config — zero tokens) → replaced by a mechanical PREGAME READ |
| W4 | **SS VERDICT BOX**: gate line → CELL READ → chips (temp dot, EK) → SEASON CONTEXT panel → VERDICT (V0–V8 + traps) → FUEL/TEMP block (HOLDER READ, caution kernels, STICKY) → evidence lines → as-of | top of Scoring Comp section | `get_ss_state`, `ss_ledger_summary`, client PBP comp, `computeFuelTemp` | gate line YES (NBA form) · CELL READ **NO** (SS_STRUCT = WNBA fine arena) → CUE READ · SEASON CONTEXT **NO** (SS_SEASON26) → FORWARD LEDGER panel · VERDICT YES (reduced table) · FUEL/TEMP + kernels + STICKY **NO** (band-dependent, 2026 WNBA numbers) · evidence lines YES · as-of YES |
| W5 | Fetch layer: `fetchSSState` 55s TTL / 60s timer on the active card, prefetch all cards post-init, render-miss kick, in-flight guard, frozen on `closed` | — | `get_ss_state&league=wnba` | YES — re-parameterized for a multi-card grid (§3.4) |

### 1.2 `bdl.html` today (what the NBA card already has to build on)
- Card = `renderCard(game)` (~9893); multi-card **grid** (`selIds`, `renderGrid`, `mountCard`), 10s `refreshLiveCards`, per-card 1s countdown timer pre-tip. No single "active card" — every selected card is live.
- Sections are `_secHdr/_secOpen` collapsibles; **SCORING COMPOSITION** (~10370) is the natural mount (same slot the WNBA uses) and already has a lead-composition read (`cs.clientLeadComposition`: structural/variance margins, classification).
- PBP zone object `cs.pbpAudit.{home,away}.{rim,paint,mid,threes}` has the **same shape** `computeScoringComp` consumes → the WNBA evidence lines port verbatim.
- `cs.espnWP = {home, away, opening, time}` (0–100) live on the card; `cs.oddsData = {homeSpread, homeML, awayML, total, time}` (strings) from the MARKET section.
- `standingsCache` is filled by a **direct BDL call with `season:'2025'` hardcoded** (`fetchStandings`, ~1484) → the NBA hero badges show **last season's** records right now. Pre-existing landmine; fixed by §3.1.
- `getState(g)` → PRE / LIVE / FINAL, identical semantics to the WNBA file.

### 1.3 What the NBA engine writes (Phase 1 + 1b, live now)
- Every NBA snapshot: `ss_leader_alias`, `ss_leader_wp`, `ss_trailer_wp` (≥5 GP, as-of from `standings_cache`), `ss_quality_gap`, `ss_leader_efg` (×100, 1dp), `ss_variance_share`, `ss_lead_class`, `ss_line_used` (observed best ML, live/pregame mix). **Null:** `ss_leader_efg_band`, `ss_fade_tier`, `ss_collapse_tier`, `ss_collapse_true`, `ss_implied`, `ss_edge`, `ss_kelly_size`, `ss_alert_tier`; `ss_alert_fired=false` always.
- With `NBA_SS_LEDGER_ON` / `NBA_SS_WATCHLIST_ON`: one `GAP_BASE` row per game (gap ≥ .15 · Q2–Q3 · deficit 1–9) and one `WATCHLIST` row per game (× leader eFG ≥ 57), `player_ctx_json.priceStale = {stale, implied, espnWp}`, resolved nightly (`trailer_won`). `ss_ledger_summary&league=nba` returns realized trailer-win% by subtype (predicted null — no prior).
- `get_ss_state&league=nba` already works: snapshot ss_* + game row + rows/subtypes + `fire_review` (NBA rows carry deficit/gap) + `fuel_at_fire` (always null for NBA).

---

## 2. Honesty rules for the NBA surfaces (govern every line of copy)

- **N1 — no WNBA-calibrated number on an NBA surface.** `SS_STRUCT`, `SS_SEASON26`, `comebackProb`, `EFG_BANDS`, `computeFuelTemp`, `ssCautionLines`, HOLDER READ, STICKY, the EK chip, the inflation badge, override-lane copy, trap T1 ("Jun 21, 1-for-7") and T4 ("POR@CHI rule") are **not** mirrored into `bdl.html`. The only WNBA-origin pure functions that cross over are definitional, not calibrated: `computeScoringComp`, `ssLeadClassDisplay`, `ssGapFmt`, `americanToImplied`, `ssPriceStale` — each under a **source-equality fixture** (the aliasMap/SS_STRUCT treatment).
- **N2 — one exploratory constant block, tagged, with a pre-named exit.** `SS_NBA_EXPLORATORY = { asof:'2026-11-19', source:'aaf0ec8', cue:{ p:74.4, espn:50.1, n:39 }, gapBase:{ p:null, edge:+6.0, ci:11.8, n:66 } }` — GENERATED by a build script from the committed exploratory output (never hand-edited), rendered **only** with the words `[this season · exploratory · LOW]`, never as a rate the bettor should act on, never inside the verdict head. **Switch:** when `ss_ledger_summary&league=nba` shows `WATCHLIST n_resolved ≥ 30`, the CUE READ prints the forward number and drops the exploratory one; the constant block stays in the file for the FORWARD LEDGER panel's "origin" line only.
- **N3 — the forward ledger is the headline.** The thing Phase 1b exists to produce (how the cue converts, in rows, this season) gets its own panel and is always visible on LIVE and FINAL cards. Realized % is labeled trailer-WINS and carries n and a power tag (LOW <80 / MED 80–200 / HIGH ≥200). Below MED: ordering words only ("running above / around / below ESPN"), no precision in the verdict.
- **N4 — ESPN is the fair price on NBA surfaces** (the audit and the exploratory both used it). Every price line pairs the book's number with ESPN's live fair and the stale flag; the dashboard never shows an "edge" or a size for the NBA.
- **N5 — the dashboard never recomputes a gate.** Gap, win%s, leader eFG, lead class and rows come from `get_ss_state` (server stamp). The client computes only (a) the evidence lines from its own PBP comp, (b) the live price read from the card's own ESPN WP + odds, (c) the pregame gap from `standings_cache` records before the first snapshot exists.
- **N6 — R4 (Q4 inside 5:00) and R2 (WIN/HOLD labels)** carry over unchanged; the NBA cue window is Q2–Q3, so any Q4 state prints the window-closed line and no number.

---

## 3. Phase D1 — LIVE VIEW (verdict box on every NBA card)

### 3.1 Server (db-api.js, one new action — the only server change in D1)
`get_standings&league=<l>` → `SELECT team_alias, wins, losses, updated_at FROM standings_cache WHERE league = $1` → `{ standings: { ALIAS: { w, l, updated_at } }, age_s }`. One definition of "record" for the engine's gap **and** the dashboard's badges/pregame sheet (the elite-definition lesson). `bdl.html` `fetchStandings` switches to it (BDL direct call kept as fallback **only** when the cache is empty, with the season derived `d.getMonth() < 9 ? y-1 : y` — never a literal). Fixes the `season:'2025'` badge bug on the same commit. `confRank` (the badge's `(3rd)`) is not in the cache → keep the BDL call for rank only, derived season, 6h TTL; records come from the cache.

### 3.2 Client — pure functions (mirrored or new; all fixture-extracted)
Mirrored verbatim from `poll-live-bdl.mjs` under source-equality fixtures: `computeScoringComp`, `ssLeadClassDisplay`, `americanToImplied`, `ssPriceStale`. Mirrored from `wnba-bdl.html`: `ssGapFmt`.

New (NBA-only, `bdl.html`, fixture file `research/ss_nba_dashboard_fixtures.mjs`):

- **`ssGateLineNba(st)`** → `GAP .39 STRONG · LDR .36 / TRL .75 · LEAD: variance-built`
  - gap seg: `—` / `below bar` (<.15) / `qualified` (.15–.35) / `STRONG` (≥.35) — same tiers as the WNBA gate line (gap tiers are gate definitions, not calibrated rates).
  - no "FADE COUNTRY / WATCH-ONLY" (no validated NBA leader-quality tier); both win%s printed instead.
  - lead seg: `ssLeadClassDisplay(ss_lead_class)`; `margin ≤ 2 → LEAD: too thin to read`. No fuel word, no temp chip, no EK.
- **`ssCueReadNba(st, ledger)`** (replaces CELL READ) — returns null when the gate line owns the state (gap <.15 / null; deficit out of 1–9):
  - Q4 (any clock): `Q4 — cue window closed (the NBA cue is Q2–Q3 only). No late-game NBA numbers exist.` (R4 for <5:00 is implied by the window.)
  - Q1: `Gates read from Q2 — Q1 shot samples are too thin for an eFG cue.`
  - Q2–Q3, gap ≥.15, leader eFG ≥ 57: `WATCH SHAPE — the better team is down N to a hot leader (eFG 64%).` + ledger clause: if forward `WATCHLIST n_resolved ≥ 30` → `Forward log: trailers WIN X% [n=N, TAG] vs ESPN.` else → `[this season · exploratory · LOW] trailers WON 74% vs ESPN 50% on 39 Q2–Q3 spots through Nov 19 — forward log collecting (N/30).`
  - Q2–Q3, gap ≥.15, leader not hot: `GAP SPOT — gap qualifies, leader not hot (eFG 52%). The base shape has run about even with ESPN this season; the ledger is collecting it (N/30).`
- **`ssPriceLineNba(st)`** → `ESPN fair for DEN 61% · book DEN +140 (implied 42%) ⚠ may be pregame` — `st.espnTrailerWp` from `cs.espnWP` (live), `st.trailML` from `cs.oddsData` (card's own line), stale via mirrored `ssPriceStale` with the **same .25 gap** as the server (pinned: `SS_NBA_STALE_GAP = 0.25`, fixture asserts equality to `SS_CFG.nba.staleGapPp` by grep). No odds on the card → `no line on the card — tap MARKET to add one`. No ESPN → omit the fair clause.
- **`ssVerdictComposeNba(st)`** — reduced V-table, first match wins. Row anchoring (D-7/D-8) and the V8 final-freeze rule are copied **as logic** from the WNBA composer; the copy is NBA's:
  | V | condition | copy |
  |---|---|---|
  | V1 | `WATCHLIST` row, row trailer still trails 1–9 | `REVIEW — {trailer} is the better team ({gap} quality gap) down {rowDef} to a hot leader. Not a bet call; your read decides. See the push.` (blue) |
  | V3 | `GAP_BASE` row, in band | `GAP SPOT, LOGGING — gap qualifies, leader not hot. Ledger is collecting this shape ({n}/30 resolved). Not a validated bet.` (secondary) |
  | V0 | period < 2 | `Gates read from Q2 — no verdict yet.` (dim) |
  | V4 | gap null or < .15 | `NO SPOT — quality gap ({gap} or "no standings gap") is below the review line (.15). Anything taken here is the speculative stream — size like it.` (dim) |
  | V6 | p < 4, deficit ≥ 10 | `OUT OF BAND — {trailer} down {d}: outside the 1–9 window. No chasing.` (coral) |
  | V7 | p ≥ 4 | `Q4 — the NBA cue window closed after Q3. Nothing fires here; your read decides.` (secondary) |
  | VX | else (Q2–Q3, gap ≥ .15, no row yet) | `READ FORMING — gap qualifies, no row yet (next server read lands in about a minute).` (dim) |
  | V8 | game closed → append `Final A-B — {rowTrailer} completed the comeback / did not come back.` | — |
  - **Traps (one max):** T5 only, NBA-evidenced: leader eFG ≥ 57 with gap < .15 → `⚠ Hot leader without a quality gap — heat alone was a null on 1,200 NBA games (deficit-controlled) and ran negative this season against a worse/even trailer. Heat only matters ON TOP of a gap.` T1/T4 (WNBA kills) are not rendered. `Line dead.` suffix on |ML| ≥ 50,000 stays.
  - No V2-style ".20 bar" clause (that bar is Manny's WNBA line); no V5 (`collapseTier` is null for NBA).
- **`ssForwardLedgerPanelNba(ledger, exploratory)`** (replaces SEASON CONTEXT) — tap-to-expand under the cue line, mono, three rows: `WATCHLIST  n_resolved · trailer-WINS X% · TAG` / `GAP_BASE   n_resolved · trailer-WINS X% · TAG` / `origin: exploratory cell +24pp vs ESPN, n=39 LOW, as of 2026-11-19 (aaf0ec8)`; a fourth line when `n_resolved < 30` for WATCHLIST: `switch to forward numbers at 30 resolved`. Reads `ss_ledger_summary&league=nba` (cached per session, same 55s TTL discipline).

### 3.3 Client — `renderSSVerdictBoxNba(id, cs, hA, aA)` (anatomy, top → bottom)
1. Gate line → 2. Cue read → 3. Price line → 4. FORWARD LEDGER (collapsed by default; open by default when a `WATCHLIST` row exists for the game) → 5. VERDICT head + trap → 6. Evidence lines (`LEADER'S ENGINE (shot mix)` / `THE LEAD`, verbatim from the WNBA box, fed by `computeScoringComp(cs.pbpAudit, hA, aA, pts)`) → 7. `server read as of Q{p} {clock}`.
Mount: first element inside the SCORING COMPOSITION body (same slot as the WNBA box); the section auto-opens on a card whose game has any `sweetspot_alerts` row. Stale guard (snapshot ts > 3 min on a LIVE game → `updating…`) carried over. Tap target → MATCHUP SHEET (Phase D2); until D2 ships the box is not tappable.

### 3.4 Client — fetch layer for a multi-card grid
`fetchSSState(gameId, force)` ported with these changes: per-card 55s TTL, **one** 60s timer that walks `selIds` (not an active card) staggered 150ms apart; prefetch all mounted cards post-init (600ms + i×150ms, as the WNBA does); render-miss kick; in-flight guard; frozen once `game.status==='closed'` and a read exists; empty-snapshot entries retry at 15s. Ledger summary fetched once per session (`_ssLedgerCache`), refreshed when a card goes FINAL (so the panel's n ticks the next morning without a reload).

### 3.5 Cascading implications (traced)
- `get_ss_state` is five isolated queries per call; at 6 cards × 1/min that is 30 small indexed reads/min — the WNBA pays the same per card. Netlify function budget: negligible.
- `standings_cache` becomes a read path for the dashboard; the writer is still only `fetchStandingsCache` (poll function). Cache is refreshed every ~20h → badges can lag a day, same as the engine's gap (one definition, one staleness).
- `bdl.html` CSS: reuses existing tokens (`--b1/--t2/--amber/--green`); no new stylesheet. The WNBA box's inline styles use `--bg-surface-2/--hairline` tokens that **do not exist** in `bdl.html` → map to `--b2/--b1` at port time (build step; fixture pins no `var(--hairline` string in the ported block).
- Dead code: `fetchStandings`'s hardcoded `season:'2025'` goes; nothing else removed.
- `NBA_PAUSED`: irrelevant to the dashboard (reads only).

### 3.6 Fixtures (`research/ss_nba_dashboard_fixtures.mjs`, new)
Source-equality: `computeScoringComp`, `ssLeadClassDisplay`, `americanToImplied`, `ssPriceStale` byte-equal between `poll-live-bdl.mjs` and `bdl.html`; `ssGapFmt` byte-equal to `wnba-bdl.html`; `SS_NBA_STALE_GAP === SS_CFG.nba.staleGapPp`. Pure-function pins: gate line (gap tiers, thin margin, class display, null safety), cue read (Q1/Q4/hot/not-hot/below-bar/out-of-band, exploratory vs forward switch at n=30), price line (stale/not/absent), verdict table (every V, anchoring, V8 freeze, T5 only, line dead), ledger panel (power tags). Grep gates: no `SS_STRUCT`, `SS_SEASON26`, `computeFuelTemp`, `ssCautionLines`, `comebackProb`, `EFG_BANDS`, `ekBadge`, `STICKY` inside the NBA SS block. `node -c` on the extracted script block.

### 3.7 Size
~520 lines in `bdl.html` (mirrors 90 · gate/cue/price/verdict/panel 200 · render + fetch 160 · standings swap 30 · CSS 0 · comments 40) · db-api +15 · fixtures ~200. No migration. Reversible: `renderSSVerdictBoxNba` is additive inside one section.

---

## 4. Phase D2 — PREGAME VIEW + MATCHUP SHEET (lite)

### 4.1 What the pregame card shows (replaces the WNBA GAME_BRIEF role, zero tokens)
A **PREGAME READ** block under the hero (PRE state only; stays on the card as the first line of the sheet once LIVE):
```
PREGAME READ — as-of records DEN 9-4 (.692) · POR 4-9 (.308) · gap .38 STRONG
If POR leads in Q2–Q3 by 1–9 → DEN is the watch trailer (hot-leader cue needs POR eFG ≥ 57).
If DEN leads → no spot (gap runs the wrong way).
This season: DEN 2 watchlist cues as trailer (2 WON) · POR 1 (0). Forward ledger: WATCH 7 resolved · 71% [LOW].
Standings as of Nov 19 03:10 · line: POR +310 / DEN −400 (pregame)
```
- Records/gap from `get_standings&league=nba` (the engine's own cache). Per-team cue history from `get_sweetspot_alerts&league=nba&limit=400` (one fetch per session, filtered client-side by alias). Ledger line from the same `_ssLedgerCache`. Line from `cs.oddsData` when present.
- Both directions are stated (which team would be the trailer-of-interest) — this is the pregame version of the whose-side-is-the-gap read, and it is the only pregame "verdict" the NBA engine can honestly give.
- No narration, no archetype, no identity diffs (none exist for NBA). The block says `NBA pregame narration is off (zero-token mode)` in the sheet footer so the empty BRIEFING slot is explained, not mysterious.

### 4.2 MATCHUP SHEET (lite) — tap target for the hero strip and the verdict box
Columns per team: alias · record · win% · GP guard (`<5 GP — no gap yet`) · **season eFG / opp eFG / L10 record** (Phase D3 data — rendered `—` until it exists) · this-season cue history (rows as trailer, won). Center: GAP line (`ssGapFmt`, tier word), and the PREGAME READ sentence pair. Footer: standings as-of, ledger line, zero-token note. Same overlay mechanics as the WNBA sheet (`openMatchupSheet/closeMatchupSheet`, `ms-*` classes ported with token mapping).

### 4.3 Size
~260 lines in `bdl.html` (pregame block 80 · sheet 120 · fetch/cache 40 · CSS 20) + ~80 fixture lines (pregame copy pins both directions, GP guard, missing-line/missing-ESPN paths).

---

## 5. Phase D3 — NBA team profile *lite* (server, optional, zero tokens)

What the sheet's `—` cells need and nothing more: per team-season **season eFG, opponent eFG, pace proxy, L10 record, H2H this season**, computed nightly from the **final snapshots already in `snapshots.raw_stats_json`** (the exploratory proved every field is there) — no new API calls. New action in `team-profiles-nightly.mjs` guarded `league==='nba'` writing `team_profiles` rows with `profile = { lite:true, efg, opp_efg, pace, l10:{w,l}, h2h:{} }` and **no** `killer` / `tiers` / `elite` / `identity` keys (so no consumer can mistake it for a WNBA profile; `ensureTeamCtx` stays `league==='wnba'`). `get_team_profiles&league=nba` already works. The dashboard's `—` cells fill themselves. ~180 lines + 40 fixture lines (golden from three committed finals). **Not** a prerequisite for D1/D2.

---

## 6. Build order, verification, rollback
1. **D1** (one commit): db-api `get_standings` → `bdl.html` mirrors + pure functions + render + fetch layer + standings swap → fixtures → `node -c` (extract script block) → all standing harnesses → push. Verify on the next slate: a live NBA card shows gate line / cue read / price line / verdict / evidence / as-of; a card with a WATCHLIST row shows V1 and the push body's facts match the box; FINAL card freezes with V8; badges show **this** season's records.
2. **D2** (one commit): pregame block + sheet + fixtures. Verify pre-tip: both-direction read renders, GP guard renders for a <5 GP team, sheet opens from hero and from the box.
3. **D3** (optional, one commit): nightly lite profiles + fixtures; verify `get_team_profiles&league=nba` returns 30 rows with `lite:true` and the sheet fills.
Rollback for all three: revert the commit (dashboard-only; no DB state), `NBA_SS_COMPUTE_OFF=1` is unrelated and not needed.

## 7. Open decisions for the PM (answer before D1 go)
- **D-1 mount:** verdict box inside SCORING COMPOSITION (WNBA parity, collapsible) **or** a standalone always-visible strip under the ESPN WP bar? Recommendation: parity (inside the section), auto-open when a row exists.
- **D-2 exploratory line:** render the tagged exploratory numbers in the cue read until n=30 (recommended — it is the stated reason the cue exists), or forward-ledger-only from day one?
- **D-3 T5 trap wording:** keep the NBA n=1,200 null reference on the dashboard (recommended) or traps off entirely for NBA?
- **D-4 D3 scope:** build lite profiles now, or leave the sheet's season-stat cells `—` until the NBA eFG-band prereg (Phase 2) needs the same data anyway?

---

## Amendment 1 — pre-build corrections + PM decisions (2026-11-19, PM go: "I'm good with your recs, want to proceed with d3 too")

Four gaps found on the pre-build source check, each with its resolution; then the four §7 decisions as taken. Nothing in §1–§6 is withdrawn except where a line below says so.

### A1.1 Season literals — scope narrowed (corrects §3.1 and §3.5 "dead code")
`bdl.html` carries **four** season literals, not one: `fetchStandings` (`season:'2025'`), `get_season_cache&season=2025`, and two `get_wp_profiles&season=2025-26` calls. The last three are **coupled to server-side writers that still write under the same literals on `main`** — flipping the client alone would read empty tables. They belong to the unmerged `season-consolidation` branch (`26441d3`, now stale: 1 conflict against `main` in `poll-live-bdl.mjs`), whose `bdl.html` diff is exactly those lines.
- **D1 fixes only the standings literal**, by routing records through `get_standings` (the engine's own `standings_cache`, already written with the Oct-start season by Phase 1's `fetchStandingsCache`). The BDL fallback for conference rank derives its season client-side (`m < 9 ? y-1 : y`), never a literal.
- The other three literals are **left untouched and named here** so the season branch keeps owning them. PM item, not this build: rebase or retire `season-consolidation`.

### A1.2 Tie state (new; §3.2 gate line, cue read, verdict)
At a tie the server stamps **home as leader, deficit 0, gap = away − home** (`ssComputeShape`: `homeTrails = aPts > hPts`), so the gap sign flips on every lead change through zero — correct for the engine, but a raw render would alternate "qualified" ↔ "NO SPOT" at 25-25. Tie is handled as its own state, detected from the snapshot score (`home_pts === away_pts`), never from the leader alias:
- **Gate line:** `TIED · gap .16 (direction set by the next lead) · NYK .571 / MIN .733 · LEAD: —`. The gap prints as **|gap|**; both records print; no lead descriptor.
- **Cue read:** null (the gate line owns it).
- **Verdict VT** (after V0, before V4): `TIED — no trailer to read. The .16 gap resolves on the next lead; MIN would be the watch trailer.` (dim) · when |gap| < .15: `TIED — gap (.08) is below the review line either way.` Priority order becomes **V1 → V3 → V0 → VT → V4 → V6 → V7 → VX**, V8 freeze unchanged. A row anchored to a trailer that is now tied has `rowDef = 0`, out of band → falls through to VT as today's WNBA composer falls through to current-state reads.

### A1.3 Price source priority (corrects §3.2 `ssPriceLineNba`)
The card's MARKET line (`cs.oddsData`, BDL odds) and the engine's stamp (`ss_line_used`, The Odds API best book) are **different feeds** and can legitimately disagree; the push body quotes the engine's. One copy source (ACA): the price line leads with the **server stamp** and shows the card's line as a secondary fact.
- `engine saw MIN +135 (implied 43%) · ESPN fair 42% ⚠ may be pregame` — ML from the snapshot's `ss_line_used` (the trailer's best ML at stamp time), fair from the card's live `cs.espnWP` for the trailer, stale via mirrored `ssPriceStale` at the pinned .25 gap.
- `· card line +140` appended when `cs.oddsData` carries a trailer ML that differs from the stamp.
- Stamp null, card line present → the card's line is used and labeled `card line`; neither → `no line observed — tap MARKET to add one`. ESPN absent → fair clause and stale flag omitted (no fake reads).

### A1.4 Empty-ledger copy (new; §3.2 `ssForwardLedgerPanelNba`)
`ss_ledger_summary&league=nba` returns `{ledger:[], regime:null}` until the first NBA row resolves (first slate under the flags: Nov 19). Pinned render:
```
WATCHLIST  0 rows · 0 resolved · —
GAP_BASE   0 rows · 0 resolved · —
origin: exploratory cell +24pp vs ESPN, n=39 LOW, as of 2026-11-19 (aaf0ec8)
switch to forward numbers at 30 resolved WATCHLIST rows
```
Rows with `n_total > 0, n_resolved = 0` print `—` for the rate; a resolved stream prints `trailer-WINS X% [TAG]`. Row format is `{subtype}  {n_total} rows · {n_resolved} resolved · {rate}`.

### A1.5 Mount mechanics (fills in §3.3)
The SCORING COMPOSITION container today renders **only when a lead-composition object exists**. Amended: the container renders when a lead composition exists **or** the card is LIVE/FINAL with a Sweet Spot state entry; the bars render only when the composition exists; the Sweet Spot box renders first inside the body. Auto-open: when a card first acquires any `sweetspot_alerts` row, `cs._sec.sc` is set open once (`cs._ssAutoOpened` guards it, so a later manual collapse sticks). PRE cards get the D2 pregame block under the hero, not the box.

### A1.6 Decisions taken (§7)
- **D-1 mount:** inside SCORING COMPOSITION, auto-open on row (parity).
- **D-2 exploratory line:** render the tagged exploratory numbers until `WATCHLIST n_resolved ≥ 30`, then forward only.
- **D-3 trap:** T5 kept (NBA n=1,200 null + this season's worse/even-trailer negative).
- **D-4 D3 scope:** **build D3 now.** Lite NBA profiles run as an isolated stage inside `team-profiles-nightly.mjs` (1:30am MST, after the WNBA stage; try/catch — a failure never touches the WNBA upsert), source = latest snapshot per finalized NBA game this season (`games.winner IS NOT NULL`, `raw_stats_json IS NOT NULL`, same query shape as `get_final_snapshots`), season = Oct-start year (same formula as `ssStandingsSeason`). Per team: `efg`, `opp_efg` (Σ(fgm+.5·fg3m)/Σfga ×100, box fields), `pace` (mean of both teams' `poss` per game), `l10 {w,l}`, `h2h {OPP:{w,l}}`, `gp`; row `w/l` from finals; `archetype = 'LITE'`; `profile = {lite:true, …, asof}` with **no** `killer`/`tiers`/`elite`/`identity`/`rotation` keys. Pure `computeNbaLiteProfiles(finals)` exported for the fixture harness.

### A1.7 Build order (supersedes §6 cadence)
One session, three commits in order D1 → D2 → D3, each `node -c` + standing harnesses green before the next; the new harness `research/ss_nba_dashboard_fixtures.mjs` grows with each phase (source-equality + pins + grep gates per §3.6, plus the A1.2 tie pins, A1.3 priority pins, A1.4 empty-ledger pin, and the D3 golden from committed finals).

---

## Amendment 2 — target surface correction: `v3.html` is the phone dashboard (2026-11-19, PM: "please spec first so you're familiar with the code")

**The miss:** v1 inventoried `bdl.html` and D1–D3 shipped there (`2d3a94c`, `ac9cd43`, `a15c720`). Manny runs the NBA from **`v3.html`** (the mobile single-card swipe dashboard, 4,202 lines) — the spec never asked which NBA surface he uses. Nothing in v3 reads the Sweet Spot state, and v3 carries the same `season:'2025'` standings literal (line ~643), so its hero ranks ("NYK 3rd / MIN 6th") are last season's. This amendment ports D1 + D2 to v3; D3 (server) needs nothing. `bdl.html` keeps what it has.

**Size correction:** the chat estimate of ~250 lines was wrong. The pure functions travel with the port, so v3 gains ~470 lines (pure fns + fetch layer ~330 copied byte-for-byte · v3 render + mount ~120 · CSS ~15); the genuinely new design is the ~120 render lines. Harness +~40 lines.

### A2.1 Why v3 is the easier port (verified against source)
- Single active card (`activeGameId`, swipe at ~990, `scrollToGame` ~929) — the WNBA dashboard's model, so the WNBA fetch cadence (60s timer on the active card + refresh on select + render-miss kick) ports as-is; the bdl.html grid walker is not needed.
- **Same token family as `wnba-bdl.html`** (`--bg-surface-2`, `--hairline`, `--fg-secondary/tertiary/dim`, `--coral`, `--blue`, `--r-inner`, `tc()`, `esc()`, `_collOpen/toggleColl`) — the WNBA box's inline styles port verbatim; no token mapping step.
- `renderCard(id)` takes an id (bdl.html's takes a game object) — the fetch layer's re-render call is the one line that differs.
- v3 already has its own `computeScoringComp` (~3298) and builds `cs.scoringComp` (`buildScoringCompForCard`) → the evidence lines read `cs.scoringComp` directly; **no `computeScoringComp` mirror in v3** (and v3's copy is left alone — it is v3's Scoring Comp, not an SS surface).
- `cs.espnWP = {home, away, opening}` (0–100) and `cs.oddsData` exist with the same shapes.
- `_ssExpanded` in v3 is the **Sonnet-signal** expander, not Sweet Spot — never touched; all new globals are `_ssNba*`.

### A2.2 Architecture call: mirror, not a shared script
A shared `ss-nba-core.js` would give one source for both dashboards, but `_headers` scopes Basic Auth to `/*.html` (the `/*` form breaks cron functions — hotfix #10), so a `.js` asset would be served **unauthenticated**. House pattern stands: the pure block is duplicated in `v3.html` under **cross-file function-body byte-equality** (bdl.html ↔ v3.html for every pure function and constant; server ↔ both for the mirrors). Pins run once against bdl.html; equality carries them to v3.

### A2.3 Composer made token-free (touches bdl.html in the same commit)
`ssVerdictComposeNba` currently returns bdl.html CSS tokens (`var(--t3)`, `var(--red)`, `#4aa3ff`), which would break byte-equality with v3. It returns a **color key** instead — `green | amber | blue | coral | dim | secondary` — and each render maps keys to its own tokens (`SS_NBA_COLORS` per file: bdl `{dim:'var(--t3)', secondary:'var(--t2)', coral:'var(--red)', blue:'#4aa3ff', …}`; v3 `{dim:'var(--fg-dim)', secondary:'var(--fg-secondary)', coral:'var(--coral)', blue:'var(--blue)', …}`). Fixture pins switch from token strings to keys.

### A2.4 v3 mounts (exact anchors)
1. **Standings** (`fetchStandings` ~643): same swap as bdl.html — records from `get_standings`, BDL for conference rank on `nbaSeasonYear()`, cache-first fallback. Hero rank badge (~1113–1121, both PRE and LIVE rows) renders only when `confRank` is truthy (the `()` guard from `a15c720`).
2. **Pregame block** (hero, PRE branch ~1113): `renderSSPregameNba` appended **right after the hero**, before the `Analysis — Sonnet analysis activates at tip` placeholder (~1267), styled as a `.placeholder`-adjacent card (`--bg-surface-2`, `--hairline`, 12px sans) so it reads as part of the pregame stack.
3. **Verdict box** (`renderScoringCompSection` ~3440): today it `return ''` when `cs.scoringComp` is missing. Amended: when `_ssNbaState[id]` exists the collapsible renders anyway — header with summary `SS only` when no comp, box first inside `.coll-inner`, `scoringBar`s + legend only when `sc` exists (A1.5 logic, v3 form). Auto-open: `_collOpen[id+'_sc'] = true` once when the game first acquires a row (`cs._ssAutoOpened`).
4. **Header chip (v3-specific, recommended):** the Scoring Comp `.coll-summary` gains a leading pill with the verdict head word in its color — `REVIEW` / `GAP SPOT` / `NO SPOT` / `OUT OF BAND` / `TIED` / `Q4` / `FORMING` / `FINAL ✓/✗` — so the read is visible with the section collapsed, which is the resting state on a phone. Computed from the cached state at render; no fetch. PM may veto; without it the box is invisible until the section is opened or a row auto-opens it.
5. **Fetch cadence:** `startSSNbaTimer()` beside the poll start (~743) → 60s on `activeGameId`; `fetchSSStateNba(id)` in `scrollToGame` and in the swipe handler where `activeGameId` changes (~991); initial fetch after `mountAllCards` sets the first active card (~951); render-miss kick inside the box. Ledger / rows / standings / profiles ensure-fns identical to bdl.html.
6. **Matchup sheet (lite):** same `openMatchupSheetNba` with the WNBA `.ms-*` CSS ported under `.msn-*` (tokens identical, so byte-close to the WNBA sheet); opens from the box and the pregame block. v3's existing drawer (`openDrawer`, Deep Dive) is untouched.

### A2.5 Cascading implications
- `renderCard` runs on every 10s poll tick; the box reads cache only (no fetch in render except the guarded kick) — same cost profile as the WNBA file.
- `_collOpen` auto-open writes once per game; the user's later collapse sticks (guard flag), matching A1.5.
- `games` objects carry `homePoints/awayPoints/period/clock/status/scheduled/home.alias` — identical field names to bdl.html (same lineage); `getState` identical.
- No change to v3's `computeScoringComp`, Sonnet signal, drawer, toast, odds clock, or MC strip. `NBA_PAUSED` irrelevant (reads only).
- `bdl.html` changes in this commit are limited to A2.3 (color keys) — behavior-identical after the token map.

### A2.6 Fixtures (extend `research/ss_nba_dashboard_fixtures.mjs`)
- Cross-file equality: every function and constant in the shared pure set byte-equal between the `SS_NBA_BEGIN…END` blocks of `bdl.html` and `v3.html` (`ssGateLineNba`, `ssCueReadNba`, `ssPriceLineNba`, `ssVerdictComposeNba`, `ssForwardLedgerPanelNba`, `ssPregameReadNba`, `ssPowerTag`, `ssWpFmt`, `ssGapTierWord`, `ssRecWp`, `ssRecGp`, `nbaSeasonYear`, `ssNbaCueHist`, the ensure-fns, `SS_NBA_STALE_GAP`, `SS_NBA_SWITCH_N`, `SS_NBA_EXPLORATORY`); server mirrors (`ssLeadClassDisplay`, `americanToImplied`, `ssPriceStale`) and `ssGapFmt` byte-equal in v3 too.
- Color-key pins (A2.3) + both files' `SS_NBA_COLORS` cover every key the composer can emit.
- v3 grep gates: no `computeScoringComp` inside v3's SS block; no `_ssExpanded` reference inside it; N1 symbol list; `fetchStandings` literal gone; rank badge guard present in both hero rows; `renderScoringCompSection` renders on SS state; timer + select hooks present; every fetch carries `league=nba`.
- `node -c` on v3's extracted script block.

### A2.7 Order
One commit: A2.3 (bdl.html composer keys) → v3 block + mounts + CSS → harness → `node -c` both pages → standing harnesses → push → verify on the live slate from the phone (box inside Scoring Comp, chip in the header, pregame block on a PRE card, hero ranks this season's).
