# SWEETSPOT_ENGINE_SPEC.md

**Status:** DRAFT — spec → sign-off → implement. Nothing ships before Manny reads this.
**Scope:** WNBA only.
**Date:** 2026-06-24

---

## 0. Goal & non-goals

**Goal:** Port the client sweet-spot gates server-side, store gate outputs at snapshot level, fire ONE mechanical (zero-Opus) sweet-spot ntfy, disable all legacy alerts + their Opus calls, repurpose the post-game learning agent as a calibration + execution tracker, and reorient the per-quarter auto-analysis prompt to the sweet-spot strategy.

**Non-goals (this spec):** NBA; the individual-heater layer (shelved — validate later, then maybe a 3rd fade type); *deleting* dead state-machine code (Phase 3, separate spec). Build the engine **extensibly** so the heater layer plugs in as a 3rd fade type without re-architecture.

---

## 1. The two gates (source of truth = `wnba-bdl.html`)

Move server-side, **inlined** into `poll-live-bdl.mjs` (Netlify bundles functions separately; no shared import without an esbuild module spike — deferred).

- **`comebackProb` / `comebackEV`** (bad-leader collapse): leader win% < .40, quality gap ≥ .10 (>.20 STRONG/SHORT, .10–.20 MODERATE×0.75), deficit < 20, depth-rate table; EV + ¼-Kelly size capped 12%.
- **`divergenceRead`** (efficiency-divergence fade): elevated eFG (orange/red band by quarter) + variance share > 55% (or eFG ≥70 with >45%), margin < 10 (BANKED at +10), pre-Q4 (LATE in Q4 / final 3:00 Q3), structural exclusion (variance share ≤45 → sticky lead).
- **`computeScoringComp`** (lead-source class): VOLATILE / STRUCTURAL / MIXED.

**Clean A = collapse BACK [trailer] STRONG/SHORT + EDGE>0, divergence STRONG/LEAN FADE, class VOLATILE, deficit ≤9, margin <10, pre-Q4.**

---

## 2. Odds — available, BUT a confirmed alias bug degrades 7 teams (Decision B)

> **✅ FIXED — commit `000094d` (deployed 2026-06-24).** The Odds API line now resolves for all 15 teams; the 7 divergent-alias teams (GSV/WAS/PDX/LVA/LAS/NYL/TOY) no longer fall back to inferior BDL odds. Cache keyed BDL-canonical via `cfg.aliasMap`. Live confirmation (GS/WSH writing `source='odds-api'`) pending next live WNBA slate. The remaining §2 refinements (consensus line, point-in-time pairing, stale-guard) are Phase-2 quality work.

**Path that exists:** `fetchOddsAPIBatch('wnba')` (poll loop S9, lines 6567 + 7063) → The Odds API `/v4/sports/basketball_wnba/odds`, regions us,us2, markets h2h+spreads+totals, american, **best-available per side**, keyed by home alias via `ODDS_API_TEAMS_WNBA`. Per-game: `odds = oddsAPICache[hA]` → `{homeSpread, homeML, awayML, total, books}`. Stored: `odds_history (game_id, home_spread, home_ml, away_ml, total, source)`, appended per poll. `mlToProb()` available. Trailer ML = `trailerIsHome ? homeML : awayML`.

**Refinements (quality/accuracy):**
1. **Consensus line for EV.** Best-available is optimistic. Compute a **median ML across books** for the honest edge/size calc; keep best-available as the "shop here" line in the alert body. Store both.
2. **Point-in-time pairing.** Store the exact line the gate used **on the snapshot gate-output row** (not only in `odds_history`), so calibration pairs predicted-true% ↔ line-at-that-instant.
3. **Stale-guard.** If freshest `odds_history` for a game is > N min old, flag the alert "line stale — verify" instead of computing a bad edge.
4. **Alias completeness.** Verify `ODDS_API_TEAMS_WNBA` covers all 13 teams incl. expansion (GSV / POR Fire / TOR) — memory flagged WNBA alias gaps elsewhere.

