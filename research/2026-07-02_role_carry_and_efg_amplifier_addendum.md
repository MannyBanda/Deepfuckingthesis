# Addendum — Manny's Two Framings Tested (same 720-game PBP set)

**Date:** 2026-07-02. Follows `2026-07-02_direction2_heater_fade_killed.md`. Directed tests of
two PM hypotheses (not exploratory fishing): (1) is there a context where an individual carry IS
fragile — specifically star-carry vs role-player-carry with a poor supporting cast; (2) does
extreme/team-level eFG heat matter conditional on quality gap ("whose variance is it").

## Q1 — Role-player carry: THE fragile-heater context (candidate, small n)

Halftime leads, margin 1–9 (n=448, base comeback 33.9%). Heater = top-scorer share ≥.30,
TS dev ≥+.10, FGA ≥5:

| Cut | Comeback | n |
|---|---|---|
| STAR heater (season ppg ≥14) | **25.6%** (lead SAFE) | 90 |
| ROLE heater ppg ≤9 | **83.3%** | 12 |
| ROLE heater ppg ≤10 / ≤11 / ≤12 | 73.3% / 70.0% / 60.9% | 15 / 20 / 23 |
| Role top-carry share ≥.28, NO heat req | **68.0%** | 25 |
| Heater + rest-of-team cold (≤−5pp) | 32.7% (null) | 49 |

End-Q3 (base 29.5%): role ≤11 = 60.0% (n=10), ≤12 = 50.0% (n=14), no-heat top-carry 42.9%
(n=14); STAR heater 19.2% (n=73) — star-carried leads through Q3 hold 81%.

**Reading:** the fade signal isn't "heat" — it's **WHO carries**. Everyone regresses to norm
(kill-doc H2); a star's norm sustains the lead, a role player's norm doesn't. "Rest-of-team
cold" adds nothing; the carrier's identity is the whole signal. Monotone across ppg thresholds,
holds directionally at Q3, needs no TS-dev measurement (a ≤10ppg player leading a team's scoring
IS the heat, definitionally). Consistent with the pre-existing T1 (Role Player Heater) trajectory
signal. **Grade: strong candidate, NOT validated — halftime cells are n=12–25.** Next validation:
pull 2021–2023 PBP (BDL covers to 2021, ~500+ games) as true OOS for the role-carry cell; log
forward in nightly betting log meanwhile.

## Q2 — eFG heat: dead standalone, alive as a GAP AMPLIFIER

Halftime, margin 1–9. Leader team eFG dev vs own season norm; trailer likewise:

| Cell | Comeback | n |
|---|---|---|
| leader hot (≥+8pp) + trailer AT/BELOW norm | 50.0% | 44 |
| leader hot + trailer also hot | 35.8% | 120 |
| leader not hot | 30.6% | 284 |
| **gap ≥.10 alone** | **52.9%** | 121 |
| **gap + leader hot ≥+8pp** | **61.1%** | 54 |
| **gap + leader hot + trailer ≤ norm** | **64.7%** | 17 |
| gap + leader NOT hot | 46.3% | 67 |
| NO gap + leader hot + trailer ≤ norm | 37.5% | 16 |

Absolute-eFG tail (Q2a) is noisy/non-monotone — no clean "past X it breaks" threshold; the
signal only appears **relative to own norm and conditional on gap**. Structure is monotone:
46.3 → 52.9 → 61.1 → 64.7. Without the gap, two-sided heat is ~base (37.5%).

**Reading:** reconciles the prior "eFG null" (standalone, NBA) with Manny's live results —
eFG-heat is not an edge, it's an **amplifier on the quality-gap edge**, and "whose variance is
it" (leader dev vs trailer dev) is the correct check, exactly as the betting framework's KEY
CHECK states. Honest stats: +8.2pp on n=54 ≈ 1.2 SE — directionally solid, forward log continues.
Implication for engine framing: fadeRead should be framed gap-first with eFG as conditional
amplifier, not standalone (no shipped changes; PM call).

## Status
No code changed. Follow-ups proposed: (a) 2021–2023 PBP pull for role-carry OOS;
(b) nightly-log fields: carrier identity (star/mid/role by season ppg) + leader/trailer eFG dev
vs norm; (c) NBA replication of the two-sided gap-amplifier construction on the 1,235-game set.
