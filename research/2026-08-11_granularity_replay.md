# 2026-08-11 — Instrument-Granularity Replay (2026 tape): FINDINGS

**Prereg:** `2026-08-11_granularity_replay_PREREG.md` (recipe + bars fixed before
cutting). **Script:** `2026-08-11_granularity_replay.mjs`. **States:**
`fixtures_gran_states.json` (fine 932 + coarse 777 + episodes 198, committed).
Tape: 217 finished 2026 games, production snapshots, read-only.

## VERDICTS

**1. H0 — CORRECTED (instrument spec was wrong in memory).** Production
inter-snapshot spacing is **median 26s of game time** (p25 15s / p75 41s / p90
56s); only 7.1% of deltas fall in [60,90]s. The remembered "70% at ~75s" figure
described the WALL-clock poll cadence; game-clock stoppages make the game-time
grid ~3x finer. The production-vs-arena granularity ratio is **~6x, not 2x**.

**2. H1 — CONFIRMED, STRONGLY MATERIAL (the PM's structural read was right).**
The 2.5-min checkpoint grid misses **35.4% of in-band episodes** (70/198,
dedupe-free seen-check; 42.9% under state-dedupe accounting — both far over the
pre-registered 10% bar). **Median in-band episode lives 71 seconds; 60.6% live
under 2 minutes.** The arena instrument cannot see most individual qualifying
moments. Power: MED (198 episodes, game-clustered).

**3. H3 — THE FLIP: the missed trailers were NOT hidden winners.** Missed
episodes convert **58.6% (n=70)** vs seen **57.8% (n=128)** — statistically
identical. Short-only split: 56.6 vs 51.4, mild ordering, LOW power, no claim.
The specific fear — that the coarse instrument systematically loses comeback
winners and waters the numbers down — is **NOT SUPPORTED** on the 2026 tape.
The instrument loses SAMPLE, not measurement: brief states convert like
persistent ones this season. (Caveat: measured in a TRANSIENT_COLLAPSE regime;
transfer to 2024-25 unknown and now lower-priority.)

**4. H2 secondary tell — THE d46 RIDER SURVIVES.** Downsampled to the arena's
own grid, 2026 still runs hot: coarse d46 = **52.9% (n=51)** vs the historical
arena's 39.4. The 2026-vs-historical gap is **not a granularity artifact** —
regime (or something else that is not the instrument) is real on this axis.
Cell-level fine-vs-coarse deltas are otherwise non-directional small-n churn
(signs flip cell to cell; coarse cells n=51/25/13/8).

**5. REPRO GATE — PARTIAL, and the gap it exposes matters more than the miss.**
Fine arm vs the documented deficit26: d46 **60.0 (n=55) EXACT** · d13 62.9
(n=105) vs 65.4 (n=104) · d79 40.7 (n=27) vs 42.9 (n=35). The documented
numbers were found to have **no committed derivation script** — they exist only
in the parity spec text. This study's recipe is committed, prereg'd, and lands
within ~2.5pp; the original's exact recipe is unrecoverable.

## DECISION QUEUED FOR PM (no action taken)

Re-pin `deficit26` in SS_STRUCT from THIS committed script — 62.9/105 ·
60.0/55 · 40.7/27 — so every SS_STRUCT cell has regenerable provenance
(currently deficit26 is the only transcribed-not-computed structural-side data).
Consequences under the mechanical R1 rule: **d46 rider unchanged** (~60% this
season); **d79 rider DROPS** (8.7pp ≤ 10 AND n=27 < 30 — fails both legs),
which retires yesterday's d79 borderline flag on its own.

## WHAT DOES NOT CHANGE

- Arena structural numbers stay valid for what they measure — persistent-state
  conversion — and H3 says brief states convert the same, so no correction
  factor is warranted at current power.
- Sticky's kill stands: it died on merits with a mechanism, and nothing here
  reopens it (the granularity route to a revival was the H3 path, which came
  back flat).
- No 2024-25 re-reconstruction: the concern that motivated it did not survive
  contact with the 2026 control test.

## CAVEATS

Tape is 217 games vs ~211 at the audit (tape grew; explains part of small n
drift). Episodes are game-clustered, not independent. The seen/missed split is
descriptive of THIS season's regime. H3 at n=70/128 is MED-LOW power — a true
±8pp difference could hide in it; the point estimate is flat, the claim is
"not supported," never "disproven."
