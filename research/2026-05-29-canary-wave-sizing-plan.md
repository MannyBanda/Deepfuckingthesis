# WNBA MC Canary — Wave-Sizing Research Plan

**Date:** 2026-05-29
**Status:** PLAN — anchor for next session. Nothing built yet.
**Builds on:** `2026-05-28-wnba-canary-profitability.md` (validated: edge is real on market odds, MC-Cum co-dip is the discriminator).

---

## The reframe (Manny's surfing lens)

We have been measuring the **outcome** — did the bet win, did the line eventually compress. That is the
wrong unit of analysis. The unit is **the wave**.

> Sitting on the board, the skill is not judging a wave after it breaks. It is sizing the swell *while it
> is still forming* — early enough to paddle. A small wave is a waste of energy. We want to catch the big one.

This forces two changes to the analysis:

1. **Metric flips from win/loss → wave size.** The right outcome variable is the MAX FAVORABLE COMPRESSION
   after the canary fires — how far the line (or the margin) moves in your favor before it re-extends.
   Under Manny's actual strategy (CASH OUT on collapse, not hold-to-win — see memory), wave height *is* the
   payout. The buy team does not need to win; the wave just needs to be big enough to cash green.

2. **The hard problem is EARLY detection — sizing the wave in the paddle window.** Not "was this fire
   followed by compression" (hindsight) but "at the moment of the fire, can we forecast a BIG wave?" The
   canary's lead time over the scoreboard (measured: leads by minutes) IS the paddle window. Question:
   what is observable in that window that separates a swell from a ripple?

---

## Why this unifies the three banked threads

- **Cash-out on collapse** (memory): wave height = cash-out value. Confirms the metric should be compression,
  not win/loss.
- **BUY inversion / momentum team** (memory): the canary buys the team WITH momentum (the one generating the
  wave), not the structural team being overrun. The wave IS the momentum run.
- **Baseline divergence** (memory): over/underperformance vs season norms = the mean-reversion fuel BEHIND
  the wave. Likely the single best wave-sizer.

All three say the same thing: stop grading the final result, start measuring the run itself, and learn to
size it early.

---

## Build (next session)

### Step 1 — Repoint the harness from EV to compression magnitude
Already have the pieces (`/tmp/odds_harness.py` traced real odds forward; `/tmp/canary_ev.json` has 36 fires
with snapshot timelines + real ML traces). Recompute the outcome variable as:
- **Line wave:** max favorable buy-team ML movement within {1,2,3,4} min of fire, before any re-extension.
- **Margin wave:** max reduction in leader's margin within the same windows (works on all games, not just
  ones with dense odds — wider sample).
Characterize the distribution: how often is the wave big enough to cash green, how big, how fast it peaks.

### Step 2 — Build the wave-size classifier (the real deliverable)
Target = wave size (continuous, or big/small bucket). Features observable AT or 1 poll after fire:
- **MC Cum co-dip depth + velocity** — fast/deep follow vs shallow.
- **Baseline divergence** — leader overperforming season norm + trailing team underperforming (need season
  baselines per team; SR seasonal stats or computed from prior games).
- **Peak lead size at fire** — more room to compress, but maybe slower wave.
- **Canary break velocity** — how violently MC windowed dropped (sharp vs drift).
- **XGB level at fire** — structural anchor; does a high XGB mean the wave fizzles (leader re-extends)?

Output is NOT "bet every canary." It is a PADDLE / LET-IT-PASS read delivered in the forming window —
making measurable the manual confluence judgment Manny already does.

### Step 3 — Validate wave-sizer against the cash-out timeline
A leader who ultimately HOLDS can still produce a big cashable wave (run compresses line, you cash, exit
before the hold). So re-grade the old "reject bucket" under the wave metric — it may be far more profitable
than win/loss made it look.

---

## Guardrails (carry from this week's rigor)
- n is small (~36 fires with odds; ~531 reconstructed at checkpoint scale). Wave-size magnitudes will be
  underpowered — report ORDERING, not precise thresholds, below ~80 samples.
- Odds traces use best-price-in-window = optimistic (assumes nailing the local max). Real execution lands
  between fire price and peak.
- Backtest checkpoints (2.5-min) are coarser than prod — wave timing will be blurrier than live. Prod is the
  sharp lens; this is directional.
- Output stays agent CONTEXT supporting manual paddle decision — NOT an auto-firing alert. Matches how Manny
  actually bets (confluence + odds patience + cash-out).

## Cached data ready for next session
`/tmp/canary_ev.json` (36 fires + real odds), `/tmp/wnba_mc_checkpoints.json` (6,336 MC-scored checkpoints),
`/tmp/canary_events.json`. Snapshot cache at `/tmp/wnba_snaps/`. (May not survive container reset — re-pull
via cached scripts in `research/2026-05-28-*` if gone.)
