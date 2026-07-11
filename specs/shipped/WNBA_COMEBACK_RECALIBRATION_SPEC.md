# WNBA Comeback Engine — Recalibration Spec (v1.1)

**Status:** Proposed — awaiting go-ahead to implement
**Date:** 2026-06-21
**Scope:** `wnba-bdl.html`, function `comebackProb` + the render branches in `renderScoringCompSection`. No data, architecture, or `comebackEV` changes.
**Trigger:** live miss on SEA/PHX (`401857007`).

---

## 1. What happened

The engine fired on **SEA (3–13) down 8 to PHX (4–12)** in Q2:
> THIN GAP — true ~51% (44–58%) · +800 (mkt ~11%) · **EDGE +40pp** · size ~11% (¼-Kelly) · **take & hold**

The game did the opposite of the read. From the snapshot trajectory (`401857007`):

| moment | score | SEA margin |
|---|---|---|
| read fires (Q2) | PHX 47–37 | −10 |
| Q2 end | PHX 47–41 | −6 |
| mid Q3 | PHX 65–43 | **−22** |
| Q3 end | PHX 81–61 | −20 |
| Q4 | PHX 91–65 | **−26** |
| **final** | **PHX 92–71** | **−21** |

SEA never ran. A "take & hold" position bleeds out to a 21-point loss, with the "no exit" instruction actively telling the bettor not to bail. **Manny passed — correctly.**

---

## 2. Root cause

**The chaser was the *worse* team.** SEA win% .188 < PHX win% .25 → quality gap **−0.06**. The bad-leader-collapse thesis is "a **quality** team trailing a bad one." This was two bad teams with the *worse* one trailing — not the edge.

Two defects let it through:

1. **The gate only checks `leaderWP < 0.40`.** It never requires the trailer to be better than the leader, so even-or-worse chasers fire as collapses.
2. **The quality gap — the master variable (54/39/12, the largest spread in the research) — is implemented as a weak ±0.05 lean** on top of `cbDepthRate`. The depth curve dominates.

And the depth curve itself is the problem when misapplied: `cbDepthRate` (68/56/50/44) was measured on **bad-leader spots, which skew better-chaser-heavy** (a bad team leading usually means a better team trailing). So it is effectively the *"bad leader + decent chaser"* curve. Using it as the base for **all** gaps overstates even/worse chasers badly — SEA landed at 51% when the gap curve puts a −0.06 chaser at **~30%** (shallow), decaying with depth.

Net: a marginal-or-pass spot was rendered as a +40pp, 11%-of-roll, take-and-hold play.

---

## 3. The fix

### 3.1 `comebackProb` — gate on a real quality gap, make the gap the driver

```
if leaderWP==null || trailerWP==null   → NO_DATA
if leaderWP >= 0.40                     → NO_EDGE          (competent leader, unchanged)
if deficit >= 20                        → DEAD             (too deep, unchanged)
gap = trailerWP - leaderWP
if gap < 0.10                           → NO_QUALITY_EDGE   ← NEW gate
                                          (chaser not meaningfully better than the bad leader)

base = cbDepthRate(deficit)
if gap > 0.20:                          // STRONG band — validated core
    bonus  = (gap > 0.40) ? 0.10 : 0.05 // dominant gap pushes toward the 58–75% zone
    pPoint = min(0.85, base + bonus)
else:                                    // MODERATE band (gap 0.10–0.20)
    pPoint = base * 0.75                 // depth curve overstates modest-gap chasers

if fadeRead.tier === 'STRONG FADE': pPoint = min(0.85, pPoint + 0.03)  // fragility, unchanged

tier = gap > 0.20 ? (deficit <= 7 ? 'SHORT' : 'STRONG') : 'MODERATE'
```

The old `lean` term is removed.

**Calibration check against known spots:**

| spot | gap | new result |
|---|---|---|
| TOR/CON, down 12, STRONG FADE | +.34 | STRONG, pPoint **0.58** (was 0.57 — core unchanged) |
| **SEA/PHX, down 8** | **−.06** | **NO_QUALITY_EDGE — suppressed** |
| even teams (gap +.02) | +.02 | NO_QUALITY_EDGE |
| modest-gap chaser, down 12 | +.15 | MODERATE, pPoint **0.375** (~38%, was ~49%) |
| dominant chaser, down 10 | +.50 | STRONG, pPoint **0.60** |

### 3.2 Render — suppress note + framing by backstop

- **`NO_QUALITY_EDGE`** → muted box (neutral styling, no EV):
  > "{trailer} ({rec}) isn't better than {leader} ({rec}) — comeback here is a coin flip with no backstop. Pass."
- **Take-and-hold only where there's a backstop.** `take & hold` framing fires on **STRONG / SHORT** only. **MODERATE** gets:
  > "*variance-dependent — back small; no structural backstop if the lead holds.*"

  Rationale: take-and-hold assumes a quality team grinds the lead back even when variance is slow. A modest-gap spot has a thin backstop; the bettor should know the position can run away (this is exactly the SEA failure mode at a smaller gap).

---

## 4. What does NOT change

- The **validated STRONG core** (real quality gap, e.g. TOR/CON) — same probabilities, same take-and-hold. This is the edge; it's untouched.
- `cbDepthRate`, `comebackEV`, `americanToImplied`, the depth ceiling (20+ DEAD), competent-leader `NO_EDGE`, the fragility confirm, the standings/odds plumbing, and the section placement.
- Blast radius: one function's internal branches + two render branches. No data or architecture change.

---

## 5. Tests (the coverage gap that let SEA through)

Add to the fixture suite:

| fixture | gap | expect |
|---|---|---|
| SEA (3–13) / PHX (4–12), down 8 | −.06 | **NO_QUALITY_EDGE** (no size, no take-and-hold) |
| even teams (.45 / .47), down 9 | −.02 | NO_QUALITY_EDGE |
| modest-gap (.55 trailer / .40 leader), down 12 | +.15 | MODERATE, pPoint ~0.35–0.40, framing NOT "take & hold", smaller size |
| TOR (.47) / CON (.12), down 12, STRONG FADE | +.34 | STRONG, pPoint ~0.58 — **assert unchanged from v1.0** |
| dominant (.65 / .20), down 10 | +.45 | STRONG, pPoint ~0.60 |

Plus a regression assert that the **TOR/CON output is byte-stable** against v1.0, to prove the core didn't move.

---

## 6. Open tuning question (thin n — flag, don't pretend precision)

- **Gate threshold (gap ≥ 0.10)** and **MODERATE discount (×0.75)** are gradient choices on small samples. The *structure* (gate on positive gap; gap drives the probability; take-and-hold only with a backstop) is the fix; the exact constants are tunable as games accrue. The SEA/PHX deep at/above-vs-below cell and the worse-trailer-vs-bad-leader rate are both on the re-run list once the season fills in.
