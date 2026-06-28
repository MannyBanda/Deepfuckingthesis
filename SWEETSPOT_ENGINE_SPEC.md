# SWEETSPOT_ENGINE_SPEC.md

**Status:** DRAFT — spec → sign-off → implement. Nothing ships before Manny reads this.
**Scope:** WNBA only.
**Date:** 2026-06-24 · **§3 Phase-1 code-verified against HEAD `f260031`: 2026-06-25** (line numbers refreshed; 3 prior mischaracterizations corrected; `generateFallbackThesis` surfaced as an open sub-decision).

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

> **✅ FIXED — commit `000094d` (committed/deployed 2026-06-25 20:18 UTC).** The Odds API line now resolves for all 15 teams; the 7 divergent-alias teams (GSV/WAS/PDX/LVA/LAS/NYL/TOY) no longer fall back to inferior BDL odds. Cache keyed BDL-canonical via `cfg.aliasMap`. **Timing note:** the fix postdates the 2026-06-24 slate (tip 23:30 UTC, ~21 h earlier), so that slate's divergent-home games (`ATL@GS`, `MIN@WSH`) writing `source='server'` is **pre-fix behavior, NOT a fix failure.** **Live confirmation = TONIGHT (2026-06-25 slate): `LA@TOR` + `DAL@LV` are home-divergent (TOR/LV) → their `odds_history` rows should write `source='odds-api'` once books open (~30 min pre-tip).** The remaining §2 refinements (consensus line, point-in-time pairing, stale-guard) are Phase-2 quality work.

**Path that exists:** `fetchOddsAPIBatch('wnba')` (poll loop S9, lines 6567 + 7063) → The Odds API `/v4/sports/basketball_wnba/odds`, regions us,us2, markets h2h+spreads+totals, american, **best-available per side**, keyed by home alias via `ODDS_API_TEAMS_WNBA`. Per-game: `odds = oddsAPICache[hA]` → `{homeSpread, homeML, awayML, total, books}`. Stored: `odds_history (game_id, home_spread, home_ml, away_ml, total, source)`, appended per poll. `mlToProb()` available. Trailer ML = `trailerIsHome ? homeML : awayML`.

**Refinements (quality/accuracy):**
1. **Consensus line for EV.** Best-available is optimistic. Compute a **median ML across books** for the honest edge/size calc; keep best-available as the "shop here" line in the alert body. Store both.
2. **Point-in-time pairing.** Store the exact line the gate used **on the snapshot gate-output row** (not only in `odds_history`), so calibration pairs predicted-true% ↔ line-at-that-instant.
3. **Stale-guard.** If freshest `odds_history` for a game is > N min old, flag the alert "line stale — verify" instead of computing a bad edge.
4. **Alias completeness.** Verify `ODDS_API_TEAMS_WNBA` covers all 13 teams incl. expansion (GSV / POR Fire / TOR) — memory flagged WNBA alias gaps elsewhere.

---

## 3. Phase 1 — disable legacy alerts + Opus calls (Decision C)

> **Code-verified against HEAD `f260031` (post-`000094d`).** All line numbers below are live, not spec-era; legacy numbers drifted **+4** from the odds-fix commit. **Four** Opus call sites exist in the poll fn (the original kill list named two and missed `generateFallbackThesis`); `runAlertAgent` is invoked at **two** sites (not one); and `game_context` + the "2nd snapshot" are **NOT** in the investigation block (corrected below).

### Mechanism — one league-gated kill-switch
`WNBA_LEGACY_ALERTS_OFF`, read at module scope. **Recommend env-var** (`process.env.WNBA_LEGACY_ALERTS_OFF === '1'`) for instant rollback without redeploy; const is the simpler-but-redeploy alternative. **Default OFF (legacy ON)** for safety — set `1` to activate teardown. Every gate is `if (WNBA_LEGACY_ALERTS_OFF && league === 'wnba')`. **NBA/NCAAMB are byte-identical at runtime** (guard is always false for them). Hard rule: never reference the flag without the `&& league === 'wnba'` pairing.

### Kill sites — 4 gates (all WNBA-gated, reversible)

| # | Path | Site(s) | Gate |
|---|---|---|---|
| 1 | **Main alert path** — BUY / BWC / WINDOW BUY / EXIT / POSITION_*. Covers the PENDING lock-row insert (8286), the **main agent Opus call (8293)**, and the **main alert ntfy (8329)**. | `routeV2Alert()` **def 8034** | Early-return at top of `routeV2Alert`: `return { decision:'LEGACY_OFF', sent:false }`. One guard kills lock-row + Opus + ntfy together (must be block-level — the lock-row precedes the slow await per the concurrency hotfix). |
| 2 | **Legacy position-update flow** — the **2nd `runAlertAgent` Opus call (5993)**, its AUTO_ANALYSIS `alerts` inserts, and position-update ntfy (**6090** SEND "UPDATE: …", **6105** DOWNGRADE "WATCH: …"). | CAL-block **Step 10**, opens **~5939** at `if (calConviction.tier !== 'NO ENTRY' && ind.score >= 0.55)` | Gate the whole Step-10 sub-block. |
| 3 | **BWC-death alert** — TRACKING_INVALIDATED `alerts` insert + ntfy (**7890**). Mechanical, no agent. | BWC-death block **~7882–7891** | Gate the insert + `sendNtfy`. |
| 4 | **MC-investigation block** — MC INVESTIGATING ntfy (**9126**), STRUCTURAL STRESS ntfy (**9183**), **MC-investigation Opus call (9254/9259)**, position-exit ntfy (**9277** primary / **9287** fallback). | canary→investigate block **~9090–~9300** | Gate block entry. Ends *before* the calibration-transition capture (~9360+) — see Keep. |

