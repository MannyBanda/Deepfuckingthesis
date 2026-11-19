# EXPLORATORY — the WNBA Sweet Spot shape on the 2026-27 NBA production tape (Oct 21 – Nov 18)

**Status:** exploratory, cuts declared in chat before contact (gap staircase; gap × leader-eFG band; gap × beatable leader), no bars, no promotion possible. **The 2026-27 tape is now contaminated for these cells**; any prereg must take its verdict from the two fine arenas and keep 2026-27 as the forward log. Script: `research/2026-11-19_nba_ss_season_exploratory.py`.

**Instrument:** 219 finals, 23,310 production snapshots. As-of records built strictly from finals (both teams ≥ 5 GP; median GP at fire ≈ 10 — early-season records are noisy). Leader eFG from `raw_stats_json` at the state. **Fair line = ESPN WP for the trailer at the moment** (NBA ML stamps are a live/pregame mix; ESPN is the honest proxy). Population: Q2–Q3, trailer down 1–9, **first perception** per game-trailer (209 game-trailers, 132 games). Edge = trailer-WIN − ESPN.

## (A) Gap staircase, pre-Q4

| gap (trailer − leader as-of win%) | n | trailer-WIN | ESPN | edge |
|---|---|---|---|---|
| trailer worse by ≥ .15 | 83 MED | 22.9% | 24.8% | −1.9 (±9.0) |
| even | 59 LOW | 33.9 | 37.2 | −3.3 |
| better .15–.35 | 33 LOW | 54.5 | 49.5 | +5.0 (±17) |
| better ≥ .35 | 33 LOW | 66.7 | 59.7 | +7.0 (±16) |
| **GAP_BASE (≥ .15)** | 66 LOW | 60.6 | 54.6 | **+6.0 (±11.8)** |

Consistent with the locked NBA verdict: the gap alone is roughly priced (+6 inside ±12).

## (B) The A-tier shape — gap ≥ .15 × leader eFG, pre-Q4

| leader eFG at first perception | n | trailer-WIN | ESPN | edge |
|---|---|---|---|---|
| < 50 (cold) | 12 LOW | 58.3 | 62.8 | −4.5 |
| 50–57 (normal) | 15 LOW | 26.7 | 59.9 | −33.2 (±22) |
| **≥ 57 (hot)** | **39 LOW** | **74.4** | **50.1** | **+24.3 (±13.7)** |
| WNBA band as-is (> 55) | 46 LOW | 67.4 | 50.6 | +16.8 (±13.5) |
| not hot (< 57), gap ≥ .15 | 27 LOW | 40.7 | 61.2 | −20.4 (±18.5) |

Robustness (post-hoc, descriptive): first half of the month +24.0 (n=19) / second half +24.6 (n=20) · deficit 1–3 +12.7 / 4–9 +32.4 · gap .15–.35 +31.2 / ≥ .35 +17.0 · eFG threshold ordering .52 +10.6 → .55 +16.8 → .57 +24.3 → .60 +21.1 → .63 +21.6 (plateau from .57).

**Mechanism check — the whose-variance gating:** hot-leader edge by gap class: trailer WORSE **−7.3** (n=40) · EVEN **−7.9** (n=29) · trailer BETTER **+24.3** (n=39). Not-hot by gap class: +3.1 / +1.2 / **−20.4**. The heat pays only when the trailer is the better team; a better trailer facing a leader who is *not* shooting hot is losing badly to fair (the lead is earned). This is the FUEL × GAP map's structure (≥ .15 TRANSIENT +14, elsewhere ~0, EARNED −21) reproduced on NBA tape.

## (C) Beatable leader — gap ≥ .15 × leader win%
< .400 → +8.9 (n=47) · .400–.550 → +12.9 (n=15) · ≥ .550 → 0/4. Compound < .400 × hot → +23.6 (n=29).

## Read
This is the strongest exploratory NBA cell this project has produced, and it has the right *shape*: the controls are flat-to-negative exactly where the mechanism says they should be. It is also one month, LOW power, on 10-game records, with the WNBA's absolute eFG band applied uncalibrated (most first perceptions sit at Q2 12:00, so "leader eFG" is one quarter of shooting), against a proxy rather than a price. It **contradicts** the 2025-26 full-season deficit-controlled null (n≈1,200) — the candidate reconciliation is the PM's regime hypothesis (early-season volatile leads collapse), which is now testable on both fine arenas by calendar window. The 39 fires are listed in the chat record of 2026-11-19.
