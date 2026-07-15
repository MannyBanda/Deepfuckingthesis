# Honest Gap (SOS/performance-adjusted quality gap) — TESTED & REJECTED (2026-07-14)

**Hypothesis (Manny):** Raw win% misprices teams whose record diverges from opponent-adjusted
performance (record-inflation index, `2026-07-14_team_profiles_findings.md`: GS +.69, TOR +.56,
DAL +.44). An SOS/performance-adjusted gap should improve comeback prediction over the raw gap.
Prior-art gate: the Jul 12 form-gap kill barred *recency*-weighted records but explicitly allowed
"different data, different hypothesis" — opponent-quality adjustment qualifies.

**Substrate (Phase 0, this session):** `team_game_stats` backfilled to 2024 (263 games) and 2025
(311 games) via existing nightly backfill mode — one line of new code (`quiet=1`), plus the
All-Star phantom guard (`CANONICAL_ALIASES`, commit 8670843; WNBASTARS/USA + CLA/COL purged).
As-of replay validated: pure `computeProfiles` over date-filtered rows reproduces sane mid-2024
profiles (NY/MIN finals teams, LA SHOT_DEFICIT).

**Frame:** `export_xgb_training` (5,260 checkpoints, 526 games) joined to `team_game_stats` by
bdl id. Spots = Q2/Q3 checkpoints, trailer down 1–9, deduped to first per game-quarter, both
teams ≥4 GP entering, strictly pre-game as-of. **n=744.** Outcome cross-check vs `ctrl_won`:
0 mismatches. (Jul 12 frame was n=686 — it also required form ≥5 GP; decision rule here is
relative on a single frame, so the delta is benign. G0 replicates directionally: 0.698 vs 0.672.)

**Pre-registered variants + decision rule (stated before running):** challenger must beat G0 by
≥0.015 AUC (form study's +0.0014 = known noise floor), stay monotonic, and be directionally
better in both seasons. G2 implementation: 50/50 reweight of vs->.600/vs-rest win% (STRICT
cutoff, matching TIER_CUTOFF), cell <2 games falls back to overall win%.

## Results

| Variant | AUC all | 2024 | 2025 | Terciles (low→high) |
|---|---|---|---|---|
| **G0 raw win% gap** | **0.6975** | 0.7506 | **0.6612** | 14.9 / 35.5 / 52.2% |
| G1 margin_pg gap | 0.6797 | 0.7434 | 0.6360 | 20.5 / 29.7 / 52.4% |
| G2 tier-adjusted win% gap | 0.6787 | 0.7533 | 0.6313 | 18.9 / 31.5 / 52.2% |
| G3 aggregate eFGd gap | 0.6688 | 0.7285 | 0.6345 | 21.3 / 31.3 / 50.0% |

1. **Raw record beats every performance-based strength measure — not one challenger even
   matches G0**, let alone clears +0.015. All deltas are NEGATIVE (−0.018 to −0.029). G2's 2024
   edge (+0.003) is noise and reverses in 2025 (−0.030).
2. **Blend sweep: optimal λ=0 for G1 and G2, +0.0001 for G3.** The challengers carry zero
   complementary signal — same verdict as the form-gap blend (Jul 12).
3. **Leader<.40 gate under honest strength (secondary):** raw pool 50.3% trailer-win (n=177).
   The "secretly bad" leaders the inflation story says we're missing (raw ≥.40, adj <.40):
   **33.9% (n=59)** — exactly the base rate, zero edge, would dilute the pool to 46.8%.
   n=59 is LOW power → ordering only, but the ordering says do not expand the gate.

## Interpretation

Second consecutive kill of a gap modifier (form Jul 12, honest-strength Jul 14). For predicting
live comebacks from a trailing position, raw win% appears to encode something the "cleaner"
measures wash out — plausibly close-game execution, which is precisely the skill a comeback
requires. Margin_pg is polluted by blowout/garbage-time noise; tier-splitting halves the sample
per cell and buys variance; eFGd is an input to winning, not a summary of converting.

The inflation index remains REAL as a description (GS genuinely is 2-6 vs top) — it just is not
a better *gap input*. It stays exactly where the Jul 14 findings put it: discretionary sizing via
the usage playbook + composeTeamContext narrative.

## Verdict

- **Season raw win% stays the sole gap input AND the sole leader-bad gate input.** No code changes.
- Team profiles / inflation data = **narrative-only, confirmed by test** (not by default).
- Do NOT revisit gap redefinition without a genuinely new mechanism — record-recency (killed
  Jul 12) and opponent-quality/performance adjustment (killed here) are both exhausted. The
  remaining open mechanism from the Jul 12 doc is **availability-adjusted** strength (injury
  layer, §4c direction) — different data, still legal.
- Caches: /tmp/xgb_export.json, /tmp/tgs.json, /tmp/honest_gap_spots.json.

## Addendum (same day): small-gap conditional lever test — ALSO REJECTED

**Hypothesis (Manny):** profile levers (eFGd, TOm, vs-Top, top-eFGd, vs-Rest, Infl) may add
accuracy where G0 is uninformative — |gap| < .15, the NO EDGE zone — possibly as their own
watchlist criteria. Legitimately distinct from the global test (conditional, not replacement).

**Pre-registered:** pool = |g0| < .15 (PROBE threshold, principled); levers as trailer−leader
deltas (Infl = leader_infl − trailer_infl); pass = in-pool AUC ≥ 0.58 AND both-season
directional consistency; passers validate on 2026 live spots (2026 never used for derivation).

**Pool:** n=281 (2024=104, 2025=177), base trailer-win 36.3%. MED-LOW power.

| lever | AUC | 2024 | 2025 |
|---|---|---|---|
| g0 residual (control) | 0.569 | 0.694 | 0.502 |
| L_vsrest | 0.571 | 0.651 | 0.528 |
| L_efgd | 0.511 | 0.650 | **0.426 (inverts)** |
| L_vstop | 0.497 | 0.538 | 0.485 |
| L_infl | 0.485 | 0.486 | 0.482 |
| L_topefgd | 0.470 | 0.569 | **0.403 (inverts)** |
| L_tom | 0.462 | 0.502 | 0.444 |

1. **Nothing passes.** Best lever (vs-Rest, 0.571) barely matches the residual g0 ordering it's
   mostly a re-expression of, and is season-inconsistent.
2. **The season-flip signature is the tell:** every lever with an apparent 2024 edge inverts or
   collapses in 2025 (eFGd 0.650→0.426). Same noise pattern as the form study's seductive cell.
3. **Inflation is the cleanest null in the study:** 0.486/0.482 — perfectly consistent at zero.
4. **2025-only focus makes levers WORSE, not better** (all ≤0.53). A 2024-only derivation would
   have shipped an inverted signal — the exact trap the both-season rule exists for.
5. **No small-gap watchlist:** base 36.3%, best reliable cell ~42% — below break-even at
   realistic small-deficit prices. Nothing advanced to 2026 validation.

**Standing verdict extended:** profile levers add no mechanical accuracy globally OR in the
small-gap region. They remain discretionary-sizing/narrative inputs, where the bets ledger
already measures whether they add alpha in Manny's hands (the correct forward test, zero
multiplicity cost). 2026-specific value ("expansion year is different") is untestable at
current n (~50-60 small-gap spots) — revisit only with a new mechanism or next season's OOS.

