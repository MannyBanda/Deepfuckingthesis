# 2026-08-11 — PRE-REGISTRATION: Instrument-Granularity Replay (2026 tape)

**Motivation (PM, Aug 11):** checkpoint-arena studies live at 2.5-min granularity;
production perceives ~75s. Short-lived qualifying states may be under-sampled by
the coarse instrument, and A/B conditions have been observed to persist <2 min.
Concern: arena numbers are "watered down," and part of the 2026-vs-historical gap
attributed to regime (TRANSIENT_COLLAPSE) may be instrument artifact.

**Design (PM-directed):** downsample the 2026 production tape to the arena's
checkpoint grid and compare against the same tape at native snapshot granularity.
Same games, same season, same regime, same recipe — the instrument is the only
difference. No pre-2026 data in this study.

**Caveat carried:** any instrument effect measured here is measured IN a
TRANSIENT_COLLAPSE regime; transfer of the correction to 2024-25 is a separate
question, opened only if this test finds something.

## Population & recipe (fixed before cutting)
- 2026-season finished games, UUID ids, from the production archive.
- States: periods 2-4, margin 1-15, both teams FGA >= 12, both teams GP >= 10
  as-of game date (records from the games list, date-ordered, date < game date).
- gap = trailer as-of wp − leader as-of wp.
- Dedupe: one state per (game, leader, timebucket); timebucket = Q{2,3,4} ×
  {early, late} (arena convention: 7.5/5.0 marks = early, 2.5/0.0 = late).
- FINE arm: walk snapshots in game-time order; first qualifying snapshot per key.
- COARSE arm: arena marks at elapsed (P−1)·600 + {150,300,450,600}s; snap each
  mark to the nearest snapshot within ±75s of elapsed game time (else mark
  missing); evaluate that snapshot; same dedupe keyed by the MARK's bucket.
- Episodes (in-band): contiguous fine-walk runs with same leader, gap >= .15,
  margin 1-9, guards passing. An episode is SEEN by coarse iff >= 1 coarse-kept
  in-band state (same leader) falls inside its [start, end] elapsed interval.

## Hypotheses & bars
- **H0 (instrument check):** measure inter-snapshot elapsed spacing; verify or
  correct the remembered "70% at ~75s" figure. Descriptive, no bar.
- **REPRO GATE:** the FINE arm must reproduce the documented deficit26 cells
  (d13 65.4/104 · d46 60.0/55 · d79 42.9/35) within rounding. These numbers have
  NO committed derivation script (discovered at study start) — reproduction gives
  them provenance; failure to reproduce is itself a reportable finding and halts
  H2/H3 interpretation until resolved.
- **H1 (materiality):** coarse misses > 10% of in-band episodes → material.
- **H2 (conversion shift):** per-cell delta, coarse − fine, on d13/d46/d79
  (gap >= .15). Primary metric. Secondary tell: does the coarse-2026 replay land
  closer to the historical arena numbers (60.8/39.4/32.0) than the fine tape?
- **H3 (the missed set):** conversion of episodes visible ONLY at fine
  granularity. Power warning pre-committed: expected n < 80 → ordering only, no
  directive language, no precision claims.

## Outputs
- research/2026-08-11_granularity_2026_replay.{md,mjs}
- research/fixtures_gran_states.json (fine + coarse states, committed)
- No engine changes. Read-only against production.
