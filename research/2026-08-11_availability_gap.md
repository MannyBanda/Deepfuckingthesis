# Availability-Adjusted Quality Gap — NOT PROMOTED (all four hypotheses failed)

**Pre-reg:** `2026-08-11_availability_gap_PREREG.md` sha1 `04b1882`, locked 13:17Z before data cut.
**Arena:** 2024+2025 checkpoint reconstruction, 576 games → **2,724 states** (1,121 / 1,603 by season).
**Absence:** BDL `player_stats`; rotation = trailing-10 team games, mpg ≥ 8.0 per team game;
OUT = rotation player with no row or 0 minutes. Archive→BDL join 576/576, zero misses.
**Transfer:** 2026 prod ledger, 51 resolved SS rows, 51/51 joined.

## Results vs pre-registered bars

| H | Test | Bar | Result | Verdict |
|---|---|---|---|---|
| H1 | trailer out_min_share, band0 → >.20 | ≥10pp drop, both seasons | **+5.1pp** in-band (+7.0pp all) | **FAIL** |
| H2 | leader out_min_share, band0 → >.20 | ≥8pp lift, both seasons | **+7.2pp** in-band, non-monotone | **FAIL** |
| H3 | separation surviving inside gap strata | ≥8pp | **+6.2 / −7.3 / +3.7pp — sign flips** | **FAIL (unstable)** |
| H4 | rule R (out5≥2 OR share≥.25) | ≥10pp below unflagged, both seasons | **+5.9pp** in-band | **FAIL** |

### H1 — trailer absence, in-band 1–9
| band | n | conv | 2024 | 2025 |
|---|---|---|---|---|
| 0 | 679 | 34.2% | 31.5% (340) | 36.9% (339) |
| (0,.10] | 498 | 29.9% | 33.3% (213) | 27.4% (285) |
| (.10,.20] | 496 | 29.8% | 29.2% (212) | 30.3% (284) |
| >.20 | 327 | 29.1% | 8.5% (59, LOW) | 33.6% (268) |

Pooled drop is carried entirely by one underpowered 2024 cell (n=59). On the only
well-powered high-band cell (2025, n=268) the drop is −3.3pp. Not structural.

### H3 — additivity inside gap strata (in-band)
| gap | clean n / conv | any-out n / conv | delta |
|---|---|---|---|
| <.15 | 508 / 29.9% | 1008 / 23.7% | +6.2pp |
| .15–.30 | 94 / 40.4% | 199 / 47.7% | **−7.3pp** |
| >.30 | 77 / 54.5% | 114 / 50.9% | +3.7pp (LOW) |

Sign flips. In the `.15–.30` stratum — where the killer effect concentrates and where
CHI@SEA sat at .199 — trailers **with** absences converted *better*.
Control intact: raw gap staircase 25.8% → 45.4% → 52.4%. Arena is healthy; this is a
real null, not a broken pipeline.

### H4 — component decomposition (in-band) — the decisive cut
| component | flagged n | conv | vs rest | delta |
|---|---|---|---|---|
| out_core5 ≥ 1 | 617 | 30.6% | 31.5% | +0.8pp |
| out_core5 ≥ 2 | 135 | 30.4% | 31.3% | +0.9pp |
| out_core5 ≥ 3 | 39 | 30.8% | 31.2% | +0.4pp (LOW) |
| out_min_share ≥ .25 | 210 | 26.7% | 31.7% | +5.1pp |

**Starter headcount is a flat null** (31.5 / 30.7 / 30.2 / 30.8% across 0/1/2/3+ out).
What little signal exists is minutes-weighted, and it does not reach the bar.

### 2026 transfer (LOW power, ordering only, n=51)
Trailer clean 84.6% (n=26) vs any-out 68.0% (n=25). Direction matches H1 but sits far
below the n=80 cutoff — **no directive verbs**. Rule R flagged **0 of 51** rows all season.

## CHI@SEA autopsy — the triggering premise does not hold

CHI trailing-10 rotation as of Aug 9:

| player | mpg/team-game | played |
|---|---|---|
| Skylar Diggins | 0.0 | **0/10** |
| Maddy Westbeld | 0.8 | 1/10 |
| Sydney Taylor | 20.9 | 8/10 |

Of the three names, only **Taylor** was a new absence. Diggins had not played in ten
games; Jackson was out since May 19. Reconstructed: CHI `out5=1`, `share=.104` —
and **SEA was worse** at `share=.206`. Net availability favored CHI.

Recency check:

| team | season wp | trailing-10 | drift |
|---|---|---|---|
| CHI | .375 (n=32) | .500 | +.125 |
| SEA | .176 (n=34) | .000 | −.176 |

Season gap **+.199** vs trailing-10 gap **+.500**. The gap was stale — in the
**opposite** direction. The engine understated the edge. The bet lost on variance in a
single state, not on an availability blind spot.

## What this does NOT settle

1. No historical live lines for 2024–25 → conversion only, never edge vs price. If the
   market over-shades injured trailers, flat conversion is a *buy*, not a pass.
2. Absence includes rest/DNP-CD/suspension.
3. Box-derived absence is post-hoc; this is the ceiling on deliverable value.
4. **Star-quality is untested.** out_core5 treats a 31-mpg lead guard and a 9-mpg
   rotation piece identically. A usage- or scoring-share-weighted absence metric is a
   separate hypothesis and remains open.
5. **Same-day scratches are untested** — the trailing window absorbs chronic absences by
   construction, which is exactly why it found nothing for CHI.

## Successor hypothesis (for separate pre-registration)

The real defect surfaced by CHI@SEA is **recency, not availability**: season win% is a
stale estimator of current team strength, and absence is only one of the things that
makes it stale. Proposed next study — does a trailing-10 (or recency-weighted) win% gap
outperform the season win% gap on trailer conversion, and does the season-vs-recent drift
itself carry signal? That question is well-powered on this arena and directly addresses
what went wrong, which this study did not.
