# 2026-08-06 — TAKEAWAY DECAY × NET-POT study (PM-directed, pre-registered in chat)

**Question (Manny):** how does the takeaway-transient lead effect behave across game time
(early/late Q2/Q3/Q4), and is the mechanism absolute leader POT (≥6, current gate) or the
POT differential? **Data:** 2026 archive (199 games) → n=703 states, one per (game,
trailing-side, bucket), first in-band (deficit 1–9) hit per bucket, buckets split at 5:00
on 10-minute quarters; repo-extracted computeFuelTemp; as-of records GP≥10; live ML joined
700/703 (≤3 min). Primary metric: edge vs de-vig market (implied controls deficit/time,
making cross-bucket comparison honest). Primary pool gap ≥ 0 (n=321); gap ≥ .15 subset
ordering-only. All cells LOW power — the evidence is the sign pattern replicating across
six independent time slices, not any single cell.

## H1 — time decay: CONFIRMED as a STEP, not a slope
Takeaway-fed edge vs market (gap≥0): **+19 / +13 / +13 / +13 / +11 / −2** across
Q2e→Q4-late. Surface population (gap≥.15): **+25 / +13 / +20 / +18 / +12 / 0**.
The effect holds essentially intact through EARLY Q4 and dies inside 5:00 — the
regression-window mechanism, with the window closing at ~Q4 5:00, not gradually.
Row-1197's juice (Q4 2:22) fired in the dead bucket.

## H2 — net POT: REJECTED
Within takeaway-fed Q2+Q3 (gap≥0): net ≤0 → +10pp (n=47), net 1–5 → +17pp (n=50),
net ≥6 → +14pp (n=45). Gate head-to-head: absolute ≥6 (current) +14pp over n=142;
net-≥6 candidate +14pp over n=45 — same edge, a third of the coverage; the supposed
mislabel cell (absolute-fired, net <6) runs +14pp. **Mechanism: the leader's OWN
takeaway-fed production is transient regardless of the opponent's takeaway line.
POT_MIN=6 absolute validated; no gate change.** (Q4-only whisper, ordering-only:
net ≤0 → 0pp vs net ≥1 → +11pp — net may matter when time is short; n too small to act.)

## H3 — last positive bucket: Q4-early
The kernel's numeric claim is legitimate through Q4 ~5:00 and not after.

## Secondary
Earned-lead controls negative in every bucket (−16 to −51pp; late buckets n=1–4,
ordering-only) — the earned pass signal's sixth+ independent replication.

## Shipped on PM go (same day)
Three-form time-conditioned CHANNEL NOTE in ssCautionLines (poll + squeeze mirror,
source-equality contract): pre-Q4 unchanged (~85% line) · Q4 ≥5:00 tempered (~+12pp,
window closing) · Q4 <5:00 number suspended (window closed, market-priced) — unknown
Q4 clock degrades conservatively to the late form. Clock rides the existing row param
(fire rows + squeeze snapshot). No gate changes, no tier changes.

**Multiplicity record:** recipe, buckets, hypotheses, and primary metric pre-registered
in chat before the cut; H2 rejected and reported; regime label 2026 on all numbers;
monthly pulse remains the watchdog. Script: research/2026-08-06_takeaway_decay.mjs.

## ADDENDUM — HOLDER READ six-bucket giveback cut + dashboard parity ship (same day)
Population = the HOLDER READ surface (gap ≤ −.15, transient lead), n=250, same recipe.
Giveback by bucket: 28/19/19/26/25/19% vs market 25/23/24/25/23/20% — **flat and
market-priced in every bucket** (edges −5 to +3 = noise). The ~24% claim is time-robust;
no conditioning needed — copy tagged "(time-stable across all six buckets)."
Honesty catch: EARNED leads in this population give back 21% (n=19) vs transient ~22% —
indistinguishable — so the green HOLDER READ superlative ("strongest hold shape")
overclaimed for the below-bar holder context; softened to the mechanism statement
("no transient feed to give back"). Client gained a verbatim ssCautionLines mirror
(source-equality pinned) rendering the same time-conditioned kernels as alerts; trap
line excluded on the dashboard (the verdict box owns it there).
