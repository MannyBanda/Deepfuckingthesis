# 2026-08-11 — FINE ARENA (30s grain): FINDINGS

**Prereg:** FINE_ARENA_SPEC v1 (chat, PM go) + §4 change rule (>2pp AND both
seasons). **Instruments:** walker grain param (regression gate PASSED 2,724/2,724
exact vs committed arena), 576 games re-reconstructed at 30s marks → 3,224
deduped states (3,113 in the coarse-comparable 750-2250s window). **States:**
`/tmp` + `fixtures_tier_replay_states.json` committed; fine states regenerable
via `pull + fine_arena_states.mjs`. As-of records fixture-pinned (never
closing-season — PM directive).

## VERDICT 1 — THE DEFICIT CLIFF AT 3-4 IS MOSTLY INSTRUMENT, THE REAL BREAK IS AT 6-7
gap>=.15, trailer-WIN, coarse-window-matched:

| cell | FINE (30s) | coarse (2.5m) | 2024 fine | 2025 fine |
|------|-----------|---------------|-----------|-----------|
| d13  | 54.9 (335)| 60.8 (232)    | 61.1      | 50.0      |
| d46  | **52.2 (138)** | 39.4 (155) | 57.9    | 48.1      |
| d79  | 35.8 (106)| 32.0 (97)     | 36.1      | 35.7      |

d13→d46 at fine grain = a 2.7pp step, not a 21pp cliff; d46→d79 = −16.4pp,
both seasons. **Mechanism (the sampling-moment bias):** the coarse instrument
samples leads that SIT at a deficit for 2.5 minutes; the fine instrument samples
the FIRST moment a deficit exists, including transient pass-throughs. A lead
parked at 4-6 is a stronger lead than one passing through 4-6. Production fires
on first perception (~26s grid) — **the fine prior is the transfer-correct one
for fire-time reads.** This was the PM's original instrument hypothesis,
vindicated through a mechanism the morning's episode test could not see (it
checked missed episodes, not WHICH moment within seen buckets gets stamped).

## VERDICT 2 — THE 2026 d46 RIDER DECOMPOSES: ROUGHLY HALF INSTRUMENT, HALF ERA
d46 in all four instrument×era corners: fine-2026 **60.0** · coarse-2026 52.9 ·
fine-hist **52.2** · coarse-hist 39.4. Instrument effect ≈ +8-13pp; era effect
≈ +7-8pp. The +20.6pp rider on the card conflated the two. Measured
like-for-like (fine vs fine), this season's d46 edge over history is ~+8pp.

## VERDICT 3 — §4-ELIGIBLE CELL CHANGES (>2pp AND both seasons)
ELIGIBLE: d13 −5.9 · d46 +12.8 · q4e +6.8 (44.7/85) · q4l +8.3 (31.5/73) ·
gapStrong +4.6 (60.8/189) · d79 +3.8 (2025 leg marginal +0.9, noted).
NOT eligible (<2pp): preQ4, gapQual, holds, ldrBad/Mid (~3pp, season-mixed),
ldrQual (n=40, LOW).
**If the fine arena is adopted as the structural source AND deficit26 is
re-pinned from the committed 2026 script (62.9/60.0/40.7), every R1 rider
drops** (|2026−base| = 8.0/7.8/4.9, all ≤10pp) — the card becomes single-number
structural at instrument-matched values. Cleaner and more honest than the
current mixed-instrument riders.

## VERDICT 4 — TIER-SHAPE REPLAY (price-blind; fade/collapse/class verbatim)
| shape | conv | n | note |
|-------|------|---|------|
| A+B shapes pooled | 64.3% | 14 | ordering only — funnel is ~0.4% selective |
| GAP_BASE (base gates pass) | **59.0%** | 229 | HIGH power; 2024 71.6 / 2025 47.5 |
| collapse-fail (everything else) | 26.6% | 2,957 | |
| Q4_COLLAPSE (Q4 d10-15) | **0.0%** | 24 | 0/24, BOTH seasons |

The base gates (beatable leader + real gap + catchable depth) carry a +32pp
separation at HIGH power; the A/B shape refinement adds ~+5pp at unpowered n.
The price leg is stubbed — this is shape selectivity, never P&L. **Q4_COLLAPSE
converted zero of twenty-four historically** — disposition decision queued.

## DECISIONS QUEUED FOR PM (nothing auto-changed)
1. Adopt fine arena as SS_STRUCT structural source (§4-eligible cells re-pin;
   build_ss_struct gains a fine mode; states file committed).
2. Re-pin deficit26 from the committed granularity script (all riders then drop).
3. Q4_COLLAPSE: keep log-only forever, or kill the stream.
4. Product question flagged only: the catchable band's interior geometry —
   fine grain says 1-6 is one country and 7-9 another; copy and sizing-confidence
   language currently narrate a 3-4 cliff.

## CAVEATS
Fine cells are game-clustered like all arena cells. The persistence signal the
coarse instrument measured is real information (a lead that sits is stronger) —
retiring it from the PRIOR does not retire it as a LIVE read; JUICE re-checks
naturally observe persistence. 2024/2025 season splits diverge notably in
several cells (d13, GAP_BASE) — both-seasons discipline remains the bar.