## Addendum 2 (same day): H2H lever + 2026-season descriptive view

**H2H (powered, 2024-25):** L_h2h = as-of same-season avg margin in prior meetings, trailer
perspective. Full frame n=612: standalone AUC 0.618 (trailer H2H+ 41.9% vs H2H− 28.0%) — looks
alive, but corr(g0, h2h) = **0.619** and blend optimal λ = **0** (g0 alone 0.7002 on the same
subset). Small-gap pool n=247: AUC **0.543** (38.1% vs 34.5%). **H2H is the quality gap in
disguise — zero incremental signal, and ~nothing in the region where g0 is silent.** It also
retroactively explains part of the WSH@TOR gut read: WSH 2-0 vs TOR was mostly restating that
WSH was the better team.

**2026 season so far (n=256 spots / 178 games; small-gap n=109, base 38.5%) — LOW POWER,
ordering only, NOT a derivation set:**

| lever | 2026 all (AUC) | 2026 small-gap (AUC) | 24-25 small-gap (ref) |
|---|---|---|---|
| g0 | 0.648 | 0.563 | 0.569 |
| L_vsrest | **0.698** | **0.660** | 0.571 (best) |
| L_infl | 0.576 | 0.651 | 0.485 |
| L_efgd | 0.609 | 0.554 | 0.511 |
| L_topefgd | 0.583 | 0.539 | 0.470 |
| L_vstop | 0.602 | 0.536 | 0.497 |
| L_h2h | 0.570 | 0.530 | 0.543 |
| L_tom | 0.503 | 0.470 | 0.462 |

Honest read: the levers ARE livelier in 2026 (Manny's expansion-year intuition), but this is
exactly the shape 2024-alone showed before inverting in 2025, at even lower n, across 16
lever×pool looks. One thread has cross-sample rank stability: **vs-Rest is the top lever in
both the powered pool and 2026** (heavily record-correlated, but the only consistent riser).

### FORWARD REGISTRATION (frozen 2026-07-14, evaluate ~season end)

Hypothesis: in small-gap spots (|g0| < .15), L_vsrest > 0 and L_infl > 0 predict elevated
trailer-win in the 2026 expansion environment.
- Pool: spots with **game date > 2026-07-14** (never seen by this analysis), same frame
  (first qualifying Q2/Q3 snapshot, trailing 1-9, ≥4 GP, dedup per game-quarter).
- Pass: forward AUC ≥ 0.58 for the registered lever(s) on the new spots, n ≥ 60.
- No re-derivation, no threshold tuning, no additional levers. Evaluation = rerun of this
  script over post-Jul-14 games (pipeline: /tmp scripts + live26_states extraction method).
- Regardless of outcome: levers remain discretionary/narrative until a forward pass.