---

## 3. Phase 1 — disable legacy alerts + Opus calls (Decision C)

### Kill list (flag off, reversible)
- **Opus calls:** alert-reasoning agent (~989–1124, 500 tok) + MC-investigation agent (~9252).
- **ntfy fires:** 7886 (TRACKING INVALIDATED), 8325 (BUY/BWC/WINDOW BUY main), 9122 (MC INVESTIGATING), 9179 (STRUCTURAL STRESS), 9273 + 9283 (XGB/MC INVALIDATED position exit).

### Keep
- Per-quarter auto-analysis Opus (~5750–5907, 2500 tok) — Decision #1, prompt reoriented (§6).
- Pregame thesis (separate fn) — Decision #2.
- Snapshot INSERT (7699) — the data substrate.
- Always-on MC trajectory + XGB compute — cheap, no Opus, may feed displays.

### Cascade trace (1st / 2nd / 3rd order)
1. **`game_context` — CLEARED.** Written only at 9421 (inside MC-investigation); **read nowhere in the poll loop**; the per-quarter auto-analysis builds its own prompt and does not read it. → Killing alert agent + MC investigation does NOT starve the kept analysis. *(Verify client/`analyze.js` don't hard-depend on fresh `game_context`; worst case = dashboard staleness, not a poll break.)*
2. **Learning agent — intended break → repurpose (§5).** It reads the `alerts` table to build BUY/BWC/position arcs; with those off, arc-building yields nothing. Transition gap between Phase 1 (off) and Phase 2 (sweet-spot on) is acceptable on a controlled WNBA timeline.
3. **State machine — harmless dormancy.** BWC/position/graduation keep writing `games.live_tracking` each cycle but fire no ntfy; snapshot cols `bwc_state/grad_rank/position_team` stay populated (no null surprise); no poll-path SELECT touched.
4. **Dashboards — quiet badges.** Legacy badges still render from `live_tracking` (Phase 1) but stop pushing. The **Scoring Comp panel (the gates) is client-side, independent, unaffected** — the edge view is untouched.
5. **Anthropic spend.** Drops alert agent (500/alert) + MC investigation immediately. Remaining: per-quarter analysis (kept) + pregame. Sweet-spot alert path (Phase 2) is mechanical → **0 Opus**.
6. **`alerts` table.** Stops receiving legacy rows; sweet-spot rows go to the **new `sweetspot_alerts` table** (resolved §7b.3) with an `alert_subtype` column for multiple Claude-derived types.

### Sub-decision flagged
- Per-quarter analysis currently **pushes ntfy** (6086/6101). **DECIDED: store-only** — compute + write to `analyses`, kill the push (6086/6101). No quarter summaries to ntfy; the sweet-spot alert is the only push.

---

## 4. Phase 2 — server-side gate engine + mechanical alert

### Port (inline)
`divergenceRead`, `comebackProb`, `comebackEV`, `computeScoringComp` as inlined fns. **Extensible lead-source classifier:** fade types `{eFG-variance, bad-leader-collapse, [heater later]}` → one composite decision.

**Inputs (server availability):** box eFG per team ✓ (raw_stats); variance share — box-derived `(3PT pts + mid pts)/total` (decision: box-derived simplicity vs stored-PBP-zone parity — §7); standings win% (VERIFY — §7); deficit/period/clock ✓; trailer live ML ✓ (§2).

### Mechanical sweet-spot alert (0 Opus)
- **Fires** when both gates align (per §1) — gates already emit plain-English text.
- **Body:** `SWEET SPOT — Back [trailer] vs [leader]. [Leader] +[margin], eFG [X%] ([band]) / variance [Y%]. True ~[P]% ([lo]–[hi]) · best [ML]@[book] (consensus [ML2], mkt [Q]%) · EDGE +[Z]pp · size ~[S]% (¼-Kelly, cap 12%). Window: single-digit, pre-Q4. Take & hold.`
- **Tier in body:** A (both clean) vs B (one clean / other soft) — feeds calibration.
- **Dedup:** fire once per game on first reveal; re-fire if edge strengthens (+X pp) or after cooldown (Y min); emit terse `SWEET SPOT CLOSED — [banked +10 / Q4 / deficit out of band]`. Mirror BWC dedup (5min OR +0.10).

### Snapshot gate-output storage (schema diff)
`ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS`: `ss_leader_alias text, ss_leader_wp real, ss_trailer_wp real, ss_quality_gap real, ss_leader_efg real, ss_leader_efg_band text, ss_variance_share real, ss_fade_tier text, ss_collapse_tier text, ss_collapse_true real, ss_lead_class text, ss_line_used int, ss_line_consensus int, ss_implied real, ss_edge real, ss_kelly_size real, ss_alert_fired bool`. Populate at 7699. Run `?action=init`. **Do NOT widen any poll-path SELECT** (hard rule) — write-only, read later by the tracker + backtests. The second snapshot INSERT (9375, in investigation) disappears when investigation is killed — ensure 7699 is the sole writer.

---

## 5. Learning agent → calibration + execution tracker (Decision D)

`post-game-agent.mjs`, nightly:
1. Pull `SWEETSPOT` alerts + gate-output snapshot rows for the slate; join BDL final scores.
2. **Signal base edge (optimal placement):** for every qualifying gate-fire (whether or not Manny bet), realized win vs gate predicted-true% and vs line → calibration curve (predicted% vs realized%) + edge-vs-market. *This is the OOS sample for sizing readiness.*
3. **Execution comparison:** join Manny's actual bets → compare his entry timing/price/size vs the gate's optimal (best-edge moment) → discretionary alpha + "did you enter at the right time/price."
4. Opus summary (keep, low token): calibration drift, best-missed entries, execution gaps → `learnings`, one nightly ntfy.

**Input dependency:** Manny's actual bets need a structured source (`research/betting_log.md` we started, or a lightweight bet-entry endpoint — §7).

---

## 6. Auto-analysis prompt reorientation (Decision #1)

Keep the 2500-tok per-quarter call; rewrite the prompt to the sweet-spot lens only: read gate outputs → narrate is-a-fadeable-lead-forming / whose-scoring-is-the-mirage (structural vs variance; heater flag once built) / is-the-trailer-better / deficit+time window → and **explicitly say "no edge here" when gates don't align** (don't manufacture action). Strip ALL killed-alert vocabulary (BUY/BWC/WINDOW BUY/tracking/position/graduation/conviction). **Grep prompt template literals for dead vocabulary and replace** (blindspot #1: prompt text gets less rigor than code).

---

## 7. Code-read findings (RESOLVED)

1. **Standings win% — CLIENT-ONLY → one genuine build.** Poll loop has NO season W-L: `wp_profiles` (line 5694) is the WP-*curve* identity profile, and db-api `win_pct` is control-win% from calibration — neither is team season record. `comebackProb`'s `leaderWP/trailerWP` are fed CLIENT-side (`fetchStandings` → BDL `standings` endpoint, season=current year). **Build:** add a server-side standings fetch (BDL WNBA standings, confirmed live per commit `7b952d5`) + lightweight **daily** cache keyed by **BDL-canonical alias** → win%. One endpoint, cheap (standings move ~1×/day). Low complexity; it's the only net-new gate input.

2. **Odds — alias bug FIXED ✅ (commit `000094d`, deployed).** `fetchOddsAPIBatch` had keyed the cache by **SR convention** (`'GSV'`) while the loop looks up **BDL-canonical** (`hA` = `cfg.aliasMap[home_alias]` → `'GS'`, line 7070). Empirically verified on the 2026-06-24 slate: divergent-home games (GS, WSH) wrote `source='server'` (inferior BDL fallback), non-divergent (IND, CHI) wrote `source='odds-api'`. **7 teams** (GSV/WAS/PDX/LVA/LAS/NYL/TOY) silently missed the line-shopped line. Fixed by keying the cache BDL-canonical (`result[cfg.aliasMap?.[homeAlias]||homeAlias]`); unit-tested 15/15. Live confirmation (GS/WSH → `source='odds-api'`) pending next live slate.

3. **`game_context` — CORRECTED finding: keep the table + endpoints; only the WNBA MC-investigation write dies.** Exhaustive trace:
   - **Writers:** poll MC-investigation (9421, `serverCtx`); clients via `save_context` — pushers are **`index.html` (NBA) + `ncaamb.html` (NCAAMB)**, NOT `wnba-bdl.html`.
   - **Readers:** clients via `get_context` — **`bdl.html` + `index.html` (NBA), `ncaamb.html` + `ncaamb-bdl.html` (NCAAMB)**; plus the V2 test harness. The poll's per-quarter auto-analysis does **not** call `get_context`.
   - **`wnba-bdl.html` neither reads nor writes it; no WNBA-path consumer reads it.**
   - **Decision:** keep the `game_context` table + `save_context`/`get_context` endpoints (NBA + NCAAMB depend on them). The only WNBA-relevant write is the MC-investigation writer (9421), which dies *with* the investigation — **league-gate the kill to WNBA** so NBA/NCAAMB investigation writes are untouched. (Earlier "cascade cleared / no client reads it" was wrong — corrected here.)

4. **Variance share — PBP-zone, and HALF-BUILT already.** Box-derived is OFF the table for WNBA (box paint/mid splits are the v3 gap). The poll loop **already computes `leadComp.classification`** (STRUCTURAL/VARIANCE/MIXED) from PBP zones, stored as `lead_class` (line 7589). Porting the full fade read mostly means **exposing the variance-share % + leader eFG band** off that existing machinery + box eFG. **Decision: PBP-zone (Manny's client/server-parity bias confirms it).**

### 7b. Manny's calls — RESOLVED
1. **Bet-entry source** → **talk through each bet nightly, Claude logs to `betting_log.md`.** Near-future: a **lite betting-log UI**, likely a **`debug.html` section**. No bet-entry endpoint for now.
2. **Per-quarter analysis ntfy** → **store-only** (compute + write to `analyses`, no push). Kill ntfy sites 6086/6101.
3. **Alerts table** → **new `sweetspot_alerts` table.** Design for **multiple alert subtypes** (Manny foresees several Claude-derived sweet-spot alert types). Schema: include an `alert_subtype` column (e.g. `EFG_FADE`, `BAD_LEADER_COLLAPSE`, `INDIVIDUAL_HEATER`, …) + the gate-output fields + tier + line/edge/size + outcome (for the calibration tracker). Extensible by design, mirrors the extensible lead-source classifier (§4).

---

## 8. Test plan

- **Port-parity (canonical):** run ported gates server-side vs the client on the SAME stored snapshots for tonight's 4 games + a historical set; assert identical tiers/true%/edge within float tolerance. (The aliasMap-regression lesson: this is the test that would have caught it.)
- **Replay:** ported engine over 524 historical + 95 live WNBA snapshots; confirm gate-fire counts, POR-type structural leads do NOT fire, ATL-type banked deficits correctly CLOSE.
- **Odds:** trailer-ML resolution (home/away) live; consensus vs best-available; stale-guard.
- **Cascade:** with alerts flagged off, auto-analysis + pregame still run, snapshot INSERT still succeeds, dashboards render without crash.
- **Tracker:** dry-run tonight (0 triggers expected) + a historical slate with known triggers; verify predicted↔realized pairing.
- Syntax-gate every change (`node -c`); no ship without green.

---

## 9. Phasing

- **Phase 1:** flag off legacy alerts + 2 Opus calls (cascade cleared). Immediate token/noise drop. Reversible.
- **Phase 2:** port gates, schema diff, mechanical alert (odds wired), tracker repurpose, prompt reorient.
- **Phase 3 (separate spec):** delete dead state-machine code (BWC/position/graduation/canary) once nothing references them.
- **Later:** individual-heater layer (validate first).