### Keep (unchanged for WNBA)
- **2500-tok per-quarter analysis** — Opus call **5884** → `analyses` INSERT **~5915**. **CORRECTION:** this call is **already store-only — it self-pushes nothing.** The thing that pushes at 6090/6105 is the *separate* legacy position-update agent (gate #2), not this analysis. Phase 2 §6 reorients this prompt.
- `computeServerContext` (**5752**) feeding that analysis.
- **Primary poll snapshot** INSERT (**7703**) — the data substrate. Phase-2 gate-output columns populate here.
- **Calibration-transition snapshot** INSERT (**9379**, tagged Q2_END/Q3_END/…) — gold-standard calibration data. **CORRECTION:** this is the calibration capture, **not** an investigation write; gate #4 does **not** touch it.
- **`game_context` write** (`computeServerContext` **9421** → INSERT **9425**, `ON CONFLICT … DO UPDATE`). **CORRECTION:** this lives in the calibration-transition capture, **not** the MC-investigation block; it fires on quarter transitions (not canary), so it does **not** "die with the investigation." It is league-tagged, no WNBA consumer reads it (§7.3), and it is a cheap write → **leave it running for WNBA; not a Phase-1 target.**
- Always-on MC trajectory + XGB compute (no Opus).
- Pregame thesis (`pregame-agent.mjs`, separate fn) — Decision #2.

### OPEN SUB-DECISION — `generateFallbackThesis` (NEW finding, was not in the kill list)
Poll-loop pregame-thesis safety net: **def 2643**, Opus call **2720** (1000 tok) → writes `theses` `ON CONFLICT DO NOTHING` → then **ntfy "Thesis (late)" at 2742**. Invoked **7449**, **not league-gated**, guarded only by `!_thesisAttempted.has(game.id)`. This is the fn that covered WNBA during the pregame-404 outage (`8edf8b0`). It is a *thesis* generator (pregame-equivalent), **not** an in-game alert — but it (a) burns an Opus call, (b) pushes an ntfy that competes with "the sweet-spot alert is the only push," and (c) its prompt carries legacy conviction/control-score vocabulary.
- **Recommended:** KEEP the Opus call (preserve the WNBA thesis safety net → `theses`, dashboard-visible) + **kill only the 2742 ntfy for WNBA**. Reorient its prompt to the sweet-spot lens in Phase 2 §6 alongside the kept analysis + pregame prompts.
- Alternatives: keep both (accept a pregame-style push); kill both for WNBA (**risk:** if pregame cron misses, WNBA gets *no* thesis — the exact 8edf8b0 failure).
- *(Not touched: the `test_ntfy=1` manual probe at 6134 — diagnostic only, leave alone.)*

### Cascade trace (corrected)
1. **`game_context` — KEEP, no gate.** *(Corrects the earlier "CLEARED / written only at 9421 inside MC-investigation.")* The single write (9421/9425) is in the calibration-transition capture, fires on quarter transitions (not the canary), is league-tagged, and is unread by any WNBA consumer → harmless to leave on; **not** killed by gate #4. NBA/NCAAMB readers (`bdl.html`/`index.html`/`ncaamb*.html`) untouched.
2. **Learning agent — intended break → repurpose (§5).** Legacy `alerts` arcs go empty under Phase 1. Acceptable gap Phase 1→2 on a controlled WNBA timeline.
3. **State machine — harmless dormancy.** BWC/position/graduation keep writing `games.live_tracking` each cycle but fire no ntfy; snapshot cols `bwc_state/grad_rank/position_team` stay populated (no null surprise); no poll-path SELECT touched.
4. **Dashboards — quiet badges.** Legacy badges still render from `live_tracking` but stop pushing. The client **Scoring Comp panel (the gates) is independent, unaffected** — the edge view is untouched.
5. **Anthropic spend (per WNBA poll cycle).** Drops main-alert agent (gate 1), position-update agent (gate 2), and MC-investigation (gate 4). **KEEP:** 2500-tok per-quarter analysis + (recommended) fallback thesis. Phase-2 sweet-spot alert = **0 Opus**.
6. **`alerts` table.** Stops receiving legacy WNBA rows; sweet-spot rows → new `sweetspot_alerts` (§7b.3, `alert_subtype` col).

### Phase 1 implementation checklist
1. Add `WNBA_LEGACY_ALERTS_OFF` (env-var read at module scope; default OFF).
2. Gate #1 — early-return atop `routeV2Alert` (8034).
3. Gate #2 — wrap CAL-block Step 10 (~5939).
4. Gate #3 — wrap BWC-death insert + ntfy (~7882–7891).
5. Gate #4 — wrap MC-investigation block entry (~9090).
6. `generateFallbackThesis` — per the resolved sub-decision (default rec: gate **only** the 2742 ntfy for WNBA).
7. `node -c` gate. Grep-confirm every `WNBA_LEGACY_ALERTS_OFF` use is paired with `&& league === 'wnba'`.

### Phase 1 test plan
- **NBA byte-identical:** poll run flag-ON vs flag-OFF on a replayed/contrived NBA slate → identical alerts/ntfy/snapshots (guard false for NBA ⇒ zero delta).
- **WNBA silence:** flag ON, tonight's slate fires **zero** legacy ntfy (TRACKING / BUY / BWC / WINDOW BUY / EXIT / position-update / MC INVESTIGATING / STRUCTURAL STRESS / position-exit) and **zero** legacy Opus calls (log-verify agent / investigation / position-update skipped).
- **Substrate intact:** primary snapshot (7703) + calibration snapshot (9379) still write; 2500-tok analysis still writes `analyses`; pregame thesis present; (recommended) fallback thesis still writes `theses` *without* ntfy; `game_context` still writes; poll completes clean.
- **Reversibility:** flip flag OFF → legacy alerts resume next cycle.

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
`ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS`: `ss_leader_alias text, ss_leader_wp real, ss_trailer_wp real, ss_quality_gap real, ss_leader_efg real, ss_leader_efg_band text, ss_variance_share real, ss_fade_tier text, ss_collapse_tier text, ss_collapse_true real, ss_lead_class text, ss_line_used int, ss_line_consensus int, ss_implied real, ss_edge real, ss_kelly_size real, ss_alert_fired bool`. Populate at 7699. Run `?action=init`. **Do NOT widen any poll-path SELECT** (hard rule) — write-only, read later by the tracker + backtests. **Populate the new columns at the primary poll snapshot (7703).** *(Corrected: there are two legitimate snapshot writers — primary poll (7703) + calibration-transition tagged (9379, Q2_END/Q3_END) — and **both are kept**. Neither is an "investigation" write; the MC-investigation block writes no snapshot. The earlier "2nd INSERT at 9375 in investigation disappears" note was a mis-attribution.)*

---

## 4a. Phase 2a — gate engine + parity (DETAILED, code-verified at `ad5bf3f`)

> First shippable slice. **Compute + store + validate only — no alert fires in 2a.** Ships dark behind a separate compute flag; the mechanical alert is 2b, gated on 2a parity being green.

### Parity question — RESOLVED (favorable)
The server has **two** lead-composition paths and they are **not** interchangeable:
- `computeLeadComposition(summary)` (4202) splits from **box** stats (`points_in_the_paint`, `field_goals_at_rim_made`). This is the WNBA box-paint-unreliability gap (the v3 reason the client avoids box). **DO NOT reuse for the sweet-spot port.**
- `pbpResult.home/away` (= `game._bdlPbp`, from `parseBDLPBPServer` @1768) carries **PBP-zone** `{made, att}` per `rim/paint/mid/threes` (assembled @1876–1882) — the **exact** shape the client's `computeScoringComp.breakdown()` reads. The client consumes this same structure round-tripped through the server-written `game_pbp` table, so feeding the server's own in-loop `pbpResult` into a ported `computeScoringComp` reproduces the client at the field level.

**Port path:** zones from PBP (`game._bdlPbp.home/away`), eFG from reliable box (`fgm/fg3m/fga`). The unreliable WNBA box fields (paint/mid) are never touched.

### Port inventory (inline into `poll-live-bdl.mjs` — Netlify bundles separately)
- **Pure, lift as-is:** `americanToImplied`, `cbDepthRate` (depth table .68 / .56 / .50 / .44 / 0), `efgTier` + its `EFG_BANDS` table, `_clkSec`, `comebackEV` (¼-Kelly, hard cap 12%).
- **Assembled:** `computeScoringComp(game._bdlPbp.home/away, hA, aA, hPts, aPts)` → eFG/FGA augmentation per side `(fgm + 0.5·fg3m)/fga` (matches the I3 row) → `divergenceRead(sc)` → `comebackProb(leaderWP, trailerWP, deficit, period, fadeRead)`.
- **DO NOT port/reuse:** `computeLeadComposition` (box-paint). Sweet spot is PBP-zone only. *(Leave it in place — NBA prompt path still uses it; just don't feed the sweet-spot engine from it.)*
- *Availability check at impl:* `game._bdlPbp` is populated in-loop (already consumed by `ctx.pbpAudit` @4945 and the MC rate extractor), so it's present where the gates will run.

### eFG source — implementation drift, CORRECTED (caught Jun 25, Manny pressure-test)
The spec above is right (**"eFG from reliable box `(fgm+0.5·fg3m)/fga`"**), but the 2a gate-compute as shipped (`6fae745`, poll ~7945) **deviated**: it computed eFG from **PBP zone-sums** (`_zEfg`, summing rim/paint/mid/threes made+att) and mislabeled it "mitigation #1." Wrong source. **Empirical proof (n=18 live snapshots, NY@SEA / DAL@LV / LA@TOR):** zone-sum carries a **one-directional upward bias vs the official box** — mean **+1.62pp**, max **+5.2pp**, zone ≥ box in **18/18** (never once below). Mechanism: the zone regex silently drops **missed** attempts it can't classify (makes parse more reliably than misses) → denominator shrinks → eFG inflates. For a *fade* gate this is the dangerous direction — it manufactures STRONG/LEAN FADE, and +5pp flips bands. The box (`summary.home/away.statistics.field_goals_made/att/three_points_made` — the same source `raw_stats_json` already serializes) is accurate and **matches the client headline** (57.4% vs client 57% on the canonical NY@SEA snapshot; zone-sum read 59.3%). **Variance-share is unaffected** (a *made-points* ratio, robust to dropped misses → `variance_share=38` already matched the dashboard) → **stays on PBP zones.** Net: box for eFG, zones for variance — each source where it's strongest, exactly as the spec said.

**Fix (gate-compute ~7945–7953):** replace `_zEfg` (zone-sum) with `_bEfg` reading the box —
`var fgm=Number(st?.field_goals_made||st?.fgm||0)||0, fga=Number(st?.field_goals_att||st?.fga||0)||0, fg3m=Number(st?.three_points_made||st?.fg3m||0)||0; return {efg: fga>0?((fgm+0.5*fg3m)/fga*100):null, fga};` fed `_bEfg(summary.home?.statistics)` / `_bEfg(summary.away?.statistics)`. Everything downstream unchanged (`efgBox`/`fga` still feed `divergenceRead`/`efgTier`/`ss_leader_efg`). Fix the line-7935 comment ("zone-sums" → "reliable box"). **Delete `_zEfg`** (dead after swap; block-local, no other consumer).

**Cascading implications:**
- `ss_leader_efg` / `_band`: now box-sourced. Pre-fix stored rows are inflated — but every snapshot's `raw_stats_json` carries `fgm/fga/fg3m`, so **the replay recomputes box eFG retroactively** for all 619+ rows → no backfill, no data loss.
- A-trigger: fade band now accurate → **fewer false STRONG FADE → fewer false A's** (the correction, not a regression).
- Server/client parity: gap **2.3pp → ~0.4pp** (box 57.4 vs client player-sum 57, within rounding). Residual immaterial; optional follow-up = point the client headline at the box too for byte-exact display↔alert agreement.
- Graceful degradation preserved: empty `summary.statistics` → eFG null → no band → no fade → no A (correct), inside the existing try/catch. No new break surface.
- Parity harness: `divergenceRead` **logic** unchanged → still 14,083/0. Harness feeds `efgBox` directly, so the source swap doesn't touch it — add a box-vs-zone band-flip delta check to the **replay**, not the parity harness.

**Test plan:** (1) re-run `ss_parity.mjs` → expect 14,083 / 0. (2) post-deploy re-pull an NY@SEA-class snapshot → `ss_leader_efg` ≈ box (`raw_stats`) and ≈ client display. (3) replay: box-eFG vs zone-eFG band-flip count across stored rows (quantify how many historical fade reads the drift corrupted).

### New input — server standings cache (the ONLY net-new data dependency)
- Source: BDL WNBA `standings` (confirmed live, commit `7b952d5`), **daily** refresh (standings move ~1×/day).
- Cache keyed **BDL-canonical alias** → `{w, l}`. `_wp = gp >= 4 ? w/(w+l) : null` — the **gp ≥ 4 floor is a real gate** (early season → `null` → `comebackProb` NO_DATA), not a bug; port faithfully.
- Alias keying = BDL-canonical, same convention as the odds fix (`000094d`). **Divergent-team test mandatory** (TOR/LV/GS/etc.) — this is the aliasMap-regression class of bug.

### A / B tiering (LOCKED with Manny)
- **A — pristine dual-gate (system trigger):** `comebackProb.tier ∈ {STRONG, SHORT}` (gap > .20) **AND** `divergenceRead.tier === 'STRONG FADE'` **AND** `computeScoringComp.classification === 'VOLATILE'` **AND** deficit ≤ 9 **AND** margin < 10 **AND** pre-Q4 **AND** `comebackEV.edge > 0`. (Both reads key on `L` = the leader, so a *trailer*-variance lead — the POR@CHI trap — cannot trip A.)
- **B — soft dual-gate (lower conviction, "worth your eyes, your call"):** exactly one gate steps down — `comebackProb` MODERATE (gap .10–.20) with a fade, **OR** STRONG/SHORT collapse with only a LEAN FADE, **OR** deficit in the 10–14 band — **AND** still `edge > 0`. **Threshold EARNED, not assumed** (see B-earning).
- **Display / calibration-only (NO push):** any bucket that doesn't beat the line in replay.
- **NOT B:** individual-heater / Q4-closing-capacity discretionary reads (the MIN@WSH type). The gates key on *team* eFG/variance, so an individual-heater lead reads STRUCTURAL/MIXED and won't fire — by design. That edge is the shelved **`INDIVIDUAL_HEATER`** subtype, validated separately (below), never a B retrofit.

### C tier — Q4 collapse-only (DEFERRED, post-A/B)
Late-game collapse reads (the NY@SEA-down-13-in-Q4 type) are **C**, not A/B. A/B are structurally confined to **pre-Q4, deficit ≤ 9** (the fade gate BANKS at margin ≥ 10 and goes LATE in Q4), so a Q4 collapse-only read can *never* be A/B — it's its own tier.
- **Surface C only when:** the **trailer is a top-3 team** (by win%) **AND** a catchable deficit late in Q4 (Manny: "less than 10 to go in Q4" — *confirm whether deficit <10 pts or clock-based*). This is the formalized **elite-team Q4 closing-capacity** read (cf. the MIN@WSH discretionary read — supersedes the "NOT B / nothing" framing above: closing-capacity reads land here, as C).
- **Keys on the TRAILER being elite (absolute win%), NOT the quality gap** — a *different gate* than A/B (which key on trailer-minus-leader gap). The leader need not be sub-.40; in Q4 what matters is the elite team's ability to close, not how bad the leader is. So C is its own signal, **not** "Q4 `comebackProb`." Design the gate accordingly when built.
- **Opus MAY SUPPRESS C** — the concrete answer to the earlier "revisit Opus-suppress after we see the pattern." Tiered decision authority: **A/B fire mechanically (0-Opus, deterministic); C is mechanically-proposed but Opus-suppressable on context** (star benched, garbage time, foul math). Lowest conviction → the judgment layer earns its keep there, and only there.
- **DEFERRED:** build A + B (2b) first. C recorded here, not built.


- Bucket every gate-fire by **(collapse tier × divergence tier × deficit band)**.
- Per bucket: realized win% vs predicted-true% vs line-implied.
- **A** = the pristine bucket; **B** = the next buckets that **still beat the line**; non-line-beating buckets → display/calibration-only.
- **Data caveat (Jun-9 standard):** edge-vs-line needs point-in-time odds → leans on the **live 95-set + forward**; calibration (predicted vs realized, no line needed) uses **all 619** (524 historical likely lack point-in-time odds).

### Two-stage narration (LOCKED with Manny) — decision stays **0-Opus & deterministic**
What Phase 1 removed was Opus in the *decision* loop. This adds Opus as *narration on an already-fired mechanical alert* — a different layer.
- **Stage 1 — instant mechanical push:** the actionable WHAT (back trailer, line, edge, size, window). Fires the moment the gate trips. 0-Opus, no await.
- **Stage 2 — async Opus context:** the WHY (run dynamics, who's actually hot/cold, foul trouble, injuries, thesis cross-reference, anything else relevant). Lands seconds later as a 2nd push (or enriches the alert in place).
- **HARD RULES:** narration is **never a dependency** — Opus slow/error → Stage-1 alert already delivered, full and actionable. **Dedicated sweet-spot-scoped Opus call at the trigger moment** (NOT the per-quarter analysis — it can be stale when a mid-quarter sweet spot fires). **No synchronous await / lock-row in the fire path** (the exact race Phase 1 stripped). Store the narration text on the `sweetspot_alerts` row so the tracker sees what Manny was told.
- Opus = narration only for now; **revisit Opus-as-suppressor later**, after we see the full alert pattern (Manny). *(This is 2b wiring; specced here because it shapes the `sweetspot_alerts` schema.)*

### Snapshot gate-output columns (schema diff — see §4 list)
`ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS …` the `ss_*` set. **Populate at the primary snapshot (7703), after gates compute.** Run `?action=init`. **Write-only — widen no poll-path SELECT** (hard rule). This is the parity + calibration substrate.

### `sweetspot_alerts` table (created in 2a, written in 2b)
`alert_subtype` (EFG_FADE / BAD_LEADER_COLLAPSE / INDIVIDUAL_HEATER / …) + gate-output fields + **tier (A/B)** + line_used/line_consensus/implied/edge/kelly_size + **narration_text** + outcome/pnl (tracker). Extensible by design, mirrors the extensible classifier.

### Test harness (2a gate)
- **Port-parity (canonical):** ported gates server-side vs the client on the **same stored snapshots** — tonight's slate + a historical set — assert identical tier / true% / edge within float tolerance. *(The aliasMap-regression lesson — this is the test that catches a bad port before it can fire.)*
- **Replay:** 524 historical + 95 live — gate-fire counts; **POR-type structural lead does NOT fire; ATL-type banked deficit correctly CLOSES**; divergent-alias team (TOR/LV/GS) resolves line + standings correctly.
- **Standings:** gp ≥ 4 floor behavior; divergent-alias keying.
- `node -c` gate; no ship without green.

### Out of 2a (parallel / later)
- **`INDIVIDUAL_HEATER` backtest** (524 + 95): does heater-dependence erode MORE than the line implies OOS? Metric = lead-DEPENDENCE composite (top-scorer pts share + their TS/eFG vs OWN season norm + shot-type variance-vs-rim + support-cast vacuum), NOT raw TS. **Separate research thread**; if validated → its own subtype, not a B retrofit.
- **2b** mechanical alert (two-stage) + odds consensus/stale-guard + `sweetspot_alerts` writes. **2c** tracker repurpose. **2d** per-quarter prompt reorient.

---

## 4b. Phase 2b — mechanical A alert (DETAILED, code-verified at `8a3f63b`)

> Fires the **A** alert the instant the gate-compute produces `_ssTier === 'A'`. Two-stage: instant 0-Opus mechanical push (the WHAT) → async Opus narration (the WHY). **B deferred** until the replay earns its threshold; **C deferred** (post-A/B). A/B fire mechanically — Opus **cannot** suppress (only C is Opus-suppressable, §4a).

### Hook point (code-verified)
Gate-compute block, immediately after `var _ssFired = _ssTier != null;` (~7982) and the isolated snapshot UPDATE (~7984–7994). When `_ssTier === 'A'`, call the helper. All inputs already in scope: `_ssLeadAl, _ssTrailAl, _ssLeadWP, _ssTrailWP, _ssGap, _ssDeficit, _ssLeadEfg, _ssLeadBand, _ssVar, _ssClass, _ssFadeT, _ssCollT, _ssPr.pPoint, _ssTrailML, _ssImplied, _ssEdge, _ssEv.size, currentPeriod, clock, odds`. Inside the existing WNBA-only + try/catch → NBA byte-identical, never breaks polling.

### Decision A — structure: helper in-file
`async function fireSweetSpotAlert(sql, game, league, hA, aA, ss)` in `poll-live-bdl.mjs` (Netlify bundles separately → must be in-file; a helper keeps the gate block readable). `ss` = gate-output object assembled at the hook.

### Decision C — atomic dedup (schema + logic) — THE must-do the 2a schema missed
- **Schema migration** (db-api.js init): `CREATE UNIQUE INDEX IF NOT EXISTS idx_ssa_dedup ON sweetspot_alerts (game_id, alert_subtype)`. (2a created only a NON-unique `idx_ssa_game` → `ON CONFLICT` throws without this.) Run `?action=init`.
- **Logic:** `INSERT INTO sweetspot_alerts (...) ON CONFLICT (game_id, alert_subtype) DO NOTHING RETURNING id`. **Push only if the INSERT returned a row** — dedup AND cron-concurrency in one atomic move (strictly better than the legacy query-then-send at 6205, which isn't atomic). No lock row needed.
- **Subtype for the current A** = `'EFG_FADE'`. Per-subtype dedup → when `INDIVIDUAL_HEATER` ships it can fire in a game that already had an eFG-fade alert.

### Decision B — two-stage narration
- **Stage 1 (fast, in-cycle):** after the atomic INSERT wins → `await sendNtfy('SWEET SPOT — Back '+trailer+' vs '+leader, body, 5)`. Mark `ntfy_sent=true`.
- **Stage 2 (in-cycle, after Stage 1):** Opus narration — `claude-opus-4-8`, the 2765 fetch template, ~400 tok. On response → `UPDATE sweetspot_alerts SET narration_text=… WHERE id=…` + `await sendNtfy('SWEET SPOT — why '+trailer, narration, 4)` (the WHY follows the WHAT). **Opus failure = non-fatal** (decision + Stage-1 push already happened). The Stage-1 atomic insert **gates** Stage 2 → only the race-winner narrates (no double Opus). Cycle extends ~3s on an A fire (rare — 0 in 2 days); acceptable.
- **Narration is NARRATION ONLY** — does not gate/suppress the A.

### The mechanical body (Stage 1) — per §4 line format
`SWEET SPOT — Back [trailer] ([tW-tL]) vs [leader] ([lW-lL]). [leader] +[margin], eFG [X]% ([band]) / variance [Y]%. True ~[P]% [([lo]–[hi])] · best [ML]@[book] (consensus [ML2], mkt [Q]%) · EDGE +[Z]pp · ~[S]% (¼-Kelly, cap 12%). Window: single-digit, pre-Q4. Take & hold.`
- **CONFIRM at impl:** does `comebackProb` return the band `(lo–hi)`? (dashboard shows "55% (48–62%)"). If it returns it → use; if the client derives it → port that; else drop the clause.
- ntfy body is UTF-8-safe (only the *Title* needs ASCII — `sendNtfy` strips it).

### Decision D — odds consensus (`fetchOddsAPIBatch` extension)
- In the `h2h` loop (1630–1635): also capture the **book name** of the best ML (`bestHomeMLBook`/`bestAwayMLBook`) and **collect all** home/away MLs → `median()` consensus, exactly as spread/total already do (1647–1649).
- Return adds: `homeMLBook, awayMLBook, homeMLConsensus, awayMLConsensus` (`books` count already returned).
- **Source-guard (Decision E):** the gate's `odds` is `oddsAPICache[hA]` with a `bdlOdds` fallback (7748–7750). Show the "consensus [ML2]" clause **only when `odds.books > 1`** (Odds-API multi-book); BDL fallback → omit it. **Null-odds cannot occur on an A** — A requires `edge>0` ⇒ a trailer ML existed ⇒ odds present. So the guard is purely consensus-wording, not a fire/skip gate.

### sweetspot_alerts INSERT (schema already present, 2a)
`game_id, league, alert_subtype='EFG_FADE', alert_tier='A', period, clock, leader_alias, trailer_alias, leader_wp, trailer_wp, quality_gap, leader_efg, leader_efg_band, variance_share, lead_class, fade_tier, collapse_tier, collapse_true, deficit, margin, line_used, line_consensus, implied, edge, kelly_size, narration_text(NULL→UPDATE), ntfy_sent=true, outcome=NULL, pnl=NULL`. outcome/pnl filled by the 2c tracker.

### Stage-2 narration prompt (NEW — design here, refine at impl)
Focused (~400 tok). Inputs: leader/trailer + records, margin, deficit, eFG+band, variance-share, fade tier, collapse tier, quality gap, edge, line. Ask for 2–3 plain-English sentences: (1) why the leader's lead is a mirage (eFG/variance unsustainability), (2) why the trailer is structurally the better team (records + quality gap), (3) the single risk to watch. No jargon, use aliases. Explicit: this NARRATES a decision already made — it does not re-decide.

### Ship pattern + kill-switch
Mirror Phase 1 / 2a: `WNBA_SS_ALERT_OFF` flag (`process.env...==='1'`). **Ship DARK** (flag set = alerts off) → forced/synthetic A test (verify push + row + narration UPDATE + dedup) → flip the env var on. A brand-new live push path should not fire untested, even though A's are rare.

### Cascading implications
- Gate-compute snapshot UPDATE (ss_*) **unchanged** — 2b ADDS the fire after it.
- `ss_alert_fired` (snapshot) = "this snapshot met the A bar" (per-snapshot detection); the **push** dedup lives in `sweetspot_alerts` (per-game-per-subtype). A 2nd A snapshot in the same game sets `ss_alert_fired=true` but does NOT push (dedup). Semantics noted — not a conflict.
- Phase-1 legacy untouched (different table; same ntfy topic). Per-quarter auto-analysis still writes `alerts` — no collision with `sweetspot_alerts`.
- NBA byte-identical (WNBA-only block). No dead code introduced.

### Test plan
1. `?action=init` → verify `idx_ssa_dedup` UNIQUE index exists.
2. `fetchOddsAPIBatch` consensus/best-book on a live/sample Odds-API response.
3. Dedup/concurrency: two rapid pokes of the poll on a forced-A game → exactly one row + one push.
4. Forced A end-to-end (synthetic `ss` or a replay snapshot meeting A): push fires, row written, narration UPDATE lands, 2nd poke no-ops.
5. Parity harness unaffected (no gate-logic change) → still 14,083/0.

## 4c. Sweet-spot analysis layer — Opus as ANALYST, not narrator (enhances 2b Stage-2; pulls 2d forward)

> The shipped Stage-2 is a **translator** (sees only the gate's ~6 outputs). Manny's correction: he doesn't need the alert re-stated — he needs Opus to hold the **entire game** (the part he can't keep in his head) and **stress-test the alert against it**, including disagreeing. The mechanical A still fires instantly (the WHAT); this upgrades the WHY into a contextual analyst read. **Output stays phone-tight (~100-120 words); the richness is in what Opus INGESTS.**

### Role reframe (the core change)
Prompt shifts from *"explain why the gate fired"* → *"here is the full state of this game; an alert fired with thesis X; as a sharp bettor, does it hold up in context — the real story, the one factor that matters most, your read."* **Opus MAY disagree** ("gate fired but I'd pass — ATL's run is all 3s that'll cool, CHI just got starters back"). It does NOT re-fire or suppress the A (A is mechanical); it informs Manny's discretionary call — including talking him off a bad one.

### Context set (ingested, weighed SILENTLY — never recited back)
- **Score arc / momentum:** recent scoring runs (`runs6`), is the deficit actually shrinking (comeback already underway?).
- **Both teams' box truth:** FT rate, TOs, OREB/glass, bench pts, assist rate — not just the leader's eFG.
- **Sustainability audit** (`sust_json`): is the leader's lead one hot shooter or broad-based? (concentrated → regressable.)
- **Per-quarter breakdown** (`getQuarterData`): the quarter-by-quarter story.
- **XGB + MC + floor:** structural models as **silent inputs Opus weighs**, never quoted back — corroboration when aligned, an explicit caveat when they disagree with the gate.
- **Foul/personnel + injuries:** best-effort (WNBA data is thin — no per-player stats/clutch; team box + zones + runs + sustainability + XGB/MC/per-quarter are the reliable core).
- **The gate thesis:** the specific claim being stress-tested (collapse+fade read + edge).

### Architecture — async assembly, ZERO hot-path cost (code-verified)
The rich context is assembled at the legacy auto-analysis call sites (`formatSonnetPrompt` @ 6056/6497, quarter-transition only) — NOT at the gate-compute hook. But Stage-2 is already **async + non-fatal** (fires after the instant mechanical push), so assembly lives there, off the hot path:
- **Passed from the hook** (already computed every poll): `_xgbWinProb` + SHAP (7781), `_pollMC`/`_mcCum` (7896/7925), `summary` (box), `ind`, `runs6`, the gate `ss` outputs.
- **Assembled inside Stage-2** (async, latency irrelevant): per-quarter (`getQuarterData` query), `sust_json` (pass or recompute), injuries (SR/cache).

### Composer — NEW, not `formatSonnetPrompt` wholesale (honest correction)
`formatSonnetPrompt` is bound to the **legacy control-team framework** (floor reliability, conviction combos, graduation tiers, control-relative). The sweet-spot is trailer/leader-relative with none of that machinery. So we **reuse the context DATA objects + assembly logic** (the proven queries/computes that build xgbData/mcData/sust/quarterData/runs), but write a **new `formatSweetSpotAnalysisPrompt`** that composes them trailer-relative for the analyst role, WITHOUT injecting floor/conviction/graduation. Reuse the pipeline, not the framing.

### Output — prose + STRUCTURED read (for calibration)
Opus returns:
1. **Prose** (~100-120 words, decision-oriented): the read + the 1-2 factors that drove it. → stored + pushed as the WHY.
2. **A structured tail line** we parse: `READ: [CONFIRM|LEAN|CAUTION|PASS] | CONVICTION: [STRONG|MODERATE|WEAK] | KEY: [one phrase]`. READ = the analyst's verdict on the alert (CONFIRM = context backs it; PASS = Opus disagrees). Regex-parsed → new columns.

### Calibration loop — the piece that makes decisions better over time
**Schema migration** (db-api init): add `analysis_text TEXT, analysis_read TEXT, analysis_conviction TEXT, analysis_key TEXT` to `sweetspot_alerts` (fold `narration_text` into `analysis_text`). 2b INSERT/UPDATE writes the prose + parsed structured fields.
**The loop (defined here, consumed by §5/2c):** the post-game tracker joins `analysis_read`/`analysis_conviction` to the realized outcome. Over ~30-40 spots it answers the question that matters: **do Opus's CONFIRM/STRONG reads win materially more than its CAUTION/PASS reads?** That separates three edges —
- **gate base edge** (does an A win at its predicted rate?),
- **Opus analytical edge** (does the read add info beyond the gate?),
- **Manny's realized edge** (discretionary execution).
Without the loop you trust the analysis on faith; with it you weight it like any signal — and learn whether to lean on a CONFIRM or treat a PASS as a real veto.

### Cascading implications
- Stage-1 mechanical push **unchanged** — still instant, still the source of truth for "an A fired." Only Stage-2 changes.
- The shipped translator prompt is **replaced** (dead) by `formatSweetSpotAnalysisPrompt`. `fireSweetSpotAlert` Stage-2 grows a context-assembly step + the parse.
- Hot path untouched (assembly async). NBA byte-identical (WNBA-only).
- `formatSonnetPrompt` stays (still used by the kept per-quarter auto-analysis) — add alongside, don't touch.
- Token budget: Stage-2 `max_tokens` 400 → ~800-1000 (richer input + structured tail). Per-A only (rare).

### Open decisions (rec in parens)
1. **READ scale:** 4-level CONFIRM/LEAN/CAUTION/PASS *(rec — interpretable + enough for calibration)* vs a 1-5 number.
2. **MVP context depth:** full set vs core (box + sustainability + runs + per-quarter + XGB/MC + thesis), injuries/foul deferred *(rec — core first; WNBA per-player data is thin)*.
3. **Disagreement surfacing:** always show the strongest counter-factor even on a CONFIRM *(rec — the honest caveat is the value)*.

### Test plan
1. Schema init → verify the 4 `analysis_*` columns.
2. `formatSweetSpotAnalysisPrompt` on a real game's assembled context → inspect the rendered prompt (all sections present, trailer-relative, no legacy floor/conviction).
3. Forced-test fire → verify prose + parsed READ/CONVICTION/KEY land in the row, the second push reads as an analyst (not a translator), and a deliberately-weak spot yields CAUTION/PASS (Opus disagrees).
4. Parity harness unaffected (no gate-logic change).

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
   - **Decision:** keep the `game_context` table + `save_context`/`get_context` endpoints (NBA + NCAAMB depend on them). The only WNBA-relevant write is at **9421/9425 — but re-verified at `f260031`: it sits in the calibration-transition capture, NOT the MC-investigation block, and fires on quarter transitions (not the canary), so it does NOT die when the investigation is gated.** It is league-tagged and unread by any WNBA consumer → **leave it running for WNBA (cheap, harmless); no Phase-1 gate.** NBA/NCAAMB writers/readers untouched. *(Two prior characterizations were off — "cascade cleared / no client reads it" AND "dies with the investigation"; both corrected here and in §3.)*

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

- **Phase 1 — SHIPPED (`ad5bf3f`, live behind `WNBA_LEGACY_ALERTS_OFF=1`).** Flag off legacy alerts + 3 Opus call paths (cascade cleared). Immediate token/noise drop. Reversible via env flip.
- **Phase 2a — gate engine + parity (NEXT; spec §4a).** Port gates inline + standings cache + snapshot `ss_*` columns + `sweetspot_alerts` table. **Compute + store + validate only — no alert.** Ships dark; gated on port-parity + replay green.
- **Phase 2b — mechanical alert (two-stage).** Stage-1 instant mechanical push + Stage-2 async Opus narration (never a dependency) + odds consensus/stale-guard + `sweetspot_alerts` writes. A/B tiers fire. Gated on 2a.
- **Phase 2c — tracker repurpose.** `post-game-agent` → calibration (signal base edge) + execution (discretionary alpha).
- **Phase 2d — prompt reorient.** The kept 2500-tok per-quarter analysis → sweet-spot lens; strip legacy vocabulary.
- **Phase 3 (separate spec):** delete dead state-machine code (BWC/position/graduation/canary) once nothing references them.
- **Parallel research:** `INDIVIDUAL_HEATER` validation (524 + 95). If it clears the Jun-9 standard → its own subtype, not a B retrofit.
