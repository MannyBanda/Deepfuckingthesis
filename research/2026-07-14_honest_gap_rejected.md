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
