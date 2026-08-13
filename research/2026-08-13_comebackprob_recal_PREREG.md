# PREREG — comebackProb recalibration vs the FINE ARENA

**Date:** 2026-08-13 · **Status:** PM GO received in chat (Aug 13) — committed before any outcome data cut.
**Motivating question (PK v5.4):** the `collapse_true` stamps behind the ledger's predicted column were set before either arena existed and have never been calibrated against a transfer-correct instrument. The A-tier +30.4pp over-performance may be partly stamp bias — or partly era. This study decides which.

## What is being measured

`comebackProb` is the engine's stamped **true win probability** for the trailer — carried as `collapse_true` on SS rows, compared against the market's implied probability by the edge gate (`comebackEV`), printed as the ledger's predicted column and the narration "true vs implied" line, and (post-graduation) the Kelly input. **Calibration** = among states stamped X%, do X% actually convert? **Signed calibration error** = realized − stamped (positive = stamp too low). **Brier score** = mean squared error of the probability vs the 0/1 outcome (lower better; rewards calibration and sharpness together).

## Phase 0 — instrument pinning

Derivation pinned verbatim from poll-live-bdl.mjs (L5308, L5329, L5343) at commit a3f885a:

```js
function cbDepthRate(d) { if (d <= 5) return 0.68; if (d <= 9) return 0.56;
  if (d <= 14) return 0.50; if (d <= 19) return 0.44; return 0; }

function comebackProb(leaderWP, trailerWP, deficit, period, fadeRead) {
  if (leaderWP == null || trailerWP == null) return { tier:'NO_DATA' };
  if (leaderWP >= 0.40) return { tier:'NO_EDGE', leaderWP:leaderWP };
  if (deficit >= 20) return { tier:'DEAD', deficit:deficit };
  var gap = trailerWP - leaderWP;
  if (gap < 0.10) return { tier:'NO_QUALITY_EDGE', gap:gap };
  var base = cbDepthRate(deficit), pPoint, drivers = [];
  if (gap > 0.20) { var lean = Math.max(-1, Math.min(1, (gap-0.20)/0.20))*0.05;
    pPoint = Math.max(0.10, Math.min(0.85, base+lean)); }
  else { pPoint = base*0.75; }
  if (fadeRead && fadeRead.tier === 'STRONG FADE') { pPoint = Math.min(0.85, pPoint+0.03);
    drivers.push('fragile lead'); }
  var tier = gap > 0.20 ? (deficit <= 7 ? 'SHORT' : 'STRONG') : 'MODERATE';
  return { tier:tier, pPoint:pPoint, pLow:Math.max(0.05, pPoint-0.07),
    pHigh:Math.min(0.95, pPoint+0.07), gap:gap, drivers:drivers };
}
```

Pinned facts: the stamp is **deficit-only** (period is a parameter but unused — the stamp is time-blind while the fine arena shows 55.3 → 44.7 → 31.5 across preQ4/Q4e/Q4l); hard gates inside the function (leader wp ≥ .400 → no stamp; gap < .10 → no stamp) explain routine `collapse_true` NULLs; gap .10-.20 takes a flat ×0.75 haircut; gap > .20 adds a linear lean to +.05 at gap .40; STRONG FADE adds +.03; clamps .10-.85; ±.07 display band. The .68 base at d≤5 sits ABOVE both fine d13 (54.9) and coarse d13 (60.8) — the direction of bias is an open empirical question, NOT presumed "lowball."

Remaining Phase 0 (before Phase 1 cut; any surprise amends this doc, disclosed and dated):
(a) git-history provenance of the .68/.56/.50/.44 constants; (b) consumer audit — confirm whether odds-squeeze or JUICE thresholds consume `collapse_true` (believed no); (c) confirm fine-arena states carry as-of records, deficit, and fadeRead-computable box fields.

## Population

**Stampable states:** fine-arena states (`research/fixtures_fine_states_matched.json.gz`, 3,113 states, window 750-2250s, 2024+2025) where the function produces a number — leader wp < .400, gap ≥ .10, deficit 1-19. **Primary analysis region:** the band, deficit 1-9. **Primary unit:** state-level (matches how stamps are applied in production), with a one-first-stampable-state-per-game sensitivity cut and game-clustered standard errors.

## Hypotheses & bars

**H1 — miscalibration exists (direction is an output).** Bar: |mean signed calibration error| ≥ **4pp** on the band stampable population, **same sign in 2024 and 2025 independently**. Fails → current table survives, nothing promoted, findings committed anyway. Primary deliverable either way: the **signed-error map** by deficit region (1-3/4-6/7-9) × gap regime (haircut .10-.20 / lean >.20) × time bucket (preQ4/Q4e/Q4l) × stamped-probability bin.

**H1a — the ledger's directional read.** On the fired-comparable shape (base gates: beatable leader + qualifying gap + catchable depth), stamps understate fine-arena truth. May fail while H1 passes — if so, the A-tier over-performance is attributed to era + small-n and written down as loudly as the original claim.

**H2 — a fine-derived model is better calibrated.** Model ladder, fixed before fitting: **M0** = current function (control) · **M1** = same functional form and same deficit breakpoints, values re-fit from the fine substrate (bucket bases, haircut multiplier, lean slope) · **M2** = M1 + a time axis (Q4-early and Q4-late multipliers relative to pre-Q4). No other forms get fit; no re-bucketing (that would be a new prereg). Adoption bar: candidate beats M0 Brier on **season-holdout in both directions** (fit 2024→test 2025 AND reverse) AND pooled |mean signed error| < **3pp** after recalibration. **Parsimony rule:** promote the simplest model within 0.002 Brier of the best.

**H3 — does the +.03 fadeRead bump earn its keep?** At matched deficit×gap cells, STRONG-FADE states' realized minus non-fade states' realized ≥ **+3pp in both seasons** → bump stays. Otherwise the recalibration proposal drops it (resolving the locked signal's standing "candidate to drop"). Power rule: below MED (n<80 per side), ordering only — bump retained but flagged.

**Phase 3 — 2026 transfer (report, never a bar).** Score resolved stamped SS rows (n≈23, LOW) — and the 1,907 committed granularity states iff the as-of records join is clean — under current vs recalibrated stamps. Era effects stay riders per R3; this phase sizes the era residual, never tunes to it.

## Promotion rule & pre-declared second-order effects

All bars passing produces a **PM decision package, not a code change**. Pre-committed contents: (1) **edge gate** — % of historical stamped rows whose NO_VALUE/edge verdict flips under new stamps, measured; no gate-threshold changes ride along; (2) **graduation ledger** — original stamps remain the ledger of record; restamped column is analysis-only; both deltas presented at the graduation decision; no retroactive restamping; (3) **sizing** — flat test-caps unaffected now; post-graduation Kelly effect quantified; (4) **surfaces** — narration/price ladder/digest consume pPoint automatically; copy unchanged; parity fixtures re-pinned; (5) **ship shape** — new priors as a generated constant block via committed `research/build_cb_priors.mjs`, never-hand-edit, fixture-verified (SS_STRUCT contract).

## Deliverables

Findings doc + fit script + scored-states file committed to `research/` with date prefix; every number regenerable; power tags (HIGH 200+ / MED 80-200 / LOW <80) on every cell; retractions as prominent as findings if H1/H1a/H3 lands opposite to the motivating framing.
