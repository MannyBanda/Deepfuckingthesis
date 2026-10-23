# PREREG — Canary × Turnover Fuel (NBA)

**Date:** 2026-10-23
**Status:** PRE-REGISTERED. Committed before any outcome contact. Executor: Claude (Fable 5.1), PM: Manny.
**Motivating case (disclosed, not evidence):** CLE@PHI 2026-10-22. CLE +16 at the canary trigger (Q3 11:09) with eFG only 55 vs 50 — the lead was 14 PHI turnovers and a 17-9 FTA edge. STRUCTURAL STRESS pushed at Q3 6:58 (+13). PHI turned it over twice in Q3 and won 114-106. PHI was +600 at the push.

---

## 1. Question

The MC canary's CLEAN pattern is a validated collapse detector (May 3-6, 2026: 77.6% "control team loses", n=277, 1,235-game backtest). It has never been conditioned on **what the lead was made of** before it fired. PM hypothesis: a lead built on the trailer's turnovers is less structural than a lead built on shooting, and a trailer that has already cleaned up its turnovers by the time the push lands is the trailer that converts.

Two hypotheses, adjudicated separately. Passing one does not rescue the other.

- **H1 — pre-fire fuel.** Among production-style CLEAN fires on a leading control team, trailer-WIN rate rises with the takeaway content of the lead at the trigger checkpoint.
- **H2 — clean-up.** Among the same fires, trailer-WIN rate rises with the trailer's turnover improvement between the trigger checkpoint and the CLEAN checkpoint (the moment the push lands).

Mechanism claimed: turnover rates regress faster than shooting makes do, so a takeaway-fed lead has less structural floor under it (the WNBA takeaway-channel finding — POT-fed leads convert for trailers at +14pp vs market — untested in the NBA). H2 is the within-game expression of the same mechanism.

## 2. Prior art (disclosed)

- **Driver-type null (May 6, same backtest):** post-trigger rate decomposition at first CONFIRMED (VOLATILE = ctrl TO rate + opp OREB deviation vs STRUCTURAL = 2PT%) did **not** separate CLEAN precision. "Pattern predicts, driver doesn't." That cut measured the *leader's* post-trigger turnovers; nothing pre-trigger, nothing on the trailer. Adjacent null — the bar below is set with it in mind.
- **MC collapse is not a standalone BUY (May 3, cross_deep):** MC<.30 with ctrl floor still >.75 → opponent wins 25.8% (n=213); floor <.60 → 59.9% (n=182). Floor-at-trigger is a known conditioner and is controlled for below.
- **Margin-at-trigger gradient (May 3):** CLEAN ≤3 = 81.0% (n=179) · 4-8 = 72.2% (79) · 9-15 = 63.3% (30) · 16+ = 50% (4). The ≤3 bucket in that run was `margin <= 3` with no floor at zero, so it includes ctrl-trailing triggers; Phase 0 recomputes it with margin ≥ 1 enforced.
- **WNBA trailer overlays 0-for-3 (Aug 2026):** the within-game clean-up delta was killed as a team trait (late-execution M2, r=.049, sign-flips) and Phase B failed on the takeaway cell. Different league and population; same conceptual family. Disclosed so the bar is not softened by the motivating case.

## 3. Instruments

**Instrument A (primary):** `nba_snapshot_backtest`, 1,235 games, 3-minute checkpoints (Q3_9 → Q4_3 eligible), replayed by a new read-only phase `mc-backtest?phase=canary_fuel_export`. The phase mirrors the validated trigger exactly (combined mode: floor − MC > .15 OR MC < .70; 2-checkpoint canary window; post-trigger box-diff investigation; verdict thresholds .25/.40/.60; INV below 8 post-trigger possessions) with one addition and one correction:

- **Addition — production-style incremental pattern.** The May replay labelled CLEAN post-hoc ("never NORM after first alarm through end of game"), which carries hindsight a bet cannot have. Production classifies incrementally (`classifyMCPattern`: ≥3 verdicts, ≥2 non-INV, hit LIKELY/CONF, no NORM yet) and stops at the first CLEAN. The export records both labels; **the primary population is `pattern_prod === 'CLEAN'` and all bet-time features are read at `clean_cp`**, the checkpoint where production would have pushed.
- **Correction — ctrl must lead.** Trigger requires ctrl margin ≥ 1 at the trigger checkpoint (the production `_v2Margin >= 0` gate plus a strict lead). Gaps vs production that remain: no ≥3-point compression gate, no tracked-team gate, 3-minute grain. Per the fine-arena lesson the backtest measures the sampling moment, not the state; Instrument B is the transfer check.
- MC is stochastic. The export seeds `Math.random` (mulberry32, seed 20261023) for the duration of the phase so the committed rows regenerate byte-for-byte.

**Instrument B (transfer check, report-only):** production snapshot archive, NBA, 2026-03-17 → present, minute-level, replayed by `cross_triggered_prod` logic with the same features; `espn_wp` at the fire as the market proxy. Expected LOW power; ordering only.

