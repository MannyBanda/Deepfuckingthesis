# LATE-EXECUTION — PHASE A FINDINGS (stability gate)

**Prereg** 492e0fd + Amendment 1 (A1/A2). Surfaces: 2026 snapshots (direct `poss`, 461 team-games) + 2024/2025 checkpoint export (formula poss, 528+624 team-games; late window = Q3 start → last checkpoint ~Q4 1:00, which excludes final-minute intentional-foul TOs — disclosed, arguably cleaner for an execution metric; H1 = Q2_END cumulative). Denominators surface-declared, never mixed (A1); split-halves correlate within surface.

## Verdict

- **M1 (absolute late TO/100poss): PASS.** Pooled split-half **r = 0.468** (n=40 team-seasons, bar .40), within-season-centered robustness **r = 0.453**. Season legs all positive: 2024 **.480**, 2025 **.580**, 2026 .393 (just under, shortest half-samples). Late-game ball security is a real, measurable team trait.
- **M2 (clean-up delta): KILLED.** Pooled r = 0.049, centered 0.008, sign-flips in 2025. Whether a team tightens *relative to its own first half* is noise. Per the adjudication rule, **M1 advances to Phase B alone.**
- **M3 (unforced late, descriptive per A2): r = .350** (2026 only) — consistent, below M1, no authority.
- **Year-over-year M1: r ≈ .25–.27** — weak carryover across rosters. Correct instrument is within-season as-of with shrinkage (already specified); prior-season priors are weak.

2026 M1 spread: 14.2 (MIN) → 19.7 (POR), league span 5.6 per 100 poss — meaningful variation to rank on.

## What changes

Per the pre-committed product ladder: Phase A pass alone unlocks the **display-only matchup-sheet column** (M1-based, as-of, strict-<, ≥10 GP, shrinkage k=10) — code ships only on explicit PM go. Phase B (does the trait predict takeaway-channel regression in the validated POT≥6 cell) is now unlocked and awaits go. Conceptual note for the column copy: the stable trait is *absolute* late ball security, not "cleaning up" relative to a team's own early game — M2's death means the column should read as a level, not a tendency to improve.