**Fair-line proxy (mandatory for the primary metric):** P(leader holds | checkpoint × leader-margin bucket) fit on **all** backtest checkpoints Q3_9 → Q4_3, leader = team ahead on the scoreboard, buckets 1-3 / 4-8 / 9-15 / 16+. Emitted by the same phase as aggregate counts (`base_rates`). The proxy is required because takeaway-fed leads may simply be smaller leads, and the 81→63 margin gradient would masquerade as the effect.

## 4. Population

All fires in Instrument A with `pattern_prod === 'CLEAN'` and ctrl margin ≥ 1 at trigger. One row per game (first trigger only). Secondary, report-only: `pattern_prod === 'WAVE'`; `pattern_posthoc === 'CLEAN'` (to quantify the hindsight gap).

Season split: `season` derived from `nba_backtest.date` (Oct–Jun → the season ending in the later year). Both-seasons rule applies to any structural claim.

## 5. Features (all at the trigger checkpoint unless stated; "trailer" = the non-control team)

- **F1 net POT** = leader `points_off_turnovers` − trailer `points_off_turnovers` (from `pbp_derived` hPOT/aPOT). Tercile-split within the population. Top tercile = "takeaway-fed".
- **F2 trailer TO burden** = trailer turnovers ÷ trailer estimated possessions, possessions = FGA + 0.44·FTA − OREB + TO. Tercile-split.
- **F3 clean-up (H2)** = trailer post-trigger TO rate (TO and possessions diffed trigger → `clean_cp`) − trailer pre-trigger TO rate (F2). Negative = cleaned up. Tercile-split. Read at `clean_cp` only — never later.
- **F4 FTA edge (descriptive only, no bar):** leader FTA − trailer FTA at trigger. Reported because it was the second fuel channel in the motivating case; it earns a bar only in a future prereg.

Controls recorded on every row: ctrl margin at trigger and at `clean_cp`, floor at trigger / `clean_cp`, XGB at trigger / `clean_cp` where `mc_backtest_results` has it, trigger checkpoint, trigger MC, verdict sequence, season.

## 6. Metrics

- **Primary:** trailer-WIN rate per tercile, **and** edge = trailer-WIN − (1 − proxy hold rate) at the fire's checkpoint × leader-margin bucket, averaged over the tercile's rows. Both must clear the bar.
- **Secondary (report-only):** same cuts within margin bucket (1-3 / 4-8 / 9-15) and within floor-at-trigger class (>.75 vs ≤.75), to show the effect is not the known gradients wearing a costume.
- **Power tags:** HIGH ≥200 · MED 80-200 · LOW <80 per cell. Below MED, ordering only, no directive language.

## 7. Bars (pre-declared)

For each of H1 (F1 primary; F2 reported alongside) and H2 (F3):

1. Top-vs-bottom tercile separation ≥ **8pp** on trailer-WIN **and** ≥ 8pp on edge-vs-proxy.
2. Monotone across the three terciles.
3. Holds in both backtest seasons independently (sign and ≥ 4pp in each leg).
4. n ≥ 40 per tercile.

Any bar missed → NOT PROMOTED. H1 and H2 are independent verdicts. No threshold search: terciles are the only split; if the signal lives at a cut point the terciles don't expose, that is a new prereg, not an amendment.

## 8. Promotion ladder (pre-committed)

- **PASS →** a pinned fact line in the STRUCTURAL STRESS push ("Lead is takeaway-fed: N trailer TOs feeding ~X of the M-point lead" / "Trailer has cleaned up since trigger: a→b TOs") and a stamped field on the forward canary log. Context only. **Never a gate, never a tier, never sizing authority** at this stage.
- **Sizing confidence** only after a forward, price-joined n ≥ 20 on the live canary log — which requires the NBA stale-quote filter (odds tape frozen at the pregame line on CLE@PHI, 169/169 rows) to ship first.
- **FAIL →** recorded here with retraction-grade prominence; the motivating case is logged as single-game variance.

## 9. Data-contact plan

- **Phase 0 (counts only, no outcomes read):** export coverage — games processed, fires by `pattern_prod` and `pattern_posthoc`, CLEAN n with margin ≥ 1 by season, POT non-null share at trigger checkpoints, tercile cut points for F1/F2/F3, and the corrected margin-bucket n's. Committed as findings before Phase 1.
- **Phase 1:** H1 and H2 cuts on the committed export, in the sandbox, from the committed script. Findings doc with verdicts, numbers, n, power tags, provenance, what changes, mechanism.
- **Phase 2:** Instrument B transfer check. Report-only.

Amendments after Phase 0 are permitted only for instrument defects (a field that turns out null, a join that fails) and must be dated and disclosed in the findings doc; bars and features do not move after data contact.

## 10. Artifacts

- This file.
- `netlify/functions/mc-backtest.mjs` — `canary_fuel_export` phase (read-only; no production path touched).
- `research/2026-10-23_canary_fuel_fires.json.gz` — committed export (regenerable with the seed).
- `research/2026-10-23_canary_fuel_cuts.py` — Phase 1 script.
- `research/2026-10-23_canary_turnover_fuel_PHASE0.md`, `..._FINDINGS.md`.
